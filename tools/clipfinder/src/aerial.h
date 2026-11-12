// clipfinder: aerial acute angle clips - Link in the air (a jump, a fall off a
// ledge), moving with horizontal speed into an acute corner of two walls: one
// wall's push takes him through the other, as in a walking acute clip, but at
// any height up the walls. Acute points only: the clip works without the
// walls' extended planes, pushed from in front of the pusher's face
// (pushOnFace).
//
// The frame's y velocity matters in three ways (each frame is tried at every
// y velocity of aerialVys):
// - Entering the corner from above or below: at the start's own check height
//   the walls aren't there (under an overhang or a fence's bottom edge, over a
//   ledge's top), so he can start right over or under the corner and the
//   frame's rise or fall puts posNext deep in it, little or no horizontal
//   move needed.
// - Falling fast (checkHeight + dy < 5, OoT -14 and faster): the game's line
//   test runs at his feet (ground.h groundLine) instead of at check height,
//   and can miss the pusher (under its bottom edge), so there's no snap to
//   its face before the pushes.
// - Landing in the frame: the floor check (from prevPos.y + 50) puts him on a
//   floor at or above his feet - pos.y = floorHeight whatever his y velocity
//   (z_actor.c func_8002E2AC; only GROUND needs velocity.y <= 0) - so a floor
//   behind the wall he's pushed through lifts him onto it (an aerial slope clip).
#pragma once

#include "search.h"

// The most speedXZ the scan uses in the air: a frame moves up to this x
// SPEED_RATE (27 on the N64)
static const double AERIAL_MAX_SPEED = 18;

// --aerial-vys: the y velocities to try (empty: the default list, see aerialVys)
extern vector<double> AERIAL_VY_LIST;

// The y velocities each aerial frame is tried at, rising first: by default 6
// and 3 (a backflip is 5.8, a sidehop 3.5, a jumpslash 5), 0 (the top of a
// jump), -5, -10, the fastest fall that still has the line test at check
// height ((5 - checkHeight) / 1.5, rounded up: OoT adult -14), and -20 (the
// fastest, the line test at the feet).
vector<double> aerialVys(const Model& m);

// The floor under p (where Link lands falling straight down), or none
std::optional<V3> floorUnder(const Model& m, const V3& p);

// Where Link can be in the air at about p (his height kept): where the walls'
// pushes there (at his own check height) settle (at most 4 frames), in bounds
// over a floor in bounds (a pit has its void plane), and not under a floor within 50
// above his feet (the floor check would put him up on it), or none.
std::optional<V3> airStart(const Model& m, Scratch& s, const V3& p);

// One frame in the air from prev at yaw / speed with velocity.y vy, then
// falling (or standing where the floor check put him): an aerial acute clip
// (kind 4), or none. lineWall >= 0: the frame's line test (at check height)
// has to hit that wall (a crossing); -1: it mustn't hit anything; -2: either.
std::optional<Clip> aerialFrame(const Model& m, Scratch& s, const V3& prev, int yaw, double speed, double vy, int lineWall);

// Every wall pair of pusher A, at heights up both walls (every 5 of check
// height, at most 20 heights a pair): posNext in the corner where A's push
// takes Link behind the other wall, and moves through A's face near the
// corner (A a sloped floor: only those, the line test's snap off it), each from a start in the air up to AERIAL_MAX_SPEED away, at each
// of aerialVys (the start that much lower or higher).
// Calls yield for each clip, the first start found per point and y velocity.
// pairDone(pusher, crossed): skip what's already found (--first-per-pair).
void aerialClipsForPusher(const Model& m, Scratch& s, const Poly& A, const vector<const Pair*>& pairs,
	const std::function<bool(int, int)>& pairDone, const std::function<void(const Clip&)>& yield);
