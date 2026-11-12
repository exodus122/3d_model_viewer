#include "aerial.h"
#include "ground.h"

vector<double> AERIAL_VY_LIST;

// Check heights up a pair: every LEVEL_STEP, at most MAX_LEVELS (spread out
// further on tall walls)
static const double LEVEL_STEP = 5;
static const int MAX_LEVELS = 20;
// posNext in the corner: a grid every GRID_STEP, coarsened to at most
// GRID_MAX points a height
static const double GRID_STEP = 0.5;
static const double GRID_MAX = 10000;
// crossing points along the pusher's face
static const double CROSS_STEP = 0.25;
// how far back starts are tried (up to the most a frame moves)
static const double RING[] = { 2, 4, 6, 8, 12, 16, 20, 24 };
// rising or falling: also from right under / over the point, and 1 off it
static const double NEAR_RING[] = { 0, 1 };

static double airMaxMove() { return F(AERIAL_MAX_SPEED * SPEED_RATE); }

vector<double> aerialVys(const Model& m) {
	// NAN: the fastest fall whose line test is still at check height
	vector<double> want = AERIAL_VY_LIST.empty() ? vector<double>{ 6, 3, 0, -5, -10, NAN, -20 } : AERIAL_VY_LIST;
	double pushMin = F(std::ceil((5 - m.checkHeight) / SPEED_RATE * 100) / 100);
	while (feetLine(m.checkHeight, F(pushMin * SPEED_RATE))) pushMin = F(pushMin + 0.01);
	vector<double> out;
	for (double v : want) {
		const double vy = std::isnan(v) ? pushMin : F(v);
		if (std::find(out.begin(), out.end(), vy) == out.end()) out.push_back(vy);
	}
	std::sort(out.begin(), out.end(), std::greater<double>());
	return out;
}

std::optional<V3> floorUnder(const Model& m, const V3& p) {
	auto fy = m.floorCheck(p.x, p.z, p.y);
	if (!fy) return std::nullopt;
	return V3{ p.x, *fy, p.z };
}

std::optional<V3> airStart(const Model& m, Scratch& s, const V3& p) {
	V3 cur = p;
	bool settled = false;
	for (int i = 0; i < 4 && !settled; i++) {
		const V3 nx = m.sphereStep(cur, LOOSE, nullptr);
		if (nx.x == cur.x && nx.z == cur.z) settled = true;
		else cur = { nx.x, p.y, nx.z };
	}
	if (!settled) return std::nullopt;
	auto fy = m.floorCheck(cur.x, cur.z, F(cur.y + 50));
	if (fy && *fy >= cur.y) return std::nullopt;
	if (!m.isInBounds(s, cur, true)) return std::nullopt;
	// over somewhere he could have jumped or fallen from: a floor under him,
	// in bounds too. (High over the top of a cliff's wall the rays meet
	// nothing, so the start alone looks in bounds: OoT Kakariko Village, 183
	// over the wall TRI 47. With no floor at all he's outside the map, under
	// a fence's bottom edge with nothing below: Kakariko TRI 579 / 577 - a
	// real pit has a void plane.)
	auto u = floorUnder(m, cur);
	if (!u || !m.isInBounds(s, *u, true)) return std::nullopt;
	return cur;
}

namespace {
struct AirRun { V3 res; PushList trace; bool line = false; Hit hit{}; };
}

// The frame's line test and pushes, from prev to next: at check height, or
// falling fast (feet) the line at his feet, floors included (ground.h)
static void airRun(const Model& m, Scratch& s, const V3& prev, const V3& next, const Tol& tol, bool feet, AirRun& r) {
	r.trace.clear();
	r.line = false;
	if (feet) {
		const GroundLine gl = groundLine(m, s, prev, next);
		if (gl.poly >= 0) r.trace.push_back({ gl.poly, next, gl.res, true });
		r.res = m.sphereStep(gl.res, tol, &r.trace, &prev, gl.poly >= 0 && m.polys[gl.poly].bg >= 0);
	} else if (auto lf = lineFrame(m, s, prev, next, tol)) {
		r.res = lf->res; r.trace = lf->trace; r.line = true; r.hit = lf->hit;
	} else {
		r.res = m.sphereStep(next, tol, &r.trace, &prev);
	}
}

// The frame's floor check (from prevPos.y + 50) puts him on a floor at or
// above his feet, at any y velocity (func_8002E2AC sets pos.y = floorHeight)
static bool lands(const Model& m, const V3& prev, const V3& res) {
	auto fy = m.floorCheck(res.x, res.z, F(prev.y + 50));
	return fy && F(*fy - res.y) >= 0;
}

