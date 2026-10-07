// clipfinder: action clips - a sword lunge's own movement doing the clip.
#pragma once

#include "search.h"

// A melee attack's lunge moves Link by its animation's root motion
// (z_player.c func_80837948: Player_StartAnimMovement with
// ANIM_FLAG_UPDATE_XZ | ANIM_FLAG_ENABLE_MOVEMENT, speedXZ zeroed). That's
// added to world.pos by AnimTask_ActorMovement after Player's update, so
// after the frame's bg check, and the next frame's prevPos is home.pos from
// before it (Player_UpdateCommon: prevPos = home.pos). The next frame's bg
// check then sweeps prevPos -> world.pos with the root motion in it, exactly
// like a walking frame's move (velocity.y is still Link's ground -4 -> -5, so
// posNext is GROUND_DROP below). OoT and MM are the same here.
//
// The lunge (the stick held forward: the stab Z-targeting, else the forward
// slash; a Deku stick always does the forward slash) also sets speedXZ 15 on
// the attack's first action frame, which Math_StepToF(speed, 0, 5) takes to
// 10 at once: UpdatePos moves Link 15 forward the next frame, then 7.5.
//
// Each game frame of an action, exactly as the game does it (bit-exact):
// the root motion the movement task added at the end of the previous frame
// (SkelAnime_UpdateTranslation: the animation's root translation `j`, minus
// prevTransl `p`, rotated by the facing; x 0.01 scale, MM x the form's
// unk_08), then speedXZ `speed` along the facing (Actor_UpdatePos, x 1.5).
// OoT rotates j and p separately and subtracts, MM subtracts first. The
// table comes from the decomps' animation data (link_animetion): see
// action.cpp.
// swing: the sword swing is active at this frame's collision (meleeWeaponState
// != 0): if Link leaves the ground, func_8083AA10 (MM func_8083827C) puts him
// back at prevPos and zeroes speedXZ - no lunging off a ledge.
// angle: speedXZ moves Link at facing + angle (the Deku spins: the backwalk
// moves him backwards, 0x8000).
// stick: speedXZ comes from the stick (held at full tilt) instead of `speed`
// (which is then only its value unobstructed, for aiming and display), worked
// out frame by frame in runFrames, since a wall Link touches lowers the stick's
// speed (Player_ProcessSceneCollision's unk_B50): 'R' running (+2 / -1.5 to
// it), 'B' the Z backwalk (+1.5 / -2 to it x 1.5), 'H' kept as it is (an action
// handler's frame), 'S' a Deku spin frame (dekuSpinFrames).
// rx, rz (Action::recorded): the root motion as measured, already in world
// units, in Link's frame (rz forward, rx as the root x: the tables' rotation).
struct ActionFrame { int jx, jz, px, pz; double speed; bool swing; int angle = 0; char stick = 0; double rx = 0, rz = 0; int shape = -1; };  // shape: (recorded) shape yaw at the row's end, from the facing (-1 none)
// jump: the jumpslash (Z-targeting + A: func_8083BA90 / MM func_808395F0).
// Link leaves the ground at speedXZ 5, velocity.y 5, and moves as any actor
// in the air (Player_Action_80844AF4 / MM Player_Action_29): no root motion,
// gravity the boots' -1.0 for the first frame (it's set before the action
// that starts the jump runs) then -1.2. The stick left alone, speedXZ steps
// down 0.1 a frame (Math_AsymStepToF to 0); stickForward: the stick held
// forward (Z held, the camera behind him), up 0.05 a frame towards the
// stick's speed, full stick x 0.8 x 0.14 = 6.72, at most the run speed limit
// (OoT 6, MM 10; on flat ground: a floor pitch lowers it). The yaw stays the
// facing either way. Where the floor check first puts him on a floor with
// velocity.y <= 0 he lands: speedXZ - 1 (func_80843E64), and the landing
// slash starts - `frames`, the root motion as for the lunges, row 0 moving at
// that speed. That first frame's posNext is velocity.y (not yet reset to the
// ground's -4: the landing frame doesn't) - 1.2 below the floor, x 1.5. The
// rows stop one frame into the step back after it: shield held (the tester
// holds R) interrupts it.
struct Action {
	string key;       // --action-keys name, e.g. "1h-slash"
	string name;      // e.g. "lunge 1h slash"
	string game;      // "OOT" / "MM"
	vector<string> forms;  // upper case, the forms it's for
	vector<ActionFrame> frames;
	bool jump = false;
	bool stickForward = false;  // (jump) the stick held forward in the air
	// actionScan aims only the frames moving at least this fast (the Deku
	// spins: faster than Deku can run, 6 - slower is a walking clip, and
	// above 2 a clip on a slower frame doesn't count)
	double aimMin = 2;
	// actionScan also aims it at acute wall corners (cornerTargets): one
	// frame can wedge Link into the corner deeper than he can stand, the next
	// push him through - a clip no standing start does, so the scan's own clip
	// points don't have it (the Deku spins)
	bool corners = false;
	// (stick frames) the form's run speed limit, R_RUN_SPEED_LIMIT / 100: the
	// stick's full speed; Model::indoors: 5
	double runLimit = 6;
	// Frames run before all the others (a jumpslash: before its air frames):
	// the -walkin variants run into the corner first (walkInVariant). A clip
	// during them is a walking clip, not the action's. cornersOnly: aimed at
	// acute corners only.
	vector<ActionFrame> pre;
	bool cornersOnly = false;
	// (MM) the root motion's scale, the form's ageProperties->unk_08: Human
	// 11/17, Zora 1
	double animScale = 11.0 / 17.0;
	// (jump) the jump's speedXZ and velocity.y (func_808395F0: 5 and 5; Zora
	// x 1.1 and x 0.9), the gravity in the air after the first frame
	// (Player_Action_29: -1.2, Zora -0.8), and the cap on the stick's speed in
	// the air (0: OoT 6, MM 10 as before; Zora 6, its run limit)
	double jumpSpeed = 5, jumpVy = 5, airGravity = -1.2, airCap = 0;
	bool noWalkIn = false;  // no -walkin variant (the charged spin attack)
	// MM3D (loadRecordedActions): the rows were measured in the game
	// (mm3d_action_recorder.lua), not worked out from the code: root motion
	// rx / rz, then speedXZ `speed` at `angle`. canStop: as a stick-driven
	// action's (judge), the recorded Deku spins.
	bool recorded = false;
	bool canStop = false;
	int pressRow = -1;     // (recorded) the recording's row of the last frame before the press (mm3d_action_recorder.lua)
};
extern vector<Action> ACTIONS;

