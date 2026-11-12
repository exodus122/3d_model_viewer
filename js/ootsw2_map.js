// Ocarina of Time (Switch 2) maps, from the Owl Object Map's data
// (tools/ootsw2/extract_objmap.py -> models/OOTSW2/<map_type>/<map_name>/).
//
// The level is the static compound (compound/: the game's baked static
// collision, every triangle tagged with its object). Objects not baked into
// it come from collision.bin ("OCOL"), one collision shape per ACTOR NAME in
// the actor's local space: each placed object in objects.json whose name has a
// shape gets it scaled, rotated and moved to its position, the same transform
// objmap-oot uses for its shapes (scale, then R = Rz * Ry * Rx, then +pos).
// Everything is then split by actor name (groupOOTSW2ByActor), one row each.
import * as THREE from 'three';
import { ConvexGeometry } from 'three/addons/geometries/ConvexGeometry.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';

// The game is in metres; x10 puts Hyrule Field near N64 OoT's size and keeps
// the big maps inside the camera's far plane (100000).
export const OOTSW2_SCALE = 10;

// collision.bin:
//   "OCOL", u32 version 1, u32 shapeCount, then per shape:
//     u16 nameLen, name, u32 vertexCount, u32 indexCount, u32 hullCount,
//     f32 min[3], f32 max[3], u16 xyz[vertexCount] (quantized over min..max),
//     u16 or u32 (vertexCount > 65536) indices[indexCount], pad to 4,
//     (u32 firstVertex, u32 vertexCount)[hullCount]: convex hulls as point sets
//   u32 n, u64 hashIds[n]: placed objects that have no collision
export function parseOCOL(buf) {
    const dv = new DataView(buf);
    if (buf.byteLength < 12 || new TextDecoder().decode(new Uint8Array(buf, 0, 4)) !== 'OCOL' || dv.getUint32(4, true) !== 1)
        return null;
    const shapes = new Map();
    const count = dv.getUint32(8, true);
    let p = 12;
    for (let s = 0; s < count; s++) {
        const len = dv.getUint16(p, true);
        const name = new TextDecoder().decode(new Uint8Array(buf, p + 2, len));
        p += 2 + len;
        const vc = dv.getUint32(p, true), ic = dv.getUint32(p + 4, true), hc = dv.getUint32(p + 8, true);
        const min = [0, 1, 2].map(k => dv.getFloat32(p + 12 + k * 4, true));
        const max = [0, 1, 2].map(k => dv.getFloat32(p + 24 + k * 4, true));
        p += 36;
        const step = min.map((m, k) => Math.max(max[k] - m, 1e-6) / 65535);
        const positions = new Float32Array(vc * 3);
        for (let k = 0; k < vc * 3; k++) positions[k] = min[k % 3] + dv.getUint16(p + k * 2, true) * step[k % 3];
        p += vc * 6;
        const wide = vc > 65536;
        const indices = wide ? new Uint32Array(buf.slice(p, p + ic * 4)) : new Uint16Array(buf.slice(p, p + ic * 2));
        p += ic * (wide ? 4 : 2);
        p += -p & 3;
        const hulls = [];
        for (let h = 0; h < hc; h++, p += 8) hulls.push({ first: dv.getUint32(p, true), count: dv.getUint32(p + 4, true) });
        shapes.set(name, { positions, indices, hulls });
    }
    const skipped = new Set();
    const n = dv.getUint32(p, true);
    for (let k = 0; k < n; k++) skipped.add('0x' + dv.getBigUint64(p + 4 + k * 8, true).toString(16).padStart(16, '0'));
    return { shapes, skipped };
}

// The object's rotation as matrix rows, R = Rz * Ry * Rx (radians)
export function rotationRows(obj) {
    const [rx, ry, rz] = obj.r ?? [0, 0, 0];
    const [sx, sy, sz] = [Math.sin(rx), Math.sin(ry), Math.sin(rz)];
    const [cx, cy, cz] = [Math.cos(rx), Math.cos(ry), Math.cos(rz)];
    return [
        [cy * cz, sx * sy * cz - cx * sz, cx * sy * cz + sx * sz],
        [cy * sz, sx * sy * sz + cx * cz, cx * sy * sz - sx * cz],
        [-sy, sx * cy, cx * cy],
    ];
}

