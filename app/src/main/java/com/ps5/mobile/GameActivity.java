package com.ps5.mobile;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.ComponentCallbacks2;
import android.content.Intent;
import android.graphics.Color;
import android.net.Uri;
import android.net.http.SslError;
import android.os.Build;
import android.os.Bundle;
import android.os.Handler;
import android.os.Looper;
import android.util.Log;
import android.view.Gravity;
import android.view.View;
import android.view.WindowManager;
import android.webkit.ConsoleMessage;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.SslErrorHandler;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.Toast;

import com.ps5.mobile.bridge.GameInputBridge;
import com.ps5.mobile.bridge.WebViewIsolationBridge;
import com.ps5.mobile.config.LaunchConfig;
import com.ps5.mobile.stats.StatsHudView;
import com.ps5.mobile.stats.StatsMonitor;
import com.ps5.mobile.ui.DeveloperTrainerOverlay;
import com.ps5.mobile.ui.MobileControlsOverlay;
import com.ps5.mobile.ui.Ps5ControllerOverlay;
import com.ps5.mobile.ui.Ps5SettingsOverlay;

import java.io.BufferedReader;
import java.io.InputStream;
import java.io.InputStreamReader;
import java.nio.charset.StandardCharsets;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * 100% In-App Fullscreen Horizontal Landscape PS5 Mobile + GTA V Host:
 * 1) Boots directly into the PS5 Home Screen (assets/ps5_ui/index.html) with Ps5ControllerOverlay
 *    blocking all direct screen taps so ONLY DualSense UI controls navigate the PS5 UI.
 * 2) Pressing "Play Game" destroys the PS5 Home WebView first (freeing all UI textures & audio RAM),
 *    then spawns a clean dedicated landscape GTA V WebView with:
 *      - RENDERER_PRIORITY_IMPORTANT (fixes LMKD "no memory" starvation),
 *      - Chromium WebView Profile.setCrossOriginIsolatedAllowList + Document-Isolation-Policy header
 *        injection (enables REAL crossOriginIsolated===true & SharedArrayBuffer inside the app!),
 *      - DOCUMENT_START_SCRIPT bridge injection + native MobileControlsOverlay + Floating [D] Trainer
 *        + Live Hardware Stats HUD (FPS / CPU / GPU / RAM) — ZERO external browser, ALWAYS landscape!
 */
public final class GameActivity extends Activity {

    public static final String EXTRA_DIRECT_LAUNCH = "ps5_direct_launch";
    public static final String EXTRA_LAUNCH_MODE = "ps5_launch_mode";

    private static final String TAG = "Ps5GameActivity";
    private static final String PS5_HOME_URL = "file:///android_asset/ps5_ui/index.html";
    private static final Pattern CHROME_MAJOR = Pattern.compile("Chrome/(\\d+)");

    private final Handler mainHandler = new Handler(Looper.getMainLooper());
    private LaunchConfig config;
    private WebViewIsolationBridge isolationBridge;
    private FrameLayout webViewHost;
    private WebView activeWebView;
    private GameInputBridge inputBridge;

    private Ps5ControllerOverlay ps5ControllerOverlay;
    private MobileControlsOverlay gameControlsOverlay;
    private DeveloperTrainerOverlay trainerOverlay;
    private Ps5SettingsOverlay settingsOverlay;
    private StatsHudView statsHud;
    private StatsMonitor statsMonitor;

