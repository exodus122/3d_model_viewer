#!/usr/bin/env python3
"""
Extract Donkey Kong 64 (US) map assets for the viewer.

usage: extract_dk64_maps.py [path/to/dk64]   (default: ../dk64 next to this repo)

Reads <dk64>/baserom.us.z64 and the map names from <dk64>/include/enums.h
(the decomp's map_e), and writes:

  models/DK64/<NNN>_<NAME>/geometry.bin   pointer table 1, decompressed
  models/DK64/<NNN>_<NAME>/floors.bin     pointer table 3
  models/DK64/<NNN>_<NAME>/walls.bin      pointer table 2
  models/DK64/<NNN>_<NAME>/setup.bin      pointer table 9, decompressed
  models/DK64/textures/<ID>.bin           pointer table 25 entries the map
                                          display lists use (G_SETTIMG
                                          segment 0), decompressed
  models/DK64/textures/T7_<ID>.bin        pointer table 7 entries: animated
                                          texture frames (header +0x48) and,
                                          with a few table 25 ones, the water
                                          textures (WATER_TEXTURES)
  js/dk64_map_list.js                     DK64_Maps

ROM layout (global_asm/code_6AF80.c): the pointer tables live at romAssetBin
(0x101C50). Its first 32 words are each table's offset from romAssetBin; a
table is an array of offsets (relative to romAssetBin again) whose size is
entry[i + 1] - entry[i]. An entry with the top bit set is a redirect: the
first halfword at its offset is the file index to use instead. Compressed
files are gzip streams.

Formats (see js/dk64_map.js for the reader):
  geometry  header +0x00 walls size, +0x04 floors size, +0x10/+0x12 collision
            grid cells x/z, +0x34..+0x38 F3DEX2 display lists (segment 7),
            +0x38..+0x40 Vtx[] (segment 6), +0x48 animated textures, +0x4C
            water surfaces, +0x68 chunk table (0x34 bytes each: four display
            list (offset, size) pairs and the chunk's vertex range; see
            js/dk64_map.js for how G_VTX addresses resolve into it). Maps
            with chunks are stored in world * 3, the rest in world units.
  floors /  u32 total triangle count, then one block per collision grid cell:
  walls     u32 end offset, 0x18-byte triangles up to it (a triangle is stored
            in every cell it touches). Floor triangles are s16 x[3], y[3],
            z[3] in world * 6, walls s16 (x, y, z)[3] in world units.
"""

import gzip
import hashlib
import json
import os
import re
import struct
import sys
import zlib

ROOT = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))
BASEROM_SHA1 = "cf806ff2603640a748fca5026ded28802f1f4a50"
ROM_ASSET_BIN = 0x101C50

TABLE_MAP_GEOMETRY = 1
TABLE_MAP_WALLS = 2
TABLE_MAP_FLOORS = 3
TABLE_TEXTURES_UNCOMPRESSED = 7
TABLE_SETUP = 9
TABLE_TEXTURES_GEOMETRY = 25

G_SETTIMG = 0xFD


class Rom:
    def __init__(self, data):
        self.data = data
        self.tables = {}

    def u32(self, offset):
        return struct.unpack_from(">I", self.data, offset)[0]

    def table(self, index):
        if index not in self.tables:
            offset = self.u32(ROM_ASSET_BIN + 4 * index)
            count = ((self.u32(ROM_ASSET_BIN + offset) & 0x7FFFFFFF) - offset) // 4
            self.tables[index] = [self.u32(ROM_ASSET_BIN + offset + 4 * i) for i in range(count)]
        return self.tables[index]

    def count(self, index):
        return len(self.table(index)) - 1

    def raw(self, index, file):
        entries = self.table(index)
        entry = entries[file]
        if entry & 0x80000000:
            redirect = struct.unpack_from(">H", self.data, ROM_ASSET_BIN + (entry & 0x7FFFFFFF))[0]
            return self.raw(index, redirect)
        start = entry & 0x7FFFFFFF
        end = entries[file + 1] & 0x7FFFFFFF
        return self.data[ROM_ASSET_BIN + start:ROM_ASSET_BIN + end]

    def file(self, index, file):
        data = self.raw(index, file)
        if data[:2] == b"\x1f\x8b":
            return zlib.decompressobj(16 + zlib.MAX_WBITS).decompress(data)
        return data


