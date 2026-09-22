import * as THREE from 'three';
import { addModelCheckbox, getModelGroup, resetGroupModelState } from './render.js';
import { isTexturedMode, VIEW_CONTROLS } from './bk_textured.js';

////////////////////////////////////////
// System: Ocarina of Time / Majora's Mask textured map rendering
////////////////////////////////////////
//
// A scene file (segment 2) holds the collision that the rest of the viewer
// draws; what the game actually shows is in the scene's room files (segment
// 3, models/OOT/<scene>_room_<n> and models/MM/<scene>_room_<nn>, see
// tools/oot/import_oot_rooms.py and tools/mm/import_mm_rooms.py).
// Each room header's ROOM_SHAPE command (0x0A) lists display-list pairs
// (opaque, translucent) that Room_Draw runs through the F3DZEX microcode
// with segment 2 pointing at the scene and 3 at the room (z_room.c). This
// module replays those display lists -- the RSP side for the vertices and
// geometry mode, the RDP side for the texture tiles, colour combiner and
// render modes -- into one textured three.js mesh per room, and hangs the
// rooms under a "Textured Rooms" group in the sidebar. The "Textures"
// checkbox (shared with BK / BT) shows or hides the lot.
//
// The rooms are drawn as the game draws them at frame 0 of the day: OoT's
// scene draw configs (z_scene_table.c) that scroll or swap textures through
// segments 8-D are reduced to their first choice (OOT_Scene_Segments in
// js/oot_scene_data.js, generated from the decomp), MM's animated material
// list (scene command 0x1A, z_scene_proc.c) is evaluated at step 0 (its
// colour keyframes and texture cycles; segment 6 holds the region's
// scene_texture file), the texture scrolls stand still, and a display list
// that branches on the distance to the camera (LOD) takes the near branch.
// Nothing else animates. The
// pre-rendered backgrounds of the RoomShapeImage rooms (shops, houses) are
// not drawn -- only their bit of real geometry.
//
// The rooms sit on top of the collision mesh: their materials use a polygon
// offset between the collision mesh's (render.js buildGeometry, factor 1)
// and the wireframe's (none), so a textured surface covers the coplanar
// collision face under it while the collision edges still draw over the
// texture, and collision with no visual counterpart shows through.

const SEG_SCENE = 0x02;
const SEG_ROOM = 0x03;

// Scene / room header commands (include/scene.h)
const CMD_ROOM_LIST = 0x04;
const CMD_ROOM_SHAPE = 0x0A;
const CMD_LIGHT_SETTINGS = 0x0F;
const CMD_SKYBOX_SETTINGS = 0x11;
const CMD_END = 0x14;
const CMD_ANIMATED_MATERIALS = 0x1A; // MM
const LIGHT_MODE_TIME = 0;

// MM AnimatedMaterial { s8 segment; s16 type; void* params }: the list ends
// with a negative segment, and the segment used is |segment| + 7.
const ANIM_MAT_SIZE = 8;
const ANIM_MAT_SEGMENT_BASE = 7;
const ANIM_MAT_COLOR = 2, ANIM_MAT_COLOR_LERP = 3, ANIM_MAT_COLOR_NONLINEAR = 4, ANIM_MAT_TEX_CYCLE = 5;
const SEG_AREA_TEXTURES = 0x06; // MM: the scene's scene_texture_<nn> file

// Outdoor scenes (LIGHT_MODE_TIME) take their ambient and light colours from
// the light setting the time of day selects -- setting 1 from 8:00 to 16:00
// (z_kankyo.c sTimeBasedLightConfigs) -- and point light 1 at the sun, which
// at noon is straight up (0, 120, 20), with light 2 (the moon) opposite.
const DAY_LIGHT_SETTING = 1;
const NOON_SUN_DIR = [0, 120 / 127, 20 / 127];

const ROOM_SHAPE_NORMAL = 0, ROOM_SHAPE_IMAGE = 1, ROOM_SHAPE_CULLABLE = 2;

// F3DZEX2 (include/ultra64/gbi.h with F3DEX_GBI_2)
const G_VTX = 0x01, G_CULLDL = 0x03, G_BRANCH_Z = 0x04, G_TRI1 = 0x05, G_TRI2 = 0x06, G_QUAD = 0x07,
      G_TEXTURE = 0xD7, G_POPMTX = 0xD8, G_GEOMETRYMODE = 0xD9, G_MTX = 0xDA, G_DL = 0xDE, G_ENDDL = 0xDF, G_RDPHALF_1 = 0xE1,
      G_SETOTHERMODE_L = 0xE2, G_SETOTHERMODE_H = 0xE3,
      G_LOADTLUT = 0xF0, G_SETTILESIZE = 0xF2, G_LOADBLOCK = 0xF3, G_LOADTILE = 0xF4, G_SETTILE = 0xF5,
      G_SETPRIMCOLOR = 0xFA, G_SETENVCOLOR = 0xFB, G_SETCOMBINE = 0xFC, G_SETTIMG = 0xFD;

const G_CULL_FRONT = 0x00000200, G_CULL_BACK = 0x00000400, G_LIGHTING = 0x00020000, G_TEXTURE_GEN = 0x00040000;

// gSPMatrix params (F3DEX2 stores them with G_MTX_PUSH inverted)
const G_MTX_PUSH = 0x01, G_MTX_LOAD = 0x02, G_MTX_PROJECTION = 0x04;
// Segment SkelAnime_DrawFlex* points at its per-limb matrix buffer.
export const SEG_FLEX_MATRICES = 0x0D;

// Other mode, low word (render mode)
const Z_UPD = 0x0020, ZMODE_MASK = 0x0C00, ZMODE_DEC = 0x0C00, CVG_X_ALPHA = 0x1000, FORCE_BL = 0x4000;
// Other mode, high word
const G_MDSFT_TEXTLUT = 14, G_MDSFT_CYCLETYPE = 20;
const G_TT_IA16 = 3;
const G_CYC_2CYCLE = 1;

// Room_Draw runs every room list after Gfx_SetupDL_25 (z_rcp.c SETUPDL_25):
//   geometry mode  G_ZBUFFER | G_SHADE | G_CULL_BACK | G_FOG | G_LIGHTING | G_SHADING_SMOOTH
//   other mode     2-cycle, no TLUT; G_RM_FOG_SHADE_A | G_RM_AA_ZB_OPA_SURF2
//   combiner       G_CC_MODULATEIDECALA, G_CC_MODULATEIA_PRIM2
// and Scene_Draw's default list leaves prim and env colour at 128,128,128,128.
const DEFAULT_GEOMETRY_MODE = 0x00230405;
const DEFAULT_OTHERMODE_L = 0xC8152078;
const DEFAULT_OTHERMODE_H = 1 << G_MDSFT_CYCLETYPE;
const DEFAULT_COMBINE = [0xFC127E03, 0xFF0FF23F]; // gsDPSetCombineMode(G_CC_MODULATEIDECALA, G_CC_MODULATEIA_PRIM2)

const VTX_SIZE = 16;
const VTX_CACHE_SIZE = 32;

// Texture formats / sizes (G_IM_FMT_*, G_IM_SIZ_*)
const FMT_RGBA = 0, FMT_CI = 2, FMT_IA = 3, FMT_I = 4;
const SIZ_4B = 0, SIZ_8B = 1, SIZ_16B = 2, SIZ_32B = 3;
const BITS = [4, 8, 16, 32];

// Colour-combiner input codes (a / b / c / d slots differ; see combinerInput)
const CC_COMBINED = 0, CC_TEXEL0 = 1, CC_TEXEL1 = 2, CC_PRIM = 3, CC_SHADE = 4, CC_ENV = 5;

