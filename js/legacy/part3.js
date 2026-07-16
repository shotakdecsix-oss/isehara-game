/**
 * legacy/part3.js — index.html の巨大インラインスクリプトを行範囲のまま機械的に切り出した
 * ファイル(3/9)。part2.js の続き。詳細は part1.js 冒頭のコメント参照。
 */
// ======= 建物の高さ・マンション判定(タグが曖昧でも大きさ・高さで見た目を識別可能にする) =======
// building:height(実測m)を最優先、無ければbuilding:levels*3、どちらも無ければ既存通りランダム。
function resolveBuildingHeight(tags) {
  const hTag = parseFloat(tags['building:height']);
  if (Number.isFinite(hTag) && hTag > 0) return hTag;
  const levels = parseInt(tags['building:levels']);
  if (Number.isFinite(levels) && levels > 0) return Math.max(levels * 3, 3);
  return null; // タグから決められない → 呼び出し元の既存ランダム式にフォールバック
}
const APT_HEIGHT_M = 10;      // これ以上の高さは一戸建てタグでもマンション扱いにする
const APT_FOOTPRINT_M2 = 200; // これ以上のフットプリント面積も同様
const APARTMENT_STYLE = { color: 0x90a0c0, roofColor: 0x506080, emissive: 0x001122, type: 'apartment' };
// オフィス・商業ビル用(ガラス張りの寒色系。part2.jsのkind選択で自動的に'office'ファサードになる)
const OFFICE_STYLE = { color: 0x8090a8, roofColor: 0x505868, emissive: 0x0a1420, type: 'office' };
const COMMERCIAL_INDUSTRIAL_STYLE = { color: 0x808890, roofColor: 0x505860, emissive: 0x111111, type: 'industrial' };
// 「高さ・階数・フットプリント面積がある閾値を超えたらタグに関わらずマンション/オフィス扱いに
// する」ルール。house/defaultタイプ(=タグが曖昧、または一戸建てタグだが実際は大きい)だけを対象にする。
// 【重要】以前は style===null(=OSMの building=yes だけでサブタイプ無しの、実際には
// 最も多いパターン)の建物をここで即return してしまい、footprint/高さがどれだけ大きくても
// 判定自体が一切走らなかった。日本のマンション等は建物ポリゴンにbuilding=yesしか付いておらず
// building:levels等の高さタグも無いことが非常に多いため、この分岐のせいで「本来マンション
// 規模のはずの建物が、タグ欠損時のランダム1〜3階(house型ファサード)のまま」になり、
// マンションがあるはずの場所に戸建てが敷き詰められて見える不具合の主因になっていた。
// style===nullは type==='default' 相当として扱う(既存のhouse/default判定と同列に)。
// 【重要・2026-07-15】東京・NYのような都心は住宅よりオフィス・商業ビルの方が多いのに、
// 上記の格上げ先が常に「マンション」一択だった(building=yesの大きい建物は無条件で
// 住宅顔になる)。x,zが分かれば、既に取得済みのlanduse区画(part1.js landuseTypeAt)を
// 見て、商業・工業区画ならオフィス/商業ビル寄りの見た目にする。landuse情報がまだ無い
// (このバッチ自身のlanduseパスがまだ来ていない等)場合は、従来通りマンション扱いに
// フォールバックする(挙動を壊さない既定値)。
function classifyResidential(style, w, d, h, x, z) {
  if (style && style.type !== 'house' && style.type !== 'default') return style;
  if (h >= APT_HEIGHT_M || w * d >= APT_FOOTPRINT_M2) {
    const lu = (x != null && z != null) ? landuseTypeAt(x, z) : null;
    if (lu === 'industrial') return COMMERCIAL_INDUSTRIAL_STYLE;
    if (lu === 'commercial' || lu === 'retail' || lu === 'mixed_use') return OFFICE_STYLE;
    return APARTMENT_STYLE;
  }
  return style;
}

// 学校・病院・役場・神社仏閣は街の目印として際立つべきだが、OSMに高さ/階数タグが
// 無いと既存のランダム式(3〜11m程度)で低く埋もれてしまう。種別が判明しているものだけ
// 最低高さを底上げする(タグの実測値がある場合はresolveBuildingHeightの値を尊重=縮めない)。
const LANDMARK_MIN_H = { school: 7, hospital: 9, government: 8, shrine: 6, temple: 7 };
function applyLandmarkMinHeight(style, h) {
  if (!style) return h;
  const min = LANDMARK_MIN_H[style.type];
  return min ? Math.max(h, min) : h;
}

// 江戸: OSM建物の実測高さ(現代の高層マンション・オフィスビル等)をそのまま使うと、
// 明治(実測データに基づき低層の集落家屋へ全面差し替え済み)より江戸の方が高層建築だらけに
// 見えてしまう(本来は逆で、江戸期の方が古く木造2階建て程度が大半のはず)。
// 神社仏閣・城郭など一部の例外を除き、天井高さを木造家屋相当に抑える。
const EDO_MAX_H = { shrine: 16, temple: 16, church: 16, school: 8, hospital: 8, government: 9, apartment: 8, industrial: 8, shop: 8, office: 8, house: 8, default: 8 };
function applyEdoHeightCap(style, h) {
  const cap = EDO_MAX_H[(style && style.type) || 'default'];
  return Math.min(h, cap != null ? cap : EDO_MAX_H.default);
}
// 同じ理由で建物の「数」も現代の密集度をそのまま使うと多すぎる。
// ランドマーク(神社仏閣)以外は一定確率で間引き、当時の低密度な町並みに近づける。
function shouldSkipEdoBuilding(style) {
  const t = style && style.type;
  if (t === 'shrine' || t === 'temple' || t === 'church') return false;
  return Math.random() < 0.4;
}

// マンション・工場は一戸建てよりはっきり大きく見えるべき。タグ欠落時のランダム
// 高さ/フットプリントが小さすぎて一戸建てと見分けがつかないケースの最低サイズ底上げ
// (実測タグ由来の大きい建物はMath.maxなので縮まない)。
const SIZE_FLOOR = {
  apartment:  { w: 15, d: 12, h: 12 },
  industrial: { w: 20, d: 16, h: 8  },
  office:     { w: 15, d: 12, h: 12 },
};
function applySizeFloor(style, w, d, h) {
  if (!style) return { w, d, h };
  const f = SIZE_FLOOR[style.type];
  if (!f) return { w, d, h };
  return { w: Math.max(w, f.w), d: Math.max(d, f.d), h: Math.max(h, f.h) };
}

// 【2026-07-16】現実モードの壁色バリエーション。同じ国プロファイル・同じstyle.colorでも
// 建物ごとに明暗・寒暖の微差をつける。連続乱数ではなく6種の量子化ティントに限定することで、
// lambertMat/facadeMatの色キーキャッシュが際限なく増殖しない(最大6倍で頭打ち)。
const WALL_TINTS = [
  [0.84, 0.86, 0.90], // 暗め・やや寒色
  [0.93, 0.93, 0.95],
  [1.00, 1.00, 1.00], // 素の色
  [1.07, 1.05, 1.02], // 明るめ・やや暖色
  [0.92, 0.97, 1.06], // 青みがかったガラス風
  [1.12, 1.12, 1.14], // 白っぽい
];
function tintWall(c) {
  const t = WALL_TINTS[(Math.random() * WALL_TINTS.length) | 0];
  const r = Math.min(255, Math.round(((c >> 16) & 255) * t[0]));
  const g = Math.min(255, Math.round(((c >> 8) & 255) * t[1]));
  const b = Math.min(255, Math.round((c & 255) * t[2]));
  return (r << 16) | (g << 8) | b;
}

