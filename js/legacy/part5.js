/**
 * legacy/part5.js — index.html の巨大インラインスクリプトを行範囲のまま機械的に切り出した
 * ファイル(5/9)。part4.js の続き。詳細は part1.js 冒頭のコメント参照。
 */
// ======= TERRAIN SYSTEM =======
const TERRAIN_SEGS = 24; // 25x25 = 625 vertices, ~170m grid
const WORLD_W = (OSM_BOUNDS.maxLon - OSM_BOUNDS.minLon) * SCALE * COS_LAT;
const WORLD_D = (OSM_BOUNDS.maxLat - OSM_BOUNDS.minLat) * SCALE;
const SEGS1 = TERRAIN_SEGS + 1;

// Build terrain mesh (detailed, covers OSM area)
// 高さ別の頂点カラーで起伏を視覚化するマテリアル(遠景地形と共用)
const terrainGeo = new THREE.PlaneGeometry(WORLD_W, WORLD_D, TERRAIN_SEGS, TERRAIN_SEGS);
const terrainCols = new Float32Array(SEGS1 * SEGS1 * 3);
for (let i = 0; i < SEGS1 * SEGS1; i++) { terrainCols[i*3] = 0.23; terrainCols[i*3+1] = 0.33; terrainCols[i*3+2] = 0.21; }
terrainGeo.setAttribute('color', new THREE.BufferAttribute(terrainCols, 3));
const terrainMat = new THREE.MeshLambertMaterial({ vertexColors: true });
terrainMesh = new THREE.Mesh(terrainGeo, terrainMat);
terrainMesh.rotation.x = -Math.PI / 2;
terrainMesh.receiveShadow = true;
terrainMesh.renderOrder = 0;
scene.add(terrainMesh);

// 遠景の実地形データ(loadWideTerrain がバックグラウンドで代入)。
// farNodeY が参照するため、初回 updateFarMesh(true) より前に宣言しておく(TDZ回避)。
let wideElev = null;

// ======= 遠景地形メッシュ(プレイヤー追従) =======
// 以前は y=-0.3 の平坦な巨大平面だったため、OSM_BOUNDS 外に動的生成された
// 道路・建物(getTerrainY はエッジの標高にクランプされる)が宙に浮き、
// 下に地面が無い状態になっていた。道路・建物と同じ getTerrainY を
// サンプリングする粗いメッシュをプレイヤーに追従させることで、
// 生成物のある場所には必ず一致した高さの地面が存在するようにする。
const FAR_SIZE = 12000, FAR_SEGS = 60, FAR_SEGS1 = FAR_SEGS + 1; // 半径6km > far(5000) なので端は見えない
const farGeo = new THREE.PlaneGeometry(FAR_SIZE, FAR_SIZE, FAR_SEGS, FAR_SEGS);
farGeo.setAttribute('color', new THREE.BufferAttribute(new Float32Array(FAR_SEGS1 * FAR_SEGS1 * 3), 3));
const farMesh = new THREE.Mesh(farGeo, terrainMat);
farMesh.rotation.x = -Math.PI / 2;
farMesh.frustumCulled = false; // 頂点変位+移動するためカリングさせない
farMesh.renderOrder = 0;
scene.add(farMesh);

// --- 遠景メッシュの高さは farNodeY / farSurfaceY に一本化する ---
// 頂点は世界座標に固定された FAR_STEP(200m) 格子上にあり(中心スナップも FAR_STEP 単位)、
// 「描画される遠景メッシュ表面」= farSurfaceY が返す値、が厳密に成り立つ。
const FAR_STEP = FAR_SIZE / FAR_SEGS; // 200m
const FAR_Y = -0.15;                  // メッシュ全体のyオフセット(詳細地形とのz-fighting回避)
const FAR_SINK_MARGIN = 250, FAR_SINK = 5; // 詳細地形の内側では5m沈めて重なりを防ぐ

