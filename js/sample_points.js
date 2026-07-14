import * as THREE from 'three';

////////////////////////////////////////
// System: Sample Standable Polygon Surface
////////////////////////////////////////

const samplePointsContainer = document.getElementById("samplePointsContainer"); 
const samplePointsCheckbox  = document.getElementById("samplePointsCheckbox");
const samplePointsResolution  = document.getElementById("samplePointsResolution");

// Target number of points per triangle (adjust as needed)
const TARGET_POINTS_PER_TRIANGLE = 500;

// Global flag to check if sampling is in progress
let isSamplingInProgress = false;
let currentPointsObject = null;

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

// Process a single triangle and return its points
function processSingleTriangle(tri, resolution) {
    const COLPOLY_NORMAL_FRAC = 1.0 / 32767.0;

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
    
    // Calculate area-based step size
    const adaptiveStep = calculateAdaptiveResolution(tri, resolution);
    
    // For very small triangles, just sample the center
    if (adaptiveStep > (maxX - minX) * 2 || adaptiveStep > (maxZ - minZ) * 2) {
        const centerX = (v0.x + v1.x + v2.x) / 3;
        const centerZ = (v0.z + v1.z + v2.z) / 3;
        const y = computeYFromPlane(nx, ny, nz, d, centerX, centerZ);
        result.push({
            x: f32(centerX),
            z: f32(centerZ),
            y: y
        });
        return result;
    }

    // Use simple for loops for better performance
    for (let x = minX; x <= maxX; x += adaptiveStep) {
        const fx = f32(x);
        for (let z = minZ; z <= maxZ; z += adaptiveStep) {
            const fz = f32(z);

            if (!triChkPointParaYImpl(v0, v1, v2, fz, fx, 0.0, chkDist, ny)) {
                continue;
            }

            const y = computeYFromPlane(nx, ny, nz, d, fx, fz);

            result.push({
                x: fx,
                z: fz,
                y: y
            });
        }
    }
    
    return result;
}

// ------------------------
// Mesh Generation
// ------------------------

