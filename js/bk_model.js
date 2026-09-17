////////////////////////////////////////
// System: Banjo-Kazooie model file (BKModelBin) geometry decoding
////////////////////////////////////////
//
// Pulls renderable triangles out of a BK model asset (see
// banjo-kazooie/include/core2/model.h for the file layout). Two sources:
//
//  - the collision list: what the game collides with. Stored as a spatial
//    grid, so a triangle appears once per cell it overlaps and has to be
//    deduplicated (same issue parseBKModelBinary handles for map models).
//  - the display lists: what the game draws. Only needed for models with no
//    collision (about half the props), decoded by replaying the G_VTX /
//    G_TRI1 / G_TRI2 / G_QUAD commands against a vertex cache.
//
// Both index into the same BKVertexList, so a caller gets one position
// array plus one index array per source.
//
// Banjo-Tooie uses the same file format with two differences, selected by
// passing game: "BT": its display lists are F3DEX2 (different RSP opcodes
// and encodings; the RDP commands are identical) and its texture list
// entries are 8 bytes. See UCODES below.

const MODEL_MAGIC = 0x0000000B;

// RSP microcode differences. modelRender_draw points segment 1 at the
// model's vertex list, so every G_VTX address is 0x01xxxxxx with the low 24
// bits a byte offset into the Vtx array (16 bytes per vertex); that is the
// same in both games.
//
//   F3DEX (BK):  G_VTX w0 = | 04 | v0*2:8 | (n-1):6 (n*16-1):10 |
//                G_TRI1 in w1, G_QUAD w1 = 4 slots, geometry mode set/clear
//                are separate commands, G_DL 0x06.
//   F3DEX2 (BT): G_VTX w0 = | 01 | 0:4 n:8 | 0:4 | (v0+n)*2:8 |
//                G_TRI1 in w0, no G_QUAD (07 is the TRI2 layout),
//                G_GEOMETRYMODE clears ~w0[23:0] then sets w1, G_DL 0xDE.
//                G_CULL_BACK moved from bit 13 to bit 10.
const UCODES = {
    BK: {
        ops: { 0x04: 'VTX', 0xBF: 'TRI1', 0xB1: 'TRI2', 0xB5: 'QUAD', 0x06: 'DL', 0xB8: 'ENDDL',
               0xB6: 'CLEARGEOMETRYMODE', 0xB7: 'SETGEOMETRYMODE', 0xBB: 'TEXTURE' },
        cullBack: 0x00002000,
        textureEntrySize: 16,
        vtx: (w0) => ({ v0: ((w0 >>> 16) & 0xFF) >>> 1, n: ((w0 >>> 10) & 0x3F) + 1 }),
        tri1: (w0, w1) => w1,
        // w0: | op | 0 | level:3 tile:3 | on |
        texture: (w0) => ({ on: (w0 & 0xFF) !== 0, tile: (w0 >>> 8) & 7 }),
    },
    BT: {
        ops: { 0x01: 'VTX', 0x05: 'TRI1', 0x06: 'TRI2', 0x07: 'TRI2', 0xDE: 'DL', 0xDF: 'ENDDL',
               0xD9: 'GEOMETRYMODE', 0xD7: 'TEXTURE' },
        cullBack: 0x00000400,
        textureEntrySize: 8,
        vtx: (w0) => { const n = (w0 >>> 12) & 0xFF; return { v0: (((w0 >>> 1) & 0x7F) - n), n }; },
        tri1: (w0, w1) => w0,
        // w0: | op | 0 | 0:2 level:3 tile:3 | on:7 0 |
        texture: (w0) => ({ on: ((w0 >>> 1) & 0x7F) !== 0, tile: (w0 >>> 8) & 7 }),
    },
};
const VERTEX_SEGMENT = 0x01;
const VTX_CACHE_SIZE = 32;
const VTX_SIZE = 16;

// Number of Vtx records a model's vertex list holds. BK's BKVertexList
// header stores it at +0x14; BT keeps something else in that slot (it is
// usually larger than the list, sometimes smaller), so the list is sized
// from the space up to the next section instead, which is also a safe cap
// for BK.
function vertexListCount(dv, vtxListOffset, game) {
    let end = dv.byteLength;
    for (const o of [0x04, 0x0C, 0x14, 0x18, 0x1C, 0x20, 0x24, 0x28, 0x2C]) {
        const off = dv.getInt32(o, false);
        if (off > vtxListOffset && off < end) end = off;
    }
    const texOff = dv.getInt16(0x08, false);
    if (texOff > vtxListOffset && texOff < end) end = texOff;
    const spaceCount = Math.max(0, Math.floor((end - vtxListOffset - 0x18) / VTX_SIZE));
    if (game === "BT") return spaceCount;
    return Math.min(dv.getInt16(vtxListOffset + 0x14, false), spaceCount);
}

/**
 * @param {ArrayBuffer} buffer a decompressed BKModelBin
 * @returns {{positions: Float32Array, vertexCount: number,
 *            collisionIndices: Uint16Array|Uint32Array|null,
 *            displayListIndices: Uint16Array|Uint32Array|null,
 *            bounds: {center: number[], localNorm: number, globalNorm: number},
 *            hitVolumes: object|null}}
 *   bounds is the BKVertexList header: the model-space centre, the distance
 *   from it to the furthest vertex (local_norm) and the same from the origin
 *   (global_norm). The game's actor touch sphere is centre / local_norm --
 *   unless the model has hitVolumes (see parseHitVolumes), which replace it.
 * @param {"BK"|"BT"} game which game's model this is (see UCODES)
 */
