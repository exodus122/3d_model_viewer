// clipfinder: the game's wall / floor collision in f32 (BgCheck_*), as a Model: the
// scene's static collision, plus the dynapoly actors from a viewer export (--dyna).
#pragma once

#include "scene.h"

////////////////////////////////////////
// Collision model (wall_push_clips.js)
////////////////////////////////////////

static const int SNORMAL_FLOOR = (int)std::trunc(0.5 * 32767);
static const int SNORMAL_CEIL = (int)std::trunc(-0.8 * 32767);

struct Poly {
	bool exists = false;
	int id;
	double ax, ay, az, bx, by, bz, cx, cy, cz;
	int sx, sy, sz;
	double nx, ny, nz, dist, nMag, nXZ, invNXZ;
	double minX, maxX, minY, maxY, minZ, maxZ, sortY, tz, tx;
	bool isFloor, isCeiling, isWall;
	int bg = -1; // dynapoly: its BgActor (Model::bgActors), -1 for static
	// a loading zone (SurfaceType exit index) or a void plane (floor property 5
	// respawn, 12 void out, MM 13 too); dynapolys: never (the export has no surface types)
	bool loadOrVoid = false;
	int exitIndex = 0, floorProp = 0; // (the static polys' SurfaceType fields)
	// a slide floor: SurfaceType_GetFloorEffect (data[1] >> 4 & 3) == FLOOR_EFFECT_1.
	// Player_HandleSlopes (OoT and MM): on one, Link slides down it (Player_Action_SlideOnSlope),
	// or facing up it, gets pushed down it (pushedSpeed) - he can't stand still there.
	// Dynapolys: never (the export has no surface types)
	bool slide = false;
};

// One dynapoly actor's collision as DynaPoly_ExpandSRT leaves it (dyna.cpp
// reads it from the viewer's export). walls / floors are its dynaLookup lists:
// DynaSSNodeList_SetSSListHead puts each poly at the head, so they run in
// reverse poly order, unsorted. The bounding sphere is a Sphere16 (s16s).
struct BgActor {
	string name;
	vector<int> walls, floors;
	double cx, cy, cz, r, minY, maxY;
};

struct Tol { double detMax, chkDist, lineChkDist; };
static const Tol LOOSE = { 300, 1, 1 };
static const Tol STRICT = { 0, 0, 0 };

inline double planeDist(const Poly& p, double x, double y, double z) {
	if (isZero(p.nMag)) return 0;
	return F(F(F(F(F(p.nx * x) + F(p.ny * y)) + F(p.nz * z)) + p.dist) / p.nMag);
}

inline double edgeDistSq(double x0, double y0, double x1, double y1, double x2, double y2) {
	double dx = F(x2 - x1), dy = F(y2 - y1);
	double lenSq = F(sq(dx) + sq(dy));
	if (isZero(lenSq)) return INFINITY;
	double t = F(F(F(F(x0 - x1) * dx) + F(F(y0 - y1) * dy)) / lenSq);
	if (!(t >= 0 && t <= 1)) return INFINITY;
	return F(sq(F(F(F(dx * t) + x1) - x0)) + sq(F(F(F(dy * t) + y1) - y0)));
}

