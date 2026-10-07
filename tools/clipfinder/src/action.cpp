#include "action.h"
#include "json.h"
#include "output.h"

// Generated from the decomps' animation data (link_animetion,
// gPlayerAnim_link_fighter_{normal,pierce,Lnormal,Lpierce}_kiru and their _end)
// by a script replaying z_player.c: each game frame of the lunge from the one
// after the attack starts, { root x, root z, prevTransl x, prevTransl z, speedXZ }.
//  OoT: the first frame's prevTransl is sSkeletonBaseTransl (-57, 3377, 0) x the
//   age's unk_08, a Vec3s (child 11/17: -36): Link steps back first.
//  MM: ANIM_FLAG_NOMOVE zeroes that first diff, so no step back (dropped here).
//  The animation plays 2/3 x 1.5 = 1 frame a game frame; when it ends, the _end
//  animation takes over at 1.5 frames a game frame and its root motion carries on.
//  swing: the frames whose collision runs with the swing active (after the
//   attack actions at curFrame 0 .. endFrame - 1, within the table's unk_0D;
//   the _end switch clears it). Leaving the ground then puts Link back at
//   prevPos, speedXZ zeroed (OoT func_8083AA10, MM func_8083827C; tested in
//   game: OoT Lost Woods, the 2h stab off TRI 974 was put back).
//  MM also puts him back during any root motion when the floor under prevPos
//   is within 10 of him (func_808381F8): see runFrames.
//  Not modelled: the sword hitting a wall from animation frame 2 on
//  (func_80842DF4 / func_808401F4): speedXZ -14, a recoil back.
// The jumpslash's air part isn't a table: see Action::jump and airFrames. The Deku stick (OoT
// child, MM Human) has its own key, stick-slash: it counts as two-handed
// (OoT Player_HoldsTwoHandedWeapon, MM Player_IsHoldingTwoHandedWeapon) and
// always does the forward slash, so it's the 2h slash's frames. OoT child has
// no other two-handed weapon.
// The Deku spins (MM Deku, A on the ground: Player_ActionHandler_6 ->
// func_80839A84, Player_Action_95). No root motion: speedXZ only, each frame
// computed as the game does (floats). From standing still at the start, the
// stick held at full tilt throughout (on flat ground: a floor pitch lowers the
// stick's speed, 6.58 - 8 sin^2 pitch, capped at Deku's run speed 6):
//  deku-spin: running (Player_Action_13, func_8083CB58: speedXZ steps up
//   REG(19) 2.0 a frame to 6): 2, 4, 6; then A - the action handler runs before
//   the speed step, so that frame still moves 6; then the spin.
//  deku-spin-backwalk: Z held, the stick back (Player_Action_6, the parallel
//   backwalk: speed steps up 1.5 a frame to the stick's 6 x 1.5 = 9), Link
//   facing `facing` and moving the other way (angle 0x8000): 1.5 .. 9; then Z let
//   go for a frame (func_8083A844: he turns to face the way he's moving, the
//   speed untouched: 9), then A (9 again), then the spin.
// The spin: func_808373A4 sets unk_B10[0] 20000, unk_B10[1] 0x30000. Each frame
// the target is the stick's speed x (1 - 0.9 (11100 - B10[0]) / 11100) (B10[0]
// before its -800), speedXZ steps to it, up 2.0 / down 1.5 (func_8083CB58);
// the spin ends on the frame B10[1], stepped to 0 by the new B10[0], gets
// there (15 frames). Run up at 6, that's 8, 9.94, 9.55, ...; from the
// backwalk's 9 the first is the whole target, 10.33.
// These are the speeds unobstructed: runFrames works them out again each frame
// (ActionFrame::stick), as touching a wall lowers the stick's speed. In MM's
// Player_UpdateCommon Link moves and the scene collision runs before the action:
// the collision sets unk_B50, the cap on the stick's speed (Player_Calc-
// SpeedAndYawFromControlStick), and the action then sets the speed of the next
// frame's move. Touching a wall on the ground (BGCHECKFLAG_WALL), the cap is the
// run limit x |yaw - (wallYaw + 0x8000)| x 0.00008 when that's under 1 (at least
// 0.1): wallYaw of the wall Player_PosVsWallLineTest hits (from 17.8 up, along
// the shape yaw, wallCheckRadius + 10 out; walls, one face), else of the first wall
// that pushed him (actor.wallPoly: BgCheck_ComputeWallDisplacement only records
// a wall while none is yet - the line test's, else the first push's; the Deku
// Palace corner, 1531 then 1504 pushing, is capped by 1531's). The shape yaw: the move's way when running and from the Z
// release on, the facing while backwalking, and in the spin it turns by B10[0]
// (after its -800) a frame. Indoors (Model::indoors) the run limit is 5.
// Not modelled: a Deku flower floor under him (A goes into the flower).
static double asymStep(double v, double target, double incr, double decr) {
	double step = target >= v ? incr : decr;
	if (target < v) step = -step;
	v = F(v + step);
	return F(F(v - target) * step) >= 0 ? target : v;
}
static vector<ActionFrame> dekuSpinFrames(bool backwalk) {
	vector<ActionFrame> out;
	const int angle = backwalk ? 0x8000 : 0;
	const double stick = 6;  // full stick, capped at Deku's R_RUN_SPEED_LIMIT 600 / 100
	double speed = 0;
	if (backwalk) {
		const double target = F(stick * F(1.5));
		while (speed != target) out.push_back({ 0, 0, 0, 0, speed = asymStep(speed, target, 1.5, 2.0), false, angle, 'B' });
		out.push_back({ 0, 0, 0, 0, speed, false, angle, 'H' });  // Z let go
	} else {
		while (speed != stick) out.push_back({ 0, 0, 0, 0, speed = asymStep(speed, stick, 2.0, 1.5), false, angle, 'R' });
	}
	out.push_back({ 0, 0, 0, 0, speed, false, angle, 'H' });  // A
	double b0 = 20000, b1 = 0x30000;
	for (;;) {
		const double factor = F(1.0 - F(F(0.9) * F(F(11100.0 - b0) / 11100.0)));
		speed = asymStep(speed, F(stick * factor), 2.0, 1.5);
		out.push_back({ 0, 0, 0, 0, speed, false, angle, 'S' });
		b0 = F(b0 - 800);
		const double nb1 = b1 - b0;  // Math_StepToF(&B10[1], 0, B10[0])
		if (nb1 <= 0) break;
		b1 = F(nb1);
	}
	return out;
}

static vector<Action> baseActions() { return {
	{ "1h-slash", "adult lunge 1h slash", "OOT", { "ADULT" }, { { 166, -1066, -57, 0, 0, false }, { -11, -439, 166, -1066, 10, true }, { -90, -441, -11, -439, 5, true }, { -167, -117, -90, -441, 0, true }, { -224, 134, -167, -117, 0, true }, { -223, 126, -224, 134, 0, false }, { -173, 71, -223, 126, 0, false }, { -52, -66, -173, 71, 0, false }, { -5, -86, -52, -66, 0, false }, { 48, -56, -5, -86, 0, false }, { -41, -7, 48, -56, 0, false } } },
	{ "1h-stab", "adult lunge 1h stab", "OOT", { "ADULT" }, { { -48, -1144, -57, 0, 0, false }, { -66, -953, -48, -1144, 10, true }, { -84, -659, -66, -953, 5, true }, { -129, -511, -84, -659, 0, true }, { -178, -458, -129, -511, 0, false }, { -206, -424, -178, -458, 0, false }, { -170, -434, -206, -424, 0, false }, { -142, -421, -170, -434, 0, false }, { -94, -220, -142, -421, 0, false }, { -71, -88, -94, -220, 0, false }, { -58, -7, -71, -88, 0, false } } },
	{ "2h-slash", "adult lunge 2h slash", "OOT", { "ADULT" }, { { -175, -545, -57, 0, 0, false }, { -217, -392, -175, -545, 10, true }, { -261, -244, -217, -392, 5, true }, { -299, -122, -261, -244, 0, true }, { -331, -103, -299, -122, 0, true }, { -337, -150, -331, -103, 0, false }, { -297, -133, -337, -150, 0, false }, { -206, -83, -297, -133, 0, false }, { -167, -61, -206, -83, 0, false }, { -87, -15, -167, -61, 0, false }, { -63, -1, -87, -15, 0, false }, { -57, 2, -63, -1, 0, false } } },
	{ "2h-stab", "adult lunge 2h stab", "OOT", { "ADULT" }, { { -35, 1134, -57, 0, 0, false }, { 76, 1964, -35, 1134, 10, true }, { 123, 2463, 76, 1964, 5, true }, { 123, 2463, 123, 2463, 0, false }, { 104, 2301, 123, 2463, 0, false }, { 21, 1766, 104, 2301, 0, false }, { -7, 1377, 21, 1766, 0, false }, { -39, 475, -7, 1377, 0, false }, { -48, 194, -39, 475, 0, false }, { -57, 2, -48, 194, 0, false } } },
	{ "1h-slash", "child lunge 1h slash", "OOT", { "CHILD" }, { { 166, -1066, -36, 0, 0, false }, { -11, -439, 166, -1066, 10, true }, { -90, -441, -11, -439, 5, true }, { -167, -117, -90, -441, 0, true }, { -224, 134, -167, -117, 0, true }, { -223, 126, -224, 134, 0, false }, { -173, 71, -223, 126, 0, false }, { -52, -66, -173, 71, 0, false }, { -5, -86, -52, -66, 0, false }, { 48, -56, -5, -86, 0, false }, { -41, -7, 48, -56, 0, false } } },
	{ "1h-stab", "child lunge 1h stab", "OOT", { "CHILD" }, { { -48, -1144, -36, 0, 0, false }, { -66, -953, -48, -1144, 10, true }, { -84, -659, -66, -953, 5, true }, { -129, -511, -84, -659, 0, true }, { -178, -458, -129, -511, 0, false }, { -206, -424, -178, -458, 0, false }, { -170, -434, -206, -424, 0, false }, { -142, -421, -170, -434, 0, false }, { -94, -220, -142, -421, 0, false }, { -71, -88, -94, -220, 0, false }, { -58, -7, -71, -88, 0, false } } },
	{ "stick-slash", "child lunge Deku stick slash", "OOT", { "CHILD" }, { { -175, -545, -36, 0, 0, false }, { -217, -392, -175, -545, 10, true }, { -261, -244, -217, -392, 5, true }, { -299, -122, -261, -244, 0, true }, { -331, -103, -299, -122, 0, true }, { -337, -150, -331, -103, 0, false }, { -297, -133, -337, -150, 0, false }, { -206, -83, -297, -133, 0, false }, { -167, -61, -206, -83, 0, false }, { -87, -15, -167, -61, 0, false }, { -63, -1, -87, -15, 0, false }, { -57, 2, -63, -1, 0, false } } },
	{ "1h-slash", "lunge 1h slash", "MM", { "HUMAN" }, { { -11, -439, 166, -1066, 10, true }, { -90, -441, -11, -439, 5, true }, { -167, -117, -90, -441, 0, true }, { -224, 134, -167, -117, 0, true }, { -223, 126, -224, 134, 0, false }, { -173, 71, -223, 126, 0, false }, { -52, -66, -173, 71, 0, false }, { -5, -86, -52, -66, 0, false }, { 48, -56, -5, -86, 0, false }, { -41, -7, 48, -56, 0, false } } },
	{ "1h-stab", "lunge 1h stab", "MM", { "HUMAN" }, { { -66, -953, -48, -1144, 10, true }, { -84, -659, -66, -953, 5, true }, { -129, -511, -84, -659, 0, true }, { -178, -458, -129, -511, 0, false }, { -206, -424, -178, -458, 0, false }, { -170, -434, -206, -424, 0, false }, { -142, -421, -170, -434, 0, false }, { -94, -220, -142, -421, 0, false }, { -71, -88, -94, -220, 0, false }, { -58, -7, -71, -88, 0, false } } },
	{ "2h-slash", "lunge 2h slash", "MM", { "HUMAN" }, { { -217, -392, -175, -545, 10, true }, { -261, -244, -217, -392, 5, true }, { -299, -122, -261, -244, 0, true }, { -331, -103, -299, -122, 0, true }, { -337, -150, -331, -103, 0, false }, { -297, -133, -337, -150, 0, false }, { -206, -83, -297, -133, 0, false }, { -167, -61, -206, -83, 0, false }, { -87, -15, -167, -61, 0, false }, { -63, -1, -87, -15, 0, false }, { -57, 2, -63, -1, 0, false } } },
	{ "2h-stab", "lunge 2h stab", "MM", { "HUMAN" }, { { 76, 1964, -35, 1134, 10, true }, { 123, 2463, 76, 1964, 5, true }, { 123, 2463, 123, 2463, 0, false }, { 104, 2301, 123, 2463, 0, false }, { 21, 1766, 104, 2301, 0, false }, { -7, 1377, 21, 1766, 0, false }, { -39, 475, -7, 1377, 0, false }, { -48, 194, -39, 475, 0, false }, { -57, 2, -48, 194, 0, false } } },
	{ "stick-slash", "lunge Deku stick slash", "MM", { "HUMAN" }, { { -217, -392, -175, -545, 10, true }, { -261, -244, -217, -392, 5, true }, { -299, -122, -261, -244, 0, true }, { -331, -103, -299, -122, 0, true }, { -337, -150, -331, -103, 0, false }, { -297, -133, -337, -150, 0, false }, { -206, -83, -297, -133, 0, false }, { -167, -61, -206, -83, 0, false }, { -87, -15, -167, -61, 0, false }, { -63, -1, -87, -15, 0, false }, { -57, 2, -63, -1, 0, false } } },
	// The jumpslash (Action::jump): the landing slash's rows, from
	// gen_jumpslash_frames.py (Lpower_jump_kiru_hit, then the first frame of its _end,
	// the step back, which shield held cuts short). Row 0 moves at the landing's speed
	// (-1 here). The -fwd keys hold the stick forward in the air (Action::stickForward).
	// One-handed only: the two-handed weapons and the Deku stick jump the same way (only
	// the step back, cut short, differs).
	{ "1h-jumpslash", "adult jumpslash 1h", "OOT", { "ADULT" }, { { -26, 2728, -57, 0, -1, true }, { -26, 2686, -26, 2728, 0, true }, { -25, 2633, -26, 2686, 0, true }, { -25, 2636, -25, 2633, 0, true }, { -25, 2670, -25, 2636, 0, false }, { -25, 2699, -25, 2670, 0, false }, { -25, 2699, -25, 2699, 0, false }, { -24, 2699, -25, 2699, 0, false }, { -24, 2699, -24, 2699, 0, false }, { -24, 2699, -24, 2699, 0, false } }, true, false },
	{ "1h-jumpslash-fwd", "adult jumpslash 1h, stick forward", "OOT", { "ADULT" }, { { -26, 2728, -57, 0, -1, true }, { -26, 2686, -26, 2728, 0, true }, { -25, 2633, -26, 2686, 0, true }, { -25, 2636, -25, 2633, 0, true }, { -25, 2670, -25, 2636, 0, false }, { -25, 2699, -25, 2670, 0, false }, { -25, 2699, -25, 2699, 0, false }, { -24, 2699, -25, 2699, 0, false }, { -24, 2699, -24, 2699, 0, false }, { -24, 2699, -24, 2699, 0, false } }, true, true },
	{ "1h-jumpslash", "child jumpslash 1h", "OOT", { "CHILD" }, { { -26, 2728, -36, 0, -1, true }, { -26, 2686, -26, 2728, 0, true }, { -25, 2633, -26, 2686, 0, true }, { -25, 2636, -25, 2633, 0, true }, { -25, 2670, -25, 2636, 0, false }, { -25, 2699, -25, 2670, 0, false }, { -25, 2699, -25, 2699, 0, false }, { -24, 2699, -25, 2699, 0, false }, { -24, 2699, -24, 2699, 0, false }, { -24, 2699, -24, 2699, 0, false } }, true, false },
	{ "1h-jumpslash-fwd", "child jumpslash 1h, stick forward", "OOT", { "CHILD" }, { { -26, 2728, -36, 0, -1, true }, { -26, 2686, -26, 2728, 0, true }, { -25, 2633, -26, 2686, 0, true }, { -25, 2636, -25, 2633, 0, true }, { -25, 2670, -25, 2636, 0, false }, { -25, 2699, -25, 2670, 0, false }, { -25, 2699, -25, 2699, 0, false }, { -24, 2699, -25, 2699, 0, false }, { -24, 2699, -24, 2699, 0, false }, { -24, 2699, -24, 2699, 0, false } }, true, true },
	{ "1h-jumpslash", "jumpslash 1h", "MM", { "HUMAN" }, { { -26, 2728, -26, 2728, -1, false }, { -26, 2686, -26, 2728, 0, true }, { -25, 2633, -26, 2686, 0, true }, { -25, 2636, -25, 2633, 0, true }, { -25, 2670, -25, 2636, 0, false }, { -25, 2699, -25, 2670, 0, false }, { -25, 2699, -25, 2699, 0, false }, { -24, 2699, -25, 2699, 0, false }, { -24, 2699, -24, 2699, 0, false }, { -24, 2699, -24, 2699, 0, false } }, true, false },
	{ "1h-jumpslash-fwd", "jumpslash 1h, stick forward", "MM", { "HUMAN" }, { { -26, 2728, -26, 2728, -1, false }, { -26, 2686, -26, 2728, 0, true }, { -25, 2633, -26, 2686, 0, true }, { -25, 2636, -25, 2633, 0, true }, { -25, 2670, -25, 2636, 0, false }, { -25, 2699, -25, 2670, 0, false }, { -25, 2699, -25, 2699, 0, false }, { -24, 2699, -25, 2699, 0, false }, { -24, 2699, -24, 2699, 0, false }, { -24, 2699, -24, 2699, 0, false } }, true, true },
	// The Deku spins (dekuSpinFrames). Aimed only at the frames faster than
	// Deku runs (6): slower, a walking clip does it.
	{ "deku-spin", "Deku spin (run up to 6, A)", "MM", { "DEKU" }, dekuSpinFrames(false), false, false, 6.01, true, 6 },
	{ "deku-spin-backwalk", "Deku spin from a backwalk (Z + back to 9, Z off a frame, A)", "MM", { "DEKU" }, dekuSpinFrames(true), false, false, 6.01, true, 6 },
}; }

