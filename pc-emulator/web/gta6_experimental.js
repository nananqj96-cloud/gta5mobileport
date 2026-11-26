// ==================== VICEBOX X — EXPERIMENTAL GTA 6 SANDBOX ENGINE ====================
// Activates ONLY when Developer Settings -> "Experimental GTA 6" is enabled (?vbx_gta6=1).
// Implements Phase 3 (Boot Sequence + Main Menu), Phase 4 (2026 GTA VI HUD, Minimap,
// 8-Card Rectangular Weapon Wheel, Pause Menu, Leonida Smartphone, Notifications),
// Phase 5 (Lucia & Jason Character System, Low-Bone Spring Hair/Cloth Physics, WebGPU Lighting
// & Motion Blur bridge), and Phase 6 (Performance: Auto GTX 1050 60 FPS optimizer + FPS/ms telemetry).
(function initExperimentalGta6() {
  'use strict';
  if (window.__VBX_GTA6_EXP_LOADED) return;

  const qs = new URLSearchParams(window.location.search);
  const isGta6Exp = qs.get('vbx_gta6') === '1';
  if (!isGta6Exp) return;

  // Always run the dedicated non-COEP /gta6/boot startup video sequence (real z_RUhg96MiI
  // Rockstar Games Logo Intro) on fresh launch unless already completed or switching maps!
  if (qs.get('vbx_intro_done') !== '1' && qs.get('vbx_skip_intro') !== '1') {
    window.location.replace('/gta6/boot' + window.location.search);
    return;
  }
  window.__VBX_GTA6_EXP_LOADED = true;

  // ==================== PHASE 6: QUIET GTX 1050 PERFORMANCE: AUTO PRE-INIT ====================
  const STORE_KEY = 'vbx_gta6_exp_v29';
  const defaultSettings = {
    perfAuto: true,            // Default ON — quiet GTX 1050 60 FPS @ 1080p optimizer
    viceLighting: 92,          // 0..100
    motionBlur: 85,            // 0..100
    bloom: 72,                 // 0..100
    sunShafts: 45,             // 0..100
    hairClothPhysics: true,    // Lucia ponytail + Jason jacket spring physics
    minimap3D: true,           // True 3D perspective satellite-style iFruit radar vs 2D flat radar
    minimapTheme: 'auto',      // 'auto' | 'light' | 'dark' (Day / Night plate)
    navMode: 'on',             // 'on' (Always On) | 'dynamic' (GTA VI Dynamic fade) | 'compass' (Compass only)
    showCompanionRig: false,   // Optional live corner hair/cloth physics mini-monitor
    showFpsCounter: false,     // Dev FPS & frame-time ms pill
    character: 'lucia',        // 'lucia' | 'jason'
    outfitIdx: 0,
    sandboxMap: qs.get('map') === 'gta5' ? 'main' : 'env_test',
    weather: 'sunset',         // 'sunset' | 'noon' | 'night' | 'storm'
    radioStation: 'VICE CITY FM',
    lookSensitivity: Math.max(20, Math.min(300, parseInt(qs.get('vbx_sens') || '100', 10) || 100))
  };

  let cfg = Object.assign({}, defaultSettings);
  try {
    const saved = JSON.parse(localStorage.getItem(STORE_KEY) || '{}');
    cfg = Object.assign({}, defaultSettings, saved);
    if (qs.get('vbx_perf_auto') === '0') cfg.perfAuto = false;
    if (qs.get('vbx_perf_auto') === '1') cfg.perfAuto = true;
    // Always sync sandboxMap to the active URL query on page load so we never reload unexpectedly!
    if (qs.get('map') === 'env_test') cfg.sandboxMap = 'env_test';
    else if (qs.get('mode') === 'sandbox' && !qs.get('map')) cfg.sandboxMap = 'main';
  } catch (e) {}

  function saveCfg() {
    try { localStorage.setItem(STORE_KEY, JSON.stringify(cfg)); } catch (e) {}
    syncFxToWgpu();
    try {
      fetch('/vbx/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          devPerfAuto: !!cfg.perfAuto,
          lookSensitivity: cfg.lookSensitivity,
          motionBlur: cfg.motionBlur > 0,
          motionBlurStrength: cfg.motionBlur
        })
      }).catch(() => {});
    } catch (e) {}
  }

  // Quietly clamp HiDPI devicePixelRatio to 1.0 when Performance: Auto is ON
  // so 1080p stays genuine 1080p on GTX 1050 (2-4GB VRAM) even with Windows 125%-150% DPI scaling.
  if (cfg.perfAuto) {
    try {
      Object.defineProperty(window, 'devicePixelRatio', {
        configurable: true,
        get: () => 1.0
      });
    } catch (e) {}
  }

  // ==================== LIVE GAMEPLAY & ENGINE RUNTIME STATE ====================
  const state = {
    phase: 'intro', // 'intro' | 'menu' | 'loading' | 'playing'
    worldReady: false,
    realFramesSeen: 0,
    loadPct: 1,
    loadLabel: 'Initializing RAGE WebAssembly & WebGPU...',
    loadDl: '',
    loadConsole: '',
    loadError: '',
    dataBytes: 0,
    worldBaseBytes: -1,
    dlSamples: [],
    compilingCount: -1,
    lastEngineActivity: performance.now(),
    rawEngineVisible: false,
    choiceReady: false,
    // Player spatial & kinesthetic state (starts right on Ocean Drive / Vice Strip avenue!)
    posX: 680,
    posY: 880,
    heading: 0.0,         // radians (0 = North, +PI/2 = East)
    smoothHeading: 0.0,
    speed: 0,             // 0..1 normalized
    smoothZoom: 1.0,
    camVelX: 0,
    camVelY: 0,
    inVehicle: false,
    // Vitals (exact 2026 top-left bars)
    health: 100,
    stamina: 100,
    focus: 88,
    focusActive: false,
    focusMix: 0,
    // Economy & Wanted (exact 2026 top-right)
    bank: 15150,
    cash: 700,
    wantedStars: 0,
    wantedClues: { face: false, outfit: false, vehicle: false, weapon: false, cctv: false, couple: false },
    // Weapons & Items (exact 8-card rectangular octagonal wheel)
    wheelOpen: false,
    wheelTab: 'weapons', // 'weapons' | 'items'
    equippedWeapon: 0,
    hoveredSlot: 0,
    medkits: 2,
    focusShots: 2,
    // Minimap & Waypoint (snapped cleanly to real street intersection!)
    minimapExpanded: false,
    waypoint: { x: 1040, y: 340, name: 'OCEAN BEACH · VICE STRIP' },
    cachedRoute: null,
    cachedRouteKey: '',
    // Pause Menu & Phone
    pauseOpen: false,
    pauseTab: 'map',     // 'character' | 'map' | 'brief' | 'progress' | 'settings'
    mapFilter: 'layers',
    mapPanX: 0,
    mapPanY: 0,
    mapZoom: 1.0,
    phoneOpen: false,
    phoneApp: null,      // null = home grid, or app id
    phoneSelectedIdx: 0,
    // Brief / Notifications
    briefLog: [
      { time: '1:34 pm', title: 'LEONIDA SANDBOX', body: 'Welcome to Vice-Dale County. Hold TAB (L1) for Loadout, P (OPTIONS) for Pause/Map, ↑ for Phone, ↓ to summon HUD, CAPS for Focus, M for 3D/2D Radar, F9 for PS5.' },
      { time: '1:35 pm', title: 'JASON DUVAL · WhatUp', body: 'Car is gassed up down on Ocean Beach. Follow the pink GPS across the Starfish Causeway whenever you are ready.' }
    ],
    // Real Telemetry from wgpu_worker.js + game-fps
    fps: 0,
    frameMs: 0,
    perfTier: 0,
    resW: 1920,
    resH: 1080,
    draws: 0,
    // Input keys & GTA VI Dynamic HUD reveal timer
    keys: Object.create(null),
    hudPulseT: 10.0,
    gameMinutes: 13 * 60 + 37 // 1:37 pm
  };

  const WEAPONS = [
    { id: 'pistol',   name: '9MM PISTOL',     cat: 'SIDEARM',       mag: 20, res: 80,  slotKey: '2', icon: 'pistol' },
    { id: 'smg',      name: 'MICRO SMG',      cat: 'SUBMACHINE',    mag: 30, res: 180, slotKey: '3', icon: 'smg' },
    { id: 'unarmed',  name: 'UNARMED',        cat: 'MELEE',         mag: 0,  res: 0,   slotKey: '1', icon: 'fist' },
    { id: 'binoc',    name: 'BINOCULARS',     cat: 'RECON',         mag: 0,  res: 0,   slotKey: '0', icon: 'binoc' },
    { id: 'empty4',   name: 'EMPTY SLOT',     cat: 'TRUNK STORAGE', mag: 0,  res: 0,   slotKey: null, empty: true },
    { id: 'shotgun',  name: 'PUMP SHOTGUN',   cat: 'SHOTGUN',       mag: 8,  res: 48,  slotKey: '4', icon: 'shotgun' },
    { id: 'rifle',    name: 'CARBINE RIFLE',  cat: 'ASSAULT RIFLE', mag: 30, res: 210, slotKey: '5', icon: 'rifle' },
    { id: 'empty7',   name: 'EMPTY SLOT',     cat: 'TRUNK STORAGE', mag: 0,  res: 0,   slotKey: null, empty: true }
  ];

  const ITEMS = [
    { id: 'mask',     name: 'SKI MASK',       cat: 'CONCEALMENT',   equipped: false, icon: 'mask' },
    { id: 'cap',      name: 'LEONIDA CAP',    cat: 'HEADWEAR',      equipped: false, icon: 'cap' },
    { id: 'shades',   name: 'AVIATORS',       cat: 'EYEWEAR',       equipped: true,  icon: 'shades' },
    { id: 'armor',    name: 'KEVLAR VEST',    cat: 'PROTECTION',    equipped: false, icon: 'armor' },
    { id: 'bandana',  name: 'BANDANA',        cat: 'CONCEALMENT',   equipped: false, icon: 'mask' },
    { id: 'medkit',   name: 'TRAUMA KIT',     cat: 'RESTORE HP',    equipped: false, icon: 'med' },
    { id: 'booster',  name: 'FOCUS SHOT',     cat: 'RESTORE FOCUS', equipped: false, icon: 'bolt' },
    { id: 'empty_i',  name: 'EMPTY SLOT',     cat: 'POCKET',        empty: true }
  ];

  const CHARACTERS = {
    lucia: {
      name: 'LUCIA CAMINOS',
      short: 'LUCIA',
      role: 'Vice-Dale Driver & Enforcer',
      outfits: ['Vice Sunset Tank & Cargo', 'Ocean Beach Denim', 'Leonida Night Jacket'],
      accent: '#F04A98',
      hairColor: '#2A181B',
      hairHi: '#5A323A',
      jacketColor: '#E13D7D'
    },
    jason: {
      name: 'JASON DUVAL',
      short: 'JASON',
      role: 'Ex-Army Marauder & Wheelman',
      outfits: ['White Ribbed Tank & Olive Cargo', 'Vice Floral Open Shirt', 'Keys Highway Denim'],
      accent: '#67E8D0',
      hairColor: '#4A3828',
      hairHi: '#745B42',
      jacketColor: '#2E6F78'
    }
  };

  const BLIPS = [
    { id: 'home',   x: 680,  y: 700,  type: 'home',   color: '#F04A98', label: 'SAFEHOUSE · MOTEL' },
    { id: 'gun',    x: 500,  y: 880,  type: 'gun',    color: '#FFFFFF', label: 'PAWN & AMMO' },
    { id: 'garage', x: 680,  y: 1060, type: 'garage', color: '#67E8D0', label: 'VICE CUSTOMS' },
    { id: 'beach',  x: 1040, y: 340,  type: 'star',   color: '#F04A98', label: 'OCEAN BEACH STRIP' },
    { id: 'gym',    x: 1040, y: 700,  type: 'gym',    color: '#FFD166', label: 'VICE MUSCLE GYM' },
    { id: 'diner',  x: 500,  y: 520,  type: 'food',   color: '#FF9E6D', label: 'RUSTY ANCHOR BAR' }
  ];

  // ==================== WEBGPU FX & REAL PLAYGTA5 ENGINE TELEMETRY CHANNELS ====================
  let fxChannel = null;
  try {
    fxChannel = new BroadcastChannel('vbx-gta6-fx');
    fxChannel.onmessage = (ev) => {
      const d = ev.data;
      if (!d || !d.perfReport) return;
      if (d.fps > 0) state.fps = d.fps;
      if (d.frameMs > 0) state.frameMs = d.frameMs;
      if (d.tier !== undefined) state.perfTier = d.tier;
      if (d.resW > 0) { state.resW = d.resW; state.resH = d.resH; }
      if (d.presentCount > 0) state.realFramesSeen = Math.max(state.realFramesSeen, d.presentCount);
    };
  } catch (e) {}

  try {
    const fpsBc = new BroadcastChannel('game-fps');
    fpsBc.onmessage = (ev) => {
      const d = ev.data;
      if (d && typeof d.fps === 'number' && d.fps > 0) {
        state.fps = d.fps;
        state.frameMs = 1000 / Math.max(1, d.fps);
        state.realFramesSeen += 8;
      }
    };
  } catch (e) {}

  try {
    const crashBc = new BroadcastChannel('game-crash');
    crashBc.onmessage = (ev) => {
      const m = ev.data;
      if (!m) return;
      const isMem = /memory|OOM|Aborted\(|RangeError|grow/i.test(String(m.text || ''));
      state.loadError = `Engine stopped (${m.kind || 'crash'}): ${String(m.text || '').split('\n')[0].slice(0, 180)}` +
        (isMem ? ' — Low memory detected. Try Low-Memory Safe Mode below.' : '');
    };
  } catch (e) {}

  try {
    const progBc = new BroadcastChannel('game-progress');
    progBc.onmessage = (ev) => {
      const m = ev.data;
      if (!m) return;
      const now = performance.now();
      state.lastEngineActivity = now;

      // Real byte-delta streaming reports from io_worker.js (matches homepage.html verbatim!)
      if (typeof m.dl === 'number' && m.dl > 0) {
        state.dataBytes += m.dl;
        state.dlSamples.push([now, m.dl]);
        while (state.dlSamples.length && now - state.dlSamples[0][0] > 3000) state.dlSamples.shift();
        const bps = state.dlSamples.reduce((a, x) => a + x[1], 0) / 3;
        const mb = (state.dataBytes / 1048576) | 0;
        state.loadDl = `Game data: ${mb} MB` + (bps > 1e4 ? ` (${(bps / 1048576).toFixed(1)} MB/s)` : '');
        if (state.worldBaseBytes >= 0 && !state.worldReady) {
          const est = 72 + 26 * Math.min(1, (state.dataBytes - state.worldBaseBytes) / 1.2e9);
          if (est > state.loadPct) state.loadPct = est;
        }
        return;
      }
      if (Array.isArray(m.lines) && m.lines.length) {
        state.loadConsole = String(m.lines[m.lines.length - 1] || '').slice(0, 140);
        return;
      }
      if (typeof m.pct === 'number' && m.pct > state.loadPct) {
        state.loadPct = m.pct;
        if (m.pct >= 72 && state.worldBaseBytes < 0) state.worldBaseBytes = state.dataBytes;
      }
      if (m.label) state.loadLabel = String(m.label);
      if (m.choice) {
        state.choiceReady = true;
        if (state.phase === 'loading') triggerPlayGta5SandboxMode();
      }
      if (m.compiling !== undefined) {
        state.compilingCount = m.compiling;
        state.loadPct = Math.max(state.loadPct, 99);
        state.loadLabel = m.compiling > 0
          ? `Compiling WebGPU Shaders (${m.compiling} pipelines queued)...`
          : 'Finalizing 3D World Pipelines...';
      }
      if (m.error) {
        state.loadError = String(m.error);
      } else if (m.gpuLost) {
        state.loadError = 'WebGPU Device Lost: ' + String(m.gpuLost);
      }
      if (m.world) {
        state.worldReady = true;
        state.loadPct = 100;
        if (state.phase === 'loading') enterPlayingPhase();
      }
    };
  } catch (e) {}

  function getWeatherParams() {
    if (cfg.weather === 'noon')  return { tod: 13.0, warmth: 0.48, bloom: 0.58, rays: 0.36 };
    if (cfg.weather === 'night') return { tod: 22.8, warmth: 0.42, bloom: 1.00, rays: 0.16 };
    if (cfg.weather === 'storm') return { tod: 16.5, warmth: 0.32, bloom: 0.55, rays: 0.15 };
    return { tod: 18.4, warmth: 0.66, bloom: 0.84, rays: 0.54 }; // Leonida Golden Hour Sunset
  }

  function syncFxToWgpu() {
    if (!fxChannel) return;
    const wp = getWeatherParams();
    try {
      fxChannel.postMessage({
        enabled: !!(state.worldReady && state.phase === 'playing'),
        worldReady: !!state.worldReady,
        perfAuto: !!cfg.perfAuto,
        lighting: cfg.viceLighting > 0,
        motionBlur: cfg.motionBlur > 0,
        motionBlurStrength: (cfg.motionBlur / 100) * 0.85,
        bloomStrength: (cfg.bloom / 100) * wp.bloom * 0.65,
        warmth: (cfg.viceLighting / 100) * wp.warmth,
        volumetricRays: (cfg.sunShafts / 100) * wp.rays,
        camVelX: state.camVelX,
        camVelY: state.camVelY,
        speedNorm: state.speed,
        timeOfDay: wp.tod,
        focusMix: state.focusMix
      });
    } catch (e) {}
  }

  // Push live FPS & Frame-Time telemetry to ViceBox X native C++ Dev Settings every 600 ms
  setInterval(() => {
    try {
      fetch('/vbx/api/perf', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          fps: Number(state.fps.toFixed(1)),
          frameMs: Number(state.frameMs.toFixed(2)),
          perfTier: state.perfTier,
          resW: state.resW,
          resH: state.resH
        })
      }).catch(() => {});
    } catch (e) {}
  }, 600);

  // ==================== PHASE 5: LOW-BONE SPRING HAIR & CLOTH PHYSICS SOLVER ====================
  // Ultra-lightweight (<0.04ms/frame, zero GC allocations) Verlet/Spring chain for
  // Lucia's ponytail (5 bones) + loose jacket hem (4 bones) and Jason's floral shirt/collar (4 bones).
  function createChain(n, segLen) {
    const nodes = [];
    for (let i = 0; i < n; i++) {
      nodes.push({ x: 0, y: i * segLen, vx: 0, vy: 0, seg: segLen });
    }
    return nodes;
  }
  const hairChain  = createChain(5, 9.5);
  const clothL     = createChain(4, 10.0);
  const clothR     = createChain(4, 10.0);
  let physAccum = 0;

  function stepSpringChain(chain, anchorX, anchorY, windX, gravY, damping, dt) {
    chain[0].x = anchorX;
    chain[0].y = anchorY;
    for (let i = 1; i < chain.length; i++) {
      const p = chain[i];
      p.vx = (p.vx + windX * dt) * damping;
      p.vy = (p.vy + gravY * dt) * damping;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
    }
    // 2 distance-constraint iterations keep hair/cloth crisp and non-stretchy
    for (let iter = 0; iter < 2; iter++) {
      for (let i = 1; i < chain.length; i++) {
        const a = chain[i - 1], b = chain[i];
        const dx = b.x - a.x, dy = b.y - a.y;
        const dist = Math.hypot(dx, dy) || 0.001;
        const diff = (dist - b.seg) / dist;
        b.x -= dx * diff;
        b.y -= dy * diff;
      }
    }
  }

  function updateHairClothPhysics(dt, timeSec) {
    if (!cfg.hairClothPhysics) return;
    // Distance/frame-time throttling under Performance: Auto (60Hz normal, 30Hz if Tier 2)
    const stepRate = (cfg.perfAuto && state.perfTier >= 2) ? (1 / 30) : (1 / 60);
    physAccum += dt;
    if (physAccum < stepRate) return;
    const hdt = Math.min(0.04, physAccum);
    physAccum = 0;

    // Combine ambient Leonida coastal breeze + player forward speed + yaw turn impulse
    const breeze = Math.sin(timeSec * 2.3) * 18 + Math.cos(timeSec * 4.7) * 7;
    const moveWind = -state.camVelX * 14 - state.speed * 68;
    const jumpImpulse = state.keys['Space'] ? -45 : 0;
    const totalWind = breeze + moveWind;
    stepSpringChain(hairChain, 54, 34, totalWind * 1.18, 92 + jumpImpulse, 0.90, hdt);
    stepSpringChain(clothL,    36, 72, totalWind * 0.82 - 8, 108, 0.88, hdt);
    stepSpringChain(clothR,    72, 72, totalWind * 0.82 + 8, 108, 0.88, hdt);
  }

  function drawCharacterPhysicsCanvas(ctx, w, h, timeSec) {
    ctx.clearRect(0, 0, w, h);
    const ch = CHARACTERS[cfg.character] || CHARACTERS.lucia;
    const cx = w * 0.5;
    // Subtle Leonida sunset studio backdrop
    const bg = ctx.createLinearGradient(0, 0, 0, h);
    bg.addColorStop(0, 'rgba(240, 74, 152, 0.22)');
    bg.addColorStop(0.55, 'rgba(25, 29, 54, 0.85)');
    bg.addColorStop(1, 'rgba(14, 18, 34, 0.96)');
    ctx.fillStyle = bg;
    ctx.fillRect(0, 0, w, h);

    ctx.save();
    ctx.translate(cx - 54, 10);

    // Back ponytail hair volume (Lucia) simulated by 5-bone spring chain!
    if (cfg.character === 'lucia') {
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.strokeStyle = ch.hairColor;
      ctx.lineWidth = 15;
      ctx.beginPath();
      ctx.moveTo(hairChain[0].x + 6, hairChain[0].y);
      for (let i = 1; i < hairChain.length; i++) {
        ctx.lineTo(hairChain[i].x + 12, hairChain[i].y + i * 2.5);
      }
      ctx.stroke();

      ctx.strokeStyle = ch.hairHi;
      ctx.lineWidth = 5;
      ctx.beginPath();
      ctx.moveTo(hairChain[0].x + 8, hairChain[0].y + 2);
      for (let i = 1; i < hairChain.length; i++) {
        ctx.lineTo(hairChain[i].x + 13, hairChain[i].y + i * 2.2);
      }
      ctx.stroke();
    }

    // Shoulders & Torso
    ctx.fillStyle = cfg.character === 'lucia' ? '#D69A7B' : '#DFAA8A';
    ctx.beginPath();
    ctx.arc(54, 34, 15, 0, Math.PI * 2);
    ctx.fill();

    // Top / Jacket body
    ctx.fillStyle = ch.jacketColor;
    ctx.beginPath();
    ctx.moveTo(35, 56);
    ctx.quadraticCurveTo(54, 48, 73, 56);
    ctx.lineTo(clothR[clothR.length - 1].x, clothR[clothR.length - 1].y + 8);
    ctx.quadraticCurveTo(54, clothL[clothL.length - 1].y + 12, clothL[clothL.length - 1].x, clothL[clothL.length - 1].y + 8);
    ctx.closePath();
    ctx.fill();

    // Animated spring cloth hems (left & right jacket/shirt lapels)
    ctx.strokeStyle = 'rgba(255,255,255,0.45)';
    ctx.lineWidth = 2.2;
    ctx.beginPath();
    ctx.moveTo(clothL[0].x, clothL[0].y);
    for (let i = 1; i < clothL.length; i++) ctx.lineTo(clothL[i].x, clothL[i].y);
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(clothR[0].x, clothR[0].y);
    for (let i = 1; i < clothR.length; i++) ctx.lineTo(clothR[i].x, clothR[i].y);
    ctx.stroke();

    // Hair crown
    ctx.fillStyle = ch.hairColor;
    ctx.beginPath();
    ctx.arc(54, 30, 15.5, Math.PI, Math.PI * 2);
    ctx.fill();

    // Subtle wind lines when moving fast
    if (state.speed > 0.15) {
      ctx.strokeStyle = 'rgba(103, 232, 208, 0.35)';
      ctx.lineWidth = 1.2;
      for (let i = 0; i < 3; i++) {
        const ly = 26 + i * 28;
        const lx = ((timeSec * 160 + i * 40) % 120);
        ctx.beginPath();
        ctx.moveTo(110 - lx, ly);
        ctx.lineTo(94 - lx, ly);
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  // ==================== PHASE 4: AUTHENTIC 2026 GTA VI 3D iFRUIT NAVIGATION ENGINE ====================
  // Real 3D perspective camera projection + connected Vice City / Leonida road graph + A* shortest-path
  // street-following GPS + depth-sorted 3D buildings with shaded walls, window bands & rooftop HVAC details
  // (naturally occluding the pink GPS line behind buildings, matching real Nov 2026 PS5 GTA VI footage!).
  const MAP_SIZE = 1536;
  const bakedMaps = { light: null, dark: null };

  // Connected Vice City / Vice Beach / Starfish Island Street & Causeway Grid
  const CITY_AVENUES = [140, 320, 500, 680, 1040, 1220]; // x-coords (bay sits cleanly at x = 760..960!)
  const CITY_STREETS = [160, 340, 520, 700, 880, 1060, 1240, 1400]; // y-coords
  const BAY_X0 = 760, BAY_X1 = 960;
  const BAY_BRIDGES = [340, 700, 1060]; // Three iconic causeway bridges crossing Biscayne Bay!
  const OCEAN_SAND_X = 1285;
  const OCEAN_WATER_X = 1335;

  // Build explicit road graph (nodes + weighted bidirectional edges) for true A* street-following GPS!
  const ROAD_NODES = [];
  const ROAD_ADJ = [];
  const ROAD_SEGMENTS = []; // { x1, y1, x2, y2, w, isHwy, isBridge }
  const NODE_LOOKUP = new Map();

  (function initRoadGraph() {
    const addNode = (x, y) => {
      const key = `${x},${y}`;
      if (NODE_LOOKUP.has(key)) return NODE_LOOKUP.get(key);
      const id = ROAD_NODES.length;
      ROAD_NODES.push({ id, x, y });
      ROAD_ADJ.push([]);
      NODE_LOOKUP.set(key, id);
      return id;
    };
    const addEdge = (a, b, w, isHwy, isBridge) => {
      const na = ROAD_NODES[a], nb = ROAD_NODES[b];
      const dist = Math.hypot(nb.x - na.x, nb.y - na.y);
      const cost = dist * (isHwy ? 0.85 : 1.0); // slight preference for major boulevards/causeways
      ROAD_ADJ[a].push({ to: b, cost });
      ROAD_ADJ[b].push({ to: a, cost });
      ROAD_SEGMENTS.push({ x1: na.x, y1: na.y, x2: nb.x, y2: nb.y, w, isHwy, isBridge: !!isBridge });
    };

    // North-South Avenues
    for (const x of CITY_AVENUES) {
      const isHwy = (x === 320 || x === 680 || x === 1040);
      const width = isHwy ? 34 : 24;
      for (let j = 0; j < CITY_STREETS.length - 1; j++) {
        const a = addNode(x, CITY_STREETS[j]);
        const b = addNode(x, CITY_STREETS[j + 1]);
        addEdge(a, b, width, isHwy, false);
      }
    }

    // East-West Streets (Mainland west of bay + Vice Beach east of bay + 3 causeway bridges across bay!)
    for (const y of CITY_STREETS) {
      const isBridgeRow = BAY_BRIDGES.includes(y);
      const isHwy = isBridgeRow || y === 520 || y === 880;
      const width = isBridgeRow ? 34 : (isHwy ? 26 : 22);
      // Mainland segments: 140->320->500->680
      for (let i = 0; i < 3; i++) {
        const a = addNode(CITY_AVENUES[i], y);
        const b = addNode(CITY_AVENUES[i + 1], y);
        addEdge(a, b, width, isHwy, false);
      }
      // Causeway bridge across Biscayne Bay (680 -> 860 Starfish Island -> 1040 Vice Beach)
      if (isBridgeRow) {
        const a = addNode(680, y);
        const mid = addNode(860, y);
        const b = addNode(1040, y);
        addEdge(a, mid, 36, true, true);
        addEdge(mid, b, 36, true, true);
      }
      // Vice Beach island segments: 1040->1220
      {
        const a = addNode(1040, y);
        const b = addNode(1220, y);
        addEdge(a, b, 24, isHwy, false);
      }
    }
  })();

  // Parks & Green Plazas placed cleanly inside specific city blocks (never overlapping roads!)
  const MAP_PARKS = [
    { x: 162, y: 182, w: 136, h: 136 },
    { x: 522, y: 542, w: 136, h: 136 },
    { x: 1062, y: 362, w: 136, h: 136 },
    { x: 342, y: 1082, w: 136, h: 136 },
    { x: 1062, y: 902, w: 136, h: 136 }
  ];

  // Architectural 3D Vice City Buildings placed cleanly inside city blocks (guaranteed zero road overlap!)
  const MAP_BUILDINGS = [];
  (function initMapBuildings() {
    let seed = 9137;
    const rand = () => { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; };
    const isParkBlock = (bx, by) => MAP_PARKS.some((p) => bx >= p.x - 8 && bx <= p.x + p.w + 8 && by >= p.y - 8 && by <= p.y + p.h + 8);

    // Block intervals between consecutive avenues & streets (skipping Biscayne Bay 680..1040)
    const xSpans = [[140, 320], [320, 500], [500, 680], [1040, 1220]];
    const palettesDay = [
      { wallL: '#B9987B', wallR: '#9D7F65', wallF: '#AC8C70', roof: '#8B8986', parapet: '#CFC4B8', win: 'rgba(244,246,248,0.68)' }, // Warm Vice Sandstone (exact le-3.png!)
      { wallL: '#C5AA90', wallR: '#A68D75', wallF: '#B69B82', roof: '#949390', parapet: '#DDD3C8', win: 'rgba(245,247,250,0.62)' }, // Art Deco Cream/Tan
      { wallL: '#9DA4AC', wallR: '#828A93', wallF: '#8F97A0', roof: '#7A8189', parapet: '#BCC3CA', win: 'rgba(232,240,248,0.58)' }, // Downtown Concrete Tower
      { wallL: '#8E9EAD', wallR: '#748494', wallF: '#8091A1', roof: '#6F7D8B', parapet: '#B4C3D1', win: 'rgba(220,238,255,0.64)' }, // Bayfront Glass High-rise
      { wallL: '#B59D8D', wallR: '#988172', wallF: '#A68E7F', roof: '#868482', parapet: '#CFC2B8', win: 'rgba(246,244,240,0.56)' }  // Midtown Terracotta
    ];
    const palettesNight = [
      { wallL: '#3F4452', wallR: '#2E3340', wallF: '#373C4A', roof: '#272C38', parapet: '#586073', win: 'rgba(255,214,158,0.44)' },
      { wallL: '#47434E', wallR: '#35313B', wallF: '#3E3A45', roof: '#2B2832', parapet: '#645D6E', win: 'rgba(255,196,148,0.42)' },
      { wallL: '#344052', wallR: '#263040', wallF: '#2D3849', roof: '#212A38', parapet: '#4F5F78', win: 'rgba(170,220,255,0.40)' },
      { wallL: '#3A4658', wallR: '#2A3544', wallF: '#323E4F', roof: '#242E3D', parapet: '#56677F', win: 'rgba(255,180,224,0.36)' },
      { wallL: '#443F4A', wallR: '#332F38', wallF: '#3B3741', roof: '#292630', parapet: '#5F5969', win: 'rgba(255,220,170,0.38)' }
    ];

    for (const [ax0, ax1] of xSpans) {
      const isDowntown = (ax0 === 500);
      const isBeach = (ax0 === 1040);
      for (let j = 0; j < CITY_STREETS.length - 1; j++) {
        const sy0 = CITY_STREETS[j], sy1 = CITY_STREETS[j + 1];
        const pad = 25; // clean sidewalk setback from avenue/street edges
        const bx0 = ax0 + pad, bx1 = ax1 - pad;
        const by0 = sy0 + pad, by1 = sy1 - pad;
        if (isParkBlock(bx0, by0)) continue;

        const bw = bx1 - bx0, bh = by1 - by0;
        const styleRoll = rand();
        const slots = [];
        if (styleRoll < 0.34) {
          // Single prominent landmark block (like the large corner building in le-3.png!)
          slots.push({ x: bx0 + 4, y: by0 + 4, w: bw - 8, h: bh - 8 });
        } else if (styleRoll < 0.68) {
          // Two architectural buildings separated by a clean service alley
          const splitX = bx0 + bw * (0.44 + rand() * 0.14);
          slots.push({ x: bx0 + 3, y: by0 + 4, w: splitX - bx0 - 8, h: bh - 8 });
          slots.push({ x: splitX + 5, y: by0 + 4, w: bx1 - splitX - 8, h: bh - 8 });
        } else {
          // Three-lot urban corner cluster
          const splitY = by0 + bh * 0.50;
          const splitX = bx0 + bw * 0.50;
          slots.push({ x: bx0 + 3, y: by0 + 3, w: splitX - bx0 - 7, h: splitY - by0 - 7 });
          slots.push({ x: splitX + 4, y: by0 + 3, w: bx1 - splitX - 7, h: splitY - by0 - 7 });
          slots.push({ x: bx0 + 3, y: splitY + 4, w: bw - 6, h: by1 - splitY - 7 });
        }

        for (const s of slots) {
          const elev = isDowntown
            ? (30 + rand() * 38)
            : (isBeach ? (22 + rand() * 30) : (15 + rand() * 22));
          const palIdx = isBeach
            ? (rand() < 0.72 ? 0 : 1)
            : (isDowntown ? (rand() < 0.45 ? 0 : (rand() < 0.7 ? 1 : 2 + Math.floor(rand() * 2))) : Math.floor(rand() * palettesDay.length));
          const hvacCount = (s.w > 46 && s.h > 42) ? 2 : 1;
          MAP_BUILDINGS.push({
            x: s.x, y: s.y, w: s.w, h: s.h,
            cx: s.x + s.w * 0.5, cy: s.y + s.h * 0.5,
            elev,
            floors: Math.max(2, Math.min(7, Math.round(elev / 10))),
            dayPal: palettesDay[palIdx],
            nightPal: palettesNight[palIdx],
            hvacCount
          });
        }
      }
    }

    // Starfish Island luxury villas along the center bay island (x = 810..910, y = 630..770)
    MAP_BUILDINGS.push({
      x: 822, y: 610, w: 72, h: 52, cx: 858, cy: 636, elev: 20, floors: 2,
      dayPal: palettesDay[1], nightPal: palettesNight[1], hvacCount: 1
    });
    MAP_BUILDINGS.push({
      x: 824, y: 736, w: 68, h: 52, cx: 858, cy: 762, elev: 22, floors: 2,
      dayPal: palettesDay[0], nightPal: palettesNight[0], hvacCount: 1
    });
  })();

  // Snap any world coordinate to the nearest road intersection node for A* routing
  function nearestRoadNode(wx, wy) {
    let best = 0, bestD = 1e12;
    for (let i = 0; i < ROAD_NODES.length; i++) {
      const n = ROAD_NODES[i];
      const d = (n.x - wx) * (n.x - wx) + (n.y - wy) * (n.y - wy);
      if (d < bestD) { bestD = d; best = i; }
    }
    return best;
  }

  // Project a point orthogonally onto the nearest road segment so GPS starts & ends ON a real street!
  function snapToRoadPoint(wx, wy) {
    let bestX = wx, bestY = wy, bestD = 1e12;
    for (let i = 0; i < ROAD_SEGMENTS.length; i++) {
      const s = ROAD_SEGMENTS[i];
      const dx = s.x2 - s.x1, dy = s.y2 - s.y1;
      const len2 = dx * dx + dy * dy || 1;
      const t = Math.max(0, Math.min(1, ((wx - s.x1) * dx + (wy - s.y1) * dy) / len2));
      const px = s.x1 + dx * t, py = s.y1 + dy * t;
      const d = (px - wx) * (px - wx) + (py - wy) * (py - wy);
      if (d < bestD) { bestD = d; bestX = px; bestY = py; }
    }
    return [bestX, bestY];
  }

  // Real A* Shortest-Path Street-Following GPS Route with Smooth Rounded Intersection Turns!
  function computeStreetRoute(sx, sy, tx, ty) {
    const startSnap = snapToRoadPoint(sx, sy);
    const endSnap = snapToRoadPoint(tx, ty);
    const sNode = nearestRoadNode(startSnap[0], startSnap[1]);
    const eNode = nearestRoadNode(endSnap[0], endSnap[1]);

    const N = ROAD_NODES.length;
    const gScore = new Float64Array(N).fill(1e12);
    const fScore = new Float64Array(N).fill(1e12);
    const cameFrom = new Int32Array(N).fill(-1);
    const closed = new Uint8Array(N);
    const open = [sNode];
    const en = ROAD_NODES[eNode];
    gScore[sNode] = 0;
    fScore[sNode] = Math.hypot(en.x - ROAD_NODES[sNode].x, en.y - ROAD_NODES[sNode].y);

    while (open.length) {
      let bestIdx = 0;
      for (let i = 1; i < open.length; i++) {
        if (fScore[open[i]] < fScore[open[bestIdx]]) bestIdx = i;
      }
      const cur = open.splice(bestIdx, 1)[0];
      if (cur === eNode) break;
      if (closed[cur]) continue;
      closed[cur] = 1;

      const edges = ROAD_ADJ[cur];
      for (let i = 0; i < edges.length; i++) {
        const nb = edges[i].to;
        if (closed[nb]) continue;
        const tentG = gScore[cur] + edges[i].cost;
        if (tentG < gScore[nb]) {
          cameFrom[nb] = cur;
          gScore[nb] = tentG;
          const nn = ROAD_NODES[nb];
          fScore[nb] = tentG + Math.hypot(en.x - nn.x, en.y - nn.y);
          if (!open.includes(nb)) open.push(nb);
        }
      }
    }

    // Reconstruct raw intersection vertices
    const raw = [];
    let cur = eNode;
    while (cur !== -1) {
      raw.push([ROAD_NODES[cur].x, ROAD_NODES[cur].y]);
      cur = cameFrom[cur];
    }
    raw.reverse();
    if (!raw.length) raw.push(startSnap, endSnap);
    else {
      // Prepend player snapped point cleanly (avoid backtracking if player is already past sNode toward raw[1])
      if (raw.length >= 2) {
        const d01 = Math.hypot(raw[1][0] - raw[0][0], raw[1][1] - raw[0][1]);
        const dP1 = Math.hypot(raw[1][0] - startSnap[0], raw[1][1] - startSnap[1]);
        if (dP1 < d01) raw[0] = startSnap;
        else raw.unshift(startSnap);
      } else {
        raw[0] = startSnap;
      }
      if (Math.hypot(endSnap[0] - raw[raw.length - 1][0], endSnap[1] - raw[raw.length - 1][1]) > 8) {
        raw.push(endSnap);
      }
    }

    // Apply smooth corner fillets (radius 18 world units) + subdivide into clean 3D segments so perspective stays crisp!
    const smooth = [];
    for (let i = 0; i < raw.length; i++) {
      const p = raw[i];
      if (i > 0 && i < raw.length - 1) {
        const prev = raw[i - 1], next = raw[i + 1];
        const v1x = p[0] - prev[0], v1y = p[1] - prev[1];
        const v2x = next[0] - p[0], v2y = next[1] - p[1];
        const l1 = Math.hypot(v1x, v1y) || 1, l2 = Math.hypot(v2x, v2y) || 1;
        const dot = (v1x * v2x + v1y * v2y) / (l1 * l2);
        if (dot < 0.96 && l1 > 22 && l2 > 22) {
          const r = Math.min(20, l1 * 0.35, l2 * 0.35);
          const a = [p[0] - (v1x / l1) * r, p[1] - (v1y / l1) * r];
          const b = [p[0] + (v2x / l2) * r, p[1] + (v2y / l2) * r];
          for (let k = 0; k <= 4; k++) {
            const t = k / 4, u = 1 - t;
            smooth.push([
              u * u * a[0] + 2 * u * t * p[0] + t * t * b[0],
              u * u * a[1] + 2 * u * t * p[1] + t * t * b[1]
            ]);
          }
          continue;
        }
      }
      smooth.push(p);
    }

    // Subdivide long straight road runs every ~28 world units for distortion-free 3D perspective projection
    const pts = [];
    let totalDist = 0;
    for (let i = 0; i < smooth.length; i++) {
      if (i === 0) { pts.push(smooth[0]); continue; }
      const a = smooth[i - 1], b = smooth[i];
      const segLen = Math.hypot(b[0] - a[0], b[1] - a[1]);
      totalDist += segLen;
      const steps = Math.max(1, Math.ceil(segLen / 28));
      for (let s = 1; s <= steps; s++) {
        const t = s / steps;
        pts.push([a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t]);
      }
    }
    return { pts, dist: totalDist };
  }

  function getCachedStreetRoute() {
    if (!state.waypoint) return null;
    const key = `${Math.round(state.posX / 6)},${Math.round(state.posY / 6)}->${Math.round(state.waypoint.x / 6)},${Math.round(state.waypoint.y / 6)}`;
    if (state.cachedRoute && state.cachedRouteKey === key) return state.cachedRoute;
    state.cachedRoute = computeStreetRoute(state.posX, state.posY, state.waypoint.x, state.waypoint.y);
    state.cachedRouteKey = key;
    return state.cachedRoute;
  }

  function getActiveMapTheme() {
    if (cfg.minimapTheme === 'light') return 'light';
    if (cfg.minimapTheme === 'dark') return 'dark';
    return (cfg.weather === 'night' || cfg.weather === 'storm') ? 'dark' : 'light';
  }

  // Full 2D Vector Pause Map (100% geometrically matched to our 3D Minimap road graph & buildings!)
  function ensureBakedMap(themeOverride) {
    const theme = themeOverride || getActiveMapTheme();
    if (bakedMaps[theme]) return bakedMaps[theme];

    const cv = document.createElement('canvas');
    cv.width = MAP_SIZE;
    cv.height = MAP_SIZE;
    const c = cv.getContext('2d');
    const isDark = theme === 'dark';

    const pal = isDark ? {
      oceanDeep: '#101A2B', oceanShelf: '#17253B', sand: '#2E3645',
      land: '#222A39', park: '#1E312E', sidewalk: '#2D3748',
      roadEdge: '#4A566B', roadFill: '#394356', hwyFill: '#455168',
      divider: '#283142', shadow: 'rgba(5,8,16,0.52)'
    } : {
      oceanDeep: '#4B7D92', oceanShelf: '#5E92A6', sand: '#D3C9B4',
      land: '#82888E', park: '#66876B', sidewalk: '#999FA5',
      roadEdge: '#697076', roadFill: '#AEB2B6', hwyFill: '#BCBFBF',
      divider: '#7B8288', shadow: 'rgba(26,30,36,0.28)'
    };

    // 1. Land, Biscayne Bay Waterway, Starfish Island & Ocean Beach
    c.fillStyle = pal.land;
    c.fillRect(0, 0, MAP_SIZE, MAP_SIZE);

    c.fillStyle = pal.oceanShelf;
    c.fillRect(BAY_X0, 0, BAY_X1 - BAY_X0, MAP_SIZE);

    // Starfish Island in center of bay
    c.fillStyle = pal.land;
    c.beginPath();
    c.roundRect(796, 588, 128, 224, 34);
    c.fill();

    // East Coast Golden Sand + Atlantic Ocean
    c.fillStyle = pal.sand;
    c.fillRect(OCEAN_SAND_X, 0, OCEAN_WATER_X - OCEAN_SAND_X, MAP_SIZE);
    c.fillStyle = pal.oceanShelf;
    c.fillRect(OCEAN_WATER_X, 0, 75, MAP_SIZE);
    c.fillStyle = pal.oceanDeep;
    c.fillRect(OCEAN_WATER_X + 75, 0, MAP_SIZE - (OCEAN_WATER_X + 75), MAP_SIZE);

    // 2. Parks
    c.fillStyle = pal.park;
    for (const p of MAP_PARKS) {
      c.beginPath(); c.roundRect(p.x, p.y, p.w, p.h, 14); c.fill();
    }

    // 3. Connected Street & Causeway Road Network
    c.lineCap = 'round';
    c.lineJoin = 'round';
    for (const s of ROAD_SEGMENTS) {
      if (s.isBridge) {
        c.strokeStyle = pal.shadow;
        c.lineWidth = s.w + 10;
        c.beginPath(); c.moveTo(s.x1, s.y1 + 6); c.lineTo(s.x2, s.y2 + 6); c.stroke();
      }
      c.strokeStyle = pal.sidewalk;
      c.lineWidth = s.w + 8;
      c.beginPath(); c.moveTo(s.x1, s.y1); c.lineTo(s.x2, s.y2); c.stroke();

      c.strokeStyle = pal.roadEdge;
      c.lineWidth = s.w + 2;
      c.beginPath(); c.moveTo(s.x1, s.y1); c.lineTo(s.x2, s.y2); c.stroke();

      c.strokeStyle = s.isHwy ? pal.hwyFill : pal.roadFill;
      c.lineWidth = s.w;
      c.beginPath(); c.moveTo(s.x1, s.y1); c.lineTo(s.x2, s.y2); c.stroke();

      if (s.isHwy) {
        c.strokeStyle = pal.divider;
        c.lineWidth = 2;
        c.beginPath(); c.moveTo(s.x1, s.y1); c.lineTo(s.x2, s.y2); c.stroke();
      }
    }

    // 4. Clean Architectural Building Footprints
    for (const b of MAP_BUILDINGS) {
      const bp = isDark ? b.nightPal : b.dayPal;
      c.fillStyle = pal.shadow;
      c.fillRect(b.x + 4, b.y + 5, b.w, b.h);
      c.fillStyle = bp.wallF;
      c.fillRect(b.x, b.y, b.w, b.h);
      c.fillStyle = bp.roof;
      c.fillRect(b.x + 2, b.y + 2, b.w - 4, b.h - 4);
      c.strokeStyle = bp.parapet;
      c.lineWidth = 1;
      c.strokeRect(b.x + 2.5, b.y + 2.5, b.w - 5, b.h - 5);
    }

    bakedMaps[theme] = cv;
    return cv;
  }

  function buildGpsRoutePoints(sx, sy, tx, ty) {
    return computeStreetRoute(sx, sy, tx, ty).pts;
  }

  // ==================== SYNTHESIZED VICE CITY AUDIO FEEDBACK ====================
  let audioCtx = null;
  function playUiTone(freq, dur, vol, type) {
    try {
      if (!audioCtx) audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      if (audioCtx.state === 'suspended') audioCtx.resume().catch(() => {});
      const o = audioCtx.createOscillator();
      const g = audioCtx.createGain();
      o.type = type || 'sine';
      o.frequency.setValueAtTime(freq, audioCtx.currentTime);
      g.gain.setValueAtTime(vol || 0.06, audioCtx.currentTime);
      g.gain.exponentialRampToValueAtTime(0.0001, audioCtx.currentTime + (dur || 0.09));
      o.connect(g); g.connect(audioCtx.destination);
      o.start(); o.stop(audioCtx.currentTime + (dur || 0.09));
    } catch (e) {}
  }

  function playIntroChord() {
    playUiTone(110, 1.4, 0.09, 'sawtooth');
    setTimeout(() => playUiTone(164.81, 1.2, 0.07, 'triangle'), 180);
    setTimeout(() => playUiTone(220, 1.5, 0.07, 'sine'), 420);
    setTimeout(() => playUiTone(329.63, 1.8, 0.06, 'triangle'), 900);
  }

  // ==================== INJECT CSS STYLES (EXACT UI_SPEC.md TOKENS) ====================
  const styleEl = document.createElement('style');
  styleEl.id = 'vbx-gta6-styles';
  styleEl.textContent = `
    :root {
      --vi-pink: #F04A98;
      --vi-pink-soft: #F4A5C4;
      --vi-mint: #67E8D0;
      --vi-violet: #9C85FF;
      --vi-coral: #FF9E6D;
      --vi-gold: #FFD166;
      --vi-green: #4ADE80;
      --vi-red: #FF2E63;
      --vi-navy: #141933;
      --vi-font: 'Bahnschrift', 'Segoe UI Variable Display', 'Segoe UI', system-ui, sans-serif;
    }
    /* Suppress stock GTA V Scaleform loading stage in Experimental GTA 6 Mode unless user clicks View Raw Engine */
    #loading { opacity: 0 !important; pointer-events: none !important; visibility: hidden !important; }
    body.vbx-show-raw-engine #loading { opacity: 1 !important; pointer-events: auto !important; visibility: visible !important; z-index: 99997 !important; }
    body.vbx-show-raw-engine #vi-loading { opacity: 0 !important; pointer-events: none !important; }
    #vbx-raw-close { position: fixed; right: 20px; top: 20px; z-index: 99999; display: none; padding: 8px 16px; border-radius: 999px; border: 1px solid rgba(255,255,255,0.35); background: rgba(16,20,38,0.92); color: #fff; font-size: 11px; font-weight: 800; letter-spacing: 0.1em; cursor: pointer; pointer-events: auto; }
    body.vbx-show-raw-engine #vbx-raw-close { display: block; }
    #vbx-gta6-root, #vbx-gta6-root * { box-sizing: border-box; font-family: var(--vi-font); user-select: none; }
    #vbx-gta6-root { position: fixed; inset: 0; z-index: 99990; pointer-events: none; color: #fff; }

    /* ---- PHASE 3: BOOT INTRO ---- */
    #vi-intro { position: fixed; inset: 0; background: #000; z-index: 99999; pointer-events: auto; display: flex; align-items: center; justify-content: center; transition: opacity 0.5s ease; }
    #vi-intro.hidden { opacity: 0; pointer-events: none; }
    #vi-intro-canvas { position: absolute; inset: 0; width: 100%; height: 100%; }
    #vi-intro-video { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; display: none; }
    #vi-intro-skip { position: absolute; right: 32px; bottom: 28px; font-size: 12px; letter-spacing: 0.16em; text-transform: uppercase; color: rgba(255,255,255,0.65); background: rgba(0,0,0,0.45); padding: 7px 14px; border-radius: 999px; border: 1px solid rgba(255,255,255,0.16); }

    /* ---- PHASE 3: MAIN MENU ---- */
    #vi-menu { position: fixed; inset: 0; z-index: 99996; pointer-events: auto; overflow: hidden; background: #0d0a1a; transition: opacity 0.45s ease; display: none; }
    #vi-menu.visible { display: block; }
    #vi-menu.fadeout { opacity: 0; pointer-events: none; }
    .vi-menu-bg { position: absolute; inset: -18px; background: url('/vbx/img/gta6_keyart_wide.webp') center/cover no-repeat, url('/vbx/img/gta6_hero.jpg') center/cover no-repeat; transform: scale(1.03); transition: transform 0.25s ease-out; filter: saturate(1.12) contrast(1.04); }
    .vi-menu-scrim { position: absolute; inset: 0; background: linear-gradient(95deg, rgba(12,10,24,0.92) 0%, rgba(16,13,34,0.68) 42%, rgba(22,12,32,0.16) 76%, rgba(12,10,24,0.52) 100%), linear-gradient(0deg, rgba(10,12,24,0.72) 0%, transparent 34%); }
    .vi-menu-left { position: absolute; left: 56px; top: 44px; bottom: 42px; width: 396px; display: flex; flex-direction: column; justify-content: space-between; }
    .vi-brand-tag { display: inline-flex; align-items: center; gap: 8px; padding: 5px 12px; border-radius: 999px; background: rgba(240,74,152,0.18); border: 1px solid rgba(240,74,152,0.48); color: #FFD1E6; font-size: 11px; letter-spacing: 0.16em; font-weight: 700; width: fit-content; }
    .vi-logo-img { width: 224px; max-height: 116px; object-fit: contain; margin-top: 12px; filter: drop-shadow(0 8px 26px rgba(240,74,152,0.42)); }
    .vi-nav-list { display: flex; flex-direction: column; gap: 11px; margin: 18px 0; }
    .vi-menu-btn { position: relative; display: flex; align-items: center; justify-content: space-between; width: 100%; height: 54px; padding: 0 20px; border-radius: 10px; border: 1px solid rgba(255,255,255,0.16); background: rgba(16,20,38,0.72); backdrop-filter: blur(12px); color: #fff; font-size: 16px; font-weight: 700; letter-spacing: 0.10em; text-transform: uppercase; cursor: pointer; transition: transform 0.16s cubic-bezier(0.2,0.9,0.3,1), background 0.16s, border-color 0.16s, box-shadow 0.16s; }
    .vi-menu-btn:hover:not(:disabled) { transform: translateX(8px); border-color: rgba(255,255,255,0.75); background: rgba(240,74,152,0.28); box-shadow: 0 10px 28px rgba(240,74,152,0.28); }
    .vi-menu-btn:active:not(:disabled) { transform: translateX(4px) scale(0.99); }
    .vi-menu-btn.primary { height: 60px; background: linear-gradient(100deg, #F04A98 0%, #FF7B6B 100%); border-color: rgba(255,255,255,0.55); box-shadow: 0 12px 32px rgba(240,74,152,0.40); font-size: 17px; }
    .vi-menu-btn.primary:hover { background: linear-gradient(100deg, #FF5CA8 0%, #FF9378 100%); box-shadow: 0 14px 36px rgba(240,74,152,0.55); }
    .vi-menu-btn:disabled { opacity: 0.46; cursor: not-allowed; background: rgba(14,16,28,0.62); border-color: rgba(255,255,255,0.09); }
    .vi-badge-tbc { font-size: 10px; letter-spacing: 0.14em; padding: 4px 9px; border-radius: 6px; background: rgba(255,255,255,0.10); border: 1px solid rgba(255,255,255,0.18); color: #C8CDD6; }
    .vi-map-pills { display: flex; gap: 8px; margin-top: -4px; }
    .vi-pill { flex: 1; padding: 7px 10px; border-radius: 8px; border: 1px solid rgba(255,255,255,0.14); background: rgba(14,18,34,0.68); color: #C8CDD6; font-size: 11px; font-weight: 700; letter-spacing: 0.09em; text-transform: uppercase; cursor: pointer; text-align: center; transition: all 0.15s; }
    .vi-pill.active { border-color: #67E8D0; background: rgba(103,232,208,0.18); color: #fff; }
    .vi-char-chip { display: flex; align-items: center; gap: 12px; }
    .vi-char-ava { width: 34px; height: 34px; border-radius: 50%; border: 2px solid var(--vi-pink); background-size: 210%; background-image: url('/vbx/img/gta6_duo.jpg'); }
    .vi-char-ava.lucia { background-position: 26% 32%; border-color: #F04A98; }
    .vi-char-ava.jason { background-position: 70% 24%; border-color: #67E8D0; }
    .vi-menu-footer { font-size: 11px; letter-spacing: 0.09em; color: rgba(220,226,240,0.72); display: flex; justify-content: space-between; }

    /* Menu Settings Drawer */
    #vi-menu-settings { position: absolute; right: 44px; top: 44px; bottom: 44px; width: 410px; border-radius: 16px; background: rgba(16,20,42,0.92); backdrop-filter: blur(18px); border: 1px solid rgba(255,255,255,0.15); padding: 24px; display: none; flex-direction: column; gap: 14px; overflow-y: auto; box-shadow: 0 24px 60px rgba(0,0,0,0.6); }
    #vi-menu-settings.open { display: flex; }

    /* Loading Transition Curtain */
    #vi-loading { position: fixed; inset: 0; z-index: 99995; pointer-events: auto; display: none; background: #0c0e1c; }
    #vi-loading.visible { display: flex; flex-direction: column; justify-content: flex-end; padding: 48px 56px; }
    .vi-load-bg { position: absolute; inset: 0; background: url('/vbx/img/gta6_duo.jpg') center 24%/cover no-repeat; opacity: 0.45; filter: saturate(1.15); }
    .vi-load-grad { position: absolute; inset: 0; background: linear-gradient(0deg, rgba(10,12,24,0.96) 0%, rgba(16,14,32,0.55) 45%, rgba(12,10,24,0.65) 100%); }
    .vi-load-content { position: relative; z-index: 2; max-width: 680px; }
    .vi-load-track { width: 100%; height: 6px; border-radius: 4px; background: rgba(255,255,255,0.14); overflow: hidden; margin: 14px 0 10px; }
    .vi-load-fill { height: 100%; width: 12%; background: linear-gradient(90deg, #F04A98, #FF9E6D, #67E8D0); transition: width 0.25s ease; }

    /* ---- PHASE 4: SANDBOX HUD (4-CORNER 2026 LAYOUT) ---- */
    #vi-hud { position: fixed; inset: 0; pointer-events: none; display: none; }
    #vi-hud.visible { display: block; }

    /* Top-Left Vitals (Exact ref_03_weapon_wheel_hud.jpg) */
    .vi-vitals { position: fixed; top: 24px; left: 26px; display: flex; flex-direction: column; gap: 6px; width: 192px; transition: opacity 0.4s; }
    .vi-vital-row { display: flex; align-items: center; gap: 8px; }
    .vi-vital-ico { width: 14px; height: 14px; flex: none; filter: drop-shadow(0 1px 3px rgba(0,0,0,0.8)); }
    .vi-vital-track { flex: 1; height: 6px; border-radius: 3px; background: rgba(14,17,26,0.58); overflow: hidden; box-shadow: 0 1px 4px rgba(0,0,0,0.5); }
    .vi-vital-fill { height: 100%; border-radius: 3px; transition: width 0.18s ease-out; }
    #vi-bar-hp    { background: var(--vi-pink-soft); }
    #vi-bar-stam  { background: var(--vi-mint); }
    #vi-bar-focus { background: var(--vi-violet); }

    /* Top-Right Economy, Ammo, 6-Star Wanted & Intel Clues */
    .vi-topright { position: fixed; top: 22px; right: 26px; display: flex; flex-direction: column; align-items: flex-end; gap: 5px; text-shadow: 0 2px 6px rgba(0,0,0,0.85); }
    .vi-money-row { display: flex; align-items: center; gap: 7px; font-size: 20px; font-weight: 800; font-variant-numeric: tabular-nums; letter-spacing: 0.03em; }
    .vi-money-cash { font-size: 17px; opacity: 0.94; }
    .vi-ammo-box { margin-top: 2px; font-size: 16px; font-weight: 800; font-variant-numeric: tabular-nums; letter-spacing: 0.05em; display: flex; align-items: baseline; gap: 5px; }
    .vi-ammo-res { color: #B8C0D0; font-size: 13px; }
    .vi-wanted-stars { display: flex; gap: 4px; margin-top: 3px; }
    .vi-star { font-size: 16px; color: rgba(255,255,255,0.22); transition: color 0.15s; }
    .vi-star.on { color: #fff; animation: vi-star-pulse 0.75s infinite alternate; }
    @keyframes vi-star-pulse { from { color: #fff; text-shadow: 0 0 8px #fff; } to { color: #FF2E63; text-shadow: 0 0 10px #FF2E63; } }
    .vi-clues { display: flex; gap: 5px; margin-top: 2px; }
    .vi-clue { font-size: 9px; font-weight: 700; letter-spacing: 0.08em; padding: 2px 6px; border-radius: 4px; background: rgba(255,46,99,0.28); border: 1px solid rgba(255,46,99,0.75); color: #FFD1DC; }

    /* Bottom-Left Authentic 2026 GTA VI 3D Satellite-Style iFruit Minimap (Real 3D Camera Projection) */
    #vi-minimap-wrap { position: fixed; left: 26px; bottom: 24px; transition: opacity 0.35s ease, transform 0.35s ease; }
    #vi-minimap-wrap.hud-hidden { opacity: 0; transform: translateY(10px); }
    #vi-minimap-shell { position: relative; width: 268px; height: 158px; border-radius: 16px; overflow: hidden; background: #7E858C; border: 1px solid rgba(255,255,255,0.28); box-shadow: 0 12px 32px rgba(0,0,0,0.52), inset 0 1px 0 rgba(255,255,255,0.18); transition: width 0.25s, height 0.25s, border-color 0.2s; }
    #vi-minimap-shell.theme-dark { background: #202836; border-color: rgba(255,255,255,0.20); }
    #vi-minimap-shell.expanded { width: 372px; height: 222px; }
    #vi-minimap-shell.wanted { border-color: rgba(255,46,99,0.88); animation: vi-map-wanted 0.78s infinite alternate; }
    @keyframes vi-map-wanted { from { box-shadow: 0 0 0 1.5px rgba(255,46,99,0.65), 0 12px 30px rgba(0,0,0,0.58); } to { box-shadow: 0 0 20px 2px rgba(42,130,255,0.80), 0 12px 30px rgba(0,0,0,0.58); } }
    #vi-minimap-canvas { position: absolute; inset: 0; width: 100%; height: 100%; display: block; border-radius: 15px; }
    #vi-minimap-wanted-wash { position: absolute; inset: 0; pointer-events: none; z-index: 3; opacity: 0; border-radius: 15px; }
    /* Crisp black circular player arrow (exact PS5 GTA VI le-3.png & le-2.png style) */
    #vi-minimap-player { position: absolute; left: 50%; top: 76%; width: 19px; height: 19px; transform: translate(-50%, -50%); border-radius: 50%; background: #0C0E13; box-shadow: 0 2px 5px rgba(0,0,0,0.68), 0 0 0 1.2px rgba(255,255,255,0.22); display: flex; align-items: center; justify-content: center; z-index: 5; pointer-events: none; transition: top 0.22s ease; }
    #vi-minimap-shell:not(.mode-3d) #vi-minimap-player { top: 55%; }
    /* Crisp top-left mileage readout matching real PS5 GTA VI (1.86 mi / 0.43 mi) */
    #vi-minimap-gps { position: absolute; left: 11px; top: 8px; font-size: 13px; font-weight: 700; color: #FFFFFF; font-variant-numeric: tabular-nums; letter-spacing: 0.01em; text-shadow: 0 1px 3px rgba(0,0,0,0.92), 0 0 8px rgba(0,0,0,0.55); z-index: 6; pointer-events: none; }
    /* Orbiting black circular N badge & glowing hot-pink waypoint dot gliding cleanly around outer border! */
    #vi-minimap-north { position: absolute; width: 16px; height: 16px; border-radius: 50%; background: #0A0C11; border: 1px solid rgba(255,255,255,0.26); color: #fff; font-size: 9px; font-weight: 900; display: flex; align-items: center; justify-content: center; transform: translate(-50%,-50%); pointer-events: none; z-index: 8; box-shadow: 0 2px 5px rgba(0,0,0,0.72); }
    #vi-minimap-wp-pin { position: absolute; width: 12px; height: 12px; border-radius: 50%; background: #FF4EA8; border: 1.5px solid rgba(16,12,20,0.78); transform: translate(-50%,-50%); pointer-events: none; z-index: 8; box-shadow: 0 0 10px rgba(255,78,168,0.95), 0 1px 4px rgba(0,0,0,0.65); }

    /* Optional Top-Center GTA VI Directional Compass Bar (Compass Navigation Mode) */
    #vi-compass-wrap { position: fixed; top: 58px; left: 50%; transform: translateX(-50%); width: 320px; height: 28px; border-radius: 999px; background: rgba(12,16,28,0.64); backdrop-filter: blur(8px); border: 1px solid rgba(255,255,255,0.18); overflow: hidden; display: none; z-index: 99990; pointer-events: none; }
    #vi-compass-wrap.visible { display: block; }
    #vi-compass-canvas { width: 100%; height: 100%; display: block; }

    /* Optional Live Hair/Cloth Physics Companion Corner Rig */
    #vi-phys-rig { position: fixed; left: 294px; bottom: 22px; width: 108px; height: 126px; border-radius: 10px; overflow: hidden; border: 1px solid rgba(255,255,255,0.18); box-shadow: 0 8px 22px rgba(0,0,0,0.5); display: none; }
    #vi-phys-rig.visible { display: block; }
    #vi-phys-lbl { position: absolute; left: 0; right: 0; bottom: 3px; text-align: center; font-size: 9px; font-weight: 800; letter-spacing: 0.1em; color: #FFD1E6; text-shadow: 0 1px 3px #000; }

    /* Subtle bottom-center pointer-lock & audio prompt (disappears automatically on click/lock) */
    #vi-lock-hint { position: fixed; left: 50%; bottom: 26px; transform: translateX(-50%); padding: 7px 16px; border-radius: 999px; background: rgba(10,14,26,0.74); backdrop-filter: blur(8px); border: 1px solid rgba(255,255,255,0.18); font-size: 11.5px; font-weight: 700; letter-spacing: 0.08em; color: rgba(255,255,255,0.9); pointer-events: none; transition: opacity 0.25s; opacity: 0; z-index: 99990; }
    #vi-lock-hint.show { opacity: 1; }

    /* Bottom-Right Contextual Hints + Vehicle Scan Card (ref_06) */
    #vi-hints { position: fixed; right: 26px; bottom: 22px; display: flex; flex-direction: column; align-items: flex-end; gap: 6px; }
    .vi-hint-pill { display: flex; align-items: center; gap: 7px; font-size: 11px; font-weight: 700; letter-spacing: 0.09em; color: rgba(255,255,255,0.88); text-shadow: 0 1px 4px rgba(0,0,0,0.85); }
    .vi-keycap { padding: 2px 6px; border-radius: 4px; background: #fff; color: #11131C; font-size: 10px; font-weight: 900; }
    .vi-ps-cap { padding: 2px 6px; border-radius: 4px; background: rgba(0,112,209,0.88); border: 1px solid rgba(125,211,252,0.55); color: #fff; font-size: 10px; font-weight: 900; }

    /* Slide-in Vehicle Scan / Notification Toast */
    #vi-toast-stack { position: fixed; left: 26px; top: 96px; display: flex; flex-direction: column; gap: 8px; max-width: 310px; }
    .vi-toast { border-radius: 8px; overflow: hidden; box-shadow: 0 12px 30px rgba(0,0,0,0.55); animation: vi-slide-in 0.22s cubic-bezier(0.2,0.9,0.3,1); }
    .vi-toast-hdr { background: rgba(34, 30, 50, 0.94); padding: 7px 12px; font-size: 11px; font-weight: 800; letter-spacing: 0.12em; color: #FF8CC6; border-left: 3px solid #F04A98; }
    .vi-toast-body { background: rgba(236, 232, 224, 0.94); color: #1A1822; padding: 8px 12px; font-size: 12px; font-weight: 600; line-height: 1.35; }
    @keyframes vi-slide-in { from { opacity: 0; transform: translateX(-20px); } to { opacity: 1; transform: translateX(0); } }

    /* Live FPS / Frame-Time Counter Pill (docked cleanly below top-center CHEATS/HUD/PS5 bar) */
    #vi-fps-pill { position: fixed; top: 52px; left: 50%; transform: translateX(-50%); padding: 4px 12px; border-radius: 8px; background: rgba(12,16,30,0.84); border: 1px solid rgba(103,232,208,0.45); font-size: 11px; font-weight: 800; letter-spacing: 0.06em; font-variant-numeric: tabular-nums; color: #67E8D0; display: none; }
    #vi-fps-pill.visible { display: block; }

    /* ---- PHASE 4: REAL 8-CARD RECTANGULAR WEAPON WHEEL (Exact ref_03) ---- */
    #vi-wheel { position: fixed; inset: 0; z-index: 99993; pointer-events: auto; background: rgba(10,12,20,0.36); backdrop-filter: blur(10px); display: none; align-items: center; justify-content: center; }
    #vi-wheel.open { display: flex; }
    .vi-wheel-tabs { position: absolute; top: 44px; left: 50%; transform: translateX(-50%); display: flex; flex-direction: column; align-items: center; gap: 6px; }
    .vi-wheel-tab-row { display: flex; background: rgba(16,19,30,0.78); border-radius: 4px; overflow: hidden; border: 1px solid rgba(255,255,255,0.16); }
    .vi-wtab { padding: 6px 18px; font-size: 13px; font-weight: 800; letter-spacing: 0.10em; cursor: pointer; color: #E2E6F0; background: transparent; border: none; }
    .vi-wtab.active { background: #fff; color: #11131A; }
    .vi-wheel-stage { position: relative; width: 520px; height: 470px; }
    .vi-wheel-ring { position: absolute; left: 50%; top: 50%; width: 356px; height: 356px; transform: translate(-50%,-50%); border-radius: 50%; border: 1px solid rgba(255,255,255,0.22); pointer-events: none; }
    .vi-wheel-center { position: absolute; left: 50%; top: 50%; transform: translate(-50%,-50%); text-align: center; pointer-events: none; }
    .vi-wheel-title { font-size: 23px; font-weight: 800; letter-spacing: 0.08em; text-shadow: 0 2px 10px rgba(0,0,0,0.9); }
    .vi-wheel-cat { font-size: 12px; font-weight: 700; letter-spacing: 0.14em; color: #C8CDD6; margin-top: 2px; }
    .vi-wslot { position: absolute; width: 126px; height: 76px; transform: translate(-50%,-50%); border-radius: 3px; background: rgba(255,255,255,0.09); border: 1px solid rgba(255,255,255,0.18); display: flex; flex-direction: column; align-items: center; justify-content: center; cursor: pointer; transition: transform 0.11s ease, border-color 0.11s, background 0.11s; overflow: hidden; }
    .vi-wslot.equipped::after { content: ''; position: absolute; left: 0; right: 0; bottom: 20px; height: 14px; background: radial-gradient(ellipse at center bottom, rgba(56,232,200,0.68), transparent 75%); pointer-events: none; }
    .vi-wslot.selected { border: 2px solid #fff; background: rgba(255,255,255,0.22); transform: translate(-50%,-50%) scale(1.05); box-shadow: 0 8px 26px rgba(0,0,0,0.45); }
    .vi-wslot.selected::before { content: ''; position: absolute; left: 0; right: 0; top: 0; height: 14px; background: radial-gradient(ellipse at center top, rgba(255,92,168,0.65), transparent 78%); pointer-events: none; }
    .vi-wslot-ammo { position: absolute; left: 0; right: 0; bottom: 0; height: 20px; background: rgba(16,18,26,0.82); display: flex; align-items: center; justify-content: center; gap: 6px; font-size: 12px; font-weight: 800; font-variant-numeric: tabular-nums; }
    .vi-wheel-cons { position: absolute; left: 26px; bottom: 26px; display: flex; gap: 10px; }
    .vi-cons-card { width: 64px; height: 82px; border-radius: 6px; background: rgba(20,23,34,0.84); border: 1px solid rgba(255,255,255,0.18); display: flex; flex-direction: column; align-items: center; justify-content: space-between; padding: 8px 4px; cursor: pointer; }
    .vi-cons-card:hover { border-color: #F04A98; background: rgba(240,74,152,0.22); }

    /* ---- PHASE 4: REAL 2026 PAUSE MENU (Exact ref_05_pause_menu_map.jpg) ---- */
    #vi-pause { position: fixed; inset: 0; z-index: 99994; pointer-events: auto; background: rgba(16, 20, 42, 0.94); backdrop-filter: blur(14px); display: none; flex-direction: column; }
    #vi-pause.open { display: flex; }
    .vi-pause-top { height: 56px; padding: 0 28px; display: flex; align-items: center; justify-content: space-between; background: rgba(12, 15, 32, 0.88); border-bottom: 1px solid rgba(255,255,255,0.08); }
    .vi-pause-tabs { display: flex; align-items: center; gap: 24px; }
    .vi-ptab { background: none; border: none; color: #C8CDD6; font-size: 15px; font-weight: 800; letter-spacing: 0.10em; padding: 16px 4px; cursor: pointer; position: relative; text-transform: uppercase; }
    .vi-ptab.active { color: #F04A98; }
    .vi-ptab.active::after { content: ''; position: absolute; left: 0; right: 0; bottom: 0; height: 2.5px; background: #F04A98; }
    .vi-pause-body { flex: 1; position: relative; overflow: hidden; display: flex; }
    .vi-map-rail { position: absolute; left: 20px; top: 20px; z-index: 5; display: flex; flex-direction: column; gap: 6px; background: rgba(18,21,36,0.88); padding: 6px; border-radius: 8px; border: 1px solid rgba(255,255,255,0.10); }
    .vi-rail-btn { width: 38px; height: 38px; border-radius: 5px; border: none; background: transparent; color: #D8DCE8; font-size: 16px; cursor: pointer; position: relative; display: flex; align-items: center; justify-content: center; }
    .vi-rail-btn.active { background: #fff; color: #141933; }
    .vi-rail-btn.active::before { content: ''; position: absolute; left: 0; top: 3px; bottom: 3px; width: 3px; background: #F04A98; }
    .vi-pause-legend { position: absolute; right: 26px; bottom: 20px; z-index: 5; display: flex; flex-direction: column; align-items: flex-end; gap: 8px; }
    .vi-panel-wrap { width: 100%; height: 100%; padding: 28px 44px; overflow-y: auto; display: flex; gap: 28px; }
    .vi-card { background: rgba(11,15,30,0.78); border: 1px solid rgba(255,255,255,0.12); border-radius: 14px; padding: 22px; }
    .vi-row { display: flex; align-items: center; justify-content: space-between; gap: 14px; padding: 10px 0; border-bottom: 1px solid rgba(255,255,255,0.07); font-size: 13px; font-weight: 600; }
    .vi-row input[type=range] { width: 155px; accent-color: #F04A98; }
    .vi-toggle { width: 42px; height: 22px; border-radius: 999px; background: rgba(255,255,255,0.18); border: none; position: relative; cursor: pointer; transition: background 0.16s; }
    .vi-toggle.on { background: #F04A98; }
    .vi-toggle::after { content: ''; position: absolute; top: 3px; left: 3px; width: 16px; height: 16px; border-radius: 50%; background: #fff; transition: transform 0.16s; }
    .vi-toggle.on::after { transform: translateX(20px); }

    /* ---- PHASE 4: REAL 2026 LEONIDA SMARTPHONE (Exact ref_06_phone_and_minimap.jpg) ---- */
    #vi-phone { position: fixed; right: 34px; bottom: -520px; width: 256px; height: 474px; z-index: 99993; pointer-events: auto; border-radius: 34px; background: linear-gradient(145deg, #D9DCE3 0%, #9FA6B3 100%); padding: 10px; box-shadow: 0 26px 60px rgba(0,0,0,0.72), inset 0 1px 2px rgba(255,255,255,0.8); transition: bottom 0.24s cubic-bezier(0.18,0.9,0.25,1); }
    #vi-phone.open { bottom: 26px; }
    .vi-phone-screen { width: 100%; height: 100%; border-radius: 25px; overflow: hidden; background: linear-gradient(160deg, #4B6B7C 0%, #2B4554 45%, #5C898A 100%); display: flex; flex-direction: column; padding: 12px 14px; position: relative; }
    .vi-phone-speaker { width: 42px; height: 4px; border-radius: 3px; background: #262A34; margin: 0 auto 8px; }
    .vi-phone-status { display: flex; justify-content: space-between; font-size: 11px; font-weight: 700; color: rgba(255,255,255,0.92); margin-bottom: 10px; }
    .vi-phone-rem { background: rgba(22,26,38,0.82); border-radius: 12px; padding: 9px 11px; margin-bottom: 14px; }
    .vi-phone-grid { display: grid; grid-template-columns: repeat(4, 1fr); gap: 11px 8px; }
    .vi-app-btn { width: 44px; height: 44px; border-radius: 50%; border: 2px solid transparent; display: flex; align-items: center; justify-content: center; font-size: 18px; cursor: pointer; margin: 0 auto; transition: transform 0.13s, border-color 0.13s; color: #fff; }
    .vi-app-btn:hover, .vi-app-btn.sel { transform: scale(1.12); border-color: #fff; }
    .vi-phone-pill { position: absolute; left: 50%; bottom: 18px; transform: translateX(-50%); padding: 5px 16px; border-radius: 999px; background: rgba(16,20,30,0.86); font-size: 12px; font-weight: 700; }
    #vi-phone-appview { position: absolute; inset: 34px 10px 10px; border-radius: 18px; background: rgba(16,20,34,0.95); padding: 12px; display: none; flex-direction: column; gap: 8px; overflow-y: auto; }
    #vi-phone-appview.open { display: flex; }

    /* Character Switch Leonida Flash */
    #vi-switch-flash { position: fixed; inset: 0; z-index: 99998; pointer-events: none; opacity: 0; background: radial-gradient(circle, rgba(240,74,152,0.55), rgba(14,18,36,0.92)); transition: opacity 0.25s; display: flex; align-items: center; justify-content: center; font-size: 28px; font-weight: 900; letter-spacing: 0.18em; }
    #vi-switch-flash.show { opacity: 1; }
  `;

  function attachDom() {
    if (!document.head || !document.body) {
      setTimeout(attachDom, 25);
      return;
    }
    document.head.appendChild(styleEl);

    const root = document.createElement('div');
    root.id = 'vbx-gta6-root';
    root.innerHTML = `
      <!-- PHASE 3: BOOT INTRO -->
      <div id="vi-intro">
        <video id="vi-intro-video" playsinline></video>
        <canvas id="vi-intro-canvas"></canvas>
        <div id="vi-intro-skip">PRESS ANY KEY OR CLICK TO SKIP</div>
      </div>

      <!-- PHASE 3: MAIN MENU -->
      <div id="vi-menu">
        <div class="vi-menu-bg" id="vi-menu-bg"></div>
        <div class="vi-menu-scrim"></div>
        <div class="vi-menu-left">
          <div>
            <div class="vi-brand-tag">● GRAND THEFT AUTO VI · EXPERIMENTAL SANDBOX</div>
            <img class="vi-logo-img" src="/vbx/img/gta6_logo.png" alt="Grand Theft Auto VI">
          </div>
          <div class="vi-nav-list">
            <button class="vi-menu-btn primary" id="vi-btn-sandbox">
              <span>▶ PLAY SANDBOX</span>
              <span style="font-size:11px;opacity:0.9;">LEONIDA</span>
            </button>
            <div class="vi-map-pills">
              <button class="vi-pill ${cfg.sandboxMap === 'env_test' ? 'active' : ''}" data-map="env_test">VICE CITY / FLORIDA (env_test)</button>
              <button class="vi-pill ${cfg.sandboxMap === 'main' ? 'active' : ''}" data-map="main">LOS SANTOS (GTA V MAP)</button>
            </div>
            <button class="vi-menu-btn" id="vi-btn-story" disabled title="Story Mode is unavailable in this Experimental Sandbox build">
              <span>🔒 STORY MODE</span>
              <span class="vi-badge-tbc">TO BE CONTINUED</span>
            </button>
            <button class="vi-menu-btn" id="vi-btn-char">
              <span class="vi-char-chip">
                <span class="vi-char-ava ${cfg.character}" id="vi-menu-ava"></span>
                <span id="vi-menu-char-lbl">${CHARACTERS[cfg.character].name}</span>
              </span>
              <span style="font-size:11px;color:#67E8D0;">SWITCH</span>
            </button>
            <button class="vi-menu-btn" id="vi-btn-settings">
              <span>⚙ SETTINGS</span>
              <span style="font-size:11px;color:#C8CDD6;">DISPLAY · FX</span>
            </button>
            <button class="vi-menu-btn" id="vi-btn-exit">
              <span>← EXIT TO ${(qs.get('vbx_from') || qs.get('vbx_console') || 'ps5').toUpperCase()}</span>
              <span style="font-size:11px;color:#C8CDD6;">DASHBOARD</span>
            </button>
          </div>
          <div class="vi-menu-footer">
            <span>VICEBOX X · ${(qs.get('vbx_from') || qs.get('vbx_console') || 'ps5').toUpperCase()} WEBGPU SANDBOX</span>
            <span id="vi-menu-perf-note">GTX 1050 60 FPS TARGET</span>
          </div>
        </div>
        <div id="vi-menu-settings"></div>
      </div>

      <!-- LOADING TRANSITION -->
      <div id="vi-loading">
        <div class="vi-load-bg"></div>
        <div class="vi-load-grad"></div>
        <div class="vi-load-content">
          <div style="font-size:12px;letter-spacing:0.18em;color:#F04A98;font-weight:800;">ENTERING ${cfg.sandboxMap === 'env_test' ? 'LEONIDA · FLORIDA TEST WORLD (env_test)' : 'SANDBOX WORLD · LOS SANTOS'}</div>
          <div style="font-size:32px;font-weight:900;letter-spacing:0.06em;margin-top:4px;" id="vi-load-char">PLAYING AS ${CHARACTERS[cfg.character].name}</div>
          <div class="vi-load-track"><div class="vi-load-fill" id="vi-load-fill"></div></div>
          <div style="display:flex;justify-content:space-between;align-items:center;font-size:12px;color:#E6EAF4;gap:12px;">
            <span id="vi-load-lbl">Initializing RAGE WebAssembly &amp; WebGPU...</span>
            <span id="vi-load-pct" style="font-variant-numeric:tabular-nums;font-weight:800;">1%</span>
          </div>
          <div id="vi-load-dl" style="font-size:11.5px;color:#67E8D0;margin-top:6px;min-height:16px;font-variant-numeric:tabular-nums;"></div>
          <div id="vi-load-console" style="font-size:10.5px;font-family:Consolas,monospace;color:rgba(200,210,230,0.68);margin-top:3px;min-height:15px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;"></div>
          <div style="display:flex;gap:8px;margin-top:14px;flex-wrap:wrap;">
            <button id="vi-btn-raw-engine" style="padding:6px 12px;border-radius:7px;border:1px solid rgba(255,255,255,0.22);background:rgba(255,255,255,0.08);color:#DCE4F4;font-size:10.5px;font-weight:700;letter-spacing:0.08em;cursor:pointer;">VIEW RAW ENGINE</button>
            <button id="vi-btn-lowmem" style="padding:6px 12px;border-radius:7px;border:1px solid rgba(103,232,208,0.38);background:rgba(103,232,208,0.12);color:#9FF7E6;font-size:10.5px;font-weight:700;letter-spacing:0.08em;cursor:pointer;">LOW-MEMORY SAFE MODE (4GB / GTX 1050)</button>
          </div>
          <div id="vi-load-err" style="display:none;margin-top:14px;padding:12px 14px;border-radius:10px;background:rgba(255,46,99,0.18);border:1px solid rgba(255,46,99,0.65);font-size:12px;color:#FFD6E0;"></div>
        </div>
      </div>
      <button id="vbx-raw-close">← BACK TO GTA VI LOADING OVERLAY</button>

      <!-- PHASE 4: IN-GAME SANDBOX HUD -->
      <div id="vi-hud">
        <!-- Top-Left Vitals (Health Pink, Stamina Mint, Focus Violet) -->
        <div class="vi-vitals" id="vi-vitals">
          <div class="vi-vital-row">
            <svg class="vi-vital-ico" viewBox="0 0 24 24" fill="#F4A5C4"><path d="M12 21.35l-1.45-1.32C5.4 15.36 2 12.28 2 8.5 2 5.42 4.42 3 7.5 3c1.74 0 3.41.81 4.5 2.09C13.09 3.81 14.76 3 16.5 3 19.58 3 22 5.42 22 8.5c0 3.78-3.4 6.86-8.55 11.54L12 21.35z"/></svg>
            <div class="vi-vital-track"><div class="vi-vital-fill" id="vi-bar-hp" style="width:100%"></div></div>
          </div>
          <div class="vi-vital-row">
            <svg class="vi-vital-ico" viewBox="0 0 24 24" fill="#67E8D0"><path d="M13 2L3 14h7l-1 8 10-12h-7l1-8z"/></svg>
            <div class="vi-vital-track"><div class="vi-vital-fill" id="vi-bar-stam" style="width:100%"></div></div>
          </div>
          <div class="vi-vital-row">
            <svg class="vi-vital-ico" viewBox="0 0 24 24" fill="#9C85FF"><path d="M12 4.5C7 4.5 2.73 7.61 1 12c1.73 4.39 6 7.5 11 7.5s9.27-3.11 11-7.5c-1.73-4.39-6-7.5-11-7.5zm0 12.5a5 5 0 110-10 5 5 0 010 10zm0-8a3 3 0 100 6 3 3 0 000-6z"/></svg>
            <div class="vi-vital-track"><div class="vi-vital-fill" id="vi-bar-focus" style="width:88%"></div></div>
          </div>
        </div>

        <!-- Live Dev FPS & Frame-Time Verification Pill -->
        <div id="vi-fps-pill">60.0 FPS · 14.2 ms · 1080p</div>

        <!-- Top-Right Economy, Ammo & 6-Star Wanted -->
        <div class="vi-topright">
          <div class="vi-money-row"><span id="vi-bank">$15,150</span><span style="width:18px;height:18px;border-radius:50%;background:#9C85FF;display:inline-flex;align-items:center;justify-content:center;font-size:11px;font-weight:900;color:#111;">b</span></div>
          <div class="vi-money-row vi-money-cash"><span id="vi-cash">$700</span><span style="padding:1px 4px;border-radius:3px;background:#4ADE80;color:#0A1810;font-size:10px;font-weight:900;">$</span></div>
          <div class="vi-ammo-box" id="vi-ammo-box"><span id="vi-ammo-mag">20</span><span class="vi-ammo-res" id="vi-ammo-res">80</span></div>
          <div class="vi-wanted-stars" id="vi-wanted-stars"></div>
          <div class="vi-clues" id="vi-clues"></div>
        </div>

        <!-- Slide-In Notifications -->
        <div id="vi-toast-stack"></div>

        <!-- Optional Top-Center GTA VI Directional Compass Strip (Compass Mode) -->
        <div id="vi-compass-wrap">
          <canvas id="vi-compass-canvas" width="640" height="56"></canvas>
        </div>

        <!-- Authentic 2026 GTA VI 3D/2D iFruit Minimap -->
        <div id="vi-minimap-wrap">
          <div id="vi-minimap-shell" class="mode-3d">
            <canvas id="vi-minimap-canvas" width="536" height="316"></canvas>
            <div id="vi-minimap-wanted-wash"></div>
            <div id="vi-minimap-gps">1.86 mi</div>
            <div id="vi-minimap-player">
              <svg width="11" height="11" viewBox="0 0 12 12" fill="#FFFFFF"><path d="M6 1L10.5 10.5L6 8.3L1.5 10.5Z"/></svg>
            </div>
          </div>
          <div id="vi-minimap-north">N</div>
          <div id="vi-minimap-wp-pin"></div>
        </div>

        <!-- Optional Live Hair/Cloth Physics Companion Rig -->
        <div id="vi-phys-rig">
          <canvas id="vi-phys-canvas" width="108" height="126"></canvas>
          <div id="vi-phys-lbl">LUCIA · SPRING</div>
        </div>

        <!-- Subtle pointer-lock & audio activation helper -->
        <div id="vi-lock-hint">Click game viewport to lock camera &amp; enable audio</div>

        <!-- Bottom-Right Contextual Hints (PS5 DualSense + PC) -->
        <div id="vi-hints">
          <div class="vi-hint-pill"><span>LOADOUT</span><span class="vi-ps-cap">L1</span><span class="vi-keycap">TAB</span></div>
          <div class="vi-hint-pill"><span>PAUSE / MAP</span><span class="vi-ps-cap">OPT</span><span class="vi-keycap">P</span></div>
          <div class="vi-hint-pill"><span>PHONE</span><span class="vi-keycap">↑</span></div>
          <div class="vi-hint-pill"><span>FOCUS</span><span class="vi-keycap">CAPS</span></div>
          <div class="vi-hint-pill"><span>SWITCH CHAR</span><span class="vi-keycap">F4</span></div>
        </div>
      </div>

      <!-- PHASE 4: 8-CARD RECTANGULAR WEAPON WHEEL -->
      <div id="vi-wheel">
        <div class="vi-wheel-tabs">
          <span class="vi-keycap">R1 / E</span>
          <div class="vi-wheel-tab-row">
            <button class="vi-wtab active" data-wtab="weapons">WEAPONS</button>
            <button class="vi-wtab" data-wtab="items">ITEMS</button>
          </div>
        </div>
        <div class="vi-wheel-stage" id="vi-wheel-stage">
          <div class="vi-wheel-ring"></div>
          <div class="vi-wheel-center">
            <div class="vi-wheel-title" id="vi-wheel-title">9MM PISTOL</div>
            <div class="vi-wheel-cat" id="vi-wheel-cat">SIDEARM</div>
          </div>
        </div>
        <div class="vi-wheel-cons">
          <div class="vi-cons-card" id="vi-use-med">
            <span style="font-size:22px;">💊</span>
            <span style="font-size:12px;font-weight:800;" id="vi-med-cnt">2 ♥</span>
            <span class="vi-keycap">□</span>
          </div>
          <div class="vi-cons-card" id="vi-use-focus">
            <span style="font-size:22px;">⚡</span>
            <span style="font-size:12px;font-weight:800;color:#FFD166;" id="vi-foc-cnt">2 ✦</span>
            <span class="vi-keycap">△</span>
          </div>
        </div>
      </div>

      <!-- PHASE 4: PAUSE MENU (2026 LEONIDA LAYOUT) -->
      <div id="vi-pause">
        <div class="vi-pause-top">
          <div style="font-size:14px;color:#C8CDD6;font-weight:700;" id="vi-pause-clock">1:37 pm</div>
          <div class="vi-pause-tabs">
            <span class="vi-keycap">L1</span>
            <button class="vi-ptab" data-ptab="character">JASON &amp; LUCIA</button>
            <button class="vi-ptab active" data-ptab="map">MAP</button>
            <button class="vi-ptab" data-ptab="brief">BRIEF</button>
            <button class="vi-ptab" data-ptab="progress">PROGRESS</button>
            <button class="vi-ptab" data-ptab="settings">SETTINGS</button>
            <span class="vi-keycap">R1</span>
          </div>
          <div style="display:flex;align-items:center;gap:8px;font-weight:800;font-size:16px;">
            <span id="vi-pause-cash">$15,850</span>
            <span style="padding:1px 5px;border-radius:3px;background:#4ADE80;color:#0A1810;font-size:10px;font-weight:900;">$</span>
          </div>
        </div>
        <div class="vi-pause-body" id="vi-pause-body"></div>
      </div>

      <!-- PHASE 4: LEONIDA SMARTPHONE -->
      <div id="vi-phone">
        <div class="vi-phone-screen">
          <div class="vi-phone-speaker"></div>
          <div class="vi-phone-status">
            <span id="vi-ph-time">3:35 pm</span>
            <span id="vi-ph-wx" style="color:#FFD166;">☀ 80°</span>
          </div>
          <div class="vi-phone-rem">
            <div style="font-size:11px;font-weight:800;color:#fff;">✦ Reminders</div>
            <div style="font-size:10px;color:#B8C0D4;margin-top:2px;" id="vi-ph-rem-txt">2 Notifications · Vice-Dale</div>
          </div>
          <div class="vi-phone-grid" id="vi-phone-grid"></div>
          <div class="vi-phone-pill" id="vi-phone-pill">WhatUp</div>
          <div id="vi-phone-appview"></div>
        </div>
      </div>

      <div id="vi-switch-flash"></div>
    `;
    document.body.appendChild(root);

    initBootIntro();
    initMainMenu();
    initWeaponWheel();
    initPhone();
    initControlsAndLoop();
  }

  // ==================== PHASE 3: CINEMATIC BOOT INTRO ====================
  function initBootIntro() {
    const intro = document.getElementById('vi-intro');
    // Arrived cleanly from /gta6/boot (real GTA 6 Rockstar Logo startup video already played/skipped)
    if (qs.get('vbx_intro_done') === '1' || qs.get('vbx_skip_intro') === '1') {
      if (intro) intro.style.display = 'none';
      if (qs.get('vbx_skip_intro') !== '1') showMainMenu();
      return;
    }
    const vid = document.getElementById('vi-intro-video');
    const cv = document.getElementById('vi-intro-canvas');
    let skipped = false;
    let rafId = 0;

    function finishIntro() {
      if (skipped) return;
      skipped = true;
      if (rafId) cancelAnimationFrame(rafId);
      try { vid.pause(); } catch (e) {}
      intro.classList.add('hidden');
      setTimeout(() => { intro.style.display = 'none'; }, 520);
      showMainMenu();
    }

    const onSkip = () => {
      playUiTone(520, 0.08, 0.05, 'triangle');
      finishIntro();
    };
    intro.addEventListener('click', onSkip);
    const keySkip = (e) => {
      if (state.phase === 'intro') {
        e.preventDefault();
        window.removeEventListener('keydown', keySkip, true);
        onSkip();
      }
    };
    window.addEventListener('keydown', keySkip, true);

    // Try user-supplied /vbx/user/gta6_intro.mp4 first; cleanly fall back to 60fps Vice Neon Canvas intro!
    let canvasStarted = false;
    function startCanvasIntro() {
      if (canvasStarted || skipped) return;
      canvasStarted = true;
      vid.style.display = 'none';
      const ctx = cv.getContext('2d');
      if (!ctx) { setTimeout(finishIntro, 1800); return; }
      playIntroChord();
      const t0 = performance.now();

      function frame(now) {
        if (skipped) return;
        const t = (now - t0) / 1000;
        const w = cv.width = window.innerWidth;
        const h = cv.height = window.innerHeight;
        ctx.fillStyle = '#000';
        ctx.fillRect(0, 0, w, h);

        if (t < 1.8) {
          // Stage 1: Stylized Gold/Vice Star emblem reveal
          const a = Math.min(1, t * 1.4) * (t > 1.35 ? Math.max(0, (1.8 - t) / 0.45) : 1);
          ctx.save();
          ctx.globalAlpha = a;
          const grad = ctx.createRadialGradient(w * 0.5, h * 0.5, 10, w * 0.5, h * 0.5, 240);
          grad.addColorStop(0, 'rgba(255, 185, 70, 0.35)');
          grad.addColorStop(0.5, 'rgba(240, 74, 152, 0.14)');
          grad.addColorStop(1, 'rgba(0,0,0,0)');
          ctx.fillStyle = grad;
          ctx.fillRect(0, 0, w, h);

          ctx.fillStyle = '#FFD166';
          ctx.beginPath();
          ctx.roundRect(w * 0.5 - 52, h * 0.5 - 52, 104, 104, 22);
          ctx.fill();
          ctx.fillStyle = '#0D0B14';
          ctx.font = '900 54px Bahnschrift, Segoe UI, sans-serif';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.fillText('R★', w * 0.5, h * 0.5 + 3);
          ctx.fillStyle = '#E8ECF8';
          ctx.font = '700 13px Bahnschrift, Segoe UI, sans-serif';
          ctx.fillText('VICEBOX X  ·  LEONIDA EXPERIMENTAL ENGINE', w * 0.5, h * 0.5 + 88);
          ctx.restore();
        } else if (t < 4.9) {
          // Stage 2: Leonida sunset palm horizon + neon outlined VI + GRAND THEFT AUTO
          const p = (t - 1.8) / 3.1;
          const fadeIn = Math.min(1, p * 3.5);
          const fadeOut = p > 0.84 ? Math.max(0, (1 - p) / 0.16) : 1;
          ctx.save();
          ctx.globalAlpha = fadeIn * fadeOut;

          const sky = ctx.createLinearGradient(0, 0, 0, h);
          sky.addColorStop(0, '#140E29');
          sky.addColorStop(0.52, '#5F2B63');
          sky.addColorStop(0.84, '#F04A98');
          sky.addColorStop(1, '#FF9E6D');
          ctx.fillStyle = sky;
          ctx.fillRect(0, 0, w, h);

          // Glowing outlined Roman numeral VI
          const sc = 0.94 + p * 0.08;
          ctx.translate(w * 0.5, h * 0.5);
          ctx.scale(sc, sc);
          ctx.font = '900 190px Bahnschrift, Impact, sans-serif';
          ctx.textAlign = 'center';
          ctx.textBaseline = 'middle';
          ctx.lineWidth = 5;
          ctx.strokeStyle = 'rgba(255,255,255,0.92)';
          ctx.shadowColor = '#F04A98';
          ctx.shadowBlur = 32;
          ctx.strokeText('VI', 0, 12);

          ctx.shadowBlur = 18;
          ctx.shadowColor = 'rgba(0,0,0,0.8)';
          ctx.fillStyle = '#FFFFFF';
          ctx.font = '900 42px Bahnschrift, Segoe UI, sans-serif';
          ctx.fillText('GRAND THEFT AUTO', 0, -4);
          ctx.restore();
        } else {
          finishIntro();
          return;
        }
        rafId = requestAnimationFrame(frame);
      }
      rafId = requestAnimationFrame(frame);
    }

    vid.onerror = startCanvasIntro;
    vid.onended = finishIntro;
    vid.oncanplay = () => {
      if (skipped) return;
      vid.style.display = 'block';
      vid.play().catch(startCanvasIntro);
    };
    vid.src = '/vbx/user/gta6_intro.mp4';
    // Quick fallback if no local video responds within 320ms
    setTimeout(() => { if (!vid.readyState && !canvasStarted) startCanvasIntro(); }, 320);
  }

  // ==================== PHASE 3: MAIN MENU ====================
  function showMainMenu() {
    state.phase = 'menu';
    document.body.classList.remove('vbx-gta6-playing');
    const menu = document.getElementById('vi-menu');
    menu.style.display = 'block';
    menu.classList.add('visible');
    menu.classList.remove('fadeout');
    renderSettingsPanel(document.getElementById('vi-menu-settings'), false);
  }

  function initMainMenu() {
    const menu = document.getElementById('vi-menu');
    const bg = document.getElementById('vi-menu-bg');
    menu.addEventListener('mousemove', (e) => {
      const rx = (e.clientX / window.innerWidth - 0.5) * -18;
      const ry = (e.clientY / window.innerHeight - 0.5) * -12;
      bg.style.transform = `translate3d(${rx}px, ${ry}px, 0) scale(1.04)`;
    });

    // Map selector pills (Main Map vs env_test)
    menu.querySelectorAll('.vi-pill[data-map]').forEach((btn) => {
      btn.addEventListener('click', () => {
        playUiTone(480, 0.06, 0.05);
        cfg.sandboxMap = btn.dataset.map;
        menu.querySelectorAll('.vi-pill[data-map]').forEach((b) => b.classList.toggle('active', b === btn));
        saveCfg();
      });
    });

    // Protagonist switch button (Lucia / Jason)
    document.getElementById('vi-btn-char').addEventListener('click', () => {
      playUiTone(540, 0.08, 0.06, 'triangle');
      cfg.character = (cfg.character === 'lucia') ? 'jason' : 'lucia';
      const ch = CHARACTERS[cfg.character];
      const ava = document.getElementById('vi-menu-ava');
      ava.className = 'vi-char-ava ' + cfg.character;
      document.getElementById('vi-menu-char-lbl').textContent = ch.name;
      document.getElementById('vi-load-char').textContent = 'PLAYING AS ' + ch.name;
      saveCfg();
    });

    // Settings drawer toggle
    document.getElementById('vi-btn-settings').addEventListener('click', () => {
      playUiTone(440, 0.07, 0.05);
      const panel = document.getElementById('vi-menu-settings');
      panel.classList.toggle('open');
      renderSettingsPanel(panel, false);
    });

    // Exit back to PS5 / Xbox / ViceOS Neo console dashboard
    document.getElementById('vi-btn-exit').addEventListener('click', () => {
      playUiTone(310, 0.09, 0.05);
      const from = qs.get('vbx_from') || 'ps5';
      window.location.href = (from === 'xbox') ? '/xbox/' : (from === 'viceos' ? '/viceos/' : '/ps5/');
    });

    // PLAY SANDBOX (the ONLY playable mode; Story Mode stays disabled!)
    document.getElementById('vi-btn-sandbox').addEventListener('click', () => {
      playUiTone(640, 0.14, 0.08, 'triangle');
      startSandboxLaunch();
    });
  }

  function triggerPlayGta5SandboxMode() {
    // Programmatically select Sandbox Mode (GTA V map or env_test) in playgta5's hidden #modes bar
    try {
      const modes = document.getElementById('modes');
      if (modes) {
        const sbBtn = modes.querySelector('button[data-act="sandbox"]');
        if (sbBtn && !sbBtn.hidden) sbBtn.click();
        setTimeout(() => {
          const mapAct = cfg.sandboxMap === 'env_test' ? 'map6' : 'map5';
          const mBtn = modes.querySelector(`button[data-act="${mapAct}"]`);
          if (mBtn && !mBtn.hidden) mBtn.click();
        }, 120);
      }
    } catch (e) {}
  }

  function startSandboxLaunch() {
    state.phase = 'loading';
    document.body.classList.remove('vbx-gta6-playing');
    const menu = document.getElementById('vi-menu');
    const loadEl = document.getElementById('vi-loading');
    menu.classList.add('fadeout');
    setTimeout(() => { menu.classList.remove('visible'); menu.style.display = 'none'; }, 450);

    // Wire diagnostic Raw Engine viewer & Low-Memory Safe Mode buttons once
    const rawBtn = document.getElementById('vi-btn-raw-engine');
    const rawClose = document.getElementById('vbx-raw-close');
    const lowMemBtn = document.getElementById('vi-btn-lowmem');
    if (rawBtn && !rawBtn.dataset.bound) {
      rawBtn.dataset.bound = '1';
      rawBtn.addEventListener('click', () => document.body.classList.add('vbx-show-raw-engine'));
    }
    if (rawClose && !rawClose.dataset.bound) {
      rawClose.dataset.bound = '1';
      rawClose.addEventListener('click', () => document.body.classList.remove('vbx-show-raw-engine'));
    }
    if (lowMemBtn && !lowMemBtn.dataset.bound) {
      lowMemBtn.dataset.bound = '1';
      lowMemBtn.addEventListener('click', () => {
        const nextQs = new URLSearchParams(window.location.search);
        nextQs.set('mode', 'sandbox');
        if (cfg.sandboxMap === 'env_test') nextQs.set('map', 'env_test'); else nextQs.delete('map');
        nextQs.set('scale', '0.75');
        nextQs.set('shadows', '0');
        nextQs.set('args', '-textureQuality=0 -pedVariety=0 -vehicleVariety=0 -shadowQuality=-1 -reflectionQuality=0 -particleQuality=0 -grassQuality=0 -cityDensity=0 -lodScale=0 -pedLodBias=0 -vehicleLodBias=0');
        nextQs.set('vbx_skip_intro', '1');
        window.location.search = nextQs.toString();
      });
    }

    // If user switched map selection vs initial URL query, reload cleanly into the chosen sandbox map (skipping intro!)
    const curIsEnv = qs.get('map') === 'env_test';
    const wantEnv = cfg.sandboxMap === 'env_test';
    if (curIsEnv !== wantEnv && !state.worldReady) {
      qs.set('mode', 'sandbox');
      if (wantEnv) qs.set('map', 'env_test'); else qs.delete('map');
      qs.set('vbx_skip_intro', '1');
      window.location.search = qs.toString();
      return;
    }

    const pgLoading = document.getElementById('loading');
    const pgHud0 = document.getElementById('hud');
    if (state.worldReady || (pgLoading && pgLoading.classList.contains('done')) || (pgHud0 && pgHud0.classList.contains('show'))) {
      state.worldReady = true;
      enterPlayingPhase();
      return;
    }

    loadEl.style.display = 'flex';
    loadEl.classList.add('visible');
    triggerPlayGta5SandboxMode();

    let lastActivityAt = performance.now();
    let lastObservedPct = state.loadPct;
    let lastObservedBytes = state.loadBytes;

    // Monitor REAL PlayGTA5 loading progress (BroadcastChannel + real DOM IDs #label/#pct/#data/#console/#hud).
    // NEVER exit prematurely on presentCount/pct=76 (PlayGTA5 posts pct=76 on its very first empty black pre-world frame!).
    const tick = setInterval(() => {
      if (state.phase !== 'loading') { clearInterval(tick); return; }

      const pgLoad = document.getElementById('loading');
      const pgLbl  = document.getElementById('label');
      const pgPct  = document.getElementById('pct');
      const pgData = document.getElementById('data');
      const pgCon  = document.getElementById('console');
      const pgHud  = document.getElementById('hud');

      if (pgPct && pgPct.textContent) {
        const parsed = parseInt(pgPct.textContent, 10);
        if (!isNaN(parsed) && parsed > state.loadPct) state.loadPct = parsed;
      }
      if (pgLbl && pgLbl.textContent && pgLbl.textContent.trim()) {
        state.loadLabel = pgLbl.textContent.trim();
      }
      if (pgData && pgData.textContent && pgData.textContent.trim() && !state.loadDl) {
        state.loadDl = pgData.textContent.trim();
      }
      if (pgCon && pgCon.textContent && pgCon.textContent.trim()) {
        const lines = pgCon.textContent.trim().split('\n');
        const last = lines[lines.length - 1];
        if (last) state.loadConsole = last.trim();
      }
      if (state.choiceReady) {
        triggerPlayGta5SandboxMode();
      }

      if (state.loadPct !== lastObservedPct || state.loadBytes !== lastObservedBytes) {
        lastObservedPct = state.loadPct;
        lastObservedBytes = state.loadBytes;
        lastActivityAt = performance.now();
      }

      const fill = document.getElementById('vi-load-fill');
      const lbl  = document.getElementById('vi-load-lbl');
      const pct  = document.getElementById('vi-load-pct');
      const dlEl = document.getElementById('vi-load-dl');
      const conEl = document.getElementById('vi-load-console');
      const errBox = document.getElementById('vi-load-err');

      const p = Math.min(99, Math.max(1, Math.round(state.loadPct)));
      if (fill) fill.style.width = p + '%';
      if (lbl) lbl.textContent = state.loadLabel || 'Streaming Leonida Sandbox World...';
      if (pct) pct.textContent = p + '%';
      if (dlEl) {
        const mbStr = state.loadBytes > 0 ? `${(state.loadBytes / 1048576).toFixed(1)} MB streamed` : '';
        const spdStr = state.loadSpeedMBs > 0.05 ? ` · ${state.loadSpeedMBs.toFixed(1)} MB/s` : '';
        const compStr = state.compilingShaders > 0 ? ` · Compiling ${state.compilingShaders} WebGPU shaders` : '';
        const framesStr = state.realFramesSeen > 0 ? ` · ${state.realFramesSeen} boot frames` : '';
        dlEl.textContent = state.loadDl || (mbStr ? `${mbStr}${spdStr}${compStr}${framesStr}` : 'Downloading & compiling RAGE WebAssembly...');
      }
      if (conEl && state.loadConsole) {
        conEl.textContent = '> ' + state.loadConsole;
      }

      const stalledSec = (performance.now() - lastActivityAt) / 1000;
      if ((state.loadError || stalledSec > 35) && errBox) {
        errBox.style.display = 'block';
        const from = qs.get('vbx_from') || qs.get('vbx_console') || 'ps5';
        const backUrl = (from === 'xbox') ? '/xbox/' : (from === 'viceos' ? '/viceos/' : '/ps5/');
        const msg = state.loadError
          ? `ENGINE NOTICE: ${state.loadError}`
          : `STILL STREAMING (${Math.round(stalledSec)}s without progress) — Large maps (env_test = 5.5 GB) stream on first launch. You can inspect the raw PlayGTA5 console or switch to Low-Memory Safe Mode.`;
        errBox.innerHTML = `<div style="font-weight:800;margin-bottom:8px;">${msg}</div>` +
          `<div style="display:flex;gap:8px;flex-wrap:wrap;">` +
          `<button onclick="document.body.classList.add('vbx-show-raw-engine')" style="padding:7px 14px;border-radius:7px;border:none;background:#67E8D0;color:#0A121C;font-weight:800;cursor:pointer;">VIEW RAW ENGINE</button>` +
          `<button onclick="location.reload()" style="padding:7px 14px;border-radius:7px;border:none;background:#F04A98;color:#fff;font-weight:800;cursor:pointer;">RETRY LOAD</button>` +
          `<button onclick="location.href='${backUrl}'" style="padding:7px 14px;border-radius:7px;border:1px solid rgba(255,255,255,0.28);background:rgba(255,255,255,0.08);color:#fff;font-weight:800;cursor:pointer;">RETURN TO ${from.toUpperCase()}</button>` +
          `</div>`;
      }

      // Enter gameplay ONLY once PlayGTA5 genuinely completes 3D world initialization!
      // (wgpu_worker posts world: true after rendering >300 draw calls/frame cleanly, OR #loading gets .done / removed)
      const domDone = !!(pgLoad && pgLoad.classList.contains('done'));
      const domRemoved = (!pgLoad && state.loadPct >= 95 && !state.loadError);
      if (state.worldReady || domDone || domRemoved) {
        state.worldReady = true;
        document.body.classList.remove('vbx-show-raw-engine');
        clearInterval(tick);
        enterPlayingPhase();
      }
    }, 180);
  }

  function updatePointerLockHint() {
    const h = document.getElementById('vi-lock-hint');
    if (!h) return;
    const shouldShow = (state.phase === 'playing') && !state.pauseOpen && !state.wheelOpen && !state.phoneOpen && !document.pointerLockElement;
    h.classList.toggle('show', shouldShow);
  }

  function enterPlayingPhase() {
    state.phase = 'playing';
    document.body.classList.add('vbx-gta6-playing');
    const intro = document.getElementById('vi-intro');
    const menu  = document.getElementById('vi-menu');
    const loadEl = document.getElementById('vi-loading');
    if (intro) { intro.classList.add('hidden'); intro.style.display = 'none'; }
    if (menu)  { menu.classList.remove('visible'); menu.style.display = 'none'; }
    if (loadEl) { loadEl.classList.remove('visible'); loadEl.style.display = 'none'; }
    document.getElementById('vi-hud').classList.add('visible');
    updateHudVisibilitySettings();
    updatePointerLockHint();
    syncFxToWgpu();
    pushToast('LEONIDA SANDBOX ACTIVE', `${CHARACTERS[cfg.character].name} · Hold TAB (L1) for Loadout, P (OPT) for Pause/Map, ↑ for Phone, CAPS for Focus, M for 3D/2D Radar, F9 for PS5.`);
  }

  // ==================== SHARED SETTINGS PANEL (MAIN MENU & PAUSE) ====================
  function renderSettingsPanel(container, inPause) {
    if (!container) return;
    container.innerHTML = `
      <div style="display:flex;justify-content:space-between;align-items:center;">
        <div style="font-size:18px;font-weight:900;letter-spacing:0.12em;">SETTINGS</div>
        ${!inPause ? '<button id="vi-close-mset" style="background:none;border:none;color:#C8CDD6;font-size:18px;cursor:pointer;">✕</button>' : ''}
      </div>

      <div class="vi-row">
        <div>
          <div style="color:#fff;">Performance: Auto</div>
          <div style="font-size:11px;color:#9BA6BE;">Balances resolution, shadows &amp; effects for 60 FPS</div>
        </div>
        <button class="vi-toggle ${cfg.perfAuto ? 'on' : ''}" data-set="perfAuto"></button>
      </div>

      <div class="vi-row">
        <div><div>Vice City Lighting</div><div style="font-size:11px;color:#9BA6BE;">Warm ACES filmic grading</div></div>
        <input type="range" min="0" max="100" value="${cfg.viceLighting}" data-rng="viceLighting">
      </div>

      <div class="vi-row">
        <div><div>Motion Blur</div><div style="font-size:11px;color:#9BA6BE;">Per-object &amp; high-speed camera blur</div></div>
        <input type="range" min="0" max="100" value="${cfg.motionBlur}" data-rng="motionBlur">
      </div>

      <div class="vi-row">
        <div><div>Anamorphic Bloom</div><div style="font-size:11px;color:#9BA6BE;">Headlights, neon &amp; ocean speculars</div></div>
        <input type="range" min="0" max="100" value="${cfg.bloom}" data-rng="bloom">
      </div>

      <div class="vi-row">
        <div><div>Volumetric Sun Shafts</div><div style="font-size:11px;color:#9BA6BE;">Golden-hour crepuscular light</div></div>
        <input type="range" min="0" max="100" value="${cfg.sunShafts}" data-rng="sunShafts">
      </div>

      <div class="vi-row">
        <div><div>Hair &amp; Cloth Physics</div><div style="font-size:11px;color:#9BA6BE;">Lucia ponytail &amp; jacket spring simulation</div></div>
        <button class="vi-toggle ${cfg.hairClothPhysics ? 'on' : ''}" data-set="hairClothPhysics"></button>
      </div>

      <div class="vi-row">
        <div><div>Navigation Mode</div><div style="font-size:11px;color:#9BA6BE;">Always On, Dynamic (↓ to summon), or Compass Only</div></div>
        <button id="vi-cycle-navmode" style="padding:5px 12px;border-radius:7px;border:1px solid rgba(255,255,255,0.22);background:rgba(255,255,255,0.10);color:#fff;font-size:11px;font-weight:800;letter-spacing:0.08em;cursor:pointer;text-transform:uppercase;">${cfg.navMode || 'on'}</button>
      </div>

      <div class="vi-row">
        <div><div>3D Perspective Minimap</div><div style="font-size:11px;color:#9BA6BE;">Switch between 3D Satellite GPS and 2D Classic radar (M)</div></div>
        <button class="vi-toggle ${cfg.minimap3D ? 'on' : ''}" data-set="minimap3D"></button>
      </div>

      <div class="vi-row">
        <div><div>Minimap Theme</div><div style="font-size:11px;color:#9BA6BE;">Daylight Light Plate or Nighttime Dark Plate</div></div>
        <button id="vi-cycle-mtheme" style="padding:5px 12px;border-radius:7px;border:1px solid rgba(255,255,255,0.22);background:rgba(255,255,255,0.10);color:#fff;font-size:11px;font-weight:800;letter-spacing:0.08em;cursor:pointer;text-transform:uppercase;">${cfg.minimapTheme || 'auto'}</button>
      </div>

      <div class="vi-row">
        <div><div>Live Physics Corner Rig</div><div style="font-size:11px;color:#9BA6BE;">Preview Lucia/Jason spring solver on HUD</div></div>
        <button class="vi-toggle ${cfg.showCompanionRig ? 'on' : ''}" data-set="showCompanionRig"></button>
      </div>

      <div class="vi-row">
        <div><div>Look Sensitivity (${cfg.lookSensitivity}%)</div><div style="font-size:11px;color:#9BA6BE;">Mouse &amp; controller aim speed</div></div>
        <input type="range" min="20" max="300" value="${cfg.lookSensitivity}" data-rng="lookSensitivity">
      </div>

      <div class="vi-row">
        <div><div>FPS &amp; Frame-Time Counter</div><div style="font-size:11px;color:#9BA6BE;">Live ms &amp; FPS verification pill</div></div>
        <button class="vi-toggle ${cfg.showFpsCounter ? 'on' : ''}" data-set="showFpsCounter"></button>
      </div>

      <div class="vi-row" style="border-bottom:none;padding-top:14px;">
        <div><div>Startup Intro Video</div><div style="font-size:11px;color:#9BA6BE;">Official Rockstar Games GTA VI logo sequence</div></div>
        <button id="vi-replay-intro" style="padding:7px 14px;border-radius:8px;border:1px solid rgba(240,74,152,0.55);background:rgba(240,74,152,0.22);color:#fff;font-size:11px;font-weight:800;letter-spacing:0.08em;cursor:pointer;">REPLAY INTRO</button>
      </div>
    `;

    const closeBtn = container.querySelector('#vi-close-mset');
    if (closeBtn) closeBtn.addEventListener('click', () => container.classList.remove('open'));
    const navModeBtn = container.querySelector('#vi-cycle-navmode');
    if (navModeBtn) {
      navModeBtn.addEventListener('click', () => {
        const order = ['on', 'dynamic', 'compass'];
        const cur = order.indexOf(cfg.navMode || 'on');
        cfg.navMode = order[(cur + 1) % order.length];
        navModeBtn.textContent = cfg.navMode;
        state.dynamicHudTimer = 6.0;
        playUiTone(540, 0.06, 0.05);
        saveCfg();
        updateHudVisibilitySettings();
      });
    }
    const mThemeBtn = container.querySelector('#vi-cycle-mtheme');
    if (mThemeBtn) {
      mThemeBtn.addEventListener('click', () => {
        const order = ['auto', 'light', 'dark'];
        const cur = order.indexOf(cfg.minimapTheme || 'auto');
        cfg.minimapTheme = order[(cur + 1) % order.length];
        mThemeBtn.textContent = cfg.minimapTheme;
        playUiTone(520, 0.06, 0.05);
        saveCfg();
        updateHudVisibilitySettings();
      });
    }
    const replayBtn = container.querySelector('#vi-replay-intro');
    if (replayBtn) {
      replayBtn.addEventListener('click', () => {
        playUiTone(560, 0.08, 0.06, 'triangle');
        const nextQs = new URLSearchParams(window.location.search);
        nextQs.delete('vbx_intro_done');
        nextQs.delete('vbx_skip_intro');
        window.location.href = '/gta6/boot?' + nextQs.toString();
      });
    }

    container.querySelectorAll('.vi-toggle[data-set]').forEach((btn) => {
      btn.addEventListener('click', () => {
        const k = btn.dataset.set;
        cfg[k] = !cfg[k];
        btn.classList.toggle('on', cfg[k]);
        playUiTone(cfg[k] ? 560 : 340, 0.06, 0.05);
        saveCfg();
        updateHudVisibilitySettings();
      });
    });

    container.querySelectorAll('input[data-rng]').forEach((inp) => {
      inp.addEventListener('input', () => {
        cfg[inp.dataset.rng] = parseInt(inp.value, 10);
        saveCfg();
      });
    });
  }

  function updateHudVisibilitySettings() {
    const fpsPill = document.getElementById('vi-fps-pill');
    const physRig = document.getElementById('vi-phys-rig');
    const shell = document.getElementById('vi-minimap-shell');
    const wrap = document.getElementById('vi-minimap-wrap');
    const compassWrap = document.getElementById('vi-compass-wrap');
    if (fpsPill) fpsPill.classList.toggle('visible', !!cfg.showFpsCounter);
    if (physRig) physRig.classList.toggle('visible', !!cfg.showCompanionRig && cfg.hairClothPhysics);
    const isDark = getActiveMapTheme() === 'dark';
    if (shell) {
      shell.classList.toggle('mode-3d', !!cfg.minimap3D);
      shell.classList.toggle('theme-dark', isDark);
    }
    const nm = cfg.navMode || 'on';
    if (wrap) {
      wrap.style.display = (nm === 'compass') ? 'none' : 'block';
      if (nm !== 'dynamic') wrap.classList.remove('hud-hidden');
    }
    if (compassWrap) {
      compassWrap.classList.toggle('visible', nm === 'compass');
    }
  }

  // ==================== PHASE 4: WEAPON WHEEL (8 RECTANGULAR CARDS) ====================
  function weaponSvg(icon) {
    const svgs = {
      pistol:  '<svg width="42" height="26" viewBox="0 0 48 30" fill="#DDE3EE"><path d="M8 7h28v7H22l-3 11h-7l2-11H8z"/></svg>',
      smg:     '<svg width="48" height="26" viewBox="0 0 54 30" fill="#DDE3EE"><path d="M6 10h34v6H29l-2 11h-6l1-11H15l-2 7H8l1-7H6z"/></svg>',
      shotgun: '<svg width="58" height="24" viewBox="0 0 64 26" fill="#DDE3EE"><path d="M4 11h50v4H28l-6 7h-8l4-7H4z"/></svg>',
      rifle:   '<svg width="60" height="26" viewBox="0 0 66 28" fill="#DDE3EE"><path d="M4 12h48v4H38l2 9h-6l-2-9H22l-4 7h-6l2-7H4z"/></svg>',
      fist:    '<svg width="32" height="28" viewBox="0 0 32 28" fill="#F2B9A8"><rect x="6" y="7" width="18" height="14" rx="4"/><rect x="20" y="10" width="7" height="8" rx="3"/></svg>',
      binoc:   '<svg width="30" height="24" viewBox="0 0 32 26" fill="#B6C0D2"><rect x="4" y="6" width="10" height="16" rx="3"/><rect x="18" y="6" width="10" height="16" rx="3"/><rect x="13" y="11" width="6" height="4"/></svg>',
      mask:    '<svg width="28" height="28" viewBox="0 0 28 28" fill="#DDE3EE"><ellipse cx="14" cy="14" rx="9" ry="11"/><circle cx="10" cy="12" r="2" fill="#111"/><circle cx="18" cy="12" r="2" fill="#111"/></svg>',
      cap:     '<svg width="34" height="24" viewBox="0 0 36 24" fill="#67E8D0"><path d="M6 15a10 10 0 0120 0h7v3H4v-3z"/></svg>',
      shades:  '<svg width="36" height="20" viewBox="0 0 38 20" fill="#FFD166"><rect x="3" y="6" width="13" height="9" rx="3"/><rect x="22" y="6" width="13" height="9" rx="3"/><rect x="16" y="8" width="6" height="2"/></svg>',
      armor:   '<svg width="28" height="28" viewBox="0 0 28 28" fill="#67E8D0"><path d="M7 4h14l3 7-3 13H7L4 11z"/></svg>',
      med:     '<svg width="26" height="26" viewBox="0 0 28 28" fill="#F4A5C4"><rect x="4" y="6" width="20" height="16" rx="4"/><path d="M12 10h4v8h-4zM10 12h8v4h-8z" fill="#161824"/></svg>',
      bolt:    '<svg width="24" height="26" viewBox="0 0 24 24" fill="#9C85FF"><path d="M13 2L3 14h7l-1 8 10-12h-7l1-8z"/></svg>'
    };
    return svgs[icon] || '<span style="font-size:18px;opacity:0.55;">+</span>';
  }

  function renderWeaponWheel() {
    const stage = document.getElementById('vi-wheel-stage');
    if (!stage) return;
    stage.querySelectorAll('.vi-wslot').forEach((n) => n.remove());
    const list = state.wheelTab === 'weapons' ? WEAPONS : ITEMS;
    const cx = 260, cy = 235, rx = 186, ry = 166;

    list.forEach((item, idx) => {
      const ang = -Math.PI / 2 + (idx * Math.PI * 2) / 8;
      const sx = cx + Math.cos(ang) * rx;
      const sy = cy + Math.sin(ang) * ry;
      const slot = document.createElement('div');
      const isEq = state.wheelTab === 'weapons' ? (idx === state.equippedWeapon) : !!item.equipped;
      slot.className = 'vi-wslot' + (isEq ? ' equipped' : '') + (idx === state.hoveredSlot ? ' selected' : '');
      slot.style.left = sx + 'px';
      slot.style.top = sy + 'px';

      if (item.empty) {
        slot.innerHTML = '<span style="font-size:18px;color:rgba(255,255,255,0.45);">+</span>';
      } else if (state.wheelTab === 'weapons') {
        slot.innerHTML = `
          <div style="margin-bottom:${item.mag ? '16px' : '0'};">${weaponSvg(item.icon)}</div>
          ${item.mag ? `<div class="vi-wslot-ammo"><span>${item.mag}</span><span style="color:#9AA3B5;">${item.res}</span></div>` : ''}
        `;
      } else {
        slot.innerHTML = `
          <div style="margin-bottom:14px;">${weaponSvg(item.icon)}</div>
          <div class="vi-wslot-ammo" style="font-size:10px;color:${item.equipped ? '#67E8D0' : '#B8C0D0'};">${item.equipped ? 'EQUIPPED' : item.name}</div>
        `;
      }

      slot.addEventListener('mouseenter', () => {
        state.hoveredSlot = idx;
        updateWheelCenter();
        stage.querySelectorAll('.vi-wslot').forEach((el, j) => el.classList.toggle('selected', j === idx));
        playUiTone(420 + idx * 24, 0.04, 0.03);
      });
      slot.addEventListener('click', () => selectWheelSlot(idx));
      stage.appendChild(slot);
    });
    updateWheelCenter();
  }

  function updateWheelCenter() {
    const list = state.wheelTab === 'weapons' ? WEAPONS : ITEMS;
    const item = list[state.hoveredSlot] || list[0];
    document.getElementById('vi-wheel-title').textContent = item.name;
    document.getElementById('vi-wheel-cat').textContent = item.cat;
  }

  function selectWheelSlot(idx) {
    const list = state.wheelTab === 'weapons' ? WEAPONS : ITEMS;
    const item = list[idx];
    if (!item || item.empty) return;
    playUiTone(620, 0.08, 0.06, 'triangle');
    if (state.wheelTab === 'weapons') {
      state.equippedWeapon = idx;
      updateAmmoHud();
      if (item.slotKey) {
        try {
          window.dispatchEvent(new KeyboardEvent('keydown', { key: item.slotKey, code: 'Digit' + item.slotKey, bubbles: true }));
          setTimeout(() => window.dispatchEvent(new KeyboardEvent('keyup', { key: item.slotKey, code: 'Digit' + item.slotKey, bubbles: true })), 60);
        } catch (e) {}
      }
      setWheelOpen(false);
    } else {
      if (item.id === 'medkit') { useMedkit(); return; }
      if (item.id === 'booster') { useFocusShot(); return; }
      item.equipped = !item.equipped;
      pushToast('GEAR UPDATED', `${item.name} ${item.equipped ? 'equipped' : 'removed'}.`);
      renderWeaponWheel();
    }
  }

  function useMedkit() {
    if (state.medkits <= 0) return;
    state.medkits--;
    state.health = 100;
    document.getElementById('vi-med-cnt').textContent = state.medkits + ' ♥';
    playUiTone(680, 0.12, 0.07);
    pushToast('HEALTH RESTORED', 'Trauma kit applied.');
  }

  function useFocusShot() {
    if (state.focusShots <= 0) return;
    state.focusShots--;
    state.focus = 100;
    document.getElementById('vi-foc-cnt').textContent = state.focusShots + ' ✦';
    playUiTone(740, 0.12, 0.07);
    pushToast('FOCUS RESTORED', 'Focus meter at 100%.');
  }

  function setWheelOpen(open) {
    state.wheelOpen = open;
    const el = document.getElementById('vi-wheel');
    el.classList.toggle('open', open);
    if (open) {
      if (document.pointerLockElement) { try { document.exitPointerLock(); } catch (e) {} }
      renderWeaponWheel();
      playUiTone(380, 0.06, 0.04);
    }
  }

  function initWeaponWheel() {
    document.querySelectorAll('.vi-wtab').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.wheelTab = btn.dataset.wtab;
        document.querySelectorAll('.vi-wtab').forEach((b) => b.classList.toggle('active', b === btn));
        playUiTone(520, 0.05, 0.04);
        renderWeaponWheel();
      });
    });
    document.getElementById('vi-use-med').addEventListener('click', useMedkit);
    document.getElementById('vi-use-focus').addEventListener('click', useFocusShot);
  }

  function updateAmmoHud() {
    const w = WEAPONS[state.equippedWeapon] || WEAPONS[0];
    const box = document.getElementById('vi-ammo-box');
    if (!box) return;
    if (!w.mag) { box.style.opacity = '0.35'; document.getElementById('vi-ammo-mag').textContent = w.name; document.getElementById('vi-ammo-res').textContent = ''; }
    else { box.style.opacity = '1'; document.getElementById('vi-ammo-mag').textContent = w.mag; document.getElementById('vi-ammo-res').textContent = '/ ' + w.res; }
  }

  // ==================== PHASE 4: PAUSE MENU (2026 LEONIDA) ====================
  function setPauseOpen(open) {
    state.pauseOpen = open;
    const el = document.getElementById('vi-pause');
    el.classList.toggle('open', open);
    if (open) {
      setWheelOpen(false);
      setPhoneOpen(false);
      if (document.pointerLockElement) { try { document.exitPointerLock(); } catch (e) {} }
      playUiTone(460, 0.08, 0.05);
      renderPauseTab();
    }
  }

  function formatGameClock() {
    const h24 = Math.floor(state.gameMinutes / 60) % 24;
    const m = Math.floor(state.gameMinutes % 60);
    const ampm = h24 >= 12 ? 'pm' : 'am';
    const h12 = (h24 % 12) || 12;
    return `${h12}:${String(m).padStart(2, '0')} ${ampm}`;
  }

  function renderPauseTab() {
    const body = document.getElementById('vi-pause-body');
    if (!body) return;
    document.getElementById('vi-pause-clock').textContent = formatGameClock();
    document.getElementById('vi-pause-cash').textContent = '$' + (state.bank + state.cash).toLocaleString();
    document.querySelectorAll('.vi-ptab').forEach((b) => b.classList.toggle('active', b.dataset.ptab === state.pauseTab));

    if (state.pauseTab === 'map') {
      body.innerHTML = `
        <div class="vi-map-rail">
          <button class="vi-rail-btn" data-flt="player" title="Recenter on Player">▲</button>
          <button class="vi-rail-btn active" data-flt="layers" title="Map Layers">🗺</button>
          <button class="vi-rail-btn" data-flt="jobs" title="Jobs & Cash">$</button>
          <button class="vi-rail-btn" data-flt="gym" title="Gym">🏋</button>
          <button class="vi-rail-btn" data-flt="garage" title="Vehicles">🚗</button>
          <button class="vi-rail-btn" data-flt="gun" title="Weapons">🔫</button>
          <button class="vi-rail-btn" data-flt="food" title="Dining">🍴</button>
        </div>
        <canvas id="vi-pause-map-cv" style="width:100%;height:100%;cursor:crosshair;"></canvas>
        <div class="vi-pause-legend">
          <button class="vi-pill" id="vi-pmap-recenter" style="width:170px;">RECENTER [R]</button>
          <button class="vi-pill" id="vi-pmap-3d" style="width:170px;">RADAR: ${cfg.minimap3D ? '3D VIEW' : '2D VIEW'}</button>
          <button class="vi-pill" id="vi-pmap-menu" style="width:170px;border-color:#FF9E6D;color:#FFD5BF;">MAIN MENU</button>
          <button class="vi-pill active" id="vi-pmap-resume" style="width:170px;">RESUME [P]</button>
        </div>
      `;
      const mcv = document.getElementById('vi-pause-map-cv');
      drawPauseMapCanvas(mcv);

      mcv.addEventListener('click', (e) => {
        const r = mcv.getBoundingClientRect();
        const wx = ((e.clientX - r.left) / r.width) * MAP_SIZE;
        const wy = ((e.clientY - r.top) / r.height) * MAP_SIZE;
        state.waypoint = { x: Math.max(40, Math.min(MAP_SIZE - 40, wx)), y: Math.max(40, Math.min(MAP_SIZE - 40, wy)), name: 'CUSTOM GPS WAYPOINT' };
        playUiTone(620, 0.08, 0.06);
        drawPauseMapCanvas(mcv);
        pushToast('GPS DESTINATION SET', 'Pink route updated on minimap.');
      });
      document.getElementById('vi-pmap-recenter').addEventListener('click', () => { state.mapPanX = 0; state.mapPanY = 0; drawPauseMapCanvas(mcv); });
      document.getElementById('vi-pmap-3d').addEventListener('click', (e) => {
        cfg.minimap3D = !cfg.minimap3D;
        saveCfg();
        updateHudVisibilitySettings();
        e.target.textContent = 'RADAR: ' + (cfg.minimap3D ? '3D VIEW' : '2D VIEW');
      });
      document.getElementById('vi-pmap-menu').addEventListener('click', () => { setPauseOpen(false); showMainMenu(); });
      document.getElementById('vi-pmap-resume').addEventListener('click', () => setPauseOpen(false));
    } else if (state.pauseTab === 'character') {
      const ch = CHARACTERS[cfg.character];
      body.innerHTML = `
        <div class="vi-panel-wrap">
          <div class="vi-card" style="flex:1.1;display:flex;flex-direction:column;gap:14px;">
            <div style="font-size:12px;letter-spacing:0.16em;color:#F04A98;font-weight:800;">PROTAGONIST SELECTOR · LEONIDA</div>
            <div style="display:flex;gap:14px;">
              <button class="vi-menu-btn ${cfg.character === 'lucia' ? 'primary' : ''}" id="vi-pick-lucia" style="flex:1;height:52px;">LUCIA CAMINOS</button>
              <button class="vi-menu-btn ${cfg.character === 'jason' ? 'primary' : ''}" id="vi-pick-jason" style="flex:1;height:52px;">JASON DUVAL</button>
            </div>
            <div style="display:flex;gap:18px;align-items:center;margin-top:6px;">
              <img src="/vbx/img/gta6_duo.jpg" style="width:170px;height:170px;object-fit:cover;object-position:${cfg.character === 'lucia' ? '25% 28%' : '72% 20%'};border-radius:14px;border:2px solid ${ch.accent};">
              <div>
                <div style="font-size:24px;font-weight:900;">${ch.name}</div>
                <div style="font-size:13px;color:#67E8D0;margin-top:2px;">${ch.role}</div>
                <div style="margin-top:12px;font-size:12px;color:#C8CDD6;">ACTIVE OUTFIT</div>
                <div style="display:flex;flex-direction:column;gap:6px;margin-top:6px;">
                  ${ch.outfits.map((o, i) => `<button class="vi-pill ${cfg.outfitIdx === i ? 'active' : ''}" data-outfit="${i}" style="text-align:left;padding:7px 12px;">${o}</button>`).join('')}
                </div>
              </div>
            </div>
          </div>
          <div class="vi-card" style="width:320px;display:flex;flex-direction:column;align-items:center;gap:12px;">
            <div style="font-size:12px;letter-spacing:0.14em;color:#67E8D0;font-weight:800;">LIVE HAIR &amp; CLOTH SPRING PHYSICS</div>
            <canvas id="vi-pause-phys-cv" width="240" height="220" style="border-radius:12px;border:1px solid rgba(255,255,255,0.14);"></canvas>
            <div style="font-size:11px;color:#9BA6BE;text-align:center;">Low-bone Verlet spring solver (&lt;0.05 ms/frame): reacts dynamically to player movement, yaw turning &amp; Vice Beach breeze.</div>
            <button class="vi-pill active" id="vi-pause-back-play" style="width:100%;padding:10px;">RESUME SANDBOX</button>
          </div>
        </div>
      `;
      document.getElementById('vi-pick-lucia').addEventListener('click', () => { switchCharacter('lucia'); renderPauseTab(); });
      document.getElementById('vi-pick-jason').addEventListener('click', () => { switchCharacter('jason'); renderPauseTab(); });
      body.querySelectorAll('[data-outfit]').forEach((b) => b.addEventListener('click', () => {
        cfg.outfitIdx = parseInt(b.dataset.outfit, 10);
        saveCfg();
        renderPauseTab();
      }));
      document.getElementById('vi-pause-back-play').addEventListener('click', () => setPauseOpen(false));
    } else if (state.pauseTab === 'settings') {
      body.innerHTML = `<div class="vi-panel-wrap"><div class="vi-card" id="vi-pause-set-card" style="max-width:640px;width:100%;margin:0 auto;"></div></div>`;
      renderSettingsPanel(document.getElementById('vi-pause-set-card'), true);
    } else if (state.pauseTab === 'brief') {
      body.innerHTML = `
        <div class="vi-panel-wrap">
          <div class="vi-card" style="max-width:720px;width:100%;margin:0 auto;display:flex;flex-direction:column;gap:12px;">
            <div style="font-size:14px;letter-spacing:0.14em;color:#F04A98;font-weight:800;">RECENT LEONIDA BRIEFING</div>
            ${state.briefLog.map((b) => `
              <div style="padding:12px 14px;border-radius:10px;background:rgba(255,255,255,0.05);border-left:3px solid #F04A98;">
                <div style="display:flex;justify-content:space-between;font-size:12px;font-weight:800;color:#FF8CC6;"><span>${b.title}</span><span style="color:#9BA6BE;">${b.time}</span></div>
                <div style="font-size:13px;color:#E2E6F0;margin-top:4px;">${b.body}</div>
              </div>
            `).join('')}
          </div>
        </div>`;
    } else {
      body.innerHTML = `
        <div class="vi-panel-wrap">
          <div class="vi-card" style="max-width:680px;width:100%;margin:0 auto;">
            <div style="font-size:14px;letter-spacing:0.14em;color:#67E8D0;font-weight:800;margin-bottom:14px;">CRIMINAL PROFILE &amp; ENGINE TELEMETRY</div>
            <div class="vi-row"><span>Active Mode</span><span style="color:#F04A98;">SANDBOX (STORY: TO BE CONTINUED)</span></div>
            <div class="vi-row"><span>Protagonist</span><span>${CHARACTERS[cfg.character].name}</span></div>
            <div class="vi-row"><span>Live WebGPU Frame Rate</span><span style="color:#67E8D0;">${state.fps.toFixed(1)} FPS (${state.frameMs.toFixed(2)} ms)</span></div>
            <div class="vi-row"><span>Active Resolution</span><span>${state.resW} × ${state.resH}</span></div>
            <div class="vi-row"><span>Performance: Auto</span><span>${cfg.perfAuto ? 'ON (Tier ' + state.perfTier + ')' : 'OFF'}</span></div>
            <div class="vi-row"><span>Bank + Cash</span><span style="color:#4ADE80;">$${(state.bank + state.cash).toLocaleString()}</span></div>
          </div>
        </div>`;
    }
  }

  function drawPauseMapCanvas(cv) {
    if (!cv) return;
    const rect = cv.getBoundingClientRect();
    cv.width = Math.max(640, rect.width | 0);
    cv.height = Math.max(360, rect.height | 0);
    const ctx = cv.getContext('2d');
    const baked = ensureBakedMap();

    ctx.fillStyle = '#141933';
    ctx.fillRect(0, 0, cv.width, cv.height);
    ctx.save();
    ctx.globalAlpha = 0.88;
    ctx.drawImage(baked, 0, 0, cv.width, cv.height);
    ctx.restore();

    const sx = cv.width / MAP_SIZE, sy = cv.height / MAP_SIZE;

    // County names matching ref_05_pause_menu_map.jpg
    ctx.fillStyle = 'rgba(255,255,255,0.42)';
    ctx.font = '800 26px Bahnschrift, Segoe UI, sans-serif';
    ctx.fillText('VICE-DALE COUNTY', cv.width * 0.62, cv.height * 0.24);
    ctx.fillText('MARIANA COUNTY', cv.width * 0.22, cv.height * 0.78);

    // Smooth curved pink GPS route from player to waypoint
    if (state.waypoint) {
      const pts = buildGpsRoutePoints(state.posX, state.posY, state.waypoint.x, state.waypoint.y);
      ctx.save();
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.strokeStyle = 'rgba(255, 74, 164, 0.35)';
      ctx.lineWidth = 9;
      ctx.beginPath();
      pts.forEach(([px, py], i) => { if (i === 0) ctx.moveTo(px * sx, py * sy); else ctx.lineTo(px * sx, py * sy); });
      ctx.stroke();

      ctx.strokeStyle = '#FF4EA6';
      ctx.lineWidth = 4;
      ctx.beginPath();
      pts.forEach(([px, py], i) => { if (i === 0) ctx.moveTo(px * sx, py * sy); else ctx.lineTo(px * sx, py * sy); });
      ctx.stroke();
      ctx.restore();

      ctx.fillStyle = '#FF4EA6';
      ctx.beginPath();
      ctx.arc(state.waypoint.x * sx, state.waypoint.y * sy, 8, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#fff';
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    // Blips
    for (const b of BLIPS) {
      ctx.fillStyle = '#14171F';
      ctx.beginPath(); ctx.arc(b.x * sx, b.y * sy, 9, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = b.color;
      ctx.beginPath(); ctx.arc(b.x * sx, b.y * sy, 5.5, 0, Math.PI * 2); ctx.fill();
    }

    // Player chevron
    ctx.save();
    ctx.translate(state.posX * sx, state.posY * sy);
    ctx.rotate(state.smoothHeading);
    ctx.fillStyle = '#14171F';
    ctx.beginPath(); ctx.arc(0, 0, 11, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#FFFFFF';
    ctx.beginPath(); ctx.moveTo(0, -8); ctx.lineTo(6, 6); ctx.lineTo(0, 3); ctx.lineTo(-6, 6); ctx.closePath(); ctx.fill();
    ctx.restore();
  }

  // ==================== PHASE 4: LEONIDA SMARTPHONE (Exact ref_06) ====================
  const PHONE_APPS = [
    { id: 'whatup',   name: 'WhatUp',    bg: '#3B9AC7', ico: '💬' },
    { id: 'phone',    name: 'Contacts',  bg: '#38B86A', ico: '📞' },
    { id: 'camera',   name: 'Camera',    bg: '#1D202A', ico: '📷' },
    { id: 'radio',    name: 'Vice Radio',bg: '#5B4CE6', ico: '🎵' },
    { id: 'gallery',  name: 'Gallery',   bg: '#E86A50', ico: '🖼' },
    { id: 'waink',    name: 'WAiNK',     bg: '#F2B84B', ico: '❤' },
    { id: 'news',     name: 'Vice News', bg: '#D93B4B', ico: '📰' },
    { id: 'weather',  name: 'Weather',   bg: '#4FA8E8', ico: '⛅' },
    { id: 'cheats',   name: 'Leonida+',  bg: '#E0489A', ico: '✦' },
    { id: 'settings', name: 'Settings',  bg: '#5D6578', ico: '⚙' }
  ];

  function initPhone() {
    const grid = document.getElementById('vi-phone-grid');
    PHONE_APPS.forEach((app, idx) => {
      const b = document.createElement('button');
      b.className = 'vi-app-btn' + (idx === 0 ? ' sel' : '');
      b.style.background = app.bg;
      b.textContent = app.ico;
      b.title = app.name;
      b.addEventListener('mouseenter', () => {
        state.phoneSelectedIdx = idx;
        document.getElementById('vi-phone-pill').textContent = app.name;
        grid.querySelectorAll('.vi-app-btn').forEach((el, j) => el.classList.toggle('sel', j === idx));
      });
      b.addEventListener('click', () => openPhoneApp(app));
      grid.appendChild(b);
    });
  }

  function openPhoneApp(app) {
    playUiTone(580, 0.06, 0.05);
    const view = document.getElementById('vi-phone-appview');
    let html = `<div style="display:flex;justify-content:space-between;align-items:center;border-bottom:1px solid rgba(255,255,255,0.12);padding-bottom:6px;">
      <span style="font-weight:800;font-size:13px;color:#FF8CC6;">${app.name}</span>
      <button id="vi-ph-back" style="background:none;border:none;color:#fff;cursor:pointer;font-weight:800;">←</button>
    </div>`;

    if (app.id === 'whatup') {
      html += `
        <div style="font-size:11px;padding:8px;border-radius:8px;background:rgba(255,255,255,0.08);"><b>Jason Duval:</b> Meet me on Ocean Beach Strip — watch for VCPD!</div>
        <div style="font-size:11px;padding:8px;border-radius:8px;background:rgba(240,74,152,0.22);"><b>Lucia Caminos:</b> Already rolling. Setting pink GPS now.</div>
        <div style="font-size:11px;padding:8px;border-radius:8px;background:rgba(255,255,255,0.08);"><b>Raul Bautista:</b> Keep heat low until we hit the vault.</div>`;
    } else if (app.id === 'weather') {
      html += `<div style="font-size:11px;color:#C8CDD6;">Tap to shift Leonida WebGPU lighting &amp; sun shafts live:</div>` +
        ['sunset', 'noon', 'night', 'storm'].map((w) =>
          `<button class="vi-pill ${cfg.weather === w ? 'active' : ''}" data-wx="${w}" style="padding:8px;">${w.toUpperCase()}</button>`
        ).join('');
    } else if (app.id === 'radio') {
      html += ['VICE CITY FM', 'EMOTION 98.3', 'LEONIDA WAVE', 'RADIO OFF'].map((r) =>
        `<button class="vi-pill ${cfg.radioStation === r ? 'active' : ''}" data-rad="${r}" style="padding:8px;">${r}</button>`
      ).join('');
    } else if (app.id === 'cheats') {
      html += `
        <button class="vi-pill" id="vi-ph-heal" style="padding:8px;">Restore Health &amp; Focus</button>
        <button class="vi-pill" id="vi-ph-stars" style="padding:8px;">Cycle Wanted Level (${state.wantedStars}★)</button>
        <button class="vi-pill" id="vi-ph-swap" style="padding:8px;">Switch Lucia / Jason</button>
        <button class="vi-pill" id="vi-ph-veh" style="padding:8px;">Scan Nearby Vehicle</button>`;
    } else if (app.id === 'camera') {
      pushToast('PHOTO STUDIO', 'Leonida snapshot saved to session gallery.');
      html += `<div style="font-size:12px;color:#67E8D0;padding:12px;text-align:center;">📷 Snapshot captured!<br><img src="/vbx/img/gta6_keyart_wide.webp" style="width:100%;border-radius:8px;margin-top:8px;"></div>`;
    } else if (app.id === 'settings') {
      setPhoneOpen(false);
      state.pauseTab = 'settings';
      setPauseOpen(true);
      return;
    } else {
      html += `<div style="font-size:11px;color:#C8CDD6;line-height:1.45;">Leonida Network connected. Vice-Dale County telemetry active (${state.fps.toFixed(0)} FPS).</div>`;
    }

    view.innerHTML = html;
    view.classList.add('open');
    view.querySelector('#vi-ph-back').addEventListener('click', () => view.classList.remove('open'));
    view.querySelectorAll('[data-wx]').forEach((b) => b.addEventListener('click', () => {
      cfg.weather = b.dataset.wx;
      saveCfg();
      pushToast('VICE LIGHTING', 'Atmosphere shifted to ' + cfg.weather.toUpperCase());
      openPhoneApp(app);
    }));
    view.querySelectorAll('[data-rad]').forEach((b) => b.addEventListener('click', () => {
      cfg.radioStation = b.dataset.rad;
      saveCfg();
      pushToast('RADIO TUNED', cfg.radioStation);
      openPhoneApp(app);
    }));
    const heal = view.querySelector('#vi-ph-heal');
    if (heal) heal.addEventListener('click', () => { state.health = 100; state.stamina = 100; state.focus = 100; pushToast('VITALS MAXED', 'Health, Stamina & Focus restored.'); });
    const stars = view.querySelector('#vi-ph-stars');
    if (stars) stars.addEventListener('click', () => { setWanted((state.wantedStars + 1) % 7); openPhoneApp(app); });
    const swap = view.querySelector('#vi-ph-swap');
    if (swap) swap.addEventListener('click', () => switchCharacter(cfg.character === 'lucia' ? 'jason' : 'lucia'));
    const veh = view.querySelector('#vi-ph-veh');
    if (veh) veh.addEventListener('click', () => pushToast('SHITZU SQUALO · SCAN', 'ACCESS: LOCKED  |  SECURITY: ALARMED  |  TRACKER: NONE'));
  }

  function setPhoneOpen(open) {
    state.phoneOpen = open;
    const el = document.getElementById('vi-phone');
    el.classList.toggle('open', open);
    if (!open) document.getElementById('vi-phone-appview').classList.remove('open');
    else {
      if (document.pointerLockElement) { try { document.exitPointerLock(); } catch (e) {} }
      playUiTone(620, 0.06, 0.05);
    }
  }

  // ==================== CHARACTER SWITCH + WANTED + TOASTS ====================
  function switchCharacter(target) {
    cfg.character = target;
    saveCfg();
    const ch = CHARACTERS[target];
    const fl = document.getElementById('vi-switch-flash');
    fl.textContent = ch.name;
    fl.classList.add('show');
    playUiTone(330, 0.14, 0.08, 'sawtooth');
    setTimeout(() => playUiTone(520, 0.18, 0.07, 'triangle'), 110);
    setTimeout(() => fl.classList.remove('show'), 460);
    const lbl = document.getElementById('vi-phys-lbl');
    if (lbl) lbl.textContent = ch.short + ' · SPRING';
    pushToast('PROTAGONIST SWITCH', `Now controlling ${ch.name} (${ch.role}).`);
  }

  function setWanted(n) {
    state.wantedStars = Math.max(0, Math.min(6, n));
    state.wantedClues.face = n >= 1;
    state.wantedClues.weapon = n >= 2;
    state.wantedClues.vehicle = n >= 3;
    state.wantedClues.cctv = n >= 4;
    state.wantedClues.couple = n >= 5;
    renderWantedHud();
    document.getElementById('vi-minimap-shell').classList.toggle('wanted', state.wantedStars > 0);
    if (state.wantedStars > 0) {
      pushToast(`WANTED · ${state.wantedStars} STAR${state.wantedStars > 1 ? 'S' : ''}`, 'VCPD manhunt active — police blips hidden on radar; use Focus [C] to spot units.');
    }
  }

  function renderWantedHud() {
    const sw = document.getElementById('vi-wanted-stars');
    const cl = document.getElementById('vi-clues');
    if (!sw || !cl) return;
    sw.innerHTML = state.wantedStars > 0
      ? Array.from({ length: 6 }, (_, i) => `<span class="vi-star ${i < state.wantedStars ? 'on' : ''}">★</span>`).join('')
      : '';
    const activeClues = Object.entries(state.wantedClues).filter(([, v]) => v).map(([k]) => k.toUpperCase());
    cl.innerHTML = state.wantedStars > 0 ? activeClues.map((c) => `<span class="vi-clue">${c}</span>`).join('') : '';
  }

  function pushToast(title, body) {
    state.briefLog.unshift({ time: formatGameClock(), title, body });
    if (state.briefLog.length > 20) state.briefLog.pop();
    const stack = document.getElementById('vi-toast-stack');
    if (!stack) return;
    const t = document.createElement('div');
    t.className = 'vi-toast';
    t.innerHTML = `<div class="vi-toast-hdr">${title}</div><div class="vi-toast-body">${body}</div>`;
    stack.appendChild(t);
    setTimeout(() => { t.style.opacity = '0'; t.style.transition = 'opacity 0.3s'; setTimeout(() => t.remove(), 320); }, 4200);
  }

  // ==================== AUTHENTIC 2026 GTA VI 3D PERSPECTIVE MINIMAP & COMPASS RENDERER ====================
  // Helper: clamp a unit direction (dx, dy) cleanly onto the outer perimeter of the rounded rectangle!
  function clampToRoundedEdge(sw, sh, dx, dy, inset) {
    const hw = sw * 0.5 - inset;
    const hh = sh * 0.5 - inset;
    const ax = Math.max(0.0001, Math.abs(dx));
    const ay = Math.max(0.0001, Math.abs(dy));
    const t = Math.min(hw / ax, hh / ay);
    let ex = dx * t;
    let ey = dy * t;
    const r = 15;
    const cx = hw - r, cy = hh - r;
    if (Math.abs(ex) > cx && Math.abs(ey) > cy) {
      const sx = Math.sign(ex), sy = Math.sign(ey);
      const vx = Math.abs(ex) - cx, vy = Math.abs(ey) - cy;
      const vl = Math.hypot(vx, vy) || 1;
      ex = sx * (cx + (vx / vl) * r);
      ey = sy * (cy + (vy / vl) * r);
    }
    return [sw * 0.5 + ex, sh * 0.5 + ey];
  }

  function drawCompass() {
    const cv = document.getElementById('vi-compass-canvas');
    if (!cv) return;
    const ctx = cv.getContext('2d');
    const w = cv.width, h = cv.height;
    ctx.clearRect(0, 0, w, h);

    // Heading in degrees [0..360) where 0 = North, 90 = East, 180 = South, 270 = West
    let deg = ((state.smoothHeading * 180 / Math.PI) % 360 + 360) % 360;
    const pxPerDeg = w / 150; // 150 deg field of view across compass bar
    const dirs = [
      [0, 'N'], [45, 'NE'], [90, 'E'], [135, 'SE'],
      [180, 'S'], [225, 'SW'], [270, 'W'], [315, 'NW']
    ];

    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    for (let a = 0; a < 360; a += 15) {
      let diff = ((a - deg + 540) % 360) - 180;
      if (Math.abs(diff) > 82) continue;
      const x = w * 0.5 + diff * pxPerDeg;
      const alpha = Math.max(0, 1 - Math.abs(diff) / 80);
      const card = dirs.find((d) => d[0] === a);
      if (card) {
        ctx.fillStyle = card[1] === 'N' ? `rgba(255,90,174,${alpha})` : `rgba(255,255,255,${alpha * 0.94})`;
        ctx.font = card[1].length === 1 ? '900 22px Bahnschrift, Segoe UI, sans-serif' : '700 17px Bahnschrift, Segoe UI, sans-serif';
        ctx.fillText(card[1], x, h * 0.54);
      } else {
        ctx.strokeStyle = `rgba(255,255,255,${alpha * 0.36})`;
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.moveTo(x, h * 0.34);
        ctx.lineTo(x, h * 0.66);
        ctx.stroke();
      }
    }

    // Glowing Hot-Pink Waypoint Chevron on Compass Bar
    if (state.waypoint) {
      const wx = state.waypoint.x - state.posX;
      const wy = state.waypoint.y - state.posY;
      const wpDeg = ((Math.atan2(wx, -wy) * 180 / Math.PI) % 360 + 360) % 360;
      let diff = ((wpDeg - deg + 540) % 360) - 180;
      const clamped = Math.max(-72, Math.min(72, diff));
      const x = w * 0.5 + clamped * pxPerDeg;
      ctx.fillStyle = '#FF4EA8';
      ctx.shadowColor = '#FF4EA8';
      ctx.shadowBlur = 10;
      ctx.beginPath();
      ctx.arc(x, h * 0.5, 8, 0, Math.PI * 2);
      ctx.fill();
      ctx.shadowBlur = 0;
    }

    // Center white notch
    ctx.fillStyle = '#FFFFFF';
    ctx.beginPath();
    ctx.moveTo(w * 0.5, 4);
    ctx.lineTo(w * 0.5 - 6, 13);
    ctx.lineTo(w * 0.5 + 6, 13);
    ctx.closePath();
    ctx.fill();
  }

  function drawMinimap(timeSec) {
    const nm = cfg.navMode || 'on';
    if (nm === 'compass') {
      drawCompass();
      return;
    }

    const cv = document.getElementById('vi-minimap-canvas');
    const shell = document.getElementById('vi-minimap-shell');
    const wrap = document.getElementById('vi-minimap-wrap');
    if (!cv || !shell) return;

    // Dynamic HUD auto-fade when idle on foot
    if (nm === 'dynamic' && wrap) {
      wrap.classList.toggle('hud-hidden', state.dynamicHudTimer <= 0 && state.wantedStars === 0 && state.speed < 0.08);
    }

    const ctx = cv.getContext('2d');
    const W = cv.width, H = cv.height; // 536 x 316 (2x Retina)
    const theme = getActiveMapTheme();
    const isDark = theme === 'dark';

    shell.classList.toggle('mode-3d', !!cfg.minimap3D);
    shell.classList.toggle('theme-dark', isDark);

    // Dynamic speed-responsive driving zoom (pulls smoothly back at high speed, just like real PS5 GTA VI!)
    const targetZoom = state.minimapExpanded ? 0.72 : (1.0 - state.speed * 0.24);
    state.smoothZoom += (targetZoom - state.smoothZoom) * 0.10;
    const route = getCachedStreetRoute();

    if (!cfg.minimap3D) {
      // ===== 2D CLASSIC TOP-DOWN RADAR (exact same road graph & buildings!) =====
      const baked = ensureBakedMap(theme);
      ctx.clearRect(0, 0, W, H);
      ctx.fillStyle = isDark ? '#101A2B' : '#4B7D92';
      ctx.fillRect(0, 0, W, H);

      ctx.save();
      ctx.translate(W * 0.5, H * 0.55);
      ctx.rotate(-state.smoothHeading);
      ctx.scale(state.smoothZoom * 1.15, state.smoothZoom * 1.15);
      ctx.translate(-state.posX, -state.posY);

      ctx.drawImage(baked, 0, 0);

      if (route && route.pts.length > 1) {
        ctx.save();
        ctx.lineCap = 'round'; ctx.lineJoin = 'round';
        ctx.strokeStyle = 'rgba(255, 68, 164, 0.38)';
        ctx.lineWidth = 14;
        ctx.beginPath();
        route.pts.forEach(([px, py], i) => { if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py); });
        ctx.stroke();

        ctx.strokeStyle = '#FF4AA4';
        ctx.lineWidth = 6.5;
        ctx.beginPath();
        route.pts.forEach(([px, py], i) => { if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py); });
        ctx.stroke();

        ctx.strokeStyle = 'rgba(255, 210, 236, 0.75)';
        ctx.lineWidth = 2;
        ctx.beginPath();
        route.pts.forEach(([px, py], i) => { if (i === 0) ctx.moveTo(px, py); else ctx.lineTo(px, py); });
        ctx.stroke();
        ctx.restore();
      }

      for (const b of BLIPS) {
        ctx.fillStyle = '#0D1017';
        ctx.beginPath(); ctx.arc(b.x, b.y, 7.5, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = b.color;
        ctx.beginPath(); ctx.arc(b.x, b.y, 4.4, 0, Math.PI * 2); ctx.fill();
      }
      ctx.restore();
    } else {
      // ===== TRUE 3D PERSPECTIVE PS5 GTA VI MINIMAP (ZERO CSS WARP, ZERO SKY GAP, REAL BUILDING OCCLUSION!) =====
      const pal = isDark ? {
        land: '#202838', water: '#122036', waterDeep: '#0D1729', sand: '#2E3646',
        park: '#1B302C', sidewalk: '#2D3749', roadEdge: '#47536A', roadFill: '#354054',
        hwyFill: '#404D66', divider: '#263042', shadow: 'rgba(4,7,14,0.46)',
        hvacTop: '#363F52', hvacSide: '#212735'
      } : {
        land: '#7F868C', water: '#588EA1', waterDeep: '#47798C', sand: '#D3C9B4',
        park: '#67896C', sidewalk: '#959BA1', roadEdge: '#666D73', roadFill: '#ADB1B5',
        hwyFill: '#B8BCBF', divider: '#7E858C', shadow: 'rgba(24,28,34,0.28)',
        hvacTop: '#A4A3A0', hvacSide: '#6F6E6C'
      };

      // 3D Camera parameters tuned so ground fills 100% edge-to-edge (ZERO horizon sky strip!)
      // and player (0, 0, 0) projects cleanly onto screen (W*0.5, H*0.76)!
      const heading = state.smoothHeading;
      const fx = Math.sin(heading), fy = -Math.cos(heading); // Forward unit vector in world
      const rx = Math.cos(heading), ry =  Math.sin(heading); // Right unit vector in world
      const px0 = state.posX, py0 = state.posY;

      const invZ = 1 / Math.max(0.62, state.smoothZoom);
      const camBack   = 132 * invZ;
      const camHeight = 208 * invZ;
      const pitch = 0.82; // ~47 deg downward pitch — reveals 5-8 rich city blocks edge-to-edge (exact PS5 GTA VI le-3.png!)
      const cosP = Math.cos(pitch), sinP = Math.sin(pitch);
      const focal = 408;
      const cx0 = W * 0.5;
      const cy0 = H * 0.46;

      // Project world point (wx, wy, wz) -> [sx, sy, cz] (returns null if behind near plane)
      const proj = (wx, wy, wz) => {
        const dx = wx - px0, dy = wy - py0;
        const lx = dx * rx + dy * ry;
        const ly = dx * fx + dy * fy;
        const vy = ly + camBack;
        const vz = wz - camHeight;
        const cz = vy * cosP - vz * sinP;
        if (cz < 24) return null;
        const cy = vy * sinP + vz * cosP;
        return [cx0 + (lx / cz) * focal, cy0 - (cy / cz) * focal, cz];
      };

      // Helper: project & fill a ground-plane rectangle (x0..x1, y0..y1) cleanly subdivided to avoid near-plane clip
      const fillGroundRect = (x0, y0, x1, y1, color, zElev) => {
        const z = zElev || 0;
        const p0 = proj(x0, y0, z), p1 = proj(x1, y0, z), p2 = proj(x1, y1, z), p3 = proj(x0, y1, z);
        if (!p0 || !p1 || !p2 || !p3) return;
        ctx.fillStyle = color;
        ctx.beginPath();
        ctx.moveTo(p0[0], p0[1]);
        ctx.lineTo(p1[0], p1[1]);
        ctx.lineTo(p2[0], p2[1]);
        ctx.lineTo(p3[0], p3[1]);
        ctx.closePath();
        ctx.fill();
      };

      // 1. Base Ground Plane (100% edge-to-edge fill, zero sky band!)
      ctx.fillStyle = pal.land;
      ctx.fillRect(0, 0, W, H);

      // Clip view cull radius in world units
      const cullR = 620 * invZ;

      // 2. Biscayne Bay Waterway + Ocean Beach Sand + Atlantic Ocean (tiled in 140px strips so near-plane clipping never drops polygons!)
      const tileStartY = Math.max(0, Math.floor((py0 - cullR) / 140) * 140);
      const tileEndY   = Math.min(MAP_SIZE, Math.ceil((py0 + cullR) / 140) * 140);
      for (let ty = tileStartY; ty < tileEndY; ty += 140) {
        const ty2 = ty + 142;
        if (Math.abs(860 - px0) < cullR + 140) {
          fillGroundRect(BAY_X0, ty, BAY_X1, ty2, pal.water, -0.5);
        }
        if (px0 + cullR > OCEAN_SAND_X - 40) {
          fillGroundRect(OCEAN_SAND_X, ty, OCEAN_WATER_X, ty2, pal.sand, -0.2);
          fillGroundRect(OCEAN_WATER_X, ty, OCEAN_WATER_X + 180, ty2, pal.water, -0.5);
          fillGroundRect(OCEAN_WATER_X + 180, ty, MAP_SIZE + 260, ty2, pal.waterDeep, -0.5);
        }
      }
      // Starfish Island landmass sitting cleanly inside Biscayne Bay
      if (Math.hypot(860 - px0, 700 - py0) < cullR + 150) {
        fillGroundRect(796, 588, 924, 812, pal.land, 0);
      }

      // 3. Green Parks + Tropical Palm Canopy Groves inside blocks
      const treeCol = isDark ? '#142622' : '#4E7253';
      for (let i = 0; i < MAP_PARKS.length; i++) {
        const pk = MAP_PARKS[i];
        if (Math.abs(pk.x + pk.w * 0.5 - px0) > cullR + 120 || Math.abs(pk.y + pk.h * 0.5 - py0) > cullR + 120) continue;
        fillGroundRect(pk.x, pk.y, pk.x + pk.w, pk.y + pk.h, pal.park, 0.1);
        // Organic 3D Florida palm canopy clusters inside park
        for (let tx = pk.x + 24; tx < pk.x + pk.w - 18; tx += 36) {
          for (let ty = pk.y + 24; ty < pk.y + pk.h - 18; ty += 36) {
            const jx = Math.sin(tx * 0.37 + ty * 0.19) * 9;
            const jy = Math.cos(tx * 0.23 + ty * 0.41) * 9;
            const tp = proj(tx + jx, ty + jy, 3.5);
            if (!tp) continue;
            const tr = Math.max(3, ((9 + (tx % 5)) / tp[2]) * focal);
            ctx.fillStyle = treeCol;
            ctx.beginPath(); ctx.arc(tp[0], tp[1], tr, 0, Math.PI * 2); ctx.fill();
          }
        }
      }

      // 4. Connected 3D Perspective Streets — Layered Pass-by-Pass (Shadows -> Sidewalks -> Curbs -> Asphalt -> Dividers)
      // Guarantees 100% seamless Apple Maps / GTA VI 4-way intersections with ZERO crossing curb seams!
      const drawRoadQuad = (x1, y1, x2, y2, halfW, color, zElev) => {
        const dx = x2 - x1, dy = y2 - y1;
        const len = Math.hypot(dx, dy) || 1;
        const nx = (-dy / len) * halfW, ny = (dx / len) * halfW;
        const steps = Math.max(1, Math.ceil(len / 90));
        ctx.fillStyle = color;
        for (let s = 0; s < steps; s++) {
          const t0 = s / steps, t1 = (s + 1) / steps;
          const ax = x1 + dx * t0, ay = y1 + dy * t0;
          const bx = x1 + dx * t1, by = y1 + dy * t1;
          const p0 = proj(ax + nx, ay + ny, zElev);
          const p1 = proj(ax - nx, ay - ny, zElev);
          const p2 = proj(bx - nx, by - ny, zElev);
          const p3 = proj(bx + nx, by + ny, zElev);
          if (!p0 || !p1 || !p2 || !p3) continue;
          ctx.beginPath();
          ctx.moveTo(p0[0], p0[1]); ctx.lineTo(p1[0], p1[1]);
          ctx.lineTo(p2[0], p2[1]); ctx.lineTo(p3[0], p3[1]);
          ctx.closePath();
          ctx.fill();
        }
      };

      const visRoads = [];
      for (let i = 0; i < ROAD_SEGMENTS.length; i++) {
        const s = ROAD_SEGMENTS[i];
        const mx = (s.x1 + s.x2) * 0.5, my = (s.y1 + s.y2) * 0.5;
        if (Math.abs(mx - px0) > cullR + 180 || Math.abs(my - py0) > cullR + 180) continue;
        visRoads.push(s);
      }

      // Pass 4a: Causeway water shadows & sidewalk borders
      for (let i = 0; i < visRoads.length; i++) {
        const s = visRoads[i], hw = s.w * 0.5, rz = s.isBridge ? 2.2 : 0.2;
        if (s.isBridge) drawRoadQuad(s.x1 + 6, s.y1 + 7, s.x2 + 6, s.y2 + 7, hw + 5, pal.shadow, 0);
        drawRoadQuad(s.x1, s.y1, s.x2, s.y2, hw + 5.5, pal.sidewalk, rz);
      }
      // Pass 4b: Crisp curb edge outlines
      for (let i = 0; i < visRoads.length; i++) {
        const s = visRoads[i], hw = s.w * 0.5, rz = s.isBridge ? 2.25 : 0.25;
        drawRoadQuad(s.x1, s.y1, s.x2, s.y2, hw + 1.4, pal.roadEdge, rz);
      }
      // Pass 4c: Seamless asphalt road decks + seamless intersection pads
      for (let i = 0; i < visRoads.length; i++) {
        const s = visRoads[i], hw = s.w * 0.5, rz = s.isBridge ? 2.3 : 0.3;
        drawRoadQuad(s.x1, s.y1, s.x2, s.y2, hw, s.isHwy ? pal.hwyFill : pal.roadFill, rz);
      }
      for (let i = 0; i < ROAD_NODES.length; i++) {
        const n = ROAD_NODES[i];
        if (Math.abs(n.x - px0) > cullR + 40 || Math.abs(n.y - py0) > cullR + 40) continue;
        const isHwyNode = (n.x === 320 || n.x === 680 || n.x === 1040 || BAY_BRIDGES.includes(n.y));
        const hw = isHwyNode ? 17.5 : 12.5;
        fillGroundRect(n.x - hw, n.y - hw, n.x + hw, n.y + hw, isHwyNode ? pal.hwyFill : pal.roadFill, 0.35);
      }
      // Pass 4d: Subtle boulevard center dividers (inset away from intersections!)
      for (let i = 0; i < visRoads.length; i++) {
        const s = visRoads[i];
        if (!s.isHwy) continue;
        const dx = s.x2 - s.x1, dy = s.y2 - s.y1, len = Math.hypot(dx, dy) || 1;
        if (len < 50) continue;
        const t = 22 / len;
        drawRoadQuad(s.x1 + dx * t, s.y1 + dy * t, s.x2 - dx * t, s.y2 - dy * t, 1.3, pal.divider, s.isBridge ? 2.35 : 0.4);
      }

      // 5. LUMINOUS HOT-PINK A* STREET-FOLLOWING GPS ROUTE (drawn BEFORE 3D buildings so foreground buildings NATURALLY OCCLUDE IT — exact PS5 GTA VI le-3.png!)
      if (route && route.pts.length > 1) {
        const projected = [];
        for (let i = 0; i < route.pts.length; i++) {
          const p = proj(route.pts[i][0], route.pts[i][1], 1.1);
          if (p) projected.push(p);
        }
        if (projected.length > 1) {
          ctx.save();
          ctx.lineCap = 'round';
          ctx.lineJoin = 'round';

          // Soft neon pink outer halo
          ctx.strokeStyle = 'rgba(255, 62, 158, 0.34)';
          ctx.lineWidth = 13.5;
          ctx.beginPath();
          projected.forEach((p, i) => { if (i === 0) ctx.moveTo(p[0], p[1]); else ctx.lineTo(p[0], p[1]); });
          ctx.stroke();

          // Signature vibrant GTA VI hot-pink road ribbon (#FF4AA4)
          ctx.strokeStyle = '#FF4AA4';
          ctx.lineWidth = 6.8;
          ctx.beginPath();
          projected.forEach((p, i) => { if (i === 0) ctx.moveTo(p[0], p[1]); else ctx.lineTo(p[0], p[1]); });
          ctx.stroke();

          // Crisp luminous inner pink core
          ctx.strokeStyle = 'rgba(255, 214, 238, 0.78)';
          ctx.lineWidth = 2.0;
          ctx.beginPath();
          projected.forEach((p, i) => { if (i === 0) ctx.moveTo(p[0], p[1]); else ctx.lineTo(p[0], p[1]); });
          ctx.stroke();
          ctx.restore();
        }
      }

      // 6. Collect visible 3D buildings, compute camera depth & sort BACK-TO-FRONT (Painter's Algorithm!)
      const visibleBldgs = [];
      // Camera position in world space (needed for exact backface culling of vertical walls!)
      const camWX = px0 - fx * camBack;
      const camWY = py0 - fy * camBack;

      for (let i = 0; i < MAP_BUILDINGS.length; i++) {
        const b = MAP_BUILDINGS[i];
        const dx = b.cx - px0, dy = b.cy - py0;
        const lx = dx * rx + dy * ry;
        const ly = dx * fx + dy * fy;
        if (ly < -camBack + 18 || ly > cullR + 60 || Math.abs(lx) > cullR + 90) continue;
        const vy = ly + camBack;
        const cz = vy * cosP + camHeight * sinP;
        if (cz < 32) continue;
        visibleBldgs.push({ b, cz });
      }
      visibleBldgs.sort((a, b) => b.cz - a.cz); // farthest first -> nearest last!

      // Draw soft directional ground drop shadows under all visible buildings first
      ctx.fillStyle = pal.shadow;
      for (let i = 0; i < visibleBldgs.length; i++) {
        const b = visibleBldgs[i].b;
        const sxOff = b.elev * 0.24, syOff = b.elev * 0.20;
        const p0 = proj(b.x + sxOff, b.y + syOff, 0.4);
        const p1 = proj(b.x + b.w + sxOff, b.y + syOff, 0.4);
        const p2 = proj(b.x + b.w + sxOff, b.y + b.h + syOff, 0.4);
        const p3 = proj(b.x + sxOff, b.y + b.h + syOff, 0.4);
        if (!p0 || !p1 || !p2 || !p3) continue;
        ctx.beginPath();
        ctx.moveTo(p0[0], p0[1]); ctx.lineTo(p1[0], p1[1]);
        ctx.lineTo(p2[0], p2[1]); ctx.lineTo(p3[0], p3[1]);
        ctx.closePath();
        ctx.fill();
      }

      // Helper: draw one visible shaded vertical building wall + crisp perspective window bands!
      const drawWallFace = (b0, b1, t1, t0, wallCol, winCol, floors) => {
        ctx.fillStyle = wallCol;
        ctx.beginPath();
        ctx.moveTo(b0[0], b0[1]); ctx.lineTo(b1[0], b1[1]);
        ctx.lineTo(t1[0], t1[1]); ctx.lineTo(t0[0], t0[1]);
        ctx.closePath();
        ctx.fill();

        // Crisp subtle vertical corner outline
        ctx.strokeStyle = isDark ? 'rgba(10,14,24,0.45)' : 'rgba(65,58,52,0.28)';
        ctx.lineWidth = 1;
        ctx.stroke();

        // Architectural horizontal louver / window strips (exact PS5 GTA VI le-3.png facade detail!)
        if (floors >= 2) {
          ctx.fillStyle = winCol;
          for (let f = 0; f < floors; f++) {
            const vA = (f + 0.24) / (floors + 0.15);
            const vB = (f + 0.56) / (floors + 0.15);
            // Inset 6% horizontally from facade edges for architectural pilasters
            const u0 = 0.06, u1 = 0.94;
            const lerp2 = (pA, pB, t) => [pA[0] + (pB[0] - pA[0]) * t, pA[1] + (pB[1] - pA[1]) * t];
            const lb0 = lerp2(b0, t0, vA), lb1 = lerp2(b1, t1, vA);
            const lt0 = lerp2(b0, t0, vB), lt1 = lerp2(b1, t1, vB);
            const q0 = lerp2(lb0, lb1, u0), q1 = lerp2(lb0, lb1, u1);
            const q2 = lerp2(lt0, lt1, u1), q3 = lerp2(lt0, lt1, u0);
            ctx.beginPath();
            ctx.moveTo(q0[0], q0[1]); ctx.lineTo(q1[0], q1[1]);
            ctx.lineTo(q2[0], q2[1]); ctx.lineTo(q3[0], q3[1]);
            ctx.closePath();
            ctx.fill();
          }
        }
      };

      // 7. Render every 3D Building Back-to-Front (walls -> parapet rooftop -> 3D HVAC rooftop boxes!)
      for (let i = 0; i < visibleBldgs.length; i++) {
        const b = visibleBldgs[i].b;
        const bp = isDark ? b.nightPal : b.dayPal;
        const x0 = b.x, y0 = b.y, x1 = b.x + b.w, y1 = b.y + b.h, h = b.elev;

        const B0 = proj(x0, y0, 0), B1 = proj(x1, y0, 0), B2 = proj(x1, y1, 0), B3 = proj(x0, y1, 0);
        const T0 = proj(x0, y0, h), T1 = proj(x1, y0, h), T2 = proj(x1, y1, h), T3 = proj(x0, y1, h);
        if (!B0 || !B1 || !B2 || !B3 || !T0 || !T1 || !T2 || !T3) continue;

        // Backface-cull vertical faces against camera world coordinate (only draw faces facing the camera!)
        if (camWY < y0) drawWallFace(B0, B1, T1, T0, bp.wallF, bp.win, b.floors); // North wall (-Y)
        if (camWY > y1) drawWallFace(B3, B2, T2, T3, bp.wallL, bp.win, b.floors); // South wall (+Y, sunlit)
        if (camWX < x0) drawWallFace(B0, B3, T3, T0, bp.wallL, bp.win, b.floors); // West wall  (-X, sunlit)
        if (camWX > x1) drawWallFace(B1, B2, T2, T1, bp.wallR, bp.win, b.floors); // East wall  (+X, shaded)

        // Rooftop slab + crisp bright parapet border rim
        ctx.fillStyle = bp.roof;
        ctx.beginPath();
        ctx.moveTo(T0[0], T0[1]); ctx.lineTo(T1[0], T1[1]);
        ctx.lineTo(T2[0], T2[1]); ctx.lineTo(T3[0], T3[1]);
        ctx.closePath();
        ctx.fill();

        ctx.strokeStyle = bp.parapet;
        ctx.lineWidth = 2.1;
        ctx.stroke();

        // Rooftop 3D HVAC / mechanical penthouse units (makes rooftops feel truly architectural like le-3.png!)
        if (b.w > 26 && b.h > 26) {
          const ux = x0 + b.w * 0.24, uy = y0 + b.h * 0.24;
          const uw = Math.min(20, b.w * 0.26), uh = Math.min(18, b.h * 0.26), uz = h + 5.5;
          const HB0 = proj(ux, uy, h), HB1 = proj(ux + uw, uy, h), HB2 = proj(ux + uw, uy + uh, h), HB3 = proj(ux, uy + uh, h);
          const HT0 = proj(ux, uy, uz), HT1 = proj(ux + uw, uy, uz), HT2 = proj(ux + uw, uy + uh, uz), HT3 = proj(ux, uy + uh, uz);
          if (HB0 && HB1 && HB2 && HB3 && HT0 && HT1 && HT2 && HT3) {
            ctx.fillStyle = pal.hvacSide;
            if (camWY > uy + uh) { ctx.beginPath(); ctx.moveTo(HB3[0], HB3[1]); ctx.lineTo(HB2[0], HB2[1]); ctx.lineTo(HT2[0], HT2[1]); ctx.lineTo(HT3[0], HT3[1]); ctx.closePath(); ctx.fill(); }
            if (camWX > ux + uw) { ctx.beginPath(); ctx.moveTo(HB1[0], HB1[1]); ctx.lineTo(HB2[0], HB2[1]); ctx.lineTo(HT2[0], HT2[1]); ctx.lineTo(HT1[0], HT1[1]); ctx.closePath(); ctx.fill(); }
            ctx.fillStyle = pal.hvacTop;
            ctx.beginPath(); ctx.moveTo(HT0[0], HT0[1]); ctx.lineTo(HT1[0], HT1[1]); ctx.lineTo(HT2[0], HT2[1]); ctx.lineTo(HT3[0], HT3[1]); ctx.closePath(); ctx.fill();
          }
        }
      }

      // 8. Floating World POI Blips & Destination Marker in true 3D perspective
      for (let i = 0; i < BLIPS.length; i++) {
        const b = BLIPS[i];
        const p = proj(b.x, b.y, 12);
        if (!p || p[0] < -20 || p[0] > W + 20 || p[1] < -20 || p[1] > H + 20) continue;
        ctx.fillStyle = '#0B0E15';
        ctx.beginPath(); ctx.arc(p[0], p[1], 8.5, 0, Math.PI * 2); ctx.fill();
        ctx.fillStyle = b.color;
        ctx.beginPath(); ctx.arc(p[0], p[1], 5.0, 0, Math.PI * 2); ctx.fill();
      }

      if (state.waypoint) {
        const wp = proj(state.waypoint.x, state.waypoint.y, 8);
        if (wp && wp[0] >= -15 && wp[0] <= W + 15 && wp[1] >= -15 && wp[1] <= H + 15) {
          ctx.fillStyle = '#FF4EA8';
          ctx.beginPath(); ctx.arc(wp[0], wp[1], 8.5, 0, Math.PI * 2); ctx.fill();
          ctx.strokeStyle = '#FFFFFF';
          ctx.lineWidth = 2.2;
          ctx.stroke();
        }
      }
    }

    // 9. Authentic GTA VI Wanted Search Zone Wash (red-pink alert + flashing red/blue edge — NO cop dots!)
    const washEl = document.getElementById('vi-minimap-wanted-wash');
    if (washEl) {
      if (state.wantedStars > 0) {
        const s = Math.sin(timeSec * 5.6);
        const colA = s >= 0 ? 'rgba(255, 42, 92, 0.36)' : 'rgba(42, 130, 255, 0.34)';
        const colB = s >= 0 ? 'rgba(255, 42, 92, 0.14)' : 'rgba(42, 130, 255, 0.14)';
        washEl.style.opacity = '1';
        washEl.style.background = `radial-gradient(ellipse at 50% 50%, ${colB} 22%, ${colA} 100%)`;
      } else {
        washEl.style.opacity = '0';
      }
    }

    // 10. Orbiting Black Circular 'N' Badge riding cleanly along outer rounded-rectangle border
    const sw = shell.clientWidth || 268;
    const sh = shell.clientHeight || 158;
    const northEl = document.getElementById('vi-minimap-north');
    if (northEl) {
      const na = -state.smoothHeading - Math.PI / 2;
      const [nx, ny] = clampToRoundedEdge(sw, sh, Math.cos(na), Math.sin(na), 1);
      northEl.style.left = nx + 'px';
      northEl.style.top  = ny + 'px';
    }

    // 11. Live Street-Route Distance Readout (`1.86 mi`) + Orbiting Glowing Hot-Pink Waypoint Dot!
    const wpPin = document.getElementById('vi-minimap-wp-pin');
    const gpsEl = document.getElementById('vi-minimap-gps');
    if (state.waypoint) {
      const wx = state.waypoint.x - state.posX;
      const wy = state.waypoint.y - state.posY;
      const directDist = Math.hypot(wx, wy);
      const routeDist = route ? route.dist : directDist;
      if (gpsEl) {
        gpsEl.style.display = 'block';
        gpsEl.textContent = (routeDist / 260).toFixed(2) + ' mi';
      }
      if (wpPin) {
        if (directDist > 125) {
          const ch = Math.cos(-state.smoothHeading), shh = Math.sin(-state.smoothHeading);
          const ox = wx * ch - wy * shh;
          const oy = wx * shh + wy * ch;
          const [px, py] = clampToRoundedEdge(sw, sh, ox, oy, 1);
          wpPin.style.display = 'block';
          wpPin.style.left = px + 'px';
          wpPin.style.top  = py + 'px';
        } else {
          wpPin.style.display = 'none';
        }
      }
    } else {
      if (gpsEl) gpsEl.style.display = 'none';
      if (wpPin) wpPin.style.display = 'none';
    }
  }

  // ==================== INPUT HOOKS & 60 FPS MASTER LOOP ====================
  function initControlsAndLoop() {
    document.querySelectorAll('.vi-ptab').forEach((btn) => {
      btn.addEventListener('click', () => {
        state.pauseTab = btn.dataset.ptab;
        playUiTone(480, 0.05, 0.04);
        renderPauseTab();
      });
    });

    document.addEventListener('pointerlockchange', updatePointerLockHint);

    // Real mouse motion feeds both minimap heading & WebGPU camera motion blur velocity!
    window.addEventListener('mousemove', (e) => {
      if (state.phase !== 'playing' || state.pauseOpen || state.wheelOpen) return;
      const sens = (cfg.lookSensitivity || 100) / 100;
      const mx = e.movementX || 0;
      const my = e.movementY || 0;
      if (document.pointerLockElement) {
        state.heading += mx * 0.0032 * sens;
        state.camVelX = Math.max(-22, Math.min(22, state.camVelX * 0.45 + mx * 0.55 * sens));
        state.camVelY = Math.max(-18, Math.min(18, state.camVelY * 0.45 + my * 0.45 * sens));
      }
    }, true);

    // Clean, non-destructive key bindings (NEVER hijack GTA V core controls like Q=Cover, C=Look Behind, K=Aircraft Pitch!)
    window.addEventListener('keydown', (e) => {
      state.keys[e.code] = true;
      // While on our GTA VI Main Menu, stop Enter/Space/5/6/Backspace from accidentally flipping PlayGTA5's hidden #modes bar to Story Mode!
      if (state.phase === 'menu' && (e.code === 'Enter' || e.code === 'NumpadEnter' || e.code === 'Space' || e.code === 'Digit5' || e.code === 'Digit6' || e.code === 'Backspace')) {
        e.stopImmediatePropagation();
        return;
      }
      if (state.phase !== 'playing') return;

      // Ignore hotkeys while typing inside Cheat Menu input box
      if (document.activeElement && (document.activeElement.tagName === 'INPUT' || document.activeElement.tagName === 'TEXTAREA')) return;

      if (e.code === 'Tab') {
        if (!state.pauseOpen) {
          e.preventDefault();
          if (!state.wheelOpen) setWheelOpen(true);
        }
      } else if (e.code === 'KeyE' && state.wheelOpen) {
        e.preventDefault();
        state.wheelTab = state.wheelTab === 'weapons' ? 'items' : 'weapons';
        document.querySelectorAll('.vi-wtab').forEach((b) => b.classList.toggle('active', b.dataset.wtab === state.wheelTab));
        renderWeaponWheel();
      } else if (e.code === 'KeyP') {
        e.preventDefault();
        setPauseOpen(!state.pauseOpen);
        updatePointerLockHint();
      } else if (e.code === 'ArrowUp') {
        if (!state.pauseOpen && !state.wheelOpen) {
          e.preventDefault();
          setPhoneOpen(!state.phoneOpen);
          updatePointerLockHint();
        }
      } else if (e.code === 'CapsLock' && !state.pauseOpen && !state.wheelOpen) {
        state.focusActive = !state.focusActive;
        playUiTone(state.focusActive ? 260 : 420, 0.12, 0.06, 'sine');
      } else if (e.code === 'KeyM' && !state.pauseOpen && !state.wheelOpen) {
        cfg.minimap3D = !cfg.minimap3D;
        saveCfg();
        updateHudVisibilitySettings();
        pushToast('RADAR VIEW', cfg.minimap3D ? '3D Satellite Perspective Minimap' : '2D Classic Top-Down Minimap');
      } else if (e.code === 'ArrowDown' && !state.pauseOpen && !state.wheelOpen) {
        // Authentic PS5 GTA VI D-Pad Down: Summons Dynamic Minimap OR expands radar!
        state.dynamicHudTimer = 7.0;
        const wrap = document.getElementById('vi-minimap-wrap');
        if (wrap) wrap.classList.remove('hud-hidden');
        if ((cfg.navMode || 'on') !== 'dynamic') {
          state.minimapExpanded = !state.minimapExpanded;
          document.getElementById('vi-minimap-shell').classList.toggle('expanded', state.minimapExpanded);
        }
      } else if (e.code === 'KeyZ' && !state.pauseOpen) {
        state.dynamicHudTimer = 7.0;
        state.minimapExpanded = !state.minimapExpanded;
        document.getElementById('vi-minimap-shell').classList.toggle('expanded', state.minimapExpanded);
      } else if (e.code === 'F4') {
        e.preventDefault();
        switchCharacter(cfg.character === 'lucia' ? 'jason' : 'lucia');
      } else if (e.code === 'Equal') {
        cfg.showFpsCounter = !cfg.showFpsCounter;
        saveCfg();
        updateHudVisibilitySettings();
      } else if (e.code === 'Escape') {
        if (state.pauseOpen) { e.preventDefault(); setPauseOpen(false); updatePointerLockHint(); }
        else if (state.phoneOpen) { e.preventDefault(); setPhoneOpen(false); updatePointerLockHint(); }
        else if (state.wheelOpen) { e.preventDefault(); setWheelOpen(false); updatePointerLockHint(); }
      }
    }, true);

    window.addEventListener('keyup', (e) => {
      state.keys[e.code] = false;
      if (state.phase === 'playing' && e.code === 'Tab' && state.wheelOpen) {
        selectWheelSlot(state.hoveredSlot);
        setWheelOpen(false);
        updatePointerLockHint();
      }
    }, true);

    // Master 60 FPS lightweight RAF loop
    let prevT = performance.now();
    let fxSendAcc = 0;

    function tick(now) {
      const dt = Math.min(0.05, Math.max(0.001, (now - prevT) / 1000));
      prevT = now;
      const timeSec = now * 0.001;

      // Decay camera velocity smoothly for authentic motion blur settle
      state.camVelX *= Math.pow(0.0015, dt);
      state.camVelY *= Math.pow(0.0015, dt);

      if (state.phase === 'playing') {
        state.gameMinutes += dt * 0.4;

        // Read BOTH keyboard AND PS5 DualSense / Xbox controller sticks + triggers for live minimap & motion blur!
        let padFwd = 0, padTurn = 0, padSprint = false;
        try {
          const pads = navigator.getGamepads ? navigator.getGamepads() : [];
          for (let i = 0; i < pads.length; i++) {
            const gp = pads[i];
            if (!gp || !gp.connected) continue;
            const lx = gp.axes[0] || 0;
            const ly = gp.axes[1] || 0;
            const rx = gp.axes[2] || 0;
            const r2 = gp.buttons[7] ? gp.buttons[7].value : 0;
            const l2 = gp.buttons[6] ? gp.buttons[6].value : 0;
            if (Math.abs(lx) > 0.2) padTurn = lx;
            if (ly < -0.2 || r2 > 0.15) padFwd = Math.max(-ly, r2);
            else if (ly > 0.2 || l2 > 0.15) padFwd = -Math.max(ly, l2);
            if (gp.buttons[0] && gp.buttons[0].pressed) padSprint = true;
            if (Math.abs(rx) > 0.18) {
              state.heading += rx * dt * 2.1 * ((cfg.lookSensitivity || 100) / 100);
              state.camVelX = Math.max(-22, Math.min(22, state.camVelX + rx * 2.8));
            }
            break;
          }
        } catch (e) {}

        const kbFwd = (state.keys['KeyW'] ? 1 : 0) - (state.keys['KeyS'] ? 1 : 0);
        const kbTurn = (state.keys['KeyD'] ? 1 : 0) - (state.keys['KeyA'] ? 1 : 0);
        const fwd = Math.abs(padFwd) > 0.15 ? padFwd : kbFwd;
        const turn = Math.abs(padTurn) > 0.15 ? padTurn : kbTurn;
        const sprint = !!state.keys['ShiftLeft'] || !!state.keys['ShiftRight'] || padSprint;

        const targetSpeed = fwd > 0.1 ? (sprint ? 1.0 : Math.min(0.85, 0.45 + fwd * 0.4)) : (fwd < -0.1 ? 0.28 : 0);
        state.speed += (targetSpeed - state.speed) * Math.min(1, dt * 4.5);
        if (Math.abs(turn) > 0.1 && state.speed > 0.12) {
          state.heading += turn * dt * 1.45;
          state.camVelX = Math.max(-18, Math.min(18, state.camVelX + turn * 2.2));
        }
        state.smoothHeading += (state.heading - state.smoothHeading) * Math.min(1, dt * 10);

        // Advance minimap position cleanly within Vice-Dale County bounds
        const movePx = state.speed * dt * 52 * (fwd < -0.1 ? -0.5 : 1);
        state.posX = Math.max(80, Math.min(MAP_SIZE - 80, state.posX + Math.sin(state.smoothHeading) * movePx));
        state.posY = Math.max(80, Math.min(MAP_SIZE - 80, state.posY - Math.cos(state.smoothHeading) * movePx));
        if (state.speed > 0.12) state.dynamicHudTimer = 6.0;
        else if (state.dynamicHudTimer > 0) state.dynamicHudTimer = Math.max(0, state.dynamicHudTimer - dt);

        // Vitals simulation (Stamina sprint drain + Focus Eagle Eye drain)
        if (sprint && fwd > 0.1) state.stamina = Math.max(0, state.stamina - dt * 14);
        else state.stamina = Math.min(100, state.stamina + dt * 10);

        if (state.focusActive && state.focus > 0) {
          state.focus = Math.max(0, state.focus - dt * 16);
          if (state.focus <= 0) state.focusActive = false;
        } else {
          state.focus = Math.min(100, state.focus + dt * 6);
        }
        state.focusMix += ((state.focusActive ? 1 : 0) - state.focusMix) * Math.min(1, dt * 8);

        document.getElementById('vi-bar-hp').style.width = state.health.toFixed(1) + '%';
        document.getElementById('vi-bar-stam').style.width = state.stamina.toFixed(1) + '%';
        document.getElementById('vi-bar-focus').style.width = state.focus.toFixed(1) + '%';

        // Update live FPS/Frame-Time verification pill
        if (cfg.showFpsCounter) {
          const fp = document.getElementById('vi-fps-pill');
          if (fp) {
            const tierTag = cfg.perfAuto ? ` · AUTO T${state.perfTier}` : '';
            const fpsDisp = state.fps > 0 ? state.fps.toFixed(1) : '--';
            const msDisp  = state.frameMs > 0 ? state.frameMs.toFixed(2) : '--';
            fp.textContent = `${fpsDisp} FPS · ${msDisp} ms · ${state.resW}×${state.resH}${tierTag}`;
          }
        }

        // Update Hair & Cloth spring physics + draw authentic 2026 iFruit minimap
        updateHairClothPhysics(dt, timeSec);
        drawMinimap(timeSec);

        if (cfg.showCompanionRig && cfg.hairClothPhysics) {
          const pcv = document.getElementById('vi-phys-canvas');
          if (pcv) drawCharacterPhysicsCanvas(pcv.getContext('2d'), pcv.width, pcv.height, timeSec);
        }
        if (state.pauseOpen && state.pauseTab === 'character') {
          const ppcv = document.getElementById('vi-pause-phys-cv');
          if (ppcv) drawCharacterPhysicsCanvas(ppcv.getContext('2d'), ppcv.width, ppcv.height, timeSec);
        }

        // Stream live uniforms to WebGPU wgpu_worker.js at ~30 Hz (zero message overhead!)
        fxSendAcc += dt;
        if (fxSendAcc >= 0.033) {
          fxSendAcc = 0;
          syncFxToWgpu();
        }
      }
      requestAnimationFrame(tick);
    }

    updateAmmoHud();
    renderWantedHud();
    updateHudVisibilitySettings();
    requestAnimationFrame(tick);

    // If reloaded just to swap sandbox map, skip intro directly into Sandbox loading!
    if (qs.get('vbx_skip_intro') === '1') {
      const intro = document.getElementById('vi-intro');
      if (intro) intro.style.display = 'none';
      startSandboxLaunch();
    }
  }

  attachDom();
})();