export function parseBKModelGeometry(buffer, game = "BK") {
    const ucode = UCODES[game] ?? UCODES.BK;
    const dv = new DataView(buffer);
    if (dv.byteLength < 0x38 || dv.getUint32(0, false) !== MODEL_MAGIC) {
        throw new Error('not a BK model file');
    }

    const gfxListOffset = dv.getInt32(0x0C, false);
    const vtxListOffset = dv.getInt32(0x10, false);
    const collisionListOffset = dv.getInt32(0x1C, false);
    if (!vtxListOffset) {
        throw new Error('model has no vertex list');
    }

    // BKVertexList: min[3], max[3], center[3], local_norm, count, global_norm, Vtx[]
    const vertexCount = vertexListCount(dv, vtxListOffset, game);
    const vtxBase = vtxListOffset + 0x18;
    const bounds = {
        center: [dv.getInt16(vtxListOffset + 0xC, false), dv.getInt16(vtxListOffset + 0xE, false),
            dv.getInt16(vtxListOffset + 0x10, false)],
        localNorm: dv.getInt16(vtxListOffset + 0x12, false),
        globalNorm: dv.getInt16(vtxListOffset + 0x16, false),
    };
    const positions = new Float32Array(vertexCount * 3);
    for (let i = 0; i < vertexCount; i++) {
        const o = vtxBase + i * VTX_SIZE;
        positions[3 * i] = dv.getInt16(o, false);
        positions[3 * i + 1] = dv.getInt16(o + 2, false);
        positions[3 * i + 2] = dv.getInt16(o + 4, false);
    }

    const IndexArray = vertexCount > 65535 ? Uint32Array : Uint16Array;

    let collisionIndices = null;
    if (collisionListOffset) {
        // BKCollisionList: min[3], max[3], y_stride, z_stride, geo_count, scale,
        // tri_count, pad, BKCollisionGeometry[geo_count], BKCollisionTriangle[tri_count]
        const geoCount = dv.getInt16(collisionListOffset + 0x10, false);
        const triCount = dv.getInt16(collisionListOffset + 0x14, false);
        let o = collisionListOffset + 0x18 + geoCount * 4;
        const seen = new Set();
        const out = [];
        for (let i = 0; i < triCount; i++, o += 12) {
            const a = dv.getInt16(o, false);
            const b = dv.getInt16(o + 2, false);
            const c = dv.getInt16(o + 4, false);
            if (pushUniqueTri(out, seen, a, b, c, vertexCount)) continue;
        }
        collisionIndices = IndexArray.from(out);
    }

    let displayListIndices = null;
    if (gfxListOffset) {
        // BKGfxList: u32 size (command count), u32 pad, Gfx list[]. The list
        // usually holds several display lists back to back (one per
        // geo-command LOADDL). Walking it linearly draws each exactly once;
        // G_DL calls are ignored since their targets are inside the same
        // region and get walked anyway. Vertex cache state carries across,
        // which is harmless: every list loads its own vertices first.
        const cmdCount = dv.getUint32(gfxListOffset, false);
        const cache = new Int32Array(VTX_CACHE_SIZE).fill(-1);
        const seen = new Set();
        const out = [];
        let o = gfxListOffset + 8;
        for (let i = 0; i < cmdCount && o + 8 <= dv.byteLength; i++, o += 8) {
            const w0 = dv.getUint32(o, false);
            const w1 = dv.getUint32(o + 4, false);
            const op = ucode.ops[w0 >>> 24];
            if (op === 'VTX') {
                const { v0, n } = ucode.vtx(w0);
                if ((w1 >>> 24) !== VERTEX_SEGMENT) continue;
                const first = (w1 & 0xFFFFFF) / VTX_SIZE;
                for (let k = 0; k < n && v0 + k < VTX_CACHE_SIZE; k++) {
                    if (v0 + k < 0) continue;
                    const idx = first + k;
                    cache[v0 + k] = idx < vertexCount ? idx : -1;
                }
            } else if (op === 'TRI1') {
                pushCacheTri(out, seen, cache, ucode.tri1(w0, w1), vertexCount);
            } else if (op === 'TRI2') {
                pushCacheTri(out, seen, cache, w0, vertexCount);
                pushCacheTri(out, seen, cache, w1, vertexCount);
            } else if (op === 'QUAD') {
                // w1: | v0*2 | v1*2 | v2*2 | v3*2 |  -> (v0,v1,v2), (v0,v2,v3)
                const a = cache[((w1 >>> 24) & 0xFF) >>> 1];
                const b = cache[((w1 >>> 16) & 0xFF) >>> 1];
                const c = cache[((w1 >>> 8) & 0xFF) >>> 1];
                const d = cache[(w1 & 0xFF) >>> 1];
                pushUniqueTri(out, seen, a, b, c, vertexCount);
                pushUniqueTri(out, seen, a, c, d, vertexCount);
            }
        }
        displayListIndices = IndexArray.from(out);
    }

    return {
        positions, vertexCount, collisionIndices, displayListIndices, bounds,
        refPoints: collectRefPoints(dv), hitVolumes: parseHitVolumes(dv),
    };
}

// Hit volume list (BKModelUnk14List at header +0x14). When a model has one,
// the game tests Banjo against these instead of the vertex list's bounding
// sphere: marker_loadModelBin installs func_80330974 as the marker's
// collision test, and func_803322F0 calls it in place of the sphere check.
// The test (bkmodelunk14list_func_802EBAE0, core2/code_637D0.c) first
// rejects anything outside `radius` of the actor's position, then walks
// the boxes, cylinders and spheres in model space. Each may be pinned to a
// bone, in which case the game moves it with the animation; this is the
// rest pose, which is also exactly what the game uses for actors without an
// animation matrix list. `id` is what the actor is told was hit.
//
//   header:   s16 boxCount, s16 cylinderCount, s16 sphereCount, s16 radius
//   box:      s16 min[3], s16 max[3], s16 pivot[3], u8 rot[3] (deg/2), u8 id, s8 bone, pad
//             - an axis-aligned box [min, max] rotated about `pivot`
//   cylinder: s16 radius, s16 height, s16 centre[3], u8 rot[3] (deg/2), u8 id, s8 bone, pad
//             - axis along local Z, centred on `centre`, then rotated about it
//   sphere:   s16 radius, s16 centre[3], u8 id, s8 bone, pad[2]
//
// Rotations are applied yaw, then pitch, then roll (func_80252DDC /
// func_80252EC8 undo them roll-first), i.e. three.js Euler order 'ZXY'.
function parseHitVolumes(dv) {
    const base = dv.getInt32(0x14, false);
    if (!base || base + 8 > dv.byteLength) return null;
    const s16 = o => dv.getInt16(o, false);
    const vec = o => [s16(o), s16(o + 2), s16(o + 4)];
    const rot = o => [dv.getUint8(o) * 2, dv.getUint8(o + 1) * 2, dv.getUint8(o + 2) * 2];
    const boxCount = s16(base);
    const cylinderCount = s16(base + 2);
    const sphereCount = s16(base + 4);
    const radius = s16(base + 6);
    let o = base + 8;
    const boxes = [];
    for (let i = 0; i < boxCount; i++, o += 0x18) {
        boxes.push({ min: vec(o), max: vec(o + 6), pivot: vec(o + 12), rot: rot(o + 18), id: dv.getUint8(o + 21), bone: dv.getInt8(o + 22) });
    }
    const cylinders = [];
    for (let i = 0; i < cylinderCount; i++, o += 0x10) {
        cylinders.push({ radius: s16(o), height: s16(o + 2), center: vec(o + 4), rot: rot(o + 10), id: dv.getUint8(o + 13), bone: dv.getInt8(o + 14) });
    }
    const spheres = [];
    for (let i = 0; i < sphereCount; i++, o += 0xC) {
        spheres.push({ radius: s16(o), center: vec(o + 2), id: dv.getUint8(o + 8), bone: dv.getInt8(o + 9) });
    }
    return { radius, boxes, cylinders, spheres };
}

