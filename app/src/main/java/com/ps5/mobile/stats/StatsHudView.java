package com.ps5.mobile.stats;

import android.content.Context;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.view.Gravity;
import android.view.View;
import android.widget.LinearLayout;
import android.widget.TextView;

import java.util.Locale;

/**
 * Compact, translucent floating telemetry HUD displaying live FPS, CPU/GPU, and RAM statistics.
 * Fully non-interactive so it never intercepts gameplay or controller touches.
 */
public final class StatsHudView extends LinearLayout {

    private final TextView tvFps;
    private final TextView tvCpuGpu;
    private final TextView tvVram;
    private final TextView tvRam;

    private boolean masterEnabled = true;
    private boolean showFps = true;
    private boolean showCpuGpu = true;
    private boolean showRam = true;

    public StatsHudView(Context context) {
        super(context);
        setOrientation(HORIZONTAL);
        setGravity(Gravity.CENTER_VERTICAL);
        setClickable(false);
        setFocusable(false);
        setFocusableInTouchMode(false);

        GradientDrawable bg = new GradientDrawable();
        bg.setColor(0xBC060C1C);
        bg.setCornerRadius(dp(12));
        bg.setStroke(dp(1), 0x4860A5FA);
        setBackground(bg);
        setPadding(dp(10), dp(4), dp(10), dp(4));

        tvFps = makeMetric(context, 0xFF34D399, "FPS --");
        tvCpuGpu = makeMetric(context, 0xFF60A5FA, "CPU --%");
        tvVram = makeMetric(context, 0xFF2DD4BF, "");
        tvVram.setVisibility(View.GONE);
        tvRam = makeMetric(context, 0xFFFBBF24, "RAM --");

        addView(tvFps);
        addView(tvCpuGpu);
        addView(tvVram);
        addView(tvRam);
    }

    private TextView makeMetric(Context ctx, int color, String init) {
        TextView tv = new TextView(ctx);
        tv.setText(init);
        tv.setTextColor(color);
        tv.setTextSize(10.5f);
        tv.setTypeface(Typeface.MONOSPACE, Typeface.BOLD);
        tv.setPadding(dp(5), 0, dp(5), 0);
        tv.setFocusable(false);
        return tv;
    }

    public void applyVisibility(boolean enabled, boolean fps, boolean cpuGpu, boolean ram) {
        this.masterEnabled = enabled;
        this.showFps = fps;
        this.showCpuGpu = cpuGpu;
        this.showRam = ram;
        boolean any = enabled && (fps || cpuGpu || ram);
        setVisibility(any ? View.VISIBLE : View.GONE);
        tvFps.setVisibility(fps ? View.VISIBLE : View.GONE);
        tvCpuGpu.setVisibility(cpuGpu ? View.VISIBLE : View.GONE);
        if (!ram && !cpuGpu) tvVram.setVisibility(View.GONE);
        tvRam.setVisibility(ram ? View.VISIBLE : View.GONE);
    }

    public void update(StatsMonitor.Snapshot s) {
        if (!masterEnabled || s == null) return;

        if (showFps) {
            tvFps.setText(s.fps > 0 ? (s.fps + " FPS") : "-- FPS");
            if (s.fps >= 45) tvFps.setTextColor(0xFF34D399);
            else if (s.fps >= 25) tvFps.setTextColor(0xFFFBBF24);
            else tvFps.setTextColor(s.fps == 0 ? 0xFF94A3B8 : 0xFFFB7185);
        }

        if (showCpuGpu) {
            StringBuilder sb = new StringBuilder();
            sb.append("CPU ").append(s.cpuPct).append('%');
            if (s.cpuMhz > 0) sb.append('(').append(String.format(Locale.US, "%.1fG", s.cpuMhz / 1000f)).append(')');
            if (s.gpuDirect) {
                sb.append(" · GPU ").append(s.gpuPct).append('%');
            }
            tvCpuGpu.setText(sb.toString());
        }

        if ((showRam || showCpuGpu) && s.vramTexMb >= 0) {
            int totalVram = s.vramTexMb + s.vramBufMb;
            tvVram.setVisibility(View.VISIBLE);
            if (s.vramSavedMb > 0) {
                tvVram.setText(String.format(Locale.US, "VRAM %dM (-%dM)", totalVram, s.vramSavedMb));
                tvVram.setTextColor(0xFF34D399);
            } else {
                tvVram.setText(String.format(Locale.US, "VRAM %dM", totalVram));
                tvVram.setTextColor(totalVram > 420 ? 0xFFFB7185 : 0xFF2DD4BF);
            }
        } else {
            tvVram.setVisibility(View.GONE);
        }

        if (showRam) {
            double usedGb = s.usedRamMb / 1024.0;
            double totalGb = Math.max(1.0, s.totalRamMb / 1024.0);
            if (s.appPssMb > 0) {
                tvRam.setText(String.format(Locale.US, "RAM %.1f/%.1fG (%dM)", usedGb, totalGb, s.appPssMb));
            } else {
                tvRam.setText(String.format(Locale.US, "RAM %.1f/%.1fG", usedGb, totalGb));
            }
            double ratio = usedGb / totalGb;
            tvRam.setTextColor(ratio > 0.85 ? 0xFFFB7185 : (ratio > 0.72 ? 0xFFFBBF24 : 0xFFE2E8F0));
        }
    }

    private int dp(int v) {
        return Math.round(v * getResources().getDisplayMetrics().density);
    }
}