// local [x, y, z] -> world (viewer units), for one placed object
export function placement(obj) {
    const m = rotationRows(obj);
    const scale = obj.s ?? [1, 1, 1];
    const pos = obj.p;
    return (x, y, z) => {
        const l = [x * scale[0], y * scale[1], z * scale[2]];
        return m.map((row, r) => (pos[r] + row[0] * l[0] + row[1] * l[1] + row[2] * l[2]) * OOTSW2_SCALE);
    };
}

// A growing verts / tris list (buildGeometry's input), with the object each
// triangle came from for the selection info.
export function meshList() {
    return { verts: [], tris: [], owners: [] };
}

export function addTriangles(list, place, positions, indices, owner) {
    const base = list.verts.length;
    const used = new Map();   // shape vertex -> list vertex, only the ones the triangles use
    const vert = i => {
        let v = used.get(i);
        if (v === undefined) {
            v = list.verts.length;
            used.set(i, v);
            list.verts.push(place(positions[i * 3], positions[i * 3 + 1], positions[i * 3 + 2]));
        }
        return v;
    };
    for (let t = 0; t + 2 < indices.length; t += 3) {
        list.tris.push([vert(indices[t]), vert(indices[t + 1]), vert(indices[t + 2])]);
        list.owners.push(owner);
    }
    return list.verts.length - base;
}

export function addHull(list, points, owner) {
    if (points.length < 4) return;
    let geom;
    try { geom = new ConvexGeometry(points); } catch { return; }
    const pos = geom.getAttribute('position');
    for (let i = 0; i < pos.count; i += 3) {
        const v = list.verts.length;
        for (let k = 0; k < 3; k++) list.verts.push([pos.getX(i + k), pos.getY(i + k), pos.getZ(i + k)]);
        list.tris.push([v, v + 1, v + 2]);
        list.owners.push(owner);
    }
    geom.dispose();
}

// Land_* (and Dm_Land_*) pieces are the level; everything else with a shape
// is an actor (doors, crates, NPCs...).
export function isOOTSW2Terrain(name) {
    return /^(Dm_)?Land_/.test(name);
}

// -> { terrain, actors, hulls, airwalls } mesh lists in viewer units, plus counts.
// hasCompound: the static compound is drawn, so leave out what it holds.
export function buildOOTSW2Collision(ocol, objects, airwalls, hasCompound = false) {
    const out = { terrain: meshList(), actors: meshList(), hulls: meshList(), airwalls: meshList() };
    const counts = { placed: 0, skipped: 0, noShape: 0 };
    for (const obj of objects) {
        const air = airwalls?.[obj.n];
        if (air) {
            // air walls baked into the static compound are drawn from it
            if (hasCompound && ocol?.skipped.has(obj.h)) { counts.skipped++; continue; }
            addTriangles(out.airwalls, placement(obj), air.v, air.i, obj);
            continue;
        }
        const shape = ocol?.shapes.get(obj.n);
        if (!shape) { counts.noShape++; continue; }
        // The static compound already holds these (baked static actors); without
        // one they are drawn from their own shapes
        if (ocol.skipped.has(obj.h)) {
            counts.skipped++;
            if (hasCompound) continue;
        }
        counts.placed++;
        const place = placement(obj);
        if (shape.indices.length)
            addTriangles(isOOTSW2Terrain(obj.n) && !hasCompound ? out.terrain : out.actors, place, shape.positions, shape.indices, obj);
        for (const { first, count } of shape.hulls) {
            const points = [];
            for (let i = first; i < first + count; i++) {
                const [x, y, z] = place(shape.positions[i * 3], shape.positions[i * 3 + 1], shape.positions[i * 3 + 2]);
                points.push(new THREE.Vector3(x, y, z));
            }
            addHull(out.hulls, points, obj);
        }
    }
    return { ...out, counts };
}

