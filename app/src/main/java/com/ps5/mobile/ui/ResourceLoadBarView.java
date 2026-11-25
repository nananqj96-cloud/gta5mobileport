package com.ps5.mobile.ui;

import android.animation.ValueAnimator;
import android.content.Context;
import android.graphics.Canvas;
import android.graphics.LinearGradient;
import android.graphics.Paint;
import android.graphics.RectF;
import android.graphics.Shader;
import android.util.AttributeSet;
import android.view.View;
import android.view.animation.DecelerateInterpolator;

/**
 * Animated system resource load bar shown inside the PS5 launcher deck.
 */
public final class ResourceLoadBarView extends View {

    private final Paint bgPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint fillPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final RectF bgRect = new RectF();
    private final RectF fillRect = new RectF();

    private float fraction = 0.55f;
    private boolean lowMode = false;
    private ValueAnimator animator;

    public ResourceLoadBarView(Context context) {
        super(context);
        init();
    }

    public ResourceLoadBarView(Context context, AttributeSet attrs) {
        super(context, attrs);
        init();
    }

    private void init() {
        bgPaint.setColor(0x3693C5FD);
    }

    public void setLoad(float targetFraction, boolean isLowMode, boolean animate) {
        this.lowMode = isLowMode;
        float clamped = Math.max(0.12f, Math.min(1f, targetFraction));
        if (animator != null) animator.cancel();
        if (!animate) {
            fraction = clamped;
            invalidate();
            return;
        }
        animator = ValueAnimator.ofFloat(fraction, clamped);
        animator.setDuration(300);
        animator.setInterpolator(new DecelerateInterpolator());
        animator.addUpdateListener(a -> {
            fraction = (float) a.getAnimatedValue();
            invalidate();
        });
        animator.start();
    }

    @Override
    protected void onDraw(Canvas canvas) {
        super.onDraw(canvas);
        float w = getWidth();
        float h = getHeight();
        float r = h * 0.5f;
        bgRect.set(0, 0, w, h);
        canvas.drawRoundRect(bgRect, r, r, bgPaint);

        float fw = Math.max(h, w * fraction);
        fillRect.set(0, 0, fw, h);
        int cStart = lowMode ? 0xFF059669 : (fraction > 0.75f ? 0xFFF59E0B : 0xFF0070D1);
        int cEnd = lowMode ? 0xFF34D399 : (fraction > 0.75f ? 0xFFFB7185 : 0xFF38BDF8);
        fillPaint.setShader(new LinearGradient(0, 0, fw, 0, cStart, cEnd, Shader.TileMode.CLAMP));
        canvas.drawRoundRect(fillRect, r, r, fillPaint);
    }
}
