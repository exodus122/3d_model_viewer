////////////////////////////////////////
// Majora's Mask actor overrides
////////////////////////////////////////
//
// Hand fixes on top of the mined MM_Actor_Models (js/mm_object_list.js) for
// js/oot_actors.js, which draws both games' actors: see OOT_ACTOR_OVERRIDES
// there for what an entry can set. Keyed by actor name.

const dl = (file, offset, layer = 'opa') => ({ file, offset, layer });
const keep = (offset, layer = 'opa') => dl('gameplay_keep', offset, layer);
const keepTex = (offset) => ({ file: 'gameplay_keep', offset });

// z_actor.c Actor_DrawDoorLock(frame 10, type) under the ops before it: from
// (0, yShift, 500), four chain lists turned about z (chainRotZ stepping by
// pi - 2 * chainAngle, then 2 * chainAngle), and the lock at scale 1.
// sDoorLocksInfo: DOORLOCK_NORMAL (gameplay_dangeon_keep's chain and lock)
// and DOORLOCK_BOSS (object_bdoor's).
const DOOR_LOCKS = {
    normal: { angle: 0.54, yShift: 5000, chain: dl('gameplay_dangeon_keep', 0x230), lock: dl('gameplay_dangeon_keep', 0x140) },
    boss: { angle: 0.644, yShift: 8000, chain: dl('object_bdoor', 0x530), lock: dl('object_bdoor', 0x400) },
};
function doorLockLists(kind = 'normal', pre = []) {
    const { angle, yShift, chain, lock } = DOOR_LOCKS[kind];
    const base = ['t', 0, yShift, 500];
    const lists = [];
    let rz = 0;
    for (let i = 0; i < 4; i++) {
        lists.push({ ...chain, ops: [...pre, base, ['rz', rz]] });
        rz += i % 2 ? 2 * angle : Math.PI - 2 * angle;
    }
    lists.push({ ...lock, ops: [...pre, base] });
    return lists;
}

// z_door_shutter.c: D_808A21B0 by shutter index, [door, bars, bars z].
const SHUTTER_GFX = [
    [dl('object_bdoor', 0xC0), null, 12],
    [keep(0x77990), keep(0x78A80), 12],
    [dl('object_numa_obj', 0x7150), keep(0x78A80), 12],
    [dl('object_hakugin_obj', 0x128), keep(0x78A80), 12],
    [dl('object_dblue_object', 0x17D00), keep(0x78A80), 12],
    [dl('object_ikana_obj', 0x14A40), keep(0x78A80), 12],
    [dl('object_redead_obj', 0x1A0), keep(0x78A80), 12],
    [dl('object_ikninside_obj', 0x4440), dl('object_ikninside_obj', 0x5260), 0],
    [dl('object_random_obj', 0x190), keep(0x78A80), 12],
    [dl('object_kinsta1_obj', 0x198), keep(0x78A80), 12],
    [dl('object_kaizoku_obj', 0x1A0), keep(0x78A80), 12],
    [dl('object_last_obj', 0x39C0), keep(0x78A80), 12],
];
// D_808A2258 (scene -> D_808A2180 entry, whose index is the shutter's).
const SHUTTER_OBJECT_INDEX = [0, 1, 2, 3, 4, 5, 6, 7, 11, 8, 9, 10];
const SHUTTER_BY_SCENE = {
    Z2_MITURIN: 2, Z2_HAKUGIN: 3, Z2_SEA: 4, Z2_INISIE_N: 5, Z2_INISIE_R: 5, Z2_REDEAD: 6, Z2_IKNINSIDE: 7,
    Z2_CASTLE: 7, Z2_RANDOM: 9, Z2_KINSTA1: 10, Z2_KAIZOKU: 11, Z2_PIRATE: 11, Z2_TORIDE: 11,
    Z2_LAST_DEKU: 8, Z2_LAST_GORON: 8, Z2_LAST_ZORA: 8, Z2_LAST_LINK: 8,
};
// D_808A22A0 -> D_808A22DC: the boss door's texture (object_bdoor).
const BOSS_DOOR_TEX = {
    Z2_MITURIN: 0x5BA0, Z2_MITURIN_BS: 0x5BA0, Z2_HAKUGIN: 0x5C0, Z2_HAKUGIN_BS: 0x5C0,
    Z2_SEA: 0x4BA0, Z2_SEA_BS: 0x4BA0, Z2_INISIE_N: 0x3BA0, Z2_INISIE_R: 0x3BA0, Z2_INISIE_BS: 0x3BA0,
};

