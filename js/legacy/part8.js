/**
 * legacy/part8.js — index.html の巨大インラインスクリプトを行範囲のまま機械的に切り出した
 * ファイル(8/9)。part7.js の続き。詳細は part1.js 冒頭のコメント参照。
 */
// ======= TILE-BASED DYNAMIC OSM FETCHING =======
// Overpassの公開サーバーは(プロキシ側で守っている)実質1リクエスト/秒程度の上限があり、
// これはタイルをどれだけ並行リクエストしても変わらない(サーバー側でホスト単位に直列化されるため)。
// つまり「1秒間に処理できるタイル数」はほぼ固定で、稼げるのは「1タイルでカバーする面積」だけ。
// 以前は700m→1100m四方だったが、ダッシュ(最大45m/s)や地図ジャンプでの新規エリア
// カバーがまだ追いつかない場合があった。overpass-api.deへは server/server.js 側の
// scheduleUpstream が「1ホストにつき1.1秒間隔」で直列化しており、これはポリシー
// 遵守のため下げられない固定の下限。そのためスループットを上げる唯一の手段は
// 「1リクエストでカバーする面積を広げる」こと。1600mへ拡大し、同じ範囲を埋めるのに
// 必要なリクエスト数自体を減らす(面積比で1100m時の約2.1倍/リクエストをカバー)。
const OSM_TILE_M = 1600;
const fetchedOSMTiles = new Set();   // キュー投入済み(取得中 or 取得完了)のタイル
const loadedOSMTiles = new Set();    // 実際に処理が完了した(道路が確定した)タイル。
                                      // 「地形→道路→建物→木」の順を守るため、チャンクの
                                      // 建物生成はこれで判定してカバー範囲のタイルを待つ。
const osmTileQueue = [];
// タイル取得の同時実行数。以前は1件ずつ完全直列だったため、ダッシュ(最大45m/s)で
// 移動すると描写エリアの拡大がまったく追いつかず、未読み込みの端に突き当たっていた。
// 一方で4は欲張りすぎで、遠景地形の高解像度化(WIDE_SEGS増)による大量リクエストと
// 重なった際にプロキシ/サーバーを詰まらせていたため2に落とした経緯がある。
// その後「上流へは結局サーバー側が1.1秒間隔で直列化するので3に戻して問題ない」という
// 判断で3に上げていたが、これはプロキシ経由(ローカル/プロキシ健在時)の前提。
// Render等でプロキシが上流に5xxされて直接アクセスにフォールバックした場合、
// サーバー側の直列化は効かず、Overpass側の実際の同時実行枠(公式に2/IPと明言されている。
// 2026年時点でもgall/lambertの2台がそれぞれ独立してrate limit=2を課している)に直接ぶつかる。
// 3のままだと3本目が恒常的に429になり、バックオフ待ち(最大30秒)が積み重なって
// 「道路が読み込まれない/ものすごく時間がかかる」の主因になっていた。実際の上限に合わせて2に戻す。
const OSM_TILE_CONCURRENCY = 2;
let osmTileActiveCount = 0;
const osmTileFailCount = new Map(); // タイルごとの失敗回数(3回まで再試行)
// 【重要】標高データ+初期OSMのロード完了までタイル取得を止めるゲート。
// 以前は起動直後からタイル取得が走り、標高ロード(約8秒)より先に完了した
// 境界タイルの道路が「平坦な地面の高さ」で生成され、その後地形が持ち上がると
// 地面の下に埋まって「道路がスパッと途切れる」症状になっていた。
// (ミニマップには道路が残るのに3Dでは見えない、という報告と厳密に一致する)
let initialWorldLoaded = false;
const seenOSMWays = new Set();      // 処理済みway ID(タイル境界をまたぐ要素の二重生成防止)
const pendingBuildings = [];        // タイル取得分の建物はフレーム分割して生成
let pendingBuildingIdx = 0;

// 駅ランドマーク。以前は初期ロード(loadOSM)時にしか処理しておらず、タイル取得側の
// クエリにも駅ノードが含まれていなかったため、初期範囲の外にある駅(愛甲石田以外)が
// 一切表示されなかった。初期ロード・タイル取得の両方から呼べる共通関数にする。
const seenStations = new Set();
function processStationNodes(elements) {
  if (USES_MEIJI_LANDUSE) return; // 明治・江戸: 鉄道開通前なので駅なし
  elements.forEach(el => {
    if (el.type !== 'node' || !el.tags) return;
    const isStation = el.tags.railway === 'station' || el.tags.railway === 'halt' || el.tags.public_transport === 'station';
    if (!isStation) return;
    const name = el.tags.name || el.tags['name:ja'] || '駅';
    if (seenStations.has(name)) return;
    seenStations.add(name);
    const pos = latLonToXZ(el.lat, el.lon);
    addStation(pos.x, pos.z, name);
  });
}

// Mark tiles that the initial loadOSM already covered (OSM_BOUNDS rectangle)
// タイルが初期範囲に「完全に」含まれる場合のみ取得済み扱いにする。
// 以前は境界に部分的にかかるタイルも取得済み扱いになり、範囲外部分が
// 永久に歯抜けになっていた(境界沿いで道路・建物が途切れる主因)。
// 重複ロードは seenOSMWays のway ID重複排除で防ぐ。
(function markInitialTiles() {
  const pt1 = latLonToXZ(OSM_BOUNDS.minLat, OSM_BOUNDS.minLon);
  const pt2 = latLonToXZ(OSM_BOUNDS.maxLat, OSM_BOUNDS.maxLon);
  const x0 = Math.min(pt1.x, pt2.x), x1 = Math.max(pt1.x, pt2.x);
  const z0 = Math.min(pt1.z, pt2.z), z1 = Math.max(pt1.z, pt2.z);
  for (let tx = Math.floor(x0/OSM_TILE_M); tx <= Math.floor(x1/OSM_TILE_M); tx++)
    for (let tz = Math.floor(z0/OSM_TILE_M); tz <= Math.floor(z1/OSM_TILE_M); tz++) {
      if (tx*OSM_TILE_M >= x0 && (tx+1)*OSM_TILE_M <= x1 &&
          tz*OSM_TILE_M >= z0 && (tz+1)*OSM_TILE_M <= z1) {
        const k = `${tx},${tz}`;
        fetchedOSMTiles.add(k);
        loadedOSMTiles.add(k); // 初期loadOSM()で道路も既に確定済み
      }
    }
})();

