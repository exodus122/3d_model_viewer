import * as THREE from 'three';
import { clearSelection, updateSelectionUI } from './selection.js';
import { updateSamplePointsUIVisibility } from './sample_points.js';

////////////////////////////////////////
// Model checkboxes
////////////////////////////////////////

export function addModelCheckbox(scene, name, meshObj, edgesObj, clearFirst, checked, color = null, deleteButton = false) {
    const section = document.querySelector('.controls');

    // Container
    const container = document.createElement('div');
    container.style.display = 'flex';
    container.style.alignItems = 'center';
    container.style.marginBottom = '4px';
    container.style.gap = '8px'; // space between checkbox+label and color picker
    container.dataset.modelName = name;

    // Visibility checkbox + label
    const label = document.createElement('label');
    label.style.display = 'flex';
    label.style.alignItems = 'center';
    const chk = document.createElement('input');
    chk.type = 'checkbox';
    
    const savedVisible = modelState[name]?.visible;
    const isChecked = savedVisible !== undefined ? savedVisible : checked;

    chk.checked = isChecked;
    if (meshObj) meshObj.visible = isChecked;
    if (edgesObj) edgesObj.visible = isChecked;
    
    chk.addEventListener('change', () => {
        if (meshObj) meshObj.visible = chk.checked;

        if (edgesObj && !meshObj)
            edgesObj.visible = chk.checked;
        else if (edgesObj)
            edgesObj.visible = chk.checked && wireframeCheckbox.checked;

        // Ensure entry exists
        if (!modelState[name]) modelState[name] = {};

        // Save visibility
        modelState[name].visible = chk.checked;

        clearSelection(scene);
    });
    label.appendChild(chk);
    const labelText = document.createTextNode(` Show ${name}`);
    label.appendChild(labelText);
    
    // ----- DELETE BUTTON -----
    const del = document.createElement('button');
    del.textContent = "×";
    del.style.marginLeft = "4px";
    del.style.cursor = "pointer";
    del.style.padding = "0 4px";
    del.style.border = "1px solid #888";
    del.style.borderRadius = "3px";
    del.style.background = "#333";
    del.style.color = "#f55";
    del.title = "Remove this model";
    del.classList.add("delete-btn");
    
    del.addEventListener('click', () => {
        // Remove from scene
        if (meshObj) scene.remove(meshObj);
        if (edgesObj) scene.remove(edgesObj);

        // Dispose
        if (meshObj?.geometry) meshObj.geometry.dispose();
        if (meshObj?.material) meshObj.material.dispose();
        if (edgesObj?.geometry) edgesObj.geometry.dispose();
        if (edgesObj?.material) edgesObj.material.dispose();

        // Remove from loadedModels
        const idx = loadedModels.findIndex(m => m.name === name);
        if (idx !== -1) loadedModels.splice(idx, 1);

        // Remove UI
        container.remove();

        clearSelection(scene);
        updateSelectionUI();
    });

    // A group with more than one mesh+edges pair (e.g. our green/red/blue
    // standable-surface group) has more than one independent color, so a
    // single swatch can't represent it — skip creating/forcing that picker.
    const isMultiMeshGroup = !!(meshObj?.children && !meshObj.material && meshObj.children.length > 2);

    // Color picker
    const colorInput = document.createElement('input');
    colorInput.type = 'color';

    if (!isMultiMeshGroup) {
        const savedColor = modelState[name]?.color;

        colorInput.value = savedColor ??
            (color ?? (clearFirst ? '#3aa6ff' : '#3aff78'));

        if (meshObj?.material) {
            meshObj.material.color.set(colorInput.value);
        }
        else if (meshObj?.children) {
            meshObj.children[0].material.color.set(colorInput.value);
        }
        else if (edgesObj?.material) {
            edgesObj.material.color.set(colorInput.value);
        }

        colorInput.addEventListener('input', () => {

            if (meshObj?.material) {
                meshObj.material.color.set(colorInput.value);
                meshObj.material.needsUpdate = true;
            }
            else if (meshObj?.children) {
                meshObj.children[0].material.color.set(colorInput.value);
                meshObj.children[0].material.needsUpdate = true;
            }
            else if (edgesObj?.material) {
                edgesObj.material.color.set(colorInput.value);
                edgesObj.material.needsUpdate = true;
            }

            // Ensure entry exists
            if (!modelState[name]) modelState[name] = {};

            // Save color
            modelState[name].color = colorInput.value;
        });
    }

    // Assemble
    container.appendChild(label);
    if (!isMultiMeshGroup) {
        container.appendChild(colorInput);
    }
    if(deleteButton) {
        container.appendChild(del);
    }
    section.appendChild(container);
}

