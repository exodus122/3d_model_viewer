#include "reach.h"
#include "ground.h"
#include "slope.h"
#include "corners.h"

// wall_push_clips.js reachability: the lowest speed Link can do clip `c` at,
// from a standable in-bounds start one frame's move away (32 directions, every
// REACH_STEP up to REACH_DIST). Crossings: the game's move at that yaw and
// speed (0.5 past the plane) has to hit the pusher and clip through the same
// wall. Standing points: unlike the JS (which only checks the line), the frame
// is run too - the move at that yaw and speed has to clip through the same
// wall and end out of bounds - so the speed is one that works exactly.
void reachability(const Model& m, Scratch& s, Clip& c) {
	const double REACH_STEP = 1;
	// a slope / ground clip's move is its reach already (slopeFrame, groundFrame)
	if (c.kind >= 2) return;
	c.reachDone = true;
	const double floorRef = c.hasFloorY ? c.floorY : c.from.y;
	const V3 P = c.from;
	const double over = c.cross ? 0.5 : 0;
	std::set<std::pair<double, double>> tried;
	bool have = false;
	// (Link standing partly inside a convex wall corner too, after the 32
	// directions: corners.h)
	vector<V3> corner;
	cornerSpotsNear(m, P.x, P.z, floorRef, REACH_DIST, corner);
	for (int i = 0; i <= 32; i++) {
		double ang = i / 32.0 * 2 * PI;
		const size_t nd = i < 32 ? (size_t)(REACH_DIST / REACH_STEP) : corner.size();
		for (size_t di = 0; di < nd; di++) {
			std::optional<V3> startO;
			if (i < 32) {
				const double d = (di + 1) * REACH_STEP;
				if (have && (d + over) / SPEED_RATE >= c.reachSpeed + 2) break;
				startO = standSpot(m, F(P.x - d * std::sin(ang)), F(P.z - d * std::cos(ang)), floorRef);
			} else startO = corner[di];
			if (!startO) continue;
			V3 start = *startO;
			if (!tried.insert({ start.x, start.z }).second) continue;
			double vx = P.x - start.x, vz = P.z - start.z, len = std::hypot(vx, vz);
			if (len < 0.01 || len > REACH_DIST) continue;
			double speed = F((len + over) / SPEED_RATE);
			if (have && speed >= c.reachSpeed) continue;
			int yaw = yawOf(vx, vz);
			V3 next = moveStep(start, yaw, speed);
			if (c.drop > 0) next.y = P.y;
			// (moving, a drop with checkHeight + dy < 5 gets the feet-level line
			// test that stops him on his floor: see crossingPointsForWall)
			if (feetLine(m.checkHeight, F(next.y - start.y))) continue;
			if (c.cross) {
				auto f = lineFrame(m, s, start, next, LOOSE);
				if (!f || f->hit.poly != c.pusher) continue;
				const Move mv{ yaw, speed };
				auto clip = clipFromFrame(m, s, start, f->res, f->trace, LOOSE, c.drop > 0 ? NAN : start.y, &mv);
				if (!clip || clip->crossed != c.crossed) continue;
				bool noFloor;
				if (c.drop > 0 ? !landing(m, s, f->res, floorRef, noFloor, clip->crossed, &start) : !m.endCounts(s, clip->crossed, clip->end, &start)) continue;
			} else {
				// nothing in the way, then the frame's pushes clip through the same wall
				if (lineFrame(m, s, start, next, LOOSE)) continue;
				PushList tr;
				V3 res = m.sphereStep(next, LOOSE, &tr, &start);
				const Move mv{ yaw, speed };
				auto clip = clipFromFrame(m, s, start, res, tr, LOOSE, c.drop > 0 ? NAN : start.y, &mv);
				if (!clip || clip->crossed != c.crossed) continue;
				bool noFloor;
				if (c.drop > 0 ? !landing(m, s, res, floorRef, noFloor, clip->crossed, &start) : !m.endCounts(s, clip->crossed, clip->end, &start)) continue;
			}
			if (!m.isInBounds(s, start, true)) continue;
			have = true;
			c.hasReach = true;
			c.reachSpeed = speed;
			c.reachYaw = yaw;
			c.reachStart = start;
		}
	}
}

FrameSpec FRAME_SPEC;

bool inFrameSpec(const Clip& c) {
	switch (FRAME_SPEC.type) {
	case 0: return c.kind < 2 && c.drop == 0;
	case 1: return c.kind < 2 && c.drop > 0;
	default: return c.kind == FRAME_SPEC.type;
	}
}

double fallOf(const Clip& c) {
	return c.hasNext ? F(c.prev.y - c.next.y) : (double)c.drop;
}

int chooseFrameSpec(const vector<Clip>& clips, int want, double drop, double checkHeight) {
	FrameSpec sp;
	auto has = [&](int type) {
		FrameSpec keep = FRAME_SPEC;
		FRAME_SPEC.type = type;
		bool any = std::any_of(clips.begin(), clips.end(), inFrameSpec);
		FRAME_SPEC = keep;
		return any;
	};
	if (want >= 0) {
		if (!has(want)) return 1;
		sp.type = want;
	} else {
		sp.type = -1;
		for (int t : { 0, 2, 3, 1 }) if (has(t)) { sp.type = t; break; }
		if (sp.type < 0) return 1;
	}
	// still a wall push: checkHeight + dy >= 5 (else the line test runs at the feet)
	auto pushable = [&](double d) { return F(checkHeight - d) >= 5; };
	if (sp.type == 1) {
		// the smallest real fall (the least y velocity), or the one asked for
		sp.drop = drop;
		sp.autoDrop = drop <= 0;
		if (drop <= 0) {
			sp.drop = INFINITY;
			for (const Clip& c : clips) {
				const double d = fallOf(c);
				if (c.kind < 2 && c.drop > 0 && pushable(d)) sp.drop = std::min(sp.drop, d);
			}
		}
		if (!(sp.drop < INFINITY) || !pushable(sp.drop)) { FRAME_SPEC = sp; return 2; }
	}
	if (sp.type == 3) {
		sp.vy = GROUND_VYS[0];
		for (const Clip& c : clips) if (c.kind == 3) { sp.vy = c.vy; break; }
	}
	FRAME_SPEC = sp;
	return 0;
}

