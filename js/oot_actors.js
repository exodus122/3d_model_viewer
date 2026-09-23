import * as THREE from 'three';
import { addModelCheckbox, getModelGroup, resetGroupModelState, applyGroupMasterState } from './render.js';
import { replayDisplayLists, makeZeldaMesh, parseZeldaSceneInfo, scrollSegment, SEG_FLEX_MATRICES } from './zelda_textured.js';
import { attachTextured, clearTexturedPairs } from './bk_textured.js';
import { addTypeRow, makeYawLine, groupBy, ACTOR_COLOR } from './bk_setup.js';
import { decodeActorSpawnEntry, actorShapeRot } from './render_actors.js';
import { MM_ACTOR_OVERRIDES } from './mm_actor_overrides.js';

////////////////////////////////////////
// System: Ocarina of Time / Majora's Mask actors (every spawn in the scene's
// actor lists)
////////////////////////////////////////
//
// Both games draw actors the same way, so one renderer serves both: MM's
// table is MM_Actor_Models (js/mm_object_list.js, the same generator run with
// --mm), its hand fixes MM_ACTOR_OVERRIDES (js/mm_actor_overrides.js), its
// files models/MM/actors/. What follows describes OoT; MM differs only in
// how spawn and transition-actor rotations are packed.
//
// The scene's room actor lists (models/OOT/actors/OOT_actors_by_scene.json,
// one ActorEntry per spawn: id, position, rotation, params) are drawn the
// way BK's and BT's setup files are: one sidebar row per actor type with an
// instance at every placement, drawn with the actor's real model when it
// can be, a marker when it can't. The DynaPoly rows (render_actors.js) stay
// separate: they draw the collision an actor registers, this draws what the
// player sees.
//
// What an actor draws is in its own code, not in any table, so
// tools/oot/generate_oot_actor_models.py reads it out of the decomp into
// OOT_Actor_Models (js/oot_object_list.js): the skeleton its Init sets up
// and the animation that poses it, the static display lists its Draw
// issues, the textures it points segments 8-F at, its scale and yOffset.
// OOT_ACTOR_OVERRIDES below patches what that mining gets wrong or cannot
// see (a model picked in code, a scale computed from params).
//
// A model is replayed by js/zelda_textured.js's F3DZEX interpreter with the
// object in segment 6, gameplay_keep in 4 and the scene's keep object
// (field or dungeon) in 5, at the actor's spawn transform
// (Actor_Draw: translate to world.pos + yOffset * scale.y, rotate YXZ by
// shape.rot, scale). A skeleton is posed at frame 0 of its animation and
// each limb's list run under the limb's matrix (SkelAnime_DrawOpa /
// DrawFlexOpa, with segment 0xD holding the flex limb matrices). Nothing
// animates, and a limb-draw callback that swaps lists or moves limbs is not
// run, so an actor is drawn as its skeleton's plain first frame.

const SEG_SCENE = 0x02, SEG_KEEP = 0x04, SEG_SCENE_KEEP = 0x05, SEG_OBJECT = 0x06;
const OBJECT_GAMEPLAY_DANGEON_KEEP = 3;
const CMD_SPECIAL_FILES = 0x07;
const CMD_END = 0x14;

const LIMB_DONE = 0xFF;
const STANDARD_LIMB_SIZE = 0x0C, LOD_LIMB_SIZE = 0x10;

// Actor_Init sets every actor to this before its own Init runs.
const DEFAULT_SCALE = 0.01;

const BINANG_TO_RAD = Math.PI / 0x8000;

const GROUP_MODELS = 'oot-actors';
const GROUP_MARKERS = 'oot-actors-markers';

// Per game: the generated model table (a classic script's global, so only
// reachable by name) and the hand overrides.
const GAMES = {
    OOT: { models: () => (typeof OOT_Actor_Models === 'undefined' ? null : OOT_Actor_Models), overrides: () => OOT_ACTOR_OVERRIDES },
    MM: { models: () => (typeof MM_Actor_Models === 'undefined' ? null : MM_Actor_Models), overrides: () => MM_ACTOR_OVERRIDES },
};

const wireframeCheckbox = document.getElementById('wireframe');

