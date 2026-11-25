package com.ps5.mobile;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.ComponentCallbacks2;
import android.graphics.Color;
import android.net.http.SslError;
import android.os.Build;
import android.os.Bundle;
import android.view.Gravity;
import android.view.View;
import android.view.WindowManager;
import android.webkit.ConsoleMessage;
import android.webkit.JavascriptInterface;
import android.webkit.RenderProcessGoneDetail;
import android.webkit.SslErrorHandler;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceError;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;

import com.ps5.mobile.bridge.GameInputBridge;
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

/**
 * Unified landscape PS5 Emulator + GTA V Runtime host:
 * 1) Boots directly into the PS5 Home Screen (assets/ps5_ui/index.html) with Ps5ControllerOverlay
 *    blocking all direct screen taps so ONLY the DualSense UI controls navigate the PS5 UI.
 * 2) Selecting "Play Game" on GTA V seamlessly transitions to playgta5.com with MobileControlsOverlay
 *    (allowing dragging/tapping & full touch gameplay) + the Floating [D] Developer Trainer.
 * 3) Runs StatsMonitor + StatsHudView (FPS, CPU/GPU, RAM) continuously across both modes,
 *    togglable ON/OFF anytime from Ps5SettingsOverlay.
 */
public final class GameActivity extends Activity {

    private static final String PS5_HOME_URL = "file:///android_asset/ps5_ui/index.html";

    private LaunchConfig config;
    private WebView webView;
    private GameInputBridge inputBridge;

    private Ps5ControllerOverlay ps5ControllerOverlay;
    private MobileControlsOverlay gameControlsOverlay;
    private DeveloperTrainerOverlay trainerOverlay;
    private Ps5SettingsOverlay settingsOverlay;
    private StatsHudView statsHud;
    private StatsMonitor statsMonitor;

    private String bridgeScript;
    private boolean inGameMode = false;
    private String lastLaunchMode = "default";

