#!/usr/bin/env python3
import os
import struct
import shutil

INPUT_DIR = "./MM3D_compressed"
OUTPUT_DIR = "MM3D"
MAGIC = b"LzS\x01"


def decompress_lzs(data: bytes, uncompressed_size: int) -> bytes:
    N = 4096
    F = 18

    dst = bytearray(uncompressed_size)
    temp = bytearray(N)
    temp_wp = N - F

    src_off = 0
    dst_off = 0
    data_len = len(data)

    def read():
        nonlocal src_off
        if src_off >= data_len:
            raise EOFError("Unexpected EOF in LZSS stream")
        b = data[src_off]
        src_off += 1
        return b

    while dst_off < uncompressed_size:
        command = read()
        for i in range(8):
            if command & (1 << i):
                # literal byte
                b = read()
                dst[dst_off] = b
                temp[temp_wp] = b
                dst_off += 1
                temp_wp = (temp_wp + 1) % N
                if dst_off >= uncompressed_size:
                    return bytes(dst)
            else:
                # backreference
                b0 = read()
                b1 = read()

                temp_rp = b0 | ((b1 & 0xF0) << 4)
                length = (b1 & 0x0F) + 3

                for _ in range(length):
                    b = temp[temp_rp]
                    dst[dst_off] = b
                    temp[temp_wp] = b

                    dst_off += 1
                    temp_wp = (temp_wp + 1) % N
                    temp_rp = (temp_rp + 1) % N

                    if dst_off >= uncompressed_size:
                        return bytes(dst)
    return bytes(dst)


def process_all():
    os.makedirs(OUTPUT_DIR, exist_ok=True)

    for fname in sorted(os.listdir(INPUT_DIR)):
        if not fname.lower().endswith(".zsi"):
            continue

        src_path = os.path.join(INPUT_DIR, fname)
        dst_path = os.path.join(OUTPUT_DIR, fname)

        with open(src_path, "rb") as f:
            buf = f.read()

        if buf[:4] != MAGIC:
            print(f"Copying (already decompressed): {fname}")
            shutil.copyfile(src_path, dst_path)
            continue

        # Correct format: size is at offset 0x08, little-endian
        uncompressed_size = struct.unpack("<I", buf[0x08:0x0C])[0]
        print(f"Decompressing {fname} -> {uncompressed_size} bytes")

        compressed_data = buf[0x10:]  # correct starting offset

        try:
            out = decompress_lzs(compressed_data, uncompressed_size)
        except Exception as e:
            print(f"  ERROR decompressing {fname}: {e}")
            continue

        with open(dst_path, "wb") as f:
            f.write(out)
        print(f"  WROTE {dst_path}")


if __name__ == "__main__":
    process_all()
