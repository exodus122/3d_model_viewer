#include "sim.h"
#include "action.h"
#include "corners.h"

static const char* P(const V3& v) {
	static char b[4][96];
	static int k = 0;
	k = (k + 1) % 4;
	snprintf(b[k], 96, "(%.9g, %.9g, %.9g)", v.x, v.y, v.z);
	return b[k];
}

// Whether Link could be at the start at all: a floor within the floor check's
// reach (from y + 50) above his feet would put him up on it (inside a step:
// MM West Clock Town, under the platform floor TRI 162), and with no floor
// under him there's nothing to stand on. A floor below is fine, but says he's
// in the air.
static void warnStartFloor(const Model& m, const V3& start) {
	int fp = -1;
	auto fy = m.floorCheck(start.x, start.z, F(start.y + 50), &fp);
	if (fy && F(*fy - start.y) > 0.01)
		printf("WARNING: the start is under %s (y %.9g, %.9g above his feet): the floor check would put him up on it - not a real start\n",
			m.polyName(fp).c_str(), *fy, F(*fy - start.y));
	else if (!fy)
		printf("WARNING: no floor under the start: nothing to stand on (out of the level, or over a void)\n");
	else if (F(start.y - *fy) > 0.01)
		printf("note: the start is %.9g above its floor (%s at y %.9g): in the air\n", F(start.y - *fy), m.polyName(fp).c_str(), *fy);
}

// SPEED as "15/7": a frame of walking per speed (the same yaw), each ending
// with the floor check, then two frames standing still. For slope clips
// (slope.h), where the frame after the one through the wall can matter.
// moves: each frame's posNext from where Link is (a walking frame at a yaw and speed, or an action frame)
// swing (action frames): off the ground on such a frame, Link is put back at
// the frame's start and noSpeed set (action.h ActionFrame::swing)
static int runSimFrames(const Model& m, const V3& start, const vector<std::function<V3(const V3&)>>& moves,
	const vector<bool>& swing = {}, bool* noSpeed = nullptr) {
	Scratch s;
	s.stamp.assign(m.polys.size(), 0);
	printf("start %s, in bounds: %s\n", P(start), m.isInBounds(s, start, true) ? "yes" : "NO");
	warnStartFloor(m, start);
	{
		int fp = -1;
		auto fy = m.floorCheck(start.x, start.z, F(start.y + 1), &fp);
		if (fy && fp >= 0 && m.polys[fp].slide)
			printf("  on %s, a slide floor (floor effect 1): Link slides off it, or is pushed down it - not a start the scan uses\n", m.polyName(fp).c_str());
	}
	V3 cur = start;
	for (size_t i = 0; i < moves.size(); i++) {
		V3 next = moves[i](cur);
		printf("frame %zu: move (%.9g, %.9g), posNext %s\n", i + 1, F(next.x - cur.x), F(next.z - cur.z), P(next));
		PushList trace;
		V3 res;
		if (auto f = lineFrame(m, s, cur, next, LOOSE)) {
			printf("  line test at y %.9g hits TRI %d, snapped to %s\n", F(next.y + m.checkHeight), f->hit.poly, P(f->trace[0].to));
			res = f->res;
			trace = f->trace;
		} else res = m.sphereStep(next, LOOSE, &trace, &cur);
		for (const Push& t : trace) if (!t.line) printf("  %s pushes %s -> %s\n", m.polyName(t.poly).c_str(), P(t.from), P(t.to));
		int floorPoly = -1;
		auto fy = m.floorCheck(res.x, res.z, F(cur.y + 50), &floorPoly);
		if ((!fy || F(*fy - res.y) < -11) && i < swing.size() && swing[i]) {
			printf("  off the ground with the sword swing active: put back at %s, speedXZ zeroed\n", P(cur));
			if (noSpeed) *noSpeed = true;
			continue;
		}
		if (!fy) { printf("  no floor under %s at all: falls out\n", P(res)); return 0; }
		if (F(*fy - res.y) < -11) { printf("  floor %s at y %.9g is more than 11 below: falls (not modelled further)\n", m.polyName(floorPoly).c_str(), *fy); return 0; }
		cur = { res.x, *fy, res.z };
		const double low = F(cur.y - GROUND_DROP);
		int behind = m.crossedWall(s, { start.x, low, start.z }, { cur.x, low, cur.z });
		printf("  on %s: %s, %s%s\n", m.polyName(floorPoly).c_str(), P(cur), m.isInBounds(s, cur) ? "in bounds" : "OUT OF BOUNDS",
			behind >= 0 ? (", behind " + m.polyName(behind) + " (from the start, at this check height)").c_str() : "");
	}
	V3 s1 = m.sphereStep({ cur.x, F(cur.y - GROUND_DROP), cur.z }, LOOSE, nullptr);
	V3 s2 = m.sphereStep(s1, LOOSE, nullptr);
	V3 end = { s2.x, cur.y, s2.z };
	printf("2 frames standing: %s, %s\n", P(end), m.isInBounds(s, end) ? "in bounds" : "OUT OF BOUNDS");
	return 0;
}

