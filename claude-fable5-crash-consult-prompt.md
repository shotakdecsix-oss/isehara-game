# 相談プロンプト: iPhone(Chrome)でのタブクラッシュが直らない

以下をそのままFable 5に貼ってください。

---

three.js製のブラウザゲーム「ChronoDrift」(実世界の地図データをOSM/Overpass APIから取得し、リアルタイムに街を生成して歩き回れるゲーム)で、iPhoneのChrome(中身はSafariと同じWebKit)で頻繁にタブがクラッシュする(画面が真っ白になって落ちる)問題が直りません。何段階か対策を打ちましたが、直近の対策後にNYで数十秒という今までで最短の時間で落ちました。新しい目で見てほしいです。

## 環境・症状の推移

- 端末: iPhone、ブラウザ: Chrome(WebKitベース)
- 開発機はWindows。Macを持っていないため、Safariのリモートデバッグ(Web Inspector)が使えず、実機のメモリ推移を直接観測できない(iOSは`performance.memory`のようなJSからメモリを読むAPIも無い)。ライブ診断が一切できない状態でコードだけを頼りに対策している。
- 症状の推移(この順で対策→再現テストを繰り返した):
  1. ⚙設定「標準」で数分程度でクラッシュ
  2. 初回起動時、スマホと判定した端末は「軽量」プリセットを既定にするよう変更 → まだ改善不明
  3. 「軽量」でも改善しないと報告があり、facadeCache(後述)の量子化・テクスチャ解像度を軽量時のみ縮小 → 生存時間が数分→約10分に伸びた
  4. それでも最終的には落ちるとの報告 → facadeCacheに総件数のハード上限(220件、軽量時のみ)を追加
  5. 「バックグラウンドで解放してユーザー体験に影響しないようにできないか」と言われ、facadeCacheに参照カウント方式の解放処理を実装(下記コード参照)。プリセット問わず有効。
  6. **直後の再テストでNY(マンハッタン相当の高密度エリア)で数十秒でクラッシュ**。これまでで最短。この最新の変更が退行(regression)を生んだ可能性と、単に「NYは初期ロードだけで即座にメモリ上限に達する(参照カウントの解放が効く前に落ちる)」可能性の両方が考えられ、切り分けできていない。

## アプリの構成

- `index.html` + `js/legacy/part1.js`〜`part9.js`(元は1つの巨大なインラインスクリプトを機械的に9分割したもの。グローバルスコープを共有する昔ながらの`<script>`タグの並び読み込みで、ES Modulesではない)
- `js/lib/pure.js`: 純粋関数のみ(distSqPointToSeg等)
- サーバーは`server/server.js`(Node)、Renderにデプロイ(pushで自動デプロイ)
- OSM Overpass APIからタイル単位で道路・建物・鉄道・landuse等を取得し、three.jsのメッシュを動的生成。IndexedDBにタイルをキャッシュ済み。
- ⚙設定(`PERF_PRESET`: lite/std/high)で生成距離・保持件数の上限が変わる(`js/legacy/part1.js`の`PERF`オブジェクト参照)。

## 疑わしい箇所: facadeCache(建物ファサードのテクスチャキャッシュ)

`js/legacy/part2.js`の`facadeMat(kind, color, variant)`が、建物の壁面テクスチャ(128x128の壁面Canvas + 64x64の発光マップCanvas、`THREE.MeshLambertMaterial`)を`kind_color_variant`をキーにMapでキャッシュしている。**このキャッシュは今回の一連の変更まで一度も解放されたことがなく**、「一度作った組み合わせのGPUテクスチャメモリ(1件あたり約100〜130KB)が二度と解放されない」設計だった。呼び出し元は`js/legacy/part3.js`の`addBuilding()`内、壁メッシュ1箇所のみ(1回の呼び出し=必ず1つのmeshにしか使われない、という前提で今回の参照カウント実装をしている)。

今日入れた変更(直近→古い順):

### 1. 参照カウント方式の解放(最新の変更。これが退行の疑いあり)

`js/legacy/part2.js`:
```js
const facadeCache = new Map();
const FACADE_CACHE_MAX = PERF_PRESET === 'lite' ? 220 : Infinity;
function facadeMat(kind, color, variant) {
  const key = kind + '_' + color + '_' + variant;
  const hit = facadeCache.get(key);
  if (hit) { hit.userData.refCount = (hit.userData.refCount || 0) + 1; return hit; }
  if (facadeCache.size >= FACADE_CACHE_MAX) {
    for (const [k, m] of facadeCache) {
      if (k.startsWith(kind + '_')) { m.userData.refCount = (m.userData.refCount || 0) + 1; return m; }
    }
  }
  // ...(128x128 Canvas描画。省略。TEX_SCALE=PERF_PRESET==='lite'?0.75:1 で物理解像度のみ縮小)
  const m = new THREE.MeshLambertMaterial({ map: tex, emissive: 0xffffff, emissiveMap: etex, emissiveIntensity: emi });
  m.userData.cacheKey = key; m.userData.refCount = 1;
  facadeCache.set(key, m);
  return m;
}
function releaseFacadeMat(mat) {
  if (!mat || !mat.userData || mat.userData.cacheKey == null) return;
  mat.userData.refCount--;
  if (mat.userData.refCount > 0) return;
  facadeCache.delete(mat.userData.cacheKey);
  if (mat.map) mat.map.dispose();
  if (mat.emissiveMap) mat.emissiveMap.dispose();
  mat.dispose();
}
```

