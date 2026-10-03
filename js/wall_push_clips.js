import * as THREE from 'three';
import { currentColCtx } from './parse_model.js';
import { getPointSubdivisionIndex } from './subdivisions.js';
import { addModelCheckbox, primaryColorTarget } from './render.js';
import { sins } from './libultra_sins.js';
import { setupDynaExports, sceneNumPolygons } from './oot_actors.js';
import { getSelectedClips } from './selection.js';

////////////////////////////////////////
// System: Wall Push Clips (OOT / MM)
////////////////////////////////////////

/*
Shows the wall push clips found by tools/clipfinder (a native program; the
scan itself used to live here and was far too slow in the browser): spots
where one static wall pushes Link far enough behind another that he clips out
of bounds. Import loads its JSON onto the loaded map's collision, drawn as
markers with each point's details on click; "Reachable only" filters them by
the lowest speed Link can do them at (from the file, or worked out here the
first time); Export writes the shown points back out in the same format, for
tools/clipfinder/wall_clip_tester.lua.

The collision model below is the game's (BgCheck_CheckWallImpl's line test and
BgCheck_SphVsStaticWall's pushes, the floor check), all in f32 in the decomp's
operation order, for reachability. It has the dynapoly actors too when the
results were scanned with them (clipfinder --dyna, from "Export all
dynapolys" here): the same checks as
tools/clipfinder/src/collision.cpp. How the clips work and how they're
categorised: tools/clipfinder.

Loading a map also imports its results by itself ("Auto-import"): every file
clipfinder --out-dir wrote for it in the results folder, the static scans and
the dynapoly scans of the loaded setup, merged.
*/

// R_RUN_SPEED_LIMIT / 100 of each form's boots (z_player_lib.c): the default
// max speed for "Reachable only" (by the imported file's first form).
const FORM_RUN_SPEED = {
    Adult: 6.0, Child: 6.0, Crawlspace: 6.0,
    Human: 5.5, Deku: 6.0, Zora: 6.0, Goron: 6.0, FierceDeity: 10.0,
};

// Walking on the ground, Link's posNext is below his feet too: the floor check
// leaves a grounded actor's velocity.y at -4 (Actor_UpdateBgCheckInfo), gravity
// makes it -5 before he moves and Actor_UpdatePos moves 1.5x that, so the wall
// check runs 7.5 below the floor (seen in-game: MM Laundry Pool trace).
// OoT3D / MM3D run at 30 fps: Actor_UpdatePos moves velocity x 1.0 a frame,
// so walking posNext is 5 below the floor there (setGameRate, from `game`;
// clipfinder's setGameRate).
let GROUND_DROP = 7.5;

// Reachability: starts up to REACH_DIST away (speed 30 moves 45 a frame), every
// REACH_STEP, in 32 directions. Actor_UpdatePos moves speed * 1.5 a frame.
const DEFAULT_MAX_MOVE = 45;
let REACH_DIST = DEFAULT_MAX_MOVE;
const REACH_STEP = 1;

// How far Link can move in a frame (glitches can go well past speed 30):
// reachability starts up to n away (speed n / 1.5).
function setMaxMove(n) {
    REACH_DIST = n;
}
let SPEED_RATE = 1.5;
function setGameRate() {
    const is3ds = game === "OOT3D" || game === "MM3D";
    SPEED_RATE = is3ds ? 1.0 : 1.5;
    GROUND_DROP = 5 * SPEED_RATE;
}

const ACUTE_COLOR = 0xff3030;
const EXTENDED_COLOR = 0xff40ff;
const LOW_ACUTE_COLOR = 0x7040ff; // (indigo: blue was too close to the Main Model's 0x3aa6ff)
const LOW_EXTENDED_COLOR = 0x30e0ff;
const LOW_COLOR = 0x30c8ff; // falling clips from older files, not split by category
const SLOPE_COLOR = 0xff90d0; // slope clips (clipfinder slope.h)
const GROUND_COLOR = 0xd4a017; // ground clips (clipfinder ground.h)
const ACTION_1H_COLOR = 0x40e0ff; // action clips: a sword lunge's own move (clipfinder action.h), one-handed
const ACTION_2H_COLOR = 0xb070ff; // and two-handed (OoT Biggoron / Giant's Knife, MM Great Fairy's Sword)
const ACTION_STICK_COLOR = 0xc8a060; // and the Deku stick
const JUMP_1H_COLOR = 0x40ff90; // the jumpslash (clipfinder action.h Action::jump), one-handed
const JUMP_2H_COLOR = 0xff8040; // two-handed
const JUMP_STICK_COLOR = 0xa8d040; // the Deku stick
const SPIN_COLOR = 0x60ff40; // MM Deku spin, run up to 6 (clipfinder action.cpp dekuSpinFrames)
const BACKSPIN_COLOR = 0xff40c0; // and from a backwalk at 9
const ZORA_PUNCH_COLOR = 0x40a0ff; // MM Zora punch (clipfinder zoraActions)
const ZORA_JUMP_COLOR = 0x00d0c0; // Zora jumpslash
const ZORA_CLIP_COLOR = 0xff2060; // the Zora clip (jumpslash with B held: the fins aimed, a ~64 jump on landing)
const SPIN_LOCK_COLOR = 0xffa020; // the 2h spin attack ending locked on to an enemy (a ~22 / ~14 jump into its endR)
const SPIN_FWD_COLOR = 0xffe060; // a spin attack released with the stick forward (its lunge), no lock-on
const JUMP_LS_COLOR = 0xc0ff00; // the jumpslash with a lunge stored (15 -> 10, 5 after landing)
const PUSHER_COLOR = 0xffd000;

const SNORMAL_FLOOR = Math.trunc(0.5 * 32767);   // COLPOLY_SNORMAL(0.5f)
const SNORMAL_CEIL = Math.trunc(-0.8 * 32767);   // COLPOLY_SNORMAL(-0.8f)

////////////////////////////////////////
// Collision model (f32)
////////////////////////////////////////

// Everything the game computes is rounded to f32 after every operation, in the
// decomp's evaluation order, so positions match the game's bit for bit (MIPS
// has no fused multiply-add). A double product or quotient of two f32s rounded
// once to f32 is the correctly rounded f32 result.
const F = Math.fround;
const NORMAL_FRAC = F(1.0 / 32767.0);   // COLPOLY_NORMAL_FRAC
const SHT_MINV = F(1.0 / 32767.0);
const EPSILON = F(0.008);               // IS_ZERO
const isZero = v => Math.abs(v) < EPSILON;
const sq = v => F(v * v);

// Math_SinS / Math_CosS: sins(angle) * (1.0f / SHRT_MAX)
const SHRT_INV = F(1 / 32767);
const sinS = yaw => F(sins(yaw) * SHRT_INV);
const cosS = yaw => F(sins(yaw + 0x4000) * SHRT_INV);
// The s16 yaw pointing along (dx, dz) (x = sin, z = cos), as a u16.
const yawOf = (dx, dz) => Math.round(Math.atan2(dx, dz) / (2 * Math.PI) * 0x10000) & 0xFFFF;
// Link walking on the ground for a frame at `yaw` with speed `speed`:
// Actor_UpdateVelocityWithGravity + Actor_UpdatePos (x1.5, velocity.y -4 + gravity -1).
function moveStep(from, yaw, speed) {
    return {
        x: F(from.x + F(F(speed * sinS(yaw)) * SPEED_RATE)),
        y: F(from.y - GROUND_DROP),
        z: F(from.z + F(F(speed * cosS(yaw)) * SPEED_RATE)),
    };
}

function buildPoly(tri) {
    const [a, b, c] = tri.vtxs;
    const [sx, sy, sz] = tri.normals;
    const nx = F(sx * NORMAL_FRAC), ny = F(sy * NORMAL_FRAC), nz = F(sz * NORMAL_FRAC);
    const nXZ = F(Math.sqrt(F(sq(nx) + sq(nz))));
    const p = {
        id: tri.id, tri,
        ax: a.x, ay: a.y, az: a.z, bx: b.x, by: b.y, bz: b.z, cx: c.x, cy: c.y, cz: c.z,
        sx, sy, sz, nx, ny, nz, dist: tri.d,
        nMag: F(Math.sqrt(F(F(sq(nx) + sq(ny)) + sq(nz)))),
        nXZ, invNXZ: nXZ > 0 ? F(1 / nXZ) : 0,
        minX: Math.min(a.x, b.x, c.x), maxX: Math.max(a.x, b.x, c.x),
        minY: Math.min(a.y, b.y, c.y), maxY: Math.max(a.y, b.y, c.y),
        minZ: Math.min(a.z, b.z, c.z), maxZ: Math.max(a.z, b.z, c.z),
        isFloor: sy > SNORMAL_FLOOR,
        isCeiling: sy < SNORMAL_CEIL,
    };
    // CollisionPoly_GetMinY, including its bug for polys with ny = +-1
    p.sortY = (sy === 32767 || sy === -32767) ? a.y : p.minY;
    p.isWall = !p.isFloor && !p.isCeiling;
    p.tz = nXZ > 0 ? F(Math.abs(nz) * p.invNXZ) : 0;
    p.tx = nXZ > 0 ? F(Math.abs(nx) * p.invNXZ) : 0;
    return p;
}

// A dynapoly from an export (exportDynapolys): world-space s16 vertices and the
// normal / dist DynaPoly_ExpandSRT recomputes, sorted on its float normal (`type`).
function buildDynaPoly(id, q, bg, actorName, index) {
    const v = q.v.map(([x, y, z]) => ({ x, y, z }));
    const p = buildPoly({ id, vtxs: v, normals: q.n, d: q.d });
    p.bg = bg;
    p.isFloor = q.type === "floor";
    p.isCeiling = q.type === "ceiling";
    p.isWall = q.type === "wall";
    p.label = `TRI ${id} (${actorName} dynapoly ${index})`;
    return p;
}

// "TRI 12", or "TRI 1300 (Obj_Tokei_Tobira dynapoly 3)"
const polyLabel = p => p.label ?? `TRI ${p.id}`;

// Math3D_DistPlaneToPos
function planeDist(p, x, y, z) {
    if (isZero(p.nMag)) return 0;
    return F(F(F(F(F(p.nx * x) + F(p.ny * y)) + F(p.nz * z)) + p.dist) / p.nMag);
}

// Math3D_TriChkPointPara[XYZ]Impl, generic over the projected axes (a, b):
// X = (y, z), Y = (z, x), Z = (x, y).
function triChkPara(a0, b0, a1, b1, a2, b2, pa, pb, detMax, chkDist, nComp) {
    // Math3D_CirSquareVsTriSquare
    if (!(F(Math.min(a0, a1, a2) - chkDist) <= pa && F(Math.max(a0, a1, a2) + chkDist) >= pa &&
          F(Math.min(b0, b1, b2) - chkDist) <= pb && F(Math.max(b0, b1, b2) + chkDist) >= pb)) {
        return false;
    }
    const chkSq = sq(chkDist);
    if (F(sq(F(a0 - pa)) + sq(F(b0 - pb))) < chkSq || F(sq(F(a1 - pa)) + sq(F(b1 - pb))) < chkSq ||
        F(sq(F(a2 - pa)) + sq(F(b2 - pb))) < chkSq) {
        return true;
    }
    const d01 = F(F(F(a0 - pa) * F(b1 - pb)) - F(F(b0 - pb) * F(a1 - pa)));
    const d12 = F(F(F(a1 - pa) * F(b2 - pb)) - F(F(b1 - pb) * F(a2 - pa)));
    const d20 = F(F(F(a2 - pa) * F(b0 - pb)) - F(F(b2 - pb) * F(a0 - pa)));
    if ((d01 <= detMax && d12 <= detMax && d20 <= detMax) || (d01 >= -detMax && d12 >= -detMax && d20 >= -detMax)) {
        return true;
    }
    if (Math.abs(nComp) > 0.5) {
        if (edgeDistSq(pa, pb, a0, b0, a1, b1) < chkSq || edgeDistSq(pa, pb, a1, b1, a2, b2) < chkSq ||
            edgeDistSq(pa, pb, a2, b2, a0, b0) < chkSq) {
            return true;
        }
    }
    return false;
}

// Math3D_PointDistSqToLine2D; Infinity where it returns false
function edgeDistSq(x0, y0, x1, y1, x2, y2) {
    const dx = F(x2 - x1), dy = F(y2 - y1);
    const lenSq = F(sq(dx) + sq(dy));
    if (isZero(lenSq)) return Infinity;
    const t = F(F(F(F(x0 - x1) * dx) + F(F(y0 - y1) * dy)) / lenSq);
    if (!(t >= 0 && t <= 1)) return Infinity;
    return F(sq(F(F(F(dx * t) + x1) - x0)) + sq(F(F(F(dy * t) + y1) - y0)));
}

const triChkX = (p, y, z, detMax, chk) => triChkPara(p.ay, p.az, p.by, p.bz, p.cy, p.cz, y, z, detMax, chk, p.nx);
const triChkY = (p, z, x, detMax, chk) => triChkPara(p.az, p.ax, p.bz, p.bx, p.cz, p.cx, z, x, detMax, chk, p.ny);
const triChkZ = (p, x, y, detMax, chk) => triChkPara(p.ax, p.ay, p.bx, p.by, p.cx, p.cy, x, y, detMax, chk, p.nz);

// The game's tolerances (the extended plane), or none at all.
const LOOSE = { detMax: 300, chkDist: 1, lineChkDist: 1 };
const STRICT = { detMax: 0, chkDist: 0, lineChkDist: 0 };

// f32 -> s16 as the game stores it (truncating)
const toS16 = v => (Math.trunc(v) << 16) >> 16;

