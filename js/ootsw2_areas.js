// Ocarina of Time (Switch 2) areas and loading zones, as the Owl Object Map
// draws them (its area layer, ported from objmap-oot's index.js): every
// area-like placed object is a volume (box / sphere / capsule / cylinder from
// actor_shapes.json and its Scale, a point-set hull, or an air wall mesh),
// sorted into objmap's categories; a loading zone is a
// FieldAndDungeonEntranceEventRequestActor and the area-like objects of its
// generation group. Tables come from tools/ootsw2/extract_objmap.py.
import * as THREE from 'three';
import { OOTSW2_SCALE, rotationRows, placement, meshList, addTriangles, addHull } from './ootsw2_map.js';

const ZONE_ACTOR = 'FieldAndDungeonEntranceEventRequestActor';
const SHAPE_TYPES = ['Sphere', 'Box', 'Capsule', 'Cylinder'];   // Dynamic.RigidBodyShapeType
// objmap's "minor" areas (fog, culling, nav mesh, camera...): their own row, off by default
const MINOR = new RegExp('^(VolumeFogArea|DustArea|AreaOverwriteEnvParam|(EnvPaletteTimeTable|FixedEnvPalette|WeatherPalette)ChangeArea|' +
    'AreaCulling(TargetArea|ActivationArea)?|SoundOcclusionArea|NavMesh(CutBoxArea|CutCylinderArea|DummyBox)|AirWallEnemy_NavMeshCut|' +
    'ForbidAutoPlacementArea(Box|Cylinder)|ForbiddenCreateDropArea|DropKeepAwayArea.*|FallingRockExclusionArea.*|CameraChangeAreaBox|' +
    'CameraPassThroughUnderAreaBox|IndoorAreaOutCameraBox|FldObj_AirWall_(CameraSightAndCameraBody|CharacterSight_GenerateNavMesh.*))$');

let tablesLoad = null;
// actor_shapes.json, rigid_body_shape_actors.json, location_areas.json, void_out_areas.json
export function loadOOTSW2AreaTables() {
    const get = f => fetch(`./models/OOTSW2/${f}`).then(r => r.ok ? r.json() : {}).catch(() => ({}));
    return tablesLoad ??= Promise.all(['actor_shapes', 'rigid_body_shape_actors', 'location_areas', 'void_out_areas'].map(n => get(`${n}.json`)))
        .then(([shapes, rigidDefaults, locations, voidOuts]) => ({ shapes, rigidDefaults, locations, voidOuts }));
}

function isAirwall(name, airwalls) {
    return !!airwalls[name] || /Air[Ww]all/.test(name);
}

// objmap's $g: drawn as an area
function isAreaLike(name, airwalls) {
    if (airwalls[name] || /Air[Ww]all/.test(name) && !/Anchor$/.test(name)) return true;
    if (/^(Land_|Eft)/.test(name) || /Anchor$/.test(name)) return false;
    if (/Area/.test(name)) return true;
    return /(Box|Cylinder|Sphere|Capsule)$/.test(name) && !/^(Obj_|FldObj_|Npc_|Enemy_|Item_|Weapon_|TBox)/.test(name);
}

// objmap's e_: Sphere / Box / Capsule / Cylinder
function shapeType(obj, tables) {
    const type = obj.t ?? tables.rigidDefaults[obj.n];
    if (type !== undefined && SHAPE_TYPES[type]) return SHAPE_TYPES[type];
    const kind = tables.shapes[obj.n]?.kind;
    if (kind && kind !== 'Box' && SHAPE_TYPES.includes(kind)) return kind;
    const m = obj.n.match(/(Box|Cylinder|Sphere|Capsule)(?=_|$)/g);
    return m ? m[m.length - 1] : 'Box';
}

