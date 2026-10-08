import * as THREE from 'three';

////////////////////////////////////////
// System: Donkey Kong 64 maps
////////////////////////////////////////
//
// Reads the files tools/dk64/extract_dk64_maps.py writes to models/DK64/<dir>/:
//
//   floors.bin / walls.bin  The collision. u32 total triangle count, then one
//                           block per collision grid cell: u32 end offset and
//                           0x18-byte triangles up to it. A triangle is stored
//                           in every cell it touches, so copies are dropped.
//                             floor: s16 x[3], y[3], z[3] (world * 6), u16 x3
//                             wall:  s16 (x, y, z)[3]     (world),     u16 x3
//                           (the * 6 is global_asm's func_80666D88 /
//                           func_80666F04 dividing floor heights by 6.)
//   geometry.bin            The visible map: header +0x34..+0x38 F3DEX2
//                           display lists (segment 7), +0x38..+0x40 Vtx[]
//                           (segment 6), in `scale` units per world unit
//                           (DK64_Maps). G_SETTIMG addresses in segment 0 are
//                           pointer table 25 ids (global_asm func_8062F3A0),
//                           extracted to models/DK64/textures/<ID>.bin.

const FLOOR_SCALE = 6;
const TRI_SIZE = 0x18;

/**
 * Collision triangles of a floors.bin / walls.bin in world units, one copy
 * each: { verts: [[x, y, z]], tris: [[a, b, c]], info: [{ flags }] }.
 */
export function parseDK64Collision(buffer, isFloor) {
    const dv = new DataView(buffer);
    const verts = [], tris = [], info = [];
    const vertIndex = new Map();
    const seen = new Set();
    const vertex = (x, y, z) => {
        const key = x + ',' + y + ',' + z;
        let i = vertIndex.get(key);
        if (i === undefined) {
            i = verts.length;
            verts.push(isFloor ? [x / FLOOR_SCALE, y / FLOOR_SCALE, z / FLOOR_SCALE] : [x, y, z]);
            vertIndex.set(key, i);
        }
        return i;
    };
    let pos = 4;
    while (pos + 4 <= dv.byteLength) {
        const end = dv.getUint32(pos, false);
        if (end <= pos || end > dv.byteLength) break;
        for (let o = pos + 4; o + TRI_SIZE <= end; o += TRI_SIZE) {
            const s = [];
            for (let k = 0; k < 9; k++) s.push(dv.getInt16(o + 2 * k, false));
            const tail = [dv.getUint16(o + 0x12, false), dv.getUint16(o + 0x14, false), dv.getUint16(o + 0x16, false)];
            const key = s.join(',') + ',' + tail.join(',');
            if (seen.has(key)) continue;
            seen.add(key);
            const idx = isFloor
                ? [0, 1, 2].map(i => vertex(s[i], s[3 + i], s[6 + i]))
                : [0, 1, 2].map(i => vertex(s[3 * i], s[3 * i + 1], s[3 * i + 2]));
            tris.push(idx);
            info.push({ fields: tail });
        }
        pos = end;
    }
    return { verts, tris, info };
}

// --- display lists -------------------------------------------------------

const G_VTX = 0x01, G_TRI1 = 0x05, G_TRI2 = 0x06, G_QUAD = 0x07;
const G_TEXTURE = 0xD7, G_GEOMETRYMODE = 0xD9, G_SETOTHERMODE_L = 0xE2;
const G_LOADTLUT = 0xF0, G_SETTILESIZE = 0xF2, G_LOADBLOCK = 0xF3, G_LOADTILE = 0xF4;
const G_SETTILE = 0xF5, G_SETCOMBINE = 0xFC, G_SETTIMG = 0xFD;

const G_CULL_FRONT = 0x200, G_CULL_BACK = 0x400, G_LIGHTING = 0x20000;
const RM_Z_UPD = 0x20, RM_FORCE_BL = 0x4000, RM_ZMODE_DEC = 0xC00;

const FMT_RGBA = 0, FMT_YUV = 1, FMT_CI = 2, FMT_IA = 3, FMT_I = 4;

// Texture ids are pointer table 25 ids, or table 7 ids with this bit set
// (models/DK64/textures/T7_<ID>.bin).
const TABLE7_TEXTURE = 0x70000;

function emptyTile() {
    return { fmt: 0, siz: 0, line: 0, tmem: 0, palette: 0, cms: 0, cmt: 0, masks: 0, maskt: 0, shifts: 0, shiftt: 0, uls: 0, ult: 0, lrs: 0, lrt: 0 };
}

function shiftScale(shift) {
    if (shift === 0) return 1;
    return shift <= 10 ? 1 / (1 << shift) : (1 << (16 - shift));
}

const CHUNK_SIZE = 0x34;

/**
 * The map's chunks (header +0x68, count at the start of the +0x64 table): each
 * draws up to four display lists, words 3..10 as (offset, size) pairs from
 * the display list base (-1 = none), and its G_VTX addresses are relative to
 * its own vertex range, words 11..12, in the vertex block.
 */
export function parseDK64Chunks(dv) {
    const count = dv.getUint32(dv.getUint32(0x64, false), false);
    const table = dv.getUint32(0x68, false);
    const chunks = [];
    for (let i = 0; i < count && table + (i + 1) * CHUNK_SIZE <= dv.byteLength; i++) {
        const c = table + i * CHUNK_SIZE;
        const dls = [];
        for (let k = 0; k < 4; k++) {
            const offset = dv.getInt32(c + 0x0C + 8 * k, false);
            const size = dv.getUint32(c + 0x10 + 8 * k, false);
            if (offset >= 0 && size > 0) dls.push([offset, size]);
        }
        chunks.push({ dls, vtxOffset: dv.getUint32(c + 0x2C, false), vtxSize: dv.getUint32(c + 0x30, false) });
    }
    return chunks;
}

