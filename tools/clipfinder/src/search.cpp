#include "search.h"
#include "ground.h"
#include "slope.h"
#include "corners.h"

////////////////////////////////////////
// Search
////////////////////////////////////////

static const double NEXT_STEP = 0.5;
static const double CROSS_STEP = 0.25;
static const double FLOOR_BLOCK = 4;

static const double REACH = 14;




struct Pair { int A, B; double cosAB, lo, hi, x0, x1, z0, z1; };

// Triangle-triangle distance: 0 if an edge of one passes through the other,
// else the smallest vertex-triangle / edge-edge distance.
using D3 = std::array<double, 3>;
static D3 sub3(const D3& a, const D3& b) { return { a[0] - b[0], a[1] - b[1], a[2] - b[2] }; }
static double dot3(const D3& a, const D3& b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
static D3 cross3(const D3& a, const D3& b) { return { a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0] }; }

static D3 closestOnTri(const D3& p, const D3& a, const D3& b, const D3& c) {
	D3 ab = sub3(b, a), ac = sub3(c, a), ap = sub3(p, a);
	double d1 = dot3(ab, ap), d2 = dot3(ac, ap);
	if (d1 <= 0 && d2 <= 0) return a;
	D3 bp = sub3(p, b);
	double d3 = dot3(ab, bp), d4 = dot3(ac, bp);
	if (d3 >= 0 && d4 <= d3) return b;
	double vc = d1 * d4 - d3 * d2;
	if (vc <= 0 && d1 >= 0 && d3 <= 0) { double v = d1 / (d1 - d3); return { a[0] + v * ab[0], a[1] + v * ab[1], a[2] + v * ab[2] }; }
	D3 cp = sub3(p, c);
	double d5 = dot3(ab, cp), d6 = dot3(ac, cp);
	if (d6 >= 0 && d5 <= d6) return c;
	double vb = d5 * d2 - d1 * d6;
	if (vb <= 0 && d2 >= 0 && d6 <= 0) { double w = d2 / (d2 - d6); return { a[0] + w * ac[0], a[1] + w * ac[1], a[2] + w * ac[2] }; }
	double va = d3 * d6 - d5 * d4;
	if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
		double w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
		return { b[0] + w * (c[0] - b[0]), b[1] + w * (c[1] - b[1]), b[2] + w * (c[2] - b[2]) };
	}
	double denom = 1 / (va + vb + vc), v = vb * denom, w = vc * denom;
	return { a[0] + ab[0] * v + ac[0] * w, a[1] + ab[1] * v + ac[1] * w, a[2] + ab[2] * v + ac[2] * w };
}

static double segSegDistSq(const D3& p1, const D3& q1, const D3& p2, const D3& q2) {
	D3 d1 = sub3(q1, p1), d2 = sub3(q2, p2), r = sub3(p1, p2);
	double a = dot3(d1, d1), e = dot3(d2, d2), f = dot3(d2, r), s, t;
	auto clamp01 = [](double v) { return std::min(std::max(v, 0.0), 1.0); };
	if (a <= 1e-12 && e <= 1e-12) return dot3(r, r);
	if (a <= 1e-12) { s = 0; t = clamp01(f / e); }
	else {
		double c = dot3(d1, r);
		if (e <= 1e-12) { t = 0; s = clamp01(-c / a); }
		else {
			double b = dot3(d1, d2), denom = a * e - b * b;
			s = denom != 0 ? clamp01((b * f - c * e) / denom) : 0;
			t = (b * s + f) / e;
			if (t < 0) { t = 0; s = clamp01(-c / a); }
			else if (t > 1) { t = 1; s = clamp01((b - c) / a); }
		}
	}
	D3 c1 = { p1[0] + d1[0] * s, p1[1] + d1[1] * s, p1[2] + d1[2] * s };
	D3 c2 = { p2[0] + d2[0] * t, p2[1] + d2[1] * t, p2[2] + d2[2] * t };
	D3 d = sub3(c1, c2);
	return dot3(d, d);
}

static bool segHitsTri(const D3& p, const D3& q, const D3& a, const D3& b, const D3& c) {
	D3 n = cross3(sub3(b, a), sub3(c, a));
	double dp = dot3(n, sub3(p, a)), dq = dot3(n, sub3(q, a));
	if ((dp > 0 && dq > 0) || (dp < 0 && dq < 0) || dp == dq) return false;
	double t = dp / (dp - dq);
	D3 x = { p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t, p[2] + (q[2] - p[2]) * t };
	double s1 = dot3(n, cross3(sub3(b, a), sub3(x, a)));
	double s2 = dot3(n, cross3(sub3(c, b), sub3(x, b)));
	double s3 = dot3(n, cross3(sub3(a, c), sub3(x, c)));
	return (s1 >= 0 && s2 >= 0 && s3 >= 0) || (s1 <= 0 && s2 <= 0 && s3 <= 0);
}

static double triTriDist(const Poly& A, const Poly& B) {
	D3 ta[3] = { { A.ax, A.ay, A.az }, { A.bx, A.by, A.bz }, { A.cx, A.cy, A.cz } };
	D3 tb[3] = { { B.ax, B.ay, B.az }, { B.bx, B.by, B.bz }, { B.cx, B.cy, B.cz } };
	for (int i = 0; i < 3; i++) {
		if (segHitsTri(ta[i], ta[(i + 1) % 3], tb[0], tb[1], tb[2])) return 0;
		if (segHitsTri(tb[i], tb[(i + 1) % 3], ta[0], ta[1], ta[2])) return 0;
	}
	double best = INFINITY;
	for (int k = 0; k < 3; k++) {
		D3 d = sub3(ta[k], closestOnTri(ta[k], tb[0], tb[1], tb[2]));
		best = std::min(best, dot3(d, d));
		d = sub3(tb[k], closestOnTri(tb[k], ta[0], ta[1], ta[2]));
		best = std::min(best, dot3(d, d));
	}
	for (int i = 0; i < 3; i++)
		for (int j = 0; j < 3; j++)
			best = std::min(best, segSegDistSq(ta[i], ta[(i + 1) % 3], tb[j], tb[(j + 1) % 3]));
	return std::sqrt(best);
}

static vector<Pair> wallPairCandidates(const Model& m) {
	vector<Pair> pairs;
	std::unordered_set<int64_t> seen;
	const double R = m.radius, E = R + REACH;
	const double reach = 2 * m.radius + 42;
	// (pairWalls: the subdivisions' walls, dynapoly walls included.) The
	// pusher can also be a sloped floor: moving more than the radius, the
	// frame's line test includes floors and snaps Link the radius out along a
	// floor's slope too (BgCheck_CheckWallImpl), which can put him behind the
	// wall the slope runs up to (OoT Bottom of the Well TRI 863 -> 876).
	// Those pairs are crossings only: floors don't push in the wall check.
	for (size_t ci = 0; ci < m.pairWalls.size(); ci++) {
		const auto& sub = m.pairWalls[ci];
		if (sub.empty()) continue;
		vector<int> walls, pushers;
		for (int id : sub) { const Poly& p = m.polys[id]; if (p.exists && p.isWall && p.nXZ > 0) walls.push_back(id); }
		pushers = walls;
		for (int id : m.colCtx.subFloors[ci]) {
			const Poly& p = m.polys[id];
			if (p.exists && p.isFloor && !isZero(p.nXZ)) pushers.push_back(id);
		}
		if (walls.empty() || pushers.size() < 2) continue;
		for (size_t i = 0; i < pushers.size(); i++) {
			for (size_t j = 0; j < walls.size(); j++) {
				if (pushers[i] == walls[j]) continue;
				const Poly& A = m.polys[pushers[i]];
				const Poly& B = m.polys[walls[j]];
				int64_t key = (int64_t)A.id << 32 | (uint32_t)B.id;
				if (m.dynaPairsOnly && A.bg < 0 && B.bg < 0) continue;
				if (seen.count(key)) continue;
				double cosAB = (A.nx * B.nx + A.nz * B.nz) * A.invNXZ * B.invNXZ;
				if (cosAB > -0.02) continue;
				double lo = std::max(A.minY, B.minY) - 1, hi = std::min(A.maxY, B.maxY) + 1;
				if (hi < lo) continue;
				double x0 = std::max(A.minX, B.minX) - E, x1 = std::min(A.maxX, B.maxX) + E;
				double z0 = std::max(A.minZ, B.minZ) - E, z1 = std::min(A.maxZ, B.maxZ) + E;
				if (x1 < x0 || z1 < z0) continue;
				seen.insert(key);
				if (triTriDist(A, B) > reach) continue;
				pairs.push_back({ A.id, B.id, cosAB, lo, hi, x0, x1, z0, z1 });
			}
		}
	}
	return pairs;
}

