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
const STANDABLE_OCCLUSION_MAX_DEPTH = 12;

// Absolute smallest cell the refiner will split a MIXED (boundary-straddling)
// leaf down to, even below the per-axis feature size. This exists for pieces
// that START smaller than the feature size - notably the radius-1 vertex-bulge
// circle segments - which would otherwise be decided whole by a single
// centroid probe and poke a full piece-width past the clip boundary. Splitting
// them to this floor snaps the bulge edge to the same boundary the base
// surface uses. Smaller = tighter bulge clipping but more tiny triangles along
// boundaries; ~0.25 is well below the bulge radius and keeps the count modest.
const STANDABLE_OCCLUSION_HARD_FLOOR = 0.25;

// Terminal refinement threshold on a mixed cell's PLANE-Y span (world units).
// The validity boundary on these surfaces is largely a function of Y, so on a
// near-vertical triangle a cell that's tiny in XZ can still span a huge Y range
// and clip the boundary coarsely. This makes the refiner keep splitting a mixed
// cell until its Y extent is this thin (auto-adapting to steepness: flat cells
// bottom out on the XZ hard floor first, steep cells keep going until the Y
// band is narrow). This is what actually tightens the green vertex bulge in the
// invalid region. Smaller = tighter boundary but more triangles on steep faces.
const STANDABLE_OCCLUSION_Y_FLOOR = 4.0;

// Coarse seed-grid cell size (world units). The entry point pre-splits each
// triangle so no region handed to the adaptive refiner starts larger than this
// before probing. It bounds how large an invalid band can be while still
// slipping between a region's probe points: a fully-valid or fully-invalid
// seed cell is decided in one probe (cheap), and only cells straddling a
// validity boundary refine further. Smaller = safer against thin missed bands
// but more baseline probes on big surfaces; ~64 units catches Shadow-Temple-
// scale features while keeping open floors light.
const STANDABLE_OCCLUSION_SAMPLE_SEED = 64.0;

// Scene-wide safety ceiling on triangles emitted by the occlusion clip across
// ALL polygons in one renderStandableSurfaceXZ call. The positions arrays are
// scene-global, so a per-triangle cap isn't enough to guarantee we never hit
// JS's max array length; this is the real backstop. Well above what any real
// scene needs, but finite. Reset at the top of each render call.
const STANDABLE_OCCLUSION_SCENE_TRI_BUDGET = 4000000;

