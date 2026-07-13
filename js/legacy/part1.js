/**
 * legacy/part1.js — index.html の巨大インラインスクリプトを、挙動を変えずに
 * 行範囲のまま機械的に切り出した最初のファイル(1/9)。
 * ロジックの再編・命名整理は行っていない。読み込み順は元のコードと同一を維持する必要がある
 * (classic scriptなのでグローバルスコープを共有し、宣言順に依存しているため)。
 */
// Prevent default touch scroll everywhere
document.documentElement.style.touchAction = 'none';
document.body.style.touchAction = 'none';

// ======= 表示モード =======
// 地形・道路・当たり判定・ゲームロジックは全モード共通。見た目(マテリアル/ジオメトリ/環境色)のみ差し替える。
// 切替は localStorage に保存してリロード=ワールド全体をそのモードで再生成(最も安全な「チャンク再構築」)。
const VISUAL_MODES = [
  { id: 'real',    label: '🏙 現実' },
  { id: 'meiji',   label: '🌾 明治' },
  { id: 'edo',     label: '🏯 江戸' },
  { id: 'marchen', label: '🍭 メルヘン' },
  { id: 'space',   label: '🛸 宇宙' },
];
let MODE = 'real';
try {
  const m = localStorage.getItem('iseharaVisualMode');
  if (VISUAL_MODES.some(v => v.id === m)) MODE = m;
} catch (e) {}
(function initModeBtn() {
  const btn = document.getElementById('modeBtn');
  const idx = VISUAL_MODES.findIndex(v => v.id === MODE);
  const [icoText, ...labelParts] = VISUAL_MODES[idx].label.split(' ');
  document.getElementById('modeIco').textContent = icoText;
  document.getElementById('modeSub').textContent = labelParts.join(' ');
  btn.addEventListener('click', () => {
    const next = VISUAL_MODES[(idx + 1) % VISUAL_MODES.length].id;
    try {
      localStorage.setItem('iseharaVisualMode', next);
      // 現在位置と向きを保存 → リロード後の loadOSM がここから再開する(スポーンに戻さない)
      const ll = xzToLatLon(player.position.x, player.position.z);
      localStorage.setItem('iseharaResumePos',
        JSON.stringify({ lat: ll.lat, lon: ll.lon, yaw: camYaw, rot: player.rotation.y }));
    } catch (e) {}
    location.reload();
  });
})();

// モード切替リロード用の再開位置(1回読んだら消す — 通常リロードは従来どおりスポーン地点)
function consumeResumePos() {
  try {
    const s = localStorage.getItem('iseharaResumePos');
    if (!s) return null;
    localStorage.removeItem('iseharaResumePos');
    const p = JSON.parse(s);
    if (typeof p.lat === 'number' && typeof p.lon === 'number') return p;
  } catch (e) {}
  return null;
}
// モード別の環境パレット
const MODE_CONF = {
  real: {
    fog: 0x3080b0, ambient: 0x9070d0, ambInt: 2.5, moon: 0xd0c0ff,
    sky: ['#0a2a60', '#1a5090', '#3090c0', '#80d0f0'], glow: 'rgba(200,100,50,0.5)',
    water: 0x2277bb, lawn: 0x4a8a3d, roadMinor: 0xe8e8e8, windowC: 0xffee88,
  },
  meiji: { // 明治(迅速測図)— 落ち着いた自然色・薄暮
    fog: 0x8a9a88, ambient: 0xb8b8a0, ambInt: 2.4, moon: 0xe8dcc0,
    sky: ['#1a2a3a', '#3a5a6a', '#7a9a8a', '#d8c8a0'], glow: 'rgba(220,170,90,0.45)',
    water: 0x3a6a8a, lawn: 0x5a7a3a, roadMinor: 0x907a55, windowC: 0xffcc77,
  },
  edo: { // セピア・和
    fog: 0x8a7a5a, ambient: 0xc0a878, ambInt: 2.3, moon: 0xffe8c0,
    sky: ['#2a2018', '#4a3a28', '#7a6040', '#c8a870'], glow: 'rgba(255,180,80,0.5)',
    water: 0x4a7a8a, lawn: 0x6a7a40, roadMinor: 0xcabc9a, windowC: 0xffd890,
  },
  marchen: { // 明るいパステル
    fog: 0x88c8e8, ambient: 0xd0c0f0, ambInt: 3.2, moon: 0xfff0d0,
    sky: ['#3a70c8', '#5a9ae0', '#90c8f0', '#ffd8e8'], glow: 'rgba(255,160,220,0.6)',
    water: 0x55ccff, lawn: 0x66d060, roadMinor: 0xf2e2e8, windowC: 0xfff0a0,
  },
  space: { // 宇宙コロニー
    fog: 0x0a0e1a, ambient: 0x8090c0, ambInt: 2.2, moon: 0xa0c0ff,
    sky: ['#000006', '#01020e', '#040820', '#0a1030'], glow: 'rgba(80,120,255,0.35)',
    water: 0x113355, lawn: 0x3a4450, roadMinor: 0x556070, windowC: 0x66eeff,
  },
}[MODE];
const IS_MEIJI = MODE === 'meiji';
// 江戸: 当時の実測地図データが無いため、明治期(迅速測図)土地利用データを近似として流用する。
// (現代のOSM建物をそのまま使うと、明治より江戸の方が高層建築だらけになってしまうため)
const USES_MEIJI_LANDUSE = IS_MEIJI || MODE === 'edo';
// 明治期土地利用データの出典表記(CC BY 4.0 の帰属表示。江戸モードでも同データを使うため表示する)
if (USES_MEIJI_LANDUSE) {
  const cr = document.getElementById('credit');
  cr.style.display = 'block';
  cr.innerHTML = '明治期土地利用: 出典 <a href="https://habs.rad.naro.go.jp/" target="_blank" style="color:#cdb">農研機構農業環境研究部門</a>(迅速測図・CC BY 4.0)'
    + (MODE === 'edo' ? '<br>※江戸期の実測地図が無いため、明治期データを近似として使用しています' : '');
}

