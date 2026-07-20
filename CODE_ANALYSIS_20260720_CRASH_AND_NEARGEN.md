# コード分析 2026-07-20: タブクラッシュ / 最寄りエリア生成遅延

実装は別チャットで行う前提の分析結果。参照行番号は本日時点のもの。

---

## 問題1: 数分プレイでクラッシュ / だんだん重くなって落ちる

### 発見A【最有力・NY数十秒クラッシュ(退行)の説明】tintWallが色量子化を無効化 × refCount解放がキャップを無効化

2つの同日(07-20)変更の相互作用。

1. **キー空間の爆発**: `quantizeColor`(part2.js:944)はOSMタグ色をキャッシュキー用に量子化するが、
   `addBuilding`(part3.js:258-259)はその**後**に `tintWall(wallC)`(part3.js:114、6種ランダム倍率)を掛けており、
   量子化済みの色を再び任意の24bit色に散らしてから `facadeMat(kind, wallC, variant)` のキーに使っている。
   さらに07-20で `style.wallPalette` 抽選(part3.js:234-240)と高層default用 `DEFAULT_WALLS_REAL`(part3.js:243-252)が
   加わり、基底色の種類自体も増加。→ facadeCacheキー数 = 基底色 × 6ティント × 2バリアント × kind で
   NYのようなタグ豊富な密集地では数百〜千超の一意キーが初期ロードだけで発生し得る。

2. **キャップの実質無効化**: lite の `FACADE_CACHE_MAX=220`(part2.js:98)は「到達後は新規テクスチャを作らない」
   ことで**生成レート**を止めていた。ところがrefCount解放(part2.js:307)導入後は、初期ロード中でも
   `removeBuildingsOverlappingRoad`(part1.js:330、道路が後着するたび建物撤去→再キュー)が解放を発生させ、
   cacheサイズが220を割る → 新規Canvas+テクスチャ生成が再開、の繰り返しになる。
   瞬間保持数は有界でも**Canvas生成レートが無制限**になった。

3. **iOSで致命的な理由**: WebKitはCanvasバッキングストアをGC遅延で解放し、タブ毎のCanvas/メモリ上限が厳しい。
   初期ラッシュ(建物400棟/フレーム・14ms予算、part9.js:424,440)中に1棟ごとの新キーで
   128x128+64x64のCanvasを2枚ずつ量産すると、解放が追いつかずタブkill。
   「refCount導入直後にNYで数十秒(過去最短)」は、refCountのバグそのものより
   **「refCountがliteのキャップ挙動を壊した + 同日の色多様化でミス率が上がった」**として最も整合的。

**推奨修正(優先順)**
- (a) `tintWall`の出力を`quantizeColor`に通す。またはキーを「量子化基底色 + ティントindex」にする(キー空間を設計通り有界に戻す)。
- (b) liteではrefCount解放を無効化して従来の「220到達で生成停止・使い回し」に戻す(解放はstd/highのみ)。
     もしくは「新規テクスチャ生成は毎秒N件まで」のレート制限を入れ、超過分は同genre使い回しへ。
- (c) dispose時にCanvasを明示解放: `mat.map.image.width = mat.map.image.height = 0;`(emissiveMapも同様)。
     iOSではGC待ちのバッキングストアを即時返却でき、churn耐性が大きく上がる。

### 発見B【確定バグ・二重解放】chunkMeshes と buildingRecords.parts の二重管理

- `generateChunk`は終了時に `scene.children.slice(beforeCount)` を丸ごと `chunkMeshes.set(key, added)`
  (part8.js:1060-1061)。チャンク内で`addBuilding`された手続き建物のメッシュは
  **chunkMeshes[key] と buildingRecords[].parts の両方**に入る。
- `removeBuildingsOverlappingRoad`(part1.js:364-368)が手続き建物を撤去すると`releaseFacadeMat`が呼ばれるが、
  **chunkMeshesからは除去されない**。プレイヤーが離れてチャンクアンロード(part8.js:1262-1266)が走ると、
  同じメッシュに対して`releaseFacadeMat`が**もう一度**呼ばれる。
