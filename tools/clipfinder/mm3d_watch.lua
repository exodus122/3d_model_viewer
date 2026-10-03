-- MM3D pointer watches (BizHawk 3DS core, MM3D US): RAM watches whose
-- address goes through a pointer, which BizHawk's own watches can't follow.
-- Link's actor and the globalContext are allocated at run time; their
-- pointers are read again every frame, so the watches follow them across
-- scene loads and savestates.
--
-- A window lists the watches with their values. Pick one in the dropdown to:
--   Poke     write the value in the box (0x... for hex; a float for f32)
--   Freeze   write its current value every frame (again: unfreeze)
--   Type     show it as another type (u8 s8 u16 s16 u32 s32 h8 h16 h32 f32)
-- Add a watch at the bottom: base, offset, type, name. Each one added is
-- printed as a WATCHES line to paste below, to keep it.

---------------------------------------------------------------------------
-- Settings
---------------------------------------------------------------------------

-- 3DS pointers are virtual addresses; minus this, an FCRAM (mainmemory) one
local PTR_OFFSET = 0x24EE000

-- Where an address starts from: a number is an FCRAM address; a function
-- returns one (nil: not there right now)
local function deref(ptrAddr)
	local p = mainmemory.read_u32_le(ptrAddr)
	if p == 0 then return nil end
	if p >= PTR_OFFSET then p = p - PTR_OFFSET end
	return p
end
local BASES = {
	player = function() return deref(0x0752FD6C) end,   -- Link's actor ("Player Ptr")
	play = function() return deref(0x0754D890) end,     -- globalContext ("Global Context Ptr")
	save = 0x0765B1B0,                                  -- save context
	abs = 0,                                            -- offset = the FCRAM address
}
local BASE_ORDER = { "player", "play", "save", "abs" }

-- The watches: base, offset from it, type, name. `chain` (optional): offsets
-- of pointers to follow first, e.g. { base = "player", chain = { 0x7C }, off = 0x0 }
-- is the first word of the wall poly Link touches.
-- (types: u8 s8 u16 s16 u32 s32, h8 h16 h32 = hex, f32)
local WATCHES = {
	{ base = "player", off = 0x08, type = "f32", name = "home x" },
	{ base = "player", off = 0x0C, type = "f32", name = "home y" },
	{ base = "player", off = 0x10, type = "f32", name = "home z" },
	{ base = "player", off = 0x24, type = "f32", name = "pos x" },
	{ base = "player", off = 0x28, type = "f32", name = "pos y" },
	{ base = "player", off = 0x2C, type = "f32", name = "pos z" },
	{ base = "player", off = 0x68, type = "f32", name = "velocity y" },
	{ base = "player", off = 0xC2, type = "h16", name = "angle (shape.rot.y)" },
	{ base = "player", off = 0x11E30, type = "f32", name = "linear velocity" },
	{ base = "player", off = 0x11E34, type = "h16", name = "yaw (Player.yaw)" },
	{ base = "player", off = 0x7C, type = "h32", name = "wallPoly" },
	{ base = "player", off = 0x80, type = "h32", name = "floorPoly" },
	{ base = "play", off = 0x138, type = "u32", name = "frame counter" },
	{ base = "play", off = 0xC529, type = "u8", name = "warp trigger" },
	{ base = "play", off = 0xC52E, type = "h16", name = "next entrance" },
	{ base = "save", off = 0x48, type = "h16", name = "time of day" },
	{ base = "save", off = 0x4E, type = "s16", name = "form (4 human)" },
	{ base = "save", off = 0x164, type = "s16", name = "health" },
	{ base = "save", off = 0x168, type = "s16", name = "rupees" },
	{ base = "save", off = 0x17A, type = "u8", name = "B button item" },
}

---------------------------------------------------------------------------
-- Memory
---------------------------------------------------------------------------

local TYPES = { "u8", "s8", "u16", "s16", "u32", "s32", "h8", "h16", "h32", "f32" }
local SIZE = { u8 = 1, s8 = 1, h8 = 1, u16 = 2, s16 = 2, h16 = 2, u32 = 4, s32 = 4, h32 = 4, f32 = 4 }

local function read(addr, t)
	if t == "u8" or t == "h8" then return mainmemory.read_u8(addr) end
	if t == "s8" then return mainmemory.read_s8(addr) end
	if t == "u16" or t == "h16" then return mainmemory.read_u16_le(addr) end
	if t == "s16" then return mainmemory.read_s16_le(addr) end
	if t == "u32" or t == "h32" then return mainmemory.read_u32_le(addr) end
	if t == "s32" then return mainmemory.read_s32_le(addr) end
	return mainmemory.readfloat(addr, false)
end

-- (the value as written: unsigned types wrap, signed ones too)
local function write(addr, t, v)
	if t == "f32" then mainmemory.writefloat(addr, v, false); return end
	v = math.floor(v + 0.5)
	local size = SIZE[t]
	local mod = 2 ^ (8 * size)
	v = v % mod
	if size == 1 then mainmemory.write_u8(addr, v)
	elseif size == 2 then mainmemory.write_u16_le(addr, v)
	else mainmemory.write_u32_le(addr, v) end
