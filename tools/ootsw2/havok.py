"""Havok (Phive) collision readers for the OoT (Switch 2) romfs.

A Phive file (.bphsc static compound tile, .bphsh shape) is a "Phive" header
followed by one or more Havok tagfiles ("TAG0" sections). Format notes:

Tagfile: big-endian u32 (size | flags << 30) + 4-char tag per section. TAG0
holds SDKV, DATA (the objects, little endian), TYPE (TST1 type-name strings,
TNA1 type table as varints) and INDX (ITEM: 12-byte entries u32 type | flags,
u32 data offset, u32 count). Pointers / arrays in DATA are hkRelArray-style:
i32 offset relative to the field itself, u32 count.

Shapes used here (field offsets in DATA):
  hknpMeshShape:   +0x60 shape tag table (sorted (key, tag) u32 pairs, key =
                   section << 8 | primitive), +0x88 geometry sections (0x40
                   bytes: +8 primitives (4 x u8 vertex indices, a quad when the
                   last two differ), +16 u16 xyz vertices, +32 i32 xyz section
                   offset; position = (offset + vertex) / 512)
  hknpCompoundShape: instances in an hkFreeListArrayElement array, 64 bytes
                   each: quaternion xyzw, translation xyz, scale xyz,
                   +48 shape pointer
  hknpConvexPolytopeShape / Box / Convex: +0x38 packed f32x3 vertices (hkFloat3),
                   +0x48 faces (u16 first index, u8 count), +0x50 u8 face vertex indices
  hknpCapsuleShape: +0x38 two packed f32x3 end points, +0x68 radius

Static compound header (u32 offsets from the file start, w[i] = word i):
  [w4, w5)  0x20 per entry: i32 first instance, i32 last instance, u64
            placement hash id (Banc "Hash"), ...  -> which object each baked
            instance belongs to
  [w7, w8)  20 bytes per instance: u32 instance, u32 flags (>> 24: 1 convex,
            2 mesh), u16, u16, u32 first material entry, u32 entry count
  [w8, w9)  16 bytes per material entry: u32 material, u32 sub material,
            u64 user flags; a triangle's entry is first + its shape tag
"""
import math
import struct

import numpy as np

EMPTY_TRIS = np.zeros((0, 3, 3), np.float32)
EMPTY_I = np.zeros(0, np.int64)


def _varuint(b, p):
    x = b[p]
    if x & 0x80 == 0:
        return x, p + 1
    if x & 0xC0 == 0x80:
        return ((x & 0x3F) << 8) | b[p + 1], p + 2
    if x & 0xE0 == 0xC0:
        return ((x & 0x1F) << 16) | (b[p + 1] << 8) | b[p + 2], p + 3
    if x & 0xF8 == 0xE0:
        return ((x & 0x07) << 24) | (b[p + 1] << 16) | (b[p + 2] << 8) | b[p + 3], p + 4
    return ((x & 0x07) << 32) | int.from_bytes(b[p + 1:p + 5], "big"), p + 5


def _sections(b, start, end):
    out, p = {}, start
    while p + 8 <= end:
        size = struct.unpack_from(">I", b, p)[0] & 0x3FFFFFFF
        if size < 8:
            break
        out.setdefault(b[p + 4:p + 8], (p + 8, p + size))
        p += size
    return out


def tagfile_offsets(b):
    out, i = [], 0
    while True:
        i = b.find(b"TAG0", i)
        if i < 0:
            return out
        size = struct.unpack_from(">I", b, i - 4)[0] & 0x3FFFFFFF
        out.append((i - 4, size))
        i = i - 4 + max(size, 8)


