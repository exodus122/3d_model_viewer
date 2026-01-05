import * as THREE from 'three';
import { clearSelection } from './selection.js';
import { updateSamplePointsUIVisibility, drawSampledTriangles } from './sample_points.js';
import { addModelCheckbox, removeAllModelCheckboxes } from './render.js';

/*
This file contains untested/incomplete gap finders between polygons.

buildGeometry2 - this ony checks every edge of each polygon, then highlights all that do not have a "partner edge" in another triangle
buildGeometry3 - same as above but don't render line on polys with normal < 0
buildGeometry4 - seems like a subset of the above and tries to find actual misalignments rather than edges that don't match. not perfect tho...

*/

const wireframeCheckbox = document.getElementById('wireframe');

// Material used as base for clones per mesh
const material = new THREE.MeshStandardMaterial({color:0x3aa6ff,side:THREE.FrontSide,transparent:true,opacity:1.0,flatShading:true});
const material2 = new THREE.MeshStandardMaterial({color:0xf56342,side:THREE.FrontSide,transparent:true,opacity:1.0,flatShading:true});
const material3 = new THREE.MeshStandardMaterial({color:0xe1eb34,side:THREE.FrontSide,transparent:true,opacity:1.0,flatShading:true});

export function buildGeometry2(scene, verts, tris, allTriangleData, colCtx, name = "Main Model", clearFirst = true) {

    if ((!verts || !tris || verts.length === 0 || tris.length === 0) && clearFirst) { 
        alert('No valid vertices or triangles found'); 
        return; 
    }

    // Clear existing
    if (clearFirst) {
        loadedModels.forEach(m => {
            scene.remove(m.mesh);
            scene.remove(m.edges);
            if (m.edgesUnmatched) scene.remove(m.edgesUnmatched); // === NEW ===
        });
        loadedModels = [];
        
        loadedModelsNotSelectable.forEach(m => {
            scene.remove(m.mesh);
            scene.remove(m.edges);
            if (m.edgesUnmatched) scene.remove(m.edgesUnmatched); // === NEW ===
        });
        loadedModelsNotSelectable = [];

        removeAllModelCheckboxes();
        clearSelection(scene);
    }

    // vertex buffer
    const positions = new Float32Array(verts.length * 3);
    for (let i = 0; i < verts.length; i++) {
        positions[3 * i]     = verts[i][0];
        positions[3 * i + 1] = verts[i][1];
        positions[3 * i + 2] = verts[i][2];
    }

    // index buffer
    const indices = new (verts.length > 65535 ? Uint32Array : Uint16Array)(tris.length * 3);
    for (let i = 0; i < tris.length; i++) {
        indices[3 * i]     = tris[i][0];
        indices[3 * i + 1] = tris[i][1];
        indices[3 * i + 2] = tris[i][2];
    }

    // create mesh
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geom.setIndex(new THREE.BufferAttribute(indices, 1));
    
    const meshObj = new THREE.Mesh(geom, material.clone());
    meshObj.material.polygonOffset = true;
    meshObj.material.polygonOffsetFactor = 1;
    meshObj.material.polygonOffsetUnits = 1;
    meshObj.userData.triangles = allTriangleData;
    meshObj.userData.colCtx = colCtx;
    if (!clearFirst)
        meshObj.material.color.set(0x3aff78);
    scene.add(meshObj);

    // WIREFRAME (normal)
    const edgePositions = [];
    for (let i = 0; i < indices.length; i += 3) {
        const a = indices[i], b = indices[i+1], c = indices[i+2];
        const va = verts[a], vb = verts[b], vc = verts[c];
        edgePositions.push(
            va[0],va[1],va[2], vb[0],vb[1],vb[2],
            vb[0],vb[1],vb[2], vc[0],vc[1],vc[2],
            vc[0],vc[1],vc[2], va[0],va[1],va[2]
        );
    }
    const edgeGeom = new THREE.BufferGeometry();
    edgeGeom.setAttribute('position', new THREE.Float32BufferAttribute(edgePositions,3));
    const edgesObj = new THREE.LineSegments(
        edgeGeom,
        new THREE.LineBasicMaterial({ color: 0x3240a8, linewidth: 1, opacity: 0.8, transparent: true })
    );
    edgesObj.visible = wireframeCheckbox.checked;
    scene.add(edgesObj);

    // ============================================================
    // === NEW: FIND UNMATCHED TRIANGLE EDGES + RENDER IN RED ===
    // ============================================================

    const edgeMap = new Map(); // key = "minIndex-maxIndex", value = count

    // Build edge frequency map
    for (let i = 0; i < indices.length; i += 3) {
        const t0 = indices[i], t1 = indices[i+1], t2 = indices[i+2];
        const triEdges = [
            [t0, t1],
            [t1, t2],
            [t2, t0]
        ];

        for (let e of triEdges) {
            const a = Math.min(e[0], e[1]);
            const b = Math.max(e[0], e[1]);
            const key = a + "-" + b;
            edgeMap.set(key, (edgeMap.get(key) || 0) + 1);
        }
    }

    // Collect unmatched edges into geometry
    const unmatchedPos = [];

    for (let i = 0; i < indices.length; i += 3) {
        const t0 = indices[i], t1 = indices[i+1], t2 = indices[i+2];

        const triEdges = [
            [t0, t1],
            [t1, t2],
            [t2, t0]
        ];

        for (let e of triEdges) {
            const a = Math.min(e[0], e[1]);
            const b = Math.max(e[0], e[1]);
            const key = a + "-" + b;

            if (edgeMap.get(key) === 1) {
                // This edge has NO partner
                const va = verts[e[0]];
                const vb = verts[e[1]];
                unmatchedPos.push(
                    va[0],va[1],va[2],
                    vb[0],vb[1],vb[2]
                );
            }
        }
    }

    let unmatchedEdgesObj = null;

    if (unmatchedPos.length > 0) {
        const ug = new THREE.BufferGeometry();
        ug.setAttribute('position', new THREE.Float32BufferAttribute(unmatchedPos, 3));
        unmatchedEdgesObj = new THREE.LineSegments(
            ug,
            new THREE.LineBasicMaterial({
                color: 0xff0000, // 🔴 highlight color
                linewidth: 2,
                transparent: true,
                opacity: 1.0
            })
        );
        scene.add(unmatchedEdgesObj);
    }

    // ============================================================

    // Store
    loadedModels.push({
        name,
        mesh: meshObj,
        edges: edgesObj,
        edgesUnmatched: unmatchedEdgesObj // === NEW ===
    });

    addModelCheckbox(scene, name, meshObj, edgesObj, clearFirst, true);
    updateSamplePointsUIVisibility(game);
}

