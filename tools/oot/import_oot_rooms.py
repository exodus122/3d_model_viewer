#!/usr/bin/env python3
"""
Bring the OoT room files (the meshes the viewer's textured map rendering
draws, js/zelda_textured.js) over from the decomp, and generate
js/oot_scene_data.js from its sources.

usage: import_oot_rooms.py [path/to/oot] [version]

    path/to/oot   the oot decomp checkout (default: ../oot next to this repo)
    version       its baseroms/<version> (default: ntsc-1.0)

The decomp must have been extracted for that version (make setup), so that
extracted/<version>/baserom/ holds the decompressed scene and room files.

For every scene in models/OOT/ (the scene files already there came from the
same directory), the rooms named by the scene's room list command (0x04) are
copied in as models/OOT/<scene base>_room_<n>, the decomp's own names.

js/oot_scene_data.js gets OOT_Scene_Segments: the textures the scene draw
configs (src/code/z_scene_table.c) point segments 8-D at, which room display
lists read through gsDPSetTextureImage(..., 0x0N000000). Each config's
segment is resolved to its first choice (daytime, animation frame 0) and the
texture symbol to a file offset through the scene's asset XML.
"""

import os
import re
import struct
import sys

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..")
MODELS = os.path.join(ROOT, "models", "OOT")
OUT_JS = os.path.join(ROOT, "js", "oot_scene_data.js")

SCENE_CMD_ROOM_LIST = 0x04
SCENE_CMD_END = 0x14


def room_count(scene_path):
    """numRooms from the scene's main header room list command."""
    with open(scene_path, "rb") as f:
        data = f.read()
    off = 0
    while off + 8 <= len(data):
        cmd = data[off]
        if cmd == SCENE_CMD_END:
            break
        if cmd == SCENE_CMD_ROOM_LIST:
            return data[off + 1]
        off += 8
    return 0


def copy_rooms(baserom_dir):
    copied = 0
    for name in sorted(os.listdir(MODELS)):
        if not name.endswith("_scene"):
            continue
        base = name[: -len("_scene")]
        n = room_count(os.path.join(MODELS, name))
        for i in range(n):
            room = f"{base}_room_{i}"
            src = os.path.join(baserom_dir, room)
            if not os.path.isfile(src):
                print(f"warning: {room} missing from {baserom_dir}", file=sys.stderr)
                continue
            with open(src, "rb") as f:
                blob = f.read()
            dst = os.path.join(MODELS, room)
            if os.path.isfile(dst):
                with open(dst, "rb") as f:
                    if f.read() == blob:
                        continue
            with open(dst, "wb") as f:
                f.write(blob)
            copied += 1
    print(f"rooms: {copied} copied")


# ---- scene draw config segments

def parse_scene_table(oot):
    """scene file name -> SDC_ enum name (include/tables/scene_table.h)."""
    out = {}
    with open(os.path.join(oot, "include", "tables", "scene_table.h")) as f:
        for m in re.finditer(r"DEFINE_SCENE\((\w+),\s*\w+,\s*\w+,\s*(SDC_\w+)", f.read()):
            out[m.group(1)] = m.group(2)
    return out


def parse_sdc_enum(oot):
    """SDC_ enum name -> index (include/scene.h)."""
    with open(os.path.join(oot, "include", "scene.h")) as f:
        text = f.read()
    body = re.search(r"typedef enum SceneDrawConfig \{(.*?)\} SceneDrawConfig;", text, re.S)
    if not body:
        body = re.search(r"\{([^{}]*SDC_DEFAULT[^{}]*)\}", text, re.S)
    names = re.findall(r"\b(SDC_\w+)\b", body.group(1))
    return {name: i for i, name in enumerate(names)}