function addBuilding(x, z, w, d, h, style, isReal, rot) {
  const _origH = h; // 遠方アンロード時、再生成できるよう元のhを覚えておく(下でhを斜面ぶん延長するため)
  // 4隅+中心の地形高さを見て、最低点を基礎にし最高点まで胴体を延長。
  // (中心1点だけだと斜面で山側が埋まり、谷側が浮いていた)
  const hs = [
    getGroundY(x, z),
    getGroundY(x - w/2, z - d/2), getGroundY(x + w/2, z - d/2),
    getGroundY(x - w/2, z + d/2), getGroundY(x + w/2, z + d/2),
  ];
  const gy = Math.min(...hs);   // 基礎 = 最低点
  h += Math.max(...hs) - gy;    // 斜面の高低差ぶん建物を延長して埋まりを防ぐ

  // このbuildingを構成する全メッシュ/ライトをここに集める。
  // 【重要】以前はここで各パーツを個別に絶対Y座標でsceneへ直置きし、生成後は二度と
  // 動かさない仕様だった。地形(NEAR)は後から更新され続けるのに建物だけ固定されるため、
  // 進めば進むほど道路・地形との高さのズレが蓄積して浮く/埋まるが悪化していた。
  // 剛体(building全体)としてY方向にだけ平行移動すればよいので、パーツを集めておき
  // rebuildBuildingHeight() でまとめてシフトできるようにする。
  const parts = [];
  const dm = (...a) => { const m = detailMesh(...a); parts.push(m); return m; };

  const type = style ? style.type : 'default';
  const floors = Math.max(1, Math.round(h / 3)); // building:levels は h に反映済み → 窓の段数に逆算
  const minWD = Math.min(w, d), maxWD = Math.max(w, d);

  // 国別建物プロファイル(現実モード限定。タグ実測値が無い箇所だけのフォールバックに使う)
  const cprof = MODE === 'real' ? getCountryBuildingProfile(currentCountryCode) : null;

  // ---- 壁色(モード別パレット。lambertMat/facadeMat キャッシュを通すので増殖しない) ----
  let isMushroom = false;
  let wallC;
  if (MODE === 'edo' && type !== 'shrine' && type !== 'temple') {
    wallC = EDO_WALLS[(Math.random() * EDO_WALLS.length) | 0]; // 木造・土壁
  } else if (MODE === 'marchen') {
    isMushroom = maxWD < 11 && Math.random() < 0.3; // 小さい家はたまにキノコ
    wallC = isMushroom ? 0xf0e8d8 : PASTEL_WALLS[(Math.random() * PASTEL_WALLS.length) | 0];
  } else if (MODE === 'space') {
    wallC = SPACE_WALLS[(Math.random() * SPACE_WALLS.length) | 0]; // 金属
  } else if (style && style.color != null) {
    wallC = style.color;
  } else if (MODE === 'real') {
    const wp = (cprof && cprof.wallPalette) || DEFAULT_WALLS_REAL;
    wallC = wp[(Math.random() * wp.length) | 0];
  } else {
    wallC = DEFAULT_WALLS[(Math.random() * DEFAULT_WALLS.length) | 0];
  }
  // 現実モード: 神社仏閣・教会以外は建物ごとに色味をばらす(style.color固定のオフィス街が
  // 全部同じ色になる違和感への対策。tintWall参照)
  if (MODE === 'real' && type !== 'shrine' && type !== 'temple' && type !== 'church') {
    wallC = tintWall(wallC);
  }

  // ---- ファサード種別(手続きテクスチャ。神社仏閣・教会・キノコは従来の無地) ----
  const kind =
    (isMushroom || type === 'shrine' || type === 'temple' || type === 'church') ? null :
    type === 'industrial' ? 'ind' :
    (floors <= 2 && (type === 'house' || type === 'default' || type === 'shop')) ? 'house' :
    (type === 'house' || type === 'apartment') ? 'apt' : 'office';
  const mat = kind
    ? facadeMat(kind, wallC, (Math.random() * 2) | 0)
    : lambertMat(wallC, (style && style.emissive) || (MODE === 'space' ? 0x0a1420 : 0));

  const geo = isMushroom
    ? new THREE.CylinderGeometry(minWD * 0.42, minWD * 0.5, h, 10)
    : new THREE.BoxGeometry(w, h, d);
  if (kind) { // 側面に窓タイルを並べ、天面/底面は無地領域へ
    const tw = kind === 'ind' ? 8 : 3.6; // 1タイルの実幅
    setBoxFacadeUVs(geo,
      kind === 'house' ? 1 : Math.max(1, Math.round(w / tw)),
      kind === 'house' ? 1 : Math.max(1, Math.round(d / tw)),
      kind === 'house' ? 1 : floors);
  }
  const mesh = new THREE.Mesh(geo, mat);
  mesh.position.set(x, gy + h/2, z);
  mesh.renderOrder = 2;
  scene.add(mesh);
  parts.push(mesh);

  // ---- 敷地の余白(lotPadding。国プロファイル限定・実測OSM建物のみ) ----
  // 建物本体のフットプリント・位置には一切触れず、周囲に芝生/舗装の縁取りを追加描画するだけ。
  // 香港のように余白がほぼ無い国では実質発生せず、アメリカのように広い国だけ効いて見える。
  // 【重要】実機検証で、米国プロファイル(広い余白)をニューヨークの高層ビル街にそのまま
  // 適用すると、高層ビル1棟ごとに追加メッシュが生成され続けてレンダラーが完全にフリーズする
  // 不具合が確認された。高層ビルに庭の余白があるのはそもそも不自然なので高さでスキップし、
  // かつ国・密度を問わない固定予算(lotPaddingBudget)でも歯止めをかける(detailOK()の850は
  // 他の装飾と共有の閾値で緩すぎ、今回の不具合の主因だった)。
  const LOT_PADDING_MAX_H = 15;
  if (isReal && cprof && cprof.lotPaddingRange && h < LOT_PADDING_MAX_H && lotPaddingBudget > 0 && detailOK()) {
    const [padMin, padMax] = cprof.lotPaddingRange;
    const pad = padMin + Math.random() * (padMax - padMin);
    if (pad > 0.05) {
      const hw = w / 2 + pad, hd = d / 2 + pad;
      const padPts = [
        { x: x - hw, z: z - hd }, { x: x + hw, z: z - hd },
        { x: x + hw, z: z + hd }, { x: x - hw, z: z + hd },
      ];
      buildTerrainFollowingAreaPoly(padPts, lambertMat(cprof.lotSurfaceColor || 0x5a8a3d), 0.05, Math.max(hw, hd) * 2, false);
      lotPaddingBudget--;
    }
  }

  // ==== 屋根 — 切妻・寄棟・片流れ・陸屋根+パラペットをモード/種別/高さで出し分け ====
  let roofC = MODE === 'edo' ? 0x3a4450 /* 瓦 */ : (style && style.roofColor) ? style.roofColor : 0x5030a0;
  if (MODE === 'real' && type === 'house' && Math.random() < 0.6) {
    const rp = (cprof && cprof.roofPalette) || ROOF_COLS;
    roofC = rp[(Math.random() * rp.length) | 0]; // 住宅は屋根色もばらす
  }
  const rm = roofSurfMat(roofC, null);
  // 屋根材(茅葺き/瓦葺き)は本来「時代」ではなく「農家の集落か、町場の町家か」で決まる
  // (瓦は防火目的で江戸中期以降の都市部では既に一般的。茅葺きは時代を問わず農村の民家)。
  // generateMeijiCells 側が密度ティアに応じて style.roofStyle('thatch'|'tile')を明示指定した
  // 場合はそれを優先し、指定が無ければ従来通りモードから決める(後方互換の既定値)。
  // 専用の屋根形状を持つ神社仏閣・学校・病院・役場(洋風建築)等の種別には適用しない。
  const isOrdinaryType = type === 'house' || type === 'shop' || type === 'default' ||
                          type === 'apartment' || type === 'industrial';
  const eraRoof = (style && style.roofStyle) || null;
  const rtype = MODE === 'marchen' ? '_marchen'
              : MODE === 'space' ? '_space'
              : (isOrdinaryType && (eraRoof === 'thatch' || (!eraRoof && IS_MEIJI))) ? '_meiji'
              : (isOrdinaryType && (eraRoof === 'tile' || (!eraRoof && MODE === 'edo'))) ? '_edo' : type;

  // 勾配屋根を載せる(長辺方向に棟を向け、ov=軒の張り出し)
  const pitched = (geoR, rh, ov, matR) => {
    const m2 = new THREE.Mesh(geoR, matR);
    if (d > w) { m2.rotation.y = Math.PI / 2; m2.scale.set(d + ov, rh, w + ov); }
    else m2.scale.set(w + ov, rh, d + ov);
    m2.position.set(x, gy + h - 0.02, z);
    m2.renderOrder = 2;
    scene.add(m2);
    parts.push(m2);
    return m2;
  };

  if (rtype === '_meiji') {
    // 茅葺き: 軒の深い分厚い寄棟(茅の縦筋テクスチャ)
    pitched(HIP_GEO, Math.max(2.6, h * 0.85), minWD * 0.55, roofSurfMat(0x8a7050, 'thatch'));
  } else if (rtype === '_edo') {
    // 瓦: 切妻と寄棟を混在(瓦テクスチャ+深い軒)
    pitched(Math.random() < 0.5 ? GABLE_GEO : HIP_GEO,
            Math.min(3.2, Math.max(1.4, minWD * 0.42)), 1.8, roofSurfMat(0x3a4450, 'tile'));
  } else if (rtype === '_marchen') {
    if (isMushroom) { // キノコの傘
      dm(UNIT_SPH, lambertMat(0xff5060), x, gy + h + minWD * 0.12, z,
                 minWD * 1.6, minWD * 0.88, minWD * 1.6);
    } else { // しま模様のとんがり屋根+たまに煙突
      dm(UNIT_CONE8, roofSurfMat(PASTEL_ROOFS[(Math.random() * PASTEL_ROOFS.length) | 0], 'stripe'),
                 x, gy + h + h * 0.42, z, maxWD * 1.36, h * 0.85, maxWD * 1.36);
      if (detailOK() && Math.random() < 0.3)
        dm(UNIT_BOX, lambertMat(0xb06050), x + w * 0.22, gy + h + 0.9, z, 0.8, 1.8, 0.8);
    }
  } else if (rtype === '_space') {
    // ドーム型居住区: 屋根の一部を飾るのではなく、建物全体を大きな半球ドームで覆う
    // (footprintの対角線まで確実に覆う半径にして、四隅がドームからはみ出さないようにする)。
    // パラペットは廃止し、ドーム基部にネオンリングだけを残す。
    const domeR = Math.sqrt(w * w + d * d) / 2 * 1.08;
    const domeBaseY = gy + h * 0.55; // ドームの根元を建物高さの半分あたりに沈め、ドームが主役に見えるようにする
    const dome = dm(UNIT_DOME, SPACE_GLASS, x, domeBaseY, z, domeR, domeR, domeR);
    dome.renderOrder = 3;
    dm(UNIT_BOX, NEON_MATS[(Math.random() * NEON_MATS.length) | 0],
               x, domeBaseY + 0.05, z, domeR * 1.85, 0.22, domeR * 1.85);
    if (detailOK() && Math.random() < 0.3)
      dm(UNIT_CYL, lambertMat(0x223344, 0x2266ff), x, domeBaseY + domeR * 0.85, z, 0.12, 3.2, 0.12);
  } else if (rtype === 'shrine') {
    // Pagoda-style double roof
    dm(UNIT_CONE4, rm, x, gy + h + h * 0.2, z, maxWD * 1.6, h * 0.4, maxWD * 1.6, Math.PI / 4);
    dm(UNIT_CONE4, rm, x, gy + h + h * 0.55, z, maxWD, h * 0.25, maxWD, Math.PI / 4);
    // Torii gate in front
    const tMat = lambertMat(0xdd2200);
    const pillarH = Math.min(h * 0.8, 8);
    [-1.5, 1.5].forEach(ox =>
      dm(UNIT_CYL, tMat, x + ox, gy + pillarH / 2, z + d / 2 + 2, 0.6, pillarH, 0.6));
    dm(UNIT_BOX, tMat, x, gy + pillarH - 0.5, z + d / 2 + 2, 4.5, 0.5, 0.5);
    dm(UNIT_BOX, tMat, x, gy + pillarH - 1.5, z + d / 2 + 2, 3.8, 0.4, 0.4);
  } else if (rtype === 'temple') {
    // Wide curved roof + bell tower hint
    dm(UNIT_CONE8, rm, x, gy + h + h * 0.15, z, maxWD * 1.8, h * 0.3, maxWD * 1.8);
    dm(UNIT_CYL, lambertMat(0x4a3010), x + w / 2 + 2, gy + h * 0.3, z, 1.9, h * 0.6, 1.9);
  } else if (rtype === 'hospital') {
    // 陸屋根+パラペット+赤十字
    dm(PARAPET_GEO, rm, x, gy + h, z, w + 0.5, 0.8, d + 0.5);
    dm(UNIT_BOX, CROSS_MAT, x, gy + h + 0.7, z, 3, 0.4, 1);
    dm(UNIT_BOX, CROSS_MAT, x, gy + h + 0.7, z, 1, 0.4, 3);
  } else if (rtype === 'school') {
    pitched(HIP_GEO, Math.max(1.4, minWD * 0.22), 1.6, rm); // 幅広の寄棟
  } else if (rtype === 'government') {
    dm(UNIT_DOME, rm, x, gy + h, z, minWD * 0.8, minWD * 0.8, minWD * 0.8); // Dome
  } else {
    // 一般建物(現実モード)
    // OSMのroof:shapeタグがあれば形状はそれを優先(flat/gabled/hipped/pyramidal/skillion等)。
    // タグが無ければ、国プロファイルのroofShapeWeights(flat/gable/hip/shed)があればそれで
    // 重み付き抽選し、無ければ従来通り高さ・種別からの推定/ランダムのまま(挙動・負荷とも変化なし)。
    const roofShape = style && style.roofShape;
    const shapeFlat = roofShape === 'flat';
    const countryPick = (!roofShape && cprof && cprof.roofShapeWeights) ? pickWeighted(cprof.roofShapeWeights) : null;
    const flatThreshold = (cprof && cprof.flatRoofHeightThreshold != null) ? cprof.flatRoofHeightThreshold : 10;
    const isFlat = shapeFlat || (countryPick ? countryPick === 'flat' :
      (!roofShape && (h >= flatThreshold || (type === 'apartment' && h >= 7) || (type === 'industrial' && h >= 8))));
    if (isFlat) {
      // 陸屋根+パラペット+屋上設備(貯水槽・室外機・アンテナ)
      dm(PARAPET_GEO, lambertMat(shadeHex(wallC, 0.8)), x, gy + h, z, w + 0.3, 0.9, d + 0.3);
      if (detailOK()) {
        if (Math.random() < 0.6)
          dm(UNIT_CYL, TANK_MAT, x + w * 0.22, gy + h + 1.2, z + d * 0.18, 2.2, 2.4, 2.2);
        if (Math.random() < 0.7)
          dm(UNIT_BOX, AC_MAT, x - w * 0.2, gy + h + 0.5, z - d * 0.15, 1.8, 1.0, 1.2, Math.random() * 3);
        if (Math.random() < 0.35)
          dm(UNIT_CYL, lambertMat(0x888888), x - w * 0.05, gy + h + 2, z + d * 0.2, 0.1, 4, 0.1);
      }
      // 工場: 遠くからでも「工場」と分かるよう煙突を1本立てる(白/赤の縞、屋根より確実に高い)
      if (type === 'industrial') {
        const chH = h * 0.9 + 4;
        dm(UNIT_CYL, lambertMat(0xd8d8d0), x - w * 0.32, gy + h + chH / 2, z - d * 0.28, 1.3, chH, 1.3);
        dm(UNIT_CYL, lambertMat(0xcc3322), x - w * 0.32, gy + h + chH - 0.6, z - d * 0.28, 1.34, 1.2, 1.34);
      }
    } else {
      // 勾配屋根: タグがあれば形状を確定。無ければ国プロファイルの重み付き抽選結果(countryPick)を
      // 優先し、それも無ければ従来通り切妻50%/寄棟35%/片流れ15%のランダム(工場・倉庫は片流れ)。
      // roof:materialが瓦系ならテクスチャも瓦にする。プロファイルが無ければ住宅は既定で瓦。
      let geoR;
      if (roofShape === 'gabled' || roofShape === 'gable') geoR = GABLE_GEO;
      else if (roofShape === 'hipped' || roofShape === 'hip' || roofShape === 'pyramidal') geoR = HIP_GEO;
      else if (roofShape === 'skillion' || roofShape === 'lean_to' || roofShape === 'pitched') geoR = SHED_GEO;
      else if (countryPick === 'gable') geoR = GABLE_GEO;
      else if (countryPick === 'hip') geoR = HIP_GEO;
      else if (countryPick === 'shed') geoR = SHED_GEO;
      else {
        const r = Math.random();
        geoR = type === 'industrial' ? SHED_GEO : r < 0.5 ? GABLE_GEO : r < 0.85 ? HIP_GEO : SHED_GEO;
      }
      const roofMat = style && style.roofMaterial;
      const isTileMat = roofMat === 'roof_tiles' || roofMat === 'tiles' || roofMat === 'tile';
      const defaultTileBias = cprof ? (cprof.roofMaterialBias === 'tile') : (MODE === 'real' && type === 'house');
      const rM = roofSurfMat(roofC, (isTileMat || defaultTileBias) ? 'tile' : null);
      pitched(geoR, geoR === SHED_GEO ? Math.max(0.8, minWD * 0.18)
                                      : Math.min(4.2, Math.max(1.5, minWD * 0.38)), 1.0, rM);
      // 玄関庇(住宅のみ)
      if (type === 'house' && detailOK() && Math.random() < 0.5)
        dm(UNIT_BOX, roofSurfMat(roofC, null), x + w * 0.22, gy + 2.35, z + d / 2 + 0.5, 2.2, 0.16, 1.1);
    }
  }

  // エントランス(中高層ビルの1階の玄関ガラス)
  if ((kind === 'office' || kind === 'apt') && h >= 9 && MODE !== 'edo' && !IS_MEIJI &&
      detailOK() && Math.random() < 0.5) {
    dm(UNIT_PLANE, ENTRANCE_MAT, x, gy + 1.4, z + d / 2 + 0.06, 3.0, 2.8, 1);
  }

  // コンビニ・商店のモード別演出(共有マテリアル、追加は最大2メッシュ+提灯インスタンス)
  if (type === 'shop' && h <= 12) {
    if (MODE === 'edo') {
      // 茶屋: 暖簾+提灯
      dm(UNIT_PLANE, NOREN_MAT, x, gy + 1.7, z + d / 2 + 0.08, Math.min(w * 0.7, 6), 1.1, 1);
      poolAdd(lampP, x - Math.min(w, 8) * 0.35, gy + 2.2, z + d / 2 + 0.4, 0, 0.9, 1.2, 0.9, 0xff8830);
      poolAdd(lampP, x + Math.min(w, 8) * 0.35, gy + 2.2, z + d / 2 + 0.4, 0, 0.9, 1.2, 0.9, 0xff8830);
    } else {
      const bandMats = MODE === 'space' ? NEON_MATS : MODE === 'marchen' ? CANDY_BAND_MATS : SIGN_BAND_MATS;
      dm(UNIT_PLANE, STOREFRONT_MAT, x, gy + 1.1, z + d / 2 + 0.06, Math.min(w * 0.85, 10), 1.6, 1);
      dm(UNIT_BOX, bandMats[(Math.random() * bandMats.length) | 0],
                 x, gy + 2.4, z + d / 2 + 0.2, Math.min(w, 12) * 0.95, 0.7, 0.25);
    }
  } else if (type === 'school') {
    // 校庭(土色の広場)
    const yard = dm(UNIT_PLANE, YARD_MAT, x, gy + 0.12, z, w + 18, d + 18, 1);
    yard.rotation.x = -Math.PI / 2;
  }

  // (旧: 窓プレーン生成はファサードテクスチャの emissiveMap に置換され削除)

  // Special glow for shrines/temples
  if (type === 'shrine') {
    parts.push(addDecorLight(0xff4400, 1.5, 30, x, gy+h*0.8, z));
  } else if (type === 'temple') {
    parts.push(addDecorLight(0xffaa00, 1.2, 25, x, gy+h*0.8, z));
  } else if (Math.random() < 0.06) {
    dm(UNIT_SPH, glowMat, x, gy + h * 0.6, z, maxWD * 1.6, maxWD * 1.6, maxWD * 1.6);
    parts.push(addDecorLight(0x8040ff, 0.8, 15, x, gy + h*0.6, z));
  }

  // 【重要・2026-07-16】実OSM建物の向き(rot)を反映する。各パーツは軸平行前提の絶対座標で
  // 組み立てられているので、最後に建物中心(x,z)周りでまとめて剛体回転させる
  // (親Groupにrotation.y=rotを付けたのと同じ変換: 位置の回転+各パーツ自身のyaw加算)。
  // Y座標・rebuildBuildingHeightのY平行移動とは干渉しない。
  if (rot) {
    const rc = Math.cos(rot), rs = Math.sin(rot);
    for (const p of parts) {
      const dx0 = p.position.x - x, dz0 = p.position.z - z;
      p.position.x = x + dx0 * rc + dz0 * rs;
      p.position.z = z - dx0 * rs + dz0 * rc;
      p.rotation.y += rot;
    }
  }

  // Collision AABB — terrain-aware(chunkKey はアンロード時の掃除用)
  // 上端は実際の屋根高さに(+5の余白があるとジャンプでの屋根着地位置がずれる)
  // 【2026-07-16】回転建物(rot≠0)の場合、Box3自体は回転フットプリントを包む外接AABB
  // (collGridのセル登録・ブロードフェーズ用)にし、正確な判定用の回転情報
  // (rot/cx/cz/hw/hd)をボックスに添付する。実判定はcollBoxHitsXZ(part7.js)が
  // プレイヤー座標を建物ローカル系へ逆回転して行うので、見た目と当たりが一致する。
  let _bMinX = x - w/2, _bMaxX = x + w/2, _bMinZ = z - d/2, _bMaxZ = z + d/2;
  if (rot) {
    const _hx = (Math.abs(w * Math.cos(rot)) + Math.abs(d * Math.sin(rot))) / 2;
    const _hz = (Math.abs(w * Math.sin(rot)) + Math.abs(d * Math.cos(rot))) / 2;
    _bMinX = x - _hx; _bMaxX = x + _hx; _bMinZ = z - _hz; _bMaxZ = z + _hz;
  }
  const cbox = new THREE.Box3(
    new THREE.Vector3(_bMinX, gy, _bMinZ),
    new THREE.Vector3(_bMaxX, gy + h, _bMaxZ)
  );
  if (rot) { cbox.rot = rot; cbox.cx = x; cbox.cz = z; cbox.hw = w / 2; cbox.hd = d / 2; }
  cbox.chunkKey = currentChunkKey;
  // 実OSM建物を遠方アンロードする際、collisionBoxes/minimapBuildings/placedBuildings
  // からもこのbuilding分だけ一括で取り除けるよう、共通のIDを振っておく。
  const bid = _buildingIdSeq++;
  cbox.buildingId = bid;
  collisionBoxes.push(cbox);
  collGridAdd(cbox);

  // Minimap record
  minimapBuildings.push({x, z, w, d, rot: rot || 0, ck: currentChunkKey, bid}); // rotはミニマップの回転描画用
  // Spatial index for landuse fill de-duplication
  placedBuildings.push({x, z, r: Math.max(w,d)/2, ck: currentChunkKey, bid});

  // resnap用の記録(地形が後から更新された時にこのbuilding一式をY方向へ平行移動する)。
  // h/styleも保持しておき、遠方アンロード時にpendingBuildingsへ戻して再訪時に再生成できるようにする。
  // isReal: 実OSM建物かどうか(手続き生成の密集地判定で「本物の建物が近くにあるか」の
  // 裏付けに使う。農地の農道グリッドを住宅街と誤認する対策)
  const brec = { x, z, w, d, h: _origH, style, gy, parts, cbox, ck: currentChunkKey, bid, real: !!isReal, rot: rot || 0 };
  buildingRecords.push(brec);
  buildingGridAdd(brec);
}

