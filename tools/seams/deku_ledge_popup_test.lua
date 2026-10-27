-- Deku ledge-grab popup test (BizHawk, MM US, N64 core)
--
-- In-game check of scan_ledge_popup.py's Stock Pot Inn hits: Deku Link grabs a
-- bed-rail face next to a bed post, the grab puts him at the post top's height
-- (y 254, 24 above the rail top), and the post top's 1-unit floor tolerance
-- should keep him GROUNDED on the next frame instead of popping up into a fall.
--
-- Setup: savestate with Deku Link standing still on foot in the Stock Pot Inn
-- (any room; don't hold the stick, no Z). Load this script: it sweeps every
-- target below, reloading the savestate for each try, and prints one line a
-- try plus a summary (also written to deku_ledge_popup_log.txt).
--
-- Each try puts Link IN THE AIR at y 215.5 with velocity.y 0 (ground flag
-- cleared), facing the rail, speedXZ 1.0, stick neutral. MM moves actors x1.5
-- a frame: y 214 (Player_Action_25 starts, the landing anim), then y 211 -
-- the first frame the grab is checked (z_player.c:15222). How Link would get
-- there in a real run is a separate question: this only tests the grab.
--
-- Verdicts:
--   GROUNDED   grabbed (hang flag / Player_Action_48), ground flag set on the
--              next frame and still hanging: the post-top tolerance caught him
--   POPUP      grabbed, not grounded next frame (falls: Player_Action_25)
--   no grab    never grabbed (log shows wall flag / wall poly to see why)

local TARGETS = {
	-- grab window ends at y 211 (Link 14 from the wall face), wall normal, facing
	{ wall = 505, ledge = 514, a = { -531.315, -89.380 }, b = { -525.721, -89.114 }, n = { 0.04758, -0.99887 }, yaw = 0xFE10 },
	{ wall = 1107, ledge = 1116, a = { -551.612, 530.853 }, b = { -552.375, 530.287 }, n = { -0.59585, 0.80310 }, yaw = 0x65FE },
	{ wall = 1111, ledge = 1116, a = { -521.450, 488.482 }, b = { -520.688, 489.048 }, n = { 0.59585, -0.80310 }, yaw = 0xE5FE },
	{ wall = 1125, ledge = 1122, a = { -560.725, 562.891 }, b = { -559.782, 562.773 }, n = { -0.12403, -0.99228 }, yaw = 0x0511 },
}
local ONLY_WALL = nil          -- e.g. 505 to test one target
local LATERAL_MARGIN = 1.0     -- also try this far past each end of the window
local LATERAL_STEP = 0.25
local END_DISTS = { 12.5, 13.0, 13.5, 14.0 }  -- distance from the wall face on the grab frame
local START_Y = 215.5
local SPEED = 1.0              -- written once; Deku's air decel is 0.1 a frame (stick neutral)
local GAME_FRAMES = 6          -- game frames logged a try
local VERBOSE = false          -- print every try's per-frame log, not just the grabs

-- MM US (N64)
local HASH_MM = 'D6133ACE5AFAA0882CF214CF88DABA39E266C078'
if gameinfo.getromhash() ~= HASH_MM then error("deku_ledge_popup_test: needs MM US (N64)") end
local EMU_PER_GAME = 3
local PLAY = 0x3E6B20
local GAMEPLAY_FRAMES = 0x18840
local COLCTX = PLAY + 0x830
local PLAYER = 0x3FFDB0
local O = {
	home = 0x08, pos = 0x24, rotY = 0x32, velocity = 0x64, actorSpeed = 0x70,
	wallPoly = 0x7C, floorPoly = 0x80, wallBgId = 0x84, bgCheckFlags = 0x90,
	shapeRotY = 0xBE, prevPos = 0x108, transformation = 0x14B,
	actionFunc = 0x748, stateFlags1 = 0xA6C, speedXZ = 0xAD0, yaw = 0xAD4,
}
-- gKaleidoMgrOverlayTable[KALEIDO_OVL_PLAYER_ACTOR] (0x801963E0 + 0x1C):
-- loadedRamAddr at +0x00, vramStart at +0x0C
local PLAYER_OVL = 0x1963E0 + 0x1C
local ACTIONS = {
	[0x80847F58] = "Action_25(fall)", [0x80830DD4] = "Action_48(hang)", [0x808484D8] = "Action_49(climb)",
	[0x808442B0] = "Idle", [0x80833E64] = "Action_21(knockback)", [0x80834B58] = "Action_20(damage)",
}
local GROUND, WALL = 0x1, 0x8
local STATE1_HANG = 0x2000

local function u32(a) return mainmemory.read_u32_be(a) end
local function rf(a) return mainmemory.readfloat(a, true) end
local function wf(a, v) mainmemory.writefloat(a, v, true) end
local function bit(x, b) return math.floor(x / b) % 2 == 1 end
local function phys(p) return p % 0x80000000 end
local function frames() return u32(PLAY + GAMEPLAY_FRAMES) end

local function actionName()
	local f = u32(PLAYER + O.actionFunc)
	local vram = (f - u32(PLAYER_OVL) + u32(PLAYER_OVL + 0x0C)) % 0x100000000
	return ACTIONS[vram] or string.format("%08X", vram)
end
local function polyId(ptr, bgId)
	if ptr == 0 then return "-" end
	if bgId ~= 50 then return "dyna" end
	local hdr = phys(u32(COLCTX))
	local list = u32(hdr + 0x18)
	local id = (ptr - list) / 0x10
	if id >= 0 and id == math.floor(id) then return string.format("%d", id) end
	return string.format("%08X", ptr)
end
local function writeVec(off, x, y, z)
	wf(PLAYER + off, x); wf(PLAYER + off + 4, y); wf(PLAYER + off + 8, z)
end

-- one game frame's state, right after it ran
local function snap()
	local bg = mainmemory.read_u16_be(PLAYER + O.bgCheckFlags)
	return {
		x = rf(PLAYER + O.pos), y = rf(PLAYER + O.pos + 4), z = rf(PLAYER + O.pos + 8),
		vy = rf(PLAYER + O.velocity + 4), speed = rf(PLAYER + O.speedXZ),
		action = actionName(), hang = bit(u32(PLAYER + O.stateFlags1), STATE1_HANG),
		ground = bit(bg, GROUND), wall = bit(bg, WALL),
		wallPoly = polyId(u32(PLAYER + O.wallPoly), mainmemory.read_u8(PLAYER + O.wallBgId)),
		floorPoly = polyId(u32(PLAYER + O.floorPoly), mainmemory.read_u8(PLAYER + O.wallBgId + 1)),
		floorY = rf(PLAYER + 0x88),
	}
end
local function fmtSnap(i, s)
	return string.format("    gf+%d pos (%.3f, %.3f, %.3f) velY %.2f speedXZ %.2f %s%s ground %s wall %s wallPoly %s floorPoly %s floorY %.2f",
		i, s.x, s.y, s.z, s.vy, s.speed, s.action, s.hang and " HANG" or "",
		s.ground and "Y" or "n", s.wall and "Y" or "n", s.wallPoly, s.floorPoly, s.floorY)
end

-- wait until a game frame has just run, then EMU_PER_GAME - 1 more emulated
-- frames: the next emulated frame runs the next game frame (as in
-- wall_clip_tester.lua's move mode)
local function syncToGameFrame()
	local f0 = frames()
	for _ = 1, 2 * EMU_PER_GAME do
		emu.frameadvance()
		if frames() ~= f0 then break end
	end
	for _ = 1, EMU_PER_GAME - 1 do emu.frameadvance() end
end
-- advance until the next game frame has run (false: stuck)
local function runGameFrame()
	local f0 = frames()
	for _ = 1, 3 * EMU_PER_GAME do
		emu.frameadvance()
		if frames() ~= f0 then return true end
	end
	return false
end

local DRIFT = 1.5 * SPEED + 1.5 * (SPEED - 0.1)  -- moved toward the wall before the grab frame's collision

local function try(t, frac, dEnd)
	-- point on the window line (14 from the face), then dEnd from the face, then
	-- back by the drift
	local px = t.a[1] + (t.b[1] - t.a[1]) * frac
	local pz = t.a[2] + (t.b[2] - t.a[2]) * frac
	px, pz = px + t.n[1] * (dEnd - 14), pz + t.n[2] * (dEnd - 14)
	local sx, sz = px + t.n[1] * DRIFT, pz + t.n[2] * DRIFT
	syncToGameFrame()
	writeVec(O.pos, sx, START_Y, sz)
	writeVec(O.prevPos, sx, START_Y, sz)
	writeVec(O.home, sx, START_Y, sz)
	wf(PLAYER + O.velocity + 4, 0)
	wf(PLAYER + O.speedXZ, SPEED)
	wf(PLAYER + O.actorSpeed, SPEED)
	local yaw = t.yaw >= 0x8000 and t.yaw - 0x10000 or t.yaw
	mainmemory.write_s16_be(PLAYER + O.yaw, yaw)
	mainmemory.write_s16_be(PLAYER + O.rotY, yaw)
	mainmemory.write_s16_be(PLAYER + O.shapeRotY, yaw)
	local bg = mainmemory.read_u16_be(PLAYER + O.bgCheckFlags)
	if bit(bg, GROUND) then mainmemory.write_u16_be(PLAYER + O.bgCheckFlags, bg - GROUND) end
	local log, grabAt = {}, nil
	for i = 1, GAME_FRAMES do
		if not runGameFrame() then log[#log + 1] = "    (stuck: no game frame ran)"; break end
		local s = snap()
		log[#log + 1] = fmtSnap(i, s)
		if not grabAt and (s.hang or s.action == "Action_48(hang)") then grabAt = { i = i, s = s } end
		if grabAt and i == grabAt.i + 1 then grabAt.next = s end
	end
	local verdict
	if not grabAt then
		verdict = "no grab"
	elseif not grabAt.next then
		verdict = "grab (no next frame logged)"
	elseif grabAt.next.ground and grabAt.next.action ~= "Action_25(fall)" then
		verdict = "GROUNDED"
	else
		verdict = "POPUP"
	end
	return verdict, log, sx, sz, grabAt
end

-- the log file goes next to BizHawk's working directory
local out = io.open("deku_ledge_popup_log.txt", "w")
local function say(s)
	print(s)
	if out then out:write(s, "\n") end
end

console.clear()
if mainmemory.read_u8(PLAYER + O.transformation) ~= 3 then error("deku_ledge_popup_test: be Deku Link (PLAYER_FORM_DEKU) in the savestate") end
local base = memorysavestate.savecorestate()
local totals = {}
for _, t in ipairs(TARGETS) do
	if not ONLY_WALL or ONLY_WALL == t.wall then
		local len = math.sqrt((t.b[1] - t.a[1]) ^ 2 + (t.b[2] - t.a[2]) ^ 2)
		if len < 0.01 then len = 0.01 end
		say(string.format("== wall %d (ledge %d): window %.2f long, facing 0x%04X", t.wall, t.ledge, len, t.yaw))
		local counts = {}
		local off = -LATERAL_MARGIN
		while off <= len + LATERAL_MARGIN + 1e-6 do
			for _, dEnd in ipairs(END_DISTS) do
				memorysavestate.loadcorestate(base)
				local verdict, log, sx, sz, grabAt = try(t, off / len, dEnd)
				counts[verdict] = (counts[verdict] or 0) + 1
				local extra = ""
				if grabAt then
					extra = string.format("  grab at gf+%d y %.2f%s", grabAt.i, grabAt.s.y,
						grabAt.next and string.format(", next frame y %.2f floorY %.2f floor poly %s", grabAt.next.y, grabAt.next.floorY, grabAt.next.floorPoly) or "")
				end
				say(string.format("  along %+.2f  d %.1f  start (%.3f, %.1f, %.3f): %s%s", off, dEnd, sx, START_Y, sz, verdict, extra))
				if VERBOSE or grabAt then
					for _, l in ipairs(log) do say(l) end
				end
			end
			off = off + LATERAL_STEP
		end
		local parts = {}
		for k, v in pairs(counts) do parts[#parts + 1] = k .. " " .. v end
		say("  -> " .. table.concat(parts, ", "))
		totals[t.wall] = counts
	end
end
memorysavestate.loadcorestate(base)
memorysavestate.removestate(base)
say("done (savestate restored)")
if out then out:close() end
