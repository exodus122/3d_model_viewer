#include "collision.h"
#include <memory>
#ifndef _MSC_VER
#include <pthread.h>
#endif

static void initPoly(Poly& p, int id, const int v[3][3], const int n[3], double d) {
	p.exists = true;
	p.id = id;
	p.ax = v[0][0]; p.ay = v[0][1]; p.az = v[0][2];
	p.bx = v[1][0]; p.by = v[1][1]; p.bz = v[1][2];
	p.cx = v[2][0]; p.cy = v[2][1]; p.cz = v[2][2];
	p.sx = n[0]; p.sy = n[1]; p.sz = n[2];
	p.nx = F(p.sx * NORMAL_FRAC); p.ny = F(p.sy * NORMAL_FRAC); p.nz = F(p.sz * NORMAL_FRAC);
	p.nXZ = F(std::sqrt(F(sq(p.nx) + sq(p.nz))));
	p.dist = d;
	p.nMag = F(std::sqrt(F(F(sq(p.nx) + sq(p.ny)) + sq(p.nz))));
	p.invNXZ = p.nXZ > 0 ? F(1 / p.nXZ) : 0;
	p.minX = std::min({ p.ax, p.bx, p.cx }); p.maxX = std::max({ p.ax, p.bx, p.cx });
	p.minY = std::min({ p.ay, p.by, p.cy }); p.maxY = std::max({ p.ay, p.by, p.cy });
	p.minZ = std::min({ p.az, p.bz, p.cz }); p.maxZ = std::max({ p.az, p.bz, p.cz });
	p.isFloor = p.sy > SNORMAL_FLOOR;
	p.isCeiling = p.sy < SNORMAL_CEIL;
	p.isWall = !p.isFloor && !p.isCeiling;
	p.sortY = (p.sy == 32767 || p.sy == -32767) ? p.ay : p.minY;
	p.tz = p.nXZ > 0 ? F(std::fabs(p.nz) * p.invNXZ) : 0;
	p.tx = p.nXZ > 0 ? F(std::fabs(p.nx) * p.invNXZ) : 0;
}

void Model::build(const vector<Tri>& tris, int numPolygons) {
	polys.assign(numPolygons, Poly{});
	numStatic = numPolygons;
	for (const Tri& t : tris) {
		initPoly(polys[t.id], t.id, t.v, t.n, t.d);
		// SurfaceType_GetExitIndex (>> 8 & 0x1F), SurfaceType_GetFloorProperty (>> 26 & 0xF)
		const uint32_t exitIndex = t.surf0 >> 8 & 0x1F, floorProp = t.surf0 >> 26 & 0xF;
		polys[t.id].loadOrVoid = exitIndex != 0 || floorProp == 5 || floorProp == 12 || floorProp == 13;
		polys[t.id].exitIndex = (int)exitIndex;
		polys[t.id].floorProp = (int)floorProp;
		polys[t.id].slide = (t.surf1 >> 4 & 3) == 1;
	}
	pairWalls = colCtx.subWalls;
	auto sorted = [&](const vector<int>& ids, bool walls) {
		vector<int> out;
		for (int id : ids) {
			const Poly& p = polys[id];
			if (!p.exists) continue;
			if (walls ? p.isWall : p.isFloor) out.push_back(id);
		}
		std::stable_sort(out.begin(), out.end(), [&](int a, int b) {
			if (polys[a].sortY != polys[b].sortY) return polys[a].sortY < polys[b].sortY;
			return a < b;
		});
		return out;
	};
	cellWallsL.resize(colCtx.subWalls.size());
	cellFloorsL.resize(colCtx.subWalls.size());
	for (size_t i = 0; i < colCtx.subWalls.size(); i++) {
		cellWallsL[i] = sorted(colCtx.subWalls[i], true);
		cellFloorsL[i] = sorted(colCtx.subFloors[i], false);
	}
	for (const Poly& p : polys) {
		if (!p.exists || !p.isFloor) continue;
		int64_t x0 = (int64_t)std::floor(p.minX / floorCell), x1 = (int64_t)std::floor(p.maxX / floorCell);
		int64_t z0 = (int64_t)std::floor(p.minZ / floorCell), z1 = (int64_t)std::floor(p.maxZ / floorCell);
		for (int64_t gx = x0; gx <= x1; gx++)
			for (int64_t gz = z0; gz <= z1; gz++) floorGrid[key2(gx, gz)].push_back(p.id);
	}
}

