////////////////////////////////////////
// System: Subdivisions
////////////////////////////////////////

const BGCHECK_Y_MIN = f32(-32000.0);
const BGCHECK_Y_MAX = f32(32000.0);
const BGCHECK_XYZ_ABSMAX = f32(32760.0);
const BGCHECK_SUBDIV_OVERLAP = f32(50.0);
export { BGCHECK_SUBDIV_OVERLAP };
const BGCHECK_SUBDIV_MIN = f32(150.0);

const OOT_sceneSubdivisionList = {
    "Shadow Temple": [23, 7, 14],
    "Forest Temple": [38, 1, 38]
};
const MM_sceneSubdivisionList = {
    "Termina Field": [36, 1, 36],
    "Great Bay Coast": [40, 1, 40],
    "Zora Cape": [40, 1, 40]
};

function clampMin(v, min) {
    return v < min ? min : v;
}

function setSubdivisionDimension(min, subdivAmount, max) {
    min = f32(min);
    max = f32(max);

    // length = max - min
    let length = f32(f32(max) - f32(min));

    // (s32)(length / subdivAmount)
    let temp = (f32(length / subdivAmount) | 0);

    // subdivLength = (s32)(length / subdivAmount) + 1
    let subdivLength = f32(temp + 1);

    // CLAMP_MIN
    subdivLength = f32(clampMin(subdivLength, BGCHECK_SUBDIV_MIN));

    let subdivLengthInv = f32(f32(1.0) / subdivLength);

    // newMax = subdivLength * subdivAmount + min
    let newMax = f32(f32(subdivLength * subdivAmount) + min);

    return {
        max: newMax,
        subdivLength: subdivLength,
        subdivLengthInv: subdivLengthInv
    };
}

