import * as THREE from 'three';
import { addModelCheckbox, getModelGroup, resetGroupModelState, applyGroupMasterState } from './render.js';
import { replayDisplayLists, makeZeldaMesh, parseZeldaSceneInfo, scrollSegment, SEG_FLEX_MATRICES } from './zelda_textured.js';
import { attachTextured, clearTexturedPairs } from './bk_textured.js';
import { addTypeRow, makeYawLine, groupBy, ACTOR_COLOR } from './bk_setup.js';
import { decodeActorSpawnEntry } from './render_actors.js';

////////////////////////////////////////
// System: Ocarina of Time actors (every spawn in the scene's actor lists)
////////////////////////////////////////
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

const wireframeCheckbox = document.getElementById('wireframe');

////////////////////////////////////////
// Hand overrides
////////////////////////////////////////
//
// Keyed by actor name. Each entry can set: scale (number, [x, y, z] or a
// function of (params, sceneName)), yOffset (number or a function of params), model (a
// function of (params, sceneName, minedSpec, spawnRot) returning a model spec to use
// instead of the mined one, or null for a marker), rot (a function of
// (rot, params) returning the shape.rot the actor's Init sets), place (a
// function of (instance, sceneCollision) returning { position?, rot? } for
// an Init that moves the actor against the scene's collision), and
// marker: true to force the marker.
//
// A model spec is { object, skeleton?, anim?, lists?, segments?, limbLists? }
// as generated, with limbLists: { limbIndex: [list refs] } for lists a limb
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

    // Environment effect actors: nothing placeable to draw. En_Light is a
    // torch flame (gEffFire1DL, or an unused candle list for negative
    // params, which the mining picks up instead).
    "Object_Kankyo": { marker: true },
    "Demo_Kankyo": { marker: true },
    "En_Light": { marker: true },
};

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

const fileCache = new Map(); // file name -> Promise<DataView | null>

