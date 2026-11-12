#!/usr/bin/env python3
"""Download Ocarina of Time (Switch 2) map data from the Owl Object Map.

https://objmap-oot.zeldamods.org/ is a 2D map, but it serves the 3D data it
draws its shapes from:

  game_files/maps.json                         areas -> maps (map_type, map_name, age)
  game_files/actor_collision/<type>/<map>.bin  "OCOL": collision shapes per ACTOR NAME,
                                               in the actor's local space
  game_files/airwall_meshes.json (+ _triangles) air wall meshes per actor name
  radar-oot.zeldamods.org/objs/<type>/<map>    every placed object (name, pos, Rotate, Scale)

The map's terrain is made of placed Land_* actors, so the level collision is
rebuilt by putting each placed actor's OCOL shape at its position (see
js/ootsw2_map.js). This script only downloads and trims; the OCOL files are
copied as-is.

Writes:
  models/OOTSW2/<map_type>/<map_name>/collision.bin   (OCOL, unchanged)
  models/OOTSW2/<map_type>/<map_name>/objects.json    [{n, h, p, r?, s?, t?}]
  models/OOTSW2/airwalls.json                         {name: {v: [...], i: [...]}}
  js/ootsw2_map_list.js                               OOTSW2_Maps

Usage: python tools/ootsw2/extract_objmap.py [--only HyruleField_Child ...] [--force]
"""
import argparse, json, os, sys, time, urllib.parse, urllib.request

OBJMAP = "https://objmap-oot.zeldamods.org/game_files"
RADAR = "https://radar-oot.zeldamods.org"
ROOT = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", ".."))
OUT = os.path.join(ROOT, "models", "OOTSW2")
GROUPS = {"field": "Field", "dungeon": "Dungeons", "other": "Other"}


def fetch(url, retries=3):
    for attempt in range(retries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "3d_model_viewer extractor"})
            with urllib.request.urlopen(req, timeout=120) as r:
                return r.read()
        except urllib.error.HTTPError as e:
            if e.code == 404:
                return None
            if attempt == retries - 1:
                raise
        except OSError:
            if attempt == retries - 1:
                raise
        time.sleep(2 * (attempt + 1))


def fetch_json(url):
    data = fetch(url)
    return None if data is None else json.loads(data)


def vec3(v):
    # Rotate / Scale are either one number (uniform) or [x, y, z]
    return [v, v, v] if isinstance(v, (int, float)) else v


DATA_FIELDS = ("Rotate,Scale,Name,Bakeable,IsNotTurnToActor,Links,Dynamic.RigidBodyShapeType,"
               "Dynamic.NextBancParamNameChild,Dynamic.NextBancParamNameAdult,Dynamic.NextStartPosName")


def trim(o):
    """Placed object -> the fields the viewer uses:
    n name, h hash id, p pos, g generation group, r Rotate, s Scale,
    t RigidBodyShapeType, nm data Name, u objmap's friendly name (when it
    differs from n), b Bakeable (baked into the static compound), na
    IsNotTurnToActor (never becomes an actor at runtime), l Links as
    [[destination hash id, link name]], and for loading zones the
    destination: zc / za child / adult map, zs start position."""
    d = o.get("data") or {}
    dyn = d.get("Dynamic") or {}
    out = {"n": o["name"], "h": o["hash_id"], "p": o["pos"], "g": o.get("gen_group")}
    if o.get("ui_name") and o["ui_name"] != o["name"]:
        out["u"] = o["ui_name"]
    if d.get("Bakeable"):
        out["b"] = 1
    if d.get("IsNotTurnToActor"):
        out["na"] = 1
    links = [[l["Dst"], l.get("Name") or l.get("Gyaml")] for l in d.get("Links") or [] if l.get("Dst")]
    if links:
        out["l"] = links
    if "Rotate" in d and any(vec3(d["Rotate"])):
        out["r"] = vec3(d["Rotate"])
    if "Scale" in d:
        out["s"] = vec3(d["Scale"])
    for key, field in (("t", "RigidBodyShapeType"), ("zc", "NextBancParamNameChild"),
                       ("za", "NextBancParamNameAdult"), ("zs", "NextStartPosName")):
        if dyn.get(field) is not None:
            out[key] = dyn[field]
    if d.get("Name"):
        out["nm"] = d["Name"]
    return out


