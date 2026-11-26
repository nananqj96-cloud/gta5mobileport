# Grand Theft Auto VI — Experimental Mode UI & Visual Specification (`UI_SPEC.md`)

**Target Engine:** `playgta5` WebAssembly + WebGPU RAGE Fork (`ViceBox X v2.6` Experimental GTA 6 Mode)  
**Minimum Target GPU:** NVIDIA GeForce GTX 1050 (2–4 GB VRAM) — 1080p @ 60 FPS (`16.67 ms` frame budget)  
**Scope:** Applies strictly when **Developer Settings → `Experimental GTA 6`** is enabled. Story Mode remains disabled (`To Be Continued`) and untouched; **Sandbox Mode** is the active playable mode.

---

## 1. Visual Reference Inventory (Stored in Drive Folder `playgta5-gta6`)

| Reference Filename | Source / Subject | Key Visual Elements Extracted |
|---|---|---|
| `ref_01_keyart_wide.webp` | Official Rockstar GTA VI landscape key art (Lucia & Jason on car hood, Vice City palm sunset) | Hero sunset palette (`#FF6E8E`, `#FFB36B`, `#5F3B78`, `#1C152B`), white GTA stacked logo + outlined `VI`, Lucia ponytail & Jason sleeveless tank silhouettes |
| `ref_02_lucia_jason_portrait.jpg` | Official Rockstar Lucia Caminos & Jason Duval sunset beach portrait | Character art for Main Menu & Pause `JASON & LUCIA` tab; coral/violet rim lighting; Lucia ponytail hair volume & gold hoop earrings; Jason white tank + Marauder tattoo |
| `ref_03_weapon_wheel_hud.jpg` | Real 2026 GTA 6 PS5 gameplay weapon wheel & HUD capture | Top-left 3-bar vitals (Pink Health, Mint Stamina, Violet Focus), top-right Bank/Cash, 8-card rectangular octagonal weapon wheel with `[R1] WEAPONS | ITEMS`, cyan active ammo glow, white border + pink top glow on selection, bottom-left quick consumables |
| `ref_04_minimap_3d_2d.webp` | 2026 GTA 6 HUD 2D & 3D minimap comparison | Pink GPS route (`#F04A98`), white player chevron inside dark halo, orbiting `N` compass badge, 2D top-down + 3D perspective building extrusion toggle |
| `ref_05_pause_menu_map.jpg` | Real 2026 GTA 6 PS5 Pause Menu capture (`VICE-DALE COUNTY` / `MARIANA COUNTY`) | Midnight navy `#141933` backdrop, top header (`1:37 pm`, `[L1] JASON & LUCIA | MAP | BRIEF | PROGRESS [R1]`, pink active underline, `$407`), left vertical icon filter rail, bottom-right control legend |
| `ref_06_phone_and_minimap.jpg` | Real 2026 GTA 6 PS5 Smartphone & live in-game minimap capture | Exact bottom-left rounded-rectangle minimap (`#5DA8C8` water, `#6C9589` land, `#F04A98` safehouse blip, orbiting `N`), brushed-silver smartphone (`3:35 pm · ☀ 80°`, dark `Reminders` banner, 10 circular app icons incl. `WhatUp`, `WAiNK`, selected app pill) |
| Rockstar Official Asset Gist (`mrdarrengriffin/e462ff06e4cf25c0dfbaee9e19076455`) | Rockstar Games `rockstargames.com/VI` official media index | Confirmed official hero parallax layers (`Hero_BG`/`Hero_FG`), `VIstack.svg`, `gtaLogoGlow.png`, `visit-leonida.svg`, location posters |

> **Honest Capture Note:** Because this sandbox cannot run `yt-dlp`/`ffmpeg` against `youtube.com` directly and no `image-1.png` was attached to the workspace/Drive, the specification above was compiled directly from verified official Rockstar GTA VI media and real 2026 PS5 gameplay HUD/pause/phone screenshots inspected pixel-by-pixel.

---

## 2. Color System (Exact Hex Tokens)