// MM Zora (zoraActions): tables from gen_mm_attack_frames.py (MM's animation
// data, the game frames emulated; it rebuilds the 1h slash table above exactly).
//  zora-punch: B (PLAYER_MWA_ZORA_PUNCH_LEFT, the first of the combo): no
//   lunge speed, the root motion of pz_attackA (about 35 forward) then its end
//   animation's (about 34 back).
//  zora-jumpslash: Z + A (func_808395F0: Zora x 1.1 speed, x 0.9 velocity.y:
//   5.5, 4.5), in the air -0.8 gravity (after the boots' -1.0 the first frame),
//   no root motion; the landing (PLAYER_MWA_ZORA_JUMPKICK_FINISH) plays
//   pz_jumpATend, then pz_wait, which stands still.
//  zora-clip: the same with B held throughout (the fins out and aimed first):
//   when the landing animation ends, Player_Action_84 calls
//   Player_ActionHandler_8, which starts the fin aim and takes its animation,
//   pz_cutterwaitC, for the lower body too, the root-motion flags kept - the
//   jump from pz_jumpATend's last root to pz_cutterwaitC's first is 64.4
//   forward in one frame, then about 12 more.
// -fwd: the stick and Z held forward in the air, as the jumpslash's. No step
// back to stop (R would be the Zora barrier, which could stop the clip).
static Action zoraAction(const string& key, const string& name, const vector<ActionFrame>& frames, bool jump, bool fwd) {
	Action a;
	a.key = key;
	a.name = name;
	a.game = "MM";
	a.forms = { "ZORA" };
	a.frames = frames;
	a.jump = jump;
	a.stickForward = fwd;
	a.runLimit = 6;
	a.animScale = 1.0;
	a.jumpSpeed = F(5.0 * F(1.1));
	a.jumpVy = F(5.0 * F(0.9));
	a.airGravity = F(-0.8);
	a.airCap = 6;
	return a;
}
static vector<Action> zoraActions() {
	vector<Action> v;
	const vector<ActionFrame> punch = { { -215, 1798, -129, 0, 0, true }, { -270, 2710, -215, 1798, 0, true }, { -314, 3169, -270, 2710, 0, true }, { -330, 3453, -314, 3169, 0, true }, { -275, 3532, -330, 3453, 0, true }, { -206, 3520, -275, 3532, 0, true }, { -206, 3520, -206, 3520, 0, false }, { -198, 3588, -206, 3520, 0, false }, { -153, 3427, -198, 3588, 0, false }, { -118, 2497, -153, 3427, 0, false }, { -46, 818, -118, 2497, 0, false }, { -14, 340, -46, 818, 0, false }, { 0, 150, -14, 340, 0, false } };
	const vector<ActionFrame> kick = { { 0, 0, 0, 0, -1, false }, { 0, 219, 0, 0, 0, true }, { 0, 428, 0, 219, 0, true }, { 0, 376, 0, 428, 0, true }, { 0, 273, 0, 376, 0, false }, { 0, 145, 0, 273, 0, false }, { 0, 15, 0, 145, 0, false }, { 0, -92, 0, 15, 0, false }, { 0, -152, 0, -92, 0, false }, { 0, -120, 0, -152, 0, false }, { 0, -15, 0, -120, 0, false }, { 0, 98, 0, -15, 0, false }, { 0, 150, 0, 98, 0, false }, { 0, 150, 0, 150, 0, false } };
	const vector<ActionFrame> clip = { { 0, 0, 0, 0, -1, false }, { 0, 219, 0, 0, 0, true }, { 0, 428, 0, 219, 0, true }, { 0, 376, 0, 428, 0, true }, { 0, 273, 0, 376, 0, false }, { 0, 145, 0, 273, 0, false }, { 0, 15, 0, 145, 0, false }, { 0, -92, 0, 15, 0, false }, { 0, -152, 0, -92, 0, false }, { 0, -120, 0, -152, 0, false }, { 0, -15, 0, -120, 0, false }, { 0, 98, 0, -15, 0, false }, { 0, 150, 0, 98, 0, false }, { 0, 6593, 0, 150, 0, false }, { 54, 6548, 0, 6593, 0, false }, { 98, 6800, 54, 6548, 0, false }, { 65, 7158, 98, 6800, 0, false }, { 0, 7559, 65, 7158, 0, false }, { 0, 7813, 0, 7559, 0, false }, { 0, 7813, 0, 7813, 0, false } };
	v = {
		zoraAction("zora-punch", "Zora punch", punch, false, false),
		zoraAction("zora-jumpslash", "Zora jumpslash", kick, true, false),
		zoraAction("zora-jumpslash-fwd", "Zora jumpslash, stick forward", kick, true, true),
		zoraAction("zora-clip", "Zora clip (jumpslash, B held: the fins aimed)", clip, true, false),
		zoraAction("zora-clip-fwd", "Zora clip (jumpslash, B held: the fins aimed), stick forward", clip, true, true),
	};
	// (the Zora clip: aimed only with, and counted only on, the ~64 frame (speed ~43):
	// a clip in its air or landing frames is the plain jumpslash's)
	for (Action& a : v) if (a.key.rfind("zora-clip", 0) == 0) a.aimMin = 10;
	return v;
}

// The -walkin variants (the user's idea: Link run into an acute corner first
// wedges him deeper than he can stand, then the attack): the stick held at full
// tilt along the facing from standing still (Z too for the stabs and the
// jumpslash: the run is the same, Player_Action_14), speedXZ stepping up 2 a
// frame to the run limit (OoT 6, MM Human 5.5; a wall touched lowers it, as
// ActionFrame::stick), held for WALKIN_HOLD frames more, then the B / A frame:
// Link still moves at the run speed on it (the game moves him before the
// action runs, in both games' Player_UpdateCommon), then the attack as before.
// Aimed at acute corners only.
static const int WALKIN_HOLD = 6;
// The two-handed spin attack ending with a hostile lock-on (the user's
// request): released (B let go after charging, under 0.85: not the great
// spin; OoT func_80844BE4, MM func_80840CD4) it's PLAYER_MWA_SPIN_ATTACK_2H,
// link_fighter_Lrolling_kiru; Z-targeting an enemy when it ends, the attack
// action's end animation is the hostile lock-on one (unk_8),
// link_anchor_Lrolling_kiru_endR, whose root starts 2214 further forward than
// the spin's ended, the root-motion flags kept: one frame 22.1 forward (OoT;
// MM Human x 11/17: 14.3), then the end animation slides him back ~26.
// -fwd: the stick forward when B is let go: a lunge too (PLAYER_STATE2_30 /
// 40000000, 15 -> 10, then 5). Two-handed only: OoT adult (Biggoron / Giant's
// Knife) and child (the Biggoron Sword on B: the user), MM Human (Great Fairy's
// Sword) - there is no Deku stick spin (the user).
// Tables: gen_mm_attack_frames.py --spin. Facing: the lock-on turns Link to
// the enemy, so the facing has to point at one.
static Action spinLock(const string& key, const string& name, const string& game, const string& form, const vector<ActionFrame>& frames) {
	Action a;
	a.key = key;
	a.name = name;
	a.game = game;
	a.forms = { form };
	a.frames = frames;
	a.noWalkIn = true;
	return a;
}
static vector<Action> spinLockActions() {
	const vector<ActionFrame> mm = { { -162, -22, -172, -143, 0, true }, { -167, 0, -162, -22, 0, true }, { -178, 0, -167, 0, 0, true }, { -178, 0, -178, 0, 0, true }, { -46, 0, -178, 0, 0, true }, { 249, 0, -46, 0, 0, true }, { 250, 0, 249, 0, 0, true }, { 168, 0, 250, 0, 0, true }, { 43, 26, 168, 0, 0, true }, { -56, 0, 43, 26, 0, true }, { -73, -59, -56, 0, 0, true }, { -77, -50, -73, -59, 0, true }, { -71, -13, -77, -50, 0, true }, { -62, 1, -71, -13, 0, true }, { -52, -39, -62, 1, 0, true }, { -52, 2175, -52, -39, 0, false }, { -46, 2105, -52, 2175, 0, false }, { -61, 1484, -46, 2105, 0, false }, { -79, 870, -61, 1484, 0, false }, { -104, -125, -79, 870, 0, false }, { -93, -313, -104, -125, 0, false }, { -17, -478, -93, -313, 0, false }, { 21, -437, -17, -478, 0, false }, { 40, -408, 21, -437, 0, false } };
	const vector<ActionFrame> mmFwd = { { -162, -22, -172, -143, 10, true }, { -167, 0, -162, -22, 5, true }, { -178, 0, -167, 0, 0, true }, { -178, 0, -178, 0, 0, true }, { -46, 0, -178, 0, 0, true }, { 249, 0, -46, 0, 0, true }, { 250, 0, 249, 0, 0, true }, { 168, 0, 250, 0, 0, true }, { 43, 26, 168, 0, 0, true }, { -56, 0, 43, 26, 0, true }, { -73, -59, -56, 0, 0, true }, { -77, -50, -73, -59, 0, true }, { -71, -13, -77, -50, 0, true }, { -62, 1, -71, -13, 0, true }, { -52, -39, -62, 1, 0, true }, { -52, 2175, -52, -39, 0, false }, { -46, 2105, -52, 2175, 0, false }, { -61, 1484, -46, 2105, 0, false }, { -79, 870, -61, 1484, 0, false }, { -104, -125, -79, 870, 0, false }, { -93, -313, -104, -125, 0, false }, { -17, -478, -93, -313, 0, false }, { 21, -437, -17, -478, 0, false }, { 40, -408, 21, -437, 0, false } };
	const vector<ActionFrame> adult = { { -172, -143, -57, 0, 0, false }, { -162, -22, -172, -143, 0, true }, { -167, 0, -162, -22, 0, true }, { -178, 0, -167, 0, 0, true }, { -178, 0, -178, 0, 0, true }, { -46, 0, -178, 0, 0, true }, { 249, 0, -46, 0, 0, true }, { 250, 0, 249, 0, 0, true }, { 168, 0, 250, 0, 0, true }, { 43, 26, 168, 0, 0, true }, { -56, 0, 43, 26, 0, true }, { -73, -59, -56, 0, 0, true }, { -77, -50, -73, -59, 0, true }, { -71, -13, -77, -50, 0, true }, { -62, 1, -71, -13, 0, true }, { -52, -39, -62, 1, 0, true }, { -52, 2175, -52, -39, 0, false }, { -46, 2105, -52, 2175, 0, false }, { -61, 1484, -46, 2105, 0, false }, { -79, 870, -61, 1484, 0, false }, { -104, -125, -79, 870, 0, false }, { -93, -313, -104, -125, 0, false }, { -17, -478, -93, -313, 0, false }, { 21, -437, -17, -478, 0, false }, { 40, -408, 21, -437, 0, false } };
	const vector<ActionFrame> adultFwd = { { -172, -143, -57, 0, 0, false }, { -162, -22, -172, -143, 10, true }, { -167, 0, -162, -22, 5, true }, { -178, 0, -167, 0, 0, true }, { -178, 0, -178, 0, 0, true }, { -46, 0, -178, 0, 0, true }, { 249, 0, -46, 0, 0, true }, { 250, 0, 249, 0, 0, true }, { 168, 0, 250, 0, 0, true }, { 43, 26, 168, 0, 0, true }, { -56, 0, 43, 26, 0, true }, { -73, -59, -56, 0, 0, true }, { -77, -50, -73, -59, 0, true }, { -71, -13, -77, -50, 0, true }, { -62, 1, -71, -13, 0, true }, { -52, -39, -62, 1, 0, true }, { -52, 2175, -52, -39, 0, false }, { -46, 2105, -52, 2175, 0, false }, { -61, 1484, -46, 2105, 0, false }, { -79, 870, -61, 1484, 0, false }, { -104, -125, -79, 870, 0, false }, { -93, -313, -104, -125, 0, false }, { -17, -478, -93, -313, 0, false }, { 21, -437, -17, -478, 0, false }, { 40, -408, 21, -437, 0, false } };
	const vector<ActionFrame> child = { { -172, -143, -36, 0, 0, false }, { -162, -22, -172, -143, 0, true }, { -167, 0, -162, -22, 0, true }, { -178, 0, -167, 0, 0, true }, { -178, 0, -178, 0, 0, true }, { -46, 0, -178, 0, 0, true }, { 249, 0, -46, 0, 0, true }, { 250, 0, 249, 0, 0, true }, { 168, 0, 250, 0, 0, true }, { 43, 26, 168, 0, 0, true }, { -56, 0, 43, 26, 0, true }, { -73, -59, -56, 0, 0, true }, { -77, -50, -73, -59, 0, true }, { -71, -13, -77, -50, 0, true }, { -62, 1, -71, -13, 0, true }, { -52, -39, -62, 1, 0, true }, { -52, 2175, -52, -39, 0, false }, { -46, 2105, -52, 2175, 0, false }, { -61, 1484, -46, 2105, 0, false }, { -79, 870, -61, 1484, 0, false }, { -104, -125, -79, 870, 0, false }, { -93, -313, -104, -125, 0, false }, { -17, -478, -93, -313, 0, false }, { 21, -437, -17, -478, 0, false }, { 40, -408, 21, -437, 0, false } };
	const vector<ActionFrame> childFwd = { { -172, -143, -36, 0, 0, false }, { -162, -22, -172, -143, 10, true }, { -167, 0, -162, -22, 5, true }, { -178, 0, -167, 0, 0, true }, { -178, 0, -178, 0, 0, true }, { -46, 0, -178, 0, 0, true }, { 249, 0, -46, 0, 0, true }, { 250, 0, 249, 0, 0, true }, { 168, 0, 250, 0, 0, true }, { 43, 26, 168, 0, 0, true }, { -56, 0, 43, 26, 0, true }, { -73, -59, -56, 0, 0, true }, { -77, -50, -73, -59, 0, true }, { -71, -13, -77, -50, 0, true }, { -62, 1, -71, -13, 0, true }, { -52, -39, -62, 1, 0, true }, { -52, 2175, -52, -39, 0, false }, { -46, 2105, -52, 2175, 0, false }, { -61, 1484, -46, 2105, 0, false }, { -79, 870, -61, 1484, 0, false }, { -104, -125, -79, 870, 0, false }, { -93, -313, -104, -125, 0, false }, { -17, -478, -93, -313, 0, false }, { 21, -437, -17, -478, 0, false }, { 40, -408, 21, -437, 0, false } };
	return {
		spinLock("2h-spin-lock", "adult 2h spin attack, locked on", "OOT", "ADULT", adult),
		spinLock("2h-spin-lock-fwd", "adult 2h spin attack, locked on, stick forward", "OOT", "ADULT", adultFwd),
		spinLock("2h-spin-lock", "child 2h spin attack (Biggoron Sword), locked on", "OOT", "CHILD", child),
		spinLock("2h-spin-lock-fwd", "child 2h spin attack (Biggoron Sword), locked on, stick forward", "OOT", "CHILD", childFwd),
		spinLock("2h-spin-lock", "2h spin attack, locked on", "MM", "HUMAN", mm),
		spinLock("2h-spin-lock-fwd", "2h spin attack, locked on, stick forward", "MM", "HUMAN", mmFwd),
	};
}

