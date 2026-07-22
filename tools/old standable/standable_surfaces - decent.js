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

// ============================================================================
// TOP-CUT CORE (pure geometry, no colCtx dependency).
//
// Given a standable triangle on plane T and a "cutter" polygon on plane C, cut
// off the part of the triangle that sits BELOW C within C's XZ footprint
// (i.e. the part C overhangs). This is exact and cheap: the boundary where
// T's height equals C's height is a straight line in XZ, so removing "T above
// which C sits" is a sequence of half-plane clips (the y_T<y_C half-plane,
// intersected with C's footprint edges). No sampling.
//
// A cutter is described by {nx,ny,nz,d, foot:[{x,z},...]} where (nx,ny,nz,d)
// is its world plane (N·p + d = 0) and foot is its XZ footprint polygon.
// The standable triangle is described by its own plane (tnx..td).
// ============================================================================

// Signed value yC - yT at (x,z): how far the cutter (floor) poly's plane sits
// above the standable surface. >0 means the surface is UNDER the floor poly.
//
// POLARITY (see cutPolyTop): the caller KEEPS where this is >= 0, i.e. keeps the
// surface where it stays at or below the floor poly, and DELETES where the
// surface rises above it. The floor poly acts as a lid: standable area that
// pokes up through it isn't reachable.
//
// The gather now admits any cutter that is itself standable, including steep
// ones, so callers must clamp this to the cutter's real Y extent (see
// cutPolyTop) rather than trusting the unbounded plane. The degenerate guard
// remains as a divide-by-zero backstop; it is unreachable in practice because
// isStandablePoly already rejects ny ~ 0. Returning +1 reads as "surface is
// under the lid" -> kept, so a degenerate cutter never deletes anything.
function cutterMinusSurfaceY(c, tnx, tny, tnz, td, x, z) {
    if (!(Math.abs(c.ny) > 1e-3)) return 1; // degenerate -> keep (no deletion)
    const yT = computeYFromPlaneLocal(tnx, tny, tnz, td, x, z);
    const yC = computeYFromPlaneLocal(c.nx, c.ny, c.nz, c.d, x, z);
    return yC - yT;
}

// Height of the cutter's plane at (x,z), with the same degenerate backstop.
// Returns +Infinity for a degenerate cutter so the clamp in cutPolyTop pins it
// to maxY and it never deletes anything.
function cutterPlaneY(c, x, z) {
    if (!(Math.abs(c.ny) > 1e-3)) return Infinity;
    return computeYFromPlaneLocal(c.nx, c.ny, c.nz, c.d, x, z);
}

