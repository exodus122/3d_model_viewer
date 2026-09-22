#!/usr/bin/env python3
"""
Generate js/oot_object_list.js -- what each OoT actor draws -- from the oot
decomp, and bring the object files those models live in over to
models/OOT/actors/objects (and overlays to models/OOT/actors/overlays).

usage: generate_oot_actor_models.py [path/to/oot] [version]

    path/to/oot   the oot decomp checkout (default: ../oot next to this repo)
    version       its baseroms/<version> (default: ntsc-1.0)

The decomp must have been extracted for that version (make setup), so that
extracted/<version>/baserom/ holds the decompressed object and overlay files.

OoT has no table saying which model an actor draws: every actor's own Draw
function issues the display lists, usually through a skeleton set up in its
Init. This script reads that out of each actor's C source:

  * ActorProfile                          -> object, Init / Draw function names
  * Actor_SetScale(&this->..., 0.01f)     -> scale (a literal in Init; anything
                                             computed is left for the hand table
                                             in js/oot_actors.js)
  * ActorShape_Init(&..., yOffset, ...)   -> shape.yOffset
  * SkelAnime_Init / SkelAnime_InitFlex   -> skeleton and the animation whose
                                             frame 0 poses it (falling back to
                                             the first Animation_Play* / the
                                             first animation the file names)
  * Gfx_DrawDListOpa / Xlu, gSPDisplayList(POLY_*_DISP++, ...) in Draw
                                          -> static display lists; an array
                                             (of lists, or of structs holding
                                             one) indexed by a PARAMS_GET_* of
                                             the actor's params becomes a
                                             selector; a member or variable is
                                             followed to its first assignment;
                                             the shared effect quads (gEff*) and
                                             drop shadows are skipped
  * Matrix_Translate / Rotate* / Scale with literal arguments before a list
    or the SkelAnime_Draw* in Draw   -> ops applied on top of the actor matrix
  * gDPSetPrimColor / gDPSetEnvColor with literal colours before them
                                     -> prim / env the list is drawn with
  * if (limbIndex == N) { ... } / switch (limbIndex) { case N: ... } in a
    SkelAnime limb callback           -> the list drawn in place of limb N
  * gSPSegment(POLY_*_DISP++, 0x08..0x0F, SEGMENTED_TO_VIRTUAL(tex)) in Draw
                                          -> the texture a segment stands for
                                             (eyes, mouths), first choice; with
                                             play->objectCtx.slots[..].segment,
                                             the whole object the actor loaded;
                                             with Gfx_TexScroll / TwoTexScroll,
                                             the tile sizes that list sets

Symbols are resolved to a file and offset through assets/xml/objects/*.xml
and assets/xml/overlays/*.xml (an overlay's data starts at the start_offset
its baseroms/<version>/config.yml entry gives, and its pointers are VRAM
addresses from baseroms/<version>/segments.csv).

Actors whose draw is not a plain skeleton or display list (skinned horses,
curve skeletons, effects, anything picking its model in code) come out with
whatever this finds, or nothing; js/oot_actors.js overrides them by hand.
"""

import csv
import glob
import json
import os
import re
import sys
import xml.etree.ElementTree as ET

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..", "..")
OUT_JS = os.path.join(ROOT, "js", "oot_object_list.js")
OBJECTS_OUT = os.path.join(ROOT, "models", "OOT", "actors", "objects")
OVERLAYS_OUT = os.path.join(ROOT, "models", "OOT", "actors", "overlays")

# Objects every actor may draw from without loading them: segment 4 and 5.
KEEP_OBJECTS = ["gameplay_keep", "gameplay_field_keep", "gameplay_dangeon_keep"]

# Files only the hand overrides in js/oot_actors.js reach (models drawn
# through code this does not follow, such as GetItem_Draw's tables).
EXTRA_FILES = ["object_gi_heart"]


def strip_comments(text):
    text = re.sub(r"/\*.*?\*/", " ", text, flags=re.S)
    text = re.sub(r"//[^\n]*", " ", text)
    return text


# ---- decomp tables


def read_actor_table(oot):
    """[(id, name)] from include/tables/actor_table.h, in table order."""
    actors = []
    with open(os.path.join(oot, "include", "tables", "actor_table.h"), encoding="utf-8") as f:
        for line in f:
            m = re.match(r"\s*/\*\s*0x([0-9A-Fa-f]+)\s*\*/\s*DEFINE_ACTOR(_INTERNAL)?\((\w+),", line)
            if m:
                actors.append((int(m.group(1), 16), m.group(3)))
    return actors


def read_object_table(oot):
    """{OBJECT_ENUM: (id, name)} from include/tables/object_table.h."""
    objects = {}
    with open(os.path.join(oot, "include", "tables", "object_table.h"), encoding="utf-8") as f:
        for line in f:
            m = re.match(r"\s*/\*\s*0x([0-9A-Fa-f]+)\s*\*/\s*DEFINE_OBJECT\((\w+),\s*(\w+)\)", line)
            if m:
                objects[m.group(3)] = (int(m.group(1), 16), m.group(2))
    return objects


# ---- asset symbols


def read_overlay_ranges(oot, version):
    """{ovl name: (start_offset, vram)}: where an overlay's extracted data sits."""
    starts = {}
    with open(os.path.join(oot, "baseroms", version, "config.yml"), encoding="utf-8") as f:
        name = None
        for line in f:
            m = re.match(r"- name: overlays/(\w+)", line)
            if m:
                name = m.group(1)
                continue
            m = re.match(r"\s+start_offset: (0x[0-9A-Fa-f]+)", line)
            if m and name:
                starts[name] = int(m.group(1), 16)
    vram = {}
    with open(os.path.join(oot, "baseroms", version, "segments.csv"), encoding="utf-8") as f:
        for row in csv.reader(f):
            if len(row) >= 2 and row[0].startswith("ovl_"):
                vram[row[0]] = int(row[1], 16)
    return {n: (s, vram.get(n)) for n, s in starts.items() if n in vram}


