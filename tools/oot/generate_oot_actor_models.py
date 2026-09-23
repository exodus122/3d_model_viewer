#!/usr/bin/env python3
"""
Generate js/oot_object_list.js -- what each OoT actor draws -- from the oot
decomp, and bring the object files those models live in over to
models/OOT/actors/objects (and overlays to models/OOT/actors/overlays).
With --mm, the same for Majora's Mask from the mm decomp: js/mm_object_list.js
(MM_Actor_Models) and models/MM/actors/{objects,overlays}.

usage: generate_oot_actor_models.py [--mm] [path/to/decomp] [version]

    path/to/decomp  the oot (mm) decomp checkout (default: ../oot or ../mm
                    next to this repo)
    version         its baseroms/<version> (default: ntsc-1.0 / n64-us)

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
  * Gfx_DrawDListOpa / Xlu, gSPDisplayList(POLY_*_DISP++ / &gfx[n] /
    gfx++, ...) in Draw                   -> static display lists; an array
                                             (of lists, or of structs holding
                                             them -- the field named, when the
                                             file's typedef gives the fields)
                                             indexed by a PARAMS_GET_* of the
                                             actor's params becomes a selector,
                                             also through a local `info =
                                             &sInfo[type]`; a member or
                                             variable is followed to its first
                                             assignment; &gDL[n] enters a list
                                             n commands in; the shared effect
                                             quads (gEff*) and drop shadows are
                                             skipped
  * Matrix_Translate / Rotate* / Scale with literal arguments before a list
    or the SkelAnime_Draw* in Draw   -> ops applied on top of the actor matrix
  * gDPSetPrimColor / gDPSetEnvColor with literal colours before them
                                     -> prim / env the list is drawn with
  * if (params == X) { ... } else { ... } / switch (type) { case X: ... }
    around a list in Draw            -> `when`: the params tests it is drawn
                                        under; a branch on other state (an
                                        action function, a flag) is dropped
                                        when its chain has an else to fall to,
                                        and a cutscene (csCtx) branch always;
                                        a projectedPos.z draw-distance test
                                        takes the near branch;
                                        a `draw = X` Init installs inside a
                                        params branch tags X's lists the same
  * if (limbIndex == N) { ... } / switch (limbIndex) { case N: ... } in a
    SkelAnime limb callback           -> the list drawn in place of limb N
                                        (*dList = ...) or next to it (add:
                                        gSPDisplayList, as a post-limb draw
                                        does); N may be the object header's
                                        limb enum
  * gSPSegment(POLY_*_DISP++, 0x08..0x0F, SEGMENTED_TO_VIRTUAL(tex)) in Draw
    (MM: Lib_SegmentedToVirtual(tex))
                                          -> the texture a segment stands for
                                             (eyes, mouths), first choice; with
                                             play->objectCtx.slots[..].segment,
                                             the whole object the actor loaded;
                                             with Gfx_TexScroll / TwoTexScroll,
                                             the tile sizes that list sets

Symbols are resolved to a file and offset through assets/xml/objects/*.xml
and assets/xml/overlays/*.xml (an OoT overlay's data starts at the
start_offset its baseroms/<version>/config.yml entry gives, and its pointers
are VRAM addresses from baseroms/<version>/segments.csv; an MM overlay XML
gives offsets into the whole file and its VRAM as BaseAddress).

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

# Objects every actor may draw from without loading them: segment 4 and 5.
KEEP_OBJECTS = ["gameplay_keep", "gameplay_field_keep", "gameplay_dangeon_keep"]

# Per game: the decomp and version read by default, the table written and
# its overrides. extra: files only the hand overrides reach (models drawn
# through code this does not follow, such as GetItem_Draw's tables).
GAMES = {
    "OOT": {
        "decomp": "oot", "version": "ntsc-1.0", "table": "OOT_Actor_Models", "js": "oot_object_list.js",
        "overrides": "js/oot_actors.js",
        "extra": ["object_gi_heart", "object_jya_door", "object_ganon_objects", "object_haka_door", "object_ouke_haka",
                  "object_km1", "object_masterkokiri", "object_ds2", "object_rs", "object_masterzoora", "object_mastergolon", "object_os"],
    },
    "MM": {
        "decomp": "mm", "version": "n64-us", "table": "MM_Actor_Models", "js": "mm_object_list.js",
        "overrides": "js/mm_actor_overrides.js",
        "extra": ["object_gi_heart", "object_gi_hearts", "object_numa_obj", "object_dor01", "object_dor02", "object_dor03", "object_dor04", "object_wdor01",
                  "object_wdor02", "object_wdor03", "object_wdor04", "object_wdor05", "object_kaizoku_obj",
                  "object_kinsta2_obj", "object_bdoor", "object_hakugin_obj", "object_dblue_object",
                  "object_ikana_obj", "object_redead_obj", "object_ikninside_obj", "object_random_obj",
                  "object_kinsta1_obj", "object_last_obj", "object_danpei_object", "object_bombiwa", "object_bombf",
                  "object_mastergolon", "object_masterzoora", "object_rsn", "object_zo", "object_oF1d_map",
                  "object_mnk", "object_snowman", "object_az", "object_dekubaba", "object_mtoride"],
    },
}


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
                # OoT names the whole enum (OBJECT_BOX), MM its suffix (BOX,
                # GAMEPLAY_KEEP), which its profiles use as OBJECT_BOX but
                # GAMEPLAY_KEEP.
                entry = (int(m.group(1), 16), m.group(2))
                objects[m.group(3)] = entry
                if not m.group(3).startswith("OBJECT_"):
                    objects["OBJECT_" + m.group(3)] = entry
    return objects


# ---- asset symbols


def read_overlay_ranges(oot, version):
    """{ovl name: (start_offset, vram)}: where an overlay's extracted data sits."""
    starts = {}
    config = os.path.join(oot, "baseroms", version, "config.yml")
    if not os.path.isfile(config):
        return {}
    with open(config, encoding="utf-8") as f:
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
                if sub == "overlays" and "BaseAddress" in file_el.attrib:
                    # MM: offsets into the whole file, linked at BaseAddress
                    data_start, vram = 0, int(file_el.attrib["BaseAddress"], 16)
                elif sub == "overlays":
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