// -r: the locked-on spin's step back (~26 over the end animation's frames) cut
// short (the user's request): Z held through the frame the attack switches to
// its end animation (the lock-on picks the endR one then), then Z let go and R
// held. The switch row, the jump, still happens; the next frame
// Player_Action_Idle's handlers raise the shield - the full-body shield action
// (Player_ActionHandler_11), a new action, so Player_SetupAction ends the root
// motion - but only with no lock-on (!Player_FriendlyLockOnOrParallel,
// focusActor NULL): still locked on, R only raises it on the upper body
// (OoT func_80834758) and the step back plays out (the user saw that). So the
// rows stop at the jump. (At the switch the attack action only calls
// Player_ActionHandler_7, the B combo.)
static vector<Action> spinLockRActions() {
	const vector<ActionFrame> mm = { { -162, -22, -172, -143, 0, true }, { -167, 0, -162, -22, 0, true }, { -178, 0, -167, 0, 0, true }, { -178, 0, -178, 0, 0, true }, { -46, 0, -178, 0, 0, true }, { 249, 0, -46, 0, 0, true }, { 250, 0, 249, 0, 0, true }, { 168, 0, 250, 0, 0, true }, { 43, 26, 168, 0, 0, true }, { -56, 0, 43, 26, 0, true }, { -73, -59, -56, 0, 0, true }, { -77, -50, -73, -59, 0, true }, { -71, -13, -77, -50, 0, true }, { -62, 1, -71, -13, 0, true }, { -52, -39, -62, 1, 0, true }, { -52, 2175, -52, -39, 0, false } };
	const vector<ActionFrame> mmFwd = { { -162, -22, -172, -143, 10, true }, { -167, 0, -162, -22, 5, true }, { -178, 0, -167, 0, 0, true }, { -178, 0, -178, 0, 0, true }, { -46, 0, -178, 0, 0, true }, { 249, 0, -46, 0, 0, true }, { 250, 0, 249, 0, 0, true }, { 168, 0, 250, 0, 0, true }, { 43, 26, 168, 0, 0, true }, { -56, 0, 43, 26, 0, true }, { -73, -59, -56, 0, 0, true }, { -77, -50, -73, -59, 0, true }, { -71, -13, -77, -50, 0, true }, { -62, 1, -71, -13, 0, true }, { -52, -39, -62, 1, 0, true }, { -52, 2175, -52, -39, 0, false } };
	const vector<ActionFrame> adult = { { -172, -143, -57, 0, 0, false }, { -162, -22, -172, -143, 0, true }, { -167, 0, -162, -22, 0, true }, { -178, 0, -167, 0, 0, true }, { -178, 0, -178, 0, 0, true }, { -46, 0, -178, 0, 0, true }, { 249, 0, -46, 0, 0, true }, { 250, 0, 249, 0, 0, true }, { 168, 0, 250, 0, 0, true }, { 43, 26, 168, 0, 0, true }, { -56, 0, 43, 26, 0, true }, { -73, -59, -56, 0, 0, true }, { -77, -50, -73, -59, 0, true }, { -71, -13, -77, -50, 0, true }, { -62, 1, -71, -13, 0, true }, { -52, -39, -62, 1, 0, true }, { -52, 2175, -52, -39, 0, false } };
	const vector<ActionFrame> adultFwd = { { -172, -143, -57, 0, 0, false }, { -162, -22, -172, -143, 10, true }, { -167, 0, -162, -22, 5, true }, { -178, 0, -167, 0, 0, true }, { -178, 0, -178, 0, 0, true }, { -46, 0, -178, 0, 0, true }, { 249, 0, -46, 0, 0, true }, { 250, 0, 249, 0, 0, true }, { 168, 0, 250, 0, 0, true }, { 43, 26, 168, 0, 0, true }, { -56, 0, 43, 26, 0, true }, { -73, -59, -56, 0, 0, true }, { -77, -50, -73, -59, 0, true }, { -71, -13, -77, -50, 0, true }, { -62, 1, -71, -13, 0, true }, { -52, -39, -62, 1, 0, true }, { -52, 2175, -52, -39, 0, false } };
	const vector<ActionFrame> childR = { { -172, -143, -36, 0, 0, false }, { -162, -22, -172, -143, 0, true }, { -167, 0, -162, -22, 0, true }, { -178, 0, -167, 0, 0, true }, { -178, 0, -178, 0, 0, true }, { -46, 0, -178, 0, 0, true }, { 249, 0, -46, 0, 0, true }, { 250, 0, 249, 0, 0, true }, { 168, 0, 250, 0, 0, true }, { 43, 26, 168, 0, 0, true }, { -56, 0, 43, 26, 0, true }, { -73, -59, -56, 0, 0, true }, { -77, -50, -73, -59, 0, true }, { -71, -13, -77, -50, 0, true }, { -62, 1, -71, -13, 0, true }, { -52, -39, -62, 1, 0, true }, { -52, 2175, -52, -39, 0, false } };
	const vector<ActionFrame> childFwdR = { { -172, -143, -36, 0, 0, false }, { -162, -22, -172, -143, 10, true }, { -167, 0, -162, -22, 5, true }, { -178, 0, -167, 0, 0, true }, { -178, 0, -178, 0, 0, true }, { -46, 0, -178, 0, 0, true }, { 249, 0, -46, 0, 0, true }, { 250, 0, 249, 0, 0, true }, { 168, 0, 250, 0, 0, true }, { 43, 26, 168, 0, 0, true }, { -56, 0, 43, 26, 0, true }, { -73, -59, -56, 0, 0, true }, { -77, -50, -73, -59, 0, true }, { -71, -13, -77, -50, 0, true }, { -62, 1, -71, -13, 0, true }, { -52, -39, -62, 1, 0, true }, { -52, 2175, -52, -39, 0, false } };
	return {
		spinLock("2h-spin-lock-r", "adult 2h spin attack, locked on, R held", "OOT", "ADULT", adult),
		spinLock("2h-spin-lock-fwd-r", "adult 2h spin attack, locked on, stick forward, R held", "OOT", "ADULT", adultFwd),
		spinLock("2h-spin-lock-r", "child 2h spin attack (Biggoron Sword), locked on, R held", "OOT", "CHILD", childR),
		spinLock("2h-spin-lock-fwd-r", "child 2h spin attack (Biggoron Sword), locked on, stick forward, R held", "OOT", "CHILD", childFwdR),
		spinLock("2h-spin-lock-r", "2h spin attack, locked on, R held", "MM", "HUMAN", mm),
		spinLock("2h-spin-lock-fwd-r", "2h spin attack, locked on, stick forward, R held", "MM", "HUMAN", mmFwd),
	};
}

// The plain spin attacks (the user's request), released with the stick forward
// (the lunge: 15 -> 10, then 5 - the large move at the spin's start the user saw
// without targeting) and no lock-on: the ordinary end animation. One-handed:
// PLAYER_MWA_SPIN_ATTACK_1H (link_fighter_rolling_kiru, unk_D 12); two-handed:
// SPIN_ATTACK_2H (Lrolling_kiru, unk_D 15). No Deku stick spin (the user).
// Tables: gen_mm_attack_frames.py --spin.
static vector<Action> spinFwdActions() {
	const vector<ActionFrame> mm1 = { { -173, -6, -157, -6, 10, true }, { -170, -6, -173, -6, 5, true }, { 58, 4, -170, -6, 0, true }, { 242, 11, 58, 4, 0, true }, { 189, 9, 242, 11, 0, true }, { 86, 5, 189, 9, 0, true }, { -63, 0, 86, 5, 0, true }, { -152, -3, -63, 0, 0, true }, { -169, -4, -152, -3, 0, true }, { -165, -4, -169, -4, 0, true }, { -168, -4, -165, -4, 0, true }, { -167, -4, -168, -4, 0, true }, { -161, -4, -167, -4, 0, false }, { -146, -3, -161, -4, 0, false }, { -54, 0, -146, -3, 0, false }, { 2, 2, -54, 0, 0, false }, { 83, 4, 2, 2, 0, false }, { 85, 4, 83, 4, 0, false }, { 35, 2, 85, 4, 0, false }, { 11, 1, 35, 2, 0, false }, { -49, -1, 11, 1, 0, false }, { -76, -2, -49, -1, 0, false }, { -97, -3, -76, -2, 0, false } };
	const vector<ActionFrame> mm2 = { { -162, -22, -172, -143, 10, true }, { -167, 0, -162, -22, 5, true }, { -178, 0, -167, 0, 0, true }, { -178, 0, -178, 0, 0, true }, { -46, 0, -178, 0, 0, true }, { 249, 0, -46, 0, 0, true }, { 250, 0, 249, 0, 0, true }, { 168, 0, 250, 0, 0, true }, { 43, 26, 168, 0, 0, true }, { -56, 0, 43, 26, 0, true }, { -73, -59, -56, 0, 0, true }, { -77, -50, -73, -59, 0, true }, { -71, -13, -77, -50, 0, true }, { -62, 1, -71, -13, 0, true }, { -52, -39, -62, 1, 0, true }, { -83, 42, -52, -39, 0, false }, { -96, 51, -83, 42, 0, false }, { -117, 45, -96, 51, 0, false }, { -122, 38, -117, 45, 0, false }, { -103, 33, -122, 38, 0, false }, { -24, 28, -103, 33, 0, false }, { 34, 14, -24, 28, 0, false }, { -53, 6, 34, 14, 0, false }, { -105, 3, -53, 6, 0, false } };
	const vector<ActionFrame> adult1 = { { -157, -6, -57, 0, 0, false }, { -173, -6, -157, -6, 10, true }, { -170, -6, -173, -6, 5, true }, { 58, 4, -170, -6, 0, true }, { 242, 11, 58, 4, 0, true }, { 189, 9, 242, 11, 0, true }, { 86, 5, 189, 9, 0, true }, { -63, 0, 86, 5, 0, true }, { -152, -3, -63, 0, 0, true }, { -169, -4, -152, -3, 0, true }, { -165, -4, -169, -4, 0, true }, { -168, -4, -165, -4, 0, true }, { -167, -4, -168, -4, 0, true }, { -161, -4, -167, -4, 0, false }, { -146, -3, -161, -4, 0, false }, { -54, 0, -146, -3, 0, false }, { 2, 2, -54, 0, 0, false }, { 83, 4, 2, 2, 0, false }, { 85, 4, 83, 4, 0, false }, { 35, 2, 85, 4, 0, false }, { 11, 1, 35, 2, 0, false }, { -49, -1, 11, 1, 0, false }, { -76, -2, -49, -1, 0, false }, { -97, -3, -76, -2, 0, false } };
	const vector<ActionFrame> adult2 = { { -172, -143, -57, 0, 0, false }, { -162, -22, -172, -143, 10, true }, { -167, 0, -162, -22, 5, true }, { -178, 0, -167, 0, 0, true }, { -178, 0, -178, 0, 0, true }, { -46, 0, -178, 0, 0, true }, { 249, 0, -46, 0, 0, true }, { 250, 0, 249, 0, 0, true }, { 168, 0, 250, 0, 0, true }, { 43, 26, 168, 0, 0, true }, { -56, 0, 43, 26, 0, true }, { -73, -59, -56, 0, 0, true }, { -77, -50, -73, -59, 0, true }, { -71, -13, -77, -50, 0, true }, { -62, 1, -71, -13, 0, true }, { -52, -39, -62, 1, 0, true }, { -83, 42, -52, -39, 0, false }, { -96, 51, -83, 42, 0, false }, { -117, 45, -96, 51, 0, false }, { -122, 38, -117, 45, 0, false }, { -103, 33, -122, 38, 0, false }, { -24, 28, -103, 33, 0, false }, { 34, 14, -24, 28, 0, false }, { -53, 6, 34, 14, 0, false }, { -105, 3, -53, 6, 0, false } };
	const vector<ActionFrame> child1 = { { -157, -6, -36, 0, 0, false }, { -173, -6, -157, -6, 10, true }, { -170, -6, -173, -6, 5, true }, { 58, 4, -170, -6, 0, true }, { 242, 11, 58, 4, 0, true }, { 189, 9, 242, 11, 0, true }, { 86, 5, 189, 9, 0, true }, { -63, 0, 86, 5, 0, true }, { -152, -3, -63, 0, 0, true }, { -169, -4, -152, -3, 0, true }, { -165, -4, -169, -4, 0, true }, { -168, -4, -165, -4, 0, true }, { -167, -4, -168, -4, 0, true }, { -161, -4, -167, -4, 0, false }, { -146, -3, -161, -4, 0, false }, { -54, 0, -146, -3, 0, false }, { 2, 2, -54, 0, 0, false }, { 83, 4, 2, 2, 0, false }, { 85, 4, 83, 4, 0, false }, { 35, 2, 85, 4, 0, false }, { 11, 1, 35, 2, 0, false }, { -49, -1, 11, 1, 0, false }, { -76, -2, -49, -1, 0, false }, { -97, -3, -76, -2, 0, false } };
	const vector<ActionFrame> child2 = { { -172, -143, -36, 0, 0, false }, { -162, -22, -172, -143, 10, true }, { -167, 0, -162, -22, 5, true }, { -178, 0, -167, 0, 0, true }, { -178, 0, -178, 0, 0, true }, { -46, 0, -178, 0, 0, true }, { 249, 0, -46, 0, 0, true }, { 250, 0, 249, 0, 0, true }, { 168, 0, 250, 0, 0, true }, { 43, 26, 168, 0, 0, true }, { -56, 0, 43, 26, 0, true }, { -73, -59, -56, 0, 0, true }, { -77, -50, -73, -59, 0, true }, { -71, -13, -77, -50, 0, true }, { -62, 1, -71, -13, 0, true }, { -52, -39, -62, 1, 0, true }, { -83, 42, -52, -39, 0, false }, { -96, 51, -83, 42, 0, false }, { -117, 45, -96, 51, 0, false }, { -122, 38, -117, 45, 0, false }, { -103, 33, -122, 38, 0, false }, { -24, 28, -103, 33, 0, false }, { 34, 14, -24, 28, 0, false }, { -53, 6, 34, 14, 0, false }, { -105, 3, -53, 6, 0, false } };
	return {
		spinLock("1h-spin-fwd", "adult 1h spin attack, stick forward", "OOT", "ADULT", adult1),
		spinLock("2h-spin-fwd", "adult 2h spin attack, stick forward", "OOT", "ADULT", adult2),
		spinLock("1h-spin-fwd", "child 1h spin attack, stick forward", "OOT", "CHILD", child1),
		spinLock("2h-spin-fwd", "child 2h spin attack (Biggoron Sword), stick forward", "OOT", "CHILD", child2),
		spinLock("1h-spin-fwd", "1h spin attack, stick forward", "MM", "HUMAN", mm1),
		spinLock("2h-spin-fwd", "2h spin attack, stick forward", "MM", "HUMAN", mm2),
	};
}

