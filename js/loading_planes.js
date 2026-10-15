import * as THREE from 'three';
import { addModelCheckbox, getModelGroup, resetGroupModelState, applyGroupMasterState } from './render.js';

////////////////////////////////////////
// System: OoT / MM loading planes (En_Holl's trigger volumes)
////////////////////////////////////////
//
// En_Holl is the room transition actor of the scene's transition actor list
// (and, in MM, a scene changer). It draws nothing useful itself: what
// matters is where its update reacts to the player. Every kind tests the
// player's position in the actor's own frame (Actor_WorldToActorCoords, so
// rotated by rotY), against a box for the horizontal kinds ("halls": |x| <
// half width, bottom < y < top, then |z| against the plane distances) or a
// cylinder for the vertical ones ("holes": xzDistToPlayer < radius, then
// |yDistToPlayer| against the distances). Each kind is drawn as its zones,
// one slab per side of the central plane, coloured by what it does:
//
//   load     the room on the player's side (or, for the visible kinds, the
//            room beyond) is requested: Room_RequestNewRoom
//   finish   the visible kinds' outer band: Room_FinishRoomChange unloads the
//            room behind the player
//   exit     MM's scene changer: the setup's exit list entry is taken
//   fade     the background cover / plane alpha ramps, nothing loads
//
// Distances are z_en_holl.c's (OoT and MM), with the per-scene changes
// (OoT Spirit Temple, MM Ikana Canyon / Pirates' Fortress). Side 0 is
// local z < 0 (or, vertically, above: yDistToPlayer > 0), the transition
// entry's front room (offset 0); side 1 its back room (offset 2).

const GROUP = 'zelda-loading-planes';
const BINANG_TO_RAD = Math.PI / 0x8000;

const ZONE_COLORS = {
    load: 0xff3030,
    finish: 0x30c060,
    exit: 0xd030ff,
    fade: 0x3080ff,
};
const PLANE_COLOR = 0x101010;

// kind: 'h' (box) or 'v' (cylinder). zones: [{ zone, min, max, side? }] in
// |z| (or |dy|); side 'player' loads the room on the player's side, 'other'
// the room beyond, 1 only sides[1].
function ootKind(type, sceneName) {
    const H = (halfWidth, zones, label) => ({ kind: 'h', halfWidth, bottom: -50, top: 200, zones, label });
    const V = (radius, zones, label) => ({ kind: 'v', radius, zones, label });
    switch (type) {
        case 0: {
            const d = sceneName === 'jyasinzou_scene' ? [100, 75, 50, 25] : [200, 150, 100, 50];
            return H(100, [
                { zone: 'finish', min: d[1], max: d[0], side: 'player' },
                { zone: 'load', min: 0, max: d[1], side: 'other' },
                { zone: 'fade', min: d[3], max: d[2] },
            ], 'H visible narrow');
        }
        case 1: return V(500, [
            { zone: 'fade', min: 95, max: 605 },
            { zone: 'load', min: 0, max: 95, side: 1 },
        ], 'V down bg cover (large)');
        case 2: return V(120, [{ zone: 'load', min: 50, max: 200, side: 'player' }], 'V invisible');
        case 3: return H(200, [
            { zone: 'fade', min: 50, max: 100 },
            { zone: 'load', min: 0, max: 50, side: 'player' },
        ], 'H bg cover (switch flag)');
        case 4: return H(200, [{ zone: 'load', min: 50, max: 100, side: 'player' }], 'H invisible');
        case 5: return V(120, [
            { zone: 'fade', min: 50, max: 200 },
            { zone: 'load', min: 50, max: 200, side: 'player' },
        ], 'V bg cover');
        case 6: return H(100, [{ zone: 'load', min: 50, max: 100, side: 'player' }], 'H invisible narrow');
    }
    return null;
}

function mmKind(type, sceneName) {
    switch (type) {
        case 0: case 4: {
            const ikana = sceneName === 'Z2_IKANA';
            const zones = type === 4
                ? [{ zone: 'exit', min: 0, max: 150 }]
                : [
                    { zone: 'finish', min: 150, max: 200, side: 'player' },
                    { zone: 'load', min: 0, max: 150, side: 'other' },
                    { zone: 'fade', min: 50, max: 100 },
                ];
            return {
                kind: 'h', halfWidth: ikana ? 280 : 150, bottom: ikana ? -90 : -50, top: 200, zones,
                label: type === 4 ? 'H scene changer' : 'H visible',
            };
        }
        case 1: return { kind: 'v', radius: 120, zones: [{ zone: 'load', min: 50, max: 200, side: 'player' }], label: 'V invisible' };
        case 2: return {
            kind: 'h', halfWidth: 200, bottom: -50, top: sceneName === 'Z2_KAIZOKU' ? 280 : 200,
            zones: [{ zone: 'load', min: 50, max: 100, side: 'player' }], label: 'H invisible',
        };
        case 3: return {
            kind: 'v', radius: 120, zones: [
                { zone: 'fade', min: 50, max: 200 },
                { zone: 'load', min: 50, max: 200, side: 'player' },
            ], label: 'V bg cover',
        };
    }
    return null;
}

