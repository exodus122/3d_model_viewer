import * as THREE from 'three';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';
import { BGCHECK_SUBDIV_OVERLAP } from './subdivisions.js';

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

// GROUND-CLIP TEST.
// Reproduces the `planeDistA` value that CollisionPoly_LineVsPoly computes for a
// point posA, using the EXACT arithmetic the game uses:
//
//   planeDistA = (normal.x*posA.x + normal.y*posA.y + normal.z*posA.z)
//                    * COLPOLY_NORMAL_FRAC + poly->dist
//
// where normal.* are the RAW s16 components (not the unit-scaled Nx/Ny/Nz) and
// poly->dist is the integer originDist. The multiply/add order and every f32
// rounding step are preserved because the ground-clip bug lives entirely in that
// rounding: on some triangles the near-zero residue rounds to -0.000122 (which is
// < 0 and lets the raycast pass through the floor), and on others it rounds to
// 0.0 or +0.000122 (which is >= 0 and stays solid). The check in the game is
// `planeDistA < 0.0f`, so a point is ground-clippable exactly when this returns a
// value strictly less than 0.
//
// normalsRaw : tri.normals (raw s16 ints [x,y,z])
// originDist : tri.d (integer)
// (x, y, z)  : the point to test (the on-surface lifted sample point)
function groundClipPlaneDist(normalsRaw, originDist, x, y, z) {
    const rx = f32(normalsRaw[0]);
    const ry = f32(normalsRaw[1]);
    const rz = f32(normalsRaw[2]);
    const dot = f32(f32(f32(rx * f32(x)) + f32(ry * f32(y))) + f32(rz * f32(z)));
    return f32(f32(dot * COLPOLY_NORMAL_FRAC) + f32(originDist));
}

// Sutherland-Hodgman clip of an {x,y,z} polygon against one XZ half-plane
// defined by a scalar function side(x,z): keep vertices where keepPositive
// ? side>=0 : side<=0. At crossings, position is interpolated in XZ and Y is
// re-lifted onto the surface plane via liftFn(x,z) so the kept polygon stays
// flush on the standable triangle.
// mode:
//   true / 'geq'   keep s >= 0   (default)
//   false / 'leq'  keep s <= 0
//   'lt'           keep s <  0   (strict; boundary dropped)
//   'gte0'         keep s >= 0   (explicit partner of 'lt')
// The boolean form is what existing callers use. The 'lt'/'gte0' strict pair is
// available for an exact, gapless partition but the ground-clip split now uses
// a bounded region classifier (classifyRegionGroundClip) instead, so nothing calls
// them by default — they're kept for reuse.
function clipPolyXZByFn(verts, sideFn, keepMode, liftFn) {
    if (verts.length < 3) return [];
    const out = [];
    const n = verts.length;
    let keep;
    if (keepMode === true || keepMode === 'geq' || keepMode === 'gte0') keep = (s) => s >= 0;
    else if (keepMode === 'lt') keep = (s) => s < 0;
    else keep = (s) => s <= 0; // false / 'leq'
    let sPrev = sideFn(verts[0].x, verts[0].z);
    for (let i = 0; i < n; i++) {
        const a = verts[i], b = verts[(i + 1) % n];
        const sa = (i === 0) ? sPrev : sideFn(a.x, a.z);
        const sb = sideFn(b.x, b.z);
        const aIn = keep(sa), bIn = keep(sb);
        if (aIn) out.push(a);
        if (aIn !== bIn) {
            const t = sa / (sa - sb); // crossing param along edge a->b
            const x = a.x + (b.x - a.x) * t;
            const z = a.z + (b.z - a.z) * t;
            out.push(liftFn(x, z));
        }
    }
    return out;
}

// The ground-clip stripe pattern flips on the order of ~0.07 world units (one
// f32 ULP of the planeDist accumulator maps to that much XZ movement). We can't
// resolve those stripes as geometry — a single above-region can be tens of
// millions of cells at that pitch — and they're far finer than a pixel anyway.
// Instead we answer one boolean per region: does ANY point in it clip? To find
// that reliably we must sample finer than the stripe pitch, but with a hard cap
// so a large/steep region can't blow up. GROUNDCLIP_SAMPLE_STEP is the ideal
// spacing; GROUNDCLIP_MAX_SAMPLES caps the total, coarsening the effective step
// if the region is big. Because clip and non-clip stripes alternate densely, a
// capped grid still lands on clip stripes wherever they exist.
const GROUNDCLIP_SAMPLE_STEP = 0.02;
const GROUNDCLIP_MAX_SAMPLES = 4096; // 64x64 worst case

