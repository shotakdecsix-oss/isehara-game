/**
 * legacy/part4.js — index.html の巨大インラインスクリプトを行範囲のまま機械的に切り出した
 * ファイル(4/9)。part3.js の続き。詳細は part1.js 冒頭のコメント参照。
 */
// ======= 道路沿いの小物自動配置 =======
// すべてインスタンスプールへの追記なのでメッシュ・マテリアルは増えない
function decorateRoad(x1, z1, x2, z2, type, w, rec) {
  if (type === 'water' || type === 'railway') return;
  const dx = x2 - x1, dz = z2 - z1;
  const len = Math.sqrt(dx * dx + dz * dz);
  if (len < 18) return;
  const nx = dx / len, nz = dz / len, px = -nz, pz = nx;
  const ry = Math.atan2(-nz, nx); // boxのX軸を道路方向に向ける回転
  if (IS_MEIJI) {
    // 明治: 街道の並木と道祖神(石)のみ。電柱・自販機・信号・ガードレール・看板は存在しない
    for (let s = 20; s < len - 10; s += 45 + Math.random() * 20) {
      const side = Math.random() < 0.5 ? -1 : 1;
      const tx = x1 + nx * s + px * side * (w / 2 + 2.2);
      const tz = z1 + nz * s + pz * side * (w / 2 + 2.2);
      addTree(tx, tz, 1.0 + Math.random() * 0.6);
    }
    if (Math.random() < 0.08) {
      const t = Math.random();
      const sx = x1 + dx * t + px * (w / 2 + 1);
      const sz = z1 + dz * t + pz * (w / 2 + 1);
      poolAdd(signalP, sx, getGroundY(sx, sz) + 0.4, sz, Math.random() * 3, 0.5, 1.6, 0.9); // 道祖神
    }
    return;
  }
  const minor = (type === 'road' || type === 'tertiary');
  if (minor) {
    // 電柱・電線は撤去済み(2026-07-15。ただの装飾でリソースの無駄という判断。
    // 経緯はpart2.js冒頭のコメント参照)。
    // 自販機(江戸では樽/井戸)
    if (Math.random() < 0.13) {
      const t = 0.2 + Math.random() * 0.6;
      const vx = x1 + dx * t + px * (w / 2 + 1.2);
      const vz = z1 + dz * t + pz * (w / 2 + 1.2);
      poolAdd(vendP, vx, getGroundY(vx, vz) + PROP_VEND_Y, vz, ry + Math.PI / 2, 1, 1, 1,
              PROP_VEND_COLORS[(Math.random() * 3) | 0]);
    }
  } else {
    // 幹線(secondary以上): ガードレール(8m毎、両側)
    for (let s = 4; s < len - 4; s += 8) {
      for (const side of [-1, 1]) {
        const gx = x1 + nx * s + px * side * (w / 2 + 0.4);
        const gz = z1 + nz * s + pz * side * (w / 2 + 0.4);
        poolAdd(guardP, gx, getGroundY(gx, gz) + 0.7, gz, ry, 8, 1, 1, PROP_GUARD_C);
      }
    }
    // 信号機(長い区間にたまに。江戸モードでは出さない)
    if (PROP_SIGNALS && len > 60 && Math.random() < 0.1) {
      const sx = x1 + dx * 0.5 + px * (w / 2 + 0.8), sz = z1 + dz * 0.5 + pz * (w / 2 + 0.8);
      const gy = getGroundY(sx, sz);
      poolAdd(poleP, sx, gy + 3, sz, 0, 0.8, 0.72, 0.8);
      poolAdd(signalP, sx - px * 1.2, gy + 5.6, sz - pz * 1.2, ry);
      poolAdd(lampP, sx - px * 1.2, gy + 5.6, sz - pz * 1.2, ry, 0.9, 0.9, 0.9,
              Math.random() < 0.6 ? 0x33ff66 : 0xff4433);
    }
    // 青看板・標識
    if (Math.random() < 0.12) {
      const t = Math.random();
      const sx = x1 + dx * t + px * (w / 2 + 0.7), sz = z1 + dz * t + pz * (w / 2 + 0.7);
      const gy = getGroundY(sx, sz);
      poolAdd(poleP, sx, gy + 1.8, sz, 0, 0.5, 0.45, 0.5);
      poolAdd(signBoardP, sx, gy + 3.3, sz, ry);
    }
  }
}

// ======= STATION LANDMARKS =======
const stationLabels = []; // for billboard update each frame
// 駅を構成する全パーツ(駅舎・プラットホーム・看板等)をrecordにまとめておき、
// NEAR高解像度地形が後から届いた時にrebuildStationHeight()でY方向にまとめて
// 追従させる。以前は生成時のgy(=届いていればNEAR、届いていなければFAR基準)で
// 固定していたため、FAR基準で建った駅がNEAR到着後も浮いたまま取り残されていた
// (建物・道路と違って駅だけこの追従の仕組みが無かった)。
const stationRecords = [];