// Each G_ENDDL-terminated list in [offset, offset + size) of the display list
// block: { start, end, extent }, extent being the end of the vertex range its
// own G_VTX commands address.
function listsIn(dv, dlStart, offset, size) {
    const lists = [];
    let start = dlStart + offset, extent = 0;
    const end = Math.min(dlStart + offset + size, dv.byteLength);
    for (let o = start; o + 8 <= end; o += 8) {
        const op = dv.getUint8(o);
        if (op === G_VTX) {
            const w0 = dv.getUint32(o, false), w1 = dv.getUint32(o + 4, false);
            extent = Math.max(extent, (w1 & 0xFFFFFF) + 16 * ((w0 >>> 12) & 0xFF));
        } else if (op === 0xDF) {
            lists.push({ start, end: o + 8, extent });
            start = o + 8;
            extent = 0;
        }
    }
    if (start < end) lists.push({ start, end, extent });
    return lists;
}

/**
 * Where each chunk display list's vertices are: [start, end, vertex base,
 * chunk index], sorted. Segment 6 is the whole vertex block while the map
 * draws (global_asm func_8062C29C), so the chunks' G_VTX addresses resolve
 * against the chunk's vertex range in one of two ways, checked against all
 * 797 chunks of the US maps:
 *  - every list's addresses start again from 0, and the lists take their
 *    vertices from the chunk's range one after another, in order (their
 *    extents add up to the chunk's vertex size), or
 *  - the lists address the chunk's range directly (chunks whose first list is
 *    a table of G_DL calls into the others).
 * Lists outside every chunk address the vertex block directly.
 */
export function dk64ListRanges(dv) {
    const dlStart = dv.getUint32(0x34, false);
    const vtxStart = dv.getUint32(0x38, false);
    const ranges = [];
    parseDK64Chunks(dv).forEach((chunk, index) => {
        const lists = chunk.dls.flatMap(([offset, size]) => listsIn(dv, dlStart, offset, size));
        const sequential = lists.reduce((sum, l) => sum + l.extent, 0) === chunk.vtxSize;
        let next = 0;
        for (const list of lists) {
            ranges.push([list.start, list.end, vtxStart + chunk.vtxOffset + (sequential ? next : 0), index]);
            next += list.extent;
        }
    });
    return ranges.sort((a, b) => a[0] - b[0]);
}

const ANIMATED_TEXTURE_SIZE = 0x7C;

/**
 * The animated textures (header +0x48: u32 count, then 0x7C-byte entries of
 * u8 segment, u8 chunk, u8 frame delay, u8 frame count, ..., u32 table 7
 * frame ids from +0xC; global_asm func_8062EDA8 / func_8062EE48).
 */
export function parseDK64AnimatedTextures(dv) {
    const table = dv.getUint32(0x48, false);
    const out = [];
    const count = dv.getUint32(table, false);
    for (let i = 0; i < count; i++) {
        const e = table + 4 + i * ANIMATED_TEXTURE_SIZE;
        const frames = [];
        for (let f = 0; f < dv.getUint8(e + 3); f++) frames.push(dv.getUint32(e + 0xC + 4 * f, false));
        out.push({ segment: dv.getUint8(e), chunk: dv.getUint8(e + 1), delay: dv.getUint8(e + 2), frames });
    }
    return out;
}

/**
 * Walk the map's display lists (one linear pass over the whole block: every
 * sub-list is in it once, so the G_DL jump tables between them are skipped)
 * and gather triangles into batches by texture and render state.
 * Positions are divided by `scale` into world units.
 */
export function parseDK64Geometry(buffer, scale = 3) {
    const dv = new DataView(buffer);
    const vtxStart = dv.getUint32(0x38, false);
    // display list -> [start, end, vertex base (segment 6), chunk index]
    const ranges = dk64ListRanges(dv);
    let rangeIndex = 0;
    let chunkIndex = -1;
    const vertexBaseAt = (o) => {
        while (rangeIndex < ranges.length && ranges[rangeIndex][1] <= o) rangeIndex++;
        const r = ranges[rangeIndex];
        const inside = r && r[0] <= o;
        chunkIndex = inside ? r[3] : -1;
        return inside ? r[2] : vtxStart;
    };
    const animated = parseDK64AnimatedTextures(dv);
    return walkDK64DisplayList(dv, dv.getUint32(0x34, false), dv.getUint32(0x38, false), {
        scale,
        vertexEnd: dv.getUint32(0x40, false),
        vertexAddress: (o, w1) => (w1 >>> 24) === 0x06 ? vertexBaseAt(o) + (w1 & 0xFFFFFF) : -1,
        // 0x0B..0x0E: an animated texture, drawn with its first frame
        textureId: (o, w1) => {
            vertexBaseAt(o);
            const segment = w1 >>> 24;
            const entry = animated.find(a => a.segment === segment && a.chunk === chunkIndex) ??
                          animated.find(a => a.segment === segment);
            return entry && entry.frames.length ? entry.frames[0] | TABLE7_TEXTURE : -1;
        },
    });
}

/**
 * A pointer table 4 prop model (model2, func_806368F0 / func_80636AE8): two
 * display lists, +0x40..+0x44 and +0x44..+0x48 (the first is only a stub in
 * some models), vertices (segment 8) from +0x48; segment 9 is the instance
 * matrix. Null for the sprite-drawn kind (+0x1C == 2) and empty files.
 */
export function parseDK64PropModel(buffer) {
    const dv = new DataView(buffer);
    if (dv.byteLength < 0x50 || dv.getUint8(0x1C) !== 1) return null;
    const vtxStart = dv.getUint32(0x48, false);
    return walkDK64DisplayList(dv, dv.getUint32(0x40, false), vtxStart, {
        animatedTextures: dk64PropTextureAnimations(dv),
        vertexEnd: dv.byteLength,
        vertexAddress: (o, w1) => (w1 >>> 24) === 0x08 ? vtxStart + (w1 & 0xFFFFFF) : -1,
    });
}