////////////////////////////////////////
// Hand overrides
////////////////////////////////////////
//
// Keyed by actor name. Each entry can set: scale (number, [x, y, z] or a
// function of (params, sceneName, spawnRot)), yOffset (number or a function of params), model (a
// function of (params, sceneName, minedSpec, spawnRot, keepFile, room) returning a model spec
// to use instead of the mined one, or null for a marker), rot (a function of
// (rot, params) returning the shape.rot the actor's Init sets), place (a
// function of (instance, sceneCollision) returning { position?, rot? } for
// an Init that moves the actor against the scene's collision), spawns (a
// function of the spawn { actorId, params, rot, rotRaw, position } returning
// the spawns to draw instead -- an Init that spawns a copy of itself), and
// marker: true to force the marker.
//
// A model spec is { object, skeleton?, anim?, lists?, segments?, limbLists?,
// attach? } as generated (attach: { limb, skeleton, anim } is a second
// skeleton posed at that limb of the first, 1-based), with limbLists: { limbIndex: [list refs] } for lists a limb
// callback draws in place of a limb's own, or after it with add: true
// (limbIndex as the callback sees it, counting from 1), and a segment
// { matrices: [ops] } for an Mtx array the Draw builds (En_Rr).
const OOT_ACTOR_OVERRIDES = {
    // z_en_box.c EnBox_Init: type = params >> 12; ENBOX_TYPE_SMALL (5),
    // TYPE_6, ROOM_CLEAR_SMALL (7) and SWITCH_FLAG_FALL_SMALL (8) are scale
    // 0.005, the rest 0.01.
    "En_Box": { scale: (params) => ([5, 6, 7, 8].includes((params >> 12) & 0xF) ? 0.005 : 0.01) },

    // z_en_okuta.c: the projectile list is only drawn by the spawned
    // projectile; a placed Octorok is its skeleton alone.
    "En_Okuta": { lists: [] },

    // z_en_ishi.c sRockScales[params & 1]: small rock 0.1, silver boulder 0.4.
    "En_Ishi": { scale: (params) => ((params & 1) ? 0.4 : 0.1) },

    // z_en_wood02.c EnWood02_Init: params & 0xFF is the WOOD_ type. The
    // large trees and bushes (and their spawners / spawned copies) are 1.5,
    // the small conical tree 0.6, the two leaves 0.02, the rest 1.0. The
    // draw picks D_80B3BF54 / D_80B3BF70 by drawType, which Init derives
    // from the type: conical trees, oval trees, the Kakariko tree, green
    // bushes, black bushes (and the green leaf), the yellow leaf. The leaves
    // themselves draw object_wood02_DL_000700 instead.
    "En_Wood02": {
        scale: (params) => {
            const type = params & 0xFF;
            if ([0x00, 0x0C, 0x0F, 0x10, 0x12, 0x15, 0x16].includes(type)) return 1.5;
            if (type === 0x02) return 0.6;
            if (type === 0x17 || type === 0x18) return 0.02;
            return 1.0;
        },
        model: (params) => {
            const type = params & 0xFF;
            const wood = (offset, layer) => ({ file: 'object_wood02', offset, layer });
            if (type === 0x17 || type === 0x18) return { object: 'object_wood02', lists: [wood(0x700, 'opa')] };
            const drawType = type <= 0x04 ? 0 : type <= 0x09 ? 1 : type <= 0x0A ? 2 : type <= 0x10 ? 3 : type <= 0x17 ? 4 : 5;
            const opa = [0x78D0, 0x7CA0, 0x80D0, 0x90, 0x340, 0x340][drawType];
            const xlu = [0x7968, 0x7D38, 0x81A8, null, null, null][drawType];
            // Without a translucent canopy list the trunk list itself is
            // drawn on the XLU layer.
            return { object: 'object_wood02', lists: xlu != null ? [wood(opa, 'opa'), wood(xlu, 'xlu')] : [wood(opa, 'xlu')] };
        },
    },

    // z_en_hata.c EnHata_Init: Actor_SetScale(1.0f / 75.0f).
    "En_Hata": { scale: 1 / 75 },

    // z_en_st.c EnSt_Init: 0.04, times 1.4 for params == 1 (the big one).
    "En_St": { scale: (params) => (params === 1 ? 0.056 : 0.04) },

    // z_en_rr.c EnRr_Init: x/z 0.014, y 0.013. gLikeLikeDL loads each of
    // its four body rings' matrix from segment 0xC, which EnRr_Draw fills:
    // ring i is Translate(0, height + 1000) * RotateZYX(rot) * Scale(scale)
    // on top of ring i - 1, and at rest (EnRr_InitBodySegments) height and
    // rot are 0 and scale 1. Unmapped, every ring collapses onto the base.
    "En_Rr": {
        scale: [0.014, 0.013, 0.014],
        segments: { 0x0C: { matrices: [1, 2, 3, 4].map(i => [['t', 0, 1000 * i, 0]]) } },
    },

    // z_bg_spot09_obj.c BgSpot09Obj_Init: the carpenters' tent (params 3)
    // is 0.1, the Gerudo Valley bridges 1.0.
    "Bg_Spot09_Obj": { scale: (params) => ((params & 0xFF) === 3 ? 0.1 : 1.0) },

    // z_en_peehat.c EnPeehat_Init: 0.036; the larva (params == 1) is
    // 0.006 / 0.003 / 0.006.
    "En_Peehat": { scale: (params) => (params === 1 ? [0.006, 0.003, 0.006] : 0.036) },

    // z_en_go2.c D_80A481F8[params & 0x1F].scale (the Goron type table).
    "En_Go2": { scale: (params) => [0.026, 0.008, 0.16, 0.01, 0.015][params & 0x1F] ?? 0.01 },

    // z_bg_hidan_firewall.c: x/z 0.12, y 0.01.
    "Bg_Hidan_Firewall": { scale: [0.12, 0.01, 0.12] },

    // z_bg_hidan_curtain.c: sHCParams[size].scale, size 1 for types 2 and 4
    // (type = params >> 12).
    "Bg_Hidan_Curtain": { scale: (params) => ([2, 4].includes((params >> 12) & 0xF) ? 0.055 : 0.090) },

    // z_bg_ice_shelter.c sRedIceScales[(params >> 8) & 7].
    "Bg_Ice_Shelter": { scale: (params) => [0.1, 0.06, 0.1, 0.1, 0.25][(params >> 8) & 7] ?? 0.1 },

    // z_en_item00.c (src/code): params & 0xFF is the ITEM00_ type (the upper
    // byte is the collectible flag). Init sets a scale and yOffset per type;
    // Draw dispatches on it: rupees are gRupeeDL with segment 8 at
    // sRupeeTex[type, or type - 0x10 for orange / purple], the heart piece
    // is gHeartPieceInteriorDL alone (XLU), the container
    // gHeartPieceExteriorDL over gHeartContainerInteriorDL, the
    // recovery heart is GetItem_Draw's gGiRecoveryHeartDL (object_gi_heart,
    // XLU), the ammo / nuts / sticks / magic / key drops are gItemDropDL
    // with segment 8 at sItemDropTex[]. Shields, tunics and "flexible" have
    // no placeable model here.
    "En_Item00": {
        scale: (params) => ITEM00_TYPES[params & 0xFF]?.scale ?? 0.01,
        yOffset: (params) => ITEM00_TYPES[params & 0xFF]?.yOffset ?? 0,
        model: (params) => ITEM00_TYPES[params & 0xFF]?.model ?? null,
    },

    // z_en_a_keep.c (src/code): params & 0xFF is the A_OBJ_ type (the upper
    // byte is the sign's text id); Draw is gameplay_keep's sDLists[type],
    // Init the scale per type (blocks only; the rest keep Actor_Init's 0.01).
    "En_A_Obj": {
        scale: (params) => [0.025, 0.05, 0.1, 0.005, 0.01, 0.1, 0.1][params & 0xFF] ?? 0.01,
        model: (params) => {
            const type = Math.min(params & 0xFF, 0xB);
            const dl = A_OBJ_LISTS[type];
            return dl ? { object: 'gameplay_keep', lists: [dl] } : null;
        },
    },

    // z_bg_spot16_doughnut.c Init: the expanding ring types 1-4 use
    // sScales[params] * 1e-4; the background ring is 0.04 in Kakariko,
    // 0.018 outside the Temple of Time, 0.1 on Death Mountain itself.
    "Bg_Spot16_Doughnut": {
        scale: (params, sceneName) => {
            if (params >= 1 && params <= 4) return [0, 0, 70, 210, 300][params] * 1e-4;
            if (sceneName === 'spot01_scene') return 0.04;
            if (/^shrine(_n|_r)?_scene$/.test(sceneName)) return 0.018;
            return 0.1;
        },
    },

    // z_obj_warp2block.c Init: sSpawnData[(params >> 8) & 1].scale.
    "Obj_Warp2block": { scale: (params) => (((params >> 8) & 1) ? 0.6 : 1.0) },

    // z_bg_mori_hineri.c Init: params becomes bit 15 >> 14 (0: the first
    // twisted hallway, 2: the second), +1 once the switch is set. The mined
    // selector cannot read that macro.
    "Bg_Mori_Hineri": { model: (params, sceneName, base) => ({ ...base, lists: base.lists.map(l => l.variants ? { ...l, select: [14, 2] } : l) }) },

    // z_en_sw.c: (params >> 13) & 7 is the type -- 0 a Skullwalltula, 1-4
    // a Gold Skulltula (bit 15 set means "+1"). Only the gold ones swap the
    // limb lists for the gold body (EnSw_OverrideLimbDraw's switch) and tilt
    // the skeleton back 80 degrees / 200 out of the wall in Draw; the mining
    // applies both to every type. A Skullwalltula's Init zeroes rot x / z; a
    // gold one's (func_80B0C0CC) line-tests the collision and stands on the
    // polygon it finds, "up" along its normal.
    "En_Sw": {
        model: (params, sceneName, base) => (enSwType(params) ? base : { ...base, skelOps: [], limbLists: null }),
        rot: (rot, params) => (enSwType(params) ? rot : [0, rot[1], 0]),
        place: (inst, collision) => (enSwType(inst.params) ? enSwStandOnPoly(inst, collision) : {}),
    },

    // z_bg_ice_turara.c BgIceTurara_Init: a stalagmite (type 0) stands as
    // is; the stalactites hang: shape.rot.x -0x8000, yOffset 1200.
    "Bg_Ice_Turara": {
        yOffset: (params) => (params === 0 ? 0 : 1200),
        rot: (rot, params) => (params === 0 ? rot : [-0x8000, rot[1], rot[2]]),
    },

    // z_obj_timeblock.c: sSizeOptions[(params >> 8) & 1].scale. Init zeroes
    // shape.rot.z, which the spawn uses as the colour: sPrimColors[home.rot.z
    // & 7] multiplies the block (the list's combiner is COMBINED * PRIMITIVE).
    "Obj_Timeblock": {
        scale: (params) => (((params >> 8) & 1) ? 0.6 : 1.0),
        rot: (rot) => [rot[0], rot[1], 0],
        model: (params, sceneName, base, rot) => {
            const c = TIMEBLOCK_PRIM[(rot?.[2] ?? 0) & 7];
            return { ...base, lists: base.lists.map(l => ({ ...l, prim: [...c, 255] })) };
        },
    },

    // z_obj_oshihiki.c: sScales[params & 0xF]. ObjOshihiki_SetTexture puts
    // gPushBlockSilverTex (small / medium), gPushBlockBaseTex (large) or gPushBlockGrayTex (huge)
    // in segment 8 by (params & 0xF) & 3; ObjOshihiki_SetColor tints it (env)
    // with sColors[scene][(params >> 6) & 3], white outside those dungeons.
    "Obj_Oshihiki": {
        scale: (params) => [1 / 10, 1 / 6, 1 / 5, 1 / 3, 1 / 10, 1 / 6, 1 / 5, 1 / 3][params & 0xF] ?? 0.1,
        model: (params, sceneName) => {
            const tex = [0x3350, 0x3350, 0x3B50, 0x4350][params & 3];
            const colour = OSHIHIKI_COLORS[sceneName]?.[(params >> 6) & 3] ?? [255, 255, 255];
            return {
                object: 'gameplay_dangeon_keep',
                lists: [{ file: 'gameplay_dangeon_keep', offset: 0x4CD0, layer: 'opa', env: [...colour, 255] }],
                segments: { 8: { file: 'gameplay_dangeon_keep', offset: tex } },
            };
        },
    },

    // z_en_dekubaba.c at rest (EnDekubaba_SetupWait): size 2.5 for the big
    // one (params 1), else 1; the head is scaled size * 0.005, raised 14 *
    // size and tipped rot.x -0x4000 (here as skelOps, so the lists below keep
    // the plain yaw); the retracted stem top is drawn 6 * size below home,
    // tipped the same, and the base leaves at home, both at size * 0.01.
    "En_Dekubaba": {
        scale: (params) => (params === 1 ? 2.5 : 1) * 0.005,
        model: (params, sceneName, base) => ({
            ...base,
            skelOps: [['t', 0, 2800, 0], ['rx', -Math.PI / 2]],
            lists: [
                { file: 'object_dekubaba', offset: 0x10F0, layer: 'opa', ops: [['s', 2, 2, 2]] },
                { file: 'object_dekubaba', offset: 0x1330, layer: 'opa', ops: [['t', 0, -1200, 0], ['rx', -Math.PI / 2], ['s', 2, 2, 2]] },
            ],
        }),
    },

    // z_door_shutter.c: the door's look is sStyleInfo[style], the style
    // sTypeStyles[type] ((params >> 6) & 0xF) or, for the plain shutters,
    // the scene's (sSceneInfo); its gfx is gfxType1 for a SHUTTER, else
    // gfxType2. A door barred at rest (front clear / front switch types)
    // draws its bars barsOffsetZ in front. Jabu-Jabu's is eight rotated
    // sections at 0.1; a boss door takes its scene's texture in segment 8.
    "Door_Shutter": {
        scale: (params, sceneName) => (doorShutterGfx(params, sceneName) === 3 ? 0.1 : 1),
        model: (params, sceneName) => doorShutterModel(params, sceneName),
    },

    // z_en_door.c: EnDoor_OverrideLimbDraw gives limb 4 one of
    // sDoorDLists[dListIndex] (the scene's door from sDoorInfo, else
    // gameplay_field_keep's where that keep is loaded): the left list when the
    // camera is behind the door, the right one in front -- each is one-sided,
    // so both are drawn here. The list Draw adds at the actor matrix is only
    // for a door swung open (world.rot.y != 0), which none is at rest. A
    // locked door (type 1) adds Actor_DrawDoorLock's chains and lock. A
    // double door (params bit 6) spawns its other half 30 to the right,
    // turned round, and moves itself 30 to the left.
    "En_Door": {
        model: (params, sceneName, base, rot, keepFile) => {
            const [file, left, right] = EN_DOOR_LISTS[sceneName]
                ?? (keepFile === 'gameplay_field_keep' ? ['gameplay_field_keep', 0x47A0, 0x4978] : ['gameplay_keep', 0xF158, 0xF2A0]);
            const lists = ((params >> 7) & 7) === 1 ? doorLockLists() : [];
            return { ...base, lists, limbLists: { 4: [left, right].map(offset => ({ file, offset, layer: 'opa' })) } };
        },
        spawns: (spawn) => {
            if (!(spawn.params & 0x40)) return [spawn];
            const yaw = spawn.rot[1] * BINANG_TO_RAD, dx = Math.cos(yaw) * 30, dz = Math.sin(yaw) * 30;
            const [x, y, z] = spawn.position, params = spawn.params & ~0x40, rotY = (spawn.rot[1] + 0x8000) << 16 >> 16;
            return [
                { ...spawn, params, position: [x - dx, y, z + dz] },
                { ...spawn, params, position: [x + dx, y, z - dz], rot: [0, rotY, 0], rotRaw: [0, rotY & 0xFFFF, 0] },
            ];
        },
    },

    // z_en_ge1.c: EnGe1_PostLimbDraw draws sHairstyleDLists[hairstyle] on
    // the head, and Init picks the hairstyle by type (params & 0xFF): the
    // gate guard spiky, the gate operator / normal / training-ground guards
    // a straight fringe, the valley-floor and horseback-archery ones a bob.
    "En_Ge1": {
        model: (params, sceneName, base) => {
            const type = params & 0xFF;
            const hair = type === 0x00 ? 0x9690 : [0x01, 0x04, 0x46].includes(type) ? 0x9430 : 0x9198;
            return { ...base, limbLists: { ...(base.limbLists ?? {}), 15: [{ file: 'object_ge1', offset: hair, layer: 'opa', add: true }] } };
        },
    },

    // z_en_vm.c: the Beamos laser is scaled by beamScale, which is 0 until
    // it fires; at rest only the skeleton shows.
    "En_Vm": { lists: [] },

    // z_obj_lightswitch.c ObjLightswitch_DrawOpa: the face and both flame
    // rings multiply by env, which is this->color: (155, 125, 255) from
    // Init until the switch is lit.
    "Obj_Lightswitch": {
        model: (params, sceneName, base) => ({ ...base, lists: base.lists.map(l => ({ ...l, env: [155, 125, 255, 255] })) }),
    },

    // z_en_g_switch.c EnGSwitch_Init by type ((params >> 12) & 0xF): the
    // silver-rupee tracker draws nothing, a silver rupee is gRupeeDL with
    // sRupeeTextures[5] (silver) at 0.03, the horseback-archery pot is
    // object_tsubo's pot at 0.25 / 0.45 / 0.25, the shooting-gallery rupee
    // gRupeeDL at 0.05 (colorIdx 0, green, until it is shot).
    "En_G_Switch": {
        scale: (params) => [null, 0.03, [0.25, 0.45, 0.25], 0.05][(params >> 12) & 0xF] ?? 0.01,
        yOffset: (params) => ([1, 3].includes((params >> 12) & 0xF) ? 700 : 0),
        model: (params) => {
            const type = (params >> 12) & 0xF;
            if (type === 1 || type === 3) {
                return { object: 'gameplay_keep', lists: [keep(0x45150)], segments: { 8: keepTex(type === 1 ? 0x44EF0 : 0x44E50) } };
            }
            if (type === 2) return { object: 'object_tsubo', lists: [{ file: 'object_tsubo', offset: 0x17C0, layer: 'opa' }] };
            return null;
        },
    },

    // z_door_warp1.c: WARP_BLUE_CRYSTAL (-2) and WARP_PURPLE_CRYSTAL (3)
    // draw gWarpCrystalSkel in their colours; the rest the portal,
    // gWarpPortalDL at the actor's own position unscaled (Matrix_Translate
    // ... MTXMODE_NEW), blue unless a colour variant. The mined list tests
    // params == -1 against the u16 params, so it never drew.
    "Door_Warp1": {
        scale: 1.0,
        model: (params, sceneName, base) => {
            const type = (params << 16) >> 16;
            if (type === -2 || type === 3) {
                return { ...base, lists: [], skelPrim: type === -2 ? [200, 255, 255, 255] : [255, 255, 255, 255], skelEnv: type === -2 ? [0, 100, 255, 255] : [150, 0, 100, 255] };
            }
            const env = { 4: [255, 255, 0], 8: [255, 150, 0], 9: [0, 200, 0], 10: [255, 50, 0] }[type] ?? [0, 255, 255];
            return { object: 'object_warp1', lists: [{ file: 'object_warp1', offset: 0x1A0, layer: 'xlu', prim: [255, 255, 255, 255], env: [...env, 255], primLod: 128 }],
                     segments: { 8: { scroll: [[0, 256, 256], [1, 256, 256]] }, 9: { matrices: [[['t', 0, 230, 0]]] }, 10: { matrices: [[]] } } };
        },
    },

    // z_obj_bean.c: until a bean is planted it is the soft soil spot,
    // ObjBean_DrawSoftSoilSpot's gMagicBeanSoftSoilDL at 0.1 (its
    // MTXMODE_NEW translate is just the home position and yaw).
    "Obj_Bean": {
        scale: 0.1,
        model: () => ({ object: 'object_mamenoki', lists: [{ file: 'object_mamenoki', offset: 0x650, layer: 'opa' }] }),
    },

    // z_en_light.c: D_80A9E840[params & 0xF] gives the colours and the size
    // (scale * 0.0001). Non-negative params draw gEffFire1DL in those
    // colours, negative ones gUnusedCandleDL (prim (255, 200, 0), env red).
    "En_Light": {
        scale: (params) => ((params & 0xF) === 4 ? 40 : 75) * 0.0001,
        model: (params) => {
            if (params & 0x8000) {
                return { object: 'gameplay_dangeon_keep', lists: crossed({ file: 'gameplay_dangeon_keep', offset: 0x440, layer: 'xlu', prim: [255, 200, 0, 0], env: [255, 0, 0, 0], primLod: 0xC0 }),
                         segments: { 8: { scroll: [[0, 16, 32], [1, 16, 32]] } } };
            }
            const [prim, env] = OOT_LIGHT_COLOURS[params & 0xF];
            return { object: 'gameplay_keep', lists: crossed({ ...keep(0x52A10), layer: 'xlu', prim: [...prim, 255], env: [...env, 0], primLod: 0x80 }),
                     segments: { 8: { scroll: [[0, 32, 64], [1, 32, 128]] } } };
        },
    },

    // z_obj_syokudai.c: the torch by type ((params >> 12) & 0xF), and with
    // params & 0x400 (always lit) its flame, gEffFire1DL 52 up at 0.0027.
    "Obj_Syokudai": {
        model: (params, sceneName, base) => (params & 0x400 ? {
            ...base,
            lists: [...base.lists, ...crossed({ ...keep(0x52A10), layer: 'xlu', ops: [['t', 0, 52, 0], ['s', 0.0027, 0.0027, 0.0027]],
                                                prim: [255, 255, 0, 255], env: [255, 0, 0, 0], primLod: 0x80 })],
        } : base),
    },

    // z_obj_switch.c: OBJSWITCH_TYPE (params & 7) floor / rusty floor /
    // eye / crystal (x2), OBJSWITCH_SUBTYPE ((params >> 4) & 7) the variant.
    // A raised floor switch is 0.165 tall (ObjSwitch_FloorUpInit); eyes are
    // open; a crystal is off (env black, the toggle one's red texture).
    "Obj_Switch": {
        scale: (params) => ((params & 7) <= 1 ? [0.1, 0.165, 0.1] : 0.1),
        model: (params) => {
            const type = params & 7, sub = (params >> 4) & 7;
            const dk = (offset, layer = 'opa') => ({ file: 'gameplay_dangeon_keep', offset, layer });
            if (type === 0) return { object: 'gameplay_dangeon_keep', lists: [dk([0x5800, 0x6170, 0x5D50, 0x5D50][sub] ?? 0x5800)] };
            if (type === 1) return { object: 'gameplay_dangeon_keep', lists: [dk(0x5AD0)] };
            if (type === 2) {
                return { object: 'gameplay_dangeon_keep', lists: [dk(sub === 1 ? 0x6810 : 0x6610)],
                         segments: { 8: { file: 'gameplay_dangeon_keep', offset: sub === 1 ? OOT_SILVER_EYE_OPEN : OOT_GOLD_EYE_OPEN } } };
            }
            const [xlu, opa] = sub === 1 ? [0x7488, 0x7340] : [0x6E60, 0x6D10];
            if (sub === 2 || sub === 3) return null;
            return { object: 'gameplay_dangeon_keep', lists: [dk(xlu, 'xlu'), { ...dk(opa), env: [0, 0, 0, 128] }],
                     segments: { 8: { scroll: [[0, 32, 32], [1, 32, 32]] }, ...(sub === 1 ? { 9: { file: 'gameplay_dangeon_keep', offset: OOT_CRYSTAL_RED_TEX } } : {}) } };
        },
    },

    // z_en_kanban.c: an uncut sign is object_kanban's material, then
    // gameplay_keep's gSignRectangularDL 100 back; the pieces and the cut
    // mark are only drawn once it is cut.
    "En_Kanban": {
        model: () => ({ object: 'object_kanban', lists: [
            { file: 'object_kanban', offset: 0xC30, layer: 'opa' },
            { ...keep(0x3D560), ops: [['t', 0, 0, -100]] },
        ] }),
    },

    // z_en_fire_rock.c: params 5 is the invisible ceiling spawner; 6 the
    // rock lying on the floor at 0.03.
    "En_Fire_Rock": {
        model: (params, sceneName, base) => (params === 5 ? null : base),
    },

    // z_en_bb.c (Bubbles): params with bit 7 set sign-extend to the type,
    // -1 blue, -2 red, -3 white, -4 green, -5 big green (0.03, else 0.01).
    // EnBb_Draw: the skull, then (not white) gEffFire1DL 4000 down, 100 x 80
    // wide, prim (255, 255, blue?) and env in the type's colour.
    "En_Bb": {
        scale: (params) => (enBbType(params) === -5 ? 0.03 : 0.01),
        model: (params, sceneName, base) => {
            const type = enBbType(params);
            if (type > -1) return null; // flame trails
            const env = { [-1]: [0, 0, 255], [-2]: [255, 0, 0], [-4]: [0, 255, 0], [-5]: [0, 255, 0] }[type];
            const flame = env && { ...keep(0x52A10), layer: 'xlu', ops: [['t', 0, -4000, 0], ['s', 1, 0.8, 1]],
                                   prim: [255, 255, type === -1 ? 255 : 0, 255], env: [...env, 0], primLod: 0x80 };
            return { ...base, lists: flame ? crossed(flame) : [], segments: { 8: { scroll: [[0, 32, 64], [1, 32, 128]] } } };
        },
    },

    // z_bg_ganon_otyuka.c: the params 0x23 platform draws every platform
    // (the others have no Draw): sPlatformMaterialDL, then each one's
    // sPlatformTopDL at its own position, unscaled. Sides only show once a
    // neighbour has fallen.
    "Bg_Ganon_Otyuka": {
        scale: 1.0,
        model: () => {
            const ovl = (offset) => ({ file: 'ovl_Bg_Ganon_Otyuka', offset, vram: 0x80A53DD0, layer: 'opa' });
            return { object: 'object_ganon', lists: [ovl(0x1958), ovl(0x19E0)] };
        },
    },

    // z_bg_haka_trap.c: sDLists[params & 0xFF]; Init turns
    // HAKA_TRAP_GUILLOTINE_FAST (5) into the slow guillotine (0).
    "Bg_Haka_Trap": {
        model: (params) => {
            const offset = [0x7610, 0x9860, 0x7EF0, 0x8A20, 0x72C0, 0x7610][params & 0xFF];
            return offset ? { object: 'object_haka_objects', lists: [{ file: 'object_haka_objects', offset, layer: 'opa' }] } : null;
        },
    },

    // z_en_bw.c (Torch Slug): the skeleton in env color1 (red), then its
    // flame, gEffFire1DL at the actor's position scaled unk_248 (0.6) *
    // 0.01 absolute -- 0.006 / 0.013 of the actor scale.
    "En_Bw": {
        model: (params, sceneName, base) => ({
            ...base, skelEnv: [255, 0, 0, 255],
            lists: crossed({ ...keep(0x52A10), layer: 'xlu', ops: [['s', 0.006 / 0.013, 0.006 / 0.013, 0.006 / 0.013]],
                             prim: [255, 255, 0, 255], env: [255, 0, 0, 0], primLod: 0x80 }),
        }),
    },

    // z_demo_gj.c (Ganon's arena rubble), DemoGj_GetType (params & 0xFF):
    // 4 the rubble around the arena, 8-14 the piles Ganondorf rises from
    // (gGanonsCastleRubble2-7 / Tall), 16 / 17 / 22 the rubble Ganon can
    // smash (Rubble2 / 3 / Tall, shown once he transforms).
    "Demo_Gj": {
        model: (params) => {
            const offset = { 4: 0xDC0, 8: 0x1D20, 9: 0x2160, 10: 0x2600, 11: 0x2A40, 12: 0x2E80, 13: 0x3190, 14: 0x3710,
                             16: 0x1D20, 17: 0x2160, 22: 0x3710 }[params & 0xFF];
            return offset ? { object: 'object_gj', lists: [{ file: 'object_gj', offset, layer: 'opa' }] } : null;
        },
    },

    // z_bg_spot08_iceblock.c: (params >> 4) & 0xF 0 / 1 / 2 is 0.2 / 0.1 /
    // 0.05 (an unlisted params becomes 0x10); params & 0x200 the ice ramp
    // (gZorasFountainIceRampDL) instead of the iceberg.
    "Bg_Spot08_Iceblock": {
        scale: (params) => {
            const valid = [1, 4, 0x10, 0x11, 0x12, 0x14, 0x20, 0x23, 0x24].includes(params & 0xFF);
            return [0.2, 0.1, 0.05][valid ? (params >> 4) & 0xF : 1] ?? 0.1;
        },
        model: (params) => ({ object: 'object_spot08_obj', lists: [{ file: 'object_spot08_obj', offset: (params & 0x200) ? 0xDE0 : 0x2BD0, layer: 'opa' }] }),
    },

    // z_en_po_field.c (Hyrule Field Poes): each placed one is a spawn spot
    // (params is its switch flag) where a Big Poe appears until caught
    // (sPoFieldInfo[EN_PO_FIELD_BIG]). Fully appeared: 0.007, segment 8 env the
    // info's light colour, 0xA env its env colour; limb 7 has no list (the
    // lantern is drawn at its matrix, env the soul colour); a Big Poe swaps
    // in its face / cloak / body on limbs 1, 8, 9.
    "En_Po_Field": {
        scale: 0.007,
        model: (params, sceneName, base) => {
            const big = true;
            const c = (rgb, a = 255) => ({ colour: { env: [...rgb, a].map(v => v / 255) } });
            const po = (offset) => ({ file: 'object_po_field', offset, layer: 'opa' });
            const limbLists = { 7: [{ ...po(0x4BA0), env: big ? [160, 0, 255, 255] : [255, 85, 0, 255] }, po(0x4CC0)] };
            if (big) Object.assign(limbLists, { 1: [po(0x5900)], 8: [po(0x5620)], 9: [po(0x59F0)] });
            return { ...base, lists: [], limbLists,
                     segments: { 8: c(big ? [255, 200, 0] : [100, 0, 150]), 0xA: c(big ? [160, 0, 255] : [255, 85, 0]), 0xC: { colour: {} } } };
        },
    },

    // z_en_zo.c (Zoras): the skeleton; ripples, bubbles and splashes are
    // effects.
    "En_Zo": {
        model: (params, sceneName, base) => ({ ...base, lists: [] }),
    },

    // z_en_ossan.c (shopkeepers), params = OSSAN_TYPE: each type's
    // skeleton, Init animation, eyes open and sShopkeeperScale. The Kokiri
    // shopkeeper's head (limb 15) comes from object_masterkokirihead with
    // its eyes in segment 0xA; env colours in 8 / 9, an empty list in 0xC.
    "En_Ossan": {
        scale: (params) => ([0.01, 0.011, 0.0105, 0.011][params & 0xFF] ?? 0.01),
        model: (params) => {
            const flex = (file, offset) => ({ file, offset, type: 'Flex', limbType: 'Standard' });
            const tex = (file, offset) => ({ file, offset });
            const env = (r, g, b) => ({ colour: { env: [r / 255, g / 255, b / 255, 1] } });
            const npc = (file, skel, animFile, anim, segments) => ({ object: file, skeleton: flex(file, skel), anim: { file: animFile, offset: anim }, segments });
            switch (params & 0xFF) {
                case 0: return { ...npc('object_km1', 0xF0, 'object_masterkokiri', 0x4A8, {
                                     8: env(0, 130, 70), 9: env(110, 170, 20), 0xA: tex('object_masterkokirihead', 0x1570), 0xC: { colour: {} } }),
                                 limbLists: { 15: [{ file: 'object_masterkokirihead', offset: 0x2820, layer: 'opa' }] } };
                case 1: case 3: return npc('object_ds2', 0x4258, 'object_ds2', 0x2E4, { 8: tex('object_ds2', 0x30D8) });
                case 2: return npc('object_rs', 0x4868, 'object_rs', 0x65C, { 8: tex('object_rs', 0x3968) });
                case 4: case 5: case 6: case 9: return npc('object_ossan', 0x9B38, 'object_ossan', 0x338, { 8: tex('object_ossan', 0x4878) });
                case 7: return npc('object_zo', 0xBFA8, 'object_masterzoora', 0x78C, { 8: tex('object_zo', 0x3E40), 0xC: { colour: {} } });
                case 8: return npc('object_oF1d_map', 0xFEF0, 'object_mastergolon', 0xFC, { 8: tex('object_oF1d_map', 0xCE80), 9: tex('object_oF1d_map', 0xDE80) });
                case 10: return npc('object_os', 0x4658, 'object_os', 0x2E4, { 8: tex('object_os', 0x39D8) });
                default: return null;
            }
        },
    },

    // z_en_poh.c: params 0 / 1 a graveyard Poe (gPoeSkel), 2 / 3 the
    // composer brothers Sharp / Flat (gPoeComposerSkel, Flat with his own
    // head on limb 10). sPoeInfo's limb (18 / 9) has no list: the lantern is
    // drawn at its matrix. Colours as fully appeared: env / segment 8 the
    // info's light colour, the composers' 0xA / 0xB their cloak colours.
    "En_Poh": {
        scale: 0.01,
        model: (params) => {
            const type = params & 0xFF;
            const c = (r, g, b) => ({ colour: { env: [r / 255, g / 255, b / 255, 1] } });
            if (type < 2) {
                const f = 'object_poh';
                return { object: f, skeleton: { file: f, offset: 0x50D0, type: 'Normal', limbType: 'Standard' }, anim: { file: f, offset: 0xA60 },
                         skelEnv: [100, 0, 150, 255], segments: { 8: { colour: {} } },
                         limbLists: { 18: [{ file: f, offset: 0x2D28, layer: 'opa', env: [255, 170, 255, 255] }] } };
            }
            const f = 'object_po_composer';
            const sharp = type === 2;
            const lantern = (offset, env) => ({ file: f, offset, layer: 'opa', env });
            const limbLists = { 9: [lantern(0x45A0, [255, 255, 170, 255]), lantern(0x4498), lantern(0x4530, sharp ? [75, 20, 25, 255] : [80, 110, 90, 255])] };
            if (!sharp) limbLists[10] = [{ file: f, offset: 0x4638, layer: 'opa' }];
            return { object: f, skeleton: { file: f, offset: 0x6F90, type: 'Flex', limbType: 'Standard' }, anim: { file: f, offset: 0x9DC }, limbLists,
                     segments: { 8: c(0, 150, 0), 0xA: sharp ? c(75, 20, 25) : c(80, 110, 90), 0xB: sharp ? c(90, 85, 50) : c(100, 90, 100), 0xC: { colour: {} } } };
        },
    },

    // z_en_wf.c: params 0 a Wolfos (gWolfosNormalSkel, 0.0075), else a
    // White Wolfos (gWolfosWhiteSkel, 0.01); eyes open in segment 8.
    "En_Wf": {
        scale: (params) => ((params & 0xFF) === 0 ? 0.0075 : 0.01),
        model: (params) => {
            const normal = (params & 0xFF) === 0;
            return { object: 'object_wf', skeleton: { file: 'object_wf', offset: normal ? 0x9690 : 0x3BC0, type: 'Flex', limbType: 'Standard' },
                     anim: { file: 'object_wf', offset: 0xA4AC }, segments: { 8: { file: 'object_wf', offset: normal ? 0x7B68 : 0x300 } } };
        },
    },

    // z_en_mb.c (Moblins): params -1 a spear guard (0.01), 0 the club
    // Moblin (gEnMbClubSkel, 0.02), else a spear patrol (0.014).
    "En_Mb": {
        scale: (params) => ((params & 0xFFFF) === 0xFFFF ? 0.01 : (params & 0xFFFF) === 0 ? 0.02 : 0.014),
        model: (params) => {
            const club = (params & 0xFFFF) === 0;
            return { object: 'object_mb', skeleton: { file: 'object_mb', offset: club ? 0x14190 : 0x8F38, type: 'Flex', limbType: 'Standard' },
                     anim: { file: 'object_mb', offset: club ? 0xEBE4 : 0x28E0 } };
        },
    },

    // z_en_ik.c (Iron Knuckles), IK_GET_ARMOR_TYPE (params & 0xFF) 0
    // Nabooru, 1 silver, 2 black, 3 white: EnIk_DrawEnemy's prim / env in
    // segments 8-A, the helmet and Gerudo head (not Nabooru), the armour's
    // rivets and pauldron trims, and the bare torso / waist hidden while the
    // armour is on.
    "En_Ik": {
        scale: 0.012,
        model: (params, sceneName, base) => {
            const type = params & 0xFF;
            const pe = (p, e) => ({ colour: { prim: [...p, 255].map(v => v / 255), env: [...e, 255].map(v => v / 255) } });
            const colours = [
                [[245, 225, 155], [30, 30, 0], [255, 40, 0], [40, 0, 0], [255, 255, 255], [20, 40, 30]],
                [[245, 255, 205], [30, 35, 0], [185, 135, 25], [20, 20, 0], [255, 255, 255], [30, 40, 20]],
                [[55, 65, 55], [0, 0, 0], [205, 165, 75], [25, 20, 0], [205, 165, 75], [25, 20, 0]],
            ][type] ?? [[255, 255, 255], [180, 180, 180], [225, 205, 115], [25, 20, 0], [225, 205, 115], [25, 20, 0]];
            const ik = (offset, extra = {}) => ({ file: 'object_ik', offset, layer: 'xlu', add: true, ...extra });
            const limbLists = {
                22: [ik(0x16F88)], 24: [ik(0x16EE8)], 26: [ik(0x16BE0)], 27: [ik(0x16CD8)], 28: [], 29: [],
            };
            if (type !== 0) {
                limbLists[12] = [{ file: 'object_ik', offset: 0x18E78, layer: 'opa' }, ik(0x19E08)];
                limbLists[13] = [{ file: 'object_ik', offset: 0x19100, layer: 'opa' }];
            }
            return { ...base, lists: [], limbLists,
                     segments: { 8: pe(colours[0], colours[1]), 9: pe(colours[2], colours[3]), 0xA: pe(colours[4], colours[5]) } };
        },
    },

    // z_en_heishi2.c (Hyrule Castle guards), type (params & 0xFF): 6 / 9 are
    // the guard in the courtyard window (EnHeishi2_DrawKingGuard: the static
    // gHeishiKingGuardDL; 9 at 0.02, moved 90 / -60 / 90); the rest the
    // skeleton. The gate guard's Keaton Mask only shows once it is sold.
    "En_Heishi2": {
        scale: (params) => ((params & 0xFF) === 9 ? 0.02 : 0.01),
        model: (params, sceneName, base) => ([6, 9].includes(params & 0xFF)
            ? { object: 'object_sd', lists: [{ file: 'object_sd', offset: 0x2C10, layer: 'opa' }] }
            : { ...base, lists: [] }),
        place: (inst) => ((inst.params & 0xFF) === 9
            ? { position: [inst.position[0] + 90, inst.position[1] - 60, inst.position[2] + 90], rot: [0, 0x7918, 0] }
            : null),
    },

    // z_bg_haka_meganebg.c: params 0 is the Lens of Truth platform, drawn
    // XLU only; the rest D_8087E410[params] opaque.
    "Bg_Haka_MeganeBG": {
        model: (params) => {
            const offset = [0x8EB0, 0xA1A0, 0x5000, 0x40][params & 0xFF];
            return offset == null ? null
                : { object: 'object_haka_objects', lists: [{ file: 'object_haka_objects', offset, layer: (params & 0xFF) === 0 ? 'xlu' : 'opa' }] };
        },
    },

    // z_en_floormas.c: a placed Floormaster is the big one at the default
    // 0.01 (0.004 is its split pieces); SPAWN_SMALL (0x10) ones are hidden.
    "En_Floormas": {
        scale: 0.01,
        model: (params, sceneName, base) => (((params & 0x7FFF) === 0x10) ? null : base),
    },

    // z_bg_ydan_hasi.c: params 0 / 2 the sliding / rising platforms (opa),
    // 1 the moving water plane (XLU only).
    "Bg_Ydan_Hasi": {
        model: (params) => {
            const type = params & 0xFF;
            const offset = [0x7508, 0x5DE0, 0x5018][type];
            const base = { object: 'object_ydan_objects', segments: { 8: { scroll: [[0, 32, 32], [1, 32, 32]] } } };
            if (type === 1) return { ...base, lists: [{ file: 'object_ydan_objects', offset: 0x5DE0, layer: 'xlu' }] };
            return offset ? { ...base, lists: [{ file: 'object_ydan_objects', offset, layer: 'opa' }] } : null;
        },
    },

    // z_bg_bdan_objects.c: sDLists[params], the water (2) XLU instead.
    "Bg_Bdan_Objects": {
        model: (params) => {
            const type = params & 0xFF;
            const offset = [0x8618, 0x4BE8, 0x38E8, 0x5200][type];
            return offset ? { object: 'object_bdan_objects', lists: [{ file: 'object_bdan_objects', offset, layer: type === 2 ? 'xlu' : 'opa' }] } : null;
        },
    },

    // z_bg_po_event.c (Forest Temple Poe sisters' puzzle): displayLists[type]
    // ((params >> 8) & 0xF), the paintings (2, 3) with env alpha 255.
    "Bg_Po_Event": {
        model: (params, sceneName, base) => {
            const type = (params >> 8) & 0xF;
            const lists = base.lists[0]?.variants?.[type];
            return lists ? { ...base, lists: lists.map(l => ({ ...l, env: [255, 255, 255, 255] })) } : null;
        },
    },

    // Cutscene NPCs (Ruto, Nabooru, Sheik, adult Ruto, Impa, Saria,
    // Darunia, Rauru): the mined skeleton in its Init animation, with the
    // faces their Draws put in segments 8 / 9 (/ 0xA) at the first entry
    // of each eye / mouth table, and 0xC the opaque render-mode list (a
    // no-op here). Most only appear during their cutscene.
    ...Object.fromEntries(Object.entries({
        En_Ru1: { 8: ['object_ru1', 0xE3B8], 9: ['object_ru1', 0xE838] },
        En_Nb: { 8: ['object_nb', 0xB428], 9: ['object_nb', 0xB428] },
        En_Xc: { 8: ['object_xc', 0x56E0], 9: ['object_xc', 0x56E0] },
        En_Ru2: { 8: ['object_ru2', 0xF20], 9: ['object_ru2', 0xF20] },
        Demo_Im: { 8: ['object_im', 0x7210], 9: ['object_im', 0x7210] },
        Demo_Sa: { 8: ['object_sa', 0x2F48], 9: ['object_sa', 0x2F48], 0xA: ['object_sa', 0x3588] },
        Demo_Du: { 8: ['object_du', 0x8680], 9: ['object_du', 0x9280], 0xA: ['object_du', 0x85C0] },
        En_Rl: { 8: ['object_rl', 0x3620], 9: ['object_rl', 0x3620] },
    }).map(([name, segs]) => [name, {
        model: (params, sceneName, base) => ({
            ...base, lists: [],
            segments: { 0xC: { colour: {} }, ...Object.fromEntries(Object.entries(segs).map(([s, [file, offset]]) => [s, { file, offset }])) },
        }),
    }])),

    // z_en_goma.c: a placed Gohma larva (params < 10) is still its egg:
    // gObjectGolEggDL squished 0.95 x 1.05, 1500 up (-1500 hanging from the
    // ceiling, params >= 8); segment 8 a texture scroll.
    "En_Goma": {
        model: (params) => ((params & 0xFFFF) >= 10 ? null : {
            object: 'object_gol',
            lists: [{ file: 'object_gol', offset: 0x2A70, layer: 'opa', ops: [['s', 0.95, 1.05, 0.95], ['t', 0, (params & 0xFFFF) >= 8 ? -1500 : 1500, 0]] }],
            segments: { 8: { scroll: [[0, 32, 32]] } },
        }),
    },

    // z_en_ba.c (Jabu-Jabu's parasitic tentacles), params & 0xFF: 0-2 the
    // tentacle in D_809B8118[type]'s colour, its 14 links hanging straight
    // down 32 apart from 100 above home (EnBa_Init) as the Mtx array in
    // segment 0xC (each link rotated x -0x4000, scaled 0.01 like the actor);
    // 3 the dead blob at 0.021.
    "En_Ba": {
        scale: (params) => ((params & 0xFF) < 3 ? 0.01 : 0.021),
        model: (params) => {
            const type = params & 0xFF;
            if (type >= 3) {
                return { object: 'object_bxa', lists: [{ file: 'object_bxa', offset: 0x1D80, layer: 'opa', prim: [255, 125, 100, 255] }],
                         segments: { 8: { scroll: [[0, 32, 32], [1, 32, 32]] } } };
            }
            const links = Array.from({ length: 14 }, (_, i) => [['t', 0, (100 - (i + 1) * 32) / 0.01, 0], ['rx', -Math.PI / 2]]);
            return { object: 'object_bxa', lists: [{ file: 'object_bxa', offset: 0x890, layer: 'opa' }],
                     segments: { 8: { file: 'object_bxa', offset: [0x24F0, 0x27F0, 0x29F0][type] }, 9: { scroll: [[0, 16, 16], [1, 32, 32]] }, 0xC: { matrices: links } } };
        },
    },

    // z_en_brob.c (Flobbery Muscle Block): (params >> 8) & 0xFF 0 is 0.01
    // tall params & 0xFF / 30 of that, else 0.005 and twice that
    // (0xFF keeps it unstretched).
    "En_Brob": {
        scale: (params) => {
            const small = ((params >> 8) & 0xFF) !== 0;
            const s = small ? 0.005 : 0.01;
            const h = params & 0xFF;
            return [s, h === 0xFF ? s : s * h * (small ? 2 : 1) / 30, s];
        },
    },

    // z_bg_gnd_soulmeiro.c (Spirit trial): dLists[params & 0xFF], the web
    // and light source XLU, the lit floor opaque -- once each.
    "Bg_Gnd_Soulmeiro": {
        model: (params) => {
            const type = params & 0xFF;
            const offset = [0x7C00, 0x2320][type];
            if (type === 2) return { object: 'object_demo_kekkai', lists: [{ file: 'object_demo_kekkai', offset: 0x35A0, layer: 'opa' }] };
            return offset ? { object: 'object_demo_kekkai', lists: [{ file: 'object_demo_kekkai', offset, layer: 'xlu' }] } : null;
        },
    },

    // z_bg_hidan_fwbig.c: a direction ((params >> 8) & 0xFF) makes it the
    // big moving fire wall at 0.15; the switch-controlled one is 0.1.
    "Bg_Hidan_Fwbig": { scale: (params) => (((params >> 8) & 0xFF) ? 0.15 : 0.1) },

    // z_bg_dy_yoseizo.c (Great Fairy): this->scale grows to 0.035 as she
    // appears.
    "Bg_Dy_Yoseizo": { scale: 0.035 },

    // z_en_vali.c (Bari): EnVali_DrawBody's inner hood, three nuclei (the
    // translations undo the yaw they are expressed in: (506, 1114, 372) and
    // then (-964, -108, -804) in the actor's own frame) and the outer hood,
    // before the tentacle skeleton.
    "En_Vali": {
        model: (params, sceneName, base) => {
            const v = (offset, ops) => ({ file: 'object_vali', offset, layer: 'xlu', ...(ops ? { ops } : {}) });
            return { ...base, lists: [v(0x2610), v(0x2740), v(0x2740, [['t', 506, 1114, 372]]), v(0x2740, [['t', -458, 1006, -432]]), v(0x27D8)] };
        },
    },

    // z_bg_haka_water.c (Bottom of the Well water): the ring at the actor,
    // and the waterfall at the fixed world point (0, 92, -1680) at 0.1 --
    // from the one placed actor at (0, 0, -740) that is (0, 92, -940).
    "Bg_Haka_Water": {
        model: (params, sceneName, base) => ({
            ...base,
            lists: [base.lists[0], { ...base.lists[1], ops: [['new'], ['t', 0, 92, -940], ['s', 0.1, 0.1, 0.1]] }],
        }),
    },

    // z_boss_va.c: the placed Barinade is BOSSVA_BODY (-1), its skeleton;
    // the mined lists belong to the zappers, Bari and door pieces it spawns.
    "Boss_Va": {
        model: (params, sceneName, base) => ({ ...base, lists: [] }),
    },

    // z_boss_tw.c: the placed one (-1) is the merged Twinrova
    // (gTwinrovaSkel in gTwinrovaTPoseAnim); the mined skeleton and limb
    // lists are Kotake's, the magic particles the sisters' beams.
    "Boss_Tw": {
        scale: 0.025, // BossTw_Init: 2.5 * 0.01 for all but the blasts
        model: (params, sceneName, base) => ({
            ...base, lists: [], limbLists: {},
            skeleton: { file: 'object_tw', offset: 0x30C20, type: 'Flex', limbType: 'Standard' },
            anim: { file: 'object_tw', offset: 0x244B4 },
        }),
    },

    // z_boss_ganon.c: Ganondorf (params < 0x64) as a skeleton only -- the
    // mined lists are his light balls, window shards and the like.
    "Boss_Ganon": {
        model: (params, sceneName, base) => ({ ...base, lists: [] }),
    },

    // z_boss_ganon2.c: Ganon starts as Ganondorf (gGanondorfSkel) buried in
    // the rubble; the light orbs, rubble and Master Sword lists are drawn
    // with their own matrices during the fight.
    "Boss_Ganon2": {
        model: (params, sceneName, base) => ({ ...base, lists: [] }),
    },

    // z_fishing.c (the Fishing Pond; one actor draws it all): the owner
    // (skeleton, eyes open, his hat) at (160, -2, 1208) where Fishing_Init
    // puts him, the aquarium at
    // (130, 40, 1300) scaled (0.08, 0.12, 0.14), and the pond props at their
    // world positions (Fishing_InitPondProps' random sizes at their mean:
    // reeds 0.875, lily pads 0.65 wide, rocks 0.35, posts 0.08; rotations
    // left out). Rod, lure, line and effects are the player's.
    "Fishing": {
        model: (params, sceneName, base) => {
            if ((params & 0xFFFF) >= 100 && (params & 0xFFFF) !== 0xFFFF) return base; // the fish
            const f = (offset, layer, ops) => ({ file: 'object_fish', offset, layer, ...(ops ? { ops } : {}) });
            // 'new' keeps the owner's yaw (-0x6000); undo it for world positions.
            const at = (x, y, z) => [['new'], ['ry', Math.PI * 0.75], ['t', x - 160, y + 2, z - 1208]];
            const lists = [f(0x153D0, 'opa', [...at(130, 40, 1300), ['s', 0.08, 0.12, 0.14]]), f(0x15470, 'xlu', [...at(130, 40, 1300), ['s', 0.08, 0.12, 0.14]])];
            const kinds = {
                r: [0x14030, 0x140B0, 'xlu', [0.875, 0.875, 0.875]], p: [0x13F50, 0x13FD0, 'opa', [0.08, 0.08, 0.08]],
                l: [0x13330, 0x133B0, 'xlu', [0.65, 1, 0.65]], k: [0x13590, 0x13610, 'opa', [0.35, 0.35, 0.35]],
            };
            for (const [type, x, y, z] of OOT_FISHING_PROPS) {
                const [mat, model, layer, s] = kinds[type];
                lists.push(f(mat, layer), f(model, layer, [...at(x, y, z), ['s', ...s], ...(type === 'l' ? [['t', 0, 0, 20]] : [])]));
            }
            return { ...base, lists, segments: { 8: { file: 'object_fish', offset: 0x9250 } } };
        },
        place: (inst) => (((inst.params << 16) >> 16) < 100 ? { position: [160, -2, 1208], rot: [0, -0x6000, 0] } : null),
    },

    // z_en_dy_extra.c (the Great Fairy's light beam): Init keeps its size in
    // this->scale (0.025, 0.039, 0.025) and copies it to the actor.
    "En_Dy_Extra": { scale: [0.025, 0.039, 0.025] },

    // Environment effect actors: nothing placeable to draw.
    "Object_Kankyo": { marker: true },
    // z_en_holl.c: the black plane a room transition fades through.
    "En_Holl": { marker: true },
    "Demo_Kankyo": { marker: true },
};

