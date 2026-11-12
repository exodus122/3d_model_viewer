"""Phive VolumeStats (.bpvsts) reader: the game's precomputed voxel volumes.

Layout (little endian), worked out from the files and the game's own ray query
(update 131072 main+0x5421c0 / +0x543240):

  0x00 "Phive\\0", u16 version 1, ...
  0x14 i32 origin[3]          tile corner in metres (the tile is cells[k] * 250)
  0x20 u32 cells[3]           top cells along x, y, z (2, 4, 2: 500 x 1000 x 500 m)
  0x2c u8  ...[4], ...
  0x40 cells[x * y * z], each:
       u32 nodeBytes          size of the node section that follows
       8 levels: u32 count, u32 node[count]
                 node = child mask (8 bits, octant = xbit | ybit << 1 | zbit << 2)
                        | first child index (in the next level) << 8
                 a child's index: first + popcount(mask & ((1 << octant) - 1))
       8 levels: u32 size, u8 data[size]   (per-level attribute bit streams, unaligned)
  then "Phive\\0".

A cell is a 256 m octree: level L nodes are 2^(8-L) m cubes, level 7's masks
are the 1 m voxels the game's queries (the void probe among them) hit.
"""
import struct

import numpy as np

LEVELS = 8
CELL_SIZE = 250
OCTREE_OFFSET = -3   # a cell's 256 m octree starts 3 m before its 250 m cell (the game's query bounds: +3..+253)


# Attribute record layouts per structure preset (PhiveConfig's
# VolumeStatsStructureCollection order), from the game's own table (update
# 131072 main+0x3f09e80, 0x74 bytes each: u32 total bits, 22 enable bytes,
# 22 u32 bit offsets in VolumeStatsAttributeCollection order). The header
# gives each level's preset (u8 at 0x37 + level) and record width (u8 at
# 0x2f + level); a level's records are indexed by child (the 1 m voxels for
# level 7), bits LSB first.
#   name -> (bit offset, width) per preset
PRESETS = {
    0: ("Empty", 0, {}),
    1: ("OnlyIntersect", 18, {"Intersect": (0, 6), "IntersectForAir": (6, 6), "IntersectWater": (12, 6)}),
    2: ("Default1m", 219, {"Intersect": (0, 6), "InWater": (6, 1), "WaterMat": (7, 8), "GlobalWindFlow": (15, 96),
                           "IntersectForAir": (111, 6), "SixDirMaterials": (117, 96), "IntersectWater": (213, 6)}),
    3: ("Dungeon1m", 227, {"Intersect": (0, 6), "InWater": (6, 1), "IsWaterSurface": (7, 1), "DungeonRoomId": (8, 8),
                           "OnGroundRoomArea": (16, 1), "GlobalWindFlow": (17, 96), "IntersectForAir": (113, 6),
                           "SixDirMaterials": (119, 96), "buffer": (215, 6), "IntersectWater": (221, 6)}),
    4: ("Default4m", 155, {"Intersect": (0, 6), "WaterDepth": (6, 8), "WaterDist": (14, 8), "WaterArea": (22, 8),
                           "IsWaterSurface": (30, 1), "WaterMat": (31, 8), "WaterFlow": (39, 8),
                           "IntersectForAir": (47, 6), "SixDirMaterials": (53, 96), "IntersectWater": (149, 6)}),
    5: ("Field4m", 164, {"Intersect": (0, 6), "WaterDepth": (6, 8), "WaterDist": (14, 8), "WaterArea": (22, 8),
                         "IsWaterSurface": (30, 1), "WaterMat": (31, 8), "WaterFlow": (39, 8), "InHidingHole": (47, 1),
                         "HoleIndex": (48, 8), "IntersectForAir": (56, 6), "SixDirMaterials": (62, 96),
                         "IntersectWater": (158, 6)}),
    6: ("Field1m", 249, {"Intersect": (0, 6), "InWater": (6, 1), "IsWaterSurface": (7, 1), "InDoor": (8, 1),
                         "InHidingHole": (9, 1), "GlobalWindFlow": (10, 96), "GlobalWaterFlow": (106, 24),
                         "IntersectForAir": (130, 6), "SixDirMaterials": (136, 96), "buffer": (232, 6),
                         "IntersectWater": (238, 6), "OutsideOuterBoundary": (244, 1), "OuterBoundaryDist": (245, 4)}),
}


def level_records(tile, raw, cell, level, count):
    """The level's attribute records -> {attribute: uint array} (count records), or None."""
    preset = raw[0x37 + level]
    name, bits, fields = PRESETS.get(preset, (None, 0, {}))
    data = tile.cell_attrs[cell][level]
    if not bits or not count or len(data) * 8 < bits * count:
        return None
    a = np.unpackbits(np.frombuffer(data, np.uint8), bitorder="little")[:bits * count].reshape(count, bits)
    out = {}
    for f, (off, w) in fields.items():
        if w > 32:
            continue
        out[f] = (a[:, off:off + w].astype(np.uint64) << np.arange(w, dtype=np.uint64)).sum(1).astype(np.uint32)
    return out