// A meshList as a typed source for groupOOTSW2ByActor: owners as indices
// into `objects`.
export function typedMeshList(list, objects) {
    const index = new Map(objects.map((o, i) => [o, i]));
    const positions = new Float32Array(list.verts.length * 3);
    list.verts.forEach((v, i) => positions.set(v, i * 3));
    const indices = new Uint32Array(list.tris.length * 3);
    list.tris.forEach((t, k) => indices.set(t, k * 3));
    return { positions, indices, owners: Int32Array.from(list.owners, o => index.get(o) ?? NO_OBJECT) };
}

// A typed source split in two by its triangles' owners: { kind } keeps those
// keep(owner) accepts, { kind: otherKind } the rest (same position buffer).
export function splitSourceByOwner(src, otherKind, keep) {
    const parts = splitSourceByTriangle(src, t => keep(src.owners[t]) ? src.kind : otherKind);
    return [src.kind, otherKind].map(kind => parts.find(p => p.kind === kind) ?? emptySource(src, kind));
}

function emptySource(src, kind) {
    return { kind, positions: src.positions, indices: new Uint32Array(0), owners: new Int32Array(0),
             ...(src.surfaces ? { surfaces: new Uint16Array(0) } : {}) };
}

// A typed source split by kindOf(triangle index) -> kind, one source per kind
// that has triangles (same position buffer; per-triangle surfaces kept).
export function splitSourceByTriangle(src, kindOf) {
    const tris = src.owners.length;
    const kinds = new Map();   // kind -> count
    const kindIndex = new Int32Array(tris);
    const order = [];
    for (let t = 0; t < tris; t++) {
        const kind = kindOf(t);
        if (!kinds.has(kind)) { kinds.set(kind, 0); order.push(kind); }
        kinds.set(kind, kinds.get(kind) + 1);
        kindIndex[t] = order.indexOf(kind);
    }
    const parts = order.map(kind => {
        const count = kinds.get(kind);
        return { kind, positions: src.positions, indices: new Uint32Array(count * 3), owners: new Int32Array(count),
                 ...(src.surfaces ? { surfaces: new Uint16Array(count) } : {}), fill: 0 };
    });
    for (let t = 0; t < tris; t++) {
        const part = parts[kindIndex[t]], k = part.fill++;
        part.indices.set(src.indices.subarray(t * 3, t * 3 + 3), k * 3);
        part.owners[k] = src.owners[t];
        if (part.surfaces) part.surfaces[k] = src.surfaces[t];
    }
    for (const part of parts) delete part.fill;
    return parts;
}

// Owner codes for triangles that are not one placed object's
export const NO_OBJECT = -1, DISTANT = -2, GROUND = -3;

