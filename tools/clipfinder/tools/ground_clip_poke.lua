-- Ground clip poke (BizHawk: OoT US 1.0 / MM US on the N64 core, OoT3D US Rev 1
-- / MM3D US on the 3DS core): press K and Link gets speedXZ (linear velocity)
-- SPEED and velocity.y VEL_Y for one game frame, moving the way he faces. For
-- finding ground clips by hand: stand against a wall, face it, press K.
--
-- The values are written every emulated frame until Link moves (the game frame
-- that uses them has run), at most MAX_WRITES emulated frames, so they land on
-- exactly one game frame whichever of its emulated frames K is pressed on.

local SPEED = 25
local VEL_Y = -18
local KEY = "K"         -- keyboard key (input.get() name)

-- (the same detection and addresses as wall_clip_tester.lua's K)
local GAME
local hash = gameinfo.getromhash()
if hash == 'AD69C91157F6705E8AB06C79FE08AAD47BB57BA7' then
	GAME = "OOT" -- OoT US 1.0
elseif hash == 'D6133ACE5AFAA0882CF214CF88DABA39E266C078' then
	GAME = "MM" -- MM US
elseif emu.getsystemid() == "3DS" then
	GAME = hash == '8AEB0679FC5F77D35B8A58954CE98236' and "MM3D" or "OOT3D"
else
	error("ground_clip_poke: needs OoT US 1.0, MM US, OoT3D or MM3D (rom hash " .. hash .. ")")
end
local IS_3DS = GAME == "OOT3D" or GAME == "MM3D"
local BE = not IS_3DS
local EMU_PER_GAME = IS_3DS and 2 or 3   -- emulated frames per game frame
local MAX_WRITES = EMU_PER_GAME + 2

-- Player actor, and his fields
local function playerAddr()
	if GAME == "OOT3D" then return 0x06FF4010 end
	if GAME == "OOT" then return 0x1DAA30 end
	if GAME == "MM" then return 0x3FFDB0 end
	local p = mainmemory.read_u32_le(0x0752FD6C)
	if p > 0x24EE000 then p = p - 0x24EE000 end
	return p
end
local F = ({
	OOT3D = { pos = 0x28, velY = 0x64, speedXZ = 0x221C, yaw = 0x2220 },
	MM3D = { pos = 0x24, velY = 0x68, speedXZ = 0x11E30, yaw = 0x11E34 },
	OOT = { pos = 0x24, velY = 0x60, speedXZ = 0x828, yaw = 0x82C },
	MM = { pos = 0x24, velY = 0x68, speedXZ = 0xAD0, yaw = 0xAD4 },
})[GAME]

local function readfloat(addr) return mainmemory.readfloat(addr, BE) end
local function writefloat(addr, v) mainmemory.writefloat(addr, v, BE) end
local function readPos(p)
	return readfloat(p + F.pos), readfloat(p + F.pos + 4), readfloat(p + F.pos + 8)
end
local function readYaw(p)
	return BE and mainmemory.read_u16_be(p + F.yaw) or mainmemory.read_u16_le(p + F.yaw)
end

console.clear()
print(string.format("%s ground clip poke: press %s for speed %g, y velocity %g for a game frame", GAME, KEY, SPEED, VEL_Y))

local wasDown = false
local writes = 0          -- emulated frames left to write on (0: idle)
local startX, startY, startZ
local player

while true do
	local down = input.get()[KEY] == true
	if down and not wasDown then
		player = playerAddr()
		startX, startY, startZ = readPos(player)
		writes = MAX_WRITES
		print(string.format("start %.9g, %.9g, %.9g  yaw 0x%04X", startX, startY, startZ, readYaw(player)))
	end
	wasDown = down
	if writes > 0 then
		local x, y, z = readPos(player)
		if x ~= startX or y ~= startY or z ~= startZ then
			-- moved: that game frame used the values
			print(string.format("  after %.9g, %.9g, %.9g", x, y, z))
			writes = 0
		else
			writefloat(player + F.speedXZ, SPEED)
			writefloat(player + F.velY, VEL_Y)
			writes = writes - 1
			if writes == 0 then print("  Link didn't move (standing still on foot?)") end
		end
	end
	emu.frameadvance()
end
