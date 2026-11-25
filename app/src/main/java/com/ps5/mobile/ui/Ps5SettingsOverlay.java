package com.ps5.mobile.ui;

import android.content.Context;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.view.Gravity;
import android.view.HapticFeedbackConstants;
import android.view.View;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.SeekBar;
import android.widget.TextView;

import com.ps5.mobile.config.LaunchConfig;

/**
 * In-emulator PS5 System Settings modal (v3.0 Ultra Optimize Edition):
 * - Ultra Optimize Mode (ULTRA 360p / EXTREME 270p) + live VRAM savings readout + 1-tap RAM/VRAM Flush
 * - Skip PS5 Home (Direct Boot) toggle
 * - Hardware Statistics Viewer (FPS, CPU/GPU, VRAM, RAM)
 * - Graphics Quality & Render Distance controls
 */
public final class Ps5SettingsOverlay extends FrameLayout {

    public interface Callback {
        void onStatsSettingsChanged(boolean enabled, boolean fps, boolean cpuGpu, boolean ram);
        void onGraphicsSettingsChanged(boolean reloadGameIfRunning);
        void onTriggerMemoryTrim();
        void onClosed();
    }

    private final Callback callback;
    private boolean inGameMode = false;

    private boolean ultraOpt, skipHome, lowEnd;
    private int ultraLevel;
    private boolean statsEnabled, statsFps, statsCpuGpu, statsRam;
    private int gfxPreset;
    private int renderDistance;

    private PremiumToggleSwitch swUltra, swSkipHome, swStatsAll, swStatsFps, swStatsCpuGpu, swStatsRam, swLowEnd;
    private TextView chipUltra360, chipExtreme270, tvUltraSavings;
    private final TextView[] presetChips = new TextView[5];
    private SeekBar seekRd;
    private TextView tvRdVal;
    private TextView btnFlushRam;
    private TextView btnApplyReload;

    public Ps5SettingsOverlay(Context context, Callback callback) {
        super(context);
        this.callback = callback;
        setVisibility(View.GONE);
        setBackgroundColor(0xC2030714);
        setClickable(true);
        setOnClickListener(v -> hide());

        LinearLayout card = new LinearLayout(context);
        card.setOrientation(LinearLayout.VERTICAL);
        card.setClickable(true);
        GradientDrawable cardBg = new GradientDrawable();
        cardBg.setColor(0xF50B142C);
        cardBg.setCornerRadius(dp(20));
        cardBg.setStroke(dp(1), 0x6634D399);
        card.setBackground(cardBg);
        card.setPadding(dp(18), dp(14), dp(18), dp(14));

        // Header
        LinearLayout header = new LinearLayout(context);
        header.setOrientation(LinearLayout.HORIZONTAL);
        header.setGravity(Gravity.CENTER_VERTICAL);
        TextView title = new TextView(context);
        title.setText("PS5 SYSTEM SETTINGS · v3.0");
        title.setTextColor(Color.WHITE);
        title.setTextSize(14.5f);
        title.setTypeface(Typeface.SANS_SERIF, Typeface.BOLD);
        header.addView(title, new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f));

        TextView closeBtn = makeActionChip(context, "✕ CLOSE", 0xFF334155, this::hide);
        header.addView(closeBtn);
        card.addView(header);

        ScrollView scroll = new ScrollView(context);
        LinearLayout body = new LinearLayout(context);
        body.setOrientation(LinearLayout.VERTICAL);
        body.setPadding(0, dp(8), 0, dp(4));

        // SECTION 1: ULTRA OPTIMIZE ENGINE (LOW-VRAM / LOW-RAM FORCE RUNNER)
        body.addView(makeSectionLabel(context, "⚡ ULTRA OPTIMIZE MODE (LOW-RAM / LOW-VRAM)", 0xFF34D399));

        swUltra = new PremiumToggleSwitch(context);
        body.addView(makeToggleRow(context, "Ultra Optimize Engine", "BC texture mip-drop · shrunk rings/arenas · tight IO RAM cap", swUltra, on -> {
            ultraOpt = on;
            LaunchConfig.saveUltraOptimize(getContext(), ultraOpt, ultraLevel);
            syncFromSavedConfig(false);
        }));