# {draw function: lists} for the entries of a draw-function table, set per
# actor by read_actor.
draw_fn_lists = {}

# {array name: [{field: token}, ...]} for the file's struct array
# initializers whose struct typedef it can read (sBoeModelInfo[i].modelDL);
# set per actor by read_actor.
struct_fields = {}


def struct_arrays(text):
    """
    {array name: [{field: token}]}: each element of a `StructType name[] =
    { { a, b }, ... }` initializer, its values named by the fields of the
    file's `typedef struct StructType { ... } StructType;`. An element whose
    value count does not match the fields (a nested struct) is left out.
    """
    types = {}
    for m in re.finditer(r"typedef\s+struct\s*\w*\s*\{([^{}]*)\}\s*(\w+)\s*;", text):
        fields = []
        for decl in m.group(1).split(";"):
            fm = re.search(r"(\w+)\s*(?:\[[^\]]*\])?\s*$", decl.strip())
            if fm and decl.strip():
                fields.append(fm.group(1))
        types[m.group(2)] = fields
    out = {}
    for m in re.finditer(r"\b(\w+)\s+(\w+)\s*\[\s*\w*\s*\]\s*=\s*\{(.*?)\}\s*;", text, flags=re.S):
        fields = types.get(m.group(1))
        if not fields:
            continue
        elements = []
        for el in re.findall(r"\{([^{}]*)\}", m.group(3)):
            values = [t.strip().lstrip("&").strip() for t in el.split(",") if t.strip()]
            elements.append(dict(zip(fields, values)) if len(values) == len(fields) else None)
        if elements and all(elements):
            out[m.group(2)] = elements
    return out


def assignments(text):
    """{name: [rhs]} for every `x = rhs;` / `this->x = rhs;` in the file."""
    out = {}
    for m in re.finditer(r"(?:->|\.|\b)(\w+)\s*(?<![=!<>+\-*/&|])=(?!=)\s*([^;{}]+?)\s*;", text):
        rhs = m.group(2).strip()
        if rhs and not re.match(r"^[-0-9.]", rhs):
            out.setdefault(m.group(1), []).append(rhs)
    return out


