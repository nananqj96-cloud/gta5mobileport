// ==================== VICEBOX X — EXPERIMENTAL GTA 6 WEBGPU POST-PROCESSING PIPELINE ====================
// Runs natively inside playgta5's wgpu_worker.js swapchain present() pass on the GPU (GTX 1050 60 FPS target).
// Single-pass unified shader: Per-Object + Camera Velocity Motion Blur, Vice City ACES Filmic Lighting,
// Fast Anamorphic Bloom, Subtle Volumetric Sun Shafts, Focus Mode Grade & Performance: Auto Governor.
(function initVbxGta6Wgpu() {
  if (typeof self === 'undefined' || self.__VBX_GTA6_WGPU_INSTALLED) return;
  self.__VBX_GTA6_WGPU_INSTALLED = true;

  const fxState = {
    enabled: 1,
    perfAuto: 1,
    velX: 0,
    velY: 0,
    speed: 0,
    blurStrength: 0.85,
    lightStrength: 0.92,
    bloomStrength: 0.72,
    shaftStrength: 0.45,
    sunU: 0.72,
    sunV: 0.16,
    focusMix: 0.0,
    perfTier: 0,      // 0 = Full (6-tap blur + bloom + shafts), 1 = Balanced (4-tap), 2 = Fast (2-tap)
    emaMs: 14.0,
    lastTierUpT: 0,
    lastPerfPostT: 0,
    t0: performance.now(),
    failed: false
  };

  try {
    const fxBc = new BroadcastChannel('vbx-gta6-fx');
    fxBc.onmessage = (ev) => {
      const d = ev.data;
      if (!d) return;
      if (d.enabled !== undefined) fxState.enabled = d.enabled ? 1 : 0;
      if (d.perfAuto !== undefined) fxState.perfAuto = d.perfAuto ? 1 : 0;
      if (d.velX !== undefined) fxState.velX = d.velX;
      if (d.velY !== undefined) fxState.velY = d.velY;
      if (d.speed !== undefined) fxState.speed = d.speed;
      if (d.blurStrength !== undefined) fxState.blurStrength = d.blurStrength;
      if (d.lightStrength !== undefined) fxState.lightStrength = d.lightStrength;
      if (d.bloomStrength !== undefined) fxState.bloomStrength = d.bloomStrength;
      if (d.shaftStrength !== undefined) fxState.shaftStrength = d.shaftStrength;
      if (d.sunU !== undefined) fxState.sunU = d.sunU;
      if (d.sunV !== undefined) fxState.sunV = d.sunV;
      if (d.focusMix !== undefined) fxState.focusMix = d.focusMix;
      if (!fxState.perfAuto && d.manualTier !== undefined) fxState.perfTier = d.manualTier;
    };
  } catch (e) {}

  let gta6Pipe = null;
  let gta6UniformBuf = null;
  let gta6PrevTex = null;
  let gta6PrevW = 0;
  let gta6PrevH = 0;
  let gta6PrevFmt = '';
  let gta6HasPrev = 0;
  let gta6PerfBc = null;
  const uData = new Float32Array(16);

  const WGSL_GTA6_POST = `
struct VbxUniforms {
  p0: vec4f, // velX, velY, fwdSpeed, blurStrength
  p1: vec4f, // lightStrength, bloomStrength, shaftStrength, timeSec
  p2: vec4f, // sunU, sunV, focusMix, perfTier
  p3: vec4f, // width, height, enabled, hasPrev
};

@group(0) @binding(0) var curTex: texture_2d<f32>;
@group(0) @binding(1) var prevTex: texture_2d<f32>;
@group(0) @binding(2) var<uniform> u: VbxUniforms;

@vertex fn vs(@builtin(vertex_index) i: u32) -> @builtin(position) vec4f {
  var p = array<vec2f, 3>(vec2f(-1.0, -1.0), vec2f(3.0, -1.0), vec2f(-1.0, 3.0));
  return vec4f(p[i], 0.0, 1.0);
}

fn loadCur(coord: vec2f, maxC: vec2i) -> vec3f {
  let c = clamp(vec2i(coord), vec2i(0, 0), maxC);
  return textureLoad(curTex, c, 0).rgb;
}

fn luma(c: vec3f) -> f32 {
  return dot(c, vec3f(0.2126, 0.7152, 0.0722));
}

fn acesFilmic(x: vec3f) -> vec3f {
  let a = 2.51;
  let b = 0.03;
  let c = 2.43;
  let d = 0.59;
  let e = 0.14;
  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), vec3f(0.0), vec3f(1.0));
}

@fragment fn fs(@builtin(position) pos: vec4f) -> @location(0) vec4f {
  let res = vec2f(max(u.p3.x, 1.0), max(u.p3.y, 1.0));
  let maxC = vec2i(i32(res.x) - 1, i32(res.y) - 1);
  let ip = clamp(vec2i(pos.xy), vec2i(0, 0), maxC);
  let baseRaw = textureLoad(curTex, ip, 0);

  if (u.p3.z < 0.5) {
    return baseRaw;
  }

  let uv = pos.xy / res;
  let tier = u.p2.w;
  var col = baseRaw.rgb;

  // 1. GTA 6 Per-Object + Camera & High-Speed Radial Motion Blur
  let blurStr = u.p0.w;
  if (blurStr > 0.02) {
    let fromCenter = uv - vec2f(0.5, 0.46);
    let edgeMask = smoothstep(0.10, 0.62, length(fromCenter));
    let radialVec = fromCenter * (u.p0.z * 32.0 * edgeMask);
    let camVec = vec2f(u.p0.x, u.p0.y);
    var vel = (camVec + radialVec) * blurStr;

    // Clamp max streak length to keep image crisp and avoid artifacts
    let velLen = length(vel);
    if (velLen > 24.0) {
      vel = vel * (24.0 / velLen);
    }

    // Per-object optical motion energy from previous frame history
    var objMotion = 0.0;
    var prevRgb = col;
    if (u.p3.w > 0.5) {
      prevRgb = textureLoad(prevTex, ip, 0).rgb;
      let diff = length(col - prevRgb);
      objMotion = smoothstep(0.06, 0.42, diff);
    }

    if (velLen > 0.35) {
      // Interleaved screen-space noise eliminates banding at low tap counts (GTX 1050 friendly!)
      let jitter = fract(52.9829189 * fract(dot(pos.xy, vec2f(0.06711056, 0.00583715)))) - 0.5;
      var accum = col * 1.35;
      var wSum = 1.35;
      let taps: i32 = select(select(6i, 4i, tier > 0.5), 2i, tier > 1.5);
      let invTaps = 1.0 / f32(taps);
      for (var k: i32 = 1i; k <= 6i; k = k + 1i) {
        if (k > taps) { break; }
        let t = (f32(k) + jitter * 0.6) * invTaps;
        let w = 1.0 - t * 0.55;
        let s1 = loadCur(pos.xy - vel * t, maxC);
        let s2 = loadCur(pos.xy + vel * (t * 0.45), maxC);
        accum = accum + (s1 * 0.72 + s2 * 0.28) * w;
        wSum = wSum + w;
      }
      col = accum / wSum;
    }

    // Per-object temporal shutter blend (smooths moving cars, peds & fast foliage cleanly)
    if (u.p3.w > 0.5 && objMotion > 0.01) {
      let temporalAmt = clamp(objMotion * (0.18 + u.p0.z * 0.16) * blurStr, 0.0, 0.34);
      col = mix(col, prevRgb, temporalAmt);
    }
  }

  // 2. Single-Pass Fast Anamorphic Bloom (headlights, Vice neon, ocean speculars)
  let bloomStr = u.p1.y;
  if (bloomStr > 0.02 && tier < 1.5) {
    let r1 = 3.2;
    let r2 = 7.5;
    let b0 = loadCur(pos.xy + vec2f( r1,  r1), maxC);
    let b1 = loadCur(pos.xy + vec2f(-r1,  r1), maxC);
    let b2 = loadCur(pos.xy + vec2f( r1, -r1), maxC);
    let b3 = loadCur(pos.xy + vec2f(-r1, -r1), maxC);
    var glow = (max(b0 - vec3f(0.76), vec3f(0.0)) +
                max(b1 - vec3f(0.76), vec3f(0.0)) +
                max(b2 - vec3f(0.76), vec3f(0.0)) +
                max(b3 - vec3f(0.76), vec3f(0.0))) * 0.25;
    if (tier < 0.5) {
      let h0 = loadCur(pos.xy + vec2f( r2, 0.0), maxC);
      let h1 = loadCur(pos.xy + vec2f(-r2, 0.0), maxC);
      let h2 = loadCur(pos.xy + vec2f(0.0,  r2), maxC);
      let h3 = loadCur(pos.xy + vec2f(0.0, -r2), maxC);
      let wide = (max(h0 - vec3f(0.78), vec3f(0.0)) +
                  max(h1 - vec3f(0.78), vec3f(0.0)) +
                  max(h2 - vec3f(0.78), vec3f(0.0)) +
                  max(h3 - vec3f(0.78), vec3f(0.0))) * 0.25;
      glow = glow * 0.62 + wide * 0.55;
    }
    col = col + glow * vec3f(1.12, 0.96, 1.04) * (bloomStr * 0.85);
  }

  // 3. Subtle Volumetric Sun Shafts (Leonida Golden Hour crepuscular rays)
  let shaftStr = u.p1.z;
  if (shaftStr > 0.02 && tier < 1.5) {
    let sunPos = vec2f(u.p2.x, u.p2.y) * res;
    let toSun = sunPos - pos.xy;
    let sunDist = length(toSun) / res.x;
    if (sunDist < 0.85) {
      var ray = 0.0;
      let stepVec = toSun * 0.14;
      var decay = 1.0;
      for (var s: i32 = 1; s <= 4; s = s + 1) {
        let sc = loadCur(pos.xy + stepVec * f32(s), maxC);
        let hi = max(luma(sc) - 0.72, 0.0);
        ray = ray + hi * decay;
        decay = decay * 0.74;
      }
      let sunFalloff = smoothstep(0.85, 0.05, sunDist);
      col = col + vec3f(1.00, 0.74, 0.56) * (ray * sunFalloff * shaftStr * 0.28);
    }
  }

  // 4. Warm Vice City / Leonida ACES Filmic Color Grading & Lighting
  let lightStr = u.p1.x;
  if (lightStr > 0.01) {
    let lum = luma(col);
    // Lift cool coastal teal bounce in shadows, warm coral-amber sun in highlights
    let shadowTint = vec3f(0.93, 1.02, 1.09);
    let midTint    = vec3f(1.04, 1.01, 0.96);
    let hiTint     = vec3f(1.09, 0.99, 0.92);
    let graded = col * mix(mix(shadowTint, midTint, smoothstep(0.05, 0.48, lum)),
                           hiTint, smoothstep(0.48, 0.95, lum));
    // Vibrant Leonida micro-saturation (+13%)
    let sat = mix(vec3f(luma(graded)), graded, 1.13);
    // Subtle filmic exposure + ACES highlight rolloff
    let filmic = acesFilmic(sat * 1.09);
    // Gentle sunset horizon atmospheric warmth on upper third
    let skyWarm = smoothstep(0.58, 0.0, uv.y) * 0.045 * lightStr;
    let finalLit = mix(col, filmic, clamp(lightStr * 0.78, 0.0, 1.0)) + vec3f(skyWarm, skyWarm * 0.42, skyWarm * 0.56);
    col = finalLit;
  }

  // 5. GTA 6 Focus Mode (Heightened Awareness / Eagle Eye visual grade)
  let focusMix = u.p2.z;
  if (focusMix > 0.01) {
    let lumF = luma(col);
    let eR = luma(loadCur(pos.xy + vec2f(1.5, 0.0), maxC));
    let eD = luma(loadCur(pos.xy + vec2f(0.0, 1.5), maxC));
    let edge = clamp((abs(lumF - eR) + abs(lumF - eD)) * 3.8, 0.0, 1.0);
    let focusTint = mix(vec3f(lumF) * vec3f(0.76, 0.74, 1.06), col, 0.58) + vec3f(1.0, 0.78, 0.36) * (edge * 0.35);
    let vig = smoothstep(0.32, 0.85, length(uv - vec2f(0.5, 0.5)));
    col = mix(col, focusTint - vec3f(0.05, 0.07, 0.02) * vig, focusMix * 0.82);
  }

  return vec4f(clamp(col, vec3f(0.0), vec3f(1.0)), 1.0);
}
`;

  self.__vbxGta6Present = function(device, canvasCtx, canvasFormat, getEncoder, t, dtMs, drawsPerFrame) {
    // Update GTX 1050 Performance: Auto closed-loop governor + live Dev Settings FPS/frame-time telemetry
    const now = performance.now();
    if (dtMs > 0.5 && dtMs < 250) {
      fxState.emaMs = fxState.emaMs * 0.90 + dtMs * 0.10;
    }
    if (fxState.perfAuto) {
      if (fxState.emaMs > 16.4 && fxState.perfTier < 2) {
        fxState.perfTier++;
        fxState.lastTierUpT = now;
      } else if (fxState.emaMs < 14.4 && fxState.perfTier > 0 && (now - fxState.lastTierUpT) > 2600) {
        fxState.perfTier--;
        fxState.lastTierUpT = now;
      }
    }
    if (now - fxState.lastPerfPostT >= 350) {
      fxState.lastPerfPostT = now;
      try {
        if (!gta6PerfBc) gta6PerfBc = new BroadcastChannel('vbx-gta6-perf');
        gta6PerfBc.postMessage({
          fps: Math.min(240, 1000 / Math.max(1, fxState.emaMs)),
          frameMs: fxState.emaMs,
          perfTier: fxState.perfTier,
          draws: drawsPerFrame || 0,
          w: t.desc.size.width,
          h: t.desc.size.height
        });
      } catch (e) {}
    }

    if (fxState.failed || !fxState.enabled) return false;

    try {
      const w = t.desc.size.width;
      const h = t.desc.size.height;
      const fmt = t.desc.format;

      if (!gta6Pipe) {
        const mod = device.createShaderModule({ code: WGSL_GTA6_POST, label: 'vbx_gta6_post_blit' });
        gta6Pipe = device.createRenderPipeline({
          layout: 'auto',
          vertex: { module: mod, entryPoint: 'vs' },
          fragment: { module: mod, entryPoint: 'fs', targets: [{ format: canvasFormat }] }
        });
        gta6UniformBuf = device.createBuffer({
          size: 64,
          usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST
        });
      }

      if (!gta6PrevTex || gta6PrevW !== w || gta6PrevH !== h || gta6PrevFmt !== fmt) {
        if (gta6PrevTex) {
          try { gta6PrevTex.destroy(); } catch (e) {}
        }
        gta6PrevTex = device.createTexture({
          size: { width: w, height: h, depthOrArrayLayers: 1 },
          dimension: '2d',
          format: fmt,
          usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST
        });
        gta6PrevW = w;
        gta6PrevH = h;
        gta6PrevFmt = fmt;
        gta6HasPrev = 0;
        t.__vbxGta6BG = null;
        t.__vbxGta6PrevRef = null;
      }

      // Pack 16 floats (64 bytes) with zero GC allocations
      uData[0] = fxState.velX;
      uData[1] = fxState.velY;
      uData[2] = fxState.speed;
      uData[3] = fxState.blurStrength;
      uData[4] = fxState.lightStrength;
      uData[5] = fxState.bloomStrength;
      uData[6] = fxState.shaftStrength;
      uData[7] = (now - fxState.t0) * 0.001;
      uData[8] = fxState.sunU;
      uData[9] = fxState.sunV;
      uData[10] = fxState.focusMix;
      uData[11] = fxState.perfTier;
      uData[12] = w;
      uData[13] = h;
      uData[14] = fxState.enabled;
      uData[15] = gta6HasPrev;
      device.queue.writeBuffer(gta6UniformBuf, 0, uData);

      if (!t.__vbxGta6BG || t.__vbxGta6PrevRef !== gta6PrevTex) {
        t.__vbxGta6BG = device.createBindGroup({
          layout: gta6Pipe.getBindGroupLayout(0),
          entries: [
            { binding: 0, resource: t.tex.createView({ dimension: '2d', baseMipLevel: 0, mipLevelCount: 1 }) },
            { binding: 1, resource: gta6PrevTex.createView({ dimension: '2d', baseMipLevel: 0, mipLevelCount: 1 }) },
            { binding: 2, resource: { buffer: gta6UniformBuf } }
          ]
        });
        t.__vbxGta6PrevRef = gta6PrevTex;
      }

      const enc = getEncoder();
      const pass2 = enc.beginRenderPass({
        colorAttachments: [{ view: canvasCtx.getCurrentTexture().createView(), loadOp: 'clear', storeOp: 'store' }]
      });
      pass2.setPipeline(gta6Pipe);
      pass2.setBindGroup(0, t.__vbxGta6BG);
      pass2.draw(3);
      pass2.end();

      // Snapshot current backbuffer into prevTex for next frame's per-object optical motion blur (~0.08 ms GPU copy)
      if ((t.desc.usage & GPUTextureUsage.COPY_SRC) !== 0) {
        enc.copyTextureToTexture(
          { texture: t.tex, mipLevel: 0 },
          { texture: gta6PrevTex, mipLevel: 0 },
          { width: w, height: h, depthOrArrayLayers: 1 }
        );
        gta6HasPrev = 1;
      }
      return true;
    } catch (err) {
      fxState.failed = true;
      return false;
    }
  };
})();