// REFPOINT geo commands (modelRender_geoCmd_REFPOINT) publish a model-space
// point under an index that actors attached to the model look up at runtime
// (Clanker's screw and teeth sit on ref points 5, 7 and 9). The game moves
// each point by its bone's animation matrix; this is the rest pose.
function collectRefPoints(dv) {
    const points = new Map();
    const geoListOffset = dv.getInt32(0x04, false);
    if (!geoListOffset) return points;
    let steps = 0;
    const walk = (offset, depth) => {
        if (depth > 64) return;
        while (offset > 0 && offset + 8 <= dv.byteLength && steps++ < 200000) {
            const cmd = dv.getUint32(offset, false);
            const next = dv.getInt32(offset + 4, false);
            switch (cmd) {
                case GEO_REFPOINT: {
                    // s16 index +8, s16 anim_mtx_id +10, f32 point[3] +12
                    const index = dv.getInt16(offset + 8, false);
                    if (!points.has(index)) {
                        points.set(index, [dv.getFloat32(offset + 12, false),
                            dv.getFloat32(offset + 16, false), dv.getFloat32(offset + 20, false)]);
                    }
                    break;
                }
                case GEO_BILLBOARD:
                case GEO_CAMERA: { const b = dv.getInt16(offset + 8, false); if (b) walk(offset + b, depth + 1); break; }
                case GEO_DRAWDIST: { const b = dv.getInt16(offset + 0x14, false); if (b) walk(offset + b, depth + 1); break; }
                case GEO_BONE: { const b = dv.getUint8(offset + 8); if (b) walk(offset + b, depth + 1); break; }
                case GEO_CALL: { const b = dv.getInt32(offset + 8, false); if (b) walk(offset + b, depth + 1); break; }
                case GEO_LOD: { const b = dv.getInt32(offset + 0x1C, false); if (b) walk(offset + b, depth + 1); break; }
                case GEO_UNKE: { const b = dv.getInt16(offset + 0x10, false); if (b) walk(offset + b, depth + 1); break; }
                case GEO_SORT: {
                    const b1 = dv.getInt16(offset + 0x22, false), b2 = dv.getInt32(offset + 0x24, false);
                    if (b1) walk(offset + b1, depth + 1);
                    if (b2) walk(offset + b2, depth + 1);
                    break;
                }
                case GEO_SELECTOR: {
                    const count = dv.getInt16(offset + 8, false);
                    for (let i = 0; i < count; i++) {
                        const b = dv.getInt32(offset + 12 + i * 4, false);
                        if (b) walk(offset + b, depth + 1);
                    }
                    break;
                }
                default:
                    break;
            }
            if (next === 0) break;
            offset += next;
        }
    };
    walk(geoListOffset, 0);
    return points;
}

// Low three bytes of a TRI word are vertex-cache slots * 2.
function pushCacheTri(out, seen, cache, word, vertexCount) {
    const a = cache[((word >>> 16) & 0xFF) >>> 1];
    const b = cache[((word >>> 8) & 0xFF) >>> 1];
    const c = cache[(word & 0xFF) >>> 1];
    pushUniqueTri(out, seen, a, b, c, vertexCount);
}

// Winding-preserving dedupe: rotate so the smallest index leads, so the same
// face in any rotation collapses but its back face stays distinct.
function pushUniqueTri(out, seen, a, b, c, vertexCount) {
    if (a < 0 || b < 0 || c < 0 || a >= vertexCount || b >= vertexCount || c >= vertexCount) return true;
    let key;
    if (a <= b && a <= c) key = a * 4294967296 + b * 65536 + c;
    else if (b <= a && b <= c) key = b * 4294967296 + c * 65536 + a;
    else key = c * 4294967296 + a * 65536 + b;
    if (seen.has(key)) return true;
    seen.add(key);
    out.push(a, b, c);
    return false;
}

////////////////////////////////////////
// Textured (visual) geometry
////////////////////////////////////////
//
// Replays the model's F3DEX display lists with enough RDP/RSP state to give
// every triangle the texture it is drawn with in-game, plus UVs and vertex
// colours, and decodes the model's texture list into RGBA textures.
//
// Texture list (BKTextureList at header +0x08): { s32 size; s16 count; u16 pad;
// BKTextureInfo[count] } followed by the texture data. modelRender_draw points
// segment 2 at that data, so every G_SETTIMG address is 0x02xxxxxx with the
// low 24 bits an offset into it. Each BKTextureInfo is { s32 offset; s16 type;
// u8 pad[2]; u8 width; u8 height; u8 pad[6] }; a CI texture's 32- or 512-byte
// RGBA16 palette sits at the offset and the pixels follow it
// (textureInfo_getTextureSize in code_63690.c).
//
// BT packs the entry into 8 bytes: { s32 offset; u8 flags; u8 type; u8 width;
// u8 height }, same type bits. flags 0x80 marks a mipmapped texture (the base
// level is followed by a 256-byte LOD chain, drawn through tile 2 like BK's).
// Only a handful of BT models embed their pixels after the entries like BK
// does; in the rest the gfx list starts right after the entries and `offset`
// is instead a texture id into the game's texture bank (asset 0x1EF6 + id).
// The game DMAs those into the segment-2 buffer in entry order, which is
// replicated here from options.textureBank (bt_textures.js); without the
// bank, or for an id it lacks, the entry is marked `missing` and its
// surfaces draw untextured.

const TEX_TYPE_CI4 = 0x01;
const TEX_TYPE_CI8 = 0x02;
const TEX_TYPE_RGBA16 = 0x04;
const TEX_TYPE_RGBA32 = 0x08;
const TEX_TYPE_IA8 = 0x10;

const TEXTURE_SEGMENT = 0x02;
// A few BT models address their textures through segments 0xC-0xF instead
// (the feather nest: one per selector branch). The offsets line up with the
// model's own texture list, so they are read as aliases of segment 2.
const BT_TEXTURE_SEGMENT_ALIASES = new Set([0x0C, 0x0D, 0x0E, 0x0F]);

// RDP commands (identical in F3DEX and F3DEX2); the RSP ones are in UCODES.
const G_SETTIMG = 0xFD;
const G_SETTILE = 0xF5;
const G_SETTILESIZE = 0xF2;
const G_LOADBLOCK = 0xF3;
const G_LOADTILE = 0xF4;
const G_SETCOMBINE = 0xFC;

// modelRender_draw points segment 3 at a table of 16-byte render-mode display
// lists (renderModes*Opa / *Xlu in core2/modelRender.c) and a model picks one
// with G_DL 0x030000n0. For an opaque model entries 0, 1, 6 and 7 are the OPA
// surface modes; every other entry alpha-blends (XLU).
//
// BT's tables (core2 data, 29 entries) follow the same idea: entries 0, 1, 6,
// 7 are opaque, 12-13 and 18-19 are their fogged copies, and the rest
// (including the decal modes 24-28 that its maps use for ground markings)
// blend -- read off each entry's cycle-2 blender (CLR_MEM * (1 - A)).
const RENDER_MODE_SEGMENT = 0x03;
// BT only: the game's "restore defaults" display list. BT model lists never
// set G_CULL_BACK themselves -- back-face culling is on when a model starts
// drawing, the few double-sided lists clear it, and every such list ends by
// calling this segment to put it back.
const BT_RESTORE_SEGMENT = 0x07;
const OPA_RENDER_MODE_ENTRIES = {
    BK: new Set([0, 1, 6, 7]),
    BT: new Set([0, 1, 6, 7, 12, 13, 18, 19]),
};