const PROP_WALL_SIZE = 0x16;
const PROP_FLOOR_SIZE = 0x18;

/**
 * A prop model's collision, in the model's own units (like its display list):
 * walls at header +0x4C (u32 count, then 0x16 bytes each: s16 (x, y, z)[3],
 * u8, u8, s8 matrix (-1 = the prop's own; else one of its animated parts),
 * u8; global_asm func_8066C2D0's Prop_Wall), floors at +0x50 (u32 count, s16
 * min / max x, y, z bounds, then 0x18 bytes each: s16 (x, y, z)[3], 6 bytes
 * of flags). The animated parts' matrices only exist at run time, so walls on
 * them are drawn in their rest position, as the display list is.
 * -> { walls: Float32Array, floors: Float32Array } of triangle corners.
 */
export function parseDK64PropCollision(buffer) {
    const dv = new DataView(buffer);
    const out = { walls: new Float32Array(0), floors: new Float32Array(0) };
    if (dv.byteLength < 0x58 || dv.getUint8(0x1C) !== 1) return out;
    const read = (table, header, size) => {
        if (table + 4 > dv.byteLength) return new Float32Array(0);
        const count = Math.min(dv.getUint32(table, false), Math.floor((dv.byteLength - table - header) / size));
        const corners = new Float32Array(Math.max(0, count) * 9);
        for (let i = 0; i < count; i++) {
            const o = table + header + i * size;
            for (let k = 0; k < 9; k++) corners[i * 9 + k] = dv.getInt16(o + 2 * k, false);
        }
        return corners;
    };
    out.walls = read(dv.getUint32(0x4C, false), 4, PROP_WALL_SIZE);
    out.floors = read(dv.getUint32(0x50, false), 16, PROP_FLOOR_SIZE);
    return out;
}

const PROP_ANIMATION_SIZE = 0x84;

/**
 * A prop model's animated textures (header +0x60: u32 count, 0x84-byte
 * layers of u32 first frame, mode, delay, frame count, other frames): a
 * G_SETTIMG of a first frame's id is not a pointer table 25 texture but these
 * pointer table 7 frames (global_asm func_80636EFC / func_80639CD0). Jungle
 * Japes' grass tufts and flowers, Fungi's lamps... -> Map id -> { frames, delay }.
 */
function dk64PropTextureAnimations(dv) {
    const out = new Map();
    const table = dv.getUint32(0x60, false);
    if (table + 4 > dv.byteLength) return out;
    const count = dv.getUint32(table, false);
    for (let i = 0; i < count; i++) {
        const o = table + 4 + PROP_ANIMATION_SIZE * i;
        if (o + 16 > dv.byteLength) break;
        const first = dv.getUint32(o, false), delay = dv.getUint32(o + 8, false), n = dv.getUint32(o + 12, false);
        const frames = [first];
        for (let k = 0; k + 1 < n && o + 16 + 4 * (k + 1) <= dv.byteLength; k++) frames.push(dv.getUint32(o + 16 + 4 * k, false));
        out.set(first, { frames, delay });
    }
    return out;
}

/**
 * A pointer table 5 actor model (func_80612E90). Its addresses are relative
 * to the header's +0x00, which is file offset 0x28; +0x04 points at an array
 * of +0x21 display list pointers right after the display list, the first one
 * its start. Vertices are segment 3 from 0x28. Each bone (+0x08, +0x20 of
 * them, 0x10 bytes: u8 parent (0xFF = root), ..., f32 x, y, z from the
 * parent) is a G_MTX from segment 4 (0x40 bytes per bone); the model is
 * drawn in its rest pose, each bone's vertices moved by its offsets.
 */
export function parseDK64ActorModel(buffer) {
    const dv = new DataView(buffer);
    if (dv.byteLength < 0x30) return null;
    const base = dv.getUint32(0, false);
    const at = p => p - base + 0x28;
    const table = at(dv.getUint32(4, false));
    if (table < 0x28 || table + 4 > dv.byteLength) return null;
    const dlStart = at(dv.getUint32(table, false));
    const offsets = dk64ActorBoneOffsets(dv);
    const segmentTextures = dk64ActorSegmentTextures(dv);
    return walkDK64DisplayList(dv, dlStart, table, {
        vertexEnd: dv.byteLength,
        vertexAddress: (o, w1) => (w1 >>> 24) === 0x03 ? 0x28 + (w1 & 0xFFFFFF) : -1,
        textureId: (o, w1) => segmentTextures.get(w1 >>> 24) ?? -1,
        boneOffset: (w1) => (w1 >>> 24) === 0x04 ? offsets[(w1 & 0xFFFFFF) >> 6] ?? null : null,
    });
}

/** An actor model's bones' rest positions: each bone's offsets summed up its parents. */
function dk64ActorBoneOffsets(dv) {
    const base = dv.getUint32(0, false);
    const boneCount = dv.getUint8(0x20);
    const bonePtr = dv.getUint32(8, false);
    const offsets = [];
    if (!bonePtr) return offsets;
    const bones = bonePtr - base + 0x28;
    for (let i = 0; i < boneCount && bones + 0x10 * (i + 1) <= dv.byteLength; i++) {
        const b = bones + 0x10 * i;
        const parent = dv.getUint8(b);
        const p = parent < i ? offsets[parent] : [0, 0, 0];
        offsets.push([p[0] + dv.getFloat32(b + 4, false), p[1] + dv.getFloat32(b + 8, false), p[2] + dv.getFloat32(b + 0xC, false)]);
    }
    return offsets;
}

