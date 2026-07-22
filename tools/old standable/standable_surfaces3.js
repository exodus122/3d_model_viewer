import * as THREE from 'three';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { BGCHECK_SUBDIV_OVERLAP } from './subdivisions.js';
import { isSamplePointValid } from './sample_points.js';

////////////////////////////////////////
// System: Standable Surfaces
////////////////////////////////////////
const COLPOLY_NORMAL_FRAC = f32(1.0 / 32767.0);

function clipPolygonByMinY(verts, minY) {
    // verts = [{x,y,z}, ...] any length, in order around the polygon

    const out = [];
    const n = verts.length;

    for (let i = 0; i < n; i++) {
        const a = verts[i];
        const b = verts[(i + 1) % n];

        const aAbove = a.y >= minY;
        const bAbove = b.y >= minY;

        // Case 1: A is above → keep A
        if (aAbove) out.push(a);

        // Case 2: Edge AB crosses the minY plane → add intersection
        if (aAbove !== bAbove) {
            const t = (minY - a.y) / (b.y - a.y);  // param along AB
            out.push({
                x: a.x + (b.x - a.x) * t,
                y: minY,
                z: a.z + (b.z - a.z) * t,
            });
        }
    }

    return out;
}

// Mirror of clipPolygonByMinY, keeping the portion BELOW minY instead.
function clipPolygonBelowMinY(verts, minY) {
    const out = [];
    const n = verts.length;

    for (let i = 0; i < n; i++) {
        const a = verts[i];
        const b = verts[(i + 1) % n];

        const aBelow = a.y < minY;
        const bBelow = b.y < minY;

        if (aBelow) out.push(a);

        if (aBelow !== bBelow) {
            const t = (minY - a.y) / (b.y - a.y);
            out.push({
                x: a.x + (b.x - a.x) * t,
                y: minY,
                z: a.z + (b.z - a.z) * t,
            });
        }
    }

    return out;
}

// Keeps the portion of the polygon AT OR BELOW maxY.
function clipPolygonByMaxY(verts, maxY) {
    const out = [];
    const n = verts.length;

    for (let i = 0; i < n; i++) {
        const a = verts[i];
        const b = verts[(i + 1) % n];

        const aBelow = a.y <= maxY;
        const bBelow = b.y <= maxY;

        // Keep vertices below the plane
        if (aBelow) out.push(a);

        // Add intersection if the edge crosses the plane
        if (aBelow !== bBelow) {
            const t = (maxY - a.y) / (b.y - a.y);
            out.push({
                x: a.x + (b.x - a.x) * t,
                y: maxY,
                z: a.z + (b.z - a.z) * t,
            });
        }
    }

    return out;
}

// Keeps the portion of the polygon ABOVE maxY.
function clipPolygonAboveMaxY(verts, maxY) {
    const out = [];
    const n = verts.length;

    for (let i = 0; i < n; i++) {
        const a = verts[i];
        const b = verts[(i + 1) % n];

        const aAbove = a.y > maxY;
        const bAbove = b.y > maxY;

        if (aAbove) out.push(a);

        if (aAbove !== bAbove) {
            const t = (maxY - a.y) / (b.y - a.y);
            out.push({
                x: a.x + (b.x - a.x) * t,
                y: maxY,
                z: a.z + (b.z - a.z) * t,
            });
        }
    }

    return out;
}

// Kept for the _old function below.
function clipTriangleByMinY(verts, minY) {
    return clipPolygonByMinY(verts, minY);
}

// Generic Sutherland-Hodgman clip of a polygon against a single axis-aligned
// half-plane in the XZ plane, keeping the requested side. `axis` is 'x' or
// 'z'; `op` is one of '<','<=','>','>=' describing which side of `value` to
// KEEP. Y (and the untouched axis) are linearly interpolated at crossings so
// the emitted polygon still lies flush on the triangle's plane. Used by the
// occlusion split to carve a sub-triangle into "outside the occluder box"
// slabs (emitted whole) and an "inside the box" slab (rasterized).
//
// Note the boundary is inclusive-consistent between complementary ops: e.g.
// clipPolyKeep(p,'x','<',v) and clipPolyKeep(p,'x','>=',v) partition p with no
// gap and no overlap, so splitting a polygon into both halves loses no area.
function clipPolyKeep(verts, axis, op, value) {
    const n = verts.length;
    if (n === 0) return [];

    const coord = (v) => (axis === 'x' ? v.x : v.z);
    const inside = (v) => {
        const c = coord(v);
        switch (op) {
            case '<':  return c <  value;
            case '<=': return c <= value;
            case '>':  return c >  value;
            case '>=': return c >= value;
        }
        return false;
    };

    const out = [];
    for (let i = 0; i < n; i++) {
        const a = verts[i];
        const b = verts[(i + 1) % n];
        const aIn = inside(a);
        const bIn = inside(b);

        if (aIn) out.push(a);

        if (aIn !== bIn) {
            const ca = coord(a);
            const cb = coord(b);
            const denom = (cb - ca);
            // Parallel-to-plane edges never cross; guarded by aIn!==bIn anyway.
            const t = denom !== 0 ? (value - ca) / denom : 0;
            out.push({
                x: a.x + (b.x - a.x) * t,
                y: a.y + (b.y - a.y) * t,
                z: a.z + (b.z - a.z) * t,
            });
        }
    }
    return out;
}

// Helper: compute vertices below minY (clipped slice)
function getClippedBelowTriangle(rawVerts, minY) {
    const belowVerts = [];

    for (let i = 0; i < 3; i++) {
        const curr = rawVerts[i];
        const next = rawVerts[(i + 1) % 3];

        const currBelow = curr.y < minY;
        const nextBelow = next.y < minY;

        if (currBelow) belowVerts.push(curr);

        // Edge crosses minY plane
        if (currBelow !== nextBelow) {
            const t = (minY - curr.y) / (next.y - curr.y);
            const intersect = {
                x: f32(curr.x + t * (next.x - curr.x)),
                y: f32(minY),
                z: f32(curr.z + t * (next.z - curr.z))
            };
            belowVerts.push(intersect);
        }
    }

    return belowVerts;
}

const STANDABLE_CHK_DIST = 1.0; // must match sample_points.js's chkDist
const STANDABLE_CIRCLE_SEGMENTS = 16;

function computeYFromPlaneLocal(nx, ny, nz, d, x, z) {
    if (isZero(ny)) return 0;
    return f32((((-nx * x) - (nz * z)) - d) / ny);
}

export function renderStandableSurfaceXZ_old(allTriangleData) {
    const f32 = Math.fround;

    const positionsNormal = [];
    const indicesNormal = [];
    let vertexOffsetNormal = 0;

    const positionsSpecial = [];
    const indicesSpecial = [];
    let vertexOffsetSpecial = 0;

    allTriangleData.forEach(tri => {
        const vtxs = tri.vtxs;
        const normals = tri.normals;
        const D = f32(tri.d);

        const Nx = f32(normals[0] * COLPOLY_NORMAL_FRAC);
        const Ny = f32(normals[1] * COLPOLY_NORMAL_FRAC);
        const Nz = f32(normals[2] * COLPOLY_NORMAL_FRAC);

        if (Ny < f32(0.0) || isZero(Ny)) return;

        const originalMinY = Math.min(vtxs[0].y, vtxs[1].y, vtxs[2].y);

        function liftVertex(x, z) {
            // f32 comparison threshold
            if (Math.abs(Ny) < f32(1e-12)) return f32(0.0);

            // dot = Nx*x + Nz*z + D   (all f32)
            const dot = f32(
                f32(f32(Nx * x) + f32(Nz * z)) + D
            );

            // -(dot) / Ny    (all f32)
            return f32(f32(-dot) / Ny);
        }
        
        if (vtxs[0].x == 485 && vtxs[0].y == 1233 && vtxs[0].z == 1764 && 
        vtxs[1].x == -69 && vtxs[1].y == 1233 && vtxs[1].z == 1487 && 
        vtxs[2].x == -291 && vtxs[2].y == 1233 && vtxs[2].z == 1875)
            console.log("test")

        // Expand triangle
        let expandedVertices = vtxs.map(v => ({ x: f32(v.x), z: f32(v.z) }));
        if (Math.abs(Ny) > f32(0.5)) {

            // Compute centroid in f32
            const centroidX = f32(
                f32(expandedVertices[0].x + expandedVertices[1].x + expandedVertices[2].x) / f32(3.0)
            );
            const centroidZ = f32(
                f32(expandedVertices[0].z + expandedVertices[1].z + expandedVertices[2].z) / f32(3.0)
            );

            expandedVertices = expandedVertices.map(v => {

                const dx = f32(v.x - centroidX);
                const dz = f32(v.z - centroidZ);

                // len = sqrt(dx*dx + dz*dz) in f32
                const len = f32(Math.sqrt(f32(f32(dx * dx) + f32(dz * dz))));

                // factor = (len + 1) / len   (all f32)
                let factor = f32(1.0);
                if (len > f32(0.0)) {
                    factor = f32(f32(len + f32(1.0)) / len);
                }

                return {
                    x: f32(centroidX + f32(dx * factor)),
                    z: f32(centroidZ + f32(dz * factor))
                };
            });
        }

        // Compute rawVerts
        const rawVerts = [];
        for (let i = 0; i < 3; i++) {
            const vx = expandedVertices[i].x;
            const vz = expandedVertices[i].z;
            const vy = liftVertex(vx, vz);
            rawVerts.push({ x: vx, y: vy, z: vz });
        }

        // Check if ALL rawVerts are below original triangle, and it's relatively flat
        let allBelowOriginal = rawVerts.every(v => v.y < originalMinY);

        let clippedAbove;
        if (!allBelowOriginal) {
            clippedAbove = clipTriangleByMinY(rawVerts, originalMinY);
            if (clippedAbove.length < 3) return;
        }

        // Triangulate above-plane portion
        if (!allBelowOriginal) {
            for (let i = 1; i < clippedAbove.length - 1; i++) {
                const v0 = clippedAbove[0], v1 = clippedAbove[i], v2 = clippedAbove[i+1];
                positionsNormal.push(v0.x,v0.y,v0.z, v1.x,v1.y,v1.z, v2.x,v2.y,v2.z);
                indicesNormal.push(vertexOffsetNormal, vertexOffsetNormal+1, vertexOffsetNormal+2);
                vertexOffsetNormal += 3;
            }
        }

        // Triangulate clipped/below-plane portion (special color)
        if(Ny > 0.5) {
            
            let clippedBelow;
            if (allBelowOriginal) {
                clippedBelow = rawVerts;
            } else {
                clippedBelow = getClippedBelowTriangle(rawVerts, originalMinY);
            }

            if (clippedBelow.length >= 3) {
                for (let i = 1; i < clippedBelow.length - 1; i++) {
                    const v0 = clippedBelow[0], v1 = clippedBelow[i], v2 = clippedBelow[i+1];
                    positionsSpecial.push(v0.x,v0.y,v0.z, v1.x,v1.y,v1.z, v2.x,v2.y,v2.z);
                    indicesSpecial.push(vertexOffsetSpecial, vertexOffsetSpecial+1, vertexOffsetSpecial+2);
                    vertexOffsetSpecial += 3;
                }
            }
        }
    });

    // Build meshes
    const group = new THREE.Group();

    if (positionsNormal.length > 0) {
        const geometryN = new THREE.BufferGeometry();
        geometryN.setAttribute('position', new THREE.Float32BufferAttribute(positionsNormal, 3));
        geometryN.setIndex(indicesNormal);
        geometryN.computeVertexNormals();

        const meshN = new THREE.Mesh(
            geometryN,
            new THREE.MeshStandardMaterial({
                color: 0xff0000,
                side: THREE.DoubleSide,
                flatShading: true,
                polygonOffset: true,
                polygonOffsetFactor: 4,
                polygonOffsetUnits: 4
            })
        );

        const edgesN = new THREE.LineSegments(
            new THREE.EdgesGeometry(geometryN),
            new THREE.LineBasicMaterial({ color: 0x000000 })
        );

        group.add(meshN);
        group.add(edgesN);
    }

    if (positionsSpecial.length > 0) {
        const geometryS = new THREE.BufferGeometry();
        geometryS.setAttribute('position', new THREE.Float32BufferAttribute(positionsSpecial, 3));
        geometryS.setIndex(indicesSpecial);
        geometryS.computeVertexNormals();

        const meshS = new THREE.Mesh(
            geometryS,
            new THREE.MeshStandardMaterial({
                color: 0x0000ff,
                side: THREE.DoubleSide,
                flatShading: true,
                polygonOffset: true,
                polygonOffsetFactor: 4,
                polygonOffsetUnits: 4
            })
        );

        const edgesS = new THREE.LineSegments(
            new THREE.EdgesGeometry(geometryS),
            new THREE.LineBasicMaterial({ color: 0x000000 })
        );

        group.add(meshS);
        group.add(edgesS);
    }

    return group;
}

