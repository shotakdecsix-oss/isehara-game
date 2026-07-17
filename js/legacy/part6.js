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
// 実際の高さ問い合わせ(terrainY)は、まずNEARの範囲内ならNEARを、範囲外ならFARを返す。
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

// この地域の高度基準(elevBase等)を確定済みかどうか。false の間、loadNearTerrain の初回成功時に
// establishRegionBase を呼ぶ。起動時だけでなく、recenterOrigin(part4.js、遠方ジャンプ後の
// ページ再読み込み直後)でも false に戻され、新しい地域の実データで確定し直される。
// 【重要】通常のプレイヤー移動によるNEAR再取得(checkNearTerrain)ではここを false に戻さない
// — elevBaseが動くと、接地済みの建物・道路の高さがゲーム内で一斉にズレて見えてしまうため、
// 「明確に別の地域に移った(=recenterOriginが呼ばれた)時だけ」基準を確定し直す。
let regionBaseReady = false;

// 遠方ジャンプ後の再開時、目的地のOSMタイル(part8.js)が届くまで表示するsticky状態メッセージが
// まだ出ているかどうか。true の間、プレイヤーの現在地タイルが届いた時点で完了メッセージに
// 差し替える(fetchOSMTileBatch参照)。以前はここでどのshowToastも呼ばれず、起動直後の
// 静的プレースホルダ文言(index.html「🗺 伊勢原マップ読み込み中...」)がずっと残ってしまっていた。
let awaitingDestinationLoad = false;

// NEARグリッドの生データ(raw、null=データ無し地点を含む)から、この地域の高度基準(elevBase)と、
// それに連動する岩・雪・森林限界のしきい値・海面のゲーム高さを確定する。伊勢原本体だけでなく、
// 遠方ジャンプで来た新しい地域でも同じロジックで確定し直す(地域専用の特別扱いをしない)。
function establishRegionBase(raw) {
  const finite = raw.filter(v => v != null);
  elevBase = finite.length ? Math.min(...finite) : 0;
  // 岩・雪・森林限界の高さ境界を実標高基準で確定。本州中部の森林限界は約2500m。
  ROCK_Y   = (2500 - elevBase) * ELEV_SCALE; // これ以上で岩肌
  SNOW_Y   = (2900 - elevBase) * ELEV_SCALE; // これ以上で雪
  TREELINE = (2500 - elevBase) * ELEV_SCALE; // 森林限界
  terrainMaxH = 1; // 色の正規化基準もこの地域向けにリセット(updateFarMeshが再度積み上げる)
  regionBaseReady = true;
  if (seaMesh) setSeaLevel(); else initDistantSea(); // 初回はここでseaMeshを作る。2回目以降(地域移動)は高さだけ更新
}

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

