#!/usr/bin/env node
/**
 * ChronoDrift ローカルサーバ (プロトタイプ)
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
const { execSync } = require('child_process');

const PORT = Number(process.env.PORT || process.argv[2] || 8080);
const HOST = '0.0.0.0';
const ROOT = path.join(__dirname, '..');          // ゲーム本体 (index.html のある場所)
const CACHE_DIR = path.join(__dirname, 'cache');
const MIN_INTERVAL_MS = 1100;                     // 上流レート制限 (1req/秒 + 余裕)
const UPSTREAM_TIMEOUT_MS = 45000;
const MAX_ATTEMPTS = 3;

// ---------- デプロイ日時 ----------
// Renderはデプロイのたびにこのプロセスを新しく起動し直すため、プロセス起動時刻が
// 実質的な「デプロイ日時」として使える。ビルドコマンドが無い(echo no build)ため
// ビルド時刻を別途記録する手段が無く、これが最も簡単で確実。
// あわせて .git が残っていれば直近コミットのハッシュ・日時も拾う(無ければnullのまま)。
const DEPLOY_TIME = new Date();
let DEPLOY_COMMIT = null, DEPLOY_COMMIT_TIME = null;
try {
  DEPLOY_COMMIT = execSync('git rev-parse --short HEAD', { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
  DEPLOY_COMMIT_TIME = execSync('git log -1 --format=%cI', { cwd: ROOT, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
} catch (_) { /* gitが無い/取得失敗時はプロセス起動時刻だけを使う */ }

// Overpassはメインの overpass-api.de が混雑/不調になることがあるため、
// 独立運営の別ミラーへのフォールバックを用意する(2026-07: 香港・上海等で
// overpass-api.de がプロキシ経由・ブラウザ直接の両方でタイムアウトする事象を確認)。
// 東京(伊勢原)がテストで問題なく見えていたのは、直近の試行が既にディスクキャッシュに
// 乗っていて上流に問い合わせずに済んでいただけの可能性が高く、地形データが国によって
// 恒久的に取得不可というわけではない。
const OVERPASS_MIRRORS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
];

