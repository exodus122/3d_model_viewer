import * as THREE from 'three';
import { addModelCheckbox } from './render.js';
import { buildTexturedParts, makeTexturedMesh, isTexturedMode } from './bk_textured.js';

////////////////////////////////////////
// System: Banjo-Kazooie skyboxes
////////////////////////////////////////
//
// A map's sky is up to three model assets (core2/gc/sky.c, D_8036BD40) that
// sky_draw renders first each frame, centred on the camera, before the map:
// a sky dome and, for some maps, one or two cloud layers that spin about the
// camera at rotation_speed degrees per second. Nothing about the sky is
// depth-buffered (sky_draw leaves modelRender in MODEL_RENDER_DEPTH_NONE),
// so the layers simply paint over each other in list order and the map
// paints over them all. The models are tiny -- Freezeezy Peak's dome is 22
// units across -- which never shows because a dome centred on the camera
// looks the same at any size.
//
// The viewer does the same: the layers live in their own scene, drawn as a
// separate pass before the main scene with the depth test and depth write
// off, centred on the camera and turned by the clock. (A separate pass
// rather than a render order because three.js draws every blended material
// after every opaque one, which would put a cloud layer over the map.) The
// "Skybox" row in the sidebar is an empty group in the main scene that only
// carries the checkbox; the sky is shown in the textured views only.

const PROP_MODEL_DIR = './models/BK/props/';

// map id -> [{ model, scale, speed }]  (asset id, uniform scale, deg/s)
const BK_Skies = {
    0x01: [{ model: 0x7C4, scale: 1, speed: 0 }],                                             // SM_SPIRAL_MOUNTAIN
    0x02: [{ model: 0x7BD, scale: 1, speed: 0 }, { model: 0x7BE, scale: 1, speed: 1 }],       // MM_MUMBOS_MOUNTAIN
    0x03: [{ model: 0x7BF, scale: 1, speed: 0 }, { model: 0x7C0, scale: 2, speed: 0.5 }],     // STUB_TEST_TEMPLE
    0x07: [{ model: 0x7BF, scale: 1, speed: 0 }, { model: 0x7C0, scale: 2, speed: 0.5 }],     // TTC_TREASURE_TROVE_COVE
    0x0C: [{ model: 0x7BD, scale: 1, speed: 0.5 }],                                           // MM_TICKERS_TOWER
    0x12: [{ model: 0x7C1, scale: 1, speed: 0 }],                                             // GV_GOBIS_VALLEY
    0x1B: [{ model: 0x7C2, scale: 1, speed: 0 }, { model: 0x7C3, scale: 1, speed: 0 }],       // MMM_MAD_MONSTER_MANSION
    0x1F: [{ model: 0x7C9, scale: 1, speed: 0 }],                                             // CS_START_RAREWARE
    0x20: [{ model: 0x7CD, scale: 1, speed: 0 }],                                             // CS_END_NOT_100
    0x27: [{ model: 0x7C6, scale: 1, speed: 1 }, { model: 0x7C7, scale: 1, speed: 1.5 }, { model: 0x7C8, scale: 1, speed: 3 }], // FP_FREEZEEZY_PEAK
    0x31: [{ model: 0x7C5, scale: 1, speed: 0 }],                                             // RBB_RUSTY_BUCKET_BAY
    0x75: [{ model: 0x7CB, scale: 1, speed: 0.5 }, { model: 0x7CA, scale: 1, speed: 6 }],     // GL_MMM_LOBBY
    0x7D: [{ model: 0x7C4, scale: 1, speed: 0 }],                                             // CS_SPIRAL_MOUNTAIN_1
    0x85: [{ model: 0x7C4, scale: 1, speed: 0 }],                                             // CS_SPIRAL_MOUNTAIN_3
    0x86: [{ model: 0x7C4, scale: 1, speed: 0 }],                                             // CS_SPIRAL_MOUNTAIN_4
    0x87: [{ model: 0x7CC, scale: 1, speed: 0 }],                                             // CS_SPIRAL_MOUNTAIN_5 (Grunty's fall)
    0x88: [{ model: 0x7C4, scale: 1, speed: 0 }],                                             // CS_SPIRAL_MOUNTAIN_6
    0x89: [{ model: 0x7C4, scale: 1, speed: 0 }],                                             // CS_INTRO_BANJOS_HOUSE_2
    0x8C: [{ model: 0x7C4, scale: 1, speed: 0 }],                                             // SM_BANJOS_HOUSE
    0x94: [{ model: 0x7C4, scale: 1, speed: 0 }],                                             // CS_INTRO_SPIRAL_7
    0x95: [{ model: 0x7CD, scale: 1, speed: 0 }],                                             // CS_END_ALL_100
    0x96: [{ model: 0x7CD, scale: 1, speed: 0 }],                                             // CS_END_BEACH_1
    0x97: [{ model: 0x7CD, scale: 1, speed: 0 }],                                             // CS_END_BEACH_2
    0x98: [{ model: 0x7C4, scale: 1, speed: 0 }],                                             // CS_END_SPIRAL_MOUNTAIN_1
    0x99: [{ model: 0x7C4, scale: 1, speed: 0 }],                                             // CS_END_SPIRAL_MOUNTAIN_2
};

