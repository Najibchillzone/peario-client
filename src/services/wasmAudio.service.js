import { Input, ALL_FORMATS, CustomSource, UrlSource, AudioBufferSink } from 'mediabunny';
import { registerAc3Decoder } from '@mediabunny/ac3';
import { registerDtsDecoder } from '@mediabunny/dts';
import { registerTrueHdDecoder } from '@mediabunny/truehd';

const NATIVE_STEREO_AUDIO_CODECS = new Set(['aac', 'mp3', 'opus', 'vorbis', 'flac']);
const LOOKAHEAD_SECONDS = 1.5;
const DRIFT_RESYNC_THRESHOLD = 0.15;
const CHUNK_SIZE_BYTES = 2 * 1024 * 1024; // 2 MiB chunks

let decodersRegistered = false;

function ensureDecodersRegistered() {
    if (decodersRegistered) return;
    registerAc3Decoder();
    registerDtsDecoder();
    registerTrueHdDecoder();
    decodersRegistered = true;
}

function isLocalUrl(urlStr) {
    try {
        const u = new URL(urlStr, window.location.href);
        return u.hostname === 'localhost' || u.hostname === '127.0.0.1';
    } catch (_) {
        return false;
    }
}

function createChunkedRangeReader(fetchChunkFn, signal) {
    return (start, end) => new ReadableStream({
        async pull(controller) {
            if (this._cursor === undefined) {
                this._cursor = start;
            }
            if (this._cursor >= end || (signal && signal.aborted)) {
                controller.close();
                return;
            }
            const chunkStart = this._cursor;
            const chunkEndExclusive = Math.min(end, chunkStart + CHUNK_SIZE_BYTES);
            try {
                const bytes = await fetchChunkFn(chunkStart, chunkEndExclusive - 1, signal);
                this._cursor = chunkEndExclusive;
                controller.enqueue(bytes);
                if (this._cursor >= end) {
                    controller.close();
                }
            } catch (err) {
                controller.error(err);
            }
        },
    });
}

async function createResilientSource(videoUrl, knownFileSize, abortController) {
    const signal = abortController.signal;

    const directFetchRange = async (start, endInclusive, sig) => {
        const res = await fetch(videoUrl, {
            headers: {
                Range: `bytes=${start}-${endInclusive}`,
            },
            signal: sig,
        });
        if (!res.ok && res.status !== 206) {
            throw new Error(`Direct range HTTP ${res.status}`);
        }
        const ab = await res.arrayBuffer();
        const bytes = new Uint8Array(ab);
        const expected = endInclusive - start + 1;
        return bytes.byteLength > expected ? bytes.subarray(0, expected) : bytes;
    };

    // 1. Known file size (e.g. Stremio local torrent stream)
    if (knownFileSize && knownFileSize > 0) {
        return new CustomSource({
            getSize: () => knownFileSize,
            prefetchProfile: 'network',
            maxCacheSize: 16 * 1024 * 1024,
            read: createChunkedRangeReader(directFetchRange, signal),
            dispose: () => abortController.abort(),
        });
    }

    // 2. Try probing size directly from browser (works when CDN exposes CORS + Content-Range)
    try {
        const probeRes = await fetch(videoUrl, {
            headers: { Range: 'bytes=0-0' },
            signal,
        });
        let directSize = null;
        const cr = probeRes.headers.get('content-range');
        if (cr) {
            const match = cr.match(/\/(\d+)\s*$/);
            if (match) directSize = Number(match[1]);
        }
        if (!directSize && probeRes.status === 200) {
            const cl = probeRes.headers.get('content-length');
            if (cl) directSize = Number(cl);
        }
        if (probeRes.body && typeof probeRes.body.cancel === 'function') {
            await probeRes.body.cancel().catch(() => {});
        }
        if (directSize && directSize > 0) {
            return new CustomSource({
                getSize: () => directSize,
                prefetchProfile: 'network',
                maxCacheSize: 16 * 1024 * 1024,
                read: createChunkedRangeReader(directFetchRange, signal),
                dispose: () => abortController.abort(),
            });
        }
    } catch (_) {
        // Direct browser probe blocked by CORS; fall through to /api/range proxy
    }

    // 3. External HTTP/HTTPS stream without CORS (e.g. Debrid / HTTP addons) -> use /api/range proxy
    if (!isLocalUrl(videoUrl)) {
        try {
            const probeProxyRes = await fetch(`/api/range?probe=1&url=${encodeURIComponent(videoUrl)}`, { signal });
            if (probeProxyRes.ok) {
                const info = await probeProxyRes.json();
                if (info && info.size && info.size > 0) {
                    const resolvedUrl = info.finalUrl || videoUrl;
                    const proxyFetchRange = async (start, endInclusive, sig) => {
                        const proxyUrl = `/api/range?url=${encodeURIComponent(resolvedUrl)}&start=${start}&end=${endInclusive}`;
                        const res = await fetch(proxyUrl, { signal: sig });
                        if (!res.ok && res.status !== 206) {
                            throw new Error(`Proxy range HTTP ${res.status}`);
                        }
                        const ab = await res.arrayBuffer();
                        return new Uint8Array(ab);
                    };

                    return new CustomSource({
                        getSize: () => info.size,
                        prefetchProfile: 'network',
                        maxCacheSize: 16 * 1024 * 1024,
                        read: createChunkedRangeReader(proxyFetchRange, signal),
                        dispose: () => abortController.abort(),
                    });
                }
            }
        } catch (_) {
            // Fall through to UrlSource fallback
        }
    }

    return new UrlSource(videoUrl, {
        maxCacheSize: 16 * 1024 * 1024,
    });
}

