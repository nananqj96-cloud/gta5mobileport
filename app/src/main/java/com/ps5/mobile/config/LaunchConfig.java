package com.ps5.mobile.config;

import android.app.ActivityManager;
import android.content.Context;
import android.content.SharedPreferences;
import android.net.Uri;
import android.util.DisplayMetrics;

import org.json.JSONObject;

import java.util.ArrayList;
import java.util.List;
import java.util.Locale;

/**
 * Persists all PS5 Android launcher & GTA V runtime engine tuning settings:
 * - Low-End Phone Mode resource saver
 * - True Below-Menu Graphics Presets (fixing playgta5.com's in-game graphics floor)
 * - Numeric Render Distance (-1 = engine default, or 0..100 -> -lodScale/-pedLodBias/-vehicleLodBias/-cityDensity)
 * - Hardware Statistics Viewer toggles (FPS, CPU/GPU, RAM)
 */
public final class LaunchConfig {

    private static final String PREFS = "ps5_mobile_prefs";
    private static final String KEY_LOW_END = "low_end_mode";
    private static final String KEY_GFX_PRESET = "gfx_preset";
    private static final String KEY_RENDER_DIST = "render_distance"; // -1 = Default, 0..100
    private static final String KEY_RES_SCALE = "res_scale_pct";     // 35..100
    private static final String KEY_SHADOWS = "shadows_level";       // -1=Off, 0=Lowest, 1=Normal, 2=High
    private static final String KEY_FPS_CAP = "fps_cap";             // 30, 60, 0 (uncapped)
    private static final String KEY_DBG_DRAWS = "dbg_draws";
    private static final String KEY_STATS_ON = "stats_enabled";
    private static final String KEY_STATS_FPS = "stats_fps";
    private static final String KEY_STATS_CPUGPU = "stats_cpugpu";
    private static final String KEY_STATS_RAM = "stats_ram";

    public static final int PRESET_POTATO = 0;
    public static final int PRESET_ULTRA_LOW = 1;
    public static final int PRESET_LOW = 2;
    public static final int PRESET_MEDIUM = 3;
    public static final int PRESET_HIGH = 4;

    public static final String[] PRESET_SHORT = {"POTATO", "U-LOW", "LOW", "MED", "HIGH"};
    public static final String[] PRESET_LABELS = {
            "Potato (Ultra-Low · 45% · No Shadows)",
            "Ultra Low (60% · Shadows Off)",
            "Low (75% · Soft Shadows)",
            "Medium (88% · Balanced)",
            "High (100% · PS5 Fidelity)"
    };

    public final boolean lowEndMode;
    public final int graphicsPreset;
    public final int renderDistance; // -1 = GTA V engine default, 0..100 custom
    public final int resScalePct;
    public final int shadowsLevel;   // -1, 0, 1, 2
    public final int fpsCap;         // 30, 60, 0
    public final boolean debugDraws;

    public final boolean statsEnabled;
    public final boolean statsShowFps;
    public final boolean statsShowCpuGpu;
    public final boolean statsShowRam;

    public final long totalRamMb;
    public final int cpuCores;
    public final int renderWidth;
    public final int renderHeight;
    public final int engineCores;
    public final int gpuSlots;
    public final int bridgeFlushIntervalMs;

    private LaunchConfig(
            boolean lowEndMode, int graphicsPreset, int renderDistance,
            int resScalePct, int shadowsLevel, int fpsCap, boolean debugDraws,
            boolean statsEnabled, boolean statsShowFps, boolean statsShowCpuGpu, boolean statsShowRam,
            long totalRamMb, int cpuCores, int renderWidth, int renderHeight,
            int engineCores, int gpuSlots, int bridgeFlushIntervalMs) {
        this.lowEndMode = lowEndMode;
        this.graphicsPreset = graphicsPreset;
        this.renderDistance = renderDistance;
        this.resScalePct = resScalePct;
        this.shadowsLevel = shadowsLevel;
        this.fpsCap = fpsCap;
        this.debugDraws = debugDraws;
        this.statsEnabled = statsEnabled;
        this.statsShowFps = statsShowFps;
        this.statsShowCpuGpu = statsShowCpuGpu;
        this.statsShowRam = statsShowRam;
        this.totalRamMb = totalRamMb;
        this.cpuCores = cpuCores;
        this.renderWidth = renderWidth;
        this.renderHeight = renderHeight;
        this.engineCores = engineCores;
        this.gpuSlots = gpuSlots;
        this.bridgeFlushIntervalMs = bridgeFlushIntervalMs;
    }

