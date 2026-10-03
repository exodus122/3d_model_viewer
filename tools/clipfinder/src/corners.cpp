#include "corners.h"

#include <atomic>
#include <mutex>
#include <thread>

// Distance from p to triangle P (3D)
static double triDist(const Poly& P, double px, double py, double pz) {
	// (Ericson, Real-Time Collision Detection 5.1.5)
	const double ax = P.ax, ay = P.ay, az = P.az;
	const double abx = P.bx - ax, aby = P.by - ay, abz = P.bz - az;
	const double acx = P.cx - ax, acy = P.cy - ay, acz = P.cz - az;
	auto dist = [&](double qx, double qy, double qz) { return std::sqrt(sq(px - qx) + sq(py - qy) + sq(pz - qz)); };
	const double apx = px - ax, apy = py - ay, apz = pz - az;
	const double d1 = abx * apx + aby * apy + abz * apz, d2 = acx * apx + acy * apy + acz * apz;
	if (d1 <= 0 && d2 <= 0) return dist(ax, ay, az);
	const double bpx = px - P.bx, bpy = py - P.by, bpz = pz - P.bz;
	const double d3 = abx * bpx + aby * bpy + abz * bpz, d4 = acx * bpx + acy * bpy + acz * bpz;
	if (d3 >= 0 && d4 <= d3) return dist(P.bx, P.by, P.bz);
	const double vc = d1 * d4 - d3 * d2;
	if (vc <= 0 && d1 >= 0 && d3 <= 0) { double v = d1 / (d1 - d3); return dist(ax + v * abx, ay + v * aby, az + v * abz); }
	const double cpx = px - P.cx, cpy = py - P.cy, cpz = pz - P.cz;
	const double d5 = abx * cpx + aby * cpy + abz * cpz, d6 = acx * cpx + acy * cpy + acz * cpz;
	if (d6 >= 0 && d5 <= d6) return dist(P.cx, P.cy, P.cz);
	const double vb = d5 * d2 - d1 * d6;
	if (vb <= 0 && d2 >= 0 && d6 <= 0) { double w = d2 / (d2 - d6); return dist(ax + w * acx, ay + w * acy, az + w * acz); }
	const double va = d3 * d6 - d5 * d4;
	if (va <= 0 && d4 - d3 >= 0 && d5 - d6 >= 0) {
		double w = (d4 - d3) / ((d4 - d3) + (d5 - d6));
		return dist(P.bx + w * (P.cx - P.bx), P.by + w * (P.cy - P.by), P.bz + w * (P.cz - P.bz));
	}
	const double den = 1 / (va + vb + vc), v = vb * den, w = vc * den;
	return dist(ax + abx * v + acx * w, ay + aby * v + acy * w, az + abz * v + acz * w);
}

// How deep his sphere (at check height, standing at p) is into the nearest of
// `walls`: radius minus the distance to it (<= 0: not touching)
static double depthInto(const Model& m, const vector<int>& walls, const V3& p) {
	const double sy = p.y + m.checkHeight;
	double best = -INFINITY;
	for (int id : walls) best = std::max(best, m.radius - triDist(m.polys[id], p.x, sy, p.z));
	return best;
}

// The walls near p, at his check height (the static subdivision's, and every
// dynapoly wall within reach)
static void wallsNear(const Model& m, const V3& p, vector<int>& out) {
	out.clear();
	const double sy = F(p.y + m.checkHeight);
	for (int id : m.cellWalls(p.x, sy, p.z)) out.push_back(id);
	for (int id : m.dynaWalls) {
		const Poly& w = m.polys[id];
		if (p.x < w.minX - m.radius || p.x > w.maxX + m.radius || p.z < w.minZ - m.radius || p.z > w.maxZ + m.radius) continue;
		out.push_back(id);
	}
}

bool inCornerPocket(const Model& m, const V3& p) {
	vector<int> walls;
	wallsNear(m, p, walls);
	return depthInto(m, walls, p) >= 0.5;
}