function downmixToStereo(buffer) {
    const ch = buffer.numberOfChannels;
    if (ch <= 2) return buffer;

    const length = buffer.length;
    const out = new AudioBuffer({
        numberOfChannels: 2,
        length,
        sampleRate: buffer.sampleRate,
    });

    const leftOut = out.getChannelData(0);
    const rightOut = out.getChannelData(1);

    const fl = buffer.getChannelData(0);
    const fr = buffer.getChannelData(1);
    const fc = ch >= 3 ? buffer.getChannelData(2) : null;
    // For 5ch: [FL, FR, FC, BL, BR]; for 6+ch (5.1/7.1): [FL, FR, FC, LFE, BL, BR, SL, SR]
    const bl = ch === 4 ? buffer.getChannelData(2) : ch === 5 ? buffer.getChannelData(3) : ch >= 6 ? buffer.getChannelData(4) : null;
    const br = ch === 4 ? buffer.getChannelData(3) : ch === 5 ? buffer.getChannelData(4) : ch >= 6 ? buffer.getChannelData(5) : null;
    const sl = ch >= 7 ? buffer.getChannelData(6) : null;
    const sr = ch >= 8 ? buffer.getChannelData(7) : null;

    const cGain = 0.7071;
    const sGain = ch >= 7 ? 0.5 : 0.7071;
    let peak = 1.0;

    for (let i = 0; i < length; i += 1) {
        let l = fl[i];
        let r = fr[i];
        if (ch !== 4 && fc) {
            const c = fc[i] * cGain;
            l += c;
            r += c;
        }
        if (bl) l += bl[i] * sGain;
        if (br) r += br[i] * sGain;
        if (sl) l += sl[i] * sGain;
        if (sr) r += sr[i] * sGain;

        leftOut[i] = l;
        rightOut[i] = r;

        const absL = l < 0 ? -l : l;
        const absR = r < 0 ? -r : r;
        if (absL > peak) peak = absL;
        if (absR > peak) peak = absR;
    }

    if (peak > 1.0) {
        const scale = 1.0 / peak;
        for (let i = 0; i < length; i += 1) {
            leftOut[i] *= scale;
            rightOut[i] *= scale;
        }
    }

    return out;
}

