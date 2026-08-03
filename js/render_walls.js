import * as THREE from 'three';

// Renders static wall collision as BgCheck_SphVsStaticWall actually tests it.
//
// The game does NOT test the raw triangle. Acceptance comes from
// Math3D_TriChkPointParaXImpl / ParaZImpl, which run four stages in order:
//
//   1. bounding box in the projection plane, padded by chkDist -> hard reject
//   2. within chkDist of any vertex                            -> accept
//   3. determinant test against detMax                         -> accept
//   4. within chkDist of any edge, gated on |n_solve| > 0.5     -> accept
//
// Stage 3 dominates. Each determinant is edge_length * perpendicular_distance,
// so `det <= 300` means the region extends past each edge by
//
//       300 / |edge length in the projection plane|
//
// A 300-unit edge gets 1 unit of margin; a 30-unit edge gets 10. Small
// triangles are disproportionately sticky, and stage 1 clips the whole thing
// to the triangle's projected AABB + chkDist.
//
// Two passes exist because the game runs a Z-solving loop and then an X-solving
// loop over the same wall list, each skipping polys not aligned with its axis.

const DET_MAX = 300.0;   // Math3D_TriChkPointParaXIntersect / ParaZIntersect
const CHK_DIST = 1.0;    // same call sites

// Wall list membership, from StaticLookup_AddPoly. Compared as raw s16 because
// the float thresholds disagree with the quantised ones at the boundary:
//   COLPOLY_SNORMAL(0.5f)  == (s16)(16383.5) == 16383
//   COLPOLY_SNORMAL(-0.8f) == (s16)(-26213.6) == -26213
const WALL_NY_MAX = 16383;
const WALL_NY_MIN = -26213;

// BgCheck_SphVsStaticWall skips a poly in a given pass when
//   fabsf(n_solve) * (1 / sqrtf(SQ(nx) + SQ(nz))) < 0.4f
const AXIS_ALIGN_MIN = 0.4;

// ---------------------------------------------------------------- 2D helpers
//
// The plane solve below is kept in f32 to mirror the game. The expansion
// geometry is our own construction rather than a port of game code, so it runs
// in doubles -- matching f32 there would add error, not fidelity.

function signedArea2(t) {
    return (t[1].u - t[0].u) * (t[2].v - t[0].v) - (t[2].u - t[0].u) * (t[1].v - t[0].v);
}

function lineIntersect(p0, d0, p1, d1) {
    const denom = d0.u * d1.v - d0.v * d1.u;
    if (Math.abs(denom) < 1e-9) return null; // parallel
    const t = ((p1.u - p0.u) * d1.v - (p1.v - p0.v) * d1.u) / denom;
    return { u: p0.u + t * d0.u, v: p0.v + t * d0.v };
}

/**
 * Stage 3 (+ stage 4): offset each edge outward by max(DET_MAX / |edge|,
 * chkDist-if-applicable), then intersect adjacent offset lines.
 *
 * This is a per-edge offset, not a radial scale from the centroid -- the two
 * only agree for near-equilateral triangles and diverge badly on slivers,
 * which are exactly the cases with the largest margin.
 */
function expandTriangle(tri, applyEdgeMargin) {
    const area2 = signedArea2(tri);
    if (Math.abs(area2) < 1e-9) return null; // degenerate in this projection
    const sign = area2 > 0 ? 1 : -1;

    const lines = [];
    for (let i = 0; i < 3; i++) {
        const a = tri[i];
        const b = tri[(i + 1) % 3];
        const eu = b.u - a.u;
        const ev = b.v - a.v;
        const len = Math.hypot(eu, ev);
        if (len < 1e-9) return null;

        // Interior lies left of each directed edge for CCW winding, so the
        // outward normal is the right normal, flipped for CW.
        const nu = (sign * ev) / len;
        const nv = (-sign * eu) / len;

        const detOffset = DET_MAX / len;
        // Stages 3 and 4 are OR'd, so the region is their union -> take the max.
        const offset = applyEdgeMargin ? Math.max(detOffset, CHK_DIST) : detOffset;

        lines.push({
            p: { u: a.u + nu * offset, v: a.v + nv * offset },
            d: { u: eu, v: ev },
        });
    }

    const out = [];
    for (let i = 0; i < 3; i++) {
        const p = lineIntersect(lines[(i + 2) % 3].p, lines[(i + 2) % 3].d, lines[i].p, lines[i].d);
        if (!p) return null;
        out.push(p);
    }
    return out;
}