// Falling fast from the floor (checkHeight + dy < 5): the line test at the
// feet, and a ground clip (ground.h)
static int runSimGround(const Model& m, Scratch& s, const V3& start, int yaw, double speed, double vy) {
	const V3 next = { F(start.x + F(F(speed * sinS(yaw)) * SPEED_RATE)), F(start.y + F(vy * SPEED_RATE)),
		F(start.z + F(F(speed * cosS(yaw)) * SPEED_RATE)) };
	printf("start %s  yaw 0x%04X  speed %.9g  velocity.y %.9g -> posNext %s\n", P(start), yaw, speed, vy, P(next));
	printf("start in bounds: %s\n", m.isInBounds(s, start, true) ? "yes" : "NO");
	{
		auto rest = m.restingSpot(start);
		if (rest && rest->x == start.x && rest->z == start.z && inCornerPocket(m, start))
			printf("  partly inside a convex wall corner (no wall's projection lands on it): a corner pocket start\n");
	}
	int fp = -1;
	auto fy = m.floorCheck(start.x, start.z, F(start.y + 1), &fp);
	if (fy && fp >= 0) {
		const Poly& q = m.polys[fp];
		const double pa = F(F(F(F(F(q.sx * start.x) + F(q.sy * start.y)) + F(q.sz * start.z)) * NORMAL_FRAC) + q.dist);
		printf("start's floor: %s at y %.9g (start %s it); the line test's plane distance at the start: %.9g (%s)\n", m.polyName(fp).c_str(), *fy,
			*fy == start.y ? "exactly on" : *fy < start.y ? "above" : "below", pa, pa < 0 ? "< 0: the line doesn't cross it" : ">= 0: the line stops on it");
	}
	warnStartFloor(m, start);
	printf("checkHeight + dy%s = %.9g < 5: the line test runs at the feet, floors included\n", LINE_DY_SCALE == 1.0 ? "" : " x 1.5 (3DS)",
		F(m.checkHeight + F(F(next.y - start.y) * LINE_DY_SCALE)));
	const GroundLine gl = groundLine(m, s, start, next);
	if (gl.poly >= 0) printf("line test hits %s, puts him at %s\n", m.polyName(gl.poly).c_str(), P(gl.res));
	else printf("line test: nothing hit\n");
	PushList trace;
	const V3 res = m.sphereStep(gl.res, LOOSE, &trace, &start, gl.poly >= 0 && m.polys[gl.poly].bg >= 0);
	for (const Push& t : trace) printf("  %s pushes %s -> %s\n", m.polyName(t.poly).c_str(), P(t.from), P(t.to));
	printf("after the pushes: %s (wall check at y %.9g)\n", P(res), F(res.y + m.checkHeight));
	int lp = -1;
	auto ly = m.floorCheck(res.x, res.z, F(start.y + 50), &lp);
	if (!ly) printf("floor check from y %.9g: no floor at all\n", F(start.y + 50));
	else printf("floor check from y %.9g: %s at y %.9g: %s\n", F(start.y + 50), m.polyName(lp).c_str(), *ly,
		F(*ly - res.y) >= 0 ? "lands on it" : "below him, keeps falling");
	auto c = groundFrame(m, s, start, yaw, speed, vy);
	if (!c) printf("no ground clip\n");
	else printf("GROUND CLIP: through %s under %s; %s %s, %s\n", m.polyName(c->pusher).c_str(), m.polyName(c->crossed).c_str(),
		c->endNoFloor ? "no floor under" : "ends at", P(c->end), c->endNoFloor ? "falls out" : !m.isInBounds(s, c->end) ? "OUT OF BOUNDS" : "in bounds, past the dynapoly (counts)");
	return 0;
}

