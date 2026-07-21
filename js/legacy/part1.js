/**
 * legacy/part1.js — index.html の巨大インラインスクリプトを、挙動を変えずに
 * 行範囲のまま機械的に切り出した最初のファイル(1/9)。
 * ロジックの再編・命名整理は行っていない。読み込み順は元のコードと同一を維持する必要がある
 * (classic scriptなのでグローバルスコープを共有し、宣言順に依存しているため)。
 */
// ======= UI言語(日本語⇔English)切替 =======
// 【2026-07-22】設定パネルからUI言語を切り替えられるようにする(ユーザー要望)。
// classic script(モジュールバンドラ不使用)で index.html の <script> タグ順に
// 全part.jsがグローバルスコープを共有しているため、辞書・t()・setLang()・applyI18n()は
// 最初に読み込まれるこのファイルの冒頭で定義し、他の全part.jsから素朴に参照できるようにする。
// 絵文字は言語に関わらず視認性のため残す(辞書の値自体に絵文字を含めて持つ)。
const I18N = {
  ja: {
    // ---- 静的UI(index.html) ----
    addrLoading: '📍 現在地を取得中...',
    addrUnknown: '📍 (住所不明)',
    gpsLoading: '📍 座標取得中...',
    viewBtnTitle: '視点切替(三人称→一人称→上空)',
    viewThird: '👁 三人称',
    viewFirst: '👁 一人称',
    viewTop: '🗺 上空',
    jumpBtnTitle: 'マップジャンプ',
    modeBtnTitle: '時代モード',
    modeReal: '🏙 現実',
    modeMeiji: '🌾 明治',
    modeEdo: '🏯 江戸',
    modeMarchen: '🍭 メルヘン',
    modeSpace: '🛸 宇宙',
    perfBtnTitle: '設定(描写・海面・時間帯・キャラクター・視点)',
    helpBtnTitle: '操作ヘルプ',
    perfSectionTitle: '⚙ 描写範囲・負荷(変更すると再読み込みします)',
    perfLite: '🌱 軽量',
    perfStd: '⚖️ 標準',
    perfHigh: '🏙 高品質',
    perfLiteSub: '軽量',
    perfStdSub: '標準',
    perfHighSub: '高品質',
    perfDesc1: '軽量: 建物1.4km/低負荷(スマホ向け)<br>標準: 建物2.2km<br>高品質: 建物4.2km/先読み拡大(高性能PC向け・メモリ大)',
    cleanupNowBtn: '🧹 今すぐ整理',
    cleanupDesc: '現在地周辺以外の道路・建物・公園/水面等のGPUメッシュを解放します(記録は残るので再訪すれば元通り。長時間プレイで重くなってきたら押してください)',
    debugTileBtn: '🩺 タイル状況',
    debugTileDesc: 'デバッグ用: 周囲のOSMタイルごとの取得・生成状況を色分け表示します(灰=未取得 赤=取得中 青=地形待ち 橙=生成中 緑=完了)',
    seaLevelLabel: '🌊 海面の高さ',
    timeSectionTitle: '🕐 時間帯(手動固定)',
    timeAuto: '🕐 自動',
    timeMorning: '🌅 朝',
    timeNoon: '☀️ 昼',
    timeEvening: '🌇 夕',
    timeNight: '🌙 夜',
    timeAutoSub: '自動',
    timeMorningSub: '朝',
    timeNoonSub: '昼',
    timeEveningSub: '夕',
    timeNightSub: '夜',
    timeDesc: '昼に固定して建物の色を確認できます(紫っぽく見える場合の切り分けに)',
    charSectionTitle: '🧍 キャラクター',
    charBoy: '👦 少年',
    charGirl: '👧 少女',
    camDirSectionTitle: '🔄 視点回転の向き',
    camDirStandard: '標準',
    camDirInverted: '反転',
    uiToggleTitle: 'UI表示/非表示',
    mapHintDefault: 'タップした場所にジャンプします',
    mapSearchPlaceholder: '地名・住所・施設名で検索',
    mapSearchBtnLabel: '🔎 検索',
    geoBtnLabel: '📡 現在地',
    helpBody: 'PC: WASD移動 / Shiftダッシュ / Spaceジャンプ / ドラッグ回転 / Cで高度キープ切替<br>スマホ: 左スティック移動(倒すほど加速) / 右スワイプ回転 / ⤴ジャンプ / 🔓で高度キープ切替',
    closeBtn: '閉じる',
    statusInitial: '🗺 伊勢原マップ読み込み中...',
    debugLegendHtml: '🩺左から地形/道路線路/建物の3本<span style="background:#555555"></span>未取得<span style="background:#3388dd"></span>待ち<span style="background:#dd3333"></span>取得中<span style="background:#ffaa22"></span>生成中<span style="background:#33cc55"></span>完了<span style="background:#9b3fd4"></span>諦め(未着)',
    altKeepTitleOff: '高度キープ(空中でタップ)',
    altKeepTitleOn: '高度キープ中(タップで解除)',
    // ---- 動的メッセージ(part4/6/7/8.js) ----
    mapHintJumpTo: '📍 {name} へジャンプ！',
    mapHintSearching: '🔎 「{q}」を検索中...',
    mapHintNotFound: '⚠️ 「{q}」が見つかりませんでした',
    mapHintGeoUnsupported: '⚠️ この端末・ブラウザは位置情報に対応していません',
    mapHintGeoHttpsOnly: '⚠️ 位置情報はHTTPS接続でのみ使えます(http://192.168.…などLAN経由では不可。Render等のhttps版でお試しを)',
    mapHintGeoFetching: '📡 現在地を取得中...',
    mapHintGeoJump: '📍 現在地へジャンプ！',
    mapHintGeoFailed: '⚠️ 現在地を取得できませんでした({reason})',
    geoPermissionDenied: '位置情報の利用が許可されていません',
    gpsElevation: '標高 {elev}m',
    gpsOpenGoogleMaps: 'Googleマップで開く',
    meijiLanduseLabel: '明治期土地利用',
    meijiLanduseEdoLabel: '明治期データを江戸期の近似として',
    meijiLoadingToast: '{label}データ取得中...',
    meijiLoadedToast: '{label} {count} 地点読込',
    terrainLoadingRegion: '🏔 この地域の地形を取得中...',
    terrainApplied: '🏔 地形反映完了',
    terrainFarFailRetry: '⚠️ 遠景の地形取得に失敗しています(自動で再試行中)',
    terrainFarGiveUp: '⚠️ 遠景データを取得できません(平坦な遠景のまま続行します)',
    mapLoadingToast: '🗺 マップを読み込み中...',
    cleanupDoneToast: '🧹 現在地周辺以外を整理しました(ジオメトリ {before} → {after})',
    mapShownToast: '✨ マップを表示しました',
    mapPartialFailToast: '⚠️ 地図取得が一部失敗しました(背景で再試行を続けます)',
    meijiCreditBase: '明治期土地利用: 出典 <a href="https://habs.rad.naro.go.jp/" target="_blank" style="color:#cdb">農研機構農業環境研究部門</a>(迅速測図・CC BY 4.0)',
    meijiCreditEdoNote: '<br>※江戸期の実測地図が無いため、明治期データを近似として使用しています',
    deployInfoUnavailable: 'デプロイ日時: 取得できません(サーバ経由で開いてください)',
    deployInfoLine: '🚀 デプロイ日時: {time}',
    deployInfoCommitSuffix: ', コミット: {time}',
  },
  en: {
    // ---- 静的UI(index.html) ----
    addrLoading: '📍 Locating you...',
    addrUnknown: '📍 (Unknown location)',
    gpsLoading: '📍 Fetching coordinates...',
    viewBtnTitle: 'Switch view (3rd person to 1st person to top-down)',
    viewThird: '👁 3rd Person',
    viewFirst: '👁 1st Person',
    viewTop: '🗺 Top-down',
    jumpBtnTitle: 'Map jump',
    modeBtnTitle: 'Era mode',
    modeReal: '🏙 Real',
    modeMeiji: '🌾 Meiji',
    modeEdo: '🏯 Edo',
    modeMarchen: '🍭 Fairytale',
    modeSpace: '🛸 Space',
    perfBtnTitle: 'Settings (rendering, sea level, time of day, character, view)',
    helpBtnTitle: 'Controls help',
    perfSectionTitle: '⚙ Render distance & load (changing this reloads the page)',
    perfLite: '🌱 Light',
    perfStd: '⚖️ Standard',
    perfHigh: '🏙 High Quality',
    perfLiteSub: 'Light',
    perfStdSub: 'Standard',
    perfHighSub: 'High Quality',
    perfDesc1: 'Light: buildings 1.4km / low load (for phones)<br>Standard: buildings 2.2km<br>High Quality: buildings 4.2km / wider prefetch (for powerful PCs, uses more memory)',
    cleanupNowBtn: '🧹 Clean up now',
    cleanupDesc: 'Frees up GPU meshes for roads/buildings/parks/water away from your current location (records are kept, so revisiting restores them. Press this if things get heavy after a long play session)',
    debugTileBtn: '🩺 Tile status',
    debugTileDesc: 'Debug: color-codes the fetch/generation status of nearby OSM tiles (gray=not fetched, red=fetching, blue=waiting for terrain, orange=generating, green=done)',
    seaLevelLabel: '🌊 Sea level',
    timeSectionTitle: '🕐 Time of day (manual override)',
    timeAuto: '🕐 Auto',
    timeMorning: '🌅 Morning',
    timeNoon: '☀️ Noon',
    timeEvening: '🌇 Evening',
    timeNight: '🌙 Night',
    timeAutoSub: 'Auto',
    timeMorningSub: 'Morning',
    timeNoonSub: 'Noon',
    timeEveningSub: 'Evening',
    timeNightSub: 'Night',
    timeDesc: 'Fix the time to noon to check building colors (useful if buildings look purplish)',
    charSectionTitle: '🧍 Character',
    charBoy: '👦 Boy',
    charGirl: '👧 Girl',
    camDirSectionTitle: '🔄 Camera rotation direction',
    camDirStandard: 'Standard',
    camDirInverted: 'Inverted',
    uiToggleTitle: 'Show/hide UI',
    mapHintDefault: 'Tap a location to jump there',
    mapSearchPlaceholder: 'Search by place, address, or facility name',
    mapSearchBtnLabel: '🔎 Search',
    geoBtnLabel: '📡 My location',
    helpBody: 'PC: WASD to move / Shift to dash / Space to jump / drag to rotate view / C to toggle altitude hold<br>Mobile: left stick to move (tilt further to speed up) / swipe right side to rotate view / ⤴ to jump / 🔓 to toggle altitude hold',
    closeBtn: 'Close',
    statusInitial: '🗺 Loading Isehara map...',
    debugLegendHtml: '🩺From left: terrain / road+rail / building<span style="background:#555555"></span>not fetched<span style="background:#3388dd"></span>waiting<span style="background:#dd3333"></span>fetching<span style="background:#ffaa22"></span>generating<span style="background:#33cc55"></span>done<span style="background:#9b3fd4"></span>gave up (unreached)',
    altKeepTitleOff: 'Altitude hold (tap while airborne)',
    altKeepTitleOn: 'Altitude hold on (tap to release)',
    // ---- 動的メッセージ(part4/6/7/8.js) ----
    mapHintJumpTo: '📍 Jumping to {name}!',
    mapHintSearching: '🔎 Searching for "{q}"...',
    mapHintNotFound: '⚠️ "{q}" was not found',
    mapHintGeoUnsupported: '⚠️ This device/browser does not support location services',
    mapHintGeoHttpsOnly: '⚠️ Location services require an HTTPS connection (will not work over LAN like http://192.168...; please try the https version, e.g. on Render)',
    mapHintGeoFetching: '📡 Fetching your location...',
    mapHintGeoJump: '📍 Jumping to your location!',
    mapHintGeoFailed: '⚠️ Could not get your location ({reason})',
    geoPermissionDenied: 'Location permission was denied',
    gpsElevation: 'Elevation {elev}m',
    gpsOpenGoogleMaps: 'Open in Google Maps',
    meijiLanduseLabel: 'Meiji-era land use',
    meijiLanduseEdoLabel: 'Meiji-era data (as an Edo-era approximation)',
    meijiLoadingToast: 'Loading {label} data...',
    meijiLoadedToast: '{label}: {count} points loaded',
    terrainLoadingRegion: '🏔 Loading terrain for this area...',
    terrainApplied: '🏔 Terrain updated',
    terrainFarFailRetry: '⚠️ Failed to fetch distant terrain (retrying automatically)',
    terrainFarGiveUp: '⚠️ Could not fetch distant terrain data (continuing with flat terrain)',
    mapLoadingToast: '🗺 Loading map...',
    cleanupDoneToast: '🧹 Cleaned up areas away from your current location (geometries {before} to {after})',
    mapShownToast: '✨ Map displayed',
    mapPartialFailToast: '⚠️ Some map data failed to load (retrying in the background)',
    meijiCreditBase: 'Meiji-era land use: source <a href="https://habs.rad.naro.go.jp/" target="_blank" style="color:#cdb">NARO Institute for Agro-Environmental Sciences</a> (Rapid Survey Maps, CC BY 4.0)',
    meijiCreditEdoNote: '<br>*No surveyed maps exist from the Edo era, so Meiji-era data is used as an approximation',
    deployInfoUnavailable: 'Deploy time: unavailable (please open via the server)',
    deployInfoLine: '🚀 Deploy time: {time}',
    deployInfoCommitSuffix: ', commit: {time}',
  },
};
let currentLang = 'ja';
try { currentLang = localStorage.getItem('iseharaLang') || 'ja'; } catch (e) {}
function t(key, vars) {
  let s = (I18N[currentLang] && I18N[currentLang][key]) || I18N.ja[key] || key;
  if (vars) for (const k in vars) s = s.split('{' + k + '}').join(vars[k]);
  return s;
}
function setLang(lang) {
  currentLang = lang;
  try { localStorage.setItem('iseharaLang', lang); } catch (e) {}
  applyI18n();
}
// data-i18n系属性を持つ全要素へ現在言語のテキストを反映し、続けて他part.jsが持つ
// 「現在の状態(視点モード・描写プリセット・視点回転向き・高度キープ等)依存で
// 中身が変わる動的ラベル」の再描画関数も呼ぶ(state依存のためdata-i18n属性の
// 一括置換だけではカバーできない)。該当スクリプトが未読み込みでも安全なようtypeof確認する。
function applyI18n() {
  document.documentElement.lang = currentLang;
  document.querySelectorAll('[data-i18n]').forEach(el => { el.textContent = t(el.getAttribute('data-i18n')); });
  document.querySelectorAll('[data-i18n-title]').forEach(el => { el.title = t(el.getAttribute('data-i18n-title')); });
  document.querySelectorAll('[data-i18n-placeholder]').forEach(el => { el.placeholder = t(el.getAttribute('data-i18n-placeholder')); });
  document.querySelectorAll('[data-i18n-html]').forEach(el => { el.innerHTML = t(el.getAttribute('data-i18n-html')); });
  if (typeof refreshModeLabel === 'function') refreshModeLabel();
  if (typeof refreshViewLabel === 'function') refreshViewLabel();
  if (typeof refreshPerfLabel === 'function') refreshPerfLabel();
  if (typeof updateCamDirBtn === 'function') updateCamDirBtn();
  if (typeof updateAltKeepBtn === 'function') updateAltKeepBtn();
  if (typeof updateLangButtons === 'function') updateLangButtons();
  if (typeof refreshMeijiCredit === 'function') refreshMeijiCredit();
  if (typeof refreshDeployInfo === 'function') refreshDeployInfo();
}