// 格子ノード(i,j)の高さ(メッシュ頂点とクエリの両方がこの1つの関数を使う)
function farNodeY(i, j) {
  const x = i * FAR_STEP, z = j * FAR_STEP;
  const inDetail = x > -WORLD_W/2 + FAR_SINK_MARGIN && x < WORLD_W/2 - FAR_SINK_MARGIN &&
                   z > -WORLD_D/2 + FAR_SINK_MARGIN && z < WORLD_D/2 - FAR_SINK_MARGIN;
  let h = getTerrainY(x, z); // 詳細グリッド(範囲外は縁の高さでクランプ)
  if (inDetail) return h - FAR_SINK;
  // 詳細範囲の外側: 遠景の実地形(wideElev)へ滑らかに遷移させ、大山や海岸を出す。
  // wideElev 未取得時は従来どおりクランプ値のまま(安全なフォールバック)。
  if (wideElev) {
    const dEdge = Math.max(Math.abs(x) - (WORLD_W/2 - FAR_SINK_MARGIN),
                           Math.abs(z) - (WORLD_D/2 - FAR_SINK_MARGIN), 0);
    const t = Math.min(1, dEdge / 1400); // 縁から1.4kmかけて実地形へブレンド
    h = h * (1 - t) + getWideTerrainY(x, z) * t;
  }
  return h;
}

// 描画される遠景メッシュ表面と厳密に一致する高さ(三角形分割もPlaneGeometryと同一)
function farSurfaceY(x, z) {
  const i = Math.floor(x / FAR_STEP), j = Math.floor(z / FAR_STEP);
  const u = x / FAR_STEP - i, v = z / FAR_STEP - j;
  const ha = farNodeY(i, j),     hb = farNodeY(i, j + 1);
  const hc = farNodeY(i + 1, j + 1), hd = farNodeY(i + 1, j);
  const s = (u + v <= 1)
    ? ha + (hd - ha) * u + (hb - ha) * v
    : hc + (hb - hc) * (1 - u) + (hd - hc) * (1 - v);
  return s + FAR_Y;
}

let farLastX = Infinity, farLastZ = Infinity;
function updateFarMesh(force) {
  const cx = Math.round(player.position.x / FAR_STEP) * FAR_STEP;
  const cz = Math.round(player.position.z / FAR_STEP) * FAR_STEP;
  if (!force && cx === farLastX && cz === farLastZ) return;
  farLastX = cx; farLastZ = cz;
  farMesh.position.set(cx, FAR_Y, cz);
  const i0 = Math.round((cx - FAR_SIZE / 2) / FAR_STEP);
  const j0 = Math.round((cz - FAR_SIZE / 2) / FAR_STEP);
  const pos = farGeo.attributes.position, col = farGeo.attributes.color;
  for (let jz = 0; jz < FAR_SEGS1; jz++) {
    for (let jx = 0; jx < FAR_SEGS1; jx++) {
      const idx = jz * FAR_SEGS1 + jx;
      const h = farNodeY(i0 + jx, j0 + jz); // クエリと同じノード関数を使用
      pos.setZ(idx, h);
      const c = terrainColorRGB(h);
      col.setXYZ(idx, c[0], c[1], c[2]);
    }
  }
  pos.needsUpdate = true;
  col.needsUpdate = true;
  farGeo.computeVertexNormals();
}

let elevData = null;  // flat array [iz * SEGS1 + ix]
let elevBase = 0;

