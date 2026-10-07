// clipfinder: the scan for wall push clips over a whole map.
#pragma once

#include "frame.h"

struct Clip {
	// The wall pair's category, the same for all its points (walking and
	// falling): 0 acute if any of the pair's points is an acutePoint, else 1
	// extended. Set at the end of the scan. 2: a slope clip (slope.h), whose
	// pusher is the floor that lifts Link behind the wall. 3: a ground clip
	// (ground.h), whose pusher is the floor Link falls through.
	int kind = 1;
	// This point on its own clips without the extended planes, pushed from in
	// front of the pusher's face (pushOnFace)
	bool acutePoint = false;
	bool cross = false;
	bool hold = false;    // only with the stick held one more frame (ClipResult::hold)
	bool inBounds = false; // ends in bounds (past a dynapoly, or somewhere he couldn't walk to: Model::endCounts)
	double walkDist = 0;   // (inBounds) how far Link walks there from the start, -1 he can't: a shortcut otherwise
	int drop = 0;         // falling: posNext this far below the floor (0 walking)
	bool aerial = false;  // --aerial: prev is in the air where he couldn't stand still (aerialSpot)
	int pusher = -1, crossed = -1;
	V3 from, prev, next, res, end;
	bool hasNext = false, hasFloorY = false, endNoFloor = false;
	double floorY = 0;
	vector<int> yaws;
	int yaw = 0;          // crossings and standing points: the exact move (s16 yaw, f32 speed)
	bool hasMove = false;
	double speed = 0;
	double speed2 = 0;    // slope clips: a second frame's speed (same yaw) before standing still, 0 none
	double vy = 0;        // ground clips: velocity.y for the frame (posNext.y = prev.y + vy x 1.5)
	// action clips (action.h): the action (ACTIONS index, -1 none), the way
	// Link faces at the start, and where each of its frames leaves him (after
	// the floor check). yaw / speed are then the clip frame's move.
	int action = -1;
	int facing = 0;
	vector<V3> frames;
	// each frame's move, as a speed (move / 1.5) and angle from the facing (the JSON's actionFrames)
	vector<std::pair<double, int>> frameMoves;
	int airFrames = 0;    // a jumpslash: how many of the frames are in the air (the last one lands)
	int stopAfter = 0;    // an action: stop after this many of its frames, Link out of bounds in the wall (0: its whole length)
	bool hasFrog = false; // --frog: the frog (En_Minifrog) standing here pushes Link (action.h FrogOpts)
	V3 frog;
	int frogTurn = 0, frogTurnRow = -1;  // --frog-turns: yaw added each spin row after frogTurnRow (0-based)
	// --min-speed: the slowest move from a standable start that does it
	// (reachability below); reachDone and no reach = none found
	bool reachDone = false, hasReach = false;
	double reachSpeed = 0;
	int reachYaw = 0;
	V3 reachStart;
};

// firstPerPair: stop looking at a wall pair (pushing wall, clipped wall) once
// one clip through it is found (like wall_clip_tester.lua's
// RECORD_ONE_PER_PAIR) - one point per pair, much faster.
vector<Clip> scan(const Model& m, int threads, bool firstPerPair = false);

// --max-per-pair N: at most n points per wall pair (and per row the viewer
// shows it in: crossing / standing, walking / falling), spread out evenly
// (farthest point sampling on the clip points). Always kept: the lowest
// --min-speed reach, and an acute point of an acute pair. Keeps the order.
// Returns how many were left out.
size_t thinClips(vector<Clip>& clips, int n);

// The largest per-row cap, at most maxN (and at least minN), that thinClips
// can use on every one of `sets` (one file's forms) and keep them under
// `budget` points in all. maxN when they're already under.
int thinCapForBudget(const vector<const vector<Clip>*>& sets, int maxN, int minN, size_t budget);

// --type: which clips to look for and keep
enum : int {
	TYPE_ACUTE = 1, TYPE_EXTENDED = 2, TYPE_SLOPE = 4, TYPE_GROUND = 8, TYPE_FALLING = 16, TYPE_ACTIONS = 32,
	TYPE_ALL = 31,  // "all": every clip type, not the lunges
};
// "acute,extended,slope,ground,falling,actions" (or "all": the first five) to TYPE_ bits; 0 and err if a name is wrong
int parseTypes(const string& list, string& err);
// The file name part for a set of types: "" for the default (acute,
// extended, slope), "_all" for all, else "_" and the names joined by "-",
// e.g. "_acute-falling"
string typeTag(int types);
// Drop the clips the types don't ask for: walking wall pushes by the pair's
// category (acute / extended), falling ones with falling (and the category,
// if acute or extended was picked), slope and ground clips by theirs. With
// actions and none of acute / extended / slope, all three are kept (the
// lunges' targets, then the lunges' clips).
void keepTypes(vector<Clip>& clips, int types);
