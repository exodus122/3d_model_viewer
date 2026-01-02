import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { PointerLockControls } from 'three/addons/controls/PointerLockControls.js';
import { LineMaterial } from 'three/addons/lines/LineMaterial.js';
import { LineGeometry } from 'three/addons/lines/LineGeometry.js';
import { LineSegments2 } from 'three/addons/lines/LineSegments2.js';

function createGroundClipMarker(verts) {

    // ---- Mesh ----
    const geom = new THREE.BufferGeometry();
    geom.setAttribute(
        "position",
        new THREE.Float32BufferAttribute([
            verts[0].x, verts[0].y, verts[0].z,
            verts[1].x, verts[1].y, verts[1].z,
            verts[2].x, verts[2].y, verts[2].z
        ], 3)
    );
    geom.setIndex([0,1,2]);

    const mat = new THREE.MeshBasicMaterial({
        color: 0x00ffff,
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0.9,
        polygonOffset: true,
        polygonOffsetFactor: -1,
        polygonOffsetUnits: -1
    });

    const mesh = new THREE.Mesh(geom, mat);
    mesh.renderOrder = 1;

    // ---- Edges ----
    const edgeGeom = new THREE.BufferGeometry();
    edgeGeom.setAttribute(
        "position",
        new THREE.Float32BufferAttribute([
            verts[0].x, verts[0].y, verts[0].z,
            verts[1].x, verts[1].y, verts[1].z,
            verts[1].x, verts[1].y, verts[1].z,
            verts[2].x, verts[2].y, verts[2].z,
            verts[2].x, verts[2].y, verts[2].z,
            verts[0].x, verts[0].y, verts[0].z
        ], 3)
    );

    const edgeMat = new THREE.LineBasicMaterial({
        color: 0x000000,
        linewidth: 1.5
    });

    const edges = new THREE.LineSegments(edgeGeom, edgeMat);
    edges.renderOrder = 999;

    return [mesh, edges];
}

////////////////////////////////////////
// System: Flat Ground Preview (Main Model only)
////////////////////////////////////////

export function scanAndBuildFlatGroundMarkers() {

    const mainModel = loadedModels.find(m => m.name === "Main Model");
    if (!mainModel || !mainModel.mesh) return null;

    const mesh = mainModel.mesh;
    const triData = mesh.userData.triangles;
    if (!triData || triData.length === 0) return null;

    const geom = mesh.geometry;
    const pos = geom.attributes.position;
    const index = geom.index;

    // -------------------------
    // Collect merged geometry
    // -------------------------
    const mergedVerts = [];
    const mergedEdges = [];

    for (let i = 0; i < triData.length; i++) {

        const ia = index.getX(i*3);
        const ib = index.getX(i*3 + 1);
        const ic = index.getX(i*3 + 2);

        const va = new THREE.Vector3().fromBufferAttribute(pos, ia);
        const vb = new THREE.Vector3().fromBufferAttribute(pos, ib);
        const vc = new THREE.Vector3().fromBufferAttribute(pos, ic);

        // flat y check
        if (va.y !== vb.y || vb.y !== vc.y) continue;

        const y = Math.round(va.y);
        if (!flat_ground_clip_y_table.has(y)) continue;

        // upward facing
        const edge1 = new THREE.Vector3().subVectors(vb, va);
        const edge2 = new THREE.Vector3().subVectors(vc, va);
        const normal = new THREE.Vector3().crossVectors(edge1, edge2).normalize();
        if (normal.y <= 0) continue;

        // -----------------------
        // Add triangle to merged mesh
        // -----------------------
        mergedVerts.push(
            va.x, va.y, va.z,
            vb.x, vb.y, vb.z,
            vc.x, vc.y, vc.z
        );

        // -----------------------
        // Add edges for merged edges
        // -----------------------
        mergedEdges.push(
            va.x, va.y, va.z, vb.x, vb.y, vb.z,
            vb.x, vb.y, vb.z, vc.x, vc.y, vc.z,
            vc.x, vc.y, vc.z, va.x, va.y, va.z
        );
    }

    // If no triangles matched
    if (mergedVerts.length === 0) return null;

    // -------------------------
    // Build merged mesh
    // -------------------------
    const meshGeom = new THREE.BufferGeometry();
    meshGeom.setAttribute(
        "position",
        new THREE.Float32BufferAttribute(mergedVerts, 3)
    );
    meshGeom.setIndex([...Array(mergedVerts.length / 3).keys()]);

    const meshMat = new THREE.MeshBasicMaterial({
        color: 0x00ffff,
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0.9,
        polygonOffset: true,
        polygonOffsetFactor: -1,
        polygonOffsetUnits: -1
    });

    const mergedMesh = new THREE.Mesh(meshGeom, meshMat);
    mergedMesh.renderOrder = 1;

    // -------------------------
    // Build merged edges
    // -------------------------
    const edgeGeom = new THREE.BufferGeometry();
    edgeGeom.setAttribute(
        "position",
        new THREE.Float32BufferAttribute(mergedEdges, 3)
    );

    const edgeMat = new THREE.LineBasicMaterial({
        color: 0x000000,
        linewidth: 1.5
    });

    const mergedEdgesObj = new THREE.LineSegments(edgeGeom, edgeMat);
    mergedEdgesObj.renderOrder = 999;

    // -------------------------
    // Build final group with exactly ONE mesh + ONE edges
    // -------------------------
    const master = new THREE.Group();
    master.add(mergedMesh);
    master.add(mergedEdgesObj);

    return master;
}

