# ChronoDrift コードベース品質レビュー (2026-07-17)

対象: js/legacy/part1〜9.js、js/core/mode-registry.js、server/server.js、index.html、GENERATION_PIPELINE.md ほか。
前提として尊重した事情: Overpass防御層・大量コメント・実測済み定数は「簡略化しない」。

---

## 総評(3行)

1. **「シンプルで美しい」ではないが、「経緯が焼き込まれた、実戦的で誠実な」コードベース**。障害対応の履歴がコメントとして残り、順序ゲート(地形→道路→建物)や部分応答検証(out count)など難しい問題への解法自体は的確。
2. 最大の構造的リスクは**建物の状態が7つの並行コレクション**(buildingRecords / collisionBoxes+collGrid / minimapBuildings / placedBuildings / buildingGrid / knownBuildingGrid / pending+dormant)に分散し、削除処理が3箇所に複製されていること。ここが今後のバグの最有力発生源。
3. 即効性のある改善は (a) generateChunkホットパスに残った**hasBuildingNearbyの線形走査**、(b) 撤去済み機能の**死コード一掃**、(c) **紛らわしい命名4組のリネーム**。いずれもリスクが低く、挙動を変えない。

---

## 優先度順の指摘リスト

### P1: hasBuildingNearby が唯一残った「全件線形走査」ホットパス
- **対象**: part1.js:877-884(定義)、part8.js:798, 835, 859, 882, 934, 1007(呼び出し)
- **問題**: このコードベースは「増え続ける配列の線形走査」を空間ハッシュで潰してきた歴史がある(isOnRoad、minimapRoads、areaPolyMeshes…全てコメントに経緯あり)のに、`hasBuildingNearby`だけが `placedBuildings` 全件を線形走査したまま。generateChunkは1チャンクあたり数百の候補地点でこれを呼ぶため、bMax=12000(標準)近くまで建物が溜まった密集地では **1チャンク生成 = 数百万回の距離計算** になり、1フレームスパイクの原因になり得る。part9.js:28のコメントが皮肉にも「以前のhasBuildingNearbyは線形走査で重かった」と自認している。
- **提案**: placedBuildingsを空間ハッシュ化する(最小手: `_gridAddTo`を流用しBUILDING_CELLで別グリッドを持つ。あるいはbuildingGridに`r`を持たせて代用)。判定ロジック(b.r込みの距離)は変えない。
- **リスク**: 低(判定結果は同一。削除時のグリッド同期だけ注意 — 既存のrebuildBuildingGridと同じタイミングで再構築すればよい)
- **工数**: 1〜2時間

### P2: 撤去済み機能の死コード(検証済み・呼び出しゼロ)
- **対象と内容**:
  - part3.js:562 `pierP` — 橋脚廃止(コメント687, 702-703)後も500インスタンスのInstancedMeshを生成しsceneに追加したまま。純粋なGPU/メモリの無駄。
  - part3.js:569-574 `xingBarP`、577-578 `nodeUse`は横断歩道用に生存だが `xingCount`、581-590 `segCross`、593-606 `addRailXing` — 踏切廃止(2026-07-16)後、**segCross/addRailXing/xingCount/xingBarPは呼び出し箇所ゼロ**(grep確認済み)。xingBarPも240インスタンス分のプール生成が走る。
  - part1.js:205-209 — `moonLight.castShadow = false` の直後にshadow.mapSize/camera設定5行。影は全体で無効(part1.js:108)なので完全に死んだ設定。
  - part5.js:15-16 `WORLD_W`/`WORLD_D` — 伊勢原専用地形メッシュ廃止(2026-07-14)後、参照ゼロ。
  - server.js:192-197 `window.setTimeout`パッチ — 旧クライアントのレート制限待ち(1100/1500ms)短縮用だが、該当のsetTimeoutはもう存在しない。**しかも有害**: part6.js:400-403の `Promise.race([updateAddressDisplay(), setTimeout 1500ms])` が対象に誤爆し、直前のAPIがキャッシュHITだと国コード取得の猶予1.5秒が15msに切り詰められる(国別プロファイル焼き込み漏れの遠因になり得る)。
