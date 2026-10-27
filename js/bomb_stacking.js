import * as THREE from 'three';
import { currentColCtx } from './parse_model.js';
import { CollisionModel, LOOSE, F, isZero, triChkY, toS16, NORMAL_FRAC } from './wall_push_clips.js';
import { addModelCheckbox, getModelGroup, resetGroupModelState, applyGroupMasterState, deferGroupBuild, setGroupBusy } from './render.js';

////////////////////////////////////////
// System: OoT / MM (and OoT3D / MM3D) bomb stacking floors
////////////////////////////////////////
//
// Two bombs put down in the same spot overlap. The frame their OC collider
// turns on (z_en_bom.c: Link 20+ away), CollisionCheck_SetOCvsOC pushes them
// apart: same mass, so half the overlap each, and with their centres exactly
// on top of each other (xzDist 0) straight along world X, -6 / +6. The next
// frame Actor_UpdatePos applies it and, on open ground, they're 12 apart
// (2 x radius 6), too far apart for Link to touch both near their centres.
//
// What can keep them together is the bomb's own Actor_UpdateBgCheckInfo
// after that move:
//   - OoT: the bomb's wall check height is only 5. A resting bomb moves
//     velocity.y -5.2 x 1.5 = -7.8 a frame, so checkHeight + dy < 5 and
//     BgCheck_CheckWallImpl does its line test from posPrev to posNext at the
//     feet (the "checkHeight is not applied" bug), floors included. posPrev is
//     on the floor, so whether that line hits the floor right where it starts
//     comes down to f32 rounding: the floor height the raycast gave, put back
//     into the poly's plane equation, lands on or above the plane (hit: the
//     bomb is put back at the intersection, i.e. where it was, and stays) or
//     just below it (no hit: it moves). On a flat floor that's the same at
//     every point, so it's a property of the floor (its height and normal);
//     on a slope it varies from point to point. Pushed into a rising slope,
//     the line hits it too. (MM's bombs check walls at height 35, so this
//     never happens there.)
//   - MM ceiling lock: a scene ceiling found by the ceiling check (about 28
//     above the floor for a resting bomb) while it's on a scene floor puts x/z
//     back to prevPos (floor bgId == ceiling bgId): it can't move sideways.
//     (OoT's bomb ceiling check is 15 high starting 10 up, so with the -7.8 a
//     frame it never finds one.)
//   - walls: the wall push puts the bomb back out to 10 from the wall. Against
//     one wall the pair still drifts apart over a few frames; boxed in, not.
// MM polys with flags_vIB bit 2 (tri.flags & 4) are skipped by non-player
// actors, so they're left out of MM bombs' collision.
//
// For each sample point on the scene's floors this runs the two bombs the
// game's way, frame by frame, from the frame their collision turns on (put
// down where the bomb's own wall check leaves it) until they stop moving, and
// keeps the points where they end up under MAX_USEFUL_SEP apart. (That's what
// Link finds when he comes back: their OC turns on as soon as he's 20 away
// after putting them down, long before he can slide back into them.) For
// those it then looks for the biggest one-frame push Link can get from them
// in a superslide / HESS: 27 a frame (18 x 1.5) plus 0.8 x the overlap per
// bomb (Link mass 50, bombs 200, radii 12 + 6), with Link touching neither
// bomb the frame before, and his start, landing spot and destination on floor
// within 40 of the bombs' height, clear of his walls and of low ceilings, for
// each of the game's forms. Static collision only (no dynapoly actors).
//
// OoT3D / MM3D run at 30 fps: velocity x 1.0 a frame, so a resting bomb
// drops 5.2 and the slide moves 18 (the OC push isn't scaled). Their feet
// line rule is the one clipfinder fitted for 3DS ground clips (checkHeight +
// dy x 1.5 < 5); the bombs' check heights are assumed to be N64's. At 18 a
// frame, 2 x 0.8 x 18 from the bombs can't make up a 50 push, so the 3DS maps
// only get the stacked / close rows.

