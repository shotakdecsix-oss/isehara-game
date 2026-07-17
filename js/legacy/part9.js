/**
 * legacy/part9.js — index.html の巨大インラインスクリプトを行範囲のまま機械的に切り出した
 * ファイル(9/9・最終)。part8.js の続き。詳細は part1.js 冒頭のコメント参照。
 */
// ======= 山の森(プレイヤー周囲の一定範囲だけを描く=軽量) =======
// 木は建物・道路と同じく「近くだけ」描く。プレイヤーが一定距離動いたら森を作り直す。
// 木の位置・見た目は座標から決まる(plantTree)ので、作り直しても同じ木が並び、ちらつかない。
// 建物・道路のチャンクは半径 CHUNK_RADIUS で生成され CHUNK_RADIUS+2 で消える。
// 森はその中間(+1)に合わせ、建物と木が同じくらいの距離で現れ・消えるようにする。
// 【2026-07-16】CHUNK_RADIUSを8(960m)へ拡大した際、森が連動して1080mまで広がると
// 樹木の生成負荷が跳ね上がるため、森は従来の480m固定に切り離す(木は遠景での存在感が
// 建物より小さく、フォグ距離的にも480mで十分)。
const FOREST_R = PERF.forestR; // パフォーマンス設定に連動(標準480m)
const FOREST_REBUILD_STEP = CHUNK_SIZE / 2;        // 60mごとに再構築(建物の出現範囲に追従)
const FOREST_MIN_H = 30;          // 局所比高がこの高さ(≈15m)以上を「山」とみなす(平地の街には生えない)
const FOREST_SCATTER = 36;        // 散布グリッド間隔(m)。粗くして候補数=負荷を抑える
let _forestBX = Infinity, _forestBZ = Infinity;
// キュー投入時(タイル到着時)には近い順に並べていたが、その後プレイヤーが動くと
// 「近い順」が古くなる(投入時は遠かった建物が、移動後には最優先になっているのに
// キューの奥に埋もれたまま)。低頻度(~0.5秒ごと)で未処理分だけ距離順に並べ直し、
// 常にプレイヤーの現在地に近い建物・道路から生成されるようにする。
let _buildingSortFrame = 0;
let _roadSortFrame = 0;
// 毎フレームnewしない方針(_instMat等と同じパターン)。exploreOnUpdate/updateCameraで使い回す
// 短命Vector3をモジュールスコープに退避(CODE_REVIEW_20260717 P11)。
const _moveForward = new THREE.Vector3(), _moveRight = new THREE.Vector3();
const _idealCam = new THREE.Vector3(), _occTargetPos = new THREE.Vector3();

function resetPool(p) { p.n = 0; p.mesh.count = 0; p.mesh.instanceMatrix.needsUpdate = true; }

// 建物などの当たり判定ボックスが近くにあるか。空間ハッシュ(collGrid)で近傍セルだけ調べる。
// (以前の hasBuildingNearby は全建物を線形走査していたため、森の再構築が非常に重かった)
function boxNear(x, z, r) {
  const c = COLL_CELL;
  const gx0 = Math.floor((x - r) / c), gx1 = Math.floor((x + r) / c);
  const gz0 = Math.floor((z - r) / c), gz1 = Math.floor((z + r) / c);
  for (let gx = gx0; gx <= gx1; gx++)
    for (let gz = gz0; gz <= gz1; gz++) {
      const arr = collGrid.get(gx + ',' + gz);
      if (!arr) continue;
      for (const b of arr)
        if (x > b.min.x - r && x < b.max.x + r && z > b.min.z - r && z < b.max.z + r) return true;
    }
  return false;
}