inline bool triChkPara(double a0, double b0, double a1, double b1, double a2, double b2, double pa, double pb,
	double detMax, double chkDist, double nComp) {
	if (!(F(std::min({ a0, a1, a2 }) - chkDist) <= pa && F(std::max({ a0, a1, a2 }) + chkDist) >= pa &&
		F(std::min({ b0, b1, b2 }) - chkDist) <= pb && F(std::max({ b0, b1, b2 }) + chkDist) >= pb)) return false;
	double chkSq = sq(chkDist);
	if (F(sq(F(a0 - pa)) + sq(F(b0 - pb))) < chkSq || F(sq(F(a1 - pa)) + sq(F(b1 - pb))) < chkSq ||
		F(sq(F(a2 - pa)) + sq(F(b2 - pb))) < chkSq) return true;
	double d01 = F(F(F(a0 - pa) * F(b1 - pb)) - F(F(b0 - pb) * F(a1 - pa)));
	double d12 = F(F(F(a1 - pa) * F(b2 - pb)) - F(F(b1 - pb) * F(a2 - pa)));
	double d20 = F(F(F(a2 - pa) * F(b0 - pb)) - F(F(b2 - pb) * F(a0 - pa)));
	if ((d01 <= detMax && d12 <= detMax && d20 <= detMax) || (d01 >= -detMax && d12 >= -detMax && d20 >= -detMax)) return true;
	if (std::fabs(nComp) > 0.5) {
		if (edgeDistSq(pa, pb, a0, b0, a1, b1) < chkSq || edgeDistSq(pa, pb, a1, b1, a2, b2) < chkSq ||
			edgeDistSq(pa, pb, a2, b2, a0, b0) < chkSq) return true;
	}
	return false;
}
inline bool triChkX(const Poly& p, double y, double z, double dm, double ck) { return triChkPara(p.ay, p.az, p.by, p.bz, p.cy, p.cz, y, z, dm, ck, p.nx); }
inline bool triChkY(const Poly& p, double z, double x, double dm, double ck) { return triChkPara(p.az, p.ax, p.bz, p.bx, p.cz, p.cx, z, x, dm, ck, p.ny); }
inline bool triChkZ(const Poly& p, double x, double y, double dm, double ck) { return triChkPara(p.ax, p.ay, p.bx, p.by, p.cx, p.cy, x, y, dm, ck, p.nz); }

inline bool pointInTri3D(const Poly& p, double x, double y, double z, double tol) {
	double ax = std::fabs(p.nx), ay = std::fabs(p.ny), az = std::fabs(p.nz);
	double a0, b0, a1, b1, a2, b2, pa, pb;
	if (ax >= ay && ax >= az) { a0 = p.ay; b0 = p.az; a1 = p.by; b1 = p.bz; a2 = p.cy; b2 = p.cz; pa = y; pb = z; }
	else if (az >= ay) { a0 = p.ax; b0 = p.ay; a1 = p.bx; b1 = p.by; a2 = p.cx; b2 = p.cy; pa = x; pb = y; }
	else { a0 = p.az; b0 = p.ax; a1 = p.bz; b1 = p.bx; a2 = p.cz; b2 = p.cx; pa = z; pb = x; }
	double d01 = (a0 - pa) * (b1 - pb) - (b0 - pb) * (a1 - pa);
	double d12 = (a1 - pa) * (b2 - pb) - (b1 - pb) * (a2 - pa);
	double d20 = (a2 - pa) * (b0 - pb) - (b2 - pb) * (a0 - pa);
	if ((d01 >= 0 && d12 >= 0 && d20 >= 0) || (d01 <= 0 && d12 <= 0 && d20 <= 0)) return true;
	double tSq = tol * tol;
	auto near = [&](double x0, double y0, double x1, double y1, double x2, double y2) {
		double dx = x2 - x1, dy = y2 - y1, len = dx * dx + dy * dy;
		if (len == 0) return false;
		double t = std::max(0.0, std::min(1.0, ((x0 - x1) * dx + (y0 - y1) * dy) / len));
		return std::pow(x1 + dx * t - x0, 2) + std::pow(y1 + dy * t - y0, 2) <= tSq;
	};
	return near(pa, pb, a0, b0, a1, b1) || near(pa, pb, a1, b1, a2, b2) || near(pa, pb, a2, b2, a0, b0);
}

struct Push { int poly; V3 from, to; bool line = false; };
struct Hit { int poly; double x, y, z; };

// Fixed-capacity inline lists. The scan's inner loops used to allocate their
// results on the heap, and with many threads the C runtime's allocator lock
// made the threads wait on each other more than they worked.
template <typename T, int N>
struct InlineList {
	int n = 0;
	T a[N];
	void push_back(const T& v) { if (n < N) a[n++] = v; }
	bool empty() const { return n == 0; }
	int size() const { return n; }
	const T* begin() const { return a; }
	const T* end() const { return a + n; }
	const T& operator[](int i) const { return a[i]; }
	void clear() { n = 0; }
};
using FloorList = InlineList<double, 16>;  // floor heights under one point
using PushList = InlineList<Push, 64>;     // one frame's wall pushes

