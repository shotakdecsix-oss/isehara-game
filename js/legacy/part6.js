/**
 * legacy/part6.js — index.html の巨大インラインスクリプトを行範囲のまま機械的に切り出した
 * ファイル(6/9)。part5.js の続き。詳細は part1.js 冒頭のコメント参照。
 */
// ======= 遠景の実地形(北西=大山の山塊 / 南=相模湾へ下る海岸) =======
// 詳細標高グリッド(±約2.2km、約170m間隔)の外側に、実標高グリッドを背景として敷く。
// これで遠景メッシュ(farMesh、半径6km=直径12km相当を描画)が縁の高さでクランプされて
// 平坦になるのを解消し、北西に大山が立ち上がり、南は海面へ下る本物の地形が地平に現れる。
//
// 「伊勢原と同じ解像度を全域で」に一段階のグリッドで対応しようとすると、広い範囲を
// 高解像度で覆うために一度に大量の点(50バッチ超)を取りに行くことになり、公開APIや
// プロキシが詰まって「格子状フォールバックに落ちる」「取り直しに5分かかる」不具合が
// 起きていた。そこで2段階構成にする:
//   ① FAR  = 広い範囲(±14km)を低解像度で覆う。地平線に見える山並み・海岸線の概形用。
//            取得点数が少ない(約9バッチ)ので初回・再取得とも短時間で確実に終わる。
//   ② NEAR = プレイヤーの周囲(±4km)を比較的高い解像度(約300〜400m間隔)で覆う。
//            範囲が狭いので取得点数も少なく、頻繁に取り直しても軽い。
// 実際の高さ問い合わせ(getWideTerrainY)は、まずNEARの範囲内ならNEARを、範囲外ならFARを返す。
//
// 【opentopodata公開APIの実際の上限(公式ポリシーで確認済み)】
//   1リクエスト/秒・1リクエスト最大100地点、かつ「1日あたり最大1000コール」というハード上限がある。
//   NEARを伊勢原本体と同じ約170m間隔・±2kmのままだと、ダッシュ(45m/s)で動き続けた場合
//   1時間で900コール超に達し、1日の上限をわずか1時間程度で使い切ってしまう計算になった。
//   上限に達すると以降その日は標高取得が失敗し続け、地形が更新されなくなる(=読み込みが
//   進まないまま止まる)ため、これが「読み込みが遅い/終わらない」の一因になっていた可能性が高い。
//   → NEARの範囲を広げ(±2km→±4km)て取り直しの頻度そのものを下げ、かつ解像度を少し
//   落とす(約170m→約300〜400m)ことで、1回の取り直しあたりのバッチ数と発生頻度の両方を
//   減らした。体感の「待ち時間」は「取り直し頻度 × 1回あたりの待ち時間」で決まるため、
//   頻度を下げるほうが解像度をわずかに落とすより効果が大きい。
const WIDE_HALF_LAT = 0.13, WIDE_HALF_LON = 0.13;   // FAR: ≈ ±14km(低解像度)
const WIDE_SEGS = 28, WIDE_SEGS1 = WIDE_SEGS + 1;   // FAR: 約1km間隔、約9バッチ
const WIDE_W = 2 * WIDE_HALF_LON * SCALE * COS_LAT;
const WIDE_D = 2 * WIDE_HALF_LAT * SCALE;
// 遠景標高グリッドの中心(ワールド座標)。プレイヤーが遠くへ移動/ジャンプしたら中心を移して取り直す。
// これで富士山など伊勢原から離れた場所でも実際の地形・標高が出る。
let wideCX = 0, wideCZ = 0, wideLoading = false;

const NEAR_HALF_LAT = 0.036, NEAR_HALF_LON = 0.036; // NEAR: ≈ ±4km(高解像度・プレイヤー追従)
const NEAR_SEGS = 20, NEAR_SEGS1 = NEAR_SEGS + 1;   // NEAR: 約300〜400m間隔、約5バッチ
const NEAR_W = 2 * NEAR_HALF_LON * SCALE * COS_LAT;
const NEAR_D = 2 * NEAR_HALF_LAT * SCALE;
let nearElev = null, nearCX = 0, nearCZ = 0, nearLoading = false;

let seaLevelM = 5;            // 海面の実標高(m)。スライダーで変更可(elevBase確定時に初期値を上書き)
// wideElev は上方(遠景地形メッシュ定義の前)で宣言済み。flat [iz*WIDE_SEGS1+ix] = ゲーム高さ(実標高で固定)
let SEA_Y = 0;                // 海面(seaLevelM)のゲーム高さ。SEA_Y = (seaLevelM - elevBase) * ELEV_SCALE

