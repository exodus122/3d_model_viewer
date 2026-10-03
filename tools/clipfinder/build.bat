@echo off
rem Builds clipfinder.exe from src\ with Visual Studio's C++ compiler (cl).
rem Run it from anywhere: if cl isn't on the PATH (a Developer Command
rem Prompt), it finds Visual Studio with vswhere and sets it up.
rem
rem   tools\clipfinder\build.bat [output.exe]
rem
rem The default output is clipfinder.exe next to this file. Give another path
rem to build a copy while clipfinder.exe is running.
rem
rem No /arch:AVX2 and no /fp:fast: the f32 maths mustn't be fused into
rem multiply-adds or reordered, which would change results. /GL + /LTCG let the
rem hot collision functions inline across the source files.
setlocal
cd /d "%~dp0"

where cl >nul 2>nul
if not errorlevel 1 goto build

rem (gotos, not ( ) blocks: the ")" in ProgramFiles(x86) would end a block)
set "VSWHERE=%ProgramFiles(x86)%\Microsoft Visual Studio\Installer\vswhere.exe"
if not exist "%VSWHERE%" goto novs
set "VSDIR="
for /f "usebackq delims=" %%i in (`call "%%VSWHERE%%" -latest -products * -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath`) do set "VSDIR=%%i"
if not defined VSDIR goto novs
if not exist "%VSDIR%\VC\Auxiliary\Build\vcvars64.bat" goto novs
call "%VSDIR%\VC\Auxiliary\Build\vcvars64.bat" >nul
where cl >nul 2>nul
if errorlevel 1 goto novs

:build
set "OUT=%~1"
if "%OUT%"=="" set "OUT=clipfinder.exe"
if not exist build\msvc mkdir build\msvc
cl /nologo /O2 /GL /EHsc /std:c++17 /utf-8 /fp:precise /MT src\*.cpp /Fobuild\msvc\ /Fe"%OUT%" /link /LTCG
if errorlevel 1 exit /b 1
echo built %OUT%
exit /b 0

:novs
echo build.bat: no Visual Studio C++ compiler found. Install Visual Studio, or its
echo Build Tools, with "Desktop development with C++". Or build with g++ / clang++:
echo   sh tools/clipfinder/build.sh
exit /b 1