// プレイヤー周囲 FOREST_R 内の山(FOREST_MIN_H〜TREELINE)へ木を敷き直す(近傍判定はO(1)相当で軽量)
function rebuildForest() {
  if (!regionBaseReady) return; // このリージョンの高度基準(TREELINE等)がまだ確定していない
  resetPool(forestTrunkP);
  forestLeafPools.forEach(resetPool);
  const px = player.position.x, pz = player.position.z;
  const R = FOREST_R, R2 = R * R, cell = FOREST_SCATTER;
  const gx0 = Math.floor((px - R) / cell), gx1 = Math.floor((px + R) / cell);
  const gz0 = Math.floor((pz - R) / cell), gz1 = Math.floor((pz + R) / cell);
  for (let gx = gx0; gx <= gx1; gx++)
    for (let gz = gz0; gz <= gz1; gz++) {
      const cx = gx * cell, cz = gz * cell;
      const h = getGroundY(cx + cell / 2, cz + cell / 2);
      if (h < FOREST_MIN_H || h > TREELINE) continue; // 平地・森林限界より上は除外
      const dens = Math.min(6, 2 + ((h - FOREST_MIN_H) / 60 | 0)); // 高いほど密(控えめ=軽量)
      for (let i = 0; i < dens; i++) {
        const x = cx + _fhash(gx * 92821 + i, gz * 68917) * cell;
        const z = cz + _fhash(gx * 40503, gz * 51787 + i * 131) * cell;
        const dx = x - px, dz = z - pz;
        if (dx * dx + dz * dz > R2) continue;   // 円形範囲に収める
        if (roadNear(x, z, 2)) continue;        // 道路の上には生やさない(空間グリッドで高速判定)
        if (boxNear(x, z, 5)) continue;         // 建物の上には生やさない(空間グリッドで高速判定)
        plantTree(x, z);
      }
    }
}

// プレイヤーが FOREST_REBUILD_STEP 以上動いたら森を作り直す
function updateForest() {
  if (USES_MEIJI_LANDUSE ? !meijiReady : !initialWorldLoaded) return;
  const bx = Math.round(player.position.x / FOREST_REBUILD_STEP);
  const bz = Math.round(player.position.z / FOREST_REBUILD_STEP);
  if (bx === _forestBX && bz === _forestBZ) return;
  _forestBX = bx; _forestBZ = bz;
  rebuildForest();
}

// ======= ANIMATION LOOP =======
const clock = new THREE.Clock();
let walkCycle = 0;