def parse_draw_configs(oot):
    """SDC index -> { segment: texture symbol } for the configs that point a
    segment at a texture (the first entry of the day/night or frame array)."""
    with open(os.path.join(oot, "src", "code", "z_scene_table.c")) as f:
        text = f.read()

    # void* sName[] = { gA, gB, };
    arrays = {}
    for m in re.finditer(r"void\*\s+(\w+)\[\]\s*=\s*\{([^}]*)\}", text):
        arrays[m.group(1)] = re.findall(r"\b(g\w+)\b", m.group(2))

    # sSceneDrawConfigs[SDC_MAX] = { Scene_DrawConfigX, ... }
    table = re.search(r"sSceneDrawConfigs\[SDC_MAX\]\s*=\s*\{(.*?)\};", text, re.S)
    funcs = re.findall(r"\b(Scene_DrawConfig\w+)\b", table.group(1))

    out = {}
    for index, func in enumerate(funcs):
        body = re.search(r"void %s\(PlayState\* play\) \{(.*?)\n\}" % func, text, re.S)
        if not body:
            continue
        segs = {}
        for m in re.finditer(r"gSPSegment\([^,]+,\s*0x0([0-9A-Fa-f]),\s*SEGMENTED_TO_VIRTUAL\((\w+)\[", body.group(1)):
            seg, arr = int(m.group(1), 16), m.group(2)
            if arr in arrays and arrays[arr]:
                segs[seg] = arrays[arr][0]
        if segs:
            out[index] = segs
    return out


def scene_xml_paths(oot, version):
    """scene name -> asset XML path, from baseroms/<version>/config.yml."""
    out = {}
    with open(os.path.join(oot, "baseroms", version, "config.yml")) as f:
        lines = f.read().splitlines()
    for i, line in enumerate(lines):
        m = re.match(r"- name: scenes/\w+/(\w+)$", line.strip())
        if m and i + 1 < len(lines):
            p = re.match(r"xml_path: (\S+)", lines[i + 1].strip())
            if p:
                out[m.group(1)] = os.path.join(oot, p.group(1))
    return out


def find_texture(xml_path, symbol):
    """(file name, offset) of a <Texture Name=symbol> in the XML, or None."""
    with open(xml_path) as f:
        text = f.read()
    current = None
    for m in re.finditer(r"<File\s+Name=\"(\w+)\"|<Texture\s+Name=\"(\w+)\"[^>]*\bOffset=\"(0x[0-9A-Fa-f]+)\"", text):
        if m.group(1):
            current = m.group(1)
        elif m.group(2) == symbol:
            return current, int(m.group(3), 16)
    return None


def generate_segments(oot, version):
    scene_sdc = parse_scene_table(oot)
    sdc_index = parse_sdc_enum(oot)
    configs = parse_draw_configs(oot)
    xmls = scene_xml_paths(oot, version)

    result = {}
    for scene, sdc in sorted(scene_sdc.items()):
        segs = configs.get(sdc_index.get(sdc, -1))
        if not segs:
            continue
        base = scene[: -len("_scene")]
        xml = xmls.get(base)
        if not xml or not os.path.isfile(xml):
            print(f"warning: no asset XML for {scene}", file=sys.stderr)
            continue
        entries = {}
        for seg, symbol in sorted(segs.items()):
            found = find_texture(xml, symbol)
            if not found:
                print(f"warning: {scene}: {symbol} not in {os.path.basename(xml)}", file=sys.stderr)
                continue
            entries[seg] = (found[0], found[1], symbol)
        if entries:
            result[scene] = entries

    lines = [
        "// Generated by tools/oot/import_oot_rooms.py from the oot decomp -- do not edit.",
        "//",
        "// OOT_Scene_Segments: for each scene whose draw config (z_scene_table.c)",
        "// points a display-list segment at a texture, the file and offset of that",
        "// texture (the daytime / first-frame choice). Room display lists load",
        "// such textures with gsDPSetTextureImage(..., 0x0N000000); the viewer's",
        "// js/zelda_textured.js maps the segment to this data.",
        "",
        "const OOT_Scene_Segments = {",
    ]
    for scene, entries in result.items():
        lines.append(f"    \"{scene}\": {{")
        for seg, (file, offset, symbol) in entries.items():
            lines.append(f"        0x{seg:02X}: {{ file: \"{file}\", offset: 0x{offset:X} }}, // {symbol}")
        lines.append("    },")
    lines.append("};")
    lines.append("")
    with open(OUT_JS, "w", newline="\n") as f:
        f.write("\n".join(lines))
    print(f"segments: {len(result)} scenes -> {os.path.relpath(OUT_JS, ROOT)}")


def main():
    oot = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, "..", "oot")
    version = sys.argv[2] if len(sys.argv) > 2 else "ntsc-1.0"
    baserom_dir = os.path.join(oot, "extracted", version, "baserom")
    if not os.path.isdir(baserom_dir):
        sys.exit(f"{baserom_dir} not found: extract the decomp for {version} first")
    copy_rooms(baserom_dir)
    generate_segments(oot, version)


if __name__ == "__main__":
    main()
