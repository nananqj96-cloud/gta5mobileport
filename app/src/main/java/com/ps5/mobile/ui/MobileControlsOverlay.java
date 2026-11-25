package com.ps5.mobile.ui;

import android.content.Context;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.view.Gravity;
import android.view.HapticFeedbackConstants;
import android.view.View;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.TextView;

import com.ps5.mobile.bridge.GameInputBridge;
import com.ps5.mobile.config.LaunchConfig;

/**
 * Full multi-touch GTA V gameplay controller HUD (On-Foot, Drive, Fly) + 360° Camera Look Pad,
 * Fire Drag-to-Aim, dynamic Title Screen Mode/Server Dock, Top Utility Bar, and Crash Recovery.
 */
public final class MobileControlsOverlay extends FrameLayout {

    public enum ControlMode { FOOT, DRIVE, FLY }

    public interface HostCallback {
        void onOpenSettings();
        void onReturnToPs5Home();
        void onReloadGame(boolean forcePotatoLowEnd);
        void onClearCacheAndReload();
        void onUpdateWebView();
    }

    private static final int COBALT = 0xFF0070D1;
    private static final int SKY = 0xFF38BDF8;
    private static final int EMERALD = 0xFF10B981;
    private static final int GOLD = 0xFFF59E0B;
    private static final int CRIMSON = 0xFFEF4444;
    private static final int SLATE = 0xFF64748B;

    private final GameInputBridge input;
    private final HostCallback hostCallback;
    private final LaunchConfig config;

    private final FrameLayout gameplayLayer;
    private final FrameLayout footLayer;
    private final FrameLayout driveLayer;
    private final FrameLayout flyLayer;
    private final CameraLookPadView cameraPad;
    private final VirtualJoystickView footJoystick;
    private final VirtualJoystickView flyLeftStick;
    private final VirtualJoystickView flyRightStick;

    private final LinearLayout titleDock;
    private final LinearLayout errorBanner;
    private final TextView tvErrorMsg;
    private final TextView btnUpdateWebView;
    private final TextView btnDismissError;

    private final TextView btnMode;
    private final TextView btnSens;
    private final TextView btnTapMode;
    private final TextView btnShowHide;

    private ControlMode currentMode = ControlMode.FOOT;
    private boolean worldReady = false;
    private boolean manualPadOverride = false;
    private boolean gameplayVisible = false;

    private static final float[] SENS_VALUES = {0.85f, 1.35f, 1.90f, 2.55f};
    private static final String[] SENS_LABELS = {"0.7x", "1.0x", "1.4x", "1.9x"};
    private int sensIndex = 1;

    private boolean steerLeft, steerRight, driveGas, driveBrake;

    public MobileControlsOverlay(Context context, GameInputBridge input, LaunchConfig config, HostCallback hostCallback) {
        super(context);
        this.input = input;
        this.config = config;
        this.hostCallback = hostCallback;
        setClickable(false);
        setFocusable(false);
        setMotionEventSplittingEnabled(true);

        // 1. Gameplay Layer
        gameplayLayer = new FrameLayout(context);
        gameplayLayer.setMotionEventSplittingEnabled(true);
        addView(gameplayLayer, new LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT));

