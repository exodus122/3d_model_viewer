import * as THREE from 'three';
import { addModelCheckbox } from './render.js';
import { OVERLAY_RENDER_ORDER } from './bk_textured.js';

////////////////////////////////////////
// BK / BT bitclip edges
////////////////////////////////////////
//
// A bitclip is a spot on the seam between two collision triangles that
// neither triangle claims: the game's point-in-triangle test is done in f32,
// and the rounding can put a point that is on the surface (in exact
// arithmetic) outside every triangle there. A floor probe at that spot falls
// straight through. See banjo_wall_bitclip_searcher.cpp for the original
// single-seam search.
//
// The test replicated here is the one in collisionList_intersectLine
// (core2/code_5FD90.c): the triangle is projected onto the plane that drops
// its normal's largest axis (primary_axis), and with d = p - tri[0],
// u = (primary+1)%3, v = (primary+2)%3, ab = tri[1]-tri[0], ac = tri[2]-tri[0]:
//   den = ab_u*ac_v - ab_v*ac_u
//   f1  = (d_u*ac_v - d_v*ac_u) / den    rejected if f1 < 0 || f1 > 1
//   f2  = (ab_u*d_v - ab_v*d_u) / den    rejected if f2 < 0 || f2 > 1
//   rejected if f1 + f2 > 1
// every operation rounded to f32 (Math.fround). tri[0] is the triangle's
// first vertex in the collision list, so the stored winding matters (the
// reversed copies of double-sided triangles must not be used).
//
// Edges are matched by vertex position (the vertex list repeats positions
// with different UVs / colours). The triangles meeting at an edge are
// grouped by kind - floor (primary axis Y, normal up), ceiling (Y, down) or
// wall (X or Z) - since a floor probe never asks a wall. An edge is a
// bitclip edge when, for a kind with at least two triangles on it, some
// point near it is inside one of them in exact arithmetic but rejected by
// every triangle of that kind touching the edge or its two vertices.
//
// Walking every float along an edge (what the .cpp does) is over a hundred
// million tests per edge, so the search samples where the gaps actually are.
// Two roundings make them:
//  - d = p - tri[0] is rounded to f32. Where |p - tri[0]| has a larger
//    exponent than |p| (p near zero, or on the other side of zero from the
//    triangle's first vertex), the triangle sees the point snapped to a
//    coarser grid, and in a band about one grid step wide along the seam a
//    point can be snapped out of both triangles. Those stretches of the edge
//    are worked out exactly (coordinate ranges between powers of two) and
//    sampled with random offsets of up to a grid step.
//  - f1 + f2 > 1 on a triangle's tri[1]-tri[2] edge: near either end of it,
//    one barycentric is tiny and the other is just under 1, and their
//    rounded sum can land above 1. Most common on skinny triangles. Sampled
//    on a log scale towards both ends of the edge, plus evenly along it,
//    each sample stepped a few floats across the seam.
// An edge whose gaps are rarer than the sampling can still be missed.

const COARSE_SAMPLES = 64;   // per snapping stretch
const COARSE_OFFSETS = 8;    // random offsets per sample
const END_SAMPLES = 1024;    // log-spaced towards the two ends
const EVEN_SAMPLES = 256;
const WINDOW = 4;            // floats either side of the seam

const f = Math.fround;

// Per-triangle constants for the inside test.
function prepTri(p0, p1, p2) {
    const ab = [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]];
    const ac = [p2[0] - p0[0], p2[1] - p0[1], p2[2] - p0[2]];
    const n = [
        f(f(ab[1] * ac[2]) - f(ab[2] * ac[1])),
        f(f(ab[2] * ac[0]) - f(ab[0] * ac[2])),
        f(f(ab[0] * ac[1]) - f(ab[1] * ac[0])),
    ];
    let primary = Math.abs(n[0]) > Math.abs(n[1]) ? 0 : 1;
    primary = Math.abs(n[2]) > Math.abs(n[primary]) ? 2 : primary;
    const u = (primary + 1) % 3, v = (primary + 2) % 3;
    return {
        kind: primary !== 1 ? 'wall' : (n[1] > 0 ? 'floor' : 'ceiling'),
        primary, u, v,
        ou: p0[u], ov: p0[v],
        abu: ab[u], abv: ab[v], acu: ac[u], acv: ac[v],
        den: f(f(ab[u] * ac[v]) - f(ab[v] * ac[u])),
    };
}

