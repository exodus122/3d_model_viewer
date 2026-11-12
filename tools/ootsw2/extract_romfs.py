#!/usr/bin/env python3
"""Extract Ocarina of Time (Switch 2) maps for the viewer straight from a romfs dump.

Reads the game's own files instead of the Owl Object Map's processed copies:

  Banc/<area>/<banc>_{Static,Dynamic}.bcett.byml.zs   placed objects (BYML)
  Phive/StaticCompoundBody/<area>/<banc>[_X#_Z#]...bphsc.zs
                                                      the baked static collision (Havok),
                                                      one file per 250 m tile on field maps
  Pack/Actor/<name>.pack.zs                           actor packs: physics -> shapes
  Phive/Shape/Dcc/*.bphsh.zs                          actor collision meshes (Havok)
  RSDB/ActorInfo.Product.*.rstbl.byml.zs              IsNotTurnToActor per actor
  Pack/Bootup...pack.zs: Phive/Config/PhiveConfig.byml material / shape tag names

Writes, per map (models/OOTSW2/<area>/<banc>/):
  objects.json        [{n, h, p, g, r?, s?, b?, na?, l?, t?, zc?, za?, zs?, nm?, u?}]
                      (the same fields extract_objmap.py writes; u, objmap's friendly
                      name, is kept from an existing objects.json since the romfs has none)
  collision.bin       "OCOL" actor shapes per actor name (format in js/ootsw2_map.js)
  compound/manifest.json + <tile>.tile.bin.gz
                      the static compound, format "romfs-1" (see write_tile)
and models/OOTSW2/airwalls.json, js/ootsw2_map_list.js.

Usage:
  python tools/ootsw2/extract_romfs.py <romfs dir> [--only Graveyard_Child ...]
"""
import argparse
import gzip
import json
import math
import os
import re
import struct
import sys
import time

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import havok  # noqa: E402
import volumestats  # noqa: E402
from romfs import RomFS, byml, sarc  # noqa: E402

ROOT = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))
OUT = os.path.join(ROOT, "models", "OOTSW2")
TILE = 250.0
PHIVE_SUFFIX = ".Nin_Ounce_NVN2"
AIRWALL = re.compile(r"Air[Ww]all")


# ---- Map list ---------------------------------------------------------------

def find_maps(r):
    """-> [(area, banc)] for every Banc scene."""
    out = []
    base = r.path("Banc")
    for area in sorted(os.listdir(base)):
        d = os.path.join(base, area)
        if not os.path.isdir(d):
            continue
        bancs = set()
        for f in os.listdir(d):
            m = re.match(r"(.+)_(Static|Dynamic)\.bcett\.byml\.zs$", f)
            if m:
                bancs.add(m.group(1))
        out += [(area, b) for b in sorted(bancs)]
    return out


def compound_files(r, area, banc):
    """-> {(x, z): path} (an untiled map: {None: path})."""
    d = r.path("Phive", "StaticCompoundBody", area)
    if not os.path.isdir(d):
        return {}
    out = {}
    pat = re.compile(re.escape(banc) + r"(?:_X(\d+)_Z(\d+))?" + re.escape(PHIVE_SUFFIX) + r"\.bphsc\.zs$")
    for f in os.listdir(d):
        m = pat.match(f)
        if m:
            out[(int(m.group(1)), int(m.group(2))) if m.group(1) else None] = os.path.join(d, f)
    return out


def old_map_list():
    """The current js/ootsw2_map_list.js entries by dir (names, groups, ages, bounds)."""
    path = os.path.join(ROOT, "js", "ootsw2_map_list.js")
    out = {}
    if os.path.exists(path):
        for line in open(path, encoding="utf-8"):
            line = line.strip().rstrip(",")
            if line.startswith("{"):
                e = json.loads(line)
                out[e["dir"]] = e
    return out


# ---- Objects ----------------------------------------------------------------

def vec3(v):
    return [v, v, v] if isinstance(v, (int, float)) else list(v)


def hexid(h):
    return "0x%016x" % h


def r4(v):
    return [round(float(x), 4) for x in v]


def _msbt_text(raw, utf8):
    """One MSBT string, control tags (0x0E group type size payload, 0x0F group type) dropped."""
    unit = 1 if utf8 else 2
    rd = (lambda k: raw[k]) if utf8 else (lambda k: raw[k] | raw[k + 1] << 8)
    out, k = bytearray(), 0
    while k + unit <= len(raw):
        c = rd(k)
        if c == 0x0E:   # code, u16 group, u16 type, u16 payload size, payload
            k += unit + 6 + (raw[k + unit + 4] | raw[k + unit + 5] << 8)
            continue
        if c == 0x0F:
            k += unit + 4
            continue
        if c == 0:
            break
        out += raw[k:k + unit]
        k += unit
    return out.decode("utf-8" if utf8 else "utf-16-le", "replace").strip()