- facadeMatの'house'系は多数の建物で共有されるため、過剰減算でrefCountが早期に0 →
  **使用中の共有材をdispose + cacheから削除** → 以後同キーで重複テクスチャが再生成され続け、
  破棄済み材を持つ表示中メッシュはレンダラーが再アップロード。テクスチャ重複蓄積+churnで
  「だんだん重くなって落ちる」に直結。PC Chromeでも起きる(iOS限定ではない)。
- 発生頻度: Overpass不調時ほど多い。「4回失敗→roadReady扱い→手続き生成→道路後着→撤去」
  (part6/part8のゲート仕様)がこの経路をまとめて踏む。

**推奨修正**
- (a) 解放を冪等に: 解放時 `mesh.userData._released = true` を立て、全3箇所(part1.js:368, 827 / part8.js:1266)で
  スキップ。geometry.dispose二重呼びも同時に防げる。
- (b) 防御: `releaseFacadeMat`内で `if (mat.userData.refCount < 0) { console.warn(...); return; }`。
  デバッグHUDに負カウント検出数を出せば実機で発生有無を確認できる。

### 発見C【前提確認】「facadeMat 1呼び出し=1mesh」は現状正しい

part3.jsで`mat`が使われるのは壁メッシュ1箇所のみ(part3.js:270-271, 291)。屋根・小物は
roofSurfMat/lambertMat(cacheKeyなし→release no-op)。リリース3箇所のrec.parts走査自体も正しい。
問題は発見Bの二重管理だけ。

### 発見D【蓄積系・中〜小】

- `dormantBuildings` に上限なし(part1.js:833, part9.js:452,459)。複数都市を長時間巡ると
  entries(style含むオブジェクト)が無制限に蓄積。JSヒープ圧迫に寄与。
  → 距離上限(例: 5km超は破棄。再訪時はIndexedDBタイルキャッシュから再構築される)か件数上限を推奨。
- `matCache`/`roofMatCache`は無解放だがテクスチャを持たない/共有ROOF_TEXSのみで影響小。
  ただしroofC・wallC多様化(07-20)でエントリ数は増加傾向。監視対象。

### iOSでのメモリ間接観測(Macなしで可能)

- `renderer.info.memory.textures / geometries` と `facadeCache.size`・Canvas累計生成数を
  デバッグHUDへ表示するだけで、iOSでも「テクスチャ数が単調増加していないか」を実機確認できる。
  performance.memory不要。クラッシュ直前値のlocalStorage保存(1秒毎)で事後検死も可能。

---

## 問題2: 最寄りエリアの道路・建物が数分生成されない

### 構造分解(3層)

1. **取得層(主因)**: 現在地タイルのOverpassデータ未着。クライアント猶予70秒(part8.js:559-560) vs
   サーバー再試行チェーン最大91.5秒 vs 実測881秒のケース。タイムアウト→再試行→バックオフ
   (現在地タイルは最大5秒、part8.js:663-664)を4周する間、道路レコード自体が存在せず
   「近くに何もない」時間が数分続く。IndexedDBヒット時は即時なので**初訪問エリア限定の症状**。

2. **再試行の構造問題(増幅要因)**: 建物の地形待ち/隣接タイル待ち(part9.js:464-472, 488-490)は
   「配列**末尾**へ戻す」方式。バックログ数万件では1周に数秒〜十数秒かかり、
   `_tries<40`でも **1周時間 × 40回 = 数分** の天井になる。07-19の200→40短縮は
   天井を下げただけで、「近い建物ほど早く再判定される」構造にはなっていない。

3. **ゲート仕様**: `osmTilesReadyAround(64m)`はタイル内部の建物なら自タイルのみ待つ設計は正しい。
   境界64m帯だけが隣タイム依存。ボトルネックはゲートではなく上記1,2。

### 推奨修正(優先順)