function doorShutterModel(params, sceneName) {
    const type = (params >> 7) & 7;
    const objectIndex = type === 5 ? 0 : (SHUTTER_BY_SCENE[sceneName] ?? 1);
    const [door, bars, barsZ] = SHUTTER_GFX[SHUTTER_OBJECT_INDEX[objectIndex]];
    const lists = [door];
    // DoorShutter_SetupDoor: types 1 (room not clear), 2 and 7 (switch not
    // set) rest barred, the bars barsZ in front.
    if (bars && [1, 2, 7].includes(type)) lists.push({ ...bars, ops: [['t', 0, 0, barsZ]] });
    // Init: types 4 and 5 (boss) are locked until their switch is set;
    // Draw scales the lock by (0.01, 0.01, 0.025) first.
    if (type === 4 || type === 5) lists.push(...doorLockLists(type === 5 ? 'boss' : 'normal', [['s', 0.01, 0.01, 0.025]]));
    const segments = type === 5 ? { 8: { file: 'object_bdoor', offset: BOSS_DOOR_TEX[sceneName] ?? 0x6BA0 } } : {};
    return { object: door.file, lists, segments };
}

// z_en_door.c sDoorDLists by EnDoorDListIndex: [file, left, right].
const DOOR_DEFAULT = ['gameplay_keep', 0x20BB8, 0x20D00];
const DOOR_FIELD_KEEP = ['gameplay_field_keep', 0x4050, 0x4228];
const DOOR_WOODFALL = ['object_numa_obj', 0x5DF0, 0x5DF0];
const DOOR_OBSERVATORY_LAB = ['object_dor01', 0x448, 0x448];
const DOOR_ZORA_HALL = ['object_dor02', 0x428, 0x428];
const DOOR_SWAMP = ['object_dor03', 0x3C0, 0x3C0];
const DOOR_MAGIC_HAG = ['object_dor04', 0x468, 0x468];
const DOOR_LOTTERY = ['object_wdor01', 0x548, 0x548];
const DOOR_POST_OFFICE = ['object_wdor02', 0x548, 0x548];
const DOOR_INN_SCHOOL = ['object_wdor03', 0x548, 0x548];
const DOOR_MILK_BAR = ['object_wdor04', 0x508, 0x508];
const DOOR_MUSIC_BOX = ['object_wdor05', 0x508, 0x508];
const DOOR_PIRATES = ['object_kaizoku_obj', 0x9F20, 0x9F20];
const DOOR_SPIDER_HOUSE = ['object_kinsta2_obj', 0x310, 0x310];

// sObjectInfo's DOOR_OBJKIND_DEFAULT entries, by scene.
const DOOR_BY_SCENE = {
    Z2_MITURIN: DOOR_WOODFALL,
    Z2_TENMON_DAI: DOOR_OBSERVATORY_LAB, Z2_00KEIKOKU: DOOR_OBSERVATORY_LAB, Z2_30GYOSON: DOOR_OBSERVATORY_LAB, Z2_LABO: DOOR_OBSERVATORY_LAB,
    Z2_33ZORACITY: DOOR_ZORA_HALL, Z2_BANDROOM: DOOR_ZORA_HALL,
    Z2_20SICHITAI: DOOR_SWAMP, Z2_20SICHITAI2: DOOR_SWAMP, Z2_MAP_SHOP: DOOR_SWAMP,
    Z2_KAIZOKU: DOOR_PIRATES, Z2_PIRATE: DOOR_PIRATES, Z2_TORIDE: DOOR_PIRATES,
    Z2_KINDAN2: DOOR_SPIDER_HOUSE,
};