// 汎用のバイリニア補間。inRangeOnly=true のときは範囲外で null を返す(NEARの範囲外判定に使う)。
function sampleGrid(elev, cx, cz, w, d, segs, segs1, x, z, inRangeOnly) {
  if (!elev) return null;
  const nx = (x - cx + w / 2) / w * segs;
  const nz = (z - cz + d / 2) / d * segs;
  if (inRangeOnly && (nx < 0 || nx > segs || nz < 0 || nz > segs)) return null;
  const ix = Math.max(0, Math.min(segs - 1, Math.floor(nx)));
  const iz = Math.max(0, Math.min(segs - 1, Math.floor(nz)));
  const fx = Math.max(0, Math.min(1, nx - ix));
  const fz = Math.max(0, Math.min(1, nz - iz));
  const h00 = elev[ iz    * segs1 + ix    ];
  const h10 = elev[ iz    * segs1 + ix + 1];
  const h01 = elev[(iz+1) * segs1 + ix    ];
  const h11 = elev[(iz+1) * segs1 + ix + 1];
  return h00*(1-fx)*(1-fz) + h10*fx*(1-fz) + h01*(1-fx)*fz + h11*fx*fz;
}

function getWideTerrainY(x, z) {
  // まずプレイヤー追従の高解像度NEARグリッドの範囲内かを見る(範囲外ならnull)
  const near = sampleGrid(nearElev, nearCX, nearCZ, NEAR_W, NEAR_D, NEAR_SEGS, NEAR_SEGS1, x, z, true);
  if (near !== null) return near;
  // 範囲外、またはNEAR未取得なら低解像度のFARグリッドへフォールバック
  return sampleGrid(wideElev, wideCX, wideCZ, WIDE_W, WIDE_D, WIDE_SEGS, WIDE_SEGS1, x, z, false) || 0;
}

async function loadWideTerrain(centerX = 0, centerZ = 0) {
  if (wideLoading) return;
  wideLoading = true;
  const reCenter = (wideElev !== null); // 2回目以降(=別地域へ移動しての取り直し)
  if (reCenter) showToast('🏔 この地域の地形を取得中...', { sticky: true });
  const pts = [];
  for (let iz = 0; iz < WIDE_SEGS1; iz++)
    for (let ix = 0; ix < WIDE_SEGS1; ix++) {
      const wx = centerX - WIDE_W/2 + ix * WIDE_W / WIDE_SEGS;
      const wz = centerZ - WIDE_D/2 + iz * WIDE_D / WIDE_SEGS;
      pts.push(xzToLatLon(wx, wz));
    }
  const raw = new Array(pts.length).fill(null);
  // 【重要】以前はここだけopentopodata(1req/秒・1日1000コール上限の共有プロキシ)に
  // 直行しており、loadElevations/loadNearTerrainと違ってGSIタイル(レート制限なし)を
  // 使っていなかった。上限に達したりプロキシが詰まると遠景(FAR)の実地形が更新されなく
  // なり、「地形読み込みが止まる」「標高2倍の効果が(遠くの山や海岸で)見えない」の
  // 原因になっていた。まず国土地理院タイルを試し、国外の点等で使えない時だけ
  // opentopodataへフォールバックする(loadElevations/loadNearTerrainと同じ方針に統一)。
  const gsi = await fetchElevationsGSI(pts);
  if (gsi) {
    for (let i = 0; i < raw.length; i++) raw[i] = gsi[i];
  } else try {
    // loadElevations と同じ理由で少数の同時実行数に絞ってバッチ発行する
    // (解像度アップでバッチ数が最大54件まで増えたため、無制限並列だと確実に詰まる)
    const batches = [];
    for (let i = 0; i < pts.length; i += 100) batches.push(pts.slice(i, i + 100));
    const results = await runLimited(batches, batch => {
      const loc = batch.map(ll => `${ll.lat.toFixed(6)},${ll.lon.toFixed(6)}`).join('|');
      return fetch(`https://api.opentopodata.org/v1/srtm30m?locations=${encodeURIComponent(loc)}`).then(r => r.json());
    });
    for (let bi = 0; bi < results.length; bi++) {
      const j = results[bi];
      if (!j || !j.results) { wideLoading = false; onWideTerrainFail(); return; } // 失敗時は現状維持(安全なフォールバック)
      j.results.forEach((r, k) => { raw[bi*100 + k] = r.elevation; });
    }
  } catch (e) { wideLoading = false; onWideTerrainFail(); return; }
  const arr = new Float32Array(pts.length);
  const oceanFloor = (0 - elevBase) * ELEV_SCALE - 10; // データ無しノードは海底(海面より十分下)扱い
  for (let i = 0; i < raw.length; i++) {
    const m = raw[i];
    arr[i] = (m == null) ? oceanFloor : (m - elevBase) * ELEV_SCALE; // 実標高で固定(海面とは無関係)
  }
  wideElev = arr; wideCX = centerX; wideCZ = centerZ; // データと中心を同時に更新
  wideLoading = false;
  _wideFailCount = 0; // 成功したのでリセット
  updateFarMesh(true); // 遠景メッシュを新しい実地形で再構築
  if (reCenter) showToast('🏔 地形反映完了', { duration: 2500 });
}