// Builds the exact region triChkPointParaYImpl accepts for a single triangle,
// as a handful of overlapping filled shapes instead of a sampled grid:
//   - the triangle itself + the edge buffer strips -> pushRed / pushBlue,
//     split by minVertexY (blue = the portion that dipped below), matching
//     the original function's red/blue distinction.
//   - a full circle of radius chkDist centered at each vertex (always) -> pushGreen
// Overlap between these pieces is fine since we're only filling area, not
// tracing a single outline.
//
// colCtx/polyIdx (optional): mirrors the validity rules sample_points.js
// applies to individual sample points (see isSamplePointValid there):
//   - If this triangle was never registered as standable ground (floor or
//     wall) in any subdivision, none of its geometry is emitted at all.
//   - Any geometry whose Y falls below (this triangle's own lowest vertex Y
//     - BGCHECK_SUBDIV_OVERLAP) is clipped away, since that's the same
//     tolerance sample_points.js uses to reject plane-equation blowups on
//     near-vertical triangles (subdivision cells alone are too coarse to
//     catch these). This applies to every piece we emit - the base
//     triangle, the edge buffer strips, and the vertex-bulge circles -
//     not just the existing minY/maxY red/blue/yellow split.
// Omit colCtx to fall back to the old unfiltered behavior.
// Occlusion top-clip tuning.
//
// The bottom-clip (cutoffY) and the standable-set membership test are exact
// polygon operations, but the occlusion/downward-scan portion of
// isSamplePointValid is inherently per-(x,z)-position (which other polys sit
// above/below a given column, and whether their footprints contain that exact
// x,z), so there's no single plane to clip a whole triangle against.
//
// Rather than rasterize the whole surface into fixed cells (which explodes
// into millions of tiny quads on large floors and can overflow the vertex
// array), we ADAPTIVELY REFINE: a sub-triangle that overlaps no occluder is
// emitted whole; one that does is recursively quartered, and each piece that
// turns out uniformly valid/invalid (sampled via isSamplePointValid) is
// emitted or dropped as a whole polygon. Only pieces straddling a validity
// boundary keep subdividing, down to a minimum feature size. This keeps the
// output geometry proportional to the *length of the occlusion boundary*, not
// the *area* of the surface, so open floors stay cheap and the vertex count
// can't blow up.

// Smallest edge length (world units) an occluded region is refined to before
// we stop subdividing and just decide the whole leaf by its center sample.
// ~2 units keeps the clipped silhouette visually indistinguishable from the
// point cloud. Larger = coarser boundary but fewer triangles.
const STANDABLE_OCCLUSION_MIN_FEATURE = 2.0;

// Max quadtree depth per sub-triangle, a hard bound on work regardless of
// triangle size. Set with headroom for steep triangles: a near-vertical seed
// cell can start with a large plane-Y span, and reaching OCCLUSION_Y_FLOOR from
// there takes several extra splits, so this must be comfortably above the flat-
// surface need (which is only ~log2(SAMPLE_SEED/MIN_FEATURE)).
// MEASURED: recursion terminates on the Y-floor test long before this cap
// binds - sweeping 4..14 showed probe counts identical from depth 5 upward.
// So this is a pure safety backstop, not a tuning knob. Left generous.
const STANDABLE_OCCLUSION_MAX_DEPTH = 12;

// Absolute smallest cell the refiner will split a MIXED (boundary-straddling)
// leaf down to, even below the per-axis feature size. This exists for pieces
// that START smaller than the feature size - notably the radius-1 vertex-bulge
// circle segments - which would otherwise be decided whole by a single
// centroid probe and poke a full piece-width past the clip boundary. Splitting
// them to this floor snaps the bulge edge to the same boundary the base
// surface uses. Smaller = tighter bulge clipping but more tiny triangles along
// boundaries; ~0.25 is well below the bulge radius and keeps the count modest.
//
// Kept at the original 0.25. Lowering it to 0.10 tightens how closely a bulge
// hugs the cutoff, but only by sampling bulges more finely than the original
// did, which also deletes bulge area the original kept. Bulges reading as
// over-clipped is worse than a slight overhang, so this stays at 0.25.
const STANDABLE_OCCLUSION_HARD_FLOOR = 0.25;

// Terminal refinement threshold on a mixed cell's PLANE-Y span (world units).
// The validity boundary on these surfaces is largely a function of Y, so on a
// near-vertical triangle a cell that's tiny in XZ can still span a huge Y range
// and clip the boundary coarsely. This makes the refiner keep splitting a mixed
// cell until its Y extent is this thin (auto-adapting to steepness: flat cells
// bottom out on the XZ hard floor first, steep cells keep going until the Y
// band is narrow). This is what actually tightens the green vertex bulge in the
// invalid region. Smaller = tighter boundary but more triangles on steep faces.
// Restored to the original 4.0. This governs how tightly a MIXED cell's
// boundary is resolved once the refiner is already running on it, so unlike
// the seed step it only costs accuracy where detail was already detected.
const STANDABLE_OCCLUSION_Y_FLOOR = 4.0;

// Coarse seed-grid cell size (world units). The entry point pre-splits each
// triangle so no region handed to the adaptive refiner starts larger than this
// before probing. It bounds how large an invalid band can be while still
// slipping between a region's probe points: a fully-valid or fully-invalid
// seed cell is decided in one probe (cheap), and only cells straddling a
// validity boundary refine further. Smaller = safer against thin missed bands
// but more baseline probes on big surfaces; ~64 units catches Shadow-Temple-
// scale features while keeping open floors light.
// This is the single most accuracy-critical knob, and it must NOT be coarsened
// aggressively.
//
// A seed cell is decided by ~7 probes (centroid, vertices, edge midpoints). If
// all 7 agree, the cell is emitted or dropped WHOLE and the refiner never runs
// on it. So the seed step sets the largest validity feature that can slip
// through completely unseen. Real validity boundaries here are driven by
// subdivision-cell membership and are DISCONTINUOUS - they jump at cell
// edges - so probes spaced far apart tell you nothing about what lies between
// them. (An earlier tuning pass measured this against a smooth synthetic
// boundary and wrongly concluded coarse seeding was free; smooth boundaries
// interpolate, real ones don't.)
//
// Diagnostic: if the perf log shows probes/seedCell near 7.0 and leaves far
// below refine calls, the seed grid is too coarse - cells are resolving as
// uniform in one probe and the refiner is being starved.
const STANDABLE_OCCLUSION_SAMPLE_SEED = 64.0;

// Scene-wide safety ceiling on triangles emitted by the occlusion clip across
// ALL polygons in one renderStandableSurfaceXZ call. The positions arrays are
// scene-global, so a per-triangle cap isn't enough to guarantee we never hit
// JS's max array length; this is the real backstop. Well above what any real
// scene needs, but finite. Reset at the top of each render call.
const STANDABLE_OCCLUSION_SCENE_TRI_BUDGET = 4000000;

////////////////////////////////////////
// Adaptive sample density
////////////////////////////////////////
//
// The constants above describe the density we'd LIKE on every triangle. The
// problem is that the cost of that density is not uniform: a near-vertical
// standable triangle (Ny just above 0) has a huge plane-Y gradient, so the
// steepness-aware seed step collapses to FEATURE_FLOOR and the seed grid alone
// can hit MAX_SEED_CELLS - per triangle. One or two such triangles is fine;
// ten or more multiplies that cost linearly and the render appears to hang.
//
// So instead of a fixed density we run a cheap PLANNING PASS over all
// triangles first, estimate how many seed cells each expensive triangle wants,
// and if the scene total exceeds a probe budget we scale the density DOWN
// globally (coarser seed step, coarser Y floor, lower depth cap) until the
// estimate fits. Maps with few steep triangles are unaffected - they never
// exceed the budget, so the scale stays 1 and output is bit-identical to
// before. Maps with many steep triangles degrade gracefully in boundary
// precision instead of taking minutes.
//
// Total seed-cell probes we're willing to spend across the WHOLE scene. Each
// seed cell costs ~7 isSamplePointValid calls at minimum (centroid + 3 verts +
// 3 edge midpoints), plus recursion for mixed cells, so this is roughly a
// few million predicate evaluations at the ceiling.
// Each seed cell costs ~7 isSamplePointValid calls just to probe, and a cell
// that straddles a validity boundary costs several times that as it recurses.
// isSamplePointValid is itself not cheap (it walks subdivision cells and tests
// other polys' footprints), so the practical ceiling for a responsive load is
// on the order of tens of thousands of seed cells, not hundreds of thousands.
// With the retuned seed step above, a typical steep triangle costs far fewer
// seed cells than it used to, so this budget now tolerates noticeably more
// steep triangles before any coarsening kicks in - which is the goal, since
// coarsening is the only thing that costs accuracy. Raise if you still see
// detail loss on your heaviest maps; lower if load time is still the problem.
// Sized so that real maps stay at scale 1.00 (no coarsening) rather than being
// degraded preemptively. Reference points from actual maps:
//   4947 tris /  805 steep (sichitai-class) -> est@scale1 ~352k cells
//   4395 tris / 2715 steep (z2_20sichitai)   -> est@scale1 ~1.07M cells
//   4413 tris / 1383 steep (bdan)            -> est@scale1 ~2.14M cells
// 1.1M keeps the first two at scale 1.00. bdan lands near scale 1.5, which
// measurements show costs almost nothing in boundary quality (its "% cut
// short" stays under 0.2% even at scale 4.8) while roughly halving build time
// - coarsening there reduces how many boundary cells EXIST rather than
// degrading the ones that do.
//
// If a map logs UNDER-REFINED at scale 1.00, the budget is NOT the problem;
// something else is cutting refinement short.
const STANDABLE_ADAPTIVE_PROBE_BUDGET = 1100000;

// Never coarsen beyond these, no matter how many steep triangles a map has.
// Past this point the clip silhouette gets visibly blocky, so we'd rather
// accept the remaining cost than produce garbage.
const STANDABLE_ADAPTIVE_MAX_SCALE = 16.0;