// 詳細地形メッシュの「描画される表面」と厳密に一致する高さを返す。
// 修正点1: 以前はバイリニア補間だったが、実際のメッシュは三角形で描画されるため
//   急斜面ではセル対角線上で最大数mズレて道路が埋まっていた。
//   → PlaneGeometry と同じ対角線(b-d)の区分線形補間に変更し、ズレをゼロに。
// 修正点2: 範囲外で fx>1 のまま線形外挿され高さが暴走していた → [0,1]にクランプ。
function getTerrainY(x, z) {
  if (!elevData) return 0;
  const nx = (x + WORLD_W / 2) / WORLD_W * TERRAIN_SEGS;
  const nz = (z + WORLD_D / 2) / WORLD_D * TERRAIN_SEGS;
  const ix = Math.max(0, Math.min(TERRAIN_SEGS - 1, Math.floor(nx)));
  const iz = Math.max(0, Math.min(TERRAIN_SEGS - 1, Math.floor(nz)));
  const fx = Math.max(0, Math.min(1, nx - ix));
  const fz = Math.max(0, Math.min(1, nz - iz));
  const h00 = elevData[ iz    * SEGS1 + ix    ];
  const h10 = elevData[ iz    * SEGS1 + ix + 1];
  const h01 = elevData[(iz+1) * SEGS1 + ix    ];
  const h11 = elevData[(iz+1) * SEGS1 + ix + 1];
  if (fx + fz <= 1) return h00 + (h10 - h00) * fx + (h01 - h00) * fz;
  return h11 + (h01 - h11) * (1 - fx) + (h10 - h11) * (1 - fz);
}

// 起伏の倍率
const ELEV_SCALE = 2.0;

// ======= 「見えている地面」の高さ(生成物・プレイヤーはすべてこれを使う) =======
// 画面に存在する地面は「詳細地形メッシュ」と「遠景地形メッシュ」の2枚。
// getTerrainY / farSurfaceY はどちらも描画される三角形と厳密に一致するので、
// その上側包絡線(max)に置けば、どちらのメッシュにも埋まることは構造上あり得ない。
function getGroundY(x, z) {
  const inside = x >= -WORLD_W/2 && x <= WORLD_W/2 && z >= -WORLD_D/2 && z <= WORLD_D/2;
  const fy = farSurfaceY(x, z);
  return inside ? Math.max(getTerrainY(x, z), fy) : fy;
}

// 高さ→頂点カラー: 緑(低地) → 深緑(山) → 岩 → 雪。詳細地形と遠景地形で共用
let terrainMaxH = 1;
// 岩・雪・森林限界の境界(ゲーム高さ)。実標高(m)基準で loadElevations が設定する。
// 以前は「詳細エリアの最大高」で正規化していたため、遠景の実際の高山(大山1252m)が
// 正規化1.0を超えて全部「白い岩」になり、森も詳細エリアの縁で途切れていた。
// 実標高基準にして、山は中腹まで緑・森、岩と雪は本当に高い所だけにする。
let ROCK_Y = 1e9, SNOW_Y = 1e9, TREELINE = 1e9;
function terrainColorRGB(h) {
  if (MODE === 'space')   { const t = Math.max(0,Math.min(1,h/terrainMaxH)); const g = 0.15 + t*0.25; return [g*0.9, g, g*1.3]; }
  if (MODE === 'edo')     { const t = Math.max(0,Math.min(1,h/terrainMaxH)); return [0.30 + 0.18*t, 0.27 + 0.10*t, 0.16 + 0.06*t]; }
  if (MODE === 'marchen') { const t = Math.max(0,Math.min(1,h/terrainMaxH)); return [0.28 + 0.42*t, 0.60 - 0.12*t, 0.32 + 0.28*t]; }
  // 現実・明治: 実標高基準。森林限界(約2500m)まで森の緑、2500〜2900mで岩、2900m以上が雪。
  // 大山・丹沢はいずれも2500m未満なので全山が緑=森になる。
  if (h < ROCK_Y) { const k = Math.max(0, Math.min(1, h / Math.max(1, ROCK_Y))); return [0.20 - 0.05*k, 0.34 - 0.07*k, 0.17 - 0.03*k]; } // 低地の緑→山地の深緑
  if (h < SNOW_Y) { const k = (h - ROCK_Y) / Math.max(1, SNOW_Y - ROCK_Y);       return [0.15 + 0.32*k, 0.26 + 0.22*k, 0.13 + 0.22*k]; } // 岩肌
  const k = Math.min(1, (h - SNOW_Y) / Math.max(1, SNOW_Y - ROCK_Y));            return [0.55 + 0.35*k, 0.58 + 0.32*k, 0.56 + 0.38*k];   // 雪
}
// 起動直後も緑の地面で初期化(elevData ロード後に applyTerrain が再サンプリングする)
updateFarMesh(true);

