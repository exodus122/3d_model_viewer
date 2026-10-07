#include "output.h"
#include "action.h"

////////////////////////////////////////
// Output
////////////////////////////////////////

int MAX_PER_PAIR = 0;

static string num(double v) {
	char buf[40];
	// %.9g round-trips any f32
	snprintf(buf, sizeof buf, "%.9g", v);
	return buf;
}
static string vec(const V3& v) { return "[" + num(v.x) + "," + num(v.y) + "," + num(v.z) + "]"; }
static string jsonStr(const string& s) {
	string o = "\"";
	for (char c : s) { if (c == '"' || c == '\\') o += '\\'; o += c; }
	return o + "\"";
}


// Format 2: every form's clips in one file, each clip marked with its form
// (one of `forms`), so the viewer can show them all at once.
string toJson(const string& game, const string& map, int numPolygons, bool falling, bool extendedOnly,
	const vector<FormResult>& forms, const string& dynaRaw, const vector<int>& setups) {
	static const char* kinds[] = { "acute", "extended", "slope", "ground" };
	std::ostringstream o;
	o << "{\n  \"format\": \"wall-push-clips-2\",\n";
	o << "  \"game\": " << jsonStr(game) << ", \"map\": " << jsonStr(map)
		<< ", \"falling\": " << (falling ? "true" : "false") << ", \"extendedOnly\": " << (extendedOnly ? "true" : "false") << ", \"numPolygons\": " << numPolygons;
	if (REACH_DIST != DEFAULT_MAX_MOVE) o << ", \"maxMove\": " << num(REACH_DIST);
	if (MAX_PER_PAIR > 0) o << ", \"maxPerPair\": " << MAX_PER_PAIR;
	// the scene setups whose dynapolys these are (the viewer's auto-import)
	if (!setups.empty()) {
		o << ", \"setups\": [";
		for (size_t i = 0; i < setups.size(); i++) o << (i ? "," : "") << setups[i];
		o << "]";
	}
	o << ",\n";
	o << "  \"forms\": [";
	for (size_t i = 0; i < forms.size(); i++) {
		o << (i ? ",\n    " : "\n    ") << "{\"form\":" << jsonStr(forms[i].form) << ",\"radius\":" << num(forms[i].radius)
			<< ",\"checkHeight\":" << num(forms[i].checkHeight) << "}";
	}
	o << "\n  ],\n";
	o << "  \"clips\": [";
	bool first = true;
	for (const FormResult& fr : forms) for (const Clip& c : fr.clips) {
		o << (first ? "\n    " : ",\n    ");
		first = false;
		o << "{\"form\":" << jsonStr(fr.form) << ",\"kind\":\"" << kinds[c.kind] << "\",\"cross\":" << (c.cross ? "true" : "false")
			<< ",\"drop\":" << c.drop << ",\"pusher\":" << c.pusher << ",\"crossed\":" << c.crossed
			<< ",\"from\":" << vec(c.from) << ",\"prev\":" << vec(c.prev);
		if (c.hasNext) o << ",\"next\":" << vec(c.next);
		o << ",\"res\":" << vec(c.res) << ",\"end\":" << vec(c.end);
		if (c.endNoFloor) o << ",\"endNoFloor\":true";
		// only with the stick held one more frame (the same yaw and speed)
		if (c.hold) o << ",\"hold\":true";
		// ends in bounds: past a dynapoly, or somewhere he couldn't walk to
		if (c.inBounds) o << ",\"inBounds\":true";
		// and how far the walk there is (-1: no way) - a shortcut (Model::walkUnreachable)
		if (c.inBounds && c.walkDist != 0) o << ",\"walkDistance\":" << (int)std::lround(c.walkDist);
		// --aerial: prev is in the air where he couldn't stand still
		if (c.aerial) o << ",\"aerial\":true";
		if (c.hasFloorY) o << ",\"floorY\":" << num(c.floorY);
		if (c.cross) {
			o << ",\"yaws\":[";
			for (size_t k = 0; k < c.yaws.size(); k++) o << (k ? "," : "") << c.yaws[k];
			o << "]";
		}
		if (c.hasMove) o << ",\"yaw\":" << c.yaw << ",\"speed\":" << num(c.speed);
		// slope clips: the second frame's speed (the same yaw), if it needs one
		if (c.speed2 > 0) o << ",\"speed2\":" << num(c.speed2);
		// ground clips: velocity.y for the frame
		if (c.kind == 3) o << ",\"vy\":" << num(c.vy);
		// action clips: the action, Link's facing at the start, and where each of its frames leaves him
		if (c.action >= 0) {
			o << ",\"action\":" << jsonStr(ACTIONS[c.action].name) << ",\"actionKey\":" << jsonStr(ACTIONS[c.action].key) << ",\"facing\":" << c.facing << ",\"actionFrames\":[";
			for (size_t k = 0; k < c.frameMoves.size(); k++)
				o << (k ? "," : "") << "[" << num(F(c.frameMoves[k].first)) << "," << c.frameMoves[k].second << "]";
			o << "]";
			if (c.airFrames) o << ",\"airFrames\":" << c.airFrames;
			if (c.stopAfter) o << ",\"stopAfter\":" << c.stopAfter;
			if (c.hasFrog) o << ",\"frog\":" << vec(c.frog);
			if (c.hasFrog && c.frogTurn) o << ",\"frogTurn\":" << c.frogTurn << ",\"frogTurnRow\":" << c.frogTurnRow;
			o << ",\"frames\":[";
			for (size_t k = 0; k < c.frames.size(); k++) o << (k ? "," : "") << vec(c.frames[k]);
			o << "]";
		}
		// --min-speed: the slowest move that does it, or null for none. Not for
		// a slope / ground clip whose reach is its own move (most of them): the
		// viewer fills that in on import (wall_push_clips.js slopeReach) - it
		// was ~10% of a big file
		const bool ownMove = c.kind >= 2 && c.hasReach && c.reachYaw == c.yaw && c.reachSpeed == std::max(c.speed, c.speed2) &&
			c.reachStart.x == c.prev.x && c.reachStart.y == c.prev.y && c.reachStart.z == c.prev.z;
		if (c.reachDone && !ownMove) {
			if (c.hasReach) o << ",\"reach\":{\"speed\":" << num(c.reachSpeed) << ",\"yaw\":" << c.reachYaw << ",\"start\":" << vec(c.reachStart) << "}";
			else o << ",\"reach\":null";
		}
		o << "}";
	}
	o << "\n  ]";
	// --dyna: the export as read, so the viewer rebuilds the same dynapolys
	// (and poly ids) when it imports the results
	if (!dynaRaw.empty()) {
		size_t e = dynaRaw.find_last_not_of(" \t\r\n");
		o << ",\n  \"dyna\": " << dynaRaw.substr(0, e + 1);
	}
	o << "\n}\n";
	return o.str();
}
