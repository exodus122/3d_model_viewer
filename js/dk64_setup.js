import * as THREE from 'three';
import { addModelCheckbox, getModelGroup, resetGroupModelState, applyGroupMasterState } from './render.js';
import { parseDK64PropModel, parseDK64ActorModel, buildDK64Parts, loadDK64Texture, animateDK64Materials } from './dk64_map.js';

////////////////////////////////////////
// System: Donkey Kong 64 objects
////////////////////////////////////////
//
// The objects a DK64 map places, from the files tools/dk64/extract_dk64_maps.py
// writes next to the map (formats in its header comment):
//   setup.bin     props (model2, pointer table 4 models: models/DK64/props/)
//                 and actor spawners (pointer table 5 models: models/DK64/actors/,
//                 picked by DK64_Setup_Actor_Models)
//   spawners.bin  enemy spawners (models by DK64_Enemy_Types)
// Each type is a row; objects without a model (triggers, controllers, the
// sprite-drawn pickups) are markers.

const GROUPS = [
    ['dk64-props', 'Props'],
    ['dk64-pickups', 'Pickups (sprites)'],
    ['dk64-actors', 'Actors'],
    ['dk64-enemies', 'Enemies'],
];

const COLORS = { prop: 0x8fb8ff, pickup: 0xffd23a, actor: 0xff9a3a, enemy: 0xff4a4a };

// Actors are drawn at 0.15 of their model's units (func_806134B4); a setup
// spawner's scale and an enemy spawner's scale byte (50 = 1) multiply that.
const ACTOR_SCALE = 0.15;
const ENEMY_SCALE_ONE = 50;
const YAW_UNITS = 4096;

const hex = (v, n = 2) => '0x' + v.toString(16).toUpperCase().padStart(n, '0');

/** setup.bin: { props: [...], actors: [...] } */
export function parseDK64Setup(buffer) {
    const dv = new DataView(buffer);
    const props = [], actors = [];
    if (dv.byteLength < 4) return { props, actors };
    const propCount = dv.getUint32(0, false);
    for (let i = 0; i < propCount; i++) {
        const o = 4 + 0x30 * i;
        props.push({
            index: i,
            position: [dv.getFloat32(o, false), dv.getFloat32(o + 4, false), dv.getFloat32(o + 8, false)],
            scale: dv.getFloat32(o + 0xC, false),
            rotation: [dv.getFloat32(o + 0x18, false), dv.getFloat32(o + 0x1C, false), dv.getFloat32(o + 0x20, false)],
            type: dv.getInt16(o + 0x28, false),
            id: dv.getUint16(o + 0x2A, false),
        });
    }
    let o = 4 + 0x30 * propCount;
    o += 4 + 0x24 * dv.getUint32(o, false);
    const actorCount = dv.getUint32(o, false);
    for (let i = 0; i < actorCount; i++) {
        const a = o + 4 + 0x38 * i;
        actors.push({
            index: i,
            position: [dv.getFloat32(a, false), dv.getFloat32(a + 4, false), dv.getFloat32(a + 8, false)],
            scale: dv.getFloat32(a + 0xC, false),
            yaw: dv.getInt16(a + 0x30, false),
            actor: dv.getInt16(a + 0x32, false) + 0x10,
            id: dv.getUint16(a + 0x34, false),
        });
    }
    return { props, actors };
}