// EnvLightSettings (include/environment.h): u8 ambient[3]; s8 light1Dir[3];
// u8 light1Color[3]; s8 light2Dir[3]; u8 light2Color[3]; u8 fog[3]; s16; s16
const LIGHT_SETTING_SIZE = 0x16;

const srgbToLinear = (c) => (c < 0.04045) ? c * 0.0773993808 : Math.pow(c * 0.9478672986 + 0.0521327014, 2.4);

////////////////////////////////////////
// Header parsing
////////////////////////////////////////

/** Walk a scene or room header (main header only) calling fn(cmd, offset). */
function walkHeader(dv, fn) {
    for (let off = 0; off + 8 <= dv.byteLength; off += 8) {
        const cmd = dv.getUint8(off);
        if (cmd === CMD_END) return;
        fn(cmd, off);
    }
}

/**
 * The scene's room count and the environment lighting its lit surfaces get:
 * indoors the first light setting, outdoors the daytime one under the noon
 * sun (see DAY_LIGHT_SETTING).
 */
export function parseZeldaSceneInfo(buffer) {
    const dv = new DataView(buffer);
    // areaTextureIndex (MM): which scene_texture_<nn> file goes in segment 6
    // (0: none). animatedMaterials (MM): [{ segment, type, params }] with
    // params a scene offset.
    const info = { numRooms: 0, light: null, areaTextureIndex: 0, animatedMaterials: [] };
    let lightMode = LIGHT_MODE_TIME, lightList = 0, numLightSettings = 0;
    walkHeader(dv, (cmd, off) => {
        if (cmd === CMD_ROOM_LIST) {
            info.numRooms = dv.getUint8(off + 1);
        } else if (cmd === CMD_LIGHT_SETTINGS) {
            numLightSettings = dv.getUint8(off + 1);
            lightList = dv.getUint32(off + 4, false) & 0xFFFFFF;
        } else if (cmd === CMD_SKYBOX_SETTINGS) {
            info.areaTextureIndex = dv.getUint8(off + 1);
            lightMode = dv.getUint8(off + 6);
        } else if (cmd === CMD_ANIMATED_MATERIALS) {
            let p = dv.getUint32(off + 4, false) & 0xFFFFFF;
            for (let n = 0; n < 64 && p + ANIM_MAT_SIZE <= dv.byteLength; n++, p += ANIM_MAT_SIZE) {
                const segment = dv.getInt8(p);
                info.animatedMaterials.push({
                    segment: Math.abs(segment) + ANIM_MAT_SEGMENT_BASE,
                    type: dv.getInt16(p + 2, false),
                    params: dv.getUint32(p + 4, false) & 0xFFFFFF,
                });
                if (segment < 0) break;
            }
        }
    });
    if (!numLightSettings) return info;
    const outdoors = lightMode === LIGHT_MODE_TIME;
    const setting = (outdoors && numLightSettings > DAY_LIGHT_SETTING) ? DAY_LIGHT_SETTING : 0;
    const p = lightList + setting * LIGHT_SETTING_SIZE;
    if (p + LIGHT_SETTING_SIZE > dv.byteLength) return info;
    const u8 = (i) => dv.getUint8(p + i) / 255;
    const s8 = (i) => dv.getInt8(p + i) / 127;
    info.light = {
        ambient: [u8(0), u8(1), u8(2)],
        lights: [
            { dir: outdoors ? NOON_SUN_DIR : [s8(3), s8(4), s8(5)], color: [u8(6), u8(7), u8(8)] },
            { dir: outdoors ? NOON_SUN_DIR.map(x => -x) : [s8(9), s8(10), s8(11)], color: [u8(12), u8(13), u8(14)] },
        ],
    };
    return info;
}

/** The room's display-list entries: [{ opa, xlu }] as segment addresses (0 = none). */
function parseRoomShape(dv) {
    const entries = [];
    walkHeader(dv, (cmd, off) => {
        if (cmd !== CMD_ROOM_SHAPE) return;
        const shape = dv.getUint32(off + 4, false) & 0xFFFFFF;
        if (shape + 12 > dv.byteLength) return;
        const type = dv.getUint8(shape);
        if (type === ROOM_SHAPE_NORMAL || type === ROOM_SHAPE_CULLABLE) {
            const count = dv.getUint8(shape + 1);
            const stride = type === ROOM_SHAPE_CULLABLE ? 16 : 8;
            const dlOffset = type === ROOM_SHAPE_CULLABLE ? 8 : 0;
            let p = dv.getUint32(shape + 4, false) & 0xFFFFFF;
            for (let i = 0; i < count && p + stride <= dv.byteLength; i++, p += stride) {
                entries.push({ opa: dv.getUint32(p + dlOffset, false), xlu: dv.getUint32(p + dlOffset + 4, false) });
            }
        } else if (type === ROOM_SHAPE_IMAGE) {
            const p = dv.getUint32(shape + 4, false) & 0xFFFFFF;
            if (p + 8 <= dv.byteLength) entries.push({ opa: dv.getUint32(p, false), xlu: dv.getUint32(p + 4, false) });
        }
    });
    return entries;
}

////////////////////////////////////////
// Texture decoding
////////////////////////////////////////

function rgba16(v, out, o) {
    const r = (v >>> 11) & 0x1F, g = (v >>> 6) & 0x1F, b = (v >>> 1) & 0x1F;
    out[o] = (r << 3) | (r >>> 2);
    out[o + 1] = (g << 3) | (g >>> 2);
    out[o + 2] = (b << 3) | (b >>> 2);
    out[o + 3] = (v & 1) ? 255 : 0;
}

function ia16(v, out, o) {
    out[o] = out[o + 1] = out[o + 2] = v >>> 8;
    out[o + 3] = v & 0xFF;
}

/**
 * Decode a texture to top-row-first RGBA8.
 * src: { dv, off } of the first texel row; rowBytes: bytes per row of texels
 * in memory; palette: Uint16Array of the TLUT entries the texture indexes
 * (CI4: 16 entries, CI8: 256), or null; paletteIA: TLUT is IA16 not RGBA16.
 */
function decodeTexture(src, rowBytes, fmt, siz, width, height, palette, paletteIA) {
    const out = new Uint8Array(width * height * 4);
    const { dv, off } = src;
    const bits = BITS[siz];
    const byteAt = (i) => (i >= 0 && i < dv.byteLength) ? dv.getUint8(i) : 0;
    const wordAt = (i) => (i >= 0 && i + 1 < dv.byteLength) ? dv.getUint16(i, false) : 0;
    const putPalette = (idx, o) => {
        const v = palette ? (palette[idx] ?? 0) : 0;
        if (paletteIA) ia16(v, out, o); else rgba16(v, out, o);
    };
    let o = 0;
    for (let y = 0; y < height; y++) {
        const row = off + y * rowBytes;
        for (let x = 0; x < width; x++, o += 4) {
            if (bits === 4) {
                const b = byteAt(row + (x >>> 1));
                const n = (x & 1) ? (b & 0xF) : (b >>> 4);
                if (fmt === FMT_CI) putPalette(n, o);
                else if (fmt === FMT_IA) {
                    const i = (n >>> 1) * 36; // 3-bit intensity, 1-bit alpha
                    out[o] = out[o + 1] = out[o + 2] = i > 255 ? 255 : i;
                    out[o + 3] = (n & 1) ? 255 : 0;
                } else {
                    out[o] = out[o + 1] = out[o + 2] = out[o + 3] = n * 17;
                }
            } else if (bits === 8) {
                const b = byteAt(row + x);
                if (fmt === FMT_CI) putPalette(b, o);
                else if (fmt === FMT_IA) {
                    out[o] = out[o + 1] = out[o + 2] = (b >>> 4) * 17;
                    out[o + 3] = (b & 0xF) * 17;
                } else {
                    out[o] = out[o + 1] = out[o + 2] = out[o + 3] = b;
                }
            } else if (bits === 16) {
                const v = wordAt(row + x * 2);
                if (fmt === FMT_IA) ia16(v, out, o);
                else rgba16(v, out, o);
            } else {
                const p = row + x * 4;
                out[o] = byteAt(p); out[o + 1] = byteAt(p + 1); out[o + 2] = byteAt(p + 2); out[o + 3] = byteAt(p + 3);
            }
        }
    }
    return out;
}

