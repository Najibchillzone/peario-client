<template>
    <div class="hls" @click="$emit('toggle')">
        <ion-icon name="color-wand-outline" v-show="!isHls"></ion-icon>
        <ion-icon name="color-wand" v-show="isHls"></ion-icon>
    </div>
</template>

<script>
import { mapGetters } from 'vuex';

export default {
    name: 'HlsControl',
    emits: ['toggle'],
    computed: mapGetters({
        isHls: 'player/isHls'
    })
}
</script>