// 遠景(FAR)取得に失敗するたびに呼ぶ。checkNearTerrainのonNearTerrainFailと同じ考え方で、
// 失敗するたび再試行の間隔を伸ばす(上流を叩き続けない)。5回目以降は10秒間隔で回復を待つ。
let _wideFailCount = 0;
function onWideTerrainFail() {
  _wideFailCount++;
  if (_wideFailCount === 3) { // 数回続けて失敗した時だけ知らせる(単発の通信エラーではうるさくしない)
    console.warn('[遠景地形] 取得に失敗しています(' + _wideFailCount + '回目)。取得できるまで自動で再試行します。');
    showToast('⚠️ 遠景の地形取得に失敗しています(自動で再試行中)', { duration: 3000 });
  }
}

// プレイヤーが遠景(FAR)グリッドの中心から離れすぎたら、その場所を中心に取り直す
// (富士山などへ飛んでも地形が出る)。FARは範囲が広いので頻度は控えめでよい。
// 【重要】以前は wideElev が未取得(=初回ロードが1度でも失敗した)場合、この関数が
// 即return するだけで再試行のきっかけが一切無く、そのセッションではFAR(遠景)の
// 実地形が永久に取得されないまま止まっていた(「地形読み込みが止まる」「標高2倍の
// 効果が遠景で見えない」の主因と考えられる)。checkNearTerrainと同じく「未取得なら
// それ自体を取得トリガーにする」形にし、失敗しても一定間隔で自動的に再試行し続ける。
let _wideCheckFrame = 0;
function checkWideTerrain() {
  if (wideLoading) return;
  const interval = 120 * Math.min(5, 1 + _wideFailCount); // 失敗するたび間隔を伸ばす(最大10秒)
  if ((++_wideCheckFrame) % interval !== 0) return;
  if (!wideElev ||
      Math.abs(player.position.x - wideCX) > WIDE_W * 0.32 ||
      Math.abs(player.position.z - wideCZ) > WIDE_D * 0.32) {
    loadWideTerrain(player.position.x, player.position.z);
  }
}

// NEAR取得に失敗するたびに呼ぶ。既定回数(5回)を超えたら「NEARは使えない」扱いにして、
// 建物生成がAPI障害で永久にブロックされないようにする(chunkNearTerrainReadyが参照)。
function onNearTerrainFail() {
  _nearFailCount++;
  if (_nearFailCount >= 5) _nearGiveUp = true;
}

// NEAR(プレイヤー追従の高解像度グリッド)の取得。範囲が狭く点数も少ないので、
// FARと同じロジックだが速く終わる(約7バッチ)。
async function loadNearTerrain(centerX = 0, centerZ = 0) {
  if (nearLoading) return;
  nearLoading = true;
  const pts = [];
  for (let iz = 0; iz < NEAR_SEGS1; iz++)
    for (let ix = 0; ix < NEAR_SEGS1; ix++) {
      const wx = centerX - NEAR_W/2 + ix * NEAR_W / NEAR_SEGS;
      const wz = centerZ - NEAR_D/2 + iz * NEAR_D / NEAR_SEGS;
      pts.push(xzToLatLon(wx, wz));
    }
  const raw = new Array(pts.length).fill(null);
  // まず国土地理院タイル(並列・数秒)。NEARは建物生成のゲートなので、ここが速いほど
  // 道路・建物の読み込み体感が改善する。国外・失敗時のみopentopodataへ。
  const gsi = await fetchElevationsGSI(pts);
  if (gsi) {
    for (let i = 0; i < raw.length; i++) raw[i] = gsi[i]; // null(海上)は下でoceanFloor扱い
  } else try {
    const batches = [];
    for (let i = 0; i < pts.length; i += 100) batches.push(pts.slice(i, i + 100));
    const results = await runLimited(batches, batch => {
      const loc = batch.map(ll => `${ll.lat.toFixed(6)},${ll.lon.toFixed(6)}`).join('|');
      return fetch(`https://api.opentopodata.org/v1/srtm30m?locations=${encodeURIComponent(loc)}`).then(r => r.json());
    });
    for (let bi = 0; bi < results.length; bi++) {
      const j = results[bi];
      if (!j || !j.results) { nearLoading = false; onNearTerrainFail(); return; } // 失敗時は現状維持(古いNEAR/FARへ自動フォールバック)
      j.results.forEach((r, k) => { raw[bi*100 + k] = r.elevation; });
    }
  } catch (e) { nearLoading = false; onNearTerrainFail(); return; }
  const arr = new Float32Array(pts.length);
  const oceanFloor = (0 - elevBase) * ELEV_SCALE - 10;
  for (let i = 0; i < raw.length; i++) {
    const m = raw[i];
    arr[i] = (m == null) ? oceanFloor : (m - elevBase) * ELEV_SCALE;
  }
  nearElev = arr; nearCX = centerX; nearCZ = centerZ;
  nearLoading = false;
  _nearFailCount = 0; _nearGiveUp = false; // 成功したのでリセット
  updateFarMesh(true);
  // NEARグリッドが更新された(=この範囲の地形高さが変わった可能性がある)ので、
  // 範囲にかかる道路・川/公園/田畑ポリゴンをすぐに新しい地形へ合わせ直す(浮き/埋まりを即座に解消する)
  rebuildRoadsInBounds(centerX - NEAR_W/2, centerX + NEAR_W/2, centerZ - NEAR_D/2, centerZ + NEAR_D/2);
  rebuildAreaPolysInBounds(centerX - NEAR_W/2, centerX + NEAR_W/2, centerZ - NEAR_D/2, centerZ + NEAR_D/2);
  // 【重要】以前は建物だけここで追従させておらず、道路はNEAR更新のたびに正確な高さへ
  // 追従するのに建物は生成時の高さで固定されたままだったため、進むほど道路と建物の
  // 高さのズレが蓄積して浮く/埋まるが悪化していた。同じ範囲で建物もY方向に追従させる。
  rebuildBuildingsInBounds(centerX - NEAR_W/2, centerX + NEAR_W/2, centerZ - NEAR_D/2, centerZ + NEAR_D/2);
  // 駅舎も道路・建物と同じタイミングでY方向に追従させる(浮き対策)
  rebuildStationsInBounds(centerX - NEAR_W/2, centerX + NEAR_W/2, centerZ - NEAR_D/2, centerZ + NEAR_D/2);
}