- **提案**: 上記をまとめて削除。撤去の経緯コメントは残す(運用方針どおり)。
- **リスク**: 低(全て参照ゼロを確認済み。setTimeoutパッチ削除はむしろ正しい挙動に戻す)
- **工数**: 30分

### P3: 建物状態の7コレクション分散と削除処理の3重複製
- **対象**: part1.js:368-375(removeBuildingsOverlappingRoad)、part1.js:810-815(unloadFarBuildings)、part8.js:1101-1112(updateChunks)
- **問題**: 建物1棟の削除に「buildingRecords splice + collisionBoxes filter + minimapBuildings filter + placedBuildings filter + rebuildCollGrid + rebuildBuildingGrid」という同じ6点セットが3箇所にほぼコピペで存在(片やbid基準、片やchunkKey基準)。新しい建物属性・新しいインデックスを足すたびに3箇所の同期漏れリスクがある。実際、過去の不具合(幽霊当たり判定、"rec.parts is not iterable")はこの分散が土壌。
- **提案**: `removeBuildings(predicate)` 1関数に集約(bid Set版とchunkKey版は述語だけ差し替え)。将来的には「大きいリファクタ#1」のBuildingStoreへ。
- **リスク**: 中(削除順序・グリッド再構築タイミングを変えないよう注意)
- **工数**: 半日

### P4: 削除のたびの collGrid / buildingGrid 全再構築
- **対象**: part1.js:291-294(rebuildCollGrid)、692-695(rebuildBuildingGrid)、呼び出しは上記3箇所
- **問題**: unloadFarBuildingsは~1.5秒ごとに走り、1棟でも削除があると **全建物×全所属セル** のグリッド再構築(O(N))。bMax上限付近の密集地で移動し続けると、この再構築自体が周期的なコストになる(数千レコード×複数セル登録)。
- **提案**: レコード側に登録セルキー配列を持たせ、削除時に該当セルからだけ抜く「差分削除」に変更。追加はいまのままでよい。
- **リスク**: 中(セル登録と削除の対応漏れがあると幽霊判定が復活する。P3の集約後にやると安全)
- **工数**: 半日

### P5: 命名 — 実態と名前がズレている4組
- **対象/提案**:
  | 現在 | 問題 | 改名案 |
  |---|---|---|
  | `buildingGrid` vs `knownBuildingGrid` (part1.js:668-691) | 「known」だけでは描画済み/未描画スタブの区別が読めない。過去に混同で実バグ発生済み | `meshedBuildingGrid` vs `queuedRealBuildingGrid`(または`realBuildingIndex`) |
  | `fetchedOSMTiles` vs `loadedOSMTiles` (part8.js:16-19) | fetch済みとload済みの差(=キュー投入済み vs 道路確定済み)が名前から読めない | `queuedTiles` vs `roadReadyTiles` |
  | `minimapRoads` / `minimapBuildings` (part1.js:298-299) | 実際はisOnRoad・踏切・アンロード・当たり判定の**正本レコード**。ミニマップは一利用者にすぎない | `roadRecords` / (buildings側は既にbuildingRecordsがあるので`minimapBuildings`の責務をそちらへ寄せる) |
  | `getWideTerrainY` (part6.js:94-100) | NEARを先に見る統合サンプラなのに「Wide」。NEAR/FAR/WIDEの用語も混在(farMeshがwideElevを参照) | `terrainY`(統合)+ 用語をNEAR/FARの2語に統一 |
- **リスク**: 低(classic script global。grepで全参照を機械置換できる。1組ずつコミットを分ける)
- **工数**: 1〜2時間(コメント内の言及も同時更新)

### P6: GENERATION_PIPELINE.md が現行コードと乖離
- **対象**: GENERATION_PIPELINE.md(BUILDING_GEN_DIST=800m/1500m、water予算80、CHUNK_RADIUS=3、7×7タイル先読み、建物予算20-80と記載)
- **問題**: 現行は PERF プリセット制(標準: real=2200/2900m、chunkR=8、prefetchR=2=5×5)、water=400、建物予算はラッシュ時400棟/14ms。このプロジェクトはドキュメント・コメントが運用の柱なので、乖離した設計書は将来の判断ミスを誘発する。
- **提案**: PERF表(lite/std/high)を正とする形で改訂。「値はpart1.js PERFが正、本書は構造のみ」と明記するのも手。
- **リスク**: なし / **工数**: 30分

