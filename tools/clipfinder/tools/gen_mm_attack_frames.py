"""MM attack frame tables for src/action.cpp (ACTIONS), from the MM decomp's
animation data (extracted/n64-us/assets/misc/link_animetion/link_animetion.c),
by emulating z_player.c / z_skelanime.c game frame by game frame:

  Player_UpdateCommon moves Link (speedXZ) and runs the collision, then the
  action. Player_Action_84 (the attack): func_8083FCF0 sets the swing
  (meleeWeaponState) from the animation frame before it advances - active
  while curFrame <= unk_D (sMeleeAttackAnimInfo), off after - then
  PlayerAnimation_Once advances the frame (curFrame += playSpeed x 1.5, held
  at endFrame; on the frame it's already there it reloads that frame and
  returns true). Done: func_8082DC38 (swing off) and the end animation
  (unk_4) from frame 0, played by Player_Action_Idle at sWaterSpeedFactor (1)
  x 1.5 a frame, the root-motion flags kept. Zora with B still held (and held
  since the attack began, unk_ADC): Player_ActionHandler_8 starts the fin aim
  and the end animation is the aim's, pz_cutterwaitA/B/C (the "Zora clip").
  The frame loads (AnimTaskQueue, (s32)curFrame, no morph: PlayOnceSetSpeed's
  morphFrames is 0) run before the movement task, which (SkelAnime_Update-
  Translation) moves Link by root - prevTransl, rotated by his facing, x 0.01
  x the form's unk_08 (Zora 1, Human 11/17), and sets prevTransl = root.
  ANIM_FLAG_NOMOVE (func_80833864) zeroes the first one, on the attack's
  start frame. That root motion is added after the frame's collision, so the
  next frame's collision sweeps it (with that frame's speedXZ move).

Each row: { root x, root z, prevTransl x, prevTransl z, speed, swing } as
ACTIONS has them: one per game frame from the one after the attack starts
(the start frame doesn't move: NOMOVE). The speed column is filled in by hand
(the lunge's 15 -> 10, 5; Zora attacks have none; a landing: -1).

Check: `--check` rebuilds MM's 1h slash table (normal_kiru, unk_D 4) and
compares it with ACTIONS'.

usage: gen_mm_attack_frames.py [--check] [path/to/mm]   (default ../../../../mm)
"""
import os, re, sys

HERE = os.path.dirname(os.path.abspath(__file__))
args = [a for a in sys.argv[1:] if not a.startswith('--')]
MM = args[0] if args else os.path.join(HERE, '..', '..', '..', '..', 'mm')
SRC = os.path.join(MM, 'extracted', 'n64-us', 'assets', 'misc', 'link_animetion', 'link_animetion.c')
FRAME = 22 * 3 + 1
_text = None


OOT_ANIMS = os.path.join(HERE, '..', '..', '..', '..', 'oot', 'extracted', 'ntsc-1.0', 'assets', 'misc', 'link_animetion')