int runSim(const Model& m, const string& simArg, const string& game, const string& formUpper) {
	{
		// X,Y,Z,walk,X2,Y2,Z2: Model::walkUnreachable's flood fill, the path it
		// walks from the first point to the second (why an end counts as reachable)
		double x, y, z, x2, y2, z2;
		if (sscanf(simArg.c_str(), "%lf,%lf,%lf,walk,%lf,%lf,%lf", &x, &y, &z, &x2, &y2, &z2) == 6) {
			Scratch s;
			s.stamp.assign(m.polys.size(), 0);
			const vector<V3> path = m.walkPath(s, { x, y, z }, { x2, y2, z2 });
			if (path.empty()) { printf("not reachable walking (the flood fill never gets there): an end there counts\n"); return 0; }
			printf("reachable walking, %zu steps:\n", path.size());
			for (size_t i = 0; i < path.size(); i++) {
				// (only where it turns or climbs, and the ends)
				const bool turn = i == 0 || i + 1 == path.size() ||
					std::fabs((path[i].x - path[i - 1].x) - (path[i + 1].x - path[i].x)) > 1e-6 ||
					std::fabs((path[i].z - path[i - 1].z) - (path[i + 1].z - path[i].z)) > 1e-6 || std::fabs(path[i].y - path[i - 1].y) > 1;
				if (turn) printf("  %zu: (%.1f, %.1f, %.1f)\n", i, path[i].x, path[i].y, path[i].z);
				// (a wall lower down the fill steps through: it only looks 50 up)
				if (i > 0) for (double up : { 10.0, 30.0 }) {
					const double h = F(path[i - 1].y + up);
					if (auto hit = m.lineHit(s, { path[i - 1].x, h, path[i - 1].z }, { path[i].x, h, path[i].z }, LOOSE, false, false, true)) {
						printf("    step %zu goes through %s at %g up (the fill only checks 50 up)\n", i, m.polyName(hit->poly).c_str(), up);
						break;
					}
				}
			}
			return 0;
		}
	}
	{
		// X,Y,Z,FACING,@ACTION: an action's frames (action.h) from facing FACING
		char act[64] = {}, yawS[32] = {};
		double x, y, z;
		if (sscanf(simArg.c_str(), "%lf,%lf,%lf,%31[^,],@%63s", &x, &y, &z, yawS, act) == 5) {
			string err;
			vector<int> ai = parseActions(game, act, err);
			// (the one for this form: OoT adult and child share keys)
			ai.erase(std::remove_if(ai.begin(), ai.end(), [&](int i) { return !actionForForm(ACTIONS[i], formUpper); }), ai.end());
			if (ai.size() != 1) { fprintf(stderr, "--sim: %s\n", err.empty() ? "one action, e.g. @1h-slash" : err.c_str()); return 2; }
			const Action& a = ACTIONS[ai[0]];
			const int facing = (int)strtol(yawS, nullptr, 0) & 0xFFFF;
			const V3 start = { F(x), F(y), F(z) };
			printf("%s, facing 0x%04X\n", a.name.c_str(), facing);
			// (the jumpslash: in the air, then the landing slash; a -walkin: the run in first)
			if (a.jump || !a.pre.empty()) printActionFrames(m, start, facing, ai[0]);
			else {
				vector<std::function<V3(const V3&)>> moves;
				vector<bool> swing;
				bool noSpeed = false;
				for (const ActionFrame& f : a.frames) {
					moves.push_back([&a, f, facing, &noSpeed](const V3& p) { return actionStep(a, f, p, facing, noSpeed); });
					swing.push_back(f.swing);
				}
				runSimFrames(m, start, moves, swing, &noSpeed);
			}
			Scratch s;
			s.stamp.assign(m.polys.size(), 0);
			auto c = actionClip(m, s, start, facing, ai[0]);
			if (!c) printf("no clip\n");
			else printf("CLIP: %s %s through %s (%s), ends %s\n", m.polyName(c->pusher).c_str(), c->kind == 2 ? "(the floor check) lifts Link" : "pushes Link",
				m.polyName(c->crossed).c_str(), c->kind == 2 ? "slope" : c->acutePoint ? "acute point" : "needs the extended planes", P(c->end));
			if (c && c->stopAfter) printf("  (stop after frame %d: out of bounds in the wall there; the rest of the frames would carry him on)\n", c->stopAfter);
			return 0;
		}
	}
	{
		// SPEED/SPEED/...: several frames
		char speeds[256] = {}, yawS[32] = {};
		double x, y, z;
		if (sscanf(simArg.c_str(), "%lf,%lf,%lf,%31[^,],%255[^,]", &x, &y, &z, yawS, speeds) == 5 && strchr(speeds, '/')) {
			vector<std::function<V3(const V3&)>> sp;
			const int yaw = (int)strtol(yawS, nullptr, 0) & 0xFFFF;
			for (char* t = strtok(speeds, "/"); t; t = strtok(nullptr, "/")) { const double v = atof(t); sp.push_back([yaw, v](const V3& p) { return moveStep(p, yaw, F(v)); }); }
			return runSimFrames(m, { F(x), F(y), F(z) }, sp);
		}
	}
	double sx, sy, sz, speed, drop = 0;
	char yawStr[32] = {}, dropStr[32] = {};
	int n = sscanf(simArg.c_str(), "%lf,%lf,%lf,%31[^,],%lf,%31s", &sx, &sy, &sz, yawStr, &speed, dropStr);
	if (n < 5) { fprintf(stderr, "--sim wants X,Y,Z,YAW,SPEED[,DROP | ,vVY] (YAW as 0x1234 or decimal)\n"); return 2; }
	int yaw = (int)strtol(yawStr, nullptr, 0) & 0xFFFF;
	Scratch s;
	s.stamp.assign(m.polys.size(), 0);
	V3 start = { F(sx), F(sy), F(sz) };
	V3 next = moveStep(start, yaw, F(speed));
	// DROP, or vVY: velocity.y (v-20: posNext.y = y + -20 x 1.5)
	double vy = NAN;
	if (dropStr[0] == 'v' || dropStr[0] == 'V') {
		vy = F(atof(dropStr + 1));
		drop = F(start.y - F(start.y + F(vy * SPEED_RATE)));
	} else if (dropStr[0]) drop = atof(dropStr);
	if (drop > 0) next.y = F(start.y - drop);
	// falling fast from the floor: the line test at the feet (ground clips)
	if (drop > 0 && feetLine(m.checkHeight, F(next.y - start.y)))
		return runSimGround(m, s, start, yaw, F(speed), std::isnan(vy) ? F(-drop / SPEED_RATE) : vy);
	printf("start %s  yaw 0x%04X  speed %.9g -> posNext %s\n", P(start), yaw, F(speed), P(next));
	printf("start in bounds: %s\n", m.isInBounds(s, start, true) ? "yes" : "NO");
	warnStartFloor(m, start);
	auto rest = m.restingSpot(start);
	printf("start is a resting spot: %s\n", rest && rest->x == start.x && rest->z == start.z ? "yes" : rest ? (string("no, rests at ") + P(*rest)).c_str() : "no (pushes don't settle)");
	if (rest && rest->x == start.x && rest->z == start.z && inCornerPocket(m, start))
		printf("  partly inside a convex wall corner (no wall's projection lands on it): a corner pocket start\n");
	{
		int fp = -1;
		auto fy = m.floorCheck(start.x, start.z, F(start.y + 1), &fp);
		if (fy && fp >= 0) printf("start's floor: %s at y %.9g, exit %d, floor property %d%s\n", m.polyName(fp).c_str(), *fy,
			m.polys[fp].exitIndex, m.polys[fp].floorProp, m.polys[fp].loadOrVoid ? " (a loading zone / void plane: the scan leaves out clips starting here)" : "");
		if (fy && fp >= 0 && m.polys[fp].slide) printf("  a slide floor (floor effect 1): Link slides off it, or is pushed down it - not a start the scan uses\n");
	}
	if (feetLine(m.checkHeight, F(next.y - start.y))) printf("checkHeight + dy < 5: the game's line test runs at the feet, floors included (not modelled)\n");
	V3 res;
	PushList trace;
	auto f = lineFrame(m, s, start, next, LOOSE);
	if (f) {
		printf("line test at y %.9g hits TRI %d at (%.9g, %.9g), snapped to %s\n", F(next.y + m.checkHeight), f->hit.poly, f->hit.x, f->hit.z, P(f->trace[0].to));
		res = f->res;
		trace = f->trace;
	} else {
		printf("line test at y %.9g: nothing hit\n", F(next.y + m.checkHeight));
		res = m.sphereStep(next, LOOSE, &trace, &start);
	}
	for (const Push& t : trace) {
		if (!t.line) printf("  %s pushes %s -> %s\n", m.polyName(t.poly).c_str(), P(t.from), P(t.to));
		else if (&t != &trace[0]) printf("  a dynapoly collision: the one-face line check stops him on %s at %s\n", m.polyName(t.poly).c_str(), P(t.to));
	}
	printf("after the pushes: %s\n", P(res));
	const Move mv{ yaw, F(speed) };
	auto clip = clipFromFrame(m, s, start, res, trace, LOOSE, drop > 0 ? NAN : start.y, &mv);
	// walking: the floor check lifting him behind a wall (slope.h)
	auto slope = !clip && drop <= 0 ? slopeFrame(m, s, start, yaw, F(speed)) : std::nullopt;
	if (slope) {
		const Clip& c = *slope;
		printf("SLOPE CLIP: the floor check puts Link on %s at %s, behind %s (the frame's wall check at y %.9g was under its bottom)\n",
			m.polyName(c.pusher).c_str(), P(c.res), m.polyName(c.crossed).c_str(), F(next.y + m.checkHeight));
		if (c.speed2 > 0) printf("  standing still, %s pushes him back out: one more frame at speed %g (the same yaw) takes him further behind\n",
			m.polyName(c.crossed).c_str(), c.speed2);
		printf("  %s %s, %s\n", c.endNoFloor ? "no floor under" : "ends at", P(c.end),
			c.endNoFloor ? "falls out" : !m.isInBounds(s, c.end) ? "OUT OF BOUNDS" : "in bounds, past the dynapoly (counts)");
		printf("  (--sim X,Y,Z,YAW,SPEED/SPEED2 runs the frames one by one)\n");
	} else if (!clip) {
		int crossed = m.crossedWall(s, { start.x, res.y, start.z }, res);
		printf("no clip (%s)\n", crossed < 0 ? "not through any wall between start and there"
			: ("through TRI " + std::to_string(crossed) + ", but the next frames' pushes put him back / not held").c_str());
	} else {
		printf("CLIP: TRI %d pushes Link through TRI %d%s; after 2 more frames %s, %s\n", clip->pusher, clip->crossed,
			clip->hold ? " (keeping the stick held one more frame)" : "", P(clip->end),
			!m.isInBounds(s, clip->end) ? "OUT OF BOUNDS" : m.polys[clip->crossed].bg >= 0 ? "in bounds, past the dynapoly (counts)" : "in bounds (doesn't count)");
		for (int id : { clip->pusher, clip->crossed }) {
			const Poly& q = m.polys[id];
			printf("  TRI %d: (%g, %g, %g) (%g, %g, %g) (%g, %g, %g)  normal (%.4f, %.4f, %.4f)\n", id,
				q.ax, q.ay, q.az, q.bx, q.by, q.bz, q.cx, q.cy, q.cz, q.nx / q.nMag, q.ny / q.nMag, q.nz / q.nMag);
		}
		// (the line test first, as the scan's crossingClip does: a sloped
		// floor pusher only snaps him through it)
		PushList st;
		V3 sres;
		auto sf = lineFrame(m, s, start, next, STRICT);
		if (sf) {
			printf("  without the extended planes: the line test hits TRI %d, snapped to %s\n", sf->hit.poly, P(sf->trace[0].to));
			sres = sf->res;
			st = sf->trace;
		} else sres = m.sphereStep(next, STRICT, &st, &start);
		for (const Push& t : st) if (!t.line) printf("  without the extended planes: TRI %d pushes %s -> %s\n", t.poly, P(t.from), P(t.to));
		auto sclip = clipFromFrame(m, s, start, sres, st, STRICT, drop > 0 ? NAN : start.y, &mv);
		printf("without the extended planes: %s\n", !sclip ? "no clip (extended)"
			: sclip->onFace ? "still clips, pushed from in front of the pusher's face (acute)"
			: "still clips, but pushed from beside the pusher, past its edge (extended)");
		if (drop > 0) {
			bool noFloor;
			auto land = landing(m, s, res, start.y, noFloor, clip->crossed, &start);
			int lp = -1;
			auto ly = m.floorCheck(res.x, res.z, F(start.y + 50), &lp);
			if (!land && ly) printf("falling: lands on %s at y %.9g\n", m.polyName(lp).c_str(), *ly);
			printf("falling: %s\n", !land ? "lands in bounds" : noFloor ? "no floor under him: falls out"
				: (string(!m.isInBounds(s, *land) ? "lands out of bounds at " : m.polys[clip->crossed].bg >= 0 ? "lands in bounds past the dynapoly (counts) at "
				: "lands in bounds, somewhere he couldn't walk to from the start (counts) at ") + P(*land)).c_str());
		}
	}
	return 0;
}

int printTris(const Model& m, const string& ids) {
	for (size_t a = 0; a < ids.size();) {
		size_t b = ids.find(',', a);
		if (b == string::npos) b = ids.size();
		const int id = atoi(ids.substr(a, b - a).c_str());
		a = b + 1;
		if (id < 0 || id >= (int)m.polys.size() || !m.polys[id].exists) { printf("%s: no such poly\n", m.polyName(id).c_str()); continue; }
		const Poly& q = m.polys[id];
		printf("%s: %s  (%g, %g, %g) (%g, %g, %g) (%g, %g, %g)  normal (%.4f, %.4f, %.4f)  dist %g  exit %d  floor property %d%s%s\n", m.polyName(id).c_str(),
			q.isWall ? "wall" : q.isFloor ? "floor" : "ceiling", q.ax, q.ay, q.az, q.bx, q.by, q.bz, q.cx, q.cy, q.cz,
			q.nx / q.nMag, q.ny / q.nMag, q.nz / q.nMag, q.dist, q.exitIndex, q.floorProp, q.loadOrVoid ? "  (loading zone / void)" : "",
			q.slide ? "  (slide floor)" : "");
	}
	return 0;
}