class CollisionModel {
    // dyna: an export's actors (exportDynapolys), in bgId order; their polys
    // get the ids after the scene's own, in order (as tools/clipfinder does).
    constructor(colCtx, triangles, radius, checkHeight, dyna = null) {
        this.colCtx = colCtx;
        this.radius = F(radius);
        this.checkHeight = F(checkHeight);
        this.polys = new Map();
        for (const tri of triangles) this.polys.set(tri.id, buildPoly(tri));
        // dynapoly actors: bgActors[i] = { name, walls, floors (dynaLookup
        // lists: head insertion, so last poly first), sphere, minY, maxY }
        this.bgActors = [];
        this.dynaWalls = [];
        let id = colCtx.colHeader.numPolygons;
        for (const a of dyna?.actors ?? []) {
            const bg = this.bgActors.length;
            const polys = a.polys.map((q, k) => buildDynaPoly(id++, q, bg, a.actor, k));
            for (const p of polys) this.polys.set(p.id, p);
            const rev = polys.slice().reverse();
            this.bgActors.push({
                name: a.actor, walls: rev.filter(p => p.isWall), floors: rev.filter(p => p.isFloor),
                cx: a.sphere.center[0], cy: a.sphere.center[1], cz: a.sphere.center[2], r: a.sphere.radius,
                minY: a.minY, maxY: a.maxY,
            });
            this.dynaWalls.push(...polys.filter(p => p.isWall));
        }
        this.cellCache = new Map();
        this.buildFloorGrid();
    }

    cellIndex(x, y, z) {
        return getPointSubdivisionIndex(this.colCtx, { x, y, z }).index;
    }

    // A subdivision's floor and wall lists in the game's order:
    // StaticLookup_AddPolyToSSList inserts each poly (in poly index order)
    // before the first one whose vertices are all above its CollisionPoly_GetMinY,
    // i.e. a stable sort on that.
    cell(index) {
        let c = this.cellCache.get(index);
        if (!c) {
            const sub = this.colCtx.subdivisions[index];
            const list = ids => (ids || []).map(id => this.polys.get(id)).filter(Boolean)
                .sort((a, b) => a.sortY - b.sortY || a.id - b.id);
            c = sub ? { walls: list(sub.walls).filter(p => p.isWall), floors: list(sub.floors).filter(p => p.isFloor) }
                    : { walls: [], floors: [] };
            this.cellCache.set(index, c);
        }
        return c;
    }

    cellWalls(x, y, z) {
        return this.cell(this.cellIndex(x, y, z)).walls;
    }

    buildFloorGrid() {
        this.floorCell = 128;
        this.floorGrid = new Map();
        for (const p of this.polys.values()) {
            if (!p.isFloor) continue;
            const x0 = Math.floor(p.minX / this.floorCell), x1 = Math.floor(p.maxX / this.floorCell);
            const z0 = Math.floor(p.minZ / this.floorCell), z1 = Math.floor(p.maxZ / this.floorCell);
            for (let gx = x0; gx <= x1; gx++) {
                for (let gz = z0; gz <= z1; gz++) {
                    const key = gx + "," + gz;
                    let cell = this.floorGrid.get(key);
                    if (!cell) this.floorGrid.set(key, cell = []);
                    cell.push(p);
                }
            }
        }
    }

    // Heights of the static floors under (x, z): CollisionPoly_CheckYIntersect
    // (detMax 0) and its y = ((-nx * x) - (nz * z) - dist) / ny.
    floorsAt(x, z) {
        const cell = this.floorGrid.get(Math.floor(x / this.floorCell) + "," + Math.floor(z / this.floorCell));
        const out = [];
        if (!cell) return out;
        for (const p of cell) {
            if (x < p.minX - 1 || x > p.maxX + 1 || z < p.minZ - 1 || z > p.maxZ + 1) continue;
            // (dynapolys: CollisionPoly_CheckYIntersectApprox1, detMax 300)
            if (!triChkY(p, z, x, p.bg !== undefined ? 300 : 0, 1)) continue;
            out.push(F(F(F(F(-p.nx * x) - F(p.nz * z)) - p.dist) / p.ny));
        }
        return out;
    }

    // BgCheck_CheckWallImpl after its line test, on the sphere at `pos` +
    // checkHeight: the dynapoly walls (BgCheck_SphVsDynaWall), then the static
    // ones (BgCheck_SphVsStaticWall) in the subdivision of where those left him
    // (BgCheck_GetNearestStaticLookup(posResult)), then - after a dynapoly
    // collision - the one-face static line check from `prev` (null: standing
    // still, pos + GROUND_DROP). lineDyna: the frame's line test stopped him
    // on a dynapoly. Returns the displaced feet position; each push is appended
    // to `trace` as { poly, from, to }.
    sphereStep(pos, tol, trace, prev = null, lineDyna = false) {
        const R = this.radius;
        const sphY = F(pos.y + this.checkHeight);
        let rx = pos.x, rz = pos.z;

        // One wall's push in a Z (pass 0) or X (pass 1) pass
        const tryPush = (p, pass) => {
            const pd = planeDist(p, rx, sphY, rz);
            if (R < Math.abs(pd)) return false;
            let hit = false;
            if (pass === 0) {
                if (p.tz < F(0.4)) return false;
                if (rz < F(p.minZ - R) || rz > F(p.maxZ + R)) return false;
                // CollisionPoly_CheckZIntersectApprox
                if (isZero(p.nz) || !triChkZ(p, rx, sphY, tol.detMax, tol.chkDist)) return false;
                const inter = F(F(F(F(-p.nx * rx) - F(p.ny * sphY)) - p.dist) / p.nz);
                const d = F(inter - rz);
                hit = Math.abs(d) <= F(R / p.tz) && F(d * p.nz) <= 4.0;
            } else {
                if (p.tx < F(0.4)) return false;
                if (rx < F(p.minX - R) || F(p.maxX + R) < rx) return false;
                // CollisionPoly_CheckXIntersectApprox
                if (isZero(p.nx) || !triChkX(p, sphY, rz, tol.detMax, tol.chkDist)) return false;
                const inter = F(F(F(F(-p.ny * sphY) - F(p.nz * rz)) - p.dist) / p.nx);
                const d = F(inter - rx);
                hit = Math.abs(d) <= F(R / p.tx) && F(d * p.nx) <= 4.0;
            }
            if (!hit) return false;
            // BgCheck_ComputeWallDisplacement
            const disp = F(F(R - pd) * p.invNXZ);
            const from = { x: rx, y: pos.y, z: rz };
            rx = F(rx + F(disp * p.nx));
            rz = F(rz + F(disp * p.nz));
            if (trace) trace.push({ poly: p, from, to: { x: rx, y: pos.y, z: rz } });
            return true;
        };

        // BgCheck_SphVsDynaWall: each bg actor whose Y range and bounding
        // sphere (grown by the radius, as an s16) take the sphere centre; all
        // its walls' Z pushes, then their X pushes (unsorted, no early out)
        let dynaHit = false;
        const grow = toS16(R); // TRUNCF_BINANG(radius)
        for (const bg of this.bgActors) {
            if (bg.minY > sphY || bg.maxY < sphY) continue;
            const r = toS16(bg.r + grow);
            const r2 = F(r * r);
            const dx = F(bg.cx - rx), dz = F(bg.cz - rz), dy = F(bg.cy - sphY);
            if (r2 < F(F(dx * dx) + F(dz * dz))) continue;
            if (!(F(F(dx * dx) + F(dy * dy)) <= r2) && !(F(F(dy * dy) + F(dz * dz)) <= r2)) continue;
            for (let pass = 0; pass < 2; pass++) {
                for (const p of bg.walls) if (tryPush(p, pass)) dynaHit = true;
            }
        }

        const list = this.cellWalls(rx, pos.y, rz);
        let staticHit = false;
        for (let pass = 0; pass < 2; pass++) {
            for (let i = 0; i < list.length; i++) {
                const p = list[i];
                if (sphY < p.minY) break;
                if (tryPush(p, pass)) staticHit = true;
            }
        }

        // A dynapoly collision: BgCheck_CheckLineImpl from posPrev to the
        // result, static walls from their front only (BGCHECK_CHECK_ONE_FACE |
        // BGCHECK_CHECK_WALL, no BGCHECK_CHECK_DYNA), putting him the radius in
        // front of the first one crossed.
        if (dynaHit || (lineDyna && !staticHit)) {
            const from = prev ?? { x: pos.x, y: F(pos.y + GROUND_DROP), z: pos.z };
            const to = { x: rx, y: pos.y, z: rz };
            const hit = this.lineHit(from, to, tol, false, true, false);
            if (hit && !isZero(hit.poly.nXZ)) {
                const k = F(R * F(1 / hit.poly.nXZ));
                rx = F(F(k * hit.poly.nx) + hit.x);
                rz = F(F(k * hit.poly.nz) + hit.z);
                if (trace) trace.push({ poly: hit.poly, from: to, to: { x: rx, y: pos.y, z: rz }, line: true });
            }
        }
        return { x: rx, y: pos.y, z: rz };
    }

    // CollisionPoly_LineVsPoly. With `oneFace` (BGCHECK_CHECK_ONE_FACE) a poly
    // crossed from its back to its front doesn't count. Returns the
    // intersection or null.
    lineVsPoly(p, a, b, chkDist, oneFace) {
        const planeA = F(F(F(F(F(p.sx * a.x) + F(p.sy * a.y)) + F(p.sz * a.z)) * NORMAL_FRAC) + p.dist);
        const planeB = F(F(F(F(F(p.sx * b.x) + F(p.sy * b.y)) + F(p.sz * b.z)) * NORMAL_FRAC) + p.dist);
        const delta = F(planeA - planeB);
        if ((planeA >= 0 && planeB >= 0) || (planeA < 0 && planeB < 0) || (oneFace && planeA < 0 && planeB > 0) ||
            isZero(delta)) return null;
        // Math3D_LineSplitRatio
        const t = F(planeA / delta);
        const i = {
            x: F(F(F(b.x - a.x) * t) + a.x),
            y: F(F(F(b.y - a.y) * t) + a.y),
            z: F(F(F(b.z - a.z) * t) + a.z),
        };
        if ((Math.abs(p.nx) > 0.5 && !isZero(p.nx) && triChkX(p, i.y, i.z, 0, chkDist)) ||
            (Math.abs(p.ny) > 0.5 && !isZero(p.ny) && triChkY(p, i.z, i.x, 0, chkDist)) ||
            (Math.abs(p.nz) > 0.5 && !isZero(p.nz) && triChkZ(p, i.x, i.y, 0, chkDist))) {
            return i;
        }
        return null;
    }

    // BgCheck_CheckLineImpl over static floors (if `floors`) and walls, then
    // (`dyna`) the dynapoly actors': the nearest intersection from a to b, or
    // null. Subdivisions are every cell between the two ends' (the
    // Math3D_LineVsCube cull only skips cells the segment misses, which can't
    // produce a hit anyway).
    lineHit(a, b, tol, floors, oneFace = false, dyna = true) {
        const ia = getPointSubdivisionIndex(this.colCtx, a);
        const ib = getPointSubdivisionIndex(this.colCtx, b);
        const cells = [];
        if (ia.index === ib.index) {
            cells.push(ia.index);
        } else {
            const amt = this.colCtx.subdivAmount;
            for (let sz = Math.min(ia.sz, ib.sz); sz <= Math.max(ia.sz, ib.sz); sz++)
                for (let sy = Math.min(ia.sy, ib.sy); sy <= Math.max(ia.sy, ib.sy); sy++)
                    for (let sx = Math.min(ia.sx, ib.sx); sx <= Math.max(ia.sx, ib.sx); sx++)
                        cells.push(sz * amt.x * amt.y + sy * amt.x + sx);
        }
        const checked = new Set();
        let best = null, bestDistSq = 1.0e38;
        let end = b;
        const scan = list => {
            for (const p of list) {
                if (checked.has(p)) continue;
                checked.add(p);
                if (a.y < p.sortY && end.y < p.sortY) break;
                const i = this.lineVsPoly(p, a, end, tol.lineChkDist, oneFace);
                if (!i) continue;
                const d = F(F(sq(F(a.x - i.x)) + sq(F(a.y - i.y))) + sq(F(a.z - i.z)));
                if (d < bestDistSq) {
                    bestDistSq = d;
                    best = { poly: p, ...i };
                    end = i;
                }
            }
        };
        for (const index of cells) {
            const c = this.cell(index);
            if (floors) scan(c.floors);
            scan(c.walls);
        }
        if (!dyna) return best;
        // BgCheck_CheckLineAgainstDyna, on the line as far as the static test
        // left it: each bg actor whose Y range and bounding sphere
        // (Math3D_LineVsSph) the line touches, its walls then (floors) floors
        const scanDyna = list => {
            for (const p of list) {
                const i = this.lineVsPoly(p, a, end, tol.lineChkDist, oneFace);
                if (!i) continue;
                const d = F(F(sq(F(a.x - i.x)) + sq(F(a.y - i.y))) + sq(F(a.z - i.z)));
                if (d < bestDistSq) {
                    bestDistSq = d;
                    best = { poly: p, ...i };
                    end = i;
                }
            }
        };
        for (const bg of this.bgActors) {
            if (a.y < bg.minY && end.y < bg.minY) continue;
            if (a.y > bg.maxY && end.y > bg.maxY) continue;
            if (!lineVsSphere(bg, a, end)) continue;
            scanDyna(bg.walls);
            if (floors) scanDyna(bg.floors);
        }
        return best;
    }