export function initColCtx(game, sceneName, colHeader) {
    let colCtx = {}; 
    colCtx.colHeader = colHeader;
    
    let spotScenes = [
        "Spot 00 - Hyrule Field",
        "Spot 01 - Kakariko Village",
        "Spot 02 - Graveyard",
        "Spot 03 - Zora's River",
        "Spot 04 - Kokiri Forest",
        "Spot 05 - Sacred Forest Meadow",
        "Spot 06 - Lake Hylia",
        "Spot 07 - Zora's Domain",
        "Spot 08 - Zora's Fountain",
        "Spot 09 - Gerudo Valley",
        "Spot 10 - Lost Woods",
        "Spot 11 - Desert Colossus",
        "Spot 12 - Gerudo's Fortress",
        "Spot 13 - Haunted Wasteland",
        "Spot 15 - Hyrule Castle",
        "Spot 16 - Death Mountain Trail",
        "Spot 17 - Death Mountain Crater",
        "Spot 18 - Goron City",
        "Spot 20 - Lon Lon Ranch"
    ];

    //
    // Determine subdivision amount
    //
    if ((game == "OOT" || game == "OOT3D") && 
        (colHeader.camType === 0x10 || // "SHOP"
        colHeader.camType === 0x20 || // "TOGGLE"
        colHeader.camType === 0x30 || // "FIXED"
        colHeader.camType === 0x40)) { // "MARKET"
        
        // OoT uses a special subdivision count for certain areas of the game, such as shops
        colCtx.subdivAmount = { x: 2, y: 2, z: 2 };
    } else {
        if ((game == "OOT" || game == "OOT3D") && OOT_sceneSubdivisionList.hasOwnProperty(sceneName)) {
            const arr = OOT_sceneSubdivisionList[sceneName];
            colCtx.subdivAmount = {
                x: arr[0],
                y: arr[1],
                z: arr[2]
            };
        }
        else if ((game == "MM" || game == "MM3D") && MM_sceneSubdivisionList.hasOwnProperty(sceneName)) {
            const arr = MM_sceneSubdivisionList[sceneName];
            colCtx.subdivAmount = {
                x: arr[0],
                y: arr[1],
                z: arr[2]
            };
        }
        else if (game == "OOT3D" && spotScenes.includes(sceneName)){
            colCtx.subdivAmount = { x: 32, y: 8, z: 32 };
        }
        else {
            colCtx.subdivAmount = { x: 16, y: 4, z: 16 };
        }
    }

    //
    // Copy bounds (as f32)
    //
    colCtx.minBounds = {
        x: f32(colHeader.minBounds.x),
        y: f32(colHeader.minBounds.y),
        z: f32(colHeader.minBounds.z)
    };

    colCtx.maxBounds = {
        x: f32(colHeader.maxBounds.x),
        y: f32(colHeader.maxBounds.y),
        z: f32(colHeader.maxBounds.z)
    };

    //
    // Prepare output containers
    //
    colCtx.subdivLength = { x: 0, y: 0, z: 0 };
    colCtx.subdivLengthInv = { x: 0, y: 0, z: 0 };

    //
    // X dimension
    //
    let r = setSubdivisionDimension(
        colCtx.minBounds.x,
        colCtx.subdivAmount.x,
        colCtx.maxBounds.x
    );
    colCtx.maxBounds.x = r.max;
    colCtx.subdivLength.x = r.subdivLength;
    colCtx.subdivLengthInv.x = r.subdivLengthInv;

    //
    // Y dimension
    //
    r = setSubdivisionDimension(
        colCtx.minBounds.y,
        colCtx.subdivAmount.y,
        colCtx.maxBounds.y
    );
    colCtx.maxBounds.y = r.max;
    colCtx.subdivLength.y = r.subdivLength;
    colCtx.subdivLengthInv.y = r.subdivLengthInv;

    //
    // Z dimension
    //
    r = setSubdivisionDimension(
        colCtx.minBounds.z,
        colCtx.subdivAmount.z,
        colCtx.maxBounds.z
    );
    colCtx.maxBounds.z = r.max;
    colCtx.subdivLength.z = r.subdivLength;
    colCtx.subdivLengthInv.z = r.subdivLengthInv;
    colCtx.subdivisions = [];
    colCtx.surfaceTypes = [];
    
    let total_subdivisions = colCtx.subdivAmount.x * colCtx.subdivAmount.y * colCtx.subdivAmount.z;
    
    for (let zi=0; zi<colCtx.subdivAmount.z; zi++) {
        for (let yi=0; yi<colCtx.subdivAmount.y; yi++) {
            for (let xi=0; xi<colCtx.subdivAmount.x; xi++) {
                colCtx.subdivisions.push({
                    bounds: [
                        [colCtx.minBounds.x + colCtx.subdivLength.x * xi, colCtx.minBounds.x + colCtx.subdivLength.x * (xi + 1)], 
                        [colCtx.minBounds.y + colCtx.subdivLength.y * yi, colCtx.minBounds.y + colCtx.subdivLength.y * (yi + 1)],
                        [colCtx.minBounds.z + colCtx.subdivLength.z * zi, colCtx.minBounds.z + colCtx.subdivLength.z * (zi + 1)]
                    ],
                    floors: [],
                    walls: [],
                    ceilings: [],
                    standable: []
                });
            }
        }
    }
    
    return colCtx;
}