// The game's test.
function inside(t, p) {
    const du = f(p[t.u] - t.ou);
    const dv = f(p[t.v] - t.ov);
    const f1 = f(f(f(du * t.acv) - f(dv * t.acu)) / t.den);
    if (f1 < 0 || f1 > 1) return false;
    const f2 = f(f(f(t.abu * dv) - f(t.abv * du)) / t.den);
    if (f2 < 0 || f2 > 1) return false;
    return !(f(f1 + f2) > 1);
}

// The same test in doubles, which is exact here (integer vertices, f32 point).
function insideExact(t, p) {
    const du = p[t.u] - t.ou, dv = p[t.v] - t.ov;
    const s = t.den > 0 ? 1 : -1;
    const n1 = (du * t.acv - dv * t.acu) * s;
    const n2 = (t.abu * dv - t.abv * du) * s;
    return n1 >= 0 && n2 >= 0 && n1 + n2 <= t.den * s;
}

// edgeTris: the triangles on the edge (one of them must hold p exactly);
// tris: those plus the same-kind triangles around its two vertices.
function isGap(edgeTris, tris, p) {
    for (const t of tris) {
        if (inside(t, p)) return false;
    }
    return edgeTris.some(t => insideExact(t, p));
}

const exponent = v => (v === 0 ? -150 : Math.floor(Math.log2(Math.abs(v))));
const ulp = v => 2 ** (Math.max(exponent(v), -126) - 23);

// Stretches [x0, x1] of the alignment axis i where some triangle's
// d = p - tri[0] has a larger exponent than p on an axis it uses.
function snappingStretches(a, b, i, d, tris) {
    const out = [];
    for (const t of tris) {
        for (const [c, o] of [[t.u, t.ou], [t.v, t.ov]]) {
            const slope = d[c] / d[i];
            if (slope === 0) {
                if (exponent(a[c] - o) > exponent(a[c])) out.push([a[i], b[i]]);
                continue;
            }
            const c0 = Math.min(a[c], b[c]), c1 = Math.max(a[c], b[c]);
            const cuts = [c0, c1];
            if (c0 < 0 && 0 < c1) cuts.push(0);
            for (let k = -8; k <= 16; k++) {
                for (const v of [2 ** k, -(2 ** k), o + 2 ** k, o - 2 ** k]) {
                    if (v > c0 && v < c1) cuts.push(v);
                }
            }
            cuts.sort((x, y) => x - y);
            for (let n = 0; n + 1 < cuts.length; n++) {
                const lo = cuts[n], hi = cuts[n + 1];
                if (hi <= lo) continue;
                const mid = (lo + hi) / 2;
                // (anything within 2^-8 of zero counts as snapping)
                if (exponent(mid - o) <= Math.max(exponent(mid), -8)) continue;
                const x0 = a[i] + (lo - a[c]) / slope, x1 = a[i] + (hi - a[c]) / slope;
                out.push([Math.min(x0, x1), Math.max(x0, x1)]);
            }
        }
    }
    return out;
}