// Standard even-odd point-in-polygon test in XZ.
function pointInPolyXZ(x, z, poly) {
    let inside = false;
    const n = poly.length;
    for (let i = 0, j = n - 1; i < n; j = i++) {
        const xi = poly[i].x, zi = poly[i].z;
        const xj = poly[j].x, zj = poly[j].z;
        if (((zi > z) !== (zj > z)) &&
            (x < (xj - xi) * (z - zi) / (zj - zi) + xi)) {
            inside = !inside;
        }
    }
    return inside;
}

// Ground-clip duty-cycle thresholds. The clippable set is always a fine stripe
// pattern (~0.07u); what varies between regions is the *fraction* of the stripe
// period that clips (the duty cycle), and that fraction is a stable property of
// the region, not sampling noise. Empirically: safe regions sit near 0%, "solid"
// clip regions ~85%+, and coin-flip regions in between. We bucket into three:
//   fraction <  SAFE   -> not clippable (red)
//   fraction >= SOLID  -> near-always clippable (yellow)
//   in between         -> partial / position-dependent clip (orange)
const GROUNDCLIP_FRAC_SAFE = 0.02;   // below this, treat as non-clippable
const GROUNDCLIP_FRAC_SOLID = 0.70;  // at/above this, treat as solid clip

// Bucket ids returned by classifyRegionGroundClip.
const GC_SAFE = 0;    // -> red
const GC_PARTIAL = 1; // -> orange
const GC_SOLID = 2;   // -> yellow

// REGION GROUND-CLIP CLASSIFIER (3-way by duty cycle).
// Samples `poly` on a bounded grid and returns the fraction of interior samples
// that are ground-clippable (sideFn < 0, the exact f32 planeDist at the floor-
// snapped surface point), then maps that fraction to GC_SAFE / GC_PARTIAL /
// GC_SOLID. Grid is sized by GROUNDCLIP_SAMPLE_STEP but capped to
// GROUNDCLIP_MAX_SAMPLES total points, so cost is O(1)-bounded per region.
// Because the fraction (duty cycle) is resolution-stable, a modest sample count
// gives a reliable bucket. Returns an object { bucket, fraction, samples }.
function classifyRegionGroundClip(poly, sideFn) {
    if (poly.length < 3) return { bucket: GC_SAFE, fraction: 0, samples: 0 };

    let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
    for (const p of poly) {
        if (p.x < minX) minX = p.x;
        if (p.x > maxX) maxX = p.x;
        if (p.z < minZ) minZ = p.z;
        if (p.z > maxZ) maxZ = p.z;
    }
    const spanX = maxX - minX;
    const spanZ = maxZ - minZ;

    let clip = 0, total = 0;

    if (spanX > 0 && spanZ > 0) {
        let nx = Math.max(2, Math.ceil(spanX / GROUNDCLIP_SAMPLE_STEP));
        let nz = Math.max(2, Math.ceil(spanZ / GROUNDCLIP_SAMPLE_STEP));
        if (nx * nz > GROUNDCLIP_MAX_SAMPLES) {
            const scale = Math.sqrt(GROUNDCLIP_MAX_SAMPLES / (nx * nz));
            nx = Math.max(2, Math.floor(nx * scale));
            nz = Math.max(2, Math.floor(nz * scale));
        }
        const stepX = spanX / nx;
        const stepZ = spanZ / nz;
        for (let ix = 0; ix < nx; ix++) {
            const cx = minX + (ix + 0.5) * stepX;
            for (let iz = 0; iz < nz; iz++) {
                const cz = minZ + (iz + 0.5) * stepZ;
                if (!pointInPolyXZ(cx, cz, poly)) continue;
                total++;
                if (sideFn(cx, cz) < 0) clip++;
            }
        }
    }

    // Fallback for slivers the interior grid may miss entirely: probe vertices.
    if (total === 0) {
        for (const p of poly) {
            total++;
            if (sideFn(p.x, p.z) < 0) clip++;
        }
    }

    const fraction = total > 0 ? clip / total : 0;
    let bucket;
    if (fraction < GROUNDCLIP_FRAC_SAFE) bucket = GC_SAFE;
    else if (fraction >= GROUNDCLIP_FRAC_SOLID) bucket = GC_SOLID;
    else bucket = GC_PARTIAL;
    return { bucket, fraction, samples: total };
}


// Maximum surviving pieces per standable triangle. The subtract-a-convex-region
// operation can split a polygon once per cutter half-plane, so without a cap a
// column with many overhead polys multiplies pieces without bound (this is what
// made the first top-cut attempt hang rather than merely run slow). When the cap
// is hit we stop cutting and keep what we have - slightly under-cut geometry is
// far better than a frozen load.
const TOPCUT_MAX_PIECES = 64;

