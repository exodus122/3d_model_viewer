import * as THREE from 'three';
import { addModelCheckbox, getModelGroup, resetGroupModelState, applyGroupMasterState } from './render.js';
import { parseDK64PropModel, parseDK64ActorModel, parseDK64PropCollision, parseDK64ActorCollision, buildDK64Parts,
         loadDK64Texture, animateDK64Materials } from './dk64_map.js';

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
//   triggers.bin  trigger cylinders; the loading zones among them are drawn
// Each type is a row; objects without a model (triggers, controllers, the
// sprite-drawn pickups) are markers.

// Actors are split as BK / BT's are: those whose model has standable
// collision, and the rest (hit spheres only, or model-less triggers).
const GROUPS = [
    ['dk64-props', 'Props'],
    ['dk64-pickups', 'Pickups (sprites)'],
    ['dk64-actors', 'Actors (collision)'],
    ['dk64-actors-hitbox', 'Actors (hitbox only)'],
    ['dk64-enemies', 'Enemies'],
    ['dk64-loading-zones', 'Loading zones'],
];

const COLORS = { prop: 0x8fb8ff, pickup: 0xffd23a, actor: 0xff9a3a, enemy: 0xff4a4a, loadingZone: 0x3aff8c };

// Actors are drawn at 0.15 of their model's units (func_806134B4); a setup
// spawner's scale and an enemy spawner's scale byte (50 = 1) multiply that.
const ACTOR_SCALE = 0.15;
const ENEMY_SCALE_ONE = 50;
const YAW_UNITS = 4096;

const hex = (v, n = 2) => '0x' + v.toString(16).toUpperCase().padStart(n, '0');

/**
 * triggers.bin (pointer table 18, global_asm/done/triggers.c): s16 count, then
 * 0x38-byte cylinders: s16 x, y, z, radius, height (-1 = no vertical limit),
 * ..., u8 command count at +0x0E, 4 commands of (s16 type, u16 args[4]) at
 * +0x10. A command is a message to the loading zone controller; these types
 * load a map (args: map, exit) -- they link back to each other across maps.
 * The rest (camera / cutscene regions, ...) take no destination.
 */
const LOADING_ZONE_TYPES = new Set([9, 12, 13, 16, 17]);
// An unbounded zone is drawn this tall above its base.
const UNBOUNDED_HEIGHT = 150;

export function parseDK64LoadingZones(buffer) {
    const zones = [];
    if (!buffer || buffer.byteLength < 2) return zones;
    const dv = new DataView(buffer);
    const count = dv.getInt16(0, false);
    for (let i = 0; i < count && 2 + 0x38 * (i + 1) <= dv.byteLength; i++) {
        const o = 2 + 0x38 * i;
        const commands = Math.min(dv.getUint8(o + 0xE), 4);
        for (let k = 0; k < commands; k++) {
            const c = o + 0x10 + 10 * k;
            const type = dv.getInt16(c, false);
            if (!LOADING_ZONE_TYPES.has(type)) continue;
            zones.push({
                index: i,
                position: [dv.getInt16(o, false), dv.getInt16(o + 2, false), dv.getInt16(o + 4, false)],
                radius: dv.getInt16(o + 6, false),
                height: dv.getInt16(o + 8, false),
                type,
                map: dv.getUint16(c + 2, false),
                exit: dv.getUint16(c + 4, false),
            });
            break;
        }
    }
    return zones;
}

const zoneGeometry = new THREE.CylinderGeometry(1, 1, 1, 24, 1, true).translate(0, 0.5, 0);
const zoneEdges = new THREE.EdgesGeometry(new THREE.CylinderGeometry(1, 1, 1, 24, 1).translate(0, 0.5, 0));

function loadingZoneMesh() {
    const mesh = new THREE.Mesh(zoneGeometry, new THREE.MeshBasicMaterial({ color: COLORS.loadingZone, transparent: true,
        opacity: 0.25, side: THREE.DoubleSide, depthWrite: false }));
    const edges = new THREE.LineSegments(zoneEdges, new THREE.LineBasicMaterial({ color: COLORS.loadingZone }));
    edges.userData.unselectable = true;
    mesh.add(edges);
    return mesh;
}

function placeLoadingZone(zone, mesh) {
    mesh.position.set(...zone.position);
    mesh.scale.set(zone.radius, zone.height < 0 ? UNBOUNDED_HEIGHT : zone.height, zone.radius);
}

