////////////////////////////////////////
// Known Issues:
// - none
////////////////////////////////////////

////////////////////////////////////////
// Imports
////////////////////////////////////////

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { PointerLockControls } from 'three/addons/controls/PointerLockControls.js';
import { performSelection, clearSelection, selectHit } from './selection.js';
import { parseModel, parseModelText, parseModelBinary, parseBKModelBinary, parseZeldaSceneBinary, parseInvisibleSeams1D } from './parse_model.js';
import { renderZeldaObjectBinary } from './render_actors.js';
import { renderBKSetup, getPropInstances } from './bk_setup.js';
import { addActorBitclipEdges } from './bitclips.js';
import { renderBTSetup } from './bt_setup.js';
import { renderSky, renderDK64Sky, drawSky } from './sky.js';
import { loadBTModelTextures } from './bt_textures.js';
import { renderZeldaSceneTextured, parseZeldaSceneInfo, zeldaRoomFileName, zeldaAreaTextureFileName, ROOM_GROUP_KEY } from './zelda_textured.js';
import { renderOOTActors } from './oot_actors.js';
import { renderLoadingPlanes3DS } from './loading_planes.js';
import { addModelCheckbox, buildGeometry, buildTest, deferGroupBuild, clearAllModels, getModelGroup, applyGroupMasterState } from './render.js';
import { setupWallPushClipUI } from './wall_push_clips.js';
import { setupBombStacking } from './bomb_stacking.js';
import { installWaterboxDepthToggle } from './waterboxes.js';
import { parseDK64Collision, buildDK64TexturedMesh, buildDK64Water, parseDK64Water, findDK64Ledges, buildDK64LedgeMarker,
         mergeDK64Collision, findDK64SlipperyFloors, buildDK64SlopeMarker } from './dk64_map.js';
import { attachTextured, clearTexturedPairs, registerPlain } from './bk_textured.js';
import { renderDK64Setup, getDK64PropCollisionWorld, parseDK64LedgeScripts } from './dk64_setup.js';
import { buildDK64CrouchGapItems } from './dk64_crouch_gaps.js';
import { parseOCOL, buildOOTSW2Collision, typedMeshList, groupOOTSW2ByActor, buildOOTSW2ObjectPoints, OOTSW2_SCALE, isOOTSW2Terrain, splitSourceByOwner,
         splitSourceByTriangle, describeOOTSW2Surface,
         loadOOTSW2Compound, mergeOOTSW2Compound, buildOOTSW2Mesh, buildOOTSW2Edges, lazyTriangleIds } from './ootsw2_map.js';

import { loadOOTSW2AreaTables, buildOOTSW2Areas, splitMeshList, OOTSW2_AREA_KINDS, OOTSW2_ZONE_COLOR } from './ootsw2_areas.js';
import { loadOOTSW2Voxels, activeVoxelTiles, VoxelSet, buildVoxelPoints, buildVoidMap, buildFloorVoidMap, availableCubeViews,
         VOID_COLORS, VOID_RADIUS } from './ootsw2_voidmap.js';

let ootsw2Airwalls = null;   // models/OOTSW2/airwalls.json, shared by every map
const wireframeOn = () => document.getElementById('wireframe').checked;
const OOTSW2_LINK_COLOR = '#ffd040';
// The "Collision types" checkboxes, kept across map loads
const ootsw2KindShown = { static: true, staticObj: true, ocarina: true, actor: true, hull: true, airwall: true, climbWall: true, pushWall: false,
    detail: false, bakedArea: false,
    zone: true, link: false,
    ...Object.fromEntries(OOTSW2_AREA_KINDS.map(([kind, , , shown]) => [kind, shown])) };

////////////////////////////////////////
// System: DOM / Static UI Elements
////////////////////////////////////////

const mapDropdown = document.getElementById("mapDropdown");
const setupDropdown = document.getElementById("setupDropdown");
const setupDropdownDiv = document.getElementById("setupDropdownDiv");
const actorDropdown = document.getElementById("actorDropdown");
const fileInput = document.getElementById('file');
const loadMapButton = document.getElementById('loadMap');
const loadActorButton = document.getElementById('loadActor');
const gridCheckbox = document.getElementById('grid');
const translucentCheckbox = document.getElementById('translucent');
const opacitySlider = document.getElementById('opacity');
const movementSpeedSlider = document.getElementById('movementSpeedSlider');
const backfaceCheckbox = document.getElementById('backface');
const camPosEl = document.getElementById('cam-pos');
const camRotEl = document.getElementById('cam-rot');
const statusEl = document.getElementById('status');
const loadingEl = document.getElementById('loading');
const loadingTextEl = document.getElementById('loadingText');

// Loading overlay over the canvas. Map parsing runs synchronously on the main
// thread (the big maps take a while), so after
// changing the message this yields a frame, otherwise the browser never gets
// to paint it before the work starts.
async function showLoading(message) {
    loadingTextEl.textContent = message;
    loadingEl.hidden = false;
    await new Promise(resolve => requestAnimationFrame(() => setTimeout(resolve, 0)));
}
function hideLoading() {
    loadingEl.hidden = true;
}
const controlModeSel = document.getElementById('control-mode');
const gameSel = document.getElementById('selected-game');
const subdivisionSelectorContainer = document.getElementById("subdivisionSelectorContainer");
const waterboxCheckboxElement = document.getElementById("waterboxCheckboxDiv");
const groundClipBandsLabel = document.getElementById("groundClipBandsLabel");

const display_fwc = document.getElementById('display_fwc');
const display_fwc_label = document.getElementById('display_fwc_label');
const bkViewModeLabel = document.getElementById('bkViewModeLabel');
const bkPropCollisionLabel = document.getElementById('bkPropCollisionLabel');
const bkActorHitboxesLabel = document.getElementById('bkActorHitboxesLabel');

////////////////////////////////////////
// System: Scene, Renderer, Camera, Lights
////////////////////////////////////////
let speed = 850; // movement units per second
let controlMode = 'pointer'; // State regarding which control mode is active: 'pointer' | 'orbit' | 'auto'
let mesh = null;
let edges = null;

const canvas = document.getElementById('gl');

const renderer = new THREE.WebGLRenderer({canvas, antialias:true});
renderer.setPixelRatio(window.devicePixelRatio);
renderer.shadowMap.enabled = false;

const scene = new THREE.Scene();
scene.background = new THREE.Color(0x0b1220);
setupWallPushClipUI(scene);
setupBombStacking(scene);
installWaterboxDepthToggle(scene, document.getElementById('showFullWaterboxDepth'));

// Depth precision goes as near / distance^2, and the meshes use polygonOffset
// so their wireframes draw on top: with a 0.1 near plane, one depth-buffer
// step is over 10 world units a few thousand units out, and a surface that
// close above another (CCW winter's ice over its lake bed) shows the lower
// one's edges through it. 2 units is well below the slowest fly speed.
const camera = new THREE.PerspectiveCamera(60,2,2,100000);
camera.position.set(0,100,400);

// Movement state (applies only in pointer-lock / fly mode)
const move = {forward:false,back:false,left:false,right:false,up:false,down:false};

// Lights
const hemi = new THREE.HemisphereLight(0xaaaaee,0xaaaaee,0.8); // 0x9696fa
scene.add(hemi);
const dir = new THREE.DirectionalLight(0xffffff,0.7);
dir.position.set(100,200,100);
scene.add(dir);

////////////////////////////////////////
// System: UI wiring (material/grid/wireframe/pointer status/etc)
////////////////////////////////////////

const grid = new THREE.GridHelper(8000, 80, '#1c2a3a', '#0f1720');
grid.material.opacity = 0.25;
grid.material.transparent = true;
grid.visible = gridCheckbox.checked;
scene.add(grid);

// The status bar was removed from the sidebar -- it only ever echoed
// pointer-lock chatter. The call sites are left in place and become no-ops, so
// dropping the #status element back into index.html is all it takes to get it
// working again, and nothing throws in the meantime.
function setStatus(msg, level='info'){
    if(!statusEl) return;

    statusEl.textContent = `Status: ${msg}`;
    if(level==='warn') statusEl.style.background = '#40230b';
    else if(level==='error') statusEl.style.background = '#4b0b0b';
    else statusEl.style.background = '#221a11';
}

function setMaterialProps() {
    const transparent = translucentCheckbox.checked;
    const opacity = parseFloat(opacitySlider.value);
    const side = backfaceCheckbox.checked ? THREE.DoubleSide : THREE.FrontSide;

    loadedModels.forEach(entry => {

        const root = entry.mesh;   // the real Three.js object

        if (!root || !root.isObject3D) return;

        root.traverse(obj => {

            // OOT's textured rooms keep their display lists' culling
            // (zelda_textured.js).
            if (obj.isMesh && obj.material && !obj.userData.textured) {

                const materials = Array.isArray(obj.material)
                    ? obj.material
                    : [obj.material];

                materials.forEach(mat => {
                    mat.transparent = transparent;
                    mat.opacity    = opacity;
                    mat.side       = side;
                    mat.needsUpdate = true;
                });
            }
        });
    });
}

translucentCheckbox.addEventListener('change', setMaterialProps);
opacitySlider.addEventListener('input', setMaterialProps);
backfaceCheckbox.addEventListener('change', setMaterialProps);

movementSpeedSlider.addEventListener('input', () => {speed = movementSpeedSlider.value;});

gridCheckbox.addEventListener('change', () => {
    grid.visible = gridCheckbox.checked;
});


////////////////////////////////////////
// System: Dropdown population (initial)
////////////////////////////////////////

BK_Maps.forEach(map => {
    const option = document.createElement("option");
    option.value = map.name; // This will be the value when selected
    option.textContent = map.name; // This is what’s shown to the user
    mapDropdown.appendChild(option);
});

////////////////////////////////////////
// System: Surface Flag dropdown
////////////////////////////////////////

// Toggle dropdown (robust)
const dropdownElement = document.getElementById("surfaceDropdown");
const dropdown = document.querySelector('.dropdown');
const dropdownBtn = document.querySelector('.dropdown-btn');
const dropdownContent = document.getElementById("surfaceDropdownContent");

// Open/close when clicking the button
dropdownBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    dropdown.classList.toggle('show');
});

// Close if clicking outside
document.addEventListener('click', () => {
    dropdown.classList.remove('show');
});

// Prevent inside clicks from closing
dropdownContent.addEventListener('click', (e) => {
    e.stopPropagation();
});

////////////////////////////////////////
// System: Game / Map selector
////////////////////////////////////////

// Map each game to its data array
const GAME_MAPS = {
    BK: BK_Maps,
    BT: BT_Maps,
    DK64: DK64_Maps,
    OOT: OOT_Maps,
    MM: MM_Maps,
    OOT3D: OOT3D_Maps,
    MM3D: MM3D_Maps,
    OOTSW2: OOTSW2_Maps,
};

// Map each game to its data array
const GAME_ACTORS = {
    BK: null,
    BT: null,
    DK64: null,
    OOT: OOT_Dynapoly_Actors,
    MM: MM_Dynapoly_Actors,
    OOT3D: null,
    MM3D: null,
};

const GAME_COLLISIONS = {
    BK: null,
    BT: null,
    DK64: null,
    OOT: OOT_Dynapoly_Collisions,
    MM: MM_Dynapoly_Collisions,
    OOT3D: null,
    MM3D: null,
};

