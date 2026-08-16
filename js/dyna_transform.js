////////////////////////////////////////
// System: Dynapoly transform (N64-accurate)
////////////////////////////////////////
//
// Reproduces DynaPoly_ExpandSRT (z_bgcheck.c) exactly, so a dynapoly
// actor's collision in the viewer matches what the game actually builds
// at runtime rather than an idealised float transform.
//
// The game does NOT keep dynapoly collision in float object space and
// transform it on the fly. Once per frame it bakes each dynapoly actor's
// vertices into world space and stores them as Vec3s -- 16-bit INTEGERS.
// Polygon normals and plane distances are then recomputed from those
// already-truncated integers. That quantisation is load-bearing: it is
// why rotated/scaled dynapoly surfaces have slightly "wrong" normals in
// game, and it is what makes seams and standable-surface edge cases line
// up with real hardware.
//
// Pipeline (z_bgcheck.c DynaPoly_ExpandSRT):
//   1. pos    = actor->world.pos, pos.y += shape.yOffset * scale.y
//   2. mtx    = SkinMatrix_SetTranslateRotateYXZScale(scale, shape.rot, pos)
//              => M = T * Ry * Rx * Rz * S
//   3. vtxT   = SkinMatrix_Vec3fMtxFMultXYZ(mtx, (Vec3f)srcVtx)   [f32]
//   4. vtx    = (Vec3s)vtxT   <-- C float->s16 cast: TRUNCATE TOWARD ZERO
//   5. normal = normalize(cross(B-A, C-A)) built from the TRUNCATED verts,
//              then quantised again via COLPOLY_SNORMAL: (s16)(n * 32767)
//   6. dist   = (s16)-dot(normal, vtxA)                [truncated]
//
// Trig is the libultra binang table (sins/coss), not Math.sin/Math.cos.
// sins() throws away the low 4 bits of the angle and returns a 16-bit
// integer, so it is materially coarser than a real sine -- on a vertex
// 3000 units from the origin that difference is easily a whole unit once
// step 4 truncates, which changes which integer a vertex lands on.
//
// All float math is forced to single precision with Math.fround to match
// the N64 FPU.

const F = Math.fround;

const SHT_MAX = F(32767.0);
const SHT_MINV = F(1.0 / 32767.0);