    private String bridgeScript;
    private boolean inGameMode = false;
    private boolean awaitingCacheClearReload = false;
    private String lastLaunchMode = "default";
    private volatile String lastConsoleError = "";

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        config = LaunchConfig.load(this);
        bridgeScript = readAssetText("mobile_bridge.js");
        isolationBridge = new WebViewIsolationBridge();
        isolationBridge.setBcDecodeScript(readAssetText("bc_decode.js"));
        isolationBridge.setLaunchConfig(config);

        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        applyImmersiveFullscreen();

        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.BLACK);
        root.setMotionEventSplittingEnabled(true);

        // 1. Dedicated container that cleanly swaps PS5 Home WebView <-> GTA V WebView
        webViewHost = new FrameLayout(this);
        webViewHost.setBackgroundColor(Color.BLACK);
        root.addView(webViewHost, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));

        inputBridge = new GameInputBridge(null);

        // 2. Native GTA V Gameplay Touch Controls Overlay (hidden on PS5 Home)
        gameControlsOverlay = new MobileControlsOverlay(this, inputBridge, config, new MobileControlsOverlay.HostCallback() {
            @Override
            public void onOpenSettings() {
                settingsOverlay.show(true);
            }

            @Override
            public void onReturnToPs5Home() {
                enterPs5Home();
            }

            @Override
            public void onReloadGame(boolean forceUltraExtreme) {
                if (forceUltraExtreme) {
                    LaunchConfig.activateEmergencyUltraExtreme(GameActivity.this);
                    config = LaunchConfig.load(GameActivity.this);
                }
                launchGtaRuntime(lastLaunchMode);
            }

            @Override
            public void onClearCacheAndReload() {
                clearCacheAndReload();
            }

            @Override
            public void onTriggerMemoryTrim() {
                triggerLiveMemoryTrim(true);
            }

            @Override
            public void onUpdateWebView() {
                openWebViewPlayStore();
            }
        });
        gameControlsOverlay.setVisibility(View.GONE);
        root.addView(gameControlsOverlay, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));

        // 3. PS5 Home Controller Overlay (strict controller-only PS5 UI navigation)
        ps5ControllerOverlay = new Ps5ControllerOverlay(this, inputBridge, new Ps5ControllerOverlay.HostCallback() {
            @Override
            public void onOpenSettings() {
                settingsOverlay.show(false);
            }

            @Override
            public void onExitApp() {
                finish();
            }
        });
        root.addView(ps5ControllerOverlay, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));

        // 4. Floating Draggable [D] Developer Trainer Overlay
        trainerOverlay = new DeveloperTrainerOverlay(this, inputBridge, new DeveloperTrainerOverlay.Callback() {
            @Override
            public void onSwitchToFlyHud() {
                gameControlsOverlay.setControlMode(MobileControlsOverlay.ControlMode.FLY);
            }

            @Override
            public void onReloadGameWithNewGraphics(String optionalLaunchMode) {
                config = LaunchConfig.load(GameActivity.this);
                if (optionalLaunchMode != null) lastLaunchMode = optionalLaunchMode;
                launchGtaRuntime(lastLaunchMode);
            }

            @Override
            public void onToggleStatsQuick() {
                LaunchConfig c = LaunchConfig.load(GameActivity.this);
                boolean next = !c.statsEnabled;
                LaunchConfig.saveStatsPrefs(GameActivity.this, next, c.statsShowFps, c.statsShowCpuGpu, c.statsShowRam);
                config = LaunchConfig.load(GameActivity.this);
                statsHud.applyVisibility(config.statsEnabled, config.statsShowFps, config.statsShowCpuGpu, config.statsShowRam);
            }

            @Override
            public void onTriggerMemoryTrim() {
                triggerLiveMemoryTrim(true);
            }

            @Override
            public void onReturnToPs5Home() {
                enterPs5Home();
            }
        });
        trainerOverlay.setButtonVisible(false);
        root.addView(trainerOverlay, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));

        // 5. Floating Hardware Statistics Viewer HUD (FPS / CPU / GPU / VRAM / RAM)
        statsHud = new StatsHudView(this);
        statsHud.applyVisibility(config.statsEnabled, config.statsShowFps, config.statsShowCpuGpu, config.statsShowRam);
        root.addView(statsHud, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.WRAP_CONTENT, FrameLayout.LayoutParams.WRAP_CONTENT,
                Gravity.TOP | Gravity.CENTER_HORIZONTAL));

        // 6. PS5 System Settings & Ultra Optimize Overlay (topmost modal)
        settingsOverlay = new Ps5SettingsOverlay(this, new Ps5SettingsOverlay.Callback() {
            @Override
            public void onStatsSettingsChanged(boolean enabled, boolean fps, boolean cpuGpu, boolean ram) {
                config = LaunchConfig.load(GameActivity.this);
                statsHud.applyVisibility(enabled, fps, cpuGpu, ram);
            }

            @Override
            public void onGraphicsSettingsChanged(boolean reloadGameIfRunning) {
                config = LaunchConfig.load(GameActivity.this);
                isolationBridge.setLaunchConfig(config);
                if (!inGameMode) {
                    inputBridge.ps5SetProfileSummary(config.getPs5HomeSubtitle());
                    inputBridge.ps5SetUltraBadge(config.ultraOptimize, config.getUltraBadgeLabel());
                } else if (reloadGameIfRunning) {
                    launchGtaRuntime(lastLaunchMode);
                }
            }

            @Override
            public void onTriggerMemoryTrim() {
                triggerLiveMemoryTrim(true);
            }

            @Override
            public void onClosed() {
                applyImmersiveFullscreen();
            }
        });
        root.addView(settingsOverlay, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));

        setContentView(root);

        // Start real-time Android CPU/GPU/VRAM/RAM/FPS telemetry sampler
        statsMonitor = new StatsMonitor(this, snap -> runOnUiThread(() -> statsHud.update(snap)));
        statsMonitor.start();

        // Direct Boot mode bypasses PS5 Home WebView entirely to save ~150MB RAM on low-RAM phones!
        boolean directLaunch = getIntent().getBooleanExtra(EXTRA_DIRECT_LAUNCH, false) || config.skipPs5Home;
        String intentMode = getIntent().getStringExtra(EXTRA_LAUNCH_MODE);
        if (directLaunch) {
            launchGtaRuntime(intentMode != null ? intentMode : "default");
        } else {
            enterPs5Home();
        }
    }

    private void destroyActiveWebView() {
        if (activeWebView != null) {
            try {
                activeWebView.removeJavascriptInterface("GtaAndroidBridge");
                activeWebView.stopLoading();
                activeWebView.loadUrl("about:blank");
                activeWebView.clearHistory();
                activeWebView.clearCache(false);
                webViewHost.removeView(activeWebView);
                activeWebView.destroy();
            } catch (Throwable ignored) {}
            activeWebView = null;
            inputBridge.setWebView(null);
        }
    }

    @SuppressLint({"SetJavaScriptEnabled", "ClickableViewAccessibility"})
    private WebView createConfiguredWebView(boolean forGame) {
        destroyActiveWebView();

        WebView wv = new WebView(this);
        wv.setBackgroundColor(Color.BLACK);
        wv.setFocusable(true);
        wv.setFocusableInTouchMode(true);
        wv.setOverScrollMode(View.OVER_SCROLL_NEVER);
        wv.setLayerType(View.LAYER_TYPE_HARDWARE, null);

        // Block all direct screen taps on PS5 Home; allow tapping/dragging inside GTA V!
        wv.setOnTouchListener((v, e) -> !forGame);

        WebSettings ws = wv.getSettings();
        ws.setJavaScriptEnabled(true);
        ws.setDomStorageEnabled(true);
        ws.setDatabaseEnabled(true);
        ws.setMediaPlaybackRequiresUserGesture(false);
        ws.setUseWideViewPort(true);
        ws.setLoadWithOverviewMode(true);
        ws.setSupportZoom(false);
        ws.setBuiltInZoomControls(false);
        ws.setDisplayZoomControls(false);
        ws.setJavaScriptCanOpenWindowsAutomatically(false);
        ws.setCacheMode(WebSettings.LOAD_DEFAULT);
        ws.setTextZoom(100);

        if (!forGame) {
            ws.setAllowFileAccess(true);
            ws.setAllowFileAccessFromFileURLs(true);
            ws.setAllowUniversalAccessFromFileURLs(false);
        } else {
            ws.setAllowFileAccess(false);
            ws.setAllowContentAccess(true);
            ws.setMixedContentMode(WebSettings.MIXED_CONTENT_COMPATIBILITY_MODE);
            // Disable offscreen pre-rastering in Ultra Optimize Mode to cut GPU compositor VRAM!
            ws.setOffscreenPreRaster(!config.ultraOptimize);

            // Clean Chrome UA (removes "; wv") for optimal WebGPU + desktop resolution support
            String rawUa = ws.getUserAgentString();
            String chromeMajor = "136";
            if (rawUa != null) {
                Matcher m = CHROME_MAJOR.matcher(rawUa);
                if (m.find()) chromeMajor = m.group(1);
                ws.setUserAgentString(rawUa.replace("; wv", ""));
            } else {
                ws.setUserAgentString("Mozilla/5.0 (Linux; Android 14) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/"
                        + chromeMajor + ".0.0.0 Mobile Safari/537.36");
            }
            isolationBridge.setUserAgent(ws.getUserAgentString());

            // CRITICAL FOR "no memory" FIX: ALWAYS keep IMPORTANT renderer priority (never BOUND!)
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                wv.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, false);
            }
            CookieManager.getInstance().setAcceptThirdPartyCookies(wv, true);

            // CRITICAL FOR "not cross-origin isolated" FIX:
            // Opt https://playgta5.com into Chromium WebView's Cross-Origin Isolated Allowlist
            // AND register DOCUMENT_START_SCRIPT before page scripts parse!
            isolationBridge.applyToWebView(wv, bridgeScript);
        }

        wv.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onConsoleMessage(ConsoleMessage cm) {
                if (cm != null && cm.message() != null) {
                    String m = cm.message();
                    if (cm.messageLevel() == ConsoleMessage.MessageLevel.ERROR) {
                        lastConsoleError = m;
                        Log.w(TAG, "[WebView ERR] " + m + " (" + cm.sourceId() + ":" + cm.lineNumber() + ")");
                    }
                }
                return true;
            }
        });

        wv.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                if (forGame) {
                    if (isolationBridge.shouldInterceptDocument(request)) {
                        WebResourceResponse isolated = isolationBridge.fetchIsolatedDocument(request);
                        if (isolated != null) return isolated;
                    } else if (isolationBridge.shouldInterceptWorkerPatch(request)) {
                        WebResourceResponse patched = isolationBridge.fetchPatchedWorker(request);
                        if (patched != null) return patched;
                    }
                }
                return super.shouldInterceptRequest(view, request);
            }

            @Override
            public void onPageFinished(WebView v, String url) {
                super.onPageFinished(v, url);
                if (!forGame && url != null && url.startsWith("file:///android_asset/ps5_ui/")) {
                    inputBridge.ps5SetProfileSummary(config.getPs5HomeSubtitle());
                    inputBridge.ps5SetUltraBadge(config.ultraOptimize, config.getUltraBadgeLabel());
                    inputBridge.ps5ResetBoot();
                } else if (forGame && url != null && url.contains("playgta5.com")) {
                    if (!isolationBridge.isDocumentStartSupported()) {
                        injectBridge();
                    }
                    inputBridge.syncSettingsXml(config.buildSettingsXmlJson());
                }
            }

            @Override
            public void onReceivedError(WebView v, WebResourceRequest req, WebResourceError err) {
                super.onReceivedError(v, req, err);
                if (req != null && req.isForMainFrame() && forGame && inGameMode) {
                    runOnUiThread(() -> gameControlsOverlay.showError(
                            "Could not reach playgta5.com.\nCheck your internet connection and tap Reload.", false));
                }
            }

            @Override
            public void onReceivedSslError(WebView v, SslErrorHandler handler, SslError error) {
                handler.cancel();
                if (forGame && inGameMode) {
                    runOnUiThread(() -> gameControlsOverlay.showError(
                            "Secure HTTPS handshake failed while loading playgta5.com.", false));
                }
            }

            @Override
            public boolean onRenderProcessGone(WebView v, RenderProcessGoneDetail detail) {
                final boolean crashed = Build.VERSION.SDK_INT >= 26 && detail != null && detail.didCrash();
                runOnUiThread(() -> {
                    if (forGame && inGameMode) {
                        gameControlsOverlay.showError(crashed
                                ? "WebGPU renderer ran out of RAM/VRAM or crashed.\nTap ⚡ ULTRA EXTREME (270p · 128px BC Mip-Drop · 16MB IO) to force-run on low-RAM phones!"
                                : "Android LMK reclaimed renderer memory.\nClose background apps and tap ⚡ ULTRA EXTREME (270p Survival Mode).", false);
                    } else {
                        enterPs5Home();
                    }
                });
                return true;
            }
        });

        wv.addJavascriptInterface(new AndroidJsInterface(), "GtaAndroidBridge");
        webViewHost.addView(wv, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));
        wv.requestFocus();

        activeWebView = wv;
        inputBridge.setWebView(wv);
        return wv;
    }

    private void enterPs5Home() {
        inGameMode = false;
        if (gameControlsOverlay != null) {
            gameControlsOverlay.releaseAllInputs();
            gameControlsOverlay.setVisibility(View.GONE);
        }
        if (trainerOverlay != null) {
            trainerOverlay.setButtonVisible(false);
        }
        if (ps5ControllerOverlay != null) {
            ps5ControllerOverlay.setVisibility(View.VISIBLE);
        }
        positionStatsHud(false);
        config = LaunchConfig.load(this);

        WebView ps5Wv = createConfiguredWebView(false);
        ps5Wv.loadUrl(PS5_HOME_URL);
    }

    private void launchGtaRuntime(String mode) {
        lastLaunchMode = (mode == null || mode.isEmpty()) ? "default" : mode;
        lastConsoleError = "";
        awaitingCacheClearReload = false;
        config = LaunchConfig.load(this);
        isolationBridge.setLaunchConfig(config);
        if (statsMonitor != null) statsMonitor.resetGpuTelemetry();

        inGameMode = true;
        ps5ControllerOverlay.setVisibility(View.GONE);
        gameControlsOverlay.resetForNewLoad();
        gameControlsOverlay.setVisibility(View.VISIBLE);
        trainerOverlay.setButtonVisible(true);
        positionStatsHud(true);

        // Destroys PS5 Home WebView first (freeing its RAM), then starts dedicated isolated GTA V WebView!
        WebView gameWv = createConfiguredWebView(true);
        String targetUrl = config.buildGameUrl(lastLaunchMode);
        gameWv.loadUrl(targetUrl);
    }

    private void triggerLiveMemoryTrim(boolean notifyUser) {
        if (inGameMode && inputBridge != null) {
            inputBridge.triggerMemoryTrim();
        }
        if (activeWebView != null) {
            try {
                activeWebView.clearCache(false);
            } catch (Throwable ignored) {}
        }
        if (notifyUser) {
            Toast.makeText(this, "⚡ Flushed GPU BindGroups, Shader Packs & IO RAM Cache", Toast.LENGTH_SHORT).show();
        }
    }

    private void clearCacheAndReload() {
        awaitingCacheClearReload = true;
        if (activeWebView != null) {
            try {
                activeWebView.clearCache(true);
                activeWebView.evaluateJavascript(
                        "window.__gtaMobile && window.__gtaMobile.clearStorageCache && window.__gtaMobile.clearStorageCache();",
                        null);
            } catch (Throwable ignored) {}
        }
        // Fallback timeout in case the WebView renderer is unresponsive
        mainHandler.postDelayed(() -> {
            if (awaitingCacheClearReload && inGameMode) {
                awaitingCacheClearReload = false;
                launchGtaRuntime(lastLaunchMode);
            }
        }, 1800);
    }

    private void openWebViewPlayStore() {
        try {
            startActivity(new Intent(Intent.ACTION_VIEW,
                    Uri.parse("market://details?id=com.google.android.webview")));
        } catch (Throwable e) {
            try {
                startActivity(new Intent(Intent.ACTION_VIEW,
                        Uri.parse("https://play.google.com/store/apps/details?id=com.google.android.webview")));
            } catch (Throwable ignored) {}
        }
    }

    private void positionStatsHud(boolean inGame) {
        if (statsHud == null) return;
        FrameLayout.LayoutParams lp = new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.WRAP_CONTENT, FrameLayout.LayoutParams.WRAP_CONTENT,
                inGame ? (Gravity.TOP | Gravity.START) : (Gravity.TOP | Gravity.CENTER_HORIZONTAL));
        lp.topMargin = dp(8);
        lp.leftMargin = inGame ? dp(10) : 0;
        statsHud.setLayoutParams(lp);
    }

    private void injectBridge() {
        if (bridgeScript != null && !bridgeScript.isEmpty() && activeWebView != null) {
            activeWebView.evaluateJavascript(bridgeScript, null);
        }
    }

    @Override
    public void onBackPressed() {
        if (settingsOverlay != null && settingsOverlay.isShowing()) {
            settingsOverlay.hide();
            return;
        }
        if (trainerOverlay != null && trainerOverlay.isDrawerOpen()) {
            trainerOverlay.closeDrawer();
            return;
        }
        if (inGameMode) {
            inputBridge.pulseKey("Escape", 75);
        } else {
            inputBridge.ps5Circle();
        }
    }

    @Override
    protected void onResume() {
        super.onResume();
        applyImmersiveFullscreen();
        if (activeWebView != null) activeWebView.onResume();
        if (statsMonitor != null) statsMonitor.start();
    }

    @Override
    protected void onPause() {
        super.onPause();
        if (gameControlsOverlay != null) gameControlsOverlay.releaseAllInputs();
        if (activeWebView != null) activeWebView.onPause();
        if (statsMonitor != null) statsMonitor.stop();
    }

    @Override
    public void onTrimMemory(int level) {
        super.onTrimMemory(level);
        if (level >= ComponentCallbacks2.TRIM_MEMORY_RUNNING_MODERATE && inGameMode && inputBridge != null) {
            inputBridge.triggerMemoryTrim();
        }
        if (activeWebView != null && level >= ComponentCallbacks2.TRIM_MEMORY_RUNNING_LOW) {
            activeWebView.clearCache(false);
        }
    }

    @Override
    protected void onDestroy() {
        if (statsMonitor != null) statsMonitor.stop();
        if (trainerOverlay != null) trainerOverlay.shutdown();
        destroyActiveWebView();
        super.onDestroy();
    }

    @Override
    public void onWindowFocusChanged(boolean hasFocus) {
        super.onWindowFocusChanged(hasFocus);
        if (hasFocus) applyImmersiveFullscreen();
    }

    private void applyImmersiveFullscreen() {
        View decor = getWindow().getDecorView();
        decor.setSystemUiVisibility(
                View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                        | View.SYSTEM_UI_FLAG_LAYOUT_STABLE
                        | View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                        | View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                        | View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                        | View.SYSTEM_UI_FLAG_FULLSCREEN);
    }

    private String readAssetText(String name) {
        try (InputStream is = getAssets().open(name);
             BufferedReader br = new BufferedReader(new InputStreamReader(is, StandardCharsets.UTF_8))) {
            StringBuilder sb = new StringBuilder();
            String line;
            while ((line = br.readLine()) != null) sb.append(line).append('\n');
            return sb.toString();
        } catch (Exception e) {
            return "";
        }
    }

    private int dp(int v) {
        return Math.round(v * getResources().getDisplayMetrics().density);
    }

    // ==================== JS -> ANDROID BRIDGE ====================
    private final class AndroidJsInterface {
        @JavascriptInterface
        public void launchGtaGame(final String mode) {
            runOnUiThread(() -> launchGtaRuntime(mode));
        }

        @JavascriptInterface
        public void openPs5Settings() {
            runOnUiThread(() -> settingsOverlay.show(inGameMode));
        }

        @JavascriptInterface
        public void onFps(final int fps) {
            if (statsMonitor != null) statsMonitor.setFps(fps);
        }

        @JavascriptInterface
        public void onGpuTelemetry(final int texMb, final int bufMb, final int savedMb, final int texCnt, final boolean ultraOn) {
            if (statsMonitor != null) {
                statsMonitor.setGpuTelemetry(texMb, bufMb, savedMb, texCnt, ultraOn);
            }
        }

        @JavascriptInterface
        public void onMemoryTrimmed() {
            // Confirmed worker caches purged
        }

        @JavascriptInterface
        public void onProgress(final int pct, final String label) {
            // Legacy 2-arg hook
        }

        @JavascriptInterface
        public void onProgress(final int pct, final String label, final String dataText, final String consoleLine) {
            // Tracked via live in-page #ls-log & stall detector
        }

        @JavascriptInterface
        public void onLoadingStall(final int pct, final String label, final String dataText, final String consoleLine) {
            runOnUiThread(() -> {
                if (!inGameMode) return;
                StringBuilder sb = new StringBuilder();
                sb.append("Loading paused at ").append(pct).append("%");
                if (label != null && !label.isEmpty()) {
                    sb.append(" (").append(label).append(")");
                }
                sb.append('.');
                if (dataText != null && !dataText.isEmpty()) {
                    sb.append("\nStream: ").append(dataText);
                }
                String diag = (consoleLine != null && !consoleLine.isEmpty()) ? consoleLine : lastConsoleError;
                if (diag != null && !diag.isEmpty()) {
                    if (diag.length() > 140) diag = diag.substring(0, 140) + "…";
                    sb.append("\nLog: ").append(diag);
                }
                sb.append("\nTap WAIT to keep streaming, CLEAR CACHE to reset corrupt stream cache, or ⚡ ULTRA EXTREME.");
                gameControlsOverlay.showStallWarning(sb.toString());
            });
        }

        @JavascriptInterface
        public void onCacheCleared() {
            runOnUiThread(() -> {
                if (awaitingCacheClearReload && inGameMode) {
                    awaitingCacheClearReload = false;
                    launchGtaRuntime(lastLaunchMode);
                }
            });
        }

        @JavascriptInterface
        public void onTitleButtons(final String spec) {
            runOnUiThread(() -> {
                if (inGameMode) gameControlsOverlay.onTitleButtonsChanged(spec);
            });
        }

        @JavascriptInterface
        public void onWorldReady() {
            runOnUiThread(() -> {
                if (inGameMode) gameControlsOverlay.onWorldReady();
            });
        }

        @JavascriptInterface
        public void onCheatExecuted(final String code) {
            runOnUiThread(() -> {
                if (trainerOverlay != null) trainerOverlay.onCheatConfirmed(code);
            });
        }

        @JavascriptInterface
        public void onCapabilities(final boolean hasWebGpu, final boolean crossOriginIsolated, final boolean hasWasm) {
            if (!inGameMode) return;
            runOnUiThread(() -> {
                if (!hasWebGpu) {
                    gameControlsOverlay.showError(
                            "WebGPU was not detected in Android System WebView ("
                                    + WebViewIsolationBridge.getInstalledWebViewVersion()
                                    + ").\nUpdate Android System WebView from Play Store and retry.",
                            true);
                } else if (!crossOriginIsolated) {
                    String ver = WebViewIsolationBridge.getInstalledWebViewVersion();
                    String detail = isolationBridge.isCrossOriginIsolationSupported()
                            ? "Cross-origin isolation did not activate on this load.\nTap RELOAD or update Android System WebView (" + ver + ")."
                            : "Your Android System WebView (" + ver + ") is too old for in-app SharedArrayBuffer.\nTap UPDATE WEBVIEW (needs Chromium WebView v150+/v156+) to run inside this app in landscape!";
                    gameControlsOverlay.showError(detail, true);
                }
            });
        }

        @JavascriptInterface
        public void onEngineError(final String message) {
            runOnUiThread(() -> {
                if (!inGameMode) return;
                String msg = message != null ? message : "Runtime error";
                String lower = msg.toLowerCase();
                if (lower.contains("not cross-origin isolated")) {
                    String ver = WebViewIsolationBridge.getInstalledWebViewVersion();
                    gameControlsOverlay.showError(
                            "In-app shared memory requires an updated Android System WebView (v150+/v156+).\n"
                                    + "Installed: " + ver + "\nTap UPDATE WEBVIEW on Play Store, then tap RELOAD.",
                            true);
                } else if (lower.contains("no memory") || lower.contains("out of memory")) {
                    gameControlsOverlay.showError(
                            "Not enough free RAM/VRAM for current graphics tier.\n"
                                    + "Close background apps and tap ⚡ ULTRA EXTREME (270p · 128px BC Mip-Drop · 16MB IO).",
                            false);
                } else {
                    gameControlsOverlay.showError(msg, false);
                }
            });
        }
    }
}
