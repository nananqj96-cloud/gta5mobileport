package com.ps5.mobile.proxy;

import android.content.Context;

import com.ps5.mobile.config.LaunchConfig;
import com.ps5.mobile.stats.StatsMonitor;

import org.json.JSONObject;

import java.io.BufferedInputStream;
import java.io.BufferedOutputStream;
import java.io.ByteArrayOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.net.HttpURLConnection;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.net.URL;
import java.nio.charset.StandardCharsets;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.zip.GZIPInputStream;

import javax.net.ssl.SSLSocket;
import javax.net.ssl.SSLSocketFactory;

/**
 * Localhost-only (127.0.0.1) COOP/COEP reverse proxy to https://playgta5.com.
 *
 * Why this completely fixes BOTH Android errors:
 * 1) Android System WebView never enables crossOriginIsolated=true (crbug.com/40914606) and runs
 *    inside a restricted single-renderer sandbox that cannot allocate playgta5.com's 3 GB shared
 *    WebAssembly memory ("not cross-origin isolated" / "no memory").
 * 2) Opening http://localhost:<port>/ in real Chrome (via Chrome Custom Tab) provides a secure
 *    context with strict COOP/COEP headers -> crossOriginIsolated===true, full 64-bit SharedArrayBuffer,
 *    Memory64 / WebGPU, persistent OPFS cache across sessions, AND injects our full PS5 Mobile Touch
 *    Controls + Floating [D] Developer Trainer + Real Android Hardware Stats HUD (/__ps5/overlay.js).
 */
public final class LocalPlayProxyServer {

    public static final int PREFERRED_PORT = 19555;
    private static final String UPSTREAM_HOST = "playgta5.com";
    private static final String UPSTREAM_ORIGIN = "https://playgta5.com";

    private final Context appContext;
    private final byte[] overlayJsBytes;
    private final AtomicBoolean running = new AtomicBoolean(false);
    private final ExecutorService pool = Executors.newCachedThreadPool();

    private ServerSocket serverSocket;
    private int boundPort = -1;
    private volatile StatsMonitor.Snapshot latestStats;

    public LocalPlayProxyServer(Context context) {
        this.appContext = context.getApplicationContext();
        this.overlayJsBytes = loadAssetBytes("ps5_game_overlay.js");
    }

    public void updateStats(StatsMonitor.Snapshot snap) {
        this.latestStats = snap;
    }

    public int getPort() {
        return boundPort;
    }

    public String getBaseOrigin() {
        return "http://localhost:" + boundPort;
    }

    public synchronized int start() throws IOException {
        if (running.get() && serverSocket != null && !serverSocket.isClosed()) {
            return boundPort;
        }
        InetAddress loopback = InetAddress.getByName("127.0.0.1");
        try {
            serverSocket = new ServerSocket(PREFERRED_PORT, 128, loopback);
        } catch (IOException busy) {
            serverSocket = new ServerSocket(0, 128, loopback);
        }
        boundPort = serverSocket.getLocalPort();
        running.set(true);

        pool.execute(() -> {
            while (running.get()) {
                try {
                    final Socket client = serverSocket.accept();
                    client.setTcpNoDelay(true);
                    client.setSoTimeout(60000);
                    pool.execute(() -> handleClient(client));
                } catch (IOException e) {
                    if (!running.get()) break;
                }
            }
        });
        return boundPort;
    }

    public synchronized void stop() {
        running.set(false);
        if (serverSocket != null) {
            try {
                serverSocket.close();
            } catch (IOException ignored) {}
            serverSocket = null;
        }
        pool.shutdownNow();
    }