class Tagfile:
    def __init__(self, b, off, size):
        self.b = b
        top = _sections(b, off + 8, off + size)
        sub = {}
        for k in (b"TYPE", b"INDX"):
            if k in top:
                sub.update(_sections(b, *top[k]))
        self.D = top[b"DATA"][0]
        names = b[sub[b"TST1"][0]:sub[b"TST1"][1]].split(b"\0")
        p = sub[b"TNA1"][0]
        n, p = _varuint(b, p)
        types = [None]
        for _ in range(1, n):
            name, p = _varuint(b, p)
            tcount, p = _varuint(b, p)
            for _ in range(tcount):   # template parameters: name index + value
                p = _varuint(b, _varuint(b, p)[1])[1]
            types.append(names[name].decode("latin1"))
        start, end = sub[b"ITEM"]
        self.items = {}
        self.root = None
        for k, r in enumerate(range(start, end - 11, 12)):
            t, data_off, count = struct.unpack_from("<III", b, r)
            t &= 0xFFFFFF
            if k == 1 and 0 < t < len(types):
                self.root = types[t]
            if count and 0 < t < len(types):
                self.items[data_off] = (types[t], count)

    def rel(self, off):
        """Relative array / pointer at data offset off -> (target data offset, count)."""
        r, n = struct.unpack_from("<iI", self.b, self.D + off)
        return off + r, n

    def f32(self, off, n):
        return np.frombuffer(self.b, np.float32, n, self.D + off)

    def kind(self, off):
        return self.items.get(off, (None,))[0]


def _quat_matrix(q):
    x, y, z, w = (float(v) for v in q)
    return np.array([[1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w)],
                     [2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w)],
                     [2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)]], np.float32)


def _shape_tags(t, off, keys):
    to, tn = t.rel(off + 0x60)
    if not tn:
        return np.zeros(len(keys), np.int64)
    tab = np.frombuffer(t.b, "<u4", tn * 2, t.D + to).reshape(-1, 2)
    return tab[np.clip(np.searchsorted(tab[:, 0], keys, "right") - 1, 0, None), 1].astype(np.int64)


def mesh_shape(t, off):
    """hknpMeshShape -> (triangles (n, 3, 3), shape tag per triangle)."""
    so, sn = t.rel(off + 0x88)
    tris, tags = [], []
    for s in range(sn):
        sec = so + s * 0x40
        po, pn = t.rel(sec + 8)
        vo, _ = t.rel(sec + 16)
        if not pn:
            continue
        prims = np.frombuffer(t.b, np.uint8, pn * 4, t.D + po).reshape(-1, 4).astype(np.int64)
        nv = int(prims.max()) + 1
        offset = struct.unpack_from("<3i", t.b, t.D + sec + 32)
        if offset[0] == 0x7FFFFFFF:
            # unquantized section: float32 xyz vertices
            world = np.frombuffer(t.b, "<f4", nv * 3, t.D + vo).reshape(-1, 3).astype(np.float32)
        else:
            verts = np.frombuffer(t.b, "<u2", nv * 3, t.D + vo).reshape(-1, 3).astype(np.float32)
            world = (np.array(offset, np.float32) + verts) / 512.0
        tg = _shape_tags(t, off, (s << 8) | np.arange(pn))
        tris.append(world[prims[:, [0, 1, 2]]])
        tags.append(tg)
        quad = prims[:, 2] != prims[:, 3]
        if quad.any():
            tris.append(world[prims[quad][:, [0, 2, 3]]])
            tags.append(tg[quad])
    if not tris:
        return EMPTY_TRIS, EMPTY_I
    return np.concatenate(tris), np.concatenate(tags)


def convex_shape(t, off):
    vo, vn = t.rel(off + 0x38)
    fo, fn = t.rel(off + 0x48)
    io, inn = t.rel(off + 0x50)
    if not vn or not fn:
        return EMPTY_TRIS
    verts = t.f32(vo, vn * 3).reshape(-1, 3)   # hkFloat3, packed
    idx = np.frombuffer(t.b, np.uint8, inn, t.D + io)
    out = []
    for i in range(fn):
        first, count = struct.unpack_from("<HB", t.b, t.D + fo + i * 4)
        f = idx[first:first + count]
        if len(f) >= 3 and f.max() < vn:   # fan
            out.append(np.stack([np.repeat(verts[f[:1]], len(f) - 2, 0), verts[f[1:-1]], verts[f[2:]]], 1))
    return np.concatenate(out).astype(np.float32) if out else EMPTY_TRIS


