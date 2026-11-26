const dns = require('dns').promises;
const net = require('net');

const MAX_CHUNK_BYTES = 2 * 1024 * 1024; // 2 MiB per serverless response (well under Vercel's 4.5 MB limit)
const MAX_REDIRECTS = 5;

function isPrivateIPv4(ip) {
    const parts = ip.split('.').map(Number);
    if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return true;
    const [a, b] = parts;
    return (
        a === 0 ||
        a === 10 ||
        a === 127 ||
        (a === 100 && b >= 64 && b <= 127) || // CGNAT
        (a === 169 && b === 254) ||
        (a === 172 && b >= 16 && b <= 31) ||
        (a === 192 && b === 168) ||
        (a === 192 && b === 0) ||
        (a === 198 && (b === 18 || b === 19)) ||
        a >= 224 // multicast + reserved
    );
}

function isPrivateIPv6(ip) {
    const lower = ip.toLowerCase();
    if (lower === '::' || lower === '::1') return true;
    // IPv4-mapped (::ffff:a.b.c.d or ::ffff:7f00:1)
    const mappedDotted = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mappedDotted) return isPrivateIPv4(mappedDotted[1]);
    if (lower.startsWith('::ffff:')) return true; // hex-form mapped: reject conservatively
    if (/^f[cd]/.test(lower)) return true; // fc00::/7 unique local
    if (/^fe[89ab]/.test(lower)) return true; // fe80::/10 link-local
    if (lower.startsWith('ff')) return true; // multicast
    return false;
}

function isPrivateAddress(ip) {
    const family = net.isIP(ip);
    if (family === 4) return isPrivateIPv4(ip);
    if (family === 6) return isPrivateIPv6(ip);
    return true;
}

// Rejects loopback/private/link-local targets, including hostnames that DNS-resolve to them.
async function assertPublicUrl(urlObj) {
    if (urlObj.protocol !== 'http:' && urlObj.protocol !== 'https:') {
        throw new Error('Unsupported protocol');
    }
    // WHATWG URL keeps IPv6 literals wrapped in brackets
    const host = urlObj.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') || host.endsWith('.internal')) {
        throw new Error('Blocked host');
    }
    if (net.isIP(host)) {
        if (isPrivateAddress(host)) throw new Error('Blocked host');
        return;
    }
    const addresses = await dns.lookup(host, { all: true });
    if (!addresses.length || addresses.some(({ address }) => isPrivateAddress(address))) {
        throw new Error('Blocked host');
    }
}

// fetch() with manual redirect handling so every hop is validated, not just the first URL.
async function safeFetch(startUrl, init) {
    let current = new URL(startUrl);
    for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
        await assertPublicUrl(current);
        const response = await fetch(current.toString(), { ...init, redirect: 'manual' });
        if (response.status >= 300 && response.status < 400 && response.headers.get('location')) {
            if (response.body && typeof response.body.cancel === 'function') {
                await response.body.cancel().catch(() => {});
            }
            current = new URL(response.headers.get('location'), current);
            continue;
        }
        return { response, finalUrl: current.toString() };
    }
    throw new Error('Too many redirects');
}

module.exports = async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Range, Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Content-Length, Accept-Ranges');

    if (req.method === 'OPTIONS') {
        res.status(200).end();
        return;
    }

    const targetUrl = req.query.url;
    if (!targetUrl || typeof targetUrl !== 'string') {
        res.status(400).json({ error: 'Missing url parameter' });
        return;
    }

    let parsed;
    try {
        parsed = new URL(targetUrl);
        await assertPublicUrl(parsed);
    } catch (_) {
        res.status(400).json({ error: 'Unsupported target host' });
        return;
    }

    try {
        // Probe mode: fetch 1 byte to discover the total file size and the final (post-redirect) URL
        if (req.query.probe === '1') {
            const { response: upstream, finalUrl } = await safeFetch(parsed.toString(), {
                method: 'GET',
                headers: { Range: 'bytes=0-0', 'User-Agent': 'Mozilla/5.0' },
            });

            let size = null;
            const contentRange = upstream.headers.get('content-range');
            if (contentRange) {
                const match = contentRange.match(/\/(\d+)\s*$/);
                if (match) size = Number(match[1]);
            }
            if (!size && upstream.status === 200) {
                const cl = upstream.headers.get('content-length');
                if (cl) size = Number(cl);
            }

            // Cancel body immediately so we don't download the full stream if the server ignored Range
            if (upstream.body && typeof upstream.body.cancel === 'function') {
                await upstream.body.cancel().catch(() => {});
            }

            if (!upstream.ok && upstream.status !== 206) {
                res.status(upstream.status).json({ error: `Upstream HTTP ${upstream.status}` });
                return;
            }

            res.status(200).json({
                size: Number.isFinite(size) && size > 0 ? size : null,
                finalUrl,
            });
            return;
        }

        const start = Math.max(0, parseInt(req.query.start, 10) || 0);
        const requestedEnd = parseInt(req.query.end, 10);
        const end = Number.isFinite(requestedEnd) && requestedEnd >= start
            ? Math.min(requestedEnd, start + MAX_CHUNK_BYTES - 1)
            : start + MAX_CHUNK_BYTES - 1;

        const { response: upstream } = await safeFetch(parsed.toString(), {
            method: 'GET',
            headers: { Range: `bytes=${start}-${end}`, 'User-Agent': 'Mozilla/5.0' },
        });

        if (!upstream.ok && upstream.status !== 206) {
            if (upstream.body && typeof upstream.body.cancel === 'function') {
                await upstream.body.cancel().catch(() => {});
            }
            res.status(upstream.status).json({ error: `Upstream HTTP ${upstream.status}` });
            return;
        }

        const expectedLen = end - start + 1;
        let buffer;
        if (upstream.status === 200 && start > 0) {
            // Upstream ignored Range and is sending the whole file from byte 0; refuse rather than buffer it all
            if (upstream.body && typeof upstream.body.cancel === 'function') {
                await upstream.body.cancel().catch(() => {});
            }
            res.status(416).json({ error: 'Upstream does not support Range requests' });
            return;
        }
        buffer = Buffer.from(await upstream.arrayBuffer());
        if (buffer.length > expectedLen) {
            buffer = buffer.subarray(0, expectedLen);
        }

        const contentRange = upstream.headers.get('content-range');
        if (contentRange) {
            res.setHeader('Content-Range', contentRange);
        }
        res.setHeader('Content-Type', 'application/octet-stream');
        res.setHeader('Content-Length', String(buffer.length));
        res.setHeader('Cache-Control', 'public, max-age=300');
        res.status(206).send(buffer);
    } catch (err) {
        res.status(502).json({ error: err && err.message ? err.message : 'Upstream fetch failed' });
    }
};
