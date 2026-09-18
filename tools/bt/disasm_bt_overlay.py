#!/usr/bin/env python3
"""
Disassemble one Banjo-Tooie code overlay (ch*, gl*, gc*, sub*, ...) straight
out of the US ROM, annotated with the symbol names the banjo-tooie decomp
knows, so an actor's behaviour (scale changes, model picks, actors it moves
around, ...) can be read without a decompiled C file.

usage: disasm_bt_overlay.py <overlay name> [--repo ../banjo-tooie] [--rom baserom.us.z64]
       disasm_bt_overlay.py core1|core2 --range 0x80101808-0x80101970
       disasm_bt_overlay.py --list

  disasm_bt_overlay.py chmrsicecube > chmrsicecube.s
  disasm_bt_overlay.py core2 --range 0x801018A4-0x80101970   # a core function an overlay calls

Output: every .text instruction (address, mnemonic, operands), then the
.rodata and .data words. Annotations:
  * a label line before each address named in the decomp's symbol files
    (symbol_addrs.us.txt, syscall_symbol_addrs.us.txt, ovl_symbol_addrs.us.txt
    for this overlay)
  * jal/j and branch targets: "; <symbol>". Calls into other overlays go
    through the syscall stubs (_<overlay>_entrypoint_<n>, 0x8008xxxx); calls
    to 0x800Dxxxx-0x8010xxxx are core functions, mostly unnamed in the decomp
  * lui/addiu, lui/lw... pairs: "; <address> <symbol>" for the resolved address

The overlay is linked at 0x80800000 (.text, then .rodata, then .data). Its
own jal targets and lui halves are stored unrelocated in the ROM (jal
0x800xxxxx, lui 0), so both are fixed up here as the game's loader would.

core1 (0x80012030) and core2 (0x800815C0) are the always-loaded code the
overlays call into; they are zlib streams at fixed ROM offsets
(tools/tooie_utils.h us_v10) and need --range since they are big. The decomp
has C for some of core2 (src/core2/*.c), so check there first.

Where things live in an overlay: entrypoint_<n> returns a pointer to an
ActorInfo struct (0x48 bytes, {u16 markerId, u16 actorId, u16 modelId, ...})
in .data, see banjo-tooie/tools/extract_maps.py find_actor_model. The
gemarkersDll table (BT_Actor_Overlays in js/bt_object_list.js) says which
overlay and entrypoint an actor id uses.

Needs: pip install capstone. The banjo-tooie repo (with baserom.us.z64) is
expected next to this repo unless --repo says otherwise.
"""

import argparse
import os
import re
import struct
import sys
import zlib

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..")
OVERLAY_BASE = 0x80800000
# Compressed core code in the US ROM (banjo-tooie/tools/tooie_utils.h us_v10):
# name -> (vram, text start, text end / data start, data end). Each part is a
# u16 (size / 16) then a raw zlib stream.
CORES = {
    "core1": (0x80012030, 0x1E29B60, 0x1E3F718, 0x1E42550),
    "core2": (0x800815C0, 0x1E42550, 0x1E86C76, 0x1E899B0),
}
SYMBOL_FILES = ["symbol_addrs.us.txt", "syscall_symbol_addrs.us.txt", "ovl_symbol_addrs.us.txt"]


def load_extract_maps(repo):
    """banjo-tooie/tools/extract_maps.py, for the ROM helpers (byte order, CRC, table offset)."""
    sys.path.insert(0, os.path.join(repo, "tools"))
    try:
        import extract_maps
    except ImportError:
        sys.exit("banjo-tooie/tools/extract_maps.py not found under %s (use --repo)" % repo)
    return extract_maps


