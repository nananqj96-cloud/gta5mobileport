package com.ps5.mobile.ui;

import android.content.Context;
import android.graphics.Color;
import android.graphics.Typeface;
import android.graphics.drawable.GradientDrawable;
import android.os.Handler;
import android.os.Looper;
import android.text.InputType;
import android.view.Gravity;
import android.view.HapticFeedbackConstants;
import android.view.MotionEvent;
import android.view.View;
import android.widget.EditText;
import android.widget.FrameLayout;
import android.widget.LinearLayout;
import android.widget.ScrollView;
import android.widget.SeekBar;
import android.widget.TextView;

import com.ps5.mobile.bridge.GameInputBridge;
import com.ps5.mobile.config.LaunchConfig;

/**
 * Floating draggable "D" button + full Developer Trainer Menu for GTA V:
 * - Spawn Vehicles (14 instant GTA V native cheat spawners + custom code runner)
 * - Weapons & Combat (Give All Weapons, Max Health/Armor/Repair, Explosive/Fire Ammo, Dead Eye)
 * - Player & Fly (God Mode + Auto-Renew, Skyfall Free Fly, Moon-Gravity Hover Fly, Super Jump, Wanted, Weather)
 * - Live Graphics & Render Distance Customizer (Potato -> High, Shadows OFF -1, Res Scale, Render Distance 0-100)
 * - Dev Tools (Debug Draw Isolation, Custom Cheat Console, Stats Toggle, Return to PS5 Home)
 */
public final class DeveloperTrainerOverlay extends FrameLayout {

    public interface Callback {
        void onSwitchToFlyHud();
        void onReloadGameWithNewGraphics(String optionalLaunchMode);
        void onToggleStatsQuick();
        void onTriggerMemoryTrim();
        void onReturnToPs5Home();
    }

    private final GameInputBridge input;
    private final Callback callback;
    private final Handler handler = new Handler(Looper.getMainLooper());

    private final TextView floatingD;
    private final FrameLayout drawerBackdrop;
    private final LinearLayout tabContent;
    private final TextView tvToastStatus;
    private final TextView[] tabButtons = new TextView[5];

    private int activeTab = 0;
    private boolean autoGodMode = false;

    // Graphics editor scratch state
    private int editPreset;
    private int editScale;
    private int editShadows;
    private int editFps;
    private int editRd;
    private boolean editLowEnd;
    private boolean editDbgDraws;

    // Drag tracking for floating D button
    private float dragDownX, dragDownY, btnStartX, btnStartY;
    private boolean dragged = false;

    private final Runnable godModeRefresher = new Runnable() {
        @Override
        public void run() {
            if (!autoGodMode) return;
            input.runCheat("PAINKILLER");
            showStatus("Auto-renewed God Mode (PAINKILLER)");
            handler.postDelayed(this, 270_000L); // Refresh every 4.5 min before 5 min expires
        }
    };

    public DeveloperTrainerOverlay(Context context, GameInputBridge input, Callback callback) {
        super(context);
        this.input = input;
        this.callback = callback;
        setClickable(false);
        setFocusable(false);

        // 1. Drawer Backdrop & Panel (hidden by default)
        drawerBackdrop = new FrameLayout(context);
        drawerBackdrop.setBackgroundColor(0xBA030714);
        drawerBackdrop.setVisibility(View.GONE);
        drawerBackdrop.setClickable(true);
        drawerBackdrop.setOnClickListener(v -> closeDrawer());

        LinearLayout drawer = new LinearLayout(context);
        drawer.setOrientation(LinearLayout.VERTICAL);
        drawer.setClickable(true);
        GradientDrawable drawerBg = new GradientDrawable();
        drawerBg.setColor(0xF5081126);
        drawerBg.setCornerRadius(dp(18));
        drawerBg.setStroke(dp(1), 0x7738BDF8);
        drawer.setBackground(drawerBg);
        drawer.setPadding(dp(14), dp(10), dp(14), dp(10));

        // Drawer Header
        LinearLayout hdr = new LinearLayout(context);
        hdr.setOrientation(LinearLayout.HORIZONTAL);
        hdr.setGravity(Gravity.CENTER_VERTICAL);

        TextView badgeD = new TextView(context);
        badgeD.setText("D");
        badgeD.setTextColor(Color.WHITE);
        badgeD.setTextSize(13f);
        badgeD.setTypeface(Typeface.MONOSPACE, Typeface.BOLD);
        badgeD.setGravity(Gravity.CENTER);
        GradientDrawable bBg = new GradientDrawable();
        bBg.setShape(GradientDrawable.OVAL);
        bBg.setColor(0xFF0070D1);
        bBg.setStroke(dp(1), 0xFF7DD3FC);
        badgeD.setBackground(bBg);
        hdr.addView(badgeD, new LinearLayout.LayoutParams(dp(26), dp(26)));

        TextView title = new TextView(context);
        title.setText("  DEVELOPER TRAINER");
        title.setTextColor(Color.WHITE);
        title.setTextSize(13.5f);
        title.setTypeface(Typeface.SANS_SERIF, Typeface.BOLD);
        hdr.addView(title, new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f));