// ======= EXPLORE MODE: 自由移動・ジャンプ・歩行アニメーション・追従カメラ =======
// 「3D探索」というゲームプレイそのものに属するロジックをここにまとめ、ModeRegistryの
// explore モードの onUpdate として登録する(下の registerMode 呼び出し参照)。
// 挙動・呼び出しタイミングは分割前と完全に同一(animate()の同じ位置から毎フレーム
// 呼ばれるだけで、処理の中身・順序は一切変えていない)。将来のRPG/アクション等の
// モードは、この関数を丸ごと差し替えることで全く異なる移動方式・カメラを実装できる。
// ワールドのストリーミング・描画(チャンク生成・地形・ミニマップ等)はモードに依らない
// 共通処理として animate() 側に残す。
function exploreOnUpdate(dt) {
  // 速度: 通常5m/s、最大3倍(15m/s)。スマホ=スティックの倒し量で連続加速、PC=Shiftダッシュ
  // 加速カーブを立たせ(pow0.7×1.15)、6割程度の倒しでも3倍近く出るように
  const joyMag = joyActive ? Math.min(1, Math.sqrt(joyOx*joyOx + joyOz*joyOz)) : 0;
  let speed = 5 + 40 * Math.min(1, Math.pow(joyMag, 0.7) * 1.15); // 最大45m/s
  if (keys['shift']) speed = 45;
  const forward = _moveForward.set(-Math.sin(camYaw), 0, -Math.cos(camYaw));
  const right   = _moveRight.set( Math.cos(camYaw), 0, -Math.sin(camYaw));

  let moveX = 0, moveZ = 0;
  let isMoving = false;

  // Keyboard
  if (keys['w'] || keys['arrowup'])    { moveX += forward.x; moveZ += forward.z; isMoving = true; }
  if (keys['s'] || keys['arrowdown'])  { moveX -= forward.x; moveZ -= forward.z; isMoving = true; }
  if (keys['a'] || keys['arrowleft'])  { moveX -= right.x;   moveZ -= right.z;   isMoving = true; }
  if (keys['d'] || keys['arrowright']) { moveX += right.x;   moveZ += right.z;   isMoving = true; }
  // Mouse keys for camera
  if (keys['q']) { camYaw += dt; }
  if (keys['e']) { camYaw -= dt; }

  // Joystick
  if (joyActive && (Math.abs(joyOx) > 0.1 || Math.abs(joyOz) > 0.1)) {
    moveX += forward.x * (-joyOz) + right.x * joyOx;
    moveZ += forward.z * (-joyOz) + right.z * joyOx;
    isMoving = true;
  }

  // Normalize
  const mLen = Math.sqrt(moveX*moveX + moveZ*moveZ);
  if (mLen > 0) { moveX /= mLen; moveZ /= mLen; }

  // Apply movement with collision
  const nx = player.position.x + moveX * speed * dt;
  const nz = player.position.z + moveZ * speed * dt;
  if (!wouldCollide(nx, player.position.z)) player.position.x = nx;
  if (!wouldCollide(player.position.x, nz)) player.position.z = nz;

  // ======= ジャンプ・重力・着地(地形と建物屋根の両方に整合) =======
  const floorY = floorHeightAt(player.position.x, player.position.z, player.position.y);
  // ボタン/Spaceを押している間は高度の上限なく一定速度で上昇し続け、
  // 離すとその場の上向き速度から自然に重力で落下へ移行する。
  if (hopHeld) {
    velY = RISE_SPEED;
    airborne = true;
    player.position.y += velY * dt;
  } else if (airborne) {
    velY += GRAVITY * dt;
    player.position.y += velY * dt;
    if (velY <= 0 && player.position.y <= floorY) {
      player.position.y = floorY; velY = 0; airborne = false;
    }
  } else {
    if (player.position.y - floorY > 1.5) {
      airborne = true; velY = 0; // 屋根や崖から歩き出た → 落下開始
    } else {
      player.position.y = floorY; // 接地中は床に追従
    }
  }

  // Face movement direction
  if (isMoving) {
    const targetAngle = Math.atan2(moveX, moveZ);
    let diff = targetAngle - player.rotation.y;
    while (diff >  Math.PI) diff -= Math.PI*2;
    while (diff < -Math.PI) diff += Math.PI*2;
    player.rotation.y += diff * 8 * dt;
  }

  // Walk / Run animation — 速度(5=歩き 〜 45=全力疾走)に応じて歩幅の速さ・振幅・前傾を変える
  const runT = Math.max(0, Math.min(1, (speed - 5) / 40)); // 0=歩き, 1=全力疾走
  if (isMoving && !airborne) {
    const cadence  = 6 + runT * 8;    // 歩き:6 → 全力疾走:14(1秒あたりの振り速さ)
    const swingAmp = 0.5 + runT * 0.45; // 歩き:0.5 → 全力疾走:0.95(振り幅)
    walkCycle += dt * cadence;
    const swing = Math.sin(walkCycle) * swingAmp;
    leftArm.rotation.x  =  swing;
    rightArm.rotation.x = -swing;
    leftLeg.rotation.x  = -swing; // 腕と脚は逆位相(右腕+左脚が同時に前へ)
    rightLeg.rotation.x =  swing;
    player.rotation.x = runT * 0.22; // 走るほど前のめりに(yaw=facingは別軸なので向きには影響しない)
  } else if (!airborne) {
    leftArm.rotation.x  = 0;
    rightArm.rotation.x = 0;
    leftLeg.rotation.x  = 0;
    rightLeg.rotation.x = 0;
    player.rotation.x += (0 - player.rotation.x) * Math.min(1, dt * 10); // ゆっくり直立姿勢に戻す
  }

  // Jump pose — 空中では歩行アニメーションの代わりに脚を畳み、上昇/落下で仰け反り/前のめりを付ける
  if (airborne) {
    const jumpT = Math.min(1, Math.abs(velY) / 15.6);
    leftArm.rotation.x  = -0.9 * jumpT;
    rightArm.rotation.x = -0.9 * jumpT;
    leftLeg.rotation.x  =  0.7 * jumpT;
    rightLeg.rotation.x =  0.7 * jumpT;
    player.rotation.x = velY > 0 ? -0.15 * jumpT : 0.1 * jumpT;
  }

  // Camera
  if (viewMode === 1) {
    // First person
    scene.fog = WORLD_FOG;
    camera.position.set(
      player.position.x + Math.sin(player.rotation.y + Math.PI) * 0.1,
      player.position.y + 1.65,
      player.position.z + Math.cos(player.rotation.y + Math.PI) * 0.1
    );
    camera.rotation.order = 'YXZ';
    camera.rotation.y = camYaw + Math.PI;
    camera.rotation.x = -camPitch + 0.3;
  } else if (viewMode === 2) {
    // Overhead / top-down — disable fog so buildings are visible
    scene.fog = null;
    // プレイヤーの標高基準にしないと山岳部で地形がカメラより高くなる
    camera.position.set(player.position.x, player.position.y + 800, player.position.z + 0.001);
    camera.up.set(0, 0, -1);
    camera.lookAt(player.position.x, player.position.y, player.position.z);
    camera.up.set(0, 1, 0); // restore after lookAt
  } else {
    // Third person
    scene.fog = WORLD_FOG;
    const camX = player.position.x + Math.sin(camYaw) * camDist * Math.cos(camPitch);
    const camY = player.position.y + camHeight + camDist * Math.sin(camPitch);
    const camZ = player.position.z + Math.cos(camYaw) * camDist * Math.cos(camPitch);
    const idealCam = _idealCam.set(camX, camY, camZ);
    const safeCam = occlusionCamPos(idealCam, _occTargetPos.set(player.position.x, player.position.y + 1.5, player.position.z));
    camera.position.lerp(safeCam, 0.2);
    camera.lookAt(player.position.x, player.position.y + 1.5, player.position.z);
  }
}

