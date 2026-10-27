"""MM Deku ledge-grab popup scan: ledges where the grab leaves Deku Link
grounded on the next frame thanks to a seam / the floor check's tolerance,
or snaps him up onto a higher surface.

The grab (z_player.c Player_Action_25, falling, at a wall with a ledge):
  - Player_ProcessSceneCollision: the interact wall is the first wall hit by a
    line from (pos.y + 17.8) forward wallCheckRadius + 10 (Deku 14 + 10 = 24).
    distToInteractWall d = plane distance. The ledge is the floor raycast at
    pos - (d + 10) * n from pos.y + unk_0C (Deku 71): yDistToLedge = ledgeY - pos.y.
    Rejected if < 17.8, if a ceiling is within yDist + 20 above pos, if a wall
    facing the same way (< 0x4000, without WALL_FLAG_1) is hit at ledgeY + 5,
    or the wall has WALL_FLAG_0. Climb type >= 2 needs yDist >= unk_1C (Deku 27)
    and the ledge floor's |normal.y| > 0x5DC0.
  - Action_25 grabs if yDist < 150 * unk_08 (Deku 45) and
    (pos.y - floorHeight) + yDist > 70 * unk_08 (21): pos.y = ledgeY,
    xz = pos - (d + 1) * n (func_80837CEC), velocity.y = 0, not grounded.
  - Next frame: gravity -1, moved x1.5 (MM N64 sActorMovementScale) -> y1 = ledgeY - 1.5, then func_800B7678 raycasts the
    floor at the hang xz from ledgeY + 50: grounded iff floorY >= y1. Otherwise
    func_8083827C drops him into the fall (the "popup").

The floor raycast (BgCheck_EntityRaycastFloor5_2, flags 0x1C) checks the floor
list and the wall list (walls with normal.y < 0 skipped, |ny| < 0.008 skipped),
point-in-triangle with 1.0 tolerance: near a vertex for every poly, along the
edges only for |ny| > 0.5 (Math3D_TriChkPointParaYImplNoCheckRange). Wall seams
come from the vertex circles of slightly tilted walls.

Grab positions where Link's wall sphere (radius 14 at pos.y + 26.8) would
overlap another wall are dropped (the wall push wouldn't let him be there); a
wall the sphere overlaps at the hang point next frame is printed as a warning.

Scene collision only (no BgActors / dyna polys); perpendicular approach only;
the next frame's ceiling check isn't simulated.

usage: scan_ledge_popup.py [--scene Z2_MILK_BAR] [--all] [--step 2] [--mm path/to/mm]
  default: every scene with the B button disabled (scene_table.h restrictions)
"""
import argparse, math, os, re, sys

HERE = os.path.dirname(os.path.abspath(__file__))

# Deku (sPlayerAgeProperties[PLAYER_FORM_DEKU])
WALL_R = 14.0
UNK_0C = 71.0
UNK_1C = 27.0
GRAB_MAX = 150 * 0.3
GRAB_MIN_TOTAL = 70 * 0.3
GRAVITY = -1.0 * 1.5  # one frame of gravity, moved x1.5
SPHERE = [WALL_R]

NORM = 1.0 / 32767


def restriction_b_disabled(mm):
    t = open(os.path.join(mm, 'include', 'tables', 'scene_table.h')).read()
    src = open(os.path.join(mm, 'src', 'code', 'z_parameter.c')).read()
    macros = {}
    for name, args in re.findall(r'#define (RESTRICTIONS_\w+) RESTRICTIONS_SET\(([^)]*)\)', src):
        macros[name] = [int(a) for a in args.split(',')]
    out = []
    for m in re.finditer(r'DEFINE_SCENE\((\w+), (\w+), [^,]+, \w+, (RESTRICTIONS_SET\([^)]*\)|\w+),', t):
        r = m.group(3)
        args = [int(a) for a in r[len('RESTRICTIONS_SET('):-1].split(',')] if r.startswith('RESTRICTIONS_SET') else macros[r]
        if args[1]:
            out.append(m.group(1))
    return out


