package com.ps5.mobile.bridge;

import android.content.pm.PackageInfo;
import android.net.Uri;
import android.os.Build;
import android.util.Log;
import android.webkit.CookieManager;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;

import com.ps5.mobile.config.LaunchConfig;

import org.chromium.support_lib_boundary.ProfileBoundaryInterface;
import org.chromium.support_lib_boundary.ProfileStoreBoundaryInterface;
import org.chromium.support_lib_boundary.WebViewProviderBoundaryInterface;
import org.chromium.support_lib_boundary.WebViewProviderFactoryBoundaryInterface;

import java.io.ByteArrayInputStream;
import java.io.ByteArrayOutputStream;
import java.io.InputStream;
import java.lang.reflect.InvocationHandler;
import java.lang.reflect.Method;
import java.lang.reflect.Proxy;
import java.net.HttpURLConnection;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.Collections;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;
import java.util.zip.GZIPInputStream;

/**
 * PS5 Mobile v3.0 Cross-Origin Isolation + Ultra Optimize Worker Patcher:
 *
 * 1) Opts https://playgta5.com into Chromium WebView's Cross-Origin Isolated Allowlist
 *    + injects Document-Isolation-Policy: isolate-and-require-corp for real SharedArrayBuffer.
 * 2) Intercepts playgta5.com's wgpu_worker.js & io_worker.js and applies live-verified
 *    Android + Ultra Optimize Mode low-VRAM/low-RAM patches:
 *    - MIT BC1-BC7 software texture decoding when Android GPUs lack hardware BC.
 *    - ULTRA OPTIMIZE BC TEXTURE MIP-DROP (256px / 128px cap): cuts uncompressed Android
 *      texture VRAM by 75%–88% and skips top-mip CPU BC decode & upload overhead!
 *    - Uniform ring shrinking (8MB -> 2MB / 1MB) & Buffer Arena shrinking (16MB -> 4MB).
 *    - Tight Vulkan BindGroup cache eviction (24000 -> 3072 / 1536) + proxy-texture leak fix
 *      on DESTROY_OBJECT.
 *    - Single-thread shader compilation (AHEAD_MAX=1), capped shader fetches (4), fast
 *      shader pack sweep (1.5s), capped anisotropy (1x), disabled volumetric Roadster FX.
 *    - IO worker RAM cache cap (192–768MB -> 32MB / 16MB), tightened lanes & read-ahead.
 *    - Live VRAM & VRAM-saved telemetry broadcast + Android onTrimMemory emergency purge hook!
 */
public final class WebViewIsolationBridge {

    private static final String TAG = "Ps5WebViewIsolation";
    private static final String FEATURE_COI_ALLOWLIST = "CROSS_ORIGIN_ISOLATED_ALLOW_LIST";
    private static final String FEATURE_MULTI_PROFILE = "MULTI_PROFILE";
    private static final String FEATURE_DOCUMENT_START = "DOCUMENT_START_SCRIPT";
    private static final Pattern CHARSET_PATTERN = Pattern.compile("charset=\"?([^;\"]+)", Pattern.CASE_INSENSITIVE);

    private static final String DEFAULT_ULTRA_JSON =
            "{\"enabled\":false,\"level\":1,\"maxTex\":0,\"ringMb\":8,\"arenaMb\":16,\"bgLimit\":24000,"
                    + "\"ioMemMb\":192,\"aheadMax\":2,\"shaderFetches\":16,\"noHints\":false,"
                    + "\"noRoadster\":false,\"capAniso\":false,\"nearMip\":false,\"lowEnd\":false}";

    private static final Set<String> TRUSTED_ORIGINS;
    static {
        Set<String> s = new HashSet<>();
        s.add("https://playgta5.com");
        s.add("https://www.playgta5.com");
        TRUSTED_ORIGINS = Collections.unmodifiableSet(s);
    }

    private final WebViewProviderFactoryBoundaryInterface factory;
    private final Set<String> supportedFeatures;
    private final boolean coiAllowlistSupported;
    private final boolean multiProfileSupported;
    private final boolean documentStartSupported;
    private volatile boolean allowlistApplied = false;
    private volatile String activeUserAgent = "";
    private volatile String bcDecodeScript = "";
    private volatile String ultraConfigJson = DEFAULT_ULTRA_JSON;

    public WebViewIsolationBridge() {
        WebViewProviderFactoryBoundaryInterface f = null;
        Set<String> feats = new HashSet<>();
        try {
            ClassLoader webViewCl = getWebViewClassLoader();
            if (webViewCl != null) {
                Class<?> glue = Class.forName(
                        "org.chromium.support_lib_glue.SupportLibReflectionUtil", false, webViewCl);
                Method createFactory = glue.getDeclaredMethod("createWebViewProviderFactory");
                InvocationHandler ih = (InvocationHandler) createFactory.invoke(null);
                if (ih != null) {
                    f = castProxy(WebViewProviderFactoryBoundaryInterface.class, ih);
                    String[] arr = f.getSupportedFeatures();
                    if (arr != null) {
                        Collections.addAll(feats, arr);
                    }
                }
            }
        } catch (Throwable t) {
            Log.w(TAG, "WebView support library glue unavailable", t);
        }
        this.factory = f;
        this.supportedFeatures = Collections.unmodifiableSet(feats);
        this.multiProfileSupported = hasFeature(FEATURE_MULTI_PROFILE);
        this.coiAllowlistSupported = hasFeature(FEATURE_COI_ALLOWLIST);
        this.documentStartSupported = hasFeature(FEATURE_DOCUMENT_START);
    }

    private boolean hasFeature(String name) {
        if (supportedFeatures.contains(name)) return true;
        String devPrefix = name + ":";
        for (String f : supportedFeatures) {
            if (f != null && f.startsWith(devPrefix)) return true;
        }
        return false;
    }

    public boolean isCrossOriginIsolationSupported() {
        return factory != null && multiProfileSupported && coiAllowlistSupported;
    }

    public boolean isAllowlistApplied() {
        return allowlistApplied;
    }

    public boolean isDocumentStartSupported() {
        return factory != null && documentStartSupported;
    }

