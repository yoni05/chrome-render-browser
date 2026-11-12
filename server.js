const express = require('express');
const ytdl = require('@distube/ytdl-core');

const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// פתיחת גישה מלאה (CORS) כדי שקובץ ה-HTML המקומי יוכל לתקשר עם Render בחופשיות
app.use((req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', '*');
    if (req.method === 'OPTIONS') return res.sendStatus(200);
    next();
});

const YT_KEY = (process.env.YOUTUBE_API_KEY || '').trim();

const INVIDIOUS_HOSTS = [
    'https://inv.nadeko.net',
    'https://invidious.nerdvpn.de',
    'https://inv.tux.pizza',
    'https://yt.chocolatemoo53.com'
];

async function fetchWithTimeout(url, options = {}, timeout = 12000) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
        const res = await fetch(url, { ...options, signal: controller.signal });
        clearTimeout(timer);
        return res;
    } catch (e) {
        clearTimeout(timer);
        throw e;
    }
}

app.get('/', (req, res) => {
    res.send('Chrome Render Gateway Server Ready');
});

// 1. חיפוש סרטונים (תומך ב-YouTube API או בחיפוש ישיר ללא מפתח)
app.get('/api/search', async (req, res) => {
    const q = String(req.query.q || '').trim();
    if (!q) return res.json({ items: [] });

    // אם קיים מפתח YouTube Data API בשרת
    if (YT_KEY) {
        try {
            const u = `https://www.googleapis.com/youtube/v3/search?part=snippet&q=${encodeURIComponent(q)}&type=video&maxResults=12&key=${YT_KEY}`;
            const r = await fetchWithTimeout(u, {}, 8000);
            if (r.ok) {
                const d = await r.json();
                const items = (d.items || []).map(it => ({
                    videoId: it.id.videoId,
                    title: it.snippet.title,
                    author: it.snippet.channelTitle,
                    thumb: it.snippet.thumbnails?.medium?.url || `https://i.ytimg.com/vi/${it.id.videoId}/mqdefault.jpg`
                }));
                if (items.length > 0) return res.json({ items });
            }
        } catch (e) {}
    }

    // חיפוש אוטומטי ללא צורך במפתח דרך שרתי Invidious
    for (const host of INVIDIOUS_HOSTS) {
        try {
            const r = await fetchWithTimeout(`${host}/api/v1/search?q=${encodeURIComponent(q)}&type=video`, {
                headers: { 'User-Agent': 'Mozilla/5.0' }
            }, 6000);
            if (r.ok) {
                const arr = await r.json();
                const items = (arr || []).filter(x => x.videoId).slice(0, 12).map(x => ({
                    videoId: x.videoId,
                    title: x.title || 'סרטון',
                    author: x.author || '',
                    thumb: `https://i.ytimg.com/vi/${x.videoId}/mqdefault.jpg`
                }));
                if (items.length > 0) return res.json({ items });
            }
        } catch (e) {}
    }

    res.status(500).json({ error: 'לא נמצאו תוצאות או שהחיפוש נכשל' });
});