export function removeAllModelCheckboxes() {
    const section = document.querySelector('.controls');
    // Remove all containers that hold the model checkbox + color picker
    section.querySelectorAll('div').forEach(container => {
        const label = container.querySelector('label');
        if (label && label.textContent.trim().startsWith('Show ')) {
            container.remove();
        }
    });
    //delete modelVisibilityState[name];
}

const modelState = {};

////////////////////////////////////////
// System: Geometry creation
////////////////////////////////////////

const wireframeCheckbox = document.getElementById('wireframe');

wireframeCheckbox.addEventListener('change', () => {
    loadedModels.forEach(m => {
        if (m.edges && m.mesh) {
            m.edges.visible = m.mesh.visible && wireframeCheckbox.checked;
        }
    });
});

// Material used as base for clones per mesh
//
// MeshLambertMaterial, not MeshStandardMaterial: Standard/Physical materials
// compute full PBR lighting per-fragment; Lambert computes it per-vertex and
// interpolates, so its cost scales with vertex count rather than covered
// screen area. Helps, but wasn't the main cost - see transparent:false below.
//
// transparent: false (was true) - this is the actual fix for "a couple huge
// triangles lag hard, thousands of small ones don't, and shrinking the
// browser window makes it go away." That symptom set (resolution-dependent,
// scales with pixels covered, not triangle/vertex count) is the signature of
// a fill-rate/blending cost, not a shading-model or JS cost.
//
// transparent:true puts the GPU on the alpha-blend path for every fragment:
// blending is a read-modify-write against the framebuffer (must read the
// existing pixel color to blend with it) instead of a plain write, and it
// forfeits the early-depth-test/early-Z rejection opaque draws get, so the
// fragment shader can end up running for pixels a depth pre-pass would
// otherwise have skipped. That cost is paid per pixel covered - negligible
// for lots of small triangles scattered across the screen, but huge for one
// enormous triangle that fills most of the viewport when the camera is
// close to it and facing it - exactly "look towards a very large triangle."
//
// This was always effectively dead weight: the opacity slider and
// "Translucent" checkbox that setMaterialProps() reads to decide
// transparent/opacity are both `style="display:none"` in index.html, so
// there's no live UI path that ever sets transparent back to true or
// changes opacity off of 1.0 - every mesh has been permanently opaque in
// appearance but paying the translucent-rendering cost since these
// materials were created.
const material = new THREE.MeshLambertMaterial({color:0x3aa6ff,side:THREE.FrontSide,transparent:false,opacity:1.0,flatShading:true});
const material_red_wall = new THREE.MeshLambertMaterial({color:0xf56342,side:THREE.FrontSide,transparent:false,opacity:1.0,flatShading:true});
const material_yellow_ceiling = new THREE.MeshLambertMaterial({color:0xe1eb34,side:THREE.FrontSide,transparent:false,opacity:1.0,flatShading:true});

export function clearAllModels(scene) {
    loadedModels.forEach(m => {
        scene.remove(m.mesh);
        scene.remove(m.edges);
    });
    loadedModels = [];
    
    loadedModelsNotSelectable.forEach(m => {
        scene.remove(m.mesh);
        scene.remove(m.edges);
    });
    loadedModelsNotSelectable = [];

    // Remove all model checkboxes
    removeAllModelCheckboxes();
    
    // Clear selection
    clearSelection(scene);
}