// Tooltips of the view checkboxes the games share. index.html's text is BK /
// BT's; DK64 swaps in its own (dk64_setup.js / dk64_map.js describe the data).
const texturesLabel = document.getElementById('bkTextures').closest('label');
const DEFAULT_TOOLTIPS = new Map([
    [texturesLabel, texturesLabel.title],
    [bkPropCollisionLabel, bkPropCollisionLabel.title],
    [bkActorHitboxesLabel, bkActorHitboxesLabel.title],
]);
const DK64_TOOLTIPS = new Map([
    [texturesLabel, "The map, props and actors drawn with their in-game textures and vertex colours " +
        "(decoded from the display lists), with the water surfaces and animated textures. Off: the map's " +
        "collision (floors and walls) as one flat mesh, props as flat purple triangles and actors as flat orange " +
        "ones, like BK / BT."],
    [bkPropCollisionLabel, "Draw each prop's and actor's own collision triangles: a prop model's wall and floor " +
        "lists, and an actor model's (boulders, cages; most actors only have hit spheres). Floors amber, walls " +
        "pink, triangles listed as both purple. With textures on they are drawn translucent over the model; with " +
        "textures off they replace it. Models without any keep showing their model and say 'no collision' in " +
        "their description. Parts the game animates (doors, moving platforms) are shown at rest."],
    [bkActorHitboxesLabel, "Draw actors' hit spheres, from their model's collision block (each sphere on a bone, " +
        "shown in the rest pose and scaled with the actor). Enemies = the enemy spawners' actors (red). Touch = " +
        "the setup file's actors: barrels, cannons, boulders, switches (cyan). Actors without a model (balloons, " +
        "triggers) have none."],
]);
function applyGameTooltips(game) {
    const tooltips = game == "DK64" ? DK64_TOOLTIPS : DEFAULT_TOOLTIPS;
    for (const [element, title] of tooltips) element.title = title;
}

gameSel.addEventListener('change',(e)=>{
    game = e.target.value;
    mapDropdown.replaceChildren();   // options and any <optgroup>s
    setupDropdown.options.length = 0;
    actorDropdown.options.length = 0;
    
    let maps = GAME_MAPS[game]
    let actors = GAME_ACTORS[game]
    
    if(game == "OOT" || game == "MM") {
        EPS = 0.008;
    }
    else if(game == "OOT3D" || game == "MM3D") {
        EPS = 0.00008;
    }
    
    // Maps with a `group` (DK64) go under <optgroup> headings, in list order
    let optgroup = null;
    maps.forEach(map => {
        const option = document.createElement("option");
        option.value = map.name; // This will be the value when selected
        option.textContent = map.name; // This is what’s shown to the user
        if (map.group && map.group !== optgroup?.label) {
            optgroup = document.createElement("optgroup");
            optgroup.label = map.group;
            mapDropdown.appendChild(optgroup);
        }
        (map.group ? optgroup : mapDropdown).appendChild(option);
    });
    if(actors) {
        actors.forEach(actor => {
            const option = document.createElement("option");
            option.value = actor.list_index; // This will be the value when selected
            option.textContent = actor.actor_name + ": " + actor.actor_description; // This is what’s shown to the user
            actorDropdown.appendChild(option);
        });
    }
    
    // "Textures" also covers OOT's and MM's rooms (zelda_textured.js);
    // "Prop/actor collision" and "Actor hitboxes" are BK / BT / DK64 things.
    bkViewModeLabel.style.display = (game == "BK" || game == "BT" || game == "DK64" || game == "OOT" || game == "MM") ? "block" : "none";
    bkPropCollisionLabel.style.display = (game == "BK" || game == "BT" || game == "DK64") ? "" : "none";
    bkActorHitboxesLabel.style.display = (game == "BK" || game == "BT" || game == "DK64") ? "block" : "none";
    applyGameTooltips(game);
    document.getElementById('actorDisplay').style.display = (game == "OOT" || game == "MM") ? "" : "none";

    // OOT / MM / OOT3D / MM3D only: surface flags, waterboxes, subdivisions and
    // the ground clip bands come from their collision format (not OOT Switch 2's)
    if (["BK", "BT", "DK64", "OOTSW2"].includes(game)) {
        display_fwc_label.style.display = "none";
        dropdownElement.style.display = "none";
        waterboxCheckboxElement.style.display = "none";
        subdivisionSelectorContainer.style.display = "none";
        groundClipBandsLabel.style.display = "none";
    }
    else {
        // (display_fwc_label stays hidden for now: floors/walls/ceilings are never split on load)
        dropdownElement.style.display = "block";
        waterboxCheckboxElement.style.display = "block";
        subdivisionSelectorContainer.style.display = "block";
        groundClipBandsLabel.style.display = "block";
    }

    if (["OOT","MM"].includes(game)) {
        // (the single-actor picker, actorDropdown / loadActor, stays hidden for now)
        setupDropdownDiv.style.display = "";
        
        const game = document.getElementById("selected-game").value;
        if (game == "OOT" || game == "MM") {
            const mapName = document.getElementById("mapDropdown").value;
            let mapFilename = getMapProperty(game, mapName, "file");
            loadActorsInSceneJSON(game, mapFilename)
        }
    }
    else {
        setupDropdownDiv.style.display = "none";
    }
        
});

mapDropdown.addEventListener('change',(e)=>{
    const game = document.getElementById("selected-game").value;
    if (game == "OOT" || game == "MM") {
        const mapName = document.getElementById("mapDropdown").value;
        let mapFilename = getMapProperty(game, mapName, "file");
        loadActorsInSceneJSON(game, mapFilename)
    }
});

// Get map property
function getMapProperty(game, mapName, prop) {
    const maps = GAME_MAPS[game];
    if (!maps) return null;

    const found = maps.find(map => map.name === mapName);
    return found ? found[prop] ?? null : null;
}

// Load selected map
// Everything the viewer saved in this site's localStorage goes, then a reload
// starts from the defaults.
document.getElementById('resetDefaults').addEventListener('click', () => {
    if (!confirm('Reset every saved setting to its default? The page will reload.')) return;
    try { localStorage.clear(); } catch { /* nothing saved */ }
    location.reload();
});

loadMap.addEventListener('click', async (e) => {
    const game = document.getElementById("selected-game").value;
    const mapLabel = document.getElementById("mapDropdown").value;
    await showLoading(`Loading ${mapLabel}…`);
    try {
        await loadSelectedMap(game);
    } finally {
        hideLoading();
    }
});

