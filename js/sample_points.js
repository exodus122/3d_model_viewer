import * as THREE from 'three';
import { getPointSubdivisionIndex, decomposeSubdivIndex, BGCHECK_SUBDIV_OVERLAP } from './subdivisions.js';

////////////////////////////////////////
// System: Sample Standable Polygon Surface
////////////////////////////////////////

const samplePointsContainer = document.getElementById("samplePointsContainer"); 
const samplePointsCheckbox  = document.getElementById("samplePointsCheckbox");
const samplePointsResolution  = document.getElementById("samplePointsResolution");

// Debug-only toggle: when checked, points that got filtered out by
// isSamplePointValid are still generated and rendered (in a different
// color) instead of being silently dropped, so they can be compared
// against in-game testing rather than just trusting the filter. Off by
// default so normal use is unaffected. Created dynamically so no
// index.html changes are needed.
const showExcludedPointsCheckbox = document.createElement('input');
showExcludedPointsCheckbox.type = 'checkbox';
showExcludedPointsCheckbox.id = 'showExcludedPointsCheckbox';
const showExcludedPointsLabel = document.createElement('label');
showExcludedPointsLabel.htmlFor = 'showExcludedPointsCheckbox';
showExcludedPointsLabel.textContent = 'Show excluded points (debug)';
showExcludedPointsLabel.style.marginLeft = '4px';
if (samplePointsContainer) {
    samplePointsContainer.appendChild(showExcludedPointsCheckbox);
    samplePointsContainer.appendChild(showExcludedPointsLabel);
}

// Target number of points per triangle (adjust as needed)
const TARGET_POINTS_PER_TRIANGLE = 500;

// Global flag to check if sampling is in progress
let isSamplingInProgress = false;
let currentPointsObject = null;
let currentExcludedPointsObject = null;

// ------------------------
// Helper Functions
// ------------------------

// Distance squared from point (x0,z0) to segment (x1,z1)-(x2,z2)
function pointDistSqToLine2D(z, x, z0, x0, z1, x1) {
    const dz = z1 - z0;
    const dx = x1 - x0;

    const lenSq = dz*dz + dx*dx;
    if (lenSq === 0) return { hit: false, d2: 0 };

    const t = ((z - z0) * dz + (x - x0) * dx) / lenSq;
    if (t < 0 || t > 1) return { hit: false, d2: 0 };

    const projZ = z0 + t * dz;
    const projX = x0 + t * dx;

    const dZ = projZ - z;
    const dX = projX - x;

    return { hit: true, d2: dZ*dZ + dX*dX };
}

// Cir-square vs tri-square
function cirSquareVsTriSquare(x0,y0, x1,y1, x2,y2, cx,cy, r) {
    x0 = Math.fround(x0); 
    x1 = Math.fround(x1); 
    x2 = Math.fround(x2);
    y0 = Math.fround(y0);
    y1 = Math.fround(y1);
    y2 = Math.fround(y2);
    cx = Math.fround(cx);
    cy = Math.fround(cy);
    r  = Math.fround(r);

    let minX = Math.fround(x0);
    let maxX = Math.fround(x0);
    let minY = Math.fround(y0);
    let maxY = Math.fround(y0);

    if (x1 < minX) minX = Math.fround(x1); else if (maxX < x1) maxX = Math.fround(x1);
    if (y1 < minY) minY = Math.fround(y1); else if (maxY < y1) maxY = Math.fround(y1);

    if (x2 < minX) minX = Math.fround(x2); else if (maxX < x2) maxX = Math.fround(x2);
    if (y2 < minY) minY = Math.fround(y2); else if (maxY < y2) maxY = Math.fround(y2);

    return (Math.fround(minX - r) <= cx &&
            Math.fround(maxX + r) >= cx &&
            Math.fround(minY - r) <= cy &&
            Math.fround(maxY + r) >= cy);
}

