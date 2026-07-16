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
// 【2026-07-16】2→3。直接モードはミラー輪番(3ホスト)になったため、ホストあたりの
// 同時実行は従来以下のまま全体スループットを上げられる。プロキシ経由でもサーバ側の
// per-hostペース配分(1.1s)が守られるので上流には安全。429が増えるようなら2に戻す。
const OSM_TILE_CONCURRENCY = 3;
let osmTileActiveCount = 0;
let _osmMoveUx = 0, _osmMoveUz = 0; // プレイヤーの進行方向(単位ベクトル)。取得順の前方優先に使う
const osmTileFailCount = new Map(); // タイルごとの失敗回数(3回まで再試行)
// 【重要】標高データ+初期OSMのロード完了までタイル取得を止めるゲート。
// 以前は起動直後からタイル取得が走り、標高ロード(約8秒)より先に完了した
// 境界タイルの道路が「平坦な地面の高さ」で生成され、その後地形が持ち上がると
// 地面の下に埋まって「道路がスパッと途切れる」症状になっていた。
// (ミニマップには道路が残るのに3Dでは見えない、という報告と厳密に一致する)
let initialWorldLoaded = false;
const seenOSMWays = new Set();      // 処理済みway ID(タイル境界をまたぐ要素の二重生成防止)
const seenOSMRelations = new Set(); // 処理済みbuilding relation ID(下記synthesizeBuildingRelationWays参照)
const pendingBuildings = [];        // タイル取得分の建物はフレーム分割して生成
let pendingBuildingIdx = 0;
// 遠景最適化(2026-07-15): プレイヤーからBUILDING_GEN_DIST(part1.js)より遠い実建物は、
// 道路・地形・線路・川と違って生成そのものを見送る(遠景は地形と交通網だけで十分という
// 判断)。まだ生成していないが「いずれ近づけば作る」対象はここへ退避しておき、
// reactivateNearbyDormantBuildings(part1.js)がプレイヤー接近を検知してpendingBuildingsへ
// 戻す。pendingBuildingsに残したまま距離判定だけ毎フレーム繰り返すと、遠方の建物が
// 溜まるほど「足踏みして即キュー末尾へ戻す」だけの空回りが増えてしまうため、
// 生成ループの外(低頻度スキャン)に分離する。
const dormantBuildings = [];

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

// 【重要】以前はここに markInitialTiles() があり、伊勢原本体(OSM_BOUNDS)のタイルを
// 起動時点で「取得済み」としてマークしていた(loadOSM()が同期的に道路・建物を組み立てて
// いたため)。loadOSM()をタイル取得への一本化に伴い削除 — 伊勢原も他地域と全く同じく、
// checkOSMTiles()がプレイヤー周辺のタイルを未取得として検出し、通常のフローで取得する。