function holl(inst, game, sceneName) {
    const type = game === 'MM' ? (inst.params >> 7) & 7 : (inst.params >> 6) & 7;
    const k = game === 'MM' ? mmKind(type, sceneName) : ootKind(type, sceneName);
    return k ? { ...k, type } : null;
}

const materials = new Map();
function zoneMaterial(zone, wire) {
    const key = zone + (wire ? ' wire' : '');
    if (!materials.has(key)) {
        const color = zone === 'plane' ? PLANE_COLOR : ZONE_COLORS[zone];
        materials.set(key, wire
            ? new THREE.LineBasicMaterial({ color, transparent: true, opacity: 0.9 })
            : new THREE.MeshBasicMaterial({
                color, transparent: true, opacity: zone === 'plane' ? 0.45 : zone === 'fade' ? 0.12 : 0.22,
                side: THREE.DoubleSide, depthWrite: false,
            }));
    }
    return materials.get(key);
}

// A see-through slab (picking goes through it) with its outline.
function slab(geometry, zone, at) {
    const mesh = new THREE.Mesh(geometry, zoneMaterial(zone, false));
    mesh.position.copy(at);
    mesh.userData.unselectable = true;
    mesh.renderOrder = 2;
    const edges = new THREE.LineSegments(new THREE.EdgesGeometry(geometry), zoneMaterial(zone, true));
    edges.userData.unselectable = true;
    mesh.add(edges);
    return mesh;
}

function sideRoom(inst, h, z) {
    const t = inst.transition;
    if (!t) return null;
    // Horizontal: z < 0 is side 0. Vertical: above (the slab at +y) is side 0.
    return (h.kind === 'h' ? z < 0 : z > 0) ? t.frontRoom : t.backRoom;
}

function zoneText(inst, h, zn) {
    const range = zn.min ? `${zn.min}-${zn.max}` : `< ${zn.max}`;
    const t = inst.transition;
    let what = zn.zone;
    if (zn.zone === 'load' && t) {
        what += zn.side === 1 ? ` room ${t.backRoom}`
            : zn.side === 'other' ? ' the room beyond' : ' the room on that side';
    } else if (zn.zone === 'exit') {
        what += ` exit ${inst.params & 0x7F}`;
    }
    return `${what} at ${h.kind === 'h' ? '|z|' : '|y|'} ${range}`;
}

function describe(inst, h, game) {
    const t = inst.transition;
    const dims = h.kind === 'h'
        ? `box |x| < ${h.halfWidth}, y ${h.bottom}..${h.top}`
        : `cylinder r < ${h.radius}`;
    const rooms = t ? (h.kind === 'h'
        ? ` rooms: -z ${t.frontRoom} / +z ${t.backRoom}`
        : ` rooms: above ${t.frontRoom} / below ${t.backRoom}`) : '';
    const flag = game === 'OOT' && h.type === 3 ? ` switch flag 0x${(inst.params & 0x3F).toString(16)}` : '';
    return `LOADING PLANE En_Holl type ${h.type} (${h.label}): pos=${inst.position.join(', ')}` +
        ` rotY=${(inst.rot[1] / 0x10000 * 360).toFixed(1)} params=0x${inst.params.toString(16).toUpperCase().padStart(4, '0')}` +
        `${flag}; ${dims};${rooms}; ` + h.zones.map(z => zoneText(inst, h, z)).join(', ');
}

function buildHoll(inst, h, game) {
    const g = new THREE.Group();
    g.position.set(inst.position[0], inst.position[1], inst.position[2]);
    g.rotation.y = inst.rot[1] * BINANG_TO_RAD;
    const info = describe(inst, h, game);

    if (h.kind === 'h') {
        const w = h.halfWidth * 2, ht = h.top - h.bottom, cy = (h.top + h.bottom) / 2;
        for (const zn of h.zones) {
            if (zn.min === 0) {
                g.add(slab(new THREE.BoxGeometry(w, ht, zn.max * 2), zn.zone, new THREE.Vector3(0, cy, 0)));
                continue;
            }
            const geom = new THREE.BoxGeometry(w, ht, zn.max - zn.min);
            for (const s of [-1, 1]) g.add(slab(geom, zn.zone, new THREE.Vector3(0, cy, s * (zn.min + zn.max) / 2)));
        }
        const plane = new THREE.Mesh(new THREE.PlaneGeometry(w, ht), zoneMaterial('plane', false));
        plane.position.y = cy;
        plane.userData.bkInfo = info;
        g.add(plane);
    } else {
        for (const zn of h.zones) {
            if (zn.min === 0) {
                g.add(slab(new THREE.CylinderGeometry(h.radius, h.radius, zn.max * 2, 32, 1, true), zn.zone, new THREE.Vector3()));
                continue;
            }
            const geom = new THREE.CylinderGeometry(h.radius, h.radius, zn.max - zn.min, 32, 1, true);
            for (const s of [-1, 1]) g.add(slab(geom, zn.zone, new THREE.Vector3(0, s * (zn.min + zn.max) / 2, 0)));
        }
        const plane = new THREE.Mesh(new THREE.CircleGeometry(h.radius, 32), zoneMaterial('plane', false));
        plane.rotation.x = -Math.PI / 2;
        plane.userData.bkInfo = info;
        g.add(plane);
    }
    // Which room each side belongs to: a short arrow from the plane per side.
    if (inst.transition) {
        for (const s of [-1, 1]) {
            const dir = h.kind === 'h' ? new THREE.Vector3(0, 0, s) : new THREE.Vector3(0, s, 0);
            const origin = h.kind === 'h' ? new THREE.Vector3(0, (h.top + h.bottom) / 2, 0) : new THREE.Vector3();
            const room = sideRoom(inst, h, s);
            const arrow = new THREE.ArrowHelper(dir, origin, 60, room === inst.transition.frontRoom ? 0xffd040 : 0x40e0ff, 15, 10);
            arrow.traverse(o => { o.userData.unselectable = true; });
            g.add(arrow);
        }
    }
    g.userData.bkInfo = info;
    return g;
}