struct NextPos { V3 p; double lo, hi; };

// Where walls A and B's planes meet (top down) at check height h, offset to
// signed distances a from A and b from B. False for walls under ~3 degrees apart.
static bool planesMeet(const Poly& A, const Poly& B, double h, double a, double b, double& x, double& z) {
	double det = A.nx * B.nz - A.nz * B.nx;
	if (std::fabs(det) < 0.05 * A.nXZ * B.nXZ) return false;
	double ra = a * A.nMag - A.ny * h - A.dist, rb = b * B.nMag - B.ny * h - B.dist;
	x = (ra * B.nz - A.nz * rb) / det;
	z = (A.nx * rb - ra * B.nx) / det;
	return true;
}

// cornerBox: the bounding box of the parallelogram (within
// radius in front of A or 4 behind it, at most radius + 4 in front of B)
// around where the planes meet, over check heights [lo, hi], plus a unit.
static bool cornerBox(const Poly& A, const Poly& B, double R, double lo, double hi, double box[4]) {
	double x0 = INFINITY, x1 = -INFINITY, z0 = INFINITY, z1 = -INFINITY;
	for (double h : { lo, hi })
		for (double a : { -(4 / A.nXZ) - 1, R })
			for (double b : { 0.0, R + 4 }) {
				double x, z;
				if (!planesMeet(A, B, h, a, b, x, z)) return false;
				x0 = std::min(x0, x); x1 = std::max(x1, x);
				z0 = std::min(z0, z); z1 = std::max(z1, z);
			}
	box[0] = x0 - 1; box[1] = x1 + 1; box[2] = z0 - 1; box[3] = z1 + 1;
	return true;
}

// step0: the grid step; capGrid: coarsen it until the pair's box is at most
// 40000 points (off for --wall-step's pass)
static void nextPositionsForPair(const Model& m, Scratch& s, const Pair& pair, const std::function<void(const NextPos&)>& yield,
	double step0 = NEXT_STEP, bool capGrid = true) {
	const Poly& A = m.polys[pair.A];
	const Poly& B = m.polys[pair.B];
	const double R = m.radius, ch = m.checkHeight, lo = pair.lo, hi = pair.hi, cosAB = pair.cosAB;
	double x0 = std::max(pair.x0, std::min(A.minX, B.minX) - R), x1 = std::min(pair.x1, std::max(A.maxX, B.maxX) + R);
	double z0 = std::max(pair.z0, std::min(A.minZ, B.minZ) - R), z1 = std::min(pair.z1, std::max(A.maxZ, B.maxZ) + R);
	double cb[4];
	if (cornerBox(A, B, R, lo, hi, cb)) {
		x0 = std::max(x0, cb[0]); x1 = std::min(x1, cb[1]);
		z0 = std::max(z0, cb[2]); z1 = std::min(z1, cb[3]);
		if (x1 < x0 || z1 < z0) return;
	}
	double step = step0;
	while (capGrid && ((x1 - x0) / step) * ((z1 - z0) / step) > 40000) step *= 1.25;
	double x = 0, z = 0;
	auto reachable = [&](double h) {
		double dA = planeDist(A, x, h, z);
		if (dA > R || dA < -(4 / A.nXZ) - 1) return false;
		double dB = planeDist(B, x, h, z);
		if (dB < 0 || dB > R + 4) return false;
		// (anywhere behind B: a shallow push can still hold with the stick held, ClipResult::hold)
		if (dB + (R - dA) * cosAB > 0) return false;
		// near the triangles themselves, not just their planes (slack: the
		// extended plane and pushes from walls before A in the list)
		const double slack = R;
		double kA = dA / A.nMag;
		if (!pointInTri3D(A, x - kA * A.nx, h - kA * A.ny, z - kA * A.nz, slack)) return false;
		double disp = (R - dA) * A.invNXZ;
		double qx = x + disp * A.nx, qz = z + disp * A.nz;
		double dBq = planeDist(B, qx, h, qz);
		if (dBq >= 0) return true;
		double t = dB / (dB - dBq);
		return pointInTri3D(B, x + (qx - x) * t, h, z + (qz - z) * t, slack);
	};
	double aX = A.nx * A.invNXZ, aZ = A.nz * A.invNXZ, bX = B.nx * B.invNXZ, bZ = B.nz * B.invNXZ;
	double mLen = std::hypot(aX + bX, aZ + bZ);
	if (mLen == 0) mLen = 1;
	const double outDirs[3][2] = { { aX, aZ }, { bX, bZ }, { (aX + bX) / mLen, (aZ + bZ) / mLen } };
	auto anyHeight = [&]() {
		double hMin = lo, hMax = hi;
		double dA0 = planeDist(A, x, 0, z), dA1 = planeDist(A, x, 1, z) - dA0;
		double dB0 = planeDist(B, x, 0, z), dB1 = planeDist(B, x, 1, z) - dB0;
		auto le = [&](double k, double mm) {
			if (std::fabs(mm) < 1e-9) { if (k > 0) hMax = -INFINITY; return; }
			double root = -k / mm;
			if (mm > 0) hMax = std::min(hMax, root); else hMin = std::max(hMin, root);
		};
		le(dA0 - R, dA1);
		le(-dA0 - (4 / A.nXZ) - 1, -dA1);
		le(-dB0, -dB1);
		le(dB0 - R - 4, dB1);
		le(dB0 + (R - dA0) * cosAB, dB1 - dA1 * cosAB);
		return hMin <= hMax;
	};
	vector<double> ys;
	for (x = std::ceil(x0 / step) * step; x <= x1; x += step) {
		for (z = std::ceil(z0 / step) * step; z <= z1; z += step) {
			if (!anyHeight()) continue;
			// floor heights around the point, in the order first found
			ys.clear();
			auto add = [&](double y) { if (std::find(ys.begin(), ys.end(), y) == ys.end()) ys.push_back(y); };
			for (double y : m.floorsAt(x, z)) add(y);
			for (double d : { 8.0, 16.0, 24.0 })
				for (const auto& od : outDirs)
					for (double y : m.floorsNear(s, x + d * od[0], z + d * od[1])) add(y);
			for (double fy : ys) {
				double h = fy - GROUND_DROP + ch;
				if (h < lo || h > hi + m.lowDrop) continue;
				double hTop = std::min(h, hi), hLow = std::max(lo, h - m.lowDrop);
				if (!reachable(hTop) && !(m.lowDrop && (reachable(hLow) || reachable((hTop + hLow) / 2)))) continue;
				yield({ { F(x), fy, F(z) }, lo, hi });
			}
		}
	}
}

struct CrossPoint { V3 p; double floorY; int drop; double spotU, spotY; };