def read_symbols(oot, version):
    """
    {symbol: {file, offset, kind, ...}} for every named asset in the object
    and overlay XMLs. kind is the XML tag (DList, Skeleton, Animation,
    Texture, ...); skeletons also carry type / limbType.
    """
    symbols = {}
    ranges = read_overlay_ranges(oot, version)
    for sub in ("objects", "overlays"):
        for path in sorted(glob.glob(os.path.join(oot, "assets", "xml", sub, "*.xml"))):
            try:
                root = ET.parse(path).getroot()
            except ET.ParseError as e:
                print(f"warning: {path}: {e}", file=sys.stderr)
                continue
            for file_el in root.findall("File"):
                fname = file_el.attrib["Name"]
                if sub == "overlays":
                    if fname not in ranges:
                        continue
                    data_start, vram = ranges[fname]
                else:
                    data_start, vram = 0, None
                for el in file_el:
                    name, off = el.attrib.get("Name"), el.attrib.get("Offset")
                    if not name or off is None:
                        continue
                    if name in symbols:
                        continue  # PAL / iQue duplicates of the same symbol
                    entry = {"file": fname, "offset": data_start + int(off, 16), "kind": el.tag,
                             "overlay": sub == "overlays"}
                    if vram is not None:
                        entry["vram"] = vram
                    if el.tag == "Skeleton":
                        entry["type"] = el.attrib.get("Type", "Normal")
                        entry["limbType"] = el.attrib.get("LimbType", "Standard")
                    symbols[name] = entry
    return symbols


# ---- actor source mining


def function_body(text, name):
    """The braces body of `... name(...) {`, or ''."""
    m = re.search(r"\b" + re.escape(name) + r"\s*\([^)]*\)\s*\{", text)
    if not m:
        return ""
    depth, i = 0, m.end() - 1
    while i < len(text):
        if text[i] == "{":
            depth += 1
        elif text[i] == "}":
            depth -= 1
            if depth == 0:
                return text[m.end():i]
        i += 1
    return text[m.end():]


def static_arrays(text, symbols):
    """
    {name: [symbols]} for every `type name[] = { a, &b, ... }` initializer,
    and for a struct array `{ { gADL, 0.01f, ... }, { gBDL, ... } }` the
    first display list of each element (when every element has one), so
    that sParams[type].dList indexes it like a plain list array.
    """
    arrays = {}
    for m in re.finditer(r"\b(\w+)\s*\[\s*\w*\s*\]\s*=\s*\{(.*?)\}\s*;", text, flags=re.S):
        body = m.group(2).replace("\n", " ")
        elements = re.findall(r"\{([^{}]*)\}", body)
        if elements:
            firsts = []
            for el in elements:
                dls = [t.strip().lstrip("&").strip() for t in el.split(",")]
                dls = [t for t in dls if t in symbols and symbols[t]["kind"] == "DList"]
                firsts.append(dls[0] if dls else None)
            # An element without a list (NULL) becomes an empty variant.
            if any(firsts):
                arrays[m.group(1)] = [t or "NULL" for t in firsts]
            continue
        items = [t.strip().lstrip("&").strip() for t in body.split(",")]
        items = [t for t in items if t]
        if items and all(re.match(r"^\w+$", t) for t in items):
            arrays[m.group(1)] = items
    return arrays


def assignments(text):
    """{name: [rhs]} for every `x = rhs;` / `this->x = rhs;` in the file."""
    out = {}
    for m in re.finditer(r"(?:->|\.|\b)(\w+)\s*(?<![=!<>+\-*/&|])=(?!=)\s*([^;{}]+?)\s*;", text):
        rhs = m.group(2).strip()
        if rhs and not re.match(r"^[-0-9.]", rhs):
            out.setdefault(m.group(1), []).append(rhs)
    return out


# An index expression on the actor's params, as (shift, mask).
PARAM_INDEX = [
    (re.compile(r"PARAMS_GET_[US]\(\s*[^,]*params[^,]*,\s*(\d+)\s*,\s*(\d+)\s*\)"), lambda m: (int(m.group(1)), (1 << int(m.group(2))) - 1)),
    (re.compile(r"PARAMS_GET_NOMASK\(\s*[^,]*params[^,]*,\s*(\d+)\s*\)"), lambda m: (int(m.group(1)), 0xFFFF >> int(m.group(1)))),
    (re.compile(r"\(?\s*[\w>.()-]*params\)?\s*>>\s*(\d+)\s*\)?\s*&\s*(0x[0-9A-Fa-f]+|\d+)"), lambda m: (int(m.group(1)), int(m.group(2), 0))),
    (re.compile(r"[\w>.()-]*params\)?\s*&\s*(0x[0-9A-Fa-f]+|\d+)"), lambda m: (0, int(m.group(1), 0))),
]


def expand_macros(text):
    """
    Expand the file's own one-argument function-like macros
    (#define MOVEBG_TYPE(params) PARAMS_GET_U((u16)(params), 12, 4)), so a
    params field read through one still looks like a PARAMS_GET_*.
    """
    text = re.sub(r"\\\n", " ", text)
    macros = {}
    for m in re.finditer(r"#define\s+(\w+)\((\w+)\)\s+([^\n]+)", text):
        macros[m.group(1)] = (m.group(2), m.group(3).strip())
    for name, (arg, body) in macros.items():
        rx = re.compile(r"\b" + re.escape(name) + r"\(([^()]*(?:\([^()]*\)[^()]*)*)\)")
        text = rx.sub(lambda m: "(" + re.sub(r"\b" + re.escape(arg) + r"\b", "(" + m.group(1) + ")", body) + ")", text)
    return text


# A bare `thisx->params` index takes the whole word, unless the actor's Init
# has already masked it (params &= 0xFF, the upper byte being a flag).
BARE_PARAMS_RX = re.compile(r"^[\s()]*(?:\(\w+\)\s*)?(?:this\s*->\s*(?:dyna\s*\.\s*)?actor\s*\.|thisx\s*->\s*|this\s*->\s*actor\s*\.)?params[\s()]*$")
bare_params_mask = 0xFFFF


