////////////////////////////////////////
// Known Issues:
// - subdivisions are not considered for seams, so points or standable surfaces may be produced which are not actually standable
// - poly exclusion flags (xpflags) were not accounted for when generating the green line seams, 
// so some are fake in lost woods and kokiri
// - Some OoT3D Death mountain crater polys are showing as red standable surfances instead of blue
////////////////////////////////////////

////////////////////////////////////////
// Imports
////////////////////////////////////////

import * as THREE from 'three';
import { OrbitControls } from 'three/addons/controls/OrbitControls.js';
import { PointerLockControls } from 'three/addons/controls/PointerLockControls.js';
import { performSelection, clearSelection } from './selection.js';
import { parseModel, parseModelText, parseModelBinary, parseBKModelBinary, parseZeldaModelBinary, parseInvisibleSeams1D } from './parse_model.js';
import { addModelCheckbox, buildTest } from './render.js';

////////////////////////////////////////
// System: DOM / Static UI Elements
////////////////////////////////////////

const mapDropdown = document.getElementById("mapDropdown");
const fileInput = document.getElementById('file');
const loadMapButton = document.getElementById('loadMap');
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

const display_fwc = document.getElementById('display_fwc');
const display_fwc_label = document.getElementById('display_fwc_label');

////////////////////////////////////////
// System: Scene, Renderer, Camera, Lights
////////////////////////////////////////
let speed = 1500; // movement units per second
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

function setStatus(msg, level='info'){
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

gameSel.addEventListener('change',(e)=>{
    game = e.target.value;
    mapDropdown.options.length = 0;
    
    let maps = GAME_MAPS[game]
    
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
    
    if (game == "BK" || game == "BT")
        display_fwc_label.style.display = "none";
    else
        display_fwc_label.style.display = "block";
        
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
            parseZeldaModelBinary(scene, buffer1, true, mapName);
            
            if (game == "OOT" || game == "MM" || game == "OOT3D" || game == "MM3D") {
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
            }
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
    parseModel(scene, buf);
});

////////////////////////////////////////
// System: Canvas / Pointer interactions
////////////////////////////////////////
const pointerControls = new PointerLockControls(camera, renderer.domElement);
let pointerLockBlocked = false; // whether requestPointerLock is blocked (sandboxed iframe)

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

////////////////////////////////////////
// System: Rendering loop
////////////////////////////////////////

let last = performance.now();

function animate(){
    requestAnimationFrame(animate);
    const now = performance.now();
    const dt = Math.min(0.05,(now-last)/1000);
    last = now;
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.0));

    if(controlMode !== 'orbit' && document.pointerLockElement === renderer.domElement){
        // Apply WASD movement in pointer-lock mode
        const dir = new THREE.Vector3();
        if(move.forward) dir.z -= 1;
        if(move.back) dir.z += 1;
        if(move.left) dir.x -= 1;
        if(move.right) dir.x += 1;
        if(move.up) dir.y += 1;
        if(move.down) dir.y -= 1;
        if(dir.lengthSq()>0){
            dir.normalize();
            const worldDir = dir.applyQuaternion(camera.quaternion).multiplyScalar(speed*dt);
            pointerControls.getObject().position.add(worldDir);
            camera.position.copy(pointerControls.getObject().position);
        }
    }

    // Update UI
    camPosEl.textContent = `${camera.position.x.toFixed(2)}, ${camera.position.y.toFixed(2)}, ${camera.position.z.toFixed(2)}`;
    const euler = new THREE.Euler().setFromQuaternion(camera.quaternion);
    camRotEl.textContent = `${THREE.MathUtils.radToDeg(euler.x).toFixed(1)}, ${THREE.MathUtils.radToDeg(euler.y).toFixed(1)}, ${THREE.MathUtils.radToDeg(euler.z).toFixed(1)}`;

    // Update orbit controls if active
    if(orbitControls) orbitControls.update();

    // update edges transformation if any
    if(edges && mesh){ edges.position.copy(mesh.position); edges.rotation.copy(mesh.rotation); }

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