function processTileData(data, tileCount) {
  if (!data || !data.elements) return;
  // このバッチ(tileCount枚のタイル分、1枚=OSM_TILE_M四方)の実測建物密度を先に見て、
  // 国プロファイルより高層寄りに上書きするか一度だけ決める(part6.js PASS-2と同じ考え方。
  // 「USも高密度地帯は高層ビルにして」への対応 — 国単位の固定ルールだけでは同じ国の中の
  // 都心部と郊外の違いを表現できないため、実測の建物密度で判定する)。
  const cprofH8Base = MODE === 'real' ? getCountryBuildingProfile(currentCountryCode) : null;
  const cprofH8Batch = MODE === 'real'
    ? applyLocalDensityOverride(cprofH8Base, estimateFootprintAreaM2(data.elements), (tileCount || 1) * OSM_TILE_M * OSM_TILE_M)
    : null;
  // 駅ランドマーク(初期範囲の外にある駅も、タイルが届いた時点でここで拾う)
  processStationNodes(data.elements);
  // Roads
  data.elements.forEach(el => {
    if (el.type !== 'way' || !el.geometry || el.geometry.length < 2) return;
    if (seenOSMWays.has(el.id)) return; // 隣接タイル/初期ロードで処理済み
    const tags = el.tags || {};
    if (tags.highway) {
      const hw = tags.highway;
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
    }
    if (!USES_MEIJI_LANDUSE && tags.railway === 'rail') {
      for (let i = 0; i < el.geometry.length-1; i++) {
        const a = latLonToXZ(el.geometry[i].lat, el.geometry[i].lon);
        const b = latLonToXZ(el.geometry[i+1].lat, el.geometry[i+1].lon);
        addRoad(a.x, a.z, b.x, b.z, 4, 'railway');
      }
    }
    if (tags.waterway && tags.waterway !== 'riverbank') {
      const ww = waterwayWidth(tags);
      for (let i = 0; i < el.geometry.length-1; i++) {
        const a = latLonToXZ(el.geometry[i].lat, el.geometry[i].lon);
        const b = latLonToXZ(el.geometry[i+1].lat, el.geometry[i+1].lon);
        addRoad(a.x, a.z, b.x, b.z, ww, 'water');
      }
    }
  });
  // 公園・水域・田畑・森 + multipolygon水面
  data.elements.forEach(el => {
    if (el.type === 'relation') { processWaterRelation(el); return; } // 重複はrel側のSetで防止
    if (el.type === 'way' && el.id && seenOSMWays.has(el.id)) return;
    handleAreaFeature(el);
  });
  // Buildings — 直接生成せずキューに積み、フレーム分割して生成する
  // (以前は1タイル分の建物を1フレームで同期生成し、大きなカクつきの原因だった)
  data.elements.forEach(el => {
    if (el.type !== 'way' || !el.geometry || el.geometry.length < 4) return;
    if (seenOSMWays.has(el.id)) return;
    const tags = el.tags || {};
    // 学校・大学・病院は、校舎そのものにbuildingタグが無く敷地全体(amenity)しか
    // マッピングされていないケースが多い。その場合も敷地の中心に代表的な校舎を1棟建てる。
    const isCampusOnly = !USES_MEIJI_LANDUSE && !tags.building &&
      ['school','university','college','hospital'].includes(tags.amenity || '');
    if (!tags.building && !isCampusOnly) return;
    if (USES_MEIJI_LANDUSE && tags.building) {
      // 実際には描画しないが、密度ヒントとして棟数だけ数えておく(フィルタで捨てる前に)
      const p0 = latLonToXZ(el.geometry[0].lat, el.geometry[0].lon);
      noteModernBuilding(p0.x, p0.z);
    }
    if (USES_MEIJI_LANDUSE) { // 明治・江戸: 神社仏閣以外のOSM建物は出さない(手続き生成に任せる)
      const st = getBuildingStyle(tags);
      if (!st || (st.type !== 'shrine' && st.type !== 'temple')) return;
    }
    const pts = el.geometry.map(g => latLonToXZ(g.lat, g.lon));
    let cx=0, cz=0;
    pts.forEach(p => { cx+=p.x; cz+=p.z; });
    cx/=pts.length; cz/=pts.length;
    let maxDx=0, maxDz=0;
    pts.forEach(p => { maxDx=Math.max(maxDx,Math.abs(p.x-cx)); maxDz=Math.max(maxDz,Math.abs(p.z-cz)); });
    let w=Math.max(maxDx*2,2), d=Math.max(maxDz*2,2);
    if (isCampusOnly) { w = Math.min(w, 34); d = Math.min(d, 22); } // 敷地全体でなく校舎サイズに収める
    let style = getBuildingStyle(tags);
    if (MODE === 'edo' && shouldSkipEdoBuilding(style)) return; // 江戸: 現代の建物密度をそのまま使わず間引く
    const resolvedH = resolveBuildingHeight(tags);
    // 国プロファイルの階数フォールバック・最低階数floor(part6.js PASS-2と同じロジック)。
    // 【重要】ここ(part8.js)はプレイヤーが移動して新しいOSMタイルを取得するたびに
    // 呼ばれる経路で、part6.js側だけに国プロファイルを配線していたため、ジャンプ直後の
    // 初期範囲を過ぎて歩き回った先の建物には反映されていなかった(香港で歩き続けると
    // 低層タグの建物がまた出る不具合の原因)。
    const cprofH8 = cprofH8Batch;
    const [lvMin8, lvMax8] = (cprofH8 && cprofH8.levelsRange) || [1, 3];
    const levels = parseInt(tags['building:levels']) || (lvMin8 + Math.floor(Math.random() * (lvMax8 - lvMin8 + 1)));
    let h = resolvedH != null ? resolvedH : Math.max(levels*3,3)+Math.random()*2;
    h = applyLandmarkMinHeight(style, h); // 学校・病院・役場・神社仏閣は最低限の高さを確保
    const _landmarkType8 = style && (style.type === 'shrine' || style.type === 'temple' || style.type === 'church');
    if (cprofH8 && cprofH8.minLevels && !_landmarkType8) {
      h = Math.max(h, cprofH8.minLevels * 3);
    }
    style = classifyResidential(style, w, d, h);
    let fw = w, fd = d, fh = h;
    ({ w: fw, d: fd, h: fh } = applySizeFloor(style, w, d, h)); // マンション・工場は最低サイズを底上げ
    if (MODE === 'edo') fh = applyEdoHeightCap(style, fh); // 江戸: 現代建物の実測高さそのままだと高層ビルになるため木造家屋相当に抑える
    pendingBuildings.push({ x: cx, z: cz, w: fw, d: fd, h: fh, style, real: true });
  });
  // Landuse polygons for chunk system
  data.elements.forEach(el => {
    if (el.type !== 'way' || !el.geometry || el.geometry.length < 4) return;
    if (seenOSMWays.has(el.id)) return;
    const tags = el.tags || {};
    const lu = tags.landuse;
    if (!lu || !['residential','commercial','industrial','retail','mixed_use'].includes(lu)) return;
    const pts = el.geometry.map(g => latLonToXZ(g.lat, g.lon));
    let minX=Infinity, maxX=-Infinity, minZ=Infinity, maxZ=-Infinity;
    pts.forEach(p => { minX=Math.min(minX,p.x); maxX=Math.max(maxX,p.x); minZ=Math.min(minZ,p.z); maxZ=Math.max(maxZ,p.z); });
    const _luEntry = { pts, lu, minX, maxX, minZ, maxZ };
    landusePolygons.push(_luEntry);
    polyGridAdd(landuseGrid, _luEntry);
  });
  // 最後にway IDを記録(カテゴリ別の3パスが終わってから)
  data.elements.forEach(el => { if (el.type === 'way') seenOSMWays.add(el.id); });
}

// キューに空きワーカー枠がある限り、並行してタイルを取得していく
// (以前は1件処理→待機→次の1件、という完全直列で、高速移動時に描写エリアの
//  拡大が追いつかなかった)
function processOSMTileQueue() {
  while (osmTileActiveCount < OSM_TILE_CONCURRENCY && osmTileQueue.length > 0) {
    osmTileActiveCount++;
    fetchOSMTileBatch();
  }
}