def param_selector(expr):
    for rx, fn in PARAM_INDEX:
        m = rx.search(expr)
        if m:
            return fn(m)
    if BARE_PARAMS_RX.match(expr):
        return (0, bare_params_mask)
    return None


def function_names(text):
    """Every function defined in the file."""
    return set(re.findall(r"\b(\w+)\s*\([^;{}]*\)\s*\{", text))


DL_RX = re.compile(r"(?:Gfx_DrawDList(Opa|Xlu)\s*\(\s*play\s*,\s*|gSPDisplayList\s*\(\s*POLY_(OPA|XLU)_DISP\+\+\s*,\s*)([^;]+?)\)\s*;")


# Lists that are never the actor's own model: the shared effect quads
# (gEffFire1DL, gEffDustDL ...) and drop shadows, which actors draw under a
# matrix of their own (Obj_Syokudai scales its flame by 0.0027; drawn at
# the actor's matrix it is a 16000-unit quad).
EFFECT_DL_RX = re.compile(r"^gEff|Shadow")


def index_selector(expr, assigned):
    """param_selector of an index expression, following a local (type = PARAMS_GET_U(...)) one step."""
    sel = None if BARE_PARAMS_RX.match(expr) else param_selector(expr)
    if sel:
        return sel
    vm = re.match(r"^\s*(?:this\s*->\s*)?(\w+)\s*$", expr)
    if vm:
        for rhs in assigned.get(vm.group(1), []):
            sel = param_selector(rhs)
            if sel:
                return sel
    if BARE_PARAMS_RX.match(expr):
        # The actor may rewrite its params in Init (params = TYPE(params)):
        # use that field, or the first variant when it cannot be read. A
        # rewrite to a constant (a type forced on one branch) changes nothing.
        rewrites = [rhs for rhs in assigned.get("params", []) if "params" in rhs]
        for rhs in rewrites:
            sel = param_selector(rhs)
            if sel:
                return sel
        return (0, 0) if rewrites else (0, bare_params_mask)
    return None


def resolve_list_expr(expr, arrays, symbols, assigned, layer, depth=0):
    """
    A display-list expression -> {sym, layer} | {variants, select} | None:
    a symbol, an array element (sDLists[PARAMS_GET_U(...)], sParams[i].dList),
    or a variable / member the file assigns one of those to (this->dList =
    sDLists[type] in Init, drawn in Draw) -- its first assignment.
    """
    expr = expr.strip()
    am = re.match(r"^(\w+)\s*\[(.+)\]\s*(?:\.\s*\w+)?$", expr, flags=re.S)
    is_dl = lambda t: t in symbols and symbols[t]["kind"] == "DList" and not EFFECT_DL_RX.search(t)
    if am and am.group(1) in arrays:
        items = arrays[am.group(1)]
        if all(is_dl(t) or t == "NULL" for t in items) and any(is_dl(t) for t in items):
            return {"variants": [[{"sym": t, "layer": layer}] if t != "NULL" else [] for t in items],
                    "select": index_selector(am.group(2), assigned)}
        return None
    if re.match(r"^\w+$", expr) and is_dl(expr):
        return {"sym": expr, "layer": layer}
    vm = re.match(r"^(?:\(?\s*\w+\s*\)?\s*->\s*|\w+\s*\.\s*)?(\w+)$", expr)
    if vm and depth < 3:
        for rhs in assigned.get(vm.group(1), []):
            r = resolve_list_expr(rhs, arrays, symbols, assigned, layer, depth + 1)
            if r:
                return r
    return None


# Literal matrix operations a Draw applies on top of the actor's matrix
# before issuing a list or drawing the skeleton (En_Jj: Matrix_Scale(10);
# Bg_Mori_Hineri: Matrix_Put(&mtx), Translate, RotateY, Scale(0.01) for the
# chest it embeds). Matrix_Put / Push / Pop start again from the actor's.
MATRIX_OP_RX = re.compile(
    r"Matrix_(Put|Push|Pop)\s*\(|MTXMODE_NEW|"
    r"Matrix_(Translate|Scale)\s*\(\s*([^,()]+),\s*([^,()]+),\s*([^,()]+),\s*MTXMODE_APPLY\s*\)|"
    r"Matrix_Rotate([XYZ])\s*\(\s*([^,]+?),\s*MTXMODE_APPLY\s*\)")


def literal_number(expr):
    """A numeric literal, or None."""
    m = re.match(r"^\s*(-?[0-9]*\.?[0-9]+)f?\s*$", expr)
    return float(m.group(1)) if m else None


def literal_angle(expr):
    """An angle in radians from a literal, M_PI expression or BINANG_TO_RAD(literal), or None."""
    expr = expr.strip()
    m = re.match(r"^(-?)M_PI(?:\s*/\s*([0-9.]+))?$", expr)
    if m:
        v = 3.141592653589793 / (float(m.group(2)) if m.group(2) else 1)
        return -v if m.group(1) else v
    m = re.match(r"^BINANG_TO_RAD(?:_ALT)?\s*\(\s*(-?0x[0-9A-Fa-f]+|-?\d+)\s*\)$", expr)
    if m:
        return int(m.group(1), 0) * 3.141592653589793 / 0x8000
    m = re.match(r"^DEG_TO_RAD\s*\(\s*(-?[0-9]*\.?[0-9]+)f?\s*\)$", expr)
    if m:
        return float(m.group(1)) * 3.141592653589793 / 180
    return literal_number(expr)