// Lunge storage (-ls; the user's request): the lunge flag (OoT
// PLAYER_STATE2_30, MM PLAYER_STATE2_40000000: set by an attack started with
// the stick forward, or a spin released with it) is only cleared where it
// fires, on an attack action's first frame (OoT Player_Action_808502D0, MM
// Player_Action_84: LinkAnimation_OnFrame(0) -> speedXZ 15). If that block is
// skipped - e.g. the sword's wall recoil (func_80842DF4) returns first - the
// flag stays until the next attack: the jumpslash's landing attack then
// lunges. Its first action frame sets 15, stepped to 10 at once, then 5: the
// landing table's rows 1 and 2 (row 0 is the landing frame's own move).
static Action lungeStored(const Action& j) {
	Action a = j;
	a.key += "-ls";
	a.name += ", lunge stored";
	a.frames[1].speed = 10;
	a.frames[2].speed = 5;
	return a;
}

static Action walkInVariant(const Action& a) {
	Action w = a;
	w.key += "-walkin";
	w.name += ", run into a corner first";
	w.runLimit = a.game == "MM" && a.forms[0] == "HUMAN" ? 5.5 : 6;  // (R_RUN_SPEED_LIMIT: MM Human 550, Zora / OoT 600)
	double speed = 0;
	while (speed != w.runLimit) w.pre.push_back({ 0, 0, 0, 0, speed = asymStep(speed, w.runLimit, 2.0, 1.5), false, 0, 'R' });
	for (int i = 0; i < WALKIN_HOLD; i++) w.pre.push_back({ 0, 0, 0, 0, speed, false, 0, 'R' });
	// B / A: its move is at the speed the last run frame's action set, capped by
	// the wall that frame touched like any run frame's ('R'; with 'H' it ran at
	// the uncapped speed: Deku Palace 0x5272, the game 5.13, clipfinder 5.5)
	w.pre.push_back({ 0, 0, 0, 0, speed, false, 0, 'R' });
	// then a frame standing still: the attack's setup zeroes speedXZ and its
	// lunge (15 -> 10) is only set by the attack action at the end of the next
	// frame, so that frame moves him nowhere and the walls push him back out of
	// the corner (Deku Palace 0x5200: the game's gf+2 is exactly that, and gf+3
	// the lunge from there). From a standing start the frame does nothing; the
	// jumpslash leaves the ground on the press (its setup sets the jump speed)
	if (!a.jump) w.pre.push_back({ 0, 0, 0, 0, 0, false, 0, 0 });
	w.corners = w.cornersOnly = true;
	return w;
}
static vector<Action> buildActions() {
	vector<Action> v = baseActions();
	for (const Action& z : zoraActions()) v.push_back(z);
	{
		// (the Human / adult / child jumpslashes, not Zora's: its attacks don't lunge)
		const size_t nb = v.size();
		for (size_t i = 0; i < nb; i++) if (v[i].jump && v[i].forms[0] != "ZORA") v.push_back(lungeStored(v[i]));
	}
	for (const Action& s : spinLockActions()) v.push_back(s);
	for (const Action& s : spinLockRActions()) v.push_back(s);
	for (const Action& s : spinFwdActions()) v.push_back(s);
	const size_t n = v.size();
	for (size_t i = 0; i < n; i++)
		if (!v[i].noWalkIn && !std::any_of(v[i].frames.begin(), v[i].frames.end(), [](const ActionFrame& f) { return f.stick != 0; })) v.push_back(walkInVariant(v[i]));
	return v;
}
vector<Action> ACTIONS = buildActions();

// MM3D: no decomp to work the actions out from, so they're measured in the
// game: tools/clipfinder/tools/mm3d_action_recorder.lua does each one from a standing
// start on open ground and writes <key>.json, the rows as it saw them (each
// game frame: the root motion added after the last frame's bg check, in Link's
// frame, then the speedXZ move, at an angle from his facing). Swept here like
// the N64 rows (actionStep). The swing frames aren't measured (a row's "swing"
// if the file has it), but MM's root-motion ledge revert covers the lunges'
// every frame (runFrames). Not modelled: the stick speed's wall cap in the Deku
// spins (their speeds are as recorded, unobstructed).
bool loadRecordedActions(const string& dir, const string& game, string& err) {
	std::error_code ec;
	if (!std::filesystem::is_directory(dir, ec)) return true;
	vector<std::filesystem::path> files;
	for (const auto& e : std::filesystem::directory_iterator(dir, ec))
		if (e.path().extension() == ".json") files.push_back(e.path());
	std::sort(files.begin(), files.end());
	for (const auto& path : files) {
		std::ifstream in(path, std::ios::binary);
		const string text((std::istreambuf_iterator<char>(in)), std::istreambuf_iterator<char>());
		try {
			JParser p(text);
			const JVal root = p.val();
			auto str = [&](const char* k) { const JVal* v = root.get(k); return v && v->kind == JVal::Str ? v->s : string(); };
			auto num = [](const JVal* v, double def) { return v && v->kind == JVal::Num ? v->n : def; };
			if (str("game") != game) continue;
			Action a;
			a.key = str("key");
			a.name = str("name") + " (recorded)";
			a.game = game;
			a.forms = { str("form") };
			a.recorded = true;
			a.noWalkIn = true;
			a.aimMin = num(root.get("aimMin"), 2);
			a.pressRow = (int)num(root.get("pressRow"), -1);
			const JVal* rows = root.get("rows");
			if (a.key.empty() || a.forms[0].empty() || !rows || rows->kind != JVal::Arr || rows->a.empty())
				throw std::runtime_error("needs key, form and rows");
			for (const JVal& r : rows->a) {
				ActionFrame f{ 0, 0, 0, 0, F(num(r.get("speed"), 0)), false, (int)num(r.get("angle"), 0) & 0xFFFF };
				f.rx = F(num(r.get("rx"), 0));
				if (const JVal* sh = r.get("shape"); sh && sh->kind == JVal::Num) f.shape = ((int)sh->n - (int)num(root.get("facing"), 0)) & 0xFFFF;
				f.rz = F(num(r.get("rz"), 0));
				const JVal* sw = r.get("swing");
				f.swing = sw && sw->kind == JVal::Bool && sw->b;
				a.frames.push_back(f);
			}
			// (the Deku spins: stopping part way, and aimed at acute corners too, as the N64 ones)
			if (a.key.rfind("deku-spin", 0) == 0) a.canStop = a.corners = true;
			// (a new take of the same key replaces nothing here: one file a key)
			ACTIONS.push_back(a);
		} catch (const std::exception& ex) {
			err = path.string() + ": " + ex.what();
			return false;
		}
	}
	return true;
}

static const double ACTION_SCALE = F(0.01);

V3 actionStep(const Action& a, const ActionFrame& f, const V3& pos, int facing, bool noSpeed, double speed) {
	const double sn = sinS(facing), cs = cosS(facing);
	double dx, dz;
	if (a.recorded) {
		dx = F(F(f.rx * cs) + F(f.rz * sn));
		dz = F(F(f.rz * cs) - F(f.rx * sn));
	} else if (a.game == "MM") {
		const double x = F(f.jx - f.px), z = F(f.jz - f.pz);
		dx = F(F(F(x * cs) + F(z * sn)) * ACTION_SCALE);
		dz = F(F(F(z * cs) - F(x * sn)) * ACTION_SCALE);
		dx = F(dx * F(a.animScale));  // (ageProperties->unk_08, Action::animScale)
		dz = F(dz * F(a.animScale));
	} else {
		dx = F(F(F(f.jx * cs) + F(f.jz * sn)) - F(F(f.px * cs) + F(f.pz * sn)));
		dz = F(F(F(f.jz * cs) - F(f.jx * sn)) - F(F(f.pz * cs) - F(f.px * sn)));
		dx = F(dx * ACTION_SCALE);
		dz = F(dz * ACTION_SCALE);
	}
	V3 p = { F(pos.x + dx), pos.y, F(pos.z + dz) };
	return noSpeed ? V3{ p.x, F(p.y - GROUND_DROP), p.z } : moveStep(p, (facing + f.angle) & 0xFFFF, F(std::isnan(speed) ? std::max(f.speed, 0.0) : speed));
}

bool anyJump(const vector<int>& actions) {
	return std::any_of(actions.begin(), actions.end(), [](int i) { return ACTIONS[i].jump; });
}

// The jumpslash in the air (Action::jump)
static const double JUMP_GRAVITY0 = F(-100 / 100.0);  // REG(68) / 100.0f, the Kokiri boots' (MM: Human's)
static const double JUMP_AIR_DECEL = F(0.1);  // Math_AsymStepToF(&speedXZ, target, 0.05, 0.1): the stick left alone (target 0)
static const double JUMP_AIR_ACCEL = F(0.05); // ... held forward (a target above 5)
static const double MIN_VELOCITY_Y = -20;     // actor.minVelocityY
static const int JUMP_MAX_AIR = 60;           // frames in the air before giving up (falling out)

// One air frame's physics (Actor_UpdateVelocityXZGravity, Actor_UpdatePos):
// velocity.y takes the gravity first, then posNext = pos + velocity x 1.5
static double airVy(double vy, double g) { vy = F(vy + g); return vy < MIN_VELOCITY_Y ? MIN_VELOCITY_Y : vy; }
// The air action's speedXZ step (func_8083DFE0 / MM func_8083CBC4)
static double airSpeed(const Action& a, double speed) {
	if (!a.stickForward) return std::max(0.0, (double)F(speed - JUMP_AIR_DECEL));
	// full stick: 60 x 0.8 x 0.14, capped at the run speed limit in the air
	const double target = std::min((double)F(F(60 * F(0.8)) * F(0.14)), a.airCap > 0 ? a.airCap : a.game == "MM" ? 10.0 : 6.0);
	return std::min(target, (double)F(speed + JUMP_AIR_ACCEL));
}
static V3 airNext(const V3& pos, int facing, double speed, double vy) {
	const V3 n = moveStep(pos, facing, speed);
	return { n.x, F(pos.y + F(vy * SPEED_RATE)), n.z };
}

// The action's frames unobstructed on flat ground (y 0) from (0, 0, 0): each
// frame's posNext. For aiming (actionScan).
static vector<V3> nominalFrames(const Action& a, int facing) {
	vector<V3> out;
	V3 pos = { 0, 0, 0 };
	double landSpeed = 0, firstY = -GROUND_DROP;
	for (const ActionFrame& f : a.pre) {
		const V3 n = actionStep(a, f, pos, facing);
		out.push_back(n);
		pos = { n.x, 0, n.z };
	}
	if (a.jump) {
		const double gAir = F(a.airGravity);
		double vy = F(a.jumpVy), g = JUMP_GRAVITY0, speed = F(a.jumpSpeed);
		for (int k = 0; k < JUMP_MAX_AIR; k++) {
			vy = airVy(vy, g);
			const V3 n = airNext(pos, facing, speed, vy);
			out.push_back(n);
			if (n.y <= 0 && vy <= 0) {
				landSpeed = std::max(0.0, (double)F(speed - 1));
				firstY = F(F(airVy(vy, gAir)) * SPEED_RATE);
				pos = { n.x, 0, n.z };
				break;
			}
			pos = n;
			g = gAir;
			speed = airSpeed(a, speed);
		}
	}
	for (size_t i = 0; i < a.frames.size(); i++) {
		const ActionFrame& f = a.frames[i];
		V3 n = actionStep(a, f, pos, facing, false, f.speed < 0 ? landSpeed : NAN);
		if (a.jump && i == 0) n.y = firstY;
		out.push_back(n);
		pos = { n.x, 0, n.z };
	}
	return out;
}

void actionFrameMove(const Action& a, const ActionFrame& f, double& speed, int& angle) {
	const V3 d = actionStep(a, f, { 0, GROUND_DROP, 0 }, 0);
	speed = std::hypot(d.x, d.z) / SPEED_RATE;
	angle = speed > 0 ? yawOf(d.x, d.z) : 0;
}

vector<int> parseActions(const string& game, const string& list, string& err) {
	vector<int> out;
	for (size_t a = 0; a <= list.size();) {
		size_t b = list.find(',', a);
		if (b == string::npos) b = list.size();
		string k = list.substr(a, b - a);
		a = b + 1;
		if (k.empty()) continue;
		bool any = false;
		for (size_t i = 0; i < ACTIONS.size(); i++) {
			if (ACTIONS[i].game != game || (k != "all" && k != ACTIONS[i].key)) continue;
			if (std::find(out.begin(), out.end(), (int)i) == out.end()) out.push_back((int)i);
			any = true;
		}
		if (!any) {
			err = "unknown action \"" + k + "\" for " + game + " (";
			for (const Action& x : ACTIONS) if (x.game == game) err += x.key + ", ";
			err += "or all)";
			return {};
		}
	}
	return out;
}

bool actionForForm(const Action& a, const string& formUpper) {
	return std::find(a.forms.begin(), a.forms.end(), formUpper) != a.forms.end();
}