const skyScene = new THREE.Scene();

// The current map's sky: { row: Group (the checkbox's object in the main
// scene), entries: [{ mesh, speed }] (in skyScene) }. One at a time;
// clearAllModels drops the row, which retires the sky.
let currentSky = null;

function clearSky() {
    if (currentSky) {
        for (const { mesh } of currentSky.entries) skyScene.remove(mesh);
        currentSky = null;
    }
}

async function loadSkyModel(assetId) {
    const file = assetId.toString(16).toUpperCase().padStart(4, '0') + '.model.bin';
    const res = await fetch(PROP_MODEL_DIR + file);
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return buildTexturedParts(await res.arrayBuffer());
}

/**
 * Add the map's sky layers to the scene as one "Skybox" row. Resolves once
 * the models are loaded; maps without a sky add nothing.
 */
export async function renderBKSky(scene, mapId) {
    clearSky();
    const list = BK_Skies[mapId];
    if (!list) return;

    const row = new THREE.Group();
    row.name = 'Skybox';
    const entries = [];

    const parts = await Promise.all(list.map(layer => loadSkyModel(layer.model).catch(err => {
        console.warn(`sky model ${layer.model.toString(16)}: ${err.message}`);
        return null;
    })));
    for (let i = 0; i < list.length; i++) {
        if (!parts[i]) continue;
        const layer = list[i];
        const mesh = makeTexturedMesh(parts[i]);
        mesh.visible = true;
        mesh.scale.setScalar(layer.scale);
        mesh.renderOrder = i; // list order, like sky_draw
        mesh.frustumCulled = false;
        for (const material of mesh.material) {
            material.depthTest = false;
            material.depthWrite = false;
        }
        skyScene.add(mesh);
        entries.push({ mesh, speed: layer.speed });
    }
    if (!entries.length) return;

    scene.add(row);
    loadedModels.push({ name: row.name, root: row, mesh: row, edges: null });
    addModelCheckbox(scene, row.name, row, null, false, true, null, false, false);
    currentSky = { row, entries };
}

/**
 * Draw the sky as its own pass, clearing the frame first, and set the
 * renderer up so the main scene draws over it without clearing. Returns a
 * function to call once the main scene is rendered, or null when there is
 * no sky to draw (and nothing was touched).
 */
export function drawBKSky(renderer, scene, camera, seconds) {
    if (!currentSky || !currentSky.row.parent || !currentSky.row.visible || !isTexturedMode()) return null;
    for (const { mesh, speed } of currentSky.entries) {
        mesh.position.copy(camera.position);
        if (speed) mesh.rotation.y = THREE.MathUtils.degToRad(speed * seconds); // sky_update's timer
    }
    // Where no layer covers, the game shows the black rectangle sky_draw
    // draws first; the viewer keeps its own background there.
    const background = scene.background;
    renderer.setClearColor(background);
    renderer.clear();
    renderer.render(skyScene, camera);
    // A scene with a colour background is cleared even with autoClear off,
    // so the background comes off for the main pass.
    renderer.autoClear = false;
    scene.background = null;
    return () => {
        renderer.autoClear = true;
        scene.background = background;
    };
}