////////////////////////////////////////
// Colour combiner
////////////////////////////////////////

// Decode a G_SETCOMBINE pair into the 16 mux fields:
//   [a0, b0, c0, d0, Aa0, Ab0, Ac0, Ad0, a1, b1, c1, d1, Aa1, Ab1, Ac1, Ad1]
function decodeCombine(w0, w1) {
    return [
        (w0 >>> 20) & 0xF, (w1 >>> 28) & 0xF, (w0 >>> 15) & 0x1F, (w1 >>> 15) & 7,
        (w0 >>> 12) & 7, (w1 >>> 12) & 7, (w0 >>> 9) & 7, (w1 >>> 9) & 7,
        (w0 >>> 5) & 0xF, (w1 >>> 24) & 0xF, w0 & 0x1F, (w1 >>> 6) & 7,
        (w1 >>> 21) & 7, (w1 >>> 3) & 7, (w1 >>> 18) & 7, w1 & 7,
    ];
}

// The value of one combiner input, per channel (0..2 colour, 3 alpha).
// Texels are white / opaque here: the texture itself is applied by the
// material, so this yields the per-vertex factor that multiplies it.
// v: { combined[4], shade[4], prim[4], env[4], lodFrac }
function combinerInput(slot, code, ch, v) {
    const colour = ch < 3;
    if (slot === 'c' && colour) {
        switch (code) {
            case 0: return v.combined[ch];
            case 1: case 2: return 1;
            case 3: return v.prim[ch];
            case 4: return v.shade[ch];
            case 5: return v.env[ch];
            case 7: return v.combined[3];
            case 8: case 9: return 1;
            case 10: return v.prim[3];
            case 11: return v.shade[3];
            case 12: return v.env[3];
            case 13: return 0;          // LOD_FRACTION
            case 14: return v.lodFrac;  // PRIM_LOD_FRAC
            default: return 0;          // SCALE, K5, ZERO
        }
    }
    if (slot === 'c') {
        switch (code) {
            case 0: return 0;           // LOD_FRACTION
            case 1: case 2: return 1;
            case 3: return v.prim[3];
            case 4: return v.shade[3];
            case 5: return v.env[3];
            case 6: return v.lodFrac;
            default: return 0;
        }
    }
    switch (code) {
        case 0: return v.combined[ch];
        case 1: case 2: return 1;
        case 3: return v.prim[ch];
        case 4: return v.shade[ch];
        case 5: return v.env[ch];
        case 6: return (slot === 'a' || slot === 'd' || !colour) ? 1 : 0; // ONE (b's 6 is CENTER)
        default: return 0;
    }
}

const clamp01 = (x) => x < 0 ? 0 : (x > 1 ? 1 : x);

/** (a - b) * c + d over both cycles (or the second alone in 1-cycle mode). */
function evalCombiner(mux, v, twoCycle) {
    const out = [0, 0, 0, 0];
    const cycles = twoCycle ? [0, 8] : [8];
    v.combined = [0, 0, 0, 0];
    for (const base of cycles) {
        for (let ch = 0; ch < 4; ch++) {
            const m = ch < 3 ? base : base + 4;
            const a = combinerInput('a', mux[m], ch, v), b = combinerInput('b', mux[m + 1], ch, v);
            const c = combinerInput('c', mux[m + 2], ch, v), d = combinerInput('d', mux[m + 3], ch, v);
            out[ch] = clamp01((a - b) * c + d);
        }
        v.combined = out.slice();
    }
    return out;
}

/** Which texels the colour and alpha muxes read (cycle 1 and 2). */
function combinerTexels(mux, twoCycle) {
    const fields = twoCycle ? mux : mux.slice(8);
    const colourUses = (code) => fields.some((m, i) => (twoCycle ? (i % 8) < 4 : i < 4) && m === code);
    const alphaUses = (code) => fields.some((m, i) => (twoCycle ? (i % 8) >= 4 : i >= 4) && m === code);
    // The c slot's texel-alpha codes (8, 9) also read the texture
    const cAlpha = fields.some((m, i) => (twoCycle ? (i % 8) === 2 : i === 2) && (m === 8 || m === 9));
    return {
        texel0: colourUses(CC_TEXEL0) || cAlpha,
        texel1: colourUses(CC_TEXEL1) || cAlpha,
        alpha: alphaUses(CC_TEXEL0) || alphaUses(CC_TEXEL1) || cAlpha,
    };
}

////////////////////////////////////////
// Display-list replay
////////////////////////////////////////

/**
 * Replay a room's display lists.
 * segments: array[16] of { dv, base } (base = byte offset of the segment's
 * address 0 in dv) or null.
 * light: the scene's first light setting (parseZeldaSceneInfo), or null.
 * caches: { textures: Map, dataTextures: Map } shared across the rooms of a
 * scene so that a scene texture is decoded once.
 * Returns { batches: [...], missingTextures: number }.
 */
function replayRoom(entries, segments, light, caches, colours = {}) {
    return replayDisplayLists({
        opa: entries.map(e => e.opa).filter(Boolean).map(addr => ({ addr, ...colours })),
        xlu: entries.map(e => e.xlu).filter(Boolean).map(addr => ({ addr, ...colours })),
    }, segments, light, caches);
}

/**
 * Replay display lists into batches of triangles keyed by their RDP state.
 *
 * lists: { opa: [{ addr, matrix?, segments? }], xlu: [...] } -- the lists
 *   issued into the POLY_OPA then the POLY_XLU buffer, each starting from the
 *   setup DL's RDP state; matrix (THREE.Matrix4) is the model-view matrix the
 *   list starts under (an actor's limb), identity when missing. A list's own
 *   gSPMatrix commands push, load and multiply on top of it. segments, when
 *   given, replaces the shared table for that list; prim / env ([r, g, b, a]
 *   0-255) set the colours before it runs.
 * segments: segment index -> { dv, base, key } (a file), { colour } (MM's
 *   colour lists), { matrices: [Matrix4] } (SEG_FLEX_MATRICES, a skeleton's
 *   limb matrices), or for an overlay { dv, vram, key } resolved by VRAM
 *   address under segments.vram.
 * light: the scene's light setting (parseZeldaSceneInfo), or null.
 * caches: { textures: Map, dataTextures: Map } shared across a scene.
 * Returns { batches: [...], missingTextures: number }.
 */