    private void handleClient(Socket client) {
        try {
            BufferedInputStream in = new BufferedInputStream(client.getInputStream(), 16384);
            BufferedOutputStream out = new BufferedOutputStream(client.getOutputStream(), 32768);

            String requestLine = readLine(in);
            if (requestLine == null || requestLine.isEmpty()) return;
            String[] parts = requestLine.split(" ");
            if (parts.length < 2) return;

            String method = parts[0].trim().toUpperCase(Locale.US);
            String rawTarget = parts[1].trim();

            Map<String, String> headers = new HashMap<>();
            Map<String, String> rawHeaderNames = new HashMap<>();
            String line;
            while ((line = readLine(in)) != null && !line.isEmpty()) {
                int colon = line.indexOf(':');
                if (colon > 0) {
                    String k = line.substring(0, colon).trim();
                    String v = line.substring(colon + 1).trim();
                    headers.put(k.toLowerCase(Locale.US), v);
                    rawHeaderNames.put(k.toLowerCase(Locale.US), k);
                }
            }

            // WebSocket TLS tunnel (supports multiplayer servers over localhost!)
            String upgrade = headers.get("upgrade");
            if (upgrade != null && upgrade.equalsIgnoreCase("websocket")) {
                handleWebSocketTunnel(client, in, out, rawTarget, headers, rawHeaderNames);
                return;
            }

            // Read request body if Content-Length is present (e.g., POST /data/batch or /__ps5/api/settings)
            byte[] reqBody = null;
            String clStr = headers.get("content-length");
            if (clStr != null) {
                int cl = Math.max(0, Integer.parseInt(clStr.trim()));
                if (cl > 0 && cl <= 16 * 1024 * 1024) {
                    reqBody = readExact(in, cl);
                }
            }

            String pathOnly = rawTarget;
            int qIdx = rawTarget.indexOf('?');
            if (qIdx >= 0) pathOnly = rawTarget.substring(0, qIdx);

            // Local PS5 API & Injected Overlay routes
            if ("/__ps5/overlay.js".equals(pathOnly)) {
                sendBytes(out, 200, "OK", "application/javascript; charset=utf-8", overlayJsBytes, false);
                return;
            }
            if ("/__ps5/api/ping".equals(pathOnly)) {
                sendBytes(out, 200, "OK", "application/json", "{\"ok\":true}".getBytes(StandardCharsets.UTF_8), false);
                return;
            }
            if ("/__ps5/api/stats".equals(pathOnly)) {
                handleStatsApi(out);
                return;
            }
            if ("/__ps5/api/settings".equals(pathOnly)) {
                handleSettingsApi(method, reqBody, out);
                return;
            }

            // Reverse proxy everything else transparently to https://playgta5.com
            boolean isRootHtml = ("/".equals(pathOnly) || "/index.html".equals(pathOnly)) && "GET".equals(method);
            proxyToUpstream(method, rawTarget, headers, reqBody, isRootHtml, out);
        } catch (Throwable ignored) {
        } finally {
            try {
                client.close();
            } catch (IOException ignored) {}
        }
    }

    private void handleStatsApi(OutputStream out) throws IOException {
        LaunchConfig cfg = LaunchConfig.load(appContext);
        StatsMonitor.Snapshot s = latestStats;
        int cpuPct = s != null ? s.cpuPct : 0;
        int cpuMhz = s != null ? s.cpuMhz : 0;
        int gpuPct = s != null ? s.gpuPct : -1;
        boolean gpuDirect = s != null && s.gpuDirect;
        long usedRamMb = s != null ? s.usedRamMb : 0;
        long totalRamMb = s != null ? s.totalRamMb : cfg.totalRamMb;
        int appPssMb = s != null ? s.appPssMb : 0;

        String json = String.format(Locale.US,
                "{\"cpuPct\":%d,\"cpuMhz\":%d,\"gpuPct\":%d,\"gpuDirect\":%b,\"usedRamMb\":%d,\"totalRamMb\":%d,\"appPssMb\":%d,\"config\":%s}",
                cpuPct, cpuMhz, gpuPct, gpuDirect, usedRamMb, totalRamMb, appPssMb, cfg.toConfigJson());
        sendBytes(out, 200, "OK", "application/json; charset=utf-8", json.getBytes(StandardCharsets.UTF_8), false);
    }

