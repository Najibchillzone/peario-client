<template>
    <div class="player" ref="playerRef" :class="{ 'controlsHidden': controlsHidden }"
        @mousemove="showControls"
        @touchmove="showControls"
        @dragover="onSubtitlesDropped"
        @drop="onSubtitlesDropped"
        @mouseleave="hideControls">

        <LockScreen :options="props.options" v-if="locked"></LockScreen>
        
        <div class="buffering" v-if="!locked && !paused && buffering">
            <div>
                <ion-icon name="sync-outline" class="spin"></ion-icon>
            </div>
        </div>

        <Subtitle v-if="videoRef" :timecode="currentTime" :controlsShown="!controlsHidden"></Subtitle>

        <video ref="videoRef" :poster="options.meta.background"
            @click="showControls"
            @error="onVideoError"
            @timeupdate="updateCurrentTime"
            @waiting="() => updateBuffering(true)"
            @loadedmetadata="() => updateBuffering(false)"
            @canplay="() => updateBuffering(false)">
        </video>

        <div class="controls" v-if="!locked && videoRef">
            <AutoSyncControl></AutoSyncControl>

            <div class="panel">
                <PlayPauseControl class="control" :options="options" @change="onPlayerChange()"></PlayPauseControl>

                <div class="timer control" v-to-timer="currentTime"></div>
            </div>

            <div class="panel stretch">
                <TimeBarControl class="control" :options="options"></TimeBarControl>
            </div>

            <div class="panel">
                <VolumeContol class="control" />
                <SubtitlesControl class="control" v-if="options.src && options.meta" :videoUrl="options.src" :meta="options.meta" :userSubtitle="userSubtitle" />
                <HlsControl class="control" v-if="options.hls" @toggle="toggleHls" />
                <FullScreenControl class="control" :player="playerRef" :video="videoRef" />
            </div>
        </div>
    </div>
</template>

<script setup>
import { computed, getCurrentInstance, onMounted, ref, watch, onUnmounted } from 'vue';
import { useI18n } from 'vue-i18n';
import store from '@/store';
import HlsService from '@/services/hls.service';
import WasmAudioService from '@/services/wasmAudio.service';

import LockScreen from "./LockScreen.vue";
import Subtitle from "./Subtitle.vue";
import AutoSyncControl from "./controls/AutoSync.vue";
import PlayPauseControl from "./controls/PlayPause.vue";
import TimeBarControl from "./controls/TimeBar.vue";
import VolumeContol from "./controls/Volume.vue";
import SubtitlesControl from "./controls/Subtitles.vue";
import HlsControl from "./controls/Hls.vue";
import FullScreenControl from "./controls/FullScreen.vue";

const props = defineProps({
    options: {
        src: String,
        fileSize: Number,
        hls: String,
        meta: {
            id: String,
            type: String,
            logo: String,
            background: String,
        },
        isOwner: Boolean
    }
});

const emit = defineEmits(['change']);
const { t } = useI18n();
const instance = getCurrentInstance();
const toast = instance && instance.appContext.config.globalProperties.$toast;

const locked = computed(() => store.state.player.locked);
const paused = computed(() => store.state.player.paused);
const currentTime = computed(() => store.state.player.currentTime);
const controlsHidden = computed(() => store.state.player.controlsHidden);
const buffering = computed(() => store.state.player.buffering);
const volume = computed(() => store.state.player.volume);
const isHls = computed(() => store.state.player.isHls);

const playerRef = ref(null);
const videoRef = ref(null);
const userSubtitle = ref(null);
const hlsFailed = ref(false);
let isSwitchingSource = false;

const applyAudioState = () => {
    WasmAudioService.setVolume(volume.value);
    if (!videoRef.value) return;
    if (WasmAudioService.isActive) {
        videoRef.value.muted = true;
    } else {
        videoRef.value.volume = volume.value;
        videoRef.value.muted = volume.value === 0;
    }
};

const safePlay = () => {
    if (!videoRef.value) return;
    const playPromise = videoRef.value.play();
    if (playPromise && typeof playPromise.catch === 'function') {
        playPromise.catch(() => {});
    }
};

const seekTo = (seekTime) => {
    if (!videoRef.value || !seekTime || seekTime <= 0) return;
    if (videoRef.value.readyState >= 1) {
        videoRef.value.currentTime = seekTime;
    } else {
        videoRef.value.addEventListener('loadedmetadata', () => {
            if (videoRef.value) videoRef.value.currentTime = seekTime;
        }, { once: true });
    }
};

const loadDirectSource = (seekTime, wasPlaying) => {
    if (!videoRef.value) return;
    HlsService.clear();
    WasmAudioService.clear();
    videoRef.value.src = props.options.src;
    videoRef.value.load();
    applyAudioState();
    store.commit('player/updateIsHls', false);

    seekTo(seekTime);
    if (wasPlaying) {
        safePlay();
    }

    // Automatically attach client-side WASM audio decoder (AC3/EAC3/DTS/TrueHD)
    // when playing direct source so audio works universally without Stremio HLS CORS.
    if (props.options.src) {
        WasmAudioService.attach(props.options.src, videoRef.value, {
            fileSize: props.options.fileSize,
            volume: volume.value,
        }).then((result) => {
            if (result && result.active) {
                applyAudioState();
                if (toast && result.codec) {
                    toast.success(`Audio decoder active (${result.codec.toUpperCase()})`);
                }
            }
        }).catch(() => {});
    }
};

