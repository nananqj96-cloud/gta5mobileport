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
  const STORE_KEY = 'vbx_gta6_exp_v26';
  const defaultSettings = {
    perfAuto: true,            // Default ON — quiet GTX 1050 60 FPS @ 1080p optimizer
    viceLighting: 92,          // 0..100
    motionBlur: 85,            // 0..100
    bloom: 72,                 // 0..100
    sunShafts: 45,             // 0..100
    hairClothPhysics: true,    // Lucia ponytail + Jason jacket spring physics
    minimap3D: true,           // 3D perspective tilt vs 2D flat radar
    showCompanionRig: false,   // Optional live corner hair/cloth physics mini-monitor
    showFpsCounter: false,     // Dev FPS & frame-time ms pill
    character: 'lucia',        // 'lucia' | 'jason'
    outfitIdx: 0,
    sandboxMap: qs.get('map') === 'env_test' ? 'env_test' : 'main',
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
    loadPct: 0,
    loadLabel: 'Initializing Leonida Sandbox Engine...',
    // Player simulated spatial & kinesthetic state (driven by real WASD/mouse/controller inputs)
    posX: 512,
    posY: 560,
    heading: -0.45,       // radians (0 = North)
    smoothHeading: -0.45,
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
    // Minimap & Waypoint
    minimapExpanded: false,
    waypoint: { x: 642, y: 318, name: 'OCEAN BEACH · VICE STRIP' },
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
      { time: '1:34 pm', title: 'LEONIDA SANDBOX', body: 'Welcome to Vice-Dale County. Press TAB for Loadout, P for Pause/Map, UP for Phone, C for Focus, N for 2D/3D Radar.' },
      { time: '1:35 pm', title: 'JASON DUVAL · WhatUp', body: 'Car is gassed up down on Ocean Beach. Meet me by the pink waypoint whenever you are ready.' }
    ],
    // Telemetry from wgpu_worker.js (GTX 1050 live verification)
    fps: 60.0,
    frameMs: 14.2,
    perfTier: 0,
    resW: 1920,
    resH: 1080,
    draws: 0,
    // Input keys
    keys: Object.create(null),
    hudPulseT: 8.0,
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
    { id: 'home',   x: 472, y: 492, type: 'home',   color: '#F04A98', label: 'SAFEHOUSE · MOTEL' },
    { id: 'gun',    x: 398, y: 615, type: 'gun',    color: '#FFFFFF', label: 'PAWN & AMMO' },
    { id: 'garage', x: 560, y: 642, type: 'garage', color: '#67E8D0', label: 'VICE CUSTOMS' },
    { id: 'beach',  x: 642, y: 318, type: 'star',   color: '#F04A98', label: 'OCEAN BEACH STRIP' },
    { id: 'gym',    x: 610, y: 455, type: 'gym',    color: '#FFD166', label: 'VICE MUSCLE GYM' },
    { id: 'diner',  x: 430, y: 395, type: 'food',   color: '#FF9E6D', label: 'RUSTY ANCHOR BAR' }
  ];

  // ==================== WEBGPU FX & TELEMETRY CHANNELS ====================
  let fxChannel = null;
  let perfChannel = null;
  try { fxChannel = new BroadcastChannel('vbx-gta6-fx'); } catch (e) {}
  try {
    perfChannel = new BroadcastChannel('vbx-gta6-perf');
    perfChannel.onmessage = (ev) => {
      const d = ev.data;
      if (!d) return;
      if (d.fps > 0) state.fps = d.fps;
      if (d.frameMs > 0) state.frameMs = d.frameMs;
      if (d.perfTier !== undefined) state.perfTier = d.perfTier;
      if (d.w > 0) { state.resW = d.w; state.resH = d.h; }
      if (d.draws !== undefined) state.draws = d.draws;
    };
  } catch (e) {}

  try {
    const progBc = new BroadcastChannel('game-progress');
    progBc.onmessage = (ev) => {
      const m = ev.data;
      if (!m) return;
      if (typeof m.pct === 'number') state.loadPct = Math.max(state.loadPct, m.pct);
      if (m.label) state.loadLabel = m.label;
      if (m.world) {
        state.worldReady = true;
        state.loadPct = 100;
        if (state.phase === 'loading') enterPlayingPhase();
      }
    };
  } catch (e) {}

  function getWeatherSun() {
    if (cfg.weather === 'noon')  return { u: 0.52, v: 0.08, light: 0.78, bloom: 0.55, shaft: 0.32 };
    if (cfg.weather === 'night') return { u: 0.80, v: 0.14, light: 0.65, bloom: 1.15, shaft: 0.14 };
    if (cfg.weather === 'storm') return { u: 0.35, v: 0.12, light: 0.52, bloom: 0.65, shaft: 0.18 };
    return { u: 0.74, v: 0.16, light: 1.0, bloom: 0.85, shaft: 0.55 }; // sunset
  }

  function syncFxToWgpu() {
    if (!fxChannel) return;
    const ws = getWeatherSun();
    try {
      fxChannel.postMessage({
        enabled: true,
        perfAuto: !!cfg.perfAuto,
        velX: state.camVelX,
        velY: state.camVelY,
        speed: state.speed,
        blurStrength: (cfg.motionBlur / 100) * 1.15,
        lightStrength: (cfg.viceLighting / 100) * ws.light,
        bloomStrength: (cfg.bloom / 100) * ws.bloom,
        shaftStrength: (cfg.sunShafts / 100) * ws.shaft,
        sunU: ws.u,
        sunV: ws.v,
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

  // ==================== PHASE 4: PRE-BAKED ULTRA-CHEAP VICE CITY / LEONIDA MINIMAP ====================
  const MAP_SIZE = 1024;
  let bakedMapCanvas = null;

  function ensureBakedMap() {
    if (bakedMapCanvas) return bakedMapCanvas;
    bakedMapCanvas = document.createElement('canvas');
    bakedMapCanvas.width = MAP_SIZE;
    bakedMapCanvas.height = MAP_SIZE;
    const c = bakedMapCanvas.getContext('2d');

    // Deep coastal ocean (#3B84A8 -> #5DA8C8 exact match to ref_06_phone_and_minimap.jpg)
    c.fillStyle = '#3B84A8';
    c.fillRect(0, 0, MAP_SIZE, MAP_SIZE);

    // Shallow turquoise coastline shelf (#5DA8C8)
    c.fillStyle = '#5DA8C8';
    c.beginPath();
    c.moveTo(0, 0);
    c.lineTo(760, 0);
    c.quadraticCurveTo(805, 290, 745, 560);
    c.quadraticCurveTo(690, 810, 730, MAP_SIZE);
    c.lineTo(0, MAP_SIZE);
    c.closePath();
    c.fill();

    // Golden-pale Vice Beach sand strip (#D8CCA6)
    c.fillStyle = '#D8CCA6';
    c.beginPath();
    c.moveTo(0, 0);
    c.lineTo(712, 0);
    c.quadraticCurveTo(752, 285, 694, 555);
    c.quadraticCurveTo(645, 795, 682, MAP_SIZE);
    c.lineTo(0, MAP_SIZE);
    c.closePath();
    c.fill();

    // Main Leonida / Vice-Dale sage-teal land mass (#6C9589 exact ref_06 palette)
    c.fillStyle = '#6C9589';
    c.beginPath();
    c.moveTo(0, 0);
    c.lineTo(682, 0);
    c.quadraticCurveTo(720, 285, 666, 550);
    c.quadraticCurveTo(618, 790, 654, MAP_SIZE);
    c.lineTo(0, MAP_SIZE);
    c.closePath();
    c.fill();

    // Inner Biscayne bay canal dividing mainland & Vice Beach island
    c.fillStyle = '#4B95B8';
    c.beginPath();
    c.moveTo(525, 0);
    c.quadraticCurveTo(568, 280, 520, 540);
    c.quadraticCurveTo(485, 760, 528, MAP_SIZE);
    c.lineTo(576, MAP_SIZE);
    c.quadraticCurveTo(535, 760, 568, 540);
    c.quadraticCurveTo(612, 280, 570, 0);
    c.closePath();
    c.fill();

    // Parks & golf greens (#557D73)
    c.fillStyle = '#557D73';
    const parks = [
      [140, 140, 150, 120], [330, 340, 95, 110], [600, 180, 58, 120],
      [190, 650, 140, 130], [585, 425, 55, 95]
    ];
    for (const [x, y, w, h] of parks) {
      c.beginPath();
      c.roundRect(x, y, w, h, 18);
      c.fill();
    }

    // Urban city blocks with subtle 3D rooftop highlights (#2B313E + #3F4758)
    for (let gx = 90; gx < 660; gx += 48) {
      for (let gy = 70; gy < 920; gy += 48) {
        // Skip canal & ocean
        if (gx > 508 && gx < 576) continue;
        if (gx > 642) continue;
        const hash = ((gx * 37 + gy * 91) % 100);
        if (hash < 24) continue;
        const bw = 24 + (hash % 14);
        const bh = 22 + ((hash * 3) % 14);
        c.fillStyle = '#252B36';
        c.fillRect(gx + 6, gy + 6, bw, bh);
        c.fillStyle = '#3C4556';
        c.fillRect(gx + 5, gy + 4, bw - 2, bh - 2);
      }
    }

    // Arterial streets (#3B424E)
    c.strokeStyle = '#3B424E';
    c.lineWidth = 6;
    for (let x = 86; x <= 662; x += 48) {
      if (x > 515 && x < 572) continue;
      c.beginPath(); c.moveTo(x, 20); c.lineTo(x, MAP_SIZE - 20); c.stroke();
    }
    for (let y = 66; y <= 940; y += 48) {
      c.beginPath(); c.moveTo(30, y); c.lineTo(665, y); c.stroke();
    }

    // Causeway bridges across Vice Bay + Ocean Drive expressway (#C5CDD4)
    c.strokeStyle = '#C5CDD4';
    c.lineWidth = 8;
    for (const by of [210, 450, 738]) {
      c.beginPath(); c.moveTo(86, by); c.lineTo(668, by); c.stroke();
    }
    c.beginPath(); c.moveTo(374, 10); c.lineTo(374, MAP_SIZE - 10); c.stroke();
    c.beginPath(); c.moveTo(648, 20); c.quadraticCurveTo(682, 290, 636, 560); c.quadraticCurveTo(598, 790, 628, MAP_SIZE - 10); c.stroke();

    return bakedMapCanvas;
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
    /* Suppress stock GTA V Scaleform loading stage in Experimental GTA 6 Mode */
    #loading { opacity: 0 !important; pointer-events: none !important; visibility: hidden !important; }
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

    /* Bottom-Left Minimap (Exact ref_04 + ref_06) */
    #vi-minimap-wrap { position: fixed; left: 24px; bottom: 22px; transition: width 0.25s ease, height 0.25s ease; }
    #vi-minimap-shell { position: relative; width: 248px; height: 152px; border-radius: 10px; overflow: hidden; background: #3B84A8; border: 2px solid rgba(255,255,255,0.24); box-shadow: 0 10px 30px rgba(0,0,0,0.58); transition: width 0.25s, height 0.25s, border-color 0.2s; }
    #vi-minimap-shell.expanded { width: 344px; height: 214px; }
    #vi-minimap-shell.wanted { border-color: #FF2E63; animation: vi-map-wanted 0.8s infinite alternate; }
    @keyframes vi-map-wanted { from { box-shadow: 0 0 0 2px rgba(255,46,99,0.55), 0 10px 28px rgba(0,0,0,0.6); } to { box-shadow: 0 0 18px 3px rgba(255,46,99,0.85), 0 10px 28px rgba(0,0,0,0.6); } }
    #vi-minimap-canvas { width: 100%; height: 100%; display: block; }
    #vi-minimap-north { position: absolute; width: 18px; height: 18px; border-radius: 50%; background: #14171F; border: 1.5px solid #fff; color: #fff; font-size: 10px; font-weight: 800; display: flex; align-items: center; justify-content: center; transform: translate(-50%,-50%); pointer-events: none; z-index: 4; box-shadow: 0 2px 6px rgba(0,0,0,0.7); }
    #vi-minimap-gps { position: absolute; left: 8px; bottom: 6px; padding: 2px 7px; border-radius: 5px; background: rgba(14,17,28,0.78); font-size: 11px; font-weight: 800; color: #FF88C2; font-variant-numeric: tabular-nums; letter-spacing: 0.04em; z-index: 4; }
    #vi-minimap-mode { position: absolute; right: 7px; top: 6px; padding: 2px 6px; border-radius: 4px; background: rgba(14,17,28,0.72); font-size: 9px; font-weight: 800; color: #67E8D0; letter-spacing: 0.08em; z-index: 4; }

    /* Optional Live Hair/Cloth Physics Companion Corner Rig */
    #vi-phys-rig { position: fixed; left: 284px; bottom: 22px; width: 108px; height: 126px; border-radius: 10px; overflow: hidden; border: 1px solid rgba(255,255,255,0.18); box-shadow: 0 8px 22px rgba(0,0,0,0.5); display: none; }
    #vi-phys-rig.visible { display: block; }
    #vi-phys-lbl { position: absolute; left: 0; right: 0; bottom: 3px; text-align: center; font-size: 9px; font-weight: 800; letter-spacing: 0.1em; color: #FFD1E6; text-shadow: 0 1px 3px #000; }

    /* Bottom-Right Contextual Hints + Vehicle Scan Card (ref_06) */
    #vi-hints { position: fixed; right: 26px; bottom: 22px; display: flex; flex-direction: column; align-items: flex-end; gap: 6px; }
    .vi-hint-pill { display: flex; align-items: center; gap: 7px; font-size: 11px; font-weight: 700; letter-spacing: 0.09em; color: rgba(255,255,255,0.88); text-shadow: 0 1px 4px rgba(0,0,0,0.85); }
    .vi-keycap { padding: 2px 6px; border-radius: 4px; background: #fff; color: #11131C; font-size: 10px; font-weight: 900; }

    /* Slide-in Vehicle Scan / Notification Toast */
    #vi-toast-stack { position: fixed; left: 26px; top: 96px; display: flex; flex-direction: column; gap: 8px; max-width: 310px; }
    .vi-toast { border-radius: 8px; overflow: hidden; box-shadow: 0 12px 30px rgba(0,0,0,0.55); animation: vi-slide-in 0.22s cubic-bezier(0.2,0.9,0.3,1); }
    .vi-toast-hdr { background: rgba(34, 30, 50, 0.94); padding: 7px 12px; font-size: 11px; font-weight: 800; letter-spacing: 0.12em; color: #FF8CC6; border-left: 3px solid #F04A98; }
    .vi-toast-body { background: rgba(236, 232, 224, 0.94); color: #1A1822; padding: 8px 12px; font-size: 12px; font-weight: 600; line-height: 1.35; }
    @keyframes vi-slide-in { from { opacity: 0; transform: translateX(-20px); } to { opacity: 1; transform: translateX(0); } }

    /* Live FPS / Frame-Time Counter Pill (Dev Verification on GTX 1050) */
    #vi-fps-pill { position: fixed; top: 20px; left: 50%; transform: translateX(-50%); padding: 5px 12px; border-radius: 8px; background: rgba(12,16,30,0.84); border: 1px solid rgba(103,232,208,0.45); font-size: 11px; font-weight: 800; letter-spacing: 0.06em; font-variant-numeric: tabular-nums; color: #67E8D0; display: none; }
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
              <button class="vi-pill ${cfg.sandboxMap === 'main' ? 'active' : ''}" data-map="main">LEONIDA / MAIN MAP</button>
              <button class="vi-pill ${cfg.sandboxMap === 'env_test' ? 'active' : ''}" data-map="env_test">VICE TEST (env_test)</button>
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
              <span>← EXIT TO CONSOLE</span>
              <span style="font-size:11px;color:#C8CDD6;">DASHBOARD</span>
            </button>
          </div>
          <div class="vi-menu-footer">
            <span>VICEBOX X · WEBGPU SANDBOX</span>
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
          <div style="font-size:12px;letter-spacing:0.18em;color:#F04A98;font-weight:800;">ENTERING VICE-DALE COUNTY · SANDBOX MODE</div>
          <div style="font-size:32px;font-weight:900;letter-spacing:0.06em;margin-top:4px;" id="vi-load-char">PLAYING AS ${CHARACTERS[cfg.character].name}</div>
          <div class="vi-load-track"><div class="vi-load-fill" id="vi-load-fill"></div></div>
          <div style="display:flex;justify-content:space-between;font-size:12px;color:#C8CDD6;">
            <span id="vi-load-lbl">Preparing WebGPU Vice Lighting & Shaders...</span>
            <span id="vi-load-pct">0%</span>
          </div>
        </div>
      </div>

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

        <!-- Centerpiece GTA 6 Minimap -->
        <div id="vi-minimap-wrap">
          <div id="vi-minimap-shell">
            <canvas id="vi-minimap-canvas" width="344" height="214"></canvas>
            <div id="vi-minimap-north">N</div>
            <div id="vi-minimap-mode">3D</div>
            <div id="vi-minimap-gps">1.34 mi</div>
          </div>
        </div>

        <!-- Optional Live Hair/Cloth Physics Companion Rig -->
        <div id="vi-phys-rig">
          <canvas id="vi-phys-canvas" width="108" height="126"></canvas>
          <div id="vi-phys-lbl">LUCIA · SPRING</div>
        </div>

        <!-- Bottom-Right Contextual Hints -->
        <div id="vi-hints">
          <div class="vi-hint-pill"><span>LOADOUT</span><span class="vi-keycap">TAB</span></div>
          <div class="vi-hint-pill"><span>PAUSE / MAP</span><span class="vi-keycap">P</span></div>
          <div class="vi-hint-pill"><span>PHONE</span><span class="vi-keycap">↑</span></div>
          <div class="vi-hint-pill"><span>FOCUS</span><span class="vi-keycap">C</span></div>
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
    const menu = document.getElementById('vi-menu');
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
    const menu = document.getElementById('vi-menu');
    const loadEl = document.getElementById('vi-loading');
    menu.classList.add('fadeout');
    setTimeout(() => { menu.classList.remove('visible'); }, 450);

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

    if (state.worldReady) {
      enterPlayingPhase();
      return;
    }

    loadEl.classList.add('visible');
    triggerPlayGta5SandboxMode();

    // Update loading bar until playgta5's WebGPU world broadcasts { world: true } (or user clicks Skip once frames appear)
    const tick = setInterval(() => {
      if (state.phase !== 'loading') { clearInterval(tick); return; }
      const fill = document.getElementById('vi-load-fill');
      const lbl = document.getElementById('vi-load-lbl');
      const pct = document.getElementById('vi-load-pct');
      const p = Math.min(99, Math.max(8, Math.round(state.loadPct)));
      if (fill) fill.style.width = p + '%';
      if (lbl) lbl.textContent = state.loadLabel || 'Streaming Leonida Sandbox Shaders...';
      if (pct) pct.textContent = p + '%';
      if (state.worldReady) {
        clearInterval(tick);
        enterPlayingPhase();
      }
    }, 180);

    // Safety fallback: if world broadcast already fired before listener bound, detect live canvas after 5s
    setTimeout(() => {
      if (state.phase === 'loading') {
        const cv = document.getElementById('canvas');
        if (cv && cv.width >= 320 && state.fps > 5) {
          state.worldReady = true;
          enterPlayingPhase();
        }
      }
    }, 6500);
  }

  function enterPlayingPhase() {
    state.phase = 'playing';
    const loadEl = document.getElementById('vi-loading');
    loadEl.classList.remove('visible');
    document.getElementById('vi-hud').classList.add('visible');
    updateHudVisibilitySettings();
    syncFxToWgpu();
    pushToast('LEONIDA SANDBOX ACTIVE', `${CHARACTERS[cfg.character].name} · Hold TAB for Loadout, P for Pause/Map, ↑ for Phone, C for Focus, F4 to Swap.`);
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
        <div><div>3D Perspective Minimap</div><div style="font-size:11px;color:#9BA6BE;">Switch between 3D tilted and 2D flat radar</div></div>
        <button class="vi-toggle ${cfg.minimap3D ? 'on' : ''}" data-set="minimap3D"></button>
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
    const mapMode = document.getElementById('vi-minimap-mode');
    if (fpsPill) fpsPill.classList.toggle('visible', !!cfg.showFpsCounter);
    if (physRig) physRig.classList.toggle('visible', !!cfg.showCompanionRig && cfg.hairClothPhysics);
    if (mapMode) mapMode.textContent = cfg.minimap3D ? '3D' : '2D';
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

    // Pink GPS route from player to waypoint
    if (state.waypoint) {
      ctx.strokeStyle = '#F04A98';
      ctx.lineWidth = 4;
      ctx.beginPath();
      ctx.moveTo(state.posX * sx, state.posY * sy);
      ctx.lineTo(state.waypoint.x * sx, state.posY * sy);
      ctx.lineTo(state.waypoint.x * sx, state.waypoint.y * sy);
      ctx.stroke();

      ctx.fillStyle = '#F04A98';
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

  // ==================== MINIMAP RENDERER (<0.22ms / FRAME) ====================
  function drawMinimap(timeSec) {
    const cv = document.getElementById('vi-minimap-canvas');
    if (!cv) return;
    const ctx = cv.getContext('2d');
    const w = cv.width, h = cv.height;
    const baked = ensureBakedMap();

    ctx.clearRect(0, 0, w, h);
    ctx.fillStyle = '#3B84A8';
    ctx.fillRect(0, 0, w, h);

    // Smooth perspective zoom & tilt when 3D mode is active
    const targetZoom = state.minimapExpanded ? 0.78 : (1.18 - state.speed * 0.38);
    state.smoothZoom += (targetZoom - state.smoothZoom) * 0.12;
    const cx = w * 0.5, cy = cfg.minimap3D ? h * 0.62 : h * 0.54;

    ctx.save();
    if (cfg.minimap3D) {
      // Lightweight 2.5D perspective shear/compress (zero WebGL overhead, silky 60fps on GTX 1050)
      ctx.translate(cx, cy);
      ctx.scale(1.06, 0.78);
      ctx.translate(-cx, -cy);
    }

    ctx.translate(cx, cy);
    ctx.rotate(-state.smoothHeading);
    ctx.scale(state.smoothZoom, state.smoothZoom);
    ctx.translate(-state.posX, -state.posY);

    // 1 single GPU-accelerated blit of the entire pre-baked Vice City vector tile!
    ctx.drawImage(baked, 0, 0);

    // Animated Hot-Pink GTA 6 GPS Waypoint Route (#F04A98)
    if (state.waypoint) {
      ctx.strokeStyle = 'rgba(240, 74, 152, 0.35)';
      ctx.lineWidth = 9;
      ctx.lineCap = 'round';
      ctx.lineJoin = 'round';
      ctx.beginPath();
      ctx.moveTo(state.posX, state.posY);
      ctx.lineTo(state.waypoint.x, state.posY);
      ctx.lineTo(state.waypoint.x, state.waypoint.y);
      ctx.stroke();

      ctx.strokeStyle = '#F04A98';
      ctx.lineWidth = 4.5;
      ctx.beginPath();
      ctx.moveTo(state.posX, state.posY);
      ctx.lineTo(state.waypoint.x, state.posY);
      ctx.lineTo(state.waypoint.x, state.waypoint.y);
      ctx.stroke();
    }

    // Crisp custom blips (NO police dots during wanted — authentic GTA 6 mechanic!)
    for (const b of BLIPS) {
      ctx.fillStyle = '#14171F';
      ctx.beginPath(); ctx.arc(b.x, b.y, 7.5, 0, Math.PI * 2); ctx.fill();
      ctx.fillStyle = b.color;
      ctx.beginPath(); ctx.arc(b.x, b.y, 4.5, 0, Math.PI * 2); ctx.fill();
    }
    ctx.restore();

    // Red-pink manhunt search zone glow when wanted (no cop dots!)
    if (state.wantedStars > 0) {
      const pulse = 0.16 + 0.12 * Math.sin(timeSec * 5.2);
      ctx.fillStyle = `rgba(255, 46, 99, ${pulse.toFixed(3)})`;
      ctx.fillRect(0, 0, w, h);
    }

    // Subtle top horizon haze in 3D mode
    if (cfg.minimap3D) {
      const hz = ctx.createLinearGradient(0, 0, 0, h * 0.34);
      hz.addColorStop(0, 'rgba(20, 28, 48, 0.58)');
      hz.addColorStop(1, 'rgba(20, 28, 48, 0)');
      ctx.fillStyle = hz;
      ctx.fillRect(0, 0, w, h * 0.34);
    }

    // Player white directional chevron inside crisp dark halo
    ctx.save();
    ctx.translate(cx, cy);
    ctx.fillStyle = '#14171F';
    ctx.beginPath(); ctx.arc(0, 0, 10, 0, Math.PI * 2); ctx.fill();
    ctx.fillStyle = '#FFFFFF';
    ctx.beginPath(); ctx.moveTo(0, -7); ctx.lineTo(5.5, 5.5); ctx.lineTo(0, 2.5); ctx.lineTo(-5.5, 5.5); ctx.closePath(); ctx.fill();
    ctx.restore();

    // Orbiting North ('N') badge clamped cleanly onto minimap perimeter!
    const northEl = document.getElementById('vi-minimap-north');
    const shell = document.getElementById('vi-minimap-shell');
    if (northEl && shell) {
      const sw = shell.clientWidth, sh = shell.clientHeight;
      const na = -state.smoothHeading - Math.PI / 2;
      const dx = Math.cos(na), dy = Math.sin(na);
      const scaleX = (sw * 0.5 - 11) / Math.max(0.001, Math.abs(dx));
      const scaleY = (sh * 0.5 - 11) / Math.max(0.001, Math.abs(dy));
      const t = Math.min(scaleX, scaleY);
      northEl.style.left = (sw * 0.5 + dx * t) + 'px';
      northEl.style.top = (sh * 0.5 + dy * t) + 'px';
    }

    // Live GPS distance countdown readout
    const gpsEl = document.getElementById('vi-minimap-gps');
    if (gpsEl && state.waypoint) {
      const distMi = (Math.hypot(state.waypoint.x - state.posX, state.waypoint.y - state.posY) / 195).toFixed(2);
      gpsEl.textContent = distMi + ' mi';
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

    window.addEventListener('keydown', (e) => {
      state.keys[e.code] = true;
      if (state.phase !== 'playing') return;

      if (e.code === 'Tab' || e.code === 'KeyQ') {
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
      } else if (e.code === 'ArrowUp' || e.code === 'KeyK') {
        if (!state.pauseOpen && !state.wheelOpen) {
          e.preventDefault();
          setPhoneOpen(!state.phoneOpen);
        }
      } else if (e.code === 'KeyC' && !state.pauseOpen && !state.wheelOpen) {
        state.focusActive = !state.focusActive;
        playUiTone(state.focusActive ? 260 : 420, 0.12, 0.06, 'sine');
      } else if (e.code === 'KeyN' && !state.pauseOpen) {
        cfg.minimap3D = !cfg.minimap3D;
        saveCfg();
        updateHudVisibilitySettings();
        pushToast('RADAR MODE', cfg.minimap3D ? '3D Perspective Minimap' : '2D Top-Down Minimap');
      } else if (e.code === 'KeyZ' && !state.pauseOpen) {
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
        if (state.pauseOpen) setPauseOpen(false);
        else if (state.phoneOpen) setPhoneOpen(false);
        else if (state.wheelOpen) setWheelOpen(false);
      }
    }, true);

    window.addEventListener('keyup', (e) => {
      state.keys[e.code] = false;
      if (state.phase === 'playing' && (e.code === 'Tab' || e.code === 'KeyQ') && state.wheelOpen) {
        selectWheelSlot(state.hoveredSlot);
        setWheelOpen(false);
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
        // Player forward/strafe kinematics for minimap tracking + radial speed blur
        const fwd = (state.keys['KeyW'] ? 1 : 0) - (state.keys['KeyS'] ? 1 : 0);
        const turn = (state.keys['KeyD'] ? 1 : 0) - (state.keys['KeyA'] ? 1 : 0);
        const sprint = !!state.keys['ShiftLeft'] || !!state.keys['ShiftRight'];

        const targetSpeed = fwd > 0 ? (sprint ? 1.0 : 0.45) : (fwd < 0 ? 0.25 : 0);
        state.speed += (targetSpeed - state.speed) * Math.min(1, dt * 4.5);
        if (turn !== 0 && state.speed > 0.15) {
          state.heading += turn * dt * 1.45;
          state.camVelX = Math.max(-18, Math.min(18, state.camVelX + turn * 2.2));
        }
        state.smoothHeading += (state.heading - state.smoothHeading) * Math.min(1, dt * 10);

        // Advance minimap position cleanly within Vice-Dale County bounds
        const movePx = state.speed * dt * 36 * (fwd < 0 ? -0.5 : 1);
        state.posX = Math.max(60, Math.min(MAP_SIZE - 60, state.posX + Math.sin(state.smoothHeading) * movePx));
        state.posY = Math.max(60, Math.min(MAP_SIZE - 60, state.posY - Math.cos(state.smoothHeading) * movePx));

        // Vitals simulation (Stamina sprint drain + Focus Eagle Eye drain)
        if (sprint && fwd > 0) state.stamina = Math.max(0, state.stamina - dt * 14);
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
            fp.textContent = `${state.fps.toFixed(1)} FPS · ${state.frameMs.toFixed(2)} ms · ${state.resW}×${state.resH}${tierTag}`;
          }
        }

        // Update Hair & Cloth spring physics + draw minimap
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