def matrix_ops_before(body, pos):
    """
    [["t", x, y, z] | ["s", x, y, z] | ["rx"|"ry"|"rz", radians]] applied
    since the matrix was last reset, in order; [] when none. An operation
    with a non-literal argument is skipped. A leading ["new"] marks a
    matrix built with MTXMODE_NEW, i.e. without the actor's scale.
    """
    ops = []
    for m in MATRIX_OP_RX.finditer(body[:pos]):
        if m.group(0) == "MTXMODE_NEW":
            # Built from scratch (Matrix_Translate(world.pos, MTXMODE_NEW)):
            # the actor's scale is not part of it. Its position and any
            # rotation from the actor's own fields come back non-literal.
            ops = [["new"]]
        elif m.group(1):
            ops = []
        elif m.group(2):
            v = [literal_number(m.group(i)) for i in (3, 4, 5)]
            if None in v:
                # Matrix_Scale(this->actor.scale.x, ...) after MTXMODE_NEW puts
                # the actor's scale back: that is the actor matrix again.
                if m.group(2) == "Scale" and ops and ops[0] == ["new"]:
                    ops.pop(0)
            elif v != ([0.0, 0.0, 0.0] if m.group(2) == "Translate" else [1.0, 1.0, 1.0]):
                ops.append([m.group(2)[0].lower()] + v)
        elif m.group(6):
            a = literal_angle(m.group(7))
            if a:
                # Two rotations about one axis in a row are the branches of
                # an if / else; the else (the flag-not-set default) wins.
                if ops and ops[-1][0] == "r" + m.group(6).lower():
                    ops.pop()
                ops.append(["r" + m.group(6).lower(), a])
    return ops


# gDPSetPrimColor(POLY_*_DISP++, m, l, r, g, b, a) / gDPSetEnvColor(POLY_*_DISP++, r, g, b, a)
COLOR_RX = re.compile(r"gDP(Set(?:Prim|Env)Color)\s*\(\s*POLY_(?:OPA|XLU)_DISP\+\+\s*,\s*([^;]*?)\)\s*;")


def colors_before(body, pos):
    """
    {"prim": [r, g, b, a], "env": [...]} from the last literal
    gDPSetPrimColor / gDPSetEnvColor issued before pos in body (an alpha
    that is computed counts as 255), for lists whose combiner takes the
    colour from the Draw rather than from the list itself.
    """
    out = {}
    for m in COLOR_RX.finditer(body[:pos]):
        args = split_args(m.group(2))
        if m.group(1) == "SetPrimColor":
            args = args[2:]
        if len(args) != 4:
            continue
        rgb = [literal_number(a) for a in args[:3]]
        if None in rgb:
            continue
        alpha = literal_number(args[3])
        out["prim" if m.group(1) == "SetPrimColor" else "env"] = [int(v) for v in rgb] + [int(alpha) if alpha is not None else 255]
    return out


def lists_in(text, body, arrays, symbols, functions, seen):
    """
    The display lists a function body issues: [{sym, layer}] for plain
    symbols, [{variants: [[...], ...], select: [shift, mask]}] for a
    params-indexed array of lists or of draw functions. Calls into other
    functions of the file are followed; functions passed as arguments
    (SkelAnime limb callbacks) are not, since those draw inside a limb.
    """
    lists = []
    for m in DL_RX.finditer(body):
        layer = (m.group(1) or m.group(2)).lower()
        expr = m.group(3).strip()
        if EFFECT_DL_RX.search(expr):
            continue
        r = resolve_list_expr(expr, arrays, symbols, functions.assigned, layer)
        if r:
            ops = matrix_ops_before(body, m.start())
            if ops:
                r["ops"] = ops
            r.update(colors_before(body, m.start()))
            lists.append(r)
    # sDrawFuncs[PARAMS_GET_U(...)](this, play): one variant per function
    for m in re.finditer(r"\b(\w+)\s*\[(.+?)\]\s*\(\s*this", body):
        items = arrays.get(m.group(1))
        if items and all(fn in functions for fn in items):
            variants = []
            for fn in items:
                if fn in seen:
                    variants.append([])
                    continue
                seen.add(fn)
                variants.append(lists_in(text, function_body(text, fn), arrays, symbols, functions, seen))
            lists.append({"variants": variants, "select": index_selector(m.group(2), functions.assigned)})
    for m in re.finditer(r"\b(\w+)\s*\(", body):
        fn = m.group(1)
        if fn in seen or fn not in functions:
            continue
        seen.add(fn)
        lists.extend(lists_in(text, function_body(text, fn), arrays, symbols, functions, seen))
    return lists


LIMB_DL_RX = re.compile(r"(?:gSPDisplayList\s*\(\s*(?:\(\*gfx\)\+\+|POLY_(?:OPA|XLU)_DISP\+\+|gfx\+\+)\s*,\s*|\*dList\s*=\s*)(\w+)")


def enum_values(text):
    """{name: value} for every enumerator in the file's typedef enums."""
    values = {}
    for m in re.finditer(r"typedef\s+enum\s*\w*\s*\{([^}]*)\}", text):
        n = 0
        for item in m.group(1).split(","):
            item = item.strip()
            if not item:
                continue
            em = re.match(r"(\w+)\s*(?:=\s*(-?\w+))?", item)
            if not em:
                continue
            if em.group(2):
                try:
                    n = int(em.group(2), 0)
                except ValueError:
                    continue
            values[em.group(1)] = n
            n += 1
    return values


def balanced_block(text, start):
    """text from the '{' at start to its matching '}' (exclusive)."""
    depth = 0
    for i in range(start, len(text)):
        if text[i] == "{":
            depth += 1
        elif text[i] == "}":
            depth -= 1
            if depth == 0:
                return text[start + 1:i]
    return text[start + 1:]