// プレイヤーがNEARグリッドの中心から離れたら取り直す。範囲を広げた(±4km)ぶん、
// 閾値も0.3→0.4に上げて取り直し頻度自体を下げた(opentopodataの1日1000コール上限対策。
// 上のNEAR定数のコメント参照)。それでも端に近づく前に十分な余裕を残して取り直す。
let _nearCheckFrame = 0, _nearFailCount = 0, _nearGiveUp = false;
function checkNearTerrain() {
  if (nearLoading) return;
  const interval = 30 * Math.min(20, 1 + _nearFailCount); // 失敗するたび間隔を伸ばす(最大10秒)
  if ((++_nearCheckFrame) % interval !== 0) return;
  if (!nearElev ||
      Math.abs(player.position.x - nearCX) > NEAR_W * 0.4 ||
      Math.abs(player.position.z - nearCZ) > NEAR_D * 0.4) {
    loadNearTerrain(player.position.x, player.position.z);
  }
}

// 海面標高の変更は「水面プレーンの上下」だけにする。地形・道路・建物は一切動かさない。
// (以前は海面に応じて遠景地形の高さも作り替えていたため、水が来ていない陸の道路までズレて消えていた)
function setSeaLevel() {
  SEA_Y = (seaLevelM - elevBase) * ELEV_SCALE;
  if (seaMesh) seaMesh.position.y = SEA_Y;
}

// 海面(実標高0m)の巨大プレーン。カメラ追従・霧免除で、南の地平の先に海が見える。
// 陸(地形メッシュ)は不透明でdepthが先に書かれるので、標高が海面より高い場所では自然に隠れる。
let seaMesh = null;
const waterOverlay = document.getElementById('waterOverlay');
let _wasSubmerged = false;
function initDistantSea() {
  if (seaMesh) return;
  // 海面標高の初期値: 保存値があれば優先。無ければ「詳細エリアの最低標高より少し下」に置く
  // (= 海岸が街の近くまで来て、かつ街は水没しない安全な既定値)
  let saved = NaN;
  try { saved = parseFloat(localStorage.getItem('iseharaSeaLevel')); } catch (e) {}
  seaLevelM = Number.isFinite(saved) ? saved : 3;
  seaLevelM = Math.max(-10, Math.min(10, seaLevelM)); // -10〜10m
  SEA_Y = (seaLevelM - elevBase) * ELEV_SCALE;
  const c = document.createElement('canvas'); c.width = 128; c.height = 128;
  const g = c.getContext('2d');
  const base = MODE === 'space' ? '#0a2440' : MODE === 'edo' ? '#2f5a6a'
             : MODE === 'marchen' ? '#3fc8ff' : MODE === 'meiji' ? '#345f7a' : '#1f6ea8';
  const hi = MODE === 'space' ? '#1e4a7a' : MODE === 'marchen' ? '#8fe6ff' : '#5aa8d8';
  g.fillStyle = base; g.fillRect(0, 0, 128, 128);
  g.strokeStyle = hi; g.globalAlpha = 0.5; g.lineWidth = 2;
  for (let i = 0; i < 11; i++) {
    const y = i * 12 + (i % 2 ? 3 : 0);
    g.beginPath(); g.moveTo(0, y);
    for (let x = 0; x <= 128; x += 16) g.lineTo(x, y + Math.sin(x * 0.15 + i) * 3);
    g.stroke();
  }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(260, 260);
  const geo = new THREE.PlaneGeometry(60000, 60000);
  const mat = new THREE.MeshBasicMaterial({ map: tex, fog: false });
  seaMesh = new THREE.Mesh(geo, mat);
  seaMesh.rotation.x = -Math.PI / 2;
  seaMesh.position.y = SEA_Y;
  seaMesh.frustumCulled = false;
  seaMesh.renderOrder = -1; // 空(-2)の後・地形の前。depthTestで陸には隠れる
  scene.add(seaMesh);
  setupSeaSlider();
}