def msbt_labels(buf):
    """MSBT -> {label: text}, control codes dropped."""
    if buf[:8] != b"MsgStdBn":
        return {}
    utf8 = buf[0x0C] == 0
    labels, texts, p = {}, [], 0x20
    while p + 0x10 <= len(buf):
        magic, size = buf[p:p + 4], struct.unpack_from("<I", buf, p + 4)[0]
        d = buf[p + 0x10:p + 0x10 + size]
        if magic == b"LBL1":
            for i in range(struct.unpack_from("<I", d, 0)[0]):
                count, q = struct.unpack_from("<II", d, 4 + i * 8)
                for _ in range(count):
                    n = d[q]
                    labels[d[q + 1:q + 1 + n].decode("utf-8", "replace")] = struct.unpack_from("<I", d, q + 1 + n)[0]
                    q += n + 5
        elif magic == b"TXT2":
            n = struct.unpack_from("<I", d, 0)[0]
            offs = list(struct.unpack_from(f"<{n}I", d, 4)) + [len(d)]
            texts += [_msbt_text(d[offs[i]:offs[i + 1]], utf8) for i in range(n)]
        p = (p + 0x10 + size + 15) & ~15
    return {l: texts[i] for l, i in labels.items() if i < len(texts)}


def english_names(r):
    """Actor name -> its English name, from the "<actor>_Name" labels of Mals/USen ActorMsg."""
    files = [f for f in os.listdir(r.path("Mals")) if f.startswith("USen.")] if r.exists("Mals") else []
    if not files:
        return {}
    out = {}
    for k, buf in sarc(r.read("Mals", sorted(files)[-1])).items():
        if k.startswith("ActorMsg/"):
            out.update({l[:-5]: t for l, t in msbt_labels(buf).items() if l.endswith("_Name") and t})
    return out


def english_name(names, actor):
    for key in (actor, actor.replace("Obj_", "Item_", 1), re.sub(r"_[A-Z]_\d+$", "", actor)):
        if key in names:
            return names[key]
    return None


# Hazard zones: the area actors an AI group's logic watches. Shared logic by
# name; scene-specific modules by the nodes inside their .ainb.
ZONE_LOGIC = [("Gimmick_AreaContact_FallDown_Item", None, None),   # catches items / animals, not Link
              ("Gimmick_AreaContact_FallDown", "void", "Void out"),
              ("InvalidateRestartArea", "norespawn", "No respawn"),
              ("Whirlpool", "whirlpool", "Whirlpool"),
              ("FieldDungeonEntranceSet", None, None)]              # loading zones, drawn on their own
MODULE_NODES = [(b"GiveAbyssItem", None, None), (b"FallDown_Item", None, None),
                (b"SandAbyss", "void", "Quicksand"),
                (b"OutAreaCheck", "safepath", "Safe path (leaving these sends you back)"),
                (b"GiveAbyssActor", "void", "Void out (scripted)"),
                (b"InvalidateRestartPos", "norespawn", "No respawn"),
                (b"EventRequestTrigger", "event", "Cutscene trigger")]


class ZoneLogic:
    def __init__(self, r):
        self.r = r
        self.cache = {}

    def kind(self, logic):
        """A Logic path -> (kind, label) or None."""
        for pattern, kind, label in ZONE_LOGIC:
            if pattern in logic:
                return (kind, label) if kind else None
        if "/Module/" not in logic:
            return None
        name = logic.split("/")[-1].split(".")[0]
        if name not in self.cache:
            self.cache[name] = None
            f = self.r.path("Logic", name + ".logic.module.ainb")
            if os.path.exists(f):
                b = self.r.decompress(open(f, "rb").read())
                for node, kind, label in MODULE_NODES:
                    if node in b and (kind in (None, "event") or b"Player" in b):
                        if kind == "event":
                            m = re.search(rb"(?:Dm|Demo)_[A-Za-z0-9_]+", b)
                            label = "Cutscene " + m.group(0).decode() if m else label
                        self.cache[name] = (kind, label) if kind else None
                        break
        return self.cache[name]