// How strongly the SEED STEP follows the global coarsening scale, as an
// exponent: seedStep = SAMPLE_SEED * scale^SEED_SCALE_EXP.
//
// The other knobs (Y floor, XZ floors) can absorb the full scale because they
// only affect cells the refiner has ALREADY identified as mixed - coarsening
// them blurs a boundary that was still found. The seed step is different:
// coarsening it makes whole features invisible, because a uniform-probing seed
// cell is emitted or dropped without ever being refined. So the seed step is
// deliberately the LAST thing to give way.
//
// DEFAULT 0: the seed step does NOT coarsen at all. Evidence from a real map
// (4947 tris / 805 steep) where the seed step had been stretched to 312 units:
//   probes/seedCell 7.6   (7.0 is the floor - one uniform probe per cell)
//   refine/seedCell  1.04  (seed cells essentially never subdivided)
//   leaves/refine    1.5%  (the refiner almost never reached a decision)
// i.e. the adaptive refiner had been switched off in all but name, and the
// output was just a coarse grid. Freezing the seed step keeps the refiner fed;
// the cost is then controlled by the Y floor and cell caps instead, which
// degrade smoothness rather than deleting features.
//
// Raise toward 1.0 only if load time is unacceptable AND the perf log shows a
// healthy leaves/refine ratio (well above ~10%) with headroom to spare.
const STANDABLE_ADAPTIVE_SEED_SCALE_EXP = 0.0;

// Hard ceiling on the seed step regardless of scale. Past roughly this size a
// seed cell is large enough to swallow an entire real feature between probes,
// which is the failure mode this whole section exists to avoid.
const STANDABLE_ADAPTIVE_MAX_SEED_STEP = 80.0;

// Ceiling on the Y floor after scaling. With the seed step frozen (exp 0) the
// whole coarsening burden lands on the Y floor, which can otherwise run away
// to 50+ units on a heavy map and visibly stair-step the boundary. Capping it
// means a very heavy scene gives up refinement DEPTH (via maxDepth and the
// cell caps) rather than boundary precision.
const STANDABLE_ADAPTIVE_MAX_Y_FLOOR = 16.0;

// Floor under the per-triangle seed-cell cap. Scaling drove this to ~94 cells
// on a heavy map, which starves large steep triangles of seed coverage. Keep
// enough that a big face still gets a usable grid.
const STANDABLE_ADAPTIVE_MIN_SEED_CELLS = 1024;

// How far a single triangle may exceed its seed-cell allowance before we give
// up and coarsen its seed step. Set high: stretching the seed step is the one
// form of degradation that makes whole features disappear, so we tolerate a
// lot of extra cells to avoid it. The depth cap keeps each cell cheap.
const STANDABLE_SEED_CAP_OVERSHOOT = 24;


// Per-triangle seed-cell ceiling, scaled down alongside everything else. This
// replaces the old fixed MAX_SEED_CELLS = 20000, which was a per-triangle
// guard with no notion of how many other triangles were also paying it.
const STANDABLE_ADAPTIVE_BASE_MAX_SEED_CELLS = 20000;

// A triangle whose XZ footprint is tiny contributes little visible boundary,
// so it's the first thing we're willing to coarsen. Triangles with an XZ
// bounding-box diagonal below this are always refined at the coarsest
// permitted density once the scene is over budget.
const STANDABLE_ADAPTIVE_SMALL_TRI_DIAG = 8.0;

////////////////////////////////////////
// Performance logging
////////////////////////////////////////
// Master switch for the summary line + counters. Cheap enough to leave on.
const STANDABLE_PERF_LOGGING = true;

// Per-triangle timing for the expensive triangles. Adds a clock read per
// sampled triangle, so it's off by default - turn it on when you want to know
// WHICH polys are eating the time (their Ny and span tell you what to tune).
const STANDABLE_PERF_LOGGING_VERBOSE = false;

// Only triangles at least this slow get an individual line in verbose mode.
const STANDABLE_PERF_SLOW_TRI_MS = 2.0;

// performance.now() where available (sub-ms, monotonic), Date.now() otherwise.
const _now = (typeof performance !== 'undefined' && performance.now)
    ? () => performance.now()
    : () => Date.now();

// Whether the green vertex-bulge circles are exempt from adaptive coarsening.
// They're radius-1 discs (three per triangle, area bounded regardless of
// triangle size), so they contribute almost nothing to the cost that motivates
// scaling - but they're the most detail-sensitive geometry emitted, so
// coarsening them is where the accuracy loss shows first. Exempt by default;
// set false to put them back under the scene scale.
const STANDABLE_ADAPTIVE_EXEMPT_BULGES = true;

// Vertex bulges are sampled against their own plane-Y excursion rather than
// the global Y floor.
//
// A bulge is a radius-chkDist disc around a vertex, and unlike the edge
// buffer strips (which are gated to |Ny| > 0.5) it is emitted on EVERY
// standable triangle - matching the game, whose vertex-distance check has no
// steepness gate. On a near-vertical plane one unit of XZ is |Nx/Ny| units of
// Y: ~20 at Ny=0.05, ~50 at Ny=0.02. Nothing clips that from above (see
// pushAboveCutoff), so the ONLY thing that removes the invalid part is the
// sampled validity test - and refining to a fixed 4-unit yFloor cannot
// resolve a 50-unit excursion, which is why parts of the bulge survive above
// where the surface ends.
//
// So for bulges the Y floor is scaled to the piece: a fraction of the bulge's
// own Y span. 1/16 means a bulge spanning 50 units in Y refines to ~3-unit
// bands, and one spanning 2 units refines to ~0.125 - each resolved to the
// same RELATIVE precision regardless of steepness. Smaller = tighter bulge
// clipping, more triangles.
// DISABLED BY DEFAULT (set to 0).
//
// Tying the bulge Y floor to each piece's own Y excursion does reduce how far
// a bulge pokes past the cutoff (measured: 5.67% -> 0.91% of bulge area above
// a hard cutoff at Ny=0.1). But it does that by sampling the bulges MORE
// finely than the original ever did, and finer sampling also rejects bulge
// area the original kept - measured up to 3.5% of the bulge footprint gone on
// a boundary with structure at bulge scale, worst on flatter triangles.
//
// In practice that reads as the bulges being cut off too aggressively, which
// is worse than them overhanging slightly. So this is off by default and the
// bulges use the same fixed yFloor the original did. Set to 1/8 to trade
// bulge coverage for a tighter cutoff.
const STANDABLE_BULGE_Y_FLOOR_FRACTION = 0;

// Never refine a bulge below this absolute Y band, whatever the fraction says.
const STANDABLE_BULGE_MIN_Y_FLOOR = 0.5;

// Smallest cell the refiner will resolve on each axis at scale 1 (was a local
// FEATURE_FLOOR inside the builder). Hoisted so the planner's cost estimate
// uses exactly the same value the builder does.
const FEATURE_FLOOR_BASE = 0.25;

// Shared by the planning pass and the real build: decides whether a triangle
// needs adaptive sampling at all, and if so how expensive it looks. Returns
// null for triangles that are skipped outright (back-facing, not standable),
// otherwise { mayBeInvalid, Nx, Ny, Nz, D, minY, maxY, spanX, spanZ }.
//
// This is deliberately the SAME logic the builder uses for its `mayBeInvalid`
// fast path, factored out so the planner can't disagree with the builder about
// which triangles are expensive.
function analyzeStandableTriangle(tri, colCtx, polyIdx) {
    const vtxs = tri.vtxs;
    const normals = tri.normals;
    const D = f32(tri.d);

    const Nx = f32(normals[0] * COLPOLY_NORMAL_FRAC);
    const Ny = f32(normals[1] * COLPOLY_NORMAL_FRAC);
    const Nz = f32(normals[2] * COLPOLY_NORMAL_FRAC);

    if (Ny < f32(0.0) || isZero(Ny)) return null;

    const occlusionClipEnabled = (colCtx && polyIdx !== undefined && polyIdx !== null);

    let standableSet = null;
    if (occlusionClipEnabled) {
        standableSet = colCtx.polyStandableSubdivIndices && colCtx.polyStandableSubdivIndices[polyIdx];
        if (!standableSet) return null;
    }

    const rawV0 = { x: f32(vtxs[0].x), y: f32(vtxs[0].y), z: f32(vtxs[0].z) };
    const rawV1 = { x: f32(vtxs[1].x), y: f32(vtxs[1].y), z: f32(vtxs[1].z) };
    const rawV2 = { x: f32(vtxs[2].x), y: f32(vtxs[2].y), z: f32(vtxs[2].z) };

    const minY = Math.min(rawV0.y, rawV1.y, rawV2.y);
    const maxY = Math.max(rawV0.y, rawV1.y, rawV2.y);

    // Footprint including the chkDist buffer, since the bulges/strips extend
    // that far past the raw triangle.
    const spanX = (Math.max(rawV0.x, rawV1.x, rawV2.x) - Math.min(rawV0.x, rawV1.x, rawV2.x)) + 2 * STANDABLE_CHK_DIST;
    const spanZ = (Math.max(rawV0.z, rawV1.z, rawV2.z) - Math.min(rawV0.z, rawV1.z, rawV2.z)) + 2 * STANDABLE_CHK_DIST;

    let mayBeInvalid = false;
    if (occlusionClipEnabled) {
        const nearFlat = Ny > f32(0.99);

        let hasOccluder = false;
        if (standableSet) {
            const oMinX = Math.min(rawV0.x, rawV1.x, rawV2.x) - STANDABLE_CHK_DIST;
            const oMaxX = Math.max(rawV0.x, rawV1.x, rawV2.x) + STANDABLE_CHK_DIST;
            const oMinZ = Math.min(rawV0.z, rawV1.z, rawV2.z) - STANDABLE_CHK_DIST;
            const oMaxZ = Math.max(rawV0.z, rawV1.z, rawV2.z) + STANDABLE_CHK_DIST;
            const seen = new Set();
            outer:
            for (const cellIndex of standableSet) {
                const cell = colCtx.subdivisions[cellIndex];
                if (!cell || !cell.standable) continue;
                for (const p of cell.standable) {
                    if (p === polyIdx || seen.has(p)) continue;
                    seen.add(p);
                    const yr = colCtx.polyWorldYRange && colCtx.polyWorldYRange[p];
                    if (yr && yr.min >= minY) continue;
                    const xz = colCtx.polyWorldXZBounds && colCtx.polyWorldXZBounds[p];
                    if (xz && (xz.maxX < oMinX || xz.minX > oMaxX || xz.maxZ < oMinZ || xz.minZ > oMaxZ)) continue;
                    hasOccluder = true;
                    break outer;
                }
            }
        }

        mayBeInvalid = hasOccluder || !nearFlat;
    }

    return { mayBeInvalid, Nx, Ny, Nz, D, minY, maxY, spanX, spanZ };
}