// Determinant tolerance for the floor check, and the ONLY thing that differs
// between static scene collision and dynapoly collision.
//
// Both paths run the identical Math3D_TriChkPointParaYImpl with the identical
// chkDist of 1.0 (BgCheck_RaycastDownImpl passes its chkDist straight through
// to both). What differs is which wrapper calls it:
//
//   static  BgCheck_RaycastDownStaticList
//             -> CollisionPoly_CheckYIntersect
//             -> Math3D_TriChkPointParaYIntersectInsideTri   detMax = 0.0f
//
//   dyna    BgCheck_RaycastDownDynaList
//             -> CollisionPoly_CheckYIntersectApprox1
//             -> Math3D_TriChkPointParaYIntersectDist        detMax = 300.0f
//
// The determinant of an edge against the sample point is twice the area of the
// triangle (point, vA, vB), i.e. |edge| * distance-from-the-edge-line. So a
// detMax of 300 lets a point sit up to 300/|edge| units beyond an edge -- a
// long 600-unit edge buys only 0.5 units, but a short 20-unit edge buys 15.
// That is why Link can stand noticeably further off the side of a small
// dynapoly poly than off a static one.
//
// The expansion is still hard-capped by the Cir-Square-vs-Tri-Square gate
// below, which rejects anything outside the triangle's XZ bounding box grown
// by chkDist -- so the region never exceeds bbox +/- 1.0 either way.
const DET_MAX_STATIC = 0.0;
const DET_MAX_DYNAPOLY = 300.0;

// z,x order matches OoT exactly
function triChkPointParaYImpl(v0, v1, v2, z, x, detMax, chkDist, ny) {
    if (isZero(ny)) {
        return false;
    }

    // ---- Cir-Square vs Tri-Square ----
    if (!cirSquareVsTriSquare(
        v0.z, v0.x,
        v1.z, v1.x,
        v2.z, v2.x,
        z, x,
        chkDist
    )) {
        return false;
    }

    const chkDistSq = chkDist * chkDist;

    // ---- Vertex distance check ----
    if (((v0.z - z) ** 2 + (v0.x - x) ** 2) < chkDistSq ||
        ((v1.z - z) ** 2 + (v1.x - x) ** 2) < chkDistSq ||
        ((v2.z - z) ** 2 + (v2.x - x) ** 2) < chkDistSq) {

        return true;
    }

    // ---- Determinant checks ----
    const detv0v1 = ((v0.z - z) * (v1.x - x)) - ((v0.x - x) * (v1.z - z));
    const detv1v2 = ((v1.z - z) * (v2.x - x)) - ((v1.x - x) * (v2.z - z));
    const detv2v0 = ((v2.z - z) * (v0.x - x)) - ((v2.x - x) * (v0.z - z));

    // Same logic as the real game: inside if all ≤ detMax OR all ≥ -detMax
    if (detMax >= detv0v1 && detMax >= detv1v2 && detMax >= detv2v0) return true;
    if (-detMax <= detv0v1 && -detMax <= detv1v2 && -detMax <= detv2v0) return true;

    // ---- Edge distance expansion for steep triangles ----
    if (Math.abs(ny) > 0.5) {

        // PointDistSqToLine2D matches Math3D_PointDistSqToLine2D
        let L;

        L = pointDistSqToLine2D(z, x, v0.z, v0.x, v1.z, v1.x);
        if (L.hit && L.d2 < chkDistSq) return true;

        L = pointDistSqToLine2D(z, x, v1.z, v1.x, v2.z, v2.x);
        if (L.hit && L.d2 < chkDistSq) return true;

        L = pointDistSqToLine2D(z, x, v2.z, v2.x, v0.z, v0.x);
        if (L.hit && L.d2 < chkDistSq) return true;
    }

    return false;
}

// Compute Y from plane
function computeYFromPlane(nx,ny,nz,d,x,z) {
    if (isZero(ny)) return 0;
    return (f32)((((-nx * x) - (nz * z)) - d) / ny);
}

// Calculate the area of a triangle in the XZ plane
function calculateTriangleXZArea(v0, v1, v2) {
    // Using the shoelace formula for the 2D polygon area
    const area = Math.abs(
        (v0.x * (v1.z - v2.z) +
         v1.x * (v2.z - v0.z) +
         v2.x * (v0.z - v1.z)) / 2
    );
    return area;
}