// Geometry-setup commands (include/core2/model.h). The geo list is a tree of
// these that modelRender_draw walks; it decides which display lists run, in
// what order, and carries state like TEXWRAP.
const GEO_BILLBOARD = 0x00, GEO_SORT = 0x01, GEO_BONE = 0x02, GEO_LOADDL = 0x03, GEO_SKINNING = 0x05,
      GEO_CALL = 0x06, GEO_LOADDL2 = 0x07, GEO_LOD = 0x08, GEO_REFPOINT = 0x0A, GEO_SELECTOR = 0x0C,
      GEO_DRAWDIST = 0x0D, GEO_UNKE = 0x0E, GEO_CAMERA = 0x0F, GEO_TEXWRAP = 0x10,
      // BT only: three more "draw display list" commands, all with s16 gfx_index
      // at +8 (0x11 is 16 bytes, 0x16 is 24, 0x18 is 48; the other fields are
      // unknown -- every BT display list is reachable once these are honoured)
      GEO_BT_LOADDL = 0x11, GEO_BT_LOADDL2 = 0x16, GEO_BT_LOADDL3 = 0x18;

const G_LIGHTING = 0x00020000;
const G_TEXTURE_GEN = 0x00040000;

// Colour-combiner inputs (a/b/c/d slot numbering is the same for these)
const CC_TEXEL0 = 1;
const CC_TEXEL1 = 2;
const CC_SHADE = 4;

function texturePixelBits(type) {
    if (type & TEX_TYPE_CI4) return 4;
    if (type & TEX_TYPE_CI8) return 8;
    if (type & TEX_TYPE_RGBA16) return 16;
    if (type & TEX_TYPE_RGBA32) return 32;
    if (type & TEX_TYPE_IA8) return 8;
    return 0;
}

function texturePaletteBytes(type) {
    if (type & TEX_TYPE_CI4) return 32;
    if (type & TEX_TYPE_CI8) return 512;
    return 0;
}

function rgba16(dv, offset, out, o) {
    const v = dv.getUint16(offset, false);
    const r = (v >>> 11) & 0x1F, g = (v >>> 6) & 0x1F, b = (v >>> 1) & 0x1F;
    out[o] = (r << 3) | (r >>> 2);
    out[o + 1] = (g << 3) | (g >>> 2);
    out[o + 2] = (b << 3) | (b >>> 2);
    out[o + 3] = (v & 1) ? 255 : 0;
}

/** Decode one texture entry to top-row-first RGBA8. */
function decodeTexture(dv, dataBase, info) {
    const { width: w, height: h, type } = info;
    const out = new Uint8Array(w * h * 4);
    const paletteBytes = texturePaletteBytes(type);
    const pixels = dataBase + info.offset + paletteBytes;
    const palette = dataBase + info.offset;
    const n = w * h;
    if (info.missing) {
        out.fill(255);
        return out;
    }

    if (type & TEX_TYPE_CI4) {
        for (let i = 0; i < n; i++) {
            const byte = dv.getUint8(pixels + (i >>> 1));
            const idx = (i & 1) ? (byte & 0xF) : (byte >>> 4);
            rgba16(dv, palette + idx * 2, out, i * 4);
        }
    } else if (type & TEX_TYPE_CI8) {
        for (let i = 0; i < n; i++) {
            rgba16(dv, palette + dv.getUint8(pixels + i) * 2, out, i * 4);
        }
    } else if (type & TEX_TYPE_RGBA16) {
        for (let i = 0; i < n; i++) {
            rgba16(dv, pixels + i * 2, out, i * 4);
        }
    } else if (type & TEX_TYPE_RGBA32) {
        for (let i = 0; i < n * 4; i++) {
            out[i] = dv.getUint8(pixels + i);
        }
    } else if (type & TEX_TYPE_IA8) {
        for (let i = 0; i < n; i++) {
            const v = dv.getUint8(pixels + i);
            const intensity = (v >>> 4) * 17;
            out[i * 4] = out[i * 4 + 1] = out[i * 4 + 2] = intensity;
            out[i * 4 + 3] = (v & 0xF) * 17;
        }
    } else {
        out.fill(255);
    }
    return out;
}

/**
 * @param {ArrayBuffer} buffer a decompressed BKModelBin
 * @returns {{textures: {width, height, type, rgba: Uint8Array}[],
 *            batches: {texture: number, wrapS: number, wrapT: number, cullBack: boolean, xlu: boolean,
 *                      billboard: number,
 *                      positions: number[], uvs: number[], colors: number[] (rgba per vertex)}[],
 *            billboards: {pivot: number[], yawOnly: boolean}[]} | null}
 *   texture is an index into textures or -1 for untextured; wrapS/wrapT are the
 *   tile's clamp/mirror bits (bit 1 clamp, bit 0 mirror); xlu is set for
 *   triangles drawn through an alpha-blending render mode (see G_DL below).
 *   billboard is an index into billboards, or -1 for geometry drawn in place:
 *   a batch under a BILLBOARD geo command is drawn turned to face the camera
 *   about its pivot (see GEO_BILLBOARD in the geo walk below).
 *
 * options.appendages: the model's appendage visibility table (the game's
 *   D_80383658, see selector resolution below) as { [index]: selection }.
 *   When given, SELECTORs are resolved exactly as modelRender_geoCmd_SELECTOR
 *   does and `selector` is ignored; see mapAppendageVisibility().
 * options.appendageOverrides: a partial table in the same form. Indices it
 *   names are resolved exactly; the rest fall back to the guess described
 *   below. For actors whose draw callback pins a part on or off (see
 *   BK_ACTOR_APPENDAGES in bk_setup.js).
 * options.game: "BK" (default) or "BT", see UCODES.
 * options.textureBank: for BT, the loaded bank (bt_textures.js getBTTextureBank()).
 */
