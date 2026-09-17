#!/usr/bin/env python3
"""
Generate js/bk_object_list.js (BK actor / model / sprite name tables) from the
banjo-kazooie decomp's include/enums.h.

usage: generate_bk_object_list.py <path/to/banjo-kazooie> [out.js]

Names come from two places inside each enum block:
  - the enumerator itself, whose name embeds its hex id (ACTOR_2A_GOLD_BULLION,
    ASSET_14CF_MODEL_SM_SPIRAL_MOUNTAIN_OPA)
  - "// 2ff MM Tree" style comment lines the decomp uses for ids that have no
    enumerator yet

BK_Actor_Hitboxes comes from a static read of the actor code (see
parse_actor_hitboxes).
"""

import os
import re
import sys


def enum_block(src, name):
    m = re.search(r"enum %s\s*\{(.*?)\};" % name, src, re.S)
    if not m:
        sys.exit("enum %s not found" % name)
    return m.group(1)


def parse_names(block, prefix):
    names = {}
    for m in re.finditer(r"\b%s_([0-9A-Fa-f]+)_(\w+)" % prefix, block):
        names.setdefault(int(m.group(1), 16), m.group(2))
    return names


def parse_comment_names(block):
    """'// 2ff MM Tree' -> {0x2ff: 'MM Tree'}; 'Unused' lines are skipped."""
    names = {}
    for m in re.finditer(r"^\s*//\s*([0-9A-Fa-f]{2,4})\s+(.+?)\s*$", block, re.M):
        text = m.group(2).strip()
        if text.lower().startswith("unused"):
            continue
        names.setdefault(int(m.group(1), 16), text)
    return names


def parse_actor_models(repo):
    """actorId -> model asset id from every `ActorInfo x = { marker, actor, model, ...}` in src/.

    Ids are written either as enum names (which embed the hex id) or as plain
    numbers. ActorInfo.modelId is a raw asset id (assetcache_get(marker->modelId)),
    NOT offset by 0x2D1 like ModelProp.modelId. A model of 0 / NULL means the
    actor is invisible (a trigger); those are left out.
    """
    src = []
    for root, _dirs, files in os.walk(os.path.join(repo, "src")):
        for name in files:
            if name.endswith(".c"):
                with open(os.path.join(root, name), encoding="utf-8", errors="replace") as f:
                    src.append(f.read())
    src = "\n".join(src)

    def value(text, prefix):
        text = text.strip()
        m = re.match(r"%s_([0-9A-Fa-f]+)_" % prefix, text)
        if m:
            return int(m.group(1), 16)
        if re.fullmatch(r"0x[0-9A-Fa-f]+|\d+", text):
            return int(text, 0)
        return None

    models = {}
    for _marker, actor, model in re.findall(
            r"\bActorInfo\s+\w+\s*=\s*\{\s*([^,]+),\s*([^,]+),\s*([^,]+),", src, re.S):
        actor_id = value(actor, "ACTOR")
        model_id = value(model, "ASSET")
        if actor_id and model_id:
            models.setdefault(actor_id, model_id)
    return models


# ---- actor hitboxes
#
# Every actor's marker starts collidable (marker_init), and the game tests
# Banjo, eggs etc. against its touch sphere (func_803322F0 in code_A5BC0.c).
# A hit only matters, though, if something reacts to it:
#   - the collision table in code_B62B0.c lists the marker (generic damage /
#     hits-to-kill handling through func_8033D410),
#   - a sphere-query consumer special-cases the marker id: the player's
#     __baMarker_resolveCollision switch, the egg handler in code_CC1E0.c,
#     or an actor looking for others (clam, twinkly muncher),
#   - or the actor's own code installs a callback (marker_setCollisionScripts,
#     a direct collisionFunc / collision2Func / dieFunc store, func_803300B8),
#     which is found by walking the call graph from the ActorInfo's update /
#     draw functions (enemies register through shared code such as
#     humanoidBaddie_update).
# Anything else (stairs, signs, Bottles, molehills) has a sphere nothing looks
# at, so the viewer leaves it undrawn. The rest split into two kinds:
#   "enemy" - contact hurts Banjo: a collision-table row with damageToPlayer
#             set for some attack, or a player-handler case that sends the
#             player's own hurt / knockback callback (plyr_collision_type =
#             FUNC_1 / FUNC_2_DIE: Zubba, Clanker's sawblade, racing Boggy),
#   "touch" - everything else: collectibles, pads, switches, doors, NPCs.

STRIP_COMMENTS = re.compile(r"/\*.*?\*/|//[^\n]*", re.S)
FUNC_HEAD = re.compile(r"^[A-Za-z_][\w \t\*]*?\b(\w+)\s*\(([^;{}]*)\)\s*\{", re.M)
CALL = re.compile(r"\b([A-Za-z_]\w*)\s*\(")
REGISTERS = re.compile(
    r"\bmarker_setCollisionScripts\s*\(([^;]*)\)"
    r"|->\s*(collisionFunc|collision2Func|dieFunc)\s*=(?!\s*(NULL|0)\b)"
    r"|\bfunc_803300B8\s*\(([^;]*)\)")