# An index expression on the actor's params, as (shift, mask).
_N = r"(0x[0-9A-Fa-f]+|\d+)"
PARAM_INDEX = [
    (re.compile(r"PARAMS_GET_[US]\(\s*[^,]*params[^,]*,\s*(\d+)\s*,\s*(\d+)\s*\)"), lambda m: (int(m.group(1)), (1 << int(m.group(2))) - 1)),
    (re.compile(r"PARAMS_GET_NOMASK\(\s*[^,]*params[^,]*,\s*(\d+)\s*\)"), lambda m: (int(m.group(1)), 0xFFFF >> int(m.group(1)))),
    # (params >> 12) & 0xF
    (re.compile(r"\(?\s*[\w>.()-]*params\)?\s*>>\s*" + _N + r"\s*\)?\s*&\s*" + _N), lambda m: (int(m.group(1), 0), int(m.group(2), 0))),
    # (params & 0xF000) >> 12 -- MM writes the mask first
    (re.compile(r"[\w>.()-]*params\)?\s*&\s*" + _N + r"\s*\)?\s*>>\s*" + _N), lambda m: (int(m.group(2), 0), int(m.group(1), 0) >> int(m.group(2), 0))),
    (re.compile(r"[\w>.()-]*params\)?\s*&\s*" + _N), lambda m: (0, int(m.group(1), 0))),
    # params >> 0xC with no mask: the rest of the word
    (re.compile(r"[\w>.()-]*params\)?\s*>>\s*" + _N), lambda m: (int(m.group(1), 0), 0xFFFF >> int(m.group(1), 0))),
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
# has already masked it (params &= 0xFF, the upper byte being a flag; MM's
# En_Mkk: params &= 1).
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
    """Every function defined in the file (not an `if (...) {` / `while (...) {`)."""
    return set(re.findall(r"\b(\w+)\s*\([^;{}]*\)\s*\{", text)) - {"if", "while", "for", "switch", "return", "sizeof"}


# (MM also writes through a local: gSPDisplayList(&gfx[3], ...), gfx++,
# (*gfx)++ -- which buffer is not known there, so those count as opaque.)
DL_RX = re.compile(r"(?:Gfx_DrawDList(Opa|Xlu)\s*\(\s*play\s*,\s*|gSPDisplayList\s*\(\s*(?:POLY_(OPA|XLU)_DISP\+\+|&\w+\[\d+\]|\w+\+\+|\(\*\w+\)\+\+)\s*,\s*)([^;]+?)\)\s*;")


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


def resolve_list_expr(expr, arrays, symbols, assigned, layer, depth=0, field=None):
    """
    A display-list expression -> {sym, layer} | {variants, select} | None:
    a symbol, an array element (sDLists[PARAMS_GET_U(...)], sParams[i].dList),
    or a variable / member the file assigns one of those to (this->dList =
    sDLists[type] in Init, drawn in Draw) -- its first assignment.
    """
    expr = expr.strip().lstrip("&").strip()
    am = re.match(r"^(\w+)\s*\[(.+)\]\s*(?:\.\s*(\w+))?$", expr, flags=re.S)
    is_dl = lambda t: t in symbols and symbols[t]["kind"] == "DList" and not EFFECT_DL_RX.search(t)
    member = (am.group(3) if am else None) or field
    if am and member and all(member in el for el in struct_fields.get(am.group(1), [{}])):
        # sInfo[type].dList: that field of each element
        items = [struct_fields[am.group(1)][k][member] for k in range(len(struct_fields[am.group(1)]))]
        items = ["NULL" if t in ("NULL", "0") else t for t in items]
        if all(is_dl(t) or t == "NULL" for t in items) and any(is_dl(t) for t in items):
            return {"variants": [[{"sym": t, "layer": layer}] if t != "NULL" else [] for t in items],
                    "select": index_selector(am.group(2), assigned)}
    if am and am.group(1) in arrays:
        items = arrays[am.group(1)]
        if all(is_dl(t) or t == "NULL" for t in items) and any(is_dl(t) for t in items):
            return {"variants": [[{"sym": t, "layer": layer}] if t != "NULL" else [] for t in items],
                    "select": index_selector(am.group(2), assigned)}
        return None
    if re.match(r"^\w+$", expr) and is_dl(expr):
        return {"sym": expr, "layer": layer}
    # &gSomeDL[2]: a list entered at its third command
    im = re.match(r"^(\w+)\s*\[\s*(\d+)\s*\]$", expr)
    if im and is_dl(im.group(1)):
        return {"sym": im.group(1), "layer": layer, "index": int(im.group(2))}
    # info->dList with a local `info = &sInfo[type]`: that struct array's lists
    pm = re.match(r"^(\w+)\s*->\s*(\w+)$", expr)
    if pm and pm.group(1) not in ("this", "thisx") and depth < 3:
        for rhs in assigned.get(pm.group(1), []):
            if rhs.lstrip().startswith("&"):
                r = resolve_list_expr(rhs, arrays, symbols, assigned, layer, depth + 1, pm.group(2))
                if r:
                    return r
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
# chest it embeds). Matrix_Put / Push / Pop start again from the actor's;
# Matrix_SetTranslateRotateYXZ builds one from scratch, like MTXMODE_NEW. A
# Matrix_Scale whose arguments are expressions (last alternative) is taken
# as the actor's own scale.
MATRIX_OP_RX = re.compile(
    r"Matrix_(Put|Push|Pop)\s*\(|MTXMODE_NEW|Matrix_SetTranslateRotateYXZ\s*\(|"
    r"Matrix_(Translate|Scale)\s*\(\s*([^,()]+),\s*([^,()]+),\s*([^,()]+),\s*MTXMODE_APPLY\s*\)|"
    r"Matrix_Rotate([XYZ])\s*\(\s*([^,]+?),\s*MTXMODE_APPLY\s*\)|"
    r"(Matrix_Scale)\s*\(")


def literal_number(expr):
    """A numeric literal, or None."""
    m = re.match(r"^\s*(-?[0-9]*\.?[0-9]+)f?\s*$", expr)
    return float(m.group(1)) if m else None


def literal_color(expr):
    """A colour / LOD-fraction byte: a decimal or hex literal (gDPSetPrimColor(.., 0x80, 0x80, ..)), or None."""
    m = re.match(r"^\s*0x([0-9A-Fa-f]+)\s*$", expr)
    return float(int(m.group(1), 16)) if m else literal_number(expr)


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
        if m.group(0) == "MTXMODE_NEW" or m.group(0).startswith("Matrix_SetTranslateRotateYXZ"):
            # Built from scratch (Matrix_Translate(world.pos, MTXMODE_NEW)):
            # the actor's scale is not part of it. Its position and any
            # rotation from the actor's own fields come back non-literal.
            ops = [["new"]]
        elif m.group(1):
            ops = []
        elif m.group(8):
            if ops and ops[0] == ["new"]:
                ops.pop(0)
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


# gDPSetCombineLERP(POLY_*_DISP++, a0, b0, c0, d0, Aa0, Ab0, Ac0, Ad0, a1, ...)
COMBINE_RX = re.compile(r"gDPSetCombineLERP\s*\(\s*POLY_(?:OPA|XLU)_DISP\+\+\s*,\s*([^;]*?)\)\s*;")
_CC_COLOR = {"COMBINED": 0, "TEXEL0": 1, "TEXEL1": 2, "PRIMITIVE": 3, "SHADE": 4, "ENVIRONMENT": 5}
_CC_ALPHA = {"COMBINED": 0, "TEXEL0": 1, "TEXEL1": 2, "PRIMITIVE": 3, "SHADE": 4, "ENVIRONMENT": 5, "1": 6, "0": 7}
# The mux code of each LERP argument by its slot (colour a, b, c, d, alpha a, b, c, d).
CC_CODES = [
    dict(_CC_COLOR, **{"1": 6, "NOISE": 7, "0": 15}),
    dict(_CC_COLOR, **{"CENTER": 6, "K4": 7, "0": 15}),
    dict(_CC_COLOR, **{"SCALE": 6, "COMBINED_ALPHA": 7, "TEXEL0_ALPHA": 8, "TEXEL1_ALPHA": 9, "PRIMITIVE_ALPHA": 10,
                       "SHADE_ALPHA": 11, "ENV_ALPHA": 12, "LOD_FRACTION": 13, "PRIM_LOD_FRAC": 14, "K5": 15, "0": 31}),
    dict(_CC_COLOR, **{"1": 6, "0": 7}),
    _CC_ALPHA,
    _CC_ALPHA,
    {"LOD_FRACTION": 0, "TEXEL0": 1, "TEXEL1": 2, "PRIMITIVE": 3, "SHADE": 4, "ENVIRONMENT": 5, "PRIM_LOD_FRAC": 6, "0": 7},
    _CC_ALPHA,
]


def colors_before(body, pos):
    """
    {"prim": [r, g, b, a], "env": [...]} from the last literal
    gDPSetPrimColor / gDPSetEnvColor issued before pos in body (an alpha
    that is computed counts as 255), for lists whose combiner takes the
    colour from the Draw rather than from the list itself.
    """
    out = {}
    for m in COMBINE_RX.finditer(body[:pos]):
        names = [a.strip() for a in split_args(m.group(1))]
        if len(names) == 16:
            codes = [CC_CODES[i % 8].get(n) for i, n in enumerate(names)]
            if None not in codes:
                out["combine"] = codes
    for m in COLOR_RX.finditer(body[:pos]):
        args = split_args(m.group(2))
        if m.group(1) == "SetPrimColor":
            lod = literal_color(args[1]) if len(args) > 1 else None
            if lod:
                out["primLod"] = int(lod)
            args = args[2:]
        if len(args) != 4:
            continue
        rgb = [literal_color(a) for a in args[:3]]
        if None in rgb:
            continue
        alpha = literal_color(args[3])
        out["prim" if m.group(1) == "SetPrimColor" else "env"] = [int(v) for v in rgb] + [int(alpha) if alpha is not None else 255]
    return out


# ---- if / else and switch branches in a Draw
#
# A Draw often picks what it issues by the actor's type: `if (params ==
# WEB_WALL) { wall } else { floor }`, `if (thisx->params == 3) { tent
# entrance }`. Each list is tagged with the params tests of the branches it
# sits in (`when`), so that a spawn draws only its own; a branch on some
# other state (an action function, a timer, a flag) is not the placed
# actor's default when its chain has an else, so its lists are dropped.


def branch_chains(body):
    """
    [[{cond, start, end}]]: every if / else if / else chain and switch in
    body, one entry per branch, with the text range its statements cover.
    cond is the condition text; None for an else (or a switch's default),
    ("case", expr, [labels]) for a switch case.
    """
    chains = []
    open_chains = {}  # end of a chain's last branch -> chain, for an else to continue
    for m in re.finditer(r"\b(else\s+if|if|else|switch)\b", body):
        kw = re.sub(r"\s+", " ", m.group(1))
        i = m.end()
        cond = None
        if kw in ("if", "else if", "switch"):
            while i < len(body) and body[i].isspace():
                i += 1
            if i >= len(body) or body[i] != "(":
                continue
            cond = balanced_paren(body, i)
            i += len(cond) + 2
        while i < len(body) and body[i].isspace():
            i += 1
        if kw == "else" and body.startswith("if", i):
            continue  # `else if` is matched as a whole
        if i < len(body) and body[i] == "{":
            block = balanced_block(body, i)
            start, end = i + 1, i + 1 + len(block)
        else:
            semi = body.find(";", i)
            start, end = i, (semi + 1 if semi >= 0 else len(body))
        if kw == "switch":
            # case labels that share statements (fall-through) share a branch
            chain, pending = [], []
            labels = list(re.finditer(r"\b(?:case\s+([^:]+?)|default)\s*:", body[start:end]))
            for k, lm in enumerate(labels):
                stmt_start = start + lm.end()
                stmt_end = start + labels[k + 1].start() if k + 1 < len(labels) else end
                pending.append(lm.group(1).strip() if lm.group(1) else None)
                if body[stmt_start:stmt_end].strip():
                    chain.append({"cond": ("case", cond, pending), "start": stmt_start, "end": stmt_end})
                    pending = []
            if chain:
                chains.append(chain)
            continue
        entry = {"cond": cond, "start": start, "end": end}
        # An else / else if continues the chain whose last branch ended just before it.
        chain = None
        if kw != "if":
            chain = next((c for e, c in open_chains.items() if e <= m.start() and not body[e:m.start()].strip()), None)
        if chain is None:
            chain = []
            chains.append(chain)
        chain.append(entry)
        open_chains = {e: c for e, c in open_chains.items() if c is not chain}
        open_chains[end + (1 if end < len(body) and body[end] == "}" else 0)] = chain
    return chains


def constant_value(expr, consts):
    """An integer constant: a literal, an enumerator or a #define, or None."""
    expr = expr.strip().strip("()").strip()
    if expr in consts:
        return consts[expr]
    try:
        return int(expr.rstrip("uU"), 0)
    except ValueError:
        return None


def params_atom(expr, assigned, consts):
    """`<params expr> <op> <constant>` -> [shift, mask, op, value], or None."""
    # (not the > of a ->, nor a shift)
    m = re.match(r"^(.+?)\s*(==|!=|<=|>=|(?<![-<>])<(?![<=])|(?<![-<>])>(?![>=]))\s*(.+)$", expr.strip(), flags=re.S)
    if not m:
        return None
    lhs, op, rhs = m.group(1), m.group(2), m.group(3)
    # projectedPos.z against a literal: past a few hundred units a
    # draw-distance LOD test, decided for the near model (MM fades boulders
    # out past ~2200); near zero an in-front-of-the-camera test, decided true.
    if "projectedPos" in lhs + rhs and op not in ("==", "!="):
        n = literal_number(rhs if "projectedPos" in lhs else lhs)
        if n is None:
            return None
        less = (op in ("<", "<=")) == ("projectedPos" in lhs)
        return less if abs(n) >= 500 else not less
    # this->actionFunc == F: known once Init's starting action is (the
    # placed actor is in it), true or false.
    if re.search(r"\bactionFunc\s*$", lhs.strip()) and re.match(r"^\w+$", rhs.strip()) and op in ("==", "!="):
        start = consts.get("__init_action__")
        if start is None:
            return None
        return (rhs.strip() == start) == (op == "==")
    value = constant_value(rhs, consts)
    if value is None:
        value = constant_value(lhs, consts)
        lhs = rhs
        op = {"<": ">", ">": "<", "<=": ">=", ">=": "<="}.get(op, op)
        if value is None:
            return None
    lhs = lhs.strip()
    while lhs.startswith("(") and lhs.endswith(")") and balanced_paren(lhs, 0) == lhs[1:-1]:
        lhs = lhs[1:-1].strip()
    sel = index_selector(lhs, assigned)
    if not sel or sel == (0, 0):
        return None
    return [sel[0], sel[1], op, value]


def split_top(expr, sep):
    """expr split on a top-level operator (&& or ||)."""
    parts, depth, cur, i = [], 0, "", 0
    while i < len(expr):
        ch = expr[i]
        depth += ch == "("
        depth -= ch == ")"
        if depth == 0 and expr.startswith(sep, i):
            parts.append(cur)
            cur, i = "", i + len(sep)
            continue
        cur += ch
        i += 1
    parts.append(cur)
    return [p.strip() for p in parts]


def params_condition(cond, assigned, consts):
    """A branch condition as a params test ({any|all: [...]} of atoms), or None when it tests anything else."""
    cond = cond.strip()
    while cond.startswith("(") and cond.endswith(")") and balanced_paren(cond, 0) == cond[1:-1]:
        cond = cond[1:-1].strip()
    for sep, key in (("||", "any"), ("&&", "all")):
        parts = split_top(cond, sep)
        if len(parts) > 1:
            subs = [params_condition(p, assigned, consts) for p in parts]
            # true / false parts (an actionFunc test) fold away; a true part
            # decides an ||, a false one an &&, whatever the others test
            decided = key == "any"
            if decided in subs:
                return decided
            if None in subs:
                return None
            subs = [c for c in subs if c is not (not decided)]
            return (not decided) if not subs else subs[0] if len(subs) == 1 else {key: subs}
    return params_atom(cond, assigned, consts)


def branch_path(body, pos, chains, assigned, consts):
    """
    (when, drop, hidden) for the code at pos: `when` the params tests of the
    branches around it ([] for none), drop True when it sits in a branch on
    some other state that has an else to fall to, hidden the ranges of the
    branches not taken on the way there (for the matrix / colour scan).
    """
    when, drop, hidden = [], False, []
    for chain in chains:
        taken = next((k for k, b in enumerate(chain) if b["start"] <= pos < b["end"]), None)
        if taken is None:
            # A chain passed on the way: its else is the default taken.
            if chain[-1]["end"] <= pos and chain[-1]["cond"] is None:
                hidden.extend((b["start"], b["end"]) for b in chain[:-1])
            elif chain[-1]["end"] <= pos:
                # No else: an `if` on an action the actor is not in is not
                # run; one on its type is run for those params only, handed
                # back as (start, end, test) for the caller to split on
                # (En_Bombf's flower raises the bomb, Bg_Bdan_Objects' big
                # octo platform sinks, the other types do neither).
                for b in chain:
                    if isinstance(b["cond"], str):
                        c = params_condition(b["cond"], assigned, consts)
                        if c is False:
                            hidden.append((b["start"], b["end"]))
                        elif c is not None and c is not True:
                            hidden.append((b["start"], b["end"], c))
            continue
        hidden.extend((b["start"], b["end"]) for k, b in enumerate(chain) if k != taken and b["end"] <= pos)
        if isinstance(chain[0]["cond"], tuple):
            _, expr, labels = chain[taken]["cond"]
            atoms = [params_atom("%s == %s" % (expr, l), assigned, consts) for l in labels if l is not None]
            if None in labels or None in atoms or not atoms:
                continue  # default, or not a params switch
            when.append(atoms[0] if len(atoms) == 1 else {"any": atoms})
            continue
        has_else = chain[-1]["cond"] is None
        for k in range(taken + 1):
            cond = chain[k]["cond"]
            if cond is None:
                continue
            if k == taken and "csCtx" in cond:
                drop = True  # only while a cutscene runs
            c = params_condition(cond, assigned, consts)
            if c is None:
                if k == taken and has_else:
                    drop = True
                continue
            if isinstance(c, bool):
                # decided: this branch is taken (true) or not (false), and
                # an earlier branch that is taken shuts out this one
                if c != (k == taken):
                    drop = True
                continue
            when.append(c if k == taken else {"not": c})
    return when, drop, hidden


def without(body, pos, hidden):
    """body[:pos] with the hidden ranges blanked out."""
    text = list(body[:pos])
    for s, e in (h[:2] for h in hidden):
        for i in range(s, min(e, pos)):
            text[i] = " "
    return "".join(text)


# A matrix or colour set in a block (for a list issued after it)
STATE_RX = re.compile(r"Matrix_(?:Translate|Scale|Rotate[XYZ])\s*\(|gDPSet(?:Prim|Env)Color\s*\(|gDPSetCombineLERP\s*\(")


def lists_in(text, body, arrays, symbols, functions, seen):
    """
    The display lists a function body issues: [{sym, layer}] for plain
    symbols, [{variants: [[...], ...], select: [shift, mask]}] for a
    params-indexed array of lists or of draw functions. Calls into other
    functions of the file are followed; functions passed as arguments
    (SkelAnime limb callbacks) are not, since those draw inside a limb.
    A list inside a params branch carries its tests as `when`.
    """
    lists = []
    chains = branch_chains(body)

    def tagged(found, pos):
        when, drop, _ = branch_path(body, pos, chains, functions.assigned, functions.consts)
        if drop:
            return []
        if when:
            for r in found:
                r["when"] = when + r.get("when", [])
        return found

    for m in DL_RX.finditer(body):
        layer = (m.group(1) or m.group(2) or "opa").lower()
        expr = m.group(3).strip()
        if EFFECT_DL_RX.search(expr):
            continue
        r = resolve_list_expr(expr, arrays, symbols, functions.assigned, layer)
        if r:
            _, _, hidden = branch_path(body, m.start(), chains, functions.assigned, functions.consts)
            fixed = [h for h in hidden if len(h) == 2]
            # params branches passed on the way that set a matrix or colour:
            # one copy of the list per outcome, tagged with it
            optional = [h for h in hidden if len(h) == 3 and STATE_RX.search(body[h[0]:h[1]])][:3]
            fixed += [h[:2] for h in hidden if len(h) == 3 and h not in optional]
            outcomes = []
            for mask in range(1 << len(optional)):
                hid = fixed + [h[:2] for i, h in enumerate(optional) if not (mask >> i) & 1]
                before = without(body, m.start(), hid)
                state = colors_before(before, m.start())
                ops = matrix_ops_before(before, m.start())
                if ops:
                    state["ops"] = ops
                outcomes.append((state, [h[2] if (mask >> i) & 1 else {"not": h[2]} for i, h in enumerate(optional)]))
            if all(o[0] == outcomes[0][0] for o in outcomes):
                outcomes = [(outcomes[0][0], [])]
            found = []
            for state, extra in outcomes:
                copy = {**r, **state}
                if extra:
                    copy["when"] = extra + r.get("when", [])
                found.append(copy)
            lists.extend(tagged(found, m.start()))
    # sDrawFuncs[PARAMS_GET_U(...)](this, play): one variant per function
    for m in re.finditer(r"\b(\w+)\s*\[(.+?)\]\s*\(\s*this", body):
        items = arrays.get(m.group(1))
        if items and all(fn in functions for fn in items):
            variants = []
            for fn in items:
                # A function listed twice (Obj_Switch's crystal switch for
                # types 3 and 4) draws the same for both; one being visited
                # higher up the call chain draws nothing more here.
                if fn in draw_fn_lists:
                    variants.append([dict(x) for x in draw_fn_lists[fn]])
                    continue
                if fn in seen:
                    variants.append([])
                    continue
                seen.add(fn)
                draw_fn_lists[fn] = lists_in(text, function_body(text, fn), arrays, symbols, functions, seen)
                variants.append([dict(x) for x in draw_fn_lists[fn]])
            lists.extend(tagged([{"variants": variants, "select": index_selector(m.group(2), functions.assigned)}], m.start()))
    for m in re.finditer(r"\b(\w+)\s*\(", body):
        fn = m.group(1)
        if fn in seen or fn not in functions:
            continue
        seen.add(fn)
        lists.extend(tagged(lists_in(text, function_body(text, fn), arrays, symbols, functions, seen), m.start()))
    return lists


LIMB_DL_RX = re.compile(r"(?:gSPDisplayList\s*\(\s*(?:\(\*gfx\)\+\+|POLY_(?:OPA|XLU)_DISP\+\+|gfx\+\+)\s*,\s*|\*dList\s*=\s*)&?(\w+)")


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
    {limbIndex: [{sym, add, ops}]}: the display lists a SkelAnime limb
    callback (a function passed to SkelAnime_Draw*) substitutes into the limb
    (*dList = ...), or issues next to it (gSPDisplayList: add, drawn under
    the limb's matrix and the literal Matrix_* ops before it -- En_Ge1's
    hair, Wallmaster's finger), inside an `if (limbIndex == N)` block.
    limbIndex is the callback's 1-based index (the object header's limb
    enum). The first list of a block is taken, which is the default branch
    of a type switch inside it.
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
                entry = {"sym": sym, "add": not dm.group(0).startswith("*"), "ops": []}
                if entry["add"]:
                    entry["ops"] = [op for op in matrix_ops_before(block, dm.start()) if op != ["new"]]
                limbs.setdefault(idx, [])
                if entry not in limbs[idx]:
                    limbs[idx].append(entry)
                return

    for fn in sorted(callbacks):
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


def constants(text, enums):
    """{name: value}: the enumerators and the plain numeric #defines."""
    consts = dict(enums)
    for m in re.finditer(r"#define\s+(\w+)\s+\(?\s*(-?(?:0x[0-9A-Fa-f]+|\d+))\s*\)?\s*$", text, flags=re.M):
        consts[m.group(1)] = int(m.group(2), 0)
    return consts


def init_action(text, init_body, functions, depth=0):
    """The action function Init leaves the actor in: its first `actionFunc = F` / Xxx_SetupAction(this, F), following calls into the file's setup functions."""
    for m in re.finditer(r"actionFunc\s*=\s*(\w+)\s*;|\w*SetupAction\s*\(\s*this\s*,\s*(\w+)\s*\)|\b(\w+)\s*\(", init_body):
        if m.group(1) or m.group(2):
            return m.group(1) or m.group(2)
        fn = m.group(3)
        if depth < 2 and fn in functions:
            found = init_action(text, function_body(text, fn), functions, depth + 1)
            if found:
                return found
    return None


class FileFunctions(set):
    """The file's function names, carrying its variable assignments and constants too."""
    def __init__(self, text, enums):
        super().__init__(function_names(text))
        self.assigned = assignments(text)
        self.consts = constants(text, enums)


def draw_lists(text, draw_fns, arrays, symbols, functions, fn_when):
    """The lists of every draw function, those installed for some params only tagged with that `when`."""
    seen = set(draw_fns)
    lists = []
    for fn in draw_fns:
        found = lists_in(text, function_body(text, fn), arrays, symbols, functions, seen)
        if fn_when.get(fn):
            for r in found:
                r["when"] = fn_when[fn] + r.get("when", [])
        lists.extend(found)
    return lists


DRAW_ASSIGN_RX = re.compile(r"(?:actor|thisx|dyna\.actor)\s*(?:\.|->)\s*draw\s*=\s*(\w+)\s*;")


def draw_function_conditions(text, init_body, draw_fn, draw_fns, functions):
    """
    {draw function: when}: a draw function Init installs only for some
    params (`case 3: thisx->draw = func_808ACCB8;`) is drawn only for those,
    and the profile's own Draw then only for the rest. A function installed
    anywhere outside Init, or unconditionally, is not tagged.
    """
    chains = branch_chains(init_body)
    tests = {}
    for m in DRAW_ASSIGN_RX.finditer(init_body):
        when, _, _ = branch_path(init_body, m.start(), chains, functions.assigned, functions.consts)
        tests.setdefault(m.group(1), []).append(when)
    everywhere = DRAW_ASSIGN_RX.findall(text)
    out = {}
    for fn, whens in tests.items():
        if fn in ("NULL", draw_fn) or not all(whens) or everywhere.count(fn) != len(whens):
            continue
        out[fn] = [{"any": [{"all": w} for w in whens]}] if len(whens) > 1 else whens[0]
    others = [f for f in draw_fns if f != draw_fn]
    if draw_fn in draw_fns and others and all(f in out for f in others):
        out[draw_fn] = [{"not": {"any": [{"all": out[f]} for f in others]}}]
    return out


def reachable_functions(text, fns, functions):
    """fns and every function of the file they call, in order (helpers set segments too)."""
    order, queue = [], list(fns)
    while queue:
        fn = queue.pop(0)
        if fn in order:
            continue
        order.append(fn)
        queue.extend(m.group(1) for m in re.finditer(r"\b(\w+)\s*\(", function_body(text, fn))
                     if m.group(1) in functions and m.group(1) not in order)
    return order


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
    set_scale = [
        (r"Actor_SetScale\s*\([^,]+,\s*" + SCALE_LITERAL + r"\s*\)", literal_value),
        # the actor's own scale only, not another actor's (En_Fsn's shop items)
        (r"(?:this->(?:dyna\.)?actor\.|thisx->)scale\.x\s*=\s*" + SCALE_LITERAL + r"\s*;", literal_value),
    ]
    init_chain = [
        (r"ICHAIN_VEC3F_DIV1000\s*\(\s*scale\s*,\s*(\d+)", lambda v: int(v) / 1000),
        (r"ICHAIN_VEC3F\s*\(\s*scale\s*,\s*" + SCALE_LITERAL, literal_value),
    ]
    # Init's own store, then the init chain, and only then a store anywhere
    # in the file (Obj_Mine's 0.02 is its explosion's, not its size).
    for body, patterns in ((init_body, set_scale), (text, init_chain), (text, set_scale)):
        for rx, conv in patterns:
            for m in re.finditer(rx, body):
                v = conv(m.group(1))
                if v:
                    return v
    return None


def find_y_offset(text, init_body):
    """
    shape.yOffset, which Actor_Draw adds (times scale.y) to the position the
    model is drawn at: ActorShape_Init's second argument or a direct store,
    in Init first, else anywhere in the file. None when never set (0). An
    Init that sets it (even to 0) wins over a store in some later state
    (En_Vm's -5000 while it is blown up).
    """
    m = re.search(r"shape\.yOffset\s*=\s*" + SCALE_LITERAL + r"\s*;", init_body)
    if not m:
        m = re.search(r"ActorShape_Init\s*\([^,]+,\s*" + SCALE_LITERAL + r"\s*,", init_body)
    if m:
        return literal_value(m.group(1)) or None
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
    m = re.search(r"SkelAnime_Init(?:Flex)?\s*\(\s*play\s*,\s*&?[^,]+,\s*(?:\([^)]*\))?\s*&?(\w+)(?:\.sh)?(?:\[[^\]]*\])?\s*,\s*(?:\([^)]*\))?\s*&?(\w+)(?:\[[^\]]*\])?\s*,", text)
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
    for m in re.finditer(r"gSPSegment\s*\(\s*POLY_(?:OPA|XLU)_DISP\+\+\s*,\s*(0x0?[89A-Fa-f]|\d+)\s*,\s*(?:SEGMENTED_TO_VIRTUAL|SEGMENTED_TO_K0|Lib_SegmentedToVirtual)\s*\(\s*(\w+)(\[[^\]]*\])?\s*\)\s*\)", draw_body):
        seg = int(m.group(1), 0)
        sym = m.group(2)
        if m.group(3):
            if sym not in arrays:
                continue
            sym = arrays[sym][0]
        if sym in symbols and symbols[sym]["kind"] == "Texture" and seg not in segs:
            segs[seg] = sym
    return segs


ANIM_MAT_RX = re.compile(r"AnimatedMat_Draw\w*\s*\(\s*play\w*\s*,\s*(?:Lib_SegmentedToVirtual\s*\(\s*)?&?(\w+(?:\s*->\s*\w+)?)")


def find_anim_mat(body, arrays, symbols, assigned):
    """
    MM: the TextureAnimation (AnimatedMaterial list) the Draw applies first
    with AnimatedMat_Draw* -- a symbol, an array's first entry, or a member
    Init points at one. None when there is none.
    """
    is_mat = lambda t: t in symbols and symbols[t]["kind"] == "TextureAnimation"
    for m in ANIM_MAT_RX.finditer(body):
        expr = m.group(1)
        name = re.sub(r"^\w+\s*->\s*", "", expr)
        cands = [expr] if "->" not in expr else []
        if name in arrays:
            cands.append(arrays[name][0])
        for rhs in assigned.get(name, []):
            sm = re.search(r"&?(\w+)\s*\)?\s*$", rhs)
            if sm:
                cands.append(sm.group(1))
        for c in cands:
            if c in arrays:
                c = arrays[c][0]
            if is_mat(c):
                return c
    return None


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


def object_header_text(oot, version, text):
    """The object headers the actor includes (assets/objects/X/X.h), for their limb enums."""
    out = ""
    for inc in sorted(set(re.findall(r'#include\s+"(assets/objects/[^"]+\.h)"', text))):
        path = os.path.join(oot, "extracted", version, inc)
        if os.path.isfile(path):
            with open(path, encoding="utf-8", errors="replace") as f:
                out += "\n" + f.read()
    return strip_comments(out)


def read_actor(oot, name, symbols, object_table, internal, version):
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
    masked = re.search(r"params\s*&=\s*(0x[0-9A-Fa-f]+|\d+)\b", text)
    bare_params_mask = int(masked.group(1), 0) if masked else 0xFFFF

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
    global struct_fields
    struct_fields = struct_arrays(text)
    global draw_fn_lists
    draw_fn_lists = {}
    init_body = function_body(text, init_fn) if init_fn != "NULL" else ""

    # Many actors leave the profile's draw NULL and install one once their
    # object has loaded (actor.draw = ObjTsubo_Draw); those count too.
    draw_fns = [] if draw_fn == "NULL" else [draw_fn]
    for m in re.finditer(r"(?:actor|thisx|dyna\.actor)\s*(?:\.|->)\s*draw\s*=\s*(\w+)\s*;", text):
        if m.group(1) not in draw_fns and m.group(1) != "NULL":
            draw_fns.append(m.group(1))
    enums = enum_values(text + object_header_text(oot, version, text))
    functions = FileFunctions(text, enums)
    functions.consts["__init_action__"] = init_action(text, init_body, functions)
    draw_body = "\n".join(function_body(text, fn) for fn in draw_fns)
    # Segment setups may also sit in a helper the Draw calls that draws one
    # of the model's lists (ObjLightswitch_DrawOpa) -- not in an effect
    # helper, whose segments are its own.
    helpers = [fn for fn in reachable_functions(text, draw_fns, functions)[len(draw_fns):]
               if lists_in(text, function_body(text, fn), arrays, symbols, functions, set(draw_fns) | {fn})]
    helper_body = "\n".join(function_body(text, fn) for fn in helpers)

    skel, anim = find_skeleton(text, arrays, symbols)
    skel_ops, skel_colors = [], {}
    for fn in draw_fns:
        fbody = function_body(text, fn)
        dm = re.search(r"SkelAnime_Draw\w*\s*\(", fbody)
        if dm:
            skel_ops = matrix_ops_before(fbody, dm.start())
            skel_colors = colors_before(fbody, dm.start())
            break
    fn_when = draw_function_conditions(text, init_body, draw_fn, draw_fns, functions)
    lists = draw_lists(text, draw_fns, arrays, symbols, functions, fn_when) if draw_fns else []
    limbs = limb_lists(text, arrays, symbols, enums) if skel else {}
    segs = find_segments(draw_body, arrays, symbols, text, object_table) if draw_body else {}
    for seg, tiles in (find_scroll_segments(draw_body) if draw_body else {}).items():
        segs.setdefault(seg, ("scroll", tiles))
    if helper_body:
        for seg, ref in find_segments(helper_body, arrays, symbols, text, object_table).items():
            segs.setdefault(seg, ref)
        for seg, tiles in find_scroll_segments(helper_body).items():
            segs.setdefault(seg, ("scroll", tiles))

    anim_mat = find_anim_mat(draw_body + "\n" + helper_body, arrays, symbols, functions.assigned) if draw_body else None
    return {
        "animMat": anim_mat,
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
        when = (", when: " + json.dumps(l["when"])) if l.get("when") else ""
        return "{ select: %s, variants: [%s]%s }" % (sel, variants, when)
    extra = (", ops: " + fmt_ops(l["ops"])) if l.get("ops") else ""
    for k in ("prim", "env", "combine"):
        if l.get(k):
            extra += ", %s: [%s]" % (k, ", ".join(str(v) for v in l[k]))
    if l.get("primLod"):
        extra += ", primLod: %d" % l["primLod"]
    if l.get("add"):
        extra += ", add: true"
    if l.get("when"):
        extra += ", when: " + json.dumps(l["when"])
    return '{ %s, layer: "%s"%s } /* %s */' % (fmt_ref(l)[2:-2], l["layer"], extra, l["name"])


def main():
    args = sys.argv[1:]
    game = "MM" if "--mm" in args else "OOT"
    args = [a for a in args if a != "--mm"]
    cfg = GAMES[game]
    out_js = os.path.join(ROOT, "js", cfg["js"])
    objects_out = os.path.join(ROOT, "models", game, "actors", "objects")
    overlays_out = os.path.join(ROOT, "models", game, "actors", "overlays")
    oot = args[0] if len(args) > 0 else os.path.join(ROOT, "..", cfg["decomp"])
    version = args[1] if len(args) > 1 else cfg["version"]
    baserom = os.path.join(oot, "extracted", version, "baserom")
    if not os.path.isdir(baserom):
        sys.exit(f"{baserom}: not found (run the decomp's setup for {version})")

    symbols = read_symbols(oot, version)
    object_table = read_object_table(oot)
    actors = read_actor_table(oot)
    internal = internal_actor_sources(oot)

    entries = []
    files = set(KEEP_OBJECTS + cfg["extra"])
    stats = {"skeleton": 0, "lists": 0, "nothing": 0, "noDraw": 0, "unknownScale": 0}
    for actor_id, name in actors:
        info = read_actor(oot, name, symbols, object_table, internal, version)
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
                files.add(entry["anim"]["file"])  # may be another object (object_ganon_anime2)
            if info["skelOps"]:
                entry["skelOps"] = info["skelOps"]
            for k, v in info["skelColors"].items():
                entry["skel" + k.capitalize()] = v
            files.add(s["file"])
            stats["skeleton"] += 1
        def to_ref(l):
            if "variants" in l:
                # ops / colours set before an indexed list are every variant's
                inherit = {k: l[k] for k in ("ops", "prim", "env", "combine", "primLod") if l.get(k)}
                ref = {"variants": [[to_ref({**inherit, **x}) for x in v] for v in l["variants"]], "select": l["select"]}
                if l.get("when"):
                    ref["when"] = l["when"]
                return ref
            ref = js_ref(symbols, l["sym"])
            ref["layer"] = l["layer"]
            ref["name"] = l["sym"]
            if l.get("index"):
                ref["offset"] += 8 * l["index"]
                ref["name"] += "[%d]" % l["index"]
            for k in ("ops", "prim", "env", "combine", "primLod", "when"):
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
            for idx, found in sorted(info["limbLists"].items()):
                refs = []
                for f in found:
                    ref = js_ref(symbols, f["sym"])
                    ref["layer"], ref["name"] = "opa", f["sym"]
                    if f["ops"]:
                        ref["ops"] = f["ops"]
                    if f["add"]:
                        ref["add"] = True
                    refs.append(ref)
                    files.add(ref["file"])
                entry["limbLists"][idx] = refs
        if info.get("animMat"):
            entry["animMat"] = js_ref(symbols, info["animMat"])
            files.add(entry["animMat"]["file"])
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
        "// Generated by tools/oot/generate_oot_actor_models.py%s from the %s decomp -- do not edit." % (
            " --mm" if game == "MM" else "", cfg["decomp"]),
        "//",
        "// %s: for each actor id, what its Draw function issues, read" % cfg["table"],
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
        "// the Draw issues before it, [r, g, b, a]. when: the params tests of the",
        "// if / switch branches the list sits in (all must hold): [shift, mask, op,",
        "// value] or { any | all | not }. A limb list with add: true is drawn after",
        "// the limb's own list rather than in its place. animMat (MM): the",
        "// AnimatedMaterial list the Draw applies (AnimatedMat_Draw*), drawn at step 0.",
        "// Files are",
        "// models/%s/actors/objects/<file> or, with a vram, .../overlays/<file>." % game,
        "// %s applies its own overrides on top of this." % cfg["overrides"],
        "",
        "const %s = {" % cfg["table"],
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
        if "animMat" in e:
            parts.append("animMat: " + fmt_ref(e["animMat"]))
        if "segments" in e:
            parts.append("segments: { " + ", ".join("0x%02X: %s" % (seg, fmt_ref(r)) for seg, r in sorted(e["segments"].items())) + " }")
        lines.append("    0x%03X: {\n        %s\n    }," % (actor_id, ",\n        ".join(parts)))
    lines.append("};")
    lines.append("")
    with open(out_js, "w", encoding="utf-8", newline="\n") as f:
        f.write("\n".join(lines))
    print(f"{out_js}: {len(entries)} actors -- {stats['skeleton']} skeletons, {stats['lists']} display lists only, "
          f"{stats['nothing']} with a Draw this found nothing in, {stats['noDraw']} with no Draw, "
          f"{stats['unknownScale']} with a computed scale")

    # ---- copy the files the models live in
    os.makedirs(objects_out, exist_ok=True)
    os.makedirs(overlays_out, exist_ok=True)
    copied = missing = 0
    for fname in sorted(files):
        src = os.path.join(baserom, fname)
        if not os.path.isfile(src):
            print(f"warning: {fname} missing from {baserom}", file=sys.stderr)
            missing += 1
            continue
        dst = os.path.join(overlays_out if fname.startswith("ovl_") else objects_out, fname)
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