export function buildGeometry(scene, verts, tris, allTriangleData, colCtx, name = "Main Model", clearFirst = true, noPrimaryModel = false, color = 0x3aa6ff) {
    
    if ((!verts || !tris || verts.length === 0 || tris.length === 0) && clearFirst) { 
        alert('No valid vertices or triangles found'); 
        return; 
    }

    // Optionally clear all existing models
    if (clearFirst) {
        clearAllModels(scene);
    }

    // Create vertex positions
    const positions = new Float32Array(verts.length * 3);
    for (let i = 0; i < verts.length; i++) {
        positions[3 * i]     = verts[i][0];
        positions[3 * i + 1] = verts[i][1];
        positions[3 * i + 2] = verts[i][2];
    }

    // Create triangle indices
    const indices = new (verts.length > 65535 ? Uint32Array : Uint16Array)(tris.length * 3);
    for (let i = 0; i < tris.length; i++) {
        indices[3 * i]     = tris[i][0];
        indices[3 * i + 1] = tris[i][1];
        indices[3 * i + 2] = tris[i][2];
    }

    // Build geometry and mesh
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geom.setIndex(new THREE.BufferAttribute(indices, 1));
    
    const meshObj = new THREE.Mesh(geom, material.clone());
    meshObj.material.polygonOffset = true;
    meshObj.material.polygonOffsetFactor = 1;
    meshObj.material.polygonOffsetUnits = 1;
    meshObj.userData.triangles = allTriangleData;  // Store metadata
    meshObj.userData.colCtx = colCtx;  // Store metadata
    if(!clearFirst || noPrimaryModel)
        meshObj.material.color.set(0x3aff78);
    scene.add(meshObj);

    // Build wireframe edges
    const edgePositions = [];
    for (let i = 0; i < indices.length; i += 3) {
        const a = indices[i], b = indices[i + 1], c = indices[i + 2];
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
        new THREE.LineBasicMaterial({ color: 0x3240a8, linewidth: 1, opacity: 0.8, transparent: true }) // 3240a8
    );
    edgesObj.visible = wireframeCheckbox.checked;
    scene.add(edgesObj);

    // Store and register in UI
    loadedModels.push({ name, mesh: meshObj, edges: edgesObj });
    //console.log(loadedModels);
    addModelCheckbox(scene, name, meshObj, edgesObj, clearFirst, true, noPrimaryModel ? '#3aff78' : null);
    
    updateSamplePointsUIVisibility(game);
}