// A camera-facing quad (the flames' Matrix_ReplaceRotation / camera-yaw
// RotateY) can't face every camera in a static scene: it is drawn twice,
// the second copy turned 90 degrees, so it shows from any side.
function crossed(list) {
    return [list, { ...list, ops: [...(list.ops ?? []), ['ry', Math.PI / 2]] }];
}

// z_fishing.c sPondPropInits: type (r reed, p wood post, l lily pad, k rock)
// and world position of each prop Fishing_DrawPondProps draws.
const OOT_FISHING_PROPS = (
    'k529,-53,-498 k461,-66,-480 k398,-73,-474 k-226,-52,-691 k-300,-41,-710 k-333,-50,-643 k-387,-46,-632 ' +
    'k-484,-43,-596 k-409,-57,-560 p444,-87,-322 p447,-91,-274 p395,-109,-189 r617,-29,646 r698,-26,584 ' +
    'r711,-29,501 r757,-28,457 r812,-29,341 r856,-30,235 r847,-31,83 r900,-26,119 l861,-22,137 l836,-22,150 ' +
    'l829,-22,200 l788,-22,232 l803,-22,319 l756,-22,348 l731,-22,377 l700,-22,392 l706,-22,351 l677,-22,286 ' +
    'l691,-22,250 l744,-22,290 l766,-22,201 l781,-22,128 l817,-22,46 l857,-22,-50 l724,-22,110 l723,-22,145 ' +
    'l728,-22,202 l721,-22,237 l698,-22,312 l660,-22,349 l662,-22,388 l667,-22,432 l732,-22,429 l606,-22,366 ' +
    'l604,-22,286 l620,-22,217 l663,-22,159 l682,-22,73 l777,-22,83 l766,-22,158 r1073,0,-876 r970,0,-853 ' +
    'r896,0,-886 r646,-27,-651 r597,-29,-657 r547,-32,-651 r690,-29,-546 r720,-29,-490 r-756,-30,-409 ' +
    'r-688,-34,-458 r-613,-34,-581 l-593,-22,-479 l-602,-22,-421 l-664,-22,-371 l-708,-22,-316 l-718,-22,-237 ' +
    'r-807,-36,-183 r-856,-29,-259 l-814,-22,-317 l-759,-22,-384 l-718,-22,-441 l-474,-22,-567 l-519,-22,-517 ' +
    'l-539,-22,-487 l-575,-22,-442 l-594,-22,-525 l-669,-22,-514 l-653,-22,-456 r-663,-28,-606 r-708,-26,-567 ' +
    'r-739,-27,-506 r-752,-28,-464 r-709,-29,-513 l-544,-22,-436 l-559,-22,-397 l-616,-22,-353 l-712,-22,-368 ' +
    'l-678,-22,-403 l-664,-22,-273 l-630,-22,-276 l-579,-22,-311 l-588,-22,-351 l-555,-22,-534 l-547,-22,-567 ' +
    'l-592,-22,-571 l-541,-22,-610 l-476,-22,-629 l-439,-22,-598 l-412,-22,-550 l-411,-22,-606 l-370,-22,-634 ' +
    'l-352,-22,-662 l-413,-22,-641 l-488,-22,-666 l-578,-22,-656 l-560,-22,-640 l-531,-22,-654 l-451,-22,-669 ' +
    'l-439,-22,-699 l-482,-22,-719 l-524,-22,-720 l-569,-22,-714 r-520,-27,-727 r-572,-28,-686 r-588,-32,-631 ' +
    'r-622,-34,-571 r-628,-36,-510 r-655,-36,-466 r-655,-41,-393 r-661,-47,-328 r-723,-40,-287 r-756,-33,-349 ' +
    'r-755,-43,-210 l-770,-22,-281 l-750,-22,-313 l-736,-22,-341 l-620,-22,-418 l-601,-22,-371 l-635,-22,-383 ' +
    'l-627,-22,-311 l-665,-22,-327 l-524,-22,-537 l-514,-22,-579 l-512,-22,-623 l-576,-22,-582 l-600,-22,-608 ' +
    'l-657,-22,-531 l-641,-22,-547 '
).trim().split(' ').map(s => [s[0], ...s.slice(1).split(',').map(Number)]);