    public void setUserAgent(String ua) {
        this.activeUserAgent = ua != null ? ua : "";
    }

    public void setBcDecodeScript(String js) {
        this.bcDecodeScript = js != null ? js : "";
    }

    public void setLaunchConfig(LaunchConfig cfg) {
        this.ultraConfigJson = (cfg != null) ? cfg.toUltraWorkerConfigJson() : DEFAULT_ULTRA_JSON;
    }

    /**
     * Applies Profile.setCrossOriginIsolatedAllowList({"https://playgta5.com", ...})
     * and installs DOCUMENT_START_SCRIPT on the dedicated GTA V WebView. Must run on UI thread.
     */
    public void applyToWebView(WebView webView, String documentStartScript) {
        if (factory == null || webView == null) return;

        if (documentStartSupported && documentStartScript != null && !documentStartScript.isEmpty()) {
            try {
                InvocationHandler providerIh = factory.createWebView(webView);
                WebViewProviderBoundaryInterface provider = castProxy(WebViewProviderBoundaryInterface.class, providerIh);
                provider.addDocumentStartJavaScript(
                        documentStartScript,
                        new String[]{"https://playgta5.com", "https://www.playgta5.com"});
            } catch (Throwable t) {
                Log.w(TAG, "addDocumentStartJavaScript failed", t);
            }
        }

        if (isCrossOriginIsolationSupported()) {
            boolean applied = false;
            try {
                InvocationHandler providerIh = factory.createWebView(webView);
                WebViewProviderBoundaryInterface provider = castProxy(WebViewProviderBoundaryInterface.class, providerIh);
                InvocationHandler profileIh = provider.getProfile();
                if (profileIh != null) {
                    ProfileBoundaryInterface profile = castProxy(ProfileBoundaryInterface.class, profileIh);
                    profile.setCrossOriginIsolatedAllowList(TRUSTED_ORIGINS);
                    applied = true;
                    try {
                        if (profile.canConfigureIsolatedSites()) {
                            profile.configureIsolatedSites(TRUSTED_ORIGINS);
                        }
                    } catch (Throwable ignored) {}
                }
            } catch (Throwable t) {
                Log.w(TAG, "WebView getProfile().setCrossOriginIsolatedAllowList failed", t);
            }

            if (!applied) {
                try {
                    InvocationHandler storeIh = factory.getProfileStore();
                    if (storeIh != null) {
                        ProfileStoreBoundaryInterface store = castProxy(ProfileStoreBoundaryInterface.class, storeIh);
                        InvocationHandler defIh = store.getOrCreateProfile("Default");
                        if (defIh != null) {
                            ProfileBoundaryInterface profile = castProxy(ProfileBoundaryInterface.class, defIh);
                            profile.setCrossOriginIsolatedAllowList(TRUSTED_ORIGINS);
                            applied = true;
                        }
                    }
                } catch (Throwable t) {
                    Log.w(TAG, "ProfileStore Default setCrossOriginIsolatedAllowList failed", t);
                }
            }
            allowlistApplied = applied;
        }
    }

    public boolean shouldInterceptDocument(WebResourceRequest request) {
        if (request == null || !isCrossOriginIsolationSupported()) return false;
        if (!"GET".equalsIgnoreCase(request.getMethod())) return false;
        String origin = originOf(request.getUrl());
        if (origin == null || !TRUSTED_ORIGINS.contains(origin)) return false;
        if (request.isForMainFrame()) return true;

        Map<String, String> headers = request.getRequestHeaders();
        if (headers == null) return false;
        String dest = headerIgnoreCase(headers, "Sec-Fetch-Dest");
        if (dest != null) {
            return "document".equals(dest) || "iframe".equals(dest) || "frame".equals(dest);
        }
        String accept = headerIgnoreCase(headers, "Accept");
        return accept != null && accept.startsWith("text/html");
    }

    public boolean shouldInterceptWorkerPatch(WebResourceRequest request) {
        if (request == null) return false;
        if (!"GET".equalsIgnoreCase(request.getMethod())) return false;
        Uri uri = request.getUrl();
        String origin = originOf(uri);
        if (origin == null || !TRUSTED_ORIGINS.contains(origin)) return false;
        String path = uri.getPath();
        if (path == null) return false;
        return path.endsWith("/wgpu_worker.js") || path.endsWith("/io_worker.js");
    }

    public WebResourceResponse fetchPatchedWorker(WebResourceRequest request) {
        Uri uri = request.getUrl();
        String urlStr = uri.toString();
        String path = uri.getPath() != null ? uri.getPath() : "";
        boolean isWgpu = path.endsWith("/wgpu_worker.js");
        boolean isIo = path.endsWith("/io_worker.js");
        if (!isWgpu && !isIo) return null;

        HttpURLConnection conn = null;
        try {
            conn = openGetConnection(urlStr, request.getRequestHeaders());
            int code = conn.getResponseCode();
            if (code != 200) {
                conn.disconnect();
                return null;
            }

            Map<String, String> respHeaders = extractResponseHeaders(conn, urlStr, false);
            byte[] rawBytes = readBodyBytes(conn, code, 4 * 1024 * 1024);
            conn.disconnect();
            if (rawBytes == null || rawBytes.length == 0) return null;

            String src = new String(rawBytes, StandardCharsets.UTF_8);
            String patched = isWgpu ? patchWgpuWorker(src) : patchIoWorker(src);

            respHeaders.put("Content-Type", "application/javascript; charset=utf-8");
            respHeaders.put("Cross-Origin-Resource-Policy", "same-origin");
            respHeaders.put("Cross-Origin-Embedder-Policy", "require-corp");
            respHeaders.put("Cross-Origin-Opener-Policy", "same-origin");
            respHeaders.put("Cache-Control", "no-store");

            byte[] outBytes = patched.getBytes(StandardCharsets.UTF_8);
            return new WebResourceResponse(
                    "application/javascript", "utf-8", 200, "OK", respHeaders,
                    new ByteArrayInputStream(outBytes));
        } catch (Throwable t) {
            Log.w(TAG, "Worker patch failed for " + urlStr + " (falling back to stock)", t);
            if (conn != null) conn.disconnect();
            return null;
        }
    }