// ======= SCENE SETUP =======
const canvas = document.getElementById('canvas');
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.setSize(window.innerWidth, window.innerHeight);
// 影を無効化 — 3000m範囲を1024pxで描く影は約3m/texelでほぼ視認できず、
// シャドウパスで全建物を毎フレーム二重描画するコストだけが残るため
renderer.shadowMap.enabled = false;
renderer.toneMapping = THREE.ACESFilmicToneMapping;
renderer.toneMappingExposure = 0.9;

const scene = new THREE.Scene();
// フォグ: 高密度モード(明治以外)は生成半径を狭めた分だけ濃くして、ポップインを隠す。
// 宇宙は大気(=光の散乱)が無い設定なので、遠くまでくっきり見えるようフォグをごく薄くする。
const WORLD_FOG = new THREE.FogExp2(MODE_CONF.fog, MODE === 'meiji' ? 0.0004 : MODE === 'space' ? 0.00008 : 0.00056); // 毎フレーム new しない(GC対策)
scene.fog = WORLD_FOG;

// 宇宙は遠景メッシュ(半径6km)がカバーする範囲まで見えるよう視界を伸ばす(他モードは従来通り)
const camera = new THREE.PerspectiveCamera(75, window.innerWidth/window.innerHeight, 0.5, MODE === 'space' ? 5800 : 5000);

// ======= FANTASY SKY =======
// 半径はカメラの far(5000) より十分小さく。原点固定だったのをカメラ追従に変更
// (以前は原点から100m以上離れると球の反対側がfarクリップされ、マップジャンプで
//  球の外に出ると空が完全に消えていた)
let skyMesh = null, skyCanvas = null, skyCtx = null, skyTex = null;
function buildSky() {
  const geo = new THREE.SphereGeometry(4000, 32, 32);
  skyCanvas = document.createElement('canvas');
  skyCanvas.width = 512; skyCanvas.height = 512;
  skyCtx = skyCanvas.getContext('2d');
  const grad = skyCtx.createLinearGradient(0, 0, 0, 512);
  grad.addColorStop(0,   MODE_CONF.sky[0]);
  grad.addColorStop(0.4, MODE_CONF.sky[1]);
  grad.addColorStop(0.7, MODE_CONF.sky[2]);
  grad.addColorStop(1,   MODE_CONF.sky[3]);
  skyCtx.fillStyle = grad;
  skyCtx.fillRect(0,0,512,512);
  // Horizon glow
  const hgrad = skyCtx.createRadialGradient(256,512,0,256,512,300);
  hgrad.addColorStop(0, MODE_CONF.glow);
  hgrad.addColorStop(1, 'rgba(0,0,0,0)');
  skyCtx.fillStyle = hgrad;
  skyCtx.fillRect(0,0,512,512);
  skyTex = new THREE.CanvasTexture(skyCanvas);
  // fog:false — 半径4000ではFogExp2でほぼフォグ色に塗り潰されるため空はフォグ対象外に
  const mat = new THREE.MeshBasicMaterial({ map: skyTex, side: THREE.BackSide, fog: false, depthWrite: false });
  skyMesh = new THREE.Mesh(geo, mat);
  skyMesh.frustumCulled = false;
  skyMesh.renderOrder = -2; // 最初に背景として描画
  scene.add(skyMesh);

  // 宇宙モード: 地球と衛星を空に浮かべる(skyMeshの子なのでカメラ追従も自動)
  if (MODE === 'space') {
    const ec = document.createElement('canvas'); ec.width = 64; ec.height = 64;
    const eg = ec.getContext('2d');
    eg.fillStyle = '#1a55cc'; eg.fillRect(0, 0, 64, 64);
    eg.fillStyle = '#2a8a3a';
    for (let i = 0; i < 7; i++) { eg.beginPath(); eg.arc(Math.random()*64, Math.random()*64, 5+Math.random()*9, 0, 7); eg.fill(); }
    eg.fillStyle = 'rgba(255,255,255,0.7)';
    for (let i = 0; i < 9; i++) { eg.beginPath(); eg.arc(Math.random()*64, Math.random()*64, 3+Math.random()*7, 0, 7); eg.fill(); }
    const earth = new THREE.Mesh(new THREE.SphereGeometry(420, 24, 18),
      new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(ec), fog: false }));
    earth.position.set(1600, 1500, -2600);
    earth.frustumCulled = false;
    skyMesh.add(earth);
    const moon2 = new THREE.Mesh(new THREE.SphereGeometry(140, 16, 12),
      new THREE.MeshBasicMaterial({ color: 0xc8b8e8, fog: false }));
    moon2.position.set(-2200, 900, 1500);
    moon2.frustumCulled = false;
    skyMesh.add(moon2);
  }
}
buildSky();

// ======= STARS =======
// カメラ追従。sizeAttenuation:false にしないと距離3800では1px未満で見えない
let starMesh = null;
(function buildStars() {
  const geo = new THREE.BufferGeometry();
  // 宇宙モードは星を濃く、メルヘンは控えめに
  const count = MODE === 'space' ? 7000 : MODE === 'marchen' ? 1200 : 3000;
  const pos = new Float32Array(count * 3);
  for (let i = 0; i < count * 3; i += 3) {
    const phi = Math.random() * Math.PI * (MODE === 'space' ? 0.85 : 0.5);
    const theta = Math.random() * Math.PI * 2;
    const r = 3800;
    pos[i]   = r * Math.sin(phi) * Math.cos(theta);
    pos[i+1] = r * Math.cos(phi);
    pos[i+2] = r * Math.sin(phi) * Math.sin(theta);
  }
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3));
  const mat = new THREE.PointsMaterial({ color: 0xffffff, size: MODE === 'space' ? 2.2 : 1.6, sizeAttenuation: false, fog: false, transparent: true, opacity: 0.9 });
  starMesh = new THREE.Points(geo, mat);
  starMesh.frustumCulled = false;
  starMesh.renderOrder = -1;
  scene.add(starMesh);
})();

