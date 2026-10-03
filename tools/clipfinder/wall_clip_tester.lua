-- Wall push clip tester (BizHawk, N64 OoT US 1.0 / MM US, Mupen64Plus core;
-- or OoT3D US Rev 1 / MM3D US, decrypted, 3DS core - see below)
--
-- OoT3D / MM3D (clipfinder --game OOT3D / MM3D results): "move" mode only (no
-- hooks), 30 fps (2 emulated frames a game frame, moves velocity x 1.0). MM3D
-- action tests (the recorded lunges and Deku spins): see runActionTest3DS.
-- MM3D's form is read from the save context (K.playerForm). At
-- the start the script checks the frame counter and Player.yaw addresses and
-- stops with an error if they don't look right (see K).
--
-- Tries, in the game, every clip point in a results JSON - from
-- tools/clipfinder, or the 3d_model_viewer's "Export JSON" of imported
-- results (e.g. just the reachable ones) - and writes a summary of the ones that worked.
--
-- How a test runs: the game's own wall check does the work. A callback on
-- Actor_UpdateBgCheckInfo (code segment, so its address is fixed) catches the
-- player's call, and just before it runs sets his prevPos and world.pos (his
-- position after this frame's movement) to the test's `prev` and `next`:
--   standing points: prev = next = the point (no movement, so no line check;
--                    only the wall pushes), falling ones start from the floor
--                    height so only y changes;
--   crossing points: prev = the start, next = just past the crossing (the line
--                    check stops him on the wall, then the pushes).
-- Then the game runs on for SETTLE_FRAMES with no input and the script looks
-- at where Link is. Every test starts from the same savestate.
--
-- Setup:
--   1. Get a results JSON: run tools/clipfinder, or scan the map in the viewer
--      and click "Export JSON". Set TESTS_FILE below to it (or save it as
--      wall_clip_tests.json next to this script).
--   2. In BizHawk (N64 core: Mupen64Plus - the callback needs it), load the
--      same map as the same form, with Link standing still anywhere and no
--      menus or text open. (Tests of several forms: the ones for the form
--      Link is in run - see FORM below.) Unthrottled / fast-forward makes it much quicker.
--   3. Run this script. Progress prints to the Lua console; the summary goes
--      to the console and to wall_clip_results.txt next to the tests file.
--      The game is put back to the starting savestate at the end.
--   Action clips (clipfinder --type actions, a sword lunge doing the clip): the
--   game does the attack itself - see ACTION_HOLD below for what the
--   savestate needs.
--   Recording a video: set RECORD = true below, run BizHawk at normal speed
--   (not unthrottled) and start BizHawk's AVI/video recording before the
--   script. Each test then gets the camera behind Link and a pause before and
--   after it (RECORD_BUFFER).

---------------------------------------------------------------------------
-- Settings
---------------------------------------------------------------------------

