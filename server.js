const express = require('express');
const WebSocket = require('ws');
const puppeteer = require('puppeteer');
const axios = require('axios');
const cheerio = require('cheerio');

const app = express();
app.use(express.json());

const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

// --- Decoder XOR Logic ---
function decodeURIData(encodedString, prefixLength = 5) {
    const base64Decoded = Buffer.from(encodedString, 'base64').toString('binary');
    const prefix = base64Decoded.substring(0, prefixLength);
    const body = base64Decoded.substring(prefixLength);
    let decoded = '';
    for (let i = 0; i < body.length; i++) {
        decoded += String.fromCharCode(body.charCodeAt(i) ^ prefix.charCodeAt(i % prefix.length));
    }
    return decoded;
}

async function getLootData(lootUrl) {
    console.log(`[BROWSER] Launching browser...`);

    const browser = await puppeteer.launch({
    headless: "new",
    args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--no-zygote',
        '--single-process'
    ]
});

    const page = await browser.newPage();
    let lootParams = null;

    page.on('response', async response => {
        try {
            const text = await response.text();
            if (text.includes('urid')) {
                const json = JSON.parse(text);
                const item = Array.isArray(json) ? json[0] : json;
                if (item?.urid) {
                    lootParams = {
                        urid: item.urid,
                        pixel: item.action_pixel_url,
                        task_id: item.task_id || 8
                    };
                }
            }
        } catch {}
    });

    await page.setUserAgent(UA);

    try {
        await page.goto(lootUrl, {
            waitUntil: 'domcontentloaded',
            timeout: 60000
        }).catch(async () => {
            console.log('[BROWSER] Retry...');
            await page.goto(lootUrl, {
                waitUntil: 'networkidle2',
                timeout: 60000
            });
        });

        await page.evaluate(() => window.scrollBy(0, 500));
        await new Promise(r => setTimeout(r, 8000));

        const html = await page.content();
        const $ = cheerio.load(html);

        let extracted = {
            TID: null,
            KEY: null,
            SERVER: "onsultingco.com",
            SYNCER: "nerventualken.com",
            SESSION: null
        };

        $('script').each((i, el) => {
            const content = $(el).html();
            if (!content) return;

            const keyM = content.match(/p\['KEY'\]\s*=\s*["'](\d+)["']/);
            const tidM = content.match(/p\['TID'\]\s*=\s*(\d+)/);
            const srvM = content.match(/INCENTIVE_SERVER_DOMAIN\s*=\s*["']([^"']+)["']/);
            const syncM = content.match(/INCENTIVE_SYNCER_DOMAIN\s*=\s*["']([^"']+)["']/);

            if (keyM) extracted.KEY = keyM[1];
            if (tidM) extracted.TID = tidM[1];
            if (srvM) extracted.SERVER = srvM[1];
            if (syncM) extracted.SYNCER = syncM[1];
        });

        extracted.SESSION = await page.evaluate(() => document.session || null);

        if (!lootParams || !extracted.KEY) {
            await browser.close();
            throw new Error('Failed to extract KEY or URID');
        }

        return { ...lootParams, ...extracted, browser };

    } catch (e) {
        if (browser) await browser.close();
        throw e;
    }
}

async function resolvePublisherLink(data) {
    const shard = data.urid.substr(-5) % 3;
    const hostname = `${shard}.${data.SERVER}`;

    const wsUrl = `wss://${hostname}/c?uid=${data.urid}&cat=${data.task_id}&key=${data.KEY}&session_id=${data.SESSION}&is_loot=1&tid=${data.TID}`;
    console.log(`[WS] Connecting: ${wsUrl}`);

    return new Promise((resolve, reject) => {
        const ws = new WebSocket(wsUrl, {
            origin: `https://${hostname}`,
            headers: { 'user-agent': UA }
        });

        let hb;
        let result = "";
        let done = false;

        const timeout = setTimeout(() => {
            if (!done) {
                ws.terminate();
                reject(new Error('Timeout'));
            }
        }, 200000);

        ws.on('open', () => {
            hb = setInterval(() => {
                if (ws.readyState === WebSocket.OPEN) ws.send('0');
            }, 1000);

            (async () => {
                try {
                    const base = `https://${hostname}`;
                    await axios.get(`${base}/st?uid=${data.urid}&cat=${data.task_id}`);
                    await axios.get(`${base}/p?uid=${data.urid}`);
                    const px = data.pixel.startsWith('http') ? data.pixel : `https:${data.pixel}`;
                    await axios.get(px);
                    await axios.get(`https://${data.SYNCER}/td?ac=auto_complete&urid=${data.urid}&cat=${data.task_id}&tid=${data.TID}`);
                    await axios.get(`${base}/ad?uid=${data.urid}`);
                } catch {}
            })();
        });

        ws.on('message', (buffer) => {
            const msg = buffer.toString();

            if (msg.startsWith('r:')) {
                result = msg.replace('r:', '').trim();
            }

            if (!msg.includes(',') && msg.length > 25) {
                try {
                    const decoded = decodeURIComponent(decodeURIData(msg));
                    if (decoded.includes('http')) {
                        result = msg;
                    }
                } catch {}
            }
        });

        ws.on('close', () => {
            clearInterval(hb);
            clearTimeout(timeout);

            if (result) {
                done = true;
                resolve(result);
            } else {
                reject(new Error('No result'));
            }
        });

        ws.on('error', reject);
    });
}

// ✅ FINAL FIXED ROUTE (NO URL BREAKING)
app.get('/bypass', async (req, res) => {
    try {
        const raw = req.originalUrl.split('?url=')[1];
        if (!raw) return res.status(400).json({ error: 'Missing ?url=' });

        // decode once
        let decoded = decodeURIComponent(raw);

        // 🔥 ONLY fix bad characters (DO NOT rebuild URL)
        decoded = decoded
            .replace(/\+/g, '%2B')
            .replace(/ /g, '%20');

        const safeUrl = decoded;

        console.log(`[INPUT RAW]: ${raw}`);
        console.log(`[INPUT FINAL]: ${safeUrl}`);

        const lootData = await getLootData(safeUrl);
        const encodedLink = await resolvePublisherLink(lootData);

        let finalUrl = decodeURIComponent(decodeURIData(encodedLink));
        
        // 🔥 REMOVE TRASH CHARACTERS
        finalUrl = finalUrl.replace(/\f/g, '').trim();

        await lootData.browser.close();

        console.log(`[✓] Resolved: ${finalUrl}`);
        res.json({ success: true, RESULT: finalUrl });

    } catch (err) {
        console.error(err);
        res.status(500).json({ success: false, error: err.message });
    }
});

const PORT = process.env.PORT || 3100;
app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
