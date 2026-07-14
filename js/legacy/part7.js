/**
 * legacy/part7.js — index.html の巨大インラインスクリプトを行範囲のまま機械的に切り出した
 * ファイル(7/9)。part6.js の続き。詳細は part1.js 冒頭のコメント参照。
 */
// ======= REAL-WORLD COORDINATES =======
const gpsEl = document.getElementById('gpsDisplay');
let lastGpsUpdate = 0;

function xzToLatLon(x, z) {
  return { lat: MID_LAT - z / SCALE, lon: MID_LON + x / (SCALE * COS_LAT) };
}

// ======= 現在地の住所表示(市区町村+町名レベル)。移動中ずっと更新する =======
// Nominatim(OSMの逆ジオコーディング)を server/server.js 経由(/api/nominatim)で叩く。
// 公式ポリシー上、移動のたびに逐次リバースジオコーディングする使い方は
// 「reverse queries in a grid」に近く、頻度が高すぎると禁止行為(BAN対象)とみなされ得る。
// そのため、時間(約10秒)と移動距離(150m)の両方が閾値を超えたときだけ再取得する
// (「時々ふりかえって現在地を確認する」程度の頻度に抑える)。失敗時は前回の表示を維持する。
const addressEl = document.getElementById('addressDisplay');
let addrFetching = false, lastAddrX = null, lastAddrZ = null, _addrCheckFrame = 0;
// 建物の国別スタイル(getCountryBuildingProfile、part2.js)が参照する現在地の国コード。
// 住所表示と同じNominatim応答に相乗りするだけなので新規の通信は増やさない。
// 国境をまたいだ直後は次のcheckAddressDisplay更新(最大約10秒/150m)まで前の国のまま。
let currentCountryCode = null;
async function updateAddressDisplay() {
  if (addrFetching) return;
  addrFetching = true;
  try {
    const { lat, lon } = xzToLatLon(player.position.x, player.position.z);
    // 座標を丸めてプロキシ側のディスクキャッシュのヒット率を上げる(同じ町内を歩き回っても
    // キャッシュヒットで即応答になる)
    const url = `https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat.toFixed(4)}&lon=${lon.toFixed(4)}&zoom=18&addressdetails=1&accept-language=ja`;
    const res = await fetch(url);
    const j = await res.json();
    const a = (j && j.address) || {};
    const city = a.city || a.town || a.village || a.county || '';
    const area = a.suburb || a.neighbourhood || a.quarter || a.city_district || '';
    const text = [city, area].filter(Boolean).join('');
    if (addressEl) addressEl.textContent = text ? `📍 ${text}` : '📍 (住所不明)';
    if (a.country_code) currentCountryCode = a.country_code.toLowerCase();
  } catch (e) { /* 失敗時は前回表示のまま何もしない */ }
  addrFetching = false;
}
function checkAddressDisplay() {
  if (!initialWorldLoaded) return;
  _addrCheckFrame++;
  if (_addrCheckFrame % 600 !== 0) return; // ~10秒ごと(以前は45秒ごとで反映が遅く感じられたため短縮)
  if (lastAddrX !== null && Math.hypot(player.position.x - lastAddrX, player.position.z - lastAddrZ) < 150) return;
  lastAddrX = player.position.x; lastAddrZ = player.position.z;
  updateAddressDisplay();
}

// ======= MAP JUMP (Leaflet overlay) =======
let leafletMap = null, playerMarker = null;
const mapOverlay = document.getElementById('mapOverlay');
const mapHintEl = document.getElementById('mapHint');

