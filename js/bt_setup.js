import * as THREE from 'three';
import { getModelGroup, resetGroupModelState, applyGroupMasterState } from './render.js';
import {
    resetSetupState, getPropInstances, loadPropGeometry, addTypeRow, addLoadedModelRow, groupBy, makeYawLine,
    actorGeometry, nodeGeometry, modelGeometry, radiusGeometry,
    ACTOR_COLOR, NODE_COLOR, MODEL_COLOR, ACTOR_MARKER_RADIUS, MODEL_MARKER_SIZE,
} from './bk_setup.js';

////////////////////////////////////////
// System: Banjo-Tooie setup file (object placement)
////////////////////////////////////////
//
// A BT map's setup.bin (decrypted and decompressed by
// banjo-tooie/tools/extract_maps.py) is a tagged byte stream in the same
// style as BK's, read by gsworldDll_entrypoint_0. Top-level sections:
//
//   0x06  camera nodes      0x14 s32 count, then nodes: (tag field)* 0x00, ended by 0x00
//   0x07  objects           one flat "cube" (gccubeDll_entrypoint_5, no cube grid):
//           0x0A s32 n  NodeProp[n]   20 bytes each, BK's layout (actor spawns, triggers ...)
//           0x08 s32 n  Prop[n]       12 bytes each, BK's layout (static models / sprites)
//         ended by 0x01
//   0x04  lights            entries 0x01 / 0x05 / 0x06 / 0x08 / 0x09 with fields
//                           0x02 f32[3], 0x03 f32[2], 0x04 s32[3], 0x07 u8; ended by 0x00
//   0x05  (always empty)    ended by 0x00
//   0x00  end of file
//
// Two beta maps (0x149, 0x184) still use BK's cube-grid layout (section 0x01);
// those are reported and skipped.
//
// A model prop's asset comes from the gsproplookup overlay's table
// (BT_Prop_Models, index = modelId), an actor's overlay from gemarkersDll
// (BT_Actor_Overlays) and its model from the actor-info struct in that
// overlay (BT_Actor_Models); all generated into bt_object_list.js.
//
// The actor behaviour cited below (scale changes, model picks, actors moving
// other actors) was read out of the overlays' MIPS with
// tools/bt/disasm_bt_overlay.py, which disassembles an overlay (or a core1 /
// core2 range) from the ROM with the decomp's symbol names.

// NodeProp.category as BK names them (enum Prop1Category); 6 = actor holds
// for BT (its ids resolve to actor overlays), the rest are unverified.
const NODE_CATEGORY_NAMES = {
    0: 'Category 0',
    2: 'Warp / Trigger?',
    3: 'Camera Controller?',
    4: 'Category 4',
    5: 'Category 5',
    6: 'Actor',
    7: 'Enemy Boundary?',
    8: 'Path?',
    9: 'Camera Trigger?',
    10: 'Flag?',
    11: 'Category 11',
    12: 'Category 12',
};
const NODE_CATEGORY_ACTOR = 6;

// Parts an actor's draw callback switches on or off, as a partial appendage
// table (see parseBKModelTextured's options.appendageOverrides). BT models
// gate most parts behind single-branch selectors that are on by default, so
// a model whose selectors are alternatives has every index listed.
//
// Nests (chnests overlay): the egg nest model 0x6EA holds all seven egg types
// under selectors 1-8 and the feather nest 0x6EF both feather types under 1-2.
// Its draw callbacks (func_80800968, func_80800D8C) turn on the one index
// named by the marker's row in the overlay's item table -- 0x1CE 2, 0x1CF 1,
// 0x1D0 3, 0x1D1 5, 0x1D2 7, 0x1D3 8, 0x1D4 4, 0x1D5 2, 0x1D6 1 -- and 0x6EA's
// textures put 1 = fire, 2 = blue, 3 = ice, 4 = gold, 5 = grenade, 7 =
// proximity, 8 = clockwork; 0x6EF's 1 = gold, 2 = red. The generic nests
// (0x1E9 eggs, 0x4A6 feathers) pick their row at run time; blue eggs / red
// feathers are the defaults.
const eggNest = type => Object.fromEntries([1, 2, 3, 4, 5, 7, 8].map(i => [i, i === type ? 1 : 0]));
const featherNest = type => ({ 1: type === 1 ? 1 : 0, 2: type === 2 ? 1 : 0 });
const BT_ACTOR_APPENDAGES = {
    0x1C8: eggNest(2), 0x1E9: eggNest(2),           // blue
    0x1C9: eggNest(1),                              // fire
    0x1CA: eggNest(3),                              // ice
    0x1CB: eggNest(5),                              // grenade
    0x1CC: eggNest(7),                              // proximity
    0x1CD: eggNest(4),                              // gold
    0x2B8: eggNest(8),                              // clockwork
    0x1CE: featherNest(2), 0x4A6: featherNest(2),   // red
    0x1CF: featherNest(1),                          // gold
};

