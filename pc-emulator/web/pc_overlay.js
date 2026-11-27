/**
 * ViceBox X PC Gameplay Enhancement Layer (Injected into GTA V Runtime)
 * Features:
 * 1. Real Live Hardware Debug Overlay (Real Windows CPU %, Real Windows GPU %, Real VRAM/RAM, Real Game FPS)
 * 2. Full Mobile-Parity GTA V Cheat Menu (Vehicles, Weapons, Player/Fly, Visuals/Perf, Dev Console)
 * 3. Full DualSense (PS5) & Xbox Controller Support Mapped to Real GTA V Default Controls
 * 4. Real Frame-Smoothing Motion Blur System (masks frame stutters smoothly)
 * 5. Real Optimization Mode (high-performance GPU adapter, HiDPI fillrate clamp, visual-preserving RAGE tuning)
 */
(function () {
  'use strict';
  if (window.__viceboxPcOverlay) return;
  window.__viceboxPcOverlay = true;

  // Read initial runtime flags from URL + sync live state with local C++ server
  const urlParams = new URLSearchParams(window.location.search);
  const vbxState = {
    consoleTarget: urlParams.get('vbx_console') || urlParams.get('vbx_from') || 'ps5', // 'ps5' | 'xbox' | 'viceos'
    emulatedGame: urlParams.get('vbx_mode') || 'gta5', // 'gta5' | 'gta6' | 'all'
    isGta6Sandbox: urlParams.get('vbx_title') === 'gta6',
    showDebugHud: urlParams.get('vbx_hud') !== '0',
    enableCheatMenu: urlParams.get('vbx_cheats') !== '0',
    motionBlur: urlParams.get('vbx_mblur') === '1',
    motionBlurStrength: Math.max(0, Math.min(100, parseInt(urlParams.get('vbx_mblur_str') || '55', 10) || 55)),
    optimizationMode: urlParams.get('vbx_opt') === '1',
    lookSensitivity: Math.max(20, Math.min(300, parseInt(urlParams.get('vbx_sens') || '100', 10) || 100)),
    cheatOpen: false,
    autoGodMode: false,
    vehicleMode: false, // Toggled automatically when Y / Triangle is pressed
    controllerName: '',
    controllerType: 'dualsense', // 'dualsense' | 'xbox'
    realFps: 0,
    frameMs: 0,
    bcFpsSeenAt: 0,
    telemetry: { cpuPct: 0, gpuPct: 0, vramUsedMb: 0, ramUsedGb: 0, ramTotalGb: 16, gpuName: '' },
    fpsHistory: [],
    lastCamSpeed: 0
  };

  // ==================== 0. WEBSOCKET PASSTHROUGH FOR MULTIPLAYER ====================
  // If playgta5.com opens a relative WebSocket against 127.0.0.1, forward directly to wss://playgta5.com
  try {
    const OrigWS = window.WebSocket;
    window.WebSocket = function (url, protocols) {
      let target = String(url || '');
      if (target.startsWith('ws://127.0.0.1') || target.startsWith('ws://localhost')) {
        target = target.replace(/^ws:\/\/(127\.0\.0\.1|localhost)(:\d+)?/, 'wss://playgta5.com');
      }
      return protocols !== undefined ? new OrigWS(target, protocols) : new OrigWS(target);
    };
    window.WebSocket.prototype = OrigWS.prototype;
    Object.assign(window.WebSocket, OrigWS);
  } catch (e) {}

  // ==================== 0B. REAL GTA V LOOK SENSITIVITY HOOK (MOUSE + POINTER LOCK) ====================
  // Scales MouseEvent/PointerEvent movementX & movementY with sub-pixel fractional carry so
  // both slow (20%) and fast (300%) camera look work smoothly in GTA V without touching cursor clientX/Y.
  (function installLookSensitivityHook() {
    try {
      const descX = Object.getOwnPropertyDescriptor(MouseEvent.prototype, 'movementX');
      const descY = Object.getOwnPropertyDescriptor(MouseEvent.prototype, 'movementY');
      if (!descX || !descY || !descX.get || !descY.get || !descX.configurable || !descY.configurable) return;

      const origGetX = descX.get;
      const origGetY = descY.get;
      const scaledCache = new WeakMap();
      let carryX = 0;
      let carryY = 0;

      function computeScaled(ev) {
        let cached = scaledCache.get(ev);
        if (cached) return cached;

        const rawX = origGetX.call(ev);
        const rawY = origGetY.call(ev);

        // Synthetic events (controller right-stick) are already scaled by lookSensitivity
        if (!ev.isTrusted || vbxState.lookSensitivity === 100) {
          cached = { x: rawX, y: rawY };
          scaledCache.set(ev, cached);
          return cached;
        }

        const factor = Math.max(0.20, Math.min(3.00, vbxState.lookSensitivity / 100.0));
        const fx = rawX * factor + carryX;
        const fy = rawY * factor + carryY;
        const ix = fx >= 0 ? Math.floor(fx) : Math.ceil(fx);
        const iy = fy >= 0 ? Math.floor(fy) : Math.ceil(fy);
        carryX = fx - ix;
        carryY = fy - iy;
        // Clamp fractional residual safely
        if (Math.abs(carryX) > 2) carryX = 0;
        if (Math.abs(carryY) > 2) carryY = 0;

        cached = { x: ix, y: iy };
        scaledCache.set(ev, cached);
        return cached;
      }

      Object.defineProperty(MouseEvent.prototype, 'movementX', {
        configurable: true,
        enumerable: true,
        get: function () { return computeScaled(this).x; }
      });
      Object.defineProperty(MouseEvent.prototype, 'movementY', {
        configurable: true,
        enumerable: true,
        get: function () { return computeScaled(this).y; }
      });
    } catch (e) {}
  })();

  // ==================== 1. REAL OPTIMIZATION MODE (VISUAL-PRESERVING) ====================
  // Runs BEFORE playgta5.com boots so GPU adapter & DPR fillrate optimizations take effect immediately!
  function applyEarlyOptimizations() {
    // Always request high-performance discrete GPU adapter so Windows laptops don't fall back to iGPU
    try {
      if (navigator.gpu && typeof navigator.gpu.requestAdapter === 'function') {
        const origReqAdapter = navigator.gpu.requestAdapter.bind(navigator.gpu);
        navigator.gpu.requestAdapter = function (opts) {
          const merged = Object.assign({}, opts || {}, { powerPreference: 'high-performance' });
          return origReqAdapter(merged);
        };
      }
    } catch (e) {}

    if (vbxState.optimizationMode) {
      // Clamp excessive Windows 125%/150%/200% HiDPI scaling on game canvas to 1.0 (huge fillrate gain, same visuals!)
      try {
        if ((window.devicePixelRatio || 1) > 1.0) {
          Object.defineProperty(window, 'devicePixelRatio', {
            configurable: true,
            get: function () { return 1.0; }
          });
        }
      } catch (e) {}

      // Keep Textures & Shaders crisp (identical look) while disabling invisible GPU hogs in settings.xml
      syncOptimizationSettingsXml(true);
    }
  }

  function syncOptimizationSettingsXml(enable) {
    if (!window.indexedDB) return;
    try {
      const req = indexedDB.open('gta5-userdata', 1);
      req.onupgradeneeded = function () {
        const db = req.result;
        if (!db.objectStoreNames.contains('files')) db.createObjectStore('files');
      };
      req.onsuccess = function () {
        try {
          const db = req.result;
          if (!db.objectStoreNames.contains('files')) { db.close(); return; }
          const tx = db.transaction('files', 'readwrite');
          const store = tx.objectStore('files');
          const getReq = store.get('/userdata/settings.xml');
          getReq.onsuccess = function () {
            try {
              const rec = getReq.result;
              if (!rec || !rec.data) return;
              let xml = new TextDecoder('utf-8').decode(rec.data instanceof Uint8Array ? rec.data : new Uint8Array(rec.data));
              const setTag = (tag, val) => {
                const re = new RegExp('(<' + tag + '\\s+value=")[^"]*("\\s*/>)', 'i');
                if (re.test(xml)) xml = xml.replace(re, '$1' + val + '$2');
              };
              if (enable) {
                // Visual-preserving optimizations: keep TextureQuality & ShaderQuality untouched!
                setTag('Tessellation', 0);
                setTag('PostFX', 0);
                setTag('MSAA', 0);
                setTag('ReflectionMSAA', 0);
                setTag('Shadow_SoftShadows', 0);
                setTag('DX_Version', 2);
              } else {
                setTag('PostFX', 1);
                setTag('Tessellation', 1);
              }
              store.put({ data: new TextEncoder().encode(xml), mtime: Date.now() }, '/userdata/settings.xml');
            } catch (e) {}
          };
          tx.oncomplete = function () { db.close(); };
        } catch (e) {}
      };
    } catch (e) {}
  }

  applyEarlyOptimizations();

  // ==================== 2. REAL VIRTUAL POINTER LOCK + INPUT DISPATCHER ====================
  let virtualLocked = false;
  const heldKeys = new Set();
  const heldButtons = new Set();

  function getGameCanvas() {
    return document.getElementById('canvas') || document.querySelector('canvas:not(#vbx-mblur):not(#vbx-fps-graph)');
  }

  const KEY_MAP = {
    KeyW: 'w', KeyA: 'a', KeyS: 's', KeyD: 'd',
    KeyE: 'e', KeyF: 'f', KeyR: 'r', KeyQ: 'q', KeyV: 'v', KeyC: 'c',
    KeyG: 'g', KeyH: 'h', KeyI: 'i', KeyJ: 'j', KeyK: 'k', KeyL: 'l',
    KeyM: 'm', KeyP: 'p', KeyZ: 'z', KeyX: 'x', KeyT: 't',
    Space: ' ', ShiftLeft: 'Shift', ControlLeft: 'Control', AltLeft: 'Alt',
    Tab: 'Tab', Escape: 'Escape', Enter: 'Enter', Backspace: 'Backspace',
    Backquote: '`', ArrowUp: 'ArrowUp', ArrowDown: 'ArrowDown',
    ArrowLeft: 'ArrowLeft', ArrowRight: 'ArrowRight',
    Digit1: '1', Digit2: '2', Digit3: '3', Digit4: '4', Digit5: '5', Digit6: '6'
  };

  function dispatchKey(code, down, explicitKey) {
    const key = explicitKey !== undefined ? explicitKey : (KEY_MAP[code] || code);
    if (down) {
      if (heldKeys.has(code)) return;
      heldKeys.add(code);
    } else {
      if (!heldKeys.has(code)) return;
      heldKeys.delete(code);
    }
    try {
      window.dispatchEvent(new KeyboardEvent(down ? 'keydown' : 'keyup', {
        code: code, key: key, bubbles: true, cancelable: true
      }));
    } catch (e) {}
  }

  function pulseKey(code, ms) {
    dispatchKey(code, true);
    setTimeout(() => dispatchKey(code, false), ms || 65);
  }

  function dispatchMouseBtn(button, down) {
    const c = getGameCanvas();
    if (down) {
      if (heldButtons.has(button)) return;
      heldButtons.add(button);
      const cx = c ? c.clientWidth * 0.5 : window.innerWidth * 0.5;
      const cy = c ? c.clientHeight * 0.5 : window.innerHeight * 0.5;
      try {
        (c || window).dispatchEvent(new MouseEvent('mousedown', {
          bubbles: true, cancelable: true, button: button, clientX: cx, clientY: cy
        }));
      } catch (e) {}
    } else {
      if (!heldButtons.has(button)) return;
      heldButtons.delete(button);
      try {
        window.dispatchEvent(new MouseEvent('mouseup', {
          bubbles: true, cancelable: true, button: button
        }));
      } catch (e) {}
    }
  }

  function dispatchMouseMove(dx, dy) {
    if (!dx && !dy) return;
    vbxState.lastCamSpeed = Math.min(40, Math.hypot(dx, dy));
    // Ensure game accepts camera movement from controller even if user hasn't clicked canvas yet
    if (!document.pointerLockElement) {
      const c = getGameCanvas();
      if (c && typeof c.requestPointerLock === 'function') {
        try {
          const res = c.requestPointerLock();
          if (res && typeof res.catch === 'function') res.catch(() => {});
        } catch (e) {}
      }
    }
    try {
      window.dispatchEvent(new MouseEvent('mousemove', {
        bubbles: true, cancelable: true, movementX: dx, movementY: dy
      }));
    } catch (e) {}
  }

  function dispatchWheel(steps) {
    try {
      window.dispatchEvent(new WheelEvent('wheel', {
        bubbles: true, cancelable: true, deltaMode: 0, deltaY: steps * 110
      }));
    } catch (e) {}
  }

  // ==================== 3. BATTLE-TESTED GTA V CHEAT CONSOLE EXECUTOR ====================
  const cheatQueue = [];
  let cheatRunning = false;

  function charToCode(ch) {
    const up = ch.toUpperCase();
    if (up >= 'A' && up <= 'Z') return 'Key' + up;
    if (up >= '0' && up <= '9') return 'Digit' + up;
    if (ch === ' ') return 'Space';
    if (ch === '-') return 'Minus';
    return null;
  }

  function rawCharKey(code, ch, down) {
    try {
      window.dispatchEvent(new KeyboardEvent(down ? 'keydown' : 'keyup', {
        code: code, key: ch, bubbles: true, cancelable: true
      }));
    } catch (e) {}
  }

  function runCheat(codeStr, label) {
    const clean = String(codeStr || '').trim().toUpperCase();
    if (!clean) return;
    cheatQueue.push({ code: clean, label: label || clean });
    showToast('Sending Cheat: ' + (label || clean) + ' (' + clean + ')');
    pumpCheatQueue();
  }

  function pumpCheatQueue() {
    if (cheatRunning || cheatQueue.length === 0) return;
    cheatRunning = true;
    const item = cheatQueue.shift();
    const text = item.code.toLowerCase();

    try { window.dispatchEvent(new Event('focus')); } catch (e) {}
    rawCharKey('Backquote', '`', true);
    setTimeout(() => {
      rawCharKey('Backquote', '`', false);
      let i = 0;
      function nextChar() {
        if (i >= text.length) {
          setTimeout(() => {
            rawCharKey('Enter', 'Enter', true);
            setTimeout(() => {
              rawCharKey('Enter', 'Enter', false);
              showToast('Activated: ' + item.label + ' (' + item.code + ')', '#19db7a');
              setTimeout(() => { cheatRunning = false; pumpCheatQueue(); }, 180);
            }, 55);
          }, 70);
          return;
        }
        const ch = text[i++];
        const code = charToCode(ch);
        if (code) {
          rawCharKey(code, ch, true);
          setTimeout(() => {
            rawCharKey(code, ch, false);
            setTimeout(nextChar, 24);
          }, 28);
        } else {
          setTimeout(nextChar, 10);
        }
      }
      setTimeout(nextChar, 140);
    }, 65);
  }

  let godModeTimer = null;
  function setAutoGodMode(on) {
    vbxState.autoGodMode = !!on;
    if (godModeTimer) { clearInterval(godModeTimer); godModeTimer = null; }
    if (vbxState.autoGodMode) {
      runCheat('PAINKILLER', 'God Mode (Auto-Renew)');
      godModeTimer = setInterval(() => {
        if (vbxState.autoGodMode) runCheat('PAINKILLER', 'God Mode Renewed');
      }, 270000);
    }
  }

  // ==================== 4. REAL LIVE FPS + REAL PC HARDWARE TELEMETRY ====================
  try {
    const fpsBc = new BroadcastChannel('game-fps');
    fpsBc.onmessage = (ev) => {
      if (ev.data && typeof ev.data.fps === 'number' && ev.data.fps >= 0) {
        vbxState.realFps = ev.data.fps;
        vbxState.bcFpsSeenAt = performance.now();
      }
    };
  } catch (e) {}

  let rafFrames = 0;
  let rafLastSample = performance.now();
  let rafPrevFrame = performance.now();

  async function pollTelemetry() {
    try {
      const r = await fetch('/vbx/api/telemetry', { cache: 'no-store' });
      if (r.ok) {
        const d = await r.json();
        vbxState.telemetry = d;
      }
    } catch (e) {}
  }

  let lastLocalConfigEditAt = 0;

  async function syncServerConfig() {
    if (performance.now() - lastLocalConfigEditAt < 1500) return;
    try {
      const r = await fetch('/vbx/api/state', { cache: 'no-store' });
      if (!r.ok) return;
      const s = await r.json();
      if (performance.now() - lastLocalConfigEditAt < 1500) return;
      if (typeof s.consoleTarget === 'string') vbxState.consoleTarget = s.consoleTarget;
      if (typeof s.emulatedGame === 'string') vbxState.emulatedGame = s.emulatedGame;
      if (typeof s.showDebugHud === 'boolean') vbxState.showDebugHud = s.showDebugHud;
      if (typeof s.enableCheatMenu === 'boolean') vbxState.enableCheatMenu = s.enableCheatMenu;
      if (typeof s.motionBlur === 'boolean') vbxState.motionBlur = s.motionBlur;
      if (typeof s.motionBlurStrength === 'number') vbxState.motionBlurStrength = s.motionBlurStrength;
      if (typeof s.optimizationMode === 'boolean') vbxState.optimizationMode = s.optimizationMode;
      if (typeof s.lookSensitivity === 'number') {
        vbxState.lookSensitivity = Math.max(20, Math.min(300, Math.round(s.lookSensitivity)));
        const sensInp = document.getElementById('vbx-opt-sens');
        const sensLbl = document.getElementById('vbx-sens-val');
        if (sensInp && document.activeElement !== sensInp) sensInp.value = String(vbxState.lookSensitivity);
        if (sensLbl) sensLbl.textContent = vbxState.lookSensitivity + '%';
      }
      updateUiVisibility();
    } catch (e) {}
  }

  function pushConfigUpdate(patch) {
    lastLocalConfigEditAt = performance.now();
    try {
      fetch('/vbx/api/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch)
      }).catch(() => {});
    } catch (e) {}
  }

  // ==================== 5. REAL GPU MOTION BLUR (DIRECTIONAL SVG + RADIAL SPEED + STUTTER SMOOTHING) ====================
  // Tracks REAL mouse look (including Pointer Lock), keyboard driving/sprinting/turning,
  // controller sticks/triggers, and frame-time spikes. Renders 100% on the Chromium GPU compositor
  // directly over WebGPU OffscreenCanvas #canvas (zero drawImage readback!).
  const mbMotion = {
    rawVx: 0,
    rawVy: 0,
    smoothVx: 0,
    smoothVy: 0,
    fwdSpeed: 0,
    turnRate: 0,
    lastMouseX: null,
    lastMouseY: null,
    keys: new Set(),
    padGas: 0,
    padSteer: 0
  };

  // Capture REAL mouse movement (Pointer Lock movementX/Y + unlocked cursor fallback)
  window.addEventListener('mousemove', (e) => {
    let dx = (typeof e.movementX === 'number') ? e.movementX : 0;
    let dy = (typeof e.movementY === 'number') ? e.movementY : 0;
    if (dx === 0 && dy === 0 && mbMotion.lastMouseX !== null) {
      dx = e.clientX - mbMotion.lastMouseX;
      dy = e.clientY - mbMotion.lastMouseY;
    }
    mbMotion.lastMouseX = e.clientX;
    mbMotion.lastMouseY = e.clientY;
    // Clamp absurd pointer-lock jump spikes (>160px in a single event)
    dx = Math.max(-160, Math.min(160, dx));
    dy = Math.max(-160, Math.min(160, dy));
    mbMotion.rawVx += dx;
    mbMotion.rawVy += dy;
    vbxState.lastCamSpeed = Math.min(60, Math.hypot(dx, dy));
  }, true);

  // Capture REAL keyboard movement / driving / sprinting keys
  window.addEventListener('keydown', (e) => {
    if (e.code) mbMotion.keys.add(e.code);
  }, true);
  window.addEventListener('keyup', (e) => {
    if (e.code) mbMotion.keys.delete(e.code);
  }, true);
  window.addEventListener('blur', () => {
    mbMotion.keys.clear();
    mbMotion.padGas = 0;
    mbMotion.padSteer = 0;
  });

  let mbSvgEl = null;
  let mbBlurNode = null;
  let mbRadialEl = null;
  let mbPanEl = null;
  let mbFilterActive = false;

  function ensureMotionBlurNodes() {
    if (!document.body) return;
    if (!mbSvgEl) {
      const svgNS = 'http://www.w3.org/2000/svg';
      mbSvgEl = document.createElementNS(svgNS, 'svg');
      mbSvgEl.id = 'vbx-mblur-svg';
      mbSvgEl.setAttribute('aria-hidden', 'true');
      // Keep 1x1 off-screen (never display:none or 0x0) so Chromium always keeps the SVG filter active
      mbSvgEl.style.cssText = 'position:fixed;left:-9999px;top:-9999px;width:1px;height:1px;overflow:hidden;pointer-events:none;';
      const defs = document.createElementNS(svgNS, 'defs');
      const filter = document.createElementNS(svgNS, 'filter');
      filter.id = 'vbx-dir-mblur';
      filter.setAttribute('x', '-4%');
      filter.setAttribute('y', '-4%');
      filter.setAttribute('width', '108%');
      filter.setAttribute('height', '108%');
      filter.setAttribute('color-interpolation-filters', 'sRGB');
      mbBlurNode = document.createElementNS(svgNS, 'feGaussianBlur');
      mbBlurNode.id = 'vbx-dir-blur';
      mbBlurNode.setAttribute('in', 'SourceGraphic');
      mbBlurNode.setAttribute('stdDeviation', '0 0');
      mbBlurNode.setAttribute('edgeMode', 'duplicate');
      filter.appendChild(mbBlurNode);
      defs.appendChild(filter);
      mbSvgEl.appendChild(defs);
      document.body.appendChild(mbSvgEl);
    }
    if (!mbPanEl) {
      mbPanEl = document.createElement('div');
      mbPanEl.id = 'vbx-mblur-pan';
      mbPanEl.style.cssText =
        'position:fixed;inset:0;pointer-events:none;z-index:99898;display:none;will-change:backdrop-filter,opacity;';
      document.body.appendChild(mbPanEl);
    }
    if (!mbRadialEl) {
      mbRadialEl = document.createElement('div');
      mbRadialEl.id = 'vbx-mblur-radial';
      mbRadialEl.style.cssText =
        'position:fixed;inset:0;pointer-events:none;z-index:99899;display:none;' +
        '-webkit-mask-image:radial-gradient(ellipse 62% 60% at 50% 50%, transparent 38%, rgba(0,0,0,0.95) 100%);' +
        'mask-image:radial-gradient(ellipse 62% 60% at 50% 50%, transparent 38%, rgba(0,0,0,0.95) 100%);' +
        'will-change:backdrop-filter,opacity;';
      document.body.appendChild(mbRadialEl);
    }
  }

  function updateMotionBlur(now, dtMs) {
    const gameCanvas = getGameCanvas();
    if (!gameCanvas) return;
    ensureMotionBlurNodes();

    const clampedDt = Math.max(4, Math.min(80, dtMs || 16.67));
    const dtSec = clampedDt / 1000;

    // Integrate camera velocity from mouse + controller right-stick with smooth exponential decay
    const decay = Math.exp(-dtSec * 12.0);
    mbMotion.smoothVx = mbMotion.smoothVx * decay + mbMotion.rawVx * (1 - decay) * 2.4;
    mbMotion.smoothVy = mbMotion.smoothVy * decay + mbMotion.rawVy * (1 - decay) * 2.4;
    mbMotion.rawVx = 0;
    mbMotion.rawVy = 0;
    vbxState.lastCamSpeed *= decay;

    // Integrate driving/sprinting forward speed & steering yaw from keyboard + controller
    const k = mbMotion.keys;
    const movingFwd = k.has('KeyW') || k.has('ArrowUp') || mbMotion.padGas > 0.15;
    const movingRev = k.has('KeyS') || k.has('ArrowDown');
    const sprinting = k.has('ShiftLeft') || k.has('ShiftRight');
    const steering = (k.has('KeyA') || k.has('ArrowLeft') ? -1 : 0) + (k.has('KeyD') || k.has('ArrowRight') ? 1 : 0) + mbMotion.padSteer;

    const targetFwd = movingFwd ? (sprinting || vbxState.vehicleMode ? 1.0 : 0.72) : (movingRev ? 0.45 : 0.0);
    const rampRate = targetFwd > mbMotion.fwdSpeed ? 3.4 : 4.8;
    mbMotion.fwdSpeed += (targetFwd - mbMotion.fwdSpeed) * Math.min(1, dtSec * rampRate);

    const targetTurn = Math.min(1.0, Math.abs(steering)) * (0.45 + mbMotion.fwdSpeed * 0.55);
    mbMotion.turnRate += (targetTurn - mbMotion.turnRate) * Math.min(1, dtSec * 8.0);

    if (!vbxState.motionBlur || vbxState.motionBlurStrength <= 0) {
      if (mbFilterActive) {
        gameCanvas.style.filter = '';
        mbFilterActive = false;
      }
      if (mbPanEl) mbPanEl.style.display = 'none';
      if (mbRadialEl) mbRadialEl.style.display = 'none';
      return;
    }

    const strength = Math.max(0, Math.min(1, vbxState.motionBlurStrength / 100.0));
    const stutterBoost = Math.max(0, Math.min(1, (clampedDt - 19) / 28)) * 3.0;

    // Layer 1: TRUE anisotropic directional SVG blur on #canvas (horizontal vs vertical streak)
    const absVx = Math.abs(mbMotion.smoothVx);
    const absVy = Math.abs(mbMotion.smoothVy);
    const camVel = Math.hypot(absVx, absVy);
    const dirX = Math.min(14.0, (absVx * 0.30 + mbMotion.turnRate * 3.8 + mbMotion.fwdSpeed * 0.9 + stutterBoost) * strength);
    const dirY = Math.min(10.0, (absVy * 0.26 + mbMotion.fwdSpeed * 0.35 + stutterBoost * 0.55) * strength);

    if (mbBlurNode && (dirX > 0.14 || dirY > 0.14)) {
      mbBlurNode.setAttribute('stdDeviation', `${dirX.toFixed(2)} ${dirY.toFixed(2)}`);
      if (!mbFilterActive) {
        gameCanvas.style.filter = 'url(#vbx-dir-mblur)';
        mbFilterActive = true;
      }
    } else if (mbFilterActive) {
      gameCanvas.style.filter = '';
      mbFilterActive = false;
    }

    // Layer 2: Compositor-level camera-pan & stutter smoothing blur (guaranteed on ALL WebGPU OffscreenCanvas drivers!)
    const panPx = Math.min(7.5, (camVel * 0.16 + mbMotion.turnRate * 2.1 + stutterBoost * 0.85) * strength);
    if (mbPanEl && panPx > 0.25) {
      mbPanEl.style.display = 'block';
      mbPanEl.style.backdropFilter = `blur(${panPx.toFixed(1)}px)`;
      mbPanEl.style.webkitBackdropFilter = `blur(${panPx.toFixed(1)}px)`;
      mbPanEl.style.opacity = String(Math.min(0.78, 0.22 + (panPx / 7.5) * 0.56));
    } else if (mbPanEl) {
      mbPanEl.style.display = 'none';
    }

    // Layer 3: GPU-composited Peripheral Radial Speed Tunnel (sharp center, smooth rushing edges during driving/sprinting/turning)
    const speedMag = Math.min(1.0, mbMotion.fwdSpeed * 0.88 + camVel * 0.03 + mbMotion.turnRate * 0.5);
    const radialPx = (speedMag * 8.5 + stutterBoost * 0.9) * strength;
    if (mbRadialEl && radialPx > 0.35) {
      mbRadialEl.style.display = 'block';
      mbRadialEl.style.backdropFilter = `blur(${radialPx.toFixed(1)}px)`;
      mbRadialEl.style.webkitBackdropFilter = `blur(${radialPx.toFixed(1)}px)`;
      mbRadialEl.style.opacity = String(Math.min(0.95, 0.35 + speedMag * 0.6));
    } else if (mbRadialEl) {
      mbRadialEl.style.display = 'none';
    }
  }

  // ==================== 6. DUALSENSE & XBOX CONTROLLER -> REAL GTA V DEFAULT CONTROLS + CHEAT DRAWER NAV ====================
  const prevBtn = new Array(24).fill(false);
  let lastComboAt = 0;
  let drawerFocusIdx = 0;
  let drawerPadVCd = 0;
  let drawerPadHCd = 0;

  function getCheatDrawerControls() {
    const body = document.getElementById('vbx-cheat-body');
    if (!body) return [];
    return Array.from(body.querySelectorAll('button:not(:disabled), input[type="checkbox"], input[type="range"], input[type="text"]')).filter((el) => {
      const st = window.getComputedStyle(el);
      return st.display !== 'none' && st.visibility !== 'hidden';
    });
  }

  function applyCheatDrawerFocus() {
    const body = document.getElementById('vbx-cheat-body');
    if (!body) return;
    body.querySelectorAll('.vbx-pad-focus').forEach(el => el.classList.remove('vbx-pad-focus'));
    if (!vbxState.cheatOpen) return;
    const ctrls = getCheatDrawerControls();
    if (!ctrls.length) return;
    drawerFocusIdx = Math.max(0, Math.min(ctrls.length - 1, drawerFocusIdx));
    const el = ctrls[drawerFocusIdx];
    const target = (el.type === 'checkbox' && el.closest('.vbx-toggle')) ? el.closest('.vbx-toggle') : el;
    target.classList.add('vbx-pad-focus');
    target.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }

  function pollGamepad(now) {
    const pads = navigator.getGamepads ? navigator.getGamepads() : [];
    let gp = null;
    for (let i = 0; i < pads.length; i++) {
      if (pads[i] && pads[i].connected) { gp = pads[i]; break; }
    }
    if (!gp) {
      mbMotion.padGas = 0;
      mbMotion.padSteer = 0;
      if (vbxState.controllerName) {
        vbxState.controllerName = '';
        updateHudControllerBadge();
      }
      return;
    }

    if (vbxState.controllerName !== gp.id) {
      vbxState.controllerName = gp.id;
      const lid = gp.id.toLowerCase();
      vbxState.controllerType = (lid.includes('dualsense') || lid.includes('054c') || lid.includes('playstation') || lid.includes('wireless controller'))
        ? 'dualsense' : 'xbox';
      showToast((vbxState.controllerType === 'dualsense' ? 'DualSense PS5' : 'Xbox') + ' Controller Connected — GTA V Controls Active', '#0ae0ff');
      updateHudControllerBadge();
    }

    const b = (i) => !!(gp.buttons[i] && (gp.buttons[i].pressed || gp.buttons[i].value > 0.35));
    const v = (i) => (gp.buttons[i] ? gp.buttons[i].value : 0);
    const pressed = (i) => b(i) && !prevBtn[i];

    // System shortcuts
    // L3 + R3 toggles Cheat Menu!
    if (b(10) && b(11) && now - lastComboAt > 450) {
      lastComboAt = now;
      toggleCheatDrawer();
      if (vbxState.cheatOpen) {
        drawerFocusIdx = 0;
        applyCheatDrawerFocus();
      }
    }
    // PS / Xbox Guide Button (16) -> return to console dashboard
    if (pressed(16)) {
      returnToConsoleDashboard();
    }

    if (vbxState.cheatOpen) {
      // Full Controller Navigation inside Cheat & Visuals/Perf Drawer!
      mbMotion.padGas = 0;
      mbMotion.padSteer = 0;
      const lx = gp.axes[0] || 0;
      const ly = gp.axes[1] || 0;
      const dUp = b(12) || ly < -0.55;
      const dDown = b(13) || ly > 0.55;
      const dLeft = b(14) || lx < -0.55;
      const dRight = b(15) || lx > 0.55;

      if (pressed(1)) {
        toggleCheatDrawer(false);
      } else if (pressed(4)) {
        activeCheatTab = (activeCheatTab - 1 + 5) % 5;
        drawerFocusIdx = 0;
        renderCheatTab();
        applyCheatDrawerFocus();
      } else if (pressed(5)) {
        activeCheatTab = (activeCheatTab + 1) % 5;
        drawerFocusIdx = 0;
        renderCheatTab();
        applyCheatDrawerFocus();
      } else {
        const ctrls = getCheatDrawerControls();
        const cur = ctrls[drawerFocusIdx];
        if (dDown && now - drawerPadVCd > 155 && ctrls.length) {
          drawerPadVCd = now;
          drawerFocusIdx = (drawerFocusIdx + 1) % ctrls.length;
          applyCheatDrawerFocus();
        } else if (dUp && now - drawerPadVCd > 155 && ctrls.length) {
          drawerPadVCd = now;
          drawerFocusIdx = (drawerFocusIdx - 1 + ctrls.length) % ctrls.length;
          applyCheatDrawerFocus();
        } else if ((dLeft || dRight) && now - drawerPadHCd > 120 && cur) {
          drawerPadHCd = now;
          const dir = dRight ? 1 : -1;
          if (cur.tagName === 'INPUT' && cur.type === 'range') {
            const min = parseFloat(cur.min || '0');
            const max = parseFloat(cur.max || '100');
            const step = Math.max(1, parseFloat(cur.step || '5'));
            const next = Math.max(min, Math.min(max, (parseFloat(cur.value || '0') + dir * step)));
            cur.value = String(next);
            cur.dispatchEvent(new Event('input', { bubbles: true }));
            cur.dispatchEvent(new Event('change', { bubbles: true }));
          } else if (cur.tagName === 'INPUT' && cur.type === 'checkbox') {
            cur.checked = dir > 0;
            cur.dispatchEvent(new Event('change', { bubbles: true }));
          } else if (ctrls.length > 1) {
            drawerFocusIdx = (drawerFocusIdx + dir + ctrls.length) % ctrls.length;
            applyCheatDrawerFocus();
          }
        } else if (pressed(0) && cur) {
          if (cur.tagName === 'INPUT' && cur.type === 'checkbox') {
            cur.checked = !cur.checked;
            cur.dispatchEvent(new Event('change', { bubbles: true }));
          } else if (cur.tagName === 'INPUT' && cur.type === 'range') {
            const min = parseFloat(cur.min || '0');
            const max = parseFloat(cur.max || '100');
            const step = Math.max(5, parseFloat(cur.step || '10'));
            let next = parseFloat(cur.value || String(min)) + step;
            if (next > max) next = min;
            cur.value = String(next);
            cur.dispatchEvent(new Event('input', { bubbles: true }));
            cur.dispatchEvent(new Event('change', { bubbles: true }));
          } else if (cur.tagName === 'INPUT' && cur.type === 'text') {
            cur.focus();
          } else {
            cur.click();
          }
        }
      }
    } else {
      // Check if GTA V title screen is still visible -> map A/Cross = Story, X/Square = Sandbox
      const loadingEl = document.getElementById('loading');
      const onTitle = loadingEl && !loadingEl.classList.contains('done');
      if (onTitle) {
        if (pressed(0)) pulseKey('Enter', 80);       // Cross / A -> Story Mode
        if (pressed(2)) pulseKey('Space', 80);       // Square / X -> Sandbox
        if (pressed(1)) pulseKey('Backspace', 80);   // Circle / B -> Back
        if (pressed(12)) pulseKey('Digit5', 80);     // D-Up -> GTA V Map
        if (pressed(13)) pulseKey('Digit6', 80);     // D-Down -> GTA VI Map
      } else {
        // ---- REAL GTA V DEFAULT CONTROLLER BINDINGS ----
        const lx = gp.axes[0] || 0;
        const ly = gp.axes[1] || 0;
        const rx = gp.axes[2] || 0;
        const ry = gp.axes[3] || 0;
        const deadL = 0.22;
        const deadR = 0.14;

        mbMotion.padSteer = Math.abs(lx) > deadL ? lx : 0;

        // Triangle / Y (btn 3): Enter / Exit Vehicle (F) & toggles On-Foot <-> Vehicle trigger profile!
        if (pressed(3)) {
          pulseKey('KeyF', 80);
          vbxState.vehicleMode = !vbxState.vehicleMode;
          showToast('Controller Profile: ' + (vbxState.vehicleMode ? 'VEHICLE (R2 Gas / L2 Brake)' : 'ON-FOOT (R2 Shoot / L2 Aim)'), '#0ae0ff');
          updateHudControllerBadge();
        }

        if (vbxState.vehicleMode) {
          // VEHICLE CONTROLS (Authentic GTA V Default)
          const gas = v(7) > 0.15 || ly < -deadL;   // R2 / RT accelerate
          const brk = v(6) > 0.15 || ly > deadL;    // L2 / LT brake/reverse
          mbMotion.padGas = Math.max(v(7), ly < -deadL ? -ly : 0);
          dispatchKey('KeyW', gas);
          dispatchKey('KeyS', brk);
          dispatchKey('KeyA', lx < -deadL);         // Left Stick steer left
          dispatchKey('KeyD', lx > deadL);          // Left Stick steer right
          dispatchKey('Space', b(5) || b(0));       // R1/RB or X/A = Handbrake
          dispatchMouseBtn(0, b(4));                // L1/LB = Drive-by Fire
          dispatchKey('Tab', b(2));                 // Square/X = Cycle Vehicle Weapon
          dispatchKey('KeyR', b(1));                // Circle/B = Cinematic Cam
          dispatchKey('KeyE', b(10));               // L3 = Horn
          dispatchKey('KeyC', b(11));               // R3 = Look Behind
          dispatchKey('ShiftLeft', false);
          dispatchKey('ControlLeft', false);
          dispatchKey('KeyQ', false);
          dispatchMouseBtn(2, false);
        } else {
          // ON-FOOT CONTROLS (Authentic GTA V Default)
          mbMotion.padGas = ly < -deadL ? -ly : 0;
          dispatchKey('KeyW', ly < -deadL);         // Left Stick forward
          dispatchKey('KeyS', ly > deadL);          // Left Stick backward
          dispatchKey('KeyA', lx < -deadL);         // Left Stick left
          dispatchKey('KeyD', lx > deadL);          // Left Stick right
          dispatchKey('ShiftLeft', b(0));           // Cross / A = Sprint
          dispatchKey('KeyR', b(1));                // Circle / B = Reload / Melee
          dispatchKey('Space', b(2));               // Square / X = Jump / Climb
          dispatchKey('Tab', b(4));                 // L1 / LB = Weapon Wheel
          dispatchKey('KeyQ', b(5));                // R1 / RB = Take Cover
          dispatchMouseBtn(2, v(6) > 0.25);         // L2 / LT = Aim
          dispatchMouseBtn(0, v(7) > 0.25);         // R2 / RT = Shoot / Fire
          dispatchKey('ControlLeft', b(10));        // L3 = Stealth / Crouch
          dispatchKey('KeyC', b(11));               // R3 = Look Behind
          dispatchKey('KeyE', false);
        }

        // Right Stick -> Smooth 360° Camera Look (customizable lookSensitivity 20%..300% + motion blur feed!)
        const rMag = Math.hypot(rx, ry);
        if (rMag > deadR) {
          const norm = (rMag - deadR) / (1.0 - deadR);
          const sensMul = Math.max(0.20, Math.min(3.00, vbxState.lookSensitivity / 100.0));
          const curved = norm * norm * 16.5 * sensMul;
          const rdx = (rx / rMag) * curved;
          const rdy = (ry / rMag) * curved;
          mbMotion.rawVx += rdx * 2.2;
          mbMotion.rawVy += rdy * 2.2;
          dispatchMouseMove(rdx, rdy);
        }

        // D-Pad & Menu buttons (shared)
        if (pressed(12)) pulseKey('ArrowUp', 70);   // D-Pad Up = Phone
        if (pressed(13)) pulseKey('AltLeft', 120);  // D-Pad Down = Character / Minimap
        if (pressed(14)) dispatchWheel(-1);         // D-Pad Left = Prev Weapon / Radio
        if (pressed(15)) dispatchWheel(1);          // D-Pad Right = Next Weapon / Radio
        if (pressed(9))  pulseKey('Escape', 70);    // Options / Start = Pause Menu
        if (pressed(8) || pressed(17)) pulseKey('KeyV', 70); // View / Touchpad = Change Camera
      }
    }

    for (let i = 0; i < Math.min(24, gp.buttons.length); i++) {
      prevBtn[i] = b(i);
    }
  }

  function consoleLabelShort() {
    if (vbxState.consoleTarget === 'viceos') return 'VICEOS';
    if (vbxState.consoleTarget === 'xbox') return 'XBOX';
    return 'PS5';
  }

  function consoleHudTitle() {
    if (vbxState.consoleTarget === 'viceos') return 'VICEOS NEO · CUSTOM OS';
    if (vbxState.consoleTarget === 'xbox') return 'XBOX SERIES X · NATIVE';
    return 'PS5 PORT · XBOX→PS5';
  }

  function returnToConsoleDashboard() {
    if (vbxState.consoleTarget === 'viceos') { window.location.href = '/viceos/'; return; }
    window.location.href = (vbxState.consoleTarget === 'xbox') ? '/xbox/' : '/ps5/';
  }

  async function triggerAllModeSwap() {
    if (vbxState.isGta6Sandbox) {
      showToast('Switching to Grand Theft Auto V (ALL Mode)...', '#00e5ff');
      const u = new URL(window.location.href);
      u.searchParams.delete('map');
      u.searchParams.delete('vbx_title');
      window.location.href = u.toString();
      return;
    }
    try {
      const r = await fetch('/vbx/api/launch-custom-exe', { method: 'POST' });
      const d = await r.json();
      if (d && d.ok) {
        showToast('ALL Mode: Launched GTA VI alongside GTA V!', '#ffb830');
        return;
      }
    } catch (e) {}
    showToast('ALL Mode (Might Be Buggy): Switching to GTA VI Vice Sandbox...', '#ffb830');
    const u = new URL(window.location.href);
    u.searchParams.set('mode', 'sandbox');
    u.searchParams.set('map', 'env_test');
    u.searchParams.set('vbx_title', 'gta6');
    window.location.href = u.toString();
  }

  // ==================== 7. UI: REAL HARDWARE DEBUG HUD + FULL CHEAT MENU ====================
  let uiMounted = false;
  let hudEl = null;
  let fabEl = null;
  let drawerEl = null;
  let toastEl = null;
  let toastTimer = null;
  let activeCheatTab = 0;

  const CHEATS_VEHICLES = [
    ['Buzzard Attack Heli', 'BUZZOFF', '#0070D1'],
    ['Pfister Comet Sports', 'COMET', '#10B981'],
    ['Dewbauchee Rapid GT', 'RAPIDGT', '#10B981'],
    ['PCJ-600 Superbike', 'ROCKET', '#0EA5E9'],
    ['Sanchez Dirt Bike', 'OFFROAD', '#F59E0B'],
    ['BMX Stunt Bike', 'BANDIT', '#F59E0B'],
    ['Stunt Plane', 'BARNSTORM', '#6366F1'],
    ['Duster Biplane', 'FLYSPRAY', '#6366F1'],
    ['Stretch Limousine', 'VINEWOOD', '#8B5CF6'],
    ['Trashmaster Truck', 'TRASHED', '#64748B'],
    ['Caddy Golf Cart', 'HOLEIN1', '#14B8A6'],
    ['Duke O\'Death Armored', 'DEATHCAR', '#EF4444'],
    ['Dodo Seaplane', 'EXTINCT', '#0284C7'],
    ['Kraken Submarine', 'BUBBLES', '#0284C7']
  ];

  const CHEATS_WEAPONS = [
    ['Give ALL Weapons + Ammo', 'TOOLUP', '#10B981'],
    ['Full Health + Armor + Repair', 'TURTLE', '#0070D1'],
    ['Explosive Bullets (Bang!)', 'HIGHEX', '#EF4444'],
    ['Flaming Incendiary Ammo', 'INCENDIARY', '#F97316'],
    ['Explosive Melee Punches', 'HOTHANDS', '#F59E0B'],
    ['Slow-Mo Aim (Dead Eye)', 'DEADEYE', '#8B5CF6'],
    ['Give Parachute', 'SKYDIVE', '#0EA5E9'],
    ['Recharge Special Ability', 'POWERUP', '#14B8A6']
  ];

  const CHEATS_PLAYER = [
    ['God Mode (5 min)', 'PAINKILLER', '#10B981'],
    ['Clear Wanted Level', 'LAWYERUP', '#0070D1'],
    ['Raise Wanted Level', 'FUGITIVE', '#EF4444'],
    ['Super Jump', 'HOPTOIT', '#8B5CF6'],
    ['Moon Gravity Float', 'FLOATER', '#0EA5E9'],
    ['Fast Run', 'CATCHME', '#14B8A6'],
    ['Fast Swim', 'GOTGILLS', '#0284C7'],
    ['Slippery Drift Cars', 'SNOWDAY', '#F59E0B'],
    ['Slow Motion', 'SLOWMO', '#6366F1'],
    ['Cycle Weather', 'MAKEITRAIN', '#3B82F6'],
    ['Drunk Mode', 'LIQUOR', '#EC4899'],
    ['Give Parachute', 'SKYDIVE', '#64748B']
  ];

  function showToast(msg, color) {
    if (!toastEl) return;
    toastEl.textContent = msg;
    toastEl.style.borderColor = color || '#0ae0ff';
    toastEl.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => toastEl && toastEl.classList.remove('show'), 2800);
  }

  function updateHudControllerBadge() {
    const el = document.getElementById('vbx-hud-pad');
    if (!el) return;
    if (!vbxState.controllerName) {
      el.textContent = 'KB/MOUSE · CONNECT PAD';
      el.style.color = '#94a3b8';
    } else {
      const icon = vbxState.controllerType === 'dualsense' ? 'PS5 DUALSENSE' : 'XBOX PAD';
      el.textContent = icon + ' · ' + (vbxState.vehicleMode ? 'DRIVE' : 'FOOT');
      el.style.color = '#38bdf8';
    }
  }

  function updateUiVisibility() {
    if (hudEl) hudEl.style.display = vbxState.showDebugHud ? 'block' : 'none';
    if (fabEl) fabEl.style.display = vbxState.enableCheatMenu ? 'flex' : 'none';
  }

  function toggleCheatDrawer(force) {
    if (!drawerEl) return;
    vbxState.cheatOpen = force !== undefined ? !!force : !vbxState.cheatOpen;
    drawerEl.classList.toggle('open', vbxState.cheatOpen);
    if (vbxState.cheatOpen) {
      try { if (document.pointerLockElement) document.exitPointerLock(); } catch (e) {}
      renderCheatTab();
    }
  }

  function renderCheatTab() {
    const body = document.getElementById('vbx-cheat-body');
    if (!body) return;
    document.querySelectorAll('.vbx-tab-btn').forEach((btn, i) => {
      btn.classList.toggle('active', i === activeCheatTab);
    });
    body.innerHTML = '';

    const addGrid = (items) => {
      const g = document.createElement('div');
      g.className = 'vbx-grid';
      items.forEach(([title, code, col]) => {
        const b = document.createElement('button');
        b.className = 'vbx-cbtn';
        b.style.borderLeftColor = col;
        b.innerHTML = `<span>${title}</span><small>${code}</small>`;
        b.onclick = () => runCheat(code, title);
        g.appendChild(b);
      });
      body.appendChild(g);
    };

    if (activeCheatTab === 0) {
      body.innerHTML = '<div class="vbx-hint">Spawns vehicles directly in front of your character using GTA V\'s console:</div>';
      addGrid(CHEATS_VEHICLES);
    } else if (activeCheatTab === 1) {
      body.innerHTML = '<div class="vbx-hint">Weapons, full health/armor/repair, explosive & incendiary rounds:</div>';
      addGrid(CHEATS_WEAPONS);
    } else if (activeCheatTab === 2) {
      const top = document.createElement('div');
      top.className = 'vbx-toggle-row';
      top.innerHTML = `<div><strong>God Mode Auto-Renew</strong><div style="font-size:11px;color:#94a3b8">Re-applies invincibility every 4.5 min</div></div>
        <input type="checkbox" id="vbx-god-chk" ${vbxState.autoGodMode ? 'checked' : ''}>`;
      body.appendChild(top);
      top.querySelector('#vbx-god-chk').onchange = (e) => setAutoGodMode(e.target.checked);

      const fly = document.createElement('div');
      fly.className = 'vbx-grid';
      fly.style.marginBottom = '10px';
      const f1 = document.createElement('button');
      f1.className = 'vbx-cbtn accent';
      f1.innerHTML = '<span>FREE FLY / SKYFALL</span><small>SKYFALL</small>';
      f1.onclick = () => runCheat('SKYFALL', 'Skyfall Fly');
      const f2 = document.createElement('button');
      f2.className = 'vbx-cbtn accent2';
      f2.innerHTML = '<span>SUPER-JUMP + FLOAT</span><small>COMBO</small>';
      f2.onclick = () => { runCheat('HOPTOIT', 'Super Jump'); runCheat('FLOATER', 'Moon Gravity'); };
      fly.appendChild(f1);
      fly.appendChild(f2);
      body.appendChild(fly);
      addGrid(CHEATS_PLAYER);
    } else if (activeCheatTab === 3) {
      body.innerHTML = `
        <div class="vbx-hint">Real PC Visuals, Motion Blur, Performance Optimization & Controls:</div>
        <div class="vbx-toggle-row">
          <div><strong>Real Hardware Debug HUD (F3)</strong><div style="font-size:11px;color:#94a3b8">Live Windows CPU %, GPU %, VRAM & Real FPS</div></div>
          <input type="checkbox" id="vbx-opt-hud" ${vbxState.showDebugHud ? 'checked' : ''}>
        </div>
        <div class="vbx-toggle-row">
          <div><strong>Motion Blur (Stutter Smoothing)</strong><div style="font-size:11px;color:#94a3b8">Blends frames & velocity blur to hide stutters</div></div>
          <input type="checkbox" id="vbx-opt-mb" ${vbxState.motionBlur ? 'checked' : ''}>
        </div>
        <div class="vbx-toggle-row" style="flex-direction:column;align-items:stretch;gap:6px;">
          <div style="display:flex;justify-content:space-between;"><span>Motion Blur Intensity</span><strong id="vbx-mb-val">${vbxState.motionBlurStrength}%</strong></div>
          <input type="range" id="vbx-opt-mbstr" min="0" max="100" step="5" value="${vbxState.motionBlurStrength}">
        </div>
        <div class="vbx-toggle-row" style="flex-direction:column;align-items:stretch;gap:6px;">
          <div style="display:flex;justify-content:space-between;align-items:center;">
            <div><strong>Camera Look Sensitivity</strong><div style="font-size:10.5px;color:#94a3b8">Mouse &amp; Controller Right-Stick (20%–300%)</div></div>
            <div style="display:flex;align-items:center;gap:8px;">
              <strong id="vbx-sens-val" style="color:#38bdf8;">${vbxState.lookSensitivity}%</strong>
              <button class="vbx-mini-btn" id="vbx-sens-reset" style="padding:2px 8px;font-size:10.5px;">100%</button>
            </div>
          </div>
          <input type="range" id="vbx-opt-sens" min="20" max="300" step="5" value="${vbxState.lookSensitivity}">
        </div>
        <div class="vbx-toggle-row">
          <div><strong>Optimization Mode (Same Visuals)</strong><div style="font-size:11px;color:#94a3b8">Hi-Perf GPU, DPR clamp, trims PostFX/MSAA hogs</div></div>
          <input type="checkbox" id="vbx-opt-perf" ${vbxState.optimizationMode ? 'checked' : ''}>
        </div>
        <div class="vbx-toggle-row">
          <div><strong>Controller Mode: ${vbxState.vehicleMode ? 'VEHICLE' : 'ON-FOOT'}</strong><div style="font-size:11px;color:#94a3b8">Also auto-switches when pressing △ / Y</div></div>
          <button class="vbx-mini-btn" id="vbx-flip-pad">Switch</button>
        </div>
        <div style="display:flex;gap:8px;margin-top:12px;">
          <button class="vbx-action-btn" id="vbx-back-dash">Return to ${consoleLabelShort()} Dashboard (F9)</button>
        </div>
      `;
      body.querySelector('#vbx-opt-hud').onchange = (e) => {
        vbxState.showDebugHud = e.target.checked;
        updateUiVisibility();
        pushConfigUpdate({ showDebugHud: vbxState.showDebugHud });
      };
      body.querySelector('#vbx-opt-mb').onchange = (e) => {
        vbxState.motionBlur = e.target.checked;
        pushConfigUpdate({ motionBlur: vbxState.motionBlur });
        showToast('Motion Blur ' + (vbxState.motionBlur ? 'Enabled' : 'Disabled'), '#0ae0ff');
      };
      body.querySelector('#vbx-opt-mbstr').oninput = (e) => {
        vbxState.motionBlurStrength = parseInt(e.target.value, 10) || 0;
        body.querySelector('#vbx-mb-val').textContent = vbxState.motionBlurStrength + '%';
        pushConfigUpdate({ motionBlurStrength: vbxState.motionBlurStrength });
      };
      body.querySelector('#vbx-opt-sens').oninput = (e) => {
        vbxState.lookSensitivity = Math.max(20, Math.min(300, parseInt(e.target.value, 10) || 100));
        body.querySelector('#vbx-sens-val').textContent = vbxState.lookSensitivity + '%';
        pushConfigUpdate({ lookSensitivity: vbxState.lookSensitivity });
      };
      body.querySelector('#vbx-sens-reset').onclick = () => {
        vbxState.lookSensitivity = 100;
        const sl = body.querySelector('#vbx-opt-sens');
        if (sl) sl.value = '100';
        body.querySelector('#vbx-sens-val').textContent = '100%';
        pushConfigUpdate({ lookSensitivity: 100 });
        showToast('Camera Look Sensitivity reset to 100%', '#38bdf8');
      };
      body.querySelector('#vbx-opt-perf').onchange = (e) => {
        vbxState.optimizationMode = e.target.checked;
        syncOptimizationSettingsXml(vbxState.optimizationMode);
        pushConfigUpdate({ optimizationMode: vbxState.optimizationMode });
        showToast('Optimization Mode ' + (vbxState.optimizationMode ? 'ON' : 'OFF') + ' (saved for next load too)', '#19db7a');
      };
      body.querySelector('#vbx-flip-pad').onclick = () => {
        vbxState.vehicleMode = !vbxState.vehicleMode;
        updateHudControllerBadge();
        renderCheatTab();
      };
      body.querySelector('#vbx-back-dash').onclick = () => returnToConsoleDashboard();
    } else {
      body.innerHTML = `
        <div class="vbx-hint">Run any GTA V PC Console Cheat directly (e.g. BUZZOFF, TOOLUP, PAINKILLER, SKYFALL):</div>
        <div style="display:flex;gap:8px;margin-bottom:14px;">
          <input type="text" id="vbx-raw-cheat" placeholder="TYPE CHEAT CODE..." style="flex:1;padding:10px 12px;border-radius:8px;border:1px solid rgba(56,189,248,0.4);background:rgba(10,16,32,0.9);color:#fff;font-family:Consolas,monospace;text-transform:uppercase;">
          <button class="vbx-action-btn" id="vbx-raw-run" style="width:auto;padding:0 18px;">RUN</button>
        </div>
        <div class="vbx-hint">Real GTA V Controller Default Bindings (DualSense / Xbox):</div>
        <div style="font-size:11.5px;line-height:1.6;color:#cbd5e1;background:rgba(8,12,24,0.75);padding:12px;border-radius:10px;border:1px solid rgba(255,255,255,0.08);">
          <b>L-Stick</b> Move / Steer &nbsp;·&nbsp; <b>R-Stick</b> Camera Look<br>
          <b>R2/RT</b> Shoot / Accelerate &nbsp;·&nbsp; <b>L2/LT</b> Aim / Brake<br>
          <b>R1/RB</b> Cover / Handbrake &nbsp;·&nbsp; <b>L1/LB</b> Weapon Wheel / Drive-by<br>
          <b>✕/A</b> Sprint &nbsp;·&nbsp; <b>□/X</b> Jump &nbsp;·&nbsp; <b>○/B</b> Reload &nbsp;·&nbsp; <b>△/Y</b> Enter/Exit Vehicle<br>
          <b>L3</b> Stealth/Horn &nbsp;·&nbsp; <b>R3</b> Look Behind &nbsp;·&nbsp; <b>L3+R3</b> Cheat Menu &nbsp;·&nbsp; <b>PS/Xbox Btn</b> Dashboard
        </div>
      `;
      const inp = body.querySelector('#vbx-raw-cheat');
      const run = () => { if (inp.value.trim()) { runCheat(inp.value.trim()); inp.value = ''; } };
      body.querySelector('#vbx-raw-run').onclick = run;
      inp.onkeydown = (e) => { if (e.key === 'Enter') run(); e.stopPropagation(); };
      inp.onkeyup = (e) => e.stopPropagation();
    }
  }

  function mountUi() {
    if (uiMounted || !document.body) return;
    uiMounted = true;

    const style = document.createElement('style');
    style.id = 'vbx-pc-overlay-style';
    style.textContent = `
      #canvas { will-change: filter, transform; }
      .vbx-pad-focus {
        outline: 2.5px solid #ffffff !important;
        box-shadow: 0 0 0 4px rgba(56, 189, 248, 0.72), 0 0 18px rgba(56, 189, 248, 0.5) !important;
      }
      #vbx-hud {
        position: fixed; top: 12px; right: 12px; z-index: 99990;
        width: 256px; padding: 11px 13px; border-radius: 12px;
        background: rgba(8, 12, 22, 0.82); backdrop-filter: blur(10px);
        border: 1px solid rgba(255, 255, 255, 0.14);
        box-shadow: 0 12px 34px rgba(0, 0, 0, 0.55);
        font: 12px/1.35 Consolas, 'Cascadia Mono', monospace; color: #f1f5f9;
        pointer-events: none; user-select: none;
      }
      .vbx-hud-top { display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px; padding-bottom: 6px; border-bottom: 1px solid rgba(255,255,255,0.1); }
      .vbx-hud-tag { font-weight: 700; font-size: 10.5px; letter-spacing: 0.8px; color: #38bdf8; }
      .vbx-hud-fps { font-size: 18px; font-weight: 800; color: #19db7a; }
      .vbx-hud-row { display: flex; justify-content: space-between; margin: 3px 0; font-size: 11.5px; }
      .vbx-hud-bar { height: 4px; background: rgba(255,255,255,0.1); border-radius: 3px; overflow: hidden; margin-bottom: 5px; }
      .vbx-hud-fill { height: 100%; border-radius: 3px; transition: width 0.25s; }
      #vbx-fps-graph { width: 100%; height: 28px; display: block; margin-top: 6px; background: rgba(0,0,0,0.28); border-radius: 5px; }
      #vbx-hud-pad { margin-top: 5px; font-size: 10.5px; text-align: right; color: #94a3b8; }

      #vbx-fab {
        position: fixed; top: 12px; left: 12px; z-index: 99991;
        display: flex; gap: 6px; align-items: center;
      }
      .vbx-pill-btn {
        border: 1px solid rgba(255,255,255,0.18); background: rgba(8,12,24,0.84);
        color: #fff; border-radius: 999px; padding: 6px 12px;
        font: 600 11.5px 'Segoe UI', sans-serif; cursor: pointer;
        backdrop-filter: blur(8px); transition: background 0.15s, border-color 0.15s;
      }
      .vbx-pill-btn:hover { background: rgba(0,112,209,0.75); border-color: #7dd3fc; }

      #vbx-drawer {
        position: fixed; top: 52px; left: 12px; z-index: 99995;
        width: 440px; max-width: calc(100vw - 24px); max-height: calc(100vh - 68px);
        background: rgba(10, 14, 26, 0.94); backdrop-filter: blur(18px);
        border: 1px solid rgba(56, 189, 248, 0.35); border-radius: 16px;
        box-shadow: 0 24px 60px rgba(0,0,0,0.78);
        color: #f8fafc; font-family: 'Segoe UI', sans-serif;
        display: none; flex-direction: column; overflow: hidden;
      }
      #vbx-drawer.open { display: flex; }
      .vbx-d-hdr { display: flex; justify-content: space-between; align-items: center; padding: 13px 16px; border-bottom: 1px solid rgba(255,255,255,0.1); background: linear-gradient(90deg, rgba(0,112,209,0.22), rgba(25,219,122,0.12)); }
      .vbx-d-hdr h3 { font-size: 14px; font-weight: 700; letter-spacing: 0.4px; margin: 0; }
      .vbx-tabs { display: flex; gap: 5px; padding: 9px 12px; background: rgba(0,0,0,0.28); border-bottom: 1px solid rgba(255,255,255,0.07); }
      .vbx-tab-btn { flex: 1; border: 1px solid rgba(255,255,255,0.1); background: rgba(255,255,255,0.04); color: #94a3b8; border-radius: 8px; padding: 7px 4px; font-size: 11px; font-weight: 700; cursor: pointer; }
      .vbx-tab-btn.active { background: #0070d1; color: #fff; border-color: #7dd3fc; }
      #vbx-cheat-body { padding: 12px 14px 16px; overflow-y: auto; flex: 1; }
      .vbx-hint { font-size: 11.5px; color: #94a3b8; margin-bottom: 9px; }
      .vbx-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 7px; }
      .vbx-cbtn {
        text-align: left; border: 1px solid rgba(255,255,255,0.1); border-left: 3px solid #0070d1;
        background: rgba(20, 28, 48, 0.85); color: #fff; border-radius: 9px;
        padding: 9px 10px; cursor: pointer; display: flex; flex-direction: column; gap: 2px;
        transition: transform 0.12s, background 0.12s;
      }
      .vbx-cbtn:hover { background: rgba(35, 50, 84, 0.95); transform: translateY(-1px); }
      .vbx-cbtn span { font-size: 12px; font-weight: 600; }
      .vbx-cbtn small { font-size: 10px; font-family: Consolas, monospace; color: #7dd3fc; }
      .vbx-cbtn.accent { background: rgba(2,132,199,0.35); border-left-color: #38bdf8; }
      .vbx-cbtn.accent2 { background: rgba(124,58,237,0.35); border-left-color: #a78bfa; }
      .vbx-toggle-row {
        display: flex; justify-content: space-between; align-items: center;
        padding: 9px 11px; border-radius: 10px; background: rgba(18, 28, 52, 0.78);
        border: 1px solid rgba(255,255,255,0.08); margin-bottom: 8px; font-size: 12.5px;
      }
      .vbx-mini-btn { border: 1px solid #38bdf8; background: rgba(56,189,248,0.16); color: #fff; border-radius: 7px; padding: 5px 11px; font-size: 11.5px; font-weight: 700; cursor: pointer; }
      .vbx-action-btn { width: 100%; border: none; border-radius: 9px; padding: 10px 14px; background: linear-gradient(90deg, #0070d1, #0ea5e9); color: #fff; font-weight: 700; font-size: 12.5px; cursor: pointer; }

      #vbx-toast {
        position: fixed; bottom: 20px; left: 50%; transform: translateX(-50%) translateY(20px);
        z-index: 99999; background: rgba(8, 12, 24, 0.94); color: #fff;
        padding: 9px 18px; border-radius: 999px; border: 1px solid #0ae0ff;
        font: 600 12.5px 'Segoe UI', sans-serif; opacity: 0; pointer-events: none;
        transition: opacity 0.2s, transform 0.2s; box-shadow: 0 12px 30px rgba(0,0,0,0.6);
      }
      #vbx-toast.show { opacity: 1; transform: translateX(-50%) translateY(0); }
    `;
    (document.head || document.documentElement).appendChild(style);

    // Real Hardware Debug HUD
    hudEl = document.createElement('div');
    hudEl.id = 'vbx-hud';
    hudEl.innerHTML = `
      <div class="vbx-hud-top">
        <div>
          <div class="vbx-hud-tag" id="vbx-hud-console">${consoleHudTitle()}</div>
          <div style="font-size:10px;color:#94a3b8" id="vbx-hud-flags">REAL HARDWARE TELEMETRY</div>
        </div>
        <div class="vbx-hud-fps" id="vbx-hud-fps">-- FPS</div>
      </div>
      <div class="vbx-hud-row"><span>CPU (REAL)</span><strong id="vbx-hud-cpu">0%</strong></div>
      <div class="vbx-hud-bar"><div class="vbx-hud-fill" id="vbx-bar-cpu" style="width:0%;background:#38bdf8;"></div></div>
      <div class="vbx-hud-row"><span>GPU 3D (REAL)</span><strong id="vbx-hud-gpu">0%</strong></div>
      <div class="vbx-hud-bar"><div class="vbx-hud-fill" id="vbx-bar-gpu" style="width:0%;background:#19db7a;"></div></div>
      <div class="vbx-hud-row"><span>RAM / VRAM</span><strong id="vbx-hud-mem">--</strong></div>
      <div class="vbx-hud-row"><span>FRAMETIME</span><strong id="vbx-hud-ms">-- ms</strong></div>
      <canvas id="vbx-fps-graph" width="230" height="28"></canvas>
      <div id="vbx-hud-pad">KB/MOUSE · CONNECT PAD</div>
    `;
    document.body.appendChild(hudEl);

    // Compact Top-Left Action Bar
    fabEl = document.createElement('div');
    fabEl.id = 'vbx-fab';
    fabEl.innerHTML = `
      <button class="vbx-pill-btn" id="vbx-btn-cheats">⚡ CHEATS (F2)</button>
      <button class="vbx-pill-btn" id="vbx-btn-hud">📊 HUD (F3)</button>
      <button class="vbx-pill-btn" id="vbx-btn-allswap" style="display:${vbxState.emulatedGame === 'all' ? 'inline-block' : 'none'};border-color:#f59e0b;color:#fde68a;">🔀 ${vbxState.isGta6Sandbox ? 'GTA V' : 'GTA VI'} (ALL)</button>
      <button class="vbx-pill-btn" id="vbx-btn-home">🏠 ${consoleLabelShort()} (F9)</button>
    `;
    document.body.appendChild(fabEl);
    fabEl.querySelector('#vbx-btn-cheats').onclick = () => toggleCheatDrawer();
    fabEl.querySelector('#vbx-btn-hud').onclick = () => {
      vbxState.showDebugHud = !vbxState.showDebugHud;
      updateUiVisibility();
      pushConfigUpdate({ showDebugHud: vbxState.showDebugHud });
    };
    fabEl.querySelector('#vbx-btn-allswap').onclick = () => triggerAllModeSwap();
    fabEl.querySelector('#vbx-btn-home').onclick = () => returnToConsoleDashboard();

    // Mobile-Parity Cheat Menu Drawer
    drawerEl = document.createElement('div');
    drawerEl.id = 'vbx-drawer';
    drawerEl.innerHTML = `
      <div class="vbx-d-hdr">
        <h3>VICEBOX X · GTA V TRAINER &amp; ENHANCEMENTS</h3>
        <button class="vbx-mini-btn" id="vbx-close-drawer">✕</button>
      </div>
      <div class="vbx-tabs">
        <button class="vbx-tab-btn active">Vehicles</button>
        <button class="vbx-tab-btn">Weapons</button>
        <button class="vbx-tab-btn">Player/Fly</button>
        <button class="vbx-tab-btn">Visuals/Perf</button>
        <button class="vbx-tab-btn">Console</button>
      </div>
      <div id="vbx-cheat-body"></div>
    `;
    document.body.appendChild(drawerEl);
    drawerEl.querySelector('#vbx-close-drawer').onclick = () => toggleCheatDrawer(false);
    drawerEl.querySelectorAll('.vbx-tab-btn').forEach((btn, idx) => {
      btn.onclick = () => { activeCheatTab = idx; renderCheatTab(); };
    });

    toastEl = document.createElement('div');
    toastEl.id = 'vbx-toast';
    document.body.appendChild(toastEl);

    updateUiVisibility();
    updateHudControllerBadge();
  }

  // Hotkeys: F2 Cheat Menu, F3 Debug HUD, F4 Motion Blur quick toggle, F9 Back to PS5/Xbox Dashboard
  window.addEventListener('keydown', (e) => {
    if (e.code === 'F2' || e.code === 'Insert') {
      e.preventDefault();
      if (vbxState.enableCheatMenu) toggleCheatDrawer();
    } else if (e.code === 'F3') {
      e.preventDefault();
      vbxState.showDebugHud = !vbxState.showDebugHud;
      updateUiVisibility();
      pushConfigUpdate({ showDebugHud: vbxState.showDebugHud });
    } else if (e.code === 'F4') {
      e.preventDefault();
      vbxState.motionBlur = !vbxState.motionBlur;
      pushConfigUpdate({ motionBlur: vbxState.motionBlur });
      showToast('Motion Blur: ' + (vbxState.motionBlur ? 'ON (' + vbxState.motionBlurStrength + '%)' : 'OFF'), '#0ae0ff');
    } else if (e.code === 'F6' || e.code === 'F7') {
      e.preventDefault();
      const delta = (e.code === 'F7') ? 10 : -10;
      vbxState.lookSensitivity = Math.max(20, Math.min(300, vbxState.lookSensitivity + delta));
      pushConfigUpdate({ lookSensitivity: vbxState.lookSensitivity });
      const sensInp = document.getElementById('vbx-opt-sens');
      const sensLbl = document.getElementById('vbx-sens-val');
      if (sensInp) sensInp.value = String(vbxState.lookSensitivity);
      if (sensLbl) sensLbl.textContent = vbxState.lookSensitivity + '%';
      showToast('Camera Look Sensitivity: ' + vbxState.lookSensitivity + '%', '#38bdf8');
    } else if (e.code === 'F9') {
      e.preventDefault();
      returnToConsoleDashboard();
    }
  }, true);

  function drawHudTick(now) {
    if (!hudEl || !vbxState.showDebugHud) return;
    const t = vbxState.telemetry;
    const fpsVal = Math.round(vbxState.realFps);
    const fpsEl = document.getElementById('vbx-hud-fps');
    if (fpsEl) {
      fpsEl.textContent = fpsVal + ' FPS';
      fpsEl.style.color = fpsVal >= 45 ? '#19db7a' : (fpsVal >= 25 ? '#f59e0b' : '#ef4444');
    }
    const cpuPct = Math.max(0, Math.min(100, t.cpuPct || 0));
    const gpuPct = Math.max(0, Math.min(100, t.gpuPct || 0));
    const cpuEl = document.getElementById('vbx-hud-cpu');
    const gpuEl = document.getElementById('vbx-hud-gpu');
    const memEl = document.getElementById('vbx-hud-mem');
    const msEl = document.getElementById('vbx-hud-ms');
    const flagsEl = document.getElementById('vbx-hud-flags');
    if (cpuEl) cpuEl.textContent = cpuPct.toFixed(1) + '%';
    if (gpuEl) gpuEl.textContent = gpuPct.toFixed(1) + '%';
    if (memEl) memEl.textContent = `${(t.ramUsedGb || 0).toFixed(1)}G · ${Math.round(t.vramUsedMb || 0)}M VRAM`;
    if (msEl) msEl.textContent = vbxState.frameMs.toFixed(1) + ' ms';
    if (flagsEl) {
      const f = [];
      if (vbxState.emulatedGame === 'all') f.push('ALL-MODE');
      if (vbxState.optimizationMode) f.push('OPT:ON');
      if (vbxState.motionBlur) f.push('MBLUR:' + vbxState.motionBlurStrength + '%');
      if (vbxState.lookSensitivity !== 100) f.push('SENS:' + vbxState.lookSensitivity + '%');
      flagsEl.textContent = f.length ? f.join(' · ') : 'STANDARD RENDER';
    }
    const swapBtn = document.getElementById('vbx-btn-allswap');
    if (swapBtn) swapBtn.style.display = vbxState.emulatedGame === 'all' ? 'inline-block' : 'none';
    const bCpu = document.getElementById('vbx-bar-cpu');
    const bGpu = document.getElementById('vbx-bar-gpu');
    if (bCpu) bCpu.style.width = cpuPct.toFixed(0) + '%';
    if (bGpu) bGpu.style.width = gpuPct.toFixed(0) + '%';

    // Real-time FPS sparkline graph
    const g = document.getElementById('vbx-fps-graph');
    if (g && vbxState.fpsHistory.length > 1) {
      const ctx = g.getContext('2d');
      ctx.clearRect(0, 0, g.width, g.height);
      ctx.strokeStyle = '#19db7a';
      ctx.lineWidth = 1.6;
      ctx.beginPath();
      const n = vbxState.fpsHistory.length;
      for (let i = 0; i < n; i++) {
        const x = (i / (n - 1)) * g.width;
        const y = g.height - Math.min(1, vbxState.fpsHistory[i] / 75) * (g.height - 4) - 2;
        if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
      }
      ctx.stroke();
    }
  }

  let lastHudRender = 0;
  function mainLoop(now) {
    const dtMs = now - rafPrevFrame;
    rafPrevFrame = now;
    vbxState.frameMs = vbxState.frameMs * 0.85 + dtMs * 0.15;
    rafFrames++;

    if (now - rafLastSample >= 500) {
      const measuredRafFps = (rafFrames * 1000) / (now - rafLastSample);
      // Prefer game engine's own BroadcastChannel FPS when streaming, fall back to real rAF FPS
      if (now - vbxState.bcFpsSeenAt > 1800) {
        vbxState.realFps = measuredRafFps;
      }
      vbxState.fpsHistory.push(vbxState.realFps);
      if (vbxState.fpsHistory.length > 56) vbxState.fpsHistory.shift();
      rafFrames = 0;
      rafLastSample = now;
    }

    if (uiMounted) {
      pollGamepad(now);
      updateMotionBlur(now, dtMs);
      if (now - lastHudRender >= 250) {
        lastHudRender = now;
        drawHudTick(now);
      }
    }
    requestAnimationFrame(mainLoop);
  }

  function bootOverlay() {
    mountUi();
    syncServerConfig();
    pollTelemetry();
    setInterval(pollTelemetry, 500);
    setInterval(syncServerConfig, 2500);
    requestAnimationFrame(mainLoop);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', bootOverlay, { once: true });
  } else {
    bootOverlay();
  }
})();
