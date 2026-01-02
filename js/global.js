////////////////////////////////////////
// System: Global Variables
////////////////////////////////////////

let game = "BK";
let controlMode = 'pointer'; // State regarding which control mode is active: 'pointer' | 'orbit' | 'auto'
let loadedModels = []; // { name, mesh, edges }
let loadedModelsNotSelectable = []; // { name, mesh, edges }
let mesh = null;
let edges = null;
let selectedTriangles = []; // Store multiple selections
let speed = 1500; // movement units per second

// Zelda-specific variables
const COLPOLY_NORMAL_FRAC = 1.0 / 32767.0; // used for zelda collision
let EPS = 0.008; // used for zelda collision
let samplePointsEnabled = false;

const f32 = Math.fround;
function isZero(f) { return Math.abs(f) < EPS; }
