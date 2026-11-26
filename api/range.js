const MAX_CHUNK_BYTES = 2 * 1024 * 1024; // 2 MiB per serverless response (well under Vercel's 4.5 MB limit)

function isBlockedHost(hostname) {
    if (!hostname) return true;
    const lower = hostname.toLowerCase();
    if (
        lower === 'localhost' ||
        lower === '127.0.0.1' ||
        lower === '0.0.0.0' ||
        lower === '::1' ||
        lower.endsWith('.local') ||
        lower.endsWith('.internal')
    ) {
        return true;
    }
    // Block private IPv4 ranges (SSRF protection)
    const ipv4 = lower.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (ipv4) {
        const [, a, b] = ipv4.map(Number);
        if (
            a === 10 ||
            a === 127 ||
            a === 0 ||
            (a === 169 && b === 254) ||
            (a === 172 && b >= 16 && b <= 31) ||
            (a === 192 && b === 168)
        ) {
            return true;
        }
    }
    return false;
}

module.exports = async (req, res) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Headers', 'Range, Content-Type');
    res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Range, Content-Length, Accept-Ranges, X-Resolved-Url');

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
    } catch (_) {
        res.status(400).json({ error: 'Invalid url parameter' });
        return;
    }

    if ((parsed.protocol !== 'http:' && parsed.protocol !== 'https:') || isBlockedHost(parsed.hostname)) {
        res.status(400).json({ error: 'Unsupported target host' });
        return;
    }

    try {
        // Probe mode: fetch 1 byte (bytes=0-0) to discover total file size and resolved redirect URL
        if (req.query.probe === '1') {
            const upstream = await fetch(parsed.toString(), {
                method: 'GET',
                headers: {
                    Range: 'bytes=0-0',
                    'User-Agent': 'Mozilla/5.0',
                },
                redirect: 'follow',
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

            // Cancel body immediately so we don't download full stream if server ignored Range
            if (upstream.body && typeof upstream.body.cancel === 'function') {
                await upstream.body.cancel().catch(() => {});
            }

            const finalUrl = upstream.url || parsed.toString();
            let finalParsed;
            try {
                finalParsed = new URL(finalUrl);
            } catch (_) {
                finalParsed = null;
            }
            const safeFinalUrl = finalParsed && !isBlockedHost(finalParsed.hostname) ? finalUrl : parsed.toString();

            res.status(200).json({
                size: Number.isFinite(size) && size > 0 ? size : null,
                finalUrl: safeFinalUrl,
            });
            return;
        }

        const start = Math.max(0, parseInt(req.query.start, 10) || 0);
        const requestedEnd = parseInt(req.query.end, 10);
        const end = Number.isFinite(requestedEnd) && requestedEnd >= start
            ? Math.min(requestedEnd, start + MAX_CHUNK_BYTES - 1)
            : start + MAX_CHUNK_BYTES - 1;

        const upstream = await fetch(parsed.toString(), {
            method: 'GET',
            headers: {
                Range: `bytes=${start}-${end}`,
                'User-Agent': 'Mozilla/5.0',
            },
            redirect: 'follow',
        });

        if (!upstream.ok && upstream.status !== 206) {
            res.status(upstream.status).json({ error: `Upstream HTTP ${upstream.status}` });
            return;
        }

        const arrayBuffer = await upstream.arrayBuffer();
        let buffer = Buffer.from(arrayBuffer);

        // If upstream ignored Range and returned 200 with more bytes than requested, slice safely
        const expectedLen = end - start + 1;
        if (upstream.status === 200 && start === 0 && buffer.length > expectedLen) {
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