def limb_lists(text, arrays, symbols, enums):
    """
    {limbIndex: [symbol]}: the display lists a SkelAnime limb callback
    (a function passed to SkelAnime_Draw*) issues, or substitutes into the
    limb (*dList = ...), inside an `if (limbIndex == N)` block. limbIndex is
    the callback's 1-based index. The first list of a block is taken, which
    is the default branch of a type switch inside it.
    """
    callbacks = set()
    for m in re.finditer(r"SkelAnime_Draw\w*\s*\(([^;]*)\)\s*;", text):
        for arg in m.group(1).split(","):
            arg = arg.strip()
            if re.match(r"^\w+$", arg) and arg != "NULL" and re.search(r"\b" + arg + r"\s*\([^;{}]*\)\s*\{", text):
                callbacks.add(arg)
    limbs = {}

    def limb_index(name):
        idx = enums.get(name)
        if idx is None:
            try:
                idx = int(name, 0)
            except ValueError:
                return None
        return idx

    def add(idx, block):
        for dm in LIMB_DL_RX.finditer(block):
            sym = dm.group(1)
            if sym in arrays:
                sym = arrays[sym][0]
            if sym in symbols and symbols[sym]["kind"] == "DList":
                limbs.setdefault(idx, [])
                if sym not in limbs[idx]:
                    limbs[idx].append(sym)
                return

    for fn in callbacks:
        body = function_body(text, fn)
        for m in re.finditer(r"limbIndex\s*==\s*(\w+)\s*\)\s*\{", body):
            idx = limb_index(m.group(1))
            if idx is not None:
                add(idx, balanced_block(body, m.end() - 1))
        # switch (limbIndex) { case N: ... break; }: fall-through labels share
        # the statements that follow them.
        for m in re.finditer(r"switch\s*\(\s*limbIndex\s*\)\s*\{", body):
            block = balanced_block(body, m.end() - 1)
            parts = re.split(r"\bcase\s+(\w+)\s*:", block)
            pending = []
            for label, stmts in zip(parts[1::2], parts[2::2]):
                pending.append(label)
                if stmts.strip():
                    for name in pending:
                        idx = limb_index(name)
                        if idx is not None:
                            add(idx, stmts)
                    pending = []
    return limbs


class FileFunctions(set):
    """The file's function names, carrying its variable assignments too."""
    def __init__(self, text):
        super().__init__(function_names(text))
        self.assigned = assignments(text)


def draw_lists(text, draw_fns, arrays, symbols):
    functions = FileFunctions(text)
    seen = set(draw_fns)
    lists = []
    for fn in draw_fns:
        lists.extend(lists_in(text, function_body(text, fn), arrays, symbols, functions, seen))
    return lists


# A literal, or a product / quotient of two (36.0f * 0.001f, 1.0f / 75.0f).
SCALE_LITERAL = r"((?:-?[0-9]*\.?[0-9]+f?\s*[*/]\s*)?-?[0-9]*\.?[0-9]+)f?"


def literal_value(text):
    m = re.match(r"^\s*(-?[0-9]*\.?[0-9]+)f?\s*([*/])\s*(-?[0-9]*\.?[0-9]+)\s*$", text)
    if m:
        a, b = float(m.group(1)), float(m.group(3))
        return a * b if m.group(2) == "*" else (a / b if b else 0.0)
    return float(text)


def find_scale(text, init_body):
    """
    A literal scale, or None: Actor_SetScale / scale.x = in Init, else the
    init chain's ICHAIN_VEC3F(_DIV1000)(scale, n) (Actor_ProcessInitChain
    runs it from Init), else the first Actor_SetScale literal anywhere in the
    file (a setup function Init calls).
    """
    # A zero is a spawn-in / hidden state, never the size the actor is seen at.
    for body in (init_body, text):
        for rx, conv in (
            (r"Actor_SetScale\s*\([^,]+,\s*" + SCALE_LITERAL + r"\s*\)", literal_value),
            (r"scale\.x\s*=\s*" + SCALE_LITERAL + r"\s*;", literal_value),
            (r"ICHAIN_VEC3F_DIV1000\s*\(\s*scale\s*,\s*(\d+)", lambda v: int(v) / 1000),
            (r"ICHAIN_VEC3F\s*\(\s*scale\s*,\s*" + SCALE_LITERAL, literal_value),
        ):
            for m in re.finditer(rx, body):
                v = conv(m.group(1))
                if v:
                    return v
    return None


def find_y_offset(text, init_body):
    """
    shape.yOffset, which Actor_Draw adds (times scale.y) to the position the
    model is drawn at: ActorShape_Init's second argument or a direct store,
    in Init first, else anywhere in the file. None when never set (0).
    """
    for body in (init_body, text):
        m = re.search(r"ActorShape_Init\s*\([^,]+,\s*" + SCALE_LITERAL + r"\s*,", body)
        if m and literal_value(m.group(1)):
            return literal_value(m.group(1))
        m = re.search(r"shape\.yOffset\s*=\s*" + SCALE_LITERAL + r"\s*;", body)
        if m and literal_value(m.group(1)):
            return literal_value(m.group(1))
    return None


def find_skeleton(text, arrays, symbols):
    """(skeleton symbol, animation symbol) from the actor's SkelAnime setup, or (None, None)."""
    m = re.search(r"SkelAnime_Init(?:Flex)?\s*\(\s*play\s*,\s*&?[^,]+,\s*(?:\([^)]*\))?\s*&?(\w+)(?:\[[^\]]*\])?\s*,\s*(?:\([^)]*\))?\s*&?(\w+)(?:\[[^\]]*\])?\s*,", text)
    if not m:
        return None, None
    skel, anim = m.group(1), m.group(2)
    if skel in arrays:
        skel = arrays[skel][0]
    if skel not in symbols or symbols[skel]["kind"] != "Skeleton":
        return None, None
    if anim in arrays:
        anim = arrays[anim][0]
    if anim not in symbols or symbols[anim]["kind"] != "Animation":
        anim = None
        for pm in re.finditer(r"Animation_(?:PlayLoop|PlayOnce|PlayOnceSetSpeed|PlayLoopSetSpeed|Change|MorphToLoop|MorphToPlayOnce)\s*\(\s*&[^,]+,\s*&?(\w+)", text):
            cand = pm.group(1)
            if cand in arrays:
                cand = arrays[cand][0]
            if cand in symbols and symbols[cand]["kind"] == "Animation":
                anim = cand
                break
    if anim is None:
        # First animation of the skeleton's object the file names at all.
        obj = symbols[skel]["file"]
        for cand in re.findall(r"\b(\w+)\b", text):
            if cand in symbols and symbols[cand]["kind"] == "Animation" and symbols[cand]["file"] == obj:
                anim = cand
                break
    return skel, anim