static void crossingPointsForWall(const Model& m, Scratch& s, const Poly& A, const vector<const Pair*>& pairsA,
	const std::function<void(const CrossPoint&)>& yield, double crossStep = CROSS_STEP) {
	const double ch = m.checkHeight;
	double nx = A.nx * A.invNXZ, nz = A.nz * A.invNXZ;
	double tx = -nz, tz = nx;
	double us[3] = { A.ax * tx + A.az * tz, A.bx * tx + A.bz * tz, A.cx * tx + A.cz * tz };
	double u0 = std::min({ us[0], us[1], us[2] }) - 2, u1 = std::max({ us[0], us[1], us[2] }) + 2;
	vector<std::pair<double, double>> nearR;
	for (const Pair* pr : pairsA) {
		const Poly& B = m.polys[pr->B];
		double bu[3] = { B.ax * tx + B.az * tz, B.bx * tx + B.bz * tz, B.cx * tx + B.cz * tz };
		double pad = m.radius + 30;
		double a = std::min({ bu[0], bu[1], bu[2] }) - pad, b = std::max({ bu[0], bu[1], bu[2] }) + pad;
		// Snapped radius in front of A, Link is only behind B near where the
		// planes meet: within (5 radius + 25) / sin(angle) of it along A.
		double xl, zl, xh, zh;
		if (planesMeet(A, B, pr->lo, 0, 0, xl, zl) && planesMeet(A, B, pr->hi, 0, 0, xh, zh)) {
			double sinAB = std::fabs(A.nx * B.nz - A.nz * B.nx) / (A.nXZ * B.nXZ);
			double w = (5 * m.radius + 25) / sinAB;
			double ul = xl * tx + zl * tz, uh = xh * tx + zh * tz;
			a = std::max(a, std::min(ul, uh) - w);
			b = std::min(b, std::max(ul, uh) + w);
			if (b < a) continue;
		}
		nearR.push_back({ a, b });
	}
	auto isNear = [&](double u) { for (auto& r : nearR) if (u >= r.first && u <= r.second) return true; return false; };
	auto onPlane = [&](double u, double h) {
		double c = -(A.dist + A.ny * h) / (A.nXZ * A.nXZ);
		return std::pair<double, double>(c * A.nx + u * tx, c * A.nz + u * tz);
	};
	const double c45 = SQRT1_2;
	const double outDirs[3][2] = { { nx, nz }, { (nx - nz) * c45, (nz + nx) * c45 }, { (nx + nz) * c45, (nz - nx) * c45 } };
	// A sloped floor pusher: the line test (at Link's feet + checkHeight -
	// GROUND_DROP) only meets the slope where it has risen that far above
	// the floor he stands on, which can be a whole frame's move away (OoT
	// Shadow Temple TRI 1182: 29+ units), so look that far for his floor.
	vector<double> sides = { -12.0, -2.0, 4.0, 14.0, 28.0 };
	if (A.isFloor) for (double d = 40; d <= REACH_DIST + 4; d += 12) sides.push_back(d);
	auto floorsBeside = [&](std::pair<double, double> q) {
		vector<double> out;
		for (double side : sides)
			for (const auto& od : outDirs)
				for (double y : m.floorsNear(s, q.first + side * od[0], q.second + side * od[1]))
					if (std::find(out.begin(), out.end(), y) == out.end()) out.push_back(y);
		return out;
	};
	vector<double> seedHeights = { A.minY, (A.minY + A.maxY) / 2, A.maxY };
	// A sloped floor pusher: every 8 up the slope too. Where the slope
	// meets a wall, its plane at the bottom / middle / top is out past the
	// wall, and only the plane at the line test's height has the floor Link
	// starts on beside it (OoT Shadow Temple: floor TRI 1207 at y -63, 40
	// units from where the line test at y -44.5 meets slope TRI 1182, by
	// wall TRI 1160).
	if (A.isFloor) for (double hs = A.minY + 8; hs < A.maxY; hs += 8) seedHeights.push_back(hs);
	// Where the floors beside the plane are looked for, below a floor's
	// y + checkHeight: a wall's plane is the same at every height, but a
	// slope's moves with it, so for a floor pusher also where the line test
	// runs - GROUND_DROP lower walking, up to checkHeight - 5 falling.
	vector<double> lineDrops = { 0 };
	if (A.isFloor) {
		lineDrops.push_back(GROUND_DROP);
		if (m.lowDrop) for (double d : { 14.0, maxPushDrop(ch) }) if (d > GROUND_DROP && d <= m.lowDrop) lineDrops.push_back(d);
	}
	auto floorsFor = [&](double u) {
		// floorsBeside of a position already looked up in this block (on a
		// vertical wall the plane is in the same place at every height)
		vector<std::tuple<double, double, vector<double>>> memo;
		auto beside = [&](std::pair<double, double> q) {
			for (auto& e : memo) if (std::get<0>(e) == q.first && std::get<1>(e) == q.second) return std::get<2>(e);
			memo.emplace_back(q.first, q.second, floorsBeside(q));
			return std::get<2>(memo.back());
		};
		vector<double> ys, seeds;
		for (double hs : seedHeights)
			for (double y : beside(onPlane(u, hs)))
				if (std::find(seeds.begin(), seeds.end(), y) == seeds.end()) seeds.push_back(y);
		auto same = [&](double y) { for (double v : ys) if (std::fabs(v - y) < 0.5) return true; return false; };
		for (double y0 : seeds) {
			for (double d : lineDrops) {
				for (double y : beside(onPlane(u, y0 + ch - d))) {
					double h = y + ch;
					if (h - std::max((double)m.lowDrop, GROUND_DROP) > A.maxY + 1 || h < A.minY - 1 || same(y)) continue;
					ys.push_back(y);
				}
			}
		}
		return ys;
	};
	bool haveBlock = false;
	double block = 0;
	vector<double> blockYs;
	int ui = 0;
	for (double u = u0; u <= u1; ui++, u += crossStep) {
		if (!isNear(u)) continue;
		double b = std::floor(u / FLOOR_BLOCK);
		if (!haveBlock || b != block) {
			haveBlock = true;
			block = b;
			blockYs = floorsFor((b + 0.5) * FLOOR_BLOCK);
		}
		for (double y : blockYs) {
			for (int drop = 0; drop <= m.lowDrop; drop += drop == 0 ? 2 : 4) {
				if (drop > 0 && (ui % 2)) break;
				// (walking, posNext is GROUND_DROP below the floor)
				double low = F(y - (drop ? drop : GROUND_DROP));
				// checkHeight + dy < 5 makes the game's line
				// test run at the feet with floors, which stops Link on the
				// floor he starts from - bigger drops can't clip crossing
				if (feetLine(ch, F(low - y))) break;
				double h = F(low + ch);
				if (h < A.minY - 1 || h > A.maxY + 1) continue;
				auto i = onPlane(u, h);
				yield({ { F(i.first), low, F(i.second) }, y, drop, u, y });
			}
		}
	}
}








struct CrossFound { ClipResult clip; V3 prev, next, res, at; bool noFloor = false; int yaw = 0; double speed = 0; bool aerial = false; };