// Per-thread scratch: an open-addressing floorsNear cache (reset per wall or
// wall pair), a visited-stamp array and reusable id lists.
struct Scratch {
	static const int CAP = 1 << 15;
	vector<int64_t> cacheKey = vector<int64_t>(CAP);
	vector<uint32_t> cacheGen = vector<uint32_t>(CAP, 0);
	vector<FloorList> cacheVal = vector<FloorList>(CAP);
	uint32_t gen = 1;
	int used = 0;
	void clearCache() { gen++; used = 0; }

	// standSpot results for the pushing wall being scanned: its crossing
	// points try starts at the same spots over and over (every falling drop
	// of a point on a vertical wall has the same x/z), keyed on the f32 bits
	// of x, z and the floor height.
	struct SpotKey {
		uint32_t x, z, y;
		bool operator==(const SpotKey& o) const { return x == o.x && z == o.z && y == o.y; }
	};
	struct SpotHash {
		size_t operator()(const SpotKey& k) const {
			return (size_t)(((uint64_t)k.x * 0x9E3779B97F4A7C15ull) ^ ((uint64_t)k.z * 0xC2B2AE3D27D4EB4Full) ^ k.y);
		}
	};
	std::unordered_map<SpotKey, std::optional<V3>, SpotHash> standSpots;
	// Model::walkUnreachable results, keyed on the end and start spots (5 units)
	std::unordered_map<uint64_t, bool> unreachable;
	// Model::walkUnreachable's whole flood fill from a start spot (5 units):
	// the floor heights it reached, per 10 x 10 cell. An end it can't reach
	// takes the whole fill, and falling / ground clips land at many ends from
	// the same few starts.
	// (flat: the points sorted by cell, and each cell's first point in a dense
	// grid around the start - a map of small vectors was ~1 MB a fill, 3 GB with
	// 12 threads' caches full: MM Ikana Graveyard ran out of memory)
	struct WalkFill {
		int64_t bx = 0, bz = 0;  // the start's cell
		int n = 0;               // the grid is n x n cells, the start's in the middle
		vector<uint32_t> first;  // n * n + 1: cell (i, j)'s points are pts[first[c]] .. pts[first[c + 1]]
		vector<std::array<float, 4>> pts;  // x, z, floor y, walking distance
	};
	std::unordered_map<uint64_t, std::shared_ptr<const WalkFill>> walkFills;
	size_t walkFillPts = 0;  // the points in walkFills (the cache's size cap)

	vector<uint32_t> stamp;
	uint32_t curStamp = 0;
	vector<int> wallsBuf, cellsBuf;
	vector<V3> cornerBuf;  // cornerSpotsNear results
	uint32_t nextStamp() {
		if (++curStamp == 0) { std::fill(stamp.begin(), stamp.end(), 0); curStamp = 1; }
		return curStamp;
	}
};

struct Model {
	ColCtx colCtx;
	double radius, checkHeight;
	int lowDrop;
	bool extendedOnly = false; // leave out wall pairs with an acute clip (see pushOnFace)
	vector<Poly> polys;          // the scene's polys by index, then the dynapolys (ids from numStatic)
	int numStatic = 0;
	vector<BgActor> bgActors;    // in bgId order
	vector<int> dynaWalls;       // every dynapoly wall, for the checks that aren't the game's
	vector<vector<int>> pairWalls; // subWalls with the dynapoly walls added: wall pair candidates only
	vector<vector<int>> cellWallsL, cellFloorsL; // sorted, per subdivision
	std::unordered_map<int64_t, vector<int>> floorGrid;
	const double floorCell = 128;
	// Convex corner pockets (corners.h, findCornerSpots): resting spots where
	// Link's sphere is partly inside a wall corner that sticks out at him, and
	// a cornerCell xz grid of them. Empty with --no-corners.
	vector<V3> cornerSpots;
	std::unordered_map<int64_t, vector<int>> cornerGrid;
	const double cornerCell = 32;

	static int64_t key2(int64_t a, int64_t b) { return (a << 32) ^ (b & 0xFFFFFFFF); }

	void build(const vector<Tri>& tris, int numPolygons);

