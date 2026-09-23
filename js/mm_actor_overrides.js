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
const DBLUE_WATERWHEEL_FAKE_GEAR = 0xA528; // gGreatBayTempleObjectWaterwheelWithFakeGearDL

// z_en_light.c D_808666D0: [prim rgb, env rgb] by params & 0xF.
const EN_LIGHT_COLOURS = [
    [[255, 200, 0], [255, 0, 0]], [[255, 235, 175], [255, 0, 0]], [[0, 170, 255], [0, 0, 255]], [[170, 255, 0], [0, 150, 0]],
    [[255, 200, 0], [255, 0, 0]], [[255, 200, 0], [255, 0, 0]], [[170, 255, 0], [0, 150, 0]], [[0, 170, 255], [0, 0, 255]],
    [[255, 0, 170], [200, 0, 0]], [[255, 255, 170], [255, 50, 0]], [[255, 255, 170], [255, 255, 0]], [[255, 255, 170], [100, 255, 0]],
    [[255, 170, 255], [255, 0, 100]], [[255, 170, 255], [100, 0, 255]], [[170, 255, 255], [0, 0, 255]], [[170, 255, 255], [0, 150, 255]],
];

// z_obj_tokeidai.c by OBJ_TOKEIDAI_TYPE: Init's scale, and the lists its
// draw function issues at rest (object_obj_tokeidai).
const TOKEIDAI_SCALES = { 4: 0.15, 5: 0.15, 6: 0.15, 8: 1.0, 9: 0.02, 10: 0.01 };
const tokei = (offset, extra = {}) => ({ ...dl('object_obj_tokeidai', offset), ...extra });
const tokeiClock = (face) => [tokei(0xCF28), tokei(0xBEE8), tokei(face), tokei(0xC368, { ops: [['t', 0, -1112, -19.6]] })];
const TOKEIDAI_LISTS = {
    0: [tokei(0xBA78)], 4: [tokei(0xBA78)],                  // exterior gear
    1: [tokei(0xD388)],                                      // unused wall
    2: tokeiClock(0xE818), 5: tokeiClock(0xE818),            // tower clock
    3: [tokei(0xB208)], 6: [tokei(0xB208)],                  // counterweight
    8: [tokei(0x9A08)],                                      // Termina Field tower walls
    9: tokeiClock(0xF518), 10: tokeiClock(0xF518),           // wall clocks
    11: [tokei(0xD8E8)],                                     // staircase to the rooftop
};

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

    // z_en_dnp.c EnDnp_Init: DEKU_PRINCESS_GET_TYPE (params & 7) 1 is the
    // princess released from a bottle, 0.00085 (the mining takes this, the
    // first Actor_SetScale); the placed ones -- Woodfall Temple (0) and the
    // Deku King's chamber (2) -- are 0.0085.
    "En_Dnp": { scale: (params) => ((params & 7) === 1 ? 0.00085 : 0.0085) },

    // z_mir_ray3.c: the beam Link's Mirror Shield reflects, drawn from the
    // shield's matrix only while it catches light -- nothing at its spawn.
    "Mir_Ray3": { marker: true },

    // z_obj_tokeidai.c: OBJ_TOKEIDAI_TYPE (params >> 12) picks the scale
    // (init chain 0.1; the Termina Field copies 0.15, its tower walls 1.0,
    // the wall clocks 0.02 / 0.01) and the draw: the exterior gear, the
    // clock (minute ring, centre and hand, face, sun/moon panel 1112 below),
    // the counterweight (its spotlight only lit at night), or a single list
    // (walls, rooftop staircase). The tower opening (day 3 night, where the
    // mined yOffset 1500 comes from) is not the state drawn here.
    "Obj_Tokeidai": {
        scale: (params) => TOKEIDAI_SCALES[(params >> 12) & 0xF] ?? 0.1,
        yOffset: 0,
        model: (params) => {
            const lists = TOKEIDAI_LISTS[(params >> 12) & 0xF];
            return lists ? { object: 'object_obj_tokeidai', lists } : null;
        },
    },

    // z_en_fall.c: EN_FALL_TYPE ((params >> 7) & 0x1F) picks the draw and
    // scale from EN_FALL_SCALE (params & 0x7F: 1-4 -> 0.08 / 0.04 / 0.02 /
    // 0.01, else 0.16). The moons draw gMoonDL (the LOD moons object_lodmoon's
    // eyes and moon) with prim 40 / LOD 0x80 (the eyes unlit); the Termina
    // Field and LOD moons are x2.4 on the first day, the clock-tower and
    // stopped moons x3. The crashing moon (x5.4) is drawn only on its
    // cutscene cue; it, the crash effects (fireball, debris, fire ring), the
    // Moon's Tear and the open-mouth moon start undrawn: markers.
    "En_Fall": {
        scale: (params) => {
            const s = [0.16, 0.08, 0.04, 0.02, 0.01][params & 0x7F] ?? 0.16;
            const type = (params >> 7) & 0x1F;
            return s * (type === 1 ? 1 : type === 2 ? 5.4 : (type === 7 || type === 9) ? 3 : 2.4);
        },
        model: (params) => {
            const type = (params >> 7) & 0x1F;
            const glow = { prim: [40, 40, 40, 255], primLod: 0x80 };
            if ([5, 6, 12].includes(type)) {
                return { object: 'object_lodmoon', lists: [{ ...dl('object_lodmoon', 0x10E0), ...glow }, { ...dl('object_lodmoon', 0x1158), ...glow }] };
            }
            if ([2, 3, 4, 8, 10, 11].includes(type)) return null;
            return { object: 'object_fall', lists: [{ ...dl('object_fall', 0x77F0), ...glow }] };
        },
    },

    // z_obj_hakaisi.c (Ikana gravestones): params & 0xFF 3 draws nothing,
    // 4 and 5 are the broken pieces (func_80B154A0: DL_001F10 / DL_0021B0 at
    // 0.1, yOffset 100); the rest stand whole at 1.0 (ObjHakaisi_Draw with
    // unk_194 0: DL_002650).
    "Obj_Hakaisi": {
        scale: (params) => ([4, 5].includes(params & 0xFF) ? 0.1 : 1.0),
        yOffset: (params) => ([4, 5].includes(params & 0xFF) ? 100 : 0),
        model: (params) => {
            const type = params & 0xFF;
            if (type === 3) return null;
            const offset = type === 4 ? 0x1F10 : type === 5 ? 0x21B0 : 0x2650;
            return { object: 'object_hakaisi', lists: [dl('object_hakaisi', offset)] };
        },
    },

    // z_bg_ctower_gear.c: BGCTOWERGEAR_GET_TYPE (params & 3) indexes
    // sDLists (ceiling cog, centre cog, water wheel); the organ (3) has no
    // draw until a cutscene cue installs BgCtowerGear_DrawOrgan.
    "Bg_Ctower_Gear": {
        model: (params, sceneName, base) => ((params & 3) === 3 ? null : { ...base, lists: base.lists.filter(l => l.variants) }),
    },

    // z_obj_syokudai.c: a torch that starts lit (params & 0x800) also draws
    // gEffFire1DL 52 up at 0.0027, prim (255, 255, 0) / env (255, 0, 0), LOD
    // 0x80 (billboarded in game; drawn facing the torch's yaw here).
    "Obj_Syokudai": {
        model: (params, sceneName, base) => (params & 0x800 ? {
            ...base,
            lists: [...base.lists, { ...keep(0x7D590, 'xlu'), ops: [['t', 0, 52, 0], ['s', 0.0027, 0.0027, 0.0027]],
                                     prim: [255, 255, 0, 255], env: [255, 0, 0, 0], primLod: 0x80 }],
        } : base),
    },

    // z_obj_tsubo.c: sPotTypeData[(params >> 7) & 3].scale -- the magic pot
    // (1) 0.2955, the others 0.197.
    "Obj_Tsubo": { scale: (params) => (((params >> 7) & 3) === 1 ? 0.2955 : 0.197) },

    // z_en_kusa.c EnKusa_WaitObject: type (params & 3) 0 is a bush
    // (EnKusa_DrawBush: gameplay_field_keep's gKusaBushType1DL), the rest
    // grass (EnKusa_DrawGrass: object_kusa's sprout, uncut). 0.4, and the
    // -6.25 yOffset only once cut.
    "En_Kusa": {
        yOffset: 0,
        model: (params) => ((params & 3) === 0
            ? { object: 'gameplay_field_keep', lists: [dl('gameplay_field_keep', 0x78A0)] }
            : { object: 'object_kusa', lists: [dl('object_kusa', 0x140)] }),
    },

    // z_en_twig.c (Beaver race rings): params & 0xF 1 is a ring at 4.2, 2
    // the big ring at 1.0; 0 is killed.
    "En_Twig": {
        scale: (params) => ((params & 0xF) === 2 ? 1.0 : 4.2),
        model: (params, sceneName, base) => ((params & 0xF) === 0 ? null : base),
    },

    // z_obj_etcetera.c (Deku flowers): DEKU_FLOWER_TYPE ((params & 0xFF80)
    // >> 7) 0 / 1 pink, 2 / 3 gold. At rest ObjEtcetera_DrawIdle draws the
    // idle list (the bounce types settle into it), at (0.01, 0.02, 0.01).
    "Obj_Etcetera": {
        scale: [0.01, 0.02, 0.01],
        model: (params) => ({ object: 'gameplay_keep', lists: [keep(((params >> 7) & 0x1FF) >= 2 ? 0x11BD0 : 0xED80)] }),
    },

    // z_en_ishi.c: size (params & 1) picks sIshiSizes (0.1 / 0.4) and
    // sIshiShapeYOffsets (58 / 80); ENISHI_GET_USE_OBJECT ((params >> 3) & 1)
    // draws object_ishi's gSmallRockDL, else gameplay_field_keep's small
    // rock or silver boulder (prim white) by size.
    "En_Ishi": {
        scale: (params) => ((params & 1) ? 0.4 : 0.1),
        yOffset: (params) => ((params & 1) ? 80 : 58),
        model: (params) => {
            if ((params >> 3) & 1) return { object: 'object_ishi', lists: [dl('object_ishi', 0x9B0)] };
            return { object: 'gameplay_field_keep', lists: [(params & 1)
                ? { ...dl('gameplay_field_keep', 0x61E8), prim: [255, 255, 255, 255] }
                : dl('gameplay_field_keep', 0x66B0)] };
        },
    },

    // z_en_water_effect.c: drips, splashes and falling-rock particles an
    // update spawns and draws at their own positions -- nothing at the spawn.
    "En_Water_Effect": { marker: true },

    // z_obj_snowball.c: 0.1, x1.5 when home.rot.y is 1 (a raw size flag);
    // pitch and roll zeroed. ObjSnowball_Draw is the whole ball
    // (object_goroiwa_DL_008B90); DL_0082D0 is its pieces once broken.
    "Obj_Snowball": {
        scale: (params, sceneName, rot) => (rot?.[1] === 1 ? 0.15 : 0.1),
        rot: (rot) => [0, rot[1], 0],
        model: () => ({ object: 'object_goroiwa', lists: [dl('object_goroiwa', 0x8B90)] }),
    },

    // z_obj_switch.c: type (params & 7) scales by sScale; a floor switch (0)
    // stands raised at y floorSwitchUpScale (33 / 200, a third of that in
    // Sakon's Hideout), the large one (5) at 0.2475. Floor types sit 1 (1.9
    // for the large) over home. An eye switch (2) shows sEyeSwitchTextures[
    // (params >> 4) & 7][0], the open eye, in segment 8.
    "En_Neo_Reeba": { scale: (params) => ((params & 0x8000) ? 0.05 : 0.04) },
    "Obj_Switch": {
        scale: (params, sceneName) => {
            const type = params & 7;
            if (type === 0) return [0.123, sceneName === 'Z2_SECOM' ? 0.055 : 0.165, 0.123];
            if (type === 5) return [0.248, 0.2475, 0.248];
            return [0.123, 0.123, 0.1, 0.118, 0.118][type] ?? 0.1;
        },
        model: (params, sceneName, base) => ((params & 7) === 2
            ? { ...base, segments: { 8: { file: 'gameplay_dangeon_keep', offset: ((params >> 4) & 7) ? 0xB6C0 : 0xAEC0 } } }
            : base),
        place: (inst) => {
            const type = inst.params & 7;
            if (![0, 1, 5].includes(type)) return {};
            return { position: [inst.position[0], inst.position[1] + (type === 5 ? 1.9 : 1), inst.position[2]] };
        },
    },

    // z_en_kanban.c: an uncut sign (partFlags 0xFFFF) is object_kanban's
    // gSignMaterialDL then gameplay_keep's whole gSignRectangularDL 100
    // back; the pieces, cut mark and shadow only once it is cut. Drawn 15
    // below home for human / Deku Link.
    "En_Kanban": {
        model: () => ({ object: 'object_kanban', lists: [dl('object_kanban', 0xC30), { ...keep(0x5AED0), ops: [['t', 0, 0, -100]] }] }),
        place: (inst) => ({ position: [inst.position[0], inst.position[1] - 15, inst.position[2]] }),
    },

    // z_en_wood02.c: params & 0xFF is the WOOD_ type. Scale 1.5 for the
    // large trees / bushes (and their spawners / spawned copies) and the
    // special tree, 0.6 for the small conical tree, 0.02 for the leaves.
    // drawType from the type (conical, oval, Kakariko, green bush, black
    // bush, leaf) picks D_808C4D54 (opaque trunk) + D_808C4D70 (XLU canopy
    // with the oval trees' green / yellow env), or D_808C4D54 alone on XLU
    // for bushes; the leaves draw DL_000700.
    "En_Wood02": {
        scale: (params) => {
            const t = params & 0xFF;
            if ([0x00, 0x0C, 0x0F, 0x10, 0x12, 0x15, 0x16, 0x1A].includes(t)) return 1.5;
            if (t === 0x02) return 0.6;
            if (t === 0x17 || t === 0x18) return 0.02;
            return 1.0;
        },
        model: (params) => {
            const t = params & 0xFF;
            const wood = (offset, layer, extra = {}) => ({ ...dl('object_wood02', offset, layer), ...extra });
            if (t === 0x17 || t === 0x18) return { object: 'object_wood02', lists: [wood(0x700, 'opa')] };
            const drawType = t === 0x1A || t < 0x05 ? 0 : t < 0x0A ? 1 : t < 0x0B ? 2 : t < 0x11 ? 3 : 4;
            const env = [5, 8, 9].includes(t) ? [50, 170, 70, 0] : [6, 7].includes(t) ? [180, 155, 0, 0] : [255, 255, 255, 0];
            const opa = [0x78D0, 0x7CA0, 0x8160, 0x90, 0x340][drawType];
            const xlu = [0x7968, 0x7D38, 0x80D0, null, null][drawType];
            return { object: 'object_wood02', lists: xlu != null ? [wood(opa, 'opa'), wood(xlu, 'xlu', { env })] : [wood(opa, 'xlu')] };
        },
    },

    // z_en_sw.c: EnSw_Draw tips the skeleton back Matrix_RotateXS(-0x3C72);
    // EnSw_OverrideLimbDraw swaps in the gold body only for Gold Skulltulas
    // (params & 3 != 0), a Skullwalltula keeps the skeleton's own lists.
    "En_Sw": {
        model: (params, sceneName, base) => ({
            ...base,
            skelOps: [['rx', -0x3C72 * Math.PI / 0x8000]],
            limbLists: (params & 3) ? base.limbLists : null,
        }),
    },

    // z_door_warp1.c by params & 0xFF: 0 / 1 the blue warp (func_808BAE9C:
    // gWarpPortalDL loading its matrices from segment 0xA, at the actor's
    // position +1 unscaled, and 9, lifted unk_1A4 (0.3 at rest) * 230; drawn
    // at full alpha, the state it fades into), 1 also the crystal skeleton;
    // 2-5 the boss-warp platform (gWarpBossWarpPlatformDL at 0.1); 6 its
    // light-shaft beam, which only rises on activation: a marker.
    "Door_Warp1": {
        scale: (params) => ([2, 3, 4, 5].includes(params & 0xFF) ? 0.1 : 1.0),
        yOffset: 0,
        model: (params, sceneName, base) => {
            const type = params & 0xFF;
            if (type === 6) return null;
            if (type >= 2) return { object: 'object_warp1', lists: [dl('object_warp1', 0x76C0)] };
            const portal = { ...dl('object_warp1', 0x1A0, 'xlu'), prim: [0, 255, 255, 255], env: [0, 0, 255, 255], primLod: 0x80 };
            return {
                object: 'object_warp1',
                skeleton: type === 1 ? base.skeleton : undefined, anim: type === 1 ? base.anim : undefined,
                lists: [portal],
                segments: { 0x0A: { matrices: [[['new'], ['t', 0, 1, 0]]] }, 0x09: { matrices: [[['new'], ['t', 0, 70, 0]]] } },
            };
        },
    },

    // z_bg_breakwall.c: D_808B8140[params & 0xF] picks the lists (mined by
    // field) and a setup: scale 1 from the init chain, 0.1 for types 4, 9
    // and 11 (func_808B7410 / func_808B751C), x alone 0.1 for type 5
    // (func_808B7460), 3.5 for the type 7 whirlpool (func_808B78DC).
    "Bg_Breakwall": {
        scale: (params) => {
            const type = params & 0xF;
            if ([4, 9, 11].includes(type)) return 0.1;
            if (type === 5) return [0.1, 1, 1];
            return type === 7 ? 3.5 : 1.0;
        },
    },

    // z_obj_nozoki.c (Sakon's Hideout): unk_15C = (params >> 7) & 3 picks
    // D_80BA34FC's object_secom_obj list (door, lid, second lid) at 1.0;
    // type 1 is the Sun's Mask on its conveyor (GetItem_Draw, 0.6) and in the
    // Curiosity Shop it is the peephole, which draws nothing: markers.
    "Obj_Nozoki": {
        scale: 1.0,
        model: (params, sceneName) => {
            const type = (params >> 7) & 3;
            if (sceneName === 'Z2_AYASHIISHOP' || type === 1) return null;
            return { object: 'object_secom_obj', lists: [dl('object_secom_obj', [0x80, 0, 0x1230, 0x1300][type])] };
        },
    },

    // z_obj_mine.c: OBJMINE_GET_TYPE ((params >> 12) & 3). A path mine (0)
    // is the spiked ball (DL_002068 + DL_002188, env black). An air mine (1)
    // hangs linkCount (params & 0x3F) links of 12 below home, the ball 10
    // below the last; a water mine (2) is tethered up from home the same way,
    // alternate links turned 90 degrees. Scale 0.01 (the init chain); the
    // ball is tipped RotateX(0x2000). Offsets below are world units / 0.01.
    "Obj_Mine": {
        scale: 0.01,
        model: (params) => {
            const type = (params >> 12) & 3, n = type === 0 ? 0 : params & 0x3F;
            const dir = type === 2 ? 1 : -1;
            const ball = (y) => [
                { ...dl('object_ny', 0x2068), env: [0, 0, 0, 255], ops: [['t', 0, y, 0], ['rx', 0x2000 * Math.PI / 0x8000]] },
                { ...dl('object_ny', 0x2188), env: [0, 0, 0, 255], ops: [['t', 0, y, 0], ['rx', 0x2000 * Math.PI / 0x8000]] },
            ];
            if (type === 0) return { object: 'object_ny', lists: ball(0) };
            const lists = [];
            for (let i = 0; i < n; i++) {
                const ops = [['t', 0, dir * (i * 12 + 6) * 100, 0]];
                if (type === 2 && i % 2 === 0) ops.push(['ry', Math.PI / 2]);
                lists.push({ ...dl('object_ny', 0x30), ops });
            }
            return { object: 'object_ny', lists: [...lists, ...ball(dir * (10 + n * 12) * 100)] };
        },
    },

    // z_obj_kinoko.c: the magic mushroom's glow -- two crossed quads
    // (gameplay_keep_DL_029D10 entered at its third command), prim purple
    // with alpha from speed (drawn half-opaque here), env (110, 44, 200).
    "Obj_Kinoko": {
        model: () => ({
            object: 'gameplay_keep',
            lists: [0, 1].map(k => ({ ...keep(0x29D20, 'xlu'), prim: [169, 63, 186, 128], env: [110, 44, 200, 100],
                                      ops: k ? [['rx', -Math.PI / 2]] : undefined })),
        }),
    },

    // z_obj_bean.c: OBJBEAN_GET_C000 (params >> 14) 2 is the soft-soil patch
    // (func_80938F50: XLU DL_002208); 0 the grown bean platform (unk_1FE 2:
    // DL_0002D0), 1 a sprout in the soil (unk_1FE 1: DL_000530).
    "Obj_Bean": {
        scale: 0.1,
        model: (params) => {
            const type = (params >> 14) & 3;
            return { object: 'object_mamenoki', lists: [type === 2 ? dl('object_mamenoki', 0x2208, 'xlu') : dl('object_mamenoki', type === 0 ? 0x2D0 : 0x530)] };
        },
    },

    // z_en_bb.c (Bubble): the skull skeleton at 0.01 and its blue flame
    // (gEffFire1DL, prim white / env blue, LOD 0x80) scaled (1, 0.8) and
    // dropped 47 * 0.8 below the skull (billboarded in game).
    "En_Bb": {
        scale: 0.01,
        model: (params, sceneName, base) => ({
            ...base,
            lists: [{ ...keep(0x7D590, 'xlu'), ops: [['t', 0, -3760, 0], ['s', 1, 0.8, 1]], prim: [255, 255, 255, 255], env: [0, 0, 255, 0], primLod: 0x80 }],
        }),
    },

    // z_en_go.c: the Goron skeleton at ENGO_NORMAL_SCALE (0.01), x5 for the
    // Medigoron (type (params & 0xF) 8). The steam / dust / snow lists are
    // effect particles drawn at their own positions, and the -4000 shift only
    // applies to the sitting-stretch animation.
    "En_Go": {
        scale: (params) => ((params & 0xF) === 8 ? 0.05 : 0.01),
        model: (params, sceneName, base) => ({ ...base, lists: [], skelOps: [] }),
    },

    // z_en_slime.c (ChuChu): colour by type (params & 0xFF: blue, green,
    // yellow, red) -- sPrimColors / sEnvColors with LOD 100 on the body --
    // the eyes (env (0, 30, 70), gChuchuEyeOpenTex in segment 9). The item
    // it may hold (gItemDropDL) only shows once it is hit.
    "En_Slime": {
        model: (params, sceneName, base) => {
            const t = Math.min(params & 0xFF, 3);
            const prim = [[255, 255, 255, 255], [255, 255, 0, 255], [255, 255, 200, 255], [225, 200, 255, 255]][t];
            const env = [[140, 255, 195, 255], [50, 255, 0, 255], [255, 180, 0, 255], [255, 50, 155, 255]][t];
            return {
                object: 'object_slime',
                lists: [{ ...dl('object_slime', 0x4C0, 'xlu'), prim, env, primLod: 100 }, { ...dl('object_slime', 0x650), env: [0, 30, 70, 255] }],
                segments: { 9: { file: 'object_slime', offset: 0xF70 } },
            };
        },
    },

    // z_en_rat.c (Real Bombchu): EnRat_PostLimbDraw hangs its bomb off the
    // tail end (limb 5): gBombCapDL, then gBombBodyDL turned RotateZYX(0x4000)
    // in (255, 0, 40) before it starts flashing; the fuse sparks only while
    // it chases.
    "En_Rat": {
        model: (params, sceneName, base) => ({
            ...base,
            limbLists: { 5: [
                { ...keep(0x15FA0), add: true },
                { ...keep(0x15DB0), add: true, ops: [['rx', Math.PI / 2]], prim: [255, 0, 40, 255], env: [255, 0, 40, 255] },
            ] },
        }),
    },

    // z_en_zoraegg.c: at rest (unk_1ED 255) an egg is the opaque gZoraEggDL
    // alone -- the hatchling skeleton only shows once it hatches, and the
    // glow quad is a camera-facing effect. Type (params & 0x1F) 1 starts
    // undrawn (func_80B31590).
    "En_Zoraegg": {
        model: (params) => ((params & 0x1F) === 1 ? null : { object: 'object_zoraegg', lists: [dl('object_zoraegg', 0x5250)] }),
    },

    // z_en_karebaba.c (Deku Baba) at rest (EnKarebaba_SetupIdle): the head
    // skeleton at 0.005 pointing up (shape.rot.x -0x4000), 14 above home;
    // under it EnKarebaba_Draw hangs the stem sections (top, middle, base; the
    // mini type 2 only the top) at 0.01, each 2000 further along; the base
    // leaves lie flat at home at 0.01 (drawn from the head's frame here).
    "En_Karebaba": {
        scale: 0.005,
        rot: (rot) => [-0x4000, rot[1], 0],
        place: (inst) => ({ position: [inst.position[0], inst.position[1] + 14, inst.position[2]] }),
        model: (params, sceneName, base) => {
            const stems = [0x1330, 0x1628, 0x1828].slice(0, (params & 0xFF) === 2 ? 1 : 3)
                .map((offset, i) => ({ ...dl('object_dekubaba', offset), ops: [['s', 2, 2, 2], ['t', 0, 0, -2000 * (i + 1)]] }));
            const leaves = { ...dl('object_dekubaba', 0x10F0), ops: [['s', 200, 200, 200], ['rx', Math.PI / 2], ['t', 0, -14, 0], ['s', 0.01, 0.01, 0.01]] };
            return { ...base, skelOps: [], lists: [...stems, leaves] };
        },
    },

    // z_en_baguo.c (Nejiron): buried at rest (yOffset -3000); the boulder
    // fragments are its explosion.
    "En_Baguo": { model: (params, sceneName, base) => ({ ...base, lists: [] }) },

    // z_en_mnk.c (monkeys): gMonkeySkel (the mining took the pole's, the
    // file's first SkelAnime_Init) with its face in segment 8. MONKEY_GET_TYPE
    // ((params >> 7) & 0xF) 5 is tied to a pole, 6 hangs from a rope: those
    // draw the prop skeleton and re-root the monkey at its limb 4 / 3
    // (EnMnk_*_PropPostLimbDraw's Matrix_Get), both at their first
    // animation (kick around / struggle; the kicking monkey's face 5).
    "En_Mnk": {
        scale: 0.012,
        model: (params) => {
            const mnk = (offset, extra = {}) => ({ file: 'object_mnk', offset, ...extra });
            const monkey = mnk(0x19B88, { type: 'Flex', limbType: 'Standard' });
            const type = (params >> 7) & 0xF;
            if (type === 5 || type === 6) {
                const hanging = type === 6;
                return {
                    object: 'object_mnk',
                    skeleton: mnk(hanging ? 0x1D518 : 0x5150, { type: 'Flex', limbType: 'Standard' }),
                    anim: mnk(hanging ? 0x1C3B4 : 0x3584),
                    attach: { limb: hanging ? 3 : 4, skeleton: monkey, anim: mnk(hanging ? 0x82C8 : 0xD1C8) },
                    segments: { 8: mnk(hanging ? 0x15020 : 0x17920) },
                };
            }
            return { object: 'object_mnk', skeleton: monkey, anim: mnk(0x105DC), segments: { 8: mnk(0x15020) } };
        },
    },

    // z_en_kakasi.c (Pierre's scarecrow): one placed above ground
    // (params & 1) stands at yOffset 0; the others wait underground (draw NULL,
    // yOffset -7000) until summoned with a song.
    "En_Kakasi": {
        yOffset: 0,
        model: (params, sceneName, base) => ((params & 1) ? base : null),
    },

    // z_obj_tree.c: OBJTREE_ISLARGE (params & 0x8000) 0.15, else 0.1.
    "Obj_Tree": { scale: (params) => ((params & 0x8000) ? 0.15 : 0.1) },

    // z_en_snowman.c (Eeno): an Eeno (types 0-2, params & 0xFF) starts
    // hidden as the moving snow pile (EnSnowman_SetupMoveSnowPile:
    // gEenoSnowPileSkel), 0.02 for the large one (1), else 0.01; the
    // snowballs (3 / 4) are its projectiles.
    "En_Snowman": {
        scale: (params) => ((params & 0xFF) === 1 ? 0.02 : 0.01),
        model: (params) => ((params & 0xFF) >= 3 ? null : {
            object: 'object_snowman',
            skeleton: { file: 'object_snowman', offset: 0x4A90, type: 'Flex', limbType: 'Standard' },
            anim: { file: 'object_snowman', offset: 0x46D8 },
        }),
    },

    // z_obj_warpstone.c (owl statue): no scale of its own (0.01 from
    // Actor_Init); closed until the owl is activated. The flash is a save
    // effect.
    "Obj_Warpstone": { scale: 0.01, model: (params, sceneName, base) => ({ ...base, lists: base.lists.map(l => (l.variants ? { ...l, select: null } : l)) }) },

    // z_en_az.c (Beaver brothers): D_80A9915C[(params >> 8) & 0xF] 0 is the
    // older brother (gBeaverOlderBrotherSkel, 0.012), else the younger one
    // (gBeaverYoungerBrotherSkel at 0.01 with his eye / belt textures in
    // segments 8 / 9). The tail vortex and splash only show while swimming.
    "En_Az": {
        scale: (params) => ([0, 2, 4].includes((params >> 8) & 0xF) ? 0.012 : 0.01),
        model: (params, sceneName, base) => {
            const older = [0, 2, 4].includes((params >> 8) & 0xF);
            return {
                ...base, lists: [],
                skeleton: { file: 'object_az', offset: older ? 0x7438 : 0x17990, type: 'Flex', limbType: 'Standard' },
                segments: older ? {} : base.segments,
            };
        },
    },

    // z_obj_lightblock.c (sun block): sLightblockTypeVars[params & 1].scale.
    "Obj_Lightblock": { scale: (params) => ((params & 1) ? 1 / 6 : 0.1) },

    // z_en_nwc.c (cucco chick): gNwcBodyDL with its open eye in segment 8,
    // until it grows into a cucco (the object_niw skeleton).
    "En_Nwc": {
        model: () => ({ object: 'object_nwc', lists: [dl('object_nwc', 0x2E8)], segments: { 8: { file: 'object_nwc', offset: 0x7D0 } } }),
    },

    // z_en_elforg.c (stray fairy): its colour is the area's AnimatedMaterial
    // -- in a dungeon (or its boss room) that dungeon's, else
    // STRAY_FAIRY_GET_NON_DUNGEON_AREA ((params >> 6) & 7): Clock Town,
    // Woodfall, Snowhead, Great Bay, Stone Tower.
    "En_Elforg": {
        model: (params, sceneName, base) => {
            const dungeon = { Z2_MITURIN: 1, Z2_MITURIN_BS: 1, Z2_HAKUGIN: 2, Z2_HAKUGIN_BS: 2, Z2_SEA: 3, Z2_SEA_BS: 3,
                              Z2_INISIE_N: 4, Z2_INISIE_R: 4, Z2_INISIE_BS: 4 }[sceneName];
            const area = dungeon ?? ((params >> 6) & 7);
            return { ...base, animMat: keepTex([0x2C818, 0x2C908, 0x2C890, 0x2C980, 0x2C9F8][area] ?? 0x2C818) };
        },
    },

    // z_en_test2.c: lens-of-truth objects; sModelInfo[params] (the whole
    // word). The mining could not read the index through the macro.
    "En_Test2": {
        model: (params, sceneName, base) => ({ ...base, lists: base.lists.map(l => (l.variants ? { ...l, select: [0, 0xFFFF] } : l)) }),
    },

    // z_en_bbfall.c (red Bubble): as En_Bb with a red flame (env 255, 0, 0).
    "En_Bbfall": {
        scale: 0.01,
        model: (params, sceneName, base) => ({
            ...base,
            lists: [{ ...keep(0x7D590, 'xlu'), ops: [['t', 0, -3760, 0], ['s', 1, 0.8, 1]], prim: [255, 255, 0, 255], env: [255, 0, 0, 0], primLod: 0x80 }],
        }),
    },

    // z_bg_dblue_movebg.c (Great Bay Temple): type params & 0xF picks
    // sOpaDLists / sXluDLists / sTexAnims: 1 the two-way switch, 6 the gear
    // shaft (gGreatBayTempleObjectGearShaftDL under the shaft with platforms),
    // 7 the one-way switch, 10 the whirlpool (XLU, its animated material);
    // the waterwheels (8 / 9) take the plain wheel in room 0 and the one with
    // the fake gear in room 8. Type 11 only plays the wheel's sound.
    "Bg_Dblue_Movebg": {
        model: (params, sceneName, base, rot, keepFile, room) => {
            const type = params & 0xF, obj = (offset, layer) => dl('object_dblue_object', offset, layer);
            const spec = (lists, extra = {}) => ({ object: 'object_dblue_object', lists, ...extra });
            switch (type) {
                case 1: return spec([obj(0x69D8)]);
                case 6: return spec([obj(0x52B8), obj(0x4848)]);
                case 7: return spec([obj(0x61B8)]);
                case 8: case 9: return spec([obj(room === 8 ? DBLUE_WATERWHEEL_FAKE_GEAR : 0x8778)]);
                case 10: return spec([obj(0xCAA0, 'xlu')], { animMat: { file: 'object_dblue_object', offset: 0xCC18 } });
                default: return null;
            }
        },
    },

    // z_obj_raillift.c: OBJRAILLIFT_GET_TYPE ((params >> 15) & 1) 1 is a
    // Deku flower platform (DL_000208, the colourful DL_0071B8 when its speed
    // -- home.rot.z / 10 -- is negative), else the lift (DL_004BF0).
    "Obj_Raillift": {
        model: (params, sceneName, base, rot) => ({
            object: 'object_raillift',
            lists: [dl('object_raillift', !((params >> 15) & 1) ? 0x4BF0 : (rot?.[2] ?? 0) < 0 ? 0x71B8 : 0x208)],
            segments: base.segments,
        }),
    },

    // z_obj_bigicicle.c: scale (params >> 8) & 0xFF thousandths (0 / 0xFF:
    // 60); at rest unk_149 0, the first of each list table.
    "Obj_Bigicicle": {
        scale: (params) => { const n = (params >> 8) & 0xFF; return ((n === 0 || n === 0xFF) ? 60 : n) * 0.001; },
    },

    // z_en_kusa2.c (Keaton grass ring): each is a gKusaBushType1DL bush at 0.4;
    // the leaf lists are the cut effect.
    "En_Kusa2": { model: () => ({ object: 'gameplay_field_keep', lists: [dl('gameplay_field_keep', 0x78A0)] }) },

    // z_en_bigpo.c (Big Poe): params & 0xFF 0 (Beneath the Well) and 1
    // (Dampe's) are the ghost itself, EnBigpo_DrawMainBigpo's skeleton at
    // 0.014; 2-5 are the flames circling to summon it: markers. The lantern
    // and soul lists belong to other states.
    "En_Bigpo": {
        model: (params, sceneName, base) => ((params & 0xFF) <= 1 ? { ...base, lists: [] } : null),
    },

    // z_bg_dy_yoseizo.c (Great Fairy): the particle lists are its sparkle
    // effects.
    "Bg_Dy_Yoseizo": { model: (params, sceneName, base) => ({ ...base, lists: [] }) },

    // z_bg_dblue_waterfall.c: unfrozen at rest (unk_19E 255): the waterfall
    // alone; the ice stalactite and frozen waterfall once its switch is set.
    "Bg_Dblue_Waterfall": {
        model: (params, sceneName, base) => ({ ...base, lists: base.lists.slice(0, 1) }),
    },

    // z_bg_kin2_shelf.c: params & 1 0 is the chest of drawers at 0.1, 1 the
    // bookshelf at 1.0.
    "Bg_Kin2_Shelf": { scale: (params) => ((params & 1) ? 1.0 : 0.1) },

    // z_dm_char01.c (Woodfall scenery), poisoned until the temple is cleared
    // (unk_34C 0): params 0 the poison water, 1 the poison walls, 2 the temple
    // and its entrances, 3 the ramp and platform (only once raised above
    // -120). The purified variants and cutscene water are later states.
    "Dm_Char01": {
        model: (params, sceneName, base) => {
            const m = (offset, layer) => dl('object_mtoride', offset, layer);
            const lists = [[m(0xA8F8)], [m(0xA398)], [m(0xDF18), m(0xDE50, 'xlu')], [m(0xFAE8)]][params & 0xFF];
            return lists ? { object: 'object_mtoride', lists } : null;
        },
        place: (inst) => ((inst.params & 0xFF) === 3 && inst.position[1] <= -120 ? { model: null } : {}),
    },

    // z_bg_dblue_balance.c: the seesaw parts by (params >> 8) & 3; the splash
    // only shows while it moves.
    "Bg_Dblue_Balance": { model: (params, sceneName, base) => ({ ...base, lists: base.lists.filter(l => l.variants) }) },

    // z_demo_kankyo.c: Lost Woods sparkles / moon-and-giants light orbs --
    // particles drawn at their own positions.
    "Demo_Kankyo": { marker: true },

    // z_en_sob1.c (shopkeepers), ENSOB1_GET_SHOPTYPE (params & 0x1F): 0 the
    // Zora (gZoraSkel, object_masterzoora's anim), 1 / 3 the Goron
    // (gGoronSkel, object_mastergolon's), 2 the Bomb Shop's (sitting at the
    // counter, his bomb on limb 11); all 0.01, eyes open in segment 8.
    "En_Sob1": {
        scale: 0.01,
        model: (params) => {
            const flex = (file, offset) => ({ file, offset, type: 'Flex', limbType: 'Standard' });
            switch (params & 0x1F) {
                case 0: return { object: 'object_zo', skeleton: flex('object_zo', 0xD208), anim: { file: 'object_masterzoora', offset: 0x78C },
                                 segments: { 8: { file: 'object_zo', offset: 0x50A0 } } };
                case 1: case 3: return { object: 'object_oF1d_map', skeleton: flex('object_oF1d_map', 0x11AC8), anim: { file: 'object_mastergolon', offset: 0xFC },
                                         segments: { 8: { file: 'object_oF1d_map', offset: 0x10438 } } };
                case 2: return { object: 'object_rsn', skeleton: flex('object_rsn', 0x9220), anim: { file: 'object_rsn', offset: 0x87BC },
                                 segments: { 8: { file: 'object_rsn', offset: 0x5458 } },
                                 limbLists: { 11: [{ ...dl('object_rsn', 0x970), add: true }] } };
                default: return null;
            }
        },
    },

    // z_obj_hugebombiwa.c: ENHUGEBOMBIWA_GET_100 ((params >> 8) & 1) 1 is
    // the huge boulder at 0.74 (func_80A55B34: DL_001820), else the one at
    // 0.067 (DL_002F60 with its XLU DL_003110). The rest are its pieces.
    "Obj_Hugebombiwa": {
        scale: (params) => (((params >> 8) & 1) ? 0.74 : 0.067),
        model: (params) => ({
            object: 'object_bombiwa',
            lists: ((params >> 8) & 1) ? [dl('object_bombiwa', 0x1820)]
                : [{ ...dl('object_bombiwa', 0x2F60), prim: [255, 255, 255, 255], primLod: 255 }, { ...dl('object_bombiwa', 0x3110, 'xlu'), prim: [255, 255, 255, 255], primLod: 255 }],
        }),
    },

    // z_bg_iknv_doukutu.c (Ikana Canyon cave): BGIKNVDOUKUTU_GET_F
    // (params & 0xF) 0 the cursed spring (BgIknvDoukutu_Draw: DL_00DDD8 env
    // black + XLU DL_00DB60 env (215, 42, 55, 120)), 1 the water at 1.0
    // (XLU DL_012700), 2 the glow (XLU DL_0115E0).
    "Bg_Iknv_Doukutu": {
        scale: (params) => ((params & 0xF) === 1 ? 1.0 : 0.1),
        model: (params, sceneName, base) => {
            const k = (offset, layer, extra = {}) => ({ ...dl('object_iknv_obj', offset, layer), ...extra });
            const lists = [
                [k(0xDDD8, 'opa', { env: [0, 0, 0, 255] }), k(0xDB60, 'xlu', { env: [215, 42, 55, 120] })],
                [k(0x12700, 'xlu')],
                [k(0x115E0, 'xlu', { prim: [255, 255, 255, 140], primLod: 0x80 })],
            ][params & 0xF];
            return lists ? { ...base, lists } : null;
        },
    },

    // z_en_osk.c (Igos's servants in cutscenes), ENOSK_GET_TYPE (params &
    // 0xF): 1 Skel_007B48 at 0.013, 2 Skel_00B490 (its own sk2_default; Init
    // plays type 1's, which doesn't fit), else Skel_0038F0 at 0.017. No other
    // lists (the mined ones are its disappearing-dust effect).
    "En_Osk": {
        scale: (params) => ([1, 2].includes(params & 0xF) ? 0.013 : 0.017),
        model: (params) => {
            const [skel, anim] = { 1: [0x7B48, 0x6808], 2: [0xB490, 0x9F00] }[params & 0xF] ?? [0x38F0, 0xB8];
            return { object: 'object_ikn_demo', skeleton: { file: 'object_ikn_demo', offset: skel, type: 'Flex', limbType: 'Standard' },
                     anim: { file: 'object_ikn_demo', offset: anim }, segments: { 8: { colour: { prim: [1, 1, 1, 1], lodFrac: 0x80 / 256, env: null } } } };
        },
    },

    // z_en_tru.c (Koume, injured in the Woods of Mystery): just the skeleton
    // lying down with its eyes; the mined lists are her potion effects.
    "En_Tru": {
        model: (params, sceneName, base) => ({ ...base, lists: [] }),
    },

    // z_en_horse.c: ENHORSE_PARAM_DONKEY (0x8000) the donkey (gDonkeySkel,
    // 0.008), ENHORSE_PARAM_BANDIT (0x2000) the bandits' horse
    // (gHorseBanditSkel, 0.01), both in object_ha idling (sHniAnimations[0]).
    // Epona (0x4000) is a Skin skeleton, not drawn here.
    "En_Horse": {
        scale: (params) => ((params & 0x8000) ? 0.008 : (params & 0x4000) ? 0.00648 : 0.01),
        model: (params) => {
            if (!(params & 0xA000)) return null;
            return { object: 'object_ha', skeleton: { file: 'object_ha', offset: (params & 0x8000) ? 0x150D8 : 0x8C68, type: 'Flex', limbType: 'Standard' },
                     anim: { file: 'object_ha', offset: 0xC850 } };
        },
    },

    // z_en_al.c (Madame Aroma): her shawl pieces, D_80BE007C, drawn at the
    // matrices PostLimbDraw keeps for the shawl limbs.
    "En_Al": {
        model: (params, sceneName, base) => {
            const shawl = (offset) => [{ ...dl('object_al', offset), add: true }];
            return { ...base, lists: [], limbLists: { 3: shawl(0x6598), 11: shawl(0x5920), 12: shawl(0x5878), 13: shawl(0x57D0), 14: shawl(0x5728), 15: shawl(0x5680) } };
        },
    },

    // z_en_ot.c (the seahorse) and z_en_egol.c (Eyegore): the skeleton and
    // its animated material only -- the mined lists are their bubbles,
    // shadow, laser and debris effects.
    "En_Ot": {
        model: (params, sceneName, base) => ({ ...base, lists: [], segments: {} }),
    },
    "En_Egol": {
        model: (params, sceneName, base) => ({ ...base, lists: [] }),
    },

    // z_en_light.c (free-standing flames): D_808666D0[params & 0xF] gives
    // the colours and the size (unk_07 * 0.0001). A non-negative params is
    // gEffFire1DL in those colours, a negative one the small
    // gameplay_keep_DL_01ACF0 flame (prim (255, 200, 0), env red). 0x2000
    // without 0x800 is hidden.
    "En_Light": {
        scale: (params) => ((params & 0xF) === 4 ? 40 : 75) * 0.0001,
        model: (params) => {
            if ((params & 0x2000) && !(params & 0x800)) return null;
            if (params & 0x8000) {
                return { object: 'gameplay_keep', lists: [{ ...keep(0x1ACF0, 'xlu'), prim: [255, 200, 0, 0], env: [255, 0, 0, 0], primLod: 0xC0 }],
                         segments: { 8: { scroll: [[0, 16, 32], [1, 16, 32]] } } };
            }
            const [prim, env] = EN_LIGHT_COLOURS[params & 0xF];
            return { object: 'gameplay_keep', lists: [{ ...keep(0x7D590, 'xlu'), prim: [...prim, 255], env: [...env, 0], primLod: 0x80 }],
                     segments: { 8: { scroll: [[0, 32, 64], [1, 32, 128]] } } };
        },
    },

    // z_en_mkk.c (Boes), params & 1 black / white: EnMkk_Draw's eyes (prim
    // white), then the body material and model and its end, at the default
    // 0.01 (0.005 is the dying puff); the trailing copies follow its path.
    "En_Mkk": {
        scale: 0.01,
        model: (params) => {
            const [eyes, mat, body, end] = (params & 1) ? [0x310, 0x1F0, 0x278, 0x290] : [0x140, 0x30, 0xB0, 0xC8];
            return { object: 'object_mkk', lists: [
                { ...dl('object_mkk', eyes), prim: [255, 255, 255, 255] },
                dl('object_mkk', mat, 'xlu'), { ...dl('object_mkk', body, 'xlu'), env: [255, 255, 255, 255] }, dl('object_mkk', end, 'xlu'),
            ] };
        },
    },

    // z_bg_umajump.c: BG_UMAJUMP_GET_TYPE (params & 0xFF) 2 is the
    // invisible Epona-jump cutscene trigger; the rest draw the horse-jump
    // fence once they have collision, which type 5 only gets after the
    // aliens are beaten (type 6 until then).
    "Bg_Umajump": {
        model: (params, sceneName, base) => ([2, 5].includes(params & 0xFF) ? null : base),
    },

    // z_en_fz.c (Freezard): its ice body (D_809347BC[0]); the frozen steam
    // is an effect.
    "En_Fz": {
        model: (params, sceneName, base) => ({ ...base, lists: base.lists.slice(0, 1) }),
    },

    // z_dm_opstage.c (the opening cutscene's stage): DMOPSTAGE_GET_TYPE
    // (params & 0xFF) picks the floor or one of the tall trees, opa + xlu.
    // The trees' Matrix_Translate(... MTXMODE_NEW) is just the actor's own
    // position and yaw at 0.1.
    "Dm_Opstage": {
        model: (params) => {
            const pair = [[0x978, 0x970], [0x2878, 0x2870], [0x3068, 0x3060], [0x3728, 0x3720]][params & 0xFF];
            return pair ? { object: 'object_keikoku_demo', lists: [dl('object_keikoku_demo', pair[0]), dl('object_keikoku_demo', pair[1], 'xlu')] } : null;
        },
    },

    // z_en_invadepoh.c (Romani Ranch's invasion), EN_INVADEPOH_GET_TYPE
    // ((params >> 4) & 0xF): the Romanis (gRomaniSkel, her bow on the left
    // hand, eyes open), Cremia on night 3, the dog at 0.007, the aliens (1,
    // 13) as mined without their beam / flash / shadow; 0 is the invisible
    // invasion handler.
    "En_Invadepoh": {
        scale: (params) => (((params >> 4) & 0xF) === 0xA ? 0.007 : 0.01),
        yOffset: (params) => ([1, 0xD].includes((params >> 4) & 0xF) ? 6800 : 0),
        model: (params, sceneName, base) => {
            const type = (params >> 4) & 0xF;
            const flex = (file, offset) => ({ file, offset, type: 'Flex', limbType: 'Standard' });
            if ([4, 5, 7, 8, 9, 0xC].includes(type)) {
                return { object: 'object_ma1', skeleton: flex('object_ma1', 0x13928), anim: { file: 'object_ma1', offset: [5, 8, 9].includes(type) ? 0x9E58 : 0x14088 },
                         segments: { 8: { file: 'object_ma1', offset: 0xFFC8 }, 9: { file: 'object_ma1', offset: 0x127C8 } },
                         limbLists: { 19: [{ ...dl('object_ma1', 0x3B0), add: true }] } };
            }
            if (type === 0xB) {
                return { object: 'object_ma2', skeleton: flex('object_ma2', 0x15C28), anim: { file: 'object_ma2', offset: 0x16720 },
                         segments: { 8: { file: 'object_ma2', offset: 0x11AD8 }, 9: { file: 'object_ma2', offset: 0x14AD8 } } };
            }
            if (type === 0xA) return { object: 'object_dog', skeleton: flex('object_dog', 0x80F0), anim: { file: 'object_dog', offset: 0x21C8 } };
            if (type === 1 || type === 0xD) return { ...base, lists: [], limbLists: {} };
            return null;
        },
    },

    // z_en_ma_yts.c (Romani at the ranch), EN_MA_YTS_GET_TYPE (params >>
    // 12): 2 is her in bed (EnMaYts_DrawSleeping: gRomaniSleepingDL alone),
    // 1 sitting at dinner (gRomaniSittingAnim), else the skeleton idling.
    "En_Ma_Yts": {
        model: (params, sceneName, base) => {
            const type = (params >> 12) & 0xF;
            if (type === 2) return { object: 'object_ma1', lists: [dl('object_ma1', 0x43A0)] };
            return { ...base, lists: [], anim: type === 1 ? { file: 'object_ma1', offset: 0x7D98 } : base.anim };
        },
    },

    // z_en_vm.c (Beamos): just the skeleton; gBeamosLaserDL is its beam.
    "En_Vm": {
        model: (params, sceneName, base) => ({ ...base, lists: [] }),
    },

    // z_en_wiz.c (Wizzrobe): this->scale grows to 0.015 as it appears; the
    // platform light is drawn at the platforms, not on it.
    "En_Wiz": {
        scale: 0.015,
        model: (params, sceneName, base) => ({ ...base, lists: [] }),
    },

    // z_en_okuta.c (Octorok) and z_en_giant.c (the Giants): the skeleton
    // only -- gOctorokProjectileDL is its rock, and the Giant's beard is
    // already drawn on its limb.
    "En_Okuta": {
        model: (params, sceneName, base) => ({ ...base, lists: [] }),
    },
    "En_Giant": {
        model: (params, sceneName, base) => ({ ...base, lists: [] }),
    },

    // z_en_zod.c (Tijo): EnZod_DrawDrums draws the whole kit at its fixed
    // offsets, then the skeleton with eyes open and mouth closed.
    "En_Zod": {
        model: (params, sceneName, base) => {
            const kit = [
                [0xA460, 0, 0, 0], [0xA550, -2690, 6335, 4350], [0xA5E0, 2310, 6703, 3200], [0xA670, 3888, 5735, 1555],
                [0xA700, -4160, 3098, 2874], [0xA8F8, -2200, 3349, 3901], [0xAAF0, -463, 3748, 4722], [0xACE8, 1397, 3718, 4344],
                [0xAEE0, 3413, 2980, 3200], [0xB0D8, 389, 1530, 3373],
            ];
            return { ...base, lists: kit.map(([offset, x, y, z]) => ({ ...dl('object_zod', offset), ops: [['t', x, y, z]] })),
                     segments: { 8: { file: 'object_zod', offset: 0x5E50 }, 9: { file: 'object_zod', offset: 0x7650 } } };
        },
    },

    // z_en_ossan.c: params 0 the Curiosity Shop man (gFsnSkel), 1 the
    // Trading Post's part-timer (gAniSkel), both 0.01 with eyes open.
    "En_Ossan": {
        scale: 0.01,
        model: (params) => {
            const [file, skel, anim, eye] = params === 1 ? ['object_ani', 0x28A0, 0x9D34, 0x6498] : ['object_fsn', 0x13320, 0x12C34, 0x5BC0];
            return { object: file, skeleton: { file, offset: skel, type: 'Flex', limbType: 'Standard' }, anim: { file, offset: anim },
                     segments: { 8: { file, offset: eye } } };
        },
    },

    // z_en_zow.c (Zora in the water): the skeleton; the ripples, bubbles
    // and splashes are effects.
    "En_Zow": {
        model: (params, sceneName, base) => ({ ...base, lists: [] }),
    },

    // z_obj_dhouse.c (Ikana's broken house): ObjDhouse_Draw is DL_005A78;
    // the others are its falling pieces.
    "Obj_Dhouse": {
        model: (params, sceneName, base) => ({ ...base, lists: base.lists.slice(0, 1) }),
    },

    // z_en_encount2.c (Majora balloon): this->scale 0.1, the balloon and
    // its knot; the sparkles are its burst.
    "En_Encount2": {
        scale: 0.1,
        model: (params, sceneName, base) => ({ ...base, lists: base.lists.slice(0, 2), segments: {} }),
    },

    // z_obj_kendo_kanban.c: OBJKENDOKANBAN_GET_BOARD_FRAGMENTS (params &
    // 0xF) 0 is the whole board, else the quarters in its bit set.
    "Obj_Kendo_Kanban": {
        model: (params) => {
            const parts = params & 0xF;
            const lists = parts ? [0x2080, 0x2180, 0x2380, 0x2280].filter((_, i) => parts & (1 << i)).map(o => dl('object_dora', o)) : [dl('object_dora', 0x180)];
            return { object: 'object_dora', lists };
        },
    },

    // z_en_honotrap.c: types 0 and 3 are the silver eye switch at 0.1
    // (gEyeSwitchSilverDL, the eye open in segment 8); the flames are
    // spawned by it.
    "En_Honotrap": {
        scale: 0.1,
        yOffset: 0, // -1000 is the dropping flame's
        model: (params) => ((params === 0 || params === 3)
            ? { object: 'gameplay_dangeon_keep', lists: [dl('gameplay_dangeon_keep', 0x85F0)], segments: { 8: { file: 'gameplay_dangeon_keep', offset: 0xB6C0 } } }
            : null),
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