// Overpassクエリの各条件節(bboxを後から差し込むテンプレート)。
// 1タイル分の絞り込み条件を、まとめて取得するタイルの数だけ繰り返して1クエリにする。
const OSM_TILE_CLAUSES = [
  'way["highway"]',
  'way["building"]',
  'way["landuse"~"residential|commercial|industrial|retail|mixed_use|farmland|orchard|meadow|allotments|forest"]',
  'way["leisure"~"park|garden|playground"]',
  'way["natural"~"water|wood"]',
  'way["waterway"~"river|stream|canal|riverbank"]',
  'relation["natural"="water"]',
  'relation["waterway"="riverbank"]',
  'way["railway"="rail"]',
  'node["railway"="station"]',
  'node["railway"="halt"]',
  'node["public_transport"="station"]',
  // 学校・大学・病院の敷地(校庭・構内に手続き生成の家を置かないための回避ゾーン用)
  'way["amenity"~"school|university|college|hospital"]',
];
// 1リクエストにまとめる最大タイル数。スポーン直後・地図ジャンプ直後・急旋回時は
// 一度に何十枚も新規タイルが必要になるが、Overpassは1ホスト1.1秒間隔の直列制限
// (server.js)のため「1タイル=1リクエスト」だと平常時の10〜数十倍待たされていた。
// Overpass QLは (clause(bbox1);clause(bbox2);...) のようにbboxをunionで束ねて
// 1クエリに収められるので、近い順に最大6枚まとめて1往復で取得する。
const OSM_TILE_BATCH = 6;
function buildOSMBatchQuery(bboxes) {
  const parts = [];
  for (const clause of OSM_TILE_CLAUSES) for (const bb of bboxes) parts.push(clause + '(' + bb + ');');
  const timeout = Math.min(60, 20 + bboxes.length * 6); // タイル数に応じて上流タイムアウトも延ばす
  return `[out:json][timeout:${timeout}];(${parts.join('')});out geom;`;
}

async function fetchOSMTileBatch() {
  // プレイヤーに近いタイルを優先(以前はキュー投入順で、進行方向の
  // タイルが後回しになり目の前で道路が途切れたまま待たされていた)
  const ptx = player.position.x / OSM_TILE_M, ptz = player.position.z / OSM_TILE_M;
  osmTileQueue.sort((a, b) =>
    (Math.abs(a.tx + 0.5 - ptx) + Math.abs(a.tz + 0.5 - ptz)) -
    (Math.abs(b.tx + 0.5 - ptx) + Math.abs(b.tz + 0.5 - ptz)));
  // ジャンプ直後(現在地のタイルすら未確定)は、まず1枚だけの小さいクエリで最速で足元の
  // 道路・建物を出す。6枚まとめの大クエリはOverpass側の実行に20〜40秒かかるため、
  // ジャンプ後「道路が出るまで1〜2分」の主因だった(同時実行枠は1IPあたり2つしかない)。
  // 現在地のタイルが確定したら、従来どおり6枚まとめで効率よく外側を埋める。
  const ptKey = `${Math.floor(player.position.x / OSM_TILE_M)},${Math.floor(player.position.z / OSM_TILE_M)}`;
  const batch = osmTileQueue.splice(0, loadedOSMTiles.has(ptKey) ? OSM_TILE_BATCH : 1); // 近い順
  const keys = batch.map(({tx, tz}) => `${tx},${tz}`);
  const bboxes = batch.map(({tx, tz}) => {
    const worldX0 = tx * OSM_TILE_M, worldZ0 = tz * OSM_TILE_M;
    const ll00 = xzToLatLon(worldX0, worldZ0);
    const ll11 = xzToLatLon(worldX0 + OSM_TILE_M, worldZ0 + OSM_TILE_M);
    const minLat = Math.min(ll00.lat, ll11.lat), maxLat = Math.max(ll00.lat, ll11.lat);
    const minLon = Math.min(ll00.lon, ll11.lon), maxLon = Math.max(ll00.lon, ll11.lon);
    return `${minLat.toFixed(5)},${minLon.toFixed(5)},${maxLat.toFixed(5)},${maxLon.toFixed(5)}`;
  });
  const query = buildOSMBatchQuery(bboxes);
  let failed = false;
  try {
    // 【重要】ブラウザ→Overpass直接アクセス時(プロキシ迂回フォールバック)はサーバー側の
    // 45秒タイムアウトが効かないため、ハングしたリクエストがこのワーカー枠を永久に塞ぐ。
    // クライアント側でも50秒で見切る(失敗扱い→既存のバックオフ・再試行に乗る)。
    const res = await Promise.race([
      fetch('https://overpass-api.de/api/interpreter?data=' + encodeURIComponent(query)),
      new Promise((_, rej) => setTimeout(() => rej(new Error('timeout')), 50000))
    ]);
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    if (!data || !data.elements) throw new Error('no elements');
    // 複数タイル分の要素が1つの配列で混ざって届くが、seenOSMWaysでway ID重複排除される
    // ので、1タイルの時と同じ processTileData にそのまま渡してよい。密度計算用にタイル枚数も渡す。
    processTileData(data, batch.length);
    keys.forEach(k => {
      osmTileFailCount.delete(k);
      loadedOSMTiles.add(k); // このタイルの道路が確定 → 建物生成待ちのチャンクを解放してよい
    });
    // 遠方ジャンプ後、伊勢原の初期ワールド構築をスキップした再開(part6.js loadOSM参照)では
    // 「目的地の地図を読み込み中...」のstickyトーストを出したまま。プレイヤーの現在地タイルが
    // 届いた時点で、これを完了メッセージに差し替える(でなければ静的プレースホルダのまま残る)。
    if (awaitingDestinationLoad && keys.includes(ptKey)) {
      awaitingDestinationLoad = false;
      showToast('✨ 目的地の地図を表示しました', { duration: 3000 });
    }
  } catch(e) {
    // 以前は3回失敗すると完全に諦めて二度と再試行しなかったため、Overpassが一時的に
    // 混雑していただけの場合でも「その区画だけ永久に道路が途切れる」ことがあった。
    // → 諦めきらず、間隔を伸ばしながら背景でずっと再試行し続ける。
    // (3回失敗した時点では建物生成だけ先に進めてよい扱いにし、後から道路が届いたら反映される)
    failed = true;
    keys.forEach(k => {
      const n = (osmTileFailCount.get(k) || 0) + 1;
      osmTileFailCount.set(k, n);
      if (n >= 4) loadedOSMTiles.add(k); // これ以上は建物生成をブロックしない(道路は背景で取得を続ける)
      fetchedOSMTiles.delete(k); // 常に再試行対象に戻す(checkOSMTiles が再度キューに積む)
    });
    // 現在地タイルが4回失敗して「諦めて先に進む」扱いになった場合も、sticky状態のトーストを
    // 出しっぱなしにしない(Overpass不調が長引くと「目的地の地図を読み込み中...」が永久に残るため)。
    if (awaitingDestinationLoad && loadedOSMTiles.has(ptKey)) {
      awaitingDestinationLoad = false;
      showToast('⚠️ 目的地の地図取得が一部失敗しました(背景で再試行を続けます)', { duration: 4000 });
    }
  }
  // 失敗するたびに待ち時間を延ばす(最大30秒)。連続失敗中の無駄な連打を防ぎつつ、
  // 一時的な混雑が収まれば自動的に復帰して歯抜けが埋まる。
  // (成功時はプロキシ側で既にレート制限済みなので、このワーカーはすぐ次のバッチへ)
  const maxN = keys.reduce((m, k) => Math.max(m, osmTileFailCount.get(k) || 0), 0);
  await new Promise(r => setTimeout(r, failed ? Math.min(30000, 3000 * maxN) : 200));
  osmTileActiveCount--;
  processOSMTileQueue(); // この枠が空いたので、キューに残りがあれば次を拾う
}

