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
 * PS5 Mobile v3.0 Engine & Ultra Optimize Configuration:
 * - Ultra Optimize Mode (Balanced 360p / Extreme 270p Survival) engineered to force GTA V
 *   (playgta5.com WebGPU + Emscripten WASM) to boot & run on low-VRAM / low-RAM Android phones.
 * - Real multi-layer cuts: BC texture mip-drop (256px / 128px cap), shrunk WebGPU uniform rings
 *   & buffer arenas, tight Vulkan bind-group eviction, single-thread shader compilation,
 *   capped IO RAM cache, stripped RAGE shadows/postFX/MSAA/aniso, and Skip-PS5-Home Direct Boot.
 * - Hardware RAM / free-RAM / isLowRamDevice auto-detection.
 * - Live FPS / CPU / GPU / RAM / VRAM HUD telemetry toggles.
 */
public final class LaunchConfig {

    private static final String PREFS = "ps5_mobile_prefs";
    private static final String KEY_ULTRA_OPT = "ultra_optimize_mode";
    private static final String KEY_ULTRA_LEVEL = "ultra_optimize_level"; // 1 = Ultra 360p, 2 = Extreme 270p
    private static final String KEY_SKIP_HOME = "skip_ps5_home";
    private static final String KEY_LOW_END = "low_end_mode";
    private static final String KEY_GFX_PRESET = "gfx_preset";
    private static final String KEY_RENDER_DIST = "render_distance"; // -1 = Default, 0..100
    private static final String KEY_RES_SCALE = "res_scale_pct";     // 25..100
    private static final String KEY_SHADOWS = "shadows_level";       // -1=Off, 0=Lowest, 1=Normal, 2=High
    private static final String KEY_FPS_CAP = "fps_cap";             // 30, 60, 0 (uncapped)
    private static final String KEY_DBG_DRAWS = "dbg_draws";
    private static final String KEY_STATS_ON = "stats_enabled";
    private static final String KEY_STATS_FPS = "stats_fps";
    private static final String KEY_STATS_CPUGPU = "stats_cpugpu";
    private static final String KEY_STATS_RAM = "stats_ram";

    public static final int ULTRA_BALANCED = 1; // 360p GBuffer · 256px BC mip-drop · 2 MB ring · 32 MB IO cache
    public static final int ULTRA_EXTREME = 2;  // 270p GBuffer · 128px BC mip-drop · 1 MB ring · 16 MB IO cache · noHints

    public static final int PRESET_POTATO = 0;
    public static final int PRESET_ULTRA_LOW = 1;
    public static final int PRESET_LOW = 2;
    public static final int PRESET_MEDIUM = 3;
    public static final int PRESET_HIGH = 4;

    public static final String[] PRESET_SHORT = {"POTATO", "U-LOW", "LOW", "MED", "HIGH"};
    public static final String[] PRESET_LABELS = {
            "Potato (360p/42% · No Shadows · Min LOD)",
            "Ultra Low (55% · Shadows Off)",
            "Low (72% · Soft Shadows)",
            "Medium (86% · Balanced)",
            "High (100% · PS5 Fidelity)"
    };

    public final boolean ultraOptimize;
    public final int ultraLevel;        // ULTRA_BALANCED (1) or ULTRA_EXTREME (2)
    public final boolean skipPs5Home;

    public final boolean lowEndMode;
    public final int graphicsPreset;
    public final int renderDistance;    // -1 = GTA V engine default, 0..100 custom
    public final int resScalePct;
    public final int shadowsLevel;      // -1, 0, 1, 2
    public final int fpsCap;            // 30, 60, 0
    public final boolean debugDraws;

    public final boolean statsEnabled;
    public final boolean statsShowFps;
    public final boolean statsShowCpuGpu;
    public final boolean statsShowRam;

    public final long totalRamMb;
    public final long availRamMb;
    public final boolean isLowRamDevice;
    public final int cpuCores;
    public final int renderWidth;
    public final int renderHeight;
    public final int engineCores;
    public final int gpuSlots;
    public final int bridgeFlushIntervalMs;

