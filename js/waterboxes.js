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
        // Determine top and bottom
        const top = wb.ySurface;
        const bottom = fullDepth ? -32000 : Math.min(0, wb.ySurface); // ensures bottom <= top

        // Compute height and center
        const height = top - bottom;
        const cy = (top + bottom) / 2;
        const cx = wb.xMin + wb.xLength / 2;
        const cz = wb.zMin + wb.zLength / 2;

        // Build BoxGeometry
        const geom = new THREE.BoxGeometry(wb.xLength, height, wb.zLength);
        const triCount = geom.index.count / 3;

        // Store per-box metadata
        metadata.push({
            index,
            waterbox: wb,
            startTri: triOffset,
            endTri: triOffset + triCount - 1,
            bbox: {
                xMin: wb.xMin,
                xMax: wb.xMin + wb.xLength,
                yMin: bottom,
                yMax: top,
                zMin: wb.zMin,
                zMax: wb.zMin + wb.zLength
            }
        });
        triOffset += triCount;

        // Position cube at correct center
        geom.applyMatrix4(new THREE.Matrix4().makeTranslation(cx, cy, cz));
        geometries.push(geom);
    });

    // Merge geometries into a single mesh
    const merged = BufferGeometryUtils.mergeBufferGeometries(geometries, false);

    // ----- Mesh -----
    const mesh = new THREE.Mesh(
        merged,
        new THREE.MeshBasicMaterial({
            color: 0x00FFFF,
            transparent: true,
            opacity: 0.35,
            depthWrite: false, // ensures translucency behaves consistently
            wireframe: false
        })
    );
    mesh.renderOrder = 1000; // draw in front
    mesh.name = "WaterboxesMesh";
    mesh.userData.waterboxes = metadata;

    // ----- Edges -----
    const edgesGeom = new THREE.EdgesGeometry(merged);
    const edges = new THREE.LineSegments(
        edgesGeom,
        new THREE.LineBasicMaterial({ color: 0x00FFFF, linewidth: 1 })
    );
    edges.name = "WaterboxesEdges";
    edges.userData.waterboxes = metadata; // same metadata for selection

    return { mesh, edges };
}