const dk64MapName = id => DK64_Maps.find(m => m.mapID === id)?.name ?? `map ${id}`;

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
                if (!batches || !batches.length) return null;
                return buildDK64Parts(batches).then(parts => {
                    // The flat view (Textures off): BK / BT's colours, flat shaded
                    // (the display lists carry no normals), edges with the wireframe.
                    const flat = PLAIN_STYLES[kind];
                    parts.plainMaterial = flat.material;
                    parts.plainEdgeMaterial = flat.edges;
                    parts.plainEdges = new THREE.WireframeGeometry(parts.geometry);
                    if (kind === 'props') {
                        parts.rawCollision = parseDK64PropCollision(buffer);
                        parts.collision = buildCollisionGeometry(parts.rawCollision);
                    } else {
                        // actors: hit spheres, and standable collision for some (boulders, cages)
                        const collision = parseDK64ActorCollision(buffer);
                        parts.hitSpheres = collision?.spheres ?? [];
                        parts.collision = collision ? buildCollisionGeometry(collision) : null;
                    }
                    return parts;
                });
            })
            .catch(err => { console.warn(`${file}: ${err.message}`); return null; }));
    }
    return modelCache.get(key);
}

// --- prop collision ------------------------------------------------------------
//
// The "Prop/actor collision" checkbox, as for BK / BT (bk_textured.js): with
// Textures on, each prop's collision (parseDK64PropCollision) is drawn
// translucent over its textured model; with Textures off it replaces the
// model, which is otherwise drawn in a flat colour. Floors, walls and
// triangles that are both get their own colours, and the "Draw triangle
// edges" checkbox outlines the triangles.
const texturesCheckbox = document.getElementById('bkTextures');
const propCollisionCheckbox = document.getElementById('bkPropCollision');
const wireframeCheckbox = document.getElementById('wireframe');

// Kept apart from the map collision's blue. Some props (Factory's platforms)
// list every triangle as both a floor and a wall; those are drawn once, in
// their own colour.
const COLLISION_COLORS = {
    floor: new THREE.Color(0xffb030), wall: new THREE.Color(0xff5a8c), both: new THREE.Color(0xb070ff),
};
const collisionSolid = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide });
// Drawn after the map's translucent parts and water (renderOrder 1), still depth-tested.
const collisionOverlay = new THREE.MeshLambertMaterial({ vertexColors: true, side: THREE.DoubleSide,
    transparent: true, opacity: 0.5, depthWrite: false });
const collisionEdgeMaterial = new THREE.LineBasicMaterial({ color: 0x10203a, transparent: true, opacity: 0.8 });
const COLLISION_OVERLAY_ORDER = 2;

/**
 * Non-indexed collision geometry, each triangle once and coloured as a floor,
 * a wall, or both, plus its edges; null without collision.
 */
function buildCollisionGeometry({ floors, walls }) {
    if (!floors.length && !walls.length) return null;
    // A triangle's key: its corners in sorted order, so either list's winding matches.
    const key = (corners, i) => {
        const p = [0, 1, 2].map(k => `${corners[i + 3 * k]},${corners[i + 3 * k + 1]},${corners[i + 3 * k + 2]}`);
        return p.sort().join('|');
    };
    const triangles = new Map();   // key -> { corners, floor, wall }
    const add = (corners, kind) => {
        for (let i = 0; i < corners.length; i += 9) {
            const k = key(corners, i);
            if (!triangles.has(k)) triangles.set(k, { corners: corners.subarray(i, i + 9), floor: false, wall: false });
            triangles.get(k)[kind] = true;
        }
    };
    add(floors, 'floor');
    add(walls, 'wall');

    const positions = new Float32Array(triangles.size * 9);
    const colors = new Float32Array(triangles.size * 9);
    const counts = { floor: 0, wall: 0, both: 0 };
    let o = 0;
    for (const t of triangles.values()) {
        const kind = t.floor && t.wall ? 'both' : t.floor ? 'floor' : 'wall';
        counts[kind]++;
        const c = COLLISION_COLORS[kind];
        positions.set(t.corners, o);
        for (let k = 0; k < 9; k += 3) { colors[o + k] = c.r; colors[o + k + 1] = c.g; colors[o + k + 2] = c.b; }
        o += 9;
    }
    const geometry = new THREE.BufferGeometry();
    geometry.setAttribute('position', new THREE.BufferAttribute(positions, 3));
    geometry.setAttribute('color', new THREE.BufferAttribute(colors, 3));
    geometry.computeVertexNormals();
    geometry.computeBoundingSphere();
    const summary = [counts.floor && `${counts.floor} floor`, counts.wall && `${counts.wall} wall`,
                     counts.both && `${counts.both} floor+wall`].filter(Boolean).join(', ') + ' triangles';
    return { geometry, edges: new THREE.WireframeGeometry(geometry), summary };
}

