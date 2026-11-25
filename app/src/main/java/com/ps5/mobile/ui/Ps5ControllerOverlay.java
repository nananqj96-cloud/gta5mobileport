package com.ps5.mobile.ui;

import android.content.Context;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.view.Gravity;
import android.view.HapticFeedbackConstants;
import android.view.MotionEvent;
import android.view.View;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;

import com.ps5.mobile.bridge.GameInputBridge;

/**
 * DualSense-inspired controller overlay for the PS5 Home Screen.
 * Enforces controller-only navigation: direct taps/drags on the PS5 UI surface are blocked.
 */
public final class Ps5ControllerOverlay extends FrameLayout {

    public interface HostCallback {
        void onOpenSettings();
        void onExitApp();
    }

    private final GameInputBridge input;
    private final HostCallback callback;

    public Ps5ControllerOverlay(Context context, GameInputBridge input, HostCallback callback) {
        super(context);
        this.input = input;
        this.callback = callback;
        setMotionEventSplittingEnabled(true);
        setFocusable(false);

        // Full-screen touch shield: blocks ALL direct taps & drags on the PS5 WebView UI!
        View touchBlocker = new View(context);
        touchBlocker.setClickable(true);
        touchBlocker.setOnTouchListener((v, e) -> true);
        addView(touchBlocker, new LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT));