// 海面標高スライダーの初期化・配線(max = 詳細エリア最低標高 → 街は水没しない範囲で調整)
function setupSeaSlider() {
  const sl = document.getElementById('seaSlider');
  const lab = document.getElementById('seaVal');
  const box = document.getElementById('seaCtrl');
  if (!sl || !lab) return;
  sl.min = -10; sl.max = 10; sl.step = 0.5;   // 海面標高 -10〜10m を 0.5m 刻みで
  sl.value = seaLevelM;
  lab.textContent = seaLevelM.toFixed(1);
  sl.addEventListener('input', () => {
    seaLevelM = Math.max(-10, Math.min(10, +sl.value));
    lab.textContent = seaLevelM.toFixed(1);
    try { localStorage.setItem('iseharaSeaLevel', String(seaLevelM)); } catch (e) {}
    setSeaLevel();
  });
  // スマホ: スライダー操作がカメラ回転ハンドラに奪われないようにする
  if (box) ['touchstart', 'touchmove', 'pointerdown'].forEach(ev =>
    box.addEventListener(ev, e => e.stopPropagation(), { passive: false }));
}

// OSM(Overpass)データの取得だけを行う。地形(標高)データへの依存が無いので、
// loadElevations() と並行に開始できる(以前は awaitloadElevations() の後に
// 直列で呼んでおり、地形取得+OSM取得の待ち時間がそのまま合算されていた)。
async function fetchOSMData() {
  // 伊勢原本体エリア(OSM_BOUNDS)は起動のたびに全く同じ範囲・同じクエリになるため、
  // 一度取得した結果を静的JSONとして同梱してある(data/isehara-osm-seed.json)。
  // まずこれを同一オリジンから取りに行く — Overpass本体の混雑やRender等の共有IP制限の
  // 影響を受けず、静的ファイル配信なので通常数百ms〜1秒程度で完了する。これが
  // 「起動時に道路・建物の読み込みが遅い」の主因(Overpassへの40〜45秒クエリ)を消す。
  // ファイルが無い/壊れている場合のみ、従来どおりOverpassへ直接問い合わせる。
  try {
    const seedRes = await fetch('/data/isehara-osm-seed.json');
    if (seedRes.ok) {
      const seedJson = await seedRes.json();
      if (seedJson && Array.isArray(seedJson.elements) && seedJson.elements.length > 0) return seedJson;
    }
  } catch (e) { /* 静的ファイル取得失敗時は下のOverpass直接取得にフォールバック */ }

  const bb = `${OSM_BOUNDS.minLat},${OSM_BOUNDS.minLon},${OSM_BOUNDS.maxLat},${OSM_BOUNDS.maxLon}`;
  const query = `[out:json][timeout:40];(way["highway"](${bb});way["building"](${bb});way["landuse"~"residential|commercial|industrial|retail|mixed_use|farmland|orchard|meadow|allotments|forest"](${bb});way["leisure"~"park|garden|playground"](${bb});way["natural"~"water|wood"](${bb});way["waterway"~"river|stream|canal|riverbank"](${bb});relation["natural"="water"](${bb});relation["waterway"="riverbank"](${bb});way["railway"="rail"](${bb});node["railway"="station"](${bb});node["railway"="halt"](${bb});node["public_transport"="station"](${bb}););out geom;`;
  const url = 'https://overpass-api.de/api/interpreter?data=' + encodeURIComponent(query);
  // 一度の失敗(429やタイムアウト)ですぐ単純格子状のフォールバックマップに落とすと、Overpassが
  // 一時的に混雑していただけでも見た目が大きく崩れてしまう。最大3回、間隔を空けて再試行する。
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      showToast(attempt === 1
        ? '🗺 伊勢原マップ取得中... (最大45秒)'
        : `🗺 伊勢原マップ取得再試行中... (${attempt}/3)`, { sticky: true });
      // クエリ自体のOverpass側タイムアウトが40秒なのに、以前クライアント側は32秒で見切っていたため、
      // サーバーがまだ処理中でも早期に諦めてフォールバックになることがあった。サーバー側より余裕を持たせる。
      const res = await Promise.race([
        fetch(url),
        new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 45000))
      ]);
      if (!res.ok) throw new Error('HTTP ' + res.status); // 429/5xx等
      const json = await res.json();
      if (!json || !json.elements) throw new Error('no elements');
      return json;
    } catch (e) {
      if (attempt < 3) await new Promise(r => setTimeout(r, 4000 * attempt)); // 4s, 8s と間隔を空けて再試行
    }
  }
  return null; // 3回とも失敗した場合のみフォールバックマップを使う
}

