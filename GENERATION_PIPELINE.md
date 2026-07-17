# 生成パイプライン整理 (2026-07-15、2026-07-17改訂)

地形・川/水域・道路・建物、それぞれのNEAR/FAR構造と優先順位をコードベースで整理したもの。
行番号は `js/legacy/part{N}.js`。9ファイルは元々1本のスクリプトを機械的に分割したもので、
全ファイルがロード順(1→9)で同一グローバルスコープを共有する。

**値の正本について**: 生成・消去距離やチャンク半径などの数値は`⚙`(パフォーマンス設定)の
`PERF`プリセット(lite/std/high、part1.js:554-571)から取得するものが大半で、リリースの
たびに実測調整されている。本書はその**構造**(何が何をどの順で参照するか)を正として読み、
**数値は必ずpart1.jsの`PERF`定義を正**とすること(本書の数値は改訂時点のstdでのスナップショット)。

全体の生成順序の設計意図: **地形 → 道路 → 建物 → 森**(part8.js:18, part8.js:855-856のコメントに明記)。

---

## 1. 地形

**重要**: 描画メッシュは`farMesh`(1枚)のみ。NEAR/FARは「メッシュ」の話ではなく、
高さを取得する**標高データソース**の話(高解像度グリッドと低解像度グリッドの2種類)。
どちらのグリッドも`terrainY(x,z)`(part6.js:94、2026-07-17に`getWideTerrainY`から改名 — 「Wide」は
実態と逆でNEARを先に見る統合サンプラだったため)という1つの関数がまとめてサンプリングし、
NEARが使えればNEARを優先、無ければWIDEにフォールバックする。

### 描画メッシュ本体
- `farMesh`: 12,000m×12,000m(半径6,000m)、60×60分割(200m間隔)、常にプレイヤー中心に追従(part5.js:37-49)
- `updateFarMesh()`(part5.js:76-98): 200mグリッドを跨いだ時だけ再サンプリング。毎フレーム呼ばれる(part9.js:353)が、跨がなければ即return

### NEAR(高解像度・プレイヤー追従)
| 項目 | 値 |
|---|---|
| 範囲 | ±約4km(`NEAR_HALF_LAT/LON = 0.036`) |
| 解像度 | 20×20分割、約300〜400m間隔 |
| データ源 | 国土地理院(GSI)標高タイル優先、失敗時opentopodata |
| 再取得トリガー | 30〜600フレーム毎のタイマー **かつ** プレイヤーがグリッド中心から範囲の40%以上ズレたら(part6.js:267-276) |
| 関数 | `loadNearTerrain`(part6.js:205-261) / `checkNearTerrain`(part6.js:267-276) |

初回取得時に`establishRegionBase()`(part6.js:65-75)で標高基準(海面・雪線等)を確定させ、
`regionBaseReady`をtrueにする。5回連続失敗で諦めて`_nearGiveUp=true`(以後は建物生成を無限に待たせない)。

### WIDE/FAR(低解像度・広域)
| 項目 | 値 |
|---|---|
| 範囲 | ±約14km(`WIDE_HALF_LAT/LON = 0.13`) |
| 解像度 | 29×29分割、約1km間隔 |
| データ源 | NEARと同じ(GSI優先→opentopodata) |
| 再取得トリガー | 120〜600フレーム毎のタイマー **かつ** 範囲の32%以上ズレたら(part6.js:185-194) |
| 関数 | `loadWideTerrain`(part6.js:102-150) / `checkWideTerrain`(part6.js:185-194) |

地形自体には「生成/消去距離」という概念はなく(メッシュは常に存在)、上記の再取得閾値が実質的な相当物。
フレーム予算による分割処理も無し(トリガーされたら1フレームで全61×61頂点を書き換え)。

---

## 2. 川・水域

2つの独立した経路があり、**どちらも距離による消去が一切無い**(生成されたら永久に残る)。