    wallsAlong(a, b) {
        const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.z - a.z) / 40));
        if (steps === 1) {
            const ia = this.cellIndex(a.x, a.y, a.z);
            const ib = this.cellIndex(b.x, a.y, b.z);
            if (ia === ib) return this.cell(ia).walls;
        }
        const seen = new Set();
        for (let s = 0; s <= steps; s++) {
            const t = s / steps;
            for (const p of this.cellWalls(a.x + (b.x - a.x) * t, a.y, a.z + (b.z - a.z) * t)) seen.add(p);
        }
        return seen;
    }

    // First wall crossed from its front to its back going from a to b at sphere
    // height (or from its back to its front, with `exiting`). Not a game
    // function: this is how the search decides Link went through a wall.
    crossedWall(a, b, exiting = false) {
        const y = a.y + this.checkHeight;
        let best = null, bestT = Infinity;
        const test = p => {
            if (y < p.minY || y > p.maxY) return;
            let dA = planeDist(p, a.x, y, a.z);
            let dB = planeDist(p, b.x, y, b.z);
            if (exiting) { dA = -dA; dB = -dB; }
            if (!(dA > 0 && dB < 0)) return;
            const t = dA / (dA - dB);
            if (t >= bestT) return;
            const ix = a.x + (b.x - a.x) * t, iz = a.z + (b.z - a.z) * t;
            if (pointInTri3D(p, ix, y, iz, 0.25)) {
                best = p;
                bestT = t;
            }
        };
        for (const p of this.wallsAlong(a, b)) test(p);
        const x0 = Math.min(a.x, b.x), x1 = Math.max(a.x, b.x), z0 = Math.min(a.z, b.z), z1 = Math.max(a.z, b.z);
        for (const p of this.dynaWalls) {
            if (p.maxX < x0 || p.minX > x1 || p.maxZ < z0 || p.minZ > z1) continue;
            test(p);
        }
        return best;
    }

    // Where Link comes to rest standing at `pos`: the wall pushes applied until
    // they stop moving him (at most 8 frames), or null if they don't settle.
    // (Standing still, posNext is GROUND_DROP below his feet every frame, so
    // that's the height the pushes run at: it matters for leaning walls.)
    // Still means not moved at all: the game does push him the last
    // thousandths (out to exactly the radius from a wall's stored plane), so
    // pushes under 0.01 don't count as still (tools/clipfinder does the same).
    restingSpot(pos) {
        let cur = pos;
        for (let i = 0; i < 8; i++) {
            const next = this.sphereStep({ x: cur.x, y: F(pos.y - GROUND_DROP), z: cur.z }, LOOSE, null);
            if (next.x === cur.x && next.z === cur.z) return cur;
            cur = { x: next.x, y: pos.y, z: next.z };
        }
        return null;
    }

    // BgCheck_RaycastFloorImpl for the actor floor check (flags 0x1C): the
    // highest static floor, or wall whose normal doesn't point down, under
    // (x, z) and below y, from the subdivision y is in (stepping down a
    // subdivision at a time while there's nothing). Null if none.
    // Then BgCheck_RaycastFloorDyna: each bg actor whose minY is under y and
    // whose bounding sphere takes (x, z) top down: its floors (detMax 300),
    // then - only while nothing, static or dynapoly, has been found yet - its
    // walls whose normal doesn't point down.
    floorCheck(x, z, y) {
        let best = this.staticFloorCheck(x, z, y);
        for (const bg of this.bgActors) {
            if (y < bg.minY) continue;
            const dx = F(bg.cx - x), dz = F(bg.cz - z);
            if (!(F(F(dx * dx) + F(dz * dz)) <= F(bg.r * bg.r))) continue;
            const scan = (list, walls) => {
                for (const p of list) {
                    if (walls && p.sy < 0) continue;
                    if (isZero(p.ny) || !triChkY(p, z, x, 300, 1)) continue;
                    const yi = F(F(F(F(-p.nx * x) - F(p.nz * z)) - p.dist) / p.ny);
                    if (yi < y && (best === null || best < yi)) best = yi;
                }
            };
            scan(bg.floors, false);
            if (best === null) scan(bg.walls, true);
        }
        return best;
    }

    staticFloorCheck(x, z, y) {
        const c = this.colCtx, mn = c.minBounds, mx = c.maxBounds;
        if (x < mn.x || x > mx.x || z < mn.z || z > mx.z) return null;
        for (let cy = y; cy >= mn.y; cy = F(cy - c.subdivLength.y)) {
            if (cy > mx.y) continue;
            const cell = this.cell(this.cellIndex(x, cy, z));
            let best = null;
            const scan = (list, walls) => {
                for (const p of list) {
                    if (y < p.minY) break;
                    if (walls && p.sy < 0) continue;
                    if (isZero(p.ny) || !triChkY(p, z, x, 0, 1)) continue;
                    const yi = F(F(F(F(-p.nx * x) - F(p.nz * z)) - p.dist) / p.ny);
                    if (yi < y && (best === null || yi > best)) best = yi;
                }
            };
            scan(cell.floors, false);
            scan(cell.walls, true);
            if (best !== null) return best;
        }
        return null;
    }

    // A wall that `pos` (at sphere height) is inside: less than 2 radii behind
    // it and within its triangle, i.e. inside the solid it bounds.
    behindWall(pos) {
        const y = pos.y + this.checkHeight;
        const inside = p => {
            if (y < p.minY || y > p.maxY) return false;
            const d = planeDist(p, pos.x, y, pos.z);
            if (!(d < 0 && d > -2 * this.radius)) return false;
            const k = d / p.nMag;
            return pointInTri3D(p, pos.x - k * p.nx, y - k * p.ny, pos.z - k * p.nz, 0);
        };
        for (const p of this.cellWalls(pos.x, pos.y, pos.z)) if (inside(p)) return p;
        const reach = 2 * this.radius;
        for (const p of this.dynaWalls) {
            if (pos.x < p.minX - reach || pos.x > p.maxX + reach || pos.z < p.minZ - reach || pos.z > p.maxZ + reach) continue;
            if (inside(p)) return p;
        }
        return null;
    }

    // Not inside a wall (behindWall), and horizontal rays at sphere height
    // don't see the back of a wall first in any direction. floorsBlock (where
    // Link starts or stands): a ray into a floor first doesn't count - up a
    // slope the rays go under the ground to the back of a wall far off
    // (tools/clipfinder Model::isInBounds).
    isInBounds(pos, floorsBlock = false) {
        if (this.behindWall(pos)) return false;
        const y = F(pos.y + this.checkHeight);
        const len = 400;
        for (let i = 0; i < 8; i++) {
            const ang = i * Math.PI / 4;
            const a = { x: pos.x, y, z: pos.z };
            const b = { x: F(pos.x + Math.sin(ang) * len), y, z: F(pos.z + Math.cos(ang) * len) };
            const hit = this.lineHit(a, b, STRICT, false);
            if (!hit || planeDist(hit.poly, a.x, a.y, a.z) >= 0) continue;
            // (only a ray that says out of bounds is checked again with floors:
            // otherwise they can't change its answer, and they're slow. A
            // floor's underside first: under the ground, out of bounds)
            if (floorsBlock) {
                const fh = this.lineHit(a, b, STRICT, true);
                if (fh && fh.poly.isFloor && planeDist(fh.poly, a.x, a.y, a.z) >= 0) continue;
            }
            return false;
        }
        return true;
    }
}

// Whether a clip through `crossed` ending at `end` counts: out of bounds, or -
// through a dynapoly (a gate, a fence, a crate) - just behind it, wherever
// that is (tools/clipfinder Model::endCounts)
function endCounts(model, crossed, end) {
    if (crossed && crossed.bg !== undefined && behindPoly(model, crossed, end)) return true;
    return !model.isInBounds(end);
}

// Still behind wall p at `pos`: at his check height, on its back side and
// within the triangle's span (not, say, landed on top of the crate it's a
// side of)
function behindPoly(model, p, pos) {
    const y = pos.y + model.checkHeight;
    if (y < p.minY || y > p.maxY) return false;
    const d = planeDist(p, pos.x, y, pos.z);
    if (!(d < 0)) return false;
    const k = d / p.nMag;
    return pointInTri3D(p, pos.x - k * p.nx, y - k * p.ny, pos.z - k * p.nz, 0.25);
}

// Math3D_LineVsSph on a bg actor's Sphere16
function lineVsSphere(bg, a, b) {
    const r2 = F(bg.r * bg.r);
    const inSph = p => {
        const dx = F(bg.cx - p.x), dy = F(bg.cy - p.y), dz = F(bg.cz - p.z);
        return F(F(F(dx * dx) + F(dy * dy)) + F(dz * dz)) <= r2;
    };
    if (inSph(a) || inSph(b)) return true;
    const lx = F(b.x - a.x), ly = F(b.y - a.y), lz = F(b.z - a.z);
    const len2 = F(F(F(lx * lx) + F(ly * ly)) + F(lz * lz));
    if (isZero(len2)) return false;
    const t = F(F(F(F(F(bg.cx - a.x) * lx) + F(F(bg.cy - a.y) * ly)) + F(F(bg.cz - a.z) * lz)) / len2);
    if (t < 0 || t > 1) return false;
    return inSph({ x: F(F(lx * t) + a.x), y: F(F(ly * t) + a.y), z: F(F(lz * t) + a.z) });
}

function pointInTri3D(p, x, y, z, tolerance) {
    // Project on the dominant normal axis and test with an edge tolerance.
    const ax = Math.abs(p.nx), ay = Math.abs(p.ny), az = Math.abs(p.nz);
    let a0, b0, a1, b1, a2, b2, pa, pb;
    if (ax >= ay && ax >= az) { [a0, b0, a1, b1, a2, b2, pa, pb] = [p.ay, p.az, p.by, p.bz, p.cy, p.cz, y, z]; }
    else if (az >= ay) { [a0, b0, a1, b1, a2, b2, pa, pb] = [p.ax, p.ay, p.bx, p.by, p.cx, p.cy, x, y]; }
    else { [a0, b0, a1, b1, a2, b2, pa, pb] = [p.az, p.ax, p.bz, p.bx, p.cz, p.cx, z, x]; }
    const d01 = (a0 - pa) * (b1 - pb) - (b0 - pb) * (a1 - pa);
    const d12 = (a1 - pa) * (b2 - pb) - (b1 - pb) * (a2 - pa);
    const d20 = (a2 - pa) * (b0 - pb) - (b2 - pb) * (a0 - pa);
    if ((d01 >= 0 && d12 >= 0 && d20 >= 0) || (d01 <= 0 && d12 <= 0 && d20 <= 0)) return true;
    const tSq = tolerance * tolerance;
    const near = (x0, y0, x1, y1, x2, y2) => {
        const dx = x2 - x1, dy = y2 - y1, len = dx * dx + dy * dy;
        if (len === 0) return false;
        const t = Math.max(0, Math.min(1, ((x0 - x1) * dx + (y0 - y1) * dy) / len));
        return (x1 + dx * t - x0) ** 2 + (y1 + dy * t - y0) ** 2 <= tSq;
    };
    return near(pa, pb, a0, b0, a1, b1) || near(pa, pb, a1, b1, a2, b2) || near(pa, pb, a2, b2, a0, b0);
}

////////////////////////////////////////
// Search
////////////////////////////////////////

// Checks the frame prev -> res (whose pushes are in `trace`) for a clip: the
// result is behind a wall it was in front of, and two more frames of standing
// still leave it there. Returns the wall crossed, the push that crossed it and
// where Link ends up, or null.
//
// With `rayFromY` (prevPos.y, Link walking) the frame's floor check runs first
// (func_800B7678): a ray down from rayFromY + 50 finds the highest floor - or
// wall facing up at all - under where he was pushed to, and he lands on it if
// it's above him or at most 11 below. Pushed into a sloped rock he can land on
// top of it that way, in front of the wall he went through.
// `move` ({ yaw, speed }, walking frames): if standing still afterwards puts
// him back, try keeping the stick held for one more frame (clip.hold).
function clipFromFrame(model, prev, res, trace, tol, rayFromY = null, move = null) {
    if (trace.length === 0) return null;
    // (at the frame's height: prevPos.xz, posNext.y)
    const from = { x: prev.x, y: res.y, z: prev.z };
    const crossed = model.crossedWall(from, res);
    if (!crossed) return null;

    let at = res, landY = null;
    if (rayFromY !== null) {
        const fy = model.floorCheck(res.x, res.z, F(rayFromY + 50));
        if (fy !== null && F(fy - res.y) >= -11) {
            landY = fy;
            // standing there from then on: the following frames' posNext
            at = { x: res.x, y: F(fy - GROUND_DROP), z: res.z };
        }
    }
    // Two more frames standing still from at0: still through the same wall -
    // or, landed at another height, through any: there it can be another
    // triangle (MM Treasure Chest Shop: pushed through the 40 high counter
    // front TRI 90, he lands on its top, behind TRI 73/74 of the wall above
    // it - in-game that clips walking at speed 11). Null if not.
    const standStill = (at0, landY0) => {
        const s1 = model.sphereStep(at0, tol, null);
        const s2 = model.sphereStep(s1, tol, null);
        const from2 = { x: prev.x, y: at0.y, z: prev.z };
        const held = model.crossedWall(from2, s2);
        if (landY0 === null ? held !== crossed : !held) return null;
        // Out the other side of a thin wall: through it, not out of bounds.
        // (through a dynapoly - a gate, a fence - that's what the clip is for)
        if (crossed.bg === undefined && model.crossedWall(from2, s2, true)) return null;
        return landY0 === null ? s2 : { x: s2.x, y: landY0, z: s2.z };
    };
    let end = standStill(at, landY);
    let hold = false;
    if (!end) {
        // Standing still, the wall he went through pushes him back out (he's
        // less than 4 behind it); holding the stick, the next frame's move can
        // take him further behind it first (tools/clipfinder clipFromFrame).
        if (!move || landY === null) return null;
        const st2 = { x: res.x, y: landY, z: res.z };
        const nx2 = moveStep(st2, move.yaw, move.speed);
        const lf = lineFrame(model, st2, nx2, tol);
        const r2 = lf ? lf.res : model.sphereStep(nx2, tol, null, st2);
        const fy = model.floorCheck(r2.x, r2.z, F(st2.y + 50));
        if (fy === null || F(fy - r2.y) < -11) return null;
        end = standStill({ x: r2.x, y: F(fy - GROUND_DROP), z: r2.z }, fy);
        if (!end) return null;
        hold = true;
    }

    // The push that took Link through `crossed`.
    const sphY = res.y + model.checkHeight;
    let pusher = null;
    for (const t of trace) {
        if (t.poly === crossed) continue;
        const before = planeDist(crossed, t.from.x, sphY, t.from.z);
        const after = planeDist(crossed, t.to.x, sphY, t.to.z);
        if (before >= 0 && after < 0) { pusher = t; break; }
    }
    if (!pusher) {
        for (let i = trace.length - 1; i >= 0; i--) {
            if (trace[i].poly !== crossed) { pusher = trace[i]; break; }
        }
    }
    if (!pusher) return null;
    return { crossed, pusher: pusher.poly, end, hold };
}

