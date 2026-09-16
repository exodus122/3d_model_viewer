import * as THREE from 'three';
import { addModelCheckbox, getModelGroup, resetGroupModelState } from './render.js';

////////////////////////////////////////
// System: Banjo-Kazooie setup file (object placement)
////////////////////////////////////////
//
// A BK map's setup.bin is a tagged byte stream: every field is prefixed by a
// one-byte indicator and 0x00 ends a section. The layout below mirrors
// gsworld_load() / cubeList_fromFile() / code7AF80_initCubeFromFile() in the
// decomp (src/core2/gsworld.c, gccube.c, code_A5BC0.c).
//
//   0x01                       cube section
//     0x01 s32 min[3]          first cube index on each axis
//          s32 max[3]          last cube index on each axis
//     for each cube, x -> y -> z order:
//       (0x00 s32[6] | 0x02 s32[3])*   unknown, skipped
//       0x03                   cube has props
//         0x0A u8 n  0x0B NodeProp[n]      actor spawns / triggers (20 bytes)
//       | 0x06 u8 n  0x07 OtherNode[n]     alternative node layout (12 bytes)
//         0x08 u8 n  0x09 Prop[n]          sprites + static models (12 bytes)
//       0x01                   end of this cube
//     0x00                     end of cube section
//   0x03 ... camera nodes, 0x04 ... lighting   (not rendered here)
//   0x00                       end of file
//
// A list marker (0x0B / 0x07 / 0x09) is omitted when its count is zero.
//
// Cubes are 1000-unit cells; a prop's cube is floor(position / 1000). Prop
// positions inside are absolute world coordinates, not cube-relative.

// NodeProp.category (enum Prop1Category in code_A5BC0.c)
const NODE_CATEGORY_NAMES = {
    0: 'Unknown 0',
    1: 'Unknown 1',
    2: 'Warp / Trigger',
    3: 'Camera Controller',
    4: 'Unknown 4',
    5: 'Unknown 5',
    6: 'Actor',
    7: 'Enemy Boundary',
    8: 'Path',
    9: 'Camera Trigger',
    10: 'Flag',
};
const NODE_CATEGORY_ACTOR = 6;
// Categories whose selector_or_radius field is a radius around the node.
const NODE_CATEGORIES_WITH_RADIUS = new Set([7, 9, 10]);

const MODEL_ASSET_OFFSET = 0x2D1;
const SPRITE_ASSET_OFFSET = 0x572;

const NODE_PROP_SIZE = 20;
const OTHER_NODE_SIZE = 12;
const PROP_SIZE = 12;

const CUBE_SIZE = 1000;

function actorName(id) {
    return BK_Actor_Names[id] ?? `ACTOR_0x${id.toString(16).toUpperCase()}`;
}

function modelName(modelId) {
    const asset = modelId + MODEL_ASSET_OFFSET;
    return BK_Model_Names[asset] ?? `MODEL_0x${asset.toString(16).toUpperCase()}`;
}

function spriteName(spriteId) {
    const asset = spriteId + SPRITE_ASSET_OFFSET;
    return BK_Sprite_Names[asset] ?? `SPRITE_0x${asset.toString(16).toUpperCase()}`;
}

function hex(v, width = 0) {
    return '0x' + v.toString(16).toUpperCase().padStart(width, '0');
}

////////////////////////////////////////
// Parsing
////////////////////////////////////////

// Mirrors the decomp's File reader: file_isNextByteExpected() is a one-byte
// lookahead that only consumes the byte when it matches.
class SetupReader {
    constructor(buffer) {
        this.dv = new DataView(buffer);
        this.pos = 0;
    }

    get eof() {
        return this.pos >= this.dv.byteLength;
    }

    peek() {
        return this.dv.getUint8(this.pos);
    }

    expect(indicator) {
        if (!this.eof && this.peek() === indicator) {
            this.pos++;
            return true;
        }
        return false;
    }

    u8() { const v = this.dv.getUint8(this.pos); this.pos += 1; return v; }
    s16() { const v = this.dv.getInt16(this.pos, false); this.pos += 2; return v; }
    u16() { const v = this.dv.getUint16(this.pos, false); this.pos += 2; return v; }
    s32() { const v = this.dv.getInt32(this.pos, false); this.pos += 4; return v; }
    u32() { const v = this.dv.getUint32(this.pos, false); this.pos += 4; return v; }

    skip(n) {
        this.pos += n;
    }
}