// ======= LIGHTS =======
const ambientLight = new THREE.AmbientLight(MODE_CONF.ambient, MODE_CONF.ambInt);
scene.add(ambientLight);
const moonLight = new THREE.DirectionalLight(MODE_CONF.moon, 1.8);
moonLight.position.set(-500, 1000, -300);
moonLight.castShadow = false;
moonLight.shadow.mapSize.set(1024, 1024);
moonLight.shadow.camera.near = 1;
moonLight.shadow.camera.far = 5000;
moonLight.shadow.camera.left = moonLight.shadow.camera.bottom = -1500;
moonLight.shadow.camera.right = moonLight.shadow.camera.top = 1500;
scene.add(moonLight);

// Warm torch point lights — 地形読み込み後に地表高さへ再配置する(下の loadElevations 参照)
const torchColors = [0xff6a00, 0xff8c40, 0xffaa60];
const torchLights = [];
for (let i = 0; i < 6; i++) {
  const pt = new THREE.PointLight(torchColors[i%3], 1.2, 300);
  pt.position.set(Math.random()*2000-1000, 4, Math.random()*2000-1000);
  scene.add(pt);
  torchLights.push(pt);
}

// ======= 実時間のデイナイト(朝・昼・夕方・夜) =======
// 実際の時刻から、空グラデーション・フォグ・光(太陽/月)・星の見え方を時間帯に連動させる。
// 宇宙モードは対象外(常に宇宙)。1分ごとに更新。
const _cA = new THREE.Color(), _cB = new THREE.Color();
function _lerpCss(a, b, t) { _cA.set(a); _cB.set(b); return _cA.lerp(_cB, t).getStyle(); }
function _lerpHex(a, b, t) { _cA.setHex(a); _cB.setHex(b); return _cA.lerp(_cB, t).getHex(); }
// キーフレーム: 0時=夜 / 6時=朝(夜明け) / 12時=昼 / 18時=夕方
const DAY_KF = [
  { sky:['#050a1e','#0a1836','#16244e','#2b4270'], glow:0x7c8cdc, glowA:0.22, fog:0x1a2848, sun:0xb9c4ff, sunInt:0.5, amb:0x3a4a7a, ambInt:1.05, star:1.0 },
  { sky:['#33406e','#8a6a90','#e6a878','#ffdca6'], glow:0xffaa5a, glowA:0.50, fog:0xb69a86, sun:0xffd2a0, sunInt:1.25,amb:0x9a8aa0, ambInt:1.75, star:0.12 },
  { sky:['#2a70c8','#4a95e0','#8fc4ef','#cfe8fb'], glow:0xfff0d2, glowA:0.30, fog:0x9fc4e0, sun:0xfff4e0, sunInt:2.3, amb:0xbcd0e6, ambInt:2.5, star:0.0 },
  { sky:['#1e2448','#6a3a68','#d0673c','#ffb060'], glow:0xff783c, glowA:0.50, fog:0xa86a56, sun:0xff9a58, sunInt:1.15,amb:0x8a6a80, ambInt:1.6, star:0.12 },
];
function applyTimeOfDay() {
  if (MODE === 'space') return; // 宇宙は常に宇宙
  const now = new Date();
  const h = now.getHours() + now.getMinutes() / 60; // 0..24
  const seg = Math.min(3, Math.floor(h / 6));
  const a = DAY_KF[seg], b = DAY_KF[(seg + 1) % 4];
  const t = (h - seg * 6) / 6;
  if (skyCtx && skyTex) {
    const sky = [0,1,2,3].map(i => _lerpCss(a.sky[i], b.sky[i], t));
    const grad = skyCtx.createLinearGradient(0, 0, 0, 512);
    grad.addColorStop(0, sky[0]); grad.addColorStop(0.4, sky[1]);
    grad.addColorStop(0.7, sky[2]); grad.addColorStop(1, sky[3]);
    skyCtx.fillStyle = grad; skyCtx.fillRect(0, 0, 512, 512);
    const glow = _lerpHex(a.glow, b.glow, t);
    const glowA = a.glowA + (b.glowA - a.glowA) * t;
    const r = (glow>>16)&255, g = (glow>>8)&255, bl = glow&255;
    const hg = skyCtx.createRadialGradient(256, 512, 0, 256, 512, 320);
    hg.addColorStop(0, `rgba(${r},${g},${bl},${glowA})`);
    hg.addColorStop(1, 'rgba(0,0,0,0)');
    skyCtx.fillStyle = hg; skyCtx.fillRect(0, 0, 512, 512);
    skyTex.needsUpdate = true;
  }
  WORLD_FOG.color.setHex(_lerpHex(a.fog, b.fog, t));
  ambientLight.color.setHex(_lerpHex(a.amb, b.amb, t));
  ambientLight.intensity = a.ambInt + (b.ambInt - a.ambInt) * t;
  moonLight.color.setHex(_lerpHex(a.sun, b.sun, t));
  moonLight.intensity = a.sunInt + (b.sunInt - a.sunInt) * t;
  // 太陽/月の位置(6時=東の地平, 12時=天頂, 18時=西の地平, 夜=地平下)
  const ang = (h - 6) / 12 * Math.PI, sy = Math.sin(ang);
  moonLight.position.set(Math.cos(ang) * 900, sy * 1000 + (sy < 0 ? -150 : 200), 300);
  const night = a.star + (b.star - a.star) * t; // 1=夜, 0=昼
  if (starMesh) starMesh.material.opacity = night;
  // 松明は夜だけ灯す(昼間に暖色の点光源が浮くのを防ぐ)
  torchLights.forEach(l => { l.intensity = 0.1 + night * 1.1; });
}
applyTimeOfDay();
setInterval(applyTimeOfDay, 60000); // 1分ごとに時間帯を更新

// ======= GROUND / TERRAIN =======
// Placeholder — actual terrain mesh is built after OSM_BOUNDS constants are defined
let terrainMesh = null; // set up after OSM constants

// ======= COLLISION BOXES =======
let collisionBoxes = [];

