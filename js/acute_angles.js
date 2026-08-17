////////////////////////////////////////
// System: Concave Acute Angle Seams
////////////////////////////////////////

/*
This file contains gap finders between polygons. Not currently working properly.
*/

let acuteAngleEnabled = false;
let acuteAngleMarkers = [];
let acuteAngleFaceMarkers = [];

const ACUTE_MIN_DOT = 0.02;  // > 90°
const ACUTE_MAX_DOT = 0.98;  // < coplanar
const EDGE_BIAS = 0.25;      // for line offset
const GRID_CELL = 500;       // adjust depending on world scale

const acuteAngleColor = 0xff0000; // can be UI controlled

////////////////////////////////////////
// UI hookup
////////////////////////////////////////

const acuteAngleContainer = document.getElementById("acuteAngleContainer");
const acuteAngleCheckbox = document.getElementById("acuteAngleCheckbox");
const acuteAngleColorPicker = document.getElementById("flatGroundColorPicker");

function updateAcuteAngleUIVisibility() {
	if (["OOT","MM","OOT3D","MM3D"].includes(game)) {
		acuteAngleContainer.style.display = "flex";
	} else {
		acuteAngleContainer.style.display = "none";
		clearAcuteAngleMarkers();
	}
}

acuteAngleCheckbox.addEventListener("change", () => {
	acuteAngleEnabled = acuteAngleCheckbox.checked;
	if (acuteAngleEnabled) {
		scanAndBuildAcuteAngleMarkers();
	} else {
		clearAcuteAngleMarkers();
	}
});

////////////////////////////////////////
// Clear markers
////////////////////////////////////////

function clearAcuteAngleMarkers() {
    for (const m of acuteAngleMarkers) {
        scene.remove(m);
        m.geometry.dispose();
        m.material.dispose();
    }
    for (const m of acuteAngleFaceMarkers) {
        scene.remove(m);
        m.geometry.dispose();
        m.material.dispose();
    }
    acuteAngleMarkers.length = 0;
    acuteAngleFaceMarkers.length = 0;
}

////////////////////////////////////////
// Helpers
////////////////////////////////////////

function avgNormal(triA, triB) {
    return triA.normal.clone().add(triB.normal).normalize();
}

function createSeamLine(p0, p1, normal) {
    const geom = new THREE.BufferGeometry().setFromPoints([p0, p1]);
    const mat = new THREE.LineBasicMaterial({
        color: acuteAngleColor,
        depthTest: false,
        depthWrite: false,
        transparent: true,
        opacity: 1.0
    });
    const line = new THREE.Line(geom, mat);
    line.renderOrder = 999;
    scene.add(line);
    acuteAngleMarkers.push(line);
}

function createFaceMarker(verts, color) {
    const geom = new THREE.BufferGeometry();
    const arr = new Float32Array([
        verts[0].x, verts[0].y, verts[0].z,
        verts[1].x, verts[1].y, verts[1].z,
        verts[2].x, verts[2].y, verts[2].z
    ]);
    geom.setAttribute("position", new THREE.BufferAttribute(arr, 3));
    geom.setIndex([0,1,2]);

    const mat = new THREE.MeshBasicMaterial({
        color,
        side: THREE.DoubleSide,
        transparent: true,
        opacity: 0.25,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -2
    });

    const mesh = new THREE.Mesh(geom, mat);
    scene.add(mesh);
    acuteAngleFaceMarkers.push(mesh);
}

// Triangle edges
function triEdges(tri) {
    return [
        [tri.va, tri.vb],
        [tri.vb, tri.vc],
        [tri.vc, tri.va]
    ];
}

function pointToLineDistance(p, a, b) {
    const ab = new THREE.Vector3().subVectors(b, a);
    const ap = new THREE.Vector3().subVectors(p, a);
    const t = ap.dot(ab) / ab.lengthSq();
    const closest = ab.multiplyScalar(t).add(a);
    return closest.distanceTo(p);
}

function furthestVertexFromEdge(tri, edge) {
    const [a, b] = edge;
    let best = tri.va;
    let bestDist = -Infinity;
    for (const v of [tri.va, tri.vb, tri.vc]) {
        const d = pointToLineDistance(v, a, b);
        if (d > bestDist) {
            bestDist = d;
            best = v;
        }
    }
    return best;
}

function isConcave(edge, triA, triB) {
    const [e0, e1] = edge;
    const edgeDir = new THREE.Vector3().subVectors(e1, e0).normalize();
    const testPoint = furthestVertexFromEdge(triB, edge);
    const planeN1 = new THREE.Vector3().crossVectors(edgeDir, triA.normal).normalize();
    const planeN2 = planeN1.clone().negate();
    const v = new THREE.Vector3().subVectors(testPoint, e0);
    return planeN1.dot(v) < 0 || planeN2.dot(v) < 0;
}