### P7: 一方通行で枯渇する資源(プール・面ポリゴン予算)
- **対象**: part2.js:715-743ほか(poleP 3000 / guardP 2500 / vendP 400 / benchP 400 / lampP / signalP / signBoardP / scrubP 2400)、part4.js:329(areaPolyBudget: park 80 / farm 250 / campus 60)
- **問題**: 道路小物のインスタンスプールと面ポリゴン予算は**セッション累計の使い切り**で、遠くへ移動してもリサイクルされない。長距離移動すると「後から訪れた地域だけガードレール・自販機・信号・公園の芝生・田畑テクスチャが無い」状態になる(waterは400に増枠して延命したが、park 80/campus 60は都市部だとすぐ尽きる)。森(rebuildForest)だけは「移動のたび作り直し」方式で解決済み。
- **提案**: (a) 短期: 尽きた事実を可視化(デバッグ表示にプール残量)+park/campus予算をwater同様に増枠。(b) 中期: 道路小物をチャンク/道路レコードに紐付けて距離アンロード時にインスタンス枠を返却する(poolAddの返り値idxを既に持てる設計になっているので、フリーリスト化は可能)。
- **リスク**: (a)は低、(b)は中(InstancedMeshの穴あき管理) / **工数**: (a)1時間、(b)1〜2日

### P8: 無限に成長するデータ構造の棚卸し
- **対象**: `seenOSMWays`(part8.js:45)、`nodeUse`(part3.js:577)、`osmTileFailCount`、`knownBuildingGrid`、`minimapRoads`+`roadGrid`、`areaPolyMeshes`/`avoidPolygons`/`landusePolygons`、`railSegs`、server側ディスクキャッシュ(server.js:400-404、削除処理なし)
- **問題**: 「レコードは軽量なので残す」は正しい設計判断だが、上限も掃除も監視も無いものが混在。特に (1) seenOSMWaysは長時間プレイで数十万ID(数十MB)に達し得る、(2) serverのディスクキャッシュはRenderの永続ディスク/コンテナFSを無限に食う、(3) unloadFarRoadsはminimapRoads全件を90フレームごとに線形走査するため、走査コスト自体がレコード数に比例して伸び続ける。
- **提案**: GSIタイルキャッシュ(GSI_TILE_CACHE_MAX=120で古い順破棄、part5.js:160)という**社内前例**があるので、同じパターンを適用: seenOSMWays/nodeUseに上限+古い順破棄、serverキャッシュにサイズ上限つき掃除(起動時 or cron的に)、unloadFarRoadsはroadGridセル走査に置換(近傍セル外は触らない)。
- **リスク**: 低〜中(seenOSMWaysの破棄は再訪時の二重生成防止と衝突しないようタイル単位で) / **工数**: 各1〜3時間

### P9: 重複ロジックの共通化(やるべきもの / やるべきでないもの)
- **共通化すべき(事情が同じ・振る舞い同一)**:
  1. **点-線分距離**: roadNear(part1.js:642)、isOnRoad(part2.js:836)、nearMinorRoad(part8.js:767)、isNearWater(part8.js:903)の4箇所に同じclamp-t距離計算。純関数 `distSqPointToSeg(px,pz,seg)` を1つ切り出す。
  2. **空間ハッシュ**: collGrid/roadGrid/_gridAddTo(building)/polyGrid の4実装。polyGridが既に汎用形なので、セルサイズをパラメタ化した1クラス(add/query/removeByRef)へ寄せられる。
  3. **loadNearTerrain / loadWideTerrain**(part6.js:102-150 / 205-261): 9割同一(グリッド点生成→GSI→opentopodataフォールバック→Float32化)。`loadTerrainGrid(spec)`に統合し、NEAR固有の establishRegionBase / rebuild連鎖だけ後処理に残す。
  4. **フレームカウンタ間引き**: `_xxxFrame % N` パターンが11箇所(_roadUnloadFrame, _buildingUnloadFrame, _dormantCheckFrame, _curTileRushFrame, _osmCheckFrame, _addrCheckFrame, _nearCheckFrame, _wideCheckFrame, _mmFrame, _buildingSortFrame, _roadSortFrame)。`every(n, fn)`ヘルパか小さなスケジューラ1個で置換可能。
  5. `landuseTypeAt`(part1.js:427)と generateChunk 内 `luTypeAt`(part8.js:671)— 同じ判定の2実装。