// 指定の緯度経度へジャンプ(地図タップ・地名検索・現在地ボタンの共通処理)
function jumpToLatLon(toLat, toLon) {
  const pos = latLonToXZ(toLat, toLon);
  player.position.set(pos.x, 0, pos.z); // yはanimateの床追従が合わせる
  if (playerMarker) { playerMarker.setLatLng([toLat, toLon]); playerMarker.openPopup(); }
  if (leafletMap) leafletMap.setView([toLat, toLon], leafletMap.getZoom());
  // 遠景(FAR)グリッドの外へ飛んだら、その場を中心に地形を取り直す(富士山などでも地形・標高が出る)。
  // wideElevが未取得(初回ロードが失敗していた等)の場合もここで取得のきっかけになるようにする。
  if (!wideElev || Math.abs(pos.x - wideCX) > WIDE_W * 0.32 || Math.abs(pos.z - wideCZ) > WIDE_D * 0.32)
    loadWideTerrain(pos.x, pos.z);
  // マップジャンプは高確率でNEARグリッドの範囲外になるので、こちらは毎回無条件で取り直す
  // (範囲が狭く数秒〜十秒程度で終わるため、ジャンプ直後に足元の高解像度地形をすぐ用意できる)
  loadNearTerrain(pos.x, pos.z);
  // 【重要】国別建物スタイル(currentCountryCode)は通常、移動距離・時間の両方が閾値を超えた
  // 時だけ更新される(checkAddressDisplayのスロットル)。マップジャンプは一瞬で数百〜数千km
  // 移動するため、このスロットルを待つと「ジャンプ直後に生成される建物」が前の国のスタイルの
  // まま焼き込まれてしまう(後から国コードが更新されても既存の建物は再生成されない)。
  // ジャンプ時だけはスロットルを無視して即座に住所・国コードを取り直す。
  lastAddrX = pos.x; lastAddrZ = pos.z; // 直後の周期チェックでの二重取得を防ぐ
  updateAddressDisplay();
  setTimeout(() => mapOverlay.classList.remove('active'), 300);
}

function openMapJump() {
  mapOverlay.classList.add('active');
  mapHintEl.textContent = 'タップした場所にジャンプします';
  const { lat, lon } = xzToLatLon(player.position.x, player.position.z);

  if (!leafletMap) {
    leafletMap = L.map('leafletMap').setView([lat, lon], 16);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      attribution: '© OpenStreetMap'
    }).addTo(leafletMap);

    // Player marker
    const wizIcon = L.divIcon({ html: '🧙', className: '', iconSize: [28,28], iconAnchor:[14,14] });
    playerMarker = L.marker([lat, lon], { icon: wizIcon }).addTo(leafletMap)
      .bindPopup('現在地').openPopup();

    // Tap to jump
    leafletMap.on('click', e => jumpToLatLon(e.latlng.lat, e.latlng.lng));
  } else {
    playerMarker.setLatLng([lat, lon]);
    leafletMap.setView([lat, lon], leafletMap.getZoom());
    leafletMap.invalidateSize();
  }
}

document.getElementById('jumpBtn').addEventListener('click', openMapJump);
document.getElementById('mapCloseBtn').addEventListener('click', () => {
  mapOverlay.classList.remove('active');
});

// ======= 地名・住所・施設名の検索ジャンプ =======
// 国土地理院ジオコーディングAPI(無料・キー不要・CORS可)→ 失敗時は Nominatim にフォールバック
const mapSearchInput = document.getElementById('mapSearchInput');
async function searchPlaceJump() {
  const q = mapSearchInput.value.trim();
  if (!q) return;
  mapHintEl.textContent = '🔎 「' + q + '」を検索中...';
  let lat = null, lon = null, name = '';
  try {
    const res = await fetch('https://msearch.gsi.go.jp/address-search/AddressSearch?q=' + encodeURIComponent(q));
    const js = await res.json();
    if (Array.isArray(js) && js.length && js[0].geometry && js[0].geometry.coordinates) {
      lon = js[0].geometry.coordinates[0];
      lat = js[0].geometry.coordinates[1];
      name = (js[0].properties && js[0].properties.title) || q;
    }
  } catch (e) {}
  if (lat === null) { // フォールバック: Nominatim (OSM)
    try {
      const res = await fetch('https://nominatim.openstreetmap.org/search?format=json&limit=1&accept-language=ja&q=' + encodeURIComponent(q));
      const js = await res.json();
      if (Array.isArray(js) && js.length) {
        lat = parseFloat(js[0].lat);
        lon = parseFloat(js[0].lon);
        name = js[0].display_name || q;
      }
    } catch (e) {}
  }
  if (lat === null || !isFinite(lat) || !isFinite(lon)) {
    mapHintEl.textContent = '⚠️ 「' + q + '」が見つかりませんでした';
    return;
  }
  mapHintEl.textContent = '📍 ' + name + ' へジャンプ！';
  jumpToLatLon(lat, lon);
}
document.getElementById('mapSearchBtn').addEventListener('click', searchPlaceJump);
mapSearchInput.addEventListener('keydown', e => {
  e.stopPropagation(); // WASD移動のキー入力ハンドラに拾わせない
  if (e.key === 'Enter') searchPlaceJump();
});
mapSearchInput.addEventListener('keyup', e => e.stopPropagation());