function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.05);
  const t  = clock.getElapsedTime();

  // ゲームプレイモード固有の処理(現状はexplore=3D探索の移動・ジャンプ・カメラ)。
  // 元は同じ内容がここに直接書かれていたのと完全に同じ順序・タイミングで呼ばれる。
  // 以降のstation labels・カメラ追従処理はカメラが確定済みであることに依存するため、
  // この呼び出しは他の処理より先に行う必要がある。
  if (window.ModeRegistry) ModeRegistry.update(dt);

  // Station labels: billboard + ring spin
  for (const sl of stationLabels) {
    if (sl.type === 'label') {
      sl.mesh.quaternion.copy(camera.quaternion);
    } else if (sl.type === 'ring') {
      sl.mesh.rotation.y = t * 0.8;
      sl.mesh.rotation.x = Math.sin(t * 0.5) * 0.3;
    }
  }

  // Dynamic chunk streaming — generates buildings around player as they explore
  updateChunks();
  processChunkQueue(); // フレーム分割: 1チャンク/フレーム
  // 道路も建物と同じく、タイル到着時に一度並べた「近い順」がプレイヤーの移動で古くなる。
  // pendingRoadMeshesは処理済み分をprocessRoadMeshQueue側でsplice(0,i)して毎回0番始まりに
  // 保っているので、fromIdx=0でまるごと並べ直せばよい(pendingBuildingsのような
  // インデックスカーソル管理が不要な分、建物より単純)。
  _roadSortFrame++;
  if (_roadSortFrame % 30 === 0) {
    sortNewEntriesByDistanceToPlayer(pendingRoadMeshes, 0, r => ({ x: (r.x1 + r.x2) / 2, z: (r.z1 + r.z2) / 2 }));
  }
  processRoadMeshQueue(); // 道路メッシュもフレーム分割(密集タイル到着時のフリーズ防止)
  // タイル取得分の建物もフレーム分割(20棟/フレーム)で生成。
  // 【重要】以前はここでNEAR地形の準備状況を一切見ていなかった。チャンク生成側
  // (processChunkQueue/chunkNearTerrainReady)だけをゲートしても、実際の建物の大半は
  // OSMタイルのポリゴンから来るこちらの経路で生成されるため、浮き/埋まりが直りきって
  // いなかった。同じ判定をここにも入れ、NEARがまだその位置を覆っていなければこのフレームは
  // ここで足踏みする(同じ建物から次フレームで再判定。手前で止めるだけなのでコストは低い)。
  // 【重要】以前はここでNEAR未準備の建物に当たった時点でbreakしており、キューが
  // OSM出現順(=場所とは無関係)のFIFOだったため、たまたま先頭付近にNEAR未到達の
  // 建物が1つあるだけで、後続の「もう準備が整っている」他エリアの建物まで全部
  // 足止めされていた。これが移動速度に読み込みが追いつかない主因の一つ。
  // → 未準備の建物は諦めずキュー末尾へ回して次を試す(他が足止めされないように)。
  // 固定20棟/フレームだと、密集タイルが届いた直後にバックログが溜まりやすい。
  // 未処理分(バックログ)が多いほど今フレームの処理数を増やす可変バジェットにし、
  // 通常時(バックログ小)はコマ落ちさせない20棟のまま、山になった時だけ追いつく。
  // 未処理分(pendingBuildingIdx以降)だけを対象に、プレイヤー現在地への近い順で並べ直す。
  // 毎フレームやると要素数が多い時にソート自体が重くなるため、~30フレーム(0.5秒)おきに
  // 留める(その程度の遅延なら「常に一番近い建物から出る」体感には十分)。
  _buildingSortFrame++;
  if (_buildingSortFrame % 30 === 0) {
    sortNewEntriesByDistanceToPlayer(pendingBuildings, pendingBuildingIdx, b => ({ x: b.x, z: b.z }));
  }
  const _buildBacklog = pendingBuildings.length - pendingBuildingIdx;
  // 【重要・2026-07-15】東京駅のような超高密度エリアはバックログが数万件に達し、
  // 上限80のままだと1棟あたりが軽い場所でも実測時間(下の8ms)に達する前に件数上限で
  // 頭打ちになり、生成が体感で非常に遅くなっていた。件数上限自体を引き上げても、
  // 8msの実測時間打ち切りが依然として最終的な安全弁(香港・NY等の重いメガシティで
  // 1フレームが暴走するのを防ぐ)として効くため、上限を160に緩めてスループットを上げる。
  // 【2026-07-16】起動・ジャンプ直後(=リロード後)の30秒間は「初期ラッシュ」として
  // 生成予算を大幅に引き上げ、体感の待ち時間を縮める(その間のFPS低下は許容)。
  // 30秒過ぎたら従来予算に戻り、プレイ中のフレームレートは従来どおり守られる。
  // 起動後30秒の初期ラッシュに加え、現在地タイルの描写が未完了の間もラッシュ扱いにして
  // 「立っている場所」を常に最優先で仕上げる(part8.js checkCurrentTileRush参照)
  checkCurrentTileRush();
  const _rush = performance.now() < 30000 || _curTileRush;
  let _buildBudget = Math.min(_rush ? 400 : 160, 20 + Math.floor(_buildBacklog / 20));
  // 【重要・2026-07-15】生成順序は地形→道路→建物のはずなのに、道路(pendingRoadMeshes)が
  // 固定6ms/フレームだった一方こちらはバックログに応じて最大80棟/フレームまで伸びる
  // 可変制だったため、混雑時は建物の方が道路より速く追いつき、道路だけ取り残されて
  // 「道路の拡張だけ止まって見える」逆転が起きていた(道路側は上のprocessRoadMeshQueue
  // で同様にバックログ応じた可変予算にして底上げ済み)。それでも道路が大きく詰まっている
  // 間は、建物側の予算をさらに絞って道路に追いつく時間を確保する(0にはしない — 道路が
  // 疎な田舎道沿いの孤立した建物などが永久に生成されなくなるのを避けるため)。
  const _roadBacklogForGate = pendingRoadMeshes.length;
  // 初期ラッシュ中は道路優先の絞りも緩める(5だと数万件の建物バックログが捌けない)
  if (_roadBacklogForGate > 80) _buildBudget = Math.min(_buildBudget, _rush ? 40 : 5);
  // 【重要】件数ベースの予算だけだと、1棟あたりのコストが場所によって大きく違う場合に
  // 対応できない(香港・ニューヨークのような超高密度メガシティは1棟の生成コスト自体が
  // 伊勢原基準より重く、実機検証で「1フレームが暴走してタブごと固まって見える」不具合が
  // 確認された)。件数の上限に加えて実測時間(8ms)でも早期に打ち切り、残りは次フレームへ
  // 回すことで、どんなに1棟が重くても1フレームの処理時間には必ず天井を設ける。
  const _buildFrameDeadline = performance.now() + (_rush ? 14 : 8); // 初期ラッシュ中は時間予算も拡大
  for (let n = 0; n < _buildBudget && pendingBuildingIdx < pendingBuildings.length; n++) {
    if (n > 0 && performance.now() > _buildFrameDeadline) break; // 時間切れ: 残りは次フレームへ
    const b = pendingBuildings[pendingBuildingIdx++];
    // 遠景最適化: BUILDING_GEN_DIST(part1.js)より遠い実建物はまだ生成しない。
    // 【重要】ここでpendingBuildingsの末尾へ戻すと、遠方の建物が溜まるほど「戻すだけの
    // 空回り」が積み重なる(チャンク未準備の待ちと違い、遠い建物はプレイヤーが
    // 戻らない限り一生近づかない可能性があるため)。dormantBuildingsという別の待機列へ
    // 逃がし、reactivateNearbyDormantBuildingsが低頻度で接近を検知して戻す。
    if (b.real) {
      const bdx = b.x - player.position.x, bdz = b.z - player.position.z;
      if (bdx * bdx + bdz * bdz > BUILDING_GEN_DIST_REAL * BUILDING_GEN_DIST_REAL) {
        dormantBuildings.push(b);
        continue;
      }
      // 【2026-07-16】描画済み建物の総数上限(PERF.bMax)。密集地では距離制限だけだと
      // 数万棟に達しGPUメモリが際限なく積み上がる(浮上クラッシュの真因)。上限到達分は
      // dormantへ退避し、移動でunloadFarBuildingsが枠を空けたら近い順に復帰する。
      if (buildingRecords.length >= PERF.bMax) {
        dormantBuildings.push(b);
        continue;
      }
    }
    const bcx = Math.floor(b.x / CHUNK_SIZE), bcz = Math.floor(b.z / CHUNK_SIZE);
    if (!IS_MEIJI && !chunkNearTerrainReady(bcx, bcz)) {
      b._tries = (b._tries || 0) + 1;
      // 200回(プレイヤーが二度と戻らない遠方チャンク等)試しても揃わなければ、
      // 諦めてFAR基準のまま生成する(無限に足踏みし続けるのを防ぐ)。
      if (b._tries < 200) { pendingBuildings.push(b); continue; }
    }
    // 【重要・2026-07-16】実OSM建物(b.real)はisOnRoadチェックを免除する。isOnRoadは
    // 建物の外接円半径(halfDiag=対角線の半分)で道路中心線との距離を見るため、
    // 60m×40mの商業ビルならhalfDiag≈36m — 中心から36m+道路半幅以内に道路が1本でも
    // あれば「道路上」と判定される。八重洲・京橋のような大型ビルが道路に四方を囲まれた
    // 街区では大きい実建物がほぼ全て黙って破棄され、しかもknownBuildingGridには
    // 「ここに実建物がある」と登録済みのため手続き生成の補完もブロックされ、
    // 「大きいビルだけが消えて空き地になる」「消える場所が毎回同じ(決定論的)」という
    // 症状になっていた(実機診断: タイルはloaded・count検証済みなのに空き地、で確定)。
    // 実建物は測量データ由来で現実に道路上には建っていないので、このチェック自体が不要。
    // (手続き生成の建物・樹木に対するisOnRoadは従来どおり維持)
    // 【2026-07-16】順序担保(実建物版): 周囲64mがかかる全タイルの道路確定を待つ
    // (part8.js osmTilesReadyAround参照。タイル境界付近で隣タイルの道路が後から届き、
    // 建物が道路に被るレースの対策)。地形待ちと同じ_tries機構で、200回試しても
    // 揃わなければ(隣タイルが4回失敗で諦め扱いになった場合など)待たずに生成する。
    if (b.real && !osmTilesReadyAround(b.x, b.z, 64)) {
      b._tries = (b._tries || 0) + 1;
      if (b._tries < 200) { pendingBuildings.push(b); continue; }
    }
    // 実建物はゲーム側の広い道路・線路リボンに食い込む分だけ寸法を縮めてから生成する
    // (part2.js fitRealBuildingToRoads参照。道路レコード登録はデータ到着時に同期で済んで
    // いるので、描画時点では周囲のリボン幅が判明している)。1回だけ計算して結果を保持。
    if (b.real && !b._fit) {
      const _f = fitRealBuildingToRoads(b.x, b.z, b.w, b.d, b.rot);
      if (_f.drop) continue; // 縮小しても線路に被る建物(線路またぎ)は生成しない
      b.w = _f.w; b.d = _f.d; b._fit = 1;
    }
    if (b.real || !isOnRoad(b.x, b.z, b.w, b.d)) addBuilding(b.x, b.z, b.w, b.d, b.h, b.style, b.real, b.rot);
  }
  if (pendingBuildingIdx > 0 && pendingBuildingIdx === pendingBuildings.length) {
    pendingBuildings.length = 0; pendingBuildingIdx = 0;
  }
  // 実OSM建物が距離に関係なく無限に溜まり続けメモリ・描画負荷が際限なく増える
  // (長時間プレイでの重量化→クラッシュ)のを防ぐため、遠方の建物を解放する
  unloadFarBuildings();
  reactivateNearbyDormantBuildings(); // 逆に、近づいた遠景建物は生成キューへ復帰させる
  // (2026-07-16: 高度LOD(updateAltitudeLOD)は撤去 — 40m/300mまで絞ってもクラッシュ防止に
  //  効かないことが実証され、上空の「スカスカ感」の害だけが残ったため。クラッシュの実対策は
  //  建物総数キャップ(PERF.bMax)+細街路メッシュ距離制限で達成済み)
  // 道路・線路も同様に、遠方のものはGPUメッシュだけ解放する(記録データは残す)
  unloadFarRoads();
  // 公園・水面・田畑・キャンパスの面メッシュも同じ方式(遠方GPU解放/再接近で再構築)。
  // 【2026-07-17】以前はこれだけ一度作ったら二度と解放されなかった(CODE_REVIEW_20260717 P8)。
  unloadFarAreaPolys();
  // Tile-based OSM fetch — loads roads/buildings for newly entered areas
  checkOSMTiles();
  // 遠景標高グリッドをプレイヤーに追従(遠くへジャンプしても実地形・標高が出る)
  checkWideTerrain();
  checkNearTerrain(); // プレイヤー周辺の高解像度グリッドも追従させる
  checkAddressDisplay(); // 現在地の住所表示(市区町村+町名)を移動に応じて更新

  // 山の森(プレイヤー周囲だけ・移動で作り直し)
  updateForest();

  // 空・星・遠景地形をカメラ/プレイヤーに追従させる
  // (固定のままだと移動やマップジャンプで far クリップ外に出て「空が消える」)
  skyMesh.position.copy(camera.position);
  starMesh.position.copy(camera.position);
  // 海面もカメラ追従(高さは海面固定)。テクスチャをスクロールしてさざ波を演出
  if (seaMesh) {
    seaMesh.position.x = camera.position.x;
    seaMesh.position.z = camera.position.z;
    const wt = seaMesh.material.map;
    wt.offset.x = (t * 0.012) % 1;
    wt.offset.y = (t * 0.008) % 1;
    // キャラが完全に水没(頭まで海面下)したら水中エフェクトを出す
    const submerged = (player.position.y + 1.8) < SEA_Y;
    if (submerged !== _wasSubmerged) {
      if (waterOverlay) waterOverlay.classList.toggle('active', submerged);
      _wasSubmerged = submerged;
    }
  }
  updateFarMesh(); // 200mグリッドをまたいだ時だけ再サンプリング(それ以外は即return)

  renderer.render(scene, camera);
  drawMinimap();
  updateGPS(t);
}