class Col:
    def __init__(self, path):
        t = open(path).read()
        hdr = re.search(r'SCENE_CMD_COL_HEADER\(&(\w+)\)', t).group(1)

        def block(suffix):
            m = re.search(r'\b' + hdr + suffix + r'\[\] = \{(.*?)\n\};', t, re.S)
            return m.group(1) if m else ''
        self.v = [tuple(int(x) for x in m) for m in
                  re.findall(r'\{\s*(-?\d+),\s*(-?\d+),\s*(-?\d+)\s*\}', block('Vertices'))]
        st = [[int(x, 0) for x in m.split(',')] for m in re.findall(r'\{([^{}]*)\}', block('SurfaceType'))]
        self.polys = []
        for m in re.findall(r'\{([^{}]*)\}', block('Polygons')):
            a = [int(x, 0) for x in m.split(',')]
            a = [x - 0x10000 if i >= 4 and x >= 0x8000 else x for i, x in enumerate(a)]
            typ, va, vb, vc, nx, ny, nz, dist = a
            p = dict(id=len(self.polys), type=typ, fa=va >> 13, fb=vb >> 13,
                     vs=[self.v[va & 0x1FFF], self.v[vb & 0x1FFF], self.v[vc]],
                     ni=(nx, ny, nz), n=(nx * NORM, ny * NORM, nz * NORM), d=float(dist))
            p['wallType'] = (st[typ][0] >> 21) & 0x1F if typ < len(st) else 0
            p['ignore'] = bool(p['fa'] & 2)  # COLPOLY_IGNORE_ENTITY
            if ny > 0.5 * 32767:
                p['list'] = 'floor'
            elif ny < -0.8 * 32767:
                p['list'] = 'ceil'
            else:
                p['list'] = 'wall'
            xs = [q[0] for q in p['vs']]; ys = [q[1] for q in p['vs']]; zs = [q[2] for q in p['vs']]
            p['box'] = (min(xs), max(xs), min(ys), max(ys), min(zs), max(zs))
            self.polys.append(p)
        self.cell = 40.0
        self.grid = {}
        for p in self.polys:
            if p['ignore']:
                continue
            b = p['box']
            for gx in range(int(math.floor((b[0] - 2) / self.cell)), int(math.floor((b[1] + 2) / self.cell)) + 1):
                for gz in range(int(math.floor((b[4] - 2) / self.cell)), int(math.floor((b[5] + 2) / self.cell)) + 1):
                    self.grid.setdefault((gx, gz), []).append(p)

    def near(self, x0, z0, x1=None, z1=None):
        if x1 is None:
            x1, z1 = x0, z0
        seen = {}
        for gx in range(int(math.floor(min(x0, x1) / self.cell)), int(math.floor(max(x0, x1) / self.cell)) + 1):
            for gz in range(int(math.floor(min(z0, z1) / self.cell)), int(math.floor(max(z0, z1) / self.cell)) + 1):
                for p in self.grid.get((gx, gz), ()):
                    seen[p['id']] = p
        return seen.values()


def dist_sq_to_line_zx(z, x, a, b):
    """Math3D_PointDistSqToLineZX: true if the projection is on the segment."""
    dz, dx = b[2] - a[2], b[0] - a[0]
    l = dz * dz + dx * dx
    if l == 0:
        return False, 0
    t = ((z - a[2]) * dz + (x - a[0]) * dx) / l
    if t < 0 or t > 1:
        return False, 0
    pz, px = a[2] + t * dz - z, a[0] + t * dx - x
    return True, pz * pz + px * px


def in_tri_zx(p, x, z, chk):
    v0, v1, v2 = p['vs']
    c2 = chk * chk
    for v in (v0, v1, v2):
        if (v[2] - z) ** 2 + (v[0] - x) ** 2 < c2:
            return True
    d01 = (v0[2] - z) * (v1[0] - x) - (v0[0] - x) * (v1[2] - z)
    d12 = (v1[2] - z) * (v2[0] - x) - (v1[0] - x) * (v2[2] - z)
    d20 = (v2[2] - z) * (v0[0] - x) - (v2[0] - x) * (v0[2] - z)
    if (d01 <= 0 and d12 <= 0 and d20 <= 0) or (d01 >= 0 and d12 >= 0 and d20 >= 0):
        return True
    if abs(p['n'][1]) > 0.5 and c2 > 0:
        for a, b in ((v0, v1), (v1, v2), (v2, v0)):
            ok, ds = dist_sq_to_line_zx(z, x, a, b)
            if ok and ds < c2:
                return True
    return False