const GROUP = 'zelda-bomb-stacking';
const GROUP_LABEL = 'Bomb stacking';

const GAMES = {
    // z_en_bom.c Actor_UpdateBgCheckInfo(35, 10, 36), func_800B7678's -11
    // grace; z_player.c sAgeProperties (Human), wall check height 26.8.
    MM: {
        rate: 1.5, lineDyScale: 1,
        bombWallH: 35, bombCeil: { start: 4, h: 36, sub: 4 }, floorGrace: true, skipPlayerOnly: true,
        maxSamples: 1000000,
        linkWallH: 26.8, linkCeil: { start: 4, sub: 4 },
        forms: [{ name: 'Human', wallR: 14, ceilH: 40 }],
    },
    // z_en_bom.c Actor_UpdateBgCheckInfo(5, 10, 15); func_8002E2AC snaps only
    // on or below the floor; z_player.c sAgeProperties, wall check height 26.
    OOT: {
        rate: 1.5, lineDyScale: 1,
        bombWallH: 5, bombCeil: { start: 10, h: 15, sub: 10 }, floorGrace: false, skipPlayerOnly: false,
        // (most OoT floor points need simulating: a coarser grid on big maps)
        maxSamples: 250000,
        linkWallH: 26, linkCeil: { start: 10, sub: 10 },
        forms: [{ name: 'Adult', wallR: 18, ceilH: 56 }, { name: 'Child', wallR: 14, ceilH: 40 }],
    },
};
// sActorMovementScale 1.0 at 30 fps
GAMES.OOT3D = { ...GAMES.OOT, rate: 1.0, lineDyScale: 1.5 };
GAMES.MM3D = { ...GAMES.MM, rate: 1.0, lineDyScale: 1.5 };
// What follows from the frame rate: a resting bomb's dy each frame, grounded
// Link's (velocity.y -5 before the checks) and the superslide / HESS (18).
for (const g of Object.values(GAMES)) {
    g.bombDrop = F(F(-4 + -1.2) * g.rate);
    g.linkGroundDrop = 5 * g.rate;
    g.slide = 18 * g.rate;
}

const MIN_SAMPLE = 4;        // sample spacing on the floors, wider on big maps (maxSamples)
const FRAMES = 30;

const BOMB_WALL_R = 10;
const BOMB_GRAVITY = -1.2, BOMB_MIN_VY = -20;
const BOMB_CYL_R = 6, BOMB_CYL_YSHIFT = 14, BOMB_CYL_H = 11;

const LINK_REACH = 12 + BOMB_CYL_R;   // Link cylinder radius 12
const LINK_PUSH = 200 / (200 + 50);   // bomb mass / (bomb + Link)
const LINK_MAX_DY = 40;               // his spots' floors this close to the bombs' height (slopes)
const GOAL = 50;                      // transparent En_Holl load band width
// Two bombs this far apart give at most ~50 even lined up with the slide
// and nothing in Link's way, so wider gaps aren't shown.
const MAX_USEFUL_SEP = 7.5;

const ROWS = [
    { key: 'clear', label: `Bombs: push of ${GOAL}+ in one frame`, color: 0xff3030 },
    { key: 'stacked', label: 'Bombs: stay stacked (under 1 apart)', color: 0xd040ff },
    { key: 'close', label: `Bombs: end up under ${MAX_USEFUL_SEP} apart`, color: 0xffc830 },
];

// The bombs' and each form's collision.
function buildModels(g, colCtx, triangles) {
    const bombTris = g.skipPlayerOnly ? triangles.filter(t => !(t.flags & 4)) : triangles;
    const bomb = new CollisionModel(colCtx, bombTris, BOMB_WALL_R, g.bombWallH);
    bomb.ceilingCache = new Map();
    const forms = g.forms.map(f => {
        const m = new CollisionModel(colCtx, triangles, f.wallR, g.linkWallH);
        m.ceilingCache = new Map();
        return { ...f, model: m };
    });
    return { bomb, forms };
}