// The object's volume added to `list` (objmap's s_). false: it has no shape.
function addVolume(list, obj, tables, airwalls) {
    const air = airwalls[obj.n];
    if (air) {
        addTriangles(list, placement(obj), air.v, air.i, obj);
        return true;
    }
    const def = tables.shapes[obj.n];
    const scale = obj.s ?? (def ? [1, 1, 1] : null);
    if (!scale) return false;
    if (def?.parts) {
        const place = placement({ ...obj, s: scale });
        for (const part of def.parts) {
            const points = [];
            for (let i = 0; i + 2 < part.length; i += 3) points.push(new THREE.Vector3(...place(part[i], part[i + 1], part[i + 2])));
            addHull(list, points, obj);
        }
        return true;
    }
    const he = (def?.halfExtents ?? [1, 1, 1]).map((v, k) => v * scale[k]);
    const local = (def?.center ?? (tables.rigidDefaults[obj.n] !== undefined ? [0, 1, 0] : [0, 0, 0])).map((v, k) => v * scale[k]);
    const R = rotationRows(obj);
    const center = R.map((row, r) => obj.p[r] + row[0] * local[0] + row[1] * local[1] + row[2] * local[2]);
    let geom;
    switch (shapeType(obj, tables)) {
        case 'Sphere': geom = new THREE.SphereGeometry(he[0], 16, 10); break;
        case 'Capsule': geom = new THREE.CapsuleGeometry(he[0], 2 * he[1], 4, 12); break;
        case 'Cylinder': geom = new THREE.CylinderGeometry(he[0], he[0], 2 * he[1], 20); break;
        default: geom = new THREE.BoxGeometry(2 * he[0], 2 * he[1], 2 * he[2]);
    }
    const m = new THREE.Matrix4().set(
        R[0][0], R[0][1], R[0][2], center[0],
        R[1][0], R[1][1], R[1][2], center[1],
        R[2][0], R[2][1], R[2][2], center[2],
        0, 0, 0, 1);
    geom.applyMatrix4(m.premultiply(new THREE.Matrix4().makeScale(OOTSW2_SCALE, OOTSW2_SCALE, OOTSW2_SCALE)));
    const pos = geom.getAttribute('position'), index = geom.getIndex();
    const base = list.verts.length;
    for (let i = 0; i < pos.count; i++) list.verts.push([pos.getX(i), pos.getY(i), pos.getZ(i)]);
    for (let k = 0; k < index.count; k += 3) {
        list.tris.push([base + index.getX(k), base + index.getX(k + 1), base + index.getX(k + 2)]);
        list.owners.push(obj);
    }
    geom.dispose();
    return true;
}

// Area kinds, objmap's layers: [key, label, colour, shown by default, short label]
export const OOTSW2_AREA_KINDS = [
    ['location', 'Location areas', '#4fc3f7', false, 'locations'],
    ['room', 'Dungeon rooms', '#90a4ae', false, 'rooms'],
    ['voidOut', 'Void outs', '#e040fb', true, 'void outs'],
    ['possibleVoidOut', 'Possible void outs', '#ce93d8', true, 'possible void outs'],
    ['warpBack', 'Warp backs', '#26c6da', true, 'warp backs'],
    ['noRespawn', 'No-respawn areas (the game logic invalidates the restart point)', '#28dcc8', true, 'no respawn'],
    ['safePath', 'Safe path areas (leaving every one of them sends you back)', '#ff9628', true, 'safe paths'],
    ['whirlpool', 'Whirlpools', '#3f6cff', false, 'whirlpools'],
    ['cutscene', 'Cutscene triggers', '#ffe650', false, 'cutscene triggers'],
    ['wall', 'Air wall shapes (boxes, cylinders...)', '#ff4f6a', true, 'air wall shapes'],
    ['area', 'Other areas', '#b0bec5', false, 'other areas'],
    ['minor', 'Minor areas (fog, culling, nav mesh, camera)', '#78909c', false, 'minor areas'],
];
export const OOTSW2_ZONE_COLOR = '#ffb000';