export function replayDisplayLists(lists, segments, light, caches) {
    // An item can bring its own segment table (an actor drawing a list from
    // another object puts that object in segment 6 first).
    let curSegments = segments;
    const resolve = (addr) => {
        // Overlay data is linked at a VRAM address (0x80xxxxxx), not a segment.
        const seg = (addr >>> 31) ? curSegments.vram : curSegments[(addr >>> 24) & 0xF];
        if (!seg || !seg.dv) return null;
        const off = seg.vram != null ? (addr - seg.vram) : seg.base + (addr & 0xFFFFFF);
        return (off >= 0 && off < seg.dv.byteLength) ? { dv: seg.dv, off, key: seg.key + ':' + off.toString(16) } : null;
    };
    // A fixed-point Mtx in a file: 16 s16 integer parts then 16 u16 fractions,
    // row-major with row vectors, which reads straight into three's
    // column-major, column-vector layout.
    const readMtx = (addr) => {
        const src = resolve(addr);
        if (!src || src.off + 64 > src.dv.byteLength) return null;
        const m = new THREE.Matrix4();
        for (let i = 0; i < 16; i++) {
            m.elements[i] = src.dv.getInt16(src.off + i * 2, false) + src.dv.getUint16(src.off + 32 + i * 2, false) / 65536;
        }
        return m;
    };

    const batches = new Map();
    let missingTextures = 0;
    const wrapFor = (clampMirror, mask) => {
        if (mask === 0 || (clampMirror & 2)) return THREE.ClampToEdgeWrapping;
        return (clampMirror & 1) ? THREE.MirroredRepeatWrapping : THREE.RepeatWrapping;
    };

    // One command buffer's worth of display lists (all the opaque lists of
    // the room, then all the translucent ones), each starting from the
    // setup DL's state as Room_Draw's POLY_OPA / POLY_XLU buffers do.
    const runList = (items) => {

    // ---- RSP state
    const cache = new Int32Array(VTX_CACHE_SIZE).fill(-1); // byte offset of each slot's Vtx
    const cacheDv = new Array(VTX_CACHE_SIZE).fill(null);
    // Vertices are transformed as they are loaded, as the RSP does, so a
    // matrix change after a G_VTX does not move what is already in the cache.
    const cachePos = new Array(VTX_CACHE_SIZE).fill(null); // [x, y, z] or null
    const cacheNrm = new Array(VTX_CACHE_SIZE).fill(null); // [nx, ny, nz] or null
    let mtx = null;           // current model-view matrix, null = identity
    const mtxStack = [];
    const normalMtx = new THREE.Matrix3();
    const _v = new THREE.Vector3();
    let geometryMode = DEFAULT_GEOMETRY_MODE;
    let texOn = true, texScaleS = 0.99998, texScaleT = 0.99998, renderTile = 0;
    let half1 = 0;

    // ---- RDP state
    let othermodeL = DEFAULT_OTHERMODE_L, othermodeH = DEFAULT_OTHERMODE_H;
    let mux = decodeCombine(DEFAULT_COMBINE[0], DEFAULT_COMBINE[1]);
    const prim = [0.5, 0.5, 0.5, 0.5], env = [0.5, 0.5, 0.5, 0.5];
    let primLodFrac = 0;
    let timg = { fmt: 0, siz: 0, width: 1, addr: 0 };
    const tiles = Array.from({ length: 8 }, () => ({
        fmt: 0, siz: 0, line: 0, tmem: 0, palette: 0, cms: 0, cmt: 0, masks: 0, maskt: 0, shifts: 0, shiftt: 0,
        uls: 0, ult: 0, lrs: 0, lrt: 0,
    }));
    const tmemLoads = new Map(); // tmem word address -> { src, fmt, siz, width, block, uls, ult }
    const tlutLoads = [];        // { tmem, count, src }

    // ---- textures
    const twoCycle = () => ((othermodeH >>> G_MDSFT_CYCLETYPE) & 3) === G_CYC_2CYCLE;
    const paletteFor = (tile) => {
        // TMEM word 256 + entry holds TLUT entry `entry`; a CI4 tile picks
        // one of 16 sub-palettes.
        const base = 256 + (tile.siz === SIZ_4B ? tile.palette * 16 : 0);
        const count = tile.siz === SIZ_4B ? 16 : 256;
        const palette = new Uint16Array(count);
        const keys = new Set();
        for (let i = 0; i < count; i++) {
            const word = base + i;
            for (let k = tlutLoads.length - 1; k >= 0; k--) {
                const load = tlutLoads[k];
                if (word >= load.tmem && word < load.tmem + load.count) {
                    const p = load.src.off + (word - load.tmem) * 2;
                    palette[i] = p + 1 < load.src.dv.byteLength ? load.src.dv.getUint16(p, false) : 0;
                    keys.add(load.src.key + '+' + load.count + '@' + load.tmem);
                    break;
                }
            }
        }
        return { palette, key: [...keys].join(',') + '/' + base };
    };
    // Decoded RGBA for the texture the given tile renders, or null.
    const textureForTile = (tileIndex) => {
        const tile = tiles[tileIndex];
        const load = tmemLoads.get(tile.tmem);
        if (!load) return null;
        if (!load.src) { missingTextures++; return null; }
        const width = Math.max(1, Math.round(tile.lrs - tile.uls) + 1);
        const height = Math.max(1, Math.round(tile.lrt - tile.ult) + 1);
        if (width > 1024 || height > 1024) return null;
        const bits = BITS[tile.siz];
        let rowBytes, origin;
        if (load.block) {
            rowBytes = (width * bits) >>> 3;
            origin = 0;
        } else {
            rowBytes = (load.width * BITS[load.siz]) >>> 3;
            origin = load.ult * rowBytes + ((load.uls * BITS[load.siz]) >>> 3);
        }
        const isCI = tile.fmt === FMT_CI;
        const pal = isCI ? paletteFor(tile) : null;
        const paletteIA = ((othermodeH >>> G_MDSFT_TEXTLUT) & 3) === G_TT_IA16;
        const key = `${load.src.key}+${origin}:${tile.fmt}/${tile.siz}:${width}x${height}:${rowBytes}` + (isCI ? `:${pal.key}:${paletteIA ? 'ia' : 'rgba'}` : '');
        let tex = caches.textures.get(key);
        if (!tex) {
            const src = { dv: load.src.dv, off: load.src.off + origin };
            tex = { key, width, height, rgba: decodeTexture(src, rowBytes, tile.fmt, tile.siz, width, height, pal?.palette, paletteIA) };
            caches.textures.set(key, tex);
        }
        return tex;
    };
    const opaqueAlpha = (t) => {
        const key = t.key + '~opaque';
        let tex = caches.textures.get(key);
        if (tex) return tex;
        const rgba = new Uint8Array(t.rgba);
        for (let i = 3; i < rgba.length; i += 4) rgba[i] = 255;
        tex = { key, width: t.width, height: t.height, rgba };
        caches.textures.set(key, tex);
        return tex;
    };

    // The tile's texel-coordinate transform: the vertex s/t (after the
    // G_TEXTURE scale) are shifted by the tile's shift, offset by its
    // upper-left corner and divided by the texture size to give 0..1 UVs.
    // Kept per layer, since a second tile usually maps the same vertex
    // coordinates at another scale (a detail texture under a large mask).
    const shiftScale = (shift) => (shift === 0 ? 1 : (shift <= 10 ? 1 / (1 << shift) : (1 << (16 - shift))));
    const layerFor = (tex, tileIndex) => {
        const t = tiles[tileIndex];
        return {
            tex,
            wrapS: wrapFor(t.cms, t.masks), wrapT: wrapFor(t.cmt, t.maskt),
            repeat: [shiftScale(t.shifts) / tex.width, shiftScale(t.shiftt) / tex.height],
            offset: [-t.uls / tex.width, -t.ult / tex.height],
        };
    };

    // The texture layers the current combiner shows: [] for none, one, or
    // two blended as `blend` says -- lerp (mix by a per-channel factor) or
    // mul. A second tile with the texture at another scale (MM's ground: a
    // 64x64 intensity mask times a 32x32 dirt texture at 1/16 scale) is why
    // the layers stay separate down to the shader (makeRoomMesh).
    const currentLayers = () => {
        if (!texOn) return { layers: [], blend: null };
        const use = combinerTexels(mux, twoCycle());
        const t0 = use.texel0 ? textureForTile(renderTile) : null;
        const t1 = use.texel1 ? textureForTile((renderTile + 1) & 7) : null;
        let layers = [], blend = null;
        if (t0 && t1) {
            // Cycle 1 colour: (a - b) * c + d
            const c = twoCycle() ? mux : mux.slice(8);
            const [a, b, cc, d] = c;
            const factor = (code) => {
                switch (code) {
                    case 3: return prim.slice(0, 4);
                    case 5: return env.slice(0, 4);
                    case 10: return [prim[3], prim[3], prim[3], prim[3]];
                    case 12: return [env[3], env[3], env[3], env[3]];
                    case 14: return [primLodFrac, primLodFrac, primLodFrac, primLodFrac];
                    default: return [0.5, 0.5, 0.5, 0.5]; // LOD_FRACTION: between mip levels
                }
            };
            layers = [layerFor(t0, renderTile), layerFor(t1, (renderTile + 1) & 7)];
            if (a === CC_TEXEL1 && b === CC_TEXEL0 && d === CC_TEXEL0) blend = { mode: 'lerp', factor: factor(cc) };
            else if (a === CC_TEXEL0 && b === CC_TEXEL1 && d === CC_TEXEL1) blend = { mode: 'lerp', factor: factor(cc).map(x => 1 - x) };
            else if ((a === CC_TEXEL0 && cc === CC_TEXEL1) || (a === CC_TEXEL1 && cc === CC_TEXEL0)) blend = { mode: 'mul', factor: [0, 0, 0, 0] };
            else layers = [layers[0]];
        } else if (t0) {
            layers = [layerFor(t0, renderTile)];
        } else if (t1) {
            layers = [layerFor(t1, (renderTile + 1) & 7)];
        }
        if (!use.alpha) for (const l of layers) l.tex = opaqueAlpha(l.tex);
        // The effect combiner -- fire, lava, magic: cycle 2 colour is
        // (PRIM - ENV) * COMBINED + ENV, an intensity texture picking a
        // colour between env and prim. The material can't do that with a
        // texture times a vertex colour, so the texel is baked through it
        // (with cycle 1's mix of two textures approximated by the first)
        // and the vertex colour left white.
        let bakedRGB = false;
        if (layers.length && twoCycle() && mux[8] === CC_PRIM && mux[9] === CC_ENV && mux[10] === CC_COMBINED && mux[11] === CC_ENV
            && [0, 1, 2].some(k => Math.abs(prim[k] - env[k]) > 0.01)) {
            layers = [{ ...layers[0], tex: gradientBake(layers[0].tex) }];
            blend = null;
            bakedRGB = true;
        }
        return { layers, blend, bakedRGB };
    };
    const gradientBake = (t) => {
        const key = t.key + '~grad:' + prim.slice(0, 3).map(x => x.toFixed(3)).join(',') + '/' + env.slice(0, 3).map(x => x.toFixed(3)).join(',');
        let tex = caches.textures.get(key);
        if (tex) return tex;
        const rgba = new Uint8Array(t.rgba);
        for (let i = 0; i < rgba.length; i += 4) {
            for (let k = 0; k < 3; k++) {
                const c = t.rgba[i + k] / 255;
                rgba[i + k] = Math.round(clamp01(env[k] + c * (prim[k] - env[k])) * 255);
            }
        }
        tex = { key, width: t.width, height: t.height, rgba };
        caches.textures.set(key, tex);
        return tex;
    };

    // ---- batches
    let batchState = null; // recomputed when the RDP state changes
    const invalidate = () => { batchState = null; };
    const layerKey = (l) => `${l.tex.key}:${l.wrapS}:${l.wrapT}:${l.repeat.map(x => x.toPrecision(6)).join(',')}:${l.offset.map(x => x.toPrecision(6)).join(',')}`;
    const batchFor = () => {
        if (batchState) return batchState;
        const { layers, blend, bakedRGB } = currentLayers();
        const cull = (geometryMode & G_CULL_BACK) ? ((geometryMode & G_CULL_FRONT) ? 'none' : 'back')
                   : ((geometryMode & G_CULL_FRONT) ? 'front' : 'double');
        const translucent = (othermodeL & FORCE_BL) !== 0;
        const depthWrite = (othermodeL & Z_UPD) !== 0;
        const decal = (othermodeL & ZMODE_MASK) === ZMODE_DEC;
        const texEdge = (othermodeL & CVG_X_ALPHA) !== 0;
        const key = [layers.map(layerKey).join('~'), blend ? blend.mode + blend.factor.map(x => x.toFixed(3)).join(',') : '-',
                     cull, translucent ? 1 : 0, depthWrite ? 1 : 0, decal ? 1 : 0, texEdge ? 1 : 0, bakedRGB ? 'g' : ''].join('|');
        let b = batches.get(key);
        if (!b) {
            b = { layers, blend, cull, translucent, depthWrite, decal, texEdge, bakedRGB, positions: [], uvs: [], colors: [] };
            batches.set(key, b);
        }
        batchState = { batch: b, textured: layers.length > 0 };
        return batchState;
    };

    // Per-vertex colour through the combiner (texels white), in linear space.
    const shadeOf = (dv, o, lit, nrm) => {
        const alpha = dv.getUint8(o + 15) / 255;
        if (!lit) return [dv.getUint8(o + 12) / 255, dv.getUint8(o + 13) / 255, dv.getUint8(o + 14) / 255, alpha];
        const [nx, ny, nz] = nrm;
        if (!light) {
            const d = Math.max(0, nx * 0.30 + ny * 0.86 + nz * 0.41);
            const i = 0.45 + 0.55 * d;
            return [i, i, i, alpha];
        }
        const c = light.ambient.slice();
        for (const l of light.lights) {
            const len = Math.hypot(l.dir[0], l.dir[1], l.dir[2]) || 1;
            const d = Math.max(0, (nx * l.dir[0] + ny * l.dir[1] + nz * l.dir[2]) / len);
            for (let k = 0; k < 3; k++) c[k] += l.color[k] * d;
        }
        return [clamp01(c[0]), clamp01(c[1]), clamp01(c[2]), alpha];
    };

    const emit = (ia, ib, ic) => {
        const { batch, textured } = batchFor();
        const lit = (geometryMode & G_LIGHTING) !== 0;
        const texGen = lit && (geometryMode & G_TEXTURE_GEN) !== 0;
        if (texGen && textured && !batch.texGen) {
            // Environment mapping: the UVs are already 0..1, so the layer
            // transforms must not scale them.
            batch.texGen = true;
            for (const l of batch.layers) { l.repeat = [1, 1]; l.offset = [0, 0]; }
        }
        const cyc2 = twoCycle();
        for (const slot of [ia, ib, ic]) {
            if (!cachePos[slot]) return;
        }
        for (const slot of [ia, ib, ic]) {
            const dv = cacheDv[slot], o = cache[slot];
            batch.positions.push(...cachePos[slot]);
            const nrm = cacheNrm[slot];
            if (texGen) {
                batch.uvs.push(0.5 + nrm[0] * 127 / 254, 0.5 - nrm[1] * 127 / 254);
            } else if (textured) {
                // Vtx.tc is s10.5 texels, scaled by G_TEXTURE's 0.16 factors;
                // each layer's tile transform takes it from there.
                batch.uvs.push((dv.getInt16(o + 8, false) / 32) * texScaleS, (dv.getInt16(o + 10, false) / 32) * texScaleT);
            } else {
                batch.uvs.push(0, 0);
            }
            const shade = shadeOf(dv, o, lit, nrm);
            const c = evalCombiner(mux, { shade, prim, env, lodFrac: primLodFrac }, cyc2);
            if (batch.bakedRGB) batch.colors.push(1, 1, 1, c[3]);
            else batch.colors.push(srgbToLinear(c[0]), srgbToLinear(c[1]), srgbToLinear(c[2]), c[3]);
        }
    };

    // ---- execution
    const run = (addr, depth) => {
        if (depth > 32) return;
        const start = resolve(addr);
        if (!start) return;
        const dv = start.dv;
        for (let o = start.off; o + 8 <= dv.byteLength; o += 8) {
            const w0 = dv.getUint32(o, false);
            const w1 = dv.getUint32(o + 4, false);
            switch (w0 >>> 24) {
                case G_ENDDL:
                    return;
                case G_DL: {
                    // MM's colour-animation segments stand for a
                    // "set prim (and env) colour" list (AnimatedMat_SetColor).
                    const colour = curSegments[(w1 >>> 24) & 0xF]?.colour;
                    if (colour) {
                        primLodFrac = colour.lodFrac;
                        prim.splice(0, 4, ...colour.prim);
                        if (colour.env) env.splice(0, 4, ...colour.env);
                        invalidate();
                        break;
                    }
                    if (((w0 >>> 16) & 0xFF) === 1) { run(w1, depth + 1); return; } // branch
                    run(w1, depth + 1);
                    break;
                }
                case G_RDPHALF_1:
                    half1 = w1;
                    break;
                case G_BRANCH_Z:
                    // LOD: the list branches to its near version when the
                    // camera is close (spot16, spot17). Always be close.
                    run(half1, depth + 1);
                    return;
                case G_VTX: {
                    const n = (w0 >>> 12) & 0xFF;
                    const v0 = ((w0 >>> 1) & 0x7F) - n;
                    const src = resolve(w1);
                    if (mtx) normalMtx.getNormalMatrix(mtx);
                    for (let k = 0; k < n && v0 + k < VTX_CACHE_SIZE; k++) {
                        if (v0 + k < 0) continue;
                        const o = src ? src.off + k * VTX_SIZE : -1;
                        if (!src || o + VTX_SIZE > src.dv.byteLength) {
                            cache[v0 + k] = -1;
                            cacheDv[v0 + k] = null;
                            cachePos[v0 + k] = cacheNrm[v0 + k] = null;
                            continue;
                        }
                        const dv = src.dv;
                        cache[v0 + k] = o;
                        cacheDv[v0 + k] = dv;
                        _v.set(dv.getInt16(o, false), dv.getInt16(o + 2, false), dv.getInt16(o + 4, false));
                        if (mtx) _v.applyMatrix4(mtx);
                        cachePos[v0 + k] = [_v.x, _v.y, _v.z];
                        _v.set(dv.getInt8(o + 12) / 127, dv.getInt8(o + 13) / 127, dv.getInt8(o + 14) / 127);
                        if (mtx) _v.applyMatrix3(normalMtx).normalize();
                        cacheNrm[v0 + k] = [_v.x, _v.y, _v.z];
                    }
                    break;
                }
                case G_MTX: {
                    const params = (w0 & 0xFF) ^ G_MTX_PUSH;
                    if (params & G_MTX_PROJECTION) break;
                    const flex = curSegments[SEG_FLEX_MATRICES]?.matrices;
                    const m = (flex && ((w1 >>> 24) & 0xF) === SEG_FLEX_MATRICES)
                        ? (flex[(w1 & 0xFFFFFF) >>> 6] ?? null) : readMtx(w1);
                    if (params & G_MTX_PUSH) mtxStack.push(mtx);
                    if (params & G_MTX_LOAD) mtx = m ? m.clone() : null;
                    else if (m) mtx = mtx ? mtx.clone().multiply(m) : m.clone();
                    break;
                }
                case G_POPMTX:
                    for (let k = Math.max(1, w1 >>> 6); k > 0 && mtxStack.length; k--) mtx = mtxStack.pop();
                    break;
                case G_TRI1:
                    emit(((w0 >>> 16) & 0xFF) >>> 1, ((w0 >>> 8) & 0xFF) >>> 1, (w0 & 0xFF) >>> 1);
                    break;
                case G_TRI2:
                case G_QUAD:
                    emit(((w0 >>> 16) & 0xFF) >>> 1, ((w0 >>> 8) & 0xFF) >>> 1, (w0 & 0xFF) >>> 1);
                    emit(((w1 >>> 16) & 0xFF) >>> 1, ((w1 >>> 8) & 0xFF) >>> 1, (w1 & 0xFF) >>> 1);
                    break;
                case G_CULLDL:
                    break;
                case G_GEOMETRYMODE:
                    geometryMode = (geometryMode & (w0 & 0xFFFFFF)) | w1;
                    invalidate();
                    break;
                case G_TEXTURE:
                    texOn = ((w0 >>> 1) & 0x7F) !== 0;
                    renderTile = (w0 >>> 8) & 7;
                    texScaleS = (w1 >>> 16) / 65536;
                    texScaleT = (w1 & 0xFFFF) / 65536;
                    invalidate();
                    break;
                case G_SETOTHERMODE_L: {
                    const len = (w0 & 0xFF) + 1;
                    const sft = 32 - ((w0 >>> 8) & 0xFF) - len;
                    const mask = len >= 32 ? 0xFFFFFFFF : (((1 << len) - 1) << sft) >>> 0;
                    othermodeL = ((othermodeL & ~mask) | (w1 & mask)) >>> 0;
                    invalidate();
                    break;
                }
                case G_SETOTHERMODE_H: {
                    const len = (w0 & 0xFF) + 1;
                    const sft = 32 - ((w0 >>> 8) & 0xFF) - len;
                    const mask = len >= 32 ? 0xFFFFFFFF : (((1 << len) - 1) << sft) >>> 0;
                    othermodeH = ((othermodeH & ~mask) | (w1 & mask)) >>> 0;
                    invalidate();
                    break;
                }
                case G_SETCOMBINE:
                    mux = decodeCombine(w0, w1);
                    invalidate();
                    break;
                case G_SETPRIMCOLOR:
                    primLodFrac = (w0 & 0xFF) / 256;
                    prim[0] = (w1 >>> 24) / 255; prim[1] = ((w1 >>> 16) & 0xFF) / 255;
                    prim[2] = ((w1 >>> 8) & 0xFF) / 255; prim[3] = (w1 & 0xFF) / 255;
                    invalidate();
                    break;
                case G_SETENVCOLOR:
                    env[0] = (w1 >>> 24) / 255; env[1] = ((w1 >>> 16) & 0xFF) / 255;
                    env[2] = ((w1 >>> 8) & 0xFF) / 255; env[3] = (w1 & 0xFF) / 255;
                    invalidate();
                    break;
                case G_SETTIMG:
                    timg = { fmt: (w0 >>> 21) & 7, siz: (w0 >>> 19) & 3, width: (w0 & 0xFFF) + 1, addr: w1 };
                    break;
                case G_SETTILE: {
                    const tile = tiles[(w1 >>> 24) & 7];
                    tile.fmt = (w0 >>> 21) & 7;
                    tile.siz = (w0 >>> 19) & 3;
                    tile.line = (w0 >>> 9) & 0x1FF;
                    tile.tmem = w0 & 0x1FF;
                    tile.palette = (w1 >>> 20) & 0xF;
                    tile.cmt = (w1 >>> 18) & 3;
                    tile.maskt = (w1 >>> 14) & 0xF;
                    tile.shiftt = (w1 >>> 10) & 0xF;
                    tile.cms = (w1 >>> 8) & 3;
                    tile.masks = (w1 >>> 4) & 0xF;
                    tile.shifts = w1 & 0xF;
                    invalidate();
                    break;
                }
                case G_SETTILESIZE: {
                    const tile = tiles[(w1 >>> 24) & 7];
                    tile.uls = ((w0 >>> 12) & 0xFFF) / 4;
                    tile.ult = (w0 & 0xFFF) / 4;
                    tile.lrs = ((w1 >>> 12) & 0xFFF) / 4;
                    tile.lrt = (w1 & 0xFFF) / 4;
                    invalidate();
                    break;
                }
                case G_LOADBLOCK:
                case G_LOADTILE: {
                    const tile = tiles[(w1 >>> 24) & 7];
                    tmemLoads.set(tile.tmem, {
                        src: resolve(timg.addr), fmt: timg.fmt, siz: timg.siz, width: timg.width,
                        block: (w0 >>> 24) === G_LOADBLOCK,
                        uls: ((w0 >>> 12) & 0xFFF) >>> 2, ult: (w0 & 0xFFF) >>> 2,
                    });
                    invalidate();
                    break;
                }
                case G_LOADTLUT: {
                    const tile = tiles[(w1 >>> 24) & 7];
                    const src = resolve(timg.addr);
                    if (src) tlutLoads.push({ tmem: tile.tmem, count: ((w1 >>> 14) & 0x3FF) + 1, src });
                    invalidate();
                    break;
                }
                default:
                    break;
            }
        }
    };

    for (const item of items) {
        curSegments = item.segments ?? segments;
        mtx = item.matrix ?? null;
        mtxStack.length = 0;
        // Colours the issuing code set before the list (an actor's Draw).
        if (item.prim) { prim.splice(0, 4, ...item.prim.map(c => c / 255)); invalidate(); }
        if (item.env) { env.splice(0, 4, ...item.env.map(c => c / 255)); invalidate(); }
        run(item.addr, 0);
    }
    };

    runList(lists.opa ?? []);
    runList(lists.xlu ?? []);
    return { batches: [...batches.values()].filter(b => b.positions.length), missingTextures };
}

