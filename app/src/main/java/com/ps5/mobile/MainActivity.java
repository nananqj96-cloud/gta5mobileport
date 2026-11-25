package com.ps5.mobile;

import android.animation.ObjectAnimator;
import android.animation.ValueAnimator;
import android.app.Activity;
import android.app.AlertDialog;
import android.content.Intent;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.os.Bundle;
import android.text.InputType;
import android.view.Gravity;
import android.view.HapticFeedbackConstants;
import android.view.View;
import android.view.animation.LinearInterpolator;
import android.widget.EditText;
import android.widget.ImageView;
import android.widget.LinearLayout;
import android.widget.SeekBar;
import android.widget.TextView;

import com.ps5.mobile.config.LaunchConfig;
import com.ps5.mobile.ui.PremiumToggleSwitch;
import com.ps5.mobile.ui.ResourceLoadBarView;

/**
 * PS5 Android Pre-Boot Launcher:
 * - Sleek PlayStation 5 midnight-cobalt aesthetic
 * - Small discreet Info (i) button at top-right transparently explaining the underlying GTA V WebGPU runtime
 * - Low-End Phone Mode toggle + Resource Load bar
 * - Graphics Quality override selector (Potato -> High, fixing playgta5.com's lower-graphics floor)
 * - Numeric Render Distance setting (Default = GTA 5 emu default, or 0..100 custom)
 * - Hero LAUNCH PS5 button
 */
public final class MainActivity extends Activity {

    private ImageView bgArt;
    private View lowEndCard;
    private View btnLaunch;
    private TextView btnInfo;
    private TextView tvDeviceSpecs;
    private TextView tvModeBadge;
    private TextView tvLowEndDesc;
    private TextView tvProfileMeta;
    private TextView tvGraphicsHint;
    private TextView tvRenderDistDesc;
    private TextView btnRenderDistNum;
    private TextView btnRenderDistReset;
    private SeekBar seekRenderDist;
    private LinearLayout graphicsPresetRow;
    private PremiumToggleSwitch toggleLowEnd;
    private ResourceLoadBarView loadBar;

    private final TextView[] presetButtons = new TextView[5];
    private ObjectAnimator bgScaleX, bgScaleY;
    private LaunchConfig currentConfig;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        setContentView(R.layout.activity_main);

        bgArt = findViewById(R.id.bgArt);
        lowEndCard = findViewById(R.id.lowEndCard);
        btnLaunch = findViewById(R.id.btnLaunch);
        btnInfo = findViewById(R.id.btnInfo);
        tvDeviceSpecs = findViewById(R.id.tvDeviceSpecs);
        tvModeBadge = findViewById(R.id.tvModeBadge);
        tvLowEndDesc = findViewById(R.id.tvLowEndDesc);
        tvProfileMeta = findViewById(R.id.tvProfileMeta);
        tvGraphicsHint = findViewById(R.id.tvGraphicsHint);
        tvRenderDistDesc = findViewById(R.id.tvRenderDistDesc);
        btnRenderDistNum = findViewById(R.id.btnRenderDistNum);
        btnRenderDistReset = findViewById(R.id.btnRenderDistReset);
        seekRenderDist = findViewById(R.id.seekRenderDist);
        graphicsPresetRow = findViewById(R.id.graphicsPresetRow);
        toggleLowEnd = findViewById(R.id.toggleLowEnd);
        loadBar = findViewById(R.id.loadBar);

        buildGraphicsPresetPills();

        // Small discreet Info button (i) on the very start of the app
        btnInfo.setOnClickListener(v -> {
            v.performHapticFeedback(HapticFeedbackConstants.VIRTUAL_KEY);
            showRuntimeInfoDialog();
        });

        // Low-End Phone Mode Toggle
        toggleLowEnd.setOnCheckedChangeListener(checked -> {
            LaunchConfig.saveLowEndMode(this, checked);
            refreshFromConfig(true);
        });
        lowEndCard.setOnClickListener(v -> toggleLowEnd.toggle());

        // Render Distance Slider + Numeric Input + Default Reset
        seekRenderDist.setOnSeekBarChangeListener(new SeekBar.OnSeekBarChangeListener() {
            @Override
            public void onProgressChanged(SeekBar seekBar, int progress, boolean fromUser) {
                if (!fromUser) return;
                LaunchConfig.saveRenderDistance(MainActivity.this, progress);
                refreshFromConfig(false);
            }
            @Override public void onStartTrackingTouch(SeekBar seekBar) {}
            @Override public void onStopTrackingTouch(SeekBar seekBar) {}
        });

        btnRenderDistNum.setOnClickListener(v -> {
            v.performHapticFeedback(HapticFeedbackConstants.VIRTUAL_KEY);
            showRenderDistanceInputDialog();
        });