// BgCheck_CheckStaticCeiling on the subdivision `pos` is in: every ceiling
// poly (no early out), CollisionPoly_CheckYIntersectApprox2. Returns outY or
// null.
function ceilingCheck(m, x, y, z, h) {
    if (!(h > 0)) return null;
    const c = m.colCtx, mn = c.minBounds, mx = c.maxBounds;
    if (x < mn.x || x > mx.x || y < mn.y || y > mx.y || z < mn.z || z > mx.z) return null;
    const index = m.cellIndex(x, y, z);
    let list = m.ceilingCache.get(index);
    if (!list) {
        const sub = c.subdivisions[index];
        list = (sub?.ceilings ?? []).map(id => m.polys.get(id)).filter(p => p && p.isCeiling);
        m.ceilingCache.set(index, list);
    }
    let outY = y, hit = false;
    for (const p of list) {
        if (x < p.minX - 1 || x > p.maxX + 1 || z < p.minZ - 1 || z > p.maxZ + 1) continue;
        if (!triChkY(p, z, x, 300, 1)) continue;
        const cy = F(F(F(F(-p.nx * x) - F(p.nz * z)) - p.dist) / p.ny);
        const d = F(cy - outY);
        if (d > 0 && d < h && F(d * p.ny) <= 0) {
            outY = F(cy - h);
            hit = true;
        }
    }
    return hit ? outY : null;
}

// CollisionCheck_SetOCvsOC for the two bomb cylinders (Collider_UpdateCylinder
// truncates the positions to s16). Returns each one's displacement, or null.
function bombOC(a, b) {
    const ax = toS16(a.x), ay = toS16(a.y), az = toS16(a.z);
    const bx = toS16(b.x), by = toS16(b.y), bz = toS16(b.z);
    const dx = bx - ax, dz = bz - az;
    const dist = F(Math.sqrt(dx * dx + dz * dz));
    if (2 * BOMB_CYL_R < dist) return null;
    if (ay + BOMB_CYL_YSHIFT + BOMB_CYL_H < by + BOMB_CYL_YSHIFT || by + BOMB_CYL_YSHIFT + BOMB_CYL_H < ay + BOMB_CYL_YSHIFT) return null;
    const overlap = F(2 * BOMB_CYL_R - dist);
    if (!isZero(dist)) {
        const kx = F(dx * F(overlap / dist)), kz = F(dz * F(overlap / dist));
        return { a: { x: F(-kx * 0.5), z: F(-kz * 0.5) }, b: { x: F(kx * 0.5), z: F(kz * 0.5) } };
    }
    const k = overlap !== 0 ? overlap : 1;
    return { a: { x: F(-k * 0.5), z: 0 }, b: { x: F(k * 0.5), z: 0 } };
}