export function buildGeometry_fwc(scene, verts, tris, name = "Main Model", clearFirst = true) {

    if ((!verts || !tris || verts.length === 0 || tris.length === 0) && clearFirst) {
        alert('No valid vertices or triangles found');
        return;
    }

    // Clear existing models
    if (clearFirst) {
        clearAllModels(scene);
    }

    // Build vertex buffer
    const positions = new Float32Array(verts.length * 3);
    for (let i = 0; i < verts.length; i++) {
        positions[i * 3 + 0] = verts[i][0];
        positions[i * 3 + 1] = verts[i][1];
        positions[i * 3 + 2] = verts[i][2];
    }

    // Build index buffer
    const indices = new (verts.length > 65535 ? Uint32Array : Uint16Array)(tris.length * 3);
    for (let i = 0; i < tris.length; i++) {
        indices[i * 3 + 0] = tris[i][0];
        indices[i * 3 + 1] = tris[i][1];
        indices[i * 3 + 2] = tris[i][2];
    }

    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geom.setIndex(new THREE.BufferAttribute(indices, 1));
    geom.clearGroups();

    // --- normal.y helper ---
    function triangleNormalY(a, b, c) {
        const ax = b[0] - a[0];
        const ay = b[1] - a[1];
        const az = b[2] - a[2];

        const bx = c[0] - a[0];
        const by = c[1] - a[1];
        const bz = c[2] - a[2];

        const nx = ay * bz - az * by;
        const ny = az * bx - ax * bz;
        const nz = ax * by - ay * bx;

        const len = Math.sqrt(nx * nx + ny * ny + nz * nz) || 1;
        return ny / len;
    }

    // --- build geometry groups ---
    let groupStart = 0;
    let currentGroup = null;

    for (let i = 0; i < tris.length; i++) {
        const [ia, ib, ic] = tris[i];
        const ny = triangleNormalY(verts[ia], verts[ib], verts[ic]);

        let group;
        if (ny > 0.5) {
            group = 0;          // floor
        } else if (ny < -0.8) {
            group = 2;          // ceiling
        } else {
            group = 1;          // wall
        }

        if (currentGroup === null) {
            currentGroup = group;
            groupStart = i * 3;
        }

        if (group !== currentGroup) {
            geom.addGroup(groupStart, (i * 3) - groupStart, currentGroup);
            groupStart = i * 3;
            currentGroup = group;
        }
    }

    // flush final group
    geom.addGroup(groupStart, tris.length * 3 - groupStart, currentGroup);

    // --- mesh ---
    const meshObj = new THREE.Mesh(
        geom,
        [
            material.clone(),   // group 0
            material_red_wall.clone(),  // group 1
            material_yellow_ceiling.clone()   // group 2
        ]
    );

    meshObj.material.forEach(m => {
        m.polygonOffset = true;
        m.polygonOffsetFactor = 1;
        m.polygonOffsetUnits = 1;
    });

    if (!clearFirst) {
        meshObj.material.forEach(m => m.color.set(0x3aff78));
    }

    scene.add(meshObj);

    // --- wireframe edges ---
    const edgePositions = [];
    for (let i = 0; i < indices.length; i += 3) {
        const a = indices[i], b = indices[i + 1], c = indices[i + 2];
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
        new THREE.LineBasicMaterial({
            color: 0x3240a8,
            linewidth: 1,
            opacity: 0.8,
            transparent: true
        })
    );

    edgesObj.visible = wireframeCheckbox.checked;
    scene.add(edgesObj);

    // Register model
    loadedModels.push({ name, mesh: meshObj, edges: edgesObj });
    addModelCheckbox(scene, name, meshObj, edgesObj, clearFirst, true);
    
    updateSamplePointsUIVisibility(game);
}

