<template>
    <div class="volume">
        <RangeInput class="volume-bar" v-model="volumeInput"></RangeInput>
        <span class="icon" @click="toggleVolume()">
            <ion-icon name="volume-mute-outline" v-show="volume === 0"></ion-icon>
            <ion-icon name="volume-off-outline" v-show="volume > 0 && volume <= 0.2"></ion-icon>
            <ion-icon name="volume-low-outline" v-show="volume > 0.2 && volume < 0.5"></ion-icon>
            <ion-icon name="volume-medium-outline" v-show="volume >= 0.5 && volume < 0.8"></ion-icon>
            <ion-icon name="volume-high-outline" v-show="volume >= 0.8"></ion-icon>
        </span>
    </div>
</template>

<script>
import { mapGetters } from 'vuex';
import RangeInput from '@/components/ui/RangeInput.vue';
import store from '../../../store';

export default {
    name: 'VolumeControl',
    components: {
        RangeInput
    },
    computed: mapGetters({
        video: 'player/video',
        volume: 'player/volume'
    }),
    data() {
        return {
            volumeTmp: 0,
            volumeInput: this.volume
        };
    },
    watch: {
        volumeInput(value) {
            store.commit('player/updateVolume', parseFloat(value));
        }
    },
    methods: {
        toggleVolume() {
            if (this.volume) {
                this.volumeTmp = this.volume;
                this.volumeInput = 0;
            } else {
                this.volumeInput = this.volumeTmp || 0.5;
            }
        },
        onMouseWheel({ deltaY }) {
            const current = parseFloat(this.volumeInput) || 0;
            const next = deltaY < 0 ? Math.min(1, current + 0.1) : Math.max(0, current - 0.1);
            this.volumeInput = parseFloat(next.toFixed(1));
        }
    },
    mounted() {
        if (this.video) {
            this.video.addEventListener('wheel', this.onMouseWheel);
        }
    },
    unmounted() {
        if (this.video) {
            this.video.removeEventListener('wheel', this.onMouseWheel);
        }
    }
}
</script>

<style lang="scss" scoped>
.volume {
    display: flex;
    justify-content: center;

    .volume-bar {
        position: absolute;
        top: -70px;
        width: 120px;
        transform: rotate(-90deg);
        transform-origin: center;
        opacity: 0;
    }

    .icon {
        display: contents;
    }

    &:hover {
        .volume-bar {
            opacity: 1;
        }
    }
}
</style>