// One frame of FRAME_SPEC's kind from a standing start at yaw / speed: does
// it do this pair's clip, leaving him somewhere that counts? Where he ends
// up, or none. Walking / falling: TRI pusher pushes Link through TRI crossed
// (line test, pushes, floor check or the fall, two more frames: the scan's
// own checks). Slope / ground: slopeFrame / groundFrame through TRI crossed,
// starting on (slope: lifted by) TRI pusher.
static std::optional<V3> walkFrameClips(const Model& m, Scratch& s, const V3& start, int yaw, double speed,
	int pusher, int crossed) {
	const FrameSpec& spec = FRAME_SPEC;
	if (spec.type == 2 || spec.type == 3) {
		auto c = spec.type == 2 ? slopeFrame(m, s, start, yaw, speed, crossed) : groundFrame(m, s, start, yaw, speed, spec.vy, crossed);
		if (!c || c->pusher != pusher) return std::nullopt;
		return c->end;
	}
	V3 next = moveStep(start, yaw, speed);
	const bool falling = spec.type == 1;
	if (falling) {
		next.y = F(start.y - spec.drop);
		// (checkHeight + dy < 5: the line test at the feet stops him on his floor)
		if (feetLine(m.checkHeight, F(next.y - start.y))) return std::nullopt;
	}
	V3 res;
	PushList trace;
	auto f = lineFrame(m, s, start, next, LOOSE);
	if (f) { res = f->res; trace = f->trace; }
	else res = m.sphereStep(next, LOOSE, &trace, &start);
	const Move mv{ yaw, speed };
	auto clip = clipFromFrame(m, s, start, res, trace, LOOSE, falling ? NAN : start.y, &mv);
	if (!clip || clip->crossed != crossed || clip->pusher != pusher) return std::nullopt;
	if (falling) {
		bool noFloor;
		return landing(m, s, res, start.y, noFloor, clip->crossed, &start);
	}
	if (!m.endCounts(s, clip->crossed, clip->end, &start)) return std::nullopt;
	return clip->end;
}


// Clips at this speed and at every 0.0025 up to 0.01 more: not a single-f32
// coincidence (e.g. posNext landing exactly on a wall's plane, which the
// one-face line test then counts from behind). Speeds over `top` (the most
// allowed) aren't checked: a clip that works from a speed up to the top but
// stops a little past it (MM Treasure Chest Shop Deku 50 -> 90 at 0xFED0,
// x -239.5883 z 824.1: 9.938 to 9.950, top 9.94054) still counts.
static bool robustClip(const Model& m, Scratch& s, const V3& S, int yaw, double sp, int pusher, int crossed, double top) {
	for (int k = 0; k <= 4; k++) {
		const double v = F(sp + k * 0.0025);
		if (k > 0 && v > top) break;
		if (!walkFrameClips(m, s, S, yaw, v, pusher, crossed)) return false;
	}
	return true;
}

// The lowest robustly clipping speed from S at one yaw, in [lower, limit):
// every 0.02, then bisected to the f32 boundary. 0 if none.
static double minSpeedAtYaw(const Model& m, Scratch& s, const V3& S, int yaw, int pusher, int crossed,
	double lower, double limit) {
	double prevFail = std::max(0.0, lower - 0.02);
	// (the last try is the top speed itself, the f32 just under limit: a
	// start whose lowest speed is between the last 0.02 step and limit used
	// to count as not clipping at all)
	const double top = std::nextafter((float)limit, 0.0f);
	for (double sp = std::max(0.02, lower); prevFail < top; sp += 0.02) {
		if (sp >= limit) sp = top;
		// (the plain check first: most speeds don't clip at all)
		if (!walkFrameClips(m, s, S, yaw, F(sp), pusher, crossed) || !robustClip(m, s, S, yaw, F(sp), pusher, crossed, top)) {
			prevFail = sp;
			continue;
		}
		double a = prevFail, b = F(sp);
		for (int k = 0; k < 40; k++) {
			double mid = F((a + b) / 2);
			if (mid <= a || mid >= b) break;
			if (robustClip(m, s, S, yaw, mid, pusher, crossed, top)) b = mid; else a = mid;
		}
		return b;
	}
	return 0.0;
}

// --angles: from the refined start, every one of the 4096 directions the sine
// table tells apart (yaw >> 4): its lowest robust speed up to REACH_DIST / 1.5, and whether
// the refined speed works there. Printed as runs of neighbouring yaws.
void angleRanges(const Model& m, const Refined& r, int pusher, int crossed, int threads) {
	vector<double> minSp(4096, 0);
	vector<char> atRefined(4096, 0);
	std::atomic<int> next{ 0 };
	auto work = [&]() {
		Scratch s;
		s.stamp.assign(m.polys.size(), 0);
		for (int c; (c = next++) < 4096;) {
			int yaw = c << 4;
			minSp[c] = minSpeedAtYaw(m, s, r.start, yaw, pusher, crossed, 0, REACH_DIST / SPEED_RATE);
			atRefined[c] = walkFrameClips(m, s, r.start, yaw, r.speed, pusher, crossed).has_value();
		}
	};
	vector<std::thread> ts;
	for (int t = 0; t < threads; t++) ts.emplace_back(work);
	for (auto& t : ts) t.join();
	auto run = [&](const char* title, auto pred, bool withMin) {
		printf("%s\n", title);
		// start the scan at a class that doesn't match, so a run through 0 isn't split
		int s0 = 0;
		while (s0 < 4096 && pred(s0)) s0++;
		if (s0 == 4096) { printf("  all yaws\n"); return; }
		bool any = false;
		for (int k = 1; k <= 4096; k++) {
			int c = (s0 + k) & 0xFFF;
			if (!pred(c)) continue;
			int first = c, n = 0;
			double lo = 1e9;
			int loYaw = 0;
			while (pred((first + n) & 0xFFF)) {
				int cc = (first + n) & 0xFFF;
				if (minSp[cc] > 0 && minSp[cc] < lo) { lo = minSp[cc]; loYaw = cc << 4; }
				n++;
			}
			int last = (first + n - 1) & 0xFFF;
			printf("  0x%04X - 0x%04X  (%d directions)", first << 4, (last << 4) | 0xF, n);
			if (withMin) printf("  lowest speed %.9g at 0x%04X", lo, loYaw);
			printf("\n");
			any = true;
			k += n - 1;
		}
		if (!any) printf("  none\n");
	};
	printf("From start %.9g, %.9g, %.9g (TRI %d -> %d); yaws that differ only in the low 4 bits move the same:\n",
		r.start.x, r.start.y, r.start.z, pusher, crossed);
	char title[128];
	snprintf(title, sizeof title, "Yaws that clip at speed %.9g:", r.speed);
	run(title, [&](int c) { return atRefined[c] != 0; }, false);
	snprintf(title, sizeof title, "Yaws that clip at some speed up to %g (with the lowest speed in each run):", REACH_DIST / SPEED_RATE);
	run(title, [&](int c) { return minSp[c] > 0; }, true);
	printf("Lowest speed per direction where it clips (runs of the same speed merged):\n");
	for (int c = 0; c < 4096;) {
		if (minSp[c] <= 0) { c++; continue; }
		int e = c;
		while (e + 1 < 4096 && minSp[e + 1] == minSp[c]) e++;
		printf("  0x%04X - 0x%04X: %.9g%s\n", c << 4, (e << 4) | 0xF, minSp[c], atRefined[c] ? "" : "  (not at that speed)");
		c = e + 1;
	}
}