def load_objects(r, area, banc, actor_info, old, names=None, zones=None):
    """Banc Static + Dynamic -> objects.json records (objmap's field names, plus
    zk / zl: the hazard zone kind and label the game's logic gives an area)."""
    actors, groups, ai_groups = [], [], []
    for kind in ("Static", "Dynamic"):
        f = r.path("Banc", area, f"{banc}_{kind}.bcett.byml.zs")
        if os.path.exists(f):
            doc = byml(r.read("Banc", area, f"{banc}_{kind}.bcett.byml.zs")) or {}
            actors += doc.get("Actors") or []
            groups += doc.get("SimultaneousGroups") or []
            ai_groups += doc.get("AiGroups") or []
    zone_of = {}
    if zones:
        for g in ai_groups:
            z = zones.kind(g.get("Logic", ""))
            if z:
                for ref in g.get("References") or []:
                    zone_of.setdefault(ref.get("Reference"), z)

    # Generation groups: the scene's SimultaneousGroups (objects spawned
    # together); every other object is a group of its own
    parent = {a["Hash"]: a["Hash"] for a in actors}

    def find(x):
        while parent[x] != x:
            parent[x] = parent[parent[x]]
            x = parent[x]
        return x

    for g in groups:
        members = [h for h in g if h in parent]
        for h in members[1:]:
            parent[find(h)] = find(members[0])
    group_ids = {}

    out = []
    for a in actors:
        name, h = a["Gyaml"], a["Hash"]
        dyn = a.get("Dynamic") or {}
        o = {"n": name, "h": hexid(h), "p": r4(a.get("Translate", [0, 0, 0])),
             "g": group_ids.setdefault(find(h), len(group_ids))}
        prev = old.get(o["h"])
        # objmap's hand-written label when an earlier objects.json has one,
        # else the game's own English name for the actor
        label = english_name(names or {}, name)
        if prev and prev.get("u"):
            o["u"] = prev["u"]
        elif label and label != name:
            o["u"] = label
        z = zone_of.get(h)
        if z and is_area_name(name):
            o["zk"], o["zl"] = z
        if a.get("Bakeable"):
            o["b"] = 1
        if (actor_info.get(name) or {}).get("IsNotTurnToActor"):
            o["na"] = 1
        links = [[hexid(l["Dst"]), l.get("Name") or l.get("Gyaml")] for l in a.get("Links") or [] if l.get("Dst")]
        if links:
            o["l"] = links
        if "Rotate" in a and any(vec3(a["Rotate"])):
            o["r"] = vec3(a["Rotate"])
        if "Scale" in a:
            o["s"] = vec3(a["Scale"])
        for key, field in (("t", "RigidBodyShapeType"), ("zc", "NextBancParamNameChild"),
                           ("za", "NextBancParamNameAdult"), ("zs", "NextStartPosName")):
            if dyn.get(field) is not None:
                o[key] = dyn[field]
        if a.get("Name"):
            o["nm"] = a["Name"]
        out.append(o)
    return out


# ---- Actor collision (OCOL) -------------------------------------------------

def rot_deg(r):
    """OffsetRotation (degrees, XYZ) -> R = Rz * Ry * Rx."""
    rx, ry, rz = (math.radians(r.get(k, 0.0)) for k in "XYZ") if r else (0, 0, 0)
    cx, sx, cy, sy, cz, sz = math.cos(rx), math.sin(rx), math.cos(ry), math.sin(ry), math.cos(rz), math.sin(rz)
    X = np.array([[1, 0, 0], [0, cx, -sx], [0, sx, cx]])
    Y = np.array([[cy, 0, sy], [0, 1, 0], [-sy, 0, cy]])
    Z = np.array([[cz, -sz, 0], [sz, cz, 0], [0, 0, 1]])
    return Z @ Y @ X


def v3(d, default=0.0):
    return np.array([d.get(k, default) for k in "XYZ"], float) if d else np.full(3, default, float)


def _ring(a, b, r, n):
    """n points around the axis a -> b at a."""
    axis = b - a
    length = np.linalg.norm(axis)
    axis = axis / length if length > 1e-9 else np.array([0, 1, 0.0])
    u = np.cross(axis, [0, 1, 0] if abs(axis[1]) < 0.9 else [1, 0, 0])
    u /= np.linalg.norm(u)
    w = np.cross(axis, u)
    t = np.linspace(0, 2 * math.pi, n, endpoint=False)
    return a + r * (np.outer(np.cos(t), u) + np.outer(np.sin(t), w)), axis


def _sphere_points(c, r, n=8):
    pts = [c + [0, r, 0], c - [0, r, 0]]
    for lat in (-60, -30, 0, 30, 60):
        y, rr = r * math.sin(math.radians(lat)), r * math.cos(math.radians(lat))
        pts += [c + [rr * math.cos(t), y, rr * math.sin(t)] for t in np.linspace(0, 2 * math.pi, n, endpoint=False)]
    return np.array(pts)


