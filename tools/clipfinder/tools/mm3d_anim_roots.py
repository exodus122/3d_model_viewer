#!/usr/bin/env python3
"""MM3D Link animation root motion, from the extracted ROM (a cross-check for
mm3d_action_recorder.lua's recordings: clipfinder uses the recordings).

Link's animations are CSAB files in actors/zelda2_link_new.gar.lzs (LzS-
compressed GAR2 archive; folders boy/ = Human, nuts/ = Deku, zora/, goron/,
child/ ...). Format as noclip.website's OcarinaOfTime3D/zar.ts and csab.ts
(Majora version). Every root track in Link's archive is "baked": one value a
frame, u16 x scale - bias. The root is the lowest animated bone (bone 1).
MM3D's are re-made at 30 fps - not the N64 data (the 1h slash: 7 frames, the
N64's 5) - so the N64 tables in action.cpp don't apply.

  python mm3d_anim_roots.py ROMFS_ACTORS_DIR --list kiru
  python mm3d_anim_roots.py ROMFS_ACTORS_DIR boy/anim/link_fighter_normal_kiru boy/anim/link_fighter_normal_kiru_end
  python mm3d_anim_roots.py ROMFS_ACTORS_DIR --compare mm3d_actions/1h-slash.json boy/anim/link_fighter_normal_kiru boy/anim/link_fighter_normal_kiru_end

Without --compare: each animation's root (x, y, z) a frame. --compare: the
animations played back to back one frame a game frame, the root's change each
frame x 0.01 x SCALE (N64 MM Human's unk_08 11/17, a guess for MM3D) next to
the recording's root motion rows (rx, rz) - a guess at how MM3D plays them, to
check against the game.
"""
import argparse
import json
import os
import struct
import sys

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))
from decompress_zsi import decompress_lzs  # noqa: E402

SCALE = 11 / 17


def load(path):
    buf = open(path, "rb").read()
    if buf[:4] == b"LzS\x01":
        buf = decompress_lzs(buf[0x10:], struct.unpack_from("<I", buf, 8)[0])
    return buf


def cstr(b, o):
    return b[o:b.index(b"\0", o)].decode()


def gar(b):
    assert b[:4] == b"GAR\x02", b[:4]
    n = struct.unpack_from("<H", b, 0x0A)[0]
    ft, dt = struct.unpack_from("<II", b, 0x10)
    files = {}
    for i in range(n):
        size = struct.unpack_from("<I", b, ft + i * 12)[0]
        name = cstr(b, struct.unpack_from("<I", b, ft + i * 12 + 8)[0])
        off = struct.unpack_from("<I", b, dt + i * 4)[0]
        files[name] = b[off:off + size]
    return files


def track(b, o):
    typ, baked, n = struct.unpack_from("<BBH", b, o)
    if baked or typ == 1:
        scale, bias = struct.unpack_from("<ff", b, o + 4)
        return [struct.unpack_from("<H", b, o + 12 + 2 * i)[0] * scale - bias for i in range(n)]
    raise ValueError("track type %d (only baked / linear root tracks handled)" % typ)


def root_frames(b):
    """[(x, y, z)] a frame for the root bone"""
    assert b[:4] == b"csab" and struct.unpack_from("<I", b, 8)[0] == 5
    dur = struct.unpack_from("<I", b, 0x34)[0] + 1
    nanod, nbone = struct.unpack_from("<II", b, 0x3C)
    o = (0x44 + 2 * nbone + 3) & ~3
    nodes = {}
    for i in range(nanod):
        ao = 0x24 + struct.unpack_from("<I", b, o + 4 * i)[0]
        bone = struct.unpack_from("<H", b, ao + 4)[0]
        nodes[bone] = (ao, struct.unpack_from("<3H", b, ao + 8))
    ao, offs = nodes[min(nodes)]
    axes = [track(b, ao + of) if of else None for of in offs]
    out = []
    for t in range(dur):
        out.append(tuple((ax[min(t, len(ax) - 1)] if ax else 0.0) for ax in axes))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("actors", help="the extracted RomFS actors folder")
    ap.add_argument("anims", nargs="*", help="e.g. boy/anim/link_fighter_normal_kiru (.csab optional)")
    ap.add_argument("--archive", default="zelda2_link_new.gar.lzs")
    ap.add_argument("--list", metavar="TEXT", help="list the animations whose name has TEXT")
    ap.add_argument("--compare", metavar="RECORDING", help="a mm3d_actions/<key>.json to set the anims against")
    a = ap.parse_args()
    files = gar(load(os.path.join(a.actors, a.archive)))
    if a.list is not None:
        for n in sorted(files):
            if n.endswith(".csab") and a.list in n:
                print(n, len(root_frames(files[n])))
        return
    seq = []
    for n in a.anims:
        if not n.endswith(".csab"):
            n += ".csab"
        if n not in files:
            sys.exit("no %s in %s" % (n, a.archive))
        fr = root_frames(files[n])
        if not a.compare:
            print("== %s: %d frames" % (n, len(fr)))
            for i, (x, y, z) in enumerate(fr):
                print("  %2d  x %9.3f  y %9.3f  z %9.3f" % (i, x, y, z))
        seq += fr
    if not a.compare:
        return
    rec = json.load(open(a.compare))["rows"]
    print("row  recorded rx, rz          anims' root change x 0.01 x %.4f (x, z)   speed" % SCALE)
    for i in range(max(len(rec), len(seq) - 1)):
        r = rec[i] if i < len(rec) else None
        d = None
        if i + 1 < len(seq):
            d = ((seq[i + 1][0] - seq[i][0]) * 0.01 * SCALE, (seq[i + 1][2] - seq[i][2]) * 0.01 * SCALE)
        print("%3d  %-24s %-40s %s" % (i + 1, "(%.3f, %.3f)" % (r["rx"], r["rz"]) if r else "-",
                                      "(%.3f, %.3f)" % d if d else "-", "%.4f" % r["speed"] if r else ""))


if __name__ == "__main__":
    main()