// z_en_bb.c EnBb_Init: a params with bit 7 set becomes params | 0xFF00.
function enBbType(params) {
    const p = (params & 0x80) ? (params | 0xFF00) : params;
    return (p << 16) >> 16;
}

// gameplay_dangeon_keep textures Obj_Switch puts in segments 8 / 9.
const OOT_GOLD_EYE_OPEN = 0xA8A0;   // gEyeSwitchGoldOpenTex
const OOT_SILVER_EYE_OPEN = 0xB0A0; // gEyeSwitchSilverOpenTex
const OOT_CRYSTAL_RED_TEX = 0x144B0; // gCrstalSwitchRedTex

// z_en_light.c D_80A9E840: [prim rgb, env rgb] by params & 0xF.
const OOT_LIGHT_COLOURS = [
    [[255, 200, 0], [255, 0, 0]], [[255, 200, 0], [255, 0, 0]], [[0, 170, 255], [0, 0, 255]], [[170, 255, 0], [0, 150, 0]],
    [[255, 200, 0], [255, 0, 0]], [[255, 200, 0], [255, 0, 0]], [[170, 255, 0], [0, 150, 0]], [[0, 170, 255], [0, 0, 255]],
    [[255, 0, 170], [200, 0, 0]], [[255, 255, 170], [255, 50, 0]], [[255, 255, 170], [255, 255, 0]], [[255, 255, 170], [100, 255, 0]],
    [[255, 170, 255], [255, 0, 100]], [[255, 170, 255], [100, 0, 255]], [[170, 255, 255], [0, 0, 255]], [[170, 255, 255], [0, 150, 255]],
];

