import * as THREE from 'three';
import { getModelGroup, resetGroupModelState, applyGroupMasterState } from './render.js';
import {
    resetSetupState, loadPropGeometry, addTypeRow, addLoadedModelRow, groupBy, makeYawLine,
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

function actorName(id) {
    const ovl = BT_Actor_Overlays[id];
    const model = BT_Actor_Models[id];
    const modelName = model ? BT_Asset_Names[model]?.replace(/^Model: /, '') : null;
    if (modelName) return `${modelName} (${hex(id)}, ${ovl ?? 'core'})`;
    return ovl ? `${ovl} (${hex(id)})` : `ACTOR ${hex(id)}`;
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
//   u8 markerId; u8 pad; u32 yaw:9 | scale:23; u32 unk10
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
    const model = node.extraModel ? node.extraModel.asset : BT_Actor_Models[node.actorId];
    const what = node.category === NODE_CATEGORY_ACTOR
        ? `ACTOR ${actorName(node.actorId)}` +
          (node.extraModel ? ` ${node.extraModel.label}` : '') +
          (model ? ` model ${hex(model)}${node.geometrySource ? ' ' + node.geometrySource : ''}` : '')
        : `NODE ${cat} id=${hex(node.actorId)}`;
    return `${what}: pos=${node.position.join(', ')} yaw=${node.yaw} scale=${node.scale / 100}` +
        ` selector/radius=${node.selectorOrRadius} marker=${node.markerId} bit0=${node.bit0} unk10=${hex(node.unk10, 8)}`;
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
    const s = THREE.MathUtils.clamp(node.scale === 0 ? 1 : node.scale / 100, 0.25, 4);
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
// degrees and scale / 100 (0 = 1). NodeProp.selector_or_radius picks the
// selector-gated variant for models that have one, as it does in BK.
const ACTOR_STYLE = {
    color: ACTOR_COLOR,
    edgeColor: 0x8a3d10,
    describe: describeNode,
    fallback: buildActorInstance,
    selectorOf: node => node.selectorOrRadius,
    appendagesOf: node => BT_ACTOR_APPENDAGES[node.actorId] ?? null,
    transform(node, obj) {
        obj.position.set(node.position[0], node.position[1], node.position[2]);
        obj.rotation.set(0, THREE.MathUtils.degToRad(node.yaw), 0, 'YXZ');
        obj.scale.setScalar(node.scale === 0 ? 1 : node.scale / 100);
    },
};

const GROUP_KEYS = ['bt-models', 'bt-actors', 'bt-actors-hitbox', 'bt-nodes'];

export async function renderBTSetup(scene, buffer, mapId = -1) {
    const setup = parseBTSetup(buffer);
    resetSetupState();
    for (const key of GROUP_KEYS) resetGroupModelState(key);

    if (setup.legacy) {
        console.log(`BT setup ${hex(mapId)}: BK-style cube layout (beta map), objects not parsed`);
        return setup;
    }

    const actorNodes = setup.nodes.filter(n => n.category === NODE_CATEGORY_ACTOR);
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
        const byType = [...groupBy(actorNodes, n => n.actorId)]
            .sort((a, b) => actorName(a[0]).localeCompare(actorName(b[0])));
        // One row per actor type, plus one per extra model it draws
        // (BT_ACTOR_EXTRA_MODELS) over copies of its nodes, so each row keeps
        // its own geometry source and description.
        const rows = byType.flatMap(([id, list]) => [
            { name: actorName(id), asset: BT_Actor_Models[id], list },
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