// Same containment/height logic as processSingleTriangle, but instead of
// loose points it tracks them on an indexed grid and stitches adjacent grid
// cells into triangle faces. This preserves the "quirky" OoT standable
// boundary shape faithfully (only genuinely-adjacent sample points are
// connected), unlike a naive Delaunay triangulation over the whole point
// cloud, which would incorrectly bridge across gaps/holes.
export function processSingleTriangleForMesh(tri, resolution) {
    const COLPOLY_NORMAL_FRAC = 1.0 / 32767.0;

    const v0 = tri.vtxs[0], v1 = tri.vtxs[1], v2 = tri.vtxs[2];
    const nx = tri.normals[0] * COLPOLY_NORMAL_FRAC;
    const ny = tri.normals[1] * COLPOLY_NORMAL_FRAC;
    const nz = tri.normals[2] * COLPOLY_NORMAL_FRAC;
    const d = tri.d;
    const chkDist = 1.0;

    const xs = [v0.x, v1.x, v2.x], zs = [v0.z, v1.z, v2.z];
    const minX = Math.min(...xs) - chkDist, maxX = Math.max(...xs) + chkDist;
    const minZ = Math.min(...zs) - chkDist, maxZ = Math.max(...zs) + chkDist;

    const adaptiveStep = calculateAdaptiveResolution(tri, resolution);
    const faces = [];

    // Tiny triangle: no grid to stitch, so just emit the triangle itself.
    if (adaptiveStep > (maxX - minX) * 2 || adaptiveStep > (maxZ - minZ) * 2) {
        faces.push([
            { x: v0.x, y: v0.y, z: v0.z },
            { x: v1.x, y: v1.y, z: v1.z },
            { x: v2.x, y: v2.y, z: v2.z }
        ]);
        return faces;
    }

    // Build the accepted-point grid, keyed by integer grid indices "ix,iz".
    const grid = new Map();

    let ix = 0;
    for (let x = minX; x <= maxX; x += adaptiveStep, ix++) {
        const fx = f32(x);
        let iz = 0;
        for (let z = minZ; z <= maxZ; z += adaptiveStep, iz++) {
            const fz = f32(z);

            if (!triChkPointParaYImpl(v0, v1, v2, fz, fx, 0.0, chkDist, ny)) {
                continue;
            }

            const y = computeYFromPlane(nx, ny, nz, d, fx, fz);

            grid.set(ix + "," + iz, { x: fx, y, z: fz });
        }
    }

    // Stitch adjacent grid cells: 4 corners present -> two triangles (a quad),
    // exactly 3 present -> one triangle so boundary edges aren't stair-stepped.
    const cols = Math.ceil((maxX - minX) / adaptiveStep) + 2;
    const rows = Math.ceil((maxZ - minZ) / adaptiveStep) + 2;

    for (let cx = 0; cx < cols - 1; cx++) {
        for (let cz = 0; cz < rows - 1; cz++) {
            const p00 = grid.get(cx + "," + cz);
            const p10 = grid.get((cx + 1) + "," + cz);
            const p01 = grid.get(cx + "," + (cz + 1));
            const p11 = grid.get((cx + 1) + "," + (cz + 1));

            const corners = [p00, p10, p11, p01].filter(Boolean);

            if (corners.length === 4) {
                faces.push([p00, p10, p11]);
                faces.push([p00, p11, p01]);
            } else if (corners.length === 3) {
                faces.push(corners);
            }
        }
    }

    return faces;
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
export function drawSampledTriangles(scene, allTriangleData, sampleStep = 0.1) {
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
        // Filter out invalid triangles
        const validTriangles = allTriangleData.filter(tri => 
            tri && tri.vtxs && tri.vtxs.length === 3 &&
            tri.vtxs[0] && tri.vtxs[1] && tri.vtxs[2] &&
            tri.normals && tri.normals.length === 3
        );
        
        if (validTriangles.length === 0) {
            console.warn("No valid triangles to sample");
            isSamplingInProgress = false;
            return null;
        }
        
        console.log(`Processing ${validTriangles.length} triangle(s)...`);
        
        // Process all triangles
        const allPoints = [];
        let totalPoints = 0;
        
        for (let i = 0; i < validTriangles.length; i++) {
            const tri = validTriangles[i];
            const points = processSingleTriangle(tri, sampleStep);
            allPoints.push(...points);
            totalPoints += points.length;
            
            if (validTriangles.length > 1 && i % 10 === 0) {
                console.log(`Processed ${i + 1}/${validTriangles.length} triangles, total points: ${totalPoints}`);
            }
        }
        
        console.log(`Total points generated: ${totalPoints} from ${validTriangles.length} triangle(s)`);

        // If no points were generated, return null
        if (totalPoints === 0) {
            console.warn("No points were generated. The triangle may not be standable or the resolution may be too high.");
            isSamplingInProgress = false;
            return null;
        }

        // If we have too many points, warn and maybe limit
        if (totalPoints > 5000000) {
            console.warn(`Warning: ${totalPoints} points is a very large number. Consider increasing the resolution.`);
        }

        // Build BufferGeometry
        const vertices = new Float32Array(totalPoints * 3);
        let offset = 0;
        
        for (let i = 0; i < allPoints.length; i++) {
            const p = allPoints[i];
            vertices[offset++] = Math.fround(p.x);
            vertices[offset++] = Math.fround(p.y);
            vertices[offset++] = Math.fround(p.z);
        }

        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(vertices, 3));

        // Calculate point size based on total points to prevent overdraw
        let pointSize = 0.5;
        if (totalPoints > 100000) pointSize = 0.3;
        if (totalPoints > 500000) pointSize = 0.2;
        if (totalPoints > 1000000) pointSize = 0.15;
        if (totalPoints > 5000000) pointSize = 0.1;
        
        // Create Points object
        const material = new THREE.PointsMaterial({ 
            color: 0xff0000, 
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
        pts.name = "SampledPoints";
        pts.renderOrder = 1001; // draw in front of waterboxes and other meshes

        scene.add(pts);
        currentPointsObject = pts;
        
        // Also add to loadedModels for proper cleanup
        loadedModels.push({ name: "Points", mesh: pts, edges: null });
        
        isSamplingInProgress = false;
        return pts;
        
    } catch (error) {
        console.error("Error during sampling:", error);
        isSamplingInProgress = false;
        return null;
    }
}

// Build a solid mesh of the whole standable surface, by stitching each
// triangle's accepted sample grid into faces (see processSingleTriangleForMesh).
export function drawSampledSurfaceMesh(scene, allTriangleData, sampleStep = 0.1) {
    if (isSamplingInProgress) {
        console.warn("Sampling already in progress, please wait...");
        return null;
    }

    // Same slider inversion as drawSampledTriangles.
    if (sampleStep >= SAMPLE_STEP_SLIDER_MIN && sampleStep <= SAMPLE_STEP_SLIDER_MAX) {
        sampleStep = (SAMPLE_STEP_SLIDER_MIN + SAMPLE_STEP_SLIDER_MAX) - sampleStep;
    }

    removeExistingSurfaceMesh(scene);

    isSamplingInProgress = true;

    try {
        const validTriangles = allTriangleData.filter(tri =>
            tri && tri.vtxs && tri.vtxs.length === 3 &&
            tri.vtxs[0] && tri.vtxs[1] && tri.vtxs[2] &&
            tri.normals && tri.normals.length === 3
        );

        if (validTriangles.length === 0) {
            console.warn("No valid triangles to sample");
            isSamplingInProgress = false;
            return null;
        }

        console.log(`Building surface mesh from ${validTriangles.length} triangle(s)...`);

        const positions = [];

        for (let i = 0; i < validTriangles.length; i++) {
            const faces = processSingleTriangleForMesh(validTriangles[i], sampleStep);
            for (const face of faces) {
                for (const p of face) {
                    positions.push(p.x, p.y, p.z);
                }
            }
        }

        if (positions.length === 0) {
            console.warn("No standable surface mesh generated. The triangles may not be standable or the resolution may be too high.");
            isSamplingInProgress = false;
            return null;
        }

        console.log(`Surface mesh: ${positions.length / 9} faces generated.`);

        const geometry = new THREE.BufferGeometry();
        geometry.setAttribute('position', new THREE.BufferAttribute(new Float32Array(positions), 3));
        geometry.computeVertexNormals();

        const material = new THREE.MeshBasicMaterial({
            color: 0x00ff88,
            transparent: true,
            opacity: 0.55,
            side: THREE.DoubleSide,
            depthWrite: false,
            polygonOffset: true,
            polygonOffsetFactor: -4,
            polygonOffsetUnits: -4
        });

        const mesh = new THREE.Mesh(geometry, material);
        mesh.name = "SampledSurfaceMesh";
        mesh.renderOrder = 1001;

        scene.add(mesh);

        loadedModels.push({ name: "SurfaceMesh", mesh: mesh, edges: null });

        isSamplingInProgress = false;
        return mesh;

    } catch (error) {
        console.error("Error during surface mesh generation:", error);
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
}

function removeExistingSurfaceMesh(scene) {
    removeExistingModel(scene, "SurfaceMesh");
}

// Export for external use
export function removeAllSampledPoints(scene) {
    removeExistingPoints(scene);
}

export function removeAllSampledSurfaceMesh(scene) {
    removeExistingSurfaceMesh(scene);
}

// Clean up function for when the scene changes
export function cleanupSampledPoints() {
    if (currentPointsObject) {
        // The scene will handle removal when the model is removed
        currentPointsObject = null;
    }
}