static std::optional<std::pair<CrossFound, vector<int>>> crossingClip(const Model& m, Scratch& s, const Poly& A,
	const CrossPoint& cp, const Tol& tol) {
	vector<int> yaws;
	std::optional<CrossFound> first;
	std::set<std::pair<double, double>> tried;
	// (a sloped floor pusher needs a start far enough back for the line to
	// reach it at all: up to a whole frame's move, see floorsBeside)
	vector<double> steps = MOVE_STEPS;
	if (A.isFloor) for (double d = steps.back() + 4; d <= REACH_DIST; d += 4) steps.push_back(d);
	// standing still at prev, moving from there through the point
	auto tryStart = [&](const V3& prev, bool aerial) -> std::optional<CrossFound> {
		if (!tried.insert({ prev.x, prev.z }).second) return std::nullopt;
		double vx = cp.p.x - prev.x, vz = cp.p.z - prev.z, len = std::hypot(vx, vz);
		if (len < 0.5) return std::nullopt;
		double dx = vx / len, dz = vz / len;
		if (std::fabs(dx * A.nx + dz * A.nz) * A.invNXZ < 0.1) return std::nullopt;
		// the game's move: s16 yaw, speed 1 unit past the point, sine table
		int yaw = yawOf(vx, vz);
		double speed = F((len + 1) / SPEED_RATE);
		V3 next = moveStep(prev, yaw, speed);
		if (cp.drop > 0) next.y = cp.p.y;
		// The drop is from the floor at the clip point, but downhill the start
		// is higher: from the start, checkHeight + dy < 5 makes the game's line
		// test run at the feet, which stops him on his floor (tested in game:
		// OoT Kakariko child TRI 142 -> 673, 141 -> 21 etc., 20 of 20 didn't clip).
		if (cp.drop > 0 && feetLine(m.checkHeight, F(next.y - prev.y))) return std::nullopt;
		auto f = lineFrame(m, s, prev, next, tol);
		if (!f || f->hit.poly != A.id) return std::nullopt;
		const Move mv{ yaw, speed };
		auto clip = clipFromFrame(m, s, prev, f->res, f->trace, tol, cp.drop > 0 ? NAN : prev.y, &mv);
		if (!clip || !m.isInBounds(s, prev, true)) return std::nullopt;
		bool noFloor = false;
		if (cp.drop > 0) {
			auto end = landing(m, s, f->res, cp.floorY, noFloor, clip->crossed, &prev);
			if (!end) return std::nullopt;
			clip->end = *end;
		} else if (!m.endCounts(s, clip->crossed, clip->end, &prev)) {
			return std::nullopt;
		}
		return CrossFound{ *clip, prev, next, f->res, { f->hit.x, next.y, f->hit.z }, noFloor, yaw, speed, aerial };
	};
	auto record = [&](const CrossFound& found) {
		if (std::find(yaws.begin(), yaws.end(), found.yaw) == yaws.end()) yaws.push_back(found.yaw);
		if (!first) first = found;
	};
	// Resting starts first. Falling with --aerial, failing those, from right
	// there in the air (aerialSpot): only a pair no standing start does.
	for (int ai = 0; ai < (cp.drop > 0 && m.aerial ? 2 : 1) && !first; ai++) {
		for (int i = 0; i < 32; i++) {
			int yaw0 = i * 0x800;
			double dx0 = std::sin(yaw0 / 65536.0 * 2 * PI), dz0 = std::cos(yaw0 / 65536.0 * 2 * PI);
			if (std::fabs(dx0 * A.nx + dz0 * A.nz) * A.invNXZ < 0.1) continue;
			std::optional<CrossFound> found;
			for (double dist : steps) {
				// (cached for falling points only: a walking point's starts are
				// hardly ever tried again, so the cache just costs time there)
				double sx = F(cp.p.x - dist * dx0), sz = F(cp.p.z - dist * dz0);
				auto prevO = ai ? aerialSpot(m, sx, sz, cp.floorY)
					: cp.drop > 0 ? standSpotCached(m, s, sx, sz, cp.floorY) : standSpot(m, sx, sz, cp.floorY);
				if (!prevO) continue;
				if ((found = tryStart(*prevO, ai == 1))) break;
			}
			if (found) record(*found);
		}
		// Link standing partly inside a convex wall corner (corners.h)
		if (ai == 0) {
			vector<V3>& near = s.cornerBuf;
			near.clear();
			cornerSpotsNear(m, cp.p.x, cp.p.z, cp.floorY, steps.back(), near);
			for (const V3& prev : near)
				if (auto found = tryStart(prev, false)) record(*found);
		}
	}
	if (!first) return std::nullopt;
	return std::make_pair(*first, yaws);
}

// aerial (falling, --aerial): failing a resting spot, a start in the air
// (aerialSpot), and *aerial says which
static std::optional<V3> reachFrom(const Model& m, Scratch& s, const V3& p, double floorY, bool* aerial = nullptr) {
	double h = F(p.y + m.checkHeight);
	auto ok = [&](const V3& prev) {
		double x = prev.x, z = prev.z;
		if (std::hypot(p.x - x, p.z - z) > REACH_DIST) return false;
		// checkHeight + dy < 5: the game's line test runs at the feet,
		// floors included, and stops him on the floor he starts from (as
		// crossingClip; tested in game: MM West Clock Town human, drop 28
		// from y 75 / 135, TRI 143 -> 62 / 66 and 172 -> 69 didn't clip)
		if (feetLine(m.checkHeight, F(p.y - prev.y))) return false;
		if (m.lineHit(s, { x, h, z }, { p.x, h, p.z }, LOOSE, false, true)) return false;
		return m.isInBounds(s, prev, true);
	};
	for (int ai = 0; ai < (aerial && m.aerial ? 2 : 1); ai++) {
		for (double dist : MOVE_STEPS) {
			for (int i = 0; i < 16; i++) {
				double ang = i / 16.0 * 2 * PI;
				const double x0 = F(p.x - dist * std::sin(ang)), z0 = F(p.z - dist * std::cos(ang));
				auto prevO = ai ? aerialSpot(m, x0, z0, floorY) : standSpot(m, x0, z0, floorY);
				if (!prevO || !ok(*prevO)) continue;
				if (aerial) *aerial = ai == 1;
				return prevO;
			}
		}
		// Link standing partly inside a convex wall corner (corners.h)
		if (ai == 0) {
			vector<V3>& near = s.cornerBuf;
			near.clear();
			cornerSpotsNear(m, p.x, p.z, floorY, REACH_DIST, near);
			for (const V3& prev : near) {
				if (!ok(prev)) continue;
				if (aerial) *aerial = false;
				return prev;
			}
		}
	}
	return std::nullopt;
}

static std::optional<Clip> standingClip(const Model& m, Scratch& s, const V3& floorPt) {
	const V3 p = { floorPt.x, F(floorPt.y - GROUND_DROP), floorPt.z };
	PushList trace;
	V3 res = m.sphereStep(p, LOOSE, &trace);
	if (trace.empty()) return std::nullopt;
	auto clip = clipFromFrame(m, s, p, res, trace, LOOSE, floorPt.y);
	if (!m.isInBounds(s, floorPt, true)) return std::nullopt;
	if (clip) {
		if (!m.endCounts(s, clip->crossed, clip->end, &floorPt)) return std::nullopt;
	} else {
		// Not through standing still afterwards: maybe with the stick held one
		// more frame, which needs the move (below). Only if he went through a
		// wall at all.
		if (m.crossedWall(s, { p.x, res.y, p.z }, res) < 0) return std::nullopt;
	}
	// Link walks there himself: the game's move
	// stops a hair off p, so the frame is checked again where he ends up.
	// (the rings round p, then Link standing partly inside a convex wall
	// corner: corners.h)
	vector<V3> corner;
	cornerSpotsNear(m, p.x, p.z, floorPt.y, REACH_DIST, corner);
	const size_t rings = MOVE_STEPS.size() * 16;
	for (size_t k = 0; k < rings + corner.size(); k++) {
		{
			std::optional<V3> prevO;
			if (k < rings) {
				double dist = MOVE_STEPS[k / 16], ang = (k % 16) / 16.0 * 2 * PI;
				prevO = standSpot(m, F(p.x - dist * std::sin(ang)), F(p.z - dist * std::cos(ang)), floorPt.y);
			} else prevO = corner[k - rings];
			if (!prevO) continue;
			V3 prev = *prevO;
			double vx = p.x - prev.x, vz = p.z - prev.z, len = std::hypot(vx, vz);
			if (len < 0.01 || len > REACH_DIST) continue;
			int yaw = yawOf(vx, vz);
			double speed = F(len / SPEED_RATE);
			V3 next = moveStep(prev, yaw, speed);
			if (lineFrame(m, s, prev, next, LOOSE)) continue;
			PushList tr;
			V3 wres = m.sphereStep(next, LOOSE, &tr, &prev);
			const Move mv{ yaw, speed };
			auto wclip = clipFromFrame(m, s, prev, wres, tr, LOOSE, prev.y, &mv);
			if (!wclip || !m.endCounts(s, wclip->crossed, wclip->end, &prev) || !m.isInBounds(s, prev, true)) continue;
			PushList st;
			V3 sres = m.sphereStep(next, STRICT, &st, &prev);
			// acute: it clips without the extended planes, and the push starts
			// in front of the pusher's face (not beside it, see pushOnFace)
			auto sclip = clipFromFrame(m, s, prev, sres, st, STRICT, prev.y, &mv);
			Clip c;
			c.acutePoint = sclip && sclip->onFace;
			c.hold = wclip->hold;
			c.from = next; c.floorY = prev.y; c.hasFloorY = true; c.prev = prev; c.res = wres; c.end = wclip->end;
			c.next = next; c.hasNext = true; c.yaw = yaw; c.speed = speed; c.hasMove = true;
			c.crossed = wclip->crossed; c.pusher = wclip->pusher;
			return c;
		}
	}
	return std::nullopt;
}