        btnRenderDistReset.setOnClickListener(v -> {
            v.performHapticFeedback(HapticFeedbackConstants.VIRTUAL_KEY);
            LaunchConfig.saveRenderDistance(this, -1);
            refreshFromConfig(true);
        });

        // Hero LAUNCH PS5 Button
        btnLaunch.setOnClickListener(v -> {
            v.performHapticFeedback(HapticFeedbackConstants.VIRTUAL_KEY);
            v.animate().scaleX(0.96f).scaleY(0.96f).setDuration(80).withEndAction(() -> {
                v.animate().scaleX(1f).scaleY(1f).setDuration(100).start();
                startActivity(new Intent(this, GameActivity.class));
            }).start();
        });

        refreshFromConfig(false);
    }

    @Override
    protected void onResume() {
        super.onResume();
        refreshFromConfig(false);
    }

    @Override
    protected void onPause() {
        super.onPause();
        stopBgAnimation();
    }

    private void buildGraphicsPresetPills() {
        graphicsPresetRow.removeAllViews();
        float d = getResources().getDisplayMetrics().density;
        for (int i = 0; i < 5; i++) {
            final int idx = i;
            TextView tv = new TextView(this);
            tv.setText(LaunchConfig.PRESET_SHORT[i]);
            tv.setTextSize(10.5f);
            tv.setTypeface(Typeface.SANS_SERIF, Typeface.BOLD);
            tv.setGravity(Gravity.CENTER);
            tv.setPadding(Math.round(4 * d), Math.round(7 * d), Math.round(4 * d), Math.round(7 * d));
            LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f);
            lp.leftMargin = i == 0 ? 0 : Math.round(5 * d);
            tv.setLayoutParams(lp);
            tv.setOnClickListener(v -> {
                v.performHapticFeedback(HapticFeedbackConstants.VIRTUAL_KEY);
                LaunchConfig.saveGraphicsPreset(this, idx);
                refreshFromConfig(true);
            });
            presetButtons[i] = tv;
            graphicsPresetRow.addView(tv);
        }
    }

    private void refreshFromConfig(boolean animate) {
        currentConfig = LaunchConfig.load(this);
        tvDeviceSpecs.setText(currentConfig.getDeviceSpecSummary());

        toggleLowEnd.setChecked(currentConfig.lowEndMode, animate);
        lowEndCard.setBackgroundResource(currentConfig.lowEndMode
                ? R.drawable.bg_toggle_card_active
                : R.drawable.bg_toggle_card);

        if (currentConfig.lowEndMode) {
            tvModeBadge.setText("LOW-END ON");
            tvModeBadge.setBackgroundResource(R.drawable.bg_badge_low);
            tvModeBadge.setTextColor(0xFF34D399);
            tvLowEndDesc.setText(R.string.low_end_desc_on);
        } else {
            tvModeBadge.setText("STANDARD");
            tvModeBadge.setBackgroundResource(R.drawable.bg_badge_std);
            tvModeBadge.setTextColor(0xFF38BDF8);
            tvLowEndDesc.setText(R.string.low_end_desc_off);
        }

        tvProfileMeta.setText(currentConfig.getProfileSummary());
        loadBar.setLoad(currentConfig.getEstimatedLoadFraction(), currentConfig.lowEndMode, animate);

        // Graphics tier highlights
        float d = getResources().getDisplayMetrics().density;
        for (int i = 0; i < presetButtons.length; i++) {
            boolean sel = (i == currentConfig.graphicsPreset);
            GradientDrawable bg = new GradientDrawable();
            bg.setColor(sel ? 0xE60070D1 : 0x55122040);
            bg.setCornerRadius(10 * d);
            bg.setStroke(Math.round(1 * d), sel ? Color.WHITE : 0x4493C5FD);
            presetButtons[i].setBackground(bg);
            presetButtons[i].setTextColor(sel ? Color.WHITE : 0xFFB8C7E0);
        }
        tvGraphicsHint.setText(LaunchConfig.PRESET_LABELS[currentConfig.graphicsPreset]);

        // Render Distance display
        if (currentConfig.renderDistance < 0) {
            btnRenderDistNum.setText("DEFAULT");
            tvRenderDistDesc.setText("Default (GTA 5 Emu Default) · Lower = less loads nearby");
            seekRenderDist.setProgress(50);
            btnRenderDistReset.setAlpha(0.45f);
        } else {
            btnRenderDistNum.setText(currentConfig.renderDistance + " / 100");
            String zone = currentConfig.renderDistance <= 20
                    ? "Ultra-Near · Minimal nearby streaming"
                    : (currentConfig.renderDistance <= 55
                    ? "Reduced · Fewer distant objects load"
                    : "Extended · Wider world LOD streaming");
            tvRenderDistDesc.setText(zone + " (LOD " + String.format("%.2f", currentConfig.renderDistance / 100f) + ")");
            seekRenderDist.setProgress(currentConfig.renderDistance);
            btnRenderDistReset.setAlpha(1.0f);
        }

        if (currentConfig.lowEndMode) {
            stopBgAnimation();
            bgArt.setScaleX(1.0f);
            bgArt.setScaleY(1.0f);
        } else {
            startBgAnimation();
        }
    }

    private void showRenderDistanceInputDialog() {
        final EditText et = new EditText(this);
        et.setInputType(InputType.TYPE_CLASS_NUMBER);
        et.setHint("0 to 100 (leave empty for Default)");
        if (currentConfig != null && currentConfig.renderDistance >= 0) {
            et.setText(String.valueOf(currentConfig.renderDistance));
            et.setSelection(et.getText().length());
        }
        int pad = Math.round(20 * getResources().getDisplayMetrics().density);
        LinearLayout box = new LinearLayout(this);
        box.setPadding(pad, pad / 2, pad, 0);
        box.addView(et, new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT));

        new AlertDialog.Builder(this, android.R.style.Theme_Material_Dialog_Alert)
                .setTitle("Render Distance (0 – 100)")
                .setMessage("Lower numbers stream fewer distant objects, peds & vehicles nearby. Leave blank for GTA 5 engine Default.")
                .setView(box)
                .setPositiveButton("Apply", (d, w) -> {
                    String s = et.getText().toString().trim();
                    if (s.isEmpty()) {
                        LaunchConfig.saveRenderDistance(this, -1);
                    } else {
                        try {
                            LaunchConfig.saveRenderDistance(this, Integer.parseInt(s));
                        } catch (NumberFormatException ignored) {}
                    }
                    refreshFromConfig(true);
                })
                .setNeutralButton("Reset Default", (d, w) -> {
                    LaunchConfig.saveRenderDistance(this, -1);
                    refreshFromConfig(true);
                })
                .setNegativeButton("Cancel", null)
                .show();
    }

    private void showRuntimeInfoDialog() {
        new AlertDialog.Builder(this, android.R.style.Theme_Material_Dialog_Alert)
                .setTitle("System Information")
                .setMessage(
                        "PS5 Mobile Shell v2.1\n\n"
                                + "Under the hood, this app is NOT a native PS5 hypervisor — it wraps a PlayStation 5 Home UI shell around the live playgta5.com Grand Theft Auto V WebGPU + 64-bit WebAssembly runtime.\n\n"
                                + "• Chrome 64-bit COOP/COEP Bridge: Android System WebView blocks crossOriginIsolated and lacks 3 GB WASM heap, so Play Game starts an embedded localhost COOP/COEP proxy and launches GTA V in Chrome Custom Tab with full WebGPU, SharedArrayBuffer & injected PS5 controls.\n"
                                + "• PS5 Home UI: Controller-only navigation (use the on-screen DualSense D-Pad & ✕ / ○ buttons; direct screen tapping is disabled on PS5 Home).\n"
                                + "• Lower Graphics Fix: Passes real RAGE engine flags (-shadowQuality=-1, -textureQuality=0, -lodScale, ?scale) below GTA V's pause-menu floor.\n"
                                + "• Render Distance: Scales -lodScale, -pedLodBias, -vehicleLodBias, and -cityDensity.\n"
                                + "• Hardware Stats: Live FPS, CPU/GPU usage & RAM — togglable from PS5 Settings.\n"
                                + "• Floating [D] Button: Opens the GTA V Developer Trainer (vehicles, guns, fly, cheats & graphics)."
                )
                .setPositiveButton("Got It", null)
                .show();
    }

    private void startBgAnimation() {
        if (bgScaleX != null && bgScaleX.isRunning()) return;
        bgScaleX = ObjectAnimator.ofFloat(bgArt, "scaleX", 1.0f, 1.06f);
        bgScaleX.setDuration(14000);
        bgScaleX.setRepeatCount(ValueAnimator.INFINITE);
        bgScaleX.setRepeatMode(ValueAnimator.REVERSE);
        bgScaleX.setInterpolator(new LinearInterpolator());

        bgScaleY = ObjectAnimator.ofFloat(bgArt, "scaleY", 1.0f, 1.06f);
        bgScaleY.setDuration(14000);
        bgScaleY.setRepeatCount(ValueAnimator.INFINITE);
        bgScaleY.setRepeatMode(ValueAnimator.REVERSE);
        bgScaleY.setInterpolator(new LinearInterpolator());

        bgScaleX.start();
        bgScaleY.start();
    }

    private void stopBgAnimation() {
        if (bgScaleX != null) bgScaleX.cancel();
        if (bgScaleY != null) bgScaleY.cancel();
    }
}