/**
 * An actor model's hit spheres and collision (header +0x0C, file offset
 * +0x0C - +0x00 + 0x28; up to +0x10), in model units and the rest pose:
 *   f32, f32 (unknown)
 *   u32 n, n x 0x14: f32 x, y, z, radius, s32 bone        hit spheres
 *   u32 n, n x 0x10: f32 x, y, z, s32 bone                points (unknown use)
 *   u32 n, n x 0x2C: f32 (x, y, z)[3], u32, s32 bone      walls
 *   u32 n, n x 0x34: f32 (x, y, z)[3], u32, s32 bone[3]   floors (a bone per corner)
 * A bone is the offset of its matrix (0x40 bytes each), -1 for the model's
 * own. Checked to end exactly at +0x10 on all 113 extracted actor models.
 * -> { spheres: [{ center, radius, bone }], points, walls, floors }
 *    (walls / floors: Float32Array of triangle corners), or null.
 */
export function parseDK64ActorCollision(buffer) {
    const dv = new DataView(buffer);
    if (dv.byteLength < 0x30 || !dv.getUint32(0x0C, false)) return null;
    const base = dv.getUint32(0, false);
    const start = dv.getUint32(0x0C, false) - base + 0x28;
    const end = dv.getUint32(0x10, false) ? dv.getUint32(0x10, false) - base + 0x28 : dv.byteLength;
    if (start < 0x28 || end > dv.byteLength) return null;
    const offsets = dk64ActorBoneOffsets(dv);
    const boneAt = matrix => matrix >= 0 ? offsets[matrix >> 6] ?? [0, 0, 0] : [0, 0, 0];
    const f = o => dv.getFloat32(o, false);
    let o = start + 8;
    const list = size => {
        if (o + 4 > end) return 0;
        const n = Math.min(dv.getUint32(o, false), Math.floor((end - o - 4) / size));
        o += 4;
        return n;
    };

    const spheres = [];
    for (let i = 0, n = list(0x14); i < n; i++, o += 0x14) {
        const bone = dv.getInt32(o + 0x10, false), b = boneAt(bone);
        spheres.push({ center: [f(o) + b[0], f(o + 4) + b[1], f(o + 8) + b[2]], radius: f(o + 0xC), bone: bone >= 0 ? bone >> 6 : -1 });
    }
    const points = list(0x10);
    o += points * 0x10;
    const n3 = list(0x2C);
    const walls = new Float32Array(n3 * 9);
    for (let i = 0; i < n3; i++, o += 0x2C) {
        const b = boneAt(dv.getInt32(o + 0x28, false));
        for (let k = 0; k < 9; k++) walls[i * 9 + k] = f(o + 4 * k) + b[k % 3];
    }
    const n4 = list(0x34);
    const floors = new Float32Array(n4 * 9);
    for (let i = 0; i < n4; i++, o += 0x34) {
        for (let v = 0; v < 3; v++) {
            const b = boneAt(dv.getInt32(o + 0x28 + 4 * v, false));
            for (let k = 0; k < 3; k++) floors[i * 9 + v * 3 + k] = f(o + 12 * v + 4 * k) + b[k];
        }
    }
    return { spheres, points, walls, floors };
}

/**
 * An actor model's animated textures (header +0x10: u16 count, then u16
 * frame count, u16 segment, u16, u16 table 25 ids[frame count]; eyes, mouths)
 * as segment -> first frame.
 */
function dk64ActorSegmentTextures(dv) {
    const out = new Map();
    const base = dv.getUint32(0, false);
    const ptr = dv.getUint32(0x10, false);
    if (!ptr) return out;
    let o = ptr - base + 0x28;
    if (o < 0x28 || o + 2 > dv.byteLength) return out;
    const count = dv.getUint16(o, false);
    o += 2;
    for (let i = 0; i < count && o + 6 <= dv.byteLength; i++) {
        const frames = dv.getUint16(o, false), segment = dv.getUint16(o + 2, false);
        if (frames && o + 8 <= dv.byteLength) out.set(segment, dv.getUint16(o + 6, false));
        o += 6 + 2 * frames;
    }
    return out;
}

const G_MTX = 0xDA;

const LIGHT_DIR = (() => { const l = [0.3, 0.85, 0.45], n = Math.hypot(...l); return l.map(x => x / n); })();
const LIGHT_AMBIENT = 0.55;

/**
 * Gather a display list's triangles into batches by texture and render state.
 * opts.vertexAddress(o, w1): file offset of a G_VTX's vertices, -1 to skip;
 * opts.textureId(o, w1): table 25 / 7 id for a G_SETTIMG outside segment 0;
 * opts.boneOffset(w1): translation for the vertices after a G_MTX;
 * opts.scale: file units per world unit; opts.vertexEnd: vertex data bound.
 */