// ======= スマホ等の位置情報から現在地ジャンプ =======
// Geolocation API は HTTPS(secure context)必須。LANのhttpアクセスでは使えない旨を案内する
document.getElementById('geoBtn').addEventListener('click', () => {
  if (!('geolocation' in navigator)) {
    mapHintEl.textContent = '⚠️ この端末・ブラウザは位置情報に対応していません';
    return;
  }
  if (!window.isSecureContext) {
    mapHintEl.textContent = '⚠️ 位置情報はHTTPS接続でのみ使えます(http://192.168.…などLAN経由では不可。Render等のhttps版でお試しを)';
    return;
  }
  mapHintEl.textContent = '📡 現在地を取得中...';
  navigator.geolocation.getCurrentPosition(
    p => {
      mapHintEl.textContent = '📍 現在地へジャンプ！';
      jumpToLatLon(p.coords.latitude, p.coords.longitude);
    },
    err => {
      mapHintEl.textContent = '⚠️ 現在地を取得できませんでした(' +
        (err.code === 1 ? '位置情報の利用が許可されていません' : err.message) + ')';
    },
    { enableHighAccuracy: true, timeout: 10000 });
});

function updateGPS(t) {
  if (uiHidden) return; // UI非表示中は更新不要
  if (t - lastGpsUpdate < 0.5) return;
  lastGpsUpdate = t;
  const { lat, lon } = xzToLatLon(player.position.x, player.position.z);
  const latStr = lat.toFixed(5), lonStr = lon.toFixed(5);
  // 標高: 地表のゲーム高さ(getGroundY)を実標高(m)へ逆算(= elevBase + h/ELEV_SCALE)
  const elevM = Math.round(elevBase + getGroundY(player.position.x, player.position.z) / ELEV_SCALE);
  gpsEl.href = `https://www.google.com/maps?q=${latStr},${lonStr}&z=17`;
  gpsEl.innerHTML = `📍 ${latStr}, ${lonStr}<br>⛰ 標高 ${elevM}m<br>🗺 Googleマップで開く`;
  if (leafletMap && playerMarker) playerMarker.setLatLng([lat, lon]);
}

// ======= CAMERA OCCLUSION =======
// If a building is between camera and player, pull camera closer
function occlusionCamPos(targetPos, playerPos) {
  const dir = new THREE.Vector3().subVectors(targetPos, playerPos);
  const dist = dir.length();
  dir.normalize();
  for (let d = 1.5; d < dist; d += 0.4) {
    const tp = playerPos.clone().addScaledVector(dir, d);
    if (wouldCollide(tp.x, tp.z, tp.y - 1.2)) {
      // Return a position just before the hit
      return playerPos.clone().addScaledVector(dir, Math.max(d - 0.8, 1.5));
    }
  }
  return targetPos;
}

// ======= SPAWN FINDER =======
// 指定地点が建物内なら、螺旋状に周囲を探して最寄りの空き地点に立たせる
function findSpawnNear(x0, z0) {
  // スポーン時点ではプレイヤーyが未設定のため、その地点の地面高さで判定する
  if (!wouldCollide(x0, z0, getGroundY(x0, z0))) return { x: x0, z: z0 };
  for (let r = 2; r <= 200; r += 2) {
    for (let a = 0; a < Math.PI * 2; a += Math.PI / 8) {
      const x = x0 + Math.cos(a) * r, z = z0 + Math.sin(a) * r;
      if (!wouldCollide(x, z, getGroundY(x, z))) return { x, z };
    }
  }
  return { x: x0, z: z0 };
}

// ======= CAMERA CONTROL =======
// viewMode: 0=三人称, 1=一人称, 2=上空
let viewMode = 0;
let camYaw = 0, camPitch = 0.25;
const camDist = 15, camHeight = 8; // meters
const viewBtnLabels = ['👁 一人称', '👁 三人称', '🗺 上空'];

function setViewMode(mode) {
  viewMode = mode % 3;
  const [icoText, ...labelParts] = viewBtnLabels[viewMode].split(' ');
  document.getElementById('viewIco').textContent = icoText;
  document.getElementById('viewSub').textContent = labelParts.join(' ');
  document.getElementById('viewBtn').classList.toggle('active', viewMode !== 2);
  document.getElementById('mapBtn').classList.toggle('active', viewMode === 2);
  const showBody = (viewMode !== 1); // hide body in first-person
  body.visible = leftArm.visible = rightArm.visible =
  head.visible = leftLeg.visible = rightLeg.visible =
  leftShoe.visible = rightShoe.visible = showBody;
  // 帽子/髪型は表示状態(showBody)と選択中の性別の両方を満たす時だけ見せる
  hatBrim.visible = hatTop.visible = showBody && charSex !== 'girl';
  girlHairTop.visible = girlPonyL.visible = girlPonyR.visible = showBody && charSex === 'girl';
}