// elevData を terrainGeo に反映(頂点高さ+高さ別カラー+法線+バウンディング再計算)
function applyTerrain() {
  const posAttr = terrainGeo.attributes.position;
  const colAttr = terrainGeo.attributes.color;
  terrainMaxH = 1;
  for (const h of elevData) terrainMaxH = Math.max(terrainMaxH, h);
  for (let i = 0; i < elevData.length; i++) {
    const h = elevData[i];
    posAttr.setZ(i, h); // メッシュ回転前のローカルZ → ワールドY
    const c = terrainColorRGB(h);
    colAttr.setXYZ(i, c[0], c[1], c[2]);
  }
  posAttr.needsUpdate = true;
  colAttr.needsUpdate = true;
  terrainGeo.computeVertexNormals();
  terrainGeo.computeBoundingSphere(); // 頂点変位後に再計算しないとカリング判定が狂う
  updateFarMesh(true); // 遠景地形も新しい標高で再サンプリング
}

// API失敗時のフォールバック — 北西(大山方面)に向かって高くなる擬似地形
function proceduralElevs(elevs) {
  for (let iz = 0; iz < SEGS1; iz++) {
    for (let ix = 0; ix < SEGS1; ix++) {
      const wx = -WORLD_W/2 + ix * WORLD_W / TERRAIN_SEGS;
      const wz = -WORLD_D/2 + iz * WORLD_D / TERRAIN_SEGS;
      const fx = (wx + WORLD_W/2) / WORLD_W; // 0=西
      const fz = (wz + WORLD_D/2) / WORLD_D; // 0=北
      const mountain = Math.pow(Math.max(0, 1 - (fx*1.4 + fz*0.9)), 2) * 350;
      const rolling = (Math.sin(wx*0.004)*Math.cos(wz*0.003) + Math.sin(wx*0.011+1.7)*Math.cos(wz*0.009+0.6)*0.5) * 12 + 14;
      elevs[iz * SEGS1 + ix] = Math.max(0, mountain + rolling);
    }
  }
}

// 同時実行数を絞ってバッチ処理する小さなワーカープール。
// 標高取得を Promise.all で無制限に並列発行していたところ、遠景の高解像度化(WIDE_SEGS増)
// と合わさって一度に最大50件以上の同時リクエストが発生し、プロキシ/サーバーが詰まって
// OSM取得(伊勢原本体)まで巻き添えで失敗する、遠くへジャンプした際に地形取得自体が
// 失敗して何も描写されない、という不具合を起こしていた。同時実行数を小さく固定する。
const FETCH_CONCURRENCY = 3;
async function runLimited(items, worker, limit = FETCH_CONCURRENCY) {
  const results = new Array(items.length);
  let idx = 0;
  async function runNext() {
    while (idx < items.length) {
      const i = idx++;
      results[i] = await worker(items[i], i);
    }
  }
  const pool = [];
  for (let n = 0; n < Math.min(limit, items.length); n++) pool.push(runNext());
  await Promise.all(pool);
  return results;
}