MARKER_REF = re.compile(r"(?:\bcase\s+|==\s*)(MARKER_([0-9A-Fa-f]+)_\w+|0x[0-9A-Fa-f]+|\d+)\b")
SPHERE_QUERIES = ("func_80320EB0",)  # nearest collidable actor prop within a radius
NOT_FUNCTIONS = {"if", "for", "while", "switch", "return", "sizeof"}


def c_functions(src):
    """name -> body for every top-level function definition in one file."""
    out = {}
    for m in FUNC_HEAD.finditer(src):
        name = m.group(1)
        if name in NOT_FUNCTIONS:
            continue
        start = m.end() - 1
        depth = 0
        for i in range(start, len(src)):
            if src[i] == "{":
                depth += 1
            elif src[i] == "}":
                depth -= 1
                if depth == 0:
                    out.setdefault(name, src[start:i + 1])
                    break
    return out


def installs_callback(body):
    """True if the function stores a non-NULL collision callback on a marker."""
    for m in REGISTERS.finditer(body):
        args = m.group(1) if m.group(1) is not None else m.group(4)
        if args is None:
            return True
        if any(re.search(r"\b(?!NULL\b)[A-Za-z_]\w*", a) for a in args.split(",")[1:]):
            return True
    return False


def marker_value(text):
    m = re.match(r"MARKER_([0-9A-Fa-f]+)_", text)
    return int(m.group(1), 16) if m else int(text, 0)


def collision_damages_player(params):
    """CollisionParams (structs.h) is a u16 of playerInteraction:4, nextState:2,
    unkBit7:3, damageToPlayer:2, hitsToTrigger:3, dropBundleNum:2."""
    return (params >> 5) & 3


def parse_actor_hitboxes(repo):
    """actorId -> "enemy" / "touch" for actors whose touch sphere something reacts to."""
    defs = {}
    infos = []
    for root, _dirs, files in os.walk(os.path.join(repo, "src")):
        for name in files:
            if not name.endswith(".c"):
                continue
            with open(os.path.join(root, name), encoding="utf-8", errors="replace") as f:
                src = STRIP_COMMENTS.sub("", f.read())
            for fname, body in c_functions(src).items():
                defs.setdefault(fname, body)
            for m in re.finditer(r"\bActorInfo\s+\w+\s*=\s*\{(.*?)\};", src, re.S):
                fields = [x.strip() for x in m.group(1).split(",")]
                if len(fields) < 8:
                    continue
                roots = [x for x in fields[5:8] if re.fullmatch(r"\w+", x) and x not in ("NULL", "0")]
                infos.append((fields[0], fields[1], roots))

    calls = {name: {c for c in CALL.findall(body) if c in defs and c != name} for name, body in defs.items()}
    registering = {name for name, body in defs.items() if installs_callback(body)}

    reach_cache = {}

    def reaches(fn):
        if fn not in reach_cache:
            seen = set()
            stack = [fn]
            while stack:
                f = stack.pop()
                if f not in seen:
                    seen.add(f)
                    stack.extend(calls.get(f, ()))
            reach_cache[fn] = seen
        return reach_cache[fn]

    # Marker ids that a sphere-query consumer reacts to by id.
    reactive = set()
    handlers = ["__baMarker_resolveCollision"] + [
        name for name, body in defs.items() if any(q + "(" in body.replace(" ", "") for q in SPHERE_QUERIES)]
    for name in handlers:
        for m in MARKER_REF.finditer(defs.get(name, "")):
            reactive.add(marker_value(m.group(1)))

    # Player-handler cases that hurt the player. Split the switch at its
    # marker-id labels (inner switches use HITBOX_ labels, so they stay inside
    # their case) and look at each case group's code.
    enemies = set()
    player_handler = defs.get("__baMarker_resolveCollision", "")
    label = re.compile(r"case\s+(MARKER_\w+|0x[0-9A-Fa-f]+|\d+)\s*:")
    labels = list(label.finditer(player_handler))
    group = []
    for i, m in enumerate(labels):
        group.append(marker_value(m.group(1)))
        code = player_handler[m.end():labels[i + 1].start() if i + 1 < len(labels) else len(player_handler)]
        if not code.strip():
            continue  # fall-through label, shares the next case's code
        if re.search(r"plyr_collision_type\s*=\s*MARKER_COLLISION_FUNC_(1|2)", code):
            enemies.update(group)
        group = []

    # Marker ids in the collision table (code_B62B0.c), skipping all-zero rows;
    # collisionUnion is OR-ed into every attack's params at init.
    with open(os.path.join(repo, "src", "core2", "code_B62B0.c"), encoding="utf-8") as f:
        table_src = f.read()
    for m in re.finditer(r"\{\s*(MARKER_\w+|0x[0-9A-Fa-f]+|\d+)\s*,\s*(0x[0-9A-Fa-f]+|\d+)\s*,\s*\{([^}]*)\}", table_src):
        union = int(m.group(2), 0)
        params = [int(x, 0) | union for x in re.findall(r"0x[0-9A-Fa-f]+|\d+", m.group(3))]
        if union or any(params):
            reactive.add(marker_value(m.group(1)))
        if any(collision_damages_player(p) for p in params):
            enemies.add(marker_value(m.group(1)))

    hitboxes = {}
    for marker, actor, roots in infos:
        actor_id = re.match(r"ACTOR_([0-9A-Fa-f]+)_", actor)
        actor_id = int(actor_id.group(1), 16) if actor_id else (int(actor, 0) if re.fullmatch(r"0x[0-9A-Fa-f]+|\d+", actor) else None)
        if not actor_id:
            continue
        try:
            marker_id = marker_value(marker)
        except ValueError:
            marker_id = None
        reached = set().union(*(reaches(r) for r in roots)) if roots else set()
        if marker_id in enemies:
            hitboxes.setdefault(actor_id, "enemy")
        elif marker_id in reactive or (reached & registering):
            hitboxes.setdefault(actor_id, "touch")
    return hitboxes