// Only surfaces steeper than this get the subdivision-based clipping. Above it
// the 1/Ny lift is tame enough that the rendered geometry never leaves the
// triangle's own registered cells, so clipping would only fragment a floor that
// was already correct. 0.5 matches subdivisions.js's floor/wall split, so
// "floor" and "not clipped" mean the same thing.
const TOPCUT_MAX_SURFACE_NY = 0.5;

// Maximum cutters gathered per standable triangle. Guards against a pathological
// column (tall cells, dense geometry above) handing the clipper an unbounded
// candidate list.
const TOPCUT_MAX_CUTTERS = 48;

// Apply cutters in sequence, each further trimming all surviving pieces.
// `cutters` should already be XZ-rejected against this triangle (see
// gatherTopCutters). Returns polygons ready to fan-triangulate.
//
// EQUIVALENCE WITH THE POINT SAMPLER
// ----------------------------------
// This reproduces sample_points.js's isSamplePointValid analytically, so the
// rendered surface matches the sampled points exactly without paying for
// per-point sampling (which is what made the sampled view laggy and gave it
// ragged, dithered edges instead of clean cuts).
//
// isSamplePointValid rejects a point on three independent grounds. Each one is
// a region bounded by AXIS-ALIGNED PLANES, so each is a plain polygon clip:
//
//   Gate 1  y < triMinVertexY - BGCHECK_SUBDIV_OVERLAP
//           -> one horizontal plane. Already applied upstream via `cutoffY`
//              in buildStandableSurfaceTriangles, so it is not repeated here.
//
//   Gate 2  the point's own subdivision cell is not in the triangle's
//           registered set, AND no registered cell lies below it in the same
//           (sx,sz) column.
//           -> the surviving band in each column is bounded above by the top of
//              that column's highest registered cell, so this is a horizontal
//              clip at a subdivision cell boundary, per column.
//
//   Gate 3  scanning down from the point's cell to the triangle's topmost
//           registered cell in that column, some OTHER standable poly is found
//           whose polyWorldYRange.max <= y and whose polyWorldXZBounds contains
//           (x,z).
//           -> note this tests AXIS-ALIGNED BOUNDING BOXES, not the blocker's
//              actual triangle footprint or its plane. Subtracting a box from a
//              polygon is four vertical half-plane clips plus one horizontal
//              one.
//
// The earlier implementation of this function cut against each cutter's exact
// triangle footprint and its exact (unbounded) plane. That is a different
// region from what the sampler tests, which is why steep triangles kept their
// bulges: a neighbour could contain the bulge inside its AABB while sharing no
// footprint area at all, so the footprint clip found nothing to do.
function cutTriangleTopAll(a, b, c, topCut, tnx, tny, tnz, td, liftFn, colCtx) {
    if (!topCut) return [[a, b, c]];
    const { blockers, columnBand } = topCut;
    if (!columnBand || !colCtx || !colCtx.subdivLength || !colCtx.minBounds) {
        return [[a, b, c]];
    }

    const SLx = colCtx.subdivLength.x, SLy = colCtx.subdivLength.y, SLz = colCtx.subdivLength.z;
    const mb = colCtx.minBounds;

    // The sampler's structure (isSamplePointValid) is:
    //
    //   if (point's own cell is registered) -> VALID, and the occlusion scan
    //                                          never runs;
    //   else if (a registered cell lies below in this column) -> run occlusion;
    //   else -> INVALID.
    //
    // So the surface splits into two regions that are treated differently, and
    // gate 3 applies to only ONE of them. Applying blockers to the whole
    // triangle (as an earlier version did) wrongly deleted the parts sitting in
    // the triangle's own registered cells - which is most of a steep triangle,
    // since a large coplanar floor under its bottom edge satisfies the
    // yMax <= y blocker test almost everywhere.
    //
    // Both regions are unions of axis-aligned cell boxes, so both are built by
    // clipping a copy of the triangle to each cell and collecting the pieces.
    const out = [];

    for (const [key, band] of columnBand) {
        const comma = key.indexOf(',');
        const xi = +key.slice(0, comma), zi = +key.slice(comma + 1);

        // UNPADDED column slab in XZ. This must be the raw cell range, not the
        // overlap-padded one from getSubdivisionCellBounds.
        //
        // The padding belongs to REGISTRATION (deciding which cells a poly is
        // listed in - a poly near a border is registered in both neighbours).
        // The point->cell mapping the sampler actually uses,
        // getPointSubdivisionIndex, simply truncates, so every point belongs to
        // exactly ONE cell and the cells TILE.
        //
        // Clipping is a partition, not a coverage test: if we clip a fresh copy
        // of the triangle to each PADDED column, the 2*OVERLAP-wide strip shared
        // by neighbouring columns gets emitted once per column. On tri 1571
        // (registered across sx 11-12 and sz 21-23, whose padded ranges overlap
        // by 100 units in both axes) that produced 4 overlapping pieces totalling
        // 1.32x the triangle's own area - visible as several differently-cut
        // copies of the same region stacked on top of each other.
        const xmin = f32(f32(SLx * xi) + mb.x);
        const xmax = f32(xmin + SLx);
        const zmin = f32(f32(SLz * zi) + mb.z);
        const zmax = f32(zmin + SLz);

        let slab = [a, b, c];
        slab = clipPolyXZByFn(slab, (x) => x - xmin, true, liftFn);
        slab = clipPolyXZByFn(slab, (x) => xmax - x, true, liftFn);
        slab = clipPolyXZByFn(slab, (x, z) => z - zmin, true, liftFn);
        slab = clipPolyXZByFn(slab, (x, z) => zmax - z, true, liftFn);
        if (slab.length < 3) continue;

        // REGION A: inside the registered cells themselves -> kept outright,
        // no blocker test (the sampler returns true before scanning).
        // Cell membership for a POINT uses getPointSubdivisionIndex, which
        // truncates and does NOT apply BGCHECK_SUBDIV_OVERLAP - sample_points.js
        // says so explicitly (it tried the padded bounds and got false
        // positives). Registration is padded; the lookup is not. So the band's
        // world extent here is the raw cell range, with no pad.
        // getPointSubdivisionIndex CLAMPS the computed index into
        // [0, subdivAmount-1], so a point below the grid's minBounds.y still
        // maps to slice 0, and a point above the top still maps to the last
        // slice. Mirror that here: the lowest band extends down to -Infinity and
        // the highest up to +Infinity, otherwise geometry hanging outside the
        // scene bounds (tri 1571 reaches y=-283 against a minBounds.y of -157)
        // gets clipped away even though the sampler accepts it.
        const regLoY = (band.lo <= 0)
            ? -Infinity
            : f32(mb.y + f32(SLy * band.lo));
        const regHiY = (band.hi >= colCtx.subdivAmount.y - 1)
            ? Infinity
            : f32(mb.y + f32(SLy * (band.hi + 1)));

        let inReg = clipPolyToMaxSurfaceY(slab, regHiY, tnx, tny, tnz, td, liftFn);
        inReg = clipPolyToMinSurfaceY(inReg, regLoY, tnx, tny, tnz, td, liftFn);
        if (inReg.length >= 3) out.push(inReg);

        // REGION B: above the registered band but still in this column. Here a
        // registered cell does lie below, so the occlusion scan runs and the
        // blockers apply. Bounded above by the top of the highest cell that can
        // still see a registered cell below it - the sampler's downward scan
        // imposes no ceiling of its own beyond the column, so this is the rest
        // of the column above regHiY.
        let above = clipPolyToMinSurfaceY(slab, regHiY, tnx, tny, tnz, td, liftFn);
        if (above.length >= 3) {
            let pieces = [above];
            for (const blocker of blockers) {
                if (pieces.length === 0) break;
                // Only blockers reached through THIS column apply here.
                if (blocker.col !== key) continue;
                const next = [];
                for (const p of pieces) {
                    const cut = cutPolyByBlockerBox(p, blocker, tnx, tny, tnz, td, liftFn);
                    for (const q of cut) next.push(q);
                }
                pieces = next;
                if (pieces.length > TOPCUT_MAX_PIECES) break;
            }
            for (const p of pieces) if (p.length >= 3) out.push(p);
        }

        if (out.length > TOPCUT_MAX_PIECES) break;
    }

    // DE-DUPLICATE. Columns are padded by BGCHECK_SUBDIV_OVERLAP on every side,
    // so when a triangle is smaller than that pad along an axis (tri 1580 spans
    // only 8 units in Z against a 50-unit pad) several adjacent columns each
    // contain it whole and emit byte-identical pieces. Rendering those stacks
    // duplicate coplanar geometry, which z-fights and - because every edge is
    // then covered an even number of times - erases the computed outline.
    if (out.length < 2) return out;
    const seenPieces = new Set();
    const deduped = [];
    for (const poly of out) {
        let key = '';
        for (const v of poly) {
            key += v.x.toFixed(3) + ',' + v.y.toFixed(3) + ',' + v.z.toFixed(3) + ';';
        }
        if (seenPieces.has(key)) continue;
        seenPieces.add(key);
        deduped.push(poly);
    }
    return deduped;
}