async function loadSelectedMap(game) {
    if (game == "BK"){
        // models/BK/<dir>/{opa,xlu}.model.bin, see BK_Maps in model_list.js
        const mapName = document.getElementById("mapDropdown").value;
        const mapDir = getMapProperty(game, mapName, "dir");
        const mapId = parseInt(getMapProperty(game, mapName, "sceneID"), 16);
        const hasXlu = getMapProperty(game, mapName, "xlu") !== "";

        try {
            const res1 = await fetch('./models/BK/' + mapDir + '/opa.model.bin');
            const buffer1 = await res1.arrayBuffer();
            console.log(mapDir+"/opa.model.bin: Binary file length:", buffer1.byteLength);
            await showLoading(`${mapName}: map model…`);
            parseBKModelBinary(scene, buffer1, true, undefined, mapId);

            if (hasXlu) {
                const res2 = await fetch('./models/BK/' + mapDir + '/xlu.model.bin');
                const buffer2 = await res2.arrayBuffer();
                console.log(mapDir+"/xlu.model.bin: Binary file length:", buffer2.byteLength);
                parseBKModelBinary(scene, buffer2, false, "XLU Model", mapId);
            }

            // Sky dome / cloud layers drawn behind the map (sky.js)
            await renderSky(scene, 'BK', mapId);

            // Object placement (actor spawns, static model / sprite props)
            const res3 = await fetch('./models/BK/' + mapDir + '/setup.bin');
            const buffer3 = await res3.arrayBuffer();
            console.log(mapDir+"/setup.bin: Binary file length:", buffer3.byteLength);
            await showLoading(`${mapName}: actors and props…`);
            await renderBKSetup(scene, buffer3, mapId);
            addActorBitclipEdges(scene, getPropInstances());
        } catch (err) {
            console.error(err);
        }
    }
    else if (game == "BT"){
        // models/BT/<dir>/{opa,xlu}.model.bin, see BT_Maps in model_list.js.
        // Same BKModelBin format as BK. The three big Jolly Roger's Lagoon maps
        // have no opa model of their own: their terrain is a list of sector
        // models (sect<N>.*.model.bin) and the map-level xlu is the water.
        const mapName = document.getElementById("mapDropdown").value;
        const mapDir = getMapProperty(game, mapName, "dir");
        const mapId = parseInt(getMapProperty(game, mapName, "sceneID"), 16);
        const hasOpa = getMapProperty(game, mapName, "opa") !== "";
        const hasXlu = getMapProperty(game, mapName, "xlu") !== "";
        const sectors = getMapProperty(game, mapName, "sectors") ?? [];

        const files = [];
        if (hasOpa) files.push(["opa.model.bin", undefined]);
        sectors.forEach(([opa, xlu, offset], i) => {
            files.push([`sect${i}.opa.model.bin`, `Sector ${i} (0x${opa})`, offset]);
            if (xlu !== "") files.push([`sect${i}.xlu.model.bin`, `Sector ${i} XLU (0x${xlu})`, offset]);
        });
        if (hasXlu) files.push(["xlu.model.bin", "XLU Model"]);

        try {
            for (let i = 0; i < files.length; i++) {
                const [filename, label, offset] = files[i];
                const res = await fetch('./models/BT/' + mapDir + '/' + filename);
                const buffer = await res.arrayBuffer();
                console.log(mapDir + "/" + filename + ": Binary file length:", buffer.byteLength);
                await showLoading(`${mapName}: ${label ?? 'map model'}…`);
                // Textures are looked up by id in the shared bank: fetch the
                // chunks this model names first (bt_textures.js)
                await loadBTModelTextures(buffer);
                parseBKModelBinary(scene, buffer, i === 0, label, undefined, offset);
            }

            // Sky layers drawn behind the map (sky.js, BT_Skies)
            await renderSky(scene, 'BT', mapId);

            // Object placement (actor spawns, static model props), bt_setup.js
            const res3 = await fetch('./models/BT/' + mapDir + '/setup.bin');
            const buffer3 = await res3.arrayBuffer();
            console.log(mapDir + "/setup.bin: Binary file length:", buffer3.byteLength);
            await showLoading(`${mapName}: actors and props…`);
            await renderBTSetup(scene, buffer3, mapId, mapName);
            addActorBitclipEdges(scene, getPropInstances());
        } catch (err) {
            console.error(err);
        }
    }
    else if (game == "DK64") {
        // models/DK64/<dir>/{geometry,floors,walls}.bin, see DK64_Maps in
        // dk64_map_list.js and tools/dk64/extract_dk64_maps.py. The collision
        // (floors + walls) is the plain mesh; the display lists hang under it
        // as the textured mesh, as for BK / BT.
        const mapName = document.getElementById("mapDropdown").value;
        const mapDir = getMapProperty(game, mapName, "dir");
        const scale = getMapProperty(game, mapName, "scale") ?? 3;
        const load = async file => {
            const res = await fetch(`./models/DK64/${mapDir}/${file}`);
            if (!res.ok) throw new Error(`${mapDir}/${file}: ${res.status}`);
            return res.arrayBuffer();
        };
        try {
            const [geometry, floorsBuf, wallsBuf] = await Promise.all(["geometry.bin", "floors.bin", "walls.bin"].map(load));
            await showLoading(`${mapName}: collision…`);
            const floors = parseDK64Collision(floorsBuf, true);
            const walls = parseDK64Collision(wallsBuf, false);
            clearAllModels(scene);
            clearTexturedPairs();

            // The map is a "Main Model" group box: Floors, Walls and Ceilings
            // rows, one mesh each under one scene group that also holds the
            // textured map. floors.bin triangles facing down are ceilings: the
            // floor finder (global_asm 806679BC) only stands on one whose normal
            // points up (8066893C), 806685E0 tags the others 2 (ceiling).
            const main = new THREE.Group();
            main.name = "Main Model";
            scene.add(main);
            const group = getModelGroup("dk64-main", "Main Model");
            const facesUp = ([a, b, c]) => {
                const [p, q, r] = [a, b, c].map(i => floors.verts[i]);
                return (q[2] - p[2]) * (r[0] - p[0]) - (q[0] - p[0]) * (r[2] - p[2]) >= 0;
            };
            // selection ids: the triangle's place in floors.bin / walls.bin (first
            // grid-cell copy; crouch_gaps.py's "map floor k" / "map wall k")
            const floorKs = [], ceilingKs = [];
            floors.tris.forEach((t, k) => (facesUp(t) ? floorKs : ceilingKs).push(k));
            const parts = [
                ["Floors", floors, floorKs, "floor", "#3aa6ff"],
                ["Walls", walls, walls.tris.map((_, k) => k), "wall", "#3aa6ff"],
                ["Ceilings", floors, ceilingKs, "floor", "#3aa6ff"],
            ];
            for (const [rowName, source, ks, kind, color] of parts) {
                if (!ks.length) continue;
                buildGeometry(scene, source.verts, ks.map(k => source.tris[k]), null, null, rowName, false, false, color, group.body);
                const entry = loadedModels[loadedModels.length - 1];
                main.add(entry.mesh);
                entry.mesh.geometry.userData.triangleIds = ks.map(k => `${kind} ${k}`);
                registerPlain(entry.mesh, entry.edges);
            }
            loadedModels.push({ name: "Main Model", mesh: main, edges: null });
            // The master is the whole map: the textured map shows while any row is on.
            const syncMain = () => { main.visible = group.master.checked || group.master.indeterminate; };
            group.body.addEventListener('change', syncMain);
            group.master.addEventListener('change', syncMain);
            applyGroupMasterState("dk64-main");
            syncMain();
            console.log(`${mapDir}: ${floorKs.length} floor + ${walls.tris.length} wall + ${ceilingKs.length} ceiling triangles`);

            await showLoading(`${mapName}: textured geometry…`);
            const textured = await buildDK64TexturedMesh(geometry, scale, getMapProperty(game, mapName, "mapID") ?? -1);
            attachTextured(main, textured, null);

            // Water surfaces (their own row: they are drawn by the game's water
            // code, not the map's display lists). Like BK / BT's XLU model, a
            // plain polygon row with the textured water hung under it, so the
            // Textures checkbox swaps between them.
            const waterRects = parseDK64Water(new DataView(geometry));
            if (waterRects.length) {
                const waterVerts = [], waterTris = [];
                for (const w of waterRects) {
                    const i = waterVerts.length;
                    waterVerts.push([w.x0, w.y, w.z0], [w.x0, w.y, w.z1], [w.x1, w.y, w.z1], [w.x1, w.y, w.z0]);
                    waterTris.push([i, i + 1, i + 2], [i, i + 2, i + 3]);
                }
                buildGeometry(scene, waterVerts, waterTris, null, null, "Water", false);
                const waterEntry = loadedModels[loadedModels.length - 1];
                const water = await buildDK64Water(geometry);
                if (water && waterEntry?.name === "Water") attachTextured(waterEntry.mesh, water, waterEntry.edges);
            }

            // Sky gradient / moon / backdrop drawn behind the map (sky.js)
            await renderDK64Sky(scene, mapName);

            // Props, actors and enemies (dk64_setup.js)
            await showLoading(`${mapName}: actors and props…`);
            const [setup, spawners, triggers] = await Promise.all(["setup.bin", "spawners.bin", "triggers.bin"].map(load));
            await renderDK64Setup(scene, setup, spawners, triggers);

            // Ledge grab markers: floor edges a Kong can grab (dk64_map.js
            // findDK64Ledges), over the map's collision and the placed props'
            // together (a prop's floor can top a map wall). Off by default.
            const scripts = await load("scripts.bin").catch(() => null);
            const propCollision = getDK64PropCollisionWorld(parseDK64LedgeScripts(scripts));
            const ledges = findDK64Ledges(mergeDK64Collision([floors, propCollision.floors]),
                                          mergeDK64Collision([walls, propCollision.walls]));
            for (const [rowName, edges, color] of [
                ["Grabbable ledges", ledges.grab, 0xffe14d],
                ["No-grab ledges", ledges.noGrab, 0xff4040],
            ]) {
                if (!edges.length) continue;
                const marker = buildDK64LedgeMarker(edges, color);
                marker.name = rowName;
                marker.userData.bkInfo = `${rowName}: ${edges.length} floor edges` + (color === 0xff4040
                    ? " (map floors with flag 0x8, and prop floors whose script doesn't enable grabs)" : "");
                scene.add(marker);
                loadedModels.push({ name: rowName, root: marker, mesh: marker, edges: null });
                addModelCheckbox(scene, rowName, marker, null, false, false, '#' + color.toString(16).padStart(6, '0'), false, null);
            }
            console.log(`${mapDir}: ${ledges.grab.length} grabbable ledge edges, ${ledges.noGrab.length} no-grab ` +
                        `(${propCollision.floors.tris.length} prop floor triangles)`);

            // Slippery slopes: floors steep enough for their surface type that
            // a Kong slips on them (dk64_map.js findDK64SlipperyFloors).
            // Cliff faces are often floor triangles too, and slippery, so the
            // steep ones get a row of their own.
            const slopes = findDK64SlipperyFloors(mergeDK64Collision([floors, propCollision.floors]));
            const steep = s => s.slopeDegrees >= 60;
            for (const [rowName, list, color, range] of [
                ["Slippery slopes", slopes.filter(s => !steep(s)), 0xff8c1a, "under 60 degrees"],
                ["Steep slippery floors", slopes.filter(steep), 0xff40c0, "60 degrees or steeper (mostly cliff faces)"],
            ]) {
                if (!list.length) continue;
                const marker = buildDK64SlopeMarker(list, color);
                marker.name = rowName;
                const types = [...new Set(list.map(s => s.surface))].sort((a, b) => a - b);
                const info = `${rowName}: floors a Kong slips on with a slope ${range}\n` +
                    `${list.length} triangles, surface types ${types.join(', ')}`;
                marker.userData.bkInfo = info;
                scene.add(marker);
                loadedModels.push({ name: rowName, root: marker, mesh: marker, edges: null });
                addModelCheckbox(scene, rowName, marker, null, false, false, '#' + color.toString(16).padStart(6, '0'), false, null);
                const row = [...document.querySelectorAll('.model-row')].find(el => el.dataset.modelName === rowName);
                if (row) row.title = info;
            }
            console.log(`${mapDir}: ${slopes.length} slippery floor triangles (${slopes.filter(steep).length} steep)`);

            // Crouch gaps: openings only crouching Diddy fits through
            // (dk64_crouch_gaps.js; crouch_gaps.json from the dk64 repo's
            // tools/kong_viewer/scripts/crouch_gaps.py, absent until it's run).
            // One row per clip in a "Crouch clips (Diddy)" group, each with a
            // button that points the camera at it.
            const gaps = await load("crouch_gaps.json").then(b => JSON.parse(new TextDecoder().decode(b))).catch(() => null);
            const gapItems = buildDK64CrouchGapItems(gaps);
            if (gapItems.length) {
                const group = getModelGroup("dk64-crouch", "Crouch clips (Diddy)");
                group.wrapper.title = 'Leaning walls a crouch slide gets through (purple: Diddy only, grey: a standing ' +
                    'Kong too), gaps only crouching Diddy fits (red passage, orange pocket, blue corridor) and the jugs ' +
                    'stump check (green). The arrow buttons move the camera to one.';
                for (const item of gapItems) {
                    const rowName = item.label;
                    item.object.name = rowName;
                    scene.add(item.object);
                    loadedModels.push({ name: rowName, root: item.object, mesh: item.object, edges: null });
                    addModelCheckbox(scene, rowName, item.object, null, false, false, null, false, false, group.body);
                    const row = group.body.lastElementChild;
                    row.title = item.info;
                    const go = document.createElement('button');
                    go.type = 'button';
                    go.className = 'model-goto';
                    go.textContent = '➜';
                    go.title = 'Go to this clip (and show it)';
                    go.addEventListener('click', () => {
                        const box = row.querySelector('.model-label > input');
                        if (!box.checked) box.click();
                        const { from, to } = item.focus;
                        const dir = to.clone().sub(from).normalize();
                        setCameraPose(from.toArray(), Math.asin(dir.y), Math.atan2(-dir.x, -dir.z));
                        if (orbitControls) orbitControls.target.copy(to);
                    });
                    row.querySelector('.model-delete-spacer')?.replaceWith(go);
                }
                applyGroupMasterState("dk64-crouch");
            }
        } catch (err) {
            console.error(err);
        }
    }
    else if (game == "OOTSW2") {
        // models/OOTSW2/<map_type>/<map_name>/{collision.bin,objects.json}, see
        // OOTSW2_Maps in ootsw2_map_list.js and tools/ootsw2/extract_objmap.py.
        // compound/ is the level, collision.bin the objects not baked into it (ootsw2_map.js).
        const mapName = document.getElementById("mapDropdown").value;
        const mapDir = getMapProperty(game, mapName, "dir");
        try {
            const objects = await fetch(`./models/OOTSW2/${mapDir}/objects.json`).then(r => r.json());
            const ocol = getMapProperty(game, mapName, "collision")
                ? parseOCOL(await fetch(`./models/OOTSW2/${mapDir}/collision.bin`).then(r => r.arrayBuffer()))
                : null;
            ootsw2Airwalls ??= await fetch('./models/OOTSW2/airwalls.json').then(r => r.json()).catch(() => ({}));
            await showLoading(`${mapName}: static compound…`);
            const compound = await loadOOTSW2Compound(`./models/OOTSW2/${mapDir}/compound`, getMapProperty(game, mapName, "bounds"));
            await showLoading(`${mapName}: collision…`);
            const col = buildOOTSW2Collision(ocol, objects, ootsw2Airwalls, !!compound);
            clearAllModels(scene);
            clearTexturedPairs();

            // Every source split by actor name: one row per actor (all its
            // instances), in a group per name prefix (Land, Obj, Npc...). The
            // static compound (the game's baked static collision) is the level;
            // without one, the Land_ actors are rebuilt from their own shapes.
            // Static collision split by the owner's IsNotTurnToActor flag:
            // "permanent" never becomes an actor; "removable" (crack walls,
            // chain-lock doors, spider webs, boss fences...) is baked but the
            // game can turn it into an actor (break, open, despawn). Data
            // without the flags falls back to Land_ = permanent. The ground,
            // far scenery and unknown bodies are permanent.
            // Removable collision that matches what ocarina jumps were found to
            // need in game is its own kind: neither Bakeable nor IsNotTurnToActor
            // (Land_ pieces with neither and body byte 6 don't work), body byte 2
            // in the bodies file, and static collision at least
            // OCARINA_MIN_HEIGHT tall: large chests (1.75 m) and pullable
            // gravestones (1.10 m) work, small chests (0.55 m) and grass
            // (<= 0.42 m) don't. The byte's meaning is unknown and the height
            // cut is somewhere between 0.55 and 1.10 m.
            const OCARINA_MIN_HEIGHT = 0.6;
            const haveFlags = objects.some(o => o.na);
            const permanent = owner => owner < 0 || (haveFlags ? !!objects[owner].na : isOOTSW2Terrain(objects[owner].n));
            const staticSource = compound ? mergeOOTSW2Compound(compound, objects) : { kind: "static", ...typedMeshList(col.terrain, objects) };
            const ocarinaCandidate = owner => !objects[owner].b && !objects[owner].na && !!staticSource.bodyBytes?.get(owner)?.has(2);
            const ocarinaJumpable = owner => ocarinaCandidate(owner) && staticSource.height(owner) >= OCARINA_MIN_HEIGHT;
            // romfs data (extract_romfs.py) knows each triangle's surface and
            // collision layer: AirWall-material triangles (invisible walls,
            // also inside Land_ meshes) and air wall objects are air walls;
            // the more detailed duplicate layer and the baked area volumes
            // are kinds of their own, hidden at first
            const surfaceTable = compound?.manifest?.surfaces ?? [];
            const compoundLayers = compound?.manifest?.layers ?? [];
            // Air walls Link can only climb, and push walls (doors and the
            // like), are kinds of their own: they don't simply block him
            const wallKind = owner => {
                const name = owner >= 0 ? objects[owner].n : '';
                return /Climb/.test(name) ? "climbWall" : /^PushAir[Ww]all/.test(name) ? "pushWall" : "airwall";
            };
            let staticMain = staticSource, staticExtra = [];
            if (staticSource.layers) {
                const AIR = /Air[Ww]all/;
                const parts = splitSourceByTriangle(staticSource, t => {
                    const layer = staticSource.layers[t];
                    if (layer === 2) return "detail";
                    if (layer === 3) return "bakedArea";
                    const owner = staticSource.owners[t];
                    if (surfaceTable[staticSource.surfaces[t]]?.m === "AirWall" || (owner >= 0 && AIR.test(objects[owner].n))) return wallKind(owner);
                    return "static";
                });
                staticMain = parts.find(p => p.kind === "static") ??
                    { kind: "static", positions: staticSource.positions, indices: new Uint32Array(0), owners: new Int32Array(0), surfaces: new Uint16Array(0) };
                staticExtra = parts.filter(p => p.kind !== "static");
            }
            const [staticPermanent, staticRemovable] = splitSourceByOwner(staticMain, "staticObj", permanent);
            const sources = [
                staticPermanent,
                ...(haveFlags ? splitSourceByOwner(staticRemovable, "ocarina", owner => !ocarinaJumpable(owner)) : [staticRemovable]),
                ...staticExtra,
                { kind: "actor", ...typedMeshList(col.actors, objects) },
                { kind: "hull", ...typedMeshList(col.hulls, objects) },
                ...(() => {
                    const walls = { kind: "airwall", ...typedMeshList(col.airwalls, objects) };
                    return splitSourceByTriangle(walls, t => wallKind(walls.owners[t]));
                })(),
            ];
            const actorRows = groupOOTSW2ByActor(sources, objects);
            const KIND_COLORS = { static: "#3aa6ff", staticObj: "#3ddc84", ocarina: "#ffe14d", actor: "#b05cff", hull: "#ff9a3a", airwall: "#ff4f6a",
                                  climbWall: "#ffc400", pushWall: "#4f8cff", detail: "#9aa0a6", bakedArea: "#3fc1b0" };
            const KIND_LABELS = { static: "static permanent", staticObj: "static removable", ocarina: "static removable (ocarina jump)",
                                  actor: "actor collision", hull: "hulls", airwall: "air wall", climbWall: "climb-only wall",
                                  pushWall: "push wall", detail: "detail copy", bakedArea: "baked areas" };
            const KIND_TITLES = {
                static: "Static collision of objects that never become actors (IsNotTurnToActor): level geometry, the heightmap ground",
                staticObj: "Static collision of objects the game can turn into actors (no IsNotTurnToActor): crack walls, " +
                    "chain-lock doors... It can disappear when the object breaks, opens or isn't spawned",
                ocarina: "Objects an ocarina jump should work on, from in-game tests: in the static collision with neither Bakeable " +
                    "nor IsNotTurnToActor, body byte 2, and collision at least 0.6 m from bottom to top (large chests 1.75 m, " +
                    "pullable gravestones 1.10 m and bean plants 0.96 m work; small chests 0.55 m and grass don't). That is the " +
                    "collision's extent, not its visible height: a bean plant's reaches 0.8 m below its leaf. Click an object to see it",
                actor: "Its own triangle mesh: doors, platforms, moving parts",
                hull: "Convex physics shapes: NPC / enemy bodies, pots, crates, bomb flowers",
                airwall: "Invisible walls: air wall objects, and static collision whose surface material is AirWall",
                climbWall: "Air walls Link can only climb (air wall objects with Climb in their name)",
                pushWall: "Push walls: air walls that push Link back (doors and the like)",
                detail: compoundLayers.find(l => l.index === 2)?.title,
                bakedArea: compoundLayers.find(l => l.index === 3)?.title,
            };
            const categories = new Map();
            for (const row of actorRows) {
                if (!categories.has(row.category)) categories.set(row.category, { rows: [], triangles: 0 });
                const cat = categories.get(row.category);
                cat.rows.push(row);
                cat.triangles += row.triangles;
            }
            const order = [...categories.keys()].sort((a, b) =>
                (a === "Other") - (b === "Other") || categories.get(b).triangles - categories.get(a).triangles);

            // Loading zones and areas (ootsw2_areas.js), see-through volumes
            const areaData = buildOOTSW2Areas(objects, await loadOOTSW2AreaTables(), ootsw2Airwalls,
                getMapProperty(game, mapName, "age"),
                dest => OOTSW2_Maps.find(m => m.dir.endsWith(`/${dest}`))?.name ?? dest);
            const areaKinds = OOTSW2_AREA_KINDS.filter(([kind]) => areaData.areas[kind].tris.length);

            // Collision types: one checkbox per kind across every row, so a
            // Land_ piece's air walls hide with the rest of the air walls while
            // its static collision stays (and the reverse). A part shows when
            // its row is on AND its kind is on. The second line is the volumes:
            // loading zones (rows of their own too) and objmap's area categories.
            const kindParts = {};   // kind -> [mesh, edge mesh] pairs
            const kindRow = document.createElement('div');
            kindRow.className = 'model-row ootsw2-kinds';
            kindRow.title = 'Show or hide one kind of collision or volume on every row, including rows that hold several kinds';
            const addKind = (kind, label, color, title = null) => {
                kindParts[kind] = [];
                const box = document.createElement('label');
                box.className = 'ootsw2-kind';
                if (title) box.title = title;
                const chk = document.createElement('input');
                chk.type = 'checkbox';
                chk.checked = ootsw2KindShown[kind] ?? true;
                chk.addEventListener('change', () => {
                    ootsw2KindShown[kind] = chk.checked;
                    for (const [mesh, edge] of kindParts[kind]) mesh.visible = edge.visible = chk.checked;
                    clearSelection(scene);
                });
                const dot = document.createElement('span');
                dot.className = 'ootsw2-kind-dot';
                dot.style.background = color;
                box.append(chk, dot, label);
                kindRow.appendChild(box);
            };
            for (const kind of Object.keys(KIND_COLORS))
                if (actorRows.some(r => r.parts.some(p => p.kind === kind))) addKind(kind, KIND_LABELS[kind], KIND_COLORS[kind], KIND_TITLES[kind]);
            if (areaData.zones.length || areaKinds.length) {
                const brk = document.createElement('span');
                brk.className = 'ootsw2-kinds-break';
                kindRow.appendChild(brk);
            }
            if (areaData.zones.length) addKind('zone', 'loading zones', OOTSW2_ZONE_COLOR);
            for (const [kind, label, color, , short] of areaKinds) addKind(kind, short, color, label);
            const byHash = new Map(objects.map(o => [o.h, o]));
            const linkCount = objects.reduce((n, o) => n + (o.l ?? []).filter(([dst]) => byHash.has(dst)).length, 0);
            if (linkCount) addKind('link', 'links', OOTSW2_LINK_COLOR,
                'Lines from each object to the objects it links to (its Links), yellow at the source end, cyan at the target');
            document.querySelector('.controls').appendChild(kindRow);
            // Selection info for one placed object: name, hash, objmap's
            // friendly name and its link count
            // and whether an ocarina jump should work on it (with the height
            // of its static collision, for objects that only miss on height)
            const objectIndex = new Map(objects.map((o, i) => [o, i]));
            const ocarinaNote = i => {
                if (!haveFlags || !compound || !ocarinaCandidate(i)) return '';
                const h = staticSource.height(i).toFixed(2);
                return ocarinaJumpable(i) ? ` [ocarina jumpable, collision ${h} m top to bottom]`
                                          : ` [collision too thin for an ocarina jump?, ${h} m top to bottom]`;
            };
            const objectInfo = o => `${o.n} ${o.h}` + (o.u ? ` - ${o.u}` : '') + ocarinaNote(objectIndex.get(o)) +
                (o.l?.length ? ` (${o.l.length} link${o.l.length > 1 ? 's' : ''})` : '');
            const friendlyName = new Map();
            for (const o of objects) if (o.u && !friendlyName.has(o.n)) friendlyName.set(o.n, o.u);
            // Mesh and edge mesh joined to their kind's checkbox
            const joinKind = (kind, mesh, edge) => {
                kindParts[kind].push([mesh, edge]);
                mesh.visible = edge.visible = ootsw2KindShown[kind] ?? true;
            };

            for (const category of order) {
                const { rows } = categories.get(category);
                const key = `ootsw2-${category}`;
                const group = getModelGroup(key, `${category} (${rows.length})`);
                for (const row of rows.sort((a, b) => a.name.localeCompare(b.name))) {
                    const root = new THREE.Group();
                    for (const part of row.parts) {
                        const mesh = buildOOTSW2Mesh(part.positions, part.indices, KIND_COLORS[part.kind]);
                        mesh.name = `${row.name} ${KIND_LABELS[part.kind]}`;
                        const owners = part.owners, surfaces = part.surfaces;
                        const surfaceNote = k => surfaces ? ` · ${describeOOTSW2Surface(surfaceTable[surfaces[k]])}` : '';
                        mesh.geometry.userData.triangleIds = lazyTriangleIds(owners.length, k =>
                            (owners[k] >= 0 ? objectInfo(objects[owners[k]]) : row.name) + surfaceNote(k));
                        root.add(mesh);
                    }
                    const rowName = row.instances > 1 ? `${row.name} ×${row.instances}` : row.name;
                    root.name = rowName;
                    scene.add(root);
                    const edges = buildOOTSW2Edges(root.children);
                    scene.add(edges);
                    row.parts.forEach((part, i) => joinKind(part.kind, root.children[i], edges.children[i]));
                    loadedModels.push({ name: rowName, mesh: root, edges });
                    // The swatch drives the row's biggest part; the others (an
                    // air wall on a Land_ piece) keep their kind's colour
                    const main = row.parts.reduce((best, p, i) => p.owners.length > row.parts[best].owners.length ? i : best, 0);
                    addModelCheckbox(scene, rowName, root, edges, false, true, KIND_COLORS[row.parts[main].kind], false,
                                     root.children[main], group.body);
                    edges.visible = root.visible && wireframeOn();
                    group.body.lastElementChild.title = (friendlyName.has(row.name) ? `${friendlyName.get(row.name)}\n` : '') +
                        `${row.name}: ` + (row.instances ? `${row.instances} placed, ` : '') + `${row.triangles} triangles (` +
                        row.parts.map(p => `${p.owners.length} ${KIND_LABELS[p.kind]}`).join(', ') + ')';
                }
                applyGroupMasterState(key);
            }

            // Surface view (romfs data only): "surface colours" tints the
            // static collision by material, hazards over it; "highlight"
            // paints the triangles with one shape tag or material magenta.
            // Both are overlays sharing the static collision's vertex buffer,
            // drawn just in front of it.
            if (staticSource.surfaces) {
                const has = tag => s => !!s.t?.includes(tag);
                const SURFACE_CLASSES = [   // [label, colour, test], first match wins
                    ['Lava', '#ff6e00', s => s.m === 'Lava'],
                    ['Abyss (void floor)', '#6a00b0', has('Abyss')],
                    ['Edge of the world', '#c8003c', has('EdgeOfTheWorld')],
                    ['No respawn (DisableRespawn)', '#28dcc8', has('DisableRespawn')],
                    ['No restart pos (material)', '#00a08c', s => s.m === 'InvalidateRestartPos'],
                    ['Slippery', '#bee9ff', s => has('Slip')(s) || /Slip$/.test(s.m)],
                    ['Water', '#3c78e6', s => /Water$/.test(s.m)],
                    ['Bog', '#6b5f3a', s => /Bog$/.test(s.m)],
                    ['Soil', '#8c643c', s => s.m === 'Soil'],
                    ['Grass', '#50a03c', s => s.m === 'Grass'],
                    ['Sand', '#e1cd82', s => /Sand$/.test(s.m)],
                    ['Snow / ice', '#dcf0ff', s => /Snow|Ice/.test(s.m)],
                    ['Stone', '#8a8a8a', s => /^Stone/.test(s.m)],
                    ['Metal', '#5f7391', s => /^Metal|WireNet/.test(s.m)],
                    ['Wood', '#af7332', s => /^Wood/.test(s.m)],
                    ['Other material', '#b4b4b4', () => true],
                ];
                const HIGHLIGHTS = [   // [label, test]
                    ['Abyss flag (void floor)', has('Abyss')], ['DisableRespawn flag', has('DisableRespawn')],
                    ['EdgeOfTheWorld flag', has('EdgeOfTheWorld')], ['NoPreventFall flag', has('NoPreventFall')],
                    ['NoStick flag (no void point update)', has('NoStick')],
                    ['InvalidateRestartPosForHorse flag', has('InvalidateRestartPosForHorse')], ['FlowFall flag', has('FlowFall')],
                    ['NarrowPlace flag', has('NarrowPlace')], ['InvalidateRestartPos material', s => s.m === 'InvalidateRestartPos'],
                    ['Lava material', s => s.m === 'Lava'], ['PoisonBog material', s => s.m === 'PoisonBog'],
                    ['Bog material', s => s.m === 'Bog'], ['Water materials', s => /Water$/.test(s.m)],
                    ['Slip flag', has('Slip')], ['SlipWithoutHeavyBoot flag', has('SlipWithoutHeavyBoot')],
                    ['Climb flag', has('Climb')], ['NoClamber flag', has('NoClamber')], ['HookshotEffective flag', has('HookshotEffective')],
                    ['StickHookshot flag', has('StickHookshot')], ['JumpField flag', has('JumpField')],
                    ['Ladder flags', s => ['LadderUp', 'Ladder', 'LadderSide'].some(t => s.t?.includes(t))],
                    ['AirWall material', s => s.m === 'AirWall'],
                ];
                const src = staticSource;
                const triCount = src.owners.length;
                // static collision only: not the detail copy / baked areas
                const eligible = t => src.layers[t] <= 1 && surfaceTable[src.surfaces[t]];
                const surfaceLabel = t => (src.owners[t] >= 0 ? objectInfo(objects[src.owners[t]])
                                                              : src.owners[t] === -3 ? 'Ground (heightmap)' : 'static collision') +
                                          ` · ${describeOOTSW2Surface(surfaceTable[src.surfaces[t]])}`;
                const overlay = (tris, color, offset) => {
                    const indices = new Uint32Array(tris.length * 3);
                    tris.forEach((t, k) => indices.set(src.indices.subarray(t * 3, t * 3 + 3), k * 3));
                    const mesh = buildOOTSW2Mesh(src.positions, indices, color);
                    mesh.material.polygonOffsetFactor = offset;
                    mesh.material.polygonOffsetUnits = offset;
                    mesh.geometry.userData.triangleIds = lazyTriangleIds(tris.length, k => surfaceLabel(tris[k]));
                    return mesh;
                };
                const register = (name, obj) => {
                    obj.name = name;
                    scene.add(obj);
                    loadedModels.push({ name, mesh: obj, edges: null });
                };

                // Surface colours: one overlay per class
                const classOf = surfaceTable.map(s => s && s.m !== 'AirWall' && s.m !== 'DropItem'
                    ? SURFACE_CLASSES.findIndex(([, , test]) => test(s)) : -1);
                const byClass = SURFACE_CLASSES.map(() => []);
                for (let t = 0; t < triCount; t++) if (eligible(t) && classOf[src.surfaces[t]] >= 0) byClass[classOf[src.surfaces[t]]].push(t);
                const surfaceGroup = new THREE.Group();
                byClass.forEach((tris, c) => { if (tris.length) surfaceGroup.add(overlay(tris, SURFACE_CLASSES[c][1], 0)); });
                surfaceGroup.visible = ootsw2KindShown.surfaces ?? false;
                register('Surface colours', surfaceGroup);

                const line = document.createElement('div');
                line.className = 'ootsw2-surface-row';
                const box = document.createElement('label');
                box.className = 'ootsw2-kind';
                box.title = 'Tint the static collision by surface material, hazards over it: ' +
                    SURFACE_CLASSES.filter((_, c) => byClass[c].length).map(([label]) => label).join(', ') +
                    '. The heightmap ground has no known material and stays untinted.';
                const chk = document.createElement('input');
                chk.type = 'checkbox';
                chk.checked = surfaceGroup.visible;
                const legend = document.createElement('div');
                legend.className = 'ootsw2-surface-legend';
                legend.innerHTML = SURFACE_CLASSES.filter((_, c) => byClass[c].length).map(([label, color]) =>
                    `<span><i style="background:${color}"></i>${label}</span>`).join('');
                legend.style.display = chk.checked ? '' : 'none';
                chk.addEventListener('change', () => {
                    ootsw2KindShown.surfaces = surfaceGroup.visible = chk.checked;
                    legend.style.display = chk.checked ? '' : 'none';
                    clearSelection(scene);
                });
                box.append(chk, 'surface colours');

                // Highlight one tag / material
                const pick = document.createElement('select');
                pick.className = 'ootsw2-highlight';
                pick.title = 'Paint every static collision triangle with this shape tag or material magenta';
                pick.add(new Option('highlight: none', ''));
                HIGHLIGHTS.forEach(([label], i) => pick.add(new Option(label, String(i))));
                const count = document.createElement('span');
                count.className = 'ootsw2-highlight-count';
                let highlight = null;
                pick.addEventListener('change', () => {
                    if (highlight) {
                        scene.remove(highlight);
                        loadedModels.splice(loadedModels.findIndex(m => m.mesh === highlight), 1);
                        highlight = null;
                    }
                    count.textContent = '';
                    clearSelection(scene);
                    if (pick.value === '') return;
                    const test = HIGHLIGHTS[+pick.value][1];
                    const match = surfaceTable.map(s => !!s && test(s));
                    const tris = [];
                    for (let t = 0; t < triCount; t++) if (eligible(t) && match[src.surfaces[t]]) tris.push(t);
                    count.textContent = `${tris.length} triangles`;
                    if (!tris.length) return;
                    highlight = overlay(tris, '#ff00ff', -1);
                    register(`Highlight: ${HIGHLIGHTS[+pick.value][0]}`, highlight);
                });
                line.append(box, pick, count);
                kindRow.append(line, legend);
            }

            // Void probe (ootsw2_voidmap.js): the game voids Link by the 1 m
            // cubes of its VolumeStats voxels, not the collision. "probe
            // cubes" shows them; "void map here" runs the probe on a grid
            // around the point the camera looks at.
            const voxelData = await loadOOTSW2Voxels(`./models/OOTSW2/${mapDir}/voxels.bin.gz`);
            if (voxelData) {
                const variantNames = [...voxelData.variants.keys()].sort();
                let variant = '', voxelSet = null, cubes = null, voidMap = null, floorMap = null;
                const line = document.createElement('div');
                line.className = 'ootsw2-surface-row';
                const status = document.createElement('span');
                status.className = 'ootsw2-highlight-count';
                const drop = obj => {
                    if (!obj) return;
                    scene.remove(obj);
                    const i = loadedModels.findIndex(m => m.mesh === obj);
                    if (i >= 0) loadedModels.splice(i, 1);
                };
                const put = (name, obj) => {
                    obj.name = name;
                    scene.add(obj);
                    loadedModels.push({ name, mesh: obj, edges: null });
                };
                const tiles = () => activeVoxelTiles(voxelData, variant);
                const getSet = () => voxelSet ??= new VoxelSet(tiles());

                // The game's 1 m cubes (VolumeStats), coloured by one of their
                // attributes; only the views this map has data for
                const views = availableCubeViews(tiles());
                const cubePick = document.createElement('select');
                cubePick.className = 'ootsw2-highlight';
                cubePick.title = "The game's 1 m cubes (its VolumeStats voxels, a coarse copy of the world it asks quick " +
                    "questions: is this indoors, in water, which dungeon room...). The void probe only hits the cube faces " +
                    "marked for it: ground without them doesn't keep Link from voiding.";
                cubePick.add(new Option('cubes: off', ''));
                for (const [key, label] of views) cubePick.add(new Option(`cubes: ${label}`, key));
                if (views.some(v => v[0] === ootsw2KindShown.cubeView)) cubePick.value = ootsw2KindShown.cubeView;
                const cubeLegend = document.createElement('div');
                cubeLegend.className = 'ootsw2-surface-legend';
                const showCubes = () => {
                    drop(cubes);
                    cubes = null;
                    const view = views.find(v => v[0] === cubePick.value);
                    cubeLegend.style.display = view ? '' : 'none';
                    if (!view) return;
                    put('Cubes', cubes = buildVoxelPoints(tiles(), view[0]));
                    cubeLegend.innerHTML = view[3].map(([label, color]) => `<span><i style="background:${color}"></i>${label}</span>`).join('') +
                        `<span>${cubes.userData.count} cubes</span>`;
                };
                cubePick.addEventListener('change', () => { ootsw2KindShown.cubeView = cubePick.value; showCubes(); });
                line.append(cubePick);

                if (variantNames.length) {
                    const pick = document.createElement('select');
                    pick.className = 'ootsw2-highlight';
                    pick.title = 'Story state: some volume tiles have one version per state (tomb open or closed, water level...)';
                    pick.add(new Option('story state: default', ''));
                    for (const v of variantNames) pick.add(new Option(v.replace(/_/g, ' '), v));
                    pick.addEventListener('change', () => {
                        variant = pick.value;
                        voxelSet = null;
                        drop(voidMap);
                        drop(floorMap);
                        voidMap = floorMap = null;
                        status.textContent = '';
                        showCubes();
                    });
                    line.append(pick);
                }

                const stepPick = document.createElement('select');
                stepPick.className = 'ootsw2-highlight';
                [['1 m grid, 30 m around', 1, 61], ['2 m grid, 40 m around', 2, 41], ['4 m grid, 80 m around', 4, 41]]
                    .forEach(([label, step, side], i) => { const o = new Option(label, `${step},${side}`); o.selected = i === 1; stepPick.add(o); });
                const lift = document.createElement('input');
                lift.type = 'number';
                lift.step = '0.5';
                lift.value = '0';
                lift.style.width = '4.5em';
                lift.title = 'Height of the scanned plane above the cube the camera looks at (metres); 0 = standing on it';
                const scan = document.createElement('button');
                scan.textContent = 'void map here';
                scan.title = `Runs the game's void probe (64 rays, nearest cube; void at ${VOID_RADIUS} m or more sideways) on a ` +
                    'grid around the point at the screen centre. Green: under 6 m sideways, yellow: under 8, red: Link ' +
                    'voids there while in the air (the check only runs off the ground), ' +
                    'dark red: no cube at all. White dots: the cube each point found.';
                scan.addEventListener('click', async () => {
                    const set = getSet();
                    const dir = new THREE.Vector3();
                    camera.getWorldDirection(dir);
                    const o = camera.position.clone().divideScalar(OOTSW2_SCALE);
                    const t = set.cast(o.x, o.y, o.z, dir.x, dir.y, dir.z);
                    let center = null;
                    if (t >= 0) {
                        const c = o.clone().addScaledVector(dir, t + 1e-3);
                        center = [c.x, Math.floor(c.y) + 1, c.z];   // top of the cube looked at
                    } else {
                        // no cube there: the collision surface at the screen centre
                        const ray = new THREE.Raycaster(camera.position, dir);
                        const meshes = [];
                        scene.traverseVisible(obj => { if (obj.isMesh && !obj.userData.unselectable && obj.material?.opacity === 1) meshes.push(obj); });
                        const hit = ray.intersectObjects(meshes, false)[0];
                        if (hit) center = hit.point.divideScalar(OOTSW2_SCALE).toArray();
                        else if (controlMode === 'orbit' && orbitControls) center = orbitControls.target.clone().divideScalar(OOTSW2_SCALE).toArray();
                    }
                    if (!center) {
                        status.textContent = 'look at the ground first (nothing under the screen centre)';
                        return;
                    }
                    const [step, side] = stepPick.value.split(',').map(Number);
                    const y = center[1] + (parseFloat(lift.value) || 0);
                    drop(voidMap);
                    voidMap = null;
                    scan.disabled = true;
                    const { group, counts } = await buildVoidMap(set, center[0], y, center[2], step, side,
                        (done, total) => { status.textContent = `void map ${done} / ${total}`; });
                    scan.disabled = false;
                    put('Void map', voidMap = group);
                    status.textContent = `void map at ${center[0].toFixed(1)}, ${y.toFixed(1)}, ${center[2].toFixed(1)}: ` +
                        `${counts.safe} safe, ${counts.near} near, ${counts.void + counts.none} void`;
                });
                // Whole map: every walkable floor spot, coloured by the probe
                const floorStep = document.createElement('select');
                floorStep.className = 'ootsw2-highlight';
                [['1 m spots', 1], ['2 m spots', 2], ['4 m spots', 4]]
                    .forEach(([label, step], i) => { const o = new Option(label, String(step)); o.selected = i === 1; floorStep.add(o); });
                const whole = document.createElement('button');
                whole.textContent = 'void map: whole floor';
                whole.title = 'Runs the void probe standing on every walkable floor of the map (one spot per grid square ' +
                    'and floor level) and colours the floor: green safe, yellow close, red: Link voids if he leaves the ground ' +
                    'there (jumps, falls, gets knocked back); standing and walking on it is fine, the check only runs in the air, ' +
                    'dark red no cube at all. "void map here" checks a height in the air instead (jumps, falls).';
                whole.addEventListener('click', async () => {
                    if (!staticSource.indices.length) { status.textContent = 'no static collision'; return; }
                    const set = getSet();
                    drop(floorMap);
                    floorMap = null;
                    whole.disabled = true;
                    const t0 = performance.now();
                    const keep = t => !['AirWall', 'DropItem'].includes(surfaceTable[staticSource.surfaces?.[t]]?.m);
                    const { points, counts } = await buildFloorVoidMap(set, staticSource, +floorStep.value, keep,
                        (done, total) => { status.textContent = `whole floor ${done} / ${total}`; });
                    whole.disabled = false;
                    put('Void map (floors)', floorMap = points);
                    const n = counts.safe + counts.near + counts.void + counts.none;
                    status.textContent = `whole floor: ${n} spots, ${counts.safe} safe, ${counts.near} close, ` +
                        `${counts.void + counts.none} void (${((performance.now() - t0) / 1000).toFixed(1)} s)`;
                });
                const clear = document.createElement('button');
                clear.textContent = 'clear';
                clear.addEventListener('click', () => {
                    drop(voidMap);
                    drop(floorMap);
                    voidMap = floorMap = null;
                    status.textContent = '';
                });
                const legend = document.createElement('div');
                legend.className = 'ootsw2-surface-legend';
                legend.innerHTML = [['under 6 m', VOID_COLORS.safe], ['6-8 m', VOID_COLORS.near],
                                    [`${VOID_RADIUS} m+ (void in the air)`, VOID_COLORS.void], ['no cube (void in the air)', VOID_COLORS.none]]
                    .map(([label, color]) => `<span><i style="background:${color}"></i>${label}</span>`).join('');
                const line2 = document.createElement('div');
                line2.className = 'ootsw2-surface-row';
                line2.append(whole, floorStep, scan, stepPick, lift, clear, status);
                kindRow.append(line, cubeLegend, line2, legend);
                showCubes();
            }

            // A see-through volume: { root, edges } like an actor row (root
            // for a row checkbox, its one child for the kind checkbox)
            const buildVolume = (name, list, color, kind, label) => {
                const typed = typedMeshList(list, objects);
                const mesh = buildOOTSW2Mesh(typed.positions, typed.indices, color, 0.3);
                mesh.name = name;
                mesh.renderOrder = 1;
                mesh.geometry.userData.triangleIds = lazyTriangleIds(typed.owners.length, k => label(objects[typed.owners[k]]));
                const root = new THREE.Group();
                root.name = name;
                root.add(mesh);
                scene.add(root);
                const edges = buildOOTSW2Edges([mesh]);
                scene.add(edges);
                joinKind(kind, mesh, edges.children[0]);
                loadedModels.push({ name, mesh: root, edges });
                return { root, edges, mesh };
            };
            // Loading zones: a row each, in a group
            if (areaData.zones.length) {
                const key = "ootsw2-zones";
                const group = getModelGroup(key, `Loading zones (${areaData.zones.length})`);
                const used = new Map();
                for (const zone of areaData.zones.sort((a, b) => a.label.localeCompare(b.label))) {
                    const n = (used.get(zone.label) ?? 0) + 1;
                    used.set(zone.label, n);
                    const rowName = n > 1 ? `${zone.label} #${n}` : zone.label;
                    const { root, edges, mesh } = buildVolume(rowName, zone.list, OOTSW2_ZONE_COLOR, 'zone',
                                                              o => `Loading zone ${zone.label}: ${o.nm ?? ''} ${o.h}`);
                    addModelCheckbox(scene, rowName, root, edges, false, true, OOTSW2_ZONE_COLOR, false, mesh, group.body);
                    edges.visible = root.visible && wireframeOn();
                    group.body.lastElementChild.title = `${zone.label}\n${zone.obj.nm ?? ''} ${zone.obj.h}` +
                        (zone.obj.zc || zone.obj.za ? `\nChild: ${zone.obj.zc ?? '-'}, Adult: ${zone.obj.za ?? '-'}` : '');
                }
                applyGroupMasterState(key);
            }
            // Areas: a group per category (Location areas, Void outs, Other
            // areas...), a row per actor name (location areas: per location).
            // Their Collision types checkbox still switches the whole category.
            const usedNames = new Set(loadedModels.map(m => m.name));
            for (const [kind, label, color] of areaKinds) {
                const parts = splitMeshList(areaData.areas[kind], o => areaData.rowKey(kind, o));
                const key = `ootsw2-area-${kind}`;
                const group = getModelGroup(key, `${label} (${parts.size})`);
                for (const [name, list] of [...parts].sort(([a], [b]) => a.localeCompare(b))) {
                    const count = new Set(list.owners).size;
                    let rowName = count > 1 ? `${name} ×${count}` : name;
                    if (usedNames.has(rowName)) rowName += ` (${label})`;
                    usedNames.add(rowName);
                    const { root, edges, mesh } = buildVolume(rowName, list, color, kind, areaData.labelOf);
                    addModelCheckbox(scene, rowName, root, edges, false, true, color, false, mesh, group.body);
                    edges.visible = root.visible && wireframeOn();
                    group.body.lastElementChild.title = `${label}: ${name}, ${count} object${count > 1 ? 's' : ''}`;
                }
                applyGroupMasterState(key);
            }

            // Links: a line per link between two objects of this map, from the
            // source (yellow) to the target (cyan); only the "links" checkbox
            if (linkCount) {
                const pos = new Float32Array(linkCount * 6), col = new Float32Array(linkCount * 6);
                const src = new THREE.Color(0xffd040), dst = new THREE.Color(0x40e0ff);
                let k = 0;
                for (const o of objects) {
                    for (const [h] of o.l ?? []) {
                        const target = byHash.get(h);
                        if (!target) continue;
                        pos.set(o.p.map(v => v * OOTSW2_SCALE), k * 6);
                        pos.set(target.p.map(v => v * OOTSW2_SCALE), k * 6 + 3);
                        col.set([src.r, src.g, src.b, dst.r, dst.g, dst.b], k * 6);
                        k++;
                    }
                }
                const geom = new THREE.BufferGeometry();
                geom.setAttribute('position', new THREE.BufferAttribute(pos, 3));
                geom.setAttribute('color', new THREE.BufferAttribute(col, 3));
                const lines = new THREE.LineSegments(geom, new THREE.LineBasicMaterial({ vertexColors: true, depthTest: false, transparent: true, opacity: 0.8 }));
                lines.name = "Links";
                lines.renderOrder = 2;
                lines.userData.unselectable = true;
                scene.add(lines);
                loadedModels.push({ name: "Links", mesh: lines, edges: null });
                joinKind('link', lines, new THREE.Object3D());
            }

            const compoundBox = new THREE.Box3();
            const bounds = getMapProperty(game, mapName, "bounds");
            if (compound && bounds) compoundBox.set(new THREE.Vector3(bounds[0], 0, bounds[2]).multiplyScalar(OOTSW2_SCALE),
                                                    new THREE.Vector3(bounds[1], 0, bounds[3]).multiplyScalar(OOTSW2_SCALE));

            const points = buildOOTSW2ObjectPoints(objects);
            points.name = "Objects";
            points.userData.bkInfo = `Objects: ${objects.length} placed objects`;
            scene.add(points);
            loadedModels.push({ name: "Objects", root: points, mesh: points, edges: null });
            addModelCheckbox(scene, "Objects", points, null, false, false, '#ffd040', false, null);

            const tris = sources.map(s => `${s.indices.length / 3} ${KIND_LABELS[s.kind]}`).join(', ');
            console.log(`${mapDir}: ${objects.length} objects, ${col.counts.placed} placed from collision.bin ` +
                        `(${col.counts.skipped} in the compound, ${col.counts.noShape} without a shape); ` +
                        `${actorRows.length} actor rows in ${categories.size} groups; triangles: ${tris}` +
                        (compound ? `; ${compound.chunks.length} tiles (${compound.chunks.filter(c => c.level > 0).length} at lod1)` : ''));

            // Start over the middle of the map (maps.json bounds, else the
            // rebuilt terrain), at the objects' height, looking down
            const box = new THREE.Box3().setFromPoints((col.terrain.verts.length ? col.terrain.verts : objects.map(o => o.p.map(v => v * OOTSW2_SCALE)))
                .map(v => new THREE.Vector3(...v)));
            if (!compoundBox.isEmpty()) {
                compoundBox.min.y = box.isEmpty() ? 0 : box.min.y;
                compoundBox.max.y = box.isEmpty() ? 0 : box.max.y;
                box.copy(compoundBox);
            }
            if (!box.isEmpty()) {
                const c = box.getCenter(new THREE.Vector3()), size = box.getSize(new THREE.Vector3());
                setCameraPose([c.x, box.max.y + Math.max(size.x, size.z) * 0.4, c.z + Math.max(size.x, size.z) * 0.4], -0.8, 0);
                if (orbitControls) orbitControls.target.copy(c);
            }
        } catch (err) {
            console.error(err);
        }
    }
    else if (game == "OOT" || game == "MM" || game == "OOT3D" || game == "MM3D"){
        const mapName = document.getElementById("mapDropdown").value;
        let mapFilename = getMapProperty(game, mapName, "file");

        try {
            const res1 = await fetch('./models/' + game + '/' + mapFilename);
            const buffer1 = await res1.arrayBuffer();
            console.log(mapFilename+": Binary file length:", buffer1.byteLength);
            await showLoading(`${mapName}: scene…`);
            parseZeldaSceneBinary(scene, buffer1, true, mapName, mapFilename);

            // OOT / MM: the rooms' display lists, textured (zelda_textured.js).
            // models/<game>/<scene>_room_<n>, see tools/oot/import_oot_rooms.py
            // and tools/mm/import_mm_rooms.py.
            // With the group last left unchecked, nothing is fetched or built
            // until it is checked again (deferGroupBuild).
            const buildRooms = async () => {
                const { numRooms } = parseZeldaSceneInfo(buffer1);
                const rooms = [];
                for (let i = 0; i < numRooms; i++) {
                    const file = zeldaRoomFileName(game, mapFilename, i);
                    const res = await fetch(`./models/${game}/${file}`);
                    if (!res.ok) { console.warn(`${file}: ${res.status}`); continue; }
                    rooms.push({ index: i, buffer: await res.arrayBuffer() });
                }
                let areaTextures = null;
                const areaFile = zeldaAreaTextureFileName(game, buffer1);
                if (areaFile) {
                    const res = await fetch(`./models/${game}/${areaFile}`);
                    if (res.ok) areaTextures = await res.arrayBuffer();
                    else console.warn(`${areaFile}: ${res.status}`);
                }
                renderZeldaSceneTextured(scene, buffer1, rooms, mapFilename, { game, areaTextures });
            };
            if ((game == "OOT" || game == "MM") && !deferGroupBuild(ROOM_GROUP_KEY, 'Textured Rooms', buildRooms)) {
                await showLoading(`${mapName}: textured rooms…`);
                await buildRooms();
            }

            // OOT / MM: every actor of the selected setup, drawn with its model
            // (oot_actors.js), dynapoly collision in the same rows.
            if ((game == "OOT" || game == "MM") && areaActors) {
                await showLoading(`${mapName}: actors…`);
                await renderOOTActors(scene, buffer1, mapFilename, game);
            }
            // OOT3D / MM3D: no actor rows, but the loading planes (En_Holl) are
            // read from the scene's transition actor list (loading_planes.js).
            if (game == "OOT3D" || game == "MM3D") renderLoadingPlanes3DS(scene, buffer1, game, mapFilename);

            // The map is in: wall_push_clips.js auto-imports its results
            if (game == "OOT" || game == "MM" || game == "OOT3D" || game == "MM3D") {
                document.dispatchEvent(new CustomEvent("zeldamaploaded", {
                    detail: { game, map: mapName, setup: Number(setupDropdown.value || 0) },
                }));
            }


            /* if (game == "OOT" || game == "MM" || game == "OOT3D" || game == "MM3D") {
                let mapFilename2 = getMapProperty(game, mapName, "seams");
                if (mapFilename2 === undefined) {
                
                }
                else {
                    let seams_path = "seams";
                    if (game == "OOT3D" || game == "MM3D" || game == "MM" || game == "OOT")
                        seams_path = "seams2";
                    
                    const res2 = await fetch('./models/' + game + '/' + seams_path + '/' + mapFilename2);
                    //const res2 = await fetch('./models/' + game + '/' + seams_path + '/' + "test.txt");
                        
                    const buffer2 = await res2.arrayBuffer();
                    console.log(mapFilename2+": Binary file length:", buffer2.byteLength);
                    
                    parseInvisibleSeams1D(scene, new TextDecoder().decode(buffer2));
                }
            } */
        } catch (err) {
            console.error(err);
        }
    }
}