namespace {
struct FrameOut {
	V3 prev, next, res;
	PushList trace;
	bool landed = false;
	double landY = 0;
	int floorPoly = -1;
	bool reverted = false;  // off the ground during the swing: put back at prev
	bool air = false;       // a jumpslash frame in the air (landed: the one he lands on)
	double vy = 0;          // (air) velocity.y for the frame
};

// The jumpslash's frames in the air (Action::jump), from `start` until the
// floor check puts him on a floor falling (velocity.y <= 0): the move at the
// frame's speedXZ and velocity.y, the line test or pushes at posNext, the
// floor check from prevPos.y + 50, which also lifts him onto a floor he's
// under while rising, without landing (func_8002E2AC). False if he never
// lands (JUMP_MAX_AIR frames). Else pos is where he lands, landSpeed the
// landing slash's first speedXZ and firstY that frame's posNext.y.
static bool airFrames(const Model& m, Scratch& s, const Action& a, const V3& start, int facing, const Tol& tol, vector<FrameOut>& out,
	V3& pos, double& landSpeed, double& firstY) {
	const double gAir = F(a.airGravity);
	double vy = F(a.jumpVy), g = JUMP_GRAVITY0, speed = F(a.jumpSpeed);
	pos = start;
	for (int k = 0; k < JUMP_MAX_AIR; k++) {
		vy = airVy(vy, g);
		FrameOut& o = out.emplace_back();
		o.air = true;
		o.vy = vy;
		o.prev = pos;
		o.next = airNext(pos, facing, speed, vy);
		if (auto lf = lineFrame(m, s, pos, o.next, tol)) { o.res = lf->res; o.trace = lf->trace; }
		else o.res = m.sphereStep(o.next, tol, &o.trace, &pos);
		auto fy = m.floorCheck(o.res.x, o.res.z, F(pos.y + 50), &o.floorPoly);
		if (fy && F(*fy - o.res.y) >= 0) {
			o.res.y = *fy;
			if (vy <= 0) {
				o.landed = true;
				o.landY = *fy;
				pos = { o.res.x, *fy, o.res.z };
				landSpeed = std::max(0.0, (double)F(speed - 1));
				firstY = F(pos.y + F(airVy(vy, gAir) * SPEED_RATE));
				return true;
			}
		}
		pos = o.res;
		g = gAir;
		speed = airSpeed(a, speed);
	}
	return false;
}

// The cap on the stick's speed after a frame on the ground (ActionFrame::stick):
// touching a wall (any push), from the wall in front of him or the first one that
// pushed him (see dekuSpinFrames)
static double stickCap(const Model& m, Scratch& s, const V3& pos, const PushList& trace, int yaw, int shape, double limit) {
	if (trace.empty()) return limit;
	int wall = trace[0].poly;
	const double r = F(m.radius + 10);
	const V3 a = { pos.x, F(pos.y + F(178.0f * 0.1f)), pos.z };
	const V3 b = { F(pos.x + F(r * sinS(shape))), a.y, F(pos.z + F(r * cosS(shape))) };
	if (auto h = m.lineHit(s, a, b, LOOSE, false, true)) wall = h->poly;
	const Poly& w = m.polys[wall];
	const int wallYaw = yawOf(w.sx, w.sz);
	const double scale = F(std::abs((int)(int16_t)(yaw - ((wallYaw + 0x8000) & 0xFFFF))) * F(0.00008));
	if (scale >= 1) return limit;
	return std::max((double)F(0.1), (double)F(limit * scale));
}

// MM3D's recorded Deku spins were recorded on flat ground. On a slope
// Player_GetMovementSpeedAndYaw's stick target is stick x 0.14 (6.72 at full
// tilt) - 8 sin^2(floorPitch), at most 6, floorPitch the floor's pitch along
// his move yaw (Player_UpdateCommon, from the floor the last frame's bg check
// found). The user's backwalk up Laundry Pool's ramp (TRI 135) topped out at
// 8.022 = (6.72 - 1.38) x 1.5, as this gives. The rows' speeds (each row's
// move, the speedXZ the frame before) then: before pressRow, the run up,
// limited by the target (x 1.5 backwalking); pressRow through spinRow, kept (L
// let go: he turns; A); after spinRow, the spin's target - the recording's decay
// line, extended back over the rows it was still speeding up on - scaled by
// target / 6, stepped to at +0.4 / -2.0 a frame (+0.4 as recorded; -2.0 as
// the user's MM3D runs show it).
// The wall cap (unk_B50, dekuCap) on the spin's speed updates. In a game frame
// Link moves and collides first (Player_UpdateCommon: func_80844784,
// Player_ProcessSceneCollision), then his action sets the next speed, with the
// stick target clamped to unk_B50 (Player_GetMovementSpeedAndYaw) and the spin
// multiplying it by its factor. unk_B50 = 6 x |move yaw - (wallYaw + 0x8000)| x
// 0.00008 (under 1). N64 MM sets it only on a frame a wall pushed him
// (BGCHECKFLAG_WALL), wallYaw from the line wall check radius + 10 ahead along
// his shape if it hits, else the pusher. The user's MM3D runs into Laundry
// Pool's corner fit another rule: capped whenever that line hits a wall, pushed
// or not, and not otherwise - pressed into TRI 27 with the line along his
// spinning shape elsewhere he sped up (7.0 -> 7.4 -> 7.8), and stopping 0.3
// short of the walls with the line along his move yaw reaching TRI 27 / 28 he
// was capped (6.98 -> 4.98). So that's what's modelled, on every spin update
// (the line along his shape going into the frame: his move yaw on the first,
// the recording's spinning shape after).
struct DekuSpeeds { int pressRow = -1, spinRow = -1; size_t peak = 0; double decay = 0; bool back = false; };
DekuSpeeds dekuSpeeds(const Action& a) {
	DekuSpeeds d;
	if (!a.recorded || a.key.rfind("deku-spin", 0) != 0 || a.pressRow < 0) return d;
	d.back = a.key == "deku-spin-backwalk";
	d.pressRow = a.pressRow;
	d.spinRow = d.back ? 11 : 16;  // (the first row his shape spins on: the moves speed up the row after)
	if (d.spinRow >= (int)a.frames.size()) { d.spinRow = -1; return d; }
	d.peak = d.spinRow;
	for (size_t j = d.spinRow; j < a.frames.size(); j++) if (a.frames[j].speed > a.frames[d.peak].speed) d.peak = j;
	if (d.peak + 1 < a.frames.size()) d.decay = a.frames[d.peak].speed - a.frames[d.peak + 1].speed;
	return d;
}
// The stick target (at most 6) on floorPoly moving at yaw
double dekuTarget(const Model& m, int floorPoly, int yaw) {
	if (floorPoly < 0 || floorPoly >= (int)m.polys.size()) return 6;
	const Poly& p = m.polys[floorPoly];
	if (!(p.ny > 0)) return 6;
	const double t = -(p.nx * sinS(yaw) + p.nz * cosS(yaw)) / p.ny;
	const double s2 = t * t / (1 + t * t);
	return std::max(0.0, std::min(6.0, (double)F(6.72 - 8 * s2)));
}
// unk_B50 after a frame (dekuSpeed, see above): the limit unless a wall pushed
// him; then the line ahead's wall if it hits one, else the (last) pusher
double dekuCap(const Model& m, Scratch& s, const V3& pos, const PushList& trace, int yaw, int shape, double limit = 6) {
	const double r = F(m.radius + 10);
	const V3 a = { pos.x, F(pos.y + F(178.0f * 0.1f)), pos.z };
	const V3 b = { F(pos.x + F(r * sinS(shape))), a.y, F(pos.z + F(r * cosS(shape))) };
	// (MM3D: the line's wall whenever it hits one, pushed or not; no hit, no cap -
	// see dekuSpeed's notes. N64's Player_ProcessSceneCollision only does it on a
	// frame a wall pushed him, with the pusher if the line misses.)
	(void)trace;
	int wall = -1;
	if (auto h = m.lineHit(s, a, b, LOOSE, false, true)) wall = h->poly;
	if (wall < 0) return limit;
	const Poly& w = m.polys[wall];
	const int wallYaw = yawOf(w.sx, w.sz);
	const double scale = F(std::abs((int)(int16_t)(yaw - ((wallYaw + 0x8000) & 0xFFFF))) * F(0.00008));
	if (scale >= 1) return limit;
	return std::max((double)F(0.1), (double)F(limit * scale));
}
// The cap on row j's move speed: set by the action of row j - 1's frame, after
// that frame's collision (out[j - 1]: where it left him, what pushed him), the
// line ahead along his shape as it was going into it (row j - 2's: his move
// yaw until the spin turns it, then the recording's spinning shape). turn:
// (--frog curved paths) the yaw added each spin row after turnRow, his move yaw
// and shape both (Player_Action_95 turns the shape with the yaw)
int spinTurnAt(int turn, int turnRow, size_t j) { return turnRow >= 0 && (int)j > turnRow ? turn * ((int)j - turnRow) : 0; }
double dekuRowCap(const Model& m, Scratch& s, const Action& a, int facing, const vector<FrameOut>& out, size_t j, int turn = 0, int turnRow = -1) {
	const FrameOut& e = out[j - 1];
	const int yaw = (facing + a.frames[j - 1].angle + spinTurnAt(turn, turnRow, j - 1)) & 0xFFFF;
	const size_t sj = j >= 2 ? j - 2 : 0;
	const ActionFrame& sf = a.frames[sj];
	const int shape = ((sf.shape >= 0 ? facing + sf.shape : facing + sf.angle) + spinTurnAt(turn, turnRow, sj)) & 0xFFFF;
	return dekuCap(m, s, e.landed ? V3{ e.res.x, e.landY, e.res.z } : e.res, e.trace, yaw, shape);
}
// Row j's speed after a row of prev, the stick target `target` (dekuTarget)
double dekuSpeed(const Action& a, const DekuSpeeds& d, size_t j, double target, double prev, double wallCap = 6) {
	const double rec = a.frames[j].speed;
	if (d.spinRow < 0) return rec;
	if ((int)j < d.pressRow) return std::min(rec, target * (d.back ? 1.5 : 1.0));
	if ((int)j <= d.spinRow) return std::min(rec, prev);
	const double flat = j < d.peak ? a.frames[d.peak].speed + d.decay * (double)(d.peak - j) : rec;
	const double T = flat * std::min(target, wallCap) / 6;
	return std::max(0.0, prev + std::max(-2.0, std::min(0.4, T - prev)));
}

// The action's frames from `start`, each a walking frame: the move, the
// line test (or the pushes), then the floor check from prevPos.y + 50. Stops
// early if Link leaves the ground (no floor within 11 below posNext).
void runFrames(const Model& m, Scratch& s, const V3& start, int facing, const Action& a, const Tol& tol, vector<FrameOut>& out) {
	out.clear();
	V3 pos = start;
	double landSpeed = 0, firstY = NAN;
	bool noSpeed = false;  // (a swing frame put him back: speedXZ zeroed)
	// (stick frames: speedXZ, the cap the last frame's collision left, the spin)
	const double limit = m.indoors ? 5.0 : a.runLimit;
	double stickSpd = 0, cap = limit, b0 = 20000;
	int spinTurn = 0;
	const size_t np = a.pre.size();
	bool air = false;
	// (the Deku spins: the floor's slope cuts the stick's speed, dekuTarget; its floor from the last frame)
	int floorPoly = -1;
	m.floorCheck(start.x, start.z, F(start.y + 1), &floorPoly);
	const DekuSpeeds ds = dekuSpeeds(a);
	double recSpd = 0;
	for (size_t j = 0; j < np + a.frames.size(); j++) {
		// (the jumpslash: in the air after the prefix; never landing, those frames are all)
		if (j == np && a.jump) {
			const V3 from = pos;
			if (!airFrames(m, s, a, from, facing, tol, out, pos, landSpeed, firstY)) return;
			air = true;
		}
		const ActionFrame& af = j < np ? a.pre[j] : a.frames[j - np];
		FrameOut& o = out.emplace_back();
		o.prev = pos;
		int shape = facing;
		if (af.stick) {
			// the action at the end of the last frame: this frame's speed
			// (the full stick, 6.58 / 6.72, is over every cap - but not after a slope's cut, MM)
			const double full = a.game == "MM" ? std::min(cap, dekuTarget(m, floorPoly, (facing + af.angle) & 0xFFFF)) : cap;
			if (af.stick == 'R') stickSpd = asymStep(stickSpd, full, 2.0, 1.5);
			else if (af.stick == 'B') stickSpd = asymStep(stickSpd, F(full * F(1.5)), 1.5, 2.0);
			else if (af.stick == 'S') {
				const double factor = F(1.0 - F(F(0.9) * F(F(11100.0 - b0) / 11100.0)));
				stickSpd = asymStep(stickSpd, F(full * factor), 2.0, 1.5);
				b0 = F(b0 - 800);
				spinTurn = (spinTurn + (int)(int16_t)(int)b0) & 0xFFFF;
			}
			shape = af.stick == 'B' ? facing : (facing + af.angle + spinTurn) & 0xFFFF;
		}
		double spd = af.stick ? stickSpd : af.speed < 0 ? landSpeed : NAN;
		if (ds.spinRow >= 0 && j >= np) {
			const size_t row = j - np;
			double wallCap = 6;
			// (the spin's first speed update: capped by its frame's own collision, dekuCap)
			if (ds.spinRow >= 1 && (int)row > ds.spinRow && out.size() >= row) wallCap = dekuRowCap(m, s, a, facing, out, row);
			spd = recSpd = dekuSpeed(a, ds, row, dekuTarget(m, floorPoly, (facing + af.angle) & 0xFFFF), recSpd, wallCap);
		}
		o.next = actionStep(a, af, pos, facing, noSpeed, spd);
		if (air && j == np) o.next.y = firstY;
		if (auto lf = lineFrame(m, s, pos, o.next, tol)) { o.res = lf->res; o.trace = lf->trace; }
		else o.res = m.sphereStep(o.next, tol, &o.trace, &pos);
		auto fy = m.floorCheck(o.res.x, o.res.z, F(pos.y + 50), &o.floorPoly);
		o.landed = fy && F(*fy - o.res.y) >= -11;
		// Off the ground, func_8083AA10 / MM func_8083827C put him back at
		// prevPos (speedXZ zeroed) with the swing active - and MM also during
		// any root motion (ANIM_FLAG_ENABLE_MOVEMENT: the whole attack, its end
		// animation too) if func_808381F8 finds the floor under prevPos (from 50
		// above) within 10 of where he is: so no MM lunge carries him off a
		// ledge or out over a void (the user, Laundry Pool). MM3D taken to do
		// the same (its recorded rows have no swing frames). Not OoT: swing only.
		// (the attack's frames: not a -walkin run in, not a stick-driven spin)
		bool back = af.swing;
		if (!o.landed && !back && (a.game == "MM" || a.game == "MM3D") && j >= np && !af.stick && !a.canStop) {
			const auto pf = m.floorCheck(pos.x, pos.z, F(pos.y + 50));
			back = pf && std::fabs((double)F(*pf - o.res.y)) < 10;
		}
		if (!o.landed && back) {
			// off the ground: back where the frame started
			o.res = pos;
			o.trace.clear();
			o.landed = true;
			o.landY = pos.y;
			o.reverted = true;
			noSpeed = true;
			continue;
		}
		if (!o.landed) break;
		o.landY = *fy;
		pos = { o.res.x, o.landY, o.res.z };
		if (o.floorPoly >= 0) floorPoly = o.floorPoly;
		if (af.stick) cap = stickCap(m, s, pos, o.trace, (facing + af.angle) & 0xFFFF, shape, limit);
	}
}

struct Verdict { int crossed = -1, pusher = -1, frame = -1, kind = 1, stopAfter = 0; bool onFace = false, cross = false, noFloor = false; V3 end; };

// Whether the frames take Link through a wall: the first frame that leaves
// him behind one, at its own posNext height (a wall push: that frame's pushes
// or line test snap), or failing that on the floor its floor check lifts him
// onto (a slope clip, as slope.h). Then, as clipFromFrame: standing still
// for two frames after the last frame he's still behind a wall (another one
// at the height he landed at is fine; a slope clip: the same one), and that
// counts - or, off the ground, he lands out of bounds.
std::optional<Verdict> judge(const Model& m, Scratch& s, const V3& start, const vector<FrameOut>& fr, const Tol& tol, bool canStop) {
	Verdict v;
	for (size_t k = 0; k < fr.size() && v.frame < 0; k++) {
		const FrameOut& o = fr[k];
		const int cw = m.crossedWall(s, { start.x, o.res.y, start.z }, o.res);
		if (cw >= 0) {
			const Poly& C = m.polys[cw];
			const double sphY = o.res.y + m.checkHeight;
			const Push* p = nullptr;
			for (const Push& t : o.trace) {
				if (t.poly == cw) continue;
				if (planeDist(C, t.from.x, sphY, t.from.z) >= 0 && planeDist(C, t.to.x, sphY, t.to.z) < 0) { p = &t; break; }
			}
			// (in the air, only a push that took him across it: jumping off a
			// ledge, the line from the start at his new height can go through
			// the cliff under it, with no push to do with it)
			if (!p && !o.air) for (int i = (int)o.trace.size() - 1; i >= 0; i--) if (o.trace[i].poly != cw) { p = &o.trace[i]; break; }
			if (!p) return std::nullopt;  // (no push did it)
			v.crossed = cw;
			v.pusher = p->poly;
			v.frame = (int)k;
			v.onFace = pushOnFace(m, *p);
			v.cross = o.trace[0].line;
			v.kind = 1;
		} else if (o.landed && o.floorPoly >= 0) {
			const double low = F(o.landY - GROUND_DROP);
			const int lw = m.crossedWall(s, { start.x, low, start.z }, { o.res.x, low, o.res.z });
			if (lw < 0 || std::any_of(o.trace.begin(), o.trace.end(), [&](const Push& t) { return t.poly == lw; })) continue;
			v.crossed = lw;
			v.pusher = o.floorPoly;
			v.frame = (int)k;
			v.kind = 2;
			v.cross = true;
		}
	}
	if (v.frame < 0) return std::nullopt;
	// canStop (stick-driven actions, the Deku spins: not a lunge, whose root
	// motion runs on whatever the stick does): stopping part way (the user, from
	// playing it). A frame from
	// the clip on that leaves him out of bounds, still behind the wall it went
	// through after two frames standing still there, counts even if the rest of
	// the action carries him out again (e.g. through a thin wall and back into
	// bounds on its other side). The last frame: the checks below.
	for (size_t k = v.frame; canStop && k + 1 < fr.size(); k++) {
		const FrameOut& o = fr[k];
		if (!o.landed || o.reverted) continue;
		V3 s1 = m.sphereStep({ o.res.x, F(o.landY - GROUND_DROP), o.res.z }, tol, nullptr);
		V3 s2 = m.sphereStep(s1, tol, nullptr);
		const V3 end = { s2.x, o.landY, s2.z };
		if (m.crossedWall(s, { start.x, s2.y, start.z }, s2) != v.crossed || m.isInBounds(s, end)) continue;
		if (!m.endCounts(s, v.crossed, end, &start)) continue;
		v.end = end;
		v.stopAfter = (int)k + 1;
		return v;
	}
	const FrameOut& L = fr.back();
	if (L.landed) {
		V3 s1 = m.sphereStep({ L.res.x, F(L.landY - GROUND_DROP), L.res.z }, tol, nullptr);
		V3 s2 = m.sphereStep(s1, tol, nullptr);
		const V3 from = { start.x, s2.y, start.z };
		const int held = m.crossedWall(s, from, s2);
		bool ok = held >= 0 && !(v.kind == 2 && held != v.crossed);
		// out the other side of a thin wall: through it, not out of bounds - but
		// through a dynapoly that's what the clip is for (clipFromFrame)
		if (ok && m.polys[held].bg < 0 && m.crossedWall(s, from, s2, true) >= 0) ok = false;
		v.end = { s2.x, L.landY, s2.z };
		// or back out in front, somewhere he couldn't walk to (Model::walkUnreachable)
		if (!ok && (!m.isInBounds(s, v.end) || !m.walkUnreachable(s, v.end, start))) return std::nullopt;
		if (!m.endCounts(s, v.crossed, v.end, &start)) return std::nullopt;
	} else {
		auto land = landing(m, s, L.res, L.prev.y, v.noFloor, v.crossed, &start);
		if (!land) return std::nullopt;
		v.end = *land;
	}
	return v;
}
}  // namespace

