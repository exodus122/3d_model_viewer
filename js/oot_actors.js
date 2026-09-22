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
// function of (params, sceneName, minedSpec) returning a model spec to use
// instead of the mined one, or null for a marker), rot (a function of
// (rot, params) returning the shape.rot the actor's Init sets), and
// marker: true to force the marker.
//
// A model spec is { object, skeleton?, anim?, lists?, segments?, limbLists? }
// as generated, with limbLists: { limbIndex: [list refs] } for lists a limb
// callback draws in place of a limb's own (limbIndex as the callback sees
// it, counting from 1).
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

    // z_obj_timeblock.c sSizeOptions[(params >> 8) & 1].scale.
    "Obj_Timeblock": { scale: (params) => (((params >> 8) & 1) ? 0.6 : 1.0) },

    // z_obj_oshihiki.c sScales[params & 0xF].
    "Obj_Oshihiki": { scale: (params) => [1 / 10, 1 / 6, 1 / 5, 1 / 3, 1 / 10, 1 / 6, 1 / 5, 1 / 3][params & 0xF] ?? 0.1 },

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

    // z_en_rr.c EnRr_Init: x/z 0.014, y 0.013.
    "En_Rr": { scale: [0.014, 0.013, 0.014] },

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
    // and container are gHeartPieceExteriorDL over an XLU interior, the
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

    // z_en_sw.c: (params >> 13) & 7 is the type -- 0 a Skullwalltula, 1-3
    // a Gold Skulltula (bit 15 set means "+1", the same three types). Only
    // the gold ones swap the limb lists for the gold body
    // (EnSw_OverrideLimbDraw's switch) and tilt the skeleton back 80
    // degrees / 200 out of the wall in Draw; the mining applies both to
    // every type.
    "En_Sw": {
        model: (params, sceneName, base) => {
            const gold = ((params >> 13) & 7) !== 0 || (params & 0x8000) !== 0;
            return gold ? base : { ...base, skelOps: [], limbLists: null };
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
const RUPEE_TEX = [0x44E50, 0x44E70, 0x44E90, 0x44EB0, 0x44ED0]; // sRupeeTex: green, blue, red, pink, orange
const DROP_TEX = [0x40D80, 0x3F580, 0x3E580, 0x3DD80, 0x3ED80, 0x3F580, 0x42E50, 0x43E50, 0x44650, 0x42650, 0x43650, 0x41E50]; // sItemDropTex
const rupee = (texIndex, scale) => ({ scale, yOffset: 750, model: { object: 'gameplay_keep', lists: [keep(0x45150)], segments: { 8: keepTex(RUPEE_TEX[texIndex]) } } });
const drop = (texIndex, scale, yOffset) => ({ scale, yOffset, model: { object: 'gameplay_keep', lists: [keep(0x41D80)], segments: { 8: keepTex(DROP_TEX[texIndex]) } } });
const ITEM00_TYPES = {
    0x00: rupee(0, 0.015), 0x01: rupee(1, 0.015), 0x02: rupee(2, 0.015),
    0x13: rupee(3, 0.045), 0x14: rupee(4, 0.03),
    // The recovery heart is drawn under Matrix_Scale(16) on top of its 0.02.
    0x03: { scale: 0.32, yOffset: 430, model: { object: 'object_gi_heart', lists: [{ file: 'object_gi_heart', offset: 0xE0, layer: 'xlu' }] } },
    0x04: drop(1, 0.03, 320), 0x05: drop(2, 0.02, 400),
    0x06: { scale: 0.02, yOffset: 650, model: { object: 'gameplay_keep', lists: [keep(0x3C3D0), keep(0x3B860, 'xlu')] } },
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
 * limbs an override callback fills in.
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
        const lists = limbLists?.[index + 1];
        if (lists) {
            for (const ref of lists) items.push({ addr: refAddress(ref), matrix: world, layer: ref.layer ?? 'opa' });
            matrices.push(world);
        } else if (limb.dl) {
            items.push({ addr: limb.dl, matrix: world, layer: 'opa' });
            matrices.push(world);
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

// The lists a spec draws for these params: a { select, variants } entry
// picks variants[(params >> shift) & mask].
function selectLists(lists, params) {
    const out = [];
    for (const l of lists ?? []) {
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
function modelSpec(actorName, base, override, params, sceneName, scale) {
    if (override?.marker) return null;
    let spec = base;
    if (override?.model) spec = override.model(params, sceneName, base);
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
                 spec.anim ? spec.anim.offset : '-', JSON.stringify(spec.skelOps ?? null),
                 lists.map(l => `${l.file}@${l.offset}${l.layer === 'xlu' ? 'x' : ''}${l.ops ? JSON.stringify(l.ops) : ''}${l.prim ?? ''}${l.env ?? ''}`).join(','),
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
            lists[l.layer === 'xlu' ? 'xlu' : 'opa'].push({ addr: refAddress(l), matrix: opsMatrix(l.ops, model.scale), segments: segs, prim: l.prim, env: l.env });
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
    const ctx = {
        sceneSegment: { dv: sceneDv, base: 0, key: sceneName },
        keepFile,
        light: parseZeldaSceneInfo(sceneBuffer).light,
        caches: { textures: new Map(), dataTextures: new Map() },
    };
    modelCache.clear();

    // ---- decode every spawn
    const instances = [];
    setup.rooms.forEach((room, roomIndex) => {
        for (const entry of room.actors) {
            const spawn = decodeActorSpawnEntry(entry, 'OOT');
            const base = OOT_Actor_Models[spawn.actorId] ?? null;
            const name = base?.name ?? `Actor ${hex(spawn.actorId, 3)}`;
            const override = OOT_ACTOR_OVERRIDES[name] ?? null;
            const rot = override?.rot ? override.rot(spawn.rot, spawn.params) : spawn.rot;
            const scale = scaleOf(base, override, spawn.params, sceneName);
            const model = base ? modelSpec(name, base, override, spawn.params, sceneName, scale) : null;
            instances.push({
                actorId: spawn.actorId, name, params: spawn.params, room: roomIndex,
                position: entry.position, rot, rotRaw: spawn.rotRaw,
                scale,
                yOffset: (typeof override?.yOffset === 'function' ? override.yOffset(spawn.params) : override?.yOffset) ?? base?.yOffset ?? 0,
                model,
            });
        }
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