let _osmCheckFrame = 0;
let _osmLastPx = null, _osmLastPz = null;
function checkOSMTiles() {
  if (!initialWorldLoaded) return; // 標高+初期OSMが揃うまで開始しない(高さ競合防止)
  _osmCheckFrame++;
  if (_osmCheckFrame % 30 !== 0) return; // ~0.5秒ごと(移動中の追随を速める)
  const px = player.position.x, pz = player.position.z;
  // 明治・江戸: プレイヤー周辺の二次メッシュ土地利用データも必要に応じて追加取得
  if (USES_MEIJI_LANDUSE) {
    [[-1500,-1500],[1500,-1500],[-1500,1500],[1500,1500]].forEach(([ox,oz]) => {
      const c = xzToLatLon(px + ox, pz + oz);
      loadMeijiMesh(c.lat, c.lon);
    });
  }
  // 進行方向を推定(直前チェックからの移動)
  let fdx = 0, fdz = 0;
  if (_osmLastPx !== null) { fdx = px - _osmLastPx; fdz = pz - _osmLastPz; }
  _osmLastPx = px; _osmLastPz = pz;
  const queueTile = (wx, wz) => {
    const tx = Math.floor(wx / OSM_TILE_M), tz = Math.floor(wz / OSM_TILE_M);
    const key = `${tx},${tz}`;
    if (!fetchedOSMTiles.has(key)) { fetchedOSMTiles.add(key); osmTileQueue.push({ tx, tz }); }
  };
  // 周囲7x7(±約4.8km。OSM_TILE_M拡大に伴い先読み範囲も自動的に広がる)を先読み。
  // 道路・建物データは建物生成(±360m)より広い範囲で先に用意する
  for (let dx = -3; dx <= 3; dx++)
    for (let dz = -3; dz <= 3; dz++)
      queueTile(px + dx * OSM_TILE_M, pz + dz * OSM_TILE_M);
  // 進行方向にさらに先まで先読み(移動中に描写の端へぶつからないように)
  const flen = Math.hypot(fdx, fdz);
  if (flen > 1) {
    const ux = fdx / flen, uz = fdz / flen, perpx = -uz, perpz = ux;
    for (let k = 4; k <= 6; k++)
      for (let s = -1; s <= 1; s++)
        queueTile(px + (ux * k + perpx * s) * OSM_TILE_M, pz + (uz * k + perpz * s) * OSM_TILE_M);
  }
  if (osmTileQueue.length > 0) processOSMTileQueue(); // 空きワーカー枠がある分だけ内部で処理される
}