// Splits every source's triangles by the actor NAME of the object they belong
// to, so each actor (all its instances) can be its own row.
// sources: [{ kind, positions, indices, owners }] (kind: "static", "actor",
// "hull", "airwall"). Every part shares its source's position buffer.
// -> [{ name, category, instances, triangles, parts: [{ kind, positions, indices, owners }] }]
export function groupOOTSW2ByActor(sources, objects) {
    const keyOf = new Map();   // actor name -> key id
    const objKey = Int32Array.from(objects, o => {
        if (!keyOf.has(o.n)) keyOf.set(o.n, keyOf.size);
        return keyOf.get(o.n);
    });
    const special = { [NO_OBJECT]: keyOf.size, [DISTANT]: keyOf.size + 1, [GROUND]: keyOf.size + 2 };
    const names = [...keyOf.keys(), "(not in the object list)", "(distant scenery, lod1)", "Ground (heightmap)"];
    const key = owner => owner >= 0 ? objKey[owner] : special[owner];

    const rows = names.map(name => ({ name, parts: [], instances: new Set(), triangles: 0 }));
    for (const src of sources) {
        const tris = src.indices.length / 3;
        const counts = new Uint32Array(names.length);
        for (let t = 0; t < tris; t++) counts[key(src.owners[t])]++;
        const parts = Array.from(counts, n => n ? { kind: src.kind, positions: src.positions,
                                                      indices: new Uint32Array(n * 3), owners: new Int32Array(n),
                                                      ...(src.surfaces ? { surfaces: new Uint16Array(n) } : {}), fill: 0 } : null);
        for (let t = 0; t < tris; t++) {
            const owner = src.owners[t], part = parts[key(owner)], k = part.fill++;
            part.indices[k * 3] = src.indices[t * 3];
            part.indices[k * 3 + 1] = src.indices[t * 3 + 1];
            part.indices[k * 3 + 2] = src.indices[t * 3 + 2];
            part.owners[k] = owner;
            if (part.surfaces) part.surfaces[k] = src.surfaces[t];
        }
        parts.forEach((part, i) => {
            if (!part) return;
            delete part.fill;
            rows[i].parts.push(part);
            rows[i].triangles += part.owners.length;
            for (const o of part.owners) if (o >= 0) rows[i].instances.add(o);
        });
    }
    return rows.filter(r => r.parts.length).map(r => ({
        ...r,
        instances: r.instances.size,
        category: r.name.startsWith("(") || r.name.startsWith("Ground (") ? "Other" : r.name.replace(/^Dm_/, "").split("_")[0],
    }));
}

// ---- Static compound -------------------------------------------------------
// compound/manifest.json + tiles: the map's baked static collision (every
// static actor's shape, which objmap lists as "skipped" in collision.bin, plus
// the field's heightmap ground). Tiles are meshopt-compressed (as in glTF's
// EXT_meshopt_compression):
//   u32 vertexCount, u32 triangleCount, u32 vertexBytes,
//   ATTRIBUTES stream (8 bytes per vertex: u16 x, y, z over the tile's
//   box_min..box_max, u16 "ground object" flag), TRIANGLES index stream
// The manifest's terrain.bin (objmap's decimated ground to drape its map image
// on, not game collision) is not used.
// *.bodies.bin: u32 bodyCount, u32 runCount, u64 hashIds[bodyCount], one byte
// per body (padded to 4), then (u32 triangles, u32 body)[runCount]. The body
// byte's meaning is unknown: 2 on many actor-type Obj_ (pullable gravestones,
// chests, Gossip Stones, crack walls), 6 on Land_ pieces, the ground and other
// Obj_, 7 on a few of both. Ocarina jumps seem to need byte 2 (and neither
// Bakeable nor IsNotTurnToActor), so it is shown in the selection info.

function decodeTile(buf, boxMin, boxMax) {
    const dv = new DataView(buf);
    const vc = dv.getUint32(0, true), tc = dv.getUint32(4, true), vBytes = dv.getUint32(8, true);
    const verts = new Uint8Array(vc * 8);
    MeshoptDecoder.decodeGltfBuffer(verts, vc, 8, new Uint8Array(buf, 12, vBytes), 'ATTRIBUTES');
    const wide = vc > 65536;
    const idx = new Uint8Array(tc * 3 * (wide ? 4 : 2));
    MeshoptDecoder.decodeGltfBuffer(idx, tc * 3, wide ? 4 : 2, new Uint8Array(buf, 12 + vBytes), 'TRIANGLES');
    const q = new Uint16Array(verts.buffer);
    const positions = new Float32Array(vc * 3);
    for (let v = 0; v < vc; v++)
        for (let k = 0; k < 3; k++)
            positions[v * 3 + k] = (boxMin[k] + q[v * 4 + k] / 65535 * Math.max(boxMax[k] - boxMin[k], 1e-6)) * OOTSW2_SCALE;
    return { positions, indices: wide ? new Uint32Array(idx.buffer) : new Uint16Array(idx.buffer) };
}

