# 相談プロンプト: bMax近傍が「常態」の密集地で、dormant復帰上限そのものが支配的ボトルネックになっている

以下をそのままFable 5に貼ってください。文脈: あなたが以前診断してくれた「bMax飽和時に
dormantBuildingsが無限に増え続ける片道弁」問題(修正6: ヒストグラムtarget修正、
reactivateNearbyDormantBuildingsへのヒステリシスマージン+高層距離換算統一+復帰件数上限
REVIVE_BUDGET=200を実装済み)と、その後の「建物生成が取得後の段階で詰まる」問題
(生成予算の大半がchunkNearTerrainReady/osmTilesReadyAround待ちの空回りで消費されていた件、
対策(c)GSIタイル部分リトライ+道路ゲート近傍限定は実装・実機確認済み)の両方の続き。
今回、対策(c)デプロイ後の実機ログを見たところ、REVIVE_BUDGET=200自体が新たな支配的
ボトルネックになっていることを示すデータが取れた。この解釈と対策を検証してほしい。

## 実装済みの現状(part1.js)

```js
function reactivateNearbyDormantBuildings() {
  ...
  if (buildingRecords.length >= PERF.bMax) return; // 上限到達中は完全停止
  ...
  const _nearCapNow = buildingRecords.length >= PERF.bMax * 0.95;
  const _realRevLim = _nearCapNow ? Math.min(BUILDING_GEN_DIST_REAL, _lastRealKeepDist * 0.8) : BUILDING_GEN_DIST_REAL;
  ...
  // 上限から遠い(80%未満)間は無制限、80%以上だけ200件/サイクル(~1.5秒毎)に絞る
  const _recoveringNearCap = buildingRecords.length >= PERF.bMax * 0.8;
  const REVIVE_BUDGET = _recoveringNearCap ? 200 : Infinity;
  ...
}
```

この200/サイクル(≈133件/秒)という値は、「上限から抜けた直後、生成距離内のdormant数万件が
1パスで雪崩れ込むスパイクを防ぐ」という**過渡的な**シナリオを想定して入れた(あなたの前回の
助言通り)。80%未満では無制限に戻すことで、通常時の過剰スロットルは解消済み(実機確認済み)。

## 新たに判明した問題: 密集地では「80%以上」が過渡的ではなく常態

東京駅クラスの密集地では、`records`(bMax=12000のstd設定)が9600(80%)〜12000の間で
ずっと張り付いたまま推移し続ける。実機ログ(約10〜15秒間隔で6回連続採取、[buildgen]は
generated/requeued/toDormantを直近2秒の累計、tableのbuildPendingは
pendingBuildings+dormantBuildingsの合算値):

```
records 11150/12000  dormant 92498  [buildgen] budget20 gate0 generated200 requeued0    toDormant0   pendingTotal0
records 11465/12000  dormant 92387  [buildgen] budget20 gate0 generated111 requeued0    toDormant89  pendingTotal0
records 10138/12000  dormant 93747  [buildgen] budget21 gate0 generated228 requeued274  toDormant150 pendingTotal22
records 10241/12000  dormant 93611  [buildgen] budget22 gate0 generated100 requeued1574 toDormant64  pendingTotal58
records 10477/12000  dormant 93469  [buildgen] budget20 gate0 generated200 requeued1662 toDormant58  pendingTotal0
records 10776/12000  dormant 86625  [buildgen] budget160 gate0 generated2007 requeued2057 toDormant102 pendingTotal6545 (直後に504でOverpassクールダウン中)
```

この間、テーブル上で特定タイル(例: 22,-21)の`buildPending`は**7356のまま6回連続で
一切変化しなかった**。records(=80%閾値9600)を常時上回っているため`_recoveringNearCap`が
ずっとtrueになり、REVIVE_BUDGET=200が実質「常時適用のレート上限」として機能している。
dormant(86000〜93000件)に対し133件/秒の復帰速度では、数分単位で待たないと特定エリアの
建物が復帰しない計算になる。requeued(空回り。あなたの指摘通りpendingBuildings本流の
churnで、対策(b)未実装のため依然発生している)とは別に、**dormant側の復帰速度そのものが
もう一段のボトルネック**になっていることが今回のログで裏付けられた。

## 見立てている因果(検証してほしい)

1. REVIVE_BUDGET=200は「上限からの一時的な回復」を想定した値で、「bMax近傍に恒常的に
   留まり続ける密集地」という定常状態は想定していなかった。std設定のbMax=12000自体が、
   東京駅のような実在建物密度に対して足りておらず、プレイヤーがそこに留まる限り
   records は常に80%超のまま動かない。
2. この定常状態では、REVIVE_BUDGET=200が「スパイク防止」ではなく「dormantの実効的な
   排出速度の上限」として働き続け、133件/秒という値は数万件規模のdormant backlogに対して
   明らかに小さすぎる。
3. 対策(b)(chunkWaitBuildings/tileWaitBuildingsによる隔離キュー、未実装)はpendingBuildings
   本流の空回り(requeued)を解消するが、dormantBuildings→pendingBuildingsの復帰速度
   (REVIVE_BUDGET)自体は別物なので、(b)だけでは今回の「buildPendingが数字ごと動かない」
   症状は解消しない可能性が高い。

## 相談したいこと

1. 上記の見立ては妥当か。REVIVE_BUDGETを「bMaxに対する割合」ではなく「定常状態か過渡
   状態か」で切り替える設計に無理があったか(そもそも密集地では常に定常的に上限付近に
   留まるので、この二分法自体が成立しない場所がある、という理解で合っているか)。
2. 対策の方向性としてどれが妥当か。候補: (a) REVIVE_BUDGETをdormantの規模や滞留時間に
   応じて動的に増やす(例: dormant件数が多いほど、あるいは同じ建物が長時間dormantに
   留まっているほど優先度を上げる)、(b) 復帰と退避(unloadFarBuildings)を「進行方向優先」で
   組にし、プレイヤーの前方だけは無制限復帰を許す、(c) この規模の密集地ではbMax自体を
   動的に(その場のプレイヤー近傍実建物密度を見て)引き上げる、(d) 「表示できる上限に
   構造的に達しているので、これ以上は復帰速度を上げても焼け石に水」と判断し、
   代わりにデバッグオーバーレイのbuildPending表示自体を「pendingのみ」と「dormant込み」に
   分けて、ユーザーに誤解を与えない表示に直す、(e) その他。
3. GPUクラッシュ対策の経緯(bMaxキャップ自体は死守したい)を踏まえると、(c)のような
   bMax動的引き上げは危険か、それとも「プレイヤー近傍だけ一時的に緩め、離れたら通常の
   キャップ+ヒステリシス縮小(修正6)で回収する」ような設計であれば許容できるか。
4. 実装順として、対策(b)(隔離キュー)と今回の件はどちらを先に着手すべきか、それとも
   同じデプロイでまとめるべきか。

コードの実装自体は別チャットで行う前提。まずは原因の妥当性と対策の方針だけ検証してほしい。