function addStation(x, z, name) {
  const gy = getGroundY(x, z); // 地表基準にしないと高地の駅ランドマークが埋まる
  const parts = []; // このパーツをまとめて後からY方向に平行移動する(rebuildStationHeight)
  const dm = (...a) => { const m = detailMesh(...a); parts.push(m); return m; };
  let refX = x, refZ = z; // rebuild時に地形高さを再サンプリングする基準点(駅舎があればその位置)

  // 最寄りの線路(現実モードの駅舎の向き・プラットホーム位置の両方に使うので先に1回だけ探す)
  let bestRail = null;
  if (railSegs.length) {
    let bd0 = 40 * 40;
    for (const rs of railSegs) {
      const mx = (rs.x1 + rs.x2) / 2, mz = (rs.z1 + rs.z2) / 2;
      const dd = (mx - x) * (mx - x) + (mz - z) * (mz - z);
      if (dd < bd0) { bd0 = dd; bestRail = rs; }
    }
  }

  let labelY = gy + 62; // ファンタジー版の高い掲示位置(既定)

  if (IS_REAL) {
    // ===== 現実モード: 立派な駅舎(ファンタジーの金塔・星・輪は使わない) =====
    let rx = 1, rz = 0; // 線路の向き(見つからなければ既定でx軸方向)
    if (bestRail) {
      const ddx = bestRail.x2 - bestRail.x1, ddz = bestRail.z2 - bestRail.z1;
      const dl = Math.hypot(ddx, ddz) || 1;
      rx = ddx / dl; rz = ddz / dl;
    }
    const px = -rz, pz = rx; // 線路に直交する向き(駅舎を線路の脇に配置する)
    const ry = Math.atan2(rx, rz); // 建物の長辺(ローカルZ)を線路と平行に揃える回転
    const off = 12; // 線路中心からのオフセット
    const sx = x + px * off, sz = z + pz * off;
    const sgy = getGroundY(sx, sz);
    refX = sx; refZ = sz; // 駅舎位置を基準にNEAR更新時の高さを再サンプリングする
    const bw = 30, bd = 15, bh = 8; // 線路沿いに長い、堂々とした駅舎

    const body = new THREE.Mesh(new THREE.BoxGeometry(bd, bh, bw), lambertMat(0xe8e0cc));
    body.position.set(sx, sgy + bh / 2, sz);
    body.rotation.y = ry;
    body.castShadow = true;
    scene.add(body);
    parts.push(body);

    // 屋上の帯(濃色パラペットで建物を引き締める)
    const band = new THREE.Mesh(new THREE.BoxGeometry(bd + 0.6, 1.1, bw + 0.6), lambertMat(0x2a4a6a));
    band.position.set(sx, sgy + bh + 0.55, sz);
    band.rotation.y = ry;
    scene.add(band);
    parts.push(band);

    // 線路側(改札口)のガラス張り玄関+庇
    const entX = sx - px * (bd / 2 + 2.0), entZ = sz - pz * (bd / 2 + 2.0);
    const glassMat = new THREE.MeshLambertMaterial({
      color: 0x88ccee, emissive: 0x224466, emissiveIntensity: 0.45, transparent: true, opacity: 0.85,
    });
    const glass = new THREE.Mesh(new THREE.BoxGeometry(1.0, bh * 0.7, bw * 0.55), glassMat);
    glass.position.set(entX, sgy + bh * 0.4, entZ);
    glass.rotation.y = ry;
    scene.add(glass);
    parts.push(glass);
    const canopy = new THREE.Mesh(new THREE.BoxGeometry(3.4, 0.4, bw * 0.65), lambertMat(0x445566));
    canopy.position.set(entX - px * 1.7, sgy + bh * 0.62, entZ - pz * 1.7);
    canopy.rotation.y = ry;
    scene.add(canopy);
    parts.push(canopy);
    for (const co of [-bw * 0.28, bw * 0.28]) { // 庇の支柱
      dm(UNIT_CYL, lambertMat(0x8a8d90),
        entX - px * 3.3 + rx * co, sgy + bh * 0.31, entZ - pz * 3.3 + rz * co, 0.22, bh * 0.62, 0.22);
    }

    // 駅舎の時計
    const clock = new THREE.Mesh(new THREE.CylinderGeometry(1.3, 1.3, 0.25, 16),
      new THREE.MeshLambertMaterial({ color: 0xfffbe8, emissive: 0xffee88, emissiveIntensity: 0.5 }));
    clock.rotation.x = Math.PI / 2;
    clock.rotation.z = ry;
    clock.position.set(entX - px * 2.4, sgy + bh * 0.88, entZ - pz * 2.4);
    scene.add(clock);
    parts.push(clock);

    // 駅前の温かい灯り
    const light = new THREE.PointLight(0xffddaa, 3, 100);
    light.position.set(entX - px * 3, sgy + bh * 0.6, entZ - pz * 3);
    scene.add(light);
    parts.push(light);

    labelY = sgy + 30; // 駅名看板は遠くからでも目立つよう駅舎の上空に浮かせる
  } else {
    // ===== 従来のファンタジー演出(江戸・メルヘン・宇宙モード) =====
    const stC = MODE === 'edo'     ? { c: 0x8a6a40, e: 0xcc6600 }
              : MODE === 'marchen' ? { c: 0xffb0d0, e: 0xff70a0 }
              : MODE === 'space'   ? { c: 0x66eeff, e: 0x00ccff }
              : { c: 0xffcc00, e: 0xff8800 };
    const pillarMat = new THREE.MeshLambertMaterial({ color: stC.c, emissive: stC.e, emissiveIntensity: 0.6 });
    const pillar = new THREE.Mesh(new THREE.CylinderGeometry(1.5, 2.5, 50, 8), pillarMat);
    pillar.position.set(x, gy + 25, z);
    pillar.castShadow = true;
    scene.add(pillar);
    parts.push(pillar);

    // Glowing star orb on top
    const starMat = new THREE.MeshBasicMaterial({ color: 0xffee44 });
    const star = new THREE.Mesh(new THREE.SphereGeometry(5, 12, 12), starMat);
    star.position.set(x, gy + 53, z);
    scene.add(star);
    parts.push(star);

    // Rotating ring
    const ringMat = new THREE.MeshBasicMaterial({ color: 0xffaa00, side: THREE.DoubleSide });
    const ring = new THREE.Mesh(new THREE.TorusGeometry(8, 0.8, 8, 32), ringMat);
    ring.position.set(x, gy + 45, z);
    scene.add(ring);
    parts.push(ring);
    stationLabels.push({ type: 'ring', mesh: ring, x, z }); // animate the ring each frame

    // Bright light
    const light = new THREE.PointLight(0xffdd44, 4, 600);
    light.position.set(x, gy + 53, z);
    scene.add(light);
    parts.push(light);
  }

  // 現実モード: 最寄りの線路に沿ってプラットホーム(両側)+上屋を置く
  if (IS_REAL && bestRail) {
    const ddx = bestRail.x2 - bestRail.x1, ddz = bestRail.z2 - bestRail.z1;
    const dl = Math.hypot(ddx, ddz) || 1;
    const rx = ddx / dl, rz = ddz / dl;
    const ryr = Math.atan2(-rz, rx);
    const pxp = -rz, pzp = rx;
    const mx = (bestRail.x1 + bestRail.x2) / 2, mz = (bestRail.z1 + bestRail.z2) / 2;
    for (const sd of [-1, 1]) {
      const hx = mx + pxp * sd * 4.6, hz = mz + pzp * sd * 4.6;
      const hgy = getGroundY(hx, hz);
      dm(UNIT_BOX, lambertMat(0x9c9c96), hx, hgy + 0.6, hz, 46, 1.2, 3.2, ryr); // ホーム
      dm(UNIT_BOX, lambertMat(0x50545a), hx, hgy + 3.6, hz, 42, 0.2, 3.0, ryr); // 上屋
      for (const po of [-14, 14]) { // 上屋の支柱
        dm(UNIT_CYL, lambertMat(0x8a8d90), hx + rx * po, hgy + 2.4, hz + rz * po, 0.24, 2.4, 0.24);
      }
    }
  }

  // Name label (canvas texture billboard)
  const cvs = document.createElement('canvas');
  cvs.width = 512; cvs.height = 96;
  const ctx2d = cvs.getContext('2d');
  ctx2d.fillStyle = 'rgba(20,10,0,0.85)';
  ctx2d.fillRect(0, 0, 512, 96);
  ctx2d.strokeStyle = '#ffcc00';
  ctx2d.lineWidth = 4;
  ctx2d.strokeRect(2, 2, 508, 92);
  ctx2d.fillStyle = '#ffee44';
  ctx2d.font = 'bold 52px sans-serif';
  ctx2d.textAlign = 'center';
  ctx2d.textBaseline = 'middle';
  ctx2d.fillText(name, 256, 48);
  const tex = new THREE.CanvasTexture(cvs);
  const labelMesh = new THREE.Mesh(
    new THREE.PlaneGeometry(40, 8),
    new THREE.MeshBasicMaterial({ map: tex, transparent: true, side: THREE.DoubleSide, depthTest: false })
  );
  labelMesh.position.set(x, labelY, z);
  scene.add(labelMesh);
  parts.push(labelMesh);
  stationLabels.push({ type: 'label', mesh: labelMesh, x, z });

  // NEAR高解像度地形が後から届いた時にY方向へまとめて追従できるよう記録しておく
  // (道路・建物と同じ仕組み。以前は駅だけこれが無く、FAR基準で建った駅が浮いたまま残った)
  stationRecords.push({ refX, refZ, gy: getGroundY(refX, refZ), parts });
}