    private void handleSettingsApi(String method, byte[] reqBody, OutputStream out) throws IOException {
        String launchMode = null;
        if ("POST".equals(method) && reqBody != null && reqBody.length > 0) {
            try {
                JSONObject obj = new JSONObject(new String(reqBody, StandardCharsets.UTF_8));
                LaunchConfig.applyPartialJson(appContext, obj);
                if (obj.has("launchMode") && !obj.isNull("launchMode")) {
                    launchMode = obj.optString("launchMode", null);
                }
            } catch (Throwable ignored) {}
        }
        LaunchConfig updated = LaunchConfig.load(appContext);
        String reloadUrl = updated.buildGameUrl(getBaseOrigin(), launchMode);
        String resp = String.format(Locale.US,
                "{\"ok\":true,\"reloadUrl\":%s,\"config\":%s}",
                JSONObject.quote(reloadUrl), updated.toConfigJson());
        sendBytes(out, 200, "OK", "application/json; charset=utf-8", resp.getBytes(StandardCharsets.UTF_8), false);
    }

    private void proxyToUpstream(String method, String rawTarget, Map<String, String> reqHeaders,
                                 byte[] reqBody, boolean isRootHtml, OutputStream out) throws IOException {
        String urlStr = UPSTREAM_ORIGIN + (rawTarget.startsWith("/") ? rawTarget : ("/" + rawTarget));
        HttpURLConnection conn = (HttpURLConnection) new URL(urlStr).openConnection();
        conn.setRequestMethod(method);
        conn.setInstanceFollowRedirects(true);
        conn.setConnectTimeout(15000);
        conn.setReadTimeout(60000);
        conn.setUseCaches(false);

        String ua = reqHeaders.get("user-agent");
        if (ua != null) conn.setRequestProperty("User-Agent", ua);
        conn.setRequestProperty("Origin", UPSTREAM_ORIGIN);
        conn.setRequestProperty("Referer", UPSTREAM_ORIGIN + "/");

        if (isRootHtml) {
            // Request uncompressed HTML so we cleanly inject /__ps5/overlay.js
            conn.setRequestProperty("Accept-Encoding", "identity");
        } else {
            String ae = reqHeaders.get("accept-encoding");
            conn.setRequestProperty("Accept-Encoding", (ae != null && !ae.isEmpty()) ? ae : "gzip");
        }

        String[] forwardReq = {"range", "if-range", "if-none-match", "if-modified-since", "content-type", "accept"};
        for (String h : forwardReq) {
            String v = reqHeaders.get(h);
            if (v != null && !v.isEmpty()) conn.setRequestProperty(h, v);
        }

        if (reqBody != null && reqBody.length > 0 && ("POST".equals(method) || "PUT".equals(method))) {
            conn.setDoOutput(true);
            conn.setFixedLengthStreamingMode(reqBody.length);
            try (OutputStream os = conn.getOutputStream()) {
                os.write(reqBody);
            }
        }

        int status = conn.getResponseCode();
        String reason = conn.getResponseMessage();
        if (reason == null || reason.isEmpty()) reason = "OK";

        InputStream upstreamIn;
        try {
            upstreamIn = status >= 400 ? conn.getErrorStream() : conn.getInputStream();
        } catch (IOException e) {
            upstreamIn = conn.getErrorStream();
        }

        String contentType = conn.getContentType();
        if (contentType == null) contentType = guessContentType(rawTarget);

        // If this is the root HTML page, inject our PS5 Mobile Overlay script cleanly
        if (isRootHtml && status == 200 && upstreamIn != null && contentType.toLowerCase(Locale.US).contains("text/html")) {
            String ce = conn.getContentEncoding();
            InputStream htmlStream = (ce != null && ce.toLowerCase(Locale.US).contains("gzip"))
                    ? new GZIPInputStream(upstreamIn) : upstreamIn;
            byte[] rawHtml = readAllLimited(htmlStream, 2 * 1024 * 1024);
            conn.disconnect();
            String html = new String(rawHtml, StandardCharsets.UTF_8);
            String injectTag = "\n<script src=\"/__ps5/overlay.js\"></script>\n";
            int bodyEnd = html.toLowerCase(Locale.US).lastIndexOf("</body>");
            if (bodyEnd >= 0) {
                html = html.substring(0, bodyEnd) + injectTag + html.substring(bodyEnd);
            } else {
                html = html + injectTag;
            }
            sendBytes(out, 200, "OK", "text/html; charset=utf-8", html.getBytes(StandardCharsets.UTF_8), false);
            return;
        }

        // Stream binary/JS/WASM/Range/Batch response with strict COOP/COEP/CORP headers
        long contentLength = conn.getContentLengthLong();
        boolean useChunked = (!"HEAD".equals(method) && status != 204 && status != 304 && contentLength < 0);

        StringBuilder hdr = new StringBuilder(512);
        hdr.append("HTTP/1.1 ").append(status).append(' ').append(reason).append("\r\n");
        hdr.append("Cross-Origin-Opener-Policy: same-origin\r\n");
        hdr.append("Cross-Origin-Embedder-Policy: require-corp\r\n");
        hdr.append("Cross-Origin-Resource-Policy: same-origin\r\n");
        hdr.append("Content-Type: ").append(contentType).append("\r\n");

        Map<String, List<String>> respHeaders = conn.getHeaderFields();
        if (respHeaders != null) {
            String[] copyResp = {"Content-Range", "Accept-Ranges", "Content-Encoding", "ETag", "Cache-Control", "Last-Modified"};
            for (String key : copyResp) {
                String val = getHeaderIgnoreCase(respHeaders, key);
                if (val != null && !val.isEmpty()) {
                    hdr.append(key).append(": ").append(val).append("\r\n");
                }
            }
        }

        if (contentLength >= 0) {
            hdr.append("Content-Length: ").append(contentLength).append("\r\n");
        } else if (useChunked) {
            hdr.append("Transfer-Encoding: chunked\r\n");
        }
        hdr.append("Connection: close\r\n\r\n");
        out.write(hdr.toString().getBytes(StandardCharsets.ISO_8859_1));
        out.flush();

        if (!"HEAD".equals(method) && status != 204 && status != 304 && upstreamIn != null) {
            byte[] buf = new byte[32768];
            int n;
            try {
                while ((n = upstreamIn.read(buf)) != -1) {
                    if (useChunked) {
                        out.write((Integer.toHexString(n) + "\r\n").getBytes(StandardCharsets.ISO_8859_1));
                        out.write(buf, 0, n);
                        out.write("\r\n".getBytes(StandardCharsets.ISO_8859_1));
                    } else {
                        out.write(buf, 0, n);
                    }
                }
                if (useChunked) {
                    out.write("0\r\n\r\n".getBytes(StandardCharsets.ISO_8859_1));
                }
                out.flush();
            } finally {
                try {
                    upstreamIn.close();
                } catch (IOException ignored) {}
            }
        }
        conn.disconnect();
    }