std::optional<Clip> aerialFrame(const Model& m, Scratch& s, const V3& prev, int yaw, double speed, double vy, int lineWall) {
	V3 next = moveStep(prev, yaw, speed);
	next.y = F(prev.y + F(vy * SPEED_RATE));
	const bool feet = feetLine(m.checkHeight, F(next.y - prev.y));
	// (a crossing's snap is the check height line test's)
	if (feet && lineWall >= 0) return std::nullopt;
	AirRun r;
	airRun(m, s, prev, next, LOOSE, feet, r);
	if (lineWall >= 0 ? !r.line || r.hit.poly != lineWall : lineWall == -1 && r.line) return std::nullopt;
	const bool landed = lands(m, prev, r.res);
	// (landed: clipFromFrame's floor check finds the same floor, and stands him on it)
	auto clip = clipFromFrame(m, s, prev, r.res, r.trace, LOOSE, landed ? prev.y : NAN);
	if (!clip) return std::nullopt;
	const int pusher = r.line ? r.hit.poly : clip->pusher;
	if (pusher == clip->crossed) return std::nullopt;
	if (m.dynaPairsOnly && m.polys[pusher].bg < 0 && m.polys[clip->crossed].bg < 0) return std::nullopt;
	// acute: it clips without the extended planes too, pushed from in front of the pusher's face
	AirRun st;
	airRun(m, s, prev, next, STRICT, feet, st);
	auto sclip = clipFromFrame(m, s, prev, st.res, st.trace, STRICT, lands(m, prev, st.res) ? prev.y : NAN);
	if (!sclip || !sclip->onFace) return std::nullopt;
	// Landed: where the floor check put him (after standing still), out of
	// bounds. Else he falls: where he lands, or no floor at all. Landing in
	// bounds counts if he couldn't walk there from the floor under his start
	// (Model::endCounts).
	auto under = floorUnder(m, prev);
	const V3* from = under ? &*under : nullptr;
	bool noFloor = false;
	V3 end;
	if (landed) {
		if (!m.endCounts(s, clip->crossed, clip->end, from)) return std::nullopt;
		end = clip->end;
	} else {
		auto e = landing(m, s, r.res, prev.y, noFloor, clip->crossed, from);
		if (!e) return std::nullopt;
		end = *e;
	}
	Clip c;
	c.kind = 4;
	c.acutePoint = true;
	c.cross = r.line;
	c.airLanded = landed;
	c.pusher = pusher; c.crossed = clip->crossed;
	c.from = r.line ? V3{ r.hit.x, next.y, r.hit.z } : next;
	c.prev = prev; c.next = next; c.hasNext = true; c.res = r.res; c.end = end; c.endNoFloor = noFloor;
	c.yaw = yaw; c.speed = speed; c.hasMove = true; c.vy = vy;
	c.yaws = { yaw };
	// (the floor under the start: how high in the air he is)
	if (under) { c.floorY = under->y; c.hasFloorY = true; }
	// the move itself is the reach (from the air: --min-speed leaves it)
	c.reachDone = c.hasReach = true;
	c.reachSpeed = speed;
	c.reachYaw = yaw;
	c.reachStart = prev;
	return c;
}

// posNext where A's push can take Link behind B (search.cpp
// nextPositionsForPair's reachable): within the radius of A or just behind
// it, in front of B, pushed out of A he'd be behind B's plane, and near both
// triangles, not just their planes
static bool inWedge(const Poly& A, const Poly& B, double cosAB, double R, double x, double h, double z) {
	double dA = planeDist(A, x, h, z);
	if (dA > R || dA < -(4 / A.nXZ) - 1) return false;
	double dB = planeDist(B, x, h, z);
	if (dB < 0 || dB > R + 4) return false;
	if (dB + (R - dA) * cosAB > 0) return false;
	const double slack = R;
	double kA = dA / A.nMag;
	if (!pointInTri3D(A, x - kA * A.nx, h - kA * A.ny, z - kA * A.nz, slack)) return false;
	double disp = (R - dA) * A.invNXZ;
	double qx = x + disp * A.nx, qz = z + disp * A.nz;
	double dBq = planeDist(B, qx, h, qz);
	if (dBq >= 0) return true;
	double t = dB / (dB - dBq);
	return pointInTri3D(B, x + (qx - x) * t, h, z + (qz - z) * t, slack);
}