        LinearLayout tierRow = new LinearLayout(context);
        tierRow.setOrientation(LinearLayout.HORIZONTAL);
        LinearLayout.LayoutParams tlp = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        tlp.bottomMargin = dp(6);
        tierRow.setLayoutParams(tlp);

        chipUltra360 = makeTierChip(context, "⚡ ULTRA 360p (4GB)", () -> {
            ultraOpt = true;
            ultraLevel = LaunchConfig.ULTRA_BALANCED;
            LaunchConfig.saveUltraOptimize(getContext(), true, LaunchConfig.ULTRA_BALANCED);
            syncFromSavedConfig(false);
        });
        chipExtreme270 = makeTierChip(context, "🔥 EXTREME 270p (2-3GB)", () -> {
            ultraOpt = true;
            ultraLevel = LaunchConfig.ULTRA_EXTREME;
            LaunchConfig.saveUltraOptimize(getContext(), true, LaunchConfig.ULTRA_EXTREME);
            syncFromSavedConfig(false);
        });
        LinearLayout.LayoutParams c1 = new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f);
        LinearLayout.LayoutParams c2 = new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f);
        c2.leftMargin = dp(6);
        tierRow.addView(chipUltra360, c1);
        tierRow.addView(chipExtreme270, c2);
        body.addView(tierRow);

        tvUltraSavings = new TextView(context);
        tvUltraSavings.setTextColor(0xFF6EE7B7);
        tvUltraSavings.setTextSize(10f);
        tvUltraSavings.setTypeface(Typeface.MONOSPACE);
        tvUltraSavings.setPadding(dp(4), 0, dp(4), dp(8));
        body.addView(tvUltraSavings);

        swSkipHome = new PremiumToggleSwitch(context);
        body.addView(makeToggleRow(context, "Skip PS5 Home (Direct Boot)", "Boots straight into GTA V WebView · saves ~150MB RAM", swSkipHome, on -> {
            skipHome = on;
            LaunchConfig.saveSkipPs5Home(getContext(), on);
            if (callback != null) callback.onGraphicsSettingsChanged(false);
        }));

        btnFlushRam = makeActionChip(context, "⚡ FLUSH GPU & IO RAM CACHES NOW (LIVE)", 0xFF047857, () -> {
            if (callback != null) callback.onTriggerMemoryTrim();
        });
        btnFlushRam.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams flp = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, dp(36));
        flp.bottomMargin = dp(8);
        body.addView(btnFlushRam, flp);

        // SECTION 2: Performance Statistics Viewer
        body.addView(makeSectionLabel(context, "HARDWARE STATISTICS OVERLAY", 0xFF60A5FA));

        swStatsAll = new PremiumToggleSwitch(context);
        swStatsFps = new PremiumToggleSwitch(context);
        swStatsCpuGpu = new PremiumToggleSwitch(context);
        swStatsRam = new PremiumToggleSwitch(context);

        body.addView(makeToggleRow(context, "Show Statistics Viewer", "Live floating FPS / CPU / VRAM / RAM HUD", swStatsAll, on -> {
            statsEnabled = on;
            persistAndNotifyStats();
        }));
        body.addView(makeToggleRow(context, "FPS Counter", "Real-time frame rate from PS5 UI & WebGPU", swStatsFps, on -> {
            statsFps = on;
            persistAndNotifyStats();
        }));
        body.addView(makeToggleRow(context, "CPU / GPU / VRAM Usage", "Live processor load, GPU sensor & VRAM saved", swStatsCpuGpu, on -> {
            statsCpuGpu = on;
            persistAndNotifyStats();
        }));
        body.addView(makeToggleRow(context, "RAM Statistics", "System memory used/total GB & app PSS MB", swStatsRam, on -> {
            statsRam = on;
            persistAndNotifyStats();
        }));

        // SECTION 3: Graphics & Render Distance
        body.addView(makeSectionLabel(context, "GRAPHICS & RENDER DISTANCE", 0xFF60A5FA));

        LinearLayout presetRow = new LinearLayout(context);
        presetRow.setOrientation(LinearLayout.HORIZONTAL);
        for (int i = 0; i < 5; i++) {
            final int idx = i;
            TextView chip = new TextView(context);
            chip.setText(LaunchConfig.PRESET_SHORT[i]);
            chip.setTextSize(10.5f);
            chip.setTypeface(Typeface.SANS_SERIF, Typeface.BOLD);
            chip.setGravity(Gravity.CENTER);
            chip.setPadding(dp(6), dp(8), dp(6), dp(8));
            LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f);
            lp.leftMargin = i == 0 ? 0 : dp(5);
            chip.setLayoutParams(lp);
            chip.setOnClickListener(v -> {
                v.performHapticFeedback(HapticFeedbackConstants.VIRTUAL_KEY);
                gfxPreset = idx;
                if (idx > LaunchConfig.PRESET_POTATO && ultraOpt) {
                    ultraOpt = false;
                    LaunchConfig.saveUltraOptimize(getContext(), false, ultraLevel);
                }
                LaunchConfig.saveGraphicsPreset(getContext(), gfxPreset);
                syncFromSavedConfig(false);
            });
            presetChips[i] = chip;
            presetRow.addView(chip);
        }
        body.addView(presetRow);

        // Render Distance slider
        LinearLayout rdRow = new LinearLayout(context);
        rdRow.setOrientation(LinearLayout.HORIZONTAL);
        rdRow.setGravity(Gravity.CENTER_VERTICAL);
        rdRow.setPadding(0, dp(10), 0, dp(2));

        TextView rdLabel = new TextView(context);
        rdLabel.setText("Render Distance (Lower = less loads nearby)");
        rdLabel.setTextColor(0xFFCBD5E1);
        rdLabel.setTextSize(11.5f);
        rdRow.addView(rdLabel, new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f));

        tvRdVal = new TextView(context);
        tvRdVal.setTextColor(0xFF38BDF8);
        tvRdVal.setTextSize(11.5f);
        tvRdVal.setTypeface(Typeface.MONOSPACE, Typeface.BOLD);
        rdRow.addView(tvRdVal);

        TextView btnResetRd = makeActionChip(context, "DEFAULT", 0xFF1E3A8A, () -> {
            renderDistance = -1;
            LaunchConfig.saveRenderDistance(getContext(), -1);
            refreshRdUi();
            if (callback != null) callback.onGraphicsSettingsChanged(false);
        });
        LinearLayout.LayoutParams rlp = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        rlp.leftMargin = dp(8);
        rdRow.addView(btnResetRd, rlp);
        body.addView(rdRow);

        seekRd = new SeekBar(context);
        seekRd.setMax(100);
        seekRd.setOnSeekBarChangeListener(new SeekBar.OnSeekBarChangeListener() {
            @Override
            public void onProgressChanged(SeekBar sb, int progress, boolean fromUser) {
                if (!fromUser) return;
                renderDistance = progress;
                LaunchConfig.saveRenderDistance(getContext(), renderDistance);
                refreshRdUi();
                if (callback != null) callback.onGraphicsSettingsChanged(false);
            }
            @Override public void onStartTrackingTouch(SeekBar sb) {}
            @Override public void onStopTrackingTouch(SeekBar sb) {}
        });
        body.addView(seekRd);

        swLowEnd = new PremiumToggleSwitch(context);
        body.addView(makeToggleRow(context, "Low-End Phone Mode", "30 FPS cap · 2 cores · shadows off · reduced RAM", swLowEnd, on -> {
            lowEnd = on;
            if (!on && ultraOpt) {
                ultraOpt = false;
                LaunchConfig.saveUltraOptimize(getContext(), false, ultraLevel);
            }
            LaunchConfig.saveLowEndMode(getContext(), on);
            syncFromSavedConfig(false);
        }));

        // Bottom apply/reload row
        btnApplyReload = makeActionChip(context, "APPLY SETTINGS & RELOAD GAME", 0xFF0070D1, () -> {
            hide();
            if (callback != null) callback.onGraphicsSettingsChanged(true);
        });
        btnApplyReload.setGravity(Gravity.CENTER);
        LinearLayout.LayoutParams alp = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, dp(40));
        alp.topMargin = dp(10);
        body.addView(btnApplyReload, alp);

        scroll.addView(body);
        card.addView(scroll, new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f));

        LayoutParams cardLp = new LayoutParams(dp(490), dp(325), Gravity.CENTER);
        addView(card, cardLp);
    }

    public void show(boolean inGame) {
        this.inGameMode = inGame;
        syncFromSavedConfig(false);
        btnFlushRam.setVisibility(inGameMode ? View.VISIBLE : View.GONE);
        btnApplyReload.setVisibility(inGameMode ? View.VISIBLE : View.GONE);
        setVisibility(View.VISIBLE);
    }

    private void syncFromSavedConfig(boolean reload) {
        LaunchConfig cfg = LaunchConfig.load(getContext());
        ultraOpt = cfg.ultraOptimize;
        ultraLevel = cfg.ultraLevel;
        skipHome = cfg.skipPs5Home;
        statsEnabled = cfg.statsEnabled;
        statsFps = cfg.statsShowFps;
        statsCpuGpu = cfg.statsShowCpuGpu;
        statsRam = cfg.statsShowRam;
        gfxPreset = cfg.graphicsPreset;
        renderDistance = cfg.renderDistance;
        lowEnd = cfg.lowEndMode;

        swUltra.setChecked(ultraOpt, false);
        swSkipHome.setChecked(skipHome, false);
        swStatsAll.setChecked(statsEnabled, false);
        swStatsFps.setChecked(statsFps, false);
        swStatsCpuGpu.setChecked(statsCpuGpu, false);
        swStatsRam.setChecked(statsRam, false);
        swLowEnd.setChecked(lowEnd, false);

        refreshUltraUi(cfg);
        refreshPresetChips();
        refreshRdUi();
        if (callback != null) callback.onGraphicsSettingsChanged(reload);
    }

    private void refreshUltraUi(LaunchConfig cfg) {
        boolean extreme = ultraOpt && ultraLevel == LaunchConfig.ULTRA_EXTREME;
        styleTierChip(chipUltra360, ultraOpt && !extreme, 0xFF059669, 0xFF34D399);
        styleTierChip(chipExtreme270, extreme, 0xFFD97706, 0xFFFBBF24);
        tvUltraSavings.setText(cfg.getUltraSavingsSummary());
        tvUltraSavings.setTextColor(ultraOpt ? (extreme ? 0xFFFDE68A : 0xFF6EE7B7) : 0xFF94A3B8);
    }

    private void styleTierChip(TextView tv, boolean active, int fill, int stroke) {
        GradientDrawable bg = new GradientDrawable();
        bg.setColor(active ? (0xE0000000 | (fill & 0x00FFFFFF)) : 0x55122038);
        bg.setCornerRadius(dp(10));
        bg.setStroke(dp(1), active ? stroke : 0x4493C5FD);
        tv.setBackground(bg);
        tv.setTextColor(active ? Color.WHITE : 0xFFCBD5E1);
    }

    public void hide() {
        if (getVisibility() == View.VISIBLE) {
            setVisibility(View.GONE);
            if (callback != null) callback.onClosed();
        }
    }

    public boolean isShowing() {
        return getVisibility() == View.VISIBLE;
    }

    private void persistAndNotifyStats() {
        LaunchConfig.saveStatsPrefs(getContext(), statsEnabled, statsFps, statsCpuGpu, statsRam);
        if (callback != null) {
            callback.onStatsSettingsChanged(statsEnabled, statsFps, statsCpuGpu, statsRam);
        }
    }

    private void refreshPresetChips() {
        for (int i = 0; i < presetChips.length; i++) {
            boolean sel = (i == gfxPreset);
            GradientDrawable bg = new GradientDrawable();
            bg.setColor(sel ? (ultraOpt ? 0xE6059669 : 0xE60070D1) : 0x66162244);
            bg.setCornerRadius(dp(10));
            bg.setStroke(dp(1), sel ? Color.WHITE : 0x4493C5FD);
            presetChips[i].setBackground(bg);
            presetChips[i].setTextColor(sel ? Color.WHITE : 0xFFCBD5E1);
        }
    }

    private void refreshRdUi() {
        if (renderDistance < 0) {
            tvRdVal.setText("DEFAULT");
            seekRd.setProgress(50);
        } else {
            tvRdVal.setText(renderDistance + " / 100");
            seekRd.setProgress(renderDistance);
        }
    }

    private TextView makeSectionLabel(Context ctx, String text, int color) {
        TextView tv = new TextView(ctx);
        tv.setText(text);
        tv.setTextColor(color);
        tv.setTextSize(10.5f);
        tv.setTypeface(Typeface.SANS_SERIF, Typeface.BOLD);
        tv.setPadding(0, dp(8), 0, dp(6));
        return tv;
    }

    private TextView makeTierChip(Context ctx, String text, Runnable onClick) {
        TextView tv = new TextView(ctx);
        tv.setText(text);
        tv.setTextSize(10.5f);
        tv.setTypeface(Typeface.SANS_SERIF, Typeface.BOLD);
        tv.setGravity(Gravity.CENTER);
        tv.setPadding(dp(8), dp(8), dp(8), dp(8));
        tv.setOnClickListener(v -> {
            v.performHapticFeedback(HapticFeedbackConstants.VIRTUAL_KEY);
            onClick.run();
        });
        return tv;
    }

    private LinearLayout makeToggleRow(Context ctx, String title, String sub,
                                       PremiumToggleSwitch sw,
                                       PremiumToggleSwitch.OnCheckedChangeListener listener) {
        LinearLayout row = new LinearLayout(ctx);
        row.setOrientation(LinearLayout.HORIZONTAL);
        row.setGravity(Gravity.CENTER_VERTICAL);
        row.setPadding(dp(8), dp(6), dp(8), dp(6));
        GradientDrawable bg = new GradientDrawable();
        bg.setColor(0x45121E3D);
        bg.setCornerRadius(dp(12));
        row.setBackground(bg);
        LinearLayout.LayoutParams rlp = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        rlp.bottomMargin = dp(6);
        row.setLayoutParams(rlp);

        LinearLayout textCol = new LinearLayout(ctx);
        textCol.setOrientation(LinearLayout.VERTICAL);
        TextView t = new TextView(ctx);
        t.setText(title);
        t.setTextColor(Color.WHITE);
        t.setTextSize(12f);
        t.setTypeface(Typeface.SANS_SERIF, Typeface.BOLD);
        textCol.addView(t);

        TextView s = new TextView(ctx);
        s.setText(sub);
        s.setTextColor(0xFF94A3B8);
        s.setTextSize(10f);
        textCol.addView(s);

        row.addView(textCol, new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f));
        sw.setOnCheckedChangeListener(listener);
        row.addView(sw, new LinearLayout.LayoutParams(dp(50), dp(27)));
        row.setOnClickListener(v -> sw.toggle());
        return row;
    }

    private TextView makeActionChip(Context ctx, String label, int bgCol, Runnable onClick) {
        TextView tv = new TextView(ctx);
        tv.setText(label);
        tv.setTextColor(Color.WHITE);
        tv.setTextSize(10.5f);
        tv.setTypeface(Typeface.SANS_SERIF, Typeface.BOLD);
        tv.setPadding(dp(12), dp(6), dp(12), dp(6));
        GradientDrawable bg = new GradientDrawable();
        bg.setColor(bgCol);
        bg.setCornerRadius(dp(14));
        bg.setStroke(dp(1), 0x66FFFFFF);
        tv.setBackground(bg);
        tv.setOnClickListener(v -> {
            v.performHapticFeedback(HapticFeedbackConstants.VIRTUAL_KEY);
            if (onClick != null) onClick.run();
        });
        return tv;
    }

    private int dp(int v) {
        return Math.round(v * getResources().getDisplayMetrics().density);
    }
}