// One EnBom update for a bomb resting with speed 0: Actor_MoveWithGravity
// (with the OC displacement), then Actor_UpdateBgCheckInfo's wall, ceiling
// and floor checks.
function bombStep(g, m, b, disp) {
    const prev = { x: b.x, y: b.y, z: b.z };
    b.vy = Math.max(F(b.vy + BOMB_GRAVITY), BOMB_MIN_VY);
    const nx = F(b.x + disp.x), nz = F(b.z + disp.z), ny = F(b.y + F(b.vy * g.rate));
    const dy = F(ny - prev.y);

    // BgCheck_CheckWallImpl's line test, then the sphere pushes.
    let rx = nx, ry = ny, rz = nz;
    if (nx !== prev.x || nz !== prev.z) {
        if (F(g.bombWallH + F(dy * g.lineDyScale)) < 5) {
            // posPrev to posNext as they are, floors and walls
            const hit = m.lineHit(prev, { x: nx, y: ny, z: nz }, LOOSE, true, false, false);
            if (hit) {
                const p = hit.poly;
                if (p.ny > 0.5) {
                    rx = hit.x; ry = F(hit.y - 1); rz = hit.z;
                    b.floorLine = true;
                } else {
                    rx = F(F(BOMB_WALL_R * p.nx) + hit.x);
                    ry = F(F(BOMB_WALL_R * p.ny) + hit.y);
                    rz = F(F(BOMB_WALL_R * p.nz) + hit.z);
                    b.wall = true;
                }
            }
        } else {
            // at posNext.y + checkHeight, walls only (the move is under the radius)
            const ly = F(ny + g.bombWallH);
            const hit = m.lineHit({ x: prev.x, y: ly, z: prev.z }, { x: nx, y: ly, z: nz }, LOOSE, false, false, false);
            if (hit && !isZero(hit.poly.nXZ)) {
                const k = F(BOMB_WALL_R * F(1 / hit.poly.nXZ));
                rx = F(F(k * hit.poly.nx) + hit.x);
                rz = F(F(k * hit.poly.nz) + hit.z);
                b.wall = true;
            }
        }
    }
    const s = m.sphereStep({ x: rx, y: ry, z: rz }, LOOSE, null, prev, false);
    if (s.x !== rx || s.z !== rz) b.wall = true;
    b.x = s.x; b.z = s.z; b.y = ry;

    const c = g.bombCeil;
    const ceilY = ceilingCheck(m, b.x, F(prev.y + c.start), b.z, F(F(c.h + dy) - c.sub));
    if (ceilY !== null) b.y = F(F(ceilY + dy) - c.sub);

    const floorY = m.floorCheck(b.x, b.z, F(prev.y + 50));
    if (floorY === null) {
        b.grounded = false;
        return;
    }
    const toFloor = F(floorY - b.y);
    if (toFloor >= 0 || (g.floorGrace && b.grounded && toFloor >= -11 && b.vy < 0)) {
        if (ceilY !== null) {
            b.x = prev.x;
            b.z = prev.z;
            b.ceilingLock = true;
        }
        b.y = floorY;
        if (b.vy <= 0) {
            b.vy = -4;
            b.grounded = true;
        }
    } else if (!(b.grounded && toFloor >= -11)) {
        b.grounded = false;
    }
}

const sepOf = (a, b) => Math.hypot(b.x - a.x, b.z - a.z);

// Where a bomb put down at (x, y, z) comes to rest before its OC turns on:
// its own wall pushes move it out to 10 from the walls. Null if it falls.
function restingSpot(g, m, x, y, z) {
    const b = { x, y, z, vy: -4, grounded: true };
    for (let i = 0; i < 8; i++) {
        const px = b.x, pz = b.z;
        bombStep(g, m, b, { x: 0, z: 0 });
        if (!b.grounded) return null;
        if (b.x === px && b.z === pz) return b;
    }
    return null;
}

// Both bombs at (x, y, z), from the frame their OC turns on, until they stop
// moving. seps[i] is how far apart they are at the end of frame i + 1.
function simulate(g, m, x, y, z) {
    const A = { x, y, z, vy: -4, grounded: true };
    const B = { x, y, z, vy: -4, grounded: true };
    const seps = [];
    for (let f = 0; f < FRAMES; f++) {
        const oc = bombOC(A, B);
        const pa = { x: A.x, z: A.z }, pb = { x: B.x, z: B.z };
        bombStep(g, m, A, oc ? oc.a : { x: 0, z: 0 });
        bombStep(g, m, B, oc ? oc.b : { x: 0, z: 0 });
        seps.push(sepOf(A, B));
        if (!A.grounded || !B.grounded) return { seps, fell: true, A, B };
        if (!oc) break;
        if (sepOf(A, pa) < 0.001 && sepOf(B, pb) < 0.001) break;
    }
    return { seps, fell: false, A, B };
}