// ======= 現実モード: リアル道路・線路・高速高架 =======
const IS_REAL = MODE === 'real';

// 路面テクスチャ(Canvas)。u=道路横断方向(0..1)、v=道なり(メートル。materialのrepeatで周期化)。
// 種別ごとに1枚だけ生成して全セグメントで共有(アスファルト粒・車線・路肩・歩道を焼き込み)
const _roadTexCache = {};
function realRoadTex(kind) {
  if (_roadTexCache[kind]) return _roadTexCache[kind];
  const c = document.createElement('canvas');
  c.width = kind === 'xwalk' ? 64 : 128;
  c.height = kind === 'xwalk' ? 64 : kind === 'rail' ? 128 : 256;
  const W = c.width, H = c.height;
  const g = c.getContext('2d');
  const u = f => (f * W) | 0;
  const WHITE = 'rgba(230,232,235,0.92)', YELLOW = '#d8b032';
  const noise = (x0, x1, n, a) => {
    for (let i = 0; i < n; i++) {
      g.fillStyle = Math.random() < 0.5 ? `rgba(255,255,255,${a})` : `rgba(0,0,0,${a * 1.6})`;
      g.fillRect((u(x0) + Math.random() * (u(x1) - u(x0))) | 0, (Math.random() * H) | 0, 2, 2);
    }
  };
  const line = (p, wpx, col) => { g.fillStyle = col; g.fillRect(u(p) - wpx / 2, 0, wpx, H); };
  const dash = (p, wpx, col, on, off) => {
    g.fillStyle = col;
    for (let y = 0; y < H; y += on + off) g.fillRect(u(p) - wpx / 2, y, wpx, on);
  };
  const sidewalk = (x0, x1) => { g.fillStyle = '#5a5d62'; g.fillRect(u(x0), 0, u(x1) - u(x0), H); noise(x0, x1, 30, 0.04); };

  if (kind === 'xwalk') { // 横断歩道ゼブラ(背景透過でアスファルトが透ける)
    g.clearRect(0, 0, W, H);
    g.fillStyle = 'rgba(232,235,238,0.88)';
    for (let x = 2; x < W; x += 10) g.fillRect(x, 2, 5, H - 4);
  } else if (kind === 'rail') { // バラスト(砂利道床)+枕木+2本のレール
    g.fillStyle = '#6a6157'; g.fillRect(0, 0, W, H);
    noise(0, 1, 500, 0.07);
    g.fillStyle = '#463a2c';
    for (let y = 2; y < H; y += 13) g.fillRect(u(0.16), y, u(0.68), 6); // 枕木(約0.8m間隔)
    for (const p of [0.37, 0.63]) {
      line(p + 0.012, 5, '#2c2c2e');  // レール影
      line(p, 3, '#b6babe');          // レール(鋼)
    }
  } else if (kind === 'motorway') {
    // アトラス: u 0〜0.72=路面 / 0.74〜0.87=防音壁 / 0.88〜1=桁コンクリート
    g.fillStyle = '#33363b'; g.fillRect(0, 0, u(0.72), H); noise(0, 0.72, 220, 0.045);
    line(0.045, 3, WHITE); line(0.675, 3, WHITE);                   // 路肩の白実線
    line(0.35, 2, WHITE); line(0.37, 2, WHITE);                     // 中央分離
    dash(0.185, 3, WHITE, 85, 86); dash(0.545, 3, WHITE, 85, 86);   // 車線境界(白破線)
    g.fillStyle = '#b2b6ba'; g.fillRect(u(0.74), 0, u(0.87) - u(0.74), H); // 防音壁
    g.fillStyle = 'rgba(0,0,0,0.14)';
    for (let y = 0; y < H; y += 34) g.fillRect(u(0.74), y, u(0.87) - u(0.74), 2); // 壁パネル目地
    g.fillStyle = '#6e7175'; g.fillRect(u(0.88), 0, W - u(0.88), H); noise(0.88, 1, 60, 0.05); // 桁
  } else if (kind === 'trunk') { // 国道クラス: 歩道+黄色2本の中央線+2車線ずつ
    g.fillStyle = '#37393e'; g.fillRect(0, 0, W, H); noise(0, 1, 200, 0.05);
    sidewalk(0, 0.10); sidewalk(0.90, 1);
    line(0.10, 2, '#9aa0a4'); line(0.90, 2, '#9aa0a4'); // 縁石
    line(0.145, 2.5, WHITE); line(0.855, 2.5, WHITE);   // 路側線
    line(0.49, 2, YELLOW); line(0.51, 2, YELLOW);       // 中央線(黄・2本)
    dash(0.31, 2.5, WHITE, 53, 85); dash(0.69, 2.5, WHITE, 53, 85);
  } else if (kind === 'primary') { // 主要地方道: 歩道+黄色中央線+車線破線
    g.fillStyle = '#383b40'; g.fillRect(0, 0, W, H); noise(0, 1, 200, 0.05);
    sidewalk(0, 0.11); sidewalk(0.89, 1);
    line(0.11, 2, '#9aa0a4'); line(0.89, 2, '#9aa0a4');
    line(0.16, 2.5, WHITE); line(0.84, 2.5, WHITE);
    line(0.50, 3, YELLOW);
    dash(0.33, 2.5, WHITE, 53, 85); dash(0.67, 2.5, WHITE, 53, 85);
  } else if (kind === 'secondary') { // 片側1車線: 歩道+白実線の中央線
    g.fillStyle = '#3a3d42'; g.fillRect(0, 0, W, H); noise(0, 1, 200, 0.05);
    sidewalk(0, 0.12); sidewalk(0.88, 1);
    line(0.12, 2, '#9aa0a4'); line(0.88, 2, '#9aa0a4');
    line(0.17, 2.5, WHITE); line(0.83, 2.5, WHITE);
    line(0.50, 2.5, WHITE);
  } else { // minor: 生活道路(中央線なし・路側帯の白線のみ)
    g.fillStyle = '#45484d'; g.fillRect(0, 0, W, H); noise(0, 1, 180, 0.05);
    line(0.08, 2.5, WHITE); line(0.92, 2.5, WHITE);
  }
  const t = new THREE.CanvasTexture(c);
  t.wrapT = THREE.RepeatWrapping;
  _roadTexCache[kind] = t;
  return t;
}
const _roadMatCache2 = {};
function realRoadMat(kind, period) {
  let m = _roadMatCache2[kind];
  if (!m) {
    const tex = realRoadTex(kind);
    tex.repeat.set(1, 1 / period);
    m = new THREE.MeshBasicMaterial({ map: tex, side: THREE.DoubleSide });
    _roadMatCache2[kind] = m;
  }
  return m;
}

