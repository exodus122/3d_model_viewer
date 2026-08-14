////////////////////////////////////////
// System: Global Variables
////////////////////////////////////////

let game = "BK";
let loadedModels = []; // { name, mesh, edges }
let loadedModelsNotSelectable = []; // { name, mesh, edges }

// Zelda-specific variables
let EPS = 0.008; // used for zelda collision
let samplePointsEnabled = false;

const f32 = Math.fround;
const COLPOLY_NORMAL_FRAC = f32(1.0 / 32767.0);
function isZero(f) { return Math.abs(f) < EPS; }
let areaActors = null