def iter_overlays(rom, em):
    """Yields (name, text, rodata, data, entrypoint offsets) for every overlay in the ROM.
    Same walk as extract_maps.iter_overlay_data, which only keeps .data."""
    table_base = em.OVERLAY_TABLE_ROM_OFFSET
    count = struct.unpack_from(">I", rom, table_base)[0] // 4 - 1
    offsets = [struct.unpack_from(">I", rom, table_base + 4 * i)[0] for i in range(count + 1)]
    for i in range(count):
        start, end = table_base + offsets[i], table_base + offsets[i + 1]
        if start == end:
            continue
        header = bytearray(rom[start:start + 0x12])
        name_len, flags = header[0xE], header[0xF]
        if flags & 0x80:
            contents = zlib.decompressobj(wbits=-15).decompress(rom[start + 0x12:end])
            crc1, crc2 = em.bk_crc(contents)       # header words 0 and 8 are XORed with the CRCs
            struct.pack_into(">I", header, 0, struct.unpack_from(">I", header, 0)[0] ^ crc1)
            struct.pack_into(">I", header, 8, struct.unpack_from(">I", header, 8)[0] ^ crc2)
        else:
            contents = rom[start + 0x10:end]
        num_entrypoints, num_relocs = struct.unpack_from(">HH", header, 8)
        name_off = 0x28 + 4 * num_entrypoints
        name = contents[name_off:name_off + name_len].rstrip(b"\0").decode("ascii", "replace")
        entrypoints = [struct.unpack_from(">I", contents, 0x28 + 4 * k)[0] for k in range(num_entrypoints)]
        relocs_end = name_off + ((name_len + 3) & ~3) + 2 * num_relocs
        code_off = (relocs_end + 15) & ~15
        text_size, rodata_size = (16 * v for v in struct.unpack_from(">HH", header, 0))
        text = contents[code_off:code_off + text_size]
        rodata = contents[code_off + text_size:code_off + text_size + rodata_size]
        data = contents[code_off + text_size + rodata_size:]
        yield name, text, rodata, data, entrypoints


def inflate_part(rom, start, end):
    size = struct.unpack_from(">H", rom, start)[0] * 16
    return zlib.decompressobj(wbits=-15).decompress(rom[start + 2:end])[:size]


def load_core(rom, name):
    """(vram, text, data) of core1 / core2."""
    vram, start, text_end, end = CORES[name]
    return vram, inflate_part(rom, start, text_end), inflate_part(rom, text_end, end)


def load_symbols(repo, overlay):
    """address -> name. Overlay-space symbols (0x808xxxxx) are only taken for this overlay."""
    syms = {}
    for fn in SYMBOL_FILES:
        path = os.path.join(repo, fn)
        if not os.path.exists(path):
            continue
        with open(path, encoding="utf-8") as f:
            for m in re.finditer(r"^(\w+) = 0x([0-9A-Fa-f]+);(.*)$", f.read(), re.M):
                addr = int(m.group(2), 16)
                if addr >= OVERLAY_BASE and not re.search(r"segment:%s\b" % re.escape(overlay), m.group(3)):
                    continue
                syms.setdefault(addr, m.group(1))
    return syms


def relocate_target(t):
    # An overlay's own jal targets are stored as 0x800xxxxx; the loader adds its base.
    return t + 0x800000 if t < 0x80010000 else t


MEM_RE = re.compile(r"(-?0x[0-9a-f]+|-?\d+)\((\$\w+)\)")
IMM_RE = re.compile(r"(\$\w+), (\$\w+), (-?0x[0-9a-f]+|-?\d+)$")


def disassemble(text, syms, out, base=OVERLAY_BASE, relocate=True):
    from capstone import Cs, CS_ARCH_MIPS, CS_MODE_MIPS64, CS_MODE_BIG_ENDIAN
    md = Cs(CS_ARCH_MIPS, CS_MODE_MIPS64 | CS_MODE_BIG_ENDIAN)
    hi = {}   # register -> value from the last lui, for lui/lo16 pairs
    for ins in md.disasm(text, base):
        label = syms.get(ins.address)
        if label:
            out.write("\n%s:\n" % label)
        ops = ins.op_str
        if ins.mnemonic in ("jal", "j") and re.match(r"^0x[0-9a-f]+$", ops):
            t = int(ops, 16)
            if relocate:
                t = relocate_target(t)
            ops = "0x%x   ; %s" % (t, syms.get(t, ""))
        elif ins.mnemonic.startswith("b") and ops:
            try:
                t = int(ops.split(",")[-1].strip(), 16)
                ops += "   ; %s" % syms.get(t, "")
            except ValueError:
                pass
        if ins.mnemonic == "lui":
            reg, val = ops.split(", ")
            hi[reg] = int(val, 16) << 16
            if relocate and not hi[reg]:
                hi[reg] = OVERLAY_BASE   # lui 0 = this overlay, unrelocated
        else:
            m = MEM_RE.search(ops)
            if m and m.group(2) in hi:
                addr = hi[m.group(2)] + int(m.group(1), 0)
                ops += "   ; 0x%x %s" % (addr, syms.get(addr, ""))
            else:
                m = IMM_RE.match(ops)
                if m and ins.mnemonic in ("addiu", "ori") and m.group(2) in hi:
                    addr = hi[m.group(2)] + int(m.group(3), 0)
                    ops += "   ; 0x%x %s" % (addr, syms.get(addr, ""))
        out.write("  %08x: %-8s %s\n" % (ins.address, ins.mnemonic, ops))


