(function () {
  'use strict';
  if (window.__ps5ChromeOverlayInstalled) return;
  window.__ps5ChromeOverlayInstalled = true;

  // =========================================================================
  // 1. VIRTUAL POINTER LOCK + REAL KEYBOARD/MOUSE/CHEAT ENGINE
  // =========================================================================
  var virtualLockActive = false;
  var activeKeys = new Set();
  var activeButtons = 0;
  var cheatQueue = [];
  var cheatBusy = false;
  var autoGodTimer = null;

  var KEY_INFO = {
    KeyW: { key: 'w', code: 'KeyW', kc: 87 },
    KeyA: { key: 'a', code: 'KeyA', kc: 65 },
    KeyS: { key: 's', code: 'KeyS', kc: 83 },
    KeyD: { key: 'd', code: 'KeyD', kc: 68 },
    KeyE: { key: 'e', code: 'KeyE', kc: 69 },
    KeyF: { key: 'f', code: 'KeyF', kc: 70 },
    KeyR: { key: 'r', code: 'KeyR', kc: 82 },
    KeyQ: { key: 'q', code: 'KeyQ', kc: 81 },
    KeyV: { key: 'v', code: 'KeyV', kc: 86 },
    KeyC: { key: 'c', code: 'KeyC', kc: 67 },
    KeyH: { key: 'h', code: 'KeyH', kc: 72 },
    KeyG: { key: 'g', code: 'KeyG', kc: 71 },
    KeyM: { key: 'm', code: 'KeyM', kc: 77 },
    KeyP: { key: 'p', code: 'KeyP', kc: 80 },
    KeyI: { key: 'i', code: 'KeyI', kc: 73 },
    KeyJ: { key: 'j', code: 'KeyJ', kc: 74 },
    KeyK: { key: 'k', code: 'KeyK', kc: 75 },
    KeyL: { key: 'l', code: 'KeyL', kc: 76 },
    KeyU: { key: 'u', code: 'KeyU', kc: 85 },
    KeyO: { key: 'o', code: 'KeyO', kc: 79 },
    Space: { key: ' ', code: 'Space', kc: 32 },
    ShiftLeft: { key: 'Shift', code: 'ShiftLeft', kc: 16 },
    ControlLeft: { key: 'Control', code: 'ControlLeft', kc: 17 },
    Tab: { key: 'Tab', code: 'Tab', kc: 9 },
    Escape: { key: 'Escape', code: 'Escape', kc: 27 },
    Enter: { key: 'Enter', code: 'Enter', kc: 13 },
    CapsLock: { key: 'CapsLock', code: 'CapsLock', kc: 20 },
    ArrowUp: { key: 'ArrowUp', code: 'ArrowUp', kc: 38 },
    ArrowDown: { key: 'ArrowDown', code: 'ArrowDown', kc: 40 },
    ArrowLeft: { key: 'ArrowLeft', code: 'ArrowLeft', kc: 37 },
    ArrowRight: { key: 'ArrowRight', code: 'ArrowRight', kc: 39 },
    Backquote: { key: '`', code: 'Backquote', kc: 192 }
  };

  function getCanvas() {
    return document.getElementById('canvas') || document.querySelector('canvas');
  }

  function installVirtualPointerLock() {
    try {
      var origReq = Element.prototype.requestPointerLock;
      Element.prototype.requestPointerLock = function () {
        var el = this;
        try {
          if (origReq) {
            var r = origReq.apply(el, arguments);
            if (r && typeof r.catch === 'function') r.catch(function () {});
          }
        } catch (e) {}
        if (!virtualLockActive) {
          virtualLockActive = true;
          document.dispatchEvent(new Event('pointerlockchange'));
        }
        return Promise.resolve();
      };
      Object.defineProperty(document, 'pointerLockElement', {
        configurable: true,
        get: function () { return virtualLockActive ? getCanvas() : null; }
      });
      var origExit = document.exitPointerLock;
      document.exitPointerLock = function () {
        try { if (origExit) origExit.call(document); } catch (e) {}
        if (virtualLockActive) {
          virtualLockActive = false;
          document.dispatchEvent(new Event('pointerlockchange'));
        }
      };
    } catch (e) {}
  }
  installVirtualPointerLock();

  function ensureLock() {
    var c = getCanvas();
    if (!c) return false;
    if (!virtualLockActive) {
      virtualLockActive = true;
      document.dispatchEvent(new Event('pointerlockchange'));
    }
    return true;
  }

  function makeKeyEvent(type, info) {
    var ev = new KeyboardEvent(type, {
      key: info.key, code: info.code, keyCode: info.kc, which: info.kc,
      bubbles: true, cancelable: true, composed: true
    });
    try {
      Object.defineProperty(ev, 'keyCode', { get: function () { return info.kc; } });
      Object.defineProperty(ev, 'which', { get: function () { return info.kc; } });
    } catch (e) {}
    return ev;
  }

  function setKey(code, pressed) {
    var info = KEY_INFO[code];
    if (!info) return;
    if (pressed) {
      if (activeKeys.has(code)) return;
      activeKeys.add(code);
      window.dispatchEvent(makeKeyEvent('keydown', info));
    } else {
      if (!activeKeys.has(code)) return;
      activeKeys.delete(code);
      window.dispatchEvent(makeKeyEvent('keyup', info));
    }
  }

  function tapKey(code, ms) {
    setKey(code, true);
    setTimeout(function () { setKey(code, false); }, ms || 75);
  }

  function moveMouse(dx, dy) {
    var c = getCanvas();
    if (!c || (!dx && !dy)) return;
    ensureLock();
    var rect = c.getBoundingClientRect();
    var cx = rect.left + rect.width * 0.5;
    var cy = rect.top + rect.height * 0.5;
    var ev = new MouseEvent('mousemove', {
      bubbles: true, cancelable: true, clientX: cx, clientY: cy, buttons: activeButtons
    });
    try {
      Object.defineProperty(ev, 'movementX', { get: function () { return dx; } });
      Object.defineProperty(ev, 'movementY', { get: function () { return dy; } });
    } catch (e) {}
    window.dispatchEvent(ev);
  }

  function setMouseBtn(button, pressed) {
    var c = getCanvas();
    if (!c) return;
    ensureLock();
    var mask = button === 0 ? 1 : (button === 2 ? 2 : 4);
    var rect = c.getBoundingClientRect();
    var cx = rect.left + rect.width * 0.5;
    var cy = rect.top + rect.height * 0.5;
    if (pressed) {
      if (activeButtons & mask) return;
      activeButtons |= mask;
      c.dispatchEvent(new MouseEvent('mousedown', {
        bubbles: true, cancelable: true, button: button, buttons: activeButtons, clientX: cx, clientY: cy
      }));
    } else {
      if (!(activeButtons & mask)) return;
      activeButtons &= ~mask;
      window.dispatchEvent(new MouseEvent('mouseup', {
        bubbles: true, cancelable: true, button: button, buttons: activeButtons, clientX: cx, clientY: cy
      }));
    }
  }

  function wheel(deltaY) {
    window.dispatchEvent(new WheelEvent('wheel', {
      bubbles: true, cancelable: true, deltaY: deltaY, deltaMode: 0
    }));
  }

  function releaseAll() {
    Array.from(activeKeys).forEach(function (k) { setKey(k, false); });
    if (activeButtons & 1) setMouseBtn(0, false);
    if (activeButtons & 2) setMouseBtn(2, false);
  }

  function charInfo(ch) {
    var u = ch.toUpperCase();
    var code = u.charCodeAt(0);
    if (code >= 65 && code <= 90) return { key: ch.toLowerCase(), code: 'Key' + u, kc: code };
    if (code >= 48 && code <= 57) return { key: ch, code: 'Digit' + ch, kc: code };
    if (ch === ' ') return { key: ' ', code: 'Space', kc: 32 };
    return null;
  }

  function processCheatQueue() {
    if (cheatBusy || !cheatQueue.length) return;
    cheatBusy = true;
    var codeStr = String(cheatQueue.shift() || '').trim();
    if (!codeStr) { cheatBusy = false; processCheatQueue(); return; }
    ensureLock();
    var seq = [KEY_INFO.Backquote];
    for (var i = 0; i < codeStr.length; i++) {
      var ci = charInfo(codeStr[i]);
      if (ci) seq.push(ci);
    }
    seq.push(KEY_INFO.Enter);
    var t = 0;
    seq.forEach(function (info, idx) {
      var gap = idx === 0 ? 110 : 38;
      setTimeout(function () {
        window.dispatchEvent(makeKeyEvent('keydown', info));
        setTimeout(function () { window.dispatchEvent(makeKeyEvent('keyup', info)); }, 22);
      }, t);
      t += gap;
    });
    setTimeout(function () {
      cheatBusy = false;
      processCheatQueue();
    }, t + 140);
  }

  function runCheat(code) {
    cheatQueue.push(code);
    processCheatQueue();
    toast('Cheat: ' + code);
  }

  // =========================================================================
  // 2. INDEXEDDB /userdata/settings.xml GRAPHICS & RENDER-DISTANCE PATCHER
  // =========================================================================
  function syncSettingsXml(s) {
    if (!s || !window.indexedDB) return;
    try {
      var req = indexedDB.open('gta5-userdata');
      req.onsuccess = function () {
        var db = req.result;
        var storeName = db.objectStoreNames.contains('FILE_DATA')
          ? 'FILE_DATA'
          : (db.objectStoreNames.length ? db.objectStoreNames[0] : null);
        if (!storeName) { db.close(); return; }
        var tx = db.transaction(storeName, 'readwrite');
        var store = tx.objectStore(storeName);
        var curReq = store.openCursor();
        curReq.onsuccess = function (e) {
          var cursor = e.target.result;
          if (!cursor) { db.close(); return; }
          var key = String(cursor.key || '');
          if (key.toLowerCase().indexOf('settings.xml') >= 0 && cursor.value && cursor.value.contents) {
            try {
              var xml = new TextDecoder().decode(cursor.value.contents);
              var rep = function (tag, val) {
                var r = new RegExp('(<' + tag + '\\s+value=")[^"]*(")', 'i');
                return r.test(xml) ? xml.replace(r, '$1' + val + '$2') : xml;
              };
              if (typeof s.shadowQuality === 'number') xml = rep('ShadowQuality', s.shadowQuality);
              if (typeof s.textureQuality === 'number') xml = rep('TextureQuality', s.textureQuality);
              if (typeof s.shaderQuality === 'number') xml = rep('ShaderQuality', s.shaderQuality);
              if (typeof s.grassQuality === 'number') xml = rep('GrassQuality', s.grassQuality);
              if (typeof s.postFx === 'number') xml = rep('PostFX', s.postFx);
              if (typeof s.reflectionQuality === 'number') xml = rep('ReflectionQuality', s.reflectionQuality);
              if (typeof s.waterQuality === 'number') xml = rep('WaterQuality', s.waterQuality);
              if (typeof s.tessellation === 'number') xml = rep('Tessellation', s.tessellation);
              if (typeof s.lodScale === 'number' && s.lodScale >= 0) {
                var f = s.lodScale.toFixed(6);
                xml = rep('LodScale', f);
                xml = rep('PedLodBias', f);
                xml = rep('VehicleLodBias', f);
                xml = rep('CityDensity', f);
              }
              cursor.value.contents = new TextEncoder().encode(xml);
              cursor.value.timestamp = new Date();
              cursor.update(cursor.value);
            } catch (ex) {}
          }
          cursor.continue();
        };
      };
    } catch (e) {}
  }

  // =========================================================================
  // 3. STATE & TELEMETRY (LIVE WEBGPU FPS + ANDROID /__ps5/api/stats)
  // =========================================================================
  var state = {
    mode: 'foot',        // 'foot' | 'drive' | 'fly'
    hudVisible: true,
    hudUserOverride: null, // null = auto detect menu vs game, true/false = manual
    sensitivity: 1.15,
    opacity: 0.78,
    fps: 0,
    fpsSource: 'raf',
    stats: {
      cpuPct: 0, cpuMhz: 0, gpuPct: -1, gpuDirect: false,
      usedRamMb: 0, totalRamMb: 0, appPssMb: 0
    },
    cfg: {
      lowEndMode: true,
      graphicsPreset: 1,
      renderDistance: -1,
      resScalePct: 60,
      shadowsLevel: -1,
      fpsCap: 30,
      debugDraws: false,
      statsEnabled: true,
      statsShowFps: true,
      statsShowCpuGpu: true,
      statsShowRam: true,
      settingsXml: null
    }
  };

  // Capture real WebGPU engine FPS from BroadcastChannel('game-fps')
  try {
    var fpsCh = new BroadcastChannel('game-fps');
    fpsCh.onmessage = function (ev) {
      var d = ev.data;
      var val = typeof d === 'number' ? d : (d && typeof d.fps === 'number' ? d.fps : -1);
      if (val >= 0) {
        state.fps = Math.round(val);
        state.fpsSource = 'wgpu';
      }
    };
  } catch (e) {}

  // RAF fallback FPS counter before WebGPU broadcast arrives
  var rafFrames = 0, rafLast = performance.now();
  function rafLoop(now) {
    rafFrames++;
    if (now - rafLast >= 1000) {
      if (state.fpsSource !== 'wgpu') {
        state.fps = Math.round((rafFrames * 1000) / (now - rafLast));
      }
      rafFrames = 0;
      rafLast = now;
    }
    requestAnimationFrame(rafLoop);
  }
  requestAnimationFrame(rafLoop);

  var initialXmlSynced = false;
  function pollAndroidStats() {
    fetch('/__ps5/api/stats', { cache: 'no-store' })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        state.stats.cpuPct = d.cpuPct || 0;
        state.stats.cpuMhz = d.cpuMhz || 0;
        state.stats.gpuPct = typeof d.gpuPct === 'number' ? d.gpuPct : -1;
        state.stats.gpuDirect = !!d.gpuDirect;
        state.stats.usedRamMb = d.usedRamMb || 0;
        state.stats.totalRamMb = d.totalRamMb || 0;
        state.stats.appPssMb = d.appPssMb || 0;
        if (d.config) {
          Object.assign(state.cfg, d.config);
          if (!initialXmlSynced && d.config.settingsXml) {
            initialXmlSynced = true;
            syncSettingsXml(d.config.settingsXml);
          }
        }
        renderStatsHud();
      })
      .catch(function () { renderStatsHud(); });
  }

  function saveSettingsToAndroid(patch, reloadAfter) {
    Object.assign(state.cfg, patch);
    renderStatsHud();
    return fetch('/__ps5/api/settings', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(patch)
    })
      .then(function (r) { return r.json(); })
      .then(function (d) {
        if (d && d.config) {
          Object.assign(state.cfg, d.config);
          if (d.config.settingsXml) syncSettingsXml(d.config.settingsXml);
        }
        if (reloadAfter && d && d.reloadUrl) {
          toast('Applying graphics & reloading...');
          setTimeout(function () { window.location.href = d.reloadUrl; }, 350);
        }
        return d;
      })
      .catch(function () {});
  }

  // =========================================================================
  // 4. SHADOW DOM UI SHELL (ZERO CSS COLLISION WITH PLAYGTA5.COM)
  // =========================================================================
  var host = document.createElement('div');
  host.id = 'ps5-mobile-host';
  host.style.cssText = 'position:fixed;inset:0;z-index:2147483647;pointer-events:none;user-select:none;-webkit-user-select:none;';
  document.body.appendChild(host);
  var shadow = host.attachShadow({ mode: 'open' });

  shadow.innerHTML = [
    '<style>',
    '*{box-sizing:border-box;user-select:none;-webkit-user-select:none;-webkit-tap-highlight-color:transparent;font-family:system-ui,-apple-system,Roboto,sans-serif;}',
    '.layer{position:fixed;inset:0;pointer-events:none;overflow:hidden;}',
    /* Stats HUD */
    '.stats{position:fixed;top:10px;left:12px;background:rgba(7,12,24,0.82);border:1px solid rgba(56,189,248,0.42);border-radius:10px;padding:6px 10px;color:#e2e8f0;font:700 10.5px/1.38 ui-monospace,monospace;pointer-events:none;backdrop-filter:blur(6px);min-width:138px;}',
    '.stats.hide{display:none;}',
    '.st-fps{color:#4ade80;font-size:11.5px;} .st-fps.warn{color:#facc15;} .st-fps.bad{color:#fb7185;}',
    '.st-cpu{color:#38bdf8;} .st-ram{color:#a7f3d0;}',
    /* Top Bar */
    '.topbar{position:fixed;top:10px;left:50%;transform:translateX(-50%);display:flex;gap:5px;align-items:center;background:rgba(7,12,24,0.80);border:1px solid rgba(255,255,255,0.18);border-radius:20px;padding:4px 7px;pointer-events:auto;backdrop-filter:blur(8px);}',
    '.tb-btn{border:1px solid rgba(255,255,255,0.18);background:rgba(20,30,52,0.75);color:#cbd5e1;font-size:10px;font-weight:800;letter-spacing:.05em;padding:5px 9px;border-radius:14px;cursor:pointer;touch-action:manipulation;}',
    '.tb-btn.active{background:#0070d1;border-color:#60a5fa;color:#fff;}',
    '.tb-btn.accent{background:rgba(0,112,209,0.28);border-color:#38bdf8;color:#7dd3fc;}',
    /* Floating Draggable [D] Trainer FAB */
    '.dev-fab{position:fixed;top:54px;right:16px;width:48px;height:48px;border-radius:50%;background:radial-gradient(circle at 32% 28%,#38bdf8,#0070d1 58%,#023e8a);border:2px solid rgba(255,255,255,0.88);color:#fff;font-size:21px;font-weight:900;display:flex;align-items:center;justify-content:center;box-shadow:0 4px 18px rgba(0,112,209,0.65);pointer-events:auto;touch-action:none;cursor:pointer;z-index:50;}',
    /* Toast */
    '.toast{position:fixed;top:52px;left:50%;transform:translateX(-50%);background:rgba(4,12,28,0.92);border:1px solid #38bdf8;color:#f8fafc;font-size:12px;font-weight:700;padding:7px 14px;border-radius:18px;opacity:0;transition:opacity .2s;pointer-events:none;z-index:90;}',
    '.toast.show{opacity:1;}',
    /* Touch Controls Container */
    '.controls{position:fixed;inset:0;pointer-events:none;transition:opacity .2s;}',
    '.controls.hide{display:none;}',
    '.look-pad{position:fixed;top:52px;right:0;bottom:0;left:42%;pointer-events:auto;touch-action:none;}',
    /* Analog Joystick */
    '.stick-zone{position:fixed;bottom:22px;left:22px;width:136px;height:136px;border-radius:50%;background:rgba(10,18,34,0.42);border:2px solid rgba(255,255,255,0.28);pointer-events:auto;touch-action:none;display:flex;align-items:center;justify-content:center;}',
    '.stick-knob{width:54px;height:54px;border-radius:50%;background:radial-gradient(circle at 35% 30%,rgba(255,255,255,0.85),rgba(148,163,184,0.55));border:2px solid #fff;box-shadow:0 2px 10px rgba(0,0,0,0.5);pointer-events:none;transform:translate(0,0);}',
    '.stick-sprint{position:absolute;top:6px;font-size:8px;font-weight:800;color:rgba(125,211,252,0.75);letter-spacing:.08em;pointer-events:none;}',
    '.stick-right{position:fixed;bottom:22px;right:22px;width:136px;height:136px;border-radius:50%;background:rgba(10,18,34,0.42);border:2px solid rgba(56,189,248,0.38);pointer-events:auto;touch-action:none;display:flex;align-items:center;justify-content:center;}',
    /* Action Buttons */
    '.btn{position:fixed;border-radius:50%;background:rgba(10,18,36,0.68);border:1.8px solid rgba(255,255,255,0.36);color:#f8fafc;font-size:10px;font-weight:800;letter-spacing:.03em;display:flex;align-items:center;justify-content:center;text-align:center;pointer-events:auto;touch-action:none;box-shadow:0 3px 10px rgba(0,0,0,0.45);}',
    '.btn.pill{border-radius:16px;padding:0 10px;}',
    '.btn.pressed{background:rgba(0,112,209,0.88);border-color:#7dd3fc;transform:scale(0.94);}',
    '.btn.fire{width:68px;height:68px;background:rgba(220,38,38,0.78);border-color:#fca5a5;font-size:12px;}',
    '.btn.fire.pressed{background:rgba(239,68,68,0.98);}',
    '.btn.aim{width:54px;height:54px;background:rgba(217,119,6,0.72);border-color:#fde68a;}',
    '.btn.gas{width:64px;height:82px;border-radius:16px;background:rgba(22,163,74,0.76);border-color:#86efac;font-size:12px;}',
    '.btn.brake{width:58px;height:66px;border-radius:16px;background:rgba(220,38,38,0.74);border-color:#fca5a5;font-size:11px;}',
    '.btn.steer{width:66px;height:62px;border-radius:16px;font-size:20px;}',
    /* Modals / Drawers */
    '.modal-bg{position:fixed;inset:0;background:rgba(3,7,18,0.72);backdrop-filter:blur(8px);display:none;align-items:center;justify-content:center;pointer-events:auto;z-index:80;}',
    '.modal-bg.open{display:flex;}',
    '.panel{width:min(94vw,540px);max-height:88vh;background:#0a1122;border:1px solid rgba(56,189,248,0.45);border-radius:18px;display:flex;flex-direction:column;overflow:hidden;box-shadow:0 18px 48px rgba(0,0,0,0.75);color:#f1f5f9;}',
    '.p-head{display:flex;align-items:center;justify-content:space-between;padding:12px 16px;background:rgba(0,112,209,0.18);border-bottom:1px solid rgba(255,255,255,0.1);}',
    '.p-title{font-size:14px;font-weight:900;letter-spacing:.05em;color:#fff;}',
    '.p-close{background:rgba(255,255,255,0.12);border:1px solid rgba(255,255,255,0.22);color:#fff;width:30px;height:30px;border-radius:50%;font-weight:800;cursor:pointer;}',
    '.tabs{display:flex;gap:4px;padding:8px 12px;background:#070d1b;border-bottom:1px solid rgba(255,255,255,0.08);overflow-x:auto;}',
    '.tab{flex:1;min-width:66px;padding:7px 6px;border-radius:10px;border:1px solid rgba(255,255,255,0.12);background:#101b33;color:#94a3b8;font-size:10px;font-weight:800;cursor:pointer;text-align:center;}',
    '.tab.on{background:#0070d1;border-color:#60a5fa;color:#fff;}',
    '.p-body{padding:12px 14px;overflow-y:auto;flex:1;}',
    '.grid{display:grid;grid-template-columns:repeat(2,1fr);gap:8px;}',
    '.card-btn{padding:10px 10px;border-radius:11px;border:1px solid rgba(255,255,255,0.14);background:#111d36;color:#f1f5f9;text-align:left;cursor:pointer;}',
    '.card-btn:active{background:#0070d1;}',
    '.card-btn b{display:block;font-size:11.5px;color:#fff;}',
    '.card-btn span{display:block;font-size:9.5px;color:#7dd3fc;margin-top:2px;}',
    '.row{display:flex;align-items:center;justify-content:space-between;gap:10px;padding:9px 10px;background:#101a30;border:1px solid rgba(255,255,255,0.1);border-radius:11px;margin-bottom:8px;}',
    '.row label{font-size:12px;font-weight:700;color:#e2e8f0;}',
    '.row small{display:block;font-size:10px;color:#94a3b8;margin-top:2px;}',
    '.chips{display:flex;flex-wrap:wrap;gap:6px;margin-bottom:10px;}',
    '.chip{padding:7px 10px;border-radius:10px;border:1px solid rgba(255,255,255,0.16);background:#111d36;color:#cbd5e1;font-size:10.5px;font-weight:800;cursor:pointer;}',
    '.chip.on{background:#0070d1;border-color:#60a5fa;color:#fff;}',
    '.primary-btn{width:100%;padding:11px;border-radius:12px;border:none;background:linear-gradient(135deg,#0070d1,#0284c7);color:#fff;font-size:12.5px;font-weight:900;letter-spacing:.04em;cursor:pointer;margin-top:6px;}',
    '.txt-in{flex:1;padding:9px 11px;border-radius:10px;border:1px solid rgba(56,189,248,0.45);background:#070d1a;color:#fff;font-size:13px;font-weight:700;outline:none;}',
    'input[type=range]{accent-color:#38bdf8;width:140px;}',
    'input[type=checkbox]{width:18px;height:18px;accent-color:#38bdf8;}',
    '</style>',
    '<div class="layer">',
      '<div id="stats" class="stats"></div>',
      '<div class="topbar">',
        '<button class="tb-btn active" data-mode="foot">FOOT</button>',
        '<button class="tb-btn" data-mode="drive">DRIVE</button>',
        '<button class="tb-btn" data-mode="fly">FLY</button>',
        '<button class="tb-btn accent" id="btn-pad">PAD</button>',
        '<button class="tb-btn" id="btn-fs">⛶</button>',
        '<button class="tb-btn" id="btn-cfg">⚙</button>',
        '<button class="tb-btn" id="btn-esc">||</button>',
      '</div>',
      '<div id="dev-fab" class="dev-fab" title="Developer Trainer">D</div>',
      '<div id="toast" class="toast"></div>',
      '<div id="controls" class="controls"></div>',
      /* Developer Trainer Modal */
      '<div id="trainer-modal" class="modal-bg">',
        '<div class="panel">',
          '<div class="p-head"><div class="p-title">PS5 DEVELOPER TRAINER</div><button class="p-close" id="tr-close">✕</button></div>',
          '<div class="tabs">',
            '<button class="tab on" data-tab="veh">VEHICLES</button>',
            '<button class="tab" data-tab="wep">WEAPONS</button>',
            '<button class="tab" data-tab="ply">PLAYER/FLY</button>',
            '<button class="tab" data-tab="gfx">GRAPHICS</button>',
            '<button class="tab" data-tab="dev">DEV</button>',
          '</div>',
          '<div class="p-body" id="tr-body"></div>',
        '</div>',
      '</div>',
      /* PS5 Settings Modal */
      '<div id="settings-modal" class="modal-bg">',
        '<div class="panel" style="width:min(90vw,420px)">',
          '<div class="p-head"><div class="p-title">PS5 HUD &amp; TELEMETRY SETTINGS</div><button class="p-close" id="st-close">✕</button></div>',
          '<div class="p-body" id="st-body"></div>',
        '</div>',
      '</div>',
    '</div>'
  ].join('');

  var elStats = shadow.getElementById('stats');
  var elControls = shadow.getElementById('controls');
  var elToast = shadow.getElementById('toast');
  var elDevFab = shadow.getElementById('dev-fab');
  var elTrainerModal = shadow.getElementById('trainer-modal');
  var elTrainerBody = shadow.getElementById('tr-body');
  var elSettingsModal = shadow.getElementById('settings-modal');
  var elSettingsBody = shadow.getElementById('st-body');
  var elBtnPad = shadow.getElementById('btn-pad');

  var toastTimer = null;
  function toast(msg) {
    elToast.textContent = msg;
    elToast.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { elToast.classList.remove('show'); }, 1800);
  }

  function enterFullscreen() {
    try {
      var docEl = document.documentElement;
      var p = (document.fullscreenElement ? document.exitFullscreen() : (docEl.requestFullscreen && docEl.requestFullscreen()));
      if (p && p.then) {
        p.then(function () {
          try { if (screen.orientation && screen.orientation.lock) screen.orientation.lock('landscape').catch(function () {}); } catch (e) {}
        }).catch(function () {});
      }
    } catch (e) {}
  }

  function renderStatsHud() {
    var c = state.cfg;
    if (!c.statsEnabled) {
      elStats.classList.add('hide');
      return;
    }
    elStats.classList.remove('hide');
    var lines = [];
    if (c.statsShowFps) {
      var cls = state.fps >= 45 ? 'st-fps' : (state.fps >= 24 ? 'st-fps warn' : 'st-fps bad');
      lines.push('<div class="' + cls + '">FPS ' + state.fps + (state.fpsSource === 'wgpu' ? ' (WGPU)' : '') + '</div>');
    }
    if (c.statsShowCpuGpu) {
      var s = state.stats;
      var cpuLine = 'CPU ' + s.cpuPct + '%' + (s.cpuMhz > 0 ? (' · ' + (s.cpuMhz / 1000).toFixed(2) + 'GHz') : '');
      var gpuStr = (s.gpuDirect && s.gpuPct >= 0) ? ('  GPU ' + s.gpuPct + '%') : '';
      lines.push('<div class="st-cpu">' + cpuLine + gpuStr + '</div>');
    }
    if (c.statsShowRam && state.stats.totalRamMb > 0) {
      var usedGb = (state.stats.usedRamMb / 1024).toFixed(1);
      var totGb = (state.stats.totalRamMb / 1024).toFixed(1);
      var pss = state.stats.appPssMb > 0 ? (' · App ' + state.stats.appPssMb + 'M') : '';
      lines.push('<div class="st-ram">RAM ' + usedGb + '/' + totGb + 'GB' + pss + '</div>');
    }
    elStats.innerHTML = lines.join('') || '<div class="st-fps">PS5 READY</div>';
  }

  // =========================================================================
  // 5. MULTI-TOUCH CONTROLS BUILDER (FOOT / DRIVE / FLY)
  // =========================================================================
  function bindHoldButton(btn, onDown, onUp, dragLook) {
    var pid = null, lx = 0, ly = 0;
    btn.addEventListener('pointerdown', function (e) {
      e.preventDefault();
      e.stopPropagation();
      if (pid !== null) return;
      pid = e.pointerId;
      lx = e.clientX; ly = e.clientY;
      try { btn.setPointerCapture(pid); } catch (ex) {}
      btn.classList.add('pressed');
      if (onDown) onDown();
    });
    btn.addEventListener('pointermove', function (e) {
      if (!dragLook || e.pointerId !== pid) return;
      e.preventDefault();
      var dx = (e.clientX - lx) * state.sensitivity * 1.4;
      var dy = (e.clientY - ly) * state.sensitivity * 1.4;
      lx = e.clientX; ly = e.clientY;
      if (dx || dy) moveMouse(dx, dy);
    });
    function end(e) {
      if (e.pointerId !== pid) return;
      pid = null;
      btn.classList.remove('pressed');
      if (onUp) onUp();
    }
    btn.addEventListener('pointerup', end);
    btn.addEventListener('pointercancel', end);
  }

  function makeBtn(label, styleCss, cls, onDown, onUp, dragLook) {
    var b = document.createElement('div');
    b.className = 'btn ' + (cls || '');
    b.style.cssText = styleCss;
    b.textContent = label;
    bindHoldButton(b, onDown, onUp, !!dragLook);
    return b;
  }

  function makeStick(zoneCls, onAxis) {
    var zone = document.createElement('div');
    zone.className = zoneCls;
    zone.innerHTML = '<div class="stick-sprint">SPRINT</div><div class="stick-knob"></div>';
    var knob = zone.querySelector('.stick-knob');
    var pid = null;
    function update(cx, cy) {
      var r = zone.getBoundingClientRect();
      var maxR = r.width * 0.36;
      var dx = cx - (r.left + r.width * 0.5);
      var dy = cy - (r.top + r.height * 0.5);
      var dist = Math.hypot(dx, dy);
      if (dist > maxR) { dx = dx / dist * maxR; dy = dy / dist * maxR; dist = maxR; }
      knob.style.transform = 'translate(' + dx.toFixed(1) + 'px,' + dy.toFixed(1) + 'px)';
      onAxis(dx / maxR, dy / maxR, dist / maxR);
    }
    zone.addEventListener('pointerdown', function (e) {
      e.preventDefault(); e.stopPropagation();
      if (pid !== null) return;
      pid = e.pointerId;
      try { zone.setPointerCapture(pid); } catch (ex) {}
      update(e.clientX, e.clientY);
    });
    zone.addEventListener('pointermove', function (e) {
      if (e.pointerId !== pid) return;
      e.preventDefault();
      update(e.clientX, e.clientY);
    });
    function end(e) {
      if (e.pointerId !== pid) return;
      pid = null;
      knob.style.transform = 'translate(0,0)';
      onAxis(0, 0, 0);
    }
    zone.addEventListener('pointerup', end);
    zone.addEventListener('pointercancel', end);
    return zone;
  }

  function makeLookPad() {
    var pad = document.createElement('div');
    pad.className = 'look-pad';
    var pid = null, lx = 0, ly = 0;
    pad.addEventListener('pointerdown', function (e) {
      if (pid !== null) return;
      pid = e.pointerId;
      lx = e.clientX; ly = e.clientY;
      try { pad.setPointerCapture(pid); } catch (ex) {}
    });
    pad.addEventListener('pointermove', function (e) {
      if (e.pointerId !== pid) return;
      e.preventDefault();
      var dx = (e.clientX - lx) * state.sensitivity * 1.45;
      var dy = (e.clientY - ly) * state.sensitivity * 1.45;
      lx = e.clientX; ly = e.clientY;
      if (dx || dy) moveMouse(dx, dy);
    });
    function end(e) { if (e.pointerId === pid) pid = null; }
    pad.addEventListener('pointerup', end);
    pad.addEventListener('pointercancel', end);
    return pad;
  }

  function rebuildControls() {
    releaseAll();
    elControls.innerHTML = '';
    elControls.style.opacity = String(state.opacity);
    elControls.appendChild(makeLookPad());

    if (state.mode === 'foot') {
      elControls.appendChild(makeStick('stick-zone', function (nx, ny, mag) {
        setKey('KeyW', ny < -0.22);
        setKey('KeyS', ny > 0.28);
        setKey('KeyA', nx < -0.25);
        setKey('KeyD', nx > 0.25);
        setKey('ShiftLeft', mag > 0.86 && ny < -0.35);
      }));
      // Right cluster
      elControls.appendChild(makeBtn('FIRE', 'bottom:98px;right:24px;', 'fire', function () { setMouseBtn(0, true); }, function () { setMouseBtn(0, false); }, true));
      elControls.appendChild(makeBtn('AIM', 'bottom:112px;right:104px;', 'aim', function () { setMouseBtn(2, true); }, function () { setMouseBtn(2, false); }, true));
      elControls.appendChild(makeBtn('JUMP', 'bottom:24px;right:28px;width:56px;height:56px;', '', function () { setKey('Space', true); }, function () { setKey('Space', false); }));
      elControls.appendChild(makeBtn('CAR', 'bottom:24px;right:96px;width:54px;height:54px;', '', function () { setKey('KeyF', true); }, function () { setKey('KeyF', false); }));
      elControls.appendChild(makeBtn('RLD', 'bottom:180px;right:28px;width:48px;height:48px;', '', function () { setKey('KeyR', true); }, function () { setKey('KeyR', false); }));
      elControls.appendChild(makeBtn('DUCK', 'bottom:24px;right:162px;width:48px;height:48px;', '', function () { setKey('ControlLeft', true); }, function () { setKey('ControlLeft', false); }));
      elControls.appendChild(makeBtn('CVR', 'bottom:86px;right:170px;width:46px;height:46px;', '', function () { setKey('KeyQ', true); }, function () { setKey('KeyQ', false); }));
      elControls.appendChild(makeBtn('USE', 'bottom:174px;right:92px;width:46px;height:46px;', '', function () { setKey('KeyE', true); }, function () { setKey('KeyE', false); }));
      // Left utility pills
      elControls.appendChild(makeBtn('WEP', 'bottom:172px;left:22px;height:36px;', 'pill', function () { setKey('Tab', true); }, function () { setKey('Tab', false); }));
      elControls.appendChild(makeBtn('◀', 'bottom:172px;left:82px;width:36px;height:36px;', 'pill', function () { wheel(-120); }, null));
      elControls.appendChild(makeBtn('▶', 'bottom:172px;left:124px;width:36px;height:36px;', 'pill', function () { wheel(120); }, null));
      elControls.appendChild(makeBtn('CAM', 'bottom:216px;left:22px;height:32px;', 'pill', function () { tapKey('KeyV'); }, null));
      elControls.appendChild(makeBtn('PHONE', 'bottom:216px;left:78px;height:32px;', 'pill', function () { tapKey('ArrowUp'); }, null));
      elControls.appendChild(makeBtn('SPEC', 'bottom:216px;left:144px;height:32px;', 'pill', function () { tapKey('CapsLock'); }, null));
    } else if (state.mode === 'drive') {
      elControls.appendChild(makeBtn('◀', 'bottom:28px;left:22px;', 'steer', function () { setKey('KeyA', true); }, function () { setKey('KeyA', false); }));
      elControls.appendChild(makeBtn('▶', 'bottom:28px;left:98px;', 'steer', function () { setKey('KeyD', true); }, function () { setKey('KeyD', false); }));
      elControls.appendChild(makeBtn('GAS', 'bottom:24px;right:24px;', 'gas', function () { setKey('KeyW', true); }, function () { setKey('KeyW', false); }));
      elControls.appendChild(makeBtn('BRK', 'bottom:24px;right:100px;', 'brake', function () { setKey('KeyS', true); }, function () { setKey('KeyS', false); }));
      elControls.appendChild(makeBtn('DRIFT', 'bottom:116px;right:24px;width:58px;height:44px;', 'pill', function () { setKey('Space', true); }, function () { setKey('Space', false); }));
      elControls.appendChild(makeBtn('EXIT', 'bottom:116px;right:96px;width:54px;height:44px;', 'pill', function () { setKey('KeyF', true); }, function () { setKey('KeyF', false); }));
      elControls.appendChild(makeBtn('FIRE', 'bottom:172px;right:24px;width:54px;height:54px;', 'fire', function () { setMouseBtn(0, true); }, function () { setMouseBtn(0, false); }, true));
      elControls.appendChild(makeBtn('HORN', 'bottom:108px;left:22px;height:38px;', 'pill', function () { setKey('KeyE', true); }, function () { setKey('KeyE', false); }));
      elControls.appendChild(makeBtn('LIGHT', 'bottom:108px;left:92px;height:38px;', 'pill', function () { tapKey('KeyH'); }, null));
      elControls.appendChild(makeBtn('RADIO', 'bottom:154px;left:22px;height:34px;', 'pill', function () { setKey('KeyQ', true); }, function () { setKey('KeyQ', false); }));
      elControls.appendChild(makeBtn('CAM', 'bottom:154px;left:92px;height:34px;', 'pill', function () { tapKey('KeyV'); }, null));
    } else {
      // Fly Mode
      elControls.appendChild(makeStick('stick-zone', function (nx, ny) {
        setKey('KeyW', ny < -0.2);
        setKey('KeyS', ny > 0.25);
        setKey('KeyA', nx < -0.25);
        setKey('KeyD', nx > 0.25);
      }));
      var rStick = makeStick('stick-right', function (nx, ny) {
        setKey('KeyI', ny < -0.22);
        setKey('KeyK', ny > 0.22);
        setKey('KeyJ', nx < -0.22);
        setKey('KeyL', nx > 0.22);
      });
      rStick.querySelector('.stick-sprint').textContent = 'PITCH/ROLL';
      elControls.appendChild(rStick);
      elControls.appendChild(makeBtn('FIRE', 'bottom:172px;right:24px;width:56px;height:56px;', 'fire', function () { setKey('Space', true); }, function () { setKey('Space', false); }));
      elControls.appendChild(makeBtn('GEAR', 'bottom:172px;right:94px;height:40px;', 'pill', function () { tapKey('KeyG'); }, null));
      elControls.appendChild(makeBtn('BAIL', 'bottom:172px;left:22px;height:40px;', 'pill', function () { tapKey('KeyF'); }, null));
      elControls.appendChild(makeBtn('CAM', 'bottom:172px;left:84px;height:40px;', 'pill', function () { tapKey('KeyV'); }, null));
    }
  }

  function updateHudVisibility() {
    var shouldShow;
    if (state.hudUserOverride !== null) {
      shouldShow = state.hudUserOverride;
    } else {
      // Auto-hide touch overlay while playgta5.com title/menu overlay is active so user can tap Play/Story/Sandbox/Servers cleanly
      var c = getCanvas();
      var menuVisible = false;
      var candidates = document.querySelectorAll('#start, #menu, .menu, button');
      for (var i = 0; i < candidates.length; i++) {
        var el = candidates[i];
        var cs = window.getComputedStyle ? window.getComputedStyle(el) : null;
        var visible = cs ? (cs.display !== 'none' && cs.visibility !== 'hidden' && parseFloat(cs.opacity || '1') > 0.05) : (el.offsetParent !== null);
        if (visible) {
          var rect = el.getBoundingClientRect ? el.getBoundingClientRect() : { width: 1, height: 1 };
          if (rect.width > 2 && rect.height > 2) {
            var txt = (el.textContent || '').toLowerCase();
            if (txt.indexOf('story mode') >= 0 || txt.indexOf('sandbox') >= 0 || txt.indexOf('play') >= 0 || txt.indexOf('server') >= 0) {
              menuVisible = true;
              break;
            }
          }
        }
      }
      shouldShow = !!c && !menuVisible;
    }
    state.hudVisible = shouldShow;
    elControls.classList.toggle('hide', !shouldShow);
    elBtnPad.classList.toggle('active', shouldShow);
  }

  // Top bar mode buttons
  shadow.querySelectorAll('[data-mode]').forEach(function (b) {
    b.addEventListener('click', function () {
      state.mode = b.getAttribute('data-mode');
      shadow.querySelectorAll('[data-mode]').forEach(function (x) { x.classList.toggle('active', x === b); });
      state.hudUserOverride = true;
      updateHudVisibility();
      rebuildControls();
      toast('Controls: ' + state.mode.toUpperCase());
    });
  });

  elBtnPad.addEventListener('click', function () {
    state.hudUserOverride = !state.hudVisible;
    updateHudVisibility();
    toast(state.hudVisible ? 'Touch Controls ON' : 'Touch Controls Hidden (tap page freely)');
  });
  shadow.getElementById('btn-fs').addEventListener('click', enterFullscreen);
  shadow.getElementById('btn-esc').addEventListener('click', function () { tapKey('Escape', 90); });
  shadow.getElementById('btn-cfg').addEventListener('click', openSettingsModal);

  // =========================================================================
  // 6. DRAGGABLE FLOATING [D] DEVELOPER TRAINER
  // =========================================================================
  (function makeFabDraggable() {
    var pid = null, sx = 0, sy = 0, ox = 0, oy = 0, dragged = false;
    elDevFab.addEventListener('pointerdown', function (e) {
      e.preventDefault();
      pid = e.pointerId;
      dragged = false;
      var r = elDevFab.getBoundingClientRect();
      sx = e.clientX; sy = e.clientY; ox = r.left; oy = r.top;
      try { elDevFab.setPointerCapture(pid); } catch (ex) {}
    });
    elDevFab.addEventListener('pointermove', function (e) {
      if (e.pointerId !== pid) return;
      var dx = e.clientX - sx, dy = e.clientY - sy;
      if (Math.hypot(dx, dy) > 8) dragged = true;
      if (!dragged) return;
      var nx = Math.max(8, Math.min(window.innerWidth - 56, ox + dx));
      var ny = Math.max(8, Math.min(window.innerHeight - 56, oy + dy));
      elDevFab.style.left = nx + 'px';
      elDevFab.style.top = ny + 'px';
      elDevFab.style.right = 'auto';
    });
    function end(e) {
      if (e.pointerId !== pid) return;
      pid = null;
      if (!dragged) openTrainerModal();
    }
    elDevFab.addEventListener('pointerup', end);
    elDevFab.addEventListener('pointercancel', end);
  })();

  var activeTab = 'veh';
  var VEHICLES = [
    ['Buzzard Attack Heli', 'BUZZOFF'], ['Comet Sports Car', 'COMET'],
    ['Rapid GT Coupe', 'RAPIDGT'], ['PCJ-600 Sport Bike', 'ROCKET'],
    ['Sanchez Dirt Bike', 'OFFROAD'], ['BMX Bicycle', 'BANDIT'],
    ['Stunt Plane', 'BARNSTORM'], ['Duster Biplane', 'FLYSPRAY'],
    ['Stretch Limo', 'VINEWOOD'], ['Trashmaster Truck', 'TRASHED'],
    ['Caddy Golf Cart', 'HOLEIN1'], ['Duke O\'Death', 'DEATHCAR'],
    ['Dodo Seaplane', 'EXTINCT'], ['Kraken Sub', 'BUBBLES']
  ];
  var WEAPONS = [
    ['Give All Weapons + Ammo', 'TOOLUP'], ['Max Health + Armor + Repair', 'TURTLE'],
    ['Explosive Bullets', 'HIGHEX'], ['Flaming Bullets', 'INCENDIARY'],
    ['Explosive Melee', 'HOTHANDS'], ['Dead Eye Slow Aim', 'DEADEYE'],
    ['Give Parachute', 'SKYDIVE']
  ];
  var PLAYER_CHEATS = [
    ['God Mode (5 min)', 'PAINKILLER'], ['Free Fly / Skyfall', 'SKYFALL'],
    ['Super Jump', 'HOPTOIT'], ['Moon Gravity', 'FLOATER'],
    ['Lower Wanted Level', 'LAWYERUP'], ['Raise Wanted Level', 'FUGITIVE'],
    ['Fast Run', 'CATCHME'], ['Fast Swim', 'GOTGILLS'],
    ['Recharge Special', 'POWERUP'], ['Slippery Drift Cars', 'SNOWDAY'],
    ['Slow Motion', 'SLOWMO'], ['Cycle Weather', 'MAKEITRAIN']
  ];
  var PRESETS = ['POTATO', 'U-LOW', 'LOW', 'MED', 'HIGH'];
  var gfxDraft = {};

  function openTrainerModal() {
    gfxDraft = {
      graphicsPreset: state.cfg.graphicsPreset,
      shadowsLevel: state.cfg.shadowsLevel,
      resScalePct: state.cfg.resScalePct,
      renderDistance: state.cfg.renderDistance,
      fpsCap: state.cfg.fpsCap,
      lowEndMode: state.cfg.lowEndMode,
      debugDraws: state.cfg.debugDraws
    };
    elTrainerModal.classList.add('open');
    renderTrainerTab();
  }
  shadow.getElementById('tr-close').addEventListener('click', function () {
    elTrainerModal.classList.remove('open');
  });
  shadow.querySelectorAll('.tab').forEach(function (t) {
    t.addEventListener('click', function () {
      activeTab = t.getAttribute('data-tab');
      shadow.querySelectorAll('.tab').forEach(function (x) { x.classList.toggle('on', x === t); });
      renderTrainerTab();
    });
  });

  function renderTrainerTab() {
    elTrainerBody.innerHTML = '';
    if (activeTab === 'veh') {
      var g = document.createElement('div'); g.className = 'grid';
      VEHICLES.forEach(function (v) {
        var b = document.createElement('button'); b.className = 'card-btn';
        b.innerHTML = '<b>' + v[0] + '</b><span>Spawn · ' + v[1] + '</span>';
        b.onclick = function () { runCheat(v[1]); elTrainerModal.classList.remove('open'); };
        g.appendChild(b);
      });
      elTrainerBody.appendChild(g);
    } else if (activeTab === 'wep') {
      var gw = document.createElement('div'); gw.className = 'grid';
      WEAPONS.forEach(function (w) {
        var b = document.createElement('button'); b.className = 'card-btn';
        b.innerHTML = '<b>' + w[0] + '</b><span>' + w[1] + '</span>';
        b.onclick = function () { runCheat(w[1]); };
        gw.appendChild(b);
      });
      var sb5 = document.createElement('button'); sb5.className = 'card-btn';
      sb5.innerHTML = '<b>Sandbox: GTA V Map</b><span>Instant reload in Sandbox</span>';
      sb5.onclick = function () { saveSettingsToAndroid({ launchMode: 'sandbox5' }, true); };
      gw.appendChild(sb5);
      var sb6 = document.createElement('button'); sb6.className = 'card-btn';
      sb6.innerHTML = '<b>Sandbox: GTA VI Map</b><span>Instant reload in env_test</span>';
      sb6.onclick = function () { saveSettingsToAndroid({ launchMode: 'sandbox6' }, true); };
      gw.appendChild(sb6);
      elTrainerBody.appendChild(gw);
    } else if (activeTab === 'ply') {
      // Hover Fly Combo & Permanent God Mode
      var combo = document.createElement('button'); combo.className = 'primary-btn';
      combo.style.marginBottom = '10px';
      combo.textContent = '★ ENABLE HOVER FLY COMBO (SUPER JUMP + MOON GRAVITY)';
      combo.onclick = function () {
        runCheat('HOPTOIT'); runCheat('FLOATER');
        elTrainerModal.classList.remove('open');
      };
      elTrainerBody.appendChild(combo);

      var autoRow = document.createElement('div'); autoRow.className = 'row';
      autoRow.innerHTML = '<div><label>Permanent God Mode</label><small>Auto-renews PAINKILLER every 4m 40s</small></div><input type="checkbox" id="chk-autogod"' + (autoGodTimer ? ' checked' : '') + '/>';
      elTrainerBody.appendChild(autoRow);
      autoRow.querySelector('#chk-autogod').onchange = function (e) {
        if (e.target.checked) {
          runCheat('PAINKILLER');
          autoGodTimer = setInterval(function () { runCheat('PAINKILLER'); }, 280000);
        } else {
          clearInterval(autoGodTimer); autoGodTimer = null;
        }
      };

      var gp = document.createElement('div'); gp.className = 'grid';
      PLAYER_CHEATS.forEach(function (p) {
        var b = document.createElement('button'); b.className = 'card-btn';
        b.innerHTML = '<b>' + p[0] + '</b><span>' + p[1] + '</span>';
        b.onclick = function () { runCheat(p[1]); };
        gp.appendChild(b);
      });
      elTrainerBody.appendChild(gp);
    } else if (activeTab === 'gfx') {
      var wrap = document.createElement('div');
      var rdDefault = gfxDraft.renderDistance < 0;
      var rdVal = rdDefault ? 50 : gfxDraft.renderDistance;

      wrap.innerHTML = [
        '<div style="font-size:11px;font-weight:800;color:#7dd3fc;margin-bottom:6px">GRAPHICS PRESET (TRUE RAGE ENGINE CLI OVERRIDE)</div>',
        '<div class="chips" id="gfx-presets"></div>',
        '<div style="font-size:11px;font-weight:800;color:#7dd3fc;margin:6px 0">SHADOWS (FIXES PLAYGTA5 FLOOR)</div>',
        '<div class="chips" id="gfx-shadows"></div>',
        '<div class="row"><div><label>Resolution Scale: <span id="lbl-scale">' + gfxDraft.resScalePct + '%</span></label><small>Lower boosts FPS dramatically on mobile GPUs</small></div><input type="range" id="rng-scale" min="35" max="100" step="5" value="' + gfxDraft.resScalePct + '"/></div>',
        '<div class="row"><div><label>Render Distance: <span id="lbl-rd">' + (rdDefault ? 'Default' : (rdVal + '/100')) + '</span></label><small>Uncheck Default to set custom LOD/streaming distance</small></div><label style="font-size:11px"><input type="checkbox" id="chk-rd-def"' + (rdDefault ? ' checked' : '') + '/> Default</label></div>',
        '<div class="row" id="rd-slider-row" style="' + (rdDefault ? 'opacity:.45' : '') + '"><div><label>Custom Distance (0–100)</label><small>Lower = fewer nearby buildings/peds/props load</small></div><input type="range" id="rng-rd" min="0" max="100" value="' + rdVal + '"' + (rdDefault ? ' disabled' : '') + '/></div>',
        '<div style="font-size:11px;font-weight:800;color:#7dd3fc;margin:6px 0">FPS CAP</div>',
        '<div class="chips" id="gfx-fps"></div>',
        '<div class="row"><div><label>Low-End Phone Mode</label><small>Caps worker threads &amp; VRAM slots for stability</small></div><input type="checkbox" id="chk-lowend"' + (gfxDraft.lowEndMode ? ' checked' : '') + '/></div>',
        '<button class="primary-btn" id="btn-apply-gfx">APPLY GRAPHICS &amp; RELOAD ENGINE</button>'
      ].join('');
      elTrainerBody.appendChild(wrap);

      var pBox = wrap.querySelector('#gfx-presets');
      PRESETS.forEach(function (name, idx) {
        var c = document.createElement('button'); c.className = 'chip' + (gfxDraft.graphicsPreset === idx ? ' on' : '');
        c.textContent = name;
        c.onclick = function () {
          gfxDraft.graphicsPreset = idx;
          gfxDraft.resScalePct = [45, 60, 75, 88, 100][idx];
          gfxDraft.shadowsLevel = [-1, -1, 0, 1, 2][idx];
          if (idx <= 1) { gfxDraft.lowEndMode = true; gfxDraft.fpsCap = 30; }
          renderTrainerTab();
        };
        pBox.appendChild(c);
      });

      var sBox = wrap.querySelector('#gfx-shadows');
      [['OFF (-1)', -1], ['Lowest (0)', 0], ['Normal (1)', 1], ['High (2)', 2]].forEach(function (sh) {
        var c = document.createElement('button'); c.className = 'chip' + (gfxDraft.shadowsLevel === sh[1] ? ' on' : '');
        c.textContent = sh[0];
        c.onclick = function () { gfxDraft.shadowsLevel = sh[1]; renderTrainerTab(); };
        sBox.appendChild(c);
      });

      var fBox = wrap.querySelector('#gfx-fps');
      [['30 FPS', 30], ['60 FPS', 60], ['Uncapped', 0]].forEach(function (fp) {
        var c = document.createElement('button'); c.className = 'chip' + (gfxDraft.fpsCap === fp[1] ? ' on' : '');
        c.textContent = fp[0];
        c.onclick = function () { gfxDraft.fpsCap = fp[1]; renderTrainerTab(); };
        fBox.appendChild(c);
      });

      wrap.querySelector('#rng-scale').oninput = function (e) {
        gfxDraft.resScalePct = parseInt(e.target.value, 10);
        wrap.querySelector('#lbl-scale').textContent = gfxDraft.resScalePct + '%';
      };
      wrap.querySelector('#chk-rd-def').onchange = function (e) {
        gfxDraft.renderDistance = e.target.checked ? -1 : parseInt(wrap.querySelector('#rng-rd').value, 10);
        renderTrainerTab();
      };
      wrap.querySelector('#rng-rd').oninput = function (e) {
        gfxDraft.renderDistance = parseInt(e.target.value, 10);
        wrap.querySelector('#lbl-rd').textContent = gfxDraft.renderDistance + '/100';
      };
      wrap.querySelector('#chk-lowend').onchange = function (e) { gfxDraft.lowEndMode = e.target.checked; };
      wrap.querySelector('#btn-apply-gfx').onclick = function () {
        elTrainerModal.classList.remove('open');
        saveSettingsToAndroid(gfxDraft, true);
      };
    } else {
      var devDiv = document.createElement('div');
      devDiv.innerHTML = [
        '<div style="display:flex;gap:8px;margin-bottom:10px"><input class="txt-in" id="cheat-in" placeholder="Custom GTA V cheat (e.g. BUZZOFF)"/><button class="chip on" id="cheat-go">RUN</button></div>',
        '<div class="row"><div><label>Debug Draw Isolation (?dbg=1)</label><small>Enable playgta5.com GPU draw-call debugger</small></div><input type="checkbox" id="chk-dbg"' + (gfxDraft.debugDraws ? ' checked' : '') + '/></div>',
        '<div class="row"><div><label>Cross-Origin Isolated Status</label><small>Required for SharedArrayBuffer &amp; 3 GB WASM heap</small></div><b style="color:' + (self.crossOriginIsolated ? '#4ade80' : '#fb7185') + '">' + (self.crossOriginIsolated ? 'ACTIVE ✓' : 'OFF ✕') + '</b></div>',
        '<div class="row"><div><label>Hardware WebGPU Status</label><small>navigator.gpu availability in Chrome</small></div><b style="color:' + (navigator.gpu ? '#4ade80' : '#facc15') + '">' + (navigator.gpu ? 'READY ✓' : 'UNAVAILABLE') + '</b></div>',
        '<button class="primary-btn" id="btn-dev-fs">ENTER IMMERSIVE FULLSCREEN LANDSCAPE</button>'
      ].join('');
      elTrainerBody.appendChild(devDiv);
      devDiv.querySelector('#cheat-go').onclick = function () {
        var v = devDiv.querySelector('#cheat-in').value.trim();
        if (v) { runCheat(v); devDiv.querySelector('#cheat-in').value = ''; }
      };
      devDiv.querySelector('#chk-dbg').onchange = function (e) {
        saveSettingsToAndroid({ debugDraws: e.target.checked }, true);
      };
      devDiv.querySelector('#btn-dev-fs').onclick = function () {
        elTrainerModal.classList.remove('open');
        enterFullscreen();
      };
    }
  }

  // =========================================================================
  // 7. PS5 HUD & HARDWARE TELEMETRY SETTINGS MODAL
  // =========================================================================
  function openSettingsModal() {
    elSettingsModal.classList.add('open');
    var c = state.cfg;
    elSettingsBody.innerHTML = [
      '<div class="row"><div><label>Hardware Statistics HUD</label><small>Master toggle for top-left telemetry overlay</small></div><input type="checkbox" id="st-en"' + (c.statsEnabled ? ' checked' : '') + '/></div>',
      '<div class="row"><div><label>Show FPS Counter</label><small>Real-time WebGPU / compositor FPS</small></div><input type="checkbox" id="st-fps"' + (c.statsShowFps ? ' checked' : '') + '/></div>',
      '<div class="row"><div><label>Show CPU / GPU Usage</label><small>Live Android CPU % / GHz &amp; GPU sensor</small></div><input type="checkbox" id="st-cpu"' + (c.statsShowCpuGpu ? ' checked' : '') + '/></div>',
      '<div class="row"><div><label>Show RAM Usage</label><small>System RAM used/total &amp; app footprint</small></div><input type="checkbox" id="st-ram"' + (c.statsShowRam ? ' checked' : '') + '/></div>',
      '<div class="row"><div><label>Camera Sensitivity: <span id="st-sens-v">' + state.sensitivity.toFixed(2) + 'x</span></label></div><input type="range" id="st-sens" min="0.4" max="2.5" step="0.05" value="' + state.sensitivity + '"/></div>',
      '<div class="row"><div><label>Controls Opacity: <span id="st-op-v">' + Math.round(state.opacity * 100) + '%</span></label></div><input type="range" id="st-op" min="0.25" max="1.0" step="0.05" value="' + state.opacity + '"/></div>'
    ].join('');

    function syncStatsToggles() {
      saveSettingsToAndroid({
        statsEnabled: elSettingsBody.querySelector('#st-en').checked,
        statsShowFps: elSettingsBody.querySelector('#st-fps').checked,
        statsShowCpuGpu: elSettingsBody.querySelector('#st-cpu').checked,
        statsShowRam: elSettingsBody.querySelector('#st-ram').checked
      }, false);
    }
    elSettingsBody.querySelector('#st-en').onchange = syncStatsToggles;
    elSettingsBody.querySelector('#st-fps').onchange = syncStatsToggles;
    elSettingsBody.querySelector('#st-cpu').onchange = syncStatsToggles;
    elSettingsBody.querySelector('#st-ram').onchange = syncStatsToggles;
    elSettingsBody.querySelector('#st-sens').oninput = function (e) {
      state.sensitivity = parseFloat(e.target.value);
      elSettingsBody.querySelector('#st-sens-v').textContent = state.sensitivity.toFixed(2) + 'x';
    };
    elSettingsBody.querySelector('#st-op').oninput = function (e) {
      state.opacity = parseFloat(e.target.value);
      elSettingsBody.querySelector('#st-op-v').textContent = Math.round(state.opacity * 100) + '%';
      elControls.style.opacity = String(state.opacity);
    };
  }
  shadow.getElementById('st-close').addEventListener('click', function () {
    elSettingsModal.classList.remove('open');
  });

  // =========================================================================
  // 8. BOOTSTRAP
  // =========================================================================
  rebuildControls();
  updateHudVisibility();
  pollAndroidStats();
  setInterval(pollAndroidStats, 1000);
  setInterval(updateHudVisibility, 1200);
})();