- (a) **現在地タイルのみミラー並走**: overpass-api.de と ミラーへ同時発射し先勝ち
  (Promise.any + 敗者abort)。private.coffee「メイン化」は失敗済みだが「並走・先勝ち」は
  最悪でも現状と同じで、成功時のみ速くなる。サーバープロキシ経由なら並走はサーバー側実装でも可。
- (b) **近傍専用の再試行列**: `_tries`方式をやめ、プレイヤーから200m以内の待ち建物は
  時刻ベースの小さな別キュー(nearRetryQueue)で毎秒直接再判定(件数は高々数十)。
  「キュー1周」への依存を断つのが本質。
- (c) 現在地タイルが未確定の間は、そのタイル内の**手続きinfillを保留**する。
  4回失敗→proc生成→実道路後着→撤去、は無駄が大きく、発見Bの二重解放も踏む。
- (d) 検討: 現在地タイルの1枚クエリを「道路のみ先行→建物は後続クエリ」に分割すると、
  Overpass側の重い建物集計を待たずに道路が出せる(クエリ2本になるトレードオフあり)。

---

## 両問題の接点

Overpass不調 → 4回失敗フォールバック → 手続き生成 → 道路後着で撤去(removeBuildingsOverlappingRoad)
→ 発見Bの二重解放 + 発見Aのcacheサイズ変動による再生成churn。
**「近くが生成されない」状況そのものがクラッシュ経路を加速する**ため、問題2の対策(a)(c)は問題1の軽減にも効く。

## 追記 2026-07-21: 「移動を続けると生成が止まる・遅れる」のログ分析

実機コンソールログから、独立した2系統の問題を確認。

### 系統1: 道路・建物が止まる = Overpass層がほぼ全滅状態

- overpass-api.de 直叩きが **429 (Too Many Requests)** と **504** を連発。
- フォールバック先のプロキシ `chronodrift.onrender.com/api/overpass` も **502 (Bad Gateway)**。
  → 取得経路が両方死んでいる時間帯があり、タイルデータが届かない=生成が止まる。
- 429は移動継続による自業自得の面がある: 5x5先読み+進行方向リング+再試行で、移動中は
  リクエスト量が高止まりする。現在のバックオフは**タイル単位**のみで、429を受けても
  キュー全体は3並列で叩き続けるため、レート制限中に別タイルのリクエストを出し続けて
  429ストームを維持してしまう。
- **推奨**: (a) 429/504受信時は`Retry-After`ヘッダを尊重した**グローバル・クールダウン**
  (全タイル共通で30〜60秒、指数的に延長)を入れる。タイル単位バックオフとは別物として。
  (b) プロキシ502はRenderサーバー側の問題(落ちている/コールドスタート/上流エラー)。
  Renderログの確認が必要。502時にクライアントが直叩きへ切り替える設計なら、
  それが直側の429を悪化させる連鎖も起きうる。

### 系統2: 木・小物・公園面が止まる = セッション累計プール/予算の恒久枯渇(既知仕様の実害化)

- ログで確認: tree(3500)・guardP(2500)・scrubP(2400)・vendP(400)・benchP(400)・lampP(700)が
  上限到達、areaPolyBudget park(400)/campus(400)も使い切り。
- これらは**一方通行のセッション累計カウンタ**でリサイクル無し(part2.js poolAdd、
  part4.js:374 areaPolyBudget。CODE_REVIEW P8-aで既知)。森だけrebuildForest方式で解決済み。
- 移動を続ければ**必ず**枯渇し、以降の新エリアは木・小物・公園面がゼロになる。
  「移動すると生成されなくなる」体感のかなりの部分はこれ。クラッシュとは無関係で安全側の症状。
- **推奨**: 森と同じ「プレイヤー周辺だけ距離ベースで作り直す」方式への移行が本命。
  暫定なら、チャンク/タイルのアンロード時にインスタンスのスロットを返却するフリーリスト化。
  areaPolyBudgetも面メッシュのアンロード時(存在するなら)に予算返却。

### 補足: GSI標高タイル404