// Link moving from prev to next crosses a wall: BgCheck_CheckWallImpl's line
// check (at next.y + checkHeight) stops him at the nearest wall it hits and
// puts him `radius` in front of it, then the frame's pushes run.
function lineFrame(model, prev, next, tol) {
    const h = F(next.y + model.checkHeight);
    // BGCHECK_CHECK_ALL minus ceilings: one face only (a wall Link comes
    // through from behind doesn't stop him), and floors too when he moves
    // more than `radius` this frame.
    const dx = F(next.x - prev.x), dz = F(next.z - prev.z);
    const floors = sq(model.radius) < F(sq(dx) + sq(dz));
    const hit = model.lineHit({ x: prev.x, y: h, z: prev.z }, { x: next.x, y: h, z: next.z }, tol, floors, true);
    if (!hit || isZero(hit.poly.nXZ)) return null;
    const k = F(model.radius * F(1 / hit.poly.nXZ));
    const snapped = { x: F(F(k * hit.poly.nx) + hit.x), y: next.y, z: F(F(k * hit.poly.nz) + hit.z) };
    const trace = [{ poly: hit.poly, from: { ...next }, to: { ...snapped }, line: true }];
    const res = model.sphereStep(snapped, tol, trace, prev, hit.poly.bg !== undefined);
    return { hit, res, trace };
}

// Where Link can stand still near (x, z): on the highest floor within 10 of
// floorY, moved to where the wall pushes leave him alone (e.g. radius out from
// a wall), with his height from the floor he ends up over. Null if there's no
// floor there or the pushes don't settle.
function standSpot(model, x, z, floorY) {
    // (then the top one of the floors right there: overlapping triangles of a
    // bumpy slope give a few heights at once, and Link stands on the highest)
    const floorAt = (fx, fz) => {
        const ys = model.floorsAt(fx, fz);
        const y = ys.filter(y => Math.abs(y - floorY) <= 10).sort((a, b) => b - a)[0];
        return y === undefined ? y : Math.max(...ys.filter(v => v <= y + 3));
    };
    let y = floorAt(x, z);
    if (y === undefined) return null;
    for (let i = 0; i < 3; i++) {
        const rest = model.restingSpot({ x, y, z });
        if (!rest) return null;
        const ry = floorAt(rest.x, rest.z);
        if (ry === undefined) return null;
        if (rest.x === x && rest.z === z && ry === y) {
            // not under a floor within 50 above his feet: the floor check
            // (from pos.y + 50) would put him up on it (clipfinder standSpot)
            const fy = model.floorCheck(rest.x, rest.z, F(rest.y + 50));
            return fy !== null && fy > rest.y ? null : rest;
        }
        x = rest.x; z = rest.z; y = ry;
    }
    return null;
}

// Where falling Link lands after being pushed to `res`, if that's out of
// bounds: the floor check's ray comes down from prevPos.y + 50 (he was at least
// at the height of the floor at floorY), so the highest floor under res at most
// 50 above that one, then two frames standing there. No floor: he falls out of
// bounds. Null if he lands in bounds.
// crossed: the wall clipped through; behind a dynapoly counts wherever he lands (endCounts)
function landing(model, res, floorY, crossed = null) {
    // (the game's floor check: floors and upward-facing walls, see floorCheck)
    const land = model.floorCheck(res.x, res.z, F(floorY + 50));
    if (land === null) return { x: res.x, y: res.y, z: res.z, noFloor: true };
    const low = F(land - GROUND_DROP);
    const s = model.sphereStep(model.sphereStep({ x: res.x, y: low, z: res.z }, LOOSE, null), LOOSE, null);
    const end = { x: s.x, y: land, z: s.z };
    return endCounts(model, crossed, end) ? end : null;
}

// Can Link get to clip `c` from standing still somewhere? A standable start:
// where he comes to rest (the wall pushes applied until they stop moving him,
// e.g. resting against a slope) from a spot one frame's movement away in one
// of 32 directions, on a floor near the clip's floor height and in bounds. The
// frame from there straight at the point has to produce the clip through the
// same wall, ending out of bounds (for a standing point: nothing stops him on
// the way and the pushes do it; for a crossing point: the line check stops
// him on the pusher and the clip follows), as clipfinder's reachability()
// (tools/clipfinder/src/reach.cpp). Returns the lowest speed that works, the
// start and the yaw, or null.
function reachability(model, c) {
    const floorRef = c.floorY ?? c.from.y;
    const P = c.from;
    const over = c.cross ? 0.5 : 0; // a crossing has to get past the plane
    const tried = new Set();
    let best = null;
    for (let i = 0; i < 32; i++) {
        const ang = i / 32 * 2 * Math.PI;
        for (let d = REACH_STEP; d <= REACH_DIST; d += REACH_STEP) {
            if (best && (d + over) / SPEED_RATE >= best.speed + 2) break;
            const sx = F(P.x - d * Math.sin(ang)), sz = F(P.z - d * Math.cos(ang));
            const start = standSpot(model, sx, sz, floorRef);
            if (!start) continue;
            const key = start.x + "," + start.z;
            if (tried.has(key)) continue;
            tried.add(key);
            const vx = P.x - start.x, vz = P.z - start.z;
            const len = Math.hypot(vx, vz);
            if (len < 0.01 || len > REACH_DIST) continue;
            const speed = F((len + over) / SPEED_RATE);
            if (best && speed >= best.speed) continue;
            const yaw = yawOf(vx, vz);
            // the game's move at that yaw and speed
            const next = moveStep(start, yaw, speed);
            if (c.drop > 0) next.y = P.y;
            // (moving, a drop with checkHeight + dy < 5 gets the feet-level line
            // test that stops him on his floor)
            if (F(model.checkHeight + F(next.y - start.y)) < 5) continue;
            if (c.cross) {
                const f = lineFrame(model, start, next, LOOSE);
                if (!f || f.hit.poly !== c.pusher) continue;
                const clip = clipFromFrame(model, start, f.res, f.trace, LOOSE, c.drop > 0 ? null : start.y, { yaw, speed });
                if (!clip || clip.crossed !== c.crossed) continue;
                if (c.drop > 0 ? !landing(model, f.res, floorRef, clip.crossed) : !endCounts(model, clip.crossed, clip.end)) continue;
            } else {
                // nothing in the way, then the frame's pushes clip through the same wall
                if (lineFrame(model, start, next, LOOSE)) continue;
                const trace = [];
                const res = model.sphereStep(next, LOOSE, trace, start);
                const clip = clipFromFrame(model, start, res, trace, LOOSE, c.drop > 0 ? null : start.y, { yaw, speed });
                if (!clip || clip.crossed !== c.crossed) continue;
                if (c.drop > 0 ? !landing(model, res, floorRef, clip.crossed) : !endCounts(model, clip.crossed, clip.end)) continue;
            }
            if (!model.isInBounds(start, true)) continue;
            best = { speed, start, yaw };
        }
    }
    return best;
}

// Yield to the page between chunks of work. A MessageChannel message, since
// setTimeout gets throttled to once a second in a background tab.
const yieldChannel = new MessageChannel();
const yieldQueue = [];
yieldChannel.port1.onmessage = () => yieldQueue.shift()?.();
const nextTask = () => new Promise(resolve => {
    yieldQueue.push(resolve);
    yieldChannel.port2.postMessage(null);
});

// One group per (form, pusher, clipped wall, standing / crossing, cat).
// `cat` is how a clip is shown: its wall pair's category (`kind`, acute or
// extended), with falling ones ("low-acute" / "low-extended") apart; "low" for
// falling clips from files older than the per-pair categories. Clips carry
// their `form` and the `model` (radius, check height) they were found with.
function groupClips(clips) {
    const groups = new Map();
    for (const c of clips) {
        const key = [c.form ?? "", c.pusher.id, c.crossed.id, c.cross ? "cross" : "stand", c.cat].join(":");
        let g = groups.get(key);
        if (!g) groups.set(key, g = { pusher: c.pusher, crossed: c.crossed, cross: !!c.cross, cat: c.cat, clips: [], form: c.form, model: c.model });
        g.clips.push(c);
    }
    return [...groups.values()];
}

////////////////////////////////////////
// Markers
////////////////////////////////////////

// Shortest decimal that reads back as the same f32, and the f32's bits.
function f32Str(v) {
    let str = String(v);
    for (let p = 1; p <= 9; p++) {
        const t = Number(v.toPrecision(p));
        if (F(t) === v) { str = String(t); break; }
    }
    const dv = new DataView(new ArrayBuffer(4));
    dv.setFloat32(0, v);
    return `${str} (0x${dv.getUint32(0).toString(16).toUpperCase().padStart(8, "0")})`;
}
const fmt = p => `x ${f32Str(p.x)}, y ${f32Str(p.y)}, z ${f32Str(p.z)}`;
const hex4 = n => "0x" + (n & 0xFFFF).toString(16).toUpperCase().padStart(4, "0");

// A slope or ground clip's reach is its own move from a standing start
// (clipfinder slopeFrame / groundFrame): the faster of its (slope: two)
// frames. reachability() doesn't model them.
const slopeReach = c => ({ speed: Math.max(c.speed, c.speed2 ?? 0), yaw: c.yaw, start: c.prev });

function describeReach(c) {
    if (c.action) return `  reachable: the ${isSpinKey(c.actionKey) ? "spin" : c.actionKey?.includes("jumpslash") ? "jumpslash" : "lunge"} is the move (no stick speed needed)`;
    if (c.reach === undefined) return `  reachability: tick "Reachable only" to work it out`;
    if (!c.reach) return `  not reachable from a standable start (at up to speed ${REACH_DIST / SPEED_RATE})`;
    const r = c.reach;
    return `  reachable: stand at ${fmt(r.start)}, move at yaw ${hex4(r.yaw)} with speed ${r.speed.toFixed(2)} or more`;
}

function describeClip(g, c, checkHeight) {
    const form = g.form ? `  form: ${g.form} (radius ${g.model.radius}, check height ${+checkHeight.toPrecision(7)})\n` : "";
    const lines = describeClipLines(g, c, checkHeight).split("\n");
    // (clipfinder Model::endCounts: past a dynapoly, or somewhere he couldn't walk to from the start)
    // (Model::walkUnreachable: walkDistance > 0 is a shortcut - the walk there is a long way round)
    const inBounds = !c.inBounds ? "" : c.walkDistance > 0
        ? `\n  ends in bounds - a shortcut: walking there from his start is about ${c.walkDistance} (the clip goes ${Math.round(Math.hypot(c.end.x - c.prev.x, c.end.z - c.prev.z))})`
        : "\n  ends in bounds, somewhere Link couldn't walk to from his start (past a dynapoly, onto a ledge, into another room)";
    // (clipfinder --aerial: the start is mid-air where Link couldn't stand still)
    const aerial = c.aerial ? "\n  aerial start: Link has to be at the start in the air (e.g. knocked there by a bomb), he can't stand still there" : "";
    return [lines[0], form + lines.slice(1).join("\n")].join("\n") + inBounds + aerial + "\n" + describeReach(c);
}

// (clipfinder action clips' rows: the lunges' action-*, the jumpslash's jump-*)
const isActionCat = cat => cat.startsWith("action") || cat.startsWith("jump");
const isSpinKey = k => k?.startsWith("deku-spin");

const CAT_TITLES = {
    acute: "acute angle", extended: "extended plane only",
    "low-acute": "falling, acute angle", "low-extended": "falling, extended plane only", low: "falling",
    slope: "slope", ground: "ground", "action-1h": "action, one-handed", "action-2h": "action, two-handed", "action-stick": "action, Deku stick",
    "action-spin": "action, Deku spin", "action-backspin": "action, Deku spin from a backwalk",
    "action-zora": "action, Zora punch", "jump-zora": "jumpslash, Zora", "action-zoraclip": "action, Zora clip",
    "action-spinlock": "action, 2h spin attack locked on", "action-spinfwd": "action, spin attack with the stick forward", "jump-ls": "jumpslash, lunge stored",
    "jump-1h": "jumpslash, one-handed", "jump-2h": "jumpslash, two-handed", "jump-stick": "jumpslash, Deku stick",
};

// What the wall pair's category means (none for older files' falling clips).
function pairLine(g) {
    if (g.cat === "low" || g.cat === "slope" || g.cat === "ground" || isActionCat(g.cat)) return [];
    return [g.cat.endsWith("acute")
        ? `  wall pair: acute angle (at least one of its points clips with the extended planes removed)`
        : `  wall pair: extended plane only (every point needs ${polyLabel(g.pusher)}'s extended plane: its 1 unit tolerance, or Link beside it, past its edge)`];
}

function describeClipLines(g, c, checkHeight) {
    const lines = describeClipLinesBase(g, c, checkHeight);
    if (!c.hold) return lines;
    // (after the frame's line; clipfinder ClipResult::hold)
    const at = lines.indexOf("\n", lines.indexOf("\n") + 1);
    const note = `  keep holding the stick (same yaw and speed) one more frame: standing still, ${polyLabel(g.crossed)} pushes him back out`;
    return at < 0 ? lines + "\n" + note : lines.slice(0, at) + "\n" + note + lines.slice(at);
}