int Model::addBgActor(const string& name, const vector<DynaPolyIn>& in, const double center[3], double radius, double minY, double maxY) {
	BgActor bg;
	bg.name = name;
	bg.cx = center[0]; bg.cy = center[1]; bg.cz = center[2]; bg.r = radius;
	bg.minY = minY; bg.maxY = maxY;
	const int first = (int)polys.size();
	const int bgId = (int)bgActors.size();
	vector<int> cells;
	for (const DynaPolyIn& d : in) {
		Poly p;
		initPoly(p, (int)polys.size(), d.v, d.n, d.d);
		p.bg = bgId;
		// DynaPoly_ExpandSRT sorts on the float normal (newNormal.y > 0.5 /
		// < -0.8), which the export passes as `type`; the s16 one can be a
		// hair different.
		p.isFloor = d.type == 'f';
		p.isCeiling = d.type == 'c';
		p.isWall = d.type == 'w';
		polys.push_back(p);
		if (p.isWall) {
			dynaWalls.push_back(p.id);
			Tri t;
			t.id = p.id;
			memcpy(t.v, d.v, sizeof t.v);
			memcpy(t.n, d.n, sizeof t.n);
			t.d = d.d;
			cells.clear();
			subdivisionCellsOf(colCtx, t, cells);
			for (int c : cells) pairWalls[c].push_back(p.id);
		}
		if (p.isFloor) {
			int64_t x0 = (int64_t)std::floor(p.minX / floorCell), x1 = (int64_t)std::floor(p.maxX / floorCell);
			int64_t z0 = (int64_t)std::floor(p.minZ / floorCell), z1 = (int64_t)std::floor(p.maxZ / floorCell);
			for (int64_t gx = x0; gx <= x1; gx++)
				for (int64_t gz = z0; gz <= z1; gz++) floorGrid[key2(gx, gz)].push_back(p.id);
		}
	}
	// head insertion: the lists run from the last poly to the first
	for (int id = (int)polys.size() - 1; id >= first; id--) {
		if (polys[id].isWall) bg.walls.push_back(id);
		else if (polys[id].isFloor) bg.floors.push_back(id);
	}
	bgActors.push_back(bg);
	return first;
}

FloorList Model::floorsAt(double x, double z) const {
	FloorList out;
	auto it = floorGrid.find(key2((int64_t)std::floor(x / floorCell), (int64_t)std::floor(z / floorCell)));
	if (it == floorGrid.end()) return out;
	for (int id : it->second) {
		const Poly& p = polys[id];
		if (x < p.minX - 1 || x > p.maxX + 1 || z < p.minZ - 1 || z > p.maxZ + 1) continue;
		// static: CollisionPoly_CheckYIntersect (detMax 0); dynapoly:
		// CollisionPoly_CheckYIntersectApprox1 (Math3D_TriChkPointParaYIntersectDist, detMax 300)
		if (!triChkY(p, z, x, p.bg >= 0 ? 300 : 0, 1)) continue;
		out.push_back(F(F(F(F(-p.nx * x) - F(p.nz * z)) - p.dist) / p.ny));
	}
	return out;
}

const FloorList& Model::floorsNear(Scratch& s, double x, double z) const {
	int64_t kx = (int64_t)std::floor(x * 4 + 0.5), kz = (int64_t)std::floor(z * 4 + 0.5);
	int64_t k = key2(kx, kz);
	if (s.used > Scratch::CAP * 7 / 10) s.clearCache();
	uint64_t h = (uint64_t)k * 0x9E3779B97F4A7C15ull;
	int i = (int)(h >> 49);  // top 15 bits
	while (s.cacheGen[i] == s.gen) {
		if (s.cacheKey[i] == k) return s.cacheVal[i];
		i = (i + 1) & (Scratch::CAP - 1);
	}
	s.cacheGen[i] = s.gen;
	s.cacheKey[i] = k;
	s.cacheVal[i] = floorsAt(kx / 4.0, kz / 4.0);
	s.used++;
	return s.cacheVal[i];
}

// One wall's push in a Z (pass 0) or X (pass 1) pass: BgCheck_SphVsStaticWall and
// BgCheck_SphVsDynaWallInBgActor do the same per poly.
static inline bool wallPush(const Poly& p, int pass, double R, double sphY, double rx, double rz, const Tol& tol) {
	if (pass == 0) {
		if (p.tz < F(0.4)) return false;
		if (rz < F(p.minZ - R) || rz > F(p.maxZ + R)) return false;
		if (isZero(p.nz) || !triChkZ(p, rx, sphY, tol.detMax, tol.chkDist)) return false;
		double inter = F(F(F(F(-p.nx * rx) - F(p.ny * sphY)) - p.dist) / p.nz);
		double d = F(inter - rz);
		return std::fabs(d) <= F(R / p.tz) && F(d * p.nz) <= 4.0;
	}
	if (p.tx < F(0.4)) return false;
	if (rx < F(p.minX - R) || F(p.maxX + R) < rx) return false;
	if (isZero(p.nx) || !triChkX(p, sphY, rz, tol.detMax, tol.chkDist)) return false;
	double inter = F(F(F(F(-p.ny * sphY) - F(p.nz * rz)) - p.dist) / p.nx);
	double d = F(inter - rx);
	return std::fabs(d) <= F(R / p.tx) && F(d * p.nx) <= 4.0;
}