export function parseBKModelTextured(buffer, selector = 0, options = {}) {
    const appendages = options.appendages ?? null;
    const appendageOverrides = options.appendageOverrides ?? null;
    const game = options.game === "BT" ? "BT" : "BK";
    const ucode = UCODES[game];
    const opaRenderModes = OPA_RENDER_MODE_ENTRIES[game];
    const G_CULL_BACK = ucode.cullBack;
    const dv = new DataView(buffer);
    if (dv.byteLength < 0x38 || dv.getUint32(0, false) !== MODEL_MAGIC) return null;

    const textureListOffset = dv.getInt16(0x08, false);
    const gfxListOffset = dv.getInt32(0x0C, false);
    const vtxListOffset = dv.getInt32(0x10, false);
    if (!gfxListOffset || !vtxListOffset) return null;

    // ---- textures
    const textures = [];
    if (textureListOffset) {
        const count = dv.getInt16(textureListOffset + 4, false);
        const entrySize = ucode.textureEntrySize;
        let dataBase = textureListOffset + 8 + count * entrySize;
        let texDv = dv;
        for (let i = 0; i < count; i++) {
            const o = textureListOffset + 8 + i * entrySize;
            const info = entrySize === 16 ? {
                offset: dv.getInt32(o, false),
                type: dv.getInt16(o + 4, false),
                width: dv.getUint8(o + 8),
                height: dv.getUint8(o + 9),
            } : {
                offset: dv.getInt32(o, false),
                flags: dv.getUint8(o + 4),
                type: dv.getUint8(o + 5),
                width: dv.getUint8(o + 6),
                height: dv.getUint8(o + 7),
            };
            info.size = texturePaletteBytes(info.type) + (texturePixelBits(info.type) * info.width * info.height) / 8;
            textures.push(info);
        }
        if (entrySize === 8 && gfxListOffset <= dataBase) {
            // Bank ids: assemble the segment-2 buffer the game would build.
            const bank = options.textureBank ?? null;
            const blobs = textures.map(t => bank ? bank.get(t.offset) : null);
            const total = blobs.reduce((n, b) => n + (b ? b.length : 0), 0);
            const seg = new Uint8Array(total);
            let off = 0;
            for (let i = 0; i < textures.length; i++) {
                const t = textures[i], b = blobs[i];
                t.id = t.offset;
                t.offset = off;
                if (b) { seg.set(b, off); off += b.length; }
                else t.missing = true;
            }
            texDv = new DataView(seg.buffer);
            dataBase = 0;
        }
        for (const info of textures) {
            info.missing = info.missing || dataBase + info.offset + info.size > texDv.byteLength;
            info.rgba = decodeTexture(texDv, dataBase, info);
        }
    }
    const textureAt = (addr) => {
        const segment = addr >>> 24;
        if (segment !== TEXTURE_SEGMENT && !(game === "BT" && BT_TEXTURE_SEGMENT_ALIASES.has(segment))) return -1;
        const off = addr & 0xFFFFFF;
        return textures.findIndex(t => !t.missing && off >= t.offset && off < t.offset + t.size);
    };

    // ---- vertices
    const vertexCount = vertexListCount(dv, vtxListOffset, game);
    const vtxBase = vtxListOffset + 0x18;

    // ---- display list replay
    //
    // The RDP has 8 tile descriptors. A texture is loaded into TMEM through
    // one tile (usually 7) and drawn through another; gSPTexture picks which
    // tile renders (BK uses tile 0 for plain surfaces and tile 2 with LOD for
    // mipmapped ones). So loads are remembered by TMEM address and resolved
    // through the render tile's descriptor at draw time -- taking the last
    // load would pick the smallest mip level and a stale tile's wrap modes.
    const cache = new Int32Array(VTX_CACHE_SIZE).fill(-1);
    const defaultGeometryMode = game === "BT" ? G_CULL_BACK : 0;
    let geometryMode = defaultGeometryMode;
    let renderXlu = false; // current segment-3 render mode blends alpha
    let texOn = false, texScaleS = 1, texScaleT = 1, renderTile = 0;
    let timgAddr = 0;
    let combinerUsesTexel = true;
    let combinerUsesShade = true;
    const tiles = Array.from({ length: 8 }, () => ({
        tmem: 0, cms: 0, cmt: 0, masks: 0, maskt: 0, shifts: 0, shiftt: 0, uls: 0, ult: 0, lrs: 0, lrt: 0,
    }));
    // Mipmapped surfaces render through tile 2 (gSPTexture level 2, tile 2)
    // but never configure it themselves: modelRender_draw emits mipMapWrapDL
    // first, which sets tiles 2-6 to the 32x32 base level at TMEM 0 and its
    // LODs, all wrapping. Seed the same so those surfaces resolve. (Two maps
    // flip a subtree to the clamp variant via the TEXWRAP geo command; that
    // is not replicated.)
    [[2, 0x000, 5, 0, 32], [3, 0x100, 4, 1, 16], [4, 0x104, 3, 2, 8], [5, 0x106, 2, 3, 4], [6, 0x107, 1, 4, 2]]
        .forEach(([t, tmem, mask, shift, size]) => {
            Object.assign(tiles[t], { tmem, cms: 0, cmt: 0, masks: mask, maskt: mask, shifts: shift, shiftt: shift,
                uls: 0, ult: 0, lrs: size - 1, lrt: size - 1 });
        });
    const tmemTextures = new Map(); // tmem address -> texture index

    // Effective wrap per axis. The hardware clamps to the tile's declared size
    // and then applies the mask, so a "clamped" tile declared wider than the
    // texture still repeats inside it; a mask of 0 never wraps.
    const wrapFor = (clampMirror, mask, tileSize, texSize) => {
        if (mask === 0) return 2;                              // clamp
        if ((clampMirror & 2) && tileSize <= texSize) return 2; // clamp
        return clampMirror & 1;                                // mirror or repeat
    };

    // The BILLBOARD geo command the walk is currently inside (index into
    // billboards), -1 outside any.
    const billboards = [];
    let billboard = -1;

    const batches = new Map();
    const batchFor = () => {
        const rt = tiles[renderTile];
        const texIndex = tmemTextures.get(rt.tmem);
        const tex = (texOn && combinerUsesTexel && texIndex !== undefined) ? texIndex : -1;
        let wrapS = 0, wrapT = 0;
        if (tex >= 0) {
            wrapS = wrapFor(rt.cms, rt.masks, rt.lrs - rt.uls + 1, textures[tex].width);
            wrapT = wrapFor(rt.cmt, rt.maskt, rt.lrt - rt.ult + 1, textures[tex].height);
        }
        const cullBack = (geometryMode & G_CULL_BACK) !== 0;
        const key = tex + ':' + wrapS + ':' + wrapT + ':' + (cullBack ? 1 : 0) + ':' + (renderXlu ? 1 : 0) + ':' + billboard;
        let b = batches.get(key);
        if (!b) {
            b = { texture: tex, wrapS, wrapT, cullBack, xlu: renderXlu, billboard, positions: [], uvs: [], colors: [] };
            batches.set(key, b);
        }
        return b;
    };

    const shiftCoord = (v, shift) => (shift === 0 ? v : (shift <= 10 ? v / (1 << shift) : v * (1 << (16 - shift))));

    const emit = (a, b, c) => {
        if (a < 0 || b < 0 || c < 0) return;
        const batch = batchFor();
        const tex = batch.texture >= 0 ? textures[batch.texture] : null;
        const lit = (geometryMode & G_LIGHTING) !== 0;
        // Environment mapping: with G_TEXTURE_GEN the RSP derives s/t from the
        // eye-space normal instead of Vtx.tc (shiny honeycombs, jiggies, eggs).
        // That is view-dependent; a static sphere-map lookup on the model-space
        // normal gives the right look.
        const texGen = lit && (geometryMode & G_TEXTURE_GEN) !== 0;
        for (const idx of [a, b, c]) {
            const o = vtxBase + idx * VTX_SIZE;
            batch.positions.push(dv.getInt16(o, false), dv.getInt16(o + 2, false), dv.getInt16(o + 4, false));

            const nx = dv.getInt8(o + 12) / 127, ny = dv.getInt8(o + 13) / 127, nz = dv.getInt8(o + 14) / 127;

            if (texGen) {
                batch.uvs.push(0.5 + nx * 0.5, 0.5 - ny * 0.5);
            } else {
                // Vtx.tc is s10.5 texels, scaled by G_TEXTURE's 0.16 factors, then
                // the tile's shift, relative to the tile's upper-left corner.
                const rt = tiles[renderTile];
                let s = (dv.getInt16(o + 8, false) / 32) * texScaleS;
                let t = (dv.getInt16(o + 10, false) / 32) * texScaleT;
                s = shiftCoord(s, rt.shifts) - rt.uls;
                t = shiftCoord(t, rt.shiftt) - rt.ult;
                batch.uvs.push(tex ? s / tex.width : 0, tex ? t / tex.height : 0);
            }

            // The 4th byte is the vertex alpha in both the coloured and the
            // lit (normal) vertex layouts; XLU models use it for translucency.
            const alpha = dv.getUint8(o + 15) / 255;
            if (!combinerUsesShade) {
                // Combiner ignores the shade colour (e.g. plain TEXEL0 output).
                batch.colors.push(1, 1, 1, alpha);
            } else if (lit) {
                // The colour bytes are a normal; approximate the game's single
                // directional light with a fixed key light plus ambient.
                const d = Math.max(0, nx * 0.30 + ny * 0.86 + nz * 0.41);
                const i = 0.45 + 0.55 * d;
                batch.colors.push(i, i, i, alpha);
            } else {
                batch.colors.push(dv.getUint8(o + 12) / 255, dv.getUint8(o + 13) / 255, dv.getUint8(o + 14) / 255, alpha);
            }
        }
    };

    // ---- display list execution
    const gfxBase = gfxListOffset + 8;
    const cmdCount = dv.getUint32(gfxListOffset, false);
    const gfxEnd = gfxBase + cmdCount * 8;

    // Run one display list from a byte offset until G_ENDDL (or, in linear
    // mode, until the end of the whole list -- ENDDL just separates lists).
    // RDP/RSP state persists across calls exactly as it does on hardware.
    const runDisplayList = (startOffset, linear) => {
        for (let o = startOffset; o + 8 <= gfxEnd; o += 8) {
            const w0 = dv.getUint32(o, false);
            const w1 = dv.getUint32(o + 4, false);
            const op = ucode.ops[w0 >>> 24] ?? (w0 >>> 24);
            if (op === 'ENDDL') {
                if (linear) continue;
                return;
            }
            switch (op) {
                case 'VTX': {
                    const { v0, n } = ucode.vtx(w0);
                    if ((w1 >>> 24) !== VERTEX_SEGMENT) break;
                    const first = (w1 & 0xFFFFFF) / VTX_SIZE;
                    for (let k = 0; k < n && v0 + k < VTX_CACHE_SIZE; k++) {
                        if (v0 + k < 0) continue;
                        const idx = first + k;
                        cache[v0 + k] = idx < vertexCount ? idx : -1;
                    }
                    break;
                }
                case 'TRI1': {
                    const w = ucode.tri1(w0, w1);
                    emit(cache[((w >>> 16) & 0xFF) >>> 1], cache[((w >>> 8) & 0xFF) >>> 1], cache[(w & 0xFF) >>> 1]);
                    break;
                }
                case 'TRI2':
                    emit(cache[((w0 >>> 16) & 0xFF) >>> 1], cache[((w0 >>> 8) & 0xFF) >>> 1], cache[(w0 & 0xFF) >>> 1]);
                    emit(cache[((w1 >>> 16) & 0xFF) >>> 1], cache[((w1 >>> 8) & 0xFF) >>> 1], cache[(w1 & 0xFF) >>> 1]);
                    break;
                case 'QUAD': {
                    const a = cache[((w1 >>> 24) & 0xFF) >>> 1], b = cache[((w1 >>> 16) & 0xFF) >>> 1];
                    const c = cache[((w1 >>> 8) & 0xFF) >>> 1], d = cache[(w1 & 0xFF) >>> 1];
                    emit(a, b, c);
                    emit(a, c, d);
                    break;
                }
                case 'CLEARGEOMETRYMODE': geometryMode &= ~w1; break;
                case 'SETGEOMETRYMODE': geometryMode |= w1; break;
                case 'GEOMETRYMODE':
                    // F3DEX2: w0[23:0] is the inverted clear mask, w1 the set bits
                    geometryMode = (geometryMode & (w0 & 0xFFFFFF)) | w1;
                    break;
                case 'DL':
                    // Only the render-mode table calls matter here; calls into
                    // the model's own lists are reached through the geo tree.
                    if ((w1 >>> 24) === RENDER_MODE_SEGMENT) {
                        renderXlu = !opaRenderModes.has(((w1 & 0xFFFFFF) >>> 4));
                    } else if (game === "BT" && (w1 >>> 24) === BT_RESTORE_SEGMENT) {
                        geometryMode |= defaultGeometryMode;
                    }
                    break;
                case 'TEXTURE': {
                    // w1: scaleS:16 scaleT:16 (0.16 fixed); w0 layout per microcode (UCODES)
                    const t = ucode.texture(w0);
                    texOn = t.on;
                    renderTile = t.tile;
                    texScaleS = (w1 >>> 16) / 65536;
                    texScaleT = (w1 & 0xFFFF) / 65536;
                    break;
                }
                case G_SETTIMG: timgAddr = w1; break;
                case G_LOADBLOCK:
                case G_LOADTILE: {
                    // The load goes through the tile named in w1; whatever TMEM
                    // address that tile points at now holds this texture.
                    const loadTile = tiles[(w1 >>> 24) & 7];
                    tmemTextures.set(loadTile.tmem, textureAt(timgAddr));
                    break;
                }
                case G_SETTILE: {
                    // w0: | op | fmt:3 siz:2 | 0 | line:9 | tmem:9 |
                    // w1: | tile:3 | palette:4 | cmt:2 maskt:4 shiftt:4 | cms:2 masks:4 shifts:4 |
                    const tile = tiles[(w1 >>> 24) & 7];
                    tile.tmem = w0 & 0x1FF;
                    tile.cmt = (w1 >>> 18) & 3;
                    tile.maskt = (w1 >>> 14) & 0xF;
                    tile.shiftt = (w1 >>> 10) & 0xF;
                    tile.cms = (w1 >>> 8) & 3;
                    tile.masks = (w1 >>> 4) & 0xF;
                    tile.shifts = w1 & 0xF;
                    break;
                }
                case G_SETTILESIZE: {
                    // w0: | op | uls:12 ult:12 |   w1: | tile:3 | lrs:12 lrt:12 |  (10.2 fixed)
                    const tile = tiles[(w1 >>> 24) & 7];
                    tile.uls = ((w0 >>> 12) & 0xFFF) / 4;
                    tile.ult = (w0 & 0xFFF) / 4;
                    tile.lrs = ((w1 >>> 12) & 0xFFF) / 4;
                    tile.lrt = (w1 & 0xFFF) / 4;
                    break;
                }
                case G_SETCOMBINE: {
                    // Colour = (a - b) * c + d, two cycles. BK's usual combiner is
                    // cycle 1: (TEXEL0 - PRIM) * ENV + PRIM, cycle 2: COMBINED * SHADE,
                    // so the shade (vertex colour / lighting) only shows up in cycle 2.
                    //   cycle 1: a = w0[23:20]  c = w0[19:15]  b = w1[31:28]  d = w1[17:15]
                    //   cycle 2: a = w0[8:5]    c = w0[4:0]    b = w1[27:24]  d = w1[8:6]
                    const inputs = [
                        (w0 >>> 20) & 0xF, (w0 >>> 15) & 0x1F, (w1 >>> 28) & 0xF, (w1 >>> 15) & 7,
                        (w0 >>> 5) & 0xF, w0 & 0x1F, (w1 >>> 24) & 0xF, (w1 >>> 6) & 7,
                    ];
                    combinerUsesTexel = inputs.some(v => v === CC_TEXEL0 || v === CC_TEXEL1);
                    combinerUsesShade = inputs.some(v => v === CC_SHADE);
                    break;
                }
                default:
                    break;
            }
        }
    };

    // ---- geometry-setup tree
    //
    // Branch offsets are relative to the command they appear in; a list ends
    // when next_offset is 0. Choices the game makes at runtime are resolved
    // statically here: nearest LOD, every SORT / CAMERA / DRAWDIST branch (they
    // only cull), and SELECTORs as described at that case below.
    const mipTile2 = (clamp) => Object.assign(tiles[2], clamp
        ? { cms: 0, cmt: 0, masks: 0, maskt: 0 }
        : { cms: 0, cmt: 0, masks: 5, maskt: 5 });
    const runDl = (gfxIndex) => {
        if (gfxIndex >= 0 && gfxIndex < cmdCount) runDisplayList(gfxBase + gfxIndex * 8, false);
    };
    // ---- selector resolution
    //
    // A SELECTOR reads selection = D_80383658[index], a table the drawing code
    // fills through modelRender_setAppendageVisibility: 0 draws nothing, n > 0
    // draws branch n-1 (if the node has that many), n < 0 is a bitmask of
    // branches (modelRender_geoCmd_SELECTOR). A caller that knows the table
    // (map models: mapAppendageVisibility) passes it as options.appendages and
    // gets exactly that.
    //
    // Without it (props) the table is guessed. For per-instance variants (level
    // entry signs, SNS eggs, world exit pads) the actor sets appendage
    // `actorTypeSpecificField` on, and that value is NodeProp.selector_or_radius
    // from the setup file -- passed in here as `selector`. For state-driven
    // ones (pressed / unpressed, flag colours) there is no static answer, so a
    // model whose geometry is entirely selector-gated shows its lowest index.
    const singleIndices = new Set();
    let hasUnconditional = false;
    let scanSteps = 0;
    const scanGeo = (offset, depth, inSelector) => {
        if (depth > 64) return;
        while (offset > 0 && offset + 8 <= dv.byteLength && scanSteps++ < 200000) {
            const cmd = dv.getUint32(offset, false);
            const next = dv.getInt32(offset + 4, false);
            if (cmd === GEO_SELECTOR) {
                const count = dv.getInt16(offset + 8, false);
                if (count === 1) singleIndices.add(dv.getInt16(offset + 10, false));
            } else if (cmd === GEO_LOADDL || cmd === GEO_LOADDL2 || cmd === GEO_SKINNING) {
                if (!inSelector) hasUnconditional = true;
            } else {
                let b = 0;
                if (cmd === GEO_BILLBOARD || cmd === GEO_CAMERA) b = dv.getInt16(offset + 8, false);
                else if (cmd === GEO_DRAWDIST) b = dv.getInt16(offset + 0x14, false);
                else if (cmd === GEO_BONE) b = dv.getUint8(offset + 8);
                else if (cmd === GEO_CALL) b = dv.getInt32(offset + 8, false);
                else if (cmd === GEO_LOD) b = dv.getInt32(offset + 0x1C, false);
                else if (cmd === GEO_UNKE) b = dv.getInt16(offset + 0x10, false);
                else if (cmd === GEO_BT_LOADDL || cmd === GEO_BT_LOADDL2 || cmd === GEO_BT_LOADDL3) { if (!inSelector) hasUnconditional = true; }
                else if (cmd === GEO_SORT) {
                    const b1 = dv.getInt16(offset + 0x22, false), b2 = dv.getInt32(offset + 0x24, false);
                    if (b1) scanGeo(offset + b1, depth + 1, inSelector);
                    if (b2) scanGeo(offset + b2, depth + 1, inSelector);
                }
                if (b) scanGeo(offset + b, depth + 1, inSelector);
            }
            if (next === 0) break;
            offset += next;
        }
    };
    const geoListOffsetForScan = dv.getInt32(0x04, false);
    if (geoListOffsetForScan && !appendages) scanGeo(geoListOffsetForScan, 0, false);
    let activeSingleIndex = -1;
    if (singleIndices.has(selector)) activeSingleIndex = selector;
    else if (!hasUnconditional && singleIndices.size) activeSingleIndex = Math.min(...singleIndices);

    // modelRender_geoCmd_SELECTOR for one known table entry.
    const branchesForSelection = (count, selection) => {
        if (selection > 0) return selection <= count ? [selection - 1] : [];
        const chosen = [];
        for (let i = 0; i < count; i++) if ((-selection >> i) & 1) chosen.push(i);
        return chosen;
    };

    // Branch choices for one SELECTOR node, per the resolution above.
    const selectorBranches = (count, index) => {
        if (appendages) return index === 0 ? [] : branchesForSelection(count, appendages[index] ?? 0);
        if (appendageOverrides && index in appendageOverrides) {
            return branchesForSelection(count, appendageOverrides[index]);
        }
        // BT models gate their ordinary body parts behind single-branch
        // selectors (a character's whole torso can sit under one), so there a
        // lone branch is on by default; BK's are opt-in parts (see above).
        if (count === 1) return (game === "BT" || index === activeSingleIndex) ? [0] : [];
        if (count > 1) return [(selector >= 1 && selector <= count) ? selector - 1 : 0];
        return [];
    };

    let geoSteps = 0;
    const walkGeo = (offset, depth) => {
        if (depth > 64) return;
        while (offset > 0 && offset + 8 <= dv.byteLength && geoSteps++ < 200000) {
            const cmd = dv.getUint32(offset, false);
            const next = dv.getInt32(offset + 4, false);
            const branch16 = () => dv.getInt16(offset + 8, false);
            switch (cmd) {
                case GEO_BILLBOARD: {
                    // s16 branch_offset +8, s16 yaw_only +10, f32 pivot[3] +12.
                    // modelRender_geoCmd_Unk0 draws the branch with a fresh
                    // matrix: translate to the pivot, turn by the camera's yaw
                    // (and its pitch too unless yaw_only), scale, translate
                    // back -- so the branch faces the camera about the pivot
                    // and ignores the model's own rotation. Egg nests, sparkles,
                    // Napper's Zs. Recorded on the batches for the renderer.
                    const b = branch16();
                    if (b) {
                        const saved = billboard;
                        billboard = billboards.push({
                            pivot: [dv.getFloat32(offset + 12, false), dv.getFloat32(offset + 16, false),
                                dv.getFloat32(offset + 20, false)],
                            yawOnly: dv.getInt16(offset + 10, false) !== 0,
                        }) - 1;
                        walkGeo(offset + b, depth + 1);
                        billboard = saved;
                    }
                    break;
                }
                case GEO_CAMERA: {
                    // s16 branch_offset at +8
                    const b = branch16();
                    if (b) walkGeo(offset + b, depth + 1);
                    break;
                }
                case GEO_DRAWDIST: {
                    // s16 min[3] +8, s16 max[3] +0xE, s16 branch_offset +0x14
                    const b = dv.getInt16(offset + 0x14, false);
                    if (b) walkGeo(offset + b, depth + 1);
                    break;
                }
                case GEO_SORT: {
                    // s16 flags +0x20, s16 branch_offset_1 +0x22, s32 branch_offset_2 +0x24
                    const b1 = dv.getInt16(offset + 0x22, false);
                    const b2 = dv.getInt32(offset + 0x24, false);
                    if (b1) walkGeo(offset + b1, depth + 1);
                    if (b2) walkGeo(offset + b2, depth + 1);
                    break;
                }
                case GEO_BONE: {
                    // u8 branch_offset at +8
                    const b = dv.getUint8(offset + 8);
                    if (b) walkGeo(offset + b, depth + 1);
                    break;
                }
                case GEO_LOADDL:
                    runDl(dv.getInt16(offset + 8, false));
                    break;
                case GEO_LOADDL2:
                    runDl(dv.getInt16(offset + 10, false));
                    break;
                case GEO_SKINNING: {
                    // s16 gfx_index[]: first always, then until a 0 entry
                    runDl(dv.getInt16(offset + 8, false));
                    for (let i = 1; offset + 8 + i * 2 + 2 <= dv.byteLength; i++) {
                        const idx = dv.getInt16(offset + 8 + i * 2, false);
                        if (idx === 0) break;
                        runDl(idx);
                    }
                    break;
                }
                case GEO_CALL: {
                    const b = dv.getInt32(offset + 8, false);
                    if (b) walkGeo(offset + b, depth + 1);
                    break;
                }
                case GEO_LOD: {
                    // f32 max +8, f32 min +12, f32 position[3], s32 branch_offset +0x1C
                    const min = dv.getFloat32(offset + 12, false);
                    const b = dv.getInt32(offset + 0x1C, false);
                    if (b && min <= 0) walkGeo(offset + b, depth + 1);
                    break;
                }
                case GEO_SELECTOR: {
                    // s16 branch_offset_count +8, s16 index +10, s32 branch_offsets[] +12
                    // With a guessed table, one branch is an on/off part, on
                    // only if it is the resolved variant (see selector
                    // resolution above), and several are a choice between
                    // states -- the instance's selector value if it names one,
                    // else the first.
                    const count = dv.getInt16(offset + 8, false);
                    const index = dv.getInt16(offset + 10, false);
                    for (const choice of selectorBranches(count, index)) {
                        const b = dv.getInt32(offset + 12 + choice * 4, false);
                        if (b) walkGeo(offset + b, depth + 1);
                    }
                    break;
                }
                case GEO_UNKE: {
                    // s16 position[3] +8, s16 distance +0xE, s16 branch_offset +0x10
                    const b = dv.getInt16(offset + 0x10, false);
                    if (b) walkGeo(offset + b, depth + 1);
                    break;
                }
                case GEO_TEXWRAP:
                    // s32 mode at +8: 1 = mipMapClampDL, 2 = mipMapWrapDL (modelRender_geoCmd_TEXWRAP)
                    mipTile2(dv.getInt32(offset + 8, false) === 1);
                    break;
                case GEO_BT_LOADDL:
                case GEO_BT_LOADDL2:
                case GEO_BT_LOADDL3:
                    runDl(dv.getInt16(offset + 8, false));
                    break;
                default:
                    break;
            }
            if (next === 0) break;
            offset += next;
        }
    };

    const geoListOffset = dv.getInt32(0x04, false);
    if (geoListOffset) {
        walkGeo(geoListOffset, 0);
    } else {
        runDisplayList(gfxBase, true);
    }

    return { textures, batches: [...batches.values()], billboards };
}