- cyberjapandata dem_png z14 の404が多発。日本のDEMはz14に欠損領域があるため404自体は正常だが、
  404を「失敗→リトライ」扱いにしていると現在地の地形ready(chunkNearTerrainReady)が遅れ、
  建物生成の待ちを増やす。404は「データなし=平地/低解像度確定」として即確定させるべき(要確認)。

## 実装指示 2026-07-21(移動時の生成停止対策)

### 修正1: Overpassグローバル・クールダウン【優先度: 高・小差分】

対象: `js/legacy/part8.js`

1. グローバル状態を追加:
```js
let osmGlobalCooldownUntil = 0;
let _osm429Streak = 0;
```
2. `fetchOSMTileBatch` の `if (!res.ok) throw new Error('HTTP ' + res.status);`(part8.js:603付近)を
   分岐に変え、**429/502/504のときだけ**グローバル・クールダウンを設定してからthrow:
```js
if (!res.ok) {
  if (res.status === 429 || res.status === 502 || res.status === 504) {
    _osm429Streak++;
    const ra = parseInt(res.headers.get('Retry-After'), 10); // 429で付くことがある
    const backoff = Number.isFinite(ra) ? ra * 1000
      : Math.min(120000, 30000 * Math.pow(2, _osm429Streak - 1)); // 30s→60s→120s上限
    osmGlobalCooldownUntil = Date.now() + backoff;
  }
  throw new Error('HTTP ' + res.status);
}
```
3. 成功時(processTileDataを呼ぶ直前あたり)に `_osm429Streak = 0;` でリセット。
4. `processOSMTileQueue`(part8.js:281)の冒頭にゲート追加:
```js
if (Date.now() < osmGlobalCooldownUntil) return;
```
   トレードオフ: クールダウン中はIndexedDBキャッシュヒットの1枚クエリも止まるが、
   実装の単純さを優先(キャッシュヒット分だけ通す最適化は保留)。
5. 注意: index.htmlのfetchラッパー(paceThrough/direct/プロキシfallback、index:58-117)は
   触らない。チョークポイントはpart8側の1箇所に集約する。ただしラッパーが
   「direct失敗→proxyへ再送」を1呼び出し内でやっている場合、429時に両方を叩いて
   いないかだけ確認し、叩いていたら429時は即座に諦めてエラーを返すよう修正。
6. 動作確認: コンソールで429発生後、fetchが30秒以上完全に止まること。
   クールダウン明けに再開すること。

### 修正2: 小物プールのリサイクル【優先度: 中・2段階】

方針: 実績のある「軽量レコード恒久保持 + プレイヤー周辺だけメッシュ再構築」パターン
(rebuildForest・道路メッシュと同じ)へ寄せる。一気にやらず2段階。

**Phase 1(チャンク由来の小物): アンロード時のスロット返却**

対象: `js/legacy/part2.js`(poolAdd周り)、`js/legacy/part8.js`(generateChunk / updateChunks)

1. poolに空きリストを追加。`makePool`の戻り値に `free: []` を足す。
2. `poolAdd`: `const idx = pool.free.length ? pool.free.pop() : pool.n++;`
   満杯判定は `if (!pool.free.length && pool.n >= pool.max) return -1;` に変更
   (poolFullの警告はそのまま流用)。
3. 解放関数を追加:
```js
function poolRelease(pool, idx) {
  if (idx == null || idx < 0) return;
  _dummy.position.set(0, -9999, 0); _dummy.scale.set(0, 0, 0); _dummy.updateMatrix();
  pool.mesh.setMatrixAt(idx, _dummy.matrix); // スケール0で不可視化(countは減らせない)
  pool.mesh.instanceMatrix.needsUpdate = true;
  pool.free.push(idx);
}
```
4. 所有記録: `generateChunk`が`currentChunkKey`をセットするのと同じパターンで、
   グローバル `let currentChunkPoolList = null;` を用意。generateChunk冒頭で
   `currentChunkPoolList = [];`、末尾で `chunkPoolInstances.set(key, currentChunkPoolList);
   currentChunkPoolList = null;`。`poolAdd`は成功時
   `if (currentChunkPoolList) currentChunkPoolList.push({ pool, idx });`。
