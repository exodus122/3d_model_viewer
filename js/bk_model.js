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

const TEX_TYPE_CI4 = 0x01;
const TEX_TYPE_CI8 = 0x02;
const TEX_TYPE_RGBA16 = 0x04;
const TEX_TYPE_RGBA32 = 0x08;
const TEX_TYPE_IA8 = 0x10;

const TEXTURE_SEGMENT = 0x02;

// F3DEX (v1) opcodes beyond the ones the collision-only decoder needs
const G_CLEARGEOMETRYMODE = 0xB6;
const G_SETGEOMETRYMODE = 0xB7;
const G_TEXTURE = 0xBB;
const G_SETTIMG = 0xFD;
const G_SETTILE = 0xF5;
const G_SETTILESIZE = 0xF2;
const G_LOADBLOCK = 0xF3;
const G_LOADTILE = 0xF4;
const G_SETCOMBINE = 0xFC;
const G_ENDDL = 0xB8;

// Geometry-setup commands (include/core2/model.h). The geo list is a tree of
// these that modelRender_draw walks; it decides which display lists run, in
// what order, and carries state like TEXWRAP.
const GEO_UNK0 = 0x00, GEO_SORT = 0x01, GEO_BONE = 0x02, GEO_LOADDL = 0x03, GEO_SKINNING = 0x05,
      GEO_CALL = 0x06, GEO_LOADDL2 = 0x07, GEO_LOD = 0x08, GEO_SELECTOR = 0x0C, GEO_DRAWDIST = 0x0D,
      GEO_UNKE = 0x0E, GEO_CAMERA = 0x0F, GEO_TEXWRAP = 0x10;

const G_LIGHTING = 0x00020000;
const G_TEXTURE_GEN = 0x00040000;
const G_CULL_BACK = 0x00002000;

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
 *            batches: {texture: number, wrapS: number, wrapT: number, cullBack: boolean,
 *                      positions: number[], uvs: number[], colors: number[]}[]} | null}
 *   texture is an index into textures or -1 for untextured; wrapS/wrapT are the
 *   tile's clamp/mirror bits (bit 1 clamp, bit 0 mirror).
 */
export function parseBKModelTextured(buffer) {
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
        const dataBase = textureListOffset + 8 + count * 16;
        for (let i = 0; i < count; i++) {
            const o = textureListOffset + 8 + i * 16;
            const info = {
                offset: dv.getInt32(o, false),
                type: dv.getInt16(o + 4, false),
                width: dv.getUint8(o + 8),
                height: dv.getUint8(o + 9),
            };
            info.size = texturePaletteBytes(info.type) + (texturePixelBits(info.type) * info.width * info.height) / 8;
            info.rgba = decodeTexture(dv, dataBase, info);
            textures.push(info);
        }
    }
    const textureAt = (addr) => {
        if ((addr >>> 24) !== TEXTURE_SEGMENT) return -1;
        const off = addr & 0xFFFFFF;
        return textures.findIndex(t => off >= t.offset && off < t.offset + t.size);
    };

    // ---- vertices
    const vertexCount = dv.getInt16(vtxListOffset + 0x14, false);
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
    let geometryMode = 0;
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
        const key = tex + ':' + wrapS + ':' + wrapT + ':' + (cullBack ? 1 : 0);
        let b = batches.get(key);
        if (!b) {
            b = { texture: tex, wrapS, wrapT, cullBack, positions: [], uvs: [], colors: [] };
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

            if (!combinerUsesShade) {
                // Combiner ignores the shade colour (e.g. plain TEXEL0 output).
                batch.colors.push(1, 1, 1);
            } else if (lit) {
                // The colour bytes are a normal; approximate the game's single
                // directional light with a fixed key light plus ambient.
                const d = Math.max(0, nx * 0.30 + ny * 0.86 + nz * 0.41);
                const i = 0.45 + 0.55 * d;
                batch.colors.push(i, i, i);
            } else {
                batch.colors.push(dv.getUint8(o + 12) / 255, dv.getUint8(o + 13) / 255, dv.getUint8(o + 14) / 255);
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
            if ((w0 >>> 24) === G_ENDDL) {
                if (linear) continue;
                return;
            }
            switch (w0 >>> 24) {
            case G_VTX: {
                    const v0 = ((w0 >>> 16) & 0xFF) >>> 1;
                    const n = ((w0 >>> 10) & 0x3F) + 1;
                    if ((w1 >>> 24) !== VERTEX_SEGMENT) break;
                    const first = (w1 & 0xFFFFFF) / VTX_SIZE;
                    for (let k = 0; k < n && v0 + k < VTX_CACHE_SIZE; k++) {
                        const idx = first + k;
                        cache[v0 + k] = idx < vertexCount ? idx : -1;
                    }
                    break;
                }
                case G_TRI1:
                    emit(cache[((w1 >>> 16) & 0xFF) >>> 1], cache[((w1 >>> 8) & 0xFF) >>> 1], cache[(w1 & 0xFF) >>> 1]);
                    break;
                case G_TRI2:
                    emit(cache[((w0 >>> 16) & 0xFF) >>> 1], cache[((w0 >>> 8) & 0xFF) >>> 1], cache[(w0 & 0xFF) >>> 1]);
                    emit(cache[((w1 >>> 16) & 0xFF) >>> 1], cache[((w1 >>> 8) & 0xFF) >>> 1], cache[(w1 & 0xFF) >>> 1]);
                    break;
                case G_QUAD: {
                    const a = cache[((w1 >>> 24) & 0xFF) >>> 1], b = cache[((w1 >>> 16) & 0xFF) >>> 1];
                    const c = cache[((w1 >>> 8) & 0xFF) >>> 1], d = cache[(w1 & 0xFF) >>> 1];
                    emit(a, b, c);
                    emit(a, c, d);
                    break;
                }
                case G_CLEARGEOMETRYMODE: geometryMode &= ~w1; break;
                case G_SETGEOMETRYMODE: geometryMode |= w1; break;
                case G_TEXTURE:
                    // w0: | op | 0 | level:3 tile:3 | on |   w1: scaleS:16 scaleT:16 (0.16 fixed)
                    texOn = (w0 & 0xFF) !== 0;
                    renderTile = (w0 >>> 8) & 7;
                    texScaleS = (w1 >>> 16) / 65536;
                    texScaleT = (w1 & 0xFFFF) / 65536;
                    break;
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
    let geoSteps = 0;
    const walkGeo = (offset, depth) => {
        if (depth > 64) return;
        while (offset > 0 && offset + 8 <= dv.byteLength && geoSteps++ < 200000) {
            const cmd = dv.getUint32(offset, false);
            const next = dv.getInt32(offset + 4, false);
            const branch16 = () => dv.getInt16(offset + 8, false);
            switch (cmd) {
                case GEO_UNK0:
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
                    //
                    // The game draws nothing here until the actor sets a
                    // selector. A one-branch selector is an on/off toggle for an
                    // optional part (a note door's 12 digit plates, hats, ...),
                    // so keep it off; a multi-branch one picks between states
                    // (eye blinks, mouth shapes), so show the first.
                    const count = dv.getInt16(offset + 8, false);
                    if (count > 1) {
                        const b = dv.getInt32(offset + 12, false);
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

    return { textures, batches: [...batches.values()] };
}
