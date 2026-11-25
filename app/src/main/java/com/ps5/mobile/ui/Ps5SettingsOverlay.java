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
 * In-emulator PS5 System Settings modal accessible from both the PS5 Home Screen
 * and during GTA V gameplay. Hosts toggles for the Hardware Statistics Viewer
 * (FPS, CPU/GPU, RAM) plus Graphics Quality & Render Distance controls.
 */
public final class Ps5SettingsOverlay extends FrameLayout {

    public interface Callback {
        void onStatsSettingsChanged(boolean enabled, boolean fps, boolean cpuGpu, boolean ram);
        void onGraphicsSettingsChanged(boolean reloadGameIfRunning);
        void onClosed();
    }

    private final Callback callback;
    private boolean inGameMode = false;

    private boolean statsEnabled, statsFps, statsCpuGpu, statsRam;
    private int gfxPreset;
    private int renderDistance;
    private boolean lowEnd;

    private PremiumToggleSwitch swStatsAll, swStatsFps, swStatsCpuGpu, swStatsRam, swLowEnd;
    private final TextView[] presetChips = new TextView[5];
    private SeekBar seekRd;
    private TextView tvRdVal;
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
        cardBg.setStroke(dp(1), 0x6660A5FA);
        card.setBackground(cardBg);
        card.setPadding(dp(18), dp(14), dp(18), dp(14));

        // Header
        LinearLayout header = new LinearLayout(context);
        header.setOrientation(LinearLayout.HORIZONTAL);
        header.setGravity(Gravity.CENTER_VERTICAL);
        TextView title = new TextView(context);
        title.setText("PS5 SYSTEM SETTINGS");
        title.setTextColor(Color.WHITE);
        title.setTextSize(15f);
        title.setTypeface(Typeface.SANS_SERIF, Typeface.BOLD);
        header.addView(title, new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f));

        TextView closeBtn = makeActionChip(context, "✕ CLOSE", 0xFF334155, this::hide);
        header.addView(closeBtn);
        card.addView(header);

        ScrollView scroll = new ScrollView(context);
        LinearLayout body = new LinearLayout(context);
        body.setOrientation(LinearLayout.VERTICAL);
        body.setPadding(0, dp(10), 0, dp(4));

        // SECTION 1: Performance Statistics Viewer
        body.addView(makeSectionLabel(context, "HARDWARE STATISTICS OVERLAY"));

        swStatsAll = new PremiumToggleSwitch(context);
        swStatsFps = new PremiumToggleSwitch(context);
        swStatsCpuGpu = new PremiumToggleSwitch(context);
        swStatsRam = new PremiumToggleSwitch(context);

        body.addView(makeToggleRow(context, "Show Statistics Viewer", "Live floating telemetry HUD on screen", swStatsAll, on -> {
            statsEnabled = on;
            persistAndNotifyStats();
        }));
        body.addView(makeToggleRow(context, "FPS Counter", "Real-time frame rate from PS5 UI & WebGPU", swStatsFps, on -> {
            statsFps = on;
            persistAndNotifyStats();
        }));
        body.addView(makeToggleRow(context, "CPU / GPU Usage", "Live processor load, clock MHz & GPU sensor", swStatsCpuGpu, on -> {
            statsCpuGpu = on;
            persistAndNotifyStats();
        }));
        body.addView(makeToggleRow(context, "RAM Statistics", "System memory used/total GB & app PSS MB", swStatsRam, on -> {
            statsRam = on;
            persistAndNotifyStats();
        }));

        // SECTION 2: Graphics & Render Distance
        body.addView(makeSectionLabel(context, "GRAPHICS & RENDER DISTANCE"));

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
                if (idx <= LaunchConfig.PRESET_ULTRA_LOW) {
                    lowEnd = true;
                    swLowEnd.setChecked(true, true);
                }
                LaunchConfig.saveGraphicsPreset(getContext(), gfxPreset);
                refreshPresetChips();
                if (callback != null) callback.onGraphicsSettingsChanged(false);
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
            LaunchConfig.saveLowEndMode(getContext(), on);
            LaunchConfig updated = LaunchConfig.load(getContext());
            gfxPreset = updated.graphicsPreset;
            refreshPresetChips();
            if (callback != null) callback.onGraphicsSettingsChanged(false);
        }));

        // Bottom apply/reload row
        btnApplyReload = makeActionChip(context, "APPLY GRAPHICS & RELOAD GAME", 0xFF0070D1, () -> {
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

        LayoutParams cardLp = new LayoutParams(dp(470), dp(310), Gravity.CENTER);
        addView(card, cardLp);
    }

    public void show(boolean inGame) {
        this.inGameMode = inGame;
        LaunchConfig cfg = LaunchConfig.load(getContext());
        statsEnabled = cfg.statsEnabled;
        statsFps = cfg.statsShowFps;
        statsCpuGpu = cfg.statsShowCpuGpu;
        statsRam = cfg.statsShowRam;
        gfxPreset = cfg.graphicsPreset;
        renderDistance = cfg.renderDistance;
        lowEnd = cfg.lowEndMode;

        swStatsAll.setChecked(statsEnabled, false);
        swStatsFps.setChecked(statsFps, false);
        swStatsCpuGpu.setChecked(statsCpuGpu, false);
        swStatsRam.setChecked(statsRam, false);
        swLowEnd.setChecked(lowEnd, false);

        refreshPresetChips();
        refreshRdUi();
        btnApplyReload.setVisibility(inGameMode ? View.VISIBLE : View.GONE);
        setVisibility(View.VISIBLE);
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
            bg.setColor(sel ? 0xE60070D1 : 0x66162244);
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

    private TextView makeSectionLabel(Context ctx, String text) {
        TextView tv = new TextView(ctx);
        tv.setText(text);
        tv.setTextColor(0xFF60A5FA);
        tv.setTextSize(10.5f);
        tv.setTypeface(Typeface.SANS_SERIF, Typeface.BOLD);
        tv.setPadding(0, dp(8), 0, dp(6));
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
        t.setTextSize(12.5f);
        t.setTypeface(Typeface.SANS_SERIF, Typeface.BOLD);
        textCol.addView(t);

        TextView s = new TextView(ctx);
        s.setText(sub);
        s.setTextColor(0xFF94A3B8);
        s.setTextSize(10.5f);
        textCol.addView(s);

        row.addView(textCol, new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f));
        sw.setOnCheckedChangeListener(listener);
        row.addView(sw, new LinearLayout.LayoutParams(dp(52), dp(28)));
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