// 空間ハッシュグリッド — wouldCollide が全ボックスを線形走査していたため、
// カメラ遮蔽判定(毎フレーム約40回呼ぶ)と合わせて数万判定/フレームになっていた。
// 近傍セルのみの照合に変更して大幅軽量化。
const COLL_CELL = 60;
let collGrid = new Map();
function collGridAdd(box) {
  const x0 = Math.floor(box.min.x / COLL_CELL), x1 = Math.floor(box.max.x / COLL_CELL);
  const z0 = Math.floor(box.min.z / COLL_CELL), z1 = Math.floor(box.max.z / COLL_CELL);
  for (let gx = x0; gx <= x1; gx++) for (let gz = z0; gz <= z1; gz++) {
    const k = gx + ',' + gz;
    let arr = collGrid.get(k);
    if (!arr) { arr = []; collGrid.set(k, arr); }
    arr.push(box);
  }
}
function rebuildCollGrid() {
  collGrid = new Map();
  for (const b of collisionBoxes) collGridAdd(b);
}
let currentChunkKey = null; // generateChunk 実行中のみセット(アンロード時の掃除タグ)

// ======= MINIMAP DATA =======
let minimapBuildings = []; // {x,z,w,d,ck}
const minimapRoads = [];   // {x1,z1,x2,z2}
// 道路の空間ハッシュ — 「道路の上に木/建物を置かない」判定を高速化する(全道路の線形走査を避ける)。
// minimapRoads へ追加するたび addRoadRecord 経由でここにも登録する。
const ROAD_CELL = 40;
const roadGrid = new Map();
function roadGridAdd(r) {
  const pad = (r.rw || 4) / 2 + 3;
  const gx0 = Math.floor((Math.min(r.x1, r.x2) - pad) / ROAD_CELL), gx1 = Math.floor((Math.max(r.x1, r.x2) + pad) / ROAD_CELL);
  const gz0 = Math.floor((Math.min(r.z1, r.z2) - pad) / ROAD_CELL), gz1 = Math.floor((Math.max(r.z1, r.z2) + pad) / ROAD_CELL);
  for (let gx = gx0; gx <= gx1; gx++) for (let gz = gz0; gz <= gz1; gz++) {
    const k = gx + ',' + gz; let arr = roadGrid.get(k);
    if (!arr) { arr = []; roadGrid.set(k, arr); }
    arr.push(r);
  }
}
// minimapRoads.push の共通化: 記録と同時に空間グリッドへ登録
function addRoadRecord(r) { minimapRoads.push(r); roadGridAdd(r); }
// 矩形範囲にかかる可能性のある道路だけを空間ハッシュから拾う(minimapRoads全件走査を避ける)
function queryRoadGrid(x0, x1, z0, z1) {
  const gx0 = Math.floor(x0 / ROAD_CELL), gx1 = Math.floor(x1 / ROAD_CELL);
  const gz0 = Math.floor(z0 / ROAD_CELL), gz1 = Math.floor(z1 / ROAD_CELL);
  const seen = new Set(), out = [];
  for (let gx = gx0; gx <= gx1; gx++) for (let gz = gz0; gz <= gz1; gz++) {
    const arr = roadGrid.get(gx + ',' + gz);
    if (!arr) continue;
    for (const r of arr) { if (!seen.has(r)) { seen.add(r); out.push(r); } }
  }
  return out;
}

// ======= ポリゴン(避けエリア・landuse・水/公園/田畑メッシュ)用の汎用空間ハッシュ =======
// 【重要】これらは取得したタイル分だけ増え続けて一切減らないため、以前は
// generateChunk() や rebuildAreaPolysInBounds() が毎回配列を全件線形走査(filter)して
// いた。探索距離が伸びるほど1回あたりのコストが線形に悪化し、長時間プレイで
// 「移動を続けると徐々に重くなり最終的に落ちる」症状の主因の一つになっていた。
// ポリゴンは道路よりずっと広い範囲を覆うことがあるため、道路用より粗いセルを使う。
const POLY_CELL = 200;
function polyGridAdd(grid, entry) {
  const gx0 = Math.floor(entry.minX / POLY_CELL), gx1 = Math.floor(entry.maxX / POLY_CELL);
  const gz0 = Math.floor(entry.minZ / POLY_CELL), gz1 = Math.floor(entry.maxZ / POLY_CELL);
  for (let gx = gx0; gx <= gx1; gx++) for (let gz = gz0; gz <= gz1; gz++) {
    const k = gx + ',' + gz;
    let arr = grid.get(k);
    if (!arr) { arr = []; grid.set(k, arr); }
    arr.push(entry);
  }
}
function queryPolyGrid(grid, x0, x1, z0, z1) {
  const gx0 = Math.floor(x0 / POLY_CELL), gx1 = Math.floor(x1 / POLY_CELL);
  const gz0 = Math.floor(z0 / POLY_CELL), gz1 = Math.floor(z1 / POLY_CELL);
  const seen = new Set(), out = [];
  for (let gx = gx0; gx <= gx1; gx++) for (let gz = gz0; gz <= gz1; gz++) {
    const arr = grid.get(gx + ',' + gz);
    if (!arr) continue;
    for (const e of arr) { if (!seen.has(e)) { seen.add(e); out.push(e); } }
  }
  return out;
}