static std::optional<Clip> lowClip(const Model& m, Scratch& s, const V3& p, int drop) {
	V3 low = { p.x, F(p.y - drop), p.z };
	PushList trace;
	V3 res = m.sphereStep(low, LOOSE, &trace);
	if (trace.empty()) return std::nullopt;
	auto clip = clipFromFrame(m, s, low, res, trace, LOOSE);
	if (!clip) return std::nullopt;
	if (!m.isInBounds(s, p, true)) return std::nullopt;
	bool noFloor = false;
	auto end = landing(m, s, res, p.y, noFloor, clip->crossed, &p);
	if (!end) return std::nullopt;
	bool aerial = false;
	auto prev = reachFrom(m, s, low, p.y, &aerial);
	if (!prev) return std::nullopt;
	Clip c;
	c.aerial = aerial;
	PushList st;
	V3 sres = m.sphereStep(low, STRICT, &st);
	auto sclip = clipFromFrame(m, s, low, sres, st, STRICT);
	c.acutePoint = sclip && sclip->onFace;
	c.drop = drop;
	c.from = low; c.floorY = p.y; c.hasFloorY = true; c.prev = *prev; c.res = res; c.end = *end; c.endNoFloor = noFloor;
	c.crossed = clip->crossed; c.pusher = clip->pusher;
	return c;
}


// A point (and falling drop) seen by any thread, sharded to keep lock
// contention down.
struct SeenKey {
	double x, z, y;
	int drop;
	bool operator==(const SeenKey& o) const { return x == o.x && z == o.z && y == o.y && drop == o.drop; }
};
struct SeenHash {
	size_t operator()(const SeenKey& k) const {
		uint64_t h = 1469598103934665603ull;
		for (double v : { k.x, k.z, k.y }) {
			uint64_t b;
			memcpy(&b, &v, 8);
			h = (h ^ b) * 1099511628211ull;
		}
		return (size_t)(h ^ (uint64_t)k.drop * 0x9E3779B97F4A7C15ull);
	}
};
struct SharedSet {
	static const int N = 64;
	std::mutex mu[N];
	std::unordered_set<SeenKey, SeenHash> sets[N];
	bool insert(const SeenKey& k) {
		size_t h = SeenHash{}(k) % N;
		std::lock_guard<std::mutex> g(mu[h]);
		return sets[h].insert(k).second;
	}
};

static string keyOf(double a, double b, double c) {
	char buf[96];
	snprintf(buf, sizeof buf, "%.9g,%.9g,%.9g", a, b, c);
	return buf;
}