function describeClipLinesBase(g, c, checkHeight) {
    const behind = -planeDist(g.crossed, c.end.x, F(c.from.y + checkHeight), c.end.z);
    const title = CAT_TITLES[g.cat];
    if (g.cat === "slope") {
        // (clipfinder slope.h: the wall check runs checkHeight - 7.5 above the
        // floor Link starts on, under the wall; the floor check lifts him behind it)
        const speed = v => f32Str(v).split(" ")[0];
        return [
            `SLOPE CLIP: walking up to ${polyLabel(g.crossed)}, the floor check lifts Link onto ${polyLabel(g.pusher)} behind it`,
            `  clipfinder: --pair ${g.pusher.id},${g.crossed.id} (the floor, then the wall)`,
            `  stand still at ${fmt(c.prev)} (feet), move at yaw ${hex4(c.yaw)} with speed ${speed(c.speed)}`,
            `  posNext ${fmt(c.next)}: the wall check (y ${f32Str(F(c.next.y + checkHeight)).split(" ")[0]}) is under ${polyLabel(g.crossed)}'s bottom there`,
            `  the floor check puts him at ${fmt(c.res)}, behind ${polyLabel(g.crossed)}`,
            ...(c.speed2 !== undefined ? [`  standing still, ${polyLabel(g.crossed)} pushes him back out: move again the next frame (same yaw), ` +
                `e.g. at speed ${speed(c.speed2)}, the slowest that does (it pushes him out while he's at most 4 behind it)`] : []),
            c.end.noFloor ? `  then no floor under him: falls out of bounds` : `  ends at: ${fmt(c.end)} (out of bounds)`,
        ].join("\n");
    }
    if (isActionCat(g.cat)) {
        // (clipfinder action.h: each frame of the lunge is a walking frame of
        // the root motion, at facing + angle; then standing still. The
        // jumpslash: its air frames first, then the landing slash)
        const num = v => f32Str(v).split(" ")[0];
        const how = c.kind === "slope" ? `the floor check lifts Link onto ${polyLabel(g.pusher)}, behind ${polyLabel(g.crossed)}`
            : `${polyLabel(g.pusher)} pushes Link through ${polyLabel(g.crossed)} (${CAT_TITLES[c.kind] ?? c.kind})`;
        return [
            `ACTION CLIP (${c.action}): ${how}`,
            `  stand still at ${fmt(c.prev)} (feet), facing ${hex4(c.facing)}, and do the ${c.action}` +
                // (frames counted from the first one he moves on; clipfinder dekuSpinFrames / walkInVariant)
                // (MM3D: recorded by tools/clipfinder/tools/mm3d_action_recorder.lua, whose inputs these are)
                (c.actionKey === "deku-spin" && game === "MM3D" ? ` (the stick held at full tilt toward ${hex4(c.facing)} throughout: A once speedXZ reaches 6, about his 15th frame moving)`
                : c.actionKey === "deku-spin-backwalk" && game === "MM3D" ? ` (L held, the stick at full tilt toward ${hex4(c.facing + 0x8000)} - behind him - throughout: ` +
                    `once speedXZ is 9, about his 9th frame moving, let go of L for a frame, then A)`
                : c.actionKey === "deku-spin" ? ` (the stick held at full tilt toward ${hex4(c.facing)} throughout: A on his 4th frame moving, once speedXZ is 6)`
                : c.actionKey === "deku-spin-backwalk" ? ` (Z held, the stick at full tilt toward ${hex4(c.facing + 0x8000)} - behind him - throughout: ` +
                    `once speedXZ is 9, his 6th frame moving, let go of Z for a frame, then A)`
                : (c.actionKey?.endsWith("-walkin") ? ` (first the stick held toward ${hex4(c.facing)} for 9 frames, running into the corner, then the press)` : "") +
                // (MM Zora: no R - the barrier - and the clip keeps B held; clipfinder zoraActions)
                (c.actionKey?.startsWith("zora-clip") ? ` (fins out: hold B to aim them, hold Z, then A, B held to the end; ` +
                    (c.actionKey.replace(/-walkin$/, "").replace(/-ls$/, "").endsWith("-fwd") ? `the stick and Z held forward for ${c.airFrames ?? "its"} frames in the air)` : `the stick left alone)`)
                : c.actionKey?.startsWith("zora-jumpslash") ? ` (fins out: Z + A, ` +
                    (c.actionKey.replace(/-walkin$/, "").replace(/-ls$/, "").endsWith("-fwd") ? `the stick and Z held forward for ${c.airFrames ?? "its"} frames in the air)` : `the stick left alone)`)
                : c.actionKey?.startsWith("zora-punch") ? ` (B once)`
                // (clipfinder spinLockActions / lungeStored)
                : c.actionKey?.includes("spin-lock") ? ` (Z locked on to an enemy - the lock-on turns him to face it - slash and hold B to charge, ` +
                    `then let go of B${c.actionKey.replace(/-r$/, "").endsWith("-fwd") ? " with the stick forward (its lunge)" : ""}, Z still held as the spin ends` +
                    (c.actionKey.endsWith("-r") ? `; the frame after it switches to the locked-on end, let go of Z and hold R: the shield stops the step back - only with Z let go)` : `)`)
                : /^(1h|2h)-spin-fwd/.test(c.actionKey ?? "") ? ` (slash and hold B to charge, no Z, then let go of B with the stick forward: its lunge)`
                : /-ls(-walkin)?$/.test(c.actionKey ?? "") ? ` (with a lunge stored first - an attack whose lunge never fired, e.g. stopped by the sword hitting a wall - then ` +
                    (c.actionKey.replace(/-walkin$/, "").replace(/-ls$/, "").endsWith("-fwd") ? `Z + A, the stick and Z held forward for ${c.airFrames ?? "its"} frames in the air, then R held)` : `Z + A, the stick left alone, R held)`)
                : !c.actionKey?.includes("jumpslash") ? "" : c.actionKey.replace(/-walkin$/, "").replace(/-ls$/, "").endsWith("-fwd")
                    ? ` (Z + A, the stick and Z held forward for ${c.airFrames ?? "its"} frames in the air, then R held)`
                    : ` (Z + A, the stick left alone, R held: shield stops the step back)`)),
            `  its frames (speed, angle from facing): ${(c.actionFrames ?? []).map(([v, a]) => `${num(v)} at ${a < 0 ? "-" : "+"}${hex4(Math.abs(a))}`).join(", then ")}`,
            ...(c.frames ?? []).map((p, i) => `  after frame ${i + 1}: ${fmt(p)}`),
            `  the clip frame moves at yaw ${hex4(c.yaw)}, speed ${num(c.speed)}: posNext ${fmt(c.next)}`,
            // (clipfinder judge's canStop: the rest of the spin would carry him on, e.g. out the other side of a thin wall)
            ...(c.stopAfter ? [`  stop after frame ${c.stopAfter}: he's out of bounds inside the wall there (keep going and the rest of the frames carry him on)`] : []),
            c.end.noFloor ? `  then no floor under him: falls out of bounds` : `  ends at: ${fmt(c.end)} (out of bounds)`,
        ].join("\n");
    }
    if (g.cat === "ground") {
        // (clipfinder ground.h: falling fast, the wall check's line test runs
        // at the feet and misses the floor Link starts on: under the wall)
        const num = v => f32Str(v).split(" ")[0];
        return [
            `GROUND CLIP: falling from ${polyLabel(g.pusher)}, the line test at Link's feet misses it: through the ground, under ${polyLabel(g.crossed)}`,
            `  clipfinder: --pair ${g.pusher.id},${g.crossed.id} (the floor, then the wall)`,
            `  on the floor at ${fmt(c.prev)} (feet) with y velocity ${num(c.vy ?? -20)}, move at yaw ${hex4(c.yaw)} with speed ${num(c.speed)}`,
            `  posNext ${fmt(c.next)}: the wall check (y ${num(F(c.next.y + checkHeight))}) is under ${polyLabel(g.crossed)}'s bottom there`,
            `  after the frame: ${fmt(c.res)}`,
            c.end.noFloor ? `  no floor under him: falls out of bounds` : `  ends at: ${fmt(c.end)} (out of bounds)`,
        ].join("\n");
    }
    if (c.cross) {
        return [
            `WALL CROSSING CLIP (${title}): crossing ${polyLabel(g.pusher)} puts Link through ${polyLabel(g.crossed)}`,
            `  move through: ${fmt(c.from)} (feet; the crossing is ${+checkHeight.toPrecision(7)} above)`,
            ...(c.drop > 0 ? [`  that's ${c.drop} below the floor (y ${f32Str(c.floorY)}): falling at y velocity ` +
                `${(-c.drop / SPEED_RATE).toFixed(2)} or faster this frame`] : []),
            `  works moving at yaw ${c.yaws.map(hex4).join(", ")} (any speed that gets past ${polyLabel(g.pusher)}'s plane)`,
            `  e.g. ${c.aerial ? "in the air" : "standing still"} at ${fmt(c.prev)} (feet), moving to ${fmt(c.next)}` +
                (c.speed !== undefined ? ` (yaw ${hex4(c.yaw)}, speed ${f32Str(c.speed).split(" ")[0]})` : ""),
            `  line check + pushes put Link at: ${fmt(c.res)}`,
            c.drop > 0
                ? (c.end.noFloor ? `  no floor under where he's pushed to: falls out of bounds` : `  lands at: ${fmt(c.end)} (out of bounds)`)
                : `  after 2 more frames: ${fmt(c.end)} (${behind.toFixed(3)} units behind ${polyLabel(g.crossed)})`,
            ...pairLine(g),
        ].join("\n");
    }
    if (c.drop > 0) {
        return [
            `LOW WALL CLIP (${title}): ${polyLabel(g.pusher)} pushes Link through ${polyLabel(g.crossed)}`,
            `  Link at:   ${fmt(c.from)} (after moving there, e.g. from ${fmt(c.prev)})`,
            `  that's ${c.drop} below the floor (y ${f32Str(c.floorY)}): falling at y velocity ${(-c.drop / SPEED_RATE).toFixed(2)} or faster this frame`,
            `  pushed to: ${fmt(c.res)}`,
            c.end.noFloor ? `  no floor under where he's pushed to: falls out of bounds` : `  lands at:  ${fmt(c.end)} (out of bounds)`,
            ...pairLine(g),
        ].join("\n");
    }
    return [
        `WALL PUSH CLIP (${title}): ` +
            `${polyLabel(g.pusher)} pushes Link through ${polyLabel(g.crossed)}`,
        ...(c.speed !== undefined ? [
            `  stand still at ${fmt(c.prev)} (feet), move at yaw ${hex4(c.yaw)} with speed ${f32Str(c.speed).split(" ")[0]}`,
            `  Link at:   ${fmt(c.from)} (after that move)`,
        ] : [`  Link at:   ${fmt(c.from)} (after moving there, e.g. from ${fmt(c.prev)})`]),
        `  pushed to: ${fmt(c.res)}`,
        `  after 2 more frames: ${fmt(c.end)} (${behind.toFixed(3)} units behind ${polyLabel(g.crossed)})`,
        ...pairLine(g),
    ].join("\n");
}

// "Points on top": the clip points and their lines drawn in front of
// everything (no depth test), or hidden behind the scene like the rest.
let markersOnTop = true;
function applyMarkersOnTop(group) {
    group.traverse(o => {
        if (!o.userData.onTop) return;
        o.material.depthTest = !markersOnTop;
        o.material.needsUpdate = true;
    });
}

function buildMarkerGroup(model, groups, color, checkHeight) {
    const group = new THREE.Group();
    if (groups.length === 0) return group;

    const wallTris = (polys) => {
        const arr = [];
        for (const p of polys) arr.push(p.ax, p.ay, p.az, p.bx, p.by, p.bz, p.cx, p.cy, p.cz);
        return new THREE.Float32BufferAttribute(arr, 3);
    };
    const wallMesh = (polys, c, opacity) => {
        const geom = new THREE.BufferGeometry();
        geom.setAttribute("position", wallTris(polys));
        const mesh = new THREE.Mesh(geom, new THREE.MeshBasicMaterial({
            color: c, side: THREE.DoubleSide, transparent: true, opacity,
            depthWrite: false, polygonOffset: true, polygonOffsetFactor: -2, polygonOffsetUnits: -2,
        }));
        mesh.renderOrder = 5;
        mesh.userData.unselectable = true;
        return mesh;
    };

    // Clipped walls in the marker colour first, so primaryColorTarget picks them.
    const crossed = new Set(), pushers = new Set();
    for (const g of groups) { crossed.add(g.crossed); pushers.add(g.pusher); }
    group.add(wallMesh([...crossed], color, 0.45));
    group.add(wallMesh([...pushers].filter(p => !crossed.has(p)), PUSHER_COLOR, 0.35));

    // A dot where Link stands still before each clip (in bounds, so it shows
    // without "Points on top"; older files without one: where he is on the
    // frame), a dimmer line from there to where he is on the frame and a line
    // on to where he ends up. Each dot's description goes in
    // userData.clipSpots (same order as the positions) for selection.js to
    // show when it's clicked.
    // (clipRefs: each dot's group and clip, for "Export selected")
    const pts = [], lines = [], startLines = [], spots = [], clipRefs = [];
    const lift = 2;
    for (const g of groups) {
        for (const c of g.clips) {
            // Walking, the frame's position is below the floor (GROUND_DROP):
            // drawn on the floor under it instead, the end moved up with it.
            let up = lift;
            // (ground clips: posNext itself, under the ground)
            if (!(c.drop > 0) && c.floorY !== undefined && g.cat !== "ground") {
                const top = F(c.from.y + GROUND_DROP);
                // (only a floor near his height: past the edge of a ledge the
                // next one down can be far below)
                const under = model.floorsAt(c.from.x, c.from.z).filter(y => y <= top + 20 && y >= top - 20);
                up += (under.length ? Math.max(...under) : top) - c.from.y;
            }
            if (c.prev) pts.push(c.prev.x, c.prev.y + lift, c.prev.z);
            else pts.push(c.from.x, c.from.y + up, c.from.z);
            lines.push(c.from.x, c.from.y + up, c.from.z, c.end.x, c.end.y + up, c.end.z);
            if (c.prev) startLines.push(c.prev.x, c.prev.y + lift, c.prev.z, c.from.x, c.from.y + up, c.from.z);
            spots.push(describeClip(g, c, checkHeight));
            clipRefs.push({ g, c });
        }
    }
    const startGeom = new THREE.BufferGeometry();
    startGeom.setAttribute("position", new THREE.Float32BufferAttribute(startLines, 3));
    const startObj = new THREE.LineSegments(startGeom, new THREE.LineBasicMaterial({ color: 0x60ff60, depthTest: false, transparent: true, opacity: 0.5 }));
    startObj.renderOrder = 998;
    startObj.userData.onTop = true;
    startObj.userData.unselectable = true;
    group.add(startObj);
    const ptGeom = new THREE.BufferGeometry();
    ptGeom.setAttribute("position", new THREE.Float32BufferAttribute(pts, 3));
    const points = new THREE.Points(ptGeom, new THREE.PointsMaterial({ color, size: 12, sizeAttenuation: false, depthTest: false }));
    points.renderOrder = 999;
    points.userData.onTop = true;
    points.userData.unselectable = true;
    points.userData.clipSpots = spots;
    points.userData.clipRefs = clipRefs;
    group.add(points);

    const lineGeom = new THREE.BufferGeometry();
    lineGeom.setAttribute("position", new THREE.Float32BufferAttribute(lines, 3));
    const lineObj = new THREE.LineSegments(lineGeom, new THREE.LineBasicMaterial({ color: 0xffffff, depthTest: false, transparent: true, opacity: 0.8 }));
    lineObj.renderOrder = 999;
    lineObj.userData.unselectable = true;
    lineObj.userData.onTop = true;
    group.add(lineObj);

    applyMarkersOnTop(group);
    return group;
}

