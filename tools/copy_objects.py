import os
import shutil

INPUT_FILE = "files.txt"
OUTPUT_DIR = "selected_files"


os.makedirs(OUTPUT_DIR, exist_ok=True)

copied = 0
missing = 0

with open(INPUT_FILE, "r", encoding="utf-8") as f:
    for line in f:
        filename = line.strip()

        # Skip blank lines
        if not filename:
            continue

        source = os.path.join(".", filename)
        destination = os.path.join(OUTPUT_DIR, filename)

        if not os.path.isfile(source):
            print(f"WARNING: File not found: {filename}")
            missing += 1
            continue

        shutil.copy2(source, destination)
        print(f"Copied: {filename}")
        copied += 1

print()
print(f"Copied: {copied}")
print(f"Missing: {missing}")
print(f"Output folder: {OUTPUT_DIR}")