- **共通化すべきでない(事情が違う)**:
  - **再試行/バックオフ3系統**(OSMタイル: 失敗回数×3秒+4回で諦めゲート解放 / 地形: 間隔逓増+諦めトースト / server: ホストクールダウン+ミラー輪番)。失敗の意味も回復戦略も別物。無理に統一すると「4回失敗で建物ゲートだけ解放する」といった微妙な仕様が壊れる。
  - **道路キューと建物キュー**(splice消化 vs カーソル+末尾再push)。再試行セマンティクスが違う(道路は再キュー不要、建物は_tries付きで待つ)ため、見た目が似ていても統合しない方が安全。
  - **NEAR/WIDEのsampleGrid呼び分け**(inRangeOnlyの意味が違う)は現状の1関数+フラグで十分。
- **リスク**: 低(1,4,5)〜中(2,3) / **工数**: 各1時間〜半日

### P10: メインループの周期ソートと走査コスト
- **対象**: part9.js:252-255(pendingRoadMeshes全体を30フレームごとにソート)、part8.js:575-593(checkCurrentTileRushが両キューを全走査)
- **問題**: 密集地でpendingRoadMeshesが数万件あるとき、0.5秒ごとの全ソートは数ms〜10ms級。checkCurrentTileRushも同様のO(N)走査(こちらは1.5秒ごとで軽症)。実測チューニングの積み重ねなので壊さない前提で言うと、遠い要素は距離順の精度が要らない。
- **提案**: 「近傍(例: 2タイル以内)だけ厳密ソート+それ以遠はバケツ分け」の2段構成にすればソート対象を桁で減らせる。効果が薄ければ触らない(現状でも動いてはいる)。
- **リスク**: 中(生成順の体感が変わり得る。実機確認必須) / **工数**: 半日

### P11: 毎フレームのGCチャーン(微小)
- **対象**: part9.js:98-99(forward/right Vector3を毎フレームnew)、217-218(idealCam/safeCam)、part7.js:242-254(occlusionCamPosが毎フレーム最大40回のclone/addScaledVector)
- **問題**: フレームあたり数十個の短命Vector3。スマホでのGCポーズ要因としては小さいが、コードベースの他所(_dummy, _cA/_cB, WORLD_FOGの「毎フレームnewしない」コメント)と方針が不一致。
- **提案**: モジュールスコープの再利用Vector3に置換(既存の_instMat等と同じパターン)。
- **リスク**: 低 / **工数**: 1時間

### P12: facadeCache / matCache の成長条件
- **対象**: part2.js:14-20, 77-83、part3.js:91-105(tintWall)
- **問題**: tintWallは6段階に量子化してキャッシュ爆発を防いでいる(コメントどおり)が、**ベース色がOSMのbuilding:colourタグ由来だと任意色**になり、「任意色×6ティント×2バリアント」でファサードCanvas(128px+発光マップ)が増える。色タグが豊富な欧州都市で長時間プレイすると効いてくる可能性。
- **提案**: parseOsmColor通過後の色を量子化(例: RGB各16段階に丸め)してからキャッシュキーにする。見た目の劣化はほぼ知覚不能。
- **リスク**: 低 / **工数**: 1時間

### P13: 構造 — part1〜9グローバル共有の限界が出ている箇所(問1への回答)
- **既に顕在化している症状**:
  1. 起動IIFEがpart6→part9へ引っ越し(part6.js:423-429)— scriptタグ間で巻き上げが効かない問題を「移動」で回避。
  2. part5.js:55-61 farNodeYの `typeof getWideTerrainY !== 'function'` — ロード順依存のTDZ回避が実行時チェックとして恒久化。
  3. part2.js:988「OFFICE_STYLE定数は使えないのでここでは複製する」— 定義順の制約が**データ複製**を強制。
  4. part1がpart2(_minAbsOverWindow)・part8(pendingBuildings/dormantBuildings)の実行時参照を持つ — ファイル番号と依存方向が一致していない。