// Link standing at (x, z) on a floor within LINK_MAX_DY of y: not pushed by a wall, not under
// a ceiling his check finds (from prevPos.y + start, ceilingCheckHeight + the
// frame's -7.5 - sub: those lock his x/z too).
function linkStands(g, form, x, z, y) {
    const m = form.model;
    const fy = m.floorCheck(x, z, F(y + 50));
    if (fy === null || Math.abs(fy - y) > LINK_MAX_DY) return false;
    const s = m.sphereStep({ x, y: F(fy - g.linkGroundDrop), z }, LOOSE, null);
    if (Math.abs(s.x - x) > 0.01 || Math.abs(s.z - z) > 0.01) return false;
    return ceilingCheck(m, x, F(fy + g.linkCeil.start), z, F(F(form.ceilH - g.linkGroundDrop) - g.linkCeil.sub)) === null;
}

// Link's spots next to the bombs ranked by push, for bomb B at (dx, dz) from
// bomb A (s16 collider positions): his collider at A + (i, j), the push
// along u, and him clear of both bombs a slide frame back along u. Only the
// bombs' relative position (and the slide) matters, so this is shared.
const candCache = new Map();
function candidates(dx, dz, slide) {
    const key = dx + ',' + dz + ',' + slide;
    let list = candCache.get(key);
    if (list) return list;
    list = [];
    const span = LINK_REACH + 1;
    for (let i = Math.min(0, dx) - span; i <= Math.max(0, dx) + span; i++) {
        for (let j = Math.min(0, dz) - span; j <= Math.max(0, dz) + span; j++) {
            let Px = 0, Pz = 0;
            for (const [qx, qz] of [[0, 0], [dx, dz]]) {
                const ex = i - qx, ez = j - qz, d = Math.hypot(ex, ez);
                if (d < LINK_REACH && d > 0.008) {
                    Px += LINK_PUSH * (LINK_REACH - d) * ex / d;
                    Pz += LINK_PUSH * (LINK_REACH - d) * ez / d;
                }
            }
            const mag = Math.hypot(Px, Pz);
            if (slide + mag < GOAL) continue;
            const ux = Px / mag, uz = Pz / mag;
            const sx = i - slide * ux, sz = j - slide * uz;
            if (Math.hypot(sx, sz) <= LINK_REACH + 1 || Math.hypot(sx - dx, sz - dz) <= LINK_REACH + 1) continue;
            list.push({ i, j, ux, uz, mag, total: slide + mag });
        }
    }
    list.sort((p, q) => q.total - p.total);
    candCache.set(key, list);
    return list;
}

// A world position whose s16 truncation (toward zero) is c.
const cellCentre = c => c + (c < 0 ? -0.5 : 0.5);

// The biggest one-frame push (GOAL or more) this form can get from bombs a
// and b, or null.
function bestPush(g, form, a, b, y) {
    const ax = toS16(a.x), az = toS16(a.z);
    const slide = g.slide;
    const cands = candidates(toS16(b.x) - ax, toS16(b.z) - az, slide);
    for (const c of cands) {
        const p = { x: cellCentre(ax + c.i), z: cellCentre(az + c.j) };
        const s = { x: p.x - slide * c.ux, z: p.z - slide * c.uz };
        const e = { x: p.x + c.total * c.ux, z: p.z + c.total * c.uz };
        if (!linkStands(g, form, p.x, p.z, y) || !linkStands(g, form, s.x, s.z, y)) continue;
        const ly = F(y + g.linkWallH);
        const m = form.model;
        if (m.lineHit({ x: s.x, y: ly, z: s.z }, { x: p.x, y: ly, z: p.z }, LOOSE, false, false, false)) continue;
        if (m.lineHit({ x: p.x, y: ly, z: p.z }, { x: e.x, y: ly, z: e.z }, LOOSE, false, false, false)) continue;
        if (!linkStands(g, form, e.x, e.z, y)) continue;
        return { total: c.total, ux: c.ux, uz: c.uz, p, s, e };
    }
    return null;
}