void findCornerSpots(Model& m, int threads) {
	m.cornerSpots.clear();
	m.cornerGrid.clear();
	// Every wall vertex's xz (a wall's top and bottom share one), with the walls
	// at it
	struct Vtx { double x, z; vector<int> walls; };
	std::unordered_map<int64_t, size_t> at;
	vector<Vtx> vtx;
	for (const Poly& p : m.polys) {
		if (!p.exists || !p.isWall) continue;
		const double xs[3] = { p.ax, p.bx, p.cx }, zs[3] = { p.az, p.bz, p.cz };
		for (int i = 0; i < 3; i++) {
			const int64_t k = Model::key2(std::llround(xs[i] * 2), std::llround(zs[i] * 2));
			auto it = at.find(k);
			if (it == at.end()) { at.emplace(k, vtx.size()); vtx.push_back({ xs[i], zs[i], { p.id } }); }
			else if (vtx[it->second].walls.back() != p.id) vtx[it->second].walls.push_back(p.id);
		}
	}
	const double R = m.radius;
	const int NANG = 36;
	std::atomic<size_t> next{ 0 };
	std::mutex mu;
	vector<V3> all;
	auto worker = [&]() {
		Scratch s;
		s.stamp.assign(m.polys.size(), 0);
		vector<V3> local;
		vector<int> walls;
		for (;;) {
			const size_t vi = next++;
			if (vi >= vtx.size()) break;
			const Vtx& v = vtx[vi];
			// A spot at (x, z) on the floor near y: a resting spot exactly there,
			// at least 0.5 into a wall, in bounds
			auto pocket = [&](double x, double z, double y) -> std::optional<V3> {
				x = F(x); z = F(z);
				auto st = standSpot(m, x, z, y);
				if (!st || st->x != x || st->z != z) return std::nullopt;
				wallsNear(m, *st, walls);
				if (depthInto(m, walls, *st) < 0.5) return std::nullopt;
				if (!m.isInBounds(s, *st, true)) return std::nullopt;
				return st;
			};
			// (cheap first: any pocket half the radius out, every 10 degrees)
			bool any = false;
			for (int k = 0; k < NANG && !any; k++) {
				const double a = k * 2 * PI / NANG, x = v.x + R / 2 * std::sin(a), z = v.z + R / 2 * std::cos(a);
				for (double y : m.floorsAt(F(x), F(z))) {
					// (only the corner's own walls touch him there)
					if (depthInto(m, v.walls, { x, y, z }) < 0.5) continue;
					if (pocket(x, z, y)) { any = true; break; }
				}
			}
			if (!any) continue;
			// the deepest per direction and floor
			for (int k = 0; k < NANG; k++) {
				const double a = k * 2 * PI / NANG, sa = std::sin(a), ca = std::cos(a);
				vector<double> done;
				for (double r = 0.5; r < R; r += 0.5) {
					const double x = v.x + r * sa, z = v.z + r * ca;
					for (double y : m.floorsAt(F(x), F(z))) {
						if (std::any_of(done.begin(), done.end(), [&](double d) { return std::fabs(d - y) < 3; })) continue;
						if (depthInto(m, v.walls, { x, y, z }) < 0.5) continue;
						if (auto st = pocket(x, z, y)) { local.push_back(*st); done.push_back(y); }
					}
				}
			}
		}
		std::lock_guard<std::mutex> g(mu);
		all.insert(all.end(), local.begin(), local.end());
	};
	{
		vector<std::thread> ts;
		for (int i = 0; i < std::max(1, threads); i++) ts.emplace_back(worker);
		for (auto& t : ts) t.join();
	}
	// (deterministic order, whatever the threads did)
	std::sort(all.begin(), all.end(), [](const V3& a, const V3& b) {
		return a.x != b.x ? a.x < b.x : a.z != b.z ? a.z < b.z : a.y < b.y;
	});
	all.erase(std::unique(all.begin(), all.end(), [](const V3& a, const V3& b) { return a.x == b.x && a.y == b.y && a.z == b.z; }), all.end());
	m.cornerSpots = std::move(all);
	for (size_t i = 0; i < m.cornerSpots.size(); i++) {
		const V3& p = m.cornerSpots[i];
		m.cornerGrid[Model::key2((int64_t)std::floor(p.x / m.cornerCell), (int64_t)std::floor(p.z / m.cornerCell))].push_back((int)i);
	}
}

void cornerSpotsNear(const Model& m, double x, double z, double floorY, double maxDist, vector<V3>& out) {
	if (m.cornerSpots.empty()) return;
	const int64_t x0 = (int64_t)std::floor((x - maxDist) / m.cornerCell), x1 = (int64_t)std::floor((x + maxDist) / m.cornerCell);
	const int64_t z0 = (int64_t)std::floor((z - maxDist) / m.cornerCell), z1 = (int64_t)std::floor((z + maxDist) / m.cornerCell);
	for (int64_t cx = x0; cx <= x1; cx++) {
		for (int64_t cz = z0; cz <= z1; cz++) {
			auto it = m.cornerGrid.find(Model::key2(cx, cz));
			if (it == m.cornerGrid.end()) continue;
			for (int i : it->second) {
				const V3& p = m.cornerSpots[i];
				if (std::fabs(p.y - floorY) <= 10 && sq(p.x - x) + sq(p.z - z) <= sq(maxDist)) out.push_back(p);
			}
		}
	}
}
