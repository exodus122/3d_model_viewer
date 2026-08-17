import * as THREE from 'three';
import { clearSelection, updateSelectionUI } from './selection.js';
import { updateSamplePointsUIVisibility } from './sample_points.js';

////////////////////////////////////////
// Model checkboxes
////////////////////////////////////////

// colorTarget: object whose materials the swatch edits, when that differs
// from the object the checkbox shows/hides. A dynapoly actor is one group
// holding tangible, intangible and waterbox parts in three different
// meaningful colours; the checkbox toggles the whole group, but the swatch
// should drive only the part the row's colour represents. Defaults to
// meshObj, which is the behaviour every other caller wants.
export function addModelCheckbox(scene, name, meshObj, edgesObj, clearFirst, checked, color = null, deleteButton = false,
    colorTarget = null) {
    const getMaterials = (object) => {
        const materials = [];

        if (!object) {
            return materials;
        }

        object.traverse((child) => {
            if (child.material) {
                if (Array.isArray(child.material)) {
                    materials.push(...child.material);
                } else {
                    materials.push(child.material);
                }
            }
        });

        return materials;
    };

    const section = document.querySelector('.controls');

    // Container
    //
    // Layout lives in stylesheet.css (.model-row and friends) rather than in
    // inline styles. The important part: the label is the only flexible item
    // in the row, so the swatch and the delete button keep a fixed size and
    // line up in a column down the panel however long the model names are.
    const container = document.createElement('div');
    container.className = 'model-row';
    container.dataset.modelName = name;

    // Visibility checkbox + label
    const label = document.createElement('label');
    label.className = 'model-label';
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

    // Wrapped in a span so it can be given its own overflow rules: long
    // names ellipsize instead of wrapping onto a second line or pushing the
    // swatch out of alignment. The title gives the full name back on hover.
    const labelText = document.createElement('span');
    labelText.className = 'model-label-text';
    labelText.textContent = `Show ${name}`;
    labelText.title = `Show ${name}`;
    label.appendChild(labelText);

    // ----- DELETE BUTTON -----
    const del = document.createElement('button');
    del.type = 'button';
    del.textContent = "×";
    del.title = "Remove this model";
    del.classList.add("delete-btn", "model-delete");
    
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
    //
    // Tested against colorSource, not meshObj: a caller that names a single
    // mesh as its colour target has told us exactly what the swatch drives,
    // so the enclosing group's child count is irrelevant. Without this, a
    // dynapoly actor holding both tangible and intangible collision tripped
    // the multi-mesh test and lost its swatch entirely.
    const colorSource = colorTarget ?? meshObj;
    const isMultiMeshGroup = !!(colorSource?.children && !colorSource.material && colorSource.children.length > 2);

    // Color picker
    const colorInput = document.createElement('input');
    colorInput.type = 'color';
    colorInput.className = 'model-color';
    colorInput.title = `Colour for ${name}`;

    if (!isMultiMeshGroup) {
        const savedColor = modelState[name]?.color;

        colorInput.value = savedColor ??
            (color ?? (clearFirst ? '#3aa6ff' : '#3aff78'));

        const materials = getMaterials(colorSource);

        if (materials.length > 0) {
            materials[0].color.set(colorInput.value);
        }
        else {
            const edgeMaterials = getMaterials(edgesObj);

            if (edgeMaterials.length > 0) {
                edgeMaterials[0].color.set(colorInput.value);
            }
        }

        colorInput.addEventListener('input', () => {

            const materials = getMaterials(colorSource);

            if (materials.length > 0) {
                materials[0].color.set(colorInput.value);
                materials[0].needsUpdate = true;
            }
            else {
                const edgeMaterials = getMaterials(edgesObj);

                if (edgeMaterials.length > 0) {
                    edgeMaterials[0].color.set(colorInput.value);
                    edgeMaterials[0].needsUpdate = true;
                }
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
    } else {
        // A multi-mesh group has no single colour to show, but it still needs
        // to occupy the swatch column so its label doesn't stretch further
        // right than every other row's.
        const spacer = document.createElement('span');
        spacer.className = 'model-color-spacer';
        container.appendChild(spacer);
    }

    if (deleteButton) {
        container.appendChild(del);
    } else {
        // Same idea for the delete column, so rows with and without a delete
        // button keep their swatches vertically aligned.
        const spacer = document.createElement('span');
        spacer.className = 'model-delete-spacer';
        container.appendChild(spacer);
    }

    section.appendChild(container);
}

export function removeAllModelCheckboxes() {
    const section = document.querySelector('.controls');
    // Match on the row class rather than sniffing label text for a "Show "
    // prefix, which would also have caught any other div in .controls that
    // happened to start that way.
    section.querySelectorAll('.model-row').forEach(container => container.remove());
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
    clearFirst = true, noPrimaryModel = false, color = null) {
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

    // Colour resolution.
    //
    // This used to read `if (!clearFirst || noPrimaryModel)`, which silently
    // threw away the caller's `color` for every additive model. Dynapoly
    // actors always load additively (clearFirst === false), so their tangible
    // and intangible collision both came out the same secondary green -- an
    // actor with a mix of the two rendered entirely in the intangible colour.
    //
    // clearFirst means "reset the scene first" and has nothing to do with
    // colour, so it no longer participates. An explicit colour always wins;
    // otherwise noPrimaryModel picks the secondary default.
    if (color !== null && color !== undefined) {
        meshObj.material.color.set(color);
    } else if (noPrimaryModel) {
        meshObj.material.color.set(0x3aff78);
    } else {
        meshObj.material.color.set(0x3aa6ff);
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
