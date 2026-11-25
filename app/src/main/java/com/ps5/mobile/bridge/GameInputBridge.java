package com.ps5.mobile.bridge;

import android.os.Handler;
import android.os.Looper;
import android.webkit.WebView;

import java.util.Locale;

/**
 * Low-overhead Java -> WebView dispatcher powering both:
 * 1) Controller-only PS5 Home UI navigation (window.__ps5Nav)
 * 2) Full GTA V gameplay touch controls, cheat console & settings sync (window.__gtaMobile)
 */
public final class GameInputBridge {

    private final WebView webView;
    private final Handler mainHandler = new Handler(Looper.getMainLooper());

    private boolean lastW, lastS, lastA, lastD, lastSprint;
    private boolean lastPitchUp, lastPitchDown, lastRollLeft, lastRollRight;

    public GameInputBridge(WebView webView) {
        this.webView = webView;
    }

    private void eval(final String js) {
        if (Looper.myLooper() == Looper.getMainLooper()) {
            webView.evaluateJavascript(js, null);
        } else {
            mainHandler.post(() -> webView.evaluateJavascript(js, null));
        }
    }

    private static String escapeJs(String s) {
        if (s == null) return "";
        return s.replace("\\", "\\\\").replace("'", "\\'").replace("\n", "").replace("\r", "");
    }

    // ==================== PS5 HOME UI CONTROLLER API ====================

    public void ps5Move(String dir) {
        eval("window.__ps5Nav&&window.__ps5Nav.move('" + escapeJs(dir) + "')");
    }

    public void ps5Cross() {
        eval("window.__ps5Nav&&window.__ps5Nav.pressCross()");
    }

    public void ps5Circle() {
        eval("window.__ps5Nav&&window.__ps5Nav.pressCircle()");
    }

    public void ps5Options() {
        eval("window.__ps5Nav&&window.__ps5Nav.pressOptions()");
    }

    public void ps5SetProfileSummary(String summary) {
        eval("window.__ps5Nav&&window.__ps5Nav.setProfileSummary('" + escapeJs(summary) + "')");
    }

    public void ps5ResetBoot() {
        eval("window.__ps5Nav&&window.__ps5Nav.resetBoot()");
    }

    // ==================== GTA V GAMEPLAY & TRAINER API ====================

    public void setMoveKeys(boolean w, boolean s, boolean a, boolean d, boolean sprint) {
        if (w == lastW && s == lastS && a == lastA && d == lastD && sprint == lastSprint) {
            return;
        }
        lastW = w;
        lastS = s;
        lastA = a;
        lastD = d;
        lastSprint = sprint;
        eval("window.__gtaMobile&&window.__gtaMobile.setMoveKeys("
                + (w ? 1 : 0) + "," + (s ? 1 : 0) + ","
                + (a ? 1 : 0) + "," + (d ? 1 : 0) + ","
                + (sprint ? 1 : 0) + ")");
    }

    public void setFlyKeys(boolean pitchUp, boolean pitchDown, boolean rollLeft, boolean rollRight) {
        if (pitchUp == lastPitchUp && pitchDown == lastPitchDown
                && rollLeft == lastRollLeft && rollRight == lastRollRight) {
            return;
        }
        lastPitchUp = pitchUp;
        lastPitchDown = pitchDown;
        lastRollLeft = rollLeft;
        lastRollRight = rollRight;
        eval("window.__gtaMobile&&window.__gtaMobile.setFlyKeys("
                + (pitchUp ? 1 : 0) + "," + (pitchDown ? 1 : 0) + ","
                + (rollLeft ? 1 : 0) + "," + (rollRight ? 1 : 0) + ")");
    }

    public void setKey(String code, boolean down) {
        eval("window.__gtaMobile&&window.__gtaMobile.setKey('" + escapeJs(code) + "'," + (down ? "true" : "false") + ")");
    }

    public void pulseKey(String code, int holdMs) {
        eval("window.__gtaMobile&&window.__gtaMobile.pulseKey('" + escapeJs(code) + "'," + holdMs + ")");
    }

    public void moveCamera(float dx, float dy) {
        if (Math.abs(dx) < 0.05f && Math.abs(dy) < 0.05f) return;
        eval(String.format(Locale.US,
                "window.__gtaMobile&&window.__gtaMobile.moveCamera(%.2f,%.2f)", dx, dy));
    }

    public void mouseButton(int button, boolean down) {
        eval("window.__gtaMobile&&window.__gtaMobile.mouseButton(" + button + "," + (down ? "true" : "false") + ")");
    }

    public void wheelStep(int steps) {
        eval("window.__gtaMobile&&window.__gtaMobile.wheelStep(" + steps + ")");
    }

    public void tapAt(float normX, float normY) {
        eval(String.format(Locale.US,
                "window.__gtaMobile&&window.__gtaMobile.tapAt(%.4f,%.4f)", normX, normY));
    }

    public void clickTitleAction(String action) {
        eval("window.__gtaMobile&&window.__gtaMobile.clickTitleAction('" + escapeJs(action) + "')");
    }

    public void runCheat(String cheatCode) {
        eval("window.__gtaMobile&&window.__gtaMobile.runCheat('" + escapeJs(cheatCode) + "')");
    }

    public void syncSettingsXml(String jsonConfig) {
        eval("window.__gtaMobile&&window.__gtaMobile.syncSettingsXml(" + jsonConfig + ")");
    }

    public void releaseAll() {
        lastW = lastS = lastA = lastD = lastSprint = false;
        lastPitchUp = lastPitchDown = lastRollLeft = lastRollRight = false;
        eval("window.__gtaMobile&&window.__gtaMobile.releaseAll()");
    }
}