def roots(name, game='MM'):
    """The root translation (x, z) of each frame of gPlayerAnim_<name> (OoT: its
    extracted gPlayerAnim_<name>_Data.inc.c)."""
    global _text
    if game == 'OOT':
        t = open(os.path.join(OOT_ANIMS, f'gPlayerAnim_{name}_Data.inc.c')).read()
        t = re.sub(r'//[^\n]*', '', t)
    else:
        if _text is None:
            _text = open(SRC).read()
        m = re.search(r's16 gPlayerAnim_' + re.escape(name) + r'_Data\[\] = \{(.*?)\};', _text, re.S)
        assert m, name
        t = m.group(1)
    t = re.sub(r'/\*.*?\*/', '', t, flags=re.S)
    v = [int(x, 0) for x in re.findall(r'-?0x[0-9A-Fa-f]+|-?\d+', t)]
    v = [x - 0x10000 if x >= 0x8000 else x for x in v]
    assert len(v) % FRAME == 0, name
    return [(v[i * FRAME], v[i * FRAME + 2]) for i in range(len(v) // FRAME)]


def rows(main, end, unk_d, end_frames=None, game='MM', base_x=-57):
    """The rows from the frame after the attack starts (see the module doc).
    main / end: animation names; end_frames: how many end rows (None: all).
    OoT: there's no NOMOVE - the start frame's movement task moves him from the
    skeleton's base translation (x base_x: adult -57, child -36) to frame 0,
    swept by the next collision with the swing still off: one row more first
    (its speed is the start frame's, 0); the rest is the same."""
    a, e = roots(main, game), roots(end, game)
    out = [(a[0][0], a[0][1], base_x, 0, False)] if game == 'OOT' else []
    cur = 0.0                       # main's curFrame after the start frame
    prev = a[0]                     # prevTransl after the start frame's (NOMOVE) movement task
    last = len(a) - 1
    # the attack's frames: each game frame, the action then the movement task.
    # A row's root motion is swept by the next frame's collision, with the
    # swing this same action left: active while the frame before advancing
    # was <= unk_D, off on the switch (func_8082DC38)
    while True:
        if cur == last:
            # PlayerAnimation_Once: already at the end -> reloads it, returns
            # true: the switch loads end frame 0
            root = e[0]
            out.append((root[0], root[1], prev[0], prev[1], False))
            prev = root
            break
        sw = cur <= unk_d
        cur = min(cur + (2.0 / 3.0) * 1.5, last)
        root = a[int(cur)]
        out.append((root[0], root[1], prev[0], prev[1], sw))
        prev = root
    # the end animation in Player_Action_Idle, 1.5 a frame, root motion on
    ecur = 0.0
    n = 0
    while (end_frames is None or n < end_frames) and ecur < len(e) - 1:
        ecur = min(ecur + 1.5, len(e) - 1)
        root = e[int(ecur)]
        out.append((root[0], root[1], prev[0], prev[1], False))
        prev = root
        n += 1
    return out


def fmt(rs, speeds=()):
    s = []
    for i, (jx, jz, px, pz, sw) in enumerate(rs):
        sp = speeds[i] if i < len(speeds) else 0
        s.append('{ %d, %d, %d, %d, %s, %s }' % (jx, jz, px, pz, sp, 'true' if sw else 'false'))
    return '{ ' + ', '.join(s) + ' }'


if __name__ == '__main__':
    if '--check' in sys.argv:
        print('MM 1h slash:', fmt(rows('link_fighter_normal_kiru', 'link_fighter_normal_kiru_end', 4), (10, 5)))
        print('OoT adult 1h slash:', fmt(rows('link_fighter_normal_kiru', 'link_fighter_normal_kiru_end', 4, game='OOT'), (0, 10, 5)))
        sys.exit(0)
    if '--spin' in sys.argv:
        # The two-handed spin attack (PLAYER_MWA_SPIN_ATTACK_2H, link_fighter_Lrolling_kiru,
        # unk_D 15 in both games) ending with a hostile lock-on: its end animation is
        # unk_8, link_anchor_Lrolling_kiru_endR - the switch row is the ~14 (MM Human)
        # / ~22 (OoT) jump. Speeds: released with the stick forward (-fwd) it's a
        # lunge (PLAYER_STATE2_30 / 40000000: 15 -> 10, then 5) on the first frames.
        m, e = 'link_fighter_Lrolling_kiru', 'link_anchor_Lrolling_kiru_endR'
        print('MM_SPIN_LOCK =', fmt(rows(m, e, 15)))
        print('MM_SPIN_LOCK_FWD =', fmt(rows(m, e, 15), (10, 5)))
        for age, bx in (('ADULT', -57), ('CHILD', -36)):
            print(f'OOT_{age}_SPIN_LOCK =', fmt(rows(m, e, 15, game='OOT', base_x=bx)))
            print(f'OOT_{age}_SPIN_LOCK_FWD =', fmt(rows(m, e, 15, game='OOT', base_x=bx), (0, 10, 5)))
        # -r: R (shield) held as it ends: the switch row (the jump) still happens, then
        # Player_Action_Idle's handlers raise the shield the next frame, a new action,
        # which ends the root motion - no step back (as the jumpslash's tables stop)
        print('MM_SPIN_LOCK_R =', fmt(rows(m, e, 15, end_frames=0)))
        print('MM_SPIN_LOCK_FWD_R =', fmt(rows(m, e, 15, end_frames=0), (10, 5)))
        for age, bx in (('ADULT', -57), ('CHILD', -36)):
            print(f'OOT_{age}_SPIN_LOCK_R =', fmt(rows(m, e, 15, end_frames=0, game='OOT', base_x=bx)))
            print(f'OOT_{age}_SPIN_LOCK_FWD_R =', fmt(rows(m, e, 15, end_frames=0, game='OOT', base_x=bx), (0, 10, 5)))
        # The plain spins, released with the stick forward (the lunge), no lock-on:
        # the ordinary end animation (unk_4). One-handed: PLAYER_MWA_SPIN_ATTACK_1H,
        # link_fighter_rolling_kiru, unk_D 12; two-handed as above.
        spins = (('SPIN1', 'link_fighter_rolling_kiru', 'link_fighter_rolling_kiru_end', 12),
                 ('SPIN2', 'link_fighter_Lrolling_kiru', 'link_fighter_Lrolling_kiru_end', 15))
        for tag, sm, se, d in spins:
            print(f'MM_{tag}_FWD =', fmt(rows(sm, se, d), (10, 5)))
            for age, bx in (('ADULT', -57), ('CHILD', -36)):
                print(f'OOT_{age}_{tag}_FWD =', fmt(rows(sm, se, d, game='OOT', base_x=bx), (0, 10, 5)))
        sys.exit(0)
    # The Zora tables (action.cpp ZORA_*): the punch (PLAYER_MWA_ZORA_PUNCH_LEFT,
    # unk_D 5) and its end animation; the jumpkick's landing
    # (PLAYER_MWA_ZORA_JUMPKICK_FINISH, unk_D 2), led by the landing frame itself
    # (no root motion: NOMOVE; it moves at the landing's speed, -1; swing off:
    # Player_Action_29) - its end animation is pz_wait, whose root stands still
    # (one row, the switch); the Zora clip's landing, B held: the end animation is
    # pz_cutterwaitC (the fin aim's) - the switch row is the ~64 jump - to its end.
    land = lambda a0: [(a0[0], a0[1], a0[0], a0[1], False)]
    a0 = roots('pz_jumpATend')[0]
    print('ZORA_PUNCH =', fmt(rows('pz_attackA', 'pz_attackAend', 5)))
    print('ZORA_JUMPKICK_LANDING =', fmt(land(a0) + rows('pz_jumpATend', 'pz_wait', 2, end_frames=0), (-1,)))
    print('ZORA_CLIP_LANDING =', fmt(land(a0) + rows('pz_jumpATend', 'pz_cutterwaitC', 2), (-1,)))
