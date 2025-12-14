import csv
from collections import defaultdict

input_csv = "mm3d_new_07.csv"  # change this to your filename
scenes = defaultdict(list)

# Read CSV and group rows by column 2
with open(input_csv, newline="", encoding="utf-8") as f:
    reader = csv.reader(f)
    for row in reader:
        if len(row) < 3:
            continue  # skip weird rows
        scene_name = row[1]
        scenes[scene_name].append(row[2:])  # keep only columns after first 2

# Write files
for scene_name, rows in scenes.items():
    filename = f"{scene_name}_seams.txt"
    with open(filename, "w", encoding="utf-8") as out:
        for r in rows:
            out.write(",".join(r) + "\n")

print("Done.")