// NodeProp, 20 bytes (include/prop.h). Bitfields pack from the MSB down.
//   0x00 s16 position[3]
//   0x06 u16 selector_or_radius:9 | category:6 | bit0:1
//   0x08 u16 actorId
//   0x0A u8  markerId, u8 pad
//   0x0C u32 yaw:9 | scale:23
//   0x10 u32 unk10_31:12 | unk10_19:12 | pad:1 | unk10_6:1 | pad:4 | unk10_0:2
function readNodeProp(r, cube) {
    const position = [r.s16(), r.s16(), r.s16()];
    const w6 = r.u16();
    const actorId = r.u16();
    const markerId = r.u8();
    r.u8();
    const wC = r.u32();
    const w10 = r.u32();

    return {
        cube,
        position,
        selectorOrRadius: w6 >>> 7,
        category: (w6 >>> 1) & 0x3F,
        bit0: w6 & 1,
        actorId,
        markerId,
        yaw: wC >>> 23,
        scale: wC & 0x7FFFFF,
        unk10_31: w10 >>> 20,
        unk10_19: (w10 >>> 8) & 0xFFF,
        unk10_0: w10 & 3,
    };
}

// Prop, 12 bytes: a union of SpriteProp / ModelProp / ActorProp told apart by
// the two low bits of the last byte (isModelProp = bit 1, isActorProp = bit 0).
function readProp(r, cube) {
    const start = r.pos;
    const flags = r.dv.getUint8(start + 11);
    const isActorProp = (flags & 1) !== 0;
    const isModelProp = (flags & 2) !== 0;
    const position = [
        r.dv.getInt16(start + 4, false),
        r.dv.getInt16(start + 6, false),
        r.dv.getInt16(start + 8, false),
    ];

    let prop;
    if (isModelProp) {
        // u16 modelId:12 | pad:4, u8 yaw (x2 = degrees), u8 roll, s16 pos[3],
        // u8 scale (/100), u8 flags
        prop = {
            kind: 'model',
            modelId: r.dv.getUint16(start, false) >>> 4,
            yaw: r.dv.getUint8(start + 2) * 2,
            roll: r.dv.getUint8(start + 3),
            scale: r.dv.getUint8(start + 10) / 100,
        };
    } else if (isActorProp) {
        // Runtime-only (marker pointer + position); never expected in a file.
        prop = { kind: 'actor' };
    } else {
        // u32 spriteId:12 | unk:1 | r:3 | g:3 | b:3 | scale:8 | mirrored:1 | pad:1
        const w0 = r.dv.getUint32(start, false);
        prop = {
            kind: 'sprite',
            spriteId: w0 >>> 20,
            rgbRemove: [(w0 >>> 16) & 7, (w0 >>> 13) & 7, (w0 >>> 10) & 7],
            scale: (w0 >>> 2) & 0xFF,
            isMirrored: (w0 >>> 1) & 1,
        };
    }
    prop.cube = cube;
    prop.position = position;
    r.skip(PROP_SIZE);
    return prop;
}

/**
 * Parse a setup.bin's cube section.
 *
 * @returns {{cubeMin:number[], cubeMax:number[], nodes:object[], props:object[], otherNodeCount:number}}
 */
export function parseBKSetup(buffer) {
    const r = new SetupReader(buffer);
    const result = { cubeMin: null, cubeMax: null, nodes: [], props: [], otherNodeCount: 0 };

    if (!r.expect(0x01)) {
        throw new Error(`setup: expected cube section (0x01) at 0, got ${hex(r.peek())}`);
    }
    if (!r.expect(0x01)) {
        throw new Error(`setup: expected cube dimensions (0x01) at ${r.pos}`);
    }
    result.cubeMin = [r.s32(), r.s32(), r.s32()];
    result.cubeMax = [r.s32(), r.s32(), r.s32()];

    const [x0, y0, z0] = result.cubeMin;
    const [x1, y1, z1] = result.cubeMax;

    for (let x = x0; x <= x1; x++) {
        for (let y = y0; y <= y1; y++) {
            for (let z = z0; z <= z1; z++) {
                const cube = [x, y, z];
                while (!r.expect(0x01)) {
                    if (r.expect(0x00)) {
                        r.skip(24);
                    } else if (r.expect(0x02)) {
                        r.skip(12);
                    } else if (r.expect(0x03)) {
                        if (r.expect(0x0A)) {
                            const n = r.u8();
                            if (!r.expect(0x0B) && n !== 0) {
                                throw new Error(`setup: expected node list (0x0B) at ${r.pos}`);
                            }
                            for (let i = 0; i < n; i++) result.nodes.push(readNodeProp(r, cube));
                        } else if (r.expect(0x06)) {
                            const n = r.u8();
                            if (!r.expect(0x07) && n !== 0) {
                                throw new Error(`setup: expected other-node list (0x07) at ${r.pos}`);
                            }
                            r.skip(n * OTHER_NODE_SIZE);
                            result.otherNodeCount += n;
                        }
                        if (r.expect(0x08)) {
                            const n = r.u8();
                            if (!r.expect(0x09) && n !== 0) {
                                throw new Error(`setup: expected prop list (0x09) at ${r.pos}`);
                            }
                            for (let i = 0; i < n; i++) result.props.push(readProp(r, cube));
                        }
                    } else {
                        throw new Error(`setup: unexpected byte ${hex(r.peek())} at ${r.pos} in cube ${cube}`);
                    }
                }
            }
        }
    }

    if (!r.expect(0x00)) {
        console.warn(`setup: cube section did not end with 0x00 at ${r.pos}`);
    }

    return result;
}