// data を省略した場合は自分で fetchOSMData() する(従来どおりの単体呼び出しにも対応)
async function loadOSM(preFetchedData) {
  const data = preFetchedData !== undefined ? preFetchedData : await fetchOSMData();

  if (!data || !data.elements) {
    showToast('⚠️ OSM取得失敗 - フォールバックマップ使用');
    buildFallbackMap();
    return;
  }
  showToast(`✅ OSMデータ取得完了 (${data.elements.length} 要素)`);

  const nodeMap = {};
  data.elements.forEach(el => {
    if (el.type === 'node') nodeMap[el.id] = { lat: el.lat, lon: el.lon };
  });

  let buildingCount = 0;
  let roadCount = 0;

  // === PASS 1: Roads & railways first ===
  data.elements.forEach(el => {
    if (el.type !== 'way') return;
    const tags = el.tags || {};

    if (tags.highway && el.geometry && el.geometry.length >= 2) {
      const hw = tags.highway;
      const isImportant = hw==='trunk' || hw==='primary' || hw==='secondary' || hw==='motorway';
      // 2500だと伊勢原駅周辺など密な市街地で細街路が途中打ち切りになり、その空白地に
      // (別キャップの)建物だけは生成されてしまうため「建物が道路をふさぐ」ように見えていた。
      if (!isImportant && roadCount >= 6000) return;
      const width = hw==='trunk'||hw==='primary' ? 8 : hw==='secondary' ? 6 : hw==='tertiary'||hw==='residential' ? 4 : 2.5;
      const type = hw==='motorway' ? 'motorway' : hw==='motorway_link' ? 'trunk'
                 : (hw==='trunk'||hw==='primary'||hw==='secondary'||hw==='tertiary') ? hw : 'road';
      if (USES_MEIJI_LANDUSE && (type === 'road' || type === 'motorway')) return; // 明治・江戸: 細街路も高速道路もない
      if (MODE === 'space' && (type === 'road' || type === 'tertiary' || type === 'secondary')) return; // 宇宙: 鉄道・高速道路・国道(幹線)以外の小さな道路は出さない
      for (let i = 0; i < el.geometry.length-1; i++) {
        const a = latLonToXZ(el.geometry[i].lat, el.geometry[i].lon);
        const b = latLonToXZ(el.geometry[i+1].lat, el.geometry[i+1].lon);
        addRoad(a.x, a.z, b.x, b.z, width, type);
      }
      roadCount++;
    }

    // 明治(1880年代): 伊勢原周辺に鉄道はまだない
    if (!USES_MEIJI_LANDUSE && tags.railway === 'rail' && el.geometry && el.geometry.length >= 2) {
      for (let i = 0; i < el.geometry.length-1; i++) {
        const a = latLonToXZ(el.geometry[i].lat, el.geometry[i].lon);
        const b = latLonToXZ(el.geometry[i+1].lat, el.geometry[i+1].lon);
        addRoad(a.x, a.z, b.x, b.z, 4, 'railway');
      }
    }

    // 川・水路(青いリボン。isOnRoad判定で川の上への建物生成も防げる)
    // riverbank は線ではなく面(handleAreaFeature)で処理するため除外
    if (tags.waterway && tags.waterway !== 'riverbank' && el.geometry && el.geometry.length >= 2) {
      const ww = waterwayWidth(tags);
      for (let i = 0; i < el.geometry.length-1; i++) {
        const a = latLonToXZ(el.geometry[i].lat, el.geometry[i].lon);
        const b = latLonToXZ(el.geometry[i+1].lat, el.geometry[i+1].lon);
        addRoad(a.x, a.z, b.x, b.z, ww, 'water');
      }
    }
  });

  // === PASS 2: Buildings — skip any that overlap a road ===
  data.elements.forEach(el => {
    if (el.type !== 'way') return;
    const tags = el.tags || {};

    if (USES_MEIJI_LANDUSE && tags.building && el.geometry && el.geometry.length >= 1) {
      // 実際には描画しないが、密度ヒントとして棟数だけ数えておく(フィルタで捨てる前に)
      const p0 = latLonToXZ(el.geometry[0].lat, el.geometry[0].lon);
      noteModernBuilding(p0.x, p0.z);
    }
    if (USES_MEIJI_LANDUSE && tags.building) { // 明治・江戸: OSM建物(=現代の実測)は神社仏閣のみ残し、他は迅速測図ベースの手続き生成に任せる
      const st = getBuildingStyle(tags);
      if (!st || (st.type !== 'shrine' && st.type !== 'temple')) return;
    }
    // 学校・大学・病院は、校舎そのものにbuildingタグが無く敷地全体(amenity)しか
    // マッピングされていないケースが多い。その場合も敷地の中心に代表的な校舎を1棟
    // 建てる(敷地いっぱいの巨大建物にならないよう、サイズは後段でキャップする)。
    const isCampusOnly = !USES_MEIJI_LANDUSE && !tags.building &&
      ['school','university','college','hospital'].includes(tags.amenity || '');
    if ((tags.building || isCampusOnly) && buildingCount < 3000 && el.geometry && el.geometry.length >= 4) { // 700/1200では初期エリア内でも歯抜けが出ていた
      const pts = el.geometry.map(g => latLonToXZ(g.lat, g.lon));
      let cx = 0, cz = 0;
      pts.forEach(p => { cx += p.x; cz += p.z; });
      cx /= pts.length; cz /= pts.length;

      let maxDx = 0, maxDz = 0;
      pts.forEach(p => {
        maxDx = Math.max(maxDx, Math.abs(p.x - cx));
        maxDz = Math.max(maxDz, Math.abs(p.z - cz));
      });
      let w = Math.max(maxDx * 2, 2);
      let d = Math.max(maxDz * 2, 2);
      if (isCampusOnly) { w = Math.min(w, 34); d = Math.min(d, 22); } // 敷地全体でなく校舎サイズに収める

      let style = getBuildingStyle(tags);
      if (MODE === 'edo' && shouldSkipEdoBuilding(style)) return; // 江戸: 現代の建物密度をそのまま使わず間引く
      const resolvedH = resolveBuildingHeight(tags);
      // building:levelsタグが無い場合の階数フォールバック。国プロファイルのlevelsRangeが
      // あればそれを使う(香港は塔状に高め、アメリカ郊外は低めに寄る)。無ければ従来通り1〜3階。
      const cprofH = MODE === 'real' ? getCountryBuildingProfile(currentCountryCode) : null;
      const [lvMin, lvMax] = (cprofH && cprofH.levelsRange) || [1, 3];
      const levels = parseInt(tags['building:levels']) || (lvMin + Math.floor(Math.random() * (lvMax - lvMin + 1)));
      let h = resolvedH != null ? resolvedH : Math.max(levels * 3, 3) + Math.random()*2;
      h = applyLandmarkMinHeight(style, h); // 学校・病院・役場・神社仏閣は最低限の高さを確保
      style = classifyResidential(style, w, d, h);
      let fw = w, fd = d, fh = h;
      ({ w: fw, d: fd, h: fh } = applySizeFloor(style, w, d, h)); // マンション・工場は最低サイズを底上げ
      if (MODE === 'edo') fh = applyEdoHeightCap(style, fh); // 江戸: 現代建物の実測高さそのままだと高層ビルになるため木造家屋相当に抑える
      // 直接生成せず、タイル取得分と同じキューに積んでフレーム分割で生成する。
      // 【重要】以前はここで直接addBuildingしており、NEAR高解像度地形がまだ届く前に
      // 高さが焼き込まれてしまい、初期スポーン周辺の建物が浮く/埋まる主な原因になっていた。
      // isOnRoad判定はキュー投入時ではなく、他の建物と同じくフレーム分割の生成時に行う。
      pendingBuildings.push({ x: cx, z: cz, w: fw, d: fd, h: fh, style, real: true });
      buildingCount++;
    }
  });

  // === PASS 3: Collect landuse polygons for dynamic chunk generation ===
  data.elements.forEach(el => {
    if (el.type !== 'way') return;
    const tags = el.tags || {};
    const lu = tags.landuse;
    if (!lu || !['residential','commercial','industrial','retail','mixed_use'].includes(lu)) return;
    if (!el.geometry || el.geometry.length < 4) return;
    const pts = el.geometry.map(g => latLonToXZ(g.lat, g.lon));
    let minX=Infinity, maxX=-Infinity, minZ=Infinity, maxZ=-Infinity;
    pts.forEach(p => { minX=Math.min(minX,p.x); maxX=Math.max(maxX,p.x); minZ=Math.min(minZ,p.z); maxZ=Math.max(maxZ,p.z); });
    const _luEntry = { pts, lu, minX, maxX, minZ, maxZ };
    landusePolygons.push(_luEntry);
    polyGridAdd(landuseGrid, _luEntry);
  });

  // Station landmarks(明治: 鉄道開通前なので駅なし)
  processStationNodes(data.elements);

  // === PASS 4: 公園・水域・田畑・森 + multipolygon水面 ===
  data.elements.forEach(el => {
    handleAreaFeature(el);
    if (el.type === 'relation') processWaterRelation(el);
  });

  // 初期ロードで処理したway IDを記録(境界タイルの再取得時に二重生成しないため)
  data.elements.forEach(el => { if (el.type === 'way') seenOSMWays.add(el.id); });

  showToast(`✨ ChronoDriftの世界へようこそ！ (建物:${buildingCount} 道路:${roadCount})`, { duration: 4000 });

  // モード切替リロードなら切替前の位置・向きから再開、通常起動は東成瀬2-2-11にスポーン
  const resume = consumeResumePos();
  if (resume) {
    const rp = latLonToXZ(resume.lat, resume.lon);
    player.position.set(rp.x, 0, rp.z); // yはanimateの床追従が地形/屋根に合わせる
    if (typeof resume.yaw === 'number') camYaw = resume.yaw;
    if (typeof resume.rot === 'number') player.rotation.y = resume.rot;
  } else {
    const spw = latLonToXZ(SPAWN_LAT, SPAWN_LON);
    const sp = findSpawnNear(spw.x, spw.z); // 建物内なら最寄りの空き地点へ
    player.position.set(sp.x, 0, sp.z);
  }
  initialWorldLoaded = true; // ここからタイル取得を許可(標高は既に反映済み)。森は updateForest が周囲に描く
}

