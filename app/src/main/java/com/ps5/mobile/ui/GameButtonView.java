package com.ps5.mobile.ui;

import android.content.Context;
import android.graphics.Canvas;
import android.graphics.Color;
import android.graphics.Paint;
import android.graphics.Path;
import android.graphics.Typeface;
import android.view.HapticFeedbackConstants;
import android.view.MotionEvent;
import android.view.View;

/**
 * Translucent custom-drawn tactical gameplay button with crisp vector icons,
 * press haptics, toggle state, and optional Drag-to-Aim while holding Fire.
 */
public final class GameButtonView extends View {

    public enum IconType {
        TEXT_ONLY, FIRE, AIM, JUMP, CAR, RELOAD, GAS, BRAKE, DRIFT,
        STEER_LEFT, STEER_RIGHT, CAMERA, PHONE, WEAPON
    }

    public interface PressListener {
        void onPressChanged(boolean down);
    }

    public interface DragListener {
        void onDragDelta(float dx, float dy);
    }

    private final Paint fillPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint strokePaint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint iconPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Paint textPaint = new Paint(Paint.ANTI_ALIAS_FLAG);
    private final Path path = new Path();

    private final String label;
    private final IconType iconType;
    private final int accentColor;
    private boolean pillShape = false;
    private boolean toggleMode = false;
    private boolean toggledOn = false;
    private boolean pressed = false;
    private int activePointerId = MotionEvent.INVALID_POINTER_ID;
    private float lastDragX, lastDragY;
    private PressListener pressListener;
    private DragListener dragListener;

    public GameButtonView(Context context, String label, IconType iconType, int accentColor) {
        super(context);
        setFocusable(false);
        setFocusableInTouchMode(false);
        this.label = label;
        this.iconType = iconType;
        this.accentColor = accentColor;
        strokePaint.setStyle(Paint.Style.STROKE);
        iconPaint.setStyle(Paint.Style.STROKE);
        iconPaint.setStrokeCap(Paint.Cap.ROUND);
        iconPaint.setStrokeJoin(Paint.Join.ROUND);
        textPaint.setTextAlign(Paint.Align.CENTER);
        textPaint.setTypeface(Typeface.create(Typeface.SANS_SERIF, Typeface.BOLD));
    }

    public GameButtonView setPillShape(boolean pill) {
        this.pillShape = pill;
        invalidate();
        return this;
    }

    public GameButtonView setToggleMode(boolean toggle) {
        this.toggleMode = toggle;
        return this;
    }

    public GameButtonView setPressListener(PressListener l) {
        this.pressListener = l;
        return this;
    }

    public GameButtonView setDragListener(DragListener l) {
        this.dragListener = l;
        return this;
    }

    public void setToggled(boolean on) {
        toggledOn = on;
        invalidate();
    }

    @Override
    protected void onDraw(Canvas canvas) {
        super.onDraw(canvas);
        float d = getResources().getDisplayMetrics().density;
        float w = getWidth();
        float h = getHeight();
        float cx = w * 0.5f;
        float cy = h * 0.5f;
        boolean lit = pressed || toggledOn;

        int fillAlpha = lit ? 0xC8 : 0x6A;
        int baseColor = lit ? accentColor : 0xFF0A1124;
        fillPaint.setColor((fillAlpha << 24) | (baseColor & 0x00FFFFFF));

        strokePaint.setStrokeWidth((lit ? 2.1f : 1.3f) * d);
        strokePaint.setColor(lit ? 0xFFFFFFFF : ((0xAA << 24) | (accentColor & 0x00FFFFFF)));

        if (pillShape) {
            float rad = Math.min(w, h) * 0.34f;
            float inset = 2f * d;
            canvas.drawRoundRect(inset, inset, w - inset, h - inset, rad, rad, fillPaint);
            canvas.drawRoundRect(inset, inset, w - inset, h - inset, rad, rad, strokePaint);
        } else {
            float r = Math.min(cx, cy) - 2f * d;
            canvas.drawCircle(cx, cy, r, fillPaint);
            canvas.drawCircle(cx, cy, r, strokePaint);
        }

        int fg = lit ? Color.WHITE : 0xF0F8FAFC;
        iconPaint.setColor(fg);
        iconPaint.setStrokeWidth(2.0f * d);

        float iconSize = Math.min(w, h) * 0.24f;
        float iconCy = (label != null && !label.isEmpty() && iconType != IconType.TEXT_ONLY)
                ? cy - 5.5f * d : cy;
        drawIcon(canvas, cx, iconCy, iconSize, d, fg);

        if (label != null && !label.isEmpty()) {
            textPaint.setColor(fg);
            if (iconType == IconType.TEXT_ONLY) {
                textPaint.setTextSize(Math.min(13f * d, Math.min(w, h) * 0.32f));
                canvas.drawText(label, cx, cy + textPaint.getTextSize() * 0.35f, textPaint);
            } else {
                textPaint.setTextSize(8.5f * d);
                canvas.drawText(label, cx, cy + iconSize + 7.5f * d, textPaint);
            }
        }
    }