// 1駅ぶんを現在の地形に合わせてY方向へ平行移動する(rebuildBuildingHeightと同じ考え方)
function rebuildStationHeight(rec) {
  const newGy = getGroundY(rec.refX, rec.refZ);
  const delta = newGy - rec.gy;
  if (Math.abs(delta) < 0.05) return; // 誤差レベルは無視
  for (const p of rec.parts) { if (p) p.position.y += delta; }
  rec.gy = newGy;
}
// 矩形範囲(ワールド座標)にかかる駅を、現在の地形に合わせてまとめて追従させる。
// rebuildBuildingsInBoundsと同じタイミング(NEAR再取得時・チャンク生成時)で呼ぶ。
// 駅は数が少ないため建物のような空間グリッドは使わず線形走査で十分。
function rebuildStationsInBounds(x0, x1, z0, z1) {
  for (const rec of stationRecords) {
    if (rec.refX < x0 || rec.refX > x1 || rec.refZ < z0 || rec.refZ > z1) continue;
    rebuildStationHeight(rec);
  }
}

// ======= OSM DATA LOADER =======
const statusEl = document.getElementById('status');
// トースト化: sticky=true の間は自動で消えない(次の呼び出しか手動再表示まで保持)
let _toastTimer = null;
function showToast(msg, opts) {
  opts = opts || {};
  statusEl.textContent = msg;
  statusEl.style.display = 'block';
  statusEl.style.opacity = '1';
  clearTimeout(_toastTimer);
  if (!opts.sticky) {
    _toastTimer = setTimeout(() => {
      statusEl.style.opacity = '0';
      setTimeout(() => { statusEl.style.display = 'none'; }, 400);
    }, opts.duration || 3000);
  }
}
// 初期スポーン: 神奈川県伊勢原市東成瀬2-2-11
// (国土地理院ジオコーディング「東成瀬2番地」= 35.409103, 139.342331)
const SPAWN_LAT = 35.409103, SPAWN_LON = 139.342331;
// 初期OSM取得範囲と詳細地形はスポーン位置が中心になるよう定義(スパンは従来と同じ0.04°×0.03°)。
// ワールド原点(0,0)=この範囲の中心=スポーン地点となり、以降の全計算が自動で整合する
const OSM_BOUNDS = {
  minLat: SPAWN_LAT - 0.02, minLon: SPAWN_LON - 0.015,
  maxLat: SPAWN_LAT + 0.02, maxLon: SPAWN_LON + 0.015
};
const SCALE = 111000; // 1 game unit = 1 meter
// 【重要】原点(MID_LAT/MID_LON)は元々「初期スポーン=伊勢原」に固定のconstだった。
// 海外(米国など)へジャンプするとプレイヤーのワールド座標が原点から数千〜数万km相当の
// 巨大な数値になり、three.jsがGPUへ座標・行列をfloat32(有効数字約7桁)でアップロードする際に
// 精度を使い果たして地面・道路・樹木がちらつく(位置ジッター/z-fighting)不具合が起きていた。
// そこで原点を`let`にして可変にし、遠方へジャンプする時だけジャンプ先へ原点を付け替える
// (recenterOrigin、part7.jsのjumpToLatLonから呼ぶ)。ローカル座標を常に原点付近の
// 小さな値に保つ「浮動原点(floating origin)」方式。既存の建物・地形は付け替え前の
// 原点基準のまま(数値としては正しい)残るが、遠方へ飛ぶ時点でどのみち体感上は
// 二度と戻らない距離になるため実害はない(既存のチャンク破棄・再生成の仕組みと整合的)。
let MID_LAT = (OSM_BOUNDS.minLat + OSM_BOUNDS.maxLat) / 2;
let MID_LON = (OSM_BOUNDS.minLon + OSM_BOUNDS.maxLon) / 2;
let COS_LAT = Math.cos(OSM_BOUNDS.minLat * Math.PI / 180);

