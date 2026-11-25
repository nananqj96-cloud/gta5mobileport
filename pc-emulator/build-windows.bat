@echo off
setlocal enabledelayedexpansion

REM Builds a standalone, zero-dependency 64-bit Windows executable (MSVC /MT /O2)
REM Requires Developer Command Prompt for Visual Studio 2022 (x64)

set ROOT=%~dp0
set IMGUI=%ROOT%third_party\imgui
set SRC=%ROOT%src
set OUT_DIR=%ROOT%..\releases
set OBJ_DIR=%ROOT%build_obj

if not exist "%OUT_DIR%" mkdir "%OUT_DIR%"
if exist "%OBJ_DIR%" rmdir /s /q "%OBJ_DIR%"
mkdir "%OBJ_DIR%"

echo [1/3] Compiling Windows icon, DPI manifest & PE VersionInfo resource...
rc /nologo /fo "%OBJ_DIR%\resource.res" "%SRC%\resource.rc"
if errorlevel 1 exit /b 1

echo [2/3] Compiling Dear ImGui + ViceBox X (C++17 /MT /O2)...
cl /nologo /std:c++17 /utf-8 /O2 /MT /EHsc /W3 /DNDEBUG /DUNICODE /D_UNICODE ^
    /I"%IMGUI%" /I"%IMGUI%\backends" /I"%SRC%" ^
    /Fo"%OBJ_DIR%\\" ^
    "%SRC%\main.cpp" ^
    "%IMGUI%\imgui.cpp" ^
    "%IMGUI%\imgui_draw.cpp" ^
    "%IMGUI%\imgui_tables.cpp" ^
    "%IMGUI%\imgui_widgets.cpp" ^
    "%IMGUI%\backends\imgui_impl_win32.cpp" ^
    "%IMGUI%\backends\imgui_impl_dx11.cpp" ^
    "%OBJ_DIR%\resource.res" ^
    /link /SUBSYSTEM:WINDOWS /OPT:REF /OPT:ICF ^
    d3d11.lib dxgi.lib dwmapi.lib winmm.lib shell32.lib user32.lib gdi32.lib advapi32.lib imm32.lib ^
    /OUT:"%OUT_DIR%\ViceBox-GTA6-Emulator.exe"
if errorlevel 1 exit /b 1

echo [3/3] Cleaning temporary object files...
rmdir /s /q "%OBJ_DIR%"

echo.
echo SUCCESS! Built standalone Windows executable:
dir "%OUT_DIR%\ViceBox-GTA6-Emulator.exe"