document.getElementById('viewBtn').addEventListener('click', () => setViewMode(viewMode + 1));
document.getElementById('mapBtn').addEventListener('click', () => setViewMode(2));

// ======= MINIMAP =======
const minimapCanvas = document.getElementById('minimapCanvas');
const mctx = minimapCanvas.getContext('2d');
const MM = 200; // minimap size in px
const MM_RANGE = 200; // 200 meters radius visible on minimap

let _mmFrame = 0;
function drawMinimap() {
  if (uiHidden) return; // UI非表示中は2Dキャンバス描画ごと省略
  // 3フレームに1回だけ再描画(2Dキャンバス描画も無視できない負荷のため)
  if (++_mmFrame % 3 !== 0) return;
  mctx.clearRect(0,0,MM,MM);
  mctx.fillStyle = 'rgba(10,5,25,0.9)';
  mctx.fillRect(0,0,MM,MM);

  const px = player.position.x, pz = player.position.z;
  const scale = MM / (MM_RANGE * 2);

  function toMap(wx, wz) {
    return {
      mx: MM/2 + (wx - px) * scale,
      my: MM/2 + (wz - pz) * scale
    };
  }

  // Roads (color-coded by type)
  const mmRoadColor = { motorway:'#44bb44', trunk:'#ffcc00', primary:'#ffcc00', secondary:'#ffaa40', tertiary:'#aabbcc', railway:'#cc44ff', road:'#505878', water:'#3388cc' };
  const mmRoadWidth = { motorway:4, trunk:3, primary:2.5, secondary:2, tertiary:1.5, railway:2, road:1, water:2.5 };
  const R = MM_RANGE + 60; // 表示範囲外の要素は描画コマンド自体を発行しない

  // 実形状の水面ポリゴン(道路より下層に描く)
  // 【重要】以前はminimapWaterPolys/minimapRoads(取得済み全件。増え続けて減らない)を
  // 毎回全件走査していた。drawMinimapは間引いても約20fpsで呼ばれ続けるため、
  // 探索が進むほど1フレームあたりのコストが際限なく悪化していた
  // (長時間プレイでの重量化の主因の一つ)。空間ハッシュで表示範囲の近傍だけ拾う。
  mctx.fillStyle = '#2a6a9a';
  for (const wp of queryPolyGrid(minimapWaterGrid, px - R, px + R, pz - R, pz + R)) {
    if (wp.minX - px > R || px - wp.maxX > R || wp.minZ - pz > R || pz - wp.maxZ > R) continue;
    mctx.beginPath();
    const p0 = toMap(wp.pts[0].x, wp.pts[0].z);
    mctx.moveTo(p0.mx, p0.my);
    for (let i = 1; i < wp.pts.length; i++) {
      const p = toMap(wp.pts[i].x, wp.pts[i].z);
      mctx.lineTo(p.mx, p.my);
    }
    mctx.closePath();
    mctx.fill();
  }

  for (const r of queryRoadGrid(px - R, px + R, pz - R, pz + R)) {
    if ((r.x1-px > R && r.x2-px > R) || (px-r.x1 > R && px-r.x2 > R) ||
        (r.z1-pz > R && r.z2-pz > R) || (pz-r.z1 > R && pz-r.z2 > R)) continue;
    const t = r.type || 'road';
    mctx.strokeStyle = mmRoadColor[t] || '#505878';
    // 川は3D側の実幅をそのままミニマップスケールに変換(道路は視認性優先の固定幅)
    mctx.lineWidth = t === 'water' ? Math.max(1.5, (r.rw || 3) * scale) : (mmRoadWidth[t] || 1);
    const a = toMap(r.x1, r.z1), b = toMap(r.x2, r.z2);
    mctx.beginPath(); mctx.moveTo(a.mx, a.my); mctx.lineTo(b.mx, b.my); mctx.stroke();
  }

  // Buildings
  mctx.fillStyle = '#5a3a8a';
  for (const b of minimapBuildings) {
    if (Math.abs(b.x - px) > R || Math.abs(b.z - pz) > R) continue;
    const c = toMap(b.x, b.z);
    const bw = b.w * scale, bd = b.d * scale;
    mctx.fillRect(c.mx - bw/2, c.my - bd/2, bw, bd);
  }

  // Camera FOV cone (blue) — shows what the player sees on screen
  const fov = Math.PI / 2.5; // ~72° FOV
  mctx.save();
  mctx.translate(MM/2, MM/2);
  mctx.rotate(-camYaw); // camera view direction
  mctx.fillStyle = 'rgba(80, 200, 255, 0.18)';
  mctx.beginPath();
  mctx.moveTo(0, 0);
  const cr = MM / 2 - 4;
  mctx.arc(0, 0, cr, -Math.PI/2 - fov/2, -Math.PI/2 + fov/2);
  mctx.closePath();
  mctx.fill();
  // Camera direction tick
  mctx.strokeStyle = '#50c8ff';
  mctx.lineWidth = 1.5;
  mctx.beginPath(); mctx.moveTo(0, 0); mctx.lineTo(0, -10); mctx.stroke();
  mctx.restore();

  // Player arrow — arrowhead points in facing direction, feathers at back
  const py2 = player.rotation.y;
  mctx.save();
  mctx.translate(MM/2, MM/2);
  mctx.rotate(Math.PI - py2); // corrected: tip points in movement direction
  mctx.fillStyle = '#ff4040';
  mctx.strokeStyle = '#ffffff';
  mctx.lineWidth = 1;
  mctx.beginPath();
  // Arrowhead tip (up = forward)
  mctx.moveTo(0, -10);
  mctx.lineTo(5, -2);
  mctx.lineTo(2, -2);
  // Shaft
  mctx.lineTo(2, 5);
  // Right feather
  mctx.lineTo(5, 9);
  mctx.lineTo(0, 6);
  // Left feather
  mctx.lineTo(-5, 9);
  mctx.lineTo(-2, 5);
  mctx.lineTo(-2, -2);
  mctx.lineTo(-5, -2);
  mctx.closePath();
  mctx.fill();
  mctx.stroke();
  mctx.restore();

  // Range circle
  mctx.strokeStyle = 'rgba(160,100,255,0.3)';
  mctx.lineWidth = 1;
  mctx.beginPath();
  mctx.arc(MM/2, MM/2, MM/2-1, 0, Math.PI*2);
  mctx.stroke();
}