    public static long readTotalRamMb(Context ctx) {
        ActivityManager am = (ActivityManager) ctx.getSystemService(Context.ACTIVITY_SERVICE);
        if (am == null) return 4096L;
        ActivityManager.MemoryInfo mi = new ActivityManager.MemoryInfo();
        am.getMemoryInfo(mi);
        return Math.max(1024L, mi.totalMem / (1024L * 1024L));
    }

    public static int readCpuCores() {
        return Math.max(2, Runtime.getRuntime().availableProcessors());
    }

    public static int defaultScaleForPreset(int preset) {
        switch (preset) {
            case PRESET_POTATO: return 45;
            case PRESET_ULTRA_LOW: return 60;
            case PRESET_LOW: return 75;
            case PRESET_MEDIUM: return 88;
            default: return 100;
        }
    }

    public static int defaultShadowsForPreset(int preset) {
        switch (preset) {
            case PRESET_POTATO:
            case PRESET_ULTRA_LOW: return -1;
            case PRESET_LOW: return 0;
            case PRESET_MEDIUM: return 1;
            default: return 2;
        }
    }

    public static void saveLowEndMode(Context ctx, boolean lowEnd) {
        SharedPreferences.Editor ed = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit();
        ed.putBoolean(KEY_LOW_END, lowEnd);
        int targetPreset = lowEnd ? PRESET_ULTRA_LOW : PRESET_LOW;
        ed.putInt(KEY_GFX_PRESET, targetPreset);
        ed.putInt(KEY_RES_SCALE, defaultScaleForPreset(targetPreset));
        ed.putInt(KEY_SHADOWS, defaultShadowsForPreset(targetPreset));
        ed.putInt(KEY_FPS_CAP, lowEnd ? 30 : 60);
        ed.apply();
    }

    public static void saveGraphicsPreset(Context ctx, int preset) {
        int clamped = Math.max(PRESET_POTATO, Math.min(PRESET_HIGH, preset));
        SharedPreferences.Editor ed = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit();
        ed.putInt(KEY_GFX_PRESET, clamped);
        ed.putInt(KEY_RES_SCALE, defaultScaleForPreset(clamped));
        ed.putInt(KEY_SHADOWS, defaultShadowsForPreset(clamped));
        if (clamped <= PRESET_ULTRA_LOW) {
            ed.putBoolean(KEY_LOW_END, true);
            ed.putInt(KEY_FPS_CAP, 30);
        }
        ed.apply();
    }

    public static void saveRenderDistance(Context ctx, int distance) {
        int val = distance < 0 ? -1 : Math.max(0, Math.min(100, distance));
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                .edit().putInt(KEY_RENDER_DIST, val).apply();
    }

    public static void saveAdvancedGraphics(Context ctx, int preset, int resScalePct, int shadows,
                                            int fpsCap, int renderDistance, boolean lowEnd, boolean debugDraws) {
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
                .putInt(KEY_GFX_PRESET, Math.max(PRESET_POTATO, Math.min(PRESET_HIGH, preset)))
                .putInt(KEY_RES_SCALE, Math.max(35, Math.min(100, resScalePct)))
                .putInt(KEY_SHADOWS, Math.max(-1, Math.min(2, shadows)))
                .putInt(KEY_FPS_CAP, fpsCap)
                .putInt(KEY_RENDER_DIST, renderDistance < 0 ? -1 : Math.max(0, Math.min(100, renderDistance)))
                .putBoolean(KEY_LOW_END, lowEnd)
                .putBoolean(KEY_DBG_DRAWS, debugDraws)
                .apply();
    }

    public static void saveStatsPrefs(Context ctx, boolean enabled, boolean showFps, boolean showCpuGpu, boolean showRam) {
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit()
                .putBoolean(KEY_STATS_ON, enabled)
                .putBoolean(KEY_STATS_FPS, showFps)
                .putBoolean(KEY_STATS_CPUGPU, showCpuGpu)
                .putBoolean(KEY_STATS_RAM, showRam)
                .apply();
    }