	// Adds a dynapoly actor (after build): its tangible polys, in poly index
	// order, already in world space. Returns the first poly's id.
	struct DynaPolyIn { int v[3][3]; int n[3]; int d; char type; };
	int addBgActor(const string& name, const vector<DynaPolyIn>& in, const double center[3], double radius, double minY, double maxY);

	const vector<int>& cellWalls(double x, double y, double z) const { return cellWallsL[pointCell(colCtx, x, y, z).index]; }

	FloorList floorsAt(double x, double z) const;

	const FloorList& floorsNear(Scratch& s, double x, double z) const;

	// BgCheck_CheckWallImpl after its line test: the dynapoly walls
	// (BgCheck_SphVsDynaWall), then the static ones (BgCheck_SphVsStaticWall),
	// then - if a dynapoly pushed, or lineDyna (the line test hit one) and no
	// static wall did - the one-face static line check from `prev`. prev null:
	// standing still, prev is pos + GROUND_DROP.
	V3 sphereStep(const V3& pos, const Tol& tol, PushList* trace, const V3* prev = nullptr, bool lineDyna = false) const;

	// Where Link comes to rest standing at `pos` (pushes until they stop, at
	// most 4 frames), or none.
	// (standing still, posNext is GROUND_DROP below his feet: the pushes run there)
	std::optional<V3> restingSpot(const V3& pos) const;

	// wall_push_clips.js floorCheck (BgCheck_RaycastFloorImpl, flags 0x1C):
	// the highest static floor, or wall whose normal doesn't point down, under
	// (x, z) and below y, stepping down a subdivision at a time.
	// poly: the floor found (its id), if not null.
	std::optional<double> floorCheck(double x, double z, double y, int* poly = nullptr) const;
	std::optional<double> staticFloorCheck(double x, double z, double y, int* poly = nullptr) const;
	bool lineVsSphere(const BgActor& bg, const V3& a, const V3& b) const;

	std::optional<V3> lineVsPoly(const Poly& p, const V3& a, const V3& b, double chkDist, bool oneFace) const;

	// BgCheck_CheckLineImpl: static, then (dyna) the dynapoly actors'.
	std::optional<Hit> lineHit(Scratch& s, const V3& a, const V3& b, const Tol& tol, bool floors, bool oneFace = false, bool dyna = true) const;

	// wallsAlong, as a list of poly ids (deduplicated): the cell's own list, or
	// s.wallsBuf.
	const vector<int>& wallsAlong(Scratch& s, const V3& a, const V3& b) const;

	int crossedWall(Scratch& s, const V3& a, const V3& b, bool exiting = false) const;

	bool behindWall(const V3& pos) const;

	// Not behind a wall, and none of 8 level rays at his check height meets a
	// wall's back first. floorsBlock: a ray that goes into a floor first
	// doesn't count - up a slope the rays go under the ground, and under the
	// bottom of the walls on it, to the back of a wall far off (OoT Death
	// Mountain Trail, the slope TRI 675 up to TRI 642). For where Link starts
	// or stands; whether he ends up out of bounds (endCounts) keeps every ray.
	bool isInBounds(Scratch& s, const V3& pos, bool floorsBlock = false) const;