function loadFile(name) {
    let p = fileCache.get(name);
    if (!p) {
        const dir = name.startsWith('ovl_') ? 'overlays' : 'objects';
        p = fetch(`./models/OOT/actors/${dir}/${name}`)
            .then(res => res.ok ? res.arrayBuffer().then(b => new DataView(b)) : null)
            .catch(() => null);
        fileCache.set(name, p);
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

/** The setup's transition actors (TransitionActorEntry, 0x10 bytes each). */
function transitionActors(sceneDv, setupID) {
    const cmd = sceneCommand(sceneDv, sceneHeaderOffset(sceneDv, setupID), CMD_TRANSITION_ACTOR_LIST)
        ?? sceneCommand(sceneDv, 0, CMD_TRANSITION_ACTOR_LIST);
    const out = [];
    if (!cmd) return out;
    for (let i = 0; i < cmd.count; i++) {
        const o = cmd.addr + i * 0x10;
        if (o + 0x10 > sceneDv.byteLength) break;
        out.push({
            frontRoom: sceneDv.getInt8(o), backRoom: sceneDv.getInt8(o + 2),
            id: sceneDv.getInt16(o + 4, false),
            position: [sceneDv.getInt16(o + 6, false), sceneDv.getInt16(o + 8, false), sceneDv.getInt16(o + 10, false)],
            rotY: sceneDv.getInt16(o + 12, false), params: sceneDv.getUint16(o + 14, false),
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
    const dv = segments[SEG_OBJECT]?.dv;
    if (!dv) return null;
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

        // limbLists is keyed by the callback's limbIndex, which counts from 1.
        const lists = limbLists?.[index + 1] ?? [];
        const replaced = lists.filter(l => !l.add);
        if (replaced.length) {
            for (const ref of replaced) items.push({ addr: refAddress(ref), matrix: world, layer: ref.layer ?? 'opa' });
        } else if (limb.dl) {
            items.push({ addr: limb.dl, matrix: world, layer: 'opa' });
        }
        if (replaced.length || limb.dl) matrices.push(world);
        for (const ref of lists.filter(l => l.add)) {
            const ops = opsMatrix(ref.ops, [1, 1, 1]);
            items.push({ addr: refAddress(ref), matrix: ops ? world.clone().multiply(ops) : world, layer: ref.layer ?? 'opa' });
        }
        if (limb.child !== LIMB_DONE) visit(limb.child, world, false);
        if (!isRoot && limb.sibling !== LIMB_DONE) visit(limb.sibling, parent, false);
    };
    visit(0, null, true);
    return { items, matrices };
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

function scaleOf(spec, override, params, sceneName) {
    let s = override?.scale ?? spec?.scale ?? DEFAULT_SCALE;
    if (typeof s === 'function') s = s(params, sceneName);
    return Array.isArray(s) ? s : [s, s, s];
}

/**
 * Everything needed to draw an actor at these params: the object file
 * set, the posed lists and a cache key. Null when the actor has no model.
 */
function modelSpec(actorName, base, override, params, sceneName, scale, rot) {
    if (override?.marker) return null;
    let spec = base;
    if (override?.model) spec = override.model(params, sceneName, base, rot);
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

    // Geometry is shared between instances through the key; it only depends
    // on the scale when a list is drawn without it (a "new" op).
    const rebuilt = [spec.skelOps, ...lists.map(l => l.ops)].some(ops => ops?.[0]?.[0] === 'new');
    const key = [actorName, skeleton ? `${skeleton.file}@${skeleton.offset}` : '-',
                 spec.anim ? spec.anim.offset : '-', JSON.stringify(spec.skelOps ?? null), JSON.stringify(spec.limbLists ?? null),
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
        await Promise.all(model.files.map(async f => dvs.set(f, await loadFile(f))));

        // Segment 6 is the object the skeleton or the lists live in --
        // usually the actor's own, but some actors draw from another object
        // they load themselves (Obj_Tsubo's pots from object_tsubo). A list
        // in a keep file is reached through that file's own segment (4 or
        // 5): a pot from gameplay_dangeon_keep is only ever spawned where
        // that keep is in segment 5, so its pointers resolve.
        const segments = new Array(16).fill(null);
        segments[SEG_SCENE] = ctx.sceneSegment;
        segments[SEG_KEEP] = segmentFor(dvs.get('gameplay_keep') ?? await loadFile('gameplay_keep'), { file: 'gameplay_keep' });
        segments[SEG_SCENE_KEEP] = segmentFor(dvs.get(ctx.keepFile) ?? await loadFile(ctx.keepFile), { file: ctx.keepFile });
        for (const ref of [model.skeleton, model.anim, ...model.lists]) {
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
            const dv = dvs.get(ref.file);
            if (dv) segments[Number(seg)] = { dv, base: ref.offset, key: `${ref.file}+${ref.offset}` };
        }
        if (!segments[SEG_OBJECT] && !segments.vram && !model.lists.length) return null;

        const lists = { opa: [], xlu: [] };
        if (model.skeleton) {
            const skel = parseSkeleton(segments, model.skeleton);
            if (skel) {
                const joints = model.anim ? animationFrame0(segments, model.anim, skel.limbs.length) : null;
                const posed = poseSkeleton(skel, joints, model.limbLists, opsMatrix(model.spec.skelOps, model.scale));
                if (skel.flex) segments[SEG_FLEX_MATRICES] = { matrices: posed.matrices };
                for (const item of posed.items) {
                    lists[item.layer].push({ ...item, prim: model.spec.skelPrim, env: model.spec.skelEnv });
                }
            }
        }
        // A list from another object (Bg_Mori_Hineri's chest from object_box)
        // is run with that object in segment 6, as the gSPSegment before it.
        for (const l of model.lists) {
            let segs = segments;
            if (fileSegment(l.file) === SEG_OBJECT && l.vram == null && dvs.get(l.file) && segments[SEG_OBJECT]?.key !== l.file) {
                segs = segments.slice();
                segs.vram = segments.vram;
                segs[SEG_OBJECT] = segmentFor(dvs.get(l.file), l);
            }
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
 * Draw every actor of the selected setup of an OoT scene.
 * sceneBuffer: the scene file; sceneName: its file name (keys the actor JSON).
 */
export async function renderOOTActors(scene, sceneBuffer, sceneName) {
    if (typeof OOT_Actor_Models === 'undefined' || !areaActors) return;
    const setupID = Number(document.getElementById('setupDropdown')?.value ?? 0);
    const setup = areaActors[setupID];
    if (!setup) return;

    clearTexturedPairs();
    for (const key of [GROUP_MODELS, GROUP_MARKERS]) resetGroupModelState(key);

    const sceneDv = new DataView(sceneBuffer);
    const keepFile = sceneKeepObject(sceneDv) === OBJECT_GAMEPLAY_DANGEON_KEEP ? 'gameplay_dangeon_keep' : 'gameplay_field_keep';
    const collision = sceneCollision(sceneDv);
    const ctx = {
        sceneSegment: { dv: sceneDv, base: 0, key: sceneName },
        keepFile,
        light: parseZeldaSceneInfo(sceneBuffer).light,
        caches: { textures: new Map(), dataTextures: new Map() },
    };
    modelCache.clear();

    // ---- decode every spawn
    const instances = [];
    const addInstance = (entry, spawn, roomIndex) => {
        const base = OOT_Actor_Models[spawn.actorId] ?? null;
        const name = base?.name ?? `Actor ${hex(spawn.actorId, 3)}`;
        const override = OOT_ACTOR_OVERRIDES[name] ?? null;
        const rot = override?.rot ? override.rot(spawn.rot, spawn.params) : spawn.rot;
        const scale = scaleOf(base, override, spawn.params, sceneName);
        const model = base ? modelSpec(name, base, override, spawn.params, sceneName, scale, spawn.rot) : null;
        const inst = {
            actorId: spawn.actorId, name, params: spawn.params, room: roomIndex,
            position: entry.position, rot, rotRaw: spawn.rotRaw,
            scale,
            yOffset: (typeof override?.yOffset === 'function' ? override.yOffset(spawn.params) : override?.yOffset) ?? base?.yOffset ?? 0,
            model,
        };
        if (override?.place) Object.assign(inst, override.place(inst, collision));
        instances.push(inst);
    };
    setup.rooms.forEach((room, roomIndex) => {
        for (const entry of room.actors) addInstance(entry, decodeActorSpawnEntry(entry, 'OOT'), roomIndex);
    });
    // Doors and other transition actors: the scene's own list, spawned with
    // rot (0, rotY, 0) and the entry's index in params bits 10-15.
    transitionActors(sceneDv, setupID).forEach((t, i) => {
        const params = ((i << 10) + t.params) & 0xFFFF;
        addInstance({ position: t.position }, {
            actorId: t.id & 0x1FFF, params, rot: [0, t.rotY, 0], rotRaw: [0, t.rotY & 0xFFFF, 0],
        }, t.frontRoom);
    });

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