// --refine: the lowest walking speed for one wall pair, searched finer than
// the scan's grid. Starts: every standable in-bounds resting spot on a 0.25
// grid within 24 of the scan's best start, nearest to the clip points first
// (a start can't do better than its distance to them / 1.5). Yaws: toward
// the clip points, every 8, then every 1 around the best. Speeds: every 0.02
// up to the best so far, and at the first that clips, bisected down to the
// f32 boundary. Returns the best found.
Refined refineMinSpeed(const Model& m, const vector<Clip>& clips, int pusher, int crossed, int threads) {
	Refined best;
	// The seed: the slowest move of the pair's clips of FRAME_SPEC's kind that
	// does it in this frame - their --min-speed reaches and the scan's own
	// moves (reachability can miss a clip: OoT Kakariko child, falling, TRI
	// 141 -> 21 has none). Each is checked: a slope clip's reach is the faster
	// of its two frames, and a falling one falls from its own start (OoT
	// Kakariko child 142 -> 673: the best reach falls 20.8, not the 14.93
	// being refined). None that works: the bound is the fastest move there is,
	// from the slowest candidate (much slower).
	// Falling without --drop (autoDrop): each candidate at its own fall (from
	// its start to its posNext), if that's still a wall push, and the refine is
	// at the fall of the slowest one that works - the lowest speed is the
	// point, and a smallest-fall default can need speed 30 (Kakariko 142 ->
	// 673: 14.93 needs 30.74; searching up to there took over 10 minutes).
	struct Seed { double speed; int yaw; V3 start; double fall; };
	vector<Seed> cands;
	for (const Clip& c : clips) {
		if (!inFrameSpec(c)) continue;
		if (c.hasReach) cands.push_back({ c.reachSpeed, c.reachYaw, c.reachStart, F(c.reachStart.y - c.from.y) });
		if (c.hasMove && c.hasNext) cands.push_back({ c.speed, c.yaw, c.prev, F(c.prev.y - c.next.y) });
	}
	const bool autoDrop = FRAME_SPEC.type == 1 && FRAME_SPEC.autoDrop;
	if (autoDrop)
		cands.erase(std::remove_if(cands.begin(), cands.end(), [&](const Seed& c) { return !(c.fall > 0 && F(m.checkHeight - c.fall) >= 5); }), cands.end());
	if (cands.empty()) return best;
	std::stable_sort(cands.begin(), cands.end(), [](const Seed& a, const Seed& b) { return a.speed < b.speed; });
	best.speed = cands[0].speed;
	best.yaw = cands[0].yaw;
	best.start = cands[0].start;
	{
		Scratch s;
		s.stamp.assign(m.polys.size(), 0);
		const double chosenDrop = FRAME_SPEC.drop;
		// (none works: back to the smallest fall chooseFrameSpec picked)
		auto restore = [&]() { if (autoDrop && !best.found) FRAME_SPEC.drop = chosenDrop; };
		for (const Seed& c : cands) {
			if (autoDrop) FRAME_SPEC.drop = c.fall;
			if (!walkFrameClips(m, s, c.start, c.yaw, c.speed, pusher, crossed)) continue;
			best.found = true;
			best.speed = c.speed; best.yaw = c.yaw; best.start = c.start;
			break;
		}
		restore();
		if (!best.found) best.speed = F(REACH_DIST / SPEED_RATE);
	}
	vector<V3> targets;
	for (const Clip& c : clips) if (inFrameSpec(c)) targets.push_back(c.from);
	auto nearest = [&](const V3& p) {
		double d = 1e9;
		for (const V3& t : targets) d = std::min(d, std::hypot(t.x - p.x, t.z - p.z));
		return d;
	};
	// candidate starts
	vector<std::pair<double, V3>> starts;
	{
		Scratch s;
		s.stamp.assign(m.polys.size(), 0);
		std::set<std::pair<float, float>> seen;
		const V3 B = best.start;
		for (double dx = -24; dx <= 24; dx += 0.25) {
			for (double dz = -24; dz <= 24; dz += 0.25) {
				if (dx * dx + dz * dz > 24 * 24) continue;
				auto st = standSpot(m, F(B.x + dx), F(B.z + dz), B.y);
				if (!st || !seen.insert({ (float)st->x, (float)st->z }).second) continue;
				if (!m.isInBounds(s, *st, true)) continue;
				starts.push_back({ nearest(*st), *st });
			}
		}
	}
	std::sort(starts.begin(), starts.end(), [](const auto& a, const auto& b) { return a.first < b.first; });
	std::mutex mu;
	std::atomic<size_t> next{ 0 }, done{ 0 };
	auto bestSpeed = [&]() { std::lock_guard<std::mutex> g(mu); return best.speed; };
	auto work = [&]() {
		Scratch s;
		s.stamp.assign(m.polys.size(), 0);
		for (size_t i; (i = next++) < starts.size();) {
			const V3 S = starts[i].second;
			done++;
			// (nearest clip point minus 2 units of slack: can't clip slower)
			double lower = std::max(0.0, (starts[i].first - 2) / SPEED_RATE);
			if (lower >= bestSpeed()) continue;
			// yaws toward the clip points within reach
			int lo = INT32_MAX, hi = INT32_MIN;
			int center = -1;
			for (const V3& t : targets) {
				double dx = t.x - S.x, dz = t.z - S.z;
				if (std::hypot(dx, dz) > bestSpeed() * SPEED_RATE + 2) continue;
				int y = yawOf(dx, dz);
				if (center < 0) center = y;
				int rel = (int16_t)(uint16_t)(y - center);
				lo = std::min(lo, rel);
				hi = std::max(hi, rel);
			}
			if (center < 0) continue;
			auto minAtYaw = [&](int yaw, double limit) { return minSpeedAtYaw(m, s, S, yaw, pusher, crossed, lower, limit); };
			double myBest = 0;
			int myYaw = 0;
			for (int rel = lo - 0x100; rel <= hi + 0x100; rel += 8) {
				int yaw = (center + rel) & 0xFFFF;
				double sp = minAtYaw(yaw, myBest ? myBest : bestSpeed());
				if (sp > 0 && (!myBest || sp < myBest)) { myBest = sp; myYaw = yaw; }
			}
			if (!myBest) continue;
			for (int d = -8; d <= 8; d++) {
				int yaw = (myYaw + d) & 0xFFFF;
				double sp = minAtYaw(yaw, myBest);
				if (sp > 0 && sp < myBest) { myBest = sp; myYaw = yaw; }
			}
			std::lock_guard<std::mutex> g(mu);
			if (myBest < best.speed || (!best.found && myBest <= best.speed)) {
				best.found = true;
				best.speed = myBest;
				best.yaw = myYaw;
				best.start = S;
			}
		}
	};
	vector<std::thread> ts;
	for (int t = 0; t < threads; t++) ts.emplace_back(work);
	for (auto& t : ts) t.join();
	best.starts = (int)starts.size();
	Scratch s;
	s.stamp.assign(m.polys.size(), 0);
	if (auto e = walkFrameClips(m, s, best.start, best.yaw, best.speed, pusher, crossed)) best.end = *e;
	return best;
}