// True when a gap point was found near the edge a-b.
function edgeHasGap(a, b, edgeTris, tris) {
    const d = [b[0] - a[0], b[1] - a[1], b[2] - a[2]];
    let i = 0;
    if (Math.abs(d[1]) > Math.abs(d[i])) i = 1;
    if (Math.abs(d[2]) > Math.abs(d[i])) i = 2;
    // walk from the lower end of the alignment axis
    if (d[i] < 0) { [a, b] = [b, a]; d[0] = -d[0]; d[1] = -d[1]; d[2] = -d[2]; }
    const lo = a[i], hi = b[i];
    const slope = [d[0] / d[i], d[1] / d[i], d[2] / d[i]];

    // Axes that matter: those some triangle projects onto (floors never
    // look at Y). j is the one stepped across the seam.
    const used = [0, 1, 2].filter(c => tris.some(t => t.primary !== c));
    const j = used.find(c => c !== i);

    // deterministic per edge, so a map always shows the same edges
    let seed = (Math.imul(a[0], 73856093) ^ Math.imul(a[2], 19349663) ^ Math.imul(b[1], 83492791)) >>> 0;
    const rnd = () => (seed = (Math.imul(seed, 1103515245) + 12345) >>> 0) / 4294967296;

    const p = [0, 0, 0], q = [0, 0, 0];
    const onSeam = x => {
        for (let m = 0; m < 3; m++) p[m] = m === i ? x : f(a[m] + slope[m] * (x - lo));
    };
    const windowHasGap = () => {
        const pj = p[j], step = ulp(pj);
        for (let w = -WINDOW; w <= WINDOW; w++) {
            p[j] = f(pj + w * step);
            if (isGap(edgeTris, tris, p)) return true;
        }
        return false;
    };

    for (const [x0, x1] of snappingStretches(a, b, i, d, tris)) {
        for (let s = 0; s < COARSE_SAMPLES; s++) {
            const x = f(x0 + (x1 - x0) * (s + rnd()) / COARSE_SAMPLES);
            if (x <= lo || x >= hi) continue;
            onSeam(x);
            const grid = [0, 0, 0];
            for (const c of used) {
                grid[c] = ulp(p[c]);
                for (const t of tris) {
                    const o = c === t.u ? t.ou : c === t.v ? t.ov : null;
                    if (o !== null) grid[c] = Math.max(grid[c], ulp(f(p[c] - o)));
                }
            }
            for (let r = 0; r < COARSE_OFFSETS; r++) {
                for (let m = 0; m < 3; m++) q[m] = grid[m] ? f(p[m] + (rnd() * 2 - 1) * grid[m]) : p[m];
                if (isGap(edgeTris, tris, q)) return true;
            }
        }
    }

    for (let s = 0; s < END_SAMPLES; s++) {
        const t = 2 ** (-24 + 23 * rnd());
        const x = f(lo + d[i] * ((s & 1) ? 1 - t : t));
        if (x <= lo || x >= hi) continue;
        onSeam(x);
        if (windowHasGap()) return true;
    }

    for (let s = 0; s < EVEN_SAMPLES; s++) {
        const x = f(lo + d[i] * (s + rnd()) / EVEN_SAMPLES);
        if (x <= lo || x >= hi) continue;
        onSeam(x);
        if (windowHasGap()) return true;
    }
    return false;
}

/**
 * The work list for one collision list. positions: flat xyz array;
 * indices: flat triangle list in collision-list order and winding. Each job
 * is one edge with the triangles of one kind on it.
 */