def split_args(text):
    """Top-level comma split of a call's argument text."""
    args, depth, cur = [], 0, ""
    for ch in text:
        if ch == "(":
            depth += 1
        elif ch == ")":
            depth -= 1
        if ch == "," and depth == 0:
            args.append(cur.strip())
            cur = ""
        else:
            cur += ch
    if cur.strip():
        args.append(cur.strip())
    return args


def tile_arg(text):
    text = text.strip()
    if text == "G_TX_RENDERTILE":
        return 0
    try:
        return int(text, 0)
    except ValueError:
        return None


def find_scroll_segments(draw_body):
    """
    {segment: [[tile, width, height], ...]} for gSPSegment(..., 0x08,
    Gfx_TexScroll / Gfx_TwoTexScroll[EnvColor](gfxCtx, [tile,] x, y, w, h, ...)):
    the list those build is a gDPSetTileSize per tile, which the object's
    texture list jumps into; without it a tile keeps no size and the texture
    collapses to one texel. The scroll offsets (x, y) are frame counters,
    taken as 0.
    """
    segs = {}
    for m in re.finditer(r"gSPSegment\s*\(\s*POLY_(?:OPA|XLU)_DISP\+\+\s*,\s*(0x0?[89A-Fa-f]|\d+)\s*,\s*Gfx_(Two)?TexScroll(?:EnvColor)?\s*\(", draw_body):
        seg = int(m.group(1), 0)
        if seg in segs:
            continue
        args = split_args(balanced_paren(draw_body, m.end() - 1))[1:]
        tiles = []
        if m.group(2):
            for i in (0, 5):
                if len(args) >= i + 5:
                    tiles.append((tile_arg(args[i]), tile_arg(args[i + 3]), tile_arg(args[i + 4])))
        elif len(args) >= 4:
            tiles.append((0, tile_arg(args[2]), tile_arg(args[3])))
        tiles = [list(t) for t in tiles if None not in t]
        if tiles:
            segs[seg] = tiles
    return segs


def balanced_paren(text, start):
    """text from the '(' at start to its matching ')' (exclusive)."""
    depth = 0
    for i in range(start, len(text)):
        if text[i] == "(":
            depth += 1
        elif text[i] == ")":
            depth -= 1
            if depth == 0:
                return text[start + 1:i]
    return text[start + 1:]


def find_segments(draw_body, arrays, symbols, text=None, object_table=None):
    """
    {segment: texture symbol | ("object", file)} for the segment setups in
    Draw: an eye / mouth texture (SEGMENTED_TO_VIRTUAL), or a whole object
    the actor loaded into a slot (play->objectCtx.slots[this->slot].segment,
    with slot = Object_GetSlot(..., OBJECT_X) elsewhere in the file).
    """
    segs = {}
    if text is not None and object_table is not None:
        slots = {m.group(1): m.group(2) for m in re.finditer(r"(\w+)\s*=\s*Object_GetSlot\s*\(\s*&play\w*->objectCtx\s*,\s*(OBJECT_\w+)\s*\)", text)}
        for m in re.finditer(r"gSPSegment\s*\(\s*POLY_(?:OPA|XLU)_DISP\+\+\s*,\s*(0x0?[89A-Fa-f]|\d+)\s*,\s*play\w*->objectCtx\.slots\[\s*this->(\w+)\s*\]\.segment\s*\)", draw_body):
            seg = int(m.group(1), 0)
            obj = object_table.get(slots.get(m.group(2)))
            if obj and seg not in segs:
                segs[seg] = ("object", obj[1])
    for m in re.finditer(r"gSPSegment\s*\(\s*POLY_(?:OPA|XLU)_DISP\+\+\s*,\s*(0x0?[89A-Fa-f]|\d+)\s*,\s*SEGMENTED_TO_VIRTUAL\s*\(\s*(\w+)(\[[^\]]*\])?\s*\)\s*\)", draw_body):
        seg = int(m.group(1), 0)
        sym = m.group(2)
        if m.group(3):
            if sym not in arrays:
                continue
            sym = arrays[sym][0]
        if sym in symbols and symbols[sym]["kind"] == "Texture" and seg not in segs:
            segs[seg] = sym
    return segs


def header_text(oot, name):
    """The actor's .h files, for its limb enums."""
    text = ""
    for path in sorted(glob.glob(os.path.join(oot, "src", "overlays", "actors", "ovl_" + name, "*.h"))):
        with open(path, encoding="utf-8", errors="replace") as f:
            text += "\n" + f.read()
    return strip_comments(text)


def internal_actor_sources(oot):
    """{profile name: path} for the actors built into the main code (src/code)."""
    sources = {}
    for path in sorted(glob.glob(os.path.join(oot, "src", "code", "*.c"))):
        with open(path, encoding="utf-8", errors="replace") as f:
            for m in re.finditer(r"ActorProfile\s+(\w+)_Profile\s*=", f.read()):
                sources[m.group(1)] = path
    return sources