def primitive_points(kind, p):
    """A ShapeParam primitive -> its convex point set (shape-local, before the offset)."""
    if kind == "Box":
        h = v3(p.get("HalfExtents"), 0.5)
        corners = np.array([[x, y, z] for x in (-1, 1) for y in (-1, 1) for z in (-1, 1)], float)
        return corners * h + v3(p.get("Center"))
    if kind == "Sphere":
        return _sphere_points(v3(p.get("Center")), p.get("Radius", 0.5))
    if kind in ("Capsule", "Cylinder"):
        a, b, r = v3(p.get("CenterA")), v3(p.get("CenterB")), p.get("Radius", 0.5)
        ra, axis = _ring(a, b, r, 16)
        rb, _ = _ring(b, a, r, 16)
        pts = [ra, rb]
        if kind == "Capsule":   # hemisphere caps
            for c, sgn in ((a, -1), (b, 1)):
                pts.append(_ring(c + sgn * axis * r * 0.7, c + sgn * axis * 2 * r, r * 0.7, 8)[0])
                pts.append([c + sgn * axis * r])
        return np.concatenate([np.atleast_2d(x) for x in pts])
    if kind == "Cone":
        top, bottom, r = v3(p.get("Top")), v3(p.get("Bottom")), p.get("Radius", 0.5)
        ring, _ = _ring(bottom, top, r, max(int(p.get("NumSides", 16)), 3))
        return np.vstack([ring, top])
    if kind == "Prism":   # character body: radius around the actor, up to the head
        height = max(p.get("HeightHead", 0.0), p.get("HeightShoulder", 0.0), p.get("HeightStep", 0.0), 0.1)
        r = p.get("Radius", 0.3)
        a, b = np.zeros(3), np.array([0, height, 0.0])
        return np.vstack([_ring(a, b, r, 16)[0], _ring(b, a, r, 16)[0]])
    if kind == "Polytope":
        return np.array([v3(v) for v in p.get("Vertices") or []])
    return None


def _merge(base, over):
    """$parent inheritance: dicts merge key by key, anything else is replaced."""
    out = dict(base)
    for k, v in over.items():
        out[k] = _merge(out[k], v) if isinstance(v, dict) and isinstance(out.get(k), dict) else v
    return out


class ActorShapes:
    """Actor name -> collision shapes (local space), from the actor packs."""

    PRIMITIVES = ("Box", "Sphere", "Capsule", "Cylinder", "Cone", "Prism", "Polytope")

    def __init__(self, r):
        self.r = r
        self.cache = {}
        self.meshes = {}

    def _pack(self, name):
        if not self.r.exists("Pack", "Actor", name + ".pack.zs"):
            return None
        return sarc(self.r.read("Pack", "Actor", name + ".pack.zs"))

    @staticmethod
    def _gyml(files, path, depth=0):
        """A Work/... .gyml path inside the pack, with its $parent chain merged in."""
        if not path or depth > 8:
            return {}
        key = path.lstrip("?").replace("Work/", "", 1).replace(".gyml", ".bgyml")
        if key not in files:
            return {}
        d = byml(files[key]) or {}
        base = ActorShapes._gyml(files, d.get("$parent"), depth + 1) if d.get("$parent") else {}
        return _merge(base, {k: v for k, v in d.items() if k != "$parent"})

    def _mesh(self, path):
        f = os.path.basename(path).replace(".phsh", PHIVE_SUFFIX + ".bphsh.zs")
        if f not in self.meshes:
            tris = havok.EMPTY_TRIS
            if self.r.exists("Phive", "Shape", "Dcc", f):
                tris, _ = havok.file_shapes(self.r.read("Phive", "Shape", "Dcc", f))
            self.meshes[f] = tris
        return self.meshes[f]

    def get(self, name):
        """-> {"tris": (n, 3, 3), "hulls": [points (k, 3)]} or None."""
        if name in self.cache:
            return self.cache[name]
        res = None
        try:
            res = self._build(name)
        except (KeyError, ValueError, IndexError, struct.error) as e:
            print(f"  {name}: {e}")
        self.cache[name] = res
        return res

    def _build(self, name):
        files = self._pack(name)
        if not files:
            return None
        actor = self._gyml(files, f"Work/Actor/{name}.engine__actor__ActorParam.gyml")
        phys = self._gyml(files, (actor.get("Components") or {}).get("PhysicsRef"))
        cset = self._gyml(files, phys.get("ControllerSetPath"))
        shapes = {e.get("Name"): e.get("FilePath") for e in cset.get("ShapeNamePathAry") or []}
        if not shapes:
            return None
        # Solid shapes: the ones entities (not sensors) use; bone-tracked
        # ragdoll parts are left out (they need the skeleton's pose)
        solid, has_entities = set(), False
        for e in cset.get("RigidBodyEntityNamePathAry") or []:
            has_entities = True
            solid.add(self._gyml(files, e.get("FilePath")).get("ShapeName") or e.get("Name"))
        for e in cset.get("ControllerEntityNamePathAry") or []:
            has_entities = True
            for unit in self._gyml(files, e.get("FilePath")).get("RigidBodyControllerUnitAry") or []:
                if not unit.get("TrackingBoneName"):
                    solid.add(unit.get("ShapeName") or unit.get("Name"))
        if not has_entities:
            sensors = set()
            for key in ("RigidBodySensorNamePathAry", "ControllerSensorNamePathAry"):
                for e in cset.get(key) or []:
                    p = self._gyml(files, e.get("FilePath"))
                    sensors.add(p.get("ShapeName") or e.get("Name"))
                    for unit in p.get("RigidBodyControllerUnitAry") or []:
                        sensors.add(unit.get("ShapeName") or unit.get("Name"))
            solid = set(shapes) - sensors
        params = [self._gyml(files, shapes[n]) for n in sorted(solid) if n in shapes]
        # Characters (enemies, NPCs): what others bump into is the character
        # controller's standing Prism body, not the ragdoll / attack parts
        prisms = [p for p in (self._gyml(files, f) for f in shapes.values()) if p.get("Prism")]
        if prisms and (not params or cset.get("PathCharacterController") or cset.get("CharacterControllerName")):
            params = prisms[:1]
        tris, hulls = [], []
        for p in params:
            for m in p.get("PhshMesh") or []:
                t = self._mesh(m.get("PhshMeshPath", ""))
                if len(t):
                    tris.append(t)
            for kind in self.PRIMITIVES:
                for prim in p.get(kind) or []:
                    pts = primitive_points(kind, prim)
                    if pts is None or len(pts) < 4:
                        continue
                    pts = pts @ rot_deg(prim.get("OffsetRotation")).T + v3(prim.get("OffsetTranslation"))
                    hulls.append(pts.astype(np.float32))
        if not tris and not hulls:
            return None
        return {"tris": np.concatenate(tris) if tris else havok.EMPTY_TRIS, "hulls": hulls}