// ======= CHUNK-BASED DYNAMIC BUILDING GENERATION =======
function generateChunk(chunkX, chunkZ) {
  // 旧: landusePolygons.length===0 でガードしていたが、landuse必須をやめたため
  // 本来の意図どおり「初期ロード完了」を条件にする(landuse皆無の地域でも生成できる)
  if (USES_MEIJI_LANDUSE ? !meijiReady : !initialWorldLoaded) return;
  const key = `${chunkX},${chunkZ}`;
  currentChunkKey = key; // addBuilding が記録に掃除用タグを付ける
  const worldX = chunkX * CHUNK_SIZE;
  const worldZ = chunkZ * CHUNK_SIZE;

  const beforeCount = scene.children.length; // snapshot to track added meshes

  const x0 = worldX, z0 = worldZ, x1 = worldX + CHUNK_SIZE, z1 = worldZ + CHUNK_SIZE;
  // チャンク周辺のポリゴンだけに絞る(以降の判定を軽く)。
  // 【重要】以前はavoidPolygons/landusePolygons(取得済み全件。増え続けて減らない)を
  // 毎回.filter()で全件走査していたため、探索が進むほどチャンク生成コストが際限なく
  // 悪化していた(長時間プレイでの重量化の主因の一つ)。空間ハッシュで近傍だけ拾う。
  const nearAvoid = queryPolyGrid(avoidGrid, x0, x1, z0, z1);
  const inAvoid = (x, z) => nearAvoid.some(p =>
    x >= p.minX && x <= p.maxX && z >= p.minZ && z <= p.maxZ && pointInPolygon(x, z, p.pts));
  const nearLanduse = queryPolyGrid(landuseGrid, x0 - 30, x1 + 30, z0 - 30, z1 + 30);
  const inLanduse = (x, z) => nearLanduse.some(p =>
    x >= p.minX && x <= p.maxX && z >= p.minZ && z <= p.maxZ && pointInPolygon(x, z, p.pts));
  // その地点がどのlanduse区画に属するか(無ければnull)。一戸建て補完(buildable)が
  // 工場・倉庫・商業地の敷地内にまで一戸建てを建ててしまわないよう、区画の種別を見分けるのに使う。
  const luTypeAt = (x, z) => {
    for (const p of nearLanduse) {
      if (x < p.minX || x > p.maxX || z < p.minZ || z > p.maxZ) continue;
      if (pointInPolygon(x, z, p.pts)) return p.lu;
    }
    return null;
  };

  if (USES_MEIJI_LANDUSE) {
    // ======= 明治・江戸: 迅速測図の100m土地利用グリッドに従って生成 =======
    // (現代の道路密度から住宅街を推定して埋める後段の手続き生成は、現代の建物密度を
    //  そのまま持ち込んでしまうため使わない。江戸は明治より低密度になるよう
    //  generateMeijiCells 側で間引く。)
    generateMeijiCells(x0, z0, x1, z1, inAvoid);
  } else {

  // --- 0) 細街路の密度から「住宅街」を推定 ---
  // 伊勢原郊外はOSMのlanduseタグが未登録のエリアが多く、「landuse内のみ生成」だと
  // ミニマップに細街路が網の目状にあるのに家が1軒も建たない(スカスカの主因)。
  // チャンク近傍の細街路(road/tertiary)の総延長が閾値以上なら住宅街とみなし、
  // landuse未登録でも回避ポリゴン(田畑・森・公園・水域)の外なら補完する。
  // 山道など単独の1本道は延長が閾値に届かないので家は並ばない。
  const nearMinor = [];
  let minorLen = 0;
  // 単純な1本道の延長(山道など)を住宅街と誤認しないよう、道の向き(180°を4分割)も見て、
  // 実際に格子状(=複数方向の道が交差)になっている場合だけ密集地とみなす。
  const dirBuckets = new Set();
  // 【重要】以前はminimapRoads(取得済み全道路。増え続けて減らない)を毎回全件走査していた。
  // チャンク生成のたびに走る頻出パスなので空間ハッシュで近傍だけ拾う。
  for (const r of queryRoadGrid(x0 - 40, x1 + 40, z0 - 40, z1 + 40)) {
    if (r.type !== 'road' && r.type !== 'tertiary') continue;
    if (Math.max(r.x1, r.x2) < x0 - 40 || Math.min(r.x1, r.x2) > x1 + 40 ||
        Math.max(r.z1, r.z2) < z0 - 40 || Math.min(r.z1, r.z2) > z1 + 40) continue;
    nearMinor.push(r);
    const mx = (r.x1 + r.x2) / 2, mz = (r.z1 + r.z2) / 2;
    if (mx >= x0 - 20 && mx < x1 + 20 && mz >= z0 - 20 && mz < z1 + 20) {
      minorLen += Math.min(CHUNK_SIZE, Math.hypot(r.x2 - r.x1, r.z2 - r.z1));
      let ang = Math.atan2(r.z2 - r.z1, r.x2 - r.x1);
      if (ang < 0) ang += Math.PI; // 向きは180°で一周(逆向きは同じ道なり)
      dirBuckets.add(Math.min(3, Math.floor(ang / (Math.PI / 4))));
    }
  }
  // 近隣(300m以内)に既知のlanduse=residentialがあれば、密度条件を満たさなくても住宅街とみなす
  // (住宅地の縁で細街路がまだ疎な場合の取りこぼし対策)。
  const cx0 = (x0 + x1) / 2, cz0 = (z0 + z1) / 2;
  let hasResidentialNearby = false;
  for (const p of queryPolyGrid(landuseGrid, cx0 - 300, cx0 + 300, cz0 - 300, cz0 + 300)) {
    if (p.lu === 'residential') { hasResidentialNearby = true; break; }
  }
  // 単純な1本道の延長では住宅街と誤認しないよう、格子状(2方向以上)であることも要求する。
  // 閾値も200→250に引き上げ、判定を厳しくした。
  // さらに、道路グリッドだけでは農地の農道(格子状に見える畦道)を住宅街と誤認するため、
  // landuse=residentialが近くにある「か」実OSM建物(手続き生成でない本物)が近くに
  // 実在するかのどちらかを裏付けとして要求する(道の形だけでは家を建てさせない)。
  const roadGridLooksResidential = minorLen >= 250 && dirBuckets.size >= 2 &&
    hasRealBuildingNearby(cx0, cz0, 150);
  const denseArea = hasResidentialNearby || roadGridLooksResidential;
  // 【重要】以前はdenseAreaが「チャンク全体(120m四方)」単位のフラグで、チャンクの
  // どこか1箇所でも住宅街の条件を満たせば、そのチャンク内の道路沿い全部が「建築可」
  // 扱いになっていた。このため住宅地の縁にある田畑・空き地・農道にまで一戸建てが
  // 伸びてしまっていた。ここを「候補地点それ自体」の根拠(実際にlanduse=residential等の
  // 区画内にあるか、近く(60m以内)に本物のOSM建物が既に建っているか)で判定するよう厳格化する。
  // denseAreaはチャンク全体のフラグとして残し、3)の充填ループに入るかどうかの粗い足切り
  // (探索コスト削減)にだけ使う。
  // 【重要】buildable()は「一戸建て(house)」専用の補完なので、landuseが工場・倉庫(industrial)
  // 商業(commercial/retail/mixed_use)の区画内では、たとえ道路やlanduseポリゴンの条件を
  // 満たしても一戸建てを建てない。以前はinLanduse()が「residential/commercial/industrial/
  // retail/mixed_useのどれかに入っていればtrue」という判定だったため、工場の敷地内を走る
  // 構内道路沿いにまで一戸建てが並んでいた(2)の区画内グリッド充填は種別ごとに適切な
  // スタイルを選んでいるので影響なし、ここで絞るのは1)/3)の一戸建て限定パスだけ)。
  const NON_HOUSE_LU = new Set(['industrial', 'commercial', 'retail', 'mixed_use']);
  // 判定の優先順位:
  //  1) inAvoid → 田畑・山林・公園・水域には絶対に建てない
  //  2) landuseがindustrial/commercial/retail/mixed_use → 工場・商業地には建てない
  //  3) landuse=residential → 建ててよい(実データの裏付けあり)
  //  4) 近く(60m)に本物の(工場・店舗でない)建物がある → 建ててよい
  //  5) landuseタグが一切無い(lu===null。1)で回避対象でもない)土地に限り、
  //     周辺の道路が格子状+近くに実建物があるというチャンク単位の状況証拠(denseArea)
  //     を根拠に補完してよいことにする。工場・商業・農地・山林・公園・水域は1)2)で
  //     既に弾かれているので、ここが誤って工場等に効くことはない。
  const buildable = (qx, qz) => {
    if (inAvoid(qx, qz)) return false;
    const lu = luTypeAt(qx, qz);
    if (lu && NON_HOUSE_LU.has(lu)) return false;
    if (lu === 'residential') return true;
    if (hasRealHouseNearby(qx, qz, 60)) return true;
    return lu === null && denseArea;
  };
  // 細街路から maxD 以内か(奥地の空き野原まで埋めないためのガード)
  const nearMinorRoad = (qx, qz, maxD) => {
    for (const r of nearMinor) {
      const ddx = r.x2 - r.x1, ddz = r.z2 - r.z1;
      const l2 = ddx * ddx + ddz * ddz;
      if (l2 < 0.01) continue;
      const t = Math.max(0, Math.min(1, ((qx - r.x1) * ddx + (qz - r.z1) * ddz) / l2));
      const nx2 = r.x1 + t * ddx - qx, nz2 = r.z1 + t * ddz - qz;
      if (nx2 * nx2 + nz2 * nz2 < maxD * maxD) return true;
    }
    return false;
  };

  // --- 1) 道路沿いの住宅補完(日本の住宅街らしく道路に面してぎっしり並べる) ---
  // 敷地幅≈10m間隔で両側に並べ、奥の2列目・3列目にも生成(奥ほど生成率を下げ路地の抜けを残す)
  for (const r of nearMinor) {
    const dx = r.x2 - r.x1, dz = r.z2 - r.z1;
    const len = Math.sqrt(dx * dx + dz * dz);
    if (len < 12) continue;
    const px = -dz / len, pz = dx / len;
    const ROW_SKIP = [0.08, 0.2, 0.45]; // 列ごとの空き地率(手前ほど密)
    for (let s = 5; s < len - 4; s += 9.5 + Math.random() * 2) {
      for (const side of [-1, 1]) {
        for (let row = 0; row < 3; row++) {
          if (Math.random() < ROW_SKIP[row]) continue;
          const off = (r.rw || 4) / 2 + 4.2 + Math.random() * 1.5 + row * (11 + Math.random() * 2);
          const hx = r.x1 + dx * (s / len) + px * side * off;
          const hz = r.z1 + dz * (s / len) + pz * side * off;
          if (hx < x0 || hx >= x1 || hz < z0 || hz >= z1) continue; // このチャンク担当分のみ(二重生成防止)
          if (!buildable(hx, hz)) continue;
          const bw = 6.5 + Math.random() * 3, bd = 6 + Math.random() * 2.5;
          if (isOnRoad(hx, hz, bw, bd)) continue;
          if (hasBuildingNearby(hx, hz, Math.max(bw, bd) / 2 + 2.5)) continue; // 隣家との隙間は狭く
          const pal = HOUSE_PALETTE[(Math.random() * HOUSE_PALETTE.length) | 0];
          addBuilding(hx, hz, bw, bd, 3.5 + Math.random() * 3.5,
                      { color: pal.w, roofColor: pal.r, type: 'house' });
        }
      }
    }
  }

  // --- 2) 区画内のグリッド充填(道路沿いの列の隙間・奥地を中密度で埋める) ---
  for (const poly of nearLanduse) {
    const lu = poly.lu;
    const isRes = lu === 'residential';
    const isCom = lu === 'commercial' || lu === 'retail' || lu === 'mixed_use';
    const step     = isRes ? 14 : isCom ? 17 : 34;
    const fillRate = isRes ? 0.65 : isCom ? 0.65 : 0.5;

    for (let bx = worldX; bx < worldX + CHUNK_SIZE; bx += step) {
      for (let bz = worldZ; bz < worldZ + CHUNK_SIZE; bz += step) {
        if (!pointInPolygon(bx, bz, poly.pts)) continue;
        if (Math.random() > fillRate) continue;
        const jx = bx + (Math.random()-0.5)*step*0.4;
        const jz = bz + (Math.random()-0.5)*step*0.4;
        if (inAvoid(jx, jz)) continue; // 田畑・森・公園・水域は埋めない
        const bw = isRes ? 7+Math.random()*5 : isCom ? 12+Math.random()*14 : 25+Math.random()*25;
        const bd = isRes ? 6.5+Math.random()*4.5 : isCom ? 10+Math.random()*12 : 20+Math.random()*20;
        if (isOnRoad(jx, jz, bw, bd)) continue;
        if (hasBuildingNearby(jx, jz, Math.max(bw,bd)/2+1.5)) continue;
        // 住宅地はほぼ2階建て、たまに低層アパート(日本の郊外の実感に寄せる)
        const bh = isRes ? (Math.random() < 0.15 ? 8+Math.random()*6 : 4+Math.random()*3.5)
                 : isCom ? 8+Math.random()*16 : 6+Math.random()*8;
        let style = isRes
          ? { color:0xc8a060, roofColor:0x8a5828, type:'house' }
          : isCom
          ? { color:0xf09050, roofColor:0xb05020, type:'shop' }
          : { color:0x909898, roofColor:0x606868, type:'industrial' };
        style = classifyResidential(style, bw, bd, bh); // 高さ・面積が閾値超えならマンション扱いに
        const _f1 = applySizeFloor(style, bw, bd, bh); // マンション・工場は最低サイズを底上げ
        addBuilding(jx, jz, _f1.w, _f1.d, _f1.h, style);
      }
    }
  }

  // --- 3) landuse未登録の住宅街(細街路が密なチャンク)にもグリッド充填 ---
  // 道路から35m以内に限定して、道沿い列の隙間・角地を埋める(奥の野原は空けておく)。
  // 【重要】以前はチャンク単位のdenseAreaフラグ+道路近傍+回避ポリゴン外、という条件だけで
  // 生成しており、候補地点そのものが実際に住宅地かどうかは一切見ていなかった。denseAreaが
  // (住宅地の縁の田畑を通る農道などで)誤って立った場合、その空き地全体に一戸建てが
  // 乱立していた。buildable()による地点ごとの実データ裏付け判定を追加して歯止めをかける。
  if (denseArea) {
    for (let bx = worldX; bx < worldX + CHUNK_SIZE; bx += 14) {
      for (let bz = worldZ; bz < worldZ + CHUNK_SIZE; bz += 14) {
        if (Math.random() > 0.45) continue;
        const jx = bx + (Math.random() - 0.5) * 5.6, jz = bz + (Math.random() - 0.5) * 5.6;
        if (!buildable(jx, jz)) continue; // 実landuse区画内 or 本物の建物が近くにある場合のみ
        if (!nearMinorRoad(jx, jz, 35)) continue;
        const bw = 7 + Math.random() * 4, bd = 6.5 + Math.random() * 3.5;
        if (isOnRoad(jx, jz, bw, bd)) continue;
        if (hasBuildingNearby(jx, jz, Math.max(bw, bd) / 2 + 1.5)) continue;
        const pal = HOUSE_PALETTE[(Math.random() * HOUSE_PALETTE.length) | 0];
        const bh = Math.random() < 0.12 ? 8 + Math.random() * 5 : 4 + Math.random() * 3.5;
        const style = classifyResidential({ color: pal.w, roofColor: pal.r, type: 'house' }, bw, bd, bh);
        const _f2 = applySizeFloor(style, bw, bd, bh); // マンションになったら最低サイズを底上げ
        addBuilding(jx, jz, _f2.w, _f2.d, _f2.h, style);
      }
    }
  }

  // --- 4) どの分類にも該当しない空き地に、疎らな下草・雑木を生やす ---
  // 1)〜3)のどれにも該当しない(=一戸建ても建たない、田畑・山林・公園・水域でもない)
  // 平地は、実際の伊勢原市では山林・原野であることが多いのに、これまでは
  // 何も生えないただの空き地として放置されていた(「無所属の土地」の見た目対策)。
  // 山(FOREST_MIN_H以上)は既にrebuildForest()が別途カバーしているので、ここでは
  // 平地だけを対象にする(二重に生やさない)。ここは既にif(USES_MEIJI_LANDUSE)のelse節の中。
  for (let bx = worldX; bx < worldX + CHUNK_SIZE; bx += 22) {
    for (let bz = worldZ; bz < worldZ + CHUNK_SIZE; bz += 22) {
      if (Math.random() > 0.4) continue; // 疎らに(密な藪にしない)
      const jx = bx + (Math.random() - 0.5) * 10, jz = bz + (Math.random() - 0.5) * 10;
      if (inAvoid(jx, jz)) continue;        // 田畑・山林・公園・水域は既に専用の見た目がある
      if (buildable(jx, jz)) continue;      // 家が建つ(建ちうる)場所には生やさない
      if (getGroundY(jx, jz) >= FOREST_MIN_H) continue; // 山はrebuildForest()の担当
      if (isOnRoad(jx, jz, 2, 2)) continue;
      if (hasBuildingNearby(jx, jz, 4)) continue;
      plantScrub(jx, jz);
    }
  }
  } // end if(USES_MEIJI_LANDUSE)/else

  // このチャンク付近の道路を、現在(=NEAR高解像度地形が届いている可能性が高い、
  // プレイヤーに最も近いタイミング)の地形に合わせて再構築する(浮き/埋まり対策)
  rebuildRoadsNearChunk(chunkX, chunkZ);

  // Store all meshes added during this chunk for future unloading
  const added = scene.children.slice(beforeCount);
  chunkMeshes.set(key, added);
  currentChunkKey = null;
}

