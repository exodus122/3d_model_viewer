#!/usr/bin/env python3
"""
Regenerate the BT_Maps table in js/model_list.js from models/BT/maps.json (the
index written by banjo-tooie/tools/extract_maps.py).

usage: generate_bt_map_list.py [models/BT/maps.json] [js/model_list.js]

Maps are grouped by world in the order the game presents them; within a world
the main map(s) come first (MAIN_MAPS), then the rest by map id.
"""

import json
import os
import re
import sys

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..")

# Prefix of the MAP_ enum name -> display order. Anything else goes last.
# GL_ENTRANCE (the gruntilda's lair entrance you walk out of into Spiral
# Mountain's rock face) sits with SM.
WORLD_ORDER = ["SM", "GL", "JV", "IOH", "MT", "GGM", "WW", "JRL", "TDL", "GI", "HP", "CCL", "CK",
               "MP", "GAME", "CS", "BOB", "MEANWHILE", "JINGALING", "ENERGY"]

# The main map(s) of each world, listed first in that world; the rest of a
# world follows by map id. JRL's three top-level lagoon maps go together.
MAIN_MAPS = ["SM_SPIRAL_MOUNTAIN", "MT_MAYAHEM_TEMPLE", "GGM_GLITTER_GULCH_MINE", "WW_WITCHYWORLD",
             "JRL_JOLLY_ROGERS_LAGOON", "JRL_ATLANTIS", "JRL_SEA_BOTTOM", "TDL_TERRYDACTYLAND",
             "GI_OUTSIDE", "HP_LAVA_SIDE", "CCL_CLOUD_CUCKOOLAND", "CK_CAULDRON_KEEP",
             "JV_JINJO_VILLAGE", "IOH_WOODED_HOLLOW"]


def world_rank(name):
    prefix = name.split("_")[0]
    return WORLD_ORDER.index(prefix) if prefix in WORLD_ORDER else len(WORLD_ORDER)


def sort_key(m):
    name = m["map"]
    main = MAIN_MAPS.index(name) if name in MAIN_MAPS else len(MAIN_MAPS)
    return (world_rank(name), main, m["map_id"])


def js_entry(m):
    files = m["files"]
    parts = [
        'name: "%s"' % m["map"],
        'sceneID: "%X"' % m["map_id"],
        'dir: "%s"' % m["dir"],
        'opa: "%s"' % ("%X" % files["opa.model.bin"]["asset_id"] if "opa.model.bin" in files else ""),
        'xlu: "%s"' % ("%X" % files["xlu.model.bin"]["asset_id"] if "xlu.model.bin" in files else ""),
    ]
    if m.get("sectors"):
        sects = ", ".join('["%X", "%s", [%s]]' % (s["opa"], "%X" % s["xlu"] if s["xlu"] else "",
                                                 ", ".join("%g" % v for v in s["offset"]))
                          for s in m["sectors"])
        parts.append("sectors: [%s]" % sects)
    return "    { %s }," % ", ".join(parts)


def main():
    maps_json = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, "models", "BT", "maps.json")
    model_list = sys.argv[2] if len(sys.argv) > 2 else os.path.join(ROOT, "js", "model_list.js")

    with open(maps_json, encoding="utf-8") as f:
        maps = json.load(f)
    for m in maps:
        if not m["map"]:
            m["map"] = "MAP_%X" % m["map_id"]
    maps.sort(key=sort_key)

    header = (
        "// Each BT map lives in models/BT/<dir>/ as extracted by banjo-tooie/tools/extract_maps.py:\n"
        "//   opa.model.bin  - model A, opaque level geometry (BKModelBin)      [asset id in \"opa\", \"\" if none]\n"
        "//   xlu.model.bin  - model B, translucent level geometry, if any     [asset id in \"xlu\", \"\" if none]\n"
        "//   setup.bin      - decrypted + decompressed map setup file\n"
        "//   sect<N>.{opa,xlu}.model.bin - Jolly Roger's Lagoon terrain sectors, drawn translated by\n"
        "//                                 their offset [\"sectors\": [[opa, xlu, [x, y, z]], ...]]\n"
        "const BT_Maps = [\n"
    )
    block = header + "\n".join(js_entry(m) for m in maps) + "\n];"

    with open(model_list, encoding="utf-8") as f:
        src = f.read()
    new_src, n = re.subn(r"(?:^//[^\n]*\n)*^const BT_Maps = \[\n.*?^\];", lambda _m: block, src,
                         count=1, flags=re.S | re.M)
    if n != 1:
        sys.exit("BT_Maps block not found in %s" % model_list)
    with open(model_list, "w", encoding="utf-8", newline="\n") as f:
        f.write(new_src)
    print("wrote %d BT maps to %s" % (len(maps), model_list))


if __name__ == "__main__":
    main()