// libultra sintable (src/libultra/gu/sintable.inc.c), 1024 entries,
// one quarter wave. sins() mirrors/negates it for the other quadrants.
const sSinTable = new Int16Array([
    0, 50, 100, 150, 201, 251, 301, 352, 402, 452, 503, 553, 603, 654, 704, 754,
    804, 855, 905, 955, 1006, 1056, 1106, 1156, 1207, 1257, 1307, 1358, 1408, 1458, 1508, 1559,
    1609, 1659, 1709, 1760, 1810, 1860, 1910, 1961, 2011, 2061, 2111, 2161, 2212, 2262, 2312, 2362,
    2412, 2463, 2513, 2563, 2613, 2663, 2713, 2763, 2814, 2864, 2914, 2964, 3014, 3064, 3114, 3164,
    3214, 3264, 3314, 3365, 3415, 3465, 3515, 3565, 3615, 3665, 3715, 3765, 3815, 3865, 3915, 3964,
    4014, 4064, 4114, 4164, 4214, 4264, 4314, 4364, 4414, 4463, 4513, 4563, 4613, 4663, 4713, 4762,
    4812, 4862, 4912, 4961, 5011, 5061, 5110, 5160, 5210, 5260, 5309, 5359, 5408, 5458, 5508, 5557,
    5607, 5656, 5706, 5755, 5805, 5855, 5904, 5953, 6003, 6052, 6102, 6151, 6201, 6250, 6299, 6349,
    6398, 6448, 6497, 6546, 6595, 6645, 6694, 6743, 6792, 6842, 6891, 6940, 6989, 7038, 7087, 7137,
    7186, 7235, 7284, 7333, 7382, 7431, 7480, 7529, 7578, 7627, 7676, 7725, 7773, 7822, 7871, 7920,
    7969, 8018, 8066, 8115, 8164, 8213, 8261, 8310, 8359, 8407, 8456, 8505, 8553, 8602, 8650, 8699,
    8747, 8796, 8844, 8893, 8941, 8989, 9038, 9086, 9134, 9183, 9231, 9279, 9328, 9376, 9424, 9472,
    9520, 9568, 9617, 9665, 9713, 9761, 9809, 9857, 9905, 9953, 10001, 10048, 10096, 10144, 10192, 10240,
    10288, 10335, 10383, 10431, 10478, 10526, 10574, 10621, 10669, 10717, 10764, 10812, 10859, 10907, 10954, 11001,
    11049, 11096, 11143, 11191, 11238, 11285, 11332, 11380, 11427, 11474, 11521, 11568, 11615, 11662, 11709, 11756,
    11803, 11850, 11897, 11944, 11991, 12038, 12084, 12131, 12178, 12224, 12271, 12318, 12364, 12411, 12457, 12504,
    12551, 12597, 12643, 12690, 12736, 12783, 12829, 12875, 12921, 12968, 13014, 13060, 13106, 13152, 13198, 13244,
    13290, 13336, 13382, 13428, 13474, 13520, 13566, 13611, 13657, 13703, 13749, 13794, 13840, 13885, 13931, 13976,
    14022, 14067, 14113, 14158, 14204, 14249, 14294, 14339, 14385, 14430, 14475, 14520, 14565, 14610, 14655, 14700,
    14745, 14790, 14835, 14880, 14925, 14969, 15014, 15059, 15104, 15148, 15193, 15237, 15282, 15326, 15371, 15415,
    15460, 15504, 15548, 15593, 15637, 15681, 15725, 15769, 15813, 15857, 15901, 15945, 15989, 16033, 16077, 16121,
    16165, 16208, 16252, 16296, 16339, 16383, 16427, 16470, 16514, 16557, 16600, 16644, 16687, 16730, 16774, 16817,
    16860, 16903, 16946, 16989, 17032, 17075, 17118, 17161, 17204, 17247, 17289, 17332, 17375, 17417, 17460, 17503,
    17545, 17588, 17630, 17672, 17715, 17757, 17799, 17841, 17884, 17926, 17968, 18010, 18052, 18094, 18136, 18178,
    18220, 18261, 18303, 18345, 18386, 18428, 18470, 18511, 18553, 18594, 18636, 18677, 18718, 18760, 18801, 18842,
    18883, 18924, 18965, 19006, 19047, 19088, 19129, 19170, 19211, 19251, 19292, 19333, 19373, 19414, 19454, 19495,
    19535, 19576, 19616, 19656, 19696, 19737, 19777, 19817, 19857, 19897, 19937, 19977, 20017, 20056, 20096, 20136,
    20176, 20215, 20255, 20294, 20334, 20373, 20413, 20452, 20491, 20530, 20570, 20609, 20648, 20687, 20726, 20765,
    20804, 20843, 20881, 20920, 20959, 20997, 21036, 21075, 21113, 21152, 21190, 21228, 21267, 21305, 21343, 21381,
    21419, 21457, 21495, 21533, 21571, 21609, 21647, 21685, 21722, 21760, 21797, 21835, 21873, 21910, 21947, 21985,
    22022, 22059, 22096, 22133, 22171, 22208, 22245, 22281, 22318, 22355, 22392, 22429, 22465, 22502, 22538, 22575,
    22611, 22648, 22684, 22720, 22757, 22793, 22829, 22865, 22901, 22937, 22973, 23009, 23044, 23080, 23116, 23151,
    23187, 23223, 23258, 23293, 23329, 23364, 23399, 23435, 23470, 23505, 23540, 23575, 23610, 23645, 23679, 23714,
    23749, 23783, 23818, 23853, 23887, 23921, 23956, 23990, 24024, 24058, 24093, 24127, 24161, 24195, 24229, 24262,
    24296, 24330, 24364, 24397, 24431, 24464, 24498, 24531, 24564, 24598, 24631, 24664, 24697, 24730, 24763, 24796,
    24829, 24862, 24894, 24927, 24960, 24992, 25025, 25057, 25090, 25122, 25154, 25187, 25219, 25251, 25283, 25315,
    25347, 25379, 25410, 25442, 25474, 25505, 25537, 25568, 25600, 25631, 25663, 25694, 25725, 25756, 25787, 25818,
    25849, 25880, 25911, 25942, 25972, 26003, 26034, 26064, 26095, 26125, 26155, 26186, 26216, 26246, 26276, 26306,
    26336, 26366, 26396, 26426, 26455, 26485, 26514, 26544, 26573, 26603, 26632, 26661, 26691, 26720, 26749, 26778,
    26807, 26836, 26865, 26893, 26922, 26951, 26979, 27008, 27036, 27065, 27093, 27121, 27150, 27178, 27206, 27234,
    27262, 27290, 27317, 27345, 27373, 27400, 27428, 27456, 27483, 27510, 27538, 27565, 27592, 27619, 27646, 27673,
    27700, 27727, 27754, 27780, 27807, 27834, 27860, 27887, 27913, 27939, 27966, 27992, 28018, 28044, 28070, 28096,
    28122, 28147, 28173, 28199, 28224, 28250, 28275, 28301, 28326, 28351, 28377, 28402, 28427, 28452, 28477, 28501,
    28526, 28551, 28576, 28600, 28625, 28649, 28674, 28698, 28722, 28746, 28770, 28794, 28818, 28842, 28866, 28890,
    28914, 28937, 28961, 28984, 29008, 29031, 29054, 29078, 29101, 29124, 29147, 29170, 29193, 29216, 29238, 29261,
    29284, 29306, 29329, 29351, 29373, 29396, 29418, 29440, 29462, 29484, 29506, 29528, 29550, 29571, 29593, 29614,
    29636, 29657, 29679, 29700, 29721, 29742, 29763, 29784, 29805, 29826, 29847, 29868, 29888, 29909, 29930, 29950,
    29970, 29991, 30011, 30031, 30051, 30071, 30091, 30111, 30131, 30151, 30170, 30190, 30209, 30229, 30248, 30267,
    30287, 30306, 30325, 30344, 30363, 30382, 30401, 30419, 30438, 30457, 30475, 30494, 30512, 30530, 30548, 30567,
    30585, 30603, 30621, 30639, 30656, 30674, 30692, 30709, 30727, 30744, 30762, 30779, 30796, 30813, 30830, 30847,
    30864, 30881, 30898, 30915, 30931, 30948, 30964, 30981, 30997, 31013, 31030, 31046, 31062, 31078, 31094, 31109,
    31125, 31141, 31157, 31172, 31188, 31203, 31218, 31234, 31249, 31264, 31279, 31294, 31309, 31323, 31338, 31353,
    31367, 31382, 31396, 31411, 31425, 31439, 31453, 31467, 31481, 31495, 31509, 31523, 31537, 31550, 31564, 31577,
    31591, 31604, 31617, 31630, 31643, 31656, 31669, 31682, 31695, 31708, 31720, 31733, 31746, 31758, 31770, 31783,
    31795, 31807, 31819, 31831, 31843, 31855, 31866, 31878, 31890, 31901, 31913, 31924, 31935, 31947, 31958, 31969,
    31980, 31991, 32002, 32012, 32023, 32034, 32044, 32055, 32065, 32075, 32086, 32096, 32106, 32116, 32126, 32136,
    32145, 32155, 32165, 32174, 32184, 32193, 32203, 32212, 32221, 32230, 32239, 32248, 32257, 32266, 32275, 32283,
    32292, 32300, 32309, 32317, 32325, 32333, 32342, 32350, 32358, 32365, 32373, 32381, 32389, 32396, 32404, 32411,
    32419, 32426, 32433, 32440, 32447, 32454, 32461, 32468, 32475, 32481, 32488, 32494, 32501, 32507, 32513, 32520,
    32526, 32532, 32538, 32544, 32549, 32555, 32561, 32566, 32572, 32577, 32583, 32588, 32593, 32598, 32603, 32608,
    32613, 32618, 32623, 32628, 32632, 32637, 32641, 32645, 32650, 32654, 32658, 32662, 32666, 32670, 32674, 32678,
    32681, 32685, 32688, 32692, 32695, 32698, 32702, 32705, 32708, 32711, 32714, 32716, 32719, 32722, 32724, 32727,
    32729, 32732, 32734, 32736, 32738, 32740, 32742, 32744, 32746, 32748, 32749, 32751, 32753, 32754, 32755, 32757,
    32758, 32759, 32760, 32761, 32762, 32763, 32763, 32764, 32765, 32765, 32766, 32766, 32766, 32766, 32766, 32767,]);