def write_ocol(path, shapes, baked):
    """OCOL v1 (see parseOCOL in js/ootsw2_map.js)."""
    out = bytearray(b"OCOL" + struct.pack("<II", 1, len(shapes)))
    for name, s in sorted(shapes.items()):
        tris = s["tris"].reshape(-1, 3)
        if len(tris):
            verts, inv = np.unique(tris, axis=0, return_inverse=True)
            idx = inv.reshape(-1).astype(np.uint32)
        else:
            verts, idx = np.zeros((0, 3), np.float32), np.zeros(0, np.uint32)
        hulls, pts = [], [verts]
        first = len(verts)
        for h in s["hulls"]:
            hulls.append((first, len(h)))
            pts.append(h)
            first += len(h)
        allv = np.concatenate(pts).astype(np.float64)
        lo, hi = allv.min(0), allv.max(0)
        q = np.round((allv - lo) / np.maximum(hi - lo, 1e-6) * 65535).astype(np.uint16)
        nb = name.encode()
        out += struct.pack("<H", len(nb)) + nb
        out += struct.pack("<III", len(allv), len(idx), len(hulls))
        out += struct.pack("<3f3f", *lo, *hi)
        out += q.tobytes()
        wide = len(allv) > 65536
        out += idx.astype(np.uint32 if wide else np.uint16).tobytes()
        out += b"\0" * (-len(out) & 3)
        for h in hulls:
            out += struct.pack("<II", *h)
    out += struct.pack("<I", len(baked)) + b"".join(struct.pack("<Q", h) for h in sorted(baked))
    open(path, "wb").write(out)


# ---- Static compound ----------------------------------------------------------

class SurfaceNames:
    def __init__(self, r):
        cfg = byml(sarc(r.read("Pack", "Bootup.Nin_Ounce_NVN2.pack.zs"))["Phive/Config/PhiveConfig.byml"])
        self.materials = [m["ComponentName"] for m in cfg["MaterialCollection"]]
        self.subs = list(cfg["SubMaterialCollection"])
        # bit i of the flags is the i-th name of the game's shape tag enum
        self.bits = [(1 << i, n) for i, n in enumerate(cfg["UserShapeTagCollection"])]

    def tags(self, flags):
        return [name for mask, name in self.bits if flags & mask]

    def describe(self, material, sub, flags):
        m = self.materials[material] if material < len(self.materials) else f"Material{material}"
        s = self.subs[sub] if sub < len(self.subs) else f"Sub{sub}"
        return {"m": m, "s": s if s != "Undefined" else None, "t": self.tags(flags)}


