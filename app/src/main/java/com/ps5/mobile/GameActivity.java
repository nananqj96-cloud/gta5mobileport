package com.ps5.mobile;

import android.Manifest;
import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.ComponentCallbacks2;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.view.Gravity;
import android.view.View;
import android.view.WindowManager;
import android.webkit.ConsoleMessage;
import android.webkit.JavascriptInterface;
import android.webkit.WebChromeClient;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.FrameLayout;
import android.widget.Toast;

import com.ps5.mobile.bridge.GameInputBridge;
import com.ps5.mobile.config.LaunchConfig;
import com.ps5.mobile.proxy.RuntimeProxyService;
import com.ps5.mobile.stats.StatsHudView;
import com.ps5.mobile.stats.StatsMonitor;
import com.ps5.mobile.ui.DeveloperTrainerOverlay;
import com.ps5.mobile.ui.Ps5ControllerOverlay;
import com.ps5.mobile.ui.Ps5SettingsOverlay;

/**
 * Landscape PS5 Mobile Console Host:
 * 1) Boots directly into the PS5 Home Screen (assets/ps5_ui/index.html) with Ps5ControllerOverlay
 *    blocking direct screen taps so ONLY the DualSense UI controls navigate the PS5 UI.
 * 2) Selecting "Play Game" on GTA V starts our Foreground Localhost COOP/COEP Proxy (127.0.0.1:19555),
 *    releases WebView RAM so the phone has maximum free memory, and launches the proxied game URL
 *    in Chrome's 64-bit WebGPU engine (Chrome Custom Tab) with COOP/COEP crossOriginIsolated===true
 *    and our injected PS5 Touch Controls + Floating [D] Developer Trainer + Live Hardware Stats HUD!
 * 3) Returning from Chrome seamlessly restores the PS5 Home Screen with updated settings.
 */
public final class GameActivity extends Activity {

    private static final String PS5_HOME_URL = "file:///android_asset/ps5_ui/index.html";
    private static final int REQ_POST_NOTIFICATIONS = 4041;
    private static final String[] CHROMIUM_PACKAGES = {
            "com.android.chrome",
            "com.chrome.beta",
            "com.chrome.dev",
            "com.chrome.canary",
            "com.brave.browser",
            "com.microsoft.emmx"
    };

    private LaunchConfig config;
    private WebView webView;
    private GameInputBridge inputBridge;

    private Ps5ControllerOverlay ps5ControllerOverlay;
    private DeveloperTrainerOverlay trainerOverlay;
    private Ps5SettingsOverlay settingsOverlay;
    private StatsHudView statsHud;
    private StatsMonitor statsMonitor;

    private boolean launchedToChrome = false;
    private boolean askedNotificationPermission = false;
    private String pendingLaunchMode = null;

    @SuppressLint({"SetJavaScriptEnabled", "ClickableViewAccessibility"})
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        config = LaunchConfig.load(this);

        getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
        applyImmersiveFullscreen();

        FrameLayout root = new FrameLayout(this);
        root.setBackgroundColor(Color.BLACK);
        root.setMotionEventSplittingEnabled(true);

        // 1. Hardware-accelerated WebView hosting the offline PS5 Home UI
        webView = new WebView(this);
        webView.setBackgroundColor(Color.BLACK);
        webView.setFocusable(true);
        webView.setFocusableInTouchMode(true);
        webView.requestFocus();
        webView.setLayerType(View.LAYER_TYPE_HARDWARE, null);
        // Strictly block direct taps/drags on the PS5 UI so ONLY DualSense controls navigate!
        webView.setOnTouchListener((v, e) -> true);