// 2. חיפוש אתרים כללי ברשת
app.get('/api/websearch', async (req, res) => {
    const q = String(req.query.q || '').trim();
    if (!q) return res.json({ results: [] });
    try {
        const u = `https://html.duckduckgo.com/html/?q=${encodeURIComponent(q)}`;
        const r = await fetchWithTimeout(u, {
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)' }
        }, 10000);
        const html = await r.text();
        const results = [];
        const regex = /<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
        let m;
        while ((m = regex.exec(html)) !== null && results.length < 15) {
            let link = m[1];
            const uddg = link.match(/uddg=([^&]+)/);
            if (uddg) link = decodeURIComponent(uddg[1]);
            const title = m[2].replace(/<[^>]+>/g, '').trim();
            if (link.startsWith('http')) {
                results.push({ title, url: link });
            }
        }
        res.json({ results });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// 3. הזרמת וידאו ישירה (MP4 עם תמיכה בהרצה קדימה/אחורה) לדפדפן שב-HTML
app.get('/api/video', async (req, res) => {
    let videoId = String(req.query.id || '').trim();
    const urlParam = String(req.query.url || '').trim();
    if (!videoId && urlParam) {
        const m = urlParam.match(/(?:v=|youtu\.be\/|embed\/|shorts\/)([a-zA-Z0-9_-]{11})/);
        if (m) videoId = m[1];
    }
    if (!videoId) return res.status(400).send('Missing video ID');

    // ניסיון א': הזרמת MP4 משולב (וידאו + שמע) דרך פרוקסי מהיר (itag=18)
    for (const host of INVIDIOUS_HOSTS) {
        try {
            const streamUrl = `${host}/latest_version?id=${videoId}&itag=18&local=true`;
            const headers = { 'User-Agent': 'Mozilla/5.0' };
            if (req.headers.range) headers['Range'] = req.headers.range;

            const upstream = await fetchWithTimeout(streamUrl, { headers }, 10000);
            const cType = (upstream.headers.get('content-type') || '').toLowerCase();
            if ((upstream.ok || upstream.status === 206) && !cType.includes('text/html')) {
                res.status(upstream.status);
                res.setHeader('Content-Type', 'video/mp4');
                res.setHeader('Accept-Ranges', 'bytes');
                const cLen = upstream.headers.get('content-length');
                const cRange = upstream.headers.get('content-range');
                if (cLen) res.setHeader('Content-Length', cLen);
                if (cRange) res.setHeader('Content-Range', cRange);
                if (req.query.dl === '1') {
                    res.setHeader('Content-Disposition', `attachment; filename="video_${videoId}.mp4"`);
                }
                for await (const chunk of upstream.body) {
                    res.write(chunk);
                }
                return res.end();
            }
        } catch (e) {}
    }

    // ניסיון ב': גיבוי ישיר באמצעות ytdl-core
    try {
        res.setHeader('Content-Type', 'video/mp4');
        if (req.query.dl === '1') {
            res.setHeader('Content-Disposition', `attachment; filename="video_${videoId}.mp4"`);
        }
        const stream = ytdl(`https://www.youtube.com/watch?v=${videoId}`, {
            filter: format => format.container === 'mp4' && format.hasVideo && format.hasAudio,
            quality: 'highest'
        });
        stream.on('error', err => {
            console.error('ytdl error:', err.message);
            if (!res.headersSent) res.status(500).end('Video stream error');
        });
        stream.pipe(res);
    } catch (err) {
        if (!res.headersSent) res.status(500).send('Failed to stream video: ' + err.message);
    }
});

// 4. פרוקסי תמונות ממוזערות של סרטונים (כדי שייפתחו תמיד דרך Render)
app.get('/api/thumb', async (req, res) => {
    const id = String(req.query.id || '').replace(/[^a-zA-Z0-9_-]/g, '');
    if (!id) return res.sendStatus(400);
    try {
        const r = await fetchWithTimeout(`https://i.ytimg.com/vi/${id}/mqdefault.jpg`, {}, 6000);
        res.setHeader('Content-Type', 'image/jpeg');
        const buf = Buffer.from(await r.arrayBuffer());
        res.send(buf);
    } catch (e) {
        res.sendStatus(404);
    }
});

// 5. פתיחת כל קישור ואתר חיצוני דרך שרת ה-Render (Web Proxy)
app.get('/api/proxy', async (req, res) => {
    const target = String(req.query.url || '').trim();
    if (!target || !/^https?:\/\//i.test(target)) {
        return res.status(400).send('כתובת לא תקינה');
    }
    try {
        const r = await fetchWithTimeout(target, {
            headers: {
                'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/122.0.0.0 Safari/537.36',
                'Accept-Language': 'he-IL,he;q=0.9,en-US;q=0.8,en;q=0.7'
            }
        }, 15000);

        const cType = r.headers.get('content-type') || 'text/html; charset=utf-8';
        res.setHeader('Content-Type', cType);

        if (cType.includes('text/html')) {
            let html = await r.text();
            const baseTag = `<base href="${target}">`;
            if (/<head[^>]*>/i.test(html)) {
                html = html.replace(/<head[^>]*>/i, match => `${match}${baseTag}`);
            } else {
                html = baseTag + html;
            }
            return res.send(html);
        } else {
            const buf = Buffer.from(await r.arrayBuffer());
            return res.send(buf);
        }
    } catch (e) {
        res.status(500).send(`שגיאה בטעינת האתר דרך השרת: ${e.message}`);
    }
});

const port = process.env.PORT || 3000;
app.listen(port, () => console.log(`=== Chrome Render Gateway Ready on port ${port} ===`));
