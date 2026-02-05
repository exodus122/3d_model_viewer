import * as THREE from 'three';
import * as BufferGeometryUtils from 'three/addons/utils/BufferGeometryUtils.js';

/**
 * Build a single combined WaterBox model with separate mesh and edges.
 * @param {Array} waterBoxes - list of WaterBox objects
 * @param {boolean} fullDepth - if true, extend waterboxes down to -32000
 * @returns {Object} { mesh: THREE.Mesh, edges: THREE.LineSegments }
 */
export function buildWaterBoxModel(waterBoxes, fullDepth = false) {
    const geometries = [];
    const metadata = [];

    let triOffset = 0;

    waterBoxes.forEach((wb, index) => {
        // determine height based on toggle
        const height = fullDepth ? wb.ySurface + 32000 : wb.ySurface;

        // center needs to adjust
        const cy = fullDepth ? (wb.ySurface - 32000) / 2 : height / 2;
        const cx = wb.xMin + wb.xLength / 2;
        const cz = wb.zMin + wb.zLength / 2;

        const geom = new THREE.BoxGeometry(wb.xLength, height, wb.zLength);
        const triCount = geom.index.count / 3;

        metadata.push({
            index,
            waterbox: wb,
            startTri: triOffset,
            endTri: triOffset + triCount - 1,
            bbox: {
                xMin: wb.xMin,
                xMax: wb.xMin + wb.xLength,
                yMin: fullDepth ? -32000 : 0,
                yMax: wb.ySurface,
                zMin: wb.zMin,
                zMax: wb.zMin + wb.zLength
            }
        });

        triOffset += triCount;

        // position cube
        geom.applyMatrix4(new THREE.Matrix4().makeTranslation(cx, cy, cz));
        geometries.push(geom);
    });

    // merge all waterboxes
    const merged = BufferGeometryUtils.mergeBufferGeometries(geometries, false);

    // ----- Mesh -----
    const mesh = new THREE.Mesh(
        merged,
        new THREE.MeshBasicMaterial({
            color: 0x00FFFF,
            transparent: true,
            opacity: 0.35,
            wireframe: false
        })
    );
    mesh.renderOrder = 1000;
    mesh.name = "WaterboxesMesh";
    mesh.userData.waterboxes = metadata;

    // ----- Edges -----
    const edgesGeom = new THREE.EdgesGeometry(merged);
    const edges = new THREE.LineSegments(
        edgesGeom,
        new THREE.LineBasicMaterial({ color: 0x00FFFF, linewidth: 1 })
    );
    edges.name = "WaterboxesEdges";
    edges.userData.waterboxes = metadata; // same metadata so selection still works

    return { mesh, edges };
}