// Estimated number of seed cells a triangle would produce at a given quality
// scale. Mirrors the seed-step math in the builder so the planner's numbers
// track reality. `scale` >= 1 coarsens: 1 = full density, 4 = quarter density
// per axis (sixteenth the cells).
function estimateSeedCells(info, scale) {
    if (!info || !info.mayBeInvalid) return 1; // whole-triangle fast path

    const { Nx, Ny, Nz, spanX, spanZ } = info;

    const gradX = Math.abs(Nx) > 1e-9 ? Math.abs(Ny / Nx) : Infinity;
    const gradZ = Math.abs(Nz) > 1e-9 ? Math.abs(Ny / Nz) : Infinity;

    // Must mirror makeDensity() exactly, including the damped seed scaling,
    // or the planner will under-predict cost and pick too coarse a scale.
    const featureFloor = FEATURE_FLOOR_BASE * scale;
    const minFeature = STANDABLE_OCCLUSION_MIN_FEATURE * scale;
    const sampleSeed = Math.min(
        STANDABLE_ADAPTIVE_MAX_SEED_STEP,
        STANDABLE_OCCLUSION_SAMPLE_SEED * Math.pow(scale, STANDABLE_ADAPTIVE_SEED_SCALE_EXP)
    );

    const featX = Math.max(featureFloor, Math.min(minFeature, minFeature * gradX));
    const featZ = Math.max(featureFloor, Math.min(minFeature, minFeature * gradZ));
    const seedX = Math.max(featX, Math.min(sampleSeed, sampleSeed * gradX));
    const seedZ = Math.max(featZ, Math.min(sampleSeed, sampleSeed * gradZ));

    const nx = Math.max(1, Math.ceil(spanX / seedX));
    const nz = Math.max(1, Math.ceil(spanZ / seedZ));

    const cap = (scale <= 1.0)
        ? STANDABLE_ADAPTIVE_BASE_MAX_SEED_CELLS
        : Math.max(STANDABLE_ADAPTIVE_MIN_SEED_CELLS,
                   Math.floor(STANDABLE_ADAPTIVE_BASE_MAX_SEED_CELLS / (scale * scale)));
    return Math.min(nx * nz, cap);
}

// Plans a global quality scale for one render call. Cheap: one pass over the
// triangles doing bounding-box math and (for the occluder test) the same
// subdivision walk the builder would do anyway.
//
// Returns { scale, maxSeedCells, minFeature, sampleSeed, yFloor, maxDepth,
//           featureFloor, hardFloor, smallTriScale }.
function planStandableQuality(allTriangleData, colCtx) {
    const _t0 = _now();
    const base = {
        scale: 1.0,
        maxSeedCells: STANDABLE_ADAPTIVE_BASE_MAX_SEED_CELLS,
        minFeature: STANDABLE_OCCLUSION_MIN_FEATURE,
        sampleSeed: STANDABLE_OCCLUSION_SAMPLE_SEED,
        yFloor: STANDABLE_OCCLUSION_Y_FLOOR,
        maxDepth: STANDABLE_OCCLUSION_MAX_DEPTH,
        featureFloor: FEATURE_FLOOR_BASE,
        hardFloor: STANDABLE_OCCLUSION_HARD_FLOOR,
        infos: null,
        steepCount: 0,
        planMs: 0,
        estAtScale1: 0,
        estAtScale: 0,
    };

    // Without colCtx the occlusion clip is off entirely and nothing is
    // sampled, so there's nothing to adapt.
    if (!colCtx) { base.planMs = _now() - _t0; return base; }

    // Pass 1: analyze every triangle once, cache the result for the build pass.
    const infos = new Array(allTriangleData.length);
    let expensiveCount = 0;
    for (let i = 0; i < allTriangleData.length; i++) {
        const tri = allTriangleData[i];
        const polyIdx = (tri.id !== undefined && tri.id !== null) ? tri.id : i;
        const info = analyzeStandableTriangle(tri, colCtx, polyIdx);
        infos[i] = info;
        if (info && info.mayBeInvalid) expensiveCount++;
    }
    base.infos = infos;
    base.steepCount = expensiveCount;

    if (expensiveCount === 0) { base.planMs = _now() - _t0; return base; }

    // Pass 2: find the coarsest-acceptable scale that fits the probe budget.
    // Doubling scale roughly quarters the cell count, so a handful of steps
    // covers the whole useful range.
    let scale = 1.0;
    let estimate = 0;
    for (;;) {
        estimate = 0;
        for (let i = 0; i < infos.length; i++) {
            estimate += estimateSeedCells(infos[i], scale);
            if (estimate > STANDABLE_ADAPTIVE_PROBE_BUDGET * 4) break; // early out
        }
        if (estimate <= STANDABLE_ADAPTIVE_PROBE_BUDGET) break;
        if (scale >= STANDABLE_ADAPTIVE_MAX_SCALE) break;
        scale = Math.min(STANDABLE_ADAPTIVE_MAX_SCALE, scale * 1.25);
    }

    // Exact totals for the log (the search loop early-outs, so recompute).
    let est1 = 0, estS = 0;
    for (let i = 0; i < infos.length; i++) {
        est1 += estimateSeedCells(infos[i], 1.0);
        estS += estimateSeedCells(infos[i], scale);
    }
    base.estAtScale1 = est1;
    base.estAtScale = estS;

    if (scale <= 1.0) { base.planMs = _now() - _t0; return base; }

    // Coarsen every knob together. The Y floor is the one that actually
    // governs boundary tightness on steep faces, so it scales too - otherwise
    // a coarser seed grid just means more mixed cells each refining to the
    // same fine Y band, and we'd save nothing.
    return {
        scale,
        maxSeedCells: Math.max(STANDABLE_ADAPTIVE_MIN_SEED_CELLS,
                               Math.floor(STANDABLE_ADAPTIVE_BASE_MAX_SEED_CELLS / (scale * scale))),
        minFeature: STANDABLE_OCCLUSION_MIN_FEATURE * scale,
        sampleSeed: Math.min(
            STANDABLE_ADAPTIVE_MAX_SEED_STEP,
            STANDABLE_OCCLUSION_SAMPLE_SEED * Math.pow(scale, STANDABLE_ADAPTIVE_SEED_SCALE_EXP)
        ),
        yFloor: Math.min(STANDABLE_ADAPTIVE_MAX_Y_FLOOR, STANDABLE_OCCLUSION_Y_FLOOR * scale),
        // Each doubling of scale removes one level of useful subdivision.
        maxDepth: Math.max(9, Math.round(STANDABLE_OCCLUSION_MAX_DEPTH - Math.log2(scale))),
        featureFloor: FEATURE_FLOOR_BASE * scale,
        hardFloor: STANDABLE_OCCLUSION_HARD_FLOOR * scale,
        infos,
        steepCount: expensiveCount,
        planMs: _now() - _t0,
        estAtScale1: est1,
        estAtScale: estS,
    };
}