| Token | Hex | Usage |
|---|---|---|
| `--vi-pink` | `#F04A98` | Primary Vice accent: active Pause tab underline, GPS route line, safehouse blip, wheel hover glow |
| `--vi-pink-soft` | `#F4A5C4` | Top-left **Health** bar fill & heart glyph |
| `--vi-mint` | `#67E8D0` | Top-left **Stamina** bar fill & bolt glyph; equipped weapon card bottom glow (`#38E8C8`) |
| `--vi-violet` | `#9C85FF` | Top-left **Focus** bar fill & eye glyph; bank coin emblem |
| `--vi-coral` | `#FF9E6D` | Sunset highlight / Vice volumetric glow / warm menu gradient |
| `--vi-gold` | `#FFD166` | Leonida golden-hour sun rim, focus booster icon, achievement highlight |
| `--vi-cash-green` | `#4ADE80` | Cash icon & currency pickup flashes |
| `--vi-wanted-red` | `#FF2E63` | Active wanted pulse, crime search zone tint on minimap |
| `--vi-navy-bg` | `#141933` | Pause menu ocean / full-screen backdrop (`rgba(20, 25, 51, 0.94)`) |
| `--vi-bar-bg` | `#0F1324` | Top pause bar & glass card fills (`rgba(15, 19, 36, 0.88)`) |
| `--vi-map-water` | `#5DA8C8` | Minimap shallow turquoise ocean (`#3B84A8` deep water) |
| `--vi-map-land` | `#6C9589` | Minimap coastal sage terrain (`#557D73` parks, `#D8CCA6` beach sand) |
| `--vi-map-road` | `#3B424E` | Arterial streets (`#C5CDD4` major avenues / highways, `#262B36` city blocks) |
| `--vi-text-hi` | `#FFFFFF` | Primary labels, weapon titles, cash counters |
| `--vi-text-mid` | `#C8CDD6` | Secondary subtitles (`SIDEARM`, timestamps, hints) |

---

## 3. Typography & Spacing Scale

- **Display / Headers / Menu Buttons:** Condensed bold geometric sans (`'Bahnschrift SemiCondensed'`, `'DIN Alternate'`, `'Segoe UI Variable Display'`, `sans-serif`), uppercase, `letter-spacing: 0.08em`–`0.14em`.
- **HUD Numerals & Telemetry:** Tabular numerals (`font-variant-numeric: tabular-nums`), `700` weight, crisp `0 1px 4px rgba(0,0,0,0.75)` shadow.
- **Safe Zone Margin:** `28px` outer viewport padding (`24px` compact below `1280px` width).

---

## 4. Screen-by-Screen UI Specifications

### 4.1 Boot Intro Sequence (`0.0s – 5.2s`, Skippable Any Key/Click)
1. Checks `/vbx/user/gta6_intro.mp4` first (if user placed a local intro MP4 in `%APPDATA%\ViceBoxX\gta6_intro.mp4`, plays natively with `<video>`).
2. Otherwise plays a 60 FPS GPU-light Canvas + WebAudio Vice City neon intro:
   - `0.0s–1.6s`: Pure `#000000` → Rockstar-inspired Vice neon gold/magenta flash card (`R★` stylized emblem pulse + sub-bass synth swell).
   - `1.6s–4.4s`: Animated Leonida twilight palm silhouettes + glowing outlined **`VI`** reveal with stacked **`GRAND THEFT AUTO`** wordmark (`ref_01_keyart_wide.webp` palette).
   - `4.4s–5.2s`: Cross-dissolve (`500ms ease-out`) into the GTA VI Main Menu.
   - Bottom-right subtle prompt (`PRESS ANY KEY OR CLICK TO SKIP`, opacity `0.62`), clean black logo fallback if canvas fails.