end

local function show(v, t)
	if v == nil then return "-" end
	if t == "f32" then return string.format("%.9g", v) end
	if t == "h8" then return string.format("0x%02X", v) end
	if t == "h16" then return string.format("0x%04X", v) end
	if t == "h32" then return string.format("0x%08X", v) end
	return tostring(v)
end

-- A watch's FCRAM address now, or nil (a null pointer on the way)
local function addrOf(w)
	local b = BASES[w.base]
	if b == nil then b = tonumber(w.base) end
	local a = b
	if type(b) == "function" then a = b() end
	if not a then return nil end
	for _, o in ipairs(w.chain or {}) do
		a = deref(a + o)
		if not a then return nil end
	end
	return a + w.off
end

-- "0x1F" / "-5" / "1.5"
local function parseValue(text, t)
	text = text:gsub("^%s+", ""):gsub("%s+$", "")
	local neg, hex = text:match("^(%-?)0[xX](%x+)$")
	if hex then return (neg == "-" and -1 or 1) * tonumber(hex, 16) end
	return tonumber(text)
end

---------------------------------------------------------------------------
-- Window
---------------------------------------------------------------------------

console.clear()
local W, H = 560, 640
local closed = false
local form = forms.newform(W, H, "MM3D pointer watches", function() closed = true end)
local list = forms.label(form, "", 8, 8, W - 30, 400, true)

-- (dropdown items get sorted: numbered so they keep the list's order)
local function items()
	local out = {}
	for i, w in ipairs(WATCHES) do out[#out + 1] = string.format("%02d %s", i, w.name) end
	return out
end
local y = 416
forms.label(form, "Watch", 8, y + 3, 50, 20)
local pick = forms.dropdown(form, items(), 60, y, 280, 20)
local function picked()
	local i = tonumber((forms.gettext(pick) or ""):match("^(%d+)"))
	return i and WATCHES[i], i
end

y = y + 30
forms.label(form, "Value", 8, y + 3, 50, 20)
local valueBox = forms.textbox(form, "", 120, 20, nil, 60, y)
forms.button(form, "Poke", function()
	local w = picked()
	if not w then return end
	local v = parseValue(forms.gettext(valueBox), w.type)
	local a = addrOf(w)
	if v == nil then print("not a number: " .. forms.gettext(valueBox)); return end
	if not a then print(w.name .. ": null pointer"); return end
	write(a, w.type, v)
	if w.frozen ~= nil then w.frozen = v end
end, 190, y - 1, 60, 23)
forms.button(form, "Freeze", function()
	local w = picked()
	if not w then return end
	if w.frozen ~= nil then w.frozen = nil; return end
	local a = addrOf(w)
	if a then w.frozen = read(a, w.type) end
end, 255, y - 1, 60, 23)
local typePick = forms.dropdown(form, TYPES, 330, y, 60, 20)
forms.button(form, "Type", function()
	local w = picked()
	if not w then return end
	local t = forms.gettext(typePick)
	-- (frozen: keep the frozen bytes, read back as the new type)
	if w.frozen ~= nil then local a = addrOf(w); if a then w.frozen = read(a, t) end end
	w.type = t
end, 395, y - 1, 50, 23)

-- Add a watch
y = y + 40
forms.label(form, "Add:  base / offset (hex) / type / name", 8, y, 400, 18)
y = y + 22
local basePick = forms.dropdown(form, BASE_ORDER, 8, y, 70, 20)
local offBox = forms.textbox(form, "0x0", 80, 20, nil, 85, y)
local addType = forms.dropdown(form, TYPES, 172, y, 60, 20)
local nameBox = forms.textbox(form, "", 160, 20, nil, 238, y)
forms.button(form, "Add", function()
	local off = tonumber((forms.gettext(offBox):gsub("^0[xX]", "")), 16)
	if not off then print("offset isn't hex: " .. forms.gettext(offBox)); return end
	local w = { base = forms.gettext(basePick), off = off, type = forms.gettext(addType), name = forms.gettext(nameBox) }
	if w.name == "" then w.name = string.format("%s+0x%X", w.base, off) end
	WATCHES[#WATCHES + 1] = w
	forms.setdropdownitems(pick, items())
	print(string.format('\t{ base = "%s", off = 0x%X, type = "%s", name = "%s" },', w.base, w.off, w.type, w.name))
end, 405, y - 1, 50, 23)

---------------------------------------------------------------------------
-- Every frame: freeze, then show
---------------------------------------------------------------------------

event.onexit(function() if not closed then forms.destroy(form) end end)

local lastText
while not closed do
	local lines = {}
	for i, w in ipairs(WATCHES) do
		local a = addrOf(w)
		if a and w.frozen ~= nil then write(a, w.type, w.frozen) end
		local v = a and read(a, w.type)
		lines[#lines + 1] = string.format("%02d %-22s %s %-14s %s", i, w.name:sub(1, 22),
			a and string.format("%08X", a) or "  null  ", show(v, w.type), w.frozen ~= nil and "F" or "")
	end
	local text = table.concat(lines, "\n")
	if text ~= lastText then forms.settext(list, text); lastText = text end
	emu.frameadvance()
end