const keep = (offset, layer = 'opa') => ({ file: 'gameplay_keep', offset, layer });

// z_obj_timeblock.c sPrimColors.
const TIMEBLOCK_PRIM = [
    [100, 120, 140], [80, 140, 200], [100, 150, 200], [100, 200, 240],
    [80, 110, 140], [70, 160, 225], [80, 100, 130], [100, 110, 190],
];

// z_obj_oshihiki.c sColors, by the scene (sSceneIds) it is in.
const OSHIHIKI_COLORS = {
    ydan_scene: [[110, 86, 40], [110, 86, 40], [110, 86, 40], [110, 86, 40]],
    ddan_scene: [[106, 120, 110], [104, 80, 20], [0, 0, 0], [0, 0, 0]],
    Bmori1_scene: [[142, 99, 86], [72, 118, 96], [0, 0, 0], [0, 0, 0]],
    HIDAN_scene: [[210, 150, 80], [210, 170, 80], [0, 0, 0], [0, 0, 0]],
    MIZUsin_scene: [[102, 144, 182], [176, 167, 100], [100, 167, 100], [117, 97, 96]],
    jyasinzou_scene: [[232, 210, 176], [232, 210, 176], [232, 210, 176], [232, 210, 176]],
    HAKAdan_scene: [[135, 125, 95], [135, 125, 95], [135, 125, 95], [135, 125, 95]],
    ganon_scene: [[255, 255, 255], [255, 255, 255], [255, 255, 255], [255, 255, 255]],
    men_scene: [[232, 210, 176], [232, 210, 176], [232, 210, 176], [232, 210, 176]],
};

// z_en_sw.c: the type after Init folds bit 15 into it.
function enSwType(params) {
    return (params & 0x8000) ? (((params - 0x8000) >> 13) & 7) + 1 : (params >> 13) & 7;
}

// z_en_sw.c func_80B0C0CC(this, play, 1) from Init: up (0, 1, 0), right and
// forward from the yaw. Line-test 18 above to 18 below; on a hit, look 24
// forward from the top for a wall to prefer; with no hit (or for the falling
// types 3-4) look 24 back, right and left from the bottom. func_80B0BE20
// then turns the frame so up is the polygon's normal and the actor stands
// at the hit.
function enSwStandOnPoly(inst, collision) {
    const V = (x, y, z) => new THREE.Vector3(x, y, z);
    const yaw = inst.rot[1] * BINANG_TO_RAD;
    const up = V(0, 1, 0), right = V(Math.sin(yaw + Math.PI / 2), 0, Math.cos(yaw + Math.PI / 2)), fwd = V(Math.sin(yaw), 0, Math.cos(yaw));
    const pos = V(...inst.position);
    const top = pos.clone().addScaledVector(up, 18), bottom = pos.clone().addScaledVector(up, -18);
    let hit = null;
    const falling = enSwType(inst.params) >= 3;
    const first = falling ? null : collision.lineTest(top, bottom);
    if (first) {
        hit = collision.lineTest(top, top.clone().addScaledVector(fwd, 24)) ?? first;
    } else {
        for (const dir of [fwd.clone().negate(), right, right.clone().negate()]) {
            hit = collision.lineTest(bottom, bottom.clone().addScaledVector(dir, 24));
            if (hit) break;
        }
    }
    if (!hit) return {};
    const n = hit.normal.clone().normalize();
    const axis = up.clone().cross(n);
    const r = right.clone();
    if (axis.lengthSq() > 1e-8) r.applyMatrix4(new THREE.Matrix4().makeRotationAxis(axis.normalize(), Math.acos(Math.min(1, Math.max(-1, up.dot(n))))));
    const f = r.clone().cross(n);
    if (f.lengthSq() < 1e-6) return {};
    f.normalize();
    const e = new THREE.Euler().setFromRotationMatrix(new THREE.Matrix4().makeBasis(r, n, f), 'YXZ');
    return {
        position: [hit.point.x, hit.point.y, hit.point.z],
        rot: [Math.round(e.x / BINANG_TO_RAD), Math.round(e.y / BINANG_TO_RAD), Math.round(e.z / BINANG_TO_RAD)],
    };
}

// z_door_shutter.c tables. Styles: [object's file, gfxType1, gfxType2].
const DOOR_STYLES = [
    [4, 4], [5, 5], [0, 1], [2, 2], [3, 3], [8, 8], [7, 7], [8, 8], [9, 10], [11, 11],
    [6, 6], [12, 13], [14, 15], [16, 16], [17, 17], [18, 18], [19, 19],
];
const DOOR_TYPE_STYLES = [-1, -1, -1, -1, 0, 6, 1, -1, 0, -1, -1, -1];
const DOOR_SCENE_STYLES = {
    ydan_scene: 2, ddan_scene: 3, ddan_boss_scene: 3, bdan_scene: 4, Bmori1_scene: 5, HIDAN_scene: 8,
    ganon_scene: 9, ganon_boss_scene: 9, jyasinzou_scene: 10, jyasinboss_scene: 10, MIZUsin_scene: 11,
    HAKAdan_scene: 12, HAKAdanCH_scene: 12, ice_doukutu_scene: 13, men_scene: 14, ganontika_scene: 15,
    hakaana_ouke_scene: 16,
};
// sGfxInfo: [door list, bars list, barsOffsetZ].
const dl = (file, offset) => ({ file, offset, layer: 'opa' });
const KEEP_BARS = dl('gameplay_keep', 0x50600);
const DOOR_GFX = [
    [dl('object_ydan_objects', 0x67A0), KEEP_BARS, 12], [dl('object_ydan_objects', 0x6910), KEEP_BARS, 12],
    [dl('object_ddan_objects', 0xC0), dl('object_ddan_objects', 0x1F0), 14],
    [null, dl('object_bdan_objects', 0x6460), 110],
    [dl('object_gnd', 0x12AB0), null, 12], [dl('object_goma', 0x1D820), null, 12],
    [dl('object_jya_door', 0x100), dl('object_jya_door', 0x1F0), 14], [dl('object_bdoor', 0x10C0), null, 12],
    [dl('gameplay_keep', 0x4F510), KEEP_BARS, 12],
    [dl('object_hidan_objects', 0x10CB0), KEEP_BARS, 12], [dl('object_hidan_objects', 0x11F20), KEEP_BARS, 12],
    [dl('object_ganon_objects', 0xC0), KEEP_BARS, 12],
    [dl('object_mizu_objects', 0x5D90), KEEP_BARS, 12], [dl('object_mizu_objects', 0x7000), KEEP_BARS, 12],
    [dl('object_haka_door', 0x2620), KEEP_BARS, 12], [dl('object_haka_door', 0x3890), KEEP_BARS, 12],
    [dl('object_ice_objects', 0x1D10), KEEP_BARS, 12], [dl('object_menkuri_objects', 0x10D0), KEEP_BARS, 12],
    [dl('object_demo_kekkai', 0x20D0), KEEP_BARS, 12], [dl('object_ouke_haka', 0xC0), KEEP_BARS, 12],
];
// sBossDoorInfo -> sBossDoorTextures (object_bdoor), by dungeon or boss scene.
const BOSS_DOOR_TEX = {
    HIDAN_scene: 0x35C0, FIRE_bs_scene: 0x35C0, MIZUsin_scene: 0x55C0, MIZUsin_bs_scene: 0x55C0,
    HAKAdan_scene: 0x45C0, HAKAdan_bs_scene: 0x45C0, ganon_scene: 0x0, ganon_boss_scene: 0x0,
    Bmori1_scene: 0x25C0, moribossroom_scene: 0x25C0, jyasinzou_scene: 0x15C0, jyasinboss_scene: 0x15C0,
};
// sJabuDoorDLists (object_bdan_objects).
const JABU_SECTIONS = [0x590, 0xBF0, 0x2BD0, 0x18B0, 0x1F10, 0x18B0, 0x1250, 0xBF0];

function doorShutterGfx(params, sceneName) {
    const type = (params >> 6) & 0xF;
    let style = DOOR_TYPE_STYLES[type] ?? -1;
    if (style < 0) style = DOOR_SCENE_STYLES[sceneName] ?? 7;
    return DOOR_STYLES[style][type === 0 ? 0 : 1];
}

function doorShutterModel(params, sceneName) {
    const type = (params >> 6) & 0xF;
    const gfx = doorShutterGfx(params, sceneName);
    const [door, bars, barsZ] = DOOR_GFX[gfx];
    const lists = [];
    if (gfx === 3) {
        // DoorShutter_DrawJabuJabuDoor: section i turned -i * 45 degrees
        // about z and pushed out along y.
        JABU_SECTIONS.forEach((offset, i) => {
            const y = i % 2 === 0 ? 800 : (i === 1 || i === 7) ? 848.52 : 989.94;
            lists.push({ ...dl('object_bdan_objects', offset), ops: [['rz', -i * Math.PI / 4], ['t', 0, y, 0]] });
        });
    } else {
        lists.push(door);
    }
    // Barred until the room is cleared / the switch is set.
    if (bars && [1, 2, 7].includes(type)) lists.push({ ...bars, ops: [['t', 0, 0, barsZ]] });
    const segments = gfx === 7 ? { 8: { file: 'object_bdoor', offset: BOSS_DOOR_TEX[sceneName] ?? 0x65C0 } } : {};
    return { object: lists[0].file, lists, segments };
}
const keepTex = (offset) => ({ file: 'gameplay_keep', offset });

// z_en_door.c sDoorInfo -> sDoorDLists: [file, left list, right list].
const EN_DOOR_LISTS = {
    HIDAN_scene: ['object_hidan_objects', 0xF998, 0xF938],
    MIZUsin_scene: ['object_mizu_objects', 0x4958, 0x4A10],
    HAKAdan_scene: ['object_haka_door', 0x13B8, 0x1420],
    HAKAdanCH_scene: ['object_haka_door', 0x13B8, 0x1420],
};