function triIntersectsCube(tri, box) {
    const f32 = Math.fround;

    // Extract verts
    const v0 = tri[0];
    const v1 = tri[1];
    const v2 = tri[2];

    // Compute triangle bounds
    const tminX = Math.min(v0.x, v1.x, v2.x);
    const tmaxX = Math.max(v0.x, v1.x, v2.x);
    const tminY = Math.min(v0.y, v1.y, v2.y);
    const tmaxY = Math.max(v0.y, v1.y, v2.y);
    const tminZ = Math.min(v0.z, v1.z, v2.z);
    const tmaxZ = Math.max(v0.z, v1.z, v2.z);

    // 1. AABB–triangle AABB quick reject
    if (tmaxX < box.xmin || tminX > box.xmax) return false;
    if (tmaxY < box.ymin || tminY > box.ymax) return false;
    if (tmaxZ < box.zmin || tminZ > box.zmax) return false;

    // Center & half sizes of the AABB
    const c = {
        x: f32((box.xmin + box.xmax) * 0.5),
        y: f32((box.ymin + box.ymax) * 0.5),
        z: f32((box.zmin + box.zmax) * 0.5),
    };

    const h = {
        x: f32((box.xmax - box.xmin) * 0.5),
        y: f32((box.ymax - box.ymin) * 0.5),
        z: f32((box.zmax - box.zmin) * 0.5),
    };

    // Move triangle to AABB space (center at origin)
    const tv0 = {
        x: f32(v0.x - c.x),
        y: f32(v0.y - c.y),
        z: f32(v0.z - c.z),
    };
    const tv1 = {
        x: f32(v1.x - c.x),
        y: f32(v1.y - c.y),
        z: f32(v1.z - c.z),
    };
    const tv2 = {
        x: f32(v2.x - c.x),
        y: f32(v2.y - c.y),
        z: f32(v2.z - c.z),
    };

    // Triangle edges
    const e0 = {
        x: f32(tv1.x - tv0.x),
        y: f32(tv1.y - tv0.y),
        z: f32(tv1.z - tv0.z),
    };
    const e1 = {
        x: f32(tv2.x - tv1.x),
        y: f32(tv2.y - tv1.y),
        z: f32(tv2.z - tv1.z),
    };
    const e2 = {
        x: f32(tv0.x - tv2.x),
        y: f32(tv0.y - tv2.y),
        z: f32(tv0.z - tv2.z),
    };

    //
    // 2. Separating Axis Tests:
    //    AABB axes: X, Y, Z
    //
    if (Math.max(tv0.x, tv1.x, tv2.x) < -h.x || Math.min(tv0.x, tv1.x, tv2.x) > h.x) return false;
    if (Math.max(tv0.y, tv1.y, tv2.y) < -h.y || Math.min(tv0.y, tv1.y, tv2.y) > h.y) return false;
    if (Math.max(tv0.z, tv1.z, tv2.z) < -h.z || Math.min(tv0.z, tv1.z, tv2.z) > h.z) return false;

    //
    // 3. Triangle normal test (triangle plane vs AABB)
    //
    const normal = {
        x: f32(e0.y * e1.z - e0.z * e1.y),
        y: f32(e0.z * e1.x - e0.x * e1.z),
        z: f32(e0.x * e1.y - e0.y * e1.x),
    };

    // Project AABB half extents onto triangle normal
    const r = f32(
        h.x * Math.abs(normal.x) +
        h.y * Math.abs(normal.y) +
        h.z * Math.abs(normal.z)
    );

    const d = f32(normal.x * tv0.x + normal.y * tv0.y + normal.z * tv0.z);

    if (d > r || d < -r) return false;

    //
    // 4. 9 edge cross-product tests (triangle edges × box axes)
    //
    function axisTest(e, tv0, tv1, tv2, h) {
        // X-axis cross
        {
            const p0 = f32(e.z * tv0.y - e.y * tv0.z);
            const p1 = f32(e.z * tv1.y - e.y * tv1.z);
            const p2 = f32(e.z * tv2.y - e.y * tv2.z);
            const min = Math.min(p0, p1, p2);
            const max = Math.max(p0, p1, p2);
            const rad = f32(Math.abs(e.y) * h.z + Math.abs(e.z) * h.y);
            if (min > rad || max < -rad) return false;
        }

        // Y-axis cross
        {
            const p0 = f32(e.x * tv0.z - e.z * tv0.x);
            const p1 = f32(e.x * tv1.z - e.z * tv1.x);
            const p2 = f32(e.x * tv2.z - e.z * tv2.x);
            const min = Math.min(p0, p1, p2);
            const max = Math.max(p0, p1, p2);
            const rad = f32(Math.abs(e.x) * h.z + Math.abs(e.z) * h.x);
            if (min > rad || max < -rad) return false;
        }

        // Z-axis cross
        {
            const p0 = f32(e.y * tv0.x - e.x * tv0.y);
            const p1 = f32(e.y * tv1.x - e.x * tv1.y);
            const p2 = f32(e.y * tv2.x - e.x * tv2.y);
            const min = Math.min(p0, p1, p2);
            const max = Math.max(p0, p1, p2);
            const rad = f32(Math.abs(e.x) * h.y + Math.abs(e.y) * h.x);
            if (min > rad || max < -rad) return false;
        }

        return true;
    }

    if (!axisTest(e0, tv0, tv1, tv2, h)) return false;
    if (!axisTest(e1, tv0, tv1, tv2, h)) return false;
    if (!axisTest(e2, tv0, tv1, tv2, h)) return false;

    // No separating axis found → intersection
    return true;
}

