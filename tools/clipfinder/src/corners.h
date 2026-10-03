// clipfinder: starts in convex wall corners.
//
// The game's wall check only pushes Link off a wall when his sphere centre,
// projected along Z or X onto its plane, lands on the triangle (wallPush,
// CollisionPoly_Check[ZX]IntersectApprox, 1 unit of slack). Where two walls
// meet in a corner that sticks out at him (or a wall just ends), standing off
// the corner's edge his centre projects past the end of both walls, so neither
// pushes: his sphere stands partly inside the corner. At a square corner he
// gets within about 1.5 of the edge, where a wall's face would keep him the
// radius away.
//
// standSpot only lands in such a pocket if a start happens to be tried inside
// it (anywhere else, the pushes move him out to the radius off a face), so the
// pockets are found once per scan (findCornerSpots) and tried as extra starts
// by the scans' start searches (cornerSpotsNear).
#pragma once

#include "frame.h"

// Fills m.cornerSpots / m.cornerGrid: around every wall vertex, per direction
// (every 10 degrees) and floor, the deepest spot (closest to the vertex) that
// is a standSpot of its own, with his sphere at least 0.5 into a wall.
void findCornerSpots(Model& m, int threads);

// The corner spots within maxDist (xz) of (x, z) whose floor is within 10 of
// floorY (as standSpot picks its floor), appended to out.
void cornerSpotsNear(const Model& m, double x, double z, double floorY, double maxDist, vector<V3>& out);

// Whether `p` (a resting spot) has Link's sphere at least 0.5 into a wall: a
// corner pocket start (--sim says so).
bool inCornerPocket(const Model& m, const V3& p);