////////////////////////////////////////
// three.js meshes
////////////////////////////////////////

// Between the collision mesh (factor 1, units 1) and its wireframe (none).
const ROOM_POLYGON_OFFSET = 0.5;

// Gfx_TexScroll / Gfx_TwoTexScroll build a list of one gDPSetTileSize per
// tile (at the frame's scroll offset, 0 here) that a texture list jumps into
// through its segment; rebuild it from { scroll: [[tile, width, height]] }.
export function scrollSegment(tiles) {
    const dv = new DataView(new ArrayBuffer(tiles.length * 8 + 8));
    tiles.forEach(([tile, w, h], i) => {
        dv.setUint32(i * 8, G_SETTILESIZE << 24, false);
        dv.setUint32(i * 8 + 4, ((tile << 24) | (((w - 1) << 2) << 12) | ((h - 1) << 2)) >>> 0, false);
    });
    dv.setUint32(tiles.length * 8, G_ENDDL << 24, false);
    return { dv, base: 0, key: 'scroll:' + tiles.map(t => t.join('x')).join(',') };
}

// A three.js texture for a layer: one DataTexture per decoded texture,
// cloned per (wrap, transform) combination; the clones share the pixels.
function layerTexture(layer, caches) {
    const key = `${layer.tex.key}:${layer.wrapS}:${layer.wrapT}:${layer.repeat}:${layer.offset}`;
    let dt = caches.dataTextures.get(key);
    if (dt) return dt;
    const base = caches.dataTextures.get(layer.tex.key);
    if (base) {
        dt = base.clone();
    } else {
        dt = new THREE.DataTexture(layer.tex.rgba, layer.tex.width, layer.tex.height, THREE.RGBAFormat);
        dt.flipY = false;
        dt.colorSpace = THREE.SRGBColorSpace;
        dt.magFilter = THREE.LinearFilter;
        dt.minFilter = THREE.LinearFilter;
        dt.generateMipmaps = false;
        caches.dataTextures.set(layer.tex.key, dt);
    }
    dt.wrapS = layer.wrapS;
    dt.wrapT = layer.wrapT;
    dt.repeat.set(layer.repeat[0], layer.repeat[1]);
    dt.offset.set(layer.offset[0], layer.offset[1]);
    dt.needsUpdate = true;
    caches.dataTextures.set(key, dt);
    return dt;
}

