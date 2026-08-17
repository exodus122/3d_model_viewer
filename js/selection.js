import * as THREE from 'three';
import { drawSampledTriangles, removeAllSampledPoints } from './sample_points.js';
import { currentColCtx } from './parse_model.js';

////////////////////////////////////////
// System: Selection (raycast, markers, UI)
////////////////////////////////////////

let selectedTriangles = [];
let selectedPoints = [];
let selectedEdges = [];

// Raycaster for selection
const raycaster = new THREE.Raycaster();
const mouse = new THREE.Vector2();

const multiSelectCheckbox = document.getElementById('multiSelect');
const selectionListEl = document.getElementById('selectionListEl');

// Listen for changes to multi-select checkbox
multiSelectCheckbox.addEventListener('change', () => {
    if (!multiSelectCheckbox.checked) {
        clearSelection(scene); // clears all yellow triangles & selection info
    }
});

// Update selection UI
export function updateSelectionUI() {
    function formatNumber(v) {
        return (v % 1 === 0) ? v.toString() : v.toFixed(7);
    }

    const lines = [];
    
    let sampled_triangles = [];
    for (const t of selectedTriangles) {
        if (t.type === "waterbox") {
            const wb = t.waterbox;
            lines.push(
                `WATERBOX ${t.index}: ` +
                `xMin=${wb.xMin}, ySurface=${wb.ySurface}, zMin=${wb.zMin}, ` +
                `xLen=${wb.xLength}, zLen=${wb.zLength}, props=${wb.properties}`
            );
            continue;
        }
        
        const pts = t.verts.map(v => `${formatNumber(v.x)} ${formatNumber(v.y)} ${formatNumber(v.z)}`);
        let line = `TRI`;
        if (t.id != null)
            line += ` ${t.id}`;
        line += `:  ${pts.join(' ')}`;

        if (t.normals) {
            line += `   NORMAL: ${t.normals[0]}, ${t.normals[1]}, ${t.normals[2]}`;
        }

        if (t.dist !== null && t.dist !== undefined) {
            line += `   DIST: ${t.dist}`;
        }

        if (t.xpFlags !== null && t.xpFlags !== undefined) {
            line += `   XPFLAGS: ${t.xpFlags}`;
        }

        if (t.flags !== null && t.flags !== undefined && t.flags == 1) {
            line += `   CONVEYOR`;
        }

        lines.push(line);
    }
    
    for (const e of selectedEdges) {
        const a = e.a, b = e.b;
        lines.push(
            `EDGE ${e.index}:  ` +
            `${a.x.toFixed(7)}, ${a.y.toFixed(7)}, ${a.z.toFixed(7)},  ` +
            `${b.x.toFixed(7)}, ${b.y.toFixed(7)}, ${b.z.toFixed(7)}`
        );
    }

    for (const p of selectedPoints) {
        const v = p.pos;
        lines.push(`PT:  ${formatNumber(v.x)}, ${formatNumber(v.y)}, ${formatNumber(v.z)}`);
    }

    selectionListEl.value = lines.join("\n");
}

// Clear selection
export function clearSelection(scene) {
    // ---- WATERBOX ----
    selectedTriangles
        .filter(sel => sel.type === "waterbox")
        .forEach(sel => removeWaterboxMarker(sel, scene));
    
    // Triangles
    selectedTriangles.forEach(sel => {
        const markerName = `selectionMarker_${sel.modelName}_${sel.index}`;
        const marker = scene.getObjectByName(markerName);
        if (marker) {
            scene.remove(marker);
            if (marker.geometry) marker.geometry.dispose();
            if (marker.material) marker.material.dispose();
        }
    });
    selectedTriangles.length = 0;

    // Points
    selectedPoints.forEach(p => removePointMarker(p, scene));
    selectedPoints.length = 0;
    
    // Edges
    selectedEdges.forEach(e => removeEdgeMarker(e, scene));
    selectedEdges.length = 0;

    selectionListEl.value = '';
    updateSelectionUI();
}