5. `updateChunks`のチャンクアンロード(part8.js:1259付近)で、chunkMeshes解放と同時に
   `chunkPoolInstances.get(key)`を全てpoolReleaseして削除。
   チャンクは再訪時に再生成されるので小物も復活する(挙動退行なし)。

**Phase 2(タイル由来の木・エリア面): レコード+周辺再構築(別セッションで)**

- `scatterTreesIn`/`addTree`(タイル処理由来)は、即poolAddせず軽量レコード
  `{x, z, s, color}` を配列+空間グリッドに恒久保持し、rebuildForestと同じ周期で
  「プレイヤー周辺のレコードだけをプールへ流し込み直す」方式へ移行。
- `areaPolyBudget`(part4.js:374)も同様に、面メッシュを距離でアンロードして予算を返却する
  (`areaPolyBudgetOK`の逆関数 `areaPolyBudgetRefund(kind)`)。ポリゴンレコード自体は
  既に恒久保持されているので、メッシュだけ距離管理にする。
- Phase 2は影響範囲が広いのでPhase 1の実機確認後に着手。

### 修正3: GSI標高404 → **修正不要(確認済み)**

part5.js:168で `if (res.status === 404) return null;` として「海上=データ無し」の正常系で
処理済み。コンソールの404はブラウザが自動出力するネットワークログで、実害なし。触らない。

### 修正4: Renderプロキシ502【調査タスク】

- クライアント側は修正1のクールダウンで502も吸収される。
- 別途Renderのログで502の原因(クラッシュ/コールドスタート/上流エラー)を確認。
  無料プランのスリープ起因なら、クライアント初回リクエストの猶予を長くする程度で可。

### デプロイ・検証順

1. 修正1のみデプロイ → 移動テスト: 429後に全体が沈黙し、明けて再開するか
2. 修正2 Phase 1デプロイ → 長距離移動テスト: poolFull警告が出なくなる/激減するか、
   チャンク再訪で小物が出るか
3. どちらも `git push`(Render自動デプロイ)

## 追記 2026-07-21(2): 足元タイルが「諦め(gaveUp)」に入る問題

### 原因分析

gaveUp(4回失敗→roadReadyTiles入り)は「このタイルのデータに問題がある(部分応答等)」を
想定した仕組みだが、実際には**原因を問わず全ての失敗**がosmTileFailCountに数えられる
(part8.js:650-653)。移動中に足元が諦めに入るのは次の複合:

1. **先読み中の前借り失敗**: タイルは前方3枚まとめバッチ(外周時)で先に取得が試みられ、
   429/504ストーム中はバッチ失敗のたびに**3タイル分まとめて**failCountが+1される。
   プレイヤーが到着する頃には足元タイルのfailCountが既に2〜3溜まっている。
2. **到着後のとどめ**: 近傍3x3は1枚クエリ(70秒猶予)になるが、レート制限が続いていれば
   その1回も429で失敗し、failCount=4→gaveUp。70秒猶予の恩恵を一度も受けずに諦めが確定する。
3. 429/502/504は**タイル固有の問題ではない**(インフラ側の一時障害)のに、タイル固有の
   問題を想定したgaveUpカウンタに算入されているのが構造的なバグ。

### 修正5: gaveUp判定の再設計【優先度: 高】

対象: `js/legacy/part8.js`

**(a) ハード失敗カウンタの分離**

- 新Map `osmTileHardFailCount` を追加。既存の`osmTileFailCount`は今まで通り全失敗を数え、
  バックオフとバッチ縮小判定(part8.js:505 nextFailCount)に使い続ける(挙動不変)。