// 道路メッシュを、現在(呼び出し時点)の getGroundY に合わせて作り直す。
// 以前は道路メッシュを最初に生成した瞬間の地形高さで永久に固定していたため、
// 後からNEAR高解像度地形グリッドが届いて地形の高さが変わると、道路が地面に埋まったり
// 逆に浮いて見えたりしていた。ジオメトリだけ差し替え、Mesh自体・マテリアルは使い回す。
// 【重要】unloadFarRoadsで遠方アンロードされた道路(r.mesh===null)は、このタイミング
// (=プレイヤー付近のチャンクが生成された=近くまで戻ってきた)でメッシュを作り直して復元する。
function rebuildRoadMesh(r) {
  if (r.type === 'motorway') { if (r.mesh) rebuildMotorwayMesh(r); return; } // 高架はアンロード対象外(常にmesh有り)
  const geo = makeRoadGeo(r.x1, r.z1, r.x2, r.z2, r.rw, r.yOff);
  if (!geo) return;
  if (r.mesh) {
    r.mesh.geometry.dispose();
    r.mesh.geometry = geo;
  } else {
    const mesh = new THREE.Mesh(geo, r.mat);
    mesh.renderOrder = 1;
    scene.add(mesh);
    r.mesh = mesh;
  }
  // 非現実モードの線路(白帯オーバーレイ)も同じタイミングで復元/追従
  if (r.type === 'railway' && !IS_REAL) {
    const rg = makeRoadGeo(r.x1, r.z1, r.x2, r.z2, 1.5, 0.5);
    if (rg) {
      if (r.railWhite) {
        r.railWhite.geometry.dispose();
        r.railWhite.geometry = rg;
      } else {
        const rail = new THREE.Mesh(rg, ROAD_MAT.rail_white);
        rail.renderOrder = 2;
        scene.add(rail);
        r.railWhite = rail;
      }
    }
  }
}

// ======= 道路メッシュ生成のフレーム分割 =======
// 以前は addRoad が呼ばれた瞬間に makeRoadGeo(1mごとの地形サンプリング)+Mesh生成+scene.add
// を同期実行していた。密集市街地のOSMタイル(6枚バッチ)が届くと数千セグメントを1フレームで
// 生成することになり、数秒〜数十秒のフリーズの主因だった(東京都心で45秒超を確認)。
// → addRoad はレコード登録(軽量。isOnRoad判定・ミニマップは即座に正しく動く)だけ行い、
//   重いメッシュ生成はこのキューで1フレームあたり時間バジェット内だけ処理する。
const pendingRoadMeshes = [];
function queueRoadMesh(r) {
  if (r._q) return; // 二重投入防止
  r._q = true;
  pendingRoadMeshes.push(r);
}
function processRoadMeshQueue() {
  if (pendingRoadMeshes.length === 0) return;
  const t0 = performance.now();
  const px = player.position.x, pz = player.position.z;
  const lim2 = ROAD_UNLOAD_DIST * ROAD_UNLOAD_DIST;
  let i = 0;
  while (i < pendingRoadMeshes.length) {
    if ((i & 7) === 0 && performance.now() - t0 > 6) break; // 6ms/フレームまで
    const r = pendingRoadMeshes[i++];
    r._q = false;
    const mx = (r.x1 + r.x2) / 2 - px, mz = (r.z1 + r.z2) / 2 - pz;
    // 遠方(unloadFarRoadsの解放距離の外)はどうせすぐ解放されるので作らない。
    // プレイヤーが近づけばチャンク再生成(rebuildRoadsNearChunk)やNEAR更新
    // (rebuildRoadsInBounds)が再キューするので、恒久的に欠けることはない。
    if (mx * mx + mz * mz > lim2) { r._dirty = false; continue; }
    if (r.mesh && !r._dirty) continue; // 既に構築済みで地形も変わっていない
    rebuildRoadMesh(r);
    r._dirty = false;
  }
  pendingRoadMeshes.splice(0, i);
}

// 【重要】道路・線路は建物と違い、これまで距離に関係なく永久にscene・GPUメモリに
// 残り続けていた(1本ごとに専用ジオメトリのMeshをscene.addするだけで、チャンクアンロード
// でも消えない)。探索範囲が広がるほど道路メッシュが際限なく積み上がり、長時間移動を
// 続けるとGPUメモリ・描画コールが持たずに重くなって落ちる症状の主因になっていた。
// ここでは建物と違い、minimapRoads/roadGrid(=isOnRoad判定・ミニマップ・踏切検出が
// 恒久的に参照する軽量データ)自体は消さず、GPU側の重いMesh/ジオメトリだけを距離に応じて
// 破棄・復元する(復元は上のrebuildRoadMeshが、プレイヤーが近づいてチャンクが再生成される
// タイミングで自動的に行う)。高架(motorway)は橋脚がInstancedMeshで個別解放できないため
// 対象外とする(高速道路は本数が少なく、影響は小さい)。
const ROAD_UNLOAD_DIST = 2500;
let _roadUnloadFrame = 0;
function unloadFarRoads() {
  _roadUnloadFrame++;
  if (_roadUnloadFrame % 90 !== 0) return; // 建物と同様、毎フレームやる必要はない(~1.5秒ごと)
  const px = player.position.x, pz = player.position.z;
  const d2 = ROAD_UNLOAD_DIST * ROAD_UNLOAD_DIST;
  for (const r of minimapRoads) {
    if (r.type === 'motorway' || !r.mesh) continue; // 高架は対象外/既にアンロード済みはスキップ
    const mx = (r.x1 + r.x2) / 2, mz = (r.z1 + r.z2) / 2;
    const dx = mx - px, dz = mz - pz;
    if (dx * dx + dz * dz <= d2) continue; // まだ範囲内
    scene.remove(r.mesh);
    r.mesh.geometry.dispose();
    r.mesh = null;
    if (r.railWhite) {
      scene.remove(r.railWhite);
      r.railWhite.geometry.dispose();
      r.railWhite = null;
    }
  }
}

// 矩形範囲(ワールド座標)にかかる道路を、現在の地形に合わせてまとめて再構築する。
function rebuildRoadsInBounds(x0, x1, z0, z1) {
  const gx0 = Math.floor(x0 / ROAD_CELL), gx1 = Math.floor(x1 / ROAD_CELL);
  const gz0 = Math.floor(z0 / ROAD_CELL), gz1 = Math.floor(z1 / ROAD_CELL);
  const seen = new Set();
  for (let gx = gx0; gx <= gx1; gx++) for (let gz = gz0; gz <= gz1; gz++) {
    const arr = roadGrid.get(gx + ',' + gz);
    if (!arr) continue;
    for (const r of arr) {
      if (seen.has(r)) continue;
      seen.add(r);
      // 同期一括再構築(数百〜数千本)はNEAR更新のたびに大きなカクつきを生んでいたため、
      // フレーム分割キューに回す。_dirty=trueで「メッシュ生成済みでも作り直す」指定。
      r._dirty = true;
      queueRoadMesh(r);
    }
  }
}

