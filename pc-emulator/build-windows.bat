@echo off
setlocal enabledelayedexpansion

REM Builds a standalone, zero-dependency 64-bit Windows executable (MSVC /MT /O2)
REM Requires Developer Command Prompt for Visual Studio 2022 (x64)

pushd "%~dp0"

if not exist "..\releases" mkdir "..\releases"
if exist "build_obj" rmdir /s /q "build_obj"
mkdir "build_obj"

echo [1/3] Compiling Windows icon, DPI manifest and PE VersionInfo resource...
rc /nologo /fo build_obj\resource.res src\resource.rc
if errorlevel 1 (
    popd
    exit /b 1
)

echo [2/3] Compiling Dear ImGui + ViceBox X (C++17 /MT /O2)...
cl /nologo /std:c++17 /utf-8 /O2 /MT /EHsc /W3 /DNDEBUG /DUNICODE /D_UNICODE ^
    /Ithird_party\imgui /Ithird_party\imgui\backends /Isrc ^
    /Fobuild_obj\ ^
    src\main.cpp ^
    third_party\imgui\imgui.cpp ^
    third_party\imgui\imgui_draw.cpp ^
    third_party\imgui\imgui_tables.cpp ^
    third_party\imgui\imgui_widgets.cpp ^
    third_party\imgui\backends\imgui_impl_win32.cpp ^
    third_party\imgui\backends\imgui_impl_dx11.cpp ^
    build_obj\resource.res ^
    /link /SUBSYSTEM:WINDOWS /MANIFEST:NO /OPT:REF /OPT:ICF ^
    d3d11.lib d3dcompiler.lib dxgi.lib dwmapi.lib winmm.lib shell32.lib user32.lib gdi32.lib advapi32.lib imm32.lib ole32.lib ^
    /OUT:..\releases\ViceBox-GTA6-Emulator.exe
if errorlevel 1 (
    popd
    exit /b 1
)

echo [3/3] Cleaning temporary object files...
rmdir /s /q "build_obj"

echo.
echo SUCCESS! Built standalone Windows executable:
dir "..\releases\ViceBox-GTA6-Emulator.exe"
popd
