import * as THREE from 'three';
import { drawSampledTriangles } from './sample_points.js';

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
function updateSelectionUI() {
    function formatNumber(v) {
        return (v % 1 === 0) ? v.toString() : v.toFixed(7);
    }

    const lines = [];
    
    let sampled_triangles = [];
    for (const t of selectedTriangles) {
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

    const selMat = new THREE.MeshBasicMaterial({
        color: 0xffff66,
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 1.0,
        polygonOffset: true,
        polygonOffsetFactor: -1,
        polygonOffsetUnits: -1
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
        opacity: 1.0
    });
    const mesh = new THREE.Mesh(geo, mat);
    mesh.position.copy(pointObj.pos);
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
        if (!m.edges || !m.edges.visible) continue;

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
    if (inter.length === 0) {
        clearSelection(scene);
        updateSelectionUI();
        return;
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
        
    const sample_tri = [{
        vtxs: [
            va,
            vb,
            vc
        ],
        normals: meta ? meta.normals : null,
        d: meta ? meta.d : null,
        xpFlags: meta ? meta.xpFlags : null,
        flags: meta ? meta.flags : null
    }];
    
    let pts = null
    if ((game == "OOT" || game == "MM" || game == "OOT3D" || game == "MM3D") && samplePointsEnabled && meta) {
        // --- AUTO-DELETE OLD POINTS MODEL ---
        const existing = loadedModels.find(m => m.name === "Points");
        if (existing) {
            // Find the UI container for this model and click its delete button.
            const section = document.querySelector('.controls');
            const children = Array.from(section.children);

            for (const child of children) {
                if (child.dataset && child.dataset.modelName === "Points") {
                    const delBtn = child.querySelector('.delete-btn');
                    if (delBtn) delBtn.click();
                    break;
                }
            }
        }
        
        if(sample_tri[0].normals[1] > f32(0.0) && !isZero(sample_tri[0].normals[1])) {
            pts = drawSampledTriangles(scene, sample_tri, Number(samplePointsResolution.value))
        }
    }
    
    return pts;
}