function walkDK64DisplayList(dv, dlStart, dlEnd, opts) {
    const scale = opts.scale ?? 1;
    const vtxEnd = opts.vertexEnd;
    let offset = [0, 0, 0];

    const cache = new Array(64).fill(null);
    const tiles = Array.from({ length: 8 }, emptyTile);
    const tmem = new Map();     // tmem address -> table 25 id loaded there
    const tmemAnimation = new Map();   // texture id -> { frames, delay } (opts.animatedTextures)
    let timg = { id: -1, fmt: 0, siz: 0 };
    let texOn = false, texTile = 0, texScaleS = 1, texScaleT = 1;
    let geometryMode = 0, renderMode = 0, combineUsesTexture = true;

    const batches = new Map();
    const batchFor = (key, props) => {
        let b = batches.get(key);
        if (!b) {
            b = { ...props, positions: [], uvs: [], colors: [] };
            batches.set(key, b);
        }
        return b;
    };

    const currentTexture = () => {
        if (!texOn || !combineUsesTexture) return null;
        const tile = tiles[texTile];
        const id = tmem.get(tile.tmem);
        if (id === undefined || id < 0) return null;
        const width = ((tile.lrs - tile.uls) >> 2) + 1;
        const height = ((tile.lrt - tile.ult) >> 2) + 1;
        if (width <= 0 || height <= 0 || width > 1024 || height > 1024) return null;
        let palette = -1;
        if (tile.fmt === FMT_CI) {
            const palAddr = tile.siz === 0 ? 0x100 + tile.palette * 16 : 0x100;
            palette = tmem.get(palAddr) ?? -1;
        }
        const animation = tmemAnimation.get(id);
        return { id, palette, fmt: tile.fmt, siz: tile.siz, width, height, line: tile.line, cms: tile.cms, cmt: tile.cmt,
                 frames: animation ? animation.frames.map(f => f | TABLE7_TEXTURE) : null, delay: animation?.delay ?? 0 };
    };

    const emitTri = (a, b, c) => {
        const va = cache[a], vb = cache[b], vc = cache[c];
        if (!va || !vb || !vc) return;
        const tex = currentTexture();
        const tile = tiles[texTile];
        const xlu = (renderMode & RM_FORCE_BL) !== 0 && (renderMode & RM_Z_UPD) === 0;
        const decal = (renderMode & RM_ZMODE_DEC) === RM_ZMODE_DEC;
        const cull = geometryMode & (G_CULL_BACK | G_CULL_FRONT);
        const texKey = tex ? `${tex.id}/${tex.palette}/${tex.fmt}/${tex.siz}/${tex.width}x${tex.height}/${tex.line}/${tex.cms}/${tex.cmt}` : 'none';
        const batch = batchFor(`${texKey}|${xlu}|${decal}|${cull}`, { texture: tex, xlu, decal, cull });
        const lit = (geometryMode & G_LIGHTING) !== 0;
        const ss = shiftScale(tile.shifts) * texScaleS / 32;
        const st = shiftScale(tile.shiftt) * texScaleT / 32;
        for (const v of [va, vb, vc]) {
            batch.positions.push(v.x / scale, v.y / scale, v.z / scale);
            if (tex) batch.uvs.push((v.s * ss - tile.uls / 4) / tex.width, (v.t * st - tile.ult / 4) / tex.height);
            else batch.uvs.push(0, 0);
            if (lit) {
                // G_LIGHTING: the vertex colour is an s8 normal; shade it
                // with a fixed light from above (not the game's lights)
                const n = [v.r << 24 >> 24, v.g << 24 >> 24, v.b << 24 >> 24];
                const len = Math.hypot(n[0], n[1], n[2]) || 1;
                const d = (n[0] * LIGHT_DIR[0] + n[1] * LIGHT_DIR[1] + n[2] * LIGHT_DIR[2]) / len;
                const shade = LIGHT_AMBIENT + (1 - LIGHT_AMBIENT) * Math.max(0, d);
                batch.colors.push(shade, shade, shade, v.a / 255);
            } else {
                batch.colors.push(v.r / 255, v.g / 255, v.b / 255, v.a / 255);
            }
        }
    };

    for (let o = dlStart; o + 8 <= dlEnd; o += 8) {
        const w0 = dv.getUint32(o, false);
        const w1 = dv.getUint32(o + 4, false);
        switch (w0 >>> 24) {
            case G_VTX: {
                const n = (w0 >>> 12) & 0xFF;
                const v0 = ((w0 >>> 1) & 0x7F) - n;
                const base = opts.vertexAddress(o, w1);
                if (base < 0) break;
                for (let i = 0; i < n; i++) {
                    const p = base + i * 16;
                    if (v0 + i < 0 || v0 + i >= 64 || p + 16 > vtxEnd) continue;
                    cache[v0 + i] = {
                        x: dv.getInt16(p, false) + offset[0], y: dv.getInt16(p + 2, false) + offset[1], z: dv.getInt16(p + 4, false) + offset[2],
                        s: dv.getInt16(p + 8, false), t: dv.getInt16(p + 10, false),
                        r: dv.getUint8(p + 12), g: dv.getUint8(p + 13), b: dv.getUint8(p + 14), a: dv.getUint8(p + 15),
                    };
                }
                break;
            }
            case G_TRI1:
                emitTri(((w0 >>> 16) & 0xFF) >> 1, ((w0 >>> 8) & 0xFF) >> 1, (w0 & 0xFF) >> 1);
                break;
            case G_TRI2:
            case G_QUAD:
                emitTri(((w0 >>> 16) & 0xFF) >> 1, ((w0 >>> 8) & 0xFF) >> 1, (w0 & 0xFF) >> 1);
                emitTri(((w1 >>> 16) & 0xFF) >> 1, ((w1 >>> 8) & 0xFF) >> 1, (w1 & 0xFF) >> 1);
                break;
            case G_TEXTURE:
                texOn = ((w0 >>> 1) & 0x7F) !== 0;
                texTile = (w0 >>> 8) & 7;
                texScaleS = ((w1 >>> 16) & 0xFFFF) / 0x10000;
                texScaleT = (w1 & 0xFFFF) / 0x10000;
                break;
            case G_GEOMETRYMODE:
                geometryMode = (geometryMode & (w0 & 0xFFFFFF)) | w1;
                break;
            case G_SETOTHERMODE_L: {
                const len = (w0 & 0xFF) + 1;
                const shift = 32 - ((w0 >>> 8) & 0xFF) - len;
                const mask = (len >= 32 ? 0xFFFFFFFF : ((1 << len) - 1)) << shift;
                renderMode = (renderMode & ~mask) | (w1 & mask);
                break;
            }
            case G_SETCOMBINE: {
                // cycle 1 colour inputs a, b, c, d: 1 = TEXEL0, 2 = TEXEL1
                const a = (w0 >>> 20) & 0xF, c = (w0 >>> 15) & 0x1F;
                const b = (w1 >>> 28) & 0xF, d = (w1 >>> 15) & 0x7;
                combineUsesTexture = [a, b, c, d].some(x => x === 1 || x === 2) ||
                    [(w0 >>> 12) & 0x7, (w1 >>> 12) & 0x7, (w0 >>> 9) & 0x7, (w1 >>> 9) & 0x7].some(x => x === 1 || x === 2);
                break;
            }
            case G_SETTIMG: {
                // segment 0: a table 25 id, unless the model animates it
                // (opts.animatedTextures: id -> { frames (table 7), delay })
                const animation = (w1 >>> 24) === 0 ? opts.animatedTextures?.get(w1) : undefined;
                const id = animation ? animation.frames[0] | TABLE7_TEXTURE
                    : (w1 >>> 24) === 0 ? w1 : (opts.textureId?.(o, w1) ?? -1);
                timg = { id, fmt: (w0 >>> 21) & 7, siz: (w0 >>> 19) & 3, animation };
                break;
            }
            case G_MTX:
                if (opts.boneOffset) offset = opts.boneOffset(w1) ?? [0, 0, 0];
                break;
            case G_SETTILE: {
                const t = tiles[(w1 >>> 24) & 7];
                t.fmt = (w0 >>> 21) & 7; t.siz = (w0 >>> 19) & 3;
                t.line = (w0 >>> 9) & 0x1FF; t.tmem = w0 & 0x1FF;
                t.palette = (w1 >>> 20) & 0xF;
                t.cmt = (w1 >>> 18) & 3; t.maskt = (w1 >>> 14) & 0xF; t.shiftt = (w1 >>> 10) & 0xF;
                t.cms = (w1 >>> 8) & 3; t.masks = (w1 >>> 4) & 0xF; t.shifts = w1 & 0xF;
                break;
            }
            case G_SETTILESIZE: {
                const t = tiles[(w1 >>> 24) & 7];
                t.uls = (w0 >>> 12) & 0xFFF; t.ult = w0 & 0xFFF;
                t.lrs = (w1 >>> 12) & 0xFFF; t.lrt = w1 & 0xFFF;
                break;
            }
            case G_LOADBLOCK:
            case G_LOADTILE:
            case G_LOADTLUT:
                tmem.set(tiles[(w1 >>> 24) & 7].tmem, timg.id);
                if (timg.animation) tmemAnimation.set(timg.id, timg.animation);
                break;
        }
    }
    return [...batches.values()];
}