const WasmAudioService = {
    audioContext: null,
    gainNode: null,
    input: null,
    sink: null,
    videoElement: null,
    abortController: null,
    activeNodes: new Set(),
    activeIterator: null,
    sessionId: 0,
    decodedFrames: 0,
    isLoopRunning: false,
    isActive: false,
    volume: 0.5,
    codec: null,
    boundHandlers: null,
    gestureHandler: null,
    nativeWatchTimer: null,

    ensureAudioContext() {
        if (!this.audioContext) {
            const AudioCtx = window.AudioContext || window.webkitAudioContext;
            if (!AudioCtx) return null;
            this.audioContext = new AudioCtx();
            this.gainNode = this.audioContext.createGain();
            this.gainNode.gain.value = this.volume;
            this.gainNode.connect(this.audioContext.destination);
        }
        return this.audioContext;
    },

    unlock() {
        const ctx = this.ensureAudioContext();
        if (ctx && ctx.state === 'suspended') {
            ctx.resume().catch(() => {});
        }
    },

    setVolume(value) {
        const num = Number(value);
        const clamped = Number.isFinite(num) ? Math.max(0, Math.min(1, num)) : 0.5;
        this.volume = clamped;
        if (this.gainNode) {
            this.gainNode.gain.value = clamped;
        }
    },

    stopScheduledAudio() {
        this.sessionId += 1;
        this.isLoopRunning = false;

        for (const node of this.activeNodes) {
            try {
                node.onended = null;
                node.stop();
                node.disconnect();
            } catch (_) {
                // Ignore already stopped nodes
            }
        }
        this.activeNodes.clear();

        if (this.activeIterator) {
            const iter = this.activeIterator;
            this.activeIterator = null;
            if (typeof iter.return === 'function') {
                iter.return().catch(() => {});
            }
        }
    },

    async startPlaybackLoop(startTimestamp) {
        if (!this.isActive || !this.sink || !this.videoElement) return;

        const ctx = this.ensureAudioContext();
        if (!ctx) return;

        this.stopScheduledAudio();
        const mySession = this.sessionId;
        this.isLoopRunning = true;

        const video = this.videoElement;
        const safeStart = Math.max(0, Number(startTimestamp) || 0);

        if (ctx.state === 'suspended') {
            await ctx.resume().catch(() => {});
        }
        if (mySession !== this.sessionId || !this.isActive || !video || video.paused) {
            if (mySession === this.sessionId) this.isLoopRunning = false;
            return;
        }

        let iterator;
        try {
            iterator = this.sink.buffers(safeStart);
            this.activeIterator = iterator;
        } catch (_) {
            if (mySession === this.sessionId) this.isLoopRunning = false;
            return;
        }

        let nextScheduledTime = 0;

        try {
            for await (const wrapped of iterator) {
                if (mySession !== this.sessionId || !this.isActive || !video || video.paused) {
                    break;
                }

                const { buffer: rawBuffer, timestamp, duration } = wrapped;
                if (!rawBuffer) continue;

                // Skip packets already behind the video playhead
                if (timestamp + duration < video.currentTime - 0.05) {
                    continue;
                }

                // Backpressure: stay ~1.5s ahead of the video element
                while (
                    mySession === this.sessionId &&
                    this.isActive &&
                    !video.paused &&
                    timestamp - video.currentTime > LOOKAHEAD_SECONDS
                ) {
                    await new Promise((r) => setTimeout(r, 80));
                }

                if (mySession !== this.sessionId || !this.isActive || video.paused) {
                    break;
                }

                if (ctx.state === 'suspended') {
                    await ctx.resume().catch(() => {});
                }

                const buffer = downmixToStereo(rawBuffer);
                const currentVideoTime = video.currentTime;
                let offset = 0;
                let targetDelta = timestamp - currentVideoTime;

                if (targetDelta < -0.02) {
                    offset = Math.min(buffer.duration, -targetDelta);
                    targetDelta = 0;
                }

                if (offset >= buffer.duration - 0.005) {
                    continue;
                }

                const idealWhen = ctx.currentTime + targetDelta;
                let when;

                if (nextScheduledTime === 0 || Math.abs(nextScheduledTime - idealWhen) > DRIFT_RESYNC_THRESHOLD) {
                    when = Math.max(ctx.currentTime + 0.01, idealWhen);
                } else {
                    when = Math.max(ctx.currentTime + 0.005, nextScheduledTime);
                }

                const sourceNode = ctx.createBufferSource();
                sourceNode.buffer = buffer;
                sourceNode.playbackRate.value = video.playbackRate || 1;
                sourceNode.connect(this.gainNode);

                this.activeNodes.add(sourceNode);
                sourceNode.onended = () => {
                    this.activeNodes.delete(sourceNode);
                    try {
                        sourceNode.disconnect();
                    } catch (_) {
                        // Ignore disconnect errors
                    }
                };

                sourceNode.start(when, offset);
                const playDuration = (buffer.duration - offset) / (video.playbackRate || 1);
                nextScheduledTime = when + playDuration;
                this.decodedFrames += 1;
            }
        } catch (err) {
            console.warn('[Peario Audio] Decode stream interrupted:', err && err.message ? err.message : err);
        } finally {
            if (this.activeIterator === iterator) {
                this.activeIterator = null;
            }
            if (mySession === this.sessionId) {
                this.isLoopRunning = false;
            }
        }
    },

    async attach(videoUrl, videoElement, { fileSize = null, volume = 0.5, forceWasm = false, onActivated = null } = {}) {
        this.clear();

        if (!videoUrl || !videoElement) {
            return { active: false, codec: null };
        }

        ensureDecodersRegistered();
        this.setVolume(volume);

        const abortController = new AbortController();
        this.abortController = abortController;

        try {
            const source = await createResilientSource(videoUrl, fileSize, abortController);
            if (abortController.signal.aborted) {
                return { active: false, codec: null };
            }

            const input = new Input({
                formats: ALL_FORMATS,
                source,
            });
            this.input = input;

            const tracks = await input.getAudioTracks();
            if (!tracks || !tracks.length) {
                this.clear();
                return { active: false, codec: null };
            }

            let selectedTrack = null;
            let selectedCodec = null;

            for (const candidate of tracks) {
                const c = await candidate.getCodec();
                if (c && (await candidate.canDecode())) {
                    selectedTrack = candidate;
                    selectedCodec = c;
                    break;
                }
            }

            if (!selectedTrack || !selectedCodec) {
                this.clear();
                return { active: false, codec: null };
            }

            const channels = (await selectedTrack.getNumberOfChannels()) || 2;
            const isNativeStereo = NATIVE_STEREO_AUDIO_CODECS.has(selectedCodec) && channels <= 2;

            if (isNativeStereo && !forceWasm) {
                // Let <video> play native stereo AAC/MP3/Opus/FLAC, with a safety watchdog
                // in case the browser's container demuxer silently drops the audio track.
                this.clear();
                this.watchNativeAudioDrop(videoUrl, videoElement, { fileSize, volume, onActivated });
                return { active: false, codec: selectedCodec };
            }

            this.sink = new AudioBufferSink(selectedTrack);
            this.videoElement = videoElement;
            this.codec = selectedCodec;
            this.isActive = true;

            // Mute native <video> track so only WASM decoded stereo audio plays
            videoElement.muted = true;

            let waitingTimer = null;
            const clearWaitingTimer = () => {
                if (waitingTimer) {
                    clearTimeout(waitingTimer);
                    waitingTimer = null;
                }
            };

            const ensurePlaying = () => {
                clearWaitingTimer();
                this.unlock();
                if (this.isActive && !videoElement.paused && !videoElement.seeking && !this.isLoopRunning) {
                    this.startPlaybackLoop(videoElement.currentTime);
                }
            };

            const onPlay = () => {
                clearWaitingTimer();
                this.unlock();
                if (!this.isLoopRunning) {
                    this.startPlaybackLoop(videoElement.currentTime);
                }
            };
            const onPause = () => {
                clearWaitingTimer();
                this.stopScheduledAudio();
            };
            const onWaiting = () => {
                clearWaitingTimer();
                waitingTimer = setTimeout(() => {
                    if (videoElement && !videoElement.paused && videoElement.readyState < 3) {
                        this.stopScheduledAudio();
                    }
                }, 150);
            };
            const onPlaying = () => {
                ensurePlaying();
            };
            const onCanPlay = () => {
                ensurePlaying();
            };
            const onTimeUpdate = () => {
                if (videoElement.readyState >= 2) {
                    ensurePlaying();
                }
            };
            const onSeeking = () => {
                clearWaitingTimer();
                this.stopScheduledAudio();
            };
            const onSeeked = () => {
                clearWaitingTimer();
                this.stopScheduledAudio();
                if (!videoElement.paused) {
                    this.startPlaybackLoop(videoElement.currentTime);
                }
            };

            this.boundHandlers = {
                play: onPlay,
                pause: onPause,
                waiting: onWaiting,
                playing: onPlaying,
                canplay: onCanPlay,
                timeupdate: onTimeUpdate,
                seeking: onSeeking,
                seeked: onSeeked,
            };

            Object.entries(this.boundHandlers).forEach(([event, handler]) => {
                videoElement.addEventListener(event, handler);
            });

            this.gestureHandler = () => this.unlock();
            document.addEventListener('pointerdown', this.gestureHandler, { passive: true });
            document.addEventListener('keydown', this.gestureHandler, { passive: true });

            if (!videoElement.paused) {
                this.startPlaybackLoop(videoElement.currentTime);
            }

            const result = { active: true, codec: selectedCodec, channels };
            if (typeof onActivated === 'function') {
                onActivated(result);
            }
            return result;
        } catch (err) {
            console.warn('[Peario Audio] Failed to attach WASM audio decoder:', err && err.message ? err.message : err);
            this.clear();
            return { active: false, codec: null };
        }
    },

    watchNativeAudioDrop(videoUrl, videoElement, { fileSize, volume, onActivated }) {
        if (!('webkitAudioDecodedByteCount' in videoElement)) return;

        const checkPlayback = () => {
            if (!videoElement || videoElement.paused || videoElement.currentTime < 0.6) return;
            videoElement.removeEventListener('timeupdate', checkPlayback);
            if (videoElement.webkitAudioDecodedByteCount === 0 && !this.isActive) {
                this.attach(videoUrl, videoElement, {
                    fileSize,
                    volume: this.volume ?? volume,
                    forceWasm: true,
                    onActivated,
                });
            }
        };

        videoElement.addEventListener('timeupdate', checkPlayback);
        this.nativeWatchTimer = () => videoElement.removeEventListener('timeupdate', checkPlayback);
    },

    clear() {
        this.isActive = false;
        this.codec = null;
        this.decodedFrames = 0;
        this.stopScheduledAudio();

        if (this.nativeWatchTimer) {
            this.nativeWatchTimer();
            this.nativeWatchTimer = null;
        }

        if (this.gestureHandler) {
            document.removeEventListener('pointerdown', this.gestureHandler);
            document.removeEventListener('keydown', this.gestureHandler);
            this.gestureHandler = null;
        }

        if (this.videoElement && this.boundHandlers) {
            Object.entries(this.boundHandlers).forEach(([event, handler]) => {
                this.videoElement.removeEventListener(event, handler);
            });
        }
        this.boundHandlers = null;
        this.videoElement = null;
        this.sink = null;

        if (this.abortController) {
            try {
                this.abortController.abort();
            } catch (_) {
                // Ignore abort errors
            }
            this.abortController = null;
        }

        if (this.input) {
            try {
                this.input.dispose();
            } catch (_) {
                // Ignore dispose errors
            }
            this.input = null;
        }
    },
};

if (typeof window !== 'undefined') {
    window.__pearioAudio = WasmAudioService;
}

export default WasmAudioService;