function edgeBucketKey(v0, v1, cell = GRID_CELL) {
    const mid = new THREE.Vector3().addVectors(v0, v1).multiplyScalar(0.5);
    return Math.floor(mid.x/cell) + "_" + Math.floor(mid.y/cell) + "_" + Math.floor(mid.z/cell);
}

////////////////////////////////////////
// Plane-plane intersection / triangle clipping
////////////////////////////////////////

function clipLineToTriangle(p0, dir, tri) {
    let tMin = -Infinity, tMax = Infinity;
    const verts = [tri.va, tri.vb, tri.vc];
    for (let i=0;i<3;i++) {
        const a = verts[i];
        const b = verts[(i+1)%3];
        const edge = new THREE.Vector3().subVectors(b, a);
        const edgeNormal = new THREE.Vector3().crossVectors(edge, tri.normal).normalize();
        const denom = edgeNormal.dot(dir);
        const dist = edgeNormal.dot(new THREE.Vector3().subVectors(a, p0));
        if (Math.abs(denom) < 1e-6) {
            if (dist < 0) return null;
        } else {
            const t = dist/denom;
            if (denom > 0) tMax = Math.min(tMax, t);
            else tMin = Math.max(tMin, t);
            if (tMin > tMax) return null;
        }
    }
    return [p0.clone().addScaledVector(dir, tMin), p0.clone().addScaledVector(dir, tMax)];
}

function planePlaneIntersectionSegment(triA, triB) {
    const n1 = triA.normal;
    const n2 = triB.normal;
    const dir = new THREE.Vector3().crossVectors(n1, n2);
    if (dir.lengthSq() < 1e-6) return null;
    dir.normalize();
    const d1 = -n1.dot(triA.va);
    const d2 = -n2.dot(triB.va);
    const n1xn2 = new THREE.Vector3().crossVectors(n1, n2);
    const denom = n1xn2.lengthSq();
    const p0 = new THREE.Vector3()
        .addScaledVector(new THREE.Vector3().crossVectors(n2, n1xn2), d1)
        .addScaledVector(new THREE.Vector3().crossVectors(n1xn2, n1), d2)
        .divideScalar(denom);

    const segA = clipLineToTriangle(p0, dir, triA);
    if (!segA) return null;
    const segB = clipLineToTriangle(p0, dir, triB);
    if (!segB) return null;

    // Return overlapping segment
    const t0 = 0, t1 = 1; // simplified
    return [
        new THREE.Vector3().lerpVectors(segA[0], segA[1], 0.5),
        new THREE.Vector3().lerpVectors(segB[0], segB[1], 0.5)
    ];
}

////////////////////////////////////////
// Main scanning function
////////////////////////////////////////

function scanAndBuildAcuteAngleMarkers() {
    clearAcuteAngleMarkers();
    if (!acuteAngleEnabled) return;

    const triangles = [];

    // collect all triangles
    for (const model of loadedModels) {
        if (!model.mesh || !model.mesh.visible) continue;
        const geom = model.mesh.geometry;
        const pos = geom.attributes.position;
        const index = geom.index;
        for (let i=0;i<index.count;i+=3) {
            const va = new THREE.Vector3().fromBufferAttribute(pos, index.getX(i));
            const vb = new THREE.Vector3().fromBufferAttribute(pos, index.getX(i+1));
            const vc = new THREE.Vector3().fromBufferAttribute(pos, index.getX(i+2));
            const normal = new THREE.Vector3().crossVectors(
                new THREE.Vector3().subVectors(vb, va),
                new THREE.Vector3().subVectors(vc, va)
            ).normalize();
            triangles.push({va,vb,vc,normal});
        }
    }

    // brute-force pair check (you can optimize with a spatial grid)
    for (let i=0;i<triangles.length;i++) {
        for (let j=i+1;j<triangles.length;j++) {
            const triA = triangles[i];
            const triB = triangles[j];

            const dot = triA.normal.dot(triB.normal);
            if (dot <= ACUTE_MIN_DOT || dot >= ACUTE_MAX_DOT) continue;

            // plane-plane intersection
            const segment = planePlaneIntersectionSegment(triA, triB);
            if (!segment) continue;

            const [p0,p1] = segment;

            // concavity check
            const edges = [[p0,p1]];
            let concave = false;
            for (const edge of edges) {
                if (isConcave(edge, triA, triB) || isConcave(edge, triB, triA)) {
                    concave = true; break;
                }
            }
            if (!concave) continue;

            // small offset
            const avgN = avgNormal(triA, triB);
            p0.addScaledVector(avgN, EDGE_BIAS);
            p1.addScaledVector(avgN, EDGE_BIAS);

            createSeamLine(p0, p1, avgN);

            const seamColor = new THREE.Color().setHSL((1-dot)*0.15,1.0,0.5);
            createFaceMarker([triA.va,triA.vb,triA.vc], seamColor);
            createFaceMarker([triB.va,triB.vb,triB.vc], seamColor);
        }
    }
}