function processTileData(data, tileCount) {
  if (!data || !data.elements) return;
  // このバッチ(tileCount枚のタイル分、1枚=OSM_TILE_M四方=最大6枚で約15km²)の実測建物密度を
  // 先に見て、国プロファイルより高層寄りに上書きするか決める(part6.js PASS-2と同じ考え方。
  // 「USも高密度地帯は高層ビルにして」への対応 — 国単位の固定ルールだけでは同じ国の中の
  // 都心部と郊外の違いを表現できないため、実測の建物密度で判定する)。
  // 【重要】以前はバッチ全体で1つの被覆率しか見ていなかったため、広い道路・公園・河川を
  // 含む6タイル分の平均で薄まり、実際は密集した街区(マンハッタンの一角等)でも高層化が
  // 発動しない不具合があった。DENSITY_CELL_M格子で建物1棟ごとに判定する
  // (経緯・格子サイズの選定理由はpart2.js computeLocalDensityGrid参照)。
  // building=タグを持つrelation(マルチポリゴン)をway相当の疑似要素に変換し、既存のbuilding
  // 処理・密度計算に合流させる(part2.js synthesizeBuildingRelationWays参照。地図上に見える
  // 大きな建物枠が生成システムに一切渡っていなかった不具合の対策)。
  const buildingElements8 = data.elements.concat(synthesizeBuildingRelationWays(data.elements, seenOSMRelations));
  const cprofH8Base = MODE === 'real' ? getCountryBuildingProfile(currentCountryCode) : null;
  const densityGrid8 = MODE === 'real' ? computeLocalDensityGrid(buildingElements8) : null;
  // 周囲に田畑があるエリアは被覆率に関わらず高層化しない(part2.js computeFarmlandCells参照)。
  const farmlandCells8 = MODE === 'real' ? computeFarmlandCells(data.elements) : null;
  // 至近距離に駅が複数あるエリア(ターミナル駅)は強制的に高層ビル区域にする。
  // 駅ノードはグローバルに(タイル取得バッチをまたいで)蓄積する
  // (part2.js registerStationPoints参照。東京・NY等の対策)。
  if (MODE === 'real') registerStationPoints(data.elements);
  // 駅ランドマーク(初期範囲の外にある駅も、タイルが届いた時点でここで拾う)
  processStationNodes(data.elements);
  // Roads
  const _roadMeshStart8 = pendingRoadMeshes.length; // このバッチで新規投入する分の開始位置(近傍優先ソート用)
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
  // このバッチで新規に積んだ道路メッシュだけ、プレイヤー位置を中心とした近い順へ並べ替える
  // (part1.js sortNewEntriesByDistanceToPlayer参照)。
  sortNewEntriesByDistanceToPlayer(pendingRoadMeshes, _roadMeshStart8, r => ({ x: (r.x1 + r.x2) / 2, z: (r.z1 + r.z2) / 2 }));
  // 公園・水域・田畑・森 + multipolygon水面
  data.elements.forEach(el => {
    if (el.type === 'relation') { processWaterRelation(el); return; } // 重複はrel側のSetで防止
    if (el.type === 'way' && el.id && seenOSMWays.has(el.id)) return;
    handleAreaFeature(el);
  });
  // Buildings — 直接生成せずキューに積み、フレーム分割して生成する
  // (以前は1タイル分の建物を1フレームで同期生成し、大きなカクつきの原因だった)
  const _buildingStart8 = pendingBuildings.length; // このバッチで新規投入する分の開始位置(近傍優先ソート用)
  buildingElements8.forEach(el => {
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
    // 【重要・2026-07-16】以前は「頂点平均の重心+軸平行の外接矩形(maxDx*2×maxDz*2)」で、
    // 斜め向きの建物が実際より大幅に大きい軸平行の箱になっていた(45°回転した100m×20mの
    // ビルは約85m×85mの正方形になる)。isOnRoadが実建物を破棄していた間はこの膨張した箱が
    // 目に触れなかったが、破棄をやめた途端「巨大ビルが道路・線路に覆いかぶさる」
    // 「全建物が同じ向き(軸平行)」として露見した。フットプリントの最長辺の方位角を
    // 主方位とし、その回転座標系で外接矩形を取ることで、実際の向き・寸法を復元する。
    let _ang = 0, _bestL2 = 0;
    for (let i = 0; i + 1 < pts.length; i++) {
      const ex = pts[i+1].x - pts[i].x, ez = pts[i+1].z - pts[i].z;
      const l2 = ex*ex + ez*ez;
      if (l2 > _bestL2) { _bestL2 = l2; _ang = Math.atan2(ez, ex); }
    }
    const _c = Math.cos(_ang), _s = Math.sin(_ang);
    let _minU = Infinity, _maxU = -Infinity, _minV = Infinity, _maxV = -Infinity;
    pts.forEach(p => {
      const u = p.x * _c + p.z * _s, v = -p.x * _s + p.z * _c;
      if (u < _minU) _minU = u; if (u > _maxU) _maxU = u;
      if (v < _minV) _minV = v; if (v > _maxV) _maxV = v;
    });
    // 中心は回転座標系の外接矩形中心から逆変換(頂点平均だとL字型などで偏るため)
    const _cu = (_minU + _maxU) / 2, _cv = (_minV + _maxV) / 2;
    let cx = _cu * _c - _cv * _s, cz = _cu * _s + _cv * _c;
    let w = Math.max(_maxU - _minU, 2), d = Math.max(_maxV - _minV, 2);
    // three.jsのrotation.y(+Xから-Z方向が正)に合わせて符号反転して保持
    const bRot = -_ang;
    if (isCampusOnly) { w = Math.min(w, 34); d = Math.min(d, 22); } // 敷地全体でなく校舎サイズに収める
    let style = getBuildingStyle(tags);
    if (MODE === 'edo' && shouldSkipEdoBuilding(style)) return; // 江戸: 現代の建物密度をそのまま使わず間引く
    const resolvedH = resolveBuildingHeight(tags);
    // 国プロファイルの階数フォールバック・最低階数floor(part6.js PASS-2と同じロジック)。
    // 【重要】ここ(part8.js)はプレイヤーが移動して新しいOSMタイルを取得するたびに
    // 呼ばれる経路で、part6.js側だけに国プロファイルを配線していたため、ジャンプ直後の
    // 初期範囲を過ぎて歩き回った先の建物には反映されていなかった(香港で歩き続けると
    // 低層タグの建物がまた出る不具合の原因)。
    const cprofH8 = localDensityProfileAt(cprofH8Base, densityGrid8, cx, cz, farmlandCells8);
    const [lvMin8, lvMax8] = (cprofH8 && cprofH8.levelsRange) || [1, 3];
    const levels = parseInt(tags['building:levels']) || (lvMin8 + Math.floor(Math.random() * (lvMax8 - lvMin8 + 1)));
    let h = resolvedH != null ? resolvedH : Math.max(levels*3,3)+Math.random()*2;
    h = applyLandmarkMinHeight(style, h); // 学校・病院・役場・神社仏閣は最低限の高さを確保
    const _landmarkType8 = style && (style.type === 'shrine' || style.type === 'temple' || style.type === 'church');
    if (cprofH8 && cprofH8.minLevels && !_landmarkType8) {
      h = Math.max(h, cprofH8.minLevels * 3);
    }
    style = classifyResidential(style, w, d, h, cx, cz);
    let fw = w, fd = d, fh = h;
    ({ w: fw, d: fd, h: fh } = applySizeFloor(style, w, d, h)); // マンション・工場は最低サイズを底上げ
    if (MODE === 'edo') fh = applyEdoHeightCap(style, fh); // 江戸: 現代建物の実測高さそのままだと高層ビルになるため木造家屋相当に抑える
    const realRec = { x: cx, z: cz, w: fw, d: fd, h: fh, style, real: true, rot: bRot };
    pendingBuildings.push(realRec);
    // 【重要・2026-07-15】以前はbuildingGrid(hasRealBuildingNearby/hasRealHouseNearbyが参照する、
    // 「本物のOSM建物がここにある」という手続き生成の裏付け判定用インデックス)への登録が、
    // addBuilding()で実際にメッシュ化された時にしか行われていなかった。建物のバックログが
    // 大きい(東京駅周辺のような超高密度エリアでは数万件溜まる)と、実際の描画が追いつくまで
    // 何分もかかる一方、手続き生成の住宅充填(generateChunk)は道路・地形さえ揃えば
    // すぐ動くため、「本物の商業ビルがまだ描画待ちで存在を知られていない」場所を
    // 「実建物なし」と誤判定し、周辺のlanduse=residentialの気配だけで先に小さい戸建てを
    // 敷き詰めてしまっていた(実機報告: 東京駅周辺で大きい商業ビルの場所に住宅が密集)。
    // キューに積んだ時点(=OSMデータとして存在が確定した時点)で先にbuildingGridへ軽量登録
    // しておくことで、実際の描画完了を待たずに手続き生成側が正しく「ここは本物の建物がある」
    // と認識できるようにする。
    knownBuildingGridAdd(realRec);
  });
  // このバッチで新規に積んだ建物だけ、プレイヤー位置を中心とした近い順へ並べ替える
  // (part1.js sortNewEntriesByDistanceToPlayer参照)。
  sortNewEntriesByDistanceToPlayer(pendingBuildings, _buildingStart8, b => ({ x: b.x, z: b.z }));
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
  // マルチポリゴンで描かれた建物(building=タグがrelation側に付く。複合施設や輪郭の
  // 複雑な大型ビルでよく使われる)。以前はここが無く、地図上に見える大きな建物枠が
  // 生成システムに一切渡っていなかった(part2.js synthesizeBuildingRelationWays参照)。
  'relation["building"]',
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
// 1クエリに収められるので、近い順にまとめて1往復で取得する。
// 【重要・2026-07-16】以前は6枚まとめだったが、京橋・八重洲のような超高密度エリアで
// 実機診断した結果、6タイルまとめ(15種類の条件節×6=90節)はOverpassのインフラ側で
// 504 Gateway Timeoutになることを直接確認した。一方、同じ場所で3タイル(約14秒)・
// 4タイル(約26秒)まとめは正常に成功することも確認済み。密集地で6タイルが失敗するたびに
// 該当タイルだけ1枚単位に縮小して再試行する対策も入れたが、これは「1タイル=1リクエスト」
// に戻ってしまうため、大きなバックログ(60タイル以上)がある状況では逆にリクエスト数が
// 急増し、サーバー側の直列キュー(1.1秒間隔/ホスト)・直接モードのペース配分の両方を
// 詰まらせ、429/502/504が連鎖する新たな不具合を実機で確認した。まずデフォルトのバッチ
// サイズ自体を余裕を持って安全な3に下げ、超高密度エリアでも極力初回から成功させる
// (=1枚単位への緊急縮小が滅多に発動しないようにする)方針に変更する。
// 【重要・2026-07-16再追記】3タイルまとめに下げた後も、新川・八丁堀エリアで実機診断した
// ところ、周辺タイルは全てloaded:true・fail:0(=エラーもremarkも一切無い「正常成功」扱い)
// なのに、実際にはそのエリアの建物の89%(631/712件)がpendingBuildings/dormantBuildings/
// buildingRecordsのどこにも存在しないという致命的な事象を確認した。Overpassが例外も
// HTTPエラーもremarkも一切出さずに、内部の負荷状況次第で「たまたまその時応答できた分だけ」
// を通常の200 OKとして返してくることがあるためで、v4のremark検知やv5/v6のバッチ縮小・
// 失敗検知では原理的に検出できない(失敗として記録すらされない「無言の部分成功」)。
// 3タイル・4タイルは検証時にはたまたま完全な応答を得られたが、密集地では毎回安全とは
// 限らないと判断し、一時的に1タイル固定まで縮小した。
// 【2026-07-16 3に復帰】その後、(1)out count;による完全性検証を導入し「無言の部分応答」は
// 検出→再試行できるようになった、(2)「大型ビルが生成されない」真因はネットワークではなく
// isOnRoadの外接円判定による受信後の破棄(part9.js参照)と判明した、(3)1タイル化は
// リクエスト数を3〜6倍にし、公開インスタンスのレート制限(429ストーム)の主因になっていた。
// 以上より、実測で完全応答を確認済みの3に戻す(6は密集地でリバースプロキシ側の硬い504が
// 出るため不可)。部分応答が来てもcount検証が弾いて再試行される。
const OSM_TILE_BATCH = 3;
function buildOSMBatchQuery(bboxes) {
  const parts = [];
  for (const clause of OSM_TILE_CLAUSES) for (const bb of bboxes) parts.push(clause + '(' + bb + ');');
  const timeout = Math.min(60, 20 + bboxes.length * 6); // タイル数に応じて上流タイムアウトも延ばす
  // 【重要・2026-07-16】以前はここでOverpass側のtimeout秒数だけ組み立てて文字列を返し、
  // 呼び出し側(fetchOSMTileBatch)は全く別の固定値(35秒)でクライアント側abortしていた。
  // 東京駅八重洲・京橋のような超高密度エリアでは6タイルまとめクエリがOverpass側の
  // timeout指定(最大56秒)ぎりぎりまでかかることがあり、クライアント側が35秒で
  // 先にAbortControllerで接続を切ってしまうと、Overpassがまだ計算を続けている
  // 正常なクエリを「失敗」として扱ってしまう。Overpass側に指定したtimeout秒数を
  // 呼び出し側にも返し、クライアント側のabort猶予をそれに揃える(+バッファ)。
  // 【重要・2026-07-16】out geom;の前にout count;を挟む。Overpassは負荷次第で、エラーも
  // remarkも一切出さずに「その時応答できた分だけ」を200 OKで返すことがある(無言の部分応答。
  // 新川・八丁堀で実測: 全タイルloaded扱いなのに実建物712件中631件が欠落)。out count;は
  // 集合の確定後・要素出力の前に「本来の総数」を宣言する要素(type:"count")を先頭に出力する
  // ため、宣言総数と実際に届いた要素数を突き合わせれば出力段階での切り捨てを検出できる。
  return { query: `[out:json][timeout:${timeout}];(${parts.join('')});out count;out geom;`, timeout };
}

// ---- 【2026-07-16】OSMタイルのIndexedDBキャッシュ ----
// 道路生成遅延の根本原因は「遠距離ジャンプ=location.reload()のたびに、同じタイルを
// 毎回Overpassから取り直している」こと。検証済み(out count照合済み)の1タイル応答を
// ブラウザのIndexedDBに保存し、再訪・リロード時はネットワークを介さず即時復元する。
// Overpassへのリクエスト数自体が減るので、未キャッシュタイルの取得も速くなる好循環。
// クエリ内容(OSM_TILE_CLAUSES)を変えた時はVERをバンプして旧キャッシュを無効化すること。
const OSM_TILE_CACHE_VER = 'v1';
const OSM_TILE_CACHE_TTL = 30 * 86400e3; // 30日(OSM編集の反映が最大30日遅れるのは許容)
let _osmDBPromise = null;
function osmCacheDB() {
  if (_osmDBPromise) return _osmDBPromise;
  _osmDBPromise = new Promise((resolve) => {
    try {
      const req = indexedDB.open('osmTileCache', 1);
      req.onupgradeneeded = () => req.result.createObjectStore('tiles');
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => resolve(null); // プライベートモード等で使えなくても本体は動かす
    } catch (e) { resolve(null); }
  });
  return _osmDBPromise;
}
async function osmCacheGet(key) {
  const db = await osmCacheDB();
  if (!db) return null;
  return new Promise((resolve) => {
    try {
      const rq = db.transaction('tiles', 'readonly').objectStore('tiles').get(OSM_TILE_CACHE_VER + ':' + key);
      rq.onsuccess = () => {
        const v = rq.result;
        resolve(v && (Date.now() - v.ts) < OSM_TILE_CACHE_TTL ? v.data : null);
      };
      rq.onerror = () => resolve(null);
    } catch (e) { resolve(null); }
  });
}
function osmCachePut(key, data) { // fire-and-forget
  osmCacheDB().then((db) => {
    if (!db) return;
    try { db.transaction('tiles', 'readwrite').objectStore('tiles').put({ ts: Date.now(), data }, OSM_TILE_CACHE_VER + ':' + key); } catch (e) {}
  });
}

async function fetchOSMTileBatch() {
  // プレイヤーに近いタイルを優先(以前はキュー投入順で、進行方向の
  // タイルが後回しになり目の前で道路が途切れたまま待たされていた)
  const ptx = player.position.x / OSM_TILE_M, ptz = player.position.z / OSM_TILE_M;
  // 【2026-07-16】距離のみのソートだと真後ろと真正面のタイルが同順位になり、移動中に
  // 前方タイルが後回しになることがあった。進行方向(checkOSMTilesで更新される
  // _osmMoveUx/Uz)への射影ぶんスコアを引いて、同距離なら前方を必ず先に取得する。
  // 係数0.8: 前方1タイル先 ≒ 横0.8タイルぶん優先(後方タイルは射影が負なので不利になる)。
  const _tileScore = (t) => {
    const dx = t.tx + 0.5 - ptx, dz = t.tz + 0.5 - ptz;
    return Math.abs(dx) + Math.abs(dz) - (dx * _osmMoveUx + dz * _osmMoveUz) * 0.8;
  };
  osmTileQueue.sort((a, b) => _tileScore(a) - _tileScore(b));
  // ジャンプ直後(現在地のタイルすら未確定)は、まず1枚だけの小さいクエリで最速で足元の
  // 道路・建物を出す。6枚まとめの大クエリはOverpass側の実行に20〜40秒かかるため、
  // ジャンプ後「道路が出るまで1〜2分」の主因だった(同時実行枠は1IPあたり2つしかない)。
  // 現在地のタイルが確定したら、従来どおり6枚まとめで効率よく外側を埋める。
  const ptKey = `${Math.floor(player.position.x / OSM_TILE_M)},${Math.floor(player.position.z / OSM_TILE_M)}`;
  // 【重要・2026-07-16】京橋・八重洲のような超高密度エリアで実機診断した結果、6タイル
  // まとめクエリ(道路+建物+relation building+landuse等15種類×6タイル分)がOverpassの
  // 応答インフラ側で504 Gateway Timeoutになることを確認(内部の[timeout:N]指定より手前の
  // リバースプロキシ側の上限に当たっている)。一方、同じ場所を1タイル単体でクエリすると
  // 1秒程度で正常に返る。以前は「6タイルまとめ→失敗→同じ6タイルまとめで再試行」を
  // 繰り返し、4回失敗すると諦めてloadedOSMTiles扱いにしてしまい、実データが永久に
  // 手に入らないまま(=建物もlanduseも無いので手続き生成の充填条件も満たせず)空き地が
  // 残っていた。
  // 【重要・2026-07-16追記】「失敗履歴が1回でもあれば1枚まで縮小」という対策を入れたが、
  // 実機診断でこれが新たな不具合を引き起こすことを確認した: ジャンプ直後などタイルの
  // バックログが60件規模になる状況では、6枚まとめ(既定値。この時点ではまだ3への変更前)が
  // 軒並み失敗→即座に「1タイル=1リクエスト」へ戻ってしまい、サーバー側の直列キュー
  // (ホストごと1.1秒間隔)や直接モードのペース配分を詰まらせ、429/502/504が連鎖する
  // (実機で確認: 通常1秒で返るはずのクエリが35秒〜2分待たされ、最終的に502/429)。
  // 既定バッチをそもそも3に下げたことで6枚起因の504自体は初回からほぼ回避できる想定
  // なので、1枚への緊急縮小は「同じタイルで2回以上失敗した」場合だけの最終手段に留め、
  // 1回目の失敗はまず既定バッチサイズのまま(混雑等の一時的な要因の可能性を優先して)
  // 再試行させ、リクエスト数の急増を防ぐ。
  const nextTile = osmTileQueue[0];
  const nextFailCount = nextTile ? (osmTileFailCount.get(nextTile.tx + ',' + nextTile.tz) || 0) : 0;
  // 【2026-07-16】プレイヤー近傍(3×3圏)のタイルは常に1枚クエリ。実測で1枚=1〜1.5秒、
  // 3枚まとめ=10〜30秒(密集地)なので、体感を決める近傍タイルだけ小さく速く取る。
  // 1枚クエリはIndexedDBキャッシュの対象にもなる(キャッシュはタイル単位のため)。
  // 外周のタイルは従来どおり3枚まとめでリクエスト数を抑える。
  const nearSolo = nextTile && Math.max(Math.abs(nextTile.tx + 0.5 - ptx), Math.abs(nextTile.tz + 0.5 - ptz)) <= 1.6;
  const batchSize = (!loadedOSMTiles.has(ptKey) || nextFailCount >= 2 || nearSolo) ? 1 : OSM_TILE_BATCH;
  const batch = osmTileQueue.splice(0, batchSize); // 近い順
  const keys = batch.map(({tx, tz}) => `${tx},${tz}`);
  const bboxes = batch.map(({tx, tz}) => {
    const worldX0 = tx * OSM_TILE_M, worldZ0 = tz * OSM_TILE_M;
    const ll00 = xzToLatLon(worldX0, worldZ0);
    const ll11 = xzToLatLon(worldX0 + OSM_TILE_M, worldZ0 + OSM_TILE_M);
    const minLat = Math.min(ll00.lat, ll11.lat), maxLat = Math.max(ll00.lat, ll11.lat);
    const minLon = Math.min(ll00.lon, ll11.lon), maxLon = Math.max(ll00.lon, ll11.lon);
    return `${minLat.toFixed(5)},${minLon.toFixed(5)},${maxLat.toFixed(5)},${maxLon.toFixed(5)}`;
  });
  const { query, timeout: osmTimeoutSec } = buildOSMBatchQuery(bboxes);
  let failed = false;
  // 【重要】以前は Promise.race([fetch(...), timeoutPromise]) で「50秒で見切る」だけだった。
  // これはtimeoutPromise側が先に解決してcatchに落ちるだけで、負けた方のfetch自体は
  // 中断されずバックグラウンドで生き続ける(=ブラウザの同一オリジンへの同時接続枠を
  // 掴んだまま)。Overpass/プロキシが混雑して応答が極端に遅い状況が続くと、この
  // 「見捨てられたが実際には終わっていないfetch」が積み重なり、ブラウザ側の接続枠を
  // 使い果たして新規のfetchがネットワークにすら出せず永久に足踏みする
  // (実機確認: osmTileActiveCountが2のまま固まり、成功も失敗も一切記録されない状態と一致)。
  // AbortControllerで実際に接続を中断し、枠を確実に解放する。
  //
  // 【重要・2026-07-15】50秒は「見切る」だけの数字ではなく、OSM_TILE_CONCURRENCY=2しか
  // 同時実行枠が無い設計上、1本が50秒粘るだけで残り1本と合わせた全体スループットが
  // 大きく落ちる。DEBUG_SESSION_20260710.mdの実測(1枚クエリ=10〜20秒、6枚まとめ=20〜40秒)
  // を踏まえ、クエリの大きさに応じてタイムアウトを短縮する。1枚クエリ(ジャンプ直後・
  // 現在地未確定時)は20秒、6枚まとめ(通常時)は35秒。正常系の実測上限にわずかな余裕を
  // 残しつつ、無駄な待ちを大きく減らす。
  // 【重要・2026-07-16】↑この固定35秒は、buildOSMBatchQueryがOverpassに指定する
  // [timeout:N](6タイルまとめだと最大56秒)より短い場合があった。東京駅・八重洲/京橋
  // のような超高密度エリアでは6タイル分の道路+建物+landuse等の集計にOverpass側が
  // 35秒を超えて正規に処理を続けていることがあり、クライアント側が先にAbortControllerで
  // 接続を切ってしまうと、正常進行中のクエリを「失敗」として扱って再試行ループに
  // 入ってしまっていた(実機診断: 京橋・八重洲エリアで道路は届くのに実建物が0件、
  // かつosmTileFailCountは0=直近の試行では例外が飛んでいない、という状態と整合)。
  // Overpass側に指定したtimeout秒数(osmTimeoutSec)に十分なバッファ(+8秒)を足した値を
  // クライアント側のabort猶予にする。
  const tileTimeoutMs = batch.length <= 1 ? 20000 : (osmTimeoutSec * 1000 + 8000);
  const abortCtl = new AbortController();
  const timeoutId = setTimeout(() => abortCtl.abort(), tileTimeoutMs);
  try {
    // 1枚クエリはまずIndexedDBキャッシュを照会(ヒットなら即時復元・ネットワーク不要)
    if (batch.length === 1) {
      const cached = await osmCacheGet(keys[0]);
      if (cached) {
        processTileData(cached, 1);
        osmTileFailCount.delete(keys[0]);
        loadedOSMTiles.add(keys[0]);
        if (awaitingDestinationLoad && keys.includes(ptKey)) {
          awaitingDestinationLoad = false;
          showToast('✨ マップを表示しました', { duration: 3000 });
        }
        clearTimeout(timeoutId);
        osmTileActiveCount--;
        processOSMTileQueue(); // キャッシュヒットは待ち時間なしで即次のタイルへ
        return;
      }
    }
    // 【重要・2026-07-15】以前はGETで ?data=<クエリ> をURLに埋め込んでいたが、6タイル
    // まとめ+多数のfeature種別(道路/建物/relation building/landuse/leisure/natural/
    // waterway/relation water/riverbank/railway/駅/amenity...)を含むクエリはURL長が
    // 数千文字に達し、overpass-api.deから直接 414 (Request-URI Too Long) を返される事象を
    // 実機コンソールで確認(道路が「拡張生成が完全にストップ」していた真因。水ポリゴンは
    // 別経路の同期処理・チャンク到達済みキャッシュ由来の描画だったため影響を受けず、
    // 「川だけ拡張される」ように見えていた)。Overpass API公式にPOST(data=<クエリ>を
    // ボディに)を送る方式が用意されており、URL長に一切依存しないためこちらに統一する。
    const res = await fetch('https://overpass-api.de/api/interpreter', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'data=' + encodeURIComponent(query),
      signal: abortCtl.signal,
    });
    if (!res.ok) throw new Error('HTTP ' + res.status);
    const data = await res.json();
    if (!data || !data.elements) throw new Error('no elements');
    // 【重要・2026-07-16】Overpassは内部のtimeout/メモリ上限に達すると、例外にはならず
    // HTTP 200 + data.remarkに "runtime error: Query timed out" 等の文言を入れた「途中までの
    // 部分結果」を返すことがある。以前はdata.elementsさえ存在すれば無条件で成功扱いにして
    // いたため、超高密度エリア(京橋・八重洲など)で道路は途中まで集計できても建物の集計に
    // 到達する前にOverpass側がタイムアウトし、その中途半端な結果を「完全に取得できた」
    // ものとしてタイルを永久にloadedOSMTiles入りさせてしまい、実建物が二度と現れない
    // 空地が生まれていた(実機診断で確認)。remarkにtimeout/memoryを示す文言があれば
    // 部分結果とみなし、失敗として扱って再試行キューに戻す。
    if (data.remark && /timed out|timeout|out of memory/i.test(data.remark)) {
      throw new Error('partial result: ' + data.remark);
    }
    // 【重要・2026-07-16】無言の部分応答の検出(buildOSMBatchQueryのout count;参照)。
    // count要素(必ず要素出力の先頭)の宣言総数 vs 実受信数を照合。count要素自体が無い
    // 200 OK応答も「出力の先頭から切り捨てられた」とみなし失敗扱い(このクエリは常に
    // out count;を要求しているため、正常応答なら空集合でもtotal:"0"のcount要素が付く)。
    const countEl = data.elements.find(el => el.type === 'count');
    const received = data.elements.filter(el => el.type !== 'count').length;
    const declared = countEl ? parseInt(countEl.tags && countEl.tags.total, 10) : NaN;
    if (!Number.isFinite(declared)) throw new Error('incomplete: count element missing');
    if (received < declared) throw new Error(`incomplete: ${received}/${declared} elements`);
    // count検証を通過した完全な1タイル応答だけをIndexedDBへ保存(部分応答の汚染を防ぐ)
    if (batch.length === 1) osmCachePut(keys[0], data);
    // 複数タイル分の要素が1つの配列で混ざって届くが、seenOSMWaysでway ID重複排除される
    // ので、1タイルの時と同じ processTileData にそのまま渡してよい。密度計算用にタイル枚数も渡す。
    processTileData(data, batch.length);
    keys.forEach(k => {
      osmTileFailCount.delete(k);
      loadedOSMTiles.add(k); // このタイルの道路が確定 → 建物生成待ちのチャンクを解放してよい
    });
    // loadOSM()(part6.js)は起動直後に「🗺 マップを読み込み中...」のstickyトーストを
    // 出したまま抜ける(道路・建物の実際の生成はここが担当するため)。プレイヤーの現在地
    // タイルが届いた時点で、これを完了メッセージに差し替える。
    if (awaitingDestinationLoad && keys.includes(ptKey)) {
      awaitingDestinationLoad = false;
      showToast('✨ マップを表示しました', { duration: 3000 });
    }
  } catch(e) {
    // 以前は3回失敗すると完全に諦めて二度と再試行しなかったため、Overpassが一時的に
    // 混雑していただけの場合でも「その区画だけ永久に道路が途切れる」ことがあった。
    // → 諦めきらず、間隔を伸ばしながら背景でずっと再試行し続ける。
    // (3回失敗した時点では建物生成だけ先に進めてよい扱いにし、後から道路が届いたら反映される)
    // (AbortErrorも含め、失敗理由を問わずここに来れば必ずキューの枠を解放できる)
    failed = true;
    keys.forEach(k => {
      const n = (osmTileFailCount.get(k) || 0) + 1;
      osmTileFailCount.set(k, n);
      if (n >= 4) loadedOSMTiles.add(k); // これ以上は建物生成をブロックしない(道路は背景で取得を続ける)
      fetchedOSMTiles.delete(k); // 常に再試行対象に戻す(checkOSMTiles が再度キューに積む)
    });
    // 現在地タイルが4回失敗して「諦めて先に進む」扱いになった場合も、sticky状態のトーストを
    // 出しっぱなしにしない(Overpass不調が長引くと「🗺 マップを読み込み中...」が永久に残るため)。
    if (awaitingDestinationLoad && loadedOSMTiles.has(ptKey)) {
      awaitingDestinationLoad = false;
      showToast('⚠️ 地図取得が一部失敗しました(背景で再試行を続けます)', { duration: 4000 });
    }
  } finally {
    clearTimeout(timeoutId); // 成功時に残ったタイマー自体の掃除(abort()は既に完了済みのfetchには無害)
  }
  // 失敗するたびに待ち時間を延ばす(最大30秒)。連続失敗中の無駄な連打を防ぎつつ、
  // 一時的な混雑が収まれば自動的に復帰して歯抜けが埋まる。
  // (成功時はプロキシ側で既にレート制限済みなので、このワーカーはすぐ次のバッチへ)
  const maxN = keys.reduce((m, k) => Math.max(m, osmTileFailCount.get(k) || 0), 0);
  await new Promise(r => setTimeout(r, failed ? Math.min(30000, 3000 * maxN) : 200));
  osmTileActiveCount--;
  processOSMTileQueue(); // この枠が空いたので、キューに残りがあれば次を拾う
}