    // Concrete Ultra WebGPU + IO worker parameters
    public final int bcMaxTextureDim;   // 0 = uncapped, 256 = Ultra, 128 = Extreme
    public final int ringChunkMb;       // 8 stock, 4 low-end, 2 Ultra, 1 Extreme
    public final int arenaSizeMb;       // 16 stock, 8 low-end, 4 Ultra/Extreme
    public final int bgCacheLimit;      // 24000 stock, 8192 low-end, 3072 Ultra, 1536 Extreme
    public final int ioMemCacheMb;      // 192 stock, 64 low-end, 32 Ultra, 16 Extreme
    public final int shaderAheadMax;    // 2 stock/low-end, 1 Ultra/Extreme
    public final int shaderFetchesMax;  // 16 stock, 8 low-end, 4 Ultra/Extreme
    public final boolean disableHints;  // Extreme disables background lookahead streaming
    public final boolean disableRoadsterFx;
    public final boolean capAnisotropy;
    public final boolean nearestMipmap;

    private LaunchConfig(
            boolean ultraOptimize, int ultraLevel, boolean skipPs5Home,
            boolean lowEndMode, int graphicsPreset, int renderDistance,
            int resScalePct, int shadowsLevel, int fpsCap, boolean debugDraws,
            boolean statsEnabled, boolean statsShowFps, boolean statsShowCpuGpu, boolean statsShowRam,
            long totalRamMb, long availRamMb, boolean isLowRamDevice, int cpuCores,
            int renderWidth, int renderHeight, int engineCores, int gpuSlots, int bridgeFlushIntervalMs,
            int bcMaxTextureDim, int ringChunkMb, int arenaSizeMb, int bgCacheLimit,
            int ioMemCacheMb, int shaderAheadMax, int shaderFetchesMax,
            boolean disableHints, boolean disableRoadsterFx, boolean capAnisotropy, boolean nearestMipmap) {
        this.ultraOptimize = ultraOptimize;
        this.ultraLevel = ultraLevel;
        this.skipPs5Home = skipPs5Home;
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
        this.availRamMb = availRamMb;
        this.isLowRamDevice = isLowRamDevice;
        this.cpuCores = cpuCores;
        this.renderWidth = renderWidth;
        this.renderHeight = renderHeight;
        this.engineCores = engineCores;
        this.gpuSlots = gpuSlots;
        this.bridgeFlushIntervalMs = bridgeFlushIntervalMs;
        this.bcMaxTextureDim = bcMaxTextureDim;
        this.ringChunkMb = ringChunkMb;
        this.arenaSizeMb = arenaSizeMb;
        this.bgCacheLimit = bgCacheLimit;
        this.ioMemCacheMb = ioMemCacheMb;
        this.shaderAheadMax = shaderAheadMax;
        this.shaderFetchesMax = shaderFetchesMax;
        this.disableHints = disableHints;
        this.disableRoadsterFx = disableRoadsterFx;
        this.capAnisotropy = capAnisotropy;
        this.nearestMipmap = nearestMipmap;
    }

    public static long readTotalRamMb(Context ctx) {
        ActivityManager am = (ActivityManager) ctx.getSystemService(Context.ACTIVITY_SERVICE);
        if (am == null) return 4096L;
        ActivityManager.MemoryInfo mi = new ActivityManager.MemoryInfo();
        am.getMemoryInfo(mi);
        return Math.max(1024L, mi.totalMem / (1024L * 1024L));
    }

    public static long readAvailRamMb(Context ctx) {
        ActivityManager am = (ActivityManager) ctx.getSystemService(Context.ACTIVITY_SERVICE);
        if (am == null) return 1536L;
        ActivityManager.MemoryInfo mi = new ActivityManager.MemoryInfo();
        am.getMemoryInfo(mi);
        return Math.max(256L, mi.availMem / (1024L * 1024L));
    }

    public static boolean readIsLowRamDevice(Context ctx) {
        ActivityManager am = (ActivityManager) ctx.getSystemService(Context.ACTIVITY_SERVICE);
        return am != null && am.isLowRamDevice();
    }

    public static int readCpuCores() {
        return Math.max(2, Runtime.getRuntime().availableProcessors());
    }

