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
// 【2026-07-25・詰まり検出→強制打ち切り】レーンを弾力化(BASE_LANES→MAX_LANES)しても、
// 全レーンが同時に「遅いが最終的には応答する」リクエストで埋まってしまえば、レーン数が
// 増えただけで根本的には同じ「詰まり」が起きる(ユーザー指摘のとおり)。レーン数を
// 際限なく増やす代わりに、このホスト宛ての待ち件数(詰まりの兆候)が閾値を超えている間は
// 1回のリクエストの持ち時間そのものを短くし、強制的に見切りをつけてレーンを早く手放す。
// 平常時は従来どおり寛容な45秒(密集地の正常な低速応答を誤って打ち切らない)を維持し、
// 詰まっている時だけ短縮する。
const CONGESTION_BACKLOG = 6;      // このホスト宛ての待ち件数がこれを超えたら「詰まり」とみなす
// 【2026-07-25(2)・ユーザー相談】当初は一律20秒にしていたが、3タイルまとめクエリは正常時
// でも10〜30秒かかる実測があり、一律20秒だと詰まり中はまとめクエリのほとんどが正常応答でも
// 間に合わず失敗→即リトライになり、Overpassへのリクエスト数がかえって増えて詰まりを悪化
// させかねない(429ストームの自己増幅と同じ構図)。1タイル単体クエリ(正常時1〜2秒)と
// 3タイルまとめ(正常時10〜30秒)とでは許容できる打ち切りの短さが全く違うため、
// クエリが自己申告しているOverpass側timeout([timeout:N]、1タイル=20/26秒・3タイルまとめ=
// 30/38秒。buildOSMBatchQuery(part8.js)参照)を見て使い分ける。
const CONGESTED_TIMEOUT_MS_SOLO = 5000;   // 詰まり中・1タイル単体クエリの持ち時間
const CONGESTED_TIMEOUT_MS_BATCH = 20000; // 詰まり中・複数タイルまとめクエリの持ち時間(従来値のまま)
const SOLO_QUERY_TIMEOUT_SEC_MAX = 28; // これ以下ならクエリ自己申告timeoutから「1タイル単体」とみなす

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
// 【2026-07-19・実験→撤回】private.coffeeをメインにする実験を行ったが、実機のRenderログで
// private.coffee/kumi.systemsが「毎回」upstream timeout(45秒待ちを2回=最大90秒超)になり、
// overpass-api.deだけが(429/504はあるものの)唯一実際に200を返せていることが確認された
// (この間/api/overpassの応答が最大881秒=約15分にまで悪化)。「レート制限なし」という
// サードパーティの説明は少なくとも今この瞬間のRenderの環境からは成立しておらず、むしろ
// 常に失敗する2本を毎回律儀に試す分だけ確実に遅くなっていた。overpass-api.deを先頭へ戻す。
const OVERPASS_MIRRORS = [
  'https://overpass-api.de/api/interpreter',
  'https://overpass.kumi.systems/api/interpreter',
  'https://overpass.private.coffee/api/interpreter',
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
 * 【削除済み・CODE_REVIEW_20260717 P2】旧クライアントのレート制限待ち(1100/1500ms)を
 * キャッシュHIT時に短縮するwindow.setTimeoutパッチがあったが、対象のsetTimeoutは既に
 * 存在せず、part6.js側のPromise.race([updateAddressDisplay(), setTimeout 1500ms])に誤爆
 * していた(キャッシュHIT時に国コード取得の猶予が15msに切り詰められる副作用があった)。
 */
const INJECT = `<script>
(() => {
  const MAP = [
    ['https://api.opentopodata.org', '/api/elevation'],
    ['https://overpass-api.de/api/interpreter', '/api/overpass'],
    ['https://nominatim.openstreetmap.org/reverse', '/api/nominatim'],
  ];
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
  const OVERPASS_PREFIX = 'https://overpass-api.de/api/interpreter'; // part8.js側が呼ぶ元URL(書き換え対象の目印。ミラー順とは無関係)
  // 【2026-07-19・実験→撤回】private.coffeeを先頭にする実験はRenderの実機ログで
  // private.coffee/kumi.systemsが常時タイムアウトすることが確認されたため撤回。
  // overpass-api.deを先頭に戻す(server.js側のOVERPASS_MIRRORSと同じ理由)。
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
            let mirror = null;
            // 配列先頭(overpass-api.de)から順に健全なものを選ぶ。他ミラーはbackoff中の
            // フォールバック用(private.coffee/kumi.systemsは実測で常時タイムアウトしたため
            // 先頭には置かない。詳細は[[project_isehara_game_overpass_mirror_experiment]]参照)。
            for (let i = 0; i < OVERPASS_DIRECT_MIRRORS.length; i++) {
              const cand = OVERPASS_DIRECT_MIRRORS[i];
              if ((mirrorBackoffUntil[cand] || 0) < now) {
                mirror = cand;
                break;
              }
            }
            if (!mirror) {
              // 【2026-07-17・Fable5診断】以前は全滅時に無条件で本家固定へ戻していたため、
              // 直前に429/5xxを食らったばかりの相手へ延々投げ続け、429ストームを
              // 自ら悪化させていた(実機ログ: overpass-api.deへの429が連発)。
              // 3つのうち最もbackoffの明けが早いものを選ぶ(どのみち枠は埋まっているので
              // 「一番マシな相手」を選ぶだけ。実際の間隔調整はpart8側の再試行
              // バックオフに任せる方針自体は変えない)。
              mirror = OVERPASS_DIRECT_MIRRORS.reduce((best, cand) =>
                (mirrorBackoffUntil[cand] || 0) < (mirrorBackoffUntil[best] || 0) ? cand : best,
                OVERPASS_DIRECT_MIRRORS[0]);
            }
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
          if (res.status >= 500) { proxyDown[prefix] = Date.now(); return direct(); }
          proxyDown[prefix] = null; // プロキシ復帰確認
          return res;
        }, () => { proxyDown[prefix] = Date.now(); return direct(); });
      }
    }
    return origFetch(input, init);
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

/* ---------- ディスクキャッシュの有効期限・容量上限 ---------- */
// 【2026-07-26・IMPL_PROMPT_20260724 Phase4】
// 【実態確認・本書との差分】本書は「現状Overpass14日/標高30日のTTLがある」前提で
// 「延長する」よう指示していたが、実際のコード(下のhandleApi「1) キャッシュヒット」節)は
// キャッシュファイルの有効期限を一切見ておらず、書き込み時にcachedAtを記録してはいたものの
// 読み込み時に一度も参照していなかった(=ファイルが存在する限り無期限にHIT扱い)。
// Renderの無料プランはディスクがエフェメラル(再デプロイ・再起動のたびに消える)ため、
// 実質的には「今のデプロイが生きている間はキャッシュ無期限」という、本書が目指す状態を
// 既に上回る形で達成できていた。「延長する」対象の期限が実在しないため、代わりに
// 「非常に長時間デプロイし続けた場合に現実の地図変化に対してデータが古くなりすぎない」
// ための上限として、本書が挙げていた値をそのまま採用し明示的なチェックを新設する
// (無料プランの実情ではほぼ発火しない保険的な意味合いが強い)。
const CACHE_TTL_MS_BY_DIR = {
  overpass: 14 * 86400e3,   // 14日
  elevation: 30 * 86400e3,  // 30日(地形はほぼ不変)
  nominatim: 30 * 86400e3,  // 本書に記載無し。住所も変化が非常に稀なので同じ扱い
};
// 【実態確認】ディスク容量上限(LRU削除)も同様に現状は無い。本書は「永続ディスクの場合は
// 実装」という条件付きだったが、Renderがどこかのタイミングでプラン変更される可能性や
// ローカル開発での長時間起動も考慮し、低リスクな保険として常時有効にしておく
// (小さいJSON主体のキャッシュなので、通常の使用量ではまず発火しない)。
const CACHE_MAX_BYTES = 500 * 1024 * 1024; // 500MB
const CACHE_SWEEP_INTERVAL_MS = 30 * 60 * 1000; // 30分ごとにバックグラウンドで確認(リクエスト経路には絡めない)
async function sweepCacheDir() {
  try {
    let dirents;
    try { dirents = await fsp.readdir(CACHE_DIR, { withFileTypes: true }); } catch (e) { return; } // 未作成なら何もしない
    const files = [];
    for (const d of dirents) {
      if (!d.isDirectory()) continue;
      const sub = path.join(CACHE_DIR, d.name);
      let names;
      try { names = await fsp.readdir(sub); } catch (e) { continue; }
      for (const name of names) {
        if (!name.endsWith('.json')) continue; // 書き込み中の.tmpは対象外
        const fp = path.join(sub, name);
        try {
          const st = await fsp.stat(fp);
          files.push({ fp, size: st.size, mtime: st.mtimeMs });
        } catch (e) { /* 削除競合等は無視 */ }
      }
    }
    let total = files.reduce((s, f) => s + f.size, 0);
    if (total <= CACHE_MAX_BYTES) return;
    files.sort((a, b) => a.mtime - b.mtime); // 更新日時が古い順に削除(簡易LRU)
    let pruned = 0;
    for (const f of files) {
      if (total <= CACHE_MAX_BYTES) break;
      try { await fsp.unlink(f.fp); total -= f.size; pruned++; } catch (e) { /* 既に消えている等 */ }
    }
    log(`cache sweep: pruned ${pruned} files, now ~${Math.round(total / 1024 / 1024)}MB`);
  } catch (e) {
    log(`cache sweep failed: ${e.message}`);
  }
}
setInterval(sweepCacheDir, CACHE_SWEEP_INTERVAL_MS);
sweepCacheDir(); // 起動直後にも一度実行(前回デプロイの残骸が万一あっても早期に整理する)

/* ---------- 上流レート制限 (ホスト別・弾力レーン方式) ---------- */
// 【2026-07-25・ユーザー報告対応】以前はホスト単位で完全直列(1本のチェーン)だった。
// これだと、1件のリクエストが上流(Overpass)側で数分〜十数分かかるケース(下のコメント
// 参照: 実測881秒)に当たると、同じホストへの以降の全リクエスト(他タイル・他プレイヤー
// 全員分)がその1件の裏で完全に止まる。実機報告(近傍タイルの道路生成が5分以上
// fetchingのまま停滞し、しばらくすると溜まっていた分がいっぺんに解放される)は、
// この「1本の直列キューが1件の長時間リクエストに握られる」構造と一致する。
// 【2026-07-25(2)・ユーザー報告】固定2レーン化後も改善はしたが、Overpassが混雑している
// 時間帯は2レーンとも長時間(1試行あたり最大60秒×リトライ)埋まり、後ろで待つリクエストが
// 数分単位で足止めされる「詰まり」が引き続き確認された。ユーザー提案どおり、詰まり
// (=このホスト宛ての処理待ち件数が多い状態)を検出したら一時的にレーン数を増やして
// 強制的に処理を前へ進める弾力運用にする。平常時はBASE_LANES(2、従来どおりOverpassに
// 優しい)のまま、バックログが積んだ時だけMAX_LANESまで一時的に広げ、解消すれば
// 自然と使うレーン数も減る(レーン自体は使い回すため縮小処理は不要)。
const BASE_LANES = 2;
const MAX_LANES = 4; // Overpass1IPあたりの実測上限(2)にはやや踏み込むが、詰まり解消を優先
const BACKLOG_PER_EXTRA_LANE = 4; // このペースでバックログ(待ち件数)が積むごとにレーンを1本追加
const pendingByHost = new Map();   // host -> 現在scheduleUpstreamで処理待ち/処理中の件数(詰まり検出用)
const laneChains = new Map();      // host -> [Promise, ...](レーンごとの直列チェーン。必要に応じて伸びる)
const laneLastStartAt = new Map(); // host -> [ts, ...](レーンごとの最終開始時刻。ペース配分用)
// 【2026-07-27・IMPL_PROMPT_20260726 修正3】レーンごとの「未完了件数」(depth: 割り当て時+1、
// 完了[成功/失敗どちらでも]時-1)。starts(最終開始時刻)だけでは「まだ実行中だが開始が古い
// レーン」と「最近使い終わってすぐ空いたレーン」を区別できず、前者を「一番長く空いている」
// と誤認して選んでしまうバグがあった(下のscheduleUpstream参照)。depthはその区別を可能にする。
const laneDepth = new Map(); // host -> [depth, ...]
function ensureLanes(host, n) {
  let lanes = laneChains.get(host), starts = laneLastStartAt.get(host), depths = laneDepth.get(host);
  if (!lanes) { lanes = []; laneChains.set(host, lanes); }
  if (!starts) { starts = []; laneLastStartAt.set(host, starts); }
  if (!depths) { depths = []; laneDepth.set(host, depths); }
  while (lanes.length < n) { lanes.push(Promise.resolve()); starts.push(0); depths.push(0); } // 新設分は「即使える」扱い
  return { lanes, starts, depths };
}
// 【2026-07-26・IMPL_PROMPT_20260724 Phase3】弾力レーン(2〜4本)のうち0番を「現在地
// ブロッキング/近傍単体クエリ」優先の予約レーンにする。クライアント(part8.js)が
// POSTボディ末尾に付ける優先度ヒント(&priority=blocking|near|far、handleApi参照)を
// ここで見て、レーンを選ぶ範囲を変える。
// - blocking/near(=現在地タイル、または近傍分離ジョブ・近傍1枚クエリ)は0番を含む
//   全レーンから一番空いているものを選べる(0番が別のblocking/nearで埋まっていれば
//   汎用レーンにあふれてよい。「他のレーンは従来通り全ジョブを扱う」という指示通り)。
// - far(それ以外、複数タイルまとめクエリ含む)は0番を除いた1番以降からしか選べない。
//   これにより0番は重いまとめクエリに握られることが構造的に無くなり、外周で重い
//   クエリが走っている最中でも現在地タイルの取得が数秒以内に開始される。
// - BASE_LANES=2なのでnは常に2以上。レーン数が2本に縮退していても「0番=予約・
//   1番=汎用」の構図は保たれる。
function scheduleUpstream(host, task, priority) {
  const pending = (pendingByHost.get(host) || 0) + 1;
  pendingByHost.set(host, pending);
  // バックログが積んでいるほどレーンを増やす(詰まり検出→強制的に並列度を上げて進める)
  const n = Math.min(MAX_LANES, BASE_LANES + Math.floor(Math.max(0, pending - BASE_LANES) / BACKLOG_PER_EXTRA_LANE));
  const { lanes, starts, depths } = ensureLanes(host, n);
  const useReserved = priority === 'blocking' || priority === 'near';
  const startIdx = useReserved ? 0 : 1; // far優先度は0番(予約)を候補から外す
  // 【2026-07-27・IMPL_PROMPT_20260726 修正3(症状Bの有力因)】以前は「最終開始時刻が最古」
  // だけでレーンを選んでいたが、これは「まだ実行中だが開始が古いレーン」と「最近使い終わって
  // すぐ空いたレーン」を区別できない。45秒級のfarクエリを実行中のレーンは開始時刻が
  // 過去のまま更新されないため、「一番長く空いている」と誤認され続け、その裏でblocking/near
  // が次々とこの実行中レーンの後ろにチェーンされてしまっていた(予約レーン0がすぐ後に
  // 空いていても、開始時刻の新しさだけで「使用中」と判定されて避けられてしまうケースがあった)。
  // 未完了件数(depth)が最小のレーンを最優先で選び、同数の場合だけ従来通り開始時刻最古を
  // タイブレークに使う。depthが0のレーンは(チェーンの前段が確定済みなので)ほぼ即座に
  // 開始できる、という保証が得られる。
  let laneIdx = startIdx;
  for (let i = startIdx + 1; i < n; i++) {
    if (depths[i] < depths[laneIdx] || (depths[i] === depths[laneIdx] && starts[i] < starts[laneIdx])) laneIdx = i;
  }
  depths[laneIdx]++;
  const prev = lanes[laneIdx];
  const p = prev.then(async () => {
    const wait = starts[laneIdx] + MIN_INTERVAL_MS - Date.now();
    if (wait > 0) await sleep(wait);
    starts[laneIdx] = Date.now();
    return task();
  });
  // 【重要・2026-07-15】ここでlanesに繋ぐpがもし永遠に確定(resolve/reject)しなければ、
  // 同じレーンへの以降のリクエストがこのpromiseの後ろに並んだまま永久に開始すらされなく
  // なる(1件のハングでそのレーンが詰まる。他のレーンは生きているので全滅はしない)。
  // 「道路・建物の生成が途中で止まる」がサーバー再起動(=デプロイのたび)まで直らず
  // 再発していたのは、httpsGetOnce側に必ず確定させる保証が無かったことが一因と推測される
  // (下記httpsGetOnceのハードタイムアウト参照)。
  lanes[laneIdx] = p.then(() => {}, () => {}); // 失敗してもレーンは継続
  const releaseDepth = () => { depths[laneIdx] = Math.max(0, depths[laneIdx] - 1); };
  p.then(releaseDepth, releaseDepth);
  const releasePending = () => {
    const c = (pendingByHost.get(host) || 1) - 1;
    if (c <= 0) pendingByHost.delete(host); else pendingByHost.set(host, c);
  };
  p.then(releasePending, releasePending);
  return p;
}

/* ---------- 上流リクエスト (標準 https、GET/POST両対応、リトライ付き) ---------- */
// 【重要・2026-07-15】以前はhttps.getのみでGET専用だった。Overpassの6タイルまとめクエリは
// URLに埋め込む(GET)と数千文字になり、overpass-api.deから414 (Request-URI Too Long)を
// 返される事象を確認(道路の拡張生成が完全に止まって見えた真因。詳細はpart8.js側コメント参照)。
// POST(ボディにdata=<クエリ>)はURL長に依存しないため、GET/POST両対応に拡張する。
function httpsRequestOnce(urlStr, opts) {
  opts = opts || {};
  // 【2026-07-25・詰まり検出→強制打ち切り対応】通常は45秒(UPSTREAM_TIMEOUT_MS)だが、
  // 呼び出し側(fetchUpstream)がバックログ検出時に短いopts.timeoutMsを渡してきた場合は
  // それを使う。1回のリクエストがレーンを握る最長時間を短縮し、詰まっている時ほど
  // 早く手放させる狙い(詳細はfetchUpstream側コメント参照)。
  const timeoutMs = opts.timeoutMs || UPSTREAM_TIMEOUT_MS;
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
      settle(reject, new Error('upstream hard timeout (' + (timeoutMs + 15000) + 'ms)'));
    }, timeoutMs + 15000);
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
    req.setTimeout(timeoutMs, () => req.destroy(new Error('upstream timeout')));
    req.on('error', (e) => settle(reject, e));
    if (opts.body) req.write(opts.body);
    req.end();
  });
}

// 【2026-07-16】ホスト単位のクールダウン。429/5xx/接続エラーを返したホストは一定時間
// 「不調」として記録し、fetchUpstreamMultiが即スキップして次のミラーへ行けるようにする。
// 以前は毎リクエスト必ず本家(overpass-api.de)から2回試行+バックオフ(計5秒前後)を
// 浪費してからミラーに進む構造で、本家がRenderの共有IPを拒否している間は全リクエストが
// 一律に遅延→クライアント側がプロキシ不調と判断して直接モードへ逃げていた(実機502)。
const hostCooldownUntil = new Map(); // host -> このtimestampまでスキップ
const HOST_COOLDOWN_MS = 45000;
function markHostCooldown(host) { hostCooldownUntil.set(host, Date.now() + HOST_COOLDOWN_MS); }

// 【2026-07-21・マップジャンプ後の詰まり対策】scheduleUpstreamはホストごとに完全直列
// (次のリクエストは前の完了を待ってから開始)なので、密集地(東京等)で長時間過ごして
// 大量のOverpassリクエストがこのキューに積み上がった状態でマップジャンプ(location.reload)
// すると、クライアント側は即座に真っさらな状態から再スタートするが、サーバ側のキューは
// 別プロセス(全プレイヤー共有)なので何も知らず、ジャンプ前の(既にブラウザが切断した)
// リクエストを律儀に1件ずつ最後まで処理(リトライ・タイムアウト込みで数十秒/件)してから
// でないと新しい地域(千葉等)のリクエストに進めない。「高品質モードで東京にいた後
// 千葉へジャンプしたら道路だけ長時間赤のまま」という実機報告と一致する。
// 対策: 各リクエストに紐づくres/reqの接続が切れた(=クライアントがreloadした等で
// もう誰も結果を待っていない)ことを検知したら、そのリクエストの番が回ってきた時点で
// 実際のOverpass呼び出し(1.1秒間隔の直列キューの1枠)をスキップし、即座に次へ進める。
async function fetchUpstream(upstreamUrl, opts) {
  opts = opts || {};
  const maxAttempts = opts.maxAttempts || MAX_ATTEMPTS;
  const host = new URL(upstreamUrl).host;
  let lastErr = null;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    if (opts.isAbandoned && opts.isAbandoned()) throw new Error('abandoned (no waiters left)');
    try {
      const res = await scheduleUpstream(host, () => {
        // キューで待っている間に依頼主が全員いなくなっていたら、上流への実リクエストは
        // 発行せず即座に諦める(直列キューの1枠・レート制限の待ち時間を浪費しない)。
        if (opts.isAbandoned && opts.isAbandoned()) return Promise.reject(new Error('abandoned (no waiters left)'));
        // 【2026-07-25】このタスクの実際の実行タイミング(レーンの順番が回ってきた瞬間)で
        // 詰まり具合を判定する。呼び出し時点ではなくここで見ることで、キューで待っている
        // 間に詰まりが解消していれば通常の45秒のまま、まだ詰まっていれば短縮版を使う。
        // 【2026-07-25(2)】短縮の度合いはisSoloTile(1タイル単体かどうか)で使い分ける。
        // 1タイル単体は正常時1〜2秒で返るので5秒まで攻めても実害が少ないが、3タイル
        // まとめは正常時でも10〜30秒かかるため、20秒(従来値)より短くすると正常応答まで
        // 打ち切ってリトライを増やし、かえって詰まりを悪化させる。
        const congested = (pendingByHost.get(host) || 0) > CONGESTION_BACKLOG;
        const timeoutMs = !congested ? UPSTREAM_TIMEOUT_MS
          : (opts.isSoloTile ? CONGESTED_TIMEOUT_MS_SOLO : CONGESTED_TIMEOUT_MS_BATCH);
        return httpsRequestOnce(upstreamUrl, Object.assign({}, opts, { timeoutMs }));
      }, opts.priority); // 【Phase3】blocking/near優先度ヒントをレーン選択まで運ぶ
      if (res.status === 200) return res;
      lastErr = new Error('upstream HTTP ' + res.status);
      if (res.status === 429 || res.status >= 500) {
        markHostCooldown(host);
        log(`  retry ${attempt}/${maxAttempts} (HTTP ${res.status}) ${host}`);
        await sleep(1500 * attempt);
        continue;
      }
      return res; // 4xx 等はそのまま返す
    } catch (e) {
      lastErr = e;
      if (/abandoned/.test(e.message)) throw e; // 諦めた場合はリトライせず即座に抜ける
      markHostCooldown(host);
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
// 【2026-07-19】以前は全ミラーとも一律maxAttempts:2で試していたが、実機ログで
// kumi.systems/private.coffeeが「毎回」タイムアウト(45秒×2回=90秒超/ミラー)することが
// 判明し、本命(先頭)に辿り着く前にリクエスト全体が数分〜十数分単位で遅延する原因になって
// いた。2番目以降(フォールバック)のミラーは1回だけ試して見切りをつけ、生きている
// 可能性が高い先頭ミラーへ早く戻れるようにする。
async function fetchUpstreamMulti(upstreamUrls, opts) {
  let lastRes = null, lastErr = null;
  // クールダウン中のホストを外し、健全なミラーから先に試す(全滅時は従来どおり全部試す)
  const _now = Date.now();
  const healthy = upstreamUrls.filter((u) => (hostCooldownUntil.get(new URL(u).host) || 0) < _now);
  if (healthy.length) upstreamUrls = healthy;
  for (let idx = 0; idx < upstreamUrls.length; idx++) {
    if (opts && opts.isAbandoned && opts.isAbandoned()) throw new Error('abandoned (no waiters left)');
    const url = upstreamUrls[idx];
    try {
      const res = await fetchUpstream(url, Object.assign({}, opts, { maxAttempts: idx === 0 ? 2 : 1 }));
      if (res.status === 200) return res;
      lastRes = res;
    } catch (e) {
      lastErr = e;
      // 依頼主が全員いなくなった場合は他のミラーを試さず即座に諦める(無駄な待ちを増やさない)
      if (/abandoned/.test(e.message)) throw e;
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
// 【2026-07-21・マップジャンプ後の詰まり対策】cacheKeySourceごとに「まだ結果を待っている
// クライアント接続の数」を数える。同じキーへ複数プレイヤーが同時にアクセスしている間は
// 1以上を維持し(inflightのdedup合流と同じ単位)、全員が切断(reload等)したら0に戻る。
// fetchUpstream/fetchUpstreamMultiはこれを見て、自分の番が回ってきた時点で誰も待っていな
// ければ上流呼び出し自体を省略する(scheduleUpstreamの直列キューを無駄に占有しない)。
const inflightWaiters = new Map();

async function handleApi(req, res, apiKey) {
  const api = APIS[apiKey];
  const rest = req.url.slice(apiKey.length); // 例: "/v1/srtm30m?locations=..." / GET系の "?data=..."
  // 【重要・2026-07-15】Overpassの6タイルまとめクエリはGETでURLに埋め込むと414
  // (Request-URI Too Long)を上流から返される規模になるため、クライアント側(part8.js)は
  // POST(ボディにdata=<クエリ>)へ切り替えた。ここではPOSTならボディを読み取り、
  // それをそのまま上流へもPOSTで転送する。キャッシュキーもURL(restは空になる)ではなく
  // ボディ内容ベースに切り替える必要がある。
  const rawBody = req.method === 'POST' ? await readRequestBody(req) : '';
  // 【2026-07-26・IMPL_PROMPT_20260724 Phase3】クライアント(part8.js)が付ける優先度ヒント。
  // blocking(現在地タイル)/near(近傍分離ジョブ・近傍単体クエリ)/far(それ以外)の3値。
  // カスタムヘッダ(X-Tile-Priority等)ではなくPOSTボディ末尾の"&priority=..."として送る
  // (カスタムヘッダを付けると、直接モード[プロキシ不健全時、ブラウザ→overpass-api.deへの
  // 本物のクロスオリジンリクエスト]でCORSプリフライトが発生し、Overpassが応答しなければ
  // リクエストごと失敗しかねない。ボディに追加フィールドを足すだけなら「シンプル
  // リクエスト」のままなのでCORS問題を起こさない)。上流(Overpass本体)・キャッシュキー
  // ともにこのフィールドを一切知らなくてよいので、ここで検出・除去してから使う。
  const _pMatch = rawBody.match(/&priority=(blocking|near|far)$/);
  const priority = _pMatch ? _pMatch[1] : 'far'; // 想定外(ヘッダ無し・古いクライアント等)は安全側でfar
  const reqBody = _pMatch ? rawBody.slice(0, _pMatch.index) : rawBody;
  const upstreamUrl = api.upstream + rest;
  const cacheKeySource = reqBody ? (upstreamUrl + '|POST|' + reqBody) : upstreamUrl;
  const file = cachePath(api.dir, cacheKeySource);
  const isAbandoned = () => (inflightWaiters.get(cacheKeySource) || 0) <= 0;
  // 【2026-07-25(2)】クエリ本文が自己申告しているOverpass側timeout([timeout:N])を見て、
  // 1タイル単体クエリか複数タイルまとめクエリかを判定する(詰まり時のタイムアウト長さの
  // 使い分けに使う。詳細はCONGESTED_TIMEOUT_MS_SOLO/BATCH宣言部のコメント参照)。
  let isSoloTile = false;
  if (reqBody) {
    try {
      const m = decodeURIComponent(reqBody).match(/\[timeout:(\d+)\]/);
      if (m) isSoloTile = parseInt(m[1], 10) <= SOLO_QUERY_TIMEOUT_SEC_MAX;
    } catch (e) { /* デコード失敗時はbatch扱いのまま(安全側) */ }
  }
  const upstreamOpts = Object.assign(
    reqBody
      ? { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: reqBody }
      : {},
    { isAbandoned, isSoloTile, priority }
  );

  // 1) キャッシュヒット → 即応答
  // 【2026-07-26・Phase4】期限切れなら例外を投げてmiss扱いに落とす(下の(2)で上書き取得)。
  try {
    const cached = JSON.parse(await fsp.readFile(file, 'utf8'));
    const ttlMs = CACHE_TTL_MS_BY_DIR[api.dir];
    const cachedAtMs = Date.parse(cached.cachedAt);
    if (ttlMs && Number.isFinite(cachedAtMs) && (Date.now() - cachedAtMs) > ttlMs) {
      throw new Error('cache expired');
    }
    res.writeHead(200, { 'Content-Type': cached.contentType, 'X-Cache': 'HIT' });
    res.end(cached.body);
    log(`HIT  ${apiKey} ${(reqBody || rest).slice(0, 60)}...`);
    return;
  } catch (_) { /* miss (期限切れ含む) */ }

  // このリクエストを「待ち人数」として登録する(同一キーへの合流分もそれぞれ+1する)。
  // reqの接続が切れたら(ブラウザのreload・タブ閉じ等)必ず1つ減らす。
  inflightWaiters.set(cacheKeySource, (inflightWaiters.get(cacheKeySource) || 0) + 1);
  let _waiterRemoved = false;
  const removeWaiter = () => {
    if (_waiterRemoved) return;
    _waiterRemoved = true;
    const n = (inflightWaiters.get(cacheKeySource) || 1) - 1;
    if (n <= 0) inflightWaiters.delete(cacheKeySource); else inflightWaiters.set(cacheKeySource, n);
  };
  req.on('close', removeWaiter);

  // 2) ミス → 上流 (同一キーの同時リクエストは1本に合流)
  let p = inflight.get(cacheKeySource);
  if (!p) {
    p = (async () => {
      const t0 = Date.now();
      const up = api.mirrors
        ? await fetchUpstreamMulti(api.mirrors.map((m) => m + rest), upstreamOpts) // 先頭(private.coffee)優先
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

  // 【2026-07-20】js/legacy/*.js等の静的ファイルにCache-Controlが一切付いておらず、
  // ブラウザのヒューリスティックキャッシュに任せきりだった。頻繁に修正・デプロイする
  // 開発中のゲームでこれをやると、サーバー側は最新でもプレイヤーのブラウザが古いJSを
  // キャッシュしたまま「直したはずのバグが直っていない」という報告が起き得る
  // (index.htmlだけ既にno-cacheだったが、実体のロジックはjs/legacy側にあるため無意味だった)。
  // index.htmlと同じくno-cacheにして、更新のたびブラウザに確実に反映させる。
  res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'no-cache' });
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