function buildStandableSurfaceTriangles(tri, pushGreen, pushRed, pushBlue, pushYellow, colCtx = null, polyIdx = null, budget = null, quality = null, info = null, stats = null) {
    const vtxs = tri.vtxs;
    const normals = tri.normals;
    const D = f32(tri.d);

    const Nx = f32(normals[0] * COLPOLY_NORMAL_FRAC);
    const Ny = f32(normals[1] * COLPOLY_NORMAL_FRAC);
    const Nz = f32(normals[2] * COLPOLY_NORMAL_FRAC);

    if (Ny < f32(0.0) || isZero(Ny)) return;

    // Never registered as standable ground (floor or wall) in any
    // subdivision - the game would never surface this triangle via a floor
    // check anywhere, so none of its geometry belongs here either.
    if (colCtx && polyIdx !== undefined && polyIdx !== null) {
        const standableSet = colCtx.polyStandableSubdivIndices && colCtx.polyStandableSubdivIndices[polyIdx];
        if (!standableSet) return;
    }

    const rawV0 = { x: f32(vtxs[0].x), y: f32(vtxs[0].y), z: f32(vtxs[0].z) };
    const rawV1 = { x: f32(vtxs[1].x), y: f32(vtxs[1].y), z: f32(vtxs[1].z) };
    const rawV2 = { x: f32(vtxs[2].x), y: f32(vtxs[2].y), z: f32(vtxs[2].z) };

    // Clip threshold is based on the raw stored vertex heights (the actual
    // floor reference), same as the original function.
    const minY = Math.min(rawV0.y, rawV1.y, rawV2.y);
    const maxY = Math.max(rawV0.y, rawV1.y, rawV2.y);

    // Same tolerance/rationale as sample_points.js's isSamplePointValid:
    // only active when colCtx is provided, so behavior is unchanged if it's
    // omitted.
    const cutoffY = (colCtx && polyIdx !== undefined && polyIdx !== null)
        ? f32(minY - BGCHECK_SUBDIV_OVERLAP)
        : null;

    // Whether the occlusion ("top") clip is active. Same gate as the
    // bottom-clip: only when we actually have subdivision context to test
    // against. When off, geometry passes through to the buckets untouched
    // (old behavior).
    const occlusionClipEnabled = (colCtx && polyIdx !== undefined && polyIdx !== null);

    // TOP CLIP.
    //
    // The bottom-clip above (cutoffY) and the standable-set membership test at
    // the top of this function already mirror the first two rejection paths in
    // sample_points.js's isSamplePointValid. This handles the rest: everything
    // else that predicate can reject - both occlusion by another standable poly
    // AND downward-scan failure (a near-vertical "standable" triangle whose
    // plane-equation Y drifts into subdivision cells it isn't registered below,
    // very common in e.g. Shadow Temple). Neither can be expressed as a single
    // clip plane, so we defer to isSamplePointValid itself, sampled adaptively
    // (see the refiner below), and emit only the regions it accepts.

    // Lift an (x,z) onto the triangle's plane.
    const lift = (x, z) => ({ x: f32(x), y: computeYFromPlaneLocal(Nx, Ny, Nz, D, x, z), z: f32(z) });

    // ---- Cheap "can any of this triangle be invalid?" pre-check. ----
    //
    // isSamplePointValid rejects a point only via (a) the vertex-Y guard
    // (already handled by the bottom-clip), (b) downward-scan failure, or (c)
    // occlusion by another standable poly. If NEITHER (b) nor (c) can happen
    // anywhere on this triangle, every point is valid and we can emit it whole
    // without any sampling - restoring the fast path for the common flat, open
    // floor. We test cheap sufficient conditions for "can't happen":
    //
    //  (c) occlusion: gather other standable polys sharing a subdivision cell
    //      with this triangle whose XZ footprint overlaps it and whose Y range
    //      isn't entirely above it. None -> no possible occluder.
    //
    //  (b) downward-scan failure: happens when the plane-equation Y drifts out
    //      of the subdivision cells the triangle is registered below - i.e. on
    //      steep triangles whose plane Y ranges far beyond their own vertex Y
    //      span. If the plane Y across the triangle's XZ extent stays within the
    //      vertex Y range (flat triangle), the sampled point sits right on the
    //      triangle and the downward scan finds its own cell. We approximate
    //      "flat enough" as |Ny| close to 1 (near-horizontal). Steeper than that
    //      and we can't rule (b) out, so we sample.
    // The planning pass already ran exactly this test (steepness + occluder
    // presence) and cached the answer, so reuse it rather than walking the
    // subdivision cells a second time. Falls back to computing it here if this
    // function is called without a plan (e.g. directly, in a test).
    let mayBeInvalid = false;
    if (occlusionClipEnabled) {
        const a = info || analyzeStandableTriangle(tri, colCtx, polyIdx);
        mayBeInvalid = a ? a.mayBeInvalid : false;
    }

    // Validity of a single (x,z) via the point sampler's own predicate, Y taken
    // from the plane exactly as the sampler does.
    const validAt = (x, z) => {
        if (stats) stats.probes++;
        const y = computeYFromPlaneLocal(Nx, Ny, Nz, D, x, z);
        return isSamplePointValid(colCtx, polyIdx, f32(x), y, f32(z), minY);
    };

    // Emit a polygon (already in XZ, plane-lifted) as fan triangles into pushFn,
    // charging the scene-wide budget. Returns false if the budget is exhausted.
    const emitPoly = (pushFn, verts) => {
        for (let i = 1; i < verts.length - 1; i++) {
            if (budget && budget.remaining <= 0) return false;
            pushFn(verts[0], verts[i], verts[i + 1]);
            if (budget) budget.remaining--;
            if (stats) stats.emitted++;
        }
        return true;
    };

    // ADAPTIVE VALIDITY CLIP.
    //
    // isSamplePointValid can reject a point for reasons that are NOT captured by
    // occluder footprints:
    //   - DOWNWARD-SCAN FAILURE: if the triangle isn't registered in any
    //     subdivision cell strictly below the sample point's own cell, the point
    //     is invalid - independent of any other polygon. This happens a lot on
    //     near-vertical "standable" triangles (Ny just above 0), where the
    //     plane-equation Y drifts far from the triangle's own cells.
    //   - OCCLUSION by another standable poly at/below the point.
    // Because of the first case, we CANNOT decide validity from occluder boxes
    // alone (an earlier version did, and left large invalid regions of shallow
    // walls un-clipped). So this refiner is driven purely by sampling the
    // sampler's own predicate, coarse-to-fine:
    //
    //   - Probe the region (centroid, vertices, edge midpoints). If every probe
    //     agrees valid -> emit whole; if every probe agrees invalid -> drop.
    //   - Otherwise subdivide (quadtree) and recurse, down to a min feature size.
    //
    // To avoid missing a thin invalid band that slips between probes on a very
    // large piece, the entry point pre-splits the triangle so no leaf handed to
    // refine() starts larger than SAMPLE_SEED beforehand. Output scales with the
    // area that actually varies plus the seed grid, not with raw surface area.
    // Per-axis XZ resolution that keeps each step's plane-Y change bounded.
    // On a near-vertical triangle (tiny Ny) a small XZ step spans a huge Y
    // range, and validity here is largely a function of Y, so it can flip many
    // times within a single coarse XZ cell. Sampling purely by XZ extent then
    // drops or keeps whole cells wrongly (leaving large invalid regions, or
    // erasing valid ones). Tie resolution to the plane gradient: dY/dX = -Nx/Ny
    // and dY/dZ = -Nz/Ny, so to move at most K in Y we may move at most
    // K*|Ny/Nx| in X (and K*|Ny/Nz| in Z).
    const gradX = Math.abs(Nx) > 1e-9 ? Math.abs(Ny / Nx) : Infinity;
    const gradZ = Math.abs(Nz) > 1e-9 ? Math.abs(Ny / Nz) : Infinity;

    // Density knobs come from the scene-wide plan (see planStandableQuality).
    // At scale 1 these are exactly the old constants, so a map with few steep
    // triangles behaves identically to before.
    const Q = quality || {
        scale: 1.0,
        maxSeedCells: STANDABLE_ADAPTIVE_BASE_MAX_SEED_CELLS,
        minFeature: STANDABLE_OCCLUSION_MIN_FEATURE,
        sampleSeed: STANDABLE_OCCLUSION_SAMPLE_SEED,
        yFloor: STANDABLE_OCCLUSION_Y_FLOOR,
        maxDepth: STANDABLE_OCCLUSION_MAX_DEPTH,
        featureFloor: FEATURE_FLOOR_BASE,
        hardFloor: STANDABLE_OCCLUSION_HARD_FLOOR,
    };

    // Size-aware extra coarsening. A triangle with a small XZ footprint can
    // only contribute a short stretch of validity boundary, so refining it as
    // finely as a large one spends probes where they can't show. Once the
    // scene is over budget (scale > 1) we coarsen small triangles further,
    // proportional to how far below the size threshold they are. Large
    // triangles keep the scene scale, since that's where the visible boundary
    // actually is.
    let localScale = Q.scale;
    if (Q.scale > 1.0) {
        const triSpanX = Math.max(rawV0.x, rawV1.x, rawV2.x) - Math.min(rawV0.x, rawV1.x, rawV2.x);
        const triSpanZ = Math.max(rawV0.z, rawV1.z, rawV2.z) - Math.min(rawV0.z, rawV1.z, rawV2.z);
        const diag = Math.sqrt(triSpanX * triSpanX + triSpanZ * triSpanZ);
        if (diag < STANDABLE_ADAPTIVE_SMALL_TRI_DIAG) {
            const shortfall = STANDABLE_ADAPTIVE_SMALL_TRI_DIAG / Math.max(diag, 1e-3);
            localScale = Math.min(STANDABLE_ADAPTIVE_MAX_SCALE, Q.scale * Math.min(2.0, shortfall));
        }
    }

    // Build the full set of density values for a given scale. Called twice:
    // once at the planned scale (for the red/blue/yellow surface) and once at
    // scale 1 (for the green vertex bulges - see below).
    const makeDensity = (s) => {
        // The seed step follows the scale only weakly (see
        // STANDABLE_ADAPTIVE_SEED_SCALE_EXP) and is hard-capped, so heavy
        // scenes lose boundary *smoothness* rather than losing whole features.
        const seedScale = Math.pow(s, STANDABLE_ADAPTIVE_SEED_SCALE_EXP);
        const minFeature = STANDABLE_OCCLUSION_MIN_FEATURE * s;
        const sampleSeed = Math.min(
            STANDABLE_ADAPTIVE_MAX_SEED_STEP,
            STANDABLE_OCCLUSION_SAMPLE_SEED * seedScale
        );
        const featureFloor = FEATURE_FLOOR_BASE * s;
        // Smallest cell we'll refine to on each axis (steepness-limited but
        // floored so a near-vertical face doesn't demand sub-unit cells and
        // explode count).
        const featX = Math.max(featureFloor, Math.min(minFeature, minFeature * gradX));
        const featZ = Math.max(featureFloor, Math.min(minFeature, minFeature * gradZ));
        // Coarse seed step per axis: at most SAMPLE_SEED, but fine enough that
        // a seed cell spans a bounded Y range too.
        const seedX = Math.max(featX, Math.min(sampleSeed, sampleSeed * gradX));
        const seedZ = Math.max(featZ, Math.min(sampleSeed, sampleSeed * gradZ));
        return {
            seedX, seedZ,
            minFeature,
            // Set true only for the vertex-bulge density (see below). Enables
            // the XZ hard floor, which must NOT apply to the main surface.
            isBulge: false,
            yFloor: Math.min(STANDABLE_ADAPTIVE_MAX_Y_FLOOR, STANDABLE_OCCLUSION_Y_FLOOR * s),
            hardFloor: STANDABLE_OCCLUSION_HARD_FLOOR * s,
            // Depth and seed-cell caps only relax as scale rises; at scale 1
            // they're the original constants.
            // Depth must stay high enough for a steep cell to actually reach
            // its Y floor (each split halves the Y span). Dropping to 4 on a
            // heavy map guarantees under-refinement on exactly the triangles
            // that need it most, so the floor here is deliberately generous.
            maxDepth: (s <= 1.0)
                ? STANDABLE_OCCLUSION_MAX_DEPTH
                : Math.max(9, Math.round(STANDABLE_OCCLUSION_MAX_DEPTH - Math.log2(s))),
            maxSeedCells: (s <= 1.0)
                ? STANDABLE_ADAPTIVE_BASE_MAX_SEED_CELLS
                : Math.max(STANDABLE_ADAPTIVE_MIN_SEED_CELLS,
                           Math.floor(STANDABLE_ADAPTIVE_BASE_MAX_SEED_CELLS / (s * s))),
        };
    };

    // Density for the main surface (red/blue/yellow): the planned, possibly
    // coarsened scale.
    const surfaceDensity = makeDensity(localScale);

    // VERTEX BULGES ARE EXEMPT FROM ADAPTIVE COARSENING.
    //
    // The green bulges are radius-STANDABLE_CHK_DIST (1.0) circles at each
    // vertex. Their total area is tiny and bounded - three unit circles per
    // triangle regardless of how big the triangle is - so they were never a
    // meaningful part of the cost that motivated the adaptive scaling. What
    // they ARE is the most detail-sensitive geometry we emit: at a coarsened
    // yFloor/hardFloor a single centroid probe decides a piece comparable in
    // size to the whole bulge, which visibly pokes past the clip boundary
    // (exactly what STANDABLE_OCCLUSION_HARD_FLOOR was introduced to prevent).
    // So bulges always render at full density, and only the main surface pays
    // for the scene's steep-triangle count.
    const bulgeDensity = Object.assign(
        STANDABLE_ADAPTIVE_EXEMPT_BULGES ? makeDensity(1.0) : makeDensity(localScale),
        { isBulge: true }
    );

    const probeAllSame = (verts, cxs, czs) => {
        const first = validAt(cxs, czs);
        // Vertices (inset a hair toward centroid so we test interior).
        for (const v of verts) {
            const sx = v.x + (cxs - v.x) * 1e-3;
            const sz = v.z + (czs - v.z) * 1e-3;
            if (validAt(sx, sz) !== first) return { same: false, valid: first };
        }
        // Edge midpoints (also inset), to catch bands that miss all vertices.
        for (let i = 0; i < verts.length; i++) {
            const a = verts[i], b = verts[(i + 1) % verts.length];
            let mx = (a.x + b.x) * 0.5, mz = (a.z + b.z) * 0.5;
            mx += (cxs - mx) * 1e-3; mz += (czs - mz) * 1e-3;
            if (validAt(mx, mz) !== first) return { same: false, valid: first };
        }
        return { same: true, valid: first };
    };

    const refine = (pushFn, verts, minX, maxX, minZ, maxZ, depth, dens) => {
        if (verts.length < 3) return;
        if (budget && budget.remaining <= 0) return;
        if (stats) stats.refineCalls++;

        let cxs = 0, czs = 0;
        for (const v of verts) { cxs += v.x; czs += v.z; }
        cxs /= verts.length; czs /= verts.length;

        const probe = probeAllSame(verts, cxs, czs);
        if (probe.same) {
            if (probe.valid) emitPoly(pushFn, verts);
            return; // uniformly valid -> emit; uniformly invalid -> drop
        }
        // From here on this cell STRADDLES a validity boundary. Only these
        // cells say anything about refinement quality: a map with few
        // occluders legitimately has almost none, and that is not a fault.
        if (stats) stats.mixedCells++;

        const w = maxX - minX;
        const h = maxZ - minZ;
        // The refiner must resolve the validity boundary, which on these
        // surfaces is largely a function of plane-Y. On a near-vertical
        // triangle a small XZ cell still spans a huge Y range, so an XZ-only
        // stop criterion (feature size) can't clip the boundary finely no
        // matter how small FEATURE_FLOOR is in XZ - the limiting quantity is Y.
        // So the terminal test is the cell's actual plane-Y span: keep
        // splitting a MIXED leaf until either its Y span is below
        // OCCLUSION_Y_FLOOR *or* its XZ extent hits the absolute XZ floor
        // (whichever comes first), then decide the remainder by centroid. This
        // auto-adapts to steepness: flat cells stop on XZ size, steep cells keep
        // going until the Y band is thin - without over-refining flat floors.
        let cyMin = Infinity, cyMax = -Infinity;
        for (const v of verts) {
            const vy = computeYFromPlaneLocal(Nx, Ny, Nz, D, v.x, v.z);
            if (vy < cyMin) cyMin = vy;
            if (vy > cyMax) cyMax = vy;
        }
        const ySpan = cyMax - cyMin;

        const yThin = (ySpan <= dens.yFloor);

        // XZ FLOOR - applied ONLY to sub-feature-size pieces (the bulges).
        //
        // History, because this has been got wrong twice: an earlier revision
        // applied an XZ stop to EVERY cell. That was wrong. On a near-vertical
        // triangle the steepness-aware seed step already makes ordinary surface
        // cells tiny in XZ (seedX = SEED * |Ny/Nx| collapses as Ny -> 0), so a
        // blanket XZ stop fires after a couple of splits while the cell still
        // spans a large Y range, and silently coarsens the main surface.
        //
        // But the floor IS correct for pieces that START below the feature
        // size - which is precisely what STANDABLE_OCCLUSION_HARD_FLOOR was
        // declared for (see its comment). A vertex-bulge wedge is ~0.39 units
        // of arc at the rim tapering to a point; refining it in XZ until its
        // *Y* band is thin shreds it into 0.05-unit slivers on a steep face,
        // which is what "the bulge renders as a fan of thin triangles instead
        // of a cut-off oval" looks like.
        //
        // So: gate the floor on the piece being sub-feature-size to begin with.
        // Ordinary surface cells (which start at the seed step) never satisfy
        // this and are unaffected; bulge wedges do, and stop shredding.
        // Gated on an explicit per-bucket flag rather than on measured size:
        // small fragments of the MAIN surface (clipped slivers, short edge
        // strips) would also test as sub-feature, and changing their
        // refinement changes main-surface output - which is not what this fix
        // is for. Only the bulge bucket opts in.
        // BOTH axes must be below the floor, not either. A bulge wedge is
        // naturally thin in one axis (~0.39 of arc vs 1.0 of radius), so an
        // `||` here stops it after a single split while its long axis is still
        // a full bulge-radius wide - which is exactly what "the bulge extends
        // past the cutoff" looks like. `&&` keeps splitting the long axis down
        // to the floor too, snapping the bulge edge to the same boundary the
        // base surface uses (which is what HARD_FLOOR's comment describes).
        const xzExhausted = dens.isBulge && (w <= dens.hardFloor && h <= dens.hardFloor);

        // Terminal decision. For ordinary cells the Y span governs and takes
        // priority, exactly as before: keep splitting until the Y band is thin,
        // with the depth cap as the ultimate backstop. Splitting halves the Y
        // span each level (Y is linear in XZ), so the Y floor is reachable
        // within the depth cap.
        if (yThin || xzExhausted || depth >= dens.maxDepth) {
            if (stats) {
                stats.terminalLeaves++;
                // A mixed cell forced to stop while its Y band is still well
                // above the target is genuinely under-resolved. This - not the
                // raw leaf ratio - is the real quality signal.
                if (!yThin && ySpan > dens.yFloor * 2) stats.coarseTerminations++;
            }
            if (validAt(cxs, czs)) emitPoly(pushFn, verts);
            return;
        }

        // Split into up to four quadrants via a vertical then horizontal cut.
        const midX = (minX + maxX) * 0.5;
        const midZ = (minZ + maxZ) * 0.5;

        const left  = clipPolyKeep(verts, 'x', '<=', midX);
        const right = clipPolyKeep(verts, 'x', '>',  midX);

        const quads = [];
        if (left.length >= 3) {
            quads.push([clipPolyKeep(left,  'z', '<=', midZ), minX, midX, minZ, midZ]);
            quads.push([clipPolyKeep(left,  'z', '>',  midZ), minX, midX, midZ, maxZ]);
        }
        if (right.length >= 3) {
            quads.push([clipPolyKeep(right, 'z', '<=', midZ), midX, maxX, minZ, midZ]);
            quads.push([clipPolyKeep(right, 'z', '>',  midZ), midX, maxX, midZ, maxZ]);
        }
        for (const [qv, qx0, qx1, qz0, qz1] of quads) {
            refine(pushFn, qv, qx0, qx1, qz0, qz1, depth + 1, dens);
        }
    };

    // Top-clip entry point for a single (bottom-clipped, plane-lifted)
    // sub-triangle. Pre-splits into a coarse seed grid (so no probe region
    // starts too large to trust), then adaptively refines each seed cell.

    const emitTriOcclusionClipped = (pushFn, a, b, c, dens) => {
        // Whole-triangle fast path: provably no invalid area -> emit as-is,
        // no sampling (restores flat-open-floor speed).
        if (!mayBeInvalid) {
            emitPoly(pushFn, [a, b, c]);
            return;
        }
        if (stats) stats.sampledPieces++;

        const triMinX = Math.min(a.x, b.x, c.x);
        const triMaxX = Math.max(a.x, b.x, c.x);
        const triMinZ = Math.min(a.z, b.z, c.z);
        const triMaxZ = Math.max(a.z, b.z, c.z);

        const spanX = triMaxX - triMinX;
        const spanZ = triMaxZ - triMinZ;

        // For bulges, tie the Y floor to THIS piece's own plane-Y span so the
        // clip precision scales with how far the piece actually travels in Y.
        // A fixed floor can't resolve a 50-unit excursion on a near-vertical
        // face; a proportional one refines every bulge to the same relative
        // tightness. Surface pieces are unaffected.
        if (dens.isBulge && STANDABLE_BULGE_Y_FLOOR_FRACTION > 0) {
            const ay = computeYFromPlaneLocal(Nx, Ny, Nz, D, a.x, a.z);
            const by = computeYFromPlaneLocal(Nx, Ny, Nz, D, b.x, b.z);
            const cy2 = computeYFromPlaneLocal(Nx, Ny, Nz, D, c.x, c.z);
            const pieceYSpan = Math.max(ay, by, cy2) - Math.min(ay, by, cy2);
            const scaled = Math.max(
                STANDABLE_BULGE_MIN_Y_FLOOR,
                pieceYSpan * STANDABLE_BULGE_Y_FLOOR_FRACTION
            );
            if (scaled < dens.yFloor) {
                dens = Object.assign({}, dens, { yFloor: scaled });
            }
        }

        // Tell the refiner how big this piece started out. Bulge wedges start
        // well under MIN_FEATURE and get the XZ floor; ordinary surface cells
        // start at the seed step and don't. Copy the density so concurrent
        // pieces can't clobber each other's value.
        // Seed columns/rows so each seed cell is small in both XZ extent AND
        // (via the steepness-aware seed step) in Y extent.
        let nx = Math.max(1, Math.ceil(spanX / dens.seedX));
        let nz = Math.max(1, Math.ceil(spanZ / dens.seedZ));
        // Guard against an accidental explosion on a pathological triangle.
        //
        // IMPORTANT: halving nx/nz here silently STRETCHES the effective seed
        // step. A triangle wanting 20000 cells under a 1374 cap ends up probing
        // on a ~244-unit grid even though SAMPLE_SEED says 64 - and the perf
        // log still reports 64, which makes the real resolution invisible.
        // That was the actual cause of a map rendering too coarsely while every
        // logged density value looked correct.
        //
        // So the cap no longer changes the seed step. Instead it bounds how
        // many cells we probe by making each cell CHEAPER (the depth cap below
        // does that), and only as a last resort - when a single triangle wants
        // more than a hard multiple of the cap - do we coarsen, and we say so.
        const MAX_SEED_CELLS = dens.maxSeedCells;
        const wanted = nx * nz;
        if (wanted > MAX_SEED_CELLS) {
            // Allow generous overshoot: preserving the seed step matters more
            // than hitting the cell target exactly, because the step is what
            // determines whether a feature is seen at all.
            const hardCap = MAX_SEED_CELLS * STANDABLE_SEED_CAP_OVERSHOOT;
            if (wanted > hardCap) {
                while (nx * nz > hardCap && (nx > 1 || nz > 1)) {
                    if (nx >= nz) nx = Math.max(1, nx >> 1); else nz = Math.max(1, nz >> 1);
                }
                if (stats) stats.seedCapCoarsened++;
            }
        }

        // Fast path: small triangle, no seeding needed - refine directly.
        if (nx === 1 && nz === 1) {
            if (stats) stats.seedCells++;
            refine(pushFn, [a, b, c], triMinX, triMaxX, triMinZ, triMaxZ, 0, dens);
            return;
        }

        const stepX = spanX / nx;
        const stepZ = spanZ / nz;
        if (stats) {
            // Record the seed step ACTUALLY used, not the nominal one. If the
            // cap stretched it, this is where that shows up.
            const eff = Math.max(stepX, stepZ);
            if (eff > stats.maxEffSeedStep) stats.maxEffSeedStep = eff;
            stats.effSeedStepSum += eff;
            stats.effSeedStepN++;
        }
        const poly = [a, b, c];

        for (let ix = 0; ix < nx; ix++) {
            const x0 = triMinX + stepX * ix;
            const x1 = (ix === nx - 1) ? triMaxX : x0 + stepX;
            let col = clipPolyKeep(poly, 'x', '>=', x0);
            col = clipPolyKeep(col, 'x', '<=', x1);
            if (col.length < 3) continue;
            for (let iz = 0; iz < nz; iz++) {
                const z0 = triMinZ + stepZ * iz;
                const z1 = (iz === nz - 1) ? triMaxZ : z0 + stepZ;
                let cell = clipPolyKeep(col, 'z', '>=', z0);
                cell = clipPolyKeep(cell, 'z', '<=', z1);
                if (cell.length < 3) continue;
                if (stats) stats.seedCells++;
                refine(pushFn, cell, x0, x1, z0, z1, 0, dens);
                if (budget && budget.remaining <= 0) return;
            }
        }
    };

    // Wrap the four raw bucket writers so that, when occlusion clipping is on,
    // every piece the generators below produce (base triangle, vertex-bulge
    // circles, edge buffer strips) is automatically top-clipped. When it's off,
    // they pass straight through and behavior is identical to before.
    const rawGreen = pushGreen, rawRed = pushRed, rawBlue = pushBlue, rawYellow = pushYellow;
    if (occlusionClipEnabled) {
        // Green (vertex bulges) always samples at full density; the other
        // three buckets use the scene-planned (possibly coarsened) density.
        pushGreen  = (a, b, c) => emitTriOcclusionClipped(rawGreen,  a, b, c, bulgeDensity);
        pushRed    = (a, b, c) => emitTriOcclusionClipped(rawRed,    a, b, c, surfaceDensity);
        pushBlue   = (a, b, c) => emitTriOcclusionClipped(rawBlue,   a, b, c, surfaceDensity);
        pushYellow = (a, b, c) => emitTriOcclusionClipped(rawYellow, a, b, c, surfaceDensity);
    }

    // Clips a triangle down to the portion at/above cutoffY, fan-pushing
    // whatever's left (if anything) via pushFn. No-op passthrough when
    // cutoffY isn't set.
    // Clips a triangle down to the portion at/above cutoffY, fan-pushing
    // whatever's left (if anything) via pushFn. No-op passthrough when
    // cutoffY isn't set.
    //
    // NOTE: deliberately no upper bound here. The bulges legitimately extend
    // one unit in every direction from a vertex - including above the
    // triangle's own maxY - and the game's own check does the same, so
    // clipping them at maxY would delete real area (measured: ~24% of bulge
    // footprint at every steepness, since the bulge at the highest vertex is
    // centred exactly on maxY and loses its whole upper half). What bounds a
    // bulge from above is the sampled validity test, not a plane clip.
    const pushAboveCutoff = (pushFn, a, b, c) => {
        if (cutoffY === null) {
            pushFn(a, b, c);
            return;
        }
        const kept = clipPolygonByMinY([a, b, c], cutoffY);
        for (let i = 1; i < kept.length - 1; i++) {
            pushFn(kept[0], kept[i], kept[i + 1]);
        }
    };

    // Everything we render, though — including the base triangle itself — uses
    // the Y recomputed from the plane equation, not the raw stored vertex Y.
    // Those two can differ slightly due to rounding baked into the stored
    // integer collision data, and the plane-based value is what the point
    // sampler (and the original liftVertex()) actually used.
    const liftY = (v) => ({ x: v.x, y: computeYFromPlaneLocal(Nx, Ny, Nz, D, v.x, v.z), z: v.z });
    const v0 = liftY(rawV0);
    const v1 = liftY(rawV1);
    const v2 = liftY(rawV2);
    const verts = [v0, v1, v2];

    // Clips [a,b,c] against minY, sending the above-minY portion to pushRed
    // and (if belowEnabled) the below-minY portion to pushBlue.
    const pushClippedTriSplit = (a, b, c) => {
        const above = clipPolygonAboveMaxY([a, b, c], maxY);
        for (let i = 1; i < above.length - 1; i++) {
            pushYellow(above[0], above[i], above[i + 1]);
        }
        let mid = clipPolygonByMinY([a, b, c], minY);
        mid = clipPolygonByMaxY(mid, maxY);
        for (let i = 1; i < mid.length - 1; i++) {
            pushRed(mid[0], mid[i], mid[i + 1]);
        }
        const below = clipPolygonBelowMinY([a, b, c], minY);
        const keptBelow = cutoffY === null ? below : clipPolygonByMinY(below, cutoffY);
        for (let i = 1; i < keptBelow.length - 1; i++) {
            pushBlue(keptBelow[0], keptBelow[i], keptBelow[i + 1]);
        }
    };

    // 1. Base triangle (red/blue split, though it's almost always fully red
    // since its own vertices define minY).
    pushClippedTriSplit(v0, v1, v2);

    const cx = (v0.x + v1.x + v2.x) / 3;
    const cz = (v0.z + v1.z + v2.z) / 3;

    // 2. Vertex bulge: full circle of radius chkDist at each vertex (green).
    for (let vi = 0; vi < 3; vi++) {
        const center = verts[vi];
        let prev = null;
        for (let s = 0; s <= STANDABLE_CIRCLE_SEGMENTS; s++) {
            const theta = (s / STANDABLE_CIRCLE_SEGMENTS) * Math.PI * 2;
            const px = center.x + Math.cos(theta) * STANDABLE_CHK_DIST;
            const pz = center.z + Math.sin(theta) * STANDABLE_CHK_DIST;
            const p = { x: f32(px), y: computeYFromPlaneLocal(Nx, Ny, Nz, D, px, pz), z: f32(pz) };
            if (prev) pushAboveCutoff(pushGreen, center, prev, p);
            prev = p;
        }
    }

    // 3. Edge buffer strip — only for |Ny| > 0.5, matches triChkPointParaYImpl.
    if (Math.abs(Ny) > 0.5) {
        for (let ei = 0; ei < 3; ei++) {
            const a = verts[ei];
            const b = verts[(ei + 1) % 3];

            const dx = b.x - a.x;
            const dz = b.z - a.z;
            const len = Math.sqrt(dx * dx + dz * dz);
            if (len < 1e-6) continue;

            let nX = -dz / len;
            let nZ = dx / len;

            // Ensure normal points away from the triangle's centroid.
            const midX = (a.x + b.x) / 2;
            const midZ = (a.z + b.z) / 2;
            if ((nX * (cx - midX) + nZ * (cz - midZ)) > 0) {
                nX = -nX;
                nZ = -nZ;
            }

            const a2x = a.x + nX * STANDABLE_CHK_DIST;
            const a2z = a.z + nZ * STANDABLE_CHK_DIST;
            const b2x = b.x + nX * STANDABLE_CHK_DIST;
            const b2z = b.z + nZ * STANDABLE_CHK_DIST;

            const a2 = { x: f32(a2x), y: computeYFromPlaneLocal(Nx, Ny, Nz, D, a2x, a2z), z: f32(a2z) };
            const b2 = { x: f32(b2x), y: computeYFromPlaneLocal(Nx, Ny, Nz, D, b2x, b2z), z: f32(b2z) };

            pushClippedTriSplit(a, b, b2);
            pushClippedTriSplit(a, b2, a2);
        }
    }
}