// -> { areas: { kind: meshList }, zones: [{ obj, label, list }], labelOf(obj) }
// age: "Child" / "Adult" / null, picks a zone's destination.
// mapLabel(mapName): a destination map's display name.
// zk (extract_romfs.py): the hazard zone the game's AI logic makes of an area
const ZONE_KINDS = { void: 'voidOut', norespawn: 'noRespawn', safepath: 'safePath', whirlpool: 'whirlpool', event: 'cutscene' };

export function buildOOTSW2Areas(objects, tables, airwalls, age, mapLabel) {
    const areaLike = objects.filter(o => o.zk || isAreaLike(o.n, airwalls));
    const locationOf = o => o.n === 'DungeonRoomArea' ? 'Dungeon room' : tables.locations[o.h];
    const voidKind = o => {
        const v = tables.voidOuts[o.h];
        return v ? v.kind === 'warp_back' ? 'warpBack' : v.certain ? 'voidOut' : 'possibleVoidOut' : null;
    };
    const kindOf = o => {
        if (ZONE_KINDS[o.zk]) return ZONE_KINDS[o.zk];
        if (locationOf(o)) return o.n === 'DungeonRoomArea' ? 'room' : 'location';
        const v = voidKind(o);
        if (v) return v;
        if (MINOR.test(o.n)) return 'minor';
        // air walls with a mesh are already in the collision (air wall rows)
        if (isAirwall(o.n, airwalls)) return airwalls[o.n] ? null : 'wall';
        return 'area';
    };
    const areas = Object.fromEntries(OOTSW2_AREA_KINDS.map(([key]) => [key, meshList()]));
    for (const o of areaLike) {
        const kind = kindOf(o);
        if (kind) addVolume(areas[kind], o, tables, airwalls);
    }

    // Loading zones: the entrance actor plus the area-like objects of its
    // generation group; without any, a 2 m sphere at the actor
    const byGroup = new Map();
    for (const o of areaLike) {
        if (!byGroup.has(o.g)) byGroup.set(o.g, []);
        byGroup.get(o.g).push(o);
    }
    const zones = objects.filter(o => o.n === ZONE_ACTOR).map(zone => {
        const dest = age === 'Adult' ? zone.za || zone.zc : zone.zc || zone.za;
        const label = dest ? `→ ${mapLabel(dest)}` + (zone.zs ? ` (${zone.zs})` : '') : `Arrival: ${zone.nm || 'unnamed'}`;
        const list = meshList();
        for (const o of byGroup.get(zone.g) ?? []) if (o.h !== zone.h) addVolume(list, o, tables, airwalls);
        if (!list.tris.length) addVolume(list, { ...zone, n: 'Sphere', s: [2, 2, 2], t: 0 }, tables, {});
        list.owners.fill(zone);
        return { obj: zone, label, list };
    });

    const labelOf = o => {
        const place = locationOf(o);
        const v = tables.voidOuts[o.h];
        const extra = o.zl ?? place ?? (v ? `${v.kind === 'warp_back' ? 'warp back' : v.certain ? 'void out' : 'possible void out'}` +
                                    (v.detail ? `: ${v.detail}` : '') : null);
        return `${o.n} ${o.h}` + (extra ? ` (${extra})` : '');
    };
    // The sidebar row an area object goes in: location areas by location
    // name (they're all LocationArea), everything else by actor name
    const rowKey = (kind, o) => kind === 'location' ? tables.locations[o.h] ?? o.n : o.zl ?? o.n;
    return { areas, zones, labelOf, rowKey };
}

// A meshList split by key(owner) into one meshList per key, in first-seen
// order, each with only the vertices its triangles use.
export function splitMeshList(list, key) {
    const out = new Map();
    list.tris.forEach((tri, t) => {
        const owner = list.owners[t], k = key(owner);
        if (!out.has(k)) out.set(k, { verts: [], tris: [], owners: [], remap: new Map() });
        const part = out.get(k);
        part.tris.push(tri.map(v => {
            if (!part.remap.has(v)) { part.remap.set(v, part.verts.length); part.verts.push(list.verts[v]); }
            return part.remap.get(v);
        }));
        part.owners.push(owner);
    });
    for (const part of out.values()) delete part.remap;
    return out;
}
