import * as THREE from 'three';

////////////////////////////////////////
// DK64: crouch gaps
////////////////////////////////////////
//
// models/DK64/<dir>/crouch_gaps.json, written by the dk64 repo's
// tools/kong_viewer/scripts/crouch_gaps.py: openings at body height
// (floor + bodyHeight) between 2 x crouchRadius and 2 x standRadius wide,
// where crouching Diddy (wall sphere #2, r 6.5) fits but a standing Kong
// (r 9.0 and up) is pushed back. Each spot is drawn as a disc the width of
// the gap at body height, rings of the crouch / stand radius, a post down to
// the floor and the two walls that form the gap. `crossings` are walls a
// crouch slide gets through (purple arrow + wall; grey when a standing walk
// gets through too). Only a hit that counts stops a Kong: it limits the
// next update's heading to the half away from the wall (global_asm
// 80674330 -> unkF4/unkF6, used by 80665160) and, with the feet within 6.25
// of the plane, puts him back in front of it (806713E4 / 80672B1C). A hit counts
// only with the feet in front of the wall's plane, for a 10-45 deg prop wall
// (mode 2, 8066D2F4) 2.625+ in front (80673B78). Crouched, Diddy's wall
// sphere shrinks from r 9 to r 6.5 at the same height (9.375 above the
// feet), so on a wall leaning back it first touches with the feet already
// close to the plane; if one slide step skips the few units where a hit
// counts, nothing stops him. Fungi Forest's file also has the jugs stump
// check (`stump`), drawn as a green ring.

const KIND_COLORS = { passage: 0xe5484d, pocket: 0xf7a01e, corridor: 0x3e8ef7 };
const STUMP_COLOR = 0x28aa46;
const CROSSING_COLOR = 0xb44dff;          // Diddy-only crossing
const CROSSING_OTHER_COLOR = 0x9a9a9a;    // a standing walk gets through too

const KIND_TEXT = {
    passage: 'standing room on both sides',
    pocket: 'standing room on one side only',
    corridor: 'crouch-only on both sides',
};

function ring(radius, color, y = 0) {
    const pts = [];
    for (let i = 0; i <= 48; i++) {
        const a = i / 48 * Math.PI * 2;
        pts.push(new THREE.Vector3(Math.cos(a) * radius, y, Math.sin(a) * radius));
    }
    const line = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color }));
    line.userData.unselectable = true;
    return line;
}

function translucent(color, opacity) {
    return new THREE.MeshBasicMaterial({ color, transparent: true, opacity, side: THREE.DoubleSide, depthWrite: false });
}

/**
 * crouch_gaps.json -> one marker per clip, for the "Crouch clips (Diddy)"
 * group's rows: [{ label, info, object, focus: { from, to } }] in
 * file order (crossings, Diddy-only first, then gaps, then the stump check);
 * focus is a camera position looking at the clip. [] when it lists nothing.
 */
