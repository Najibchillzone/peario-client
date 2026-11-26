import Hls from 'hls.js';
import hat from 'hat';
import { STREMIO_STREAMING_SERVER } from '@/common/config';

const HlsService = {

    hls: null,

    isSupported() {
        return Hls.isSupported();
    },

    canPlayNative(videoElement) {
        return Boolean(
            videoElement &&
            typeof videoElement.canPlayType === 'function' &&
            videoElement.canPlayType('application/vnd.apple.mpegurl')
        );
    },

    async createPlaylist(mediaURL) {
        if (!mediaURL) return null;
        if (/\.m3u8(\?|$)/i.test(mediaURL)) return mediaURL;

        const id = hat();
        const params = [
            ['mediaURL', mediaURL],
            ['videoCodecs', 'h264'],
        ];

        if (typeof MediaSource !== 'undefined' && MediaSource.isTypeSupported('video/mp4; codecs="vp09.00.10.08"')) {
            params.push(['videoCodecs', 'vp9']);
        }

        // Only advertise stereo AAC so Stremio's hlsv2 server transcodes unsupported
        // or multi-channel audio codecs (AC3, EAC3, DTS, TrueHD, Opus, 5.1/7.1) to AAC.
        params.push(['audioCodecs', 'aac']);
        params.push(['maxAudioChannels', '2']);

        const queryParams = new URLSearchParams(params);

        return `${STREMIO_STREAMING_SERVER}/hlsv2/${id}/master.m3u8?${queryParams.toString()}`;
    },

    loadHls(playlistUrl, videoElement, { onFatalError } = {}) {
        this.clear();

        if (!Hls.isSupported()) {
            if (this.canPlayNative(videoElement)) {
                return new Promise((resolve, reject) => {
                    const onLoaded = () => {
                        videoElement.removeEventListener('error', onError);
                        resolve();
                    };
                    const onError = (err) => {
                        videoElement.removeEventListener('loadedmetadata', onLoaded);
                        reject(err);
                    };
                    videoElement.addEventListener('loadedmetadata', onLoaded, { once: true });
                    videoElement.addEventListener('error', onError, { once: true });
                    videoElement.src = playlistUrl;
                    videoElement.load();
                });
            }
            return Promise.reject(new Error('HLS is not supported in this browser'));
        }

        videoElement.removeAttribute('src');
        videoElement.load();

        const hls = new Hls({
            enableWorker: true,
            maxBufferHole: 0.5,
            abrMaxWithRealBitrate: true,
        });
        this.hls = hls;

        const ensureAudioTrack = () => {
            if (hls.audioTracks && hls.audioTracks.length > 0 && hls.audioTrack === -1) {
                hls.audioTrack = 0;
            }
        };

        return new Promise((resolve, reject) => {
            let settled = false;
            let manifestParsed = false;
            let mediaRecoveryAttempts = 0;
            let networkRecoveryAttempts = 0;

            hls.on(Hls.Events.MEDIA_ATTACHED, () => {
                hls.loadSource(playlistUrl);
            });

            hls.on(Hls.Events.MANIFEST_PARSED, () => {
                manifestParsed = true;
                ensureAudioTrack();
                if (!settled) {
                    settled = true;
                    resolve();
                }
            });

            hls.on(Hls.Events.AUDIO_TRACKS_UPDATED, () => {
                ensureAudioTrack();
            });

            hls.on(Hls.Events.ERROR, (_, data) => {
                if (!data || !data.fatal) return;

                if (data.type === Hls.ErrorTypes.MEDIA_ERROR && mediaRecoveryAttempts < 2) {
                    mediaRecoveryAttempts += 1;
                    hls.recoverMediaError();
                    return;
                }

                if (data.type === Hls.ErrorTypes.NETWORK_ERROR && manifestParsed && networkRecoveryAttempts < 1) {
                    networkRecoveryAttempts += 1;
                    hls.startLoad();
                    return;
                }

                this.clear();

                if (!settled) {
                    settled = true;
                    reject(data);
                } else if (typeof onFatalError === 'function') {
                    onFatalError(data);
                }
            });

            hls.attachMedia(videoElement);
        });
    },

    clear() {
        if (this.hls) {
            this.hls.stopLoad();
            this.hls.detachMedia();
            this.hls.destroy();
            this.hls = null;
        }
    }

};

export default HlsService;