def raycast_floor(col, x, y0, z, chk=1.0, lists=('floor', 'wall')):
    best, bestp = -32000.0, None
    for p in col.near(x - 1, z - 1, x + 1, z + 1):
        if p['list'] not in lists:
            continue
        if p['list'] == 'wall' and p['ni'][1] < 0:
            continue
        b = p['box']
        if y0 < b[2]:
            continue
        if x < b[0] - chk or x > b[1] + chk or z < b[4] - chk or z > b[5] + chk:
            continue
        nx, ny, nz = p['n']
        if abs(ny) < 0.008:
            continue
        if not in_tri_zx(p, x, z, chk):
            continue
        yi = (-nx * x - nz * z - p['d']) / ny
        if yi < y0 and yi > best:
            best, bestp = yi, p
    return best, bestp


def check_ceiling(col, x, y, z, h):
    for p in col.near(x, z):
        if p['list'] != 'ceil':
            continue
        b = p['box']
        if b[3] < y or b[2] > y + h:
            continue
        nx, ny, nz = p['n']
        if not in_tri_zx(p, x, z, 1.0):
            continue
        yi = (-nx * x - nz * z - p['d']) / ny
        if y <= yi <= y + h:
            return True
    return False


def line_wall(col, a, b):
    """BgCheck_EntityLineTest2(checkWall, checkOneFace): nearest wall-list hit."""
    best, bestp = 2.0, None
    dx, dy, dz = b[0] - a[0], b[1] - a[1], b[2] - a[2]
    for p in col.near(a[0], a[2], b[0], b[2]):
        if p['list'] != 'wall':
            continue
        nx, ny, nz = p['n']
        den = nx * dx + ny * dy + nz * dz
        if den >= 0:
            continue
        t = -(nx * a[0] + ny * a[1] + nz * a[2] + p['d']) / den
        if t < 0 or t > 1 or t >= best:
            continue
        q = (a[0] + t * dx, a[1] + t * dy, a[2] + t * dz)
        v0, v1, v2 = p['vs']
        # point in triangle (3D, via same-side tests)
        ok = True
        sgn = 0
        for u, w in ((v0, v1), (v1, v2), (v2, v0)):
            e = (w[0] - u[0], w[1] - u[1], w[2] - u[2])
            r = (q[0] - u[0], q[1] - u[1], q[2] - u[2])
            c = (e[1] * r[2] - e[2] * r[1], e[2] * r[0] - e[0] * r[2], e[0] * r[1] - e[1] * r[0])
            s = c[0] * nx + c[1] * ny + c[2] * nz
            if abs(s) < 1e-6:
                continue
            if sgn == 0:
                sgn = 1 if s > 0 else -1
            elif (s > 0) != (sgn > 0):
                ok = False
                break
        if ok:
            best, bestp = t, p
    return bestp


def closest_on_tri(p, a, b, c):
    """Closest point on triangle abc to p (Ericson)."""
    def sub(u, v): return (u[0] - v[0], u[1] - v[1], u[2] - v[2])
    def dot(u, v): return u[0] * v[0] + u[1] * v[1] + u[2] * v[2]
    def add(u, v, s): return (u[0] + v[0] * s, u[1] + v[1] * s, u[2] + v[2] * s)
    ab, ac, ap = sub(b, a), sub(c, a), sub(p, a)
    d1, d2 = dot(ab, ap), dot(ac, ap)
    if d1 <= 0 and d2 <= 0:
        return a
    bp = sub(p, b)
    d3, d4 = dot(ab, bp), dot(ac, bp)
    if d3 >= 0 and d4 <= d3:
        return b
    vc = d1 * d4 - d3 * d2
    if vc <= 0 and d1 >= 0 and d3 <= 0:
        return add(a, ab, d1 / (d1 - d3))
    cp = sub(p, c)
    d5, d6 = dot(ab, cp), dot(ac, cp)
    if d6 >= 0 and d5 <= d6:
        return c
    vb = d5 * d2 - d1 * d6
    if vb <= 0 and d2 >= 0 and d6 <= 0:
        return add(a, ac, d2 / (d2 - d6))
    va = d3 * d6 - d5 * d4
    if va <= 0 and (d4 - d3) >= 0 and (d5 - d6) >= 0:
        return add(b, sub(c, b), (d4 - d3) / ((d4 - d3) + (d5 - d6)))
    den = 1 / (va + vb + vc)
    return add(add(a, ab, vb * den), ac, vc * den)