// The lineHit scratch for sphereStep's final line check (it has no Scratch
// of its own): one per thread, sized on first use, freed when the thread
// exits - each scan step starts new threads, and a Scratch is ~5 MB (its
// floor cache): never freed, an MM --all run leaked them until it ran out of
// memory. Not a thread_local object with a destructor: that's freed twice at
// thread exit in a static mingw build, so a pthread key's destructor there
// (MSVC has no pthreads, and its thread_local destructors work).
#ifdef _MSC_VER
static Scratch& lineScratch(size_t numPolys) {
	static thread_local std::unique_ptr<Scratch> s;
	if (!s) s = std::make_unique<Scratch>();
	if (s->stamp.size() < numPolys) s->stamp.assign(numPolys, 0);
	return *s;
}
#else
static Scratch& lineScratch(size_t numPolys) {
	static pthread_key_t key;
	static pthread_once_t once = PTHREAD_ONCE_INIT;
	pthread_once(&once, [] { pthread_key_create(&key, [](void* p) { delete static_cast<Scratch*>(p); }); });
	Scratch* s = static_cast<Scratch*>(pthread_getspecific(key));
	if (!s) { s = new Scratch(); pthread_setspecific(key, s); }
	if (s->stamp.size() < numPolys) s->stamp.assign(numPolys, 0);
	return *s;
}
#endif

V3 Model::sphereStep(const V3& pos, const Tol& tol, PushList* trace, const V3* prev, bool lineDyna) const {
	const double R = radius;
	const double sphY = F(pos.y + checkHeight);
	double rx = pos.x, rz = pos.z;
	// BgCheck_ComputeWallDisplacement
	auto push = [&](const Poly& p, int id, double pd) {
		double disp = F(F(R - pd) * p.invNXZ);
		V3 from = { rx, pos.y, rz };
		rx = F(rx + F(disp * p.nx));
		rz = F(rz + F(disp * p.nz));
		if (trace) trace->push_back({ id, from, { rx, pos.y, rz } });
	};

	// BgCheck_SphVsDynaWall: each bg actor in bgId order whose Y range and
	// bounding sphere (grown by the radius, as an s16) take the sphere centre;
	// all its walls' Z pushes, then all their X pushes (unsorted, no early out).
	bool dynaHit = false;
	if (!bgActors.empty()) {
		const double grow = (double)(int16_t)toI32(R); // TRUNCF_BINANG(radius)
		for (const BgActor& bg : bgActors) {
			if (bg.minY > sphY || bg.maxY < sphY) continue;
			const double r = (double)(int16_t)toI32(bg.r + grow);
			const double r2 = F(r * r);
			const double dx = F(bg.cx - rx), dz = F(bg.cz - rz);
			if (r2 < F(F(dx * dx) + F(dz * dz))) continue;
			const double dy = F(bg.cy - sphY);
			const bool xy = F(F(dx * dx) + F(dy * dy)) <= r2;  // Math3D_XYInSphere
			const bool yz = F(F(dy * dy) + F(dz * dz)) <= r2;  // Math3D_YZInSphere
			if (!xy && !yz) continue;
			for (int pass = 0; pass < 2; pass++) {
				for (int id : bg.walls) {
					const Poly& p = polys[id];
					double pd = planeDist(p, rx, sphY, rz);
					if (R < std::fabs(pd)) continue;
					if (wallPush(p, pass, R, sphY, rx, rz, tol)) { push(p, id, pd); dynaHit = true; }
				}
			}
		}
	}

	// BgCheck_SphVsStaticWall, in the subdivision of where the dynapolys left him
	const vector<int>& list = cellWalls(rx, pos.y, rz);
	bool staticHit = false;
	for (int pass = 0; pass < 2; pass++) {
		for (int id : list) {
			const Poly& p = polys[id];
			if (sphY < p.minY) break;
			double pd = planeDist(p, rx, sphY, rz);
			if (R < std::fabs(pd)) continue;
			if (wallPush(p, pass, R, sphY, rx, rz, tol)) { push(p, id, pd); staticHit = true; }
		}
	}

	// A dynapoly collision (a dynapoly push, or the line test's poly with no
	// static push after it): BgCheck_CheckLineImpl from posPrev to the result
	// against static walls, from their front only (BGCHECK_CHECK_ONE_FACE |
	// BGCHECK_CHECK_WALL, no BGCHECK_CHECK_DYNA), putting him the radius in
	// front of the first one crossed.
	if (dynaHit || (lineDyna && !staticHit)) {
		V3 from = prev ? *prev : V3{ pos.x, F(pos.y + GROUND_DROP), pos.z };
		V3 to = { rx, pos.y, rz };
		auto hit = lineHit(lineScratch(polys.size()), from, to, tol, false, true, false);
		if (hit) {
			const Poly& p = polys[hit->poly];
			if (!isZero(p.nXZ)) {
				double k = F(R * F(1 / p.nXZ));
				rx = F(F(k * p.nx) + hit->x);
				rz = F(F(k * p.nz) + hit->z);
				if (trace) trace->push_back({ hit->poly, to, { rx, pos.y, rz }, true });
			}
		}
	}
	return { rx, pos.y, rz };
}