// colCtx (optional): the collision context built by initColCtx +
// initializeSubdivisions in subdivisions.js (exposed as `currentColCtx` from
// parse_model.js). When provided, geometry is filtered/clipped using the
// same rules sample_points.js applies to individual sample points - see the
// comment above buildStandableSurfaceTriangles. Each triangle in
// allTriangleData should carry an `id` matching the polygon index colCtx
// was built with (falls back to array position if absent). Omit colCtx to
// fall back to the old unfiltered behavior.
//
// Returns { main, vertexBulge } - two separate Groups instead of one
// combined one, so the vertex-bulge (green) geometry can be given its own
// model entry/checkbox distinct from the red/blue/yellow main surface.
// Either can be null if that bucket produced no geometry.
export function renderStandableSurfaceXZ(allTriangleData, colCtx = null) {
    function makeBucket() {
        const positions = [];
        const indices = [];
        let vertexOffset = 0;
        const push = (a, b, c) => {
            positions.push(a.x, a.y, a.z, b.x, b.y, b.z, c.x, c.y, c.z);
            indices.push(vertexOffset, vertexOffset + 1, vertexOffset + 2);
            vertexOffset += 3;
        };
        return { positions, indices, push };
    }

    const green = makeBucket(); // vertex bulges
    const red = makeBucket();   // above minVertexY
    const blue = makeBucket();  // below minVertexY
    const yellow = makeBucket(); // at minVertexY

    // Scene-wide backstop shared across every triangle: the positions arrays
    // are global, so a per-triangle cap can't guarantee we never approach JS's
    // max array length. When this hits zero the occlusion refiner stops
    // emitting new geometry (already-decided whole triangles are unaffected).
    const budget = { remaining: STANDABLE_OCCLUSION_SCENE_TRI_BUDGET };

    // Planning pass: decide a scene-wide sample density before building
    // anything. On maps with few near-vertical standable triangles this
    // returns scale 1 and the build below is identical to the old behavior.
    // On maps with many, it coarsens every density knob together so total
    // probe count stays bounded instead of growing with the steep-triangle
    // count. It also caches the per-triangle occluder analysis, so the build
    // pass doesn't repeat that subdivision walk.
    const quality = planStandableQuality(allTriangleData, colCtx);

    // Performance instrumentation. Counters are cheap (integer increments on
    // an object already in cache); the per-triangle timing is the only part
    // with real overhead, so it's gated behind the verbose flag.
    const stats = STANDABLE_PERF_LOGGING ? {
        probes: 0,          // isSamplePointValid calls
        seedCells: 0,       // seed-grid cells handed to refine()
        refineCalls: 0,     // total refine() invocations (incl. recursion)
        terminalLeaves: 0,  // leaves decided by a single centroid probe
        emitted: 0,         // triangles pushed into the buckets
        sampledPieces: 0,   // pieces that took the sampling path at all
        mixedCells: 0,       // cells straddling a validity boundary
        coarseTerminations: 0, // mixed cells stopped while still Y-coarse
        seedCapCoarsened: 0, // triangles whose seed step had to be stretched
        maxEffSeedStep: 0,   // largest seed step actually used anywhere
        effSeedStepSum: 0,
        effSeedStepN: 0,
    } : null;

    const tPlan = _now();

    allTriangleData.forEach((tri, arrayIdx) => {
        const polyIdx = (tri.id !== undefined && tri.id !== null) ? tri.id : arrayIdx;
        const info = quality.infos ? quality.infos[arrayIdx] : null;

        if (STANDABLE_PERF_LOGGING_VERBOSE && info && info.mayBeInvalid) {
            const t0 = _now();
            const p0 = stats.probes, e0 = stats.emitted;
            buildStandableSurfaceTriangles(
                tri, green.push, red.push, blue.push, yellow.push,
                colCtx, polyIdx, budget, quality, info, stats
            );
            const dt = _now() - t0;
            // Only report triangles that actually cost something, so the log
            // stays readable on a map with thousands of polys.
            if (dt >= STANDABLE_PERF_SLOW_TRI_MS) {
                console.log(
                    `[standable]   slow tri poly=${polyIdx} Ny=${info.Ny.toFixed(4)} ` +
                    `span=${info.spanX.toFixed(0)}x${info.spanZ.toFixed(0)} ` +
                    `${dt.toFixed(1)}ms probes=${stats.probes - p0} emitted=${stats.emitted - e0}`
                );
            }
        } else {
            buildStandableSurfaceTriangles(
                tri, green.push, red.push, blue.push, yellow.push,
                colCtx, polyIdx, budget, quality, info, stats
            );
        }
    });

    if (STANDABLE_PERF_LOGGING && typeof console !== 'undefined') {
        const buildMs = _now() - tPlan;
        const steep = quality.steepCount || 0;
        const total = allTriangleData.length;
        console.log(
            `[standable] ${total} tris (${steep} needing sampling) | ` +
            `scale ${quality.scale.toFixed(2)}x` +
            (STANDABLE_ADAPTIVE_EXEMPT_BULGES ? ' (bulges exempt, 1.00x)' : '') +
            ` | seed ${quality.sampleSeed.toFixed(1)} yFloor ${quality.yFloor.toFixed(1)} ` +
            `depth ${quality.maxDepth} maxCells ${quality.maxSeedCells}`
        );
        console.log(
            `[standable] plan ${quality.planMs.toFixed(1)}ms | build ${buildMs.toFixed(1)}ms | ` +
            `probes ${stats.probes} | seedCells ${stats.seedCells} | ` +
            `refine ${stats.refineCalls} | leaves ${stats.terminalLeaves} | ` +
            `emitted ${stats.emitted}` +
            (budget.remaining <= 0 ? ' | *** TRI BUDGET EXHAUSTED ***' : '')
        );
        if (stats.probes > 0) {
            const perCell = stats.probes / Math.max(stats.seedCells, 1);
            const leafRatio = stats.terminalLeaves / Math.max(stats.refineCalls, 1);
            const effAvg = stats.effSeedStepN ? (stats.effSeedStepSum / stats.effSeedStepN) : 0;
            // Fraction of BOUNDARY cells that had to stop while still coarse in
            // Y. This is the real quality signal: it is ~0 both when the map has
            // no occluders (nothing to refine) and when refinement is doing its
            // job, and only rises when cells are genuinely being cut short.
            const coarsePct = 100 * stats.coarseTerminations / Math.max(stats.mixedCells, 1);
            console.log(
                `[standable] probes/seedCell ${perCell.toFixed(1)} | ` +
                `leaves/refine ${(leafRatio * 100).toFixed(1)}% | ` +
                `mixedCells ${stats.mixedCells} (${coarsePct.toFixed(1)}% cut short) | ` +
                `us/probe ${(buildMs * 1000 / stats.probes).toFixed(2)} | ` +
                `est@scale1 ${(quality.estAtScale1 || 0)} cells vs planned ${(quality.estAtScale || 0)}`
            );
            // Effective vs nominal seed step. These diverge when the per-
            // triangle cell cap has to stretch the grid; the nominal value
            // alone is misleading, so both are reported.
            console.log(
                `[standable] seed step nominal ${quality.sampleSeed.toFixed(1)} | ` +
                `effective avg ${effAvg.toFixed(1)} max ${stats.maxEffSeedStep.toFixed(1)} | ` +
                `capCoarsened ${stats.seedCapCoarsened} tris`
            );
            // SEED STARVATION WARNING.
            //
            // probes/seedCell near the ~7 minimum means seed cells are almost
            // always resolving uniform on the first probe, and a low
            // leaves/refine ratio means the refiner rarely reaches a terminal
            // decision. Together they mean the seed grid is too coarse for this
            // map's feature size: real detail is being skipped between probe
            // points rather than resolved. The fix is a finer seed step (raise
            // PROBE_BUDGET, or lower SEED_SCALE_EXP / MAX_SEED_STEP), NOT a
            // finer Y floor.
            // Warn only when boundary cells are actually being cut short.
            //
            // NOTE: a low leaves/refine ratio on its own means nothing. A map
            // with few occluders has almost no mixed cells, so nearly every
            // seed cell resolves uniform in one probe and the leaf ratio sits
            // near zero - while the output is completely correct. An earlier
            // version warned on that alone and produced false alarms on exactly
            // those maps.
            // Threshold is low on purpose: a map with few occluders has few
            // mixed cells in absolute terms, but those ARE its entire clip
            // boundary, so a high cut-short rate there still matters. The
            // absolute count is printed so a handful of cells reads as minor.
            if (stats.mixedCells >= 50 && coarsePct > 25) {
                console.warn(
                    `[standable] UNDER-REFINED: ${coarsePct.toFixed(1)}% of ` +
                    `${stats.mixedCells} boundary cells ` +
                    `(${stats.coarseTerminations} cells) stopped while still ` +
                    `coarse in Y (target ${quality.yFloor.toFixed(1)}). The clip ` +
                    `boundary will look blocky. Scale ${quality.scale.toFixed(2)}x, ` +
                    `depth ${quality.maxDepth}, effective seed step avg ` +
                    `${effAvg.toFixed(1)}` +
                    (stats.seedCapCoarsened > 0
                        ? `, ${stats.seedCapCoarsened} tris had their seed grid capped`
                        : '') +
                    `. Raise STANDABLE_ADAPTIVE_PROBE_BUDGET to pull scale toward 1.0.`
                );
            }
        }
    }

    function buildMesh(bucket, color, edgeColor = 0x000000) {
        if (bucket.positions.length === 0) return null;

        let geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.Float32BufferAttribute(bucket.positions, 3));
        geometry.setIndex(bucket.indices);

        // Weld coincident vertices so EdgesGeometry can tell genuine silhouette
        // edges apart from the internal seams between our overlapping circle
        // fans/strips (which are all coplanar and would otherwise all get
        // drawn as if they were boundary edges, since nothing shares vertices
        // in the raw un-indexed output above).
        geometry = mergeVertices(geometry);
        geometry.computeVertexNormals();

        const mesh = new THREE.Mesh(
            geometry,
            new THREE.MeshStandardMaterial({
                color,
                side: THREE.DoubleSide,
                flatShading: true,
                polygonOffset: true,
                polygonOffsetFactor: 4,
                polygonOffsetUnits: 4
            })
        );

        const edges = new THREE.LineSegments(
            new THREE.EdgesGeometry(geometry),
            new THREE.LineBasicMaterial({ color: edgeColor })
        );

        return { mesh, edges };
    }

    // Flat structure (mesh, edges, mesh, edges, ...) — addModelCheckbox (in
    // render.js) expects meshObj.children[0] to be a Mesh with a .material
    // directly, so nested sub-Groups per color would break its color picker.
    function buildGroup(buckets) {
        const group = new THREE.Group();
        let any = false;
        for (const bucket of buckets) {
            const built = buildMesh(bucket.data, bucket.color, bucket.edgeColor);
            if (built) {
                group.add(built.mesh);
                group.add(built.edges);
                any = true;
            }
        }
        return any ? group : null;
    }

    const vertexBulge = buildGroup([
        { data: green, color: 0x00cc44, edgeColor: 0x39ff64 }, // bright green edges: the thin vertex-bulge slivers get lost in black outlines otherwise
    ]);

    const main = buildGroup([
        { data: red, color: 0xff0000, edgeColor: 0x000000 },
        { data: blue, color: 0x0000ff, edgeColor: 0x000000 },
        { data: yellow, color: 0xffff00, edgeColor: 0x000000 },
    ]);

    return { main, vertexBulge };
}