// posNext p in the corner: per y velocity, a start in the air up to a
// frame's move away (rising or falling, from right under / over p too)
static void cornerAir(const Model& m, Scratch& s, const V3& p, const vector<double>& vys, const std::function<void(const Clip&)>& give) {
	{
		// p itself: the pushes there take him through a wall, without the extended planes too
		PushList tr;
		V3 res = m.sphereStep(p, STRICT, &tr);
		if (tr.empty() || m.crossedWall(s, p, res) < 0) return;
	}
	const double maxMove = airMaxMove();
	for (double vy : vys) {
		const double prevY = F(p.y - F(vy * SPEED_RATE));
		vector<double> dists;
		if (prevY != p.y) dists.assign(std::begin(NEAR_RING), std::end(NEAR_RING));
		dists.insert(dists.end(), std::begin(RING), std::end(RING));
		dists.push_back(maxMove);
		std::optional<Clip> found;
		for (double dist : dists) {
			if (dist > maxMove) continue;
			for (int i = 0; i < (dist == 0 ? 1 : 16) && !found; i++) {
				const double ang = i / 16.0 * 2 * PI;
				auto prev = airStart(m, s, { F(p.x - dist * std::sin(ang)), prevY, F(p.z - dist * std::cos(ang)) });
				if (!prev) continue;
				double vx = p.x - prev->x, vz = p.z - prev->z, len = std::hypot(vx, vz);
				if (len > maxMove) continue;
				// (straight up or down: no move across)
				found = len < 0.01 ? aerialFrame(m, s, *prev, 0, 0, vy, -1)
					: aerialFrame(m, s, *prev, yawOf(vx, vz), F(len / SPEED_RATE), vy, -1);
			}
			if (found) break;
		}
		if (found) give(*found);
	}
}

// A move through A's face at cp (on its plane, posNext's height): per y
// velocity (not falling fast: no line test at check height then), a start in
// the air, the move 1 unit past the plane
static void crossingAir(const Model& m, Scratch& s, const Poly& A, const V3& cp, const vector<double>& vys,
	const std::function<void(const Clip&)>& give) {
	const double maxMove = airMaxMove();
	for (double vy : vys) {
		if (feetLine(m.checkHeight, F(vy * SPEED_RATE))) continue;
		const double prevY = F(cp.y - F(vy * SPEED_RATE));
		std::optional<Clip> found;
		for (int i = 0; i < 32 && !found; i++) {
			const int yaw0 = i * 0x800;
			const double dx0 = std::sin(yaw0 / 65536.0 * 2 * PI), dz0 = std::cos(yaw0 / 65536.0 * 2 * PI);
			// into A's face, not along it
			if ((dx0 * A.nx + dz0 * A.nz) * A.invNXZ > -0.1) continue;
			for (double dist : RING) {
				if (dist + 1 > maxMove) break;
				auto prev = airStart(m, s, { F(cp.x - dist * dx0), prevY, F(cp.z - dist * dz0) });
				if (!prev) continue;
				double vx = cp.x - prev->x, vz = cp.z - prev->z, len = std::hypot(vx, vz);
				if (len < 0.5 || len + 1 > maxMove) continue;
				if ((found = aerialFrame(m, s, *prev, yawOf(vx, vz), F((len + 1) / SPEED_RATE), vy, A.id))) break;
			}
		}
		if (found) give(*found);
	}
}

