package com.ps5.mobile.ui;

import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Paint;
import android.view.HapticFeedbackConstants;
import android.view.MotionEvent;
import android.view.View;

/**
 * Multi-touch native thumbstick for smooth movement & flight control.
 * Pushing forward past 84% radius triggers automatic sprint with haptic feedback.
 */
public final class VirtualJoystickView extends View {

    public interface Listener {
        void onStickChanged(float normX, float normY, boolean sprintLock);
    }

    private final Paint baseFill = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint baseStroke = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint sprintRing = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint knobFill = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint knobStroke = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint labelPaint = new Paint(Paint.ANTI_ALIAS_FLAG);

    private Listener listener;
    private boolean sprintEnabled = true;
    private String topLabel = "W", bottomLabel = "S", leftLabel = "A", rightLabel = "D";

    private int activePointerId = MotionEvent.INVALID_POINTER_ID;
    private float normX = 0f, normY = 0f;
    private boolean sprintActive = false;

    public VirtualJoystickView(Context context) {
        super(context);
        setFocusable(false);
        setFocusableInTouchMode(false);
        baseStroke.setStyle(Paint.Style.STROKE);
        sprintRing.setStyle(Paint.Style.STROKE);
        knobStroke.setStyle(Paint.Style.STROKE);
        labelPaint.setTextAlign(Paint.Align.CENTER);
        labelPaint.setColor(0x66FFFFFF);
    }

    public void setListener(Listener listener) {
        this.listener = listener;
    }

    public void setSprintEnabled(boolean enabled) {
        this.sprintEnabled = enabled;
        invalidate();
    }

    public void setCardinalLabels(String top, String bottom, String left, String right) {
        this.topLabel = top;
        this.bottomLabel = bottom;
        this.leftLabel = left;
        this.rightLabel = right;
        invalidate();
    }

    public void reset() {
        activePointerId = MotionEvent.INVALID_POINTER_ID;
        normX = 0f;
        normY = 0f;
        sprintActive = false;
        if (listener != null) listener.onStickChanged(0f, 0f, false);
        invalidate();
    }

    @Override
    protected void onDraw(Canvas canvas) {
        super.onDraw(canvas);
        float d = getResources().getDisplayMetrics().density;
        float cx = getWidth() * 0.5f;
        float cy = getHeight() * 0.5f;
        float radius = Math.min(cx, cy) - 10f * d;
        float knobR = radius * 0.38f;
        float maxTravel = radius - knobR * 0.55f;

        baseFill.setColor(activePointerId != MotionEvent.INVALID_POINTER_ID ? 0x4A060E24 : 0x30060E24);
        canvas.drawCircle(cx, cy, radius, baseFill);

        baseStroke.setStrokeWidth(1.5f * d);
        baseStroke.setColor(sprintActive ? 0xDD38BDF8 : 0x55BAE6FD);
        canvas.drawCircle(cx, cy, radius, baseStroke);

        if (sprintEnabled) {
            sprintRing.setStrokeWidth(1.0f * d);
            sprintRing.setColor(sprintActive ? 0xAA38BDF8 : 0x26FFFFFF);
            canvas.drawCircle(cx, cy, radius * 0.84f, sprintRing);
        }

        labelPaint.setTextSize(10f * d);
        float offset = radius * 0.67f;
        float baseline = labelPaint.getTextSize() * 0.35f;
        canvas.drawText(topLabel, cx, cy - offset + baseline, labelPaint);
        canvas.drawText(bottomLabel, cx, cy + offset + baseline, labelPaint);
        canvas.drawText(leftLabel, cx - offset, cy + baseline, labelPaint);
        canvas.drawText(rightLabel, cx + offset, cy + baseline, labelPaint);

        float kx = cx + normX * maxTravel;
        float ky = cy + normY * maxTravel;

        knobFill.setColor(sprintActive ? 0xCC0070D1 : (activePointerId != MotionEvent.INVALID_POINTER_ID ? 0xB81E3A8A : 0x801E293B));
        canvas.drawCircle(kx, ky, knobR, knobFill);

        knobStroke.setStrokeWidth(2f * d);
        knobStroke.setColor(sprintActive ? 0xFF7DD3FC : 0xB8FFFFFF);
        canvas.drawCircle(kx, ky, knobR, knobStroke);
    }

    @Override
    public boolean onTouchEvent(MotionEvent event) {
        int action = event.getActionMasked();
        int index = event.getActionIndex();
        int pid = event.getPointerId(index);

        switch (action) {
            case MotionEvent.ACTION_DOWN:
            case MotionEvent.ACTION_POINTER_DOWN:
                if (activePointerId == MotionEvent.INVALID_POINTER_ID) {
                    activePointerId = pid;
                    updateFromTouch(event.getX(index), event.getY(index));
                    return true;
                }
                return false;

            case MotionEvent.ACTION_MOVE:
                if (activePointerId != MotionEvent.INVALID_POINTER_ID) {
                    int pIdx = event.findPointerIndex(activePointerId);
                    if (pIdx >= 0) {
                        updateFromTouch(event.getX(pIdx), event.getY(pIdx));
                        return true;
                    }
                }
                return false;

            case MotionEvent.ACTION_UP:
            case MotionEvent.ACTION_POINTER_UP:
                if (pid == activePointerId) {
                    reset();
                    return true;
                }
                return false;

            case MotionEvent.ACTION_CANCEL:
                reset();
                return true;

            default:
                return false;
        }
    }

    private void updateFromTouch(float tx, float ty) {
        float d = getResources().getDisplayMetrics().density;
        float cx = getWidth() * 0.5f;
        float cy = getHeight() * 0.5f;
        float radius = Math.max(1f, Math.min(cx, cy) - 10f * d);
        float maxTravel = Math.max(1f, radius * 0.79f);

        float dx = tx - cx;
        float dy = ty - cy;
        float dist = (float) Math.hypot(dx, dy);

        if (dist > maxTravel) {
            dx = dx / dist * maxTravel;
            dy = dy / dist * maxTravel;
        }

        normX = dx / maxTravel;
        normY = dy / maxTravel;
        boolean newSprint = sprintEnabled && normY < -0.80f && (dist / maxTravel) >= 0.84f;
        if (newSprint && !sprintActive) {
            performHapticFeedback(HapticFeedbackConstants.CLOCK_TICK);
        }
        sprintActive = newSprint;

        if (listener != null) listener.onStickChanged(normX, normY, sprintActive);
        invalidate();
    }
}
