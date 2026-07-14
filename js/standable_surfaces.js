import * as THREE from 'three';
import { mergeVertices } from 'three/addons/utils/BufferGeometryUtils.js';

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
function buildStandableSurfaceTriangles(tri, pushGreen, pushRed, pushBlue) {
    const vtxs = tri.vtxs;
    const normals = tri.normals;
    const D = f32(tri.d);

    const Nx = f32(normals[0] * COLPOLY_NORMAL_FRAC);
    const Ny = f32(normals[1] * COLPOLY_NORMAL_FRAC);
    const Nz = f32(normals[2] * COLPOLY_NORMAL_FRAC);

    if (Ny < f32(0.0) || isZero(Ny)) return;

    const rawV0 = { x: f32(vtxs[0].x), y: f32(vtxs[0].y), z: f32(vtxs[0].z) };
    const rawV1 = { x: f32(vtxs[1].x), y: f32(vtxs[1].y), z: f32(vtxs[1].z) };
    const rawV2 = { x: f32(vtxs[2].x), y: f32(vtxs[2].y), z: f32(vtxs[2].z) };

    // Clip threshold is based on the raw stored vertex heights (the actual
    // floor reference), same as the original function.
    const minY = Math.min(rawV0.y, rawV1.y, rawV2.y);
    const maxY = Math.max(rawV0.y, rawV1.y, rawV2.y);

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
        const above = clipPolygonByMinY([a, b, c], minY);
        for (let i = 1; i < above.length - 1; i++) {
            pushRed(above[0], above[i], above[i + 1]);
        }
        const below = clipPolygonBelowMinY([a, b, c], minY);
        for (let i = 1; i < below.length - 1; i++) {
            pushBlue(below[0], below[i], below[i + 1]);
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
            if (prev) pushGreen(center, prev, p);
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

export function renderStandableSurfaceXZ(allTriangleData) {
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

    allTriangleData.forEach(tri => buildStandableSurfaceTriangles(tri, green.push, red.push, blue.push));

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
    const group = new THREE.Group();
    for (const bucket of [
        { data: green, color: 0x00cc44, edgeColor: 0x39ff64 }, // bright green edges: the thin vertex-bulge slivers get lost in black outlines otherwise
        { data: red, color: 0xff0000, edgeColor: 0x000000 },
        { data: blue, color: 0x0000ff, edgeColor: 0x000000 },
    ]) {
        const built = buildMesh(bucket.data, bucket.color, bucket.edgeColor);
        if (built) {
            group.add(built.mesh);
            group.add(built.edges);
        }
    }

    return group;
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