std::optional<Clip> actionClip(const Model& m, Scratch& s, const V3& start, int facing, int action) {
	const Action& a = ACTIONS[action];
	vector<FrameOut> fr;
	runFrames(m, s, start, facing, a, LOOSE, fr);
	const bool canStop = a.canStop || std::any_of(a.frames.begin(), a.frames.end(), [](const ActionFrame& f) { return f.stick != 0; });
	auto v = judge(m, s, start, fr, LOOSE, canStop);
	if (!v) return std::nullopt;
	// (during the run in: a walking clip)
	if (v->frame < (int)a.pre.size()) return std::nullopt;
	if (m.dynaPairsOnly && m.polys[v->crossed].bg < 0 && m.polys[v->pusher].bg < 0) return std::nullopt;
	Clip c;
	c.kind = v->kind;
	if (v->kind < 2) {
		// the same without the extended planes, pushed from in front of the pusher's face
		vector<FrameOut> sfr;
		runFrames(m, s, start, facing, a, STRICT, sfr);
		auto sv = judge(m, s, start, sfr, STRICT, canStop);
		c.acutePoint = sv && sv->kind < 2 && sv->crossed == v->crossed && sv->pusher == v->pusher && sv->onFace;
	}
	const FrameOut& o = fr[v->frame];
	// (the Deku spins: a clip on a frame Deku could run at is a walking clip)
	if (a.aimMin > 2 && std::hypot(F(o.next.x - o.prev.x), F(o.next.z - o.prev.z)) / SPEED_RATE < a.aimMin) return std::nullopt;
	c.cross = v->cross;
	c.pusher = v->pusher;
	c.crossed = v->crossed;
	c.from = o.next; c.prev = start; c.next = o.next; c.hasNext = true;
	c.res = o.landed && v->kind == 2 ? V3{ o.res.x, o.landY, o.res.z } : o.res;
	c.end = v->end;
	c.endNoFloor = v->noFloor;
	c.stopAfter = v->stopAfter;
	c.floorY = start.y; c.hasFloorY = true;
	// the clip frame's move, as a yaw and speed (for display)
	c.yaw = yawOf(o.next.x - o.prev.x, o.next.z - o.prev.z);
	c.speed = F(std::hypot(o.next.x - o.prev.x, o.next.z - o.prev.z) / SPEED_RATE);
	c.hasMove = true;
	if (c.cross) c.yaws = { c.yaw };
	c.action = action;
	c.facing = facing & 0xFFFF;
	for (const FrameOut& f : fr) {
		if (f.air) c.airFrames++;
		c.frames.push_back(f.landed ? V3{ f.res.x, f.landY, f.res.z } : f.res);
		const double dx = F(f.next.x - f.prev.x), dz = F(f.next.z - f.prev.z), sp = std::hypot(dx, dz) / SPEED_RATE;
		c.frameMoves.push_back({ sp, sp > 0 ? (int16_t)(yawOf(dx, dz) - facing) : 0 });
	}
	// no stick speed to reach it with: the action is the move
	c.reachDone = c.hasReach = true;
	c.reachSpeed = 0;
	c.reachYaw = c.facing;
	c.reachStart = start;
	return c;
}

void printActionFrames(const Model& m, const V3& start, int facing, int action) {
	const Action& a = ACTIONS[action];
	Scratch s;
	s.stamp.assign(m.polys.size(), 0);
	vector<FrameOut> fr;
	runFrames(m, s, start, facing, a, LOOSE, fr);
	auto P = [](const V3& v) { char b[96]; snprintf(b, sizeof b, "(%.9g, %.9g, %.9g)", v.x, v.y, v.z); return string(b); };
	printf("start %s, in bounds: %s\n", P(start).c_str(), m.isInBounds(s, start, true) ? "yes" : "NO");
	for (size_t i = 0; i < fr.size(); i++) {
		const FrameOut& o = fr[i];
		printf("frame %zu%s: move (%.9g, %.9g)%s, posNext %s\n", i + 1, o.air ? " (air)" : "", F(o.next.x - o.prev.x), F(o.next.z - o.prev.z),
			o.air ? (", velocity.y " + std::to_string(o.vy)).c_str() : "", P(o.next).c_str());
		for (const Push& t : o.trace)
			printf("  %s %s %s -> %s\n", m.polyName(t.poly).c_str(), t.line ? "line test snaps" : "pushes", P(t.from).c_str(), P(t.to).c_str());
		if (o.reverted) printf("  off the ground mid-attack (the swing, or MM root motion with the floor under prevPos within 10): put back at %s, speedXZ zeroed\n", P(o.prev).c_str());
		else if (o.landed) printf("  %s %s at y %.9g: %s\n", o.air ? "lands on" : "on", m.polyName(o.floorPoly).c_str(), o.landY,
			m.isInBounds(s, { o.res.x, o.landY, o.res.z }) ? "in bounds" : "OUT OF BOUNDS");
		else printf("  in the air at %s\n", P(o.res).c_str());
	}
	if (!fr.empty() && !fr.back().landed) printf("(never lands, or off the ground: the frames stop there)\n");
}

// Acute wall corners (Action::corners): two walls facing into the same wedge
// (their xz normals more than 90 degrees apart), their lines meeting within
// both walls' ends (+-2), their heights overlapping. Targets on the wedge's
// bisector, from the corner out: posNext there, moving into the corner (and
// along each wall into it), from the floor at the walls' bottom.
static vector<Clip> cornerTargets(const Model& m) {
	struct W { int id; double nx, nz, d, tx, tz, t0, t1, y0, y1; };
	vector<W> ws;
	for (size_t k = 0; k < m.polys.size(); k++) {
		const Poly& p = m.polys[k];
		if (!p.exists || !p.isWall) continue;
		const double l = std::hypot((double)p.sx, (double)p.sz);
		if (l < 1) continue;
		W w;
		w.id = (int)k; w.nx = p.sx / l; w.nz = p.sz / l;
		w.d = -(w.nx * p.ax + w.nz * p.az);
		w.tx = -w.nz; w.tz = w.nx;
		const double t[3] = { w.tx * p.ax + w.tz * p.az, w.tx * p.bx + w.tz * p.bz, w.tx * p.cx + w.tz * p.cz };
		w.t0 = std::min({ t[0], t[1], t[2] }); w.t1 = std::max({ t[0], t[1], t[2] });
		w.y0 = p.minY; w.y1 = p.maxY;
		ws.push_back(w);
	}
	vector<Clip> out;
	std::set<std::array<long long, 3>> seen;  // (corner xz and floor, rounded: coplanar halves share it)
	for (size_t i = 0; i < ws.size(); i++) {
		const W& A = ws[i];
		const Poly& pa = m.polys[A.id];
		for (size_t j = i + 1; j < ws.size(); j++) {
			const W& B = ws[j];
			const Poly& pb = m.polys[B.id];
			if (pb.minX > pa.maxX + 2 || pb.maxX < pa.minX - 2 || pb.minZ > pa.maxZ + 2 || pb.maxZ < pa.minZ - 2) continue;
			const double dot = A.nx * B.nx + A.nz * B.nz;
			if (dot > -0.02 || dot < -0.995) continue;  // (not acute; or facing each other head on)
			const double floorY = std::max(A.y0, B.y0);
			if (std::min(A.y1, B.y1) < floorY + 10) continue;
			// where the lines meet
			const double det = A.nx * B.nz - A.nz * B.nx;
			const double vx = (-A.d * B.nz + B.d * A.nz) / det, vz = (-A.nx * B.d + B.nx * A.d) / det;
			const double ta = A.tx * vx + A.tz * vz, tb = B.tx * vx + B.tz * vz;
			if (ta < A.t0 - 2 || ta > A.t1 + 2 || tb < B.t0 - 2 || tb > B.t1 + 2) continue;
			if (!seen.insert({ std::llround(vx * 4), std::llround(vz * 4), std::llround(floorY) }).second) continue;
			double bx = A.nx + B.nx, bz = A.nz + B.nz;
			const double bl = std::hypot(bx, bz);
			bx /= bl; bz /= bl;
			// (each wall runs from the corner into the wedge, at least 5)
			auto into = [&](const W& w, double t) { const double sg = bx * w.tx + bz * w.tz; return sg > 0 ? w.t1 >= t + 5 : w.t0 <= t - 5; };
			if (!into(A, ta) || !into(B, tb)) continue;
			// along each wall into the corner, from a point out on the bisector
			vector<int> along;
			for (const W* w : { &A, &B }) {
				const double mx = vx + 30 * bx, mz = vz + 30 * bz, pd = w->nx * mx + w->nz * mz + w->d;
				along.push_back(yawOf(vx - (mx - pd * w->nx), vz - (mz - pd * w->nz)));
			}
			for (double dd : { 0.0, 8.0, 16.0, 24.0, 32.0, 40.0 }) {
				Clip t;
				t.hasNext = true;
				t.next = { F(vx + dd * bx), F(floorY - GROUND_DROP), F(vz + dd * bz) };
				t.prev = { t.next.x, F(floorY), t.next.z };
				t.yaw = yawOf(-bx, -bz);
				t.yaws = along;
				t.pusher = A.id; t.crossed = B.id;
				out.push_back(t);
			}
		}
	}
	return out;
}

vector<Clip> actionScan(const Model& m, const vector<Clip>& targets, const vector<int>& actions, int threads) {
	auto t0 = std::chrono::steady_clock::now();
	// the scan's walking and slope clip points (not falling or ground: those
	// need y velocity; the jumpslash has it, so its falling ones too)
	const bool jump = anyJump(actions);
	vector<const Clip*> todo;
	for (const Clip& c : targets) if (c.hasNext && (c.drop == 0 || jump) && (c.kind < 2 || c.kind == 2)) todo.push_back(&c);
	// (Action::corners: the acute corners too, after them)
	const size_t numScan = todo.size();
	vector<Clip> corners;
	if (std::any_of(actions.begin(), actions.end(), [](int i) { return ACTIONS[i].corners; })) corners = cornerTargets(m);
	for (const Clip& c : corners) todo.push_back(&c);
	// each action's frames unobstructed at facing 0: the moves to aim
	std::map<int, vector<V3>> nominal0;
	for (int ai : actions) nominal0[ai] = nominalFrames(ACTIONS[ai], 0);
	// Directions the clip frame's move is tried in: the target's own move and
	// the crossing yaws that worked, each turned by these.
	static const int FAN[] = { 0, -0x80, 0x80, -0x100, 0x100, -0x200, 0x200, -0x400, 0x400, -0x800, 0x800, -0x1000, 0x1000 };
	// Starts along the move, from the one that puts posNext on the target
	static const double ALONG[] = { 0, -0.5, 0.5, -1.5, 1.5 };
	std::atomic<size_t> next{ 0 }, done{ 0 };
	std::mutex outMu;
	vector<Clip> clips;
	auto worker = [&]() {
		Scratch s;
		s.stamp.assign(m.polys.size(), 0);
		vector<Clip> local;
		std::set<std::array<double, 4>> tried;
		for (;;) {
			size_t i = next++;
			if (i >= todo.size()) break;
			const Clip& t = *todo[i];
			const V3 P = t.next;
			const double floorRef = t.prev.y;
			vector<int> dirs;
			auto addDir = [&](int y) { y &= 0xFFFF; if (std::find(dirs.begin(), dirs.end(), y) == dirs.end()) dirs.push_back(y); };
			for (int d : FAN) addDir(t.yaw + d);
			for (int y : t.yaws) addDir(y);
			for (int ai : actions) {
				const Action& a = ACTIONS[ai];
				// (a falling target: the jumpslash's falling frames only)
				if (t.drop > 0 && !a.jump) continue;
				if (i >= numScan ? !a.corners : a.cornersOnly) continue;
				const vector<V3>& N0 = nominal0[ai];
				bool found = false;
				for (size_t k = 0; k < N0.size() && !found; k++) {
					// (only the frames that move Link a fair way can take him through)
					const double mx = F(N0[k].x - (k ? N0[k - 1].x : 0)), mz = F(N0[k].z - (k ? N0[k - 1].z : 0));
					if (std::hypot(mx, mz) / SPEED_RATE < a.aimMin) continue;
					const int kAngle = yawOf(mx, mz);
					for (int d : dirs) {
						if (found) break;
						// facing so that frame k moves along d
						const int facing = (d - kAngle) & 0xFFFF;
						// frames 0..k's moves, unobstructed
						const V3 D = nominalFrames(a, facing)[k];
						const V3 u = moveStep({ 0, 0, 0 }, d, 1 / SPEED_RATE);
						// the floor to start from: the target's own, and (in the
						// air) the one that puts frame k's posNext at its height
						vector<double> refs = { floorRef };
						if (a.jump && std::fabs(P.y - D.y - floorRef) > 1) refs.push_back(F(P.y - D.y));
						for (double ref : refs) {
							if (found) break;
							for (double al : ALONG) {
								auto st = standSpotCached(m, s, F(P.x - D.x + al * u.x), F(P.z - D.z + al * u.z), ref);
								if (!st) continue;
								if (!tried.insert({ st->x, st->z, (double)facing, (double)ai }).second) continue;
								if (!m.keepLoadVoid && m.startOnLoadVoid(*st)) continue;
								auto c = actionClip(m, s, *st, facing, ai);
								if (!c || !m.isInBounds(s, *st, true)) continue;
								local.push_back(*c);
								found = true;
								break;
							}
						}
					}
				}
			}
			if (tried.size() > 2000000) tried.clear();
			size_t n = ++done;
			static std::mutex pm;
			static auto last = std::chrono::steady_clock::now();
			std::lock_guard<std::mutex> g(pm);
			auto now = std::chrono::steady_clock::now();
			if (std::chrono::duration<double>(now - last).count() >= 0.5 || n == todo.size()) {
				last = now;
				fprintf(stderr, "\r     %zu / %zu targets (%.0fs)   ", n, todo.size(), std::chrono::duration<double>(now - t0).count());
			}
		}
		std::lock_guard<std::mutex> g(outMu);
		clips.insert(clips.end(), local.begin(), local.end());
	};
	fprintf(stderr, "  Actions: each attack aimed at %zu of the clip points above%s\n", numScan,
		corners.empty() ? "" : (" (and " + std::to_string(corners.size() / 6) + " acute wall corners: the Deku spins, the -walkin keys)").c_str());
	{
		vector<std::thread> ts;
		for (int i = 0; i < threads; i++) ts.emplace_back(worker);
		for (auto& t : ts) t.join();
	}
	fprintf(stderr, "\r%60s\r", "");
	// Deterministic order, and one clip per start and action
	std::sort(clips.begin(), clips.end(), [](const Clip& a, const Clip& b) {
		if (a.action != b.action) return a.action < b.action;
		if (a.pusher != b.pusher) return a.pusher < b.pusher;
		if (a.crossed != b.crossed) return a.crossed < b.crossed;
		if (a.prev.x != b.prev.x) return a.prev.x < b.prev.x;
		if (a.prev.z != b.prev.z) return a.prev.z < b.prev.z;
		return a.facing < b.facing;
	});
	clips.erase(std::unique(clips.begin(), clips.end(), [](const Clip& a, const Clip& b) {
		return a.action == b.action && a.prev.x == b.prev.x && a.prev.z == b.prev.z && a.prev.y == b.prev.y && a.facing == b.facing;
	}), clips.end());
	{
		Scratch s;
		s.stamp.assign(m.polys.size(), 0);
		for (Clip& c : clips) {
			c.inBounds = !c.endNoFloor && m.isInBounds(s, c.end);
			// (in bounds: how far the walk there is - a shortcut, Model::walkUnreachable)
			if (c.inBounds) c.walkDist = m.walkShortcut(s, c.end, c.prev);
		}
	}
	// One category per wall pair and action: acute if any of its points is
	std::set<std::tuple<int, int, int>> acute;
	for (const Clip& c : clips) if (c.acutePoint && c.kind < 2) acute.insert({ c.action, c.pusher, c.crossed });
	for (Clip& c : clips) if (c.kind < 2) c.kind = acute.count({ c.action, c.pusher, c.crossed }) ? 0 : 1;
	// per action: wall pairs and points
	for (int ai : actions) {
		std::set<std::pair<int, int>> pairs;
		size_t n = 0;
		for (const Clip& c : clips) if (c.action == ai) { pairs.insert({ c.pusher, c.crossed }); n++; }
		fprintf(stderr, "     %s: %zu wall pairs, %zu points\n", ACTIONS[ai].name.c_str(), pairs.size(), n);
	}
	// (the total: main, after the file's thinning)
	return clips;
}