////////////////////////////////////////
// System: Special Normal Preview
// (uses Main Model + mesh.userData.triangles)
////////////////////////////////////////

export function scanAndBuildSpecialNormalMarkers() {
    const TARGET_NORMAL = { x: 0, y: 32766, z: 0 };

    const mainModel = loadedModels.find(m => m.name === "Main Model");
    if (!mainModel || !mainModel.mesh) return null;

    const mesh = mainModel.mesh;
    const triData = mesh.userData.triangles;
    if (!triData || triData.length === 0) return null;

    const geom = mesh.geometry;
    const pos = geom.attributes.position;
    const index = geom.index;

    // -------------------------
    // Collect merged geometry
    // -------------------------
    const mergedVerts = [];
    const mergedEdges = [];

    for (let i = 0; i < triData.length; i++) {

        const ia = index.getX(i*3);
        const ib = index.getX(i*3 + 1);
        const ic = index.getX(i*3 + 2);

        const va = new THREE.Vector3().fromBufferAttribute(pos, ia);
        const vb = new THREE.Vector3().fromBufferAttribute(pos, ib);
        const vc = new THREE.Vector3().fromBufferAttribute(pos, ic);

        const tri = triData[i];
        const nx = tri.normals[0];
        const ny = tri.normals[1];
        const nz = tri.normals[2];

        // Match EXACT normal
        if (nx !== TARGET_NORMAL.x) continue;
        if (ny !== TARGET_NORMAL.y) continue;
        if (nz !== TARGET_NORMAL.z) continue;

        // upward facing
        const edge1 = new THREE.Vector3().subVectors(vb, va);
        const edge2 = new THREE.Vector3().subVectors(vc, va);
        const normal = new THREE.Vector3().crossVectors(edge1, edge2).normalize();
        if (normal.y <= 0) continue;

        // -----------------------
        // Add triangle to merged mesh
        // -----------------------
        mergedVerts.push(
            va.x, va.y, va.z,
            vb.x, vb.y, vb.z,
            vc.x, vc.y, vc.z
        );

        // -----------------------
        // Add edges for merged edges
        // -----------------------
        mergedEdges.push(
            va.x, va.y, va.z, vb.x, vb.y, vb.z,
            vb.x, vb.y, vb.z, vc.x, vc.y, vc.z,
            vc.x, vc.y, vc.z, va.x, va.y, va.z
        );
    }

    // If no triangles matched
    if (mergedVerts.length === 0) return null;

    // -------------------------
    // Build merged mesh
    // -------------------------
    const meshGeom = new THREE.BufferGeometry();
    meshGeom.setAttribute(
        "position",
        new THREE.Float32BufferAttribute(mergedVerts, 3)
    );
    meshGeom.setIndex([...Array(mergedVerts.length / 3).keys()]);

    const meshMat = new THREE.MeshBasicMaterial({
        color: 0x00ffff,
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0.9,
        polygonOffset: true,
        polygonOffsetFactor: -1,
        polygonOffsetUnits: -1
    });

    const mergedMesh = new THREE.Mesh(meshGeom, meshMat);
    mergedMesh.renderOrder = 1;

    // -------------------------
    // Build merged edges
    // -------------------------
    const edgeGeom = new THREE.BufferGeometry();
    edgeGeom.setAttribute(
        "position",
        new THREE.Float32BufferAttribute(mergedEdges, 3)
    );

    const edgeMat = new THREE.LineBasicMaterial({
        color: 0x000000,
        linewidth: 1.5
    });

    const mergedEdgesObj = new THREE.LineSegments(edgeGeom, edgeMat);
    mergedEdgesObj.renderOrder = 999;

    // -------------------------
    // Build final group with exactly ONE mesh + ONE edges
    // -------------------------
    const master = new THREE.Group();
    master.add(mergedMesh);
    master.add(mergedEdgesObj);

    return master;
}