export function buildGeometryFromTriangles(scene, allTriangleData, colCtx, name = "Main Model", clearFirst = true) {

    if ((!allTriangleData || allTriangleData.length === 0) && clearFirst) {
        alert("No triangle data found");
        return;
    }

    // ---------------------
    // Optional: Clear scene
    // ---------------------
    if (clearFirst) {
        clearAllModels(scene);
    }

    // ---------------------
    // Build position buffer
    // ---------------------
    const positions = new Float32Array(allTriangleData.length * 9); // 3 verts × 3 floats
    const indices   = new (allTriangleData.length > 21845 ? Uint32Array : Uint16Array)(allTriangleData.length * 3);

    let pi = 0;
    for (let i = 0; i < allTriangleData.length; i++) {
        const tri = allTriangleData[i];
        const v0 = tri.vtxs[0], v1 = tri.vtxs[1], v2 = tri.vtxs[2];

        positions[pi++] = v0.x; positions[pi++] = v0.y; positions[pi++] = v0.z;
        positions[pi++] = v1.x; positions[pi++] = v1.y; positions[pi++] = v1.z;
        positions[pi++] = v2.x; positions[pi++] = v2.y; positions[pi++] = v2.z;

        const base = i * 3;
        indices[base]     = base;
        indices[base + 1] = base + 1;
        indices[base + 2] = base + 2;
    }

    // ---------------------
    // Build geometry object
    // ---------------------
    const geom = new THREE.BufferGeometry();
    geom.setAttribute("position", new THREE.BufferAttribute(positions, 3));
    geom.setIndex(new THREE.BufferAttribute(indices, 1));

    // Three’s normals are lighting normals. Not what you want for OOT plane normals.
    // But we let Three compute them anyway for shading.
    geom.computeVertexNormals();

    const meshObj = new THREE.Mesh(geom, material.clone());
    meshObj.material.polygonOffset = true;
    meshObj.material.polygonOffsetFactor = 1;
    meshObj.material.polygonOffsetUnits = 1;
    if (!clearFirst)
        meshObj.material.color.set(0x3aff78);

    // Store original triangle metadata here
    meshObj.userData.triangles = allTriangleData;
    meshObj.userData.colCtx = colCtx;

    scene.add(meshObj);

    // ---------------------
    // Wireframe edges
    // ---------------------
    const edgePositions = [];
    for (let i = 0; i < indices.length; i += 3) {
        const a = indices[i], b = indices[i+1], c = indices[i+2];
        const pa = new THREE.Vector3(
            positions[3*a], positions[3*a+1], positions[3*a+2]
        );
        const pb = new THREE.Vector3(
            positions[3*b], positions[3*b+1], positions[3*b+2]
        );
        const pc = new THREE.Vector3(
            positions[3*c], positions[3*c+1], positions[3*c+2]
        );

        edgePositions.push(
            pa.x, pa.y, pa.z, pb.x, pb.y, pb.z,
            pb.x, pb.y, pb.z, pc.x, pc.y, pc.z,
            pc.x, pc.y, pc.z, pa.x, pa.y, pa.z
        );
    }

    const edgeGeom = new THREE.BufferGeometry();
    edgeGeom.setAttribute('position', new THREE.Float32BufferAttribute(edgePositions, 3));
    const edgesObj = new THREE.LineSegments(
        edgeGeom,
        new THREE.LineBasicMaterial({
            color: 0x3240a8,
            linewidth: 1,
            opacity: 0.8,
            transparent: true
        })
    );
    edgesObj.visible = wireframeCheckbox.checked;
    scene.add(edgesObj);

    // Register in UI
    loadedModels.push({ name, mesh: meshObj, edges: edgesObj });
    addModelCheckbox(scene, name, meshObj, edgesObj, clearFirst, true);

    updateSamplePointsUIVisibility(game);
}

export function buildGeometryEdges(scene, verts, edges, name = "Edge Model", clearFirst = true, checked = true) {

    if ((!verts || !edges || verts.length === 0 || edges.length === 0) && clearFirst) {
        alert('No valid vertices or edges found');
        return;
    }

    // Clear existing models
    if (clearFirst) {
        clearAllModels(scene);
    }

    // Flatten edge positions (original logic)
    const edgePositions = [];
    for (let i = 0; i < edges.length; i++) {
        const [a, b] = edges[i];
        const va = verts[a];
        const vb = verts[b];
        edgePositions.push(
            va[0], va[1], va[2],
            vb[0], vb[1], vb[2]
        );
    }

    const edgeGeom = new THREE.BufferGeometry();
    edgeGeom.setAttribute('position', new THREE.Float32BufferAttribute(edgePositions, 3));

    // Improve visibility
    const edgesObj = new THREE.LineSegments(
        edgeGeom,
        new THREE.LineBasicMaterial({
            color: 0x00ff00,   // green
            linewidth: 1,   // thickness in world units
            transparent: false,
            opacity: 0.8,
            depthTest: true
        })
    );

    edgesObj.visible = true;
    scene.add(edgesObj);

    // edgeSelectable: true - opts this model's edges into selection.js's
    // edge-picking pass (see the edgeSelectable check there). Safe here since
    // these ARE the model's whole geometry (e.g. Seams Model, Subdivision
    // Grid), unlike a per-triangle wireframe overlay where every edge
    // becoming individually clickable would make triangle selection noisy.
    loadedModels.push({ name, mesh: null, edges: edgesObj, edgeSelectable: true });

    // Register in UI
    addModelCheckbox(scene, name, null, edgesObj, clearFirst, checked);
}