### 経路A: 河川ライン(waterway) → 道路システムに相乗り
`addRoad(...,'water')`として道路と全く同じレコード・キューに入る(part8.js:127-132)。
そのため**道路と同じくROAD_UNLOAD_DIST(PERFプリセット連動。std=2500m)でGPUメッシュだけ解放**され、
近づけば復元される。軽量レコード(`roadRecords`/`roadGrid`。2026-07-17に`minimapRoads`から改名 —
ミニマップは一利用者に過ぎず、実体はisOnRoad判定・踏切検出・アンロード判定の正本レコードのため)
自体は消えない。

### 経路B: 水域ポリゴン(natural=water, riverbank, マルチポリゴン)
`handleAreaFeature`/`processWaterRelation`(part4.js:610-711)が同期的に処理。
`avoidPolygons`(建物の生成回避)に登録 + 予算内なら`buildAreaPoly`で実メッシュ生成。

- 予算: `areaPolyBudget = { park: 80, water: 400, farm: 250, campus: 60 }`(part4.js:329)
  — **セッション通算の一回限りの上限**(フレーム予算ではない)。waterは都市部で早期に枯渇した
  実績があり400へ増枠済み(2026-07-16)。park/campusは増枠しておらず、長距離移動で
  「後から訪れた地域だけ公園の芝生・キャンパス地面が無い」状態になり得る(未対応。P7参照)。
  使い切った予算は以降メッシュ無し(回避判定・ミニマップ表示は引き続き機能)。
- コード上に明記: `avoidPolygons`/`landusePolygons`/`areaPolyMeshes`/`minimapWaterPolys`は
  「増え続けて減らない」(part4.js:398, part7.js:328, part8.js:408のコメント)。削除処理は存在しない。

### 優先度
OSMタイル1バッチの処理順(part8.js:101-144)で、道路・河川ラインの直後に水域ポリゴンを処理し、
**建物より先**(part8.js:145以降が建物)。フレーム分割されず同期処理なので、道路と同程度に速い。

---

## 3. 道路

### 記録とメッシュ生成は2段階
`addRoad()`(part3.js:737-825)は軽量な記録登録(`addRoadRecord`→即`isOnRoad`判定・ミニマップ有効)+
`queueRoadMesh()`のみ。重いメッシュ生成(`makeRoadGeo`、1m毎の地形サンプリング)は後述キューへ。

### キュー・フレーム予算
```js
const roadBudgetMs = Math.min(24, 6 + Math.floor(pendingRoadMeshes.length / 150));
```
- **バックログに応じて可変**(下限6ms/フレーム、上限24ms/フレーム)。2026-07-15に固定6msから変更
  (以前は建物側だけ可変予算で、混雑時に建物が道路を追い越す逆転が起きていたため)。
- 新規追加分は距離順に事前ソート(`sortNewEntriesByDistanceToPlayer`、part8.js:138)、
  さらに30フレーム毎に全体を距離順で再ソート(part9.js:249-252)。

### 消去距離
`ROAD_UNLOAD_DIST = PERF.roadUnload`(part1.js:572。lite=1600m/std=2500m/high=3200m)。
90フレーム(~1.5秒)毎に判定し、GPUメッシュ・ジオメトリだけ解放(`r.mesh=null`)、レコード自体は残る。
高架(motorway)は対象外(InstancedMeshの橋脚が個別解放できないため)。
近づけば`rebuildRoadMesh`が自動復元。

### 生成距離
明示的な「生成開始距離」ゲートは無し — OSMタイルが届いた時点で即キュー投入。
実質的な出現範囲は「OSMタイルが先読みされる範囲」で決まる:先読み半径`PERF.prefetchR`
(1タイル=1600m四方、part8.js:624)は lite/std=2(=5×5タイル)、high=3(=7×7タイル)。

---

## 4. 建物

**実OSM建物**と**手続き生成(procedural infill)建物**は完全に別系統・別半径。

### (A) 実OSM建物 — `pendingBuildings`キュー
`processTileData`(part8.js:148-199)でOSM建物ポリゴンから`{x,z,w,d,h,style,real:true}`を積む。