    private void handleWebSocketTunnel(Socket client, InputStream clientIn, OutputStream clientOut,
                                       String rawTarget, Map<String, String> headers,
                                       Map<String, String> rawNames) throws IOException {
        client.setSoTimeout(0);
        SSLSocket upstream = (SSLSocket) SSLSocketFactory.getDefault().createSocket(UPSTREAM_HOST, 443);
        upstream.setTcpNoDelay(true);
        upstream.startHandshake();

        OutputStream upOut = upstream.getOutputStream();
        InputStream upIn = upstream.getInputStream();

        StringBuilder req = new StringBuilder(512);
        req.append("GET ").append(rawTarget).append(" HTTP/1.1\r\n");
        req.append("Host: ").append(UPSTREAM_HOST).append("\r\n");
        req.append("Origin: ").append(UPSTREAM_ORIGIN).append("\r\n");
        for (Map.Entry<String, String> e : headers.entrySet()) {
            String lk = e.getKey();
            if ("host".equals(lk) || "origin".equals(lk)) continue;
            String origName = rawNames.get(lk);
            req.append(origName != null ? origName : lk).append(": ").append(e.getValue()).append("\r\n");
        }
        req.append("\r\n");
        upOut.write(req.toString().getBytes(StandardCharsets.ISO_8859_1));
        upOut.flush();

        // Pump bidirectional frames
        pool.execute(() -> {
            try {
                pump(clientIn, upOut);
            } catch (IOException ignored) {
            } finally {
                try { upstream.close(); } catch (IOException ignored) {}
            }
        });
        try {
            pump(upIn, clientOut);
        } finally {
            try { upstream.close(); } catch (IOException ignored) {}
        }
    }