export function buildDK64CrouchGapItems(data) {
    const items = [];
    if (!data) return items;
    const bodyHeight = data.bodyHeight ?? 9.375;
    // a camera `back` units behind `from` (away from `to`) and `up` above, looking at the middle
    const frame = (from, to, back, up) => {
        const dir = to.clone().sub(from).setY(0);
        if (dir.lengthSq() < 1e-6) dir.set(0, 0, 1);
        dir.normalize();
        const mid = from.clone().add(to).multiplyScalar(0.5);
        return { from: from.clone().addScaledVector(dir, -back).add(new THREE.Vector3(0, up, 0)), to: mid };
    };

    // Leaning walls a crouch slide gets through: an arrow at body height from
    // the start of the approach to just past the wall, and the wall itself.
    (data.crossings ?? []).forEach((c, i) => {
        const color = c.diddyOnly ? CROSSING_COLOR : CROSSING_OTHER_COLOR;
        const mapWall = c.wall.src.startsWith('map');
        const info = `Crouch crossing #${i + 1}${c.diddyOnly ? ' (Diddy only)' : ''}\n` +
            (mapWall ? 'map wall leaning back: a hit counts only with the feet in front of its plane'
                : 'leaning prop wall (mode 2): a hit counts only with the feet 2.625+ in front of its plane') +
            '; the crouch sphere (r 6.5) touches it so late that a slide step longer than the "push band" ' +
            'skips every update where it would block\n' + c.text;
        const group = new THREE.Group();
        const a = new THREE.Vector3(c.start[0], c.start[1] + bodyHeight, c.start[2]);
        const b = new THREE.Vector3(c.end[0], c.end[1] + bodyHeight, c.end[2]);
        const dir = b.clone().sub(a);
        const length = dir.length();
        if (length > 1e-3) {
            const arrow = new THREE.ArrowHelper(dir.normalize(), a, length, color, 4, 3);
            arrow.traverse(o => { o.userData.textured = true; });
            arrow.line.userData.unselectable = true;
            arrow.cone.userData.bkInfo = info;
            group.add(arrow);
        }
        const wall = new THREE.Mesh(new THREE.BufferGeometry().setAttribute('position',
            new THREE.Float32BufferAttribute(c.wall.corners.flat(), 3)), translucent(color, 0.45));
        wall.renderOrder = 2;
        wall.userData.bkInfo = info;
        wall.userData.textured = true;
        const edges = new THREE.LineSegments(new THREE.EdgesGeometry(wall.geometry), new THREE.LineBasicMaterial({ color }));
        edges.userData.unselectable = true;
        wall.add(edges);
        group.add(wall);
        // short for the sidebar (the row's tooltip has the full text): Diddy-only is the norm, so only the rest say so
        const tags = [!c.diddyOnly && 'any Kong', c.underwater && 'underwater'].filter(Boolean).join(', ');
        items.push({ label: `#${i + 1} ${c.prop.replace(/^prop /, '')}${tags ? ` (${tags})` : ''}`, info, object: group,
                     focus: frame(a, b, 45, 30) });
    });

    (data.spots ?? []).forEach((s, i) => {
        const color = KIND_COLORS[s.kind] ?? 0xffffff;
        const info = `Crouch gap #${i + 1}: ${s.kind} (${KIND_TEXT[s.kind] ?? ''}), width ${s.width.toFixed(2)}\n` +
            `crouching Diddy (r ${data.crouchRadius}) fits, standing (r ${data.standRadius}) does not\n` + s.text;
        const group = new THREE.Group();
        const spot = new THREE.Group();
        spot.position.set(s.x, s.y + bodyHeight, s.z);
        const disc = new THREE.Mesh(new THREE.CircleGeometry(s.width / 2, 32), translucent(color, 0.45));
        disc.rotation.x = -Math.PI / 2;
        disc.renderOrder = 2;
        disc.userData.bkInfo = info;
        disc.userData.textured = true;
        spot.add(disc);
        spot.add(ring(data.crouchRadius, color));
        spot.add(ring(data.standRadius, 0xffffff));
        const post = new THREE.Line(new THREE.BufferGeometry().setFromPoints(
            [new THREE.Vector3(0, -bodyHeight, 0), new THREE.Vector3(0, 6, 0)]), new THREE.LineBasicMaterial({ color }));
        post.userData.unselectable = true;
        spot.add(post);
        group.add(spot);

        // the two walls forming the gap
        const corners = s.walls.flatMap(w => w.corners.flat());
        const walls = new THREE.Mesh(new THREE.BufferGeometry().setAttribute('position',
            new THREE.Float32BufferAttribute(corners, 3)), translucent(color, 0.3));
        walls.renderOrder = 2;
        walls.userData.bkInfo = info;
        walls.userData.textured = true;
        const edges = new THREE.LineSegments(new THREE.EdgesGeometry(walls.geometry), new THREE.LineBasicMaterial({ color }));
        edges.userData.unselectable = true;
        walls.add(edges);
        group.add(walls);
        const at = new THREE.Vector3(s.x, s.y + bodyHeight, s.z);
        const across = new THREE.Vector3(s.dir?.[0] ?? 1, 0, s.dir?.[1] ?? 0);
        items.push({ label: `gap ${i + 1}: ${s.kind}, width ${s.width.toFixed(1)}`, info, object: group,
                     focus: frame(at.clone().addScaledVector(across, -1), at.clone().addScaledVector(across, 1), 40, 30) });
    });

    if (data.stump) {
        const [x, y, z] = data.stump.pos;
        const group = new THREE.Group();
        const stump = new THREE.Group();
        stump.position.set(x, y + bodyHeight, z);
        const info = 'Jugs stump check (crouch_gaps.py)\n' + data.stump.text;
        const disc = new THREE.Mesh(new THREE.RingGeometry(26, 30, 48), translucent(STUMP_COLOR, 0.5));
        disc.rotation.x = -Math.PI / 2;
        disc.userData.bkInfo = info;
        disc.userData.textured = true;
        stump.add(disc);
        group.add(stump);
        const at = new THREE.Vector3(x, y + bodyHeight, z);
        items.push({ label: 'jugs stump check', info, object: group,
                     focus: { from: at.clone().add(new THREE.Vector3(0, 60, -80)), to: at } });
    }
    return items;
}