// Get actor property
function getActorProperty(game, id, prop) {
    const actors = GAME_ACTORS[game];
    if (!actors) return null;

    const found = actors.find(actor => actor.list_index === id);
    return found ? found[prop] ?? null : null;
}

// Get collision property
function getCollisionProperty(game, collisionName, prop) {
    const collisions = GAME_COLLISIONS[game];
    if (!collisions) return null;

    const found = collisions.find(collision => collision.collision_name === collisionName);
    return found ? found[prop] ?? null : null;
}

// Load selected actor
loadActor.addEventListener('click', async (e) => {
    const game = document.getElementById("selected-game").value;
    
    if (game == "OOT" || game == "MM"){
        let id = parseInt(document.getElementById("actorDropdown").value, 10);
        let actorName = getActorProperty(game, id, "actor_name");
        let collisionName = getActorProperty(game, id, "collision_name");
        let objectName = getCollisionProperty(game, collisionName, "file_name");
        let actorOffset = getCollisionProperty(game, collisionName, "offset");

        try {
            const res1 = await fetch('./models/' + game + '/actors/objects/' + objectName);
            const buffer1 = await res1.arrayBuffer();
            console.log(objectName+": Binary file length:", buffer1.byteLength);
            renderZeldaObjectBinary(scene, buffer1, true, actorName, objectName, actorOffset);
        } catch (err) {
            console.error(err);
        }
    }
});