// 高架橋脚・横断歩道・遮断機のインスタンスプール(現実モードのみ生成。各1ドローコール)
const pierP = IS_REAL ? makePool(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshLambertMaterial({ color: 0x8d8f92 }), 500) : null;
const xwalkP = IS_REAL ? (() => {
  const p = makePool(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ map: realRoadTex('xwalk'), transparent: true, depthWrite: false }), 250);
  p.mesh.renderOrder = 2;
  return p;
})() : null;
const xingBarP = IS_REAL ? (() => { // 遮断機バー(黄黒縞テクスチャ)
  const c = document.createElement('canvas'); c.width = 32; c.height = 8;
  const g = c.getContext('2d');
  for (let x = 0; x < 32; x += 8) { g.fillStyle = (x / 8) % 2 ? '#181818' : '#e8c020'; g.fillRect(x, 0, 8, 8); }
  return makePool(new THREE.BoxGeometry(1, 1, 1), new THREE.MeshBasicMaterial({ map: new THREE.CanvasTexture(c) }), 240);
})() : null;

const railSegs = [];       // 現実モード: 線路セグメント(踏切検出・駅ホーム配置用)
const nodeUse = new Map(); // 道路端点(1m格子)の使用回数。3以上=交差点 → 横断歩道
let xingCount = 0;

