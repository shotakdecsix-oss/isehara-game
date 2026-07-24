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
const queuedTiles = new Set();   // キュー投入済み(取得中 or 取得完了)のタイル
const roadReadyTiles = new Set();    // 実際に処理が完了した(道路が確定した)タイル。
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
// 【2026-07-19・実験→撤回】private.coffeeメイン化に合わせて5へ上げたが、実機Renderログで
// private.coffee/kumi.systemsが常時タイムアウトし、実質ほぼ全リクエストがoverpass-api.de
// (公式に2並列/IPの制限)に集中していたことが判明。3のままの方が安全なので戻す。
// 【2026-07-21・Fable5相談+PowerShell/Node実測】単発逐次でも3回目で429、2並列・3並列
// どちらも即全滅という実測結果から、支配要因は並列数そのものではなくスロット時間
// (クエリ実行時間+負荷比例のクールダウン)と判明。ただし3本目は空きスロットが無い限り
// ほぼ確実に429になる「無駄弾」でしかなく、failカウントとクールダウンを無駄に進めるだけ
// なので、実測で確認済みの公式上限(2/IP)に合わせて2に下げてデプロイした。
// 【2026-07-21・実機報告で巻き戻し】2に下げた後、密集地で足元含む多数のタイルが
// fetchingのまま進まない・体感が悪化したという実機報告を受けた。overpass-api.deは
// 複数バックエンドへのDNSラウンドロビン構成の疑いがあり(/api/statusのConnected as/
// Announced endpointがリクエストごとに変わった実測あり)、3本目が必ずしも同一サーバーの
// 同じ2スロットに当たるとは限らず、理論上の「無駄弾」ほど実害が無い可能性がある。
// 実機の体感を優先し、一旦3に戻す。悪化しなければ3のまま様子見、再度悪化が確認できれば
// 2に戻す。
const OSM_TILE_CONCURRENCY = 3;
let osmTileActiveCount = 0;
// 【2026-07-25・ユーザー報告】近傍タイルが5分以上fetchingのまま進まない不具合の診断用。
// これまでのwaitMs(=キュー投入からの経過)だけでは「まだ順番待ちなだけ」と「実際に
// fetchが開始されたのに終わらない(タイムアウトが機能していない/サーバー側ハング)」を
// 区別できなかった。実際にfetchOSMTileBatchへ入ってからの経過時間を別途記録し、
// [fetch]ログでmaxActiveAgeMsとして出す。これがtileTimeoutMs(現在地70秒/他34-54秒)を
// 大きく超えているなら、AbortControllerのタイムアウトが機能せず本当にハングしている
// ことの直接証拠になる。
const _activeFetchStarts = new Map(); // 一意キー → fetchOSMTileBatch開始時刻(Date.now())
let _activeFetchSeq = 0;
// 【2026-07-25・ユーザー報告(マップジャンプ後の停滞)対応】各fetchのAbortControllerを
// 一意キーで保持しておき、マップジャンプ(location.reload直前)に全部まとめてabort()できる
// ようにする。ジャンプ前の場所のタイル取得は新しい場所には無関係なので、明示的に切断して
// 早期に諦めさせ、サーバー側のisAbandoned判定(req切断検知)が早く効くようにする狙い。
const _activeFetchAborts = new Map(); // 一意キー → AbortController
function abortAllOSMFetches() {
  for (const ctl of _activeFetchAborts.values()) { try { ctl.abort(); } catch (e) {} }
}
// 【2026-07-25・ユーザー報告(300km未満の近距離ジャンプでも同じ詰まりが出る)対応】
// 遠距離ジャンプ(location.reload)はクライアント側の状態が丸ごと作り直されるが、
// 近距離ジャンプ(location.reloadしない方の分岐、jumpToLatLon)は同じJS実行環境の
// ままプレイヤー位置だけ動かすため、前の場所の未処理タイル(osmTileQueue)や
// 失敗・backoff履歴がそのまま残り続け、新しい場所のタイルがその後ろに並んで
// 詰まって見えていた。ジャンプ時にこの「タイル取得の待ち行列」だけを明示的に
// 空にし、新しい場所の分をcheckOSMTilesにいちから積み直させる。
// roadReadyTiles(既に取得済みの記録)は消さない(誤って再取得させる必要は無く、
// 実害も無いキャッシュのため)。
function resetOSMTileQueueForJump() {
  abortAllOSMFetches(); // 前の場所を追いかけている進行中のfetchを中断
  osmTileQueue.length = 0; // 未処理の待ち行列を空に(新しい場所はcheckOSMTilesが積み直す)
  queuedTiles.clear();
  osmTileFailCount.clear();
  osmTileHardFailCount.clear();
  osmTileNextRetryAt.clear();
  osmTileQueuedAt.clear();
  gaveUpTiles.clear();
  osmTileTimeoutBoost.clear();
}
let _osmMoveUx = 0, _osmMoveUz = 0; // プレイヤーの進行方向(単位ベクトル)。取得順の前方優先に使う
const osmTileFailCount = new Map(); // タイルごとの失敗回数(3回まで再試行)
// 【2026-07-21・ユーザー要望】道路生成の遅延診断用: タイルが新規キュー投入された時刻。
// fetching状態が何ms続いているか(キュー優先順位の問題か、取得自体に時間がかかっているだけか)
// をデバッグオーバーレイで見えるようにする。
const osmTileQueuedAt = new Map();
// 【2026-07-21・gaveUp判定の再設計(修正5)】以前はosmTileFailCountが4に達すると理由を問わず
// 「このタイルは諦めて建物生成をブロックしない」扱いにしていたが、429/502/504のような
// インフラ側の一時障害まで同じカウンタに算入されてしまい、429ストーム中は移動中の足元タイルが
// 本来のデータ問題ではないのに次々「諦め」に入っていた(先読み3枚バッチの失敗で3タイル分
// まとめてカウントされる前借りも重なる)。osmTileFailCount自体はバックオフ・バッチ縮小判定
// (nextFailCount)に使い続けるため挙動を変えず、「本当に諦めるべきか」の判定だけを
// 新しいカウンタ(インフラ障害を数えない・1枚クエリの失敗だけ数える)に分離する。
const osmTileHardFailCount = new Map();
const gaveUpTiles = new Set(); // 「諦めて建物生成ブロックを解除した」タイル(デバッグオーバーレイの紫と対応)
// 【2026-07-17・Fable5診断】タイルごとの「次回再試行可能時刻」(ms epoch)。以前は失敗時に
// ワーカーがconcurrency枠を握ったままsleepしていたが、これを撤去して枠は即座に解放し、
// 代わりにこのMapで各タイルの再試行間隔だけを管理する(下記fetchOSMTileBatch/processOSMTileQueue参照)。
const osmTileNextRetryAt = new Map();
// 【2026-07-21・実機ログ分析】移動を続けるとoverpass-api.deへの直接fetch(下記
// fetchOSMTileBatch)が429(Too Many Requests)や502/504を連発する時間帯があり、その間
// タイルが一切届かず生成が止まっていた。上のosmTileNextRetryAtは「タイル単位」の
// バックオフだが、429はサーバー側のレート制限(IP単位)なので、他のタイルを叩き続けても
// 429が続くだけで429ストームを自ら維持してしまう。タイル単位とは別に、全タイル共通の
// 「今は一切叩かない」グローバル・クールダウンを設ける。
// 【注】このfetchはブラウザからoverpass-api.deへ直接飛んでおり、サーバー経由のプロキシは
// 介在しない(server/server.jsのpaceThrough/ミラー輪番はこの呼び出しには使われていない、
// 別チャットの分析メモにあった「プロキシも502」という記述はこの経路には該当しない)。
let osmGlobalCooldownUntil = 0;
let _osm429Streak = 0;
// 【2026-07-21・Fable5相談】宣言timeoutを短縮した(下記buildOSMBatchQuery)ことで、
// 通常はスロット占有時間(≒クールダウン)を縮められる。ただしOverpass側の実処理が
// 短縮後の宣言値を超えて正常に進行中だった場合(504・remarkのtimed out)は、正常処理を
// 打ち切ってしまった可能性があるため、そのタイルの次回試行だけは従来の長い宣言値へ
// 一時的に戻す(=無限に短いtimeoutで再試行し続けて同じ理由で失敗し続けることを防ぐ)。
// 成功したら通常の短い宣言値に戻す(下のkeys.forEachでdelete)。
const osmTileTimeoutBoost = new Set();
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
// 【2026-07-21・Fable5診断(v2)】以前は単純な配列で、reactivateNearbyDormantBuildingsが
// 末尾(=直近dormant入りした建物)から走査していたため、古くから待っている近傍の建物に
// 予算が永遠に回らない「LIFO飢餓」を起こしていた(密集地で特定タイルのbuildPendingが
// 何十秒経っても数字ごと不変のまま固まる不具合の直接原因)。プレイヤーに近いセルから
// 優先的に復帰させられるよう、200m四方の空間グリッドで管理する。
const DORMANT_CELL = 200;
const dormantGrid = new Map(); // "gx,gz" -> 建物記述子の配列
let dormantCount = 0; // dormantGrid内の総数(逐次カウンタ。ログ表示・空判定用)
function dormantAdd(b) {
  const key = Math.floor(b.x / DORMANT_CELL) + ',' + Math.floor(b.z / DORMANT_CELL);
  let arr = dormantGrid.get(key);
  if (!arr) { arr = []; dormantGrid.set(key, arr); }
  arr.push(b);
  dormantCount++;
}

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