// OoT3D / MM3D (.zsi): the same scene commands and TransitionActorEntry as
// the N64 games, little-endian, with the commands at 0x10 and offsets
// relative to it. En_Holl is 0x023 in OoT3D, 0x017 in MM3D (0x018 on N64:
// MM3D's actor table is one short before it). Only the main header's list
// is read (the 3DS games have no setup picker).
const ZSI_BASE = 0x10;
const HOLL_3DS_ID = { OOT3D: 0x023, MM3D: 0x017 };

function zsiTransitionActors(buffer, game) {
    const dv = new DataView(buffer);
    for (let off = ZSI_BASE; off + 8 <= dv.byteLength; off += 8) {
        const cmd = dv.getUint8(off);
        if (cmd === 0x14) break;
        if (cmd !== 0x0E) continue;
        const count = dv.getUint8(off + 1), addr = dv.getUint32(off + 4, true) + ZSI_BASE;
        const out = [];
        for (let i = 0; i < count && addr + (i + 1) * 0x10 <= dv.byteLength; i++) {
            const o = addr + i * 0x10;
            if ((dv.getInt16(o + 4, true) & 0x1FFF) !== HOLL_3DS_ID[game]) continue;
            let rotY = dv.getInt16(o + 12, true), params = dv.getUint16(o + 14, true);
            if (game === 'MM3D') {
                rotY = Math.trunc(((rotY >> 7) & 0x1FF) * (0x8000 / 180)) << 16 >> 16;
                params &= 0x3FF;
            }
            out.push({
                name: 'En_Holl', params: ((i << 10) + params) & 0xFFFF,
                position: [dv.getInt16(o + 6, true), dv.getInt16(o + 8, true), dv.getInt16(o + 10, true)],
                rot: [0, rotY, 0],
                transition: { frontRoom: dv.getInt8(o), backRoom: dv.getInt8(o + 2) },
            });
        }
        return out;
    }
    return [];
}

/**
 * OoT3D / MM3D: the loading planes of a .zsi scene file (sceneFile, e.g.
 * "jyasinzou_info.zsi"), drawn as the N64 game's.
 */
export function renderLoadingPlanes3DS(scene, buffer, game, sceneFile) {
    const base = sceneFile.replace(/_info\.zsi$/i, '');
    // The N64 scene names the per-scene sizes are keyed by (a Master Quest
    // "_dd" file is the same scene).
    const sceneName = game === 'MM3D' ? base.toUpperCase() : base.replace(/_dd$/i, '') + '_scene';
    renderLoadingPlanes(scene, zsiTransitionActors(buffer, game), game === 'MM3D' ? 'MM' : 'OOT', sceneName);
}

/**
 * Draw the scene's En_Holl instances (oot_actors.js's decoded instances,
 * with `transition` = { frontRoom, backRoom } for transition actor spawns)
 * as one row per En_Holl type in the "Loading planes" group.
 */
export function renderLoadingPlanes(scene, instances, game, sceneName) {
    resetGroupModelState(GROUP);
    const byType = new Map();
    for (const inst of instances) {
        if (inst.name !== 'En_Holl') continue;
        const h = holl(inst, game, sceneName);
        if (!h) continue;
        const row = `${h.label} (type ${h.type})`;
        if (!byType.has(row)) byType.set(row, []);
        byType.get(row).push({ inst, h });
    }
    if (!byType.size) return;
    const group = getModelGroup(GROUP, 'Loading planes');
    for (const [row, list] of [...byType].sort((a, b) => a[0].localeCompare(b[0]))) {
        const name = list.length > 1 ? `${row} (x${list.length})` : row;
        const root = new THREE.Group();
        root.name = name;
        for (const { inst, h } of list) root.add(buildHoll(inst, h, game));
        scene.add(root);
        loadedModels.push({ name, root, mesh: root, edges: null });
        addModelCheckbox(scene, name, root, null, false, true, null, false, false, group.body);
    }
    applyGroupMasterState(GROUP);
}
