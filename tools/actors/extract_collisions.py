import os
import re
from openpyxl import Workbook


SCRIPT_DIR = os.path.dirname(os.path.abspath(__file__))
OUTPUT_FILE = os.path.join(SCRIPT_DIR, "collision_data.xlsx")


collision_pattern = re.compile(
    r'<Collision\s+Name="([^"]+)"\s+Offset="(0x[0-9A-Fa-f]+)"'
)


rows = []

for filename in sorted(os.listdir(SCRIPT_DIR)):
    if not filename.lower().endswith(".xml"):
        continue

    filepath = os.path.join(SCRIPT_DIR, filename)
    object_name = os.path.splitext(filename)[0]

    with open(filepath, "r", encoding="utf-8") as f:
        for line in f:
            if "Collision Name" not in line:
                continue

            match = collision_pattern.search(line)

            if match:
                rows.append([
                    object_name,
                    match.group(1),
                    match.group(2),
                ])


workbook = Workbook()
worksheet = workbook.active
worksheet.title = "Collisions"

worksheet.append([
    "object_name",
    "collision_name",
    "offset",
])

for row in rows:
    worksheet.append(row)

worksheet.column_dimensions["A"].width = 25
worksheet.column_dimensions["B"].width = 35
worksheet.column_dimensions["C"].width = 15

workbook.save(OUTPUT_FILE)

print(f"Found {len(rows)} collision(s).")
print(f"Saved to: {OUTPUT_FILE}")