/** Stage 1: Math3D_CirSquareVsTriSquare is a hard AABB reject, so clip to it. */
function clipToRect(poly, minU, maxU, minV, maxV) {
    const clip = (pts, inside, cut) => {
        if (pts.length === 0) return pts;
        const out = [];
        for (let i = 0; i < pts.length; i++) {
            const cur = pts[i];
            const prev = pts[(i + pts.length - 1) % pts.length];
            const curIn = inside(cur);
            const prevIn = inside(prev);
            if (curIn) {
                if (!prevIn) out.push(cut(prev, cur));
                out.push(cur);
            } else if (prevIn) {
                out.push(cut(prev, cur));
            }
        }
        return out;
    };

    const cutU = (a, b, x) => {
        const t = (x - a.u) / (b.u - a.u);
        return { u: x, v: a.v + t * (b.v - a.v) };
    };
    const cutV = (a, b, y) => {
        const t = (y - a.v) / (b.v - a.v);
        return { u: a.u + t * (b.u - a.u), v: y };
    };

    let p = poly;
    p = clip(p, q => q.u >= minU, (a, b) => cutU(a, b, minU));
    p = clip(p, q => q.u <= maxU, (a, b) => cutU(a, b, maxU));
    p = clip(p, q => q.v >= minV, (a, b) => cutV(a, b, minV));
    p = clip(p, q => q.v <= maxV, (a, b) => cutV(a, b, maxV));
    return p;
}

// ---------------------------------------------------------------- core build

/**
 * @param solveAxis 'z' -> project to (x,y) and solve Z  (CheckZIntersectApprox)
 *                  'x' -> project to (y,z) and solve X  (CheckXIntersectApprox)
 */
function buildWallGeometry(allTriangleData, solveAxis) {
    const positions = [];
    const indices = [];
    let vertexOffset = 0;

    allTriangleData.forEach(tri => {
        const normals = tri.normals;

        // Wall list membership. Note the band is ASYMMETRIC: -0.8 .. 0.5.
        // Using Math.abs(ny) > 0.5 would wrongly discard steep overhangs.
        if (normals[1] > WALL_NY_MAX || normals[1] < WALL_NY_MIN) return;

        const D = f32(tri.d);
        const Nx = f32(normals[0] * COLPOLY_NORMAL_FRAC);
        const Ny = f32(normals[1] * COLPOLY_NORMAL_FRAC);
        const Nz = f32(normals[2] * COLPOLY_NORMAL_FRAC);

        const nSolve = solveAxis === 'z' ? Nz : Nx;

        // BgCheck_SphVsStaticWall's per-pass gate.
        const normalXZ = f32(Math.sqrt(f32(f32(Nx * Nx) + f32(Nz * Nz))));
        if (normalXZ < 1e-9) return;
        if (Math.abs(nSolve) / normalXZ < AXIS_ALIGN_MIN) return;

        // Project. The game's det terms use (x,y) for the Z solve and (y,z)
        // for the X solve, matching Math3D_TriChkPointParaZImpl / ParaXImpl.
        const tri2 = tri.vtxs.map(v =>
            solveAxis === 'z' ? { u: f32(v.x), v: f32(v.y) } : { u: f32(v.y), v: f32(v.z) });

        // Stage 4 only runs when the solve-axis normal component clears 0.5.
        const applyEdgeMargin = Math.abs(nSolve) > 0.5;

        let poly = expandTriangle(tri2, applyEdgeMargin);
        if (!poly) return;

        // Stage 1 clamp: AABB of the ORIGINAL vertices, padded by chkDist.
        const us = tri2.map(p => p.u);
        const vs = tri2.map(p => p.v);
        poly = clipToRect(
            poly,
            Math.min(...us) - CHK_DIST, Math.max(...us) + CHK_DIST,
            Math.min(...vs) - CHK_DIST, Math.max(...vs) + CHK_DIST,
        );
        if (poly.length < 3) return;

        // Lift onto the collision plane: n.p + d = 0, solved for the missing axis.
        const lift = (u, v) => {
            if (solveAxis === 'z') {
                const dot = f32(f32(f32(Nx * u) + f32(Ny * v)) + D);
                return { x: u, y: v, z: f32(f32(-dot) / Nz) };
            }
            const dot = f32(f32(f32(Ny * u) + f32(Nz * v)) + D);
            return { x: f32(f32(-dot) / Nx), y: u, z: v };
        };

        const verts = poly.map(p => lift(p.u, p.v));

        // Fan-triangulate the convex clipped polygon.
        for (const p of verts) positions.push(p.x, p.y, p.z);
        for (let i = 1; i + 1 < verts.length; i++) {
            indices.push(vertexOffset, vertexOffset + i, vertexOffset + i + 1);
        }
        vertexOffset += verts.length;
    });

    return { positions, indices };
}

function buildGroup({ positions, indices }) {
    const group = new THREE.Group();
    if (positions.length === 0) return group;

    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));
    geometry.setIndex(indices);
    geometry.computeVertexNormals();

    group.add(new THREE.Mesh(geometry, new THREE.MeshStandardMaterial({
        color: 0xff0000,
        side: THREE.DoubleSide,
        flatShading: true,
        polygonOffset: true,
        polygonOffsetFactor: 4,
        polygonOffsetUnits: 4,
    })));

    group.add(new THREE.LineSegments(
        new THREE.EdgesGeometry(geometry),
        new THREE.LineBasicMaterial({ color: 0x000000 }),
    ));

    return group;
}

export function renderCollisionWallsXY(allTriangleData) {
    return buildGroup(buildWallGeometry(allTriangleData, 'z'));
}

export function renderCollisionWallsYZ(allTriangleData) {
    return buildGroup(buildWallGeometry(allTriangleData, 'x'));
}
