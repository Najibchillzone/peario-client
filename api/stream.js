const DEFAULT_ADDON_NAME = 'Peario (Audio Fix)';

module.exports = (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Content-Type', 'application/json; charset=utf-8');

    if (req.method === 'OPTIONS') {
        res.status(200).end();
        return;
    }

    const type = req.query.type;
    const rawId = req.query.id;

    if (!type || !rawId || (type !== 'movie' && type !== 'series')) {
        res.status(200).json({ streams: [] });
        return;
    }

    const cleanId = decodeURIComponent(String(rawId).replace(/\.json$/i, ''));
    const proto = req.headers['x-forwarded-proto'] || 'https';
    const host = req.headers.host;
    const baseUrl = (process.env.APP_URL || (host ? `${proto}://${host}` : '')).replace(/\/+$/, '');
    const addonName = process.env.ADDON_NAME || DEFAULT_ADDON_NAME;

    res.status(200).json({
        streams: [
            {
                name: addonName,
                title: 'Watch with friends',
                externalUrl: `${baseUrl}/stream/${encodeURIComponent(type)}/${cleanId}`,
            },
        ],
    });
};