def sphere_blocked(col, x, y, z, skip=None, r=WALL_R - 0.5):
    """Some wall (other than `skip`) closer than the wall sphere's radius to its
    center: the game's wall push (Actor_UpdateBgCheckInfo, sphere at
    pos.y + 26.8) wouldn't let Link sit here."""
    c = (x, y + 26.8, z)
    for p in col.near(x - WALL_R, z - WALL_R, x + WALL_R, z + WALL_R):
        if p['list'] != 'wall' or p is skip:
            continue
        nx, ny, nz = p['n']
        if nx * c[0] + ny * c[1] + nz * c[2] + p['d'] < 0:  # behind the wall
            continue
        q = closest_on_tri(c, *p['vs'])
        if (q[0] - c[0]) ** 2 + (q[1] - c[1]) ** 2 + (q[2] - c[2]) ** 2 < r * r:
            return p['id']
    return None


def yaw(nx, nz):
    return math.atan2(nx, nz)


WALL_FLAG_0 = {1, 2, 3}  # wall types with WALL_FLAG_0
WALL_FLAG_1 = {2}


def scan_wall(col, w, step):
    nx, ny, nz = w['n']
    hl = math.hypot(nx, nz)
    if hl < 1e-6:
        return []
    nh = (nx / hl, nz / hl)
    td = (-nh[1], nh[0])
    tv = [(v[0] * td[0] + v[2] * td[1], v[1]) for v in w['vs']]
    t0, t1 = min(a for a, _ in tv), max(a for a, _ in tv)
    y0, y1 = min(b for _, b in tv), max(b for _, b in tv)
    out = []
    t = t0 + step / 2
    while t < t1:
        y = y0 + step / 2
        while y < y1:
            # inside the wall triangle in (t, y)?
            inside = True
            sgn = 0
            for i in range(3):
                a, b = tv[i], tv[(i + 1) % 3]
                c = (b[0] - a[0]) * (y - a[1]) - (b[1] - a[1]) * (t - a[0])
                if c == 0:
                    continue
                if sgn == 0:
                    sgn = 1 if c > 0 else -1
                elif (c > 0) != (sgn > 0):
                    inside = False
                    break
            if inside:
                r = sample(col, w, t, y, nh, td, hl)
                if r:
                    out.append(r)
            y += step
        t += step
    return out