////////////////////////////////////////
// Rendering
////////////////////////////////////////

const ACTOR_COLOR = '#ff7b24';
const NODE_COLOR = '#ffd23a';
const MODEL_COLOR = '#c77dff';
const SPRITE_COLOR = '#3aff78';

const ACTOR_MARKER_RADIUS = 40;
const NODE_MARKER_RADIUS = 25;
const MODEL_MARKER_SIZE = 60;
const SPRITE_MARKER_RADIUS = 20;

// Shared geometries; each instance mesh clones nothing but the transform.
const actorGeometry = new THREE.OctahedronGeometry(ACTOR_MARKER_RADIUS, 0);
const nodeGeometry = new THREE.TetrahedronGeometry(NODE_MARKER_RADIUS, 0);
const modelGeometry = new THREE.BoxGeometry(MODEL_MARKER_SIZE, MODEL_MARKER_SIZE, MODEL_MARKER_SIZE);
const spriteGeometry = new THREE.OctahedronGeometry(SPRITE_MARKER_RADIUS, 0);
const radiusGeometry = new THREE.SphereGeometry(1, 12, 8);

function makeMaterial(color) {
    return new THREE.MeshLambertMaterial({ color, side: THREE.FrontSide, flatShading: true });
}

// A short line from the marker's centre along its yaw, so facing is visible.
function makeYawLine(length, material) {
    const geom = new THREE.BufferGeometry().setFromPoints([
        new THREE.Vector3(0, 0, 0),
        new THREE.Vector3(0, 0, length),
    ]);
    return new THREE.Line(geom, material);
}

function describeNode(node) {
    const cat = NODE_CATEGORY_NAMES[node.category] ?? `Category ${node.category}`;
    const what = node.category === NODE_CATEGORY_ACTOR
        ? `ACTOR ${actorName(node.actorId)} (${hex(node.actorId)})`
        : `NODE ${cat} id=${hex(node.actorId)}`;
    return `${what}: pos=${node.position.join(', ')} yaw=${node.yaw} scale=${node.scale / 100}` +
        ` ${NODE_CATEGORIES_WITH_RADIUS.has(node.category) ? 'radius' : 'selector'}=${node.selectorOrRadius}` +
        ` marker=${node.markerId} unk10=${hex(node.unk10_31)},${hex(node.unk10_19)}` +
        ` cube=${node.cube.join(',')}`;
}

function describeProp(prop) {
    if (prop.kind === 'model') {
        return `MODEL ${modelName(prop.modelId)} (${hex(prop.modelId + MODEL_ASSET_OFFSET)}):` +
            ` pos=${prop.position.join(', ')} yaw=${prop.yaw} roll=${prop.roll} scale=${prop.scale}` +
            ` cube=${prop.cube.join(',')}`;
    }
    return `SPRITE ${spriteName(prop.spriteId)} (${hex(prop.spriteId + SPRITE_ASSET_OFFSET)}):` +
        ` pos=${prop.position.join(', ')} scale=${prop.scale} mirrored=${prop.isMirrored}` +
        ` rgbRemove=${prop.rgbRemove.join(',')} cube=${prop.cube.join(',')}`;
}

/**
 * Group entries by a key, keeping first-seen order.
 */
function groupBy(list, keyFn) {
    const map = new Map();
    for (const item of list) {
        const key = keyFn(item);
        if (!map.has(key)) map.set(key, []);
        map.get(key).push(item);
    }
    return map;
}

/**
 * Build one sidebar row (and its scene group) for a set of same-typed
 * instances. Every instance shares the row's material so the swatch recolours
 * all of them together.
 */