def read_actor(oot, name, symbols, object_table, internal):
    src_dir = os.path.join(oot, "src", "overlays", "actors", "ovl_" + name)
    if os.path.isdir(src_dir):
        paths = sorted(glob.glob(os.path.join(src_dir, "*.c")))
    elif name in internal:
        paths = [internal[name]]
    else:
        return None
    text = ""
    for path in paths:
        with open(path, encoding="utf-8", errors="replace") as f:
            text += "\n" + f.read()
    text = expand_macros(strip_comments(header_text(oot, name) + text))
    global bare_params_mask
    bare_params_mask = 0xFF if re.search(r"params\s*&=\s*0xFF\b", text) else 0xFFFF

    profile = re.search(r"ActorProfile\s+\w+\s*=\s*\{([^}]*)\}", text)
    if not profile:
        return None
    fields = [s.strip() for s in profile.group(1).split(",")]
    fields = [s for s in fields if s]
    if len(fields) < 9:
        return None
    obj_enum, init_fn, draw_fn = fields[3], fields[5], fields[8]
    obj = object_table.get(obj_enum)

    arrays = static_arrays(text, symbols)
    init_body = function_body(text, init_fn) if init_fn != "NULL" else ""

    # Many actors leave the profile's draw NULL and install one once their
    # object has loaded (actor.draw = ObjTsubo_Draw); those count too.
    draw_fns = [] if draw_fn == "NULL" else [draw_fn]
    for m in re.finditer(r"(?:actor|thisx|dyna\.actor)\s*(?:\.|->)\s*draw\s*=\s*(\w+)\s*;", text):
        if m.group(1) not in draw_fns and m.group(1) != "NULL":
            draw_fns.append(m.group(1))
    draw_body = "\n".join(function_body(text, fn) for fn in draw_fns)

    skel, anim = find_skeleton(text, arrays, symbols)
    skel_ops, skel_colors = [], {}
    for fn in draw_fns:
        fbody = function_body(text, fn)
        dm = re.search(r"SkelAnime_Draw\w*\s*\(", fbody)
        if dm:
            skel_ops = matrix_ops_before(fbody, dm.start())
            skel_colors = colors_before(fbody, dm.start())
            break
    lists = draw_lists(text, draw_fns, arrays, symbols) if draw_fns else []
    limbs = limb_lists(text, arrays, symbols, enum_values(text)) if skel else {}
    segs = find_segments(draw_body, arrays, symbols, text, object_table) if draw_body else {}
    for seg, tiles in (find_scroll_segments(draw_body) if draw_body else {}).items():
        segs.setdefault(seg, ("scroll", tiles))

    return {
        "object": obj[1] if obj else None,
        "objectId": obj[0] if obj else None,
        "scale": find_scale(text, init_body),
        "yOffset": find_y_offset(text, init_body),
        "skeleton": skel,
        "skelOps": skel_ops,
        "skelColors": skel_colors,
        "anim": anim,
        "lists": lists,
        "limbLists": limbs,
        "segments": segs,
        "hasDraw": bool(draw_fns),
    }


# ---- output


def js_ref(symbols, sym):
    s = symbols[sym]
    ref = {"file": s["file"], "offset": s["offset"]}
    if s.get("overlay"):
        ref["vram"] = s["vram"]
    return ref


def fmt_ref(ref):
    if "scroll" in ref:
        return "{ scroll: [%s] }" % ", ".join("[%d, %d, %d]" % tuple(t) for t in ref["scroll"])
    parts = ['file: "%s"' % ref["file"], "offset: 0x%X" % ref["offset"]]
    if "vram" in ref:
        parts.append("vram: 0x%X" % ref["vram"])
    for k in ("type", "limbType"):
        if k in ref:
            parts.append('%s: "%s"' % (k, ref[k]))
    return "{ " + ", ".join(parts) + " }"


def fmt_ops(ops):
    return "[" + ", ".join("[" + ", ".join(('"%s"' % v) if isinstance(v, str) else repr(round(v, 6)) for v in op) + "]" for op in ops) + "]"


def fmt_list(l):
    if "variants" in l:
        sel = ("[%d, 0x%X]" % tuple(l["select"])) if l["select"] else "null"
        variants = ", ".join("[" + ", ".join(fmt_list(x) for x in v) + "]" for v in l["variants"])
        return "{ select: %s, variants: [%s] }" % (sel, variants)
    extra = (", ops: " + fmt_ops(l["ops"])) if l.get("ops") else ""
    for k in ("prim", "env"):
        if l.get(k):
            extra += ", %s: [%s]" % (k, ", ".join(str(v) for v in l[k]))
    return '{ %s, layer: "%s"%s } /* %s */' % (fmt_ref(l)[2:-2], l["layer"], extra, l["name"])