// --- textures --------------------------------------------------------------

function expand5(v) { return (v << 3) | (v >> 2); }

function rgba16At(bytes, o, out, p) {
    const c = (bytes[o] << 8) | bytes[o + 1];
    out[p] = expand5(c >> 11); out[p + 1] = expand5((c >> 6) & 0x1F); out[p + 2] = expand5((c >> 1) & 0x1F);
    out[p + 3] = (c & 1) ? 255 : 0;
}

/**
 * Decode a table 25 texture to RGBA8 (rows top first). `palette` is the
 * bytes of the RGBA16 TLUT for CI textures. Missing texels decode as magenta.
 */
export function decodeDK64Texture(bytes, tex, palette) {
    const { width, height, fmt, siz } = tex;
    const bitsPerTexel = 4 << siz;
    // G_SETTILE line is the row stride in 64-bit words of TMEM (0 for some
    // LOADBLOCKed tiles); 32-bit texels are split across TMEM's two halves, so
    // their line counts half the row's bytes.
    const stride = tex.line ? tex.line * 8 * (siz === 3 ? 2 : 1) : Math.ceil(width * bitsPerTexel / 8);
    const out = new Uint8Array(width * height * 4);
    for (let y = 0; y < height; y++) {
        for (let x = 0; x < width; x++) {
            const p = (y * width + x) * 4;
            const bit = y * stride * 8 + x * bitsPerTexel;
            const o = bit >> 3;
            if (o + (bitsPerTexel >> 3) > bytes.length) { out[p] = 255; out[p + 2] = 255; out[p + 3] = 255; continue; }
            const nibble = (bit & 4) ? bytes[o] & 0xF : bytes[o] >> 4;
            if (fmt === FMT_RGBA && siz === 2) {
                rgba16At(bytes, o, out, p);
            } else if (fmt === FMT_RGBA && siz === 3) {
                out[p] = bytes[o]; out[p + 1] = bytes[o + 1]; out[p + 2] = bytes[o + 2]; out[p + 3] = bytes[o + 3];
            } else if (fmt === FMT_CI) {
                const index = siz === 0 ? nibble : bytes[o];
                if (palette && index * 2 + 1 < palette.length) rgba16At(palette, index * 2, out, p);
                else { out[p] = out[p + 1] = out[p + 2] = index * (siz === 0 ? 17 : 1); out[p + 3] = 255; }
            } else if (fmt === FMT_IA && siz === 0) {
                const i = (nibble >> 1) * 255 / 7;
                out[p] = out[p + 1] = out[p + 2] = i; out[p + 3] = (nibble & 1) ? 255 : 0;
            } else if (fmt === FMT_IA && siz === 1) {
                const i = (bytes[o] >> 4) * 17;
                out[p] = out[p + 1] = out[p + 2] = i; out[p + 3] = (bytes[o] & 0xF) * 17;
            } else if (fmt === FMT_IA && siz === 2) {
                out[p] = out[p + 1] = out[p + 2] = bytes[o]; out[p + 3] = bytes[o + 1];
            } else if (fmt === FMT_I && siz === 0) {
                out[p] = out[p + 1] = out[p + 2] = out[p + 3] = nibble * 17;
            } else if (fmt === FMT_I && siz === 1) {
                out[p] = out[p + 1] = out[p + 2] = out[p + 3] = bytes[o];
            } else {
                out[p] = 255; out[p + 2] = 255; out[p + 3] = 255;
            }
        }
    }
    return out;
}

function wrapMode(bits) {
    if (bits & 2) return THREE.ClampToEdgeWrapping;
    if (bits & 1) return THREE.MirroredRepeatWrapping;
    return THREE.RepeatWrapping;
}

const textureFileCache = new Map();   // id -> Promise<Uint8Array | null>