// (Still means not moved at all: pushes under 0.01 used to count as still,
// but the game does push Link those last thousandths - e.g. out to exactly
// the radius from a wall's stored plane - and a start there isn't one he
// stays at: MM Treasure Chest Shop Deku, TRI 90, 0.0007-0.01 off.)
std::optional<V3> Model::restingSpot(const V3& pos) const {
	V3 cur = pos;
	for (int i = 0; i < 8; i++) {
		V3 next = sphereStep({ cur.x, F(pos.y - GROUND_DROP), cur.z }, LOOSE, nullptr);
		if (next.x == cur.x && next.z == cur.z) return cur;
		cur = { next.x, pos.y, next.z };
	}
	return std::nullopt;
}

std::optional<double> Model::floorCheck(double x, double z, double y, int* poly) const {
	auto best = staticFloorCheck(x, z, y, poly);
	if (bgActors.empty()) return best;
	// BgCheck_RaycastFloorDyna: each bg actor whose minY is under y and whose
	// bounding sphere takes (x, z) top down: its floors (detMax 300), then -
	// only while nothing, static or dynapoly, has been found yet - its walls
	// whose normal doesn't point down (flags 0x1C).
	for (const BgActor& bg : bgActors) {
		if (y < bg.minY) continue;
		const double dx = F(bg.cx - x), dz = F(bg.cz - z);
		if (!(F(F(dx * dx) + F(dz * dz)) <= F(bg.r * bg.r))) continue;
		auto scan = [&](const vector<int>& list, bool walls) {
			for (int id : list) {
				const Poly& p = polys[id];
				if (walls && p.sy < 0) continue;
				if (isZero(p.ny) || !triChkY(p, z, x, 300, 1)) continue;
				double yi = F(F(F(F(-p.nx * x) - F(p.nz * z)) - p.dist) / p.ny);
				if (yi < y && (!best || *best < yi)) { best = yi; if (poly) *poly = id; }
			}
		};
		scan(bg.floors, false);
		if (!best) scan(bg.walls, true);
	}
	return best;
}

std::optional<double> Model::staticFloorCheck(double x, double z, double y, int* poly) const {
	const double* mn = colCtx.minB;
	const double* mx = colCtx.maxB;
	if (x < mn[0] || x > mx[0] || z < mn[2] || z > mx[2]) return std::nullopt;
	for (double cy = y; cy >= mn[1]; cy = F(cy - colCtx.len[1])) {
		if (cy > mx[1]) continue;
		int idx = pointCell(colCtx, x, cy, z).index;
		std::optional<double> best;
		auto scan = [&](const vector<int>& list, bool walls) {
			for (int id : list) {
				const Poly& p = polys[id];
				if (y < p.minY) break;
				if (walls && p.sy < 0) continue;
				if (isZero(p.ny) || !triChkY(p, z, x, 0, 1)) continue;
				double yi = F(F(F(F(-p.nx * x) - F(p.nz * z)) - p.dist) / p.ny);
				if (yi < y && (!best || yi > *best)) { best = yi; if (poly) *poly = id; }
			}
		};
		scan(cellFloorsL[idx], false);
		scan(cellWallsL[idx], true);
		if (best) return best;
	}
	return std::nullopt;
}

