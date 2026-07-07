#!/usr/bin/env node
/**
 * isehara-game ローカルサーバ (プロトタイプ)
 * - 静的ファイル配信 (ゲーム本体 = 親フォルダの index.html)
 * - /api/elevation/* -> https://api.opentopodata.org/* のプロキシ+ディスクキャッシュ
 * - /api/overpass?*  -> https://overpass-api.de/api/interpreter?* のプロキシ+ディスクキャッシュ
 * - index.html 配信時に fetch を書き換える小スクリプトを注入 (index.html 自体は無変更)
 * - 上流へは 1.1 秒間隔のレート制限を厳守。キャッシュヒットは即応答
 *
 * Node.js 標準モジュールのみ使用。npm install 不要。
 */
'use strict';

const http = require('http');
const https = require('https');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');

const PORT = Number(process.env.PORT || process.argv[2] || 8080);
const HOST = '0.0.0.0';
const ROOT = path.join(__dirname, '..');          // ゲーム本体 (index.html のある場所)
const CACHE_DIR = path.join(__dirname, 'cache');
const MIN_INTERVAL_MS = 1100;                     // 上流レート制限 (1req/秒 + 余裕)
const UPSTREAM_TIMEOUT_MS = 45000;
const MAX_ATTEMPTS = 3;

const APIS = {
  '/api/elevation': { upstream: 'https://api.opentopodata.org', dir: 'elevation' },
  '/api/overpass':  { upstream: 'https://overpass-api.de/api/interpreter', dir: 'overpass' },
  '/api/nominatim': { upstream: 'https://nominatim.openstreetmap.org/reverse', dir: 'nominatim' }, // 現在地の住所表示(逆ジオコーディング)用
};

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json',
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg',
  '.gif': 'image/gif', '.svg': 'image/svg+xml', '.ico': 'image/x-icon',
  '.glb': 'model/gltf-binary', '.gltf': 'model/gltf+json',
  '.mp3': 'audio/mpeg', '.ogg': 'audio/ogg', '.wav': 'audio/wav',
  '.woff': 'font/woff', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8',
};

/* ---------- index.html に注入するスクリプト ----------
 * - opentopodata / overpass への fetch を同一オリジンのプロキシに書き換え
 * - 直前のAPI応答がキャッシュヒット (X-Cache: HIT) だった場合のみ、
 *   ゲーム側のレート制限待ち setTimeout(1100ms / 1500ms) を短縮する
 *   (コールドキャッシュ時は従来どおり待つので上流にも安全)
 */
const INJECT = `<script>
(() => {
  const MAP = [
    ['https://api.opentopodata.org', '/api/elevation'],
    ['https://overpass-api.de/api/interpreter', '/api/overpass'],
    ['https://nominatim.openstreetmap.org/reverse', '/api/nominatim'],
  ];
  let lastApiWasCacheHit = false;
  const origFetch = window.fetch.bind(window);
  window.fetch = function(input, init) {
    let url = (typeof input === 'string') ? input : (input && input.url) || '';
    for (const [prefix, local] of MAP) {
      if (url.startsWith(prefix)) {
        const p = origFetch(local + url.slice(prefix.length), init);
        return p.then(res => { lastApiWasCacheHit = res.headers.get('X-Cache') === 'HIT'; return res; });
      }
    }
    return origFetch(input, init);
  };
  const origST = window.setTimeout;
  window.setTimeout = function(fn, delay, ...args) {
    if ((delay === 1100 || delay === 1500) && lastApiWasCacheHit) delay = 15;
    return origST.call(window, fn, delay, ...args);
  };
})();
</script>`;

/* ---------- ユーティリティ ---------- */
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

function cachePath(apiDir, upstreamUrl) {
  const h = crypto.createHash('sha1').update(upstreamUrl).digest('hex');
  return path.join(CACHE_DIR, apiDir, h + '.json');
}

/* ---------- 上流レート制限 (ホスト別・直列キュー) ---------- */
const lastStartAt = new Map();
const chains = new Map();
function scheduleUpstream(host, task) {
  const prev = chains.get(host) || Promise.resolve();
  const p = prev.then(async () => {
    const wait = (lastStartAt.get(host) || 0) + MIN_INTERVAL_MS - Date.now();
    if (wait > 0) await sleep(wait);
    lastStartAt.set(host, Date.now());
    return task();
  });
  chains.set(host, p.then(() => {}, () => {})); // 失敗してもキューは継続
  return p;
}

/* ---------- 上流 GET (標準 https、リトライ付き) ---------- */
function httpsGetOnce(urlStr) {
  return new Promise((resolve, reject) => {
    const req = https.get(urlStr, { headers: { 'User-Agent': 'isehara-game-proxy/1.0' } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({
        status: res.statusCode,
        contentType: res.headers['content-type'] || 'application/json',
        body: Buffer.concat(chunks),
      }));
    });
    req.setTimeout(UPSTREAM_TIMEOUT_MS, () => req.destroy(new Error('upstream timeout')));
    req.on('error', reject);
  });
}

