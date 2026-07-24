# 実装指示: クエリ分離(Phase1〜3)の不具合修正

## 背景

`IMPL_PROMPT_20260724_TILE_QUERY_ARCH.md` の4フェーズ実装後、実機で以下の症状が発生:

- **症状A**: 「緑緑赤」(地形✓/道路✓/建物=取得中)のタイルが多数、建物が生成されないまま恒久停止
- **症状B**: タイルに突入しても「緑赤灰」(道路=取得中)のまま道路も生成されない

コードレビューで原因を特定済み。以下の修正1〜5を実装する。対象: `js/legacy/part8.js`(クライアント)、`server/server.js`(サーバー)。

## 進め方

**Step A(修正1・2・4・5、クライアントのみ)→ push → 実機確認 → Step B(修正3、サーバーのみ)→ push → 実機確認。**
デプロイタイムスタンプ更新を忘れない。pushコマンドは `;` 区切り(PowerShell 5.x)で提示。

---

## 修正1【最優先・症状Aの主因】建物ジョブの恒久消失

**場所**: part8.js `checkOSMTiles` 内 `queueTile`(L1175付近)

**問題**: 建物クエリが1回失敗すると catch で `buildingQueuedTiles.delete(k)` され、再投入は queueTile 頼みになる。しかし「roadReady済みなら建物ジョブを積み直す」分岐が `isNearSplit`(3x3圏内)の中にしかないため、タイルが3x3の外に出ていると generic 分岐に落ち、`queuedTiles.has(key)`(道路ジョブ時に登録・成功後も残る)が true なので何もしない。→ roadReady=true / buildingReady=false のまま再取得する主体が消滅。`osmTilesReadyAround` が buildingReady 必須のため、周辺チャンク生成ごと永久ブロックされる。

**修正**: 「roadReady かつ !buildingReady かつ !buildingQueued なら建物ジョブを積む」分岐を isNearSplit 条件の**外**(queueTile冒頭)に出し、全域で機能させる:

```js
const queueTile = (wx, wz) => {
  // (tx, tz, key 計算)
  if (roadReadyTiles.has(key)) {
    queuedTiles.add(key); // オーバーレイのqueued判定用(ジャンプ後にクリアされていても取得済み扱いを維持)
    if (!buildingReadyTiles.has(key) && !buildingQueuedTiles.has(key)) {
      buildingQueuedTiles.add(key);
      osmTileQueue.push({ tx, tz, kind: 'building' });
      osmTileQueuedAt.set(tileStateKey(tx, tz, 'building'), Date.now());
    }
    return;
  }
  if (isNearSplit) { /* 既存のroadジョブ投入 */ return; }
  /* 既存のgeneric(複合)投入 */
};
```

副次効果: ジャンプ後、roadReady+buildingReady両方揃った既訪問タイルは早期returnで再取得されなくなる(現状はgeneric分岐が複合クエリを重複再取得しており無駄)。

## 修正2【症状Aの大量発生因】ジャンプリセットの非対称クリア

**場所**: part8.js `resetOSMTileQueueForJump`(L111付近)

**問題**: `buildingReadyTiles.clear()` する一方 `roadReadyTiles` は保持。近距離ジャンプのたびに取得済み全タイルが「道路あり・建物なし」に化け、大量の緑緑赤+建物の無駄な再取得(リクエスト増→429→全体凍結)を生む。

**修正**: `buildingReadyTiles.clear()` の行を削除する。roadReadyTilesと同じく「取得済みの記録」なので消さない。`buildingQueuedTiles.clear()`(キュー状態)は残す。

## 修正4【症状B悪化因】分離ジョブのIndexedDBキャッシュフォールバック

**場所**: part8.js `fetchOSMTileBatch` のキャッシュ照会(L892付近)

**問題**: 既訪問エリアのキャッシュは複合キー(bbox)で保存されているが、分離ジョブは `bbox|road` / `bbox|building` で照会するためヒットせず、全部ネットワーク再取得になる。リクエスト倍増→429→`osmGlobalCooldownUntil`(最大120秒)で全タイル凍結の一因。