// --min-speed: reachability for every clip (on `threads` threads), then
// the lowest speed per wall pair, crossing / standing and kind, printed.
void findMinSpeeds(const Model& m, vector<Clip>& found, int threads) {
	auto r0 = std::chrono::steady_clock::now();
	std::atomic<size_t> next{ 0 }, done{ 0 };
	auto work = [&]() {
		Scratch s;
		s.stamp.assign(m.polys.size(), 0);
		for (size_t i; (i = next++) < found.size();) {
			reachability(m, s, found[i]);
			size_t d = ++done;
			if (d % 64 == 0 || d == found.size()) fprintf(stderr, "\r  min speed %zu / %zu   ", d, found.size());
		}
	};
	vector<std::thread> ts;
	for (int t = 0; t < threads; t++) ts.emplace_back(work);
	for (auto& t : ts) t.join();
	fprintf(stderr, "(%.1fs)\n", std::chrono::duration<double>(std::chrono::steady_clock::now() - r0).count());
	// the lowest per wall pair, crossing / standing and walking / falling
	std::map<std::tuple<int, int, bool, bool>, const Clip*> best;
	for (const Clip& c : found) {
		if (!c.hasReach) continue;
		auto k = std::make_tuple(c.pusher, c.crossed, c.cross, c.drop > 0);
		if (!best.count(k) || c.reachSpeed < best[k]->reachSpeed) best[k] = &c;
	}
	static const char* kinds[] = { "acute", "extended", "slope", "ground" };
	for (auto& [k, c] : best) {
		fprintf(stderr, "  %s %s TRI %d -> %d: min speed %.4f  start %.3f, %.3f, %.3f  yaw 0x%04X  (clip point %.3f, %.3f, %.3f%s)\n",
			kinds[c->kind], c->cross ? "cross" : "stand", c->pusher, c->crossed, c->reachSpeed,
			c->reachStart.x, c->reachStart.y, c->reachStart.z, c->reachYaw & 0xFFFF,
			c->from.x, c->from.y, c->from.z, c->drop ? (", drop " + std::to_string(c->drop)).c_str() : "");
	}
	size_t none = std::count_if(found.begin(), found.end(), [](const Clip& c) { return !c.hasReach; });
	if (none) fprintf(stderr, "  (%zu clip points not reachable from a standable start at up to speed %g)\n", none, REACH_DIST / SPEED_RATE);
}

