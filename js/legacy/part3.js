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
// 【2026-07-20】「ビル・マンションが白すぎる/画一的」という報告を受け、やや深みのある色に調整
// (part2.js getBuildingStyleの同種スタイルと値を揃えている。値の意味は変わらず単なる色調整)。
// 【2026-07-20】wallPaletteを追加(part2.js定義のOFFICE_WALL_PALETTE等)。単一のcolorだけだと
// classifyResidentialで昇格した建物(=同じ singleton オブジェクトを共有)が全部同じ色になり、
// NY等の都心で「灰色で画一的」の主因になっていた。colorは抽選が効かない場面向けの
// フォールバックとして残す(addBuilding参照)。
const APARTMENT_STYLE = { color: 0x8290ab, wallPalette: APARTMENT_WALL_PALETTE, roofColor: 0x506080, emissive: 0x001122, type: 'apartment' };
// オフィス・商業ビル用(ガラス張りの寒色系。part2.jsのkind選択で自動的に'office'ファサードになる)
const OFFICE_STYLE = { color: 0x76869c, wallPalette: OFFICE_WALL_PALETTE, roofColor: 0x505868, emissive: 0x0a1420, type: 'office' };
const COMMERCIAL_INDUSTRIAL_STYLE = { color: 0x808890, wallPalette: INDUSTRIAL_WALL_PALETTE, roofColor: 0x505860, emissive: 0x111111, type: 'industrial' };
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
const LANDMARK_MIN_H = { school: 7, hospital: 9, government: 8, shrine: 6, temple: 7, stadium: 16 };
// ドーム球場は開放型スタジアム(上のLANDMARK_MIN_H=16m)よりずっと背が高い(東京ドーム等は
// 実測50m超)。stadiumDome判定時だけ、これを下回らないよう別途底上げする(part8.js参照)。
const STADIUM_DOME_MIN_H = 45;
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
// 【2026-07-20】「白すぎる・画一的・立体感がない」という報告への対応。従来は最暗0.84〜
// 最明1.14と幅が狭く(全建物が実質同じ明るさ帯にしか散らばらない)、しかも最も明るい
// 枠が「白っぽい」という更に明るくする方向だけだったため、街全体が単調に白く見えていた。
// 色数は6のまま(キャッシュ増殖なし)で、暗い側を大きく広げ(0.62まで)、白側の
// 「もっと明るく」枠を廃止して暖色寄りの中間トーンに置き換え、明暗のレンジ自体を
// 約2倍に広げて隣り合う建物の濃淡差(=見た目の立体感)を出す。
const WALL_TINTS = [
  [0.62, 0.65, 0.72], // 濃色(日陰・打ちっぱなしコンクリート寄り)
  [0.80, 0.83, 0.88], // 暗め・やや寒色
  [0.95, 0.94, 0.92], // 中間・やや暖色
  [1.00, 1.00, 1.00], // 素の色
  [1.08, 1.04, 0.98], // 明るめ・暖色(テラコッタ寄り)
  [0.90, 0.96, 1.12], // 青みがかったガラス風(寒色でコントラスト)
];
function tintWall(c) {
  const t = WALL_TINTS[(Math.random() * WALL_TINTS.length) | 0];
  const r = Math.min(255, Math.round(((c >> 16) & 255) * t[0]));
  const g = Math.min(255, Math.round(((c >> 8) & 255) * t[1]));
  const b = Math.min(255, Math.round((c & 255) * t[2]));
  return (r << 16) | (g << 8) | b;
}

// ======= 観光ランドマーク専用外観(2026-07-18) =======
// 東京タワー/スカイツリー/大阪城/京都タワーは、実測タグを汎用ルールに流すと「巨大な箱ビル」
// にしかならず似ても似つかない。名前検出(part2.js detectLandmarkTower)された建物だけ、
// ここで手組みの専用ジオメトリを組み立てる。高さはpart8.jsで実際の高さに上書き済み。
const LANDMARK_TOWER_HEIGHT = {
  tokyo_tower: 333, skytree: 634, osaka_castle: 55, kyoto_tower: 131, eiffel_tower: 330,
  // 【2026-07-24追加】世界的ランドマーク第2弾(塔・タワー系)
  big_ben: 96, pisa_tower: 56, cn_tower: 553, empire_state: 443,
  burj_khalifa: 828, space_needle: 184, washington_monument: 169,
};
const LM_ORANGE = 0xE8541E, LM_WHITE = 0xF2F0E8, LM_STEEL = 0xE6E9EA, LM_STEEL_DK = 0xC7CCCE,
      LM_CASTLE_WALL = 0xF5F0E6, LM_CASTLE_BAND = 0x2A2620, LM_CASTLE_ROOF = 0x2E5D45, LM_GOLD = 0xD4AF37,
      LM_KYOTO = 0xEDE6D6, LM_RED = 0xCC2211, LM_IRON = 0x5C4632, LM_IRON_DK = 0x3E2F20,
      LM_STONE = 0xC9BC9C, LM_SLATE = 0x445542;
