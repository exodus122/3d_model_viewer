import * as THREE from 'three';
import { addModelCheckbox, getModelGroup, resetGroupModelState, applyGroupMasterState } from './render.js';
import { parseBKModelGeometry } from './bk_model.js';
import { buildTexturedParts, makeTexturedMesh, attachTextured, refreshTexturedMode, isPropCollisionShown } from './bk_textured.js';

const wireframeCheckbox = document.getElementById('wireframe');
const viewModeSelect = document.getElementById('bkViewMode');
const actorHitboxCheckboxes = {
    enemy: document.getElementById('bkActorHitboxesEnemy'),
    touch: document.getElementById('bkActorHitboxesTouch'),
};

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
    const name = BK_Actor_Names[id];
    if (!name) return `ACTOR_0x${id.toString(16).toUpperCase()}`;
    // The decomp names several unidentified actors plain "UNKNOWN"; rows are
    // keyed by name, so keep those distinguishable.
    return name.endsWith('UNKNOWN') ? `${name} (0x${id.toString(16).toUpperCase()})` : name;
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
        // u16 modelId:12 | pad:4, u8 yaw (x2 = degrees), u8 roll (x2 = degrees),
        // s16 pos[3], u8 scale (/100), u8 flags
        prop = {
            kind: 'model',
            modelId: r.dv.getUint16(start, false) >>> 4,
            yaw: r.dv.getUint8(start + 2) * 2,
            roll: r.dv.getUint8(start + 3) * 2,
            scale: r.dv.getUint8(start + 10) / 100,
        };
    } else if (isActorProp) {
        // Runtime-only (marker pointer + position); never expected in a file.
        prop = { kind: 'actor' };
    } else {
        // u32 spriteId:12 | unk:1 | r:3 | g:3 | b:3 | scale:8 (/100) | mirrored:1 | pad:1
        // s16 pos[3], u16 frame:5 | unk:5 | ... (see SpriteProp in prop.h)
        const w0 = r.dv.getUint32(start, false);
        prop = {
            kind: 'sprite',
            spriteId: w0 >>> 20,
            rgbRemove: [(w0 >>> 16) & 7, (w0 >>> 13) & 7, (w0 >>> 10) & 7],
            scale: ((w0 >>> 2) & 0xFF) / 100,
            isMirrored: (w0 >>> 1) & 1,
            frame: r.dv.getUint16(start + 10, false) >>> 11,
            phase: (r.dv.getUint16(start + 10, false) >>> 6) & 0x1F, // unk8_10: animation phase offset
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
// Prop model geometry
////////////////////////////////////////
//
// Prop models are extracted by banjo-kazooie/tools/extract_models.py into
// models/BK/props/<asset id>.model.bin. A model is fetched and decoded once
// per session; every placement of it is a Mesh sharing that geometry.
//
// Each model yields up to two triangle sets sharing one vertex buffer:
//   visual    - what the game draws (decoded from the F3DEX display lists)
//   collision - the collision list, which for many props is just a small
//               hitbox (an icicle is 3 triangles), but is what gameplay uses
// The "View" dropdown picks which one is shown (bk_textured.js); a model
// missing the chosen set falls back to the other, and a model that can't be
// loaded at all falls back to the marker cube. In the textured views the
// visual set is replaced by the textured mesh, and the collision set is
// drawn on top of it.

const PROP_MODEL_DIR = './models/BK/props/';
const propGeometryCache = new Map(); // asset id -> Promise<{visual, collision} | null>

// Every prop mesh / edge object currently in the scene, so the selector can
// swap their geometry in place without reloading the map.
const propInstances = [];

function makeGeometrySet(positions, indices) {
    if (!indices || indices.length === 0) return null;
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setIndex(new THREE.BufferAttribute(indices, 1));
    return { geometry, edges: new THREE.WireframeGeometry(geometry) };
}

function pickGeometry(loaded) {
    const want = isPropCollisionShown() ? 'collision' : 'visual';
    const other = want === 'collision' ? 'visual' : 'collision';
    if (loaded[want]) return { set: loaded[want], source: want };
    if (loaded[other]) return { set: loaded[other], source: other };
    return null;
}

viewModeSelect?.addEventListener('change', () => {
    for (const inst of propInstances) {
        const picked = pickGeometry(inst.loaded);
        if (!picked) continue;
        inst.mesh.geometry = picked.set.geometry;
        inst.edges.geometry = picked.set.edges;
        inst.prop.geometrySource = picked.source;
        inst.mesh.userData.bkInfo = inst.describe(inst.prop);
    }
    // Re-apply with the new geometry in place (bk_textured.js's own listener
    // ran before the swap).
    refreshTexturedMode();
});

function loadPropGeometry(assetId) {
    if (propGeometryCache.has(assetId)) {
        return propGeometryCache.get(assetId);
    }

    const file = assetId.toString(16).toUpperCase().padStart(4, '0') + '.model.bin';
    const promise = fetch(PROP_MODEL_DIR + file)
        .then(res => {
            if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
            return res.arrayBuffer();
        })
        .then(buffer => {
            const model = parseBKModelGeometry(buffer);
            const loaded = {
                visual: makeGeometrySet(model.positions, model.displayListIndices),
                collision: makeGeometrySet(model.positions, model.collisionIndices),
                bounds: model.bounds,
                refPoints: model.refPoints,
                texturedVariants: new Map(),
                // Textured geometry depends on which selector-gated variant an
                // instance shows, so it is built per selector value on demand.
                texturedFor(selector) {
                    if (!this.texturedVariants.has(selector)) {
                        let parts = null;
                        try {
                            parts = buildTexturedParts(buffer, selector);
                        } catch (err) {
                            console.warn(`prop model ${file}: textured build failed: ${err.message}`);
                        }
                        this.texturedVariants.set(selector, parts);
                    }
                    return this.texturedVariants.get(selector);
                },
            };
            if (!loaded.visual && !loaded.collision) {
                console.warn(`prop model ${file}: no triangles`);
                return null;
            }
            return loaded;
        })
        .catch(err => {
            console.warn(`prop model ${file}: ${err.message}; drawing a marker instead`);
            return null;
        });

    propGeometryCache.set(assetId, promise);
    return promise;
}

////////////////////////////////////////
// Sprite images
////////////////////////////////////////
//
// Sprites are extracted by banjo-kazooie/tools/extract_sprites.py into
// models/BK/sprites/<asset>_<frame>.png plus sprites.json, which records each
// sprite's world size (BKSprite.unk8/unkA) and each frame's pixel size and
// anchor (BKSpriteFrame.unk0/unk2). The game draws a sprite as a camera-facing
// quad world_w x world_h units across, with the prop's position at the anchor
// pixel (spriteRender_drawWithSegment) -- which is exactly a THREE.Sprite with
// its `center` set from the anchor.

const SPRITE_DIR = './models/BK/sprites/';
let spriteIndexPromise = null;   // Promise<Map<asset id, entry>>
const spriteTextureCache = new Map(); // file -> THREE.Texture
const textureLoader = new THREE.TextureLoader();

function loadSpriteIndex() {
    if (!spriteIndexPromise) {
        spriteIndexPromise = fetch(SPRITE_DIR + 'sprites.json')
            .then(res => {
                if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
                return res.json();
            })
            .then(list => new Map(list.map(e => [e.asset_id, e])))
            .catch(err => {
                console.warn(`sprites.json: ${err.message}; sprite props will be markers`);
                return new Map();
            });
    }
    return spriteIndexPromise;
}

// The game mirrors a sprite by drawing its quad with a negative X scale.
// THREE.Sprite can't do that (its shader uses the LENGTH of the model
// matrix's X column, so the sign is lost), so a mirrored frame is a second
// texture with the UVs flipped horizontally instead.
function spriteTexture(file, mirrored = false) {
    const key = mirrored ? file + '|mirrored' : file;
    let tex = spriteTextureCache.get(key);
    if (!tex) {
        tex = mirrored ? spriteTexture(file).clone() : textureLoader.load(SPRITE_DIR + file);
        // N64 point sampling; these are tiny and would smear otherwise.
        tex.magFilter = THREE.NearestFilter;
        tex.minFilter = THREE.NearestFilter;
        tex.colorSpace = THREE.SRGBColorSpace;
        if (mirrored) {
            tex.repeat.x = -1;
            tex.offset.x = 1;
            tex.needsUpdate = true;
        }
        spriteTextureCache.set(key, tex);
    }
    return tex;
}

// Place a frame on a sprite: the anchor pixel sits on the position. Sprite.center
// is in [0,1] with y up while the anchor is in pixels with y down, and a mirrored
// frame's anchor is measured from the other edge.
function setSpriteFrame(sprite, material, frame, mirrored) {
    sprite.material = material;
    sprite.center.set(mirrored ? 1 - frame.anchor_x / frame.w : frame.anchor_x / frame.w,
        1 - frame.anchor_y / frame.h);
}

// Animation
//
// Port of func_8032CD60 (code_A5BC0.c), which the game runs on every sprite
// prop each frame. The sprite header gives ticks-per-frame, a cycle mode and
// how mirroring is decided; the prop contributes a 5-bit phase offset and its
// own mirror bit, which the game overwrites with the computed one each tick
// (so it carries state between ticks -- `state.mirrored` below).
//
//   mode 0     static
//   mode 1, 2  ping-pong over the frames (period (n-1)*2)
//   mode 3     plain loop (period n)
//   mode 4     loop where the second half is drawn mirrored (period n*2)
//
// The game's tick is one 30 Hz frame (gGlobalTimer).
const GAME_TICK_MS = 1000 / 30;

export function spriteAnimationStep(anim, frameCount, prop, state, tick) {
    const n = frameCount;
    const mode = anim.mode;
    const dur = Math.max(1, anim.ticks_per_frame);
    const pingPong = mode === 1 || mode === 2;
    const period = mode === 3 ? n : (n - (pingPong ? 1 : 0)) * 2;
    if (period <= 0) return;

    const phase = Math.floor((prop.phase * period) / 32);
    let v = (Math.floor((tick % (period * dur)) / dur) + phase) % period;
    let secondHalf = false;

    let mirror;
    switch (anim.mirror_mode) {
        case 1: mirror = (prop.phase & 2) ? 1 : 0; break;
        case 2: mirror = 1; break;
        case 3: mirror = state.mirrored; break;
        default: mirror = 0; break;
    }

    let flip;
    switch (mode) {
        case 4:
            secondHalf = n <= v;
            // fall through
        case 1:
            flip = n <= v ? 1 : 0;
            break;
        case 2:
            secondHalf = n <= v;
            // fall through
        default:
            switch (anim.flip_mode) {
                case 1: flip = prop.phase & 1; break;
                case 2: flip = 1; break;
                default: flip = state.mirrored; break;
            }
            break;
    }

    if (flip ^ mirror ^ (secondHalf ? 1 : 0)) v = period - v;
    v += pingPong ? mirror : -mirror;
    v = v < 0 ? v + n : v % n;

    state.frame = v;
    state.mirrored = flip;
}

// Every animated sprite in the scene: { sprite, prop, entry, state, materialFor }
const animatedSprites = [];
let lastAnimTick = -1;

function animateSprites() {
    requestAnimationFrame(animateSprites);
    if (!animatedSprites.length) return;
    const tick = Math.floor(performance.now() / GAME_TICK_MS);
    if (tick === lastAnimTick) return;
    lastAnimTick = tick;

    for (const a of animatedSprites) {
        if (!a.sprite.visible) continue;
        spriteAnimationStep(a.entry.anim, a.entry.frames.length, a.prop, a.state, tick);
        const frame = a.entry.frames[Math.min(a.state.frame, a.entry.frames.length - 1)];
        setSpriteFrame(a.sprite, a.materialFor(a.state.frame, a.state.mirrored), frame, a.state.mirrored);
    }
}
animateSprites();

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
    const model = node.modelAsset ?? BK_Actor_Models[node.actorId];
    const what = node.category === NODE_CATEGORY_ACTOR
        ? `ACTOR ${actorName(node.actorId)} (${hex(node.actorId)}` +
          (model ? `, model ${hex(model)}${node.geometrySource ? ' ' + node.geometrySource : ''}` : '') + ')'
        : `NODE ${cat} id=${hex(node.actorId)}`;
    return `${what}: pos=${node.position.join(', ')} yaw=${node.yaw} scale=${node.scale / 100}` +
        ` ${NODE_CATEGORIES_WITH_RADIUS.has(node.category) ? 'radius' : 'selector'}=${node.selectorOrRadius}` +
        ` marker=${node.markerId} unk10=${hex(node.unk10_31)},${hex(node.unk10_19)}` +
        ` cube=${node.cube.join(',')}` +
        (node.override ? ` [runtime placement; setup pos=${node.setup.position.join(', ')} yaw=${node.setup.yaw} scale=${node.setup.scale / 100} -- ${node.override.source}]` : '');
}

function describeProp(prop) {
    if (prop.kind === 'model') {
        return `MODEL ${modelName(prop.modelId)} (${hex(prop.modelId + MODEL_ASSET_OFFSET)}${prop.geometrySource ? ', ' + prop.geometrySource : ''}):` +
            ` pos=${prop.position.join(', ')} yaw=${prop.yaw} roll=${prop.roll} scale=${prop.scale}` +
            ` cube=${prop.cube.join(',')}`;
    }
    return `SPRITE ${spriteName(prop.spriteId)} (${hex(prop.spriteId + SPRITE_ASSET_OFFSET)}):` +
        ` pos=${prop.position.join(', ')} scale=${prop.scale} frame=${prop.frame} mirrored=${prop.isMirrored}` +
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

// How each kind of placement maps onto a loaded model. `transform` applies
// the game's own placement matrix; `fallback` draws the marker used when the
// model could not be loaded (or the actor has no model at all).
const MODEL_PROP_STYLE = {
    color: MODEL_COLOR,
    edgeColor: 0x5a2d8a,
    describe: describeProp,
    fallback: buildModelInstance,
    // propModelList_drawModel: rotation = [0, yaw*2, roll*2] degrees, scale/100.
    // The game builds the matrix as yaw, then pitch, then roll (mlMtxRotatePYR),
    // which is Three's 'YXZ' order.
    transform(prop, obj) {
        obj.position.set(prop.position[0], prop.position[1], prop.position[2]);
        obj.rotation.set(0, THREE.MathUtils.degToRad(prop.yaw), THREE.MathUtils.degToRad(prop.roll), 'YXZ');
        obj.scale.setScalar(prop.scale || 1);
    },
};

// Objects a level overlay draws itself rather than spawning from the setup
// file, so they appear in no NodeProp list. Keyed by map id; positions and
// models are the ones hard-coded in the decomp.
const BK_MAP_OBJECTS = {
    0x0B: [ // CC_CLANKERS_CAVERN
        { name: 'CLANKER', asset: 0x88E, position: [5500, 0, 0], yaw: 0, scale: 1,
          source: 'src/CC/ma/clanker.c (maClanker init; y changes when raised)' },
    ],
};

// Actors whose update function throws away the NodeProp position (and
// sometimes rotation, scale or model) on its first tick and places them
// itself, so the setup file's coordinates are placeholders. Keyed by map id
// then actor id; values are what a fresh save file ends up with. A position
// is one of:
//   [x, y, z]                        world coordinates
//   { object, refPoint }             a ref point (REFPOINT geo command, rest
//                                    pose) of a BK_MAP_OBJECTS model, offset
//                                    by that object's position
//   { offset: [dx, dy, dz] }         relative to the setup position
//   { nearestActor: id }             the position of the closest node with
//                                    that actor id (actorArray_findClosest...)
//   node => [x, y, z]                computed from the setup node
const BK_ACTOR_OVERRIDES = {
    0x07: { // TTC_TREASURE_TROVE_COVE
        // Sharkfood Island slides 41.2% of the way to (8831, 13535), faces
        // yaw 199 and sits underwater until the pink SNS egg code is entered.
        0x25C: { position: n => [n.position[0] + 0.412 * (8831 - n.position[0]), -1000, n.position[2] + 0.412 * (13535 - n.position[2])], yaw: 199,
                 source: 'src/TTC/code_26D0.c: __code26D0_sharkfoodIslandUpdateFunc; y = 700 once raised' },
    },
    0x0B: { // CC_CLANKERS_CAVERN
        0x43: { position: { object: 'CLANKER', refPoint: 5 },
                source: 'src/CC/ch/clankerscrew.c: lower idle position = Clanker ref point 5 (func_80388B4C)' },
        0x44: { position: { object: 'CLANKER', refPoint: 7 }, yaw: 0,
                source: 'src/CC/ch/clankertoothext.c: position = Clanker ref point 7 (func_80388B78), rotation 0 while upright' },
        0x45: { position: { object: 'CLANKER', refPoint: 9 }, yaw: 0,
                source: 'src/CC/ch/clankertoothext.c: position = Clanker ref point 9 (func_80388BBC), rotation 0 while upright' },
        0x3C: { position: [5700, -2620, -20],
                source: 'src/CC/ch/clankerkey.c: maClankerKey_update sets position on init' },
    },
    0x12: { // GV_GOBIS_VALLEY
        0x31D: { position: [67, 1375, 400],
                 source: 'src/GV/ch/buriedpyramid.c: y = raised_state / 3 * 1050 + 1375 (raised_state 0 on a fresh file)' },
        0x1F5: { position: { offset: [0, -300, 0] }, scale: 1.35,
                 source: 'src/GV/gvspawnqueue.c func_8038E97C: scale 1.35, sunk 300 until the pyramid is fully raised' },
        0x130: { position: { nearestActor: 0x12E },
                 source: 'src/GV/ch/gobirock.c: snaps to the nearest GOBI_1' },
        0x12F: { position: { nearestActor: 0x12E },
                 source: 'src/GV/ch/gobirope.c: snaps to the nearest GOBI_1' },
    },
    0x1A: { // GV_INSIDE_JINXY
        0x119: { yaw: 90, source: 'src/GV/code_43B0.c: magic carpet yaw forced to 90 every frame' },
    },
    0x22: { // CC_INSIDE_CLANKER
        // chTooth_update: position = D_80389B50[].position * 1.25; the model
        // is the closed variant until the tooth's level flag is set.
        0x101: { position: [522.9976 * 1.25, 1135.8192 * 1.25, 5503.4833 * 1.25], asset: 0x892,
                 source: 'src/CC/ch/tooth.c: D_80389B50[0].position * 1.25, closed model until LEVEL_FLAG_0 set' },
        0x102: { position: [-713.4896 * 1.25, 1135.8192 * 1.25, 5152.913 * 1.25], asset: 0x894,
                 source: 'src/CC/ch/tooth.c: D_80389B50[1].position * 1.25, closed model until LEVEL_FLAG_1 set' },
    },
    0x31: { // RBB_RUSTY_BUCKET_BAY
        0x1C9: { position: [-5100, -2600, 1460], yaw: 0, source: 'src/RBB/ch/anchor.c: chAnchor_update init' },
        0x1C8: { position: [-5100, -2600, 1460], yaw: 0, source: 'src/RBB/ch/dolphin.c: chSnorkel_update init' },
        0x1C2: { position: [-3720, 800, -350], yaw: -90, scale: 0.25, source: 'src/RBB/ch/whistle.c: chRBBWhistleInfo[0]' },
        0x1C3: { position: [-3720, 800, 0], yaw: -90, scale: 0.25, source: 'src/RBB/ch/whistle.c: chRBBWhistleInfo[1]' },
        0x1C4: { position: [-3720, 800, 350], yaw: -90, scale: 0.25, source: 'src/RBB/ch/whistle.c: chRBBWhistleInfo[2]' },
        0x1BF: { position: [-3950, 690, -350], yaw: -90, source: 'src/RBB/ch/whistleswitch.c: chWhistleSwitchTable[0]' },
        0x1C0: { position: [-3950, 690, 0], yaw: -90, source: 'src/RBB/ch/whistleswitch.c: chWhistleSwitchTable[1]' },
        0x1C1: { position: [-3950, 690, 350], yaw: -90, source: 'src/RBB/ch/whistleswitch.c: chWhistleSwitchTable[2]' },
        // secondaryId (NodeProp.unk10_31) 0x1C is the +z propeller.
        0x175: { position: n => [7625.5, -1950, n.unk10_31 === 0x1C ? 300 : -300],
                 source: 'src/RBB/ch/propellor.c: z = +300 for secondaryId 0x1C, else -300' },
    },
    0x34: { // RBB_ENGINE_ROOM
        0x178: { position: [0, -60, 2450], source: 'src/RBB/ch/axle.c: chSpinningFlatPlatformTable[0]' },
        0x179: { position: [-1600, 730, -700], source: 'src/RBB/ch/axle.c: chSpinningFlatPlatformTable[1] (roll 270)' },
        0x17A: { position: [1600, 730, -700], source: 'src/RBB/ch/axle.c: chSpinningFlatPlatformTable[2] (roll 270)' },
        0x1BB: { position: [0, 641.45, -1400], source: 'src/RBB/ch/enginefan.c: D_80390530[0]' },
        0x1BC: { position: [-800, 641.45, -2400], source: 'src/RBB/ch/enginefan.c: D_80390530[1]' },
        0x1BD: { position: [800, 641.45, -2400], source: 'src/RBB/ch/enginefan.c: D_80390530[2]' },
        0x177: { position: [1600, 641.5, -2700], source: 'src/RBB/ch/engineparts.c: D_80390760[0]' },
        0x17E: { position: [-1600, 641.5, -2700], source: 'src/RBB/ch/engineparts.c: D_80390760[1]' },
        0x17F: { position: [300, 641.5, -400], source: 'src/RBB/ch/engineparts.c: D_80390760[2]' },
        0x180: { position: [-300, 641.5, -400], source: 'src/RBB/ch/engineparts.c: D_80390760[3]' },
        0x17B: { position: [0, -50, 700], source: 'src/RBB/ch/cog.c: small cog init' },
        0x17C: { position: [0, -50, 500], source: 'src/RBB/ch/cog.c: medium cog init' },
        0x17D: { position: [0, -50, 300], source: 'src/RBB/ch/cog.c: large cog init' },
        // secondaryId 2 is the +x switch (D_80390720[0]), anything else -x.
        0x176: { position: n => [n.unk10_31 === 2 ? 1600 : -1600, 804, -2400],
                 source: 'src/RBB/ch/propellorswitch.c: D_80390720[secondaryId == 2 ? 0 : 1]' },
        0x1BE: { position: [-3209.95, 1164.5, -2649.95], yaw: -90, source: 'src/RBB/ch/enginefanswitch.c: chEngineFanSwitch_update init' },
    },
    // CCW: Eyrie's nest and Gnawty's furniture are placed by code in every
    // season they appear in.
    0x43: { 0x2A1: { position: [-4900, 4619, 0], source: 'src/CCW/code_3310.c: chEyrieBaby init' } },
    0x44: { 0x2A1: { position: [-4900, 4619, 0], source: 'src/CCW/code_3310.c: chEyrieBaby init' } },
    0x45: {
        0x2A1: { position: [-4900, 4619, 0], source: 'src/CCW/code_3310.c: chEyrieBaby init' },
        0x2DE: { position: [325.8, 600, 0], source: 'src/CCW/ccwspawnqueue.c: code_76C0_ccwGnawtysStuffUpdate' },
        0x2DD: { position: [325.8, 600, 0], source: 'src/CCW/ccwspawnqueue.c: code_76C0_ccwGnawtysStuffUpdate' },
        0x2DC: { position: [325.8, 600, 0], source: 'src/CCW/ccwspawnqueue.c: code_76C0_ccwGnawtysStuffUpdate' },
    },
    0x46: {
        0x2DE: { position: [325.8, 600, 0], source: 'src/CCW/ccwspawnqueue.c: code_76C0_ccwGnawtysStuffUpdate' },
        0x2DD: { position: [325.8, 600, 0], source: 'src/CCW/ccwspawnqueue.c: code_76C0_ccwGnawtysStuffUpdate' },
        0x2DC: { position: [325.8, 600, 0], source: 'src/CCW/ccwspawnqueue.c: code_76C0_ccwGnawtysStuffUpdate' },
    },
};

/**
 * Apply BK_ACTOR_OVERRIDES to the actor nodes of a map: the node keeps its
 * setup values under `setup` and its position / yaw / scale / model become
 * what the game ends up using. Ref-point positions need the host model's
 * geometry.
 */
async function applyActorOverrides(mapId, actorNodes) {
    const overrides = BK_ACTOR_OVERRIDES[mapId];
    if (!overrides) return;
    const mapObjects = BK_MAP_OBJECTS[mapId] ?? [];
    const dist2 = (a, b) => (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
    // Setup positions are read before any node is moved, so a nearestActor
    // lookup sees the same layout the game's spawn pass does.
    const setupPositions = new Map(actorNodes.map(n => [n, n.position]));

    for (const node of actorNodes) {
        const ov = overrides[node.actorId];
        if (!ov) continue;
        const setup = { position: node.position, yaw: node.yaw, scale: node.scale };
        let position = ov.position;
        if (typeof position === 'function') {
            position = position(node);
        } else if (position && !Array.isArray(position)) {
            if (position.refPoint !== undefined) {
                const host = mapObjects.find(o => o.name === position.object);
                const loaded = host ? await loadPropGeometry(host.asset) : null;
                const point = loaded?.refPoints?.get(position.refPoint);
                if (!point) {
                    console.warn(`actor ${hex(node.actorId)}: ref point ${position.refPoint} of ${position.object} not found`);
                    continue;
                }
                position = point.map((v, i) => v + host.position[i]);
            } else if (position.offset) {
                position = setup.position.map((v, i) => v + position.offset[i]);
            } else if (position.nearestActor !== undefined) {
                let best = null, bestD = Infinity;
                for (const other of actorNodes) {
                    if (other.actorId !== position.nearestActor) continue;
                    const d = dist2(setupPositions.get(other), setup.position);
                    if (d < bestD) { bestD = d; best = setupPositions.get(other); }
                }
                if (!best) {
                    console.warn(`actor ${hex(node.actorId)}: no ${hex(position.nearestActor)} node to snap to`);
                    continue;
                }
                position = best;
            }
        }
        node.setup = setup;
        if (position) node.position = position.map(v => Math.round(v * 100) / 100);
        if (ov.yaw !== undefined) node.yaw = ov.yaw;
        if (ov.scale !== undefined) node.scale = Math.round(ov.scale * 100); // NodeProp units (percent)
        if (ov.asset !== undefined) node.modelAsset = ov.asset;
        node.override = ov;
    }
}

function describeMapObject(obj) {
    return `MAP OBJECT ${obj.name} (model ${hex(obj.asset)}${obj.geometrySource ? ' ' + obj.geometrySource : ''}):` +
        ` pos=${obj.position.join(', ')} yaw=${obj.yaw} scale=${obj.scale} -- ${obj.source}`;
}

const MAP_OBJECT_STYLE = {
    color: ACTOR_COLOR,
    edgeColor: 0x8a3d10,
    describe: describeMapObject,
    fallback: buildActorInstance,
    transform(obj, mesh) {
        mesh.position.set(obj.position[0], obj.position[1], obj.position[2]);
        mesh.rotation.set(0, THREE.MathUtils.degToRad(obj.yaw), 0, 'YXZ');
        mesh.scale.setScalar(obj.scale || 1);
    },
};

const ACTOR_STYLE = {
    color: ACTOR_COLOR,
    edgeColor: 0x8a3d10,
    describe: describeNode,
    fallback: buildActorInstance,
    hitbox: node => BK_Actor_Hitboxes[node.actorId],
    // NodeProp.selector_or_radius doubles as the variant index for models whose
    // parts are selector-gated (level signs, SNS eggs, exit pads).
    selectorOf: node => node.selectorOrRadius,
    // func_80330208 spawns the actor at the node's position with marker->yaw =
    // NodeProp.yaw (already degrees) and scale = NodeProp.scale * 0.01, 0 = 1.
    transform(node, obj) {
        obj.position.set(node.position[0], node.position[1], node.position[2]);
        obj.rotation.set(0, THREE.MathUtils.degToRad(node.yaw), 0, 'YXZ');
        obj.scale.setScalar(node.scale === 0 ? 1 : node.scale / 100);
    },
};

////////////////////////////////////////
// Actor hitboxes
////////////////////////////////////////
//
// The game tests Banjo against an actor with a sphere (func_803322F0 in
// core2/code_A5BC0.c): centre = the actor's position plus the model's vertex
// list centre, radius = its local_norm, both times the actor's scale
// (func_80331F54 / func_803320BC). The centre offset is not rotated by the
// actor's yaw. A sprite actor's sphere has radius half the sprite size and
// sits half a sprite up (func_80331E64). Every marker starts collidable, but
// the sphere only matters for actors something reacts to -- the collision
// table, a marker-id special case, or a callback the actor installs -- which
// is BK_Actor_Hitboxes (see tools/bk/generate_bk_object_list.py); the rest
// (stairs, signs, Bottles) are skipped. It sorts them into two kinds with a
// toggle each: "enemy" (contact hurts Banjo) and "touch" (collectibles,
// pads, switches, doors, NPCs). A style's `hitbox(instance)` returns the
// instance's kind, or nothing.

const actorHitboxes = []; // every hitbox sphere in the scene, for the toggles
const hitboxMaterials = {
    enemy: new THREE.MeshBasicMaterial({ color: 0xff4a4a, wireframe: true, transparent: true, opacity: 0.6, depthWrite: false }),
    touch: new THREE.MeshBasicMaterial({ color: 0x2ee6ff, wireframe: true, transparent: true, opacity: 0.6, depthWrite: false }),
};

function addActorHitbox(group, kind, position, centerOffset, radius, host) {
    const sphere = new THREE.Mesh(radiusGeometry, hitboxMaterials[kind]);
    sphere.position.set(position[0] + centerOffset[0], position[1] + centerOffset[1], position[2] + centerOffset[2]);
    sphere.scale.setScalar(Math.max(radius, 1));
    sphere.visible = !!actorHitboxCheckboxes[kind]?.checked;
    sphere.userData.bkInfo = host.userData.bkInfo +
        `\n  ${kind} hitbox: sphere r=${radius.toFixed(1)} at offset (${centerOffset.map(v => v.toFixed(1)).join(', ')})`;
    sphere.userData.bkProp = host.userData.bkProp;
    sphere.userData.hitboxKind = kind;
    group.add(sphere);
    actorHitboxes.push(sphere);
}

for (const [kind, checkbox] of Object.entries(actorHitboxCheckboxes)) {
    checkbox?.addEventListener('change', () => {
        for (const sphere of actorHitboxes) {
            if (sphere.userData.hitboxKind === kind) sphere.visible = checkbox.checked;
        }
    });
}

/**
 * One row for every placement of a model, drawn with the model's real
 * geometry. Falls back to the style's marker when the model could not be
 * loaded.
 */
function addLoadedModelRow(scene, groupBody, rowName, instances, loaded, style, checked = true) {
    if (!loaded) {
        addTypeRow(scene, groupBody, rowName, instances, style.color, checked, style.fallback);
        return;
    }

    const material = makeMaterial(style.color);
    material.polygonOffset = true;
    material.polygonOffsetFactor = 1;
    material.polygonOffsetUnits = 1;
    const edgeMaterial = new THREE.LineBasicMaterial({ color: style.edgeColor, transparent: true, opacity: 0.8 });

    const typeGroup = new THREE.Group();
    typeGroup.name = rowName;
    const edgesGroup = new THREE.Group();
    edgesGroup.name = rowName + ' edges';

    const picked = pickGeometry(loaded);

    for (const inst of instances) {
        inst.geometrySource = picked.source;
        const mesh = new THREE.Mesh(picked.set.geometry, material);
        style.transform(inst, mesh);
        mesh.userData.bkInfo = style.describe(inst);
        mesh.userData.bkProp = inst;
        typeGroup.add(mesh);

        const edges = new THREE.LineSegments(picked.set.edges, edgeMaterial);
        edges.position.copy(mesh.position);
        edges.rotation.copy(mesh.rotation);
        edges.scale.copy(mesh.scale);
        edgesGroup.add(edges);

        const textured = loaded.texturedFor(style.selectorOf ? style.selectorOf(inst) : 0);
        if (textured) {
            attachTextured(mesh, makeTexturedMesh(textured), edges);
        }

        propInstances.push({ mesh, edges, prop: inst, loaded, describe: style.describe });

        const hitboxKind = style.hitbox?.(inst);
        if (hitboxKind && loaded.bounds) {
            const s = mesh.scale.x;
            addActorHitbox(typeGroup, hitboxKind, inst.position, loaded.bounds.center.map(v => v * s), loaded.bounds.localNorm * s, mesh);
        }
    }

    scene.add(typeGroup);
    scene.add(edgesGroup);
    loadedModels.push({ name: rowName, root: typeGroup, mesh: typeGroup, edges: edgesGroup });
    addModelCheckbox(scene, rowName, typeGroup, edgesGroup, false, checked, style.color, false, null, groupBody);
    edgesGroup.visible = typeGroup.visible && wireframeCheckbox.checked;
}

/**
 * One row for every placement of a sprite, drawn as billboards with the real
 * image. Falls back to the marker when the sprite sheet has no entry.
 */
function addSpriteRow(scene, groupBody, rowName, instances, entry, checked, style = SPRITE_PROP_STYLE) {
    if (!entry || !entry.frames.length) {
        addTypeRow(scene, groupBody, rowName, instances, style.color, checked, style.fallback);
        return;
    }

    const typeGroup = new THREE.Group();
    typeGroup.name = rowName;

    // propModelList_drawSprite sets the prim colour to 0xFF - remove*0x10 per
    // channel; instances with the same tint and frame share one material so
    // the row's colour swatch still drives them together.
    const materials = new Map();
    const materialFor = (frameIndex, tint, mirrored) => {
        const frame = entry.frames[Math.min(frameIndex, entry.frames.length - 1)];
        const key = frame.file + ':' + tint.join(',') + (mirrored ? ':m' : '');
        let material = materials.get(key);
        if (!material) {
            // The alpha test makes the sprite a cutout, so it can write depth
            // like the game's do; the XLU map draws after every sprite
            // (bk_textured.js, renderOrder) and needs that depth to stay
            // behind the ones in front of it.
            material = new THREE.SpriteMaterial({
                map: spriteTexture(frame.file, mirrored),
                color: new THREE.Color(tint[0], tint[1], tint[2]),
                transparent: true,
                alphaTest: 0.05,
                depthWrite: true,
            });
            materials.set(key, material);
        }
        return material;
    };
    const animated = entry.anim && entry.anim.mode !== 0 && entry.frames.length > 1;

    for (const prop of instances) {
        const frame = entry.frames[Math.min(prop.frame ?? 0, entry.frames.length - 1)];
        const tint = (prop.rgbRemove ?? [0, 0, 0]).map(v => (0xFF - v * 0x10) / 0xFF);
        const mirrored = !!(prop.isMirrored ?? 0);
        const material = materialFor(prop.frame ?? 0, tint, mirrored);

        const sprite = new THREE.Sprite(material);
        sprite.name = rowName;
        sprite.position.set(prop.position[0], prop.position[1], prop.position[2]);
        // world size before the prop's own scale
        const scale = style.scaleOf(prop);
        sprite.scale.set(entry.world_w * scale, entry.world_h * scale, 1);
        setSpriteFrame(sprite, material, frame, mirrored);
        sprite.userData.bkInfo = style.describe(prop);
        sprite.userData.bkProp = prop;
        typeGroup.add(sprite);

        const hitboxKind = style.hitbox?.(prop);
        if (hitboxKind) {
            const size = Math.max(entry.world_w, entry.world_h) * scale;
            addActorHitbox(typeGroup, hitboxKind, prop.position, [0, size / 2, 0], size / 2, sprite);
        }

        if (animated) {
            const props = { phase: prop.phase ?? 0 };
            animatedSprites.push({
                sprite, entry, prop: props,
                state: { frame: prop.frame ?? 0, mirrored: prop.isMirrored ?? 0 },
                materialFor: (f, m) => materialFor(f, tint, m),
            });
        }
    }

    scene.add(typeGroup);
    loadedModels.push({ name: rowName, root: typeGroup, mesh: typeGroup, edges: null });
    // No colour swatch: the images carry their own colours (and the game's
    // rgbRemove tint is already baked into each material).
    addModelCheckbox(scene, rowName, typeGroup, null, false, checked, style.color, false, false, groupBody);
}

const SPRITE_PROP_STYLE = {
    color: SPRITE_COLOR,
    describe: describeProp,
    fallback: buildSpriteInstance,
    scaleOf: prop => prop.scale || 1,
};

// An actor whose ActorInfo "model" is really a sprite asset (Extra Life,
// Mumbo Token): drawn as a billboard like the game does, sized by the node's
// scale the same way the model actors are.
const SPRITE_ACTOR_STYLE = {
    color: ACTOR_COLOR,
    describe: describeNode,
    fallback: buildActorInstance,
    hitbox: node => BK_Actor_Hitboxes[node.actorId],
    scaleOf: node => node.scale === 0 ? 1 : node.scale / 100,
};

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
/**
 * Add one row per type, partitioned into two sidebar groups by whether the
 * type's model has a collision list: [key, label] pairs for the solid group
 * (rows shown) and the hitbox-only group (rows shown only if hitboxChecked).
 */
function addSplitModelGroups(scene, byType, geometries, style, nameFn, rowLabel, solidGroup, hitboxGroup, hitboxChecked = false) {
    // Row names must be unique (visibility, colour and lookups are keyed by
    // them); disambiguate any ids that still resolve to the same name.
    const nameCounts = new Map();
    for (const [id] of byType) nameCounts.set(nameFn(id), (nameCounts.get(nameFn(id)) ?? 0) + 1);
    const uniqueName = id => nameCounts.get(nameFn(id)) > 1
        ? `${nameFn(id)} (0x${id.toString(16).toUpperCase()})` : nameFn(id);

    const solid = [];
    const hitboxOnly = [];
    byType.forEach(([id, list], i) => {
        (geometries[i]?.collision ? solid : hitboxOnly).push([id, list, geometries[i]]);
    });

    if (solid.length) {
        const group = getModelGroup(solidGroup[0], solidGroup[1]);
        for (const [id, list, loaded] of solid) {
            addLoadedModelRow(scene, group.body, rowLabel(uniqueName(id), list), list, loaded, style, true);
        }
    }
    if (hitboxOnly.length) {
        const group = getModelGroup(hitboxGroup[0], hitboxGroup[1]);
        for (const [id, list, loaded] of hitboxOnly) {
            addLoadedModelRow(scene, group.body, rowLabel(uniqueName(id), list), list, loaded, style, hitboxChecked);
        }
    }
}

export async function renderBKSetup(scene, buffer, mapId = -1) {
    const setup = parseBKSetup(buffer);
    propInstances.length = 0;
    animatedSprites.length = 0;
    actorHitboxes.length = 0;

    // Visibility is remembered per row name across loads; the same actor
    // type unchecked in one map should not start hidden in the next.
    for (const key of ['bk-models', 'bk-models-hitbox', 'bk-actors', 'bk-actors-hitbox', 'bk-sprites', 'bk-nodes']) {
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

    // Model props first, then actors: both are split into a "collision" group
    // (the model has a collision list -- solid geometry the player interacts
    // with, shown by default) and a "hitbox only" group (models that only
    // collide through the marker's sphere, model-less triggers, and anything
    // whose model couldn't be loaded -- hidden by default).
    if (modelProps.length) {
        const byType = [...groupBy(modelProps, p => p.modelId)]
            .sort((a, b) => modelName(a[0]).localeCompare(modelName(b[0])));
        // Fetch every distinct model up front so the rows still come out in
        // name order rather than in whatever order the downloads finish.
        const geometries = await Promise.all(byType.map(([id]) => loadPropGeometry(id + MODEL_ASSET_OFFSET)));
        addSplitModelGroups(scene, byType, geometries, MODEL_PROP_STYLE, modelName, rowLabel,
            ['bk-models', 'Model Props (collision)'], ['bk-models-hitbox', 'Model Props (no collision)']);
    }

    // Level-overlay objects (Clanker) go into the actor groups alongside the
    // setup-file actors, split by collision the same way.
    const mapObjects = BK_MAP_OBJECTS[mapId] ?? [];
    if (mapObjects.length) {
        const byName = [...groupBy(mapObjects, o => o.name)];
        const geometries = await Promise.all(byName.map(([, list]) => loadPropGeometry(list[0].asset)));
        addSplitModelGroups(scene, byName, geometries, MAP_OBJECT_STYLE, name => name, rowLabel,
            ['bk-actors', 'Actors (collision)'], ['bk-actors-hitbox', 'Actors (hitbox only)'], true);
    }

    if (actorNodes.length) {
        await applyActorOverrides(mapId, actorNodes);
        const byType = [...groupBy(actorNodes, n => n.actorId)]
            .sort((a, b) => actorName(a[0]).localeCompare(actorName(b[0])));
        // Each actor's model comes from its ActorInfo (BK_Actor_Models) unless
        // an override swaps it; actors with no model (triggers, controllers)
        // or none known keep the marker. A few actors' "models" are sprite
        // assets; those become billboards in the hitbox-only group rather
        // than going through the model loader.
        const modelOf = ([id, list]) => list[0].modelAsset ?? BK_Actor_Models[id];
        const spriteIndex = await loadSpriteIndex();
        const spriteActors = byType.filter(entry => spriteIndex.has(modelOf(entry)));
        const modelActors = byType.filter(entry => !spriteIndex.has(modelOf(entry)));

        const geometries = await Promise.all(modelActors.map(entry => {
            const modelAsset = modelOf(entry);
            return modelAsset ? loadPropGeometry(modelAsset) : Promise.resolve(null);
        }));
        addSplitModelGroups(scene, modelActors, geometries, ACTOR_STYLE, actorName, rowLabel,
            ['bk-actors', 'Actors (collision)'], ['bk-actors-hitbox', 'Actors (hitbox only)'], true);

        if (spriteActors.length) {
            const group = getModelGroup('bk-actors-hitbox', 'Actors (hitbox only)');
            for (const [id, list] of spriteActors) {
                addSpriteRow(scene, group.body, rowLabel(actorName(id), list), list,
                    spriteIndex.get(modelOf([id, list])), true, SPRITE_ACTOR_STYLE);
            }
        }
    }

    if (spriteProps.length) {
        const group = getModelGroup('bk-sprites', 'Sprite Props');
        const spriteIndex = await loadSpriteIndex();
        const byType = groupBy(spriteProps, p => p.spriteId);
        for (const [id, list] of [...byType].sort((a, b) => spriteName(a[0]).localeCompare(spriteName(b[0])))) {
            addSpriteRow(scene, group.body, rowLabel(spriteName(id), list), list,
                spriteIndex.get(id + SPRITE_ASSET_OFFSET), true);
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

    // Carry each group's master checkbox over from the previous map.
    for (const key of ['bk-models', 'bk-models-hitbox', 'bk-actors', 'bk-actors-hitbox', 'bk-sprites', 'bk-nodes']) {
        applyGroupMasterState(key);
    }

    console.log(`BK setup: cubes ${setup.cubeMin} .. ${setup.cubeMax},`,
        `${actorNodes.length} actors, ${otherNodes.length} other nodes, ${skippedNodes} skipped nodes,`,
        `${modelProps.length} model props, ${spriteProps.length} sprite props, ${setup.otherNodeCount} OtherNodes`);

    return setup;
}
