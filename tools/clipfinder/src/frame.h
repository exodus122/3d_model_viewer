// clipfinder: one frame of Link's movement and wall pushes, and whether it clips; where he can stand.
#pragma once

#include "collision.h"

// How far back a frame's start is tried from (MOVE_STEPS),
// and how far a frame's move can go for reachability (REACH_DIST). --max-move
// N: both up to N units a frame (speed N / SPEED_RATE); over 45 the starts go
// on every 4 past 32. Set once in main, before any scan: by default
// SCAN_MAX_MOVE units a frame in all four games (40: speed 26.67 on the N64,
// 40 on the 3DS). DEFAULT_MAX_MOVE is the
// move a results file without "maxMove" was scanned with (45, speed 30 on the
// N64: the old default).
static const double SCAN_MAX_MOVE = 40;
static const double DEFAULT_MAX_MOVE = 45;
extern vector<double> MOVE_STEPS;
extern double REACH_DIST;
// onFace: the push that took Link through started with him in front of the
// pusher's actual face (see pushOnFace), not beside it.
// hold: Link only stays through if he keeps moving (the same yaw and speed)
// for one more frame after the push, instead of standing still
struct ClipResult { int crossed, pusher; V3 end; bool onFace; bool hold = false; };
// The frame's move, for a clip's hold frame (clipFromFrame)
struct Move { int yaw; double speed; };
struct LineFrameR { Hit hit; V3 res; PushList trace; };

void setMaxMove(double n);

// Whether a wall push started with Link in front of the wall itself: his
// sphere centre, projected onto the wall along its normal, lands on the
// triangle. The game's wall check projects along the Z or X axis instead
// (CollisionPoly_Check[ZX]IntersectApprox), so a diagonal wall also pushes
// Link standing past its end, in front of its extended plane - as far past as
// he is in front of it at 45 degrees - on top of the 1 unit / detMax 300
// tolerance. A line test's snap is on the triangle already.
// The distance is measured from a vertex, not with the poly's stored plane
// distance: that's a whole number, so the plane can sit up to 0.5 off the
// triangle, enough to put a point on the edge two walls share (OoT Hyrule
// Field TRI 1286 / 1288, 0.006 inside 1286) past it. The 0.1 slack covers the
// rest (the normal is stored as s16s).
bool pushOnFace(const Model& m, const Push& t);

// rayFromY (prevPos.y, walking; NAN = none): the frame's floor check first
// (wall_push_clips.js clipFromFrame).
// move (walking frames): if standing still afterwards puts him back, try
// keeping the stick held for one more frame (ClipResult::hold).
std::optional<ClipResult> clipFromFrame(const Model& m, Scratch& s, const V3& prev, const V3& res,
	const PushList& trace, const Tol& tol, double rayFromY = NAN, const Move* move = nullptr);

std::optional<LineFrameR> lineFrame(const Model& m, Scratch& s, const V3& prev, const V3& next, const Tol& tol);

// crossed: the wall clipped through; a dynapoly one counts wherever he lands (Model::endCounts)
// from: where the frame started - landing in bounds counts too if he couldn't
// walk there from it (Model::walkUnreachable: OoT Shadow Temple, falling
// through TRI 1160 onto TRI 1023, 1300 below)
std::optional<V3> landing(const Model& m, Scratch& s, const V3& res, double floorY, bool& noFloor, int crossed = -1,
	const V3* from = nullptr);

// wall_push_clips.js standSpot: where Link can stand still near (x, z). Not on
// a slide floor (Poly::slide).
std::optional<V3> standSpot(const Model& m, double x, double z, double floorY);

// standSpot through the thread's cache (Scratch::standSpots).
std::optional<V3> standSpotCached(const Model& m, Scratch& s, double x, double z, double floorY);

// --aerial: Link exactly at (x, z), level with his floor there (the one near
// floorY, as standSpot picks it), in the air - not moved to a resting spot:
// the walls there needn't have pushed him out (a bomb or an enemy knocks him
// back after the frame's wall pushes: MM West Clock Town, the step TRI 164
// through TRI 59 from z 23.57, 11.4 in front of 59). Not under a floor within
// 50 above (the floor check would put him up on it).
std::optional<V3> aerialSpot(const Model& m, double x, double z, double floorY);