// 原点をlat,lonへ付け替える(浮動原点の再設定)。COS_LATも現在地の緯度に合わせて更新するため、
// 経度→メートル換算の精度も(伊勢原基準の固定値だった頃に比べ)副次的に改善する。
// 【2026-07-14】地形描写を伊勢原専用メッシュ廃止・全地域共通(part5/part6.js)に統一したのに
// 合わせ、ここでは regionBaseReady(part6.js)を false に戻すだけでよい。次の loadNearTerrain
// 成功時に、新しい地域の実データから elevBase/ROCK_Y/SNOW_Y/TREELINE/海面高さが確定し直される。
function recenterOrigin(lat, lon) {
  MID_LAT = lat; MID_LON = lon;
  COS_LAT = Math.cos(lat * Math.PI / 180);
  regionBaseReady = false;
}

function latLonToXZ(lat, lon) {
  const x = (lon - MID_LON) * SCALE * COS_LAT;
  const z = -((lat - MID_LAT) * SCALE);
  return { x, z };
}

// ======= 面フィーチャ(公園・水域・田畑・森) =======
const avoidPolygons = []; // 手続き生成の建物を建ててはいけない領域
const avoidGrid = new Map(); // polyGridAdd/queryPolyGridで使う空間ハッシュ(全件走査を避ける)
const areaPolyBudget = { park: 80, water: 80, farm: 250, campus: 60 }; // 面メッシュのドローコール予算
const lawnMat  = new THREE.MeshLambertMaterial({ color: MODE_CONF.lawn, side: THREE.DoubleSide });
// リボン(ROAD_MAT.water)と同じMeshBasicにして、重なっても境目が見えないようにする
const waterAreaMat = new THREE.MeshBasicMaterial({ color: MODE_CONF.water, side: THREE.DoubleSide });
const minimapWaterPolys = []; // ミニマップに描く実形状水面 {pts,minX,maxX,minZ,maxZ}
const minimapWaterGrid = new Map(); // polyGridAdd/queryPolyGridで使う空間ハッシュ(全件走査を避ける)
// 田畑: あぜ縞のcanvasテクスチャ(uv=世界座標なので repeat で約9m周期の縞になる)
const farmMat = (() => {
  const c = document.createElement('canvas'); c.width = 32; c.height = 32;
  const g = c.getContext('2d');
  const fc = MODE === 'space' ? ['#2a3240', '#3a4756'] // 無機質グリッド
           : MODE === 'marchen' ? ['#7bd06a', '#e8c87a']
           : ['#6a8a3a', '#8a7a4a'];
  g.fillStyle = fc[0]; g.fillRect(0, 0, 32, 32);
  g.fillStyle = fc[1]; g.fillRect(0, 12, 32, 8);
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(1 / 9, 1 / 9);
  return new THREE.MeshLambertMaterial({ map: tex, side: THREE.DoubleSide });
})();