const MODEL_NAMES = {
    acute: "Acute Angle Clips", extended: "Extended Plane Clips",
    "low-acute": "Low Wall Clips (falling, acute)", "low-extended": "Low Wall Clips (falling, extended)",
    low: "Low Wall Clips (falling)", slope: "Slope Clips", ground: "Ground Clips",
    "action-1h": "Action Clips (1h lunges)", "action-2h": "Action Clips (2h lunges)", "action-stick": "Action Clips (Deku stick lunges)",
    "action-spin": "Action Clips (Deku spin)", "action-backspin": "Action Clips (backwalk Deku spin)",
    "action-zora": "Action Clips (Zora punch)", "jump-zora": "Action Clips (Zora jumpslash)", "action-zoraclip": "Action Clips (Zora clip)",
    "action-spinlock": "Action Clips (2h spin, locked on)", "action-spinfwd": "Action Clips (spin attack, stick forward)", "jump-ls": "Action Clips (jumpslash, lunge stored)",
    "jump-1h": "Action Clips (1h jumpslash)", "jump-2h": "Action Clips (2h jumpslash)", "jump-stick": "Action Clips (Deku stick jumpslash)",
};
const CAT_COLORS = {
    acute: ACUTE_COLOR, extended: EXTENDED_COLOR,
    "low-acute": LOW_ACUTE_COLOR, "low-extended": LOW_EXTENDED_COLOR, low: LOW_COLOR, slope: SLOPE_COLOR, ground: GROUND_COLOR,
    "action-1h": ACTION_1H_COLOR, "action-2h": ACTION_2H_COLOR, "action-stick": ACTION_STICK_COLOR,
    "action-spin": SPIN_COLOR, "action-backspin": BACKSPIN_COLOR,
    "action-zora": ZORA_PUNCH_COLOR, "jump-zora": ZORA_JUMP_COLOR, "action-zoraclip": ZORA_CLIP_COLOR,
    "action-spinlock": SPIN_LOCK_COLOR, "action-spinfwd": SPIN_FWD_COLOR, "jump-ls": JUMP_LS_COLOR,
    "jump-1h": JUMP_1H_COLOR, "jump-2h": JUMP_2H_COLOR, "jump-stick": JUMP_STICK_COLOR,
};

// The marker rows added (one per kind, or per kind and form for imported
// results with several forms), to take away again.
let markerNames = [];

function removeMarkerModels(scene) {
    const names = markerNames;
    markerNames = [];
    for (const name of names) {
        const idx = loadedModels.findIndex(m => m.name === name);
        if (idx < 0) continue;
        const old = loadedModels[idx];
        scene.remove(old.mesh);
        old.mesh.traverse(o => { if (o.geometry) o.geometry.dispose(); if (o.material) o.material.dispose(); });
        loadedModels.splice(idx, 1);
        const row = Array.from(document.querySelectorAll('.controls > *')).find(el => el.dataset && el.dataset.modelName === name);
        if (row) row.remove();
    }
}

// The shown points in tools/clipfinder's JSON format (wall-push-clips-2), for
// tools/clipfinder/wall_clip_tester.lua (set its TESTS_FILE to the file) and for
// importing again. Numbers are the exact f32s, written the shortest way that
// reads back the same.
function exportJson(groups, info) {
    const num = v => (Number.isInteger(v) || F(v) !== v) ? String(v) : f32Str(v).split(" ")[0];
    const vec = p => `[${num(p.x)},${num(p.y)},${num(p.z)}]`;
    const forms = new Map();
    for (const g of groups) {
        if (!forms.has(g.form)) forms.set(g.form, g.model);
    }
    const clips = [];
    for (const g of groups) {
        for (const c of g.clips) {
            const f = [
                `"form":${JSON.stringify(g.form)}`, `"kind":"${c.kind}"`, `"cross":${!!c.cross}`,
                `"drop":${c.drop ?? 0}`, `"pusher":${g.pusher.id}`, `"crossed":${g.crossed.id}`,
                `"from":${vec(c.from)}`, `"prev":${vec(c.prev)}`,
            ];
            if (c.next) f.push(`"next":${vec(c.next)}`);
            f.push(`"res":${vec(c.res)}`, `"end":${vec(c.end)}`);
            if (c.end.noFloor) f.push(`"endNoFloor":true`);
            if (c.hold) f.push(`"hold":true`);
            if (c.inBounds) f.push(`"inBounds":true`);
            if (c.walkDistance) f.push(`"walkDistance":${c.walkDistance}`);
            if (c.aerial) f.push(`"aerial":true`);
            if (c.floorY !== undefined) f.push(`"floorY":${num(c.floorY)}`);
            if (c.yaws) f.push(`"yaws":[${c.yaws.join(",")}]`);
            if (c.speed !== undefined) f.push(`"yaw":${c.yaw & 0xFFFF}`, `"speed":${num(c.speed)}`);
            if (c.speed2 !== undefined) f.push(`"speed2":${num(c.speed2)}`);
            if (c.vy !== undefined) f.push(`"vy":${num(c.vy)}`);
            if (c.action) {
                f.push(`"action":${JSON.stringify(c.action)}`, `"actionKey":${JSON.stringify(c.actionKey)}`, `"facing":${c.facing & 0xFFFF}`,
                    `"actionFrames":[${c.actionFrames.map(([v, a]) => `[${num(v)},${a}]`).join(",")}]`, `"frames":[${c.frames.map(vec).join(",")}]`);
                if (c.airFrames) f.push(`"airFrames":${c.airFrames}`);
                if (c.stopAfter) f.push(`"stopAfter":${c.stopAfter}`);
            }
            if (c.reach === null) f.push(`"reach":null`);
            else if (c.reach) f.push(`"reach":{"speed":${num(c.reach.speed)},"yaw":${c.reach.yaw & 0xFFFF},"start":${vec(c.reach.start)}}`);
            clips.push(`    {${f.join(",")}}`);
        }
    }
    return [
        `{`,
        `  "format": "wall-push-clips-2",`,
        `  "game": ${JSON.stringify(info.game)}, "map": ${JSON.stringify(info.map)}, "falling": ${info.falling}, ` +
            `"extendedOnly": ${info.extendedOnly}, "numPolygons": ${info.numPolygons}` +
            (REACH_DIST !== DEFAULT_MAX_MOVE ? `, "maxMove": ${num(REACH_DIST)}` : "") + `,`,
        `  "forms": [`,
        [...forms].map(([name, m]) => `    {"form":${JSON.stringify(name)},"radius":${num(m.radius)},"checkHeight":${num(m.checkHeight)}}`).join(",\n"),
        `  ],`,
        `  "clips": [`,
        clips.join(",\n"),
        `  ]` + (info.dyna ? `,\n  "dyna": ${JSON.stringify(info.dyna)}` : ""),
        `}`,
        ``,
    ].join("\n");
}

// dynaExports in bgId order, without the sort key
const bgOrder = exports => exports.slice().sort((a, b) => a.order - b.order).map(({ order, ...rest }) => rest);

// One actor / poly per line, so the file stays readable. `ind`: extra
// indentation (a scene of a dynapoly-set-1 file).
function exportDynapolyJson(data, ind = "") {
    const actor = a => {
        const { polys, ...head } = a;
        const h = JSON.stringify(head);
        return `${ind}    ${h.slice(0, -1)},"polys":[\n` + polys.map(q => `${ind}      ${JSON.stringify(q)}`).join(",\n") + `\n${ind}    ]}`;
    };
    return [
        `${ind}{`,
        `${ind}  "format": ${JSON.stringify(data.format)}, "game": ${JSON.stringify(data.game)}, "map": ${JSON.stringify(data.map)}, ` +
            (data.setups ? `"setups": ${JSON.stringify(data.setups)}, ` : "") + `"numPolygons": ${data.numPolygons},`,
        `${ind}  "actors": [`,
        data.actors.map(actor).join(",\n"),
        `${ind}  ]`,
        `${ind}}`,
    ].join("\n");
}

// Every map's dynapolys, every setup, for clipfinder --dyna with --all: one
// dynapoly-1 export per distinct set of dynapolys a map's setups load (setups
// with the same ones share an entry, `setups` listing them), in a
// dynapoly-set-1 file. Nothing is drawn: the spawns are expanded and the
// dynapoly actors built as for the Actors rows (setupDynaExports), each in
// its default state and all of them (no rows to hide). Maps without dynapolys
// are left out.
async function exportAllDynapolys(g, progress) {
    const maps = g === "OOT" ? OOT_Maps : MM_Maps;
    const byScene = await (await fetch(`./models/${g}/actors/${g}_actors_by_scene.json`, { cache: "no-cache" })).json();
    const scenes = [];
    for (let i = 0; i < maps.length; i++) {
        const m = maps[i];
        progress(`${m.name} (${i + 1}/${maps.length})`);
        const setups = byScene[m.file];
        if (!setups) continue;
        const res = await fetch(`./models/${g}/${m.file}`);
        if (!res.ok) { console.warn(`Export all dynapolys: ${m.file}: ${res.status}`); continue; }
        const buffer = await res.arrayBuffer();
        const numPolygons = sceneNumPolygons(buffer);
        const entries = [];
        for (let s = 0; s < setups.length; s++) {
            if (!setups[s]) continue;
            const actors = bgOrder(await setupDynaExports(g, buffer, m.file, setups[s], s, setups.flatMap((x, i) => x ? [i] : [])));
            if (!actors.length) continue;
            const key = JSON.stringify(actors);
            const same = entries.find(e => e.key === key);
            if (same) same.setups.push(s);
            else entries.push({ key, setups: [s], actors });
        }
        for (const e of entries) scenes.push({ format: "dynapoly-1", game: g, map: m.name, setups: e.setups, numPolygons, actors: e.actors });
    }
    const text = `{\n  "format": "dynapoly-set-1", "game": ${JSON.stringify(g)},\n  "scenes": [\n` +
        scenes.map(sc => exportDynapolyJson(sc, "    ")).join(",\n") + `\n  ]\n}\n`;
    return { scenes, text };
}

// clipfinder --out-dir's file names: safeName in main.cpp
const safeName = s => s.replace(/[^A-Za-z0-9_-]/g, "_");