function bitclipJobs(positions, indices) {
    const pos = i => [positions[3 * i], positions[3 * i + 1], positions[3 * i + 2]];
    const posKey = p => p[0] + ',' + p[1] + ',' + p[2];

    const edges = new Map();   // edge key -> { a, b, byKind: { kind: [tri] } }
    const fans = new Map();    // vertex key -> { kind: Set<tri> }
    const seenTris = new Set();
    for (let n = 0; n + 2 < indices.length; n += 3) {
        const ps = [pos(indices[n]), pos(indices[n + 1]), pos(indices[n + 2])];
        const keys = ps.map(posKey);
        if (keys[0] === keys[1] || keys[1] === keys[2] || keys[0] === keys[2]) continue;
        const triKey = [...keys].sort().join('|');
        if (seenTris.has(triKey)) continue; // grid-cell copies / back-to-back twins
        seenTris.add(triKey);

        const tri = prepTri(ps[0], ps[1], ps[2]);
        if (tri.den === 0) continue;
        for (let e = 0; e < 3; e++) {
            const ka = keys[e], kb = keys[(e + 1) % 3];
            const key = ka < kb ? ka + '|' + kb : kb + '|' + ka;
            let edge = edges.get(key);
            if (!edge) {
                edge = { a: ps[e], b: ps[(e + 1) % 3], ka, kb, byKind: {} };
                edges.set(key, edge);
            }
            (edge.byKind[tri.kind] ??= []).push(tri);

            let fan = fans.get(ka);
            if (!fan) fans.set(ka, fan = {});
            (fan[tri.kind] ??= new Set()).add(tri);
        }
    }

    const jobs = [];
    for (const edge of edges.values()) {
        for (const [kind, edgeTris] of Object.entries(edge.byKind)) {
            if (edgeTris.length < 2) continue;
            const tris = new Set(edgeTris);
            for (const k of [edge.ka, edge.kb]) {
                for (const t of fans.get(k)?.[kind] ?? []) tris.add(t);
            }
            jobs.push({ edge, edgeTris, tris: [...tris] });
        }
    }
    return jobs;
}

/**
 * Edges of a collision list that have a bitclip, as a flat array of line
 * segment endpoints (6 numbers per edge). Synchronous; the rows below run
 * the same search in time slices.
 */
export function findBitclipEdges(positions, indices) {
    const out = [];
    const done = new Set();
    for (const job of bitclipJobs(positions, indices)) {
        if (done.has(job.edge) || !edgeHasGap(job.edge.a, job.edge.b, job.edgeTris, job.tris)) continue;
        done.add(job.edge);
        out.push(...job.edge.a, ...job.edge.b);
    }
    return out;
}

////////////////////////////////////////
// Rows
////////////////////////////////////////
//
// The search takes a few seconds on a big map, so a row starts empty and
// searches the first time it is shown, a slice at a time, its edges
// appearing as they are found and its label counting them.

const BITCLIP_COLOR = '#ff00ff';
const SLICE_MS = 25;

/**
 * A row searching a list of collision lists. Each source is
 * { positions, indices, matrices: [THREE.Matrix4 | null] } -- its edges are
 * drawn once per matrix (null: as is).
 */