// The clips written are just the refined one, as an ordinary
// clip (the frame run again for its fields), so the viewer and
// wall_clip_tester.lua use its exact start, yaw and speed.
std::optional<Clip> refinedClip(const Model& m, const Refined& r, int pusher, int crossed) {
	Scratch s;
	s.stamp.assign(m.polys.size(), 0);
	const FrameSpec& spec = FRAME_SPEC;
	// slope / ground clips: their frame's own clip
	if (spec.type == 2 || spec.type == 3) {
		auto c = spec.type == 2 ? slopeFrame(m, s, r.start, r.yaw, r.speed, crossed) : groundFrame(m, s, r.start, r.yaw, r.speed, spec.vy, crossed);
		if (!c || c->pusher != pusher) return std::nullopt;
		return c;
	}
	const bool falling = spec.type == 1;
	auto posNext = [&]() {
		V3 nx = moveStep(r.start, r.yaw, r.speed);
		if (falling) nx.y = F(r.start.y - spec.drop);
		return nx;
	};
	auto frame = [&](const Tol& tol, V3& res, V3& at, bool& cross) {
		V3 nx = posNext();
		PushList trace;
		auto f = lineFrame(m, s, r.start, nx, tol);
		cross = (bool)f;
		if (f) { res = f->res; trace = f->trace; at = { f->hit.x, nx.y, f->hit.z }; }
		else { res = m.sphereStep(nx, tol, &trace, &r.start); at = nx; }
		const Move mv{ r.yaw, r.speed };
		auto cl = clipFromFrame(m, s, r.start, res, trace, tol, falling ? NAN : r.start.y, &mv);
		if (cl && (cl->crossed != crossed || cl->pusher != pusher)) cl.reset();
		return cl;
	};
	V3 res, at, sres, sat;
	bool cross, scross;
	auto cl = frame(LOOSE, res, at, cross);
	if (cl) {
		Clip c;
		auto scl = frame(STRICT, sres, sat, scross);
		c.acutePoint = scl && scl->onFace;
		c.cross = cross;
		c.pusher = pusher; c.crossed = crossed;
		c.prev = r.start; c.next = posNext(); c.hasNext = true;
		c.from = at; c.res = res; c.end = cl->end;
		if (falling) {
			// where he lands, as the scan's falling clips
			bool noFloor;
			auto land = landing(m, s, res, r.start.y, noFloor, crossed, &r.start);
			if (!land) return std::nullopt;
			// (the scan's field is whole units; prev / next hold the exact fall)
			c.drop = std::max(1, (int)std::lround(spec.drop));
			c.end = *land;
			c.endNoFloor = noFloor;
		}
		c.floorY = r.start.y; c.hasFloorY = true;
		c.yaw = r.yaw; c.speed = r.speed; c.hasMove = true;
		if (cross) c.yaws = { r.yaw };
		c.reachDone = c.hasReach = true;
		c.reachSpeed = r.speed; c.reachYaw = r.yaw; c.reachStart = r.start;
		return c;
	}
	return std::nullopt;
}