// Scale changes an actor's own code makes once it has spawned. The setup
// file's scale (NodeProp.scale / 100, gspropsDll) is applied first; then the
// overlay's init callback (ActorInfo+0x34) runs, and these either call
// actor_setScale (0x80102FDC) or store actor->scale (+0x38) directly, with
// the spawned scale times a constant (mul) or a fixed value (set). Found by
// scanning every actor overlay's init callback for those (banjo-tooie ROM,
// US). Two set theirs from their state machine instead: the baby
// steggosaurus (chdinofamilysmall state 1, the fresh-file state, at
// 0x808008F8) and the silo (chsilo 0x808008CC, which also takes its number
// from the selector).
const BT_ACTOR_SCALES = {
    0x17F: { set: 0.2 },        // chjigsawbitcont
    0x18F: { set: 0.5 },        // chmoley (Jamjars)
    0x197: { set: 0.5 },        // chhoney (honeycomb)
    0x19B: { set: 0.375 },      // chmayafarmer (Bovina)
    0x19D: { set: 1.0 },        // chsilo
    0x1AA: { set: 3.0 },        // chfiregen (generator pipes)
    0x1AC: { set: 3.0 },
    0x1AE: { set: 3.0 },
    0x1B0: { set: 3.0 },
    0x1B2: { set: 3.0 },
    0x1B4: { set: 3.0 },
    0x1BF: { set: 0.3 },        // chfishshootgame (Atlantis fish)
    0x1E2: { set: 0.18 },       // chjiggygamenew (Banjo's hand)
    0x229: { set: 0.5 },        // chhoney (honeycomb)
    0x29F: { set: 0.75 },       // chglowbo
    0x2A0: { set: 0.75 },
    0x523: { set: 0.75 },
    0x2A4: { set: 0.3 },        // chflysaucer (red target)
    0x2F8: { set: 0.5 },        // chmayafarmer (fly)
    0x37D: { set: 0.4 },        // chevilmumbo (purple light)
    0x37F: { set: 0.8 },        // chdodgemcontrol (blue twinkly)
    0x4A5: { set: 0.18 },       // chboggy
    0x530: { set: 2.0 },        // chboggy (sled)
    0x112: { mul: 1.5 },        // chwarriorbaddy (Moggies)
    0x133: { mul: 0.75 },       // chdiggerfly (pterodactyl)
    0x134: { mul: 0.75 },
    0x137: { set: 0.25 },       // chgobiwitchy (Gobi)
    0x13C: { set: 1.4 },        // chinflatableboss (Mr. Patch)
    0x149: { mul: 0.5 },        // chtntdetonator
    0x158: { mul: 0.6 },        // chswappy
    0x198: { mul: 0.75 },       // chsignpost
    0x203: { set: 0.25 },       // chdiggerboss (Hag 1, intro)
    0x292: { set: 0.5 },        // chdinofamilysmall (baby steggosaurus)
    0x2B3: { set: 0.75 },       // chjadestatue
    0x327: { mul: 0.85 },       // chfairgroundworker
    0x328: { mul: 0.85 },
    0x32A: { mul: 0.85 },
    0x343: { set: 0.25 },       // chdiggerboss (Grunty)
    0x347: { set: 0.45 },       // chsabreman
    0x35C: { mul: 0.7 },        // chseaweedbaddy
    0x35D: { mul: 0.7 },
    0x35E: { mul: 0.8 },        // choctopus
    0x35F: { mul: 0.5 },        // chanemone
    0x362: { mul: 4.0 },        // chdinofoot (Spomponadon)
    0x36D: { set: 0.6 },        // chlagoonbits
    0x36F: { mul: 1.25 },       // chdinoboss (Terry)
    0x382: { mul: 0.75 },       // chtimetable (Chuffy sign post)
    0x39B: { mul: 1.25 },       // chdinocoaster
    0x3A5: { mul: 1.25 },       // chnicecavemenguard (Unga Bunga)
    0x3C9: { mul: 1.5 },        // chlagoonpirate
    0x3D1: { mul: 0.5 },        // chdingpot
    0x3E3: { set: 0.25 },       // chgobihailfire (Gobi)
    0x3E6: { mul: 1.6 },        // chbiggafoot
    0x43B: { mul: 1 / 3 },      // chbottlesfamily (Mrs. Bottles)
    0x44E: { set: 1.4 },        // chbiggafoot (ice balls)
    0x464: { mul: 0.6 },        // ch2dbaddy
    0x46C: { mul: 1.75 },       // changlerbossdoor
    0x46D: { mul: 1.1 },        // chboilerbossdoor
    0x46E: { mul: 1.4 },        // chinflatablebossdoor
    0x4BC: { mul: 0.15 },       // chbottlesdead (Burnt Bottles)
    0x4F5: { set: 0.25 },       // chdiggerbossbattery
    0x21B: { set: 0.4 },        // chglowbo#0 (0.75 instead under a flag its init checks)
};

/** The scale an actor node is drawn at: the setup scale, then its code's change. */
function actorScale(node) {
    const spawned = (node.scale === 0 || node.setupActorId !== undefined) ? 1 : node.scale / 100;
    const change = BT_ACTOR_SCALES[node.actorId];
    if (!change) return spawned;
    return change.set !== undefined ? change.set : spawned * change.mul;
}

