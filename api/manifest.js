const DEFAULT_ADDON_ID = 'community.peario.audiofix';
const DEFAULT_ADDON_NAME = 'Peario (Audio Fix)';
const DEFAULT_ADDON_DESCRIPTION = 'Watch Stremio streams together with friends with fixed browser audio.';

module.exports = (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');

    if (req.method === 'OPTIONS') {
        res.status(200).end();
        return;
    }

    const proto = req.headers['x-forwarded-proto'] || 'https';
    const host = req.headers.host;
    const baseUrl = process.env.APP_URL || (host ? `${proto}://${host}` : '');

    res.status(200).json({
        id: process.env.ADDON_ID || DEFAULT_ADDON_ID,
        version: '0.12.4',
        name: process.env.ADDON_NAME || DEFAULT_ADDON_NAME,
        description: process.env.ADDON_DESCRIPTION || DEFAULT_ADDON_DESCRIPTION,
        logo: baseUrl ? `${baseUrl}/favicon.ico` : undefined,
        resources: ['stream'],
        types: ['movie', 'series'],
        idPrefixes: ['tt'],
        catalogs: [],
    });
};