// 校庭(学校の敷地全体): 土の粒状テクスチャ+陸上トラックの白線を1枚のcanvasに焼き込む。
// buildAreaPoly(ShapeGeometry)は敷地の外接矩形基準で自動的にUV0..1を割り振るため、
// このテクスチャはrepeatさせず、敷地の外接矩形にちょうど1つ収まるように描けばよい。
const campusGroundMat = (() => {
  const c = document.createElement('canvas'); c.width = 512; c.height = 384;
  const g = c.getContext('2d');
  const W = c.width, H = c.height;
  g.fillStyle = '#b89868'; // 土
  g.fillRect(0, 0, W, H);
  for (let i = 0; i < 3500; i++) { // 粒状ノイズ
    const rgb = [100 + Math.random()*50|0, 80 + Math.random()*40|0, 50 + Math.random()*30|0];
    g.fillStyle = `rgba(${rgb[0]},${rgb[1]},${rgb[2]},0.35)`;
    g.fillRect(Math.random()*W, Math.random()*H, 2, 2);
  }
  // 陸上トラック(白線、スタジアム形=直線+半円のレーンを6本)
  const cx = W/2, cy = H/2;
  g.strokeStyle = 'rgba(255,255,255,0.85)';
  for (let lane = 0; lane < 6; lane++) {
    const rx = W*0.42 - lane*15, ry = H*0.36 - lane*11;
    if (rx < 30 || ry < 18) break;
    const straight = Math.max(0.1, rx - ry);
    g.lineWidth = 2;
    g.beginPath();
    g.moveTo(cx - straight, cy - ry);
    g.lineTo(cx + straight, cy - ry);
    g.arc(cx + straight, cy, ry, -Math.PI/2, Math.PI/2, false);
    g.lineTo(cx - straight, cy + ry);
    g.arc(cx - straight, cy, ry, Math.PI/2, -Math.PI/2, false);
    g.closePath();
    g.stroke();
  }
  const tex = new THREE.CanvasTexture(c);
  return new THREE.MeshLambertMaterial({ map: tex, side: THREE.DoubleSide });
})();

// ポリゴンから地形に沿った面メッシュを1枚生成(三角形分割はShapeGeometry=earcut)
// holes: 内周リング(中州など)の配列(省略可)
// 水域・公園・田畑ポリゴンのメッシュ一覧。NEAR高解像度地形が更新されたとき、
// 範囲にかかるものだけ高さを再スナップする(浮き/埋まり対策。道路と同じ考え方)。
const areaPolyMeshes = [];
const areaPolyGrid = new Map(); // polyGridAdd/queryPolyGridで使う空間ハッシュ(全件走査を避ける)
function rebuildAreaPolyMesh(entry) {
  const pos = entry.mesh.geometry.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), z = pos.getZ(i); // Y(高さ)だけ書き換えるのでX/Zはそのまま読める
    pos.setY(i, getGroundY(x, z) + entry.yOff);
  }
  pos.needsUpdate = true;
  entry.mesh.geometry.computeVertexNormals();
  entry.mesh.geometry.computeBoundingSphere();
}
// 【重要】以前はareaPolyMeshes(取得済み全件。増え続けて減らない)を毎回全件走査していた。
// NEAR地形の再取得・チャンク生成のたびに呼ばれる頻出パスなので、探索が進むほど
// コストが際限なく悪化していた(長時間プレイでの重量化の主因の一つ)。空間ハッシュで近傍だけ拾う。
function rebuildAreaPolysInBounds(x0, x1, z0, z1) {
  for (const e of queryPolyGrid(areaPolyGrid, x0, x1, z0, z1)) {
    // グリッドはセル単位(粗い)なので、無駄な再構築を避けるため最後に正確なbboxで絞る
    if (e.maxX < x0 || e.minX > x1 || e.maxZ < z0 || e.minZ > z1) continue;
    rebuildAreaPolyMesh(e);
  }
}

function buildAreaPoly(pts, mat, yOff, holes) {
  const shape = new THREE.Shape();
  shape.moveTo(pts[0].x, pts[0].z);
  for (let i = 1; i < pts.length; i++) shape.lineTo(pts[i].x, pts[i].z);
  if (holes) for (const hp of holes) {
    if (hp.length < 4) continue;
    const hpath = new THREE.Path();
    hpath.moveTo(hp[0].x, hp[0].z);
    for (let i = 1; i < hp.length; i++) hpath.lineTo(hp[i].x, hp[i].z);
    shape.holes.push(hpath);
  }
  const geo = new THREE.ShapeGeometry(shape);
  const pos = geo.attributes.position;
  for (let i = 0; i < pos.count; i++) {
    const x = pos.getX(i), z = pos.getY(i); // ShapeのXY平面 → XZ平面へ
    pos.setXYZ(i, x, getGroundY(x, z) + yOff, z);
  }
  geo.computeVertexNormals();
  const mesh = new THREE.Mesh(geo, mat);
  mesh.renderOrder = 1;
  scene.add(mesh);
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const p of pts) { minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z); }
  const entry = { mesh, yOff, minX, maxX, minZ, maxZ };
  areaPolyMeshes.push(entry);
  polyGridAdd(areaPolyGrid, entry);
}