// Models picked at run time by actors whose info struct names none (model
// 0 / 0xFFFF, so they are not in BT_Actor_Models): actor_setModel
// (0x80103140) with an id that depends on the placement, usually the node's
// selector. Each entry is an asset id or a function of (node, mapName)
// returning one (or 0 for nothing to draw). Read out of the overlays' code:
//   chmumboskulls / chdiggerbossbattery / chlagoonlockerdoorhits index a
//   table with selector - 50 (- 51 for the lockers); the doors and the ice
//   station pick one of two ids on selector == 50; the Weldar doors add the
//   selector to 0x837; the dino switches (chdinoswitches 0x130, model-less)
//   look their row up by (map, selector) in the overlay's table at
//   0x80800B20 and take its switch model, while the row's door model 0x7C4
//   belongs to the TL Door actor (0x364) the switch opens; the Mumbo pad
//   indexes its colour table with a per-level number, which is guessed here
//   from the map's prefix (world order, MT = 1); every chmole_* actor has the
//   sumole library spawn a chmolehill (0x247, model 0x7D7, the hatch) at its
//   position, with Jamjars only appearing when approached. The spawn
//   (sumole_entrypoint_21) swaps the hatch for the Bottles mound (0x629)
//   when the mole's init passed it 1, which only chmole_training (0x1A9,
//   Spiral Mountain) does; the others all pass 0.
const MOLEHILL = 0x7D7;
const MOLEHILL_MOUND = 0x629;
const DINO_SWITCH_MODELS = {   // map id -> selector -> switch model
    0x11A: { 50: 0x7B9, 51: 0x7B8, 52: 0x942 },   // TDL_STOMPING_PLAINS: Kazooie, Banjo, BK switch
    0x112: { 52: 0x948, 53: 0x784, 55: 0x7CE },   // TDL_TERRYDACTYLAND (spawned by code, not in the setup)
    0x115: { 50: 0x7CD },                         // TDL_OOGLE_BOOGLE_CAVE
    0x119: { 50: 0x7CD, 51: 0x7CD },              // TDL_UNGA_BUNGAS_CAVE
    0x116: { 50: 0x7CD },                         // TDL_INSIDE_MOUNTAIN
    0xBB: { 50: 0x7CD },                          // MT_KICKBALL_STADIUM
    0xC5: { 50: 0x7CD },                          // MT_TREASURE_CHAMBER
};
const MUMBO_PAD_LEVELS = { MT: 1, GGM: 2, WW: 3, JRL: 4, TDL: 5, GI: 6, HP: 7, CCL: 8, CK: 9, IOH: 10, JV: 10, SM: 11 };
const MUMBO_PAD_MODELS = [0x7D8, 0x7D8, 0x7E0, 0x7D9, 0x7D9, 0x7D9, 0x7DB, 0x7DC, 0x7DC, 0x7DC, 0x7DE, 0x7DE];
const BT_ACTOR_RUNTIME_MODELS = {
    0x463: node => [0x648, 0x8E0, 0x8E1, 0x867][node.selectorOrRadius - 50] ?? 0,   // chmumboskulls
    0x4F5: node => [0x909, 0x90A][node.selectorOrRadius - 50] ?? 0,                 // chdiggerbossbattery
    0x496: node => (node.selectorOrRadius >= 51 && node.selectorOrRadius <= 59) ? 0x8E4 + node.selectorOrRadius - 51 : 0, // chlagoonlockerdoorhits
    0x341: node => 0x837 + node.selectorOrRadius,                                    // chweldarbossdoors
    0x344: node => node.selectorOrRadius === 50 ? 0x782 : 0x783,                     // chghostdoor
    0x38C: node => node.selectorOrRadius === 50 ? 0x94F : 0x950,                     // chhagstraindoor
    0x49B: node => node.selectorOrRadius === 50 ? 0x949 : 0x94A,                     // chdinotraindoor
    0x41B: node => node.selectorOrRadius === 50 ? 0x872 : 0x873,                     // chicestationbits
    0x130: (node, mapName, mapId) => DINO_SWITCH_MODELS[mapId]?.[node.selectorOrRadius] ?? 0, // chdinoswitches
    0x306: 0x828,                                                                    // chdodgemcontrol
    0x2B0: (node, mapName) => MUMBO_PAD_MODELS[MUMBO_PAD_LEVELS[mapName.split('_')[0]] ?? 0], // chmumbopad
    0x182: MOLEHILL, 0x184: MOLEHILL, 0x185: MOLEHILL, 0x186: MOLEHILL, 0x1A7: MOLEHILL, 0x1A8: MOLEHILL,
    0x30B: MOLEHILL, 0x311: MOLEHILL, 0x315: MOLEHILL, 0x376: MOLEHILL,                    // chmole_*
    0x1A9: MOLEHILL_MOUND,                                                           // chmole_training
};

/** The model asset an actor node is drawn with, or 0 for none. */
function actorModelAsset(node, mapName, mapId) {
    const runtime = BT_ACTOR_RUNTIME_MODELS[node.actorId];
    if (runtime !== undefined) return typeof runtime === 'function' ? runtime(node, mapName, mapId) : runtime;
    return BT_Actor_Models[node.actorId] ?? 0;
}

// Placement an actor's own code overrides once spawned: a function of
// (node, all actor nodes) returning any of { position, scale: [x, y, z],
// pitch, yaw } (degrees; pitch is actor +0x44, the x rotation applied in
// the yawed frame as mlMtxRotatePYR does, yaw +0x48). What the setup file
// gave stays in setupPosition / setupYaw for the description.
//
// GI roof windows (chfactoryroofbits 0x3F2, init 0x808003C4 ->
//   func_808001C0): switch on the node's unique id (NodeProp.uid, the top 11
//   bits of its last word, kept at marker +0x6C) and set the position, a
//   per-axis scale (actor +0x28) and the pitch of each of the five windows;
//   the setup yaw stays. Unknown ids keep the setup placement.
// Big Terry's bits (chbigterrysbits 0x461 / 0x469, TDL_TERRYS_NEST): doors
//   built with chdoormake whose init writes the pitch (-50 / -90).
// Ray of Light (chworlddoors 0x51B): func_80800068 finds the 0x4DC and 0x4DD
//   nodes of its world (selector), takes the angles from 0x4DD toward 0x4DC
//   (0x800F18FC) and sits 1000 units from 0x4DD along them (state 1); the
//   draw then shifts it by scale * the model's radius (0x80103EAC) further
//   along, so the beam (0x966, symmetric about its origin) starts there.
// Chuffy (chchuffy 0x2A5): nothing in the overlay writes its rotation, and
//   every station's track runs along x (z ~ -1070), so its yaw is inferred:
//   engine (model +z) toward -x, which in GI_TRAIN_STATION is the only way
//   round the train fits between the station doors (chfactorystationdoors
//   0x406 at x = -3136 / 2717).
const ROOF_WINDOWS = {
    0x4B: { position: [-1392, 8063, -632], scale: [0.94, 0.73, 1], pitch: 312 },
    0x4C: { position: [174, 8066, -1017], scale: [0.94, 0.73, 1], pitch: 312 },
    0x4D: { position: [-1138, 2148, 2300], scale: [1.8, 1.8, 1.8], pitch: 0 },
    0x4E: { position: [2303, 2143, -376], scale: [1.8, 1.8, 1.8], pitch: 0 },
    0x0E: { position: [2645, 1494, 2645], scale: [1.14, 1, 1], pitch: 0 },
};
const WORLD_DOOR_START = 0x4DC, WORLD_DOOR_END = 0x4DD;
const RAY_OF_LIGHT_RADIUS = 733;   // 0x966's bounding radius (vertex store +0x12)
const deg = rad => rad * 180 / Math.PI;
/** Game angles (0x800F18FC): pitch up-positive, yaw with +z at 0, of the vector `to - from`. */
function anglesBetween(from, to) {
    const dx = to[0] - from[0], dy = to[1] - from[1], dz = to[2] - from[2];
    const h = Math.hypot(dx, dz);
    return { pitch: deg(Math.atan2(dy, h)), yaw: deg(Math.atan2(dx, dz)), length: Math.hypot(h, dy) };
}
function nearestNode(actorNodes, actorId, selector, near) {
    let best = null, bestD = Infinity;
    for (const n of actorNodes) {
        if (n.actorId !== actorId) continue;
        const d = (n.selectorOrRadius !== selector ? 1e12 : 0) +
            (n.position[0] - near[0]) ** 2 + (n.position[1] - near[1]) ** 2 + (n.position[2] - near[2]) ** 2;
        if (d < bestD) { bestD = d; best = n; }
    }
    return best;
}
const BT_ACTOR_PLACEMENTS = {
    0x3F2: node => ROOF_WINDOWS[node.uid],
    0x461: () => ({ pitch: -50 }),
    0x469: () => ({ pitch: -90 }),
    0x2A5: () => ({ yaw: 270 }),
    0x51B: (node, actorNodes) => {
        const end = nearestNode(actorNodes, WORLD_DOOR_END, node.selectorOrRadius, node.position);
        const start = end && nearestNode(actorNodes, WORLD_DOOR_START, node.selectorOrRadius, end.position);
        if (!start) return null;
        const { pitch, yaw, length } = anglesBetween(end.position, start.position);
        const t = (1000 + RAY_OF_LIGHT_RADIUS * actorScale(node)) / length;
        const position = end.position.map((v, i) => Math.round(v + (start.position[i] - v) * t));
        return { position, pitch: +pitch.toFixed(2), yaw: +yaw.toFixed(2) };
    },
};