////////////////////////////////////////
// System: File input (user-supplied file)
////////////////////////////////////////

// File parsing
fileInput.addEventListener('change', async (ev)=>{
    const f = ev.target.files[0];
    document.getElementById('fileName').textContent = f ? f.name : '';
    if(!f) return;
    const buf = await f.arrayBuffer();
    const game = document.getElementById("selected-game").value;
    if (game == "OOT" || game == "MM") {
        loadActorsInSceneJSON(game, f.name)
    }
    if (game == "BT") await loadBTModelTextures(buf);
    parseModel(scene, buf, f.name);
});

////////////////////////////////////////
// System: Canvas / Pointer interactions
////////////////////////////////////////
// PointerLockControls is attached to a throwaway object, NOT the camera. We only
// want its lock()/unlock() plumbing; its own mouse-look math round-trips the
// camera quaternion through a YXZ Euler every frame, which can decompose to a
// z=±PI representation and then get its roll discarded -> sudden 180 flip.
// Camera orientation is driven by the yaw/pitch state below instead.
const _pointerLockProxy = new THREE.Object3D();
const pointerControls = new PointerLockControls(_pointerLockProxy, renderer.domElement);
let pointerLockBlocked = false; // whether requestPointerLock is blocked (sandboxed iframe)

// Authoritative mouse-look state. Never read back from camera.quaternion.
const LOOK_SENSITIVITY = 0.002;
const PITCH_LIMIT = Math.PI/2 - 0.001; // stay strictly inside the poles
const _lookEuler = new THREE.Euler(0, 0, 0, 'YXZ');
let yaw = 0, pitch = 0;