    @SuppressLint({"SetJavaScriptEnabled", "ClickableViewAccessibility"})
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        config = LaunchConfig.load(this);
        bridgeScript = readAssetText("mobile_bridge.js");

        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        applyImmersiveFullscreen();

        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.BLACK);
        root.setMotionEventSplittingEnabled(true);

        // 1. Hardware-accelerated WebView hosting PS5 Home UI & playgta5.com WebGPU runtime
        webView = new WebView(this);
        webView.setBackgroundColor(Color.BLACK);
        webView.setFocusable(true);
        webView.setFocusableInTouchMode(true);
        webView.requestFocus();
        webView.setLayerType(View.LAYER_TYPE_HARDWARE, null);
        // Strictly block direct taps/drags on WebView while on PS5 Home UI!
        webView.setOnTouchListener((v, e) -> !inGameMode);

        configureWebView(webView, config);
        inputBridge = new GameInputBridge(webView);
        webView.addJavascriptInterface(new AndroidJsInterface(), "GtaAndroidBridge");
        root.addView(webView, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));

        // 2. GTA V Gameplay Controls Overlay (hidden while on PS5 Home)
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
            public void onReloadGame(boolean forcePotatoLowEnd) {
                if (forcePotatoLowEnd) {
                    LaunchConfig.saveGraphicsPreset(GameActivity.this, LaunchConfig.PRESET_POTATO);
                    config = LaunchConfig.load(GameActivity.this);
                }
                launchGtaRuntime(lastLaunchMode);
            }
        });
        gameControlsOverlay.setVisibility(View.GONE);
        root.addView(gameControlsOverlay, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));

        // 3. PS5 Home Controller Overlay (active while on PS5 Home — blocks direct taps on PS5 UI)
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

        // 4. Floating [D] Developer Trainer Overlay (visible during GTA V gameplay)
        trainerOverlay = new DeveloperTrainerOverlay(this, inputBridge, new DeveloperTrainerOverlay.Callback() {
            @Override
            public void onSwitchToFlyHud() {
                gameControlsOverlay.setControlMode(MobileControlsOverlay.ControlMode.FLY);
            }

            @Override
            public void onReloadGameWithNewGraphics(String optionalLaunchMode) {
                config = LaunchConfig.load(GameActivity.this);
                applyWebViewMemoryProfile(config);
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
            public void onReturnToPs5Home() {
                enterPs5Home();
            }
        });
        trainerOverlay.setButtonVisible(false);
        root.addView(trainerOverlay, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));

        // 5. Floating Hardware Statistics Viewer HUD (top-left, visible across PS5 Home & GTA V when enabled)
        statsHud = new StatsHudView(this);
        statsHud.applyVisibility(config.statsEnabled, config.statsShowFps, config.statsShowCpuGpu, config.statsShowRam);
        FrameLayout.LayoutParams statsLp = new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.WRAP_CONTENT, FrameLayout.LayoutParams.WRAP_CONTENT,
                Gravity.TOP | Gravity.START);
        statsLp.leftMargin = dp(10);
        statsLp.topMargin = dp(8);
        root.addView(statsHud, statsLp);

        // 6. PS5 System Settings & Telemetry Overlay (topmost modal)
        settingsOverlay = new Ps5SettingsOverlay(this, new Ps5SettingsOverlay.Callback() {
            @Override
            public void onStatsSettingsChanged(boolean enabled, boolean fps, boolean cpuGpu, boolean ram) {
                config = LaunchConfig.load(GameActivity.this);
                statsHud.applyVisibility(enabled, fps, cpuGpu, ram);
            }

            @Override
            public void onGraphicsSettingsChanged(boolean reloadGameIfRunning) {
                config = LaunchConfig.load(GameActivity.this);
                applyWebViewMemoryProfile(config);
                if (!inGameMode) {
                    inputBridge.ps5SetProfileSummary(config.getPs5HomeSubtitle());
                } else if (reloadGameIfRunning) {
                    launchGtaRuntime(lastLaunchMode);
                }
            }

            @Override
            public void onClosed() {
                applyImmersiveFullscreen();
            }
        });
        root.addView(settingsOverlay, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));

        setContentView(root);

        // Start real-time Android CPU/GPU/RAM/FPS telemetry sampler
        statsMonitor = new StatsMonitor(this, snap -> runOnUiThread(() -> statsHud.update(snap)));
        statsMonitor.start();

        // Boot straight into the PS5 Home Screen
        enterPs5Home();
    }

    @SuppressLint("SetJavaScriptEnabled")
    private void configureWebView(WebView view, LaunchConfig cfg) {
        WebSettings ws = view.getSettings();
        ws.setJavaScriptEnabled(true);
        ws.setDomStorageEnabled(true);
        ws.setDatabaseEnabled(true);
        ws.setMediaPlaybackRequiresUserGesture(false);
        ws.setAllowFileAccess(true);
        ws.setAllowFileAccessFromFileURLs(true);
        ws.setAllowUniversalAccessFromFileURLs(false);
        ws.setUseWideViewPort(true);
        ws.setLoadWithOverviewMode(true);
        ws.setSupportZoom(false);
        ws.setBuiltInZoomControls(false);
        ws.setDisplayZoomControls(false);
        ws.setJavaScriptCanOpenWindowsAutomatically(false);
        ws.setCacheMode(WebSettings.LOAD_DEFAULT);

        // Desktop-class Chrome UA helps playgta5.com unlock WebGPU cleanly on Android Chromium WebView
        String ua = ws.getUserAgentString();
        if (ua != null) {
            ws.setUserAgentString(ua.replace("; wv", ""));
        }

        applyWebViewMemoryProfile(cfg);

        view.setWebChromeClient(new WebChromeClient() {
            @Override
            public boolean onConsoleMessage(ConsoleMessage cm) {
                return true;
            }
        });

        view.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageFinished(WebView v, String url) {
                super.onPageFinished(v, url);
                if (url != null && url.startsWith("file:///android_asset/ps5_ui/")) {
                    inputBridge.ps5SetProfileSummary(config.getPs5HomeSubtitle());
                    inputBridge.ps5ResetBoot();
                } else if (url != null && url.contains("playgta5.com")) {
                    injectBridge();
                    inputBridge.syncSettingsXml(config.buildSettingsXmlJson());
                }
            }

            @Override
            public void onReceivedError(WebView v, WebResourceRequest req, WebResourceError err) {
                super.onReceivedError(v, req, err);
                if (req != null && req.isForMainFrame() && inGameMode) {
                    runOnUiThread(() -> gameControlsOverlay.showError(
                            "Could not reach playgta5.com.\nCheck your internet connection and tap Reload."));
                }
            }

            @Override
            public void onReceivedSslError(WebView v, SslErrorHandler handler, SslError error) {
                handler.cancel();
                if (inGameMode) {
                    runOnUiThread(() -> gameControlsOverlay.showError(
                            "Secure connection error loading runtime."));
                }
            }

            @Override
            public boolean onRenderProcessGone(WebView v, RenderProcessGoneDetail detail) {
                final boolean crashed = Build.VERSION.SDK_INT >= 26 && detail != null && detail.didCrash();
                runOnUiThread(() -> {
                    if (inGameMode) {
                        gameControlsOverlay.showError(crashed
                                ? "WebGPU renderer crashed.\nTry Potato Low-End Mode or lower Render Distance."
                                : "Android reclaimed memory from the game process.\nTap Retry Potato Low-End Mode.");
                    } else {
                        finish();
                    }
                });
                return true;
            }
        });
    }

    private void applyWebViewMemoryProfile(LaunchConfig cfg) {
        if (webView == null) return;
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            if (cfg.lowEndMode || cfg.graphicsPreset <= LaunchConfig.PRESET_ULTRA_LOW) {
                webView.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_BOUND, true);
                webView.clearCache(false);
            } else {
                webView.setRendererPriorityPolicy(WebView.RENDERER_PRIORITY_IMPORTANT, false);
            }
        }
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
        webView.stopLoading();
        webView.loadUrl(PS5_HOME_URL);
    }

    private void launchGtaRuntime(String mode) {
        lastLaunchMode = (mode == null || mode.isEmpty()) ? "default" : mode;
        config = LaunchConfig.load(this);
        applyWebViewMemoryProfile(config);

        inGameMode = true;
        ps5ControllerOverlay.setVisibility(View.GONE);
        gameControlsOverlay.resetForNewLoad();
        gameControlsOverlay.setVisibility(View.VISIBLE);
        trainerOverlay.setButtonVisible(true);
        positionStatsHud(true);

        webView.requestFocus();
        String targetUrl = config.buildGameUrl(lastLaunchMode);
        webView.loadUrl(targetUrl);
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
        if (bridgeScript != null && !bridgeScript.isEmpty() && webView != null) {
            webView.evaluateJavascript(bridgeScript, null);
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
        if (webView != null) webView.onResume();
        if (statsMonitor != null) statsMonitor.start();
    }

    @Override
    protected void onPause() {
        super.onPause();
        if (gameControlsOverlay != null) gameControlsOverlay.releaseAllInputs();
        if (webView != null) webView.onPause();
        if (statsMonitor != null) statsMonitor.stop();
    }

    @Override
    public void onTrimMemory(int level) {
        super.onTrimMemory(level);
        if (webView != null && level >= ComponentCallbacks2.TRIM_MEMORY_RUNNING_LOW) {
            webView.clearCache(false);
        }
    }

    @Override
    protected void onDestroy() {
        if (statsMonitor != null) statsMonitor.stop();
        if (trainerOverlay != null) trainerOverlay.shutdown();
        if (webView != null) {
            webView.removeJavascriptInterface("GtaAndroidBridge");
            webView.stopLoading();
            webView.destroy();
            webView = null;
        }
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
        public void onProgress(final int pct, final String label) {
            // Tracked via title dock / loading progress
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
            if (!hasWebGpu && inGameMode) {
                runOnUiThread(() -> gameControlsOverlay.showError(
                        "WebGPU was not detected in Android System WebView.\nUpdate Android System WebView (Chrome 121+) from Play Store and try again."));
            }
        }

        @JavascriptInterface
        public void onEngineError(final String message) {
            runOnUiThread(() -> {
                if (inGameMode) gameControlsOverlay.showError(message);
            });
        }
    }
}