function getSubdivisionMaxBounds(colCtx, pos, out) {
    const dx = f32(f32(pos.x) - f32(colCtx.minBounds.x));
    const dy = f32(f32(pos.y) - f32(colCtx.minBounds.y));
    const dz = f32(f32(pos.z) - f32(colCtx.minBounds.z));

    let sx = (f32(dx * colCtx.subdivLengthInv.x)) | 0;
    let sy = (f32(dy * colCtx.subdivLengthInv.y)) | 0;
    let sz = (f32(dz * colCtx.subdivLengthInv.z)) | 0;

    const subX = colCtx.subdivLength.x | 0;
    const subY = colCtx.subdivLength.y | 0;
    const subZ = colCtx.subdivLength.z | 0;

    if ((subX - BGCHECK_SUBDIV_OVERLAP) < ((dx | 0) % subX) &&
        sx < (colCtx.subdivAmount.x - 1)) {
        sx += 1;
    }

    if ((subY - BGCHECK_SUBDIV_OVERLAP) < ((dy | 0) % subY) &&
        sy < (colCtx.subdivAmount.y - 1)) {
        sy += 1;
    }

    if ((subZ - BGCHECK_SUBDIV_OVERLAP) < ((dz | 0) % subZ) &&
        sz < (colCtx.subdivAmount.z - 1)) {
        sz += 1;
    }

    out.x = sx;
    out.y = sy;
    out.z = sz;
}

function getSubdivisionMinBounds(colCtx, pos, out) {
    const f32 = Math.fround;

    // Compute deltas
    const dx = f32(pos.x - colCtx.minBounds.x);
    const dy = f32(pos.y - colCtx.minBounds.y);
    const dz = f32(pos.z - colCtx.minBounds.z);

    // Multiply by inverse subdivision length (still f32)
    let sx = f32(dx * colCtx.subdivLengthInv.x);
    let sy = f32(dy * colCtx.subdivLengthInv.y);
    let sz = f32(dz * colCtx.subdivLengthInv.z);

    // Convert to s32 exactly like N64
    sx = sx | 0;
    sy = sy | 0;
    sz = sz | 0;

    const overlap = BGCHECK_SUBDIV_OVERLAP;

    // C-code equivalent:
    // if (((s32)dx % (s32)colCtx->subdivLength.x < OVERLAP) && (sx > 0))

    const dx_i = (dx | 0);
    const dy_i = (dy | 0);
    const dz_i = (dz | 0);

    const subX_i = (colCtx.subdivLength.x | 0);
    const subY_i = (colCtx.subdivLength.y | 0);
    const subZ_i = (colCtx.subdivLength.z | 0);

    if (((dx_i % subX_i) < overlap) && sx > 0) {
        sx -= 1;
    }
    if (((dy_i % subY_i) < overlap) && sy > 0) {
        sy -= 1;
    }
    if (((dz_i % subZ_i) < overlap) && sz > 0) {
        sz -= 1;
    }

    // Output result — matches pointers in C version
    //
    // NOTE: must match .x/.y/.z (not .sx/.sy/.sz) - this is what
    // getPolySubdivisionBounds's caller (the registration loop in
    // initializeSubdivisions) actually reads minIdx.x/.y/.z from, and what
    // getSubdivisionMaxBounds already uses for its own output. Writing
    // .sx/.sy/.sz here silently left minIdx at its initial {x:0,y:0,z:0}
    // forever, causing every single polygon in the map to register into
    // every subdivision from the map's (0,0,0) corner up through its real
    // position, instead of just the handful of cells actually near it.
    out.x = sx;
    out.y = sy;
    out.z = sz;
}

// Computes the subdivision cell a single point occupies. Unlike
// getSubdivisionMinBounds/getSubdivisionMaxBounds (which nudge the index by
// one to account for BGCHECK_SUBDIV_OVERLAP when registering a polygon's
// bounding box into neighboring cells), this is a plain per-axis truncation:
// a query point either is or isn't in a given cell, there's no box to expand.
export function getPointSubdivisionIndex(colCtx, pos) {
    const dx = f32(f32(pos.x) - f32(colCtx.minBounds.x));
    const dy = f32(f32(pos.y) - f32(colCtx.minBounds.y));
    const dz = f32(f32(pos.z) - f32(colCtx.minBounds.z));

    let sx = (f32(dx * colCtx.subdivLengthInv.x)) | 0;
    let sy = (f32(dy * colCtx.subdivLengthInv.y)) | 0;
    let sz = (f32(dz * colCtx.subdivLengthInv.z)) | 0;

    // Clamp into valid range (points can legitimately sit right on the
    // scene's bounding box edge, or a hair outside it due to f32 rounding).
    sx = Math.min(Math.max(sx, 0), colCtx.subdivAmount.x - 1);
    sy = Math.min(Math.max(sy, 0), colCtx.subdivAmount.y - 1);
    sz = Math.min(Math.max(sz, 0), colCtx.subdivAmount.z - 1);

    const subdivAmountXY = colCtx.subdivAmount.x * colCtx.subdivAmount.y;
    const index = (sz * subdivAmountXY) + (sy * colCtx.subdivAmount.x) + sx;

    return { sx, sy, sz, index };
}