// ======= カメラ回転の向き / UI非表示モード =======
// 視点操作は「反転」が新デフォルト(CAM_DIR=+1)。🔄ボタンで従来の向き(-1)に戻せる
let CAM_DIR = 1;
try { if (localStorage.getItem('iseharaCamDir') === 'legacy') CAM_DIR = -1; } catch (e) {}
const camDirBtn = document.getElementById('camDirBtn');
function updateCamDirBtn() {
  camDirBtn.title = CAM_DIR === 1 ? '視点:反転' : '視点:標準';
  camDirBtn.classList.toggle('active', CAM_DIR === -1);
}
camDirBtn.addEventListener('click', () => {
  CAM_DIR = -CAM_DIR;
  try { localStorage.setItem('iseharaCamDir', CAM_DIR === -1 ? 'legacy' : 'inverted'); } catch (e) {}
  updateCamDirBtn();
});
updateCamDirBtn();

// UI非表示: スティック・ジャンプ・👁トグル以外を隠して景色を全画面で楽しむモード
let uiHidden = false;
try { uiHidden = localStorage.getItem('iseharaUIHidden') === '1'; } catch (e) {}
const uiToggleBtn = document.getElementById('uiToggleBtn');
function applyUIHidden() {
  document.body.classList.toggle('uiHidden', uiHidden);
  uiToggleBtn.textContent = uiHidden ? '👁' : '🙈';
}
uiToggleBtn.addEventListener('click', () => {
  uiHidden = !uiHidden;
  try { localStorage.setItem('iseharaUIHidden', uiHidden ? '1' : '0'); } catch (e) {}
  applyUIHidden();
});
applyUIHidden();

// ======= ロケーションカプセル(タップで座標・標高を展開) =======
if (addressEl && gpsEl) {
  addressEl.addEventListener('click', (e) => {
    e.stopPropagation();
    gpsEl.classList.toggle('open');
  });
}