// Seed yaw/pitch once from whatever orientation the camera was set up with.
{
    const seed = new THREE.Euler().setFromQuaternion(camera.quaternion, 'YXZ');
    yaw = seed.y;
    pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, seed.x));
    _lookEuler.set(pitch, yaw, 0, 'YXZ');
    camera.quaternion.setFromEuler(_lookEuler);
}

// Pointer lock occasionally reports a huge bogus delta in a single event --
// on the first event after lock, after an OS cursor warp, or when the physical
// cursor hits a screen edge. Observed values around 540px, which at the
// sensitivity below is ~60 degrees of yaw in one frame. Real hand motion between
// two events never gets close to this, so anything past the threshold is dropped
// rather than clamped (clamping would still apply a large bogus turn).
const MAX_MOVEMENT_PX = 200;

renderer.domElement.ownerDocument.addEventListener('mousemove', (ev)=>{
    if(document.pointerLockElement !== renderer.domElement) return;
    if(controlMode === 'orbit') return;
    const dx = ev.movementX || 0;
    const dy = ev.movementY || 0;
    if(Math.abs(dx) > MAX_MOVEMENT_PX || Math.abs(dy) > MAX_MOVEMENT_PX) return;
    yaw   -= dx * LOOK_SENSITIVITY;
    pitch -= dy * LOOK_SENSITIVITY;
    pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, pitch));
    _lookEuler.set(pitch, yaw, 0, 'YXZ');
    camera.quaternion.setFromEuler(_lookEuler);
});

