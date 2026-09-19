import * as THREE from 'three';
import { addModelCheckbox, getModelGroup, resetGroupModelState, applyGroupMasterState } from './render.js';
import { parseBKModelGeometry } from './bk_model.js';
import { buildTexturedParts, makeTexturedMesh, attachTextured, refreshTexturedMode, isPropCollisionShown, VIEW_CONTROLS } from './bk_textured.js';

const wireframeCheckbox = document.getElementById('wireframe');
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

// Prop models are extracted per game into models/<game>/props/; BT's come
// from banjo-tooie/tools/extract_maps.py and use the same file format
// (bt_setup.js shares this loader and the row builders below).
const propGeometryCache = new Map(); // "<game>:<asset id>" -> Promise<{visual, collision} | null>

// Every prop mesh / edge object currently in the scene, so the selector can
// swap their geometry in place without reloading the map.
const propInstances = [];

/** The { mesh, edges, prop } instances the current map's rows were built from. */
export function getPropInstances() {
    return propInstances;
}

/** Forget the previous map's prop instances, sprites and hitboxes (called on every map load). */
export function resetSetupState() {
    propInstances.length = 0;
    animatedSprites.length = 0;
    actorHitboxes.length = 0;
}

export function makeGeometrySet(positions, indices) {
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

// The Prop collision checkbox swaps every prop instance's geometry; Textures
// only changes how bk_textured.js draws it, but re-picking is harmless.
for (const control of VIEW_CONTROLS) control?.addEventListener('change', () => {
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

export function loadPropGeometry(assetId, game = 'BK') {
    const cacheKey = `${game}:${assetId}`;
    if (propGeometryCache.has(cacheKey)) {
        return propGeometryCache.get(cacheKey);
    }

    const file = assetId.toString(16).toUpperCase().padStart(4, '0') + '.model.bin';
    const promise = fetch(`./models/${game}/props/` + file)
        .then(res => {
            if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
            return res.arrayBuffer();
        })
        .then(buffer => {
            const model = parseBKModelGeometry(buffer, game);
            const loaded = {
                visual: makeGeometrySet(model.positions, model.displayListIndices),
                collision: makeGeometrySet(model.positions, model.collisionIndices),
                bounds: model.bounds,
                hitVolumes: model.hitVolumes,
                refPoints: model.refPoints,
                texturedVariants: new Map(),
                // Textured geometry depends on which selector-gated variant an
                // instance shows, so it is built per (selector, appendage
                // overrides) on demand.
                texturedFor(selector, appendageOverrides = null) {
                    const key = appendageOverrides ? `${selector}:${JSON.stringify(appendageOverrides)}` : selector;
                    if (!this.texturedVariants.has(key)) {
                        let parts = null;
                        try {
                            parts = buildTexturedParts(buffer, selector, { appendageOverrides, game });
                        } catch (err) {
                            console.warn(`prop model ${file}: textured build failed: ${err.message}`);
                        }
                        this.texturedVariants.set(key, parts);
                    }
                    return this.texturedVariants.get(key);
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

    propGeometryCache.set(cacheKey, promise);
    return promise;
}

////////////////////////////////////////
// Sprite images
////////////////////////////////////////
//
// Sprites are extracted by banjo-kazooie/tools/extract_sprites.py (and
// banjo-tooie/tools/extract_sprites.py for BT, whose sprites are a prebuilt
// display-list format but place their quads the same way) into
// models/<game>/sprites/<asset>_<frame>.png plus sprites.json, which records
// each sprite's world size (BKSprite.unk8/unkA) and each frame's pixel size
// and anchor (BKSpriteFrame.unk0/unk2). The game draws a sprite as a
// camera-facing quad world_w x world_h units across, with the prop's position
// at the anchor pixel (spriteRender_drawWithSegment) -- which is exactly a
// THREE.Sprite with its `center` set from the anchor.

const spriteDir = game => `./models/${game}/sprites/`;
const spriteIndexPromises = new Map();   // game -> Promise<Map<asset id, entry>>
const spriteTextureCache = new Map(); // game/file -> THREE.Texture
const textureLoader = new THREE.TextureLoader();

export function loadSpriteIndex(game = 'BK') {
    if (!spriteIndexPromises.has(game)) {
        spriteIndexPromises.set(game, fetch(spriteDir(game) + 'sprites.json')
            .then(res => {
                if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
                return res.json();
            })
            .then(list => new Map(list.map(e => [e.asset_id, e])))
            .catch(err => {
                console.warn(`${game} sprites.json: ${err.message}; sprite props will be markers`);
                return new Map();
            }));
    }
    return spriteIndexPromises.get(game);
}

// The game mirrors a sprite by drawing its quad with a negative X scale.
// THREE.Sprite can't do that (its shader uses the LENGTH of the model
// matrix's X column, so the sign is lost), so a mirrored frame is a second
// texture with the UVs flipped horizontally instead.
function spriteTexture(file, mirrored = false, game = 'BK') {
    const key = game + '/' + file + (mirrored ? '|mirrored' : '');
    let tex = spriteTextureCache.get(key);
    if (!tex) {
        tex = mirrored ? spriteTexture(file, false, game).clone() : textureLoader.load(spriteDir(game) + file);
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
// stepping through its sheet's animation, or { sprite, update } when the
// placing code animates it itself (update(tick) each game tick; BT's fire
// particles).
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
        if (a.update) { a.update(tick); continue; }
        spriteAnimationStep(a.entry.anim, a.entry.frames.length, a.prop, a.state, tick);
        const frame = a.entry.frames[Math.min(a.state.frame, a.entry.frames.length - 1)];
        setSpriteFrame(a.sprite, a.materialFor(a.state.frame, a.state.mirrored), frame, a.state.mirrored);
    }
}
animateSprites();

////////////////////////////////////////
// Rendering
////////////////////////////////////////

export const ACTOR_COLOR = '#ff7b24';
export const NODE_COLOR = '#ffd23a';
export const MODEL_COLOR = '#c77dff';
export const SPRITE_COLOR = '#3aff78';

export const ACTOR_MARKER_RADIUS = 40;
const NODE_MARKER_RADIUS = 25;
export const MODEL_MARKER_SIZE = 60;
const SPRITE_MARKER_RADIUS = 20;

// Shared geometries; each instance mesh clones nothing but the transform.
export const actorGeometry = new THREE.OctahedronGeometry(ACTOR_MARKER_RADIUS, 0);
export const nodeGeometry = new THREE.TetrahedronGeometry(NODE_MARKER_RADIUS, 0);
export const modelGeometry = new THREE.BoxGeometry(MODEL_MARKER_SIZE, MODEL_MARKER_SIZE, MODEL_MARKER_SIZE);
export const spriteGeometry = new THREE.OctahedronGeometry(SPRITE_MARKER_RADIUS, 0);
export const radiusGeometry = new THREE.SphereGeometry(1, 12, 8);

function makeMaterial(color) {
    return new THREE.MeshLambertMaterial({ color, side: THREE.FrontSide, flatShading: true });
}

// A short line from the marker's centre along its yaw, so facing is visible.
export function makeYawLine(length, material) {
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
        (node.override ? ` [runtime placement; setup pos=${node.setup.position.join(', ')} yaw=${node.setup.yaw} scale=${node.setup.scale / 100} -- ${node.override.source}]` : '') +
        (node.spawnedBy ? ` [spawned by ${actorName(node.spawnedBy.actorId)} (${hex(node.spawnedBy.actorId)}) -- ${node.spawnedBy.source}]` : '');
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
export function groupBy(list, keyFn) {
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
export function addTypeRow(scene, groupBody, rowName, instances, color, checked, buildInstance) {
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
// models are the ones hard-coded in the decomp. Optional `hitbox` and
// `appendages` are as for setup actors (BK_Actor_Hitboxes, BK_ACTOR_APPENDAGES).
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
//   { nearestActor: id, offset? }    the position of the closest node with
//                                    that actor id (actorArray_findClosest...)
//                                    plus an optional [dx, dy, dz]
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
    0x26: { // MMM_NAPPERS_ROOM
        0x39: { position: { nearestActor: 0x46, offset: [0, -50, 0] }, scale: 0.5,
                source: 'src/MMM/ch/napper.c: chnapper_update init sits him 50 under the jiggy at scale 0.5' },
    },
    0x27: { // FP_FREEZEEZY_PEAK
        0x1F3: { position: { nearestActor: 0x35B },
                 source: 'src/FP/ch/wozza.c: chWozza_update init moves him to the 0x35B node while he still holds the jiggy' },
    },
    0x6A: { // GL_TTC_AND_CC_PUZZLE
        0x259: { position: { offset: [0, -51, 0] },
                 source: 'src/lair/lairspawnqueue.c func_803880BC: position_y -= 51 on init (rises when the witch switch is pressed)' },
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

// Appendage visibility an actor's draw callback pins before actor_draw, for
// models whose parts are behind a SELECTOR the guess in parseBKModelTextured
// gets wrong. actorId -> { [appendage index]: selection } as passed to
// modelRender_setAppendageVisibility, in the actor's resting state; indices
// not listed keep the guess. A function entry gets (node, mapId) for actors
// whose parts depend on the map.

// CCW season by map id: src/CCW/ch/grublinhood.c __get_current_season.
const CCW_SEASON_BY_MAP = {
    0x43: 0, 0x4A: 0, 0x5B: 0, 0x5E: 0, 0x65: 0, // spring
    0x44: 1, 0x4B: 1, 0x5A: 1, 0x5F: 1, 0x66: 1, // summer
    0x45: 2, 0x4C: 2, 0x5C: 2, 0x60: 2, 0x63: 2, 0x67: 2, // autumn
    0x46: 3, 0x4D: 3, 0x61: 3, 0x62: 3, 0x64: 3, 0x68: 3, // winter
};

const BK_ACTOR_APPENDAGES = {
    // ---- core2 (actors shared between levels)
    // Mumbo: 4/6 = hut-version parts (lifetime_value 0 on a fresh file), 5/7
    // and 8 = his other two costumes: src/core2/ch/mumbo.c chMumbo_draw.
    0x7: { 4: 1, 5: 0, 6: 1, 7: 0, 8: 0, 9: 0 },
    // Bottles: 3/4 off whenever he is drawn: src/core2/ch/mole.c.
    0x37A: { 3: 0, 4: 0 },
    // Gravestones: 3 = velocity[1] (1 while idle), 4 = local->unk0 (1 after
    // init): src/core2/ch/gravestone.c.
    0xC7: { 3: 1, 4: 1 }, 0x3C2: { 3: 1, 4: 1 },
    // Grille chompa: 3 off while idle: src/core2/ch/grillechompa.c.
    0x1CC: { 3: 0 },
    // Clucker: 3 = dying, 4 off while idle: src/core2/ch/clucker.c.
    0x29F: { 3: 0, 4: 0 },
    // Ice cubes: 3 = unk38_31, 0 until they attack: src/core2/ch/icecube.c.
    0x37D: { 3: 0 }, 0x3A0: { 3: 0 },
    // Mumbo switch: 1 = 2 unless it is blinking (unk38_0): src/core2/code_4C020.c chMumboSwitch_draw.
    0x23D: { 1: 2 },
    // ---- SM
    // Vegetables: the draw sets 3 = -7 (branches 0-2 on: the leaves / tops)
    // while has_met_before, which init sets and only the death state clears:
    // src/SM/ch/vegetables.c.
    0x164: { 3: -7 }, 0x165: { 3: -7 }, 0x166: { 3: -7 }, 0x36D: { 3: -7 }, 0x36E: { 3: -7 }, 0x36F: { 3: -7 },
    // ---- MM
    // Mumbo's Mountain hut: 1 = not destroyed: src/MM/ch/hut.c.
    0x9: { 1: 1 },
    // ---- TTC
    // The whole crab is appendage 3; only the shell is unconditional. On
    // unless dead (state 7): src/TTC/ch/nipper.c __chNipper_animFunc.
    0x117: { 3: 1 },
    // Blubber: 4 always off: src/TTC/ch/blubber.c.
    0x115: { 4: 0 },
    // Lockups: 3/4 = unk38_31, 0 while closed: src/TTC/ch/lockup.c.
    0x151: { 3: 0, 4: 0 }, 0x152: { 3: 0, 4: 0 }, 0x153: { 3: 0, 4: 0 },
    // ---- BGS
    // BGS mud hut: the walls are appendage 1, shown while idle (state 1):
    // src/BGS/ch/mudhut.c chMudHut_draw.
    0xC: { 1: 1 },
    // Choir turtles: 4 = marker id - 0x19A, i.e. 1..6 in colour order:
    // src/BGS/ch/choirturtle.c.
    0x27B: { 4: 1 }, 0x27C: { 4: 2 }, 0x27D: { 4: 3 }, 0x27E: { 4: 4 }, 0x27F: { 4: 5 }, 0x280: { 4: 6 },
    // Croctus: 1 = actorTypeSpecificField (NodeProp selector): src/BGS/ch/croctus.c.
    0x1FA: node => ({ 1: node.selectorOrRadius }),
    // Pink egg: 1 = intact, 2 = breaking: src/BGS/ch/pinkegg.c.
    0x5B: { 1: 1, 2: 0 }, 0xED: { 1: 1, 2: 0 }, 0xEE: { 1: 1, 2: 0 }, 0xEF: { 1: 1, 2: 0 }, 0xF0: { 1: 1, 2: 0 },
    // ---- FP
    // Snowman button: 1 = pressed (state 3), 2 = the inverse: src/FP/ch/snowmanbutton.c.
    0x116: { 1: 0, 2: 1 },
    // Christmas tree: 5 = lights on (unk38_31), 6 = lit after the Twinklies
    // minigame: src/FP/ch/xmastree.c. Star: 1 = off, 2 = on. Switch: 1 off, 2 on.
    0x15F: { 5: 0, 6: 0 },
    0x339: { 1: 1, 2: 0 },
    0x338: { 1: 0, 2: 1 },
    // Boggy: 1/3 per appearance: src/FP/ch/boggy1.c, boggy2.c, boggy3.c.
    0x160: { 1: 0, 3: 1 }, 0xC8: { 1: 1, 3: 1 }, 0x33D: { 1: 0, 3: 0 },
    // 1 = snowball in hand (raised mid-attack), 2 = hat (until knocked off):
    // src/core2/ch/snowman.c chSnowman_draw, idle sets unk9 = 0, unkA = 1.
    0x124: { 1: 0, 2: 1 },
    // ---- GV
    // Ancient ones: 3/4 on unless state 3: src/GV/ch/ancientone.c.
    0x147: { 3: 1, 4: 1 },
    // ---- MMM
    // Cemetery pot: 3 = flowered: src/MMM/ch/cemetarypot.c.
    0x25: { 3: 0 },
    // Napper asleep (state 1): src/MMM/ch/napper.c chnapper_draw.
    0x39: { 1: 1, 2: 0, 3: 0 },
    // Portraits: 3 = unk38_31, 2 until broken: src/MMM/ch/portrait.c.
    0x382: { 3: 2 }, 0x384: { 3: 2 }, 0x385: { 3: 2 }, 0x386: { 3: 2 }, 0x387: { 3: 2 }, 0x388: { 3: 2 },
    // ---- RBB
    // Grimlet: 3/4 only while Banjo is within 600: src/RBB/ch/grimlet.c.
    0x1C6: { 3: 0, 4: 0 },
    // ---- CCW
    // Seasonal outfit; 14 = hat, worn until Banjo has met him:
    // src/CCW/ch/grublinhood.c chgrublinhood_draw.
    0x375: (node, mapId) => {
        const season = CCW_SEASON_BY_MAP[mapId] ?? 0;
        const summer = season === 1, autumn = season === 2, winter = season === 3;
        const beforeAutumn = season < 2;
        return {
            3: summer ? 1 : 2, 4: summer ? 1 : 2,
            5: beforeAutumn ? 1 : 2, 6: beforeAutumn ? 1 : 2, 7: beforeAutumn ? 1 : 2, 8: beforeAutumn ? 1 : 2,
            9: summer ? 1 : 0,
            10: beforeAutumn ? 0 : autumn ? 1 : 2, 11: beforeAutumn ? 0 : autumn ? 1 : 2,
            12: winter ? 2 : 1, 13: winter ? 1 : 0,
            14: 1,
        };
    },
    // Eyrie's egg: 3 = whole, 4 = broken: src/CCW/ch/eyrieegg.c.
    0x2A0: { 3: 1, 4: 0 },
    // Eyrie: 3 = 2 asleep, 1 otherwise: src/CCW/code_3310.c.
    0x2A1: { 3: 1 },
    // Nabnut outside in autumn: src/CCW/ch/outsideautumnnabnut.c.
    0x2A8: { 3: 0, 4: 0, 5: 1, 6: 0, 7: 1, 8: 1, 9: 0, 10: 1 },
    // Pink squirrel and Nabnut eating acorns: src/CCW/code_5BF0.c func_8038C380.
    0x311: { 3: 0, 4: 0, 5: 0, 6: 1, 7: 0, 8: 0, 9: 0, 10: 1 },
    0x315: { 3: 0, 4: 0, 5: 0, 6: 1, 7: 0, 8: 0, 9: 0, 10: 1 },
    // ---- Gruntilda's Lair
    // Warp cauldron: 3 = active, 4 = inactive: src/lair/ch/cauldron.c.
    0x23B: { 3: 0, 4: 1 },
    // Cheato: src/lair/ch/cheato.c.
    0x1D5: { 3: 1, 4: 1 }, 0x1D6: { 3: 1, 4: 1 }, 0x1D7: { 3: 1, 4: 1 },
    // Refill pillows: 3/4 while still collidable (unused): src/lair/ch/refillpillow.c.
    0x1D8: { 3: 1, 4: 1 }, 0x1D9: { 3: 1, 4: 1 }, 0x1DA: { 3: 1, 4: 1 },
    // Furnace Fun prizes: src/lair/ch/furnacefunprizes.c.
    0x3C4: { 4: 1, 5: 1 }, 0x3C6: { 4: 1, 5: 1 }, 0x3C7: { 4: 1, 5: 1 }, 0x3C8: { 4: 1, 5: 1 },
    // Gruntilda in the lair: src/lair/ch/lairgruntilda.c.
    0x3C5: { 3: 0, 4: 0, 5: 0 },
    // Crypt coffin lid: 3 = opening (unk10_12), 4 = shut: src/lair/lairspawnqueue.c func_8038664C.
    0x258: { 3: 0, 4: 1 },
};

// Map being rendered, for BK_ACTOR_APPENDAGES entries that depend on it.
let currentMapId = -1;

function actorAppendages(node) {
    const entry = BK_ACTOR_APPENDAGES[node.actorId];
    return typeof entry === 'function' ? entry(node, currentMapId) : entry ?? null;
}

// Actors another actor spawns on its first update tick (spawn_child_actor /
// actor_spawnWithYaw / __spawnQueue_add_*), which therefore have no NodeProp
// of their own. Keyed by the spawning actor's id; each rule is
//   { actorId, offset?, position?, yaw?, scale?, source }
// where offset is relative to the parent (spawn_child_actor uses the parent's
// position and yaw), position is absolute, yaw and scale default to the
// parent's yaw and 1 (actor_new), and scale 'parent' copies the parent's. A
// function entry gets the parent node and returns rules (or nothing). Only
// spawns a fresh save file sees are listed; ones that need an event (jiggies
// appearing, enemies splitting, minigames) are not.
const BK_ACTOR_CHILDREN = {
    // Bottles digs a molehill under himself.
    0x37A: [{ actorId: 0x12C, source: 'src/core2/ch/mole.c chmole_spawnMolehill' }],
    0x12B: [{ actorId: 0x12C, source: 'src/SM/ch/smbottles.c __chSmBottles_spawnMolehill' }],
    // The lighthouse top is a child of its base.
    0x2E2: [{ actorId: 0x2DF, source: 'src/TTC/code_26D0.c __code26D0_spawnLighthouseB' }],
    // Tanktup's four legs, 50 above him, facing his way.
    0xE8: [0xE9, 0xEA, 0xEB, 0xEC].map(actorId => ({ actorId, offset: [0, 50, 0],
        source: 'src/BGS/ch/tanktup.c func_8038F470 (spawned for each leg not yet hit)' })),
    // The Juju controller stacks four totems, 250 apart, none yet destroyed.
    0x11: [0, 1, 2, 3].map(i => ({ actorId: 0x59, offset: [0, 250 * i, 0],
        source: 'src/MM/ch/juju.c __chjuju_initialize_all (count = 0 on a fresh file)' })),
    // The Christmas tree spawns its star and the switch that lights it.
    0x336: [
        { actorId: 0x339, offset: [20, 0, 25], source: 'src/FP/ch/xmastree.c chXmasTree_spawnStar' },
        { actorId: 0x338, position: [-4640, 106, 6469], yaw: 350, source: 'src/FP/ch/xmastree.c chXmasTree_spawnSwitch' },
    ],
    // The boss Boom Box controller spawns the largest box where it stands;
    // its init sets scale 1.1 and yaw 270 (chBossBoomBoxTable[0]). The
    // smaller boxes only exist once it has been split.
    0x2AD: [{ actorId: 0x281, yaw: 270, scale: 1.1,
        source: 'src/RBB/ch/bossboomboxctrl.c spawn at controller; src/RBB/ch/bossboombox.c init' }],
    // Grunty's floor picture: eye 2 spawns at eye 1 (after its -51 drop).
    0x259: [{ actorId: 0x25A, source: 'src/lair/lairspawnqueue.c func_80387E94' }],
    // The crypt coffin's lid, until it has been opened; copies the coffin's scale.
    0x23E: [{ actorId: 0x258, scale: 'parent', source: 'src/lair/lairspawnqueue.c func_803897D4' }],
    // Wozza holds his jiggy at his position (see the FP override above).
    0x1F3: [{ actorId: 0x1F4, source: 'src/FP/ch/wozza.c chWozza_spawnJiggy' }],
    // Each portrait chompa hangs the painting its selector names.
    0x381: node => ({
        actorId: { 0x32: 0x382, 0x33: 0x384, 0x34: 0x385, 0x35: 0x386, 0x36: 0x387, 0x37: 0x388 }[node.selectorOrRadius] ?? 0x382,
        source: 'src/MMM/ch/portraitchompa.c __chChompa_spawnPortrait (actorTypeSpecificField picks the portrait)',
    }),
};

/**
 * Nodes for the actors that BK_ACTOR_CHILDREN says these actor nodes spawn.
 * Call after applyActorOverrides so a moved parent spawns its children where
 * the game does.
 */
function spawnActorChildren(actorNodes) {
    const spawned = [];
    for (const parent of actorNodes) {
        let rules = BK_ACTOR_CHILDREN[parent.actorId];
        if (typeof rules === 'function') rules = rules(parent);
        if (!rules) continue;
        for (const rule of [].concat(rules)) {
            const offset = rule.offset ?? [0, 0, 0];
            spawned.push({
                ...parent,
                actorId: rule.actorId,
                position: rule.position ?? parent.position.map((v, i) => v + offset[i]),
                yaw: rule.yaw ?? parent.yaw,
                // NodeProp scale units (x100); actor_new starts at 1.
                scale: rule.scale === 'parent' ? parent.scale : Math.round((rule.scale ?? 1) * 100),
                // actorTypeSpecificField is 0 for a code-spawned actor.
                selectorOrRadius: 0,
                override: null,
                spawnedBy: { actorId: parent.actorId, source: rule.source },
            });
        }
    }
    return spawned;
}

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
                position = best.map((v, i) => v + (position.offset?.[i] ?? 0));
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
    hitbox: obj => obj.hitbox,
    appendagesOf: obj => obj.appendages ?? null,
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
    appendagesOf: actorAppendages,
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
// The game tests Banjo against an actor in func_803322F0 (core2/code_A5BC0.c)
// one of two ways:
//
//  - If the actor's model has a hit volume list (bk_model.js parseHitVolumes)
//    the marker gets func_80330974 as its collision test and the sphere below
//    is never consulted: the volumes (boxes, cylinders, spheres in model
//    space) are transformed by the actor's position, rotation and scale and
//    tested one by one, after a broad-phase reject outside the list's radius.
//    About three quarters of the actors with a hitbox work this way.
//  - Otherwise, a sphere: centre = the actor's position plus the model's
//    vertex list centre, radius = its local_norm, both times the actor's
//    scale (func_80331F54 / func_803320BC). The centre offset is not rotated
//    by the actor's yaw. A sprite actor's sphere has radius half the sprite
//    size and sits half a sprite up (func_80331E64).
//
// Every marker starts collidable, but
// the sphere only matters for actors something reacts to -- the collision
// table, a marker-id special case, or a callback the actor installs -- which
// is BK_Actor_Hitboxes (see tools/bk/generate_bk_object_list.py); the rest
// (stairs, signs, Bottles) are skipped. It sorts them into two kinds with a
// toggle each: "enemy" (contact hurts Banjo) and "touch" (collectibles,
// pads, switches, doors, NPCs). A style's `hitbox(instance)` returns the
// instance's kind, or nothing.

const actorHitboxes = []; // every hitbox object in the scene, for the toggles
// Hitboxes are thin wireframes, so they can afford to write depth. Drawn
// before the XLU map (renderOrder 1, bk_textured.js), which is then
// depth-tested against them: water blends over a submerged hitbox and a
// hitbox in front of a waterfall stays crisp. (The collision overlay draws
// after the XLU map instead, because it's solid.)
const hitboxMaterials = {
    enemy: new THREE.MeshBasicMaterial({ color: 0xff4a4a, wireframe: true, transparent: true, opacity: 0.6 }),
    touch: new THREE.MeshBasicMaterial({ color: 0x2ee6ff, wireframe: true, transparent: true, opacity: 0.6 }),
};
const hitboxEdgeMaterials = {
    enemy: new THREE.LineBasicMaterial({ color: 0xff4a4a, transparent: true, opacity: 0.8 }),
    touch: new THREE.LineBasicMaterial({ color: 0x2ee6ff, transparent: true, opacity: 0.8 }),
};
const hitboxBoxEdges = new THREE.EdgesGeometry(new THREE.BoxGeometry(1, 1, 1));
const hitboxCylinderGeometry = new THREE.CylinderGeometry(1, 1, 1, 12, 1);
const hitboxSphereGeometry = new THREE.SphereGeometry(1, 8, 6);

// Hitboxes are not pickable (selection.js skips `unselectable`): clicking
// through a wireframe selects what is behind it. Their details go onto the
// host actor's own description instead (and its textured children, which
// copied the description when they were attached).
function registerHitbox(obj, kind, host, info) {
    obj.visible = !!actorHitboxCheckboxes[kind]?.checked;
    obj.userData.hitboxKind = kind;
    obj.traverse(child => { child.userData.unselectable = true; });
    const hostInfo = host.userData.bkInfo;
    host.traverse(child => { if (child.userData.bkInfo === hostInfo) child.userData.bkInfo = hostInfo + info; });
    actorHitboxes.push(obj);
}

function addActorHitbox(group, kind, position, centerOffset, radius, host) {
    const sphere = new THREE.Mesh(radiusGeometry, hitboxMaterials[kind]);
    sphere.position.set(position[0] + centerOffset[0], position[1] + centerOffset[1], position[2] + centerOffset[2]);
    sphere.scale.setScalar(Math.max(radius, 1));
    registerHitbox(sphere, kind, host,
        `\n  ${kind} hitbox: sphere r=${radius.toFixed(1)} at offset (${centerOffset.map(v => v.toFixed(1)).join(', ')})`);
    group.add(sphere);
}

// Volume rotations: the game undoes them roll, pitch, yaw (func_80252DDC /
// func_80252EC8), so the forward rotation applies yaw first -- 'ZXY'.
function hitVolumeEuler(rot) {
    const d = THREE.MathUtils.degToRad;
    return new THREE.Euler(d(rot[0]), d(rot[1]), d(rot[2]), 'ZXY');
}

const fmt3 = v => v.map(n => n.toFixed(0)).join(', ');
const boneText = bone => bone >= 0 ? ` bone ${bone}` : '';

/**
 * A model actor's hit volume list, in the actor's transform (`host` is the
 * placed model mesh: same position, rotation and scale the game feeds
 * func_80330974). Volumes pinned to a bone are drawn in the rest pose. The
 * list's broad-phase radius is only an early-out around the volumes, so it
 * is reported in the description but not drawn.
 */
function addActorHitVolumes(group, kind, volumes, host) {
    const root = new THREE.Group();
    root.position.copy(host.position);
    root.rotation.copy(host.rotation);
    root.scale.copy(host.scale);

    const lines = [`\n  ${kind} hitbox: ${volumes.boxes.length} box, ${volumes.cylinders.length} cylinder, ` +
        `${volumes.spheres.length} sphere (broad-phase r=${volumes.radius})`];
    for (const box of volumes.boxes) {
        // [min, max] is axis-aligned in a frame rotated about `pivot`.
        const pivot = new THREE.Object3D();
        pivot.position.set(box.pivot[0], box.pivot[1], box.pivot[2]);
        pivot.rotation.copy(hitVolumeEuler(box.rot));
        const edges = new THREE.LineSegments(hitboxBoxEdges, hitboxEdgeMaterials[kind]);
        edges.position.set((box.min[0] + box.max[0]) / 2 - box.pivot[0], (box.min[1] + box.max[1]) / 2 - box.pivot[1],
            (box.min[2] + box.max[2]) / 2 - box.pivot[2]);
        edges.scale.set(Math.max(box.max[0] - box.min[0], 1), Math.max(box.max[1] - box.min[1], 1),
            Math.max(box.max[2] - box.min[2], 1));
        pivot.add(edges);
        root.add(pivot);
        lines.push(`    box min (${fmt3(box.min)}) max (${fmt3(box.max)}) pivot (${fmt3(box.pivot)})` +
            (box.rot.some(r => r) ? ` rot (${fmt3(box.rot)})` : '') + boneText(box.bone));
    }
    for (const cyl of volumes.cylinders) {
        // Axis along local Z; three.js cylinders run along Y, so tip it over.
        const pivot = new THREE.Object3D();
        pivot.position.set(cyl.center[0], cyl.center[1], cyl.center[2]);
        pivot.rotation.copy(hitVolumeEuler(cyl.rot));
        const mesh = new THREE.Mesh(hitboxCylinderGeometry, hitboxMaterials[kind]);
        mesh.rotation.x = Math.PI / 2;
        mesh.scale.set(Math.max(cyl.radius, 1), Math.max(cyl.height, 1), Math.max(cyl.radius, 1));
        pivot.add(mesh);
        root.add(pivot);
        lines.push(`    cylinder r=${cyl.radius} h=${cyl.height} at (${fmt3(cyl.center)})` +
            (cyl.rot.some(r => r) ? ` rot (${fmt3(cyl.rot)})` : '') + boneText(cyl.bone));
    }
    for (const sph of volumes.spheres) {
        const mesh = new THREE.Mesh(hitboxSphereGeometry, hitboxMaterials[kind]);
        mesh.position.set(sph.center[0], sph.center[1], sph.center[2]);
        mesh.scale.setScalar(Math.max(sph.radius, 1));
        root.add(mesh);
        lines.push(`    sphere r=${sph.radius} at (${fmt3(sph.center)})` + boneText(sph.bone));
    }

    registerHitbox(root, kind, host, lines.join('\n'));
    group.add(root);
}

for (const [kind, checkbox] of Object.entries(actorHitboxCheckboxes)) {
    checkbox?.addEventListener('change', () => {
        for (const hitbox of actorHitboxes) {
            if (hitbox.userData.hitboxKind === kind) hitbox.visible = checkbox.checked;
        }
    });
}

/**
 * One row for every placement of a model, drawn with the model's real
 * geometry. Falls back to the style's marker when the model could not be
 * loaded.
 */
export function addLoadedModelRow(scene, groupBody, rowName, instances, loaded, style, checked = true) {
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

        const textured = loaded.texturedFor(style.selectorOf ? style.selectorOf(inst) : 0,
            style.appendagesOf ? style.appendagesOf(inst) ?? null : null);
        if (textured) {
            attachTextured(mesh, makeTexturedMesh(textured), edges);
            // A style can push an instance's textured draw later in the
            // transparent pass (three.js sorts by renderOrder, then depth),
            // for translucent things that must blend over what sits inside
            // them whatever the camera does to the distance sort.
            const order = style.renderOrderOf?.(inst) ?? 0;
            if (order) mesh.traverse(o => { if (o.name === 'textured') o.renderOrder = order; });
        }

        propInstances.push({ mesh, edges, prop: inst, loaded, describe: style.describe });

        const hitboxKind = style.hitbox?.(inst);
        if (hitboxKind && loaded.hitVolumes) {
            addActorHitVolumes(typeGroup, hitboxKind, loaded.hitVolumes, mesh);
        } else if (hitboxKind && loaded.bounds) {
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
 *
 * style: { game ('BK'), color, describe, fallback, scaleOf(prop), hitbox?(prop),
 *   tintOf?(prop) -> [r, g, b] in 0..1 (default: BK's rgbRemove),
 *   translucent? (blend without writing depth, for glows and flames), opacity? (1),
 *   animator?(prop, sprite, setFrame(frame, mirrored)) -> update(tick) or
 *   null: the caller animates the instance itself instead of the sheet's cycle }
 */
export function addSpriteRow(scene, groupBody, rowName, instances, entry, checked, style = SPRITE_PROP_STYLE) {
    if (!entry || !entry.frames.length) {
        addTypeRow(scene, groupBody, rowName, instances, style.color, checked, style.fallback);
        return;
    }
    const game = style.game ?? 'BK';

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
            // behind the ones in front of it. Glows and flames blend
            // instead, drawn after the cutouts.
            material = new THREE.SpriteMaterial({
                map: spriteTexture(frame.file, mirrored, game),
                color: new THREE.Color(tint[0], tint[1], tint[2]),
                transparent: true,
                opacity: style.opacity ?? 1,
                alphaTest: style.translucent ? 0 : 0.05,
                depthWrite: !style.translucent,
            });
            materials.set(key, material);
        }
        return material;
    };
    const animated = entry.anim && entry.anim.mode !== 0 && entry.frames.length > 1;

    for (const prop of instances) {
        const frame = entry.frames[Math.min(prop.frame ?? 0, entry.frames.length - 1)];
        const tint = style.tintOf ? style.tintOf(prop) : (prop.rgbRemove ?? [0, 0, 0]).map(v => (0xFF - v * 0x10) / 0xFF);
        const mirrored = !!(prop.isMirrored ?? 0);
        const material = materialFor(prop.frame ?? 0, tint, mirrored);

        const sprite = new THREE.Sprite(material);
        sprite.name = rowName;
        sprite.position.set(prop.position[0], prop.position[1], prop.position[2]);
        // world size before the prop's own scale
        const scale = style.scaleOf(prop);
        sprite.scale.set(entry.world_w * scale, entry.world_h * scale, 1);
        setSpriteFrame(sprite, material, frame, mirrored);
        if (style.translucent) sprite.renderOrder = 2;
        sprite.userData.bkInfo = style.describe(prop);
        sprite.userData.bkProp = prop;
        typeGroup.add(sprite);

        const hitboxKind = style.hitbox?.(prop);
        if (hitboxKind) {
            const size = Math.max(entry.world_w, entry.world_h) * scale;
            addActorHitbox(typeGroup, hitboxKind, prop.position, [0, size / 2, 0], size / 2, sprite);
        }

        if (style.animator) {
            const setFrame = (f, m = false) => setSpriteFrame(sprite, materialFor(f, tint, m), entry.frames[Math.min(f, entry.frames.length - 1)], m);
            const update = style.animator(prop, sprite, setFrame);
            if (update) animatedSprites.push({ sprite, update });
        } else if (animated) {
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
    currentMapId = mapId;
    resetSetupState();

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
        actorNodes.push(...spawnActorChildren(actorNodes));
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