function addSelectionMarker(tri, scene) {
    const selGeom = new THREE.BufferGeometry();
    const arr = new Float32Array([
        tri.verts[0].x, tri.verts[0].y, tri.verts[0].z,
        tri.verts[1].x, tri.verts[1].y, tri.verts[1].z,
        tri.verts[2].x, tri.verts[2].y, tri.verts[2].z
    ]);
    selGeom.setAttribute('position', new THREE.BufferAttribute(arr, 3));
    selGeom.setIndex([0, 1, 2]);

    // transparent:false (was true) - same fill-rate fix as render.js's base
    // materials: opacity is always 1.0 here (nothing ever animates it), so
    // alpha-blending this was pure overhead - a read-modify-write blend per
    // pixel instead of a plain opaque write, with no early-Z rejection.
    // Costly precisely when the selected triangle is one of the huge ones
    // that fills most of the viewport.
    const selMat = new THREE.MeshBasicMaterial({
        color: 0xffff66,
        side: THREE.DoubleSide,
        transparent: false,
        opacity: 1.0,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -2
    });

    const selMesh = new THREE.Mesh(selGeom, selMat);
    selMesh.name = `selectionMarker_${tri.modelName}_${tri.index}`;
    scene.add(selMesh);
}

function removeSelectionMarker(tri, scene) {
    const markerName = `selectionMarker_${tri.modelName}_${tri.index}`;
    const marker = scene.getObjectByName(markerName);
    if (marker) scene.remove(marker);
}