async function fetchUpstream(upstreamUrl) {
  const host = new URL(upstreamUrl).host;
  let lastErr = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await scheduleUpstream(host, () => httpsGetOnce(upstreamUrl));
      if (res.status === 200) return res;
      lastErr = new Error('upstream HTTP ' + res.status);
      if (res.status === 429 || res.status >= 500) {
        log(`  retry ${attempt}/${MAX_ATTEMPTS} (HTTP ${res.status}) ${host}`);
        await sleep(1500 * attempt);
        continue;
      }
      return res; // 4xx 等はそのまま返す
    } catch (e) {
      lastErr = e;
      log(`  retry ${attempt}/${MAX_ATTEMPTS} (${e.message}) ${host}`);
      await sleep(1500 * attempt);
    }
  }
  throw lastErr;
}

/* ---------- プロキシ本体 (キャッシュ + 同時リクエスト合流) ---------- */
const inflight = new Map();

async function handleApi(req, res, apiKey) {
  const api = APIS[apiKey];
  const rest = req.url.slice(apiKey.length); // 例: "/v1/srtm30m?locations=..." / "?data=..."
  const upstreamUrl = api.upstream + rest;
  const file = cachePath(api.dir, upstreamUrl);

  // 1) キャッシュヒット → 即応答
  try {
    const cached = JSON.parse(await fsp.readFile(file, 'utf8'));
    res.writeHead(200, { 'Content-Type': cached.contentType, 'X-Cache': 'HIT' });
    res.end(cached.body);
    log(`HIT  ${apiKey} ${rest.slice(0, 60)}...`);
    return;
  } catch (_) { /* miss */ }

  // 2) ミス → 上流 (同一URLの同時リクエストは1本に合流)
  let p = inflight.get(upstreamUrl);
  if (!p) {
    p = (async () => {
      const t0 = Date.now();
      const up = await fetchUpstream(upstreamUrl);
      log(`MISS ${apiKey} -> upstream ${up.status} (${Date.now() - t0}ms)`);
      if (up.status === 200) {
        const bodyStr = up.body.toString('utf8');
        try { JSON.parse(bodyStr); } catch (e) { throw new Error('upstream returned non-JSON'); }
        await fsp.mkdir(path.dirname(file), { recursive: true });
        const tmp = file + '.tmp';
        await fsp.writeFile(tmp, JSON.stringify({ url: upstreamUrl, cachedAt: new Date().toISOString(), contentType: up.contentType, body: bodyStr }));
        await fsp.rename(tmp, file);
        return { status: 200, contentType: up.contentType, body: bodyStr };
      }
      return { status: up.status, contentType: up.contentType, body: up.body.toString('utf8') };
    })();
    inflight.set(upstreamUrl, p);
    const cleanup = () => inflight.delete(upstreamUrl);
    p.then(cleanup, cleanup);
  }

  try {
    const out = await p;
    res.writeHead(out.status, { 'Content-Type': out.contentType, 'X-Cache': 'MISS' });
    res.end(out.body);
  } catch (e) {
    log(`FAIL ${apiKey}: ${e.message}`);
    res.writeHead(502, { 'Content-Type': 'application/json', 'X-Cache': 'MISS' });
    res.end(JSON.stringify({ error: 'proxy_failed', message: e.message }));
  }
}

/* ---------- 静的ファイル配信 ---------- */
async function handleStatic(req, res) {
  let urlPath = decodeURIComponent(req.url.split('?')[0]);
  if (urlPath === '/') urlPath = '/index.html';
  const filePath = path.normalize(path.join(ROOT, urlPath));
  if (filePath !== ROOT && !filePath.startsWith(ROOT + path.sep)) { res.writeHead(403); res.end('Forbidden'); return; }

  let data;
  try {
    data = await fsp.readFile(filePath);
  } catch (_) {
    res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('404 Not Found');
    return;
  }

  const ext = path.extname(filePath).toLowerCase();
  const mime = MIME[ext] || 'application/octet-stream';

  // index.html にはプロキシ用スクリプトを注入して配信 (ファイル自体は無変更)
  if (path.basename(filePath) === 'index.html') {
    let html = data.toString('utf8');
    if (/<head[^>]*>/i.test(html)) html = html.replace(/<head[^>]*>/i, (m) => m + '\n' + INJECT);
    else html = INJECT + html;
    res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-cache' });
    res.end(html);
    return;
  }

  res.writeHead(200, { 'Content-Type': mime });
  res.end(data);
}

/* ---------- サーバ ---------- */
const server = http.createServer((req, res) => {
  const apiKey = Object.keys(APIS).find((k) => req.url === k || req.url.startsWith(k + '/') || req.url.startsWith(k + '?'));
  if (apiKey) { handleApi(req, res, apiKey).catch(() => { try { res.writeHead(500); res.end(); } catch (_) {} }); return; }
  handleStatic(req, res).catch(() => { try { res.writeHead(500); res.end(); } catch (_) {} });
});

server.listen(PORT, HOST, () => {
  console.log('isehara-game server (proxy + cache)');
  console.log(`  game root : ${ROOT}`);
  console.log(`  cache dir : ${CACHE_DIR}`);
  console.log(`  listening : http://localhost:${PORT}/  (LAN: http://<このPCのIP>:${PORT}/)`);
});
