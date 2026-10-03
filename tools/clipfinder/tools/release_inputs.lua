-- Clears the analog stick override a script left behind (BizHawk keeps
-- joypad.setanalog values after the script stops): run it once, then stop it.
joypad.setanalog({ ["X Axis"] = "", ["Y Axis"] = "" }, 1)
emu.frameadvance()
print("released the stick override")