// プレイヤー近くのチャンクが生成される(=このあたりの地形が最新・最高解像度で
// 揃っている)たびに呼び、そのチャンクにかかる道路だけ現在の地形に合わせて再構築する。
function rebuildRoadsNearChunk(chunkX, chunkZ) {
  const margin = 20; // 道幅ぶんの余裕
  const x0 = chunkX * CHUNK_SIZE - margin, x1 = chunkX * CHUNK_SIZE + CHUNK_SIZE + margin;
  const z0 = chunkZ * CHUNK_SIZE - margin, z1 = chunkZ * CHUNK_SIZE + CHUNK_SIZE + margin;
  rebuildRoadsInBounds(x0, x1, z0, z1);
  rebuildStationsInBounds(x0, x1, z0, z1); // 駅もY方向だけ地形に合わせて追従させる
  rebuildAreaPolysInBounds(x0, x1, z0, z1); // 川・公園・田畑ポリゴンも同じタイミングで合わせ直す
  rebuildBuildingsInBounds(x0, x1, z0, z1); // 建物もY方向だけ地形に合わせて追従させる
}
// 点(x,z)が、道路の中心線から (道幅/2 + extra) 以内にあるか(近傍セルだけ調べる)
function roadNear(x, z, extra) {
  const gx = Math.floor(x / ROAD_CELL), gz = Math.floor(z / ROAD_CELL);
  for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
    const arr = roadGrid.get((gx + dx) + ',' + (gz + dz));
    if (!arr) continue;
    for (const r of arr) {
      const ax = r.x2 - r.x1, az = r.z2 - r.z1, len2 = ax * ax + az * az;
      let tt = len2 > 0 ? ((x - r.x1) * ax + (z - r.z1) * az) / len2 : 0;
      tt = tt < 0 ? 0 : tt > 1 ? 1 : tt;
      const nx = r.x1 + ax * tt - x, nz = r.z1 + az * tt - z;
      const lim = (r.rw || 4) / 2 + extra;
      if (nx * nx + nz * nz < lim * lim) return true;
    }
  }
  return false;
}
// ======= 建物の高さresnap(地形更新への追従) =======
// 建物は道路と違い「壁+屋根+屋上設備+ライト」等の複数メッシュが絶対Y座標で
// 直置きされた剛体の集合。地形が変わっても形状自体は変えず、束ねて
// Y方向にだけ平行移動すれば大部分の浮き/埋まりは解消できる(道路のような
// ジオメトリ全再構築は不要)。ただし建物フットプリント内で傾斜が大きく
// 変化した場合は一律シフトだけでは片側だけ残ることがある(既知の限界。
// まずはこの方式で様子を見て、必要なら角ごとの微傾斜補正を検討する)。
const buildingRecords = []; // {x,z,w,d,h,style,gy,parts:[mesh/light,...],cbox,ck,bid}
let _buildingIdSeq = 0; // collisionBoxes/minimapBuildings/placedBuildingsから一括削除するための共通ID
const BUILDING_CELL = 80;
let buildingGrid = new Map();
function buildingGridAdd(rec) {
  const pad = Math.max(rec.w, rec.d) / 2 + 5;
  const gx0 = Math.floor((rec.x - pad) / BUILDING_CELL), gx1 = Math.floor((rec.x + pad) / BUILDING_CELL);
  const gz0 = Math.floor((rec.z - pad) / BUILDING_CELL), gz1 = Math.floor((rec.z + pad) / BUILDING_CELL);
  for (let gx = gx0; gx <= gx1; gx++) for (let gz = gz0; gz <= gz1; gz++) {
    const k = gx + ',' + gz;
    let arr = buildingGrid.get(k);
    if (!arr) { arr = []; buildingGrid.set(k, arr); }
    arr.push(rec);
  }
}
function rebuildBuildingGrid() {
  buildingGrid = new Map();
  for (const rec of buildingRecords) buildingGridAdd(rec);
}
// 1棟ぶんを現在の地形に合わせてY方向へ平行移動する(形状・ジオメトリは変えない)
function rebuildBuildingHeight(rec) {
  const hs = [
    getGroundY(rec.x, rec.z),
    getGroundY(rec.x - rec.w/2, rec.z - rec.d/2), getGroundY(rec.x + rec.w/2, rec.z - rec.d/2),
    getGroundY(rec.x - rec.w/2, rec.z + rec.d/2), getGroundY(rec.x + rec.w/2, rec.z + rec.d/2),
  ];
  const newGy = Math.min(...hs);
  const delta = newGy - rec.gy;
  if (Math.abs(delta) < 0.05) return; // 誤差レベルは無視(毎回全建物を動かさない)
  for (const p of rec.parts) { if (p) p.position.y += delta; }
  if (rec.cbox) { rec.cbox.min.y += delta; rec.cbox.max.y += delta; }
  rec.gy = newGy;
}
// 矩形範囲(ワールド座標)にかかる建物を、現在の地形に合わせてまとめて追従させる。
// 道路のrebuildRoadsInBoundsと同じタイミング(NEAR再取得時・チャンク生成時)で呼ぶ。
function rebuildBuildingsInBounds(x0, x1, z0, z1) {
  const gx0 = Math.floor(x0 / BUILDING_CELL), gx1 = Math.floor(x1 / BUILDING_CELL);
  const gz0 = Math.floor(z0 / BUILDING_CELL), gz1 = Math.floor(z1 / BUILDING_CELL);
  const seen = new Set();
  for (let gx = gx0; gx <= gx1; gx++) for (let gz = gz0; gz <= gz1; gz++) {
    const arr = buildingGrid.get(gx + ',' + gz);
    if (!arr) continue;
    for (const rec of arr) {
      if (seen.has(rec)) continue;
      seen.add(rec);
      rebuildBuildingHeight(rec);
    }
  }
}