    /**
     * Patches live playgta5.com wgpu_worker.js with:
     * 1) Ultra Optimize Runtime Header (__PS5_ULTRA config, BC mip-drop calculator, live VRAM-saved
     *    telemetry, and Android onTrimMemory emergency cache purge BroadcastChannel).
     * 2) MIT BC1-BC7 software texture decoding when !device.features.has('texture-compression-bc').
     * 3) BC Texture Mip-Drop in createTexture / uploadTexture / subresourceOf / srvView /
     *    copyRegion / copyResource (cuts Android uncompressed texture VRAM by 75%–88%).
     * 4) Shrunk uniform RING_CHUNK, shrunk ARENA_SIZE, tight BG_LIMIT, DESTROY_OBJECT proxy leak fix,
     *    1-thread shader compilation (AHEAD_MAX), reduced SHADER_FETCHES, fast shader pack sweep,
     *    capped anisotropy & nearest mipmap (Extreme), skipped Roadster volumetric FX, and faster world-ready gate.
     */
    String patchWgpuWorker(String src) {
        String out = src;
        final String ultraCfg = ultraConfigJson != null ? ultraConfigJson : DEFAULT_ULTRA_JSON;
        final String anchorStrict = "'use strict';";

        // 1. Always inject __PS5_ULTRA header + mip-drop helper + emergency trim listener
        if (out.contains(anchorStrict)) {
            String ultraHeader = anchorStrict + "\n"
                    + "/* PS5 Mobile v3.0 Ultra Optimize Engine */\n"
                    + "const __PS5_ULTRA = " + ultraCfg + ";\n"
                    + "let __ps5VramSaved = 0;\n"
                    + "function __ps5CalcMipSkip(dim, w, h, mips, format, isBcOrig, bind, samples) {\n"
                    + "  if (!__PS5_ULTRA.maxTex || __PS5_ULTRA.maxTex <= 0) return 0;\n"
                    + "  if (dim !== 2 || samples > 1 || mips < 3) return 0;\n"
                    + "  if (bind & (BIND_RT | BIND_DS | BIND_UAV)) return 0;\n"
                    + "  if (!isBcOrig) return 0;\n"
                    + "  const maxD = __PS5_ULTRA.maxTex;\n"
                    + "  const swDecode = (typeof bcDecode !== 'undefined' && bcDecode);\n"
                    + "  let skip = 0, cw = w, ch = h;\n"
                    + "  while (skip < mips - 1 && Math.max(cw, ch) > maxD) {\n"
                    + "    const nw = Math.max(1, cw >> 1), nh = Math.max(1, ch >> 1);\n"
                    + "    if (nw < 4 || nh < 4) break;\n"
                    + "    if (!swDecode && format.startsWith('bc') && ((nw & 3) !== 0 || (nh & 3) !== 0)) break;\n"
                    + "    cw = nw; ch = nh; skip++;\n"
                    + "  }\n"
                    + "  return skip;\n"
                    + "}\n"
                    + "try {\n"
                    + "  const __ps5CtrlBc = new BroadcastChannel('ps5-ultra-ctrl');\n"
                    + "  __ps5CtrlBc.onmessage = function (ev) {\n"
                    + "    if (!ev.data || ev.data.cmd !== 'trim') return;\n"
                    + "    try {\n"
                    + "      if (typeof bindGroupCache !== 'undefined') bindGroupCache.clear();\n"
                    + "      if (typeof progsWithFast !== 'undefined') { for (const pr of progsWithFast) { pr.fast = null; pr.fastAlt = null; } }\n"
                    + "      if (typeof packs !== 'undefined') { for (const [k, x] of packs) if (x && x.done) packs.delete(k); }\n"
                    + "      if (typeof decodeBuf !== 'undefined' && decodeBuf && decodeBuf.length > (1 << 20)) decodeBuf = null;\n"
                    + "      if (typeof logLine === 'function') logLine('[ps5-ultra] Memory trim flushed caches (tex=' + (texBytesAlive / 1048576 | 0) + 'MB, saved=' + (__ps5VramSaved / 1048576 | 0) + 'MB)');\n"
                    + "    } catch (_) {}\n"
                    + "  };\n"
                    + "} catch (_) {}\n";
            out = replaceFirstLiteral(out, anchorStrict, ultraHeader);
        }

        // 2. MIT BC1-BC7 software texture decoding for Android GPUs (Adreno/Mali/PowerVR)
        final String anchorMapFmt = "function mapFormat(f, bind) {";
        final String anchorInitDev = "device = await adapter.requestDevice({ requiredFeatures, requiredLimits: limits });";
        final String anchorCreateTex = "objs.set(id, { kind: 'texture', tex, desc, format: m.format, views: new Map(), a8: !!m.a8, bytes });";
        final String anchorUpload = "device.queue.writeTexture({ texture: o.tex, mipLevel: mip, origin }, data,";
        final String anchorCopyDims = "const w = hasBox ? r - l : m.w, h = hasBox ? b - t : m.h, dep = hasBox ? bk - f : m.d;";
        final String anchorCopyThree = "const three = s.desc.dimension === '3d';";

        boolean injectedBc = false;
        if (bcDecodeScript != null && !bcDecodeScript.isEmpty() && !out.contains("let bcDecode")) {
            if (out.contains(anchorMapFmt)
                    && out.contains(anchorInitDev)
                    && out.contains(anchorCreateTex)
                    && out.contains(anchorUpload)
                    && out.contains(anchorCopyDims)
                    && out.contains(anchorCopyThree)) {

                String candidate = out;

                String bcHeader = "/* PS5 Mobile Android BC1-BC7 software texture decoder (MIT) */\n"
                        + bcDecodeScript + "\n"
                        + "let bcDecode = false;\n"
                        + "const { decodeBC, BC_BLOCK_BYTES, BC_TEXEL_BYTES } = self.BCDecode;\n"
                        + "let decodeBuf = null;\n"
                        + "function decodeScratch(n) {\n"
                        + "  if (!decodeBuf || decodeBuf.length < n) decodeBuf = new Uint8Array(Math.max(n, __PS5_ULTRA.enabled ? 262144 : (1 << 20)));\n"
                        + "  return decodeBuf;\n"
                        + "}\n"
                        + "function copyBlocksDecoded(dstId, s, ss, d, ds, w, h, hasBox, l, t, dx, dy) {\n"
                        + "  const kind = d.decode, bb = BC_BLOCK_BYTES[kind], tb = BC_TEXEL_BYTES[kind];\n"
                        + "  const bpr = Math.ceil(w * bb / 256) * 256, MU = GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ, size = bpr * h;\n"
                        + "  const rb = device.createBuffer({ size: Math.max(4, size), usage: MU });\n"
                        + "  getEncoder().copyTextureToBuffer({ texture: s.tex, mipLevel: ss.mip, origin: { x: hasBox ? l : 0, y: hasBox ? t : 0, z: ss.layer } }, { buffer: rb, bytesPerRow: bpr, rowsPerImage: h }, { width: w, height: h, depthOrArrayLayers: 1 });\n"
                        + "  usedInEncoder.add(s);\n"
                        + "  flush('bc decode copy');\n"
                        + "  const gen = d.gen, dm = mipSize(d, ds.mip), tw = Math.min(w * 4, dm.w - dx), th = Math.min(h * 4, dm.h - dy);\n"
                        + "  rb.mapAsync(GPUMapMode.READ).then(() => {\n"
                        + "    try {\n"
                        + "      if (objs.get(dstId) === d && d.gen === gen && tw > 0 && th > 0) {\n"
                        + "        const outB = new Uint8Array(tw * th * tb);\n"
                        + "        decodeBC(kind, new Uint8Array(rb.getMappedRange()), 0, bpr, tw, th, outB, tw * tb);\n"
                        + "        device.queue.writeTexture({ texture: d.tex, mipLevel: ds.mip, origin: { x: dx, y: dy, z: ds.layer } }, outB, { bytesPerRow: tw * tb, rowsPerImage: th }, { width: tw, height: th, depthOrArrayLayers: 1 });\n"
                        + "      }\n"
                        + "    } finally { try { rb.unmap(); } catch (_) {} try { rb.destroy(); } catch (_) {} }\n"
                        + "  }, (e) => { try { rb.destroy(); } catch (_) {} logOnce('bcmap', 'BC decode copy failed: ' + (e && e.message || e)); });\n"
                        + "}\n"
                        + "function mapFormat(f, bind) {\n"
                        + "  const m = mapFormatBC(f, bind);\n"
                        + "  if (!bcDecode || !m.format.startsWith('bc')) return m;\n"
                        + "  const kind = m.format.slice(0, m.format.indexOf('-')), srgb = m.format.endsWith('-srgb');\n"
                        + "  const format = kind === 'bc4' ? 'r8unorm' : kind === 'bc5' ? 'rg8unorm' : kind === 'bc6h' ? 'rgba16float' : srgb ? 'rgba8unorm-srgb' : 'rgba8unorm';\n"
                        + "  return { format, views: m.views && [srgb ? 'rgba8unorm' : 'rgba8unorm-srgb'], decode: kind };\n"
                        + "}\n"
                        + "function mapFormatBC(f, bind) {";

                String initDevPatch = anchorInitDev + "\n"
                        + "  bcDecode = !device.features.has('texture-compression-bc');\n"
                        + "  if (typeof AHEAD_MAX === 'number' && AHEAD_MAX > __PS5_ULTRA.aheadMax) AHEAD_MAX = __PS5_ULTRA.aheadMax;\n"
                        + "  if (bcDecode || __PS5_ULTRA.enabled) {\n"
                        + "    const tag = (__PS5_ULTRA.enabled ? ('Ultra Optimize L' + __PS5_ULTRA.level + ' (BC cap ' + __PS5_ULTRA.maxTex + 'px, ring ' + __PS5_ULTRA.ringMb + 'MB)') : 'Android GPU') + (bcDecode ? ' + BC1-BC7 SW decode' : '');\n"
                        + "    logLine('[ps5-mobile] ' + tag);\n"
                        + "    try { if (typeof progressChannel !== 'undefined' && progressChannel) progressChannel.postMessage({ lines: ['[gpu] ' + tag] }); } catch (_) {}\n"
                        + "  }";

                String uploadPatch = "if (o.decode) {\n"
                        + "    o.gen++;\n"
                        + "    const ms = mipSize(o, mip), tw = Math.min(w, ms.w - x), th = Math.min(h, ms.h - y), tb = BC_TEXEL_BYTES[o.decode];\n"
                        + "    if (tw <= 0 || th <= 0) return;\n"
                        + "    const srcSlice = bytesPerRow * (rowsPerImage || Math.ceil(h / 4)), outBpr = tw * tb, outSlice = outBpr * th;\n"
                        + "    const outD = decodeScratch(outSlice * d);\n"
                        + "    for (let zi = 0; zi < d; zi++) decodeBC(o.decode, data, zi * srcSlice, bytesPerRow, tw, th, outD.subarray(zi * outSlice, (zi + 1) * outSlice), outBpr);\n"
                        + "    data = outD.subarray(0, outSlice * d); bpr = outBpr; rowsPerImage = th; w = tw; h = th;\n"
                        + "  }\n"
                        + "  " + anchorUpload;

                String copyDimsPatch = "let w = hasBox ? r - l : m.w, h = hasBox ? b - t : m.h; const dep = hasBox ? bk - f : m.d;";

                String copyThreePatch = anchorCopyThree + "\n"
                        + "  if (s.decode || d.decode) {\n"
                        + "    if (d.decode && !s.decode && !three && texelBytesOf(s.format) === BC_BLOCK_BYTES[d.decode]) { copyBlocksDecoded(dstId, s, ss, d, ds, w, h, hasBox, l, t, dx, dy); markColorDirty(d); return; }\n"
                        + "    if (!s.decode || !d.decode) { logOnce('bccopy' + s.format + d.format, 'copy ' + s.format + ' -> ' + d.format + ' skipped: BC decoded'); return; }\n"
                        + "    const sm = mipSize(s, ss.mip), dm = mipSize(d, ds.mip);\n"
                        + "    w = Math.min(w, sm.w - (hasBox ? l : 0), dm.w - dx); h = Math.min(h, sm.h - (hasBox ? t : 0), dm.h - dy);\n"
                        + "    if (w <= 0 || h <= 0) return;\n"
                        + "    d.gen++;\n"
                        + "  }";

                candidate = replaceFirstLiteral(candidate, anchorMapFmt, bcHeader);
                candidate = replaceFirstLiteral(candidate, anchorInitDev, initDevPatch);
                candidate = replaceFirstLiteral(candidate, anchorUpload, uploadPatch);
                candidate = replaceFirstLiteral(candidate, anchorCopyDims, copyDimsPatch);
                candidate = replaceFirstLiteral(candidate, anchorCopyThree, copyThreePatch);
                out = candidate;
                injectedBc = true;
                Log.i(TAG, "Injected BC1-BC7 software texture decoder into wgpu_worker.js");
            } else {
                Log.w(TAG, "wgpu_worker.js BC anchors changed upstream; skipping BC injection");
            }
        }

        // 3. ULTRA OPTIMIZE BC TEXTURE MIP-DROP ENGINE (cuts Android VRAM 75%–88%!)
        final String anchorCreateMap = "const m = mapFormat(dxgi, bind);";
        final String anchorUploadFlush = "if (usedInEncoder.has(o)) flush('texture upload');";
        final String anchorSubres = "function subresourceOf(t, sub) {";
        final String anchorSrvDesc = "const desc = { dimension: b.dim, baseMipLevel: Math.min(srv.a, total - 1), mipLevelCount: Math.max(1, Math.min(mipCount, total - srv.a)) };";
        final String anchorCopyMip = "const m = mipSize(s, ss.mip);";
        final String anchorCopyResMips = "const mips = Math.min(s.desc.mipLevelCount, d.desc.mipLevelCount);";

        if (out.contains(anchorCreateMap)
                && out.contains(anchorCreateTex)
                && out.contains(anchorUploadFlush)
                && out.contains(anchorSubres)
                && out.contains(anchorSrvDesc)
                && out.contains(anchorCopyMip)) {

            String createMapPatch = anchorCreateMap + "\n"
                    + "  const __origMips = mips;\n"
                    + "  const __isBcOrig = !!(m.decode || (m.format && m.format.startsWith('bc')));\n"
                    + "  const __mipSkip = __ps5CalcMipSkip(dim, w, h, mips, m.format || '', __isBcOrig, bind, samples);\n"
                    + "  let __origBytes = 0;\n"
                    + "  if (__mipSkip > 0) {\n"
                    + "    __origBytes = textureBytes({ size: { width: w, height: dim === 1 ? 1 : h, depthOrArrayLayers: dim === 3 ? d : arraySize }, mipLevelCount: mips, sampleCount: samples, dimension: '2d', format: m.format });\n"
                    + "    w = Math.max(1, w >> __mipSkip); h = Math.max(1, h >> __mipSkip); mips = Math.max(1, mips - __mipSkip);\n"
                    + "  }";

            String createTexPatch = "const __savedB = __mipSkip > 0 ? Math.max(0, __origBytes - bytes) : 0;\n"
                    + "  if (__savedB > 0) __ps5VramSaved += __savedB;\n"
                    + "  objs.set(id, { kind: 'texture', tex, desc, format: m.format, views: new Map(), a8: !!m.a8, "
                    + (injectedBc ? "decode: m.decode || null, gen: 0, " : "")
                    + "bytes, mipSkip: __mipSkip, origMips: __origMips, savedBytes: __savedB });";

            String uploadSkipPatch = "if (o.mipSkip) { if (mip < o.mipSkip) return; mip -= o.mipSkip; }\n"
                    + "  " + anchorUploadFlush;

            String subresPatch = anchorSubres + "\n"
                    + "  const __om = t.origMips || t.desc.mipLevelCount; return { mip: sub % __om, layer: Math.floor(sub / __om) };";

            String srvDescPatch = "const __sm = t.mipSkip || 0, __ab = Math.min(Math.max(0, srv.a - __sm), total - 1);\n"
                    + "  const __ac = (srv.b === 0xffffffff || srv.b === 0) ? (total - __ab) : Math.max(1, srv.b - Math.max(0, __sm - srv.a));\n"
                    + "  const desc = { dimension: b.dim, baseMipLevel: __ab, mipLevelCount: Math.max(1, Math.min(__ac, total - __ab)) };";

            String copyMipPatch = "if ((s.mipSkip && ss.mip < s.mipSkip) || (d.mipSkip && ds.mip < d.mipSkip)) return;\n"
                    + "  if (s.mipSkip) ss.mip -= s.mipSkip;\n"
                    + "  if (d.mipSkip) ds.mip -= d.mipSkip;\n"
                    + "  " + anchorCopyMip;

            out = replaceFirstLiteral(out, anchorCreateMap, createMapPatch);
            out = replaceFirstLiteral(out, anchorCreateTex, createTexPatch);
            out = replaceFirstLiteral(out, anchorUploadFlush, uploadSkipPatch);
            out = replaceFirstLiteral(out, anchorSubres, subresPatch);
            out = replaceFirstLiteral(out, anchorSrvDesc, srvDescPatch);
            out = replaceFirstLiteral(out, anchorCopyMip, copyMipPatch);

            if (out.contains(anchorCopyResMips)) {
                String copyResPatch = "if (s.mipSkip || d.mipSkip) {\n"
                        + "    const sO = s.origMips || s.desc.mipLevelCount, dO = d.origMips || d.desc.mipLevelCount, lim = Math.min(sO, dO);\n"
                        + "    for (let om = Math.max(s.mipSkip || 0, d.mipSkip || 0); om < lim; om++) {\n"
                        + "      const smip = om - (s.mipSkip || 0), dmip = om - (d.mipSkip || 0), sm = mipSize(s, smip), dm = mipSize(d, dmip);\n"
                        + "      const ly = s.desc.dimension === '3d' ? Math.min(sm.d, dm.d) : Math.min(s.desc.size.depthOrArrayLayers, d.desc.size.depthOrArrayLayers);\n"
                        + "      try { getEncoder().copyTextureToTexture({ texture: s.tex, mipLevel: smip }, { texture: d.tex, mipLevel: dmip }, { width: Math.min(sm.w, dm.w), height: Math.min(sm.h, dm.h), depthOrArrayLayers: ly }); } catch (e) { logOnce('copyfail2', 'copyTextureToTexture (resource) failed: ' + e.message); }\n"
                        + "    }\n"
                        + "    markDepthDirty(d); markColorDirty(d); usedInEncoder.add(s); usedInEncoder.add(d); return;\n"
                        + "  }\n"
                        + "  " + anchorCopyResMips;
                out = replaceFirstLiteral(out, anchorCopyResMips, copyResPatch);
            }
        } else if (injectedBc && out.contains(anchorCreateTex)) {
            out = replaceFirstLiteral(out, anchorCreateTex,
                    "objs.set(id, { kind: 'texture', tex, desc, format: m.format, views: new Map(), a8: !!m.a8, decode: m.decode || null, gen: 0, bytes });");
        }

        // 4. Fix DESTROY_OBJECT proxy-texture leak & update saved-VRAM counter
        out = replaceFirstLiteral(out,
                "if (o.tex) { o.tex.destroy(); texBytesAlive -= o.bytes || 0; texCount--; }",
                "if (o.tex) { o.tex.destroy(); texBytesAlive -= o.bytes || 0; texCount--; "
                        + "if (o.savedBytes) __ps5VramSaved = Math.max(0, __ps5VramSaved - o.savedBytes); "
                        + "if (o.proxy_depth && o.proxy_depth.tex) { try { o.proxy_depth.tex.destroy(); } catch (_) {} o.proxy_depth = null; } "
                        + "if (o.proxy_stencil && o.proxy_stencil.tex) { try { o.proxy_stencil.tex.destroy(); } catch (_) {} o.proxy_stencil = null; } "
                        + "if (o.proxy_fdepth && o.proxy_fdepth.tex) { try { o.proxy_fdepth.tex.destroy(); } catch (_) {} o.proxy_fdepth = null; } "
                        + "if (o.views) o.views.clear(); o.blitBG = null; }");

        // 5. Shrink Uniform Ring (8MB -> 2MB/1MB), Buffer Arenas (16MB -> 4MB), BindGroup cache (24000 -> 3072/1536)
        out = replaceFirstLiteral(out,
                "const RING_CHUNK = 8 << 20, UBO_WINDOW = 65536;",
                "const RING_CHUNK = (__PS5_ULTRA.ringMb << 20), UBO_WINDOW = 65536;");
        out = replaceFirstLiteral(out,
                "const ARENA_SIZE = 16 << 20, ARENA_MAX_ALLOC = 2 << 20;",
                "const ARENA_SIZE = (__PS5_ULTRA.arenaMb << 20), ARENA_MAX_ALLOC = 2 << 20;");
        out = replaceFirstLiteral(out,
                "const BG_LIMIT = 24000;",
                "const BG_LIMIT = __PS5_ULTRA.bgLimit;");

        // 6. Shader fetch concurrency & fast shader pack sweep (frees tens of MB RAM quickly)
        out = replaceFirstLiteral(out,
                "const SHADER_FETCHES = 16, shaderQueue = [];",
                "const SHADER_FETCHES = __PS5_ULTRA.shaderFetches, shaderQueue = [];");
        out = replaceFirstLiteral(out,
                "now - x.last > 8000) packs.delete(n); }, 4000);",
                "now - x.last > (__PS5_ULTRA.enabled ? 1500 : 8000)) packs.delete(n); }, __PS5_ULTRA.enabled ? 1000 : 4000);");

        // 7. Mobile GPU sampler bandwidth optimization (cap 16x anisotropy -> 1x; nearest mip in Extreme)
        out = replaceFirstLiteral(out,
                "if (aniso) { d.magFilter = d.minFilter = d.mipmapFilter = 'linear'; d.maxAnisotropy = Math.max(1, Math.min(16, words[5])); }",
                "if (aniso) { d.magFilter = d.minFilter = 'linear'; d.mipmapFilter = __PS5_ULTRA.nearMip ? 'nearest' : 'linear'; d.maxAnisotropy = __PS5_ULTRA.capAniso ? 1 : Math.max(1, Math.min(16, words[5])); } "
                        + "if (__PS5_ULTRA.nearMip) d.mipmapFilter = 'nearest';");

        // 8. Skip heavy volumetric 3D Roadster FX compute/render passes on low-VRAM phones
        out = replaceFirstLiteral(out,
                "case 48 /* ROADSTER_FX */: roadsterFx(p); break;",
                "case 48 /* ROADSTER_FX */: if (!__PS5_ULTRA.noRoadster) roadsterFx(p); break;");

        // 9. Broadcast live VRAM used & VRAM saved alongside FPS to native Android HUD!
        out = replaceFirstLiteral(out,
                "fpsChannel.postMessage({ fps: fpsOverlayN * 1000 / (tn - fpsOverlayT) });",
                "fpsChannel.postMessage({ fps: fpsOverlayN * 1000 / (tn - fpsOverlayT), "
                        + "vramTexMb: Math.round(texBytesAlive / 1048576), "
                        + "vramBufMb: Math.round((bufBytesAlive + (typeof arenaBytes === 'number' ? arenaBytes : 0)) / 1048576), "
                        + "vramSavedMb: Math.round(__ps5VramSaved / 1048576), "
                        + "texCount: texCount, ultraOn: !!__PS5_ULTRA.enabled });");

        // 10. Lower world-ready gate for low-draw Ultra/Potato scenes & cap parallel shader compiles
        out = replaceFirstLiteral(out,
                "if (!worldSent && (worldSince || d > 300)) {",
                "if (!worldSent && (worldSince || d > (__PS5_ULTRA.enabled ? 60 : 80))) {");
        out = replaceFirstLiteral(out,
                "if ((worldClean && now - worldClean >= 1500) || now - worldSince >= 60000) {",
                "if ((worldClean && now - worldClean >= 1500) || now - worldSince >= (__PS5_ULTRA.enabled ? 12000 : 15000)) {");
        out = replaceFirstLiteral(out,
                "Math.max(2, Math.min(8, (self.navigator.hardwareConcurrency || 4) - 1))",
                "__PS5_ULTRA.aheadMax");

        return out;
    }