// Calculate adaptive resolution based on triangle area
function calculateAdaptiveResolution(tri, baseResolution) {
    const v0 = tri.vtxs[0], v1 = tri.vtxs[1], v2 = tri.vtxs[2];
    
    // Calculate the XZ area of the triangle
    const xzArea = calculateTriangleXZArea(v0, v1, v2);
    
    // If area is very small, use a minimum resolution
    // If area is very large, increase resolution step size
    const MIN_AREA = 1.0;
    const MAX_AREA = 100000.0;
    const clampedArea = Math.max(MIN_AREA, Math.min(MAX_AREA, xzArea));
    
    // Calculate the step size that would give us the target number of points
    const stepSize = Math.sqrt(clampedArea / TARGET_POINTS_PER_TRIANGLE);
    
    // Clamp the step size to reasonable bounds
    const minStep = 0.5;  // Minimum step to prevent too many points on tiny triangles
    const maxStep = 50.0; // Maximum step to prevent too few points on huge triangles
    const clampedStep = Math.max(minStep, Math.min(maxStep, stepSize));
    
    // Apply the user's resolution as a multiplier
    const userMultiplier = baseResolution / 0.1;
    const finalStep = clampedStep * userMultiplier;
    
    return finalStep;
}

// Checks whether a sample point generated from triangle `polyIdx` is
// actually reachable as standable ground on that triangle, mirroring how
// the real floor search works:
//
//  - VERTEX-Y GUARD: reject outright if the point's Y has dropped below the
//    triangle's own lowest vertex by more than BGCHECK_SUBDIV_OVERLAP. This
//    exists because subdivision cells are too coarse on their own to catch
//    a plane-equation blowup on a near-vertical/shallow triangle - a small
//    X/Z sampling deviation can compute a Y hundreds of units away from
//    anything the triangle's actual geometry represents, while still
//    landing in a subdivision cell the triangle happens to be registered
//    in (registration can legitimately extend one cell past a triangle's
//    own vertex range because of that same overlap margin). See the case
//    below for what's left to the subdivision logic once this guard passes.
//
//  - TRIVIAL CASE: if the point's own subdivision cell (exact match, no
//    overlap padding) is one this triangle is registered in as standable
//    ground (floor or wall - see colCtx.polyStandableSubdivIndices in
//    subdivisions.js; ceilings are excluded since they can't be stood on),
//    it's valid immediately - regardless of what else might be registered
//    in that same cell alongside it.
//
//    This intentionally does NOT use the cells' overlap-padded world-space
//    bounds (BGCHECK_SUBDIV_OVERLAP) - that was tried, since a naive
//    truncated point-index can in principle land one cell off from where a
//    triangle registered near a subdivision boundary, but it caused false
//    positives in practice: the padded box of a triangle's true cell can
//    reach far enough into the cell below it that a point genuinely in that
//    lower, unregistered cell would wrongly pass here - before the
//    downward-scan/occlusion logic below (which would have correctly
//    rejected it) ever runs.
//
//  - DOWNWARD SCAN: otherwise, look straight down through this (x,z)
//    column's subdivisions from the point's own cell for the closest one
//    (if any) this triangle is registered in. If none is found before
//    running out of subdivisions below the point, the triangle is either
//    entirely below the point or not in this column at all - invalid.
//
//  - OCCLUSION CHECK: if a lower cell containing the triangle *is* found,
//    the point is above the triangle in this column. This is only valid if
//    nothing else that's actually upward-facing (Ny > 0 - a different
//    standable triangle, whether bucketed as a floor or a shallow "wall")
//    AND at or below the point's actual Y (see colCtx.polyWorldYRange in
//    subdivisions.js - a candidate whose entire vertex range sits above
//    the point can't be hit by a straight-down scan from it, even if it
//    happens to share the point's coarse cell) is registered anywhere from
//    the point's own cell down through (but not including) the triangle's
//    own cell - otherwise, a real straight-down search would hit that
//    other triangle first. A downward-facing "wall" (Ny between -0.8 and
//    0, an overhang) doesn't count, same as a ceiling doesn't - neither
//    can catch a falling character. The point's own cell IS included in
//    this check (a different triangle there blocks it too, same as
//    anywhere else in the range) - only the triangle's own target cell is
//    excluded, since other triangles sharing that specific cell don't
//    matter (that's where the search successfully ends either way).
export function isSamplePointValid(colCtx, polyIdx, x, y, z, triMinVertexY) {
    if (!colCtx || polyIdx === undefined || polyIdx === null) return true;

    // VERTEX-Y GUARD: subdivision cells alone aren't fine-grained enough to
    // catch a plane-equation blowup on a near-vertical/shallow triangle - a
    // triangle's registration can legitimately extend one cell past its own
    // vertex range (see BGCHECK_SUBDIV_OVERLAP in subdivisions.js), and once
    // the downward scan below finds *a* registered cell, it doesn't care how
    // far the computed Y has drifted from the triangle's actual geometry.
    // So first reject anything that's dropped further below the triangle's
    // own lowest vertex than that same overlap margin allows - this is the
    // real tolerance the collision system itself uses, not an arbitrary one.
    if (triMinVertexY !== undefined && triMinVertexY !== null &&
        y < f32(triMinVertexY) - BGCHECK_SUBDIV_OVERLAP) {
        return false;
    }

    const standableSet = colCtx.polyStandableSubdivIndices && colCtx.polyStandableSubdivIndices[polyIdx];
    if (!standableSet) {
        // Never registered as standable ground (floor or wall) in any
        // subdivision - shouldn't normally happen for real geometry, but if
        // it does, the game would never surface this triangle via a floor
        // check anywhere.
        return false;
    }

    const registeredCells = [];
    for (const regIndex of standableSet) {
        registeredCells.push(decomposeSubdivIndex(colCtx, regIndex));
    }

    const { sx, sy, sz, index } = getPointSubdivisionIndex(colCtx, { x, y, z });

    // TRIVIAL CASE: point's own cell (exact match, no overlap padding)
    // is one this triangle is registered in.
    //
    // This deliberately does NOT use the cells' overlap-padded bounds
    // (BGCHECK_SUBDIV_OVERLAP) - that was tried and caused false positives:
    // the padded box of the triangle's true cell can extend far enough into
    // the cell below it that a point genuinely in that lower (unregistered)
    // cell would wrongly pass here, before ever reaching the downward-scan/
    // occlusion logic that would have correctly rejected it.
    if (standableSet.has(index)) return true;

    // DOWNWARD SCAN: closest registered cell strictly below the point, in
    // this same (sx,sz) column.
    let targetSy = null;
    for (const c of registeredCells) {
        if (c.sx === sx && c.sz === sz && c.sy < sy) {
            if (targetSy === null || c.sy > targetSy) targetSy = c.sy;
        }
    }

    if (targetSy === null) {
        return false;
    }

    // OCCLUSION CHECK: scan from the point's own cell down through (but not
    // including) the triangle's topmost registered cell in this column.
    // Uses each cell's .standable list (Ny>0 polys only, same rule as
    // colCtx.polyStandableSubdivIndices - see subdivisions.js) rather than
    // raw .floors/.walls: a downward-facing "wall" (Ny between -0.8 and 0,
    // an overhang) can't catch a falling character any more than a ceiling
    // can, so it shouldn't count as an occluder here.
    //
    // Also filters by colCtx.polyWorldYRange and colCtx.polyWorldXZBounds:
    // a subdivision cell can be far taller/wider/deeper than any individual
    // polygon inside it, so a candidate sharing the point's own cell isn't
    // necessarily anywhere near the point - if its entire vertex Y range
    // sits above the point's actual Y, or its X/Z footprint doesn't
    // actually overlap the point's (x,z) position at all, it can't be hit
    // by a straight-down scan starting at the point, no matter how coarse
    // a cell they both happen to be registered in.
    const subdivAmountXY = colCtx.subdivAmount.x * colCtx.subdivAmount.y;
    for (let s = sy; s > targetSy; s--) {
        const cellIndex = (sz * subdivAmountXY) + (s * colCtx.subdivAmount.x) + sx;
        const cell = colCtx.subdivisions[cellIndex];
        if (cell && cell.standable) {
            const blocker = cell.standable.find(p => {
                if (p === polyIdx) return false;

                const yRange = colCtx.polyWorldYRange && colCtx.polyWorldYRange[p];
                // If we don't have Y-range data for some reason, fall back
                // to the old (coarser) behavior of treating it as a blocker.
                if (yRange && yRange.max > y) return false;

                const xzBounds = colCtx.polyWorldXZBounds && colCtx.polyWorldXZBounds[p];
                // Same idea for X/Z: a candidate sharing the point's coarse
                // cell could be positioned anywhere else within that whole
                // cell, so only count it if its own footprint actually
                // overlaps the point's (x,z) position. Falls back to
                // treating it as a blocker if we don't have this data.
                if (xzBounds && (x < xzBounds.minX || x > xzBounds.maxX || z < xzBounds.minZ || z > xzBounds.maxZ)) return false;

                return true;
            });
            if (blocker !== undefined) {
                return false;
            }
        }
    }

    return true;
}