// The flat view of a model with Textures off: BK / BT's model-prop purple and
// actor orange (bk_setup.js MODEL_COLOR / ACTOR_COLOR and their edge colours).
const PLAIN_STYLES = {
    props: {
        material: new THREE.MeshLambertMaterial({ color: 0xc77dff, side: THREE.DoubleSide, flatShading: true,
            polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 }),
        edges: new THREE.LineBasicMaterial({ color: 0x5a2d8a, transparent: true, opacity: 0.8 }),
    },
    actors: {
        material: new THREE.MeshLambertMaterial({ color: 0xff7b24, side: THREE.DoubleSide, flatShading: true,
            polygonOffset: true, polygonOffsetFactor: 1, polygonOffsetUnits: 1 }),
        edges: new THREE.LineBasicMaterial({ color: 0x8a3d10, transparent: true, opacity: 0.8 }),
    },
};

// { textured, plain, plainEdges, collision, edges } per model placement in the current map
const propViews = [];

// Each placed prop's collision (parseDK64PropCollision), setup id and
// placement matrix, for the ledge markers (getDK64PropCollisionWorld).
const propCollisionPlacements = [];

/**
 * The prop setup ids whose behaviour script (scripts.bin, pointer table 10)
 * lets their floors be ledge-grabbed: script command 0x39 with a non-zero
 * argument sets the prop's Prop_ScriptData +0x4F (code_42630.c), which the
 * floor query (asm 0x806694D8) requires for a prop floor; without it (or
 * without a script) a prop's floors can't be grabbed. The file: u16 script
 * count, then per script u16 prop id, u16 block count, u16; per block u16
 * condition count + 8-byte instructions, u16 execution count + 8-byte
 * instructions (s16 opcode, s16 args[3]). Conditions aren't evaluated: any
 * 0x39 with a non-zero argument counts.
 */
export function parseDK64LedgeScripts(buffer) {
    const ids = new Set();
    if (!buffer || buffer.byteLength < 2) return ids;
    const dv = new DataView(buffer);
    let o = 2;
    try {
        for (let s = dv.getUint16(0, false); s > 0; s--) {
            const id = dv.getUint16(o, false), blocks = dv.getUint16(o + 2, false);
            o += 6;
            for (let b = 0; b < blocks; b++) {
                o += 2 + 8 * dv.getUint16(o, false);
                const executions = dv.getUint16(o, false);
                o += 2;
                for (let k = 0; k < executions; k++, o += 8) {
                    if (dv.getInt16(o, false) === 0x39 && dv.getInt16(o + 2, false) !== 0) ids.add(id);
                }
            }
        }
    } catch { /* truncated: keep what was read */ }
    return ids;
}

const FLOOR_FLAG_NO_LEDGE_GRAB = 0x0008;   // as dk64_map.js findDK64Ledges

/**
 * The current map's prop collision in world units, as parseDK64Collision
 * gives a map's: { floors: { verts, tris, info }, walls: { verts, tris } }.
 * Floors of props not in `grabbableIds` (parseDK64LedgeScripts) carry the
 * no-grab flag.
 */
export function getDK64PropCollisionWorld(grabbableIds = new Set()) {
    const floors = { verts: [], tris: [], info: [] }, walls = { verts: [], tris: [] };
    const v = new THREE.Vector3();
    for (const { raw, matrix, id } of propCollisionPlacements) {
        const flag = grabbableIds.has(id) ? 0 : FLOOR_FLAG_NO_LEDGE_GRAB;
        for (const [corners, out, isFloor] of [[raw.floors, floors, true], [raw.walls, walls, false]]) {
            for (let t = 0; t + 9 <= corners.length; t += 9) {
                const base = out.verts.length;
                for (let k = 0; k < 3; k++) {
                    v.set(corners[t + 3 * k], corners[t + 3 * k + 1], corners[t + 3 * k + 2]).applyMatrix4(matrix);
                    out.verts.push([v.x, v.y, v.z]);
                }
                out.tris.push([base, base + 1, base + 2]);
                if (isFloor) out.info.push({ fields: [flag, 0, 0], prop: id });
            }
        }
    }
    return { floors, walls };
}

