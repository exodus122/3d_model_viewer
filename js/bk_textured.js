import * as THREE from 'three';
import { parseBKModelTextured } from './bk_model.js';

////////////////////////////////////////
// System: Banjo-Kazooie textured rendering
////////////////////////////////////////
//
// Every BK map / prop / actor mesh the viewer draws is its collision (or plain
// display-list) geometry in a flat colour. This module builds a second,
// textured mesh for the same model from its display lists and textures
// (parseBKModelTextured), attaches it as a child of the plain mesh, and lets
// the "Textured" checkbox swap between the two. Being a child, the textured
// mesh follows the plain mesh's transform, its row checkbox, and selection.

const texturedCheckbox = document.getElementById('bkTextured');
const wireframeCheckbox = document.getElementById('wireframe');

// { plain: Mesh, textured: Object3D, edges: Object3D | null }
const texturedPairs = [];

export function isTexturedMode() {
    return !!texturedCheckbox?.checked;
}

function wrapMode(bits) {
    if (bits & 2) return THREE.ClampToEdgeWrapping;
    if (bits & 1) return THREE.MirroredRepeatWrapping;
    return THREE.RepeatWrapping;
}

/**
 * Build a textured Mesh from a decompressed BKModelBin. Returns null for
 * models with no display lists. Geometry and materials are fresh objects; a
 * caller instancing the same model many times should share them via
 * buildTexturedParts().
 */
export function buildTexturedMesh(buffer, options = {}) {
    const parts = buildTexturedParts(buffer, 0, options);
    return parts ? makeTexturedMesh(parts) : null;
}

/**
 * Shared geometry + materials for a model, for instancing.
 *
 * options.translucent: the model is drawn through the game's XLU render
 * modes (a map's XLU model: water, glass, fog planes). Its vertex alpha then
 * sets the opacity and the batches are alpha-blended without depth writes.
 * Opaque models ignore vertex alpha, as the OPA render modes do, and cut out
 * on texture alpha only -- except for the parts a model's own display list
 * switches to an XLU render mode (batch.xlu: shadows, glows, the dark base
 * of Clanker's teeth), which blend the same way the translucent path does.
 */
export function buildTexturedParts(buffer, selector = 0, options = {}) {
    const translucent = !!options.translucent;
    const parsed = parseBKModelTextured(buffer, selector);
    if (!parsed || parsed.batches.length === 0) return null;

    // One DataTexture per (texture, wrap) combination; clones share the image.
    const textureCache = new Map();
    const textureFor = (index, wrapS, wrapT) => {
        const key = index + ':' + wrapS + ':' + wrapT;
        let tex = textureCache.get(key);
        if (!tex) {
            const base = textureCache.get(index + ':0:0');
            const info = parsed.textures[index];
            tex = base ? base.clone() : new THREE.DataTexture(info.rgba, info.width, info.height, THREE.RGBAFormat);
            tex.flipY = false;                 // rows are stored top-first, matching N64 t=0 at the top
            tex.colorSpace = THREE.SRGBColorSpace;
            tex.magFilter = THREE.LinearFilter;
            tex.minFilter = THREE.LinearFilter;
            tex.generateMipmaps = false;
            tex.wrapS = wrapMode(wrapS);
            tex.wrapT = wrapMode(wrapT);
            tex.needsUpdate = true;
            textureCache.set(key, tex);
        }
        return tex;
    };

    const geometry = new THREE.BufferGeometry();
    const positions = [], uvs = [], colors = [];
    const materials = [];
    let start = 0;
    for (const batch of parsed.batches) {
        const count = batch.positions.length / 3;
        positions.push(...batch.positions);
        uvs.push(...batch.uvs);
        const blended = translucent || batch.xlu;
        // colors are rgba; a 4-component colour attribute makes three.js use
        // the vertex alpha, which only the blended batches want -- the rest
        // get alpha 1 so the opaque alphaTest never cuts them out.
        if (blended) {
            colors.push(...batch.colors);
        } else {
            for (let i = 0; i < batch.colors.length; i += 4) colors.push(batch.colors[i], batch.colors[i + 1], batch.colors[i + 2], 1);
        }
        geometry.addGroup(start, count, materials.length);
        start += count;

        // An opaque model's XLU parts still go through the full-depth table
        // (Z_CMP | Z_UPD | G_RM_XLU_SURF2), so they keep writing depth.
        const material = new THREE.MeshBasicMaterial({
            vertexColors: true,
            side: batch.cullBack ? THREE.FrontSide : THREE.DoubleSide,
            transparent: blended,
            depthWrite: !translucent,
            alphaTest: blended ? 0.01 : 0.5,
        });
        if (batch.texture >= 0) {
            material.map = textureFor(batch.texture, batch.wrapS, batch.wrapT);
        }
        materials.push(material);
    }
    geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
    geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
    geometry.setAttribute('color', new THREE.Float32BufferAttribute(colors, 4));

    return { geometry, materials, textureCount: parsed.textures.length, triangleCount: start / 3 };
}

export function makeTexturedMesh(parts) {
    const mesh = new THREE.Mesh(parts.geometry, parts.materials);
    mesh.name = 'textured';
    mesh.visible = isTexturedMode();
    return mesh;
}

/**
 * Attach a textured mesh under its plain counterpart and remember the pair so
 * the checkbox can switch between them. `edges` is the plain mesh's wireframe
 * object (hidden while textured).
 */
export function attachTextured(plain, textured, edges = null) {
    textured.userData.bkInfo = plain.userData.bkInfo;
    textured.userData.bkProp = plain.userData.bkProp;
    plain.add(textured);
    texturedPairs.push({ plain, textured, edges });
    applyTexturedMode(texturedPairs[texturedPairs.length - 1]);
}

export function clearTexturedPairs() {
    texturedPairs.length = 0;
}

function applyTexturedMode(pair) {
    const on = isTexturedMode();
    // Hiding the plain mesh's material (not the mesh) keeps its children drawn.
    const plainMaterials = Array.isArray(pair.plain.material) ? pair.plain.material : [pair.plain.material];
    for (const m of plainMaterials) if (m) m.visible = !on;
    pair.textured.visible = on;
    if (pair.edges) {
        // A prop instance's row visibility lives on its parent group.
        const rowVisible = pair.plain.visible && (pair.plain.parent ? pair.plain.parent.visible : true);
        pair.edges.visible = !on && rowVisible && wireframeCheckbox.checked;
    }
}

texturedCheckbox?.addEventListener('change', () => {
    for (const pair of texturedPairs) applyTexturedMode(pair);
});

// The wireframe checkbox and the row / group checkboxes turn edges back on
// through their own handlers in render.js; keep them off while textured.
// Both fire bubbling change events inside .controls.
document.querySelector('.controls')?.addEventListener('change', (e) => {
    if (e.target === texturedCheckbox || !isTexturedMode()) return;
    for (const pair of texturedPairs) if (pair.edges) pair.edges.visible = false;
});