def voxel_attributes(tile, raw):
    """Per 1 m voxel (same order as world_voxels): dict of uint arrays.
    probe: the 6 face bits the void probe tests (Intersect | IntersectWater):
           bit 2 * axis + (ray direction > 0) lets a ray entering along that axis hit
    flags: 1 in water, 2 water surface, 4 indoor, 8 in hiding hole, 16 outside outer boundary,
           32 on ground room area
    room:  dungeon room id (255: none), dist: outer boundary distance (0-15, 255: none)"""
    parts = {"probe": [], "flags": [], "room": [], "dist": []}
    for c in range(len(tile.cell_nodes)):
        n = len(tile.voxels(c))
        if not n:
            continue
        rec = level_records(tile, raw, c, LEVELS - 1, n) or {}
        z = np.zeros(n, np.uint32)
        g = lambda k: rec.get(k, z)
        parts["probe"].append((g("Intersect") | g("IntersectWater")).astype(np.uint8))
        flags = (g("InWater") * 1 | g("IsWaterSurface") * 2 | g("InDoor") * 4 | g("InHidingHole") * 8 |
                 g("OutsideOuterBoundary") * 16 | g("OnGroundRoomArea") * 32)
        parts["flags"].append(flags.astype(np.uint8))
        parts["room"].append(rec["DungeonRoomId"].astype(np.uint8) if "DungeonRoomId" in rec else np.full(n, 255, np.uint8))
        parts["dist"].append(rec["OuterBoundaryDist"].astype(np.uint8) if "OuterBoundaryDist" in rec else np.full(n, 255, np.uint8))
    return {k: np.concatenate(v) if v else np.zeros(0, np.uint8) for k, v in parts.items()}


def cell_corner(tile, cell):
    """World corner (x, y, z) of a cell's octree. Cells are ordered x * (y * z) + y * z + z."""
    ny, nz = tile.cells[1], tile.cells[2]
    xc, yc, zc = cell // (ny * nz), (cell // nz) % ny, cell % nz
    return np.array(tile.origin) + np.array([xc, yc, zc]) * CELL_SIZE + OCTREE_OFFSET


def world_voxels(tile):
    """All the tile's 1 m voxels as world-space integer corners (x, y, z)."""
    out = [tile.voxels(c) + cell_corner(tile, c) for c in range(len(tile.cell_nodes))]
    out = [v for v in out if len(v)]
    return np.concatenate(out).astype(np.int32) if out else np.zeros((0, 3), np.int32)


# ---- The void probe (see the shared oottools mod, voidmap.cpp) ----------------
# 64 rays on a golden spiral from the point; the nearest hit in 3D is the void
# point, and Link is voided once he is VOID_RADIUS or more sideways from it.
VOID_RADIUS = 8.0
GOLDEN_ANGLE = 3.8832221


def probe_dirs(n=64):
    i = np.arange(n)
    y = 1.0 - (2 * i + 1) / n
    r = np.sin(np.arccos(y))
    a = i * GOLDEN_ANGLE
    d = np.stack([np.cos(a) * r, y, np.sin(a) * r], 1)
    return d / np.linalg.norm(d, axis=1, keepdims=True)


class VoxelGrid:
    """Dense probe face bits over the voxels' bounding box, for ray casts.
    faces: per voxel, the 6 face bits a ray may hit (None: every face)."""

    def __init__(self, voxels, faces=None, pad=1):
        self.lo = voxels.min(0) - pad
        hi = voxels.max(0) + pad + 1
        self.occ = np.zeros(tuple(hi - self.lo), np.uint8)
        v = voxels - self.lo
        self.occ[v[:, 0], v[:, 1], v[:, 2]] = 0x3F if faces is None else faces

    def cast(self, origins, dirs, max_t=5000.0):
        """First voxel hit per ray (Amanatides-Woo). -> (hit points (n, 3), hit mask)."""
        o = origins.astype(np.float64) - self.lo
        d = dirs.astype(np.float64)
        n = len(o)
        shape = np.array(self.occ.shape)
        # clip each ray to the grid box first
        with np.errstate(divide="ignore", invalid="ignore"):
            inv = 1.0 / d
            t0 = np.where(d != 0, (0 - o) * inv, -np.inf)
            t1 = np.where(d != 0, (shape - o) * inv, np.inf)
        tmin = np.maximum.reduce(np.minimum(t0, t1), axis=1).clip(0)
        tmax = np.minimum(np.minimum.reduce(np.maximum(t0, t1), axis=1), max_t)
        active = tmin <= tmax
        p = o + d * (tmin[:, None] + 1e-6)
        cell = np.floor(p).astype(np.int64)
        step = np.sign(d).astype(np.int64)
        with np.errstate(divide="ignore", invalid="ignore"):
            nxt = np.where(step > 0, cell + 1, cell) - o
            tnext = np.where(d != 0, nxt * inv, np.inf)
            tdelta = np.where(d != 0, np.abs(inv), np.inf)
        t = tmin.copy()
        hit = np.zeros(n, bool)
        # the face a ray enters a cell through: bit 2 * axis + (dir > 0); the
        # starting cell has none (-1), so a ray can't hit the cube it starts in
        entry = np.full(n, -1, np.int64)
        for _ in range(int(shape.sum()) + 3):
            idx = np.nonzero(active)[0]
            if not len(idx):
                break
            c = cell[idx]
            inside = np.all((c >= 0) & (c < shape), axis=1)
            bits = np.zeros(len(idx), np.int64)
            bits[inside] = self.occ[c[inside, 0], c[inside, 1], c[inside, 2]]
            e = entry[idx]
            solid = (e >= 0) & ((bits >> e.clip(0)) & 1 == 1)
            hit[idx[solid]] = True
            done = solid | ~inside | (t[idx] > tmax[idx])
            # a ray starting outside the grid enters from its clip point
            active[idx[done & ~((e < 0) & ~inside & (t[idx] <= tmax[idx]))]] = False
            go = idx[~done]
            axis = np.argmin(tnext[go], axis=1)
            t[go] = tnext[go, axis]
            cell[go, axis] += step[go, axis]
            tnext[go, axis] += tdelta[go, axis]
            entry[go] = 2 * axis + (d[go, axis] > 0)
        points = origins + dirs * t[:, None]
        return points, hit