def dump_words(section, base, syms, out):
    for o in range(0, len(section), 16):
        n = min(16, len(section) - o) // 4
        if not n:
            break
        words = struct.unpack_from(">%dI" % n, section, o)
        out.write("  %08x: %s   %s\n" % (base + o, " ".join("%08x" % w for w in words), syms.get(base + o, "")))


def main():
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("overlay", nargs="?", help="overlay name, e.g. chmrsicecube, or core1 / core2")
    ap.add_argument("--range", help="core1 / core2 only: vram range to disassemble, e.g. 0x80101808-0x80101970")
    ap.add_argument("--repo", default=os.path.join(ROOT, "..", "banjo-tooie"), help="banjo-tooie decomp repo")
    ap.add_argument("--rom", default=None, help="ROM path (default: <repo>/baserom.us.z64)")
    ap.add_argument("--list", action="store_true", help="list overlay names and exit")
    args = ap.parse_args()
    if not args.overlay and not args.list:
        ap.error("an overlay name or --list is required")

    em = load_extract_maps(args.repo)
    rom_path = args.rom or os.path.join(args.repo, "baserom.us.z64")
    with open(rom_path, "rb") as f:
        rom = em.rom_to_big_endian(f.read())

    if args.list:
        for name, text, rodata, data, eps in iter_overlays(rom, em):
            print("%-28s text %#7x rodata %#5x data %#6x entrypoints %d" % (name, len(text), len(rodata), len(data), len(eps)))
        return

    if args.overlay in CORES:
        if not args.range:
            ap.error("--range is required for %s" % args.overlay)
        lo, hi_ = (int(v, 16) for v in args.range.split("-"))
        vram, text, data = load_core(rom, args.overlay)
        syms = load_symbols(args.repo, "")
        out = sys.stdout
        out.write("; %s: text at 0x%x (%#x bytes), data at 0x%x (%#x bytes)\n" %
                  (args.overlay, vram, len(text), vram + len(text), len(data)))
        if lo < vram + len(text):
            disassemble(text[lo - vram:hi_ - vram], syms, out, base=lo, relocate=False)
        else:
            dump_words(data[lo - vram - len(text):hi_ - vram - len(text)], lo, syms, out)
        return

    for name, text, rodata, data, eps in iter_overlays(rom, em):
        if name != args.overlay:
            continue
        syms = load_symbols(args.repo, name)
        for i, ep in enumerate(eps):
            syms.setdefault(OVERLAY_BASE + ep, "%s_entrypoint_%d" % (name, i))
        out = sys.stdout
        out.write("; overlay %s: text %#x rodata %#x data %#x entrypoints %s\n" %
                  (name, len(text), len(rodata), len(data), ", ".join("0x%x" % (OVERLAY_BASE + e) for e in eps)))
        disassemble(text, syms, out)
        out.write("\n; .rodata at 0x%x\n" % (OVERLAY_BASE + len(text)))
        dump_words(rodata, OVERLAY_BASE + len(text), syms, out)
        out.write("\n; .data at 0x%x\n" % (OVERLAY_BASE + len(text) + len(rodata)))
        dump_words(data, OVERLAY_BASE + len(text) + len(rodata), syms, out)
        return
    sys.exit("overlay %s not found (see --list)" % args.overlay)


if __name__ == "__main__":
    main()