// Inverse of the index math in getPointSubdivisionIndex/initializeSubdivisions:
// given a flat subdivision array index, recovers which (sx,sy,sz) cell it
// refers to.
export function decomposeSubdivIndex(colCtx, index) {
    const subdivAmountXY = colCtx.subdivAmount.x * colCtx.subdivAmount.y;
    const sz = Math.floor(index / subdivAmountXY);
    const rem = index - sz * subdivAmountXY;
    const sy = Math.floor(rem / colCtx.subdivAmount.x);
    const sx = rem - sy * colCtx.subdivAmount.x;
    return { sx, sy, sz };
}

// The exact overlap-padded world-space box for subdivision cell (sx,sy,sz) -
// matching precisely the `box` object initializeSubdivisions builds and
// tests triangles against via triIntersectsCube. Reconstructing this lets a
// consumer test true point-in-cell containment directly, instead of
// comparing truncated point indices (see getPointSubdivisionIndex) against
// registered cell indices, which can disagree by one cell near a
// subdivision boundary since registration - but not that truncation - is
// adjusted for BGCHECK_SUBDIV_OVERLAP.
export function getSubdivisionCellBounds(colCtx, sx, sy, sz) {
    const pad = f32(2 * BGCHECK_SUBDIV_OVERLAP);

    const xmin = f32(f32(colCtx.subdivLength.x * sx) + colCtx.minBounds.x - BGCHECK_SUBDIV_OVERLAP);
    const xmax = f32(xmin + f32(colCtx.subdivLength.x + pad));

    const ymin = f32(f32(colCtx.subdivLength.y * sy) + colCtx.minBounds.y - BGCHECK_SUBDIV_OVERLAP);
    const ymax = f32(ymin + f32(colCtx.subdivLength.y + pad));

    const zmin = f32(f32(colCtx.subdivLength.z * sz) + colCtx.minBounds.z - BGCHECK_SUBDIV_OVERLAP);
    const zmax = f32(zmin + f32(colCtx.subdivLength.z + pad));

    return { xmin, xmax, ymin, ymax, zmin, zmax };
}

// True if world-space point (x,y,z) falls within subdivision cell (sx,sy,sz)'s
// true overlap-padded bounds.
export function pointInSubdivisionCell(colCtx, sx, sy, sz, x, y, z) {
    const b = getSubdivisionCellBounds(colCtx, sx, sy, sz);
    return x >= b.xmin && x <= b.xmax &&
           y >= b.ymin && y <= b.ymax &&
           z >= b.zmin && z <= b.zmax;
}

function getPolySubdivisionBounds(colCtx, poly, outMin, outMax) {
    // Get first vertex
    let v = poly.vtxs[0];

    let minV = { x: f32(v.x), y: f32(v.y), z: f32(v.z) };
    let maxV = { x: minV.x, y: minV.y, z: minV.z };

    // Remaining 2 vertices
    for (let i = 1; i < 3; i++) {
        v = poly.vtxs[i];

        const x = f32(v.x);
        const y = f32(v.y);
        const z = f32(v.z);

        if (minV.x > x) minV.x = x; else if (maxV.x < x) maxV.x = x;
        if (minV.y > y) minV.y = y; else if (maxV.y < y) maxV.y = y;
        if (minV.z > z) minV.z = z; else if (maxV.z < z) maxV.z = z;
    }

    // Get subdiv min/max
    getSubdivisionMinBounds(colCtx, minV, outMin);
    getSubdivisionMaxBounds(colCtx, maxV, outMax);
}