function drawLandmarkTower(dm, x, gy, z, kind) {
  // 四角い先細り角柱を1段。y0=段の底(地表からの高さ)、ht=段の高さ、rBase=底面の半幅相当。
  const sq = (mat, y0, ht, rBase) => dm(UNIT_TAPER4, mat, x, gy + y0 + ht / 2, z, rBase * 2, ht, rBase * 2);
  const rd = (mat, y0, ht, rBase) => dm(UNIT_TAPER_ROUND, mat, x, gy + y0 + ht / 2, z, rBase * 2, ht, rBase * 2);
  const disc = (mat, y, r, ht) => dm(UNIT_CYL, mat, x, gy + y + ht / 2, z, r * 2, ht, r * 2);
  const mOrange = lambertMat(LM_ORANGE), mWhite = lambertMat(LM_WHITE),
        mSteel = lambertMat(LM_STEEL), mSteelDk = lambertMat(LM_STEEL_DK),
        mRed = lambertMat(LM_RED, 0x330000), mGold = lambertMat(LM_GOLD),
        mCastleWall = lambertMat(LM_CASTLE_WALL), mCastleBand = lambertMat(LM_CASTLE_BAND),
        mCastleRoof = lambertMat(LM_CASTLE_ROOF), mKyoto = lambertMat(LM_KYOTO),
        mIron = lambertMat(LM_IRON), mIronDk = lambertMat(LM_IRON_DK),
        mStone = lambertMat(LM_STONE), mSlate = lambertMat(LM_SLATE);

  if (kind === 'tokyo_tower') {
    sq(mOrange, 0, 150, 17);            // 脚〜大展望台
    disc(mSteelDk, 150, 13, 5);         // 大展望台(150m)
    sq(mOrange, 155, 95, 9);            // 大展望台〜特別展望台
    disc(mSteelDk, 250, 7, 4);          // 特別展望台(250m)
    sq(mOrange, 254, 64, 4);
    sq(mWhite, 318, 12, 1.2);           // 最上部アンテナ支持部(白)
    dm(UNIT_SPH, mRed, x, gy + 331, z, 2, 2, 2); // 航空障害灯
    addDecorLight(0xff2200, 0.8, 20, x, gy + 332, z);
  } else if (kind === 'skytree') {
    sq(mSteel, 0, 350, 20);             // 基部〜天望デッキ
    disc(mSteelDk, 350, 15, 8);         // 天望デッキ(350m)
    sq(mSteel, 358, 92, 9);             // 〜天望回廊
    disc(mSteelDk, 450, 10, 5);         // 天望回廊(450m)
    sq(mSteel, 455, 145, 4);
    rd(mWhite, 600, 30, 1.2);           // ゲイン塔(先端アンテナ)
    dm(UNIT_SPH, mRed, x, gy + 631, z, 1.6, 1.6, 1.6);
    addDecorLight(0x3366ff, 0.7, 25, x, gy + 355, z); // 東京スカイツリーの夜間照明を示唆する淡い青
  } else if (kind === 'osaka_castle') {
    // 白漆喰+黒帯+緑の瓦屋根を積んだ層塔型天守
    const tiers = [[0, 16, 22, 18], [17.5, 12, 16, 13], [31, 10, 11, 9], [41, 8, 7, 6]];
    tiers.forEach(([y0, ht, tw, td], i) => {
      dm(UNIT_BOX, mCastleWall, x, gy + y0 + ht / 2, z, tw, ht, td);
      dm(UNIT_BOX, mCastleBand, x, gy + y0 + ht * 0.18, z, tw + 0.15, ht * 0.22, td + 0.15); // 腰の黒漆喰帯
      dm(HIP_GEO, mCastleRoof, x, gy + y0 + ht, z, tw * 1.28, Math.max(2.5, tw * 0.28), td * 1.28);
      if (i === tiers.length - 1) { // 最上段のみ金の鯱
        dm(UNIT_CONE4, mGold, x - tw * 0.35, gy + y0 + ht + tw * 0.28 + 1.2, z, 0.9, 2.4, 0.9, Math.PI / 4);
        dm(UNIT_CONE4, mGold, x + tw * 0.35, gy + y0 + ht + tw * 0.28 + 1.2, z, 0.9, 2.4, 0.9, Math.PI / 4);
      }
    });
  } else if (kind === 'kyoto_tower') {
    dm(UNIT_BOX, lambertMat(0xEDEDED), x, gy + 15.5, z, 32, 31, 20); // 台座ビル(9階建て)
    dm(PARAPET_GEO, lambertMat(0xC8C8C0), x, gy + 31, z, 32.3, 0.9, 20.3);
    rd(mKyoto, 31, 45, 8);
    rd(mKyoto, 76, 22, 5);
    disc(mSteelDk, 98, 8.5, 7);         // 展望室
    rd(mKyoto, 105, 18, 3);
    rd(mWhite, 123, 8, 0.8);            // 尖塔先端
    dm(UNIT_SPH, mRed, x, gy + 130.5, z, 1.2, 1.2, 1.2);
    addDecorLight(0xff2200, 0.6, 18, x, gy + 130, z);
  } else if (kind === 'eiffel_tower') {
    // 【2026-07-24追加】世界的ランドマーク第1弾。実際の格子構造は表現せず、東京タワー等と
    // 同じ「先細り角柱の積み重ね」で全体シルエットを近似する(既存ランドマークと絵柄を統一)。
    // 実測に近い節目(1階57m/2階115m/3階276m/アンテナ先端330m)で段を割る。
    sq(mIron, 0, 57, 62);    // 地上〜1階展望台(4本脚が大きく広がる裾野を表現)
    sq(mIron, 57, 58, 30);   // 1階〜2階展望台
    sq(mIron, 115, 100, 14); // 2階〜3階展望台の手前まで
    sq(mIron, 215, 61, 5);   // 3階展望台(276m)まで
    rd(mIronDk, 276, 46, 2); // アンテナ支柱(330mまで)
    dm(UNIT_SPH, mRed, x, gy + 328, z, 1.5, 1.5, 1.5); // 航空障害灯
    addDecorLight(0xffcc66, 0.7, 22, x, gy + 280, z);  // 夜間のシャンパンゴールド照明を示唆
  } else if (kind === 'big_ben') {
    // 【2026-07-24追加】世界的ランドマーク第2弾。ネオゴシックの時計塔。石造りの塔身+
    // 時計盤のある明るい帯+鐘楼+四角錐の尖塔、という積み重ねで近似(96m)。
    sq(mStone, 0, 55, 7);            // 塔身(地上〜時計盤下)
    sq(mGold, 55, 7, 6.3);           // 時計盤のある区画(金の帯で表現)
    sq(mStone, 62, 13, 5.5);         // 鐘楼
    dm(UNIT_CONE4, mSlate, x, gy + 75 + 10.5, z, 11, 21, 11, 0); // 四角錐の尖塔(96mまで)
    dm(UNIT_SPH, mGold, x, gy + 96.3, z, 0.6, 0.6, 0.6);         // 尖塔先端の飾り
  } else if (kind === 'pisa_tower') {
    // 【2026-07-24追加】世界的ランドマーク第2弾。円柱を8段積み、上に行くほどx方向へ
    // わずかにずらすことで「傾き」を表現する(専用の傾斜ジオメトリは使わず既存disc流用)。
    const totalH = 56, tiers = 8, tierH = totalH / tiers, leanMax = 4;
    for (let i = 0; i < tiers; i++) {
      const y0 = i * tierH;
      const lean = leanMax * (y0 / totalH);
      const r = 7 - i * 0.15;
      dm(UNIT_CYL, mWhite, x + lean, gy + y0 + tierH / 2, z, r * 2, tierH, r * 2);
    }
  } else if (kind === 'cn_tower') {
    // 【2026-07-24追加】世界的ランドマーク第2弾。細い塔身+特徴的な太い円盤展望台(メインポッド)
    // +先細りアンテナマストの3段構成(553m)。
    sq(mSteel, 0, 342, 15);           // 地上〜メインポッド下
    disc(mSteelDk, 342, 18, 24);      // メインポッド(太い円盤の展望台)
    sq(mSteel, 366, 20, 5);           // ポッド〜マスト基部
    rd(mWhite, 386, 167, 2);          // 先細りアンテナマスト(553mまで)
    dm(UNIT_SPH, mRed, x, gy + 551, z, 1.5, 1.5, 1.5);
    addDecorLight(0xff2200, 0.7, 25, x, gy + 345, z);
  } else if (kind === 'empire_state') {
    // 【2026-07-24追加】世界的ランドマーク第2弾。アールデコのセットバック積層を単純化し、
    // 主要棟体+塔状部分+アンテナマストの3段で近似(443m)。
    sq(mSteel, 0, 320, 30);           // 主要棟体
    sq(mSteelDk, 320, 60, 18);        // 上部の塔状部分(展望台含む)
    sq(mWhite, 380, 20, 8);           // アンテナ基部の尖塔部
    rd(mWhite, 400, 43, 2);           // 先端アンテナマスト(443mまで)
    dm(UNIT_SPH, mRed, x, gy + 441, z, 1.2, 1.2, 1.2);
    addDecorLight(0xffffff, 0.6, 20, x, gy + 385, z);
  } else if (kind === 'burj_khalifa') {
    // 【2026-07-24追加】世界的ランドマーク第2弾。段々に細くなるY字プランを単純な先細り
    // 角柱の重ね(3段)+先端スパイアで近似(828m、現在世界一高い建物)。
    sq(mSteel, 0, 400, 33);
    sq(mSteelDk, 400, 250, 22);
    sq(mSteel, 650, 120, 11);
    rd(mSteelDk, 770, 58, 3);         // 尖塔スパイア(828mまで)
    dm(UNIT_SPH, mRed, x, gy + 826, z, 1.2, 1.2, 1.2);
    addDecorLight(0xffffff, 0.7, 30, x, gy + 700, z);
  } else if (kind === 'space_needle') {
    // 【2026-07-24追加】世界的ランドマーク第2弾。裾広がりの脚+細い支柱+特徴的な
    // 円盤形展望台(ソーサー)+先端アンテナの構成(184m)。
    sq(mSteel, 0, 5, 14);             // 脚の広がる裾野
    rd(mSteel, 5, 130, 4);            // 細い支柱
    disc(mSteelDk, 135, 21, 14);      // 展望台の円盤(ソーサー型)
    rd(mWhite, 149, 35, 1.5);         // アンテナマスト(184mまで)
    addDecorLight(0xffffff, 0.6, 22, x, gy + 140, z);
  } else if (kind === 'washington_monument') {
    // 【2026-07-24追加】世界的ランドマーク第2弾。白い大理石の先細りオベリスク+
    // ピラミッド型の尖頂(169m)。他のランドマークと違い装飾灯なし(実物も控えめなため)。
    sq(mWhite, 0, 160, 8.7);          // オベリスク本体
    dm(UNIT_CONE4, mWhite, x, gy + 160 + 4.5, z, 17.4, 9, 17.4, 0); // ピラミッド型先端(169mまで)
  }
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
  // 【2026-07-18】cprof(例: 米国=sprawlingSuburban)は郊外の低層住宅街を想定したプロファイル。
  // 高層ビルに敷地の余白(lotPadding)を付けるとNYの高層ビル街でフリーズする不具合があったため
  // lotPaddingは既にこの高さでガードしてある(下記参照)。この閾値をここへ引き上げ、
  // 壁色パレット(cprof.wallPalette)にも同じガードを効かせる(次のコメント参照)。
  const LOT_PADDING_MAX_H = 15;

  // 【2026-07-18】観光ランドマーク(東京タワー等)は下の汎用な箱+屋根生成を丸ごとスキップし、
  // drawLandmarkTowerの専用ジオメトリだけを描く。kindはこのelseブロック内でのみ決まるが、
  // 後段(エントランス演出の判定等)で参照されるためnullで先に確保しておく。
  let kind = null;
  if (type === 'landmark') {
    drawLandmarkTower(dm, x, gy, z, style.landmark);
  } else {
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
  } else if (style && style.wallPalette) {
    // 【2026-07-20】office/apartment/industrial等は種別ごとに小さな壁色パレットを持つ
    // (part2.js OFFICE_WALL_PALETTE等)。単一のstyle.colorだけを使うと、同種別の建物が
    // 街中どこでも全く同じ色になり(NY等の都心で「灰色で画一的」の主因)、tintWallの
    // 明暗差だけでは色調自体は変わらなかった。棟ごとに抽選してから明暗をばらつかせる。
    const wp = style.wallPalette;
    wallC = wp[(Math.random() * wp.length) | 0];
  } else if (style && style.color != null) {
    wallC = style.color;
  } else if (MODE === 'real') {
    // 【2026-07-20】NYの建物色が画一的すぎるという報告への対応。building:colour等の実測タグも
    // style.color(オフィス/マンション既定色)も無い'default'タイプの建物(OSMではbuilding=yesの
    // 高層ビルにもよく付く)が、国プロファイルの郊外パレット(cprof.wallPalette)にそのまま
    // 落ちていた。NYのような高層ビル街でも「アメリカだから」郊外住宅の淡い色6色だけが
    // 塗られ続けることになり、これが単調さの主因だった(lotPaddingは既に高さでガード済み
    // だったが、壁色は未対応だった)。背の高い建物は国を問わず既定の広めパレットへ逃がす。
    const useCprofPalette = cprof && cprof.wallPalette && h < LOT_PADDING_MAX_H;
    const wp = useCprofPalette ? cprof.wallPalette : DEFAULT_WALLS_REAL;
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
  kind =
    // 【2026-07-18】スタジアムはオフィス街のような窓タイル張りだと不自然なので無地壁にする
    (isMushroom || type === 'shrine' || type === 'temple' || type === 'church' || type === 'stadium') ? null :
    type === 'industrial' ? 'ind' :
    (floors <= 2 && (type === 'house' || type === 'default' || type === 'shop')) ? 'house' :
    (type === 'house' || type === 'apartment') ? 'apt' : 'office';
  // バリアントは2種(4種に増やしたらテクスチャメモリ超過で東京駅クラッシュ→縮小。part2.js参照)
  const mat = kind
    ? facadeMat(kind, wallC, (Math.random() * 2) | 0)
    : lambertMat(wallC, (style && style.emissive) || (MODE === 'space' ? 0x0a1420 : 0));

  // 【2026-07-20】スタジアム・競技場・野球場・ドームは本体がただの四角い箱のままだと
  // 屋根(dome/parapet)を載せてもシルエットが「箱」にしか見えないという指摘への対応。
  // 実物の多くは円形・楕円形なので、本体ジオメトリ自体をフットプリントの外接矩形に
  // 内接する楕円(共有の単位円柱UNIT_CYL_SMOOTHをw,h,dへ引き伸ばす)に変える。
  // 共有ジオメトリなのでBoxGeometryのように毎棟生成しない(メモリ・GPU負荷は増えない)。
  const isStadiumBody = type === 'stadium';
  const geo = isMushroom
    ? new THREE.CylinderGeometry(minWD * 0.42, minWD * 0.5, h, 10)
    : isStadiumBody ? UNIT_CYL_SMOOTH
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
  if (isStadiumBody) mesh.scale.set(w, h, d); // 単位円柱(半径0.5・高さ1)をフットプリント寸法へ
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
  // (LOT_PADDING_MAX_Hは関数冒頭・壁色パレットのガードと共通化済み)
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
  // 【2026-07-20】building=yes等、種別もroof:colourタグも無い建物(=type:'default'。
  // 世界的に最も多いbuildingタグでOSM上ごく一般的)が軒並みこの0x5030a0固定の紫になり、
  // 「紫の屋根ばかりで見た目のレパートリーが少ない」と報告される主因だった。
  // house(住宅)と同じ理由付けが成り立つ(=タグから種別を確定できない建物なので、
  // 何色と決め打ちするより国別パレットからばらけさせた方が自然)ため、houseと同じ
  // roofPaletteを流用する。ただしhouseは「6割だけランダム化(残り4割は固定色で統一感を
  // 出す)」という既存挙動を尊重して変えず、defaultは元が単色紫一色だった分の劣化がない
  // よう常にランダム化する。
  let roofC = MODE === 'edo' ? 0x3a4450 /* 瓦 */ : (style && style.roofColor) ? style.roofColor : 0x5030a0;
  if (MODE === 'real' && type === 'house' && Math.random() < 0.6) {
    const rp = (cprof && cprof.roofPalette) || ROOF_COLS;
    roofC = rp[(Math.random() * rp.length) | 0]; // 住宅は屋根色もばらす
  } else if (MODE === 'real' && type === 'default' && !(style && style.roofColor)) {
    // roof:colourタグが実測値として付いている場合はそちらを尊重し(上のroofC初期値のまま)、
    // タグが無く紫固定にフォールバックするケースだけをランダム化する
    const rp = (cprof && cprof.roofPalette) || ROOF_COLS;
    roofC = rp[(Math.random() * rp.length) | 0]; // 種別不明の建物も紫固定色ではなく国別パレットからばらす
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
  } else if (rtype === 'stadium') {
    // 【2026-07-18】野球場・サッカー場・競技場の再現度向上。
    // ドーム球場: フットプリント全体を覆う大きな半球ドーム(_spaceモードと同じ手法)。
    // 開放型スタジアム: 山型の屋根ではなく、幅いっぱいの陸屋根+パラペットで
    // 「低く幅広いスタジアムのお椀型」のシルエットに近づける(hospitalと同じ手法を流用)。
    if (style && style.stadiumDome) {
      const domeR = Math.sqrt(w * w + d * d) / 2 * 1.05;
      dm(UNIT_DOME, rm, x, gy + h * 0.3, z, domeR, domeR * 0.9, domeR);
    } else {
      // 【2026-07-20】本体が箱(BoxGeometry)から楕円(UNIT_CYL_SMOOTH)に変わったため、
      // 屋根も四角いPARAPET_GEOのままだと丸い本体から角がはみ出て見える。
      // 同じ楕円形状(UNIT_CYL_SMOOTH)を少し外側に張り出させた薄い庇に置き換える。
      dm(UNIT_CYL_SMOOTH, rm, x, gy + h + 0.8, z, w + 1.4, 1.6, d + 1.4);
      // ナイター照明塔。実物の野球場・競技場・サッカー場を一目でそれと分からせる
      // 最も特徴的なディテールなので、四隅に配置する(建物密度が高い時はdetailOKで省略)。
      if (detailOK()) {
        const poleH = h + 9;
        const poleMat = lambertMat(0xaaaaaa);
        const lightMat = lambertMat(0xfff0c0, 0x554422);
        [[0.62, 0.62], [-0.62, 0.62], [0.62, -0.62], [-0.62, -0.62]].forEach(([ox, oz]) => {
          const px = x + ox * w, pz = z + oz * d;
          dm(UNIT_CYL, poleMat, px, gy + poleH / 2, pz, 0.5, poleH, 0.5);
          dm(UNIT_BOX, lightMat, px, gy + poleH + 0.3, pz, 2.6, 0.8, 1.8);
        });
      }
    }
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
      // 【2026-07-16】工業系のレパートリー拡充(従来は全棟「煙突付き工場」で単調だった)。
      // 4種を抽選: 煙突工場35% / 倉庫・物流センター30% / タンク併設プラント20% / のこぎり屋根工場15%。
      // どのパーツもparts経由なので回転建物にも正しく追従する(座標は回転前の軸平行系で指定)。
      if (type === 'industrial') {
        const iv = Math.random();
        if (iv < 0.35) {
          // 煙突工場(従来): 白/赤の縞、屋根より確実に高い
          const chH = h * 0.9 + 4;
          dm(UNIT_CYL, lambertMat(0xd8d8d0), x - w * 0.32, gy + h + chH / 2, z - d * 0.28, 1.3, chH, 1.3);
          dm(UNIT_CYL, lambertMat(0xcc3322), x - w * 0.32, gy + h + chH - 0.6, z - d * 0.28, 1.34, 1.2, 1.34);
        } else if (iv < 0.65) {
          // 倉庫・物流センター: 煙突なし、屋上に大型空調・換気塔を並べる
          dm(UNIT_BOX, AC_MAT, x + w * 0.25, gy + h + 0.7, z - d * 0.2, 3.2, 1.4, 2.2);
          dm(UNIT_BOX, AC_MAT, x - w * 0.12, gy + h + 0.7, z + d * 0.24, 3.2, 1.4, 2.2);
          dm(UNIT_CYL, lambertMat(0xb8bcc0), x + w * 0.05, gy + h + 1.1, z + d * 0.02, 1.0, 2.2, 1.0);
        } else if (iv < 0.85) {
          // プラント: 銀色の縦型タンク(サイロ)を敷地側縁に2〜3基
          const nSilo = 2 + (Math.random() * 2 | 0);
          const sh = h * 0.8 + 3;
          for (let si = 0; si < nSilo; si++) {
            const sx = x + w * 0.38, sz = z - d * 0.35 + si * Math.min(6, d * 0.35);
            dm(UNIT_CYL, TANK_MAT, sx, gy + sh / 2, sz, 2.4, sh, 2.4);
            dm(UNIT_CYL, TANK_MAT, sx, gy + sh + 0.4, sz, 1.6, 0.8, 1.6); // 上部ハッチ
          }
        } else {
          // のこぎり屋根工場: 屋上に片流れ屋根を等間隔に並べて工場らしいシルエットに
          const segs = Math.max(2, Math.round(w / 8));
          const segW = w / segs;
          for (let si = 0; si < segs; si++) {
            dm(SHED_GEO, roofSurfMat(0x607080, null), x - w / 2 + segW * (si + 0.5), gy + h + 1.0, z, segW * 0.96, 2.0, d * 0.96);
          }
        }
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
  } // end of else(type !== 'landmark') 【2026-07-18】

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
  } else if (MODE !== 'real' && Math.random() < 0.06) {
    // 「魔法のオーラ」演出(半透明の紫球体+紫ライト)。ファンタジー系モード専用。
    // 【2026-07-16】現実モードでは「建物を包む謎の紫球体」として違和感が強いため無効化。
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
      if (!p || !p.position) continue; // partsにはnull要素が入りうる(unloadFarBuildings等の既存ガードと同様)
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
  // 【2026-07-18】r(hasBuildingNearby用の安全半径)は以前max(w,d)/2だった。長方形の対角線
  // 方向の角は中心からmax(w,d)/2より遠い(真の外接円半径はsqrt((w/2)^2+(d/2)^2))ため、
  // 特に細長い建物ほど角付近の余白を実際より広く見積もり、隣接建物が角に重なりやすかった。
  const _pbRec = {x, z, r: Math.hypot(w, d) / 2, ck: currentChunkKey, bid};
  placedBuildings.push(_pbRec);
  placedBuildingsGridAdd(_pbRec); // hasBuildingNearby用の空間ハッシュにも同時登録(P1)

  // resnap用の記録(地形が後から更新された時にこのbuilding一式をY方向へ平行移動する)。
  // h/styleも保持しておき、遠方アンロード時にpendingBuildingsへ戻して再訪時に再生成できるようにする。
  // isReal: 実OSM建物かどうか(手続き生成の密集地判定で「本物の建物が近くにあるか」の
  // 裏付けに使う。農地の農道グリッドを住宅街と誤認する対策)
  const brec = { x, z, w, d, h: _origH, style, gy, parts, cbox, ck: currentChunkKey, bid, real: !!isReal, rot: rot || 0 };
  buildingRecords.push(brec);
  meshedBuildingGridAdd(brec);
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
  } else if (kind === 'unpaved') { // 未舗装路(砂利・土。中央線・歩道なし、わだちのみ)
    g.fillStyle = '#8a7554'; g.fillRect(0, 0, W, H); noise(0, 1, 300, 0.075);
    g.fillStyle = 'rgba(0,0,0,0.12)';
    g.fillRect(u(0.26), 0, u(0.38) - u(0.26), H); // 左わだち
    g.fillRect(u(0.62), 0, u(0.74) - u(0.62), H); // 右わだち
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

// 横断歩道のインスタンスプール(現実モードのみ生成。1ドローコール)
// 【削除済み】pierP(高架橋脚。橋脚廃止後、参照ゼロ)/ xingBarP・xingCount・segCross・
// addRailXing(踏切。2026-07-16踏切廃止後、参照ゼロ) — CODE_REVIEW_20260717 P2で確認・削除。
const xwalkP = IS_REAL ? (() => {
  const p = makePool(new THREE.PlaneGeometry(1, 1).rotateX(-Math.PI / 2),
    new THREE.MeshBasicMaterial({ map: realRoadTex('xwalk'), transparent: true, depthWrite: false }), 250);
  p.mesh.renderOrder = 2;
  return p;
})() : null;

const railSegs = [];       // 現実モード: 線路セグメント(踏切検出・駅ホーム配置用)
const nodeUse = new Map(); // 道路端点(1m格子)の使用回数。3以上=交差点 → 横断歩道

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
  unpaved:    new THREE.MeshBasicMaterial({ color: 0x9c8355, side: THREE.DoubleSide }), // 土・砂利色(舗装色と区別)
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

// 【2026-07-21・河口部対応】橋のアンカー(入口・出口ノード)がそのまま渚際/河口にあると、
// そこの地形サンプリングが実質「海」(データ無し=oceanFloor、または渇水面ぎりぎりの低い値)
// を拾ってしまい、アンカー自体が海面相当まで沈み、橋全体がその低いアンカー間で
// 補間されて波打つ海面プレーンの下に沈んで見える(実機報告: 東品川、河口付近の国道橋)。
// 現実の橋台・堤防は渇水面よりある程度高い位置にあるはず、という前提でアンカー高さに
// 最低クリアランスを設ける(通常の内陸の橋・谷を渡る橋は元々ずっと高いのでこの底上げは
// 効かず、影響を受けるのは河口・海際の低いアンカーだけに限られる)。
// 【重要】基準にするのは可変のSEA_Y(ユーザーが海面調整スライダーで動かせる、表示用の値)
// ではなく、常に実標高0m(seaLevelMに関係なく固定)。スライダーを動かしても既存の道路・
// 橋メッシュは即座に作り直さない設計(ユーザー判断: 現実的でないため)なので、もし可変の
// SEA_Yを基準にすると、スライダーを動かした後に新しく生成される橋だけ基準がズレて
// 混在してしまう。実標高0m基準なら地点・タイミングに関わらず常に同じ結果になる。
const BRIDGE_MIN_CLEARANCE_M = 1.5; // 実標高0mからの最低クリアランス(実length, m)

// 【2026-07-21・橋対応】橋区間の両端の高さ(bridgeInfo.ax/az/bx/bzの地形高さをfracA/fracBで
// 線形補間したもの)を求める共通ヘルパー。見た目(makeRoadGeo)と足場判定(bridgeSlopes/
// floorHeightAt)の両方がこれを使うことで、常に同じ高さになることを保証する
// (別々に計算式を持つと将来どちらかだけ直し忘れてズレる)。
function bridgeSegmentY(bridgeInfo) {
  // 実標高0m(海面調整スライダーの影響を受けない固定基準)のゲーム高さ。SEA_Yの式から
  // seaLevelM部分だけ外し、常に0m基準にしたもの。
  const trueSeaY = -elevBase * ELEV_SCALE;
  const floor = trueSeaY + BRIDGE_MIN_CLEARANCE_M * ELEV_SCALE;
  const yA0 = Math.max(getGroundY(bridgeInfo.ax, bridgeInfo.az), floor);
  const yB0 = Math.max(getGroundY(bridgeInfo.bx, bridgeInfo.bz), floor);
  return { yA: yA0 + (yB0 - yA0) * bridgeInfo.fracA, yB: yA0 + (yB0 - yA0) * bridgeInfo.fracB };
}

// 橋(bridge=yes等)の「乗れる床」。motorwaySlopes(高速道路の桁)と全く同じ考え方で、
// Box3の水平積み重ねではなく2端点を結ぶ斜面を1つの数式として持ち、floorHeightAt側で
// その場のx,zに応じた高さをその都度計算する(段差なく滑らかに繋がる)。
// 【重要】最初にmakeRoadGeoで見た目の橋が地形に沈む不具合を直したが、floorHeightAtは
// 別の場所でgetGroundY(生の地形)だけを見て足場の高さを決めていたため、見た目の橋の上に
// 立とうとしてもそこには当たり判定が無く、地形(川底相当)まで沈んでいく不具合が残っていた
// (motorwayは元々このbridgeSlopes相当のmotorwaySlopesを持っていたので影響を受けなかった)。
// wouldCollide(横移動のブロック)には登録しない(motorwaySlopesと同じ理由。橋は上に
// 乗る床であって壁ではないため)。
const bridgeSlopes = [];

// Build a terrain-following road ribbon as a single BufferGeometry mesh
// 【2026-07-21・橋対応】bridgeInfoが渡された場合({ax,az,bx,bz,fracA,fracB} = 橋全体の
// 入口・出口の座標と、このセグメントが橋全体の中で占める道なり距離の割合。part8.js参照)、
// 地形サンプリング(getGroundY)を区間の中間点では一切使わず、橋の入口・出口2点だけの
// 地形高さを毎回(再構築のたびに)取り直し、その間をfracA〜fracBで線形補間する。
// 入口・出口の地形高さは通常の道路と全く同じgetGroundYで求めるため、橋の手前・先の
// 道路(=同じ入口・出口ノードで終わる区間)の高さと必ず一致し、継ぎ目が生じない。
// 座標(絶対高さではない)を保持して毎回再サンプリングするのは、NEAR高解像度地形が
// 後から届いた際に通常の道路と同じタイミングで橋の高さも追従して精度が上がるようにするため
// (高さを一度きり確定させて焼き込むと、地形がまだ粗い段階の値のまま固定されてしまう)。
// 横断方向(cols)も全列で同じ高さにする(橋の路面は地形に倣わずフラットな板であるべきため)。
function makeRoadGeo(x1, z1, x2, z2, width, yOffset, bridgeInfo) {
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
  // 橋区間: 入口・出口の地形高さをこの構築タイミングで取り直し、区間の両端の高さを確定する
  let bridgeYA = null, bridgeYB = null;
  if (bridgeInfo) {
    const bh = bridgeSegmentY(bridgeInfo);
    bridgeYA = bh.yA; bridgeYB = bh.yB;
  }

  const verts = [], idxs = [], uvs = [];
  for (let i = 0; i <= segs; i++) {
    const t = i / segs;
    const cx = x1 + dx*t, cz = z1 + dz*t;
    // 橋区間: 地形を無視し、区間の両端(bridgeYA/bridgeYB)を単純に線形補間する
    const bridgeVy = bridgeInfo ? (bridgeYA + (bridgeYB - bridgeYA) * t) : null;
    // 各横断位置ごとに個別に地形高さをサンプリング。
    // (以前は中心線の高さを両端に使っていたため、道路を横切る斜面では
    //  山側の端が地形に埋まって途切れて見えた)
    for (let c = 0; c < cols; c++) {
      const u = c / (cols - 1); // 0=left .. 1=right
      const off = hw - u * width;
      const vx = cx + px*off, vz = cz + pz*off;
      const vy = bridgeVy != null ? bridgeVy + yOffset : getGroundY(vx, vz) + yOffset;
      verts.push(vx, vy, vz);
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

// 【2026-07-21・橋対応】bridgeY: {ax,az,bx,bz,fracA,fracB}(part8.jsが算出。ax/az/bx/bzは
// 橋全体の入口・出口の座標、fracA/fracBはこのセグメントが橋全体の中で占める道なり距離の
// 割合)。実際の高さはmakeRoadGeoが構築のたびにgetGroundYで取り直して線形補間する
// (座標だけ保持し、高さを一度きり焼き込まないことで地形精度の向上に追従できるようにする)。
// 橋区間でなければnull。
function addRoad(x1, z1, x2, z2, width, type='road', bridgeY=null) {
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
    else if (type === 'unpaved') w = Math.max(w, 3.2); // 未舗装路(農道・山道)は舗装路よりやや狭め
  }

  // 現実モード: アスファルト+車線+歩道 / バラスト+枕木+レール / 土・砂利 のテクスチャ路面
  const mat = (IS_REAL && type !== 'water')
    ? (isRailway ? realRoadMat('rail', 8)
       : type === 'trunk' ? realRoadMat('trunk', 24)
       : type === 'primary' ? realRoadMat('primary', 24)
       : type === 'secondary' ? realRoadMat('secondary', 24)
       : type === 'unpaved' ? realRoadMat('unpaved', 16)
       : realRoadMat('minor', 24))
    : (ROAD_MAT[type] || ROAD_MAT.road);
  // 0.15→0.35: 幅広道路は左右端の間で地形(バイリニア面)が盛り上がることがあるため余裕を持たせる
  // 水面リボンは実形状の水面ポリゴン(+0.15)より低い+0.05に置き、
  // 実形状がある区間では推定幅リボンが完全に隠れるようにする
  // 【2026-07-18】以前は水面以外の道路が種別に関わらず全て同じ+0.35で、交差点(どこにでもある)
  // で異なる道路同士が完全に同一平面になりz-fightingしていた(「特定の場所ではなく道路と道路が
  // 重なるとちらつく」という報告と一致)。種別ごとに数cmずらして交差点で常に同じ種別が
  // 上に来るようにしつつ、同種別同士(住宅街の格子道路など、最も頻度の高いケース)の交差にも
  // 効くよう、セグメント単位の決定的な微小ジッター(_fhashで安定算出。リロードや再構築でも
  // 同じ値になる)を追加し、完全に同一平面になる組み合わせを実質無くす。水面(+0.05固定)は
  // road-submersion対策で慎重に決めた値のため触れない([[project_isehara_game_distance_perf_tuning]])。
  const ROAD_TYPE_YOFF = { trunk: 0.40, primary: 0.38, secondary: 0.36, tertiary: 0.34, railway: 0.32 };
  const yOff = type === 'water' ? 0.05 :
    (ROAD_TYPE_YOFF[type] != null ? ROAD_TYPE_YOFF[type] : 0.35) + _fhash(Math.round(x1 * 4), Math.round(z1 * 4)) * 0.018;

  if (isRailway && IS_REAL) {
    // レールはテクスチャで表現済み(白帯オーバーレイ廃止)。駅ホーム用に記録
    // 【2026-07-16】踏切の生成は廃止(ユーザー要望・メモリ/負荷削減。交差スキャンもスキップ)
    railSegs.push({ x1, z1, x2, z2 });
  }
  // 非現実モードの線路(白帯オーバーレイ)はrebuildRoadMeshが本体メッシュと同時に生成する

  // mesh/mat/yOff も記録しておく: NEAR高解像度地形が後から届いたとき、プレイヤー付近の
  // 道路だけ現在の地形高さに合わせて再構築できるようにする(rebuildRoadsNearChunk)。
  // railWhiteは距離アンロード(unloadFarRoads)/復元(rebuildRoadMesh)で本体と一緒に扱う。
  // 【重要】重いメッシュ生成はここでは行わず、レコード登録+フレーム分割キュー投入だけにする
  // (密集タイル到着時の数十秒フリーズ対策。isOnRoad・ミニマップはレコードだけで正しく動く)。
  const rec = {x1, z1, x2, z2, type, rw: w, mesh: null, mat, yOff, railWhite: null, bridgeY, slope: null};
  // 橋区間: 見た目(makeRoadGeoが使うbridgeY)と同じ高さで「乗れる床」もここで登録する。
  // 直前にbridgeSegmentYで求めた高さをそのままslopeへ焼き込み、NEAR地形更新時は
  // rebuildRoadMesh側でこのslopeを見た目と一緒に更新し続ける(常に同じ計算式を使うため、
  // 見た目と足場がズレることはない)。
  if (bridgeY) {
    const bh = bridgeSegmentY(bridgeY);
    rec.slope = { x1, z1, y1: bh.yA, x2, z2, y2: bh.yB, nx: dx/totalLen, nz: dz/totalLen, len: totalLen, hw: w/2 };
    bridgeSlopes.push(rec.slope);
  }
  addRoadRecord(rec);
  queueRoadMesh(rec);

  if (IS_REAL && !isRailway && type !== 'water') {
    // (2026-07-16: 踏切生成は廃止 — 交差スキャンごと削除)
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