// Mirror of clipPolyToMaxSurfaceY keeping the portion at or ABOVE floorY.
function clipPolyToMinSurfaceY(poly, floorY, tnx, tny, tnz, td, liftFn) {
    if (!poly || poly.length < 3) return [];
    if (floorY === -Infinity) return poly;
    const side = (x, z) => computeYFromPlaneLocal(tnx, tny, tnz, td, x, z) - floorY;
    return clipPolyXZByFn(poly, side, true, liftFn);
}

// Clip `poly` to the region where the surface stays at or below `capY`.
// Because the polygon lies on the surface plane, "surface height <= capY" is a
// half-plane in XZ, so this is a single Sutherland-Hodgman pass with the
// crossing re-lifted onto the surface (keeping the cut flush).
//
// For a near-horizontal surface the boundary line runs off to infinity and the
// clip is a no-op; for a steep one it is a clean straight cut, which is exactly
// the behaviour that was wanted in place of sampling.
function clipPolyToMaxSurfaceY(poly, capY, tnx, tny, tnz, td, liftFn) {
    if (!poly || poly.length < 3) return [];
    if (!(capY > -Infinity) || capY === Infinity) return poly;
    const side = (x, z) => capY - computeYFromPlaneLocal(tnx, tny, tnz, td, x, z);
    return clipPolyXZByFn(poly, side, true, liftFn); // keep capY - yT >= 0
}