// Floor sample points: a world-aligned grid over every scene floor poly the
// bombs stand on, `step` apart.
function floorArea(bomb) {
    let area = 0;
    for (const p of bomb.polys.values()) {
        if (!p.isFloor) continue;
        area += Math.abs((p.bx - p.ax) * (p.cz - p.az) - (p.cx - p.ax) * (p.bz - p.az)) / 2;
    }
    return area;
}

function floorSamples(bomb, step) {
    const out = [];
    const seen = new Set();
    for (const p of bomb.polys.values()) {
        if (!p.isFloor) continue;
        const x0 = Math.ceil(p.minX / step) * step, z0 = Math.ceil(p.minZ / step) * step;
        for (let x = x0; x <= p.maxX; x += step) {
            for (let z = z0; z <= p.maxZ; z += step) {
                if (!triChkY(p, z, x, 0, 0)) continue;
                const y = F(F(F(F(-p.nx * x) - F(p.nz * z)) - p.dist) / p.ny);
                const key = `${x},${Math.round(y)},${z}`;
                if (seen.has(key)) continue;
                seen.add(key);
                out.push({ x, y, z, poly: p });
            }
        }
    }
    return out;
}

// Distance in x/z from (x, z) to the nearest edge of poly p.
function edgeDistXZ(p, x, z) {
    const seg = (x1, z1, x2, z2) => {
        const dx = x2 - x1, dz = z2 - z1, len = dx * dx + dz * dz;
        const t = len ? Math.max(0, Math.min(1, ((x - x1) * dx + (z - z1) * dz) / len)) : 0;
        return Math.hypot(x1 + dx * t - x, z1 + dz * t - z);
    };
    return Math.min(seg(p.ax, p.az, p.bx, p.bz), seg(p.bx, p.bz, p.cx, p.cz), seg(p.cx, p.cz, p.ax, p.az));
}

// Which points can't keep the bombs together, so aren't simulated: far from
// any wall at the bomb's wall check height, with no ceiling over them, and
// (OoT) with the feet line test missing the floor they're on and nowhere near
// another floor it could hit.
function buildSkipTest(g, bomb) {
    const reach = 2 * BOMB_CYL_R + BOMB_WALL_R + 4;
    const cell = 32, grid = new Map();
    const add = (p, pad) => {
        for (let gx = Math.floor((p.minX - pad) / cell); gx <= Math.floor((p.maxX + pad) / cell); gx++) {
            for (let gz = Math.floor((p.minZ - pad) / cell); gz <= Math.floor((p.maxZ + pad) / cell); gz++) {
                const k = gx + ',' + gz;
                let l = grid.get(k);
                if (!l) grid.set(k, l = []);
                l.push(p);
            }
        }
    };
    for (const p of bomb.polys.values()) {
        if (p.isWall) add(p, reach);
        else if (p.isCeiling) add(p, 2);
    }
    const nearWallOrCeiling = (x, y, z) => {
        const l = grid.get(Math.floor(x / cell) + ',' + Math.floor(z / cell));
        if (!l) return false;
        for (const p of l) {
            if (p.isWall) {
                if (p.maxY < y + Math.min(0, g.bombDrop) - 2 || p.minY > y + g.bombWallH + BOMB_WALL_R) continue;
                if (x < p.minX - reach || x > p.maxX + reach || z < p.minZ - reach || z > p.maxZ + reach) continue;
                return true;
            }
            if (p.minY > y + g.bombCeil.start + g.bombCeil.h + 2 || p.maxY < y) continue;
            if (x < p.minX - 2 || x > p.maxX + 2 || z < p.minZ - 2 || z > p.maxZ + 2) continue;
            return true;
        }
        return false;
    };
    const feetLine = F(g.bombWallH + F(g.bombDrop * g.lineDyScale)) < 5;
    return (pt, y) => {
        if (nearWallOrCeiling(pt.x, y, pt.z)) return false;
        if (!feetLine) return true;
        // CollisionPoly_LineVsPoly's plane distance at the bomb's feet
        const p = pt.poly;
        const planeA = F(F(F(F(F(p.sx * pt.x) + F(p.sy * y)) + F(p.sz * pt.z)) * NORMAL_FRAC) + p.dist);
        if (planeA >= 0) return false;
        return edgeDistXZ(p, pt.x, pt.z) > BOMB_CYL_R + 2;
    };
}

