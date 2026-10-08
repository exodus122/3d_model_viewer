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


# --- objects -----------------------------------------------------------------
#
# setup.bin (pointer table 9, global_asm/code_36880.c SetupFile): u32 count +
# 0x30-byte props (model2: f32 x, y, z, scale, ..., f32 rotation x, y, z at
# +0x18, s16 type at +0x28 = pointer table 4 file, s16 id), u32 count + 0x24-byte
# "mystery" entries, u32 count + 0x38-byte actor spawners (f32 x, y, z, scale,
# ..., s16 y rotation at +0x30, s16 type at +0x32 = actor - 0x10, s16 id).
# spawners.bin (pointer table 16, enemies; func_80728300): u16 fence count,
# fences (u16 n + n * 6 bytes, u16 n + n * 10 bytes, 4 bytes), u16 spawner
# count, 0x16-byte spawners (SpawnerFileData) each followed by byte +0x11 * 2
# bytes.
# An actor's model is a pointer table 5 file (model index - 1): for setup
# actors from D_8074E8B0 (0x30 bytes: u16 actor, u16 model), for enemies from
# D_8075EB80 indexed by the spawner's enemy type (0x18 bytes: u16 actor, u16
# model), both in global_asm's compressed .data.

TABLE_PROP_GEOMETRY = 4
TABLE_ACTOR_GEOMETRY = 5
TABLE_SPAWNERS = 16

GLOBAL_ASM_CODE_ROM = 0x113F0
GLOBAL_ASM_DATA_ROM = 0xC29D4
GLOBAL_ASM_VRAM = 0x805FB300
SETUP_ACTOR_MODELS = 0x8074E8B0       # 0x80 entries of 0x30 bytes
ENEMY_TYPES = 0x8075EB80              # entries of 0x18 bytes
ENEMY_TYPE_COUNT = 0x60


def global_asm_data(rom_data):
    """global_asm's .data, decompressed, and its vram start (right after .text)."""
    code = zlib.decompressobj(16 + zlib.MAX_WBITS).decompress(rom_data[GLOBAL_ASM_CODE_ROM:])
    data = zlib.decompressobj(16 + zlib.MAX_WBITS).decompress(rom_data[GLOBAL_ASM_DATA_ROM:])
    return data, GLOBAL_ASM_VRAM + len(code)


def actor_model_tables(rom_data):
    data, vram = global_asm_data(rom_data)
    setup_models = {}
    for i in range(0x80):
        actor, model = struct.unpack_from(">hh", data, SETUP_ACTOR_MODELS - vram + 0x30 * i)
        if actor > 0 and model > 0:
            setup_models.setdefault(actor, model)
    enemies = [struct.unpack_from(">HH", data, ENEMY_TYPES - vram + 0x18 * i) for i in range(ENEMY_TYPE_COUNT)]
    return setup_models, enemies


def actor_names(enums_h):
    text = open(enums_h, encoding="utf-8").read()
    body = re.search(r"typedef enum actors_e \{(.*?)\}", text, re.S).group(1)
    names = [re.sub(r"//.*", "", line).strip().rstrip(",") for line in body.split("\n")]
    return [n[len("ACTOR_"):] if n.startswith("ACTOR_") else n for n in names if n]


def setup_objects(setup):
    """(prop types, actor types) placed by a setup.bin."""
    if len(setup) < 4:
        return [], []
    u32 = lambda o: struct.unpack_from(">I", setup, o)[0]
    props = [struct.unpack_from(">h", setup, 4 + 0x30 * i + 0x28)[0] for i in range(u32(0))]
    o = 4 + 0x30 * len(props)
    o += 4 + 0x24 * u32(o)
    actors = [struct.unpack_from(">h", setup, o + 4 + 0x38 * i + 0x32)[0] + 0x10 for i in range(u32(o))]
    return props, actors