std::optional<V3> Model::lineVsPoly(const Poly& p, const V3& a, const V3& b, double chkDist, bool oneFace) const {
	double planeA = F(F(F(F(F(p.sx * a.x) + F(p.sy * a.y)) + F(p.sz * a.z)) * NORMAL_FRAC) + p.dist);
	double planeB = F(F(F(F(F(p.sx * b.x) + F(p.sy * b.y)) + F(p.sz * b.z)) * NORMAL_FRAC) + p.dist);
	double delta = F(planeA - planeB);
	if ((planeA >= 0 && planeB >= 0) || (planeA < 0 && planeB < 0) || (oneFace && planeA < 0 && planeB > 0) ||
		isZero(delta)) return std::nullopt;
	double t = F(planeA / delta);
	V3 i = { F(F(F(b.x - a.x) * t) + a.x), F(F(F(b.y - a.y) * t) + a.y), F(F(F(b.z - a.z) * t) + a.z) };
	if ((std::fabs(p.nx) > 0.5 && !isZero(p.nx) && triChkX(p, i.y, i.z, 0, chkDist)) ||
		(std::fabs(p.ny) > 0.5 && !isZero(p.ny) && triChkY(p, i.z, i.x, 0, chkDist)) ||
		(std::fabs(p.nz) > 0.5 && !isZero(p.nz) && triChkZ(p, i.x, i.y, 0, chkDist))) return i;
	return std::nullopt;
}

std::optional<Hit> Model::lineHit(Scratch& s, const V3& a, const V3& b, const Tol& tol, bool floors, bool oneFace, bool dyna) const {
	CellIdx ia = pointCell(colCtx, a.x, a.y, a.z), ib = pointCell(colCtx, b.x, b.y, b.z);
	int cells[64];
	int nCells = 0;
	vector<int>& many = s.cellsBuf;
	many.clear();
	if (ia.index == ib.index) cells[nCells++] = ia.index;
	else {
		for (int sz = std::min(ia.sz, ib.sz); sz <= std::max(ia.sz, ib.sz); sz++)
			for (int sy = std::min(ia.sy, ib.sy); sy <= std::max(ia.sy, ib.sy); sy++)
				for (int sx = std::min(ia.sx, ib.sx); sx <= std::max(ia.sx, ib.sx); sx++)
					many.push_back(sz * colCtx.amt[0] * colCtx.amt[1] + sy * colCtx.amt[0] + sx);
	}
	uint32_t st = s.nextStamp();
	std::optional<Hit> best;
	double bestDistSq = 1.0e38;
	V3 end = b;
	auto scan = [&](const vector<int>& list) {
		for (int id : list) {
			if (s.stamp[id] == st) continue;
			s.stamp[id] = st;
			const Poly& p = polys[id];
			if (a.y < p.sortY && end.y < p.sortY) break;
			auto i = lineVsPoly(p, a, end, tol.lineChkDist, oneFace);
			if (!i) continue;
			double d = F(F(sq(F(a.x - i->x)) + sq(F(a.y - i->y))) + sq(F(a.z - i->z)));
			if (d < bestDistSq) {
				bestDistSq = d;
				best = Hit{ id, i->x, i->y, i->z };
				end = *i;
			}
		}
	};
	auto doCell = [&](int index) {
		if (floors) scan(cellFloorsL[index]);
		scan(cellWallsL[index]);
	};
	if (nCells) doCell(cells[0]);
	for (int index : many) doCell(index);
	if (!dyna) return best;
	// BgCheck_CheckLineAgainstDyna, on the line as far as the static test left
	// it: each bg actor whose Y range and bounding sphere (Math3D_LineVsSph)
	// the line touches, its walls then (floors) its floors, nearest hit to a.
	auto scanDyna = [&](const vector<int>& list) {
		for (int id : list) {
			auto i = lineVsPoly(polys[id], a, end, tol.lineChkDist, oneFace);
			if (!i) continue;
			double d = F(F(sq(F(a.x - i->x)) + sq(F(a.y - i->y))) + sq(F(a.z - i->z)));
			if (d < bestDistSq) {
				bestDistSq = d;
				best = Hit{ id, i->x, i->y, i->z };
				end = *i;
			}
		}
	};
	for (const BgActor& bg : bgActors) {
		if (a.y < bg.minY && end.y < bg.minY) continue;
		if (a.y > bg.maxY && end.y > bg.maxY) continue;
		if (!lineVsSphere(bg, a, end)) continue;
		scanDyna(bg.walls);
		if (floors) scanDyna(bg.floors);
	}
	return best;
}

