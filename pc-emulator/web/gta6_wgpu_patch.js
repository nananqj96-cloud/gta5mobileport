/**
 * ViceBox X — Experimental GTA 6 WebGPU Post-Processing & Performance Governor Patch
 * Appended into playgta5.com's wgpu_worker.js by local_server.h ONLY when Experimental GTA 6 is enabled.
 *
 * v2.8 HARDENED ARCHITECTURE:
 *  - Defaults to fxState.enabled = 0 until gta6_experimental.js activates it via BroadcastChannel('vbx-gta6-fx'),
 *    guaranteeing stock GTA V rendering is 100% untouched even when the dev toggle is ON.
 *  - Wraps all WebGPU shader/pipeline/texture allocations in device.pushErrorScope('validation') + popErrorScope()
 *    so ANY driver/format validation issue immediately flips gta6Failed = true and falls back cleanly to stock makeBlit().
 *  - Single-pass fullscreen blit (zero extra render targets; optional single prevTex copy only when COPY_SRC is supported).
 *  - GTX 1050 automatic 4-tier frame-time governor (targets >= 60 FPS, <= 16.6 ms).
 *  - Streams ground-truth GPU present telemetry (presentCount, fps, frameMs, tier, resW/H) back to gta6_experimental.js.
 */
(function () {
  'use strict';
  if (self.__vbxGta6WgpuInstalled) return;
  self.__vbxGta6WgpuInstalled = true;

  const fxState = {
    enabled: 0,           // Activated explicitly by gta6_experimental.js when vbx_gta6=1
    perfAuto: 1,
    lighting: 1,
    motionBlur: 1,
    motionBlurStrength: 0.55,
    bloomStrength: 0.42,
    warmth: 0.58,
    volumetricRays: 0.45,
    camVelX: 0.0,
    camVelY: 0.0,
    speedNorm: 0.0,
    timeOfDay: 18.4,      // Leonida golden-hour twilight default
    focusMix: 0.0,
    hudWarmth: 0.5
  };

  let perfTier = 0;       // 0 = High, 1 = Balanced, 2 = Fast, 3 = Ultra-Light
  let avgFrameMs = 14.0;
  let overBudgetFrames = 0;
  let underBudgetFrames = 0;
  let lastPerfPost = 0;
  let realPresentTotal = 0;

  // Receive live settings + camera motion velocity from gta6_experimental.js
  let fxChan = null;
  try {
    fxChan = new BroadcastChannel('vbx-gta6-fx');
    fxChan.onmessage = (ev) => {
      const m = ev.data;
      if (!m || typeof m !== 'object') return;
      if (m.enabled !== undefined) fxState.enabled = m.enabled ? 1 : 0;
      if (m.perfAuto !== undefined) fxState.perfAuto = m.perfAuto ? 1 : 0;
      if (m.lighting !== undefined) fxState.lighting = m.lighting ? 1 : 0;
      if (m.motionBlur !== undefined) fxState.motionBlur = m.motionBlur ? 1 : 0;
      if (typeof m.motionBlurStrength === 'number') fxState.motionBlurStrength = Math.max(0, Math.min(1, m.motionBlurStrength));
      if (typeof m.bloomStrength === 'number') fxState.bloomStrength = Math.max(0, Math.min(1, m.bloomStrength));
      if (typeof m.warmth === 'number') fxState.warmth = Math.max(0, Math.min(1, m.warmth));
      if (typeof m.volumetricRays === 'number') fxState.volumetricRays = Math.max(0, Math.min(1, m.volumetricRays));
      if (typeof m.camVelX === 'number') fxState.camVelX = m.camVelX;
      if (typeof m.camVelY === 'number') fxState.camVelY = m.camVelY;
      if (typeof m.speedNorm === 'number') fxState.speedNorm = Math.max(0, Math.min(1, m.speedNorm));
      if (typeof m.timeOfDay === 'number') fxState.timeOfDay = m.timeOfDay;
      if (typeof m.focusMix === 'number') fxState.focusMix = Math.max(0, Math.min(1, m.focusMix));
      if (m.resetTier) { perfTier = 0; overBudgetFrames = 0; underBudgetFrames = 0; }
    };
  } catch (e) {}

  // Single-pass WGSL shader using textureLoad (works on ALL 2D float/unorm render target formats without filterability issues!)
  const WGSL_GTA6_POST = /* wgsl */ `
    struct FxUniforms {
      p0: vec4<f32>, // x: lightingOn, y: mblurOn, z: mblurStrength, w: bloomStrength
      p1: vec4<f32>, // x: warmth, y: raysStrength, z: camVelX, w: camVelY
      p2: vec4<f32>, // x: speedNorm, y: timeOfDay, z: perfTier, w: hasPrev
      p3: vec4<f32>, // x: focusMix, y: timeSec, z: invW, w: invH
    };

    @group(0) @binding(0) var curTex: texture_2d<f32>;
    @group(0) @binding(1) var prevTex: texture_2d<f32>;
    @group(0) @binding(2) var<uniform> u: FxUniforms;

    struct VsOut {
      @builtin(position) pos: vec4<f32>,
      @location(0) uv: vec2<f32>,
    };

    @vertex fn vs(@builtin(vertex_index) i: u32) -> VsOut {
      let p = array<vec2<f32>, 3>(
        vec2<f32>(-1.0, -1.0),
        vec2<f32>( 3.0, -1.0),
        vec2<f32>(-1.0,  3.0)
      );
      var o: VsOut;
      o.pos = vec4<f32>(p[i], 0.0, 1.0);
      o.uv = vec2<f32>((p[i].x + 1.0) * 0.5, (1.0 - p[i].y) * 0.5);
      return o;
    }

    fn sampleCur(uv: vec2<f32>, dims: vec2<f32>) -> vec3<f32> {
      let c = clamp(uv, vec2<f32>(0.0), vec2<f32>(0.9999));
      let ip = vec2<i32>(c * dims);
      return textureLoad(curTex, ip, 0).rgb;
    }

    fn samplePrev(uv: vec2<f32>, dims: vec2<f32>) -> vec3<f32> {
      let c = clamp(uv, vec2<f32>(0.0), vec2<f32>(0.9999));
      let ip = vec2<i32>(c * dims);
      return textureLoad(prevTex, ip, 0).rgb;
    }

    fn luma(c: vec3<f32>) -> f32 {
      return dot(c, vec3<f32>(0.2126, 0.7152, 0.0722));
    }

    fn acesFilmic(x: vec3<f32>) -> vec3<f32> {
      let a = 2.51;
      let b = 0.03;
      let c = 2.43;
      let d = 0.59;
      let e = 0.14;
      return clamp((x * (a * x + b)) / (x * (c * x + d) + e), vec3<f32>(0.0), vec3<f32>(1.0));
    }

    @fragment fn fs(in: VsOut) -> @location(0) vec4<f32> {
      let dims = vec2<f32>(textureDimensions(curTex));
      let uv = in.uv;
      let tier = u.p2.z;
      var col = sampleCur(uv, dims);

      // 1. REAL CAMERA & RADIAL SPEED MOTION BLUR (tiered for GTX 1050 60fps)
      if (u.p0.y > 0.5 && u.p0.z > 0.01 && tier < 2.5) {
        let strength = u.p0.z;
        let camVel = vec2<f32>(u.p1.z, u.p1.w) * 0.00052 * strength;
        let fromCenter = uv - vec2<f32>(0.5, 0.5);
        let radDist = length(fromCenter);
        let radMask = smoothstep(0.24, 0.76, radDist);
        let radVel = fromCenter * (u.p2.x * 0.022 * strength * radMask);
        var vel = camVel + radVel;
        let vLen = length(vel);
        if (vLen > 0.038) {
          vel = vel * (0.038 / vLen);
        }

        if (vLen > 0.0008) {
          let taps: i32 = select(select(6i, 4i, tier > 0.5), 2i, tier > 1.5);
          var acc = col;
          var wSum = 1.0;
          for (var i: i32 = 1; i <= 6i; i = i + 1i) {
            if (i > taps) { break; }
            let frac = f32(i) / f32(taps);
            let w = 1.0 - frac * 0.55;
            acc = acc + sampleCur(uv - vel * frac, dims) * w;
            wSum = wSum + w;
          }
          col = acc / wSum;
        }

        if (u.p2.w > 0.5 && tier < 1.5) {
          let prevCol = samplePrev(uv - vel * 0.5, dims);
          let diff = length(col - prevCol);
          let motionBoost = clamp(vLen * 20.0 + u.p2.x * 0.22, 0.0, 0.30) * strength;
          let ghostGuard = smoothstep(0.45, 0.06, diff);
          let blend = motionBoost * ghostGuard;
          col = mix(col, prevCol, blend);
        }
      }

      // 2. LEONIDA / VICE CITY LIGHTING, BLOOM, GODRAYS & FILMIC GRADE
      if (u.p0.x > 0.5) {
        let warm = u.p1.x;
        let tod = u.p2.y;
        let sunsetW = clamp(1.0 - abs(tod - 18.2) * 0.30, 0.0, 1.0);
        let nightW  = clamp(smoothstep(19.5, 22.0, tod) + (1.0 - smoothstep(4.5, 7.0, tod)), 0.0, 1.0);
        let dayW    = clamp(1.0 - max(sunsetW, nightW), 0.0, 1.0);

        if (u.p0.w > 0.01 && tier < 2.5) {
          let px = vec2<f32>(u.p3.z, u.p3.w);
          let rad1 = select(2.6, 1.8, tier > 0.5);
          let b0 = sampleCur(uv + vec2<f32>( px.x * rad1,  px.y * rad1), dims);
          let b1 = sampleCur(uv + vec2<f32>(-px.x * rad1,  px.y * rad1), dims);
          let b2 = sampleCur(uv + vec2<f32>( px.x * rad1, -px.y * rad1), dims);
          let b3 = sampleCur(uv + vec2<f32>(-px.x * rad1, -px.y * rad1), dims);
          var bloom = max((b0 + b1 + b2 + b3) * 0.25 - vec3<f32>(0.62), vec3<f32>(0.0));
          if (tier < 0.5) {
            let rad2 = 5.4;
            let c0 = sampleCur(uv + vec2<f32>( px.x * rad2, 0.0), dims);
            let c1 = sampleCur(uv + vec2<f32>(-px.x * rad2, 0.0), dims);
            let c2 = sampleCur(uv + vec2<f32>(0.0,  px.y * rad2), dims);
            let c3 = sampleCur(uv + vec2<f32>(0.0, -px.y * rad2), dims);
            let halo = max((c0 + c1 + c2 + c3) * 0.25 - vec3<f32>(0.58), vec3<f32>(0.0));
            bloom = bloom * 0.6 + halo * 0.55;
          }
          let neonTint = mix(vec3<f32>(1.06, 0.94, 0.88), vec3<f32>(1.16, 0.82, 1.08), nightW * 0.65 + sunsetW * 0.35);
          col = col + bloom * neonTint * (u.p0.w * 0.72);
        }

        if (u.p1.y > 0.01 && tier < 1.5) {
          let sunUv = vec2<f32>(0.76, 0.22);
          let toSun = sunUv - uv;
          let sunDist = length(toSun);
          let sunFalloff = exp(-sunDist * 2.4) * smoothstep(0.88, 0.06, uv.y);
          let raySample = sampleCur(uv + toSun * 0.14, dims);
          let skyLum = smoothstep(0.32, 0.92, luma(raySample));
          let rayCol = mix(
            vec3<f32>(1.00, 0.84, 0.62),
            mix(vec3<f32>(1.00, 0.52, 0.66), vec3<f32>(0.42, 0.65, 1.00), nightW),
            max(sunsetW, nightW)
          );
          col = col + rayCol * sunFalloff * skyLum * (u.p1.y * 0.26);
        }

        let Y = luma(col);
        let shadowMask = clamp(1.0 - smoothstep(0.06, 0.44, Y), 0.0, 1.0);
        let highMask   = smoothstep(0.45, 0.96, Y);
        let shadowBounce = mix(
          vec3<f32>(0.028, 0.055, 0.072),
          mix(vec3<f32>(0.052, 0.032, 0.075), vec3<f32>(0.025, 0.052, 0.088), nightW),
          max(sunsetW, nightW)
        );
        col = col + shadowBounce * shadowMask * (0.48 + warm * 0.35);

        let highTint = mix(
          vec3<f32>(1.03, 0.99, 0.94),
          mix(vec3<f32>(1.08, 0.94, 0.90), vec3<f32>(0.96, 0.98, 1.08), nightW),
          max(sunsetW, nightW)
        );
        col = col * mix(vec3<f32>(1.0), highTint, highMask * (0.42 + warm * 0.38));

        let hazeMask = smoothstep(0.70, 0.04, uv.y) * smoothstep(0.18, 0.82, Y);
        let hazeCol = mix(
          vec3<f32>(0.94, 0.85, 0.78),
          mix(vec3<f32>(0.98, 0.58, 0.68), vec3<f32>(0.18, 0.22, 0.42), nightW),
          max(sunsetW, nightW)
        );
        col = mix(col, hazeCol, hazeMask * (0.04 + dayW * 0.02 + sunsetW * 0.05) * warm);

        let sat = 1.09 + sunsetW * 0.07;
        let gray = vec3<f32>(luma(col));
        col = mix(gray, col, sat);
        col = mix(col, acesFilmic(col * 1.08), 0.56);

        let d = uv - vec2<f32>(0.5, 0.5);
        let vig = 1.0 - dot(d, d) * 0.22;
        col = col * clamp(vig, 0.80, 1.0);
      }

      // 3. GTA 6 FOCUS / EAGLE EYE TINT (when CapsLock active)
      if (u.p3.x > 0.01) {
        let g = vec3<f32>(luma(col));
        let focusCol = mix(g * vec3<f32>(0.88, 0.90, 1.18), col, 0.38) + vec3<f32>(0.06, 0.02, 0.11);
        col = mix(col, focusCol, u.p3.x * 0.68);
      }

      return vec4<f32>(clamp(col, vec3<f32>(0.0), vec3<f32>(1.0)), 1.0);
    }
  `;

  let gta6Pipe = null;
  let gta6PipeFmt = '';
  let gta6UniformBuf = null;
  let gta6UniformArr = new Float32Array(16);
  let gta6PrevTex = null;
  let gta6PrevW = 0;
  let gta6PrevH = 0;
  let gta6PrevFmt = '';
  let gta6HasPrev = 0;
  let gta6Failed = false;
  let gta6DevRef = null;

  function ensurePipeline(device, canvasFormat) {
    if (gta6Failed) return false;
    if (gta6Pipe && gta6PipeFmt === canvasFormat && gta6DevRef === device) return true;
    try {
      device.pushErrorScope('validation');
      const mod = device.createShaderModule({ label: 'vbx-gta6-post', code: WGSL_GTA6_POST });
      const pipe = device.createRenderPipeline({
        label: 'vbx-gta6-post-pipe',
        layout: 'auto',
        vertex: { module: mod, entryPoint: 'vs' },
        fragment: { module: mod, entryPoint: 'fs', targets: [{ format: canvasFormat }] },
        primitive: { topology: 'triangle-list' }
      });
      const uBuf = gta6UniformBuf && gta6DevRef === device
        ? gta6UniformBuf
        : device.createBuffer({
            label: 'vbx-gta6-uniforms',
            size: 64,
            usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
          });
      device.popErrorScope().then((err) => {
        if (err) {
          gta6Failed = true;
          gta6Pipe = null;
        }
      }).catch(() => {});
      gta6Pipe = pipe;
      gta6UniformBuf = uBuf;
      gta6PipeFmt = canvasFormat;
      gta6DevRef = device;
      return true;
    } catch (e) {
      gta6Failed = true;
      return false;
    }
  }

  function ensurePrevTex(device, w, h, fmt, canCopy) {
    if (!canCopy) {
      gta6HasPrev = 0;
      return null;
    }
    if (gta6PrevTex && gta6PrevW === w && gta6PrevH === h && gta6PrevFmt === fmt && gta6DevRef === device) {
      return gta6PrevTex;
    }
    try { if (gta6PrevTex) gta6PrevTex.destroy(); } catch (e) {}
    try {
      device.pushErrorScope('validation');
      const tex = device.createTexture({
        label: 'vbx-gta6-prev',
        size: { width: w, height: h, depthOrArrayLayers: 1 },
        format: fmt,
        usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST
      });
      device.popErrorScope().then((err) => {
        if (err) {
          try { tex.destroy(); } catch (_) {}
          gta6PrevTex = null;
          gta6HasPrev = 0;
        }
      }).catch(() => {});
      gta6PrevTex = tex;
      gta6PrevW = w;
      gta6PrevH = h;
      gta6PrevFmt = fmt;
      gta6HasPrev = 0;
      return gta6PrevTex;
    } catch (e) {
      gta6PrevTex = null;
      gta6HasPrev = 0;
      return null;
    }
  }

  function updatePerfGovernor(dtMs, w, h) {
    if (dtMs > 0.5 && dtMs < 200) {
      avgFrameMs = avgFrameMs * 0.90 + dtMs * 0.10;
    }
    if (fxState.perfAuto) {
      if (avgFrameMs > 17.5) {
        overBudgetFrames++;
        underBudgetFrames = 0;
        if (overBudgetFrames >= 24 && perfTier < 3) {
          perfTier++;
          overBudgetFrames = 0;
        }
      } else if (avgFrameMs < 13.8) {
        underBudgetFrames++;
        overBudgetFrames = 0;
        if (underBudgetFrames >= 120 && perfTier > 0) {
          perfTier--;
          underBudgetFrames = 0;
        }
      } else {
        overBudgetFrames = Math.max(0, overBudgetFrames - 1);
      }
    } else {
      perfTier = 0;
    }

    const now = performance.now();
    if (fxChan && now - lastPerfPost >= 300) {
      lastPerfPost = now;
      fxChan.postMessage({
        perfReport: true,
        realPresent: true,
        presentCount: realPresentTotal,
        fps: Math.min(240, 1000 / Math.max(1, avgFrameMs)),
        frameMs: avgFrameMs,
        tier: perfTier,
        resW: w,
        resH: h,
        fallbackActive: gta6Failed
      });
    }
  }

  self.__vbxGta6Present = function (device, canvasCtx, canvasFormat, getEncoder, t, dtMs, presentCount) {
    realPresentTotal++;
    const w = (t && t.desc && t.desc.size && t.desc.size.width) ? t.desc.size.width : 1280;
    const h = (t && t.desc && t.desc.size && t.desc.size.height) ? t.desc.size.height : 720;
    updatePerfGovernor(dtMs || 16.6, w, h);

    // Stock passthrough when Experimental GTA 6 is not active, disabled, or failed validation
    if (!fxState.enabled || gta6Failed) return false;
    if (!fxState.lighting && !fxState.motionBlur && fxState.focusMix < 0.01) return false;
    if (!device || !canvasCtx || !t || !t.tex || !t.desc || !t.desc.size) return false;
    if ((t.desc.sampleCount || 1) > 1) return false;
    if (!ensurePipeline(device, canvasFormat)) return false;

    const fmt = t.desc.format || 'bgra8unorm';
    const canCopyPrev = (fxState.motionBlur && perfTier < 2 && ((t.desc.usage || 0) & GPUTextureUsage.COPY_SRC) !== 0);
    const prev = ensurePrevTex(device, w, h, fmt, canCopyPrev);

    try {
      const u = gta6UniformArr;
      u[0]  = fxState.lighting ? 1.0 : 0.0;
      u[1]  = fxState.motionBlur ? 1.0 : 0.0;
      u[2]  = fxState.motionBlurStrength;
      u[3]  = fxState.bloomStrength;
      u[4]  = fxState.warmth;
      u[5]  = fxState.volumetricRays;
      u[6]  = fxState.camVelX;
      u[7]  = fxState.camVelY;
      u[8]  = fxState.speedNorm;
      u[9]  = fxState.timeOfDay;
      u[10] = perfTier;
      u[11] = (prev && gta6HasPrev) ? 1.0 : 0.0;
      u[12] = fxState.focusMix;
      u[13] = performance.now() * 0.001;
      u[14] = 1.0 / Math.max(1, w);
      u[15] = 1.0 / Math.max(1, h);
      device.queue.writeBuffer(gta6UniformBuf, 0, u);

      const prevRef = prev || t.tex;
      if (!t.__vbxGta6BG || t.__vbxGta6PrevRef !== prevRef || t.__vbxGta6Pipe !== gta6Pipe) {
        device.pushErrorScope('validation');
        t.__vbxGta6BG = device.createBindGroup({
          layout: gta6Pipe.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: t.tex.createView({ dimension: '2d', baseMipLevel: 0, mipLevelCount: 1 }) },
            { binding: 1, resource: prevRef.createView({ dimension: '2d', baseMipLevel: 0, mipLevelCount: 1 }) },
            { binding: 2, resource: { buffer: gta6UniformBuf } }
          ]
        });
        t.__vbxGta6PrevRef = prevRef;
        t.__vbxGta6Pipe = gta6Pipe;
        device.popErrorScope().then((err) => {
          if (err) {
            gta6Failed = true;
            t.__vbxGta6BG = null;
          }
        }).catch(() => {});
      }

      const enc = getEncoder();
      const pass = enc.beginRenderPass({
        colorAttachments: [{
          view: canvasCtx.getCurrentTexture().createView(),
          loadOp: 'clear',
          clearValue: { r: 0, g: 0, b: 0, a: 1 },
          storeOp: 'store'
        }]
      });
      pass.setPipeline(gta6Pipe);
      pass.setBindGroup(0, t.__vbxGta6BG);
      pass.draw(3);
      pass.end();

      if (prev && canCopyPrev) {
        enc.copyTextureToTexture(
          { texture: t.tex, mipLevel: 0 },
          { texture: prev, mipLevel: 0 },
          { width: w, height: h, depthOrArrayLayers: 1 }
        );
        gta6HasPrev = 1;
      }
      return true;
    } catch (e) {
      gta6Failed = true;
      return false;
    }
  };
})();
