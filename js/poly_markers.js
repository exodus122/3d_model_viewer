import * as THREE from 'three';

////////////////////////////////////////
// System: Flat Ground Preview (Main Model only)
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
        polygonOffsetFactor: 1,
        polygonOffsetUnits: 1
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
        polygonOffsetFactor: 1,
        polygonOffsetUnits: 1
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
// System: Subdivision markers
////////////////////////////////////////

const subdivisionSelector = document.getElementById("subdivisionSelector");

// Wireframe box for one subdivision cell's RAW bounds - `bounds` is
// colCtx.subdivisions[i].bounds, i.e. [[xmin,xmax],[ymin,ymax],[zmin,zmax]]
// as computed in initColCtx (subdivisions.js), which does NOT pad by
// BGCHECK_SUBDIV_OVERLAP. That padding only gets applied later, when
// actually testing/registering polygons against a cell (see
// getSubdivisionBoundsForIndex in subdivisions.js) - this draws the bare,
// non-overlapping cell partition, same as the "Subdivision Grid" model.
function buildSubdivisionCubeEdges(bounds) {
    const [[x0, x1], [y0, y1], [z0, z1]] = bounds;

    const c = [
        [x0, y0, z0], [x1, y0, z0], [x1, y0, z1], [x0, y0, z1], // bottom face
        [x0, y1, z0], [x1, y1, z0], [x1, y1, z1], [x0, y1, z1]  // top face
    ];
    const idxPairs = [
        [0, 1], [1, 2], [2, 3], [3, 0], // bottom
        [4, 5], [5, 6], [6, 7], [7, 4], // top
        [0, 4], [1, 5], [2, 6], [3, 7]  // verticals
    ];

    const positions = [];
    for (const [a, b] of idxPairs) positions.push(...c[a], ...c[b]);

    const geom = new THREE.BufferGeometry();
    geom.setAttribute("position", new THREE.Float32BufferAttribute(positions, 3));

    const mat = new THREE.LineBasicMaterial({
        color: 0xffaa00,
        linewidth: 2,
        depthTest: true
    });

    const edges = new THREE.LineSegments(geom, mat);
    edges.renderOrder = 999;
    return edges;
}

export function scanAndBuildSubdivision() {
    const mainModel = loadedModels.find(m => m.name === "Main Model");
    if (!mainModel || !mainModel.mesh) return null;

    const mesh = mainModel.mesh;
    const triData = mesh.userData.triangles;
    const colCtxData = mesh.userData.colCtx;
    if (!triData || triData.length === 0) return null;

    const geom = mesh.geometry;
    const pos = geom.attributes.position;
    const index = geom.index;

    const subdiv = Number(subdivisionSelector.value);
    const subdivEntry = colCtxData?.subdivisions?.[subdiv];

    // -------------------------
    // Collect merged geometry
    // -------------------------
    const mergedVerts = [];
    const mergedEdges = [];

    if (subdivEntry) {
        for (let i = 0; i < triData.length; i++) {

            const ia = index.getX(i*3);
            const ib = index.getX(i*3 + 1);
            const ic = index.getX(i*3 + 2);

            const va = new THREE.Vector3().fromBufferAttribute(pos, ia);
            const vb = new THREE.Vector3().fromBufferAttribute(pos, ib);
            const vc = new THREE.Vector3().fromBufferAttribute(pos, ic);

            const tri = triData[i];

            if (!subdivEntry.floors.includes(tri.id)
                && !subdivEntry.walls.includes(tri.id)
                && !subdivEntry.ceilings.includes(tri.id))
                continue;

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
    }

    // -------------------------
    // Build final group. Always includes the selected cell's raw-bounds
    // wireframe cube (when the subdivision index is valid) even if the cell
    // has no registered triangles, so empty cells are still visible - the
    // triangle mesh/edges are only added on top when there's actually
    // geometry in the cell.
    // -------------------------
    const master = new THREE.Group();

    if (subdivEntry) {
        const cubeEdges = buildSubdivisionCubeEdges(subdivEntry.bounds);
        master.add(cubeEdges);
        // Exposed so the caller (parse_model.js) can wire this specific
        // object up as the model's selectable edges, without relying on
        // child ordering within the group.
        master.userData.cubeEdges = cubeEdges;
    }

    if (mergedVerts.length > 0) {
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
            polygonOffsetFactor: 1,
            polygonOffsetUnits: 1
        });

        const mergedMesh = new THREE.Mesh(meshGeom, meshMat);
        mergedMesh.renderOrder = 1;

        const edgeGeom = new THREE.BufferGeometry();
        edgeGeom.setAttribute(
            "position",
            new THREE.Float32BufferAttribute(mergedEdges, 3)
        );

        const edgeMat = new THREE.LineBasicMaterial({
            color: 0x000000,
            linewidth: 1.5,
            depthTest: true
        });

        const mergedEdgesObj = new THREE.LineSegments(edgeGeom, edgeMat);
        mergedEdgesObj.renderOrder = 999;

        master.add(mergedMesh);
        master.add(mergedEdgesObj);
    }

    if (master.children.length === 0) return null;

    return master;
}

////////////////////////////////////////
// System: Surface flag markers
////////////////////////////////////////

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
        
        if (parameter == "horseBlocked" || parameter == "isSoft" || parameter == "wallDamage" || parameter == "canHookshot" 
            || parameter == "loadingZone" || parameter == "echo" || parameter == "unk18") {
            
            if (colCtxData.surfaceTypes[type][parameter] == 0)
                continue;
        }
        else if(parameter == "void1 (FLOOR_PROPERTY_5)") {
            if (colCtxData.surfaceTypes[type].floorProperty != 5)
                continue;
        }
        else if(parameter == "noJump2 (FLOOR_PROPERTY_6)") {
            if (colCtxData.surfaceTypes[type].floorProperty != 6)
                continue;
        }
        else if(parameter == "hoverNoISG (FLOOR_PROPERTY_7)") {
            if (colCtxData.surfaceTypes[type].floorProperty != 7)
                continue;
        }
        else if(parameter == "walkAbove (FLOOR_PROPERTY_8)") {
            if (colCtxData.surfaceTypes[type].floorProperty != 8)
                continue;
        }
        else if(parameter == "noJump1 (FLOOR_PROPERTY_9)") {
            if (colCtxData.surfaceTypes[type].floorProperty != 9)
                continue;
        }
        else if(parameter == "diveOff (FLOOR_PROPERTY_11)") {
            if (colCtxData.surfaceTypes[type].floorProperty != 11)
                continue;
        }
        else if(parameter == "void2 (FLOOR_PROPERTY_12)") {
            if (colCtxData.surfaceTypes[type].floorProperty != 12)
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
        polygonOffsetFactor: 1,
        polygonOffsetUnits: 1
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
        "conveyor",
        "void1 (FLOOR_PROPERTY_5)",
        "noJump2 (FLOOR_PROPERTY_6)",
        "hoverNoISG (FLOOR_PROPERTY_7)",
        "walkAbove (FLOOR_PROPERTY_8)",
        "noJump1 (FLOOR_PROPERTY_9)",
        "diveOff (FLOOR_PROPERTY_11)",
        "void2 (FLOOR_PROPERTY_12)"
        
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