def sample(col, w, t, sy, nh, td, hl):
    nx, ny, nz = w['n']
    s = -(ny * sy + w['d']) / hl
    S = (t * td[0] + s * nh[0], sy, t * td[1] + s * nh[1])
    P = (S[0] + nh[0] * WALL_R, sy - 17.8, S[2] + nh[1] * WALL_R)
    a = (P[0], P[1] + 17.8, P[2])
    b = (a[0] - nh[0] * (WALL_R + 10), a[1], a[2] - nh[1] * (WALL_R + 10))
    hit = line_wall(col, a, b)
    if hit is not w:
        return None
    if w['wallType'] in WALL_FLAG_0:
        return None
    d = abs(nx * P[0] + ny * P[1] + nz * P[2] + w['d'])
    qx, qz = P[0] - (d + 10) * nx, P[2] - (d + 10) * nz
    ledgeY, lp = raycast_floor(col, qx, P[1] + UNK_0C, qz)
    if lp is None:
        return None
    ydist = ledgeY - P[1]
    if ydist < 17.8 or ydist < UNK_1C or ydist >= GRAB_MAX:
        return None
    if abs(lp['ni'][1]) <= 0x5DC0:
        return None
    if check_ceiling(col, P[0], P[1], P[2], ydist + 20):
        return None
    a2 = (P[0], ledgeY + 5, P[2])
    b2 = (a2[0] - nh[0] * (WALL_R + 10), a2[1], a2[2] - nh[1] * (WALL_R + 10))
    p2 = line_wall(col, a2, b2)
    if p2 is not None:
        dy = (yaw(w['n'][0], w['n'][2]) - yaw(p2['n'][0], p2['n'][2]) + math.pi) % (2 * math.pi) - math.pi
        if abs(dy) < math.pi / 2 and p2['wallType'] not in WALL_FLAG_1:
            return None
    floorBelow, _ = raycast_floor(col, P[0], P[1] + 50, P[2])
    if P[1] <= floorBelow or (P[1] - floorBelow) + ydist <= GRAB_MIN_TOTAL:
        return None
    if sphere_blocked(col, P[0], P[1], P[2], skip=w, r=SPHERE[0]) is not None:
        return None
    hx, hz = P[0] - (d + 1) * nx, P[2] - (d + 1) * nz
    y1 = ledgeY + GRAVITY
    fy, fp = raycast_floor(col, hx, ledgeY + 50, hz)
    real, rp = raycast_floor(col, hx, ledgeY + 50, hz, chk=0.0, lists=('floor',))
    return dict(P=P, H=(hx, ledgeY, hz), ledgeY=ledgeY, ledge=lp['id'], ydist=ydist,
                floorY=fy, floor=fp['id'] if fp else None, floorList=fp['list'] if fp else None,
                real=real, grounded=fy >= y1, pushed=sphere_blocked(col, hx, y1, hz))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--mm', default=os.path.join(HERE, '..', '..', '..', 'mm'))
    ap.add_argument('--scene', action='append')
    ap.add_argument('--step', type=float, default=2.0)
    ap.add_argument('--all', action='store_true', help='print every grab, not just interesting ones')
    ap.add_argument('--wall', type=int, action='append', help='only scan these wall poly ids')
    ap.add_argument('--sphere', type=float, default=WALL_R, help='wall sphere radius for the position check (13.5: looser)')
    args = ap.parse_args()
    SPHERE[0] = args.sphere
    scenes = args.scene or restriction_b_disabled(args.mm)
    sdir = os.path.join(args.mm, 'extracted', 'n64-us', 'assets', 'scenes')
    total = 0
    for sc in scenes:
        path = os.path.join(sdir, sc, sc + '.c')
        if not os.path.exists(path):
            print(f'{sc}: no scene file', file=sys.stderr)
            continue
        col = Col(path)
        groups = {}
        ngrab = 0
        for w in col.polys:
            if w['list'] != 'wall' or w['ignore'] or abs(w['ni'][1]) >= 600 or (args.wall and w['id'] not in args.wall):
                continue
            for r in scan_wall(col, w, args.step):
                ngrab += 1
                interesting = r['grounded'] and (r['real'] < r['ledgeY'] + GRAVITY - 1e-3 or r['floorY'] > r['ledgeY'] + 1)
                if not (interesting or args.all):
                    continue
                key = (w['id'], r['ledge'], r['floor'], r['grounded'])
                g = groups.setdefault(key, [])
                g.append(r)
        print(f'== {sc}: {ngrab} grab samples, {len(groups)} groups')
        for (wid, lid, fid, gr), rs in sorted(groups.items()):
            r = max(rs, key=lambda q: q['ledgeY'] - q['real'])
            pop = r['ledgeY'] - r['real']
            print(f'  wall {wid} ledge {lid} -> floor {fid} ({r["floorList"]}) grounded={gr} samples={len(rs)}'
                  f'  popup {pop:.2f} (grab y {r["ledgeY"]:.2f}, floor {r["floorY"]:.2f}, true floor {r["real"]:.2f})'
                  f'  link at ({r["P"][0]:.1f}, {r["P"][1]:.1f}, {r["P"][2]:.1f}) hang ({r["H"][0]:.1f}, {r["H"][2]:.1f})'
                  + (f'  [next-frame wall push from {r["pushed"]}]' if r['pushed'] is not None else ''))
            total += 1
    print(f'{total} groups')


if __name__ == '__main__':
    main()