/** Apply BT_ACTOR_PLACEMENTS. */
function applyActorPlacements(actorNodes) {
    for (const node of actorNodes) {
        const placed = BT_ACTOR_PLACEMENTS[node.actorId]?.(node, actorNodes);
        if (!placed) continue;
        node.placed = placed;
        if (placed.position) { node.setupPosition ??= node.position; node.position = placed.position; }
        if (placed.scale) node.scaleVec = placed.scale;
        if (placed.pitch !== undefined) node.pitch = placed.pitch;
        if (placed.yaw !== undefined) { node.setupYaw ??= node.yaw; node.yaw = placed.yaw; }
    }
}

// Actors whose code places them relative to the camera every frame, as a
// function of the camera position returning { position, pitch, yaw }.
//
// chsunlightspell (0x297, JRL_JOLLY_ROGERS_LAGOON; the sunlight Mumbo's
// spell brings to the lagoon): func_80800668 takes the sky model's ref point
// 4 (the sun in 0xB36, via 0x800BFFB4 = sky layer 0 -> 0x800DBEFC), puts the
// actor 1000 units from the camera toward it, and aims it (0x800F18FC) at the
// fixed point D_808008B0 = (-9000, 8000, -3100). Its model 0x928 is a
// 5600-unit beam hanging down -y from its origin.
const SUNLIGHT_TARGET = [-9000, 8000, -3100];
const BT_CAMERA_PLACEMENTS = {
    0x297: {
        skyRefPoint: { model: 0xB36, index: 4 },
        place(node, cameraPos, sun) {
            const len = Math.hypot(sun[0], sun[1], sun[2]) || 1;
            const position = cameraPos.map((v, i) => v + sun[i] / len * 1000);
            const { pitch, yaw } = anglesBetween(position, SUNLIGHT_TARGET);
            return { position, pitch, yaw };
        },
    },
};
const cameraActors = [];   // { node, rule, sun }

/** Register nodes that follow the camera (BT_CAMERA_PLACEMENTS); resolved once their ref point loads. */
async function applyCameraPlacements(actorNodes) {
    cameraActors.length = 0;
    for (const node of actorNodes) {
        const rule = BT_CAMERA_PLACEMENTS[node.actorId];
        if (!rule) continue;
        const sky = await loadPropGeometry(rule.skyRefPoint.model, 'BT').catch(() => null);
        const sun = sky?.refPoints?.get(rule.skyRefPoint.index);
        if (!sun) { console.warn(`actor ${hex(node.actorId)}: sky ref point ${rule.skyRefPoint.index} of ${hex(rule.skyRefPoint.model)} not found`); continue; }
        node.cameraPlaced = true;
        cameraActors.push({ node, rule, sun });
    }
}

/**
 * Move the camera-relative actors (BT_CAMERA_PLACEMENTS) for this frame.
 * Called from the render loop; does nothing when the map has none.
 */
export function updateBTCameraActors(camera) {
    // Entries outlive a switch to another game's map, but then match no
    // instance and do nothing until the next BT map replaces them.
    if (!cameraActors.length) return;
    const cameraPos = [camera.position.x, camera.position.y, camera.position.z];
    for (const { node, rule, sun } of cameraActors) {
        const placed = rule.place(node, cameraPos, sun);
        node.position = placed.position;
        node.pitch = placed.pitch;
        node.yaw = placed.yaw;
        for (const inst of getPropInstances()) {
            if (inst.prop !== node) continue;
            ACTOR_STYLE.transform(node, inst.mesh);
            inst.edges?.position.copy(inst.mesh.position);
            inst.edges?.rotation.copy(inst.mesh.rotation);
        }
    }
}

// Models an actor draws besides the one in its info struct, placed with the
// actor's own position, yaw and scale. Every nest draws the basket
// (chnests func_80800898: model 0x85C at the actor's position, yaw and scale)
// before its eggs, feathers or notes.
const NEST_BASKET = { asset: 0x85C, label: 'nest basket' };
const BT_ACTOR_EXTRA_MODELS = {
    0x1C8: [NEST_BASKET], 0x1C9: [NEST_BASKET], 0x1CA: [NEST_BASKET], 0x1CB: [NEST_BASKET],
    0x1CC: [NEST_BASKET], 0x1CD: [NEST_BASKET], 0x1CE: [NEST_BASKET], 0x1CF: [NEST_BASKET],
    0x1D7: [NEST_BASKET], 0x1D8: [NEST_BASKET], 0x1E9: [NEST_BASKET], 0x2B8: [NEST_BASKET],
    0x4A6: [NEST_BASKET],
};