def spawner_enemy_types(spawners):
    """Enemy types placed by a spawners.bin (checked to parse to its end on all US maps)."""
    if len(spawners) < 2:
        return []
    u16 = lambda o: struct.unpack_from(">H", spawners, o)[0]
    o = 2
    for _ in range(u16(0)):
        o += 2 + 6 * u16(o)
        o += 2 + 10 * u16(o)
        o += 4
    count = u16(o) if o + 2 <= len(spawners) else 0
    o += 2
    types = []
    for _ in range(count):
        types.append(spawners[o])
        o += 0x16 + 2 * spawners[o + 0x11]
    return types


SPRITE_QUAD_SIZE = 0x30
SPRITE_ANIMATION_SIZE = 0x84
SPRITE_ANIMATION_MAX_FRAMES = (SPRITE_ANIMATION_SIZE - 16) // 4 + 1   # first frame + 29 slots


def prop_sprite_quads(rom, model):
    """The quads of a sprite-drawn prop (+0x1C == 2): header +0x70 points at a
    u32 count of 0x30-byte quads: u16 texture, u16 palette (0xFFFF none),
    s16 x[4], y[4], z[4], (s, t)[4] (10.5 texels), u8 width, u8 height, u8
    siz, u8 fmt. t = 0 is the bottom edge (y = 0, the prop's position): the
    textures are stored bottom row first. A texture id is in pointer table 7
    or 25, whichever file is width * height * size long (crates are in 7,
    trees and plants in 25). Returns [(quad dict, table)], drawn with the
    first frame of the prop's animation."""
    if len(model) < 0x74 or model[0x1C] != 2:
        return []
    table = struct.unpack_from(">I", model, 0x70)[0]
    if table + 4 > len(model):
        return []
    # +0x60: the animation, one layer per quad keyed by its texture (prop_animations)
    animations = prop_animations(model)
    quads = []
    for i in range(struct.unpack_from(">I", model, table)[0]):
        o = table + 4 + i * SPRITE_QUAD_SIZE
        if o + SPRITE_QUAD_SIZE > len(model):
            break
        tex, pal = struct.unpack_from(">HH", model, o)
        v = struct.unpack_from(">12h", model, o + 4)
        st = struct.unpack_from(">8h", model, o + 0x1C)
        width, height, siz, fmt = model[o + 0x2C:o + 0x30]
        size = width * height * (4 << siz) // 8
        source = None
        for t in (TABLE_TEXTURES_UNCOMPRESSED, TABLE_TEXTURES_GEOMETRY):
            if tex < rom.count(t) and len(rom.file(t, tex)) == size:
                source = t
                break
        if source is None:
            print(f"  sprite texture {tex:#x} ({width}x{height} siz {siz}) not found")
            continue
        delay, frames = animations.get(tex, (0, (tex,)))
        frames = [f for f in frames if f < rom.count(source) and len(rom.file(source, f)) == size]
        quads.append(({
            "tex": tex, "pal": None if pal == 0xFFFF else pal, "table": source,
            "frames": frames, "delay": delay,
            "x": v[0:4], "y": v[4:8], "z": v[8:12], "s": st[0::2], "t": st[1::2],
            "width": width, "height": height, "siz": siz, "fmt": fmt,
        }, source))
    return quads


def model_dl_textures(data, dl_start, dl_end):
    ids = set()
    for offset in range(dl_start, min(dl_end, len(data) - 7), 8):
        if data[offset] == G_SETTIMG:
            w1 = struct.unpack_from(">I", data, offset + 4)[0]
            if w1 >> 24 == 0:
                ids.add(w1)
    return ids