/**
 * libultra sins(). Returns sin(angle) * 0x7FFF as an integer.
 * NOTE the `angle >>= 4`: the table only has 4096 steps per full circle,
 * so binang inputs are quantised to multiples of 16 before lookup.
 * @param {number} angle binang (u16)
 * @returns {number} s16
 */
export function sins(angle) {
    angle = (angle & 0xFFFF) >>> 4;

    let value;
    if (angle & 0x400) {
        value = sSinTable[0x3FF - (angle & 0x3FF)];
    } else {
        value = sSinTable[angle & 0x3FF];
    }

    return (angle & 0x800) ? -value : value;
}

/** libultra coss(). @param {number} angle binang @returns {number} s16 */
export function coss(angle) {
    return sins((angle + 0x4000) & 0xFFFF);
}

/** z_lib.c Math_SinS. @param {number} angle binang @returns {number} f32 */
export function Math_SinS(angle) {
    return F(sins(angle) * SHT_MINV);
}

/** z_lib.c Math_CosS. @param {number} angle binang @returns {number} f32 */
export function Math_CosS(angle) {
    return F(coss(angle) * SHT_MINV);
}

////////////////////////////////////////
// MtxF
////////////////////////////////////////
//
// Row-major Float32Array(16), indexed [row*4 + col] with x=0,y=1,z=2,w=3.
// This matches the decomp's MtxF field naming: mf->xy is row x, column y,
// i.e. the term that multiplies src.y when producing dest.x.