// z_actor.c Actor_DrawDoorLock(frame 10, DOORLOCK_NORMAL): from (0, 5000,
// 500), four gDoorChainDL turned about z (chainRotZ stepping by pi - 2 *
// chainAngle, then 2 * chainAngle), and gDoorLockDL at scale 1.
function doorLockLists() {
    const angle = 0.54, base = ['t', 0, 5000, 500];
    const lists = [];
    let rz = 0;
    for (let i = 0; i < 4; i++) {
        lists.push({ file: 'gameplay_dangeon_keep', offset: 0x11F0, layer: 'opa', ops: [base, ['rz', rz]] });
        rz += i % 2 ? 2 * angle : Math.PI - 2 * angle;
    }
    lists.push({ file: 'gameplay_dangeon_keep', offset: 0x1100, layer: 'opa', ops: [base] });
    return lists;
}

// gameplay_keep sDLists[] of z_en_a_keep.c, by A_OBJ_ type. Type 6's
// gHookshotPostDL is in object_d_hsblock, which no A_Obj placement loads.
const A_OBJ_LISTS = [
    keep(0x3A430), keep(0x3A430), keep(0x3A430),            // gFlatBlockDL: BLOCK_SMALL / LARGE / HUGE
    keep(0x3AB00), keep(0x3AB00),                           // gFlatRotBlockDL: BLOCK_SMALL_ROT / LARGE_ROT
    keep(0x3AE60),                                          // gSmallCubeDL: CUBE_SMALL
    null,                                                   // UNKNOWN_6
    keep(0x3B3B0),                                          // gGrassBladesDL: GRASS_CLUMP
    keep(0x3B1E0),                                          // gTreeStumpDL: TREE_STUMP
    keep(0x3D560),                                          // gSignRectangularDL: SIGNPOST_OBLONG
    keep(0x3DAC0),                                          // gSignDirectionalDL: SIGNPOST_ARROW
    keep(0xD7E0),                                           // gBoulderFragmentsDL: BOULDER_FRAGMENT
];

// z_en_item00.c per ITEM00_ type: EnItem00_Init's scale and yOffset, and
// the lists of the draw function the type dispatches to.
// sRupeeTex: gRupeeGreenTex, Blue, Red, Pink (0x44ED0, drawn by the orange
// rupee), Orange (0x44EB0, drawn by the purple one), in the game's order.
const RUPEE_TEX = [0x44E50, 0x44E70, 0x44E90, 0x44ED0, 0x44EB0];
const DROP_TEX = [0x40D80, 0x3F580, 0x3E580, 0x3DD80, 0x3ED80, 0x3F580, 0x42E50, 0x43E50, 0x44650, 0x42650, 0x43650, 0x41E50]; // sItemDropTex
const rupee = (texIndex, scale) => ({ scale, yOffset: 750, model: { object: 'gameplay_keep', lists: [keep(0x45150)], segments: { 8: keepTex(RUPEE_TEX[texIndex]) } } });
const drop = (texIndex, scale, yOffset) => ({ scale, yOffset, model: { object: 'gameplay_keep', lists: [keep(0x41D80)], segments: { 8: keepTex(DROP_TEX[texIndex]) } } });
const ITEM00_TYPES = {
    0x00: rupee(0, 0.015), 0x01: rupee(1, 0.015), 0x02: rupee(2, 0.015),
    0x13: rupee(3, 0.045), 0x14: rupee(4, 0.03),
    // The recovery heart is drawn under Matrix_Scale(16) on top of its 0.02.
    0x03: { scale: 0.32, yOffset: 430, model: { object: 'object_gi_heart', lists: [{ file: 'object_gi_heart', offset: 0xE0, layer: 'xlu' }] } },
    0x04: drop(1, 0.03, 320), 0x05: drop(2, 0.02, 400),
    0x06: { scale: 0.02, yOffset: 650, model: { object: 'gameplay_keep', lists: [keep(0x3B860, 'xlu')] } },
    0x07: { scale: 0.02, yOffset: 430, model: { object: 'gameplay_keep', lists: [keep(0x3C3D0), keep(0x3C508, 'xlu')] } },
    0x08: drop(2, 0.035, 250), 0x09: drop(3, 0.035, 250), 0x0A: drop(4, 0.035, 250),
    0x0B: drop(5, 0.03, 320), 0x0C: drop(6, 0.03, 320), 0x0D: drop(7, 0.03, 320),
    0x0E: drop(8, 0.045, 320), 0x0F: drop(9, 0.03, 320), 0x10: drop(10, 0.03, 320),
    0x11: drop(11, 0.03, 350), 0x19: drop(1, 0.03, 320),
    0x12: { scale: 0.01, yOffset: 500 },
    0x15: { scale: 0.5 }, 0x16: { scale: 0.5 }, 0x17: { scale: 0.5 }, 0x18: { scale: 0.5 },
};

////////////////////////////////////////
// Files
////////////////////////////////////////

const fileCache = new Map(); // "game/file name" -> Promise<DataView | null>

function loadFile(game, name) {
    const key = `${game}/${name}`;
    let p = fileCache.get(key);
    if (!p) {
        const dir = name.startsWith('ovl_') ? 'overlays' : 'objects';
        p = fetch(`./models/${game}/actors/${dir}/${name}`)
            .then(res => res.ok ? res.arrayBuffer().then(b => new DataView(b)) : null)
            .catch(() => null);
        fileCache.set(key, p);
    }
    return p;
}

/** The keep object a scene loads into segment 5 (SCENE_CMD_SPECIAL_FILES). */
function sceneKeepObject(sceneDv) {
    for (let off = 0; off + 8 <= sceneDv.byteLength; off += 8) {
        const cmd = sceneDv.getUint8(off);
        if (cmd === CMD_END) break;
        if (cmd === CMD_SPECIAL_FILES) return sceneDv.getUint32(off + 4, false);
    }
    return 0;
}

const CMD_COL_HEADER = 0x03, CMD_TRANSITION_ACTOR_LIST = 0x0E, CMD_ALTERNATE_HEADER_LIST = 0x18;

// The offset of a scene header's commands for a setup: 0 for setup 0, else
// the alternate header list's entry (the main header when it is empty).
function sceneHeaderOffset(sceneDv, setupID) {
    if (!setupID) return 0;
    for (let off = 0; off + 8 <= sceneDv.byteLength; off += 8) {
        const cmd = sceneDv.getUint8(off);
        if (cmd === CMD_END) break;
        if (cmd === CMD_ALTERNATE_HEADER_LIST) {
            const list = sceneDv.getUint32(off + 4, false) & 0xFFFFFF;
            const at = list + (setupID - 1) * 4;
            if (at + 4 > sceneDv.byteLength) return 0;
            return sceneDv.getUint32(at, false) & 0xFFFFFF;
        }
    }
    return 0;
}

function sceneCommand(sceneDv, headerOff, want) {
    for (let off = headerOff; off + 8 <= sceneDv.byteLength; off += 8) {
        const cmd = sceneDv.getUint8(off);
        if (cmd === CMD_END) break;
        if (cmd === want) return { count: sceneDv.getUint8(off + 1), addr: sceneDv.getUint32(off + 4, false) & 0xFFFFFF };
    }
    return null;
}

/**
 * The setup's transition actors (TransitionActorEntry, 0x10 bytes each), as
 * Actor_SpawnTransitionActors spawns them: id & 0x1FFF, rot (0, rotY, 0),
 * params + (index << 10). MM packs rotY as degrees in bits 7-15 (the low 7
 * bits are a cutscene id) and keeps only params' low 10 bits.
 */
function transitionActors(sceneDv, setupID, game) {
    const cmd = sceneCommand(sceneDv, sceneHeaderOffset(sceneDv, setupID), CMD_TRANSITION_ACTOR_LIST)
        ?? sceneCommand(sceneDv, 0, CMD_TRANSITION_ACTOR_LIST);
    const out = [];
    if (!cmd) return out;
    for (let i = 0; i < cmd.count; i++) {
        const o = cmd.addr + i * 0x10;
        if (o + 0x10 > sceneDv.byteLength) break;
        let rotY = sceneDv.getInt16(o + 12, false), params = sceneDv.getUint16(o + 14, false);
        if (game === 'MM') {
            rotY = Math.trunc(((rotY >> 7) & 0x1FF) * (0x8000 / 180)) << 16 >> 16;
            params &= 0x3FF;
        }
        out.push({
            frontRoom: sceneDv.getInt8(o), backRoom: sceneDv.getInt8(o + 2),
            id: sceneDv.getInt16(o + 4, false),
            position: [sceneDv.getInt16(o + 6, false), sceneDv.getInt16(o + 8, false), sceneDv.getInt16(o + 10, false)],
            rotY, params: ((i << 10) + params) & 0xFFFF,
        });
    }
    return out.filter(t => t.id >= 0);
}

/**
 * The scene's static collision as triangles ({ a, b, c, normal }) with a
 * line test, BgCheck_EntityLineTest1's closest hit on either face:
 * lineTest(from, to) -> { point, normal } or null.
 */
function sceneCollision(sceneDv) {
    const tris = [];
    const cmd = sceneCommand(sceneDv, 0, CMD_COL_HEADER);
    if (cmd && cmd.addr + 0x2C <= sceneDv.byteLength) {
        const h = cmd.addr;
        const numVerts = sceneDv.getUint16(h + 0x0C, false), vtx = sceneDv.getUint32(h + 0x10, false) & 0xFFFFFF;
        const numPolys = sceneDv.getUint16(h + 0x14, false), polys = sceneDv.getUint32(h + 0x18, false) & 0xFFFFFF;
        const vert = (i) => {
            const o = vtx + (i & 0x1FFF) * 6;
            return o + 6 <= sceneDv.byteLength && (i & 0x1FFF) < numVerts
                ? new THREE.Vector3(sceneDv.getInt16(o, false), sceneDv.getInt16(o + 2, false), sceneDv.getInt16(o + 4, false)) : null;
        };
        for (let i = 0; i < numPolys; i++) {
            const o = polys + i * 0x10;
            if (o + 0x10 > sceneDv.byteLength) break;
            const a = vert(sceneDv.getUint16(o + 2, false)), b = vert(sceneDv.getUint16(o + 4, false)), c = vert(sceneDv.getUint16(o + 6, false));
            if (!a || !b || !c) continue;
            const normal = new THREE.Vector3(sceneDv.getInt16(o + 8, false), sceneDv.getInt16(o + 10, false), sceneDv.getInt16(o + 12, false)).divideScalar(0x7FFF);
            tris.push({ a, b, c, normal });
        }
    }
    const ray = new THREE.Ray(), hit = new THREE.Vector3(), dir = new THREE.Vector3();
    const lineTest = (from, to) => {
        dir.subVectors(to, from);
        const len = dir.length();
        if (len === 0) return null;
        ray.set(from, dir.divideScalar(len));
        let best = null, bestDist = len;
        for (const t of tris) {
            if (!ray.intersectTriangle(t.a, t.b, t.c, false, hit)) continue;
            const d = hit.distanceTo(from);
            if (d <= bestDist) { bestDist = d; best = { point: hit.clone(), normal: t.normal }; }
        }
        return best;
    };
    return { lineTest };
}

// A segment entry for a file reference ({ file, offset, vram? }).
function segmentFor(dv, ref) {
    if (!dv) return null;
    return ref.vram != null ? { dv, vram: ref.vram, key: ref.file } : { dv, base: 0, key: ref.file };
}

// The segment a file is compiled against, which is where its own pointers
// expect it: the keep files are 4 and 5, an object is 6.
function fileSegment(file) {
    if (file === 'gameplay_keep') return SEG_KEEP;
    if (file === 'gameplay_field_keep' || file === 'gameplay_dangeon_keep') return SEG_SCENE_KEEP;
    return SEG_OBJECT;
}

// The address a file reference is reached at through the segments it is
// mapped in: a VRAM address for overlay data, else its file's segment.
function refAddress(ref) {
    return ref.vram != null ? (ref.vram + ref.offset) >>> 0 : (fileSegment(ref.file) << 24) | ref.offset;
}

function resolveAddr(segments, addr) {
    const seg = (addr >>> 31) ? segments.vram : segments[(addr >>> 24) & 0xF];
    if (!seg || !seg.dv) return null;
    const off = seg.vram != null ? (addr - seg.vram) : seg.base + (addr & 0xFFFFFF);
    return (off >= 0 && off < seg.dv.byteLength) ? { dv: seg.dv, off } : null;
}

// MM AnimatedMaterial list { s8 segment; s16 type; void* params }, 8 bytes
// each, ending after the entry with a negative segment; the segment set is
// |segment| + 7. At step 0 (AnimatedMat_Draw*): a colour keyframe list sets
// its first prim / env colour, a texture cycle its first texture, a scroll
// the tile sizes (the offsets start at 0).
const ANIM_MAT_TEX_SCROLL = 0, ANIM_MAT_TWO_TEX_SCROLL = 1, ANIM_MAT_TEX_CYCLE = 5;
function animMatSegments(segments, ref) {
    const out = {};
    const list = resolveAddr(segments, refAddress(ref));
    if (!list) return out;
    for (let i = 0; i < 16; i++) {
        const o = list.off + i * 8;
        if (o + 8 > list.dv.byteLength) break;
        const segByte = list.dv.getInt8(o), type = list.dv.getInt16(o + 2, false);
        const params = resolveAddr(segments, list.dv.getUint32(o + 4, false));
        const seg = Math.abs(segByte) + 7;
        if (params) {
            const d = params.dv, p = params.off;
            if (type === ANIM_MAT_TEX_SCROLL || type === ANIM_MAT_TWO_TEX_SCROLL) {
                // AnimatedMatTexScrollParams { s8 xStep, yStep; u8 width, height } (one or two)
                const tiles = [[0, d.getUint8(p + 2), d.getUint8(p + 3)]];
                if (type === ANIM_MAT_TWO_TEX_SCROLL) tiles.push([1, d.getUint8(p + 6), d.getUint8(p + 7)]);
                out[seg] = scrollSegment(tiles);
            } else if (type >= 2 && type <= 4) {
                // AnimatedMatColorParams { u16 keyFrameLength, keyFrameCount; F3DPrimColor* prim; F3DEnvColor* env; u16* keyFrames }
                const prim = resolveAddr(segments, d.getUint32(p + 4, false));
                const envAddr = d.getUint32(p + 8, false);
                const env = envAddr ? resolveAddr(segments, envAddr) : null;
                if (prim) {
                    const c = (r, k) => r.dv.getUint8(r.off + k) / 255;
                    out[seg] = { colour: {
                        prim: [c(prim, 0), c(prim, 1), c(prim, 2), c(prim, 3)],
                        lodFrac: prim.dv.getUint8(prim.off + 4) / 256,
                        env: env ? [c(env, 0), c(env, 1), c(env, 2), c(env, 3)] : null,
                    } };
                }
            } else if (type === ANIM_MAT_TEX_CYCLE) {
                // AnimatedMatTexCycleParams { u16 keyFrameLength; TexturePtr* textureList; u8* textureIndexList }
                const texList = resolveAddr(segments, d.getUint32(p + 4, false));
                const idx = resolveAddr(segments, d.getUint32(p + 8, false));
                const tex = texList && idx ? resolveAddr(segments, texList.dv.getUint32(texList.off + idx.dv.getUint8(idx.off) * 4, false)) : null;
                if (tex) out[seg] = { dv: tex.dv, base: tex.off, key: `animmat+${tex.off}` };
            }
        }
        if (segByte <= 0) break;
    }
    return out;
}

