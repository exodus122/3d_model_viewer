#!/usr/bin/env python3
"""
Bring the MM room files (the meshes the viewer's textured map rendering
draws, js/zelda_textured.js) over from the decomp.

usage: import_mm_rooms.py [path/to/mm] [version]

    path/to/mm    the mm decomp checkout (default: ../mm next to this repo)
    version       its baseroms/<version> (default: n64-us)

The decomp must have been extracted for that version (make setup), so that
extracted/<version>/baserom/ holds the decompressed scene and room files.

For every scene in models/MM/ (the scene files already there came from the
same directory), the rooms named by the scene's room list command (0x04) are
copied in as models/MM/<scene>_room_<nn>, the decomp's own names, along with
the eight scene_texture_<nn> files that the skybox settings command (0x11)
picks one of per scene: the game loads it into segment 6 for the room
display lists (Scene_LoadAreaTextures).

Unlike OoT, nothing needs generating: MM animates its map materials through
the scene's own animated material list (command 0x1A), which the viewer
reads directly.
"""

import os
import struct
import sys

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..")
MODELS = os.path.join(ROOT, "models", "MM")

SCENE_CMD_ROOM_LIST = 0x04
SCENE_CMD_END = 0x14
AREA_TEXTURE_FILES = [f"scene_texture_{i:02d}" for i in range(1, 9)]


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


def copy_file(baserom_dir, name):
    src = os.path.join(baserom_dir, name)
    if not os.path.isfile(src):
        print(f"warning: {name} missing from {baserom_dir}", file=sys.stderr)
        return False
    with open(src, "rb") as f:
        blob = f.read()
    dst = os.path.join(MODELS, name)
    if os.path.isfile(dst):
        with open(dst, "rb") as f:
            if f.read() == blob:
                return False
    with open(dst, "wb") as f:
        f.write(blob)
    return True


def main():
    mm = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, "..", "mm")
    version = sys.argv[2] if len(sys.argv) > 2 else "n64-us"
    baserom_dir = os.path.join(mm, "extracted", version, "baserom")
    if not os.path.isdir(baserom_dir):
        sys.exit(f"{baserom_dir} not found: extract the decomp for {version} first")

    copied = 0
    for name in sorted(os.listdir(MODELS)):
        path = os.path.join(MODELS, name)
        if not os.path.isfile(path) or "_room_" in name or name.startswith("scene_texture_"):
            continue
        if not os.path.isfile(os.path.join(baserom_dir, name)):
            continue  # not a scene file
        for i in range(room_count(path)):
            copied += copy_file(baserom_dir, f"{name}_room_{i:02d}")
    print(f"rooms: {copied} copied")
    copied = sum(copy_file(baserom_dir, name) for name in AREA_TEXTURE_FILES)
    print(f"area textures: {copied} copied")


if __name__ == "__main__":
    main()
