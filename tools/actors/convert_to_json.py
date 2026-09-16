import csv
import json
import sys


def csv_to_json(input_file, output_file):
    with open(input_file, "r", encoding="utf-8", newline="") as f:
        reader = csv.DictReader(f)

        rows = list(reader)

    with open(output_file, "w", encoding="utf-8") as f:
        json.dump(rows, f, indent=4)

    print(f"Converted {len(rows)} rows.")
    print(f"Output: {output_file}")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        print("Usage:")
        print("    python csv_to_json.py input.csv output.json")
        sys.exit(1)

    csv_to_json(sys.argv[1], sys.argv[2])