	// Whether a clip through `crossed` that leaves Link at `end` counts: out of
	// bounds, or - through a dynapoly (a gate, a fence, a crate) - still behind
	// it, wherever that is: getting past it is the point. Behind means at his
	// check height, on its back side and within the triangle's span (so not
	// landed on top of it: two touching crates, pushed from one into the other
	// while falling, he just lands on the other's top).
	// from (the frame's start, when known): also counts if he ends in bounds
	// but somewhere he couldn't walk to from where he started
	// (walkUnreachable): another room, a ledge, or past a dynapoly (MM Stone
	// Tower Temple: past a sun block into the alcove behind it).
	bool endCounts(Scratch& s, int crossed, const V3& end, const V3* from = nullptr) const {
		if (crossed >= 0 && polys[crossed].bg >= 0 && behindPoly(polys[crossed], end)) return true;
		if (!isInBounds(s, end)) return true;
		return from && walkUnreachable(s, end, *from);
	}
	// Whether Link couldn't walk from `from` to `end`: a flood fill from
	// `from` on a WALK_STEP (10) grid out to WALK_RADIUS (600) - steps up to
	// 50, drops up to 300, walls (either face, dynapolys too) more than 50 tall
	// block - never gets within a step of it. Climbing, jumping, hookshots,
	// ... aren't modelled, and a way round further than 600 counts as none.
	// Or (the user's rule: a clip counts if it's a shorter way to somewhere
	// reachable) the walk there is a long way round: walkDistance at least
	// WALK_SHORTCUT_MIN (150) more than the straight line, and at least twice it.
	// Cached per spot (Scratch::unreachable).
	bool walkUnreachable(Scratch& s, const V3& end, const V3& from) const;
	// How far Link walks from `from` to `end` (the same flood fill; its BFS steps x
	// 10, a lower bound: diagonal steps count 10), or -1 if it doesn't get there
	double walkDistance(Scratch& s, const V3& end, const V3& from) const;
	// The walk if it makes the clip a shortcut by walkUnreachable's rule, -1 if
	// he can't walk there, else 0 (the clip counted for another reason)
	double walkShortcut(Scratch& s, const V3& end, const V3& from) const;
	// --sim X,Y,Z,walk,X2,Y2,Z2: the same flood fill's path from `from` to `end`
	// (each grid point, feet), empty if it doesn't get there
	vector<V3> walkPath(Scratch& s, const V3& from, const V3& end) const;
	bool behindPoly(const Poly& p, const V3& pos) const;

	bool dynaPairsOnly = false; // --dyna-only: wall pairs with a dynapoly wall in them
	// which scans run (--type): wall pushes (walking, and falling with lowDrop), slope clips, ground clips
	bool wallPushes = true, slope = true, ground = false;
	// --pair: only scan the candidates (wall pairs, slope walls) near these
	// two polys; -1 none. Every poly still collides as usual.
	int focusA = -1, focusB = -1;
	// --slope-starts: crossing points whose surroundings are only in bounds
	// not counting the rays into a slope are searched too (slower)
	bool slopeStarts = false;
	// --aerial: falling clips may also start in the air where Link couldn't
	// stand still (aerialSpot)
	bool aerial = false;
	// --ground-step: the ground clip scan's widest step along a wall (1: every unit)
	int groundStepMax = 3;
	// --slope-step: the same for the slope clip scan
	int slopeStepMax = 3;
	// --wall-step: a second wall push pass on the wall pairs nothing clipped
	// through, standing points every wallStep (no cap on a pair's grid) and
	// crossing points every wallStep / 2, one clip per new pair (0: none)
	double wallStep = 0;
	// --keep-load-void: keep clips that start on a loading zone or void plane
	bool keepLoadVoid = false;
	// every room of the scene is indoors (ROOM_TYPE_INDOORS): Player_SetBootData
	// (MM func_80123140) sets R_RUN_SPEED_LIMIT 500 there (action.h stick frames)
	bool indoors = false;
	// Whether the floor Link stands on at `start` is a loading zone or void plane.
	bool startOnLoadVoid(const V3& start) const {
		int poly = -1;
		auto fy = floorCheck(start.x, start.z, F(start.y + 1), &poly);
		return fy && poly >= 0 && polys[poly].loadOrVoid;
	}
	// Whether poly p's box comes within `margin` of the --pair polys' (true without --pair).
	bool nearFocus(const Poly& p, double margin) const {
		if (focusA < 0) return true;
		for (int id : { focusA, focusB }) {
			const Poly& q = polys[id];
			if (p.maxX >= q.minX - margin && p.minX <= q.maxX + margin && p.maxY >= q.minY - margin && p.minY <= q.maxY + margin &&
				p.maxZ >= q.minZ - margin && p.minZ <= q.maxZ + margin) return true;
		}
		return false;
	}

	// "TRI 12", or "TRI 1300 (Obj_Tokei_Tobira dynapoly 3)" for a dynapoly
	string polyName(int id) const {
		string s = "TRI " + std::to_string(id);
		if (id >= 0 && id < (int)polys.size() && polys[id].bg >= 0) {
			int first = id;
			while (first > numStatic && polys[first - 1].bg == polys[id].bg) first--;
			s += " (" + bgActors[polys[id].bg].name + " dynapoly " + std::to_string(id - first) + ")";
		}
		return s;
	}
};