////////////////////////////////////////
// Skeletons
////////////////////////////////////////

// The matrix of a Draw's literal Matrix_* calls (generated as ops): each is
// applied on the right, as the game's MTXMODE_APPLY does. A leading "new"
// (MTXMODE_NEW, rebuilt from the actor's position) drops the actor's scale,
// which the instance transform would otherwise apply.
const _op = new THREE.Matrix4();
function opsMatrix(ops, scale) {
    if (!ops || !ops.length) return null;
    const m = new THREE.Matrix4();
    for (const op of ops) {
        switch (op[0]) {
            case 'new': _op.makeScale(1 / scale[0], 1 / scale[1], 1 / scale[2]); break;
            case 't': _op.makeTranslation(op[1], op[2], op[3]); break;
            case 's': _op.makeScale(op[1], op[2], op[3]); break;
            case 'rx': _op.makeRotationX(op[1]); break;
            case 'ry': _op.makeRotationY(op[1]); break;
            case 'rz': _op.makeRotationZ(op[1]); break;
            default: continue;
        }
        m.multiply(_op);
    }
    return m;
}

/**
 * A skeleton header and its limbs: { limbs: [{ pos, child, sibling, dl }],
 * flex, dListCount }. dl is the limb's display-list address (0 for none);
 * LOD limbs give their near list.
 */
function parseSkeleton(segments, ref) {
    const flex = ref.type === 'Flex';
    const hdr = resolveAddr(segments, refAddress(ref));
    if (!hdr || hdr.off + (flex ? 12 : 8) > hdr.dv.byteLength) return null;
    const tableAddr = hdr.dv.getUint32(hdr.off, false);
    const limbCount = hdr.dv.getUint8(hdr.off + 4);
    const dListCount = flex ? hdr.dv.getUint8(hdr.off + 8) : 0;
    const table = resolveAddr(segments, tableAddr);
    if (!table || table.off + limbCount * 4 > table.dv.byteLength) return null;

    const limbSize = ref.limbType === 'LOD' ? LOD_LIMB_SIZE : STANDARD_LIMB_SIZE;
    const limbs = [];
    for (let i = 0; i < limbCount; i++) {
        const limb = resolveAddr(segments, table.dv.getUint32(table.off + i * 4, false));
        if (!limb || limb.off + limbSize > limb.dv.byteLength) return null;
        const d = limb.dv, o = limb.off;
        limbs.push({
            pos: [d.getInt16(o, false), d.getInt16(o + 2, false), d.getInt16(o + 4, false)],
            child: d.getUint8(o + 6),
            sibling: d.getUint8(o + 7),
            dl: d.getUint32(o + 8, false),
        });
    }
    return { limbs, flex, dListCount };
}

/**
 * Frame 0 of an animation for a skeleton of limbCount limbs: the joint
 * table [[x, y, z] ...] with entry 0 the root translation and entry i + 1
 * limb i's rotation (binang), as SkelAnime_AnimateFrame fills it.
 */
// The segments an animation is read with: one in another object than the
// skeleton's (MM's shopkeepers play object_mastergolon's on gGoronSkel) is
// in segment 6 while it plays, as the game swaps it in.
function animSegments(segments, ref, dvs) {
    if (ref.vram != null || fileSegment(ref.file) !== SEG_OBJECT || segments[SEG_OBJECT]?.key === ref.file || !dvs.get(ref.file)) return segments;
    const segs = segments.slice();
    segs.vram = segments.vram;
    segs[SEG_OBJECT] = segmentFor(dvs.get(ref.file), ref);
    return segs;
}

// The segments a list is run with: one from another object than segment 6's
// has that object swapped into segment 6.
function otherObjectSegments(segments, l, dvs) {
    if (fileSegment(l.file) !== SEG_OBJECT || l.vram != null || !dvs.get(l.file) || segments[SEG_OBJECT]?.key === l.file) return segments;
    const segs = segments.slice();
    segs.vram = segments.vram;
    segs[SEG_OBJECT] = segmentFor(dvs.get(l.file), l);
    return segs;
}

function animationFrame0(segments, ref, limbCount) {
    const hdr = resolveAddr(segments, refAddress(ref));
    if (!hdr || hdr.off + 0x10 > hdr.dv.byteLength) return null;
    const frameData = resolveAddr(segments, hdr.dv.getUint32(hdr.off + 4, false));
    const jointIndices = resolveAddr(segments, hdr.dv.getUint32(hdr.off + 8, false));
    const staticIndexMax = hdr.dv.getUint16(hdr.off + 0xC, false);
    if (!frameData || !jointIndices) return null;
    const joints = [];
    for (let i = 0; i < limbCount + 1; i++) {
        const jo = jointIndices.off + i * 6;
        if (jo + 6 > jointIndices.dv.byteLength) return null;
        const v = [];
        for (let k = 0; k < 3; k++) {
            // Static values index the table directly; dynamic ones add the
            // frame, which at frame 0 is the same thing.
            const idx = jointIndices.dv.getUint16(jo + k * 2, false);
            const fo = frameData.off + idx * 2;
            v.push(fo + 2 <= frameData.dv.byteLength ? frameData.dv.getInt16(fo, false) : 0);
        }
        joints.push(v);
    }
    return joints;
}

/**
 * Pose a skeleton: the display lists to run, each under its limb's model
 * space matrix, in SkelAnime_Draw* traversal order, plus the flex matrix
 * buffer (one entry per limb with a list). limbLists substitutes lists for
 * limbs an override callback fills in, or (add: true) draws them after the
 * limb's own, as a post-limb callback does, under the limb's matrix times
 * the list's ops.
 */
function poseSkeleton(skel, joints, limbLists, root = null) {
    const items = [];
    const matrices = [];
    const limbWorld = []; // every limb's matrix, by limb index
    const euler = new THREE.Euler();
    const local = new THREE.Matrix4();
    const pos = new THREE.Vector3();

    const visit = (index, parent, isRoot) => {
        const limb = skel.limbs[index];
        if (!limb) return;
        // Matrix_TranslateRotateZYX: translate, then rotate Z, Y, X.
        const t = isRoot ? (joints ? joints[0] : [0, 0, 0]) : limb.pos;
        const r = joints ? joints[index + 1] : [0, 0, 0];
        euler.set(r[0] * BINANG_TO_RAD, r[1] * BINANG_TO_RAD, r[2] * BINANG_TO_RAD, 'ZYX');
        local.makeRotationFromEuler(euler);
        local.setPosition(pos.set(t[0], t[1], t[2]));
        const world = parent ? parent.clone().multiply(local) : (root ? root.clone().multiply(local) : local.clone());
        limbWorld[index] = world;

        // limbLists is keyed by the callback's limbIndex, which counts from 1.
        // An empty list hides the limb (the callback's *dList = NULL).
        const own = limbLists?.[index + 1];
        const hidden = Array.isArray(own) && own.length === 0;
        const lists = own ?? [];
        const replaced = lists.filter(l => !l.add);
        if (hidden) {
            // nothing drawn
        } else if (replaced.length) {
            for (const ref of replaced) items.push({ addr: refAddress(ref), matrix: world, layer: ref.layer ?? 'opa', ref });
        } else if (limb.dl) {
            items.push({ addr: limb.dl, matrix: world, layer: 'opa' });
        }
        // A hidden limb still takes its flex matrix slot (SkelAnime_DrawFlexLimb).
        if (replaced.length || limb.dl) matrices.push(world);
        for (const ref of lists.filter(l => l.add)) {
            const ops = opsMatrix(ref.ops, [1, 1, 1]);
            items.push({ addr: refAddress(ref), matrix: ops ? world.clone().multiply(ops) : world, layer: ref.layer ?? 'opa', ref });
        }
        if (limb.child !== LIMB_DONE) visit(limb.child, world, false);
        if (!isRoot && limb.sibling !== LIMB_DONE) visit(limb.sibling, parent, false);
    };
    visit(0, null, true);
    return { items, matrices, limbWorld };
}

////////////////////////////////////////
// Model specs
////////////////////////////////////////

// A generated `when` test on the params: [shift, mask, op, value] (a
// full-word field compares as the s16 the actor sees), or { any | all |
// not } of those.
function paramsTest(test, params) {
    if (Array.isArray(test)) {
        const [shift, mask, op, value] = test;
        let v = (params >> shift) & mask;
        if (shift === 0 && mask === 0xFFFF && v >= 0x8000) v -= 0x10000;
        switch (op) {
            case '==': return v === value;
            case '!=': return v !== value;
            case '<': return v < value;
            case '>': return v > value;
            case '<=': return v <= value;
            case '>=': return v >= value;
            default: return true;
        }
    }
    if (test.any) return test.any.some(t => paramsTest(t, params));
    if (test.all) return test.all.every(t => paramsTest(t, params));
    if (test.not) return !paramsTest(test.not, params);
    return true;
}

// The lists a spec draws for these params: a { select, variants } entry
// picks variants[(params >> shift) & mask]; an entry with `when` is only
// drawn when its params tests hold (the Draw's `if (params == ...)`).
function selectLists(lists, params) {
    const out = [];
    for (const l of lists ?? []) {
        if (l.when && !l.when.every(t => paramsTest(t, params))) continue;
        if (l.variants) {
            const i = l.select ? (params >> l.select[0]) & l.select[1] : 0;
            out.push(...selectLists(l.variants[i] ?? [], params));
        } else {
            out.push(l);
        }
    }
    return out;
}

function scaleOf(spec, override, params, sceneName, rot) {
    let s = override?.scale ?? spec?.scale ?? DEFAULT_SCALE;
    if (typeof s === 'function') s = s(params, sceneName, rot);
    return Array.isArray(s) ? s : [s, s, s];
}

/**
 * Everything needed to draw an actor at these params: the object file
 * set, the posed lists and a cache key. Null when the actor has no model.
 */
function modelSpec(actorName, base, override, params, sceneName, scale, rot, keepFile, room) {
    if (override?.marker) return null;
    let spec = base;
    if (override?.model) spec = override.model(params, sceneName, base, rot, keepFile, room);
    if (!spec) return null;
    if (override?.lists) spec = { ...spec, lists: override.lists };
    if (override?.limbLists) spec = { ...spec, limbLists: override.limbLists };
    if (override?.segments) spec = { ...spec, segments: { ...(spec.segments ?? {}), ...override.segments } };

    const skeleton = spec.skeleton && spec.skeleton.limbType !== 'Skin' && spec.skeleton.limbType !== 'Curve'
        && spec.skeleton.type !== 'Curve' ? spec.skeleton : null;
    const lists = selectLists(spec.lists, params);
    if (!skeleton && !lists.length) return null;

    // The files the model is in: the skeleton's, the lists', the segment
    // textures'. The profile's object (spec.object) is only a name here --
    // an actor can draw entirely from another object it loads itself.
    const files = new Set();
    if (skeleton) files.add(skeleton.file);
    if (spec.anim) files.add(spec.anim.file);
    for (const l of lists) files.add(l.file);
    for (const s of Object.values(spec.segments ?? {})) if (s.file) files.add(s.file);
    for (const ls of Object.values(spec.limbLists ?? {})) for (const l of ls) files.add(l.file);
    if (spec.attach) for (const r of [spec.attach.skeleton, spec.attach.anim]) if (r) files.add(r.file);
    if (spec.animMat) files.add(spec.animMat.file);

    // Geometry is shared between instances through the key; it only depends
    // on the scale when a list is drawn without it (a "new" op).
    const rebuilt = [spec.skelOps, ...lists.map(l => l.ops)].some(ops => ops?.[0]?.[0] === 'new');
    const key = [actorName, skeleton ? `${skeleton.file}@${skeleton.offset}` : '-',
                 spec.anim ? `${spec.anim.file}@${spec.anim.offset}` : '-', JSON.stringify(spec.skelOps ?? null),
                 JSON.stringify(spec.segments ?? null), `${spec.skelPrim ?? ''}/${spec.skelEnv ?? ''}`, JSON.stringify(spec.limbLists ?? null), JSON.stringify(spec.attach ?? null), JSON.stringify(spec.animMat ?? null),
                 lists.map(l => `${l.file}@${l.offset}${l.layer === 'xlu' ? 'x' : ''}${l.ops ? JSON.stringify(l.ops) : ''}${l.prim ?? ''}${l.env ?? ''}${l.combine ?? ''}${l.primLod ?? ''}`).join(','),
                 rebuilt ? scale.join(',') : ''].join('|');
    return { spec, skeleton, anim: spec.anim ?? null, lists, segments: spec.segments ?? {},
             limbLists: spec.limbLists ?? null, files: [...files], key, scale };
}

////////////////////////////////////////
// Geometry
////////////////////////////////////////

const modelCache = new Map(); // key -> Promise<{ textured, plain, edges, triangles } | null>

/**
 * Build (once per cache key) the geometry an actor draws in model space:
 * the textured mesh parts (geometry + materials) and the edges geometry.
 */