- fetchOSMTileBatchのHTTPエラーthrow時にステータスを保持:
```js
if (!res.ok) { const e = new Error('HTTP ' + res.status);
  e.infra = (res.status === 429 || res.status === 502 || res.status === 504); throw e; }
```
- catchブロック(part8.js:649付近)で、gaveUp用カウントの条件を絞る:
```js
const isInfra = !!(e && e.infra);
keys.forEach(k => {
  const n = (osmTileFailCount.get(k) || 0) + 1;
  osmTileFailCount.set(k, n); // バックオフ・縮小用は従来通り
  // gaveUp用: インフラ障害(429/502/504)は数えない。かつ1枚クエリの失敗だけ数える
  // (3枚バッチの失敗を3タイルに等しく算入すると先読み中に前借りで溜まるため)。
  if (!isInfra && batch.length === 1) {
    const h = (osmTileHardFailCount.get(k) || 0) + 1;
    osmTileHardFailCount.set(k, h);
    if (h >= 4) { roadReadyTiles.add(k); gaveUpTiles.add(k); }
  }
  ...従来のqueuedTiles.delete / osmTileNextRetryAt はそのまま...
});
```
- 既存の `if (n >= 4) roadReadyTiles.add(k);` は削除(上に置き換え)。
- 自然なエスカレーションは既存機構で担保される: failCount>=2でバッチが1枚に縮小されるので、
  本当にデータが壊れているタイルはやがて1枚クエリで失敗してハードカウントが進む。
- 成功時(part8.js:631-634)に `osmTileHardFailCount.delete(k)` も追加。

**(b) gaveUpTilesセットの明示化 + 現在地レスキュー**

- `const gaveUpTiles = new Set();` を追加((a)で使用)。デバッグオーバーレイの紫判定が
  別ロジックで実装されているなら、このセットを参照するよう統一。
- `checkCurrentTileRush`(part8.js:696、90フレーム周期)に追加:
```js
const ptk = tx + ',' + tz;
if (gaveUpTiles.has(ptk)) {
  gaveUpTiles.delete(ptk);
  osmTileFailCount.delete(ptk);
  osmTileHardFailCount.delete(ptk);
  osmTileNextRetryAt.delete(ptk); // 即時再試行可
  // roadReadyTilesからは外さない(生成済みの建物ゲートを巻き戻さない。
  // 再取得成功時はremoveBuildingsOverlappingRoadが道路被り建物を掃除する)
}
```
  = 「諦めは仮判定。プレイヤーが実際にそこへ立ったら白紙からやり直す」。
  背景再試行は既存機構(queuedTiles.delete→checkOSMTilesが再キュー)で継続するため、
  カウンタを白紙にするだけで70秒猶予・5秒バックオフの現在地優遇がフルに効き直す。

**(c) 検証**

- 429/504が出ている状態で移動 → デバッグオーバーレイで紫(gaveUp)が新規発生しないこと
  (インフラ障害は算入されないため)。
- 紫タイルの上に立って数秒待つ → 再取得が走り、成功すれば道路・建物が出ること。
- 修正1(グローバル・クールダウン)と併用が前提。クールダウンが429の連鎖自体を減らし、
  本修正が「残った失敗を諦めに直結させない」役割を分担する。

## 追記 2026-07-21(3): 黄色タイルで実建物の生成がほぼ止まる(道路は生成される)

黄色(buildingPending)=「道路・地形は確定、建物残件あり」。つまり取得層は正常で、
**processPendingBuildings(part9.js)が建物を消化できていない**。オーバーレイの
buildPendingは pendingByTile + dormantByTile の合算である点に注意(dormant行きも黄色に見える)。

### 最有力: bMax飽和デッドロック【原因候補A】

part9.js:458 `if (buildingRecords.length >= PERF.bMax) { dormantBuildings.push(b); continue; }`
で、上限到達中は新規実建物が**全てdormant直行**する。本来はunloadFarBuildingsの
ヒストグラム選別(part1.js:795-812)が枠を空けるはずだが、2つの穴がある:

1. **ヒストグラムのtarget未達バグ**: target = bMax*0.85 だが、ヒストグラムは実建物
   (rec.real)しか数えない(part1.js:799)。bMaxは手続き建物込みの総数なので、
   手続き建物の比率が高い街では実建物の累計がtargetに届かず、`cutoff = NBIN`(=4km)の
   まま**絞り込みが一切効かない**。