**フレーム処理**(part9.js:271-338、2026-07-16に初期ラッシュ判定を追加):
```js
const _rush = performance.now() < 30000 || _curTileRush; // 起動30秒 or 現在地タイル未完了
let _buildBudget = Math.min(_rush ? 400 : 160, 20 + Math.floor(_buildBacklog / 20));
if (_roadBacklogForGate > 80) _buildBudget = Math.min(_buildBudget, _rush ? 40 : 5); // 道路優先の逆転防止
const _buildFrameDeadline = performance.now() + (_rush ? 14 : 8); // ms
```
- 件数予算: バックログに応じ20〜160棟/フレーム(通常時)、初期ラッシュ中(起動30秒 or 現在地タイル
  未完了)は最大400棟/フレームまで拡大(2026-07-16、体感の待ち時間短縮のため一時的にFPS低下を許容)
- **道路優先の強制**: 道路キューのバックログが80件を超えている間は建物側予算を5棟(ラッシュ中は40棟)
  まで絞る。完全ゼロにはしない — 疎な地域の孤立建物が永久に出なくなるのを防ぐため
- 時間予算: 通常8ms/ラッシュ中14ms(1棟あたりのコストが場所により大きく違うための安全弁)
- **生成距離ゲート**: `BUILDING_GEN_DIST_REAL`(`PERF.bGenReal`)より遠い実建物は`dormantBuildings`へ退避
- **総数上限ゲート**: `buildingRecords.length >= PERF.bMax`に達したら以降もdormantへ退避
  (密集地でのGPUメモリ超過クラッシュ対策、2026-07-16)
- **地形準備ゲート**: `chunkNearTerrainReady()`が false ならキュー末尾へ回して次フレームで再判定
  (最大200回試行、それでも揃わなければFAR地形基準のまま諦めて生成)

### 生成/消去距離・総数上限(いずれもPERFプリセット連動、part1.js:568-570)
| 定数 | lite | std(既定) | high | 意味 |
|---|---|---|---|---|
| `bGenReal` | 1400m | 2200m | 4200m | これより遠い実建物は生成しない(dormantBuildingsへ) |
| `bUnloadReal` | 2000m | 2900m | 5200m | これより遠い実建物はGPUメッシュを解放 |
| `bMax` | 6000 | 12000 | 25000 | 描画済み実建物の総数上限(超過分はdormantへ) |

2つの距離値をあえて分けている(ヒステリシス)のは、境界付近を行き来しても毎フレーム生成/消去を
繰り返さないため。`unloadFarBuildings()`/`reactivateNearbyDormantBuildings()`が90フレーム
(~1.5秒)毎に相互に監視し、近づけば`pendingBuildings`へ復帰、離れれば`dormantBuildings`へ退避。
`bMax`到達中は消去距離を生成距離まで詰め、さらに距離ヒストグラムで近い85%だけ残す
特別処理が入る(part1.js:759-784)。

### (B) 手続き生成(procedural infill)建物 — 別半径
```js
const CHUNK_SIZE = 120;             // 1チャンク=120m四方(固定)
const CHUNK_RADIUS = USES_MEIJI_LANDUSE ? 4 : PERF.chunkR; // 明治固定4。現実モードはPERF連動
```
- `PERF.chunkR`: lite=4(±480m) / std=8(±960m) / high=10(±1200m)。明治は常に4(±480m)
- 生成半径: `CHUNK_RADIUS × CHUNK_SIZE`
- 消去半径: `(CHUNK_RADIUS+2) × CHUNK_SIZE`
- `updateChunks()`(part8.js:801-852): プレイヤーがチャンクを跨いだ時だけキュー更新
- `processChunkQueue()`(part8.js:884-907): **1チャンク/フレーム**。以下2つが揃うまで生成しない:
  - `chunkTilesReady()`: そのチャンクを覆うOSMタイルの道路データが確定済みか
  - `chunkNearTerrainReady()`: NEAR高解像度地形がそのチャンクを覆っているか
- 両方揃って初めて`generateChunk()`が実行される(道路密度に応じた家並び生成等)