// 2線分の交差判定(端点付近5%は除外)。交点とa(道路)側の方向を返す
function segCross(a, b) {
  const d1x = a.x2 - a.x1, d1z = a.z2 - a.z1, d2x = b.x2 - b.x1, d2z = b.z2 - b.z1;
  const den = d1x * d2z - d1z * d2x;
  if (Math.abs(den) < 1e-6) return null;
  const t = ((b.x1 - a.x1) * d2z - (b.z1 - a.z1) * d2x) / den;
  const s = ((b.x1 - a.x1) * d1z - (b.z1 - a.z1) * d1x) / den;
  if (t < 0.05 || t > 0.95 || s < 0.05 || s > 0.95) return null;
  const l = Math.hypot(d1x, d1z) || 1;
  return { x: a.x1 + d1x * t, z: a.z1 + d1z * t, nx: d1x / l, nz: d1z / l };
}

// 踏切: 道路の両側(線路手前)に警報ポール+赤灯+黄黒の遮断機バー
function addRailXing(pt) {
  if (!IS_REAL || xingCount >= 60) return;
  xingCount++;
  const pxp = -pt.nz, pzp = pt.nx;
  for (const sd of [-1, 1]) {
    const bx = pt.x + pt.nx * sd * 4.5, bz = pt.z + pt.nz * sd * 4.5;
    const ppx = bx + pxp * sd * 2.8, ppz = bz + pzp * sd * 2.8;
    const gy = getGroundY(ppx, ppz);
    poolAdd(poleP, ppx, gy + 1.6, ppz, 0, 0.6, 0.4, 0.6);
    poolAdd(lampP, ppx, gy + 3.1, ppz, 0, 0.8, 0.8, 0.8, 0xff3030);
    poolAdd(xingBarP, bx + pxp * sd * 0.8, gy + 1.1, bz + pzp * sd * 0.8,
            Math.atan2(-pzp, pxp), 4.4, 0.14, 0.14);
  }
}