// 指定地点が水面(細い水路の線分、または池・広い川のポリゴン)の近くかどうか。
// 明治・江戸の地面パッチ(generateMeijiCells)が、面ポリゴンを持たない細い水路(river/
// stream等。addRoadで道路と同じ線分として描かれる)の上に不透明な農地テクスチャを
// 重ねて塗りつぶしてしまうのを防ぐために使う(isOnRoadと同じ空間ハッシュだが、
// water種別の線分と水面ポリゴンだけを対象にする)。
function isNearWater(cx, cz, r) {
  const cellR = Math.max(1, Math.ceil((r + MAX_ROAD_HALF_W) / ROAD_CELL)) + 1;
  const gx = Math.floor(cx / ROAD_CELL), gz = Math.floor(cz / ROAD_CELL);
  for (let dx = -cellR; dx <= cellR; dx++) for (let dz = -cellR; dz <= cellR; dz++) {
    const arr = roadGrid.get((gx + dx) + ',' + (gz + dz));
    if (!arr) continue;
    for (const rd of arr) {
      if (rd.type !== 'water') continue;
      const rdx = rd.x2 - rd.x1, rdz = rd.z2 - rd.z1;
      const len2 = rdx * rdx + rdz * rdz;
      if (len2 < 0.01) continue;
      const t = Math.max(0, Math.min(1, ((cx - rd.x1) * rdx + (cz - rd.z1) * rdz) / len2));
      const nx = rd.x1 + t * rdx - cx, nz = rd.z1 + t * rdz - cz;
      if (Math.sqrt(nx * nx + nz * nz) < (rd.rw || 3) / 2 + r) return true;
    }
  }
  for (const p of queryPolyGrid(minimapWaterGrid, cx - r, cx + r, cz - r, cz + r)) {
    if (pointInPolygon(cx, cz, p.pts)) return true;
  }
  return false;
}