// 【2026-07-16】現在地タイルの「描写完了」監視。約1.5秒ごとに、(1)現在地タイルの
// 道路データ確定(loadedOSMTiles)、(2)現在地タイル内の道路メッシュ待ち、(3)現在地タイル内の
// 建物生成待ち、をチェックし、どれかが残っていれば_curTileRushを立てる。part9の生成ループが
// これを見て、初期ラッシュと同じ拡大予算(建物400棟/14ms・道路優先の絞り緩和)で最優先処理する。
// 順序自体は既存のゲート(地形→道路確定→建物のosmTilesReadyAround等)がタイル内でも守る。
// 取得側の優先は既存の距離ソート(現在地タイル=距離0で常に先頭)+未確定時の1枚クエリで担保済み。
let _curTileRush = false;
let _curTileRushFrame = 0;
function checkCurrentTileRush() {
  _curTileRushFrame++;
  if (_curTileRushFrame % 90 !== 0) return;
  const T = OSM_TILE_M;
  const tx = Math.floor(player.position.x / T), tz = Math.floor(player.position.z / T);
  let rush = !loadedOSMTiles.has(tx + ',' + tz);
  if (!rush) {
    for (const r of pendingRoadMeshes) {
      if (Math.floor((r.x1 + r.x2) / 2 / T) === tx && Math.floor((r.z1 + r.z2) / 2 / T) === tz) { rush = true; break; }
    }
  }
  if (!rush) {
    for (let i = pendingBuildingIdx; i < pendingBuildings.length; i++) {
      const b = pendingBuildings[i];
      if (Math.floor(b.x / T) === tx && Math.floor(b.z / T) === tz) { rush = true; break; }
    }
  }
  _curTileRush = rush;
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
  // 【2026-07-16】7x7(49タイル)→5x5(25タイル)に縮小。ジャンプ直後の初期バックログが
  // 半減し、近傍タイルの取得完了(=プレイ可能になるまでの体感待ち)が大幅に早くなる。
  // 5x5でも最低±3200mをカバーし、道路のアンロード距離(ROAD_UNLOAD_DIST=2500m)・
  // 実建物生成距離(BUILDING_GEN_DIST_REAL=3000m)より広いので描写の穴は生じない。
  // 進行方向の追加先読み(下)は従来どおり効くため、移動中の端到達も従来と変わらない。
  // 先読み半径はパフォーマンス設定に連動(標準2=5×5。高品質は3=7×7で実建物4200mをカバー)
  const _pfR = PERF.prefetchR;
  for (let dx = -_pfR; dx <= _pfR; dx++)
    for (let dz = -_pfR; dz <= _pfR; dz++)
      queueTile(px + dx * OSM_TILE_M, pz + dz * OSM_TILE_M);
  // 進行方向にさらに先まで先読み(移動中に描写の端へぶつからないように)
  const flen = Math.hypot(fdx, fdz);
  if (flen > 1) {
    const ux = fdx / flen, uz = fdz / flen, perpx = -uz, perpz = ux;
    // 進行方向の単位ベクトルを保存し、fetchOSMTileBatchの取得順ソートで前方を優先させる
    _osmMoveUx = ux; _osmMoveUz = uz;
    // 【2026-07-16】k=4..6 → 3..6。基本先読みを7×7(半径3)→5×5(半径2)へ縮めた際、
    // ここが4始まりのままだと「3タイル先」のリングだけ誰も積まない穴になり、
    // 移動し続けると密集地のフェッチ遅延に追いついて道路の未生成端にぶつかっていた。
    for (let k = 3; k <= 6; k++)
      for (let s = -1; s <= 1; s++)
        queueTile(px + (ux * k + perpx * s) * OSM_TILE_M, pz + (uz * k + perpz * s) * OSM_TILE_M);
  } else {
    _osmMoveUx = 0; _osmMoveUz = 0; // 停止中は方向バイアス無し(純粋な距離順)
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
  //  0) 本物のOSM建物のフットプリント(中心±w/2,d/2+余白)に候補地点自体が入っている →
  //     landuse判定より前に、無条件で建てない(【重要・2026-07-16】東京駅周辺で
  //     landuse=residentialの粗いゾーニングが実際には大きな商業ビルの敷地まで覆っており、
  //     3)の分岐が本物の建物の有無を一切見ずに無条件でtrueを返してしまうため、procedural-
  //     infill-race対策のknownBuildingGrid導入後も一戸建てが本物の建物に重なって
  //     生成され続けていた。詳細は[[project_isehara_game_procedural_infill_race]]参照)。
  //  1) inAvoid → 田畑・山林・公園・水域には絶対に建てない
  //  2) landuseがindustrial/commercial/retail/mixed_use → 工場・商業地には建てない
  //  3) landuse=residential → 建ててよい(実データの裏付けあり)
  //  4) 近く(60m)に本物の(工場・店舗でない)建物がある → 建ててよい
  //  5) landuseタグが一切無い(lu===null。1)で回避対象でもない)土地に限り、
  //     周辺の道路が格子状+近くに実建物があるというチャンク単位の状況証拠(denseArea)
  //     を根拠に補完してよいことにする。工場・商業・農地・山林・公園・水域は1)2)で
  //     既に弾かれているので、ここが誤って工場等に効くことはない。
  const buildable = (qx, qz) => {
    if (isInsideKnownRealBuilding(qx, qz)) return false;
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
    // 【2026-07-16】手続き生成は「低層住宅のみ」に限定(ユーザー方針: 中規模以上の建物は
    // OSMマップデータに掲載されている前提を置く)。商業・工業系landuseの手続き充填
    // (12〜50m幅・8〜24m高のビル・工場の自動生成)は廃止し、実データの無い空白は
    // 空き地のままにする。日本のOSMは住宅の掲載漏れが多い一方、中規模以上の建物は
    // ほぼ掲載されているため、この前提の方が実景に近い。
    if (!isRes) continue;
    const step = 14, fillRate = 0.65;

    for (let bx = worldX; bx < worldX + CHUNK_SIZE; bx += step) {
      for (let bz = worldZ; bz < worldZ + CHUNK_SIZE; bz += step) {
        if (!pointInPolygon(bx, bz, poly.pts)) continue;
        if (Math.random() > fillRate) continue;
        const jx = bx + (Math.random()-0.5)*step*0.4;
        const jz = bz + (Math.random()-0.5)*step*0.4;
        if (inAvoid(jx, jz)) continue; // 田畑・森・公園・水域は埋めない
        // 【重要・2026-07-16】このループはbuildable()を通らずlanduseポリゴン全体を直接
        // グリッド充填するため、isInsideKnownRealBuildingのガードが効いていなかった。
        // hasBuildingNearby(既存建物との数m間隔の空け)だけでは、本物の大きい建物の
        // フットプリント内に手続き生成の建物が重なって生成されるのを防げない
        // (東京駅周辺での住宅密集バグの主因の一つ。[[project_isehara_game_procedural_infill_race]])。
        if (isInsideKnownRealBuilding(jx, jz)) continue;
        const bw = 7+Math.random()*5;
        const bd = 6.5+Math.random()*4.5;
        if (isOnRoad(jx, jz, bw, bd)) continue;
        if (hasBuildingNearby(jx, jz, Math.max(bw,bd)/2+1.5)) continue;
        // 低層住宅のみ: ほぼ2階建て(低層アパート枝・classifyResidentialによる
        // マンション/オフィス昇格・applySizeFloorの大型化は手続き生成では行わない)
        const bh = 4+Math.random()*3.5;
        addBuilding(jx, jz, bw, bd, bh, { color:0xc8a060, roofColor:0x8a5828, type:'house' });
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
        // 【2026-07-16】低層住宅のみ: 8m超(3階以上)の枝とマンション昇格を廃止
        const bh = 4 + Math.random() * 3.5;
        addBuilding(jx, jz, bw, bd, bh, { color: pal.w, roofColor: pal.r, type: 'house' });
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
// 指定点の周囲pad(m)がかかる全OSMタイルの道路が確定済みか。
// 【2026-07-16】「地形→道路・線路→建物」の順序をタイル境界でも守るための共通ゲート。
// 自タイルの道路はprocessTileDataで建物より先に同期登録されるが、タイル境界から
// pad以内の場所は隣タイルの道路が後から届く可能性があり、それを知らずに建物を
// 生成するとisOnRoad/fitRealBuildingToRoadsが道路を避けられず被りが起きる。
// padは「最大道路半幅+マージン」を意図した64m(1タイル1600mに対して十分小さいので、
// 境界付近の建物・チャンクだけが隣タイルを追加で待つことになる)。
function osmTilesReadyAround(x, z, pad) {
  const t0x = Math.floor((x - pad) / OSM_TILE_M), t1x = Math.floor((x + pad) / OSM_TILE_M);
  const t0z = Math.floor((z - pad) / OSM_TILE_M), t1z = Math.floor((z + pad) / OSM_TILE_M);
  for (let tx = t0x; tx <= t1x; tx++) for (let tz = t0z; tz <= t1z; tz++) {
    if (!loadedOSMTiles.has(`${tx},${tz}`)) return false;
  }
  return true;
}
function chunkTilesReady(chunkX, chunkZ) {
  // 【2026-07-16】以前はチャンクの四隅が乗るタイルだけ確認しており、境界から60m内側を
  // 通る隣タイルの道路を待たずに手続き生成が走るレースがあった。余白64m込みで待つ。
  const cx = chunkX * CHUNK_SIZE + CHUNK_SIZE / 2, cz = chunkZ * CHUNK_SIZE + CHUNK_SIZE / 2;
  return osmTilesReadyAround(cx, cz, CHUNK_SIZE / 2 + 64);
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