def capsule_tris(a, c, r, n=12):
    axis = np.asarray(c, np.float32) - np.asarray(a, np.float32)
    length = float(np.linalg.norm(axis))
    axis = axis / length if length > 1e-6 else np.array([0, 1, 0], np.float32)
    u = np.cross(axis, [0, 1, 0] if abs(axis[1]) < 0.9 else [1, 0, 0])
    u /= np.linalg.norm(u)
    v = np.cross(axis, u)
    ring = [u * math.cos(2 * math.pi * i / n) * r + v * math.sin(2 * math.pi * i / n) * r for i in range(n)]
    out = []
    for i in range(n):
        p0, p1 = ring[i], ring[(i + 1) % n]
        out += [[a + p0, a + p1, c + p1], [a + p0, c + p1, c + p0]]
        out += [[a, a + p1, a + p0], [c, c + p0, c + p1]]   # caps (flat)
    return np.array(out, np.float32)


def capsule_shape(t, off):
    po, pn = t.rel(off + 0x38)
    if pn < 2:
        return EMPTY_TRIS
    pts = t.f32(po, 6).reshape(2, 3)   # hkFloat3, packed
    return capsule_tris(pts[0], pts[1], float(t.f32(off + 0x68, 1)[0]))


def shape(t, off, depth=0):
    """Any supported shape -> (triangles, shape tag per triangle)."""
    kind = t.kind(off)
    if kind == "hknpMeshShape":
        return mesh_shape(t, off)
    if kind in ("hknpBoxShape", "hknpConvexShape", "hknpConvexPolytopeShape"):
        tris = convex_shape(t, off)
    elif kind == "hknpCapsuleShape":
        tris = capsule_shape(t, off)
    elif kind == "hknpCompoundShape" and depth < 4:
        tris, _, tags = compound_shape(t, off, depth + 1)
        return tris, tags
    else:
        tris = EMPTY_TRIS
    return tris, np.zeros(len(tris), np.int64)


def compound_instances(t, off):
    """(data offset, count) of the compound's 64-byte instance records."""
    for f in range(0, 0x100, 4):
        if t.D + off + f + 8 > len(t.b):
            break
        target, _ = t.rel(off + f)
        k = t.items.get(target)
        if k and k[0] == "hkFreeListArrayElement":
            return target, k[1]
    return None, 0


def compound_shape(t, off, depth=0):
    """hknpCompoundShape -> (triangles, instance index per triangle, shape tag per triangle)."""
    first, count = compound_instances(t, off)
    tris, ids, tags, cache = [], [], [], {}
    for i in range(count):
        rec = first + i * 64
        sp, _ = t.rel(rec + 48)
        if sp not in t.items:
            continue
        if sp not in cache:
            cache[sp] = shape(t, sp, depth)
        local, tg = cache[sp]
        if not len(local):
            continue
        scale = t.f32(rec + 32, 3)
        if not np.all(np.isfinite(scale)) or not np.any(scale):
            scale = np.ones(3, np.float32)
        tris.append((local * scale) @ _quat_matrix(t.f32(rec, 4)).T + t.f32(rec + 16, 3))
        ids.append(np.full(len(local), i, np.int64))
        tags.append(tg)
    if not tris:
        return EMPTY_TRIS, EMPTY_I, EMPTY_I
    return np.concatenate(tris).astype(np.float32), np.concatenate(ids), np.concatenate(tags)


def _header(b):
    return struct.unpack_from("<16I", b, 0)


def body_hashes(b):
    """Body index -> placement hash id (Banc "Hash")."""
    w = _header(b)
    return [struct.unpack_from("<Q", b, o + 8)[0] for o in range(w[4], w[5] - 0x1F, 0x20)]