// buildAreaPolyは元のOSM way頂点(数個)だけで平らな三角形を張るため、起伏のある地形では
// 頂点間で地面から浮いたり埋まったりする(校庭・田畑など、実際に上を歩く地物で顕著)。
// この版はポリゴンの外接矩形をcellSize間隔の格子に分割し、格子点ごとにgetGroundYを
// サンプルするので、地形の起伏に追従する。境界セルはポリゴン外の頂点を含む場合スキップする
// (輪郭がわずかに内側へ痩せるが、実用上は問題ない簡易対応)。
// worldUV=true: UVを世界座標(m)にする(repeatラップの田畑テクスチャ用)。
// worldUV=false: UVをポリゴン外接矩形基準の0..1にする(校庭のトラック等、1枚だけ収めたいテクスチャ用)。
function buildTerrainFollowingAreaPoly(pts, mat, yOff, cellSize, worldUV) {
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  pts.forEach(p => { minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z); });
  const nx = Math.max(1, Math.min(80, Math.ceil((maxX - minX) / cellSize)));
  const nz = Math.max(1, Math.min(80, Math.ceil((maxZ - minZ) / cellSize)));
  const verts = [], uvs = [], idx = [];
  const grid = [];
  for (let j = 0; j <= nz; j++) {
    const row = [];
    for (let i = 0; i <= nx; i++) {
      const x = minX + (maxX - minX) * i / nx;
      const z = minZ + (maxZ - minZ) * j / nz;
      if (!pointInPolygon(x, z, pts)) { row.push(-1); continue; }
      row.push(verts.length / 3);
      verts.push(x, getGroundY(x, z) + yOff, z);
      uvs.push(worldUV ? x : i / nx, worldUV ? z : j / nz);
    }
    grid.push(row);
  }
  for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
    const a = grid[j][i], b = grid[j][i + 1], c = grid[j + 1][i + 1], d = grid[j + 1][i];
    if (a < 0 || b < 0 || c < 0 || d < 0) continue; // 境界セル(ポリゴン外の頂点を含む)は張らない
    idx.push(a, b, c, a, c, d);
  }
  if (idx.length === 0) return; // 細すぎる/境界だけのポリゴンはフォールバックなしで諦める
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  const mesh = new THREE.Mesh(geo, mat);
  mesh.renderOrder = 1;
  scene.add(mesh);
  const entry = { mesh, yOff, minX, maxX, minZ, maxZ };
  areaPolyMeshes.push(entry);
  polyGridAdd(areaPolyGrid, entry);
}

function scatterTreesIn(poly, sqmPerTree, cap) {
  const area = (poly.maxX - poly.minX) * (poly.maxZ - poly.minZ);
  const n = Math.min(cap, Math.max(2, Math.floor(area / sqmPerTree)));
  for (let i = 0; i < n; i++) {
    const x = poly.minX + Math.random() * (poly.maxX - poly.minX);
    const z = poly.minZ + Math.random() * (poly.maxZ - poly.minZ);
    if (!pointInPolygon(x, z, poly.pts)) continue;
    if (isOnRoad(x, z, 2.5, 2.5)) continue; // 公園・森を横切る道路の上に木が生えないように
    addTree(x, z, 0.7 + Math.random() * 0.9);
  }
}

// ======= 明治モード: 迅速測図100m土地利用データ =======
// 出典: 農研機構農業環境研究部門「明治時代初期土地利用・被覆デジタルデータベース」(CC BY 4.0)
// https://github.com/wata909/habs_test — GitHub Pages配信でCORS可、プロキシ不要。
// 100m間隔の点データ。code: 1水田 2畑 3果樹園(桑茶) 4森林 5草地荒地 6村落 7土手崖 8砂地 9湿地 10水面 11竹 12塩田
const meijiCells = new Map();       // "gx,gz"(100m格子) → 土地利用コード
const meijiMeshLoaded = new Set();  // 取得済み二次メッシュ
let meijiReady = false;

// ======= 明治・江戸: 現代建物密度ヒント =======
// 明治・江戸モードでは実OSM建物(神社仏閣以外)は描画しないが、「ここは昔から
// 栄えていた町場だった可能性が高いか」を判定するヒントとして、実際の棟数だけを
// 100m格子で数えておく(建物メッシュは作らないので軽量)。
const modernBuildingDensity = new Map(); // "gx,gz"(100m格子) → 現代建物棟数
function noteModernBuilding(x, z) {
  const k = Math.round(x / 100) + ',' + Math.round(z / 100);
  modernBuildingDensity.set(k, (modernBuildingDensity.get(k) || 0) + 1);
}
function localModernDensity(gx, gz) { // 周辺3×3セル(300m四方)合計(1セル単体のノイズを緩和)
  let n = 0;
  for (let dx = -1; dx <= 1; dx++)
    for (let dz = -1; dz <= 1; dz++)
      n += modernBuildingDensity.get((gx + dx) + ',' + (gz + dz)) || 0;
  return n;
}
const TOWN_TIER_MIN = 8; // 300m四方の現代建物棟数がこれ以上なら「町場(宿場町・城下町)」ティアとみなす

function meijiMeshCode(lat, lon) {
  const p = Math.floor(lat * 1.5), u = Math.floor(lon - 100);
  const q = Math.floor((lat * 1.5 - p) * 8), v = Math.floor(((lon - 100) - u) * 8);
  return { m1: '' + p + u, m2: '' + p + u + q + v };
}