// Process a single triangle and return its points
function processSingleTriangle(tri, resolution, colCtx = null, polyIdx = null, isDynaPoly = false) {
    const COLPOLY_NORMAL_FRAC = 1.0 / 32767.0;

    const v0 = tri.vtxs[0], v1 = tri.vtxs[1], v2 = tri.vtxs[2];
    const nx = tri.normals[0] * COLPOLY_NORMAL_FRAC;
    const ny = tri.normals[1] * COLPOLY_NORMAL_FRAC;
    const nz = tri.normals[2] * COLPOLY_NORMAL_FRAC;
    const d = tri.d;

    // Identical for static and dynapoly -- see BgCheck_EntityRaycastDown5,
    // which hardcodes 1.0f and hands the same value to both paths.
    const chkDist = 1.0;

    const detMax = isDynaPoly ? DET_MAX_DYNAPOLY : DET_MAX_STATIC;

    // Triangle's own actual vertex Y range - used by isSamplePointValid's
    // vertex-Y guard to sanity-bound how far below a computed sample point
    // is allowed to fall.
    const triMinVertexY = Math.min(v0.y, v1.y, v2.y);

    // Compute bounds
    const xs = [v0.x, v1.x, v2.x], zs = [v0.z, v1.z, v2.z];
    const minX = Math.min(...xs) - chkDist, maxX = Math.max(...xs) + chkDist;
    const minZ = Math.min(...zs) - chkDist, maxZ = Math.max(...zs) + chkDist;

    const result = [];
    
    // Calculate area-based step size
    const adaptiveStep = calculateAdaptiveResolution(tri, resolution);
    
    // For very small triangles, just sample the center
    if (adaptiveStep > (maxX - minX) * 2 || adaptiveStep > (maxZ - minZ) * 2) {
        const centerX = (v0.x + v1.x + v2.x) / 3;
        const centerZ = (v0.z + v1.z + v2.z) / 3;
        const y = computeYFromPlane(nx, ny, nz, d, centerX, centerZ);
        const centerValid = isSamplePointValid(colCtx, polyIdx, f32(centerX), y, f32(centerZ), triMinVertexY);
        result.push({
            x: f32(centerX),
            z: f32(centerZ),
            y: y,
            valid: centerValid
        });
        return result;
    }

    // Use simple for loops for better performance
    for (let x = minX; x <= maxX; x += adaptiveStep) {
        const fx = f32(x);
        for (let z = minZ; z <= maxZ; z += adaptiveStep) {
            const fz = f32(z);

            if (!triChkPointParaYImpl(v0, v1, v2, fz, fx, detMax, chkDist, ny)) {
                continue;
            }

            const y = computeYFromPlane(nx, ny, nz, d, fx, fz);

            const pointValid = isSamplePointValid(colCtx, polyIdx, fx, y, fz, triMinVertexY);

            result.push({
                x: fx,
                z: fz,
                y: y,
                valid: pointValid
            });
        }
    }
    
    return result;
}