function makeBitclipRow(scene, name) {
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.Float32BufferAttribute([], 3));
    // Depth tested like the rest of the scene; the meshes are drawn with a
    // polygon offset, so the edges lying in them still show. The plain
    // (Textures off) meshes' wireframe lies exactly on these edges and is
    // drawn in the transparent pass, so these go in that pass too, after it
    // (the collision overlay's edges are OVERLAY_RENDER_ORDER + 1).
    const lines = new THREE.LineSegments(geometry,
        new THREE.LineBasicMaterial({ color: BITCLIP_COLOR, transparent: true }));
    lines.renderOrder = OVERLAY_RENDER_ORDER + 2;
    lines.name = name;
    scene.add(lines);
    loadedModelsNotSelectable.push({ name, mesh: lines, edges: null });
    addModelCheckbox(scene, name, null, lines, false, false, BITCLIP_COLOR);

    const rowEl = [...document.querySelectorAll('.controls .model-row')].find(r => r.dataset.modelName === name);
    const labelText = rowEl?.querySelector('.model-label-text');
    const checkbox = rowEl?.querySelector('.model-label > input[type="checkbox"]');

    const row = { lines, sources: [], points: [], edgeCount: 0, running: false, sourceIndex: 0, jobs: null, jobIndex: 0 };
    const setLabel = text => { if (labelText) labelText.textContent = text; };

    const step = () => {
        if (!lines.parent) { row.running = false; return; } // scene cleared: a new map loaded
        const start = performance.now();
        let found = false;
        while (performance.now() - start < SLICE_MS) {
            const source = row.sources[row.sourceIndex];
            if (!source) break;
            if (!row.jobs) {
                row.jobs = bitclipJobs(source.positions, source.indices);
                row.jobIndex = 0;
                row.doneEdges = new Set();
            }
            const job = row.jobs[row.jobIndex++];
            if (!job) {
                row.jobs = null;
                row.sourceIndex++;
                continue;
            }
            if (row.doneEdges.has(job.edge) || !edgeHasGap(job.edge.a, job.edge.b, job.edgeTris, job.tris)) continue;
            row.doneEdges.add(job.edge);
            const v = new THREE.Vector3();
            for (const m of source.matrices) {
                for (const end of [job.edge.a, job.edge.b]) {
                    v.set(end[0], end[1], end[2]);
                    if (m) v.applyMatrix4(m);
                    row.points.push(v.x, v.y, v.z);
                }
                row.edgeCount++;
            }
            found = true;
        }
        if (found) {
            geometry.setAttribute('position', new THREE.Float32BufferAttribute(row.points, 3));
            geometry.computeBoundingSphere();
        }

        if (row.sourceIndex >= row.sources.length) {
            row.running = false;
            setLabel(`${name} (${row.edgeCount})`);
            console.log(`${name}: ${row.edgeCount} edges`);
            return;
        }
        const part = row.jobs ? row.jobIndex / Math.max(row.jobs.length, 1) : 0;
        setLabel(`${name} (searching ${Math.floor(100 * (row.sourceIndex + part) / row.sources.length)}%)`);
        setTimeout(step, 0);
    };

    row.ensureRunning = () => {
        if (row.running || !lines.visible || row.sourceIndex >= row.sources.length) return;
        row.running = true;
        setTimeout(step, 0);
    };
    checkbox?.addEventListener('change', row.ensureRunning);
    return row;
}

// The map's row is shared by every model file of the map (opa, xlu, BT's
// sectors): each is its own collision list, so each is searched alone, and
// their edges go into the one row.
let mapRow = null;

/**
 * Add one map model's collision list to the "Bitclip Edges" row. fresh:
 * first model of a newly loaded map (the old row went with the scene clear).
 * offset: [x, y, z] translation of the model.
 */
export function addMapBitclipEdges(scene, positions, indices, fresh, offset = null) {
    if (fresh || !mapRow?.lines.parent) mapRow = makeBitclipRow(scene, 'Bitclip Edges');
    const matrix = offset ? new THREE.Matrix4().makeTranslation(offset[0], offset[1], offset[2]) : null;
    mapRow.sources.push({ positions, indices, matrices: [matrix] });
    mapRow.ensureRunning();
}

/**
 * "Actor Bitclip Edges": the bitclip edges of every placed prop / actor whose
 * model has a collision list, at each placement. instances: the setup's
 * { mesh, loaded } prop instances (bk_setup.js's getPropInstances).
 */
export function addActorBitclipEdges(scene, instances) {
    const byModel = new Map(); // loaded -> source
    for (const inst of instances) {
        const geometry = inst.loaded?.collision?.geometry;
        if (!geometry) continue;
        let source = byModel.get(inst.loaded);
        if (!source) {
            source = { positions: geometry.getAttribute('position').array, indices: geometry.getIndex().array, matrices: [] };
            byModel.set(inst.loaded, source);
        }
        inst.mesh.updateWorldMatrix(true, false);
        source.matrices.push(inst.mesh.matrixWorld.clone());
    }
    if (byModel.size === 0) return;
    const row = makeBitclipRow(scene, 'Actor Bitclip Edges');
    row.sources.push(...byModel.values());
    row.ensureRunning();
}