// 明治: チャンク内の100m格子セルを土地利用コードに従って生成
// 町場ティア: 現代建物密度が高いセルでは、農家の集落ではなく街道沿いに軒を連ねる
// 町家(machiya)を並べる。密な短冊地割の町家1棟を1点に配置する。
// 明治のみ低確率で「洋風建築」(煉瓦色の壁+ドーム屋根=government型を流用)を混ぜ、
// 文明開化期の近代化が江戸より進んでいる様子を出す。高さ上限も明治の方をやや高く許容する。
function placeMachiya(hx, hz, inAvoid) {
  if (inAvoid(hx, hz)) return;               // 水面・田畑・山林・公園には建てない
  const bw = 5.5 + Math.random() * 2.5, bd = 6 + Math.random() * 2.5; // 間口の狭い短冊地割
  if (isOnRoad(hx, hz, bw, bd)) return;
  if (hasBuildingNearby(hx, hz, Math.max(bw, bd) / 2 + 1.2)) return; // 町場らしく間隔を詰める
  const western = MODE !== 'edo' && Math.random() < 0.15; // 明治の町場だけ洋風建築が低確率で混在
  if (western) {
    const h = 9 + Math.random() * 4; // 洋風建築は木造町家より高く(〜13m)許容
    addBuilding(hx, hz, Math.max(bw, 7), Math.max(bd, 7), h,
                { color: 0x8a4030, roofColor: 0x556070, type: 'government' }); // 煉瓦壁+ドーム屋根
    return;
  }
  const cap = MODE === 'edo' ? 9 : 10; // 江戸は木造軸組の上限として明治よりわずかに低く抑える
  const h = Math.min(cap, 3.6 + Math.random() * 3.8);
  const type = Math.random() < 0.55 ? 'shop' : 'house';
  addBuilding(hx, hz, bw, bd, h,
              { color: MEIJI_HOUSE_WALLS[(Math.random() * 3) | 0], roofColor: 0x3a4450, type, roofStyle: 'tile' });
}
function generateTownRow(cx, cz, inAvoid) {
  const roads = queryRoadGrid(cx - 60, cx + 60, cz - 60, cz + 60)
    .filter(r => r.type !== 'water' && r.type !== 'railway');
  if (roads.length === 0) {
    // 近くに道が無ければ集落よりやや多めのランダム散布にフォールバック
    const n = (MODE === 'edo' ? 3 : 4) + (Math.random() * 3 | 0);
    for (let i = 0; i < n; i++)
      placeMachiya(cx + (Math.random() - 0.5) * 90, cz + (Math.random() - 0.5) * 90, inAvoid);
    return;
  }
  for (const r of roads) {
    const dx = r.x2 - r.x1, dz = r.z2 - r.z1;
    const len = Math.sqrt(dx * dx + dz * dz);
    if (len < 8) continue;
    const px = -dz / len, pz = dx / len;
    for (let s = 3; s < len - 2; s += 7 + Math.random() * 2.5) {
      const rx = r.x1 + dx * (s / len), rz = r.z1 + dz * (s / len);
      if (rx < cx - 50 || rx >= cx + 50 || rz < cz - 50 || rz >= cz + 50) continue; // このセル担当分のみ(二重生成防止)
      for (const side of [-1, 1]) {
        if (Math.random() < 0.15) continue; // 町並みに抜けを少し残す
        const off = (r.rw || 4) / 2 + 2.6 + Math.random() * 1.2;
        placeMachiya(rx + px * side * off, rz + pz * side * off, inAvoid);
      }
    }
  }
}

function generateMeijiCells(x0, z0, x1, z1, inAvoid) {
  const groundGroups = new Map(); // material → セル中心座標列(後で1メッシュにマージ)
  for (let gx = Math.floor(x0 / 100); gx <= Math.floor(x1 / 100) + 1; gx++) {
    for (let gz = Math.floor(z0 / 100); gz <= Math.floor(z1 / 100) + 1; gz++) {
      let code = meijiCells.get(gx + ',' + gz);
      const cx = gx * 100, cz = gz * 100;
      if (cx < x0 || cx >= x1 || cz < z0 || cz >= z1) continue; // 中心点が担当チャンク内のセルのみ(二重生成防止)
      const isTown = localModernDensity(gx, gz) >= TOWN_TIER_MIN; // 現代建物密度から「町場」ティアを判定
      if (!code) {
        // 迅速測図のメッシュデータが無い区画(対象外エリアなど)。現代密度が高ければ
        // 集落があった可能性が高いとみなしてフォールバックし、密度が低ければ何もしない
        // (空白のまま放置するより、少なくとも町場は埋める)。
        if (!isTown) continue;
        code = 6;
      }
      const mat = MEIJI_GROUND_MATS[code];
      if (mat) {
        let arr = groundGroups.get(mat);
        if (!arr) { arr = []; groundGroups.set(mat, arr); }
        arr.push(cx, cz);
      }
      if (code === 6) { // 集落
        if (isTown) {
          generateTownRow(cx, cz, inAvoid); // 町場: 街道沿いに町家を連ねる
        } else {
          // 農村: 茅葺き民家の集落(江戸は明治より開発途上のため、集落あたりの軒数を減らす)
          const n = (MODE === 'edo' ? 1 : 2) + (Math.random() * 3 | 0);
          for (let i = 0; i < n; i++) {
            const hx = cx + (Math.random() - 0.5) * 80, hz = cz + (Math.random() - 0.5) * 80;
            const bw = 7 + Math.random() * 4, bd = 6 + Math.random() * 3;
            if (inAvoid(hx, hz)) continue;               // 水面には建てない
            if (isOnRoad(hx, hz, bw, bd)) continue;
            if (hasBuildingNearby(hx, hz, Math.max(bw, bd) / 2 + 2)) continue;
            addBuilding(hx, hz, bw, bd, 2.8 + Math.random() * 1.2,
                        { color: MEIJI_HOUSE_WALLS[(Math.random() * 3) | 0], roofColor: 0x4a3d2a, type: 'house', roofStyle: 'thatch' });
          }
          if (Math.random() < 0.04) addFireTower(cx + (Math.random() - 0.5) * 60, cz + (Math.random() - 0.5) * 60);
        }
      } else if (code === 3 && Math.random() < 0.5) {
        const tx = cx + (Math.random() - 0.5) * 70, tz = cz + (Math.random() - 0.5) * 70;
        if (!isOnRoad(tx, tz, 2.5, 2.5)) addTree(tx, tz, 0.4); // 桑・茶の低木(街道の上には生やさない)
      }
    }
  }
  // セルをマテリアルごとに1つのBufferGeometryへマージ(チャンクあたり最大でも数ドローコール)。
  // 【重要】以前は100mセルを4隅だけの1枚の平面(2三角形)で描いていたため、起伏のある
  // 農地(伊勢原は山際で棚田状に段差がある)では中央部が実際の地形からずれ、実の高さに
  // 合わせて立つプレイヤーがその平面の上に「埋まって」見えることがあった。GROUND_SUB分割
  // で小さな区画ごとにgetGroundYを取り直し、実地形への追従精度を上げる。
  // また、細い水路(river/stream等)は面ポリゴンではなく道路と同じ線分(roadGrid)で描画
  // されているため、この不透明な地面パッチが上から重なって川を塗りつぶしてしまっていた。
  // 水面(線・面とも)に重なる区画だけは穴を開け、下の川が見えるようにする。
  const GROUND_SUB = 4; // 100mセルの分割数(25m四方単位で高さを取り直す)
  const SUB_SIZE = 100 / GROUND_SUB;
  for (const [mat, cells] of groundGroups) {
    const verts = [], idxs = [], uvs = [];
    for (let i = 0; i < cells.length; i += 2) {
      const cx = cells[i], cz = cells[i + 1];
      for (let sx = 0; sx < GROUND_SUB; sx++) {
        for (let sz = 0; sz < GROUND_SUB; sz++) {
          const qx0 = cx - 50 + sx * SUB_SIZE, qz0 = cz - 50 + sz * SUB_SIZE;
          const qx1 = qx0 + SUB_SIZE, qz1 = qz0 + SUB_SIZE;
          const midx = (qx0 + qx1) / 2, midz = (qz0 + qz1) / 2;
          if (isNearWater(midx, midz, SUB_SIZE * 0.6)) continue; // 川・水路の上には描かない(下の水面を見せる)
          const base = verts.length / 3;
          [[qx0, qz0], [qx1, qz0], [qx1, qz1], [qx0, qz1]].forEach(([vx, vz]) => {
            verts.push(vx, getGroundY(vx, vz) + 0.12, vz);
            uvs.push(vx, vz); // uv=世界座標(テクスチャ側のrepeatで縞周期を制御)
          });
          idxs.push(base, base + 2, base + 1, base, base + 3, base + 2);
        }
      }
    }
    const geo = new THREE.BufferGeometry();
    geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
    geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geo.setIndex(idxs);
    geo.computeVertexNormals();
    const mesh = new THREE.Mesh(geo, mat);
    mesh.renderOrder = 1;
    scene.add(mesh); // チャンクのスナップショットに入るためアンロード時に破棄される
  }
}