// sObjectInfo's DOOR_OBJKIND_SCHEDULE entries, by ENDOOR_TYPE_SCHEDULE's
// schType (null: gameplay_keep's door, or field keep's where it is loaded).
const K = null, F = DOOR_FIELD_KEEP;
const DOOR_BY_SCHEDULE = [
    DOOR_INN_SCHOOL, DOOR_POST_OFFICE, DOOR_LOTTERY, DOOR_POST_OFFICE, DOOR_LOTTERY,
    K, K, K, K, K,
    DOOR_MILK_BAR, DOOR_INN_SCHOOL, DOOR_INN_SCHOOL, F, F, F, F,
    DOOR_LOTTERY, K, K, K, K, F, F, F, F, K,
    DOOR_MUSIC_BOX, F, DOOR_MAGIC_HAG, DOOR_MILK_BAR, DOOR_SWAMP,
];

// z_en_item00.c (src/code) per ITEM00_ type (params & 0xFF; bit 15 marks a
// drop, bits 8-14 the collectible flag): EnItem00_Init's scale and the
// shadow offset it gives ActorShape_Init (the yOffset), and the lists of the
// draw function EnItem00_Draw dispatches to. Rupees are gRupeeDL with
// sRupeeTextures[type, or type - 0x10 for huge / purple] in segment 8, the
// ammo / nuts / sticks / magic / key drops gItemDropDL with
// sItemDropTextures[] (EnItem00_DrawSprite's index), a placed recovery heart
// GetItem_Draw's gGiRecoveryHeartDL under Matrix_Scale(16), the heart
// container object_gi_hearts' lists under Matrix_Scale(20), the heart piece
// gHeartPieceInteriorDL. The shield, map and compass have no model here.
const RUPEE_TEX = [0x61FC0, 0x61FE0, 0x62000, 0x62040, 0x62020]; // green, blue, red, orange, purple
const DROP_TEX = [0x5E6F0, 0x5CEF0, 0x5BEF0, 0x5B6F0, 0x5C6F0, 0x5CEF0, 0x607C0, 0x60FC0, 0x617C0, 0x5FFC0, null, 0x5F7C0];
const rupee = (tex, scale) => ({ scale, yOffset: 750, model: { object: 'gameplay_keep', lists: [keep(0x622C0)], segments: { 8: keepTex(RUPEE_TEX[tex]) } } });
const drop = (tex, scale, yOffset) => ({ scale, yOffset, model: { object: 'gameplay_keep', lists: [keep(0x5F6F0)], segments: { 8: keepTex(DROP_TEX[tex]) } } });
const ITEM00_TYPES = {
    0x00: rupee(0, 0.015), 0x01: rupee(1, 0.015), 0x02: rupee(2, 0.015), 0x13: rupee(3, 0.045), 0x14: rupee(4, 0.03),
    0x03: { scale: 0.32, yOffset: 430, model: { object: 'object_gi_heart', lists: [dl('object_gi_heart', 0xE0, 'xlu')] } },
    0x04: drop(1, 0.03, 320), 0x05: drop(2, 0.035, 250), 0x08: drop(3, 0.035, 250), 0x09: drop(4, 0.035, 250),
    0x0A: drop(4, 0.035, 250), 0x0B: drop(5, 0.03, 320), 0x0C: drop(6, 0.03, 320), 0x0D: drop(7, 0.03, 320),
    0x0E: drop(8, 0.045, 320), 0x0F: drop(9, 0.03, 320), 0x11: drop(11, 0.03, 350), 0x17: drop(6, 0.03, 320),
    0x19: drop(1, 0.03, 320),
    0x06: { scale: 0.02, yOffset: 650, model: { object: 'gameplay_keep', lists: [keep(0x5AAB0, 'xlu')] } },
    0x07: { scale: 0.4, yOffset: 650, model: { object: 'object_gi_hearts', lists: [dl('object_gi_hearts', 0x1290, 'xlu'), dl('object_gi_hearts', 0x1470, 'xlu')] } },
    0x12: { scale: 0.01, yOffset: 500 }, 0x1A: { scale: 0.01, yOffset: 500 },
    0x16: { scale: 0.5 }, 0x1B: { scale: 0.5 }, 0x1C: { scale: 0.5 },
};

const MM_SMALL_CHESTS = [5, 6, 7, 8, 12];