// firstPerPair: stop looking at a wall pair (pushing wall, clipped wall) once
// one clip through it is found (like wall_clip_tester.lua's
// RECORD_ONE_PER_PAIR) - one point per pair, much faster.
vector<Clip> scan(const Model& m, int threads, bool firstPerPair) {
	auto t0 = std::chrono::steady_clock::now();
	vector<Pair> pairs = wallPairCandidates(m);
	// --pair: just the candidates near its two polys (within a frame's move and
	// Link's width), not only the pair itself: which wall pushes him through
	// which is up to the frame, so its clips can turn up from a neighbouring
	// candidate's points, and those points take part in the dedupe
	const double focusMargin = REACH_DIST + 2 * m.radius + 10;
	if (m.focusA >= 0) {
		size_t all = pairs.size();
		pairs.erase(std::remove_if(pairs.begin(), pairs.end(), [&](const Pair& p) {
			return !m.nearFocus(m.polys[p.A], focusMargin) || !m.nearFocus(m.polys[p.B], focusMargin);
		}), pairs.end());
		fprintf(stderr, "  --pair: %zu of %zu wall pairs are near TRI %d and %d\n", pairs.size(), all, m.focusA, m.focusB);
	}
	SharedSet seen;
	std::mutex outMu;
	vector<Clip> clips;
	std::mutex foundMu;
	std::set<std::pair<int, int>> foundPairs;
	auto pairFound = [&](int a, int b) {
		if (!firstPerPair) return false;
		std::lock_guard<std::mutex> g(foundMu);
		return foundPairs.count({ a, b }) > 0;
	};
	// Records a clip's pair; false if another thread got there first.
	auto claimPair = [&](int a, int b) {
		if (!firstPerPair) return true;
		std::lock_guard<std::mutex> g(foundMu);
		return foundPairs.insert({ a, b }).second;
	};
	// --wall-step's fine pass: the wall pairs that have a clip (from the normal
	// passes, or found in this one), so it only looks for new pairs, and only
	// until each has one clip
	std::set<std::pair<int, int>> fineFound;
	auto isFound = [&](bool fine, int a, int b) {
		if (!fine) return pairFound(a, b);
		std::lock_guard<std::mutex> g(foundMu);
		return fineFound.count({ a, b }) > 0;
	};
	auto claim = [&](bool fine, int a, int b) {
		if (!fine) return claimPair(a, b);
		std::lock_guard<std::mutex> g(foundMu);
		return fineFound.insert({ a, b }).second;
	};
	SharedSet seenFine;
	std::atomic<size_t> nextPair{ 0 }, pairsDone{ 0 };
	// --type extended without acute: wall pairs (pusher, crossed) with an acute point found
	// (not kept). That makes the pair acute, so all its points are left out,
	// extended ones included.
	std::mutex acuteMu;
	std::set<std::pair<int, int>> acutePairs;
	auto markAcute = [&](int a, int b) {
		std::lock_guard<std::mutex> g(acuteMu);
		acutePairs.insert({ a, b });
	};

	// The terminal: each step a numbered heading saying what it does, a
	// progress count under it, then how many clip points it found
	// (what each step does: the README's "The terminal")
	int stepNo = 0;
	auto stepT0 = t0;
	string stepTitle;
	auto stepStart = [&](const string& title) {
		stepTitle = std::to_string(++stepNo) + ". " + title;
		fprintf(stderr, "  %s", stepTitle.c_str());
		stepT0 = std::chrono::steady_clock::now();
	};
	auto stepDone = [&](size_t points, const string& more = "") {
		fprintf(stderr, "\r  %s -> %zu clip points (%.1fs)%s                    \n", stepTitle.c_str(), points,
			std::chrono::duration<double>(std::chrono::steady_clock::now() - stepT0).count(), more.c_str());
	};
	auto progress = [&](const char* unit, size_t done, size_t total) {
		static std::mutex pm;
		static auto last = std::chrono::steady_clock::now();
		std::lock_guard<std::mutex> g(pm);
		auto now = std::chrono::steady_clock::now();
		if (std::chrono::duration<double>(now - last).count() < 0.5 && done != total) return;
		last = now;
		fprintf(stderr, "\r  %s: %zu / %zu %s (%.0fs)   ", stepTitle.c_str(), done, total, unit, std::chrono::duration<double>(now - stepT0).count());
	};

	// fine: --wall-step's pass (see fineFound)
	auto worker1 = [&](bool fine) {
		Scratch s;
		s.stamp.assign(m.polys.size(), 0);
		vector<Clip> local;
		const char* phase = "wall pairs";
		SharedSet& seenP = fine ? seenFine : seen;
		for (;;) {
			size_t pi = nextPair++;
			if (pi >= pairs.size()) break;
			s.clearCache();
			const Pair& pr = pairs[pi];
			// (a floor pusher only snaps Link through the line test: crossings only)
			if (m.polys[pr.A].isFloor || isFound(fine, pr.A, pr.B)) { progress(phase, ++pairsDone, pairs.size()); continue; }
			nextPositionsForPair(m, s, pr, [&](const NextPos& np) {
				if (isFound(fine, pr.A, pr.B)) return;
				const V3& p = np.p;
				double h = p.y + m.checkHeight;
				if (h - GROUND_DROP >= np.lo && h - GROUND_DROP <= np.hi && seenP.insert({ p.x, p.z, p.y, 0 })) {
					if (auto c = standingClip(m, s, p)) {
						// (extended plane only: an acute one still ends the point, it's just not kept)
						if (m.extendedOnly && c->acutePoint) markAcute(c->pusher, c->crossed);
						else if (claim(fine, c->pusher, c->crossed)) local.push_back(*c);
						return;
					}
				}
				for (int k = 2; k <= m.lowDrop; k += 2) {
					double hk = h - k;
					if (hk < np.lo || hk > np.hi) continue;
					if (!seenP.insert({ p.x, p.z, p.y, k })) continue;
					if (auto c = lowClip(m, s, p, k)) {
						if (m.extendedOnly && c->acutePoint) markAcute(c->pusher, c->crossed);
						else if (claim(fine, c->pusher, c->crossed)) local.push_back(*c);
						break;
					}
				}
			}, fine ? m.wallStep : NEXT_STEP, !fine);
			progress(phase, ++pairsDone, pairs.size());
		}
		std::lock_guard<std::mutex> g(outMu);
		clips.insert(clips.end(), local.begin(), local.end());
	};

	// Pushers and the walls each pushes against.
	std::map<int, vector<int>> partnersOf;
	std::map<int, vector<const Pair*>> pairsOf;
	vector<int> pushers;
	for (const Pair& p : pairs) {
		if (!partnersOf.count(p.A)) pushers.push_back(p.A);
		partnersOf[p.A].push_back(p.B);
		pairsOf[p.A].push_back(&p);
	}
	std::atomic<size_t> nextPusher{ 0 }, pushersDone{ 0 };

	auto worker2 = [&](bool fine) {
		Scratch s;
		s.stamp.assign(m.polys.size(), 0);
		vector<Clip> local;
		const char* phase = "pushing walls";
		for (;;) {
			size_t ai = nextPusher++;
			if (ai >= pushers.size()) break;
			s.clearCache();
			s.standSpots.clear();
			const Poly& A = m.polys[pushers[ai]];
			const vector<int>& partners = partnersOf[A.id];
			if (fine && std::all_of(partners.begin(), partners.end(), [&](int b) { return isFound(true, A.id, b); })) {
				progress(phase, ++pushersDone, pushers.size());
				continue;
			}
			double k = F(m.radius * F(1 / A.nXZ));
			std::set<std::pair<double, double>> done;
			// one point per (start, move) frame (the frame's
			// line check has to hit A, so it can only come from this pusher)
			std::set<std::array<double, 6>> frames;
			crossingPointsForWall(m, s, A, pairsOf[A.id], [&](const CrossPoint& cp) {
				if (done.count({ cp.spotU, cp.spotY })) return;
				V3 snapped = { F(F(k * A.nx) + cp.p.x), cp.p.y, F(F(k * A.nz) + cp.p.z) };
				V3 res = m.sphereStep(snapped, LOOSE, nullptr);
				double h = cp.p.y + m.checkHeight;
				bool behind = false, behindDyna = false;
				for (int bid : partners) {
					const Poly& B = m.polys[bid];
					double d = planeDist(B, res.x, h, res.z);
					if (d >= 0 || d < -4 * m.radius) continue;
					double t = d / B.nMag;
					if (pointInTri3D(B, res.x - t * B.nx, h - t * B.ny, res.z - t * B.nz, 1) && !isFound(fine, A.id, bid)) {
						behind = true;
						behindDyna = B.bg >= 0;
						break;
					}
				}
				if (!behind) return;
				double nx = A.nx * A.invNXZ, nz = A.nz * A.invNXZ;
				// Somewhere around the point in bounds. --slope-starts: failing
				// that, not counting the rays that go into a slope first
				// (isInBounds's floorsBlock). That finds clips starting on slopes
				// whose rays the old test sent under the ground, but lets through
				// many more points that don't clip: Death Mountain Trail setup 2
				// adult falling, 294 more points (1.4%, 4 more wall pairs) in
				// 110 s instead of 38 s.
				// (along A's normal, then 45 degrees either side of it: at an
				// acute corner every point along the normal is behind the other
				// wall or A - MM West Clock Town, the step TRI 164 by TRI 59)
				bool anyIn = false;
				V3 inPt;
				const double c45 = SQRT1_2;
				const double probeDirs[3][2] = { { nx, nz }, { (nx - nz) * c45, (nz + nx) * c45 }, { (nx + nz) * c45, (nz - nx) * c45 } };
				for (bool fb : { false, true }) {
					if (anyIn || (fb && !m.slopeStarts)) break;
					for (const auto& pd : probeDirs) {
						for (double sd : { 3.0, -3.0, 12.0, -12.0 }) {
							if (sd < 0 && &pd != &probeDirs[0]) continue;  // (45 degrees: in front of A only)
							inPt = { cp.p.x + sd * pd[0], cp.floorY, cp.p.z + sd * pd[1] };
							if (m.isInBounds(s, inPt, fb)) { anyIn = true; break; }
						}
						if (anyIn) break;
					}
				}
				if (!anyIn) return;
				// Falling, he has to land out of bounds: where the snap onto A
				// and the pushes put him is about where the real frame does (the
				// move is aimed through the point), so if he lands in bounds from
				// there and from 2 units around it, don't search for the move.
				// (About 90% of the falling points; in Kakariko / Kokiri Forest
				// it lost 1 point of ~7400, one that a 0.01 unit change flips.)
				// (behind a dynapoly, or somewhere he couldn't walk to from the
				// in-bounds spot beside the point, landing in bounds counts too:
				// Model::endCounts)
				if (cp.drop > 0 && !behindDyna) {
					bool landsOut = false, noFloor;
					const double offs[5][2] = { { 0, 0 }, { 2, 0 }, { -2, 0 }, { 0, 2 }, { 0, -2 } };
					for (const auto& o : offs) {
						V3 q = { res.x + o[0] * nx - o[1] * nz, res.y, res.z + o[0] * nz + o[1] * nx };
						if (landing(m, s, q, cp.floorY, noFloor)) { landsOut = true; break; }
					}
					// (the flood fill last, and only from the point itself: it's slow)
					if (!landsOut) landsOut = landing(m, s, res, cp.floorY, noFloor, -1, &inPt).has_value();
					if (!landsOut) return;
				}
				auto r = crossingClip(m, s, A, cp, LOOSE);
				if (!r) return;
				done.insert({ cp.spotU, cp.spotY });
				const CrossFound& f0 = r->first;
				if (!frames.insert({ f0.prev.x, f0.prev.y, f0.prev.z, f0.next.x, f0.next.y, f0.next.z }).second) return;
				// the same point without the extended planes
				auto sr = crossingClip(m, s, A, cp, STRICT);
				bool strict = sr && sr->first.clip.onFace;
				if (m.extendedOnly && strict) { markAcute(A.id, r->first.clip.crossed); return; }
				if (!claim(fine, A.id, r->first.clip.crossed)) return;
				const CrossFound& f = r->first;
				Clip c;
				c.acutePoint = strict;
				c.cross = true; c.drop = cp.drop; c.aerial = f.aerial;
				c.hold = f.clip.hold;
				c.from = f.at; c.floorY = cp.floorY; c.hasFloorY = true;
				c.prev = f.prev; c.next = f.next; c.hasNext = true; c.res = f.res; c.end = f.clip.end; c.endNoFloor = f.noFloor;
				c.yaws = r->second;
				c.yaw = f.yaw; c.speed = f.speed; c.hasMove = true;
				c.crossed = f.clip.crossed; c.pusher = A.id;
				local.push_back(c);
			}, fine ? m.wallStep / 2 : CROSS_STEP);
			progress(phase, ++pushersDone, pushers.size());
		}
		std::lock_guard<std::mutex> g(outMu);
		clips.insert(clips.end(), local.begin(), local.end());
	};

	fprintf(stderr, "  %zu wall pairs, %zu walls that push\n", pairs.size(), pushers.size());
	if (!m.bgActors.empty()) {
		size_t one = 0, both = 0;
		for (const Pair& p : pairs) {
			int n = (m.polys[p.A].bg >= 0) + (m.polys[p.B].bg >= 0);
			if (n == 1) one++;
			else if (n == 2) both++;
		}
		fprintf(stderr, "  (dynapolys: %zu of the pairs have one dynapoly wall, %zu two)\n", one, both);
	}
	// (--type: the wall push scan only if a wall push type is picked)
	if (m.wallPushes) {
		{
			stepStart("Wall pushes from a standing start");
			const size_t before = clips.size();
			vector<std::thread> ts;
			for (int i = 0; i < threads; i++) ts.emplace_back(worker1, false);
			for (auto& t : ts) t.join();
			stepDone(clips.size() - before);
		}
		{
			stepStart("Wall pushes through a wall's face");
			const size_t before = clips.size();
			vector<std::thread> ts;
			for (int i = 0; i < threads; i++) ts.emplace_back(worker2, false);
			for (auto& t : ts) t.join();
			stepDone(clips.size() - before);
		}
	}
	// Slope clips (slope.h): every wall, along its bottom edge
	vector<int> slopeWalls;
	for (const Poly& p : m.polys) {
		if (!p.exists || !p.isWall || !(p.nXZ > 0)) continue;
		// --dyna-only: a static wall only near a dynapoly actor (its floor can be the lift)
		if (m.dynaPairsOnly && p.bg < 0 && std::none_of(m.bgActors.begin(), m.bgActors.end(), [&](const BgActor& b) {
			return b.cx + b.r >= p.minX - 50 && b.cx - b.r <= p.maxX + 50 && b.cz + b.r >= p.minZ - 50 && b.cz - b.r <= p.maxZ + 50;
		})) continue;
		if (m.slope && m.nearFocus(p, focusMargin)) slopeWalls.push_back(p.id);
	}
	std::atomic<size_t> nextSlope{ 0 }, slopesDone{ 0 };
	size_t slopeFound = 0;
	auto worker3 = [&]() {
		Scratch s;
		s.stamp.assign(m.polys.size(), 0);
		vector<Clip> local;
		for (;;) {
			size_t wi = nextSlope++;
			if (wi >= slopeWalls.size()) break;
			s.clearCache();
			s.standSpots.clear();
			slopeClipsForWall(m, s, m.polys[slopeWalls[wi]], pairFound, [&](const Clip& c) {
				if (claimPair(c.pusher, c.crossed)) local.push_back(c);
			});
			progress("walls", ++slopesDone, slopeWalls.size());
		}
		std::lock_guard<std::mutex> g(outMu);
		slopeFound += local.size();
		clips.insert(clips.end(), local.begin(), local.end());
	};
	if (!slopeWalls.empty()) {
		stepStart("Slope clips");
		vector<std::thread> ts;
		for (int i = 0; i < threads; i++) ts.emplace_back(worker3);
		for (auto& t : ts) t.join();
		stepDone(slopeFound);
	}
	// Ground clips (ground.h): every wall rising out of a floor, along its bottom edge
	vector<int> groundWalls;
	if (m.ground) {
		for (const Poly& p : m.polys) {
			if (!p.exists || !p.isWall || !(p.nXZ > 0)) continue;
			// --dyna-only: a static wall only near a dynapoly actor (its floor can be the one he falls through)
			if (m.dynaPairsOnly && p.bg < 0 && std::none_of(m.bgActors.begin(), m.bgActors.end(), [&](const BgActor& b) {
				return b.cx + b.r >= p.minX - 50 && b.cx - b.r <= p.maxX + 50 && b.cz + b.r >= p.minZ - 50 && b.cz - b.r <= p.maxZ + 50;
			})) continue;
			if (m.nearFocus(p, focusMargin)) groundWalls.push_back(p.id);
		}
	}
	std::atomic<size_t> nextGround{ 0 }, groundsDone{ 0 };
	size_t groundFound = 0;
	auto worker4 = [&]() {
		Scratch s;
		s.stamp.assign(m.polys.size(), 0);
		vector<Clip> local;
		for (;;) {
			size_t wi = nextGround++;
			if (wi >= groundWalls.size()) break;
			s.clearCache();
			s.standSpots.clear();
			groundClipsForWall(m, s, m.polys[groundWalls[wi]], pairFound, [&](const Clip& c) {
				if (claimPair(c.pusher, c.crossed)) local.push_back(c);
			});
			progress("walls", ++groundsDone, groundWalls.size());
		}
		std::lock_guard<std::mutex> g(outMu);
		groundFound += local.size();
		clips.insert(clips.end(), local.begin(), local.end());
	};
	if (!groundWalls.empty()) {
		stepStart("Ground clips");
		vector<std::thread> ts;
		for (int i = 0; i < threads; i++) ts.emplace_back(worker4);
		for (auto& t : ts) t.join();
		stepDone(groundFound);
	}
	// --wall-step: the wall push passes again, finer and uncapped, on the wall
	// pairs without a clip yet, one clip each (a pair is known to clip then;
	// --pair --refine / --angles look at it closely)
	if (m.wallStep > 0 && m.wallPushes) {
		auto tf0 = std::chrono::steady_clock::now();
		for (const Clip& c : clips) fineFound.insert({ c.pusher, c.crossed });
		for (const auto& pr : acutePairs) fineFound.insert(pr);
		const size_t before = clips.size(), knownPairs = fineFound.size();
		nextPair = 0; pairsDone = 0; nextPusher = 0; pushersDone = 0;
		char title[64];
		snprintf(title, sizeof title, "Finer pass (--wall-step %g)", m.wallStep);
		stepStart(title);
		for (auto worker : { std::function<void(bool)>(worker1), std::function<void(bool)>(worker2) }) {
			vector<std::thread> ts;
			for (int i = 0; i < threads; i++) ts.emplace_back(worker, true);
			for (auto& t : ts) t.join();
		}
		stepDone(clips.size() - before, ", " + std::to_string(fineFound.size() - knownPairs) + " new wall pairs");
		(void)tf0;
	}
	// Deterministic order: standing points first, then crossings, by position.
	std::sort(clips.begin(), clips.end(), [](const Clip& a, const Clip& b) {
		if (a.cross != b.cross) return !a.cross;
		if (a.pusher != b.pusher) return a.pusher < b.pusher;
		if (a.from.x != b.from.x) return a.from.x < b.from.x;
		if (a.from.z != b.from.z) return a.from.z < b.from.z;
		if (a.from.y != b.from.y) return a.from.y < b.from.y;
		if (a.drop != b.drop) return a.drop < b.drop;
		if (a.crossed != b.crossed) return a.crossed < b.crossed;
		if (a.floorY != b.floorY) return a.floorY < b.floorY;
		if (a.prev.x != b.prev.x) return a.prev.x < b.prev.x;
		if (a.prev.z != b.prev.z) return a.prev.z < b.prev.z;
		return a.acutePoint > b.acutePoint;
	});
	// Low standing points can be found through more than one wall pair; keep
	// one per position.
	vector<Clip> out;
	std::unordered_set<string> keep;
	size_t acuteDropped = 0, loadVoidDropped = 0;
	for (const Clip& c : clips) {
		if (m.extendedOnly && acutePairs.count({ c.pusher, c.crossed })) { acuteDropped++; continue; }
		// starting on a loading zone or void plane: the game takes Link
		// there before any clip matters (--keep-load-void keeps them)
		if (!m.keepLoadVoid && m.startOnLoadVoid(c.prev)) { loadVoidDropped++; continue; }
		string k = (c.cross ? "c" : "s") + std::to_string(c.pusher) + ":" + keyOf(c.from.x, c.from.z, c.hasFloorY ? c.floorY : c.from.y);
		if (!c.cross && !keep.insert(k).second) continue;
		out.push_back(c);
	}
	// Where it ends in bounds (the JSON's "inBounds")
	{
		Scratch s;
		s.stamp.assign(m.polys.size(), 0);
		for (Clip& c : out) {
			c.inBounds = !c.endNoFloor && m.isInBounds(s, c.end);
			// (in bounds: how far the walk there is - a shortcut, Model::walkUnreachable)
			if (c.inBounds) c.walkDist = m.walkShortcut(s, c.end, c.prev);
		}
	}
	// One category per wall pair: acute if any of its points is
	std::set<std::pair<int, int>> acute;
	for (const Clip& c : out) if (c.acutePoint && c.kind < 2) acute.insert({ c.pusher, c.crossed });
	for (Clip& c : out) if (c.kind < 2) c.kind = acute.count({ c.pusher, c.crossed }) ? 0 : 1;
	double secs = std::chrono::duration<double>(std::chrono::steady_clock::now() - t0).count();
	fprintf(stderr, "  = %zu clip points in all (%.1fs)\n", out.size(), secs);
	(void)loadVoidDropped;
	if (m.extendedOnly && !acutePairs.empty())
		fprintf(stderr, "  (extended only: left out %zu acute wall pairs, and their %zu points that aren't acute on their own)\n",
			acutePairs.size(), acuteDropped);
	return out;
}