export function initializeSubdivisions(game, colCtx, allTriangleData) {
    const COLPOLY_NORMAL_FRAC = f32(1.0 / 32767.0);
    
    const colHeader = colCtx.colHeader;
    const polyMax = colHeader.numPolygons;

    // Clear lookup table
    const total = colCtx.subdivAmount.x * colCtx.subdivAmount.y * colCtx.subdivAmount.z;

    const subdivAmountXY = colCtx.subdivAmount.x * colCtx.subdivAmount.y;

    // Per-poly bookkeeping of exactly which subdivision cells it was
    // registered into as *floor or wall* (i.e. triIntersectsCube returned
    // true for that cell), plus the min/max y-subdivision index it touched.
    // Ceilings are excluded - a downward-facing poly can never be stood on.
    //
    // We track floor+wall together, not just floor: the floor/wall/ceiling
    // split below is keyed purely off Ny thresholds (>0.5 floor, <-0.8
    // ceiling, else wall), but standability (as sampled elsewhere off
    // triChkPointParaYImpl) only requires Ny > 0. A poly with e.g. Ny = 0.02
    // is a perfectly valid standable surface yet lands in the wall bucket,
    // not the floor bucket - so a floor-only registry would wrongly treat
    // every point on it as unregistered anywhere.
    //
    // Consumers (e.g. the sample point generator) use this to tell whether a
    // point sitting on a standable triangle actually falls within a
    // subdivision that triangle is registered in - since collision at
    // runtime is looked up per-subdivision, a point outside all of a
    // triangle's registered cells wouldn't actually be reachable as
    // standable ground on that triangle.
    colCtx.polyStandableSubdivIndices = new Array(allTriangleData.length);
    colCtx.polyStandableYRange = new Array(allTriangleData.length);

    // Each polygon's actual vertex Y range (min/max), independent of the
    // subdivision grid entirely. Subdivision cells can be much taller than
    // any individual polygon inside them, so two polys can share a cell
    // while one is genuinely far above the other in true world space. The
    // occlusion check in sample_points.js uses this to tell whether a
    // candidate polygon registered in the same cell as a query point could
    // plausibly be "hit" by a straight-down scan from that point - a
    // polygon whose entire Y extent sits above the point can't be, no
    // matter how coarse a cell they both happen to share.
    colCtx.polyWorldYRange = new Array(allTriangleData.length);

    // Same idea, but for X/Z: a subdivision cell can be far wider/deeper
    // than any individual polygon inside it, so a candidate sharing the
    // point's cell isn't necessarily anywhere near the point's actual
    // (x,z) position - it could be positioned anywhere else within that
    // whole cell. This is a plain vertex-bounding-box check (not a precise
    // point-in-triangle test), same level of approximation used elsewhere.
    colCtx.polyWorldXZBounds = new Array(allTriangleData.length);

    const subdivLengthX = f32(colCtx.subdivLength.x + f32(2 * BGCHECK_SUBDIV_OVERLAP));
    const subdivLengthY = f32(colCtx.subdivLength.y + f32(2 * BGCHECK_SUBDIV_OVERLAP));
    const subdivLengthZ = f32(colCtx.subdivLength.z + f32(2 * BGCHECK_SUBDIV_OVERLAP));

    const min = colCtx.minBounds;

    // Temporary reusable ints
    let minIdx = { x: 0, y: 0, z: 0 };
    let maxIdx = { x: 0, y: 0, z: 0 };

    for (let arrayIdx = 0; arrayIdx < allTriangleData.length; arrayIdx++) {
        let poly = allTriangleData[arrayIdx];

        // Prefer poly.id (the polygon's true original index) over its
        // position in this array. These only diverge if allTriangleData was
        // built by skipping some polygons while assigning id (e.g. an
        // xpFlags check that does `continue` before pushing) - array
        // position alone would then silently register data under the wrong
        // polygon's index, since consumers (sample_points.js,
        // standable_surfaces.js) look things up by poly.id, not by where a
        // polygon happened to land in this specific array.
        const polyIdx = (poly.id !== undefined && poly.id !== null) ? poly.id : arrayIdx;

        const polyMinY = f32(Math.min(poly.vtxs[0].y, poly.vtxs[1].y, poly.vtxs[2].y));
        const polyMaxY = f32(Math.max(poly.vtxs[0].y, poly.vtxs[1].y, poly.vtxs[2].y));
        colCtx.polyWorldYRange[polyIdx] = { min: polyMinY, max: polyMaxY };

        const polyMinX = f32(Math.min(poly.vtxs[0].x, poly.vtxs[1].x, poly.vtxs[2].x));
        const polyMaxX = f32(Math.max(poly.vtxs[0].x, poly.vtxs[1].x, poly.vtxs[2].x));
        const polyMinZ = f32(Math.min(poly.vtxs[0].z, poly.vtxs[1].z, poly.vtxs[2].z));
        const polyMaxZ = f32(Math.max(poly.vtxs[0].z, poly.vtxs[1].z, poly.vtxs[2].z));
        colCtx.polyWorldXZBounds[polyIdx] = { minX: polyMinX, maxX: polyMaxX, minZ: polyMinZ, maxZ: polyMaxZ };

        getPolySubdivisionBounds(
            colCtx, poly,
            minIdx, maxIdx
        );

        // Starting Z slice
        let baseZ = minIdx.z * subdivAmountXY;

        let curMinZ = f32(f32(colCtx.subdivLength.z * minIdx.z) + min.z - BGCHECK_SUBDIV_OVERLAP);
        let curMaxZ = f32(curMinZ + subdivLengthZ);

        for (let sz = minIdx.z; sz <= maxIdx.z; sz++) {
            
            let baseY = minIdx.y * colCtx.subdivAmount.x;

            let curMinY = f32(f32(colCtx.subdivLength.y * minIdx.y) + min.y - BGCHECK_SUBDIV_OVERLAP);
            let curMaxY = f32(curMinY + subdivLengthY);

            for (let sy = minIdx.y; sy <= maxIdx.y; sy++) {

                let index = baseZ + baseY + minIdx.x;

                let curMinX = f32(f32(colCtx.subdivLength.x * minIdx.x) + min.x - BGCHECK_SUBDIV_OVERLAP);
                let curMaxX = f32(curMinX + subdivLengthX);

                for (let sx = minIdx.x; sx <= maxIdx.x; sx++) {
                    
                    const box = {
                        xmin:curMinX, xmax:curMaxX,
                        ymin:curMinY, ymax:curMaxY,
                        zmin:curMinZ, zmax:curMaxZ,
                    };
                    
                    const tri = [
                        {x:poly.vtxs[0].x, y:poly.vtxs[0].y, z:poly.vtxs[0].z},
                        {x:poly.vtxs[1].x, y:poly.vtxs[1].y, z:poly.vtxs[1].z},
                        {x:poly.vtxs[2].x, y:poly.vtxs[2].y, z:poly.vtxs[2].z},
                    ];
                    
                    if (triIntersectsCube(tri, box)) {
                        // console.log("added poly "+polyIdx+" to subdiv "+index)
                        
                        const ny = f32(poly.normals[1] * COLPOLY_NORMAL_FRAC);

                        if (ny > 0.5) {
                            colCtx.subdivisions[index].floors.push(polyIdx);          // floor
                        } else if (ny < -0.8) {
                            colCtx.subdivisions[index].ceilings.push(polyIdx);          // ceiling
                        } else {
                            colCtx.subdivisions[index].walls.push(polyIdx);          // wall
                        }

                        // Track upward-facing (standable) registrations
                        // together (see comment above
                        // colCtx.polyStandableSubdivIndices). This is
                        // Ny > 0, not just "not a ceiling" - the .walls
                        // bucket above spans -0.8 to 0.5, which includes
                        // downward-facing overhangs (Ny between -0.8 and 0)
                        // that face away from anything standing on or
                        // falling onto them, same as a ceiling does. Only
                        // strictly-upward-facing polys (whether bucketed as
                        // a floor or as a shallow "wall") can actually be
                        // stood on or catch a falling character, so those
                        // are the only ones that belong here.
                        if (ny > f32(0.0)) {
                            if (!colCtx.polyStandableSubdivIndices[polyIdx]) {
                                colCtx.polyStandableSubdivIndices[polyIdx] = new Set();
                                colCtx.polyStandableYRange[polyIdx] = { min: sy, max: sy };
                            }
                            colCtx.polyStandableSubdivIndices[polyIdx].add(index);

                            const yRange = colCtx.polyStandableYRange[polyIdx];
                            if (sy < yRange.min) yRange.min = sy;
                            if (sy > yRange.max) yRange.max = sy;

                            // Per-cell mirror of the same thing, so a
                            // consumer checking "does this cell contain any
                            // standable poly" (e.g. an occlusion check) can
                            // query it directly instead of having to
                            // re-filter .floors/.walls by Ny itself.
                            colCtx.subdivisions[index].standable.push(polyIdx);
                        }
                    }

                    curMinX = f32(curMinX + colCtx.subdivLength.x);
                    curMaxX = f32(curMaxX + colCtx.subdivLength.x);
                    index++;
                }

                curMinY = f32(curMinY + colCtx.subdivLength.y);
                curMaxY = f32(curMaxY + colCtx.subdivLength.y);
                baseY += colCtx.subdivAmount.x;
            }

            curMinZ = f32(curMinZ + colCtx.subdivLength.z);
            curMaxZ = f32(curMaxZ + colCtx.subdivLength.z);
            baseZ += subdivAmountXY;
        }
    }

    return;
}