function buildModel(model, ctx) {
    let p = modelCache.get(model.key);
    if (p) return p;
    p = (async () => {
        const dvs = new Map();
        const load = (f) => loadFile(ctx.game, f);
        await Promise.all(model.files.map(async f => dvs.set(f, await load(f))));

        // Segment 6 is the object the skeleton or the lists live in --
        // usually the actor's own, but some actors draw from another object
        // they load themselves (Obj_Tsubo's pots from object_tsubo). A list
        // in a keep file is reached through that file's own segment (4 or
        // 5): a pot from gameplay_dangeon_keep is only ever spawned where
        // that keep is in segment 5, so its pointers resolve.
        const segments = new Array(16).fill(null);
        segments[SEG_SCENE] = ctx.sceneSegment;
        segments[SEG_KEEP] = segmentFor(dvs.get('gameplay_keep') ?? await load('gameplay_keep'), { file: 'gameplay_keep' });
        segments[SEG_SCENE_KEEP] = segmentFor(dvs.get(ctx.keepFile) ?? await load(ctx.keepFile), { file: ctx.keepFile });
        const limbRefs = Object.values(model.limbLists ?? {}).flat();
        for (const ref of [model.skeleton, model.anim, ...model.lists, ...limbRefs]) {
            if (!ref?.file || !dvs.get(ref.file)) continue;
            if (ref.vram != null) {
                segments.vram = segments.vram ?? segmentFor(dvs.get(ref.file), ref);
            } else if (fileSegment(ref.file) === SEG_SCENE_KEEP) {
                segments[SEG_SCENE_KEEP] = segmentFor(dvs.get(ref.file), ref);
            } else if (fileSegment(ref.file) === SEG_OBJECT && !segments[SEG_OBJECT]) {
                segments[SEG_OBJECT] = segmentFor(dvs.get(ref.file), ref);
            }
        }
        for (const [seg, ref] of Object.entries(model.segments)) {
            if (ref.matrices) {
                segments[Number(seg)] = { matrices: ref.matrices.map(ops => opsMatrix(ops, model.scale) ?? new THREE.Matrix4()) };
                continue;
            }
            if (ref.scroll) {
                segments[Number(seg)] = scrollSegment(ref.scroll);
                continue;
            }
            // A Gfx_PrimColor / Gfx_EnvColor list (colours 0-1).
            if (ref.colour) {
                segments[Number(seg)] = { colour: ref.colour };
                continue;
            }
            const dv = dvs.get(ref.file);
            if (dv) segments[Number(seg)] = { dv, base: ref.offset, key: `${ref.file}+${ref.offset}` };
        }
        if (!segments[SEG_OBJECT] && !segments.vram && !model.lists.length && !model.skeleton) return null;
        // MM: the AnimatedMaterial the Draw applies, for segments the spec
        // does not set itself.
        if (model.spec.animMat) {
            for (const [seg, v] of Object.entries(animMatSegments(segments, model.spec.animMat))) {
                if (!model.segments[seg]) segments[Number(seg)] = v;
            }
        }

        const lists = { opa: [], xlu: [] };
        if (model.skeleton) {
            const skel = parseSkeleton(segments, model.skeleton);
            if (skel) {
                const joints = model.anim ? animationFrame0(animSegments(segments, model.anim, dvs), model.anim, skel.limbs.length) : null;
                const posed = poseSkeleton(skel, joints, model.limbLists, opsMatrix(model.spec.skelOps, model.scale));
                if (skel.flex) segments[SEG_FLEX_MATRICES] = { matrices: posed.matrices };
                for (const { ref, ...item } of posed.items) {
                    // A limb list from another object (the Kokiri shopkeeper's
                    // head from object_masterkokirihead) runs with that object
                    // in segment 6, and can carry its own prim / env.
                    const segs = ref ? otherObjectSegments(segments, ref, dvs) : segments;
                    lists[item.layer].push({ ...item, segments: segs, prim: ref?.prim ?? model.spec.skelPrim, env: ref?.env ?? model.spec.skelEnv });
                }
                // A second skeleton drawn from one of this one's limbs (a
                // post-limb Matrix_Get the Draw re-roots it at: En_Mnk's
                // monkey on its pole). Its flex matrices get their own
                // segment 0xD, so its items carry their own segment table.
                const attach = model.spec.attach;
                const at = attach && posed.limbWorld[attach.limb - 1];
                const skel2 = at && parseSkeleton(segments, attach.skeleton);
                if (skel2) {
                    const joints2 = attach.anim ? animationFrame0(animSegments(segments, attach.anim, dvs), attach.anim, skel2.limbs.length) : null;
                    const posed2 = poseSkeleton(skel2, joints2, null, at);
                    const segs2 = segments.slice();
                    segs2.vram = segments.vram;
                    if (skel2.flex) segs2[SEG_FLEX_MATRICES] = { matrices: posed2.matrices };
                    for (const item of posed2.items) lists[item.layer].push({ ...item, segments: segs2 });
                }
            }
        }
        // A list from another object (Bg_Mori_Hineri's chest from object_box)
        // is run with that object in segment 6, as the gSPSegment before it.
        for (const l of model.lists) {
            const segs = otherObjectSegments(segments, l, dvs);
            lists[l.layer === 'xlu' ? 'xlu' : 'opa'].push({ addr: refAddress(l), matrix: opsMatrix(l.ops, model.scale), segments: segs, prim: l.prim, env: l.env, combine: l.combine, primLod: l.primLod });
        }

        const result = replayDisplayLists(lists, segments, ctx.light, ctx.caches);
        if (!result.batches.length) return null;
        const { mesh, triangleCount } = makeZeldaMesh(result.batches, ctx.caches, { selectable: true, polygonOffset: 0 });
        const geometry = mesh.geometry;
        const edges = new THREE.EdgesGeometry(geometry, 30);
        return { geometry, materials: mesh.material, edges, triangles: triangleCount, missingTextures: result.missingTextures };
    })().catch(err => { console.warn(`${model.key}: ${err.message}`); return null; });
    modelCache.set(model.key, p);
    return p;
}

////////////////////////////////////////
// Instances
////////////////////////////////////////

const MARKER_RADIUS = 15;
const markerGeometry = new THREE.OctahedronGeometry(MARKER_RADIUS, 0);

function hex(v, width = 4) {
    return '0x' + (v >>> 0).toString(16).toUpperCase().padStart(width, '0');
}

function describe(inst) {
    const rot = inst.rot.map(r => (r / 0x10000 * 360).toFixed(1)).join(', ');
    return `ACTOR ${inst.name} (${hex(inst.actorId, 3)}): pos=${inst.position.join(', ')}` +
        ` rot=${rot} (${inst.rotRaw.map(r => hex(r)).join(', ')}) params=${hex(inst.params)}` +
        ` room=${inst.room}` + (inst.model ? ` model=${inst.model.spec.object ?? inst.model.key.split('|')[1]}` : ' (no model: marker)') +
        (inst.scale.every(s => s === inst.scale[0]) ? ` scale=${inst.scale[0]}` : ` scale=${inst.scale.join(', ')}`);
}

function buildMarkerInstance(inst, material, lineMaterial) {
    const mesh = new THREE.Mesh(markerGeometry, material);
    mesh.add(makeYawLine(MARKER_RADIUS * 2.5, lineMaterial));
    mesh.rotation.set(inst.rot[0] * BINANG_TO_RAD, inst.rot[1] * BINANG_TO_RAD, inst.rot[2] * BINANG_TO_RAD, 'YXZ');
    mesh.userData.bkInfo = describe(inst);
    mesh.userData.ootActor = inst;
    return mesh;
}

// Actor_Draw's matrix: translate to world.pos with yOffset * scale.y added,
// rotate YXZ by shape.rot, scale.
function placeInstance(obj, inst) {
    obj.position.set(inst.position[0], inst.position[1] + inst.yOffset * inst.scale[1], inst.position[2]);
    obj.rotation.set(inst.rot[0] * BINANG_TO_RAD, inst.rot[1] * BINANG_TO_RAD, inst.rot[2] * BINANG_TO_RAD, 'YXZ');
    obj.scale.set(inst.scale[0], inst.scale[1], inst.scale[2]);
}

/**
 * One row for an actor type whose instances have a model: each instance is
 * a plain flat-colour mesh (shown with textures off) carrying the textured
 * mesh as a child, plus a wireframe under the row's edges group.
 */
function addModelRow(scene, groupBody, rowName, instances, built) {
    const material = new THREE.MeshLambertMaterial({ color: ACTOR_COLOR, side: THREE.DoubleSide, flatShading: true });
    material.polygonOffset = true;
    material.polygonOffsetFactor = 1;
    material.polygonOffsetUnits = 1;
    const edgeMaterial = new THREE.LineBasicMaterial({ color: 0x8a3d10, transparent: true, opacity: 0.8 });

    const typeGroup = new THREE.Group();
    typeGroup.name = rowName;
    const edgesGroup = new THREE.Group();
    edgesGroup.name = rowName + ' edges';

    let first = null;
    for (const inst of instances) {
        const b = built.get(inst.model.key);
        const mesh = new THREE.Mesh(b.geometry, material);
        placeInstance(mesh, inst);
        mesh.userData.bkInfo = describe(inst);
        mesh.userData.ootActor = inst;
        typeGroup.add(mesh);

        const edges = new THREE.LineSegments(b.edges, edgeMaterial);
        edges.position.copy(mesh.position);
        edges.rotation.copy(mesh.rotation);
        edges.scale.copy(mesh.scale);
        edgesGroup.add(edges);

        const textured = new THREE.Mesh(b.geometry, b.materials);
        textured.name = 'textured';
        textured.userData.textured = true;
        attachTextured(mesh, textured, edges);
        first = first ?? mesh;
    }

    scene.add(typeGroup);
    scene.add(edgesGroup);
    loadedModels.push({ name: rowName, root: typeGroup, mesh: typeGroup, edges: edgesGroup });
    addModelCheckbox(scene, rowName, typeGroup, edgesGroup, false, true, ACTOR_COLOR, false, first, groupBody);
    edgesGroup.visible = typeGroup.visible && wireframeCheckbox.checked;
}

////////////////////////////////////////
// Scene entry point
////////////////////////////////////////

/**
 * Draw every actor of the selected setup of an OoT or MM scene.
 * sceneBuffer: the scene file; sceneName: its file name (keys the actor JSON).
 */
export async function renderOOTActors(scene, sceneBuffer, sceneName, game = 'OOT') {
    const actorModels = GAMES[game]?.models();
    const overrides = GAMES[game]?.overrides() ?? {};
    if (!actorModels || !areaActors) return;
    const setupID = Number(document.getElementById('setupDropdown')?.value ?? 0);
    const setup = areaActors[setupID];
    if (!setup) return;

    clearTexturedPairs();
    for (const key of [GROUP_MODELS, GROUP_MARKERS]) resetGroupModelState(key);

    const sceneDv = new DataView(sceneBuffer);
    const keepFile = sceneKeepObject(sceneDv) === OBJECT_GAMEPLAY_DANGEON_KEEP ? 'gameplay_dangeon_keep' : 'gameplay_field_keep';
    const collision = sceneCollision(sceneDv);
    const ctx = {
        game,
        sceneSegment: { dv: sceneDv, base: 0, key: sceneName },
        keepFile,
        light: parseZeldaSceneInfo(sceneBuffer).light,
        caches: { textures: new Map(), dataTextures: new Map() },
    };
    modelCache.clear();

    // ---- decode every spawn
    const instances = [];
    const addInstance = (entry, first, roomIndex) => {
        const base = actorModels[first.actorId] ?? null;
        const name = base?.name ?? `Actor ${hex(first.actorId, 3)}`;
        const override = overrides[name] ?? null;
        const spawns = override?.spawns ? override.spawns({ ...first, position: entry.position }) : [{ ...first, position: entry.position }];
        for (const spawn of spawns) addSpawn(spawn, base, name, override, roomIndex);
    };
    const addSpawn = (spawn, base, name, override, roomIndex) => {
        // The shape.rot the actor's Init leaves (MM: MM_ACTOR_INIT_SHAPE_ROT in
        // render_actors.js, shared with the DynaPoly rows -- rot fields that
        // carry switch flags are zeroed, Bg_Dblue_Movebg's by type), then
        // this file's own rot override.
        const initRot = actorShapeRot(name, spawn, game, sceneName);
        const rot = override?.rot ? override.rot(initRot, spawn.params) : initRot;
        const scale = scaleOf(base, override, spawn.params, sceneName, spawn.rot);
        const model = base ? modelSpec(name, base, override, spawn.params, sceneName, scale, spawn.rot, keepFile, roomIndex) : null;
        const inst = {
            actorId: spawn.actorId, name, params: spawn.params, room: roomIndex,
            position: spawn.position, rot, rotRaw: spawn.rotRaw,
            scale,
            yOffset: (typeof override?.yOffset === 'function' ? override.yOffset(spawn.params) : override?.yOffset) ?? base?.yOffset ?? 0,
            model,
        };
        if (override?.place) Object.assign(inst, override.place(inst, collision));
        instances.push(inst);
    };
    setup.rooms.forEach((room, roomIndex) => {
        for (const entry of room.actors) addInstance(entry, decodeActorSpawnEntry(entry, game), roomIndex);
    });
    // Doors and other transition actors: the scene's own list.
    for (const t of transitionActors(sceneDv, setupID, game)) {
        addInstance({ position: t.position }, {
            actorId: t.id & 0x1FFF, params: t.params, rot: [0, t.rotY, 0], rotRaw: [0, t.rotY & 0xFFFF, 0],
        }, t.frontRoom);
    }

    // ---- build every distinct model up front, so rows come out in name order
    const built = new Map();
    const models = new Map();
    for (const inst of instances) if (inst.model && !models.has(inst.model.key)) models.set(inst.model.key, inst.model);
    await Promise.all([...models.values()].map(async m => {
        const b = await buildModel(m, ctx);
        if (b) built.set(m.key, b);
    }));
    for (const inst of instances) if (inst.model && !built.has(inst.model.key)) inst.model = null;

    const rowLabel = (name, list) => list.length > 1 ? `${name} (x${list.length})` : name;
    const byType = [...groupBy(instances, i => i.name)].sort((a, b) => a[0].localeCompare(b[0]));

    let modelRows = 0, markerRows = 0, triangles = 0, missing = 0;
    for (const [name, list] of byType) {
        // An actor type can have both modelled and marker instances (a variant
        // this cannot draw); they are split between the two groups.
        const withModel = list.filter(i => i.model);
        const markers = list.filter(i => !i.model);
        if (withModel.length) {
            const group = getModelGroup(GROUP_MODELS, 'Actors');
            addModelRow(scene, group.body, rowLabel(name, withModel), withModel, built);
            modelRows++;
            for (const key of new Set(withModel.map(i => i.model.key))) {
                triangles += built.get(key).triangles * withModel.filter(i => i.model.key === key).length;
                missing += built.get(key).missingTextures;
            }
        }
        if (markers.length) {
            const group = getModelGroup(GROUP_MARKERS, 'Actors (no model)');
            addTypeRow(scene, group.body, rowLabel(name, markers), markers, ACTOR_COLOR, true, buildMarkerInstance);
            markerRows++;
        }
    }
    for (const key of [GROUP_MODELS, GROUP_MARKERS]) applyGroupMasterState(key);

    console.log(`${sceneName} setup ${setupID}: ${instances.length} actors, ${modelRows} modelled types (${triangles} triangles),` +
                ` ${markerRows} marker types` + (missing ? `, ${missing} texture loads from unmapped segments` : ''));
}