// z_door_spiral.c sSpiralInfoTable dLists, by scene.
const SPIRAL_DANGEON_KEEP = [dl('gameplay_dangeon_keep', 0x219E0), dl('gameplay_dangeon_keep', 0x1D980)];
const SPIRAL_IKNINSIDE = [dl('object_ikninside_obj', 0xEA0), dl('object_ikninside_obj', 0x590)];
const SPIRAL_BY_SCENE = {
    Z2_MITURIN: [dl('object_numa_obj', 0x4448), dl('object_numa_obj', 0x7A8)],
    Z2_HAKUGIN: [dl('object_hakugin_obj', 0x9278), dl('object_hakugin_obj', 0x6128)],
    Z2_INISIE_N: [dl('object_ikana_obj', 0x13EA8), dl('object_ikana_obj', 0x12B70)],
    Z2_INISIE_R: [dl('object_ikana_obj', 0x13EA8), dl('object_ikana_obj', 0x12B70)],
    Z2_DANPEI2TEST: [dl('object_danpei_object', 0x2110), dl('object_danpei_object', 0x12C0)],
    Z2_IKNINSIDE: SPIRAL_IKNINSIDE, Z2_CASTLE: SPIRAL_IKNINSIDE,
};

export const MM_ACTOR_OVERRIDES = {
    // z_en_item00.c: see ITEM00_TYPES.
    "En_Item00": {
        scale: (params) => ITEM00_TYPES[params & 0xFF]?.scale ?? 0.01,
        yOffset: (params) => ITEM00_TYPES[params & 0xFF]?.yOffset ?? 980,
        model: (params) => ITEM00_TYPES[params & 0xFF]?.model ?? null,
    },

    // z_en_a_keep.c (src/code): Init turns params into (params & 0xFF) - 9,
    // the AOBJ_ type (signpost oblong / arrow) that indexes sDLists.
    "En_A_Obj": {
        model: (params) => {
            const list = [0x5AED0, 0x5B430][(params & 0xFF) - 9];
            return list != null ? { object: 'gameplay_keep', lists: [keep(list)] } : null;
        },
    },

    // z_en_box.c: type = params >> 12, item = (params >> 5) & 0x7F. The small
    // chests (Actor_IsSmallChest: 5, 6, 7, 8, 12) are 0.0075, the rest 0.01.
    // EnBox_PostLimbDraw adds the base (limb 1) and lid (limb 3): ornate for
    // the boss-key chest (2), gilded for a small chest holding a small key
    // (GI_KEY_SMALL) and for every other big chest, else the plain wood.
    "En_Box": {
        scale: (params) => (MM_SMALL_CHESTS.includes((params >> 12) & 0xF) ? 0.0075 : 0.01),
        model: (params, sceneName, base) => {
            const type = (params >> 12) & 0xF;
            const [baseDL, lidDL] = type === 2 ? [0xDB0, 0x1D58]
                : !MM_SMALL_CHESTS.includes(type) || ((params >> 5) & 0x7F) === 0x3C ? [0xA50, 0x1850]
                : [0x6F0, 0x12E8];
            const box = (offset) => ({ ...dl('object_box', offset), add: true });
            return { ...base, limbLists: { 1: [box(baseDL)], 3: [box(lidDL)] } };
        },
    },

    // z_door_shutter.c: see doorShutterModel. Scale 1 (the init chain).
    "Door_Shutter": { scale: 1, model: (params, sceneName) => doorShutterModel(params, sceneName) },

    // z_obj_bombiwa.c: Init installs D_8093A998[(params >> 8) & 1]'s draw --
    // func_8093A418's grey boulder (object_bombiwa_DL_0009E0) or
    // func_8093A608's (DL_004560 with prim LOD 0x9B, then the XLU
    // DL_004688) -- and raises world.pos 20 over home (yOffset -200 at 0.1
    // puts the model back on the ground).
    "Obj_Bombiwa": {
        model: (params) => ({
            object: 'object_bombiwa',
            lists: ((params >> 8) & 1)
                ? [{ ...dl('object_bombiwa', 0x4560), prim: [255, 255, 255, 255], primLod: 0x9B }, dl('object_bombiwa', 0x4688, 'xlu')]
                : [dl('object_bombiwa', 0x9E0)],
        }),
        place: (inst) => ({ position: [inst.position[0], inst.position[1] + 20, inst.position[2]] }),
    },

    // z_door_spiral.c: the staircase is sSpiralInfoTable[index].dLists[
    // (params >> 7) & 1] (up / down), index from the scene
    // (sSpiralSceneInfoTable -> sSpiralObjectInfoTable), else
    // gameplay_dangeon_keep's where that keep is loaded, else nothing.
    "Door_Spiral": {
        scale: 1,
        model: (params, sceneName, base, rot, keepFile) => {
            const lists = SPIRAL_BY_SCENE[sceneName] ?? (keepFile === 'gameplay_dangeon_keep' ? SPIRAL_DANGEON_KEEP : null);
            return lists ? { object: lists[0].file, lists: [lists[(params >> 7) & 1]] } : null;
        },
    },

    // z_en_bombf.c EnBombf_Draw for a placed flower (params != ENBOMBF_0):
    // the leaves, then the bomb 1000 up at unk_204 (1 until picked), prim
    // (200, 255, 200) env (0, 20, 10). Segment 8 is a billboarded spark
    // matrix list the Draw builds, left unmapped.
    "En_Bombf": {
        model: (params) => ((params << 16 >> 16) === 0 ? null : {
            object: 'object_bombf',
            lists: [dl('object_bombf', 0x340), dl('object_bombf', 0x530),
                    { ...dl('object_bombf', 0x408), ops: [['t', 0, 1000, 0]], prim: [200, 255, 200, 255], env: [0, 20, 10, 0] }],
        }),
    },

    // z_en_bigslime.c: the profile's draw (EnBigslime_DrawGekko) is only the
    // Gekko skeleton, under its own matrix at gekkoScale 0.007 (the actor's
    // 0.15 / 0.075 is the jelly's, drawn from vertices the overlay animates,
    // once the fight starts); the minislimes are actors of their own. Init
    // puts it on the floor of Great Bay Temple's room 5 (GBT_ROOM_5_MIN_Y)
    // facing 0.
    "En_Bigslime": {
        scale: 0.007,
        model: (params, sceneName, base) => ({ ...base, lists: [] }),
        rot: () => [0, 0, 0],
        place: (inst) => ({ position: [inst.position[0], -690, inst.position[2]] }),
    },

    // z_obj_taru.c: params & 0x80 is the breakable pirate panel
    // (gObjTaruBreakablePiratePanelDL; x scaled 0.2 with params & 0x100),
    // else the barrel (gObjTaruBarrelDL). Both 0.1 from the init chain.
    "Obj_Taru": {
        scale: (params) => ((params & 0x80) && (params & 0x100) ? [0.2, 0.1, 0.1] : 0.1),
        model: (params) => ({ object: 'object_taru', lists: [dl('object_taru', (params & 0x80) ? 0x1140 : 0x420)] }),
    },

    // z_dm_char08.c: the Great Turtle draws its skeleton only once awake
    // (unk_1FF 2, which Init sets in Great Bay Temple); asleep at Zora Cape
    // it is gTurtleAsleepDL alone.
    "Dm_Char08": {
        model: (params, sceneName, base) => (sceneName === 'Z2_SEA'
            ? { ...base, lists: [] }
            : { ...base, skeleton: null, anim: null, lists: [dl('object_kamejima', 0x4E70)] }),
    },

    // Room-transition planes and other invisible helpers.
    "En_Holl": { marker: true },

    // z_en_door.c: as OoT's -- EnDoor_OverrideLimbDraw gives limb 4 the
    // scene's (or, for a schedule door, the schedule type's) door list, left
    // or right by the side the camera is on (both drawn here; most MM doors
    // use one list for both). The list Draw adds at the actor matrix is only
    // for a door swung open. Type ((params >> 7) & 7) 1 is locked: the
    // chains and lock. Type 7 (unused) is a framed door: gameplay_keep's
    // frame list first.
    "En_Door": {
        model: (params, sceneName, base, rot, keepFile) => {
            const type = (params >> 7) & 7;
            const keepDoor = keepFile === 'gameplay_field_keep' ? DOOR_FIELD_KEEP : DOOR_DEFAULT;
            const [file, left, right] = (type === 5 ? DOOR_BY_SCHEDULE[params & 0x7F] : DOOR_BY_SCENE[sceneName]) ?? keepDoor;
            const lists = type === 1 ? doorLockLists() : type === 7 && (params & 0x7F) === 0 ? [dl('gameplay_keep', 0x221B8)] : [];
            const offsets = left === right ? [left] : [left, right];
            return { ...base, lists, limbLists: { 4: offsets.map(offset => dl(file, offset)) } };
        },
    },
};
