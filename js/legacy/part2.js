/**
 * legacy/part2.js — index.html の巨大インラインスクリプトを行範囲のまま機械的に切り出した
 * ファイル(2/9)。part1.js の続き。詳細は part1.js 冒頭のコメント参照。
 */
// ======= BUILDING MATERIAL =======
// スタイル不明のOSM建物の壁色(江戸・メルヘン・宇宙モードは幻想紫のまま。窓はファサードテクスチャで表現)
const DEFAULT_WALLS = [0x9a7acc, 0x8a6ab8, 0xaa80d8, 0x9880c8];
// 現実モード用: building=yesだけ等でタグから種別不明な建物は、紫だと明らかに浮くので
// 日本の街並みでよくある外壁トーン(生成りグレー・ベージュ系)を使う
const DEFAULT_WALLS_REAL = [0xd8d0c0, 0xc8c8c0, 0xe0d8c8, 0xb8b8b0, 0xd0c8b0, 0xc0bcb0];

// マテリアルキャッシュ — 建物ごとに new していたのを同色で共有し、
// チャンク生成でマテリアルが無限増殖するのを防ぐ
const matCache = new Map();
function lambertMat(color, emissive) {
  const key = color + '_' + (emissive || 0);
  let m = matCache.get(key);
  if (!m) { m = new THREE.MeshLambertMaterial({ color, emissive: emissive || 0 }); matCache.set(key, m); }
  return m;
}

// 敷地余白(lotPadding)装飾メッシュの上限 — 香港のように余白がほぼ無い国は自然と発生しないが、
// アメリカ等の広い余白プロファイルを高密度な都心(マンハッタン等)にそのまま適用すると、
// 高層ビル1棟ごとに追加のterrain-followingメッシュを生成することになり、実機検証で
// レンダラーが完全にフリーズする不具合が確認された。国・密度を問わない固定上限で歯止めをかける。
let lotPaddingBudget = 300;
// 装飾ポイントライトの上限 — ライトが増えるたびに全マテリアルのシェーダが
// 再コンパイルされてカクつき、描画コストもライト数に比例して増えるため
let decorLightCount = 0;
const MAX_DECOR_LIGHTS = 6;
function addDecorLight(color, intensity, range, x, y, z) {
  if (decorLightCount >= MAX_DECOR_LIGHTS) return null;
  decorLightCount++;
  const l = new THREE.PointLight(color, intensity, range);
  l.position.set(x, y, z);
  scene.add(l);
  return l;
}
// 窓ガラスの個別メッシュは廃止 — 窓はファサードテクスチャ+emissiveMapに焼き込む(下記 facadeMat)
const glowMat  = new THREE.MeshBasicMaterial({ color: 0x8040ff, transparent: true, opacity: 0.3, side: THREE.DoubleSide });

// 特徴建物用の共有マテリアル
const STOREFRONT_MAT = new THREE.MeshBasicMaterial({ color: 0xfff6cc }); // コンビニ等の明るい店構え
const SIGN_BAND_MATS = [0xe83020, 0x2255dd, 0x11a04a, 0xff8800].map(c => new THREE.MeshBasicMaterial({ color: c }));
const YARD_MAT = new THREE.MeshLambertMaterial({ color: 0xb89868 }); // 校庭の土
const HOUSE_PALETTE = [ // 手続き生成住宅の色バリエーション(現実モード用。他モードは addBuilding 内で置換)
  { w: 0xd8cdb8, r: 0x555a66 }, { w: 0xe8e0d0, r: 0x7a4a3a },
  { w: 0xc8b898, r: 0x4a5a3a }, { w: 0xd0c0a0, r: 0x69463c },
  { w: 0xbfae94, r: 0x3f4c59 },
];
// モード別の壁・屋根・発光パレット(lambertMatキャッシュを通すのでマテリアルは増殖しない)
const EDO_WALLS    = [0xcfc0a0, 0x8a6a4a, 0xe8e0d0, 0x7a5a3a];
const PASTEL_WALLS = [0xffc0cb, 0xb0e0ff, 0xfff0a0, 0xc8ffc0, 0xe0c0ff, 0xffd8b0];
const PASTEL_ROOFS = [0xff6090, 0x40a0ff, 0xffa040, 0x9060ff];
const SPACE_WALLS  = [0x9aa8b8, 0x7a8898, 0x5a6878, 0xa8b8c8];
const NEON_MATS = [0x00ffee, 0xff00cc, 0x7788ff, 0x00ff88].map(c => new THREE.MeshBasicMaterial({ color: c }));
const SPACE_GLASS = new THREE.MeshLambertMaterial({ color: 0x88ccff, transparent: true, opacity: 0.45, emissive: 0x113355 });
const NOREN_MAT = new THREE.MeshBasicMaterial({ color: 0x2a3a7a, side: THREE.DoubleSide }); // 暖簾(藍)
const CANDY_BAND_MATS = [0xffa0c0, 0xa0d8ff, 0xffe090].map(c => new THREE.MeshBasicMaterial({ color: c }));

