////////////////////////////////////////
// System: Subdivisions
////////////////////////////////////////

const BGCHECK_Y_MIN = f32(-32000.0);
const BGCHECK_Y_MAX = f32(32000.0);
const BGCHECK_XYZ_ABSMAX = f32(32760.0);
const BGCHECK_SUBDIV_OVERLAP = f32(50.0);
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
                    ceilings: []
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
    out.sx = sx;
    out.sy = sy;
    out.sz = sz;
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
    const colHeader = colCtx.colHeader;
    const polyMax = colHeader.numPolygons;

    // Clear lookup table
    const total = colCtx.subdivAmount.x * colCtx.subdivAmount.y * colCtx.subdivAmount.z;

    const subdivAmountXY = colCtx.subdivAmount.x * colCtx.subdivAmount.y;

    const subdivLengthX = f32(colCtx.subdivLength.x + f32(2 * BGCHECK_SUBDIV_OVERLAP));
    const subdivLengthY = f32(colCtx.subdivLength.y + f32(2 * BGCHECK_SUBDIV_OVERLAP));
    const subdivLengthZ = f32(colCtx.subdivLength.z + f32(2 * BGCHECK_SUBDIV_OVERLAP));

    const min = colCtx.minBounds;

    // Temporary reusable ints
    let minIdx = { x: 0, y: 0, z: 0 };
    let maxIdx = { x: 0, y: 0, z: 0 };

    for (let polyIdx = 0; polyIdx < allTriangleData.length; polyIdx++) {
        let poly = allTriangleData[polyIdx];
        
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
                        
                        if (f32(poly.normals[1] * COLPOLY_NORMAL_FRAC) > 0.5) {
                            colCtx.subdivisions[index].floors.push(polyIdx);          // floor
                        } else if (f32(poly.normals[1] * COLPOLY_NORMAL_FRAC) < -0.8) {
                            colCtx.subdivisions[index].ceilings.push(polyIdx);          // ceiling
                        } else {
                            colCtx.subdivisions[index].walls.push(polyIdx);          // wall
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
