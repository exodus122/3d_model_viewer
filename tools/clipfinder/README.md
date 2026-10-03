# clipfinder

The wall push clip scan for OoT and MM (and OoT3D / MM3D, see **OoT3D and
MM3D** below), native and multithreaded. It reads a
scene from `models/`, builds the same collision model the viewer does, and
runs the search in the game's f32 arithmetic. It writes the clip points as
JSON, which you can load with the viewer's **Import results** button or run in
game with `tools/clipfinder/wall_clip_tester.lua`.

It also has tools for studying a single clip: the lowest speed that does it,
the angles that work, and a step-by-step single-frame simulation.

## Building

A Windows build, `clipfinder.exe`, is in the repo. To build it yourself you
need a C++17 compiler. Use whichever of these you have:

- **g++ or clang++** (Linux, macOS, or Windows with MSYS2 / MinGW-w64):

  ```bash
  sh tools/clipfinder/build.sh
  ```

  It uses `$CXX` if set, else the first of `g++`, `clang++`, `c++` on the
  PATH, else MSYS2's `C:\msys64\mingw64\bin\g++.exe`. On Windows it writes a
  static `clipfinder.exe`, which runs without the MinGW DLLs. Elsewhere it
  writes `clipfinder`. `OUT=path` builds somewhere else. On Windows, install
  MSYS2 and run `pacman -S mingw-w64-x86_64-gcc` in its shell. On Debian or
  Ubuntu, install the `g++` package. On macOS, run `xcode-select --install`.