// 【重要】実OSM建物(タイル取得・初期ロード由来)は、手続き生成のチャンク建物と違って
// 一度生成されると距離に関係なく永久にscene・collisionBoxes等に残り続けていた。
// 探索範囲が広がるほど建物数が際限なく増え、最終的に描画・メモリが持たずに
// 「移動を続けると徐々に重くなり落ちる」症状になっていた。
// ここでプレイヤーから一定距離を超えた実建物のTHREE.jsオブジェクトを解放する。
// ただし完全に忘れるのではなく、軽量な記述(x,z,w,d,h,style)だけpendingBuildingsへ
// 戻しておき、再訪時にNEAR準備が整えば通常の経路でまた生成されるようにする
// (手続き生成建物のチャンク・アンロード/再生成と同じ考え方)。
const BUILDING_UNLOAD_DIST = 2500;
let _buildingUnloadFrame = 0;
function unloadFarBuildings() {
  _buildingUnloadFrame++;
  if (_buildingUnloadFrame % 90 !== 0) return; // 毎フレームやる必要はない(~1.5秒ごと)
  if (buildingRecords.length === 0) return;
  const px = player.position.x, pz = player.position.z;
  const d2 = BUILDING_UNLOAD_DIST * BUILDING_UNLOAD_DIST;
  const removeIds = new Set();
  for (let i = buildingRecords.length - 1; i >= 0; i--) {
    const rec = buildingRecords[i];
    const dx = rec.x - px, dz = rec.z - pz;
    if (dx * dx + dz * dz <= d2) continue; // まだ範囲内
    for (const p of rec.parts) {
      if (!p) continue;
      scene.remove(p);
      if (p.geometry && !p.geometry.userData.shared) p.geometry.dispose();
    }
    removeIds.add(rec.bid);
    buildingRecords.splice(i, 1);
    // 再訪時に復元できるよう、軽量な記述だけキューへ戻す
    pendingBuildings.push({ x: rec.x, z: rec.z, w: rec.w, d: rec.d, h: rec.h, style: rec.style, real: rec.real });
  }
  if (removeIds.size === 0) return;
  collisionBoxes = collisionBoxes.filter(b => !removeIds.has(b.buildingId));
  minimapBuildings = minimapBuildings.filter(b => !removeIds.has(b.bid));
  placedBuildings = placedBuildings.filter(b => !removeIds.has(b.bid));
  rebuildCollGrid();
  rebuildBuildingGrid();
}

let placedBuildings = [];  // {x,z,r,ck} for landuse de-duplication
const landusePolygons = []; // {pts, lu, minX, maxX, minZ, maxZ} — stored during loadOSM for dynamic chunk generation
const landuseGrid = new Map(); // polyGridAdd/queryPolyGridで使う空間ハッシュ(全件走査を避ける)
const loadedChunks = new Set(); // "cx,cz" string keys of already-generated chunks
const chunkMeshes = new Map();  // "cx,cz" → [THREE.Mesh, ...] for unloading
const CHUNK_SIZE = 120;  // meters per chunk side
// 建物密度を大幅に上げた(ぎゅうぎゅうの日本の街並み)ため、生成半径は
// ±480m→±360mに縮小し、代わりにフォグを濃く(0.0004→0.00056)して
// ポップインが目立たない距離バランスを維持する。明治は低密度なので従来の±480mのまま
const CHUNK_RADIUS = USES_MEIJI_LANDUSE ? 4 : 3;

function pointInPolygon(px, pz, pts) {
  let inside = false;
  for (let i = 0, j = pts.length-1; i < pts.length; j=i++) {
    const xi=pts[i].x, zi=pts[i].z, xj=pts[j].x, zj=pts[j].z;
    if (((zi>pz)!==(zj>pz)) && (px < (xj-xi)*(pz-zi)/(zj-zi)+xi)) inside=!inside;
  }
  return inside;
}

function hasBuildingNearby(cx, cz, minDist) {
  const d2 = minDist*minDist;
  for (const b of placedBuildings) {
    const dx=cx-b.x, dz=cz-b.z;
    if (dx*dx+dz*dz < d2) return true;
  }
  return false;
}

// 「本物のOSM建物」が近くに実在するか(手続き生成分は含まない)。
// 農地・山道の道グリッドを住宅街と誤認する対策(denseAreaの裏付け条件に使う)。
// 家並みが実在するエリアなら、landuseタグが無くても実OSM建物が既にいくつか立っている。
function hasRealBuildingNearby(cx, cz, dist) {
  const d2 = dist * dist;
  const gx0 = Math.floor((cx - dist) / BUILDING_CELL), gx1 = Math.floor((cx + dist) / BUILDING_CELL);
  const gz0 = Math.floor((cz - dist) / BUILDING_CELL), gz1 = Math.floor((cz + dist) / BUILDING_CELL);
  for (let gx = gx0; gx <= gx1; gx++) for (let gz = gz0; gz <= gz1; gz++) {
    const arr = buildingGrid.get(gx + ',' + gz);
    if (!arr) continue;
    for (const rec of arr) {
      if (!rec.real) continue;
      const dx = rec.x - cx, dz = rec.z - cz;
      if (dx*dx + dz*dz < d2) return true;
    }
  }
  return false;
}

// hasRealBuildingNearbyの「一戸建て限定」版。landuseタグが無い(=luTypeAtがnullを返す)
// 場所でも、近くの本物のOSM建物が工場(industrial)などの非住宅用途だと分かっていれば、
// それを一戸建て補完(buildable)の根拠にしない。landuse=industrialのポリゴンが
// 描かれていない工場・倉庫の構内でも一戸建てが誤って並ぶのを防ぐための追加ガード。
function hasRealHouseNearby(cx, cz, dist) {
  const d2 = dist * dist;
  const gx0 = Math.floor((cx - dist) / BUILDING_CELL), gx1 = Math.floor((cx + dist) / BUILDING_CELL);
  const gz0 = Math.floor((cz - dist) / BUILDING_CELL), gz1 = Math.floor((cz + dist) / BUILDING_CELL);
  for (let gx = gx0; gx <= gx1; gx++) for (let gz = gz0; gz <= gz1; gz++) {
    const arr = buildingGrid.get(gx + ',' + gz);
    if (!arr) continue;
    for (const rec of arr) {
      if (!rec.real) continue;
      if (rec.style && (rec.style.type === 'industrial' || rec.style.type === 'shop')) continue;
      const dx = rec.x - cx, dz = rec.z - cz;
      if (dx*dx + dz*dz < d2) return true;
    }
  }
  return false;
}

