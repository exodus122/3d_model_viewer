// clipfinder: the wall push clip scan, native and multithreaded. Reads an
// OoT / MM scene from models/, builds the same collision model the viewer does
// (js/parse_model.js, js/subdivisions.js), runs the search and writes the
// points as JSON for the viewer's "Import results" button.
//
// The collision model, clipFromFrame, standSpot, landing and reachability are
// also in js/wall_push_clips.js (for the viewer's "Reachable only") and have to
// stay in step with it: doubles with F() wherever the JS has Math.fround, so
// the numbers come out identical. The JS explains the game side of each step.
//
// The source files, from the bottom up:
//   common.h         f32 helpers (F = Math.fround), V3, the sine table, a frame's walk
//   scene.h/.cpp     the scene file's collision header and its subdivisions
//   collision.h/.cpp the game's collision checks (static and dynapoly), as a Model
//   dyna.h/.cpp      --dyna: the viewer's dynapoly export, added to the Model
//   frame.h/.cpp     one frame: does it clip; where Link can stand; --max-move
//   corners.h/.cpp   starts with Link partly inside a convex wall corner
//   search.h/.cpp    the scan over a whole map
//   slope.h/.cpp     slope clips: the floor check lifting Link behind a wall
//   ground.h/.cpp    ground clips: falling fast through the floor, under a wall
//   reach.h/.cpp     --min-speed, --refine, --angles, --yaw
//   action.h/.cpp    --type actions: sword lunges doing the clip
//   output.h/.cpp    the results JSON
//   sim.h/.cpp       --sim
//   main.cpp         options, forms and the loop over maps
//
// Build: build.sh (g++ / clang++, any OS) or build.bat (Visual Studio) next to
// this file; see the README.
// Usage:
//   clipfinder --game MM --map "Laundry Pool" --form Human [--type acute,extended,slope,ground,falling,actions] [--first-per-pair] [-o out.json]
//     (--first-per-pair: one clip point per wall pair, the first found - much faster)
//   clipfinder --game OOT --all --form Adult [--type all] --out-dir results/
//   clipfinder --game OOT --map "Spot 01 - Kakariko Village" --form All -o kak.json
//   clipfinder --game MM --map "South Clock Town" --form Human [--setup N] [--dyna-only] -o sct.json
//     (--dyna: the scene's dynapoly actors too, from the viewer's "Export all dynapolys";
//      --dyna-only: just the wall pairs with a dynapoly wall in them)
//   clipfinder --game OOT --all --form All --dyna-only --out-dir results/
//     (the viewer's "Export all dynapolys": each map scanned once per distinct
//      set of dynapolys its setups load, the output named and marked with the setups)
//     (--form All: every form's clips in the one JSON, each marked with its form;
//      --form Adult,Child: just those forms, the same way)
// Options: --root <viewer dir> (default: two levels up from the exe's dir, or
// the current dir if it has models/), --threads N, --radius R (overrides --form).
// Every option is explained in README.md next to this file.

#include "action.h"
#include "corners.h"
#include "dyna.h"
#include "output.h"
#include "reach.h"
#include "scene.h"
#include "search.h"
#include "sim.h"

////////////////////////////////////////
// Main
////////////////////////////////////////

struct MapEntry { string name, file; };

static vector<MapEntry> readMapList(const string& root, const string& game) {
	std::ifstream f(root + "/js/model_list.js");
	std::stringstream ss;
	ss << f.rdbuf();
	string text = ss.str();
	string head = "const " + game + "_Maps = [";
	size_t a = text.find(head);
	vector<MapEntry> out;
	if (a == string::npos) return out;
	size_t b = text.find("];", a);
	string body = text.substr(a, b - a);
	std::regex re("\\{\\s*name:\\s*\"([^\"]*)\",\\s*file:\\s*\"([^\"]*)\"");
	for (auto it = std::sregex_iterator(body.begin(), body.end(), re); it != std::sregex_iterator(); ++it)
		out.push_back({ (*it)[1], (*it)[2] });
	return out;
}

static bool readFile(const string& path, vector<uint8_t>& out) {
	std::ifstream f(path, std::ios::binary);
	if (!f) return false;
	out.assign(std::istreambuf_iterator<char>(f), std::istreambuf_iterator<char>());
	return true;
}

static bool exists(const string& p) { std::ifstream f(p); return (bool)f; }

// The type of each of a scene's rooms (SCENE_CMD_ROOM_BEHAVIOR's first byte;
// 2 = ROOM_TYPE_INDOORS, where Z + A rolls instead of jumpslashing), from the
// room files next to the scene's (the viewer's zeldaRoomFileName); -1 for a
// room whose file isn't there.
static vector<int> roomTypes(const string& root, const string& game, const string& sceneFile, const vector<uint8_t>& scene) {
	vector<int> out;
	int numRooms = 0;
	for (size_t o = 0; o + 8 <= scene.size() && scene[o] != 0x14; o += 8)
		if (scene[o] == 0x04) { numRooms = scene[o + 1]; break; }
	for (int i = 0; i < numRooms; i++) {
		string name = sceneFile;
		if (game == "MM") {
			char b[8];
			snprintf(b, sizeof b, "%02d", i);
			name += string("_room_") + b;
		} else {
			if (name.size() > 6 && name.compare(name.size() - 6, 6, "_scene") == 0) name.resize(name.size() - 6);
			name += "_room_" + std::to_string(i);
		}
		vector<uint8_t> r;
		int t = -1;
		if (readFile(root + "/models/" + game + "/" + name, r))
			for (size_t o = 0; o + 8 <= r.size() && r[o] != 0x14; o += 8)
				if (r[o] == 0x08) { t = r[o + 1]; break; }
		out.push_back(t);
	}
	return out;
}
static const int ROOM_TYPE_INDOORS = 2;

static string safeName(const string& s) {
	string o;
	for (char c : s) o += (isalnum((unsigned char)c) || c == '-' || c == '_') ? c : '_';
	return o;
}