const X = 0, Y = 1, Z = 2, W = 3;
const idx = (r, c) => r * 4 + c;

function mtxIdentity() {
    const m = new Float32Array(16);
    m[idx(X, X)] = 1;
    m[idx(Y, Y)] = 1;
    m[idx(Z, Z)] = 1;
    m[idx(W, W)] = 1;
    return m;
}

/** z_skin_matrix.c SkinMatrix_SetScale */
function skinMatrixSetScale(x, y, z) {
    const m = new Float32Array(16);
    m[idx(X, X)] = F(x);
    m[idx(Y, Y)] = F(y);
    m[idx(Z, Z)] = F(z);
    m[idx(W, W)] = 1;
    return m;
}

/** z_skin_matrix.c SkinMatrix_SetTranslate */
function skinMatrixSetTranslate(x, y, z) {
    const m = mtxIdentity();
    m[idx(X, W)] = F(x);
    m[idx(Y, W)] = F(y);
    m[idx(Z, W)] = F(z);
    return m;
}

/**
 * z_skin_matrix.c SkinMatrix_SetRotateYXZ.
 * Produces R = Ry * Rx * Rz (three.js Euler order 'YXZ'), NOT the
 * default 'XYZ' order -- getting this backwards silently mangles any
 * actor rotated on more than one axis.
 */
function skinMatrixSetRotateYXZ(x, y, z) {
    const m = new Float32Array(16);

    const sinY = Math_SinS(y);
    const cosY = Math_CosS(y);

    m[idx(X, X)] = cosY;
    m[idx(Z, X)] = F(-sinY);
    m[idx(W, Z)] = 0;
    m[idx(W, Y)] = 0;
    m[idx(W, X)] = 0;
    m[idx(Z, W)] = 0;
    m[idx(Y, W)] = 0;
    m[idx(X, W)] = 0;
    m[idx(W, W)] = 1;

    if (x !== 0) {
        const sin = Math_SinS(x);
        const cos = Math_CosS(x);

        m[idx(Z, Z)] = F(cosY * cos);
        m[idx(Z, Y)] = F(cosY * sin);
        m[idx(X, Z)] = F(sinY * cos);
        m[idx(X, Y)] = F(sinY * sin);
        m[idx(Y, Z)] = F(-sin);
        m[idx(Y, Y)] = cos;
    } else {
        m[idx(Z, Z)] = cosY;
        m[idx(X, Z)] = sinY;
        m[idx(X, Y)] = 0;
        m[idx(Z, Y)] = 0;
        m[idx(Y, Z)] = 0;
        m[idx(Y, Y)] = 1;
    }

    if (z !== 0) {
        const sin = Math_SinS(z);
        const cos = Math_CosS(z);

        const xx = m[idx(X, X)];
        const xy = m[idx(X, Y)];
        m[idx(X, X)] = F(F(xx * cos) + F(xy * sin));
        m[idx(X, Y)] = F(F(xy * cos) - F(xx * sin));

        const zy = m[idx(Z, Y)];
        const zx = m[idx(Z, X)];
        m[idx(Z, X)] = F(F(zx * cos) + F(zy * sin));
        m[idx(Z, Y)] = F(F(zy * cos) - F(zx * sin));

        m[idx(Y, X)] = F(m[idx(Y, Y)] * sin);
        m[idx(Y, Y)] = F(m[idx(Y, Y)] * cos);
    } else {
        m[idx(Y, X)] = 0;
    }

    return m;
}