// ======= 手続き生成ファサード(Canvasテクスチャ) =======
// 窓の列・サッシ・軒下の影・基礎の帯・ベランダ・1階の玄関などをテクスチャに焼き込み、
// (種類×壁色×バリアント)ごとに1度だけ生成してキャッシュ共有する。
// 窓明かりは emissiveMap に焼くため、旧実装の「窓1枚=1メッシュ」が丸ごと不要になった。
// 種類: house=一戸建て(1枚絵) / apt=集合住宅(1マス=1フロア、ベランダ付き)
//       office=ビル(1マス=1フロア) / ind=工場・倉庫(1マス=約8m)
// 描画ルール: キャンバス左上12px四方には何も描かない
// (BoxGeometryの天面/底面UVをこの無地部に向けるため。setBoxFacadeUVs 参照)
const _hex6 = c => '#' + ('00000' + c.toString(16)).slice(-6);
function shadeHex(c, f) {
  const r = Math.min(255, ((c >> 16 & 255) * f) | 0),
        g = Math.min(255, ((c >> 8 & 255) * f) | 0),
        b = Math.min(255, ((c & 255) * f) | 0);
  return r << 16 | g << 8 | b;
}
const _shadeCss = (c, f) => _hex6(shadeHex(c, f));
const facadeCache = new Map();
function facadeMat(kind, color, variant) {
  const key = kind + '_' + color + '_' + variant;
  const hit = facadeCache.get(key);
  if (hit) return hit;
  const S = 128;
  const cv = document.createElement('canvas'); cv.width = cv.height = S;
  const g = cv.getContext('2d');
  const ec = document.createElement('canvas'); ec.width = ec.height = S;
  const e = ec.getContext('2d');
  e.fillStyle = '#000'; e.fillRect(0, 0, S, S);
  // 決定的乱数 — 同じキーは常に同じ絵(チャンク再生成でも見た目が揺れない)
  let sd = 2166136261 ^ (variant * 977);
  for (let i = 0; i < key.length; i++) sd = (sd ^ key.charCodeAt(i)) * 16777619 | 0;
  const rnd = () => ((sd = (sd * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const wc = _hex6(MODE_CONF.windowC);

  g.fillStyle = _hex6(color); g.fillRect(0, 0, S, S);
  // 壁のむら・汚れ
  for (let i = 0; i < 26; i++) {
    g.fillStyle = rnd() < 0.5 ? 'rgba(0,0,0,0.05)' : 'rgba(255,255,255,0.05)';
    g.fillRect((rnd() * S) | 0, (14 + rnd() * (S - 18)) | 0, (2 + rnd() * 5) | 0, (2 + rnd() * 4) | 0);
  }

  // 窓1枚(枠+ガラス+中桟/格子+窓下の落ち影。lit なら emissive にも描く)
  const win = (x, y, ww, wh, lit, opt) => {
    opt = opt || {};
    g.fillStyle = opt.frame || _shadeCss(color, 0.5);
    g.fillRect(x - 2, y - 2, ww + 4, wh + 4);
    g.fillStyle = lit ? wc : (opt.glass || '#25303e');
    g.fillRect(x, y, ww, wh);
    if (opt.grid) { // 障子・木格子
      g.strokeStyle = opt.gridC || 'rgba(48,32,16,0.85)'; g.lineWidth = 1;
      for (let vx = x + 6; vx < x + ww; vx += 7) { g.beginPath(); g.moveTo(vx, y); g.lineTo(vx, y + wh); g.stroke(); }
      for (let hy = y + 8; hy < y + wh; hy += 9) { g.beginPath(); g.moveTo(x, hy); g.lineTo(x + ww, hy); g.stroke(); }
    } else { // アルミサッシの中桟
      g.fillStyle = 'rgba(200,205,210,0.7)';
      g.fillRect(x + ww / 2 - 0.5, y, 1.5, wh);
    }
    g.fillStyle = 'rgba(0,0,0,0.25)'; g.fillRect(x - 2, y + wh + 2, ww + 4, 3);
    if (lit) { e.fillStyle = wc; e.fillRect(x, y, ww, wh); }
  };

  if (MODE === 'space') {
    // パネル目地+リベット+横一文字の窓+フロア境界の発光帯
    g.strokeStyle = 'rgba(0,0,0,0.28)'; g.lineWidth = 1;
    for (let p = 16; p < S; p += 24) {
      g.beginPath(); g.moveTo(p, 13); g.lineTo(p, S); g.stroke();
      g.beginPath(); g.moveTo(0, p + 4); g.lineTo(S, p + 4); g.stroke();
    }
    g.fillStyle = 'rgba(255,255,255,0.16)';
    for (let p = 16; p < S; p += 24) for (let q = 20; q < S; q += 24) g.fillRect(p - 1, q + 3, 2, 2);
    win(20, 36, 88, 22, rnd() < 0.65, { glass: '#0a141e', frame: _shadeCss(color, 0.4) });
    if (variant === 1) {
      win(28, 76, 30, 26, rnd() < 0.5, { glass: '#0a141e' });
      win(72, 76, 30, 26, rnd() < 0.5, { glass: '#0a141e' });
    }
    g.fillStyle = wc; g.fillRect(0, S - 6, S, 2);
    e.fillStyle = wc; e.fillRect(0, S - 6, S, 2);
  } else if (MODE === 'edo' || IS_MEIJI) {
    // 上=漆喰/土壁、下=下見板張り。窓は障子(温かい光)と木格子、1階に引き戸
    const wood = IS_MEIJI ? _shadeCss(color, 0.72) : '#5a4630';
    g.fillStyle = wood; g.fillRect(0, S * 0.55, S, S * 0.45);
    g.strokeStyle = 'rgba(0,0,0,0.3)'; g.lineWidth = 1;
    for (let y = S * 0.55 + 6; y < S; y += 7) { g.beginPath(); g.moveTo(0, y); g.lineTo(S, y); g.stroke(); }
    const shoji = { grid: true, glass: '#8a8070', frame: '#403020', gridC: 'rgba(40,28,16,0.8)' };
    win(14, 26, 40, 26, rnd() < (IS_MEIJI ? 0.4 : 0.65), shoji);
    win(74, 26, 40, 26, rnd() < (IS_MEIJI ? 0.35 : 0.6), shoji);
    win(14, 82, 44, 30, rnd() < 0.5, { grid: true, glass: '#4a4034', frame: '#332618' });
    g.fillStyle = '#3a2c1c'; g.fillRect(72, 78, 42, 40); // 引き戸
    g.fillStyle = '#8a7050';
    for (let vx = 75; vx < 112; vx += 6) g.fillRect(vx, 80, 2, 36);
  } else if (MODE === 'marchen') {
    // スカラップの縁飾り+丸窓+花箱+丸屋根ドア
    g.fillStyle = 'rgba(255,255,255,0.85)';
    for (let sx2 = 20; sx2 < S; sx2 += 16) { g.beginPath(); g.arc(sx2, 14, 8, 0, Math.PI); g.fill(); }
    const cute = (x, y, ww, wh, lit) => {
      g.fillStyle = '#ffffff';
      g.beginPath(); g.arc(x + ww / 2, y + ww / 2, ww / 2 + 3, Math.PI, 0);
      g.rect(x - 3, y + ww / 2, ww + 6, wh - ww / 2 + 3); g.fill();
      g.fillStyle = lit ? wc : '#9ac8e8';
      g.beginPath(); g.arc(x + ww / 2, y + ww / 2, ww / 2, Math.PI, 0);
      g.rect(x, y + ww / 2, ww, wh - ww / 2); g.fill();
      if (lit) { e.fillStyle = wc; e.fillRect(x, y + 3, ww, wh - 3); }
      g.fillStyle = '#6a9a4a'; g.fillRect(x - 2, y + wh + 2, ww + 4, 5); // 花箱
      const fcols = ['#ff70a0', '#ffd050', '#ff5060'];
      for (let fx = x + 2; fx < x + ww; fx += 7) { g.fillStyle = fcols[(fx | 0) % 3]; g.fillRect(fx, y + wh, 3, 3); }
    };
    cute(16, 30, 28, 34, rnd() < 0.55);
    cute(84, 30, 28, 34, rnd() < 0.55);
    if (kind === 'house') { // 丸屋根のドア(白縁+屋根色+金のノブ)
      g.fillStyle = '#ffffff';
      g.beginPath(); g.arc(64, 92, 17, Math.PI, 0); g.rect(47, 92, 34, 26); g.fill();
      g.fillStyle = _hex6(PASTEL_ROOFS[variant % PASTEL_ROOFS.length]);
      g.beginPath(); g.arc(64, 92, 13, Math.PI, 0); g.rect(51, 92, 26, 24); g.fill();
      g.fillStyle = '#fff0a0'; g.beginPath(); g.arc(72, 102, 2, 0, 7); g.fill();
    } else {
      cute(50, 76, 28, 34, rnd() < 0.5);
    }
  } else if (kind === 'house') {
    // ===== 現実: 一戸建て(2階窓・掃き出し窓・戸袋・玄関・幕板・基礎の帯) =====
    const gr = g.createLinearGradient(0, 12, 0, 26); // 軒下の影
    gr.addColorStop(0, 'rgba(0,0,0,0.22)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = gr; g.fillRect(0, 12, S, 14);
    g.fillStyle = 'rgba(0,0,0,0.06)'; g.fillRect(0, 64, S, 64); // 1階をわずかに濃く
    g.fillStyle = _shadeCss(color, 0.7); g.fillRect(0, 62, S, 3); // 幕板
    g.fillStyle = '#7a7468'; g.fillRect(0, S - 10, S, 10); // 基礎
    win(16, 26, 30, 24, rnd() < 0.5);
    win(64, 26, 30, 24, rnd() < 0.5);
    win(14, 76, 40, 34, rnd() < 0.6); // 掃き出し窓
    g.fillStyle = _shadeCss(color, 0.62); g.fillRect(58, 74, 12, 38); // 雨戸戸袋
    g.fillStyle = '#4a3828'; g.fillRect(82, 78, 24, 40); // 玄関
    g.fillStyle = '#5f4a34'; g.fillRect(85, 81, 18, 34);
    g.fillStyle = '#d8c890'; g.fillRect(100, 96, 2, 5);
  } else if (kind === 'apt') {
    // ===== 現実: 集合住宅(スラブ+窓+ベランダ手すり壁) =====
    g.fillStyle = 'rgba(0,0,0,0.18)'; g.fillRect(0, 0, S, 4);
    const gr = g.createLinearGradient(0, 4, 0, 18);
    gr.addColorStop(0, 'rgba(0,0,0,0.14)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = gr; g.fillRect(0, 4, S, 14);
    win(24, 30, 80, 44, rnd() < 0.45);
    g.fillStyle = 'rgba(15,18,24,0.35)'; g.fillRect(10, 80, 108, 6); // ベランダ奥の影
    g.fillStyle = _shadeCss(color, 0.82); g.fillRect(8, 86, 112, 30); // 手すり壁
    g.fillStyle = _shadeCss(color, 0.66); g.fillRect(8, 86, 112, 3);  // 笠木
    g.fillStyle = 'rgba(0,0,0,0.2)';
    for (let vx = 14; vx < 118; vx += 13) g.fillRect(vx, 89, 2, 26);
  } else if (kind === 'ind') {
    // ===== 現実: 工場・倉庫(波板+ハイサイド窓+シャッター) =====
    g.fillStyle = 'rgba(0,0,0,0.06)';
    for (let vx = 0; vx < S; vx += 6) g.fillRect(vx, 13, 2, S - 13);
    g.fillStyle = _shadeCss(color, 0.75); g.fillRect(0, S - 8, S, 8);
    win(18, 22, 92, 16, rnd() < 0.25, { glass: '#1d242e' });
    if (variant === 1) {
      g.fillStyle = _shadeCss(color, 0.6); g.fillRect(40, 62, 48, 58); // シャッター
      g.strokeStyle = 'rgba(255,255,255,0.1)'; g.lineWidth = 1;
      for (let hy = 66; hy < 118; hy += 5) { g.beginPath(); g.moveTo(41, hy); g.lineTo(87, hy); g.stroke(); }
    }
  } else {
    // ===== 現実: オフィスビル(スラブ+目地+窓2列+スパンドレル) =====
    g.fillStyle = 'rgba(0,0,0,0.2)'; g.fillRect(0, 0, S, 4);
    const gr = g.createLinearGradient(0, 4, 0, 16);
    gr.addColorStop(0, 'rgba(0,0,0,0.12)'); gr.addColorStop(1, 'rgba(0,0,0,0)');
    g.fillStyle = gr; g.fillRect(0, 4, S, 12);
    g.fillStyle = 'rgba(0,0,0,0.15)'; g.fillRect(0, 13, 2, S - 13); g.fillRect(S - 2, 13, 2, S - 13); // 目地
    win(16, 34, 42, 56, rnd() < 0.45);
    win(70, 34, 42, 56, rnd() < 0.45);
    g.fillStyle = _shadeCss(color, 0.86); g.fillRect(10, 102, 108, 16); // スパンドレル
  }

  const tex = new THREE.CanvasTexture(cv);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  const etex = new THREE.CanvasTexture(ec);
  etex.wrapS = etex.wrapT = THREE.RepeatWrapping;
  const emi = MODE === 'space' ? 1.2 : MODE === 'edo' ? 0.9 : IS_MEIJI ? 0.55 : 0.85;
  const m = new THREE.MeshLambertMaterial({ map: tex, emissive: 0xffffff, emissiveMap: etex, emissiveIntensity: emi });
  facadeCache.set(key, m);
  return m;
}

// BoxGeometryのUVをファサードタイルの繰り返し数に張り替える。
// テクスチャは RepeatWrapping なので、UV値をタイル数倍するだけで側面に窓が並ぶ。
// 天面・底面はテクスチャ左上の「無地の壁」領域(描画ルールで確保済み)を指すよう縮小。
function setBoxFacadeUVs(geo, colsX, colsZ, floors) {
  const uv = geo.attributes.uv;
  const face = (f, cu, cvv) => {
    for (let i = 0; i < 4; i++) uv.setXY(f * 4 + i, uv.getX(f * 4 + i) * cu, uv.getY(f * 4 + i) * cvv);
  };
  face(0, colsZ, floors); face(1, colsZ, floors); // ±X面(奥行d方向の幅)
  face(4, colsX, floors); face(5, colsX, floors); // ±Z面(幅w方向)
  for (const f of [2, 3]) for (let i = 0; i < 4; i++)
    uv.setXY(f * 4 + i, 0.02 + uv.getX(f * 4 + i) * 0.03, 0.92 + uv.getY(f * 4 + i) * 0.03);
}

// ======= 屋根ジオメトリ(単位サイズ・全建物で共有し scale で変形) =======
// 旧実装は建物ごとに new ConeGeometry していた → 共有ジオメトリ+scaleでGPUメモリと生成コストを削減。
// userData.shared=true はチャンクアンロード時に dispose しない印(下の updateChunks 参照)
function _roofGeo(pos, uv) {
  const gg = new THREE.BufferGeometry();
  gg.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  gg.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  gg.computeVertexNormals();
  gg.userData.shared = true;
  return gg;
}
const _RQ = (p, u, a, b, c, d) => { p.push(...a, ...b, ...c, ...a, ...c, ...d); u.push(0,0, 4,0, 4,1, 0,0, 4,1, 0,1); };
const _RT = (p, u, a, b, c) => { p.push(...a, ...b, ...c); u.push(0,0, 1,0, 0.5,1); };
const GABLE_GEO = (() => { // 切妻(棟=X軸方向)
  const p = [], u = [];
  _RQ(p, u, [0.5,0,-0.5], [-0.5,0,-0.5], [-0.5,1,0], [0.5,1,0]);
  _RQ(p, u, [-0.5,0,0.5], [0.5,0,0.5], [0.5,1,0], [-0.5,1,0]);
  _RT(p, u, [0.5,0,0.5], [0.5,0,-0.5], [0.5,1,0]);   // 妻壁
  _RT(p, u, [-0.5,0,-0.5], [-0.5,0,0.5], [-0.5,1,0]);
  _RQ(p, u, [-0.5,0,-0.5], [0.5,0,-0.5], [0.5,0,0.5], [-0.5,0,0.5]); // 軒裏
  return _roofGeo(p, u);
})();
const HIP_GEO = (() => { // 寄棟(棟の長さ=幅の半分)
  const p = [], u = [];
  _RQ(p, u, [0.5,0,-0.5], [-0.5,0,-0.5], [-0.25,1,0], [0.25,1,0]);
  _RQ(p, u, [-0.5,0,0.5], [0.5,0,0.5], [0.25,1,0], [-0.25,1,0]);
  _RT(p, u, [0.5,0,0.5], [0.5,0,-0.5], [0.25,1,0]);
  _RT(p, u, [-0.5,0,-0.5], [-0.5,0,0.5], [-0.25,1,0]);
  _RQ(p, u, [-0.5,0,-0.5], [0.5,0,-0.5], [0.5,0,0.5], [-0.5,0,0.5]);
  return _roofGeo(p, u);
})();
const SHED_GEO = (() => { // 片流れ(z-側が高い楔形。箱を傾けると出る側面の隙間が出ない)
  const p = [], u = [];
  _RQ(p, u, [-0.5,0,0.5], [0.5,0,0.5], [0.5,1,-0.5], [-0.5,1,-0.5]);
  _RQ(p, u, [0.5,0,-0.5], [-0.5,0,-0.5], [-0.5,1,-0.5], [0.5,1,-0.5]);
  _RT(p, u, [0.5,0,0.5], [0.5,0,-0.5], [0.5,1,-0.5]);
  _RT(p, u, [-0.5,0,-0.5], [-0.5,0,0.5], [-0.5,1,-0.5]);
  _RQ(p, u, [-0.5,0,-0.5], [0.5,0,-0.5], [0.5,0,0.5], [-0.5,0,0.5]);
  return _roofGeo(p, u);
})();
const PARAPET_GEO = (() => { // 陸屋根のパラペット(4辺の立ち上がり壁を1ジオメトリに)
  const p = [], u = [];
  const q = (a, b, c, d) => { p.push(...a, ...b, ...c, ...a, ...c, ...d); u.push(0,0, 1,0, 1,1, 0,0, 1,1, 0,1); };
  const box = (x0, y0, z0, x1, y1, z1) => {
    q([x1,y0,z1], [x1,y0,z0], [x1,y1,z0], [x1,y1,z1]);
    q([x0,y0,z0], [x0,y0,z1], [x0,y1,z1], [x0,y1,z0]);
    q([x0,y1,z1], [x1,y1,z1], [x1,y1,z0], [x0,y1,z0]);
    q([x0,y0,z1], [x1,y0,z1], [x1,y1,z1], [x0,y1,z1]);
    q([x1,y0,z0], [x0,y0,z0], [x0,y1,z0], [x1,y1,z0]);
  };
  box(-0.5, 0, -0.5, 0.5, 1, -0.47);
  box(-0.5, 0, 0.47, 0.5, 1, 0.5);
  box(-0.5, 0, -0.47, -0.47, 1, 0.47);
  box(0.47, 0, -0.47, 0.5, 1, 0.47);
  return _roofGeo(p, u);
})();

// 屋根表面のテクスチャ(グレースケールで描き、マテリアル色で着色 → 1テクスチャを全色で共有)
const ROOF_TEXS = {};
function roofTex(kindT) {
  if (ROOF_TEXS[kindT]) return ROOF_TEXS[kindT];
  const c = document.createElement('canvas'); c.width = c.height = 64;
  const g = c.getContext('2d');
  if (kindT === 'tile') { // 瓦の横段+縦の継ぎ目
    g.fillStyle = '#c4c4c4'; g.fillRect(0, 0, 64, 64);
    for (let y = 0; y < 64; y += 8) {
      g.fillStyle = '#888888'; g.fillRect(0, y + 6, 64, 2);
      g.fillStyle = '#adadad';
      for (let x = ((y / 8) % 2) * 8; x < 64; x += 16) g.fillRect(x, y + 1, 1, 5);
    }
  } else if (kindT === 'thatch') { // 茅葺きの縦筋+刈り込みの段
    g.fillStyle = '#b8b8b8'; g.fillRect(0, 0, 64, 64);
    for (let i = 0; i < 240; i++) {
      g.fillStyle = Math.random() < 0.5 ? 'rgba(70,70,70,0.25)' : 'rgba(230,230,230,0.2)';
      g.fillRect((Math.random() * 64) | 0, (Math.random() * 64) | 0, 1, (3 + Math.random() * 6) | 0);
    }
    g.fillStyle = 'rgba(60,60,60,0.25)';
    for (let y = 14; y < 64; y += 16) g.fillRect(0, y, 64, 2);
  } else { // stripe: メルヘンのしま屋根
    g.fillStyle = '#ffffff'; g.fillRect(0, 0, 64, 64);
    g.fillStyle = '#c8c8c8';
    for (let x = 0; x < 64; x += 16) g.fillRect(x, 0, 8, 64);
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapS = t.wrapT = THREE.RepeatWrapping;
  ROOF_TEXS[kindT] = t;
  return t;
}
const roofMatCache = new Map();
function roofSurfMat(color, kindT) {
  const key = (kindT || 'plain') + '_' + color;
  let m = roofMatCache.get(key);
  if (!m) {
    m = new THREE.MeshLambertMaterial(kindT ? { color, map: roofTex(kindT) } : { color });
    roofMatCache.set(key, m);
  }
  return m;
}

// ======= 建物ディテール用の共有ジオメトリ・マテリアル =======
const UNIT_BOX = new THREE.BoxGeometry(1, 1, 1);
const UNIT_CYL = new THREE.CylinderGeometry(0.5, 0.5, 1, 8);
const UNIT_CONE4 = new THREE.ConeGeometry(0.5, 1, 4);
const UNIT_CONE8 = new THREE.ConeGeometry(0.5, 1, 8);
const UNIT_DOME = new THREE.SphereGeometry(0.5, 10, 6, 0, Math.PI * 2, 0, Math.PI / 2);
const UNIT_SPH = new THREE.SphereGeometry(0.5, 8, 8);
const UNIT_PLANE = new THREE.PlaneGeometry(1, 1);
[UNIT_BOX, UNIT_CYL, UNIT_CONE4, UNIT_CONE8, UNIT_DOME, UNIT_SPH, UNIT_PLANE].forEach(gg => gg.userData.shared = true);
function detailMesh(geo, mat, x, y, z, sx, sy, sz, ry) {
  const m = new THREE.Mesh(geo, mat);
  m.position.set(x, y, z);
  m.scale.set(sx, sy, sz);
  if (ry) m.rotation.y = ry;
  m.renderOrder = 2;
  scene.add(m);
  return m;
}
// 追加ディテール(玄関庇・屋上設備等)は建物が多い時は自動で省略(ドローコール抑制。
// minimapBuildings はチャンクアンロードで減るため自動的に釣り合う)。
// 高密度化(現実モード)に合わせて閾値を700→850に微増(プレイヤー近傍の建物が優先的に得る)
const detailOK = () => minimapBuildings.length < 850;
const ROOF_COLS = [0x555a66, 0x7a4a3a, 0x4a5a3a, 0x69463c, 0x3f4c59, 0x8a4038]; // 住宅屋根の色バリエーション

// ======= building=タグを持つrelation(マルチポリゴン)の取り込み(2026-07-15) =======
// 【経緯】これまでOverpassクエリは一貫して way["building"] しか要求しておらず、
// relation["building"](マルチポリゴン。複合施設や、輪郭が複雑/中庭を持つビル等でよく
// 使われる書き方で、大きめのマンション・商業ビルほどこの形式で描かれていることが珍しくない)
// は取得すらしていなかった。つまり地図上には確かに大きな建物の枠が見えているのに、
// 生成システムにはそのデータが一切渡っていなかった(「ジャンプ用マップには大きな
// マンションの枠があるのに、生成では戸建て住宅の集まりになっている」不具合の実体)。
// その空白地に、周辺の道路密度から「住宅街だろう」と推測する手続き生成の戸建て充填
// (generateChunk)が代わりに埋めてしまい、あたかも「マンションのはずが戸建ての集合」に
// 見えていた。relation自体を新たに描画対象にするのではなく、outerメンバー(通常1つ)の
// 座標列を、既存のway処理と同じ形(type:'way', tags, geometry)に変換してdata.elementsへ
// 合成することで、既存のbuilding処理ループにそのまま乗せる(新しい描画パスを増やさない)。
// innerメンバー(中庭等の穴)は現状のバウンディングボックス近似ではどのみち反映できないため無視する。
function synthesizeBuildingRelationWays(elements, seenRelations) {
  const synth = [];
  for (const el of elements) {
    if (el.type !== 'relation' || !el.tags || !el.tags.building || !el.members) continue;
    if (seenRelations) {
      if (seenRelations.has(el.id)) continue;
      seenRelations.add(el.id);
    }
    for (const m of el.members) {
      if (m.role === 'outer' && m.geometry && m.geometry.length >= 4) {
        synth.push({ type: 'way', id: 'rel' + el.id + '_' + synth.length, tags: el.tags, geometry: m.geometry });
      }
    }
  }
  return synth;
}

// ======= 国別の建物フォールバック・プロファイル(現実モード限定) =======
// OSMの実測タグ(building:colour/roof:colour/roof:shape/roof:material/building:levels等)は
// 常に最優先。ここは「タグが無い場所だけ」効く既定値を国/様式ごとに分布(範囲・重み)で
// 持たせたもので、単一の決め打ち外観にはしない(同じ国の中でも一様にならないように)。
// 参照される既存ジオメトリ(GABLE_GEO/HIP_GEO/SHED_GEO)はpart3.js側で解決するため、
// ここでは文字列キー('gable'|'hip'|'flat'|'shed')だけを持つ。
//
// 密度・敷地の空き具合は2箇所にだけ効かせる:
// ①lotPaddingRange = 建物の実フットプリント(位置・サイズ)はそのままに、周囲へ描く
//   芝生/舗装の縁取りの幅(m)。実測データを書き換えないので「現実の地図と答え合わせ」
//   という前提を壊さない。
// ②fallbackGridSpacing/fallbackFillProbability = OSM取得が完全に失敗した時だけの
//   プレースホルダー生成(buildFallbackMap)用。ここは元々位置が全部架空なので自由に調整できる。
const REGION_PROFILES = {
  denseHighRise: { // 香港・シンガポール的な高層密集
    wallPalette: [0xb8c0c8, 0xc8ccd0, 0xa8b0b8, 0xd0d4d8, 0x98a0a8],
    roofPalette: [0x707880, 0x606870, 0x585f68],
    roofShapeWeights: { flat: 0.85, hip: 0.1, gable: 0.05 },
    roofMaterialBias: null, // コンクリ陸屋根のまま(瓦にしない)
    levelsRange: [4, 18],   // タグ欠損時のフォールバック階数
    minLevels: 6,           // 実測タグがあっても最低6階は確保(高密度地区が低層だらけに見えないように)
    flatRoofHeightThreshold: 7,
    lotPaddingRange: [0, 0.3],
    lotSurfaceColor: 0x9098a0, // 舗装(余白自体がほぼ無いので目立たない)
    fallbackGridSpacing: 18, fallbackFillProbability: 0.9,
  },
  sprawlingSuburban: { // アメリカ郊外的な広い敷地・低層
    wallPalette: [0xe8dcc8, 0xd8c8a8, 0xc8d0b8, 0xe0d0d0, 0xd8dce0, 0xe4d8c0],
    roofPalette: [0x5a4a3a, 0x6a5848, 0x4a4038, 0x3a3430],
    roofShapeWeights: { hip: 0.5, gable: 0.4, flat: 0.1 },
    roofMaterialBias: null,
    levelsRange: [1, 2],
    flatRoofHeightThreshold: 12,
    lotPaddingRange: [4, 10],
    lotSurfaceColor: 0x5a8a3d, // 広い芝生の庭
    fallbackGridSpacing: 55, fallbackFillProbability: 0.35,
  },
  europeanOldTown: { // 急勾配屋根・石壁の旧市街(マンサードは未実装のためgable/hipで代用)
    wallPalette: [0xd8c8a8, 0xc0b090, 0xe0d0b0, 0xb8a888, 0xccbfa0],
    roofPalette: [0x2a3038, 0x384048, 0x40342c],
    roofShapeWeights: { gable: 0.55, hip: 0.35, flat: 0.1 },
    roofMaterialBias: 'tile',
    levelsRange: [2, 5],
    flatRoofHeightThreshold: 14,
    lotPaddingRange: [0.3, 1],
    lotSurfaceColor: 0xb0a888, // 石畳
    fallbackGridSpacing: 22, fallbackFillProbability: 0.75,
  },
  aridFlatRoof: { // 乾燥地域の陸屋根・土色壁(気候由来。文化的な決めつけは避け気候基準のみで採用)
    wallPalette: [0xe0cca0, 0xd8c090, 0xe8d8b0, 0xccb488, 0xe0c8a0],
    roofPalette: [0xc8b088, 0xd0bc98],
    roofShapeWeights: { flat: 0.9, hip: 0.1 },
    roofMaterialBias: null,
    levelsRange: [1, 4],
    flatRoofHeightThreshold: 6,
    lotPaddingRange: [0.5, 2],
    lotSurfaceColor: 0xd8c090, // 砂地
    fallbackGridSpacing: 30, fallbackFillProbability: 0.5,
  },
};
// 個別に作り込んだ国(必要になったものから追加)。無ければREGION_FALLBACK_BY_COUNTRYへ、
// それも無ければnull(=現状通りDEFAULT_WALLS_REAL/ROOF_COLS等の既定値。壊れない)。
const COUNTRY_BUILDING_PROFILES = {
  hk: REGION_PROFILES.denseHighRise,
  us: REGION_PROFILES.sprawlingSuburban,
};
// 個別プロファイルが無い国の地域バケツ割り当て。判断根拠が薄い国は入れず未設定のまま
// (=既定値)にとどめる。「わからない国は現状維持」を明示的なデフォルトにすることで、
// 憶測でのステレオタイプ化を避ける(§前段の議論どおり)。
const REGION_FALLBACK_BY_COUNTRY = {
  sg: 'denseHighRise',
  ae: 'aridFlatRoof', sa: 'aridFlatRoof', qa: 'aridFlatRoof', kw: 'aridFlatRoof',
  om: 'aridFlatRoof', bh: 'aridFlatRoof', eg: 'aridFlatRoof', ma: 'aridFlatRoof',
  dz: 'aridFlatRoof', tn: 'aridFlatRoof', ly: 'aridFlatRoof',
  gb: 'europeanOldTown', fr: 'europeanOldTown', de: 'europeanOldTown', it: 'europeanOldTown',
  es: 'europeanOldTown', pt: 'europeanOldTown', nl: 'europeanOldTown', be: 'europeanOldTown',
  at: 'europeanOldTown', ch: 'europeanOldTown', ie: 'europeanOldTown', dk: 'europeanOldTown',
  se: 'europeanOldTown', no: 'europeanOldTown', fi: 'europeanOldTown', pl: 'europeanOldTown',
  cz: 'europeanOldTown',
  ca: 'sprawlingSuburban', au: 'sprawlingSuburban', nz: 'sprawlingSuburban',
};
function getCountryBuildingProfile(cc) {
  if (!cc) return null;
  return COUNTRY_BUILDING_PROFILES[cc] || REGION_PROFILES[REGION_FALLBACK_BY_COUNTRY[cc]] || null;
}
// 実測density(このバッチの建物フットプリント被覆率)が高いエリアは、国プロファイルに
// 関わらずdenseHighRise相当の高層扱いに上書きする。国単位の固定ルールだけだと、同じ国の
// 中でも都心部(例: マンハッタン)と郊外の違いを表現できない(「USも高密度地帯は高層ビルにして」)。
// 棟数(buildings/km²)ではなく敷地被覆率(建物面積の合計/エリア面積)を見るのは、
// マンハッタンのように「棟数は多くないが1棟が巨大」な高層街区でも正しく検出するため
// (棟数基準だと、狭い区画がぎっしり並ぶ香港型の密集地しか拾えない)。
// 閾値0.22は、郊外の戸建て(被覆率5〜10%程度)と都心の高層街区(20〜40%超)の中間より
// 都心寄りに設定し、普通の住宅密集地までは高層化しないようにしている。
const DENSE_URBAN_COVERAGE_RATIO = 0.22;
function applyLocalDensityOverride(baseProfile, footprintAreaM2, areaM2) {
  if (areaM2 > 0 && (footprintAreaM2 / areaM2) >= DENSE_URBAN_COVERAGE_RATIO) {
    return REGION_PROFILES.denseHighRise;
  }
  return baseProfile;
}
// ======= 局所密度判定のグリッド化(2026-07-14) =======
// 【経緯】当初のapplyLocalDensityOverrideは「1バッチ全体で1つの被覆率」しか見ておらず、
// (旧estimateFootprintAreaM2で建物フットプリント合計を求め、バッチの地理的な広さで割るだけの
// 単純な比較だった)。バッチ=part6.jsの初期ロードなら伊勢原OSM_BOUNDS全体(約12km²)、
// part8.jsの歩行時取得なら最大6タイル分(約15km²)と、どちらも「駅前の密集地〜田畑」が
// 同時に混ざりうる広さがある。その結果、実機検証で以下の二重の誤判定が発生した:
//   (a) 伊勢原: 駅前が押し上げた平均被覆率が閾値を超え、同じバッチ内の田畑の建物までまとめて
//       高層(denseHighRise)化されてしまい、田園地帯にペンシルビルが林立する不具合。
//   (b) ニューヨーク等: 逆に、広い道路・公園・河川を含む同バッチの平均で薄まり、実際は
//       密集した街区(マンハッタンの一角等)でも閾値を割ってしまい、高層化が発動しない不具合。
// どちらも「バッチという単位が地理的に広すぎる」ことが原因なので、バッチをDENSITY_CELL_M四方の
// 格子に分割し、セルごとに被覆率を集計→判定する。セルは「概ね1〜数区画」程度の大きさを狙い、
// 細かすぎて同じ通り沿いで階数がバラバラになる(既存のバッチ単位設計が避けたかった見た目のブレ)
// ことも、粗すぎて密集地と農地を混同することも避ける。
const DENSITY_CELL_M = 250;
// elements内の建物フットプリントを、ワールド座標のDENSITY_CELL_M格子セルごとに集計する。
// 戻り値はセルキー("cx,cz")→合計フットプリント面積(m2)のMap。
function computeLocalDensityGrid(elements) {
  const cellFootprint = new Map();
  for (const el of elements) {
    if (el.type !== 'way' || !el.tags || !el.tags.building || !el.geometry || el.geometry.length < 4) continue;
    const pts = el.geometry.map(g => latLonToXZ(g.lat, g.lon));
    let cx = 0, cz = 0;
    pts.forEach(p => { cx += p.x; cz += p.z; });
    cx /= pts.length; cz /= pts.length;
    let maxDx = 0, maxDz = 0;
    pts.forEach(p => { maxDx = Math.max(maxDx, Math.abs(p.x - cx)); maxDz = Math.max(maxDz, Math.abs(p.z - cz)); });
    const area = Math.max(maxDx * 2, 2) * Math.max(maxDz * 2, 2);
    const key = Math.floor(cx / DENSITY_CELL_M) + ',' + Math.floor(cz / DENSITY_CELL_M);
    cellFootprint.set(key, (cellFootprint.get(key) || 0) + area);
  }
  return cellFootprint;
}
// ======= 農地近接による高層化抑制(2026-07-14) =======
// 【経緯】250mセル化(上記)だけでは、伊勢原のような「駅前は確かに密集しているが、
// 徒歩圏内には田畑が広がる」地域まで、局所的な被覆率だけで高層(denseHighRise)化して
// しまうケースが実機で残った。マンハッタンのような正真正銘の都心には、そもそも周囲数km
// 以内に田畑は存在しない。「セル単体の被覆率」に加えて「そもそも田園地帯の中の一角に
// 過ぎないか」を見ることで、都心か町場かをより正しく見分ける。
// FARMLAND_CELL_Mは密度セル(250m)よりずっと広い格子で「近くに田畑があるか」だけを
// 大まかに判定する(田畑ポリゴン自体の被覆率は問わない。存在するかどうかの二値判定)。
const FARMLAND_CELL_M = 1000;
const FARMLAND_CHECK_RADIUS_CELLS = 2; // 中心±2セル=約5km四方(概ね半径2〜2.5km圏内)を「近く」とみなす
const FARMLAND_LANDUSE = new Set(['farmland', 'orchard', 'meadow', 'allotments']);
// elements内のlanduse=farmland/orchard/meadow/allotmentsポリゴンの頂点から、
// それらが属するFARMLAND_CELL_M格子セルの集合を作る(computeLocalDensityGridと対になる関数)。
function computeFarmlandCells(elements) {
  const cells = new Set();
  for (const el of elements) {
    if (el.type !== 'way' || !el.tags || !FARMLAND_LANDUSE.has(el.tags.landuse) || !el.geometry || el.geometry.length < 3) continue;
    for (const g of el.geometry) {
      const p = latLonToXZ(g.lat, g.lon);
      cells.add(Math.floor(p.x / FARMLAND_CELL_M) + ',' + Math.floor(p.z / FARMLAND_CELL_M));
    }
  }
  return cells;
}
// 座標(x,z)の周囲FARMLAND_CHECK_RADIUS_CELLS圏内に田畑セルが1つでもあればtrue。
function hasFarmlandNear(farmlandCells, x, z) {
  if (!farmlandCells || farmlandCells.size === 0) return false;
  const gx = Math.floor(x / FARMLAND_CELL_M), gz = Math.floor(z / FARMLAND_CELL_M);
  for (let dx = -FARMLAND_CHECK_RADIUS_CELLS; dx <= FARMLAND_CHECK_RADIUS_CELLS; dx++)
    for (let dz = -FARMLAND_CHECK_RADIUS_CELLS; dz <= FARMLAND_CHECK_RADIUS_CELLS; dz++)
      if (farmlandCells.has((gx + dx) + ',' + (gz + dz))) return true;
  return false;
}
// ======= 駅密集(ターミナル駅)による強制高層化(2026-07-14) =======
// 【経緯】250mセルの被覆率判定だけだと、東京・NYのような真の都心部でも、広い道路・
// 広場を含むセルでは被覆率が閾値(0.22)を割り、denseHighRise化が発動しないケースが
// 実機で多く残った(footprint近似の精度限界)。ユーザー提案: 「駅が複数集まっている
// エリアは強制的に高層ビル区域にする」— 新宿・渋谷・東京や、グランドセントラル・
// ユニオンスクエア等の主要ターミナルは、JR・私鉄・地下鉄の各事業者が別々のnodeとして
// 隣接して打たれていることが多く(=同じ場所に複数の駅ノード)、「至近距離に複数の駅」は
// 被覆率よりもずっと当てにできる「ここは正真正銘の都心」シグナルになる。
// 駅ノード自体はOSM_TILE_CLAUSES/初期クエリで既に取得済み(railway=station/halt,
// public_transport=station)なので、新たな通信は増やさない。
const STATION_HUB_RADIUS_M = 1000; // 「至近距離」の半径(ユーザー指定により400→1000mに拡大)
const STATION_HUB_MIN_COUNT = 2;  // これ以上の駅ノードが半径内にあればターミナル駅とみなす
// 【重要】駅ノードは1回のOverpassバッチ(1タイル、または近い順に最大6タイル分)でしか
// 見えない。至近距離に複数の駅があっても、それらが別々のタイル取得バッチに分かれて届くと
// 「このバッチ単体では駅が1つしか映っていない」と誤判定され、実質ターミナル駅判定が
// 機能しなくなる(実機検証: NYの複数駅至近エリアでも低層住宅のままになる不具合の原因)。
// バッチをまたいで判定できるよう、駅ノードはページ読み込み中ずっと(ノードIDで重複排除
// しつつ)蓄積し、判定時は蓄積済みの全駅を対象にする。遠方ジャンプはlocation.reload()を
// 伴うため(jumpToLatLon参照)、モジュール変数はそのタイミングで自然に空になり、
// 座標系(浮動原点)の不整合を心配する必要はない。
const globalStationPoints = new Map(); // ノードID → {x,z}
// elements内の駅ノード(railway=station/halt, public_transport=station)をグローバルに登録する。
function registerStationPoints(elements) {
  for (const el of elements) {
    if (el.type !== 'node' || !el.tags || globalStationPoints.has(el.id)) continue;
    const t = el.tags;
    if (t.railway === 'station' || t.railway === 'halt' || t.public_transport === 'station') {
      globalStationPoints.set(el.id, latLonToXZ(el.lat, el.lon));
    }
  }
}
// 座標(x,z)の半径STATION_HUB_RADIUS_M以内に、登録済み駅ノードがSTATION_HUB_MIN_COUNT個以上あるか。
// (駅の総数はセッション全体でもせいぜい数百件程度なので、建物ごとの線形走査で十分軽い)
function isStationHubNear(x, z) {
  if (globalStationPoints.size < STATION_HUB_MIN_COUNT) return false;
  const r2 = STATION_HUB_RADIUS_M * STATION_HUB_RADIUS_M;
  let n = 0;
  for (const s of globalStationPoints.values()) {
    const dx = s.x - x, dz = s.z - z;
    if (dx * dx + dz * dz <= r2 && ++n >= STATION_HUB_MIN_COUNT) return true;
  }
  return false;
}
// 指定座標(建物の重心x,z)が属するセルの被覆率で、その建物1棟分のプロファイルを決める。
// gridがnull(現実モード以外、またはOSM要素が無いバッチ)ならbaseProfileをそのまま返す。
// セル面積は常にDENSITY_CELL_M四方の固定値(セル自体の大きさは地理的に変わらないため)。
// 判定の優先順位: ①ターミナル駅近接(最有力の都心シグナル。田畑近接より優先)
// →②田畑近接(高層化を抑制)→③250mセルの被覆率(通常の判定)。
function localDensityProfileAt(baseProfile, grid, x, z, farmlandCells) {
  if (isStationHubNear(x, z)) return REGION_PROFILES.denseHighRise;
  if (hasFarmlandNear(farmlandCells, x, z)) return baseProfile; // 田畑近接 → 高層化しない
  if (!grid) return baseProfile;
  const key = Math.floor(x / DENSITY_CELL_M) + ',' + Math.floor(z / DENSITY_CELL_M);
  const footprint = grid.get(key) || 0;
  return applyLocalDensityOverride(baseProfile, footprint, DENSITY_CELL_M * DENSITY_CELL_M);
}
// roofShapeWeights({flat,gable,hip,shed}の一部だけでも可)から1つ重み付き抽選する。
// タグ('roof:shape')がある建物には使わない — あくまでタグ欠損時のフォールバック専用。
function pickWeighted(weights) {
  const keys = Object.keys(weights);
  const total = keys.reduce((s, k) => s + (weights[k] || 0), 0);
  if (total <= 0) return null;
  let r = Math.random() * total;
  for (const k of keys) {
    r -= weights[k] || 0;
    if (r <= 0) return k;
  }
  return keys[keys.length - 1];
}

const ENTRANCE_MAT = new THREE.MeshBasicMaterial({ color: 0x1a2430 }); // ビル1階の玄関ガラス
const TANK_MAT = new THREE.MeshLambertMaterial({ color: 0xd8d4c8 });   // 屋上貯水槽
const AC_MAT = new THREE.MeshLambertMaterial({ color: 0xb8bcc0 });     // 室外機
const CROSS_MAT = new THREE.MeshBasicMaterial({ color: 0xff0000 });    // 病院の十字

// ======= 小物インスタンシング基盤 =======
// 電柱・木・自販機・ガードレール等は種類ごとに1つの InstancedMesh(=1ドローコール)。
// 上限(max)を超えた分は追加されないため、負荷は上限で頭打ちになる。
const _dummy = new THREE.Object3D();
const _tmpColor = new THREE.Color();
function makePool(geo, mat, max) {
  const m = new THREE.InstancedMesh(geo, mat, max);
  m.count = 0;
  m.frustumCulled = false; // インスタンスが広域に散るため全体カリング無効(1ドローコールなので安い)
  scene.add(m);
  return { mesh: m, max, n: 0 };
}
// 注意: 同じプールでは color を「常に渡す」か「常に渡さない」かを統一する
// (instanceColor バッファは初期値0=黒のため混在させると未設定分が黒くなる)
function poolAdd(pool, x, y, z, ry, sx, sy, sz, color) {
  if (pool.n >= pool.max) return -1;
  const idx = pool.n; // 呼び出し元がインスタンス番号を覚えておけば、後から位置だけ更新できる
  _dummy.position.set(x, y, z);
  _dummy.rotation.set(0, ry || 0, 0);
  _dummy.scale.set(sx || 1, sy || 1, sz || 1);
  _dummy.updateMatrix();
  pool.mesh.setMatrixAt(idx, _dummy.matrix);
  if (color !== undefined) pool.mesh.setColorAt(idx, _tmpColor.setHex(color));
  pool.n++;
  pool.mesh.count = pool.n;
  pool.mesh.instanceMatrix.needsUpdate = true;
  if (pool.mesh.instanceColor) pool.mesh.instanceColor.needsUpdate = true;
  return idx;
}
// 指定インスタンスのY位置だけ書き換える(向き・スケール・XZは維持)。
// 橋脚など「地形更新に追従して高さだけ直したい」インスタンスの再配置に使う。
const _instMat = new THREE.Matrix4(), _instPos = new THREE.Vector3(),
      _instQuat = new THREE.Quaternion(), _instScale = new THREE.Vector3();
function poolSetY(pool, idx, newY) {
  if (idx == null || idx < 0) return;
  pool.mesh.getMatrixAt(idx, _instMat);
  _instMat.decompose(_instPos, _instQuat, _instScale);
  _instPos.y = newY;
  _instMat.compose(_instPos, _instQuat, _instScale);
  pool.mesh.setMatrixAt(idx, _instMat);
  pool.mesh.instanceMatrix.needsUpdate = true;
}
// プールのジオメトリ・マテリアルはモードで決める(生成ロジック側は共通)
// 電柱: 江戸=木柱(行灯付き) / メルヘン=ピンクのキャンディ街灯 / 宇宙=発光エネルギーポール
const poleP = makePool(new THREE.CylinderGeometry(0.11, 0.16, 8, 6),
  MODE === 'edo'     ? new THREE.MeshLambertMaterial({ color: 0x6a4a2a }) :
  MODE === 'marchen' ? new THREE.MeshLambertMaterial({ color: 0xff9bb8 }) :
  MODE === 'space'   ? new THREE.MeshLambertMaterial({ color: 0x223344, emissive: 0x2266ff, emissiveIntensity: 0.9 }) :
                       new THREE.MeshLambertMaterial({ color: 0x776a5c }), 3000);
const TREE_MAX = USES_MEIJI_LANDUSE ? 5000 : 3500; // 明治・江戸は里山・並木で木が主役
const treeTrunkP = makePool(new THREE.CylinderGeometry(0.14, 0.24, 1.6, 5), new THREE.MeshLambertMaterial({ color: 0x5a4028 }), TREE_MAX);
// 木の樹冠 treeTopPools は TREE_GREENS 定義後(下方)で作る(instanceColor を使わない単色プール)
// 自販機: 江戸=樽/井戸(木の円筒) / 宇宙=発光キオスク
const vendP = makePool(
  MODE === 'edo' ? new THREE.CylinderGeometry(0.55, 0.65, 1.2, 8) : new THREE.BoxGeometry(1.0, 1.8, 0.75),
  MODE === 'edo'   ? new THREE.MeshLambertMaterial({ color: 0xffffff }) :
  MODE === 'space' ? new THREE.MeshLambertMaterial({ color: 0xffffff, emissive: 0x226688 }) :
                     new THREE.MeshLambertMaterial({ color: 0xffffff, emissive: 0x555544 }), 400);
const guardP     = makePool(new THREE.BoxGeometry(1, 0.32, 0.12), new THREE.MeshLambertMaterial({ color: 0xffffff }), 2500);
const benchP     = makePool(new THREE.BoxGeometry(1.7, 0.4, 0.55), new THREE.MeshLambertMaterial({ color: 0x8a6a40 }), 400);
// 標識: 江戸=高札(木板) / 宇宙=ネオンパネル
const signBoardP = makePool(new THREE.BoxGeometry(1.0, 0.75, 0.06),
  MODE === 'edo'   ? new THREE.MeshLambertMaterial({ color: 0x8a6a4a }) :
  MODE === 'space' ? new THREE.MeshBasicMaterial({ color: 0x22ddff }) :
  MODE === 'marchen' ? new THREE.MeshLambertMaterial({ color: 0xff88bb }) :
                     new THREE.MeshLambertMaterial({ color: 0x2255cc, emissive: 0x112244 }), 400);
// 行灯/キャンディ玉を全電柱に付けるモードは上限を拡大
const POLE_ORB = MODE === 'edo' ? 0xffb050 : MODE === 'marchen' ? 0xffe080 : null;
const lampP      = makePool(new THREE.BoxGeometry(0.3, 0.3, 0.3), new THREE.MeshBasicMaterial({ color: 0xffffff }), POLE_ORB ? 3500 : 700);
// 明治では signalP を道祖神(石)として使う
const signalP    = makePool(
  IS_MEIJI ? new THREE.BoxGeometry(0.6, 0.9, 0.45) : new THREE.BoxGeometry(1.1, 0.38, 0.35),
  IS_MEIJI ? new THREE.MeshLambertMaterial({ color: 0x8a8a82 }) : new THREE.MeshLambertMaterial({ color: 0x333338 }), IS_MEIJI ? 600 : 300);
const TREE_GREENS = MODE === 'marchen' ? [0x7be3a0, 0xffb0d0, 0xa0e8ff]
                  : MODE === 'space'   ? [0x66eeff, 0xbb88ff, 0x66ffbb]
                  : [0x2e6b2e, 0x3a7a33, 0x27632f];
// 木の樹冠プール: instanceColor(色付きインスタンス)がこの環境では描画されず樹冠が消えるため、
// 色ごとに単色マテリアルのプールを分ける(幹と同じ=確実に描画される方式)。宇宙はクリスタル。
const _treeTopGeo = MODE === 'space' ? new THREE.ConeGeometry(0.9, 2.6, 5) : new THREE.SphereGeometry(1.3, 6, 5);
const treeTopPools = TREE_GREENS.map(c => makePool(_treeTopGeo,
  MODE === 'space' ? new THREE.MeshLambertMaterial({ color: c, transparent: true, opacity: 0.85, emissive: 0x224466 })
                   : new THREE.MeshLambertMaterial({ color: c }), TREE_MAX));

// ======= 山の森 =======
// 【重要】treeTopP(街路樹の樹冠)は instanceColor を使うが、この環境では
// 色付き樹冠インスタンスが描画されず「幹だけ」になってしまう(街路樹も同様)。
// そこで森の樹冠は instanceColor を使わず、緑を焼き込んだ単色マテリアルのプールで描く
// (幹プールと同じ=確実に描画される方式)。色違いを数プール用意して単調さを避ける。
const forestLeafColors = MODE === 'space'   ? [0x66eeff, 0x88ffcc, 0xbb99ff]
                       : MODE === 'marchen' ? [0x74d98f, 0x9be0a0, 0xff9ecb]
                       : MODE === 'edo'     ? [0x4f7a3a, 0x5c8a40, 0x668f45]
                       : MODE === 'meiji'   ? [0x5a8a3a, 0x4f7a33, 0x6a9a45]
                       : [0x2f7a33, 0x3f9a3a, 0x276b2c]; // 現実: はっきりした森の緑
const forestTrunkMat = new THREE.MeshLambertMaterial({ color: MODE === 'space' ? 0x2a3a4a : 0x4a3524 });
// プレイヤー周囲の一定範囲だけを描くため上限は控えめ(常時描画=重いので)。低ポリの樹冠で軽量化。
const forestTrunkP = makePool(new THREE.CylinderGeometry(0.16, 0.26, 2.0, 5), forestTrunkMat, 2600);
const forestLeafPools = forestLeafColors.map(c => makePool(
  MODE === 'space' ? new THREE.ConeGeometry(1.1, 3.0, 5) : new THREE.SphereGeometry(1.4, 5, 4),
  new THREE.MeshLambertMaterial({ color: c }),           // 単色 → instanceColor 不要で確実に描画
  1000)); // 3プール計3000 ≥ 幹2600 なので、樹冠だけ残る(幹上限が先に尽きる)心配なし
// 木の見た目は「位置から決定」する(乱数を使わない)。こうすると森を再構築しても
// 同じ場所には同じ木が並び、ちらつき・入れ替わりが起きない。
function _fhash(a, b) { let h = (a * 374761393 + b * 668265263) | 0; h = (h ^ (h >> 13)) * 1274126177 | 0; return ((h ^ (h >> 16)) >>> 0) / 4294967296; }
function plantTree(x, z) {
  if (MODE === 'space') return; // 宇宙: 大気が無いため植生(三角錐のクリスタル樹)は生やさない
  if (forestTrunkP.n >= forestTrunkP.max) return; // 幹が上限なら木ごと追加しない(浮いた樹冠防止)
  const gy = getGroundY(x, z);
  const r1 = _fhash(Math.floor(x * 7.3), Math.floor(z * 7.3));
  const s = 0.9 + r1 * 1.3;
  const rot = _fhash(Math.floor(x * 3.1) + 7, Math.floor(z * 5.7) + 3) * 6.283;
  const leaf = forestLeafPools[(Math.floor(Math.abs(x) * 1.7 + Math.abs(z) * 2.3)) % forestLeafPools.length];
  poolAdd(forestTrunkP, x, gy + 1.0 * s, z, 0, s, s, s);              // 幹: 根元を gy に
  poolAdd(leaf, x, gy + 2.6 * s, z, rot, s * 1.25, s * 1.3, s * 1.25); // 樹冠: 幹の上に載る球(単色)
}
// 道路小物のモード別ふるまい
const PROP_SIGNALS = MODE !== 'edo';                  // 江戸に信号はない
const PROP_GUARD_C = MODE === 'edo' ? 0x8a6a48 : MODE === 'marchen' ? 0xffc8d8 : MODE === 'space' ? 0x2288ff : 0xf0f0f0; // 江戸=木柵
const PROP_VEND_COLORS = MODE === 'edo' ? [0x7a5a38, 0x6a4a2a, 0x8a6a48]
                       : MODE === 'space' ? [0x22ccff, 0xff44cc, 0x66ffcc]
                       : [0xff4444, 0x4488ff, 0xffffff];
const PROP_VEND_Y = MODE === 'edo' ? 0.6 : 0.9;

// 電柱・電線(2026-07-15撤去): ただの装飾でゲームプレイに寄与しない割に、道路1本ごとに
// 数本ずつ増える電柱メッシュ・電線セグメント・resnap処理(地形更新のたびのY座標追従)が
// リソースを食っていたため、生成そのものをやめた(decorateRoad参照)。これに伴い、
// 電線専用のLineSegments/バッファ/addWireSeg/setWireSegY、道路レコードのwireSpans、
// resnapWireSpan(part1.js)もまとめて削除。電柱と共有していたpoleP/lampPインスタンスプール
// (街灯・信号・建物の照明などで引き続き使用)は残す。

function addTree(x, z, s) {
  if (MODE === 'space') return; // 宇宙: 大気が無いため植生(三角錐のクリスタル樹)は生やさない
  const gy = getGroundY(x, z);
  const top = treeTopPools[(Math.random() * treeTopPools.length) | 0]; // 色ごとの単色プールから選ぶ
  poolAdd(treeTrunkP, x, gy + 0.8 * s, z, 0, s, s, s);
  const round = MODE === 'marchen'; // メルヘンは丸っこく
  poolAdd(top, x, gy + 2.3 * s, z, Math.random() * 3,
          s * (round ? 1.3 : 1), s * (round ? 0.95 : 0.9 + Math.random() * 0.5), s * (round ? 1.3 : 1));
}

// ======= 空き地の下草・雑木(疎林) =======
// landuse・実建物・denseAreaのどれの根拠も無い(=OSM上「無所属」の)平地は、家も畑も
// 森も生成されずただの空き地として放置されていた。伊勢原市の実態(山林・原野が
// 市域の1〜2割程度を占める)に近づけるため、そういう土地には低木を疎らに生やす。
// 山の森(plantTree/forestTrunkP)より低密度・低背にして、住宅街の並木(addTree)とも
// 見分けがつくようにする(専用プール・専用関数)。generateChunk() から低頻度で呼ぶ。
const SCRUB_MAX = 2400;
const scrubMat = new THREE.MeshLambertMaterial({
  color: MODE === 'space' ? 0x3a5a4a : MODE === 'marchen' ? 0x8fd9a0 : MODE === 'edo' ? 0x5c7a3a : 0x5a6b3a,
});
const scrubP = makePool(new THREE.SphereGeometry(0.6, 6, 5), scrubMat, SCRUB_MAX);
function plantScrub(x, z) {
  if (scrubP.n >= scrubP.max) return;
  const gy = getGroundY(x, z);
  const r1 = _fhash(Math.floor(x * 9.1) + 11, Math.floor(z * 9.1) + 5); // 位置から決定的に決める(ちらつき防止)
  const s = 0.5 + r1 * 0.6; // 木よりだいぶ小さい茂み
  poolAdd(scrubP, x, gy + 0.35 * s, z, r1 * 6.283, s, s * (0.7 + r1 * 0.4), s);
}

// 全道路種別中の最大幅(河川60m。waterwayWidthのMath.min(60,...)参照)の半分。
// isOnRoadで「この距離まで探せば取りこぼしがない」近傍セル数を見積もるのに使う。
const MAX_ROAD_HALF_W = 30;
// Returns true if the rectangle (cx,cz,bw,bd) overlaps any road segment
// 【重要】以前はminimapRoads(取得済み全道路。増え続けて減らない)を毎回線形走査していたため、
// 探索が進むほど呼び出しコストが際限なく重くなっていた(長時間プレイでの重量化の主因の一つ)。
// roadGrid(空間ハッシュ)を使い、実際に該当しうる近傍セルだけを見るように変更する。
function isOnRoad(cx, cz, bw, bd) {
  const halfDiag = Math.sqrt(bw*bw + bd*bd) / 2;
  const searchR = MAX_ROAD_HALF_W + halfDiag + 1;
  const cellR = Math.max(1, Math.ceil(searchR / ROAD_CELL)) + 1; // +1はセル境界のずれに対する安全マージン
  const gx = Math.floor(cx / ROAD_CELL), gz = Math.floor(cz / ROAD_CELL);
  for (let dx = -cellR; dx <= cellR; dx++) for (let dz = -cellR; dz <= cellR; dz++) {
    const arr = roadGrid.get((gx + dx) + ',' + (gz + dz));
    if (!arr) continue;
    for (const r of arr) {
      const rdx = r.x2-r.x1, rdz = r.z2-r.z1;
      const len2 = rdx*rdx + rdz*rdz;
      if (len2 < 0.01) continue;
      const t = Math.max(0, Math.min(1, ((cx-r.x1)*rdx + (cz-r.z1)*rdz) / len2));
      const nx = r.x1 + t*rdx - cx, nz = r.z1 + t*rdz - cz;
      const dist = Math.sqrt(nx*nx + nz*nz);
      if (dist < (r.rw||5)/2 + halfDiag + 1) return true; // 1m margin
    }
  }
  return false;
}

// OSMのbuilding:colour/roof:colourタグ(#rrggbb・#rgb・一部の色名)を数値カラーへ変換する。
// 未対応の表記は静かにnullを返し、既存の既定色にフォールバックする(タグ読み取りのみでコストはほぼゼロ)。
const OSM_COLOR_NAMES = {
  white: 0xf0f0ec, black: 0x202020, gray: 0x888888, grey: 0x888888,
  silver: 0xc0c0c0, red: 0xcc3333, green: 0x3a7a3a, blue: 0x3a5a9a,
  yellow: 0xe0c040, orange: 0xd88a30, brown: 0x8a6040, beige: 0xd8c8a0,
  tan: 0xd2b48c, cream: 0xf0e8d0, pink: 0xe8a0b0, purple: 0x7a4a9a,
  darkgray: 0x555555, darkgrey: 0x555555, lightgray: 0xcccccc, lightgrey: 0xcccccc,
  darkgreen: 0x2a5a2a, darkblue: 0x2a3a6a, darkred: 0x8a2222,
  cyan: 0x40b0c0, gold: 0xd4af37, ivory: 0xf0ead6, maroon: 0x7a2a2a,
  navy: 0x1a2a5a, olive: 0x707a30, bronze: 0x8a6a3a, copper: 0xb0684a,
};
function parseOsmColor(v) {
  if (!v) return null;
  const s = String(v).trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(s)) return parseInt(s.slice(1), 16);
  if (/^#[0-9a-f]{3}$/.test(s)) {
    const r = s[1], g = s[2], b = s[3];
    return parseInt(r + r + g + g + b + b, 16);
  }
  return OSM_COLOR_NAMES.hasOwnProperty(s) ? OSM_COLOR_NAMES[s] : null;
}

// Determine building visual style from OSM tags
function getBuildingStyle(tags) {
  const am = tags.amenity || '', rel = tags.religion || '', bt = tags.building || '';
  const name = (tags.name || '') + (tags['name:ja'] || '');
  let style = null;
  if (am === 'place_of_worship' || name.includes('神社') || name.includes('shrine')) {
    if (rel === 'shinto' || name.includes('神社'))
      style = { color: 0xcc2200, roofColor: 0x880000, emissive: 0x440000, type: 'shrine' };
    else if (rel === 'buddhist' || name.includes('寺') || name.includes('院'))
      style = { color: 0x7a5020, roofColor: 0x4a3010, emissive: 0x221100, type: 'temple' };
    else
      style = { color: 0xd4a0a0, roofColor: 0x883333, emissive: 0x220000, type: 'church' };
  } else if (am === 'school' || am === 'university' || am === 'college' || bt === 'school') {
    style = { color: 0xf0e060, roofColor: 0xa09020, emissive: 0x221100, type: 'school' };
  } else if (am === 'hospital' || am === 'clinic' || name.includes('病院')) {
    style = { color: 0xf8f8f8, roofColor: 0xdddddd, emissive: 0x111111, type: 'hospital' };
  } else if (am === 'townhall' || am === 'police' || am === 'fire_station' || name.includes('市役所') || name.includes('役場')) {
    style = { color: 0x6070a0, roofColor: 0x405080, emissive: 0x001133, type: 'government' };
  } else if (tags.shop || am === 'supermarket' || am === 'convenience') {
    // 実際の店構え(コンビニ・商店等)。街灯り演出(のれん/看板バンド等)はこの'shop'型限定。
    style = { color: 0xff8840, roofColor: 0xcc5500, emissive: 0x221100, type: 'shop' };
  } else if (bt === 'office' || tags.office) {
    // オフィスビル(ガラス張り寒色系)。東京・NY等の都心はマンションよりオフィスの方が
    // 多いため、'shop'(店構え演出)とは別の落ち着いた見た目にする。
    style = { color: 0x8090a8, roofColor: 0x505868, emissive: 0x0a1420, type: 'office' };
  } else if (bt === 'commercial' || bt === 'retail') {
    // 【重要】以前はbuilding=commercialを'shop'(明るいオレンジ+のれん/看板バンド等の
    // 店構え演出)に分類していたが、commercialタグは小さな商店からオフィスタワーまで
    // 幅広く使われており、高層のオフィスビルにコンビニ風の演出が付くのは不自然だった。
    // 'office'と同じ落ち着いた見た目にする(退避不要にstyleを直接持つ=OFFICE_STYLEと
    // 値は揃えているが、part3.jsのOFFICE_STYLE定数は使えないのでここでは複製する)。
    style = { color: 0x8090a8, roofColor: 0x505868, emissive: 0x0a1420, type: 'office' };
  } else if (bt === 'apartments') {
    style = { color: 0x90a0c0, roofColor: 0x506080, emissive: 0x001122, type: 'apartment' };
  } else if (bt === 'house' || bt === 'detached' || bt === 'residential') {
    style = { color: 0xd4b070, roofColor: 0x886030, emissive: 0x110800, type: 'house' };
  } else if (bt === 'industrial' || bt === 'warehouse' || bt === 'factory') {
    style = { color: 0x808890, roofColor: 0x505860, emissive: 0x111111, type: 'industrial' };
  }

  // building:colour/roof:colour/roof:shape/roof:material があれば、種別に関わらず上書きする。
  // タグが無い建物は従来通り(この分岐に入らない)なので既存の見た目・負荷は変わらない。
  const wallTag = parseOsmColor(tags['building:colour']);
  const roofTag = parseOsmColor(tags['roof:colour']);
  const roofShape = tags['roof:shape'];
  const roofMaterial = tags['roof:material'];
  if (wallTag != null || roofTag != null || roofShape || roofMaterial) {
    style = Object.assign({ type: 'default' }, style || {});
    if (wallTag != null) style.color = wallTag;
    if (roofTag != null) style.roofColor = roofTag;
    if (roofShape) style.roofShape = roofShape;
    if (roofMaterial) style.roofMaterial = roofMaterial;
  }
  return style; // nullなら従来通りデフォルト紫のランダム
}