let _lastChunkX = null, _lastChunkZ = null;
const chunkGenQueue = [];

function updateChunks() {
  if (USES_MEIJI_LANDUSE ? !meijiReady : !initialWorldLoaded) return;
  const cx = Math.floor(player.position.x / CHUNK_SIZE);
  const cz = Math.floor(player.position.z / CHUNK_SIZE);

  // Only process when the player enters a new chunk
  if (cx === _lastChunkX && cz === _lastChunkZ) return;
  _lastChunkX = cx; _lastChunkZ = cz;

  // 未生成チャンクをキューに積む(生成自体は1フレーム1個ずつ processChunkQueue で行う。
  // 以前は境界越えの瞬間に複数チャンクを同期生成して大きなカクつきの原因だった)
  for (let dx = -CHUNK_RADIUS; dx <= CHUNK_RADIUS; dx++) {
    for (let dz = -CHUNK_RADIUS; dz <= CHUNK_RADIUS; dz++) {
      const key = `${cx+dx},${cz+dz}`;
      if (!loadedChunks.has(key)) {
        loadedChunks.add(key);
        chunkGenQueue.push({ x: cx+dx, z: cz+dz, key });
      }
    }
  }
  // 近い順に生成(足元が歯抜けのまま遠くが先に生成されるのを防ぐ)
  chunkGenQueue.sort((a,b) => (Math.abs(a.x-cx)+Math.abs(a.z-cz)) - (Math.abs(b.x-cx)+Math.abs(b.z-cz)));

  // Unload distant chunks (geometry + lights freed from GPU)
  const unloadR = CHUNK_RADIUS + 2;
  let removedAny = false;
  for (const [key, meshes] of chunkMeshes.entries()) {
    const [kcx, kcz] = key.split(',').map(Number);
    if (Math.abs(kcx - cx) > unloadR || Math.abs(kcz - cz) > unloadR) {
      meshes.forEach(m => {
        scene.remove(m);
        // 屋根・小物の単位ジオメトリは全建物で共有しているため破棄しない
        if (m.geometry && !m.geometry.userData.shared) m.geometry.dispose();
      });
      chunkMeshes.delete(key);
      loadedChunks.delete(key); // allow re-generation if player returns
      // 【重要】以前はメッシュだけ消して記録が残っていたため、
      //  - 再訪時に hasBuildingNearby が幽霊建物を検出 → チャンクが空のまま(=途切れ)
      //  - 幽霊の当たり判定(見えない壁)とミニマップ表示も残留
      collisionBoxes = collisionBoxes.filter(b => b.chunkKey !== key);
      minimapBuildings = minimapBuildings.filter(b => b.ck !== key);
      placedBuildings = placedBuildings.filter(b => b.ck !== key);
      // resnap記録も一緒に捨てないと、消えたはずの建物パーツをいつまでも参照し続ける
      // (実OSM建物はck=nullなので手続き生成チャンクのアンロードでは消えない=想定通り)
      for (let i = buildingRecords.length - 1; i >= 0; i--) {
        if (buildingRecords[i].ck === key) buildingRecords.splice(i, 1);
      }
      removedAny = true;
    }
  }
  if (removedAny) { rebuildCollGrid(); rebuildBuildingGrid(); }
}

// このチャンクの範囲を覆うOSMタイルが全て「道路確定済み」かどうか。
// (地形→道路→建物→木の順を守るためのゲート。以前はチャンクの建物生成が
//  minimapRoads にその時点で乗っている道路だけを見て進んでしまい、後から
//  非同期でタイルの道路データが届くと、既に建てた建物に道路が遮られていた)
function chunkTilesReady(chunkX, chunkZ) {
  const x0 = chunkX * CHUNK_SIZE, z0 = chunkZ * CHUNK_SIZE;
  const x1 = x0 + CHUNK_SIZE, z1 = z0 + CHUNK_SIZE;
  const txs = [Math.floor(x0 / OSM_TILE_M), Math.floor(x1 / OSM_TILE_M)];
  const tzs = [Math.floor(z0 / OSM_TILE_M), Math.floor(z1 / OSM_TILE_M)];
  for (const tx of txs) for (const tz of tzs) {
    if (!loadedOSMTiles.has(`${tx},${tz}`)) return false;
  }
  return true;
}

// このチャンクが、プレイヤー追従の高解像度NEAR地形グリッドの範囲内に収まっているか。
// 建物は生成時に一度だけ getGroundY で高さを焼き込むため、NEARが届く前に生成すると
// 後からNEARが更新されても建物だけ取り残されて浮く/埋まる(道路のような再構築の仕組みが
// 建物側には無い)。生成そのものをNEARが揃うまで遅らせることで、この問題を避ける。
function chunkNearTerrainReady(chunkX, chunkZ) {
  if (_nearGiveUp) return true; // API障害が続く場合は諦めてFARデータのまま進める
  if (!nearElev) return false;
  const x0 = chunkX * CHUNK_SIZE, z0 = chunkZ * CHUNK_SIZE;
  const x1 = x0 + CHUNK_SIZE, z1 = z0 + CHUNK_SIZE;
  const margin = 10; // 端ぎりぎりだと補間で範囲外扱いになりやすいので少し内側に余裕を持たせる
  return x0 > nearCX - NEAR_W/2 + margin && x1 < nearCX + NEAR_W/2 - margin &&
         z0 > nearCZ - NEAR_D/2 + margin && z1 < nearCZ + NEAR_D/2 - margin;
}

// 1フレームに1チャンクだけ生成するフレーム分割処理
function processChunkQueue() {
  if (chunkGenQueue.length === 0) return;
  const c = chunkGenQueue.shift();
  const ccx = Math.floor(player.position.x / CHUNK_SIZE);
  const ccz = Math.floor(player.position.z / CHUNK_SIZE);
  // キュー待ちの間に遠ざかったチャンクは破棄(再訪時に再キューされる)
  if (Math.abs(c.x - ccx) > CHUNK_RADIUS + 1 || Math.abs(c.z - ccz) > CHUNK_RADIUS + 1) {
    loadedChunks.delete(c.key);
    return;
  }
  // カバーするタイルの道路データがまだ届いていなければ、建物を生成せず後回しにする
  // (キュー末尾へ回し、他の準備済みチャンクを先に処理する)
  if (!chunkTilesReady(c.x, c.z)) {
    chunkGenQueue.push(c);
    return;
  }
  // NEAR(周辺高解像度)地形がまだこのチャンクを覆っていなければ、建物が変な高さで
  // 焼き込まれないよう後回しにする(明治モードはNEARを使わないので対象外)
  if (!IS_MEIJI && !chunkNearTerrainReady(c.x, c.z)) {
    chunkGenQueue.push(c);
    return;
  }
  generateChunk(c.x, c.z);
}
