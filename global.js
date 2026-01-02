////////////////////////////////////////
// System: Global Variables
////////////////////////////////////////

let specialNormalEnabled = false;
let specialNormalColor = 0x00ffff;   // default
let specialNormalMarkers = [];

let flatGroundEnabled = false;
let flatGroundColor = 0x00FFFF; 
let flatGroundMarkers = [];

// Movement state (applies only in pointer-lock / fly mode)
const move = {forward:false,back:false,left:false,right:false,up:false,down:false};

// Map each game to its data array
const GAME_MAPS = {
    BK: BK_Maps,
    BT: BT_Maps,
    OOT: OOT_Maps,
    MM: MM_Maps,
    OOT3D: OOT3D_Maps,
    MM3D: MM3D_Maps,
};

let game = "BK";
let controlMode = 'pointer'; // State regarding which control mode is active: 'pointer' | 'orbit' | 'auto'
let pointerLockBlocked = false; // whether requestPointerLock is blocked (sandboxed iframe)
let loadedModels = []; // { name, mesh, edges }
let loadedModels2 = []; // { name, mesh, edges }
let mesh = null;
let edges = null;
let selectedTriangles = []; // Store multiple selections
let orbitControls = null; // lazy-created when needed

// Zelda-specific variables
let speed = 1500; // movement units per second
const COLPOLY_NORMAL_FRAC = 1.0 / 32767.0; // used for zelda collision
let EPS = 0.008; // used for zelda collision
let samplePointsEnabled = false;

const f32 = Math.fround;
function isZero(f) { return Math.abs(f) < EPS; }