// --yaw / --max-speed: the lowest speed up to maxSpeed that does this wall
// pair's clip moving at exactly `yaw`, from any standable in-bounds start.
// Starts: behind each walking clip point of the pair along the yaw (up to
// maxSpeed * 1.5 back, 3 either side), every sideStep across the yaw and 0.5
// along it, each where Link comes to rest there. A start is tried from the speed
// that takes it to within 3 of the nearest clip point ahead (none: skipped).
Refined clipAtYaw(const Model& m, const vector<Clip>& clips, int pusher, int crossed, int yaw, double maxSpeed, double sideStep, bool exact, double gridSpeed, int threads, bool grid) {
	Refined best;
	yaw &= 0xFFFF;
	const V3 unit = moveStep({ 0, 0, 0 }, yaw, 1 / SPEED_RATE);  // (sine table direction)
	const double len = std::hypot(unit.x, unit.z);
	const double dx = unit.x / len, dz = unit.z / len;
	struct Target { V3 p; double floorY; };
	vector<Target> targets;
	for (const Clip& c : clips) if (inFrameSpec(c)) targets.push_back({ c.from, c.hasFloorY ? c.floorY : c.from.y });
	if (targets.empty()) return best;
	const double back = maxSpeed * SPEED_RATE + 1;
	// the points (x, z, floor) behind the clip points: every sideStep across
	// the yaw (--side-step, default 0.002), every ALONG_STEP along it (the
	// speed search covers along). Across has to be fine: a clip can need a
	// start pressed against a wall within a few thousandths (MM Treasure Chest
	// Shop Deku TRI 50 -> 90 at 0xFFC0 works from x -239.9325 but not -239.935
	// or -239.9).
	const double ALONG_STEP = 0.5, SIDE = 3;
	const int sideN = (int)std::floor(SIDE / sideStep + 1e-9);
	// (the same point from two clip points: once, on a grid of half the step)
	const double keyScale = 2 / sideStep;
	vector<std::array<double, 3>> raw;
	{
		std::unordered_set<uint64_t> seen;
		for (const Target& t : targets)
			for (double d = 0; d <= back; d += ALONG_STEP)
				for (int li = -sideN; li <= sideN; li++) {
					const double l = li * sideStep;
					double x = F(t.p.x - d * dx + l * dz), z = F(t.p.z - d * dz - l * dx);
					uint64_t key = ((uint64_t)(uint32_t)(int32_t)std::llround(x * keyScale) << 32) ^ (uint32_t)(int32_t)std::llround(z * keyScale)
						^ ((uint64_t)(uint32_t)(int32_t)std::llround(t.floorY) * 0x9E3779B97F4A7C15ull);
					if (seen.insert(key).second) raw.push_back({ x, z, t.floorY });
				}
	}
	// The lowest speed a start could clip at: the one that takes it to within 3
	// of the nearest clip point ahead, within the push's reach to the side.
	// None (no clip point ahead, or it's over maxSpeed): the start can't do it.
	auto lowerOf = [&](const V3& st) -> std::optional<double> {
		double ahead = 1e9;
		for (const Target& t : targets) {
			double vx = t.p.x - st.x, vz = t.p.z - st.z;
			double along = vx * dx + vz * dz, side = std::fabs(vx * dz - vz * dx);
			if (along > -2 && side <= SIDE + 1) ahead = std::min(ahead, along);
		}
		if (ahead == 1e9) return std::nullopt;
		double lower = std::max(0.0, (ahead - 3) / SPEED_RATE);
		if (lower > maxSpeed) return std::nullopt;
		return lower;
	};
	// where Link rests from each, in bounds, with its lowest possible speed
	vector<std::pair<double, V3>> starts;
	{
		std::mutex mu;
		std::set<std::tuple<float, float, float>> seen;
		std::atomic<size_t> next{ 0 };
		auto work = [&]() {
			Scratch s;
			s.stamp.assign(m.polys.size(), 0);
			for (size_t i; (i = next++) < raw.size();) {
				auto st = standSpot(m, raw[i][0], raw[i][1], raw[i][2]);
				if (!st) continue;
				auto lower = lowerOf(*st);
				if (!lower) continue;
				{
					std::lock_guard<std::mutex> g(mu);
					if (!seen.insert({ (float)st->x, (float)st->y, (float)st->z }).second) continue;
				}
				if (!m.isInBounds(s, *st, true)) continue;
				std::lock_guard<std::mutex> g(mu);
				starts.push_back({ *lower, *st });
			}
		};
		vector<std::thread> ts;
		for (int t = 0; t < threads; t++) ts.emplace_back(work);
		for (auto& t : ts) t.join();
	}
	std::sort(starts.begin(), starts.end(), [](const auto& a, const auto& b) {
		return a.first != b.first ? a.first < b.first : std::tie(a.second.x, a.second.z) < std::tie(b.second.x, b.second.z);
	});
	best.starts = (int)starts.size();
	best.yaw = yaw;
	best.speed = maxSpeed;
	// every start's lowest speed up to maxSpeed (0: none), for the regions
	vector<double> speeds(starts.size(), 0);
	const double limit = F(maxSpeed) + 1e-6;
	{
		std::atomic<size_t> next{ 0 }, done{ 0 };
		auto work = [&]() {
			Scratch s;
			s.stamp.assign(m.polys.size(), 0);
			for (size_t i; (i = next++) < starts.size();) {
				size_t d = ++done;
				if (d % 256 == 0 || d == starts.size()) fprintf(stderr, "\r  yaw 0x%04X: start %zu / %zu   ", yaw, d, starts.size());
				double sp = minSpeedAtYaw(m, s, starts[i].second, yaw, pusher, crossed, starts[i].first, limit);
				if (sp > 0 && sp <= F(maxSpeed)) speeds[i] = sp;
			}
		};
		vector<std::thread> ts;
		for (int t = 0; t < threads; t++) ts.emplace_back(work);
		for (auto& t : ts) t.join();
		fprintf(stderr, "\n");
	}
	vector<std::pair<V3, double>> working;
	for (size_t i = 0; i < starts.size(); i++) if (speeds[i] > 0) working.push_back({ starts[i].second, speeds[i] });
	// The starts that clip, grouped: linked if within REGION_LINK in x / z
	// (a little over the 0.5 sampled along the yaw) and 1 in y. Slowest first,
	// each one's starts in order along its longer side.
	auto groupRegions = [](const vector<std::pair<V3, double>>& pts) {
		const double REGION_LINK = 0.75;
		vector<size_t> parent(pts.size());
		for (size_t i = 0; i < pts.size(); i++) parent[i] = i;
		// (a loop, with path halving: --exact makes tens of thousands of points,
		// too deep a chain to recurse down)
		auto root = [&](size_t i) {
			while (parent[i] != i) { parent[i] = parent[parent[i]]; i = parent[i]; }
			return i;
		};
		// Cells half REGION_LINK wide and 1 high: any two points in one cell are
		// linked (at most 0.53 apart), so a cell is joined without comparing.
		// Cells up to 2 apart (x, z) and 1 (y) can hold linked points: compared
		// until one pair links, skipped if already joined. (--exact packs tens
		// of thousands of points into one small patch: comparing every pair in
		// a cell took minutes.)
		const double H = REGION_LINK / 2;
		using Cell = std::tuple<int64_t, int64_t, int64_t>;
		std::map<Cell, vector<size_t>> cells;
		for (size_t i = 0; i < pts.size(); i++) {
			const V3& p = pts[i].first;
			cells[{ (int64_t)std::floor(p.x / H), (int64_t)std::floor(p.z / H), (int64_t)std::floor(p.y) }].push_back(i);
		}
		for (auto& [c, list] : cells)
			for (size_t k = 1; k < list.size(); k++) parent[root(list[k])] = root(list[0]);
		for (auto& [c, list] : cells) {
			auto [cx, cz, cy] = c;
			for (int64_t ax = cx - 2; ax <= cx + 2; ax++)
				for (int64_t az = cz - 2; az <= cz + 2; az++)
					for (int64_t ay = cy - 1; ay <= cy + 1; ay++) {
						const Cell o{ ax, az, ay };
						if (!(c < o)) continue;  // (each pair of cells once)
						auto it = cells.find(o);
						if (it == cells.end() || root(list[0]) == root(it->second[0])) continue;
						bool linked = false;
						for (size_t i : list) {
							const V3& p = pts[i].first;
							for (size_t j : it->second) {
								const V3& q = pts[j].first;
								if (std::hypot(p.x - q.x, p.z - q.z) <= REGION_LINK && std::fabs(p.y - q.y) <= 1) { linked = true; break; }
							}
							if (linked) break;
						}
						if (linked) parent[root(list[0])] = root(it->second[0]);
					}
		}
		std::map<size_t, StartRegion> groups;
		for (size_t i = 0; i < pts.size(); i++) {
			const V3& p = pts[i].first;
			const double sp = pts[i].second;
			auto [it, fresh] = groups.try_emplace(root(i), StartRegion{ p.x, p.x, p.z, p.z, 0, sp, p, {} });
			StartRegion& g = it->second;
			g.pts.push_back({ p, sp });
			g.x0 = std::min(g.x0, p.x); g.x1 = std::max(g.x1, p.x);
			g.z0 = std::min(g.z0, p.z); g.z1 = std::max(g.z1, p.z);
			g.n++;
			if (sp < g.speed || (sp == g.speed && std::tie(p.x, p.z) < std::tie(g.start.x, g.start.z))) { g.speed = sp; g.start = p; }
		}
		vector<StartRegion> out;
		for (auto& [k, g] : groups) {
			const bool alongZ = g.z1 - g.z0 >= g.x1 - g.x0;
			std::sort(g.pts.begin(), g.pts.end(), [&](const auto& a, const auto& b) {
				return alongZ ? std::tie(a.first.z, a.first.x) < std::tie(b.first.z, b.first.x) : std::tie(a.first.x, a.first.z) < std::tie(b.first.x, b.first.z);
			});
			out.push_back(std::move(g));
		}
		std::sort(out.begin(), out.end(), [](const StartRegion& a, const StartRegion& b) {
			return a.speed != b.speed ? a.speed < b.speed : std::tie(a.start.x, a.start.z) < std::tie(b.start.x, b.start.z);
		});
		return out;
	};
	best.regions = groupRegions(working);
	// --exact: every f32 x and z around each region, where Link stands still
	// (his resting spot is that very point) and in bounds, tried like the
	// starts above. The box starts as the region's, one sideStep bigger each
	// way, and grows until nothing that works is within a sideStep of its
	// edge (each time only the new strip is tried). The regions are then made
	// again from what works. A region over EXACT_MAX points is left as sampled.
	if (exact && !best.regions.empty()) {
		const double EXACT_MAX = 50e6;
		auto t0 = std::chrono::steady_clock::now();
		auto f32s = [](double a, double b) {
			vector<double> v;
			for (float x = (float)a; x <= (float)b; x = std::nextafter(x, INFINITY)) v.push_back(x);
			return v;
		};
		std::mutex mu;
		std::set<std::pair<float, float>> seen;
		vector<std::pair<V3, double>> exactPts;
		double tried = 0;
		for (const StartRegion& g : best.regions) {
			// tried box B (empty at first), box to try T, what works's box W
			double bx0 = INFINITY, bx1 = -INFINITY, bz0 = INFINITY, bz1 = -INFINITY;
			double wx0 = g.x0, wx1 = g.x1, wz0 = g.z0, wz1 = g.z1;
			double regionTried = 0;
			bool capped = false;
			while (true) {
				const double tx0 = std::min(bx0, wx0 - sideStep), tx1 = std::max(bx1, wx1 + sideStep);
				const double tz0 = std::min(bz0, wz0 - sideStep), tz1 = std::max(bz1, wz1 + sideStep);
				if (tx0 >= bx0 && tx1 <= bx1 && tz0 >= bz0 && tz1 <= bz1) break;
				const vector<double> xs = f32s(tx0, tx1), zs = f32s(tz0, tz1);
				if (regionTried + (double)xs.size() * zs.size() > EXACT_MAX) { capped = true; break; }
				// one z row per work item; rows inside B only try the x outside it
				std::atomic<size_t> next{ 0 };
				std::atomic<size_t> count{ 0 };
				auto work = [&]() {
					Scratch s;
					s.stamp.assign(m.polys.size(), 0);
					for (size_t zi; (zi = next++) < zs.size();) {
						const double z = zs[zi];
						const bool rowInB = z >= bz0 && z <= bz1;
						for (double x : xs) {
							if (rowInB && x >= bx0 && x <= bx1) continue;
							count++;
							auto st = standSpot(m, x, z, g.start.y);
							if (!st || st->x != x || st->z != z) continue;
							auto lower = lowerOf(*st);
							if (!lower || !m.isInBounds(s, *st, true)) continue;
							double sp = minSpeedAtYaw(m, s, *st, yaw, pusher, crossed, *lower, limit);
							if (!(sp > 0 && sp <= F(maxSpeed))) continue;
							std::lock_guard<std::mutex> lk(mu);
							wx0 = std::min(wx0, x); wx1 = std::max(wx1, x);
							wz0 = std::min(wz0, z); wz1 = std::max(wz1, z);
							if (seen.insert({ (float)x, (float)z }).second) exactPts.push_back({ *st, sp });
						}
					}
				};
				vector<std::thread> ts;
				for (int t = 0; t < threads; t++) ts.emplace_back(work);
				for (auto& t : ts) t.join();
				regionTried += count;
				fprintf(stderr, "\r  yaw 0x%04X --exact: %.0f f32 points tried   ", yaw, tried + regionTried);
				bx0 = tx0; bx1 = tx1; bz0 = tz0; bz1 = tz1;
			}
			tried += regionTried;
			if (capped) {
				fprintf(stderr, "\n  yaw 0x%04X --exact: a region grew past %.0f f32 points; the rest of it is left as sampled\n", yaw, EXACT_MAX);
				std::lock_guard<std::mutex> lk(mu);
				for (const auto& p : g.pts) if (seen.insert({ (float)p.first.x, (float)p.first.z }).second) exactPts.push_back(p);
			}
		}
		// (the same order whatever the threads did)
		std::sort(exactPts.begin(), exactPts.end(), [](const auto& a, const auto& b) { return std::tie(a.first.x, a.first.z) < std::tie(b.first.x, b.first.z); });
		fprintf(stderr, "\r  yaw 0x%04X --exact: %.0f f32 points tried, %zu work (%zu sampled) (%.1fs)\n", yaw, tried, exactPts.size(), working.size(),
			std::chrono::duration<double>(std::chrono::steady_clock::now() - t0).count());
		best.regions = groupRegions(exactPts);
	}
	if (!best.regions.empty()) {
		best.found = true;
		best.speed = best.regions[0].speed;
		best.start = best.regions[0].start;
	}
	if (best.found) {
		Scratch s;
		s.stamp.assign(m.polys.size(), 0);
		if (auto e = walkFrameClips(m, s, best.start, yaw, best.speed, pusher, crossed)) best.end = *e;
	}
	// The grid for the CSV: about GRID_COLS x GRID_ROWS round steps (1, 2 or 5
	// x a power of ten, no finer than the f32 spacing there) over the starts
	// that clip, with a step more each side. Each point is tried as it is:
	// Link standing exactly there (it has to be his resting spot, in bounds)
	// clips at some speed up to maxSpeed. While an edge row or column has a
	// Yes (the starts found don't cover it all: likely without --exact), that
	// side grows by half the span and the grid is made again (points already
	// tried aren't tried again), up to GRID_GROWS times.
	if (best.found && grid) {
		const int GRID_COLS = 20, GRID_ROWS = 40, GRID_GROWS = 16;
		double x0 = INFINITY, x1 = -INFINITY, z0 = INFINITY, z1 = -INFINITY;
		const double y = best.start.y;
		for (const StartRegion& g : best.regions) {
			x0 = std::min(x0, g.x0); x1 = std::max(x1, g.x1);
			z0 = std::min(z0, g.z0); z1 = std::max(z1, g.z1);
		}
		std::mutex mu;
		std::map<std::pair<float, float>, double> tried;  // (f32 x, z) -> lowest speed that clips, 0 none
		auto axis = [](double a, double b, int target, vector<double>& vals, int& decimals) {
			const float big = (float)std::max(std::fabs(a), std::fabs(b));
			const double ulp = (double)std::nextafter(big, INFINITY) - big;
			const double raw = std::max((b - a) / target, ulp);
			double p = std::pow(10.0, std::floor(std::log10(raw)));
			double step = 0;
			for (double mul : { 1.0, 2.0, 5.0, 10.0 }) if (mul * p >= raw * 0.999) { step = mul * p; break; }
			decimals = std::max(0, (int)-std::floor(std::log10(step) + 1e-9));
			const int64_t i0 = (int64_t)std::floor(a / step) - 1, i1 = (int64_t)std::ceil(b / step) + 1;
			for (int64_t i = i0; i <= i1; i++) vals.push_back(i * step);
		};
		YawGrid& G = best.grid;
		for (int grow = 0;; grow++) {
			G = YawGrid();
			axis(x0, x1, GRID_COLS, G.xs, G.xDecimals);
			axis(z0, z1, GRID_ROWS, G.zs, G.zDecimals);
			G.ok.assign(G.xs.size() * G.zs.size(), 0);
			G.speed.assign(G.ok.size(), 0);
			std::atomic<size_t> next{ 0 };
			auto work = [&]() {
				Scratch s;
				s.stamp.assign(m.polys.size(), 0);
				for (size_t i; (i = next++) < G.ok.size();) {
					// (the value as typed in: the nearest f32 to the round number)
					const double x = F(G.xs[i % G.xs.size()]), z = F(G.zs[i / G.xs.size()]);
					{
						std::lock_guard<std::mutex> lk(mu);
						auto it = tried.find({ (float)x, (float)z });
						if (it != tried.end()) { G.speed[i] = it->second; G.ok[i] = it->second > 0; continue; }
					}
					double ok = 0;
					auto st = standSpot(m, x, z, y);
					if (st && st->x == x && st->z == z && gridSpeed > 0) {
						// --speed: that speed exactly, as the game would run it
						if (m.isInBounds(s, *st, true) && walkFrameClips(m, s, *st, yaw, F(gridSpeed), pusher, crossed)) ok = F(gridSpeed);
					} else if (st && st->x == x && st->z == z) {
						auto lower = lowerOf(*st);
						if (lower && m.isInBounds(s, *st, true)) {
							double sp = minSpeedAtYaw(m, s, *st, yaw, pusher, crossed, *lower, limit);
							if (sp > 0 && sp <= F(maxSpeed)) ok = sp;
						}
					}
					G.speed[i] = ok;
					G.ok[i] = ok > 0;
					std::lock_guard<std::mutex> lk(mu);
					tried[{ (float)x, (float)z }] = ok;
				}
			};
			vector<std::thread> ts;
			for (int t = 0; t < threads; t++) ts.emplace_back(work);
			for (auto& t : ts) t.join();
			// a Yes on an edge: grow that side
			const size_t nx = G.xs.size(), nz = G.zs.size();
			bool left = false, right = false, bottom = false, top = false;
			for (size_t zi = 0; zi < nz; zi++) { left |= G.ok[zi * nx] != 0; right |= G.ok[zi * nx + nx - 1] != 0; }
			for (size_t xi = 0; xi < nx; xi++) { bottom |= G.ok[xi] != 0; top |= G.ok[(nz - 1) * nx + xi] != 0; }
			if (!(left || right || bottom || top)) break;
			if (grow == GRID_GROWS) {
				fprintf(stderr, "  yaw 0x%04X: the CSV's grid still has a Yes on its edge after growing %d times\n", yaw, GRID_GROWS);
				break;
			}
			const double gx = std::max((G.xs.back() - G.xs.front()) / 2, G.xs[1] - G.xs[0]);
			const double gz = std::max((G.zs.back() - G.zs.front()) / 2, G.zs[1] - G.zs[0]);
			if (left) x0 = G.xs.front() - gx;
			if (right) x1 = G.xs.back() + gx;
			if (bottom) z0 = G.zs.front() - gz;
			if (top) z1 = G.zs.back() + gz;
		}
	}
	return best;
}