    /**
     * Patches live playgta5.com io_worker.js with Ultra Optimize RAM & socket hardening:
     * - Caps memCache fallback (192–768MB -> 32MB Ultra / 16MB Extreme).
     * - Shrinks concurrent fetch lanes, read-ahead & hint queues to eliminate RAM spikes.
     * - Listens on BroadcastChannel('ps5-ultra-ctrl') for Android onTrimMemory emergency flushes.
     * - Increases transient retry attempts from 7 -> 11 for mobile network stability.
     */
    String patchIoWorker(String src) {
        String out = src;
        final String ultraCfg = ultraConfigJson != null ? ultraConfigJson : DEFAULT_ULTRA_JSON;

        out = replaceFirstLiteral(out,
                "'use strict';",
                "'use strict';\n"
                        + "const __PS5_ULTRA = " + ultraCfg + ";\n"
                        + "try {\n"
                        + "  new BroadcastChannel('ps5-ultra-ctrl').onmessage = function (ev) {\n"
                        + "    if (!ev.data || ev.data.cmd !== 'trim') return;\n"
                        + "    try {\n"
                        + "      if (typeof memCache !== 'undefined') { memCache.clear(); memBytes = 0; }\n"
                        + "      if (typeof lowQueue !== 'undefined') lowQueue.length = 0;\n"
                        + "    } catch (_) {}\n"
                        + "  };\n"
                        + "} catch (_) {}");

        out = replaceFirstLiteral(out,
                "const BS = 4096, MAX_RUN = 256, MAX_AHEAD = 512 * 1024, FIRST_AHEAD = 64 * 1024, AHEAD_MIN_READ = 65536;",
                "const BS = 4096, MAX_RUN = __PS5_ULTRA.enabled ? 128 : 256, MAX_AHEAD = (__PS5_ULTRA.enabled ? (__PS5_ULTRA.level >= 2 ? 64 : 128) : 512) * 1024, FIRST_AHEAD = (__PS5_ULTRA.enabled ? 32 : 64) * 1024, AHEAD_MIN_READ = 65536;");

        // Live build MEM_MAX (192MB–768MB!) -> clamped to 32MB Ultra / 16MB Extreme
        out = replaceFirstLiteral(out,
                "const MEM_MAX = (() => { const g = (self.navigator && self.navigator.deviceMemory) || 4; return (g >= 8 ? 768 : g >= 4 ? 192 : 96) * 1048576; })();",
                "const MEM_MAX = (__PS5_ULTRA.ioMemMb || 64) * 1048576;");

        // Legacy fallback cap if older io_worker is served
        out = replaceFirstLiteral(out,
                "while (memBytes > 48 * 1048576)",
                "while (memBytes > ((__PS5_ULTRA.ioMemMb || 48) * 1048576))");

        out = replaceFirstLiteral(out,
                "const RUN_LANES = 32, BATCH_LANES = 4, RUN_GAP = 64;",
                "const RUN_LANES = __PS5_ULTRA.enabled ? (__PS5_ULTRA.level >= 2 ? 4 : 6) : 12, BATCH_LANES = __PS5_ULTRA.enabled ? 2 : 4, RUN_GAP = 64;");

        out = replaceFirstLiteral(out,
                "const HINT_PAR = 96, LOW_PAR = 48, HINT_QUEUE_MAX = 2000;",
                "const HINT_PAR = __PS5_ULTRA.enabled ? (__PS5_ULTRA.level >= 2 ? 6 : 12) : 24, LOW_PAR = __PS5_ULTRA.enabled ? (__PS5_ULTRA.level >= 2 ? 0 : 3) : 10, HINT_QUEUE_MAX = __PS5_ULTRA.enabled ? 300 : 2000;");

        out = replaceFirstLiteral(out,
                "if (attempt >= 7) { if (res) return res; throw err; }",
                "if (attempt >= 11) { if (res) return res; throw err; }");
        return out;
    }