- **リスクが低く効果が高い切れ目(順に)**:
  1. **純関数層** `js/lib/`: pointInPolygon, thinPts, stitchRings, _minAbsOverWindow, sampleGrid, wrapLon, parseOsmColor, shadeHex, _fhash, pickWeighted, waterwayWidth, meijiMeshCode, distSqPointToSeg(新設)。THREEにもグローバルにも依存しないので、scriptタグを1本足すだけで切り出せる(挙動不変・テスト可能化の土台)。
  2. **SpatialHashクラス**(P9-2)。
  3. **地形サブシステム**(part5+part6の標高部分): 外部との接点が getGroundY / loadNear / loadWide / regionBaseReady / elevBase / SEA_Y に限られており、既に事実上のモジュール。
  4. **server.js**は既に独立しており手を入れる必要なし。
  5. **切ってはいけない場所**: 建物生成(part3 addBuilding ↔ part8 processTileData/generateChunk ↔ part9 生成ループ)は7コレクション問題(P3)が解決するまで分割しない。いま切ると境界がコレクション同期をまたいで増えるだけ。

### P14: テスト可能性 — 費用対効果の高い最初の対象(問6への回答)
現状テストゼロ。**THREE非依存の純関数**から始めるのが唯一の低コスト路線(node:test + P13-1のjs/lib切り出しとセット)。優先順:
1. **stitchRings**(part4.js:586-611)— 端点一致の連結・逆順・開リング採用と分岐が多く、大河川の見た目に直結。回帰が怖い代表格。
2. **_minAbsOverWindow + fitRealBuildingToRoads の数学部**(part2.js:866-933)— 建物縮小/線路drop判定。座標変換の符号ミスが「建物が消える/被る」に直結した実績あり(DEBUG_SESSION_20260716)。roadGrid依存を「セグメント配列を引数で渡す」形に変えれば純関数化できる。
3. **processTileDataの向き推定ブロック**(part8.js:181-199)— 最長辺方位角→回転外接矩形→中心逆変換。L字・45度回転・時計回り/反時計回りの固定ケースで守る価値が高い。関数抽出が前提。
4. **out count検証ロジック**(part8.js:508-519 と server.js:389-399 に**同じ仕様が2実装**ある)— 部分応答の見逃しはこのゲームの最悪バグ級。fixtureのJSONで両実装を同じテーブルでテストすると仕様のズレも検出できる。
5. **parseOsmColor / getBuildingStyle / waterwayWidth / classifyResidential**(landuseTypeAtを注入可能にして)— 入出力が単純でOSMタグの実例をそのままケースにできる。
6. **sampleGrid / farSurfaceY**— バイリニアと三角形分割の一致(「メッシュ表面=クエリ」不変条件)は数値テストで固定する価値あり。