// The .json files the dev server lists in `dir` (python -m http.server's
// directory page) whose names start with `prefix`
async function listResultFiles(dir, prefix) {
    const base = dir.replace(/\\/g, "/").replace(/\/*$/, "/");
    const res = await fetch(base, { cache: "no-store" });
    if (!res.ok) return null;
    const html = await res.text();
    const names = new Set();
    for (const m of html.matchAll(/href="([^"?#]+\.json)"/gi)) {
        let name;
        try { name = decodeURIComponent(m[1]); } catch { continue; }
        if (!name.includes("/") && name.startsWith(prefix)) names.add(name);
    }
    return [...names].sort().map(name => ({ name, url: base + encodeURIComponent(name) }));
}

function logGroups(groups) {
    const xyz = p => [p.x, p.y, p.z].map(v => f32Str(v).split(" ")[0]).join(", ");
    const rows = groups.map(g => {
        const c = g.clips[0];
        return {
            kind: g.cat,
            type: g.cross ? "crossing" : "standing",
            pusherPoly: g.pusher.id,
            clippedPoly: g.crossed.id,
            points: g.clips.length,
            example: xyz(c.from),
            end: xyz(c.end),
        };
    });
    console.log("Wall push clips:");
    console.table(rows);
}

////////////////////////////////////////
// UI
////////////////////////////////////////

export function setupWallPushClipUI(scene) {
    const container = document.getElementById("wallClipContainer");
    const status = document.getElementById("wallClipStatus");
    const reachableChk = document.getElementById("wallClipReachable");
    const maxSpeedInput = document.getElementById("wallClipMaxSpeed");
    const maxMoveInput = document.getElementById("wallClipMaxMove");
    const vyChk = document.getElementById("wallClipVyFilter");
    const maxVyInput = document.getElementById("wallClipMaxVy");
    if (!container) return;

    // The imported results, drawn again when the reachable filter changes.
    let last = null;

    const refresh = () => {
        container.style.display = ["OOT", "MM", "OOT3D", "MM3D"].includes(game) ? "flex" : "none";
        setGameRate();
    };
    document.getElementById("selected-game").addEventListener("change", refresh);
    document.getElementById("loadMap").addEventListener("click", () => {
        reachToken++; // abandon reachability for the previous map
        autoToken++;  // and its auto-import
        importToken++; // and an import still going
        last = null;
        loaded = null;
        status.textContent = "";
        refresh();
    });
    refresh();

    // Reachability (when the file doesn't have it) is worked out the first
    // time the filter is switched on.
    let reachToken = 0;
    // (an import yields to the page as it goes: a newer import or map load
    // abandons it)
    let importToken = 0;
    const computeReach = async () => {
        const token = ++reachToken;
        const clips = last.groups.flatMap(g => g.clips);
        let lastYield = performance.now();
        for (let i = 0; i < clips.length; i++) {
            if (clips[i].reach === undefined) clips[i].reach = clips[i].kind === "slope" || clips[i].kind === "ground" ? slopeReach(clips[i]) : reachability(clips[i].model, clips[i]);
            if (performance.now() - lastYield > 30) {
                status.textContent = `Checking reachability ${Math.floor((i + 1) / clips.length * 100)}%`;
                await nextTask();
                if (token !== reachToken || !last) return false;
                lastYield = performance.now();
            }
        }
        last.reachDone = true;
        return true;
    };

    // The |velocity.y| a clip needs this frame (Actor_UpdatePos moves 1.5x
    // it): ground clips their vy, falling ones their fall / 1.5 (from the
    // reachable start when `useReach`, as reachability() falls to the clip
    // point). Walking and slope clips don't depend on it: 0, never filtered.
    const neededVy = (c, useReach) => {
        if (c.kind === "ground") return Math.abs(c.vy ?? -20);
        if (!(c.drop > 0)) return 0;
        if (useReach && c.reach) return (c.reach.start.y - c.from.y) / SPEED_RATE;
        return (c.next ? c.prev.y - c.next.y : c.drop) / SPEED_RATE;
    };

    const render = async () => {
        if (!last) return;
        if (reachableChk.checked && !last.reachDone) {
            reachableChk.disabled = true;
            const done = await computeReach();
            reachableChk.disabled = false;
            if (!done) return;
        }
        removeMarkerModels(scene);
        const maxSpeed = Number(maxSpeedInput.value);
        const byReach = reachableChk.checked, byVy = vyChk.checked;
        const maxVy = Number(maxVyInput.value);
        const keep = c => (!byReach || (c.reach && c.reach.speed <= maxSpeed)) &&
            (!byVy || neededVy(c, byReach) <= maxVy + 1e-4);
        const shown = byReach || byVy
            ? last.groups.map(g => ({ ...g, clips: g.clips.filter(keep) })).filter(g => g.clips.length > 0)
            : last.groups;
        const byKind = {};
        for (const cat of Object.keys(MODEL_NAMES)) byKind[cat] = shown.filter(g => g.cat === cat);
        const colors = CAT_COLORS;
        // Several forms: a row per kind and form, each drawn with its own
        // form's radius and check height
        const several = last.forms.length > 1;
        for (const kind of Object.keys(MODEL_NAMES)) {
            for (const f of last.forms) {
                const list = byKind[kind].filter(g => g.form === f.form);
                if (list.length === 0) continue;
                const name = MODEL_NAMES[kind] + (several ? ` - ${f.form}` : "");
                const g = buildMarkerGroup(f.model, list, colors[kind], f.model.checkHeight);
                g.userData.clipGroups = list;
                scene.add(g);
                loadedModels.push({ name, mesh: g, edges: null });
                markerNames.push(name);
                addModelCheckbox(scene, name, g, null, false, true, "#" + colors[kind].toString(16).padStart(6, "0"), false, primaryColorTarget(g));
            }
        }
        const points = kind => byKind[kind].reduce((n, g) => n + g.clips.length, 0);
        const low = points("low-acute") + points("low-extended") + points("low");
        status.textContent = `${points("acute")} acute, ${points("extended")} extended-plane, ${low} low (falling` +
            (points("low") ? "" : `: ${points("low-acute")} acute, ${points("low-extended")} extended`) + `)` +
            (points("slope") ? `, ${points("slope")} slope` : "") + (points("ground") ? `, ${points("ground")} ground` : "") +
            (points("action-1h") ? `, ${points("action-1h")} 1h lunge` : "") + (points("action-2h") ? `, ${points("action-2h")} 2h lunge` : "") +
            (points("action-stick") ? `, ${points("action-stick")} Deku stick lunge` : "") +
            (points("action-spin") ? `, ${points("action-spin")} Deku spin` : "") +
            (points("action-backspin") ? `, ${points("action-backspin")} backwalk Deku spin` : "") +
            (points("action-zora") ? `, ${points("action-zora")} Zora punch` : "") +
            (points("jump-zora") ? `, ${points("jump-zora")} Zora jumpslash` : "") +
            (points("action-zoraclip") ? `, ${points("action-zoraclip")} Zora clip` : "") +
            (points("action-spinlock") ? `, ${points("action-spinlock")} 2h spin locked on` : "") +
            (points("action-spinfwd") ? `, ${points("action-spinfwd")} spin attack (stick forward)` : "") +
            (points("jump-ls") ? `, ${points("jump-ls")} lunge-stored jumpslash` : "") +
            (points("jump-1h") ? `, ${points("jump-1h")} 1h jumpslash` : "") + (points("jump-2h") ? `, ${points("jump-2h")} 2h jumpslash` : "") +
            (points("jump-stick") ? `, ${points("jump-stick")} Deku stick jumpslash` : "") + ` ` +
            `clip points${byReach ? ` reachable at speed ${maxSpeed}` : ""}${byVy ? ` at |y velocity| ${maxVy} or less` : ""} (${last.note})`;
        window.wallPushClips = shown;
    };
    reachableChk.addEventListener("change", render);
    // (remembered in this browser)
    try {
        const v = JSON.parse(localStorage.getItem("wallClipVy") ?? "null");
        if (v) { vyChk.checked = !!v.on; if (Number.isFinite(Number(v.max))) maxVyInput.value = v.max; }
    } catch (e) { }
    const onVyChange = () => {
        try { localStorage.setItem("wallClipVy", JSON.stringify({ on: vyChk.checked, max: maxVyInput.value })); } catch (e) { }
        render();
    };
    vyChk.addEventListener("change", onVyChange);
    maxVyInput.addEventListener("change", onVyChange);
    // Set by hand, the speed stays through map loads and page reloads
    // (remembered in this browser; imports set the form's run speed only
    // until then).
    let maxSpeedChosen = false;
    try {
        const v = localStorage.getItem("wallClipMaxSpeed");
        if (v !== null && v !== "" && Number.isFinite(Number(v))) { maxSpeedInput.value = v; maxSpeedChosen = true; }
    } catch (e) { }
    maxSpeedInput.addEventListener("change", () => {
        maxSpeedChosen = true;
        try { localStorage.setItem("wallClipMaxSpeed", maxSpeedInput.value); } catch (e) { }
        render();
    });
    // (remembered in this browser)
    const onTopChk = document.getElementById("wallClipOnTop");
    try { const v = localStorage.getItem("wallClipOnTop"); if (v !== null) onTopChk.checked = v === "1"; } catch (e) { }
    markersOnTop = onTopChk.checked;
    onTopChk.addEventListener("change", () => {
        markersOnTop = onTopChk.checked;
        try { localStorage.setItem("wallClipOnTop", markersOnTop ? "1" : "0"); } catch (e) { }
        for (const m of loadedModels) if (markerNames.includes(m.name)) applyMarkersOnTop(m.mesh);
    });

    document.getElementById("wallClipExport").addEventListener("click", () => {
        if (!last || !window.wallPushClips) {
            status.textContent = "Import results first";
            return;
        }
        // The shown points of the clip kinds whose rows are ticked
        const ticked = loadedModels.filter(m => markerNames.includes(m.name) && m.mesh.visible)
            .flatMap(m => m.mesh.userData.clipGroups ?? []);
        if (ticked.length === 0) {
            status.textContent = "No clip points shown to export";
            return;
        }
        downloadClips(ticked, "");
    });
    // exportJson of these groups, downloaded as <GAME>_<map>_<forms><suffix>.json
    function downloadClips(groups, suffix) {
        const map = document.getElementById("mapDropdown").value;
        const text = exportJson(groups, {
            game, map, falling: last.falling, extendedOnly: last.extendedOnly,
            numPolygons: last.numPolygons, dyna: last.dyna,
        });
        const a = document.createElement("a");
        a.href = URL.createObjectURL(new Blob([text], { type: "application/json" }));
        a.download = `${game}_${map}_${last.formLabel}${suffix}`.replace(/[^A-Za-z0-9_-]/g, "_") + ".json";
        a.click();
        URL.revokeObjectURL(a.href);
    }

    // Just the selected dots (selection.js), each clip once, grouped by the
    // wall pair group it was drawn from
    document.getElementById("wallClipExportSelected").addEventListener("click", () => {
        if (!last || !window.wallPushClips) {
            status.textContent = "Import results first";
            return;
        }
        const byGroup = new Map();
        for (const { g, c } of getSelectedClips()) {
            if (!byGroup.has(g)) byGroup.set(g, new Set());
            byGroup.get(g).add(c);
        }
        if (byGroup.size === 0) {
            status.textContent = "No clip points selected: click a dot to select it (tick Multi-select for several)";
            return;
        }
        const groups = [...byGroup].map(([g, cs]) => ({ ...g, clips: [...cs] }));
        downloadClips(groups, "_selected");
        status.textContent = `Exported ${groups.reduce((n, g) => n + g.clips.length, 0)} selected clip points`;
    });

    // Every map and setup's dynapolys in one file, for clipfinder --all --dyna
    const exportAllBtn = document.getElementById("wallClipDynaExportAll");
    exportAllBtn.addEventListener("click", async () => {
        const g = game;
        if (g !== "OOT" && g !== "MM") return;
        exportAllBtn.disabled = true;
        const t0 = performance.now();
        try {
            const { scenes, text } = await exportAllDynapolys(g, what => { status.textContent = `Exporting dynapolys: ${what}`; });
            const a = document.createElement("a");
            a.href = URL.createObjectURL(new Blob([text], { type: "application/json" }));
            a.download = `${g}_dyna_all.json`;
            a.click();
            URL.revokeObjectURL(a.href);
            const maps = new Set(scenes.map(sc => sc.map)).size;
            const setups = scenes.reduce((n, sc) => n + sc.setups.length, 0);
            status.textContent = `Exported the dynapolys of ${maps} maps: ${setups} setups, ${scenes.length} distinct ` +
                `(${((performance.now() - t0) / 1000).toFixed(0)} s)`;
        } catch (err) {
            console.error(err);
            status.textContent = `Export all dynapolys failed: ${err.message}`;
        } finally {
            exportAllBtn.disabled = false;
        }
    });

    // Max move a frame: how far away reachability looks for starts (the
    // reachability worked out so far is redone with it)
    const applyMaxMove = () => {
        const n = Number(maxMoveInput.value);
        setMaxMove(n > 0 ? n : DEFAULT_MAX_MOVE);
        if (!last) return;
        for (const g of last.groups) for (const c of g.clips) delete c.reach;
        last.reachDone = false;
        render();
    };
    maxMoveInput.addEventListener("change", applyMaxMove);
    setMaxMove(Number(maxMoveInput.value) > 0 ? Number(maxMoveInput.value) : DEFAULT_MAX_MOVE);

    // Results from tools/clipfinder: the points are turned back into the
    // viewer's own objects on the loaded map's collision (markers, click info,
    // Reachable only, test script export). Several files (auto-import) are
    // merged: forms by name, each point once. The dynapolys (and so the poly
    // ids past numPolygons) are the first dynapoly scan's; a static scan's
    // points only use the scene's own ids.
    const importResults = async (files, how) => {
        const token = ++importToken;
        const main = loadedModels.find(m => m.name === "Main Model");
        const colCtx = currentColCtx;
        reachToken++;
        // Progress in the status line, yielding to the page every 30 ms (so
        // it shows); false when abandoned
        let lastYield = performance.now();
        const progress = async (text, force = false) => {
            if (!force && performance.now() - lastYield <= 30) return true;
            status.textContent = text;
            await nextTask();
            lastYield = performance.now();
            return token === importToken;
        };
        removeMarkerModels(scene);
        last = null;
        const dynaFile = files.find(f => f.data.dyna);
        const dyna = dynaFile?.data.dyna ?? null;
        for (const f of files) {
            if (f.data.dyna && f !== dynaFile && JSON.stringify(f.data.dyna.actors) !== JSON.stringify(dyna.actors))
                console.warn(`wall push clips: ${f.name} was scanned with other dynapolys than ${dynaFile.name}; its dynapoly ids are read as ${dynaFile.name}'s`);
        }
        // (clipfinder --max-move: reachability as far as its scan went)
        maxMoveInput.value = Math.max(...files.map(f => f.data.maxMove ?? DEFAULT_MAX_MOVE));
        setMaxMove(Number(maxMoveInput.value));
        // Format 1: one form. Format 2: `forms` (name, radius, check height)
        // and each clip marked with its form, each form getting its own model.
        const forms = [];
        const formOf = new Map();
        const fileForms = [];
        for (const { data } of files) {
            const list = [];
            for (const f of data.forms ?? [{ form: data.form, radius: data.radius, checkHeight: data.checkHeight }]) {
                if (!formOf.has(f.form)) {
                    if (!await progress(`Importing clips: collision for ${f.form}…`, true)) return;
                    const e = { form: f.form, model: new CollisionModel(colCtx, main.mesh.userData.triangles, f.radius, f.checkHeight, dyna) };
                    forms.push(e);
                    formOf.set(f.form, e);
                }
                list.push(formOf.get(f.form));
            }
            fileForms.push(list);
        }
        // Max speed: the first form's run speed ("Human/Deku": Human's), unless
        // one was set by hand
        const runSpeed = FORM_RUN_SPEED[String(forms[0].form).split("/")[0]];
        if (runSpeed !== undefined && !maxSpeedChosen) maxSpeedInput.value = runSpeed;
        const vec = a => ({ x: a[0], y: a[1], z: a[2] });
        const clips = [];
        const seen = new Set();
        const total = files.reduce((n, f) => n + f.data.clips.length, 0);
        let done = 0;
        for (let fi = 0; fi < files.length; fi++) {
            const { data } = files[fi];
            for (const c of data.clips) {
                if (!await progress(`Importing clips ${Math.floor(done++ / total * 100)}%`)) return;
                const f = c.form !== undefined ? formOf.get(c.form) : fileForms[fi][0];
                if (!f) continue;
                const pusher = f.model.polys.get(c.pusher), crossed = f.model.polys.get(c.crossed);
                if (!pusher || !crossed) continue;
                // (the same point in two files: a static scan and a dynapoly one)
                const key = `${f.form}|${c.pusher}|${c.crossed}|${c.cross}|${c.drop}|${c.from}|${c.prev}|${c.action ?? ""}|${c.facing ?? ""}`;
                if (seen.has(key)) continue;
                seen.add(key);
                const end = vec(c.end);
                if (c.endNoFloor) end.noFloor = true;
                const clip = {
                    kind: c.kind, cross: c.cross, drop: c.drop, pusher, crossed,
                    from: vec(c.from), prev: vec(c.prev), res: vec(c.res), end,
                    form: f.form, model: f.model,
                };
                if (c.next) clip.next = vec(c.next);
                if (c.hold) clip.hold = true;
                if (c.inBounds) clip.inBounds = true;
                if (c.walkDistance) clip.walkDistance = c.walkDistance;
                if (c.aerial) clip.aerial = true;
                if (c.floorY !== undefined) clip.floorY = c.floorY;
                if (c.yaws) clip.yaws = c.yaws;
                if (c.speed !== undefined) { clip.yaw = c.yaw; clip.speed = c.speed; }
                if (c.speed2 !== undefined) clip.speed2 = c.speed2;
                if (c.vy !== undefined) clip.vy = c.vy;
                // clipfinder --type actions: the lunge that does it
                if (c.action) Object.assign(clip, { action: c.action, actionKey: c.actionKey, facing: c.facing, actionFrames: c.actionFrames, airFrames: c.airFrames, stopAfter: c.stopAfter, frames: c.frames.map(vec) });
                // clipfinder --min-speed: the reachability already worked out
                if ("reach" in c) clip.reach = c.reach ? { speed: c.reach.speed, yaw: c.reach.yaw, start: vec(c.reach.start) } : null;
                clips.push(clip);
            }
        }
        // One category per wall pair: files from before that could give a
        // pair's points different ones (and "low" for all falling points), so a
        // pair with any acute point is acute; their falling points too, and
        // falling points of other pairs stay "low" (category not known)
        const acutePairs = new Set(clips.filter(c => c.kind === "acute" && !c.action).map(c => `${c.form}:${c.pusher.id}:${c.crossed.id}`));
        for (const c of clips) {
            // (slope clips have their own row: clipfinder slope.h)
            // (and ground clips: clipfinder ground.h)
            // (action clips, of any kind: their own row, clipfinder action.h)
            // (one row per 1h / 2h weapon: the key's "1h-" / "2h-"; the jumpslash its own)
            if (c.action) {
                const k = c.actionKey ?? "";
                const pre = k.includes("jumpslash") ? "jump" : "action";
                c.cat = isSpinKey(k) ? (k.endsWith("backwalk") ? "action-backspin" : "action-spin")
                    // (MM Zora: the punch, the jumpslash, the Zora clip - B held - each its own row)
                    : k.startsWith("zora-clip") ? "action-zoraclip"
                    : k.includes("spin-lock") ? "action-spinlock"
                    : /^(1h|2h)-spin-fwd/.test(k) ? "action-spinfwd"
                    : /-ls(-walkin)?$/.test(k) ? "jump-ls"
                    : k.startsWith("zora-") ? `${pre}-zora`
                    : `${pre}-${k.startsWith("stick") ? "stick" : k.startsWith("2h") ? "2h" : "1h"}`;
                continue;
            }
            if (c.kind === "slope" || c.kind === "ground") { c.cat = c.kind; continue; }
            const acute = acutePairs.has(`${c.form}:${c.pusher.id}:${c.crossed.id}`);
            if (c.kind === "low") { if (acute) c.kind = "acute"; }
            else c.kind = acute ? "acute" : "extended";
            c.cat = c.kind === "low" ? "low" : (c.drop > 0 ? "low-" : "") + c.kind;
        }
        const groups = groupClips(clips);
        const falling = files.some(f => f.data.falling), extendedOnly = files.every(f => f.data.extendedOnly);
        last = {
            groups, forms, formLabel: forms.map(f => f.form).join("_"),
            falling, extendedOnly, numPolygons: files[0].data.numPolygons,
            note: `${how} ${forms.map(f => f.form).join(", ")}${falling ? ", falling" : ""}${extendedOnly ? ", extended plane only" : ""}` +
                (dyna ? `, with ${dyna.actors.length} dynapoly actors` : "") +
                (files.length > 1 ? `, from ${files.length} files` : ""),
            dyna,
        };
        if (clips.every(c => c.reach !== undefined)) last.reachDone = true;
        if (!await progress(`Importing clips: drawing ${clips.length} points…`, true)) return;
        await render();
        logGroups(groups);
    };

    // The setups a results file is for: its dynapolys' (null: a static scan,
    // any setup). A dynapoly scan without them (exported before setups were
    // recorded) matches none.
    const resultSetups = data => data.dyna ? (data.setups ?? data.dyna.setups ?? []) : null;

    const importInput = document.getElementById("wallClipImportFile");
    document.getElementById("wallClipImport").addEventListener("click", () => importInput.click());
    importInput.addEventListener("change", async () => {
        const file = importInput.files[0];
        importInput.value = "";
        if (!file) return;
        const main = loadedModels.find(m => m.name === "Main Model");
        const colCtx = currentColCtx;
        if (!main || !main.mesh || !main.mesh.userData.triangles || !colCtx) {
            status.textContent = "Load the map first";
            return;
        }
        let data;
        try {
            data = JSON.parse(await file.text());
        } catch (err) {
            status.textContent = `${file.name}: not JSON (${err.message})`;
            return;
        }
        if (data.format === "dynapoly-1" || data.format === "dynapoly-set-1") {
            status.textContent = `${file.name} is a dynapoly export: scan with it first ` +
                `(clipfinder.exe --game ${data.game} ${data.map ? `--map "${data.map}"` : "--all"} --dyna ${file.name} --out-dir tools/clipfinder/results), then import the results`;
            return;
        }
        if (data.format !== "wall-push-clips-1" && data.format !== "wall-push-clips-2") {
            status.textContent = `${file.name}: not a clipfinder results file`;
            return;
        }
        if (data.game !== game || data.numPolygons !== colCtx.colHeader.numPolygons) {
            status.textContent = `${file.name} is for ${data.game} ${data.map}; load that map first`;
            return;
        }
        autoToken++; // (an auto-import still going would replace it)
        const map = loaded?.map ?? document.getElementById("mapDropdown").value;
        if (data.map !== map) console.warn(`wall push clips: ${file.name} says map "${data.map}", "${map}" is loaded (same polygon count)`);
        const setups = resultSetups(data);
        if (setups && loaded && !setups.includes(loaded.setup))
            console.warn(`wall push clips: ${file.name} was scanned with the dynapolys of setup ${setups.join(", ") || "?"}, setup ${loaded.setup} is loaded`);
        importResults([{ name: file.name, data }], "imported");
    });

    // Auto-import: when a map has loaded (main.js's "zeldamaploaded" event),
    // every results file clipfinder --out-dir named for it (<GAME>_<map>_...)
    // in the folder that is for this map and either static (any setup) or
    // scanned with the loaded setup's dynapolys, merged.
    const autoChk = document.getElementById("wallClipAutoImport");
    const autoDir = document.getElementById("wallClipAutoDir");
    try {
        const saved = JSON.parse(localStorage.getItem("wallClipAutoImport") ?? "null");
        if (saved) { autoChk.checked = !!saved.on; if (saved.dir) autoDir.value = saved.dir; }
    } catch { /* storage unavailable: the defaults */ }
    const saveAuto = () => {
        try { localStorage.setItem("wallClipAutoImport", JSON.stringify({ on: autoChk.checked, dir: autoDir.value })); } catch { /* ignore */ }
    };
    autoChk.addEventListener("change", () => { saveAuto(); if (autoChk.checked && loaded && !last) autoImport(); });
    autoDir.addEventListener("change", () => { saveAuto(); if (autoChk.checked && loaded) autoImport(); });

    let loaded = null; // { game, map, setup } of the map on screen
    let autoToken = 0;
    const autoImport = async () => {
        const token = ++autoToken;
        const { map, setup } = loaded;
        const colCtx = currentColCtx;
        const main = loadedModels.find(m => m.name === "Main Model");
        if (!colCtx || !main?.mesh?.userData.triangles) return;
        const dir = autoDir.value.trim() || "tools/clipfinder/results";
        // (how long each part takes, in the console: a slow server shows up
        // in the listing and the reads)
        const t0 = performance.now();
        status.textContent = `Auto-import: looking for ${map} results in ${dir}…`;
        let list = null;
        try {
            list = await listResultFiles(dir, safeName(`${game}_${map}`) + "_");
        } catch { /* reported below */ }
        const tList = performance.now();
        // (another setup's dynapoly scan, by its name: clipfinder writes the
        // setups it's for as _setup<N>[-<N>...]_dyna - not read at all)
        const skippedByName = [];
        if (list) list = list.filter(({ name }) => {
            const m = name.match(/_setup([\d-]+)_dyna/);
            if (!m || m[1].split("-").map(Number).includes(setup)) return true;
            skippedByName.push(name);
            return false;
        });
        if (token !== autoToken) return;
        if (!list) {
            status.textContent = `Auto-import: can't list ${dir} (the server has to show folder pages, like python -m http.server)`;
            return;
        }
        status.textContent = list.length ? `Auto-import: reading ${list.length} files…` : "";
        const files = [];
        const otherSetups = [...skippedByName];
        // (all at once: one at a time, each waited on the server in turn)
        let bytes = 0;
        const read = await Promise.all(list.map(async ({ name, url }) => {
            try {
                const text = await (await fetch(url, { cache: "no-store" })).text();
                bytes += text.length;
                return { name, data: JSON.parse(text) };
            } catch (err) {
                console.warn(`Auto-import: ${name}: ${err.message}`);
                return null;
            }
        }));
        if (token !== autoToken) return;
        const tRead = performance.now();
        for (const r of read) {
            if (!r) continue;
            const { name, data } = r;
            if (data.format !== "wall-push-clips-1" && data.format !== "wall-push-clips-2") continue;
            if (data.game !== game || data.map !== map || data.numPolygons !== colCtx.colHeader.numPolygons) continue;
            const setups = resultSetups(data);
            if (setups && !setups.includes(setup)) { otherSetups.push(name); continue; }
            files.push({ name, data });
        }
        if (otherSetups.length) console.log(`Auto-import: other setups' dynapoly scans left out: ${otherSetups.join(", ")}`);
        // OoT: only the forms that play in this setup (clipfinder's formSetups):
        // child (and crawling) setups 0 / 1, adult 2 / 3, a setup the scene
        // doesn't have as the game resolves it (Scene_CommandAlternateHeaderList:
        // adult night falls back to adult day, anything else to 0). Cutscene
        // setups (4+): every form.
        let formNote = "";
        if (game === "OOT" && setup < 4) {
            const present = new Set([...document.getElementById("setupDropdown").options].map(o => Number(o.value)));
            const resolve = l => l === 0 || present.has(l) ? l : l === 3 && present.has(2) ? 2 : 0;
            const plays = { child: [0, 1], crawlspace: [0, 1], crawl: [0, 1], adult: [2, 3] };
            const playsHere = label => String(label).split("/").some(f => {
                const ls = plays[f.toLowerCase()];
                return !ls || ls.map(resolve).includes(setup);
            });
            const left = new Set();
            for (let i = files.length - 1; i >= 0; i--) {
                const d = files[i].data;
                if (!d.forms) continue; // (format 1: one form, unnamed)
                const forms = d.forms.filter(f => playsHere(f.form));
                d.forms.filter(f => !playsHere(f.form)).forEach(f => left.add(f.form));
                if (!forms.length) { files.splice(i, 1); continue; }
                files[i] = { ...files[i], data: { ...d, forms, clips: d.clips.filter(c => c.form === undefined || playsHere(c.form)) } };
            }
            if (left.size) formNote = `; ${[...left].join(", ")} not in it`;
        }
        if (!files.length) {
            status.textContent = `Auto-import: no results for ${map}${otherSetups.length || formNote ? ` setup ${setup}` : ""} in ${dir}${formNote ? ` (${formNote.slice(2)})` : ""}`;
            return;
        }
        console.log(`Auto-import (${map}, setup ${setup}): ${files.map(f => f.name).join(", ")}`);
        const tImport = performance.now();
        await importResults(files, `auto-imported (setup ${setup}${formNote})`);
        const ms = (a, b) => `${Math.round(b - a)} ms`;
        console.log(`Auto-import timing: listing ${dir} ${ms(t0, tList)}, reading ${list.length} files (${(bytes / 1e6).toFixed(2)} MB) ${ms(tList, tRead)}, ` +
            `building and drawing ${ms(tImport, performance.now())}`);
    };
    document.addEventListener("zeldamaploaded", e => {
        loaded = e.detail;
        if (loaded.game === game && autoChk.checked) autoImport();
    });
}