// Collectibles are placed in the setup file under ids the marker table
// (gemarkersDll, BT_Actor_Overlays) has no entry for, so gspropsDll's spawn
// of them fails; gccollectDll then walks the map's node list itself
// (gccollectDll_entrypoint_8), checks the save flags -- the node's yaw field
// is the item's number in the level, not an angle -- and spawns the real
// actor from its own table (D_80800C18) at the node's position. It calls
// the core spawn (0x80108C90) directly, skipping gspropsDll's step that
// applies the node's scale field, so the actor spawns at scale 1 whatever
// that field holds (often junk, e.g. 6000). The setup id is kept in
// setupActorId for the description.
const BT_COLLECTIBLE_SPAWNS = {
    0x1F5: 0x1F4,   // chjinjo
    0x1F6: 0x21F,   // chjigsaw (Jiggy)
    0x1F7: 0x220,   // chhoneycarrier (honeycomb piece)
    0x1F8: 0x21B,   // chglowbo (the node's selector is copied to the actor)
    0x201: 0x136,   // chcheatopage
    0x29D: 0x4E5,   // chdoubloon
    0x4E6: 0x3C6,   // chbigtopticket
};

// Actors that move another actor onto themselves once spawned, so the
// setup file's position for the moved one is only a rough placeholder.
//
// The ice cubes (chmrsicecube: 0x3E1 George Ice Cube, 0x3E2 Aice Cube) hold
// an item: the overlay's table at 0x80800910, indexed by selector - 50,
// names the actor id held; the spawn code (func_80800508) finds the nearest
// setup node with that id (gccubesearch_entrypoint_6 collects the map's
// nodes of the id, closest to the cube wins; jinjos, 0x1F4, via
// subaddiefind_entrypoint_0 instead), and every frame (func_8080066C) puts
// that actor at the cube's position plus scale * 100 in y -- the middle of
// the cube, whose model origin is at its base.
const ICE_CUBE_CONTENTS = [
    0x1F4, 0x229, 0x136, 0x4A6, 0x1C9, 0x1CA, 0x1CB, 0x1CC, 0x1CE,
    0x1CF, 0x1D7, 0x211, 0x19C, 0x1D8, 0x1E9, 0x210, 0x2B0,
];
const iceCube = {
    heldActor: node => ICE_CUBE_CONTENTS[node.selectorOrRadius - 50],
    place: node => [node.position[0], node.position[1] + actorScale(node) * 100, node.position[2]],
};
const BT_ACTOR_HOLDERS = { 0x3E1: iceCube, 0x3E2: iceCube };
// Holders are translucent shells drawn after everything at the default order
// (their contents included) and with the XLU map, so the ice always blends
// over the nest inside instead of the nest's own blended parts landing on
// top of the ice when the distance sort puts the cube's origin farther away.
const HOLDER_RENDER_ORDER = 1;

/**
 * Move actor nodes that another actor's code places onto itself
 * (BT_ACTOR_HOLDERS). Each moved node keeps its setup position in
 * setupPosition and names the holder in heldBy.
 */
function applyActorHolders(actorNodes) {
    for (const holder of actorNodes) {
        const rule = BT_ACTOR_HOLDERS[holder.actorId];
        if (!rule) continue;
        const heldId = rule.heldActor(holder);
        if (heldId === undefined) continue;
        let best = null, bestDist = Infinity;
        for (const node of actorNodes) {
            if (node.actorId !== heldId) continue;
            const from = node.setupPosition ?? node.position;
            const d = (from[0] - holder.position[0]) ** 2 + (from[1] - holder.position[1]) ** 2 + (from[2] - holder.position[2]) ** 2;
            if (d < bestDist) { best = node; bestDist = d; }
        }
        if (!best) continue;
        best.setupPosition ??= best.position;
        best.position = rule.place(holder);
        best.heldBy = holder;
    }
}

const NODE_PROP_SIZE = 20;
const PROP_SIZE = 12;

const CAMERA_FIELDS = {   // tag -> byte size of its payload
    0x01: 4, 0x02: 4, 0x0D: 4, 0x0E: 4, 0x0F: 4, 0x10: 4, 0x13: 4,
    0x03: 12, 0x04: 12, 0x05: 12, 0x06: 8, 0x07: 8,
    0x08: 4, 0x09: 4, 0x0B: 4, 0x0C: 4, 0x11: 4, 0x12: 4, 0x0A: 2,
};
const LIGHT_ENTRY_TAGS = new Set([0x01, 0x05, 0x06, 0x08, 0x09]);
const LIGHT_FIELDS = { 0x02: 12, 0x03: 8, 0x04: 12, 0x07: 1 };

function hex(v, width = 0) {
    return '0x' + v.toString(16).toUpperCase().padStart(width, '0');
}

function actorName(id, model = BT_Actor_Models[id]) {
    const ovl = BT_Actor_Overlays[id];
    const modelName = model ? BT_Asset_Names[model]?.replace(/^Model:\s*/, '') : null;
    if (modelName && modelName !== '?') return `${modelName} (${hex(id)}, ${ovl ?? 'core'})`;
    if (ovl) return `${ovl} (${hex(id)})`;
    // Not in gemarkersDll's table: the game has no spawn routine for the id.
    return `ACTOR ${hex(id)} (no actor in the marker table)`;
}

function propModelAsset(modelId) {
    return BT_Prop_Models[modelId] ?? 0;
}

function modelName(modelId) {
    const asset = propModelAsset(modelId);
    if (!asset) return `MODEL_ID_${hex(modelId)}`;
    const name = BT_Asset_Names[asset];
    return name ? name.replace(/^Model: /, '') : `MODEL_${hex(asset)}`;
}

////////////////////////////////////////
// Parsing
////////////////////////////////////////

