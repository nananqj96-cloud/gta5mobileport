package com.ps5.mobile.ui;

import android.animation.ValueAnimator;
import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.LinearGradient;
import android.graphics.Paint;
import android.graphics.RectF;
import android.graphics.Shader;
import android.util.AttributeSet;
import android.view.HapticFeedbackConstants;
import android.view.View;
import android.view.animation.OvershootInterpolator;

/**
 * Custom Canvas animated pill switch in PlayStation 5 electric-cobalt styling.
 */
public final class PremiumToggleSwitch extends View {

    public interface OnCheckedChangeListener {
        void onCheckedChanged(boolean checked);
    }

    private final Paint trackPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint borderPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint glowPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint thumbPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final RectF trackRect = new RectF();

    private boolean checked = false;
    private float progress = 0f;
    private ValueAnimator animator;
    private OnCheckedChangeListener listener;

    public PremiumToggleSwitch(Context context) {
        super(context);
        init();
    }

    public PremiumToggleSwitch(Context context, AttributeSet attrs) {
        super(context, attrs);
        init();
    }

    private void init() {
        setClickable(true);
        setFocusable(true);
        borderPaint.setStyle(Paint.Style.STROKE);
        setOnClickListener(v -> toggle());
    }

    public void setOnCheckedChangeListener(OnCheckedChangeListener l) {
        this.listener = l;
    }

    public boolean isChecked() {
        return checked;
    }

    public void setChecked(boolean value, boolean animate) {
        if (checked == value && (!animate || (animator != null && animator.isRunning()))) {
            return;
        }
        checked = value;
        if (animator != null) animator.cancel();
        float target = checked ? 1f : 0f;
        if (!animate) {
            progress = target;
            invalidate();
            return;
        }
        animator = ValueAnimator.ofFloat(progress, target);
        animator.setDuration(240);
        animator.setInterpolator(new OvershootInterpolator(1.1f));
        animator.addUpdateListener(a -> {
            progress = (float) a.getAnimatedValue();
            invalidate();
        });
        animator.start();
    }

    public void toggle() {
        performHapticFeedback(HapticFeedbackConstants.VIRTUAL_KEY);
        setChecked(!checked, true);
        if (listener != null) listener.onCheckedChanged(checked);
    }

    @Override
    protected void onMeasure(int widthMeasureSpec, int heightMeasureSpec) {
        float d = getResources().getDisplayMetrics().density;
        int w = resolveSize(Math.round(58 * d), widthMeasureSpec);
        int h = resolveSize(Math.round(32 * d), heightMeasureSpec);
        setMeasuredDimension(w, h);
    }

    @Override
    protected void onDraw(Canvas canvas) {
        super.onDraw(canvas);
        float w = getWidth();
        float h = getHeight();
        float d = getResources().getDisplayMetrics().density;
        float pad = 2f * d;
        trackRect.set(pad, pad, w - pad, h - pad);
        float radius = trackRect.height() * 0.5f;
        float t = Math.max(0f, Math.min(1f, progress));

        int startCol = blendColor(0xFF141E38, 0xFF005BB5, t);
        int endCol = blendColor(0xFF1C294A, 0xFF38BDF8, t);
        trackPaint.setShader(new LinearGradient(trackRect.left, 0, trackRect.right, 0,
                startCol, endCol, Shader.TileMode.CLAMP));
        canvas.drawRoundRect(trackRect, radius, radius, trackPaint);

        borderPaint.setStrokeWidth(1.2f * d);
        borderPaint.setColor(blendColor(0x5093C5FD, 0xCC7DD3FC, t));
        canvas.drawRoundRect(trackRect, radius, radius, borderPaint);

        float thumbR = radius - (3.2f * d);
        float minX = trackRect.left + 3.2f * d + thumbR;
        float maxX = trackRect.right - 3.2f * d - thumbR;
        float cx = minX + (maxX - minX) * progress;
        float cy = trackRect.centerY();

        if (t > 0.05f) {
            glowPaint.setColor(Color.argb(Math.round(90 * t), 56, 189, 248));
            canvas.drawCircle(cx, cy, thumbR + 3f * d, glowPaint);
        }

        thumbPaint.setColor(0x45000000);
        canvas.drawCircle(cx, cy + 1.2f * d, thumbR, thumbPaint);
        thumbPaint.setColor(blendColor(0xFFCBD5E1, 0xFFFFFFFF, t));
        canvas.drawCircle(cx, cy, thumbR, thumbPaint);
    }

    private static int blendColor(int c1, int c2, float t) {
        int a = Math.round(Color.alpha(c1) + (Color.alpha(c2) - Color.alpha(c1)) * t);
        int r = Math.round(Color.red(c1) + (Color.red(c2) - Color.red(c1)) * t);
        int g = Math.round(Color.green(c1) + (Color.green(c2) - Color.green(c1)) * t);
        int b = Math.round(Color.blue(c1) + (Color.blue(c2) - Color.blue(c1)) * t);
        return Color.argb(a, r, g, b);
    }
}
