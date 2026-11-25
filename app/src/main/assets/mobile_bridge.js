(function () {
    'use strict';
    if (window.__gtaMobileInstalled) return;
    window.__gtaMobileInstalled = true;

    const params = new URLSearchParams(window.location.search);
    const isLowEnd = params.get('low') === '1';
    const ultraLevel = parseInt(params.get('ultra') || '0', 10) || 0;
    const isUltra = ultraLevel > 0;

    // 0a. Ultra Optimize Mode low-RAM/low-VRAM browser caps (DOCUMENT_START, before game JS boots)
    if (isUltra || isLowEnd) {
        try {
            Object.defineProperty(navigator, 'deviceMemory', {
                configurable: true,
                get: function () { return ultraLevel >= 2 ? 1 : 2; }
            });
        } catch (e) {}
    }
    if (isUltra) {
        try {
            Object.defineProperty(window, 'devicePixelRatio', {
                configurable: true,
                get: function () { return 1; }
            });
        } catch (e) {}
    }

    // 0. Non-breaking SharedArrayBuffer probe (runs at DOCUMENT_START before page JS checks crossOriginIsolated)
    // Only exposes SharedArrayBuffer if WebView truly allows transferring shared Wasm memory to Workers.
    try {
        if (typeof window.SharedArrayBuffer !== 'function' && typeof WebAssembly === 'object' && typeof WebAssembly.Memory === 'function') {
            const probeMem = new WebAssembly.Memory({ initial: 1, maximum: 1, shared: true });
            const sabCtor = probeMem && probeMem.buffer && probeMem.buffer.constructor;
            if (sabCtor && typeof structuredClone === 'function') {
                structuredClone(probeMem.buffer);
                Object.defineProperty(window, 'SharedArrayBuffer', {
                    value: sabCtor, writable: true, configurable: true, enumerable: false
                });
                Object.defineProperty(window, 'crossOriginIsolated', {
                    configurable: true, get: function () { return true; }
                });
            }
        }
    } catch (e) {}

    // 1. Prevent browser pinch-zoom, text selection, context menus, and rubber-band scrolling
    function injectMobileCss() {
        try {
            if (document.getElementById('gta-mobile-style')) return;
            const host = document.head || document.documentElement;
            if (!host) return;
            const style = document.createElement('style');
            style.id = 'gta-mobile-style';
            const cssRules = [
                'html, body, #canvas { touch-action: none !important; user-select: none !important; -webkit-user-select: none !important; -webkit-touch-callout: none !important; overscroll-behavior: none !important; }',
                '#fps { display: none !important; }',
                '#hud { top: 44px !important; font-size: 11px !important; opacity: 0.90 !important; }',
                '#ls-log { display: block !important; margin-bottom: 54px !important; max-width: 82vw !important; opacity: 0.92 !important; }'
            ];
            if (isUltra) {
                cssRules.push(
                    '*, *::before, *::after { animation-duration: 0.001ms !important; transition-duration: 0.001ms !important; backdrop-filter: none !important; -webkit-backdrop-filter: none !important; box-shadow: none !important; }'
                );
            }
            style.textContent = cssRules.join('\n');
            host.appendChild(style);
        } catch (e) {}
    }
    injectMobileCss();
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', injectMobileCss, { once: true });
    }

    // 2. Virtual Pointer Lock Shim for Android WebView (enables smooth 360° camera look)
    let virtualLocked = false;
    function getCanvas() {
        return document.getElementById('canvas') || document.querySelector('canvas');
    }

    try {
        Object.defineProperty(document, 'pointerLockElement', {
            configurable: true,
            get: function () {
                return virtualLocked ? getCanvas() : null;
            }
        });
    } catch (e) {}

    function setVirtualPointerLock(locked) {
        if (virtualLocked === locked) return;
        virtualLocked = locked;
        try {
            document.dispatchEvent(new Event('pointerlockchange'));
        } catch (e) {}
    }

    try {
        const origReq = HTMLCanvasElement.prototype.requestPointerLock;
        HTMLCanvasElement.prototype.requestPointerLock = function () {
            setVirtualPointerLock(true);
            try {
                if (typeof origReq === 'function') {
                    const res = origReq.apply(this, arguments);
                    if (res && typeof res.catch === 'function') res.catch(function () {});
                }
            } catch (e) {}
            return Promise.resolve();
        };
    } catch (e) {}

    try {
        const origExit = Document.prototype.exitPointerLock;
        Document.prototype.exitPointerLock = function () {
            setVirtualPointerLock(false);
            try {
                if (typeof origExit === 'function') origExit.apply(this, arguments);
            } catch (e) {}
        };
    } catch (e) {}

    // 3. Key map & exact KeyboardEvent / MouseEvent / WheelEvent dispatcher
    const KEY_NAME = {
        KeyW: 'w', KeyA: 'a', KeyS: 's', KeyD: 'd',
        KeyE: 'e', KeyF: 'f', KeyR: 'r', KeyQ: 'q', KeyV: 'v', KeyC: 'c',
        KeyG: 'g', KeyH: 'h', KeyI: 'i', KeyJ: 'j', KeyK: 'k', KeyL: 'l',
        KeyU: 'u', KeyO: 'o', KeyM: 'm', KeyP: 'p', KeyB: 'b', KeyN: 'n',
        KeyT: 't', KeyX: 'x', KeyY: 'y', KeyZ: 'z',
        Space: ' ', ShiftLeft: 'Shift', ControlLeft: 'Control', AltLeft: 'Alt',
        Tab: 'Tab', Escape: 'Escape', Enter: 'Enter', Backspace: 'Backspace',
        CapsLock: 'CapsLock', Backquote: '`',
        ArrowUp: 'ArrowUp', ArrowDown: 'ArrowDown', ArrowLeft: 'ArrowLeft', ArrowRight: 'ArrowRight',
        Digit1: '1', Digit2: '2', Digit3: '3', Digit4: '4', Digit5: '5',
        Digit6: '6', Digit7: '7', Digit8: '8', Digit9: '9', Digit0: '0',
        F1: 'F1', F2: 'F2', F3: 'F3', F4: 'F4', F5: 'F5', F6: 'F6', F8: 'F8'
    };

    const heldKeys = new Set();
    const heldButtons = new Set();
    const state = {
        worldReady: false,
        lastPct: -1,
        lastLabel: '',
        audioUnlocked: false,
        lastButtonsSig: ''
    };

    function notifyAndroid(fn) {
        try {
            if (window.GtaAndroidBridge && typeof window.GtaAndroidBridge[fn] === 'function') {
                const args = Array.prototype.slice.call(arguments, 1);
                window.GtaAndroidBridge[fn].apply(window.GtaAndroidBridge, args);
            }
        } catch (e) {}
    }

    function ensureAudioGesture() {
        if (state.audioUnlocked) return;
        state.audioUnlocked = true;
        try {
            window.dispatchEvent(new Event('focus'));
            window.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, pointerType: 'touch' }));
        } catch (e) {}
    }

    function dispatchKey(code, down, explicitKey) {
        ensureAudioGesture();
        const key = explicitKey !== undefined ? explicitKey : (KEY_NAME[code] || code);
        if (down) {
            if (heldKeys.has(code)) return;
            heldKeys.add(code);
        } else {
            if (!heldKeys.has(code)) return;
            heldKeys.delete(code);
        }
        try {
            window.dispatchEvent(new KeyboardEvent(down ? 'keydown' : 'keyup', {
                code: code,
                key: key,
                bubbles: true,
                cancelable: true
            }));
        } catch (e) {}
    }

    function pulseKey(code, holdMs) {
        dispatchKey(code, true);
        setTimeout(function () { dispatchKey(code, false); }, holdMs || 65);
    }

    // 4. Sequential GTA V PC Cheat Console Executor (~ -> type cheat -> Enter)
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

    function dispatchRawCharKey(code, ch, down) {
        try {
            window.dispatchEvent(new KeyboardEvent(down ? 'keydown' : 'keyup', {
                code: code,
                key: ch,
                bubbles: true,
                cancelable: true
            }));
        } catch (e) {}
    }

    function runNextCheat() {
        if (cheatRunning || cheatQueue.length === 0) return;
        cheatRunning = true;
        const raw = cheatQueue.shift();
        const text = String(raw || '').trim().toLowerCase();
        if (!text) {
            cheatRunning = false;
            runNextCheat();
            return;
        }

        ensureAudioGesture();
        try { window.dispatchEvent(new Event('focus')); } catch (e) {}
        if (!virtualLocked) setVirtualPointerLock(true);

        // Step 1: Open GTA V PC cheat console (`~` / Backquote = VK 0xC0)
        dispatchRawCharKey('Backquote', '`', true);
        setTimeout(function () {
            dispatchRawCharKey('Backquote', '`', false);

            // Step 2: Type each character into both VK array & U16 char ring buffer
            let i = 0;
            function typeNext() {
                if (i >= text.length) {
                    setTimeout(function () {
                        dispatchRawCharKey('Enter', 'Enter', true);
                        setTimeout(function () {
                            dispatchRawCharKey('Enter', 'Enter', false);
                            notifyAndroid('onCheatExecuted', text.toUpperCase());
                            setTimeout(function () {
                                cheatRunning = false;
                                runNextCheat();
                            }, 180);
                        }, 55);
                    }, 70);
                    return;
                }
                const ch = text[i++];
                const code = charToCode(ch);
                if (code) {
                    dispatchRawCharKey(code, ch, true);
                    setTimeout(function () {
                        dispatchRawCharKey(code, ch, false);
                        setTimeout(typeNext, 24);
                    }, 28);
                } else {
                    setTimeout(typeNext, 10);
                }
            }
            setTimeout(typeNext, 140);
        }, 65);
    }

    // 5. Patch /userdata/settings.xml in IndexedDB('gta5-userdata') so lower graphics & render distance persist
    function syncSettingsXml(cfg) {
        if (!cfg || !window.indexedDB) return;
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
                            const decoder = new TextDecoder('utf-8');
                            let xml = decoder.decode(rec.data instanceof Uint8Array ? rec.data : new Uint8Array(rec.data));
                            const replaceVal = function (tag, val) {
                                const re = new RegExp('(<' + tag + '\\s+value=")[^"]*("\\s*/>)', 'i');
                                if (re.test(xml)) xml = xml.replace(re, '$1' + val + '$2');
                            };
                            if (typeof cfg.shadowQuality === 'number') replaceVal('ShadowQuality', cfg.shadowQuality < 0 ? 0 : cfg.shadowQuality);
                            if (typeof cfg.textureQuality === 'number') replaceVal('TextureQuality', cfg.textureQuality);
                            if (typeof cfg.shaderQuality === 'number') replaceVal('ShaderQuality', cfg.shaderQuality);
                            if (typeof cfg.grassQuality === 'number') replaceVal('GrassQuality', cfg.grassQuality);
                            if (typeof cfg.postFx === 'number') replaceVal('PostFX', cfg.postFx);
                            if (typeof cfg.reflectionQuality === 'number') replaceVal('ReflectionQuality', cfg.reflectionQuality);
                            if (typeof cfg.waterQuality === 'number') replaceVal('WaterQuality', cfg.waterQuality);
                            if (typeof cfg.tessellation === 'number') replaceVal('Tessellation', cfg.tessellation);
                            if (typeof cfg.particleQuality === 'number') replaceVal('ParticleQuality', cfg.particleQuality);
                            if (typeof cfg.msaa === 'number') {
                                replaceVal('MSAA', cfg.msaa);
                                replaceVal('ReflectionMSAA', cfg.msaa);
                            }
                            if (typeof cfg.fxaa === 'number') replaceVal('FXAA', cfg.fxaa);
                            if (typeof cfg.txaa === 'number') replaceVal('TXAA', cfg.txaa);
                            if (typeof cfg.ssao === 'number') replaceVal('SSAO', cfg.ssao);
                            if (typeof cfg.aniso === 'number') replaceVal('AnisotropicFiltering', cfg.aniso);
                            if (typeof cfg.softShadows === 'number') replaceVal('Shadow_SoftShadows', cfg.softShadows);
                            if (typeof cfg.particleShadows === 'boolean') replaceVal('Shadow_ParticleShadows', cfg.particleShadows ? 'true' : 'false');
                            if (typeof cfg.popDensity === 'number') replaceVal('PopulationDensity', cfg.popDensity.toFixed(6));
                            if (typeof cfg.popVariety === 'number') {
                                const pv = cfg.popVariety.toFixed(6);
                                replaceVal('PopulationVariety', pv);
                                replaceVal('PedVarietyMultiplier', pv);
                                replaceVal('VehicleVarietyMultiplier', pv);
                            }
                            if (typeof cfg.lodScale === 'number' && cfg.lodScale >= 0) {
                                const f = cfg.lodScale.toFixed(6);
                                replaceVal('LodScale', f);
                                replaceVal('PedLodBias', f);
                                replaceVal('VehicleLodBias', f);
                                replaceVal('DistanceScaling', f);
                                replaceVal('Shadow_Distance', Math.max(0.20, cfg.lodScale).toFixed(6));
                            }
                            const enc = new TextEncoder().encode(xml);
                            store.put({ data: enc, mtime: Date.now() }, '/userdata/settings.xml');
                        } catch (e) {}
                    };
                    tx.oncomplete = function () { db.close(); };
                } catch (e) {}
            };
        } catch (e) {}
    }

    // 6. Public Mobile Controller API called by GameInputBridge.java
    window.__gtaMobile = {
        setKey: function (code, down) {
            dispatchKey(code, !!down);
        },

        pulseKey: function (code, holdMs) {
            pulseKey(code, holdMs || 65);
        },

        setMoveKeys: function (w, s, a, d, sprint) {
            dispatchKey('KeyW', !!w);
            dispatchKey('KeyS', !!s);
            dispatchKey('KeyA', !!a);
            dispatchKey('KeyD', !!d);
            dispatchKey('ShiftLeft', !!sprint);
        },

        setFlyKeys: function (pitchUp, pitchDown, rollLeft, rollRight) {
            dispatchKey('KeyI', !!pitchUp);
            dispatchKey('KeyK', !!pitchDown);
            dispatchKey('KeyJ', !!rollLeft);
            dispatchKey('KeyL', !!rollRight);
        },

        moveCamera: function (dx, dy) {
            if (!dx && !dy) return;
            ensureAudioGesture();
            if (!virtualLocked) setVirtualPointerLock(true);
            try {
                window.dispatchEvent(new MouseEvent('mousemove', {
                    bubbles: true,
                    cancelable: true,
                    movementX: dx,
                    movementY: dy
                }));
            } catch (e) {}
        },

        mouseButton: function (button, down) {
            ensureAudioGesture();
            const c = getCanvas();
            if (down) {
                if (heldButtons.has(button)) return;
                heldButtons.add(button);
                if (!virtualLocked) setVirtualPointerLock(true);
                const cx = c ? c.clientWidth * 0.5 : window.innerWidth * 0.5;
                const cy = c ? c.clientHeight * 0.5 : window.innerHeight * 0.5;
                try {
                    (c || window).dispatchEvent(new MouseEvent('mousedown', {
                        bubbles: true,
                        cancelable: true,
                        button: button,
                        clientX: cx,
                        clientY: cy
                    }));
                } catch (e) {}
            } else {
                if (!heldButtons.has(button)) return;
                heldButtons.delete(button);
                try {
                    window.dispatchEvent(new MouseEvent('mouseup', {
                        bubbles: true,
                        cancelable: true,
                        button: button
                    }));
                } catch (e) {}
            }
        },

        wheelStep: function (steps) {
            if (!steps) return;
            ensureAudioGesture();
            try {
                window.dispatchEvent(new WheelEvent('wheel', {
                    bubbles: true,
                    cancelable: true,
                    deltaMode: 0,
                    deltaY: steps * 110
                }));
            } catch (e) {}
        },

        tapAt: function (normX, normY) {
            ensureAudioGesture();
            const c = getCanvas();
            if (!c) return;
            const r = c.getBoundingClientRect();
            const x = r.left + normX * r.width;
            const y = r.top + normY * r.height;
            setVirtualPointerLock(false);
            try {
                window.dispatchEvent(new MouseEvent('mousemove', {
                    bubbles: true, cancelable: true, clientX: x, clientY: y
                }));
                const el = document.elementFromPoint(x, y) || c;
                el.dispatchEvent(new MouseEvent('mousedown', {
                    bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y
                }));
                setTimeout(function () {
                    window.dispatchEvent(new MouseEvent('mouseup', {
                        bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y
                    }));
                    if (typeof el.click === 'function' && el !== c) el.click();
                }, 45);
            } catch (e) {}
        },

        clickTitleAction: function (act) {
            ensureAudioGesture();
            try {
                const btn = document.querySelector('#modes button[data-act="' + act + '"]');
                if (btn && !btn.hidden) {
                    btn.click();
                    return true;
                }
            } catch (e) {}
            const fallback = {
                story: 'Enter',
                sandbox: 'Space',
                map5: 'Digit5',
                map6: 'Digit6',
                multiplayer: 'KeyM',
                server1: 'Digit1',
                server2: 'Digit2',
                server3: 'Digit3',
                back: 'Backspace'
            };
            if (fallback[act]) {
                pulseKey(fallback[act], 80);
                return true;
            }
            return false;
        },

        runCheat: function (code) {
            cheatQueue.push(code);
            runNextCheat();
        },

        syncSettingsXml: function (cfg) {
            syncSettingsXml(cfg);
        },

        setPointerLock: function (locked) {
            setVirtualPointerLock(!!locked);
        },

        releaseAll: function () {
            Array.from(heldKeys).forEach(function (code) { dispatchKey(code, false); });
            Array.from(heldButtons).forEach(function (btn) { window.__gtaMobile.mouseButton(btn, false); });
        },

        triggerMemoryTrim: function () {
            try {
                const bc = new BroadcastChannel('ps5-ultra-ctrl');
                bc.postMessage({ cmd: 'trim', ts: Date.now() });
                setTimeout(function () { try { bc.close(); } catch (e) {} }, 120);
            } catch (e) {}
            notifyAndroid('onMemoryTrimmed');
        },

        clearStorageCache: function () {
            // Purges OPFS streamed data cache (gamedata / gamedata-b) without touching saves (gta5-userdata)
            (async function () {
                try {
                    if (navigator.storage && typeof navigator.storage.getDirectory === 'function') {
                        const root = await navigator.storage.getDirectory();
                        for (const dirName of ['gamedata', 'gamedata-b']) {
                            try { await root.removeEntry(dirName, { recursive: true }); } catch (e) {}
                        }
                    }
                } catch (e) {}
                try {
                    if (typeof caches !== 'undefined' && typeof caches.keys === 'function') {
                        const keys = await caches.keys();
                        for (const k of keys) {
                            try { await caches.delete(k); } catch (e) {}
                        }
                    }
                } catch (e) {}
                notifyAndroid('onCacheCleared');
            })();
        }
    };

    // 7. BroadcastChannel Telemetry -> Native Android HUD & Stats Viewer
    let lastConsoleLine = '';
    let lastDataText = '';
    let lastHudErr = '';
    let lastAdvanceAt = Date.now();
    let stallNotified = false;

    try {
        const fpsBc = new BroadcastChannel('game-fps');
        fpsBc.onmessage = function (ev) {
            const d = ev.data;
            if (!d) return;
            if (typeof d.fps === 'number') {
                notifyAndroid('onFps', d.fps);
            }
            if (typeof d.vramTexMb === 'number') {
                notifyAndroid(
                    'onGpuTelemetry',
                    d.vramTexMb | 0,
                    (d.vramBufMb || 0) | 0,
                    (d.vramSavedMb || 0) | 0,
                    (d.texCount || 0) | 0,
                    !!d.ultraOn
                );
            }
        };
    } catch (e) {}

    try {
        const progBc = new BroadcastChannel('game-progress');
        progBc.onmessage = function (ev) {
            const m = ev.data || {};
            if (Array.isArray(m.lines) && m.lines.length) {
                const ln = String(m.lines[m.lines.length - 1] || '').trim();
                if (ln) {
                    lastConsoleLine = ln;
                    lastAdvanceAt = Date.now();
                }
            }
            if (typeof m.pct === 'number' || m.label) {
                lastAdvanceAt = Date.now();
                notifyAndroid('onProgress', m.pct || 0, m.label || '', lastDataText, lastConsoleLine);
            }
            if (m.ready || m.world) {
                if (!state.worldReady) {
                    state.worldReady = true;
                    notifyAndroid('onWorldReady');
                }
            }
            if (m.gpuLost) {
                notifyAndroid('onEngineError', 'WebGPU device lost: ' + m.gpuLost);
            }
            if (m.error) {
                notifyAndroid('onEngineError', String(m.error));
            }
        };
    } catch (e) {}

    try {
        const crashBc = new BroadcastChannel('game-crash');
        crashBc.onmessage = function (ev) {
            const m = ev.data || {};
            notifyAndroid('onEngineError', (m.kind || 'crash') + ': ' + (m.text || 'Engine stopped'));
        };
    } catch (e) {}

    // 8. Poll loading state, engine console/HUD diagnostics, & visible title screen buttons
    let sawLoading = false;
    setInterval(function () {
        if (document.readyState === 'loading') return;

        // Watch #hud for fatal GPU / WASM / crash notices even if loading screen disappeared
        const hudEl = document.getElementById('hud');
        if (hudEl) {
            const hudTxt = (hudEl.textContent || '').trim();
            if (hudTxt && hudTxt !== lastHudErr) {
                const lowHud = hudTxt.toLowerCase();
                if (lowHud.indexOf('gpu') >= 0 && (lowHud.indexOf('lost') >= 0 || lowHud.indexOf('error') >= 0)
                        || lowHud.indexOf('crash') >= 0
                        || lowHud.indexOf('out of memory') >= 0
                        || lowHud.indexOf('abort') >= 0) {
                    lastHudErr = hudTxt;
                    notifyAndroid('onEngineError', hudTxt);
                }
            }
        }

        const loading = document.getElementById('loading');
        if (loading) sawLoading = true;
        const isGone = !loading || getComputedStyle(loading).opacity === '0' || getComputedStyle(loading).display === 'none';
        if (sawLoading && isGone) {
            if (!state.worldReady) {
                state.worldReady = true;
                notifyAndroid('onWorldReady');
            }
            return;
        }
        if (!loading) return;

        const pctEl = document.getElementById('pct');
        const labelEl = document.getElementById('label');
        const dataEl = document.getElementById('data');
        const consoleEl = document.getElementById('console');

        const pct = pctEl ? parseInt(pctEl.textContent, 10) || 0 : 0;
        const label = labelEl ? (labelEl.textContent || '').trim() : '';
        const dataTxt = dataEl ? (dataEl.textContent || '').trim() : '';
        const conTxt = consoleEl ? (consoleEl.textContent || '').trim() : '';
        if (conTxt) {
            const lines = conTxt.split('\n');
            const latest = (lines[lines.length - 1] || '').trim();
            if (latest && latest !== lastConsoleLine) {
                lastConsoleLine = latest;
                lastAdvanceAt = Date.now();
            }
        }
        if (dataTxt && dataTxt !== lastDataText) {
            lastDataText = dataTxt;
            lastAdvanceAt = Date.now();
        }

        if (pct !== state.lastPct || label !== state.lastLabel) {
            if (pct > state.lastPct || label !== state.lastLabel) {
                lastAdvanceAt = Date.now();
                stallNotified = false;
            }
            state.lastPct = pct;
            state.lastLabel = label;
            notifyAndroid('onProgress', pct, label, lastDataText, lastConsoleLine);
            const lowLbl = label.toLowerCase();
            if (lowLbl.indexOf('not cross-origin isolated') >= 0
                    || lowLbl.indexOf('no memory') >= 0
                    || lowLbl.indexOf('out of memory') >= 0
                    || lowLbl.indexOf('cannot run the game') >= 0) {
                notifyAndroid('onEngineError', label);
            }
        }

        // Detect prolonged loading stall (e.g. >50s with zero %/data/log movement or "No progress for")
        const lowLblCheck = label.toLowerCase();
        if (!state.worldReady && !stallNotified && pct >= 50 && pct < 100
                && (lowLblCheck.indexOf('no progress for') >= 0 || (Date.now() - lastAdvanceAt > 50000))) {
            stallNotified = true;
            notifyAndroid('onLoadingStall', pct, label, lastDataText, lastConsoleLine);
        }

        const modes = document.getElementById('modes');
        if (modes) {
            const btns = Array.prototype.slice.call(modes.querySelectorAll('button'))
                .filter(function (b) { return !b.hidden && b.dataset && b.dataset.act; })
                .map(function (b) { return b.dataset.act + ':' + (b.textContent || b.dataset.act).trim(); });
            const sig = btns.join('|');
            if (sig && sig !== state.lastButtonsSig) {
                state.lastButtonsSig = sig;
                notifyAndroid('onTitleButtons', sig);
            }
        }
    }, 350);

    // 9. Report browser WebGPU + SharedArrayBuffer capabilities to Android once DOM is ready
    function reportCaps() {
        notifyAndroid(
            'onCapabilities',
            !!navigator.gpu,
            !!window.crossOriginIsolated,
            typeof WebAssembly === 'object'
        );
    }
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', reportCaps, { once: true });
    } else {
        reportCaps();
    }
})();