function parseBodies(buf) {
    if (!buf) return null;
    const dv = new DataView(buf);
    const n = dv.getUint32(0, true), runs = dv.getUint32(4, true);
    const hashIds = [];
    for (let i = 0; i < n; i++) {
        const h = dv.getBigUint64(8 + i * 8, true);
        hashIds.push(h ? '0x' + h.toString(16).padStart(16, '0') : null);
    }
    const bodyBytes = new Uint8Array(buf.slice(8 + n * 8, 8 + n * 8 + n));
    const p = 8 + n * 8 + Math.ceil(n / 4) * 4;
    const runEnds = new Uint32Array(runs), runBodies = new Uint32Array(runs);
    let end = 0;
    for (let r = 0; r < runs; r++) {
        end += dv.getUint32(p + r * 8, true);
        runEnds[r] = end;
        runBodies[r] = dv.getUint32(p + r * 8 + 4, true);
    }
    return { hashIds, bodyBytes, runEnds, runBodies };
}

// ---- romfs-1 tiles (tools/ootsw2/extract_romfs.py, read from a romfs dump) --
// <tile>.tile.bin.gz, gzip'd, little endian:
//   "OOTC", u32 version 1, u32 vertexCount, u32 triangleCount, u32 bodyCount,
//   f32 xyz[vertexCount] (metres, world), u32 indices[triangleCount * 3],
//   u16 body[triangleCount] (0xFFFF: the ground), u16 surface[triangleCount]
//   (manifest.surfaces index, 0xFFFF: unknown), u8 layer[triangleCount]
//   (manifest.layers: 0 ground, 1 static, 2 detail copy, 3 baked areas), pad
//   to 8, u64 hashIds[bodyCount], u8 bodyByte[bodyCount].
// manifest.surfaces: [{ m: material, s: sub material, t: [user shape tags] }]
async function gunzip(buf) {
    const b = new Uint8Array(buf);
    if (b[0] !== 0x1f || b[1] !== 0x8b) return buf;   // already decoded (Content-Encoding: gzip)
    return new Response(new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
}

function decodeRomfsTile(buf) {
    const dv = new DataView(buf);
    if (new TextDecoder().decode(new Uint8Array(buf, 0, 4)) !== 'OOTC') throw new Error('not an OOTC tile');
    const vc = dv.getUint32(8, true), tc = dv.getUint32(12, true), bc = dv.getUint32(16, true);
    let p = 20;
    const raw = new Float32Array(buf.slice(p, p + vc * 12)); p += vc * 12;
    const positions = raw.map(v => v * OOTSW2_SCALE);
    const indices = new Uint32Array(buf.slice(p, p + tc * 12)); p += tc * 12;
    const triBody = new Uint16Array(buf.slice(p, p + tc * 2)); p += tc * 2;
    const surfaces = new Uint16Array(buf.slice(p, p + tc * 2)); p += tc * 2;
    const layers = new Uint8Array(buf.slice(p, p + tc)); p += tc;
    p += -p & 7;
    const hashIds = [];
    for (let i = 0; i < bc; i++) hashIds.push('0x' + dv.getBigUint64(p + i * 8, true).toString(16).padStart(16, '0'));
    const bodyBytes = new Uint8Array(buf.slice(p + bc * 8, p + bc * 9));
    return { positions, indices, surfaces, layers, bodies: { hashIds, bodyBytes, triBody } };
}

// Tiles that overlap the map's play area (maps.json bounds, +100 m) at full
// detail (lod0), the far scenery at lod1. romfs-1 manifests have one level.
// -> { chunks: [{ positions, indices, bodies, name, level, surfaces?, layers? }], manifest } or null
export async function loadOOTSW2Compound(dirUrl, bounds) {
    const manifest = await fetch(`${dirUrl}/manifest.json`).then(r => r.ok ? r.json() : null).catch(() => null);
    if (!manifest) return null;
    const get = f => fetch(`${dirUrl}/${f}`).then(r => r.ok ? r.arrayBuffer() : null).catch(() => null);
    if (manifest.format === 'romfs-1') {
        const chunks = await Promise.all(manifest.tiles.map(async t => {
            const buf = await get(t.file);
            return buf ? { ...decodeRomfsTile(await gunzip(buf)), name: t.name, level: 0 } : null;
        }));
        return { chunks: chunks.filter(Boolean), manifest };
    }
    await MeshoptDecoder.ready;
    const near = t => !manifest.tiled || !bounds || (t.box_max[0] > bounds[0] - 100 && t.box_min[0] < bounds[1] + 100 &&
                                                       t.box_max[2] > bounds[2] - 100 && t.box_min[2] < bounds[3] + 100);
    const chunks = await Promise.all(manifest.tiles.map(async t => {
        const level = near(t) ? 0 : Math.min(1, t.lods.length - 1);
        const [buf, bodiesBuf] = await Promise.all([get(t.lods[level].file), level === 0 ? get(t.bodies.file) : null]);
        if (!buf) return null;
        return { ...decodeTile(buf, t.box_min, t.box_max), bodies: parseBodies(bodiesBuf), name: t.name, level };
    }));
    return { chunks: chunks.filter(Boolean), manifest };
}

// Merges the compound's chunks into one source for groupOOTSW2ByActor: one
// vertex buffer, and each triangle's object (from the tile's bodies; lod1
// tiles have none and count as DISTANT).
// -> { kind: "static", positions, indices, owners, bodyBytes: Map(object index -> Set of body bytes),
//      height(object index): its static collision's height in metres (0 if it has none),
//      surfaces, layers (romfs-1 only: per-triangle manifest.surfaces / manifest.layers indices) }
export function mergeOOTSW2Compound(compound, objects) {
    const byHash = new Map(objects.map((o, i) => [o.h, i]));
    const chunks = compound.chunks;
    let vTotal = 0, tTotal = 0;
    for (const c of chunks) { vTotal += c.positions.length / 3; tTotal += c.indices.length / 3; }
    const positions = new Float32Array(vTotal * 3);
    const indices = new Uint32Array(tTotal * 3);
    const owners = new Int32Array(tTotal);
    const romfs = chunks.length > 0 && chunks.every(c => c.surfaces);
    const surfaces = romfs ? new Uint16Array(tTotal) : null, layers = romfs ? new Uint8Array(tTotal) : null;
    const bodyBytes = new Map();
    let v0 = 0, t0 = 0;
    for (const c of chunks) {
        positions.set(c.positions, v0 * 3);
        for (let k = 0; k < c.indices.length; k++) indices[t0 * 3 + k] = c.indices[k] + v0;
        const tris = c.indices.length / 3;
        if (romfs) {
            surfaces.set(c.surfaces, t0);
            layers.set(c.layers, t0);
        }
        if (c.bodies?.triBody) {
            // romfs-1: a body per triangle; 0xFFFF is the tile's ground
            const ids = c.bodies.hashIds.map(h => byHash.get(h) ?? NO_OBJECT);
            ids.forEach((owner, b) => {
                if (owner < 0) return;
                if (!bodyBytes.has(owner)) bodyBytes.set(owner, new Set());
                bodyBytes.get(owner).add(c.bodies.bodyBytes[b]);
            });
            const tb = c.bodies.triBody;
            for (let t = 0; t < tris; t++) owners[t0 + t] = tb[t] === 0xFFFF ? GROUND : ids[tb[t]] ?? NO_OBJECT;
        } else if (c.level > 0 || !c.bodies) {
            owners.fill(c.level > 0 ? DISTANT : NO_OBJECT, t0, t0 + tris);
        } else {
            // a body without a hash id is the field's heightmap ground
            const ids = c.bodies.hashIds.map(h => h ? byHash.get(h) ?? NO_OBJECT : GROUND);
            ids.forEach((owner, b) => {
                if (owner < 0) return;
                if (!bodyBytes.has(owner)) bodyBytes.set(owner, new Set());
                bodyBytes.get(owner).add(c.bodies.bodyBytes[b]);
            });
            let start = 0;
            c.bodies.runEnds.forEach((end, r) => {
                owners.fill(ids[c.bodies.runBodies[r]], t0 + start, t0 + Math.min(end, tris));
                start = end;
            });
            if (start < tris) owners.fill(NO_OBJECT, t0 + start, t0 + tris);
        }
        v0 += c.positions.length / 3;
        t0 += tris;
    }
    const lo = new Float32Array(objects.length).fill(Infinity), hi = new Float32Array(objects.length).fill(-Infinity);
    for (let t = 0; t < tTotal; t++) {
        const o = owners[t];
        if (o < 0) continue;
        for (let c = 0; c < 3; c++) {
            const y = positions[indices[t * 3 + c] * 3 + 1];
            if (y < lo[o]) lo[o] = y;
            if (y > hi[o]) hi[o] = y;
        }
    }
    const height = o => hi[o] >= lo[o] ? (hi[o] - lo[o]) / OOTSW2_SCALE : 0;
    return { kind: "static", positions, indices, owners, bodyBytes, height,
             ...(romfs ? { surfaces, layers } : {}) };
}

// "Stone, sub Hard: Slip, NoStick" for a manifest.surfaces entry
export function describeOOTSW2Surface(s) {
    if (!s) return 'surface unknown';
    return `${s.m}${s.s ? ` (${s.s})` : ''}${s.t?.length ? ': ' + s.t.join(', ') : ''}`;
}

// ids[k] for a row built from typed arrays, worked out when read (selection,
// Go to poly) instead of one string per triangle up front.
export function lazyTriangleIds(count, label) {
    return new Proxy([], {
        get(target, prop) {
            if (prop === 'length') return count;
            if (typeof prop === 'string' && /^\d+$/.test(prop)) return +prop < count ? label(+prop) : undefined;
            return Reflect.get(target, prop);
        },
    });
}

// One BufferAttribute per position array, so the many meshes cut from one
// source (an actor row each) share a single GPU buffer.
const sharedPositions = new WeakMap();

// A plain collision mesh from typed arrays (buildGeometry wants arrays of
// arrays and builds a wireframe, too much for millions of triangles). The
// bounds cover only the vertices `indices` uses. opacity < 1: a see-through
// volume (areas, loading zones) that doesn't hide what is behind it.
export function buildOOTSW2Mesh(positions, indices, color, opacity = 1) {
    let attr = sharedPositions.get(positions);
    if (!attr) sharedPositions.set(positions, attr = new THREE.BufferAttribute(positions, 3));
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', attr);
    geom.setIndex(new THREE.BufferAttribute(indices, 1));
    const box = new THREE.Box3(), v = new THREE.Vector3();
    for (let k = 0; k < indices.length; k++) box.expandByPoint(v.fromArray(positions, indices[k] * 3));
    geom.boundingBox = box;
    geom.boundingSphere = box.getBoundingSphere(new THREE.Sphere());
    return new THREE.Mesh(geom, new THREE.MeshLambertMaterial({
        color, side: THREE.DoubleSide, flatShading: true,
        polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1,
        transparent: opacity < 1, opacity, depthWrite: opacity >= 1,
    }));
}

// The "Draw triangle/cube edges" object for meshes from buildOOTSW2Mesh:
// wireframe meshes sharing their geometry (three.js builds the edge index
// only once they are drawn), instead of buildGeometry's LineSegments copy.
const edgeMaterial = new THREE.MeshBasicMaterial({ color: 0x3240a8, wireframe: true, transparent: true, opacity: 0.8 });
export function buildOOTSW2Edges(meshes) {
    const group = new THREE.Group();
    for (const mesh of meshes) {
        const edges = new THREE.Mesh(mesh.geometry, edgeMaterial);
        edges.userData.unselectable = true;
        group.add(edges);
    }
    return group;
}

// One point per placed object, for the "Objects" row
export function buildOOTSW2ObjectPoints(objects) {
    const pos = new Float32Array(objects.length * 3);
    objects.forEach((o, i) => pos.set(o.p.map(v => v * OOTSW2_SCALE), i * 3));
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    return new THREE.Points(geom, new THREE.PointsMaterial({ color: 0xffd040, size: 6, sizeAttenuation: false }));
}