// --speed S (with --yaw / --angles): a start that clips at exactly speed S,
// from the starts the search found (each with its own lowest speed v <= S):
// moved (S - v) x 1.5 back along the yaw, so posNext lands where v put it,
// then a few f32 steps either way (rounding moves posNext a hair). It has to
// be where Link rests (standSpot gives back that exact point), in bounds, and
// the frame at exactly S has to clip. Nearest v to S first.
std::optional<V3> startAtSpeed(const Model& m, const Refined& r, int yaw, double speed, int pusher, int crossed) {
	if (!r.found) return std::nullopt;
	Scratch s;
	s.stamp.assign(m.polys.size(), 0);
	const V3 unit = moveStep({ 0, 0, 0 }, yaw, 1 / SPEED_RATE);
	const double len = std::hypot(unit.x, unit.z);
	const double dx = unit.x / len, dz = unit.z / len;
	vector<std::pair<V3, double>> pts;
	for (const StartRegion& g : r.regions) pts.insert(pts.end(), g.pts.begin(), g.pts.end());
	std::stable_sort(pts.begin(), pts.end(), [&](const auto& a, const auto& b) { return std::fabs(a.second - speed) < std::fabs(b.second - speed); });
	if (pts.size() > 4000) pts.resize(4000);
	const double sp = F(speed);
	for (const auto& [p, v] : pts) {
		// (the start itself first: it may clip at S as it is)
		const double back = (sp - v) * SPEED_RATE;
		for (double base : { 0.0, back }) {
			for (int j = 0; j <= 16; j++) {
				const double o = (j % 2 ? -1 : 1) * ((j + 1) / 2) * 0.00005;  // 0, +, -, ++, --, ...
				const double x = F(p.x - (base - o) * dx), z = F(p.z - (base - o) * dz);
				auto st = standSpotCached(m, s, x, z, p.y);
				if (!st || st->x != x || st->z != z) continue;
				if (!m.isInBounds(s, *st, true)) continue;
				if (walkFrameClips(m, s, *st, yaw, sp, pusher, crossed)) return *st;
			}
		}
	}
	return std::nullopt;
}