        cameraPad = new CameraLookPadView(context);
        cameraPad.setSensitivity(SENS_VALUES[sensIndex]);
        cameraPad.setFlushIntervalMs(config.bridgeFlushIntervalMs);
        cameraPad.setListener(new CameraLookPadView.Listener() {
            @Override
            public void onCameraDelta(float dx, float dy) {
                input.moveCamera(dx, dy);
            }

            @Override
            public void onDirectTap(float normX, float normY) {
                input.tapAt(normX, normY);
            }
        });
        LayoutParams padLp = new LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT);
        padLp.leftMargin = dp(185);
        padLp.topMargin = dp(48);
        gameplayLayer.addView(cameraPad, padLp);

        footLayer = new FrameLayout(context);
        driveLayer = new FrameLayout(context);
        flyLayer = new FrameLayout(context);
        footLayer.setMotionEventSplittingEnabled(true);
        driveLayer.setMotionEventSplittingEnabled(true);
        flyLayer.setMotionEventSplittingEnabled(true);
        gameplayLayer.addView(footLayer, new LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT));
        gameplayLayer.addView(driveLayer, new LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT));
        gameplayLayer.addView(flyLayer, new LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT));

        footJoystick = buildFootControls(context, footLayer);
        buildDriveControls(context, driveLayer);
        VirtualJoystickView[] flySticks = buildFlyControls(context, flyLayer);
        flyLeftStick = flySticks[0];
        flyRightStick = flySticks[1];

        // 2. Top-Right Utility Bar (leaves top-left completely clear for StatsHudView!)
        LinearLayout topBar = new LinearLayout(context);
        topBar.setOrientation(LinearLayout.HORIZONTAL);
        topBar.setGravity(Gravity.CENTER_VERTICAL);
        GradientDrawable barBg = new GradientDrawable();
        barBg.setColor(0xA6060D1E);
        barBg.setCornerRadius(dp(18));
        barBg.setStroke(dp(1), 0x4460A5FA);
        topBar.setBackground(barBg);
        topBar.setPadding(dp(7), dp(3), dp(7), dp(3));

        btnMode = addBarChip(context, topBar, "FOOT", COBALT, this::cycleControlMode);
        btnSens = addBarChip(context, topBar, "1.0x", SLATE, this::cycleSensitivity);
        btnTapMode = addBarChip(context, topBar, "LOOK", SKY, this::toggleTapMode);
        addBarChip(context, topBar, "PAUSE", SLATE, () -> input.pulseKey("Escape", 75));
        btnShowHide = addBarChip(context, topBar, "PAD", EMERALD, () -> {
            manualPadOverride = !manualPadOverride;
            updateGameplayVisibility();
        });
        addBarChip(context, topBar, "⚙", COBALT, () -> {
            if (hostCallback != null) hostCallback.onOpenSettings();
        });
        addBarChip(context, topBar, "PS5", 0xFF991B1B, () -> {
            input.releaseAll();
            if (hostCallback != null) hostCallback.onReturnToPs5Home();
        });

        LayoutParams topLp = new LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT, Gravity.TOP | Gravity.END);
        topLp.topMargin = dp(8);
        topLp.rightMargin = dp(10);
        addView(topBar, topLp);

        // 3. Title Screen Mode/Server Helper Dock
        titleDock = new LinearLayout(context);
        titleDock.setOrientation(LinearLayout.HORIZONTAL);
        titleDock.setGravity(Gravity.CENTER);
        GradientDrawable dockBg = new GradientDrawable();
        dockBg.setColor(0xC4071024);
        dockBg.setCornerRadius(dp(20));
        dockBg.setStroke(dp(1), 0x5560A5FA);
        titleDock.setBackground(dockBg);
        titleDock.setPadding(dp(10), dp(6), dp(10), dp(6));

        populateDefaultTitleButtons(context);

        LayoutParams dockLp = new LayoutParams(LayoutParams.WRAP_CONTENT, LayoutParams.WRAP_CONTENT, Gravity.BOTTOM | Gravity.CENTER_HORIZONTAL);
        dockLp.bottomMargin = dp(14);
        addView(titleDock, dockLp);

        // 4. Crash / WebGPU Error Recovery Banner
        errorBanner = new LinearLayout(context);
        errorBanner.setOrientation(LinearLayout.VERTICAL);
        errorBanner.setGravity(Gravity.CENTER);
        errorBanner.setVisibility(View.GONE);
        GradientDrawable errBg = new GradientDrawable();
        errBg.setColor(0xEB0A1022);
        errBg.setCornerRadius(dp(20));
        errBg.setStroke(dp(1), 0x88EF4444);
        errorBanner.setBackground(errBg);
        errorBanner.setPadding(dp(22), dp(18), dp(22), dp(18));

        tvErrorMsg = new TextView(context);
        tvErrorMsg.setTextColor(Color.WHITE);
        tvErrorMsg.setTextSize(13f);
        tvErrorMsg.setGravity(Gravity.CENTER);
        errorBanner.addView(tvErrorMsg);

        LinearLayout errActions = new LinearLayout(context);
        errActions.setOrientation(LinearLayout.HORIZONTAL);
        errActions.setGravity(Gravity.CENTER);
        errActions.setPadding(0, dp(12), 0, 0);
        btnUpdateWebView = addTitleChipView(context, errActions, "UPDATE WEBVIEW", COBALT, () -> {
            if (hostCallback != null) hostCallback.onUpdateWebView();
        });
        btnUpdateWebView.setVisibility(View.GONE);
        addTitleChip(context, errActions, "POTATO MODE", EMERALD, () -> {
            hideError();
            if (hostCallback != null) hostCallback.onReloadGame(true);
        });
        addTitleChip(context, errActions, "CLEAR CACHE", SKY, () -> {
            hideError();
            if (hostCallback != null) hostCallback.onClearCacheAndReload();
        });
        addTitleChip(context, errActions, "RELOAD", GOLD, () -> {
            hideError();
            if (hostCallback != null) hostCallback.onReloadGame(false);
        });
        btnDismissError = addTitleChipView(context, errActions, "WAIT", SLATE, this::hideError);
        btnDismissError.setVisibility(View.GONE);
        addTitleChip(context, errActions, "PS5 HOME", CRIMSON, () -> {
            if (hostCallback != null) hostCallback.onReturnToPs5Home();
        });
        errorBanner.addView(errActions);

        LayoutParams errLp = new LayoutParams(dp(530), LayoutParams.WRAP_CONTENT, Gravity.CENTER);
        addView(errorBanner, errLp);

        applyControlMode(ControlMode.FOOT);
        updateGameplayVisibility();
    }

    private void populateDefaultTitleButtons(Context context) {
        titleDock.removeAllViews();
        addTitleChip(context, titleDock, "STORY", EMERALD, () -> input.clickTitleAction("story"));
        addTitleChip(context, titleDock, "SANDBOX", COBALT, () -> input.clickTitleAction("sandbox"));
        addTitleChip(context, titleDock, "GTA V MAP", SKY, () -> input.clickTitleAction("map5"));
        addTitleChip(context, titleDock, "GTA VI MAP", SKY, () -> input.clickTitleAction("map6"));
        addTitleChip(context, titleDock, "MULTIPLAYER", GOLD, () -> input.clickTitleAction("multiplayer"));
        addTitleChip(context, titleDock, "GAMEPAD", SLATE, () -> {
            manualPadOverride = !manualPadOverride;
            updateGameplayVisibility();
        });
    }

    // ==================== ON-FOOT LAYOUT ====================
    private VirtualJoystickView buildFootControls(Context ctx, FrameLayout root) {
        VirtualJoystickView joy = new VirtualJoystickView(ctx);
        joy.setSprintEnabled(true);
        joy.setCardinalLabels("W", "S", "A", "D");
        joy.setListener((nx, ny, sprint) -> {
            boolean w = ny < -0.22f;
            boolean s = ny > 0.28f;
            boolean a = nx < -0.25f;
            boolean d = nx > 0.25f;
            input.setMoveKeys(w, s, a, d, sprint);
        });
        LayoutParams jLp = new LayoutParams(dp(158), dp(158), Gravity.BOTTOM | Gravity.START);
        jLp.leftMargin = dp(20);
        jLp.bottomMargin = dp(20);
        root.addView(joy, jLp);

        addBtn(ctx, root, "CROUCH", GameButtonView.IconType.TEXT_ONLY, SLATE, 48, 48,
                Gravity.BOTTOM | Gravity.START, 186, 0, 0, 26,
                down -> input.setKey("ControlLeft", down));
        addBtn(ctx, root, "COVER", GameButtonView.IconType.TEXT_ONLY, SLATE, 48, 48,
                Gravity.BOTTOM | Gravity.START, 186, 0, 0, 82,
                down -> input.setKey("KeyQ", down));
        addBtn(ctx, root, "ACT", GameButtonView.IconType.TEXT_ONLY, GOLD, 48, 48,
                Gravity.BOTTOM | Gravity.START, 20, 0, 0, 184,
                down -> input.setKey("KeyE", down));

        GameButtonView fireBtn = new GameButtonView(ctx, "FIRE", GameButtonView.IconType.FIRE, CRIMSON)
                .setPressListener(down -> input.mouseButton(0, down))
                .setDragListener((dx, dy) -> input.moveCamera(dx * SENS_VALUES[sensIndex], dy * SENS_VALUES[sensIndex]));
        place(root, fireBtn, 76, 76, Gravity.BOTTOM | Gravity.END, 0, 0, 22, 24);

        addBtn(ctx, root, "AIM", GameButtonView.IconType.AIM, GOLD, 60, 60,
                Gravity.BOTTOM | Gravity.END, 0, 0, 108, 28,
                down -> input.mouseButton(2, down));
        addBtn(ctx, root, "JUMP", GameButtonView.IconType.JUMP, SKY, 56, 56,
                Gravity.BOTTOM | Gravity.END, 0, 0, 104, 98,
                down -> input.setKey("Space", down));
        addBtn(ctx, root, "CAR", GameButtonView.IconType.CAR, EMERALD, 56, 56,
                Gravity.BOTTOM | Gravity.END, 0, 0, 26, 110,
                down -> input.setKey("KeyF", down));
        addBtn(ctx, root, "RLD", GameButtonView.IconType.RELOAD, SLATE, 46, 46,
                Gravity.BOTTOM | Gravity.END, 0, 0, 174, 34,
                down -> input.setKey("KeyR", down));
        addBtn(ctx, root, "WPN", GameButtonView.IconType.WEAPON, GOLD, 48, 48,
                Gravity.BOTTOM | Gravity.END, 0, 0, 170, 92,
                down -> input.setKey("Tab", down));
        addBtn(ctx, root, "◀", GameButtonView.IconType.TEXT_ONLY, SLATE, 34, 34,
                Gravity.BOTTOM | Gravity.END, 0, 0, 222, 99,
                down -> { if (down) input.wheelStep(-1); });
        addBtn(ctx, root, "▶", GameButtonView.IconType.TEXT_ONLY, SLATE, 34, 34,
                Gravity.BOTTOM | Gravity.END, 0, 0, 222, 56,
                down -> { if (down) input.wheelStep(1); });

        addBtn(ctx, root, "PHN", GameButtonView.IconType.PHONE, COBALT, 44, 44,
                Gravity.TOP | Gravity.END, 0, 102, 16, 0,
                down -> { if (down) input.pulseKey("ArrowUp", 70); });
        addBtn(ctx, root, "CAM", GameButtonView.IconType.CAMERA, SKY, 44, 44,
                Gravity.TOP | Gravity.END, 0, 102, 66, 0,
                down -> { if (down) input.pulseKey("KeyV", 70); });
        addBtn(ctx, root, "BACK", GameButtonView.IconType.TEXT_ONLY, SLATE, 44, 44,
                Gravity.TOP | Gravity.END, 0, 102, 116, 0,
                down -> input.setKey("KeyC", down));
        addBtn(ctx, root, "SPEC", GameButtonView.IconType.TEXT_ONLY, GOLD, 44, 44,
                Gravity.TOP | Gravity.END, 0, 152, 16, 0,
                down -> { if (down) input.pulseKey("CapsLock", 70); });
        return joy;
    }

    // ==================== DRIVE LAYOUT ====================
    private void buildDriveControls(Context ctx, FrameLayout root) {
        addPillBtn(ctx, root, "LEFT", GameButtonView.IconType.STEER_LEFT, SKY, 80, 68,
                Gravity.BOTTOM | Gravity.START, 20, 0, 0, 28,
                down -> { steerLeft = down; syncDriveKeys(); });
        addPillBtn(ctx, root, "RIGHT", GameButtonView.IconType.STEER_RIGHT, SKY, 80, 68,
                Gravity.BOTTOM | Gravity.START, 110, 0, 0, 28,
                down -> { steerRight = down; syncDriveKeys(); });

        addBtn(ctx, root, "HORN", GameButtonView.IconType.TEXT_ONLY, GOLD, 48, 48,
                Gravity.BOTTOM | Gravity.START, 24, 0, 0, 110,
                down -> input.setKey("KeyE", down));
        addBtn(ctx, root, "LIGHT", GameButtonView.IconType.TEXT_ONLY, SLATE, 48, 48,
                Gravity.BOTTOM | Gravity.START, 80, 0, 0, 110,
                down -> { if (down) input.pulseKey("KeyH", 70); });
        addBtn(ctx, root, "RADIO", GameButtonView.IconType.TEXT_ONLY, SLATE, 48, 48,
                Gravity.BOTTOM | Gravity.START, 136, 0, 0, 110,
                down -> input.setKey("KeyQ", down));

        addPillBtn(ctx, root, "GAS", GameButtonView.IconType.GAS, EMERALD, 74, 96,
                Gravity.BOTTOM | Gravity.END, 0, 0, 22, 24,
                down -> { driveGas = down; syncDriveKeys(); });
        addPillBtn(ctx, root, "BRAKE", GameButtonView.IconType.BRAKE, CRIMSON, 72, 74,
                Gravity.BOTTOM | Gravity.END, 0, 0, 108, 24,
                down -> { driveBrake = down; syncDriveKeys(); });
        addBtn(ctx, root, "DRIFT", GameButtonView.IconType.DRIFT, GOLD, 58, 58,
                Gravity.BOTTOM | Gravity.END, 0, 0, 112, 108,
                down -> input.setKey("Space", down));
        addBtn(ctx, root, "EXIT", GameButtonView.IconType.CAR, EMERALD, 54, 54,
                Gravity.BOTTOM | Gravity.END, 0, 0, 26, 132,
                down -> input.setKey("KeyF", down));
        addBtn(ctx, root, "SHOOT", GameButtonView.IconType.FIRE, CRIMSON, 52, 52,
                Gravity.BOTTOM | Gravity.END, 0, 0, 186, 40,
                down -> input.mouseButton(0, down));
        addBtn(ctx, root, "CAM", GameButtonView.IconType.CAMERA, SKY, 46, 46,
                Gravity.TOP | Gravity.END, 0, 102, 18, 0,
                down -> { if (down) input.pulseKey("KeyV", 70); });
    }

    private void syncDriveKeys() {
        input.setMoveKeys(driveGas, driveBrake, steerLeft, steerRight, false);
    }

    // ==================== FLY LAYOUT ====================
    private VirtualJoystickView[] buildFlyControls(Context ctx, FrameLayout root) {
        VirtualJoystickView leftStick = new VirtualJoystickView(ctx);
        leftStick.setSprintEnabled(false);
        leftStick.setCardinalLabels("THR+", "THR-", "YAW L", "YAW R");
        leftStick.setListener((nx, ny, sp) ->
                input.setMoveKeys(ny < -0.22f, ny > 0.25f, nx < -0.25f, nx > 0.25f, false));
        LayoutParams lLp = new LayoutParams(dp(150), dp(150), Gravity.BOTTOM | Gravity.START);
        lLp.leftMargin = dp(20);
        lLp.bottomMargin = dp(22);
        root.addView(leftStick, lLp);

        VirtualJoystickView rightStick = new VirtualJoystickView(ctx);
        rightStick.setSprintEnabled(false);
        rightStick.setCardinalLabels("PITCH-", "PITCH+", "ROLL L", "ROLL R");
        rightStick.setListener((nx, ny, sp) ->
                input.setFlyKeys(ny < -0.22f, ny > 0.22f, nx < -0.22f, nx > 0.22f));
        LayoutParams rLp = new LayoutParams(dp(150), dp(150), Gravity.BOTTOM | Gravity.END);
        rLp.rightMargin = dp(20);
        rLp.bottomMargin = dp(22);
        root.addView(rightStick, rLp);

        addBtn(ctx, root, "GEAR", GameButtonView.IconType.TEXT_ONLY, SKY, 50, 50,
                Gravity.BOTTOM | Gravity.START, 180, 0, 0, 28,
                down -> { if (down) input.pulseKey("KeyG", 75); });
        addBtn(ctx, root, "BAIL", GameButtonView.IconType.CAR, CRIMSON, 50, 50,
                Gravity.BOTTOM | Gravity.START, 180, 0, 0, 86,
                down -> input.setKey("KeyF", down));
        addBtn(ctx, root, "FIRE", GameButtonView.IconType.FIRE, CRIMSON, 56, 56,
                Gravity.BOTTOM | Gravity.END, 0, 0, 180, 28,
                down -> input.setKey("Space", down));
        addBtn(ctx, root, "TGT L", GameButtonView.IconType.TEXT_ONLY, GOLD, 46, 46,
                Gravity.BOTTOM | Gravity.END, 0, 0, 184, 92,
                down -> input.setKey("KeyU", down));
        addBtn(ctx, root, "TGT R", GameButtonView.IconType.TEXT_ONLY, GOLD, 46, 46,
                Gravity.BOTTOM | Gravity.END, 0, 0, 236, 92,
                down -> input.setKey("KeyO", down));

        return new VirtualJoystickView[]{leftStick, rightStick};
    }

    // ==================== STATE UPDATES ====================
    public void onTitleButtonsChanged(String spec) {
        if (gameplayVisible || titleDock == null || spec == null || spec.trim().isEmpty()) return;
        titleDock.removeAllViews();
        Context ctx = getContext();
        String[] entries = spec.split("\\|");
        for (String entry : entries) {
            int sep = entry.indexOf(':');
            if (sep <= 0) continue;
            final String act = entry.substring(0, sep).trim();
            String rawLabel = entry.substring(sep + 1).trim();
            if (act.isEmpty() || rawLabel.isEmpty()) continue;
            String clean = rawLabel.replace("Backspace", "").replace("Space", "").replace("Enter", "").trim();
            if (clean.length() > 18) clean = clean.substring(0, 18).trim();
            int accent = SLATE;
            if (act.contains("story") || act.contains("multi") || act.contains("server")) accent = EMERALD;
            else if (act.contains("sandbox") || act.contains("map5")) accent = COBALT;
            else if (act.contains("map6")) accent = SKY;
            addTitleChip(ctx, titleDock, clean.toUpperCase(), accent, () -> input.clickTitleAction(act));
        }
        addTitleChip(ctx, titleDock, "GAMEPAD", GOLD, () -> {
            manualPadOverride = !manualPadOverride;
            updateGameplayVisibility();
        });
    }

    public void onWorldReady() {
        worldReady = true;
        updateGameplayVisibility();
    }

    public void resetForNewLoad() {
        worldReady = false;
        manualPadOverride = false;
        hideError();
        populateDefaultTitleButtons(getContext());
        updateGameplayVisibility();
    }

    public void setControlMode(ControlMode mode) {
        applyControlMode(mode);
    }

    public void showError(String message) {
        showError(message, false);
    }

    public void showError(String message, boolean showWebViewUpdate) {
        tvErrorMsg.setText(message);
        if (btnUpdateWebView != null) {
            btnUpdateWebView.setVisibility(showWebViewUpdate ? View.VISIBLE : View.GONE);
        }
        if (btnDismissError != null) {
            btnDismissError.setVisibility(View.GONE);
        }
        errorBanner.setVisibility(View.VISIBLE);
    }

    public void showStallWarning(String message) {
        tvErrorMsg.setText(message);
        if (btnUpdateWebView != null) {
            btnUpdateWebView.setVisibility(View.GONE);
        }
        if (btnDismissError != null) {
            btnDismissError.setVisibility(View.VISIBLE);
        }
        errorBanner.setVisibility(View.VISIBLE);
    }

    public void hideError() {
        errorBanner.setVisibility(View.GONE);
    }

    public void releaseAllInputs() {
        steerLeft = steerRight = driveGas = driveBrake = false;
        footJoystick.reset();
        flyLeftStick.reset();
        flyRightStick.reset();
        input.releaseAll();
    }

    private void updateGameplayVisibility() {
        gameplayVisible = worldReady || manualPadOverride;
        gameplayLayer.setVisibility(gameplayVisible ? View.VISIBLE : View.GONE);
        titleDock.setVisibility(gameplayVisible ? View.GONE : View.VISIBLE);
        btnShowHide.setText(gameplayVisible ? "PAD" : "SHOW");
    }

    private void cycleControlMode() {
        releaseAllInputs();
        if (currentMode == ControlMode.FOOT) applyControlMode(ControlMode.DRIVE);
        else if (currentMode == ControlMode.DRIVE) applyControlMode(ControlMode.FLY);
        else applyControlMode(ControlMode.FOOT);
    }

    private void applyControlMode(ControlMode mode) {
        currentMode = mode;
        footLayer.setVisibility(mode == ControlMode.FOOT ? View.VISIBLE : View.GONE);
        driveLayer.setVisibility(mode == ControlMode.DRIVE ? View.VISIBLE : View.GONE);
        flyLayer.setVisibility(mode == ControlMode.FLY ? View.VISIBLE : View.GONE);
        btnMode.setText(mode.name());
    }

    private void cycleSensitivity() {
        sensIndex = (sensIndex + 1) % SENS_VALUES.length;
        cameraPad.setSensitivity(SENS_VALUES[sensIndex]);
        btnSens.setText(SENS_LABELS[sensIndex]);
    }

    private void toggleTapMode() {
        boolean next = !cameraPad.isDirectTapMode();
        cameraPad.setDirectTapMode(next);
        btnTapMode.setText(next ? "TAP" : "LOOK");
        styleChip(btnTapMode, next ? GOLD : SKY);
    }

    // ==================== HELPERS ====================
    private void addBtn(Context ctx, FrameLayout root, String label, GameButtonView.IconType icon,
                        int accent, int wDp, int hDp, int gravity,
                        int l, int t, int r, int b, GameButtonView.PressListener listener) {
        GameButtonView btn = new GameButtonView(ctx, label, icon, accent).setPressListener(listener);
        place(root, btn, wDp, hDp, gravity, l, t, r, b);
    }

    private void addPillBtn(Context ctx, FrameLayout root, String label, GameButtonView.IconType icon,
                            int accent, int wDp, int hDp, int gravity,
                            int l, int t, int r, int b, GameButtonView.PressListener listener) {
        GameButtonView btn = new GameButtonView(ctx, label, icon, accent).setPillShape(true).setPressListener(listener);
        place(root, btn, wDp, hDp, gravity, l, t, r, b);
    }

    private void place(FrameLayout root, View v, int wDp, int hDp, int gravity, int l, int t, int r, int b) {
        LayoutParams lp = new LayoutParams(dp(wDp), dp(hDp), gravity);
        lp.leftMargin = dp(l);
        lp.topMargin = dp(t);
        lp.rightMargin = dp(r);
        lp.bottomMargin = dp(b);
        root.addView(v, lp);
    }

    private TextView addBarChip(Context ctx, LinearLayout parent, String text, int accent, Runnable action) {
        TextView tv = new TextView(ctx);
        tv.setText(text);
        tv.setTextColor(Color.WHITE);
        tv.setTextSize(10f);
        tv.setTypeface(Typeface.SANS_SERIF, Typeface.BOLD);
        tv.setPadding(dp(8), dp(4), dp(8), dp(4));
        tv.setFocusable(false);
        styleChip(tv, accent);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        lp.leftMargin = dp(4);
        tv.setLayoutParams(lp);
        tv.setOnClickListener(v -> {
            v.performHapticFeedback(HapticFeedbackConstants.VIRTUAL_KEY);
            action.run();
        });
        parent.addView(tv);
        return tv;
    }

    private void addTitleChip(Context ctx, LinearLayout parent, String text, int accent, Runnable action) {
        addTitleChipView(ctx, parent, text, accent, action);
    }

    private TextView addTitleChipView(Context ctx, LinearLayout parent, String text, int accent, Runnable action) {
        TextView tv = new TextView(ctx);
        tv.setText(text);
        tv.setTextColor(Color.WHITE);
        tv.setTextSize(10.5f);
        tv.setTypeface(Typeface.SANS_SERIF, Typeface.BOLD);
        tv.setPadding(dp(11), dp(6), dp(11), dp(6));
        tv.setFocusable(false);
        GradientDrawable bg = new GradientDrawable();
        bg.setColor((0xCC << 24) | (accent & 0x00FFFFFF));
        bg.setCornerRadius(dp(14));
        bg.setStroke(dp(1), 0x80FFFFFF);
        tv.setBackground(bg);
        LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.WRAP_CONTENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        lp.leftMargin = dp(4);
        lp.rightMargin = dp(4);
        tv.setLayoutParams(lp);
        tv.setOnClickListener(v -> {
            v.performHapticFeedback(HapticFeedbackConstants.VIRTUAL_KEY);
            action.run();
        });
        parent.addView(tv);
        return tv;
    }

    private void styleChip(TextView tv, int accent) {
        GradientDrawable bg = new GradientDrawable();
        bg.setColor((0x99 << 24) | (accent & 0x00FFFFFF));
        bg.setCornerRadius(dp(12));
        bg.setStroke(dp(1), 0x55FFFFFF);
        tv.setBackground(bg);
    }

    private int dp(int value) {
        return Math.round(value * getResources().getDisplayMetrics().density);
    }
}
