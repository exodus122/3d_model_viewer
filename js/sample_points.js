////////////////////////////////////////
// System: Sample Standable Polygon Surface
////////////////////////////////////////

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { PointerLockControls } from 'three/addons/controls/PointerLockControls.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';

const samplePointsContainer = document.getElementById("samplePointsContainer"); 
const samplePointsCheckbox  = document.getElementById("samplePointsCheckbox");
const samplePointsResolution  = document.getElementById("samplePointsResolution");

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

// z,x order matches OoT exactly
function triChkPointParaYImpl(v0, v1, v2, z, x, detMax, chkDist, ny) {

    //if (x > 842.25 && x < 842.35 && z > -2139.45 && z < -2139.35)
    //    console.log("test");

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
    //return f32((-(nx*x + nz*z) - d)/ny);
    return (f32)((((-nx * x) - (nz * z)) - d) / ny);
}

// ------------------------
// Game-accurate Sampling
// ------------------------

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

function sampledStandableFootprint(tri, resolution=0.25) {
    const v0 = tri.vtxs[0], v1 = tri.vtxs[1], v2 = tri.vtxs[2];
    const nx = tri.normals[0] * COLPOLY_NORMAL_FRAC;
    const ny = tri.normals[1] * COLPOLY_NORMAL_FRAC;
    const nz = tri.normals[2] * COLPOLY_NORMAL_FRAC;
    const d = tri.d;
    const chkDist = 1.0;

    // Compute bounds
    const xs = [v0.x, v1.x, v2.x], zs = [v0.z, v1.z, v2.z];
    const minX = Math.min(...xs) - chkDist, maxX = Math.max(...xs) + chkDist;
    const minZ = Math.min(...zs) - chkDist, maxZ = Math.max(...zs) + chkDist;

    const result = [];
    let total = Math.ceil((maxX - minX) / resolution) * Math.ceil((maxZ - minZ) / resolution);
    let count = 0;

    for (let x = minX; x <= maxX; x += resolution) {
        x = f32(x);
        for (let z = minZ; z <= maxZ; z += resolution) {
            z = f32(z);
            count++;
            if (count % Math.floor(total / 100) === 0) console.log("Sampling progress: " + Math.floor(count / total * 100) + "%");

            if (!triChkPointParaYImpl(v0, v1, v2, z, x, 0.0, chkDist, ny)) {
                continue;
            }

            const y = computeYFromPlane(nx, ny, nz, d, x, z);

            // --- Vertex-Y early out ---
            const minVertexY = Math.min(v0.y, v1.y, v2.y);
            if (y < minVertexY) continue;

            result.push({x: f32(x), z: f32(z), y});
        }
    }

    console.log("Sampling complete: 100%");
    /*console.log(result)
    
    function jsonToCsv(arr) {
        if (!arr.length) return "";

        const headers = Object.keys(arr[0]);
        const rows = arr.map(obj =>
            headers.map(h => JSON.stringify(obj[h] ?? "")).join(",")
        );

        return headers.join(",") + "\n" + rows.join("\n");
    }

    console.log(jsonToCsv(result));*/
    
    return result;
}

export function drawSampledTriangles(scene, allTriangleData, sampleStep = 0.1) {
    // First, count total number of points
    let totalPoints = 0;
    allTriangleData.forEach(tri => {
        totalPoints += sampledStandableFootprint(tri, sampleStep).length;
    });

    // Pre-allocate Float32Array
    const vertices = new Float32Array(totalPoints * 3);
    let offset = 0;

    // Fill vertices
    let count = 0
    allTriangleData.forEach(tri => {
        const points = sampledStandableFootprint(tri, sampleStep);
        points.forEach(p => {
            vertices[offset++] = Math.fround(p.x);
            vertices[offset++] = Math.fround(p.y);
            vertices[offset++] = Math.fround(p.z);
        });
        count += 1;
        console.log("completed "+count+"/"+allTriangleData.length)
    });

    // Build BufferGeometry
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(vertices, 3));

    // Single Points object
    const material = new THREE.PointsMaterial({ color: 0xff0000, size: 0.5 });
    const pts = new THREE.Points(geometry, material);

    scene.add(pts);
    
    loadedModels.push({ name: "Points", mesh: pts, edges: null });
    
    return pts;
}
