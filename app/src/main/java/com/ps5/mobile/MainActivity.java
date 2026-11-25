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
 * PS5 Mobile v3.0 Ultra Optimize Pre-Boot Launcher:
 * - Auto-detects Android total/free RAM and activates Ultra Optimize Mode on low-RAM/low-VRAM devices.
 * - Hero Ultra Optimize Mode Card with 2-tier selector (ULTRA 360p / EXTREME 270p) and live VRAM savings readout.
 * - Skip PS5 Home (Direct Boot) toggle + dedicated 1-tap Direct Boot CTA saving ~150MB RAM on startup.
 * - Low-End Cap, Graphics Quality Override, and Render Distance controls.
 */
public final class MainActivity extends Activity {

    private ImageView bgArt;
    private View statusDot;
    private View ultraCard;
    private View ultraTierRow;
    private View skipHomeCard;
    private View lowEndCard;
    private View btnLaunch;
    private View btnDirectBoot;
    private TextView btnInfo;
    private TextView tvDeviceSpecs;
    private TextView tvUltraBadge;
    private TextView tvUltraDesc;
    private TextView tvUltraSavings;
    private TextView btnUltraBalanced;
    private TextView btnUltraExtreme;
    private TextView tvModeBadge;
    private TextView tvProfileMeta;
    private TextView tvGraphicsHint;
    private TextView tvRenderDistDesc;
    private TextView btnRenderDistNum;
    private TextView btnRenderDistReset;
    private TextView tvLaunchTitle;
    private TextView tvLaunchSub;
    private SeekBar seekRenderDist;
    private LinearLayout graphicsPresetRow;
    private PremiumToggleSwitch toggleUltra;
    private PremiumToggleSwitch toggleSkipHome;
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
        statusDot = findViewById(R.id.statusDot);
        ultraCard = findViewById(R.id.ultraCard);
        ultraTierRow = findViewById(R.id.ultraTierRow);
        skipHomeCard = findViewById(R.id.skipHomeCard);
        lowEndCard = findViewById(R.id.lowEndCard);
        btnLaunch = findViewById(R.id.btnLaunch);
        btnDirectBoot = findViewById(R.id.btnDirectBoot);
        btnInfo = findViewById(R.id.btnInfo);
        tvDeviceSpecs = findViewById(R.id.tvDeviceSpecs);
        tvUltraBadge = findViewById(R.id.tvUltraBadge);
        tvUltraDesc = findViewById(R.id.tvUltraDesc);
        tvUltraSavings = findViewById(R.id.tvUltraSavings);
        btnUltraBalanced = findViewById(R.id.btnUltraBalanced);
        btnUltraExtreme = findViewById(R.id.btnUltraExtreme);
        tvModeBadge = findViewById(R.id.tvModeBadge);
        tvProfileMeta = findViewById(R.id.tvProfileMeta);
        tvGraphicsHint = findViewById(R.id.tvGraphicsHint);
        tvRenderDistDesc = findViewById(R.id.tvRenderDistDesc);
        btnRenderDistNum = findViewById(R.id.btnRenderDistNum);
        btnRenderDistReset = findViewById(R.id.btnRenderDistReset);
        tvLaunchTitle = findViewById(R.id.tvLaunchTitle);
        tvLaunchSub = findViewById(R.id.tvLaunchSub);
        seekRenderDist = findViewById(R.id.seekRenderDist);
        graphicsPresetRow = findViewById(R.id.graphicsPresetRow);
        toggleUltra = findViewById(R.id.toggleUltra);
        toggleSkipHome = findViewById(R.id.toggleSkipHome);
        toggleLowEnd = findViewById(R.id.toggleLowEnd);
        loadBar = findViewById(R.id.loadBar);

        buildGraphicsPresetPills();

        btnInfo.setOnClickListener(v -> {
            v.performHapticFeedback(HapticFeedbackConstants.VIRTUAL_KEY);
            showRuntimeInfoDialog();
        });