### 4.2 Main Menu (Post-Intro, Full Mouse + Keyboard + Gamepad)
- **Background:** Full-bleed `ref_01_keyart_wide.webp` (`object-fit: cover`) with gentle `1.04x` slow Ken Burns + mouse parallax (`±10px`), left-side readable dark sunset scrim (`linear-gradient(90deg, rgba(12,10,24,0.88) 0%, rgba(12,10,24,0.48) 46%, rgba(12,10,24,0.12) 100%)`).
- **Top-Left Brand:** Official GTA VI stacked logo + subtle `LEONIDA SANDBOX BUILD · EXPERIMENTAL` micro-tag.
- **Left Vertical Navigation Stack (`left: 56px`, width `360px`, gap `12px`):**
  1. **`PLAY SANDBOX`** — Primary active button (`height: 58px`, `#F04A98` → `#FF7A6B` gradient hover bar, instant white glow + `translateX(8px)` hover slide, `150ms cubic-bezier(0.2, 0.9, 0.3, 1)`). Includes compact map sub-selector pill (**Leonida / Main Map** vs **Vice Test Map `env_test`**).
  2. **`STORY MODE`** — **Explicitly Disabled** (`disabled`, `opacity: 0.48`, `cursor: not-allowed`, dark frosted glass, padlock icon + right badge **`TO BE CONTINUED`**). Clicking produces no Story Mode launch.
  3. **`PROTAGONIST: LUCIA / JASON`** — Interactive toggle card with cropped `ref_02_lucia_jason_portrait.jpg` avatar preview and active physics badge.
  4. **`SETTINGS`** — Opens sleek right-side Leonida Glass Settings Drawer (includes **`Performance: Auto`** [Default ON], Vice Lighting, Motion Blur, Hair/Cloth Physics, Minimap 2D/3D, Look Sensitivity, Show FPS/Frame-Time).
  5. **`EXIT TO CONSOLE`** — Navigates cleanly back to PS5 / Xbox / ViceOS Neo inside the ViceBox X viewport.
- **Preload Architecture:** While the intro & Main Menu display, `playgta5`'s WASM/WebGPU sandbox engine can immediately begin pre-initializing behind the menu upon clicking `PLAY SANDBOX`, with a smooth Leonida sunset loading progress bar (`0% → 100%`) before fading out into live 3D gameplay.

### 4.3 Sandbox HUD (Four-Corner Minimalist Layout — `ref_03` & `ref_06`)
- **Top-Left Vitals (`top: 26px, left: 28px`, width `186px`, gap `7px`):**
  - 3 rows, each `14px` tall: `14px` crisp monochrome SVG icon (`Heart`, `Bolt`, `Eye`) + `160px × 6px` rounded-pill bar (`border-radius: 3px`, track `rgba(12, 15, 24, 0.58)`):
    - Health: `#F4A5C4` (smooth `180ms` lerp)
    - Stamina: `#67E8D0` (drains on sprint, regenerates after `1.2s`)
    - Focus: `#9C85FF` (toggled via `C` / `L3+R3`, pulses violet edge vignette + WebGPU focus grade)
- **Top-Right Economy, Ammo & Wanted (`top: 24px, right: 28px`):**
  - Bank balance (`$15,150` + purple circle `b` icon) & Cash (`$700` + green bill icon), `20px` bold condensed white.
  - Active Weapon Ammo (`20` pure white + `/ 80` `#A8B0C2`) when weapon drawn.
  - **6-Star Wanted Row** (six `16px` crisp stars; active stars pulse `#FFFFFF` ↔ `#FF2E63` at `2.4 Hz`) + **6 Police Intel Clue Badges** beneath (`Face`, `Clothes`, `Vehicle`, `Weapon`, `CCTV`, `Couple`).