renderer.domElement.addEventListener('click', (ev)=>{
    // If user explicitly selected Orbit mode, always treat click as selection (no pointer lock)
    if(controlMode === 'orbit'){
        let pts = performSelection(ev, renderer, camera, scene);
        if (pts)
            addModelCheckbox(scene, "Points", pts, null, false, true, "#ff0000", true);
        return;
    }

    // If pointer already locked on our canvas, treat click as selection
    if(document.pointerLockElement === renderer.domElement){
        let pts = performSelection(ev, renderer, camera, scene);
        if (pts)
            addModelCheckbox(scene, "Points", pts, null, false, true, "#ff0000", true);
        return;
    }

    // If user chose Pointer mode or Auto, try to acquire pointer lock on canvas
    if(controlMode === 'pointer' /*|| controlMode === 'auto'*/){
        try{
            // Attempt to lock; this may throw in sandboxed frames.
            pointerControls.lock();
            setStatus('requesting mouse lock...');
        }catch(err){
            // SecurityError when iframe sandbox blocks pointer lock
            console.warn('Mouse lock request failed:', err);
            pointerLockBlocked = true;
            //setStatus('Mouse lock blocked (sandbox or permission). Falling back to orbit controls.', 'warn');
            //enableOrbitControls();
        }
    }
});

// Listen for pointerlockchange/pointerlockerror to update status
document.addEventListener('pointerlockchange', ()=>{
    if(document.pointerLockElement === renderer.domElement){
        setStatus('Mouse locked. WASD to fly. Click again to select triangles. Press Esc to unlock.');
    } else {
        setStatus('Mouse unlocked.');
    }
});

document.addEventListener('pointerlockerror', (ev)=>{
    console.warn('pointerlockerror', ev);
    pointerLockBlocked = true;
    //setStatus('Mouse lock error — falling back to orbit controls.', 'error');
    //enableOrbitControls();
});

// Control mode selector
// The flying speed only matters in Fly mode
const movementSpeedRow = document.getElementById('movementSpeedRow');
const showSpeedRow = () => { movementSpeedRow.style.display = controlModeSel.value === 'orbit' ? 'none' : ''; };
showSpeedRow();

controlModeSel.addEventListener('change',(e)=>{
    controlMode = e.target.value;
    showSpeedRow();
    if(controlMode === 'orbit'){
        enableOrbitControls();
    }else if(controlMode === 'pointer'){
        // try to exit orbit and enable pointer behavior
        disableOrbitControls();
        setStatus('Fly mode selected. Click the canvas to request mouse lock.');
    }else{ // auto
        if(pointerLockBlocked){
            enableOrbitControls();
        } else {
            disableOrbitControls();
            setStatus('Auto mode: click canvas to request mouse lock.');
        }
    }
});

function onWindowResize(){
    const w = renderer.domElement.clientWidth || window.innerWidth - 320;
    const h = renderer.domElement.clientHeight || window.innerHeight;
    if(h===0 || w===0) return;
    camera.aspect = w/h;
    camera.updateProjectionMatrix();
    renderer.setSize(w,h,false);
}
window.addEventListener('resize', onWindowResize);

////////////////////////////////////////
// System: Fly/Orbit controls
////////////////////////////////////////

let orbitControls = null; // lazy-created when needed

function enableOrbitControls(){
    if(orbitControls) return;
    try{
        if(document.pointerLockElement === renderer.domElement) document.exitPointerLock?.();
    }catch(e){ console.warn('exitPointerLock failed', e); }
    orbitControls = new OrbitControls(camera, renderer.domElement);
    orbitControls.enableDamping = true;
    orbitControls.dampingFactor = 0.08;
    orbitControls.screenSpacePanning = false;
    orbitControls.enablePan = true;
    
    // Hide crosshair in orbit mode
    if (crosshair) crosshair.style.display = 'none';
    if (hint) hint.style.display = 'none';
    
    setStatus('Orbit controls active (drag to rotate, scroll to zoom).');
}

function disableOrbitControls(){
    if(!orbitControls) return;
    orbitControls.dispose();
    orbitControls = null;
    
    // Show crosshair in fly mode
    if (crosshair) crosshair.style.display = 'block';
    if (hint) hint.style.display = 'block';
    
    setStatus('Orbit controls disabled.');
}

// Movement keyboard (only affects pointer-lock / fly mode)
document.addEventListener('keydown',(e)=>{
    // typing in a text field (e.g. the camera Go to boxes) doesn't fly the camera
    if(e.target.closest?.('input[type=text], input[type=number], textarea')) return;
    if(e.code==='KeyW') move.forward=true;
    if(e.code==='KeyS') move.back=true;
    if(e.code==='KeyA') move.left=true;
    if(e.code==='KeyD') move.right=true;
    if(e.code==='Space') move.up=true;
    if(e.code==='KeyC') move.down=true;
});
document.addEventListener('keyup',(e)=>{
    if(e.code==='KeyW') move.forward=false;
    if(e.code==='KeyS') move.back=false;
    if(e.code==='KeyA') move.left=false;
    if(e.code==='KeyD') move.right=false;
    if(e.code==='Space') move.up=false;
    if(e.code==='KeyC') move.down=false;
});