// Prevent default touch scroll everywhere
document.documentElement.style.touchAction = 'none';
document.body.style.touchAction = 'none';

// ======= 表示モード =======
// 地形・道路・当たり判定・ゲームロジックは全モード共通。見た目(マテリアル/ジオメトリ/環境色)のみ差し替える。
// 切替は localStorage に保存してリロード=ワールド全体をそのモードで再生成(最も安全な「チャンク再構築」)。
// 【2026-07-22】labelを「絵文字1個+i18nキー」に分解(UI言語切替対応)。
// 絵文字部分は言語に関わらず固定、テキスト部分だけt()で切り替える。
const VISUAL_MODES = [
  { id: 'real',    icon: '🏙', key: 'modeReal' },
  { id: 'meiji',   icon: '🌾', key: 'modeMeiji' },
  { id: 'edo',     icon: '🏯', key: 'modeEdo' },
  { id: 'marchen', icon: '🍭', key: 'modeMarchen' },
  { id: 'space',   icon: '🛸', key: 'modeSpace' },
];
let MODE = 'real';
try {
  const m = localStorage.getItem('iseharaVisualMode');
  if (VISUAL_MODES.some(v => v.id === m)) MODE = m;
} catch (e) {}
// 現在のMODEに応じたモードボタンのアイコン・ラベルを再描画する(言語切替時にも
// applyI18n()から呼ばれる。「今まさに画面に表示されている」状態依存ラベルのため)。
function refreshModeLabel() {
  const idx = VISUAL_MODES.findIndex(v => v.id === MODE);
  const icoEl = document.getElementById('modeIco'), subEl = document.getElementById('modeSub');
  if (icoEl) icoEl.textContent = VISUAL_MODES[idx].icon;
  if (subEl) subEl.textContent = t(VISUAL_MODES[idx].key);
}
(function initModeBtn() {
  const btn = document.getElementById('modeBtn');
  refreshModeLabel();
  btn.addEventListener('click', () => {
    const curIdx = VISUAL_MODES.findIndex(v => v.id === MODE);
    const next = VISUAL_MODES[(curIdx + 1) % VISUAL_MODES.length].id;
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
// 明治期土地利用データの出典表記(CC BY 4.0 の帰属表示。江戸モードでも同データを使うため表示する)。
// 言語切替中も「今まさに画面に表示されている」文言のため、関数化してapplyI18n()からも呼べるようにする。
function refreshMeijiCredit() {
  if (!USES_MEIJI_LANDUSE) return;
  const cr = document.getElementById('credit');
  if (!cr) return;
  cr.style.display = 'block';
  cr.innerHTML = t('meijiCreditBase') + (MODE === 'edo' ? t('meijiCreditEdoNote') : '');
}
refreshMeijiCredit();

// ======= SCENE SETUP =======
const canvas = document.getElementById('canvas');
// logarithmicDepthBuffer: 標準の深度バッファは近い場所(near付近)に精度が偏り、遠い/高い場所ほど
// 精度が急激に粗くなる。このゲームはnear=0.5〜far=5000(比が1万倍)と幅が広く、上空へ上昇して
// カメラ〜地形間の距離が伸びるほど、地形と海面のような近接した2枚のポリゴンがz-fighting
// (どちらが手前か毎フレーム入れ替わってちらつく)しやすくなる。対数深度バッファは全体に精度を
// 均等に配分するため、この「高度が上がるほどちらつきが悪化する」症状に直接効く。
const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, logarithmicDepthBuffer: true });
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
moonLight.castShadow = false; // 影は全体でrenderer.shadowMap.enabled=false(上記)なのでshadow.*設定は無意味 — CODE_REVIEW_20260717 P2で削除
scene.add(moonLight);

// Warm torch point lights — 地形読み込み後に地表高さへ再配置する(part6.js establishRegionBase 参照)
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
// 手動時間帯オーバーライド(⚙時間帯パネルから設定。part7.js参照)。
// nullなら実時刻(従来通り)。0/6/12/18で夜/朝/昼/夕の各キーフレームをそのまま固定表示する。
const TIME_OVERRIDE_H = { night: 0, morning: 6, noon: 12, evening: 18 };
let _timeOverrideH = null;
try {
  const savedT = localStorage.getItem('iseharaTimeOverride');
  if (savedT && TIME_OVERRIDE_H[savedT] != null) _timeOverrideH = TIME_OVERRIDE_H[savedT];
} catch (e) {}
function setTimeOverride(h) { _timeOverrideH = h; applyTimeOfDay(); }
function applyTimeOfDay() {
  if (MODE === 'space') return; // 宇宙は常に宇宙
  let h;
  if (_timeOverrideH != null) {
    h = _timeOverrideH;
  } else {
    const now = new Date();
    h = now.getHours() + now.getMinutes() / 60; // 0..24
  }
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
const roadRecords = [];   // {x1,z1,x2,z2}
// 道路の空間ハッシュ — 「道路の上に木/建物を置かない」判定を高速化する(全道路の線形走査を避ける)。
// roadRecords へ追加するたび addRoadRecord 経由でここにも登録する。
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
// 【2026-07-16】後から届いた道路・線路と重なっている既存建物を撤去する。
// 「地形→道路→建物」の順序ゲート(osmTilesReadyAround)には1つ穴があり、タイルが
// 4回失敗して「諦めてloaded扱い」になると道路ゼロのままゲートが通って建物が先に建つ。
// その後の背景リトライで道路データが届いた時、道路の上に建物が居座ったままになっていた
// (移動中の拡張生成で道路生成が追いつかないケースの正体)。道路レコード登録のタイミングで
// 重なる建物を検出し、手続き生成は削除・実建物は再キュー(今度は道路を知った状態で
// fitRealBuildingToRoadsが縮小 or 線路ならdrop)する。
function removeBuildingsOverlappingRoad(r) {
  if (r.type === 'water') return;
  if (buildingRecords.length === 0) return;
  const rhw = (r.rw || 5) / 2 + 0.5;
  const pad = 40; // 建物の半対角ぶんの探索余裕
  const gx0 = Math.floor((Math.min(r.x1, r.x2) - rhw - pad) / BUILDING_CELL);
  const gx1 = Math.floor((Math.max(r.x1, r.x2) + rhw + pad) / BUILDING_CELL);
  const gz0 = Math.floor((Math.min(r.z1, r.z2) - rhw - pad) / BUILDING_CELL);
  const gz1 = Math.floor((Math.max(r.z1, r.z2) + rhw + pad) / BUILDING_CELL);
  const removeIds = new Set();
  const seenB = new Set();
  for (let gx = gx0; gx <= gx1; gx++) for (let gz = gz0; gz <= gz1; gz++) {
    const arr = meshedBuildingGrid.get(gx + ',' + gz);
    if (!arr) continue;
    for (const rec of arr) {
      if (rec.bid == null || seenB.has(rec.bid)) continue;
      seenB.add(rec.bid);
      // 建物ローカル系で道路リボンとの重なり判定(part2.js fitRealBuildingToRoadsの
      // 線路最終チェックと同じ計算。_minAbsOverWindowはpart2.js定義、実行時参照)
      const c = Math.cos(rec.rot || 0), s = Math.sin(rec.rot || 0);
      const hw = rec.w / 2, hd = rec.d / 2;
      const ax = r.x1 - rec.x, az = r.z1 - rec.z, bx = r.x2 - rec.x, bz = r.z2 - rec.z;
      const au = ax * c - az * s, av = ax * s + az * c;
      const bu = bx * c - bz * s, bv = bx * s + bz * c;
      const du = bu - au, dv = bv - av;
      let overlap;
      if (Math.abs(du) >= Math.abs(dv)) {
        const vmin = _minAbsOverWindow(au, av, du, dv, hw + rhw);
        overlap = vmin !== null && vmin < hd + rhw;
      } else {
        const umin = _minAbsOverWindow(av, au, dv, du, hd + rhw);
        overlap = umin !== null && umin < hw + rhw;
      }
      if (!overlap) continue;
      for (const p of rec.parts) {
        if (!p || p.userData._released) continue; // 【2026-07-20・二重解放バグ修正】下記コメント参照
        p.userData._released = true;
        scene.remove(p);
        if (p.geometry && !p.geometry.userData.shared) p.geometry.dispose();
        if (p.material) releaseFacadeMat(p.material); // facadeMat以外は無害なno-op(part2.js参照)
      }
      removeIds.add(rec.bid);
      if (rec.real) {
        pendingBuildings.push({ x: rec.x, z: rec.z, w: rec.w, d: rec.d, h: rec.h,
          style: rec.style, real: true, rot: rec.rot }); // _fit無し→再fitされる
      }
    }
  }
  removeBuildingsByIds(removeIds);
}
// roadRecords.push の共通化: 記録と同時に空間グリッドへ登録
function addRoadRecord(r) { roadRecords.push(r); roadGridAdd(r); removeBuildingsOverlappingRoad(r); }
// 矩形範囲にかかる可能性のある道路だけを空間ハッシュから拾う(roadRecords全件走査を避ける)
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
// 座標(x,z)が属するlanduse区画の種別(residential/commercial/industrial/retail等)を返す
// (無ければnull)。generateChunk内のluTypeAtと同じ考え方だが、building=yesだけでタグ
// (サブタイプ)が無い大きな建物を住宅(マンション)/商業(オフィス)のどちらに寄せるか
// (part3.js classifyResidential)でも使う汎用版。
// 【重要】landusePolygonsはこのバッチ自身の分がまだ積まれていないことがある(part6.js
// PASS2=建物 → PASS3=landuseの順、part8.jsも建物パス→landuseパスの順のため)。
// その場合はnullを返し、呼び出し側は既存の既定動作(マンション扱い)にフォールバックする。
function landuseTypeAt(x, z) {
  const near = queryPolyGrid(landuseGrid, x - 1, x + 1, z - 1, z + 1);
  for (const p of near) {
    if (x < p.minX || x > p.maxX || z < p.minZ || z > p.maxZ) continue;
    if (pointInPolygon(x, z, p.pts)) return p.lu;
  }
  return null;
}

// 道路メッシュを、現在(呼び出し時点)の getGroundY に合わせて作り直す。
// 以前は道路メッシュを最初に生成した瞬間の地形高さで永久に固定していたため、
// 後からNEAR高解像度地形グリッドが届いて地形の高さが変わると、道路が地面に埋まったり
// 逆に浮いて見えたりしていた。ジオメトリだけ差し替え、Mesh自体・マテリアルは使い回す。
// 【重要】unloadFarRoadsで遠方アンロードされた道路(r.mesh===null)は、このタイミング
// (=プレイヤー付近のチャンクが生成された=近くまで戻ってきた)でメッシュを作り直して復元する。
function rebuildRoadMesh(r) {
  if (r.type === 'motorway') { if (r.mesh) rebuildMotorwayMesh(r); return; } // 高架はアンロード対象外(常にmesh有り)
  const geo = makeRoadGeo(r.x1, r.z1, r.x2, r.z2, r.rw, r.yOff, r.bridgeY);
  if (!geo) return;
  // 橋区間: 見た目のジオメトリと同じタイミングで「乗れる床」(bridgeSlopes)も
  // 同じ高さへ更新する(bridgeSegmentYで両方が全く同じ式を使うため、見た目と
  // 足場が食い違うことはない)。これが無いと、地形が沈んで見えるのは直っても
  // 実際に立とうとすると当たり判定だけ古い/地形のままで下に沈み続ける不具合になる。
  if (r.bridgeY && r.slope) {
    const bh = bridgeSegmentY(r.bridgeY);
    r.slope.y1 = bh.yA; r.slope.y2 = bh.yB;
  }
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
  // 電柱・電線は撤去済み(2026-07-15。part2.js冒頭のコメント参照)。以前はここで
  // resnapWireSpan()を呼び、道路面と同じタイミングで電柱・電線を地形高さに追従させていた。
}

// ======= 新規投入分をプレイヤー近傍優先に並べ替える(2026-07-15) =======
// 【経緯】OSMタイル1バッチ(密集市街地だと建物・道路とも数千件)は、そのバッチ内では
// 単にOSMが返した順(=プレイヤー位置とは無関係)でpendingBuildings/pendingRoadMeshesに
// 積まれ、フレーム分割処理も配列の先頭からFIFOで消化するだけだった。タイル自体は近い順に
// 取得されるが(fetchOSMTileBatchのソート)、1タイル内の建物・道路の並びまでは近い順に
// なっていないため、密集地では「今プレイヤーが立っている場所」の建物・道路がバッチの
// 後方に埋もれ、生成が追いつかず地形・建物の「端」に行き当たる不具合につながっていた。
// バッチ全体を毎フレーム並べ替えるのはコストが大きいので、新規追加分(fromIdx以降)だけを
// 1回だけ、そのバッチが積まれた直後にプレイヤー位置を中心とした近い順へ並べ替える。
function sortNewEntriesByDistanceToPlayer(arr, fromIdx, getXZ) {
  if (fromIdx >= arr.length) return;
  const px = player.position.x, pz = player.position.z;
  const tail = arr.splice(fromIdx);
  tail.sort((a, b) => {
    const pa = getXZ(a), pb = getXZ(b);
    const da = (pa.x - px) * (pa.x - px) + (pa.z - pz) * (pa.z - pz);
    const db = (pb.x - px) * (pb.x - px) + (pb.z - pz) * (pb.z - pz);
    return da - db;
  });
  for (const t of tail) arr.push(t);
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
  // 【重要・2026-07-15】生成順序は地形→道路→建物のはずが、建物側(part9.js)だけ
  // バックログに応じて予算を最大80棟/フレームまで伸ばす可変制にしていた一方、道路は
  // 常に固定6ms/フレームのままだったため、混雑時は建物の方が道路より速く追いつき、
  // 道路が建物に追い抜かれて「道路だけ拡張が止まって見える」逆転が起きていた。
  // 道路側もバックログに応じて時間予算を伸ばし、常に建物より優先して追いつけるようにする。
  // 【2026-07-19】建物側(part9.js)には起動・ジャンプ直後30秒 or 現在地タイル未完了中の
  // 「初期ラッシュ」で予算を8ms→14msへ広げる仕組みがあるが、道路側には同種のブーストが
  // 無かった。生成順序は「地形→道路→建物」のはずなのに、ラッシュ中はむしろ道路の方が
  // 相対的に手薄になっていた(ユーザー報告: 道路・線路の生成が遅い)。同じ判定を使い、
  // ラッシュ中は上限を24ms→42msへ広げる(この間のコマ落ちは建物側ラッシュと同様に許容)。
  const _roadRush = performance.now() < 30000 || _curTileRush;
  const roadBudgetMs = Math.min(_roadRush ? 42 : 24, 6 + Math.floor(pendingRoadMeshes.length / 150));
  let i = 0;
  while (i < pendingRoadMeshes.length) {
    if ((i & 7) === 0 && performance.now() - t0 > roadBudgetMs) break;
    const r = pendingRoadMeshes[i++];
    r._q = false;
    const mx = (r.x1 + r.x2) / 2 - px, mz = (r.z1 + r.z2) / 2 - pz;
    // 遠方(unloadFarRoadsの解放距離の外)はどうせすぐ解放されるので作らない。
    // プレイヤーが近づけばチャンク再生成(rebuildRoadsNearChunk)やNEAR更新
    // (rebuildRoadsInBounds)が再キューするので、恒久的に欠けることはない。
    // 細街路(road/tertiary)はさらに短いMINOR_ROAD_MESH_DISTで切る(メッシュ総数対策)。
    const _rlim2 = isMinorRoadType(r.type) ? MINOR_ROAD_MESH_DIST * MINOR_ROAD_MESH_DIST : lim2;
    if (mx * mx + mz * mz > _rlim2) { r._dirty = false; continue; }
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
// ここでは建物と違い、roadRecords/roadGrid(=isOnRoad判定・ミニマップ・踏切検出が
// 恒久的に参照する軽量データ)自体は消さず、GPU側の重いMesh/ジオメトリだけを距離に応じて
// 破棄・復元する(復元は上のrebuildRoadMeshが、プレイヤーが近づいてチャンクが再生成される
// タイミングで自動的に行う)。高架(motorway)は橋脚がInstancedMeshで個別解放できないため
// 対象外とする(高速道路は本数が少なく、影響は小さい)。
// ======= 【2026-07-16】描写範囲・パフォーマンスプリセット =======
// ⚙ボタン(index.html #perfCtrl、切替処理はpart7.js)で3段階から選択。localStorageに保存し、
// リロードで反映(距離系はconstで各所に焼き込まれるため、モード切替と同じリロード方式)。
// 稼働環境(PCの性能・スマホ)に合わせてユーザー自身が選ぶ。既定は「標準」。
const PERF_PRESET = (() => {
  try {
    const v = localStorage.getItem('perfPreset');
    if (v === 'lite' || v === 'std' || v === 'high') return v; // ユーザーが⚙で明示的に選んだ設定を最優先
  } catch (e) {}
  // 【2026-07-20】iPhone(Chrome)で「標準」のまま数分でクラッシュするという報告への対応。
  // 標準プリセットは密集地でGPUメモリが数GBに達することがあり(下のPERF定義のコメント参照)、
  // PCでは耐えられてもiOS(Chromeも含め全ブラウザの中身はWebKitで、タブのメモリ上限が
  // デスクトップよりずっと厳しい)ではその前にタブごと落ちる。ユーザーが一度も⚙を
  // 触っていない初回起動時に限り、スマホ・タブレット相当の端末は「軽量」を既定にする
  // (上で明示的な保存値を最優先しているので、既に選択済みのユーザーには影響しない)。
  try {
    const ua = navigator.userAgent || '';
    const isMobile = /iPhone|iPad|iPod|Android|Mobile/i.test(ua) ||
      (navigator.maxTouchPoints > 1 && /Mac/i.test(navigator.platform || '')); // iPadOSはMac名乗りUAだがタッチあり
    if (isMobile) return 'lite';
  } catch (e) {}
  return 'std';
})();
const PERF = {
  //       道路メッシュ保持 / 実建物 生成・消去 / 手続きチャンク半径(×120m) / 森 / タイル先読み半径(×1600m)
  // 【2026-07-16】標準のbGenRealを3000→2200に調整。IndexedDBタイルキャッシュ導入後は
  // 東京駅級の密集地でも本当に全建物が届く(以前は429で実質フル密度に達していなかった)ため、
  // 3000mフル密度はメモリ超過でクラッシュした。広い描写が欲しい場合は高品質を選ぶ。
  // bMax: 描画済み建物の総数上限。【2026-07-16】東京駅・標準で「静止→フル密度生成→浮上」で
  // クラッシュする問題の最終対策。実測でgeometries 21k(地上・安定)→51k(生成完了後)まで
  // 増え続けてGPUメモリが2GB→6GBに達していた。距離だけでは密集地の総量を制御できないため、
  // 総数で天井を切る(超過分はdormantに退避し、移動で近くの枠が空いたら復帰)。
  // minorRoadDist: 細街路(type='road'/'tertiary')のメッシュ化・保持距離。【2026-07-16】実測で
  // 東京駅・標準の道路メッシュが70,513本(geometries 5万超・GPU数GBの主因)に達していた。
  // 細街路は遠距離ではフォグでほぼ見えないため、主要道路(secondary以上・線路・川)より
  // 短い距離で切ってメッシュ総数を数分の一に抑える(レコード自体は残るのでミニマップ・
  // isOnRoad判定・再接近時の復元は従来どおり機能する)。
  lite: { roadUnload: 1600, bGenReal: 1400, bUnloadReal: 2000, chunkR: 4,  forestR: 360, prefetchR: 2, bMax: 6000,  minorRoadDist: 700 },
  std:  { roadUnload: 2500, bGenReal: 2200, bUnloadReal: 2900, chunkR: 8,  forestR: 480, prefetchR: 2, bMax: 12000, minorRoadDist: 1100 },
  high: { roadUnload: 3200, bGenReal: 4200, bUnloadReal: 5200, chunkR: 10, forestR: 600, prefetchR: 3, bMax: 25000, minorRoadDist: 1600 },
}[PERF_PRESET];
const ROAD_UNLOAD_DIST = PERF.roadUnload;
const MINOR_ROAD_MESH_DIST = PERF.minorRoadDist;
// 【2026-07-20】未舗装(type:'unpaved'。part8.js参照)も細街路と同じ扱いにする。
// 舗装/未舗装で分岐する前は全て'road'だったため元々ここに含まれていた枠で、
// 分岐後にここを更新し忘れると農道・山道が幹線扱いの遠距離まで描画され続けてしまう。
const isMinorRoadType = (t) => t === 'road' || t === 'tertiary' || t === 'unpaved';
let _roadUnloadFrame = 0;
// force=true: 90フレーム周期を待たず即座に判定する(「今すぐ整理」ボタン用)
function unloadFarRoads(force) {
  _roadUnloadFrame++;
  if (!force && _roadUnloadFrame % 90 !== 0) return; // 建物と同様、毎フレームやる必要はない(~1.5秒ごと)
  const px = player.position.x, pz = player.position.z;
  const d2 = ROAD_UNLOAD_DIST * ROAD_UNLOAD_DIST;
  const dMinor2 = MINOR_ROAD_MESH_DIST * MINOR_ROAD_MESH_DIST;
  for (const r of roadRecords) {
    if (r.type === 'motorway') continue; // 高架は対象外
    const mx = (r.x1 + r.x2) / 2, mz = (r.z1 + r.z2) / 2;
    const dx = mx - px, dz = mz - pz;
    const dd = dx * dx + dz * dz;
    const lim2r = isMinorRoadType(r.type) ? dMinor2 : d2;
    // 【2026-07-16】範囲内なのにメッシュが無い道路はここで再キューして復元する。
    // 以前はチャンク再生成(960m)頼みだったため、細街路の保持距離(1100m)との間に
    // 「再接近しても細い道路が生成されない帯」ができていた(実機報告)。
    if (!r.mesh) {
      if (dd <= lim2r) queueRoadMesh(r);
      continue;
    }
    if (dd <= lim2r) continue; // まだ範囲内(細街路は短い距離で切る)
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
// 【2026-07-17】distSqPointToSegはjs/lib/pure.jsへ移動(CODE_REVIEW_20260717 P13-1)。
// 点(x,z)が、道路の中心線から (道幅/2 + extra) 以内にあるか(近傍セルだけ調べる)
function roadNear(x, z, extra) {
  const gx = Math.floor(x / ROAD_CELL), gz = Math.floor(z / ROAD_CELL);
  for (let dx = -1; dx <= 1; dx++) for (let dz = -1; dz <= 1; dz++) {
    const arr = roadGrid.get((gx + dx) + ',' + (gz + dz));
    if (!arr) continue;
    for (const r of arr) {
      const d2 = distSqPointToSeg(x, z, r.x1, r.z1, r.x2, r.z2);
      const lim = (r.rw || 4) / 2 + extra;
      if (d2 < lim * lim) return true;
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
let meshedBuildingGrid = new Map();
// 共通のセル格子への登録処理(meshedBuildingGrid/realBuildingIndexで共有)
function _gridAddTo(grid, rec) {
  const pad = Math.max(rec.w, rec.d) / 2 + 5;
  const gx0 = Math.floor((rec.x - pad) / BUILDING_CELL), gx1 = Math.floor((rec.x + pad) / BUILDING_CELL);
  const gz0 = Math.floor((rec.z - pad) / BUILDING_CELL), gz1 = Math.floor((rec.z + pad) / BUILDING_CELL);
  for (let gx = gx0; gx <= gx1; gx++) for (let gz = gz0; gz <= gz1; gz++) {
    const k = gx + ',' + gz;
    let arr = grid.get(k);
    if (!arr) { arr = []; grid.set(k, arr); }
    arr.push(rec);
  }
}
// 【重要・2026-07-15】meshedBuildingGridは「実際にaddBuilding()でメッシュ化済みの建物」専用
// (rebuildBuildingsInBounds/rebuildBuildingHeightがparts/gyを前提に地形追従の平行移動を行う)。
// 一方hasRealBuildingNearby/hasRealHouseNearbyは「キューに積んだ時点(まだ未描画)」でも
// 本物のOSM建物の存在を知りたい([[project_isehara_game_procedural_infill_race]]参照)。
// 同じmeshedBuildingGridに未描画のスタブ(parts/gy無し)を混ぜてしまうと、rebuildBuildingHeightが
// rec.partsをiterateしようとして "rec.parts is not iterable" で例外になる不具合が起きた
// (実機で確認)。描画済み専用のmeshedBuildingGridとは別に、未描画スタブ専用のrealBuildingIndexを
// 用意し、用途を完全に分離する。
let realBuildingIndex = new Map();
function meshedBuildingGridAdd(rec) { _gridAddTo(meshedBuildingGrid, rec); }
function realBuildingIndexAdd(rec) { _gridAddTo(realBuildingIndex, rec); }
function rebuildBuildingGrid() {
  meshedBuildingGrid = new Map();
  for (const rec of buildingRecords) meshedBuildingGridAdd(rec);
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
    const arr = meshedBuildingGrid.get(gx + ',' + gz);
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
// ただし完全に忘れるのではなく、軽量な記述(x,z,w,d,h,style)だけdormantBuildingsへ
// 戻しておき、再接近時にreactivateNearbyDormantBuildingsが検知してpendingBuildingsへ
// 戻し、通常の経路でまた生成されるようにする(手続き生成建物のチャンク・アンロード/
// 再生成と同じ考え方)。
//
// 遠景最適化(2026-07-15): 「道路・線路・川・地形さえ見えれば遠景としては十分」という
// 判断で、実建物だけ道路(ROAD_UNLOAD_DIST=2500m)よりずっと近い距離で足切りする。
// BUILDING_GEN_DIST(生成しはじめる距離)とBUILDING_UNLOAD_DIST(消す距離)を分け、
// 境界付近を行ったり来たりしても毎フレーム生成/消去を繰り返さないようにする
// (よくあるヒステリシス方式。差が無いと境界線上でチラつく)。
// UNLOAD側は当初1000mだったが、GEN(800m)との差が小さく、少し斜めに歩いただけでも
// 頻繁に解放→再生成を繰り返しがちだったため1500mに広げ、ヒステリシス帯を厚くした。
// 【2026-07-16】種類別の距離に分離(ユーザー要望):
// ・実OSM建物(real=マップデータ由来) = 3000mで生成 / 3800mで消去
// ・手続き生成建物(real=false)はチャンクシステム側(CHUNK_RADIUS)が約1000mを管理
// ヒステリシス帯(GEN<UNLOAD)は従来同様、境界往復でのチラつき防止。
// 数値はPERFプリセット(パフォーマンス設定)から取得
const BUILDING_GEN_DIST_REAL = PERF.bGenReal;
const BUILDING_UNLOAD_DIST_REAL = PERF.bUnloadReal;
const BUILDING_GEN_DIST_PROC = 1000;
const BUILDING_UNLOAD_DIST_PROC = 1800;
let _buildingUnloadFrame = 0;
// 【2026-07-21・Fable5診断】eviction(このすぐ下)が直近で実際に適用した実建物の保持距離。
// reactivateNearbyDormantBuildings側がこれを参照してマージン(境界の緩衝帯)を作る
// (evict/revive境界のチャタリング防止。詳細はreactivateNearbyDormantBuildings参照)。
let _lastRealKeepDist = BUILDING_UNLOAD_DIST_REAL;
// 【2026-07-21・Fable5診断: revive/evictスワップ結合】このサイクル(unloadFarBuildings)で
// 実際にbuildingRecordsから除去した件数。reactivateNearbyDormantBuildingsが同じ90フレーム
// 周期で直後に読み、REVIVE_BUDGETに加算する(evictが活発な瞬間ほどreviveも動けるようにし、
// records=bMax*0.95ちょうどで両者が釣り合って膠着する「アトラクタ」を構造的に解消する)。
let _freedThisCycle = 0;
// force=true: 90フレーム周期を待たず即座に判定する(「今すぐ整理」ボタン用。CODE_REVIEW P8関連)
function unloadFarBuildings(force) {
  _buildingUnloadFrame++;
  if (!force && _buildingUnloadFrame % 90 !== 0) return; // 毎フレームやる必要はない(~1.5秒ごと)
  if (buildingRecords.length === 0) return;
  const px = player.position.x, pz = player.position.z;
  // 【2026-07-16】総数上限(PERF.bMax)付近では、実建物の消去距離をヒステリシス上限
  // (2900m)ではなく生成距離(2200m)まで詰める。上限到達中は「移動先の新しい建物」が
  // dormant行きになる一方、後方の建物が2900mを超えるまで枠が空かず、移動先の道路沿いに
  // 建物が建たない「枠詰まり」が起きていた(実機報告: 高所移動で拡張した道路に建物なし)。
  // 上限に余裕がある通常時は従来のヒステリシスでチラつきを防ぐ。
  const _nearCap = buildingRecords.length >= PERF.bMax * 0.95;
  const _realLim = _nearCap ? BUILDING_GEN_DIST_REAL : BUILDING_UNLOAD_DIST_REAL;
  let d2Real = _realLim * _realLim;
  // 【2026-07-16】上限到達中の「空洞化」対策。消去距離を生成距離まで詰めるだけでは、
  // 古い方向の1500〜2200m帯の建物が枠を占有し続け、足元の新着建物が枠待ちになって
  // 「遠くは建っているのに手前が空洞」になる瞬間があった(実機報告)。上限到達中は
  // 距離ヒストグラムで「近い順にbMaxの85%が収まる半径」を求め、それより外を解放する。
  // = どんな密集地でも常に「プレイヤーに近い建物が最優先で描画枠を得る」ことを保証する。
  if (_nearCap) {
    const BIN = 100, NBIN = 40; // 100m刻み×4km
    const hist = new Array(NBIN).fill(0);
    let realTotal = 0, procTotal = 0;
    for (const rec of buildingRecords) {
      if (!rec.real) { procTotal++; continue; }
      realTotal++;
      const dx = rec.x - px, dz = rec.z - pz;
      // 高層(40m超)は距離を1.6で割って「近い扱い」にし、選別で生き残りやすくする
      // (上限到達で保持半径が縮んでも、遠景のスカイラインが丸ごと消えないように)
      const dist = Math.sqrt(dx * dx + dz * dz) / (rec.h > 40 ? 1.6 : 1);
      const bi = Math.min(NBIN - 1, (dist / BIN) | 0);
      hist[bi]++;
    }
    // 【2026-07-21・Fable5診断・修正6】以前はtarget=PERF.bMax*0.85(=総数基準)だったが、
    // histは実建物しか数えていない。密集地でも実建物数がtarget未満の場合(手続き生成建物が
    // 総数の一部を占めるケース)、累積(acc)が一度もtargetへ到達できずcutoff=NBIN固定
    // (=このヒストグラム縮小自体が完全に空振り)になっていた。上限到達中でも実質的な
    // eviction(枠の解放)が一切発生せず、reactivateNearbyDormantBuildings側は855行目の
    // ガードで動かないため、dormantBuildingsが際限なく積み上がる片道弁の直接原因になっていた
    // (実機ログでrecords 12000/12000に張り付いたままdormantが11万件超まで増加して確認)。
    // 実建物のみのヒストグラムには実建物基準のtargetを使う: 「全体の85%からプロシージャル
    // 建物ぶんを差し引いた、実建物が占めてよい席数」。procTotalは他の距離カットオフ
    // (BUILDING_UNLOAD_DIST_PROC)で別途管理されるためここでは触らない。
    const target = Math.max(0, PERF.bMax * 0.85 - procTotal);
    let acc = 0, cutoff = NBIN;
    for (let i = 0; i < NBIN; i++) { acc += hist[i]; if (acc >= target) { cutoff = i + 1; break; } }
    const cutR = cutoff * BIN;
    if (cutR * cutR < d2Real) d2Real = cutR * cutR;
  }
  _lastRealKeepDist = Math.sqrt(d2Real); // reactivateNearbyDormantBuildings側のマージン計算用
  const d2Proc = BUILDING_UNLOAD_DIST_PROC * BUILDING_UNLOAD_DIST_PROC;
  const removeIds = new Set();
  // 【2026-07-17・P3】以前はここでbuildingRecordsを直接spliceしていたが、削除の6点セットを
  // removeBuildingsByIdsに集約したため、このループはremoveIds収集とTHREE.js解放・dormant退避
  // だけを行い、buildingRecords本体の除去はremoveBuildingsByIds側にまとめて任せる。
  for (const rec of buildingRecords) {
    const dx = rec.x - px, dz = rec.z - pz;
    let dd = dx * dx + dz * dz;
    if (rec.real && rec.h > 40) dd /= 2.56; // 高層は1.6倍遠くまで保持(ヒストグラムの換算と一致させる)
    if (dd <= (rec.real ? d2Real : d2Proc)) continue; // まだ範囲内
    for (const p of rec.parts) {
      if (!p || p.userData._released) continue; // 【2026-07-20・二重解放バグ修正】下記コメント参照
      p.userData._released = true;
      scene.remove(p);
      if (p.geometry && !p.geometry.userData.shared) p.geometry.dispose();
      if (p.material) releaseFacadeMat(p.material); // facadeMat以外は無害なno-op(part2.js参照)
    }
    removeIds.add(rec.bid);
    // 再接近時に復元できるよう、軽量な記述だけdormantBuildingsへ(すでに
    // BUILDING_UNLOAD_DIST > BUILDING_GEN_DIST の外なので、そのままpendingBuildingsへ
    // 戻すと次のフレームで即dormantへ送り返されるだけの無駄が発生する)。
    dormantAdd({ x: rec.x, z: rec.z, w: rec.w, d: rec.d, h: rec.h, style: rec.style, real: rec.real, rot: rec.rot });
  }
  _freedThisCycle = removeIds.size; // 【2026-07-21・Fable5診断】このサイクルの実解放件数を記録
  _bgEvicted += removeIds.size; // part9.js側の[buildgen]ログ用(2秒累計、ヒストグラム縮小の発火確認)
  removeBuildingsByIds(removeIds);
}

// (2026-07-16: ここにあった高度LOD(updateAltitudeLOD)は撤去。上空で遠くの低層を非表示に
//  する対策だったが、条件を40m/300mまで絞ってもクラッシュ防止に効かないことが実測で判明。
//  真因は建物+道路メッシュの総量で、建物総数キャップ(PERF.bMax)+細街路メッシュ距離制限が
//  実際に効いた対策。経緯はDEBUG_SESSION_20260716_BUILDINGS.md参照)

// dormantBuildings(遠すぎて未生成、または遠方で解放済みの実建物)を低頻度でスキャンし、
// プレイヤーがBUILDING_GEN_DIST以内に近づいたものだけpendingBuildingsへ戻して
// 通常の生成キューに合流させる。unloadFarBuildingsと同じ頻度(~1.5秒ごと)で十分
// (境界を跨いだ直後1.5秒以内に生成されれば体感上ポップインは気にならない)。
let _dormantCheckFrame = 0;
function reactivateNearbyDormantBuildings() {
  _dormantCheckFrame++;
  if (_dormantCheckFrame % 90 !== 0) return;
  if (dormantCount === 0) return;
  // 総数上限(PERF.bMax)到達中は復帰させない(復帰→上限で即dormant戻しの空回り防止)
  if (buildingRecords.length >= PERF.bMax) return;
  const px = player.position.x, pz = player.position.z;
  // 【2026-07-21・Fable5診断(v2)】密集地(東京駅等)では既知の実建物数がbMaxを大きく
  // 超えるため、records(=buildingRecords.length)がbMax付近(80%超)に恒常的に張り付き
  // 続けるのが構造的な必然であり、「過渡的な回復中」と「定常的な高止まり」を閾値で
  // 区別しようとした前回の設計(80%未満=無制限、80%以上=200件固定)は、密集地では
  // 実質「常に200件/サイクル(≈133件/秒)」に固定されているのと同じになってしまい、
  // dormant数万件規模の復帰が追いつかず新たなボトルネックになった(実機ログで確認: 特定
  // タイルのbuildPendingが10秒以上一切減らないまま固定)。閾値によるレジーム切り替え自体を
  // やめ、「修正6のヒストグラム縮小(85%まで空ける)と対になる、今空いている容量ぶんだけ」
  // を予算にする。空きが無ければ0、大きく空いていれば(上限復帰直後等)それに応じて多く
  // 復帰できる、雪崩スパイクは構造的に起きない(空き以上には入れられないため)。
  // 実際のメッシュ生成コストは下流(exploreOnUpdateの_buildFrameDeadline=8ms)が
  // 別途守っているので、ここでの上限緩和が直接フレーム落ちにつながることはない。
  // 【2026-07-21・Fable5診断(v3): records=95%アトラクタでの膠着対策】上の空き枠
  // (headroom)だけだと、evict(unloadFarBuildings)とrevive(このサイクル)の出入りが
  // 釣り合ってrecordsがbMax*0.95ちょうどで静止する均衡点(アトラクタ)に捕まった瞬間、
  // headroom=0で復帰が完全停止する(実機ログで確認: dormant急増中にrevived/2sが600→8)。
  // 直前(同じ90フレーム周期)にunloadFarBuildingsが実際に解放した件数(_freedThisCycle)を
  // 加算することで、evictが活発な瞬間ほどreviveも動けるようにし、膠着を構造的に防ぐ。
  // 下限30/サイクル(≈20件/秒)はevictも完全停止している場合の最終保険(bMaxの0.25%程度
  // なので雪崩にはならない)。総数超過はpart9側の最終弁(records>=bMaxでdormant退避)が
  // 別途守るため、多少の見積もり超過があっても安全。
  const headroom = Math.max(0, Math.floor(PERF.bMax * 0.95) - buildingRecords.length);
  const REVIVE_BUDGET = Math.min(600, Math.max(30, headroom + _freedThisCycle));
  // ヒステリシスマージン(evict境界とのチャタリング防止)は維持。
  const _nearCapNow = buildingRecords.length >= PERF.bMax * 0.95;
  const _realRevLim = _nearCapNow ? Math.min(BUILDING_GEN_DIST_REAL, _lastRealKeepDist * 0.8) : BUILDING_GEN_DIST_REAL;
  const d2Real = _realRevLim * _realRevLim;
  const d2Proc = BUILDING_GEN_DIST_PROC * BUILDING_GEN_DIST_PROC;
  // 【2026-07-21・Fable5診断(v2)】以前は配列の末尾(=直近dormant入りした建物)から走査
  // していたため、古くから待っている近傍建物に予算が永遠に回らない「LIFO飢餓」を
  // 起こしていた(レートを上げても解決しない選択の問題、と指摘された)。プレイヤーに
  // 近いセル(DORMANT_CELL=200m四方、part8.js)から外側へ順に走査し、常に「近い建物が
  // 最優先で復帰する」ことを保証する。
  const maxD = Math.sqrt(Math.max(d2Real, d2Proc));
  const maxR = Math.max(0, Math.ceil(maxD / DORMANT_CELL)) + 1;
  const pgx = Math.floor(px / DORMANT_CELL), pgz = Math.floor(pz / DORMANT_CELL);
  let revived = 0;
  for (let r = 0; r <= maxR && revived < REVIVE_BUDGET; r++) {
    for (let gx = pgx - r; gx <= pgx + r && revived < REVIVE_BUDGET; gx++) {
      for (let gz = pgz - r; gz <= pgz + r; gz++) {
        if (Math.max(Math.abs(gx - pgx), Math.abs(gz - pgz)) !== r) continue; // このリング(距離r)の外周セルだけ
        const arr = dormantGrid.get(gx + ',' + gz);
        if (!arr || arr.length === 0) continue;
        for (let i = arr.length - 1; i >= 0 && revived < REVIVE_BUDGET; i--) {
          const b = arr[i];
          const dx = b.x - px, dz = b.z - pz;
          let dd = dx * dx + dz * dz;
          // 【2026-07-21・Fable5診断】unloadFarBuildingsの高層優遇(÷1.6、距離の2乗なので
          // ÷2.56)と評価基準を揃える。揃っていないと高層建物だけevict/revive境界がずれて
          // チャーンしうる。
          if (b.real && b.h > 40) dd /= 2.56;
          if (dd <= (b.real ? d2Real : d2Proc)) {
            const last = arr.length - 1; // セル内はswap-remove(順序不要なのでO(1))
            arr[i] = arr[last]; arr.pop();
            dormantCount--;
            pendingBuildings.push(b);
            revived++;
            _bgRevived++; // 【2026-07-21・Fable5診断(dormant復帰)】part9.js側の[buildgen]ログ用
          }
        }
        if (arr.length === 0) dormantGrid.delete(gx + ',' + gz);
      }
    }
  }
}

// ======= 【2026-07-21・Fable5診断(b)】ゲート待ち建物の隔離キュー =======
// 以前はchunkNearTerrainReady/osmTilesReadyAroundが不成立の建物を、1件ずつ「ダメなら末尾へ
// 戻す」方式で扱っていた(part9.js生成ループ)。密集地では地形NEARの網羅が建物到着に
// 追いつかない時間帯があり、この「末尾へ戻すだけ」の建物が生成予算の過半(実機計測で56%)を
// 空費する「requeued空回り」の直接原因になっていた(同じ建物群が0.5秒毎の距離再ソートで
// また先頭付近に戻ってきては、また同じ理由で末尾へ戻される、というタイトループ)。
// ゲート不成立の建物を「建物ごと」ではなく「ゲートのキー(チャンク/タイル)単位」で
// グループ化して退避し、90フレーム毎の低頻度スキャナがキー単位(密集地でも数十)で
// readyを再判定する(数万棟の毎フレーム走査 → 数十キーの間欠チェックに激減)。
const chunkWaitBuildings = new Map(); // "bcx,bcz" -> { arr: 建物[], tries: number }
const tileWaitBuildings = new Map();  // 建物自身の所属タイル"tx,tz" -> { arr: 建物[], tries: number }
function chunkWaitAdd(key, b) {
  let e = chunkWaitBuildings.get(key);
  if (!e) { e = { arr: [], tries: 0 }; chunkWaitBuildings.set(key, e); }
  e.arr.push(b);
}
function tileWaitAdd(key, b) {
  let e = tileWaitBuildings.get(key);
  if (!e) { e = { arr: [], tries: 0 }; tileWaitBuildings.set(key, e); }
  e.arr.push(b);
}
let _gateWaitScanFrame = 0;
function scanGateWaitQueues() {
  _gateWaitScanFrame++;
  if (_gateWaitScanFrame % 90 !== 0) return;
  if (chunkWaitBuildings.size === 0 && tileWaitBuildings.size === 0) return;
  const px = player.position.x, pz = player.position.z;
  const d2Real = BUILDING_GEN_DIST_REAL * BUILDING_GEN_DIST_REAL;
  // 【Fable5指摘・注意点】(1)隔離キューの建物もプレイヤーが離れたらdormantへ退避しないと、
  // 二度と戻れない待機列に永久に残り続ける。(2)戻す際は1サイクルあたりの件数に上限を設け、
  // 多数のキーが同時にreadyになった瞬間の雪崩(pendingBuildingsへの一括流入)を防ぐ。
  let returnBudget = 2000;
  const scanMap = (map, isReady) => {
    for (const [key, e] of map) {
      e.tries++;
      // 【2026-07-19由来・安全弁】20回(約30秒)試しても揃わなければ、諦めてFAR基準のまま
      // 生成する(無限に待ち続けるのを防ぐ。元の_tries<40の考え方を1キー単位に踏襲)。
      const ready = isReady(key, e) || e.tries >= 20;
      const keep = [];
      for (const b of e.arr) {
        const dx = b.x - px, dz = b.z - pz;
        if (b.real && dx * dx + dz * dz > d2Real) { dormantAdd(b); continue; } // 離れた分はdormantへ
        if (ready && returnBudget > 0) { pendingBuildings.push(b); returnBudget--; continue; }
        keep.push(b);
      }
      if (keep.length === 0) map.delete(key); else e.arr = keep;
    }
  };
  scanMap(chunkWaitBuildings, (key) => {
    if (IS_MEIJI) return true;
    const parts = key.split(',');
    return chunkNearTerrainReady(parseInt(parts[0], 10), parseInt(parts[1], 10));
  });
  scanMap(tileWaitBuildings, (key, e) => {
    const rep = e.arr[0];
    return !!rep && osmTilesReadyAround(rep.x, rep.z, 64);
  });
}
// ログ・デバッグオーバーレイ用: 隔離キュー内の総件数(呼び出し頻度が低い場所でのみ使う想定)
function gateWaitTotalCount() {
  let n = 0;
  for (const e of chunkWaitBuildings.values()) n += e.arr.length;
  for (const e of tileWaitBuildings.values()) n += e.arr.length;
  return n;
}

let placedBuildings = [];  // {x,z,r,ck} for landuse de-duplication
// 【2026-07-17・CODE_REVIEW_20260717 P1】hasBuildingNearbyはplacedBuildings全件を線形走査
// していた唯一残った「増え続ける配列の全件走査」ホットパス(generateChunkが1チャンクあたり
// 数百候補点で呼ぶため、bMax近くまで建物が溜まった密集地では1チャンク生成=数百万回の距離
// 計算になり得た)。meshedBuildingGrid/realBuildingIndexと同じBUILDING_CELLのセル格子に載せ替える。
// 判定ロジック(b.r込みの距離)自体は変えない。削除時はrebuildBuildingGrid等と同じ
// タイミングでrebuildPlacedBuildingsGrid()を呼び、同期を保つ。
let placedBuildingsGrid = new Map();
function placedBuildingsGridAdd(rec) {
  const pad = (rec.r || 0) + 5;
  const gx0 = Math.floor((rec.x - pad) / BUILDING_CELL), gx1 = Math.floor((rec.x + pad) / BUILDING_CELL);
  const gz0 = Math.floor((rec.z - pad) / BUILDING_CELL), gz1 = Math.floor((rec.z + pad) / BUILDING_CELL);
  for (let gx = gx0; gx <= gx1; gx++) for (let gz = gz0; gz <= gz1; gz++) {
    const k = gx + ',' + gz;
    let arr = placedBuildingsGrid.get(k);
    if (!arr) { arr = []; placedBuildingsGrid.set(k, arr); }
    arr.push(rec);
  }
}
function rebuildPlacedBuildingsGrid() {
  placedBuildingsGrid = new Map();
  for (const rec of placedBuildings) placedBuildingsGridAdd(rec);
}
// 建物1棟ぶんの削除で必ず一緒に触る「6点セット」を1関数に集約したもの。
// 【2026-07-17・CODE_REVIEW_20260717 P3】以前はremoveBuildingsOverlappingRoad(このファイル)・
// unloadFarBuildings(このファイル)・updateChunks(part8.js)の3箇所にほぼ同一コピペで存在し、
// 新しい属性・インデックスを足すたびに3箇所の同期漏れリスクがあった(過去の幽霊当たり判定・
// "rec.parts is not iterable"はこの分散が土壌)。
// 呼び出し元は先に「削除するbuildingのbid集合」を作り(判定基準は道路重なり/距離/chunkKeyなど
// 呼び出し元ごとに異なってよい)、THREE.jsオブジェクトの解放や再キュー(pendingBuildings/
// dormantBuildingsへ戻す等)を済ませてから、このremoveBuildingsByIdsを呼ぶ。
// collisionBoxes/minimapBuildings/placedBuildingsはいずれもbidを持つため、削除基準が
// chunkKey等であっても最終的にはbid集合に変換して渡せば同じ経路で削除できる。
function removeBuildingsByIds(removeIds) {
  if (!removeIds || removeIds.size === 0) return;
  for (let i = buildingRecords.length - 1; i >= 0; i--) {
    if (removeIds.has(buildingRecords[i].bid)) buildingRecords.splice(i, 1);
  }
  collisionBoxes = collisionBoxes.filter(b => !removeIds.has(b.buildingId));
  minimapBuildings = minimapBuildings.filter(b => !removeIds.has(b.bid));
  placedBuildings = placedBuildings.filter(b => !removeIds.has(b.bid));
  rebuildCollGrid();
  rebuildBuildingGrid();
  rebuildPlacedBuildingsGrid();
}
const landusePolygons = []; // {pts, lu, minX, maxX, minZ, maxZ} — stored during loadOSM for dynamic chunk generation
const landuseGrid = new Map(); // polyGridAdd/queryPolyGridで使う空間ハッシュ(全件走査を避ける)
const loadedChunks = new Set(); // "cx,cz" string keys of already-generated chunks
const chunkMeshes = new Map();  // "cx,cz" → [THREE.Mesh, ...] for unloading
const CHUNK_SIZE = 120;  // meters per chunk side
// 建物密度を大幅に上げた(ぎゅうぎゅうの日本の街並み)ため、生成半径は
// ±480m→±360mに縮小し、代わりにフォグを濃く(0.0004→0.00056)して
// ポップインが目立たない距離バランスを維持する。明治は低密度なので従来の±480mのまま
// 【2026-07-16】ユーザー要望「手続き生成建物=約1000m」に合わせ 3→8(8×120=960m)。
// チャンク数は49→289に増えるが生成はフレーム分割キューなので徐々に埋まる。
// 重すぎる場合は6(720m)あたりに戻す候補。
const CHUNK_RADIUS = USES_MEIJI_LANDUSE ? 4 : PERF.chunkR; // パフォーマンス設定に連動

// 【2026-07-17】pointInPolygonはjs/lib/pure.jsへ移動(CODE_REVIEW_20260717 P13-1)。

// 【重要】以前はminDist(=新しく置こうとしている側の半径+余白)だけを見ており、
// 既存の建物側の大きさ(b.r。placedBuildingsに元々記録済み)を一切考慮していなかった。
// そのため、マンションのような大きな実建物のすぐ隣(中心からの距離だけで見れば
// 十分離れているつもりでも、大きな建物自体の縁からは全く離れていない位置)にまで
// 手続き生成の小さな戸建てが並んでしまい、実際にはマンション1棟のはずの場所が
// 「戸建ての集まり」に見える不具合の一因になっていた。既存建物の半径ぶんも
// 足し合わせて判定する(=「建物の縁から」minDistだけ離れているかを見る)。
function hasBuildingNearby(cx, cz, minDist) {
  const gx0 = Math.floor((cx - minDist) / BUILDING_CELL), gx1 = Math.floor((cx + minDist) / BUILDING_CELL);
  const gz0 = Math.floor((cz - minDist) / BUILDING_CELL), gz1 = Math.floor((cz + minDist) / BUILDING_CELL);
  for (let gx = gx0; gx <= gx1; gx++) for (let gz = gz0; gz <= gz1; gz++) {
    const arr = placedBuildingsGrid.get(gx + ',' + gz);
    if (!arr) continue;
    for (const b of arr) {
      const dx = cx - b.x, dz = cz - b.z;
      const lim = minDist + (b.r || 0);
      if (dx*dx + dz*dz < lim*lim) return true;
    }
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
  // realBuildingIndex: キュー投入時点(未描画でもよい)で「本物のOSM建物」として登録済みの
  // 軽量インデックス([[project_isehara_game_procedural_infill_race]]参照)。描画済み専用の
  // meshedBuildingGridとは別物なので混同しないこと。
  for (let gx = gx0; gx <= gx1; gx++) for (let gz = gz0; gz <= gz1; gz++) {
    const arr = realBuildingIndex.get(gx + ',' + gz);
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
// 【重要】以前はindustrial/shopしか除外しておらず、apartment/office(マンション・オフィス。
// classifyResidentialでbuilding=yesの大型建物を正しく格上げできるようになった後に顕在化)
// が近くにあるだけで「本物の一戸建てが実在するエリア」と誤認され、大きなマンション/オフィス
// ビル1棟のすぐ周りまで手続き生成の戸建てが取り囲むように並んでしまっていた
// (実機報告: 「ジャンプ用マップには大きなマンションの枠があるのに、生成では戸建て
// 住宅の集まりになっている」)。マンション・オフィスも一戸建て補完の根拠から除外する。
function hasRealHouseNearby(cx, cz, dist) {
  const d2 = dist * dist;
  const gx0 = Math.floor((cx - dist) / BUILDING_CELL), gx1 = Math.floor((cx + dist) / BUILDING_CELL);
  const gz0 = Math.floor((cz - dist) / BUILDING_CELL), gz1 = Math.floor((cz + dist) / BUILDING_CELL);
  const EXCLUDE_TYPES = new Set(['industrial', 'shop', 'apartment', 'office']);
  for (let gx = gx0; gx <= gx1; gx++) for (let gz = gz0; gz <= gz1; gz++) {
    const arr = realBuildingIndex.get(gx + ',' + gz);
    if (!arr) continue;
    for (const rec of arr) {
      if (!rec.real) continue;
      if (rec.style && EXCLUDE_TYPES.has(rec.style.type)) continue;
      const dx = rec.x - cx, dz = rec.z - cz;
      if (dx*dx + dz*dz < d2) return true;
    }
  }
  return false;
}

// 【重要・2026-07-16】buildable()の判定順(part8.js)では、landuse=residentialの区画内なら
// 本物の建物の有無に関係なく無条件でtrue(一戸建て補完OK)を返していた。日本のOSMの
// landuse=residentialポリゴンは粗く、実際には大きな商業ビル・オフィスビルの敷地まで
// 覆っていることが多い(特に東京駅周辺のような複合用途エリア)。realBuildingIndexに
// 本物の建物が「登録済み」でも、hasRealBuildingNearby/hasRealHouseNearbyは
// buildable()の4)の分岐(landuseタグ無しの場合)でしか参照されておらず、3)の
// landuse=residential分岐では一切チェックされていなかったため、procedural-infill-race
// 対策(realBuildingIndexの導入)をしても「実は本物の大きい建物がここにある」場所に
// 一戸建てが重なって建ち続けていた(実機報告: 東京駅周辺で本物の建物が0件、手続き生成の
// 小さい住宅のみ100%というdiag結果で発覚)。landuseの判定より前に効く、本物の建物の
// 実フットプリント(中心x,z ± w/2,d/2 に余白pad)に候補地点が入っているかどうかの
// 直接判定を追加し、どの分岐であっても本物の建物に重ねて一戸建てを建てないようにする。
function isInsideKnownRealBuilding(qx, qz, pad) {
  pad = pad || 3;
  const gx = Math.floor(qx / BUILDING_CELL), gz = Math.floor(qz / BUILDING_CELL);
  for (let dgx = -1; dgx <= 1; dgx++) for (let dgz = -1; dgz <= 1; dgz++) {
    const arr = realBuildingIndex.get((gx + dgx) + ',' + (gz + dgz));
    if (!arr) continue;
    for (const rec of arr) {
      if (!rec.real) continue;
      const hw = (rec.w || 8) / 2 + pad, hd = (rec.d || 8) / 2 + pad;
      // 【2026-07-18】以前は軸平行の箱としてしか判定しておらず、道路にフィットさせて
      // 回転済みの実建物(rec.rot≠0)では対角線付近で実際のフットプリントより狭く
      // 判定してしまい、手続き生成の家がその隙間(実際には建物の内側)に重なって
      // 生成されていた。collBoxHitsXZ(part7.js、当たり判定)と同じ逆回転変換で
      // 建物のローカル座標系に直してから判定する(軸平行=rot未設定/0の場合は
      // cos(0)=1,sin(0)=0で従来と同じ結果になるので回転無し建物への影響は無い)。
      const rot = rec.rot || 0;
      const dx = qx - rec.x, dz = qz - rec.z;
      const c = Math.cos(rot), s = Math.sin(rot);
      const lx = dx * c - dz * s, lz = dx * s + dz * c;
      if (Math.abs(lx) <= hw && Math.abs(lz) <= hd) return true;
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