function fetchTexture(id) {
    if (!textureFileCache.has(id)) {
        const hex = (id & 0xFFFF).toString(16).toUpperCase().padStart(4, '0');
        const name = (id & TABLE7_TEXTURE) ? `T7_${hex}` : hex;
        textureFileCache.set(id, fetch(`./models/DK64/textures/${name}.bin`)
            .then(res => res.ok ? res.arrayBuffer().then(b => new Uint8Array(b)) : null)
            .catch(() => null));
    }
    return textureFileCache.get(id);
}

const namedTextureCache = new Map();   // file name -> Promise<Uint8Array | null>

function fetchTextureFile(name) {
    if (!namedTextureCache.has(name)) {
        namedTextureCache.set(name, fetch(`./models/DK64/textures/${name}.bin`)
            .then(res => res.ok ? res.arrayBuffer().then(b => new Uint8Array(b)) : null)
            .catch(() => null));
    }
    return namedTextureCache.get(name);
}

/**
 * A DataTexture from models/DK64/textures/<name>.bin, decoded as
 * { width, height, fmt, siz } with an optional palette file; rows bottom first
 * (as DK64's sprites store them) map to v = 0. Null if the file is missing.
 */
export async function loadDK64Texture(name, info, paletteName = null) {
    const [bytes, palette] = await Promise.all([fetchTextureFile(name), paletteName ? fetchTextureFile(paletteName) : null]);
    if (!bytes) return null;
    const texture = new THREE.DataTexture(decodeDK64Texture(bytes, { ...info, line: 0 }, palette), info.width, info.height, THREE.RGBAFormat);
    texture.colorSpace = THREE.SRGBColorSpace;
    texture.magFilter = THREE.LinearFilter;
    texture.minFilter = THREE.LinearFilter;
    texture.generateMipmaps = false;
    texture.wrapS = texture.wrapT = THREE.ClampToEdgeWrapping;
    texture.needsUpdate = true;
    return texture;
}

// --- water -------------------------------------------------------------------

const WATER_SIZE = 0x6C;

// Texture per water type (byte +0x66 of a record): the D_80748A90 table's
// init and draw functions in global_asm/code_63EC0.c. Types 0 / 3 blend two
// tiles of their texture, 2 / 4 / 8 are mipmapped (the top level is used).
const WATER_TYPES = [
    { id: 0x3C5 | TABLE7_TEXTURE, fmt: FMT_RGBA, siz: 3, width: 32, height: 32 },
    { id: 0x2EE, palette: 0x2EF, fmt: FMT_CI, siz: 0, width: 64, height: 64 },
    { id: 0xF0, fmt: FMT_RGBA, siz: 2, width: 32, height: 32 },
    { id: 0x3C5 | TABLE7_TEXTURE, fmt: FMT_RGBA, siz: 3, width: 32, height: 32 },
    { id: 0x75C, fmt: FMT_RGBA, siz: 2, width: 32, height: 32 },
    { id: 0x3B9 | TABLE7_TEXTURE, fmt: FMT_RGBA, siz: 2, width: 32, height: 32 },
    { id: 0x3D2 | TABLE7_TEXTURE, fmt: FMT_RGBA, siz: 2, width: 32, height: 32 },
    { id: 0x3BA | TABLE7_TEXTURE, fmt: FMT_RGBA, siz: 2, width: 32, height: 32 },
    { id: 0xAF4, fmt: FMT_RGBA, siz: 2, width: 32, height: 32 },
];

// World units per texture repeat (the game's s / t scale is in asm; this
// is a look-alike).
const WATER_TEXTURE_REPEAT = 100;

/**
 * The map's water surfaces (header +0x4C: u32 count, then 0x6C-byte records;
 * global_asm func_80660830 / func_8065FB64): an x / z rectangle at +0x46,
 * +0x48, +0x4A, +0x4C, its height at +0x4E (world units), colour at +0x61..+0x64
 * and type at +0x66. The game moves some of them up and down at run time
 * (Galleon's tide); this is the stored height.
 */
export function parseDK64Water(dv) {
    const table = dv.getUint32(0x4C, false);
    const out = [];
    const count = dv.getUint32(table, false);
    for (let i = 0; i < count; i++) {
        const r = table + 4 + i * WATER_SIZE;
        out.push({
            x0: dv.getInt16(r + 0x46, false), z0: dv.getInt16(r + 0x48, false),
            x1: dv.getInt16(r + 0x4A, false), z1: dv.getInt16(r + 0x4C, false),
            y: dv.getInt16(r + 0x4E, false),
            color: [dv.getUint8(r + 0x61), dv.getUint8(r + 0x62), dv.getUint8(r + 0x63)],
            alpha: dv.getUint8(r + 0x64),
            type: dv.getUint8(r + 0x66),
        });
    }
    return out;
}

/** The water surfaces as a Group of translucent textured quads, or null if the map has none. */
export async function buildDK64Water(buffer) {
    const water = parseDK64Water(new DataView(buffer));
    if (!water.length) return null;
    const group = new THREE.Group();
    group.name = 'Water';
    const textures = new Map();
    const textureFor = async (type) => {
        const info = WATER_TYPES[type];
        if (!info) return null;
        if (!textures.has(type)) {
            const [bytes, palette] = await Promise.all([fetchTexture(info.id), info.palette !== undefined ? fetchTexture(info.palette) : null]);
            let texture = null;
            if (bytes) {
                texture = new THREE.DataTexture(decodeDK64Texture(bytes, { ...info, line: 0 }, palette), info.width, info.height, THREE.RGBAFormat);
                texture.colorSpace = THREE.SRGBColorSpace;
                texture.magFilter = THREE.LinearFilter;
                texture.minFilter = THREE.LinearFilter;
                texture.generateMipmaps = false;
                texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
                texture.needsUpdate = true;
            }
            textures.set(type, texture);
        }
        return textures.get(type);
    };
    for (const w of water) {
        const x0 = Math.min(w.x0, w.x1), x1 = Math.max(w.x0, w.x1);
        const z0 = Math.min(w.z0, w.z1), z1 = Math.max(w.z0, w.z1);
        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.Float32BufferAttribute([
            x0, w.y, z0, x0, w.y, z1, x1, w.y, z1, x1, w.y, z0], 3));
        geometry.setAttribute('uv', new THREE.Float32BufferAttribute([
            x0, z0, x0, z1, x1, z1, x1, z0].map(v => v / WATER_TEXTURE_REPEAT), 2));
        geometry.setIndex([0, 1, 2, 0, 2, 3]);
        const material = new THREE.MeshBasicMaterial({
            color: new THREE.Color(w.color[0] / 255, w.color[1] / 255, w.color[2] / 255).convertSRGBToLinear(),
            map: await textureFor(w.type),
            transparent: true,
            opacity: Math.max(w.alpha, 96) / 255,
            depthWrite: false,
            side: THREE.DoubleSide,
        });
        const mesh = new THREE.Mesh(geometry, material);
        mesh.renderOrder = 1;
        mesh.userData.textured = true;   // keeps its own material (main.js setMaterialProps)
        group.add(mesh);
    }
    return group;
}