def main():
    oot = sys.argv[1] if len(sys.argv) > 1 else os.path.join(ROOT, "..", "oot")
    version = sys.argv[2] if len(sys.argv) > 2 else "ntsc-1.0"
    baserom = os.path.join(oot, "extracted", version, "baserom")
    if not os.path.isdir(baserom):
        sys.exit(f"{baserom}: not found (run the decomp's setup for {version})")

    symbols = read_symbols(oot, version)
    object_table = read_object_table(oot)
    actors = read_actor_table(oot)
    internal = internal_actor_sources(oot)

    entries = []
    files = set(KEEP_OBJECTS + EXTRA_FILES)
    stats = {"skeleton": 0, "lists": 0, "nothing": 0, "noDraw": 0, "unknownScale": 0}
    for actor_id, name in actors:
        info = read_actor(oot, name, symbols, object_table, internal)
        if info is None:
            continue
        entry = {"name": name, "object": info["object"]}
        if info["scale"] is not None:
            entry["scale"] = info["scale"]
        if info["yOffset"] is not None:
            entry["yOffset"] = info["yOffset"]
        if info["skeleton"]:
            s = symbols[info["skeleton"]]
            ref = js_ref(symbols, info["skeleton"])
            ref["type"], ref["limbType"] = s["type"], s["limbType"]
            entry["skeleton"] = ref
            if info["anim"]:
                entry["anim"] = js_ref(symbols, info["anim"])
            if info["skelOps"]:
                entry["skelOps"] = info["skelOps"]
            for k, v in info["skelColors"].items():
                entry["skel" + k.capitalize()] = v
            files.add(s["file"])
            stats["skeleton"] += 1
        def to_ref(l):
            if "variants" in l:
                return {"variants": [[to_ref(x) for x in v] for v in l["variants"]], "select": l["select"]}
            ref = js_ref(symbols, l["sym"])
            ref["layer"] = l["layer"]
            ref["name"] = l["sym"]
            for k in ("ops", "prim", "env"):
                if l.get(k):
                    ref[k] = l[k]
            files.add(ref["file"])
            return ref

        lists = [to_ref(l) for l in info["lists"]]
        # The same list issued from two places (Opa and Xlu branches) counts once.
        unique, seen = [], set()
        for l in lists:
            key = json.dumps(l, sort_keys=True)
            if key not in seen:
                seen.add(key)
                unique.append(l)
        if unique:
            entry["lists"] = unique
            if not info["skeleton"]:
                stats["lists"] += 1
        if info["limbLists"]:
            entry["limbLists"] = {}
            for idx, syms in sorted(info["limbLists"].items()):
                refs = []
                for sym in syms:
                    ref = js_ref(symbols, sym)
                    ref["layer"], ref["name"] = "opa", sym
                    refs.append(ref)
                    files.add(ref["file"])
                entry["limbLists"][idx] = refs
        if info["segments"]:
            entry["segments"] = {}
            for seg, sym in info["segments"].items():
                if isinstance(sym, tuple) and sym[0] == "scroll":
                    entry["segments"][seg] = {"scroll": sym[1]}
                elif isinstance(sym, tuple):
                    entry["segments"][seg] = {"file": sym[1], "offset": 0}
                else:
                    entry["segments"][seg] = js_ref(symbols, sym)
            for ref in entry["segments"].values():
                if "file" in ref:
                    files.add(ref["file"])
        if not info["skeleton"] and not unique:
            stats["noDraw" if not info["hasDraw"] else "nothing"] += 1
        if (info["skeleton"] or unique) and info["scale"] is None:
            stats["unknownScale"] += 1
            entry["scaleUnknown"] = True
        entries.append((actor_id, entry))

    # ---- write the JS table
    lines = [
        "// Generated by tools/oot/generate_oot_actor_models.py from the oot decomp -- do not edit.",
        "//",
        "// OOT_Actor_Models: for each actor id, what its Draw function issues, read",
        "// out of its C source: the skeleton (and the animation whose frame 0 poses",
        "// it) its Init sets up, the static display lists its Draw runs (a",
        "// params-indexed array of lists or of draw functions becomes",
        "// { select: [shift, mask], variants: [[lists], ...] }), the lists its limb",
        "// callbacks draw in place of a limb's own (limbLists, by the callback's",
        "// 1-based limbIndex), the textures it points segments 8-F at (or a",
        "// { scroll: [[tile, w, h]] } for a Gfx_TexScroll tile-size list), the scale",
        "// its Init sets (missing when it is computed rather than a literal:",
        "// scaleUnknown) and the shape.yOffset it draws at (ActorShape_Init,",
        "// missing when 0). A list's ops (and a skeleton's skelOps) are the literal",
        "// Matrix_Translate / Rotate / Scale the Draw applies on top of the actor's",
        "// matrix before issuing it: [\"t\", x, y, z], [\"s\", x, y, z], [\"ry\", rad];",
        "// a leading [\"new\"] means the matrix was rebuilt without the actor's scale.",
        "// prim / env (skelPrim / skelEnv) are the literal gDPSetPrimColor / EnvColor",
        "// the Draw issues before it, [r, g, b, a].",
        "// Files are",
        "// models/OOT/actors/objects/<file> or, with a vram, .../overlays/<file>.",
        "// js/oot_actors.js applies its own overrides on top of this.",
        "",
        "const OOT_Actor_Models = {",
    ]
    for actor_id, e in entries:
        parts = ['name: "%s"' % e["name"], 'object: %s' % ('"%s"' % e["object"] if e["object"] else "null")]
        if "scale" in e:
            parts.append("scale: %s" % repr(round(e["scale"], 6)))
        if "yOffset" in e:
            parts.append("yOffset: %s" % repr(round(e["yOffset"], 6)))
        if e.get("scaleUnknown"):
            parts.append("scaleUnknown: true")
        if "skeleton" in e:
            parts.append("skeleton: " + fmt_ref(e["skeleton"]))
        if "anim" in e:
            parts.append("anim: " + fmt_ref(e["anim"]))
        if "skelOps" in e:
            parts.append("skelOps: " + fmt_ops(e["skelOps"]))
        for k in ("skelPrim", "skelEnv"):
            if k in e:
                parts.append("%s: [%s]" % (k, ", ".join(str(v) for v in e[k])))
        if "lists" in e:
            parts.append("lists: [\n            " + ",\n            ".join(fmt_list(l) for l in e["lists"]) + "\n        ]")
        if "limbLists" in e:
            parts.append("limbLists: { " + ", ".join("%d: [%s]" % (idx, ", ".join(fmt_list(r) for r in refs)) for idx, refs in e["limbLists"].items()) + " }")
        if "segments" in e:
            parts.append("segments: { " + ", ".join("0x%02X: %s" % (seg, fmt_ref(r)) for seg, r in sorted(e["segments"].items())) + " }")
        lines.append("    0x%03X: {\n        %s\n    }," % (actor_id, ",\n        ".join(parts)))
    lines.append("};")
    lines.append("")
    with open(OUT_JS, "w", encoding="utf-8", newline="\n") as f:
        f.write("\n".join(lines))
    print(f"{OUT_JS}: {len(entries)} actors -- {stats['skeleton']} skeletons, {stats['lists']} display lists only, "
          f"{stats['nothing']} with a Draw this found nothing in, {stats['noDraw']} with no Draw, "
          f"{stats['unknownScale']} with a computed scale")

    # ---- copy the files the models live in
    os.makedirs(OBJECTS_OUT, exist_ok=True)
    os.makedirs(OVERLAYS_OUT, exist_ok=True)
    copied = missing = 0
    for fname in sorted(files):
        src = os.path.join(baserom, fname)
        if not os.path.isfile(src):
            print(f"warning: {fname} missing from {baserom}", file=sys.stderr)
            missing += 1
            continue
        dst = os.path.join(OVERLAYS_OUT if fname.startswith("ovl_") else OBJECTS_OUT, fname)
        with open(src, "rb") as f:
            blob = f.read()
        if os.path.isfile(dst):
            with open(dst, "rb") as f:
                if f.read() == blob:
                    continue
        with open(dst, "wb") as f:
            f.write(blob)
        copied += 1
    print(f"files: {len(files)} referenced, {copied} copied, {missing} missing")


if __name__ == "__main__":
    main()