function refreshPropViews() {
    const textured = texturesCheckbox ? texturesCheckbox.checked : true;
    const showCollision = propCollisionCheckbox ? propCollisionCheckbox.checked : false;
    for (const view of propViews) {
        const collision = showCollision && view.collision;
        view.textured.visible = textured;
        view.plain.visible = !textured && !collision;
        view.plainEdges.visible = view.plain.visible && wireframeCheckbox.checked;
        if (!view.collision) continue;
        view.collision.visible = !!collision;
        view.collision.material = textured ? collisionOverlay : collisionSolid;
        view.collision.renderOrder = textured ? COLLISION_OVERLAY_ORDER : 0;
        view.edges.visible = !!collision && wireframeCheckbox.checked;
    }
}
for (const control of [texturesCheckbox, propCollisionCheckbox, wireframeCheckbox]) {
    control?.addEventListener('change', refreshPropViews);
}

/** A prop placement: its textured model, the same in a flat colour, and its collision. */
function propInstance(parts, describe) {
    const group = new THREE.Group();
    const info = describe;
    const textured = new THREE.Mesh(parts.geometry, parts.materials);
    if (parts.animated) textured.onBeforeRender = animatedBeforeRender;
    const plain = new THREE.Mesh(parts.geometry, parts.plainMaterial);
    const plainEdges = new THREE.LineSegments(parts.plainEdges, parts.plainEdgeMaterial);
    plainEdges.userData.unselectable = true;
    group.add(textured, plain, plainEdges);
    const view = { textured, plain, plainEdges, collision: null, edges: null };
    if (parts.collision) {
        view.collision = new THREE.Mesh(parts.collision.geometry, collisionSolid);
        view.edges = new THREE.LineSegments(parts.collision.edges, collisionEdgeMaterial);
        view.edges.userData.unselectable = true;
        view.collision.userData.bkInfo = `${info}\ncollision: ${parts.collision.summary}`;
        group.add(view.collision, view.edges);
    }
    for (const mesh of [textured, plain]) mesh.userData.bkInfo = info + (parts.collision
        ? `\ncollision: ${parts.collision.summary}` : '\nno collision');
    textured.userData.textured = plain.userData.textured = true;   // keep their own materials (main.js setMaterialProps)
    propViews.push(view);
    return group;
}

// --- actor hitboxes ------------------------------------------------------------
//
// An actor model's hit spheres (parseDK64ActorCollision), drawn as wireframes
// under the "Actor hitboxes" checkboxes as for BK / BT: enemies red, the other
// actors (barrels, cannons, switches...) cyan as "touch". They hang under the
// placed model, so they take its position, yaw and scale; spheres on a bone
// are in the rest pose. Not pickable: their details go on the actor's text.
const hitboxCheckboxes = {
    enemy: document.getElementById('bkActorHitboxesEnemy'),
    touch: document.getElementById('bkActorHitboxesTouch'),
};
const hitboxMaterials = {
    enemy: new THREE.MeshBasicMaterial({ color: 0xff4a4a, wireframe: true, transparent: true, opacity: 0.6 }),
    touch: new THREE.MeshBasicMaterial({ color: 0x2ee6ff, wireframe: true, transparent: true, opacity: 0.6 }),
};
const hitSphereGeometry = new THREE.SphereGeometry(1, 12, 8);
const hitboxes = [];   // every hit sphere in the current map

function addHitSpheres(host, kind, spheres) {
    if (!spheres?.length) return;
    const lines = [`\n${kind} hitbox: ${spheres.length} sphere${spheres.length > 1 ? 's' : ''} (model units)`];
    for (const s of spheres) {
        const mesh = new THREE.Mesh(hitSphereGeometry, hitboxMaterials[kind]);
        mesh.position.set(...s.center);
        mesh.scale.setScalar(Math.max(s.radius, 1));
        mesh.visible = !!hitboxCheckboxes[kind]?.checked;
        mesh.userData.unselectable = true;
        mesh.userData.hitboxKind = kind;
        host.add(mesh);
        hitboxes.push(mesh);
        lines.push(`  sphere r=${s.radius.toFixed(1)} at (${s.center.map(v => v.toFixed(0)).join(', ')})` +
            (s.bone >= 0 ? ` bone ${s.bone}` : ''));
    }
    const text = lines.join('\n');
    host.traverse(child => { if (child.userData.bkInfo && !child.userData.unselectable) child.userData.bkInfo += text; });
}