-- The results JSON (tools/clipfinder or the viewer's "Export JSON"), e.g.
-- [[C:\...\results\OOT_Spot_01_-_Kakariko_Village_All.json]]; nil:
-- wall_clip_tests.json next to this script. Its clips are turned into tests,
-- with the walls read from RAM (load that map first). (A .lua test file from
-- an older viewer still works too.)
-- A relative path is from this script's folder (tools\clipfinder).
local TESTS_FILE = [[results\OOT_Spirit_Temple_Adult_Child_selected.json]]
local RESULTS_FILE = nil          -- nil: wall_clip_results.txt next to the tests
local MAX_PER_GROUP = 12          -- points tried per wall pair (spread evenly); 0 = all
local SKIP_FALLING = false        -- true: leave out the falling clips (drop > 0, from --type falling scans)
-- Only test one area of the map: the clip points (the viewer's dots) outside
-- these ranges are ignored. Each is { min, max } (ends included), or nil for
-- no limit on that axis. E.g. X_RANGE = { 300, 500 }, Z_RANGE = { 550, 700 }.
local X_RANGE = nil -- { -3000, -2500 }
local Y_RANGE = nil
local Z_RANGE = nil -- { -370, 100 }
-- "needed": a wall pair's falling clips ("low-acute" / "low-extended") only if
-- the pair has no walking clips of that kind, or the falling ones need a lower
-- speed (the slowest move in the file: --min-speed's reach, or the clip's own).
-- Falling points with no speed known are left out when it clips walking.
-- "all": every falling clip.
local FALLING_TESTS = "needed"
local SETTLE_FRAMES = 30          -- emulated frames to let run after the test frame (3 per game frame)
local HOOK_TIMEOUT = 60           -- emulated frames to wait for the player's bg check
local HOLD_FRAMES = 9             -- "move": emulated frames Link is held at the start first
local BEHIND_MIN = 1.0            -- units behind the clipped wall that count as through it
local FAST = true                 -- skip drawing while testing (client.invisibleemulation)
-- Recording a video of the tests: draws every frame (FAST is ignored), turns
-- the camera to behind Link before each test ("move" mode: he's already
-- facing the way he'll go, and Z is tapped - Z-targeting nothing swings the
-- camera behind him), and pauses RECORD_BUFFER emulated frames (60 a second)
-- before and after each one. Off by default.
local RECORD = true
local RECORD_BUFFER = 30
local RECORD_ONE_PER_PAIR = true  -- recording: once a wall pair's test works, skip the rest of that pair's
if RECORD then FAST = false end
-- How the test frame is set up:
--   "auto": "exec", falling back to "read", then "move" if a hook never fires
--   "exec": execute callback on Actor_UpdateBgCheckInfo (exact prevPos/posNext)
--   "read": read callback on Link's world.pos.y, taken when the PC is inside
--           Actor_UpdateBgCheckInfo (exact, for cores without exec callbacks)
--   "move": no callbacks: Link is put at the start and given the yaw and speed
--           (Player speedXZ) to move there himself - real movement, but his
--           action code can still change the speed on the frame
local MODE = "auto"
-- Tests exported with several forms (clipfinder --form All, imported into the
-- viewer): only the ones for this form run. nil = the form Link is in, read
-- from RAM (OoT: "Crawlspace" if he has the crawling flag, else "Adult" /
-- "Child"; MM: "Human", "Deku", "Zora", "Goron", "FierceDeity"), or set a name.
local FORM = nil
-- Checking clipfinder --yaw's CSV grids (<output>_<YAW>.csv, Yes / No per
-- x, z) in game: set TESTS_FILE to that run's JSON (the CSVs and their
-- _speeds.csv are found next to it, one per yaw in it) and CSV_TESTS = true.
-- Every cell is tried in "move" mode (the game moves Link from exactly that
-- x, z at the yaw): a Yes at its lowest speed (should clip), a No at the max
-- speed (shouldn't). Each grid's in-game result goes to <that CSV>_ingame.csv,
-- mismatches marked, and the summary lists them.
local CSV_TESTS = false
-- Action clips (clipfinder --type actions: the lunge's own movement does the clip).
-- Each test: Link held at the start facing the test's facing, with Z held
-- (Z-targeting nothing swings the camera behind him), then B pressed with the
-- stick forward for one game frame - the stabs keep Z held (the targeted
-- stab), the slashes let go of it first (the forward slash). The game does
-- the rest. The savestate needs Link on foot, no menus or text.
-- The weapon: each test puts the one its action is for on B (ACTION_WEAPONS)
-- and presses B once while holding him at the start, so he draws it (and
-- swings it: that's over before the test). Two-handed (Player_HoldsTwoHandedWeapon):
-- OoT the Biggoron Sword / Giant's Knife, and the Deku stick (which always
-- does the forward slash); MM the Great Fairy's Sword.
-- The Deku spins (deku-spin, deku-spin-backwalk; MM Deku, no weapon): see
-- runSpin. The stick is aimed through the active camera every emulated frame
-- (stickToward), so fixed cameras (e.g. Deku Palace) get the right world yaw.
local SET_WEAPON = true           -- false: use whatever the savestate has on B (and drawn)
local ACTION_WEAPONS = {          -- B button item per game / form / one- or two-handed
	OOT = {
		Adult = { ["1h"] = 0x3C, ["2h"] = 0x3D },     -- Master Sword, Biggoron Sword / Giant's Knife
		Child = { ["1h"] = 0x3B, ["2h"] = 0x3D, stick = 0x00 },  -- Kokiri Sword, Biggoron Sword (on B: the 2h spin keys), Deku stick
	},
	MM = {
		Human = { ["1h"] = 0x4D, ["2h"] = 0x10, stick = 0x08 },  -- Kokiri Sword (77), Great Fairy's Sword (16), Deku stick (8)
	},
}
-- (the 3DS versions use the N64 item ids - the user)
ACTION_WEAPONS.OOT3D = ACTION_WEAPONS.OOT
ACTION_WEAPONS.MM3D = ACTION_WEAPONS.MM
local ACTION_HOLD = 150           -- emulated frames Link is held at the start first (3 per game frame; he draws the weapon in them)
local ACTION_KEYS = nil           -- nil: every action in the file; or a list, e.g. { "2h-stab" }
-- MM3D (runActionTest3DS): the lunges' stick has to be read before B, and the
-- game can read it late - a test with no lunge (speedXZ never above
-- LUNGE_SPEED_3DS) is run again with the stick pushed that many emulated
-- frames before B, as mm3d_action_recorder.lua does
local STICK_LEADS_3DS = { 0, 1, 2, 3, 4, 6 }
local STICK_AFTER_3DS = 4         -- emulated frames the stick stays forward after B
local LUNGE_SPEED_3DS = 7
local CSV_CELLS = "all"           -- "all", or "border": only cells next to one with the other answer
local CSV_DRIFT = 0.0001          -- Link pushed further than this off a cell's start before the move: No

---------------------------------------------------------------------------
-- Game / memory
---------------------------------------------------------------------------

console.clear()

local GAME
local hash = gameinfo.getromhash()
if hash == 'AD69C91157F6705E8AB06C79FE08AAD47BB57BA7' then
	GAME = "OOT" -- OoT US 1.0
elseif hash == 'D6133ACE5AFAA0882CF214CF88DABA39E266C078' then
	GAME = "MM" -- MM US
elseif emu.getsystemid() == "3DS" then
	-- (the 3DS core's hash: MM3D US's is known, anything else is taken as OoT3D US Rev 1)
	GAME = hash == '8AEB0679FC5F77D35B8A58954CE98236' and "MM3D" or "OOT3D"
else
	error("wall_clip_tester: needs OoT US 1.0, MM US, OoT3D or MM3D (rom hash " .. hash .. ")")
end
-- OoT3D / MM3D (BizHawk's 3DS core, decrypted US roms): FCRAM is mainmemory,
-- little-endian, and the game runs at 30 fps - 2 emulated frames a game frame,
-- and Actor_UpdatePos moves velocity x 1.0 (not x 1.5), so walking posNext is
-- 5 below the floor (clipfinder --game OOT3D / MM3D). Only "move" mode: there
-- are no function addresses for the hooks. See K below for the addresses.
local IS_3DS = GAME == "OOT3D" or GAME == "MM3D"
local EMU_PER_GAME = IS_3DS and 2 or 3   -- emulated frames per game frame
local SPEED_RATE = IS_3DS and 1.0 or 1.5 -- Actor_UpdatePos: velocity x this a frame
local GROUND_DROP = 5 * SPEED_RATE       -- walking: posNext below the floor
local LINE_DY_SCALE = IS_3DS and 1.5 or 1.0 -- the wall check's feet-level line test: checkHeight + dy x this < 5 (clipfinder feetLine)
if IS_3DS then SETTLE_FRAMES = math.floor(SETTLE_FRAMES * 2 / 3 + 0.5) end  -- (the same game frames)

local BE = not IS_3DS
local function read_u16(addr) return BE and mainmemory.read_u16_be(addr) or mainmemory.read_u16_le(addr) end
local function read_s16(addr) return BE and mainmemory.read_s16_be(addr) or mainmemory.read_s16_le(addr) end
local function write_s16(addr, v) if BE then mainmemory.write_s16_be(addr, v) else mainmemory.write_s16_le(addr, v) end end
local function read_u32(addr) return BE and mainmemory.read_u32_be(addr) or mainmemory.read_u32_le(addr) end
local function readfloat(addr) return mainmemory.readfloat(addr, BE) end
local function writefloat(addr, val) mainmemory.writefloat(addr, val, BE) end

local K = {}
-- The collision header (the scene's static polys) and pointers into RAM
K.addrOffset = 0x80000000               -- a pointer minus this is a mainmemory address
K.hdrNumPolys, K.hdrVtxList, K.hdrPolyList = 0x14, 0x10, 0x18
K.polySize, K.polyNormal = 0x10, 0x8    -- CollisionPoly: size, normal (s16 x 3); dist s16 after it, f32 at +0x10 on 3DS
if GAME == "OOT3D" then
	-- (OoT3D US Rev 1: the oot3d decomp (include/z3Dactor.hpp, z3D.hpp), the
	-- watch file's addresses and collision_dump.lua's header layout)
	K.addrOffset = 0x2900000
	K.play = 0x05E1E840                 -- PlayState (0x0871E840)
	K.gameplayFrames = 0xF8             -- GameState.frames (one a game frame)
	K.colCtx = K.play + 0xA98
	K.player = 0x06FF4010               -- Player actor
	K.home = 0x08                       -- Actor.home.pos (prevPos comes from it each frame)
	K.pos = 0x28                        -- Actor.world.pos
	K.rotY = 0x36                       -- Actor.world.rot.y
	K.velocity = 0x60                   -- Actor.velocity
	K.actorSpeed = 0x6C                 -- Actor.speedXZ
	K.wallPoly, K.floorPoly, K.wallBgId, K.bgCheckFlags = 0x78, 0x7C, 0x80, 0x90
	K.shapeRotY = 0xBE                  -- Actor.shape.rot.y (shape at 0xBC)
	K.prevPos = 0x108                   -- Actor.prevPos
	K.stateFlags2 = 0x1714
	K.crawling = 0x40000                -- PLAYER_STATE2_CRAWLING (as on the N64)
	K.speedXZ = 0x221C                  -- Player.xzSpeed ("Linear Velocity")
	-- Player.yaw: the decomp's unk_2220. On the N64 it's right after speedXZ,
	-- with meleeWeaponState 0xB past speedXZ - here isg is at 0x2227, 0xB past
	-- too, so the same layout (checked at the start: see checkYaw)
	K.yaw = 0x2220
	K.linkAge = 0x077C695C              -- gSaveContext.linkAge (s32, 0 adult, 1 child)
	K.hdrNumPolys, K.hdrVtxList, K.hdrPolyList = 0x0E, 0x18, 0x1C
	K.polySize, K.polyNormal = 0x14, 0xA
elseif GAME == "MM3D" then
	-- (MM3D US: the watch file / levitate.lua / collision_dump.lua; no decomp.
	-- Link's actor and the globalContext move: read through their pointers.
	-- The actor header matches N64 MM where the watch file shows it (world.pos
	-- 0x24, velocity 0x64, wallPoly 0x7C), so world.rot.y and Actor.speedXZ
	-- are taken from N64 MM; Player.yaw after speedXZ as in OoT3D and on the
	-- N64 (checked at the start: see checkYaw))
	K.addrOffset = 0x24EE000
	K.play = mainmemory.read_u32_le(0x0754D890) - K.addrOffset  -- globalContext ("Global Context Ptr")
	-- (a counter that goes up one a game frame: found by the tester's search,
	-- Laundry Pool 2026-10-02 - play + 0xC4BC / 0xC4C0 count too. OoT3D's
	-- GameState.frames offset, 0xF8, doesn't move in MM3D)
	K.gameplayFrames = 0x138
	K.colCtx = K.play + 0xAB0
	K.player = mainmemory.read_u32_le(0x0752FD6C)                -- Player actor ("Player Ptr")
	if K.player > K.addrOffset then K.player = K.player - K.addrOffset end
	K.home = 0x08
	K.pos = 0x24
	K.rotY = 0x32
	K.velocity = 0x64
	K.actorSpeed = 0x70
	K.wallPoly, K.floorPoly = 0x7C, 0x80
	K.shapeRotY = 0xC2                  -- "Angle"
	K.speedXZ = 0x11E30                 -- "Linear Velocity"
	K.yaw = K.speedXZ + 4
	-- save.playerForm (s16, save context 0x0765B1B0 + 0x4E; the user's find),
	-- taken to count as N64 MM's PlayerTransformation: 0 Fierce Deity, 1
	-- Goron, 2 Zora, 3 Deku, 4 Human
	K.playerForm3DS = 0x0765B1FE
	K.bButton = 0x0765B1B0 + 0x17A      -- the B button item (u8; the watch file's "B button item")
	K.hdrNumPolys, K.hdrVtxList, K.hdrPolyList = 0x10, 0x18, 0x1C
	K.polySize, K.polyNormal = 0x14, 0x8
elseif GAME == "OOT" then
	K.play = 0x1C84A0                   -- globalContext
	K.gameplayFrames = 0x11DE4
	K.colCtx = 0x1C84A0 + 0x7C0         -- globalContext + 0x7C0
	K.player = 0x1DAA30                 -- Player actor (RDRAM offset)
	K.prevPos = 0x100                   -- Actor.prevPos
	K.velocity = 0x5C                   -- Actor.velocity
	K.bgCheckInfo = 0x8001DFB4          -- Actor_UpdateBgCheckInfo (oot-ntsc-1.0.map)
	K.bgCheckInfoEnd = 0x8001E2D4       -- (next function)
	-- Player's own fields: the decomp's offsets (include/player.h) are for
	-- the debug build, whose Actor has an extra 0x10 bytes (dbgPad), so on
	-- retail they're 0x10 lower. Actor fields before that are the same.
	K.speedXZ = 0x828                   -- Player.speedXZ
	K.yaw = 0x82C                       -- Player.yaw
	K.shapeRotY = 0xB6                  -- Actor.shape.rot.y
	K.actionFunc = 0x664                -- Player.actionFunc (for the move log)
	K.stateFlags1 = 0x66C
	K.skelAnime = 0x1A4
	K.rideActor = 0x430
	K.actorSpeed = 0x68                 -- Actor.speed
	K.stateFlags2 = 0x670
	K.focusActor = 0x654                -- Player.focusActor (the lock-on target; debug 0x664)
	K.crawling = 0x40000                -- PLAYER_STATE2_CRAWLING
	K.linkAge = 0x11A5D4                -- gSaveContext.linkAge (0 adult, 1 child)
	K.meleeWeaponAnimation = 0x832      -- Player.meleeWeaponAnimation (s8)
	K.heldItemAction = 0x141            -- Player.heldItemAction (s8)
	K.bButton = 0x11A638                -- gSaveContext.save.info.equips.buttonItems[0] (gSaveContext 0x8011A5D0 + 0x68)
	K.stickAmmo = 0x11A65C              -- gSaveContext.save.info.inventory.ammo[SLOT_DEKU_STICK] (+ 0x8C)
else
	K.play = 0x3E6B20
	K.gameplayFrames = 0x18840
	K.colCtx = 0x3E6B20 + 0x830
	K.player = 0x3FFDB0
	K.prevPos = 0x108
	K.velocity = 0x64
	K.bgCheckInfo = 0x800AFE10          -- Actor_UpdateBgCheckInfo (mm-n64-us.map)
	K.bgCheckInfoEnd = 0x800B02B0
	K.speedXZ = 0xAD0                   -- Player.speedXZ (0x400880)
	K.yaw = 0xAD4
	K.shapeRotY = 0xBE
	K.actionFunc = 0x748
	K.stateFlags1 = 0xA6C
	K.stateFlags2 = 0xA70
	K.focusActor = 0x730                -- Player.focusActor (the lock-on target)
	K.skelAnime = 0x240
	K.rideActor = 0x390
	K.actorSpeed = 0x70
	K.transformation = 0x14B            -- Player.transformation (PlayerTransformation)
	K.meleeWeaponAnimation = 0xADA      -- Player.meleeWeaponAnimation (s8)
	K.heldItemAction = 0x147            -- Player.heldItemAction (s8)
	K.saveContext = 0x1EF670            -- gSaveContext (MM US retail)
	K.bButton = 0x1EF670 + 0x4C         -- save.saveInfo.equips.buttonItems[0][EQUIP_SLOT_B] (Human: CUR_FORM 0)
	K.stickAmmo = 0x1EF670 + 0xA8       -- save.saveInfo.inventory.ammo[SLOT_DEKU_STICK]
	K.playerForm = 0x1EF670 + 0x20      -- save.playerForm (checked against Player.transformation)
end
if not IS_3DS then
-- Player_UpdateCommon (both games) sets prevPos from home.pos at the start of
-- the frame (and home.pos = world.pos at its end), so home.pos is Link's real
-- "where he was last frame"
K.home = 0x08                           -- Actor.home.pos (both games)
K.rotY = 0x32                           -- Actor.world.rot.y (both games)
K.pos = 0x24                            -- Actor.world.pos (both games)
-- The active camera (GET_ACTIVE_CAM): play->cameraPtrs[play->activeCamId];
-- its inputDir.y is the yaw stick up points at (Player_ProcessControlStick)
K.cameraPtrs = GAME == "OOT" and 0x790 or 0x800
K.activeCamId = GAME == "OOT" and 0x7A0 or 0x810
K.camInputDirY = 0x136                  -- Camera.inputDir.y (both games)
-- Actor bg check results (the log names the wall / floor polys Link touched)
if GAME == "OOT" then
	K.wallPoly, K.floorPoly, K.wallBgId, K.bgCheckFlags = 0x74, 0x78, 0x7C, 0x88
else
	K.wallPoly, K.floorPoly, K.wallBgId, K.bgCheckFlags = 0x7C, 0x80, 0x84, 0x90
end
end

local function readVec(addr)
	return { readfloat(addr), readfloat(addr + 4), readfloat(addr + 8) }
end
local function writeVec(addr, v)
	writefloat(addr, v[1]); writefloat(addr + 4, v[2]); writefloat(addr + 8, v[3])
end

-- Static collision header of the loaded scene: polygon count and a reader for
-- one polygon's vertices, to check the tests belong to this map.
local function staticCollision()
	local header = read_u32(K.colCtx) - K.addrOffset
	local numPolygons = read_u16(header + K.hdrNumPolys)
	local vtxList = read_u32(header + K.hdrVtxList) - K.addrOffset
	local polyList = read_u32(header + K.hdrPolyList) - K.addrOffset
	local function polyVerts(id)
		local poly = polyList + id * K.polySize
		local out = {}
		for i, off in ipairs({ 0x2, 0x4, 0x6 }) do
			local vi = read_u16(poly + off) % 0x2000
			out[i] = { read_s16(vtxList + vi * 6), read_s16(vtxList + vi * 6 + 2), read_s16(vtxList + vi * 6 + 4) }
		end
		return out
	end
	-- (CollisionPoly normal at +0x8, dist at +0xE: the export's n and d; 3DS:
	-- the normal at K.polyNormal, dist an f32 at +0x10)
	local function polyPlane(id)
		local poly = polyList + id * K.polySize
		local n = K.polyNormal
		return { read_s16(poly + n), read_s16(poly + n + 2), read_s16(poly + n + 4) },
			IS_3DS and readfloat(poly + 0x10) or read_s16(poly + 0xE)
	end
	return numPolygons, polyVerts, polyPlane
end

-- A small JSON reader (objects, arrays, strings, numbers, true/false/null),
-- for clipfinder's results files: BizHawk's Lua has none built in.
local function parseJson(text)
	local pos = 1
	local function fail(msg) error(string.format("bad JSON at character %d: %s", pos, msg)) end
	local function ws() pos = text:find("[^ \t\r\n]", pos) or #text + 1 end
	local value
	local function str()
		local out, i = {}, pos + 1
		while true do
			local c = text:sub(i, i)
			if c == "" then fail("unterminated string") end
			if c == '"' then pos = i + 1; return table.concat(out) end
			if c == "\\" then
				local e = text:sub(i + 1, i + 1)
				local map = { n = "\n", t = "\t", r = "\r", b = "\b", f = "\f" }
				if e == "u" then local cp = tonumber(text:sub(i + 2, i + 5), 16) or 63
				out[#out + 1] = (utf8 and utf8.char(cp)) or (cp < 256 and string.char(cp)) or "?"; i = i + 6
				else out[#out + 1] = map[e] or e; i = i + 2 end
			else
				out[#out + 1] = c
				i = i + 1
			end
		end
	end
	function value()
		ws()
		local c = text:sub(pos, pos)
		if c == "{" then
			local obj = {}
			pos = pos + 1; ws()
			if text:sub(pos, pos) == "}" then pos = pos + 1; return obj end
			while true do
				ws()
				if text:sub(pos, pos) ~= '"' then fail("expected a key") end
				local k = str()
				ws()
				if text:sub(pos, pos) ~= ":" then fail("expected ':'") end
				pos = pos + 1
				obj[k] = value()
				ws()
				local d = text:sub(pos, pos)
				pos = pos + 1
				if d == "}" then return obj end
				if d ~= "," then fail("expected ',' or '}'") end
			end
		elseif c == "[" then
			local arr = {}
			pos = pos + 1; ws()
			if text:sub(pos, pos) == "]" then pos = pos + 1; return arr end
			while true do
				arr[#arr + 1] = value()
				ws()
				local d = text:sub(pos, pos)
				pos = pos + 1
				if d == "]" then return arr end
				if d ~= "," then fail("expected ',' or ']'") end
			end
		elseif c == '"' then
			return str()
		elseif text:sub(pos, pos + 3) == "true" then pos = pos + 4; return true
		elseif text:sub(pos, pos + 4) == "false" then pos = pos + 5; return false
		elseif text:sub(pos, pos + 3) == "null" then pos = pos + 4; return nil
		else
			local num = text:match("^-?%d+%.?%d*[eE]?[-+]?%d*", pos)
			if not num or num == "" then fail("unexpected '" .. c .. "'") end
			pos = pos + #num
			return tonumber(num)
		end
	end
	local v = value()
	return v
end

-- A results JSON (wall-push-clips-1 / -2, from clipfinder or the viewer's
-- "Export JSON") as a tests table: every clip, grouped by form, wall pair,
-- crossing/standing and kind. For the frame being tested, Link's prevPos and
-- posNext are `prev` and `next`: standing points move nowhere (falling ones
-- from the floor height, so only y changes), crossing points and standing
-- points with a move go from their start to `next`. Walls are filled in from
-- RAM later (T.fromJson).
local function testsFromJson(path)
	local f = io.open(path, "rb")
	if not f then error("can't read " .. path) end
	local data = parseJson(f:read("*a"))
	f:close()
	if data.format ~= "wall-push-clips-1" and data.format ~= "wall-push-clips-2" then
		error(path .. " isn't a clipfinder results file")
	end
	local forms = data.forms or { { form = data.form, radius = data.radius, checkHeight = data.checkHeight } }
	local T = {
		game = data.game, map = data.map, numPolygons = data.numPolygons, fromJson = true, dyna = data.dyna,
		radius = forms[1].radius, checkHeight = forms[1].checkHeight, tests = {}, walls = {},
	}
	if data.forms then
		T.forms = {}
		local names = {}
		for _, fm in ipairs(data.forms) do
			T.forms[fm.form] = { radius = fm.radius, checkHeight = fm.checkHeight }
			names[#names + 1] = fm.form
		end
		T.form = table.concat(names, ", ")
	else
		T.form = data.form
	end
	local groupOf, nGroups, seen = {}, 0, {}
	local vec = function(a) return { a[1], a[2], a[3] } end
	-- CSV_TESTS: the cells of clipfinder --yaw's CSV grids instead of the
	-- clips. The JSON's clip for each yaw gives the wall pair, form and floor
	-- height; <json name>_<YAW>.csv the grid, <...>_speeds.csv each cell's speed.
	if CSV_TESTS then
		T.csvGrids = {}
		local skipped = {}  -- yaws in the JSON with no CSV next to it (moved away to test fewer)
		local base = path:gsub("%.[jJ][sS][oO][nN]$", "")
		local function readCsv(file)
			local f = io.open(file, "r")
			if not f then return nil end
			local rows = {}
			for l in f:lines() do
				l = l:gsub("\r$", "")
				if l ~= "" then
					local cells = {}
					for c in (l .. ","):gmatch("([^,]*),") do cells[#cells + 1] = c end
					rows[#rows + 1] = cells
				end
			end
			f:close()
			return rows
		end
		for _, c in ipairs(data.clips) do
			if c.yaw and c.speed then
				local yawName = string.format("%04X", c.yaw)
				-- (with several forms the file has the form in its name too)
				local names = {}
				for part in tostring(c.form or ""):gmatch("[^/]+") do
					names[#names + 1] = base .. "_" .. part:gsub("[^%w%-_]", "_") .. "_" .. yawName
				end
				names[#names + 1] = base .. "_" .. yawName
				local grid, speeds, name
				for _, n in ipairs(names) do
					grid, speeds = readCsv(n .. ".csv"), readCsv(n .. "_speeds.csv")
					if grid and speeds then name = n; break end
				end
				if not name then
					skipped[#skipped + 1] = "0x" .. yawName
				else
					local g = { name = name, yaw = c.yaw, form = c.form, header = grid[1], rows = {} }
					T.csvGrids[#T.csvGrids + 1] = g
					local expect = {}
					for zi = 2, #grid do
						expect[zi] = {}
						for xi = 2, #grid[zi] do expect[zi][xi] = grid[zi][xi] == "Yes" end
					end
					local function border(zi, xi)
						for _, d in ipairs({ { -1, 0 }, { 1, 0 }, { 0, -1 }, { 0, 1 } }) do
							local e = expect[zi + d[1]] and expect[zi + d[1]][xi + d[2]]
							if e ~= nil and e ~= expect[zi][xi] then return true end
						end
						return false
					end
					local y = c.prev[2]
					local ang = c.yaw / 32768 * math.pi
					for zi = 2, #grid do
						g.rows[zi] = { label = grid[zi][1], cells = {} }
						local z = tonumber(grid[zi][1])
						for xi = 2, #grid[zi] do
							if CSV_CELLS ~= "border" or border(zi, xi) then
								local x, speed = tonumber(grid[1][xi]), tonumber(speeds[zi][xi])
								nGroups = nGroups + 1
								local t = {
									group = nGroups, form = data.forms and c.form or nil, kind = "csv 0x" .. yawName, type = "cell",
									pusher = c.pusher, crossed = c.crossed, prev = { x, y, z },
									-- (roughly: move mode lets the game work out the move itself)
									next = { x + speed * math.sin(ang) * SPEED_RATE, y - GROUND_DROP, z + speed * math.cos(ang) * SPEED_RATE },
									yaw = c.yaw, speed = speed, csv = g, zi = zi, xi = xi, expectClip = expect[zi][xi],
								}
								T.tests[#T.tests + 1] = t
								g.rows[zi].cells[xi] = t
							end
						end
					end
					T.walls[c.pusher] = true
					T.walls[c.crossed] = true
				end
			end
		end
		if #skipped > 0 then
			print(string.format("CSV_TESTS: %d yaws have no CSV next to the JSON, skipped: %s", #skipped, table.concat(skipped, ", ")))
		end
		if #T.tests == 0 then error("CSV_TESTS: no CSV grids found next to " .. path .. " (run clipfinder --yaw with -o that JSON)") end
		return T
	end
	local key3 = function(v) return string.format("%.9g,%.9g,%.9g", v[1], v[2], v[3]) end
	for _, c in ipairs(data.clips) do
		local form = data.forms and c.form or nil
		-- falling clips: "low-acute" / "low-extended" (their wall pair's category),
		-- or "low" from files older than the per-pair categories
		local kind = c.kind
		if kind ~= "low" and (c.drop or 0) > 0 then kind = "low-" .. kind end
		-- (action clips: a group per action too)
		local gk = table.concat({ form or "", c.pusher, c.crossed, c.cross and "cross" or "stand", kind, c.actionKey or "" }, ":")
		if not groupOf[gk] then nGroups = nGroups + 1; groupOf[gk] = nGroups end
		local prev, nxt
		if c.cross or c.speed then
			-- (a standing point Link walks onto: the same kind of move)
			prev, nxt = vec(c.prev), vec(c.next or c.from)
		else
			-- standing on the floor; the game's movement puts posNext below it
			nxt = vec(c.from)
			prev = { c.from[1], c.floorY or c.from[2], c.from[3] }
		end
		local k = (form or "") .. key3(prev) .. key3(nxt) .. (c.actionKey and (c.actionKey .. c.facing) or "")
		if not seen[k] then
			seen[k] = true
			T.tests[#T.tests + 1] = {
				group = groupOf[gk], form = form, kind = kind, type = c.cross and "cross" or "stand",
				pusher = c.pusher, crossed = c.crossed, prev = prev, next = nxt, from = vec(c.from),
				yaw = c.speed and c.yaw or nil, speed = c.speed, speed2 = c.speed2, vy = c.vy, expect = vec(c["end"]),
				reachSpeed = type(c.reach) == "table" and c.reach.speed or nil,
				action = c.action, actionKey = c.actionKey, facing = c.facing, actionFrames = c.frames and #c.frames or nil, airFrames = c.airFrames, stopAfter = c.stopAfter,
			}
			T.walls[c.pusher] = true
			T.walls[c.crossed] = true
		end
	end
	return T
end

---------------------------------------------------------------------------
-- Tests file
---------------------------------------------------------------------------

local scriptDir = (debug.getinfo(1, "S").source:match("^@?(.*[/\\])")) or ""
-- (a relative TESTS_FILE from the script's folder: BizHawk names the chunk
-- "main", so scriptDir can be empty - then it's BizHawk's working folder,
-- which it sets to the script's)
local testsPath = TESTS_FILE or "wall_clip_tests.json"
if not testsPath:match("^%a:[/\\]") and not testsPath:match("^[/\\]") then testsPath = scriptDir .. testsPath end
local T = testsPath:lower():match("%.json$") and testsFromJson(testsPath) or dofile(testsPath)
local resultsPath = RESULTS_FILE or (testsPath:match("^(.*[/\\])") or scriptDir) .. "wall_clip_results.txt"

if T.game ~= GAME then
	error(string.format("tests are for %s, the loaded game is %s", tostring(T.game), GAME))
end

local numPolygons, polyVerts, polyPlane = staticCollision()

-- A CollisionPoly pointer as "TRI n" (the scene's), "dyna" (a bg actor's:
-- bgId, not the scan's dynapoly ids) or "-" (none).
local function polyName(ptr, bgId)
	if ptr == 0 then return "-" end
	if bgId and bgId ~= 50 then return string.format("dyna(bg %d)", bgId) end  -- BGCHECK_SCENE
	local polyList = read_u32(read_u32(K.colCtx) - K.addrOffset + K.hdrPolyList)
	local id = (ptr - polyList) / K.polySize
	if id >= 0 and id < numPolygons and id == math.floor(id) then return "TRI " .. id end
	return string.format("%08X", ptr)
end
if numPolygons ~= T.numPolygons then
	error(string.format("tests are for %s (%d static polys); the loaded scene has %d - load that map first",
		T.map, T.numPolygons, numPolygons))
end
-- clipfinder --dyna results carry the dynapoly export ("dyna"): its polys
-- get the ids after the scene's own, in file order (clipfinder's numbering),
-- each already in world space with its s16 normal and plane distance.
local dynaPolys = {}
if T.dyna and T.dyna.actors then
	local id = numPolygons
	for _, a in ipairs(T.dyna.actors) do
		for _, q in ipairs(a.polys or {}) do
			dynaPolys[id] = { v = q.v, n = q.n, d = q.d, actor = a.actor }
			id = id + 1
		end
	end
end
if T.fromJson then
	-- (the JSON has only polygon ids: the scene's walls come from the loaded
	-- map, the dynapolys from the export - RAM past the scene's polys is
	-- something else)
	for id in pairs(T.walls) do
		if id >= numPolygons then
			if not dynaPolys[id] then
				error(string.format("TRI %d is past the scene's %d polys and the file has no dynapoly for it (run clipfinder with --dyna)", id, numPolygons))
			end
			T.walls[id] = dynaPolys[id]
		else
			local n, d = polyPlane(id)
			T.walls[id] = { v = polyVerts(id), n = n, d = d }
		end
	end
end
for id, w in pairs(T.walls) do
	local v = id < numPolygons and polyVerts(id) or w.v
	for i = 1, 3 do
		for j = 1, 3 do
			if v[i][j] ~= w.v[i][j] then
				error(string.format("TRI %d in RAM doesn't match the export - wrong map or version?", id))
			end
		end
	end
end

---------------------------------------------------------------------------
-- Hook: set prevPos / posNext right before the player's bg check
---------------------------------------------------------------------------

-- Registers are looked up once here in the emu.getregisters() table (looking
-- a name up there can't throw), since cores don't all name them the same.
-- No pcall around API calls anywhere in this script: an error thrown by one
-- inside pcall after the script has yielded makes BizHawk's NLua panic
-- ("unprotected error in call to Lua API").
local function findRegister(candidates)
	local regs = emu.getregisters()
	for _, name in ipairs(candidates) do
		if regs[name] ~= nil then return name end
	end
	return nil
end
-- (3DS: no hooks, so no registers)
local a1Reg = not IS_3DS and findRegister({ "a1_lo", "a1", "A1", "r5_lo", "r5", "R5", "gpr5", "GPR5" }) or nil
local pcReg = not IS_3DS and findRegister({ "pc", "PC", "pc_lo", "PC_lo" }) or nil
if not IS_3DS then
	local names = {}
	for k in pairs(emu.getregisters()) do names[#names + 1] = tostring(k) end
	table.sort(names)
	print("Registers: a1 = " .. tostring(a1Reg) .. ", pc = " .. tostring(pcReg) ..
		((a1Reg and pcReg) and "" or ("  (the core has: " .. table.concat(names, ", ") .. ")")))
end

local pending = nil   -- the test to apply on the player's next bg check
local fired = false
local calls, seenActors = 0, {}  -- callbacks seen, for diagnosing a hook that never catches Link

local function applyPending()
	writeVec(K.player + K.prevPos, pending.prev)
	writeVec(K.player + K.pos, pending.next)
	pending = nil
	fired = true
end

-- "exec": Actor_UpdateBgCheckInfo(play, actor, ...) is starting; a1 = actor.
local function onBgCheckExec()
	calls = calls + 1
	if not pending or not a1Reg then return end
	local actor = emu.getregister(a1Reg) % 0x1000000
	if #seenActors < 8 then seenActors[#seenActors + 1] = string.format("%06X", actor) end
	if actor == K.player then applyPending() end
end

-- "read": something is reading Link's world.pos.y; take it if that's
-- Actor_UpdateBgCheckInfo (its first statement reads it).
local function onPosRead()
	calls = calls + 1
	if not pending or not pcReg then return end
	local pc = emu.getregister(pcReg) % 0x20000000
	if #seenActors < 8 then seenActors[#seenActors + 1] = string.format("pc %06X", pc) end
	if pc >= K.bgCheckInfo % 0x20000000 and pc < K.bgCheckInfoEnd % 0x20000000 then applyPending() end
end

local hookIds = {}
local function unhook()
	for _, id in ipairs(hookIds) do event.unregisterbyid(id) end
	hookIds = {}
end
-- Each at the KSEG0 address and without the segment bits, in case the core
-- reports physical addresses.
local function hook(mode)
	unhook()
	calls, seenActors = 0, {}
	if mode == "exec" then
		hookIds[1] = event.onmemoryexecute(onBgCheckExec, K.bgCheckInfo, "wall_clip_exec")
		hookIds[2] = event.onmemoryexecute(onBgCheckExec, K.bgCheckInfo % 0x20000000, "wall_clip_exec_phys")
	elseif mode == "read" then
		local y = 0x80000000 + K.player + K.pos + 4
		hookIds[1] = event.onmemoryread(onPosRead, y, "wall_clip_read")
		hookIds[2] = event.onmemoryread(onPosRead, y % 0x20000000, "wall_clip_read_phys")
	end
end

---------------------------------------------------------------------------
-- Judging a result
---------------------------------------------------------------------------

-- Signed distance to a wall's plane (collision header normal / dist), at
-- Link's wall check height (the test's form's, with several forms).
local checkHeight = T.checkHeight
local radius = T.radius or 18  -- (old .lua test files: no radius)
local function planeDist(w, p)
	local y = p[2] + checkHeight
	return (w.n[1] * p[1] + w.n[2] * y + w.n[3] * p[3]) / 32767 + w.d
end

local function dist3(a, b)
	return math.sqrt((a[1] - b[1]) ^ 2 + (a[2] - b[2]) ^ 2 + (a[3] - b[3]) ^ 2)
end

-- How far Link's check point (feet + checkHeight), projected onto the wall
-- along its normal, is outside its triangle (0: over it).
local function offTriangle(w, p)
	local n = { w.n[1] / 32767, w.n[2] / 32767, w.n[3] / 32767 }
	local len = math.sqrt(n[1] * n[1] + n[2] * n[2] + n[3] * n[3])
	for i = 1, 3 do n[i] = n[i] / len end
	local d = planeDist(w, p) / len
	local q = { p[1] - d * n[1], p[2] + checkHeight - d * n[2], p[3] - d * n[3] }
	local a, b, c = w.v[1], w.v[2], w.v[3]
	local function sub(u, v) return { u[1] - v[1], u[2] - v[2], u[3] - v[3] } end
	local function dot(u, v) return u[1] * v[1] + u[2] * v[2] + u[3] * v[3] end
	local v0, v1, v2 = sub(b, a), sub(c, a), sub(q, a)
	local d00, d01, d11, d20, d21 = dot(v0, v0), dot(v0, v1), dot(v1, v1), dot(v2, v0), dot(v2, v1)
	local den = d00 * d11 - d01 * d01
	if den == 0 then return math.huge end
	local bv = (d11 * d20 - d01 * d21) / den
	local bw = (d00 * d21 - d01 * d20) / den
	if bv >= 0 and bw >= 0 and bv + bw <= 1 then return 0 end
	local function segDist(u, v)
		local e = sub(v, u)
		local t = math.max(0, math.min(1, dot(sub(q, u), e) / dot(e, e)))
		local r = { u[1] + e[1] * t - q[1], u[2] + e[2] * t - q[2], u[3] + e[3] * t - q[3] }
		return math.sqrt(dot(r, r))
	end
	return math.min(segDist(a, b), segDist(b, c), segDist(c, a))
end

-- "clipped": behind the clipped wall at the end; "fell": dropped a long way
-- (out of bounds with no floor); "voided": moved far away (void out /
-- respawn); "no": back in front of the wall, over it (within his radius of
-- its triangle), or where he started; "away": neither behind it nor back in
-- front of it - he went off past its edge (a wall that leans, Link landed on
-- its top side and slid or jumped off: OoT Death Mountain Trail TRI 90 -> 25).
-- The plane alone can't tell: far past a leaning wall's edge its plane says
-- nothing about the wall.
-- In front of the plane counts as "no" over the clipped wall or any scene
-- wall in the same plane: a thin strip's check point can end up over the
-- wall above it (MM West Clock Town: TRI 66 is y 60-75 under TRI 62; Link
-- dropped back onto floor TRI 145 at y 60, check point at 86.8, was "away").
local coplanarCache = {}
local function coplanarWalls(id)
	if coplanarCache[id] then return coplanarCache[id] end
	local w, out = T.walls[id], {}
	if id < numPolygons then
		for j = 0, numPolygons - 1 do
			if j ~= id then
				local n, d = polyPlane(j)
				if n[1] == w.n[1] and n[2] == w.n[2] and n[3] == w.n[3] and d == w.d then
					out[#out + 1] = { v = polyVerts(j), n = n, d = d }
				end
			end
		end
	end
	coplanarCache[id] = out
	return out
end
local function judge(test, after, final)
	local w = T.walls[test.crossed]
	if dist3(final, test.next) > 300 then return "voided" end
	if final[2] < test.next[2] - 150 then return "fell" end
	if planeDist(w, final) < -BEHIND_MIN and planeDist(w, after) < -BEHIND_MIN then return "clipped" end
	if planeDist(w, final) >= -BEHIND_MIN then
		if offTriangle(w, final) <= radius then return "no" end
		for _, c in ipairs(coplanarWalls(test.crossed)) do
			if offTriangle(c, final) <= radius then return "no" end
		end
	end
	if dist3(final, test.prev) <= radius then return "no" end
	return "away"
end
local function worked(status) return status == "clipped" or status == "fell" or status == "voided" or status == "away" end

---------------------------------------------------------------------------
-- Run
---------------------------------------------------------------------------

local function fmt(v) return v and string.format("%.9g, %.9g, %.9g", v[1], v[2], v[3]) or "-" end

-- The form Link is in now.
local function currentForm()
	local names = { [0] = "FierceDeity", "Goron", "Zora", "Deku", "Human" }
	if GAME == "MM3D" then
		local v = read_s16(K.playerForm3DS)
		if not names[v] then
			error(string.format("MM3D: save.playerForm (0x%08X) reads %d, not a form 0-4: set FORM", K.playerForm3DS, v))
		end
		return names[v]
	end
	if GAME == "OOT" or GAME == "OOT3D" then
		-- (arithmetic, not `&`: BizHawk's Lua doesn't parse the bitwise operators)
		if math.floor(read_u32(K.player + K.stateFlags2) / K.crawling) % 2 == 1 then return "Crawlspace" end
		return read_u32(K.linkAge) == 0 and "Adult" or "Child"
	end
	return names[mainmemory.read_u8(K.player + K.transformation)] or "?"
end

-- Tests with several forms: keep the ones for this form. A test's form can
-- name several ("Human/Deku": the same radius and check height, one scan).
local tests, runForm = T.tests, T.form
if #T.tests == 0 then
	error(testsPath .. " has no clips (clipfinder found none: with --pair, check the order - PUSHER,CROSSED, and for a slope clip the floor, then the wall)")
end
if T.forms then
	runForm = FORM or currentForm()
	local function formMatches(label)
		for part in tostring(label):gmatch("[^/]+") do
			if part:lower() == runForm:lower() then return true end
		end
		return false
	end
	tests = {}
	for _, t in ipairs(T.tests) do
		if formMatches(t.form) then tests[#tests + 1] = t end
	end
	local names = {}
	for label, f in pairs(T.forms) do
		names[#names + 1] = label
		if formMatches(label) then checkHeight, radius = f.checkHeight, f.radius end
	end
	table.sort(names)
	if #tests == 0 then
		error(string.format("no tests for %s (Link's form%s) - the tests have %s", runForm,
			FORM and ", from FORM" or " in RAM", table.concat(names, ", ")))
	end
	print(string.format("Form: %s (%d of %d tests; the file has %s)", runForm, #tests, #T.tests, table.concat(names, ", ")))
	if GAME == "MM3D" and not FORM then
		print(string.format("  (MM3D: the form is save.playerForm at 0x%08X = %d - if %s is wrong, set FORM)",
			K.playerForm3DS, read_s16(K.playerForm3DS), runForm))
	end
end

-- X_RANGE / Y_RANGE / Z_RANGE: only the clip points in that area
if X_RANGE or Y_RANGE or Z_RANGE then
	local ranges = { X_RANGE, Y_RANGE, Z_RANGE }
	local function inArea(p)
		for i = 1, 3 do
			local r = ranges[i]
			if r and (p[i] < math.min(r[1], r[2]) or p[i] > math.max(r[1], r[2])) then return false end
		end
		return true
	end
	local kept = {}
	for _, t in ipairs(tests) do
		-- (a .lua tests file from an older viewer has no clip point: the move's end)
		if inArea(t.from or t.next) then kept[#kept + 1] = t end
	end
	local function show(name, r) return r and string.format(" %s %g..%g", name, math.min(r[1], r[2]), math.max(r[1], r[2])) or "" end
	print(string.format("area:%s%s%s - %d of %d tests", show("x", X_RANGE), show("y", Y_RANGE), show("z", Z_RANGE), #kept, #tests))
	tests = kept
	if #tests == 0 then error("no clip points in the X_RANGE / Y_RANGE / Z_RANGE area") end
end

-- ACTION_KEYS: only those actions' tests (the other tests are kept)
if ACTION_KEYS then
	local want, kept = {}, {}
	for _, k in ipairs(ACTION_KEYS) do want[k] = true end
	for _, t in ipairs(tests) do
		if not t.actionKey or want[t.actionKey] then kept[#kept + 1] = t end
	end
	print(string.format("ACTION_KEYS: %d of %d tests", #kept, #tests))
	tests = kept
	if #tests == 0 then error("no tests left after ACTION_KEYS") end
end

-- Falling crossings whose drop makes checkHeight + dy < 5 can't work: the
-- game's wall line test then runs from Link's feet with floors included and
-- stops him on the floor he starts from (tested in game: OoT Kakariko child,
-- 20 of 20 didn't clip). Scans from before clipfinder checked this from the
-- start still have them. Not ground clips (kind "ground"): that line test
-- missing the floor is how they work.
do
	local kept = {}
	for _, t in ipairs(tests) do
		if t.kind == "ground" or not (t.type == "cross" and checkHeight + (t.next[2] - t.prev[2]) * LINE_DY_SCALE < 5) then kept[#kept + 1] = t end
	end
	if #kept < #tests then
		print(string.format("left out %d falling crossing tests with a drop over %g (can't clip)", #tests - #kept, (checkHeight - 5) / LINE_DY_SCALE))
	end
	tests = kept
	if #tests == 0 then error("no tests left: they were all falling crossings that can't clip") end
end

-- FALLING_TESTS "needed": a wall pair's falling tests only where they're
-- what gets the pair (none walking of that kind), or slower than walking.
if FALLING_TESTS == "needed" and not SKIP_FALLING then
	local function speedOf(t) return t.reachSpeed or t.speed end
	local walkMin, fallMin, hasWalk = {}, {}, {}
	local function keyOf(t, kind) return table.concat({ t.form or "", t.pusher, t.crossed, kind }, ":") end
	for _, t in ipairs(tests) do
		local base = t.kind:match("^low%-(.+)$")
		if base then
			local k = keyOf(t, base)
			local sp = speedOf(t)
			if sp and sp < (fallMin[k] or math.huge) then fallMin[k] = sp end
		elseif t.kind == "acute" or t.kind == "extended" then
			local k = keyOf(t, t.kind)
			hasWalk[k] = true
			local sp = speedOf(t)
			-- (a walking point with no speed: a standing one, reached some way)
			walkMin[k] = math.min(walkMin[k] or math.huge, sp or 0)
		end
	end
	local kept, dropped, pairs0 = {}, 0, {}
	for _, t in ipairs(tests) do
		local base = t.kind:match("^low%-(.+)$")
		local k = base and keyOf(t, base)
		if k and hasWalk[k] and not ((fallMin[k] or math.huge) < walkMin[k]) then
			dropped = dropped + 1
			pairs0[k] = true
		else
			kept[#kept + 1] = t
		end
	end
	if dropped > 0 then
		local n = 0
		for _ in pairs(pairs0) do n = n + 1 end
		print(string.format("FALLING_TESTS needed: left out %d falling tests of %d wall pairs that also clip walking, at the same or a lower speed", dropped, n))
	end
	tests = kept
	if #tests == 0 then error("no tests left after FALLING_TESTS") end
end

if SKIP_FALLING then
	local kept = {}
	for _, t in ipairs(tests) do
		if not t.kind:find("^low") then kept[#kept + 1] = t end
	end
	print(string.format("SKIP_FALLING: left out %d falling tests", #tests - #kept))
	tests = kept
	if #tests == 0 then error("no tests left after SKIP_FALLING (they were all falling ones)") end
end

-- Group the tests, and pick up to MAX_PER_GROUP spread over each group.
local groups, order = {}, {}
for _, t in ipairs(tests) do
	if not groups[t.group] then
		groups[t.group] = { tests = {}, first = t }
		order[#order + 1] = t.group
	end
	table.insert(groups[t.group].tests, t)
end
local queue = {}
for _, gi in ipairs(order) do
	local list = groups[gi].tests
	local n = #list
	local pick = (MAX_PER_GROUP > 0 and n > MAX_PER_GROUP) and MAX_PER_GROUP or n
	groups[gi].picked = {}
	for k = 1, pick do
		local idx = (pick == n) and k or (1 + math.floor((k - 1) * (n - 1) / (pick - 1) + 0.5))
		local t = list[idx]
		table.insert(groups[gi].picked, t)
		queue[#queue + 1] = t
	end
end

-- (OoT3D: no action tests - clipfinder has none for it; MM3D's are the
-- recorded ones, runActionTest3DS)
if GAME == "OOT3D" then
	for _, t in ipairs(queue) do
		if t.action then error("action tests (" .. t.action .. ") aren't supported on " .. GAME) end
	end
end

-- Action tests put their weapon on B: the save context has to be where K says
if SET_WEAPON and K.playerForm then
	local anyAction = false
	for _, t in ipairs(queue) do if t.action then anyAction = true end end
	if anyAction and mainmemory.read_u8(K.playerForm) ~= mainmemory.read_u8(K.player + K.transformation) then
		error(string.format("gSaveContext isn't at 0x80%06X in this game (save.playerForm %d, Link's form %d): fix K.saveContext, or set SET_WEAPON = false",
			K.saveContext, mainmemory.read_u8(K.playerForm), mainmemory.read_u8(K.player + K.transformation)))
	end
end

print(string.format("Wall clip tester: %s, %s, %s - %d tests (%d points exported)",
	GAME, T.map, runForm, #queue, #tests))

local base = memorysavestate.savecorestate()
print("Saved the starting state")

-- BizHawk keeps an analog override after the script stops (the stick stays
-- where it was last set): a value that isn't a number clears it. Buttons are
-- only ever pressed (true), never forced up (false), and last one frame.
local function releaseStick()
	if IS_3DS then
		joypad.setanalog({ ["Circle Pad X"] = "", ["Circle Pad Y"] = "" })
		return
	end
	joypad.setanalog({ ["X Axis"] = "", ["Y Axis"] = "" }, 1)
end

-- Put things back however the script ends (finished, error, or stopped).
local cleanedUp = false
local function cleanUp()
	if cleanedUp then return end
	cleanedUp = true
	pending = nil
	unhook()
	releaseStick()
	if FAST and client.invisibleemulation then client.invisibleemulation(false) end
	memorysavestate.loadcorestate(base)
	memorysavestate.removestate(base)
end
event.onexit(cleanUp)

if FAST and client.invisibleemulation then client.invisibleemulation(true) end

-- OoT3D / MM3D: check the addresses that aren't from a watch file before
-- relying on them (the starting state is loaded again after).
-- The frame counter: K.gameplayFrames has to go up one a game frame, every
-- EMU_PER_GAME emulated frames (the move timing hangs on it). If it doesn't
-- (MM3D: play + 0xF8, OoT3D's GameState.frames, never moved), the game
-- context is searched for a word that does: FRAME_SCAN bytes from K.play,
-- read every emulated frame for 6 game frames; each step 0 or 1, 5-7 in all.
-- The one used is printed: put it in K.gameplayFrames to skip the search.
-- checkYaw: Link standing still faces his Player.yaw, so it has to read the
-- same as shape.rot.y ("Angle").
local FRAME_SCAN = 0x10000
if IS_3DS then
	local n = 6 * EMU_PER_GAME
	local function counterOk(samples)
		for i = 2, #samples do
			local d = samples[i] - samples[i - 1]
			if d ~= 0 and d ~= 1 then return false end
		end
		local total = samples[#samples] - samples[1]
		return total >= n / EMU_PER_GAME - 1 and total <= n / EMU_PER_GAME + 1
	end
	local samples = { read_u32(K.play + K.gameplayFrames) }
	for _ = 1, n do emu.frameadvance(); samples[#samples + 1] = read_u32(K.play + K.gameplayFrames) end
	if not counterOk(samples) then
		print(string.format("%s: play + 0x%X went up %d in %d emulated frames, not %d: searching %d KB of the game context for the frame counter",
			GAME, K.gameplayFrames, samples[#samples] - samples[1], n, n / EMU_PER_GAME, FRAME_SCAN / 1024))
		-- (one block read a frame: read_bytes_as_array where the API has it)
		local function snap()
			if mainmemory.read_bytes_as_array then
				local t = mainmemory.read_bytes_as_array(K.play, FRAME_SCAN)
				local o = t[0] ~= nil and 0 or 1
				local w = {}
				for i = 0, FRAME_SCAN - 4, 4 do
					w[i] = t[i + o] + t[i + o + 1] * 0x100 + t[i + o + 2] * 0x10000 + t[i + o + 3] * 0x1000000
				end
				return w
			end
			local w = {}
			for i = 0, FRAME_SCAN - 4, 4 do w[i] = read_u32(K.play + i) end
			return w
		end
		local snaps = { snap() }
		for _ = 1, n do emu.frameadvance(); snaps[#snaps + 1] = snap() end
		local found = {}
		for i = 0, FRAME_SCAN - 4, 4 do
			local col = {}
			for k = 1, #snaps do col[k] = snaps[k][i] end
			if counterOk(col) then found[#found + 1] = i end
		end
		if #found == 0 then
			cleanUp()
			error(string.format("%s: no word in the %d KB from the game context (0x%08X) goes up one a game frame - is the game running (no pause, no menu) at 30 fps?",
				GAME, FRAME_SCAN / 1024, K.play))
		end
		local list = {}
		for k = 1, math.min(#found, 8) do list[k] = string.format("0x%X", found[k]) end
		K.gameplayFrames = found[1]
		print(string.format("  frame counters at play + %s%s: using play + 0x%X (set K.gameplayFrames = 0x%X to skip this)",
			table.concat(list, ", "), #found > 8 and ", ..." or "", K.gameplayFrames, K.gameplayFrames))
	end
	local yaw, shape = read_u16(K.player + K.yaw), read_u16(K.player + K.shapeRotY)
	if yaw ~= shape then
		-- (the s16s near speedXZ that do read as his facing, to try instead)
		local near = {}
		if shape ~= 0 then
			for o = -0x40, 0x40, 2 do
				if read_u16(K.player + K.speedXZ + o) == shape then near[#near + 1] = string.format("0x%X", K.speedXZ + o) end
			end
		end
		cleanUp()
		error(string.format("%s: Player.yaw at +0x%X reads 0x%04X but Link faces 0x%04X (shape.rot.y): K.yaw is wrong for this version, or Link isn't standing still%s",
			GAME, K.yaw, yaw, shape, #near > 0 and (" (near speedXZ, these read 0x%04X: " .. table.concat(near, ", ") .. ")"):format(shape) or ""))
	end
	print(string.format("%s: frame counter (play + 0x%X) and Player.yaw check out (player at 0x%08X)", GAME, K.gameplayFrames, K.player))
	memorysavestate.loadcorestate(base)
end

-- atan2(y, x) by hand: BizHawk's math.atan ignores a second argument (it
-- returned atan(dx), sending Link off at the wrong yaw).
local function atan2(y, x)
	if x > 0 then return math.atan(y / x) end
	if x < 0 then return math.atan(y / x) + (y >= 0 and math.pi or -math.pi) end
	if y > 0 then return math.pi / 2 end
	if y < 0 then return -math.pi / 2 end
	return 0
end

local function yawTo(dx, dz)
	local a = math.floor(atan2(dx, dz) / math.pi * 0x8000 + 0.5)
	return ((a + 0x8000) % 0x10000) - 0x8000
end

-- The stick pushed so the game reads it as pointing at world yaw `yaw` (nil:
-- centred). The game turns the stick into a world yaw with the active
-- camera's inputDir.y: Lib_GetControlStickData's angle is
-- Math_Atan2S(relY, -relX) (0 = stick up), plus Camera_GetInputDirYaw. So
-- with a fixed camera stick up isn't Link's forward: the stick is turned by
-- (yaw - camera yaw). rel is the raw stick minus the 7 dead zone, capped at
-- 60 per axis (PadUtils_UpdateRelXY), so the direction is scaled to a 60 rel
-- on its long axis (magnitude >= 60: a full push) and 7 added back.
-- MM takes the angle from the raw stick instead (Lib_GetControlStickData:
-- Math_Atan2S_XY(cur.stick_y, -cur.stick_x); only the magnitude is rel's), so
-- the 7 added to each axis turned the direction up to ~4 degrees toward the
-- diagonal (0x300 off in Deku Palace): there the raw stick itself points
-- along the direction, its long axis at 127 (rel 60 or more: a full push).
local function stickToward(yaw)
	if not yaw then
		joypad.setanalog({ ["X Axis"] = 0, ["Y Axis"] = 0 }, 1)
		return
	end
	local cam = read_u32(K.play + K.cameraPtrs + 4 * mainmemory.read_s16_be(K.play + K.activeCamId))
	local camYaw = cam >= 0x80000000 and mainmemory.read_s16_be(cam - 0x80000000 + K.camInputDirY) or 0
	local a = ((yaw - camYaw) % 0x10000) / 0x8000 * math.pi
	local dx, dy = -math.sin(a), math.cos(a)
	local m = math.max(math.abs(dx), math.abs(dy))
	if GAME == "MM" then
		-- (the whole stick, long axis 90-127, nearest the angle: these clips can
		-- need it within 0x40)
		local best, bx, by = math.huge, 0, 0
		for L = 90, 127 do
			local x, y = math.floor(dx / m * L + 0.5), math.floor(dy / m * L + 0.5)
			local e = math.abs(atan2(x * dy - y * dx, x * dx + y * dy))
			if e < best then best, bx, by = e, x, y end
		end
		joypad.setanalog({ ["X Axis"] = bx, ["Y Axis"] = by }, 1)
		return
	end
	local function axis(v)
		local rel = math.floor(v / m * 60 + 0.5)
		if rel > 0 then return rel + 7 elseif rel < 0 then return rel - 7 end
		return 0
	end
	joypad.setanalog({ ["X Axis"] = axis(dx), ["Y Axis"] = axis(dy) }, 1)
end

-- The attack clipfinder's action keys are (PLAYER_MWA_*, both games)
-- (the Deku stick is two-handed and always does the forward slash)
local ACTION_MWA = { ["1h-slash"] = 0, ["2h-slash"] = 1, ["1h-stab"] = 12, ["2h-stab"] = 13, ["stick-slash"] = 1 }
-- the jumpslash ends as PLAYER_MWA_JUMPSLASH_FINISH (MM's list has the Zora jump kick before it)
for _, k in ipairs({ "1h-jumpslash", "2h-jumpslash", "stick-jumpslash" }) do
	ACTION_MWA[k] = GAME == "OOT" and 19 or 20
	ACTION_MWA[k .. "-fwd"] = ACTION_MWA[k]
end
-- MM Zora: PLAYER_MWA_ZORA_PUNCH_LEFT; the jumpslash and the Zora clip end as
-- PLAYER_MWA_ZORA_JUMPKICK_FINISH
ACTION_MWA["zora-punch"] = 27
for _, k in ipairs({ "zora-jumpslash", "zora-jumpslash-fwd", "zora-clip", "zora-clip-fwd" }) do ACTION_MWA[k] = 21 end
local ZORA_FINS_IA = 8   -- PLAYER_IA_ZORA_BOOMERANG: the fins out (B pressed once as Zora)
-- The two-handed spin attack (PLAYER_MWA_SPIN_ATTACK_2H), locked on to an enemy
-- (no Deku stick spin: 1h and 2h only - the user)
for _, k in ipairs({ "2h-spin-lock", "2h-spin-lock-fwd", "2h-spin-fwd", "2h-spin-lock-r", "2h-spin-lock-fwd-r" }) do
	ACTION_MWA[k] = GAME == "OOT" and 25 or 31
end
ACTION_MWA["1h-spin-fwd"] = GAME == "OOT" and 24 or 30   -- PLAYER_MWA_SPIN_ATTACK_1H
local LUNGE_FLAG = 0x40000000   -- OoT PLAYER_STATE2_30 / MM PLAYER_STATE2_40000000: a lunge to come (-ls: stored)
local SPIN_CHARGE = 60          -- (spin-lock) emulated frames B is held at the end of the hold: the slash, then charging (under the great spin's 0.85)
-- The Player item action (heldItemAction) each B item gives (PLAYER_IA_*), to check he's holding it
local WEAPON_IA = GAME == "OOT" and { [0x3C] = 3, [0x3B] = 4, [0x3D] = 5, [0x55] = 5, [0x00] = 6 }
	or { [0x4D] = 3, [0x4E] = 4, [0x4F] = 5, [0x10] = 6, [0x08] = 7 }

-- The B item for an action test in the form Link is in (nil: none set up)
local function actionWeapon(t)
	local byForm = ACTION_WEAPONS[GAME] and ACTION_WEAPONS[GAME][currentForm()]
	-- ("1h-slash" -> "1h", "stick-slash" -> "stick")
	return byForm and byForm[t.actionKey:match("^[^-]+")]
end

-- A Deku spin (clipfinder action.cpp dekuSpinFrames), once Link is standing at
-- the start facing `facing`. Every game frame the stick is at full tilt toward
-- the move's world yaw (through the camera: stickToward). The game frames are
-- counted as clipfinder's frames are, from the first one Link moves on (the one
-- the stick is first pushed on doesn't move him yet):
--  deku-spin: the stick toward `facing` (no Z) for 3 frames (2, 4, 6), A on
--   the 4th.
--  deku-spin-backwalk: Z and the stick toward facing + 0x8000 (he backwalks)
--   for 6 frames (1.5 .. 9), the 7th without Z (he turns round), A on the 8th.
-- (The frame counts, not speedXZ: a wall he touches lowers the stick's speed,
-- so 6 / 9 isn't always reached - clipfinder counts the same way.) Then the
-- stick held through the spin (SPIN_FRAMES), or let go after t.stopAfter
-- frames (the clip stops part way, Link out of bounds inside the wall).
-- Statuses: "no run-up" (he never moved), "no spin" (no spinning after A: the
-- shape yaw turns about 0x4000 a frame in one).
local SPIN_FRAMES = 15   -- Player_Action_95's frames (B10[1] 0x30000 stepped by 19200, 18400, ...)
local WALKIN_RUN = 9     -- a -walkin key's run in: up to the run speed (2, 4, 5.5 / 6), then 6 more frames (clipfinder WALKIN_HOLD)
local function runSpin(t, r, facing, logLine)
	local back = t.actionKey == "deku-spin-backwalk"
	local yaw = back and ((facing + 0x8000 + 0x8000) % 0x10000 - 0x8000) or facing
	local runFrames = back and 6 or 3
	local aFrame = runFrames + (back and 2 or 1)   -- the frame A is pressed on
	local lastFrame = aFrame + SPIN_FRAMES
	local stopAfter = t.stopAfter
	local gf = read_u32(K.play + K.gameplayFrames)
	local prevPos = readVec(K.player + K.pos)
	local frame = 0        -- clipfinder's frame number of the game frame just run (0: not moving yet)
	local waited = 0
	local spun, prevShape = false, nil
	for _ = 1, (40 + lastFrame + 4) * 3 do
		-- the inputs for frame `frame + 1`
		local f = frame + 1
		local held = {}
		if back and f <= runFrames then held.Z = true end
		if f == aFrame then held.A = true end
		if next(held) then joypad.set(held, 1) end
		local stickOn = f <= lastFrame and not (stopAfter and f > stopAfter)
		stickToward(stickOn and yaw or nil)
		emu.frameadvance()
		local g = read_u32(K.play + K.gameplayFrames)
		if g ~= gf then
			gf = g
			local pos = readVec(K.player + K.pos)
			if frame > 0 or dist3(pos, prevPos) > 0.0001 then frame = frame + 1 else waited = waited + 1 end
			prevPos = pos
			local shape = mainmemory.read_u16_be(K.player + K.shapeRotY)
			if frame > aFrame and prevShape then
				local d = (shape - prevShape) % 0x10000
				if d > 0x8000 then d = 0x10000 - d end
				if d > 0x2000 then spun = true end
			end
			prevShape = shape
			logLine(frame == 0 and "wait" or string.format("frame %d%s%s", frame, frame == aFrame and " (A)" or "",
				stopAfter and frame == stopAfter and " (stop: stick let go)" or ""))
			if frame == 0 and waited > 10 then
				r.status = "no run-up"
				r.log[#r.log + 1] = "Link never moved: the stick (camera?), or something in the way"
				return false
			end
			if frame >= lastFrame + 1 then break end
		end
	end
	releaseStick()
	if not spun then
		r.status = "no spin"
		r.log[#r.log + 1] = "A didn't start a spin (the shape yaw didn't spin): Link on foot as Deku, no menus or text"
		return false
	end
	return true
end

-- An action clip: the game does the lunge. Link is held at `prev` facing
-- `facing` (Z held; the stick is aimed through the camera, see stickToward), then
-- B with the stick forward for a game frame (a stab: Z still held). His
-- meleeWeaponAnimation is set to -1 first: afterwards it says which attack he
-- did, if any (and the combo counter starts over).
-- The jumpslash: Z held, then A with Z for a game frame and the stick left
-- alone, then nothing (clipfinder's air frames: no stick, so speedXZ steps
-- down 0.1 a frame and the yaw stays the facing) - or, the -fwd keys, Z and
-- the stick forward while he's in the air (t.airFrames game frames). R
-- (shield) is held from the A press on: when the landing slash ends, it
-- interrupts the step back, which would otherwise move him about 27 back.
local function runActionTest(t, r)
	local facing = t.facing
	if facing >= 0x8000 then facing = facing - 0x10000 end
	-- (a -walkin key: the same attack after running into the corner, WALKIN_RUN)
	local key = (t.actionKey:gsub("%-walkin$", ""))
	local walkin = key ~= t.actionKey
	-- (a -ls key: the jumpslash with a lunge stored, LUNGE_FLAG set just before it)
	local lsKey = (key:gsub("%-ls$", ""))
	local lungeStored = lsKey ~= key
	key = lsKey
	-- (the 2h spin attack locked on: Z held throughout - an enemy has to be there to
	-- lock on to - B held at the end of the hold, slashing then charging, let go)
	local spinLock = key:find("spin%-lock") ~= nil
	-- (any sword spin attack: 1h- / 2h-spin-..., B held to charge, let go)
	local spinAtk = key:find("^%w+%-spin%-") ~= nil and key:find("^deku") == nil
	-- (MM Zora: the fins drawn with a B press first, no R - it's the barrier;
	-- the Zora clip is the jumpslash with B held from before it to the end)
	local zora = key:find("^zora%-") ~= nil
	local zclip = key:find("^zora%-clip") ~= nil
	local jump = key:find("jumpslash") ~= nil or zclip
	local jumpFwd = jump and key:find("%-fwd$") ~= nil
	local stab = jump or key:find("stab") ~= nil
	local spin = key:find("^deku%-spin") ~= nil
	local R = not zora
	-- (Z held right up to the test: the stabs and the jumpslash; the backwalk spin
	-- starts with it held)
	local holdZ = stab or key == "deku-spin-backwalk" or spinLock
	local function holdAt(z)
		if z then joypad.set({ Z = true }, 1) end
		writeVec(K.player + K.pos, t.prev)
		writeVec(K.player + K.prevPos, t.prev)
		writeVec(K.player + K.home, t.prev)
		writefloat(K.player + K.speedXZ, 0)
		writefloat(K.player + K.actorSpeed, 0)
		mainmemory.write_s16_be(K.player + K.yaw, facing)
		mainmemory.write_s16_be(K.player + K.rotY, facing)
		mainmemory.write_s16_be(K.player + K.shapeRotY, facing)
	end
	-- The weapon on B (SET_WEAPON), and B pressed early on so he draws it;
	-- Z held from half way (the camera behind him), a slash lets go of it 4
	-- game frames before the test
	local weapon = SET_WEAPON and actionWeapon(t)
	if weapon then
		mainmemory.write_u8(K.bButton, weapon)
		-- (sticks to swing)
		if t.actionKey:match("^stick") and mainmemory.read_u8(K.stickAmmo) == 0 then mainmemory.write_u8(K.stickAmmo, 10) end
	end
	-- (pressed again at 36 and 66 if he isn't holding it yet: a weapon in hand
	-- that's no longer on a button - the savestate's sword, B just changed - is
	-- put away first (MM Player_ProcessItemButtons), and a press during that is
	-- lost: the 2h tests ended holding nothing)
	local wantIA = zora and ZORA_FINS_IA or (weapon and WEAPON_IA[weapon])
	for i = 1, ACTION_HOLD do
		-- (Zora: B draws the fins - and punches, over long before the test; the
		-- Zora clip then holds B, aiming them, for the last 30 frames)
		local press = (i >= 6 and i < 9) or (((i >= 36 and i < 39) or (i >= 66 and i < 69))
			and wantIA and mainmemory.read_s8(K.player + K.heldItemAction) ~= wantIA)
		if (weapon or zora) and press then joypad.set({ B = true }, 1) end
		if zclip and i > ACTION_HOLD - 30 then joypad.set({ B = true }, 1) end
		if spinAtk and i > ACTION_HOLD - SPIN_CHARGE then joypad.set({ B = true }, 1) end
		holdAt(i > ACTION_HOLD / 2 and (holdZ or i <= ACTION_HOLD - 12))
		emu.frameadvance()
	end
	-- standing there on his own until a game frame has just run
	local frames = read_u32(K.play + K.gameplayFrames)
	for _ = 1, 6 do
		if holdZ or zclip or spinAtk then joypad.set({ Z = holdZ or nil, B = (zclip or spinAtk) or nil }, 1) end
		emu.frameadvance()
		if read_u32(K.play + K.gameplayFrames) ~= frames then break end
	end
	r.start = readVec(K.player + K.pos)
	r.yaw = facing
	mainmemory.write_s16_be(K.player + K.yaw, facing)
	mainmemory.write_s16_be(K.player + K.shapeRotY, facing)
	mainmemory.write_s8(K.player + K.meleeWeaponAnimation, -1)
	local held = mainmemory.read_s8(K.player + K.heldItemAction)
	if weapon and WEAPON_IA[weapon] and held ~= WEAPON_IA[weapon] then
		r.log = { string.format("Link is holding item action %d, not the B weapon's %d (B item 0x%02X): he didn't draw it - is B usable here?", held, WEAPON_IA[weapon], weapon) }
		r.status = "no weapon"
		r.after, r.final = readVec(K.player + K.pos), readVec(K.player + K.pos)
		return r
	end
	if zora and held ~= ZORA_FINS_IA then
		r.log = { string.format("Link is holding item action %d, not the fins (%d): B didn't draw them - Zora, on foot, B usable?", held, ZORA_FINS_IA) }
		r.status = "no fins"
		r.after, r.final = readVec(K.player + K.pos), readVec(K.player + K.pos)
		return r
	end
	r.log = {}
	local frames0 = read_u32(K.play + K.gameplayFrames)
	local function logLine(tag)
		r.log[#r.log + 1] = string.format(
			"%s gf+%d pos %s speedXZ %.3f velY %.3f yaw %04X shapeYaw %04X action %08X attack %d animMove %02X wall %s floor %s bgFlags %04X",
			tag, read_u32(K.play + K.gameplayFrames) - frames0, fmt(readVec(K.player + K.pos)),
			readfloat(K.player + K.speedXZ), readfloat(K.player + K.velocity + 4),
			mainmemory.read_u16_be(K.player + K.yaw), mainmemory.read_u16_be(K.player + K.shapeRotY),
			read_u32(K.player + K.actionFunc), mainmemory.read_s8(K.player + K.meleeWeaponAnimation),
			mainmemory.read_u8(K.player + K.skelAnime + 0x35),
			polyName(read_u32(K.player + K.wallPoly), mainmemory.read_u8(K.player + K.wallBgId)),
			polyName(read_u32(K.player + K.floorPoly), mainmemory.read_u8(K.player + K.wallBgId + 1)), read_u16(K.player + K.bgCheckFlags))
	end
	if spin then
		logLine("start")
		local ok = runSpin(t, r, facing, logLine)
		r.after = readVec(K.player + K.pos)
		for i = 1, SETTLE_FRAMES do
			emu.frameadvance()
			if i % 3 == 0 and i <= 18 then logLine("settle") end
		end
		r.final = readVec(K.player + K.pos)
		if RECORD then for _ = 1, RECORD_BUFFER do emu.frameadvance() end end
		if not ok then return r end
		if dist3(r.start, t.prev) > 1 then
			r.status = "setup"
			table.insert(r.log, 1, "start (should be prev) " .. fmt(r.start))
			return r
		end
		r.status = judge(t, r.after, r.final)
		return r
	end
	if walkin then
		-- Run into the corner: the stick at full tilt along the facing (Z held too
		-- for a stab or the jumpslash) for WALKIN_RUN game frames, counted as
		-- clipfinder does from the first one he moves on; the B / A press then
		-- comes on the next (clipfinder's walkInVariant: it still moves him at the
		-- run speed)
		local gf, prevPos, frame, waited = read_u32(K.play + K.gameplayFrames), readVec(K.player + K.pos), 0, 0
		while frame < WALKIN_RUN do
			if stab or zclip then joypad.set({ Z = stab or nil, B = zclip or nil }, 1) end
			stickToward(facing)
			emu.frameadvance()
			local g = read_u32(K.play + K.gameplayFrames)
			if g ~= gf then
				gf = g
				local pos = readVec(K.player + K.pos)
				if frame > 0 or dist3(pos, prevPos) > 0.0001 then frame = frame + 1 else waited = waited + 1 end
				prevPos = pos
				logLine(frame == 0 and "wait" or string.format("run in %d", frame))
				-- (gf+ in the log, and the jumpslash's frames in the air, count from the press)
				if frame == WALKIN_RUN then frames0 = g end
				if frame == 0 and waited > 10 then
					releaseStick()
					r.status = "no run-up"
					r.log[#r.log + 1] = "Link never moved: the stick (camera?), or something in the way"
					r.after, r.final = readVec(K.player + K.pos), readVec(K.player + K.pos)
					return r
				end
			end
		end
	end
	if lungeStored then
		-- the lunge flag, as an attack whose lunge never fired leaves it
		local f2 = read_u32(K.player + K.stateFlags2)
		if math.floor(f2 / LUNGE_FLAG) % 2 == 0 then mainmemory.write_u32_be(K.player + K.stateFlags2, f2 + LUNGE_FLAG) end
	end
	logLine(string.format("%s (held item action %d%s)", spinAtk and "B let go" or jump and "Z + A" or "B", held, lungeStored and ", lunge stored" or ""))
	-- B and the stick forward for a game frame (3 emulated frames); the
	-- jumpslash: A and Z, the stick left alone; the spin: B let go (Z held), the
	-- stick forward for -fwd (its lunge) or left alone
	for _ = 1, 3 do
		if spinAtk then
			joypad.set({ Z = spinLock or nil }, 1)  -- (Z only locked on: near an enemy it would lock on)
			stickToward(key:find("%-fwd") and facing or nil)
		elseif jump then
			joypad.set({ A = true, Z = true, R = R or nil, B = zclip or nil }, 1)
			stickToward(jumpFwd and facing or nil)
		else
			joypad.set(stab and { B = true, Z = true } or { B = true }, 1)
			stickToward(facing)
		end
		emu.frameadvance()
	end
	releaseStick()
	-- then nothing held; each game frame of the action logged. `after` is
	-- where it leaves him (its frames, and one more)
	local n = (t.actionFrames or 3) + 2
	local gf = read_u32(K.play + K.gameplayFrames)
	local lockedOn = false
	-- (-r, the spin locked on with R held: Z has to be held through the frame the
	-- attack switches to its end animation - that's when the locked-on one is
	-- picked - and let go the next, with R: the shield's full-body action
	-- (Player_ActionHandler_11) only runs with no lock-on, ending the root motion;
	-- still locked on, R only raises the shield on the upper body and the step
	-- back plays out. The switch is spotted as actionFunc leaving the attack's.)
	local spinR = spinLock and key:find("%-r$") ~= nil
	local spinAction, switched = nil, false
	for _ = 1, n * 3 + 6 do
		if spinR and switched then joypad.set({ R = true }, 1)
		elseif (stab and not jump) or spinLock then joypad.set({ Z = true }, 1) end
		if spinLock and not switched and read_u32(K.player + K.focusActor) ~= 0 then lockedOn = true end
		if jump then
			-- (-fwd: Z and the stick forward until he lands, then shield alone)
			local inAir = jumpFwd and read_u32(K.play + K.gameplayFrames) - frames0 < (t.airFrames or 0)
			joypad.set({ R = R or nil, Z = inAir or nil, B = zclip or nil }, 1)
			stickToward(inAir and facing or nil)
		end
		emu.frameadvance()
		local g = read_u32(K.play + K.gameplayFrames)
		if g ~= gf then
			gf = g
			if spinR then
				local af = read_u32(K.player + K.actionFunc)
				if not spinAction then spinAction = af
				elseif not switched and af ~= spinAction then switched = true end
			end
			logLine(spinR and switched and "lunge (Z let go, R)" or "lunge")
		end
		if g - frames0 >= n then break end
	end
	r.after = readVec(K.player + K.pos)
	local mwa = mainmemory.read_s8(K.player + K.meleeWeaponAnimation)
	for i = 1, SETTLE_FRAMES do
		if zclip then joypad.set({ B = true }, 1) end  -- (letting go would throw the fins)
		if spinR then joypad.set({ R = true }, 1) end  -- (the shield held: no step back)
		emu.frameadvance()
		if i % 3 == 0 and i <= 18 then logLine("settle") end
	end
	r.final = readVec(K.player + K.pos)
	if RECORD then for _ = 1, RECORD_BUFFER do emu.frameadvance() end end
	if mwa == -1 then
		r.status = "no attack"
		r.log[#r.log + 1] = (jump and "Z + A" or "B") .. " didn't start an attack: the savestate needs Link on foot, weapon out, no menus or text"
			.. (jump and " (and a room that isn't indoors: there Z + A rolls)" or "")
		return r
	end
	if mwa ~= ACTION_MWA[key] then
		r.status = "wrong attack"
		r.log[#r.log + 1] = string.format("the game did attack %d, the test is %s (%d): %s", mwa, t.actionKey, ACTION_MWA[key],
			jump and "the jumpslash didn't land (attack 17, its start: still in the air after its frames), or wasn't a jumpslash"
			or "a 1h / 2h weapon mismatch, or the stick wasn't read as forward (stickToward, the camera) - or for a stab, Z-targeting")
		return r
	end
	if spinLock and not lockedOn then
		r.status = "no lock-on"
		r.log[#r.log + 1] = "Z didn't lock on to anything during the spin (Player.focusActor stayed 0): the hostile lock-on end needs an enemy in range"
		return r
	end
	if dist3(r.start, t.prev) > 1 then
		r.status = "setup"
		table.insert(r.log, 1, "start (should be prev) " .. fmt(r.start))
		return r
	end
	r.status = judge(t, r.after, r.final)
	return r
end

-- MM3D action tests: the recorded lunges and Deku spins (clipfinder --game MM3D
-- --type actions; the rows come from mm3d_action_recorder.lua, which does them
-- the same way). There's no decomp, so no camera or attack addresses:
--  The camera: L held while Link is held at the start (targeting nothing turns
--   the camera behind him), so the stick's up is his facing. Which way the
--   Circle Pad's axes go is found once, from the starting state (calibrate3DS:
--   Link pushed up, then right, from standing).
--  Lunges: B with the stick forward (the stabs with L still held); the stick
--   has to be read before B, so a test with no lunge (speedXZ never above
--   LUNGE_SPEED_3DS) is run again with the stick pushed earlier
--   (STICK_LEADS_3DS) - status "no lunge" if none did.
--  Deku spins: the recording's own timing (mm3d_actions/<key>.json): frames
--   counted from the first one Link moves on, A for the frame after its
--   pressRow (the backwalk: L let go for the frame before), the stick held
--   until the recording's last row, or let go after t.stopAfter. The stick is
--   steered every game frame so his move yaw (Player.yaw) follows the
--   recording's (facing + each row's angle): the camera turns while he runs.
--   Statuses "no recording", "no run-up", "no spin".
-- The weapon: ACTION_WEAPONS.MM3D (the N64 ids) written to B. No Deku stick ammo top-up (its MM3D address isn't known).
local stickSign3DS = nil   -- { x = +1/-1, y = +1/-1 }: the Circle Pad's axes
local recordings3DS = {}

-- The stick at `rel` (s16: 0 = the camera's forward, +0x4000 = left, as the
-- N64's world yaw = camera yaw + rel), full tilt; nil: let go
-- Returns the Circle Pad X, Y it set (nil: let go).
local function stick3DS(rel)
	if not rel then releaseStick(); return nil end
	local a = rel / 0x8000 * math.pi
	local dx, dy = -math.sin(a), math.cos(a)
	local m = math.max(math.abs(dx), math.abs(dy))
	local x, y = math.floor(dx / m * 127 + 0.5) * stickSign3DS.x, math.floor(dy / m * 127 + 0.5) * stickSign3DS.y
	joypad.setanalog({ ["Circle Pad X"] = x, ["Circle Pad Y"] = y })
	return x, y
end

local function s16v(v) v = v % 0x10000; if v >= 0x8000 then v = v - 0x10000 end; return v end

-- Each axis's sign: from the starting state, L held then let go (the camera
-- behind him), the stick pushed one way for 6 game frames; where he went
-- against his facing. Up should take him along it, right to his right (-0x4000).
local function calibrate3DS()
	local function push(x, y)
		memorysavestate.loadcorestate(base)
		local facing = read_u16(K.player + K.shapeRotY)
		for i = 1, 40 do
			if i <= 20 then joypad.set({ L = true }) end
			emu.frameadvance()
		end
		local p0 = readVec(K.player + K.pos)
		for _ = 1, 6 * EMU_PER_GAME do
			joypad.setanalog({ ["Circle Pad X"] = x, ["Circle Pad Y"] = y })
			emu.frameadvance()
		end
		releaseStick()
		local p1 = readVec(K.player + K.pos)
		local dx, dz = p1[1] - p0[1], p1[3] - p0[3]
		if math.abs(dx) + math.abs(dz) < 1 then
			error("MM3D action tests: Link didn't move with the Circle Pad pushed - the savestate needs him standing on foot, nothing in the way")
		end
		return s16v(yawTo(dx, dz) - facing)
	end
	local up = push(0, 127)
	local right = push(127, 0)
	stickSign3DS = { y = math.abs(up) < 0x4000 and 1 or -1, x = right < 0 and 1 or -1 }
	print(string.format("MM3D: Circle Pad Y +127 went %+d from his facing, X +127 %+d: up is %s, right is %s", up, right,
		stickSign3DS.y > 0 and "+" or "-", stickSign3DS.x > 0 and "+" or "-"))
	memorysavestate.loadcorestate(base)
end

-- mm3d_actions/<key>.json (the spins' timing)
local function recording3DS(key)
	if recordings3DS[key] == nil then
		local f = io.open(scriptDir .. "mm3d_actions\\" .. key .. ".json", "r")
		recordings3DS[key] = false
		if f then
			recordings3DS[key] = parseJson(f:read("*a"))
			f:close()
		end
	end
	return recordings3DS[key] or nil
end

local function runActionTest3DS(t, r)
	if not stickSign3DS then
		calibrate3DS()
	end
	local key = t.actionKey
	local facing = s16v(t.facing)
	local spin = key:find("^deku%-spin") ~= nil
	local back = key == "deku-spin-backwalk"
	local stab = key:find("stab") ~= nil
	local holdL = stab or back
	local rec = spin and recording3DS(key)
	if spin and not rec then
		r.status = "no recording"
		r.log = { "no mm3d_actions\\" .. key .. ".json next to this script (mm3d_action_recorder.lua writes it)" }
		r.after, r.final = t.prev, t.prev
		return r
	end
	local weapon = SET_WEAPON and not spin and actionWeapon(t)
	local frames0
	local function logLine(tag)
		r.log[#r.log + 1] = string.format("%s gf+%d pos %s speedXZ %.3f velY %.3f yaw %04X shapeYaw %04X wall %s floor %s",
			tag, read_u32(K.play + K.gameplayFrames) - frames0, fmt(readVec(K.player + K.pos)),
			readfloat(K.player + K.speedXZ), readfloat(K.player + K.velocity + 4),
			read_u16(K.player + K.yaw), read_u16(K.player + K.shapeRotY),
			polyName(read_u32(K.player + K.wallPoly)), polyName(read_u32(K.player + K.floorPoly)))
	end
	-- Held at the start facing `facing`, the weapon drawn with B presses early
	-- on. Then L pressed - the camera behind him, and (held) the parallel yaw for
	-- the stab / backwalk - but NOT at the start: touching a wall there,
	-- Player_SetParallel snaps him to face it (MM z_player.c: within 0x2000 of
	-- facing it, yaw = wallYaw + 0x8000), and while L is held he keeps turning
	-- back to that. So L goes down at a spot behind the start where he touches
	-- no wall (wallPoly 0, a floor under him), then, L still held, he's held at
	-- the start; let go 12 frames before the end unless it stays held (the
	-- stabs, the backwalk). In game: target before walking up to the wall.
	-- Then on his own until a game frame has just run.
	local function place(p)
		writeVec(K.player + K.pos, p)
		writeVec(K.player + K.home, p)
		writefloat(K.player + K.speedXZ, 0)
		writefloat(K.player + K.actorSpeed, 0)
		write_s16(K.player + K.yaw, facing)
		write_s16(K.player + K.rotY, facing)
		write_s16(K.player + K.shapeRotY, facing)
	end
	local function holdStart()
		memorysavestate.loadcorestate(base)
		if weapon then mainmemory.write_u8(K.bButton, weapon) end
		local half = math.floor(ACTION_HOLD / 2)
		for i = 1, half do
			-- (B at 6, 36 and 66: a sword in hand that's no longer on B - the
			-- savestate's, B just changed - is put away first and a press during
			-- that is lost (the N64 tests re-press only if he isn't holding it;
			-- MM3D's heldItemAction isn't known, so always - a drawn one just swings)
			if not spin and ((i >= 6 and i < 9) or (i >= 36 and i < 39) or (i >= 66 and i < 69)) then joypad.set({ B = true }) end
			place(t.prev)
			emu.frameadvance()
		end
		-- the spot for L: behind him (and off to the sides), touching no wall
		local spot
		for _, c in ipairs({ { 0x8000, 40 }, { 0x8000, 70 }, { 0x6000, 50 }, { 0xA000, 50 }, { 0x8000, 110 }, { 0x4000, 50 }, { 0xC000, 50 } }) do
			local a = (facing + c[1]) / 0x8000 * math.pi
			local p = { t.prev[1] + c[2] * math.sin(a), t.prev[2], t.prev[3] + c[2] * math.cos(a) }
			for _ = 1, 3 * EMU_PER_GAME do place(p); emu.frameadvance() end
			if read_u32(K.player + K.wallPoly) == 0 and read_u32(K.player + K.floorPoly) ~= 0 then spot = p; break end
		end
		r.lSpot = spot
		for i = half + 1, ACTION_HOLD do
			local atSpot = spot and i <= half + 24
			if i > half + (spot and 4 or 0) and (holdL or i <= ACTION_HOLD - 12) then joypad.set({ L = true }) end
			place(atSpot and spot or t.prev)
			emu.frameadvance()
		end
		local g = read_u32(K.play + K.gameplayFrames)
		for _ = 1, 4 * EMU_PER_GAME do
			if holdL then joypad.set({ L = true }) end
			emu.frameadvance()
			if read_u32(K.play + K.gameplayFrames) ~= g then break end
		end
		r.start = readVec(K.player + K.pos)
		r.log = {}
		frames0 = read_u32(K.play + K.gameplayFrames)
		logLine(string.format("start (B item 0x%02X; L pressed %s)", mainmemory.read_u8(K.bButton),
			spot and string.format("at %s, touching no wall", fmt(spot)) or "at the start: no spot nearby without a wall - he may have snapped to face one"))
		if read_u16(K.player + K.shapeRotY) ~= (facing % 0x10000) then
			r.log[#r.log + 1] = string.format("  (facing 0x%04X, not the test's 0x%04X)", read_u16(K.player + K.shapeRotY), facing % 0x10000)
		end
	end
	local function settle()
		r.after = readVec(K.player + K.pos)
		for i = 1, SETTLE_FRAMES do
			emu.frameadvance()
			if i % EMU_PER_GAME == 0 and i <= 6 * EMU_PER_GAME then logLine("settle") end
		end
		r.final = readVec(K.player + K.pos)
		if RECORD then for _ = 1, RECORD_BUFFER do emu.frameadvance() end end
	end
	local function startOk()
		if dist3(r.start, t.prev) > 1 then
			r.status = "setup"
			table.insert(r.log, 1, "start (should be prev) " .. fmt(r.start))
			return false
		end
		return true
	end

	if not spin then
		local n = (t.actionFrames or 3) + 2
		for try, lead in ipairs(STICK_LEADS_3DS) do
			holdStart()
			local top = 0
			local gf = read_u32(K.play + K.gameplayFrames)
			-- the stick `lead` emulated frames before B, B for 3, the stick
			-- STICK_AFTER_3DS more; then each game frame of the lunge logged
			local step = 0
			local total = lead + 3 + STICK_AFTER_3DS
			local inputs = {}   -- (each emulated frame of the press: what was sent)
			for _ = 1, total + n * EMU_PER_GAME + 4 do
				step = step + 1
				local b = step > lead and step <= lead + 3
				if b or holdL then joypad.set({ B = b or nil, L = holdL or nil }) end
				if step <= total then
					local x, y = stick3DS(0)
					inputs[#inputs + 1] = string.format("emu %d (gf+%d): Circle Pad X %d Y %d%s%s", step,
						read_u32(K.play + K.gameplayFrames) - frames0, x, y, b and " + B" or "", holdL and " + L" or "")
				elseif step == total + 1 then releaseStick() end
				emu.frameadvance()
				top = math.max(top, readfloat(K.player + K.speedXZ))
				local g = read_u32(K.play + K.gameplayFrames)
				if g ~= gf then
					gf = g
					logLine(step <= lead and "stick" or "lunge")
				end
				if step > total and g - frames0 >= n then break end
			end
			releaseStick()
			-- the inputs, and the setup as it'd be done by hand
			local function inputLines()
				r.log[#r.log + 1] = string.format("inputs (stick %d emulated frames before B; 2 emulated frames a game frame):", lead)
				for _, l in ipairs(inputs) do r.log[#r.log + 1] = "  " .. l end
				r.log[#r.log + 1] = string.format("by hand: stand at %s facing 0x%04X, press %s L there (the camera goes behind him; touching no wall, so no snap), " ..
					"%s at %s, then%s B with the Circle Pad straight up (X 0, Y %d) on the same frame or just before",
					r.lSpot and fmt(r.lSpot) or fmt(t.prev), facing % 0x10000, holdL and "and hold" or "and tap",
					holdL and "sidestep / walk (L held) to the start" or "walk to the start, facing it again,", fmt(t.prev),
					holdL and " L still held," or "", stickSign3DS.y * 127)
			end
			if top > LUNGE_SPEED_3DS then
				if lead > 0 then r.log[#r.log + 1] = string.format("(lunged with the stick %d emulated frames before B)", lead) end
				inputLines()
				settle()
				if not startOk() then return r end
				r.status = judge(t, r.after, r.final)
				return r
			end
			if try == #STICK_LEADS_3DS then
				settle()
				r.status = "no lunge"
				r.log[#r.log + 1] = string.format("no lunge with any stick lead (speedXZ at most %.3f): the weapon on B? the camera behind him?", top)
				inputLines()
				return r
			end
		end
	end

	-- The Deku spins
	holdStart()
	local rows = rec.rows
	local pressRow = rec.pressRow or 0
	local last = #rows
	local stopAfter = t.stopAfter
	local adj = 0          -- the stick's correction for the camera (steered from Player.yaw)
	local gf = read_u32(K.play + K.gameplayFrames)
	local prevPos = readVec(K.player + K.pos)
	local frame, waited = 0, 0
	local turns, spun, prevShape = 0, false, read_u16(K.player + K.shapeRotY)
	for _ = 1, (40 + last + 4) * EMU_PER_GAME do
		-- the inputs for frame `frame + 1`
		local f = frame + 1
		local held = {}
		if back and f < pressRow then held.L = true end
		if f == pressRow + 1 then held.A = true end
		if next(held) then joypad.set(held) end
		local row = rows[math.min(f, last)]
		local on = f <= last and not (stopAfter and f > stopAfter)
		local sx, sy = stick3DS(on and s16v(row.angle + adj) or nil)
		emu.frameadvance()
		local g = read_u32(K.play + K.gameplayFrames)
		if g ~= gf then
			gf = g
			local pos = readVec(K.player + K.pos)
			if frame > 0 or dist3(pos, prevPos) > 0.0001 then frame = frame + 1 else waited = waited + 1 end
			prevPos = pos
			-- steer: his move yaw against the recording's for this frame
			if frame > 0 and on and readfloat(K.player + K.speedXZ) > 0.5 then
				local want = facing + rows[math.min(frame, last)].angle
				local err = s16v(read_u16(K.player + K.yaw) - want)
				adj = s16v(adj - math.max(-0x400, math.min(0x400, err)))
			end
			local shape = read_u16(K.player + K.shapeRotY)
			local d = math.abs(s16v(shape - prevShape))
			prevShape = shape
			if frame > pressRow and d > 0x800 then turns = turns + 1; if turns >= 2 then spun = true end else turns = 0 end
			logLine((frame == 0 and "wait" or string.format("frame %d%s%s%s", frame, frame == pressRow + 1 and " (A)" or "",
				back and frame == pressRow and " (L let go)" or "", stopAfter and frame == stopAfter and " (stop: stick let go)" or ""))
				.. (sx and string.format(" [Circle Pad X %d Y %d]", sx, sy) or " [stick let go]"))
			if frame == 0 and waited > 10 then
				releaseStick()
				r.status = "no run-up"
				r.log[#r.log + 1] = "Link never moved: the stick (camera?), or something in the way"
				r.after, r.final = pos, pos
				return r
			end
			if frame >= last + 1 then break end
		end
	end
	releaseStick()
	settle()
	if not spun then
		r.status = "no spin"
		r.log[#r.log + 1] = "A didn't start a spin (his shape didn't turn): Link on foot as Deku, no Deku flower under him"
		return r
	end
	if not startOk() then return r end
	r.status = judge(t, r.after, r.final)
	return r
end

-- One test: sets up the frame, lets it run, and says where Link ended up.
local function runTest(t, mode)
	memorysavestate.loadcorestate(base)
	local r = { test = t }
	if t.action then
		if IS_3DS then return runActionTest3DS(t, r) end
		return runActionTest(t, r)
	end
	-- Slope clips (kind "slope", clipfinder slope.h) are always "move": the
	-- clip is the game's own floor check lifting Link after the move, and can
	-- take a second frame's move (speed2). (A hook set for the other tests
	-- does nothing: no test is pending.) Ground clips (kind "ground",
	-- clipfinder ground.h) too: the game's own fall from the start, at
	-- velocity.y `vy`, is the clip.
	if t.kind == "slope" or t.kind == "ground" then mode = "move" end
	if mode == "move" then
		-- The way a manual setup that works in-game does it:
		-- Link standing still at the start facing the test's yaw, then speedXZ
		-- written once, just before a game frame, and nothing else touched.
		local dx, dz = t.next[1] - t.prev[1], t.next[3] - t.prev[3]
		local dist = math.sqrt(dx * dx + dz * dz)
		-- (the export's exact s16 yaw and f32 speed when it has them: the game
		-- moves along the sine table, so the crossing is where the viewer
		-- worked it out only for that exact move)
		-- (a yaw with nowhere to move: exported by an older viewer, where
		-- `prev` was the point itself - tested standing on it instead)
		if t.yaw and dist < 0.01 then
			print("  old export (standing test with no start to walk from): re-export with the current viewer (Ctrl+F5 first)")
			t = { group = t.group, kind = t.kind, type = t.type, pusher = t.pusher, crossed = t.crossed,
				prev = t.prev, next = t.next, expect = t.expect }
			r.test = t
		end
		local yaw = t.yaw or (dist >= 0.01 and yawTo(dx, dz) or nil)
		if yaw and yaw >= 0x8000 then yaw = yaw - 0x10000 end
		-- Hold him at the start for a few game frames: world.pos, prevPos and
		-- (MM) home.pos every emulated frame, no speed. A game frame spans 3
		-- emulated frames and a write can land in the middle of one, so a
		-- single write isn't enough.
		-- (recording: longer, with Z tapped early on for the camera, then
		-- let go for the rest so he's back to standing normally)
		local hold = HOLD_FRAMES + (RECORD and RECORD_BUFFER or 0)
		for i = 1, hold do
			-- (3DS: L targets)
			if RECORD and i >= 4 and i < 10 then
				if IS_3DS then joypad.set({ L = true }) else joypad.set({ Z = true }, 1) end
			end
			writeVec(K.player + K.pos, t.prev)
			if K.prevPos then writeVec(K.player + K.prevPos, t.prev) end
			if K.home then writeVec(K.player + K.home, t.prev) end
			writefloat(K.player + K.speedXZ, 0)
			writefloat(K.player + K.actorSpeed, 0)
			if yaw then
				write_s16(K.player + K.yaw, yaw)
				write_s16(K.player + K.rotY, yaw)
				write_s16(K.player + K.shapeRotY, yaw)
			end
			emu.frameadvance()
		end
		-- Let him stand there on his own until a game frame has just run,
		-- then 2 more emulated frames: the next one runs the next game frame
		-- (the same timing as the trace).
		local frames = read_u32(K.play + K.gameplayFrames)
		for _ = 1, 2 * EMU_PER_GAME do
			emu.frameadvance()
			if read_u32(K.play + K.gameplayFrames) ~= frames then break end
		end
		for _ = 1, EMU_PER_GAME - 1 do emu.frameadvance() end
		-- (a standing point isn't somewhere Link stays: the pushes of the
		-- first game frame from it are the test, and have already run)
		if yaw then r.start = readVec(K.player + K.pos) end
		-- Just enough speed to reach `next` (Actor_UpdatePos moves 1.5x speed; 3DS 1x).
		local speed = t.speed or dist / SPEED_RATE
		if yaw then
			write_s16(K.player + K.yaw, yaw)
			write_s16(K.player + K.shapeRotY, yaw)
		end
		writefloat(K.player + K.speedXZ, speed)
		r.yaw, r.speed = yaw, speed
		-- Falling tests (kind "low..."): `next` is `drop` below the floor, not the
		-- usual GROUND_DROP, so give him the y velocity that gets there. Written
		-- where the last frame's floor check left it (-4 standing), before the
		-- frame's gravity (-1) and Actor_UpdatePos (x1.5): velocity.y ends up
		-- -drop / 1.5 (at most -20, the terminal velocity, for the 30 drop;
		-- 3DS x1.0: -drop, at most the 20 drop).
		local drop = t.prev[2] - t.next[2]
		if t.vy then
			-- ground clips: the scan's velocity.y for the frame, before gravity
			r.velY = t.vy + 1
			writefloat(K.player + K.velocity + 4, r.velY)
		elseif t.kind:find("^low") or drop > GROUND_DROP + 0.01 then
			r.velY = -drop / SPEED_RATE + 1
			writefloat(K.player + K.velocity + 4, r.velY)
		end
		r.log = {}
		local frames0 = read_u32(K.play + K.gameplayFrames)
		-- Link's state too: what he's doing (actionFunc, stateFlags1), whether
		-- his animation moves him itself (skelAnime.movementFlags) and whether
		-- he's riding something
		local function logLine(tag)
			if IS_3DS then
				r.log[#r.log + 1] = string.format(
					"%s gf+%d pos %s speedXZ %.3f speed %.3f velY %.3f yaw %04X wall %s floor %s%s",
					tag, read_u32(K.play + K.gameplayFrames) - frames0, fmt(readVec(K.player + K.pos)),
					readfloat(K.player + K.speedXZ), readfloat(K.player + K.actorSpeed), readfloat(K.player + K.velocity + 4),
					read_u16(K.player + K.yaw),
					polyName(read_u32(K.player + K.wallPoly), K.wallBgId and mainmemory.read_u8(K.player + K.wallBgId)),
					polyName(read_u32(K.player + K.floorPoly), K.wallBgId and mainmemory.read_u8(K.player + K.wallBgId + 1)),
					K.bgCheckFlags and string.format(" bgFlags %04X", read_u16(K.player + K.bgCheckFlags)) or "")
				return
			end
			r.log[#r.log + 1] = string.format(
				"%s gf+%d pos %s speedXZ %.3f speed %.3f velY %.3f yaw %04X action %08X flags1 %08X animMove %02X ride %08X wall %s floor %s bgFlags %04X",
				tag, read_u32(K.play + K.gameplayFrames) - frames0, fmt(readVec(K.player + K.pos)),
				readfloat(K.player + K.speedXZ), readfloat(K.player + K.actorSpeed), readfloat(K.player + K.velocity + 4),
				read_u16(K.player + K.yaw),
				read_u32(K.player + K.actionFunc), read_u32(K.player + K.stateFlags1),
				mainmemory.read_u8(K.player + K.skelAnime + 0x35), read_u32(K.player + K.rideActor),
				polyName(read_u32(K.player + K.wallPoly), mainmemory.read_u8(K.player + K.wallBgId)),
				polyName(read_u32(K.player + K.floorPoly), mainmemory.read_u8(K.player + K.wallBgId + 1)), read_u16(K.player + K.bgCheckFlags))
		end
		r.logLine = logLine
		logLine("write")
		for i = 1, 9 do
			emu.frameadvance()
			logLine("+" .. i)
			if read_u32(K.play + K.gameplayFrames) ~= frames0 then break end
		end
		if read_u32(K.play + K.gameplayFrames) == frames0 then
			r.status = "stuck"
			return r
		end
		-- (the game frame ran in that emulated frame: `after` is right after it)
		r.after = readVec(K.player + K.pos)
		-- Slope clips with a second frame: its speed (the same yaw), written
		-- now, before the next game frame, the same way as the first; `after`
		-- is then after that frame (after the first, the wall is still
		-- about to push him back out).
		if t.speed2 then
			if yaw then
				write_s16(K.player + K.yaw, yaw)
				write_s16(K.player + K.shapeRotY, yaw)
			end
			writefloat(K.player + K.speedXZ, t.speed2)
			logLine("write speed2")
			local frames1 = read_u32(K.play + K.gameplayFrames)
			for i = 1, 9 do
				emu.frameadvance()
				logLine("2nd +" .. i)
				if read_u32(K.play + K.gameplayFrames) ~= frames1 then break end
			end
			r.after = readVec(K.player + K.pos)
		end
		for _ = 1, EMU_PER_GAME do emu.frameadvance() end
		local later = readVec(K.player + K.pos)
		logLine("+1 game frame")
		-- Given speed but didn't move at all in two game frames: Link's state
		-- ignores speedXZ (riding Epona, or an animation that moves him itself
		-- - ANIM_FLAG_OVERRIDE_MOVEMENT). The savestate needs him standing
		-- still on foot.
		if yaw and r.start and dist3(later, r.start) < 0.01 then
			r.status = "no move"
			r.log[#r.log + 1] = "Link didn't move with speedXZ set: use a savestate with him standing still on foot"
			return r
		end
	else
		pending = t
		fired = false
		local waited = 0
		while not fired and waited < HOOK_TIMEOUT do
			emu.frameadvance()
			waited = waited + 1
		end
		if not fired then
			pending = nil
			r.status = "hook"
			return r
		end
	end
	if mode ~= "move" then
		-- the rest of that game frame
		for _ = 1, 3 do emu.frameadvance() end
		r.after = readVec(K.player + K.pos)
	end
	-- (move mode: the log goes on through the first game frames after, where
	-- a clip that doesn't hold gets pushed back out)
	local gf = read_u32(K.play + K.gameplayFrames)
	for i = 1, SETTLE_FRAMES do
		emu.frameadvance()
		if r.logLine and i <= 18 and read_u32(K.play + K.gameplayFrames) ~= gf then
			gf = read_u32(K.play + K.gameplayFrames)
			r.logLine("settle")
		end
	end
	r.logLine = nil
	r.final = readVec(K.player + K.pos)
	-- (recording: let the end show before the next test resets everything)
	if RECORD then for _ = 1, RECORD_BUFFER do emu.frameadvance() end end
	-- The test frame has to have started from `prev`: the frame's movement,
	-- line check and pushes move Link a few tens of units at most.
	local moveDist = math.sqrt((t.next[1] - t.prev[1]) ^ 2 + (t.next[3] - t.prev[3]) ^ 2)
	if (r.start and dist3(r.start, t.prev) > 1) or
		math.sqrt((r.after[1] - t.prev[1]) ^ 2 + (r.after[3] - t.prev[3]) ^ 2) > moveDist + 60 then
		r.status = "setup"
		-- (where he actually was when the move started: not standing still
		-- at `prev` means the viewer's resting spot is off)
		if r.start then
			r.log = r.log or {}
			table.insert(r.log, 1, "start (should be prev) " .. fmt(r.start))
		end
		return r
	end
	r.status = judge(t, r.after, r.final)
	return r
end

-- Pick the mode on the first test: a hook that never catches Link's bg check
-- falls through to the next one.
-- (CSV_TESTS: always "move" - the game works out the move from exactly
-- that start, yaw and speed, which is what the grid is about)
-- (OoT3D / MM3D: always "move" - no function addresses to hook)
local mode = (T.csvGrids or IS_3DS) and "move" or MODE
local first
-- (the mode is tried on the first test that isn't a slope or ground clip or
-- an action clip: those don't use the hooks, so they'd pass any; all of them: "move")
local probe = 1
while queue[probe] and (queue[probe].kind == "slope" or queue[probe].kind == "ground" or queue[probe].action) do probe = probe + 1 end
if not queue[probe] then
	probe = 1
	-- (only action tests: they run their own way)
	local allAction = true
	for _, t in ipairs(queue) do if not t.action then allAction = false end end
	mode = allAction and "action" or "move"
end
if mode == "auto" then
	for _, m in ipairs({ "exec", "read", "move" }) do
		if (m == "exec" and not a1Reg) or (m == "read" and not pcReg) then
			print("  " .. m .. ": skipped (register not found)")
		else
			hook(m)
			first = runTest(queue[probe], m)
			if first.status ~= "hook" then
				mode = m
				break
			end
			print(string.format("  %s: callback ran %d times, never for Link's bg check%s", m, calls,
				#seenActors > 0 and (" (seen: " .. table.concat(seenActors, ", ") .. ")") or ""))
		end
	end
	unhook()
	if mode ~= "move" then hook(mode) end
else
	hook(mode)
	first = runTest(queue[probe], mode)
	if first.status == "hook" then
		cleanUp()
		error(string.format("the %s hook never caught Link's bg check (callback ran %d times)", mode, calls))
	end
end
print("Mode: " .. mode)

local results = {}
local pairDone = {}  -- recording: wall pairs (pusher:crossed) that already have a clip on video
local skipped = 0
for i, t in ipairs(queue) do
	local pairKey = t.pusher .. ":" .. t.crossed
	-- (not the CSV cells: they're all the one wall pair)
	if RECORD and RECORD_ONE_PER_PAIR and pairDone[pairKey] and not t.csv then
		skipped = skipped + 1
	else
		local r = i == probe and first or runTest(t, mode)
		results[#results + 1] = r
		if t.csv then
			-- (Link pushed off the start before the move frame: that start isn't
			-- one he can stand at, which the summary counts as No - said here too)
			local drift = r.start and math.sqrt((r.start[1] - t.prev[1]) ^ 2 + (r.start[3] - t.prev[3]) ^ 2) or 0
			local status = drift > CSV_DRIFT and string.format("No (pushed %.6f off the start first)", drift) or r.status
			print(string.format("  %d / %d: %s x %s z %s speed %s (expect %s): %s", i, #queue, t.kind,
				t.csv.header[t.xi], t.csv.rows[t.zi].label, t.speed, t.expectClip and "Yes" or "No", status))
		else
			print(string.format("  %d / %d: %s%s %s TRI %d -> %d: %s", i, #queue, t.action and (t.action .. ", ") or "", t.kind, t.type, t.pusher, t.crossed, r.status))
			-- the test's move: where Link starts, angle, speedXZ and the frame's y
			-- velocity (after gravity: ground clips' vy, else from the drop)
			local yaw, speed = r.yaw or t.yaw, r.speed or t.speed
			local vy = t.vy or (t.next[2] - t.prev[2]) / SPEED_RATE
			if t.action then
				print(string.format("      start %s  facing 0x%04X  %s", fmt(t.prev), t.facing, t.action))
			else
			print(string.format("      start %s  angle %s  linear %s  y vel %.9g", fmt(t.prev),
				yaw and string.format("0x%04X", yaw % 0x10000) or "-", speed and string.format("%.9g", speed) or "-", vy))
			end
		end
		if worked(r.status) then pairDone[pairKey] = true end
	end
end
if skipped > 0 then
	print(string.format("  (recording: skipped %d tests of wall pairs that had already clipped)", skipped))
end

cleanUp()

---------------------------------------------------------------------------
-- Summary
---------------------------------------------------------------------------

local out = {}
local function line(s) out[#out + 1] = s end

line(string.format("Wall push clip test results: %s, %s, %s (mode: %s)", GAME, T.map, runForm, mode))
line(string.format("%d tests; worked = Link ended up behind the clipped wall (clipped), fell out of the map (fell),", #results))
line("was moved far away (voided), or went off past the wall's edge without coming back in front of it (away:")
line("check those by eye), " .. SETTLE_FRAMES .. " frames after the test frame.")
line("")

local byGroup = {}
for _, r in ipairs(results) do
	local g = r.test.group
	byGroup[g] = byGroup[g] or { worked = 0, tried = 0, hits = {}, statuses = {} }
	local b = byGroup[g]
	b.tried = b.tried + 1
	b.statuses[r.status] = (b.statuses[r.status] or 0) + 1
	if worked(r.status) then
		b.worked = b.worked + 1
		b.hits[#b.hits + 1] = r
	end
end

-- How Link got there: where he stood, the yaw he faced and the speedXZ given.
-- Move mode: what was actually used (the start read back from RAM). Hook modes
-- write the frame's positions straight into the bg check, so it's the export's
-- start, yaw and speed (the move the viewer found).
local function setupStr(r)
	local t = r.test
	if t.action then
		local key = (t.actionKey:gsub("%-walkin$", ""))
		local run = key ~= t.actionKey and string.format("run in %d frames, then ", WALKIN_RUN) or ""
		local ls = key:find("%-ls$") ~= nil
		key = (key:gsub("%-ls$", ""))
		if ls then run = run .. "lunge stored, " end
		if key:find("^%w+%-spin%-") and not key:find("^deku") then
			return string.format("start %s  facing 0x%04X  %s (%sB held: slash then charge, B let go%s)", fmt(r.start or t.prev), t.facing, t.action,
				key:find("spin%-lock") and "Z locked on to an enemy, " or "", key:find("%-fwd") and " with the stick forward" or "")
		end
		if key:find("^deku%-spin") then
			return string.format("start %s  facing 0x%04X  %s%s", fmt(r.start or t.prev), t.facing, t.action,
				t.stopAfter and string.format(" (stick let go after frame %d)", t.stopAfter) or "")
		end
		if key:find("^zora%-clip") or key:find("^zora%-jumpslash") then
			return string.format("start %s  facing 0x%04X  %s (%sfins out, %sZ + A, %s)", fmt(r.start or t.prev), t.facing, t.action, run,
				key:find("^zora%-clip") and "B held (aiming) from before to the end, " or "",
				key:find("%-fwd$") and string.format("Z and the stick forward for %d frames in the air", t.airFrames or 0) or "stick left alone")
		end
		if key:find("jumpslash") then
			return string.format("start %s  facing 0x%04X  %s (%sZ + A, %s, R held from then on)", fmt(r.start or t.prev), t.facing, t.action, run,
				key:find("%-fwd$") and string.format("Z and the stick forward for %d frames in the air", t.airFrames or 0) or "stick left alone")
		end
		return string.format("start %s  facing 0x%04X  %s (%sB, stick forward%s)", fmt(r.start or t.prev), t.facing, t.action, run,
			key:find("stab") and ", Z held" or "")
	end
	local yaw, speed = r.yaw or t.yaw, r.speed or t.speed
	if not yaw then
		local dx, dz = t.next[1] - t.prev[1], t.next[3] - t.prev[3]
		if dx * dx + dz * dz >= 0.0001 then
			yaw = yawTo(dx, dz)
			speed = speed or math.sqrt(dx * dx + dz * dz) / SPEED_RATE
		end
	end
	return string.format("start %s  angle %s  speedXZ %s%s", fmt(r.start or t.prev),
		yaw and string.format("0x%04X", yaw % 0x10000) or "-", speed and string.format("%.9g", speed) or "-",
		t.speed2 and string.format(" then %.9g", t.speed2) or "")
end

-- CSV_TESTS: per grid, how many cells came out as the CSV says, each
-- mismatch, and the grid as it went in game (<CSV>_ingame.csv): Yes / No,
-- "Yes (expected No)" / "No (expected Yes)" where it differs, "?" + the
-- status where the test didn't run properly, "-" where not tried (border).
-- "setup", or Link pushed off the cell's start before the move frame (by more
-- than CSV_DRIFT: that exact start isn't somewhere he can stand) are No, even
-- if he then clips from where the push left him: the clip can't be done from
-- there. The list of mismatches says when that's why.
local function csvDrift(r)
	if not r.start then return 0 end
	return math.sqrt((r.start[1] - r.test.prev[1]) ^ 2 + (r.start[3] - r.test.prev[3]) ^ 2)
end
local function csvResult(r)
	if csvDrift(r) > CSV_DRIFT then return false, "moved" end
	if worked(r.status) then return true end
	if r.status == "no" or r.status == "setup" then return false end
	return nil
end
if T.csvGrids then
	local byTest = {}
	for _, r in ipairs(results) do byTest[r.test] = r end
	local allMatched, allTried = 0, 0
	for _, g in ipairs(T.csvGrids) do
		local matched, tried, moved, bad = 0, 0, 0, {}
		local rowsOut = { table.concat(g.header, ",") }
		for zi = 2, #g.rows + 1 do
			local row = g.rows[zi]
			if row then
				local cells = { row.label }
				for xi = 2, #g.header do
					local t = row.cells[xi]
					local r = t and byTest[t]
					local v = "-"
					if r then
						local got, why = csvResult(r)
						tried = tried + 1
						if why == "moved" then moved = moved + 1 end
						if got == nil then
							v = "? " .. r.status
							bad[#bad + 1] = string.format("    x %s z %s: expected %s, test %s", g.header[xi], row.label, t.expectClip and "Yes" or "No", r.status)
						elseif got == t.expectClip then
							v = got and "Yes" or "No"
							matched = matched + 1
						else
							v = string.format("%s (expected %s)", got and "Yes" or "No", t.expectClip and "Yes" or "No")
							if why == "moved" then
								bad[#bad + 1] = string.format("    x %s z %s: expected %s, got No: the game pushed Link %.6f off the start (to %s) before the move",
									g.header[xi], row.label, t.expectClip and "Yes" or "No", csvDrift(r), fmt(r.start))
							else
								bad[#bad + 1] = string.format("    x %s z %s speed %s: expected %s, got %s (%s)  start read back %s, after %s, final %s",
									g.header[xi], row.label, t.speed, t.expectClip and "Yes" or "No", got and "Yes" or "No", r.status,
									fmt(r.start), fmt(r.after), fmt(r.final))
							end
						end
					end
					cells[#cells + 1] = v
				end
				rowsOut[#rowsOut + 1] = table.concat(cells, ",")
			end
		end
		allMatched, allTried = allMatched + matched, allTried + tried
		local outPath = g.name .. "_ingame.csv"
		local f = io.open(outPath, "w")
		if f then f:write(table.concat(rowsOut, "\n"), "\n"); f:close() end
		line(string.format("CSV 0x%04X (%s): %d of %d cells as the CSV says%s%s", g.yaw, g.name .. ".csv", matched, tried,
			moved > 0 and string.format(" (%d No where the game pushed Link off the start)", moved) or "",
			f and ("; in game: " .. outPath) or ("; couldn't write " .. outPath)))
		for _, b in ipairs(bad) do line(b) end
	end
	line("")
	line(string.format("%d of %d cells as the CSVs say", allMatched, allTried))
else
	local totalWorked, groupsWorked = 0, 0
	line("WORKED")
	for _, gi in ipairs(order) do
		local b = byGroup[gi]
		if b and b.worked > 0 then
			local t = groups[gi].first
			groupsWorked = groupsWorked + 1
			totalWorked = totalWorked + b.worked
			line(string.format("  %s%s %s: TRI %d through TRI %d - %d of %d tried (%d points in the group)",
				t.action and (t.action .. ", ") or "", t.kind, t.type, t.pusher, t.crossed, b.worked, b.tried, #groups[gi].tests))
			for _, r in ipairs(b.hits) do
				line(string.format("    [%s] prev %s -> next %s  => after %s, final %s",
					r.status, fmt(r.test.prev), fmt(r.test.next), fmt(r.after), fmt(r.final)))
				line("        " .. setupStr(r))
			end
			-- and the ones in the group that didn't
			for _, r in ipairs(results) do
				if r.test.group == gi and r.after and not worked(r.status) then
					line(string.format("    [%s] prev %s -> next %s  => after %s, final %s (expected %s)",
						r.status, fmt(r.test.prev), fmt(r.test.next), fmt(r.after), fmt(r.final), fmt(r.test.expect)))
					for _, l in ipairs(r.log or {}) do line("        " .. l) end
				end
			end
		end
	end
	if groupsWorked == 0 then line("  (none)") end
	line("")

	line("DIDN'T WORK")
	for _, gi in ipairs(order) do
		local b = byGroup[gi]
		if b and b.worked == 0 then
			local t = groups[gi].first
			local st = {}
			for k, v in pairs(b.statuses) do st[#st + 1] = k .. " " .. v end
			line(string.format("  %s%s %s: TRI %d through TRI %d - 0 of %d (%s)",
				t.action and (t.action .. ", ") or "", t.kind, t.type, t.pusher, t.crossed, b.tried, table.concat(st, ", ")))
			for _, r in ipairs(results) do
				if r.test.group == gi and r.after then
					line(string.format("    [%s] prev %s -> next %s  => after %s, final %s (expected %s)",
						r.status, fmt(r.test.prev), fmt(r.test.next), fmt(r.after), fmt(r.final), fmt(r.test.expect)))
					if r.test.action then line("        " .. setupStr(r)) end
					for _, l in ipairs(r.log or {}) do line("        " .. l) end
				end
			end
		end
	end
	-- (recording: groups never run because their wall pair had already clipped)
	local skippedGroups = {}
	for _, gi in ipairs(order) do
		if not byGroup[gi] then
			local t = groups[gi].first
			skippedGroups[#skippedGroups + 1] = string.format("  %s %s: TRI %d through TRI %d - skipped (the pair already clipped)",
				t.kind, t.type, t.pusher, t.crossed)
		end
	end
	if #skippedGroups > 0 then
		line("")
		line("SKIPPED")
		for _, l in ipairs(skippedGroups) do line(l) end
	end
	line("")
	-- Wall pairs (pushing wall, clipped wall), not groups: a pair can have both
	-- standing and crossing points.
	local pairsAll, pairsWorked, nAll, nWorked = {}, {}, 0, 0
	for _, gi in ipairs(order) do
		local t = groups[gi].first
		local k = t.pusher .. ":" .. t.crossed
		if not pairsAll[k] then pairsAll[k] = true; nAll = nAll + 1 end
		local b = byGroup[gi]
		if b and b.worked > 0 and not pairsWorked[k] then pairsWorked[k] = true; nWorked = nWorked + 1 end
	end
	line(string.format("%d of %d wall pairs had a point that worked (%d points)", nWorked, nAll, totalWorked))
end

local text = table.concat(out, "\n")
print(text)
local f = io.open(resultsPath, "w")
if f then
	f:write(text, "\n")
	f:close()
	print("Written to " .. resultsPath)
else
	print("Couldn't write " .. resultsPath)
end
