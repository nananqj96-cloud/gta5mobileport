package com.ps5.mobile.ui;

import android.content.Context;
import android.os.SystemClock;
import android.view.MotionEvent;
import android.view.View;

/**
 * Transparent multi-touch 360° camera look pad used during GTA V gameplay.
 * Coalesces touch deltas at 60Hz (standard) or 30Hz (low-end) and supports direct TAP cursor mode.
 */
public final class CameraLookPadView extends View {

    public interface Listener {
        void onCameraDelta(float dx, float dy);
        void onDirectTap(float normX, float normY);
    }

    private Listener listener;
    private float sensitivity = 1.45f;
    private int flushIntervalMs = 16;
    private boolean directTapMode = false;

    private int activePointerId = MotionEvent.INVALID_POINTER_ID;
    private float lastX, lastY;
    private float downX, downY;
    private long downTimeMs;
    private float accumDx = 0f, accumDy = 0f;
    private long lastFlushMs = 0L;

    public CameraLookPadView(Context context) {
        super(context);
        setFocusable(false);
        setFocusableInTouchMode(false);
    }

    public void setListener(Listener listener) {
        this.listener = listener;
    }

    public void setSensitivity(float sensitivity) {
        this.sensitivity = sensitivity;
    }

    public void setFlushIntervalMs(int ms) {
        this.flushIntervalMs = Math.max(12, ms);
    }

    public void setDirectTapMode(boolean enabled) {
        this.directTapMode = enabled;
    }

    public boolean isDirectTapMode() {
        return directTapMode;
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
                    lastX = downX = event.getX(idx);
                    lastY = downY = event.getY(idx);
                    downTimeMs = SystemClock.uptimeMillis();
                    accumDx = 0f;
                    accumDy = 0f;
                    return true;
                }
                return false;

            case MotionEvent.ACTION_MOVE:
                if (activePointerId != MotionEvent.INVALID_POINTER_ID) {
                    int pIdx = event.findPointerIndex(activePointerId);
                    if (pIdx >= 0) {
                        float x = event.getX(pIdx);
                        float y = event.getY(pIdx);
                        float dx = (x - lastX) * sensitivity;
                        float dy = (y - lastY) * sensitivity;
                        lastX = x;
                        lastY = y;

                        if (!directTapMode) {
                            accumDx += dx;
                            accumDy += dy;
                            long now = SystemClock.uptimeMillis();
                            if (now - lastFlushMs >= flushIntervalMs) {
                                flushDeltas(now);
                            }
                        }
                        return true;
                    }
                }
                return false;

            case MotionEvent.ACTION_UP:
            case MotionEvent.ACTION_POINTER_UP:
                if (pid == activePointerId) {
                    int pIdx = event.findPointerIndex(activePointerId);
                    if (directTapMode && pIdx >= 0 && listener != null) {
                        float rawX = event.getRawX();
                        float rawY = event.getRawY();
                        float screenW = Math.max(1f, getResources().getDisplayMetrics().widthPixels);
                        float screenH = Math.max(1f, getResources().getDisplayMetrics().heightPixels);
                        listener.onDirectTap(rawX / screenW, rawY / screenH);
                    } else {
                        flushDeltas(SystemClock.uptimeMillis());
                    }
                    activePointerId = MotionEvent.INVALID_POINTER_ID;
                    return true;
                }
                return false;

            case MotionEvent.ACTION_CANCEL:
                activePointerId = MotionEvent.INVALID_POINTER_ID;
                accumDx = 0f;
                accumDy = 0f;
                return true;

            default:
                return false;
        }
    }

    private void flushDeltas(long now) {
        if (listener != null && (Math.abs(accumDx) >= 0.25f || Math.abs(accumDy) >= 0.25f)) {
            listener.onCameraDelta(accumDx, accumDy);
        }
        accumDx = 0f;
        accumDy = 0f;
        lastFlushMs = now;
    }
}