        // Top-right PS5 utility pill: Settings & Exit Launcher
        LinearLayout topRight = new LinearLayout(context);
        topRight.setOrientation(LinearLayout.HORIZONTAL);
        topRight.setGravity(Gravity.CENTER_VERTICAL);
        topRight.addView(makeChip(context, "⚙ SETTINGS", 0xFF0070D1, () -> {
            input.ps5Options();
            if (callback != null) callback.onOpenSettings();
        }));
        topRight.addView(makeChip(context, "EXIT", 0xFF475569, () -> {
            if (callback != null) callback.onExitApp();
        }));
        LayoutParams trLp = new LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT, Gravity.TOP | Gravity.END);
        trLp.topMargin = dp(10);
        trLp.rightMargin = dp(14);
        addView(topRight, trLp);

        // Bottom-left DualSense D-Pad (Up / Down / Left / Right)
        FrameLayout dpad = new FrameLayout(context);
        int padSize = dp(146);
        int btnW = dp(46);
        int btnH = dp(46);

        dpad.addView(makeDpadBtn(context, "▲", "up"),
                new LayoutParams(btnW, btnH, Gravity.TOP | Gravity.CENTER_HORIZONTAL));
        dpad.addView(makeDpadBtn(context, "▼", "down"),
                new LayoutParams(btnW, btnH, Gravity.BOTTOM | Gravity.CENTER_HORIZONTAL));
        dpad.addView(makeDpadBtn(context, "◀", "left"),
                new LayoutParams(btnW, btnH, Gravity.START | Gravity.CENTER_VERTICAL));
        dpad.addView(makeDpadBtn(context, "▶", "right"),
                new LayoutParams(btnW, btnH, Gravity.END | Gravity.CENTER_VERTICAL));

        // Center dot of D-Pad
        View centerDot = new View(context);
        GradientDrawable cBg = new GradientDrawable();
        cBg.setShape(GradientDrawable.OVAL);
        cBg.setColor(0x550C152E);
        cBg.setStroke(dp(1), 0x4460A5FA);
        centerDot.setBackground(cBg);
        dpad.addView(centerDot, new LayoutParams(dp(24), dp(24), Gravity.CENTER));

        LayoutParams dpadLp = new LayoutParams(padSize, padSize, Gravity.BOTTOM | Gravity.START);
        dpadLp.leftMargin = dp(24);
        dpadLp.bottomMargin = dp(22);
        addView(dpad, dpadLp);

        // Bottom-right DualSense Action Buttons (Cross = Select, Circle = Back)
        FrameLayout actions = new FrameLayout(context);
        int actW = dp(142);
        int actH = dp(124);

        View btnCross = makeFaceButton(context, "✕", 0xFF38BDF8, input::ps5Cross);
        LayoutParams crossLp = new LayoutParams(dp(64), dp(64), Gravity.BOTTOM | Gravity.START);
        actions.addView(btnCross, crossLp);

        View btnCircle = makeFaceButton(context, "○", 0xFFFB7185, input::ps5Circle);
        LayoutParams circleLp = new LayoutParams(dp(56), dp(56), Gravity.TOP | Gravity.END);
        actions.addView(btnCircle, circleLp);

        LayoutParams actLp = new LayoutParams(actW, actH, Gravity.BOTTOM | Gravity.END);
        actLp.rightMargin = dp(26);
        actLp.bottomMargin = dp(24);
        addView(actions, actLp);
    }

    private TextView makeDpadBtn(Context ctx, String symbol, final String dir) {
        TextView tv = new TextView(ctx);
        tv.setText(symbol);
        tv.setTextColor(0xF0FFFFFF);
        tv.setTextSize(16f);
        tv.setGravity(Gravity.CENTER);
        tv.setFocusable(false);

        final GradientDrawable idle = new GradientDrawable();
        idle.setColor(0x880B142C);
        idle.setCornerRadius(dp(12));
        idle.setStroke(dp(1), 0x6693C5FD);

        final GradientDrawable active = new GradientDrawable();
        active.setColor(0xD80070D1);
        active.setCornerRadius(dp(12));
        active.setStroke(dp(2), Color.WHITE);

        tv.setBackground(idle);
        tv.setOnTouchListener((v, e) -> {
            int a = e.getActionMasked();
            if (a == MotionEvent.ACTION_DOWN) {
                v.setBackground(active);
                v.performHapticFeedback(HapticFeedbackConstants.VIRTUAL_KEY);
                input.ps5Move(dir);
                return true;
            } else if (a == MotionEvent.ACTION_UP || a == MotionEvent.ACTION_CANCEL) {
                v.setBackground(idle);
                return true;
            }
            return true;
        });
        return tv;
    }

    private TextView makeFaceButton(Context ctx, String symbol, int accent, final Runnable onPress) {
        TextView tv = new TextView(ctx);
        tv.setText(symbol);
        tv.setTextColor(accent);
        tv.setTextSize(24f);
        tv.setTypeface(Typeface.SANS_SERIF, Typeface.BOLD);
        tv.setGravity(Gravity.CENTER);
        tv.setFocusable(false);

        final GradientDrawable idle = new GradientDrawable();
        idle.setShape(GradientDrawable.OVAL);
        idle.setColor(0x960A132A);
        idle.setStroke(dp(2), (0xBB << 24) | (accent & 0x00FFFFFF));

        final GradientDrawable active = new GradientDrawable();
        active.setShape(GradientDrawable.OVAL);
        active.setColor((0xD0 << 24) | (accent & 0x00FFFFFF));
        active.setStroke(dp(2), Color.WHITE);

        tv.setBackground(idle);
        tv.setOnTouchListener((v, e) -> {
            int a = e.getActionMasked();
            if (a == MotionEvent.ACTION_DOWN) {
                v.setBackground(active);
                tv.setTextColor(Color.WHITE);
                v.performHapticFeedback(HapticFeedbackConstants.VIRTUAL_KEY);
                if (onPress != null) onPress.run();
                return true;
            } else if (a == MotionEvent.ACTION_UP || a == MotionEvent.ACTION_CANCEL) {
                v.setBackground(idle);
                tv.setTextColor(accent);
                return true;
            }
            return true;
        });
        return tv;
    }

    private TextView makeChip(Context ctx, String label, int accent, Runnable action) {
        TextView tv = new TextView(ctx);
        tv.setText(label);
        tv.setTextColor(Color.WHITE);
        tv.setTextSize(10.5f);
        tv.setTypeface(Typeface.SANS_SERIF, Typeface.BOLD);
        tv.setPadding(dp(11), dp(6), dp(11), dp(6));
        tv.setFocusable(false);

        GradientDrawable bg = new GradientDrawable();
        bg.setColor((0xCC << 24) | (accent & 0x00FFFFFF));
        bg.setCornerRadius(dp(16));
        bg.setStroke(dp(1), 0x80FFFFFF);
        tv.setBackground(bg);

        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        lp.leftMargin = dp(8);
        tv.setLayoutParams(lp);
        tv.setOnClickListener(v -> {
            v.performHapticFeedback(HapticFeedbackConstants.VIRTUAL_KEY);
            if (action != null) action.run();
        });
        return tv;
    }

    private int dp(int v) {
        return Math.round(v * getResources().getDisplayMetrics().density);
    }
}