def write_tile(path, tris, body, surface, layer, hashes, body_bytes):
    """romfs-1 tile, gzip'd. Little endian:
      "OOTC", u32 version 1, u32 vertexCount, u32 triangleCount, u32 bodyCount,
      f32 xyz[vertexCount] (world metres), u32 indices[triangleCount * 3],
      u16 body[triangleCount] (0xFFFF: the ground), u16 surface[triangleCount]
      (index into the manifest's surfaces, 0xFFFF: unknown), u8 layer[triangleCount]
      (0 the ground, k the k-th collision layer), pad to 8,
      u64 hashIds[bodyCount], u8 bodyByte[bodyCount]."""
    verts, inv = np.unique(tris.reshape(-1, 3), axis=0, return_inverse=True)
    out = bytearray(b"OOTC" + struct.pack("<IIII", 1, len(verts), len(tris), len(hashes)))
    out += verts.astype("<f4").tobytes()
    out += inv.reshape(-1).astype("<u4").tobytes()
    out += body.astype("<u2").tobytes()
    out += surface.astype("<u2").tobytes()
    out += layer.astype("u1").tobytes()
    out += b"\0" * (-len(out) & 7)
    out += np.array(hashes, "<u8").tobytes()
    out += bytes(body_bytes)
    with gzip.open(path, "wb", compresslevel=6) as f:
        f.write(out)
    return len(verts)


AREA_LIKE = re.compile(r"Area|(Box|Cylinder|Sphere|Capsule)$")
AREA_EXCLUDE = re.compile(r"^(Obj_|FldObj_|Npc_|Enemy_|Item_|Weapon_|TBox|Land_)|Air[Ww]all")
# Per-triangle layer class in the tiles
LAYERS = [
    {"index": 0, "label": "ground", "title": "The tile's heightmap ground mesh", "hidden": False},
    {"index": 1, "label": "static collision", "title": "Baked objects' collision", "hidden": False},
    {"index": 2, "label": "detail copy",
     "title": "A second, more detailed copy of objects another collision layer of the tile already holds "
              "(the game keeps smooth and rough versions for different layers)", "hidden": True},
    {"index": 3, "label": "baked areas",
     "title": "Area volumes baked into the static compound (no-horse, drop, auto-placement areas...)", "hidden": True},
]


def is_area_name(name):
    return bool(AREA_LIKE.search(name)) and not AREA_EXCLUDE.search(name)


def extract_compound(r, files, area, banc, out_dir, names, surfaces, surface_index, object_names):
    """-> (set of baked hash ids, manifest dict) or (set(), None)."""
    if not files:
        return set(), None
    os.makedirs(out_dir, exist_ok=True)
    for f in os.listdir(out_dir):   # objmap's lod / bodies files and stale tiles
        os.remove(os.path.join(out_dir, f))
    tiled = None not in files
    if tiled:
        cols = max(k[0] for k in files) + 1
        rows = max(k[1] for k in files) + 1
        origin = (-cols / 2 * TILE, -rows / 2 * TILE)
    baked = set()
    layer_tris = {}
    tiles = []
    for key, path in sorted(files.items(), key=lambda kv: kv[0] or (0, 0)):
        sc = havok.static_compound(r.decompress(open(path, "rb").read()))
        tris = sc["tris"]
        if not len(tris):
            continue
        if tiled:
            tris = tris.copy()
            tris[sc["local"]] += np.array([origin[0] + key[0] * TILE, 0, origin[1] + key[1] * TILE], np.float32)
        hashes = sc["bodies"]
        body = sc["body"]
        # surfaces: (material, sub, flags) -> map-wide index
        table = sc["table"]
        surf = np.full(len(tris), 0xFFFF, np.int64)
        known = sc["entry"] >= 0
        if known.any():
            uniq, inv = np.unique(sc["entry"][known], return_inverse=True)
            ids = []
            for e in uniq:
                t = table[e]
                k = (int(t["material"]), int(t["sub"]), int(t["flags"]))
                if k not in surface_index:
                    surface_index[k] = len(surfaces)
                    surfaces.append(names.describe(*k))
                ids.append(surface_index[k])
            surf[known] = np.array(ids)[inv]
        # Layer class per triangle: 0 ground, 1 static, 2 detail copy (a
        # compound holding the same objects as a lighter one), 3 baked area
        compound = sc["layer"]
        sets = {}
        for c in np.unique(compound[compound > 0]):
            m = compound == c
            sets[int(c)] = (frozenset(np.unique(body[m]).tolist()), int(m.sum()))
        detail = {c for c, (s, n) in sets.items()
                  if any(o != c and so == s and (no < n or (no == n and o < c)) for o, (so, no) in sets.items())}
        layer = np.where(compound == 0, 0, 1)
        if detail:
            layer[np.isin(compound, list(detail))] = 2
        area_body = np.array([is_area_name(object_names.get(h, "")) for h in hashes] + [False], bool)
        layer[(layer > 0) & area_body[body]] = 3   # body -1 indexes the trailing False
        for lay in np.unique(layer):
            layer_tris[int(lay)] = layer_tris.get(int(lay), 0) + int((layer == lay).sum())
        baked.update(hashes[b] for b in np.unique(body[(layer == 1) | (layer == 2)]) if b >= 0)
        # sort by (layer, body) so each body's triangles are contiguous
        order = np.lexsort((body, layer))
        name = banc if key is None else f"{banc}_X{key[0]}_Z{key[1]}"
        fname = f"{name}.tile.bin.gz"
        nv = write_tile(os.path.join(out_dir, fname), tris[order], np.where(body[order] < 0, 0xFFFF, body[order]),
                        surf[order], layer[order], hashes, sc["body_byte"])
        flat = tris.reshape(-1, 3)
        tiles.append({"name": name, "file": fname, "box_min": r4(flat.min(0)), "box_max": r4(flat.max(0)),
                      "triangles": int(len(tris)), "vertices": int(nv),
                      **({"column": key[0], "row": key[1]} if key is not None else {})})
    layers = [{**l, "triangles": layer_tris[l["index"]]} for l in LAYERS if l["index"] in layer_tris]
    manifest = {"format": "romfs-1", "banc": banc, "map_type": area, "tiled": tiled,
                **({"tile_size": TILE, "origin": list(origin)} if tiled else {}),
                "layers": layers, "tiles": tiles}
    return baked, manifest