void aerialClipsForPusher(const Model& m, Scratch& s, const Poly& A, const vector<const Pair*>& pairs,
	const std::function<bool(int, int)>& pairDone, const std::function<void(const Clip&)>& yield) {
	const double R = m.radius, ch = m.checkHeight;
	const vector<double> vys = aerialVys(m);
	const double k = F(R * F(1 / A.nXZ));
	const double nx = A.nx * A.invNXZ, nz = A.nz * A.invNXZ, tx = -nz, tz = nx;
	const double au[3] = { A.ax * tx + A.az * tz, A.bx * tx + A.bz * tz, A.cx * tx + A.cz * tz };
	auto onPlane = [&](double u, double h) {
		double c = -(A.dist + A.ny * h) / (A.nXZ * A.nXZ);
		return std::pair<double, double>(c * A.nx + u * tx, c * A.nz + u * tz);
	};
	std::set<std::array<double, 3>> seen;           // corner posNexts tried (by any of A's pairs)
	std::set<std::pair<double, double>> crossSeen;  // crossing points tried (u, check height)
	std::set<std::array<double, 6>> frames;         // one clip per (start, posNext)
	auto give = [&](const Clip& c) {
		if (!frames.insert({ c.prev.x, c.prev.y, c.prev.z, c.next.x, c.next.y, c.next.z }).second) return;
		if (!pairDone(c.pusher, c.crossed)) yield(c);
	};
	for (const Pair* pr : pairs) {
		const Poly& B = m.polys[pr->B];
		// (the pair's lo / hi are both walls' heights, plus 1 each way)
		double lo = pr->lo + 0.5, hi = pr->hi - 0.5;
		if (hi < lo) lo = hi = (pr->lo + pr->hi) / 2;
		int n = (int)std::floor((hi - lo) / LEVEL_STEP) + 1;
		double step = LEVEL_STEP;
		if (n > MAX_LEVELS) { n = MAX_LEVELS; step = (hi - lo) / (n - 1); }
		const double sinAB = std::fabs(A.nx * B.nz - A.nz * B.nx) / (A.nXZ * B.nXZ);
		const double bu[3] = { B.ax * tx + B.az * tz, B.bx * tx + B.bz * tz, B.cx * tx + B.cz * tz };
		for (int li = 0; li < n; li++) {
			if (pairDone(A.id, B.id)) break;
			const double h = F(lo + li * step);  // check height
			const double y = F(h - ch);          // posNext.y
			// 1. posNext in the corner, A's push takes him behind B (not a floor:
			// floors don't push, only the line test's snap off one does)
			double box[4];
			if (!A.isFloor && cornerBox(A, B, R, h, h, box)) {
				double x0 = std::max({ pr->x0, std::min(A.minX, B.minX) - R, box[0] });
				double x1 = std::min({ pr->x1, std::max(A.maxX, B.maxX) + R, box[1] });
				double z0 = std::max({ pr->z0, std::min(A.minZ, B.minZ) - R, box[2] });
				double z1 = std::min({ pr->z1, std::max(A.maxZ, B.maxZ) + R, box[3] });
				double st = GRID_STEP;
				while (((x1 - x0) / st) * ((z1 - z0) / st) > GRID_MAX) st *= 1.25;
				for (double x = std::ceil(x0 / st) * st; x1 >= x0 && x <= x1; x += st) {
					for (double z = std::ceil(z0 / st) * st; z <= z1; z += st) {
						if (!inWedge(A, B, pr->cosAB, R, x, h, z)) continue;
						const V3 p = { F(x), y, F(z) };
						if (!seen.insert({ p.x, p.y, p.z }).second) continue;
						cornerAir(m, s, p, vys, give);
					}
				}
			}
			// 2. through A's face near where its plane meets B's: the line test
			// snaps him the radius out of A, and the pushes from there. A sloped
			// floor too, where it's at the line's height: moving more than the
			// radius the line test takes floors, and snaps him radius / nXZ out
			// along the floor's slope (downhill, through a wall at its foot:
			// OoT Bottom of the Well TRI 863 through TRI 876)
			double xm, zm;
			if (sinAB > 0.05 && planesMeet(A, B, h, 0, 0, xm, zm)) {
				const double w = (5 * R + 25) / sinAB, um = xm * tx + zm * tz, pad = R + 30;
				double u0 = std::max({ um - w, std::min({ au[0], au[1], au[2] }) - 2, std::min({ bu[0], bu[1], bu[2] }) - pad });
				double u1 = std::min({ um + w, std::max({ au[0], au[1], au[2] }) + 2, std::max({ bu[0], bu[1], bu[2] }) + pad });
				for (double u = std::ceil(u0 / CROSS_STEP) * CROSS_STEP; u <= u1; u += CROSS_STEP) {
					auto q = onPlane(u, h);
					const V3 cp = { F(q.first), y, F(q.second) };
					// (cheap first: snapped out of A and pushed, he's behind B)
					const V3 snapped = { F(F(k * A.nx) + cp.x), y, F(F(k * A.nz) + cp.z) };
					const V3 res = m.sphereStep(snapped, LOOSE, nullptr);
					const double d = planeDist(B, res.x, h, res.z);
					if (d >= 0 || d < -4 * R) continue;
					const double t = d / B.nMag;
					if (!pointInTri3D(B, res.x - t * B.nx, h - t * B.ny, res.z - t * B.nz, 1)) continue;
					if (!crossSeen.insert({ u, h }).second) continue;
					crossingAir(m, s, A, cp, vys, give);
				}
			}
		}
	}
}