// MM3D: adds the actions recorded in `dir` (every <key>.json the recorder
// wrote) to ACTIONS. False (with `err` set) if a file can't be read; no
// files is not an error (none added).
bool loadRecordedActions(const string& dir, const string& game, string& err);

// Where frame f of action a moves Link from pos (posNext's x / z; y is
// pos.y - GROUND_DROP), facing `facing`.
// noSpeed: speedXZ was zeroed (a swing frame put Link back): root motion only.
// speed: the frame's speedXZ instead of f.speed (the jumpslash's landing row).
V3 actionStep(const Action& a, const ActionFrame& f, const V3& pos, int facing, bool noSpeed = false, double speed = NAN);
// Frame f's move as a speed (move / 1.5) and angle from the facing, for
// display; the angle is the s16 yaw at facing 0.
void actionFrameMove(const Action& a, const ActionFrame& f, double& speed, int& angle);

// The actions of `game` named in `list` ("all", or keys separated by commas).
// err: an unknown name.
vector<int> parseActions(const string& game, const string& list, string& err);
// Whether action a is done by the form (upper case: "ADULT", "HUMAN", ...)
bool actionForForm(const Action& a, const string& formUpper);

// Link standing still at `start` facing `facing` does action a: its frames
// (line test, pushes, floor check each), then two frames standing still. A
// clip (kind 0 / 1: a wall push, still to be categorised; 2: the floor check
// lifted him behind the wall, as slope.h), or none.
std::optional<Clip> actionClip(const Model& m, Scratch& s, const V3& start, int facing, int action);

// --sim @KEY: each frame of the action from `start` (the move, the pushes,
// where the floor check leaves him), as actionClip runs them
void printActionFrames(const Model& m, const V3& start, int facing, int action);

// Whether any of `actions` is a jumpslash (its targets include falling clip points)
bool anyJump(const vector<int>& actions);

// Every action in `actions` aimed at every walking and slope clip point of
// `targets` (the ordinary scan's; a jumpslash: the falling ones too): from
// many facings, the start the action takes to that point's posNext (for each
// of its frames, unobstructed on flat ground), where Link rests there. At most one clip per target point and action. Wall pairs get one
// category per action, as the scan's.
vector<Clip> actionScan(const Model& m, const vector<Clip>& targets, const vector<int>& actions, int threads);

// --frog: an actor's OC cylinder (MM En_Minifrog) pushing Link during a Deku
// action (action.cpp frogSearch). The push is CollisionCheck_SetOCvsOC's:
// Link's share (ratio = frog mass / both masses) of the overlap of the two
// cylinders (s16 positions), added to the next frame's move by Actor_UpdatePos.
struct FrogOpts {
	double frogR = 12, frogH = 14;  // En_Minifrog sCylinderInit
	double linkR = 12, spinR = 30;  // Player_ResetCylinder / Player_SetCylinderForAttack(DMG_DEKU_SPIN, 1, 30)
	double ratio = 0.6;             // 30 / (30 + 20): frog mass 30 (EnMinifrog_Init), Deku sPlayerMass 20
	bool floatPos = false;          // the colliders' positions as floats (OoT3D / MM3D: the user's runs), not N64's truncated s16s
	double linkH = 30;              // (Link's cylinder: the feet to the head + 10, roughly; for the height check)
	double vMargin = 2;             // the frog's top at least this far over Link's cylinder bottom
	int spinRow = -1;               // the first row Player_Action_95 runs (radius 30); -1: from the key
	int yawStep = 0x80;
	double aimR = 4, aimStep = 0.5, near = 1.5;
	int maxRows = 6;                // clip rows tried after the spin starts (or the run's top speed)
	vector<V3> aims;                // --frog-aim: where Link should be the frame before the clip
	bool oneCell = false;           // --frog-cell X,Z: only the frog in that s16 cell
	int cellX = 0, cellZ = 0;
	int yawFrom = 0, yawTo = 0xFFFF;  // --frog-yaws FROM-TO
	string csv;
	// --frog-turns FROM:TO:STEP: curved spins, each spin row turning his move yaw
	// (and shape) by that much more (Player_Action_95: Math_ScaledStepToS toward the
	// stick, REG(27) = 2000 a frame on N64; MM3D runs turned >= 1581); --frog-turn: --frog-sim's
	vector<int> turns = { 0 };
	int simTurn = 0;
	// --frog-json: the clips (frogSearch: the best frog of each start listed;
	// frogSim: that one) as a results JSON for wall_clip_tester.lua
	string json, mapName, form;
	int numPolygons = 0;
};
int frogSearch(const Model& m, const vector<Clip>& targets, const string& keys, const string& game, const FrogOpts& o, int threads);
int frogSim(const Model& m, const string& arg, const string& game, const FrogOpts& o);