// thinClips' rows: a wall pair, its kind, crossing / standing, walking /
// falling and the action
using ThinKey = std::tuple<int, int, int, bool, bool, int>;
static ThinKey thinKey(const Clip& c) { return { c.pusher, c.crossed, c.kind, c.cross, c.drop > 0, c.action }; }

int thinCapForBudget(const vector<const vector<Clip>*>& sets, int maxN, int minN, size_t budget) {
	vector<size_t> sizes;
	for (const vector<Clip>* set : sets) {
		std::map<ThinKey, size_t> n;
		for (const Clip& c : *set) n[thinKey(c)]++;
		for (auto& [k, v] : n) sizes.push_back(v);
	}
	auto total = [&](int cap) { size_t t = 0; for (size_t v : sizes) t += std::min(v, (size_t)cap); return t; };
	int cap = maxN;
	while (cap > minN && total(cap) > budget) cap--;
	return cap;
}

size_t thinClips(vector<Clip>& clips, int n) {
	if (n <= 0) return 0;
	std::map<ThinKey, vector<size_t>> groups;
	for (size_t i = 0; i < clips.size(); i++) groups[thinKey(clips[i])].push_back(i);
	vector<bool> keep(clips.size(), false);
	for (auto& [k, idx] : groups) {
		if ((int)idx.size() <= n) { for (size_t i : idx) keep[i] = true; continue; }
		vector<size_t> chosen;
		auto choose = [&](size_t i) { if (std::find(chosen.begin(), chosen.end(), i) == chosen.end()) chosen.push_back(i); };
		// the slowest reach, and a point that makes the pair acute
		const Clip* best = nullptr;
		size_t bestI = 0;
		for (size_t i : idx) if (clips[i].hasReach && (!best || clips[i].reachSpeed < best->reachSpeed)) { best = &clips[i]; bestI = i; }
		if (best) choose(bestI);
		for (size_t i : idx) if (clips[i].acutePoint) { choose(i); break; }
		if (chosen.empty()) choose(idx[0]);
		// then over and over the point farthest from every chosen one
		vector<double> d(idx.size(), INFINITY);
		auto dist2 = [&](size_t a, size_t b) {
			const V3 &p = clips[a].from, &q = clips[b].from;
			return (p.x - q.x) * (p.x - q.x) + (p.y - q.y) * (p.y - q.y) + (p.z - q.z) * (p.z - q.z);
		};
		size_t seen = 0;
		while ((int)chosen.size() < n) {
			for (; seen < chosen.size(); seen++)
				for (size_t j = 0; j < idx.size(); j++) d[j] = std::min(d[j], dist2(idx[j], chosen[seen]));
			size_t far = 0;
			for (size_t j = 1; j < idx.size(); j++) if (d[j] > d[far]) far = j;
			if (!(d[far] > 0)) break; // the rest are on chosen points
			chosen.push_back(idx[far]);
		}
		for (size_t i : chosen) keep[i] = true;
	}
	size_t w = 0;
	for (size_t i = 0; i < clips.size(); i++) if (keep[i]) clips[w++] = clips[i];
	const size_t dropped = clips.size() - w;
	clips.resize(w);
	return dropped;
}