        tvToastStatus = new TextView(context);
        tvToastStatus.setText("Ready · Native Console Hook");
        tvToastStatus.setTextColor(0xFF34D399);
        tvToastStatus.setTextSize(10f);
        tvToastStatus.setTypeface(Typeface.MONOSPACE);
        tvToastStatus.setPadding(0, 0, dp(10), 0);
        hdr.addView(tvToastStatus);

        hdr.addView(makeChip(context, "✕", 0xFF334155, this::closeDrawer));
        drawer.addView(hdr);

        // Tabs Bar
        String[] tabNames = {"VEHICLES", "WEAPONS", "PLAYER / FLY", "GRAPHICS", "DEV"};
        LinearLayout tabRow = new LinearLayout(context);
        tabRow.setOrientation(LinearLayout.HORIZONTAL);
        tabRow.setPadding(0, dp(8), 0, dp(8));
        for (int i = 0; i < tabNames.length; i++) {
            final int idx = i;
            TextView tb = new TextView(context);
            tb.setText(tabNames[i]);
            tb.setTextSize(10f);
            tb.setTypeface(Typeface.SANS_SERIF, Typeface.BOLD);
            tb.setGravity(Gravity.CENTER);
            tb.setPadding(dp(6), dp(7), dp(6), dp(7));
            LinearLayout.LayoutParams tlp = new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f);
            tlp.leftMargin = i == 0 ? 0 : dp(5);
            tb.setLayoutParams(tlp);
            tb.setOnClickListener(v -> {
                v.performHapticFeedback(HapticFeedbackConstants.VIRTUAL_KEY);
                selectTab(idx);
            });
            tabButtons[i] = tb;
            tabRow.addView(tb);
        }
        drawer.addView(tabRow);

        ScrollView scroll = new ScrollView(context);
        tabContent = new LinearLayout(context);
        tabContent.setOrientation(LinearLayout.VERTICAL);
        scroll.addView(tabContent);
        drawer.addView(scroll, new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, 0, 1f));

        drawerBackdrop.addView(drawer, new LayoutParams(dp(530), dp(326), Gravity.CENTER));
        addView(drawerBackdrop, new LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT));

        // 2. Floating Draggable "D" Button
        floatingD = new TextView(context);
        floatingD.setText("D");
        floatingD.setTextColor(Color.WHITE);
        floatingD.setTextSize(16f);
        floatingD.setTypeface(Typeface.MONOSPACE, Typeface.BOLD);
        floatingD.setGravity(Gravity.CENTER);
        floatingD.setFocusable(false);
        floatingD.setFocusableInTouchMode(false);
        floatingD.setElevation(dp(8));

        GradientDrawable dBg = new GradientDrawable();
        dBg.setShape(GradientDrawable.OVAL);
        dBg.setColor(0xD60070D1);
        dBg.setStroke(dp(2), 0xE67DD3FC);
        floatingD.setBackground(dBg);

        LayoutParams dLp = new LayoutParams(dp(42), dp(42), Gravity.TOP | Gravity.END);
        dLp.topMargin = dp(52);
        dLp.rightMargin = dp(12);
        addView(floatingD, dLp);

        floatingD.setOnTouchListener((v, e) -> {
            switch (e.getActionMasked()) {
                case MotionEvent.ACTION_DOWN:
                    dragDownX = e.getRawX();
                    dragDownY = e.getRawY();
                    btnStartX = v.getX();
                    btnStartY = v.getY();
                    dragged = false;
                    return true;
                case MotionEvent.ACTION_MOVE:
                    float dx = e.getRawX() - dragDownX;
                    float dy = e.getRawY() - dragDownY;
                    if (Math.hypot(dx, dy) > dp(7)) dragged = true;
                    if (dragged) {
                        float maxX = Math.max(0, getWidth() - v.getWidth());
                        float maxY = Math.max(0, getHeight() - v.getHeight());
                        v.setX(Math.max(0, Math.min(maxX, btnStartX + dx)));
                        v.setY(Math.max(0, Math.min(maxY, btnStartY + dy)));
                    }
                    return true;
                case MotionEvent.ACTION_UP:
                    if (!dragged) {
                        v.performHapticFeedback(HapticFeedbackConstants.VIRTUAL_KEY);
                        toggleDrawer();
                    }
                    return true;
                default:
                    return false;
            }
        });
    }

    public void setButtonVisible(boolean visible) {
        floatingD.setVisibility(visible ? View.VISIBLE : View.GONE);
        if (!visible) closeDrawer();
    }

    public boolean isDrawerOpen() {
        return drawerBackdrop.getVisibility() == View.VISIBLE;
    }

    public void toggleDrawer() {
        if (isDrawerOpen()) closeDrawer();
        else openDrawer();
    }

    public void openDrawer() {
        syncGraphicsFromPrefs();
        selectTab(activeTab);
        drawerBackdrop.setVisibility(View.VISIBLE);
    }

    public void closeDrawer() {
        drawerBackdrop.setVisibility(View.GONE);
    }

    public void onCheatConfirmed(String code) {
        showStatus("Activated: " + code);
    }

    public void shutdown() {
        autoGodMode = false;
        handler.removeCallbacks(godModeRefresher);
    }

    private void showStatus(String msg) {
        tvToastStatus.setText(msg);
    }

    private void triggerCheat(String code, String desc) {
        input.runCheat(code);
        showStatus("Sending " + desc + " (" + code + ")...");
    }

    private void syncGraphicsFromPrefs() {
        LaunchConfig c = LaunchConfig.load(getContext());
        editPreset = c.graphicsPreset;
        editScale = c.resScalePct;
        editShadows = c.shadowsLevel;
        editFps = c.fpsCap;
        editRd = c.renderDistance;
        editLowEnd = c.lowEndMode;
        editDbgDraws = c.debugDraws;
    }

    private void selectTab(int idx) {
        activeTab = idx;
        for (int i = 0; i < tabButtons.length; i++) {
            boolean sel = (i == idx);
            GradientDrawable bg = new GradientDrawable();
            bg.setColor(sel ? 0xE60070D1 : 0x55162448);
            bg.setCornerRadius(dp(10));
            bg.setStroke(dp(1), sel ? 0xFF7DD3FC : 0x3393C5FD);
            tabButtons[i].setBackground(bg);
            tabButtons[i].setTextColor(sel ? Color.WHITE : 0xFF94A3B8);
        }
        tabContent.removeAllViews();
        switch (idx) {
            case 0: buildVehiclesTab(); break;
            case 1: buildWeaponsTab(); break;
            case 2: buildPlayerFlyTab(); break;
            case 3: buildGraphicsTab(); break;
            default: buildDevTab(); break;
        }
    }

    // ==================== TAB 0: VEHICLES ====================
    private void buildVehiclesTab() {
        Context ctx = getContext();
        tabContent.addView(makeHint(ctx, "Spawns vehicles right in front of your character using GTA V's native console:"));
        String[][] vehicles = {
                {"Buzzard Attack Heli", "BUZZOFF", "#0070D1"},
                {"Pfister Comet Sports", "COMET", "#10B981"},
                {"Dewbauchee Rapid GT", "RAPIDGT", "#10B981"},
                {"PCJ-600 Superbike", "ROCKET", "#0EA5E9"},
                {"Sanchez Dirt Bike", "OFFROAD", "#F59E0B"},
                {"BMX Stunt Bike", "BANDIT", "#F59E0B"},
                {"Stunt Plane", "BARNSTORM", "#6366F1"},
                {"Duster Biplane", "FLYSPRAY", "#6366F1"},
                {"Stretch Limousine", "VINEWOOD", "#8B5CF6"},
                {"Trashmaster Truck", "TRASHED", "#64748B"},
                {"Caddy Golf Cart", "HOLEIN1", "#14B8A6"},
                {"Duke O'Death Armored", "DEATHCAR", "#EF4444"},
                {"Dodo Seaplane", "EXTINCT", "#0284C7"},
                {"Kraken Submarine", "BUBBLES", "#0284C7"}
        };
        addGridButtons(ctx, vehicles, 2);
    }

    // ==================== TAB 1: WEAPONS & COMBAT ====================
    private void buildWeaponsTab() {
        Context ctx = getContext();
        tabContent.addView(makeHint(ctx, "Weapons, armor, vehicle repair & special ammunition:"));
        String[][] actions = {
                {"Give ALL Weapons + Ammo", "TOOLUP", "#10B981"},
                {"Full Health + Armor + Repair", "TURTLE", "#0070D1"},
                {"Explosive Bullets (Bang!)", "HIGHEX", "#EF4444"},
                {"Flaming Incendiary Ammo", "INCENDIARY", "#F97316"},
                {"Explosive Melee Punches", "HOTHANDS", "#F59E0B"},
                {"Slow-Mo Aim (Dead Eye)", "DEADEYE", "#8B5CF6"},
                {"Give Parachute", "SKYDIVE", "#0EA5E9"},
                {"Recharge Special Ability", "POWERUP", "#14B8A6"}
        };
        addGridButtons(ctx, actions, 2);

        tabContent.addView(makeHint(ctx, "Quick-load Sandbox Mode (starts free roam with every gun unlocked):"));
        LinearLayout sbRow = new LinearLayout(ctx);
        sbRow.setOrientation(LinearLayout.HORIZONTAL);
        sbRow.addView(makeFullBtn(ctx, "SANDBOX · GTA V MAP", 0xFF0070D1, () -> {
            closeDrawer();
            if (callback != null) callback.onReloadGameWithNewGraphics("sandbox5");
        }), new LinearLayout.LayoutParams(0, dp(38), 1f));
        View gap = new View(ctx);
        sbRow.addView(gap, new LinearLayout.LayoutParams(dp(8), 1));
        sbRow.addView(makeFullBtn(ctx, "SANDBOX · GTA VI MAP", 0xFF0EA5E9, () -> {
            closeDrawer();
            if (callback != null) callback.onReloadGameWithNewGraphics("sandbox6");
        }), new LinearLayout.LayoutParams(0, dp(38), 1f));
        tabContent.addView(sbRow);
    }

    // ==================== TAB 2: PLAYER, FLY & WORLD ====================
    private void buildPlayerFlyTab() {
        Context ctx = getContext();

        // Permanent God Mode toggle
        LinearLayout godRow = new LinearLayout(ctx);
        godRow.setOrientation(LinearLayout.HORIZONTAL);
        godRow.setGravity(Gravity.CENTER_VERTICAL);
        godRow.setPadding(dp(10), dp(7), dp(10), dp(7));
        GradientDrawable gBg = new GradientDrawable();
        gBg.setColor(0x5512244A);
        gBg.setCornerRadius(dp(12));
        godRow.setBackground(gBg);
        TextView gTxt = new TextView(ctx);
        gTxt.setText("God Mode Auto-Renew (Re-applies Invincibility)");
        gTxt.setTextColor(Color.WHITE);
        gTxt.setTextSize(11.5f);
        gTxt.setTypeface(Typeface.SANS_SERIF, Typeface.BOLD);
        godRow.addView(gTxt, new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f));
        PremiumToggleSwitch swGod = new PremiumToggleSwitch(ctx);
        swGod.setChecked(autoGodMode, false);
        swGod.setOnCheckedChangeListener(on -> {
            autoGodMode = on;
            handler.removeCallbacks(godModeRefresher);
            if (on) {
                triggerCheat("PAINKILLER", "God Mode");
                handler.postDelayed(godModeRefresher, 270_000L);
            } else {
                showStatus("Auto-renew paused");
            }
        });
        godRow.addView(swGod, new LinearLayout.LayoutParams(dp(50), dp(26)));
        LinearLayout.LayoutParams glp = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        glp.bottomMargin = dp(8);
        tabContent.addView(godRow, glp);

        // Fly Combo row
        LinearLayout flyRow = new LinearLayout(ctx);
        flyRow.setOrientation(LinearLayout.HORIZONTAL);
        flyRow.addView(makeFullBtn(ctx, "✈ FREE FLY / SKYFALL", 0xFF0284C7, () -> {
            triggerCheat("SKYFALL", "Skyfall Fly");
            if (callback != null) callback.onSwitchToFlyHud();
        }), new LinearLayout.LayoutParams(0, dp(38), 1f));
        flyRow.addView(new View(ctx), new LinearLayout.LayoutParams(dp(6), 1));
        flyRow.addView(makeFullBtn(ctx, "⚡ SUPER-JUMP + FLOAT FLY", 0xFF7C3AED, () -> {
            triggerCheat("HOPTOIT", "Super Jump");
            triggerCheat("FLOATER", "Moon Gravity");
        }), new LinearLayout.LayoutParams(0, dp(38), 1f));
        LinearLayout.LayoutParams flp = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        flp.bottomMargin = dp(8);
        tabContent.addView(flyRow, flp);

        String[][] cheats = {
                {"God Mode (5 min)", "PAINKILLER", "#10B981"},
                {"Clear Wanted Level", "LAWYERUP", "#0070D1"},
                {"Raise Wanted Level", "FUGITIVE", "#EF4444"},
                {"Super Jump", "HOPTOIT", "#8B5CF6"},
                {"Moon Gravity Float", "FLOATER", "#0EA5E9"},
                {"Fast Run", "CATCHME", "#14B8A6"},
                {"Fast Swim", "GOTGILLS", "#0284C7"},
                {"Slippery Drift Cars", "SNOWDAY", "#F59E0B"},
                {"Slow Motion", "SLOWMO", "#6366F1"},
                {"Cycle Weather", "MAKEITRAIN", "#3B82F6"},
                {"Drunk Mode", "LIQUOR", "#EC4899"},
                {"Give Parachute", "SKYDIVE", "#64748B"}
        };
        addGridButtons(ctx, cheats, 2);
    }

    // ==================== TAB 3: GRAPHICS & RENDER DISTANCE ====================
    private void buildGraphicsTab() {
        Context ctx = getContext();
        tabContent.addView(makeHint(ctx, "⚡ Ultra Optimize Engine — forces GTA V onto low-RAM / low-VRAM Android phones:"));

        LinearLayout ultraRow = new LinearLayout(ctx);
        ultraRow.setOrientation(LinearLayout.HORIZONTAL);
        LinearLayout.LayoutParams ulp = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, dp(36));
        ulp.bottomMargin = dp(8);
        ultraRow.addView(makeFullBtn(ctx, "⚡ ULTRA 360p", 0xFF059669, () -> {
            LaunchConfig.saveUltraOptimize(getContext(), true, LaunchConfig.ULTRA_BALANCED);
            closeDrawer();
            if (callback != null) callback.onReloadGameWithNewGraphics(null);
        }), new LinearLayout.LayoutParams(0, dp(36), 1f));
        ultraRow.addView(new View(ctx), new LinearLayout.LayoutParams(dp(5), 1));
        ultraRow.addView(makeFullBtn(ctx, "🔥 EXTREME 270p", 0xFFD97706, () -> {
            LaunchConfig.activateEmergencyUltraExtreme(getContext());
            closeDrawer();
            if (callback != null) callback.onReloadGameWithNewGraphics(null);
        }), new LinearLayout.LayoutParams(0, dp(36), 1f));
        ultraRow.addView(new View(ctx), new LinearLayout.LayoutParams(dp(5), 1));
        ultraRow.addView(makeFullBtn(ctx, "⚡ FLUSH RAM", 0xFF0F766E, () -> {
            if (callback != null) callback.onTriggerMemoryTrim();
            showStatus("⚡ Flushed GPU BindGroups & IO RAM Cache!");
        }), new LinearLayout.LayoutParams(0, dp(36), 1f));
        tabContent.addView(ultraRow, ulp);

        tabContent.addView(makeHint(ctx, "Real RAGE Engine overrides — unlocks lower graphics below GTA V's menu limit:"));

        // Presets
        LinearLayout pRow = new LinearLayout(ctx);
        pRow.setOrientation(LinearLayout.HORIZONTAL);
        for (int i = 0; i < 5; i++) {
            final int idx = i;
            boolean sel = (idx == editPreset);
            TextView tv = makeChip(ctx, LaunchConfig.PRESET_SHORT[i], sel ? 0xFF0070D1 : 0xFF1E293B, () -> {
                editPreset = idx;
                editScale = LaunchConfig.defaultScaleForPreset(idx);
                editShadows = LaunchConfig.defaultShadowsForPreset(idx);
                if (idx <= LaunchConfig.PRESET_ULTRA_LOW) {
                    editLowEnd = true;
                    editFps = 30;
                }
                buildGraphicsRefresh();
            });
            tv.setGravity(Gravity.CENTER);
            LinearLayout.LayoutParams lp = new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f);
            lp.leftMargin = i == 0 ? 0 : dp(4);
            pRow.addView(tv, lp);
        }
        tabContent.addView(pRow);

        // Resolution Scale
        TextView tvScale = makeHint(ctx, "Resolution Scale: " + editScale + "% (Lower = huge FPS boost on mobile)");
        tabContent.addView(tvScale);
        SeekBar sbScale = new SeekBar(ctx);
        sbScale.setMax(65); // 35..100
        sbScale.setProgress(Math.max(0, editScale - 35));
        sbScale.setOnSeekBarChangeListener(new SeekBar.OnSeekBarChangeListener() {
            @Override public void onProgressChanged(SeekBar s, int p, boolean fromUser) {
                editScale = 35 + p;
                tvScale.setText("Resolution Scale: " + editScale + "% (Lower = huge FPS boost on mobile)");
            }
            @Override public void onStartTrackingTouch(SeekBar s) {}
            @Override public void onStopTrackingTouch(SeekBar s) {}
        });
        tabContent.addView(sbScale);

        // Render Distance
        LinearLayout rdHdr = new LinearLayout(ctx);
        rdHdr.setOrientation(LinearLayout.HORIZONTAL);
        rdHdr.setGravity(Gravity.CENTER_VERTICAL);
        TextView tvRd = makeHint(ctx, "Render Distance: " + (editRd < 0 ? "DEFAULT (Engine Default)" : (editRd + " / 100")));
        rdHdr.addView(tvRd, new LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f));
        rdHdr.addView(makeChip(ctx, "DEFAULT", 0xFF1E3A8A, () -> {
            editRd = -1;
            buildGraphicsRefresh();
        }));
        tabContent.addView(rdHdr);

        SeekBar sbRd = new SeekBar(ctx);
        sbRd.setMax(100);
        sbRd.setProgress(editRd < 0 ? 50 : editRd);
        sbRd.setOnSeekBarChangeListener(new SeekBar.OnSeekBarChangeListener() {
            @Override public void onProgressChanged(SeekBar s, int p, boolean fromUser) {
                if (!fromUser) return;
                editRd = p;
                tvRd.setText("Render Distance: " + editRd + " / 100 (LOD " + (editRd / 100f) + ")");
            }
            @Override public void onStartTrackingTouch(SeekBar s) {}
            @Override public void onStopTrackingTouch(SeekBar s) {}
        });
        tabContent.addView(sbRd);

        // Shadows + FPS quick cyclers
        LinearLayout sfRow = new LinearLayout(ctx);
        sfRow.setOrientation(LinearLayout.HORIZONTAL);
        sfRow.setPadding(0, dp(6), 0, dp(8));
        String shLabel = editShadows < 0 ? "SHADOWS: OFF (-1)" : (editShadows == 0 ? "SHADOWS: LOWEST" : "SHADOWS: LVL " + editShadows);
        sfRow.addView(makeFullBtn(ctx, shLabel, 0xFF1E293B, () -> {
            editShadows = (editShadows >= 2) ? -1 : (editShadows + 1);
            buildGraphicsRefresh();
        }), new LinearLayout.LayoutParams(0, dp(36), 1f));
        sfRow.addView(new View(ctx), new LinearLayout.LayoutParams(dp(6), 1));
        String fpsLabel = editFps == 0 ? "FPS CAP: UNCAPPED" : ("FPS CAP: " + editFps);
        sfRow.addView(makeFullBtn(ctx, fpsLabel, 0xFF1E293B, () -> {
            editFps = (editFps == 30) ? 60 : (editFps == 60 ? 0 : 30);
            buildGraphicsRefresh();
        }), new LinearLayout.LayoutParams(0, dp(36), 1f));
        tabContent.addView(sfRow);

        // Apply & Reload
        tabContent.addView(makeFullBtn(ctx, "✓ APPLY GRAPHICS & RELOAD ENGINE", 0xFF0070D1, () -> {
            LaunchConfig.saveAdvancedGraphics(getContext(), editPreset, editScale, editShadows, editFps, editRd, editLowEnd, editDbgDraws);
            closeDrawer();
            if (callback != null) callback.onReloadGameWithNewGraphics(null);
        }), new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(42)));
    }

    private void buildGraphicsRefresh() {
        tabContent.removeAllViews();
        buildGraphicsTab();
    }

    // ==================== TAB 4: DEV / CONSOLE ====================
    private void buildDevTab() {
        Context ctx = getContext();
        tabContent.addView(makeHint(ctx, "Run any GTA V PC Console Cheat directly (e.g. BUZZOFF, TOOLUP, PAINKILLER, SKYFALL):"));

        LinearLayout cmdRow = new LinearLayout(ctx);
        cmdRow.setOrientation(LinearLayout.HORIZONTAL);
        cmdRow.setGravity(Gravity.CENTER_VERTICAL);

        EditText et = new EditText(ctx);
        et.setHint("Type cheat code...");
        et.setHintTextColor(0xFF64748B);
        et.setTextColor(Color.WHITE);
        et.setTextSize(12.5f);
        et.setSingleLine(true);
        et.setInputType(InputType.TYPE_CLASS_TEXT | InputType.TYPE_TEXT_FLAG_CAP_CHARACTERS);
        GradientDrawable etBg = new GradientDrawable();
        etBg.setColor(0x88101C3B);
        etBg.setCornerRadius(dp(10));
        etBg.setStroke(dp(1), 0x5560A5FA);
        et.setBackground(etBg);
        et.setPadding(dp(10), dp(8), dp(10), dp(8));
        cmdRow.addView(et, new LinearLayout.LayoutParams(0, dp(38), 1f));

        View gap = new View(ctx);
        cmdRow.addView(gap, new LinearLayout.LayoutParams(dp(8), 1));
        cmdRow.addView(makeFullBtn(ctx, "RUN", 0xFF10B981, () -> {
            String code = et.getText().toString().trim();
            if (!code.isEmpty()) {
                triggerCheat(code, code);
                et.setText("");
            }
        }), new LinearLayout.LayoutParams(dp(74), dp(38)));

        LinearLayout.LayoutParams clp = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        clp.bottomMargin = dp(10);
        tabContent.addView(cmdRow, clp);

        LinearLayout toolsRow = new LinearLayout(ctx);
        toolsRow.setOrientation(LinearLayout.HORIZONTAL);
        toolsRow.addView(makeFullBtn(ctx, "TOGGLE STATS HUD", 0xFF0070D1, () -> {
            if (callback != null) callback.onToggleStatsQuick();
            showStatus("Toggled Hardware Stats HUD");
        }), new LinearLayout.LayoutParams(0, dp(38), 1f));
        toolsRow.addView(new View(ctx), new LinearLayout.LayoutParams(dp(6), 1));
        toolsRow.addView(makeFullBtn(ctx, editDbgDraws ? "DBG DRAWS: ON" : "DBG DRAWS: OFF", 0xFF475569, () -> {
            editDbgDraws = !editDbgDraws;
            LaunchConfig.saveAdvancedGraphics(getContext(), editPreset, editScale, editShadows, editFps, editRd, editLowEnd, editDbgDraws);
            tabContent.removeAllViews();
            buildDevTab();
            showStatus("Debug Draw Panel (?dbg=1) " + (editDbgDraws ? "ON (reload to apply)" : "OFF"));
        }), new LinearLayout.LayoutParams(0, dp(38), 1f));
        LinearLayout.LayoutParams tlp = new LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
        tlp.bottomMargin = dp(8);
        tabContent.addView(toolsRow, tlp);

        tabContent.addView(makeFullBtn(ctx, "⟵ RETURN TO PS5 HOME SCREEN", 0xFFB91C1C, () -> {
            closeDrawer();
            if (callback != null) callback.onReturnToPs5Home();
        }), new LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, dp(40)));
    }

    private void addGridButtons(Context ctx, String[][] items, int cols) {
        LinearLayout row = null;
        for (int i = 0; i < items.length; i++) {
            if (i % cols == 0) {
                row = new LinearLayout(ctx);
                row.setOrientation(LinearLayout.HORIZONTAL);
                LinearLayout.LayoutParams rlp = new LinearLayout.LayoutParams(
                        LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.WRAP_CONTENT);
                rlp.bottomMargin = dp(6);
                tabContent.addView(row, rlp);
            }
            final String title = items[i][0];
            final String code = items[i][1];
            final int col = Color.parseColor(items[i][2]);
            TextView btn = makeFullBtn(ctx, title, col, () -> triggerCheat(code, title));
            LinearLayout.LayoutParams blp = new LinearLayout.LayoutParams(0, dp(38), 1f);
            if (i % cols > 0) blp.leftMargin = dp(6);
            row.addView(btn, blp);
        }
    }

    private TextView makeHint(Context ctx, String text) {
        TextView tv = new TextView(ctx);
        tv.setText(text);
        tv.setTextColor(0xFF94A3B8);
        tv.setTextSize(10.5f);
        tv.setPadding(0, dp(4), 0, dp(6));
        return tv;
    }

    private TextView makeFullBtn(Context ctx, String label, int accent, Runnable onClick) {
        TextView tv = new TextView(ctx);
        tv.setText(label);
        tv.setTextColor(Color.WHITE);
        tv.setTextSize(11f);
        tv.setTypeface(Typeface.SANS_SERIF, Typeface.BOLD);
        tv.setGravity(Gravity.CENTER);
        tv.setPadding(dp(8), dp(4), dp(8), dp(4));
        GradientDrawable bg = new GradientDrawable();
        bg.setColor((0xB8 << 24) | (accent & 0x00FFFFFF));
        bg.setCornerRadius(dp(11));
        bg.setStroke(dp(1), 0x55FFFFFF);
        tv.setBackground(bg);
        tv.setOnClickListener(v -> {
            v.performHapticFeedback(HapticFeedbackConstants.VIRTUAL_KEY);
            if (onClick != null) onClick.run();
        });
        return tv;
    }

    private TextView makeChip(Context ctx, String label, int bgCol, Runnable onClick) {
        TextView tv = new TextView(ctx);
        tv.setText(label);
        tv.setTextColor(Color.WHITE);
        tv.setTextSize(10.5f);
        tv.setTypeface(Typeface.SANS_SERIF, Typeface.BOLD);
        tv.setPadding(dp(10), dp(6), dp(10), dp(6));
        GradientDrawable bg = new GradientDrawable();
        bg.setColor(bgCol);
        bg.setCornerRadius(dp(12));
        bg.setStroke(dp(1), 0x55FFFFFF);
        tv.setBackground(bg);
        tv.setOnClickListener(v -> {
            v.performHapticFeedback(HapticFeedbackConstants.VIRTUAL_KEY);
            if (onClick != null) onClick.run();
        });
        return tv;
    }

    private int dp(int v) {
        return Math.round(v * getResources().getDisplayMetrics().density);
    }
}