// ======= 国土地理院(GSI)標高タイル =======
// opentopodataには「1リクエスト/秒・1リクエスト最大100地点・1日最大1000コール」の制限があり、
// 初回起動だけで約21コール(初期7+遠景9+NEAR5)、移動のたびにさらに消費するため、
// 「地形待ち→道路・建物生成が全部ゲートされて遅い」の根本原因だった。
// 日本国内では国土地理院の標高タイル(dem_png: DEM10B相当、z14、約10mメッシュ)を
// 並列取得する。レート制限・日次上限が無く、地形読み込みが数十秒→数秒になる。
// ・タイルはCORS対応なのでプロキシを通さず直接fetchできる(ブラウザHTTPキャッシュも効く)
// ・海上などタイルが無い場所は404が正常応答 → 「データ無し」(呼び出し側で海底/0m扱い)
// ・日本のカバー範囲外の点が混じるグリッドや、ネットワークエラー時は null を返し、
//   呼び出し側が従来どおり opentopodata へフォールバックする(挙動の安全網は従来のまま)
const GSI_DEM_Z = 14;
const _gsiTiles = new Map(); // "tx,ty" -> Promise<Float32Array|null> (null=タイル無し/海上)
const GSI_TILE_CACHE_MAX = 120; // 約30MB。超えたら古い順に捨てる(HTTPキャッシュがあるので再取得は速い)
function gsiCovers(lat, lon) { return lat >= 20 && lat <= 46 && lon >= 122 && lon <= 154; }
function _gsiLoadTile(tx, ty) {
  const key = tx + ',' + ty;
  let p = _gsiTiles.get(key);
  if (p) return p;
  p = (async () => {
    const res = await fetch(`https://cyberjapandata.gsi.go.jp/xyz/dem_png/${GSI_DEM_Z}/${tx}/${ty}.png`);
    if (res.status === 404) return null; // 海上など: タイルが存在しない(正常系)
    if (!res.ok) throw new Error('GSI HTTP ' + res.status);
    const bmp = await createImageBitmap(await res.blob());
    const cv = document.createElement('canvas');
    cv.width = 256; cv.height = 256;
    const ctx = cv.getContext('2d', { willReadFrequently: true });
    ctx.drawImage(bmp, 0, 0);
    const d = ctx.getImageData(0, 0, 256, 256).data;
    const out = new Float32Array(65536);
    for (let i = 0; i < 65536; i++) {
      // 標高 = (R*2^16 + G*2^8 + B) * 0.01m。2^23 は無効値(海など)。それ以上は負値(2^24を引く)
      const x = d[i * 4] * 65536 + d[i * 4 + 1] * 256 + d[i * 4 + 2];
      out[i] = (x === 8388608) ? NaN : (x < 8388608 ? x : x - 16777216) * 0.01;
    }
    return out;
  })();
  p.catch(() => _gsiTiles.delete(key)); // 失敗Promiseをキャッシュに残すと永久に失敗し続けるため取り除く
  _gsiTiles.set(key, p);
  if (_gsiTiles.size > GSI_TILE_CACHE_MAX) {
    for (const k of _gsiTiles.keys()) {
      if (_gsiTiles.size <= GSI_TILE_CACHE_MAX) break;
      if (k !== key) _gsiTiles.delete(k);
    }
  }
  return p;
}
// latlons([{lat,lon},...])に対応する標高(m)の配列を返す。データ無し地点(海上)は null。
// グリッド全体が使えない場合(国外の点が混じる/ネットワーク失敗)は null を返す。
async function fetchElevationsGSI(latlons) {
  if (!latlons.length || !latlons.every(ll => gsiCovers(ll.lat, ll.lon))) return null;
  try {
    const n = 2 ** GSI_DEM_Z;
    const jobs = latlons.map(ll => {
      const xt = (ll.lon + 180) / 360 * n;
      const latR = ll.lat * Math.PI / 180;
      const yt = (1 - Math.log(Math.tan(latR) + 1 / Math.cos(latR)) / Math.PI) / 2 * n;
      const tx = Math.floor(xt), ty = Math.floor(yt);
      return { key: tx + ',' + ty, tx, ty,
        px: Math.min(255, Math.floor((xt - tx) * 256)),
        py: Math.min(255, Math.floor((yt - ty) * 256)) };
    });
    // タイル単位に重複排除して並列取得(キャッシュ削除に巻き込まれないようローカルに保持)
    const tiles = new Map();
    const keys = [...new Set(jobs.map(j => j.key))];
    await runLimited(keys, async (k, i) => {
      const j = jobs.find(jb => jb.key === k);
      tiles.set(k, await _gsiLoadTile(j.tx, j.ty));
    }, 8);
    return jobs.map(j => {
      const tile = tiles.get(j.key);
      const h = tile ? tile[j.py * 256 + j.px] : NaN;
      return Number.isFinite(h) ? h : null;
    });
  } catch (e) {
    return null; // ネットワークエラー等 → 呼び出し側で opentopodata にフォールバック
  }
}

