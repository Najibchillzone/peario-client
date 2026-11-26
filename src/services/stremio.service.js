import axios from "axios";
import { CINEMETA_URL, OPENSUBTITLES_URL, STREMIO_API_URL, STREMIO_STREAMING_SERVER } from "@/common/config";

const StremioService = {

    async isServerOpen() {
        try {
            await axios.get(`${STREMIO_STREAMING_SERVER}/stats.json`);
            return Promise.resolve(true);
        } catch(e) {
            return Promise.resolve(false);
        }
    },

    async getMetaSeries(imdbId) {
        const { data } = await axios.get(`${CINEMETA_URL}/meta/series/${imdbId}.json`);
        return data.meta;
    },

    async getMetaMovie(imdbId) {
        const { data } = await axios.get(`${CINEMETA_URL}/meta/movie/${imdbId}.json`);
        return data.meta;
    },

    async searchMovies(title) {
        const { data } = await axios.get(`${CINEMETA_URL}/catalog/movie/top/search=${title}.json`);
        return data.metas;
    },

    async searchSeries(title) {
        const { data } = await axios.get(`${CINEMETA_URL}/catalog/series/top/search=${title}.json`);
        return data.metas;
    },

    async getAddons() {
        const { data } = await axios.get(`${STREMIO_API_URL}/addonscollection.json`);
        return data;
    },

    async createTorrentStreamInfo(stream) {
        let { infoHash, fileIdx = null } = stream;
        const { data } = await axios.get(`${STREMIO_STREAMING_SERVER}/${infoHash}/create`);
        const { files } = data;
        if (fileIdx === null || fileIdx === undefined) {
            const largest = files.reduce((max, file) => (file.length > max.length ? file : max), files[0]);
            fileIdx = files.indexOf(largest);
        }
        const selectedFile = files[fileIdx];
        return {
            url: `${STREMIO_STREAMING_SERVER}/${infoHash}/${fileIdx}`,
            size: selectedFile && typeof selectedFile.length === 'number' ? selectedFile.length : null,
        };
    },

    async createTorrentStream(stream) {
        const { url } = await this.createTorrentStreamInfo(stream);
        return url;
    },

    async getStats(streamUrl) {
        const { data } = await axios.get(`${streamUrl}/stats.json`);
        console.log(data);
        
        return data;
    },

    async getSubtitles({ type, id, url }) {
        try {
            const { hash } = await getOpenSubInfo(url);
            return queryOpenSubtitles({
                type,
                id,
                videoHash: hash,
            });
        } catch(_) {
            return [];
        }
    }

};

async function getOpenSubInfo(streamUrl) {
    const { data } = await axios.get(`${STREMIO_STREAMING_SERVER}/opensubHash?videoUrl=${streamUrl}`);
    const { result } = data;
    return result;
}

async function queryOpenSubtitles({ type, id, videoHash }) {
    const { data } = await axios.get(`${OPENSUBTITLES_URL}/subtitles/${type}/${id}/videoHash=${videoHash}.json`);
    const { subtitles } = data;
    return subtitles;
}

export default StremioService;