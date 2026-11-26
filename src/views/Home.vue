<template>
    <div class="home">
        <div class="title">
            <ATitle translate="views.home.title"/>
            <ATitle type="tertiary">
                <i18n-t keypath="views.home.sub" tag="span">
                    <ALink href="https://stremio.com">Stremio</ALink>
                </i18n-t>
            </ATitle>
        </div>

        <div class="actions">
            <AButton large icon="play" @click="goToSearch()">
                {{ $t('views.home.button') }}
            </AButton>
            <AButton large clear icon="extension-puzzle-outline" @click="installAddon()">
                Install Stremio Addon
            </AButton>
        </div>
    </div>
</template>

<script setup>
import router from '@/router';

import ATitle from '@/components/ui/Title.vue';
import ALink from '@/components/ui/Link.vue';
import AButton from '@/components/ui/Button.vue';

const goToSearch = () => router.push({ name: 'search' });
const installAddon = () => {
    window.location.href = `stremio://${window.location.host}/manifest.json`;
};
</script>

<style lang="scss" scoped>
.home {
    display: flex;
    flex-direction: column;
    justify-content: center;
    gap: 45px;

    .title {
        display: flex;
        flex-direction: column;
        gap: 15px;
    }

    .actions {
        display: flex;
        flex-wrap: wrap;
        gap: 15px;
    }
}
</style>