export function renderCollisionWallsXY(allTriangleData) {
    const f32 = Math.fround;

    const positions = [];
    const indices = [];
    let vertexOffset = 0;

    allTriangleData.forEach(tri => {

        const vtxs = tri.vtxs;
        const normals = tri.normals;
        const D = f32(tri.d);

        const Nx = f32(normals[0] * COLPOLY_NORMAL_FRAC);
        const Ny = f32(normals[1] * COLPOLY_NORMAL_FRAC);
        const Nz = f32(normals[2] * COLPOLY_NORMAL_FRAC);

        // Need a valid Z solve
        if ((Math.abs(Nz) < f32(1e-12)) || (Math.abs(Ny) > 0.5) || (Math.abs(Ny) < -0.8)) 
            return;

        //
        // LIFT FUNCTION (solve Z)
        //
        function liftVertex(x, y) {
            const dot = f32(
                f32(f32(Nx * x) + f32(Ny * y)) + D
            );
            return f32(f32(-dot) / Nz);
        }

        //
        // STEP 1: Expand triangle in XY plane
        //
        let expanded = vtxs.map(v => ({ 
            x: f32(v.x), 
            y: f32(v.y) 
        }));

        if (Math.abs(Nz) > f32(0.5)) {

            // centroid
            const cx = f32(
                f32(expanded[0].x + expanded[1].x + expanded[2].x) / f32(3.0)
            );
            const cy = f32(
                f32(expanded[0].y + expanded[1].y + expanded[2].y) / f32(3.0)
            );

            expanded = expanded.map(v => {
                const dx = f32(v.x - cx);
                const dy = f32(v.y - cy);

                const len = f32(Math.sqrt(f32(f32(dx*dx) + f32(dy*dy))));

                let factor = f32(1.0);
                if (len > f32(0.0)) {
                    factor = f32(f32(len + f32(1.0)) / len);
                }

                return {
                    x: f32(cx + f32(dx * factor)),
                    y: f32(cy + f32(dy * factor))
                };
            });
        }

        //
        // STEP 2: Build the lifted 3D vertices (x,y from expanded, z solved)
        //
        const verts3 = [];
        for (let i = 0; i < 3; i++) {
            const vx = expanded[i].x;
            const vy = expanded[i].y;
            const vz = liftVertex(vx, vy);
            verts3.push({ x: vx, y: vy, z: vz });
        }

        //
        // STEP 3: Triangulate directly (no clipping)
        //
        positions.push(
            verts3[0].x, verts3[0].y, verts3[0].z,
            verts3[1].x, verts3[1].y, verts3[1].z,
            verts3[2].x, verts3[2].y, verts3[2].z
        );

        indices.push(
            vertexOffset,
            vertexOffset + 1,
            vertexOffset + 2
        );

        vertexOffset += 3;
    });

    //
    // BUILD GROUP OUTPUT (same as your original)
    //
    const group = new THREE.Group();

    if (positions.length > 0) {

        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
        geometry.setIndex(indices);
        geometry.computeVertexNormals();

        const mesh = new THREE.Mesh(
            geometry,
            new THREE.MeshStandardMaterial({
                color: 0xff0000,
                side: THREE.DoubleSide,
                flatShading: true,
                polygonOffset: true,
                polygonOffsetFactor: 4,
                polygonOffsetUnits: 4
            })
        );

        const edges = new THREE.LineSegments(
            new THREE.EdgesGeometry(geometry),
            new THREE.LineBasicMaterial({ color: 0x000000 })
        );

        group.add(mesh);
        group.add(edges);
    }

    return group;
}