int main(int argc, char** argv) {
	string game, mapName, form, out, outDir, root, after, dynaPath;
	bool maxMoveGiven = false;
	int groundStepMax = 3, slopeStepMax = 3;
	double wallStep = 0;  // --wall-step S: the fine pass on pairs without a clip (Model::wallStep)
	bool dynaOnly = false, slopeStarts = false, keepLoadVoid = false;
	bool aerial = false;  // --aerial: falling clips may start in the air (Model::aerial)
	bool corners = true;  // --no-corners: no convex corner pocket starts (corners.h)
	string typeArg;  // --type acute,extended,slope,ground,falling,actions (TYPE_*)
	int onlySetup = -1;  // --setup N: just the dynapolys of that setup
	bool night = false;  // --night: OoT's night setups (1, 3) too
	int maxPerPair = 0;  // --max-per-pair N: at most N points a wall pair, spread out (thinClips)
	size_t maxBytes = 5000000;  // --max-mb N: thin a bigger file (0: no limit)
	double radius = 0;
	bool all = false, firstPerPair = false, minSpeed = false, refine = false, angles = false;
	bool angleSweep = false;  // --angles: every yaw that clips, each from its own start (like --yaw)
	int angleGap = 16;        // --angle-gap: --angles stops a way after this many yaws in a row that don't clip
	int onlyPusher = -1, onlyCrossed = -1;
	string simArg;  // --sim x,y,z,yaw,speed[,drop]
	string triArg;  // --tri ID[,ID...]: print those polys
	bool haveFrom = false;
	double fromX = 0, fromY = 0, fromZ = 0, fromSpeed = 0;  // --from
	int atYaw = -1, yawTo = -1;  // --yaw YAW or FROM-TO
	double maxSpeed = 0;    // --max-speed (with --yaw)
	double sideStep = 0.002;  // --side-step (with --yaw)
	bool exact = false;       // --exact (with --yaw)
	double gridSpeed = 0;     // --speed (with --yaw): the CSV at exactly this speed
	int clipKind = -1;        // --clip-kind: which of the pair's clips --refine / --yaw / --angles do (-1: auto, FrameSpec::type)
	double fallDrop = 0;      // --drop: falling clips, posNext this far below the start (0: the pair's smallest that works)
	string actionsArg = "all"; // --action-keys KEY,...: which sword lunges --type actions does (action.h)
	int threads = (int)std::max(1u, std::thread::hardware_concurrency());
	for (int i = 1; i < argc; i++) {
		string a = argv[i];
		auto val = [&]() { if (i + 1 >= argc) { fprintf(stderr, "missing value for %s\n", a.c_str()); exit(2); } return string(argv[++i]); };
		if (a == "--game") game = val();
		else if (a == "--map") mapName = val();
		else if (a == "--form") form = val();
		else if (a == "--radius") radius = std::stod(val());
		else if (a == "--type") typeArg = val();
		else if (a == "--first-per-pair") firstPerPair = true;
		else if (a == "--max-mb") {
			const double mb = std::stod(val());
			if (!(mb >= 0)) { fprintf(stderr, "--max-mb wants a size in MB (0: no limit)\n"); return 2; }
			maxBytes = (size_t)(mb * 1e6);
		}
		else if (a == "--max-per-pair") {
			maxPerPair = std::stoi(val());
			if (maxPerPair < 1) { fprintf(stderr, "--max-per-pair wants a number of points >= 1\n"); return 2; }
			MAX_PER_PAIR = maxPerPair;
		}
		else if (a == "--min-speed") minSpeed = true;
		else if (a == "--refine") { refine = true; minSpeed = true; }
		else if (a == "--angles") angleSweep = true;
		else if (a == "--angle-gap") {
			angleGap = std::stoi(val());
			if (angleGap < 1) { fprintf(stderr, "--angle-gap wants a number of yaws >= 1\n"); return 2; }
		}
		else if (a == "--from") {
			// every direction from this one start (and speed), after --refine
			string v = val();
			int n = sscanf(v.c_str(), "%lf,%lf,%lf,%lf", &fromX, &fromY, &fromZ, &fromSpeed);
			if (n < 3) { fprintf(stderr, "--from wants X,Y,Z[,SPEED]\n"); return 2; }
			haveFrom = true;
			angles = refine = minSpeed = true;
		}
		else if (a == "--yaw") {
			// YAW, or a range FROM-TO (going up from FROM, through 0xFFFF -> 0 if TO is below it)
			string v = val();
			char* end;
			atYaw = (int)strtol(v.c_str(), &end, 0) & 0xFFFF;
			yawTo = atYaw;
			if (*end == '-') yawTo = (int)strtol(end + 1, &end, 0) & 0xFFFF;
			if (end == v.c_str() || *end) { fprintf(stderr, "--yaw wants YAW or FROM-TO, e.g. 0xFFC0 or 0xFF80-0x0040\n"); return 2; }
		}
		else if (a == "--max-speed") {
			maxSpeed = std::stod(val());
			if (!(maxSpeed > 0)) { fprintf(stderr, "--max-speed wants a speed > 0\n"); return 2; }
		}
		else if (a == "--side-step") {
			sideStep = std::stod(val());
			if (!(sideStep > 0 && sideStep <= 3)) { fprintf(stderr, "--side-step wants a distance > 0 and <= 3\n"); return 2; }
		}
		else if (a == "--exact") exact = true;
		else if (a == "--clip-kind") {
			string v = val();
			clipKind = -1;
			for (int k = 0; k < 4; k++) if (v == FRAME_TYPE_NAMES[k]) clipKind = k;
			if (clipKind < 0) { fprintf(stderr, "--clip-kind wants walking, falling, slope or ground\n"); return 2; }
		}
		else if (a == "--drop") {
			fallDrop = std::stod(val());
			if (!(fallDrop > 0)) { fprintf(stderr, "--drop wants a distance > 0\n"); return 2; }
		}
		else if (a == "--speed") {
			gridSpeed = std::stod(val());
			if (!(gridSpeed > 0)) { fprintf(stderr, "--speed wants a speed > 0\n"); return 2; }
		}
		else if (a == "--action-keys") actionsArg = val();
		else if (a == "--sim") simArg = val();
		else if (a == "--tri") triArg = val();
		else if (a == "--dyna") dynaPath = val();
		else if (a == "--dyna-only") dynaOnly = true;
		else if (a == "--night") night = true;
		else if (a == "--slope-starts") slopeStarts = true;
		else if (a == "--aerial") aerial = true;
		else if (a == "--no-corners") corners = false;
		else if (a == "--slope-step") {
			slopeStepMax = std::stoi(val());
			if (slopeStepMax < 1 || slopeStepMax > 3) { fprintf(stderr, "--slope-step wants 1, 2 or 3\n"); return 2; }
		}
		else if (a == "--wall-step") {
			wallStep = std::stod(val());
			if (!(wallStep > 0 && wallStep < 0.5)) { fprintf(stderr, "--wall-step wants a step below the normal 0.5, e.g. 0.25 or 0.1\n"); return 2; }
		}
		else if (a == "--ground-step") {
			groundStepMax = std::stoi(val());
			if (groundStepMax < 1 || groundStepMax > 3) { fprintf(stderr, "--ground-step wants 1, 2 or 3\n"); return 2; }
		}
		else if (a == "--keep-load-void") keepLoadVoid = true;
		else if (a == "--setup") {
			// one setup (std::stoi took "0,1,2,3" as 0 without a word)
			string v = val();
			char* end;
			long n = strtol(v.c_str(), &end, 10);
			if (v.empty() || *end || n < 0) {
				fprintf(stderr, "--setup wants one setup number, e.g. --setup 2 (OoT: leave it out and each form gets the setups it plays in)\n");
				return 2;
			}
			onlySetup = (int)n;
		}
		else if (a == "--pair") {
			string v = val();
			if (sscanf(v.c_str(), "%d,%d", &onlyPusher, &onlyCrossed) != 2) { fprintf(stderr, "--pair wants PUSHER,CROSSED (TRI ids), e.g. --pair 757,714\n"); return 2; }
		}
		else if (a == "--all") all = true;
		else if (a == "--after") after = val();
		else if (a == "-o" || a == "--out") out = val();
		else if (a == "--out-dir") outDir = val();
		else if (a == "--root") root = val();
		else if (a == "--max-move") {
			double n = std::stod(val());
			if (!(n > 0)) { fprintf(stderr, "--max-move wants a distance > 0\n"); return 2; }
			setMaxMove(n);
			maxMoveGiven = true;
		}
		else if (a == "--threads") threads = std::max(1, std::stoi(val()));
		else if (a == "--falling" || a == "--extended-only" || a == "--no-slope" || a == "--slope-only" || a == "--ground-clips" ||
			a == "--ground-only" || a == "--no-ground" || a == "--actions") {
			fprintf(stderr, "%s is gone: --type picks the clips, e.g. --type acute,extended,slope,falling (see --type in the README)%s\n", a.c_str(),
				a == "--actions" ? "; --type actions [--action-keys KEY,...] for the lunges" : "");
			return 2;
		}
		else { fprintf(stderr, "unknown option %s\n", a.c_str()); return 2; }
	}
	// --type: which clips. Default acute, extended and slope; --clip-kind
	// falling / slope / ground adds its own (its pair's clips of that kind
	// come from the scan)
	int types = 0;
	if (typeArg.empty()) types = TYPE_ACUTE | TYPE_EXTENDED | TYPE_SLOPE;
	else {
		string err;
		types = parseTypes(typeArg, err);
		if (!types) { fprintf(stderr, "--type: %s\n", err.c_str()); return 2; }
	}
	if (clipKind == 1) types |= TYPE_FALLING;
	if (clipKind == 2) types |= TYPE_SLOPE;
	if (clipKind == 3) types |= TYPE_GROUND;
	const bool falling = types & TYPE_FALLING;
	// extended and not acute: the old --extended-only (Model::extendedOnly)
	const bool extendedOnly = (types & TYPE_EXTENDED) && !(types & TYPE_ACUTE);
	if (aerial && !falling) { fprintf(stderr, "--aerial needs falling clips: --type with falling (e.g. --type acute,extended,falling)\n"); return 2; }
	if (aerial && (minSpeed || atYaw >= 0 || angleSweep)) { fprintf(stderr, "--aerial can't be used with --min-speed / --refine / --yaw / --angles\n"); return 2; }
	if (exact && atYaw < 0) { fprintf(stderr, "--exact needs --yaw\n"); return 2; }
	if (gridSpeed > 0 && atYaw < 0 && !angleSweep) { fprintf(stderr, "--speed needs --yaw or --angles\n"); return 2; }
	// (--speed without --max-speed: the search for starts goes up to that speed)
	if (gridSpeed > 0 && maxSpeed <= 0) maxSpeed = gridSpeed;
	if (atYaw >= 0 && (onlyPusher < 0 || maxSpeed <= 0)) { fprintf(stderr, "--yaw needs --pair PUSHER,CROSSED and --max-speed S\n"); return 2; }
	if (atYaw >= 0 && minSpeed) { fprintf(stderr, "--yaw can't be used with --min-speed / --refine / --angles / --from\n"); return 2; }
	// --angles --from X,Y,Z: every direction from that one start (the old --angles)
	if (angleSweep && haveFrom) angleSweep = false;
	if (angleSweep && (onlyPusher < 0 || maxSpeed <= 0)) { fprintf(stderr, "--angles needs --pair PUSHER,CROSSED and --max-speed S\n"); return 2; }
	if (angleSweep && (atYaw >= 0 || minSpeed)) { fprintf(stderr, "--angles can't be used with --yaw / --min-speed / --refine\n"); return 2; }
	for (auto& ch : game) ch = (char)toupper((unsigned char)ch);
	// OoT3D / MM3D: the same collision and forms as OoT / MM (base), at 30 fps:
	// a frame moves velocity x 1.0 instead of x 1.5 (setGameRate), so speed 30
	// moves 30 a frame and walking posNext is 5 below the floor
	const bool is3ds = game == "OOT3D" || game == "MM3D";
	const string base = is3ds ? game.substr(0, game.size() - 2) : game;
	setGameRate(is3ds);
	// the same move a frame in all four games (SCAN_MAX_MOVE)
	if (!maxMoveGiven) setMaxMove(SCAN_MAX_MOVE);
	if ((base != "OOT" && base != "MM") || (mapName.empty() && !all)) {
		fprintf(stderr,
			"usage: clipfinder --game OOT|MM|OOT3D|MM3D (--map \"<name in the viewer's map list>\" | --all)\n"
			"                  [--form Adult|Child|Crawlspace|Human|Deku|Zora|Goron|FierceDeity|All, or a list: Adult,Child] [--radius R] [--first-per-pair]\n"
			"                  [--type acute,extended,slope,ground,falling,actions | all]  (which clips; default acute,extended,slope; all: every one but actions)\n"
			"                  [--min-speed] [--pair PUSHER,CROSSED] [--refine (with --pair: the exact lowest walking speed)]\n"
			"                  [--angles (with --pair: also every yaw that works from the refined start)]\n"
			"                  [--from X,Y,Z[,SPEED] (--angles from this start instead, and at this speed)]\n"
			"                  [--yaw YAW|FROM-TO --max-speed S (with --pair: the lowest speed up to S that clips moving at exactly YAW, or at each yaw FROM-TO every 0x10)]\n"
			"                  [--side-step D (with --yaw: starts every D across the yaw, default 0.002)]\n"
			"                  [--exact (with --yaw: then every f32 x, z around each region found)]\n"
			"                  [--speed S (with --yaw: the CSV grids at exactly speed S; stands in for --max-speed)]\n"
			"                  [--clip-kind walking|falling|slope|ground] [--drop D]  (with --refine / --yaw / --angles: which of the pair's clips; falling: posNext D below the floor)\n"
			"                  [--sim X,Y,Z,YAW,SPEED[,DROP | ,vVY]]  (one frame from a standing start, printed step by step; SPEED as 15/7: a frame per speed)\n"
			"                  [--tri ID[,ID...]]  (print those polys: vertices, normal, type)\n"
			"                  [--max-move N]  (units Link can move in one frame: default 55 - speed 36.67, OOT3D / MM3D 55)\n"
			"                  [--dyna FILE|none [--dyna-only] [--setup N] [--night]]  (the viewer's dynapoly export; default tools/clipfinder/<GAME>_dyna_all.json)\n"
			"                  [--slope-step 1|2|3] [--wall-step S] [--slope-starts] [--aerial] [--keep-load-void] [--ground-step 1|2|3]\n"
			"                  [--max-per-pair N]  (at most N points per wall pair, spread out evenly: smaller files)\n"
			"                  [--max-mb N]  (default 5: a bigger file keeps fewer points per wall pair, as --max-per-pair; 0: no limit)\n"
			"                  [--action-keys 1h-slash,1h-stab,2h-slash,2h-stab,stick-slash,...,deku-spin,deku-spin-backwalk]  (with --type actions: which, default all; MM3D: the ones recorded in tools/clipfinder/tools/mm3d_actions)\n"
			"                  [-o out.json | --out-dir dir (default tools/clipfinder/results)] [--root viewer_dir] [--threads N]\n");
		return 2;
	}
	// ageProperties->wallCheckRadius (z_player.c)
	static const std::map<string, double> radii = {
		{ "ADULT", 18 }, { "CHILD", 14 }, { "HUMAN", 14 }, { "DEKU", 14 }, { "ZORA", 18 }, { "GORON", 19.5 },
		{ "FIERCEDEITY", 27 }, { "FIERCE_DEITY", 27 }, { "FD", 27 },
		{ "CRAWLSPACE", 10 }, { "CRAWL", 10 },
	};
	// --form All: every form of the game (the viewer's RADIUS_OPTIONS). A
	// smaller radius's clips aren't a subset of a bigger one's: resting spots,
	// what fits between walls and which walls are in reach all change with it.
	static const std::map<string, vector<string>> allForms = {
		{ "OOT", { "Adult", "Child", "Crawlspace" } },
		{ "MM", { "Human", "Deku", "Zora", "Goron", "FierceDeity" } },
	};
	if (form.empty()) form = base == "OOT" ? "Adult" : "Human";
	auto upper = [](string v) { for (auto& ch : v) ch = (char)toupper((unsigned char)ch); return v; };
	struct Variant { string form; double radius, checkHeight; };
	vector<Variant> variants;
	{
		// --form All, or a list: --form Adult,Child
		vector<string> list;
		for (size_t a = 0; a <= form.size();) {
			size_t b = form.find(',', a);
			if (b == string::npos) b = form.size();
			string f = form.substr(a, b - a);
			if (!f.empty()) {
				if (upper(f) == "ALL") list.insert(list.end(), allForms.at(base).begin(), allForms.at(base).end());
				else list.push_back(f);
			}
			a = b + 1;
		}
		if (list.size() > 1 && radius != 0) { fprintf(stderr, "--radius can't be used with several forms\n"); return 2; }
		for (const string& f : list) {
			const string fu = upper(f);
			double r = radius;
			if (r == 0) {
				if (!radii.count(fu)) { fprintf(stderr, "unknown form %s (or pass --radius)\n", f.c_str()); return 2; }
				r = radii.at(fu);
			}
			// OoT's PLAYER_STATE2_CRAWLING checks walls at 15 instead of 26 (z_player.c)
			const bool crawl = base == "OOT" && (fu == "CRAWLSPACE" || fu == "CRAWL");
			variants.push_back({ f, r, crawl ? 15.0 : base == "OOT" ? 26.0 : F(F(268 * F(0.1))) });
		}
	}
	if (root.empty()) {
		string exe = argv[0];
		size_t sl = exe.find_last_of("/\\");
		string dir = sl == string::npos ? "." : exe.substr(0, sl);
		root = exists("js/model_list.js") ? "." : dir + "/../..";
	}
	// --type actions: the scan's walking and slope clip points, then the lunges aimed at them.
	// MM3D: the actions recorded in the game (tools/clipfinder/tools/mm3d_actions, from
	// mm3d_action_recorder.lua); OoT3D has none.
	const string actionGame = game == "MM3D" ? game : base;
	if (game == "MM3D") {
		string err;
		if (!loadRecordedActions(root + "/tools/clipfinder/tools/mm3d_actions", game, err)) { fprintf(stderr, "%s\n", err.c_str()); return 2; }
		if ((types & TYPE_ACTIONS) && std::none_of(ACTIONS.begin(), ACTIONS.end(), [&](const Action& x) { return x.game == game; })) {
			fprintf(stderr, "MM3D: no recorded actions in %s/tools/clipfinder/tools/mm3d_actions (record them with tools/clipfinder/tools/mm3d_action_recorder.lua)\n", root.c_str());
			return 2;
		}
	}
	vector<int> actions;
	if (types & TYPE_ACTIONS) {
		string err;
		actions = parseActions(actionGame, actionsArg, err);
		if (actions.empty()) { fprintf(stderr, "--action-keys: %s\n", err.empty() ? "no actions" : err.c_str()); return 2; }
		if ((types & (TYPE_FALLING | TYPE_GROUND)) || minSpeed || atYaw >= 0 || angleSweep) {
			fprintf(stderr, "--type actions can't be used with falling / ground types, --min-speed / --refine / --yaw / --angles\n");
			return 2;
		}
	}
	vector<MapEntry> maps = readMapList(root, game);
	if (maps.empty()) { fprintf(stderr, "no %s maps found in %s/js/model_list.js (use --root)\n", game.c_str(), root.c_str()); return 1; }
	vector<MapEntry> todo;
	for (const MapEntry& e : maps) if (all || e.name == mapName) todo.push_back(e);
	if (todo.empty()) { fprintf(stderr, "no map named \"%s\" in the %s list\n", mapName.c_str(), game.c_str()); return 1; }
	// --after "<map>": resume an --all run, skipping the maps up to and
	// including that one
	if (!after.empty()) {
		auto it = std::find_if(todo.begin(), todo.end(), [&](const MapEntry& e) { return e.name == after; });
		if (it == todo.end()) { fprintf(stderr, "--after: no map named \"%s\" in the %s list\n", after.c_str(), game.c_str()); return 1; }
		todo.erase(todo.begin(), it + 1);
		fprintf(stderr, "starting after %s: %zu maps to go\n", after.c_str(), todo.size());
	}

	// --dyna: the dynapoly actors the viewer loads: one map's ("Export
	// dynapolys") or every map's, per setup ("Export all dynapolys"). Each map
	// is scanned once per export of it (a set of setups with the same
	// dynapolys); a map without one once without dynapolys (not at all with
	// --dyna-only).
	vector<DynaFile> dynas;
	// (default: the viewer's Export all dynapolys for this game, tools/clipfinder/<GAME>_dyna_all.json;
	// --dyna none scans without dynapolys)
	// (OoT3D / MM3D: the viewer has no dynapoly actors for them)
	if (dynaPath.empty() && !is3ds) {
		const string def = root + "/tools/clipfinder/" + game + "_dyna_all.json";
		if (exists(def)) dynaPath = def;
		else fprintf(stderr, "warning: no %s (the viewer's Export all dynapolys) - scanning without dynapolys\n", def.c_str());
	}
	else if (dynaPath == "none") dynaPath.clear();
	if (dynaOnly && dynaPath.empty()) { fprintf(stderr, "--dyna-only needs dynapolys (a --dyna FILE, or the default one)\n"); return 2; }
	if (onlySetup >= 0 && dynaPath.empty()) { fprintf(stderr, "--setup needs dynapolys (a --dyna FILE, or the default one)\n"); return 2; }
	if (!dynaPath.empty()) {
		string err;
		if (!readDynaFile(dynaPath, dynas, err)) { fprintf(stderr, "%s\n", err.c_str()); return 1; }
		for (const DynaFile& d : dynas)
			if (!d.game.empty() && upper(d.game) != game) { fprintf(stderr, "%s is a %s export, not %s\n", dynaPath.c_str(), d.game.c_str(), game.c_str()); return 1; }
		// one map's export with --map: it has to be that map's
		if (!all && dynas.size() == 1 && !dynas[0].map.empty() && dynas[0].map != mapName) {
			fprintf(stderr, "%s is %s's export, not %s's\n", dynaPath.c_str(), dynas[0].map.c_str(), mapName.c_str());
			return 1;
		}
		if (onlySetup >= 0) {
			dynas.erase(std::remove_if(dynas.begin(), dynas.end(), [&](const DynaFile& d) {
				return std::find(d.setups.begin(), d.setups.end(), onlySetup) == d.setups.end();
			}), dynas.end());
		}
		if (!all && std::none_of(dynas.begin(), dynas.end(), [&](const DynaFile& d) { return d.map.empty() || d.map == mapName; })) {
			// (not an error: the scan goes on without dynapolys - with
			// --dyna-only there's nothing to scan, and the map is skipped)
			fprintf(stderr, "warning: %s has no dynapolys for %s%s - scanning %s\n", dynaPath.c_str(), mapName.c_str(),
				onlySetup >= 0 ? (" setup " + std::to_string(onlySetup)).c_str() : "",
				dynaOnly ? "nothing (--dyna-only)" : "without them");
		}
	}
	const DynaFile noDyna;

	// OoT: which setups each scene has (the viewer's setup list), so each form
	// is scanned with the dynapolys of the setups it plays in
	std::map<string, vector<bool>> sceneSetups;
	if (base == "OOT" && !dynas.empty() && onlySetup < 0) {
		string err;
		if (!readSceneSetups(root + "/models/OOT/actors/OOT_actors_by_scene.json", sceneSetups, err))
			fprintf(stderr, "%s - every form gets every setup's dynapolys\n", err.c_str());
	}
	// The setups a form plays in, empty for any: OoT child (and crawling)
	// setups 0 / 1, adult 2 / 3 (SCENE_LAYER_*), one the scene doesn't have
	// resolved the way Scene_CommandAlternateHeaderList does - adult night
	// falls back to adult day, anything else to setup 0. Cutscene setups (4+)
	// only with --setup, which also takes any form.
	auto formSetups = [&](const Variant& v, const string& sceneFile) {
		vector<int> out;
		auto it = sceneSetups.find(sceneFile);
		if (it == sceneSetups.end()) return out;
		const vector<bool>& present = it->second;
		auto has = [&](int l) { return l < (int)present.size() && present[l]; };
		const string fu = upper(v.form);
		vector<int> want;
		// (the night setups 1 / 3 only with --night)
		if (fu == "CHILD" || fu == "CRAWLSPACE" || fu == "CRAWL") want = night ? vector<int>{ 0, 1 } : vector<int>{ 0 };
		else if (fu == "ADULT") want = night ? vector<int>{ 2, 3 } : vector<int>{ 2 };
		else return out;
		for (int l : want) {
			int r = l == 0 || has(l) ? l : l == 3 && has(2) ? 2 : 0;
			if (std::find(out.begin(), out.end(), r) == out.end()) out.push_back(r);
		}
		return out;
	};

	int failures = 0;
	for (const MapEntry& e : todo) {
		vector<uint8_t> buf;
		if (!readFile(root + "/models/" + game + "/" + e.file, buf)) { fprintf(stderr, "%s - %s: can't read models/%s/%s\n", game.c_str(), e.name.c_str(), game.c_str(), e.file.c_str()); failures++; continue; }
		ColHeader ch;
		vector<Tri> tris;
		try {
			if (!parseScene(buf, game, e.name, ch, tris)) { fprintf(stderr, "%s - %s: no collision header\n", game.c_str(), e.name.c_str()); failures++; continue; }
		} catch (const std::exception& ex) { fprintf(stderr, "%s - %s: bad scene file: %s\n", game.c_str(), e.name.c_str(), ex.what()); failures++; continue; }
		// The jumpslash: not where every room is indoors (Z + A rolls there,
		// Player_ActionHandler_10; the room Link is in isn't known, so a scene
		// with some indoor rooms keeps it)
		bool noJump = false, indoors = false;
		// (always: --sim @KEY too; OoT3D / MM3D: no room types read - MM3D's recorded actions have no stick frames)
		if (!is3ds) {
			// (the stick's speed: R_RUN_SPEED_LIMIT 500 indoors; a scene with some
			// indoor rooms: the room Link is in isn't known, the outdoor limit)
			const vector<int> rt = roomTypes(root, game, e.file, buf);
			indoors = !rt.empty() && (size_t)std::count(rt.begin(), rt.end(), ROOM_TYPE_INDOORS) == rt.size();
		}
		if (anyJump(actions)) {
			const vector<int> rt = roomTypes(root, game, e.file, buf);
			const size_t indoors = std::count(rt.begin(), rt.end(), ROOM_TYPE_INDOORS);
			noJump = !rt.empty() && indoors == rt.size();
			if (noJump) fprintf(stderr, "%s - %s: every room is indoors (Z + A rolls): no jumpslash\n", game.c_str(), e.name.c_str());
			else if (indoors) fprintf(stderr, "%s - %s: %zu of %zu rooms are indoors, where the jumpslash is a roll instead\n", game.c_str(), e.name.c_str(), indoors, rt.size());
		}
		// this map's dynapoly exports, each with the forms that play in its
		// setups (OoT: formSetups), and the forms none of them is for without
		// dynapolys (the static scan; not with --dyna-only)
		struct Job { const DynaFile* dyna; vector<const Variant*> forms; };
		vector<Job> jobs;
		vector<bool> covered(variants.size(), false);
		if (!sceneSetups.empty()) {
			string line;
			for (const Variant& v : variants) {
				vector<int> ls = formSetups(v, e.file);
				if (ls.empty()) continue;
				line += (line.empty() ? "" : ", ") + v.form + " setup" + (ls.size() > 1 ? "s " : " ");
				for (size_t k = 0; k < ls.size(); k++) line += (k ? "/" : "") + std::to_string(ls[k]);
			}
			(void)line;  // (each form's line says its setup)
		}
		for (const DynaFile& d : dynas) {
			if (!d.map.empty() && d.map != e.name) continue;
			Job j{ &d, {} };
			for (size_t k = 0; k < variants.size(); k++) {
				vector<int> ls = formSetups(variants[k], e.file);
				bool in = ls.empty() || d.setups.empty() ||
					std::any_of(ls.begin(), ls.end(), [&](int l) { return std::find(d.setups.begin(), d.setups.end(), l) != d.setups.end(); });
				if (in) { j.forms.push_back(&variants[k]); covered[k] = true; }
			}
			if (!j.forms.empty()) jobs.push_back(j);
		}
		{
			Job j{ &noDyna, {} };
			for (size_t k = 0; k < variants.size(); k++) if (!covered[k]) j.forms.push_back(&variants[k]);
			if (!j.forms.empty()) {
				if (dynaOnly) {
					string names;
					for (const Variant* v : j.forms) names += (names.empty() ? "" : ", ") + v->form;
					fprintf(stderr, "%s - %s (%s): no dynapolys in %s setups, skipped\n", game.c_str(), e.name.c_str(), names.c_str(),
						j.forms.size() > 1 ? "their" : "its");
				} else jobs.push_back(j);
			}
		}
		if (jobs.empty()) continue;
		for (const Job& job : jobs) {
			const DynaFile& dyna = *job.dyna;
			if (dyna.numPolygons >= 0 && dyna.numPolygons != ch.numPolygons) {
				fprintf(stderr, "%s: %s was exported with %d static polys, the scene file has %d\n", dynaPath.c_str(), e.name.c_str(), dyna.numPolygons, ch.numPolygons);
				return 1;
			}
			// the setups these dynapolys are for: "_setup0-2" in file names
			string setupTag;
			for (size_t k = 0; k < dyna.setups.size(); k++) setupTag += (k ? "-" : "_setup") + std::to_string(dyna.setups[k]);
			// (on each form's line)
			string dynaNote;
			if (!dyna.setups.empty())
				dynaNote = string(" setup") + (dyna.setups.size() > 1 ? "s " : " ") + setupTag.substr(6) + ": " + std::to_string(dyna.actors.size()) + " dynapoly actors";
			// The output file is opened before the scan, so a path that can't be
			// written (e.g. a missing directory) stops the run straight away
			// instead of after the scan, and a write that fails stops it too.
			string path = out;
			if (path.empty() || all) {
				// (default: the viewer's results folder, where its auto-import looks)
				string dir = outDir.empty() ? root + "/tools/clipfinder/results" : outDir;
				path = dir + "/" + safeName(game + "_" + e.name + "_" + form) + typeTag(types) + (firstPerPair ? "_first" : "") + (aerial ? "_aerial" : "") + setupTag + (dyna.raw.empty() ? "" : "_dyna") +
					// (--pair: its own file, not over the whole map's scan)
					(onlyPusher >= 0 ? "_pair" + std::to_string(onlyPusher) + "-" + std::to_string(onlyCrossed) : "") + ".json";
			}
			// -o with several exports of the map: one file each
			else if (jobs.size() > 1) {
				const bool js = path.size() > 5 && path.compare(path.size() - 5, 5, ".json") == 0;
				path = (js ? path.substr(0, path.size() - 5) : path) + setupTag + ".json";
			}
			// (--sim writes nothing, so it doesn't open, and leave empty, the file)
			std::ofstream f;
			if (simArg.empty() && triArg.empty()) f.open(path, std::ios::binary);
			if (simArg.empty() && triArg.empty() && !f) {
				// (the full path: a Windows exe reads "/dir" as the root of the
				// current drive, not as relative to the current directory)
				std::error_code ec;
				string full = std::filesystem::absolute(path, ec).string();
				fprintf(stderr, "can't write %s (%s - does that directory exist?) - stopping\n", path.c_str(), ec ? path.c_str() : full.c_str());
				return 1;
			}
			// Forms with the same radius and check height (Human / Deku) share a
			// scan, listed once as "Human/Deku".
			vector<FormResult> results;
			vector<string> csvPaths;  // --yaw: the CSV written per yaw
			size_t actionPoints = 0;  // --type actions: the attacks' clip points, before the file's thinning
			double actionSecs = 0;
			for (const Variant* vp : job.forms) {
				const Variant& v = *vp;
				// --type actions: the ones this form does (none: skipped, before sharing
				// a scan)
				vector<int> formActions;
				for (int ai : actions) if (actionForForm(ACTIONS[ai], upper(v.form)) && !(noJump && ACTIONS[ai].jump)) formActions.push_back(ai);
				if (!actions.empty() && formActions.empty()) {
					fprintf(stderr, "%s - %s (%s): none of the --action-keys are for this form%s, skipped\n", game.c_str(), e.name.c_str(), v.form.c_str(),
						noJump ? " (or here)" : "");
					continue;
				}
				// (not with actions: each form's are its own - Human's sword, Deku's spins)
				auto same = !actions.empty() ? results.end() : std::find_if(results.begin(), results.end(),
					[&](const FormResult& r) { return r.radius == v.radius && r.checkHeight == v.checkHeight; });
				if (same != results.end()) {
					fprintf(stderr, "%s - %s (%s): same radius and check height as %s, sharing its scan\n",
						game.c_str(), e.name.c_str(), v.form.c_str(), same->form.c_str());
					same->form += "/" + v.form;
					continue;
				}
				fprintf(stderr, "%s - %s: (%s, radius %g%s)%s\n", game.c_str(), e.name.c_str(), v.form.c_str(), v.radius, falling ? ", falling" : "", dynaNote.c_str());
				Model m;
				initColCtx(m.colCtx, game, e.name, ch);
				initializeSubdivisions(m.colCtx, tris);
				m.radius = F(v.radius);
				m.checkHeight = F(v.checkHeight);
				// (a jumpslash also aims at the scan's falling clip points)
				// (the most posNext falls below the start: terminal velocity -20, x1.5 / x1.0 on 3DS)
				m.lowDrop = falling || anyJump(formActions) ? (int)(20 * SPEED_RATE) : 0;
				m.extendedOnly = extendedOnly;
				m.build(tris, ch.numPolygons);
				addDynaActors(m, dyna);
				// convex corner pockets: starts with Link partly inside a corner (corners.h)
				if (corners) {
					const auto tc = std::chrono::steady_clock::now();
					findCornerSpots(m, threads);
					fprintf(stderr, "  %zu convex corner pocket starts (%.1fs)\n", m.cornerSpots.size(),
						std::chrono::duration<double>(std::chrono::steady_clock::now() - tc).count());
				}
				m.dynaPairsOnly = dynaOnly;
				// the wall push scan: for its clips, or the lunges' targets
				m.wallPushes = types & (TYPE_ACUTE | TYPE_EXTENDED | TYPE_FALLING | TYPE_ACTIONS);
				m.slope = types & (TYPE_SLOPE | TYPE_ACTIONS);
				m.slopeStarts = slopeStarts;
				m.aerial = aerial;
				m.ground = types & TYPE_GROUND;
				m.groundStepMax = groundStepMax;
				m.slopeStepMax = slopeStepMax;
				m.wallStep = wallStep;
				m.keepLoadVoid = keepLoadVoid;
				m.indoors = indoors;
				// --pair: the scan only looks near those two polys
				if (onlyPusher >= 0) {
					if (onlyPusher >= (int)m.polys.size() || onlyCrossed >= (int)m.polys.size() || !m.polys[onlyPusher].exists || !m.polys[onlyCrossed].exists) {
						fprintf(stderr, "--pair %d,%d: no such polys in this map (%zu)\n", onlyPusher, onlyCrossed, m.polys.size());
						return 2;
					}
					m.focusA = onlyPusher;
					m.focusB = onlyCrossed;
				}
				if (!simArg.empty()) return runSim(m, simArg, actionGame, upper(v.form));
				if (!triArg.empty()) return printTris(m, triArg);
				vector<Clip> found = scan(m, threads, firstPerPair);
				keepTypes(found, types | (anyJump(formActions) ? TYPE_FALLING : 0));
				// --type actions: the lunges aimed at the scan's walking and slope clip points
				// (a jumpslash: the falling ones too)
				if (!formActions.empty()) {
					const auto ta = std::chrono::steady_clock::now();
					found = actionScan(m, found, formActions, threads);
					keepTypes(found, types);
					actionPoints += found.size();
					actionSecs += std::chrono::duration<double>(std::chrono::steady_clock::now() - ta).count();
				}
				// --pair: just the clips of that wall pair
				if (onlyPusher >= 0) {
					found.erase(std::remove_if(found.begin(), found.end(),
						[&](const Clip& c) { return c.pusher != onlyPusher || c.crossed != onlyCrossed; }), found.end());
					fprintf(stderr, "  %zu clip points of TRI %d through TRI %d\n", found.size(), onlyPusher, onlyCrossed);
					if (found.empty() && m.polys[onlyPusher].isWall && !m.polys[onlyCrossed].isWall)
						fprintf(stderr, "  (TRI %d isn't a wall: for a slope / ground clip --pair is the floor first, then the wall: --pair %d,%d)\n",
							onlyCrossed, onlyCrossed, onlyPusher);
				}
				// --yaw / --max-speed: that pair at each yaw, from any start. A
				// range goes every 0x10 (the sine table ignores the low 4 bits).
				// --angles: the same for every yaw that clips, found by walking out
				// from the yaws of the scan's clip points (see below).
				// --refine / --yaw / --angles / --from: the kind of clip (and frame) they
				// work on, from the pair's clips (reach.h FrameSpec)
				const bool perPair = refine || atYaw >= 0 || angleSweep;
				bool specOk = true;  // (false: --refine / --yaw / --angles have nothing to do)
				if (perPair && !found.empty()) {
					const int why = chooseFrameSpec(found, clipKind, fallDrop, m.checkHeight);
					if (why == 1) {
						fprintf(stderr, "  --clip-kind %s: TRI %d -> %d has no clips of that kind\n", FRAME_TYPE_NAMES[clipKind], onlyPusher, onlyCrossed);
						found.clear();
					} else if (why == 2) {
						// (the scan measures a falling clip's drop from the floor at the
						// clip point: downhill, Link falls further than that)
						specOk = false;
						if (fallDrop > 0) fprintf(stderr, "  --drop %g: over checkHeight - 5 (%g), the game's line test runs at the feet: not a wall push\n", fallDrop, F(maxPushDrop(m.checkHeight)));
						else fprintf(stderr, "  falling clips: every one of this pair's falls further than checkHeight - 5 (%g) from its start, where the game's line test "
							"runs at the feet (not a wall push): nothing to refine. --drop D tries a smaller one.\n", F(maxPushDrop(m.checkHeight)));
					} else {
						const FrameSpec& sp = FRAME_SPEC;
						fprintf(stderr, "  %s clips", FRAME_TYPE_NAMES[sp.type]);
						if (sp.type == 1) fprintf(stderr, " (posNext %.9g below the start: y velocity %.9g)", sp.drop, F(-sp.drop / SPEED_RATE));
						if (sp.type == 3) fprintf(stderr, " (y velocity %g)", sp.vy);
						std::set<int> kinds;
						for (const Clip& c : found) kinds.insert(c.kind >= 2 ? c.kind : c.drop > 0 ? 1 : 0);
						if (kinds.size() > 1 && clipKind < 0) fprintf(stderr, " - the pair has other kinds too: --clip-kind picks one");
						fprintf(stderr, "\n");
					}
				}
				// the pair's category, for the clips written (its clips of that kind)
				auto pairKind = [&]() { for (const Clip& c : found) if (inFrameSpec(c)) return c.kind; return found.front().kind; };
				if ((atYaw >= 0 || angleSweep) && !found.empty() && specOk) {
					// (only clips at those yaws are written: none found, no clips)
					vector<Clip> atYaws;
					vector<Refined> rs;
					std::map<int, size_t> tried;  // yaw -> its index in rs
					// --speed S: per yaw, a start that clips at exactly S (startAtSpeed)
					std::map<int, std::optional<V3>> atSpeed;
					auto doYaw = [&](int yaw) -> bool {
						auto ty = std::chrono::steady_clock::now();
						Refined r = clipAtYaw(m, found, onlyPusher, onlyCrossed, yaw, maxSpeed, sideStep, exact, gridSpeed, threads, !angleSweep);
						double secs = std::chrono::duration<double>(std::chrono::steady_clock::now() - ty).count();
						if (!r.found) fprintf(stderr, "  YAW 0x%04X TRI %d -> %d: no clip at speeds up to %g (%d starts tried, %.1fs)\n",
							yaw, onlyPusher, onlyCrossed, maxSpeed, r.starts, secs);
						else {
							fprintf(stderr, "  YAW 0x%04X TRI %d -> %d: min speed %.9g  start %.9g, %.9g, %.9g  -> end %.9g, %.9g, %.9g  (%d starts tried, %.1fs)\n",
								yaw, onlyPusher, onlyCrossed, r.speed, r.start.x, r.start.y, r.start.z, r.end.x, r.end.y, r.end.z, r.starts, secs);
							Refined rc = r;
							if (gridSpeed > 0) {
								// (the JSON's clip is the move at exactly S, for the tester)
								auto st = startAtSpeed(m, r, yaw, gridSpeed, onlyPusher, onlyCrossed);
								atSpeed[yaw] = st;
								if (st) fprintf(stderr, "    at exactly speed %.9g: start %.9g, %.9g, %.9g\n", F(gridSpeed), st->x, st->y, st->z);
								else fprintf(stderr, "    at exactly speed %.9g: no start found\n", F(gridSpeed));
								if (st) { rc.start = *st; rc.speed = F(gridSpeed); }
							}
							if (gridSpeed <= 0 || atSpeed[yaw]) {
								if (auto c = refinedClip(m, rc, onlyPusher, onlyCrossed)) {
									c->kind = pairKind(); // the pair's category
									atYaws.push_back(*c);
								}
							}
						}
						tried[yaw] = rs.size();
						rs.push_back(r);
						return r.found;
					};
					if (atYaw >= 0) {
						const int n = ((yawTo - atYaw) & 0xFFFF) / 16 + 1;
						for (int k = 0; k < n; k++) doYaw((atYaw + k * 16) & 0xFFFF);
					} else {
						// Every yaw the scan's clip points were found moving at, then
						// out from each, 0x10 at a time both ways, until --angle-gap (16) yaws
						// in a row don't clip: the yaws that work come in runs, with
						// the odd gap (Treasure Chest Shop 50 -> 90 at speed 11:
						// 0xFF40-0xFFE0, then 0x0010 on, not 0xFFF0 / 0x0000).
						// The refined yaw (--refine: the lowest speed there is) first,
						// then the scan's clip moves already at speed S or less,
						// nearest it first. Only a seed that clips is walked out from.
						// (Not every yaw in the scan points' lists: those come from 32
						// start directions at any speed up to 30, and on Treasure
						// Chest Shop 50 -> 90 at 10 all 28 of them failed, 7 s each.)
						const int ANGLE_GAP = angleGap;
						std::set<int> seedSet;
						for (const Clip& c : found)
							if (c.hasMove && inFrameSpec(c) && c.speed <= maxSpeed) seedSet.insert(c.yaw & 0xFFF0);
						int best = -1;
						if (std::any_of(found.begin(), found.end(), inFrameSpec)) {
							findMinSpeeds(m, found, threads);
							Refined rf = refineMinSpeed(m, found, onlyPusher, onlyCrossed, threads);
							if (rf.found) {
								best = rf.yaw & 0xFFF0;
								fprintf(stderr, "  refined: min speed %.9g at yaw 0x%04X - starting there\n", rf.speed, rf.yaw & 0xFFFF);
								if (FRAME_SPEC.type == 1) fprintf(stderr, "    (falling %.9g from the start: the yaws are tried at that)\n", FRAME_SPEC.drop);
							}
						}
						vector<int> seeds(seedSet.begin(), seedSet.end());
						if (best >= 0) {
							auto dist = [&](int y) { int d = (y - best) & 0xFFFF; return std::min(d, 0x10000 - d); };
							std::stable_sort(seeds.begin(), seeds.end(), [&](int a, int b) { return dist(a) < dist(b); });
							seeds.erase(std::remove(seeds.begin(), seeds.end(), best), seeds.end());
							seeds.insert(seeds.begin(), best);
						}
						for (int seed : seeds) {
							if (tried.count(seed)) continue;
							if (!doYaw(seed)) continue;
							for (int dir : { 1, -1 }) {
								int misses = 0, y = seed;
								while (misses < ANGLE_GAP) {
									y = (y + dir * 16) & 0xFFFF;
									if (tried.count(y)) break;
									misses = doYaw(y) ? 0 : misses + 1;
								}
							}
						}
						// in yaw order, starting after the widest gap (a run through 0 in one piece)
						vector<Refined> sorted;
						for (auto& [y, i] : tried) sorted.push_back(rs[i]);
						size_t startAt = 0;
						int widest = -1;
						for (size_t i = 0; i < sorted.size(); i++) {
							int prev = sorted[(i + sorted.size() - 1) % sorted.size()].yaw;
							int gap = (sorted[i].yaw - prev) & 0xFFFF;
							if (sorted.size() == 1) gap = 0x10000;
							if (gap > widest) { widest = gap; startAt = i; }
						}
						std::rotate(sorted.begin(), sorted.begin() + startAt, sorted.end());
						rs = std::move(sorted);
						// the runs that clip, on one line
						string runs;
						for (size_t i = 0; i < rs.size(); i++) {
							auto ok = [&](size_t k) { return rs[k].found && (gridSpeed <= 0 || atSpeed[rs[k].yaw]); };
							if (!ok(i)) continue;
							size_t j = i;
							while (j + 1 < rs.size() && ok(j + 1) && ((rs[j + 1].yaw - rs[j].yaw) & 0xFFFF) == 16) j++;
							char b[40];
							snprintf(b, sizeof b, "%s0x%04X-0x%04X", runs.empty() ? "" : ", ", rs[i].yaw, rs[j].yaw | 0xF);
							runs += b;
							i = j;
						}
						if (gridSpeed > 0) printf("\nYaws that clip at exactly speed %.9g: %s\n", F(gridSpeed), runs.empty() ? "none" : runs.c_str());
						else printf("\nYaws that clip at speed up to %g: %s\n", maxSpeed, runs.empty() ? "none" : runs.c_str());
					}
					// every yaw's answer together, on stdout, one row each: its
					// minimum speed and the x / z range of all the starts that clip at
					// up to maxSpeed. Several separate regions: each on a row below.
					printf("\nTRI %d -> %d, %s, speed up to %g\n", onlyPusher, onlyCrossed, v.form.c_str(), maxSpeed);
					// One start per yaw, one that clips at its lowest speed: not the
					// starts' bounding box, whose points mostly don't (the starts that
					// work are thin strips, and a box around them from far apart yaws
					// or regions says nothing). The exact f32s: positions to set Link
					// at, where 4 decimals is off by more than the clip's window.
					printf("  yaw      min speed    start (x, y, z)\n");
					for (const Refined& r : rs) {
						if (!r.found) { printf("  0x%04X   none\n", r.yaw); continue; }
						printf("  0x%04X   %-11.9g  %.9g, %.9g, %.9g\n", r.yaw, r.speed, r.start.x, r.start.y, r.start.z);
						if (gridSpeed > 0) {
							auto it = atSpeed.find(r.yaw);
							if (it != atSpeed.end() && it->second)
								printf("    at exactly %.9g: start %.9g, %.9g, %.9g\n", F(gridSpeed), it->second->x, it->second->y, it->second->z);
							else printf("    at exactly %.9g: no start found\n", F(gridSpeed));
						}
						if (r.regions.size() > 1)
							for (const StartRegion& g : r.regions)
								printf("    region %-11.9g  %.9g, %.9g, %.9g\n", g.speed, g.start.x, g.start.y, g.start.z);
					}
					// then a CSV per yaw that clips, <output>_<YAW>.csv (with the form
					// too when there are several): a grid of round x (columns) and z
					// (rows) values over its starts that clip, each Yes if Link
					// standing exactly there clips at some speed up to maxSpeed, else No.
					// And <output>_<YAW>_speeds.csv, the same grid with the speed to
					// check each cell at in game (wall_clip_tester.lua CSV_TESTS): a
					// Yes cell's lowest speed that clips, a No cell's maxSpeed.
					const string base = path.size() > 5 && path.compare(path.size() - 5, 5, ".json") == 0 ? path.substr(0, path.size() - 5) : path;
					auto writeGrid = [](const string& file, const YawGrid& G, const std::function<string(size_t)>& cell) {
						FILE* cf = fopen(file.c_str(), "w");
						if (!cf) return false;
						fprintf(cf, "z \\ x");
						for (double x : G.xs) fprintf(cf, ",%.*f", G.xDecimals, x);
						fprintf(cf, "\n");
						for (size_t zi = 0; zi < G.zs.size(); zi++) {
							fprintf(cf, "%.*f", G.zDecimals, G.zs[zi]);
							for (size_t xi = 0; xi < G.xs.size(); xi++) fprintf(cf, ",%s", cell(zi * G.xs.size() + xi).c_str());
							fprintf(cf, "\n");
						}
						bool bad = ferror(cf) != 0;
						return fclose(cf) == 0 && !bad;
					};
					// (--angles: no CSVs - a grid per yaw is --yaw FROM-TO's job)
					for (const Refined& r : rs) {
						if (!r.found || angleSweep) continue;
						char yawName[8];
						snprintf(yawName, sizeof yawName, "%04X", r.yaw);
						const string csvBase = base + (variants.size() > 1 ? "_" + safeName(v.form) : "") + "_" + yawName;
						const YawGrid& G = r.grid;
						if (!writeGrid(csvBase + ".csv", G, [&](size_t i) { return string(G.ok[i] ? "Yes" : "No"); })) {
							fprintf(stderr, "can't write %s.csv - stopping\n", csvBase.c_str());
							return 1;
						}
						if (!writeGrid(csvBase + "_speeds.csv", G, [&](size_t i) {
							char b[40];
							snprintf(b, sizeof b, "%.9g", G.ok[i] ? G.speed[i] : F(gridSpeed > 0 ? gridSpeed : maxSpeed));
							return string(b);
						})) {
							fprintf(stderr, "can't write %s_speeds.csv - stopping\n", csvBase.c_str());
							return 1;
						}
						csvPaths.push_back(csvBase + ".csv");
					}
					found = std::move(atYaws);
				}
				else if (minSpeed && !found.empty()) {
					findMinSpeeds(m, found, threads);
					if (refine && specOk) {
						if (onlyPusher < 0) { fprintf(stderr, "--refine needs --pair PUSHER,CROSSED\n"); return 2; }
						auto t0r = std::chrono::steady_clock::now();
						Refined r = refineMinSpeed(m, found, onlyPusher, onlyCrossed, threads);
						if (!r.found) fprintf(stderr, "  refine: no %s clip of this pair to start from\n", FRAME_TYPE_NAMES[FRAME_SPEC.type]);
						else fprintf(stderr, "  REFINED TRI %d -> %d: min speed %.9g  start %.9g, %.9g, %.9g  yaw 0x%04X  -> end %.9g, %.9g, %.9g  (%d starts tried, %.1fs)\n",
							onlyPusher, onlyCrossed, r.speed, r.start.x, r.start.y, r.start.z, r.yaw & 0xFFFF, r.end.x, r.end.y, r.end.z,
							r.starts, std::chrono::duration<double>(std::chrono::steady_clock::now() - t0r).count());
						if (r.found && FRAME_SPEC.type == 1)
							fprintf(stderr, "    falling %.9g from the start: y velocity %.9g\n", FRAME_SPEC.drop, F(-FRAME_SPEC.drop / SPEED_RATE));
						if (angles && (r.found || haveFrom)) {
							auto ta = std::chrono::steady_clock::now();
							Refined from = r;
							if (haveFrom) {
								from.start = { F(fromX), F(fromY), F(fromZ) };
								if (fromSpeed > 0) from.speed = F(fromSpeed);
								else if (!r.found) from.speed = 0;
								Scratch s;
								s.stamp.assign(m.polys.size(), 0);
								auto rest = m.restingSpot(from.start);
								if (!rest || rest->x != from.start.x || rest->z != from.start.z)
									printf("(note: Link doesn't stand still at that start: the pushes move him%s)\n",
										rest ? (string(" to ") + std::to_string(rest->x) + ", " + std::to_string(rest->z)).c_str() : "");
								if (!m.isInBounds(s, from.start, true)) printf("(note: that start is out of bounds)\n");
							}
							angleRanges(m, from, onlyPusher, onlyCrossed, threads);
							fprintf(stderr, "  (angles: %.1fs)\n", std::chrono::duration<double>(std::chrono::steady_clock::now() - ta).count());
						}
						if (r.found) {
							if (auto c = refinedClip(m, r, onlyPusher, onlyCrossed)) {
								c->kind = pairKind(); // the pair's category
								found = { *c };
							}
						}
					}
				}
				// --max-per-pair: after --min-speed, so the slowest reach is kept
				// (not for --refine / --yaw / --angles: their clips are the answer)
				if (maxPerPair > 0 && !refine && atYaw < 0 && !angleSweep) {
					size_t before = found.size(), dropped = thinClips(found, maxPerPair);
					if (dropped) fprintf(stderr, "  --max-per-pair %d: kept %zu of %zu clip points\n", maxPerPair, found.size(), before);
				}
				results.push_back({ v.form, v.radius, F(v.checkHeight), std::move(found) });
			}
			// --type actions without --max-per-pair: a lunge clips from far more
			// starts than the viewer needs (thousands for one wall pair), so
			// each row keeps at most ACTION_MAX_PER_PAIR points spread out,
			// fewer when the file would pass ACTION_POINT_BUDGET points (~1 KB
			// each, with the lunge's frames)
			if (!actions.empty() && maxPerPair == 0) {
				constexpr int ACTION_MAX_PER_PAIR = 40, ACTION_MIN_PER_PAIR = 6;
				constexpr size_t ACTION_POINT_BUDGET = 4000;
				vector<const vector<Clip>*> sets;
				for (const FormResult& r : results) sets.push_back(&r.clips);
				const int cap = thinCapForBudget(sets, ACTION_MAX_PER_PAIR, ACTION_MIN_PER_PAIR, ACTION_POINT_BUDGET);
				size_t before = 0, after = 0;
				for (FormResult& r : results) { before += r.clips.size(); thinClips(r.clips, cap); after += r.clips.size(); }
				MAX_PER_PAIR = after < before ? cap : 0;
			}
			if (!actions.empty() && !results.empty()) {
				size_t kept = 0;
				for (const FormResult& r : results) kept += r.clips.size();
				fprintf(stderr, "  = %zu action clip points (%.1fs)", actionPoints, actionSecs);
				if (kept < actionPoints) fprintf(stderr, " (reduced to %zu for the file)", kept);
				fprintf(stderr, "\n");
			}
			// (each map its own: only a thinned file says so)
			if (maxPerPair == 0 && actions.empty()) MAX_PER_PAIR = 0;
			string json = toJson(game, e.name, ch.numPolygons, falling, extendedOnly, results, dyna.raw, dyna.setups);
			// --max-mb (default 5) without --max-per-pair: a file that would be
			// bigger keeps at most N points per row, spread out (thinClips), the
			// biggest N that fits. The scan finds far more points than the viewer
			// needs on some maps: OoT Spirit Temple, adult, with its dynapolys,
			// 45561 points / 17.4 MB (one wall pair 8798 of them, falling points
			// every 0.25 along the wall at each drop)
			if (maxBytes > 0 && maxPerPair == 0 && !refine && atYaw < 0 && !angleSweep && json.size() > maxBytes) {
				vector<vector<Clip>> all;
				size_t before = 0;
				for (const FormResult& r : results) { all.push_back(r.clips); before += r.clips.size(); }
				vector<const vector<Clip>*> sets;
				for (const vector<Clip>& c : all) sets.push_back(&c);
				// (the biggest row: no cap above it changes anything)
				int maxN = 1;
				{
					std::map<std::tuple<size_t, int, int, int, bool, bool, int>, int> n;
					for (size_t i = 0; i < all.size(); i++)
						for (const Clip& c : all[i]) maxN = std::max(maxN, ++n[{ i, c.pusher, c.crossed, c.kind, c.cross, c.drop > 0, c.action }]);
				}
				// points that fit at the file's bytes per point, a bit fewer each
				// time it still comes out too big
				const double perPoint = (double)json.size() / std::max<size_t>(before, 1);
				int cap = maxN;
				for (double frac = 1.0; ; frac *= 0.9) {
					cap = std::min(cap, thinCapForBudget(sets, maxN, 1, (size_t)(maxBytes / perPoint * frac)));
					for (size_t i = 0; i < results.size(); i++) { results[i].clips = all[i]; thinClips(results[i].clips, cap); }
					MAX_PER_PAIR = cap;
					json = toJson(game, e.name, ch.numPolygons, falling, extendedOnly, results, dyna.raw, dyna.setups);
					if (json.size() <= maxBytes || cap <= 1) break;
					cap--;
				}
				size_t after = 0;
				for (const FormResult& r : results) after += r.clips.size();
				fprintf(stderr, "  file over --max-mb %g: kept %zu of %zu clip points, at most %d per wall pair and row (%.1f MB)%s\n",
					maxBytes / 1e6, after, before, cap, json.size() / 1e6, json.size() > maxBytes ? " - still over: every row's one point is too much" : "");
			}
			f << json;
			f.close();
			if (!f) {
				fprintf(stderr, "can't write %s - stopping\n", path.c_str());
				return 1;
			}
			fprintf(stderr, "  wrote %s\n", path.c_str());
			if (!csvPaths.empty()) {
				// (on stdout too, after the table)
				printf("\nA grid of the positions that clip, per yaw:\n");
				for (const string& c : csvPaths) { printf("  %s\n", c.c_str()); fprintf(stderr, "  wrote %s\n", c.c_str()); }
			}
		}
	}
	return failures ? 1 : 0;
}
