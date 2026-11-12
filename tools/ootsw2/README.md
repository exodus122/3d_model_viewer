# OoT (Switch 2) maps from a romfs dump

`extract_romfs.py` builds every map straight from your own romfs dump of the game (no download):

```
python tools/ootsw2/extract_romfs.py "D:/path/to/romfs"                       # every map (~9 min)
python tools/ootsw2/extract_romfs.py "D:/path/to/romfs" --only Graveyard_Child
```

Needs Python 3.10+ with `numpy` and `zstandard`. It reads:

| Game file | Becomes |
|---|---|
| `Banc/<area>/<banc>_{Static,Dynamic}.bcett.byml.zs` | `objects.json` (every placed object; generation groups from the scene's `SimultaneousGroups`) |
| `Phive/StaticCompoundBody/<area>/<banc>[_X#_Z#]...bphsc.zs` | `compound/` (`manifest.json` + `<tile>.tile.bin.gz`, format `romfs-1`): the baked static collision at full detail, every triangle with its object, **surface** and layer |
| `Pack/Actor/<name>.pack.zs` → physics → ShapeParams, `Phive/Shape/Dcc/*.bphsh.zs` | `collision.bin` (OCOL): each actor's solid shapes (entity shapes, not sensors; characters use their standing body) |
| `RSDB/ActorInfo...` | `IsNotTurnToActor` per object |
| `Pack/Bootup...` → `Phive/Config/PhiveConfig.byml` | material, sub material and shape tag names |

New compared to the objmap data:
- **Surface types.** Clicking a triangle shows its material, sub material and shape tags
  (`Stone: Slip, NoStick, Unridable, NoClamber`, `Wood: Climb`, `AirWall`, `DisableRespawn`...).
  Triangles with the AirWall material are drawn as air walls, including invisible walls inside `Land_`
  meshes. The heightmap ground's material isn't decoded yet (shown as "surface unknown").
- **Collision layers.** Each tile holds one Havok compound per collision layer. Where two layers hold the
  same objects (a smooth and a rough copy), the heavier one is the "detail copy" kind; area volumes
  baked into the compound are "baked areas". Both start hidden.
- **Surface view.** "surface colours" tints the static collision by material (lava, abyss, edge of the world,
  no respawn and slippery over it); "highlight" paints one shape tag or material magenta (Abyss,
  DisableRespawn, NoPreventFall, NoStick, Slip, Climb, NoClamber, hookshot, ladders, lava, water...).
- **Hazard zones from the game's own logic.** Area actors that a scene's `AiGroups` logic watches are tagged
  (`zk` / `zl` in objects.json): void out (incl. quicksand and scripted voids), no respawn, safe path,
  whirlpool, cutscene trigger (named after its `Dm_` event). Shared logic is matched by name, scene modules
  by the nodes in their `Logic/*.logic.module.ainb`. They take precedence over objmap's void out table.
- **Wall kinds, by who they block.** `airwall_kinds.json` classifies every air wall actor from its pack:
  the entities' hit masks (`HitOnlyPlayer`, `HitOnlyCharacter` + `HitOnlyEnemy` / `HitOnlyNpc` /
  `HitOnlyAnimal`, `HitOnlyBomb`, `HitOnlyHookshot`...) and the shapes' material presets
  (`Material_AirWall` filters only camera and sight, `Material_AirWall_ForCamera` hits only the camera,
  `AirWallForClimb`...). Kinds: air wall (blocks Link, incl. each map's `Land_*_Airwall_*` boundary and inner
  walls), climb-only, push, enemy-only, NPC / animal, camera / sight, object / other. The non-Link kinds start
  hidden. AirWall-material triangles of level meshes with no air wall actor behind them are "air-wall
  surface (unknown)": who they block depends on per-body collision layers that aren't decoded.