    private static String replaceFirstLiteral(String source, String target, String replacement) {
        int idx = source.indexOf(target);
        if (idx < 0) return source;
        return source.substring(0, idx) + replacement + source.substring(idx + target.length());
    }

    public WebResourceResponse fetchIsolatedDocument(WebResourceRequest request) {
        String urlStr = request.getUrl().toString();
        HttpURLConnection conn = null;
        try {
            conn = openGetConnection(urlStr, request.getRequestHeaders());

            int code = conn.getResponseCode();
            if ((code >= 300 && code <= 399) || code < 100 || code > 599) {
                conn.disconnect();
                return null;
            }

            Map<String, String> respHeaders = extractResponseHeaders(conn, urlStr, true);

            String coep = headerIgnoreCase(respHeaders, "Cross-Origin-Embedder-Policy");
            String dip = (coep != null && coep.contains("credentialless"))
                    ? "isolate-and-credentialless"
                    : "isolate-and-require-corp";
            respHeaders.put("Document-Isolation-Policy", dip);
            if (headerIgnoreCase(respHeaders, "Cross-Origin-Opener-Policy") == null) {
                respHeaders.put("Cross-Origin-Opener-Policy", "same-origin");
            }
            if (coep == null) {
                respHeaders.put("Cross-Origin-Embedder-Policy", "require-corp");
            }
            if (headerIgnoreCase(respHeaders, "Cross-Origin-Resource-Policy") == null) {
                respHeaders.put("Cross-Origin-Resource-Policy", "same-origin");
            }

            String contentType = conn.getContentType();
            String mime = "text/html";
            String charset = "utf-8";
            if (contentType != null && !contentType.isEmpty()) {
                int semi = contentType.indexOf(';');
                String m = (semi >= 0 ? contentType.substring(0, semi) : contentType).trim();
                if (!m.isEmpty()) mime = m;
                Matcher cm = CHARSET_PATTERN.matcher(contentType);
                if (cm.find()) charset = cm.group(1).trim();
            }

            byte[] bodyBytes = readBodyBytes(conn, code, 2 * 1024 * 1024);
            String reason = conn.getResponseMessage();
            if (reason == null || reason.trim().isEmpty()) {
                reason = code < 400 ? "OK" : "Error";
            }
            conn.disconnect();
            return new WebResourceResponse(mime, charset, code, reason, respHeaders,
                    new ByteArrayInputStream(bodyBytes != null ? bodyBytes : new byte[0]));
        } catch (Throwable t) {
            Log.w(TAG, "Isolated document refetch failed for " + urlStr, t);
            if (conn != null) conn.disconnect();
            return null;
        }
    }

