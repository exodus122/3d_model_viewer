import * as THREE from 'three';

////////////////////////////////////////
// System: Flat Ground and Special Normal Preview (Main Model only)
////////////////////////////////////////

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


export function scanAndBuildSurfaceTypeMarkers(parameter) {

    const mainModel = loadedModels.find(m => m.name === "Main Model");
    if (!mainModel || !mainModel.mesh) return null;

    const mesh = mainModel.mesh;
    const triData = mesh.userData.triangles;
    const colCtxData = mesh.userData.colCtx;
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
        const type = tri.type;
        
        if (parameter == "horseBlocked" || parameter == "isSoft" || parameter == "wallDamage" || parameter == "canHookshot" || parameter == "loadingZone" || parameter == "echo" || parameter == "unk18") {
            if (colCtxData.surfaceTypes[type][parameter] == 0)
                continue;
        }
        else if(parameter == "conveyor") {
            if (tri.flags != 1)
                continue;
        }
        else {
            console.log("scanAndBuildSurfaceTypeMarkers: unknown parameter: '"+parameter+"'")
            return null;
        }

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
        color: 0xb06ae6,
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
    master.visible = false;
    
    return master;
}

export function buildSurfaceTypeMarkers(scene) {
    let parameters = [
        "loadingZone", // surfaceExitIndex
        "canHookshot",
        "wallDamage",
        "horseBlocked",
        "isSoft",
        //"floorProperty",
        //"wallType",
        //"unk18",
        //"floorType",
        //"bgCamIndex",
        //"conveyorDirection",
        //"conveyorSpeed",
        //"echo",
        //"lightSetting",
        //"floorEffect",
        //"material"
    ];
    
    /*let parameters = [
        "horseBlocked",
        "isSoft"
    ];*/

    for (let p = 0; p < parameters.length; p++) {
        const param = parameters[p];
        const surfaceTypeGroup = scanAndBuildSurfaceTypeMarkers(param);
        
        if(surfaceTypeGroup) {
            scene.add(surfaceTypeGroup);

            loadedModels.push({
                name: param,
                mesh: surfaceTypeGroup,
                edges: null
            });
        }
    }
    
    const dropdownContent = document.getElementById("surfaceDropdownContent");

    function buildSurfaceTypeCheckboxes() {
        dropdownContent.innerHTML = ""; // clear previous
        
        parameters.forEach(param => {
            const label = document.createElement("label");

            label.innerHTML = `
                <input type="checkbox" id="chk_${param}">
                ${param}
            `;

            dropdownContent.appendChild(label);
        });
    }

    buildSurfaceTypeCheckboxes();
    
    function setupSurfaceTypeVisibility() {
        parameters.forEach(param => {
            const checkbox = document.getElementById("chk_" + param);

            checkbox.addEventListener("change", () => {
                const entry = loadedModels.find(m => m.name === param);
                if (entry) {
                    entry.mesh.visible = checkbox.checked;
                }
            });
        });
    }

    setupSurfaceTypeVisibility();
    
    /*let parameters = ["horseBlocked", "isSoft", "loadingZone"];
    for (let p = 0; p < parameters.length; p++) {
        const surfaceTypeGroup = scanAndBuildSurfaceTypeMarkers(parameters[p]);
        scene.add(surfaceTypeGroup);
        loadedModels.push({ name: parameters[p], mesh: surfaceTypeGroup, edges: null });
    }*/
    
    /*let parameters = ["horseBlocked", "isSoft", "loadingZone"];
    for(let p = 0; p < parameters.length; p++){
        const surfaceTypeGroup = scanAndBuildSurfaceTypeMarkers(parameters[p]);
        scene.add(surfaceTypeGroup);
        loadedModels.push({ name: "SurfaceType", mesh: surfaceTypeGroup, edges: null });
        //addModelCheckbox(scene, "SurfaceType", surfaceTypeGroup, null, false, false, "#b06ae6");
    }*/
    
    /*const surfaceTypeGroup = scanAndBuildSurfaceTypeMarkers(surfaceTypeDropdown.value);
    if (surfaceTypeGroup) {
        scene.add(surfaceTypeGroup);
        loadedModels.push({ name: "SurfaceType", mesh: surfaceTypeGroup, edges: null });
        addModelCheckbox(scene, "SurfaceType", surfaceTypeGroup, null, false, false, "#b06ae6");
    }*/
    
    //getSelectedSurfaceFields();
}