    private static void pump(InputStream src, OutputStream dst) throws IOException {
        byte[] buf = new byte[16384];
        int n;
        while ((n = src.read(buf)) != -1) {
            dst.write(buf, 0, n);
            dst.flush();
        }
    }

    private static void sendBytes(OutputStream out, int code, String reason, String contentType,
                                  byte[] body, boolean cacheable) throws IOException {
        byte[] payload = body != null ? body : new byte[0];
        StringBuilder hdr = new StringBuilder(384);
        hdr.append("HTTP/1.1 ").append(code).append(' ').append(reason).append("\r\n");
        hdr.append("Cross-Origin-Opener-Policy: same-origin\r\n");
        hdr.append("Cross-Origin-Embedder-Policy: require-corp\r\n");
        hdr.append("Cross-Origin-Resource-Policy: same-origin\r\n");
        hdr.append("Content-Type: ").append(contentType).append("\r\n");
        hdr.append("Cache-Control: ").append(cacheable ? "public, max-age=300" : "no-store").append("\r\n");
        hdr.append("Content-Length: ").append(payload.length).append("\r\n");
        hdr.append("Connection: close\r\n\r\n");
        out.write(hdr.toString().getBytes(StandardCharsets.ISO_8859_1));
        if (payload.length > 0) out.write(payload);
        out.flush();
    }

    private static String getHeaderIgnoreCase(Map<String, List<String>> map, String key) {
        for (Map.Entry<String, List<String>> e : map.entrySet()) {
            if (e.getKey() != null && e.getKey().equalsIgnoreCase(key) && e.getValue() != null && !e.getValue().isEmpty()) {
                return e.getValue().get(0);
            }
        }
        return null;
    }

    private static String guessContentType(String target) {
        String p = target.toLowerCase(Locale.US);
        int q = p.indexOf('?');
        if (q >= 0) p = p.substring(0, q);
        if (p.endsWith(".wasm")) return "application/wasm";
        if (p.endsWith(".js") || p.endsWith(".mjs")) return "application/javascript; charset=utf-8";
        if (p.endsWith(".json")) return "application/json";
        if (p.endsWith(".png")) return "image/png";
        if (p.endsWith(".jpg") || p.endsWith(".jpeg")) return "image/jpeg";
        if (p.endsWith(".css")) return "text/css";
        if (p.endsWith(".html") || p.equals("/")) return "text/html; charset=utf-8";
        return "application/octet-stream";
    }

    private static String readLine(InputStream in) throws IOException {
        ByteArrayOutputStream baos = new ByteArrayOutputStream(128);
        int prev = -1, ch;
        while ((ch = in.read()) != -1) {
            if (ch == '\n') {
                byte[] b = baos.toByteArray();
                int len = (b.length > 0 && b[b.length - 1] == '\r') ? b.length - 1 : b.length;
                return new String(b, 0, len, StandardCharsets.ISO_8859_1);
            }
            baos.write(ch);
            if (baos.size() > 16384) throw new IOException("Header line too long");
            prev = ch;
        }
        return baos.size() == 0 && prev == -1 ? null : baos.toString("ISO-8859-1");
    }

    private static byte[] readExact(InputStream in, int len) throws IOException {
        byte[] buf = new byte[len];
        int off = 0;
        while (off < len) {
            int n = in.read(buf, off, len - off);
            if (n < 0) break;
            off += n;
        }
        return buf;
    }

    private static byte[] readAllLimited(InputStream in, int maxBytes) throws IOException {
        ByteArrayOutputStream baos = new ByteArrayOutputStream(32768);
        byte[] buf = new byte[16384];
        int n;
        while ((n = in.read(buf)) != -1) {
            baos.write(buf, 0, n);
            if (baos.size() > maxBytes) break;
        }
        return baos.toByteArray();
    }

    private byte[] loadAssetBytes(String assetName) {
        try (InputStream is = appContext.getAssets().open(assetName)) {
            return readAllLimited(is, 2 * 1024 * 1024);
        } catch (IOException e) {
            return "".getBytes(StandardCharsets.UTF_8);
        }
    }
}