function addTypeRow(scene, groupBody, rowName, instances, color, checked, buildInstance) {
    const material = makeMaterial(color);
    const lineMaterial = new THREE.LineBasicMaterial({ color });
    const typeGroup = new THREE.Group();
    typeGroup.name = rowName;

    for (const inst of instances) {
        const obj = buildInstance(inst, material, lineMaterial);
        obj.position.set(inst.position[0], inst.position[1], inst.position[2]);
        typeGroup.add(obj);
    }

    scene.add(typeGroup);
    loadedModels.push({ name: rowName, root: typeGroup, mesh: typeGroup, edges: null });
    addModelCheckbox(scene, rowName, typeGroup, null, false, checked, color, false, null, groupBody);
    return typeGroup;
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

    if (NODE_CATEGORIES_WITH_RADIUS.has(node.category) && node.selectorOrRadius > 0) {
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
    mesh.rotation.y = THREE.MathUtils.degToRad(prop.yaw);
    mesh.rotation.z = THREE.MathUtils.degToRad(prop.roll);
    mesh.add(makeYawLine(MODEL_MARKER_SIZE, lineMaterial));
    mesh.userData.bkInfo = describeProp(prop);
    mesh.userData.bkProp = prop;
    return mesh;
}

function buildSpriteInstance(prop, material) {
    const mesh = new THREE.Mesh(spriteGeometry, material);
    mesh.userData.bkInfo = describeProp(prop);
    mesh.userData.bkProp = prop;
    return mesh;
}

/**
 * Parse a setup.bin and add its placements to the scene as marker meshes,
 * one collapsible sidebar group per kind and one row per actor / model /
 * sprite type. Assumes the map's geometry has already been loaded (this does
 * not clear the scene).
 */
export function renderBKSetup(scene, buffer) {
    const setup = parseBKSetup(buffer);

    // Visibility is remembered per row name across loads; the same actor
    // type unchecked in one map should not start hidden in the next.
    for (const key of ['bk-actors', 'bk-models', 'bk-sprites', 'bk-nodes']) {
        resetGroupModelState(key);
    }

    // The game only spawns nodes with bit0 clear; the ones with it set carry a
    // different (undocumented) payload, so they are counted but not drawn.
    const spawnNodes = setup.nodes.filter(n => !n.bit0);
    const skippedNodes = setup.nodes.length - spawnNodes.length;

    const actorNodes = spawnNodes.filter(n => n.category === NODE_CATEGORY_ACTOR);
    const otherNodes = spawnNodes.filter(n => n.category !== NODE_CATEGORY_ACTOR);
    const modelProps = setup.props.filter(p => p.kind === 'model');
    const spriteProps = setup.props.filter(p => p.kind === 'sprite');

    // Rows are sorted by name so the same map always lists in the same order.
    const rowLabel = (name, list) => list.length > 1 ? `${name} (x${list.length})` : name;

    if (actorNodes.length) {
        const group = getModelGroup('bk-actors', 'Actors');
        const byType = groupBy(actorNodes, n => n.actorId);
        for (const [id, list] of [...byType].sort((a, b) => actorName(a[0]).localeCompare(actorName(b[0])))) {
            addTypeRow(scene, group.body, rowLabel(actorName(id), list), list, ACTOR_COLOR, true, buildActorInstance);
        }
    }

    if (modelProps.length) {
        const group = getModelGroup('bk-models', 'Model Props');
        const byType = groupBy(modelProps, p => p.modelId);
        for (const [id, list] of [...byType].sort((a, b) => modelName(a[0]).localeCompare(modelName(b[0])))) {
            addTypeRow(scene, group.body, rowLabel(modelName(id), list), list, MODEL_COLOR, true, buildModelInstance);
        }
    }

    if (spriteProps.length) {
        const group = getModelGroup('bk-sprites', 'Sprite Props');
        const byType = groupBy(spriteProps, p => p.spriteId);
        for (const [id, list] of [...byType].sort((a, b) => spriteName(a[0]).localeCompare(spriteName(b[0])))) {
            addTypeRow(scene, group.body, rowLabel(spriteName(id), list), list, SPRITE_COLOR, false, buildSpriteInstance);
        }
    }

    if (otherNodes.length) {
        const group = getModelGroup('bk-nodes', 'Other Setup Nodes');
        const byType = groupBy(otherNodes, n => n.category);
        for (const [cat, list] of [...byType].sort((a, b) => a[0] - b[0])) {
            const name = NODE_CATEGORY_NAMES[cat] ?? `Category ${cat}`;
            addTypeRow(scene, group.body, rowLabel(name, list), list, NODE_COLOR, false, buildNodeInstance);
        }
    }

    console.log(`BK setup: cubes ${setup.cubeMin} .. ${setup.cubeMax},`,
        `${actorNodes.length} actors, ${otherNodes.length} other nodes, ${skippedNodes} skipped nodes,`,
        `${modelProps.length} model props, ${spriteProps.length} sprite props, ${setup.otherNodeCount} OtherNodes`);

    return setup;
}