if (window.ModeRegistry) {
  // 3D探索を最初のゲームプレイモードとして登録する。
  // 移動・ジャンプ・歩行アニメーション・カメラの実処理は exploreOnUpdate(上で定義)に
  // 分離済み。将来のRPG/アクション等のモードは、同じ枠組みで別のonUpdateを登録すればよい。
  ModeRegistry.registerMode({ id: 'explore', label: '3D探索', onUpdate: exploreOnUpdate });
  ModeRegistry.switchMode('explore');
}

animate();

// ======= RESIZE =======
window.addEventListener('resize', () => {
  renderer.setSize(window.innerWidth, window.innerHeight);
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
});

// ======= 起動ブートストラップ(元 part6.js 末尾から移動) =======
// 【重要】このIIFEはxzToLatLon(part7.js定義)などを同期的に呼ぶため、
// 9ファイルすべての読み込みが終わった後(=このpart9.jsの実行時点)で初めて安全に実行できる。
// part6.jsに置いたままだと、part7.js〜part9.jsがまだ読み込まれる前にReferenceErrorで停止していた。
// Load terrain first, then place OSM world on top
// 明治モードは迅速測図の土地利用データを先に読む(チャンク生成が依存)
(async () => {
  const startLocP = getStartLocation(); // 位置情報の取得を本編ロードと並行で開始
  // モード切替リロード(江戸↔現実など)や遠方ジャンプ後の再開では切替/ジャンプ前の位置に戻す。
  // その時は現在地ジャンプしないし、これから行う伊勢原の初期地形取得も無駄になる(後述)。
  let isModeSwitch = false;
  try { isModeSwitch = !!localStorage.getItem('iseharaResumePos'); } catch (e) {}
  // 【重要】OSMデータの実際の取得・生成はもうここでは行わない — loadOSM()(part6.js)は
  // プレイヤーの初期位置決定と国コードの早期取得だけを行い、道路・建物はpart8.jsの
  // タイル取得システム(checkOSMTiles)がinitialWorldLoaded=true後に周辺タイルとして
  // 取りに行く(伊勢原も他地域と同じ経路)。そのため地形取得と並行するfetchOSMData()の
  // 事前投げは不要になった。
  // 伊勢原本体(原点)のNEAR地形を先に取得しておく。isModeSwitchがtrueでも省略できない —
  // 「モード切替(江戸↔現実など)による再開」と「遠方ジャンプによる再開」はどちらも同じ
  // iseharaResumePosを使うため、この時点(loadOSM呼び出し前)ではまだ区別できない。
  await loadNearTerrain(0, 0);
  if (USES_MEIJI_LANDUSE) await loadMeijiLanduse();
  // モード切替/遠方ジャンプの再開時は、loadOSM()内部で再開先へ原点を付け替え(recenterOrigin)、
  // regionBaseReadyがfalseに戻るため、下のloadNearTerrainで新しい地域の高度基準が確定し直される。
  await loadOSM();
  // 通常起動のみ初期位置へ移動(現在地、取れなければ東京駅)。
  const loc = await startLocP;
  if (!isModeSwitch) jumpToLatLon(loc.lat, loc.lon);
  // 最終的なプレイヤー位置を中心に、NEAR(周辺・高解像度)とFAR(広域・低解像度)を両方取得
  loadNearTerrain(player.position.x, player.position.z);
  loadWideTerrain(player.position.x, player.position.z);
})();
