# 生成パイプライン整理 (2026-07-15)

地形・川/水域・道路・建物、それぞれのNEAR/FAR構造と優先順位をコードベースで整理したもの。
行番号は `js/legacy/part{N}.js`。9ファイルは元々1本のスクリプトを機械的に分割したもので、
全ファイルがロード順(1→9)で同一グローバルスコープを共有する。

全体の生成順序の設計意図: **地形 → 道路 → 建物 → 森**(part8.js:18, part8.js:855-856のコメントに明記)。

---

## 1. 地形

**重要**: 描画メッシュは`farMesh`(1枚)のみ。NEAR/FARは「メッシュ」の話ではなく、
高さを取得する**標高データソース**の話(高解像度グリッドと低解像度グリッドの2種類)。
どちらのグリッドも`getWideTerrainY(x,z)`(part6.js:94-100)という1つの関数がまとめてサンプリングし、
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
そのため**道路と同じくROAD_UNLOAD_DIST(2500m)でGPUメッシュだけ解放**され、近づけば復元される。
軽量レコード(`minimapRoads`/`roadGrid`)自体は消えない。

### 経路B: 水域ポリゴン(natural=water, riverbank, マルチポリゴン)
`handleAreaFeature`/`processWaterRelation`(part4.js:610-711)が同期的に処理。
`avoidPolygons`(建物の生成回避)に登録 + 予算内なら`buildAreaPoly`で実メッシュ生成。

- 予算: `areaPolyBudget = { park: 80, water: 80, farm: 250, campus: 60 }`(part4.js:326)
  — **セッション通算の一回限りの上限**(フレーム予算ではない)。80枚使い切ったら以降は
  メッシュ無し(回避判定・ミニマップ表示は引き続き機能)。
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
`ROAD_UNLOAD_DIST = 2500m`(part1.js:482)。90フレーム(~1.5秒)毎に判定し、GPUメッシュ・
ジオメトリだけ解放(`r.mesh=null`)、レコード自体は残る。高架(motorway)は対象外
(InstancedMeshの橋脚が個別解放できないため)。近づけば`rebuildRoadMesh`が自動復元。

### 生成距離
明示的な「生成開始距離」ゲートは無し — OSMタイルが届いた時点で即キュー投入。
実質的な出現範囲は「OSMタイルが先読みされる範囲」(7×7タイル、1タイル=1600m四方)で決まる。

---

## 4. 建物

**実OSM建物**と**手続き生成(procedural infill)建物**は完全に別系統・別半径。

### (A) 実OSM建物 — `pendingBuildings`キュー
`processTileData`(part8.js:148-199)でOSM建物ポリゴンから`{x,z,w,d,h,style,real:true}`を積む。

**フレーム処理**(part9.js:271-315):
```js
let _buildBudget = Math.min(80, 20 + Math.floor(_buildBacklog / 25)); // 下限20〜上限80/フレーム
if (pendingRoadMeshes.length > 80) _buildBudget = Math.min(_buildBudget, 5); // 道路優先の明示的な逆転防止
```
- 件数予算: バックログに応じ20〜80棟/フレーム(可変)
- **道路優先の強制**: 道路キューのバックログが80件を超えている間は、建物側の予算を5棟/フレームまで絞る
  (2026-07-15追加。完全ゼロにはしない — 疎な地域の孤立建物が永久に出なくなるのを防ぐため)
- 時間予算: 8ms/フレームの上限も別途あり(1棟あたりのコストが場所により大きく違うための保険)
- **生成距離ゲート**: `BUILDING_GEN_DIST = 800m`より遠い実建物は`dormantBuildings`へ退避、生成しない
- **地形準備ゲート**: `chunkNearTerrainReady()`が false ならキュー末尾へ回して次フレームで再判定
  (最大200回試行、それでも揃わなければFAR地形基準のまま諦めて生成)

### 生成/消去距離
| 定数 | 値 | 意味 |
|---|---|---|
| `BUILDING_GEN_DIST` | 800m | これより遠い実建物は生成しない(dormantBuildingsへ) |
| `BUILDING_UNLOAD_DIST` | 1500m | これより遠い実建物はGPUメッシュを解放 |

2つの値をあえて分けている(ヒステリシス)のは、境界付近を行き来しても毎フレーム生成/消去を
繰り返さないため。`unloadFarBuildings()`/`reactivateNearbyDormantBuildings()`が90フレーム
(~1.5秒)毎に相互に監視し、近づけば`pendingBuildings`へ復帰、離れれば`dormantBuildings`へ退避。

### (B) 手続き生成(procedural infill)建物 — 別半径
```js
const CHUNK_SIZE = 120;             // 1チャンク=120m四方
const CHUNK_RADIUS = 3;             // 現実モード。明治モードは4
```
- 生成半径: `CHUNK_RADIUS × CHUNK_SIZE = ±360m`(明治は±480m)
- 消去半径: `(CHUNK_RADIUS+2) × CHUNK_SIZE = 600m`
- `updateChunks()`(part8.js:801-852): プレイヤーがチャンクを跨いだ時だけキュー更新
- `processChunkQueue()`(part8.js:884-907): **1チャンク/フレーム**。以下2つが揃うまで生成しない:
  - `chunkTilesReady()`: そのチャンクを覆うOSMタイルの道路データが確定済みか
  - `chunkNearTerrainReady()`: NEAR高解像度地形がそのチャンクを覆っているか
- 両方揃って初めて`generateChunk()`が実行される(道路密度に応じた家並び生成等)

### 森(参考: 建物・道路との位置関係)
`FOREST_R = (CHUNK_RADIUS+1) × CHUNK_SIZE = 480m` — 建物生成半径(360m)と消去半径(600m)の
ちょうど中間に意図的に設定(part9.js:8-10のコメントに明記)。

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
`loadedOSMTiles`は道路・水域の処理が終わった時点(または4回失敗して諦めた時点)で
マークされ、`chunkTilesReady()`はこれを見てから建物生成を許可する。

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
[建物処理ループ]                 // 可変20-80棟、道路バックログ>80なら5棟に制限、8ms上限
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
   生成距離ゲート(800m)・地形readyゲートの4重の制約を受ける
5. **森**は建物・道路よりさらに後回し(意図的に建物生成半径と消去半径の中間に設定)