        // 1. Ultra Optimize Mode Master Toggle + Tier Selector
        toggleUltra.setOnCheckedChangeListener(checked -> {
            int lvl = currentConfig != null ? currentConfig.ultraLevel : LaunchConfig.ULTRA_BALANCED;
            LaunchConfig.saveUltraOptimize(this, checked, lvl);
            refreshFromConfig(true);
        });
        ultraCard.setOnClickListener(v -> toggleUltra.toggle());

        btnUltraBalanced.setOnClickListener(v -> {
            v.performHapticFeedback(HapticFeedbackConstants.VIRTUAL_KEY);
            LaunchConfig.saveUltraOptimize(this, true, LaunchConfig.ULTRA_BALANCED);
            refreshFromConfig(true);
        });

        btnUltraExtreme.setOnClickListener(v -> {
            v.performHapticFeedback(HapticFeedbackConstants.VIRTUAL_KEY);
            LaunchConfig.saveUltraOptimize(this, true, LaunchConfig.ULTRA_EXTREME);
            refreshFromConfig(true);
        });

        // 2. Skip PS5 Home (Direct Boot) Toggle
        toggleSkipHome.setOnCheckedChangeListener(checked -> {
            LaunchConfig.saveSkipPs5Home(this, checked);
            refreshFromConfig(true);
        });
        skipHomeCard.setOnClickListener(v -> toggleSkipHome.toggle());

        // 3. Low-End Mode Toggle
        toggleLowEnd.setOnCheckedChangeListener(checked -> {
            if (!checked && currentConfig != null && currentConfig.ultraOptimize) {
                LaunchConfig.saveUltraOptimize(this, false, currentConfig.ultraLevel);
            }
            LaunchConfig.saveLowEndMode(this, checked);
            refreshFromConfig(true);
        });
        lowEndCard.setOnClickListener(v -> toggleLowEnd.toggle());

        // 4. Render Distance Slider + Numeric Input + Default Reset
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

        // 5. Primary Launch Button
        btnLaunch.setOnClickListener(v -> {
            v.performHapticFeedback(HapticFeedbackConstants.VIRTUAL_KEY);
            v.animate().scaleX(0.96f).scaleY(0.96f).setDuration(80).withEndAction(() -> {
                v.animate().scaleX(1f).scaleY(1f).setDuration(100).start();
                Intent i = new Intent(this, GameActivity.class);
                i.putExtra(GameActivity.EXTRA_DIRECT_LAUNCH, currentConfig != null && currentConfig.skipPs5Home);
                startActivity(i);
            }).start();
        });