def prop_animations(model):
    """A prop model's animated textures (header +0x60: u32 count, 0x84-byte
    layers of u32 first frame, mode, delay, frame count, other frames): its
    display lists' G_SETTIMG of a first frame's id draws these pointer table 7
    frames instead of a table 25 texture (func_80636EFC / func_80639CD0).
    Sprite props use the same table for their quads' animation.
    -> {first frame: (delay, [frames])}"""
    out = {}
    if len(model) < 0x64:
        return out
    table = struct.unpack_from(">I", model, 0x60)[0]
    if table + 4 > len(model):
        return out
    # Many models' +0x60 doesn't point at a real table, so the counts can be
    # garbage (hundreds of millions): bound both by what the file can hold.
    layers = min(struct.unpack_from(">I", model, table)[0], (len(model) - table - 4) // SPRITE_ANIMATION_SIZE)
    for i in range(layers):
        o = table + 4 + SPRITE_ANIMATION_SIZE * i
        first, _, delay, count = struct.unpack_from(">4I", model, o)
        if not 1 <= count <= SPRITE_ANIMATION_MAX_FRAMES:
            continue
        out[first] = (delay, [first] + list(struct.unpack_from(">%dI" % (count - 1), model, o + 16)))
    return out


def prop_textures(model):
    """(table, id) textures of a pointer table 4 model (display lists
    +0x40..+0x44..+0x48): table 25, or table 7 for its animated ones."""
    if len(model) < 0x50 or model[0x1C] != 1:
        return set()
    start, _, end = struct.unpack_from(">III", model, 0x40)
    animations = prop_animations(model)
    out = set()
    for tex in model_dl_textures(model, start, end):
        if tex in animations:
            out.update((TABLE_TEXTURES_UNCOMPRESSED, f) for f in animations[tex][1])
        else:
            out.add((TABLE_TEXTURES_GEOMETRY, tex))
    return out


def actor_textures(model):
    """Table 25 textures of a pointer table 5 model: its display list runs from
    the first pointer of the +0x04 array to the array itself; addresses are
    relative to +0x00, which is file offset 0x28 (func_80612E90)."""
    if len(model) < 0x28:
        return set()
    base, table = struct.unpack_from(">II", model, 0)
    table = table - base + 0x28
    start = struct.unpack_from(">I", model, table)[0] - base + 0x28
    ids = model_dl_textures(model, start, table)
    # +0x10: animated textures (u16 count; u16 frames, u16 segment, u16, u16 ids[frames])
    ptr = struct.unpack_from(">I", model, 0x10)[0]
    if ptr:
        o = ptr - base + 0x28
        if 0x28 <= o and o + 2 <= len(model):
            count = struct.unpack_from(">H", model, o)[0]
            o += 2
            for _ in range(count):
                if o + 6 > len(model):
                    break
                frames = struct.unpack_from(">H", model, o)[0]
                ids.update(struct.unpack_from(">%dH" % frames, model, o + 6)[:frames] if o + 6 + 2 * frames <= len(model) else ())
                o += 6 + 2 * frames
    return ids


# --- map order ---------------------------------------------------------------
#
# DK64_Maps lists the Isles first, then each level in game order (its main map
# first, then the rest by map id), then K. Rool, the shops, the bonus barrel
# minigames, the arenas, and cutscenes / menus / everything else.

LEVELS = [
    ("Jungle Japes", "JAPES"), ("Angry Aztec", "AZTEC"), ("Frantic Factory", "FACTORY"),
    ("Gloomy Galleon", "GALLEON"), ("Fungi Forest", "FUNGI"), ("Crystal Caves", "CAVES"),
    ("Creepy Castle", "CASTLE"), ("Hideout Helm", "HELM"),
]
ISLES_FIRST = ["DK_ISLES_OVERWORLD", "TRAINING_GROUNDS", "DK_HOUSE", "DK_ISLES_SNIDES_ROOM", "FAIRY_ISLAND",
               "KLUMSY", "TROFF_N_SCOFF", "DIVE_BARREL", "ORANGE_BARREL", "BARREL_BARREL", "VINE_BARREL"] + \
              [prefix + "_LOBBY" for _, prefix in LEVELS]
CUTSCENES_AND_OTHER = ["NINTENDO_LOGO", "DK_RAP", "TITLE_SCREEN_NOT_FOR_RESALE_VERSION", "MAIN_MENU",
                       "ROCK_INTRO_STORY", "HELM_INTRO_STORY", "HELM_LEVEL_INTROS_GAME_OVER", "DK_ISLES_DK_THEATRE",
                       "TRAINING_GROUNDS_END_SEQUENCE", "KLUMSY_ENDING", "BLOOPERS_ENDING",
                       "DK_ARCADE", "JETPAC", "TEST_MAP"]
SHOPS = ["CRANKYS_LAB", "FUNKYS_STORE", "CANDYS_MUSIC_SHOP", "SNIDES_HQ"]
MINIGAMES = ["KREMLING_KOSH", "STEALTHY_SNOOP", "TEETERING_TURTLE_TROUBLE", "MAD_MAZE_MAUL", "STASH_SNATCH",
             "MINECART_MAYHEM", "BUSY_BARREL_BARRAGE", "BATTY_BARREL_BANDIT", "SPLISH_SPLASH_SALVAGE",
             "SPEEDY_SWING_SORTIE", "KRAZY_KONG_KLAMOUR", "BIG_BUG_BASH", "SEARCHLIGHT_SEEK", "BEAVER_BOTHER",
             "PERIL_PATH_PANIC"]
DIFFICULTIES = ["VERY_EASY", "EASY", "EASY_2", "NORMAL", "NORMAL_NO_LOGO", "HARD", "INSANE"]


def map_group(name):
    """(group label, group rank, rank within the group) for a map."""
    groups = ["DK Isles"] + [label for label, _ in LEVELS] + \
             ["K. Rool", "Shops", "Bonus Minigames", "Arenas", "Cutscenes & Other"]
    rank = groups.index
    if name in ISLES_FIRST:
        return "DK Isles", rank("DK Isles"), ISLES_FIRST.index(name)
    if name in CUTSCENES_AND_OTHER:
        return "Cutscenes & Other", rank("Cutscenes & Other"), CUTSCENES_AND_OTHER.index(name)
    if name in SHOPS:
        return "Shops", rank("Shops"), SHOPS.index(name)
    if name.startswith("KROOL_FIGHT") or name.startswith("KROOLS_"):
        return "K. Rool", rank("K. Rool"), 0
    if name.startswith("KROOL_BARREL"):   # Hideout Helm's barrel minigames
        return "Hideout Helm", rank("Hideout Helm"), 1
    for label, prefix in LEVELS:
        if name == prefix:
            return label, rank(label), 0
        if name.startswith(prefix + "_"):
            return label, rank(label), 1
    for i, game in enumerate(MINIGAMES):
        if name.startswith(game):
            rest = name[len(game) + 1:]
            return "Bonus Minigames", rank("Bonus Minigames"), \
                i * 10 + (DIFFICULTIES.index(rest) if rest in DIFFICULTIES else 9)
    if name.startswith("BATTLE_ARENA") or name.startswith("KONG_BATTLE") or name.endswith("_ARENA"):
        return "Arenas", rank("Arenas"), 0
    return "Cutscenes & Other", rank("Cutscenes & Other"), 99


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
    setup_models, enemy_types = actor_model_tables(data)
    prop_types = set()
    actor_models = set()
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
        spawners = rom.file(TABLE_SPAWNERS, map_id)
        write(os.path.join(out_dir, dir_name, "spawners.bin"), spawners)
        props, actors = setup_objects(setup)
        prop_types.update(props)
        actor_models.update(setup_models[a] for a in actors if a in setup_models)
        actor_models.update(enemy_types[e][1] for e in spawner_enemy_types(spawners)
                            if e < len(enemy_types) and enemy_types[e][1])
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

    prop_info = {}
    prop_sprites = {}
    for prop in sorted(t for t in prop_types if 0 <= t < rom.count(TABLE_PROP_GEOMETRY)):
        model = rom.file(TABLE_PROP_GEOMETRY, prop)
        if len(model) < 0x50:
            continue
        category = model[0x0C:0x14].split(b"\0")[0].decode("ascii", "replace")
        prop_info[prop] = (model[0x1C], category)
        write(os.path.join(out_dir, "props", f"{prop:04X}.bin"), model)
        textures |= prop_textures(model)
        quads = prop_sprite_quads(rom, model)
        if quads:
            prop_sprites[prop] = [q for q, _ in quads]
            for q, table in quads:
                textures.add((table, q["tex"]))
                textures.update((table, f) for f in q["frames"])
                if q["pal"] is not None:
                    textures.add((table, q["pal"]))
    for model_index in sorted(m for m in actor_models if 0 < m <= rom.count(TABLE_ACTOR_GEOMETRY)):
        model = rom.file(TABLE_ACTOR_GEOMETRY, model_index - 1)
        write(os.path.join(out_dir, "actors", f"{model_index:04X}.bin"), model)
        textures |= {(TABLE_TEXTURES_GEOMETRY, t) for t in actor_textures(model)}
    print(f"{len(prop_info)} prop models, {len(actor_models)} actor models")

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
        "// group: the dropdown section; listed in map_group's order.",
        "const DK64_Maps = [",
    ]
    def sort_key(m):
        _, group_rank, rank = map_group(m["name"])
        return group_rank, rank, m["mapID"]
    lines += ['    { name: "%s", mapID: %d, dir: "%s", scale: %d, group: "%s" },' % (
        m["name"], m["mapID"], m["dir"], m["scale"], map_group(m["name"])[0]) for m in sorted(maps, key=sort_key)]
    lines.append("];")
    with open(os.path.join(ROOT, "js", "dk64_map_list.js"), "w", newline="\n") as f:
        f.write("\n".join(lines) + "\n")

    names = actor_names(os.path.join(dk64, "include", "enums.h"))
    lines = [
        "// Generated by tools/dk64/extract_dk64_maps.py.",
        "// DK64_Actor_Names: the decomp's actors_e. DK64_Setup_Actor_Models: actor -> model",
        "// (models/DK64/actors/<model>.bin) for setup.bin actors (global_asm D_8074E8B0).",
        "// DK64_Enemy_Types: spawners.bin enemy type -> [actor, model] (D_8075EB80).",
        "// DK64_Prop_Info: prop type (models/DK64/props/<type>.bin) -> [kind, category];",
        "// kind 1 = a model, 2 = a sprite-drawn pickup.",
        "const DK64_Actor_Names = [",
    ]
    lines += ['    "%s",' % n for n in names]
    lines.append("];")
    lines.append("const DK64_Setup_Actor_Models = {")
    lines += ["    %d: %d," % (a, m) for a, m in sorted(setup_models.items())]
    lines.append("};")
    lines.append("const DK64_Enemy_Types = [")
    lines += ["    [%d, %d]," % e for e in enemy_types]
    lines.append("];")
    lines.append("const DK64_Prop_Info = {")
    lines += ['    %d: [%d, "%s"],' % (p, k, c) for p, (k, c) in sorted(prop_info.items())]
    lines.append("};")
    lines.append("// DK64_Prop_Sprites: kind 2 props -> quads (prop_sprite_quads): texture file")
    lines.append("// (models/DK64/textures/), palette file or null, animation frames (texture files,")
    lines.append("// empty if static) shown for `delay` 30 Hz ticks each, corners x / y / z, texel s / t,")
    lines.append("// texture width, height, siz, fmt.")
    lines.append("const DK64_Prop_Sprites = {")
    for p, quads in sorted(prop_sprites.items()):
        parts = []
        for q in quads:
            pal = '"%s"' % texture_file(q["table"], q["pal"])[:-4] if q["pal"] is not None else "null"
            frames = ", ".join('"%s"' % texture_file(q["table"], f)[:-4] for f in q["frames"]) if len(q["frames"]) > 1 else ""
            parts.append('{ tex: "%s", pal: %s, frames: [%s], delay: %d, x: [%s], y: [%s], z: [%s], s: [%s], t: [%s], w: %d, h: %d, siz: %d, fmt: %d }' % (
                texture_file(q["table"], q["tex"])[:-4], pal, frames, q["delay"],
                ", ".join(map(str, q["x"])), ", ".join(map(str, q["y"])), ", ".join(map(str, q["z"])),
                ", ".join(map(str, q["s"])), ", ".join(map(str, q["t"])),
                q["width"], q["height"], q["siz"], q["fmt"]))
        lines.append("    %d: [%s]," % (p, ", ".join(parts)))
    lines.append("};")
    with open(os.path.join(ROOT, "js", "dk64_object_list.js"), "w", newline="\n") as f:
        f.write("\n".join(lines) + "\n")


if __name__ == "__main__":
    main()