/** z_skin_matrix.c SkinMatrix_MtxFMtxFMult: dest = a * b */
function skinMatrixMult(a, b) {
    const dest = new Float32Array(16);

    for (let r = 0; r < 4; r++) {
        const rx = a[idx(r, X)];
        const ry = a[idx(r, Y)];
        const rz = a[idx(r, Z)];
        const rw = a[idx(r, W)];

        for (let c = 0; c < 4; c++) {
            // Left-to-right accumulation, matching the C expression
            // (rx*cx) + (ry*cy) + (rz*cz) + (rw*cw)
            let acc = F(rx * b[idx(X, c)]);
            acc = F(acc + F(ry * b[idx(Y, c)]));
            acc = F(acc + F(rz * b[idx(Z, c)]));
            acc = F(acc + F(rw * b[idx(W, c)]));
            dest[idx(r, c)] = acc;
        }
    }

    return dest;
}

/**
 * z_skin_matrix.c SkinMatrix_SetTranslateRotateYXZScale.
 * dest = T * R * S  (scale first, then rotate, then translate)
 */
export function skinMatrixSetTranslateRotateYXZScale(scaleX, scaleY, scaleZ, rotX, rotY, rotZ, transX, transY, transZ) {
    let dest = skinMatrixSetTranslate(transX, transY, transZ);
    const rot = skinMatrixSetRotateYXZ(rotX, rotY, rotZ);
    const mft2 = skinMatrixMult(dest, rot);
    const scale = skinMatrixSetScale(scaleX, scaleY, scaleZ);
    dest = skinMatrixMult(mft2, scale);
    return dest;
}

/** z_skin_matrix.c SkinMatrix_Vec3fMtxFMultXYZ */
export function skinMatrixVec3fMultXYZ(m, sx, sy, sz) {
    sx = F(sx);
    sy = F(sy);
    sz = F(sz);

    const out = [0, 0, 0];

    for (let r = 0; r < 3; r++) {
        // C: dest = mw + ((x*mx) + (y*my) + (z*mz))
        let acc = F(sx * m[idx(r, X)]);
        acc = F(acc + F(sy * m[idx(r, Y)]));
        acc = F(acc + F(sz * m[idx(r, Z)]));
        out[r] = F(m[idx(r, W)] + acc);
    }

    return out;
}

////////////////////////////////////////
// Float -> integer conversion
////////////////////////////////////////

/**
 * C float->s16 conversion, as used by BgCheck_Vec3fToVec3s.
 *
 * This is the bit the transform hinges on. It is NOT Math.round and NOT
 * Math.floor -- a C cast from float to an integer type truncates toward
 * zero (IDO emits trunc.w.s), so 3.9 -> 3 and -3.9 -> -3. Using round()
 * here shifts roughly half of all vertices by one unit; using floor()
 * breaks everything with a negative coordinate, which is most of a scene.
 *
 * Out-of-range floats saturate to 0x7FFFFFFF in the 32-bit register and
 * then the low halfword is stored, so the result wraps rather than clamps.
 */
export function f32ToS16(v) {
    // trunc.w.s -> s32 (saturating), then sh -> low 16 bits, signed
    let i;
    if (Number.isNaN(v)) {
        i = 0x7FFFFFFF;
    } else {
        i = Math.trunc(v);
        if (i > 0x7FFFFFFF) i = 0x7FFFFFFF;
        else if (i < -0x80000000) i = 0x7FFFFFFF; // MIPS saturates both ways
    }
    return (i << 16) >> 16;
}

/** bgcheck.h COLPOLY_SNORMAL: (s16)(x * 32767.0f) */
export function colpolySNormal(x) {
    return f32ToS16(F(x * SHT_MAX));
}

/** z_math.h IS_ZERO */
function isZeroF(f) {
    return Math.abs(f) < 0.008;
}

////////////////////////////////////////
// DynaPoly_ExpandSRT
////////////////////////////////////////

/**
 * Transform a dynapoly actor's collision vertices into world space the way
 * the game does, returning 16-bit integer vertices.
 *
 * @param {Array<Array<number>>} verts source vertices [[x,y,z],...] (s16)
 * @param {{scale:{x,y,z}, rot:{x,y,z}, pos:{x,y,z}}} xform
 *        scale is a float multiplier, rot is binang (s16), pos is float.
 * @returns {Array<Array<number>>} transformed vertices, all integers
 */