// ======= 海面ポップオーバー(🌊タップで開閉、外側タップで閉じる) =======
const seaBtn = document.getElementById('seaBtn');
const seaCtrlEl = document.getElementById('seaCtrl');
if (seaBtn && seaCtrlEl) {
  seaBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    seaCtrlEl.classList.toggle('open');
    seaBtn.classList.toggle('active', seaCtrlEl.classList.contains('open'));
  });
}
document.addEventListener('click', () => {
  if (seaCtrlEl && seaCtrlEl.classList.contains('open')) {
    seaCtrlEl.classList.remove('open');
    seaBtn.classList.remove('active');
  }
  if (charCtrlEl && charCtrlEl.classList.contains('open')) {
    charCtrlEl.classList.remove('open');
    charBtn.classList.remove('active');
  }
  if (gpsEl && gpsEl.classList.contains('open')) gpsEl.classList.remove('open');
});

// ======= キャラクター選択ポップオーバー(🧍タップで開閉、外側タップで閉じる) =======
const charBtn = document.getElementById('charBtn');
const charCtrlEl = document.getElementById('charCtrl');
if (charBtn && charCtrlEl) {
  charBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    charCtrlEl.classList.toggle('open');
    charBtn.classList.toggle('active', charCtrlEl.classList.contains('open'));
  });
}
document.getElementById('charBoyBtn').addEventListener('click', (e) => { e.stopPropagation(); setCharacterSex('boy'); });
document.getElementById('charGirlBtn').addEventListener('click', (e) => { e.stopPropagation(); setCharacterSex('girl'); });

// ======= 操作ヘルプ: 初回のみ自動表示、以後は?ボタンから =======
const helpModal = document.getElementById('helpModal');
const helpBtn = document.getElementById('helpBtn');
const infoCloseBtn = document.getElementById('infoCloseBtn');
function openHelp() { helpModal.classList.add('active'); }
function closeHelp() { helpModal.classList.remove('active'); }
if (helpBtn) helpBtn.addEventListener('click', (e) => { e.stopPropagation(); openHelp(); });
if (infoCloseBtn) infoCloseBtn.addEventListener('click', (e) => { e.stopPropagation(); closeHelp(); });

// デプロイ日時の表示。server.js が index.html 配信時に window.__DEPLOY_INFO__ を注入する
// (Renderはデプロイのたびにプロセスを再起動するため、サーバ起動時刻=デプロイ日時として使える)。
// index.htmlをサーバ経由でなく直接開いた場合は注入されないため、その場合はその旨を表示する。
(() => {
  const el = document.getElementById('deployInfo');
  if (!el) return;
  const info = window.__DEPLOY_INFO__;
  if (!info || !info.time) {
    el.textContent = 'デプロイ日時: 取得できません(サーバ経由で開いてください)';
    return;
  }
  const fmt = (iso) => new Date(iso).toLocaleString('ja-JP', {
    timeZone: 'Asia/Tokyo', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit',
  });
  let txt = `🚀 デプロイ日時: ${fmt(info.time)}`;
  if (info.commit) {
    txt += ` (${info.commit}`;
    if (info.commitTime) txt += `, コミット: ${fmt(info.commitTime)}`;
    txt += ')';
  }
  el.textContent = txt;
})();

try {
  if (!localStorage.getItem('iseharaHelpSeen')) {
    openHelp();
    localStorage.setItem('iseharaHelpSeen', '1');
  }
} catch (e) { openHelp(); }

// ======= INPUT =======
const keys = {};
document.addEventListener('keydown', e => { keys[e.key.toLowerCase()] = true; });
document.addEventListener('keyup',   e => { keys[e.key.toLowerCase()] = false; });

// ======= JUMP STATE =======
// 押している間は上昇し続け、離すと重力で落下する(以前は押した瞬間だけ働く固定インパルスだった)。
let velY = 0, airborne = false, hopHeld = false;
const GRAVITY = -25;
const RISE_SPEED = 10;   // 押している間の上昇速度(m/s)。頭打ちなし: 押し続ける限り上昇し続ける
const hopBtn = document.getElementById('hopBtn');
// passive:false + preventDefault() で、長押し時にiOS/Androidのテキスト選択・コピー用
// 吹き出し(callout)やマウス選択カーソルが出るのを止める。これが出るとtouchend/mouseupが
// 途中で発火してhopHeldが意図せずfalseに戻り、上昇し続けられず上下動を繰り返していた。
hopBtn.addEventListener('touchstart', e => { e.preventDefault(); hopHeld = true; }, { passive: false });
hopBtn.addEventListener('touchend',   e => { e.preventDefault(); hopHeld = false; }, { passive: false });
hopBtn.addEventListener('touchcancel',e => { e.preventDefault(); hopHeld = false; }, { passive: false });
hopBtn.addEventListener('mousedown',  e => { e.preventDefault(); hopHeld = true; });
hopBtn.addEventListener('mouseup',    () => { hopHeld = false; });
hopBtn.addEventListener('mouseleave', () => { hopHeld = false; }); // 押したままボタン外へ出た場合も解除
hopBtn.addEventListener('contextmenu', e => e.preventDefault()); // 長押しでの右クリックメニュー/コールアウトも抑止
hopBtn.addEventListener('selectstart', e => e.preventDefault()); // 万一のテキスト選択開始も抑止
// Space: 押している間上昇し続け、離すと落下する
document.addEventListener('keydown', e => { if (e.key === ' ' && !e.repeat) hopHeld = true; });
document.addEventListener('keyup',   e => { if (e.key === ' ') hopHeld = false; });