// Math3D_LineVsSph on a bg actor's Sphere16
bool Model::lineVsSphere(const BgActor& bg, const V3& a, const V3& b) const {
	const double r2 = F(bg.r * bg.r);
	auto inSph = [&](const V3& p) {
		double dx = F(bg.cx - p.x), dy = F(bg.cy - p.y), dz = F(bg.cz - p.z);
		return F(F(F(dx * dx) + F(dy * dy)) + F(dz * dz)) <= r2;
	};
	if (inSph(a) || inSph(b)) return true;
	double lx = F(b.x - a.x), ly = F(b.y - a.y), lz = F(b.z - a.z);
	double len2 = F(F(F(lx * lx) + F(ly * ly)) + F(lz * lz));
	if (isZero(len2)) return false;
	double t = F(F(F(F(F(bg.cx - a.x) * lx) + F(F(bg.cy - a.y) * ly)) + F(F(bg.cz - a.z) * lz)) / len2);
	if (t < 0 || t > 1) return false;
	V3 q = { F(F(lx * t) + a.x), F(F(ly * t) + a.y), F(F(lz * t) + a.z) };
	return inSph(q);
}

const vector<int>& Model::wallsAlong(Scratch& s, const V3& a, const V3& b) const {
	int steps = std::max(1, (int)std::ceil(std::hypot(b.x - a.x, b.z - a.z) / 40));
	if (steps == 1) {
		int ia = pointCell(colCtx, a.x, a.y, a.z).index, ib = pointCell(colCtx, b.x, a.y, b.z).index;
		if (ia == ib) return cellWallsL[ia];
	}
	vector<int>& out = s.wallsBuf;
	out.clear();
	uint32_t st = s.nextStamp();
	for (int k = 0; k <= steps; k++) {
		double t = (double)k / steps;
		for (int id : cellWalls(a.x + (b.x - a.x) * t, a.y, a.z + (b.z - a.z) * t)) {
			if (s.stamp[id] == st) continue;
			s.stamp[id] = st;
			out.push_back(id);
		}
	}
	return out;
}

int Model::crossedWall(Scratch& s, const V3& a, const V3& b, bool exiting) const {
	double y = a.y + checkHeight;
	int best = -1;
	double bestT = INFINITY;
	auto test = [&](int id) {
		const Poly& p = polys[id];
		if (y < p.minY || y > p.maxY) return;
		double dA = planeDist(p, a.x, y, a.z), dB = planeDist(p, b.x, y, b.z);
		if (exiting) { dA = -dA; dB = -dB; }
		if (!(dA > 0 && dB < 0)) return;
		double t = dA / (dA - dB);
		if (t >= bestT) return;
		double ix = a.x + (b.x - a.x) * t, iz = a.z + (b.z - a.z) * t;
		if (pointInTri3D(p, ix, y, iz, 0.25)) { best = id; bestT = t; }
	};
	for (int id : wallsAlong(s, a, b)) test(id);
	if (!dynaWalls.empty()) {
		const double x0 = std::min(a.x, b.x), x1 = std::max(a.x, b.x), z0 = std::min(a.z, b.z), z1 = std::max(a.z, b.z);
		for (int id : dynaWalls) {
			const Poly& p = polys[id];
			if (p.maxX < x0 || p.minX > x1 || p.maxZ < z0 || p.minZ > z1) continue;
			test(id);
		}
	}
	return best;
}

bool Model::behindWall(const V3& pos) const {
	double y = pos.y + checkHeight;
	auto inside = [&](const Poly& p) {
		if (y < p.minY || y > p.maxY) return false;
		double d = planeDist(p, pos.x, y, pos.z);
		if (!(d < 0 && d > -2 * radius)) return false;
		double k = d / p.nMag;
		return pointInTri3D(p, pos.x - k * p.nx, y - k * p.ny, pos.z - k * p.nz, 0);
	};
	for (int id : cellWalls(pos.x, pos.y, pos.z)) if (inside(polys[id])) return true;
	const double reach = 2 * radius;
	for (int id : dynaWalls) {
		const Poly& p = polys[id];
		if (pos.x < p.minX - reach || pos.x > p.maxX + reach || pos.z < p.minZ - reach || pos.z > p.maxZ + reach) continue;
		if (inside(p)) return true;
	}
	return false;
}

bool Model::behindPoly(const Poly& p, const V3& pos) const {
	double y = pos.y + checkHeight;
	if (y < p.minY || y > p.maxY) return false;
	double d = planeDist(p, pos.x, y, pos.z);
	if (!(d < 0)) return false;
	double k = d / p.nMag;
	return pointInTri3D(p, pos.x - k * p.nx, y - k * p.ny, pos.z - k * p.nz, 0.25);
}