**修正**: kindキーがミスの場合、複合キー(bbox素のまま)でも照会。ヒットしたら複合扱い(kind=undefined)で処理し、markTileSuccessで**両方**readyにする:

```js
let cached = await osmCacheGet(cacheKeyFor(bboxes[0]));
let effKind = batchKind;
if (!cached && (batchKind === 'road' || batchKind === 'building')) {
  cached = await osmCacheGet(bboxes[0]); // 複合クエリ時代のキャッシュを流用
  if (cached) effKind = undefined; // 複合データなので道路・建物とも確定させる
}
if (cached) { ... processTileData(cached, 1); markTileSuccess(keys[0], stateKeys[0], effKind); ... }
```

processTileDataはseenOSMWaysで重複排除されるため、建物ジョブに複合データを渡しても道路等の二重登録は起きない(安全)。

## 修正5【症状Aの補助因】建物後追いジョブの飢餓

**場所**: part8.js `_tileScore`(L680付近)

**問題**: 建物後追いジョブは、タイルが3x3を出ると外周tier(オフセット0)に落ち、移動中は近傍tierとの階層ギャップ10000で恒久的に後回しになる(agingTiebreak上限100では絶対に逆転できない)。

**修正**: `kind === 'building'` のジョブは現在の距離に関係なく常に近傍tierオフセット(-10000、既存のbuildingFollowupBonus -50も付与)で扱う。対象は「かつて近傍だったタイル」の有限集合なので暴走しない。blocking(-100000)より上には行かないため現在地優先は維持される。

## 修正3【Step B・症状Bの有力因】サーバーのレーン選択がビジーレーンに積み増す

**場所**: server.js `scheduleUpstream`(L336〜)

**問題**: レーン選択が「最終**開始**時刻が最古」基準。45秒級のfarクエリを実行中のレーンは開始時刻が最古のままなので、その実行中に来るblocking/nearが**全部そのビジーレーンの後ろにチェーン**される。予約レーン0が暇でも使われず、Phase 3の意図が実質無効化されている。

**修正**: レーンごとの「未完了件数」(depth: 割り当て時+1、settle時-1)を `ensureLanes` の配列と並行して持ち、候補範囲(blocking/near=0〜n-1、far=1〜n-1)の中で **depth最小**のレーンを選ぶ(同数なら開始時刻最古)。これで空きレーンが必ず先に使われる。

---

## 実装上の注意

- 実装前に各該当箇所の現状コードを読み、行番号・変数名が本書とずれていたら実態を優先して差分を報告。
- `roadReadyTiles`/`buildingReadyTiles`/`buildingQueuedTiles`/`queuedTiles` の意味(前2つ=取得済み記録・消さない、後2つ=キュー状態)を崩さない。
- `osmTilesReadyAround` の両方待ち(procedural race対策)、buildingGridのqueue時登録、現在地70秒timeoutは触らない。

## 実機確認観点

**Step A後**: (1)密集地を移動し続けても「緑緑赤」が恒久滞留せず、いずれ緑緑緑になる。(2)近距離ジャンプ直後に既訪問側のタイルが緑緑赤の海にならない。(3)既訪問エリア再訪時、コンソールでネットワーク再取得がほぼ発生しない。(4)429/グローバルクールダウンの頻度が下がる。

**Step B後**: (5)外周のまとめクエリ実行中にタイル境界をまたいでも、現在地タイルの取得が数秒で開始される(server.jsログでレーン0の割り当てを確認できるログを一時追加してよい)。(6)「緑赤灰」で道路が数分止まる事象が消える。

## 各Step完了時の報告フォーマット

1. 変更点の要約(ファイル・関数レベル)/ 2. 本書との差分 / 3. pushコマンド(`;`区切り)/ 4. 実機確認観点(上記のうち該当分)