// highlights edges that don't have a partner edge in another triangle
export function buildGeometry3(scene, verts, tris, allTriangleData, colCtx, name = "Main Model", clearFirst = true) {

    if ((!verts || !tris || verts.length === 0 || tris.length === 0) && clearFirst) { 
        alert('No valid vertices or triangles found'); 
        return; 
    }

    // Clear previous models
    if (clearFirst) {
        loadedModels.forEach(m => {
            scene.remove(m.mesh);
            scene.remove(m.edges);
            if (m.edgesUnmatched) scene.remove(m.edgesUnmatched);
        });
        loadedModels = [];
        loadedModelsNotSelectable.forEach(m => {
            scene.remove(m.mesh);
            scene.remove(m.edges);
            if (m.edgesUnmatched) scene.remove(m.edgesUnmatched);
        });
        loadedModelsNotSelectable = [];
        removeAllModelCheckboxes();
        clearSelection(scene);
    }

    // Vertex buffer
    const positions = new Float32Array(verts.length * 3);
    for (let i = 0; i < verts.length; i++) {
        positions[3 * i]     = verts[i][0];
        positions[3 * i + 1] = verts[i][1];
        positions[3 * i + 2] = verts[i][2];
    }

    // Index buffer
    const indices = new (verts.length > 65535 ? Uint32Array : Uint16Array)(tris.length * 3);
    for (let i = 0; i < tris.length; i++) {
        indices[3 * i]     = tris[i][0];
        indices[3 * i + 1] = tris[i][1];
        indices[3 * i + 2] = tris[i][2];
    }

    // Create mesh
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geom.setIndex(new THREE.BufferAttribute(indices, 1));
    const meshObj = new THREE.Mesh(geom, material.clone());
    meshObj.material.polygonOffset = true;
    meshObj.material.polygonOffsetFactor = 1;
    meshObj.material.polygonOffsetUnits = 1;
    meshObj.userData.triangles = allTriangleData;
    meshObj.userData.colCtx = colCtx;
    if (!clearFirst) meshObj.material.color.set(0x3aff78);
    scene.add(meshObj);

    // Regular wireframe
    const edgePositions = [];
    for (let i = 0; i < indices.length; i += 3) {
        const a = indices[i], b = indices[i+1], c = indices[i+2];
        const va = verts[a], vb = verts[b], vc = verts[c];
        edgePositions.push(
            va[0],va[1],va[2], vb[0],vb[1],vb[2],
            vb[0],vb[1],vb[2], vc[0],vc[1],vc[2],
            vc[0],vc[1],vc[2], va[0],va[1],va[2]
        );
    }
    const edgeGeom = new THREE.BufferGeometry();
    edgeGeom.setAttribute('position', new THREE.Float32BufferAttribute(edgePositions,3));
    const edgesObj = new THREE.LineSegments(
        edgeGeom,
        new THREE.LineBasicMaterial({ color: 0x3240a8, linewidth: 1, opacity: 0.8, transparent: true })
    );
    edgesObj.visible = wireframeCheckbox.checked;
    scene.add(edgesObj);

    // === NEW: HIGHLIGHT UNMATCHED EDGES (DISPLAY ONLY NY>0, BUT EDGE MAP INCLUDES ALL) ===
    const edgeMap = new Map(); // key = "minIndex-maxIndex", value = count

    // Step 1: Build edge map from all triangles
    for (let i = 0; i < tris.length; i++) {
        const triIndices = tris[i];
        const edges = [
            [triIndices[0], triIndices[1]],
            [triIndices[1], triIndices[2]],
            [triIndices[2], triIndices[0]]
        ];

        for (let e of edges) {
            const a = Math.min(e[0], e[1]);
            const b = Math.max(e[0], e[1]);
            const key = a + "-" + b;
            edgeMap.set(key, (edgeMap.get(key) || 0) + 1);
        }
    }

    // Step 2: Collect unmatched edges, but only for triangles with NY > 0
    const unmatchedPos = [];
    for (let i = 0; i < allTriangleData.length; i++) {
        const tri = allTriangleData[i];
        const ny = tri.normals[1];
        if (ny <= 0) continue; // only display for NY > 0

        const triIndices = tris[i];
        const edges = [
            [triIndices[0], triIndices[1]],
            [triIndices[1], triIndices[2]],
            [triIndices[2], triIndices[0]]
        ];

        for (let e of edges) {
            const a = Math.min(e[0], e[1]);
            const b = Math.max(e[0], e[1]);
            const key = a + "-" + b;

            if (edgeMap.get(key) === 1) { // unmatched edge
                const va = verts[e[0]];
                const vb = verts[e[1]];
                unmatchedPos.push(
                    va[0], va[1], va[2],
                    vb[0], vb[1], vb[2]
                );
            }
        }
    }

    // Step 3: Create LineSegments for unmatched edges
    let unmatchedEdgesObj = null;
    if (unmatchedPos.length > 0) {
        const ug = new THREE.BufferGeometry();
        ug.setAttribute('position', new THREE.Float32BufferAttribute(unmatchedPos, 3));
        unmatchedEdgesObj = new THREE.LineSegments(
            ug,
            new THREE.LineBasicMaterial({
                color: 0xff0000,
                linewidth: 2,
                transparent: true,
                opacity: 1.0
            })
        );
        scene.add(unmatchedEdgesObj);
    }

    // Store
    loadedModels.push({
        name,
        mesh: meshObj,
        edges: edgesObj,
        edgesUnmatched: unmatchedEdgesObj
    });

    addModelCheckbox(scene, name, meshObj, edgesObj, clearFirst, true);
    updateSamplePointsUIVisibility(game);
}

