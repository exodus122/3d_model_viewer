"""The jumpslash landing tables in src/action.cpp (JUMPSLASH_LANDING), from the
OoT decomp's animation data (extracted/<version>/assets/misc/link_animetion;
MM's lunges use the same data, see ACTIONS).

The landing slash (PLAYER_MWA_JUMPSLASH_FINISH) plays
gPlayerAnim_link_fighter_Lpower_jump_kiru_hit one frame a game frame, then its
end animation (Lpower_jump_kiru_end two-handed, power_jump_kiru_end
otherwise: z_player.c Player_Action_808502D0 / MM Player_Action_84) at 1.5
frames a game frame, the root motion carrying on - a step back of about 27,
which holding shield (or the stick) cuts short: the rows stop one frame into
it (see table()). Each row is one game frame
of it, as ACTIONS: { root x, root z, prevTransl x, prevTransl z, speed, swing }.
  Row 0 is the frame after the landing: prevTransl is the skeleton's base
  translation (PLAYER_ANIM_MOVEMENT_RESET_BY_AGE: -57 adult, -36 child; OoT),
  or MM's ANIM_FLAG_NOMOVE zeroes the move (root = prevTransl). Its speed is
  the landing's (set in action.cpp), marked -1.
  swing: the sword swing is active at that frame's collision. OoT carries it
  from the air into row 0 (func_80837948 skips func_80832318 for the finish);
  MM zeroes it on landing (Player_Action_29). Then func_8084285C(0, 1, 2):
  active while the hit animation's frame is <= 2, off from the switch to
  the end animation.

usage: gen_jumpslash_frames.py [path/to/oot]   (default ../../../../oot)
"""
import os, re, sys

HERE = os.path.dirname(os.path.abspath(__file__))
OOT = sys.argv[1] if len(sys.argv) > 1 else os.path.join(HERE, '..', '..', '..', '..', 'oot')
ANIMS = os.path.join(OOT, 'extracted', 'ntsc-1.0', 'assets', 'misc', 'link_animetion')
LIMBS = 22  # PLAYER_LIMB_MAX


def roots(name):
    """The root translation (x, z) of each frame of gPlayerAnim_link_fighter_<name>."""
    text = open(os.path.join(ANIMS, f'gPlayerAnim_link_fighter_{name}_Data.inc.c')).read()
    text = re.sub(r'//[^\n]*', '', re.sub(r'/\*.*?\*/', '', text, flags=re.S))
    v = [int(x, 0) for x in re.findall(r'-?0x[0-9A-Fa-f]+|-?\d+', text)]
    v = [x - 0x10000 if x >= 0x8000 else x for x in v]
    n = LIMBS * 3 + 1
    assert len(v) % n == 0, name
    return [(v[i * n], v[i * n + 2]) for i in range(len(v) // n)]


def table(end_name, base_x, mm):
    hit, end = roots('Lpower_jump_kiru_hit'), roots(end_name)
    rows = []
    j0 = hit[0]
    p0 = j0 if mm else (base_x, 0)
    rows.append((j0[0], j0[1], p0[0], p0[1], -1, not mm))
    for k in range(1, len(hit)):
        rows.append((hit[k][0], hit[k][1], hit[k - 1][0], hit[k - 1][1], 0, k - 1 <= 2))
    # the switch to the end animation (the step back): its first frame's root
    # motion still happens, then shield held (R) interrupts it the next frame
    # (Player_Action_Idle's handler list; the new action's Player_SetupAction
    # ends the root motion, Player_FinishAnimMovement) - the tester holds R
    rows.append((end[0][0], end[0][1], hit[-1][0], hit[-1][1], 0, False))
    return rows


def fmt(rows):
    return ', '.join('{ %d, %d, %d, %d, %d, %s }' % (a, b, c, d, e, 'true' if s else 'false') for a, b, c, d, e, s in rows)


for label, end_name, base, mm in [
    ('OoT adult 1h', 'power_jump_kiru_end', -57, False),
    ('OoT child 1h', 'power_jump_kiru_end', -36, False),
    ('MM 1h', 'power_jump_kiru_end', 0, True),
]:
    print(f'// {label}')
    print('{ ' + fmt(table(end_name, base, mm)) + ' }')
