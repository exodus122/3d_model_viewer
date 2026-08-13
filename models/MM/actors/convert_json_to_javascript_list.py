import json

with open("collision_data.json", "r", encoding="utf-8") as f:
    data = json.load(f)

with open("collision_data.js", "w", encoding="utf-8") as f:
    f.write("const JS_LIST = [\n")

    for item in data:
        f.write(
            f'    {{ file_name: "{item["object_name"]}", '
            f'collision_name: "{item["collision_name"]}", '
            f'offset: {item["offset"]}, '
            f'type: "{item["type"]}" }},\n'
        )

    f.write("];\n")