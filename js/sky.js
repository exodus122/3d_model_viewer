import * as THREE from 'three';
import { addModelCheckbox } from './render.js';
import { buildTexturedParts, makeTexturedMesh, isTexturedMode } from './bk_textured.js';
import { loadDK64Texture } from './dk64_map.js';

////////////////////////////////////////
// System: Banjo-Kazooie / Banjo-Tooie skyboxes
////////////////////////////////////////
//
// A BK map's sky is up to three model assets (core2/gc/sky.c, D_8036BD40)
// that sky_draw renders first each frame, centred on the camera, before the
// map: a sky dome and, for some maps, one or two cloud layers that spin about
// the camera at rotation_speed degrees per second. Nothing about the sky is
// depth-buffered (sky_draw leaves modelRender in MODEL_RENDER_DEPTH_NONE),
// so the layers simply paint over each other in list order and the map
// paints over them all. The models are tiny -- Freezeezy Peak's dome is 22
// units across -- which never shows because a dome centred on the camera
// looks the same at any size.
//
// BT keeps the scheme with up to two layers: the gcskyDll overlay's table
// (BT_Skies in bt_object_list.js, generated from the ROM) names each map's
// layers with the same model / scale / rotation-speed fields, and core2's
// draw (0x800BFD6C) puts them at the camera, rotated speed * seconds about
// y, before the map, with the near / far planes reset around the model's
// bounds. Its models are full-sized (thousands of units), which changes
// nothing for a camera-centred dome.
//
// The viewer does the same for both: the layers live in their own scene,
// drawn as a separate pass before the main scene with the depth test and
// depth write off, centred on the camera and turned by the clock. (A
// separate pass rather than a render order because three.js draws every
// blended material after every opaque one, which would put a cloud layer
// over the map.) The "Skybox" row in the sidebar is an empty group in the
// main scene that only carries the checkbox; the sky is shown in the
// textured views only.

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

// Sky tables by game; BT's is generated into bt_object_list.js.
const SKIES = { BK: BK_Skies, BT: typeof BT_Skies !== 'undefined' ? BT_Skies : {} };

async function loadSkyModel(game, assetId) {
    const file = assetId.toString(16).toUpperCase().padStart(4, '0') + '.model.bin';
    const res = await fetch(`./models/${game}/props/` + file);
    if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
    return buildTexturedParts(await res.arrayBuffer(), 0, { game });
}

/**
 * Add the map's sky layers to the scene as one "Skybox" row. Resolves once
 * the models are loaded; maps without a sky add nothing. For BT the texture
 * bank must already be loaded (bt_textures.js).
 */