/** spawners.bin: the enemy spawners (fences are skipped). */
export function parseDK64Spawners(buffer) {
    const dv = new DataView(buffer);
    const enemies = [];
    if (dv.byteLength < 2) return enemies;
    let o = 2;
    for (let f = dv.getUint16(0, false); f > 0; f--) {
        o += 2 + 6 * dv.getUint16(o, false);
        o += 2 + 10 * dv.getUint16(o, false);
        o += 4;
    }
    if (o + 2 > dv.byteLength) return enemies;
    const count = dv.getUint16(o, false);
    o += 2;
    for (let i = 0; i < count && o + 0x16 <= dv.byteLength; i++) {
        enemies.push({
            index: i,
            type: dv.getUint8(o),
            yaw: dv.getUint16(o + 2, false),
            position: [dv.getInt16(o + 4, false), dv.getInt16(o + 6, false), dv.getInt16(o + 8, false)],
            scaleByte: dv.getUint8(o + 0xF),
            spawnTrigger: dv.getUint8(o + 0x13),
        });
        o += 0x16 + 2 * dv.getUint8(o + 0x11);
    }
    return enemies;
}

const actorName = id => DK64_Actor_Names[id] ?? `Actor ${id}`;

// model file -> Promise<parts | null>, kept across maps
const modelCache = new Map();

function loadModel(kind, id) {
    const key = kind + id;
    if (!modelCache.has(key)) {
        const file = `./models/DK64/${kind}/${id.toString(16).toUpperCase().padStart(4, '0')}.bin`;
        modelCache.set(key, fetch(file)
            .then(res => res.ok ? res.arrayBuffer() : null)
            .then(buffer => {
                if (!buffer) return null;
                const batches = kind === 'props' ? parseDK64PropModel(buffer) : parseDK64ActorModel(buffer);
                return batches && batches.length ? buildDK64Parts(batches) : null;
            })
            .catch(err => { console.warn(`${file}: ${err.message}`); return null; }));
    }
    return modelCache.get(key);
}

// Sprite-drawn props (pickups, plants, trees): DK64_Prop_Sprites quads, from
// the extractor's prop_sprite_quads. Each quad is a textured rectangle in the
// x / y plane standing on the prop's position; t = 0 is its bottom edge.
const spriteCache = new Map();   // prop type -> Promise<{ geometry, materials } | null>

function loadSprite(type) {
    if (!spriteCache.has(type)) {
        const quads = DK64_Prop_Sprites[type];
        spriteCache.set(type, !quads ? Promise.resolve(null) : (async () => {
            const positions = [], uvs = [], materials = [];
            const geometry = new THREE.BufferGeometry();
            for (const [i, q] of quads.entries()) {
                for (const k of [0, 1, 2, 0, 2, 3]) {
                    positions.push(q.x[k], q.y[k], q.z[k]);
                    uvs.push(q.s[k] / 32 / q.w, q.t[k] / 32 / q.h);
                }
                geometry.addGroup(i * 6, 6, i);
                const info = { width: q.w, height: q.h, fmt: q.fmt, siz: q.siz };
                const frames = q.frames?.length > 1
                    ? (await Promise.all(q.frames.map(f => loadDK64Texture(f, info, q.pal)))).filter(Boolean)
                    : [];
                const map = frames[0] ?? await loadDK64Texture(q.tex, info, q.pal);
                // Cut out on alpha rather than blended: the opaque pass draws
                // (and depth-writes) them before any translucent surface, so
                // water and the map's XLU parts in front cover them. Blended,
                // three.js sorted them against the whole map mesh's centre and
                // they could draw over water in front of them.
                const material = new THREE.MeshBasicMaterial({
                    map, color: map ? 0xffffff : COLORS.pickup, alphaTest: 0.3, side: THREE.DoubleSide,
                });
                if (frames.length > 1) material.userData.animation = { frames, delay: Math.max(1, q.delay) };
                // (stepped by animateDK64Materials, at the game's 30 Hz)
                materials.push(material);
            }
            geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
            geometry.setAttribute('uv', new THREE.Float32BufferAttribute(uvs, 2));
            geometry.computeBoundingSphere();
            return { geometry, materials, sprite: true };
        })());
    }
    return spriteCache.get(type);
}