// ======= 高速道路(東名など)の高架 =======
// 路面+防音壁+桁側面+桁裏を1つのBufferGeometry(=セグメントあたり1メッシュ)で作り、
// motorwayテクスチャのUV列(路面/壁/桁)を使い分ける。橋脚はInstancedMesh。
// 当たり判定: 桁の薄い水平スラブ(桁上に立てる)+橋脚の柱のみ → 高架下は自由に通れる
const MWY_H = 7, MWY_W = 16;
// 高架(高速道路)の桁ジオメトリだけを作る部分。resnap(rebuildMotorwayMesh)からも
// 同じ関数を使って再生成できるよう、addMotorwayから切り出した。
// 【重要】以前は桁の高さを6mおきに個別サンプリング(見た目)、当たり判定は22m区間の
// 端点のみ(=別のサンプリング密度)で決めていたため、両者が微妙にズレたり、区間ごとに
// 別タイミングでresnapされた際に隣接区間との段差が生まれ、それが「高速道路上の見えない
// 段差に動きをブロックされる」不具合の原因になっていた。桁は区間の両端点の高さだけを
// 使って直線的に結ぶ(=途中の地形起伏は追わない)ことで、見た目・当たり判定が常に同じ
// 1本の直線上に揃い、区間内・区間間のどちらでも段差が生じないようにする。
function makeMotorwayGeo(x1, z1, x2, z2) {
  const dx = x2 - x1, dz = z2 - z1;
  const len = Math.hypot(dx, dz);
  if (len < 2) return null;
  const nx = dx / len, nz = dz / len, px = -nz, pz = nx;
  const hw2 = MWY_W / 2;
  const steps = Math.max(1, Math.round(len / 6));
  const y1 = getGroundY(x1, z1) + MWY_H, y2 = getGroundY(x2, z2) + MWY_H;
  // 断面ストリップ: [横オフセットA, 高さA, uA, 横オフセットB, 高さB, uB]
  const strips = [
    [-hw2, 0,    0.02, +hw2, 0,    0.70], // 路面
    [-hw2, 1.4,  0.75, -hw2, 0,    0.86], // 左防音壁
    [+hw2, 0,    0.75, +hw2, 1.4,  0.86], // 右防音壁
    [-hw2, -1.1, 0.90, -hw2, 0,    0.99], // 左桁側面
    [+hw2, 0,    0.90, +hw2, -1.1, 0.99], // 右桁側面
    [+hw2, -1.1, 0.92, -hw2, -1.1, 0.97], // 桁裏(高架下から見える)
  ];
  const P = [], UV = [], I = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const cx = x1 + dx * t, cz = z1 + dz * t;
    const y = y1 + (y2 - y1) * t; // 端点間を直線的に結ぶ(区間内の地形起伏は追わない)
    const v = t * len;
    for (const s of strips) {
      P.push(cx + px * s[0], y + s[1], cz + pz * s[0], cx + px * s[3], y + s[4], cz + pz * s[3]);
      UV.push(s[2], v, s[5], v);
    }
    if (i < steps) {
      for (let k = 0; k < strips.length; k++) {
        const b = (i * strips.length + k) * 2;
        const n2 = ((i + 1) * strips.length + k) * 2;
        I.push(b, b + 1, n2, b + 1, n2 + 1, n2);
      }
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(P, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(UV, 2));
  geo.setIndex(I);
  return geo;
}

// 高架の桁メッシュを、現在の地形高さに合わせて作り直す(rebuildRoadMeshから呼ばれる)
// 高架の見た目(桁)だけでなく、床スラブ・橋脚の当たり判定も現在の地形高さへ合わせ直す。
// 【重要】以前はここで桁の見た目(mesh.geometry)だけ再構築し、当たり判定のBox3群は
// 生成時の高さのまま放置していた。NEAR地形が後から更新されて見た目の桁が正しい高さへ
// 動いても、当たり判定・橋脚の見た目は古い高さに取り残されたままになり、「見た目の
// 道路面には乗れず、桁の上の何もない空間(=古い当たり判定の位置)に乗れてしまう」上に
// 橋脚だけが空中に浮いて見えるバグの原因になっていた。
// 道路面と同じ考え方(位置は変えずジオメトリ/高さだけ作り直す)を、当たり判定・
// 橋脚インスタンス(poolSetYでY座標だけ書き換え、向き・スケールは維持)にも適用する。
// 高架の「乗れる床」は、Box3(水平の箱)の積み重ねだと登り坂で段差やガタつきが出るため、
// 見た目の桁と全く同じ「2端点を結ぶ斜面」を1つの数式として持ち、floorHeightAt側で
// その場のx,zに応じた高さをその都度計算する(=段差が原理的に発生しない、なめらかな斜面)。
// wouldCollide(横移動のブロック)には一切登録しない(floorHeightAtだけが参照する)。
const motorwaySlopes = [];
function rebuildMotorwayMesh(r) {
  if (!r.mesh) return;
  const geo = makeMotorwayGeo(r.x1, r.z1, r.x2, r.z2);
  if (!geo) return;
  r.mesh.geometry.dispose();
  r.mesh.geometry = geo;
  if (r.slope) {
    r.slope.y1 = getGroundY(r.x1, r.z1) + MWY_H;
    r.slope.y2 = getGroundY(r.x2, r.z2) + MWY_H;
  }
  // 橋脚(見た目・当たり判定とも)は挙動が不安定だったため廃止。高速道路は橋脚なしで空中に浮く形で表示する。
}

function addMotorway(x1, z1, x2, z2) {
  const dx = x2 - x1, dz = z2 - z1;
  const len = Math.hypot(dx, dz);
  if (len < 2) return;
  const nx = dx / len, nz = dz / len;
  const hw2 = MWY_W / 2;
  const geo = makeMotorwayGeo(x1, z1, x2, z2);
  if (!geo) return;
  const mesh = new THREE.Mesh(geo, realRoadMat('motorway', 24));
  mesh.renderOrder = 1;
  scene.add(mesh);

  // 橋脚は見た目・当たり判定とも挙動が不安定(見えない当たり判定が動きをブロックする不具合)だったため廃止。
  // 高速道路は橋脚なしで空中に浮く形で表示する。
  // 桁上の「乗れる床」は見た目(makeMotorwayGeo)と全く同じ2端点の直線補間の斜面として持つ
  // (Box3の積み重ねではないので、登り坂でも段差・ガタつきが原理的に発生しない)。
  const y1 = getGroundY(x1, z1) + MWY_H, y2 = getGroundY(x2, z2) + MWY_H;
  const slope = { x1, z1, y1, x2, z2, y2, nx, nz, len, hw: hw2 };
  motorwaySlopes.push(slope);
  // mesh・斜面の座標を記録し、NEAR地形更新時に桁と当たり判定を一緒に
  // 現在の地形高さへ作り直せるようにする(浮き/埋まり・判定ズレ対策)
  addRoadRecord({ x1, z1, x2, z2, type: 'motorway', rw: MWY_W, mesh, slope });
}

// Shared road materials (created once, reused)
const ROAD_MAT = {
  trunk:      new THREE.MeshBasicMaterial({ color: 0xffee00, side: THREE.DoubleSide }),
  primary:    new THREE.MeshBasicMaterial({ color: 0xffdd00, side: THREE.DoubleSide }),
  secondary:  new THREE.MeshBasicMaterial({ color: 0xff9922, side: THREE.DoubleSide }),
  tertiary:   new THREE.MeshBasicMaterial({ color: MODE_CONF.roadMinor, side: THREE.DoubleSide }),
  railway:    new THREE.MeshBasicMaterial({ color: 0xaa22ff, side: THREE.DoubleSide }),
  rail_white: new THREE.MeshBasicMaterial({ color: 0xffffff, side: THREE.DoubleSide }),
  road:       new THREE.MeshBasicMaterial({ color: MODE_CONF.roadMinor, side: THREE.DoubleSide }),
  water:      new THREE.MeshBasicMaterial({ color: MODE_CONF.water, side: THREE.DoubleSide }),
};
if (USES_MEIJI_LANDUSE) { // 明治・江戸: 全道路を土道の色調に
  ROAD_MAT.trunk.color.setHex(0xa08a60);
  ROAD_MAT.primary.color.setHex(0xa08a60);
  ROAD_MAT.secondary.color.setHex(0x98825c);
  ROAD_MAT.tertiary.color.setHex(0x907a55);
}

// 明治: 土地利用コード別の地面パッチ用マテリアル(共有・テクスチャは小さなcanvas)
function meijiTex(base, stripe, stripeH, repeat) {
  const c = document.createElement('canvas'); c.width = 32; c.height = 32;
  const g = c.getContext('2d');
  g.fillStyle = base; g.fillRect(0, 0, 32, 32);
  if (stripe) { g.fillStyle = stripe; g.fillRect(0, 0, 32, stripeH); g.fillRect(0, 16, 32, stripeH); }
  const tex = new THREE.CanvasTexture(c);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.repeat.set(1 / repeat, 1 / repeat);
  return tex;
}
const MEIJI_GROUND_MATS = USES_MEIJI_LANDUSE ? {
  1:  new THREE.MeshLambertMaterial({ map: meijiTex('#6a9a4a', '#4a6a38', 3, 18), side: THREE.DoubleSide }), // 水田(あぜ)
  2:  new THREE.MeshLambertMaterial({ map: meijiTex('#8a7a4a', '#6a5a38', 4, 8),  side: THREE.DoubleSide }), // 畑
  3:  new THREE.MeshLambertMaterial({ map: meijiTex('#5a7a3a', '#485f2e', 5, 6),  side: THREE.DoubleSide }), // 桑・茶
  5:  new THREE.MeshLambertMaterial({ color: 0x9aa060, side: THREE.DoubleSide }), // 草地・荒地
  6:  new THREE.MeshLambertMaterial({ color: 0xb0a080, side: THREE.DoubleSide }), // 村落(踏み固めた土)
  8:  new THREE.MeshLambertMaterial({ color: 0xc8b890, side: THREE.DoubleSide }), // 砂地
  9:  new THREE.MeshLambertMaterial({ color: 0x4a6a58, side: THREE.DoubleSide }), // 湿地
  10: new THREE.MeshBasicMaterial({ color: 0x3a6a8a, side: THREE.DoubleSide }),   // 水面
} : null;
const MEIJI_HOUSE_WALLS = [0xa89878, 0x8a7050, 0x9a8868];

// 火の見櫓(村落にまれに。チャンク生成中に呼ばれるのでアンロード対象)
function addFireTower(x, z) {
  const gy = getGroundY(x, z);
  const wood = lambertMat(0x6a4a2a);
  const legGeo = new THREE.BoxGeometry(0.25, 9, 0.25);
  [[-1, -1], [1, -1], [-1, 1], [1, 1]].forEach(([ox, oz]) => {
    const leg = new THREE.Mesh(legGeo, wood);
    leg.position.set(x + ox * 0.9, gy + 4.5, z + oz * 0.9);
    scene.add(leg);
  });
  const top = new THREE.Mesh(new THREE.BoxGeometry(2.6, 0.25, 2.6), wood);
  top.position.set(x, gy + 9, z); scene.add(top);
  const roof = new THREE.Mesh(new THREE.ConeGeometry(2.2, 1.2, 4), lambertMat(0x4a3d2a));
  roof.position.set(x, gy + 10, z); roof.rotation.y = Math.PI / 4; scene.add(roof);
  const bell = new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.3, 0.5, 6), lambertMat(0x554422));
  bell.position.set(x, gy + 9.6, z); scene.add(bell);
}

