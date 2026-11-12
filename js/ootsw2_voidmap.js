// Ocarina of Time (Switch 2) void probe, offline.
//
// The game decides void-outs with a probe that does NOT hit the collision
// triangles: it casts 64 rays (a golden spiral, a few per frame) from Link
// into a grid of 1 m cubes, keeps the nearest hit, and voids Link once he is
// 8 m or more sideways from that point. The cubes are the game's VolumeStats
// voxels (Phive/VolumeStats/*.bpvsts, decoded by tools/ootsw2/volumestats.py
// into models/OOTSW2/<dir>/voxels.bin.gz). The probe itself follows the
// shared oottools mod's voidmap.cpp (the game's own ray, run in game), which
// this reproduces on the decoded cubes.
import * as THREE from 'three';
import { OOTSW2_SCALE } from './ootsw2_map.js';

export const VOID_RADIUS = 8;     // main+0x5fb1d4: a fixed 8.0
const GOLDEN_ANGLE = 3.8832221;
const RAYS = 64;
const RAY_LENGTH = 5000;

async function gunzip(buf) {
    const b = new Uint8Array(buf);
    if (b[0] !== 0x1f || b[1] !== 0x8b) return buf;
    return new Response(new Blob([buf]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
}

// voxels.bin.gz -> { base: [tile], variants: Map(name -> [tile]) } or null.
// tile: { key, voxels: Int16Array of x, y, z cube corners (metres), and per
// cube (version 2): probe (face bits the void probe can hit), flags, room, dist }.
export async function loadOOTSW2Voxels(url) {
    const res = await fetch(url).catch(() => null);
    if (!res?.ok) return null;
    const buf = await gunzip(await res.arrayBuffer());
    const dv = new DataView(buf);
    if (new TextDecoder().decode(new Uint8Array(buf, 0, 4)) !== 'OVOX') return null;
    const version = dv.getUint32(4, true);
    const count = dv.getUint32(8, true);
    const dec = new TextDecoder();
    let p = 12;
    const str = () => {
        const n = dv.getUint16(p, true);
        const s = dec.decode(new Uint8Array(buf, p + 2, n));
        p += 2 + n;
        return s;
    };
    const base = [], variants = new Map();
    for (let i = 0; i < count; i++) {
        const variant = str(), key = str();
        const n = dv.getUint32(p, true);
        const tile = { key, voxels: new Int16Array(buf.slice(p + 4, p + 4 + n * 6)) };
        p += 4 + n * 6;
        if (version >= 2) {
            for (const k of ['probe', 'flags', 'room', 'dist']) {
                tile[k] = new Uint8Array(buf.slice(p, p + n));
                p += n;
            }
        } else {
            tile.probe = new Uint8Array(n).fill(0x3f);
        }
        if (!variant) base.push(tile);
        else {
            if (!variants.has(variant)) variants.set(variant, []);
            variants.get(variant).push(tile);
        }
    }
    return { base, variants };
}

// The tiles in effect: the base tiles, with the chosen story state's tiles
// replacing the base tile of the same key.
export function activeVoxelTiles(data, variant) {
    const tiles = new Map(data.base.map(t => [t.key, t]));
    for (const t of data.variants.get(variant) ?? []) tiles.set(t.key, t);
    return [...tiles.values()];
}

// Probe face bits per cube in 16^3 chunks (0: no cube; else 0x40 | faces),
// for fast lookups along rays.
export class VoxelSet {
    constructor(tiles) {
        this.chunks = new Map();
        this.lo = [Infinity, Infinity, Infinity];
        this.hi = [-Infinity, -Infinity, -Infinity];
        this.count = 0;
        for (const t of tiles) {
            const v = t.voxels;
            for (let i = 0, k = 0; i < v.length; i += 3, k++) this.add(v[i], v[i + 1], v[i + 2], t.probe[k]);
        }
    }
    static key(cx, cy, cz) { return ((cx + 512) * 1024 + (cy + 512)) * 1024 + (cz + 512); }
    add(x, y, z, faces) {
        const k = VoxelSet.key(x >> 4, y >> 4, z >> 4);
        let c = this.chunks.get(k);
        if (!c) this.chunks.set(k, c = new Uint8Array(4096));
        const i = ((x & 15) << 8) | ((y & 15) << 4) | (z & 15);
        if (!c[i]) this.count++;
        c[i] = 0x40 | (faces & 0x3f);
        const p = [x, y, z];
        for (let k2 = 0; k2 < 3; k2++) {
            if (p[k2] < this.lo[k2]) this.lo[k2] = p[k2];
            if (p[k2] + 1 > this.hi[k2]) this.hi[k2] = p[k2] + 1;
        }
    }
    // 0: no cube, else 0x40 | the probe face bits
    get(x, y, z) {
        const c = this.chunks.get(VoxelSet.key(x >> 4, y >> 4, z >> 4));
        return c ? c[((x & 15) << 8) | ((y & 15) << 4) | (z & 15)] : 0;
    }

    // First cube face along the ray the probe can hit (Amanatides-Woo): a
    // ray entering a cube along axis a, direction s, hits it only when the
    // cube's face bit 2a + (s > 0) is set (the game's own test). The cube the
    // ray starts in doesn't count. -> distance t, or -1 when nothing is hit.
    cast(ox, oy, oz, dx, dy, dz, maxT = RAY_LENGTH) {
        const o = [ox, oy, oz], d = [dx, dy, dz];
        let tmin = 0, tmax = maxT;
        for (let k = 0; k < 3; k++) {
            if (Math.abs(d[k]) < 1e-12) {
                if (o[k] < this.lo[k] || o[k] > this.hi[k]) return -1;
                continue;
            }
            let t0 = (this.lo[k] - o[k]) / d[k], t1 = (this.hi[k] - o[k]) / d[k];
            if (t0 > t1) [t0, t1] = [t1, t0];
            if (t0 > tmin) tmin = t0;
            if (t1 < tmax) tmax = t1;
        }
        if (tmin > tmax) return -1;
        const cell = [0, 0, 0], step = [0, 0, 0], tnext = [0, 0, 0], tdelta = [0, 0, 0];
        for (let k = 0; k < 3; k++) {
            const p = o[k] + d[k] * (tmin + 1e-6);
            cell[k] = Math.floor(p);
            step[k] = d[k] > 0 ? 1 : d[k] < 0 ? -1 : 0;
            tnext[k] = step[k] ? ((step[k] > 0 ? cell[k] + 1 : cell[k]) - o[k]) / d[k] : Infinity;
            tdelta[k] = step[k] ? Math.abs(1 / d[k]) : Infinity;
        }
        let t = tmin;
        // a ray clipped to the cubes' box enters through the clip face
        let face = -1;
        if (tmin > 0) {
            for (let k = 0; k < 3; k++) {
                if (!step[k]) continue;
                const plane = step[k] > 0 ? this.lo[k] : this.hi[k];
                if (Math.abs((plane - o[k]) / d[k] - tmin) < 1e-6) face = 2 * k + (step[k] > 0 ? 1 : 0);
            }
        }
        while (t <= tmax) {
            if (face >= 0) {
                const v = this.get(cell[0], cell[1], cell[2]);
                if (v && (v >> face) & 1) return t;
            }
            const a = tnext[0] < tnext[1] ? (tnext[0] < tnext[2] ? 0 : 2) : (tnext[1] < tnext[2] ? 1 : 2);
            t = tnext[a];
            cell[a] += step[a];
            tnext[a] += tdelta[a];
            face = 2 * a + (step[a] > 0 ? 1 : 0);
        }
        return -1;
    }
}

let dirs = null;
function probeDirs() {
    if (dirs) return dirs;
    dirs = [];
    for (let i = 0; i < RAYS; i++) {
        const y = 1 - (2 * i + 1) / RAYS, r = Math.sin(Math.acos(y)), a = i * GOLDEN_ANGLE;
        const v = [Math.cos(a) * r, y, Math.sin(a) * r], n = Math.hypot(...v);
        dirs.push(v.map(c => c / n));
    }
    return dirs;
}

// The probe at one point (metres) -> { sideways (-1: no hit), distance, hit: [x, y, z] | null }
export function voidProbe(set, x, y, z) {
    let best = Infinity, hit = null;
    for (const [dx, dy, dz] of probeDirs()) {
        const t = set.cast(x, y, z, dx, dy, dz);
        if (t >= 0 && t < best) { best = t; hit = [x + dx * t, y + dy * t, z + dz * t]; }
    }
    return hit ? { sideways: Math.hypot(hit[0] - x, hit[2] - z), distance: best, hit } : { sideways: -1, distance: -1, hit: null };
}

// Ways to colour the cubes: [key, label, colour(tile, i) -> '#rrggbb' or null (not drawn), legend]
const ROOM_COLORS = ['#e6194b', '#3cb44b', '#ffe119', '#4363d8', '#f58231', '#911eb4', '#46f0f0', '#f032e6',
                     '#bcf60c', '#fabebe', '#008080', '#e6beff', '#9a6324', '#fffac8', '#800000', '#aaffc3'];
const flag = (bit, color) => (t, i) => t.flags && (t.flags[i] & bit) ? color : null;
export const CUBE_VIEWS = [
    ['probe', 'void probe faces', (t, i) => t.probe[i] ? '#3ce6ff' : '#5a6470',
     [['probe can hit it', '#3ce6ff'], ['probe passes through', '#5a6470']]],
    ['water', 'in water', flag(1, '#3c78e6'), [['in water', '#3c78e6']]],
    ['surface', 'water surface', flag(2, '#9fd4ff'), [['water surface', '#9fd4ff']]],
    ['indoor', 'indoor', flag(4, '#f0a040'), [['indoor', '#f0a040']]],
    ['hiding', 'hiding hole', flag(8, '#c070ff'), [['hiding hole', '#c070ff']]],
    ['outside', 'outside outer boundary', flag(16, '#ff4060'), [['outside the outer boundary', '#ff4060']]],
    ['dist', 'outer boundary distance', (t, i) => {
        const d = t.dist?.[i];
        if (d === undefined || d === 255) return null;
        return '#' + new THREE.Color().setHSL(0.33 * d / 15, 0.85, 0.5).getHexString();
    }, [['0 (at the boundary)', '#e61919'], ['15 (far inside)', '#19e619']]],
    ['room', 'dungeon room', (t, i) => {
        const r = t.room?.[i];
        return r === undefined || r === 255 ? null : ROOM_COLORS[r % ROOM_COLORS.length];
    }, [['one colour per room id', '#e6194b']]],
];

// Which views have any cube on this map
export function availableCubeViews(tiles) {
    return CUBE_VIEWS.filter(([, , colorOf]) => tiles.some(t => {
        for (let i = 0; i < t.probe.length; i++) if (colorOf(t, i)) return true;
        return false;
    }));
}

// The cubes' tops as coloured points (viewer units), for one view; click info
// lists the cube's attributes.
export function buildVoxelPoints(tiles, view = 'probe') {
    const colorOf = (CUBE_VIEWS.find(v => v[0] === view) ?? CUBE_VIEWS[0])[2];
    const pos = [], col = [], refs = [];
    const c = new THREE.Color();
    for (const t of tiles) {
        const v = t.voxels;
        for (let i = 0; i < t.probe.length; i++) {
            const hex = colorOf(t, i);
            if (!hex) continue;
            c.set(hex);
            pos.push((v[i * 3] + 0.5) * OOTSW2_SCALE, (v[i * 3 + 1] + 1) * OOTSW2_SCALE, (v[i * 3 + 2] + 0.5) * OOTSW2_SCALE);
            col.push(c.r, c.g, c.b);
            refs.push([t, i]);
        }
    }
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(new Float32Array(pos), 3));
    geom.setAttribute('color', new THREE.BufferAttribute(new Float32Array(col), 3));
    const points = new THREE.Points(geom, new THREE.PointsMaterial({ vertexColors: true, size: 3, sizeAttenuation: false }));
    points.userData.unselectable = true;
    points.userData.count = refs.length;
    return points;
}

export const VOID_COLORS = { safe: '#3caa5a', near: '#dcbe28', void: '#d25050', none: '#6e1414' };
const voidKind = s => s.sideways < 0 ? 'none' : s.sideways < 6 ? 'safe' : s.sideways < VOID_RADIUS ? 'near' : 'void';

// Whole map: the probe at every walkable floor spot. src: a static collision
// source (viewer units: positions, indices, layers?), floor = triangles facing
// up (normal y > 0.7) on the static layers; one sample per step x step metres
// column and floor level (1.5 m apart in height), at the floor's height.
// keep(t): extra triangle filter. Runs in slices; onProgress(done, total).
// -> { points (coloured squares on the floor), counts, samples }
export async function buildFloorVoidMap(set, src, step, keep = () => true, onProgress = () => {}) {
    const S = OOTSW2_SCALE, P = src.positions, I = src.indices;
    const seen = new Map(), samples = [];
    const tris = I.length / 3;
    for (let t = 0; t < tris; t++) {
        if (src.layers && src.layers[t] > 1) continue;
        const a = I[t * 3] * 3, b = I[t * 3 + 1] * 3, c = I[t * 3 + 2] * 3;
        const ux = P[b] - P[a], uy = P[b + 1] - P[a + 1], uz = P[b + 2] - P[a + 2];
        const vx = P[c] - P[a], vy = P[c + 1] - P[a + 1], vz = P[c + 2] - P[a + 2];
        const nx = uy * vz - uz * vy, ny = uz * vx - ux * vz, nz = ux * vy - uy * vx;
        const len = Math.hypot(nx, ny, nz);
        if (!len || Math.abs(ny) / len < 0.7 || !keep(t)) continue;
        // sample the triangle on the step grid (its centroid for small ones)
        const xs = [P[a], P[b], P[c]].map(v => v / S), ys = [P[a + 1], P[b + 1], P[c + 1]].map(v => v / S),
              zs = [P[a + 2], P[b + 2], P[c + 2]].map(v => v / S);
        const pts = [[(xs[0] + xs[1] + xs[2]) / 3, (ys[0] + ys[1] + ys[2]) / 3, (zs[0] + zs[1] + zs[2]) / 3]];
        const x0 = Math.min(...xs), x1 = Math.max(...xs), z0 = Math.min(...zs), z1 = Math.max(...zs);
        if (x1 - x0 > step || z1 - z0 > step) {
            // barycentric test over the grid points inside the triangle's box
            const d = (zs[1] - zs[2]) * (xs[0] - xs[2]) + (xs[2] - xs[1]) * (zs[0] - zs[2]);
            for (let gx = Math.ceil(x0 / step) * step; gx <= x1; gx += step) {
                for (let gz = Math.ceil(z0 / step) * step; gz <= z1; gz += step) {
                    const l0 = ((zs[1] - zs[2]) * (gx - xs[2]) + (xs[2] - xs[1]) * (gz - zs[2])) / d;
                    const l1 = ((zs[2] - zs[0]) * (gx - xs[2]) + (xs[0] - xs[2]) * (gz - zs[2])) / d;
                    const l2 = 1 - l0 - l1;
                    if (l0 < 0 || l1 < 0 || l2 < 0) continue;
                    pts.push([gx, l0 * ys[0] + l1 * ys[1] + l2 * ys[2], gz]);
                }
            }
        }
        for (const [x, y, z] of pts) {
            // only the play area: within the void radius of the cubes' box
            // (the compound also holds the distant scenery, with no cubes)
            if (x < set.lo[0] - VOID_RADIUS || x > set.hi[0] + VOID_RADIUS || z < set.lo[2] - VOID_RADIUS ||
                z > set.hi[2] + VOID_RADIUS || y < set.lo[1] - VOID_RADIUS || y > set.hi[1] + VOID_RADIUS) continue;
            const key = `${Math.floor(x / step)},${Math.floor(z / step)},${Math.floor(y / 1.5)}`;
            if (seen.has(key)) continue;
            seen.set(key, true);
            samples.push({ x, y, z, owner: src.owners?.[t] ?? -1 });
        }
    }
    const total = samples.length;
    for (let k = 0; k < total; k++) {
        const s = samples[k];
        Object.assign(s, voidProbe(set, s.x, s.y + 0.05, s.z));
        if (k % 2000 === 1999) {
            onProgress(k + 1, total);
            await new Promise(r => setTimeout(r, 0));
        }
    }
    onProgress(total, total);
    const counts = { safe: 0, near: 0, void: 0, none: 0 };
    const pos = new Float32Array(total * 3), col = new Float32Array(total * 3);
    const c = new THREE.Color();
    samples.forEach((s, k) => {
        const kind = voidKind(s);
        counts[kind]++;
        c.set(VOID_COLORS[kind]);
        pos.set([s.x * S, (s.y + 0.15) * S, s.z * S], k * 3);
        col.set([c.r, c.g, c.b], k * 3);
    });
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geom.setAttribute('color', new THREE.BufferAttribute(col, 3));
    const points = new THREE.Points(geom, new THREE.PointsMaterial({ vertexColors: true, size: step * S * 0.9, sizeAttenuation: true }));
    points.userData.unselectable = true;
    return { points, counts, samples };
}

// A void map: side x side points `step` metres apart around (cx, cz) at height y.
// Runs in slices so the page stays responsive; onProgress(done, total).
// -> { group (squares + hit points, viewer units), counts }
export async function buildVoidMap(set, cx, y, cz, step, side, onProgress = () => {}) {
    const total = side * side, half = (side - 1) / 2;
    const samples = [];
    for (let j = 0; j < side; j++) {
        for (let i = 0; i < side; i++) {
            const x = cx + (i - half) * step, z = cz + (j - half) * step;
            samples.push({ x, z, ...voidProbe(set, x, y, z) });
        }
        onProgress(samples.length, total);
        await new Promise(r => setTimeout(r, 0));
    }
    const counts = { safe: 0, near: 0, void: 0, none: 0 };
    const kindOf = voidKind;
    const pos = new Float32Array(total * 18), col = new Float32Array(total * 18);
    const S = OOTSW2_SCALE, h = step * 0.45 * S, Y = y * S;
    samples.forEach((s, k) => {
        const kind = kindOf(s);
        counts[kind]++;
        const c = new THREE.Color(VOID_COLORS[kind]);
        const x = s.x * S, z = s.z * S;
        const quad = [[x - h, z - h], [x + h, z - h], [x + h, z + h], [x - h, z - h], [x + h, z + h], [x - h, z + h]];
        quad.forEach(([qx, qz], v) => {
            pos.set([qx, Y, qz], k * 18 + v * 3);
            col.set([c.r, c.g, c.b], k * 18 + v * 3);
        });
    });
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    geom.setAttribute('color', new THREE.BufferAttribute(col, 3));
    const squares = new THREE.Mesh(geom, new THREE.MeshBasicMaterial({
        vertexColors: true, side: THREE.DoubleSide, transparent: true, opacity: 0.55, depthWrite: false }));
    squares.renderOrder = 3;
    // squares: click info per triangle (two per sample)
    geom.userData.triangleIds = new Proxy([], {
        get(target, prop) {
            if (prop === 'length') return total * 2;
            if (typeof prop === 'string' && /^\d+$/.test(prop)) {
                const s = samples[Math.floor(+prop / 2)];
                if (!s) return undefined;
                return `Void probe at ${s.x.toFixed(1)}, ${y.toFixed(1)}, ${s.z.toFixed(1)}: ` + (s.hit
                    ? `nearest cube ${s.distance.toFixed(2)} m away, ${s.sideways.toFixed(2)} m sideways` +
                      (s.sideways >= VOID_RADIUS ? ' -> void' : '') : 'no cube hit -> void');
            }
            return Reflect.get(target, prop);
        },
    });
    const hits = samples.filter(s => s.hit);
    const hp = new Float32Array(hits.length * 3);
    hits.forEach((s, k) => hp.set(s.hit.map(v => v * S), k * 3));
    const hg = new THREE.BufferGeometry();
    hg.setAttribute('position', new THREE.BufferAttribute(hp, 3));
    const hitPoints = new THREE.Points(hg, new THREE.PointsMaterial({ color: 0xffffff, size: 4, sizeAttenuation: false, depthTest: false }));
    hitPoints.renderOrder = 4;
    hitPoints.userData.unselectable = true;
    const group = new THREE.Group();
    group.add(squares, hitPoints);
    return { group, counts };
}