static const char* const TYPE_NAMES[] = { "acute", "extended", "slope", "ground", "falling", "actions" };

int parseTypes(const string& list, string& err) {
	int t = 0;
	for (size_t a = 0; a <= list.size();) {
		size_t b = list.find(',', a);
		if (b == string::npos) b = list.size();
		string name = list.substr(a, b - a);
		for (auto& ch : name) ch = (char)tolower((unsigned char)ch);
		a = b + 1;
		if (name.empty()) continue;
		if (name == "all") { t |= TYPE_ALL; continue; }
		int bit = 0;
		for (int k = 0; k < 6; k++) if (name == TYPE_NAMES[k]) bit = 1 << k;
		if (!bit) { err = "unknown type " + name + " (acute, extended, slope, ground, falling, actions, or all: the first five)"; return 0; }
		t |= bit;
	}
	if (!t) err = "no types";
	return t;
}

string typeTag(int types) {
	if (types == (TYPE_ACUTE | TYPE_EXTENDED | TYPE_SLOPE)) return "";
	if (types == TYPE_ALL) return "_all";
	string s;
	for (int k = 0; k < 6; k++) if (types & (1 << k)) s += (s.empty() ? "_" : "-") + string(TYPE_NAMES[k]);
	return s;
}

void keepTypes(vector<Clip>& clips, int types) {
	if ((types & TYPE_ACTIONS) && !(types & (TYPE_ACUTE | TYPE_EXTENDED | TYPE_SLOPE))) types |= TYPE_ACUTE | TYPE_EXTENDED | TYPE_SLOPE;
	const int cats = types & (TYPE_ACUTE | TYPE_EXTENDED);
	clips.erase(std::remove_if(clips.begin(), clips.end(), [&](const Clip& c) {
		if (c.kind == 2) return !(types & TYPE_SLOPE);
		if (c.kind == 3) return !(types & TYPE_GROUND);
		const int cat = c.kind == 0 ? TYPE_ACUTE : TYPE_EXTENDED;
		if (c.drop == 0) return !(types & cat);
		return !(types & TYPE_FALLING) || (cats && !(types & cat));
	}), clips.end());
}