// Two-layer materials: MeshBasicMaterial with a second sampler patched into
// its map lookup. The first layer goes through the material's own map (and
// its uv transform); the second is sampled at that same uv re-transformed
// into its own tile's space, and the two are combined as the colour
// combiner's first cycle does.
function patchTwoLayers(material, layer0, layer1, tex1, blend) {
    // vMapUv = uv * r0 + o0, so uv1 = uv * r1 + o1 = vMapUv * (r1 / r0) + (o1 - o0 * r1 / r0)
    const rs = layer1.repeat[0] / layer0.repeat[0], rt = layer1.repeat[1] / layer0.repeat[1];
    const uv1 = new THREE.Vector4(rs, rt, layer1.offset[0] - layer0.offset[0] * rs, layer1.offset[1] - layer0.offset[1] * rt);
    const factor = new THREE.Vector4(...blend.factor);
    material.onBeforeCompile = (shader) => {
        shader.uniforms.map1 = { value: tex1 };
        shader.uniforms.map1Uv = { value: uv1 };
        shader.uniforms.blendFactor = { value: factor };
        shader.fragmentShader = shader.fragmentShader
            .replace('#include <map_pars_fragment>',
                '#include <map_pars_fragment>\nuniform sampler2D map1; uniform vec4 map1Uv; uniform vec4 blendFactor;')
            .replace('#include <map_fragment>',
                'vec4 texel0 = texture2D( map, vMapUv );\n' +
                'vec4 texel1 = texture2D( map1, vMapUv * map1Uv.xy + map1Uv.zw );\n' +
                (blend.mode === 'mul' ? 'diffuseColor *= texel0 * texel1;' : 'diffuseColor *= mix( texel0, texel1, blendFactor );'));
    };
    // Distinct shader programs per blend mode
    material.customProgramCacheKey = () => 'zelda2layer:' + blend.mode;
}

