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
import java.util.Collections;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Enables REAL Cross-Origin Isolation (SharedArrayBuffer + multi-threaded WebAssembly)
 * directly inside our fullscreen horizontal landscape Android WebView without leaving the app!
 *
 * Uses Chromium Android WebView's official Support Library Boundary Interface
 * (AndroidX WebKit 1.18.0 / WebView v150+):
 * 1) Calls Profile.setCrossOriginIsolatedAllowList({"https://playgta5.com", "https://www.playgta5.com"})
 *    (plus configureIsolatedSites when available).
 * 2) Intercepts ONLY GET HTML document loads for playgta5.com in shouldInterceptRequest() and
 *    adds the required "Document-Isolation-Policy: isolate-and-require-corp" response header
 *    (leaving all .wasm, .js, /data/, and POST /data/batch traffic on Chromium's native C++ network stack).
 * 3) Registers our bridge script via DOCUMENT_START_SCRIPT so Virtual Pointer Lock & telemetry hooks
 *    execute before page scripts run.
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
     * inject Document-Isolation-Policy: isolate-and-require-corp without touching .wasm/.js/data!
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
     * Network thread: fetches the HTML document identically to WebView and adds
     * Document-Isolation-Policy: isolate-and-require-corp alongside COOP/COEP/CORP.
     * Returns null on redirects or failure so WebView falls back to normal loading.
     */
    public WebResourceResponse fetchIsolatedDocument(WebResourceRequest request) {
        String urlStr = request.getUrl().toString();
        HttpURLConnection conn = null;
        try {
            conn = (HttpURLConnection) new URL(urlStr).openConnection();
            conn.setInstanceFollowRedirects(false);
            conn.setRequestMethod("GET");
            conn.setConnectTimeout(15000);
            conn.setReadTimeout(30000);

            Map<String, String> reqHeaders = request.getRequestHeaders();
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

            int code = conn.getResponseCode();
            if ((code >= 300 && code <= 399) || code < 100 || code > 599) {
                conn.disconnect();
                return null;
            }

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
                            || "document-isolation-policy".equals(lk)) {
                        // Body is already decoded and re-streamed; DIP is set explicitly below
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

            InputStream rawBody = code >= 400 ? conn.getErrorStream() : conn.getInputStream();
            ByteArrayOutputStream baos = new ByteArrayOutputStream(32768);
            if (rawBody != null) {
                byte[] buf = new byte[16384];
                int n;
                while ((n = rawBody.read(buf)) != -1) {
                    baos.write(buf, 0, n);
                    if (baos.size() > 2 * 1024 * 1024) break;
                }
                rawBody.close();
            }
            String reason = conn.getResponseMessage();
            if (reason == null || reason.trim().isEmpty()) {
                reason = code < 400 ? "OK" : "Error";
            }
            conn.disconnect();
            return new WebResourceResponse(mime, charset, code, reason, respHeaders,
                    new ByteArrayInputStream(baos.toByteArray()));
        } catch (Throwable t) {
            Log.w(TAG, "Isolated document refetch failed for " + urlStr, t);
            if (conn != null) conn.disconnect();
            return null;
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