bool Model::isInBounds(Scratch& s, const V3& pos, bool floorsBlock) const {
	if (behindWall(pos)) return false;
	double y = F(pos.y + checkHeight);
	const double len = 400;
	for (int i = 0; i < 8; i++) {
		double ang = i * PI / 4;
		V3 a = { pos.x, y, pos.z };
		V3 b = { F(pos.x + std::sin(ang) * len), y, F(pos.z + std::cos(ang) * len) };
		auto hit = lineHit(s, a, b, STRICT, false);
		if (!hit || planeDist(polys[hit->poly], a.x, a.y, a.z) >= 0) continue;
		// floorsBlock: a ray into the ground from above first says nothing (it
		// has gone under the slope Link is on). Into a floor's underside it's
		// under the ground to begin with: out of bounds. Only this ray is
		// checked again with floors: otherwise floors can't change its answer,
		// and they make the test several times slower
		if (floorsBlock) {
			auto fh = lineHit(s, a, b, STRICT, true);
			if (fh && polys[fh->poly].isFloor && planeDist(polys[fh->poly], a.x, a.y, a.z) >= 0) continue;
		}
		return false;
	}
	return true;
}

static const double WALK_STEP = 10, WALK_RADIUS = 600;

static const double WALK_SHORTCUT_MIN = 150;
bool Model::walkUnreachable(Scratch& s, const V3& end, const V3& from) const {
	auto q5 = [](double v) { return (uint64_t)(int64_t)std::floor(v / 5) & 0xFFFF; };
	const uint64_t key = q5(end.x) | q5(end.y) << 16 | q5(end.z) << 32 | (q5(from.x) ^ q5(from.z) * 31) << 48;
	auto it = s.unreachable.find(key);
	if (it != s.unreachable.end()) return it->second;
	if (s.unreachable.size() > 200000) s.unreachable.clear();
	const double walk = walkDistance(s, end, from);
	const double straight = std::hypot(end.x - from.x, end.z - from.z);
	const bool counts = walk < 0 || (walk >= straight + WALK_SHORTCUT_MIN && walk >= 2 * straight);
	s.unreachable.emplace(key, counts);
	return counts;
}

double Model::walkShortcut(Scratch& s, const V3& end, const V3& from) const {
	const double walk = walkDistance(s, end, from);
	const double straight = std::hypot(end.x - from.x, end.z - from.z);
	if (walk < 0) return -1;
	return walk >= straight + WALK_SHORTCUT_MIN && walk >= 2 * straight ? walk : 0;
}