// 舗装/未舗装の判別用(OSM surfaceタグ)。タグが無い場合はhighway種別からの推定にフォールバックする。
const UNPAVED_SURFACES = new Set(['unpaved','dirt','earth','ground','gravel','fine_gravel','grass','sand','mud','pebblestone','compacted','woodchips','clay','grass_paver']);

function processTileData(data, tileCount) {
  if (!data || !data.elements) return;
  // building=タグを持つrelation(マルチポリゴン)をway相当の疑似要素に変換し、既存のbuilding
  // 処理に合流させる(part2.js synthesizeBuildingRelationWays参照。地図上に見える
  // 大きな建物枠が生成システムに一切渡っていなかった不具合の対策)。
  const buildingElements8 = data.elements.concat(synthesizeBuildingRelationWays(data.elements, seenOSMRelations));
  // 国別プロファイル(タグ実測値が無い箇所のフォールバックにのみ使う)。
  // 【2026-07-17】ここでのbuildingElements8全体の被覆率判定(local density override)は
  // 撤去済み(part2.js localDensityProfileAt参照。実測タグの忠実度向上により不要と判断)。
  const cprofH8Base = MODE === 'real' ? getCountryBuildingProfile(currentCountryCode) : null;
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
      let type = hw==='motorway' ? 'motorway' : hw==='motorway_link' ? 'trunk'
                 : (hw==='trunk'||hw==='primary'||hw==='secondary'||hw==='tertiary') ? hw : 'road';
      if (USES_MEIJI_LANDUSE && (type === 'road' || type === 'motorway')) return; // 明治・江戸: 細街路も高速道路もない
      if (MODE === 'space' && (type === 'road' || type === 'tertiary' || type === 'secondary')) return; // 宇宙: 鉄道・高速道路・国道(幹線)以外の小さな道路は出さない
      // 細街路のみ舗装/未舗装を見た目に反映(幹線級は現実にほぼ全て舗装のため対象外)。
      // surfaceタグがあればそれに従い、無ければhighway=track/pathのみ未舗装と推定する。
      if (type === 'road') {
        const sf = tags.surface;
        const unpaved = sf ? UNPAVED_SURFACES.has(sf) : (hw === 'track' || hw === 'path');
        if (unpaved) type = 'unpaved';
      }
      // 【2026-07-21・橋対応】OSMのbridge=yes(等)が付いたウェイは、地形(実標高)を
      // そのままサンプリングすると川底/谷底の低い値を拾って沈んで見える(motorwayは
      // 元々addMotorwayで常時高架化されるため対象外)。ウェイ全体の入口・出口2点の座標
      // だけを覚えておき(高さそのものはmakeRoadGeoが構築のたびに取り直す。part3.js参照)、
      // その間を道なり距離の割合で線形補間した高さを使うことで、地形の細かい起伏サンプリング
      // を完全に避けつつ、橋の前後の道路(=入口・出口そのものの地形高さ)とは値が一致する
      // ため継ぎ目なく繋がる。水域に限らず(谷・線路またぎ等)全ての橋に同じロジックを
      // 適用する。OSMには橋の絶対高さ(標高)を示すタグが実質存在しないため、既定はこの
      // 補間に任せる。
      const isBridge = type !== 'motorway' && tags.bridge && tags.bridge !== 'no';
      let bridgeAx = 0, bridgeAz = 0, bridgeBx = 0, bridgeBz = 0, bridgeCum = null, bridgeTotalLen = 0;
      if (isBridge) {
        const pts = el.geometry.map(g => latLonToXZ(g.lat, g.lon));
        bridgeCum = [0];
        for (let i = 1; i < pts.length; i++) {
          const ddx = pts[i].x - pts[i-1].x, ddz = pts[i].z - pts[i-1].z;
          bridgeCum.push(bridgeCum[i-1] + Math.sqrt(ddx*ddx + ddz*ddz));
        }
        bridgeTotalLen = bridgeCum[bridgeCum.length - 1];
        bridgeAx = pts[0].x; bridgeAz = pts[0].z;
        bridgeBx = pts[pts.length - 1].x; bridgeBz = pts[pts.length - 1].z;
      }
      for (let i = 0; i < el.geometry.length-1; i++) {
        const a = latLonToXZ(el.geometry[i].lat, el.geometry[i].lon);
        const b = latLonToXZ(el.geometry[i+1].lat, el.geometry[i+1].lon);
        let bridgeY = null;
        if (isBridge && bridgeTotalLen > 0.01) {
          bridgeY = {
            ax: bridgeAx, az: bridgeAz, bx: bridgeBx, bz: bridgeBz,
            fracA: bridgeCum[i] / bridgeTotalLen, fracB: bridgeCum[i+1] / bridgeTotalLen
          };
        }
        addRoad(a.x, a.z, b.x, b.z, width, type, bridgeY);
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
    // 【2026-07-18】野球場・競技場等(国立競技場等)はbuildingタグを持たずleisure=stadium
    // 単独で表現されることが多く、campusと同じ理由でbuildingタグ必須のままだと
    // 丸ごと取りこぼしていた(part2.jsのsynthesizeBuildingRelationWaysの緩和と対になる)。
    const isStadiumOnly = !USES_MEIJI_LANDUSE && !tags.building &&
      (tags.leisure === 'stadium' || tags.amenity === 'stadium');
    if (!tags.building && !isCampusOnly && !isStadiumOnly) return;
    // 【2026-07-16】駅舎は生成しない(ユーザー要望)。線路またぎ建物のdrop(fitRealBuildingToRoads)
    // だけでは線路脇に建つ駅舎が残るため、タグで明示的に除外する。
    if (tags.building === 'train_station' || tags.building === 'station' ||
        tags.railway === 'station' || tags.public_transport === 'station') return;
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
    // 国プロファイルの階数フォールバック・最低階数floor。
    const cprofH8 = localDensityProfileAt(cprofH8Base, cx, cz);
    const [lvMin8, lvMax8] = (cprofH8 && cprofH8.levelsRange) || [1, 3];
    const levels = parseInt(tags['building:levels']) || (lvMin8 + Math.floor(Math.random() * (lvMax8 - lvMin8 + 1)));
    let h = resolvedH != null ? resolvedH : Math.max(levels*3,3)+Math.random()*2;
    h = applyLandmarkMinHeight(style, h); // 学校・病院・役場・神社仏閣は最低限の高さを確保
    const _landmarkType8 = style && (style.type === 'shrine' || style.type === 'temple' || style.type === 'church');
    if (cprofH8 && cprofH8.minLevels && !_landmarkType8) {
      h = Math.max(h, cprofH8.minLevels * 3);
    }
    // 観光ランドマーク(東京タワー等)はOSMタグ由来の階数推定を無視し、実際の高さで確定させる
    // (フットプリントのタグ欠損/誤差の影響を受けず、常に正しいシルエットになるようにするため)
    if (style && style.landmark && LANDMARK_TOWER_HEIGHT[style.landmark] != null) {
      h = LANDMARK_TOWER_HEIGHT[style.landmark];
    }
    // 【2026-07-18】ドーム球場はLANDMARK_MIN_H(開放型スタジアム共通の16m)よりずっと高い
    // (東京ドーム等は実測50m超)。実測タグがそれより高ければそちらを尊重するのでMaxで底上げ。
    if (style && style.type === 'stadium' && style.stadiumDome) {
      h = Math.max(h, STADIUM_DOME_MIN_H);
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
    realBuildingIndexAdd(realRec);
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
  // 【2026-07-21】429/502/504のグローバル・クールダウン中は新規リクエストを一切出さない
  // (osmGlobalCooldownUntil参照。fetchOSMTileBatch側で設定)。クールダウン明けはcheckOSMTiles
  // の周期呼び出し(最大0.5秒後)で自然に再開する。
  if (Date.now() < osmGlobalCooldownUntil) return;
  while (osmTileActiveCount < OSM_TILE_CONCURRENCY && osmTileQueue.length > 0) {
    // 【2026-07-17・Fable5診断】backoff中(osmTileNextRetryAtが未来)のタイルしか
    // 残っていない場合はここでbreakする。以前は失敗時にワーカー自身が枠を握ったまま
    // 最大30秒sleepしていたが、それを撤去して即座に枠解放するようにしたため、
    // ここでチェックせずにfetchOSMTileBatchを呼ぶと「即backoff判定→枠解放→whileが
    // また回る」を同一フレーム内で無限に繰り返し、タブがフリーズしてしまう。
    // 再試行可能なタイルが1件も無ければ、次の機会(checkOSMTilesの周期呼び出し=
    // 最大0.5秒後)まで待つ。
    const now = Date.now();
    const hasEligible = osmTileQueue.some(t => (osmTileNextRetryAt.get(t.tx + ',' + t.tz) || 0) <= now);
    if (!hasEligible) break;
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
function buildOSMBatchQuery(bboxes, boosted) {
  const parts = [];
  for (const clause of OSM_TILE_CLAUSES) for (const bb of bboxes) parts.push(clause + '(' + bb + ');');
  // 【2026-07-21・Fable5相談】宣言timeoutはOverpassのコスト見積り(≒スロット占有時間)に
  // 直結するため、実測(3タイルまとめ≒14秒で完了)に対して十分な余裕を持たせつつ、
  // 従来値(20+n*6、3枚で38秒)より短くしてスロット占有時間を縮める。ただし京橋・八重洲
  // 級の密集地では過去にサーバー側処理が35秒を超えた実績があるため、下げ過ぎて正常処理を
  // 打ち切らないよう15/25秒案より保守的な値に留める。boosted=true(直前にこのタイルが
  // timeout系で失敗した)時だけ従来の長い値にフォールバックする。
  const timeout = boosted
    ? Math.min(60, 20 + bboxes.length * 6) // 従来値(ブースト時のフォールバック)
    : Math.min(40, 15 + bboxes.length * 5); // 通常値(2026-07-21短縮。1枚=20秒、3枚=30秒)
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
// 【2026-07-17・Fable5診断】致命的なキー設計バグを修正: 以前はキーが`tx,tz`(=浮動原点
// からの相対タイル座標)のみだったため、ジャンプでrecenterOrigin(part4.js)が原点を
// 付け替えるたびに「現在地タイル」のtx,tzが毎回0付近に戻り、以前訪れた全く別の都市の
// タイルと衝突していた(例: 香港訪問時に`v1:0,0`で保存 → 後日NYへジャンプ →
// NYの現在地タイルも`0,0`になり香港のデータがヒット → 中身のlat/lonは絶対座標なので
// 変換結果は現在地から遠く離れた場所になり、近傍には何も生成されない。しかもタイルは
// roadReadyTiles入り=取得成功扱いになるため再取得されず、建物生成ゲートだけ外れて
// 水面回避データの無い手続き生成物(木など)が配置される「水上の木」の実体)。
// キーをタイル座標ではなく絶対緯度経度のbbox文字列(下のbboxes[i])に変えることで
// 都市をまたいだ衝突自体を無くす。VERもv2へ上げ、汚染済みの旧キャッシュを一括無効化する。
const OSM_TILE_CACHE_VER = 'v2';
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

// ---- 【2026-07-24追加】設定画面からの明示的な全データクリア用 ----
// 地形/道路/建物そのもの(buildingRecords/roadRecords等)はページ再読み込みだけで確実に
// リセットされる(いずれもモジュールスコープ変数のため)。しかし唯一「再読み込みしても
// 消えないもの」= このIndexedDBタイルキャッシュだけは、壊れた/古い応答を溜め込んでいると
// リロードしても同じ滞留を再現してしまう。そのため明示リフレッシュではこれを丸ごと削除し、
// 現在地の全タイルを新規にOverpassから取り直させる。
function clearOsmTileCache() {
  return new Promise((resolve) => {
    try {
      if (_osmDBPromise) _osmDBPromise.then((db) => { try { if (db) db.close(); } catch (e) {} });
    } catch (e) {}
    _osmDBPromise = null;
    try {
      const req = indexedDB.deleteDatabase('osmTileCache');
      req.onsuccess = () => resolve();
      req.onerror = () => resolve();
      req.onblocked = () => resolve(); // 他タブが開いていて即時削除できなくても、リロード自体は進める
    } catch (e) { resolve(); }
  });
}

// 【2026-07-21・Fable5相談】429を受けた時、実際にあと何秒待てばスロットが空くのかを
// /api/status(このエンドポイント自体はレート制限の消費対象外・軽量)で確認する。
// "Slot available after: <timestamp>, in N seconds." という行が空きスロット数だけ
// 並ぶので、一番早く空く行(最小のN)を採用する。取得・パース失敗時はnullを返し、
// 呼び出し側は既存の指数バックオフのままにする。
async function fetchOverpassSlotWaitMs() {
  try {
    const res = await fetch('https://overpass-api.de/api/status');
    if (!res.ok) return null;
    const text = await res.text();
    const rl = text.match(/Rate limit:\s*(\d+)/);
    const avail = text.match(/(\d+)\s*slots? available now/);
    console.log('[overpass status] rate limit=' + (rl ? rl[1] : '?') + ' available now=' + (avail ? avail[1] : '0'));
    const waits = [...text.matchAll(/in (\d+) seconds/g)].map(m => parseInt(m[1], 10)).filter(Number.isFinite);
    if (waits.length === 0) return null;
    return Math.min(...waits) * 1000;
  } catch (e) {
    return null;
  }
}

async function fetchOSMTileBatch() {
  // プレイヤーに近いタイルを優先(以前はキュー投入順で、進行方向の
  // タイルが後回しになり目の前で道路が途切れたまま待たされていた)
  const ptx = player.position.x / OSM_TILE_M, ptz = player.position.z / OSM_TILE_M;
  // 【2026-07-19】osmTilesReadyAround(part8.js)が建物生成のブロックに使う「現在地から
  // 64m以内にかかる全タイル」の集合。プレイヤーがタイル境界(角)近くに立つと、自タイルの
  // 建物ですらこの中の隣接1〜3タイルの到着待ちになる。他の近傍タイルと同列の優先度だと、
  // たまたま取得順が悪い時に「中心タイルは道路のみで建物が出ない・別方向は完全描写」という
  // 非対称な詰まりが実機で確認された。この集合に入るタイルは常に最優先で取得する。
  const _blockPad = 64;
  const _bx0 = Math.floor((player.position.x - _blockPad) / OSM_TILE_M), _bx1 = Math.floor((player.position.x + _blockPad) / OSM_TILE_M);
  const _bz0 = Math.floor((player.position.z - _blockPad) / OSM_TILE_M), _bz1 = Math.floor((player.position.z + _blockPad) / OSM_TILE_M);
  const _blockingTiles = new Set();
  for (let tx = _bx0; tx <= _bx1; tx++) for (let tz = _bz0; tz <= _bz1; tz++) _blockingTiles.add(tx + ',' + tz);
  // 【2026-07-19】ユーザー報告: デバッグオーバーレイで見ると、取得待ち(赤)のタイルが
  // 現在地から離れた場所(先読み5x5・進行方向先読み分)まで一度に広がりすぎていて、
  // 3並列(OSM_TILE_CONCURRENCY)がそちらにも分散してしまっていた。現在地タイル中心の
  // 近傍3x3(9枚、「5〜10個くらい」の要望に合わせた範囲)は、外側・進行方向先読みタイルより
  // 常に先に取得されるようスコアを優遇する。近傍が尽きれば(全部ready or backoff中)、
  // 自然と外側タイルの番が回ってくる(sort+splice方式なのでハードな足止めは不要)。
  // 【2026-07-21・ユーザー報告】3x3(距離1)だと、テーブル上は現在地のすぐ隣に見えるタイルが
  // 近傍優先の枠外(遠方タイルと同列)になり、Overpass混雑時に数分単位で放置される事例を確認
  // (例: 22,-21が219秒待ち)。5x5(距離2)へ拡大し、体感上「近い」と感じる範囲をカバーする。
  const NEAR_TIER_R = 2; // Chebyshev距離2以内 = 5x5 = 25枚
  const _pTileX = Math.floor(player.position.x / OSM_TILE_M), _pTileZ = Math.floor(player.position.z / OSM_TILE_M);
  // 【2026-07-16】距離のみのソートだと真後ろと真正面のタイルが同順位になり、移動中に
  // 前方タイルが後回しになることがあった。進行方向(checkOSMTilesで更新される
  // _osmMoveUx/Uz)への射影ぶんスコアを引いて、同距離なら前方を必ず先に取得する。
  // 係数0.8: 前方1タイル先 ≒ 横0.8タイルぶん優先(後方タイルは射影が負なので不利になる)。
  const _tileScore = (t) => {
    const dx = t.tx + 0.5 - ptx, dz = t.tz + 0.5 - ptz;
    const base = Math.abs(dx) + Math.abs(dz) - (dx * _osmMoveUx + dz * _osmMoveUz) * 0.8;
    // 【2026-07-21・ユーザー報告】距離だけのスコアだと、プレイヤーが動き続ける限り新しく
    // 近傍に入ってくるタイルが毎回優先され、外側のタイルが理論上いつまでも後回しにされる
    // 「飢餓」が起きうる(実機ログで、あるタイルが8分近くfetchingのまま一度も取得を
    // 試みられていないことを確認)。
    // 【2026-07-21・ユーザー指摘で修正】最初の実装はエイジング・ボーナスが階層(最優先/近傍/
    // それ以外)を跨いで逆転しうる式になっており、「60秒待った遠方タイル」が「待ち時間0の
    // 近傍タイル」より優先されてしまっていた。これは近傍優先という設計の趣旨に反する
    // (体感を左右するのは常に近傍なので、そこは待ち時間に関わらず最優先であるべき)。
    // 階層そのものを大きく離れたオフセット(0 / -10000 / -100000)で分離し、エイジングは
    // 「同じ階層内でのタイブレーク」だけに使う(最大でも100。階層間の10000ギャップより
    // 十分小さく、階層を跨いでの逆転は起こり得ない)。これにより、外側タイル同士の中で
    // 「一番待たされている物」が優先されるようになり(=特定タイルだけが恒常的に
    // 後回しにされ続ける飢餓は解消)、近傍優先の原則自体は変えない。
    const _tk = t.tx + ',' + t.tz;
    const waitedMs = Date.now() - (osmTileQueuedAt.get(_tk) || Date.now());
    const agingTiebreak = Math.min(100, waitedMs / 600); // 60秒で頭打ち、最大100(階層間ギャップ10000より十分小さい)
    if (_blockingTiles.has(_tk)) return base - agingTiebreak - 100000; // 建物生成を直接ブロックしている分は最優先
    if (Math.abs(t.tx - _pTileX) <= NEAR_TIER_R && Math.abs(t.tz - _pTileZ) <= NEAR_TIER_R) return base - agingTiebreak - 10000; // 近傍3x3は外側より先
    return base - agingTiebreak;
  };
  // 【2026-07-17・Fable5診断】距離だけでなく、backoff中(osmTileNextRetryAtが未来)の
  // タイルは近さに関係なく後ろへ回す。以前は「近い順」だけだったため、直近で失敗した
  // 近傍タイルが再試行間隔を無視して毎回先頭に来て連打されてしまっていた。
  const _now = Date.now();
  const _tileKey = (t) => t.tx + ',' + t.tz;
  osmTileQueue.sort((a, b) => {
    const ra = (osmTileNextRetryAt.get(_tileKey(a)) || 0) > _now ? 1 : 0;
    const rb = (osmTileNextRetryAt.get(_tileKey(b)) || 0) > _now ? 1 : 0;
    if (ra !== rb) return ra - rb;
    return _tileScore(a) - _tileScore(b);
  });
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
  // 繰り返し、4回失敗すると諦めてroadReadyTiles扱いにしてしまい、実データが永久に
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
  // 【2026-07-16】プレイヤー近傍のタイルは常に1枚クエリ。実測で1枚=1〜1.5秒、
  // 3枚まとめ=10〜30秒(密集地)なので、体感を決める近傍タイルだけ小さく速く取る。
  // 1枚クエリはIndexedDBキャッシュの対象にもなる(キャッシュはタイル単位のため)。
  // 外周のタイルは従来どおり3枚まとめでリクエスト数を抑える。
  // 【2026-07-25修正】当初は3×3圏(距離1.6)だけを対象にしていたが、その後スコアリング側の
  // 近傍優先(_tileScore内のNEAR_TIER_R=5×5・距離2)を先に拡張した際、こちらの1枚クエリ範囲を
  // 揃え忘れていた。結果、5×5の外周(距離2)は「優先度は最優先なのに実際のクエリは重い
  // 3枚まとめ」という不整合を抱え、そこが失敗・再試行を繰り返して3並列の枠を占有し続け、
  // 近傍のはずのタイルがいつまでも赤(fetching)のまま進まない実機報告につながった。
  // NEAR_TIER_Rに揃え、近傍5×5は丸ごと軽量な1枚クエリにする。
  const nearSolo = nextTile && Math.max(Math.abs(nextTile.tx - _pTileX), Math.abs(nextTile.tz - _pTileZ)) <= NEAR_TIER_R;
  let batchSize = (!roadReadyTiles.has(ptKey) || nextFailCount >= 2 || nearSolo) ? 1 : OSM_TILE_BATCH;
  // 【2026-07-17・Fable5診断】上のソートでbackoff中のタイルは後ろへ回しているが、
  // 先頭からbatchSize件がたまたまbackoff中のタイルを含んでしまう(=eligibleが
  // batchSize未満しか無い)場合に備え、先頭からの「再試行可能な連続数」に丸める
  // (processOSMTileQueue側で先頭1件は必ず再試行可能であることを保証済み)。
  let eligibleRun = 0;
  for (const t of osmTileQueue) {
    if ((osmTileNextRetryAt.get(_tileKey(t)) || 0) > _now) break;
    eligibleRun++;
  }
  batchSize = Math.max(1, Math.min(batchSize, eligibleRun));
  const batch = osmTileQueue.splice(0, batchSize); // 近い順(backoff中は後回し)
  const keys = batch.map(({tx, tz}) => `${tx},${tz}`);
  // 【2026-07-25・診断計器】このバッチの処理に実際どれだけ時間がかかっているかを追跡する
  // (finally節で必ず削除。ハング診断用なのでtry本体より前、失敗しうる処理より先に置く)
  const _fetchStartKey = (++_activeFetchSeq) + ':' + keys.join('|');
  _activeFetchStarts.set(_fetchStartKey, Date.now());
  const bboxes = batch.map(({tx, tz}) => {
    const worldX0 = tx * OSM_TILE_M, worldZ0 = tz * OSM_TILE_M;
    const ll00 = xzToLatLon(worldX0, worldZ0);
    const ll11 = xzToLatLon(worldX0 + OSM_TILE_M, worldZ0 + OSM_TILE_M);
    const minLat = Math.min(ll00.lat, ll11.lat), maxLat = Math.max(ll00.lat, ll11.lat);
    const minLon = Math.min(ll00.lon, ll11.lon), maxLon = Math.max(ll00.lon, ll11.lon);
    return `${minLat.toFixed(5)},${minLon.toFixed(5)},${maxLat.toFixed(5)},${maxLon.toFixed(5)}`;
  });
  // 【2026-07-21・実機報告】足元(現在地=ptKeyを含むバッチ、常に1枚クエリ)は生成体感を
  // 直接左右するため、timeout短縮の対象から常に除外する(=従来通りの長いtimeout宣言を
  // 使う)。短縮版(20秒)のまま今の混雑状況に晒すと、正常処理中の足元クエリが打ち切られ→
  // ブースト(長いtimeout)での再試行という往復が発生し、以前より足元の道路・建物表示が
  // 遅れる退行を実機で確認した。短縮によるスロット節約は、体感への影響が小さい周辺・
  // 遠方タイル(3枚まとめ等)側だけで十分。
  const boosted = keys.includes(ptKey) || keys.some(k => osmTileTimeoutBoost.has(k));
  const { query, timeout: osmTimeoutSec } = buildOSMBatchQuery(bboxes, boosted);
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
  // 【2026-07-17・Fable5診断で発見】1枚クエリだけ固定20秒でabortしていたが、
  // buildOSMBatchQueryは1タイル時もtimeout:26を指定しており、本来は34秒(26+8)の
  // 猶予が必要だった。密集地は計算+転送で20秒を超えることがあり、Overpassが
  // 正常に処理中のクエリを「失敗」として扱って無限再試行させていた(ジャンプ直後は
  // 現在地未確定+近傍が常に1枚クエリになるため、近傍だけがこのバグを踏み続け、
  // 遠方の3枚まとめ(46秒猶予、式は同じ)だけが正常に通っていた=「遠景だけ出る」の実体)。
  // 1枚・複数枚を問わず同じ式に統一する。
  // 【2026-07-20】サーバー側はcacheKeySourceが同じリクエストを1本のinflight Promiseに
  // 束ねているため、クライアントが34秒でabortして再試行しても、サーバー内部で進行中の
  // 同一Overpass取得処理自体は止まらず継続する(Renderログ実測: 同一タイルの応答が
  // 最大881秒かかったケースでも最終的に200で成功していた)。つまり現在地タイルが
  // 4回連続失敗する主因は「データが本当に取れない」のではなく「クライアントの我慢が
  // サーバーの実際の処理時間より短く、進行中の応答を毎回取りこぼしている」可能性が高い。
  // 現在地タイル(ptKeyを含むバッチ)に限り、サーバー側の1回の再試行チェーン
  // (プライマリmirror: 45秒×最大2回=最大91.5秒)をある程度カバーできるよう
  // 猶予を70秒まで伸ばす。他タイル(周辺・遠方)は従来通りの短い猶予のまま。
  const _curTileInBatch = keys.includes(ptKey);
  const tileTimeoutMs = _curTileInBatch ? Math.max(osmTimeoutSec * 1000 + 8000, 70000) : osmTimeoutSec * 1000 + 8000;
  const abortCtl = new AbortController();
  const timeoutId = setTimeout(() => abortCtl.abort(), tileTimeoutMs);
  _activeFetchAborts.set(_fetchStartKey, abortCtl); // マップジャンプ時の一斉abort対象に登録
  try {
    // 1枚クエリはまずIndexedDBキャッシュを照会(ヒットなら即時復元・ネットワーク不要)
    if (batch.length === 1) {
      // 【2026-07-17・Fable5診断】キーはkeys[0](tx,tz=浮動原点からの相対座標)ではなく
      // bboxes[0](絶対緯度経度)を使う。原点はジャンプごとに付け替わるため、相対座標を
      // キーにすると別都市のタイルと衝突していた(詳細はOSM_TILE_CACHE_VER宣言部参照)。
      const cached = await osmCacheGet(bboxes[0]);
      if (cached) {
        processTileData(cached, 1);
        osmTileFailCount.delete(keys[0]);
        roadReadyTiles.add(keys[0]);
        // 【2026-07-19】以前はkeys.includes(ptKey)=自タイル1枚が届いた時点で「表示しました」に
        // 差し替えていたが、建物はosmTilesReadyAround(64m)で隣接タイルも待つため、トーストが
        // 消えた後も建物だけしばらく生成されない「表示は完了なのに実際は空」の乖離があった
        // (体感の悪化として報告された逆ドーナツ症状の一因)。建物が実際に生成可能になる条件と
        // 揃え、隣接ブロックタイルも含めて揃ってから完了表示にする。
        if (awaitingDestinationLoad && osmTilesReadyAround(player.position.x, player.position.z, 64)) {
          awaitingDestinationLoad = false;
          showToast(t('mapShownToast'), { duration: 3000 });
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
    if (!res.ok) {
      // 【2026-07-21】429(レート制限)/502/504(上流不調)を受けた時だけ、全タイル共通の
      // グローバル・クールダウンを設定する。個別タイルのbackoff(osmTileNextRetryAt)とは別物:
      // あちらは「このタイルを次いつ叩けるか」、こちらは「今は誰も何も叩かない」というブレーキ。
      // これが無いと、429を受けている間も他のタイルが3並列で叩き続けて429ストームを
      // 自ら維持してしまっていた(実機ログで確認)。
      if (res.status === 429 || res.status === 502 || res.status === 504) {
        _osm429Streak++;
        const ra = parseInt(res.headers.get('Retry-After'), 10); // 429にはRetry-Afterが付くことがある
        const backoff = Number.isFinite(ra) ? ra * 1000
          : Math.min(120000, 30000 * Math.pow(2, _osm429Streak - 1)); // 30s→60s→120s上限
        osmGlobalCooldownUntil = Date.now() + backoff;
        // 【2026-07-21・Fable5相談】429の場合、上の指数バックオフは推測値でしかない。
        // /api/statusは自分のスロット消費対象外の軽量エンドポイントで、"Slot available
        // after: ..., in N seconds." の行から実際の待ち秒数を読み取れる。取得できたら
        // より正確な値でosmGlobalCooldownUntilを上書きする(非同期・失敗しても現状の
        // 推測バックオフのままなので無害)。overpass-api.deはDNSラウンドロビンで複数の
        // バックエンドを持ち、statusと直前のPOSTが別ホストに当たっている可能性があるため
        // 精度は完全ではない前提だが、公式ドキュメントが「429なら15秒待って再送」と
        // 明記している通り、現行の指数バックオフ(最大120秒)より短くても採用してよい。
        if (res.status === 429) {
          fetchOverpassSlotWaitMs().then(ms => {
            if (ms != null) osmGlobalCooldownUntil = Date.now() + ms;
          });
        }
      }
      // 【2026-07-21・修正5】429/502/504はタイル固有のデータ問題ではなくインフラ側の
      // 一時障害なので、下のcatchブロックでgaveUp判定(osmTileHardFailCount)に算入しない
      // よう区別できるフラグを付けておく。504は宣言timeout/maxsizeがサーバーの残りリソースに
      // 対して大きすぎる場合の応答で、宣言timeoutを短縮した(buildOSMBatchQuery)ことで
      // 正常処理を打ち切ってしまった可能性があるため、次回はブースト(長いtimeout)で
      // 再試行させる目印も付ける。
      const e = new Error('HTTP ' + res.status);
      e.infra = (res.status === 429 || res.status === 502 || res.status === 504);
      e.wasTimeout = (res.status === 504);
      throw e;
    }
    const data = await res.json();
    if (!data || !data.elements) throw new Error('no elements');
    // 【重要・2026-07-16】Overpassは内部のtimeout/メモリ上限に達すると、例外にはならず
    // HTTP 200 + data.remarkに "runtime error: Query timed out" 等の文言を入れた「途中までの
    // 部分結果」を返すことがある。以前はdata.elementsさえ存在すれば無条件で成功扱いにして
    // いたため、超高密度エリア(京橋・八重洲など)で道路は途中まで集計できても建物の集計に
    // 到達する前にOverpass側がタイムアウトし、その中途半端な結果を「完全に取得できた」
    // ものとしてタイルを永久にroadReadyTiles入りさせてしまい、実建物が二度と現れない
    // 空地が生まれていた(実機診断で確認)。remarkにtimeout/memoryを示す文言があれば
    // 部分結果とみなし、失敗として扱って再試行キューに戻す。
    if (data.remark && /timed out|timeout|out of memory/i.test(data.remark)) {
      const e2 = new Error('partial result: ' + data.remark);
      e2.wasTimeout = true; // 【2026-07-21・Fable5相談】次回はブースト(長いtimeout)で再試行
      throw e2;
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
    if (batch.length === 1) osmCachePut(bboxes[0], data); // 保存キーもbboxes[0](絶対座標)に統一
    _osm429Streak = 0; // 【2026-07-21】完全な応答を受け取れた=不調から回復したとみなし、次回のbackoffを短くリセット
    // 複数タイル分の要素が1つの配列で混ざって届くが、seenOSMWaysでway ID重複排除される
    // ので、1タイルの時と同じ processTileData にそのまま渡してよい。密度計算用にタイル枚数も渡す。
    processTileData(data, batch.length);
    keys.forEach(k => {
      osmTileFailCount.delete(k);
      osmTileHardFailCount.delete(k); // 【2026-07-21・修正5】成功したので諦めカウントも白紙に戻す
      gaveUpTiles.delete(k);
      osmTileTimeoutBoost.delete(k); // 【2026-07-21・Fable5相談】成功したので短いtimeout宣言に戻す
      osmTileQueuedAt.delete(k); // 成功したので待ち時間計測も終了
      roadReadyTiles.add(k); // このタイルの道路が確定 → 建物生成待ちのチャンクを解放してよい
    });
    // loadOSM()(part6.js)は起動直後に「🗺 マップを読み込み中...」のstickyトーストを
    // 出したまま抜ける(道路・建物の実際の生成はここが担当するため)。
    // 【2026-07-19】完了表示は自タイルだけでなく、建物生成の実際のゲート
    // (osmTilesReadyAround・上のキャッシュヒット分岐と同じ)が揃った時点に揃える。
    if (awaitingDestinationLoad && osmTilesReadyAround(player.position.x, player.position.z, 64)) {
      awaitingDestinationLoad = false;
      showToast(t('mapShownToast'), { duration: 3000 });
    }
  } catch(e) {
    // 以前は3回失敗すると完全に諦めて二度と再試行しなかったため、Overpassが一時的に
    // 混雑していただけの場合でも「その区画だけ永久に道路が途切れる」ことがあった。
    // → 諦めきらず、間隔を伸ばしながら背景でずっと再試行し続ける。
    // (3回失敗した時点では建物生成だけ先に進めてよい扱いにし、後から道路が届いたら反映される)
    // (AbortErrorも含め、失敗理由を問わずここに来れば必ずキューの枠を解放できる)
    failed = true;
    // 【2026-07-21・修正5】429/502/504(インフラ側の一時障害)は「このタイルのデータに
    // 問題がある」ことを意味しないため、諦め判定(osmTileHardFailCount/gaveUpTiles)には
    // 算入しない。また3枚まとめバッチの失敗を3タイル分に等しく算入すると、先読み中の
    // バッチ失敗だけで足元タイルの諦めカウントが「前借り」で溜まってしまうため、
    // 1枚クエリの失敗だけを対象にする(nearSolo=現在地周辺は1枚クエリなので、
    // 本当に現在地で連続失敗した場合はきちんとカウントされる)。
    const isInfra = !!(e && e.infra);
    // 【2026-07-21・Fable5相談】504・remarkのtimed out(=宣言timeoutを短縮したことで
    // Overpass側の正常処理を打ち切ってしまった疑いがあるケース)は、次回このタイルを
    // 再試行する時だけ従来の長いtimeout宣言に戻す。同じ理由の失敗を短いtimeoutのまま
    // 何度も繰り返させないための一時的な措置(成功したら上のkeys.forEachで解除)。
    const isTimeout = !!(e && e.wasTimeout);
    if (isTimeout) keys.forEach(k => osmTileTimeoutBoost.add(k));
    keys.forEach(k => {
      const n = (osmTileFailCount.get(k) || 0) + 1;
      osmTileFailCount.set(k, n); // バックオフ・バッチ縮小判定(nextFailCount)用。挙動不変
      if (!isInfra && batch.length === 1) {
        const h = (osmTileHardFailCount.get(k) || 0) + 1;
        osmTileHardFailCount.set(k, h);
        if (h >= 4) { roadReadyTiles.add(k); gaveUpTiles.add(k); } // これ以上は建物生成をブロックしない(道路は背景で取得を続ける)
      }
      queuedTiles.delete(k); // 常に再試行対象に戻す(checkOSMTiles が再度キューに積む)
      // 【2026-07-17・Fable5診断】以前はこの後にワーカー自身がsleepして間隔を作っていたが、
      // 枠を握ったままのsleepを撤去したため、代わりにタイルごとの再試行可能時刻をここへ記録する。
      // 【2026-07-18】プレイヤーが今立っているタイル(ptKey)だけは、他の未訪問タイルと
      // 同じ最大30秒バックオフを課すと「移動中、足元の道路・建物がしばらく生成されない」
      // 体感の悪化につながっていた(このバックオフはFable5診断の枠占有バグ修正で新設した
      // ものだが、意図せず現在地タイルの再試行も一律で遅らせてしまっていた)。nearSolo・
      // _curTileRush・sticky toastなど既存の「現在地タイルだけ特別扱い」方針に合わせ、
      // 現在地タイルだけ短い上限・緩やかな増分のバックオフにする(他タイルは従来通り)。
      const _isCurTile = k === ptKey;
      osmTileNextRetryAt.set(k, Date.now() + (_isCurTile ? Math.min(5000, 1500 * n) : Math.min(30000, 3000 * n)));
    });
    // 現在地タイルが4回失敗して「諦めて先に進む」扱いになった場合も、sticky状態のトーストを
    // 出しっぱなしにしない(Overpass不調が長引くと「🗺 マップを読み込み中...」が永久に残るため)。
    if (awaitingDestinationLoad && roadReadyTiles.has(ptKey)) {
      awaitingDestinationLoad = false;
      showToast(t('mapPartialFailToast'), { duration: 4000 });
    }
  } finally {
    clearTimeout(timeoutId); // 成功時に残ったタイマー自体の掃除(abort()は既に完了済みのfetchには無害)
    _activeFetchStarts.delete(_fetchStartKey); // 診断計器の後片付け(成功・失敗いずれでも必ず消す)
    _activeFetchAborts.delete(_fetchStartKey);
  }
  // 【2026-07-17・Fable5診断】以前は失敗時、待ち時間(最大30秒)をこのワーカーが
  // concurrency枠(OSM_TILE_CONCURRENCY=3)を握ったままsleepしていたため、密集地で
  // 立て続けに失敗すると3枠が同時に眠り込み、新規リクエストが一切出せない
  // 「全枠停止」の窓が生まれ、429ストームと相互に悪化させ合っていた。
  // → 失敗時は枠を即座に解放し、間隔調整はosmTileNextRetryAt(上のcatch内で記録済み)
  // 側だけで守る。成功時は従来通り軽いペーシング(200ms、プロキシ側の直列化に合わせる)を残す。
  if (!failed) {
    await new Promise(r => setTimeout(r, 200));
  }
  osmTileActiveCount--;
  processOSMTileQueue(); // この枠が空いたので、キューに残りがあれば次を拾う(backoff中のみなら内部でbreakする)
}

// 【2026-07-16】現在地タイルの「描写完了」監視。約1.5秒ごとに、(1)現在地タイルの
// 道路データ確定(roadReadyTiles)、(2)現在地タイル内の道路メッシュ待ち、(3)現在地タイル内の
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
  // 【2026-07-21・修正5(b)】諦め(gaveUp)は「本当にデータが無い」ではなくインフラ障害等での
  // 仮判定でしかないので、プレイヤーが実際にそのタイルへ足を踏み入れたら白紙に戻して
  // 取得をやり直す。roadReadyTilesからは外さない(生成済みの建物ゲートを巻き戻さない。
  // 再取得が成功すればremoveBuildingsOverlappingRoadが道路と被る建物を自然に掃除する)。
  const ptk = tx + ',' + tz;
  if (gaveUpTiles.has(ptk)) {
    gaveUpTiles.delete(ptk);
    osmTileFailCount.delete(ptk);
    osmTileHardFailCount.delete(ptk);
    osmTileNextRetryAt.delete(ptk); // 即時再試行可
  }
  let rush = !roadReadyTiles.has(tx + ',' + tz);
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
    // 【2026-07-21・ユーザー要望】道路生成が「地形は緑なのに赤いまま」滞留するパターンの
    // 診断用。新規キュー投入時刻を記録し、デバッグオーバーレイでfetching状態のタイルが
    // 何ms待たされているかを見えるようにする(キュー優先順位の問題か、実際に取得に
    // 時間がかかっているだけかを切り分ける)。
    if (!queuedTiles.has(key)) { queuedTiles.add(key); osmTileQueue.push({ tx, tz }); osmTileQueuedAt.set(key, Date.now()); }
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
  // 【2026-07-18】公園・水域等の回避ポリゴンとの境界ぎりぎりに手続き生成の家が建つ
  // (=「公園の中に家」に見える)のを防ぐため、境界からAVOID_MARGIN(m)の安全余白を
  // 設ける。1)・3)を再度有効化する際の前提としてここを先に固める。
  // クエリ自体もAVOID_MARGIN分広げておかないと、余白判定に使うポリゴンそのものが
  // nearAvoidに入らない(チャンクぎりぎり外の公園を見落とす)。
  const AVOID_MARGIN = 6;
  const nearAvoid = queryPolyGrid(avoidGrid, x0 - AVOID_MARGIN, x1 + AVOID_MARGIN, z0 - AVOID_MARGIN, z1 + AVOID_MARGIN);
  // 点(x,z)がポリゴンの各辺からmargin以内かどうか(内部判定はpointInPolygon側で別途行う。
  // ここは「外側だが際どく近い」場合を拾うための境界距離チェック)。
  const _nearPolyBoundary = (x, z, pts, margin) => {
    const m2 = margin * margin;
    for (let i = 0, j = pts.length - 1; i < pts.length; j = i++) {
      if (distSqPointToSeg(x, z, pts[j].x, pts[j].z, pts[i].x, pts[i].z) < m2) return true;
    }
    return false;
  };
  const inAvoid = (x, z) => nearAvoid.some(p => {
    // バウンディングボックス(+余白)の粗いふるい落としで、ほとんどの候補点は
    // 高コストな境界距離計算に入らず即falseになる。
    if (x < p.minX - AVOID_MARGIN || x > p.maxX + AVOID_MARGIN ||
        z < p.minZ - AVOID_MARGIN || z > p.maxZ + AVOID_MARGIN) return false;
    return pointInPolygon(x, z, p.pts) || _nearPolyBoundary(x, z, p.pts, AVOID_MARGIN);
  });
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
  // 【重要】以前はroadRecords(取得済み全道路。増え続けて減らない)を毎回全件走査していた。
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
  // 【2026-07-18】傾斜地には手続き生成の家を建てない(丘陵地で家が斜面に埋まる/浮いて
  // 見える見た目対策)。候補点からSLOPE_CHECK_DIST(m)離れた2点との高低差で勾配を概算する。
  // getGroundYはELEV_SCALE(=2.0、part5.js)で誇張された高さを返すため、しきい値はその
  // 前提での経験値(実勾配おおよそ14%相当を目安)。実OSM建物には適用しない(実データ優先)。
  const SLOPE_CHECK_DIST = 8, SLOPE_MAX_DH = 2.2;
  const isSteepSlope = (qx, qz) => {
    const h0 = getGroundY(qx, qz);
    return Math.abs(getGroundY(qx + SLOPE_CHECK_DIST, qz) - h0) > SLOPE_MAX_DH ||
           Math.abs(getGroundY(qx, qz + SLOPE_CHECK_DIST) - h0) > SLOPE_MAX_DH;
  };
  // 【2026-07-18】大きな建物のすぐ隣にわずかに残った土地など、家一軒分の最低限の
  // クリアランス(isOnRoad/hasBuildingNearbyの通常の余白)はギリギリ満たすが実質
  // 「隙間」でしかない狭小地には建てないようにする。footprint・隣接建物までの距離・
  // 実建物からの距離をひとまわり広げた基準(LOT_MARGIN)で同じ衝突判定を通し、
  // 広げた分だけでも何かにかかるなら「狭すぎる土地」とみなして除外する。
  const LOT_MARGIN = 4; // isInsideKnownRealBuildingの既定pad(3m)より広く取り、大きな実建物の脇の狭小地も除外する
  const hasRoomToBuild = (qx, qz, bw, bd) => {
    if (isInsideKnownRealBuilding(qx, qz, LOT_MARGIN)) return false;
    if (isOnRoad(qx, qz, bw + LOT_MARGIN * 2, bd + LOT_MARGIN * 2)) return false;
    if (hasBuildingNearby(qx, qz, Math.max(bw, bd) / 2 + LOT_MARGIN)) return false;
    return true;
  };
  const buildable = (qx, qz) => {
    if (isInsideKnownRealBuilding(qx, qz)) return false;
    if (inAvoid(qx, qz)) return false;
    if (isSteepSlope(qx, qz)) return false;
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
      if (ddx * ddx + ddz * ddz < 0.01) continue;
      if (distSqPointToSeg(qx, qz, r.x1, r.z1, r.x2, r.z2) < maxD * maxD) return true;
    }
    return false;
  };

  // --- 1) 道路沿いの住宅補完(日本の住宅街らしく道路に面してぎっしり並べる) ---
  // 【2026-07-18】一度撤去したが、landuse=residentialタグは日本のOSMでは未登録の
  // 郊外が多く、2)だけに絞ると住宅街がスカスカになってしまった(伊勢原郊外は元々
  // これが理由でこの補完が作られた)。真因は補完ロジック自体ではなく、回避ポリゴン
  // 境界の余白が無かったこと(inAvoidが境界ぴったりでしか弾いていなかった)と判断し、
  // 上のinAvoidにAVOID_MARGIN(6m)の安全余白を追加した上で復活させる。
  const PROC_ROADSIDE_INFILL_ENABLED = true;
  // 敷地幅≈10m間隔で両側に並べ、奥の2列目・3列目にも生成(奥ほど生成率を下げ路地の抜けを残す)
  for (const r of PROC_ROADSIDE_INFILL_ENABLED ? nearMinor : []) {
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
          if (!hasRoomToBuild(hx, hz, bw, bd)) continue; // 【2026-07-18】狭小地(大きな建物の隙間等)を除外
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
        if (isSteepSlope(jx, jz)) continue; // 【2026-07-18】傾斜地には建てない(buildable()参照)
        const bw = 7+Math.random()*5;
        const bd = 6.5+Math.random()*4.5;
        // 【2026-07-18】isInsideKnownRealBuildingを含む狭小地除外はhasRoomToBuildに統合
        if (!hasRoomToBuild(jx, jz, bw, bd)) continue;
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
  // 【2026-07-18】1)と同じ理由で復活。inAvoidの安全余白(AVOID_MARGIN)が
  // 回避ポリゴン境界付近の誤爆を防ぐ側の対策になっている。
  if (denseArea) {
    for (let bx = worldX; bx < worldX + CHUNK_SIZE; bx += 14) {
      for (let bz = worldZ; bz < worldZ + CHUNK_SIZE; bz += 14) {
        if (Math.random() > 0.45) continue;
        const jx = bx + (Math.random() - 0.5) * 5.6, jz = bz + (Math.random() - 0.5) * 5.6;
        if (!buildable(jx, jz)) continue; // 実landuse区画内 or 本物の建物が近くにある場合のみ
        if (!nearMinorRoad(jx, jz, 35)) continue;
        const bw = 7 + Math.random() * 4, bd = 6.5 + Math.random() * 3.5;
        if (!hasRoomToBuild(jx, jz, bw, bd)) continue; // 【2026-07-18】狭小地を除外
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
      if (rdx * rdx + rdz * rdz < 0.01) continue;
      if (Math.sqrt(distSqPointToSeg(cx, cz, rd.x1, rd.z1, rd.x2, rd.z2)) < (rd.rw || 3) / 2 + r) return true;
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
    // 【2026-07-24】農村側(placeMachiya呼び出し元)を大幅に引き上げたのに合わせ、
    // 町場の道路無しフォールバックも同水準まで引き上げる(江戸6-9/明治8-11)
    const n = (MODE === 'edo' ? 6 : 8) + (Math.random() * 4 | 0);
    for (let i = 0; i < n; i++)
      placeMachiya(cx + (Math.random() - 0.5) * 90, cz + (Math.random() - 0.5) * 90, inAvoid);
    return;
  }
  for (const r of roads) {
    const dx = r.x2 - r.x1, dz = r.z2 - r.z1;
    const len = Math.sqrt(dx * dx + dz * dz);
    if (len < 8) continue;
    const px = -dz / len, pz = dx / len;
    for (let s = 3; s < len - 2; s += 5 + Math.random() * 1.5) { // 【2026-07-24】さらに間隔を詰める(旧: 6+rand*2)
      const rx = r.x1 + dx * (s / len), rz = r.z1 + dz * (s / len);
      if (rx < cx - 50 || rx >= cx + 50 || rz < cz - 50 || rz >= cz + 50) continue; // このセル担当分のみ(二重生成防止)
      for (const side of [-1, 1]) {
        if (Math.random() < 0.05) continue; // 町並みに抜けを少し残す(旧: 0.1)
        const off = (r.rw || 4) / 2 + 2.6 + Math.random() * 1.2;
        placeMachiya(rx + px * side * off, rz + pz * side * off, inAvoid);
      }
    }
  }
}

// 【2026-07-25追加】実測「江戸切絵図」町家領域ポリゴンの内側を、現代道路の有無に関係なく
// 直接埋める。generateTownRowは現代の主要道路(trunk/primary/secondary/tertiary)沿いにしか
// 反応しないが、日本橋のような実測データがある密集地でも、その細かい街路網は現代では
// ただの生活道路(残念ながら明治・江戸モードではtype='road'として除外済み)になっている
// ことが多く、結果として実測ポリゴンがあるのに「近くに現代の主要道路が無い」と判定され
// スカスカな散布フォールバックにしか落ちない、という取りこぼしが起きていた。
// ここでは現代道路を一切参照せず、ポリゴンの内側かどうかだけで候補点を採否するため、
// 実測データのある場所は必ずその輪郭どおりに密集した町並みになる。
function fillRealMachiyaCell(cx, cz, inAvoid) {
  const N = 50; // 100m四方あたりの候補点数(ポリゴン外・当たり判定で多くが弾かれる前提)
  for (let i = 0; i < N; i++) {
    const hx = cx + (Math.random() - 0.5) * 98, hz = cz + (Math.random() - 0.5) * 98;
    if (!isInEdoMachiyaArea(hx, hz)) continue; // 実測ポリゴンの外には建てない(輪郭に忠実)
    placeMachiya(hx, hz, inAvoid);
  }
}

function generateMeijiCells(x0, z0, x1, z1, inAvoid) {
  const groundGroups = new Map(); // material → セル中心座標列(後で1メッシュにマージ)
  for (let gx = Math.floor(x0 / 100); gx <= Math.floor(x1 / 100) + 1; gx++) {
    for (let gz = Math.floor(z0 / 100); gz <= Math.floor(z1 / 100) + 1; gz++) {
      let code = meijiCells.get(gx + ',' + gz);
      const cx = gx * 100, cz = gz * 100;
      if (cx < x0 || cx >= x1 || cz < z0 || cz >= z1) continue; // 中心点が担当チャンク内のセルのみ(二重生成防止)
      // 【2026-07-25】実測の江戸期データ(town/road)が使える場所ではそちらを優先する。
      // 現代密度ヒューリスティックはあくまで実データの無い場所(伊勢原等)向けの推定値であり、
      // 実際に町家があった/街道が通っていたと分かっている場所ではその事実を優先すべきため。
      // (edoRealDataReadyが未読み込み、またはカバー範囲外の場所ではfalseになり、
      //  従来どおりlocalModernDensityだけで判定される)
      const isTown = (edoRealDataReady && (isInEdoMachiyaArea(cx, cz) || nearEdoHistoricalRoad(cx, cz, 40))) ||
        localModernDensity(gx, gz) >= TOWN_TIER_MIN; // 現代建物密度から「町場」ティアを判定
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
        const isRealMachiya = edoRealDataReady && isInEdoMachiyaArea(cx, cz);
        if (isRealMachiya) {
          fillRealMachiyaCell(cx, cz, inAvoid); // 実測町家ポリゴンの内側を輪郭どおりに高密度充填
        } else if (isTown) {
          generateTownRow(cx, cz, inAvoid); // 町場: 街道沿いに町家を連ねる(現代道路ヒント)
        } else {
          // 農村: 茅葺き民家の集落(江戸は明治より開発途上のため、集落あたりの軒数を減らす)
          // 【2026-07-24】実際の江戸期の村は1村平均40-50軒/人口約400人・耕地50町歩程度
          // (出典: 検地record例。古文書ネット等)だが、これは耕地を含む行政単位「村」全体の
          // 数字であり、家屋はその全域に均等分布するのではなく街道沿い等の集落コア部分に
          // 集まっていた。このcode===6セルはまさにその集落コア部分(迅速測図が「村落」と
          // 分類した100m四方)を指すため、単純な平均分割よりずっと高い密度が実態に近い。
          // 前回の2-5/3-6軒はそれでも過小と判断し、大幅に引き上げる(江戸5-9/明治7-11)。
          // 敷地の当たり判定(hasBuildingNearby)が自然に頭打ちにするため、上げすぎても
          // 詰まりすぎた見た目にはならない。
          const n = (MODE === 'edo' ? 5 : 7) + (Math.random() * 4 | 0);
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
  // 【重要】以前はメッシュだけ消して記録が残っていたため、
  //  - 再訪時に hasBuildingNearby が幽霊建物を検出 → チャンクが空のまま(=途切れ)
  //  - 幽霊の当たり判定(見えない壁)とミニマップ表示も残留
  // 【2026-07-17・P3】削除の6点セットをremoveBuildingsByIds(part1.js)に集約したため、
  // このループはchunkMeshesの解放とbid収集だけを行う(resnap記録=buildingRecordsの除去も
  // 実OSM建物はck=nullなので手続き生成チャンクのアンロードでは消えない=想定通り)。
  // 複数チャンクが同時にアンロード対象でも、bidはまとめて1回でremoveBuildingsByIdsに渡す。
  const removeIds = new Set();
  for (const [key, meshes] of chunkMeshes.entries()) {
    const [kcx, kcz] = key.split(',').map(Number);
    if (Math.abs(kcx - cx) > unloadR || Math.abs(kcz - cz) > unloadR) {
      meshes.forEach(m => {
        if (!m || m.userData._released) return; // 【2026-07-20・二重解放バグ修正】下記コメント参照
        m.userData._released = true;
        scene.remove(m);
        // 屋根・小物の単位ジオメトリは全建物で共有しているため破棄しない
        if (m.geometry && !m.geometry.userData.shared) m.geometry.dispose();
        if (m.material) releaseFacadeMat(m.material); // facadeMat以外は無害なno-op(part2.js参照)
      });
      chunkMeshes.delete(key);
      loadedChunks.delete(key); // allow re-generation if player returns
      for (const rec of buildingRecords) {
        if (rec.ck === key) removeIds.add(rec.bid);
      }
    }
  }
  removeBuildingsByIds(removeIds);
}

// このチャンクの範囲を覆うOSMタイルが全て「道路確定済み」かどうか。
// (地形→道路→建物→木の順を守るためのゲート。以前はチャンクの建物生成が
//  roadRecords にその時点で乗っている道路だけを見て進んでしまい、後から
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
    if (!roadReadyTiles.has(`${tx},${tz}`)) return false;
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
// 【2026-07-18】以前は先頭を1個shiftし、未準備(タイル未取得等)なら末尾へpushして
// そのフレームは何もせず終わる方式だった。これだと「最も近い=キュー先頭のチャンク」が
// タイル取得待ちで詰まっている間、キューの後ろの方にある「既に準備完了の遠いチャンク」が
// 同じフレームで一度も試されず、実質的にキュー全体が近い順→到着順にシャッフルされて
// いくため、「遠景は生成されるのに近辺だけ生成が大きく遅れる」体感の一因になっていた
// (密集地でOverpassの応答が遅れがちな近傍タイルほどこの詰まりの影響を受けやすい)。
// 1フレーム1チャンク生成という制約(カクつき防止)は変えず、範囲外チャンクを間引きつつ
// キューを先頭(=近い)から走査して「今すぐ生成できる最初の1件」を探す方式に変更する。
function processChunkQueue() {
  if (chunkGenQueue.length === 0) return;
  const ccx = Math.floor(player.position.x / CHUNK_SIZE);
  const ccz = Math.floor(player.position.z / CHUNK_SIZE);
  for (let i = 0; i < chunkGenQueue.length; i++) {
    const c = chunkGenQueue[i];
    // キュー待ちの間に遠ざかったチャンクは破棄(再訪時に再キューされる)
    if (Math.abs(c.x - ccx) > CHUNK_RADIUS + 1 || Math.abs(c.z - ccz) > CHUNK_RADIUS + 1) {
      chunkGenQueue.splice(i, 1);
      loadedChunks.delete(c.key);
      i--;
      continue;
    }
    // カバーするタイルの道路データがまだ届いていなければ、このチャンクは飛ばして
    // 次(=より遠いが準備完了かもしれないチャンク)を見る。この行がキューに残ったまま
    // 進むのが今回の修正の核心(以前はここでpushして関数を抜けていた)。
    if (!chunkTilesReady(c.x, c.z)) continue;
    // NEAR(周辺高解像度)地形がまだこのチャンクを覆っていなければ同様に飛ばす
    // (明治モードはNEARを使わないので対象外)
    if (!IS_MEIJI && !chunkNearTerrainReady(c.x, c.z)) continue;
    chunkGenQueue.splice(i, 1);
    generateChunk(c.x, c.z);
    return;
  }
}