// trying to display gaps between polygons. this one seems better than buildGeometry3 but not sure
export function buildGeometry4(scene, verts, tris, allTriangleData, colCtx, name = "Main Model", clearFirst = true) {
    if ((!verts || !tris || verts.length === 0 || tris.length === 0) && clearFirst) { 
        alert('No valid vertices or triangles found'); 
        return; 
    }

    // --- Clear previous models ---
    if (clearFirst) {
        loadedModels.forEach(m => {
            scene.remove(m.mesh);
            scene.remove(m.edges);
            if (m.edgesUnmatched) scene.remove(m.edgesUnmatched);
        });
        loadedModels = [];
        loadedModelsNotSelectable.forEach(m => {
            scene.remove(m.mesh);
            scene.remove(m.edges);
            if (m.edgesUnmatched) scene.remove(m.edgesUnmatched);
        });
        loadedModelsNotSelectable = [];
        removeAllModelCheckboxes();
        clearSelection(scene);
    }

    // --- Vertex buffer ---
    const positions = new Float32Array(verts.length * 3);
    for (let i = 0; i < verts.length; i++) {
        positions[3*i]   = verts[i][0];
        positions[3*i+1] = verts[i][1];
        positions[3*i+2] = verts[i][2];
    }

    // --- Index buffer ---
    const indices = new (verts.length > 65535 ? Uint32Array : Uint16Array)(tris.length*3);
    for (let i = 0; i < tris.length; i++) {
        indices[3*i]   = tris[i][0];
        indices[3*i+1] = tris[i][1];
        indices[3*i+2] = tris[i][2];
    }

    // --- Mesh ---
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geom.setIndex(new THREE.BufferAttribute(indices, 1));
    const meshObj = new THREE.Mesh(geom, material.clone());
    meshObj.material.polygonOffset = true;
    meshObj.material.polygonOffsetFactor = 1;
    meshObj.material.polygonOffsetUnits = 1;
    meshObj.userData.triangles = allTriangleData;
    meshObj.userData.colCtx = colCtx;
    if(!clearFirst) meshObj.material.color.set(0x3aff78);
    scene.add(meshObj);

    // --- Wireframe edges ---
    const edgePositions = [];
    for (let i = 0; i < indices.length; i += 3) {
        const a = indices[i], b = indices[i+1], c = indices[i+2];
        const va = verts[a], vb = verts[b], vc = verts[c];
        edgePositions.push(
            va[0], va[1], va[2], vb[0], vb[1], vb[2],
            vb[0], vb[1], vb[2], vc[0], vc[1], vc[2],
            vc[0], vc[1], vc[2], va[0], va[1], va[2]
        );
    }
    const edgeGeom = new THREE.BufferGeometry();
    edgeGeom.setAttribute('position', new THREE.Float32BufferAttribute(edgePositions, 3));
    const edgesObj = new THREE.LineSegments(
        edgeGeom,
        new THREE.LineBasicMaterial({ color: 0x3240a8, linewidth: 1, opacity: 0.8, transparent: true })
    );
    edgesObj.visible = wireframeCheckbox.checked;
    scene.add(edgesObj);

    // --- Unmatched / gap edges ---
    const GAP_EPSILON = 1.0; // integer-scale meshes
    const unmatchedPos = [];

    // Build edge map to detect exact shared edges
    const edgeMap = new Map();
    for (let i = 0; i < tris.length; i++) {
        const triIndices = tris[i];
        const edges = [
            [triIndices[0], triIndices[1]],
            [triIndices[1], triIndices[2]],
            [triIndices[2], triIndices[0]]
        ];
        for (let e of edges) {
            const a = Math.min(e[0], e[1]);
            const b = Math.max(e[0], e[1]);
            edgeMap.set(a + "-" + b, (edgeMap.get(a + "-" + b) || 0) + 1);
        }
    }

    // 2D point-in-triangle test
    function pointInTriangle2D(p, tri) {
        const [A,B,C] = tri;
        const v0=[C[0]-A[0],C[1]-A[1]];
        const v1=[B[0]-A[0],B[1]-A[1]];
        const v2=[p[0]-A[0],p[1]-A[1]];
        const dot00=v0[0]*v0[0]+v0[1]*v0[1];
        const dot01=v0[0]*v1[0]+v0[1]*v1[1];
        const dot02=v0[0]*v2[0]+v0[1]*v2[1];
        const dot11=v1[0]*v1[0]+v1[1]*v1[1];
        const dot12=v1[0]*v2[0]+v1[1]*v2[1];
        const invDenom=1/(dot00*dot11-dot01*dot01);
        const u=(dot11*dot02-dot01*dot12)*invDenom;
        const v=(dot00*dot12-dot01*dot02)*invDenom;
        return (u>=0)&&(v>=0)&&(u+v<=1);
    }

    // Check if edge is exposed using sampled points along edge
    function edgeIsExposed(v0,v1,allTriangles) {
        const samples = 5; // sample 5 points along the edge
        for(let i=0;i<=samples;i++){
            const t=i/samples;
            const px=v0[0]*(1-t)+v1[0]*t;
            const py=v0[1]*(1-t)+v1[1]*t; // keep Y for potential future filtering
            const pz=v0[2]*(1-t)+v1[2]*t;
            const pointXZ=[px,pz];
            let covered=false;
            for(let tri of allTriangles){
                const triXZ=tri.vtxs.map(v=>[v.x ?? v[0], v.z ?? v[2]]);
                if(pointInTriangle2D(pointXZ, triXZ)) {
                    covered=true;
                    break;
                }
            }
            if(!covered) return true; // at least one point not covered → gap
        }
        return false; // all points covered → no gap
    }

    // Loop through triangles with normalY>0 to detect gaps
    for(let i=0;i<allTriangleData.length;i++){
        const tri = allTriangleData[i];
        const ny = tri.normals[1];
        if(ny<=0) continue;

        const triIndices = tris[i];
        const edges = [
            [triIndices[0], triIndices[1]],
            [triIndices[1], triIndices[2]],
            [triIndices[2], triIndices[0]]
        ];

        for(let e of edges){
            const a = Math.min(e[0], e[1]);
            const b = Math.max(e[0], e[1]);
            const key = a+"-"+b;
            if(edgeMap.get(key)===1){ // only consider edges not shared exactly
                const va = verts[e[0]], vb = verts[e[1]];
                if(edgeIsExposed(va,vb,allTriangleData)){
                    unmatchedPos.push(
                        va[0],va[1],va[2],
                        vb[0],vb[1],vb[2]
                    );
                }
            }
        }
    }

    let unmatchedEdgesObj=null;
    if(unmatchedPos.length>0){
        const ug=new THREE.BufferGeometry();
        ug.setAttribute('position', new THREE.Float32BufferAttribute(unmatchedPos,3));
        unmatchedEdgesObj = new THREE.LineSegments(
            ug,
            new THREE.LineBasicMaterial({
                color: 0xff0000,
                linewidth: 2,
                transparent: true,
                opacity: 1.0,
                depthTest: true   // <-- ignores mesh depth, always draws on top
            })
        );
        unmatchedEdgesObj.renderOrder = 999; // ensures drawn after other objects
        scene.add(unmatchedEdgesObj);
    }

    loadedModels.push({name,mesh:meshObj,edges:edgesObj});
    loadedModels.push({name:"Gaps?",mesh:null,edges:unmatchedEdgesObj});
    addModelCheckbox(scene,name,meshObj,edgesObj,clearFirst,true);
    addModelCheckbox(scene,"Gaps?",null,unmatchedEdgesObj,clearFirst,false, "#ff0000");
    updateSamplePointsUIVisibility(game);
}
