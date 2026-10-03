#!/bin/sh
# Builds clipfinder from src/ with g++ or clang++ (Linux, macOS, or Windows
# with MSYS2 / MinGW). For Visual Studio on Windows, use build.bat.
#
#   sh tools/clipfinder/build.sh
#
# Environment:
#   CXX=compiler   the compiler (default: g++, clang++ or c++ on the PATH, then
#                  MSYS2's C:\msys64\mingw64\bin\g++.exe)
#   OUT=path       where the binary goes (default: clipfinder.exe on Windows,
#                  clipfinder elsewhere, next to this script), e.g. to build a
#                  copy while clipfinder.exe is running
#
# -ffp-contract=off keeps the f32 maths from being fused into multiply-adds,
# which would change results. -flto lets the hot collision functions inline
# across the source files. On Windows the exe is static, so it runs without
# the MinGW DLLs.
set -e
cd "$(dirname "$0")"

case "$(uname -s)" in
	MINGW*|MSYS*|CYGWIN*|Windows_NT) WINDOWS=1 ;;
	*) WINDOWS= ;;
esac

if [ -z "$CXX" ]; then
	for c in g++ clang++ c++; do
		if command -v "$c" >/dev/null 2>&1; then CXX="$c"; break; fi
	done
fi
if [ -z "$CXX" ] && [ -x /c/msys64/mingw64/bin/g++.exe ]; then
	CXX=/c/msys64/mingw64/bin/g++.exe
	# (its DLLs, for the compiler itself)
	PATH="/c/msys64/mingw64/bin:$PATH"
	export PATH
fi
if [ -z "$CXX" ]; then
	echo "build.sh: no C++ compiler found. Install g++ or clang++ (on Windows: MSYS2's" >&2
	echo "mingw-w64-x86_64-gcc, or use build.bat with Visual Studio), or set CXX." >&2
	exit 1
fi

FLAGS="-O2 -std=c++17 -ffp-contract=off -pthread"
# (clang has no -flto=auto)
if "$CXX" --version 2>/dev/null | grep -qi clang; then FLAGS="$FLAGS -flto"; else FLAGS="$FLAGS -flto=auto"; fi
if [ -n "$WINDOWS" ]; then
	FLAGS="$FLAGS -static"
	OUT="${OUT:-clipfinder.exe}"
else
	OUT="${OUT:-clipfinder}"
fi

echo "$CXX $FLAGS -o $OUT src/*.cpp"
# shellcheck disable=SC2086
"$CXX" $FLAGS -o "$OUT" src/*.cpp
echo "built $OUT"
