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
// the "View" dropdown swap between the two. Being a child, the textured mesh
// follows the plain mesh's transform, its row checkbox, and selection.
//
// The three views:
//   textured            - textured meshes only
//   textured-collision  - textured meshes, plus each prop's / actor's plain
//                         collision mesh drawn over its textured one, since
//                         the two differ (often a hitbox against the full
//                         model) and seeing both is the point. It is drawn
//                         translucent so the model shows through it, and
//                         depth-tested like everything else, so only the
//                         parts outside the model (and not behind the map)
//                         are visible.
//   collision           - plain meshes only (the flat-colour collision view)
// The map's collision mesh is never drawn over its textured mesh: it would
// cover the textures.

const viewModeSelect = document.getElementById('bkViewMode');
const wireframeCheckbox = document.getElementById('wireframe');

// { plain: Mesh, textured: Object3D, edges: Object3D | null }
const texturedPairs = [];

export function isTexturedMode() {
    return viewModeSelect?.value !== 'collision';
}

/** Props / actors show their collision list rather than their display-list triangles. */
export function isPropCollisionShown() {
    return viewModeSelect?.value !== 'textured';
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
    if (!parts) return null;
    const mesh = makeTexturedMesh(parts);
    // The game draws a map's XLU model last in the frame, after the OPA model
    // and the actors (gsworld_draw). three.js orders blended meshes by their
    // bounding-sphere depth instead, and the OPA model's own blended parts
    // (CCW winter's lake bed under the XLU ice) would draw over the XLU model
    // whenever the camera brings the OPA centre nearer.
    if (options.translucent) mesh.renderOrder = 1;
    return mesh;
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
 *
 * options.appendages: the model's appendage visibility table, for models
 * whose selector-gated parts the game switches itself (map models, see
 * mapAppendageVisibility); overrides `selector`.
 * options.appendageOverrides: a partial table for the parts an actor's draw
 * callback pins (BK_ACTOR_APPENDAGES); the other selectors keep the guess.
 */
export function buildTexturedParts(buffer, selector = 0, options = {}) {
    const translucent = !!options.translucent;
    const parsed = parseBKModelTextured(buffer, selector, {
        appendages: options.appendages,
        appendageOverrides: options.appendageOverrides,
    });
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

// Whether the plain mesh is drawn (see the header).
function plainShown(pair) {
    if (!isTexturedMode()) return true;
    return isPropCollisionShown() && pair.plain.userData.bkProp?.geometrySource === 'collision';
}

// Draw order for overlays (the collision overlay here, actor hitboxes in
// bk_setup.js): after the XLU map (renderOrder 1), so they blend over water
// rather than under it. Still depth-tested, so the map occludes them.
export const OVERLAY_RENDER_ORDER = 2;

function applyTexturedMode(pair) {
    const on = isTexturedMode();
    const shown = plainShown(pair);
    const overlay = on && shown;
    // Hiding the plain mesh's material (not the mesh) keeps its children drawn.
    const plainMaterials = Array.isArray(pair.plain.material) ? pair.plain.material : [pair.plain.material];
    for (const m of plainMaterials) {
        if (!m) continue;
        m.visible = shown;
        m.transparent = overlay;
        m.opacity = overlay ? 0.5 : 1;
    }
    pair.plain.renderOrder = overlay ? OVERLAY_RENDER_ORDER : 0;
    pair.textured.visible = on;
    if (pair.edges) {
        pair.edges.renderOrder = overlay ? OVERLAY_RENDER_ORDER + 1 : 0;
        // A prop instance's row visibility lives on its parent group.
        const rowVisible = pair.plain.visible && (pair.plain.parent ? pair.plain.parent.visible : true);
        pair.edges.visible = shown && rowVisible && wireframeCheckbox.checked;
    }
}

/** Re-apply after the view changed (bk_setup.js calls this after swapping prop geometry). */
export function refreshTexturedMode() {
    for (const pair of texturedPairs) applyTexturedMode(pair);
}

viewModeSelect?.addEventListener('change', refreshTexturedMode);

// The wireframe checkbox and the row / group checkboxes turn edges back on
// through their own handlers in render.js; keep them off for the plain meshes
// that are hidden while textured. Both fire bubbling change events inside
// .controls.
document.querySelector('.controls')?.addEventListener('change', (e) => {
    if (e.target === viewModeSelect || !isTexturedMode()) return;
    for (const pair of texturedPairs) if (pair.edges && !plainShown(pair)) pair.edges.visible = false;
});
