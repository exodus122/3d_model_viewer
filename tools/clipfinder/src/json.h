// clipfinder: a small JSON reader (the viewer's dynapoly export, the MM3D
// action recordings)
#pragma once

#include "common.h"

#include <cctype>
#include <stdexcept>

struct JVal {
	enum Kind { Null, Bool, Num, Str, Arr, Obj } kind = Null;
	bool b = false;
	double n = 0;
	string s;
	vector<JVal> a;
	vector<std::pair<string, JVal>> o;
	size_t begin = 0, end = 0;  // where it is in the text
	const JVal* get(const string& k) const {
		for (const auto& kv : o) if (kv.first == k) return &kv.second;
		return nullptr;
	}
};

struct JParser {
	const string& t;
	size_t i = 0;
	explicit JParser(const string& text) : t(text) {}
	[[noreturn]] void fail(const char* what) { throw std::runtime_error(string(what) + " at offset " + std::to_string(i)); }
	void ws() { while (i < t.size() && isspace((unsigned char)t[i])) i++; }
	bool lit(const char* w) {
		size_t n = strlen(w);
		if (t.compare(i, n, w) != 0) return false;
		i += n;
		return true;
	}
	string str() {
		if (t[i] != '"') fail("expected a string");
		i++;
		string o;
		while (i < t.size() && t[i] != '"') {
			char c = t[i++];
			if (c == '\\' && i < t.size()) {
				char e = t[i++];
				switch (e) {
				case 'n': o += '\n'; break;
				case 't': o += '\t'; break;
				case 'r': o += '\r'; break;
				case 'b': o += '\b'; break;
				case 'f': o += '\f'; break;
				case 'u': o += '?'; i += 4; break; // (names are ASCII)
				default: o += e;
				}
			} else o += c;
		}
		if (i >= t.size()) fail("unterminated string");
		i++;
		return o;
	}
	JVal val() {
		ws();
		const size_t b = i;
		JVal v = val1();
		v.begin = b;
		v.end = i;
		return v;
	}
	JVal val1() {
		if (i >= t.size()) fail("unexpected end");
		JVal v;
		char c = t[i];
		if (c == '{') {
			v.kind = JVal::Obj;
			i++;
			ws();
			if (t[i] == '}') { i++; return v; }
			for (;;) {
				ws();
				string k = str();
				ws();
				if (t[i] != ':') fail("expected ':'");
				i++;
				v.o.emplace_back(k, val());
				ws();
				if (t[i] == ',') { i++; continue; }
				if (t[i] == '}') { i++; return v; }
				fail("expected ',' or '}'");
			}
		}
		if (c == '[') {
			v.kind = JVal::Arr;
			i++;
			ws();
			if (t[i] == ']') { i++; return v; }
			for (;;) {
				v.a.push_back(val());
				ws();
				if (t[i] == ',') { i++; continue; }
				if (t[i] == ']') { i++; return v; }
				fail("expected ',' or ']'");
			}
		}
		if (c == '"') { v.kind = JVal::Str; v.s = str(); return v; }
		if (lit("true")) { v.kind = JVal::Bool; v.b = true; return v; }
		if (lit("false")) { v.kind = JVal::Bool; return v; }
		if (lit("null")) return v;
		char* end = nullptr;
		v.n = strtod(t.c_str() + i, &end);
		if (end == t.c_str() + i) fail("bad value");
		v.kind = JVal::Num;
		i = end - t.c_str();
		return v;
	}
};
