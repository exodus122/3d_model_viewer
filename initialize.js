////////////////////////////////////////
    // Imports
    ////////////////////////////////////////
    
	// Import from a CDN that handles internal dependency mapping (esm.sh)
	import * as THREE from 'https://esm.sh/three@0.152.2';
    import { PointerLockControls } from 'https://esm.sh/three@0.152.2/examples/jsm/controls/PointerLockControls.js';
	import { OrbitControls } from 'https://esm.sh/three@0.152.2/examples/jsm/controls/OrbitControls.js';
    import { LineMaterial } from 'https://esm.sh/three@0.152.2/examples/jsm/lines/LineMaterial.js';
    import { LineGeometry } from 'https://esm.sh/three@0.152.2/examples/jsm/lines/LineGeometry.js';
    import { LineSegments2 } from 'https://esm.sh/three@0.152.2/examples/jsm/lines/LineSegments2.js';
    
    ////////////////////////////////////////
    // System: DOM / Static UI Elements
    ////////////////////////////////////////
    
    const canvas = document.getElementById('gl');
    const mapDropdown = document.getElementById("mapDropdown");
    const fileInput = document.getElementById('file');
    const loadMapButton = document.getElementById('loadMap');
    const wireframeCheckbox = document.getElementById('wireframe');
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
    
    const multiSelectCheckbox = document.getElementById('multiSelect');
    const selectionListEl = document.getElementById('selectionListEl');
    
    ////////////////////////////////////////
    // System: Shared State
    ////////////////////////////////////////
    
    let game = 'BK';
    let controlMode = 'pointer'; // State regarding which control mode is active: 'pointer' | 'orbit' | 'auto'
    let pointerLockBlocked = false; // whether requestPointerLock is blocked (sandboxed iframe)
    let loadedModels = []; // { name, mesh, edges }
    let loadedModels2 = []; // { name, mesh, edges }
    let mesh = null;
    let edges = null;
    let selectedTriangles = []; // Store multiple selections
    const pointerControls = new PointerLockControls(camera, renderer.domElement);
    let orbitControls = null; // lazy-created when needed
    let speed = 1500; // movement units per second
    
    // Material used as base for clones per mesh
    const material = new THREE.MeshStandardMaterial({color:0x3aa6ff,side:THREE.FrontSide,transparent:true,opacity:1.0,flatShading:true});
    const material2 = new THREE.MeshStandardMaterial({color:0xf56342,side:THREE.FrontSide,transparent:true,opacity:1.0,flatShading:true});
    const material3 = new THREE.MeshStandardMaterial({color:0xe1eb34,side:THREE.FrontSide,transparent:true,opacity:1.0,flatShading:true});
    
    // Raycaster for selection
    const raycaster = new THREE.Raycaster();
    const mouse = new THREE.Vector2();
    
    // Movement state (applies only in pointer-lock / fly mode)
    const move = {forward:false,back:false,left:false,right:false,up:false,down:false};