class SetupReader {
    constructor(buffer) {
        this.dv = new DataView(buffer);
        this.pos = 0;
    }
    get eof() { return this.pos >= this.dv.byteLength; }
    peek() { return this.dv.getUint8(this.pos); }
    u8() { const v = this.dv.getUint8(this.pos); this.pos += 1; return v; }
    s32() { const v = this.dv.getInt32(this.pos, false); this.pos += 4; return v; }
    skip(n) { this.pos += n; }
}

// NodeProp, 20 bytes (BK include/prop.h; identical in BT):
//   s16 position[3]; u16 selector_or_radius:9 | category:6 | bit0:1; u16 actorId;
//   u8 markerId; u8 pad; u32 yaw:9 | scale:23; u32 uid:11 | unk:21
function readNodeProp(r) {
    const dv = r.dv, o = r.pos;
    const w6 = dv.getUint16(o + 6, false);
    const wC = dv.getUint32(o + 12, false);
    const w10 = dv.getUint32(o + 16, false);
    r.skip(NODE_PROP_SIZE);
    return {
        position: [dv.getInt16(o, false), dv.getInt16(o + 2, false), dv.getInt16(o + 4, false)],
        selectorOrRadius: w6 >>> 7,
        category: (w6 >>> 1) & 0x3F,
        bit0: w6 & 1,
        actorId: dv.getUint16(o + 8, false),
        markerId: dv.getUint8(o + 10),
        yaw: wC >>> 23,
        scale: wC & 0x7FFFFF,
        uid: w10 >>> 21,
        unk10: w10,
    };
}

// Prop, 12 bytes: u16 modelId:12 | unk:4, u8 yaw (x2 deg), u8 roll (x2 deg),
// s16 pos[3], u8 scale (/100), u8 flags (bit 1 = model prop, else sprite).
function readProp(r) {
    const dv = r.dv, o = r.pos;
    const w0 = dv.getUint16(o, false);
    const flags = dv.getUint8(o + 11);
    r.skip(PROP_SIZE);
    const prop = {
        kind: (flags & 2) ? 'model' : 'sprite',
        modelId: w0 >>> 4,
        unk0: w0 & 0xF,
        yaw: dv.getUint8(o + 2) * 2,
        roll: dv.getUint8(o + 3) * 2,
        position: [dv.getInt16(o + 4, false), dv.getInt16(o + 6, false), dv.getInt16(o + 8, false)],
        scale: dv.getUint8(o + 10) / 100,
        flags,
    };
    if (prop.kind === 'sprite') prop.spriteId = prop.modelId;
    return prop;
}

function readCameraSection(r, result) {
    if (r.u8() !== 0x14) throw new Error(`setup: camera section without count tag at ${r.pos - 1}`);
    r.s32();
    while (!r.eof && r.peek() !== 0) {
        const node = {};
        for (;;) {
            const tag = r.u8();
            if (tag === 0) break;
            const size = CAMERA_FIELDS[tag];
            if (size === undefined) throw new Error(`setup: unknown camera field ${hex(tag)} at ${r.pos - 1}`);
            if (tag === 0x01) node.id = r.s32();
            else if (tag === 0x02) node.type = r.s32();
            else if (tag === 0x03) node.position = [r.dv.getFloat32(r.pos, false), r.dv.getFloat32(r.pos + 4, false), r.dv.getFloat32(r.pos + 8, false)], r.skip(12);
            else r.skip(size);
        }
        result.cameras.push(node);
    }
    r.u8();
}

function readObjectSection(r, result) {
    for (;;) {
        const tag = r.u8();
        if (tag === 0x0A) {
            const n = r.s32();
            for (let i = 0; i < n; i++) result.nodes.push(readNodeProp(r));
        } else if (tag === 0x08) {
            const n = r.s32();
            for (let i = 0; i < n; i++) result.props.push(readProp(r));
        } else if (tag === 0x01) {
            return;
        } else {
            throw new Error(`setup: unknown object-section tag ${hex(tag)} at ${r.pos - 1}`);
        }
    }
}

function readLightSection(r, result) {
    let cur = null;
    for (;;) {
        const tag = r.u8();
        if (tag === 0) return;
        if (LIGHT_ENTRY_TAGS.has(tag)) {
            cur = { kind: tag };
            result.lights.push(cur);
        } else if (tag in LIGHT_FIELDS) {
            if (tag === 0x04) cur.color = [r.dv.getInt32(r.pos, false), r.dv.getInt32(r.pos + 4, false), r.dv.getInt32(r.pos + 8, false)];
            r.skip(LIGHT_FIELDS[tag]);
        } else {
            throw new Error(`setup: unknown light field ${hex(tag)} at ${r.pos - 1}`);
        }
    }
}

/**
 * Parse a BT setup.bin.
 * @returns {{cameras:object[], nodes:object[], props:object[], lights:object[], legacy:boolean}}
 */
export function parseBTSetup(buffer) {
    const r = new SetupReader(buffer);
    const result = { cameras: [], nodes: [], props: [], lights: [], legacy: false };

    if (!r.eof && r.peek() === 0x01) {
        // BK-style cube grid (two unused beta maps); not parsed.
        result.legacy = true;
        return result;
    }
    while (!r.eof) {
        const section = r.u8();
        if (section === 0) break;
        switch (section) {
            case 0x06: readCameraSection(r, result); break;
            case 0x07: readObjectSection(r, result); break;
            case 0x04: readLightSection(r, result); break;
            case 0x05:
                while (r.u8() !== 0) { /* never has content */ }
                break;
            default:
                throw new Error(`setup: unknown section ${hex(section)} at ${r.pos - 1}`);
        }
    }
    return result;
}

////////////////////////////////////////
// Rendering
////////////////////////////////////////