- **Visual Studio** (Windows, 2019 or later, with "Desktop development with
  C++"), from a Command Prompt or PowerShell:

  ```bat
  tools\clipfinder\build.bat
  ```

  It finds Visual Studio itself (it doesn't need a Developer Command Prompt).
  It writes `clipfinder.exe`, or the path you give it. The object files go in
  `build/msvc/`, which git ignores.

Every build gives the same results. MSYS2 g++, Ubuntu g++ 13 and Visual
Studio 2019 write byte-identical JSON for MM West Clock Town, Human, `--type
all`. That's because the scan's maths is done in f32 with no fused
multiply-adds: `-ffp-contract=off` for g++ / clang, and for Visual Studio
`/fp:precise` without `/arch:AVX2`. Don't add `-ffast-math`, `/fp:fast` or
`-march=native`. They change the results. The Visual Studio build is about a
third slower than g++.

On Linux and macOS, the clipfinder commands in this README are the same, with
`tools/clipfinder/clipfinder` in place of `tools/clipfinder/clipfinder.exe`.

A rebuild fails at the link step (`ld returned 1 exit status`, or `LNK1104`)
while `clipfinder.exe` is running. Wait for the run to finish first, or build
a copy somewhere else with `OUT=path/to/other.exe sh tools/clipfinder/build.sh`
(`tools\clipfinder\build.bat path\to\other.exe`).

The source is in `src/`, split by layer; `src/main.cpp`'s header comment
lists what each file holds. Link-time optimisation (`-flto`, `/GL /LTCG`)
lets the hot collision checks inline across files, so the split costs no
speed.

## Examples

```bash
# One map, one form
tools/clipfinder/clipfinder.exe --game MM --map "Laundry Pool" --form Human -o tools/clipfinder/results/laundry.json

# Every map, adult and child, falling clips too, one file per map
tools/clipfinder/clipfinder.exe --game OOT --all --form Adult,Child --type all

# Resume an --all run after the map where it stopped
tools/clipfinder/clipfinder.exe --game MM --all --form All --after "Laundry Pool"

# The lowest speed for one clip, exactly, and the angles that work
tools/clipfinder/clipfinder.exe --game MM --map "Treasure Chest Shop" --form Human --pair 50,90 --refine -o tools/clipfinder/results/tcs_50_90.json
tools/clipfinder/clipfinder.exe --game MM --map "Treasure Chest Shop" --form Human --pair 50,90 --angles --max-speed 11

# That clip at one yaw, at speed 15 or less
tools/clipfinder/clipfinder.exe --game MM --map "Treasure Chest Shop" --form Human --pair 50,90 --yaw 0xF000 --max-speed 15 -o tools/clipfinder/results/tcs_50_90_f000.json

# A start for each yaw from 0xFF80 to 0x0000, at speed 10.5 or less
tools/clipfinder/clipfinder.exe --game MM --map "Treasure Chest Shop" --form Deku --pair 50,90 --yaw 0xFF80-0x0000 --max-speed 10.5 -o tools/clipfinder/results/tcs_50_90_range.json

# One frame, step by step
tools/clipfinder/clipfinder.exe --game MM --map "Treasure Chest Shop" --form Human --sim "-239.859,0,824.246,0xFF9D,11"

# One map's dynapoly actors in setup 2 (from the viewer's export), only the wall pairs with a dynapoly wall in them
tools/clipfinder/clipfinder.exe --game OOT --map "Spot 01 - Kakariko Village" --form All --type all --setup 2 --dyna-only -o tools/clipfinder/results/kak_dyna.json

# Every map's dynapolys, every setup ("Export all dynapolys"), one file per map and set of setups
tools/clipfinder/clipfinder.exe --game OOT --all --form All --type all --dyna-only
```

Progress and summaries print to the terminal (stderr). The JSON goes to the
output file.

## Options

### What to scan

| Option | Meaning |
|---|---|
| `--game OOT\|MM\|OOT3D\|MM3D` | **Required.** OoT US 1.0 or MM US scenes, or the 3DS versions' (`models/OOT3D`, `models/MM3D`; see **OoT3D and MM3D** below). |
| `--map "<name>"` | One map, named exactly as in the viewer's map list (`js/model_list.js`), e.g. `"Spot 01 - Kakariko Village"`, `"Laundry Pool"`. |
| `--all` | Every map of the game, one JSON per map (see `--out-dir`). Use this or `--map`. |
| `--after "<name>"` | With `--all`: skip the maps up to and including this one, to resume a run that stopped. |
| `--form <forms>` | Link's form, which sets the wall check radius and height. OoT: `Adult` (radius 18), `Child` (14), `Crawlspace` (10, check height 15: the crawling state, child only). MM: `Human` (14), `Deku` (14), `Zora` (18), `Goron` (19.5), `FierceDeity` (27). `All` means every form of the game. A comma-separated list, like `Adult,Child`, means just those. Default: `Adult` / `Human`. |
| `--radius R` | Use radius R instead of the form's. Single form only. |

Several forms go into **one** JSON, with each clip marked with its form.
Forms with the same radius and check height share one scan and are labelled
together, e.g. `"Human/Deku"`.

A smaller radius's clips are **not** a subset of a bigger radius's. Resting
spots, what fits between walls, and which walls are in reach all change with
the radius, so scan each form you care about.

### What to look for

`--type` picks the clips, as a comma-separated list, e.g. `--type acute,falling`.

Types: `acute`, `extended`, `slope`, `ground`, `falling`, `actions`

| Type | Clips |
|---|---|
| `acute` | Walking wall push clips of acute pairs (see **Acute or extended** below) |
| `extended` | Walking wall push clips of extended pairs; without `acute`, acute pairs are left out entirely |
| `slope` | Slope clips (see **Slope clips** below) |
| `ground` | Ground clips (see **Ground clips** below) |
| `falling` | Falling wall push clips: of acute / extended pairs if either is picked too, else of both |
| `actions` | Sword lunge, jumpslash and Deku spin clips (see `--action-keys` and **Action clips** below); not with `falling` or `ground` |

Default: `acute,extended,slope`. `all` means `acute,extended,slope,ground,falling` (everything but `actions`).

| Option | Meaning |
|---|---|
| `--type T,...` | Which clips to look for (the types above). A scan only runs when a type needs it (the wall push scan for acute / extended / falling, the slope and ground scans for theirs), so `--type slope` or `--type ground` is quick. `--clip-kind falling / slope / ground` adds its type. `--out-dir` adds the types to the file name unless they are the default: `..._acute-falling.json`, `..._all.json`. The JSON's `"falling"` is true with `falling`, `"extendedOnly"` with `extended` and not `acute`. |
| (`falling`) | The wall push clips while falling ("low" clips, `drop` > 0). Link's post-move position (posNext) is 2–30 below the floor, so the wall check runs lower than when walking. Slower. Falling crossings are only generated for drops where `checkHeight + dy >= 5`, and each move is checked again from its own start: the drop is measured from the floor at the clip point, and downhill Link starts higher, so he can fall further than that (tested in game: OoT Kakariko Village child, 20 such moves through TRI 673 / 21 / 26 / 20 / 28 falling 21-26 from the start, none clipped). Beyond that, the game's line test runs from Link's feet with floors included and stops him on his own floor (MM Human: drop over 21.8, OoT: over 21, Crawlspace: over 10). |
| (`extended` alone) | `extended` without `acute` keeps only the wall pairs (pusher, clipped wall) that clip **only** thanks to the walls' extended planes: the 1-unit / `detMax 300` tolerance of the game's triangle checks, or the pusher reaching past its own edge. (The game's wall check projects Link onto a wall along the Z or X axis, not the wall's normal, so a diagonal wall also pushes Link standing beside it, past its end: at 45 degrees as far past as he is in front of its plane.) See **Acute or extended** below for how a wall pair is categorised; this leaves out every acute pair, all its points included. The terminal says how many pairs and points were left out. With `--first-per-pair`, a pair whose first point found was extended isn't checked for acute points afterwards. |
| `--first-per-pair` | Keep the first clip found for each wall pair (pushing wall, clipped wall), like the tester's one-per-pair recording mode. The output is much smaller, but the scan isn't much faster: most of the time goes on points that never clip. |
| `--max-per-pair N` | Keep at most N points of each wall pair, spread out evenly: the first chosen, then over and over the point farthest from all the ones chosen so far (so they cover the pair end to end, e.g. 10 points 120 apart along a 1300 long wall). Each row the viewer shows a pair in (crossing / standing, walking / falling, and each kind) is thinned separately, so no row goes missing. Always kept: the lowest `--min-speed` reach (thinning runs after it), and a point that makes an acute pair acute. Smaller files: OoT Kakariko Village, child, falling: 16178 points / 6.8 MB, with `--max-per-pair 10` 1403 points / 0.59 MB, all 184 rows still there. Written to the JSON as `"maxPerPair"`. Not applied with `--refine`, `--yaw` or `--angles`. `--type actions` thins by default (see below); `--max-per-pair` there sets the cap instead. Without it, `--max-mb` thins any file over 5 MB. |
| `--max-mb N` | The most a results file may be, in MB (default 5; `0`: no limit). A file that would be bigger is thinned the way `--max-per-pair` thins it, with the biggest cap that fits. The terminal says so (`file over --max-mb 5: kept ... of ... clip points, at most N per wall pair and row`), and the JSON gets `"maxPerPair"`. No row goes missing: each keeps at least one point, its slowest reach and the point that makes the pair acute. Without it, OoT Spirit Temple with setup 0's dynapolys was 17.4 MB (Adult, 45561 points) and 15.3 MB (Child), mostly ground clips and falling points: one wall pair, 1740 through 1289, had 8798 points. Not with `--max-per-pair`, which sets the cap itself, or with `--refine`, `--yaw` or `--angles`. |
| `--action-keys KEY,...` | `--type actions`: a sword attack's own movement doing the clip, from a standing start (see **Action clips** below). Default all; keys: `1h-slash`, `1h-stab`, `2h-slash`, `2h-stab`, `stick-slash` (the Deku stick: two-handed and always the forward slash, so the 2h slash's frames), and the jumpslash: `1h-jumpslash` with the stick left alone in the air, `1h-jumpslash-fwd` with it held forward (see **Jumpslash** below; one-handed only, the other weapons jump the same way), each of those with a `-walkin` variant (run into a corner first, see below), and MM Deku's `deku-spin` and `deku-spin-backwalk` (see **Deku spin** below). MM3D: the recorded ones (see **MM3D actions**). MM: Human, the sword ones; Deku, the spins; OoT: Adult (the sword ones) and Child (the Kokiri Sword's and the stick's); other forms are skipped. The jumpslash is left out of a map whose rooms are all indoors (Z + A rolls there). The file is `..._actions.json`; the other types picked with it (acute / extended / slope) narrow which clip points the lunges aim at and which of their clips are kept. A lunge clips from far more starts than the viewer needs (over a thousand for one wall pair, about 1 KB each with its frames), so without `--max-per-pair` each row keeps at most 40 points, spread out as `--max-per-pair` does, fewer (down to 6) when the file would pass 4000 points in all: MM Pirates' Fortress Interior, 50451 points / 47.7 MB, becomes about 4000 / 4 MB. Not with the `falling` or `ground` types, `--min-speed`, `--refine`, `--yaw` or `--angles`. |
| `--pair P,C` | Keep only the clips where TRI P pushes Link through TRI C (polygon ids, as the viewer and tester show them; for a slope or ground clip P is the floor, C the wall). Needed for `--refine` / `--angles`. The scan only looks near the two triangles: the wall pairs and slope walls within a frame's move (`--max-move`) plus two radii and 10 of them. Every triangle still collides as usual, and the pair's clips come out the same as a whole-map scan's (OoT Death Mountain Trail setup 2, falling, TRI 90 → 25: 168 s → 14 s). |
| `--dyna FILE\|none` | The dynapoly actors; by default `tools/clipfinder/<GAME>_dyna_all.json` (a warning and no dynapolys if it isn't there), `none` for none. From the viewer's **Export all dynapolys** (every map's, every setup; see **Dynapolys** below). A single map's `dynapoly-1` export (the old **Export dynapolys**) still works. Each map is scanned once per set of setups with the same dynapolys, and once without dynapolys if the file has none for it. Output files named by `--out-dir` get `_setup<N>[-<N>...]_dyna` added; with `-o` and several sets, `_setup...` goes before `.json`. |
| `--slope-step 1\|2\|3` | The slope clip scan's widest step along a wall's bottom edge (default 3; see **Slope clips** below). `1` searches every unit. |
| `--wall-step S` | After the normal scan, look again for wall push clips on the wall pairs that have none, with standing points every S (below the normal 0.5, e.g. `0.25` or `0.1`) and crossing points every S / 2 along the pushing wall. The normal scan coarsens a big pair's grid until it's at most 40000 points (a long wall can end up several units apart); this pass doesn't. It stops at each new pair's first clip, so the file only grows by about a point per pair it finds: once a pair is known to clip, `--pair P,C --refine` / `--angles` / `--yaw` look at it closely. Pairs with a clip already (any kind) are skipped. Slow: a step half the size is about 4x the standing points. The terminal says how many new pairs it found. |
| `--ground-step 1\|2\|3` | The ground clip scan's widest step along a wall's bottom edge (default 3; see **Ground clips** below). `1` searches every unit: the most (floor, wall) pairs, about 2.5x as long. |
| `--keep-load-void` | Keep the clips whose start is on a loading zone (a floor with an exit, `SurfaceType_GetExitIndex`) or a void plane (floor property 5 / 12, MM 13 too). Left out by default: standing there takes Link out of the scene before any clip matters. Only the floor under the start counts; dynapolys never do (the export has no surface types). E.g. OoT Death Mountain Trail, adult: 374 of 1818 points, nearly all of TRI 348 → 346 / 345, start on the summit's exit to the crater (TRI 453, exit 5). `--sim` prints the start's floor, and `--tri` a poly's exit and floor property. |
| `--slope-starts` | Also search the crossing points whose surroundings are only in bounds when the rays that go into a slope first are ignored (see **In bounds** below). Finds some more crossing clips starting on slopes, but about 3x slower on a mountain: OoT Death Mountain Trail setup 2, adult, falling: 21333 points (4 more wall pairs) in 110 s instead of 21039 in 38 s. |
| `--aerial` | With the `falling` type: a falling clip may also start in the air where Link couldn't stand still, exactly where the move starts, not moved to a resting spot (the walls there needn't have pushed him out: a bomb or an enemy knocks him there after the frame's wall pushes). Only for a clip point no resting start does. Not under a floor within 50 above him (the floor check would put him up on it). The JSON marks those clips `"aerial": true` (the viewer says so in the description), and the file name gets `_aerial`. E.g. MM West Clock Town, human: the step TRI 164 through TRI 59 from z 23.57, 11.4 in front of 59 (a community setup, bombed at the corner). Not with `--min-speed`, `--refine`, `--yaw` or `--angles`. |
| `--no-corners` | Don't try starts in convex wall corner pockets (see **Convex corner pockets**). The output is then the same as before they were added. |
| `--dyna-only` | With `--dyna`: only scan the wall pairs that have a dynapoly wall in them (pusher or clipped wall), and skip maps without dynapolys. Much faster; the static-only pairs are what a scan without `--dyna` finds, give or take the dynapolys' effect on them. |
| `--setup N` | With `--dyna`: only the dynapolys of setup N, for every form. Without it, OoT pairs each form with the setups it plays in (see **OoT forms and setups** below). |
| `--night` | OoT: the night setups too (child 1, adult 3), which are left out by default. |

### Speed and angle analysis

| Option | Meaning |
|---|---|
| `--min-speed` | For every clip, the lowest speed that does it: starts in 32 directions every 1 unit up to `--max-move` away, each where Link comes to rest there, with the real frame run. Written to each clip as `"reach": {speed, yaw, start}` (`null` if none). The terminal lists the lowest per wall pair. The viewer's "Reachable" filter uses these; without them, each clip's own move speed. |
| `--refine` | With `--pair`: the exact lowest speed for that clip (of the kind `--clip-kind` picks: walking, falling, slope or ground). It searches every standable in-bounds start within 24 of the best coarse one (0.25 grid), every yaw toward the clip points (then single steps), and speeds every 0.02, bisected down to the exact f32 boundary. A speed only counts if the clip also works at +0.0025 … +0.01, which rules out single-value flukes (like posNext landing exactly on a wall's plane). The JSON's `clips` then holds **only the refined clip** (its `prev` is the start, its `yaw` and `speed` the move), so the tester runs exactly that move. If the refine finds nothing, the ordinary clips are written. Implies `--min-speed`. |
| `--angles --max-speed S` | With `--pair`: every yaw that does that clip at speed S or less, each from its own start, as `--yaw` finds them (and the same table: a start per yaw, without the CSVs). It starts from the refined yaw (`--refine`'s lowest speed, about 1.5 s) and the scan's clip moves already at speed S or less, and walks out from each that clips, `0x10` at a time both ways, until 16 yaws in a row don't clip (`--angle-gap N` for another number; bigger is slower, about 2N failing yaws for the two ends of each run): the yaws that work come in runs, sometimes with a gap (Treasure Chest Shop Human 50 → 90 at 11: `0xFF40`–`0xFFEF`, then `0x0010` on). Prints the runs on one line (`Yaws that clip at speed up to S: ...`). A run more than that many yaws away from the others isn't found; `--yaw FROM-TO` covers a range for sure. About 4 s a yaw at speed 10 (no CSV grid to make): Treasure Chest Shop Human 50 → 90 at 10, 106 yaws in 7 minutes, clipping at `0xFE30`–`0xFFEF`, `0x0010`–`0x007F`, `0x00A0`–`0x017F` and a few single yaws up to `0x03CF`. |
| `--from X,Y,Z[,SPEED]` | With `--pair`: after refining, try all 4096 directions from this one start (feet position): the yaws that clip at SPEED (the refined speed if not given), the yaws that clip at any speed up to `--max-move` / 1.5, and each direction's lowest speed. The game's sine table ignores the yaw's low 4 bits, so e.g. `0xFFC0`–`0xFFCF` move Link the same way. Only that start: a clip that needs Link pressed against a wall to a few thousandths works at other yaws from other starts (`--angles` finds those). Warns if Link wouldn't stand still there or if it's out of bounds. Implies `--refine`. |
| `--yaw YAW --max-speed S` | With `--pair`: the lowest speed (of the kind `--clip-kind` picks) up to S that does that clip moving at exactly YAW (`0x1234` or decimal), from any standable in-bounds start. `--yaw FROM-TO` (e.g. `0xFF80-0x0040`, going up through `0xFFFF` → `0` when TO is below FROM) does every yaw from FROM to TO in steps of `0x10` (the low 4 bits don't change the move), prints each yaw's answer as it goes (with the slowest start's exact position), then a table on stdout, one row per yaw: its minimum speed and a start that clips at it, as exact f32s to set Link at (or `none`). Every start is tried, not just until a slower one turns up. Starts within 0.75 of each other are grouped into regions; a yaw with several separate regions gets a `region` row for each under its own, with that region's lowest speed and its start. Each yaw that clips also gets a CSV next to the JSON, `<output>_<YAW>.csv` (e.g. `tcs.json` → `tcs_FFC0.csv`; with several forms the form is in the name too): a grid of round x values (columns) and z values (rows), about 20 × 40, stepped 1, 2 or 5 × a power of ten, and each cell `Yes` if Link standing exactly there (the nearest f32 to that number) clips at some speed up to S, else `No`. Each cell is tested at its own coordinates, so the grid shows the shape of where the clip works. It starts over the starts found and grows until its edge rows and columns are all `No`, so it covers the whole shape even without `--exact`. (The starts that work are usually thin strips, e.g. along the edge of a wall Link is pressed against: the CSV shows their shape.) The JSON then holds one clip per yaw that works. Starts are every resting spot behind the scan's clip points of the pair along YAW (up to S × 1.5 back and 3 either side, every 0.002 across YAW (`--side-step D` to change it: smaller finds more positions but takes longer, e.g. 0.0005 about 4x) and 0.5 along it: a start pressed against a wall can have to be right to a few thousandths); speeds as for `--refine` (every 0.02, bisected, robust to +0.01). Prints the speed and start, or that none works. The JSON's `clips` holds only those clips, or nothing if none works at those yaws (unlike `--refine`, the scan's clips are never written instead). Slower at high S (Treasure Chest Shop at 30: 35–90 s; at 10: about 5 s). Can't be combined with `--min-speed` / `--refine` / `--angles` / `--from`. |
| `--exact` | With `--yaw`: after the sampled search, try **every f32 x and z** around each region it found: the region's box, one side-step bigger each way, growing until nothing that works is within a side-step of its edge (only the new strip is tried each time). A point counts if Link stands still there (his resting spot is that exact point), it's in bounds, and it clips at some speed up to S. The table and the minimum speeds then come from these (the CSVs test their own grid either way). It only fills in around what the sampling found: a separate spot narrower than `--side-step` that no sampled start landed in is still missed. Treasure Chest Shop Deku 50 → 90 at 0xFFD0, speed 9.9: 12 sampled positions became 28,238 (min speed 9.8214 → 9.8047), about 12 s. A region that would grow past 50 million points is left as sampled. |
| `--speed S` | With `--yaw` or `--angles`: also find, per yaw, a start that clips at **exactly** speed S (printed under the yaw's row, `at exactly S: start ...`; the JSON's clip for the yaw is that move, and a yaw without one gets no clip; with `--angles` the runs line lists the yaws that clip at exactly S). Each start the search found (lowest speed v <= S) is tried as it is, then moved (S - v) x 1.5 back along the yaw so posNext lands where v put it, and a few steps of 0.00005 either way; it has to be where Link rests, in bounds, and clip at exactly S. E.g. Treasure Chest Shop Human 50 → 90 at 9.94054: `0x0120` from (-240.411819, 0, 824.492676), `0x0130` from (-240.434586, 0, 824.502808). With `--yaw` it also makes the CSV grids at exactly speed S: a cell is `Yes` if Link standing exactly there clips moving at the yaw at speed S, and its `_speeds.csv` is S everywhere, so the tester tries every cell at S. Stands in for `--max-speed` if that's not given (the search for starts goes up to S). |
| `--clip-kind walking\|falling\|slope\|ground` | Which of the pair's clips `--refine`, `--yaw`, `--angles`, `--from` and `--speed` work on, and so which frame they run from each start: **walking** wall push (posNext 7.5 below the floor), **falling** wall push (posNext `--drop` below it), a **slope** clip (the frame, then the slowest second frame that works: `speed2`; the speed found is the first frame's) or a **ground** clip (at the pair's `vy`, -20). Default: the first of walking, slope, ground and falling the pair has; the terminal says which, and when the pair has other kinds too (a sloped floor's crossing clips and a ground clip can share a (floor, wall) pair). The clips written are of that kind, `drop` / `speed2` / `vy` included, so the tester runs them as such. |
| `--drop D` | Falling clips: posNext D below the start (y velocity -D / 1.5). This is the fall from where Link starts, not the scan's `drop`, which is measured from the floor under the clip point; down a slope he falls up to about 10 more than that. It has to be at most checkHeight - 5 (21 for Link in OoT); a bigger fall runs the line test at his feet, which isn't a wall push. Default: `--refine` uses the fall of the pair's slowest move that works (the lowest speed is the point), and `--yaw` / `--angles` the smallest valid fall of the pair's clips, or `--refine`'s when `--angles` refines first. If none of the pair's falling clips has a valid fall, nothing is refined and the terminal says so. Falling refines can be slow: OoT Kakariko Village, child, TRI 142 -> 673 ran past 25 minutes. |
| `--max-move N` | How far Link can move in one frame, in units. Default 55 in all four games: speed 36.67 for OoT / MM (a frame moves 1.5 x speed), speed 55 for OoT3D / MM3D (1.0 x). It used to be 45 (speed 30). Crossing points are tried from starts up to 32 back by default, and every 4 past that out to N when N is over 45. `--min-speed`, `--refine` and `--from` look for starts up to N away (speed N / 1.5; N on OoT3D / MM3D). Written to the JSON as `"maxMove"` when it isn't 45 (a file without it was scanned at 45); the viewer's max move box picks it up on import. Scans take longer the further out it goes. |

### Debugging one frame

| Option | Meaning |
|---|---|
| `--sim X,Y,Z,YAW,SPEED[,DROP]` | Run one frame and print each step (a slope clip is reported too). DROP can be given as a y velocity instead, `vVY`: `v-20` is a drop of 30. A drop of more than checkHeight - 5 runs the ground clip frame (see **Ground clips**): the start floor's line test plane distance, the line test at the feet, the pushes, the floor check and the verdict. SPEED as `15/7`: one frame of walking per speed at the same yaw, each ending with the floor check, then two frames standing still, printing where each one leaves Link and which wall he's behind; for slope clips. Link stands at (X, Y, Z) (feet) and moves at YAW (`0x1234` or decimal) with speedXZ SPEED. posNext is 7.5 below his feet (walking), or DROP below if given (falling). Prints: whether the start is in bounds and a resting spot (with a `WARNING` when there is no floor under it, or a floor within 50 above his feet that the floor check would put him up on: inside a step, not a real start; a floor further below is noted as being in the air), the line test and what it hits, every wall push, where he ends up, and whether that's a clip and out of bounds. Use it when a clip works in game but the scan disagrees, or the other way round. Nothing is written. `X,Y,Z,FACING,@KEY` (e.g. `@2h-stab`) runs that action's frames instead, Link facing FACING, and prints each frame, the two standing still and the action clip verdict. |

### Output and running

| Option | Meaning |
|---|---|
| `-o FILE`, `--out FILE` | Write the JSON here (single map). |
| `--out-dir DIR` | Write each map's JSON into DIR (default `tools/clipfinder/results`, where the viewer's auto-import looks) as `<GAME>_<map>_<form>[_<types>][_first][_setup<N>_dyna][_pair<P>-<C>].json` (`_<types>`: `--type` when it isn't the default, e.g. `_acute-falling`, `_all`, `_actions`) (`_first`: `--first-per-pair`; `--pair` and `--first-per-pair` get their own files, so they don't overwrite the whole map's full scan). Used with `--all`, or with `--map` instead of `-o`. The directory must exist. A path clipfinder can't write stops the run straight away. Note that clipfinder is a Windows program: from WSL, `/tools/...` means `C:\tools\...`, so use relative paths like `tools/clipfinder/results`. |
| `--root DIR` | The viewer's folder (with `models/` and `js/model_list.js`). Default: the current folder if it has `js/model_list.js`, else two levels up from the exe. |
| `--threads N` | Worker threads. Default: all cores. |

## The terminal

Per map and form (and its setup's dynapolys), the wall pairs found (a wall
and one it could push Link through, close enough) and the walls that push,
then each step with its clip points and time (a count shows while it runs):

1. **Wall pushes from a standing start**: Link just in front of each wall
   pair, moving into it (walking; falling too with `--type falling` or a
   jumpslash), so one wall's push takes him through the other. Starts every
   0.5.
2. **Wall pushes through a wall's face**: moves into each pushing wall from
   up to `--max-move` away; the line test stops Link at the wall and the
   pushes from there take him through the wall behind it. Every 0.25 along
   the wall.
3. **Slope clips**: walking up to each wall along its bottom edge, where the
   floor check lifts Link onto a floor behind it.
4. **Ground clips** (`--type ground`): falling fast from the floor, through
   it and under a wall.
5. **Finer pass** (`--wall-step`): 1 and 2 again, finer, on the wall pairs
   with no clip yet, one clip each.

`= N clip points in all` is after the same point found twice is kept once
and the ones starting on a loading zone or void plane are left out. With
`--type actions`, **Actions** aims each attack at those clip points and
lists what each found; the last line says how many the file keeps.

## Output format

```jsonc
{
  "format": "wall-push-clips-2",
  "game": "MM", "map": "Treasure Chest Shop", "falling": false, "extendedOnly": false, "numPolygons": 97,  // , "maxMove": N with --max-move, "setups": [...] with --dyna
  "forms": [
    {"form": "Human", "radius": 14, "checkHeight": 26.8000011}
  ],
  "clips": [
    {"form": "Human",
     "kind": "acute" | "extended" | "slope" | "ground", // the wall pair's category (below), the same for all its points
                                           // (files from before 2026-09-26: per point, and "low" for falling ones)
     "cross": true,                        // crossing (moving through the pusher's plane) vs standing point
     "drop": 0,                            // falling: how far below the floor posNext is (0 = walking)
     "pusher": 50, "crossed": 90,          // TRI ids: the wall that pushes, the wall Link ends up behind
     "from": [x, y, z],                    // the clip point (posNext, or where the line test hits)
     "prev": [x, y, z],                    // where Link stands before the frame
     "next": [x, y, z],                    // posNext after the move
     "res": [x, y, z],                     // after this frame's pushes
     "end": [x, y, z],                     // after 2 more frames (out of bounds)
     "floorY": 0,
     "yaw": 65473, "speed": 9.8252573,     // the move from prev to next (s16 yaw, f32 speedXZ)
     "speed2": 4,                          // slope clips: the next frame's speed (same yaw), if it needs one
     "vy": -20,                            // ground clips: velocity.y for the frame (next.y = prev.y + vy x 1.5)
     "yaws": [...],                        // crossings: the yaws that worked, of the 32 start directions tried for this point
     "reach": {"speed": ..., "yaw": ..., "start": [...]}  // --min-speed (slope / ground clips: left out when it's the clip's own move, which the viewer fills in)
    }
  ]
}
```

All numbers are the exact f32 values, printed so they read back unchanged.
Older single-form files (`wall-push-clips-1`) still import into the viewer
and the tester.

## Using the results

- **Viewer:** load the map. With **Auto-import** on (the default), the
  viewer imports every results file for it from `tools/clipfinder/results`
  (or the folder in the box): the files `--out-dir` named for the map
  (`<GAME>_<map>_...json`) whose `map` and poly count match, that are static
  scans or scanned with the loaded setup's dynapolys (`setups`). They're
  merged: a marker row per form and kind, each point once. So the usual
  setup is one `--all` scan and one `--all --dyna <GAME>_dyna_all.json
  --dyna-only` scan into that folder. Dynapoly scans of other setups, and ones
  made from an export without `setups` (before 2026-09-27), are left out.
  This lists the folder through the server's directory pages, which
  `python -m http.server` has. **Import results** loads one file by hand.
  Clicking a point describes it.
- **In game:** set `TESTS_FILE` in `tools/clipfinder/wall_clip_tester.lua` to the JSON.
  It reads the walls from RAM, runs the tests for the form Link is in, and
  writes `wall_clip_results.txt`. See the settings at the top of that script
  (`SKIP_FALLING`, `MAX_PER_GROUP`, `FORM`, …).
- **Checking a `--yaw` run's CSVs in game:** each `<output>_<YAW>.csv` comes
  with `<output>_<YAW>_speeds.csv`, the same grid with the speed to try each
  cell at (a Yes cell's lowest speed that clips, a No cell's max speed). Set
  `TESTS_FILE` to the run's JSON and `CSV_TESTS = true`: every cell is tried
  in "move" mode (Link moved by the game from exactly that x, z at the yaw),
  and each grid's result is written to `<output>_<YAW>_ingame.csv`, with
  `No (expected Yes)` / `Yes (expected No)` where the game disagrees. The
  summary counts the cells that match and lists the rest. `CSV_CELLS =
  "border"` tries only the cells next to one with the other answer (about a
  quarter of them). Turn `RECORD` off for this: it adds 3 s a cell.

## Dynapolys

Without `--dyna` the scan sees only the scene's static collision. With it, the
dynapoly actors the viewer had loaded join in, the way `z_bgcheck.c` handles
them:

- **Every map at once.** **Export all dynapolys** in the wall clip panel
  writes `<GAME>_dyna_all.json` (format `dynapoly-set-1`): for every map,
  every setup, the dynapoly actors that setup spawns, built the same way as
  the Actors rows but without drawing anything (a few seconds). Setups with
  identical dynapolys share one entry (`setups: [0, 2]`), and so one scan;
  maps without any are left out. Every actor is in, in its default state.
- **Order.** Each map's actors are written in the order they take bg actor
  slots, which is the order the game checks them in and can decide a clip:
  spawn order,
  except that the actors that register their collision from Update once
  their own object has loaded (Bg_Spot01_Objects2, Door_Shutter, ...:
  `LATE_BG_ACTORS` in `js/render_actors.js`) come after all the others. (In
  Kakariko setup 2 a crate pushes Link through the shooting gallery's wall
  only because the gallery's walls are checked after the crate's.) Each actor is its tangible polys in world
  space as `DynaPoly_ExpandSRT` builds them (s16 vertices, normals and plane
  distances recomputed from those), plus the bounding sphere and Y range the
  game culls it with. The viewer draws each actor in its default state (switch
  flags unset and so on), and that state is the one exported.
- **Wall pushes** (`BgCheck_CheckWallImpl`): the dynapoly walls push *before*
  the static ones: every bg actor whose Y range and bounding sphere (grown by
  the radius) take Link, all its walls' Z pushes, then all their X pushes. The
  lists are in reverse poly order, unsorted, with no early out. Then the
  static walls push, in the subdivision of where the dynapolys left him.
- **The dynapoly line check.** After a dynapoly collision (a dynapoly push, or
  the frame's line test stopping him on a dynapoly with no static push after
  it), the game checks the line from posPrev to the result against the
  **static** walls, one face only, and puts Link the radius in front of the
  first one crossed. That stops most "a dynapoly pushes Link through a static
  wall" clips, but not where the line misses the wall: it runs at Link's feet,
  and walking it ends 7.5 below the floor, under a wall whose bottom is at
  floor level. The other way round, a static wall pushing him through a
  dynapoly, isn't checked at all.
- **Line tests and floors.** The frame's line test and the floor check include
  the dynapolys (`BgCheck_CheckLineAgainstDyna`, `BgCheck_RaycastFloorDyna`:
  dynapoly floors have the `detMax 300` tolerance, and their walls count as
  floors only when nothing else was found). Standable spots, in bounds and
  "behind a wall" all see them too.
- **What counts.** A clip through a static wall still has to leave Link out
  of bounds. A clip through a **dynapoly** wall counts wherever he ends up,
  as long as he's still behind it two frames later, and passing clean through
  a thin one is allowed: getting past a gate, a fence or a door is the point,
  and that usually lands in bounds.
  See **Ending in bounds** below for clips that end in bounds elsewhere. This covers dynapolys pushed through by
  other dynapolys (the same actor's or another's), and static walls pushing
  Link into a dynapoly, like a crate against a wall.
- **Poly ids.** Dynapolys get the ids after the scene's own, in the file's
  order (`numPolygons` on). The results carry the export as `"dyna"`, so the
  viewer rebuilds the same ids on import, and labels them, e.g.
  `TRI 971 (Obj_Kibako2 dynapoly 4)`. `--sim` does the same.

Things the export can't know: actors that move (they're exported where they
spawn), ones that only appear later, and which dynapoly actors are loaded
together in-game. The export has each actor its spawn list has for the chosen
setup.

## OoT forms and setups

An OoT scene's setups (layers) 0 and 1 are child day and night, 2 and 3 adult
day and night, 4 on cutscenes. A scene without one of them loads another
(`Scene_CommandAlternateHeaderList`): adult night falls back to adult day,
anything else to setup 0. Most scenes only have setup 0, which both ages use.

With `--dyna` (and no `--setup`), each form is scanned only with the
dynapolys of the setups it plays in: Child and Crawlspace setup 0, Adult
2 (and the night setups, child 1 / adult 3, with `--night`), each resolved that way from the setups the scene has (the viewer's
setup list, `models/OOT/actors/OOT_actors_by_scene.json`). The terminal prints
the pairing, e.g. Death Mountain Trail (setups 0, 2, 4-8): `Adult setup 2,
Child setup 0, Crawlspace setup 0`. A form whose setups have no dynapolys is
scanned without them (skipped with `--dyna-only`); cutscene setups are only
scanned with `--setup`, which takes every form.

The viewer does the same on auto-import: loading setup 0-3 of an OoT map
shows only the forms that play in it (the status says which were left out);
a cutscene setup shows every form.

## OoT3D and MM3D

`--game OOT3D` / `--game MM3D` scan the 3DS versions' scenes (`.zsi` in
`models/OOT3D` / `models/MM3D`, the viewer's `OOT3D_Maps` / `MM3D_Maps`), with
OoT's / MM's forms (radius, check height) and the same collision checks.
What changes:

- **30 fps.** `Actor_UpdatePos` moves velocity x 1.0 a frame instead of x 1.5,
  so a speed moves 2/3 as far: walking, posNext is 5 below the floor (not
  7.5), and a falling frame's drop is at most 20 (terminal velocity -20; not
  30). Speeds in the results are speedXZ as the game has it (posNext is
  `speed` along the yaw): MM3D Treasure Chest Shop, Human, TRI 50 → 90 needs
  speed 16.43 where MM needs 11.01.
- **Max move.** The default `--max-move` is 55 as on the N64, but that's
  speed 55 here (36.67 there).
- **The scene file.** Little-endian, the plane distance an f32 (the N64's is an
  s16), 0x14-byte polys (`parse_model.js`). Poly ids are the 3DS file's.
  OoT3D's overworld (`Spot` ...) scenes use 32 x 8 x 32 subdivisions, and
  `IS_ZERO` is 0.00008 (the viewer's `EPS`).
- **Ground clips.** The wall check's feet-level line test still comes on at the
  N64's y velocity, as if dy were velocity x 1.5: checkHeight + dy x 1.5 < 5
  (`feetLine`), so below y velocity -14 for OoT. At -20 Link falls only 20, so
  the wall check runs 6 above the floor, on the wall, not under its bottom
  as on the N64. The clip still works when the move ends far enough past the
  wall that it doesn't push him back. In game: OoT3D Shadow Temple, adult,
  from (-1763.541, -63.00192, 77) at yaw 0 and y velocity -20, speed 25 goes
  under TRI 48 and out (20 doesn't; the model says 23 and up clip). The 1.5 is
  fitted to that clip, not read from the 3DS code (`z_bgcheck` isn't
  decompiled in oot3d). `tools/clipfinder/tools/ground_clip_poke.lua` (any of the four games) gives Link a
  speed and y velocity for one frame to try one by hand.
- **Actions: MM3D only, recorded.** `--type actions` for MM3D uses the
  actions recorded in the game (see **MM3D actions** below); OoT3D has none.
- **Not supported:** dynapolys (the viewer has no 3DS dynapoly actors, so none
  are loaded by default).

Assumed, not checked against the 3DS code: the floor check leaving velocity.y
at -4 and gravity -1 a frame as on the N64, minVelocityY -20, and libultra's
sine table for the move's direction. The viewer imports the results like the
N64 ones.

`wall_clip_tester.lua` runs them in BizHawk's 3DS core (OoT3D US Rev 1, MM3D
US, decrypted) in "move" mode only (there are no function addresses to hook),
2 emulated frames a game frame. MM3D action tests: see **MM3D actions** above. OoT3D's addresses are from the oot3d decomp
(`include/z3Dactor.hpp`, `z3D.hpp`). MM3D has no decomp: its Player and
globalContext are read through the pointers at 0x0752FD6C / 0x0754D890, with
the actor fields taken from N64 MM's layout, which matches where the watch
file shows it. At the start the tester checks that the frame counter
(OoT3D GameState.frames, play + 0xF8; MM3D play + 0x138) goes up once a game
frame, and if not, searches the first 64 KB of the game context for a word
that does and uses that (printing it). It also checks that Player.yaw
(speedXZ + 4) reads the same as Link's facing, and stops if not. In game,
MM3D Laundry Pool TRI 26 → 70 and TRI 239 → 234 clipped this way. MM3D reads Link's form from save.playerForm (s16 at
0x0765B1FE, taken as N64 MM's values: 0 Fierce Deity ... 4 Human); `FORM`
overrides it.

### MM3D actions

MM3D's animations are re-made at 30 fps (the 1h slash is 7 frames, the N64's
5, with a different root path) and there's no decomp for how its Player plays
them, so the N64 tables don't apply. Instead the moves are measured:
`tools/clipfinder/tools/mm3d_action_recorder.lua` (BizHawk 3DS core, MM3D US) does
each action from a standing start and records Link's home.pos, world.pos,
speedXZ and yaws every game frame. Keys: `1h-slash`, `1h-stab`, `2h-slash`,
`2h-stab`, `stick-slash` (Human) and `deku-spin`, `deku-spin-backwalk` (Deku),
the same keys as MM's, so the viewer's rows are the same.

1. Stand Link idle on flat, open ground (nothing within ~200: a wall changes
   the move), in the form, with the weapon on B for the lunge (1h: Kokiri
   Sword; 2h: Great Fairy's Sword; stick: Deku Stick).
2. Run the script, pick the action, **Record** (or **Record all** for every
   action of Link's form). It saves a savestate, taps L for the camera, does
   the inputs (B + the Circle Pad forward - pushed earlier and retried until
   the lunge happens, speedXZ above 7; the stabs with L held;
   the spins: the stick held, A once speedXZ stops rising, the backwalk L held
   with the stick back then L let go a frame before A), and loads the
   savestate back. The first take finds which way Circle Pad Y is "up".
3. Each take writes `tools/clipfinder/tools/mm3d_actions/<key>.json` (and
   `<key>_log.txt`, every emulated frame's raw values), replacing the last.
4. `clipfinder --game MM3D --map ... --form Human,Deku --type actions` loads
   every file there.

A row is one game frame's swept move, split as on the N64: the root motion
added after the last frame's bg check (world.pos - home.pos at its end, in
Link's frame) and this frame's speedXZ move (home.pos - the last world.pos, at
an angle from his facing). If MM3D moves the root before the bg check, the root
part is just 0 and the whole move is in the speed part; clipfinder sweeps it the
same. Leading rows that move him nowhere are dropped; a spin's rows end on the
frame his shape stops turning. The spins are aimed only at frames faster than
their run-up (the file's `aimMin`: a slower frame is a walking clip), stop part
way (`canStop`) and aim at acute corners, as MM's.

Off the ground mid-attack, Link is put back at prevPos (MM `func_8083827C`,
taken to be the same in MM3D): with the swing active, and in MM also during any
root motion when the floor under prevPos is within 10 of him
(`func_808381F8`). That covers every lunge frame, so no MM / MM3D lunge
carries him off a ledge or out over a void (Laundry Pool's 2h stab clips went
away with it). OoT only has the swing check. The swing frames themselves aren't
measured (a row gets them with `"swing": true`). Not modelled: the stick
speed's wall cap in the spins, whose speeds are the recorded, unobstructed ones. No `-walkin`, jumpslash or spin-attack keys for MM3D yet.

`wall_clip_tester.lua` tests them in game (`runActionTest3DS`): Link is held at
the start facing the test's facing with L held from half way (the camera
behind him). The Circle Pad's directions are found once from the starting
state: Link is pushed up, then right. A lunge is B with the stick forward
(stabs with L still held). With no lunge (speedXZ never above 7) the test runs
again with the stick pushed earlier, 0 to 6 emulated frames before B, as the
recorder does; status `no lunge` if none of those lunge. A Deku spin follows
the recording's timing from `mm3d_actions/<key>.json`: frames counted from the
first one Link moves on, A on the frame after `pressRow` (the backwalk lets go
of L the frame before), the stick held to the recording's last row or let go
after `stopAfter`. Each game frame the stick is steered so Link's move yaw
(Player.yaw) follows the recording's, since the camera turns while he runs.
Statuses: `no recording`, `no run-up`, `no spin`. Each lunge test puts its
weapon on B (save + 0x17A) with MM's item ids, which MM3D shares, and presses B
at three points in the hold so he draws it. Deku Sticks aren't topped up (the
MM3D ammo address isn't known).

`mm3d_anim_roots.py` dumps the animations' root motion from the extracted ROM
(`actors/zelda2_link_new.gar.lzs`: LzS-compressed GAR2, CSAB animations, every
root track baked one value a frame) and, with `--compare`, sets them against
a recording - to check how MM3D plays them (rate, scale) once there is one.

## Holding the stick, and floor snaps

Two kinds of clip beyond one push from a standing start:

- **Hold clips** (`"hold": true`). After the clip frame the scan normally has
  Link stand still for two frames; a wall he's less than 4 behind pushes him
  back out, so that isn't a clip. If he keeps holding the stick instead, the
  next frame's move (the same yaw and speed) can take him further behind it
  before its check runs, and then it can't. When standing still fails, the
  scan tries that one extra frame, then two standing still, and marks the
  point `hold`. The viewer says so when you click it. `wall_clip_tester.lua`
  doesn't hold the stick yet, so it won't reproduce these. (OoT Ice Cavern:
  the rock TRI 721 puts Link 1.5 behind the red ice, and holding on takes him
  through.)
- **Floor snaps.** Moving more than his radius in a frame, the game's line
  test includes floors, and it puts Link the radius out along a sloped
  floor's horizontal direction just as for a wall. That can put him behind
  the wall the slope runs up to, so sloped floors are pushers too, for
  crossings only (floors never push in the wall check). (OoT Bottom of the
  Well: the slopes TRI 863 and 860 through the walls TRI 876 / 884 / 885.)
  The line only meets a slope where it has risen checkHeight - 7.5 above
  Link's floor, often most of a frame's move away, so for slope pushers the
  scan looks for his floor and starts out to the full `--max-move`, beside
  the slope every 8 up it and where the line test runs (7.5 below Link's
  check height walking, up to checkHeight - 5 falling): where a slope meets
  a wall, only there is the floor he starts on beside it. Many need speeds
  near or over 30: OoT Shadow Temple, adult, TRI 1182 through TRI 1160 gives
  737 walking points, 90 of them from the flat floor TRI 1207 below the
  slope (before the floor search looked up the slope, 17, all on the slope).

Not modelled: a running start. Every frame starts where Link stands still. A
clip whose frame has to start where only a previous frame's move could have
put him (e.g. still sliding along a wall that would push him away if he
stopped) isn't found. The Ice Cavern red ice clip is one of these.

## Slope clips

`"kind": "slope"`. Walking, posNext is 7.5 below the floor Link starts on,
wherever the move takes him, so the frame's wall check and line test run at
checkHeight - 7.5 above his *start*. Walking up a steep slope into a wall
whose bottom edge is higher than that, nothing stops him: he moves past the
wall's plane, and the floor check (from prevPos.y + 50) puts him on the
higher floor there: the slope's own 1 unit tolerance past its edge, or a
floor behind the wall. Now he's behind the wall at his check height.

He doesn't even have to get past the wall's bottom edge when the wall leans
out over the slope (an overhang, its normal pointing down): at his new check
height its plane is further out than at its bottom, so the slope lifts him
behind it while he's still on the slope. OoT Death Mountain Trail, adult:
stand at (-112.4565, 1273.895, -1522.771), yaw 0x4100, speed 12, then 4. The
51 degree slope TRI 675 runs up to the overhang TRI 642.

The next frame the wall pushes him back out if he's at most 4 behind it
(`wallPush`). So standing still after that frame doesn't always work, and a
second frame's move at the same yaw (`speed2`, the slowest of 1, 2, 3, ...
that works) takes him further behind first. OoT Inside Jabu-Jabu's Belly,
adult: stand at (-722, -338.6496, -4797.859), yaw 0xA617, speed 15, then
speed 7 (4 is the slowest). The slope TRI 2632 runs up to TRI 2630, whose
bottom is at y -320: the wall check runs at -320.15. Where there's a floor
behind the wall more than 4 back, one frame does it on its own (OoT Hyrule
Field: TRI 762 behind TRI 758).

A clip's `pusher` is the floor that lifts Link and `crossed` the wall. The
frame's own pushes and line test mustn't put him behind any wall (then it's
an ordinary wall push clip). The scan goes along every wall's bottom edge,
split into stretches with the same floors behind the wall: every unit along
a stretch up to 60 long, every 2 up to 120, every 3 past that (at most
`--slope-step`; OoT Hyrule Field, child: 12 pairs in 6 s, `--slope-step 1`
16 s; Death Mountain Trail, adult: 5 of 6 pairs in 1.7 s, 3.7 s). At each point it needs a floor that would put Link's check
height on the wall, behind its plane, and a lower floor in front. It aims
moves from standing starts in front to land from 24 in front of the bottom
edge to 24 past it.

**Standing starts.** A start is where Link comes to rest on a floor near the
clip's floor height, not on a slide floor (floor effect 1, `SurfaceType_GetFloorEffect`: `Player_HandleSlopes` makes him slide down it, or pushes him down it facing uphill, at (1 - normal.y) x 40, up to 10; OoT Ice Cavern's icy slopes; dynapolys never count, the export has no surface types; `--tri` and `--sim` say when a floor is one), and not under a floor within 50 above his feet: the
game's floor check runs down from there and would put him up on it (OoT
Kokiri Forest, child: the ground under a tree's roots or a ledge; 5 of 424
pairs were such starts).

**In bounds.** Link is out of bounds if he's behind a wall, or if one of 8
level rays at his check height meets the back of a wall first. For where he
starts or stands (every clip kind, and the viewer's reachability), a ray that
goes into a floor first doesn't count: up a slope the rays pass under the
ground, and under the walls on it, to the back of some wall far off. (The
Death Mountain Trail start above was out of bounds without this, by a wall
240 away.) Whether a clip *ends* out of bounds still uses every ray. One
check keeps every ray unless `--slope-starts`: the crossing search's quick
"is anywhere around this point in bounds" test (3 and 12 either side of the pushing wall along its normal, then 3 and 12 in front of it at 45 degrees either side: at an acute corner the spots along the normal are all behind the other wall or the pusher, MM West Clock Town TRI 164 by TRI 59). Its sample spots are at a
nearby floor's height, often in the air or the ground, and ignoring the rays
into slopes there lets through far more points than it finds clips for.
`reach` is the move itself (the faster of the two speeds); `--min-speed`
leaves it as it is.

Not modelled: Link's own slope handling (sliding down a slope too steep to
stand on, or slowing on one). `wall_clip_tester.lua` runs slope clips in
"move" mode, writing `speed2` just after the first frame, and judges him
after the second.

## Ground clips

`"kind": "ground"`, with `--type ground` (not in the default types). Falling fast, the game's wall check changes its line
test: when checkHeight + dy < 5 (dy is posNext.y - prevPos.y, so a y
velocity below (5 - checkHeight) / 1.5, -14 for Link in OoT) it tests the
line from prevPos to posNext themselves, Link's feet, with floors, instead
of at his check height. If he starts the frame on the floor, that line
starts on the floor's plane, and whether the floor counts as crossed comes
down to the f32 rounding of its plane distance there (`planeDistA` in
`CollisionPoly_LineVsPoly`): just under 0 and the line goes on into the
ground. (The viewer's yellow "ground-clippable" bands on standable surfaces
are where it does.) Then it passes under the bottom of a wall rising out of
that floor, and the wall push, at posNext.y + checkHeight, is under the
wall's bottom too. The floor check (from prevPos.y + 50) finds whatever is
behind the wall, or nothing, and he falls out of bounds.

OoT Kakariko Village, child: on the slope TRI 491 at (435.5778, 35.55124,
626), pressed against TRI 507, y velocity -20, yaw 0x0000, speed 18. The
line test's plane distance at the start is -0.0000153, and there's no
floor behind TRI 507:

```bash
tools/clipfinder/clipfinder.exe --game OOT --map "Spot 01 - Kakariko Village" --form Child --sim "435.5778,35.55124,626,0,18,v-20"
```

The scan goes along every wall's bottom edge where a floor meets it, split
into stretches with the same floors in front: every unit along a stretch up
to 60 long, every 2 up to 120, every 3 past that (at most `--ground-step`).
At each point it keeps one clip per floor Link starts on (a pair's floor,
which can be a small one further back). OoT Hyrule Field, child: 384
(floor, wall) pairs in about 20 s; `--ground-step 1`, 394 in about 55 s.
It tries starts on that floor (resting spots) moving at the wall
from pressed against it to 24 further back, aimed to end 1 to 24 past it,
at y velocity -20 (the fastest, `minVelocityY`: it goes deepest, soonest).
A clip's `pusher` is the floor Link starts on, `crossed` the wall he goes
under, `vy` the y velocity; `reach` is the move itself. It must end out of
bounds (or past a dynapoly wall), and a wall push or line snap putting him
through the wall is an ordinary wall push clip, not this.

The y velocity is the hard part: Link standing on the floor has -4. The
tester writes `vy` (before gravity) as for falling clips, and runs ground
clips in "move" mode. Not modelled: the ceiling check (from prevPos.y + 10,
up to ceilingCheckHeight + dy - 10, which is small at this dy).

## Action clips

`--type actions`. A melee attack's lunge moves Link by its animation's root
motion (`func_80837948` starts the attack with
`ANIM_FLAG_UPDATE_XZ | ANIM_FLAG_ENABLE_MOVEMENT` and zeroes his speed).
`AnimTask_ActorMovement` adds it to `world.pos` after Player's update, so
after that frame's bg check; the next frame's `prevPos` is from before it
(`Player_UpdateCommon` copies `home.pos`), so that frame's bg check sweeps the
root motion exactly like a walking move: line test, wall pushes at posNext
7.5 below the floor, floor check from prevPos.y + 50. OoT and MM do the same.

The lunge is the stick held forward: the stab when Z-targeting, else the
forward slash (a Deku stick always does the forward slash, with the same
animation as the sword's). It sets `PLAYER_STATE2_30` (MM
`PLAYER_STATE2_40000000`), so the attack's first action frame sets speedXZ
15, which `Math_StepToF(speed, 0, 5)` takes straight to 10: Link moves 15
forward the next frame, then 7.5 (speed 5), on top of the root motion.

The frames (`src/action.cpp`, `ACTIONS`) come from the decomps' animation
data (`link_animetion`: `gPlayerAnim_link_fighter_{normal,pierce,Lnormal,Lpierce}_kiru`
and their `_end`), replayed the way the game does it, and the moves are
bit-exact: each game frame is the root translation the movement task used
(this frame's and `prevTransl`) and the speedXZ. The animation plays one
frame a game frame (2/3 x 1.5); when it ends, its `_end` animation takes over
at 1.5 frames a game frame and the root motion carries on for a few more
frames (the 2h stab steps back about 20 units over frames 5-10).

- **OoT**: the first frame's `prevTransl` is the skeleton's base translation
  (-57, 3377, 0) x the age's scale, a Vec3s (child: 11/17, so -36), so Link
  steps back first. `SkelAnime_UpdateTranslation` rotates the two root
  translations separately and subtracts.
- **MM** (Human): `ANIM_FLAG_NOMOVE` zeroes that first move (no step back),
  the difference is taken before rotating, and the move is scaled by the
  form's `unk_08` (Human 11/17).

The first frames, as speed (move / 1.5) and angle from the facing:

| Game | Key | Frames |
|---|---|---|
| OoT Adult | `1h-slash` | 7.2605 at +0x7799 (back), 14.2290 at -0x0362, 5.0144 at -0x044A, then small |
| | `1h-stab` | 7.6269 at +0x7FAE (back), 11.2740 at -0x006F, 6.9610 at -0x00B4, then small |
| | `2h-slash` | 3.7175 at -0x7750 (back), 11.0236 at -0x0109, 5.9938 at -0x01FF, then small |
| | `2h-stab` | 7.5614 at +0x00CA, 15.5509 at +0x01F1, 8.3326 at +0x0188, then back ~20 over frames 5-10 |
| OoT Child | `1h-slash` | 7.2331 at +0x785F (back), then as adult |
| | `1h-stab` | 7.6271 at -0x7F93 (back), then as adult |
| MM Human | `1h-slash` | 12.7276 at -0x0272, 5.0030 at -0x02C7, then small |
| | `1h-stab` | 10.8242 at -0x004B, 6.2687 at -0x0081, then small |
| | `2h-slash` | 10.6615 at -0x00B1, 5.6416 at -0x015F, then small |
| | `2h-stab` | 13.5888 at +0x0170, 7.1554 at +0x0128, then back ~13 |
| OoT Child | `stick-slash` | 3.7496 at -0x75D3 (back), 11.0236 at -0x0109, 5.9938 at -0x01FF, then small |
| MM Human | `stick-slash` | 10.6615 at -0x00B1, 5.6416 at -0x015F, then small |

The other actions, the same way (from `ACTIONS`; flat ground, nothing in the
way):

| Game | Key | Frames |
|---|---|---|
| OoT Adult / Child, MM Human | `1h-jumpslash` | air: 8 frames on flat ground, speedXZ 5 stepping down 0.1 a frame (velocity.y 5, gravity -1.0 then -1.2); landing frame: the air speed - 1 (~3.3) plus root motion 18.1878 at +0x0077 (OoT adult; child 18.1868 at +0x0026; MM 0), then small |
| | `1h-jumpslash-fwd` | as `1h-jumpslash`, but the air speed goes up 0.05 a frame instead (to at most 6 OoT, 6.72 MM: full stick x 0.8 x 0.14) |
| | `1h-jumpslash-ls`, `1h-jumpslash-fwd-ls` | as above, then after the landing frame the stored lunge: 9.7200 at +0x0000, 4.6467 at +0x000F (MM 9.8188, 4.7714 at +0x0009), then small |
| OoT Adult | `1h-spin-fwd` | 0.6679 at -0x4271, 10.0006 at -0x006F, 5.0000 at +0x002A, 1.5215 and 1.2276 at +0x3E (sideways), then small |
| | `2h-spin-fwd` | 1.2234 at -0x6468, 10.8069 at +0x0040, 5.1468 at -0x0044, then small |
| | `2h-spin-lock` | 1.2234 at -0x6468, then small for 15 frames, **14.7600 at +0x0000** (the end animation's jump), then back 4.1412, 4.0951, 6.6354 (~0x8000), then small |
| | `2h-spin-lock-fwd` | 1.2234 at -0x6468, 10.8069 at +0x0040, 5.1468 at -0x0044, then as `2h-spin-lock` |
| | `2h-spin-lock-r`, `2h-spin-lock-fwd-r` | as without `-r`, stopping at the 14.7600 frame (no step back) |
| OoT Child | `1h-spin-fwd` | as adult |
| | `2h-spin-fwd`, `2h-spin-lock*` | as adult, the first frame 1.3156 at -0x6106 |
| MM Human | `1h-spin-fwd` | 10.0002 at -0x0048, 5.0000 at +0x001B, then small |
| | `2h-spin-fwd` | 10.5220 at +0x002B, 5.0949 at -0x002C, then small |
| | `2h-spin-lock` | small for 15 frames, **9.5506 at +0x0000** (the jump), then back 2.6796, 2.6498, 4.2935 (~0x8000), then small |
| | `2h-spin-lock-fwd` | 10.5220 at +0x002B, 5.0949 at -0x002C, then as `2h-spin-lock` |
| | `2h-spin-lock-r`, `2h-spin-lock-fwd-r` | as without `-r`, stopping at the 9.5506 frame |
| MM Deku | `deku-spin` | run 2, 4, 6, the A frame 6, then the spin: 8.0000, 9.9405, then down 0.3892 a frame to 4.8811 (all at +0x0000; walls lower the stick's speed, see **Deku spin**) |
| | `deku-spin-backwalk` | backwalk 1.5 up to 9.0000, Z let go 9.0000, the A frame 9.0000, then the spin: 10.3297, 9.9405, then down 0.3892 a frame to 4.8811 (all at -0x8000, backwards) |
| MM Zora | `zora-punch` | 12.0004 at -0x01F3, 6.0910, 3.0740, 1.8963 (about -0x02 to -0x04), small, then back 6.2044, 11.2036, 3.1938 (~0x7E00) |
| | `zora-jumpslash`, `zora-jumpslash-fwd` | air: 10 frames on flat ground, speedXZ 5.5 (velocity.y 4.5, gravity -1.0 then -0.8; `-fwd` up 0.05 a frame to at most 6); landing frame: the air speed - 1 (~3.6), then 1.4600, 1.3933 forward, ~4 back, ~2 forward |
| | `zora-clip`, `zora-clip-fwd` | as the Zora jumpslash, then **42.9533 at +0x0000** (64.4 units in one frame), 1.7054, 2.3968, 2.7082, 1.6933 |

The `-walkin` variants (every lunge, stick slash, jumpslash and Zora key; not
the spin attacks or Deku spins) run in first: speed 2, 4, then the run limit
(MM Human 5.5, else 6), held 6 more frames, the B / A frame at the run speed,
and for the slashes and stabs a frame standing still (see **Running into a
corner first**), then the same frames.

Not modelled: the sword hitting a wall. From the animation's frame 2 on
(`func_80842DF4`, MM `func_808401F4`), if the line past the sword's tip hits a
wall, speedXZ becomes -14 and Link recoils (about 13.5 back, then 6). That
needs the sword's position, which clipfinder doesn't have; it comes after
the two big frames, but can undo a clip.

The lunges are grounded (the jumpslash: see **Jumpslash** below); the clip kinds tested are wall pushes (acute or
extended) and slope clips.

How it searches: the ordinary scan first (walking wall push clips and slope
clips; no falling, no ground clips), then every action is aimed at each of
their clip points: for each of the action's frames, from 13 directions
around the point's own move (±0x80 up to ±0x1000, and a crossing's yaws that
worked), the facing that makes that frame move that way, and the start that
puts that frame's posNext on the point (and 0.5 / 1.5 either way along the
move), where Link comes to rest there. Then the whole action is run: each
frame, then two frames standing still. It's a clip if a frame leaves him
behind a wall (at its posNext height: a wall push, by that frame's pushes or
line test snap; failing that, on the floor its floor check lifts him onto: a
slope clip), he's still behind a wall after standing still, and he ends out
of bounds (or past a dynapoly wall). At most one clip per clip point and
action. The pair's category is per action: acute if any of its points still
clips with the extended planes removed, pushed from in front of the pusher's
face.

In the JSON each clip has `"action"` (its name), `"actionKey"`, `"facing"`,
`"actionFrames"` (the frame data) and `"frames"` (where each frame leaves
Link); `prev` is the start, and `yaw` / `speed` / `next` the clip frame's own
move. `reach` is the start, with speed 0: the lunge is the move. The viewer
shows them in their own row, **Action Clips (sword lunges)**, whatever their
kind.

`wall_clip_tester.lua` runs them by doing the attack: Link is held at the
start facing `facing` with Z held (Z-targeting nothing swings the camera
behind him), then B is pressed with the stick forward for a game frame; the
stabs keep Z held, the slashes let go of it first. A jumpslash is Z + A
with the stick left alone, then R held; the `-fwd` keys also hold Z and the
stick forward for its `airFrames` (the JSON's count of air frames). It sets
`meleeWeaponAnimation` to -1 before, and reports "no attack" / "wrong attack"
when the game didn't do the test's attack. It also sets up the weapon
(`SET_WEAPON`, `ACTION_WEAPONS`): each test puts the action's weapon on B and
presses B once while holding Link at the start, so he draws it, then checks
he's holding it ("no weapon" if not). OoT adult: Master Sword (1h), Biggoron
Sword / Giant's Knife (2h); child: Kokiri Sword (1h), Deku stick
(`stick-slash`, stick ammo set to 10 if 0); MM Human: Kokiri Sword (item 77,
1h), Great Fairy's Sword (item 16, 2h), Deku stick (item 8, `stick-slash`). MM's B item address is checked against Link's form
first. The savestate just needs Link on foot, no menus or text.
`ACTION_KEYS` limits the run to some actions; `STICK_FORWARD` is the analog
value for stick up.

E.g. OoT Lost Woods, adult: the 2h stab from (2247.61841, -40.052494,
-787.8526) facing 0x3A0F: its second frame's line test hits the slope TRI 974
and snaps Link through TRI 807, with no floor under him. MM Treasure Chest
Shop, Human: TRI 50 → 90 with all four lunges.

### Jumpslash

Z-targeting + A (`func_8083BA90`, MM `func_808395F0`): Link leaves the ground
at speedXZ 5 and velocity.y 5, with no root motion in the air
(`Player_Action_80844AF4`, MM `Player_Action_29`). Each air frame is an
ordinary actor move: velocity.y takes the gravity (the boots' -1.0 on the
first frame, since it's set before the action that starts the jump, then
-1.2), posNext = pos + velocity x 1.5, then the line test or wall pushes at
posNext's height and the floor check from prevPos.y + 50, which also lifts him
onto a floor he's under while rising. The stick left alone, speedXZ steps
down 0.1 a frame; held forward (the `-fwd` keys, Z held so the camera is
behind him), up 0.05 a frame towards the stick's speed (full stick 6.72,
capped at the run speed limit: OoT 6, MM 10; on flat ground, a floor pitch
lowers it). The yaw stays the facing. On flat ground he lands on the 8th air
frame.

Where the floor check first puts him on a floor falling, he lands: speedXZ
drops by 1 and the landing slash starts (`JUMPSLASH_FINISH`,
`gPlayerAnim_link_fighter_Lpower_jump_kiru_hit`). Its root motion is replayed
like a lunge's; in OoT its first frame moves him about 27 forward
(`PLAYER_ANIM_MOVEMENT_RESET_BY_AGE` against the skeleton's base
translation), MM's `ANIM_FLAG_NOMOVE` drops that. That first frame's posNext
is lower than walking: velocity.y is only reset to the ground's -4 the frame
after landing, so it's (velocity.y - 1.2) x 1.5 below the floor, about 10.
OoT keeps the swing active into it (off the ground: put back), MM clears it.
When the slash ends, its step back (`Lpower_jump_kiru_end`, about 27 back)
is modelled as interrupted one frame in: holding shield (or the stick) does
that, and the tester holds R. The tables come from `gen_jumpslash_frames.py`
(the decomp's animation data).

A jumpslash is aimed at the scan's falling clip points too (its descent and
landing check walls low), so jumpslash runs scan falling as well. Not
modelled: ceilings (a low one cuts the jump short), the sword hitting a wall
(a recoil), and which room the start is in (a scene with some indoor rooms
keeps the jumpslash, and the tester says "no attack" there).

### Deku spin

MM Deku, A on the ground (`Player_ActionHandler_6` -> `func_80839A84`,
`Player_Action_95`). No root motion, only speedXZ, each frame worked out as
the game does it in floats (`dekuSpinFrames` in `src/action.cpp`), from
standing still with the stick held at full tilt throughout:

| Key | Inputs | Speeds |
|---|---|---|
| `deku-spin` | stick toward the facing; A the frame after speedXZ reaches 6 | run up 2, 4, 6; the A frame 6 (the action handler runs before the speed step); then the spin 8, **9.94**, 9.55, 9.16, ... |
| `deku-spin-backwalk` | Z held, stick back (Link faces `facing`, moves the other way); once speedXZ is 9, Z off for a frame, then A | backwalk 1.5 ... 9 (the parallel backwalk, `Player_Action_6`, steps to the stick's 6 x 1.5); Z off 9 (`func_8083A844`: he turns to face the way he's moving); A 9; then the spin **10.33**, 9.94, 9.55, ... |

The spin: `func_808373A4` sets `unk_B10[0]` 20000. Each frame the target is
the stick's speed (Deku's run limit, 6) x (1 - 0.9 (11100 - B10[0]) / 11100)
with B10[0] going down 800 a frame, and speedXZ steps to it up 2.0 / down 1.5.
Run up at 6, the first frame only gets to 8 and the second to 9.94; from the
backwalk's 9 the first frame is the whole 10.33. 15 spin frames, then
standing. Only the frames faster than Deku runs (above 6) are aimed at clip
points, and a clip on a slower frame isn't kept (a walking clip does that).
They are also aimed at every acute wall corner (two walls facing into a wedge
narrower than 90 degrees, `cornerTargets`): one spin frame can wedge Link into
a corner deeper than he can stand, so the next can push him through - a clip no
single move from a standing start does, so the scan's own clip points miss it.
Each spin has its own viewer row (**Action Clips (Deku spin)** / **(backwalk
Deku spin)**). Not modelled: a floor pitch (it lowers the stick's speed), a
Deku flower under him.

The speeds above are unobstructed. `runFrames` works them out frame by frame
(`ActionFrame::stick`), because a wall Link touches lowers the stick's speed:
in both games Link moves and collides before the action runs, and touching a
wall on the ground the collision caps the stick's speed (`unk_B50`, OoT
`unk_880`) at the run limit x |yaw - (wallYaw + 0x8000)| x 0.00008 when that's
under 1 - wallYaw from `Player_PosVsWallLineTest` along his shape yaw (which
the spin turns 19200, 18400, ... a frame), else the last wall that pushed him.
In a scene whose rooms are all indoors the run limit is 5 (`Player_SetBootData`).

Stopping part way (the spins only: a lunge's root motion can't be stopped): a
frame after the clip that leaves Link out of bounds, still behind the wall
after two frames standing there, counts even if the rest of the spin would
carry him out again - e.g. through Deku Palace's 19 thick low wall (TRI 1531)
and back into bounds on its far side. The JSON has `"stopAfter"`: let go after
that frame.

Deku Palace: `deku-spin-backwalk` 1504 -> 1531 (yaw ~0x4C91 into the corner by
the pillar, stop after the 9.94 frame) - the user's clip. The east corner
(1502 -> 1531) needs two 10.33 frames in the model; the spin has one.
Laundry Pool (Deku): `deku-spin` finds TRI 27 -> 71 on the 9.94 frame.

The tester (`wall_clip_tester.lua`, `runSpin`) does the inputs above, counting
game frames as clipfinder does (from the first one Link moves on: a wall can
keep speedXZ under 6 / 9), lets go of the stick after `stopAfter`, and aims the
stick through the active camera every emulated frame (`stickToward`), so
fixed cameras such as Deku Palace's get the right world direction. MM reads
the stick's angle from the raw stick, not the dead-zone-adjusted one
(`Lib_GetControlStickData`), so there the raw stick itself points along it
(an earlier version was up to ~0x300 off, enough to miss the Deku Palace
`-walkin` corners, whose window is about +-0x40). Statuses
"no run-up" (he never moved) and "no spin" (A didn't start one).

### Running into a corner first (-walkin)

Every lunge and jumpslash key also has a `-walkin` variant (e.g.
`1h-slash-walkin`, `1h-jumpslash-fwd-walkin`): Link runs along the facing
first (the stick at full tilt, Z held for stabs and the jumpslash) - speed 2,
4, then the run limit (OoT 6, MM Human 5.5, capped by walls as above), held for
6 more frames - so an acute corner wedges him in deeper than he can stand, then
the B / A press (that frame still moves him at the run speed, capped by the
wall he touched) and, for the slashes and stabs, a frame standing still (the
attack's setup zeroes speedXZ; its lunge is only set at the end of the next
frame, so the walls push him back out of the corner first), then the attack
as before. Aimed at acute wall corners only; a clip during the run in is a
walking clip and isn't kept. The tester runs the same 9 frames (`WALKIN_RUN`)
before the press. The speed cap uses the first wall that pushed him
(`actor.wallPoly`), not the last. Deku Palace (Human): the corners by the
pillar (1504 / 1502 -> 1531) were found before the standing frame and the
first-wall cap were modelled, and all failed in game; with them the run in and
the lunge match the game to ~0.005 and there are none.

Not modelled: the sword's wall recoil (MM `func_808401F4`): from the attack
animation's frame 2 on, a line along the blade (10 behind the hilt to the tip)
hitting a wall sets speedXZ -14 - in a corner the 2h stab bounced Link back
~13 two frames after the lunge.

### Zora: punch, jumpslash, Zora clip

MM Zora (`zoraActions`; tables from `gen_mm_attack_frames.py`, which emulates
the game frames from MM's animation data and rebuilds the Human 1h slash table
exactly - `--check`):

| Key | Inputs | Movement |
|---|---|---|
| `zora-punch` | B once (the first punch, `PLAYER_MWA_ZORA_PUNCH_LEFT`) | no lunge speed; `pz_attackA`'s root motion (~35 forward) then its end animation's (~34 back) |
| `zora-jumpslash[-fwd]` | fins out, Z + A (`-fwd`: the stick and Z forward in the air) | speedXZ 5.5, velocity.y 4.5 (`func_808395F0`: x 1.1, x 0.9), gravity -1.0 the first frame then -0.8, the stick's cap in the air 6; landing `pz_jumpATend`, then `pz_wait` (stands still) |
| `zora-clip[-fwd]` | fins out, B held (aiming them), Z, A, B still held to the end | the jumpslash, then when the landing animation ends `Player_Action_84` calls `Player_ActionHandler_8`: the fin aim, whose animation (`pz_cutterwaitC`) becomes the lower body's too, root motion still on - **64.4 forward in one frame** (its first root vs `pz_jumpATend`'s last), ~12 more after |

Root motion is x 0.01 x the form's `unk_08` (Zora 1). The Zora clip is aimed
only with, and counted only on, its ~64 frame (`aimMin` 10): a clip in its air
or landing frames is the plain jumpslash's. The jumpslash keys are slow on big
maps (like the Human jumpslash: every air and landing frame aimed at every
walking and falling clip point - Zora Hall, ~10000 targets, about 30 minutes). Each has a `-walkin`
variant (Zora's run limit 6). The viewer has a row each: **Action Clips (Zora
punch / Zora jumpslash / Zora clip)**. The tester draws the fins with a B
press while holding Link at the start ("no fins" if `heldItemAction` isn't 8,
`PLAYER_IA_ZORA_BOOMERANG`), never holds R (the Zora barrier), and for the
clip holds B from 30 frames before Z + A until after the settle (letting go
throws the fins). Not modelled: the punch combo (2nd / 3rd presses), the ledge
check during root motion (`func_808381F8`).

### 2h spin attack, locked on (spin-lock)

`2h-spin-lock[-fwd]` (OoT adult and child - a child can have the Biggoron Sword
on B - and MM Human; there's no Deku stick spin attack): the half-charged two-handed
spin (`PLAYER_MWA_SPIN_ATTACK_2H`) ending while Z-targeting an enemy. With a
hostile lock-on the attack action picks the "R" end animation,
`link_anchor_Lrolling_kiru_endR`, whose root starts 2214 forward of where the
spin's ended, the root-motion flags kept (the Zora clip's mechanism): **22.1 in
one frame** (OoT; MM Human x 11/17: 14.3), then ~26 back over its frames.
`-fwd`: B let go with the stick forward, which also lunges (15 -> 10, 5).
Tables: `gen_mm_attack_frames.py --spin` (its OoT mode rebuilds the OoT adult
1h slash table exactly). The lock-on turns Link to face the enemy, so the
facing has to point at one; the scan doesn't know where enemies are. No
`-walkin`. Lost Woods (adult): 974 -> 799 / 807 on the 22.1 frame. The
tester holds Z (an enemy must be in range: "no lock-on" otherwise), holds B for
the last `SPIN_CHARGE` frames of the hold (slash, then charge), and lets go.

`-r` (`2h-spin-lock-r`, `2h-spin-lock-fwd-r`): the
step back cut short - the rows stop at the jump. Z held through the frame the
spin switches to its end animation (the lock-on picks the endR one then), then
on the next Z let go and R held: Idle's shield handler
(`Player_ActionHandler_11`) only runs with no lock-on, and its full-body shield
action ends the root motion; still locked on, R only raises the shield on the
upper body and the step back plays out (the user saw both). Gerudo Valley
(adult): 3 wall pairs (`2h-spin-lock` 5 - some clips need the step back). The
tester spots the switch (actionFunc leaving the attack's) and lets go of Z /
holds R from the next game frame.

### Spin attack with the stick forward (spin-fwd)

`1h-spin-fwd` (OoT adult / child, MM Human), `2h-spin-fwd` (OoT adult / child
with the Biggoron Sword, MM Human): the half-charged spin attack
released (B let go) with the stick forward - which, like a stab, sets the
lunge flag: 15 on its first frame (stepped to 10, then 5) - and no lock-on, so
the ordinary end animation (no ~22 jump). One-handed:
`PLAYER_MWA_SPIN_ATTACK_1H` (`link_fighter_rolling_kiru`, unk_D 12);
two-handed: `SPIN_ATTACK_2H`. Without Z the stick turns Link while
charging, so any direction held becomes forward. Gerudo Valley (adult): 1h 5
wall pairs, 2h 7 (the 1h stab: 3). The tester charges as for spin-lock, without
Z, and lets go with the stick forward.

### Lunge storage (-ls)

Every Human / adult / child jumpslash key has a `-ls` variant (e.g.
`1h-jumpslash-ls`, `1h-jumpslash-fwd-ls-walkin`): the lunge flag (OoT
`PLAYER_STATE2_30`, MM `PLAYER_STATE2_40000000`, set by an attack started with
the stick forward) is only cleared where it fires, an attack action's first
frame; skip that (e.g. the sword's wall recoil) and it waits for the next
attack - the jumpslash's landing, which then lunges: the frame after the big
landing frame moves at 10 (14.6 with the root motion instead of -0.4), then 5.
The tester sets the flag in `stateFlags2` just before Z + A.

## Ending in bounds

A clip through a static wall usually has to leave Link out of bounds. It
also counts when he ends in bounds somewhere he couldn't have walked to from
his start (`Model::walkUnreachable`): into another room, up onto a ledge, or
past a dynapoly into the area it closes off. That's a walk out from the start
on a 10 unit grid, up to 600 away: small steps up (at most 50) and drops (at
most 300) are fine, walls more than 50 tall block it (either face,
dynapolys too). If it never gets within a step of the end, the end counts.
Such clips are marked `"inBounds": true` in the JSON, and the viewer says so
when you click one. Climbing, jumping and the like aren't modelled, so a
ledge Link could climb up to still counts, and a way round longer than 600
counts as none.

It also counts as a **shortcut** (the user's rule: a shorter way to somewhere
reachable): the walk there (`Model::walkDistance`, the fill's steps x 10, a
lower bound) is at least 150 more than the straight line from the start and at
least twice it. The JSON then has `"walkDistance"` (-1: no way to walk there)
and the viewer says "a shortcut: walking there ... is about N". The Deku Palace
1h slash (Human, 834, 0, 1089, facing 0x6132; the user's, in game) goes through
the low block 1318/1317 and out behind it, a walk of ~250 round. `--sim
X,Y,Z,walk,X2,Y2,Z2` prints the fill's path between two points, and any wall it
steps through 10 or 30 up (it only checks 50 up: walls lower than that don't
block it - Deku Palace TRI 1198, 10 up, did).

Falling and ground clips are judged where Link lands, and landing in bounds
counts the same way: OoT Shadow Temple, adult, falling through TRI 1160 off
the slope TRI 1182, Link drops 1300 onto TRI 1023, a floor he can't walk to
(1050 falling points). This finds many more falling clips on some maps (OoT
Kakariko Village, child: 9550 → 13655 points, mostly falling), and any of
them landing somewhere reachable by a longer way round, or by a drop of over
300, is a false positive.

E.g. MM Stone Tower Temple, setup 0, with its dynapolys: the sun block at
(-1350, -1220, -870) sits in front of a raised alcove (TRI 1713 / 1714).
In the corner of the block's +X face and TRI 1721, the Human 1h slash from
(-1236, -1220, -784) facing 0xE3E0: the block's +Z face (TRI 2983) pushes
Link past its edge through TRI 1721, and standing, TRI 1719 pushes him out
into the alcove (tested in game). OoT Kokiri Forest, adult: 224 of 9973
points end in bounds, up on a ledge about 50 above the start.

## Convex corner pockets

Where two walls meet in a corner that sticks out at Link (or a wall just
ends), he can stand partly inside the corner. The game's wall check only pushes
him off a wall when his centre, projected along Z or X onto its plane, lands
on the triangle (with 1 unit of slack). Standing just off the corner's edge,
he's past the end of both walls, so neither one pushes him. At a square corner
his centre gets to about 1.5 from the edge, where a wall's face would keep him
a whole radius away.

The scan's starts are the resting spots it reaches by stepping back from each
clip point. The pushes there move Link a radius off a face, so they hardly
ever end in a pocket. So once per map and form (well under a second), the
scan looks round every wall vertex, every 10 degrees and on each floor, for the
deepest spot that is a resting spot, in bounds, with his sphere at least 0.5
into a wall (`corners.cpp`, `N convex corner pocket starts` in the terminal).
Those spots are tried as extra starts, after the usual ones, by the wall push
crossings, the standing-start reach, falling clips, slope clips, ground clips
and `--min-speed`. They aren't tried by the actions, `--yaw` or `--refine`. `--sim` says `a corner pocket
start` when Link's start is one. OoT Kakariko Village, adult: 964 pockets, 3
new wall pairs (480 → 694, 872 → 780 falling, 949 → 220), and 48 new points
in all. MM West Clock Town, Human: a new ground clip, 245 under 101, from
(-1837.362, 211.602, -705.948) at yaw 0x9D3D, speed 8.107. These haven't been
checked in game.

## Acute or extended

Every wall pair (pushing wall, clipped wall) gets one category, per form, and
all its points carry it (`kind`), falling ones included:

- **acute** if at least one of its points is acute on its own: it still clips
  with the extended planes removed (no 1-unit / `detMax 300` tolerance), *and*
  the push that does it starts with Link in front of the pusher's actual face
  (his check point projected along the wall's normal lands on the triangle,
  0.1 of slack for rounding).
- **extended** otherwise: every point needs the pusher's extended plane.

The face test is there because the game's wall check projects Link onto a
wall along the Z or X axis, not the wall's normal, so a diagonal wall also
pushes Link standing beside it, past its end (at 45 degrees as far past as he
is in front of its plane), with no tolerance at all. `--sim` prints both
triangles and the verdict for that one frame.

The viewer shows walking and falling clips of each category as separate rows.
Older result files are made per pair when imported: a pair with any acute
point is acute.

## Keeping it in sync

The search lives only here. The viewer works nothing out itself: its
"Reachable" filter reads each clip's speed from the file (`fileSpeed` in
`js/wall_push_clips.js`): `--min-speed`'s `reach` when the file has it (`null`:
hidden), else the clip's own move (`speed`, a slope clip the faster of its two
frames; a ground or slope clip's `reach` is that move), else - a falling
standing point, which has no move - the distance from `prev` to the point as
one frame's speed. Attacks count as speed 0. `js/wall_push_clips.js` still has
a `CollisionModel` (the polys for the markers and click info, and the floors
under a point); its other checks are no longer used by anything.