for (const [kind, checkbox] of Object.entries(hitboxCheckboxes)) {
    checkbox?.addEventListener('change', () => {
        for (const mesh of hitboxes) if (mesh.userData.hitboxKind === kind) mesh.visible = checkbox.checked;
    });
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
    if (color === COLORS.loadingZone) return loadingZoneMesh();
    return new THREE.Mesh(markerGeometry, new THREE.MeshBasicMaterial({ color, wireframe: true }));
}

function addRow(scene, groupBody, rowName, list, parts, color, place, describe, hitboxKind = null) {
    const row = new THREE.Group();
    row.name = rowName;
    for (const item of list) {
        if (parts?.plainMaterial) {
            // a model with collision views: textured / flat / collision (propInstance)
            const instance = propInstance(parts, describe(item));
            place(item, instance, true);
            if (parts.rawCollision) {
                instance.updateMatrix();
                propCollisionPlacements.push({ raw: parts.rawCollision, matrix: instance.matrix.clone(), id: item.id });
            }
            if (hitboxKind) addHitSpheres(instance, hitboxKind, parts.hitSpheres);
            row.add(instance);
            continue;
        }
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
        if (hitboxKind && parts) addHitSpheres(mesh, hitboxKind, parts.hitSpheres);
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
export async function renderDK64Setup(scene, setupBuffer, spawnersBuffer, triggersBuffer) {
    for (const [key] of GROUPS) resetGroupModelState(key);
    propViews.length = 0;
    propCollisionPlacements.length = 0;
    hitboxes.length = 0;
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

    // setup actors, split by whether their model has standable collision
    if (actors.length) {
        const byType = [...groupBy(actors, a => a.actor)].sort((a, b) => actorName(a[0]).localeCompare(actorName(b[0])));
        const parts = await Promise.all(byType.map(([actor]) =>
            DK64_Setup_Actor_Models[actor] ? loadModel('actors', DK64_Setup_Actor_Models[actor]) : null));
        byType.forEach(([actor, list], i) => {
            const group = parts[i]?.collision ? getModelGroup('dk64-actors', 'Actors (collision)')
                                              : getModelGroup('dk64-actors-hitbox', 'Actors (hitbox only)');
            addRow(scene, group.body, rowLabel(actorName(actor), list), list, parts[i], COLORS.actor, placeActor,
                a => `${actorName(a.actor)} (actor ${a.actor}) #${a.index}, id ${a.id}\npos ${fmtPos(a.position)}, ` +
                     `yaw ${Math.round(a.yaw * 360 / YAW_UNITS)}, scale ${a.scale.toFixed(2)}` +
                     (DK64_Setup_Actor_Models[a.actor] ? `, model ${DK64_Setup_Actor_Models[a.actor]}` : ', no model'),
                'touch');
        });
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
                 `yaw ${Math.round((e.yaw & 0xFFF) * 360 / YAW_UNITS)}, scale ${e.scaleByte}, spawn trigger ${e.spawnTrigger}`,
            'enemy'));
    }

    // loading zones, one row per destination map
    const zones = parseDK64LoadingZones(triggersBuffer);
    if (zones.length) {
        const group = getModelGroup('dk64-loading-zones', 'Loading zones');
        const byMap = [...groupBy(zones, z => z.map)].sort((a, b) => dk64MapName(a[0]).localeCompare(dk64MapName(b[0])));
        byMap.forEach(([map, list]) => addRow(scene, group.body, rowLabel(`To ${dk64MapName(map)}`, list), list, null,
            COLORS.loadingZone, placeLoadingZone,
            z => `Loading zone #${z.index} -> ${dk64MapName(z.map)} (map ${z.map}), exit ${z.exit}, type ${z.type}
` +
                 `pos ${fmtPos(z.position)}, radius ${z.radius}, height ${z.height < 0 ? 'unbounded' : z.height}`));
    }

    for (const [key] of GROUPS) applyGroupMasterState(key);
    refreshPropViews();
    console.log(`DK64 setup: ${modelProps.length} props, ${pickups.length} pickups, ${actors.length} actors, ${enemies.length} enemies, ${zones.length} loading zones`);
}