// Mouse drag for camera
// 「地面や建物を指(カーソル)でつかんで動かす」感覚にするため、ドラッグしている位置が
// キャラより画面の上半分(空側=キャラより奥)か下半分(地面側=キャラより手前)かで、
// 左右ドラッグに対する視点の回る向きを反転させる(掴んだ場所がその指の動きに追従する
// イメージ。地面をつかんで左へ引けば視点も左へ、空をつかんで左へ引けば逆に視点は右へ)。
// 上下半分の判定はドラッグ中の現在位置ごとに毎回更新する(境界を跨いだらそこで切り替わる)。
let mouseDown = false, lastMouseX = 0, lastMouseY = 0;
canvas.addEventListener('mousedown', e => { mouseDown = true; lastMouseX = e.clientX; lastMouseY = e.clientY; });
canvas.addEventListener('mouseup',   () => { mouseDown = false; });
canvas.addEventListener('mousemove', e => {
  if (!mouseDown) return;
  const dragSign = (e.clientY < window.innerHeight / 2) ? -1 : 1; // 上半分なら反転
  // CAM_DIR=+1(新デフォルト)で従来と上下左右が反転した向きになる
  camYaw   += (e.clientX - lastMouseX) * 0.004 * CAM_DIR * dragSign;
  camPitch += (e.clientY - lastMouseY) * 0.003 * CAM_DIR;
  camPitch = Math.max(-0.2, Math.min(1.2, camPitch));
  lastMouseX = e.clientX; lastMouseY = e.clientY;
});

// ======= TOUCH CONTROLS (document-level, position-based) =======
const joystickKnob = document.getElementById('joystickKnob');
let joyActive = false, joyId = null, joyOx = 0, joyOz = 0;
let joyCenterX = 0, joyCenterY = 0;
let camTouchId = null, camLastX = 0, camLastY = 0;

// Joystick zone: bottom-left corner
function getJoyBounds() {
  const el = document.getElementById('joystick');
  const r = el.getBoundingClientRect();
  return { cx: r.left + r.width/2, cy: r.top + r.height/2, radius: r.width/2 + 30 };
}

// touchstart: passive:true so buttons still fire click events
document.addEventListener('touchstart', e => {
  for (const t of e.changedTouches) {
    if (t.target.closest('button, input, #mapOverlay')) continue; // ボタン・検索入力・マップ画面は通常動作
    const joy = getJoyBounds();
    const dx = t.clientX - joy.cx, dy = t.clientY - joy.cy;
    if (Math.sqrt(dx*dx+dy*dy) < joy.radius && joyId === null) {
      joyId = t.identifier; joyActive = true;
      joyCenterX = joy.cx; joyCenterY = joy.cy;
    } else if (camTouchId === null) {
      camTouchId = t.identifier; camLastX = t.clientX; camLastY = t.clientY;
    }
  }
}, { passive: true });

// touchmove: passive:false to prevent page scroll during gameplay
document.addEventListener('touchmove', e => {
  e.preventDefault();
  for (const t of e.changedTouches) {
    if (t.identifier === joyId) {
      const dx = t.clientX - joyCenterX;
      const dy = t.clientY - joyCenterY;
      const r2 = Math.sqrt(dx*dx+dy*dy);
      const maxR = 36; // 50pxでは端まで届きにくく最大速度が出なかった → 36pxで全開扱い
      const cx = r2 > maxR ? dx/r2*maxR : dx;
      const cy = r2 > maxR ? dy/r2*maxR : dy;
      joystickKnob.style.left = (50 + cx / 1.3) + '%'; // px→親幅130pxの%変換。全開(36px)でほぼ縁に届く
      joystickKnob.style.top  = (50 + cy / 1.3) + '%';
      joyOx = cx / maxR;
      joyOz = cy / maxR;
    } else if (t.identifier === camTouchId) {
      // 「地面や建物を指でつかんで動かす」感覚にするため、指の現在位置が画面の上半分
      // (空側)か下半分(地面側)かで左右ドラッグに対する視点の回る向きを反転させる
      const dragSign = (t.clientY < window.innerHeight / 2) ? -1 : 1; // 上半分なら反転
      // CAM_DIR=+1(新デフォルト)で従来と上下左右が反転した向きになる
      camYaw   += (t.clientX - camLastX) * 0.005 * CAM_DIR * dragSign;
      camPitch += (t.clientY - camLastY) * 0.004 * CAM_DIR;
      camPitch = Math.max(-0.3, Math.min(1.4, camPitch));
      camLastX = t.clientX; camLastY = t.clientY;
    }
  }
}, { passive: false });

