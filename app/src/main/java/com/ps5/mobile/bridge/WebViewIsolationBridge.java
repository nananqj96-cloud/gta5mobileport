package com.ps5.mobile.bridge;

import android.content.pm.PackageInfo;
import android.net.Uri;
import android.os.Build;
import android.util.Log;
import android.webkit.CookieManager;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebView;

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
 * Enables REAL Cross-Origin Isolation (SharedArrayBuffer + multi-threaded WebAssembly)
 * AND Android GPU compatibility directly inside our fullscreen landscape WebView:
 *
 * 1) Calls Profile.setCrossOriginIsolatedAllowList({"https://playgta5.com", "https://www.playgta5.com"})
 *    (plus configureIsolatedSites when available).
 * 2) Intercepts GET HTML documents for playgta5.com in shouldInterceptRequest() to add
 *    "Document-Isolation-Policy: isolate-and-require-corp" alongside COOP/COEP/CORP.
 * 3) Intercepts playgta5.com's wgpu_worker.js & io_worker.js to fix the Android 86% loading stall:
 *    - Injects MIT BC1-BC7 software texture decoding when the Android GPU (Adreno/Mali/PowerVR)
 *      lacks WebGPU "texture-compression-bc" (zero overhead if hardware BC is supported; skipped
 *      automatically if playgta5.com adds native bcDecode upstream).
 *    - Clamps parallel shader pipeline ahead-compilation (AHEAD_MAX <= 2) so mobile Vulkan/Dawn
 *      shader compilers do not hang or OOM during world load.
 *    - Lowers the world-ready present() gate from d > 300 / 60s to d > 80 / 15s so low-draw
 *      mobile Potato/Low indoor scenes never stay locked behind the 86% loading overlay.
 *    - Tunes io_worker.js prefetch lanes & retry count for mobile WebView network stability.
 * 4) Registers our bridge script via DOCUMENT_START_SCRIPT before page scripts parse.
 */
public final class WebViewIsolationBridge {

    private static final String TAG = "Ps5WebViewIsolation";
    private static final String FEATURE_COI_ALLOWLIST = "CROSS_ORIGIN_ISOLATED_ALLOW_LIST";
    private static final String FEATURE_MULTI_PROFILE = "MULTI_PROFILE";
    private static final String FEATURE_DOCUMENT_START = "DOCUMENT_START_SCRIPT";
    private static final Pattern CHARSET_PATTERN = Pattern.compile("charset=\"?([^;\"]+)", Pattern.CASE_INSENSITIVE);

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