function buildFallbackMap() {
  // OSM取得が完全に失敗した時だけのプレースホルダー生成。位置は元々全部架空なので、
  // わかっていれば国プロファイルのグリッド間隔・充填率を使う(わからなければ従来通り40m/0.6)。
  const cprofFb = getCountryBuildingProfile(currentCountryCode);
  const gridSpacing = (cprofFb && cprofFb.fallbackGridSpacing) || 40;
  const fillProb = (cprofFb && cprofFb.fallbackFillProbability != null) ? cprofFb.fallbackFillProbability : 0.6;
  // Grid of buildings (meter scale)
  for (let x = -1000; x <= 1000; x += gridSpacing) {
    for (let z = -1000; z <= 1000; z += gridSpacing) {
      if (Math.random() < fillProb) {
        const w = 8 + Math.random()*20;
        const d = 8 + Math.random()*20;
        const h = 4 + Math.random()*20;
        addBuilding(x + (Math.random()-0.5)*15, z + (Math.random()-0.5)*15, w, d, h);
      }
    }
  }
  // Roads (6m wide)
  for (let i = -1000; i <= 1000; i += 40) {
    addRoad(-1200, i, 1200, i, 6);
    addRoad(i, -1200, i, 1200, 6);
  }
  showToast('✨ ChronoDriftの世界（フォールバック）へようこそ！', { duration: 3000 });
  const resume2 = consumeResumePos();
  if (resume2) {
    const rp2 = latLonToXZ(resume2.lat, resume2.lon);
    player.position.set(rp2.x, 0, rp2.z);
    if (typeof resume2.yaw === 'number') camYaw = resume2.yaw;
    if (typeof resume2.rot === 'number') player.rotation.y = resume2.rot;
  } else {
    const spw2 = latLonToXZ(SPAWN_LAT, SPAWN_LON);
    const sp2 = findSpawnNear(spw2.x, spw2.z);
    player.position.set(sp2.x, 0, sp2.z);
  }
  initialWorldLoaded = true;
}

