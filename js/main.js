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
import { performSelection, clearSelection } from './selection.js';
import { parseModel, parseModelText, parseModelBinary, parseBKModelBinary, parseZeldaSceneBinary, parseInvisibleSeams1D } from './parse_model.js';
import { renderZeldaObjectBinary } from './render_actors.js';
import { addModelCheckbox, buildTest } from './render.js';

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
const controlModeSel = document.getElementById('control-mode');
const gameSel = document.getElementById('selected-game');
const subdivisionSelectorContainer = document.getElementById("subdivisionSelectorContainer");
const waterboxCheckboxElement = document.getElementById("waterboxCheckboxDiv");
const groundClipBandsLabel = document.getElementById("groundClipBandsLabel");

const display_fwc = document.getElementById('display_fwc');
const display_fwc_label = document.getElementById('display_fwc_label');

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

const camera = new THREE.PerspectiveCamera(60,2,0.1,100000);
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

            if (obj.isMesh && obj.material) {

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
    OOT: OOT_Maps,
    MM: MM_Maps,
    OOT3D: OOT3D_Maps,
    MM3D: MM3D_Maps,
};

// Map each game to its data array
const GAME_ACTORS = {
    BK: null,
    BT: null,
    OOT: OOT_Dynapoly_Actors,
    MM: MM_Dynapoly_Actors,
    OOT3D: null,
    MM3D: null,
};

const GAME_COLLISIONS = {
    BK: null,
    BT: null,
    OOT: OOT_Dynapoly_Collisions,
    MM: MM_Dynapoly_Collisions,
    OOT3D: null,
    MM3D: null,
};

gameSel.addEventListener('change',(e)=>{
    game = e.target.value;
    mapDropdown.options.length = 0;
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
    
    maps.forEach(map => {
        const option = document.createElement("option");
        option.value = map.name; // This will be the value when selected
        option.textContent = map.name; // This is what’s shown to the user
        mapDropdown.appendChild(option);
    });
    if(actors) {
        actors.forEach(actor => {
            const option = document.createElement("option");
            option.value = actor.list_index; // This will be the value when selected
            option.textContent = actor.actor_name + ": " + actor.actor_description; // This is what’s shown to the user
            actorDropdown.appendChild(option);
        });
    }
    
    if (game == "BK" || game == "BT") {
        display_fwc_label.style.display = "none";
        dropdownElement.style.display = "none";
        waterboxCheckboxElement.style.display = "none";
        subdivisionSelectorContainer.style.display = "none";
        groundClipBandsLabel.style.display = "none";
    }
    else {
        display_fwc_label.style.display = "block";
        dropdownElement.style.display = "block";
        waterboxCheckboxElement.style.display = "block";
        subdivisionSelectorContainer.style.display = "block";
        groundClipBandsLabel.style.display = "block";
    }

    if (["OOT","MM"].includes(game)) {
        actorDropdown.style.display = "block";
        loadActor.style.display = "block";
        setupDropdownDiv.style.display = "flex";
        
        const game = document.getElementById("selected-game").value;
        if (game == "OOT" || game == "MM") {
            const mapName = document.getElementById("mapDropdown").value;
            let mapFilename = getMapProperty(game, mapName, "file");
            loadActorsInSceneJSON(game, mapFilename)
        }
    }
    else {
        actorDropdown.style.display = "none";
        loadActor.style.display = "none";
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
loadMap.addEventListener('click', async (e) => {
    const game = document.getElementById("selected-game").value;
    
    if (game == "BK" || game == "BT"){
        
        const mapName = document.getElementById("mapDropdown").value;
        let mapFilename = getMapProperty(game, mapName, "modelAPointer");
        let mapFilename2 = getMapProperty(game, mapName, "modelBPointer");

        try {
            const res1 = await fetch('./models/' + game + '/' + mapFilename);
            const buffer1 = await res1.arrayBuffer();
            console.log(mapFilename+": Binary file length:", buffer1.byteLength);
            parseBKModelBinary(scene, buffer1, true);

            if (mapFilename2 === undefined) {
            
            }
            else {
                const res2 = await fetch('./models/' + game + '/' + mapFilename2);
                const buffer2 = await res2.arrayBuffer();
                console.log(mapFilename2+": Binary file length:", buffer2.byteLength);
                parseBKModelBinary(scene, buffer2, false);
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
            parseZeldaSceneBinary(scene, buffer1, true, mapName, mapFilename);
            

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
});

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
    if(!f) return;
    const buf = await f.arrayBuffer();
    const game = document.getElementById("selected-game").value;
    if (game == "OOT" || game == "MM") {
        loadActorsInSceneJSON(game, f.name)
    }
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
controlModeSel.addEventListener('change',(e)=>{
    controlMode = e.target.value;
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

async function fetchActorsByAreaJSON(path, sceneName) {
    try {
        const response = await fetch(path);
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
}
onWindowResize();
animate();

// Build a test cube model
buildTest(scene);

// expose a tiny helpful function on window for quick testing
window.__3dv = { parseModelText, parseModelBinary };

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