- **Void probe (voxels).** The game decides void-outs with a probe that ignores the collision triangles: it
  casts 64 rays (a golden spiral) from Link into a grid of 1 m cubes, keeps the nearest hit, and voids Link
  once he is 8 m or more sideways from it (worked out in game by the shared oottools mod, `voidmap.cpp`).
  The cubes are the game's VolumeStats voxels, `Phive/VolumeStats/<area>/<banc>_X#_Z#.bpvsts.zs`, decoded
  by `volumestats.py` (a 256 m octree per 250 m cell, 8 levels down to 1 m; format notes in the file)
  into `voxels.bin.gz` per map, with the story-state variants (`_presence_RFTomb_Open_True`...). In the
  viewer: "void map: whole floor" runs the probe standing on every walkable floor of the play area (one
  spot per 1 / 2 / 4 m square and floor level; Kokiri Forest 2.4 s, Hyrule Field 34 s at 2 m) and colours
  the floor; "void map here" checks a grid at a chosen height around the screen centre (jumps, falls).
  Green: under 6 m sideways, yellow under 8, red void, dark red no cube. The check only runs while Link is
  off the ground (the shared tools' notes), so red means "voids if he jumps, falls or is knocked into the
  air there", not "voids standing there". A story-state picker swaps
  variant tiles. The cubes themselves only exist along surfaces (a shell, not a full grid of space), so
  void safety belongs to where Link is, not to a cube. Checked against an in-game void map scan in Kokiri Forest (Child).
  Each cube also has an attribute record (layouts from the game's own table, one per VolumeStats preset:
  Field1m, Dungeon1m, Default1m...). The probe only hits a cube through the faces its Intersect /
  IntersectWater bits mark (a ray entering along axis a in direction s needs bit 2a + (s > 0)), the same test
  the game's code does; a third of the cubes have none and let rays through. The "cubes" picker colours the
  cubes by: void probe faces, in water, water surface, indoor, hiding hole, outside the outer boundary,
  outer boundary distance, dungeon room id (whichever the map has). Not exported: wind / water flow,
  per-face materials, and the coarser 2 m / 4 m levels' records (4 m water depth etc.).
- **English names** for actors without an objmap label, from `Mals/USen...` ActorMsg (`<actor>_Name`).
- Full detail everywhere (no lods): Hyrule Field is ~10M triangles and takes ~20 s to load.
- Maps objmap doesn't list (the DreamWorld boss / enemy stages, SageRoom...).

Still from objmap: the area tables (`actor_shapes.json`, `rigid_body_shape_actors.json`,
`location_areas.json`, `void_out_areas.json`) and the friendly names (`u`), kept from an existing
`objects.json`. `havok.py` and `romfs.py` hold the format notes.

# OoT (Switch 2) maps from the Owl Object Map (older route)

`extract_objmap.py` downloads the 3D data behind https://objmap-oot.zeldamods.org/ into
`models/OOTSW2/` and writes `js/ootsw2_map_list.js`. The viewer reads it in `js/ootsw2_map.js`
(game "OOT (Switch 2)").

```
python tools/ootsw2/extract_objmap.py                 # every map
python tools/ootsw2/extract_objmap.py --only ForestTemple --force
```

## What the site serves

| Source | Contents |
|---|---|
| `game_files/maps.json` | areas -> maps (`map_type`, `map_name`, age, 2D bounds) |
| `game_files/static_compound/<map>/` | **the level**: the game's baked static collision (every static actor + the field ground), meshopt-compressed tiles with LODs, a bodies file per tile (triangle -> object hash id). Drawn by the site's 3D view ("Static compound"). Format in `loadOOTSW2Compound` |
| `game_files/actor_collision/<type>/<map>.bin` | `OCOL`: one collision shape per **actor name**, local space (format in `parseOCOL`). Its trailer lists the hash ids already baked into the static compound |
| `game_files/airwall_meshes.json`, `airwall_mesh_triangles.json` | air wall meshes per actor name |
| `radar-oot.zeldamods.org/objs/<type>/<map>?q=*&limit=-1&dataFields=Rotate,Scale,...` | every placed object: name, hash id, position, Rotate (radians), Scale |

The extractor keeps each compound tile's lod0 (full detail) and lod1. The viewer draws the tiles that
overlap the map's bounds (+100 m) at lod0 and the distant scenery at lod1. Hyrule Field Child comes to
about 4.3M triangles and takes roughly 10 s to load.

Every triangle is tagged with the object it belongs to: compound triangles through the tile's bodies
file, the others by the object they were placed for. The sidebar has one row per actor name (all its
instances, `×N`), in a collapsible group per name prefix (Land, Obj, Npc, Enemy...). Each row's colour
shows where its triangles come from:
- **blue, static permanent:** baked static collision whose object has `IsNotTurnToActor` (never becomes an
  actor). That's level geometry and some baked objects like chest pedestals, plus the heightmap ground and
  far scenery.
- **green, static removable:** baked collision whose object lacks that flag: crack walls, chain-lock doors,
  enemy-count torches, the falling ceiling. The game can turn these into actors, so the collision can go
  away when the object breaks, opens or isn't spawned. Data without the flags falls back to `Land_` =
  permanent.
- **purple, actor collision; orange, hulls; red, air walls.**
- **yellow, static removable (ocarina jump):** removable static collision matching what ocarina jumps were found to need
  in game. The object has neither `Bakeable` nor `IsNotTurnToActor`, body byte 2 in the bodies file
  (Land_ pieces and signs with neither flag have byte 6), and static collision at least 0.6 m from bottom
  to top: large / boss key chests (1.75 m), pullable gravestones (1.10 m) and bean plants (0.96 m) work,
  small chests (0.55 m) and grass (up to 0.42 m) don't. That's the collision's vertical extent, not how
  tall the object looks: a bean plant's leaf is low but its collision reaches 0.8 m below it. The real cut
  is somewhere between 0.55 and 0.96 m (`OCARINA_MIN_HEIGHT` in `main.js`); click info shows each
  candidate's extent. Green "static removable" (crack walls, the
  Graveyard monument), blue, hulls (pots, crates) and actor collision don't work. The byte's meaning is
  unknown; the rule comes from in-game tests, not the game's code.