async function loadElevations() {
  showToast('🏔 地形データ取得中...', { sticky: true });
  // Build lat/lon for each vertex
  // PlaneGeometry vertex (ix, iz): worldX = -W/2 + ix*W/SEGS, worldZ = -D/2 + iz*D/SEGS
  const latlons = [];
  for (let iz = 0; iz < SEGS1; iz++) {
    for (let ix = 0; ix < SEGS1; ix++) {
      const wx = -WORLD_W/2 + ix * WORLD_W / TERRAIN_SEGS;
      const wz = -WORLD_D/2 + iz * WORLD_D / TERRAIN_SEGS;
      latlons.push(xzToLatLon(wx, wz));
    }
  }
  const elevs = new Array(latlons.length).fill(0);
  let ok = true;
  // まず国土地理院タイルから並列取得(数秒)。国外・失敗時のみopentopodata(直列・低速)へ
  const gsi = await fetchElevationsGSI(latlons);
  if (gsi) {
    for (let i = 0; i < elevs.length; i++) elevs[i] = gsi[i] || 0; // データ無し(海上)は0m
  } else try {
    // バッチを少数ずつ並列発行する(FETCH_CONCURRENCY件まで)。opentopodataの1req/秒
    // レート制限は server/server.js のプロキシ側(scheduleUpstream)が直列キューで既に
    // 守っているため、クライアント側でさらに1.1秒ずつ待つのは二重の待機だった。
    // ただし無制限に同時発行するとプロキシ/サーバーが詰まるため、少数の同時実行数に絞る。
    const batches = [];
    for (let i = 0; i < latlons.length; i += 100) batches.push(latlons.slice(i, i + 100));
    const results = await runLimited(batches, batch => {
      const locStr = batch.map(ll => `${ll.lat.toFixed(6)},${ll.lon.toFixed(6)}`).join('|');
      return fetch(`https://api.opentopodata.org/v1/srtm30m?locations=${encodeURIComponent(locStr)}`).then(r => r.json());
    });
    results.forEach((json, bi) => {
      if (json && json.results) json.results.forEach((r, j) => { elevs[bi*100 + j] = r.elevation || 0; });
      else ok = false; // 429等 — 失敗分は0のままだが、ok=falseで下のprocedural地形に総入れ替えされる
    });
  } catch(e) { ok = false; }

  if (!ok) {
    showToast('⚠️ 地形API失敗 - 擬似地形を生成');
    proceduralElevs(elevs);
  }

  elevBase = Math.min(...elevs);
  // 岩・雪・森林限界の高さ境界を実標高基準で確定(applyTerrain の着色前に必要)。
  // 本州中部の森林限界は約2500m。丹沢(〜1673m)・大山(1252m)はこれより低く、頂上まで森。
  ROCK_Y   = (2500 - elevBase) * ELEV_SCALE; // これ以上で岩肌(この一帯には基本存在しない)
  SNOW_Y   = (2900 - elevBase) * ELEV_SCALE; // これ以上で雪
  TREELINE = (2500 - elevBase) * ELEV_SCALE; // 森林限界≈2500m。大山・丹沢は全山が森になる
  elevData = elevs.map(e => Math.max(0, e - elevBase) * ELEV_SCALE);
  applyTerrain();
  // 地形確定後、松明ライトを地表の高さに再配置(固定y=4のままだと丘に埋まる)
  torchLights.forEach(l => { l.position.y = getGroundY(l.position.x, l.position.z) + 4; });
  initDistantSea(); // elevBase 確定後に海面を作る
  if (ok) showToast('🏔 地形反映完了');
}