    private void drawIcon(Canvas c, float cx, float cy, float r, float d, int fg) {
        path.reset();
        switch (iconType) {
            case FIRE:
                c.drawCircle(cx, cy, r * 0.72f, iconPaint);
                c.drawLine(cx - r * 1.1f, cy, cx - r * 0.45f, cy, iconPaint);
                c.drawLine(cx + r * 0.45f, cy, cx + r * 1.1f, cy, iconPaint);
                c.drawLine(cx, cy - r * 1.1f, cx, cy - r * 0.45f, iconPaint);
                c.drawLine(cx, cy + r * 0.45f, cx, cy + r * 1.1f, iconPaint);
                break;
            case AIM:
                c.drawCircle(cx, cy, r * 0.9f, iconPaint);
                c.drawCircle(cx, cy, r * 0.22f, iconPaint);
                break;
            case JUMP:
                path.moveTo(cx, cy - r * 0.85f);
                path.lineTo(cx - r * 0.7f, cy + r * 0.1f);
                path.moveTo(cx, cy - r * 0.85f);
                path.lineTo(cx + r * 0.7f, cy + r * 0.1f);
                path.moveTo(cx, cy - r * 0.75f);
                path.lineTo(cx, cy + r * 0.85f);
                c.drawPath(path, iconPaint);
                break;
            case CAR:
                c.drawRoundRect(cx - r, cy - r * 0.15f, cx + r, cy + r * 0.55f, 3 * d, 3 * d, iconPaint);
                path.moveTo(cx - r * 0.65f, cy - r * 0.15f);
                path.lineTo(cx - r * 0.35f, cy - r * 0.75f);
                path.lineTo(cx + r * 0.35f, cy - r * 0.75f);
                path.lineTo(cx + r * 0.65f, cy - r * 0.15f);
                c.drawPath(path, iconPaint);
                break;
            case RELOAD:
                c.drawArc(cx - r * 0.75f, cy - r * 0.75f, cx + r * 0.75f, cy + r * 0.75f, 35, 290, false, iconPaint);
                path.moveTo(cx + r * 0.42f, cy - r * 0.72f);
                path.lineTo(cx + r * 0.88f, cy - r * 0.45f);
                path.lineTo(cx + r * 0.32f, cy - r * 0.22f);
                c.drawPath(path, iconPaint);
                break;
            case GAS:
                path.moveTo(cx - r * 0.7f, cy + r * 0.4f);
                path.lineTo(cx, cy - r * 0.55f);
                path.lineTo(cx + r * 0.7f, cy + r * 0.4f);
                c.drawPath(path, iconPaint);
                break;
            case BRAKE:
                path.moveTo(cx - r * 0.7f, cy - r * 0.4f);
                path.lineTo(cx, cy + r * 0.55f);
                path.lineTo(cx + r * 0.7f, cy - r * 0.4f);
                c.drawPath(path, iconPaint);
                break;
            case DRIFT:
                c.drawCircle(cx, cy, r * 0.75f, iconPaint);
                textPaint.setColor(fg);
                textPaint.setTextSize(r * 1.0f);
                c.drawText("P", cx, cy + r * 0.36f, textPaint);
                break;
            case STEER_LEFT:
                path.moveTo(cx + r * 0.4f, cy - r * 0.75f);
                path.lineTo(cx - r * 0.55f, cy);
                path.lineTo(cx + r * 0.4f, cy + r * 0.75f);
                c.drawPath(path, iconPaint);
                break;
            case STEER_RIGHT:
                path.moveTo(cx - r * 0.4f, cy - r * 0.75f);
                path.lineTo(cx + r * 0.55f, cy);
                path.lineTo(cx - r * 0.4f, cy + r * 0.75f);
                c.drawPath(path, iconPaint);
                break;
            case CAMERA:
                c.drawRoundRect(cx - r * 0.9f, cy - r * 0.55f, cx + r * 0.9f, cy + r * 0.65f, 3 * d, 3 * d, iconPaint);
                c.drawCircle(cx, cy + r * 0.05f, r * 0.32f, iconPaint);
                break;
            case PHONE:
                c.drawRoundRect(cx - r * 0.55f, cy - r * 0.9f, cx + r * 0.55f, cy + r * 0.9f, 3 * d, 3 * d, iconPaint);
                break;
            case WEAPON:
                c.drawLine(cx - r * 0.85f, cy, cx + r * 0.85f, cy, iconPaint);
                c.drawLine(cx - r * 0.3f, cy, cx - r * 0.45f, cy + r * 0.7f, iconPaint);
                break;
            case TEXT_ONLY:
            default:
                break;
        }
    }