def map_names(enums_h):
    text = open(enums_h, encoding="utf-8").read()
    body = re.search(r"typedef enum map_e \{(.*?)\} Maps;", text, re.S).group(1)
    return [n.strip() for n in body.split(",") if n.strip()]


def geometry_textures(geometry):
    """Table 25 ids of every G_SETTIMG (segment 0) in the map's display lists."""
    dl_start, dl_end = struct.unpack_from(">II", geometry, 0x34)
    ids = set()
    for offset in range(dl_start, dl_end, 8):
        if geometry[offset] == G_SETTIMG:
            w1 = struct.unpack_from(">I", geometry, offset + 4)[0]
            if w1 >> 24 == 0:
                ids.add(w1)
    return ids


ANIMATED_TEXTURE_SIZE = 0x7C


def animated_textures(geometry):
    """Table 7 frame ids of the map's animated textures (header +0x48: u32
    count, 0x7C-byte entries of u8 segment, u8 chunk, u8 frame delay, u8 frame
    count, ..., u32 frame ids from +0xC; global_asm func_8062EE48), which the
    display lists draw through segments 0x0B..0x0E."""
    table = struct.unpack_from(">I", geometry, 0x48)[0]
    ids = set()
    for i in range(struct.unpack_from(">I", geometry, table)[0]):
        entry = table + 4 + i * ANIMATED_TEXTURE_SIZE
        frames = geometry[entry + 3]
        ids.update(struct.unpack_from(">%dI" % frames, geometry, entry + 0xC))
    return ids


# Water surface textures by type (header +0x4C records, byte +0x66; the
# D_80748A90 table's init functions in global_asm/code_63EC0.c):
# (pointer table, file id)
WATER_TEXTURES = [(7, 0x3C5), (25, 0x2EE), (25, 0x2EF), (25, 0xF0), (25, 0x75C),
                  (7, 0x3B9), (7, 0x3D2), (7, 0x3BA), (25, 0xAF4)]


def texture_file(table, tex_id):
    return f"{tex_id:04X}.bin" if table == TABLE_TEXTURES_GEOMETRY else f"T{table}_{tex_id:04X}.bin"


def collision_points(data, floor):
    """Every distinct triangle corner of a floors.bin / walls.bin, in world units * 6."""
    points = set()
    pos = 4
    while pos < len(data):
        end = struct.unpack_from(">I", data, pos)[0]
        for o in range(pos + 4, end, 0x18):
            v = struct.unpack_from(">9h", data, o)
            if floor:
                points.update((v[i], v[3 + i], v[6 + i]) for i in range(3))
            else:
                points.update((v[3 * i] * 6, v[3 * i + 1] * 6, v[3 * i + 2] * 6) for i in range(3))
        pos = end
    return points


def chunk_count(geometry):
    """Chunks in the map (count at the start of the header +0x64 table)."""
    return struct.unpack_from(">I", geometry, struct.unpack_from(">I", geometry, 0x64)[0])[0]


def geometry_scale(geometry):
    """Map units per world unit: maps split into chunks are stored * 3, the
    rest (some arenas, minigames, barrel blasts) * 1."""
    return 3 if chunk_count(geometry) else 1