export function renderCollisionWallsYZ(allTriangleData) {
    const f32 = Math.fround;

    const positions = [];
    const indices = [];
    let vertexOffset = 0;

    allTriangleData.forEach(tri => {

        const vtxs = tri.vtxs;
        const normals = tri.normals;
        const D = f32(tri.d);

        const Nx = f32(normals[0] * COLPOLY_NORMAL_FRAC);
        const Ny = f32(normals[1] * COLPOLY_NORMAL_FRAC);
        const Nz = f32(normals[2] * COLPOLY_NORMAL_FRAC);

        // Need N.x for solving X
        if ((Math.abs(Nx) < f32(1e-12)) || (Math.abs(Ny) > 0.5) || (Math.abs(Ny) < -0.8))
            return;

        //
        // LIFT (solve X from Y,Z)
        //
        function liftVertex(y, z) {
            const dot = f32(
                f32(f32(Ny * y) + f32(Nz * z)) + D
            );
            return f32(f32(-dot) / Nx);
        }

        //
        // Step 1: expand triangle in YZ
        //
        let expanded = vtxs.map(v => ({
            y: f32(v.y),
            z: f32(v.z)
        }));

        // Expand if triangle is "flat" relative to X axis
        if (Math.abs(Nx) > f32(0.5)) {

            // Centroid
            const cy = f32(
                f32(expanded[0].y + expanded[1].y + expanded[2].y) / f32(3.0)
            );
            const cz = f32(
                f32(expanded[0].z + expanded[1].z + expanded[2].z) / f32(3.0)
            );

            expanded = expanded.map(v => {
                const dy = f32(v.y - cy);
                const dz = f32(v.z - cz);

                const len = f32(Math.sqrt(f32(f32(dy*dy) + f32(dz*dz))));

                let factor = f32(1.0);
                if (len > f32(0.0)) {
                    factor = f32(f32(len + f32(1.0)) / len);
                }

                return {
                    y: f32(cy + f32(dy * factor)),
                    z: f32(cz + f32(dz * factor))
                };
            });
        }

        //
        // Step 2: lift to 3D (compute X)
        //
        const verts3 = [];
        for (let i = 0; i < 3; i++) {
            const vy = expanded[i].y;
            const vz = expanded[i].z;
            const vx = liftVertex(vy, vz);
            verts3.push({ x: vx, y: vy, z: vz });
        }

        //
        // Step 3: direct triangulation (no clipping)
        //
        positions.push(
            verts3[0].x, verts3[0].y, verts3[0].z,
            verts3[1].x, verts3[1].y, verts3[1].z,
            verts3[2].x, verts3[2].y, verts3[2].z
        );

        indices.push(
            vertexOffset,
            vertexOffset + 1,
            vertexOffset + 2
        );

        vertexOffset += 3;
    });

    //
    // BUILD GROUP (same style as the others)
    //
    const group = new THREE.Group();

    if (positions.length > 0) {

        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
        geometry.setIndex(indices);
        geometry.computeVertexNormals();

        const mesh = new THREE.Mesh(
            geometry,
            new THREE.MeshStandardMaterial({
                color: 0xff0000,
                side: THREE.DoubleSide,
                flatShading: true,
                polygonOffset: true,
                polygonOffsetFactor: 4,
                polygonOffsetUnits: 4
            })
        );

        const edges = new THREE.LineSegments(
            new THREE.EdgesGeometry(geometry),
            new THREE.LineBasicMaterial({ color: 0x000000 })
        );

        group.add(mesh);
        group.add(edges);
    }

    return group;
}