// ---- --frog: an actor's OC cylinder pushing Link (FrogOpts, action.h) ----
// The user's idea (MM3D Laundry Pool TRI 26 -> 70): the Deku spin's own speed
// (9.81 at most) isn't enough, but the frog (En_Minifrog, which Link can push
// around) has an OC cylinder, and CollisionCheck_SetOCvsOC adds Link's share
// of the overlap to colChkInfo.displacement, which the next frame's
// Actor_UpdatePos adds to his move: one frame of speed + push, swept by the
// frame's bg check like any move. The spin makes Link's cylinder radius 30
// (Player_Action_95 -> Player_SetCylinderForAttack), so a frog that was clear
// of his radius 12 overlaps it as soon as the spin starts.
// Modelled: positions as the colliders' s16s (truncated), Link's share of the
// push (frog mass 30 / (30 + Deku 20)), the frog's share moving it away (its
// wall check isn't), Link's cylinder from his feet (+ the frame's dy) to
// FrogOpts::linkH above. Not modelled: the frog's hops (EnMinifrog_Jump: off
// the ground the heights may not overlap), the spin's wall cap on speed.
namespace {
int frogSpinRow(const Action& a, const FrogOpts& o) {
	if (o.spinRow >= 0) return o.spinRow;
	// (the first row whose shape spins: Player_Action_95 has run, radius 30)
	if (a.key == "deku-spin-backwalk") return 11;
	if (a.key == "deku-spin") return 16;
	return -1;
}
// key "deku-backwalk": the backwalk spin's rows before L is let go, then speed 9 on
const Action* frogAction(const string& key, const string& game, Action& tmp) {
	const bool walk = key == "deku-backwalk";
	for (const Action& a : ACTIONS) {
		if (a.game != game || a.key != (walk ? "deku-spin-backwalk" : key)) continue;
		if (!walk) return &a;
		tmp = a;
		tmp.key = key;
		tmp.name = "Deku backwalk (the backwalk spin's rows 0-8, then 9 a frame)";
		tmp.frames.resize(9);
		for (int i = 0; i < 12; i++) tmp.frames.push_back(tmp.frames[8]);
		return &tmp;
	}
	return nullptr;
}
inline int s16t(double v) { return (int)(int16_t)(int)v; }
// a world coordinate in the middle of the s16 cell c (C's truncation toward 0)
inline double cellMid(int c) { return c < 0 ? c - 0.5 : c + 0.5; }
struct FrogOc { double dx = 0, dz = 0, fdx = 0, fdz = 0, overlap = 0; bool hit = false; };
// Math3D_CylVsCylOverlapCenterDist + CollisionCheck_SetOCvsOC (both normal masses)
FrogOc frogOc(const V3& link, double linkDy, const V3& frog, double rl, const FrogOpts& o) {
	FrogOc r;
	// (N64: Collider_UpdateCylinder's s16 dim.pos; MM3D measures from the float
	// positions - the user's runs: the frog moved exactly the float overlap's share)
	auto cv = [&](double v) { return o.floatPos ? v : (double)s16t(v); };
	const double ddx = F(cv(link.x) - cv(frog.x)), ddz = F(cv(link.z) - cv(frog.z));
	const double dist = F(std::sqrt(F(F(ddx * ddx) + F(ddz * ddz))));
	if (F(rl + o.frogR) < dist) return r;
	const double lb = cv(link.y) + cv(linkDy), lt = lb + o.linkH;
	const double fb = cv(frog.y), ft = fb + o.frogH;
	if (lt < fb || ft < lb) return r;
	r.hit = true;
	r.overlap = F(F(rl + o.frogR) - dist);
	const double ratio = F(o.ratio), fratio = F(1 - o.ratio);
	if (dist != 0) {
		const double k = F(r.overlap / dist), kx = F(ddx * k), kz = F(ddz * k);
		r.dx = F(kx * ratio); r.dz = F(kz * ratio);
		r.fdx = F(-kx * fratio); r.fdz = F(-kz * fratio);
	} else { r.dx = F(r.overlap * ratio); r.fdx = F(-r.overlap * fratio); }
	return r;
}
// A recorded row's walking frame at speed sp with the push from the last frame
// added (Actor_UpdatePos: pos += velocity x rate + displacement), then the bg check
void frogFrame(const Model& m, Scratch& s, const Action& a, const ActionFrame& af, int facing, double sp, V3& pos, double dX, double dZ, FrameOut& o, int extraYaw = 0) {
	o.prev = pos;
	const int yaw = (facing + af.angle + extraYaw) & 0xFFFF;
	sp = F(std::max(sp, 0.0));
	const V3 root = actionStep(a, af, pos, facing, true);
	o.next = { F(root.x + F(F(F(sp * sinS(yaw)) * SPEED_RATE) + dX)), root.y, F(root.z + F(F(F(sp * cosS(yaw)) * SPEED_RATE) + dZ)) };
	if (auto lf = lineFrame(m, s, pos, o.next, LOOSE)) { o.res = lf->res; o.trace = lf->trace; }
	else o.res = m.sphereStep(o.next, LOOSE, &o.trace, &pos);
	auto fy = m.floorCheck(o.res.x, o.res.z, F(pos.y + 50), &o.floorPoly);
	o.landed = fy && F(*fy - o.res.y) >= -11;
	if (o.landed) o.landY = *fy;
	pos = o.landed ? V3{ o.res.x, o.landY, o.res.z } : o.res;
}
// spd / floor: each frame's speed (dekuSpeed: the slope's cut) and the floor it left him on
struct FrogRun { vector<FrameOut> fr; vector<FrogOc> oc; vector<V3> frog; vector<double> spd; vector<int> floor; };
// frames [from, to) from pos (where frame from - 1 left Link, at speed spd0 on
// floor0; from 0: standing on the floor under pos), the frog at frog, d the
// push frame from - 1 left for the next move
void frogFrames(const Model& m, Scratch& s, const Action& a, int spinRow, int facing, size_t from, size_t to, V3 pos, V3 frog,
	FrogOc d, bool frogOn, const FrogOpts& o, FrogRun& r, double spd0 = 0, int floor0 = -1, int turn = 0) {
	const DekuSpeeds ds = dekuSpeeds(a);
	// (a curved spin: turn more yaw each spin row, Player_Action_95's Math_ScaledStepToS toward the stick)
	const int turnRow = turn ? ds.spinRow : -1;
	double spd = spd0;
	int floor = floor0;
	if (from == 0) { spd = 0; floor = -1; m.floorCheck(pos.x, pos.z, F(pos.y + 1), &floor); }
	for (size_t j = from; j < std::min(to, a.frames.size()); j++) {
		const ActionFrame& af = a.frames[j];
		double wallCap = 6;
		// (the spin's first speed update: capped by its frame's own collision, dekuCap)
		const int ex = spinTurnAt(turn, turnRow, j);
		if (ds.spinRow >= 1 && (int)j > ds.spinRow && r.fr.size() >= j) wallCap = dekuRowCap(m, s, a, facing, r.fr, j, turn, turnRow);
		spd = ds.spinRow >= 0 ? dekuSpeed(a, ds, j, dekuTarget(m, floor, (facing + af.angle + ex) & 0xFFFF), spd, wallCap) : af.speed;
		FrameOut& f = r.fr.emplace_back();
		frogFrame(m, s, a, af, facing, spd, pos, d.dx, d.dz, f, ex);
		if (f.floorPoly >= 0) floor = f.floorPoly;
		r.spd.push_back(spd);
		r.floor.push_back(floor);
		if (!f.landed) break;
		if (frogOn && d.hit) {
			// (the frog's update, after Link's: its share, then onto its floor)
			frog.x = F(frog.x + d.fdx);
			frog.z = F(frog.z + d.fdz);
			if (auto fy = m.floorCheck(frog.x, frog.z, F(frog.y + 50))) frog.y = *fy;
		}
		const double rl = spinRow >= 0 && (int)j >= spinRow ? o.spinR : o.linkR;
		d = frogOn ? frogOc(pos, F(pos.y - f.prev.y), frog, rl, o) : FrogOc{};
		r.oc.push_back(d);
		r.frog.push_back(frog);
	}
}
const char* PF(const V3& v) {
	static char b[4][96];
	static int k = 0;
	k = (k + 1) % 4;
	snprintf(b[k], 96, "(%.9g, %.9g, %.9g)", v.x, v.y, v.z);
	return b[k];
}
struct FrogHit { int facing = 0, k = 0, cx = 0, cz = 0, turn = 0; V3 start, S, frog; double margin = 0, dx = 0, dz = 0; Verdict v; };
// A frog clip as an action clip with "frog" (for --frog-json; -1 action: the
// action isn't one of ACTIONS - deku-backwalk - and can't be written)
std::optional<Clip> frogClip(const Model& m, Scratch& s, const Action& a, const V3& start, int facing, const FrogRun& r, const Verdict& v, const V3& frog, int turn = 0) {
	int ai = -1;
	for (size_t i = 0; i < ACTIONS.size(); i++) if (ACTIONS[i].game == a.game && ACTIONS[i].key == a.key) ai = (int)i;
	if (ai < 0) return std::nullopt;
	Clip c;
	c.kind = v.kind < 2 ? (v.onFace ? 0 : 1) : 2;
	c.cross = v.cross;
	c.pusher = v.pusher;
	c.crossed = v.crossed;
	const FrameOut& o = r.fr[v.frame];
	c.from = o.next; c.prev = start; c.next = o.next; c.hasNext = true;
	c.res = o.landed && v.kind == 2 ? V3{ o.res.x, o.landY, o.res.z } : o.res;
	c.end = v.end;
	c.endNoFloor = v.noFloor;
	c.stopAfter = v.stopAfter;
	c.floorY = start.y; c.hasFloorY = true;
	c.yaw = yawOf(o.next.x - o.prev.x, o.next.z - o.prev.z);
	c.speed = F(std::hypot(o.next.x - o.prev.x, o.next.z - o.prev.z) / SPEED_RATE);
	c.hasMove = true;
	if (c.cross) c.yaws = { c.yaw };
	c.action = ai;
	c.facing = facing & 0xFFFF;
	for (const FrameOut& f : r.fr) {
		c.frames.push_back(f.landed ? V3{ f.res.x, f.landY, f.res.z } : f.res);
		const double dx = F(f.next.x - f.prev.x), dz = F(f.next.z - f.prev.z), sp = std::hypot(dx, dz) / SPEED_RATE;
		c.frameMoves.push_back({ sp, sp > 0 ? (int16_t)(yawOf(dx, dz) - facing) : 0 });
	}
	c.inBounds = !c.endNoFloor && m.isInBounds(s, c.end);
	c.hasFrog = true;
	c.frog = frog;
	if (turn) { c.frogTurn = turn; c.frogTurnRow = dekuSpeeds(a).spinRow; }
	return c;
}
void writeFrogJson(const Model& m, const string& game, const FrogOpts& o, const vector<Clip>& clips) {
	if (o.json.empty()) return;
	const string j = toJson(game, o.mapName, o.numPolygons, false, false, { FormResult{ o.form, m.radius, m.checkHeight, clips } });
	std::ofstream f(o.json, std::ios::binary);
	if (!f) { fprintf(stderr, "--frog-json: can't write %s\n", o.json.c_str()); return; }
	f << j;
	fprintf(stderr, "  wrote %zu frog clip%s to %s\n", clips.size(), clips.size() == 1 ? "" : "s", o.json.c_str());
}
}  // namespace