// ======= PLAYER CHARACTER (少年/少女 選択可・普通の格好) =======
// 以前は魔法使い風(とんがり帽子・マント・杖・光る玉)だったが、素朴な少年/少女の
// 見た目に変更した(マント・杖・光る玉は削除、帽子は少年の短い髪に置き換え)。
const player = new THREE.Group();
scene.add(player);

// Body (シャツ) — 以前は足元まで届く長いローブで脚が隠れていたため、歩く/走るアニメーションを
// 見せられるよう丈を短くし、下に独立した脚パーツを追加した。
const bodyMat = new THREE.MeshLambertMaterial({ color: 0x3020a0 });
const body = new THREE.Mesh(new THREE.CylinderGeometry(0.30, 0.40, 0.9, 8), bodyMat);
body.position.y = 1.05;
body.castShadow = true;
player.add(body);

// Legs (歩く/走る/ジャンプのアニメーションで振る)
const legMat = new THREE.MeshLambertMaterial({ color: 0x24243a });
const leftLeg = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.14, 0.64, 8), legMat);
leftLeg.position.set(-0.15, 0.32, 0);
leftLeg.castShadow = true;
player.add(leftLeg);
const rightLeg = leftLeg.clone();
rightLeg.position.set(0.15, 0.32, 0);
player.add(rightLeg);
// Shoes
const shoeMat = new THREE.MeshLambertMaterial({ color: 0x1a1420 });
const leftShoe = new THREE.Mesh(new THREE.CylinderGeometry(0.15, 0.15, 0.12, 8), shoeMat);
leftShoe.position.set(-0.15, 0.06, 0.03);
player.add(leftShoe);
const rightShoe = leftShoe.clone();
rightShoe.position.set(0.15, 0.06, 0.03);
player.add(rightShoe);

// Head
const headMat = new THREE.MeshLambertMaterial({ color: 0xf5c8a0 });
const head = new THREE.Mesh(new THREE.SphereGeometry(0.28, 12, 12), headMat);
head.position.y = 1.65;
head.castShadow = true;
player.add(head);

// Hair(少年) — 短い髪(帽子ではなく地毛)
const hatMat = new THREE.MeshLambertMaterial({ color: 0x2a1c10 });
const hatBrim = new THREE.Mesh(new THREE.SphereGeometry(0.30, 12, 8, 0, Math.PI * 2, 0, Math.PI * 0.55), hatMat);
hatBrim.position.y = 1.68;
player.add(hatBrim);
const hatTop = new THREE.Mesh(new THREE.SphereGeometry(0.12, 8, 6), hatMat); // 前髪の房アクセント
hatTop.position.set(0, 1.83, 0.22);
hatTop.scale.set(1, 0.7, 0.8);
player.add(hatTop);

// Hair(少女) — 帽子の代わりにツインテールの髪型。既定では非表示(setCharacterSexで切替)
const girlHairMat = new THREE.MeshLambertMaterial({ color: 0x3a2210 });
const girlHairTop = new THREE.Mesh(new THREE.SphereGeometry(0.31, 12, 10), girlHairMat);
girlHairTop.position.set(0, 1.68, -0.03);
girlHairTop.scale.set(1.05, 1.05, 0.95);
player.add(girlHairTop);
const girlPonyL = new THREE.Mesh(new THREE.CylinderGeometry(0.09, 0.04, 0.55, 8), girlHairMat);
girlPonyL.position.set(-0.32, 1.45, 0.02);
girlPonyL.rotation.z = 0.35;
player.add(girlPonyL);
const girlPonyR = girlPonyL.clone();
girlPonyR.position.set(0.32, 1.45, 0.02);
girlPonyR.rotation.z = -0.35;
player.add(girlPonyR);

// Arms
const armMat = new THREE.MeshLambertMaterial({ color: 0x2818a0 });
const leftArm = new THREE.Mesh(new THREE.CylinderGeometry(0.1, 0.1, 0.7, 8), armMat);
leftArm.position.set(-0.42, 1.15, 0);
player.add(leftArm);
const rightArm = leftArm.clone();
rightArm.position.set(0.42, 1.15, 0);
player.add(rightArm);

player.position.set(0, 0, 0);

// ======= キャラクター選択(少年/少女) =======
// 帽子/髪型と服の色だけを切り替える(パーツ構成・アニメーションは共通)。
let charSex = 'boy';
function applyCharacterSex(sex) {
  charSex = sex;
  const isGirl = sex === 'girl';
  bodyMat.color.setHex(isGirl ? 0xe0448a : 0x3020a0);
  armMat.color.setHex(isGirl ? 0xc23a78 : 0x2818a0);
  // body.visible は setViewMode が管理する「一人称では非表示」の現在状態を反映している
  // (初期化時はTHREE.Meshの既定値どおりtrue)。これを見て一人称中に帽子/髪を誤って
  // 表示してしまわないようにする。
  hatBrim.visible = hatTop.visible = body.visible && !isGirl;
  girlHairTop.visible = girlPonyL.visible = girlPonyR.visible = body.visible && isGirl;
}
function setCharacterSex(sex) {
  applyCharacterSex(sex);
  try { localStorage.setItem('iseharaCharacterSex', sex); } catch (e) {}
  const boyBtn = document.getElementById('charBoyBtn'), girlBtn = document.getElementById('charGirlBtn');
  if (boyBtn) boyBtn.classList.toggle('active', sex === 'boy');
  if (girlBtn) girlBtn.classList.toggle('active', sex === 'girl');
}
(() => {
  let savedSex = 'boy';
  try { savedSex = localStorage.getItem('iseharaCharacterSex') || 'boy'; } catch (e) {}
  setCharacterSex(savedSex === 'girl' ? 'girl' : 'boy');
})();