/**
 * The map's display lists as one textured, vertex-coloured Mesh (a material
 * per batch), in world units.
 */
export async function buildDK64TexturedMesh(buffer, scale) {
    const batches = parseDK64Geometry(buffer, scale);
    const { geometry, materials, triangleCount, textureCount } = await buildDK64Parts(batches);
    const mesh = new THREE.Mesh(geometry, materials);
    mesh.name = 'textured';
    console.log(`DK64 geometry: ${triangleCount} triangles in ${batches.length} batches, ${textureCount} textures`);
    return mesh;
}

/**
 * Geometry (one group per batch) and materials for batches from
 * walkDK64DisplayList, with their textures fetched; shareable between
 * instances.
 */
// Animated textures step every `delay` ticks of the game's 30 Hz frame rate;
// materials are shared by all placements of a model, so they turn in step.
const TEXTURE_TICKS_PER_SECOND = 30;

/** Show the current frame on every material with userData.animation. */
export function animateDK64Materials(materials) {
    const tick = Math.floor(performance.now() / 1000 * TEXTURE_TICKS_PER_SECOND);
    for (const material of materials) {
        const anim = material.userData.animation;
        if (!anim) continue;
        const frame = anim.frames[Math.floor(tick / anim.delay) % anim.frames.length];
        if (material.map !== frame) material.map = frame;
    }
}

export async function buildDK64Parts(batches) {
    const ids = new Set();
    for (const b of batches) {
        if (!b.texture) continue;
        ids.add(b.texture.id);
        if (b.texture.palette >= 0) ids.add(b.texture.palette);
        for (const f of b.texture.frames ?? []) ids.add(f);
    }
    const files = new Map();
    await Promise.all([...ids].map(async id => files.set(id, await fetchTexture(id))));

    const textures = new Map();
    const textureFor = (tex) => {
        const key = `${tex.id}/${tex.palette}/${tex.fmt}/${tex.siz}/${tex.width}x${tex.height}/${tex.line}/${tex.cms}/${tex.cmt}`;
        if (textures.has(key)) return textures.get(key);
        const bytes = files.get(tex.id);
        let texture = null;
        if (bytes) {
            const rgba = decodeDK64Texture(bytes, tex, tex.palette >= 0 ? files.get(tex.palette) : null);
            texture = new THREE.DataTexture(rgba, tex.width, tex.height, THREE.RGBAFormat);
            texture.flipY = false;
            texture.colorSpace = THREE.SRGBColorSpace;
            texture.magFilter = THREE.LinearFilter;
            texture.minFilter = THREE.LinearFilter;
            texture.generateMipmaps = false;
            texture.wrapS = wrapMode(tex.cms);
            texture.wrapT = wrapMode(tex.cmt);
            texture.needsUpdate = true;
        }
        textures.set(key, texture);
        return texture;
    };

    const geometry = new THREE.BufferGeometry();
    const positions = [], uvs = [], colors = [], materials = [];
    let start = 0;
    // Opaque batches first, then the blended ones, as the game's draw order
    batches.sort((a, b) => a.xlu - b.xlu);
    for (const batch of batches) {
        const count = batch.positions.length / 3;
        positions.push(...batch.positions);
        uvs.push(...batch.uvs);
        if (batch.xlu) colors.push(...batch.colors);
        else for (let i = 0; i < batch.colors.length; i += 4) colors.push(batch.colors[i], batch.colors[i + 1], batch.colors[i + 2], 1);
        geometry.addGroup(start, count, materials.length);
        start += count;
        const material = new THREE.MeshBasicMaterial({
            vertexColors: true,
            side: (batch.cull & G_CULL_BACK) ? THREE.FrontSide : (batch.cull & G_CULL_FRONT) ? THREE.BackSide : THREE.DoubleSide,
            transparent: batch.xlu,
            depthWrite: !batch.xlu,
            alphaTest: batch.xlu ? 0.01 : 0.5,
            polygonOffset: batch.decal,
            polygonOffsetFactor: batch.decal ? -1 : 0,
            polygonOffsetUnits: batch.decal ? -1 : 0,
        });
        if (batch.texture) material.map = textureFor(batch.texture);
        // A prop's animated texture: the frames step by animateDK64Materials
        if (batch.texture?.frames?.length > 1) {
            const frames = batch.texture.frames.map(id => textureFor({ ...batch.texture, id })).filter(Boolean);
            if (frames.length > 1) material.userData.animation = { frames, delay: Math.max(1, batch.texture.delay) };
        }
        materials.push(material);
    }
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 4));
    geometry.computeBoundingBox();
    geometry.computeBoundingSphere();
    return { geometry, materials, triangleCount: start / 3, textureCount: ids.size,
             animated: materials.some(m => m.userData.animation) };
}