const loadMedia = async (useHls, { preservePosition = false, resumePlayback = false, notify = false } = {}) => {
    if (!videoRef.value || isSwitchingSource) return;
    isSwitchingSource = true;

    const seekTime = preservePosition ? videoRef.value.currentTime : 0;
    const wasPlaying = resumePlayback && !videoRef.value.paused;

    try {
        if (useHls && props.options.hls && (HlsService.isSupported() || HlsService.canPlayNative(videoRef.value))) {
            WasmAudioService.clear();
            await HlsService.loadHls(props.options.hls, videoRef.value, {
                onFatalError: () => {
                    hlsFailed.value = true;
                    if (videoRef.value && props.options.src) {
                        const fallbackTime = videoRef.value.currentTime || seekTime;
                        const fallbackPlaying = !videoRef.value.paused || wasPlaying;
                        loadDirectSource(fallbackTime, fallbackPlaying);
                    }
                },
            });

            applyAudioState();
            store.commit('player/updateIsHls', true);

            seekTo(seekTime);
            if (wasPlaying) {
                safePlay();
            }
            if (notify && toast) toast.success(t('toasts.hlsStream'));
        } else {
            loadDirectSource(seekTime, wasPlaying);
            if (notify && toast) toast.success(t('toasts.sourceStream'));
        }
    } catch (_) {
        hlsFailed.value = true;
        loadDirectSource(seekTime, wasPlaying);
    } finally {
        isSwitchingSource = false;
    }
};

const toggleHls = () => {
    const nextIsHls = !isHls.value;
    if (nextIsHls) hlsFailed.value = false;
    loadMedia(nextIsHls, { preservePosition: true, resumePlayback: true, notify: true });
};

const onVideoError = () => {
    if (!isHls.value && !hlsFailed.value && props.options.hls) {
        loadMedia(true, { preservePosition: true, resumePlayback: true, notify: true });
    }
};

watch(volume, () => {
    applyAudioState();
});

let hideTimeout = null;
const showControls = () => {
    clearTimeout(hideTimeout);
    store.commit('player/updateHideState', false);
    hideTimeout = setTimeout(hideControls, 3000);
};

const hideControls = () => {
    if (!paused.value) store.commit('player/updateHideState', true);
};

const onPlayerChange = () => {
    if (paused.value) showControls();
        emit('change');
};

const updateBuffering = (value) => {
    store.commit('player/updateBuffering', value);
};

const updateCurrentTime = () => {
    if (videoRef.value)
        store.commit('player/updateCurrentTime', videoRef.value.currentTime);
};

const onSubtitlesDropped = (event) => {
    event.preventDefault();

    const { files } = event.dataTransfer;
    if (files.length) {
        const file = files[0];
        if (file.name.endsWith('.srt'))
            userSubtitle.value = file;
    }
};

onMounted(() => {
    store.commit('player/updateLockState', true);
    store.commit('player/updateVideo', videoRef.value);
    applyAudioState();

    const shouldUseHls = Boolean(
        props.options.hls && (HlsService.isSupported() || HlsService.canPlayNative(videoRef.value))
    );
    loadMedia(shouldUseHls);
});

onUnmounted(() => {
    HlsService.clear();
    WasmAudioService.clear();
    store.commit('player/updateIsHls', false);
    store.commit('player/updateVideo', null);
    clearTimeout(hideTimeout);
    hideTimeout = null;
});
</script>

<style lang="scss" scoped>
$overlay-background-color: rgba(0, 0, 0, 0.5);

.player {
    position: relative;
    font-family: 'Montserrat-Regular';
    height: 100%;
    width: 100%;
    overflow: hidden;
    background-color: black;

    &.controlsHidden {
        cursor: none;

        .controls {
            opacity: 0;
            visibility: hidden;
        }
    }

    .buffering {
        position: absolute;
        width: 100%;
        height: 100%;
        display: flex;
        align-items: center;
        justify-content: center;
        color: $text-color;
        background-color: $overlay-background-color;

        ion-icon {
            font-size: 5rem;
        }
    }

    video {
        height: 100%;
        width: 100%;
        outline: none;
        align-self: center;
    }

    .controls {
        height: $player-controls-height;
        display: flex;
        align-items: center;
        justify-content: space-between;
        position: absolute;
        bottom: 0;
        width: 100%;
        padding: 0 1vw;
        user-select: none;
        opacity: 1;
        transition: all 0.2s ease-in;
        color: $text-color;
        background-color: $overlay-background-color;
        box-shadow: 0px -40px 100px 60px $overlay-background-color;

        .panel {
            display: flex;
            align-items: center;

            &.stretch {
                width: 100%;

                .control {
                    display: flex;
                    width: 100%;
                }
            }
        }

        .control {
            position: relative;
            display: flex;
            flex-direction: row;
            align-items: center;
            justify-content: center;
            padding: 0.5em;
            font-size: 1.8em;
            cursor: pointer;
        }

        .timer {
            width: 4em;
            padding: 0;
            font-size: 1.3em;
            font-family: 'Montserrat-Medium';
            text-align: center;
        }
    }
}

@media only screen and (max-width: 768px) {
    .panel.stretch {
        position: absolute;
        left: 0;
        right: 0;
        bottom: 70px;
        padding: 0 10px;
    }
}
</style>