function describeNode(node) {
    const cat = NODE_CATEGORY_NAMES[node.category] ?? `Category ${node.category}`;
    const model = node.extraModel ? node.extraModel.asset : (node.runtimeModel ?? BT_Actor_Models[node.actorId]);
    const what = node.category === NODE_CATEGORY_ACTOR
        ? `ACTOR ${actorName(node.actorId, node.runtimeModel)}` +
          (node.setupActorId !== undefined ? ` (setup id ${hex(node.setupActorId)}, spawned by gccollectDll)` : '') +
          (node.extraModel ? ` ${node.extraModel.label}` : '') +
          (model ? ` model ${hex(model)}${node.runtimeModel ? ' (picked by its code)' : ''}${node.geometrySource ? ' ' + node.geometrySource : ''}` : '')
        : `NODE ${cat} id=${hex(node.actorId)}`;
    const scale = node.category === NODE_CATEGORY_ACTOR && BT_ACTOR_SCALES[node.actorId]
        ? `${node.scale / 100} (drawn at ${+actorScale(node).toFixed(4)}: set by its code on spawn)`
        : node.setupActorId !== undefined
            ? `${node.scale / 100} (ignored: gccollectDll spawns at 1)`
            : `${node.scale / 100}`;
    const pos = node.heldBy
        ? `${node.position.map(v => +v.toFixed(2)).join(', ')} (moved by its ${actorName(node.heldBy.actorId)} from ${node.setupPosition.join(', ')})`
        : node.cameraPlaced
            ? `${node.position.map(v => +v.toFixed(0)).join(', ')} (follows the camera: set by its code every frame)`
        : node.setupPosition
            ? `${node.position.join(', ')} (set by its code, setup ${node.setupPosition.join(', ')})`
            : node.position.join(', ');
    const yaw = node.setupYaw !== undefined ? `${node.yaw} (set by its code, setup ${node.setupYaw})` : node.cameraPlaced ? `${+node.yaw.toFixed(1)}` : `${node.yaw}`;
    const placed = (node.scaleVec ? ` (drawn at scale ${node.scaleVec.join(', ')}: set by its code)` : '') +
        (node.pitch !== undefined ? ` pitch=${+node.pitch.toFixed(1)} (set by its code)` : '');
    return `${what}: pos=${pos} yaw=${yaw} scale=${scale}${placed}` +
        ` selector/radius=${node.selectorOrRadius} marker=${node.markerId} bit0=${node.bit0} uid=${node.uid} unk10=${hex(node.unk10, 8)}`;
}

function describeProp(prop) {
    if (prop.kind === 'model') {
        return `MODEL ${modelName(prop.modelId)} (id ${hex(prop.modelId)}, asset ${hex(propModelAsset(prop.modelId))}` +
            `${prop.geometrySource ? ', ' + prop.geometrySource : ''}): pos=${prop.position.join(', ')}` +
            ` yaw=${prop.yaw} roll=${prop.roll} scale=${prop.scale} unk=${prop.unk0} flags=${hex(prop.flags)}`;
    }
    return `SPRITE id ${hex(prop.spriteId)} (asset ${hex(BT_Prop_Sprites[prop.spriteId] ?? 0)}): pos=${prop.position.join(', ')}` +
        ` scale=${prop.scale} flags=${hex(prop.flags)}`;
}

function buildActorInstance(node, material, lineMaterial) {
    const mesh = new THREE.Mesh(actorGeometry, material);
    const s = THREE.MathUtils.clamp(actorScale(node), 0.25, 4);
    mesh.scale.setScalar(s);
    mesh.add(makeYawLine(ACTOR_MARKER_RADIUS * 2.5, lineMaterial));
    mesh.rotation.y = THREE.MathUtils.degToRad(node.yaw);
    mesh.userData.bkInfo = describeNode(node);
    mesh.userData.bkNode = node;
    return mesh;
}

function buildNodeInstance(node, material, lineMaterial) {
    const mesh = new THREE.Mesh(nodeGeometry, material);
    mesh.rotation.y = THREE.MathUtils.degToRad(node.yaw);
    mesh.userData.bkInfo = describeNode(node);
    mesh.userData.bkNode = node;
    // Categories 7 / 9 / 10 carry a radius in BK; the same field is shown
    // as a sphere here when it is plausibly one.
    if ([7, 9, 10].includes(node.category) && node.selectorOrRadius > 0) {
        const wire = new THREE.Mesh(radiusGeometry, new THREE.MeshBasicMaterial({
            color: material.color, wireframe: true, transparent: true, opacity: 0.35,
        }));
        wire.scale.setScalar(node.selectorOrRadius);
        wire.userData.bkInfo = mesh.userData.bkInfo;
        wire.userData.bkNode = node;
        mesh.add(wire);
    }
    return mesh;
}

function buildModelInstance(prop, material, lineMaterial) {
    const mesh = new THREE.Mesh(modelGeometry, material);
    mesh.scale.setScalar(THREE.MathUtils.clamp(prop.scale || 1, 0.25, 8));
    mesh.rotation.set(0, THREE.MathUtils.degToRad(prop.yaw), THREE.MathUtils.degToRad(prop.roll), 'YXZ');
    mesh.add(makeYawLine(MODEL_MARKER_SIZE, lineMaterial));
    mesh.userData.bkInfo = describeProp(prop);
    mesh.userData.bkProp = prop;
    return mesh;
}

// Same placement matrix as BK's propModelList_drawModel: yaw, then roll.
const MODEL_PROP_STYLE = {
    color: MODEL_COLOR,
    edgeColor: 0x5a2d8a,
    describe: describeProp,
    fallback: buildModelInstance,
    transform(prop, obj) {
        obj.position.set(prop.position[0], prop.position[1], prop.position[2]);
        obj.rotation.set(0, THREE.MathUtils.degToRad(prop.yaw), THREE.MathUtils.degToRad(prop.roll), 'YXZ');
        obj.scale.setScalar(prop.scale || 1);
    },
};