document.addEventListener('touchend', e => {
  for (const t of e.changedTouches) {
    if (t.identifier === joyId) {
      joyActive = false; joyId = null; joyOx = 0; joyOz = 0;
      joystickKnob.style.left = '50%'; joystickKnob.style.top = '50%';
    }
    if (t.identifier === camTouchId) camTouchId = null;
  }
}, { passive: true });

document.addEventListener('touchcancel', () => {
  joyActive = false; joyId = null; joyOx = 0; joyOz = 0;
  joystickKnob.style.left = '50%'; joystickKnob.style.top = '50%';
  camTouchId = null;
});

// ======= COLLISION =======
const tempBox = new THREE.Box3();
const playerRadius = 0.25; // small radius so player fits on narrow roads

// yBase 省略時はプレイヤーの現在高さで判定。
// 【バグ修正】以前は y=0〜3 固定だったため、標高3m超の場所では建物AABB
// (地形標高から始まる)と一切交差せず、当たり判定が実質無効だった。
// 地面が平坦だった頃は偶然動いており、標高反映+ELEV_SCALE増で顕在化した。
function wouldCollide(nx, nz, yBase) {
  const y0 = (yBase !== undefined) ? yBase : player.position.y;
  tempBox.set(
    new THREE.Vector3(nx - playerRadius, y0 + 0.1, nz - playerRadius),
    new THREE.Vector3(nx + playerRadius, y0 + 2.4, nz + playerRadius)
  );
  // 空間グリッドで近傍セルのみ照合(ボックスは重なる全セルに登録済み)
  const x0 = Math.floor((nx - playerRadius) / COLL_CELL), x1 = Math.floor((nx + playerRadius) / COLL_CELL);
  const z0 = Math.floor((nz - playerRadius) / COLL_CELL), z1 = Math.floor((nz + playerRadius) / COLL_CELL);
  for (let gx = x0; gx <= x1; gx++) for (let gz = z0; gz <= z1; gz++) {
    const arr = collGrid.get(gx + ',' + gz);
    if (!arr) continue;
    for (const box of arr) if (box.intersectsBox(tempBox)) return true;
  }
  return false;
}

// その地点で立てる床の高さ(地形 or 足元以下にある建物の屋根の高い方)
function floorHeightAt(x, z, fromY) {
  let fy = getGroundY(x, z) + 0.35;
  const arr = collGrid.get(Math.floor(x / COLL_CELL) + ',' + Math.floor(z / COLL_CELL));
  if (arr) for (const b of arr) {
    if (x >= b.min.x && x <= b.max.x && z >= b.min.z && z <= b.max.z) {
      const top = b.max.y + 0.35;
      // 現在高さ+0.5以下の屋根だけを床候補に(下から突き上げない)
      if (b.max.y <= fromY + 0.5 && top > fy) fy = top;
    }
  }
  // 高速道路の桁(斜面)。Box3の積み重ねではなく2端点間の直線を数式で評価するので、
  // 登り坂でも段差・ガタつきが出ない(常になめらかな1本の斜面として高さが決まる)。
  for (const sl of motorwaySlopes) {
    const dx = x - sl.x1, dz = z - sl.z1;
    const along = dx * sl.nx + dz * sl.nz;
    if (along < 0 || along > sl.len) continue;
    const across = dx * -sl.nz + dz * sl.nx; // 左右perpendicular成分
    if (Math.abs(across) > sl.hw + 0.3) continue;
    const deckY = sl.y1 + (sl.y2 - sl.y1) * (along / sl.len);
    if (deckY <= fromY + 0.5) {
      const top = deckY + 0.35;
      if (top > fy) fy = top;
    }
  }
  return fy;
}