export function buildGeometryButDontAddToScene(scene, verts, tris, allTriangleData, colCtx, name = "Main Model", 
    clearFirst = true, noPrimaryModel = false, color = 0x3aa6ff) {
    if ((!verts || !tris || verts.length === 0 || tris.length === 0) && clearFirst) {
        alert('No valid vertices or triangles found');
        return;
    }

    // Optionally clear all existing models
    if (clearFirst) {
        clearAllModels(scene);
    }

    // Create vertex positions
    const positions = new Float32Array(verts.length * 3);
    for (let i = 0; i < verts.length; i++) {
        positions[3 * i] = verts[i][0];
        positions[3 * i + 1] = verts[i][1];
        positions[3 * i + 2] = verts[i][2];
    }

    // Create triangle indices
    const indices = new(verts.length > 65535 ? Uint32Array : Uint16Array)(tris.length * 3);
    for (let i = 0; i < tris.length; i++) {
        indices[3 * i] = tris[i][0];
        indices[3 * i + 1] = tris[i][1];
        indices[3 * i + 2] = tris[i][2];
    }

    // Build geometry and mesh
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geom.setIndex(new THREE.BufferAttribute(indices, 1));
    const meshObj = new THREE.Mesh(geom, material.clone());
    meshObj.material.polygonOffset = true;
    meshObj.material.polygonOffsetFactor = 1;
    meshObj.material.polygonOffsetUnits = 1;
    meshObj.userData.triangles = allTriangleData;
    meshObj.userData.colCtx = colCtx;

    if (!clearFirst || noPrimaryModel) {
        meshObj.material.color.set(0x3aff78);
    } else {
        meshObj.material.color.set(color);
    }

    // Build wireframe edges
    const edgePositions = [];
    for (let i = 0; i < indices.length; i += 3) {
        const a = indices[i];
        const b = indices[i + 1];
        const c = indices[i + 2];
        const va = verts[a];
        const vb = verts[b];
        const vc = verts[c];
        edgePositions.push(
            va[0], va[1], va[2],
            vb[0], vb[1], vb[2],

            vb[0], vb[1], vb[2],
            vc[0], vc[1], vc[2],

            vc[0], vc[1], vc[2],
            va[0], va[1], va[2]
        );
    }
    const edgeGeom = new THREE.BufferGeometry();
    edgeGeom.setAttribute('position', new THREE.Float32BufferAttribute(edgePositions, 3));
    const edgesObj = new THREE.LineSegments(edgeGeom, new THREE.LineBasicMaterial({
        color: 0x3240a8,
        linewidth: 1,
        opacity: 0.8,
        transparent: true
    }));
    edgesObj.visible = wireframeCheckbox.checked;

    // Store and register in UI only for normal standalone models
    if (clearFirst) {
        loadedModels.push({
            name,
            mesh: meshObj,
            edges: edgesObj
        });
        addModelCheckbox(scene, name, meshObj, edgesObj, clearFirst, true, noPrimaryModel ? '#3aff78' : null);
        updateSamplePointsUIVisibility(game);
    }
    return {
        mesh: meshObj,
        edges: edgesObj
    };
}

////////////////////////////////////////
// System: Test model & dev helpers
////////////////////////////////////////

// initial scene: build a small test cube if user hasn't loaded
export function buildTest(scene){
    const verts = [[-200,-200,-200],[200,-200,-200],[200,200,-200],[-200,200,-200],[-200,-200,200],[200,-200,200],[200,200,200],[-200,200,200]];
    const tris = [[0,1,2],[0,2,3],[4,7,6],[4,6,5],[0,4,5],[0,5,1],[1,5,6],[1,6,2],[2,6,7],[2,7,3],[3,7,4],[3,4,0]];
    buildGeometry(scene, verts, tris, null, null, "Main Model", true);
}