    public static void applyPartialJson(Context ctx, JSONObject obj) {
        if (obj == null) return;
        SharedPreferences.Editor ed = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit();
        if (obj.has("lowEndMode")) ed.putBoolean(KEY_LOW_END, obj.optBoolean("lowEndMode"));
        if (obj.has("graphicsPreset")) ed.putInt(KEY_GFX_PRESET, Math.max(0, Math.min(4, obj.optInt("graphicsPreset"))));
        if (obj.has("renderDistance")) {
            int rd = obj.optInt("renderDistance", -1);
            ed.putInt(KEY_RENDER_DIST, rd < 0 ? -1 : Math.max(0, Math.min(100, rd)));
        }
        if (obj.has("resScalePct")) ed.putInt(KEY_RES_SCALE, Math.max(35, Math.min(100, obj.optInt("resScalePct", 75))));
        if (obj.has("shadowsLevel")) ed.putInt(KEY_SHADOWS, Math.max(-1, Math.min(2, obj.optInt("shadowsLevel", -1))));
        if (obj.has("fpsCap")) ed.putInt(KEY_FPS_CAP, obj.optInt("fpsCap", 30));
        if (obj.has("debugDraws")) ed.putBoolean(KEY_DBG_DRAWS, obj.optBoolean("debugDraws"));
        if (obj.has("statsEnabled")) ed.putBoolean(KEY_STATS_ON, obj.optBoolean("statsEnabled"));
        if (obj.has("statsShowFps")) ed.putBoolean(KEY_STATS_FPS, obj.optBoolean("statsShowFps"));
        if (obj.has("statsShowCpuGpu")) ed.putBoolean(KEY_STATS_CPUGPU, obj.optBoolean("statsShowCpuGpu"));
        if (obj.has("statsShowRam")) ed.putBoolean(KEY_STATS_RAM, obj.optBoolean("statsShowRam"));
        ed.apply();
    }

    public static LaunchConfig load(Context ctx) {
        SharedPreferences sp = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE);
        long ramMb = readTotalRamMb(ctx);
        int cores = readCpuCores();

        boolean lowEnd = sp.contains(KEY_LOW_END) ? sp.getBoolean(KEY_LOW_END, false) : (ramMb <= 6400L);
        int preset = sp.getInt(KEY_GFX_PRESET, lowEnd ? PRESET_ULTRA_LOW : PRESET_LOW);
        int renderDist = sp.getInt(KEY_RENDER_DIST, -1); // Default = GTA V engine default
        int scalePct = sp.getInt(KEY_RES_SCALE, defaultScaleForPreset(preset));
        int shadows = sp.getInt(KEY_SHADOWS, defaultShadowsForPreset(preset));
        int fpsCap = sp.getInt(KEY_FPS_CAP, lowEnd ? 30 : 60);
        boolean dbgDraws = sp.getBoolean(KEY_DBG_DRAWS, false);

        boolean statsOn = sp.getBoolean(KEY_STATS_ON, true);
        boolean statsFps = sp.getBoolean(KEY_STATS_FPS, true);
        boolean statsCpuGpu = sp.getBoolean(KEY_STATS_CPUGPU, true);
        boolean statsRam = sp.getBoolean(KEY_STATS_RAM, true);

        DisplayMetrics dm = ctx.getResources().getDisplayMetrics();
        int longSide = Math.max(dm.widthPixels, dm.heightPixels);
        int shortSide = Math.max(1, Math.min(dm.widthPixels, dm.heightPixels));
        float aspect = Math.max(1.5f, Math.min(2.25f, (float) longSide / (float) shortSide));

        int baseH = lowEnd ? 720 : (ramMb >= 7500L ? 810 : 720);
        int targetH = Math.max(300, Math.round((baseH * (scalePct / 100f)) / 2f) * 2);
        int targetW = Math.max(480, Math.round((targetH * aspect) / 2f) * 2);

        int engineCores = (lowEnd || preset <= PRESET_ULTRA_LOW) ? 2 : Math.min(cores, 4);
        int gpuSlots = (lowEnd || preset <= PRESET_ULTRA_LOW) ? 2 : 3;
        int flushMs = (lowEnd || fpsCap == 30) ? 33 : 16;