def void_probe(grid, points):
    """-> (sideways distance to the nearest hit (-1: none), 3D distance, hit point) per point."""
    dirs = probe_dirs()
    k = len(dirs)
    o = np.repeat(points, k, axis=0)
    d = np.tile(dirs, (len(points), 1))
    hp, hit = grid.cast(o, d)
    dist = np.where(hit, np.linalg.norm(hp - o, axis=1), np.inf).reshape(-1, k)
    best = np.argmin(dist, axis=1)
    rows = np.arange(len(points))
    any_hit = np.isfinite(dist[rows, best])
    bp = hp.reshape(-1, k, 3)[rows, best]
    side = np.where(any_hit, np.hypot(bp[:, 0] - points[:, 0], bp[:, 2] - points[:, 2]), -1.0)
    return side, np.where(any_hit, dist[rows, best], -1.0), bp


class VolumeTile:
    def __init__(self, b):
        if b[:5] != b"Phive":
            raise ValueError("not a Phive file")
        self.origin = struct.unpack_from("<3i", b, 0x14)
        self.cells = struct.unpack_from("<3I", b, 0x20)
        self.cell_nodes = []     # per cell: [level][nodes] as uint32 arrays
        self.cell_attrs = []     # per cell: [level] bytes
        p = 0x40
        for _ in range(self.cells[0] * self.cells[1] * self.cells[2]):
            node_bytes = struct.unpack_from("<I", b, p)[0]
            p += 4
            end = p + node_bytes
            levels = []
            for _ in range(LEVELS):
                n = struct.unpack_from("<I", b, p)[0]
                levels.append(np.frombuffer(b, "<u4", n, p + 4).copy())
                p += 4 + 4 * n
            if p != end:
                raise ValueError(f"node section size mismatch at {p:#x} (expected {end:#x})")
            attrs = []
            for _ in range(LEVELS):
                n = struct.unpack_from("<I", b, p)[0]
                attrs.append(b[p + 4:p + 4 + n])
                p += 4 + n
            self.cell_nodes.append(levels)
            self.cell_attrs.append(attrs)
        self.end = p

    def voxels(self, cell):
        """Integer (x, y, z) of the 1 m voxels in one cell, relative to the cell's octree corner."""
        levels = self.cell_nodes[cell]
        if not len(levels[0]):
            return np.zeros((0, 3), np.int32)
        # walk level by level: positions of every node
        pos = np.zeros((len(levels[0]), 3), np.int32)
        for lvl in range(LEVELS):
            nodes = levels[lvl]
            size = 1 << (LEVELS - 1 - lvl)          # child size at this level
            mask = (nodes & 0xFF).astype(np.int64)
            first = (nodes >> 8).astype(np.int64)
            child_pos, child_idx = [], []
            for octant in range(8):
                has = (mask >> octant) & 1 == 1
                if not has.any():
                    continue
                below = mask & ((1 << octant) - 1)
                rank = np.array([bin(int(m)).count("1") for m in below[has]], np.int64)
                off = np.array([octant & 1, (octant >> 1) & 1, (octant >> 2) & 1], np.int32) * size
                child_pos.append(pos[has] + off)
                child_idx.append(first[has] + rank)
            if not child_pos:
                return np.zeros((0, 3), np.int32)
            cp, ci = np.concatenate(child_pos), np.concatenate(child_idx)
            if lvl == LEVELS - 1:
                return cp[np.argsort(ci)]   # in record order: voxel i is attribute record i
            order = np.argsort(ci)
            if len(ci) != len(levels[lvl + 1]) or not np.array_equal(ci[order], np.arange(len(ci))):
                raise ValueError(f"level {lvl}: children don't map 1:1 onto level {lvl + 1}")
            pos = cp[order]
        return pos