- **Bottom-Left Minimap (`bottom: 24px, left: 26px` — Centerpiece, `ref_04` & `ref_06`):**
  - Shape: Rounded rectangle (`border-radius: 10px`, `248 × 152 px` driving / `224 × 138 px` on foot / `340 × 215 px` expanded via `Z`).
  - Modes: **2D Top-Down** and **3D Perspective Tilt** (`rotateX(34deg)` perspective projection + extruded rooftop blocks, toggleable via `N` or Pause Menu).
  - Map Palette: `#5DA8C8` shallow water, `#3B84A8` deep water, `#6C9589` land, `#557D73` parks, `#D8CCA6` beaches, `#3B424E` streets, `#C5CDD4` highways, `#F04A98` GPS route (`3.5px` bright pink with subtle glow).
  - Rotation & Zoom: Smooth damped heading rotation (`lerp factor 10/s`) driven by real camera yaw + smooth speed-based zoom (`1.0x` on foot → `0.68x` high speed).
  - Orbiting **`N`** North badge pinned cleanly to the minimap perimeter + left-edge cyan sonar/radar pulse ring + dark-halo white directional player chevron + custom SVG blips (`Safehouse`, `Ammu-Nation`, `Garage`, `Vice Beach`, `Airport`, `Waypoint`) + live GPS distance readout (`1.42 mi`).
  - Wanted behavior: **No police dots on radar** — flashes red-pink border (`#FF2E63`) + translucent red search zone tint instead!
- **Weapon Wheel (`Tab` / `Q` / `LB` Hold — Exact `ref_03` Match):**
  - Backdrop: Full-screen `rgba(10, 12, 20, 0.36)` + `backdrop-filter: blur(10px)` (`140ms` fade).
  - Top center: `[R1]` badge + segmented pills **`WEAPONS`** (white bg `#FFF`, `#111` text) | **`ITEMS`** (dark glass `rgba(20,24,36,0.78)`, `#FFF` text).
  - 8 rectangular glass slots (`124 × 74 px`, `border-radius: 3px`) evenly placed around a `210px` radius ring connected by a subtle `1px rgba(255,255,255,0.22)` circle:
    - Equipped slot: subtle `#38E8C8` bottom gradient glow + dark `20px` ammo footer (`20 80`).
    - Hovered/active slot: crisp `2px solid #FFFFFF` border + subtle `#FF5CA8` top glow + `scale(1.04)` (`110ms ease-out`).
    - Empty slots: subtle `+` centered glyph.
  - Center readout: Uppercase weapon title (`22px` bold `#FFF`) + category subtitle (`13px` `#C8CDD6`, e.g., `SIDEARM`, `ASSAULT RIFLE`, `SMG`).
  - Bottom-left consumables: `[□] Health Medkit (2 ♥)` and `[△] Focus Booster (2 ⚡)`.
- **Pause Menu (`P` / `Start` — Exact `ref_05` Match):**
  - Deep midnight-navy translucent overlay (`rgba(16, 20, 42, 0.93)`).
  - `56px` top bar: Clock (`1:37 pm`) | `[L1]` **`JASON & LUCIA`** · **`MAP`** · **`BRIEF`** · **`PROGRESS`** · **`SETTINGS`** `[R1]` (active tab `#F04A98` + `2px` bottom bar) | Cash (`$15,850`).
  - `MAP` tab includes left vertical icon filter rail (`48px` wide, active white tile with `3px #F04A98` left bar), interactive pan/zoom Vice-Dale & Mariana County map, click-to-place pink waypoint, and bottom-right control legend.
- **Leonida Smartphone (`ArrowUp` / `K` / `D-Pad Up` — Exact `ref_06` Match):**
  - Bottom-right `248 × 468 px` brushed-silver titanium bezel (`border-radius: 32px`), slides up `220ms cubic-bezier(0.18, 0.9, 0.25, 1)`.
  - Status bar (`3:35 pm` | `☀ 80°`), frosted dark `Reminders` card, 4-column circular app grid (`WhatUp`, `Phone`, `Camera`, `Music`, `Gallery`, `WAiNK`, `News`, `Weather`, `Leonida`, `Settings`), bottom dark pill showing focused app title!
- **Slide-In Notifications & Vehicle Scan Card (`ref_06`):**
  - Dark violet-charcoal header (`#2A2738`) + cream rows (`#EAE6DC`, dark `#1D1B24` text) for vehicle/world inspect notices (`ACCESS`, `SECURITY`, `TRACKER`), sliding in cleanly from bottom-right (`180ms`).