async function loadMeijiMesh(lat, lon) {
  const { m1, m2 } = meijiMeshCode(lat, lon);
  if (meijiMeshLoaded.has(m2)) return;
  meijiMeshLoaded.add(m2);
  try {
    const res = await fetch(`https://wata909.github.io/habs_test/${m1}/geojson/rapid${m2}.geojson`);
    if (!res.ok) return; // データ未整備地域(404)は空扱いで確定
    const gj = await res.json();
    if (!gj || !gj.features) return;
    for (const f of gj.features) {
      if (!f.geometry || f.geometry.type !== 'Point') continue;
      const code = f.properties && (f.properties.code || f.properties.habs_code);
      if (!code) continue;
      const p = latLonToXZ(f.geometry.coordinates[1], f.geometry.coordinates[0]);
      meijiCells.set(Math.round(p.x / 100) + ',' + Math.round(p.z / 100), code);
      // 森林・竹は読み込み時に低密度で木を散布(恒久インスタンス。プール上限で頭打ち)
      if ((code === 4 || code === 11) && Math.random() < 0.4) {
        const tx = p.x + (Math.random() - 0.5) * 80, tz = p.z + (Math.random() - 0.5) * 80;
        if (!isOnRoad(tx, tz, 2.5, 2.5)) // 街道の上に木が生えないように
          addTree(tx, tz, code === 11 ? 0.55 : 0.8 + Math.random() * 0.8);
      }
    }
  } catch (e) { meijiMeshLoaded.delete(m2); } // ネットワーク失敗は再試行可能に
}

async function loadMeijiLanduse() {
  // 江戸: 当時の実測地図が無いため、明治期(迅速測図)データを地形の近似として流用する
  const label = MODE === 'edo' ? '明治期データを江戸期の近似として' : '明治期土地利用';
  showToast(`🌾 ${label}データ取得中...`, { sticky: true });
  const jobs = [];
  for (const lat of [OSM_BOUNDS.minLat, OSM_BOUNDS.maxLat])
    for (const lon of [OSM_BOUNDS.minLon, OSM_BOUNDS.maxLon])
      jobs.push(loadMeijiMesh(lat, lon));
  await Promise.all(jobs);
  meijiReady = true;
  showToast(`🌾 ${label} ${meijiCells.size} 地点読込`);
}

// ======= 頂点間引きほか =======
// 頂点の間引き — 直前の採用点から tol[m] 未満の点をスキップ(大河川の負荷対策)
function thinPts(pts, tol) {
  if (tol <= 0 || pts.length < 20) return pts;
  const out = [pts[0]];
  for (let i = 1; i < pts.length - 1; i++) {
    const last = out[out.length - 1];
    const dx = pts[i].x - last.x, dz = pts[i].z - last.z;
    if (dx * dx + dz * dz >= tol * tol) out.push(pts[i]);
  }
  out.push(pts[pts.length - 1]);
  return out;
}

// ======= multipolygon 水面(相模川クラスの大河川) =======
// 大きな水面はOSMでは relation(multipolygon) で表現され、outer が複数wayに
// 分割されていることが多い。端点一致で連結して閉リングを組み立てる。
const seenOSMRels = new Set();
function _llEq(a, b) { return Math.abs(a.lat - b.lat) < 1e-6 && Math.abs(a.lon - b.lon) < 1e-6; }
function stitchRings(members) {
  const segs = members.map(m => m.geometry.slice());
  const rings = [];
  while (segs.length) {
    let ring = segs.pop().slice();
    let guard = 0;
    while (guard++ < 500) {
      const head = ring[0], tail = ring[ring.length - 1];
      if (_llEq(head, tail)) break; // 閉じた
      let found = -1, rev = false, atEnd = true;
      for (let i = 0; i < segs.length; i++) {
        const s = segs[i], sh = s[0], st = s[s.length - 1];
        if (_llEq(tail, sh)) { found = i; rev = false; atEnd = true;  break; }
        if (_llEq(tail, st)) { found = i; rev = true;  atEnd = true;  break; }
        if (_llEq(head, st)) { found = i; rev = false; atEnd = false; break; }
        if (_llEq(head, sh)) { found = i; rev = true;  atEnd = false; break; }
      }
      if (found < 0) break; // これ以上つながらない → 開いたまま採用(earcutは閉じ扱い)
      let s = segs.splice(found, 1)[0];
      if (rev) s = s.slice().reverse();
      ring = atEnd ? ring.concat(s.slice(1)) : s.concat(ring.slice(1));
    }
    if (ring.length >= 4) rings.push(ring);
  }
  return rings;
}

function processWaterRelation(el) {
  if (el.type !== 'relation' || !el.members) return;
  const tags = el.tags || {};
  if (!(tags.natural === 'water' || tags.waterway === 'riverbank' || tags.water)) return;
  if (seenOSMRels.has(el.id)) return;
  seenOSMRels.add(el.id);
  const outers = el.members.filter(m => m.type === 'way' && m.role !== 'inner' && m.geometry && m.geometry.length >= 2);
  const inners = el.members.filter(m => m.type === 'way' && m.role === 'inner' && m.geometry && m.geometry.length >= 2);
  const innerRings = stitchRings(inners);
  for (const ring of stitchRings(outers)) {
    let pts = ring.map(g => latLonToXZ(g.lat, g.lon));
    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    pts.forEach(p => { minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z); });
    const span = Math.max(maxX - minX, maxZ - minZ);
    if (span < 25) continue;
    const tol = span > 1500 ? 25 : span > 400 ? 10 : 0;
    pts = thinPts(pts, tol);
    if (pts.length < 4) continue;
    const poly = { pts, minX, maxX, minZ, maxZ };
    avoidPolygons.push(poly); // 水面内には建物を生成しない
    polyGridAdd(avoidGrid, poly);
    if (areaPolyBudget.water-- > 0) {
      // このouterのbbox内にある中州(inner)を穴として追加
      const holes = innerRings
        .map(r => thinPts(r.map(g => latLonToXZ(g.lat, g.lon)), tol))
        .filter(hp => hp.length >= 4 &&
                hp[0].x >= minX && hp[0].x <= maxX && hp[0].z >= minZ && hp[0].z <= maxZ);
      buildAreaPoly(pts, waterAreaMat, 0.15, holes);
      minimapWaterPolys.push(poly);
      polyGridAdd(minimapWaterGrid, poly);
    }
  }
}