        configureWebView(webView);
        inputBridge = new GameInputBridge(webView);
        webView.addJavascriptInterface(new AndroidJsInterface(), "GtaAndroidBridge");
        root.addView(webView, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));

        // 2. PS5 Home Controller Overlay (strict controller-only PS5 navigation)
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

        // 3. Floating [D] Developer Trainer (available on PS5 Home for pre-tuning Graphics / Render Distance)
        trainerOverlay = new DeveloperTrainerOverlay(this, inputBridge, new DeveloperTrainerOverlay.Callback() {
            @Override
            public void onSwitchToFlyHud() {
                Toast.makeText(GameActivity.this, "Switch to FLY mode inside the game top bar", Toast.LENGTH_SHORT).show();
            }

            @Override
            public void onReloadGameWithNewGraphics(String optionalLaunchMode) {
                config = LaunchConfig.load(GameActivity.this);
                inputBridge.ps5SetProfileSummary(config.getPs5HomeSubtitle());
                if (optionalLaunchMode != null) {
                    requestLaunchGtaInChrome(optionalLaunchMode);
                } else {
                    Toast.makeText(GameActivity.this, "Graphics & Render Distance saved for next launch", Toast.LENGTH_SHORT).show();
                }
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
                trainerOverlay.closeDrawer();
            }
        });
        trainerOverlay.setButtonVisible(true);
        root.addView(trainerOverlay, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));

        // 4. Floating Hardware Statistics Viewer HUD (top-center on PS5 Home)
        statsHud = new StatsHudView(this);
        statsHud.applyVisibility(config.statsEnabled, config.statsShowFps, config.statsShowCpuGpu, config.statsShowRam);
        FrameLayout.LayoutParams statsLp = new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.WRAP_CONTENT, FrameLayout.LayoutParams.WRAP_CONTENT,
                Gravity.TOP | Gravity.CENTER_HORIZONTAL);
        statsLp.topMargin = dp(8);
        root.addView(statsHud, statsLp);

        // 5. PS5 System Settings & Telemetry Overlay (topmost modal)
        settingsOverlay = new Ps5SettingsOverlay(this, new Ps5SettingsOverlay.Callback() {
            @Override
            public void onStatsSettingsChanged(boolean enabled, boolean fps, boolean cpuGpu, boolean ram) {
                config = LaunchConfig.load(GameActivity.this);
                statsHud.applyVisibility(enabled, fps, cpuGpu, ram);
            }

            @Override
            public void onGraphicsSettingsChanged(boolean reloadGameIfRunning) {
                config = LaunchConfig.load(GameActivity.this);
                inputBridge.ps5SetProfileSummary(config.getPs5HomeSubtitle());
            }

            @Override
            public void onClosed() {
                applyImmersiveFullscreen();
            }
        });
        root.addView(settingsOverlay, new FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT));

        setContentView(root);

        statsMonitor = new StatsMonitor(this, snap -> runOnUiThread(() -> statsHud.update(snap)));
        statsMonitor.start();

        loadPs5Home();
    }

    @SuppressLint("SetJavaScriptEnabled")
    private void configureWebView(WebView view) {
        WebSettings ws = view.getSettings();
        ws.setJavaScriptEnabled(true);
        ws.setDomStorageEnabled(true);
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
                    config = LaunchConfig.load(GameActivity.this);
                    inputBridge.ps5SetProfileSummary(config.getPs5HomeSubtitle());
                    inputBridge.ps5ResetBoot();
                }
            }
        });
    }

    private void loadPs5Home() {
        launchedToChrome = false;
        config = LaunchConfig.load(this);
        statsHud.applyVisibility(config.statsEnabled, config.statsShowFps, config.statsShowCpuGpu, config.statsShowRam);
        if (webView != null) {
            webView.stopLoading();
            webView.loadUrl(PS5_HOME_URL);
        }
    }

    private void requestLaunchGtaInChrome(String mode) {
        final String cleanMode = (mode == null || mode.isEmpty()) ? "default" : mode;
        if (Build.VERSION.SDK_INT >= 33 && !askedNotificationPermission
                && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            askedNotificationPermission = true;
            pendingLaunchMode = cleanMode;
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, REQ_POST_NOTIFICATIONS);
            return;
        }
        startProxyAndOpenChrome(cleanMode);
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == REQ_POST_NOTIFICATIONS && pendingLaunchMode != null) {
            String mode = pendingLaunchMode;
            pendingLaunchMode = null;
            startProxyAndOpenChrome(mode);
        }
    }

    private void startProxyAndOpenChrome(final String mode) {
        Toast.makeText(this, "Starting Chrome 64-bit COOP/COEP Engine...", Toast.LENGTH_SHORT).show();
        new Thread(() -> {
            try {
                final int port = RuntimeProxyService.ensureStarted(GameActivity.this);
                final LaunchConfig latest = LaunchConfig.load(GameActivity.this);
                final String localUrl = latest.buildGameUrl("http://localhost:" + port, mode);

                runOnUiThread(() -> {
                    // Release PS5 Home WebView memory BEFORE opening Chrome so Chrome gets max free RAM!
                    launchedToChrome = true;
                    if (webView != null) {
                        webView.stopLoading();
                        webView.loadUrl("about:blank");
                        webView.clearCache(false);
                    }
                    openInChromeCustomTab(localUrl);
                });
            } catch (Exception e) {
                runOnUiThread(() -> {
                    inputBridge.ps5ResetBoot();
                    Toast.makeText(GameActivity.this,
                            "Could not start local COOP/COEP bridge: " + e.getMessage(),
                            Toast.LENGTH_LONG).show();
                });
            }
        }).start();
    }

    private void openInChromeCustomTab(String url) {
        Uri uri = Uri.parse(url);
        String pkg = findBestChromiumPackage();

        Intent customTab = new Intent(Intent.ACTION_VIEW, uri);
        Bundle sessionBundle = new Bundle();
        sessionBundle.putBinder("android.support.customtabs.extra.SESSION", null);
        customTab.putExtras(sessionBundle);
        customTab.putExtra("android.support.customtabs.extra.TOOLBAR_COLOR", Color.parseColor("#040712"));
        customTab.putExtra("android.support.customtabs.extra.SECONDARY_TOOLBAR_COLOR", Color.parseColor("#040712"));
        customTab.putExtra("android.support.customtabs.extra.ENABLE_URLBAR_HIDING", true);
        customTab.putExtra("android.support.customtabs.extra.TITLE_VISIBILITY", 0);
        customTab.putExtra("androidx.browser.customtabs.extra.COLOR_SCHEME", 2);
        if (pkg != null) {
            customTab.setPackage(pkg);
        }

        try {
            startActivity(customTab);
        } catch (Exception e) {
            // Fallback to plain external browser intent
            try {
                Intent plain = new Intent(Intent.ACTION_VIEW, uri);
                if (pkg != null) plain.setPackage(pkg);
                startActivity(plain);
            } catch (Exception e2) {
                startActivity(new Intent(Intent.ACTION_VIEW, uri));
            }
        }
    }

    private String findBestChromiumPackage() {
        PackageManager pm = getPackageManager();
        for (String pkg : CHROMIUM_PACKAGES) {
            try {
                pm.getPackageInfo(pkg, 0);
                return pkg;
            } catch (PackageManager.NameNotFoundException ignored) {}
        }
        return null;
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
        inputBridge.ps5Circle();
    }

    @Override
    protected void onResume() {
        super.onResume();
        applyImmersiveFullscreen();
        if (webView != null) webView.onResume();
        if (statsMonitor != null) statsMonitor.start();
        if (launchedToChrome) {
            // User returned from Chrome Custom Tab -> restore PS5 Home Screen with synced settings
            loadPs5Home();
        } else {
            config = LaunchConfig.load(this);
            statsHud.applyVisibility(config.statsEnabled, config.statsShowFps, config.statsShowCpuGpu, config.statsShowRam);
            if (inputBridge != null) inputBridge.ps5SetProfileSummary(config.getPs5HomeSubtitle());
        }
    }

    @Override
    protected void onPause() {
        super.onPause();
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

    private int dp(int v) {
        return Math.round(v * getResources().getDisplayMetrics().density);
    }

    // ==================== PS5 HOME JS -> ANDROID BRIDGE ====================
    private final class AndroidJsInterface {
        @JavascriptInterface
        public void launchGtaGame(final String mode) {
            runOnUiThread(() -> requestLaunchGtaInChrome(mode));
        }

        @JavascriptInterface
        public void openPs5Settings() {
            runOnUiThread(() -> settingsOverlay.show(false));
        }

        @JavascriptInterface
        public void onFps(final int fps) {
            if (statsMonitor != null) statsMonitor.setFps(fps);
        }
    }
}