# ---- Void probe voxels (Phive/VolumeStats) --------------------------------------

def extract_voxels(r, area, banc, path):
    """voxels.bin.gz: the game's 1 m VolumeStats cubes (what the void probe hits), per volume tile.
    Little endian: "OVOX", u32 version 2, u32 entryCount, then per entry:
      u16 variantLength, variant (utf-8; "" = the base tile, else a story state
      such as "RFTomb_Open_True" that replaces the base tile with the same key),
      u16 keyLength, key ("X1_Z2", "" for an untiled map), u32 voxelCount,
      i16 xyz[voxelCount] (world metres, the cube's min corner),
      u8 probe[voxelCount]  faces the void probe can hit (bit 2 * axis + (ray direction > 0)),
      u8 flags[voxelCount]  1 in water, 2 water surface, 4 indoor, 8 hiding hole,
                            16 outside the outer boundary, 32 on ground room area,
      u8 room[voxelCount]   dungeon room id (255: none),
      u8 dist[voxelCount]   outer boundary distance 0-15 (255: none).
    -> voxel count of the base tiles, or None when the map has no volume."""
    d = r.path("Phive", "VolumeStats", area)
    if not os.path.isdir(d):
        return None
    pat = re.compile(re.escape(banc) + r"(?:_(X\d+_Z\d+))?(?:_presence_(.+))?\.bpvsts\.zs$")
    entries = []
    for f in sorted(os.listdir(d)):
        m = pat.match(f)
        if not m:
            continue
        raw = r.decompress(open(os.path.join(d, f), "rb").read())
        tile = volumestats.VolumeTile(raw)
        v = volumestats.world_voxels(tile)
        attrs = volumestats.voxel_attributes(tile, raw)
        entries.append((m.group(2) or "", m.group(1) or "", v, attrs))
    if not entries:
        return None
    out = bytearray(b"OVOX" + struct.pack("<II", 2, len(entries)))
    for variant, key, v, attrs in entries:
        for s in (variant, key):
            e = s.encode()
            out += struct.pack("<H", len(e)) + e
        out += struct.pack("<I", len(v)) + v.astype("<i2").tobytes()
        for k in ("probe", "flags", "room", "dist"):
            out += attrs[k].astype(np.uint8).tobytes()
    with gzip.open(path, "wb", compresslevel=6) as f:
        f.write(out)
    return sum(len(v) for variant, _, v, _ in entries if not variant)


# ---- Main ---------------------------------------------------------------------