    /**
     * Applies Profile.setCrossOriginIsolatedAllowList({"https://playgta5.com", ...})
     * and installs DOCUMENT_START_SCRIPT on the dedicated GTA V WebView. Must run on UI thread.
     */
    public void applyToWebView(WebView webView, String documentStartScript) {
        if (factory == null || webView == null) return;

        // 1. Register Document-Start script before any page JS parses
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

        // 2. Opt playgta5.com into Chromium WebView's Cross-Origin Isolated Allowlist
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

    /**
     * Network thread check: true ONLY for GET HTML document loads of playgta5.com so we can
     * inject Document-Isolation-Policy: isolate-and-require-corp without touching .wasm/.data!
     */
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

    /**
     * Network thread check: true for playgta5.com's wgpu_worker.js and io_worker.js so we can
     * inject Android GPU BC1-BC7 software texture decoding + mobile shader/world-ready/IO hardening.
     */
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

    /**
     * Network thread: fetches playgta5.com's wgpu_worker.js or io_worker.js, applies verified
     * Android compatibility patches, and serves the patched worker with strict CORP/COEP/COOP headers.
     */
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
     * 1) MIT BC1-BC7 software texture decoding when !device.features.has('texture-compression-bc')
     *    (skipped automatically if upstream already defines bcDecode or if any anchor mismatches).
     * 2) Mobile Vulkan/Dawn pipeline compile clamp (AHEAD_MAX <= 2).
     * 3) World-ready gate lowered from d > 300 / 60s -> d > 80 / 15s so Potato/Low indoor scenes
     *    transition past 86% cleanly.
     */
    String patchWgpuWorker(String src) {
        String out = src;

        // A. BC1-BC7 software texture decoding for Android GPUs (Adreno/Mali/PowerVR)
        if (bcDecodeScript != null && !bcDecodeScript.isEmpty() && !out.contains("let bcDecode")) {
            final String anchorStrict = "'use strict';";
            final String anchorMapFmt = "function mapFormat(f, bind) {";
            final String anchorInitDev = "device = await adapter.requestDevice({ requiredFeatures, requiredLimits: limits });";
            final String anchorCreateTex = "objs.set(id, { kind: 'texture', tex, desc, format: m.format, views: new Map(), a8: !!m.a8, bytes });";
            final String anchorUpload = "device.queue.writeTexture({ texture: o.tex, mipLevel: mip, origin }, data,";
            final String anchorCopyDims = "const w = hasBox ? r - l : m.w, h = hasBox ? b - t : m.h, dep = hasBox ? bk - f : m.d;";
            final String anchorCopyThree = "const three = s.desc.dimension === '3d';";

            if (out.contains(anchorStrict)
                    && out.contains(anchorMapFmt)
                    && out.contains(anchorInitDev)
                    && out.contains(anchorCreateTex)
                    && out.contains(anchorUpload)
                    && out.contains(anchorCopyDims)
                    && out.contains(anchorCopyThree)) {

                String candidate = out;

                String bcHeader = anchorStrict + "\n"
                        + "/* PS5 Mobile Android BC1-BC7 software texture decoder (MIT) */\n"
                        + bcDecodeScript + "\n"
                        + "let bcDecode = false;\n"
                        + "const { decodeBC, BC_BLOCK_BYTES, BC_TEXEL_BYTES } = self.BCDecode;\n"
                        + "let decodeBuf = null;\n"
                        + "function decodeScratch(n) {\n"
                        + "  if (!decodeBuf || decodeBuf.length < n) decodeBuf = new Uint8Array(Math.max(n, 1 << 20));\n"
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
                        + "}\n";

                String mapFmtPatch = "function mapFormat(f, bind) {\n"
                        + "  const m = mapFormatBC(f, bind);\n"
                        + "  if (!bcDecode || !m.format.startsWith('bc')) return m;\n"
                        + "  const kind = m.format.slice(0, m.format.indexOf('-')), srgb = m.format.endsWith('-srgb');\n"
                        + "  const format = kind === 'bc4' ? 'r8unorm' : kind === 'bc5' ? 'rg8unorm' : kind === 'bc6h' ? 'rgba16float' : srgb ? 'rgba8unorm-srgb' : 'rgba8unorm';\n"
                        + "  return { format, views: m.views && [srgb ? 'rgba8unorm' : 'rgba8unorm-srgb'], decode: kind };\n"
                        + "}\n"
                        + "function mapFormatBC(f, bind) {";

                String initDevPatch = anchorInitDev + "\n"
                        + "  bcDecode = !device.features.has('texture-compression-bc');\n"
                        + "  if (typeof AHEAD_MAX === 'number' && AHEAD_MAX > 2) AHEAD_MAX = 2;\n"
                        + "  if (bcDecode) {\n"
                        + "    logLine('[ps5-mobile] Android GPU BC1-BC7 software texture decode active');\n"
                        + "    try { if (typeof progressChannel !== 'undefined' && progressChannel) progressChannel.postMessage({ lines: ['[gpu] Android BC1-BC7 software texture decode active'] }); } catch (_) {}\n"
                        + "  }";

                String createTexPatch = "objs.set(id, { kind: 'texture', tex, desc, format: m.format, views: new Map(), a8: !!m.a8, decode: m.decode || null, gen: 0, bytes });";

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

                candidate = replaceFirstLiteral(candidate, anchorStrict, bcHeader);
                candidate = replaceFirstLiteral(candidate, anchorMapFmt, mapFmtPatch);
                candidate = replaceFirstLiteral(candidate, anchorInitDev, initDevPatch);
                candidate = replaceFirstLiteral(candidate, anchorCreateTex, createTexPatch);
                candidate = replaceFirstLiteral(candidate, anchorUpload, uploadPatch);
                candidate = replaceFirstLiteral(candidate, anchorCopyDims, copyDimsPatch);
                candidate = replaceFirstLiteral(candidate, anchorCopyThree, copyThreePatch);
                out = candidate;
                Log.i(TAG, "Injected BC1-BC7 software texture decoder into wgpu_worker.js");
            } else {
                Log.w(TAG, "wgpu_worker.js anchors changed upstream; skipping BC injection");
            }
        }

        // B. Lower world-ready gate from d > 300 / 60s -> d > 80 / 15s for mobile Potato/Low scenes
        out = replaceFirstLiteral(out,
                "if (!worldSent && (worldSince || d > 300)) {",
                "if (!worldSent && (worldSince || d > 80)) {");
        out = replaceFirstLiteral(out,
                "if ((worldClean && now - worldClean >= 1500) || now - worldSince >= 60000) {",
                "if ((worldClean && now - worldClean >= 1500) || now - worldSince >= 15000) {");

        // C. Mobile-safe parallel pipeline compilation cap even if hardware BC is supported
        out = replaceFirstLiteral(out,
                "Math.max(2, Math.min(8, (self.navigator.hardwareConcurrency || 4) - 1))",
                "2");

        return out;
    }

    /**
     * Patches live playgta5.com io_worker.js so Android WebView does not saturate its mobile socket
     * pool with 128 concurrent fetches during the 84%-86% world streaming surge, and retries more
     * aggressively on transient mobile/CDN hiccups.
     */
    String patchIoWorker(String src) {
        String out = src;
        out = replaceFirstLiteral(out,
                "const RUN_LANES = 32, BATCH_LANES = 4, RUN_GAP = 64;",
                "const RUN_LANES = 12, BATCH_LANES = 4, RUN_GAP = 64;");
        out = replaceFirstLiteral(out,
                "const HINT_PAR = 96, LOW_PAR = 48, HINT_QUEUE_MAX = 2000;",
                "const HINT_PAR = 24, LOW_PAR = 10, HINT_QUEUE_MAX = 2000;");
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

    /**
     * Network thread: fetches the HTML document identically to WebView and adds
     * Document-Isolation-Policy: isolate-and-require-corp alongside COOP/COEP/CORP.
     * Returns null on redirects or failure so WebView falls back to normal loading.
     */
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

            // Guarantee Document-Isolation-Policy + COOP/COEP/CORP for real WebView COI!
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