const fmt = v => (Math.round(v * 100) / 100).toString();
const yawDeg = (ux, uz) => ((Math.atan2(ux, uz) * 180 / Math.PI) + 360) % 360;

function describe(g, pt, sim, pushes) {
    const causes = [];
    if (sim.A.floorLine || sim.B.floorLine) causes.push('feet line test hits the floor');
    if (sim.A.ceilingLock || sim.B.ceilingLock) causes.push('low ceiling locks x/z');
    if (sim.A.wall || sim.B.wall) causes.push('wall push');
    const seps = sim.seps.slice(0, 6).map(fmt).join(', ') + (sim.seps.length > 6 ? ', …' : '');
    let line = `BOMB STACK put down at ${fmt(pt.x)}, ${fmt(pt.y)}, ${fmt(pt.z)}: apart after each frame from their OC turning on: ${seps}` +
        ` (settles at ${fmt(sim.seps[sim.seps.length - 1])}${sim.fell ? ', a bomb falls off' : ''})` +
        `; ${causes.join(' + ') || 'no bgcheck involved'}.`;
    line += ` Bombs end up at ${fmt(sim.A.x)}, ${fmt(sim.A.z)} / ${fmt(sim.B.x)}, ${fmt(sim.B.z)}.`;
    for (const { form, push } of pushes) {
        if (push) {
            line += ` ${form}: ${fmt(push.total)} in one frame (slide yaw ${fmt(yawDeg(push.ux, push.uz))} deg world,` +
                ` from ${fmt(push.s.x)}, ${fmt(push.s.z)} to ${fmt(push.p.x)}, ${fmt(push.p.z)}, touching them, then ${fmt(push.e.x)}, ${fmt(push.e.z)}).`;
        } else {
            line += g.slide + 2 * LINK_PUSH * LINK_REACH < GOAL
                ? ` ${form}: no ${GOAL}+ push at ${fmt(g.slide)} a frame.`
                : ` ${form}: no ${GOAL}+ push he can slide in for (gap, walls or ceilings).`;
        }
    }
    return line;
}

const yieldChannel = new MessageChannel();
const yieldQueue = [];
yieldChannel.port1.onmessage = () => yieldQueue.shift()?.();
const nextTask = () => new Promise(resolve => {
    yieldQueue.push(resolve);
    yieldChannel.port2.postMessage(null);
});

let buildId = 0;

