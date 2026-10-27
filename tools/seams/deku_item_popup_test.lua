-- Deku ledge grab -> restricted item over the Ocarina test (BizHawk, MM US, N64 core)
--
-- The trick: in a B-disabled scene the hanging branch of the C button update
-- (z_parameter.c:1950, only runs while B isn't disabled yet) does nothing, so
-- the C buttons keep the status they had. Pause on the frame before the grab,
-- equip an item Deku can't use (bombs, the Keaton Mask: dimmed) over the
-- Ocarina (C-left, lit), unpause, press C-left on the grab frame: C-left is
-- still lit, so the game takes the item.
--
-- ITEM = "bombs" checks the trick itself: bombs don't need ground (no
-- Player_ActionHandler_13 ground check, unlike masks), so on a normal popup
-- (Milk Bar banister) Deku should pull one out. ITEM = "keaton" is the mask
-- version (needs ground when it's used).
--
-- Setup: savestate with Deku Link standing still on foot in the Milk Bar or
-- the Stock Pot Inn (the targets for the loaded scene are run), the Ocarina on
-- C-left (lit), and the item owned (bombs: some in the bag). Don't hold
-- anything. Each try reloads the savestate, puts Link in the air in front of
-- the ledge (ground flag cleared, velocity.y 0, speedXZ 1.0, facing it): the
-- grab is checked from the second game frame on (y START_Y - 1.5, then - 4.5).
-- The "pause-menu equip" writes the item to C-left (item + slot) after the
-- first game frame; C-left's status isn't touched.
--
-- Logged a frame: C-left item/status, the game's C-left press flag, itemAction
-- / heldItemAction, the held actor, unk_AA5 (5 = mask use queued), form, mask,
-- action, hang / ground flags.
-- Verdicts: "BOMB" (bomb item action or a held actor), "MASK USED", "nothing".
--
-- CHEAT tries ("cheat" in the plan) answer "would Keaton work if Link were
-- grounded on the popup frame": a real popup only happens when he isn't
-- (func_8083827C runs after the floor check), so after the grab frame has run
-- - still hanging, so C-left stays lit - the script does the popup itself:
-- action = Player_Action_25 (its address read from the first falling frame),
-- hang flags cleared (STATE1_4 | 2000 | 4000), and (groundY) Link put on the
-- floor under the hang spot with velocity.y 0. On the popup frame the floor
-- check grounds him, func_8083827C doesn't fire, Player_Action_25's grounded
-- branch reads C-left (z_player.c:15258) and Player_ActionHandler_13 sees ground.

local ITEM = "keaton"           -- "bombs" or "keaton"

local SCENE_MILK_BAR, SCENE_YADOYA = 0x15, 0x61
local TARGETS = {
	-- Milk Bar banister (walls 333/334, ledge 335): the normal popup - the
	-- grab puts him at y 39.25, 6.4 above the slope; he's in the air next frame
	{ scene = SCENE_MILK_BAR, name = "Milk Bar banister x -150", a = { -150, -74 }, b = { -150, -74 }, n = { 0, -1 }, yaw = 0x0000, along = 0, d = 13.0, startY = 4.5,
	  groundY = 32.9 },  -- cheat: the banister slope under the hang spot (32.82)
	-- Stock Pot Inn bed posts: GROUNDED on the popup frame (deku_ledge_popup_test.lua)
	{ scene = SCENE_YADOYA, name = "Inn wall 505 +2.50 d13", a = { -531.315, -89.380 }, b = { -525.721, -89.114 }, n = { 0.04758, -0.99887 }, yaw = 0xFE10, along = 2.5, d = 13.0, startY = 215.5 },
	{ scene = SCENE_YADOYA, name = "Inn wall 1125 +0.00 d13", a = { -560.725, 562.891 }, b = { -559.782, 562.773 }, n = { -0.12403, -0.99228 }, yaw = 0x0511, along = 0.0, d = 13.0, startY = 215.5 },
}
-- C-left press on game frame grab + off (0 = the grab frame); the game's own
-- press flag is logged
-- (the bomb test showed the popup frame is grab + 1: C-left read there with
-- the stale status)
local PLANS = { { off = 1, cheat = true }, { off = 1 } }
local SPEED = 1.0
local LOG_FRAMES = 100          -- game frames logged after the grab (Player_Action_86, the mask change, runs 55+ frames)

local HASH_MM = 'D6133ACE5AFAA0882CF214CF88DABA39E266C078'
if gameinfo.getromhash() ~= HASH_MM then error("deku_item_popup_test: needs MM US (N64)") end
local EMU_PER_GAME = 3
local PLAY = 0x3E6B20
local GAMEPLAY_FRAMES = 0x18840
local SCENE_ID = PLAY + 0xA4         -- play->sceneId
local PRESS = PLAY + 0x14 + 0x0C     -- play->state.input[0].press.button
local BTN_CLEFT = 0x0002
local PLAYER = 0x3FFDB0
local O = {
	home = 0x08, pos = 0x24, rotY = 0x32, velocity = 0x64, actorSpeed = 0x70, bgCheckFlags = 0x90,
	shapeRotY = 0xBE, prevPos = 0x108, heldItemAction = 0x147, itemAction = 0x14A, transformation = 0x14B,
	currentMask = 0x153, heldActor = 0x34C, actionFunc = 0x748, stateFlags1 = 0xA6C, unkAA5 = 0xAA5,
	speedXZ = 0xAD0, yaw = 0xAD4,
}
local SAVE = 0x1EF670                    -- gSaveContext
local C_LEFT_ITEM = SAVE + 0x4C + 1      -- save.saveInfo.equips.buttonItems[0][EQUIP_SLOT_C_LEFT]
local C_LEFT_SLOT = SAVE + 0x5C + 1      -- save.saveInfo.equips.cButtonSlots[0][EQUIP_SLOT_C_LEFT]
local C_LEFT_STATUS = SAVE + 0x3F18 + 1  -- buttonStatus[EQUIP_SLOT_C_LEFT] (0 lit, 0xFF dimmed)
local INV_ITEMS, INV_AMMO = SAVE + 0x70, SAVE + 0xA0  -- save.saveInfo.inventory.items / ammo
local SAVE_FORM = SAVE + 0x20             -- save.playerForm (set to Human when the mask change starts)
local ITEM_OCARINA = 0x00
local ITEMS = {
	bombs = { item = 0x06, slot = 0x06, ia = 0x0E, ammo = true },  -- ITEM_BOMB, SLOT_BOMB, PLAYER_IA_BOMB
	keaton = { item = 0x3A, slot = 0x1E, ia = 0x3E },              -- ITEM_MASK_KEATON, SLOT_MASK_KEATON, PLAYER_IA_MASK_KEATON
}
local USE = ITEMS[ITEM] or error("deku_item_popup_test: ITEM must be bombs or keaton")
local PLAYER_OVL = 0x1963E0 + 0x1C       -- gKaleidoMgrOverlayTable[KALEIDO_OVL_PLAYER_ACTOR]
local ACTIONS = {
	[0x80847F58] = "Action_25(fall)", [0x80830DD4] = "Action_48(hang)", [0x808484D8] = "Action_49(climb)",
	[0x808442B0] = "Idle", [0x80833E64] = "Action_21(knockback)", [0x80834B58] = "Action_20(damage)",
}
local FORMS = { [0] = "FD", "Goron", "Zora", "Deku", "Human" }
local GROUND, STATE1_HANG = 0x1, 0x2000
local STATE1_HANG_ALL = { 0x4, 0x2000, 0x4000 }  -- cleared by the real popup's flag reset

local function u8(a) return mainmemory.read_u8(a) end
local function s8(a) local v = u8(a); if v >= 0x80 then v = v - 0x100 end; return v end
local function u32(a) return mainmemory.read_u32_be(a) end
local function rf(a) return mainmemory.readfloat(a, true) end
local function wf(a, v) mainmemory.writefloat(a, v, true) end
local function bit(x, b) return math.floor(x / b) % 2 == 1 end
local function frames() return u32(PLAY + GAMEPLAY_FRAMES) end
local function actionName()
	local vram = (u32(PLAYER + O.actionFunc) - u32(PLAYER_OVL) + u32(PLAYER_OVL + 0x0C)) % 0x100000000
	return ACTIONS[vram] or string.format("%08X", vram)
end
local function writeVec(off, x, y, z)
	wf(PLAYER + off, x); wf(PLAYER + off + 4, y); wf(PLAYER + off + 8, z)
end

local function snap()
	return {
		y = rf(PLAYER + O.pos + 4), action = actionName(),
		hang = bit(u32(PLAYER + O.stateFlags1), STATE1_HANG),
		ground = bit(mainmemory.read_u16_be(PLAYER + O.bgCheckFlags), GROUND),
		cItem = u8(C_LEFT_ITEM), cStatus = u8(C_LEFT_STATUS),
		pressC = bit(mainmemory.read_u16_be(PRESS), BTN_CLEFT),
		ia = s8(PLAYER + O.itemAction), held = s8(PLAYER + O.heldItemAction),
		heldActor = u32(PLAYER + O.heldActor) ~= 0, func = u32(PLAYER + O.actionFunc),
		aa5 = u8(PLAYER + O.unkAA5),
		form = u8(PLAYER + O.transformation), mask = u8(PLAYER + O.currentMask), saveForm = u8(SAVE_FORM),
	}
end
local function fmtSnap(tag, s)
	return string.format("    %-7s y %.2f %08X%s ground %s | C-left item %02X status %02X%s | itemAction %d held %d%s unk_AA5 %d form %s (save %s) mask %d",
		tag, s.y, s.func, s.hang and " HANG" or "", s.ground and "Y" or "n",
		s.cItem, s.cStatus, s.pressC and " PRESSED" or "", s.ia, s.held, s.heldActor and " +actor" or "",
		s.aa5, FORMS[s.form] or tostring(s.form), FORMS[s.saveForm] or tostring(s.saveForm), s.mask)
end

local function syncToGameFrame()
	local f0 = frames()
	for _ = 1, 2 * EMU_PER_GAME do
		emu.frameadvance()
		if frames() ~= f0 then break end
	end
	for _ = 1, EMU_PER_GAME - 1 do emu.frameadvance() end
end
-- run one game frame, calling `input` before each emulated frame until it has run
local function runGameFrame(input)
	local f0 = frames()
	for _ = 1, 3 * EMU_PER_GAME do
		if input then input() end
		emu.frameadvance()
		if frames() ~= f0 then return true end
	end
	return false
end
local function holdC() joypad.set({ ["C Left"] = true }, 1) end

local DRIFT = 1.5 * SPEED + 1.5 * (SPEED - 0.1)  -- moved toward the wall before the grab frame's collision

local function setup(t)
	local len = math.sqrt((t.b[1] - t.a[1]) ^ 2 + (t.b[2] - t.a[2]) ^ 2)
	local frac = len > 0.01 and t.along / len or 0
	local px = t.a[1] + (t.b[1] - t.a[1]) * frac + t.n[1] * (t.d - 14)
	local pz = t.a[2] + (t.b[2] - t.a[2]) * frac + t.n[2] * (t.d - 14)
	local sx, sz = px + t.n[1] * DRIFT, pz + t.n[2] * DRIFT
	syncToGameFrame()
	writeVec(O.pos, sx, t.startY, sz)
	writeVec(O.prevPos, sx, t.startY, sz)
	writeVec(O.home, sx, t.startY, sz)
	wf(PLAYER + O.velocity + 4, 0)
	wf(PLAYER + O.speedXZ, SPEED)
	wf(PLAYER + O.actorSpeed, SPEED)
	local yaw = t.yaw >= 0x8000 and t.yaw - 0x10000 or t.yaw
	mainmemory.write_s16_be(PLAYER + O.yaw, yaw)
	mainmemory.write_s16_be(PLAYER + O.rotY, yaw)
	mainmemory.write_s16_be(PLAYER + O.shapeRotY, yaw)
	local bg = mainmemory.read_u16_be(PLAYER + O.bgCheckFlags)
	if bit(bg, GROUND) then mainmemory.write_u16_be(PLAYER + O.bgCheckFlags, bg - GROUND) end
end

local out = io.open("deku_item_popup_log.txt", "w")
local function say(s)
	print(s)
	if out then out:write(s, "\n") end
end

local GRAB = 2  -- the grab frame: game frame 2 after the setup

local function try(t, plan)
	local log = {}
	setup(t)
	local used, grabAt, fallFunc = nil, nil, nil
	for i = 1, GRAB + LOG_FRAMES do
		runGameFrame(i == GRAB + plan.off and holdC or nil)
		local s = snap()
		if s.hang and not grabAt then grabAt = i end
		if i == 1 then fallFunc = s.func end  -- Player_Action_25: falling after the setup
		if not used then
			if ITEM == "bombs" and (s.ia == USE.ia or s.held == USE.ia or s.heldActor) then used = "BOMB on gf+" .. i end
			-- (itemAction alone isn't enough: on an airborne popup it's queued, then cancelled)
			if ITEM == "keaton" and (s.form == 4 or s.mask == 5 or s.saveForm == 4) then used = "MASK USED on gf+" .. i end
		end
		if ITEM == "keaton" and s.form == 4 and not (used or ""):find("HUMAN") then used = (used or "") .. ", HUMAN on gf+" .. i end
		local tag = (i == GRAB and "grab?" or ("gf+" .. i)) .. (i == GRAB + plan.off and " C" or "")
		log[#log + 1] = fmtSnap(tag, s)
		if i == GRAB - 1 then
			-- paused here: the pause-menu equip over the Ocarina
			-- (C-left's status, set for the Ocarina, isn't touched)
			mainmemory.write_u8(C_LEFT_ITEM, USE.item)
			mainmemory.write_u8(C_LEFT_SLOT, USE.slot)
			log[#log + 1] = fmtSnap("equip", snap())
		end
		if plan.cheat and i == GRAB and s.hang then
			-- the fake popup: falling action, hang flags off, on the floor
			mainmemory.write_u32_be(PLAYER + O.actionFunc, fallFunc)
			local f1 = u32(PLAYER + O.stateFlags1)
			for _, b in ipairs(STATE1_HANG_ALL) do
				if bit(f1, b) then f1 = f1 - b end
			end
			mainmemory.write_u32_be(PLAYER + O.stateFlags1, f1)
			if t.groundY then
				local x, z = rf(PLAYER + O.pos), rf(PLAYER + O.pos + 8)
				writeVec(O.pos, x, t.groundY, z)
				writeVec(O.prevPos, x, t.groundY, z)
				writeVec(O.home, x, t.groundY, z)
			end
			wf(PLAYER + O.velocity + 4, 0)
			log[#log + 1] = fmtSnap("cheat", snap())
		end
	end
	local verdict = used or "nothing"
	if not grabAt then verdict = verdict .. " (no grab)" elseif grabAt ~= GRAB then verdict = verdict .. " (grab on gf+" .. grabAt .. ")" end
	return verdict, log
end

console.clear()
if u8(PLAYER + O.transformation) ~= 3 then error("deku_item_popup_test: be Deku Link in the savestate") end
if u8(C_LEFT_ITEM) ~= ITEM_OCARINA then
	print(string.format("warning: C-left holds item %02X, not the Ocarina (00)", u8(C_LEFT_ITEM)))
end
if u8(INV_ITEMS + USE.slot) ~= USE.item then
	print(string.format("warning: inventory slot %d holds %02X, not the %s item (%02X)", USE.slot, u8(INV_ITEMS + USE.slot), ITEM, USE.item))
end
if USE.ammo and s8(INV_AMMO + USE.slot) <= 0 then print("warning: no " .. ITEM .. " in the bag") end
local scene = mainmemory.read_s16_be(SCENE_ID)
say(string.format("item %s, scene 0x%02X, C-left status at the start: %02X (00 = lit)", ITEM, scene, u8(C_LEFT_STATUS)))
local base = memorysavestate.savecorestate()
local ran = 0
for _, t in ipairs(TARGETS) do
	if t.scene == scene then
		ran = ran + 1
		say("== " .. t.name)
		for _, plan in ipairs(PLANS) do
			memorysavestate.loadcorestate(base)
			local verdict, log = try(t, plan)
			say(string.format("  C-left on grab %+d%s: %s", plan.off, plan.cheat and " CHEAT (grounded popup)" or "", verdict))
			for _, l in ipairs(log) do say(l) end
		end
	end
end
if ran == 0 then say("no targets for this scene (Milk Bar 0x15, Stock Pot Inn 0x61)") end
memorysavestate.loadcorestate(base)
memorysavestate.removestate(base)
say("done (savestate restored)")
if out then out:close() end