// Sutherland-Hodgman clip of an {x,y,z} polygon against one XZ half-plane
// defined by a scalar function side(x,z): keep vertices where keepPositive
// ? side>=0 : side<=0. At crossings, position is interpolated in XZ and Y is
// re-lifted onto the surface plane via liftFn(x,z) so the kept polygon stays
// flush on the standable triangle.
function clipPolyXZByFn(verts, sideFn, keepPositive, liftFn) {
    if (verts.length < 3) return [];
    const out = [];
    const n = verts.length;
    const keep = (s) => keepPositive ? s >= 0 : s <= 0;
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

// Clip `poly` to the OUTSIDE of the cutter footprint edge (e0->e1), i.e. drop
// the side of the edge that faces the footprint interior. footCentroid picks
// which side is interior.
function clipPolyOutsideFootEdge(poly, e0, e1, footCentroid, liftFn) {
    const dx = e1.x - e0.x, dz = e1.z - e0.z;
    const nx = -dz, nz = dx;
    const side = (x, z) => (x - e0.x) * nx + (z - e0.z) * nz;
    const interiorIsPositive = side(footCentroid.x, footCentroid.z) > 0;
    // keep the opposite side from the interior
    return clipPolyXZByFn(poly, side, !interiorIsPositive, liftFn);
}

// Maximum surviving pieces per standable triangle. The subtract-a-convex-region
// operation can split a polygon once per cutter half-plane, so without a cap a
// column with many overhead polys multiplies pieces without bound (this is what
// made the first top-cut attempt hang rather than merely run slow). When the cap
// is hit we stop cutting and keep what we have - slightly under-cut geometry is
// far better than a frozen load.
const TOPCUT_MAX_PIECES = 64;

// Maximum cutters gathered per standable triangle. Guards against a pathological
// column (tall cells, dense geometry above) handing the clipper an unbounded
// candidate list.
const TOPCUT_MAX_CUTTERS = 48;

// A poly may act as a cutter if and only if it is ITSELF rendered as a standable
// surface. If a triangle is too vertical to be standable, it is not something you
// could be standing on, so it cannot block a surface below it either.
//
// This must stay byte-for-byte equivalent to the accept test in
// buildStandableSurfaceTriangles (`if (Ny < 0 || isZero(Ny)) return;`). If that
// test changes, change this with it - a drift between the two reintroduces
// exactly the bug this replaced, where a poly was drawn as standable but silently
// refused to cut.
//
// Note this deliberately does NOT use subdivisions.js's 0.5 floor/wall split.
// That threshold classifies storage buckets, not standability: a poly at
// ny ~ 0.156 is filed as a "wall" yet is still rendered standable, and must be
// able to cut.
function isStandablePoly(poly) {
    if (!poly || !poly.normals) return false;
    const ny = f32(poly.normals[1] * COLPOLY_NORMAL_FRAC);
    return !(ny < f32(0.0) || isZero(ny));
}

// Apply cutters in sequence, each further trimming all surviving pieces.
// `cutters` should already be XZ-rejected against this triangle (see
// gatherTopCutters). Returns polygons ready to fan-triangulate.
function cutTriangleTopAll(a, b, c, cutters, tnx, tny, tnz, td, liftFn) {
    let pieces = [[a, b, c]];
    for (const cutter of cutters) {
        const next = [];
        for (const p of pieces) {
            const out = cutPolyTop(p, cutter, tnx, tny, tnz, td, liftFn);
            for (const q of out) next.push(q);
        }
        pieces = next;
        if (pieces.length === 0) break;
        if (pieces.length > TOPCUT_MAX_PIECES) break; // bail, keep what we have
    }
    return pieces;
}

// Subtract one cutter's overhang from a polygon.
//
// The removed region is the intersection of half-planes:
//   (inside each footprint edge)  AND  (yC > yT)
// Collision polys are triangles, so the footprint is convex and this
// intersection is a convex region. Subtracting a convex region R from polygon P
// is done by walking R's half-planes: at each step, the part of the carry that
// is OUTSIDE that half-plane can never be in R, so it is kept as a final piece;
// the part inside is carried to the next half-plane. Whatever survives all
// half-planes is exactly R∩P and is dropped.
//
// This emits at most (numHalfPlanes) pieces and, critically, only splits the
// carry - it does not re-split already-kept pieces (the earlier version fed
// every piece back through every edge, giving 4^N growth and hanging the load).
function cutPolyTop(poly0, cutter, tnx, tny, tnz, td, liftFn) {
    const foot = cutter.foot;
    const n = foot.length;

    // Footprint centroid, for deciding which side of each edge is interior.
    let fcx = 0, fcz = 0;
    for (const v of foot) { fcx += v.x; fcz += v.z; }
    fcx /= n; fcz /= n;

    const kept = [];
    let carry = poly0;

    // Footprint half-planes.
    for (let i = 0; i < n; i++) {
        if (!carry || carry.length < 3) break;
        const e0 = foot[i], e1 = foot[(i + 1) % n];
        const dx = e1.x - e0.x, dz = e1.z - e0.z;
        const nx = -dz, nz = dx;
        const side = (x, z) => (x - e0.x) * nx + (z - e0.z) * nz;
        const interiorIsPositive = side(fcx, fcz) > 0;

        const outside = clipPolyXZByFn(carry, side, !interiorIsPositive, liftFn);
        if (outside.length >= 3) kept.push(outside);
        carry = clipPolyXZByFn(carry, side, interiorIsPositive, liftFn);
    }

    // Height half-plane. The floor poly is a LID: keep the surface where it sits
    // at or below that lid (yC - yT >= 0), delete where the surface rises above
    // it. This is the cut along the line where the standable surface crosses the
    // floor poly's plane.
    if (carry && carry.length >= 3) {
        // The cutter blocks only over its OWN Y extent. Outside that span its
        // unbounded plane is fiction, so clamp the lid height to [minY, maxY]
        // before comparing. For a near-horizontal cutter the plane barely leaves
        // that span inside the footprint, so this is a no-op and behavior is
        // unchanged; for a steep one it is what stops the 1/ny amplification from
        // projecting the lid to nonsense heights and deleting valid geometry.
        const hSide = (x, z) => {
            const yT = computeYFromPlaneLocal(tnx, tny, tnz, td, x, z);
            let yC = cutterPlaneY(cutter, x, z);
            if (yC < cutter.minY) yC = cutter.minY;
            if (yC > cutter.maxY) yC = cutter.maxY;
            return yC - yT;
        };
        const underLid = clipPolyXZByFn(carry, hSide, true, liftFn); // yC - yT >= 0
        if (underLid.length >= 3) kept.push(underLid);
        // the remainder (yT > yC: surface pushes ABOVE the cutter) is dropped
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
    if (!colCtx || polyIdx === undefined || polyIdx === null) return [];
    const subs = colCtx.subdivisions;
    const amt = colCtx.subdivAmount;
    const myCells = colCtx.polyStandableSubdivIndices && colCtx.polyStandableSubdivIndices[polyIdx];
    if (!subs || !amt || !myCells) return [];

    const AX = amt.x, AY = amt.y, AZ = amt.z;
    const AXY = AX * AY;
    const getPoly = (p) => (colCtx.polys ? colCtx.polys[p] : null);
    const xzBounds = colCtx.polyWorldXZBounds;

    // Collect the distinct (xi,zi) columns and the HIGHEST yi this triangle
    // occupies in each, so the walk below starts strictly above every slice the
    // triangle itself is registered in.
    //
    // This must be the max, not the min: a triangle that spans several Y slices
    // (tall or steep ones do) would otherwise have the walk start at min+1,
    // which is still a slice the triangle occupies - and a floor sharing that
    // cell would be gathered as a cutter even though it lives in the SAME
    // subdivision as the triangle, not above it. Only floors in a subdivision
    // strictly above one containing the triangle may clip it.
    const columnMaxYi = new Map();
    for (const cellIndex of myCells) {
        const zi = Math.floor(cellIndex / AXY);
        const rem = cellIndex - zi * AXY;
        const yi = Math.floor(rem / AX);
        const xi = rem - yi * AX;
        const key = xi + ',' + zi;
        const cur = columnMaxYi.get(key);
        if (cur === undefined || yi > cur) columnMaxYi.set(key, yi);
    }

    const cutters = [];
    const seen = new Set();

    // A gathered cutter is applied to the WHOLE triangle, so "in a subdivision
    // above" has to hold globally, not merely in the column it was found
    // through. Take the highest yi the triangle occupies anywhere: a candidate
    // must live strictly above that to be eligible.
    //
    // Without this, a triangle that climbs across its footprint (e.g. a steep
    // standable poly rising from y=12 to y=202) gets clipped by floors that are
    // above its LOW end but sit in the same subdivision as its HIGH end - the
    // floors are then not "in a subdivision above a subdivision containing the
    // triangle" at all, and must not clip it.
    let triTopYi = -1;
    for (const cellIndex of myCells) {
        const zi = Math.floor(cellIndex / AXY);
        const rem = cellIndex - zi * AXY;
        const yi = Math.floor(rem / AX);
        if (yi > triTopYi) triTopYi = yi;
    }

    // A candidate is eligible only if EVERY cell it occupies is strictly above
    // triTopYi. Sharing (or sitting below) any slice the triangle reaches makes
    // it same-subdivision geometry, which never clips.
    const candidateCells = new Map(); // poly -> lowest yi it occupies
    const noteCandidateCell = (p, yi) => {
        const cur = candidateCells.get(p);
        if (cur === undefined || yi < cur) candidateCells.set(p, yi);
    };
    // Pass 1: collect every non-ceiling poly sharing a column with this triangle,
    // recording the LOWEST yi it occupies. Eligibility needs the candidate's
    // global minimum, not the slice we happened to find it at.
    //
    // Both floors[] and walls[] are scanned. That split is subdivisions.js's 0.5
    // ny classification, which is about storage, not standability - a poly at
    // ny ~ 0.156 is filed under walls[] yet still renders as a standable surface,
    // so restricting the scan to floors[] made such polys unable to cut. The
    // actual eligibility test is isStandablePoly, applied in Pass 2. Ceilings stay
    // excluded: a downward-facing overhang isn't standable and never blocks.
    const columnKeys = new Set(columnMaxYi.keys());
    for (let ci = 0; ci < subs.length; ci++) {
        const cell = subs[ci];
        if (!cell) continue;
        const hasFloors = cell.floors && cell.floors.length > 0;
        const hasWalls = cell.walls && cell.walls.length > 0;
        if (!hasFloors && !hasWalls) continue;
        const zi = Math.floor(ci / AXY);
        const rem = ci - zi * AXY;
        const yi = Math.floor(rem / AX);
        const xi = rem - yi * AX;
        if (!columnKeys.has(xi + ',' + zi)) continue; // not over this triangle
        if (hasFloors) {
            for (const p of cell.floors) {
                if (p === polyIdx) continue;
                noteCandidateCell(p, yi);
            }
        }
        if (hasWalls) {
            for (const p of cell.walls) {
                if (p === polyIdx) continue;
                noteCandidateCell(p, yi);
            }
        }
    }

    // Pass 2: a candidate clips only if EVERY cell it occupies is strictly above
    // EVERY cell the triangle occupies. Sharing any slice the triangle reaches
    // makes it same-subdivision geometry, which must never clip.
    for (const [p, lowestYi] of candidateCells) {
        if (lowestYi <= triTopYi) continue;
        if (seen.has(p)) continue;
        seen.add(p);

        // CHEAP XZ REJECT (before any clipping work). A subdivision cell is far
        // wider than most polys in it, so without this we pay a full clip for
        // cutters that don't overlap the triangle at all.
        const b = xzBounds && xzBounds[p];
        if (b && (b.maxX < triMinX || b.minX > triMaxX ||
                  b.maxZ < triMinZ || b.minZ > triMaxZ)) continue;

        const poly = getPoly(p);
        if (!poly || !poly.vtxs || !poly.normals) continue;

        const cny = f32(poly.normals[1] * COLPOLY_NORMAL_FRAC);

        // STANDABLE TEST. A poly blocks if and only if it is itself rendered as a
        // standable surface. Too vertical to stand on means too vertical to stand
        // under - such a poly is skipped by the renderer and must not cut either.
        // This replaces the old ny > 0.5 "horizontal-enough" threshold, which
        // wrongly excluded steep-but-standable polys (e.g. ny ~ 0.156) from ever
        // cutting. The unbounded-plane blowup that threshold was guarding against
        // is now handled properly by clamping to the cutter's Y extent in
        // cutPolyTop, rather than by discarding the cutter outright.
        if (!isStandablePoly(poly)) continue;

        // Mirror the renderer's second gate: a poly never registered as standable
        // ground in any subdivision isn't drawn, so it can't block either.
        if (colCtx.polyStandableSubdivIndices &&
            !colCtx.polyStandableSubdivIndices[p]) continue;

        // The cutter only blocks over its own vertical span; cutPolyTop clamps the
        // plane height to this range so a steep cutter's extrapolated plane can't
        // delete geometry far outside where the poly actually is.
        let cMinY = Infinity, cMaxY = -Infinity;
        for (const v of poly.vtxs) {
            const vy = f32(v.y);
            if (vy < cMinY) cMinY = vy;
            if (vy > cMaxY) cMaxY = vy;
        }

        cutters.push({
            nx: f32(poly.normals[0] * COLPOLY_NORMAL_FRAC),
            ny: cny,
            nz: f32(poly.normals[2] * COLPOLY_NORMAL_FRAC),
            d: f32(poly.d),
            minY: cMinY,
            maxY: cMaxY,
            foot: poly.vtxs.map(v => ({ x: f32(v.x), z: f32(v.z) })),
        });
        if (cutters.length >= TOPCUT_MAX_CUTTERS) return cutters;
    }
    return cutters;
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
function buildStandableSurfaceTriangles(tri, pushGreen, pushRed, pushBlue, pushYellow, colCtx = null, polyIdx = null) {
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
    const cutters = gatherTopCutters(colCtx, polyIdx, tcMinX, tcMaxX, tcMinZ, tcMaxZ);
    const liftOnSurface = (x, z) => ({ x: f32(x), y: computeYFromPlaneLocal(Nx, Ny, Nz, D, x, z), z: f32(z) });
    const wrapCut = (rawPush) => {
        if (cutters.length === 0) return rawPush;
        return (a, b, c) => {
            const pieces = cutTriangleTopAll(a, b, c, cutters, Nx, Ny, Nz, D, liftOnSurface);
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
        buildStandableSurfaceTriangles(tri, green.push, red.push, blue.push, yellow.push, colCtx, polyIdx);
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