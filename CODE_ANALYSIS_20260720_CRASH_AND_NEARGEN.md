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

## 実装順の提案

1. 発見B(a) 冪等化 — 小差分・確実なバグ修正
2. 発見A(a) tintWall量子化 + A(c) Canvas明示解放 — 小差分
3. 発見A(b) liteのrefCount解放無効化(220キャップ復帰) — NY数十秒の直接検証にもなる
4. 問題2(b) 近傍再試行列 → (a) ミラー並走 → (c) infill保留
5. デバッグHUDへ renderer.info + facadeCache.size + Canvas累計生成数