`releaseFacadeMat(p.material)`を、建物パーツが`scene.remove()`される既存の3箇所(`js/legacy/part1.js`の`removeBuildingsOverlappingRoad`内と`unloadFarBuildings`内、`js/legacy/part8.js`のチャンクアンロード内)に、既存の`p.geometry.dispose()`の直後に追加した。これらは既存の「90フレーム(約1.5秒)ごとに遠方の建物を自動アンロードする」処理に相乗りしており、新規のsetIntervalやリロードは一切追加していない。

**ここに見落としているバグが無いか見てほしい。** 具体的に心配している点:
- 本当に1つの`facadeMat()`呼び出し=1つのmesh、という前提が正しいか(part3.jsのaddBuilding全体をもう少し広く見て、`mat`変数が複数meshに再利用されていないか)
- `dormantBuildings`への退避(遠方で解放されたが記録は残す仕組み)と参照カウントの整合性(退避時にreleaseFacadeMatを呼んでいるのに、実は同じ建物が別経路でまだ生きたままシーンに残っている、といった二重管理が無いか)
- 何らかの理由でreleaseFacadeMatが例外を投げ、それが原因でその後の描画ループが壊れている可能性(念のためtry/catch等での防御も検討要)

### 2. テクスチャ解像度・色の量子化縮小(軽量時のみ)

同じくpart2.js。`quantizeColor(c, steps)`のデフォルトstepsを`PERF_PRESET==='lite'`なら5(通常8)に、facadeMatのcanvas物理解像度を`TEX_SCALE=0.75`(通常1)に縮小。描画コード自体は128基準の座標のままで、`ctx.scale()`で物理サイズだけ縮めている。

### 3. 軽量プリセットの自動既定化

`js/legacy/part1.js`の`PERF_PRESET`初期化。ユーザーが⚙で明示的に選んだ設定があれば最優先、無ければ`navigator.userAgent`等でモバイル判定し、初回のみ`lite`を既定にする。

## この前の対策で分かっていること

- pendingBuildingsという別の配列(建物生成のフレーム分割キュー)で、以前PC版のクラッシュ調査中に「処理済み要素をカーソルでスキップするだけでsplice()していなかった」という本物のメモリリークを見つけて修正済み(これはこの会話より前のセッションで、PCでは確認・修正済み)。
- 道路メッシュ(`roadRecords`)・区画ポリゴン(`areaPolyMeshes`)は、それぞれ独自の共有マテリアル(`ROAD_MAT`、`lawnMat`等)を使っており、色数が少なく固定なのでキャッシュ増殖の懸念は薄いと判断し、今回は手を付けていない(未検証の前提ではある)。
- `matCache`(`lambertMat`、屋根色やprop類で広く使われる共有マテリアルキャッシュ)は、1棟の建物内で同じ屋根材質オブジェクトが複数パーツ(例: 切妻屋根の2つのコーン)に再利用されるケースがあることを確認しており、facadeCacheと同じ単純な参照カウント(1呼び出し=1使用)は安全に適用できないと判断して見送った。

## 知りたいこと

1. 今日入れた参照カウント方式の解放処理(上記コード)に、見落としているバグ・データ不整合は無いか。「NYで数十秒」という今までで最悪の結果になった原因が、この変更自体のバグである可能性はどれくらいありそうか。
2. そうでない場合、NYのような高密度エリアは「初期ロードの時点」で(遠方アンロードが1回も走る前に)メモリ上限に達している可能性が高いと思うか。その場合、生成のペース自体を制限する(例: 初期ロード時のバッチサイズ・同時生成数に上限を設ける)方向の対策が要ると思うか。
3. iOS(WebKit)でJSからメモリ使用量を推定する現実的な方法はあるか(`performance.memory`が無い前提で)。例えば「テクスチャ生成に一定数失敗し始めたら危険域」といった間接的なシグナルは使えるか。
4. `matCache`(屋根色等)についても、複数パーツでの再利用を考慮した安全な解放方法(建物単位でのユニーク集合に対して参照カウントする等)は現実的か、それとも別のアプローチ(例えば屋根色もbuilding単位で1マテリアルに統一して重複利用自体を無くす)の方が安全か。

改めて、Macが無くiOS実機のライブデバッグができないため、コードレビューベースでの助言が中心になります。よろしくお願いします。