// Build a terrain-following road ribbon as a single BufferGeometry mesh
function makeRoadGeo(x1, z1, x2, z2, width, yOffset) {
  const dx = x2-x1, dz = z2-z1;
  const len = Math.sqrt(dx*dx+dz*dz);
  if (len < 0.1) return null;
  const nx = dx/len, nz = dz/len; // forward
  const px = -nz, pz = nx;        // left perpendicular
  const hw = width / 2;
  const segs = Math.max(1, Math.round(len)); // 1 vertex per meter
  // 横断方向の分割数。以前は左右端の2点だけで平面を張っていたため、幅広の道路
  // (峠道など)では中央が地形(バイリニア面)より低くなり、地形に埋まって見えることがあった。
  // 幅3mあたり1列を目安に中間点もサンプリングし、道の途中で地形に飲み込まれないようにする。
  const cols = Math.max(2, Math.min(5, Math.ceil(width / 3) + 1));

  const verts = [], idxs = [], uvs = [];
  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    const cx = x1 + dx*t, cz = z1 + dz*t;
    // 各横断位置ごとに個別に地形高さをサンプリング。
    // (以前は中心線の高さを両端に使っていたため、道路を横切る斜面では
    //  山側の端が地形に埋まって途切れて見えた)
    for (let c = 0; c < cols; c++) {
      const u = c / (cols - 1); // 0=left .. 1=right
      const off = hw - u * width;
      const vx = cx + px*off, vz = cz + pz*off;
      verts.push(vx, getGroundY(vx, vz) + yOffset, vz);
      // u=横断方向0..1 / v=道なり距離[m](テクスチャ側のrepeatで車線・枕木の周期に変換)
      uvs.push(u, t * len);
    }
    if (i < segs) {
      const b0 = i * cols, b1 = (i + 1) * cols;
      for (let c = 0; c < cols - 1; c++) {
        const a = b0 + c, bIdx = b0 + c + 1, cc = b1 + c, d = b1 + c + 1;
        idxs.push(a, bIdx, cc, bIdx, d, cc);
      }
    }
  }
  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(verts, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
  geo.setIndex(idxs);
  return geo;
}