        // 6. Instant 1-Tap Direct Boot GTA V (Always Skips PS5 Home for Lowest RAM)
        btnDirectBoot.setOnClickListener(v -> {
            v.performHapticFeedback(HapticFeedbackConstants.VIRTUAL_KEY);
            v.animate().scaleX(0.96f).scaleY(0.96f).setDuration(80).withEndAction(() -> {
                v.animate().scaleX(1f).scaleY(1f).setDuration(100).start();
                Intent i = new Intent(this, GameActivity.class);
                i.putExtra(GameActivity.EXTRA_DIRECT_LAUNCH, true);
                startActivity(i);
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
            tv.setTextSize(10f);
            tv.setTypeface(Typeface.SANS_SERIF, Typeface.BOLD);
            tv.setGravity(Gravity.CENTER);
            tv.setPadding(Math.round(4 * d), Math.round(7 * d), Math.round(4 * d), Math.round(7 * d));
            LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f);
            lp.leftMargin = i == 0 ? 0 : Math.round(5 * d);
            tv.setLayoutParams(lp);
            tv.setOnClickListener(v -> {
                v.performHapticFeedback(HapticFeedbackConstants.VIRTUAL_KEY);
                if (idx > LaunchConfig.PRESET_POTATO && currentConfig != null && currentConfig.ultraOptimize) {
                    LaunchConfig.saveUltraOptimize(this, false, currentConfig.ultraLevel);
                }
                LaunchConfig.saveGraphicsPreset(this, idx);
                refreshFromConfig(true);
            });
            presetButtons[i] = tv;
            graphicsPresetRow.addView(tv);
        }
    }

    private void refreshFromConfig(boolean animate) {
        currentConfig = LaunchConfig.load(this);
        float d = getResources().getDisplayMetrics().density;

        tvDeviceSpecs.setText(currentConfig.getDeviceSpecSummary());
        statusDot.setBackgroundColor(currentConfig.isLowRamHardware() ? 0xFFF59E0B : 0xFF34D399);

        // Ultra Optimize Hero Card state
        boolean ultraOn = currentConfig.ultraOptimize;
        boolean extreme = ultraOn && currentConfig.ultraLevel == LaunchConfig.ULTRA_EXTREME;
        toggleUltra.setChecked(ultraOn, animate);
        ultraCard.setBackgroundResource(ultraOn ? R.drawable.bg_ultra_card_active : R.drawable.bg_ultra_card);
        ultraTierRow.setAlpha(ultraOn ? 1.0f : 0.55f);

        if (extreme) {
            tvUltraBadge.setText("EXTREME 270p");
            tvUltraBadge.setBackgroundResource(R.drawable.bg_badge_ultra);
            tvUltraBadge.setTextColor(0xFFFBBF24);
            tvUltraDesc.setText(R.string.ultra_desc_extreme);
        } else if (ultraOn) {
            tvUltraBadge.setText("ULTRA 360p");
            tvUltraBadge.setBackgroundResource(R.drawable.bg_badge_ultra);
            tvUltraBadge.setTextColor(0xFF34D399);
            tvUltraDesc.setText(R.string.ultra_desc_balanced);
        } else {
            tvUltraBadge.setText("OFF");
            tvUltraBadge.setBackgroundResource(R.drawable.bg_badge_std);
            tvUltraBadge.setTextColor(0xFF94A3B8);
            tvUltraDesc.setText(R.string.ultra_desc_off);
        }

        styleTierPill(btnUltraBalanced, ultraOn && !extreme, 0xFF059669, 0xFF34D399);
        styleTierPill(btnUltraExtreme, extreme, 0xFFD97706, 0xFFFBBF24);
        tvUltraSavings.setText(currentConfig.getUltraSavingsSummary());
        tvUltraSavings.setTextColor(ultraOn ? (extreme ? 0xFFFDE68A : 0xFF6EE7B7) : 0xFF94A3B8);

        // Skip Home + Low-End Pills
        toggleSkipHome.setChecked(currentConfig.skipPs5Home, animate);
        skipHomeCard.setBackgroundResource(currentConfig.skipPs5Home
                ? R.drawable.bg_toggle_card_active : R.drawable.bg_toggle_card);

        toggleLowEnd.setChecked(currentConfig.lowEndMode, animate);
        lowEndCard.setBackgroundResource(currentConfig.lowEndMode
                ? R.drawable.bg_toggle_card_active : R.drawable.bg_toggle_card);
        tvModeBadge.setText(currentConfig.lowEndMode ? "30 FPS · 2 Cores" : "60 FPS · Full");
        tvModeBadge.setTextColor(currentConfig.lowEndMode ? 0xFF34D399 : 0xFF38BDF8);

        // Resource Load Meter
        tvProfileMeta.setText(currentConfig.getProfileSummary());
        loadBar.setLoad(currentConfig.getEstimatedLoadFraction(), currentConfig.lowEndMode || ultraOn, animate);

        // Graphics tier highlights
        for (int i = 0; i < presetButtons.length; i++) {
            boolean sel = (i == currentConfig.graphicsPreset);
            GradientDrawable bg = new GradientDrawable();
            bg.setColor(sel ? (ultraOn ? 0xE6059669 : 0xE60070D1) : 0x55122040);
            bg.setCornerRadius(10 * d);
            bg.setStroke(Math.round(1 * d), sel ? Color.WHITE : 0x4493C5FD);
            presetButtons[i].setBackground(bg);
            presetButtons[i].setTextColor(sel ? Color.WHITE : 0xFFB8C7E0);
        }
        tvGraphicsHint.setText(ultraOn
                ? (extreme ? "POTATO · EXTREME 270p" : "POTATO · ULTRA 360p")
                : LaunchConfig.PRESET_LABELS[currentConfig.graphicsPreset]);

        // Render Distance display
        if (currentConfig.renderDistance < 0) {
            btnRenderDistNum.setText("DEFAULT");
            tvRenderDistDesc.setText("Default (GTA 5 Engine Default) · Lower = less loads nearby");
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

        // Primary CTA styling adapts to Direct Boot & Ultra Mode
        if (currentConfig.skipPs5Home) {
            tvLaunchTitle.setText(ultraOn ? "⚡ LAUNCH GTA V (" + currentConfig.getUltraBadgeLabel() + ")" : "LAUNCH GTA V DIRECT");
            tvLaunchSub.setText("Skips PS5 Home WebView · Maximum free RAM for WebGPU");
            btnLaunch.setBackgroundResource(ultraOn ? R.drawable.bg_launch_ultra_btn : R.drawable.bg_launch_btn);
        } else {
            tvLaunchTitle.setText(R.string.launch_button);
            tvLaunchSub.setText(ultraOn
                    ? ("PS5 Home UI · " + currentConfig.getUltraBadgeLabel() + " Armed")
                    : getString(R.string.launch_sub));
            btnLaunch.setBackgroundResource(R.drawable.bg_launch_btn);
        }

        // Disable background wallpaper animation on Low-End / Ultra phones to save GPU RAM
        if (currentConfig.lowEndMode || ultraOn) {
            stopBgAnimation();
            bgArt.setScaleX(1.0f);
            bgArt.setScaleY(1.0f);
        } else {
            startBgAnimation();
        }
    }

    private void styleTierPill(TextView tv, boolean active, int fill, int stroke) {
        float d = getResources().getDisplayMetrics().density;
        GradientDrawable bg = new GradientDrawable();
        bg.setColor(active ? (0xD9000000 | (fill & 0x00FFFFFF)) : 0x550C1A24);
        bg.setCornerRadius(10 * d);
        bg.setStroke(Math.round(1.2f * d), active ? stroke : 0x4464748B);
        tv.setBackground(bg);
        tv.setTextColor(active ? Color.WHITE : 0xFF94A3B8);
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
                .setTitle(R.string.info_dialog_title)
                .setMessage(R.string.info_dialog_message)
                .setPositiveButton("OK", null)
                .show();
    }

    private void startBgAnimation() {
        if (bgScaleX != null && bgScaleX.isRunning()) return;
        bgScaleX = ObjectAnimator.ofFloat(bgArt, View.SCALE_X, 1.0f, 1.07f);
        bgScaleX.setDuration(14000);
        bgScaleX.setRepeatCount(ValueAnimator.INFINITE);
        bgScaleX.setRepeatMode(ValueAnimator.REVERSE);
        bgScaleX.setInterpolator(new LinearInterpolator());

        bgScaleY = ObjectAnimator.ofFloat(bgArt, View.SCALE_Y, 1.0f, 1.07f);
        bgScaleY.setDuration(14000);
        bgScaleY.setRepeatCount(ValueAnimator.INFINITE);
        bgScaleY.setRepeatMode(ValueAnimator.REVERSE);
        bgScaleY.setInterpolator(new LinearInterpolator());

        bgScaleX.start();
        bgScaleY.start();
    }

    private void stopBgAnimation() {
        if (bgScaleX != null) { bgScaleX.cancel(); bgScaleX = null; }
        if (bgScaleY != null) { bgScaleY.cancel(); bgScaleY = null; }
    }
}