function terrainY(x, z) {
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
  // 直行しており、loadNearTerrainと違ってGSIタイル(レート制限なし)を
  // 使っていなかった。上限に達したりプロキシが詰まると遠景(FAR)の実地形が更新されなく
  // なり、「地形読み込みが止まる」「標高2倍の効果が(遠くの山や海岸で)見えない」の
  // 原因になっていた。まず国土地理院タイルを試し、国外の点等で使えない時だけ
  // opentopodataへフォールバックする(loadNearTerrainと同じ方針に統一)。
  const gsi = await fetchElevationsGSI(pts);
  if (gsi) {
    for (let i = 0; i < raw.length; i++) raw[i] = gsi[i];
  } else try {
    // loadNearTerrain と同じ理由で少数の同時実行数に絞ってバッチ発行する
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
  _wideFailCount = 0; _wideGiveUp = false; // 成功したのでリセット
  updateFarMesh(true); // 遠景メッシュを新しい実地形で再構築
  if (reCenter) showToast('🏔 地形反映完了', { duration: 2500 });
}

// 遠景(FAR)取得に失敗するたびに呼ぶ。checkNearTerrainのonNearTerrainFailと同じ考え方で、
// 失敗するたび再試行の間隔を伸ばす(上流を叩き続けない)。5回目以降は10秒間隔で回復を待つ。
// 【重要】以前はここに「諦め」が無く、opentopodataの1日1000コール上限(公開APIの
// ハード上限。本ファイル冒頭のコメント参照)に達すると、checkWideTerrainが10秒おきに
// 永久に再試行し続け、そのたびloadWideTerrainが「地形を取得中...」のsticky(自動で
// 消えない)トーストを出し直すため、実際には失敗を繰り返しているだけなのに画面には
// ずっと「地形を取得中...」が張り付いて見える(=「読み込みが進まない」ように見える)
// 不具合になっていた。NEARのonNearTerrainFailと同じく、一定回数失敗したら諦めて
// 自動再試行を止め、その旨を一度だけ明示するトーストに切り替える(遠景は既にterrainYが
// wideElev未取得時0m扱いにフォールバックするので、諦めても遠景が平坦になるだけで実害はない)。
let _wideFailCount = 0;
let _wideGiveUp = false;
function onWideTerrainFail() {
  _wideFailCount++;
  if (_wideFailCount === 3) { // 数回続けて失敗した時だけ知らせる(単発の通信エラーではうるさくしない)
    console.warn('[遠景地形] 取得に失敗しています(' + _wideFailCount + '回目)。取得できるまで自動で再試行します。');
    showToast('⚠️ 遠景の地形取得に失敗しています(自動で再試行中)', { duration: 3000 });
  }
  if (_wideFailCount >= 6 && !_wideGiveUp) {
    _wideGiveUp = true;
    console.warn('[遠景地形] 取得を諦めました。平坦な遠景のまま続行します(標高APIの日次上限到達等が原因の可能性)。');
    showToast('⚠️ 遠景データを取得できません(平坦な遠景のまま続行します)', { duration: 4000 });
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
  if (wideLoading || _wideGiveUp) return; // 諦めた後は明示的なジャンプ(jumpToLatLon)だけが再挑戦のきっかけ
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
  const isNewRegion = !regionBaseReady; // このリージョンの高度基準をまだ確定していなければ、今回の取得結果で確定する
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
  // 高度基準(elevBase等)は、生データ(実標高m、まだoceanFloor変換前)を使って確定する必要がある。
  // 変換後のarrを使うと「elevBaseを求めるためにelevBaseを使う」循環になってしまうため。
  if (isNewRegion) establishRegionBase(raw);
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
  // 新しい地域の高度基準を確定した直後は、松明ライトも新しい地表の高さへ再配置する
  // (固定y=4のままだと丘に埋まる/浮く)。nearElevが入ってgetGroundYが正しい高さを返せる状態で行う。
  if (isNewRegion) torchLights.forEach(l => { l.position.y = getGroundY(l.position.x, l.position.z) + 4; });
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

// OSM(Overpass)データの取得は、常にpart8.jsのタイル取得システム(checkOSMTiles/
// fetchOSMTileBatch/processTileData)が担当する。以前は伊勢原本体エリア(OSM_BOUNDS)だけ
// 特別扱いで、静的JSON(data/isehara-osm-seed.json)またはOverpassへの一括クエリにより
// 起動時に同期的に道路・建物を組み立てていた(こちらは速い代わりに、実際の生成ロジックが
// タイル取得側と二重管理になり、地域によって挙動が食い違う不具合の温床になっていた)。
// 全地域共通のタイル取得に一本化し、伊勢原も他の場所と同じ経路で埋まっていくようにする
// (代わりに、伊勢原の起動直後はOverpassからタイルが届くまで建物が疎な状態になる)。

// モード切替リロード(VISUAL_MODES切替ボタン、part1.js)での再開先が原点から遠い場合、
// jumpToLatLon(part7.js)の遠距離ジャンプと同じ理由(float32精度によるちらつき対策)で
// 原点を付け替える。ここはページの再読み込み直後(フレッシュな実行環境)なので、
// jumpToLatLonのように「保存してリロード」する必要はなく、その場で付け替えるだけでよい。
// queuedTiles/roadReadyTilesは旧原点基準のタイル座標系で登録されているため、
// 付け替えたら必ずclearする(でなければ新しい地域なのに「タイル取得済み」と誤判定されて
// 何も新しく読み込まれない。jumpToLatLonの遠距離ジャンプで実機確認済みの不具合と同じ原因)。
function recenterForResumeIfFar(lat, lon) {
  const dist = Math.hypot((lon - MID_LON) * SCALE * COS_LAT, (lat - MID_LAT) * SCALE);
  if (dist > RECENTER_DIST_M) {
    recenterOrigin(lat, lon);
    queuedTiles.clear();
    roadReadyTiles.clear();
    return true;
  }
  return false;
}

// プレイヤーの初期位置決定(モード切替/遠方ジャンプからの再開 or 通常起動のスポーン地点)と、
// 国コード(currentCountryCode)の早期取得だけを行う。道路・建物・landuse等の実際の生成は
// 一切ここでは行わず、initialWorldLoaded=trueにした直後からpart8.jsのタイル取得システムが
// プレイヤー周辺タイルを取りに行く(伊勢原・東京・NY等、全地域で同じ経路)。
async function loadOSM() {
  const resume = consumeResumePos();
  if (resume) recenterForResumeIfFar(resume.lat, resume.lon);
  const lat = resume ? resume.lat : SPAWN_LAT;
  const lon = resume ? resume.lon : SPAWN_LON;
  const rp = latLonToXZ(lat, lon);
  // 通常起動時のみ findSpawnNear で建物内スポーンを避ける(この時点ではタイルが
  // 何も届いていないため実質ノーオペだが、フォールバック生成等が先に走っていた場合の保険)。
  // resume(モード切替/遠方ジャンプ)は元の座標そのものへ戻す。
  const sp = resume ? rp : findSpawnNear(rp.x, rp.z);
  player.position.set(sp.x, 0, sp.z);
  if (resume) {
    if (typeof resume.yaw === 'number') camYaw = resume.yaw;
    if (typeof resume.rot === 'number') player.rotation.y = resume.rot;
  }
  // 【重要】国別建物スタイル(currentCountryCode)は通常checkAddressDisplayのスロットル
  // (初期化後10秒/150m)任せだが、initialWorldLoaded=trueにした直後からcheckOSMTiles
  // (part8.js)がすぐにタイル取得を始めてしまう。Nominatim逆ジオコーディングが完了する前に
  // 最初に見える範囲の建物が生成されると、currentCountryCode=nullのまま焼き込まれて
  // 国別プロファイル(denseHighRise等)が二度と効かなくなる(実機検証: ニューヨークの都心が
  // 低層住宅だらけになる原因の一つ)。スロットルを待たず即座に取得を開始し、最大1.5秒だけ
  // 完了を待つ(ブロッキングは短時間に限定し、Nominatim不調時は諦めて先に進む)。
  showToast('🗺 マップを読み込み中...', { sticky: true });
  awaitingDestinationLoad = true;
  await Promise.race([
    updateAddressDisplay(),
    new Promise(res => setTimeout(res, 1500)),
  ]);
  initialWorldLoaded = true; // ここからタイル取得を許可(標高は既に反映済み)。森は updateForest が周囲に描く
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

// 【重要】起動ブートストラップIIFE(loadNearTerrain/loadOSM等を呼ぶ処理)は、
// 元は単一スクリプトの関数巻き上げにより「定義がテキスト上どこにあっても」動いていたが、
// ファイル分割後は script タグをまたいだ巻き上げが効かない。このIIFEはloadNearTerrain経由で
// xzToLatLon(part7.js)を同期的に呼ぶため、part7を読み込み終える前に実行されると
// ReferenceErrorで停止してしまう(実際に発生した不具合)。全ファイル読み込み後に
// 確実に実行されるよう、このIIFE本体は js/legacy/part9.js の末尾に移動した。
// (getStartLocation/TOKYO_STATION はこのファイルの他の関数から参照されないためここに残す)