// Returns the f32 value `steps` ULPs away from `v` (negative steps = down).
// Standard "biased key" bit trick: reinterpret the IEEE754 bit pattern as a
// monotonically-increasing unsigned integer (flip all bits if negative, else
// just set the sign bit), so integer +/-1 on that key is exactly +/-1 ULP in
// the real value, for either sign.
function f32Step(v, steps) {
    const buf = new ArrayBuffer(4);
    const fv = new Float32Array(buf);
    const iv = new Uint32Array(buf);
    fv[0] = f32(v);
    const bits = iv[0];
    let key = (bits & 0x80000000) !== 0 ? (~bits >>> 0) : ((bits | 0x80000000) >>> 0);
    key = (key + steps) >>> 0;
    iv[0] = (key & 0x80000000) !== 0 ? (key & 0x7fffffff) >>> 0 : (~key >>> 0);
    return fv[0];
}

// Returns the Set of Y subdivision row indices (0..subdivAmount.y-1) that can
// be silently skipped by a real floor raycast (BgCheck_RaycastFloorImpl) due
// to float32 rounding in sector.y = (s32)((checkPos.y - minBounds.y) *
// subdivLengthInv.y) - see the much longer write-up above logSubdivisionYSkips
// in parse_model.js for the full derivation. Two independent failure modes
// are checked, both walking the full checkPos.y sequence (starting near each
// internal boundary minus BGCHECK_SUBDIV_OVERLAP, scanned across a wide ULP
// neighborhood since real gameplay Y is essentially never the "clean" value):
//   1. Mid-walk jump: the computed row drops by more than 1 between
//      consecutive steps (each step individually looks locally consistent,
//      but a row in between never got tested at all).
//   2. Row-0 early exit: the raycast's own `while (checkPos.y >= minBounds.y)`
//      loop guard evaluates false one iteration too early, so the lowest
//      row(s) never get tested at all - sector.y itself can never go
//      negative for a value the loop actually tests (see chat discussion),
//      so this is the only way the very bottom row can be skipped.
export function computeVulnerableYRows(colCtx, ULP_RADIUS = 8192) {
    const minY = colCtx.minBounds.y;
    const lenY = colCtx.subdivLength.y;
    const invY = colCtx.subdivLengthInv.y;
    const amountY = colCtx.subdivAmount.y;
    const checkHeight = BGCHECK_SUBDIV_OVERLAP;
    const MAX_STEPS = amountY + 4;

    const vulnerable = new Set();

    for (let j = 1; j < amountY; j++) {
        const boundaryY = f32(minY + f32(lenY * j));
        const cleanPosY = f32(boundaryY - checkHeight);

        for (let s = -ULP_RADIUS; s <= ULP_RADIUS; s++) {
            const posY = f32Step(cleanPosY, s);

            let checkY = f32(posY + checkHeight);
            let prev = null;
            let steps = 0;
            while (steps < MAX_STEPS && checkY >= minY) {
                const diff = f32(checkY - minY);
                const computedRow = Math.trunc(f32(diff * invY));
                checkY = f32(checkY - lenY);

                if (prev !== null && prev - computedRow > 1) {
                    for (let r = computedRow + 1; r < prev; r++) {
                        if (r >= 0 && r < amountY) vulnerable.add(r);
                    }
                }
                prev = computedRow;
                steps++;
            }

            // Loop exited because checkY < minY. If the last row actually
            // tested (prev) was above 0, every row from 0 up to prev-1 never
            // got a chance at all - the loop bailed out too early.
            if (prev !== null && prev > 0) {
                for (let r = 0; r < prev; r++) {
                    if (r < amountY) vulnerable.add(r);
                }
            }
        }
    }

    return vulnerable;
}

/*
// Usage
const tri = [
    {x:0, y:0, z:0},
    {x:2, y:0, z:0},
    {x:1, y:2, z:0},
];

const box = {
    xmin:0.5, xmax:1.5,
    ymin:-1, ymax:1,
    zmin:-1, zmax:1,
};

console.log(triIntersectsCube(tri, box));  // true
*/