export function updateSamplePointsUIVisibility(game) {
    if (["OOT","MM","OOT3D","MM3D"].includes(game)) {
        samplePointsContainer.style.display = "flex";
    } else {
        samplePointsContainer.style.display = "none";
    }
}

samplePointsCheckbox.addEventListener("change", () => {
    samplePointsEnabled = samplePointsCheckbox.checked;
});

// Must match the #samplePointsResolution slider's min/max in index.html.
// The slider itself stays a normal left-to-right range input; we just flip
// which end of it means "dense" here so right = dense, left = sparse.
const SAMPLE_STEP_SLIDER_MIN = 0.005;
const SAMPLE_STEP_SLIDER_MAX = 0.03;

// Main function to draw sampled triangles - synchronous version for selection.js
//
// colCtx (optional): the collision context built by initColCtx +
// initializeSubdivisions in subdivisions.js, from the SAME allTriangleData
// array (unfiltered, so indices line up). When provided, generated points
// are checked against the subdivisions their source triangle was actually
// registered in as a floor, and points that fall below all of those
// subdivisions are discarded. Omit it to fall back to the old unfiltered
// behavior.
//
// isDynaPoly (optional): true when the triangles come from a dynapoly actor
// rather than static scene collision. Dynapoly floors are matched with a
// determinant tolerance of 300 instead of 0, so their standable region extends
// further past the poly's edges. See DET_MAX_DYNAPOLY above.
export function drawSampledTriangles(scene, allTriangleData, sampleStep = 0.1, colCtx = null, isDynaPoly = false) {
    // Prevent multiple simultaneous sampling operations
    if (isSamplingInProgress) {
        console.warn("Sampling already in progress, please wait...");
        return null;
    }

    // Invert the raw slider value: dragging right (toward the slider's max)
    // should give a smaller/denser step, and left (toward min) a larger/sparser one.
    if (sampleStep >= SAMPLE_STEP_SLIDER_MIN && sampleStep <= SAMPLE_STEP_SLIDER_MAX) {
        sampleStep = (SAMPLE_STEP_SLIDER_MIN + SAMPLE_STEP_SLIDER_MAX) - sampleStep;
    }
    
    // Remove existing points if any
    removeExistingPoints(scene);
    
    isSamplingInProgress = true;
    
    try {
        // Filter out invalid triangles, keeping each triangle's original
        // polygon index so it still matches up with colCtx's per-poly
        // subdivision data. Prefer tri.id (the polygon's actual index at
        // parse time, e.g. allTriangleData[i].id === i in parse_model.js)
        // over the array position here, since a caller may pass a smaller
        // synthetic array (selection.js samples just the one selected
        // triangle) whose position in THAT array is meaningless to colCtx.
        const validTriangles = [];
        allTriangleData.forEach((tri, arrayIdx) => {
            if (tri && tri.vtxs && tri.vtxs.length === 3 &&
                tri.vtxs[0] && tri.vtxs[1] && tri.vtxs[2] &&
                tri.normals && tri.normals.length === 3) {
                const polyIdx = (tri.id !== undefined && tri.id !== null) ? tri.id : arrayIdx;
                validTriangles.push({ tri, polyIdx });
            }
        });
        
        if (validTriangles.length === 0) {
            console.warn("No valid triangles to sample");
            isSamplingInProgress = false;
            return null;
        }
        
        console.log(`Processing ${validTriangles.length} triangle(s)...`);
        
        // Process all triangles
        const allPoints = [];
        
        for (let i = 0; i < validTriangles.length; i++) {
            const { tri, polyIdx } = validTriangles[i];
            const points = processSingleTriangle(tri, sampleStep, colCtx, polyIdx, isDynaPoly);
            allPoints.push(...points);
            
            if (validTriangles.length > 1 && i % 10 === 0) {
                console.log(`Processed ${i + 1}/${validTriangles.length} triangles, total points so far: ${allPoints.length}`);
            }
        }

        const validPoints = allPoints.filter(p => p.valid);
        const excludedPoints = allPoints.filter(p => !p.valid);

        console.log(`Total points generated: ${validPoints.length} valid, ${excludedPoints.length} excluded, from ${validTriangles.length} triangle(s)`);

        // If no points were generated at all, return null
        if (validPoints.length === 0 && excludedPoints.length === 0) {
            console.warn("No points were generated. The triangle may not be standable or the resolution may be too high.");
            isSamplingInProgress = false;
            return null;
        }

        // If we have too many points, warn and maybe limit
        if (validPoints.length > 5000000) {
            console.warn(`Warning: ${validPoints.length} points is a very large number. Consider increasing the resolution.`);
        }

        // Builds a THREE.Points mesh from a list of {x,y,z} points, sized
        // relative to the point count and depth-biased toward the camera
        // (see the comment inside) so points don't lose depth-ties against
        // whatever surface they were sampled from.
        function buildPointsMesh(points, color, name) {
            if (points.length === 0) return null;

            const vertices = new Float32Array(points.length * 3);
            let offset = 0;
            for (let i = 0; i < points.length; i++) {
                const p = points[i];
                vertices[offset++] = Math.fround(p.x);
                vertices[offset++] = Math.fround(p.y);
                vertices[offset++] = Math.fround(p.z);
            }

            const geometry = new THREE.BufferGeometry();
            geometry.setAttribute('position', new THREE.BufferAttribute(vertices, 3));

            // Calculate point size based on total points to prevent overdraw
            let pointSize = 0.5;
            if (points.length > 100000) pointSize = 0.3;
            if (points.length > 500000) pointSize = 0.2;
            if (points.length > 1000000) pointSize = 0.15;
            if (points.length > 5000000) pointSize = 0.1;

            const material = new THREE.PointsMaterial({
                color: color,
                size: pointSize,
                sizeAttenuation: true,
                transparent: true,
                opacity: 0.9
            });

            // WebGL's polygonOffset doesn't apply to POINTS draws, so points can
            // still lose depth-ties against whatever they were sampled from,
            // especially from angles where the earlier per-point normal offset
            // doesn't point toward the camera. This nudges each point's clip-space
            // depth toward the camera by a small amount proportional to distance
            // (the same idea real GL polygon offset uses for triangles), which
            // works regardless of camera angle or surface orientation.
            const POINT_DEPTH_BIAS = 0.0015;
            material.onBeforeCompile = (shader) => {
                shader.vertexShader = shader.vertexShader.replace(
                    '#include <project_vertex>',
                    `#include <project_vertex>
                    gl_Position.z -= ${POINT_DEPTH_BIAS.toFixed(6)} * gl_Position.w;`
                );
            };

            const pts = new THREE.Points(geometry, material);
            pts.name = name;
            pts.renderOrder = 1001; // draw in front of waterboxes and other meshes
            return pts;
        }

        const pts = buildPointsMesh(validPoints, 0xff0000, "SampledPoints");
        if (pts) {
            scene.add(pts);
            currentPointsObject = pts;
            loadedModels.push({ name: "Points", mesh: pts, edges: null });
        }

        // Excluded points get a visually distinct color and start hidden -
        // toggle "Show excluded points (debug)" to compare them in-game.
        const excludedPts = buildPointsMesh(excludedPoints, 0xffa500, "ExcludedSampledPoints");
        if (excludedPts) {
            excludedPts.visible = showExcludedPointsCheckbox.checked;
            scene.add(excludedPts);
            currentExcludedPointsObject = excludedPts;
            loadedModels.push({ name: "ExcludedPoints", mesh: excludedPts, edges: null });
        }

        isSamplingInProgress = false;
        return pts || excludedPts;
        
    } catch (error) {
        console.error("Error during sampling:", error);
        isSamplingInProgress = false;
        return null;
    }
}