export async function renderSky(scene, game, mapId) {
    clearSky();
    const list = SKIES[game]?.[mapId];
    if (!list) return;

    const row = new THREE.Group();
    row.name = 'Skybox';
    const entries = [];

    const parts = await Promise.all(list.map(layer => loadSkyModel(game, layer.model).catch(err => {
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

////////////////////////////////////////
// System: Donkey Kong 64 skies
////////////////////////////////////////
//
// DK64 has no sky models. global_asm func_80707980 picks a background per map
// (and, in a few maps, per chunk -- the viewer uses the outdoor one):
//   - most maps: a black fill;
//   - a gradient (func_80704B20): an 8-vertex strip of four colour rows
//     (DK64_Sky_Gradients, from the ROM) drawn in screen space, moved
//     300 * sin(camera pitch) (and, for gradient 5, by 0.08 * camera height
//     - 75) -- so looking at elevation e shows the strip at row
//     456 - 300 sin(e) - that shift. The viewer colours a camera-centred
//     sphere that way;
//   - a moon (func_80705F5C, HUD image 0x35) in the direction
//     (sin a, h - 8 * camera height, cos a) * 32767-ish units;
//   - a 320x240 backdrop image tiled around the view (func_807069A4: the
//     beetle race's and the mazes' / Stealthy Snoop's walls);
//   - a flat colour (two maps).
// The sun some maps add (func_80705C00 -> func_8070033C) is not drawn.
const DK64_MAZES = ['KROOL_BARREL_LANKY_MAZE', 'STEALTHY_SNOOP_NORMAL_NO_LOGO', 'STEALTHY_SNOOP_NORMAL',
    'MAD_MAZE_MAUL_HARD', 'STASH_SNATCH_NORMAL', 'MAD_MAZE_MAUL_EASY', 'MAD_MAZE_MAUL_NORMAL', 'STASH_SNATCH_EASY',
    'STASH_SNATCH_HARD', 'MAD_MAZE_MAUL_INSANE', 'STASH_SNATCH_INSANE', 'STEALTHY_SNOOP_VERY_EASY',
    'STEALTHY_SNOOP_EASY', 'STEALTHY_SNOOP_HARD'];
const DK64_Skies = {
    AZTEC: { gradient: 0 },
    GALLEON: { gradient: 0 },
    GALLEON_SEAL_RACE: { gradient: 0 },
    JAPES: { gradient: 4 },
    JAPES_ARMY_DILLO: { gradient: 3, moon: [0, 0x7D00] },
    FUNGI: { gradient: 2, moon: [0, 0x5DC0] },
    FUNGI_MINECART: { gradient: 1 },
    DK_ISLES_OVERWORLD: { gradient: 5 },
    DK_ISLES_DK_THEATRE: { gradient: 5 },
    ROCK_INTRO_STORY: { gradient: 5 },
    GALLEON_PUFFTOSS: { gradient: 6, moon: [0xC8, 0x4268] },
    CASTLE: { gradient: 6, moon: [0x3E8, 0x2EE0] },
    KLUMSY_ENDING: { gradient: 7 },
    MAIN_MENU: { gradient: 7, moon: [0xC8, 0x2EE0] },
    BLOOPERS_ENDING: { fill: 0xffffff },
    GALLEON_BARREL_BLAST: { fill: 0xffff84 },        // fill colour 0xFFC1 (RGBA5551)
    AZTEC_BEETLE_RACE: { backdrop: 'T14_002D', tint: 1 },
    ...Object.fromEntries(DK64_MAZES.map(name => [name, { backdrop: 'T14_002E', tint: 0x3F / 255 }])),
};

const SKY_RADIUS = 1000;
const skySphere = new THREE.SphereGeometry(SKY_RADIUS, 48, 24);

const skyVertexShader = `
    varying vec3 vDir;
    void main() {
        vDir = normalize(position);
        gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
    }`;

// Colours are the game's sRGB values, written as they are.
function dk64GradientMaterial(gradient) {
    const c = gradient.colors.map(hex => new THREE.Vector3(...[0, 2, 4].map(i => parseInt(hex.substr(i, 2), 16) / 255)));
    return new THREE.ShaderMaterial({
        uniforms: {
            rows: { value: new THREE.Vector4(...gradient.rows) },
            c0: { value: c[0] }, c1: { value: c[1] }, c2: { value: c[2] }, c3: { value: c[3] },
            shift: { value: 0 },
        },
        vertexShader: skyVertexShader,
        fragmentShader: `
            uniform vec4 rows; uniform vec3 c0, c1, c2, c3; uniform float shift;
            varying vec3 vDir;
            void main() {
                float r = 456.0 - 300.0 * normalize(vDir).y - shift;
                vec3 col = r <= rows.y ? mix(c0, c1, clamp((r - rows.x) / (rows.y - rows.x), 0.0, 1.0))
                         : r <= rows.z ? mix(c1, c2, (r - rows.y) / max(rows.z - rows.y, 1.0))
                         :               mix(c2, c3, clamp((r - rows.z) / (rows.w - rows.z), 0.0, 1.0));
                gl_FragColor = vec4(col, 1.0);
            }`,
        side: THREE.BackSide, depthTest: false, depthWrite: false,
    });
}

function dk64BackdropMaterial(texture, tint) {
    texture.wrapS = texture.wrapT = THREE.RepeatWrapping;
    // sampled and written as the game's sRGB values, like the gradient colours
    texture.colorSpace = THREE.NoColorSpace;
    texture.needsUpdate = true;
    return new THREE.ShaderMaterial({
        uniforms: { map: { value: texture }, tint: { value: tint } },
        vertexShader: skyVertexShader,
        fragmentShader: `
            uniform sampler2D map; uniform float tint;
            varying vec3 vDir;
            void main() {
                vec3 d = normalize(vDir);
                // four images around, about two from the horizon up or down
                vec2 uv = vec2(atan(d.x, d.z) / 6.2831853 * 4.0, 1.0 - asin(d.y) / 1.5707963 * 2.0);
                gl_FragColor = vec4(texture2D(map, uv).rgb * tint, 1.0);
            }`,
        side: THREE.BackSide, depthTest: false, depthWrite: false,
    });
}

// The moon's apparent size: the game draws the 64x64 image at 4x (64 pixels of
// a 320-wide screen), about 10 degrees.
const MOON_ANGLE = THREE.MathUtils.degToRad(10);

/** Add a DK64 map's sky (see above) as the "Skybox" row. Maps with a black fill add nothing. */
export async function renderDK64Sky(scene, mapName) {
    clearSky();
    const spec = DK64_Skies[mapName];
    if (!spec) return;
    const entries = [];
    if (spec.gradient !== undefined) {
        const gradient = DK64_Sky_Gradients[spec.gradient];
        const material = dk64GradientMaterial(gradient);
        const mesh = new THREE.Mesh(skySphere, material);
        mesh.frustumCulled = false;
        entries.push({ mesh, speed: 0, update: camera => {
            mesh.position.copy(camera.position);
            material.uniforms.shift.value = spec.gradient === 5 ? 0.08 * camera.position.y - 75 : 0;
        } });
    } else if (spec.fill !== undefined) {
        const mesh = new THREE.Mesh(skySphere, new THREE.MeshBasicMaterial({
            color: spec.fill, side: THREE.BackSide, depthTest: false, depthWrite: false }));
        mesh.frustumCulled = false;
        entries.push({ mesh, speed: 0 });
    } else if (spec.backdrop) {
        const texture = await loadDK64Texture(spec.backdrop, { width: 320, height: 240, fmt: 0, siz: 2 });
        if (texture) {
            const mesh = new THREE.Mesh(skySphere, dk64BackdropMaterial(texture, spec.tint));
            mesh.frustumCulled = false;
            entries.push({ mesh, speed: 0 });
        }
    }
    if (spec.moon) {
        const texture = await loadDK64Texture('T14_0035', { width: 64, height: 64, fmt: 3, siz: 1 });
        if (texture) {
            const moon = new THREE.Sprite(new THREE.SpriteMaterial({ map: texture, depthTest: false, depthWrite: false }));
            moon.renderOrder = 1;
            moon.scale.setScalar(2 * SKY_RADIUS * 0.9 * Math.tan(MOON_ANGLE / 2));
            const [angle, height] = spec.moon;
            const a = angle / 4096 * Math.PI * 2;
            entries.push({ mesh: moon, speed: 0, update: camera => {
                const dir = new THREE.Vector3(Math.sin(a) * 32767, height - 8 * camera.position.y, Math.cos(a) * 32767).normalize();
                moon.position.copy(camera.position).addScaledVector(dir, SKY_RADIUS * 0.9);
            } });
        }
    }
    if (!entries.length) return;
    for (const { mesh } of entries) skyScene.add(mesh);
    const row = new THREE.Group();
    row.name = 'Skybox';
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
export function drawSky(renderer, scene, camera, seconds) {
    if (!currentSky || !currentSky.row.parent || !currentSky.row.visible || !isTexturedMode()) return null;
    for (const { mesh, speed, update } of currentSky.entries) {
        if (update) { update(camera); continue; }   // DK64's camera-dependent layers
        mesh.position.copy(camera.position);
        if (speed) mesh.rotation.y = THREE.MathUtils.degToRad(speed * seconds); // sky_update's timer (BT: D_80128770+0x134)
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