def js_table(var, values, comment, fmt='"%s"'):
    lines = ["// %s" % comment, "const %s = {" % var]
    for uid in sorted(values):
        lines.append(("    0x%X: " + fmt + ",") % (uid, values[uid]))
    lines.append("};")
    return "\n".join(lines)


def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    repo = sys.argv[1]
    out = sys.argv[2] if len(sys.argv) > 2 else os.path.join(
        os.path.dirname(os.path.abspath(__file__)), "..", "..", "js", "bk_object_list.js")

    with open(os.path.join(repo, "include", "enums.h"), encoding="utf-8") as f:
        src = f.read()

    actors = parse_names(enum_block(src, "actor_e"), "ACTOR")

    asset_block = enum_block(src, "asset_e")
    asset_names = parse_names(asset_block, "ASSET")
    asset_comments = parse_comment_names(asset_block)

    # Enumerator names win over comments; strip the MODEL_/SPRITE_ prefix so
    # the table reads the same whichever source a name came from.
    models = {}
    sprites = {}
    for uid, name in asset_names.items():
        if name.startswith("MODEL_"):
            models[uid] = name[len("MODEL_"):]
        elif name.startswith("SPRITE_"):
            sprites[uid] = name[len("SPRITE_"):]
    for uid, text in asset_comments.items():
        if 0x2D1 <= uid < 0x572:
            models.setdefault(uid, text)
        elif 0x572 <= uid < 0x71C:
            sprites.setdefault(uid, text)

    actor_models = parse_actor_models(repo)
    actor_hitboxes = parse_actor_hitboxes(repo)

    header = (
        "// Generated by tools/bk/generate_bk_object_list.py from the banjo-kazooie\n"
        "// decomp's include/enums.h and the ActorInfo tables in src/. Do not edit by hand.\n"
        "//\n"
        "// Keys are the ids as they appear in a map's setup.bin:\n"
        "//   BK_Actor_Names  - NodeProp.actorId (enum actor_e)\n"
        "//   BK_Model_Names  - asset id; ModelProp.modelId + 0x2D1 (MODEL_ASSET_OFFSET)\n"
        "//   BK_Sprite_Names - asset id; SpriteProp.spriteId + 0x572 (SPRITE_ASSET_OFFSET)\n"
        "//   BK_Actor_Models - NodeProp.actorId -> model asset id (ActorInfo.modelId); invisible actors omitted\n"
        "//   BK_Actor_Hitboxes - NodeProp.actorId -> \"enemy\" (contact hurts Banjo) or \"touch\" (collectible, pad,\n"
        "//                       switch, door, NPC...) for actors whose touch sphere the game reacts to\n\n"
    )
    body = "\n\n".join([
        js_table("BK_Actor_Names", actors, "enum actor_e"),
        js_table("BK_Model_Names", models, "model assets 0x2D1..0x571"),
        js_table("BK_Sprite_Names", sprites, "sprite assets 0x572..0x71B"),
        js_table("BK_Actor_Models", {k: "0x%X" % v for k, v in actor_models.items()},
                 "ActorInfo.modelId per actor", fmt="%s"),
        js_table("BK_Actor_Hitboxes", actor_hitboxes,
                 "actors with a reactive touch sphere (see parse_actor_hitboxes)"),
    ])
    with open(out, "w", encoding="utf-8", newline="\n") as f:
        f.write(header + body + "\n")
    print("%s: %d actors, %d models, %d sprites, %d actor->model links, %d actor hitboxes" % (
        out, len(actors), len(models), len(sprites), len(actor_models), len(actor_hitboxes)))


if __name__ == "__main__":
    main()