/**
 * One three.js mesh from replayed batches: a geometry group and a material
 * per batch. options.polygonOffset (default ROOM_POLYGON_OFFSET) sets the
 * opaque batches' offset; options.selectable keeps clicks on the mesh
 * (rooms let them through to the collision underneath).
 */
export function makeZeldaMesh(batches, caches, options = {}) {
    const polygonOffset = options.polygonOffset ?? ROOM_POLYGON_OFFSET;
    const geometry = new THREE.BufferGeometry();
    const positions = [], uvs = [], colors = [], materials = [];
    let start = 0;
    for (const batch of batches) {
        const count = batch.positions.length / 3;
        positions.push(...batch.positions);
        uvs.push(...batch.uvs);
        if (batch.translucent) {
            colors.push(...batch.colors);
        } else {
            for (let i = 0; i < batch.colors.length; i += 4) colors.push(batch.colors[i], batch.colors[i + 1], batch.colors[i + 2], 1);
        }
        geometry.addGroup(start, count, materials.length);
        start += count;

        const material = new THREE.MeshBasicMaterial({
            vertexColors: true,
            side: batch.cull === 'back' ? THREE.FrontSide : (batch.cull === 'front' ? THREE.BackSide : THREE.DoubleSide),
            transparent: batch.translucent,
            depthWrite: batch.depthWrite,
            alphaTest: batch.translucent ? 0.01 : (batch.texEdge ? 0.5 : 0),
            polygonOffset: true,
            polygonOffsetFactor: batch.decal ? -1 : polygonOffset,
            polygonOffsetUnits: batch.decal ? -1 : polygonOffset,
        });
        if (batch.cull === 'none') material.visible = false; // G_CULL_BOTH draws nothing
        if (batch.layers.length) {
            material.map = layerTexture(batch.layers[0], caches);
            if (batch.layers.length > 1) {
                patchTwoLayers(material, batch.layers[0], batch.layers[1], layerTexture(batch.layers[1], caches), batch.blend);
            }
        }
        materials.push(material);
    }
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 4));
    const mesh = new THREE.Mesh(geometry, materials);
    mesh.name = 'textured';
    // Clicks go through to the collision mesh underneath (selection.js).
    if (!options.selectable) mesh.userData.unselectable = true;
    mesh.userData.textured = true;
    return { mesh, triangleCount: start / 3 };
}

////////////////////////////////////////
// Scene entry point
////////////////////////////////////////