// GATE 3, for one blocker: subtract the blocker's AABB column from `poly`.
//
// The removed region is { (x,z) inside [minX,maxX]x[minZ,maxZ] } AND
// { surfaceY >= blockerYMax }. Both are half-plane intersections, so the
// subtraction walks them the same way cutPolyTop does: whatever falls OUTSIDE a
// half-plane can never be in the removed region and is kept immediately; only
// the carry is split further. Emits at most 5 pieces and never re-splits a
// kept piece.
function cutPolyByBlockerBox(poly0, blocker, tnx, tny, tnz, td, liftFn) {
    const kept = [];
    let carry = poly0;

    // Four vertical half-planes of the AABB footprint.
    const edges = [
        { fn: (x) => x - blocker.minX },   // inside: x >= minX
        { fn: (x) => blocker.maxX - x },   // inside: x <= maxX
        { fn: (x, z) => z - blocker.minZ },
        { fn: (x, z) => blocker.maxZ - z },
    ];
    for (let i = 0; i < edges.length; i++) {
        if (!carry || carry.length < 3) break;
        const side = (i < 2)
            ? ((x, z) => edges[i].fn(x, z))
            : ((x, z) => edges[i].fn(x, z));
        const outside = clipPolyXZByFn(carry, side, false, liftFn); // side <= 0
        if (outside.length >= 3) kept.push(outside);
        carry = clipPolyXZByFn(carry, side, true, liftFn);          // side >= 0
    }

    // Horizontal half-plane. Two conditions must BOTH hold for occlusion:
    //   (a) the blocker's top is at or below the surface (yMax <= y), matching
    //       isSamplePointValid's `yRange.max > y -> not a blocker`; and
    //   (b) the surface point's own cell is at or above the cell slice where
    //       this blocker was found - the sampler scans only from the point's own
    //       cell downwards, so it would never encounter a blocker living above
    //       the point.
    // The effective occlusion floor is therefore the HIGHER of the two. Without
    // (b), a flat floor sitting at the triangle's own band (e.g. the y=60 floors
    // under tri 1580's vertex) deletes the whole bulge above it, because every
    // bulge point trivially satisfies y >= yMax.
    if (carry && carry.length >= 3) {
        const floorY = (blocker.cellLoY !== undefined && blocker.cellLoY > blocker.yMax)
            ? blocker.cellLoY
            : blocker.yMax;
        const under = clipPolyToMaxSurfaceY(carry, floorY, tnx, tny, tnz, td, liftFn);
        if (under.length >= 3) kept.push(under);
        // the rest (surface at/above the blocker's top, inside its box) is
        // occluded -> dropped
    }

    return kept;
}