function buildStandableSurfaceTriangles(tri, pushGreen, pushRed, pushBlue, pushYellow, colCtx = null, polyIdx = null, budget = null) {
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
    let mayBeInvalid = false;
    if (occlusionClipEnabled) {
        // (b) steepness test: near-horizontal floors can't downward-scan-fail.
        // Ny is normalized; treat > 0.99 as flat enough to skip sampling.
        const nearFlat = Ny > f32(0.99);

        // (c) occluder presence test.
        let hasOccluder = false;
        const standableSet = colCtx.polyStandableSubdivIndices && colCtx.polyStandableSubdivIndices[polyIdx];
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
                    // A real downward occluder must sit strictly below some part
                    // of this triangle. A candidate whose entire Y range is at or
                    // above this triangle's own top can't be reached by a
                    // straight-down scan from any point on it - this also
                    // excludes coplanar same-level neighbors (e.g. adjacent
                    // floor tiles), which share cells and overlap in XZ but never
                    // occlude each other, so they must NOT force the slow path.
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

    // Validity of a single (x,z) via the point sampler's own predicate, Y taken
    // from the plane exactly as the sampler does.
    const validAt = (x, z) => {
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
    // Smallest cell we'll refine to on each axis (steepness-limited but floored
    // so a near-vertical face doesn't demand sub-unit cells and explode count).
    const FEATURE_FLOOR = 0.25;
    const featX = Math.max(FEATURE_FLOOR, Math.min(STANDABLE_OCCLUSION_MIN_FEATURE, STANDABLE_OCCLUSION_MIN_FEATURE * gradX));
    const featZ = Math.max(FEATURE_FLOOR, Math.min(STANDABLE_OCCLUSION_MIN_FEATURE, STANDABLE_OCCLUSION_MIN_FEATURE * gradZ));
    // Coarse seed step per axis: at most SAMPLE_SEED, but fine enough that a
    // seed cell spans a bounded Y range too.
    const seedX = Math.max(featX, Math.min(STANDABLE_OCCLUSION_SAMPLE_SEED, STANDABLE_OCCLUSION_SAMPLE_SEED * gradX));
    const seedZ = Math.max(featZ, Math.min(STANDABLE_OCCLUSION_SAMPLE_SEED, STANDABLE_OCCLUSION_SAMPLE_SEED * gradZ));

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

    const refine = (pushFn, verts, minX, maxX, minZ, maxZ, depth) => {
        if (verts.length < 3) return;
        if (budget && budget.remaining <= 0) return;

        let cxs = 0, czs = 0;
        for (const v of verts) { cxs += v.x; czs += v.z; }
        cxs /= verts.length; czs /= verts.length;

        const probe = probeAllSame(verts, cxs, czs);
        if (probe.same) {
            if (probe.valid) emitPoly(pushFn, verts);
            return; // uniformly valid -> emit; uniformly invalid -> drop
        }

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

        const yThin = (ySpan <= STANDABLE_OCCLUSION_Y_FLOOR);

        // Terminal decision. The Y span is the quantity that actually governs
        // the validity boundary, so it takes priority: a cell that is already
        // below the XZ floor but still spans a large Y range (a thin sliver on a
        // near-vertical face - exactly the vertex-bulge case) must KEEP
        // splitting until its Y band is thin, not stop just because it's small
        // in XZ. So we stop only when the Y band is thin, or as an ultimate
        // backstop the depth cap is hit. Splitting halves the Y span each level
        // (Y is linear in XZ), so the Y floor is reachable within the depth cap.
        if (yThin || depth >= STANDABLE_OCCLUSION_MAX_DEPTH) {
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
            refine(pushFn, qv, qx0, qx1, qz0, qz1, depth + 1);
        }
    };

    // Top-clip entry point for a single (bottom-clipped, plane-lifted)
    // sub-triangle. Pre-splits into a coarse seed grid (so no probe region
    // starts too large to trust), then adaptively refines each seed cell.

    const emitTriOcclusionClipped = (pushFn, a, b, c) => {
        // Whole-triangle fast path: provably no invalid area -> emit as-is,
        // no sampling (restores flat-open-floor speed).
        if (!mayBeInvalid) {
            emitPoly(pushFn, [a, b, c]);
            return;
        }

        const triMinX = Math.min(a.x, b.x, c.x);
        const triMaxX = Math.max(a.x, b.x, c.x);
        const triMinZ = Math.min(a.z, b.z, c.z);
        const triMaxZ = Math.max(a.z, b.z, c.z);

        const spanX = triMaxX - triMinX;
        const spanZ = triMaxZ - triMinZ;

        // Seed columns/rows so each seed cell is small in both XZ extent AND
        // (via the steepness-aware seed step) in Y extent.
        let nx = Math.max(1, Math.ceil(spanX / seedX));
        let nz = Math.max(1, Math.ceil(spanZ / seedZ));
        // Guard against an accidental explosion on a pathological triangle.
        const MAX_SEED_CELLS = 20000;
        while (nx * nz > MAX_SEED_CELLS && (nx > 1 || nz > 1)) {
            if (nx >= nz) nx = Math.max(1, nx >> 1); else nz = Math.max(1, nz >> 1);
        }

        // Fast path: small triangle, no seeding needed - refine directly.
        if (nx === 1 && nz === 1) {
            refine(pushFn, [a, b, c], triMinX, triMaxX, triMinZ, triMaxZ, 0);
            return;
        }

        const stepX = spanX / nx;
        const stepZ = spanZ / nz;
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
                refine(pushFn, cell, x0, x1, z0, z1, 0);
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
        pushGreen  = (a, b, c) => emitTriOcclusionClipped(rawGreen,  a, b, c);
        pushRed    = (a, b, c) => emitTriOcclusionClipped(rawRed,    a, b, c);
        pushBlue   = (a, b, c) => emitTriOcclusionClipped(rawBlue,   a, b, c);
        pushYellow = (a, b, c) => emitTriOcclusionClipped(rawYellow, a, b, c);
    }

    // Clips a triangle down to the portion at/above cutoffY, fan-pushing
    // whatever's left (if anything) via pushFn. No-op passthrough when
    // cutoffY isn't set.
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

    allTriangleData.forEach((tri, arrayIdx) => {
        const polyIdx = (tri.id !== undefined && tri.id !== null) ? tri.id : arrayIdx;
        buildStandableSurfaceTriangles(tri, green.push, red.push, blue.push, yellow.push, colCtx, polyIdx, budget);
    });

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
