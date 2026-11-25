#!/usr/bin/env bash
set -euo pipefail

ZIG_BIN="${ZIG_BIN:-/tmp/zig-env/ziglang/zig}"
ROOT_DIR="$(cd "$(dirname "$0")/.." && pwd)"
PC_DIR="$ROOT_DIR/pc-emulator"
OBJ_DIR="/tmp/vicebox_obj"
OUT_EXE="$ROOT_DIR/releases/ViceBox-GTA6-Emulator.exe"

mkdir -p "$ROOT_DIR/releases" "$OBJ_DIR"
rm -rf "$OBJ_DIR"/*

echo "[1/3] Compiling Windows icon, DPI manifest & VersionInfo resource via zig rc..."
(
  cd "$PC_DIR/src"
  "$ZIG_BIN" rc /fo "$OBJ_DIR/resource.res" resource.rc
)

echo "[2/3] Cross-compiling Dear ImGui + ViceBox X v2.0 (x86_64-windows-gnu, C++17, -O2)..."
"$ZIG_BIN" c++ \
  -target x86_64-windows-gnu \
  -std=c++17 -O2 -DNDEBUG -DUNICODE -D_UNICODE \
  -I"$PC_DIR/third_party/imgui" \
  -I"$PC_DIR/third_party/imgui/backends" \
  -I"$PC_DIR/src" \
  -Wno-deprecated-declarations \
  "$PC_DIR/src/main.cpp" \
  "$PC_DIR/third_party/imgui/imgui.cpp" \
  "$PC_DIR/third_party/imgui/imgui_draw.cpp" \
  "$PC_DIR/third_party/imgui/imgui_tables.cpp" \
  "$PC_DIR/third_party/imgui/imgui_widgets.cpp" \
  "$PC_DIR/third_party/imgui/backends/imgui_impl_win32.cpp" \
  "$PC_DIR/third_party/imgui/backends/imgui_impl_dx11.cpp" \
  "$OBJ_DIR/resource.res" \
  -Wl,--subsystem,windows \
  -Wl,--strip-all \
  -ld3d11 -ld3dcompiler_47 -ldxgi -ldwmapi -lwinmm -lwinhttp -lws2_32 -lpdh -lcomdlg32 -lshell32 -luser32 -lgdi32 -ladvapi32 -limm32 -lole32 -luuid \
  -o "$OUT_EXE"

echo "[3/3] Cleaning build artifacts..."
rm -rf "$OBJ_DIR" "${OUT_EXE%.exe}.pdb"

ls -lh "$OUT_EXE"
echo "SUCCESS! Built $OUT_EXE"
