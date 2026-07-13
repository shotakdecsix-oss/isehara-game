/**
 * legacy/part9.js — index.html の巨大インラインスクリプトを行範囲のまま機械的に切り出した
 * ファイル(9/9・最終)。part8.js の続き。詳細は part1.js 冒頭のコメント参照。
 */
// ======= 山の森(プレイヤー周囲の一定範囲だけを描く=軽量) =======
// 木は建物・道路と同じく「近くだけ」描く。プレイヤーが一定距離動いたら森を作り直す。
// 木の位置・見た目は座標から決まる(plantTree)ので、作り直しても同じ木が並び、ちらつかない。
// 建物・道路のチャンクは半径 CHUNK_RADIUS で生成され CHUNK_RADIUS+2 で消える。
// 森はその中間(+1)に合わせ、建物と木が同じくらいの距離で現れ・消えるようにする。
const FOREST_R = (CHUNK_RADIUS + 1) * CHUNK_SIZE;  // 例: (3+1)*120 = 480m
const FOREST_REBUILD_STEP = CHUNK_SIZE / 2;        // 60mごとに再構築(建物の出現範囲に追従)
const FOREST_MIN_H = 30;          // 局所比高がこの高さ(≈15m)以上を「山」とみなす(平地の街には生えない)
const FOREST_SCATTER = 36;        // 散布グリッド間隔(m)。粗くして候補数=負荷を抑える
let _forestBX = Infinity, _forestBZ = Infinity;

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
  if (!elevData) return;
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

function animate() {
  requestAnimationFrame(animate);
  const dt = Math.min(clock.getDelta(), 0.05);
  const t  = clock.getElapsedTime();

  // 速度: 通常5m/s、最大3倍(15m/s)。スマホ=スティックの倒し量で連続加速、PC=Shiftダッシュ
  // 加速カーブを立たせ(pow0.7×1.15)、6割程度の倒しでも3倍近く出るように
  const joyMag = joyActive ? Math.min(1, Math.sqrt(joyOx*joyOx + joyOz*joyOz)) : 0;
  let speed = 5 + 40 * Math.min(1, Math.pow(joyMag, 0.7) * 1.15); // 最大45m/s
  if (keys['shift']) speed = 45;
  const forward = new THREE.Vector3(-Math.sin(camYaw), 0, -Math.cos(camYaw));
  const right   = new THREE.Vector3( Math.cos(camYaw), 0, -Math.sin(camYaw));

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
    const idealCam = new THREE.Vector3(camX, camY, camZ);
    const safeCam = occlusionCamPos(idealCam, new THREE.Vector3(player.position.x, player.position.y + 1.5, player.position.z));
    camera.position.lerp(safeCam, 0.2);
    camera.lookAt(player.position.x, player.position.y + 1.5, player.position.z);
  }

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
  const _buildBacklog = pendingBuildings.length - pendingBuildingIdx;
  const _buildBudget = Math.min(80, 20 + Math.floor(_buildBacklog / 25));
  for (let n = 0; n < _buildBudget && pendingBuildingIdx < pendingBuildings.length; n++) {
    const b = pendingBuildings[pendingBuildingIdx++];
    const bcx = Math.floor(b.x / CHUNK_SIZE), bcz = Math.floor(b.z / CHUNK_SIZE);
    if (!IS_MEIJI && !chunkNearTerrainReady(bcx, bcz)) {
      b._tries = (b._tries || 0) + 1;
      // 200回(プレイヤーが二度と戻らない遠方チャンク等)試しても揃わなければ、
      // 諦めてFAR基準のまま生成する(無限に足踏みし続けるのを防ぐ)。
      if (b._tries < 200) { pendingBuildings.push(b); continue; }
    }
    if (!isOnRoad(b.x, b.z, b.w, b.d)) addBuilding(b.x, b.z, b.w, b.d, b.h, b.style, b.real);
  }
  if (pendingBuildingIdx > 0 && pendingBuildingIdx === pendingBuildings.length) {
    pendingBuildings.length = 0; pendingBuildingIdx = 0;
  }
  // 実OSM建物が距離に関係なく無限に溜まり続けメモリ・描画負荷が際限なく増える
  // (長時間プレイでの重量化→クラッシュ)のを防ぐため、遠方の建物を解放する
  unloadFarBuildings();
  // 道路・線路も同様に、遠方のものはGPUメッシュだけ解放する(記録データは残す)
  unloadFarRoads();
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

  // ModeRegistry: 現状は3D探索(explore)の実処理はここより上に直接書かれたまま。
  // これは将来モード(RPG/アクション等)が割り込むためのフック呼び出しのみで、
  // 挙動は変えない。実際の探索ロジックをexploreのonUpdateへ移すのは、
  // 本体スクリプトを物理的にファイル分割するタイミングで行う。
  if (window.ModeRegistry) ModeRegistry.update(dt);

  renderer.render(scene, camera);
  drawMinimap();
  updateGPS(t);
}

if (window.ModeRegistry) {
  // 3D探索を最初のゲームプレイモードとして登録する。
  // 実処理はまだanimate()側に残っているため、onUpdateは現時点ではプレースホルダ。
  ModeRegistry.registerMode({ id: 'explore', label: '3D探索' });
  ModeRegistry.switchMode('explore');
}

animate();

// ======= RESIZE =======
window.addEventListener('resize', () => {
  renderer.setSize(window.innerWidth, window.innerHeight);
  camera.aspect = window.innerWidth / window.innerHeight;
  camera.updateProjectionMatrix();
});
