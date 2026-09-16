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
//  - the F3DEX display lists: what the game draws. Only needed for models
//    with no collision (about half the props), decoded by replaying the
//    G_VTX / G_TRI1 / G_TRI2 / G_QUAD commands against a vertex cache.
//
// Both index into the same BKVertexList, so a caller gets one position
// array plus one index array per source.

const MODEL_MAGIC = 0x0000000B;

// F3DEX (v1) opcodes. modelRender_draw points segment 1 at the model's
// vertex list, so every G_VTX address is 0x01xxxxxx with the low 24 bits a
// byte offset into the Vtx array (16 bytes per vertex).
const G_VTX = 0x04;
const G_TRI1 = 0xBF;
const G_TRI2 = 0xB1;
const G_QUAD = 0xB5;
const VERTEX_SEGMENT = 0x01;
const VTX_CACHE_SIZE = 32;
const VTX_SIZE = 16;

/**
 * @param {ArrayBuffer} buffer a decompressed BKModelBin
 * @returns {{positions: Float32Array, vertexCount: number,
 *            collisionIndices: Uint16Array|Uint32Array|null,
 *            displayListIndices: Uint16Array|Uint32Array|null}}
 */
export function parseBKModelGeometry(buffer) {
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
    const vertexCount = dv.getInt16(vtxListOffset + 0x14, false);
    const vtxBase = vtxListOffset + 0x18;
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
            const op = w0 >>> 24;
            if (op === G_VTX) {
                // w0: | op:8 | v0*2:8 | (n-1):6 | (n*16-1):10 |   w1: segmented address
                const v0 = ((w0 >>> 16) & 0xFF) >>> 1;
                const n = ((w0 >>> 10) & 0x3F) + 1;
                if ((w1 >>> 24) !== VERTEX_SEGMENT) continue;
                const first = (w1 & 0xFFFFFF) / VTX_SIZE;
                for (let k = 0; k < n && v0 + k < VTX_CACHE_SIZE; k++) {
                    const idx = first + k;
                    cache[v0 + k] = idx < vertexCount ? idx : -1;
                }
            } else if (op === G_TRI1) {
                pushCacheTri(out, seen, cache, w1, vertexCount);
            } else if (op === G_TRI2) {
                pushCacheTri(out, seen, cache, w0, vertexCount);
                pushCacheTri(out, seen, cache, w1, vertexCount);
            } else if (op === G_QUAD) {
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

    return { positions, vertexCount, collisionIndices, displayListIndices };
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