    @Override
    public boolean onTouchEvent(MotionEvent event) {
        int action = event.getActionMasked();
        int idx = event.getActionIndex();
        int pid = event.getPointerId(idx);

        switch (action) {
            case MotionEvent.ACTION_DOWN:
            case MotionEvent.ACTION_POINTER_DOWN:
                if (activePointerId == MotionEvent.INVALID_POINTER_ID) {
                    activePointerId = pid;
                    lastDragX = event.getX(idx);
                    lastDragY = event.getY(idx);
                    performHapticFeedback(HapticFeedbackConstants.VIRTUAL_KEY);
                    if (toggleMode) {
                        toggledOn = !toggledOn;
                        pressed = true;
                        if (pressListener != null) pressListener.onPressChanged(toggledOn);
                    } else {
                        pressed = true;
                        if (pressListener != null) pressListener.onPressChanged(true);
                    }
                    invalidate();
                    return true;
                }
                return false;

            case MotionEvent.ACTION_MOVE:
                if (activePointerId != MotionEvent.INVALID_POINTER_ID && dragListener != null) {
                    int pIdx = event.findPointerIndex(activePointerId);
                    if (pIdx >= 0) {
                        float x = event.getX(pIdx);
                        float y = event.getY(pIdx);
                        float dx = x - lastDragX;
                        float dy = y - lastDragY;
                        lastDragX = x;
                        lastDragY = y;
                        if (Math.abs(dx) > 0.4f || Math.abs(dy) > 0.4f) {
                            dragListener.onDragDelta(dx, dy);
                        }
                        return true;
                    }
                }
                return false;

            case MotionEvent.ACTION_UP:
            case MotionEvent.ACTION_POINTER_UP:
            case MotionEvent.ACTION_CANCEL:
                if (pid == activePointerId || action == MotionEvent.ACTION_CANCEL) {
                    activePointerId = MotionEvent.INVALID_POINTER_ID;
                    pressed = false;
                    if (!toggleMode && pressListener != null) {
                        pressListener.onPressChanged(false);
                    }
                    invalidate();
                    return true;
                }
                return false;

            default:
                return false;
        }
    }
}