def fetch_compound(mname, d, force):
    """static_compound/<map>/: the map's baked static collision (every static
    actor's shape, plus the field's heightmap ground), as meshopt-compressed
    tiles. Keeps manifest.json and each tile's lod0 + lod1 + bodies; skips the
    manifest's terrain.bin (objmap's decimated ground for draping its map
    image, not game collision). -> bytes on disk."""
    base = f"{OBJMAP}/static_compound/{mname}"
    man_path = os.path.join(d, "manifest.json")
    if force or not os.path.exists(man_path):
        man = fetch(f"{base}/manifest.json")
        if man is None:
            return 0
        os.makedirs(d, exist_ok=True)
        open(man_path, "wb").write(man)
    man = json.load(open(man_path))
    files = [t["bodies"]["file"] for t in man["tiles"]]
    files += [lod["file"] for t in man["tiles"] for lod in t["lods"][:2]]
    total = 0
    for f in files:
        path = os.path.join(d, f)
        if force or not os.path.exists(path):
            data = fetch(f"{base}/{f}")
            if data is None:
                print(f"  {mname}/{f}: missing")
                continue
            open(path, "wb").write(data)
        total += os.path.getsize(path)
    return total


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--only", nargs="*", help="map_name(s) to fetch (default: all)")
    ap.add_argument("--force", action="store_true", help="download files that already exist")
    ap.add_argument("--refresh-objects", action="store_true", help="download objects.json again (new fields)")
    args = ap.parse_args()

    # Area / loading zone shapes and classification (objmap's own tables):
    # actor_shapes.json (name -> primitive or point-set parts),
    # rigid_body_shape_actors.json (name -> default RigidBodyShapeType),
    # location_areas.json / void_out_areas.json (hash id -> location name / void out kind)
    os.makedirs(OUT, exist_ok=True)
    for name in ("actor_shapes.json", "rigid_body_shape_actors.json", "location_areas.json", "void_out_areas.json"):
        data = fetch(f"{OBJMAP}/{name}")
        if data is not None:
            open(os.path.join(OUT, name), "wb").write(data)

    maps = fetch_json(f"{OBJMAP}/maps.json")["areas"]
    area_names = fetch_json(f"{OBJMAP}/area_names.json") or {}
    map_names = fetch_json(f"{OBJMAP}/map_names.json") or {}

    used_names = set()
    entries = []
    for area in maps:
        for m in area["maps"]:
            mtype, mname = m["map_type"], m["map_name"]
            d = os.path.join(OUT, mtype, mname)
            col_path, obj_path = os.path.join(d, "collision.bin"), os.path.join(d, "objects.json")
            if args.only and mname not in args.only:
                if os.path.exists(obj_path):   # keep it in the map list
                    used_names.update(o["n"] for o in json.load(open(obj_path)))
                    entries.append((area, m, os.path.exists(col_path)))
                continue
            os.makedirs(d, exist_ok=True)

            if args.force or not os.path.exists(col_path):
                col = fetch(f"{OBJMAP}/actor_collision/{mtype}/{mname}.bin")
                if col is not None:
                    open(col_path, "wb").write(col)
            if args.force or args.refresh_objects or not os.path.exists(obj_path):
                q = urllib.parse.urlencode({"q": "*", "limit": -1, "withMapNames": "false",
                                            "dataFields": DATA_FIELDS})
                objs = fetch_json(f"{RADAR}/objs/{mtype}/{mname}?{q}") or []
                objs = [trim(o) for o in sorted(objs, key=lambda o: o["objid"])]
                with open(obj_path, "w", newline="\n") as f:
                    f.write("[\n" + ",\n".join(json.dumps(o, separators=(",", ":")) for o in objs) + "\n]\n")
            objs = json.load(open(obj_path))
            used_names.update(o["n"] for o in objs)
            has_col = os.path.exists(col_path)
            compound = fetch_compound(mname, os.path.join(d, "compound"), args.force)
            entries.append((area, m, has_col))
            size = os.path.getsize(col_path) if has_col else 0
            print(f"{mtype}/{mname}: {len(objs)} objects, collision {size / 1e6:.1f} MB, "
                  f"static compound {compound / 1e6:.1f} MB")

    # Air walls: only the meshes some map places
    meshes = fetch_json(f"{OBJMAP}/airwall_meshes.json") or {}
    tris = fetch_json(f"{OBJMAP}/airwall_mesh_triangles.json") or {}
    airwalls = {k: {"v": v["vertices"], "i": tris[k]} for k, v in sorted(meshes.items())
                if k in used_names and k in tris}
    with open(os.path.join(OUT, "airwalls.json"), "w", newline="\n") as f:
        json.dump(airwalls, f, separators=(",", ":"))
    print(f"airwalls.json: {len(airwalls)} meshes")

    # js/ootsw2_map_list.js
    lines = []
    for area, m, has_col in entries:
        area_label = area_names.get(area["id"], area["id"])
        label = map_names.get(m["map_name"])
        if not label:
            rest = m["map_name"][len(area["id"]):].lstrip("_").replace("_", " ") \
                if m["map_name"].startswith(area["id"]) else m["map_name"].replace("_", " ")
            label = f"{area_label} ({rest})" if rest else area_label
        lines.append("    " + json.dumps({"name": label, "group": GROUPS.get(area["kind"], area["kind"]),
                                          "dir": f"{m['map_type']}/{m['map_name']}",
                                          "collision": has_col, "age": m["age"],
                                          "bounds": [*m["bounds"]["x"], *m["bounds"]["z"]]},
                                         separators=(", ", ": ")) + ",")
    order = list(GROUPS.values())
    lines.sort(key=lambda l: order.index(json.loads(l.strip().rstrip(","))["group"]))
    with open(os.path.join(ROOT, "js", "ootsw2_map_list.js"), "w", newline="\n") as f:
        f.write("// Ocarina of Time (Switch 2) maps, written by tools/ootsw2/extract_objmap.py from the\n"
                "// Owl Object Map (objmap-oot.zeldamods.org). Each dir is models/OOTSW2/<map_type>/<map_name>/.\n"
                "const OOTSW2_Maps = [\n" + "\n".join(lines) + "\n];\n")
    print(f"js/ootsw2_map_list.js: {len(entries)} maps")


if __name__ == "__main__":
    sys.exit(main())
