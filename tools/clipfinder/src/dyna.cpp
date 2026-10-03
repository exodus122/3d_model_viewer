#include "dyna.h"
#include "json.h"

#include <stdexcept>

////////////////////////////////////////
// JSON helpers (json.h: the parser)
////////////////////////////////////////

namespace {

double num(const JVal* v, const char* what) {
	if (!v || v->kind != JVal::Num) throw std::runtime_error(string("missing number: ") + what);
	return v->n;
}

const JVal& arr(const JVal* v, size_t n, const char* what) {
	if (!v || v->kind != JVal::Arr || (n && v->a.size() != n)) throw std::runtime_error(string("bad array: ") + what);
	return *v;
}

}  // namespace

////////////////////////////////////////
// Dynapoly export
////////////////////////////////////////

// Format (js/wall_push_clips.js exportAllDynapolys, one scene):
// { "format": "dynapoly-1", "game", "map", "setups": [n...], "numPolygons",
//   "actors": [ { "actor", "sphere": { "center": [x,y,z], "radius" }, "minY", "maxY",
//                 "polys": [ { "v": [[x,y,z] x3], "n": [sx,sy,sz], "d", "type": "wall"|"floor"|"ceiling" } ] } ] }
// Polys are the actor's tangible ones in poly index order, in world space as
// DynaPoly_ExpandSRT leaves them; actors in the order they register (bgId).
// dynapoly-set-1: { "format", "game", "scenes": [ dynapoly-1 ... ] }.
static void readDyna(const JVal& root, const string& text, DynaFile& out) {
	out.raw = text.substr(root.begin, root.end - root.begin);
	if (const JVal* g = root.get("game")) out.game = g->s;
	if (const JVal* m = root.get("map")) out.map = m->s;
	if (const JVal* n = root.get("numPolygons")) out.numPolygons = (int)n->n;
	if (const JVal* st = root.get("setups"))
		for (const JVal& v : arr(st, 0, "setups").a) out.setups.push_back((int)v.n);
	for (const JVal& a : arr(root.get("actors"), 0, "actors").a) {
		DynaActorIn d;
		if (const JVal* nm = a.get("actor")) d.name = nm->s;
		const JVal* sph = a.get("sphere");
		if (!sph) throw std::runtime_error("actor without a sphere");
		const JVal& c = arr(sph->get("center"), 3, "sphere.center");
		for (int k = 0; k < 3; k++) d.center[k] = c.a[k].n;
		d.radius = num(sph->get("radius"), "sphere.radius");
		d.minY = num(a.get("minY"), "minY");
		d.maxY = num(a.get("maxY"), "maxY");
		for (const JVal& pj : arr(a.get("polys"), 0, "polys").a) {
			Model::DynaPolyIn q;
			const JVal& v = arr(pj.get("v"), 3, "poly v");
			for (int k = 0; k < 3; k++) {
				const JVal& vk = arr(&v.a[k], 3, "poly vertex");
				for (int j = 0; j < 3; j++) q.v[k][j] = (int)vk.a[j].n;
			}
			const JVal& n = arr(pj.get("n"), 3, "poly n");
			for (int k = 0; k < 3; k++) q.n[k] = (int)n.a[k].n;
			q.d = (int)num(pj.get("d"), "poly d");
			const JVal* ty = pj.get("type");
			q.type = ty && ty->kind == JVal::Str && !ty->s.empty() ? ty->s[0] : 'w';
			d.polys.push_back(q);
		}
		out.actors.push_back(std::move(d));
	}
}

bool readDynaFile(const string& path, vector<DynaFile>& out, string& err) {
	std::ifstream f(path, std::ios::binary);
	if (!f) { err = "can't read " + path; return false; }
	std::stringstream ss;
	ss << f.rdbuf();
	const string text = ss.str();
	try {
		JParser p(text);
		JVal root = p.val();
		const JVal* fmt = root.get("format");
		const string format = fmt && fmt->kind == JVal::Str ? fmt->s : "";
		if (format == "dynapoly-1") {
			out.emplace_back();
			readDyna(root, text, out.back());
		} else if (format == "dynapoly-set-1") {
			const string game = root.get("game") ? root.get("game")->s : "";
			for (const JVal& sc : arr(root.get("scenes"), 0, "scenes").a) {
				out.emplace_back();
				readDyna(sc, text, out.back());
				if (out.back().game.empty()) out.back().game = game;
			}
		} else {
			err = path + " isn't a dynapoly export (format dynapoly-1 or dynapoly-set-1)";
			return false;
		}
	} catch (const std::exception& ex) {
		err = path + ": " + ex.what();
		return false;
	}
	return true;
}

void addDynaActors(Model& m, const DynaFile& d) {
	for (const DynaActorIn& a : d.actors) m.addBgActor(a.name, a.polys, a.center, a.radius, a.minY, a.maxY);
}

////////////////////////////////////////
// Scene setups (models/<GAME>/actors/<GAME>_actors_by_scene.json)
////////////////////////////////////////

// { "<scene file>": [ setup 0, setup 1, ... ] }, null for a setup the scene
// doesn't have (tools/actors/generate_actors_by_scene.py, the viewer's setup list).
bool readSceneSetups(const string& path, std::map<string, vector<bool>>& out, string& err) {
	std::ifstream f(path, std::ios::binary);
	if (!f) { err = "can't read " + path; return false; }
	std::stringstream ss;
	ss << f.rdbuf();
	const string text = ss.str();
	try {
		JParser p(text);
		JVal root = p.val();
		for (const auto& kv : root.o) {
			vector<bool> present;
			if (kv.second.kind == JVal::Arr)
				for (const JVal& s : kv.second.a) present.push_back(s.kind != JVal::Null);
			out[kv.first] = present;
		}
	} catch (const std::exception& ex) {
		err = path + ": " + ex.what();
		return false;
	}
	return true;
}