Click info and row tooltips show objmap's friendly name ("Locked door (Small Key)"). The "links"
checkbox (off by default) draws each object's `Links` as lines, yellow at the source end and cyan at the
target. The "Collision types" checkboxes above the groups hide one kind on every row,
including rows that hold several (a `Land_` piece's air walls hide while its static collision stays).
The "Other" group holds the field's heightmap ground (bodies with no hash id)
and the far scenery tiles, which are loaded at lod1 without bodies.

**Loading zones and areas** (`js/ootsw2_areas.js`, a port of objmap's area layer) are see-through
volumes:
- **Loading zones.** A zone is a `FieldAndDungeonEntranceEventRequestActor` plus the area-type objects
  in its generation group, labelled with its destination (`NextBancParamNameChild/Adult`,
  `NextStartPosName`).
- **Areas.** Area-type objects are sorted into objmap's categories with `location_areas.json` and
  `void_out_areas.json`: location areas, dungeon rooms, void outs, possible void outs, warp backs, air
  wall shapes, other areas and minor areas (fog, culling, nav mesh, camera).
- **Shapes.** Each volume comes from `actor_shapes.json` (box / sphere / capsule / cylinder, or point-set
  parts), the object's Scale and `RigidBodyShapeType`.

The Collision types row has a second line for these: "loading zones" and one checkbox per area
category. Void outs, possible void outs, warp backs and air wall shapes start on; locations, rooms, other
and minor areas start off, since they cover whole regions. Loading zones also have a group with a row per
zone (labelled with its destination) to hide single zones. Each area category has a group too, with a row
per actor name (`Area ×214`, `AirWallEnemy_NavMeshCut ×84`); location areas get a row per location name
("Hyrule Field", "Lon Lon Ranch"). A volume shows when both its row and its category checkbox are on.

`objects.json` predating these fields needs `--refresh-objects`.

Objects that aren't baked into the compound (doors, crates, NPCs, enemies) are placed from their OCOL
shapes: scale, then `R = Rz * Ry * Rx`, then translate (objmap's own transform). Without a compound the
viewer falls back to rebuilding the `Land_*` pieces the same way, which leaves holes because objmap has
no OCOL shape for many of them. Units are metres, drawn x10.

## Limits

- **Collision only, no render models or textures.** The site never ships visual meshes.
- No surface types (floor / wall / climbable...): the compound has none.
- The rows have no wireframe (millions of edges).
- The compound manifest's `terrain.bin` isn't downloaded. It's objmap's decimated copy of the heightmap
  ground (Death Mountain Trail: 37.6k triangles, max error 0.14 m), made only to drape its map image on;
  the game doesn't use it. The real ground is the "Ground (heightmap)" row.

## Reading the game files directly

https://github.com/mrissaoussama/oot26-tools reads collision straight from a romfs dump of the game
(Havok, BYML, actor packs) and builds invisible walls and void zones, with surface kinds (climb-only,
push walls, void-out, no-respawn). It also has a Cheat Engine table that streams Link's live
position. That would be the route to real surface types; it needs your own romfs dump.