const APIS = {
  '/api/elevation': { upstream: 'https://api.opentopodata.org', dir: 'elevation' },
  '/api/overpass':  { upstream: OVERPASS_MIRRORS[0], dir: 'overpass', mirrors: OVERPASS_MIRRORS },
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

/* ---------- デプロイ情報をゲーム側へ渡すスクリプト ----------
 * ?ヘルプパネルから確認できるよう window.__DEPLOY_INFO__ に載せる。
 */
const DEPLOY_INFO_SCRIPT = `<script>window.__DEPLOY_INFO__ = ${JSON.stringify({
  time: DEPLOY_TIME.toISOString(),
  commit: DEPLOY_COMMIT,
  commitTime: DEPLOY_COMMIT_TIME,
})};</script>`;

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
  // プロキシ経由が上流に拒否された(5xx)APIは、以後ブラウザ→上流の直接アクセスに切り替える。
  // 【背景】Renderなど共有IPのホスティングはOverpass等の公開APIにIP単位で拒否/制限される
  // ことがある(2026-07: Render経由のOverpassが502連発→道路が格子状フォールバックになる
  // 症状の原因)。上流はいずれもCORS対応なのでブラウザから直接叩け、その場合は各プレイヤー
  // 自身のIPでレート制限枠を使うため、共有IPよりむしろ通りやすい。
  // プロキシが健在な間は従来どおりプロキシ+ディスクキャッシュを使う(ローカルで有効)。
  //
  // 【重要・2026-07-15追記】上記の直接アクセスには元々ペース配分が無く、proxyDownも一度
  // 立つとタブの生存中ずっと直接モードに固定されていた。実機で「しばらく動き回った後に
  // 道路・線路の拡張が止まる」を診断したところ、direct()経由でoverpass-api.deに429
  // (Too Many Requests)→さらに悪化してnet::ERR_CONNECTION_TIMED_OUT(一時的な接続拒否)
  // が連発しているのを確認。サーバ側は1.1秒間隔厳守だが、直接モードにはその制約が無いため
  // プレイヤーが速く動き回ってタイル要求が増えると連投になり、Overpass公開インスタンス側の
  // レート制限に自分から突っ込んでいた。かつ一度そうなると詰まったまま自己回復しない。
  // → (1) 直接モードにも同じ1.1秒間隔のペース配分を追加、(2) proxyDownを恒久フラグではなく
  // タイムスタンプにし、一定時間後にプロキシへの復帰を自動で試みるようにする。
  const proxyDown = {};
  const lastDirectAt = {};
  const DIRECT_MIN_INTERVAL_MS = 1100; // サーバ側のMIN_INTERVAL_MSと揃える
  const PROXY_RETRY_MS = 120000; // 2分ごとにプロキシへの復帰を試す(一時的な不調で永久固定されないように)
  // 【重要・2026-07-16】direct()の「最終アクセス時刻を見てwait時間を計算→sleep→時刻更新」は
  // 単純な read-modify-write で、呼び出し側(part8.jsはOSM_TILE_CONCURRENCY=2で並行に
  // fetchOSMTileBatchを呼ぶ)が同時に2回direct()を呼ぶと、両方とも更新前の古いlastDirectAtを
  // 読んでほぼ同じwait時間を計算し、ほぼ同時にorigFetchを発火してしまう競合状態だった
  // (実機で確認: 京橋・八重洲でdirect()経由のfetchが立て続けに429 Too Many Requestsになる
  // 事象と一致)。プレフィックスごとにPromiseチェーンで直列化し、「待つ→時刻更新」を
  // 呼び出しごとに確実に1つずつ順番に処理させる(server.js側のscheduleUpstreamと同じ考え方)。
  const directChains = {};
  // 【重要・2026-07-16】直接モードはoverpass-api.de単一ホスト固定だったため、密集地で
  // タイルのバックログが積むと1.1秒間隔でも公開インスタンスのレート制限に到達し、
  // 429/504が連発→part8.js側の失敗カウントが4に達して「諦め=永久空き地」になっていた
  // (実機コンソールで429/504の連鎖を確認)。直接モードもミラー輪番にし、429/5xx/
  // ネットワークエラーを返したミラーは一定時間除外する。ペース配分・直列化チェーンも
  // ミラー(ホスト)ごとに独立させ、健全なミラーが複数ある間は実効スループットも上がる。
  const OVERPASS_PREFIX = 'https://overpass-api.de/api/interpreter';
  const OVERPASS_DIRECT_MIRRORS = [
    'https://overpass-api.de/api/interpreter',
    'https://overpass.kumi.systems/api/interpreter',
    'https://overpass.private.coffee/api/interpreter',
  ];
  const mirrorBackoffUntil = {}; // ミラーURL -> このtimestampまで使わない
  const paceThrough = async (chainKey) => { // chainKeyごとに1.1秒間隔を直列で保証
    const prevChain = directChains[chainKey] || Promise.resolve();
    const myTurn = prevChain.then(async () => {
      const wait = (lastDirectAt[chainKey] || 0) + DIRECT_MIN_INTERVAL_MS - Date.now();
      if (wait > 0) await new Promise((r) => setTimeout(r, wait));
      lastDirectAt[chainKey] = Date.now();
    });
    directChains[chainKey] = myTurn.catch(() => {}); // 1件失敗してもチェーンは継続
    await myTurn;
  };
  const origFetch = window.fetch.bind(window);
  window.fetch = function(input, init) {
    let url = (typeof input === 'string') ? input : (input && input.url) || '';
    for (const [prefix, local] of MAP) {
      if (url.startsWith(prefix)) {
        const direct = async () => {
          if (prefix === OVERPASS_PREFIX) {
            const now = Date.now();
            const mirror = OVERPASS_DIRECT_MIRRORS.find((m) => (mirrorBackoffUntil[m] || 0) < now)
              || OVERPASS_DIRECT_MIRRORS[0]; // 全滅時は本家に戻す(part8側の再試行間隔に任せる)
            await paceThrough(mirror);
            try {
              const res = await origFetch(mirror + url.slice(prefix.length), init);
              if (res.status === 429) mirrorBackoffUntil[mirror] = Date.now() + 60000;
              else if (res.status >= 500) mirrorBackoffUntil[mirror] = Date.now() + 30000;
              return res;
            } catch (e) {
              // CORS非対応ミラーや一時的な接続拒否もここに来る。除外して呼び出し側に再試行させる。
              mirrorBackoffUntil[mirror] = Date.now() + 30000;
              throw e;
            }
          }
          await paceThrough(prefix);
          return origFetch(url, init);
        };
        const downSince = proxyDown[prefix];
        if (downSince && (Date.now() - downSince) < PROXY_RETRY_MS) return direct();
        return origFetch(local + url.slice(prefix.length), init).then(res => {
          lastApiWasCacheHit = res.headers.get('X-Cache') === 'HIT';
          if (res.status >= 500) { proxyDown[prefix] = Date.now(); return direct(); }
          proxyDown[prefix] = null; // プロキシ復帰確認
          return res;
        }, () => { proxyDown[prefix] = Date.now(); return direct(); });
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
  // 【重要・2026-07-15】ここでchainsに繋ぐpがもし永遠に確定(resolve/reject)しなければ、
  // 同じhostへの以降の全リクエスト(=全プレイヤー分)がこのpromiseの後ろに並んだまま
  // 永久に開始すらされなくなる(1件のハングでサーバ全体のOverpass取得が詰まる)。
  // 「道路・建物の生成が途中で止まる」がサーバー再起動(=デプロイのたび)まで直らず
  // 再発していたのは、httpsGetOnce側に必ず確定させる保証が無かったことが一因と推測される
  // (下記httpsGetOnceのハードタイムアウト参照)。
  chains.set(host, p.then(() => {}, () => {})); // 失敗してもキューは継続
  return p;
}

/* ---------- 上流リクエスト (標準 https、GET/POST両対応、リトライ付き) ---------- */
// 【重要・2026-07-15】以前はhttps.getのみでGET専用だった。Overpassの6タイルまとめクエリは
// URLに埋め込む(GET)と数千文字になり、overpass-api.deから414 (Request-URI Too Long)を
// 返される事象を確認(道路の拡張生成が完全に止まって見えた真因。詳細はpart8.js側コメント参照)。
// POST(ボディにdata=<クエリ>)はURL長に依存しないため、GET/POST両対応に拡張する。
function httpsRequestOnce(urlStr, opts) {
  opts = opts || {};
  return new Promise((resolve, reject) => {
    let settled = false;
    const settle = (fn, arg) => { if (settled) return; settled = true; clearTimeout(hardTimer); fn(arg); };
    // 【重要】req.setTimeout(下記)はソケットの「無通信」タイムアウトで、上流が細切れにでも
    // データを送り続ける限りリセットされ続け、実測で全体90秒以上pendingのまま(実質無期限)に
    // なるケースが確認された。かつ、レスポンスヘッダ受信後(res確定後)にreq側をdestroyしても
    // resにerrorリスナーが無いとreject/resolveどちらも呼ばれず、このPromiseが永久に解決しない
    // ことがある(scheduleUpstreamのchainsが永久に詰まる直接原因)。通信の活性・不活性に
    // 関わらず必ずどこかで確定させる「ハード上限」を別に設ける。
    const hardTimer = setTimeout(() => {
      req.destroy();
      settle(reject, new Error('upstream hard timeout (' + (UPSTREAM_TIMEOUT_MS + 15000) + 'ms)'));
    }, UPSTREAM_TIMEOUT_MS + 15000);
    const method = opts.method || 'GET';
    const headers = Object.assign({ 'User-Agent': 'chronodrift-proxy/1.0' }, opts.headers || {});
    if (opts.body) headers['Content-Length'] = Buffer.byteLength(opts.body);
    const req = https.request(urlStr, { method, headers }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => settle(resolve, {
        status: res.statusCode,
        contentType: res.headers['content-type'] || 'application/json',
        body: Buffer.concat(chunks),
      }));
      res.on('error', (e) => settle(reject, e)); // 【重要】これが無いのが上記の主因だった
    });
    req.setTimeout(UPSTREAM_TIMEOUT_MS, () => req.destroy(new Error('upstream timeout')));
    req.on('error', (e) => settle(reject, e));
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

async function fetchUpstream(upstreamUrl, opts) {
  opts = opts || {};
  const maxAttempts = opts.maxAttempts || MAX_ATTEMPTS;
  const host = new URL(upstreamUrl).host;
  let lastErr = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      const res = await scheduleUpstream(host, () => httpsRequestOnce(upstreamUrl, opts));
      if (res.status === 200) return res;
      lastErr = new Error('upstream HTTP ' + res.status);
      if (res.status === 429 || res.status >= 500) {
        log(`  retry ${attempt}/${maxAttempts} (HTTP ${res.status}) ${host}`);
        await sleep(1500 * attempt);
        continue;
      }
      return res; // 4xx 等はそのまま返す
    } catch (e) {
      lastErr = e;
      log(`  retry ${attempt}/${maxAttempts} (${e.message}) ${host}`);
      await sleep(1500 * attempt);
    }
  }
  throw lastErr;
}

// 複数ミラー対応版: 先頭(本命)ミラーから順に試し、どれかが200を返したら採用。
// 全滅した場合は最後に得られたレスポンス(あれば)かエラーを返す。
// 各ミラーは独立ホストなので scheduleUpstream のレート制限キューも別々になり、
// 一方のホストが混雑/拒否していてももう一方には影響しない。
async function fetchUpstreamMulti(upstreamUrls, opts) {
  let lastRes = null, lastErr = null;
  for (const url of upstreamUrls) {
    try {
      const res = await fetchUpstream(url, Object.assign({}, opts, { maxAttempts: 2 }));
      if (res.status === 200) return res;
      lastRes = res;
    } catch (e) {
      lastErr = e;
      log(`  mirror failed (${e.message}), trying next if available`);
    }
  }
  if (lastRes) return lastRes;
  throw lastErr || new Error('all overpass mirrors failed');
}

// POSTボディの読み取り(Overpassクエリ用。GET系API(elevation/nominatim)では未使用)
function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/* ---------- プロキシ本体 (キャッシュ + 同時リクエスト合流) ---------- */
const inflight = new Map();

async function handleApi(req, res, apiKey) {
  const api = APIS[apiKey];
  const rest = req.url.slice(apiKey.length); // 例: "/v1/srtm30m?locations=..." / GET系の "?data=..."
  // 【重要・2026-07-15】Overpassの6タイルまとめクエリはGETでURLに埋め込むと414
  // (Request-URI Too Long)を上流から返される規模になるため、クライアント側(part8.js)は
  // POST(ボディにdata=<クエリ>)へ切り替えた。ここではPOSTならボディを読み取り、
  // それをそのまま上流へもPOSTで転送する。キャッシュキーもURL(restは空になる)ではなく
  // ボディ内容ベースに切り替える必要がある。
  const reqBody = req.method === 'POST' ? await readRequestBody(req) : '';
  const upstreamUrl = api.upstream + rest;
  const cacheKeySource = reqBody ? (upstreamUrl + '|POST|' + reqBody) : upstreamUrl;
  const file = cachePath(api.dir, cacheKeySource);
  const upstreamOpts = reqBody
    ? { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: reqBody }
    : undefined;

  // 1) キャッシュヒット → 即応答
  try {
    const cached = JSON.parse(await fsp.readFile(file, 'utf8'));
    res.writeHead(200, { 'Content-Type': cached.contentType, 'X-Cache': 'HIT' });
    res.end(cached.body);
    log(`HIT  ${apiKey} ${(reqBody || rest).slice(0, 60)}...`);
    return;
  } catch (_) { /* miss */ }

  // 2) ミス → 上流 (同一キーの同時リクエストは1本に合流)
  let p = inflight.get(cacheKeySource);
  if (!p) {
    p = (async () => {
      const t0 = Date.now();
      const up = api.mirrors
        ? await fetchUpstreamMulti(api.mirrors.map((m) => m + rest), upstreamOpts)
        : await fetchUpstream(upstreamUrl, upstreamOpts);
      log(`MISS ${apiKey} -> upstream ${up.status} (${Date.now() - t0}ms)`);
      if (up.status === 200) {
        const bodyStr = up.body.toString('utf8');
        let parsed;
        try { parsed = JSON.parse(bodyStr); } catch (e) { throw new Error('upstream returned non-JSON'); }
        // 【重要・2026-07-16】Overpassはエラーもremarkも出さずに部分応答を200で返すことが
        // ある(無言の部分応答)。従来は200+有効JSONなら無条件で永久キャッシュしていたため、
        // 一度部分応答を掴むと以降の再試行が全てHITで同じ欠損データを返し続けていた
        // (「リロードしても二度と埋まらない空き地」の一因)。クライアント(part8.js)が
        // クエリに入れるout count;の宣言総数と実受信数を照合し、不完全な応答は
        // キャッシュせずそのまま返す(クライアント側の同じ検証が失敗→再試行し、
        // 次回はキャッシュ未汚染のまま上流に再問い合わせできる)。
        let cacheable = true;
        if (api.dir === 'overpass' && parsed && Array.isArray(parsed.elements)) {
          if (parsed.remark && /timed out|timeout|out of memory/i.test(parsed.remark)) cacheable = false;
          const countEl = parsed.elements.find((el) => el.type === 'count');
          if (countEl) {
            const declared = parseInt(countEl.tags && countEl.tags.total, 10);
            const received = parsed.elements.filter((el) => el.type !== 'count').length;
            if (!Number.isFinite(declared) || received < declared) cacheable = false;
          } else if (/out[+%20]{1,3}count/i.test(reqBody)) {
            cacheable = false; // count要素を要求したのに無い=出力先頭から切り捨てられている
          }
        }
        if (cacheable) {
          await fsp.mkdir(path.dirname(file), { recursive: true });
          const tmp = file + '.tmp';
          await fsp.writeFile(tmp, JSON.stringify({ url: upstreamUrl, cachedAt: new Date().toISOString(), contentType: up.contentType, body: bodyStr }));
          await fsp.rename(tmp, file);
        } else {
          log(`SKIP-CACHE ${apiKey} incomplete overpass response`);
        }
        return { status: 200, contentType: up.contentType, body: bodyStr };
      }
      return { status: up.status, contentType: up.contentType, body: up.body.toString('utf8') };
    })();
    inflight.set(cacheKeySource, p);
    const cleanup = () => inflight.delete(cacheKeySource);
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
    const injected = DEPLOY_INFO_SCRIPT + '\n' + INJECT;
    if (/<head[^>]*>/i.test(html)) html = html.replace(/<head[^>]*>/i, (m) => m + '\n' + injected);
    else html = injected + html;
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
  console.log('ChronoDrift server (proxy + cache)');
  console.log(`  game root : ${ROOT}`);
  console.log(`  cache dir : ${CACHE_DIR}`);
  console.log(`  listening : http://localhost:${PORT}/  (LAN: http://<このPCのIP>:${PORT}/)`);
});