    private HttpURLConnection openGetConnection(String urlStr, Map<String, String> reqHeaders) throws Exception {
        HttpURLConnection conn = (HttpURLConnection) new URL(urlStr).openConnection();
        conn.setInstanceFollowRedirects(false);
        conn.setRequestMethod("GET");
        conn.setConnectTimeout(15000);
        conn.setReadTimeout(30000);

        if (reqHeaders != null) {
            for (Map.Entry<String, String> e : reqHeaders.entrySet()) {
                String k = e.getKey();
                if (k == null || "Accept-Encoding".equalsIgnoreCase(k) || "Range".equalsIgnoreCase(k)) {
                    continue;
                }
                conn.setRequestProperty(k, e.getValue());
            }
        }
        if (!activeUserAgent.isEmpty()) {
            conn.setRequestProperty("User-Agent", activeUserAgent);
        }
        String cookie = CookieManager.getInstance().getCookie(urlStr);
        if (cookie != null && !cookie.isEmpty()) {
            conn.setRequestProperty("Cookie", cookie);
        }
        return conn;
    }

    private Map<String, String> extractResponseHeaders(HttpURLConnection conn, String urlStr, boolean stripDip) {
        Map<String, String> respHeaders = new LinkedHashMap<>();
        Map<String, List<String>> rawFields = conn.getHeaderFields();
        if (rawFields != null) {
            for (Map.Entry<String, List<String>> e : rawFields.entrySet()) {
                String k = e.getKey();
                List<String> vals = e.getValue();
                if (k == null || vals == null || vals.isEmpty()) continue;
                String lk = k.toLowerCase(Locale.US);
                if ("set-cookie".equals(lk)) {
                    for (String sc : vals) {
                        CookieManager.getInstance().setCookie(urlStr, sc);
                    }
                } else if ("content-encoding".equals(lk)
                        || "content-length".equals(lk)
                        || "transfer-encoding".equals(lk)
                        || "connection".equals(lk)
                        || "keep-alive".equals(lk)
                        || (stripDip && "document-isolation-policy".equals(lk))) {
                    // Handled explicitly
                } else {
                    StringBuilder joined = new StringBuilder();
                    for (int i = 0; i < vals.size(); i++) {
                        if (i > 0) joined.append(", ");
                        joined.append(vals.get(i));
                    }
                    respHeaders.put(k, joined.toString());
                }
            }
        }
        return respHeaders;
    }