def humanize(area, banc):
    rest = banc[len(area):].lstrip("_") if banc.startswith(area) else banc
    words = re.sub(r"(?<=[a-z])(?=[A-Z])", " ", area)
    return f"{words} ({rest.replace('_', ' ')})" if rest else words


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("romfs", help="the game's romfs folder (with Banc, Phive, Pack...)")
    ap.add_argument("--only", nargs="*", help="banc name(s) to extract (default: all)")
    ap.add_argument("--out", help="output folder instead of models/OOTSW2 (the map list is then not written)")
    ap.add_argument("--voxels-only", action="store_true", help="only (re)write each map's voxels.bin.gz")
    args = ap.parse_args()
    global OUT
    if args.out:
        OUT = os.path.abspath(args.out)

    r = RomFS(args.romfs)
    t0 = time.time()
    actor_info = {}
    for f in os.listdir(r.path("RSDB")):
        if f.startswith("ActorInfo.Product"):
            actor_info = {row.get("__RowId"): row for row in byml(r.read("RSDB", f))}
    names = SurfaceNames(r)
    shapes = ActorShapes(r)
    english = english_names(r)
    zones = ZoneLogic(r)
    print(f"{len(english)} English actor names", flush=True)
    previous = old_map_list()
    airwalls = {}
    if os.path.exists(os.path.join(OUT, "airwalls.json")):
        airwalls = json.load(open(os.path.join(OUT, "airwalls.json")))
    entries = []

    for area, banc in find_maps(r):
        d = os.path.join(OUT, area, banc)
        dir_key = f"{area}/{banc}"
        files = compound_files(r, area, banc)
        if args.only and banc not in args.only:
            if os.path.exists(os.path.join(d, "objects.json")):
                entries.append((area, banc, previous.get(dir_key), None, os.path.exists(os.path.join(d, "collision.bin")),
                                None not in files))
            continue
        os.makedirs(d, exist_ok=True)
        voxel_count = extract_voxels(r, area, banc, os.path.join(d, "voxels.bin.gz"))
        if args.voxels_only:
            print(f"{dir_key}: {voxel_count} voxels", flush=True)
            continue
        obj_path = os.path.join(d, "objects.json")
        old = {o["h"]: o for o in json.load(open(obj_path))} if os.path.exists(obj_path) else {}
        objects = load_objects(r, area, banc, actor_info, old, english, zones)
        if not objects and not files:
            continue
        with open(obj_path, "w", newline="\n") as f:
            f.write("[\n" + ",\n".join(json.dumps(o, separators=(",", ":")) for o in objects) + "\n]\n")

        surfaces, surface_index = [], {}
        object_names = {int(o["h"], 16): o["n"] for o in objects}
        baked, manifest = extract_compound(r, files, area, banc, os.path.join(d, "compound"), names, surfaces,
                                           surface_index, object_names)
        if manifest:
            manifest["surfaces"] = surfaces
            with open(os.path.join(d, "compound", "manifest.json"), "w", newline="\n") as f:
                json.dump(manifest, f, separators=(",", ":"))

        map_shapes = {}
        for name in sorted({o["n"] for o in objects}):
            s = shapes.get(name)
            if s:
                map_shapes[name] = s
                if AIRWALL.search(name) and len(s["tris"]):
                    verts, inv = np.unique(s["tris"].reshape(-1, 3), axis=0, return_inverse=True)
                    airwalls[name] = {"v": [round(float(x), 4) for x in verts.reshape(-1)], "i": inv.reshape(-1).tolist()}
        write_ocol(os.path.join(d, "collision.bin"), map_shapes, baked)

        tris = sum(t["triangles"] for t in manifest["tiles"]) if manifest else 0
        print(f"{dir_key}: {len(objects)} objects, {len(map_shapes)} actor shapes, "
              f"{len(manifest['tiles']) if manifest else 0} tiles / {tris} triangles, "
              f"{len(baked)} baked objects, {voxel_count or 0} voxels ({time.time() - t0:.0f} s)", flush=True)
        xs = [o["p"][0] for o in objects] or [0]
        zs = [o["p"][2] for o in objects] or [0]
        entries.append((area, banc, previous.get(dir_key), [min(xs), max(xs), min(zs), max(zs)], True,
                        bool(manifest and manifest["tiled"])))

    if args.voxels_only:
        print(f"done in {time.time() - t0:.0f} s")
        return
    with open(os.path.join(OUT, "airwalls.json"), "w", newline="\n") as f:
        json.dump(dict(sorted(airwalls.items())), f, separators=(",", ":"))
    if args.out:
        print(f"done in {time.time() - t0:.0f} s (map list not written with --out)")
        return

    # js/ootsw2_map_list.js: keep the existing names / groups / bounds
    lines = []
    for area, banc, prev, bounds, has_col, tiled in entries:
        age = "Adult" if "_Adult" in banc else "Child" if "_Child" in banc else None
        e = {"name": prev["name"] if prev else humanize(area, banc),
             "group": prev["group"] if prev else "Field" if tiled else "Dungeons",
             "dir": f"{area}/{banc}", "collision": has_col,
             "age": prev["age"] if prev else age,
             "bounds": prev["bounds"] if prev else [round(b, 2) for b in (bounds or [0, 0, 0, 0])]}
        lines.append("    " + json.dumps(e, separators=(", ", ": ")) + ",")
    order = ["Field", "Dungeons", "Other"]
    lines.sort(key=lambda l: (order.index(json.loads(l.strip().rstrip(","))["group"])
                              if json.loads(l.strip().rstrip(","))["group"] in order else 9))
    with open(os.path.join(ROOT, "js", "ootsw2_map_list.js"), "w", newline="\n") as f:
        f.write("// Ocarina of Time (Switch 2) maps, written by tools/ootsw2/extract_romfs.py from a\n"
                "// romfs dump. Each dir is models/OOTSW2/<area>/<banc>/.\n"
                "const OOTSW2_Maps = [\n" + "\n".join(lines) + "\n];\n")
    print(f"js/ootsw2_map_list.js: {len(entries)} maps; done in {time.time() - t0:.0f} s")


if __name__ == "__main__":
    sys.exit(main())