// ============================================================================
// CUTTER GATHER (the only colCtx-dependent layer).
//
// Finds non-ceiling polygons registered in a subdivision cell that sits ABOVE
// (same XZ column, higher Y-slice) a cell this standable triangle is registered
// in, and returns them as {nx,ny,nz,d,foot} cutters for the top-cut core.
//
// Grid layout (from subdivisions.js initColCtx): cells are a flat array indexed
//   index = zi*(subdivAmount.x*subdivAmount.y) + yi*subdivAmount.x + xi
// so a cell's (xi,yi,zi) is recoverable from its index, and "above over the same
// column" == same (xi,zi), higher yi. Each cell lists floors[], walls[],
// ceilings[], standable[] (poly indices). Ceilings are excluded here (a
// downward-facing overhang shouldn't cut a floor); we take floors+walls, which
// together are every non-ceiling poly the cell holds.
// ============================================================================
function gatherTopCutters(colCtx, polyIdx, triMinX, triMaxX, triMinZ, triMaxZ) {
    const EMPTY = { blockers: [], columnBand: null };
    if (!colCtx || polyIdx === undefined || polyIdx === null) return EMPTY;
    const subs = colCtx.subdivisions;
    const amt = colCtx.subdivAmount;
    const standableSet = colCtx.polyStandableSubdivIndices && colCtx.polyStandableSubdivIndices[polyIdx];
    // Mirrors isSamplePointValid: a poly never registered as standable ground
    // anywhere is entirely invalid, not merely uncut. Signal that to the caller.
    if (!subs || !amt || !standableSet) return { blockers: [], columnBand: new Map() };

    const AX = amt.x, AY = amt.y, AZ = amt.z;
    const AXY = AX * AY;

    // ---- GATE 2: per-column registered band. ----
    //
    // isSamplePointValid accepts a point when its own cell is registered, or
    // when a registered cell lies BELOW it in the same (sx,sz) column. So in
    // each column the valid band runs from the lowest registered cell up to the
    // top of the highest, and a point outside that band is rejected.
    //
    // This is per-column and two-sided. An earlier attempt used a single global
    // cap (the top of the highest registered cell anywhere) and it was wrong in
    // both directions: it kept points sitting in a column whose registered cells
    // are all ABOVE them - the downward scan finds nothing, so the sampler
    // rejects - and it applied one column's ceiling to every other column.
    //
    // Cell bounds use the overlap-padded values from subdivisions.js's
    // getSubdivisionCellBounds, matching how registration itself was done.
    const columnBand = new Map(); // "sx,sz" -> { lo, hi } registered sy range
    for (const regIndex of standableSet) {
        const zi = Math.floor(regIndex / AXY);
        const rem = regIndex - zi * AXY;
        const yi = Math.floor(rem / AX);
        const xi = rem - yi * AX;
        const key = xi + ',' + zi;
        const b = columnBand.get(key);
        if (!b) columnBand.set(key, { lo: yi, hi: yi });
        else { if (yi < b.lo) b.lo = yi; if (yi > b.hi) b.hi = yi; }
    }

    // ---- GATE 3: occluding standable polys. ----
    //
    // The sampler scans from the point's cell down to the triangle's topmost
    // registered cell in that column, consulting each cell's .standable list.
    // We gather the union over every column the triangle occupies, then subtract
    // each candidate as an AABB.
    //
    // .standable is the list the sampler uses: the Ny > 0 set, which excludes
    // downward-facing overhangs bucketed as "walls" (Ny in -0.8..0) that cannot
    // catch a falling character. Using .floors/.walls here would be a different
    // set.
    const blockers = [];
    const seen = new Set();
    const mbY = colCtx.minBounds ? colCtx.minBounds.y : 0;
    const SLyLocal = colCtx.subdivLength ? colCtx.subdivLength.y : 0;
    const yRanges = colCtx.polyWorldYRange;
    const xzBounds = colCtx.polyWorldXZBounds;

    // Walk only the cells of the columns this triangle occupies, above each
    // column's registered band. Scanning the whole subdivision array here was
    // O(cells) per triangle, which dominated load time on real scenes.
    for (const [key, bandHere] of columnBand) {
      const comma = key.indexOf(',');
      const xi = +key.slice(0, comma), zi = +key.slice(comma + 1);
      // Start strictly ABOVE the column's HIGHEST registered slice, not its
      // lowest. The sampler's occlusion loop runs `for (s = sy; s > t; s--)`
      // where t is the nearest registered cell below the point, so it only ever
      // visits cells above the registered band - it never looks inside it.
      // Starting at lo+1 scanned cells within the band itself and picked up the
      // floors living there (Kokiri Forest: tri 1580 is registered in sy 0..1,
      // and the y=60 floors sit in sy=1), which then cut the bulge at the
      // sy=1/sy=2 boundary, y=179.
      for (let yi = bandHere.hi + 1; yi < AY; yi++) {
        const ci = zi * AXY + yi * AX + xi;
        const cell = subs[ci];
        if (!cell || !cell.standable || cell.standable.length === 0) continue;
        // The sampler scans from the point's own cell DOWN TO (exclusive) the
        // nearest registered cell below it, so an occluder must sit strictly
        // ABOVE that registered cell - i.e. above the column's LOW registered
        // slice. Cells at or below `lo` are never visited: that is why the
        // coplanar floors under a steep triangle's bottom edge (e.g. the y=-40
        // floors beneath tri 2970) correctly fail to cut it, even though they
        // satisfy the yMax <= y blocker test everywhere on the surface.

        for (const p of cell.standable) {
            if (p === polyIdx) continue;
            // Keyed by column too: the same poly reached through a different
            // column has a different scan range, so it is a distinct blocker.
            const seenKey = p + '@' + key;
            if (seen.has(seenKey)) continue;
            seen.add(seenKey);

            // The sampler treats missing data as "is a blocker", but without a
            // box there is no region to subtract, so such a candidate cannot be
            // expressed as a clip. Skip it: under-cutting beats deleting the
            // whole surface.
            const yr = yRanges && yRanges[p];
            const b = xzBounds && xzBounds[p];
            if (!yr || !b) continue;

            // CHEAP XZ REJECT against the triangle's bulge-expanded bounds.
            if (b.maxX < triMinX || b.minX > triMaxX ||
                b.maxZ < triMinZ || b.minZ > triMaxZ) continue;

            // The sampler only ever meets this candidate while scanning cells
            // strictly above the triangle's registered cell in that column, and
            // it only counts as a blocker where yMax <= y. So a candidate whose
            // top lies at or below the bottom of the registered band can never
            // occlude: every surface point at or above it is in a cell the scan
            // does not reach.
            //
            // Without this a large flat floor sharing the triangle's own low
            // slice (e.g. the y=-40 floors under tri 2970's bottom edge) gets
            // admitted through some far-away cell of its own that happens to sit
            // above the band, and then wrongly deletes almost the whole surface.
            const bandFloorY = f32(
                f32(colCtx.minBounds.y + f32(colCtx.subdivLength.y * bandHere.lo))
                - BGCHECK_SUBDIV_OVERLAP
            );
            if (f32(yr.max) <= bandFloorY) continue;

            // Record which cell slice this candidate was found in, and in which
            // column. The sampler only ever sees a candidate while scanning the
            // cells BETWEEN the point and the registered cell below it, so a
            // blocker found in slice `yi` can only occlude points whose own cell
            // is at or above `yi`. Applying it to the whole column instead (as an
            // earlier version did) let the flat floors sitting at the triangle's
            // own band delete the entire bulge above them.
            blockers.push({
                minX: f32(b.minX), maxX: f32(b.maxX),
                minZ: f32(b.minZ), maxZ: f32(b.maxZ),
                yMax: f32(yr.max),
                cellLoY: f32(f32(mbY + f32(SLyLocal * yi))),
                col: key,
            });
            if (blockers.length >= TOPCUT_MAX_CUTTERS) {
                return { blockers, columnBand };
            }
        }
      }
    }

    return { blockers, columnBand };

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
function buildStandableSurfaceTriangles(tri, pushGreen, pushRed, pushBlue, pushYellow, pushOrange, colCtx = null, polyIdx = null) {
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

    // TOP-CUT SETUP. Gather non-ceiling polys overhead of this triangle and, if
    // any, wrap the push buckets so every emitted triangle (base, vertex bulge,
    // edge strip) is first trimmed to the parts NOT overhung. When there are no
    // cutters (the common case) the wrappers are the raw pushers and behavior is
    // identical to before.
    // Triangle XZ bounds, expanded by the edge/vertex bulge radius so cutters
    // that only overlap the bulge geometry are still gathered.
    const tcMinX = Math.min(rawV0.x, rawV1.x, rawV2.x) - STANDABLE_CHK_DIST;
    const tcMaxX = Math.max(rawV0.x, rawV1.x, rawV2.x) + STANDABLE_CHK_DIST;
    const tcMinZ = Math.min(rawV0.z, rawV1.z, rawV2.z) - STANDABLE_CHK_DIST;
    const tcMaxZ = Math.max(rawV0.z, rawV1.z, rawV2.z) + STANDABLE_CHK_DIST;
    // NEAR-VERTICAL ONLY. All of the subdivision-based clipping below exists to
    // tame the plane-equation blowup on a steep poly: the rendered geometry is
    // lifted through 1/Ny, so on a near-vertical triangle a 1-unit XZ expansion
    // swings Y by hundreds or thousands of units and pokes far outside the
    // triangle's real extent (tri 1580: Ny = 0.00052, 1/Ny = 1927).
    //
    // A substantially horizontal floor has no such blowup - its rendered
    // geometry stays within a unit or two of its own vertices, always inside its
    // own registered cells - so the clip can only ever chop it into pieces along
    // subdivision boundaries for no visual gain. Those floors rendered correctly
    // before any of this existed, so skip them entirely and leave them whole.
    const isNearVertical = Math.abs(Ny) < TOPCUT_MAX_SURFACE_NY;
    const topCut = isNearVertical
        ? gatherTopCutters(colCtx, polyIdx, tcMinX, tcMaxX, tcMinZ, tcMaxZ)
        : null;
    const liftOnSurface = (x, z) => ({ x: f32(x), y: computeYFromPlaneLocal(Nx, Ny, Nz, D, x, z), z: f32(z) });
    // Nothing to do only when there are no blockers AND no finite column cap.
    const topCutActive = topCut &&
        (topCut.blockers.length > 0 || (topCut.columnBand && topCut.columnBand.size > 0));
    const wrapCut = (rawPush) => {
        if (!topCutActive) return rawPush;
        return (a, b, c) => {
            const pieces = cutTriangleTopAll(a, b, c, topCut, Nx, Ny, Nz, D, liftOnSurface, colCtx);
            for (const poly of pieces) {
                for (let i = 1; i < poly.length - 1; i++) {
                    rawPush(poly[0], poly[i], poly[i + 1]);
                }
            }
        };
    };
    pushGreen  = wrapCut(pushGreen);
    pushRed    = wrapCut(pushRed);
    pushBlue   = wrapCut(pushBlue);
    pushYellow = wrapCut(pushYellow);
    pushOrange = wrapCut(pushOrange);

    // Clips [a,b,c] against minY, sending the above-minY portion to pushRed
    // and (if belowEnabled) the below-minY portion to pushBlue.
    // Ground-clip predicate for a point at (x, z): lift it onto this triangle's
    // plane, then evaluate the game's exact f32 planeDist. Negative => the
    // downward raycast's posA reads below the plane => ground-clippable.
    const groundClipSide = (x, z) => {
        const yOnPlane = computeYFromPlaneLocal(Nx, Ny, Nz, D, x, z);
        return groundClipPlaneDist(normals, tri.d, f32(x), yOnPlane, f32(z));
    };
    // Re-lift a point onto the surface (used at clip crossings so cut edges stay
    // flush on the plane, matching liftOnSurface elsewhere).
    const liftSurf = (x, z) => ({ x: f32(x), y: computeYFromPlaneLocal(Nx, Ny, Nz, D, x, z), z: f32(z) });

    const pushClippedTriSplit = (a, b, c) => {
        // Route a region to red / orange / yellow by its ground-clip duty cycle.
        // The clippable set is always a fine stripe pattern (~0.07u); what varies
        // is the fraction of the region that clips. classifyRegionGroundClip
        // samples on a bounded grid (O(1) cost) and returns:
        //   GC_SAFE    (~0% clip)      -> red    (not clippable)
        //   GC_PARTIAL (in between)    -> orange (position-dependent coin-flip)
        //   GC_SOLID   (~85%+ clip)    -> yellow (near-always clippable)
        // This is done per height-region rather than per cell because the stripes
        // are sub-pixel and can't be tessellated as geometry.
        const emitByClip = (poly) => {
            if (poly.length < 3) return;
            const { bucket } = classifyRegionGroundClip(poly, groundClipSide);
            const push = bucket === GC_SOLID ? pushYellow
                       : bucket === GC_PARTIAL ? pushOrange
                       : pushRed;
            for (let i = 1; i < poly.length - 1; i++) {
                push(poly[0], poly[i], poly[i + 1]);
            }
        };

        // ABOVE the highest vertex.
        const above = clipPolygonAboveMaxY([a, b, c], maxY);
        emitByClip(above);

        // MIDDLE BAND (between lowest and highest vertex). Ground clips are NOT
        // confined to the above-highest-vertex region — the stripes are a
        // property of the f32 rounding at each (x,z), not of the vertex heights.
        // The above band is usually densest, but the middle can carry real clip
        // area too (TRI 337's middle is ~25% clippable), so it gets the same
        // duty-cycle classification. Most middle bands come out red (TRI 200/198
        // mid ~0.2%) while genuinely clippable ones are flagged.
        let mid = clipPolygonByMinY([a, b, c], minY);
        mid = clipPolygonByMaxY(mid, maxY);
        emitByClip(mid);

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

    const green = makeBucket();  // vertex bulges
    const red = makeBucket();    // not ground-clippable
    const blue = makeBucket();   // below lowest vertex
    const yellow = makeBucket(); // solid ground-clip (high duty cycle)
    const orange = makeBucket(); // partial / position-dependent ground-clip

    // Expose an id->poly map so the top-cut gather (gatherTopCutters) can read a
    // candidate cutter poly's plane and footprint. Keyed the same way polyIdx is
    // derived below. Doesn't overwrite a colCtx.polys the caller already set.
    if (colCtx && !colCtx.polys) {
        const polys = {};
        allTriangleData.forEach((tri, arrayIdx) => {
            const id = (tri.id !== undefined && tri.id !== null) ? tri.id : arrayIdx;
            polys[id] = tri;
        });
        colCtx.polys = polys;
    }

    allTriangleData.forEach((tri, arrayIdx) => {
        const polyIdx = (tri.id !== undefined && tri.id !== null) ? tri.id : arrayIdx;
        buildStandableSurfaceTriangles(tri, green.push, red.push, blue.push, yellow.push, orange.push, colCtx, polyIdx);
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
        { data: orange, color: 0xff8800, edgeColor: 0x000000 },
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