// X,Y,Z,FACING,@KEY,FX,FZ[,FY]: the action from there with the frog at (FX, FZ), each frame printed
int frogSim(const Model& m, const string& arg, const string& game, const FrogOpts& o) {
	double x, y, z, fx, fz, fy = NAN;
	char yawS[32] = {}, key[64] = {};
	const int n = sscanf(arg.c_str(), "%lf,%lf,%lf,%31[^,],@%63[^,],%lf,%lf,%lf", &x, &y, &z, yawS, key, &fx, &fz, &fy);
	if (n < 7) { fprintf(stderr, "--frog-sim wants X,Y,Z,FACING,@KEY,FX,FZ[,FY]\n"); return 2; }
	Action tmp;
	const Action* a = frogAction(key, game, tmp);
	if (!a) { fprintf(stderr, "--frog-sim: no %s action %s\n", game.c_str(), key); return 2; }
	const int facing = (int)strtol(yawS, nullptr, 0) & 0xFFFF, spinRow = frogSpinRow(*a, o);
	Scratch s;
	s.stamp.assign(m.polys.size(), 0);
	const V3 start = { F(x), F(y), F(z) };
	if (std::isnan(fy)) { auto f = m.floorCheck(F(fx), F(fz), F(y + 50)); fy = f ? *f : y; }
	const V3 frog = { F(fx), F(fy), F(fz) };
	printf("%s, facing 0x%04X, spin (radius %g) from row %d%s\n", a->name.c_str(), facing, o.spinR, spinRow,
		o.simTurn ? (", turning " + std::to_string(o.simTurn) + " a spin row (--frog-turn)").c_str() : "");
	printf("Link %s; frog %s (s16 %d, %d, %d), radius %g, height %g, Link's share of a push %g\n", PF(start), PF(frog),
		s16t(frog.x), s16t(frog.y), s16t(frog.z), o.frogR, o.frogH, o.ratio);
	FrogRun r;
	frogFrames(m, s, *a, spinRow, facing, 0, a->frames.size(), start, frog, FrogOc{}, true, o, r, 0, -1, o.simTurn);
	for (size_t j = 0; j < r.fr.size(); j++) {
		const FrameOut& f = r.fr[j];
		const double push = j ? std::hypot(r.oc[j - 1].dx, r.oc[j - 1].dz) : 0;
		printf("frame %zu (row %zu): move (%.6f, %.6f) = %.6f", j + 1, j, F(f.next.x - f.prev.x), F(f.next.z - f.prev.z),
			std::hypot(F(f.next.x - f.prev.x), F(f.next.z - f.prev.z)));
		if (push > 0) printf(" incl. frog push (%.6f, %.6f) = %.6f", r.oc[j - 1].dx, r.oc[j - 1].dz, push);
		if (j < r.spd.size()) printf("; speed %.3f", r.spd[j]);
		printf("\n");
		for (const Push& t : f.trace) printf("    %s %s -> %s\n", t.line ? "line test snap" : (m.polyName(t.poly) + " pushes").c_str(), PF(t.from), PF(t.to));
		printf("  -> %s%s", PF(f.landed ? V3{ f.res.x, f.landY, f.res.z } : f.res), f.landed ? "" : " (off the ground)");
		if (j < r.oc.size() && r.oc[j].hit) {
			const FrogOc& c = r.oc[j];
			printf("; OC overlap %.4f (Link radius %g): push (%.6f, %.6f) next frame, frog -> %s", c.overlap,
				spinRow >= 0 && (int)j >= spinRow ? o.spinR : o.linkR, c.dx, c.dz, PF(r.frog[j]));
		}
		printf("\n");
	}
	auto v = judge(m, s, start, r.fr, LOOSE, true);
	if (!v) printf("no clip\n");
	else printf("CLIP on frame %d: %s pushes Link through %s, ends %s %s%s\n", v->frame + 1, m.polyName(v->pusher).c_str(), m.polyName(v->crossed).c_str(),
		PF(v->end), m.isInBounds(s, v->end) ? "(in bounds)" : "OUT OF BOUNDS", v->stopAfter ? (" - stop after frame " + std::to_string(v->stopAfter)).c_str() : "");
	if (v && !o.json.empty()) {
		if (auto c = frogClip(m, s, *a, start, facing, r, *v, frog, o.simTurn)) writeFrogJson(m, game, o, { *c });
		else fprintf(stderr, "--frog-json: %s isn't a recorded action, so the tester can't run it\n", a->key.c_str());
	}
	return 0;
}

// For each action, facing and start whose run puts Link at one of the aim
// points the frame before a clip row k, every frog s16 cell that first
// touches him at the end of row k - 1 (not before: so the frames up to then are
// the plain run), with the push ending in a clip.
int frogSearch(const Model& m, const vector<Clip>& targets, const string& keys, const string& game, const FrogOpts& o, int threads) {
	vector<V3> aims = o.aims;
	if (aims.empty()) for (const Clip& c : targets) {
		bool dup = false;
		for (const V3& p : aims) dup |= std::hypot(p.x - c.prev.x, p.z - c.prev.z) < 1;
		if (!dup) aims.push_back(c.prev);
	}
	if (aims.empty()) { fprintf(stderr, "--frog: no clip points of the pair to aim at (give --frog-aim X,Y,Z)\n"); return 1; }
	fprintf(stderr, "  --frog: %zu aim points:", aims.size());
	for (const V3& p : aims) fprintf(stderr, " %s", PF(p));
	fprintf(stderr, "\n");
	FILE* csv = o.csv.empty() ? nullptr : fopen(o.csv.c_str(), "w");
	if (csv) fprintf(csv, "action,facing,startX,startY,startZ,clipFrame,linkX,linkY,linkZ,frogCellX,frogCellZ,frogX,frogY,frogZ,heightMargin,pushX,pushZ,pusher,crossed,endX,endY,endZ,stopAfter,turn\n");
	vector<Clip> jsonClips;  // (--frog-json: the best frog of each start listed)
	for (size_t p0 = 0; p0 <= keys.size();) {
		size_t p1 = keys.find(',', p0);
		if (p1 == string::npos) p1 = keys.size();
		const string key = keys.substr(p0, p1 - p0);
		p0 = p1 + 1;
		if (key.empty()) continue;
		Action tmp;
		const Action* ap = frogAction(key, game, tmp);
		if (!ap) { fprintf(stderr, "--frog: no %s action %s (deku-spin, deku-spin-backwalk, deku-backwalk)\n", game.c_str(), key.c_str()); return 2; }
		const Action& a = *ap;
		const int spinRow = frogSpinRow(a, o);
		// the clip rows: the spin's first few after it starts, or the run's top speed
		const int k0 = spinRow >= 0 ? spinRow + 1 : 7, k1 = std::min<int>(k0 + o.maxRows - 1, (int)a.frames.size() - 1);
		// the offsets from each aim point
		vector<std::pair<double, double>> offs;
		for (double u = -o.aimR; u <= o.aimR + 1e-9; u += o.aimStep)
			for (double w = -o.aimR; w <= o.aimR + 1e-9; w += o.aimStep)
				if (u * u + w * w <= o.aimR * o.aimR + 1e-9) offs.push_back({ u, w });
		std::atomic<int> nextFacing{ 0 }, runs{ 0 }, ran{ 0 };
		std::mutex mu;
		vector<FrogHit> hits;
		const int nFacings = (((o.yawTo - o.yawFrom) & 0xFFFF) + 1 + o.yawStep - 1) / o.yawStep;
		auto worker = [&]() {
			Scratch s;
			s.stamp.assign(m.polys.size(), 0);
			std::map<std::pair<int, int>, std::optional<double>> cellFloor;  // (the frog standing in a cell: its floor, or none)
			vector<FrogHit> mine;
			for (int fi; (fi = nextFacing++) < nFacings;) {
				const int facing = (o.yawFrom + fi * o.yawStep) & 0xFFFF;
				// (--frog-turns: the spin curving, turn more yaw each spin row; not without a spin)
				for (int turn : o.turns) for (int k = k0; k <= k1; k++) {
					if (turn && spinRow < 0) continue;
					const int turnRow = turn ? dekuSpeeds(a).spinRow : -1;
					// the move of rows 0 .. k-1 as recorded, curved by the turn (the aim: Link there after row k - 1)
					double sx = 0, sz = 0;
					for (int j = 0; j < k; j++) {
						const V3 d = actionStep(a, a.frames[j], { 0, GROUND_DROP, 0 }, (facing + spinTurnAt(turn, turnRow, j)) & 0xFFFF);
						sx = F(sx + d.x); sz = F(sz + d.z);
					}
					for (const V3& aim : aims) for (const auto& [u, w] : offs) {
						const V3 Sa = { F(aim.x + u), aim.y, F(aim.z + w) };
						const double ax = F(Sa.x - sx), az = F(Sa.z - sz);
						auto fy = m.floorCheck(ax, az, F(Sa.y + 50));
						if (!fy) continue;
						const V3 A = { ax, *fy, az };
						auto rest = m.restingSpot(A);
						if (!rest || std::fabs(rest->x - A.x) > 1e-3 || std::fabs(rest->z - A.z) > 1e-3 || !m.isInBounds(s, A)) continue;
						runs++;
						// the plain run (no frog) up to row k + 2
						FrogRun plain;
						frogFrames(m, s, a, spinRow, facing, 0, k + 3, A, {}, FrogOc{}, false, o, plain, 0, -1, turn);
						if ((int)plain.fr.size() < k) continue;
						const FrameOut& last = plain.fr[k - 1];
						const V3 S = { last.res.x, last.landY, last.res.z };
						if (std::hypot(S.x - Sa.x, S.z - Sa.z) > o.near) continue;
						if (judge(m, s, A, plain.fr, LOOSE, true)) continue;  // (clips without the frog)
						ran++;
						vector<FrameOut> pre(plain.fr.begin(), plain.fr.begin() + k);
						const int lx = s16t(S.x), lz = s16t(S.z);
						const double rk = spinRow >= 0 && k - 1 >= spinRow ? o.spinR : o.linkR;
						const int R = (int)(rk + o.frogR) + 1;
						for (int cx = lx - R; cx <= lx + R; cx++) for (int cz = lz - R; cz <= lz + R; cz++) {
							if (o.oneCell && (cx != o.cellX || cz != o.cellZ)) continue;
							// not touching him before the end of row k - 1
							// (the frog in the middle of the cell: N64, the s16 the cell is; MM3D, floats)
							const double fx = cellMid(cx), fz = cellMid(cz);
							bool before = false;
							for (int j = 0; j + 1 < k && !before; j++) {
								const V3 p = pre[j].landed ? V3{ pre[j].res.x, pre[j].landY, pre[j].res.z } : pre[j].res;
								const double rj = spinRow >= 0 && j >= spinRow ? o.spinR : o.linkR;
								const double dd = o.floatPos ? std::hypot(p.x - fx, p.z - fz) : std::hypot((double)(s16t(p.x) - cx), (double)(s16t(p.z) - cz));
								before = dd <= rj + o.frogR;
							}
							if (before) continue;
							// the frog can stand there: a floor, in bounds, no wall within its radius
							auto it = cellFloor.find({ cx, cz });
							if (it == cellFloor.end()) {
								std::optional<double> ok;
								if (auto ffy = m.floorCheck(fx, fz, F(S.y + 50))) {
									const V3 fp = { fx, *ffy, fz };
									const V3 st = m.sphereStep(fp, LOOSE, nullptr);
									if (m.isInBounds(s, fp) && std::hypot(st.x - fx, st.z - fz) <= m.radius - o.frogR + 1e-6) ok = *ffy;
								}
								it = cellFloor.emplace(std::make_pair(cx, cz), ok).first;
							}
							if (!it->second) continue;
							const V3 frog = { fx, *it->second, fz };
							const FrogOc d = frogOc(S, F(S.y - last.prev.y), frog, rk, o);
							if (!d.hit) continue;
							const double margin = o.floatPos ? (frog.y + o.frogH) - (S.y + F(S.y - last.prev.y))
								: (s16t(frog.y) + o.frogH) - (s16t(S.y) + s16t(F(S.y - last.prev.y)));
							if (margin < o.vMargin) continue;
							FrogRun r;
							r.fr = pre;
							frogFrames(m, s, a, spinRow, facing, k, k + 3, S, frog, d, true, o, r, plain.spd[k - 1], plain.floor[k - 1], turn);
							auto v = judge(m, s, A, r.fr, LOOSE, true);
							if (!v || v->frame < k) continue;
							FrogHit h;
							h.facing = facing; h.k = k; h.cx = cx; h.cz = cz; h.turn = turn; h.start = A; h.S = S; h.frog = frog;
							h.margin = margin; h.dx = d.dx; h.dz = d.dz; h.v = *v;
							mine.push_back(h);
						}
					}
				}
				if (fi % 8 == 0) fprintf(stderr, "\r  %s: facing %d / %d, %d starts, %d near an aim point", a.key.c_str(), fi + 1, nFacings, runs.load(), ran.load());
			}
			std::lock_guard<std::mutex> g(mu);
			hits.insert(hits.end(), mine.begin(), mine.end());
		};
		vector<std::thread> ts;
		for (int i = 0; i < threads; i++) ts.emplace_back(worker);
		for (auto& t : ts) t.join();
		fprintf(stderr, "\r%90s\r", "");
		// per start: how many frog cells work (more = easier to set up)
		struct Group { int facing = 0, k = 0, turn = 0; V3 start, S; vector<const FrogHit*> h; };
		std::map<std::tuple<int, int, double, double, int>, Group> groups;
		for (const FrogHit& h : hits) {
			Group& g = groups[{ h.facing, h.turn, h.start.x, h.start.z, h.k }];
			g.facing = h.facing; g.k = h.k; g.turn = h.turn; g.start = h.start; g.S = h.S;
			g.h.push_back(&h);
		}
		vector<const Group*> order;
		for (auto& kv : groups) order.push_back(&kv.second);
		std::stable_sort(order.begin(), order.end(), [](const Group* x, const Group* y) { return x->h.size() > y->h.size(); });
		printf("%s: %zu frog clips, from %zu starts (%d starts run, %d near an aim point)\n", a.name.c_str(), hits.size(), order.size(), runs.load(), ran.load());
		for (size_t i = 0; i < order.size() && i < 25; i++) {
			const Group& g = *order[i];
			// the frog cell in the middle of the ones that work (the furthest from a failing neighbour)
			std::set<std::pair<int, int>> cells;
			for (const FrogHit* h : g.h) cells.insert({ h->cx, h->cz });
			const FrogHit* best = g.h[0];
			int bestD = -1;
			for (const FrogHit* h : g.h) {
				int dd = 0;
				while (dd < 20) {
					bool all = true;
					for (int ox = -dd - 1; ox <= dd + 1 && all; ox++) for (int oz = -dd - 1; oz <= dd + 1 && all; oz++)
						all = cells.count({ h->cx + ox, h->cz + oz }) > 0;
					if (!all) break;
					dd++;
				}
				if (dd > bestD) { bestD = dd; best = h; }
			}
			int x0 = 1 << 30, x1 = -(1 << 30), z0 = 1 << 30, z1 = -(1 << 30);
			for (const FrogHit* h : g.h) { x0 = std::min(x0, h->cx); x1 = std::max(x1, h->cx); z0 = std::min(z0, h->cz); z1 = std::max(z1, h->cz); }
			printf("  %2zu. facing 0x%04X%s, start %s, clip on frame %d: Link at %s before it; %zu frog cells (x %d..%d, z %d..%d)\n",
				i + 1, g.facing, g.turn ? (", turning " + std::to_string(g.turn) + " a spin row").c_str() : "", PF(g.start), g.k + 1, PF(g.S), g.h.size(), x0, x1, z0, z1);
			printf("      e.g. frog at %s (s16 %d, %d; %d cells clear around it), push (%.4f, %.4f) = %.4f, height margin %g: %s through %s, ends %s%s\n",
				PF(best->frog), best->cx, best->cz, bestD, best->dx, best->dz, std::hypot(best->dx, best->dz), best->margin, m.polyName(best->v.pusher).c_str(),
				m.polyName(best->v.crossed).c_str(), PF(best->v.end), best->v.stopAfter ? (" (stop after frame " + std::to_string(best->v.stopAfter) + ")").c_str() : "");
			printf("      --frog-sim \"%.9g,%.9g,%.9g,0x%04X,@%s,%.9g,%.9g\"%s\n", g.start.x, g.start.y, g.start.z, g.facing, a.key.c_str(), best->frog.x, best->frog.z,
				g.turn ? (" --frog-turn " + std::to_string(g.turn)).c_str() : "");
			if (!o.json.empty()) {
				// (the whole action with the frog from frame 1, as --frog-sim runs it)
				Scratch s;
				s.stamp.assign(m.polys.size(), 0);
				FrogRun r;
				frogFrames(m, s, a, spinRow, g.facing, 0, a.frames.size(), g.start, best->frog, FrogOc{}, true, o, r, 0, -1, g.turn);
				if (auto v = judge(m, s, g.start, r.fr, LOOSE, true))
					if (auto c = frogClip(m, s, a, g.start, g.facing, r, *v, best->frog, g.turn)) jsonClips.push_back(*c);
			}
		}
		if (csv) for (const FrogHit& h : hits)
			fprintf(csv, "%s,0x%04X,%.9g,%.9g,%.9g,%d,%.9g,%.9g,%.9g,%d,%d,%.9g,%.9g,%.9g,%g,%.6f,%.6f,%d,%d,%.9g,%.9g,%.9g,%d,%d\n", a.key.c_str(), h.facing,
				h.start.x, h.start.y, h.start.z, h.k + 1, h.S.x, h.S.y, h.S.z, h.cx, h.cz, h.frog.x, h.frog.y, h.frog.z, h.margin, h.dx, h.dz,
				h.v.pusher, h.v.crossed, h.v.end.x, h.v.end.y, h.v.end.z, h.v.stopAfter, h.turn);
	}
	if (csv) fclose(csv);
	writeFrogJson(m, game, o, jsonClips);
	return 0;
}