// Actors are placed like BK's (func_80330208): the node's position, yaw in
// degrees and scale / 100 (0 = 1), then whatever their own code does to the
// scale (BT_ACTOR_SCALES). NodeProp.selector_or_radius picks the
// selector-gated variant for models that have one, as it does in BK.
const ACTOR_STYLE = {
    color: ACTOR_COLOR,
    edgeColor: 0x8a3d10,
    describe: describeNode,
    fallback: buildActorInstance,
    selectorOf: node => node.selectorOrRadius,
    appendagesOf: node => BT_ACTOR_APPENDAGES[node.actorId] ?? null,
    renderOrderOf: node => node.actorId in BT_ACTOR_HOLDERS ? HOLDER_RENDER_ORDER : 0,
    transform(node, obj) {
        obj.position.set(node.position[0], node.position[1], node.position[2]);
        obj.rotation.set(THREE.MathUtils.degToRad(node.pitch ?? 0), THREE.MathUtils.degToRad(node.yaw), 0, 'YXZ');
        if (node.scaleVec) obj.scale.set(node.scaleVec[0], node.scaleVec[1], node.scaleVec[2]);
        else obj.scale.setScalar(actorScale(node));
    },
};

const GROUP_KEYS = ['bt-models', 'bt-actors', 'bt-actors-hitbox', 'bt-nodes'];

export async function renderBTSetup(scene, buffer, mapId = -1, mapName = '') {
    const setup = parseBTSetup(buffer);
    resetSetupState();
    for (const key of GROUP_KEYS) resetGroupModelState(key);

    if (setup.legacy) {
        console.log(`BT setup ${hex(mapId)}: BK-style cube layout (beta map), objects not parsed`);
        return setup;
    }

    const actorNodes = setup.nodes.filter(n => n.category === NODE_CATEGORY_ACTOR);
    for (const node of actorNodes) {
        const spawned = BT_COLLECTIBLE_SPAWNS[node.actorId];
        if (spawned !== undefined) { node.setupActorId = node.actorId; node.actorId = spawned; }
    }
    applyActorHolders(actorNodes);
    applyActorPlacements(actorNodes);
    await applyCameraPlacements(actorNodes);
    const otherNodes = setup.nodes.filter(n => n.category !== NODE_CATEGORY_ACTOR);
    const modelProps = setup.props.filter(p => p.kind === 'model');
    const spriteProps = setup.props.filter(p => p.kind === 'sprite');
    const rowLabel = (name, list) => list.length > 1 ? `${name} (x${list.length})` : name;

    if (modelProps.length) {
        const group = getModelGroup('bt-models', 'Model Props');
        const byType = [...groupBy(modelProps, p => p.modelId)]
            .sort((a, b) => modelName(a[0]).localeCompare(modelName(b[0])));
        const geometries = await Promise.all(byType.map(([id]) => {
            const asset = propModelAsset(id);
            return asset ? loadPropGeometry(asset, 'BT') : Promise.resolve(null);
        }));
        byType.forEach(([id, list], i) => {
            addLoadedModelRow(scene, group.body, rowLabel(modelName(id), list), list, geometries[i], MODEL_PROP_STYLE, true);
        });
    }

    if (actorNodes.length) {
        // Like BK: actors whose model has a collision list go in the "collision"
        // group (shown), the rest -- hitbox-only models, model-less actors and
        // anything that failed to load -- in the hidden-by-default group.
        // One row per actor type and model (BT_ACTOR_RUNTIME_MODELS can give
        // one actor several), plus one per extra model it draws
        // (BT_ACTOR_EXTRA_MODELS) over copies of its nodes, so each row keeps
        // its own geometry source and description.
        for (const node of actorNodes) {
            if (node.actorId in BT_ACTOR_RUNTIME_MODELS) node.runtimeModel = actorModelAsset(node, mapName, mapId);
        }
        const byType = [...groupBy(actorNodes, n => `${n.actorId}:${n.runtimeModel ?? ''}`)]
            .map(([, list]) => [list[0].actorId, list])
            .sort((a, b) => actorName(a[0], a[1][0].runtimeModel).localeCompare(actorName(b[0], b[1][0].runtimeModel)));
        const rows = byType.flatMap(([id, list]) => [
            { name: actorName(id, list[0].runtimeModel), asset: list[0].runtimeModel ?? BT_Actor_Models[id], list },
            ...(BT_ACTOR_EXTRA_MODELS[id] ?? []).map(extra => ({
                name: `${actorName(id)} ${extra.label}`, asset: extra.asset,
                list: list.map(node => ({ ...node, extraModel: extra })),
            })),
        ]);
        const geometries = await Promise.all(rows.map(row =>
            row.asset ? loadPropGeometry(row.asset, 'BT') : Promise.resolve(null)));
        const solid = [], hitboxOnly = [];
        rows.forEach((row, i) => (geometries[i]?.collision ? solid : hitboxOnly).push([row, geometries[i]]));
        if (solid.length) {
            const group = getModelGroup('bt-actors', 'Actors (collision)');
            for (const [row, loaded] of solid) {
                addLoadedModelRow(scene, group.body, rowLabel(row.name, row.list), row.list, loaded, ACTOR_STYLE, true);
            }
        }
        if (hitboxOnly.length) {
            const group = getModelGroup('bt-actors-hitbox', 'Actors (no collision)');
            for (const [row, loaded] of hitboxOnly) {
                addLoadedModelRow(scene, group.body, rowLabel(row.name, row.list), row.list, loaded, ACTOR_STYLE, true);
            }
        }
    }

    if (otherNodes.length || spriteProps.length) {
        const group = getModelGroup('bt-nodes', 'Other Setup Nodes');
        const byType = groupBy(otherNodes, n => n.category);
        for (const [cat, list] of [...byType].sort((a, b) => a[0] - b[0])) {
            const name = NODE_CATEGORY_NAMES[cat] ?? `Category ${cat}`;
            addTypeRow(scene, group.body, rowLabel(name, list), list, NODE_COLOR, false, buildNodeInstance);
        }
        if (spriteProps.length) {
            addTypeRow(scene, group.body, rowLabel('Sprite Props', spriteProps), spriteProps, NODE_COLOR, false, buildModelInstance);
        }
    }

    for (const key of GROUP_KEYS) applyGroupMasterState(key);

    console.log(`BT setup ${hex(mapId)}: ${actorNodes.length} actors, ${otherNodes.length} other nodes,`,
        `${modelProps.length} model props, ${spriteProps.length} sprite props, ${setup.cameras.length} camera nodes, ${setup.lights.length} lights`);
    return setup;
}