2. **手続き建物は上限到達中も1800m固定**(part1.js:813 d2Proc)で、キャップ占有分が減らない。
   liteはbMax=6000・チャンク9×9の密集住宅+実建物1400m圏で容易に飽和する。

飽和すると: 新規実建物→dormant直行、reactivateも `>= PERF.bMax` ガード(part1.js:853)で
停止、枠は空かない → **実建物だけ完全停止、道路は無関係に生成され続ける**。症状と一致。

**修正6の実装指示**(対象: `js/legacy/part1.js` unloadFarBuildings):

- ヒストグラムのカットオフ計算を「近い順にtargetまで数える」から
  「**超過分を遠い側から数えて解放する**」に変える:
```js
if (_nearCap) {
  // (ヒストグラム構築は現状のまま)
  const needFree = buildingRecords.length - PERF.bMax * 0.85; // 総数基準の超過分
  let acc = 0, cutoff = NBIN;
  for (let i = NBIN - 1; i >= 0; i--) {          // 遠いビンから累積
    acc += hist[i];
    if (acc >= needFree) { cutoff = i; break; }
  }
  const cutR = Math.max(cutoff, 3) * BIN;         // 最低300mは保持(足元全消し防止)
  if (cutR * cutR < d2Real) d2Real = cutR * cutR;
}
```
  実建物が少なくても「遠い実建物から超過分だけ」確実に解放される。
- 上限到達中は手続き建物も詰める: `const d2Proc = (_nearCap ? BUILDING_GEN_DIST_PROC
  : BUILDING_UNLOAD_DIST_PROC) ** 2;`(1800→1000m。チャンク再生成で復活するので安全)。
- reactivateのガード(part1.js:853)は `>= PERF.bMax` のままでよい(解放が効けば自然に外れる)。

### 副因: 道路バックログによる建物予算の絞り【原因候補B】

part9.js:434 `if (_roadBacklogForGate > 80) _buildBudget = min(budget, rush?40:5)`。
移動継続中は道路キューが常時80超になりやすく、建物は5棟/フレームに固定される。
さらに再試行(_tries)の空回りが予算枠を消費するため、実効生成数はほぼ0になり得る。

**修正**: 絞り条件を「近傍に道路残件がある場合」に限定する。pendingRoadMeshesのうち
プレイヤー800m以内の残件数を数え(checkCurrentTileRushの走査と同様、90フレーム周期の
キャッシュで可)、それが0なら絞らない。遠方の道路が詰まっているだけなら建物を止める
理由はない(「地形→道路→建物」の順序は同一エリア内でのみ意味を持つ)。

### 診断手順(実装前に必ず確認)

黄色停止の状態でPCのコンソールに貼る:
```js
console.log('records', buildingRecords.length, '/bMax', PERF.bMax,
  'dormant', dormantBuildings.length,
  'pending', pendingBuildings.length - pendingBuildingIdx,
  'roadQ', pendingRoadMeshes.length);
```
- `records`がbMax付近(95%以上) → 原因候補Aで確定。修正6を実施。
- recordsに余裕があり`roadQ`が常時80超 → 原因候補B。絞り条件の修正を実施。
- どちらでもない場合はログ(この数値の推移)を分析へ回すこと。

### 補足: 修正5とのトレードオフ(既知)

修正5でインフラ障害がgaveUpに算入されなくなったため、429ストーム中は隣接タイルが
「fetching(赤)」のまま長く残り、タイル境界64m帯の建物が隣待ち(_tries×キュー1周)で
遅くなるケースは増え得る。これは黄色停止とは別問題で、本質対応は問題2(b)の
「近傍専用再試行列」(実装指示済み・未着手ならそちらを優先度上げ)。

## 追記 2026-07-21(4): 全面赤(fetching)で道路ごと停止したケースのログ分析

### ログの読み取り(プレイヤー=タイル20,-17、東京エリア)