def measured_scale(geometry, floors, walls):
    """geometry_scale, measured: counts the collision corners that land exactly
    on a display-list vertex at each scale, falling back to comparing the two
    extents when they share no corners. Agrees with geometry_scale on all 216
    US maps; kept as a check."""
    vtx_start, vtx_end = struct.unpack_from(">I", geometry, 0x38)[0], struct.unpack_from(">I", geometry, 0x40)[0]
    verts = {struct.unpack_from(">3h", geometry, o) for o in range(vtx_start, vtx_end, 16)}
    points = collision_points(floors, True) | collision_points(walls, False)
    scores = {}
    for k in (1, 3):
        scores[k] = sum(1 for x, y, z in points
                        if (x * k) % 6 == 0 and (y * k) % 6 == 0 and (z * k) % 6 == 0
                        and (x * k // 6, y * k // 6, z * k // 6) in verts)
    best = max(scores, key=scores.get)
    if scores[best] > 0 and scores[best] > 4 * min(scores.values()):
        return best, "matched"
    def span(values):
        # middle 98%: a few slots in the vertex block are padding at +-0x8000
        values = sorted(values)
        return values[len(values) * 99 // 100] - values[len(values) // 100]
    geo = span(v[0] for v in verts) + span(v[2] for v in verts)
    world = (span(p[0] for p in points) + span(p[2] for p in points)) / 6
    ratio = geo / max(1, world)
    return (3 if ratio > 1.7 else 1), "extent %.2f" % ratio


def write(path, data):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    with open(path, "wb") as f:
        f.write(data)


def main():
    dk64 = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, "..", "dk64")
    rom_path = os.path.join(dk64, "baserom.us.z64")
    data = open(rom_path, "rb").read()
    sha1 = hashlib.sha1(data).hexdigest()
    if sha1 != BASEROM_SHA1:
        sys.exit(f"{rom_path}: sha1 {sha1}, expected the US ROM {BASEROM_SHA1}")
    rom = Rom(data)
    names = map_names(os.path.join(dk64, "include", "enums.h"))

    out_dir = os.path.join(ROOT, "models", "DK64")
    maps = []
    textures = set()
    for map_id, enum_name in enumerate(names):
        name = enum_name[len("MAP_"):]
        geometry = rom.file(TABLE_MAP_GEOMETRY, map_id)
        if len(geometry) < 0x50:
            print(f"{map_id:3d} {name}: no map geometry, skipped")
            continue
        walls = rom.file(TABLE_MAP_WALLS, map_id)
        floors = rom.file(TABLE_MAP_FLOORS, map_id)
        setup = rom.file(TABLE_SETUP, map_id)
        walls_size, floors_size = struct.unpack_from(">II", geometry, 0)
        if (walls_size, floors_size) != (len(walls), len(floors)):
            print(f"{map_id:3d} {name}: header sizes {walls_size:#x}/{floors_size:#x} "
                  f"!= walls {len(walls):#x} / floors {len(floors):#x}")

        dir_name = f"{map_id:03X}_{name}"
        write(os.path.join(out_dir, dir_name, "geometry.bin"), geometry)
        write(os.path.join(out_dir, dir_name, "floors.bin"), floors)
        write(os.path.join(out_dir, dir_name, "walls.bin"), walls)
        write(os.path.join(out_dir, dir_name, "setup.bin"), setup)
        textures |= {(TABLE_TEXTURES_GEOMETRY, t) for t in geometry_textures(geometry)}
        textures |= {(TABLE_TEXTURES_UNCOMPRESSED, t) for t in animated_textures(geometry)}
        scale = geometry_scale(geometry)
        measured, how = measured_scale(geometry, floors, walls)
        if measured != scale:
            print(f"{map_id:3d} {name}: {chunk_count(geometry)} chunks but the collision "
                  f"measures scale {measured} ({how})")
        maps.append({"name": name, "mapID": map_id, "dir": dir_name, "scale": scale})
        print(f"{map_id:3d} {name}: geometry {len(geometry):#x}, floors {len(floors):#x}, "
              f"walls {len(walls):#x}, setup {len(setup):#x}, scale {scale}")

    textures |= set(WATER_TEXTURES)
    tex_bytes = 0
    for table, tex_id in sorted(textures):
        tex = rom.file(table, tex_id)
        tex_bytes += len(tex)
        write(os.path.join(out_dir, "textures", texture_file(table, tex_id)), tex)
    print(f"{len(maps)} maps, {len(textures)} textures ({tex_bytes} bytes)")

    lines = [
        "// Generated by tools/dk64/extract_dk64_maps.py from the dk64 decomp's baserom.us.z64.",
        "// Each map lives in models/DK64/<dir>/: geometry.bin (display lists + vertices),",
        "// floors.bin / walls.bin (collision), setup.bin; textures in models/DK64/textures/.",
        "// scale: geometry.bin units per world unit (3, or 1 for some arenas and minigames).",
        "const DK64_Maps = [",
    ]
    lines += ['    { name: "%s", mapID: %d, dir: "%s", scale: %d },' % (m["name"], m["mapID"], m["dir"], m["scale"])
              for m in maps]
    lines.append("];")
    with open(os.path.join(ROOT, "js", "dk64_map_list.js"), "w", newline="\n") as f:
        f.write("\n".join(lines) + "\n")


if __name__ == "__main__":
    main()