### P15: 壊れやすさ — 「ここを触ると遠くが壊れる」トップ5(問5への回答)
1. **getGroundY連鎖と高さの焼き込み**(part5/6)。建物・道路・駅・面ポリゴン・小物すべてが生成時に高さを焼き込み、それぞれ別の追従機構(rebuildRoadsInBounds / rebuildBuildingsInBounds / rebuildStationsInBounds / rebuildAreaPolysInBounds / poolSetY)を持つ。地形サンプリングを1mm変えると全追従系の整合確認が必要。→ 緩和: 「高さ追従が必要なもの」を1つの登録リスト(followers)にし、NEAR更新時の呼び出しを1箇所にする。
2. **addRoadRecordの副作用連鎖**(part1.js:378): 1本の道路登録が minimapRoads追加→roadGrid登録→重なり建物の撤去(削除6点セット+実建物の再キュー)まで同期で走る。道路レコードの形(rw/type)を変えると建物撤去・fit・ミニマップ・踏切跡地すべてに波及。→ 緩和: addRoadRecordのdocコメントに副作用一覧を明記+P3の削除集約。
3. **生成順序ゲートの分散ステートマシン**: initialWorldLoaded(part8)/ loadedOSMTiles(4回失敗で「成功扱い」)/ chunkTilesReady / chunkNearTerrainReady(_nearGiveUpで解放)/ osmTilesReadyAround+_tries=200。ゲートのどれか1つの意味を変えると「道路より先に建物」が復活する(歴史が証明)。→ 緩和: ゲート判定を1ファイルに集約し、各ゲートの「諦め条件」を表で文書化。
4. **建物7コレクション**(P3と同根)。特に`bid`と`ck`の2軸削除、`real`フラグ、`_fit`/`_tries`/`_q`/`_dirty`のアドホック印。→ 緩和: BuildingStore(大リファクタ#1)。
5. **server.jsのfetch/setTimeoutモンキーパッチとURL文字列結合**(server.js:85-198): クライアントは `https://overpass-api.de/...` をハードコードし、サーバ注入が書き換える前提。クライアント側のURLやsetTimeout値を変えると**サーバ側の正規表現・等値比較が黙って外れる**。→ 緩和: クライアントに `window.API_BASE = {...}` の明示フックを1つ用意し、注入はその変数だけ上書きする方式へ(fetchパッチより1桁単純)。あわせてP2のsetTimeoutパッチ削除。

---

## すぐやるべき小さな改善 トップ5

1. **死コード一掃**(P2): pierP/xingBarP/segCross/addRailXing/xingCount、moonLightのshadow設定、WORLD_W/D、serverのsetTimeoutパッチ。30分・リスクほぼゼロ・GPUとメモリの無駄も消える。
2. **hasBuildingNearbyの空間ハッシュ化**(P1): 密集地のチャンク生成スパイクを直接削る。1〜2時間。
3. **命名4組のリネーム**(P5): buildingGrid→meshedBuildingGrid / knownBuildingGrid→realBuildingIndex、fetchedOSMTiles→queuedTiles / loadedOSMTiles→roadReadyTiles、minimapRoads→roadRecords、getWideTerrainY→terrainY。1組ずつ機械置換。
4. **GENERATION_PIPELINE.mdの数値改訂**(P6): PERFプリセット制を反映。ドキュメント駆動の運用なので費用対効果が高い。
5. **distSqPointToSegの切り出し**(P9-1)+ **exploreOnUpdate/occlusionCamPosのVector3再利用**(P11): どちらも挙動不変の機械的変更。

## 大きいが価値のあるリファクタ トップ3

1. **BuildingStoreへの集約**(P3+P4+P15-4): 7コレクションを「bidをキーにした1ストア+派生インデックス(coll/minimap/placed相当のビュー)」に統合し、追加・削除・差分グリッド更新を各1経路に。過去バグの大半(幽霊判定・parts not iterable・撤去漏れ)の再発を構造的に封じる。数日規模。段階案: ①削除の1関数化(P3)→②差分グリッド(P4)→③ストア化。
2. **純関数層 js/lib/ の切り出し+node:testの導入**(P13-1+P14): scriptタグ1本の追加で始められ、stitchRings・fit数学・向き推定・count検証にテストが付く。以後のリファクタ(1や3)の安全網になるため、実は最初にやる価値がある。
3. **生成パイプラインの状態・予算の一元化**(P15-3+P9-4): 分散した11個のフレームカウンタと4種のゲートを、1つの「スケジューラ+パイプライン状態」モジュールへ。優先順位(地形→道路→建物→森)がコードの1箇所で読めるようになり、「ラッシュ予算」「道路優先の絞り」のような調整も1ファイルで完結する。数日規模。ただし実測チューニング済みの数値は一切変えず、置き場所だけ動かすこと。

---

## 補足(良い点・変えるべきでない点)

- Overpass対策の階層(POST化・AbortController・out count検証・ミラー輪番・IndexedDBキャッシュ・serverの直列キュー+ハードタイムアウト)は、公開API相手の防御としてどれも実障害由来で正当。**簡略化対象ではない**。
- 「コメントに経緯を焼き込む」運用は、この規模・この題材(外部API依存の実測チューニング)では合理的。リファクタ時もコメントは消さず移送を推奨。
- PERFプリセット・bMaxヒストグラム淘汰・ヒステリシス距離・detailOK等の定数は実測済みとのことなので、本レビューでは値の変更提案をしていない(唯一、detailOK閾値850がbMax=12000と桁違いで「都市部では装飾が常時オフ」になる点だけ、意図どおりか一度確認を推奨)。