// Sprites turn about y to face the camera, and step through their animation
// frames (coins spinning, bananas turning, flames; animateDK64Materials).
const _spritePos = new THREE.Vector3();
function spriteBeforeRender(renderer, scene, camera) {
    this.getWorldPosition(_spritePos);
    this.rotation.y = Math.atan2(camera.position.x - _spritePos.x, camera.position.z - _spritePos.z);
    this.updateMatrixWorld(true);
    animateDK64Materials(this.material);
}

// Props with animated textures (grass, flowers, lamps) step them the same way.
function animatedBeforeRender() {
    animateDK64Materials(this.material);
}

const markerGeometry = new THREE.OctahedronGeometry(12);

function markerMesh(color) {
    return new THREE.Mesh(markerGeometry, new THREE.MeshBasicMaterial({ color, wireframe: true }));
}

function addRow(scene, groupBody, rowName, list, parts, color, place, describe) {
    const row = new THREE.Group();
    row.name = rowName;
    for (const item of list) {
        const mesh = parts ? new THREE.Mesh(parts.geometry, parts.materials) : markerMesh(color);
        place(item, mesh, !!parts);
        if (parts?.sprite) {
            mesh.rotation.set(0, 0, 0);
            mesh.onBeforeRender = spriteBeforeRender;
        } else if (parts?.animated) {
            mesh.onBeforeRender = animatedBeforeRender;
        }
        mesh.userData.bkInfo = describe(item);
        mesh.userData.textured = true;   // keeps its own materials (main.js setMaterialProps)
        row.add(mesh);
    }
    scene.add(row);
    loadedModels.push({ name: rowName, root: row, mesh: row, edges: null });
    // Textured rows get no colour swatch (colorTarget false): the swatch tints
    // the row's first material, which would recolour the model. Marker rows do.
    const swatch = '#' + color.toString(16).padStart(6, '0');
    addModelCheckbox(scene, rowName, row, null, false, true, swatch, false, parts ? false : null, groupBody);
}

function placeProp(prop, mesh, hasModel) {
    mesh.position.set(...prop.position);
    if (hasModel) {
        // scale, rotate x, y, z (degrees), translate (global_asm func_8066C2D0)
        const r = prop.rotation.map(THREE.MathUtils.degToRad);
        mesh.rotation.set(r[0], r[1], r[2], 'ZYX');
        mesh.scale.setScalar(prop.scale);
    }
}

function placeActor(actor, mesh, hasModel) {
    mesh.position.set(...actor.position);
    mesh.rotation.y = (actor.yaw / YAW_UNITS) * Math.PI * 2;
    if (hasModel) mesh.scale.setScalar(ACTOR_SCALE * (actor.scale || 1));
}

function placeEnemy(enemy, mesh, hasModel) {
    mesh.position.set(...enemy.position);
    mesh.rotation.y = ((enemy.yaw & 0xFFF) / YAW_UNITS) * Math.PI * 2;
    if (hasModel) mesh.scale.setScalar(ACTOR_SCALE * ((enemy.scaleByte || ENEMY_SCALE_ONE) / ENEMY_SCALE_ONE));
}

const fmtPos = p => p.map(v => Math.round(v * 10) / 10).join(', ');

function groupBy(list, key) {
    const out = new Map();
    for (const item of list) {
        const k = key(item);
        if (!out.has(k)) out.set(k, []);
        out.get(k).push(item);
    }
    return out;
}

const rowLabel = (name, list) => list.length > 1 ? `${name} (x${list.length})` : name;