async function build(scene, gameName) {
    const id = ++buildId;
    const g = GAMES[gameName];
    const colCtx = currentColCtx;
    const main = loadedModels.find(m => m.name === 'Main Model');
    if (!g || !colCtx || !main?.mesh?.userData?.triangles) return;
    setGroupBusy(GROUP, GROUP_LABEL, 'calculating…');
    const t0 = performance.now();
    const { bomb, forms } = buildModels(g, colCtx, main.mesh.userData.triangles);
    const step = Math.max(MIN_SAMPLE, Math.ceil(Math.sqrt(floorArea(bomb) / g.maxSamples)));
    const samples = floorSamples(bomb, step);
    const skip = buildSkipTest(g, bomb);

    const hits = { clear: [], stacked: [], close: [] };
    const rested = new Set();
    let simulated = 0, last = performance.now();
    for (let i = 0; i < samples.length; i++) {
        if (performance.now() - last > 30) {
            await nextTask();
            if (id !== buildId) return;
            last = performance.now();
        }
        const pt = samples[i];
        const fy = bomb.floorCheck(pt.x, pt.z, F(pt.y + 50));
        if (fy === null || Math.abs(fy - pt.y) > 1) continue;
        if (skip(pt, fy)) continue;
        const rest = restingSpot(g, bomb, pt.x, fy, pt.z);
        if (!rest) continue;
        const restKey = `${Math.round(rest.x * 2)},${Math.round(rest.y)},${Math.round(rest.z * 2)}`;
        if (rested.has(restKey)) continue;
        rested.add(restKey);
        simulated++;
        const sim = simulate(g, bomb, rest.x, rest.y, rest.z);
        const settled = sim.seps[sim.seps.length - 1];
        if (!(settled < MAX_USEFUL_SEP) || sim.fell) continue;
        const pushes = forms.map(f => ({ form: f.name, push: bestPush(g, f, sim.A, sim.B, rest.y) }));
        const row = pushes.some(p => p.push) ? 'clear' : settled < 1 ? 'stacked' : 'close';
        const at = { x: rest.x, y: rest.y, z: rest.z };
        hits[row].push({ pt: at, info: describe(g, at, sim, pushes) });
    }
    if (id !== buildId) return;

    resetGroupModelState(GROUP);
    const group = getModelGroup(GROUP, GROUP_LABEL);
    for (const r of ROWS) {
        const list = hits[r.key];
        if (!list.length) continue;
        const name = `${r.label} (${list.length})`;
        const pos = new Float32Array(list.length * 18);
        const h = step / 2;
        list.forEach(({ pt }, k) => {
            const y = pt.y + 1;
            const q = [
                pt.x - h, y, pt.z - h, pt.x - h, y, pt.z + h, pt.x + h, y, pt.z + h,
                pt.x - h, y, pt.z - h, pt.x + h, y, pt.z + h, pt.x + h, y, pt.z - h,
            ];
            pos.set(q, k * 18);
        });
        const geom = new THREE.BufferGeometry();
        geom.setAttribute('position', new THREE.BufferAttribute(pos, 3));
        const mesh = new THREE.Mesh(geom, new THREE.MeshBasicMaterial({
            color: r.color, side: THREE.DoubleSide, transparent: true, opacity: 0.85,
            polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
        }));
        mesh.name = name;
        mesh.renderOrder = 3;
        mesh.userData.bkInfo = `${r.label}: ${list.length} sample points (${step} apart)`;
        mesh.userData.faceInfo = tri => list[Math.floor(tri / 2)]?.info ?? null;
        scene.add(mesh);
        loadedModels.push({ name, root: mesh, mesh, edges: null });
        addModelCheckbox(scene, name, mesh, null, false, true, '#' + r.color.toString(16).padStart(6, '0'), false, null, group.body);
    }
    setGroupBusy(GROUP, GROUP_LABEL, null);
    applyGroupMasterState(GROUP);
    console.log(`bomb stacking (${gameName}): ${samples.length} floor samples ${step} apart, ${simulated} simulated, ` +
        `${hits.clear.length} clear / ${hits.stacked.length} stacked / ${hits.close.length} close, ` +
        `${Math.round(performance.now() - t0)} ms`);
}

// Runs on every OoT / MM / OoT3D / MM3D map load, in the background, once the
// group has been checked: it starts unchecked, and then is built only when
// checked (deferGroupBuild). While it runs the group reads "calculating…".
export function setupBombStacking(scene) {
    document.addEventListener('zeldamaploaded', e => {
        buildId++;
        const gameName = e.detail.game;
        if (!GAMES[gameName]) return;
        const run = () => build(scene, gameName).catch(err => console.error('bomb stacking:', err));
        if (!deferGroupBuild(GROUP, GROUP_LABEL, run, false)) run();
    });
}