MATERIAL = np.dtype([("material", "<u4"), ("sub", "<u4"), ("flags", "<u8")])


def instance_table(b):
    """-> (material entries, {instance id: (body index, first material entry, entry count, instance flags)}).
    The instance id is the u16 at +44 of the compound's instance record. Instance
    flags: >> 24 shape kind (1 convex, 2 mesh); (>> 8) & 0xFF is the byte objmap
    ships per body in its bodies files (2 on actor-type objects)."""
    w = _header(b)
    table = np.frombuffer(b, MATERIAL, (w[9] - w[8]) // 16, w[8])
    recs = {}
    for o in range(w[7], w[8] - 19, 20):
        inst, flags, body, _, first, count = struct.unpack_from("<IIHHII", b, o)
        recs[inst] = (body, first, count, flags)
    return table, recs


def static_compound(b):
    """A .bphsc tile -> dict:
      tris (n, 3, 3) float32: the tile's ground mesh in tile-local space, every
        baked instance in world space
      local (n,) bool: the triangle is the tile's ground (add the tile origin)
      body (n,) int: index into bodies (-1: the ground)
      entry (n,) int: material table entry (-1: unknown, the ground's)
      layer (n,) int: 0 the ground, k the k-th compound (one per collision layer)
      bodies: [u64 placement hash], body_byte: [int] per body
      table: material entries (material, sub, flags)."""
    hashes = body_hashes(b)
    table, recs = instance_table(b)
    body_byte = [0] * len(hashes)
    for body, _, _, flags in recs.values():
        if body < len(hashes) and not body_byte[body]:
            body_byte[body] = (flags >> 8) & 0xFF
    parts = []
    layer = 0
    for off, size in tagfile_offsets(b):
        try:
            t = Tagfile(b, off, size)
        except (KeyError, IndexError, struct.error):
            continue
        if t.root == "hknpMeshShape":
            tris, _ = mesh_shape(t, 0)
            n = len(tris)
            parts.append((tris, np.ones(n, bool), np.full(n, -1), np.full(n, -1), np.zeros(n, np.int64)))
        elif t.root == "hknpCompoundShape":
            layer += 1
            tris, idx, tags = compound_shape(t, 0)
            first_rec, count = compound_instances(t, 0)
            body_of = np.full(count, -1, np.int64)
            entry_of = np.full(count, -1, np.int64)
            for i in range(count):
                rec = recs.get(struct.unpack_from("<H", b, t.D + first_rec + i * 64 + 44)[0])
                if rec and rec[0] < len(hashes):
                    body_of[i], entry_of[i] = rec[0], rec[1]
            entry = entry_of[idx]
            n = len(tris)
            parts.append((tris, np.zeros(n, bool), body_of[idx], np.where(entry >= 0, entry + tags, -1),
                          np.full(n, layer, np.int64)))
    if not parts:
        parts = [(EMPTY_TRIS, np.zeros(0, bool), EMPTY_I, EMPTY_I, EMPTY_I)]
    entry = np.concatenate([p[3] for p in parts])
    entry[entry >= len(table)] = -1
    return {
        "tris": np.concatenate([p[0] for p in parts]).astype(np.float32),
        "local": np.concatenate([p[1] for p in parts]),
        "body": np.concatenate([p[2] for p in parts]),
        "entry": entry,
        "layer": np.concatenate([p[4] for p in parts]),
        "bodies": hashes, "body_byte": body_byte, "table": table,
    }


def file_shapes(b):
    """Every root shape in a .bphsh file -> triangles (local space) and shape tags."""
    tris, tags = [], []
    for off, size in tagfile_offsets(b):
        try:
            t = Tagfile(b, off, size)
        except (KeyError, IndexError, struct.error):
            continue
        tr, tg = shape(t, 0)
        if len(tr):
            tris.append(tr)
            tags.append(tg)
    if not tris:
        return EMPTY_TRIS, EMPTY_I
    return np.concatenate(tris), np.concatenate(tags)
