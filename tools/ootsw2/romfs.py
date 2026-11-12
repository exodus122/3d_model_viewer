"""Readers for the OoT (Switch 2) romfs containers: zstd (with the game's
dictionaries from Pack/ZsDic.pack.zs), SARC archives and BYML (v7) documents."""
import os
import struct

import zstandard


class RomFS:
    def __init__(self, root):
        if not os.path.isdir(os.path.join(root, "Banc")):
            raise SystemExit(f"{root} doesn't look like the game's romfs (no Banc folder)")
        self.root = root
        self._dicts = None

    def path(self, *parts):
        return os.path.join(self.root, *parts)

    def exists(self, *parts):
        return os.path.exists(self.path(*parts))

    def _load_dicts(self):
        raw = zstandard.ZstdDecompressor().decompress(open(self.path("Pack", "ZsDic.pack.zs"), "rb").read(),
                                                      max_output_size=1 << 28)
        self._dicts = {}
        for blob in sarc(raw).values():
            d = zstandard.ZstdCompressionDict(blob)
            self._dicts[d.dict_id()] = d

    def decompress(self, buf):
        if buf[:4] != b"\x28\xb5\x2f\xfd":
            return buf
        did = zstandard.get_frame_parameters(buf).dict_id
        if did:
            if self._dicts is None:
                self._load_dicts()
            z = zstandard.ZstdDecompressor(dict_data=self._dicts[did])
        else:
            z = zstandard.ZstdDecompressor()
        return z.decompress(buf, max_output_size=1 << 31)

    def read(self, *parts):
        return self.decompress(open(self.path(*parts), "rb").read())


def sarc(buf):
    """SARC archive -> {name: bytes} (little endian)."""
    if buf[:4] != b"SARC":
        raise ValueError("not a SARC")
    data_off = struct.unpack_from("<I", buf, 0xC)[0]
    n = struct.unpack_from("<H", buf, 0x1A)[0]
    names_off = 0x20 + n * 16 + 8   # SFAT entries, then the SFNT header
    out = {}
    for i in range(n):
        _, attr, start, end = struct.unpack_from("<IIII", buf, 0x20 + i * 16)
        name = str(i)
        if attr >> 24:
            p = names_off + (attr & 0xFFFF) * 4
            name = buf[p:buf.index(b"\0", p)].decode("utf-8")
        out[name] = bytes(buf[data_off + start:data_off + end])
    return out


class Byml:
    """BYML reader (little or big endian, up to v7): .root is plain dicts / lists / values.
    Hash dicts (0x20 / 0x21) come back as {int: value}."""

    CONTAINERS = (0xC0, 0xC1, 0x20, 0x21)

    def __init__(self, b):
        self.b = b
        self.e = "<" if b[:2] == b"YB" else ">"
        _, self.version, keys, strs, root = struct.unpack_from(self.e + "HHIII", b, 0)
        self.keys = self._strtab(keys) if keys else []
        self.strs = self._strtab(strs) if strs else []
        self.root = self._node(b[root], root) if root else None

    def _u(self, fmt, off):
        return struct.unpack_from(self.e + fmt, self.b, off)

    def _u24(self, off):
        return int.from_bytes(self.b[off:off + 3], "little" if self.e == "<" else "big")

    def _strtab(self, off):
        n = self._u24(off + 1)
        offs = self._u(f"{n + 1}I", off + 4)
        return [self.b[off + offs[i]:self.b.index(b"\0", off + offs[i])].decode("utf-8", "replace") for i in range(n)]

    def _node(self, t, v):
        b = self.b
        if t == 0xC1:   # dictionary
            n = self._u24(v + 1)
            out = {}
            for i in range(n):
                p = v + 4 + i * 8
                out[self.keys[self._u24(p)]] = self._value(b[p + 3], self._u("I", p + 4)[0])
            return out
        if t == 0xC0:   # array
            n = self._u24(v + 1)
            types = b[v + 4:v + 4 + n]
            vo = v + 4 + ((n + 3) & ~3)
            return [self._value(types[i], self._u("I", vo + i * 4)[0]) for i in range(n)]
        if t in (0x20, 0x21):   # hash dictionaries (u32 / u64 keys)
            n = self._u24(v + 1)
            ks = 4 if t == 0x20 else 8
            es = ks + 4
            types = v + 4 + n * es
            out = {}
            for i in range(n):
                p = v + 4 + i * es
                out[self._u("I" if ks == 4 else "Q", p)[0]] = self._value(b[types + i], self._u("I", p + ks)[0])
            return out
        raise ValueError(f"BYML node type 0x{t:x}")

    def _value(self, t, x):
        if t in self.CONTAINERS:
            return self._node(t, x)
        if t == 0xA0:
            return self.strs[x]
        if t == 0xD0:
            return bool(x)
        if t == 0xD1:
            return x - (1 << 32) if x & 0x80000000 else x
        if t == 0xD2:
            return struct.unpack("<f", struct.pack("<I", x))[0]
        if t == 0xD3:
            return x
        if t == 0xD4:
            return self._u("q", x)[0]
        if t == 0xD5:
            return self._u("Q", x)[0]
        if t == 0xD6:
            return self._u("d", x)[0]
        if t == 0xA1:   # binary blob: u32 size + data
            size = self._u("I", x)[0]
            return self.b[x + 4:x + 4 + size]
        if t == 0xFF:
            return None
        raise ValueError(f"BYML value type 0x{t:x}")


def byml(buf):
    return Byml(buf).root