function addRoad(x1, z1, x2, z2, width, type='road') {
  const dx = x2-x1, dz = z2-z1;
  const totalLen = Math.sqrt(dx*dx+dz*dz);
  if (totalLen < 0.5) return;

  // 高速道路: 現実モードは高架化、他モードは従来どおり細い地上路として描く
  if (type === 'motorway') {
    if (IS_REAL) { addMotorway(x1, z1, x2, z2); return; }
    type = 'road';
  }

  let w = width, isRailway = false;
  switch(type) {
    case 'trunk':     w = Math.max(width, 10); break;
    case 'primary':   w = Math.max(width, 8);  break;
    case 'secondary': w = Math.max(width, 6);  break;
    case 'tertiary':  w = Math.max(width, 4);  break;
    case 'railway':   w = 5; isRailway = true; break;
    case 'water':     w = Math.max(width, 1.5); break; // 川・水路(実幅は waterwayWidth で決定済み)
    default:          w = Math.max(width, 3);  break;
  }
  // 現実モード: 実勢に近い幅員(歩道込み。テクスチャの歩道帯と整合する幅)
  if (IS_REAL) {
    if (type === 'trunk') w = 14;
    else if (type === 'primary') w = 12;
    else if (type === 'secondary') w = 9;
    else if (type === 'tertiary') w = 6.5;
    else if (type === 'road') w = Math.max(w, 4.2);
  }

  // 現実モード: アスファルト+車線+歩道 / バラスト+枕木+レール のテクスチャ路面
  const mat = (IS_REAL && type !== 'water')
    ? (isRailway ? realRoadMat('rail', 8)
       : type === 'trunk' ? realRoadMat('trunk', 24)
       : type === 'primary' ? realRoadMat('primary', 24)
       : type === 'secondary' ? realRoadMat('secondary', 24)
       : realRoadMat('minor', 24))
    : (ROAD_MAT[type] || ROAD_MAT.road);
  // 0.15→0.35: 幅広道路は左右端の間で地形(バイリニア面)が盛り上がることがあるため余裕を持たせる
  // 水面リボンは実形状の水面ポリゴン(+0.15)より低い+0.05に置き、
  // 実形状がある区間では推定幅リボンが完全に隠れるようにする
  const yOff = type === 'water' ? 0.05 : 0.35;

  if (isRailway && IS_REAL) {
    // レールはテクスチャで表現済み(白帯オーバーレイ廃止)。踏切検出+駅ホーム用に記録
    const seg = { x1, z1, x2, z2 };
    railSegs.push(seg);
    // 既存の道路との交差=踏切(道路側の方向で判定)
    for (const r of minimapRoads) {
      if (r.type !== 'road' && r.type !== 'tertiary' && r.type !== 'secondary') continue;
      const pt = segCross(r, seg);
      if (pt) addRailXing(pt);
    }
  }
  // 非現実モードの線路(白帯オーバーレイ)はrebuildRoadMeshが本体メッシュと同時に生成する

  // mesh/mat/yOff も記録しておく: NEAR高解像度地形が後から届いたとき、プレイヤー付近の
  // 道路だけ現在の地形高さに合わせて再構築できるようにする(rebuildRoadsNearChunk)。
  // railWhiteは距離アンロード(unloadFarRoads)/復元(rebuildRoadMesh)で本体と一緒に扱う。
  // 【重要】重いメッシュ生成はここでは行わず、レコード登録+フレーム分割キュー投入だけにする
  // (密集タイル到着時の数十秒フリーズ対策。isOnRoad・ミニマップはレコードだけで正しく動く)。
  const rec = {x1, z1, x2, z2, type, rw: w, mesh: null, mat, yOff, railWhite: null};
  addRoadRecord(rec);
  queueRoadMesh(rec);

  if (IS_REAL && !isRailway && type !== 'water') {
    // 踏切(線路が先に生成済みの場合はこちらで検出)
    if (railSegs.length && (type === 'road' || type === 'tertiary' || type === 'secondary')) {
      const me = { x1, z1, x2, z2 };
      for (const rs of railSegs) { const pt = segCross(me, rs); if (pt) { addRailXing(pt); break; } }
    }
    // 交差点検出 → 横断歩道。OSMの共有ノード=セグメント端点なので、
    // 同一端点(1m格子)を3本以上が使っていたら交差点とみなしゼブラを敷く
    if (totalLen > 12) {
      const nx = dx / totalLen, nz = dz / totalLen;
      for (const [ex, ez, ix, iz] of [[x1, z1, nx, nz], [x2, z2, -nx, -nz]]) {
        const k = Math.round(ex) + ',' + Math.round(ez);
        const n = (nodeUse.get(k) || 0) + 1;
        nodeUse.set(k, n);
        if (n === 3 && w >= 6) {
          const cx = ex + ix * 6, cz = ez + iz * 6;
          poolAdd(xwalkP, cx, getGroundY(cx, cz) + 0.45, cz,
                  Math.atan2(-iz, ix) + Math.PI / 2, w - 1.8, 1, 2.6);
        }
      }
    }
  }

  decorateRoad(x1, z1, x2, z2, type, w, rec);
}