/** Draw a DK64 map's props, actors and enemies (one row per type). */
export async function renderDK64Setup(scene, setupBuffer, spawnersBuffer) {
    for (const [key] of GROUPS) resetGroupModelState(key);
    const { props, actors } = parseDK64Setup(setupBuffer);
    const enemies = spawnersBuffer ? parseDK64Spawners(spawnersBuffer) : [];

    const propName = type => {
        const info = DK64_Prop_Info[type];
        return `Prop ${hex(type, 3)}` + (info?.[1] ? ` (${info[1]})` : '');
    };
    const modelProps = props.filter(p => DK64_Prop_Info[p.type]?.[0] === 1);
    const pickups = props.filter(p => DK64_Prop_Info[p.type]?.[0] !== 1);

    // props
    if (modelProps.length) {
        const group = getModelGroup('dk64-props', 'Props');
        const byType = [...groupBy(modelProps, p => p.type)].sort((a, b) => a[0] - b[0]);
        const parts = await Promise.all(byType.map(([type]) => loadModel('props', type)));
        byType.forEach(([type, list], i) => addRow(scene, group.body, rowLabel(propName(type), list), list, parts[i],
            COLORS.prop, placeProp,
            p => `${propName(p.type)} #${p.index}, id ${p.id}\npos ${fmtPos(p.position)}, scale ${p.scale.toFixed(2)}, rot ${fmtPos(p.rotation)}`));
    }
    if (pickups.length) {
        const group = getModelGroup('dk64-pickups', 'Pickups (sprites)');
        const byType = [...groupBy(pickups, p => p.type)].sort((a, b) => a[0] - b[0]);
        const sprites = await Promise.all(byType.map(([type]) => loadSprite(type)));
        byType.forEach(([type, list], i) => addRow(scene, group.body, rowLabel(propName(type), list), list, sprites[i],
            COLORS.pickup, placeProp,
            p => `${propName(p.type)} #${p.index}, id ${p.id}\npos ${fmtPos(p.position)}, scale ${p.scale.toFixed(2)}`));
    }

    // setup actors
    if (actors.length) {
        const group = getModelGroup('dk64-actors', 'Actors');
        const byType = [...groupBy(actors, a => a.actor)].sort((a, b) => actorName(a[0]).localeCompare(actorName(b[0])));
        const parts = await Promise.all(byType.map(([actor]) =>
            DK64_Setup_Actor_Models[actor] ? loadModel('actors', DK64_Setup_Actor_Models[actor]) : null));
        byType.forEach(([actor, list], i) => addRow(scene, group.body, rowLabel(actorName(actor), list), list, parts[i],
            COLORS.actor, placeActor,
            a => `${actorName(a.actor)} (actor ${a.actor}) #${a.index}, id ${a.id}\npos ${fmtPos(a.position)}, ` +
                 `yaw ${Math.round(a.yaw * 360 / YAW_UNITS)}, scale ${a.scale.toFixed(2)}` +
                 (DK64_Setup_Actor_Models[a.actor] ? `, model ${DK64_Setup_Actor_Models[a.actor]}` : ', no model')));
    }

    // enemies
    if (enemies.length) {
        const group = getModelGroup('dk64-enemies', 'Enemies');
        const enemyActor = type => DK64_Enemy_Types[type]?.[0] ?? 0;
        const enemyName = type => enemyActor(type) ? actorName(enemyActor(type)) : `Enemy type ${type}`;
        const byType = [...groupBy(enemies, e => e.type)].sort((a, b) => enemyName(a[0]).localeCompare(enemyName(b[0])));
        const parts = await Promise.all(byType.map(([type]) => {
            const model = DK64_Enemy_Types[type]?.[1];
            return model ? loadModel('actors', model) : null;
        }));
        byType.forEach(([type, list], i) => addRow(scene, group.body, rowLabel(enemyName(type), list), list, parts[i],
            COLORS.enemy, placeEnemy,
            e => `${enemyName(e.type)} (enemy type ${e.type}) #${e.index}\npos ${fmtPos(e.position)}, ` +
                 `yaw ${Math.round((e.yaw & 0xFFF) * 360 / YAW_UNITS)}, scale ${e.scaleByte}, spawn trigger ${e.spawnTrigger}`));
    }

    for (const [key] of GROUPS) applyGroupMasterState(key);
    console.log(`DK64 setup: ${modelProps.length} props, ${pickups.length} pickups, ${actors.length} actors, ${enemies.length} enemies`);
}