const ROOM_GROUP_KEY = 'oot-rooms';
let texturedRoot = null;

/** models/<game>/ file name of a scene's room (the decomp's naming). */
export function zeldaRoomFileName(game, sceneName, index) {
    if (game === "MM") return `${sceneName}_room_${String(index).padStart(2, '0')}`;
    return `${sceneName.replace(/_scene$/, '')}_room_${index}`;
}

/** MM: models/MM/ file name of the scene's area texture file, or null. */
export function zeldaAreaTextureFileName(game, sceneBuffer) {
    if (game !== "MM") return null;
    const index = parseZeldaSceneInfo(sceneBuffer).areaTextureIndex;
    return index ? `scene_texture_${String(index).padStart(2, '0')}` : null;
}

// MM: the segments the scene's animated material list sets, at step 0
// (AnimatedMat_DrawMain): colour keyframe types become a colour segment
// (their first prim / env colour), a texture cycle points its segment at
// its first texture, and texture scrolls change nothing here.
function animatedMaterialSegments(info, sceneDv, sceneName) {
    const segments = {};
    for (const mat of info.animatedMaterials) {
        const p = mat.params;
        if (mat.type === ANIM_MAT_COLOR || mat.type === ANIM_MAT_COLOR_LERP || mat.type === ANIM_MAT_COLOR_NONLINEAR) {
            // AnimatedMatColorParams { u16 keyFrameLength; u16 keyFrameCount; F3DPrimColor* primColors; F3DEnvColor* envColors; u16* keyFrames }
            if (p + 16 > sceneDv.byteLength) continue;
            const primAddr = sceneDv.getUint32(p + 4, false), envAddr = sceneDv.getUint32(p + 8, false);
            const primOff = primAddr & 0xFFFFFF, envOff = envAddr & 0xFFFFFF;
            if ((primAddr >>> 24) !== SEG_SCENE || primOff + 5 > sceneDv.byteLength) continue;
            const c = (o, i) => sceneDv.getUint8(o + i) / 255;
            const colour = {
                prim: [c(primOff, 0), c(primOff, 1), c(primOff, 2), c(primOff, 3)],
                lodFrac: sceneDv.getUint8(primOff + 4) / 256,
                env: (envAddr && (envAddr >>> 24) === SEG_SCENE && envOff + 4 <= sceneDv.byteLength)
                    ? [c(envOff, 0), c(envOff, 1), c(envOff, 2), c(envOff, 3)] : null,
            };
            segments[mat.segment] = { colour };
        } else if (mat.type === ANIM_MAT_TEX_CYCLE) {
            // AnimatedMatTexCycleParams { u16 keyFrameLength; TexturePtr* textureList; u8* textureIndexList }
            if (p + 12 > sceneDv.byteLength) continue;
            const listAddr = sceneDv.getUint32(p + 4, false), indexAddr = sceneDv.getUint32(p + 8, false);
            if ((listAddr >>> 24) !== SEG_SCENE || (indexAddr >>> 24) !== SEG_SCENE) continue;
            const first = sceneDv.getUint8(indexAddr & 0xFFFFFF);
            const texAddr = sceneDv.getUint32((listAddr & 0xFFFFFF) + first * 4, false);
            if ((texAddr >>> 24) !== SEG_SCENE) continue;
            segments[mat.segment] = { dv: sceneDv, base: texAddr & 0xFFFFFF, key: sceneName };
        }
    }
    return segments;
}

/**
 * Build the textured rooms of a scene and add them to the sidebar.
 * sceneName: the scene file name (OOT_Maps / MM_Maps .file), which keys OOT_Scene_Segments.
 * rooms: [{ index, buffer }] the room files that could be fetched.
 * options.game: "OOT" (default) or "MM".
 * options.areaTextures: MM, the scene's scene_texture file (ArrayBuffer), or null.
 */
export function renderZeldaSceneTextured(scene, sceneBuffer, rooms, sceneName, options = {}) {
    const game = options.game === "MM" ? "MM" : "OOT";
    const info = parseZeldaSceneInfo(sceneBuffer);
    const sceneDv = new DataView(sceneBuffer);
    const files = new Map([[sceneName, sceneDv]]);
    for (const r of rooms) files.set(zeldaRoomFileName(game, sceneName, r.index), new DataView(r.buffer));

    const extraSegments = {};
    // Colours the scene's draw config sets before the room lists run.
    const colours = {};
    if (game === "OOT") {
        const table = (typeof OOT_Scene_Segments !== 'undefined' && OOT_Scene_Segments[sceneName]) || {};
        for (const [seg, e] of Object.entries(table)) {
            if (seg === 'prim' || seg === 'env') {
                colours[seg] = e;
            } else if (e.scroll) {
                extraSegments[seg] = scrollSegment(e.scroll);
            } else {
                const dv = files.get(e.file);
                if (dv) extraSegments[seg] = { dv, base: e.offset, key: e.file };
            }
        }
    } else {
        Object.assign(extraSegments, animatedMaterialSegments(info, sceneDv, sceneName));
        if (options.areaTextures) {
            extraSegments[SEG_AREA_TEXTURES] = { dv: new DataView(options.areaTextures), base: 0, key: 'area' };
        } else {
            // Great Bay Temple's draw config points segment 6 at "prim colour
            // white, lod fraction 0" lists for its pipes (z_scene_proc.c).
            extraSegments[SEG_AREA_TEXTURES] = { colour: { prim: [1, 1, 1, 1], lodFrac: 0, env: null } };
        }
    }
    const caches = { textures: new Map(), dataTextures: new Map() };

    resetGroupModelState(ROOM_GROUP_KEY);
    texturedRoot = new THREE.Group();
    texturedRoot.name = 'Textured Rooms';
    texturedRoot.visible = isTexturedMode();
    scene.add(texturedRoot);
    loadedModelsNotSelectable.push({ name: texturedRoot.name, mesh: texturedRoot, edges: null });

    let group = null;
    let totalTriangles = 0, totalMissing = 0;
    for (const r of rooms) {
        const roomDv = files.get(zeldaRoomFileName(game, sceneName, r.index));
        const segments = new Array(16).fill(null);
        segments[SEG_SCENE] = { dv: sceneDv, base: 0, key: sceneName };
        segments[SEG_ROOM] = { dv: roomDv, base: 0, key: `room${r.index}` };
        for (const [seg, e] of Object.entries(extraSegments)) segments[seg] = e;

        let result;
        try {
            const entries = parseRoomShape(roomDv);
            result = replayRoom(entries, segments, info.light, caches, colours);
        } catch (err) {
            console.warn(`${sceneName} room ${r.index}: textured build failed: ${err.message}`);
            continue;
        }
        if (!result.batches.length) continue;
        const { mesh, triangleCount } = makeZeldaMesh(result.batches, caches);
        totalTriangles += triangleCount;
        totalMissing += result.missingTextures;

        const roomGroup = new THREE.Group();
        roomGroup.name = `Room ${r.index}`;
        roomGroup.add(mesh);
        texturedRoot.add(roomGroup);

        if (!group) group = getModelGroup(ROOM_GROUP_KEY, 'Textured Rooms');
        loadedModels.push({ name: roomGroup.name, root: roomGroup, mesh: roomGroup, edges: null });
        addModelCheckbox(scene, roomGroup.name, roomGroup, null, false, true, null, false, false, group.body);
    }
    console.log(`${sceneName}: ${rooms.length} rooms, ${totalTriangles} textured triangles, ${caches.textures.size} textures` +
                (totalMissing ? `, ${totalMissing} texture loads from unmapped segments` : ''));
}

// The shared "Textures" checkbox shows / hides the rooms as a whole; the
// rows keep their own state underneath it.
VIEW_CONTROLS[0]?.addEventListener('change', () => {
    if (texturedRoot) texturedRoot.visible = isTexturedMode();
});