////////////////////////////////////////
// Map model appendage visibility
////////////////////////////////////////
//
// What mapModel_opa_draw / mapModel_xlu_draw (core2/mapModel.c) put in the
// appendage table before drawing a map model. modelRender_reset leaves 1 on
// and 2 off after every draw and props zero the rest, so that is the base
// state; the per-map cases override it. Runtime conditions are resolved to
// whichever state's geometry the collision list contains, so the textured
// view covers the collision view: Grunty's door open (GL_DINGPOT 6), the
// cellar's barrel top broken (MMM_CELLAR 1 -- the X_BARREL_TOP actor also
// stands there until then), GV's water pyramid jiggy collected (5 on, 2 off).
// Branches with no collision behind them stay off: GV's raised pyramid
// (flag 6), Sandybutt's first-person roof, SM's alternate ground patch
// (cutscene flag), and the closed-door Dingpot cutscenes keep 4-6 off.

const SM_OPA_MAP_IDS = [0x01, 0x7D, 0x7E, 0x85, 0x86, 0x88, 0x94]; // maps drawn with ASSET_14CF
const MUMBOS_SKULL_MAP_IDS = [0x0E, 0x47, 0x48, 0x30, 0x4A, 0x4B, 0x4C, 0x4D]; // variant n+1

const MAP_OPA_APPENDAGES = new Map([
    ...SM_OPA_MAP_IDS.map(id => [id, { 1: 0, 2: 1 }]),
    ...MUMBOS_SKULL_MAP_IDS.map((id, i) => [id, { 1: i + 1, 5: i + 1 }]),
    [0x12, { 1: 0, 2: 0, 5: 1 }],                       // GV_GOBIS_VALLEY
    [0x14, { 5: 0 }],                                   // GV_SANDYBUTTS_MAZE
    [0x5E, { 1: 1, 2: 0 }], [0x5F, { 1: 1, 2: 0 }], [0x60, { 1: 1, 2: 0 }], // CCW_*_NABNUTS_HOUSE
    [0x61, { 1: 0, 2: 1 }],                             // CCW_WINTER_NABNUTS_HOUSE
    [0x1D, { 1: 1 }],                                   // MMM_CELLAR
    [0x7C, { 5: 1 }], [0x89, { 5: 1 }], [0x8A, { 5: 1 }], [0x8C, { 5: 1 }], [0x91, { 5: 1 }], // Banjo's house, file select
    [0x7B, { 4: 0, 5: 0, 6: 0 }], [0x81, { 4: 0, 5: 0, 6: 0 }], // CS_INTRO_GL_DINGPOT_*
    [0x82, { 4: 1, 5: 1, 6: 1 }], [0x83, { 4: 1, 5: 1, 6: 1 }], [0x84, { 4: 1, 5: 1, 6: 1 }], // CS_*_MACHINE_ROOM
    [0x93, { 4: 1, 5: 1, 6: 1 }],                       // GL_DINGPOT
]);

const MAP_XLU_APPENDAGES = new Map([
    [0x1D, { 1: 1 }],                                   // MMM_CELLAR
]);

/**
 * Appendage table for a map's opaque or translucent model, for
 * parseBKModelTextured's options.appendages.
 * @param {number} mapId the map enum value (BK_Maps sceneID)
 * @param {boolean} xlu the map's XLU model rather than its OPA one
 */
export function mapAppendageVisibility(mapId, xlu) {
    const overrides = (xlu ? MAP_XLU_APPENDAGES : MAP_OPA_APPENDAGES).get(mapId);
    return { 1: 1, 2: 0, ...overrides };
}
