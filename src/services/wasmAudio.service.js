import { Input, ALL_FORMATS, CustomSource, UrlSource, AudioBufferSink } from 'mediabunny';
import { registerAc3Decoder } from '@mediabunny/ac3';
import { registerDtsDecoder } from '@mediabunny/dts';
import { registerTrueHdDecoder } from '@mediabunny/truehd';

const NATIVE_BROWSER_AUDIO_CODECS = new Set(['aac', 'mp3', 'opus', 'vorbis', 'flac']);
const LOOKAHEAD_SECONDS = 1.5;
const DRIFT_RESYNC_THRESHOLD = 0.12;

let decodersRegistered = false;

function ensureDecodersRegistered() {
    if (decodersRegistered) return;
    registerAc3Decoder();
    registerDtsDecoder();
    registerTrueHdDecoder();
    decodersRegistered = true;
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
    isActive: false,
    volume: 0.5,
    codec: null,
    boundHandlers: null,

    ensureAudioContext() {
        if (!this.audioContext) {
            const AudioCtx = window.AudioContext || window.webkitAudioContext;
            if (!AudioCtx) return null;
            this.audioContext = new AudioCtx();
            this.gainNode = this.audioContext.createGain();
            // Force clean stereo speaker downmix for 5.1 / 7.1 surround tracks
            this.gainNode.channelCount = 2;
            this.gainNode.channelCountMode = 'explicit';
            this.gainNode.channelInterpretation = 'speakers';
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
        const clamped = Math.max(0, Math.min(1, Number(value) || 0));
        this.volume = clamped;
        if (this.gainNode) {
            this.gainNode.gain.value = clamped;
        }
    },

    stopScheduledAudio() {
        this.sessionId += 1;
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
        if (ctx.state === 'suspended') {
            try {
                await ctx.resume();
            } catch (_) {
                return;
            }
        }

        this.stopScheduledAudio();
        const mySession = this.sessionId;
        const video = this.videoElement;
        const safeStart = Math.max(0, Number(startTimestamp) || 0);

        let iterator;
        try {
            iterator = this.sink.buffers(safeStart);
            this.activeIterator = iterator;
        } catch (_) {
            return;
        }

        let nextScheduledTime = 0;

        try {
            for await (const wrapped of iterator) {
                if (mySession !== this.sessionId || !this.isActive || !video || video.paused) {
                    break;
                }

                const { buffer, timestamp, duration } = wrapped;
                if (!buffer) continue;

                // Skip packets that are already behind the video playhead
                if (timestamp + duration < video.currentTime - 0.05) {
                    continue;
                }

                // Backpressure: keep decoding ~1.5s ahead of the video element
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
            }
        } catch (_) {
            // Aborted or stream read interrupted (e.g. seek/unmount)
        } finally {
            if (this.activeIterator === iterator) {
                this.activeIterator = null;
            }
        }
    },

    async attach(videoUrl, videoElement, { fileSize = null, volume = 0.5 } = {}) {
        this.clear();

        if (!videoUrl || !videoElement) {
            return { active: false, codec: null };
        }

        ensureDecodersRegistered();
        this.setVolume(volume);

        const abortController = new AbortController();
        this.abortController = abortController;

        let source;
        if (fileSize && fileSize > 0) {
            source = new CustomSource({
                getSize: () => fileSize,
                prefetchProfile: 'network',
                maxCacheSize: 16 * 1024 * 1024,
                read: async (start, end) => {
                    const response = await fetch(videoUrl, {
                        headers: {
                            Range: `bytes=${start}-${end - 1}`,
                        },
                        signal: abortController.signal,
                    });
                    if (!response.ok && response.status !== 206) {
                        throw new Error(`HTTP ${response.status}`);
                    }
                    const buf = await response.arrayBuffer();
                    return new Uint8Array(buf);
                },
                dispose: () => {
                    abortController.abort();
                },
            });
        } else {
            source = new UrlSource(videoUrl, {
                maxCacheSize: 16 * 1024 * 1024,
            });
        }

        const input = new Input({
            formats: ALL_FORMATS,
            source,
        });
        this.input = input;

        try {
            const audioTrack = await input.getPrimaryAudioTrack();
            if (!audioTrack) {
                this.clear();
                return { active: false, codec: null };
            }

            const codec = await audioTrack.getCodec();
            if (!codec || NATIVE_BROWSER_AUDIO_CODECS.has(codec)) {
                // Native browser audio codec (AAC/MP3/Opus/Vorbis/FLAC) - let <video> handle it natively
                this.clear();
                return { active: false, codec };
            }

            const decodable = await audioTrack.canDecode();
            if (!decodable) {
                this.clear();
                return { active: false, codec };
            }

            this.sink = new AudioBufferSink(audioTrack);
            this.videoElement = videoElement;
            this.codec = codec;
            this.isActive = true;

            // Mute native <video> track so only WASM decoded audio plays
            videoElement.muted = true;

            const onPlay = () => {
                this.unlock();
                this.startPlaybackLoop(videoElement.currentTime);
            };
            const onPause = () => {
                this.stopScheduledAudio();
            };
            const onWaiting = () => {
                this.stopScheduledAudio();
            };
            const onPlaying = () => {
                this.unlock();
                this.startPlaybackLoop(videoElement.currentTime);
            };
            const onSeeking = () => {
                this.stopScheduledAudio();
            };
            const onSeeked = () => {
                if (!videoElement.paused) {
                    this.startPlaybackLoop(videoElement.currentTime);
                }
            };

            this.boundHandlers = {
                play: onPlay,
                pause: onPause,
                waiting: onWaiting,
                playing: onPlaying,
                seeking: onSeeking,
                seeked: onSeeked,
            };

            Object.entries(this.boundHandlers).forEach(([event, handler]) => {
                videoElement.addEventListener(event, handler);
            });

            if (!videoElement.paused) {
                this.startPlaybackLoop(videoElement.currentTime);
            }

            return { active: true, codec };
        } catch (_) {
            this.clear();
            return { active: false, codec: null };
        }
    },

    clear() {
        this.isActive = false;
        this.codec = null;
        this.stopScheduledAudio();

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

export default WasmAudioService;