    private static byte[] readBodyBytes(HttpURLConnection conn, int code, int maxBytes) throws Exception {
        InputStream rawBody = code >= 400 ? conn.getErrorStream() : conn.getInputStream();
        if (rawBody == null) return new byte[0];
        String ce = conn.getContentEncoding();
        InputStream in = ("gzip".equalsIgnoreCase(ce)) ? new GZIPInputStream(rawBody) : rawBody;
        try {
            ByteArrayOutputStream baos = new ByteArrayOutputStream(32768);
            byte[] buf = new byte[16384];
            int n;
            while ((n = in.read(buf)) != -1) {
                baos.write(buf, 0, n);
                if (baos.size() > maxBytes) break;
            }
            return baos.toByteArray();
        } finally {
            try { in.close(); } catch (Throwable ignored) {}
        }
    }

    public static String getInstalledWebViewVersion() {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                PackageInfo pi = WebView.getCurrentWebViewPackage();
                if (pi != null && pi.versionName != null) {
                    return pi.packageName + " " + pi.versionName;
                }
            }
        } catch (Throwable ignored) {}
        return "unknown";
    }

    private static ClassLoader getWebViewClassLoader() {
        try {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) {
                return WebView.getWebViewClassLoader();
            }
            Class<?> factoryClass = Class.forName("android.webkit.WebViewFactory");
            Method getProvider = factoryClass.getDeclaredMethod("getProvider");
            getProvider.setAccessible(true);
            Object provider = getProvider.invoke(null);
            return provider != null ? provider.getClass().getClassLoader() : null;
        } catch (Throwable t) {
            return null;
        }
    }

    private static <T> T castProxy(Class<T> iface, InvocationHandler handler) {
        return iface.cast(Proxy.newProxyInstance(
                iface.getClassLoader(), new Class<?>[]{iface}, handler));
    }

    private static String originOf(Uri uri) {
        if (uri == null) return null;
        String scheme = uri.getScheme();
        String host = uri.getHost();
        if (scheme == null || host == null) return null;
        scheme = scheme.toLowerCase(Locale.US);
        host = host.toLowerCase(Locale.US);
        if (!"http".equals(scheme) && !"https".equals(scheme)) return null;
        int port = uri.getPort();
        int defPort = "https".equals(scheme) ? 443 : 80;
        return (port == -1 || port == defPort)
                ? (scheme + "://" + host)
                : (scheme + "://" + host + ":" + port);
    }

    private static String headerIgnoreCase(Map<String, String> headers, String name) {
        if (headers == null) return null;
        for (Map.Entry<String, String> e : headers.entrySet()) {
            if (e.getKey() != null && e.getKey().equalsIgnoreCase(name) && e.getValue() != null) {
                return e.getValue().toLowerCase(Locale.US);
            }
        }
        return null;
    }
}