// waterway の実幅: width タグ優先、なければ種別から推定
function waterwayWidth(tags) {
  const wtag = parseFloat(tags.width || tags['width:river']); // "5 m" 等も parseFloat で拾える
  if (wtag > 0) return Math.min(60, Math.max(1.5, wtag));
  switch (tags.waterway) {
    case 'river':  return 12;
    case 'canal':  return 5;
    case 'stream': return 2.5;
    default:       return 3;
  }
}

// OSM要素が面フィーチャなら処理して true を返す(初期ロード・タイル両方から呼ばれる)
function handleAreaFeature(el) {
  if (el.type !== 'way' || !el.geometry || el.geometry.length < 4) return false;
  const tags = el.tags || {};
  const lu = tags.landuse || '';
  // riverbank ポリゴン(旧スタイルの川の実形状)も水面として扱う
  const isWater  = tags.natural === 'water' || tags.waterway === 'riverbank';
  // 明治: 現代の公園・田畑・森ポリゴンは使わない(迅速測図データで代替)。川・水面のみ残す
  if (IS_MEIJI && !isWater) return false;
  const isPark   = tags.leisure === 'park' || tags.leisure === 'garden' || tags.leisure === 'playground';
  const isFarm   = ['farmland','farm','orchard','meadow','allotments','vineyard'].includes(lu);
  const isForest = lu === 'forest' || tags.natural === 'wood';
  // 学校・大学・病院の敷地全体(構内に手続き生成の家を建てさせないための回避ゾーン)
  const isCampus = ['school','university','college','hospital'].includes(tags.amenity || '');
  if (!isPark && !isWater && !isFarm && !isForest && !isCampus) return false;
  const pts = el.geometry.map(g => latLonToXZ(g.lat, g.lon));
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  pts.forEach(p => { minX = Math.min(minX, p.x); maxX = Math.max(maxX, p.x); minZ = Math.min(minZ, p.z); maxZ = Math.max(maxZ, p.z); });
  const poly = { pts, minX, maxX, minZ, maxZ };
  avoidPolygons.push(poly);
  polyGridAdd(avoidGrid, poly);
  // 巨大ポリゴンの面メッシュは張らない(頂点間で地形を突き抜けるため)。木は個別に接地するのでOK
  // また面メッシュ=1ドローコールなので種類ごとに総数予算を設ける(超過分は回避領域としてのみ機能)
  const span = Math.max(maxX - minX, maxZ - minZ);
  if (isPark) {
    if (span < 400 && areaPolyBudget.park-- > 0) buildTerrainFollowingAreaPoly(pts, lawnMat, 0.14, 20, false);
    scatterTreesIn(poly, 170, 40);
    const cx = (minX + maxX) / 2, cz = (minZ + maxZ) / 2;
    for (let i = 0; i < 3; i++) { // ベンチ
      const bx = cx + (Math.random() - 0.5) * (maxX - minX) * 0.5;
      const bz = cz + (Math.random() - 0.5) * (maxZ - minZ) * 0.5;
      if (pointInPolygon(bx, bz, pts)) poolAdd(benchP, bx, getGroundY(bx, bz) + 0.35, bz, Math.random() * Math.PI);
    }
    if (pointInPolygon(cx, cz, pts)) { // 公園灯
      const gy = getGroundY(cx, cz);
      poolAdd(poleP, cx, gy + 2, cz, 0, 0.6, 0.5, 0.6);
      poolAdd(lampP, cx, gy + 4.1, cz, 0, 1, 1, 1, 0xffcc77);
    }
  } else if (isWater) {
    if (span < 3000 && areaPolyBudget.water-- > 0) {
      const tp = thinPts(pts, span > 400 ? 10 : 0);
      buildAreaPoly(tp, waterAreaMat, 0.15);
      const _wpEntry = { pts: tp, minX, maxX, minZ, maxZ };
      minimapWaterPolys.push(_wpEntry);
      polyGridAdd(minimapWaterGrid, _wpEntry);
    }
  } else if (isFarm) {
    if (span >= 15 && span < 500 && areaPolyBudget.farm-- > 0) buildTerrainFollowingAreaPoly(pts, farmMat, 0.1, 20, true);
  } else if (isForest) {
    scatterTreesIn(poly, 380, 70);
  } else if (isCampus) {
    if (span < 900 && areaPolyBudget.campus-- > 0) buildTerrainFollowingAreaPoly(pts, campusGroundMat, 0.13, 25, false);
  }
  return true;
}