////////////////////////////////////////
// System: Camera "Go to" / "Go to poly"
////////////////////////////////////////

const gotoPosEl = document.getElementById('gotoPos');
const gotoRotEl = document.getElementById('gotoRot');
const gotoPolyEl = document.getElementById('gotoPoly');
const gotoStatusEl = document.getElementById('gotoStatus');

// "x, y, z" (commas and / or spaces) -> [x, y, z], or null
function parseTriple(text) {
    const parts = text.trim().split(/[\s,]+/).filter(Boolean).map(Number);
    return parts.length === 3 && parts.every(Number.isFinite) ? parts : null;
}

// Put the camera at pos looking along the mouse-look yaw / pitch (radians);
// roll only lasts until the mouse turns the camera again. Orbit mode orbits a
// point straight ahead.
function setCameraPose(pos, newPitch, newYaw, roll = 0) {
    camera.position.set(pos[0], pos[1], pos[2]);
    yaw = newYaw;
    pitch = Math.max(-PITCH_LIMIT, Math.min(PITCH_LIMIT, newPitch));
    _lookEuler.set(pitch, yaw, roll, 'YXZ');
    camera.quaternion.setFromEuler(_lookEuler);
    if (orbitControls) {
        const dist = Math.max(orbitControls.target.distanceTo(camera.position), 50);
        orbitControls.target.copy(camera.position)
            .add(new THREE.Vector3(0, 0, -dist).applyQuaternion(camera.quaternion));
    }
}

function gotoPosition() {
    const pos = parseTriple(gotoPosEl.value);
    if (!pos) { gotoStatusEl.textContent = 'pos: enter x, y, z'; return; }
    let rot = null;
    if (gotoRotEl.value.trim()) {
        rot = parseTriple(gotoRotEl.value);
        if (!rot) { gotoStatusEl.textContent = 'rot: enter pitch, yaw, roll in degrees, or leave it empty'; return; }
    }
    const deg = THREE.MathUtils.degToRad;
    if (rot) {
        setCameraPose(pos, deg(rot[0]), deg(rot[1]), deg(rot[2]));
    } else {
        // keep the current view direction
        const cur = new THREE.Euler().setFromQuaternion(camera.quaternion, 'YXZ');
        setCameraPose(pos, cur.x, cur.y, cur.z);
    }
    gotoStatusEl.textContent = '';
}

// Every loaded collision triangle whose id (the TRI line's: userData.triangles
// metadata or geometry.userData.triangleIds) is `query`, in sidebar order
// (the map first), as { object, faceIndex }.
function findPolys(query) {
    const norm = v => String(v).trim().toLowerCase().replace(/\s+/g, ' ');
    const want = norm(query);
    const found = [];
    const seen = new Set();   // a mesh can sit under two entries (DK64's Main Model group and its rows)
    for (const m of loadedModels) {
        m.mesh?.traverse(obj => {
            if (!obj.isMesh || !obj.geometry?.index || seen.has(obj)) return;
            seen.add(obj);
            const meta = obj.userData.triangles;
            const ids = obj.geometry.userData.triangleIds;
            if (!meta && !ids) return;
            const count = obj.geometry.index.count / 3;
            for (let i = 0; i < count; i++) {
                const id = meta ? meta[i]?.id : ids[i];
                if (id != null && norm(id) === want) found.push({ object: obj, faceIndex: i, model: m.name });
            }
        });
    }
    return found;
}

// Repeated clicks with the same id step through its matches (props share ids).
let gotoPolyState = { query: null, next: 0 };

function gotoPoly() {
    const query = gotoPolyEl.value.trim();
    if (!query) { gotoStatusEl.textContent = 'poly: enter an id'; return; }
    const found = findPolys(query);
    if (!found.length) { gotoStatusEl.textContent = `no loaded polygon has id "${query}"`; return; }
    if (gotoPolyState.query !== query) gotoPolyState = { query, next: 0 };
    const k = gotoPolyState.next % found.length;
    gotoPolyState.next = k + 1;
    const { object, faceIndex, model } = found[k];

    object.updateWorldMatrix(true, false);
    const index = object.geometry.index, pos = object.geometry.attributes.position;
    const face = { a: index.getX(3 * faceIndex), b: index.getX(3 * faceIndex + 1), c: index.getX(3 * faceIndex + 2) };
    const [va, vb, vc] = [face.a, face.b, face.c].map(i => new THREE.Vector3().fromBufferAttribute(pos, i).applyMatrix4(object.matrixWorld));

    // look at the centroid from the front side, far enough back to see the whole triangle
    const centre = va.clone().add(vb).add(vc).divideScalar(3);
    const normal = vb.clone().sub(va).cross(vc.clone().sub(va));
    if (normal.lengthSq() < 1e-12) normal.set(0, 1, 0);
    normal.normalize();
    const size = Math.max(va.distanceTo(vb), vb.distanceTo(vc), vc.distanceTo(va));
    const eye = centre.clone().addScaledVector(normal, Math.max(size * 1.2, 60));
    const dir = centre.clone().sub(eye).normalize();
    setCameraPose(eye.toArray(), Math.asin(dir.y), Math.atan2(-dir.x, -dir.z));
    if (orbitControls) orbitControls.target.copy(centre);

    const pts = selectHit({ object, faceIndex, face }, scene, false);
    if (pts) addModelCheckbox(scene, "Points", pts, null, false, true, "#ff0000", true);
    gotoStatusEl.textContent = found.length > 1
        ? `${model}: match ${k + 1} of ${found.length} (click again for the next)` : model;
}

document.getElementById('gotoBtn').addEventListener('click', gotoPosition);
document.getElementById('gotoPolyBtn').addEventListener('click', gotoPoly);
for (const [el, run] of [[gotoPosEl, gotoPosition], [gotoRotEl, gotoPosition], [gotoPolyEl, gotoPoly]])
    el.addEventListener('keydown', e => { if (e.key === 'Enter') run(); });

async function fetchActorsByAreaJSON(path, sceneName) {
    try {
        // (revalidated every time: python http.server sends no cache headers,
        // so a regenerated file would otherwise stay stale in the cache)
        const response = await fetch(path, { cache: "no-cache" });
        let data = await response.json();

        const areaActors = data[sceneName];

        data = null;

        return areaActors;
    } catch (error) {
        console.error('Failed to fetch or parse JSON:', error);
        return null;
    }
}

async function loadActorsInSceneJSON(game, sceneName) {
    let json_path = null;

    // ------------------------------------------------------------
    // Load actors-by-scene JSON
    // ------------------------------------------------------------
    json_path = './models/' + game + '/actors/' + game + '_actors_by_scene.json';
    areaActors = await fetchActorsByAreaJSON(json_path, sceneName);
    if (!areaActors) {
        console.log("Failed to parse 'actors by scene' json: " + sceneName);
        return;
    }
    //console.log(areaActors);

    const setupDropdown = document.getElementById("setupDropdown");
    setupDropdown.options.length = 0;
    for (let i = 0; i < areaActors.length; i++) {
        if(areaActors[i] != null) {
            const option = document.createElement("option");
            option.value = i; // This will be the value when selected
            option.textContent = i; // This is what’s shown to the user
            setupDropdown.appendChild(option);
        }
    }
}

////////////////////////////////////////
// System: Rendering loop
////////////////////////////////////////

let last = performance.now();

// Hoisted scratch objects (previously allocated every frame)
const _moveDir = new THREE.Vector3();
const _readoutEuler = new THREE.Euler(0, 0, 0, 'YXZ');

////////////////////////////////////////
// System: Depth pre-pass
////////////////////////////////////////
//
// Toggle from the console: window.__enableDepthPrepass = false
//
// The collision mesh's triangles aren't submitted in any front-to-back
// order - they're just in whatever order the file happened to store them
// in. In a part of the level with real depth complexity (walls behind
// walls, floors under floors, nested rooms), that means a far/hidden
// surface can get fully fragment-shaded, only for a closer surface drawn
// afterward to completely cover it on screen - paying real shading cost for
// pixels whose final visible color came from something else entirely.
//
// This renders the whole scene once first, depth-only (colorWrite disabled,
// cheapest possible unlit shader, so this pass itself is nearly free per
// pixel), which fills the depth buffer with the true nearest-surface depth
// everywhere. The second, real, color pass's depth test then rejects a
// hidden fragment before it ever reaches the real fragment shader, instead
// of after - regardless of submission order.
window.__enableDepthPrepass = false;
const depthPrepassMaterial = new THREE.MeshBasicMaterial({ colorWrite: false });

function animate(){
    requestAnimationFrame(animate);
    const now = performance.now();
    const dt = Math.min(0.05,(now-last)/1000);
    last = now;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.0));

    if(controlMode !== 'orbit' && document.pointerLockElement === renderer.domElement){
        // Apply WASD movement in pointer-lock mode
        _moveDir.set(0,0,0);
        if(move.forward) _moveDir.z -= 1;
        if(move.back) _moveDir.z += 1;
        if(move.left) _moveDir.x -= 1;
        if(move.right) _moveDir.x += 1;
        if(move.up) _moveDir.y += 1;
        if(move.down) _moveDir.y -= 1;
        if(_moveDir.lengthSq()>0){
            _moveDir.normalize()
                .applyQuaternion(camera.quaternion)
                .multiplyScalar(speed*dt);
            camera.position.add(_moveDir);
        }
    }

    // Update UI
    camPosEl.textContent = `${camera.position.x.toFixed(2)}, ${camera.position.y.toFixed(2)}, ${camera.position.z.toFixed(2)}`;
    _readoutEuler.setFromQuaternion(camera.quaternion, 'YXZ');
    camRotEl.textContent = `${THREE.MathUtils.radToDeg(_readoutEuler.x).toFixed(1)}, ${THREE.MathUtils.radToDeg(_readoutEuler.y).toFixed(1)}, ${THREE.MathUtils.radToDeg(_readoutEuler.z).toFixed(1)}`;

    // Update orbit controls if active
    if(orbitControls) orbitControls.update();

    // update edges transformation if any
    if(edges && mesh){ edges.position.copy(mesh.position); edges.rotation.copy(mesh.rotation); }

    // BK / BT sky dome / clouds: drawn first as their own pass (sky.js),
    // after which the main scene must not clear the frame.
    const afterSky = drawSky(renderer, scene, camera, now / 1000);

    if (window.__enableDepthPrepass) {
        // Match whatever culling mode the real materials are currently
        // using, so the prepass doesn't write depth for backfaces the real
        // pass would have culled away (which would make the prepass depth
        // wrong - too close - and cause the real pass to wrongly reject
        // fragments that should be visible).
        depthPrepassMaterial.side = backfaceCheckbox.checked ? THREE.DoubleSide : THREE.FrontSide;
        scene.overrideMaterial = depthPrepassMaterial;
        renderer.render(scene, camera);
        scene.overrideMaterial = null;
    }

    renderer.render(scene,camera);
    afterSky?.();
}
onWindowResize();
animate();

// Build a test cube model
buildTest(scene);

// expose a tiny helpful function on window for quick testing
window.__3dv = { parseModelText, parseModelBinary, camera, renderer, scene };

////////////////////////////////////////
// System: Initialization checks
////////////////////////////////////////

// Initial status: determine starting mode
(function initStatus(){
    // If the environment is clearly sandboxed (iframe), we cannot reliably request pointer lock.
    try{
        // Some browsers throw immediately when calling requestPointerLock in a sandbox; we don't call it here — just detect availability.
        const supported = 'requestPointerLock' in Element.prototype;
        if(!supported){ pointerLockBlocked = true; setStatus('Pointer lock not supported in this environment; orbit controls enabled.', 'warn'); enableOrbitControls(); return; }
        setStatus('Ready. Click canvas to request mouse lock (Auto).');
    }catch(e){
        pointerLockBlocked = true;
        setStatus('Mouse lock appears unavailable; orbit controls enabled.', 'warn');
        enableOrbitControls();
    }
})();