// 起動時の初期位置: スマホ等の位置情報から取得。取得不可(非対応/拒否/タイムアウト)は東京駅。
const TOKYO_STATION = { lat: 35.681236, lon: 139.767125 };
function getStartLocation() {
  return new Promise((resolve) => {
    if (!('geolocation' in navigator)) { resolve(TOKYO_STATION); return; }
    let done = false;
    const finish = (v) => { if (!done) { done = true; resolve(v); } };
    const timer = setTimeout(() => finish(TOKYO_STATION), 8000); // 応答が無ければ東京駅
    navigator.geolocation.getCurrentPosition(
      (p) => { clearTimeout(timer); finish({ lat: p.coords.latitude, lon: p.coords.longitude }); },
      () => { clearTimeout(timer); finish(TOKYO_STATION); }, // 拒否・失敗も東京駅
      { enableHighAccuracy: true, timeout: 7000, maximumAge: 60000 }
    );
  });
}

// 【重要】起動ブートストラップIIFE(loadElevations/loadOSM等を呼ぶ処理)は、
// 元は単一スクリプトの関数巻き上げにより「定義がテキスト上どこにあっても」動いていたが、
// ファイル分割後は script タグをまたいだ巻き上げが効かない。このIIFEはloadElevations経由で
// xzToLatLon(part7.js)を同期的に呼ぶため、part7を読み込み終える前に実行されると
// ReferenceErrorで停止してしまう(実際に発生した不具合)。全ファイル読み込み後に
// 確実に実行されるよう、このIIFE本体は js/legacy/part9.js の末尾に移動した。
// (getStartLocation/TOKYO_STATION はこのファイルの他の関数から参照されないためここに残す)