export function dynaTransformVertices(verts, xform) {
    const mtx = skinMatrixSetTranslateRotateYXZScale(
        xform.scale.x, xform.scale.y, xform.scale.z,
        xform.rot.x, xform.rot.y, xform.rot.z,
        xform.pos.x, xform.pos.y, xform.pos.z
    );

    const out = new Array(verts.length);

    for (let i = 0; i < verts.length; i++) {
        const v = verts[i];
        // Math_Vec3s_ToVec3f is exact; the source verts are already s16.
        const t = skinMatrixVec3fMultXYZ(mtx, v[0], v[1], v[2]);
        out[i] = [f32ToS16(t[0]), f32ToS16(t[1]), f32ToS16(t[2])];
    }

    return out;
}

/**
 * Build the world-space position the game feeds into the matrix.
 * Mirrors the first two lines of DynaPoly_ExpandSRT.
 *
 * @param {Array<number>} posXYZ actor position from the scene setup
 * @param {number} scaleY
 * @param {number} yOffset actor->shape.yOffset (0 for most dynapoly actors)
 */
export function dynaActorPos(posXYZ, scaleY, yOffset = 0) {
    return {
        x: F(posXYZ[0]),
        y: F(F(posXYZ[1]) + F(F(yOffset) * F(scaleY))),
        z: F(posXYZ[2])
    };
}

/**
 * Recompute polygon normals and plane distances from ALREADY-TRUNCATED
 * integer vertices, exactly as DynaPoly_ExpandSRT does.
 *
 * The original header normals are only correct for the untransformed
 * object. Once an actor is rotated or scaled the game throws them away and
 * derives new ones from the integer vertices -- which is why a rotated
 * dynapoly floor can report a normal that is not quite unit length and not
 * quite the "true" geometric normal.
 *
 * Returns a NEW array; the input triangleData is not mutated (it is shared
 * between every instance of the same collision file via the object cache).
 *
 * @param {Array<Array<number>>} intVerts transformed integer vertices
 * @param {Array<Array<number>>} tris 0-based [a,b,c] index triples
 * @param {Array<Object>} triangleData per-poly metadata from the parser
 * @param {Function} makeVec3 constructor for vtxs entries (e.g. THREE.Vector3)
 */
export function dynaRecomputePolyData(intVerts, tris, triangleData, makeVec3) {
    const out = new Array(tris.length);

    for (let i = 0; i < tris.length; i++) {
        const src = triangleData[i] || {};
        const [ia, ib, ic] = tris[i];

        const a = intVerts[ia];
        const b = intVerts[ib];
        const c = intVerts[ic];

        // Math3D_SurfaceNorm: cross(b - a, c - a)
        const abx = F(b[0] - a[0]), aby = F(b[1] - a[1]), abz = F(b[2] - a[2]);
        const acx = F(c[0] - a[0]), acy = F(c[1] - a[1]), acz = F(c[2] - a[2]);

        let nx = F(F(aby * acz) - F(abz * acy));
        let ny = F(F(abz * acx) - F(abx * acz));
        let nz = F(F(abx * acy) - F(aby * acx));

        // Math3D_Vec3fMagnitude
        let magSq = F(nx * nx);
        magSq = F(magSq + F(ny * ny));
        magSq = F(magSq + F(nz * nz));
        const mag = F(Math.sqrt(magSq));

        // Keep the original header normal when the cross product degenerates.
        let normals = src.normals;

        if (!isZeroF(mag)) {
            const inv = F(1.0 / mag);
            nx = F(nx * inv);
            ny = F(ny * inv);
            nz = F(nz * inv);
            normals = [colpolySNormal(nx), colpolySNormal(ny), colpolySNormal(nz)];
        }

        // dist = (s16)-DOTXYZ(newNormal, vtxA). Note this uses newNormal even
        // in the degenerate case, where it is still unnormalised.
        let dot = F(nx * a[0]);
        dot = F(dot + F(ny * a[1]));
        dot = F(dot + F(nz * a[2]));
        const dist = f32ToS16(F(-dot));

        // Floor/wall/ceiling classification, also done on the float normal.
        let surfaceType;
        if (ny > 0.5) surfaceType = "floor";
        else if (ny < -0.8) surfaceType = "ceiling";
        else surfaceType = "wall";

        out[i] = {
            ...src,
            vtxs: [
                makeVec3(a[0], a[1], a[2]),
                makeVec3(b[0], b[1], b[2]),
                makeVec3(c[0], c[1], c[2])
            ],
            normals: normals,
            d: dist,
            surfaceType: surfaceType
        };
    }

    return out;
}