double Model::walkDistance(Scratch& s, const V3& end, const V3& from) const {
	auto q5 = [](double v) { return (uint64_t)(int64_t)std::floor(v / 5) & 0xFFFF; };
	auto cellOf = [](double v) { return (int64_t)std::floor(v / WALK_STEP); };
	// The whole fill from this start spot, done once (Scratch::walkFills)
	const uint64_t fillKey = q5(from.x) | q5(from.z) << 16 | (uint64_t)((int64_t)std::floor(from.y / 5) & 0xFFFF) << 32;
	// reached: a filled point within a step of the end (xz) and 30 of its height;
	// the walking distance: the nearest such point's
	auto nearEnd = [&](double x, double z, double y) {
		return std::hypot(x - end.x, z - end.z) <= WALK_STEP && std::fabs(y - end.y) < 30;
	};
	auto fit = s.walkFills.find(fillKey);
	if (fit == s.walkFills.end()) {
		// A flood fill from `from` (breadth first: each point's step count is its
		// shortest walk): a step to a neighbouring grid point is walkable if no wall
		// (either face, dynapolys too) is in the way 50 above the floor and there's
		// a floor there at most 50 up (small steps) or any way down (drops, up to
		// 300). The whole fill is kept for the next end from this spot.
		auto fill = std::make_shared<Scratch::WalkFill>();
		struct Node { int i, j; double y; int d; };
		std::set<std::tuple<int, int, int>> seen;
		vector<Node> todo = { { 0, 0, from.y, 0 } };
		seen.insert({ 0, 0, (int)std::floor(from.y / 30) });
		const int R = (int)(WALK_RADIUS / WALK_STEP);
		// (a point's cell is its step from the start's, give or take 1 for rounding)
		const int half = R + 2;
		fill->bx = cellOf(from.x); fill->bz = cellOf(from.z); fill->n = 2 * half + 1;
		vector<std::pair<uint32_t, std::array<float, 4>>> cellPts;
		for (size_t k = 0; k < todo.size(); k++) {
			const Node p = todo[k];
			const double px = from.x + p.i * WALK_STEP, pz = from.z + p.j * WALK_STEP;
			const int64_t ci = cellOf(px) - fill->bx + half, cj = cellOf(pz) - fill->bz + half;
			if (ci >= 0 && ci < fill->n && cj >= 0 && cj < fill->n)
				cellPts.push_back({ (uint32_t)(ci * fill->n + cj), { (float)px, (float)pz, (float)p.y, (float)(p.d * WALK_STEP) } });
			if (p.i * p.i + p.j * p.j >= R * R) continue;
			for (int di = -1; di <= 1; di++) for (int dj = -1; dj <= 1; dj++) {
				if (!di && !dj) continue;
				const int qi = p.i + di, qj = p.j + dj;
				const double qx = from.x + qi * WALK_STEP, qz = from.z + qj * WALK_STEP;
				const double h = F(p.y + 50);
				if (lineHit(s, { px, h, pz }, { qx, h, qz }, LOOSE, false, false, true)) continue;
				auto fy = floorCheck(qx, qz, h);
				if (!fy || *fy < p.y - 300) continue;
				if (!seen.insert({ qi, qj, (int)std::floor(*fy / 30) }).second) continue;
				todo.push_back({ qi, qj, *fy, p.d + 1 });
			}
		}
		// (by cell, each cell's points in fill order, as the map's vectors had them)
		std::stable_sort(cellPts.begin(), cellPts.end(), [](const auto& a, const auto& b) { return a.first < b.first; });
		fill->first.assign((size_t)fill->n * fill->n + 1, 0);
		for (const auto& cp : cellPts) fill->first[cp.first + 1]++;
		for (size_t c = 1; c < fill->first.size(); c++) fill->first[c] += fill->first[c - 1];
		fill->pts.reserve(cellPts.size());
		for (const auto& cp : cellPts) fill->pts.push_back(cp.second);
		// (at most 2M points a thread, 32 MB: as many fills as fit, 257 at most as before)
		if (s.walkFills.size() > 256 || s.walkFillPts + fill->pts.size() > (2u << 20)) { s.walkFills.clear(); s.walkFillPts = 0; }
		s.walkFillPts += fill->pts.size();
		fit = s.walkFills.emplace(fillKey, std::move(fill)).first;
	}
	const Scratch::WalkFill& fill = *fit->second;
	double best = -1;
	for (int di = -1; di <= 1; di++) for (int dj = -1; dj <= 1; dj++) {
		const int64_t ci = cellOf(end.x + di * WALK_STEP) - fill.bx + (fill.n / 2), cj = cellOf(end.z + dj * WALK_STEP) - fill.bz + (fill.n / 2);
		if (ci < 0 || ci >= fill.n || cj < 0 || cj >= fill.n) continue;
		const size_t c = (size_t)(ci * fill.n + cj);
		for (uint32_t k = fill.first[c]; k < fill.first[c + 1]; k++) {
			const auto& q = fill.pts[k];
			if (nearEnd(q[0], q[1], q[2]) && (best < 0 || q[3] < best)) best = q[3];
		}
	}
	return best;
}

vector<V3> Model::walkPath(Scratch& s, const V3& from, const V3& end) const {
	// (walkUnreachable's fill, the same steps, with each point's parent)
	struct Node { int i, j; double y; int parent; };
	std::set<std::tuple<int, int, int>> seen;
	vector<Node> todo = { { 0, 0, from.y, -1 } };
	seen.insert({ 0, 0, (int)std::floor(from.y / 30) });
	const int R = (int)(WALK_RADIUS / WALK_STEP);
	for (size_t k = 0; k < todo.size(); k++) {
		const Node p = todo[k];
		const double px = from.x + p.i * WALK_STEP, pz = from.z + p.j * WALK_STEP;
		if (std::hypot(px - end.x, pz - end.z) <= WALK_STEP && std::fabs(p.y - end.y) < 30) {
			vector<V3> path;
			for (int n = (int)k; n >= 0; n = todo[n].parent)
				path.push_back({ from.x + todo[n].i * WALK_STEP, todo[n].y, from.z + todo[n].j * WALK_STEP });
			std::reverse(path.begin(), path.end());
			return path;
		}
		if (p.i * p.i + p.j * p.j >= R * R) continue;
		for (int di = -1; di <= 1; di++) for (int dj = -1; dj <= 1; dj++) {
			if (!di && !dj) continue;
			const int qi = p.i + di, qj = p.j + dj;
			const double qx = from.x + qi * WALK_STEP, qz = from.z + qj * WALK_STEP;
			const double h = F(p.y + 50);
			if (lineHit(s, { px, h, pz }, { qx, h, qz }, LOOSE, false, false, true)) continue;
			auto fy = floorCheck(qx, qz, h);
			if (!fy || *fy < p.y - 300) continue;
			if (!seen.insert({ qi, qj, (int)std::floor(*fy / 30) }).second) continue;
			todo.push_back({ qi, qj, *fy, (int)k });
		}
	}
	return {};
}