function addPointMarker(pointObj, scene) {
    const geo = new THREE.SphereGeometry(0.08, 12, 12);
    const mat = new THREE.MeshBasicMaterial({
        color: 0x44ff44,
        transparent: true,
        opacity: 1.0,
        depthTest: false // selection marker should always be visible, never lose a depth-tie
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.copy(pointObj.pos);
    mesh.renderOrder = 9999; // draw after everything, including the biased sampled points (renderOrder 1001)
    mesh.name = `pointMarker_${pointObj.modelName}_${pointObj.index}_${pointObj.vertex}`;
    scene.add(mesh);
}

function removePointMarker(pointObj, scene) {
    const name = `pointMarker_${pointObj.modelName}_${pointObj.index}_${pointObj.vertex}`;
    const m = scene.getObjectByName(name);
    if (m) {
        scene.remove(m);
        m.geometry.dispose();
        m.material.dispose();
    }
}

function addEdgeMarker(edge, scene) {
    const geom = new THREE.BufferGeometry();
    geom.setAttribute('position', new THREE.Float32BufferAttribute([
        edge.a.x, edge.a.y, edge.a.z,
        edge.b.x, edge.b.y, edge.b.z
    ], 3));

    const mat = new THREE.LineBasicMaterial({
        color: 0xffff00,
        linewidth: 3
    });

    const line = new THREE.LineSegments(geom, mat);
    line.name = `edgeMarker_${edge.modelName}_${edge.index}`;
    scene.add(line);
}

function removeEdgeMarker(edge, scene) {
    const name = `edgeMarker_${edge.modelName}_${edge.index}`;
    const m = scene.getObjectByName(name);
    if (m) {
        scene.remove(m);
        m.geometry.dispose();
        m.material.dispose();
    }
}

// Draw a yellow cube to highlight a whole waterbox
function addWaterboxMarker(sel, scene) {
    const b = sel.bbox;

    const w = b.xMax - b.xMin;
    const h = b.yMax - b.yMin;
    const d = b.zMax - b.zMin;

    const cx = (b.xMin + b.xMax) / 2;
    const cy = (b.yMin + b.yMax) / 2;
    const cz = (b.zMin + b.zMax) / 2;

    const geom = new THREE.BoxGeometry(w, h, d);
    const mat = new THREE.MeshBasicMaterial({
        color: 0xffff66,
        transparent: true,
        opacity: 0.35,
        depthTest: false,
        depthWrite: false
    });

    const mesh = new THREE.Mesh(geom, mat);
    mesh.position.set(cx, cy, cz);

    mesh.name = `waterboxMarker_${sel.modelName}_${sel.index}`;
    scene.add(mesh);
}

function removeWaterboxMarker(sel, scene) {
    const name = `waterboxMarker_${sel.modelName}_${sel.index}`;
    const m = scene.getObjectByName(name);
    if (m) {
        scene.remove(m);
        if (m.geometry) m.geometry.dispose();
        if (m.material) m.material.dispose();
    }
}

// Handle triangle/point selection
export function performSelection(ev, renderer, camera, scene) {
    if (!loadedModels.length) return;

    if (document.pointerLockElement === renderer.domElement) {
        mouse.x = 0;
        mouse.y = 0;
    } else {
        const rect = renderer.domElement.getBoundingClientRect();
        const x = ev.clientX - rect.left;
        const y = ev.clientY - rect.top;
        mouse.x = (x / rect.width) * 2 - 1;
        mouse.y = -(y / rect.height) * 2 + 1;
    }

    raycaster.setFromCamera(mouse, camera);
    
    // ----- POINT SELECTION PASS -----
    // Collect every visible vertex of every model
    const pointHits = [];

    for (const m of loadedModels) {
        if (!m.mesh || !m.mesh.visible) continue;

        if (m.mesh.geometry === undefined)
            continue;
        const geom = m.mesh.geometry;
        const pos = geom.attributes.position;

        for (let i = 0; i < pos.count; i++) {
            const v = new THREE.Vector3().fromBufferAttribute(pos, i);
            const worldV = m.mesh.localToWorld(v);

            const dist = raycaster.ray.distanceToPoint(worldV);
            if (dist < 0.1) {   // clickable radius
                pointHits.push({
                    modelName: m.mesh.name,
                    index: i,
                    pos: worldV
                });
            }
        }
    }

    if (pointHits.length > 0) {
        const p = pointHits[0]; // nearest

        // If exists, unselect
        const idx = selectedPoints.findIndex(
            q => q.modelName === p.modelName && q.index === p.index
        );

        if (idx !== -1) {
            removePointMarker(selectedPoints[idx], scene);
            selectedPoints.splice(idx, 1);
        } else {
            if (!multiSelectCheckbox.checked)
                clearSelection(scene);
            selectedPoints.push(p);
            addPointMarker(p, scene);
        }

        updateSelectionUI();
        return; // prevents triangle selection
    }
    // ----- END POINT PASS -----
    
    // ----- EDGE SELECTION PASS -----
    const edgeHits = [];
    const edgeThreshold = 0.08;

    for (const m of loadedModels) {
        // Only allow edge selection on models that explicitly opt in (e.g.
        // "Seams Model", "Subdivision Grid", and the "Subdivision" cell's
        // cube outline). Everything else's m.edges is just the wireframe
        // overlay of its triangle mesh, and triangle selection already
        // covers those (edge-picking every wireframe line on top of that
        // would make triangle clicks unreliable).
        if (!m.edgeSelectable || !m.edges || !m.edges.visible) continue;
        // m.edges.visible is the edge object's OWN flag, which doesn't
        // account for a parent group being hidden (e.g. Subdivision's cube
        // outline is a child of the group the checkbox actually toggles) -
        // check that too so a hidden model's edges aren't still pickable.
        if (m.mesh && !m.mesh.visible) continue;

        const pos = m.edges.geometry.attributes.position;

        for (let i = 0; i < pos.count; i += 2) {
            const a = new THREE.Vector3().fromBufferAttribute(pos, i);
            const b = new THREE.Vector3().fromBufferAttribute(pos, i + 1);

            m.edges.localToWorld(a);
            m.edges.localToWorld(b);

            const dist = raycaster.ray.distanceSqToSegment(
                a, b, null, null
            );

            if (dist < edgeThreshold * edgeThreshold) {
                edgeHits.push({
                    modelName: m.edges.name || m.name,
                    index: i / 2,
                    a, b
                });
            }
        }
    }

    if (edgeHits.length > 0) {
        const e = edgeHits[0];

        const idx = selectedEdges.findIndex(
            x => x.modelName === e.modelName && x.index === e.index
        );

        if (idx !== -1) {
            removeEdgeMarker(selectedEdges[idx], scene);
            selectedEdges.splice(idx, 1);
        } else {
            if (!multiSelectCheckbox.checked)
                clearSelection(scene);
            selectedEdges.push(e);
            addEdgeMarker(e, scene);
        }

        updateSelectionUI();
        return;
    }
    // ----- END EDGE PASS -----
    
    const visibleMeshes = loadedModels
        .filter(m => m.mesh && m.mesh.visible)
        .map(m => m.mesh);

    const inter = raycaster.intersectObjects(visibleMeshes, true);
    
    //console.log("intersected:", inter.map(x => x.object.name));
    if (inter.length === 0) {
        clearSelection(scene);
        updateSelectionUI();
        return;
    }
    
    /////////////////////////////////////////////////////////
    // ---- WATERBOX SELECTION PASS (BEFORE TRIANGLES) ----
    /////////////////////////////////////////////////////////

    // Find hit on any waterbox model
    let wbHit = null;
    for (const i of inter) {
        if (i.object.userData && i.object.userData.waterboxes) {
            wbHit = i;
            break;
        }
    }

    if (wbHit) {
        const model = wbHit.object;
        const wbList = model.userData.waterboxes;
        const tri = wbHit.faceIndex;

        // Find which waterbox contains this triangle
        const cubeIndex = wbList.findIndex(
            w => tri >= w.startTri && tri <= w.endTri
        );

        // should never happen, but safety check
        if (cubeIndex < 0) {
            console.warn("Waterbox hit but no cube matched faceIndex", tri);
            return;
        }

        const wbMeta = wbList[cubeIndex];

        // If single-select, clear old
        if (!multiSelectCheckbox.checked)
            clearSelection(scene);

        // Check if already selected
        const exists = selectedTriangles.find(x =>
            x.modelName === model.name &&
            x.type === "waterbox" &&
            x.index === cubeIndex
        );

        if (exists) {
            removeWaterboxMarker(exists, scene);
            selectedTriangles = selectedTriangles.filter(
                x => !(x.modelName === model.name && x.index === cubeIndex)
            );
            updateSelectionUI();
            return;
        }

        // Build your selection object
        const sel = {
            type: "waterbox",
            modelName: model.name,
            index: cubeIndex,
            waterbox: wbMeta.waterbox,
            bbox: wbMeta.bbox
        };

        selectedTriangles.push(sel);

        addWaterboxMarker(sel, scene);
        updateSelectionUI();

        return; // stop here so triangles don't get selected
    }
    /////////////////////////////////////////////////////////

    /////////////////////////////////////
    // ---- TRIANGLE SELECTION PASS  ----
    /////////////////////////////////////

    removeAllSampledPoints(scene);

    // The DOM-click-based removal above isn't reliable for every model
    // name (ExcludedPoints in particular doesn't reliably get cleared by
    // it - likely because it has no corresponding UI list entry for that
    // mechanism to find and click), so also remove both directly here.
    // Doing this unconditionally at the top of the triangle pass (rather
    // than only when a new upward-facing triangle gets selected below)
    // ensures stale points don't linger if the next click misses, hits a
    // non-upward-facing triangle, or hits nothing at all.
    for (const name of ["Points", "ExcludedPoints"]) {
        const existingIndex = loadedModels.findIndex(m => m.name === name);
        if (existingIndex !== -1) {
            const existing = loadedModels[existingIndex];
            if (existing && existing.mesh) {
                scene.remove(existing.mesh);
                if (existing.mesh.geometry) existing.mesh.geometry.dispose();
                if (existing.mesh.material) existing.mesh.material.dispose();
            }
            loadedModels.splice(existingIndex, 1);
        }
    }

    let hit = null;
    for (const i of inter) {
        if (i.face && i.object.visible) {
            hit = i;
            break;
        }
    }

    if (!hit) {
        clearSelection(scene);
        updateSelectionUI();
        return;
    }

    const face = hit.face;
    const geom = hit.object.geometry;
    const pos = geom.attributes.position;
    const a = face.a, b = face.b, c = face.c;
    const va = new THREE.Vector3().fromBufferAttribute(pos, a);
    const vb = new THREE.Vector3().fromBufferAttribute(pos, b);
    const vc = new THREE.Vector3().fromBufferAttribute(pos, c);

    // Convert from mesh-local space to world space
    hit.object.localToWorld(va);
    hit.object.localToWorld(vb);
    hit.object.localToWorld(vc);

    const triIndex = Math.floor(hit.faceIndex);

    // Retrieve metadata stored on the mesh
    let meta = null;
    if (hit.object.userData.triangles && hit.object.userData.triangles[triIndex]) {
        meta = hit.object.userData.triangles[triIndex];
    }

    const newTri = {
        id: meta ? meta.id : null,
        index: triIndex,
        verts: [va, vb, vc],
        modelName: hit.object.name,

        // include metadata if available:
        normals: meta ? meta.normals : null,
        dist: meta ? meta.d : null,
        xpFlags: meta ? meta.xpFlags : null,
        flags: meta ? meta.flags : null
    };

    // Check if triangle is already selected (match by index + modelName)
    const existingIndex = selectedTriangles.findIndex(
        t => t.index === newTri.index && t.modelName === newTri.modelName
    );

    if (existingIndex !== -1) {
        // It's already selected → remove it
        selectedTriangles.splice(existingIndex, 1);
        updateSelectionUI();
        removeSelectionMarker(newTri, scene);
        return;
    }

    // If single-select mode is active, clear previous selections
    if (!multiSelectCheckbox.checked) {
        clearSelection(scene);
    }

    selectedTriangles.push(newTri);
    addSelectionMarker(newTri, scene);
    updateSelectionUI();
        
    // Create a sampled standable points model for the selected triangle

    const sample_tri = [{
        id: meta ? meta.id : null,
        vtxs: [
            va.clone(),
            vb.clone(),
            vc.clone()
        ],
        normals: meta ? meta.normals : null,
        d: meta ? meta.d : null,
        xpFlags: meta ? meta.xpFlags : null,
        flags: meta ? meta.flags : null
    }];
    
    let pts = null;
    if ((game == "OOT" || game == "MM" || game == "OOT3D" || game == "MM3D") && samplePointsEnabled && meta) {
        // Check if the triangle faces upward (normal points up)
        if (sample_tri[0].normals && sample_tri[0].normals[1] > f32(0.0) && !isZero(sample_tri[0].normals[1])) {
            // Draw new points
            const isDynaPoly = !!hit.object.userData.dynaPolyActor;

            // isDynaPoly also selects the floor check's determinant tolerance:
            // the game runs dynapoly floors through
            // CollisionPoly_CheckYIntersectApprox1 (detMax 300) but static
            // floors through CollisionPoly_CheckYIntersect (detMax 0), so a
            // dynapoly's standable region reaches further past its edges.
            pts = drawSampledTriangles(
                scene,
                sample_tri,
                Number(samplePointsResolution.value),
                isDynaPoly ? null : currentColCtx,
                isDynaPoly
            );
        }
    }
    
    return pts;
}