        return new LaunchConfig(
                lowEnd, preset, renderDist, scalePct, shadows, fpsCap, dbgDraws,
                statsOn, statsFps, statsCpuGpu, statsRam,
                ramMb, cores, targetW, targetH, engineCores, gpuSlots, flushMs
        );
    }

    /**
     * Builds the tuned runtime URL (either http://localhost:<PORT>/ via our COOP/COEP Chrome proxy
     * or https://playgta5.com/) with real RAGE engine graphics & render-distance arguments.
     */
    public String buildGameUrl(String baseOrigin, String launchMode) {
        String root = (baseOrigin == null || baseOrigin.isEmpty()) ? "https://playgta5.com/" : baseOrigin;
        if (!root.endsWith("/")) root = root + "/";

        boolean engineLowProfile = lowEndMode || graphicsPreset <= PRESET_LOW;
        Uri.Builder b = Uri.parse(root).buildUpon();

        b.appendQueryParameter("low", engineLowProfile ? "1" : "0");
        b.appendQueryParameter("fps", String.valueOf(fpsCap));
        b.appendQueryParameter("res", renderWidth + "x" + renderHeight);
        b.appendQueryParameter("scale", String.format(Locale.US, "%.2f", resScalePct / 100.0));
        b.appendQueryParameter("shadows", shadowsLevel >= 0 ? "1" : "0");
        b.appendQueryParameter("fixed", "1");
        b.appendQueryParameter("mem32", "1");
        if (engineLowProfile) {
            b.appendQueryParameter("cores", String.valueOf(engineCores));
            b.appendQueryParameter("slots", String.valueOf(gpuSlots));
        }
        if (debugDraws) {
            b.appendQueryParameter("dbg", "1");
        }

        if ("story".equals(launchMode)) {
            b.appendQueryParameter("mode", "story");
        } else if ("sandbox5".equals(launchMode)) {
            b.appendQueryParameter("mode", "sandbox");
        } else if ("sandbox6".equals(launchMode)) {
            b.appendQueryParameter("mode", "sandbox");
            b.appendQueryParameter("map", "env_test");
        }

        // Real GTA V PC SettingsManager.cpp command-line arguments (fixes playgta5.com graphics floor!)
        List<String> args = new ArrayList<>();
        int texQ = graphicsPreset >= PRESET_HIGH ? 2 : (graphicsPreset == PRESET_MEDIUM ? 1 : 0);
        int shaderQ = texQ;
        int reflQ = texQ;
        int partQ = texQ;
        int grassQ = texQ;
        int postFx = texQ;
        int waterQ = graphicsPreset >= PRESET_HIGH ? 1 : 0;
        int aniso = graphicsPreset >= PRESET_HIGH ? 4 : (graphicsPreset == PRESET_MEDIUM ? 2 : 0);

        if (graphicsPreset == PRESET_POTATO) {
            args.add("-useMinimumSettings");
            args.add("-safemode");
            args.add("-ignoreprofile");
        } else if (graphicsPreset <= PRESET_LOW) {
            args.add("-ignoreprofile");
        }

        args.add("-textureQuality=" + texQ);
        args.add("-shaderQuality=" + shaderQ);
        args.add("-shadowQuality=" + shadowsLevel); // -1 disables cascade shadow pass entirely!
        args.add("-shadowSoftness=0");
        args.add("-reflectionQuality=" + reflQ);
        args.add("-waterQuality=" + waterQ);
        args.add("-particleQuality=" + partQ);
        args.add("-grassQuality=" + grassQ);
        args.add("-postFX=" + postFx);
        args.add("-tessellation=0");
        args.add("-anisotropicQualityLevel=" + aniso);
        args.add("-SSAO=" + (graphicsPreset >= PRESET_HIGH ? 1 : 0));
        args.add("-fxaa=" + (graphicsPreset >= PRESET_MEDIUM ? 1 : 0));
        if (graphicsPreset <= PRESET_LOW) {
            args.add("-noInGameDOF");
            args.add("-pedVariety=0");
            args.add("-vehicleVariety=0");
        }

        // Render Distance override: -1 = leave at GTA V engine default, 0..100 = exact LOD/streaming scaling
        if (renderDistance >= 0) {
            float lod = Math.max(0.0f, Math.min(1.0f, renderDistance / 100.0f));
            String lodStr = String.format(Locale.US, "%.2f", lod);
            args.add("-lodScale=" + lodStr);
            args.add("-pedLodBias=" + lodStr);
            args.add("-vehicleLodBias=" + lodStr);
            args.add("-cityDensity=" + lodStr);
        } else if (graphicsPreset <= PRESET_ULTRA_LOW) {
            args.add("-cityDensity=0");
            args.add("-lodScale=0");
            args.add("-pedLodBias=0");
            args.add("-vehicleLodBias=0");
        }

        StringBuilder joined = new StringBuilder();
        for (int i = 0; i < args.size(); i++) {
            if (i > 0) joined.append(',');
            joined.append(args.get(i));
        }
        b.appendQueryParameter("args", joined.toString());
        return b.build().toString();
    }

    public String buildGameUrl(String launchMode) {
        return buildGameUrl("https://playgta5.com/", launchMode);
    }

    public String buildSettingsXmlJson() {
        int texQ = graphicsPreset >= PRESET_HIGH ? 2 : (graphicsPreset == PRESET_MEDIUM ? 1 : 0);
        int waterQ = graphicsPreset >= PRESET_HIGH ? 1 : 0;
        double lod = renderDistance >= 0 ? (renderDistance / 100.0) : (graphicsPreset <= PRESET_ULTRA_LOW ? 0.0 : -1.0);
        return String.format(Locale.US,
                "{\"shadowQuality\":%d,\"textureQuality\":%d,\"shaderQuality\":%d,\"grassQuality\":%d,\"postFx\":%d,\"reflectionQuality\":%d,\"waterQuality\":%d,\"tessellation\":0,\"lodScale\":%.3f}",
                shadowsLevel, texQ, texQ, texQ, texQ, texQ, waterQ, lod);
    }

    public String toConfigJson() {
        return String.format(Locale.US,
                "{\"lowEndMode\":%b,\"graphicsPreset\":%d,\"renderDistance\":%d,\"resScalePct\":%d,\"shadowsLevel\":%d,\"fpsCap\":%d,\"debugDraws\":%b,\"statsEnabled\":%b,\"statsShowFps\":%b,\"statsShowCpuGpu\":%b,\"statsShowRam\":%b,\"renderWidth\":%d,\"renderHeight\":%d,\"settingsXml\":%s}",
                lowEndMode, graphicsPreset, renderDistance, resScalePct, shadowsLevel, fpsCap, debugDraws,
                statsEnabled, statsShowFps, statsShowCpuGpu, statsShowRam,
                renderWidth, renderHeight, buildSettingsXmlJson());
    }

    public String getDeviceSpecSummary() {
        double gb = totalRamMb / 1024.0;
        return String.format(Locale.US, "%.1f GB RAM · %d CORES", gb, cpuCores);
    }

    public String getProfileSummary() {
        String rd = renderDistance < 0 ? "Default" : (renderDistance + "/100");
        String fps = fpsCap == 0 ? "Uncapped" : (fpsCap + " FPS");
        return String.format(Locale.US, "%s · %dp · %s · RD %s",
                PRESET_SHORT[graphicsPreset], renderHeight, fps, rd);
    }

    public String getPs5HomeSubtitle() {
        String rd = renderDistance < 0 ? "Default" : (renderDistance + "/100");
        String sh = shadowsLevel < 0 ? "Shadows OFF" : ("Shadows " + shadowsLevel);
        return String.format(Locale.US, "In-App Landscape WebGPU · %s (%s · %dp) · RD %s",
                PRESET_SHORT[graphicsPreset], sh, renderHeight, rd);
    }

    public float getEstimatedLoadFraction() {
        float base = 0.25f + (graphicsPreset * 0.14f);
        if (renderDistance >= 0) {
            base = (base * 0.72f) + ((renderDistance / 100f) * 0.28f);
        }
        if (lowEndMode) base *= 0.80f;
        return Math.max(0.18f, Math.min(0.95f, base));
    }
}
