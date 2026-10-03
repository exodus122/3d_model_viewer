-- MM3D action recorder (BizHawk 3DS core, MM3D US, decrypted): does an action
-- (a sword lunge or a Deku spin) from a standing start and records Link's
-- movement every game frame, for clipfinder --game MM3D --type actions.
-- There's no MM3D decomp, so clipfinder can't work these out from the code
-- the way it does the N64 ones; this measures them instead.
--
-- Use: load MM3D, stand Link on FLAT, OPEN ground (nothing within ~200 of
-- him: a wall touched changes the move), idle, in the form the action is for
-- (Human for the lunges, with the weapon for it: 1h the Kokiri Sword, 2h the
-- Great Fairy's Sword on B, stick a Deku Stick on B; Deku for the spins).
-- Run this script, pick the action and press Record. It saves a savestate,
-- does the action, writes the result and loads the savestate back, so
-- Record can be pressed again (each take replaces the last for that action).
-- "Record all" does every action of Link's form, one after another.
--
-- What it writes, in tools\clipfinder\tools\mm3d_actions\ (next to this script):
--   <key>.json      the rows clipfinder reads (see below)
--   <key>_log.txt   every emulated frame's raw values, for checking
--
-- Each game frame's move is split as the game does it: Player_UpdateCommon
-- sets prevPos = home.pos at the start of the frame, moves Link by speedXZ
-- along Player.yaw and runs the bg check (prevPos -> world.pos), sets home.pos
-- = world.pos at the end, and the animation's root motion is added to
-- world.pos after that. So at the end of frame k:
--   root   = pos(k) - home(k)        added after frame k's bg check, swept by frame k+1's
--   speed  = home(k+1) - pos(k)      frame k+1's speedXZ move (open ground: unobstructed)
-- Row k+1 = { root of frame k (in Link's frame: rx sideways, rz forward, as
-- the N64 tables' root x / z), speed, the move's angle from his facing }.
-- If MM3D adds the root motion before the bg check instead, root is 0 and
-- the whole move shows up as the speed part: clipfinder sweeps it the same.
--
-- Inputs (the user's way of doing them in the N64 tester):
--   slashes (1h-slash, 2h-slash, stick-slash): L tapped for the camera
--     behind him, let go, then B + the stick forward on the same frame
--   stabs (1h-stab, 2h-stab): L held (targeting nothing), B + stick forward
--   deku-spin: the stick forward held; when speedXZ stops rising, A; the stick
--     held until the spin ends (Link's shape stops turning)
--   deku-spin-backwalk: L held + the stick back; when speedXZ stops rising, L
--     let go for BACKWALK_ZOFF game frames (the stick still back), then A, the
--     stick back held through the spin
--
-- Lua 5.1 syntax (BizHawk's): no bitwise operators, no goto.

---------------------------------------------------------------------------
-- Settings
---------------------------------------------------------------------------

local STICK_MAX = 127        -- the Circle Pad at full tilt (the axis range is taken as -128..127)
local STICK_UP = nil         -- +1 / -1: the sign of "up" on Circle Pad Y; nil = find it (calibrate)
local PRESS_EMU = 3          -- emulated frames B / A is held for a press
-- The lunges: the stick has to be forward when the attack starts, and the
-- game can read it a frame late - a take without the lunge (speedXZ never
-- above LUNGE_SPEED) is tried again with the stick pushed that many more
-- emulated frames before B (each of STICK_LEADS in turn). A lead of a game
-- frame or more can start him walking first: those rows are kept (printed).
local STICK_LEADS = { 0, 1, 2, 3, 4, 6 }
local STICK_AFTER = 4        -- emulated frames the stick stays forward after B is let go
local LUNGE_SPEED = 7        -- speedXZ above this: the lunge happened (MM3D's first is 8.33; running is at most ~6)
local BACKWALK_ZOFF = 1      -- game frames L is let go before A in the backwalk spin
local STILL_END = 12         -- game frames standing still that end a take
local MAX_TAKE = 150         -- game frames a take may run at most
local SPIN_MAX = 60          -- game frames after A before the spin is taken as over regardless

---------------------------------------------------------------------------
-- Addresses (MM3D US; as wall_clip_tester.lua / mm3d_watch.lua)
---------------------------------------------------------------------------

local PTR_OFFSET = 0x24EE000
local function deref(ptrAddr)
	local p = mainmemory.read_u32_le(ptrAddr)
	if p == 0 then return nil end
	if p >= PTR_OFFSET then p = p - PTR_OFFSET end
	return p
end
local PLAYER_PTR, PLAY_PTR = 0x0752FD6C, 0x0754D890
local K = {
	home = 0x08, pos = 0x24, velY = 0x68, shapeRotY = 0xC2,
	speedXZ = 0x11E30, yaw = 0x11E34,  -- Player speedXZ ("Linear Velocity") and Player.yaw after it
	frames = 0x138,                     -- play + this: one a game frame
	form = 0x0765B1FE,                  -- save.playerForm (s16): 3 Deku, 4 Human
	bItem = 0x0765B1B0 + 0x17A,         -- the B button item (u8)
}
local EMU_PER_GAME = 2

local ACTIONS = {
	{ key = "1h-slash", form = 4, kind = "slash", name = "lunge 1h slash" },
	{ key = "1h-stab", form = 4, kind = "stab", name = "lunge 1h stab" },
	{ key = "2h-slash", form = 4, kind = "slash", name = "lunge 2h slash" },
	{ key = "2h-stab", form = 4, kind = "stab", name = "lunge 2h stab" },
	{ key = "stick-slash", form = 4, kind = "slash", name = "lunge Deku stick slash" },
	{ key = "deku-spin", form = 3, kind = "spin", name = "Deku spin (run up, A)" },
	{ key = "deku-spin-backwalk", form = 3, kind = "backspin", name = "Deku spin from a backwalk (L + back, L off, A)" },
}
local FORM_NAMES = { [0] = "Fierce Deity", "Goron", "Zora", "Deku", "Human" }

---------------------------------------------------------------------------
-- Memory
---------------------------------------------------------------------------

local function rf(a) return mainmemory.readfloat(a, false) end
local function u16(a) return mainmemory.read_u16_le(a) end

-- Everything for one emulated frame (nil: no player / play)
local function sample()
	local pl, play = deref(PLAYER_PTR), deref(PLAY_PTR)
	if not pl or not play then return nil end
	return {
		frame = mainmemory.read_u32_le(play + K.frames),
		hx = rf(pl + K.home), hy = rf(pl + K.home + 4), hz = rf(pl + K.home + 8),
		px = rf(pl + K.pos), py = rf(pl + K.pos + 4), pz = rf(pl + K.pos + 8),
		vy = rf(pl + K.velY), speed = rf(pl + K.speedXZ),
		yaw = u16(pl + K.yaw), shape = u16(pl + K.shapeRotY),
	}
end

local function same(a, b)
	return a.hx == b.hx and a.hy == b.hy and a.hz == b.hz and a.px == b.px and a.py == b.py and a.pz == b.pz
		and a.speed == b.speed and a.yaw == b.yaw and a.shape == b.shape
end
local function still(a, b) return a.hx == b.hx and a.hz == b.hz and a.px == b.px and a.pz == b.pz and a.speed == 0 end

local function s16(v) v = v % 65536; if v >= 32768 then v = v - 65536 end; return v end
local function yawTo(dx, dz)
	-- (BizHawk's math.atan ignores a second argument: atan2 by hand)
	local a
	if dz > 0 then a = math.atan(dx / dz)
	elseif dz < 0 then a = math.atan(dx / dz) + (dx >= 0 and math.pi or -math.pi)
	else a = dx > 0 and math.pi / 2 or (dx < 0 and -math.pi / 2 or 0) end
	return math.floor(a / (2 * math.pi) * 65536 + 0.5) % 65536
end

---------------------------------------------------------------------------
-- Inputs (set every emulated frame; the stick cleared with "" - a number
-- left there stays after the script ends)
---------------------------------------------------------------------------

local held = {}       -- buttons held this frame
local stickY = nil    -- the Circle Pad's Y this frame (nil: let go)
local function applyInputs()
	local b = {}
	for k, v in pairs(held) do if v then b[k] = true end end
	if next(b) then joypad.set(b) end
	if stickY then joypad.setanalog({ ["Circle Pad X"] = 0, ["Circle Pad Y"] = stickY })
	else joypad.setanalog({ ["Circle Pad X"] = "", ["Circle Pad Y"] = "" }) end
end
local function releaseAll() held = {}; stickY = nil; applyInputs() end

---------------------------------------------------------------------------
-- Frames: the routine runs in a coroutine, one resume an emulated frame.
-- Every emulated frame's sample goes to `log`; game frames (the frame
-- counter going up) to `game`, each the last sample with that count - the
-- state after that frame's update.
---------------------------------------------------------------------------

local log, game, lastFrame = {}, {}, nil
local recording = false
local function emuFrame()
	coroutine.yield()
	local s = sample()
	if not s then return end
	if recording then
		log[#log + 1] = s
		if lastFrame and s.frame ~= lastFrame and #log >= 2 then
			-- (the last sample of the previous count is that frame's end state)
			game[#game + 1] = log[#log - 1]
		end
	end
	lastFrame = s.frame
end
-- one game frame on (the frame counter moves)
local function gameFrame()
	local f = lastFrame
	for _ = 1, 8 do
		emuFrame()
		if lastFrame ~= f then return end
	end
end
local function gameFrames(n) for _ = 1, n do gameFrame() end end
local function now() return sample() end

---------------------------------------------------------------------------
-- A take
---------------------------------------------------------------------------

local scriptDir = (debug.getinfo(1, "S").source:match("^@?(.*[/\\])")) or ""
local outDir = scriptDir .. "mm3d_actions\\"

local status = function(t) print(t) end

-- The stick's "up" sign: from standing, camera behind (L tapped), the stick
-- held one way: forward if he keeps his facing and moves along it
local function calibrate()
	local start = now()
	stickY = STICK_MAX
	gameFrames(6)
	local s = now()
	stickY = nil
	local dx, dz = s.hx - start.hx, s.hz - start.hz
	if math.abs(dx) + math.abs(dz) < 1 then
		error("calibrate: Link didn't move with Circle Pad Y = " .. STICK_MAX .. " (is he idle, on foot? is the axis range -128..127? set STICK_MAX)")
	end
	local off = math.abs(s16(yawTo(dx, dz) - start.shape))
	STICK_UP = off < 0x4000 and 1 or -1
	print(string.format("calibrate: Circle Pad Y %+d moved him at %+d from his facing: up is %s", STICK_MAX, s16(yawTo(dx, dz) - start.shape),
		STICK_UP > 0 and "+" or "-"))
end

local function cameraBehind()
	held.L = true
	gameFrames(8)
	held.L = false
	gameFrames(12)
end

local function press(button)
	held[button] = true
	for _ = 1, PRESS_EMU do emuFrame() end
	held[button] = false
end

-- Does the action; returns the game-frame index (into `game`) of the press
-- and, for the spins, of the spin's last frame
-- lead: (the lunges) emulated frames the stick is forward before B
local function perform(a, lead)
	local fwd, back = STICK_UP * STICK_MAX, -STICK_UP * STICK_MAX
	if a.kind == "slash" or a.kind == "stab" then
		if a.kind == "stab" then
			held.L = true
			gameFrames(6)
		end
		-- (from the start of a game frame, so the leads are the same each time)
		gameFrame()
		local at = #game
		stickY = fwd
		for _ = 1, lead do emuFrame() end
		press("B")
		for _ = 1, STICK_AFTER do emuFrame() end
		stickY = nil
		if a.kind == "stab" then
			gameFrames(30)  -- (L held through the lunge)
			held.L = false
		end
		return at
	end
	-- the spins: up to full speed, then A
	local spinBack = a.kind == "backspin"
	if spinBack then held.L = true end
	stickY = spinBack and back or fwd
	local prev = -1
	for _ = 1, 60 do
		gameFrame()
		local s = now()
		if s.speed > 0 and s.speed == prev then break end
		prev = s.speed
	end
	if spinBack then
		held.L = false
		gameFrames(BACKWALK_ZOFF)
	end
	-- (the last game frame before A: the rows up to it are the run up)
	local pressAt = #game
	press("A")
	-- the spin: the shape turning; over once it stops (or SPIN_MAX)
	local spun, lastShape, endAt = false, now().shape, nil
	for _ = 1, SPIN_MAX do
		gameFrame()
		local s = now()
		local d = math.abs(s16(s.shape - lastShape))
		lastShape = s.shape
		if d > 0x800 then spun = true
		elseif spun and d < 0x400 then endAt = #game; break end
	end
	stickY = nil
	if not spun then print("  (his shape never turned: no spin? A pressed on a Deku flower / not Deku?)") end
	return pressAt, endAt
end

local function f9(v) return string.format("%.9g", v) end

local function writeTake(a, rows, facing, pressRow, aimMin)
	local f = io.open(outDir .. a.key .. ".json", "w")
	if not f then error("can't write " .. outDir .. a.key .. ".json (make the folder mm3d_actions next to this script)") end
	local out = {}
	out[#out + 1] = string.format('{"game":"MM3D","key":"%s","name":"%s","form":"%s","facing":%d,"pressRow":%d,"aimMin":%s,\n"rows":[\n',
		a.key, a.name, a.form == 3 and "DEKU" or "HUMAN", facing, pressRow, f9(aimMin))
	for i, r in ipairs(rows) do
		out[#out + 1] = string.format('  {"rx":%s,"rz":%s,"speed":%s,"angle":%d,"speedXZ":%s,"yaw":%d,"shape":%d}%s\n',
			f9(r.rx), f9(r.rz), f9(r.speed), r.angle, f9(r.speedXZ), r.yaw, r.shape, i < #rows and "," or "")
	end
	out[#out + 1] = "]}\n"
	f:write(table.concat(out))
	f:close()
	local g = io.open(outDir .. a.key .. "_log.txt", "w")
	if g then
		g:write("frame\thome x\thome y\thome z\tpos x\tpos y\tpos z\tspeedXZ\tyaw\tshape\tvelocity.y\n")
		for _, s in ipairs(log) do
			g:write(string.format("%d\t%s\t%s\t%s\t%s\t%s\t%s\t%s\t0x%04X\t0x%04X\t%s\n", s.frame, f9(s.hx), f9(s.hy), f9(s.hz),
				f9(s.px), f9(s.py), f9(s.pz), f9(s.speed), s.yaw, s.shape, f9(s.vy)))
		end
		g:close()
	end
end

local function take(a)
	local form = mainmemory.read_s16_le(K.form)
	if form ~= a.form then
		print(string.format("%s: Link is %s, this is for %s - skipped", a.key, FORM_NAMES[form] or tostring(form), FORM_NAMES[a.form]))
		return
	end
	if not now() then print("no Link / play pointer: in a scene?"); return end
	print(string.format("== %s (B item 0x%02X)", a.key, mainmemory.read_u8(K.bItem)))
	local state = memorysavestate.savecorestate()
	gameFrame()
	if not STICK_UP then
		cameraBehind()
		calibrate()
		releaseAll()
		memorysavestate.loadcorestate(state)
		gameFrames(2)
	end
	local lunge = a.kind == "slash" or a.kind == "stab"
	local pressAt, endAt
	local lunged = not lunge
	for try, lead in ipairs(lunge and STICK_LEADS or { 0 }) do
		if try > 1 then
			memorysavestate.loadcorestate(state)
			gameFrames(2)
		end
		cameraBehind()
		log, game = {}, {}
		recording = true
		gameFrames(3)
		pressAt, endAt = perform(a, lead)
		-- until he stands still
		local stillFor = 0
		for _ = 1, MAX_TAKE do
			gameFrame()
			local n = #game
			if n >= 2 and still(game[n], game[n - 1]) then stillFor = stillFor + 1 else stillFor = 0 end
			if stillFor >= STILL_END then break end
		end
		recording = false
		releaseAll()
		if not lunge then break end
		local top = 0
		for i = pressAt + 1, #game do top = math.max(top, game[i].speed) end
		if top > LUNGE_SPEED then
			lunged = true
			if lead > 0 then print(string.format("  lunged with the stick %d emulated frames before B", lead)) end
			break
		end
		print(string.format("  no lunge (stick %d emulated frames before B: speedXZ at most %.3f)%s", lead, top,
			try < #STICK_LEADS and " - again, the stick earlier" or " - giving up, nothing written"))
	end
	if not lunged then
		memorysavestate.loadcorestate(state)
		memorysavestate.removestate(state)
		gameFrames(2)
		return
	end
	-- (the samples within a game frame should all be the same after its update: else the
	-- frame spans both emulated frames and the end state may be taken early)
	local split = 0
	for i = 2, #log do
		if log[i].frame == log[i - 1].frame and not same(log[i], log[i - 1]) then split = split + 1 end
	end
	if split > 0 then print(string.format("  warning: %d game frames changed between their emulated frames (see the log)", split)) end
	-- the rows: from the last frame standing still before he moves
	local g = game
	local first
	for i = 2, #g do
		if not still(g[i], g[i - 1]) then first = i; break end
	end
	if not first then print("  he never moved: is the weapon on B / is he idle?"); memorysavestate.loadcorestate(state); memorysavestate.removestate(state); return end
	local base = g[first - 1]
	local facing = base.shape
	local sn, cs = math.sin(facing / 65536 * 2 * math.pi), math.cos(facing / 65536 * 2 * math.pi)
	local last = #g
	while last > first and still(g[last], g[last - 1]) do last = last - 1 end
	if endAt then last = math.min(last, endAt) end
	local rows = {}
	local runUp = 0
	for k = first, last do
		local p, c = g[k - 1], g[k]
		-- the root motion added after the last frame's bg check, in his frame
		local dx, dz = p.px - p.hx, p.pz - p.hz
		local rx, rz = dx * cs - dz * sn, dx * sn + dz * cs
		-- this frame's speedXZ move
		local mx, mz = c.hx - p.px, c.hz - p.pz
		local sp = math.sqrt(mx * mx + mz * mz)
		local ang = sp > 1e-4 and s16(yawTo(mx, mz) - facing) or 0
		rows[#rows + 1] = { rx = rx, rz = rz, speed = sp, angle = ang, speedXZ = c.speed, yaw = c.yaw, shape = c.shape }
		if pressAt and k <= pressAt then runUp = math.max(runUp, sp) end
	end
	-- (leading rows that move him nowhere - the frame an attack starts adds its
	-- first root motion after the bg check - are a frame standing still: dropped)
	local lead = 0
	while lead < #rows - 1 and rows[lead + 1].rx == 0 and rows[lead + 1].rz == 0 and rows[lead + 1].speed < 1e-4 do lead = lead + 1 end
	for _ = 1, lead do table.remove(rows, 1) end
	first = first + lead
	local pressRow = pressAt and math.max(0, pressAt - first + 1) or 0
	-- (the spins: aimed only at frames faster than the run up - slower, a walking clip does it)
	-- (the spins: the run up is every row before his shape starts turning two
	-- frames running - A takes a frame or two to start the spin, he runs on at
	-- full speed meanwhile; the backwalk's one-frame turn at L let go isn't it)
	if a.kind == "spin" or a.kind == "backspin" then
		runUp = 0
		for i, r in ipairs(rows) do
			local nx = rows[i + 1]
			local prev = rows[i - 1]
			if prev and nx and math.abs(s16(r.shape - prev.shape)) > 0x800 and math.abs(s16(nx.shape - r.shape)) > 0x800 then break end
			runUp = math.max(runUp, r.speed)
		end
	end
	local aimMin = (a.kind == "spin" or a.kind == "backspin") and runUp + 0.01 or 2
	writeTake(a, rows, facing, pressRow, aimMin)
	print(string.format("  facing 0x%04X, %d rows (press at row %d%s), written to %s%s.json", facing, #rows, pressRow,
		endAt and string.format(", spin over at row %d", endAt - first + 1) or "", outDir, a.key))
	for i, r in ipairs(rows) do
		print(string.format("  %2d: root (%.3f, %.3f)  speed %.4f at %+6d  speedXZ %.4f yaw 0x%04X shape 0x%04X", i, r.rx, r.rz, r.speed, r.angle, r.speedXZ, r.yaw, r.shape))
	end
	memorysavestate.loadcorestate(state)
	memorysavestate.removestate(state)
	gameFrames(2)
end

---------------------------------------------------------------------------
-- Window
---------------------------------------------------------------------------

console.clear()
if emu.getsystemid() ~= "3DS" then error("mm3d_action_recorder: load MM3D in the 3DS core") end
local closed = false
local job = nil       -- the coroutine running a take
local form = forms.newform(360, 150, "MM3D action recorder", function() closed = true end)
local keys = {}
for i, a in ipairs(ACTIONS) do keys[#keys + 1] = string.format("%d %s", i, a.key) end
local pick = forms.dropdown(form, keys, 10, 10, 220, 20)
local function startJob(list)
	if job then print("busy"); return end
	job = coroutine.create(function()
		for _, a in ipairs(list) do take(a) end
		print("done")
	end)
end
forms.button(form, "Record", function()
	local i = tonumber((forms.gettext(pick) or ""):match("^(%d+)"))
	if i then startJob({ ACTIONS[i] }) end
end, 240, 9, 90, 23)
forms.button(form, "Record all", function()
	local f = mainmemory.read_s16_le(K.form)
	local list = {}
	for _, a in ipairs(ACTIONS) do if a.form == f then list[#list + 1] = a end end
	if #list == 0 then print("no actions for Link's form (" .. tostring(FORM_NAMES[f]) .. ")") end
	startJob(list)
end, 240, 40, 90, 23)
forms.label(form, "Flat open ground, Link idle. Output: mm3d_actions\\", 10, 75, 340, 20)

event.onexit(function()
	releaseAll()
	if not closed then forms.destroy(form) end
end)

print("MM3D action recorder: pick an action, Record (Human: lunges, Deku: spins)")
while not closed do
	if job then
		-- (the routine sets this frame's inputs, then they're applied for it)
		local ok, err = coroutine.resume(job)
		if not ok then print("error: " .. tostring(err)); releaseAll(); recording = false; job = nil
		elseif coroutine.status(job) == "dead" then releaseAll(); job = nil
		else applyInputs() end
	end
	emu.frameadvance()
end
