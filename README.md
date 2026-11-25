# PS5 Mobile — Android PS5 UI Shell + Grand Theft Auto V Runtime

A lightweight, hardware-accelerated Android app branded as a PlayStation 5 mobile console experience (adapted from [`khaledOghli/PS5_Online`](https://github.com/khaledOghli/PS5_Online)) featuring **Grand Theft Auto V** as its sole home-screen title, powered under the hood by the live [`playgta5.com`](https://playgta5.com/) WebGPU + 64-bit WebAssembly runtime.

## Prebuilt Signed APK

- **CI-Compiled Signed APK:** [`releases/PS5-Mobile.apk`](releases/PS5-Mobile.apk)
- **Package ID:** `com.ps5.mobile` · Version `2.2.0` (`versionCode 4`) · Android 8.0+ (`minSdk 26`, `targetSdk 34`)

## 100% In-App Fullscreen Landscape COOP/COEP + Memory Fix (v2.2.0)

- **Stays 100% Inside the App (Locked Horizontal Landscape):** Never kicks you out to a vertical browser window! Both the controller-only PS5 Home Screen and GTA V run inside our native fullscreen `sensorLandscape` `GameActivity` with native touch controls, Floating **`D`** Developer Trainer, and live Hardware Stats HUD.
- **Native In-App Cross-Origin Isolation (`WebViewIsolationBridge`):** Uses Chromium Android WebView's official Support Library Boundary Interface (`Profile.setCrossOriginIsolatedAllowList` + `configureIsolatedSites`, shipped in WebView v150+/v156+ & AndroidX WebKit 1.18.0) paired with `shouldInterceptRequest()` injecting `Document-Isolation-Policy: isolate-and-require-corp` on `GET https://playgta5.com` HTML documents — unlocking real `window.crossOriginIsolated === true` and `SharedArrayBuffer` directly inside our landscape WebView while keeping all `.wasm`, `.js`, and `/data/` streams on Chromium's native C++ network stack!
- **Fixes `"no memory"` Inside WebView:** Destroys the PS5 Home WebView (freeing all textures, DOM, and MP3 buffers) *before* creating a clean dedicated GTA V WebView, sets `RENDERER_PRIORITY_IMPORTANT` (never `RENDERER_PRIORITY_BOUND`), and passes `?mem32=1&low=1&cores=2&slots=2` with shadows OFF (`-shadowQuality=-1`).

## Key Features

1. **PS5 Pre-Boot Launcher (`MainActivity`):**
   - Midnight-cobalt PlayStation 5 aesthetic with custom icon & light-wave backdrop.
   - **Discreet `ⓘ` Info Button (top-right):** Transparently discloses that under the hood the app runs the `playgta5.com` GTA V WebGPU/WASM engine inside the PS5 shell.
   - **Low-End Phone Mode Toggle** + live System Load Bar (`30 FPS`, `2 cores`, shadows OFF, reduced RAM cache).
   - **Lower Graphics Override (`POTATO` / `U-LOW` / `LOW` / `MED` / `HIGH`):** Fixes `playgta5.com`'s pause-menu graphics floor by passing genuine RAGE engine flags (`-shadowQuality=-1`, `-textureQuality=0`, `-shaderQuality=0`, `-grassQuality=0`, `-postFX=0`, `-reflectionQuality=0`, `-waterQuality=0`, `-noInGameDOF`, `-fxaa=0`, `-SSAO=0`, `?scale=0.45..1.00`) and syncing `/userdata/settings.xml`.
   - **Numeric Render Distance Control (`Default` or `0`–`100`):** Defaults to GTA V's engine default; lowering the number scales `-lodScale`, `-pedLodBias`, `-vehicleLodBias`, and `-cityDensity` so fewer distant objects, pedestrians, and vehicles load nearby.

2. **Controller-Only PS5 Home Screen (`assets/ps5_ui/index.html` + `Ps5ControllerOverlay`):**
   - Faithful `khaledOghli/PS5_Online` home screen with authentic PS5 navigation sound effects, glowing border animations, trophies card, and **only Grand Theft Auto V** in the library.
   - **Direct screen tapping/dragging is strictly disabled on the PS5 UI** — navigate exclusively with the on-screen DualSense D-Pad (`▲▼◀▶`), **`✕`** (Select / Play Game), **`○`** (Back), and **`⚙ Settings`**.
   - Pressing **`✕`** on **Play Game** (or choosing Story / Sandbox GTA V / Sandbox GTA VI under `•••`) launches GTA V immediately with touch controls unlocked for gameplay (360° look drag, Fire Drag-to-Aim, On-Foot / Drive / Fly layouts, TAP menu mode).

3. **Hardware Statistics Viewer (`StatsMonitor` + `StatsHudView`):**
   - Live floating telemetry overlay showing **FPS**, **CPU % + MHz**, **GPU %** (Adreno/Mali/MediaTek kernel sensor probe when available), and **RAM used/total GB + app PSS MB**.
   - Togglable ON/OFF (master + per metric) anytime from **PS5 Settings (`⚙`)** while the PS5 emulator is running.

4. **Floating `D` Developer Trainer (`DeveloperTrainerOverlay`):**
   - Draggable floating **`D`** button opening a 5-tab trainer powered by GTA V's native PC `~` (`Backquote`) cheat console inside `playgta5.com`:
     - **Vehicles:** Instant spawners for Buzzard, Comet, Rapid GT, PCJ-600, Sanchez, BMX, Stunt Plane, Duster, Limo, Trashmaster, Golf Cart, Duke O'Death, Dodo, and Kraken Sub.
     - **Weapons:** Give All Weapons + Ammo (`TOOLUP`), Full Health + Armor + Car Repair (`TURTLE`), Explosive Ammo, Fire Bullets, Explosive Melee, Slow-Mo Aim, Parachute, plus quick Sandbox GTA V / VI launchers.
     - **Player & Fly:** God Mode (`PAINKILLER`) with optional Auto-Renew, Free Fly / Skyfall (`SKYFALL`), Super-Jump + Moon-Gravity Float Fly combo, Wanted Level, Fast Run/Swim, Drift, Slow-Mo, Weather.
     - **Graphics & LOD:** Live preset/shadows/scale/FPS/Render Distance tuning + one-tap Apply & Reload.
     - **Dev:** Custom GTA V cheat console runner, Debug Draw Isolation (`?dbg=1`), Stats toggle, and Return to PS5 Home.

## Building From Source

```bash
chmod +x scripts/build-apk.sh
./scripts/build-apk.sh releases/PS5-Mobile.apk
```