### 森(参考: 建物・道路との位置関係)
`FOREST_R = PERF.forestR`(lite=360m/std=480m/high=600m、part9.js:13)。
2026-07-16以前は`(CHUNK_RADIUS+1) × CHUNK_SIZE`で手続き生成建物の生成/消去半径の中間に連動していたが、
`CHUNK_RADIUS`をPERF連動で大きく引き上げた(std換算だと960〜1200m)際に森の負荷が跳ね上がるため、
森だけPERF直値に切り離した固定値になっている。**現在は建物半径と連動していない**ので、
「森は建物のちょうど中間」という古い前提でコードを読まないこと。

---

## 5. 全体を止めているゲート: `initialWorldLoaded`

```js
let initialWorldLoaded = false; // part8.js:40
function checkOSMTiles() { if (!initialWorldLoaded) return; ... } // part8.js:358
```

起動時、`loadNearTerrain(0,0)`(原点の地形)が完了するまでは`loadOSM()`が呼ばれず、
`loadOSM()`の最後で`initialWorldLoaded = true`になって初めて`checkOSMTiles()`(タイル取得)・
`updateChunks()`/`generateChunk()`(建物)・`updateForest()`(森)が動き出す。
「地形が先に確定していないと道路が平地の高さで生成され、後から地形が持ち上がって
道路が地面に埋まる」不具合を防ぐための設計。

さらにタイル単位でも「道路確定 → その上で建物」の順序が徹底されている:
`roadReadyTiles`(2026-07-17に`loadedOSMTiles`から改名 — 「取得済み」と「道路確定済み」の
区別が名前から読めなかったため。対になる`queuedTiles`は`fetchedOSMTiles`から改名)は
道路・水域の処理が終わった時点(または4回失敗して諦めた時点)でマークされ、
`chunkTilesReady()`はこれを見てから建物生成を許可する。

---

## 6. 毎フレームの呼び出し順序(`animate()`, part9.js:221-358)

```
requestAnimationFrame(animate)  ← 例外が起きても次フレームは必ず予約される
movement / camera
updateChunks()                  // チャンク跨ぎ時のみキュー更新
processChunkQueue()             // 1チャンク/フレーム(地形・道路readyでゲート)
[道路キュー 距離再ソート(30フレーム毎)]
processRoadMeshQueue()          // 可変6-24ms
[建物キュー 距離再ソート(30フレーム毎)]
[建物処理ループ]                 // 可変20-160棟(初期ラッシュ中400)、道路バックログ>80なら5棟(ラッシュ中40)に制限、8ms上限(ラッシュ中14ms)
unloadFarBuildings()            // 90フレーム毎
reactivateNearbyDormantBuildings() // 90フレーム毎
unloadFarRoads()                // 90フレーム毎
checkOSMTiles()                 // 30フレーム毎(内部) + initialWorldLoadedゲート
checkWideTerrain()              // 120-600フレーム毎(内部)
checkNearTerrain()              // 30-600フレーム毎(内部)
checkAddressDisplay()
updateForest()                  // 60m移動毎
sky/star/sea 追従
updateFarMesh()                 // 200mグリッド跨ぎ時のみ
renderer.render()
drawMinimap()
updateGPS()
```

### 優先順位のまとめ
1. **地形**が構造的に最優先 — 原点の地形が確定するまで道路・建物・森は一切動かない(`initialWorldLoaded`ゲート)
2. **道路**は毎フレームのコード順序でも建物より先に処理され、道路のバックログが大きい間は
   建物の処理量を明示的に絞る(2026-07-15追加の逆転防止策)
3. **川・水域**は道路と同じOSMタイル処理パス内で、建物キューに積まれるより前に同期処理される
   (フレーム分割なし、一回限りの描画予算のみ)
4. **建物**が実質最も優先度が低い — 呼び出し順序・道路バックログによる予算制限・
   生成距離ゲート(`PERF.bGenReal`、既定std=2200m)・総数上限(`PERF.bMax`)・
   地形readyゲートの5重の制約を受ける
5. **森**は建物・道路よりさらに後回し。半径は`PERF.forestR`固定で、手続き生成建物の
   半径(PERF.chunkR連動)とはもう連動していない(2026-07-16に負荷対策で切り離し済み)