- 西〜中心の広範囲が`fetching`(赤)で、**failsが0〜4と小さいのに道路データが一切届いていない**。
  現在地タイルもfails=4・road=false。失敗回数が少ない=そもそも試行自体がほとんど
  走っていない。→ **取得層が沈黙している**のが直接原因(タイル個別の失敗ではない)。
- 東側(通過済みエリア)はroadReady済みでbuildDone合計≈1.1万棟、buildPending合計≈6万棟。
  bMax(std=12000)にほぼ到達している可能性が高く、追記(3)の飽和デッドロックも併発しうる。

### 仮説A(最有力): グローバル・クールダウンの実質恒久化

修正1のクールダウンは、429が続く限りstreakが積み上がり(リセットは成功時のみ)、
120秒上限に張り付く。持続的なレート制限下では「120秒に1回、数リクエスト試行→即429→
また120秒沈黙」となり、外形的には正しい振る舞いだが体感は「完全停止」。
failsが小さいままなのはこの「試行回数自体が少ない」状態と整合する。

### 仮説B(要除外): ワーカー枠のリーク

`osmTileActiveCount`が3に張り付いたままデクリメントされない経路が修正1実装時に
できていないか(新設した`!res.ok`分岐がfinallyを迂回していないか等)。ログからは
判別不可能なので計器で切り分ける。

### 実装指示(修正7)

**(a) 取得層の計器を追加【最優先・これが無いと切り分け不能】**

`updateDebugTileOverlay`のconsole.table直後(part9.js:190付近)に1行追加:
```js
console.log('[fetch] active', osmTileActiveCount, 'queue', osmTileQueue.length,
  'cooldown(ms)', Math.max(0, osmGlobalCooldownUntil - Date.now()),
  'streak', _osm429Streak, 'records', buildingRecords.length, '/', PERF.bMax,
  'dormant', dormantBuildings.length);
```
判定: cooldownが常に正の値 → 仮説A確定。active=3のままcooldown=0でqueueが減らない →
仮説B確定(デクリメント漏れを修正)。recordsがbMax≒到達なら修正6も必須。

**(b) 仮説A対策: 現在地タイルだけの「ミラー緊急経路」**

クールダウン中でも**現在地タイル1枚だけ**は別ホストで取得を試みる。リクエスト量は
最小(1枚クエリ・90フレーム周期で未取得時のみ)なので、429の原因である総量には影響しない。
```js
// checkCurrentTileRush(part8.js:696)内、rush判定がtrueかつroadReady未達のとき:
// osmGlobalCooldownUntil中でも、専用フラグで1枚クエリを
// https://overpass.kumi.systems/api/interpreter へ発行(通常キューは通さない)。
// 成功したら通常のprocessTileData/roadReadyTiles.addと同じ処理。
// 失敗したらそのまま(次の90フレーム周期でまた1回だけ)。同時実行は常に1本まで。
```
private.coffeeメイン化の失敗(実測)とは異なり、これは「本線が沈黙中の足元1枚限定の保険」。
kumi.systemsが不調ならprivate.coffeeを第2候補に。

**(c) クールダウンの回復を段階的に**

streakのリセットを「成功時に0」から「成功時に半減(`Math.floor(_osm429Streak/2)`)、
連続2回成功で0」へ。一度の偶然の成功で30秒に戻って再ストームを起こすのを防ぎつつ、
回復局面では段階的に間隔が縮む。

**(d) 順序の整理**

このケースでは修正6(bMax飽和)も併発している可能性が高い。実装順:
計器(a) → 実測で仮説A/B確定 → (b)(c)or枠リーク修正 → 修正6。

## 実装順の提案

1. 発見B(a) 冪等化 — 小差分・確実なバグ修正
2. 発見A(a) tintWall量子化 + A(c) Canvas明示解放 — 小差分
3. 発見A(b) liteのrefCount解放無効化(220キャップ復帰) — NY数十秒の直接検証にもなる
4. 問題2(b) 近傍再試行列 → (a) ミラー並走 → (c) infill保留
5. デバッグHUDへ renderer.info + facadeCache.size + Canvas累計生成数