function removeExistingModel(scene, modelName) {
    const existing = loadedModels.find(m => m.name === modelName);
    if (existing) {
        // Find the UI container for this model and click its delete button.
        const section = document.querySelector('.controls');
        const children = Array.from(section.children);

        for (const child of children) {
            if (child.dataset && child.dataset.modelName === modelName) {
                const delBtn = child.querySelector('.delete-btn');
                if (delBtn) delBtn.click();
                break;
            }
        }
    }
}

function removeExistingPoints(scene) {
    removeExistingModel(scene, "Points");
    removeExistingModel(scene, "ExcludedPoints");
}

// Export for external use
export function removeAllSampledPoints(scene) {
    removeExistingPoints(scene);
}

// Clean up function for when the scene changes
export function cleanupSampledPoints() {
    if (currentPointsObject) {
        // The scene will handle removal when the model is removed
        currentPointsObject = null;
    }
    if (currentExcludedPointsObject) {
        currentExcludedPointsObject = null;
    }
}

// Live-toggle the excluded points' visibility without needing to
// regenerate them - lets you flip the debug view on/off instantly while
// comparing against in-game testing.
showExcludedPointsCheckbox.addEventListener("change", () => {
    if (currentExcludedPointsObject) {
        currentExcludedPointsObject.visible = showExcludedPointsCheckbox.checked;
    }
});