    public static int defaultScaleForPreset(int preset) {
        switch (preset) {
            case PRESET_POTATO: return 42;
            case PRESET_ULTRA_LOW: return 55;
            case PRESET_LOW: return 72;
            case PRESET_MEDIUM: return 86;
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

    public static void saveUltraOptimize(Context ctx, boolean enabled, int level) {
        int clampedLevel = (level >= ULTRA_EXTREME) ? ULTRA_EXTREME : ULTRA_BALANCED;
        SharedPreferences.Editor ed = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit();
        ed.putBoolean(KEY_ULTRA_OPT, enabled);
        ed.putInt(KEY_ULTRA_LEVEL, clampedLevel);
        if (enabled) {
            ed.putBoolean(KEY_LOW_END, true);
            ed.putInt(KEY_GFX_PRESET, PRESET_POTATO);
            ed.putInt(KEY_RES_SCALE, clampedLevel == ULTRA_EXTREME ? 35 : 42);
            ed.putInt(KEY_SHADOWS, -1);
            ed.putInt(KEY_FPS_CAP, 30);
            ed.putInt(KEY_RENDER_DIST, clampedLevel == ULTRA_EXTREME ? 10 : 18);
        }
        ed.apply();
    }

    public static void activateEmergencyUltraExtreme(Context ctx) {
        SharedPreferences.Editor ed = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit();
        ed.putBoolean(KEY_ULTRA_OPT, true);
        ed.putInt(KEY_ULTRA_LEVEL, ULTRA_EXTREME);
        ed.putBoolean(KEY_LOW_END, true);
        ed.putInt(KEY_GFX_PRESET, PRESET_POTATO);
        ed.putInt(KEY_RES_SCALE, 35);
        ed.putInt(KEY_SHADOWS, -1);
        ed.putInt(KEY_FPS_CAP, 30);
        ed.putInt(KEY_RENDER_DIST, 10);
        ed.apply();
    }

    public static void saveSkipPs5Home(Context ctx, boolean skip) {
        ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE)
                .edit().putBoolean(KEY_SKIP_HOME, skip).apply();
    }

    public static void saveLowEndMode(Context ctx, boolean lowEnd) {
        SharedPreferences.Editor ed = ctx.getSharedPreferences(PREFS, Context.MODE_PRIVATE).edit();
        ed.putBoolean(KEY_LOW_END, lowEnd);
        if (!lowEnd) {
            ed.putBoolean(KEY_ULTRA_OPT, false);
        }
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
        } else {
            ed.putBoolean(KEY_ULTRA_OPT, false);
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
                .putInt(KEY_RES_SCALE, Math.max(25, Math.min(100, resScalePct)))
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
        if (obj.has("ultraOptimize")) ed.putBoolean(KEY_ULTRA_OPT, obj.optBoolean("ultraOptimize"));
        if (obj.has("ultraLevel")) ed.putInt(KEY_ULTRA_LEVEL, Math.max(1, Math.min(2, obj.optInt("ultraLevel", 1))));
        if (obj.has("skipPs5Home")) ed.putBoolean(KEY_SKIP_HOME, obj.optBoolean("skipPs5Home"));
        if (obj.has("lowEndMode")) ed.putBoolean(KEY_LOW_END, obj.optBoolean("lowEndMode"));
        if (obj.has("graphicsPreset")) ed.putInt(KEY_GFX_PRESET, Math.max(0, Math.min(4, obj.optInt("graphicsPreset"))));
        if (obj.has("renderDistance")) {
            int rd = obj.optInt("renderDistance", -1);
            ed.putInt(KEY_RENDER_DIST, rd < 0 ? -1 : Math.max(0, Math.min(100, rd)));
        }
        if (obj.has("resScalePct")) ed.putInt(KEY_RES_SCALE, Math.max(25, Math.min(100, obj.optInt("resScalePct", 72))));
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
        long availMb = readAvailRamMb(ctx);
        boolean isLowRamDev = readIsLowRamDevice(ctx);
        int cores = readCpuCores();

        // Auto-enable Ultra Optimize Mode on first launch for low-RAM / low-VRAM Android devices (<= 4.5 GB or low-RAM flag)
        boolean autoUltra = isLowRamDev || ramMb <= 4608L || availMb < 1400L;
        boolean ultraOpt = sp.contains(KEY_ULTRA_OPT) ? sp.getBoolean(KEY_ULTRA_OPT, autoUltra) : autoUltra;
        int defaultUltraLvl = (isLowRamDev || ramMb <= 3300L) ? ULTRA_EXTREME : ULTRA_BALANCED;
        int ultraLvl = Math.max(ULTRA_BALANCED, Math.min(ULTRA_EXTREME, sp.getInt(KEY_ULTRA_LEVEL, defaultUltraLvl)));
        boolean skipHome = sp.getBoolean(KEY_SKIP_HOME, false);

        boolean lowEnd = ultraOpt || (sp.contains(KEY_LOW_END) ? sp.getBoolean(KEY_LOW_END, false) : (ramMb <= 6400L));
        int preset = ultraOpt ? PRESET_POTATO : sp.getInt(KEY_GFX_PRESET, lowEnd ? PRESET_ULTRA_LOW : PRESET_LOW);
        int defaultRd = ultraOpt ? (ultraLvl == ULTRA_EXTREME ? 10 : 18) : -1;
        int renderDist = sp.contains(KEY_RENDER_DIST) ? sp.getInt(KEY_RENDER_DIST, defaultRd) : defaultRd;
        int scalePct = sp.getInt(KEY_RES_SCALE, ultraOpt ? (ultraLvl == ULTRA_EXTREME ? 35 : 42) : defaultScaleForPreset(preset));
        int shadows = ultraOpt ? -1 : sp.getInt(KEY_SHADOWS, defaultShadowsForPreset(preset));
        int fpsCap = ultraOpt ? 30 : sp.getInt(KEY_FPS_CAP, lowEnd ? 30 : 60);
        boolean dbgDraws = sp.getBoolean(KEY_DBG_DRAWS, false);

        boolean statsOn = sp.getBoolean(KEY_STATS_ON, true);
        boolean statsFps = sp.getBoolean(KEY_STATS_FPS, true);
        boolean statsCpuGpu = sp.getBoolean(KEY_STATS_CPUGPU, true);
        boolean statsRam = sp.getBoolean(KEY_STATS_RAM, true);

        DisplayMetrics dm = ctx.getResources().getDisplayMetrics();
        int longSide = Math.max(dm.widthPixels, dm.heightPixels);
        int shortSide = Math.max(1, Math.min(dm.widthPixels, dm.heightPixels));
        float aspect = Math.max(1.5f, Math.min(2.25f, (float) longSide / (float) shortSide));

        int targetH;
        if (ultraOpt) {
            // Ultra Optimize locks deferred GBuffer height low to cut ~12 screen-sized render targets by 4x–7x!
            int ultraCeiling = (ultraLvl == ULTRA_EXTREME) ? 270 : 360;
            int scaled = Math.round((720f * (scalePct / 100f)) / 2f) * 2;
            targetH = Math.max(240, Math.min(ultraCeiling, scaled));
        } else {
            int baseH = lowEnd ? 720 : (ramMb >= 7500L ? 810 : 720);
            targetH = Math.max(300, Math.round((baseH * (scalePct / 100f)) / 2f) * 2);
        }
        int targetW = Math.max(360, Math.round((targetH * aspect) / 2f) * 2);

        int engineCores = (ultraOpt || lowEnd || preset <= PRESET_ULTRA_LOW) ? 2 : Math.min(cores, 4);
        int gpuSlots = (ultraOpt || lowEnd || preset <= PRESET_ULTRA_LOW) ? 2 : 3;
        int flushMs = (ultraOpt || lowEnd || fpsCap == 30) ? 33 : 16;

        // Concrete Ultra WebGPU & IO memory budgets
        int bcMaxDim;
        int ringMb;
        int arenaMb;
        int bgLimit;
        int ioMemMb;
        int aheadMax;
        int shaderFetch;
        boolean noHints;
        boolean noRoadster;
        boolean capAniso;
        boolean nearMip;

        if (ultraOpt && ultraLvl == ULTRA_EXTREME) {
            bcMaxDim = 128;
            ringMb = 1;
            arenaMb = 4;
            bgLimit = 1536;
            ioMemMb = 16;
            aheadMax = 1;
            shaderFetch = 4;
            noHints = true;
            noRoadster = true;
            capAniso = true;
            nearMip = true;
        } else if (ultraOpt) {
            bcMaxDim = 256;
            ringMb = 2;
            arenaMb = 4;
            bgLimit = 3072;
            ioMemMb = 32;
            aheadMax = 1;
            shaderFetch = 4;
            noHints = false;
            noRoadster = true;
            capAniso = true;
            nearMip = false;
        } else if (lowEnd) {
            bcMaxDim = 512;
            ringMb = 4;
            arenaMb = 8;
            bgLimit = 8192;
            ioMemMb = 64;
            aheadMax = 2;
            shaderFetch = 8;
            noHints = false;
            noRoadster = false;
            capAniso = true;
            nearMip = false;
        } else {
            bcMaxDim = 0;
            ringMb = 8;
            arenaMb = 16;
            bgLimit = 24000;
            ioMemMb = 192;
            aheadMax = 2;
            shaderFetch = 16;
            noHints = false;
            noRoadster = false;
            capAniso = false;
            nearMip = false;
        }

        return new LaunchConfig(
                ultraOpt, ultraLvl, skipHome,
                lowEnd, preset, renderDist, scalePct, shadows, fpsCap, dbgDraws,
                statsOn, statsFps, statsCpuGpu, statsRam,
                ramMb, availMb, isLowRamDev, cores, targetW, targetH, engineCores, gpuSlots, flushMs,
                bcMaxDim, ringMb, arenaMb, bgLimit, ioMemMb, aheadMax, shaderFetch,
                noHints, noRoadster, capAniso, nearMip
        );
    }

    /**
     * Builds the tuned runtime URL for https://playgta5.com/ with clean, verified RAGE engine
     * arguments and Ultra Optimize query flags.
     */
    public String buildGameUrl(String baseOrigin, String launchMode) {
        String root = (baseOrigin == null || baseOrigin.isEmpty()) ? "https://playgta5.com/" : baseOrigin;
        if (!root.endsWith("/")) root = root + "/";

        boolean engineLowProfile = ultraOptimize || lowEndMode || graphicsPreset <= PRESET_LOW;
        Uri.Builder b = Uri.parse(root).buildUpon();

        b.appendQueryParameter("low", engineLowProfile ? "1" : "0");
        b.appendQueryParameter("fps", String.valueOf(fpsCap));
        b.appendQueryParameter("res", renderWidth + "x" + renderHeight);
        b.appendQueryParameter("scale", String.format(Locale.US, "%.2f", resScalePct / 100.0));
        b.appendQueryParameter("shadows", shadowsLevel >= 0 ? "1" : "0");
        b.appendQueryParameter("fixed", "1");
        if (ultraOptimize) {
            b.appendQueryParameter("ultra", String.valueOf(ultraLevel));
        }
        if (disableHints) {
            b.appendQueryParameter("nohints", "1");
        }
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

        // Clean, verified RAGE SettingsManager.cpp CLI flags
        List<String> args = new ArrayList<>();
        if (engineLowProfile) {
            // playgta5.com already prepends verified LOW_ARGS when ?low=1:
            // (-textureQuality=0, -pedVariety=0, -vehicleVariety=0, -shadowQuality=-1,
            //  -reflectionQuality=0, -particleQuality=0, -grassQuality=0, -cityDensity=0,
            //  -lodScale=0, -pedLodBias=0, -vehicleLodBias=0).
            if (ultraOptimize) {
                args.add("-shaderQuality=0");
                args.add("-postFX=0");
                args.add("-waterQuality=0");
                args.add("-tessellation=0");
                args.add("-anisotropicQualityLevel=0");
            }
            if (shadowsLevel >= 0) {
                args.add("-shadowQuality=" + shadowsLevel);
            }
            if (renderDistance >= 0) {
                float lod = Math.max(0.0f, Math.min(1.0f, renderDistance / 100.0f));
                String lodStr = String.format(Locale.US, "%.2f", lod);
                args.add("-lodScale=" + lodStr);
                args.add("-pedLodBias=" + lodStr);
                args.add("-vehicleLodBias=" + lodStr);
                args.add("-cityDensity=" + lodStr);
            }
        } else {
            int texQ = graphicsPreset >= PRESET_HIGH ? 2 : 1;
            args.add("-textureQuality=" + texQ);
            args.add("-shaderQuality=" + texQ);
            args.add("-shadowQuality=" + shadowsLevel);
            args.add("-reflectionQuality=" + texQ);
            args.add("-particleQuality=" + texQ);
            args.add("-grassQuality=" + texQ);
            args.add("-postFX=" + texQ);
            if (renderDistance >= 0) {
                float lod = Math.max(0.0f, Math.min(1.0f, renderDistance / 100.0f));
                String lodStr = String.format(Locale.US, "%.2f", lod);
                args.add("-lodScale=" + lodStr);
                args.add("-pedLodBias=" + lodStr);
                args.add("-vehicleLodBias=" + lodStr);
                args.add("-cityDensity=" + lodStr);
            }
        }

        if (!args.isEmpty()) {
            StringBuilder joined = new StringBuilder();
            for (int i = 0; i < args.size(); i++) {
                if (i > 0) joined.append(',');
                joined.append(args.get(i));
            }
            b.appendQueryParameter("args", joined.toString());
        }
        return b.build().toString();
    }

    public String buildGameUrl(String launchMode) {
        return buildGameUrl("https://playgta5.com/", launchMode);
    }

    /**
     * Serializes concrete Ultra Optimize WebGPU + IO worker budgets to inject directly
     * into intercepted wgpu_worker.js & io_worker.js.
     */
    public String toUltraWorkerConfigJson() {
        return String.format(Locale.US,
                "{\"enabled\":%b,\"level\":%d,\"maxTex\":%d,\"ringMb\":%d,\"arenaMb\":%d,\"bgLimit\":%d,"
                        + "\"ioMemMb\":%d,\"aheadMax\":%d,\"shaderFetches\":%d,\"noHints\":%b,"
                        + "\"noRoadster\":%b,\"capAniso\":%b,\"nearMip\":%b,\"lowEnd\":%b}",
                ultraOptimize, ultraLevel, bcMaxTextureDim, ringChunkMb, arenaSizeMb, bgCacheLimit,
                ioMemCacheMb, shaderAheadMax, shaderFetchesMax, disableHints,
                disableRoadsterFx, capAnisotropy, nearestMipmap, lowEndMode);
    }

    public String buildSettingsXmlJson() {
        int texQ = ultraOptimize ? 0 : (graphicsPreset >= PRESET_HIGH ? 2 : (graphicsPreset == PRESET_MEDIUM ? 1 : 0));
        int waterQ = (!ultraOptimize && graphicsPreset >= PRESET_HIGH) ? 1 : 0;
        double lod = renderDistance >= 0 ? (renderDistance / 100.0) : ((ultraOptimize || graphicsPreset <= PRESET_ULTRA_LOW) ? 0.0 : -1.0);
        double popDens = ultraOptimize ? (ultraLevel == ULTRA_EXTREME ? 0.0 : 0.10) : (lowEndMode ? 0.25 : 0.50);
        double popVar = ultraOptimize ? 0.0 : (lowEndMode ? 0.20 : 0.50);
        return String.format(Locale.US,
                "{\"ultra\":%b,\"shadowQuality\":%d,\"textureQuality\":%d,\"shaderQuality\":%d,"
                        + "\"grassQuality\":%d,\"postFx\":%d,\"reflectionQuality\":%d,\"waterQuality\":%d,"
                        + "\"particleQuality\":%d,\"tessellation\":0,\"msaa\":0,\"fxaa\":0,\"txaa\":0,"
                        + "\"ssao\":0,\"aniso\":0,\"softShadows\":0,\"particleShadows\":false,"
                        + "\"popDensity\":%.3f,\"popVariety\":%.3f,\"lodScale\":%.3f}",
                ultraOptimize, shadowsLevel, texQ, texQ, texQ, texQ, texQ, waterQ,
                ultraOptimize ? 0 : texQ, popDens, popVar, lod);
    }

    public String toConfigJson() {
        return String.format(Locale.US,
                "{\"ultraOptimize\":%b,\"ultraLevel\":%d,\"skipPs5Home\":%b,\"lowEndMode\":%b,"
                        + "\"graphicsPreset\":%d,\"renderDistance\":%d,\"resScalePct\":%d,\"shadowsLevel\":%d,"
                        + "\"fpsCap\":%d,\"debugDraws\":%b,\"statsEnabled\":%b,\"statsShowFps\":%b,"
                        + "\"statsShowCpuGpu\":%b,\"statsShowRam\":%b,\"renderWidth\":%d,\"renderHeight\":%d,\"settingsXml\":%s}",
                ultraOptimize, ultraLevel, skipPs5Home, lowEndMode, graphicsPreset, renderDistance,
                resScalePct, shadowsLevel, fpsCap, debugDraws, statsEnabled, statsShowFps,
                statsShowCpuGpu, statsShowRam, renderWidth, renderHeight, buildSettingsXmlJson());
    }

    public boolean isLowRamHardware() {
        return isLowRamDevice || totalRamMb <= 4608L;
    }

    public String getUltraBadgeLabel() {
        if (!ultraOptimize) return "OFF";
        return ultraLevel == ULTRA_EXTREME ? "EXTREME 270p" : "ULTRA 360p";
    }

    public String getDeviceSpecSummary() {
        double gb = totalRamMb / 1024.0;
        double freeGb = availRamMb / 1024.0;
        String tier = isLowRamHardware() ? " · LOW-RAM" : (totalRamMb <= 6400L ? " · MID" : "");
        return String.format(Locale.US, "%.1fG RAM (%.1fG FREE) · %d CORES%s", gb, freeGb, cpuCores, tier);
    }

    public String getUltraSavingsSummary() {
        if (!ultraOptimize) {
            if (lowEndMode) return "LOW-END · 512px MIPS · 4MB RING · 64MB IO CACHE";
            return "STANDARD · FULL TEXTURES · 8MB RING · 16MB ARENAS";
        }
        if (ultraLevel == ULTRA_EXTREME) {
            return "EXTREME 2GB+ · 128px MIPS (-88% VRAM) · 1MB RING · 16MB IO · 270p";
        }
        return "ULTRA 4GB+ · 256px MIPS (-75% VRAM) · 2MB RING · 32MB IO · 360p";
    }

    public String getProfileSummary() {
        String rd = renderDistance < 0 ? "Default" : (renderDistance + "/100");
        String fps = fpsCap == 0 ? "Uncapped" : (fpsCap + " FPS");
        String tag = ultraOptimize ? (ultraLevel == ULTRA_EXTREME ? "EXTREME" : "ULTRA") : PRESET_SHORT[graphicsPreset];
        return String.format(Locale.US, "%s · %dx%d · %s · RD %s",
                tag, renderWidth, renderHeight, fps, rd);
    }

    public String getPs5HomeSubtitle() {
        String rd = renderDistance < 0 ? "Default" : (renderDistance + "/100");
        if (ultraOptimize) {
            String lvl = ultraLevel == ULTRA_EXTREME ? "EXTREME 270p · 128px MIPS" : "ULTRA 360p · 256px MIPS";
            return String.format(Locale.US, "⚡ ULTRA OPTIMIZE (%s · %dMB Ring · RD %s)", lvl, ringChunkMb, rd);
        }
        String sh = shadowsLevel < 0 ? "Shadows OFF" : ("Shadows " + shadowsLevel);
        return String.format(Locale.US, "In-App Landscape WebGPU · %s (%s · %dp) · RD %s",
                PRESET_SHORT[graphicsPreset], sh, renderHeight, rd);
    }

    public float getEstimatedLoadFraction() {
        if (ultraOptimize) {
            return ultraLevel == ULTRA_EXTREME ? 0.14f : 0.22f;
        }
        float base = 0.30f + (graphicsPreset * 0.14f);
        if (renderDistance >= 0) {
            base = (base * 0.72f) + ((renderDistance / 100f) * 0.28f);
        }
        if (lowEndMode) base *= 0.78f;
        return Math.max(0.18f, Math.min(0.95f, base));
    }
}
