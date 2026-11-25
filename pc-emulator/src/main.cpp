#define NOMINMAX
#define WIN32_LEAN_AND_MEAN

#include <windows.h>
#include <windowsx.h>
#include <dwmapi.h>
#include <d3d11.h>
#include <dxgi.h>

#include "imgui.h"
#include "imgui_impl_win32.h"
#include "imgui_impl_dx11.h"

#include "sound_engine.h"
#include "particles.h"
#include "launcher.h"
#include "ui_draw.h"

#include <algorithm>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <ctime>
#include <string>
#include <vector>

#ifndef DWMWA_USE_IMMERSIVE_DARK_MODE
#define DWMWA_USE_IMMERSIVE_DARK_MODE 20
#endif
#ifndef DWMWA_WINDOW_CORNER_PREFERENCE
#define DWMWA_WINDOW_CORNER_PREFERENCE 33
#endif
#ifndef DWMWCP_ROUND
#define DWMWCP_ROUND 2
#endif

#define IDI_APP_ICON 101

extern IMGUI_IMPL_API LRESULT ImGui_ImplWin32_WndProcHandler(HWND hWnd, UINT msg, WPARAM wParam, LPARAM lParam);

using namespace vicebox;

// ==================== DIRECT3D 11 STATE ====================
static ID3D11Device*            g_pd3dDevice = nullptr;
static ID3D11DeviceContext*     g_pd3dDeviceContext = nullptr;
static IDXGISwapChain*          g_pSwapChain = nullptr;
static ID3D11RenderTargetView*  g_mainRenderTargetView = nullptr;
static UINT                     g_ResizeWidth = 0;
static UINT                     g_ResizeHeight = 0;
static HWND                     g_hWnd = nullptr;

// Header interactive hit regions (screen-client coords updated each frame for WM_NCHITTEST)
static constexpr int kHeaderHeight = 54;
static float g_NavLeftX = 320.0f;
static float g_NavRightX = 760.0f;
static float g_RightControlsMinX = 860.0f;

static void CreateRenderTarget() {
    ID3D11Texture2D* pBackBuffer = nullptr;
    if (SUCCEEDED(g_pSwapChain->GetBuffer(0, IID_PPV_ARGS(&pBackBuffer))) && pBackBuffer) {
        g_pd3dDevice->CreateRenderTargetView(pBackBuffer, nullptr, &g_mainRenderTargetView);
        pBackBuffer->Release();
    }
}

static void CleanupRenderTarget() {
    if (g_mainRenderTargetView) {
        g_mainRenderTargetView->Release();
        g_mainRenderTargetView = nullptr;
    }
}

static bool CreateDeviceD3D(HWND hWnd, std::string& outGpuName) {
    DXGI_SWAP_CHAIN_DESC sd{};
    sd.BufferCount = 2;
    sd.BufferDesc.Width = 0;
    sd.BufferDesc.Height = 0;
    sd.BufferDesc.Format = DXGI_FORMAT_R8G8B8A8_UNORM;
    sd.BufferDesc.RefreshRate.Numerator = 60;
    sd.BufferDesc.RefreshRate.Denominator = 1;
    sd.Flags = DXGI_SWAP_CHAIN_FLAG_ALLOW_MODE_SWITCH;
    sd.BufferUsage = DXGI_USAGE_RENDER_TARGET_OUTPUT;
    sd.OutputWindow = hWnd;
    sd.SampleDesc.Count = 1;
    sd.SampleDesc.Quality = 0;
    sd.Windowed = TRUE;
    sd.SwapEffect = DXGI_SWAP_EFFECT_DISCARD;

    UINT createFlags = 0;
    D3D_FEATURE_LEVEL featureLevel;
    const D3D_FEATURE_LEVEL featureLevels[2] = { D3D_FEATURE_LEVEL_11_0, D3D_FEATURE_LEVEL_10_0 };

    HRESULT res = D3D11CreateDeviceAndSwapChain(
        nullptr, D3D_DRIVER_TYPE_HARDWARE, nullptr, createFlags,
        featureLevels, 2, D3D11_SDK_VERSION,
        &sd, &g_pSwapChain, &g_pd3dDevice, &featureLevel, &g_pd3dDeviceContext);
    if (res == DXGI_ERROR_UNSUPPORTED) {
        res = D3D11CreateDeviceAndSwapChain(
            nullptr, D3D_DRIVER_TYPE_WARP, nullptr, createFlags,
            featureLevels, 2, D3D11_SDK_VERSION,
            &sd, &g_pSwapChain, &g_pd3dDevice, &featureLevel, &g_pd3dDeviceContext);
    }
    if (FAILED(res)) return false;

    // Query real PC GPU adapter description via DXGI
    IDXGIDevice* dxgiDev = nullptr;
    if (SUCCEEDED(g_pd3dDevice->QueryInterface(IID_PPV_ARGS(&dxgiDev))) && dxgiDev) {
        IDXGIAdapter* adapter = nullptr;
        if (SUCCEEDED(dxgiDev->GetAdapter(&adapter)) && adapter) {
            DXGI_ADAPTER_DESC desc{};
            if (SUCCEEDED(adapter->GetDesc(&desc))) {
                std::string name = WideToUtf8(desc.Description);
                if (!name.empty()) outGpuName = name;
            }
            adapter->Release();
        }
        dxgiDev->Release();
    }

    CreateRenderTarget();
    return true;
}

static void CleanupDeviceD3D() {
    CleanupRenderTarget();
    if (g_pSwapChain) { g_pSwapChain->Release(); g_pSwapChain = nullptr; }
    if (g_pd3dDeviceContext) { g_pd3dDeviceContext->Release(); g_pd3dDeviceContext = nullptr; }
    if (g_pd3dDevice) { g_pd3dDevice->Release(); g_pd3dDevice = nullptr; }
}

// ==================== WIN32 FRAMELESS WNDPROC ====================
static LRESULT WINAPI WndProc(HWND hWnd, UINT msg, WPARAM wParam, LPARAM lParam) {
    if (ImGui_ImplWin32_WndProcHandler(hWnd, msg, wParam, lParam))
        return true;

    switch (msg) {
        case WM_NCCALCSIZE:
            if (wParam == TRUE) {
                // Keep full client area while clamping maximized window to monitor work area
                if (IsZoomed(hWnd)) {
                    auto* params = reinterpret_cast<NCCALCSIZE_PARAMS*>(lParam);
                    HMONITOR mon = MonitorFromWindow(hWnd, MONITOR_DEFAULTTONEAREST);
                    MONITORINFO mi{};
                    mi.cbSize = sizeof(mi);
                    if (GetMonitorInfoW(mon, &mi)) {
                        params->rgrc[0] = mi.rcWork;
                    }
                }
                return 0;
            }
            break;

        case WM_GETMINMAXINFO: {
            auto* mmi = reinterpret_cast<MINMAXINFO*>(lParam);
            mmi->ptMinTrackSize.x = 960;
            mmi->ptMinTrackSize.y = 630;
            return 0;
        }

        case WM_NCHITTEST: {
            POINT pt{ GET_X_LPARAM(lParam), GET_Y_LPARAM(lParam) };
            ScreenToClient(hWnd, &pt);
            RECT rc{};
            GetClientRect(hWnd, &rc);
            const int w = rc.right - rc.left;
            const int h = rc.bottom - rc.top;
            const int border = 6;

            if (!IsZoomed(hWnd)) {
                bool left   = pt.x < border;
                bool right  = pt.x >= w - border;
                bool top    = pt.y < border;
                bool bottom = pt.y >= h - border;
                if (top && left) return HTTOPLEFT;
                if (top && right) return HTTOPRIGHT;
                if (bottom && left) return HTBOTTOMLEFT;
                if (bottom && right) return HTBOTTOMRIGHT;
                if (left) return HTLEFT;
                if (right) return HTRIGHT;
                if (top) return HTTOP;
                if (bottom) return HTBOTTOM;
            }

            // Draggable glass title bar (only outside interactive nav tabs & right controls)
            if (pt.y >= 0 && pt.y < kHeaderHeight) {
                float fx = static_cast<float>(pt.x);
                bool inNav = (fx >= g_NavLeftX && fx <= g_NavRightX);
                bool inRight = (fx >= g_RightControlsMinX);
                if (!inNav && !inRight) {
                    return HTCAPTION;
                }
            }
            return HTCLIENT;
        }

        case WM_SIZE:
            if (wParam == SIZE_MINIMIZED) return 0;
            g_ResizeWidth = static_cast<UINT>(LOWORD(lParam));
            g_ResizeHeight = static_cast<UINT>(HIWORD(lParam));
            return 0;

        case WM_SYSCOMMAND:
            if ((wParam & 0xfff0) == SC_KEYMENU) return 0;
            break;

        case WM_DESTROY:
            PostQuitMessage(0);
            return 0;
    }
    return DefWindowProcW(hWnd, msg, wParam, lParam);
}

// ==================== APPLICATION STATE ====================
enum class AppScreen { Login, Dashboard };

struct AppState {
    AppScreen screen = AppScreen::Login;
    int activeTab = 0; // 0=Emulators, 1=Engine Config, 2=Hypervisor Log

    // Login state (accepts any non-empty Gamertag + Passkey seamlessly)
    char gamertagBuf[64] = "";
    char passkeyBuf[64] = "";
    bool showPasskey = false;
    bool authenticating = false;
    float authTimer = 0.0f;
    std::string authError;
    float loginShakeT = 0.0f;
    std::string signedInUser;

    // Smooth screen & tab animation values
    float loginFade = 0.0f;
    float dashFade = 0.0f;
    float tabPillX = 0.0f;
    float tabPillW = 110.0f;
    float tabSlideAlpha = 1.0f;
    float card5Hover = 0.0f;
    float card6Hover = 0.0f;
    float btnLoginHover = 0.0f;
    float btnLaunch5Hover = 0.0f;
    float btnLocked6Hover = 0.0f;
    float gta6ShakeT = 0.0f;
    float hdrBtnHover[4] = {};

    // Toast notification
    std::string toastMsg;
    ImVec4 toastCol = Palette::VicePink;
    float toastTimer = 0.0f;
    float toastSlide = 0.0f;

    // Xbox Hypervisor Launch Sequence overlay
    bool launching = false;
    bool launchDispatched = false;
    float launchProgress = 0.0f;
    float launchOverlayAlpha = 0.0f;
    std::string launchTargetUrl;
    std::string launchViewportStatus;

    // Config, hardware, logs
    EmulatorConfig config;
    PcHardwareInfo hw;
    std::vector<std::string> logs;
    int lastInputChars = 0;

    void PushLog(const std::string& line) {
        std::time_t now = std::time(nullptr);
        std::tm tmv{};
        localtime_s(&tmv, &now);
        char ts[24];
        std::snprintf(ts, sizeof(ts), "[%02d:%02d:%02d] ", tmv.tm_hour, tmv.tm_min, tmv.tm_sec);
        logs.push_back(std::string(ts) + line);
        if (logs.size() > 120) logs.erase(logs.begin());
    }

    void ShowToast(const std::string& msg, ImVec4 accent) {
        toastMsg = msg;
        toastCol = accent;
        toastTimer = 4.2f;
    }
};

// ==================== FONT BUNDLE ====================
struct FontSet {
    ImFont* regular = nullptr;
    ImFont* bold = nullptr;
    ImFont* subtitle = nullptr;
    ImFont* title = nullptr;
    ImFont* hero = nullptr;
    ImFont* mono = nullptr;
};

static FontSet LoadSystemFonts(ImGuiIO& io) {
    FontSet fs;
    static const ImWchar kGlyphRanges[] = {
        0x0020, 0x00FF, // Basic Latin + Latin Supplement (includes middle dot)
        0x2000, 0x206F, // General Punctuation (includes em-dash, en-dash, bullet)
        0,
    };
    ImFontConfig cfg;
    cfg.OversampleH = 2;
    cfg.OversampleV = 2;
    cfg.PixelSnapH = true;

    const char* segoeReg  = "C:\\Windows\\Fonts\\segoeui.ttf";
    const char* segoeSemi = "C:\\Windows\\Fonts\\seguisb.ttf";
    const char* segoeBold = "C:\\Windows\\Fonts\\segoeuib.ttf";
    const char* consola   = "C:\\Windows\\Fonts\\consola.ttf";

    auto tryLoad = [&](const char* path, float px) -> ImFont* {
        DWORD attr = GetFileAttributesA(path);
        if (attr != INVALID_FILE_ATTRIBUTES && !(attr & FILE_ATTRIBUTE_DIRECTORY)) {
            return io.Fonts->AddFontFromFileTTF(path, px, &cfg, kGlyphRanges);
        }
        return nullptr;
    };

    fs.regular  = tryLoad(segoeReg, 16.0f);
    fs.bold     = tryLoad(segoeSemi, 16.0f);
    if (!fs.bold) fs.bold = tryLoad(segoeBold, 16.0f);
    fs.subtitle = tryLoad(segoeBold, 21.0f);
    fs.title    = tryLoad(segoeBold, 27.0f);
    fs.hero     = tryLoad(segoeBold, 34.0f);
    fs.mono     = tryLoad(consola, 14.0f);

    if (!fs.regular) fs.regular = io.Fonts->AddFontDefault();
    if (!fs.bold) fs.bold = fs.regular;
    if (!fs.subtitle) fs.subtitle = fs.bold;
    if (!fs.title) fs.title = fs.bold;
    if (!fs.hero) fs.hero = fs.title;
    if (!fs.mono) fs.mono = fs.regular;
    return fs;
}

static void ApplyCleanObsidianStyle() {
    ImGuiStyle& st = ImGui::GetStyle();
    st.WindowPadding = ImVec2(0, 0);
    st.WindowRounding = 0.0f;
    st.WindowBorderSize = 0.0f;
    st.FrameRounding = 9.0f;
    st.FramePadding = ImVec2(13.0f, 10.0f);
    st.ItemSpacing = ImVec2(10.0f, 10.0f);
    st.PopupRounding = 10.0f;
    st.GrabRounding = 8.0f;
    st.ScrollbarSize = 8.0f;
    st.ScrollbarRounding = 8.0f;

    ImVec4* c = st.Colors;
    c[ImGuiCol_WindowBg]         = ImVec4(0, 0, 0, 0);
    c[ImGuiCol_ChildBg]          = ImVec4(0, 0, 0, 0);
    c[ImGuiCol_Text]             = Palette::TextHi;
    c[ImGuiCol_TextDisabled]     = Palette::TextDim;
    c[ImGuiCol_FrameBg]          = ImVec4(0.035f, 0.048f, 0.086f, 0.92f);
    c[ImGuiCol_FrameBgHovered]   = ImVec4(0.055f, 0.075f, 0.130f, 0.96f);
    c[ImGuiCol_FrameBgActive]    = ImVec4(0.068f, 0.095f, 0.165f, 1.00f);
    c[ImGuiCol_Border]           = ImVec4(1.0f, 1.0f, 1.0f, 0.11f);
    c[ImGuiCol_CheckMark]        = Palette::Emerald;
    c[ImGuiCol_SliderGrab]       = Palette::Emerald;
    c[ImGuiCol_SliderGrabActive] = Palette::Cyan;
    c[ImGuiCol_Button]           = ImVec4(0.08f, 0.11f, 0.18f, 0.85f);
    c[ImGuiCol_ButtonHovered]    = ImVec4(0.12f, 0.17f, 0.27f, 0.95f);
    c[ImGuiCol_ButtonActive]     = ImVec4(0.10f, 0.65f, 0.42f, 0.95f);
    c[ImGuiCol_PopupBg]          = ImVec4(0.055f, 0.072f, 0.125f, 0.97f);
    c[ImGuiCol_Header]           = ImVec4(0.09f, 0.56f, 0.36f, 0.48f);
    c[ImGuiCol_HeaderHovered]    = ImVec4(0.10f, 0.72f, 0.44f, 0.65f);
    c[ImGuiCol_HeaderActive]     = ImVec4(0.10f, 0.86f, 0.48f, 0.78f);
    c[ImGuiCol_ScrollbarBg]      = ImVec4(0.03f, 0.04f, 0.07f, 0.40f);
    c[ImGuiCol_ScrollbarGrab]    = ImVec4(0.24f, 0.30f, 0.44f, 0.65f);
    c[ImGuiCol_ScrollbarGrabHovered] = ImVec4(0.12f, 0.82f, 0.50f, 0.75f);
}

// ==================== TOP FRAMELESS GLASS HEADER ====================
static void RenderHeaderBar(AppState& app, const FontSet& fonts, SoundEngine& sfx,
                            ParticleSystem& particles, float winW, float dt, float time) {
    ImDrawList* dl = ImGui::GetWindowDrawList();
    ImVec2 p0(0, 0), p1(winW, static_cast<float>(kHeaderHeight));

    // Translucent obsidian bar + hairline bottom border
    dl->AddRectFilled(p0, p1, IM_COL32(7, 10, 18, 224));
    dl->AddLine(ImVec2(0, p1.y - 1.0f), ImVec2(winW, p1.y - 1.0f), IM_COL32(255, 255, 255, 20), 1.0f);

    // Subtle neon top accent edge line across window
    dl->AddRectFilledMultiColor(
        ImVec2(0, 0), ImVec2(winW, 2.0f),
        ColAlpha(Palette::Emerald, 0.85f), ColAlpha(Palette::Cyan, 0.85f),
        ColAlpha(Palette::VicePink, 0.85f), ColAlpha(Palette::Emerald, 0.85f));

    // Left: ViceBox X Logo + Brand Title
    DrawViceBoxLogo(dl, ImVec2(28.0f, 27.0f), 13.5f, time, 1.0f);
    ImGui::PushFont(fonts.bold);
    dl->AddText(ImVec2(50.0f, 11.0f), ColAlpha(Palette::TextHi, 1.0f), "VICEBOX X");
    ImGui::PopFont();
    ImGui::PushFont(fonts.mono);
    dl->AddText(ImVec2(50.0f, 30.0f), ColAlpha(Palette::TextDim, 0.95f), "CYBERLEEKS XBSX HYPERVISOR");
    ImGui::PopFont();

    // Center Navigation Tabs (only shown when signed in to Dashboard)
    if (app.screen == AppScreen::Dashboard && app.dashFade > 0.05f) {
        const char* tabs[3] = { "EMULATORS", "ENGINE CONFIG", "HYPERVISOR LOG" };
        const float tabW[3] = { 114.0f, 134.0f, 144.0f };
        const float totalW = tabW[0] + tabW[1] + tabW[2] + 16.0f;
        const float startX = (winW - totalW) * 0.5f;
        g_NavLeftX = startX - 8.0f;
        g_NavRightX = startX + totalW + 8.0f;

        // Pill background tray
        dl->AddRectFilled(ImVec2(startX - 6.0f, 9.0f), ImVec2(startX + totalW + 6.0f, 45.0f),
                          ColAlpha(ImVec4(0.04f, 0.06f, 0.11f, 0.85f), app.dashFade), 10.0f);
        dl->AddRect(ImVec2(startX - 6.0f, 9.0f), ImVec2(startX + totalW + 6.0f, 45.0f),
                    ColAlpha(ImVec4(1, 1, 1, 0.08f), app.dashFade), 10.0f);

        float curX = startX;
        float targetX = startX;
        float targetW = tabW[0];
        for (int i = 0; i < 3; ++i) {
            if (i == app.activeTab) { targetX = curX; targetW = tabW[i]; }
            curX += tabW[i] + 8.0f;
        }
        if (app.tabPillX < 1.0f) { app.tabPillX = targetX; app.tabPillW = targetW; }
        app.tabPillX = ExpLerp(app.tabPillX, targetX, 15.0f, dt);
        app.tabPillW = ExpLerp(app.tabPillW, targetW, 15.0f, dt);

        // Sliding glowing active pill
        dl->AddRectFilled(
            ImVec2(app.tabPillX, 12.0f), ImVec2(app.tabPillX + app.tabPillW, 42.0f),
            ColAlpha(ImVec4(0.10f, 0.86f, 0.48f, 0.16f), app.dashFade), 8.0f);
        dl->AddRect(
            ImVec2(app.tabPillX, 12.0f), ImVec2(app.tabPillX + app.tabPillW, 42.0f),
            ColAlpha(Palette::Emerald, 0.48f * app.dashFade), 8.0f);
        dl->AddLine(
            ImVec2(app.tabPillX + 14.0f, 42.0f), ImVec2(app.tabPillX + app.tabPillW - 14.0f, 42.0f),
            ColAlpha(Palette::Emerald, 0.95f * app.dashFade), 2.0f);

        curX = startX;
        ImGui::PushFont(fonts.bold);
        for (int i = 0; i < 3; ++i) {
            ImGui::SetCursorPos(ImVec2(curX, 12.0f));
            char tid[32];
            std::snprintf(tid, sizeof(tid), "##nav_%d", i);
            if (ImGui::InvisibleButton(tid, ImVec2(tabW[i], 30.0f))) {
                if (app.activeTab != i) {
                    app.activeTab = i;
                    app.tabSlideAlpha = 0.0f;
                    sfx.Play(SfxId::TabSwitch, 0.85f);
                    particles.EmitBurst(ImVec2(curX + tabW[i] * 0.5f, 27.0f), 10, Palette::Emerald, Palette::Cyan);
                }
            }
            bool hov = ImGui::IsItemHovered();
            ImVec2 ts = ImGui::CalcTextSize(tabs[i]);
            ImVec4 tcol = (app.activeTab == i) ? Palette::TextHi : (hov ? ImVec4(0.84f, 0.90f, 0.96f, 1.0f) : Palette::TextMid);
            dl->AddText(ImVec2(curX + (tabW[i] - ts.x) * 0.5f, 12.0f + (30.0f - ts.y) * 0.5f),
                        ColAlpha(tcol, app.dashFade), tabs[i]);
            curX += tabW[i] + 8.0f;
        }
        ImGui::PopFont();
    } else {
        g_NavLeftX = -10.0f;
        g_NavRightX = -10.0f;
    }

    // Right Controls: Signed-in Gamertag Pill + Audio Toggle + Min / Max / Close
    float rightX = winW - 14.0f;

    auto drawWinBtn = [&](const char* id, int idx, float btnW, ImVec4 hoverCol, auto drawIcon) -> bool {
        rightX -= btnW;
        ImVec2 bp(rightX, 12.0f);
        ImGui::SetCursorPos(bp);
        bool clicked = ImGui::InvisibleButton(id, ImVec2(btnW, 30.0f));
        bool hov = ImGui::IsItemHovered();
        app.hdrBtnHover[idx] = ExpLerp(app.hdrBtnHover[idx], hov ? 1.0f : 0.0f, 16.0f, dt);
        if (app.hdrBtnHover[idx] > 0.01f) {
            dl->AddRectFilled(bp, ImVec2(bp.x + btnW, bp.y + 30.0f),
                              ColAlpha(hoverCol, 0.85f * app.hdrBtnHover[idx]), 7.0f);
        }
        drawIcon(ImVec2(bp.x + btnW * 0.5f, bp.y + 15.0f),
                 ColAlpha(LerpColor(Palette::TextMid, Palette::TextHi, app.hdrBtnHover[idx]), 1.0f));
        rightX -= 4.0f;
        return clicked;
    };

    // Close button
    if (drawWinBtn("##win_close", 0, 34.0f, ImVec4(0.88f, 0.16f, 0.28f, 1.0f),
                   [&](ImVec2 c, ImU32 col) {
                       dl->AddLine(ImVec2(c.x - 4.5f, c.y - 4.5f), ImVec2(c.x + 4.5f, c.y + 4.5f), col, 1.6f);
                       dl->AddLine(ImVec2(c.x + 4.5f, c.y - 4.5f), ImVec2(c.x - 4.5f, c.y + 4.5f), col, 1.6f);
                   })) {
        PostMessageW(g_hWnd, WM_CLOSE, 0, 0);
    }

    // Maximize / Restore button
    if (drawWinBtn("##win_max", 1, 34.0f, ImVec4(0.16f, 0.22f, 0.34f, 1.0f),
                   [&](ImVec2 c, ImU32 col) {
                       dl->AddRect(ImVec2(c.x - 4.5f, c.y - 4.5f), ImVec2(c.x + 4.5f, c.y + 4.5f), col, 1.5f, 0, 1.5f);
                   })) {
        sfx.Play(SfxId::Click, 0.55f);
        ShowWindow(g_hWnd, IsZoomed(g_hWnd) ? SW_RESTORE : SW_MAXIMIZE);
    }

    // Minimize button
    if (drawWinBtn("##win_min", 2, 34.0f, ImVec4(0.16f, 0.22f, 0.34f, 1.0f),
                   [&](ImVec2 c, ImU32 col) {
                       dl->AddLine(ImVec2(c.x - 5.0f, c.y + 2.0f), ImVec2(c.x + 5.0f, c.y + 2.0f), col, 1.6f);
                   })) {
        sfx.Play(SfxId::Click, 0.55f);
        ShowWindow(g_hWnd, SW_MINIMIZE);
    }

    // SFX Mute/Unmute Toggle Chip
    rightX -= 6.0f;
    const char* sfxLbl = sfx.IsMuted() ? "SFX OFF" : "SFX ON";
    ImVec2 sfxTs = ImGui::CalcTextSize(sfxLbl);
    float sfxW = sfxTs.x + 20.0f;
    rightX -= sfxW;
    ImGui::SetCursorPos(ImVec2(rightX, 13.0f));
    if (ImGui::InvisibleButton("##sfx_toggle", ImVec2(sfxW, 28.0f))) {
        sfx.ToggleMute();
        if (!sfx.IsMuted()) sfx.Play(SfxId::Click, 0.7f);
    }
    bool sfxHov = ImGui::IsItemHovered();
    app.hdrBtnHover[3] = ExpLerp(app.hdrBtnHover[3], sfxHov ? 1.0f : 0.0f, 14.0f, dt);
    ImVec4 sfxAccent = sfx.IsMuted() ? Palette::TextDim : Palette::Cyan;
    dl->AddRectFilled(ImVec2(rightX, 13.0f), ImVec2(rightX + sfxW, 41.0f),
                      ColAlpha(ImVec4(0.07f, 0.10f, 0.17f, 0.85f + 0.12f * app.hdrBtnHover[3]), 1.0f), 8.0f);
    dl->AddRect(ImVec2(rightX, 13.0f), ImVec2(rightX + sfxW, 41.0f),
                ColAlpha(sfxAccent, 0.35f + 0.35f * app.hdrBtnHover[3]), 8.0f);
    dl->AddText(ImVec2(rightX + 10.0f, 13.0f + (28.0f - sfxTs.y) * 0.5f),
                ColAlpha(sfx.IsMuted() ? Palette::TextDim : Palette::TextHi, 1.0f), sfxLbl);

    // Signed-in Xbox Live DevKit Gamertag Pill (click to switch operator)
    if (app.screen == AppScreen::Dashboard && !app.signedInUser.empty() && app.dashFade > 0.05f) {
        rightX -= 10.0f;
        std::string badge = app.signedInUser;
        if (badge.size() > 16) badge = badge.substr(0, 15) + "..";
        ImVec2 ts = ImGui::CalcTextSize(badge.c_str());
        float bw = ts.x + 33.0f;
        rightX -= bw;
        ImVec2 badgePos(rightX, 14.0f);
        DrawStatusPill(dl, badgePos, badge.c_str(), Palette::Emerald, app.dashFade, true);
        ImGui::SetCursorPos(badgePos);
        if (ImGui::InvisibleButton("##operator_pill", ImVec2(bw, 26.0f))) {
            sfx.Play(SfxId::TabSwitch, 0.80f);
            app.screen = AppScreen::Login;
            app.loginFade = 0.0f;
            app.passkeyBuf[0] = '\0';
            app.authenticating = false;
            app.authError.clear();
            app.PushLog("[AUTH] Operator signed out");
        }
        if (ImGui::IsItemHovered()) {
            ImGui::SetTooltip("Signed in as %s — click to sign out", app.signedInUser.c_str());
        }
    }

    g_RightControlsMinX = rightX - 10.0f;
}

// ==================== SCREEN 1: AUTHENTIC OPERATOR SIGN-IN ====================
static void RenderLoginScreen(AppState& app, const FontSet& fonts, SoundEngine& sfx,
                              ParticleSystem& particles, float winW, float winH, float dt, float time) {
    app.loginFade = ExpLerp(app.loginFade, 1.0f, 6.5f, dt);
    if (app.loginShakeT > 0.0f) app.loginShakeT = std::max(0.0f, app.loginShakeT - dt * 2.8f);
    float shakeX = (app.loginShakeT > 0.0f) ? std::sin(app.loginShakeT * 38.0f) * app.loginShakeT * 12.0f : 0.0f;

    float alpha = app.loginFade;
    float slideY = (1.0f - EaseOutCubic(app.loginFade)) * 22.0f;

    const float cardW = 450.0f;
    const float cardH = 478.0f;
    ImVec2 cMin((winW - cardW) * 0.5f + shakeX, kHeaderHeight + (winH - kHeaderHeight - cardH) * 0.5f + slideY);
    ImVec2 cMax(cMin.x + cardW, cMin.y + cardH);

    ImDrawList* dl = ImGui::GetWindowDrawList();
    DrawGlassCard(dl, cMin, cMax, 18.0f, Palette::Emerald, 0.35f + 0.15f * std::sin(time * 1.4f), alpha, false);

    // Top Vice/Xbox gradient accent bar clipped inside card top
    dl->AddRectFilledMultiColor(
        ImVec2(cMin.x + 24.0f, cMin.y + 1.0f), ImVec2(cMax.x - 24.0f, cMin.y + 4.0f),
        ColAlpha(Palette::Emerald, alpha), ColAlpha(Palette::Cyan, alpha),
        ColAlpha(Palette::VicePink, alpha), ColAlpha(Palette::Emerald, alpha));

    // Centered Emblem + Title
    DrawViceBoxLogo(dl, ImVec2(cMin.x + cardW * 0.5f, cMin.y + 56.0f), 26.0f, time, alpha);

    ImGui::PushFont(fonts.title);
    const char* title = "VICEBOX X";
    ImVec2 ts = ImGui::CalcTextSize(title);
    dl->AddText(ImVec2(cMin.x + (cardW - ts.x) * 0.5f, cMin.y + 92.0f), ColAlpha(Palette::TextHi, alpha), title);
    ImGui::PopFont();

    ImGui::PushFont(fonts.mono);
    const char* sub = "XBOX SERIES X|S HYPERVISOR  //  CYBERLEEKS EDITION";
    ImVec2 ss = ImGui::CalcTextSize(sub);
    dl->AddText(ImVec2(cMin.x + (cardW - ss.x) * 0.5f, cMin.y + 124.0f), ColAlpha(Palette::Cyan, 0.85f * alpha), sub);
    ImGui::PopFont();

    // Status pill centered
    const char* gwText = "XBOX LIVE DEVKIT GATEWAY · ONLINE";
    ImVec2 gws = ImGui::CalcTextSize(gwText);
    DrawStatusPill(dl, ImVec2(cMin.x + (cardW - (gws.x + 33.0f)) * 0.5f, cMin.y + 148.0f), gwText, Palette::Emerald, alpha, true);

    if (app.authenticating) {
        // Smooth authenticating spinner transition
        app.authTimer += dt;
        ImVec2 spinC(cMin.x + cardW * 0.5f, cMin.y + 278.0f);
        DrawSpinnerRing(dl, spinC, 34.0f, 4.0f, time, Palette::Emerald, Palette::VicePink, alpha);

        const char* stage = (app.authTimer < 0.30f) ? "Verifying DevKit Keyring..."
                          : (app.authTimer < 0.62f) ? "Synchronizing Xbox Live Session..."
                                                    : "Access Granted — Entering Hypervisor...";
        ImGui::PushFont(fonts.bold);
        ImVec2 stSz = ImGui::CalcTextSize(stage);
        dl->AddText(ImVec2(cMin.x + (cardW - stSz.x) * 0.5f, cMin.y + 336.0f), ColAlpha(Palette::TextHi, alpha), stage);
        ImGui::PopFont();

        ImGui::PushFont(fonts.mono);
        std::string opLine = "OPERATOR: " + app.signedInUser;
        ImVec2 opSz = ImGui::CalcTextSize(opLine.c_str());
        dl->AddText(ImVec2(cMin.x + (cardW - opSz.x) * 0.5f, cMin.y + 364.0f), ColAlpha(Palette::Emerald, 0.90f * alpha), opLine.c_str());
        ImGui::PopFont();

        if (app.authTimer >= 0.90f) {
            app.authenticating = false;
            app.screen = AppScreen::Dashboard;
            app.dashFade = 0.0f;
            app.tabSlideAlpha = 0.0f;
            sfx.Play(SfxId::LoginSuccess, 0.90f);
            particles.EmitBurst(spinC, 28, Palette::Emerald, Palette::Cyan);
            app.PushLog("[AUTH] Operator '" + app.signedInUser + "' authenticated on Cyberleeks XBSX Gateway");
        }
        return;
    }

    // Sign-in form inputs
    const float padX = 36.0f;
    const float fieldW = cardW - padX * 2.0f;
    float y = cMin.y + 194.0f;

    ImGui::PushStyleVar(ImGuiStyleVar_Alpha, alpha);

    // Gamertag label + input
    ImGui::PushFont(fonts.bold);
    dl->AddText(ImVec2(cMin.x + padX, y), ColAlpha(Palette::TextMid, alpha), "GAMERTAG / OPERATOR ID");
    ImGui::PopFont();
    y += 24.0f;

    ImGui::SetCursorPos(ImVec2(cMin.x + padX, y));
    ImGui::SetNextItemWidth(fieldW);
    ImGui::PushStyleVar(ImGuiStyleVar_FrameBorderSize, 1.0f);
    bool enter1 = ImGui::InputTextWithHint("##gamertag", "Enter Gamertag or Access ID",
                                           app.gamertagBuf, sizeof(app.gamertagBuf),
                                           ImGuiInputTextFlags_EnterReturnsTrue);
    y += 50.0f;

    // Passkey label + input
    ImGui::PushFont(fonts.bold);
    dl->AddText(ImVec2(cMin.x + padX, y), ColAlpha(Palette::TextMid, alpha), "PASSKEY");
    ImGui::PopFont();
    y += 24.0f;

    ImGui::SetCursorPos(ImVec2(cMin.x + padX, y));
    ImGui::SetNextItemWidth(fieldW - 64.0f);
    ImGuiInputTextFlags passFlags = ImGuiInputTextFlags_EnterReturnsTrue;
    if (!app.showPasskey) passFlags |= ImGuiInputTextFlags_Password;
    bool enter2 = ImGui::InputTextWithHint("##passkey", "Enter Passkey",
                                           app.passkeyBuf, sizeof(app.passkeyBuf), passFlags);

    // Subtle keystroke feedback pip when typing
    int totalChars = static_cast<int>(std::strlen(app.gamertagBuf) + std::strlen(app.passkeyBuf));
    if (totalChars != app.lastInputChars) {
        float pitch = 0.94f + 0.12f * static_cast<float>((totalChars * 7) % 10) / 10.0f;
        sfx.Play(SfxId::KeyType, 0.55f, pitch);
        app.lastInputChars = totalChars;
    }

    ImGui::SetCursorPos(ImVec2(cMin.x + padX + fieldW - 56.0f, y));
    if (ImGui::Button(app.showPasskey ? "HIDE" : "SHOW", ImVec2(56.0f, 38.0f))) {
        app.showPasskey = !app.showPasskey;
        sfx.Play(SfxId::Click, 0.55f);
    }
    ImGui::PopStyleVar(); // FrameBorderSize
    y += 50.0f;

    // Remember Session checkbox
    ImGui::SetCursorPos(ImVec2(cMin.x + padX, y));
    if (ImGui::Checkbox("Keep DevKit Session Active", &app.config.rememberSession)) {
        sfx.Play(SfxId::Click, 0.50f);
    }
    y += 38.0f;

    // Validation inline error (if submitted empty)
    if (!app.authError.empty()) {
        ImVec2 errSz = ImGui::CalcTextSize(app.authError.c_str());
        dl->AddText(ImVec2(cMin.x + (cardW - errSz.x) * 0.5f, y - 8.0f),
                    ColAlpha(ImVec4(1.0f, 0.36f, 0.45f, 1.0f), alpha), app.authError.c_str());
    }

    // Primary Sign-In Button
    ImGui::SetCursorPos(ImVec2(cMin.x + padX, cMax.y - 78.0f));
    ImVec2 btnCenter{};
    ImGui::PushFont(fonts.bold);
    bool submit = DrawNeonButton("##btn_signin", "SIGN IN TO VICEBOX X", ImVec2(fieldW, 46.0f),
                                 Palette::EmeraldDeep, Palette::Emerald, app.btnLoginHover, dt, sfx, false, alpha, &btnCenter);
    ImGui::PopFont();

    if (submit || enter1 || enter2) {
        std::string gt(app.gamertagBuf);
        std::string pk(app.passkeyBuf);
        // Trim whitespace
        while (!gt.empty() && (gt.front() == ' ' || gt.front() == '\t')) gt.erase(gt.begin());
        while (!gt.empty() && (gt.back() == ' ' || gt.back() == '\t')) gt.pop_back();

        if (gt.empty() || pk.empty()) {
            app.authError = "Enter your Gamertag and Passkey to continue.";
            app.loginShakeT = 1.0f;
            sfx.Play(SfxId::Locked, 0.85f);
        } else {
            app.authError.clear();
            app.signedInUser = gt;
            app.config.savedGamertag = app.config.rememberSession ? gt : "";
            SaveConfig(app.config);
            app.authenticating = true;
            app.authTimer = 0.0f;
            if (enter1 || enter2) sfx.Play(SfxId::Click, 0.80f);
            particles.EmitBurst(btnCenter, 16, Palette::Emerald, Palette::Cyan);
        }
    }

    ImGui::PopStyleVar(); // Alpha
}

// ==================== TAB 0: TWO-MODE EMULATOR SELECTOR ====================
static void RenderEmulatorsTab(AppState& app, const FontSet& fonts, SoundEngine& sfx,
                               ParticleSystem& particles, float winW, float winH, float dt, float time, float alpha) {
    ImDrawList* dl = ImGui::GetWindowDrawList();
    const float marginX = std::max(34.0f, (winW - 1040.0f) * 0.5f);
    const float contentW = winW - marginX * 2.0f;
    const float topY = static_cast<float>(kHeaderHeight) + 24.0f + (1.0f - alpha) * 14.0f;

    // Hero Section Header
    ImGui::PushFont(fonts.mono);
    dl->AddText(ImVec2(marginX, topY), ColAlpha(Palette::Emerald, 0.90f * alpha),
                "XBOX SERIES X (SCARLETT) HYPERVISOR  ·  RDNA2 TRANSLATION LAYER");
    ImGui::PopFont();

    ImGui::PushFont(fonts.title);
    dl->AddText(ImVec2(marginX, topY + 20.0f), ColAlpha(Palette::TextHi, alpha), "Select Emulation Target");
    ImGui::PopFont();

    // Right-aligned live profile indicator
    ImGui::PushFont(fonts.mono);
    char profBuf[128];
    std::snprintf(profBuf, sizeof(profBuf), "PROFILE: %s  ·  %s  ·  %s",
                  kPresetNames[std::clamp(app.config.preset, 0, 4)],
                  kResQuery[std::clamp(app.config.resIndex, 0, 3)],
                  kFpsNames[std::clamp(app.config.fpsIndex, 0, 2)]);
    ImVec2 pSz = ImGui::CalcTextSize(profBuf);
    dl->AddText(ImVec2(winW - marginX - pSz.x, topY + 28.0f), ColAlpha(Palette::TextMid, alpha), profBuf);
    ImGui::PopFont();

    // Two Large Side-by-Side Emulator Cards
    const float gap = 24.0f;
    const float cardW = (contentW - gap) * 0.5f;
    const float cardsTop = topY + 66.0f;
    const float statusBarH = 50.0f;
    const float cardH = std::max(380.0f, winH - cardsTop - statusBarH - 26.0f);

    // ------------------------------------------------------------------
    // CARD 1: GTA V EMULATOR (ACTIVE / PLAYABLE)
    // ------------------------------------------------------------------
    {
        float lift = app.card5Hover * 4.5f;
        ImVec2 cMin(marginX, cardsTop - lift);
        ImVec2 cMax(cMin.x + cardW, cMin.y + cardH);

        ImVec2 mp = ImGui::GetMousePos();
        bool inCard5 = !app.launching && mp.x >= cMin.x && mp.x <= cMax.x && mp.y >= cardsTop - 6.0f && mp.y <= cardsTop + cardH;
        app.card5Hover = ExpLerp(app.card5Hover, inCard5 ? 1.0f : 0.0f, 11.0f, dt);

        DrawGlassCard(dl, cMin, cMax, 16.0f, Palette::Emerald, app.card5Hover, alpha, false);

        // Vector Los Santos Banner Art
        float bannerH = std::min(168.0f, cardH * 0.38f);
        ImVec2 bMin(cMin.x + 1.0f, cMin.y + 1.0f);
        ImVec2 bMax(cMax.x - 1.0f, cMin.y + bannerH);
        DrawGta5BannerArt(dl, bMin, bMax, time, app.card5Hover, alpha);

        // Top badges overlaid cleanly inside banner
        DrawStatusPill(dl, ImVec2(cMin.x + 18.0f, cMin.y + 16.0f), "READY · ACTIVE", Palette::Emerald, alpha, true);
        ImGui::PushFont(fonts.mono);
        const char* tag5 = "XBSX ENHANCED";
        ImVec2 t5s = ImGui::CalcTextSize(tag5);
        dl->AddText(ImVec2(cMax.x - t5s.x - 18.0f, cMin.y + 21.0f), ColAlpha(Palette::TextHi, 0.78f * alpha), tag5);
        ImGui::PopFont();

        // Card Title & Description
        float y = cMin.y + bannerH + 10.0f;
        ImGui::PushFont(fonts.title);
        dl->AddText(ImVec2(cMin.x + 22.0f, y), ColAlpha(Palette::TextHi, alpha), "GTA V EMULATOR");
        ImGui::PopFont();
        y += 33.0f;

        dl->AddText(ImVec2(cMin.x + 22.0f, y), ColAlpha(Palette::TextMid, alpha),
                    "Grand Theft Auto V — Xbox Series X RAGE Translation");
        y += 28.0f;

        // Clean Technical Specs Strip
        const char* specs5[3] = { "RAGE v1.68", "WebGPU / DX11", "playgta5.com Core" };
        float sx = cMin.x + 22.0f;
        ImGui::PushFont(fonts.mono);
        for (const char* sp : specs5) {
            ImVec2 ss = ImGui::CalcTextSize(sp);
            float pw = ss.x + 16.0f;
            dl->AddRectFilled(ImVec2(sx, y), ImVec2(sx + pw, y + 24.0f),
                              ColAlpha(ImVec4(0.10f, 0.86f, 0.48f, 0.10f), alpha), 6.0f);
            dl->AddRect(ImVec2(sx, y), ImVec2(sx + pw, y + 24.0f),
                        ColAlpha(Palette::Emerald, 0.28f * alpha), 6.0f);
            dl->AddText(ImVec2(sx + 8.0f, y + 5.0f), ColAlpha(Palette::TextHi, 0.90f * alpha), sp);
            sx += pw + 8.0f;
        }
        ImGui::PopFont();
        y += 38.0f;

        // Inline Launch Mode Selector Pills (Title / Story / Sandbox LS / Vice Map)
        ImGui::PushFont(fonts.mono);
        dl->AddText(ImVec2(cMin.x + 22.0f, y), ColAlpha(Palette::TextDim, alpha), "LAUNCH TARGET MODE");
        ImGui::PopFont();
        y += 20.0f;

        float pillGap = 6.0f;
        float pillW = (cardW - 44.0f - pillGap * 3.0f) * 0.25f;
        ImGui::PushFont(fonts.mono);
        for (int m = 0; m < 4; ++m) {
            ImVec2 pp(cMin.x + 22.0f + m * (pillW + pillGap), y);
            ImGui::SetCursorPos(pp);
            char mid[24];
            std::snprintf(mid, sizeof(mid), "##g5mode_%d", m);
            if (!app.launching && ImGui::InvisibleButton(mid, ImVec2(pillW, 28.0f))) {
                if (app.config.gta5Mode != m) {
                    app.config.gta5Mode = m;
                    SaveConfig(app.config);
                    sfx.Play(SfxId::Click, 0.65f);
                }
            }
            bool sel = (app.config.gta5Mode == m);
            bool hov = !app.launching && ImGui::IsItemHovered();
            dl->AddRectFilled(pp, ImVec2(pp.x + pillW, pp.y + 28.0f),
                              ColAlpha(sel ? ImVec4(0.10f, 0.86f, 0.48f, 0.22f)
                                           : (hov ? ImVec4(0.12f, 0.16f, 0.24f, 0.90f)
                                                  : ImVec4(0.04f, 0.06f, 0.10f, 0.85f)), alpha), 7.0f);
            dl->AddRect(pp, ImVec2(pp.x + pillW, pp.y + 28.0f),
                        ColAlpha(sel ? Palette::Emerald : ImVec4(1, 1, 1, hov ? 0.22f : 0.09f), alpha), 7.0f);

            const char* shortLbl[4] = { "TITLE", "STORY", "SANDBOX", "VICE MAP" };
            ImVec2 ls = ImGui::CalcTextSize(shortLbl[m]);
            dl->AddText(ImVec2(pp.x + (pillW - ls.x) * 0.5f, pp.y + (28.0f - ls.y) * 0.5f),
                        ColAlpha(sel ? Palette::TextHi : Palette::TextMid, alpha), shortLbl[m]);
        }
        ImGui::PopFont();

        // Full-Width Glowing Launch CTA Button
        ImGui::SetCursorPos(ImVec2(cMin.x + 22.0f, cMax.y - 68.0f));
        ImVec2 btnC{};
        ImGui::PushFont(fonts.bold);
        bool launchClicked = !app.launching && DrawNeonButton(
            "##launch_gta5", "LAUNCH GTA V EMULATOR", ImVec2(cardW - 44.0f, 46.0f),
            Palette::EmeraldDeep, Palette::Emerald, app.btnLaunch5Hover, dt, sfx, false, alpha, &btnC);
        ImGui::PopFont();

        if (launchClicked) {
            app.launchTargetUrl = BuildGta5LaunchUrl(app.config);
            app.launching = true;
            app.launchDispatched = false;
            app.launchProgress = 0.0f;
            app.launchViewportStatus.clear();
            sfx.Play(SfxId::Launch, 0.95f);
            particles.EmitBurst(btnC, 30, Palette::Emerald, Palette::Cyan);
            app.PushLog("[LAUNCH] Starting GTA V Emulator (" + std::string(kGta5Modes[app.config.gta5Mode]) + ")");
            app.PushLog("[URL] " + app.launchTargetUrl);
        }
    }

    // ------------------------------------------------------------------
    // CARD 2: GTA VI EMULATOR (CYBERLEEKS XBOX BUILD — DISABLED FOR NOW)
    // ------------------------------------------------------------------
    {
        if (app.gta6ShakeT > 0.0f) app.gta6ShakeT = std::max(0.0f, app.gta6ShakeT - dt * 3.0f);
        float shakeX = (app.gta6ShakeT > 0.0f) ? std::sin(app.gta6ShakeT * 42.0f) * app.gta6ShakeT * 8.0f : 0.0f;

        float lift = app.card6Hover * 2.5f;
        ImVec2 cMin(marginX + cardW + gap + shakeX, cardsTop - lift);
        ImVec2 cMax(cMin.x + cardW, cMin.y + cardH);

        ImVec2 mp = ImGui::GetMousePos();
        bool inCard6 = !app.launching && mp.x >= cMin.x && mp.x <= cMax.x && mp.y >= cardsTop - 6.0f && mp.y <= cardsTop + cardH;
        app.card6Hover = ExpLerp(app.card6Hover, inCard6 ? 1.0f : 0.0f, 11.0f, dt);

        DrawGlassCard(dl, cMin, cMax, 16.0f, Palette::VicePink, app.card6Hover, alpha, true);

        // Vector Vice City Neon Sunset Banner Art
        float bannerH = std::min(168.0f, cardH * 0.38f);
        ImVec2 bMin(cMin.x + 1.0f, cMin.y + 1.0f);
        ImVec2 bMax(cMax.x - 1.0f, cMin.y + bannerH);
        DrawGta6BannerArt(dl, bMin, bMax, time, app.card6Hover, alpha);

        // Top badges inside Vice banner
        DrawStatusPill(dl, ImVec2(cMin.x + 18.0f, cMin.y + 16.0f), "DISABLED · STAGING", Palette::VicePink, alpha, true);
        ImGui::PushFont(fonts.mono);
        const char* tag6 = "CYBERLEEKS XBSX";
        ImVec2 t6s = ImGui::CalcTextSize(tag6);
        dl->AddText(ImVec2(cMax.x - t6s.x - 18.0f, cMin.y + 21.0f), ColAlpha(Palette::Cyan, 0.85f * alpha), tag6);
        ImGui::PopFont();

        // Card Title & Subtitle
        float y = cMin.y + bannerH + 10.0f;
        ImGui::PushFont(fonts.title);
        dl->AddText(ImVec2(cMin.x + 22.0f, y), ColAlpha(Palette::TextHi, 0.90f * alpha), "GTA VI EMULATOR");
        ImGui::PopFont();
        y += 33.0f;

        dl->AddText(ImVec2(cMin.x + 22.0f, y), ColAlpha(Palette::TextMid, 0.90f * alpha),
                    "Grand Theft Auto VI — Cyberleeks Xbox Series X Build");
        y += 28.0f;

        // Cyberleeks Specs Strip
        const char* specs6[3] = { "RAGE9 XBSX", "Leonida / Vice", "Build CL-0.94" };
        float sx = cMin.x + 22.0f;
        ImGui::PushFont(fonts.mono);
        for (const char* sp : specs6) {
            ImVec2 ss = ImGui::CalcTextSize(sp);
            float pw = ss.x + 16.0f;
            dl->AddRectFilled(ImVec2(sx, y), ImVec2(sx + pw, y + 24.0f),
                              ColAlpha(ImVec4(1.0f, 0.20f, 0.58f, 0.11f), alpha), 6.0f);
            dl->AddRect(ImVec2(sx, y), ImVec2(sx + pw, y + 24.0f),
                        ColAlpha(Palette::VicePink, 0.30f * alpha), 6.0f);
            dl->AddText(ImVec2(sx + 8.0f, y + 5.0f), ColAlpha(Palette::TextMid, alpha), sp);
            sx += pw + 8.0f;
        }
        ImGui::PopFont();
        y += 38.0f;

        // Clean Offline Staging Notice Box
        ImVec2 boxMin(cMin.x + 22.0f, y);
        ImVec2 boxMax(cMax.x - 22.0f, cMax.y - 82.0f);
        if (boxMax.y > boxMin.y + 34.0f) {
            dl->AddRectFilled(boxMin, boxMax, ColAlpha(ImVec4(0.035f, 0.042f, 0.075f, 0.78f), alpha), 9.0f);
            dl->AddRect(boxMin, boxMax, ColAlpha(ImVec4(1.0f, 0.20f, 0.58f, 0.22f), alpha), 9.0f);
            dl->AddText(nullptr, 14.5f, ImVec2(boxMin.x + 14.0f, boxMin.y + 10.0f),
                        ColAlpha(Palette::TextMid, 0.92f * alpha),
                        "XVD DevKit partition offline. Module unlocks once Vice City\nruntime endpoint or custom GTA VI texture pack is mounted.",
                        nullptr, (boxMax.x - boxMin.x) - 24.0f);
        }

        // Disabled Lock Button
        ImGui::SetCursorPos(ImVec2(cMin.x + 22.0f, cMax.y - 68.0f));
        ImGui::PushFont(fonts.bold);
        bool lockedClick = !app.launching && DrawNeonButton(
            "##locked_gta6", "MODULE DISABLED  ·  COMING SOON", ImVec2(cardW - 44.0f, 46.0f),
            Palette::VicePink, Palette::Cyan, app.btnLocked6Hover, dt, sfx, true, alpha);
        ImGui::PopFont();

        if (lockedClick) {
            app.gta6ShakeT = 1.0f;
            app.ShowToast("GTA VI Emulator (Cyberleeks XBSX) is disabled for now — use GTA V Emulator while Vice assets are staged.", Palette::VicePink);
            app.PushLog("[XBSX-HV] GTA VI Emulator launch blocked: module disabled (awaiting Vice runtime / texture pack)");
        }
    }

    // ------------------------------------------------------------------
    // BOTTOM LIVE PC HARDWARE & HYPERVISOR TELEMETRY BAR
    // ------------------------------------------------------------------
    {
        float barY = winH - statusBarH - 14.0f;
        ImVec2 bMin(marginX, barY);
        ImVec2 bMax(winW - marginX, barY + statusBarH);
        dl->AddRectFilled(bMin, bMax, ColAlpha(ImVec4(0.048f, 0.064f, 0.112f, 0.88f), alpha), 12.0f);
        dl->AddRect(bMin, bMax, ColAlpha(ImVec4(1, 1, 1, 0.08f), alpha), 12.0f);

        // Live pulsing emerald indicator + real PC hardware telemetry
        ImVec2 dotC(bMin.x + 22.0f, bMin.y + statusBarH * 0.5f);
        float pulse = 0.55f + 0.45f * std::sin(time * 3.2f);
        dl->AddCircleFilled(dotC, 6.5f, ColAlpha(Palette::Emerald, 0.25f * pulse * alpha), 14);
        dl->AddCircleFilled(dotC, 3.2f, ColAlpha(Palette::Emerald, alpha), 12);

        ImGui::PushFont(fonts.mono);
        char hwLine[256];
        std::string gpuShort = app.hw.gpuName;
        if (gpuShort.size() > 38) gpuShort = gpuShort.substr(0, 36) + "..";
        std::snprintf(hwLine, sizeof(hwLine), "GPU: %s   |   CPU: %d THREADS   |   RAM: %.1f GB   |   UI: %.0f FPS",
                      gpuShort.c_str(), app.hw.cpuThreads, app.hw.totalRamGb, ImGui::GetIO().Framerate);
        dl->AddText(ImVec2(bMin.x + 38.0f, bMin.y + (statusBarH - 14.0f) * 0.5f),
                    ColAlpha(Palette::TextMid, alpha), hwLine);
        ImGui::PopFont();

        // Subtle animated live activity sparkline on the right of the telemetry bar
        float waveW = 86.0f;
        float waveX0 = bMax.x - waveW - 18.0f;
        float waveMidY = bMin.y + statusBarH * 0.5f;
        ImVec2 prevPt{};
        for (int i = 0; i <= 24; ++i) {
            float u = static_cast<float>(i) / 24.0f;
            float env = std::sin(u * 3.14159f);
            float yOff = (std::sin(u * 14.0f - time * 5.2f) * 0.65f + std::sin(u * 27.0f + time * 3.1f) * 0.35f) * 9.0f * env;
            ImVec2 pt(waveX0 + u * waveW, waveMidY + yOff);
            if (i > 0) {
                dl->AddLine(prevPt, pt, ColAlpha(LerpColor(Palette::Emerald, Palette::Cyan, u), 0.78f * alpha), 1.6f);
            }
            prevPt = pt;
        }
    }
}

// ==================== TAB 1: ENGINE CONFIGURATION ====================
static void RenderConfigTab(AppState& app, const FontSet& fonts, SoundEngine& sfx,
                            float winW, float winH, float alpha) {
    ImDrawList* dl = ImGui::GetWindowDrawList();
    const float marginX = std::max(34.0f, (winW - 1040.0f) * 0.5f);
    const float contentW = winW - marginX * 2.0f;
    const float topY = static_cast<float>(kHeaderHeight) + 24.0f + (1.0f - alpha) * 14.0f;

    ImGui::PushFont(fonts.mono);
    dl->AddText(ImVec2(marginX, topY), ColAlpha(Palette::Cyan, 0.90f * alpha), "RAGE RUNTIME & XBOX VIEWPORT PARAMETERS");
    ImGui::PopFont();

    ImGui::PushFont(fonts.title);
    dl->AddText(ImVec2(marginX, topY + 20.0f), ColAlpha(Palette::TextHi, alpha), "Engine Configuration");
    ImGui::PopFont();

    const float gap = 22.0f;
    const float colW = (contentW - gap) * 0.5f;
    const float cardsTop = topY + 66.0f;
    const float cardH = std::max(400.0f, winH - cardsTop - 26.0f);

    ImGui::PushStyleVar(ImGuiStyleVar_Alpha, alpha);

    // Left Glass Panel: GTA V Graphics & Performance
    {
        ImVec2 p0(marginX, cardsTop), p1(marginX + colW, cardsTop + cardH);
        DrawGlassCard(dl, p0, p1, 16.0f, Palette::Emerald, 0.20f, alpha, false);

        float x = p0.x + 24.0f;
        float w = colW - 48.0f;
        float y = p0.y + 22.0f;

        ImGui::PushFont(fonts.subtitle);
        dl->AddText(ImVec2(x, y), ColAlpha(Palette::TextHi, alpha), "GTA V Graphics & Performance");
        ImGui::PopFont();
        y += 38.0f;

        // Preset selector pills
        ImGui::PushFont(fonts.mono);
        dl->AddText(ImVec2(x, y), ColAlpha(Palette::TextMid, alpha), "GRAPHICS PRESET");
        ImGui::PopFont();
        y += 22.0f;

        float pw = (w - 24.0f) / 5.0f;
        ImGui::PushFont(fonts.mono);
        for (int i = 0; i < 5; ++i) {
            ImVec2 bp(x + i * (pw + 6.0f), y);
            ImGui::SetCursorPos(bp);
            char id[24];
            std::snprintf(id, sizeof(id), "##pre_%d", i);
            if (ImGui::InvisibleButton(id, ImVec2(pw, 30.0f))) {
                app.config.preset = i;
                if (i >= 3) app.config.shadowsIndex = 3;
                SaveConfig(app.config);
                sfx.Play(SfxId::Click, 0.65f);
            }
            bool sel = (app.config.preset == i);
            dl->AddRectFilled(bp, ImVec2(bp.x + pw, bp.y + 30.0f),
                              ColAlpha(sel ? ImVec4(0.10f, 0.86f, 0.48f, 0.24f) : ImVec4(0.04f, 0.06f, 0.10f, 0.85f), alpha), 7.0f);
            dl->AddRect(bp, ImVec2(bp.x + pw, bp.y + 30.0f),
                        ColAlpha(sel ? Palette::Emerald : ImVec4(1, 1, 1, 0.10f), alpha), 7.0f);
            ImVec2 ts = ImGui::CalcTextSize(kPresetNames[i]);
            dl->AddText(ImVec2(bp.x + (pw - ts.x) * 0.5f, bp.y + (30.0f - ts.y) * 0.5f),
                        ColAlpha(sel ? Palette::TextHi : Palette::TextMid, alpha), kPresetNames[i]);
        }
        ImGui::PopFont();
        y += 46.0f;

        // Render Resolution Combo
        ImGui::PushFont(fonts.mono);
        dl->AddText(ImVec2(x, y), ColAlpha(Palette::TextMid, alpha), "RENDER RESOLUTION");
        ImGui::PopFont();
        y += 22.0f;
        ImGui::SetCursorPos(ImVec2(x, y));
        ImGui::SetNextItemWidth(w);
        if (ImGui::Combo("##res_combo", &app.config.resIndex, kResNames, 4)) {
            SaveConfig(app.config);
            sfx.Play(SfxId::Click, 0.60f);
        }
        y += 52.0f;

        // FPS Cap Combo
        ImGui::PushFont(fonts.mono);
        dl->AddText(ImVec2(x, y), ColAlpha(Palette::TextMid, alpha), "FRAME RATE TARGET");
        ImGui::PopFont();
        y += 22.0f;
        ImGui::SetCursorPos(ImVec2(x, y));
        ImGui::SetNextItemWidth(w * 0.48f);
        if (ImGui::Combo("##fps_combo", &app.config.fpsIndex, kFpsNames, 3)) {
            SaveConfig(app.config);
            sfx.Play(SfxId::Click, 0.60f);
        }

        // Shadows Combo beside FPS
        ImGui::PushFont(fonts.mono);
        dl->AddText(ImVec2(x + w * 0.52f, y - 22.0f), ColAlpha(Palette::TextMid, alpha), "CASCADE SHADOWS");
        ImGui::PopFont();
        ImGui::SetCursorPos(ImVec2(x + w * 0.52f, y));
        ImGui::SetNextItemWidth(w * 0.48f);
        if (ImGui::Combo("##shd_combo", &app.config.shadowsIndex, kShadowNames, 4)) {
            SaveConfig(app.config);
            sfx.Play(SfxId::Click, 0.60f);
        }
        y += 56.0f;

        // Render Distance Slider (-1 = Default, 0..100)
        ImGui::PushFont(fonts.mono);
        char rdLbl[64];
        if (app.config.renderDistance < 0) std::snprintf(rdLbl, sizeof(rdLbl), "RENDER DISTANCE: ENGINE DEFAULT");
        else std::snprintf(rdLbl, sizeof(rdLbl), "RENDER DISTANCE: %d / 100", app.config.renderDistance);
        dl->AddText(ImVec2(x, y), ColAlpha(Palette::TextMid, alpha), rdLbl);
        ImGui::PopFont();
        y += 22.0f;
        ImGui::SetCursorPos(ImVec2(x, y));
        ImGui::SetNextItemWidth(w - 92.0f);
        if (ImGui::SliderInt("##rd_slider", &app.config.renderDistance, -1, 100,
                             app.config.renderDistance < 0 ? "Default" : "%d%%")) {
            SaveConfig(app.config);
        }
        ImGui::SetCursorPos(ImVec2(x + w - 82.0f, y));
        if (ImGui::Button("RESET", ImVec2(82.0f, 36.0f))) {
            app.config.renderDistance = -1;
            SaveConfig(app.config);
            sfx.Play(SfxId::Click, 0.55f);
        }
    }

    // Right Glass Panel: Viewport & GTA VI Pipeline Staging
    {
        ImVec2 p0(marginX + colW + gap, cardsTop), p1(p0.x + colW, cardsTop + cardH);
        DrawGlassCard(dl, p0, p1, 16.0f, Palette::Cyan, 0.20f, alpha, false);

        float x = p0.x + 24.0f;
        float w = colW - 48.0f;
        float y = p0.y + 22.0f;

        ImGui::PushFont(fonts.subtitle);
        dl->AddText(ImVec2(x, y), ColAlpha(Palette::TextHi, alpha), "Viewport & Future GTA VI Pipeline");
        ImGui::PopFont();
        y += 38.0f;

        ImGui::PushFont(fonts.mono);
        dl->AddText(ImVec2(x, y), ColAlpha(Palette::TextMid, alpha), "PC LAUNCH VIEWPORT");
        ImGui::PopFont();
        y += 22.0f;
        ImGui::SetCursorPos(ImVec2(x, y));
        ImGui::SetNextItemWidth(w);
        if (ImGui::Combo("##vp_combo", &app.config.viewportMode, kViewportNames, 3)) {
            SaveConfig(app.config);
            sfx.Play(SfxId::Click, 0.60f);
        }
        y += 58.0f;

        // Divider
        dl->AddLine(ImVec2(x, y), ImVec2(x + w, y), ColAlpha(ImVec4(1, 1, 1, 0.09f), alpha));
        y += 20.0f;

        // Phase 2 GTA VI Integration Preview Box
        DrawStatusPill(dl, ImVec2(x, y), "GTA VI MODULE · PHASE 2 HOOK", Palette::VicePink, alpha, true);
        y += 38.0f;

        ImGui::PushFont(fonts.mono);
        dl->AddText(ImVec2(x, y), ColAlpha(Palette::TextDim, alpha), "RUNTIME ENDPOINT (GTA VI)");
        y += 20.0f;
        dl->AddRectFilled(ImVec2(x, y), ImVec2(x + w, y + 34.0f), ColAlpha(ImVec4(0.03f, 0.04f, 0.08f, 0.85f), alpha), 8.0f);
        dl->AddRect(ImVec2(x, y), ImVec2(x + w, y + 34.0f), ColAlpha(ImVec4(1, 1, 1, 0.08f), alpha), 8.0f);
        dl->AddText(ImVec2(x + 12.0f, y + 10.0f), ColAlpha(Palette::TextDim, alpha), "[DISABLED — PENDING VICE RUNTIME]");
        y += 48.0f;

        dl->AddText(ImVec2(x, y), ColAlpha(Palette::TextDim, alpha), "CUSTOM TEXTURE PACK OVERRIDE DIR");
        y += 20.0f;
        dl->AddRectFilled(ImVec2(x, y), ImVec2(x + w, y + 34.0f), ColAlpha(ImVec4(0.03f, 0.04f, 0.08f, 0.85f), alpha), 8.0f);
        dl->AddRect(ImVec2(x, y), ImVec2(x + w, y + 34.0f), ColAlpha(ImVec4(1, 1, 1, 0.08f), alpha), 8.0f);
        dl->AddText(ImVec2(x + 12.0f, y + 10.0f), ColAlpha(Palette::Cyan, 0.85f * alpha), app.config.gta6TexturePackDir.c_str());
        ImGui::PopFont();
    }

    ImGui::PopStyleVar();
}

// ==================== TAB 2: HYPERVISOR DIAGNOSTIC LOG ====================
static void RenderLogTab(AppState& app, const FontSet& fonts, SoundEngine& sfx,
                         float winW, float winH, float alpha) {
    ImDrawList* dl = ImGui::GetWindowDrawList();
    const float marginX = std::max(34.0f, (winW - 1040.0f) * 0.5f);
    const float contentW = winW - marginX * 2.0f;
    const float topY = static_cast<float>(kHeaderHeight) + 24.0f + (1.0f - alpha) * 14.0f;

    ImGui::PushFont(fonts.mono);
    dl->AddText(ImVec2(marginX, topY), ColAlpha(Palette::Emerald, 0.90f * alpha), "REAL-TIME TELEMETRY & LAUNCH DIAGNOSTICS");
    ImGui::PopFont();

    ImGui::PushFont(fonts.title);
    dl->AddText(ImVec2(marginX, topY + 20.0f), ColAlpha(Palette::TextHi, alpha), "Hypervisor Log");
    ImGui::PopFont();

    ImGui::SetCursorPos(ImVec2(winW - marginX - 118.0f, topY + 18.0f));
    if (ImGui::Button("COPY LOG", ImVec2(118.0f, 34.0f))) {
        std::string all;
        for (const auto& l : app.logs) all += l + "\n";
        ImGui::SetClipboardText(all.c_str());
        sfx.Play(SfxId::Click, 0.70f);
        app.ShowToast("Hypervisor log copied to clipboard.", Palette::Emerald);
    }

    const float boxTop = topY + 66.0f;
    const float boxH = std::max(380.0f, winH - boxTop - 26.0f);
    ImVec2 p0(marginX, boxTop), p1(winW - marginX, boxTop + boxH);
    DrawGlassCard(dl, p0, p1, 14.0f, Palette::Cyan, 0.15f, alpha, false);

    ImGui::PushStyleVar(ImGuiStyleVar_Alpha, alpha);
    ImGui::SetCursorPos(ImVec2(p0.x + 16.0f, p0.y + 14.0f));
    ImGui::BeginChild("##log_scroll", ImVec2(contentW - 32.0f, boxH - 28.0f), false);
    ImGui::PushFont(fonts.mono);
    for (const auto& line : app.logs) {
        ImVec4 col = Palette::TextMid;
        if (line.find("[AUTH]") != std::string::npos || line.find("[LAUNCH]") != std::string::npos) col = Palette::Emerald;
        else if (line.find("[URL]") != std::string::npos) col = Palette::Cyan;
        else if (line.find("blocked") != std::string::npos) col = Palette::VicePink;
        ImGui::TextColored(col, "%s", line.c_str());
    }
    ImGui::PopFont();
    ImGui::EndChild();
    ImGui::PopStyleVar();
}

// ==================== XBOX HYPERVISOR LAUNCH OVERLAY ====================
static void RenderLaunchOverlay(AppState& app, const FontSet& fonts, SoundEngine& sfx,
                                ParticleSystem& particles, float winW, float winH, float dt, float time) {
    app.launchOverlayAlpha = ExpLerp(app.launchOverlayAlpha, app.launching ? 1.0f : 0.0f, 10.0f, dt);
    if (app.launchOverlayAlpha < 0.01f) return;

    if (app.launching) {
        app.launchProgress += dt * 0.62f;
        if (app.launchProgress >= 1.0f && !app.launchDispatched) {
            app.launchDispatched = true;
            app.launchViewportStatus = LaunchGameViewport(app.launchTargetUrl, app.config.viewportMode);
            app.PushLog("[VIEWPORT] Launched via " + app.launchViewportStatus);
            particles.EmitBurst(ImVec2(winW * 0.5f, winH * 0.5f), 26, Palette::Emerald, Palette::Cyan);
            sfx.Play(SfxId::LoginSuccess, 0.75f);
        }
        if (app.launchProgress >= 1.85f) {
            app.launching = false;
            app.ShowToast("GTA V Emulator running via " + app.launchViewportStatus, Palette::Emerald);
        }
    }

    float a = app.launchOverlayAlpha;
    ImDrawList* dl = ImGui::GetForegroundDrawList();
    dl->AddRectFilled(ImVec2(0, 0), ImVec2(winW, winH), ColAlpha(ImVec4(0.02f, 0.03f, 0.06f, 0.78f), a));

    const float bw = 470.0f, bh = 290.0f;
    ImVec2 c0((winW - bw) * 0.5f, (winH - bh) * 0.5f);
    ImVec2 c1(c0.x + bw, c0.y + bh);
    DrawGlassCard(dl, c0, c1, 18.0f, Palette::Emerald, 0.65f, a, false);

    DrawSpinnerRing(dl, ImVec2(c0.x + bw * 0.5f, c0.y + 88.0f), 36.0f, 4.2f, time, Palette::Emerald, Palette::Cyan, a);

    float p = std::clamp(app.launchProgress, 0.0f, 1.0f);
    const char* title = app.launchDispatched ? "GTA V VIEWPORT ACTIVE" : "BOOTING XBOX HYPERVISOR";
    ImGui::PushFont(fonts.subtitle);
    ImVec2 tSz = ImGui::CalcTextSize(title);
    dl->AddText(ImVec2(c0.x + (bw - tSz.x) * 0.5f, c0.y + 144.0f), ColAlpha(Palette::TextHi, a), title);
    ImGui::PopFont();

    const char* stage = (p < 0.30f) ? "Mounting XVD Virtual Disc (GTA V Enhanced)..."
                      : (p < 0.62f) ? "Initializing RDNA2 / WebGPU Pipeline & Shared Memory..."
                      : (p < 0.99f) ? "Applying Graphics Profile & Handing Off Viewport..."
                                    : "Game Window Launched — Ready to Play!";
    ImGui::PushFont(fonts.mono);
    ImVec2 sSz = ImGui::CalcTextSize(stage);
    dl->AddText(ImVec2(c0.x + (bw - sSz.x) * 0.5f, c0.y + 178.0f), ColAlpha(Palette::Emerald, 0.92f * a), stage);
    ImGui::PopFont();

    // Sleek neon progress bar
    float barW = bw - 84.0f;
    ImVec2 pb0(c0.x + 42.0f, c0.y + 218.0f);
    ImVec2 pb1(pb0.x + barW, pb0.y + 8.0f);
    dl->AddRectFilled(pb0, pb1, ColAlpha(ImVec4(1, 1, 1, 0.08f), a), 4.0f);
    float fillW = std::max(8.0f, barW * EaseOutCubic(p));
    dl->AddRectFilledMultiColor(
        pb0, ImVec2(pb0.x + fillW, pb1.y),
        ColAlpha(Palette::Emerald, a), ColAlpha(Palette::Cyan, a),
        ColAlpha(Palette::Cyan, a), ColAlpha(Palette::Emerald, a));
}

// ==================== FLOATING TOAST NOTIFICATION ====================
static void RenderToast(AppState& app, float winW, float winH, float dt) {
    if (app.toastTimer > 0.0f) {
        app.toastTimer = std::max(0.0f, app.toastTimer - dt);
    }
    app.toastSlide = ExpLerp(app.toastSlide, (app.toastTimer > 0.0f) ? 1.0f : 0.0f, 11.0f, dt);
    if (app.toastSlide < 0.01f || app.toastMsg.empty()) return;

    ImDrawList* dl = ImGui::GetForegroundDrawList();
    ImVec2 ts = ImGui::CalcTextSize(app.toastMsg.c_str());
    float tw = ts.x + 42.0f;
    float th = 40.0f;
    float y = winH - 22.0f - th * app.toastSlide;
    ImVec2 p0((winW - tw) * 0.5f, y);
    ImVec2 p1(p0.x + tw, p0.y + th);

    dl->AddRectFilled(p0, p1, ColAlpha(ImVec4(0.045f, 0.058f, 0.105f, 0.96f), app.toastSlide), 10.0f);
    dl->AddRect(p0, p1, ColAlpha(app.toastCol, 0.72f * app.toastSlide), 10.0f, 0, 1.3f);
    dl->AddCircleFilled(ImVec2(p0.x + 16.0f, p0.y + th * 0.5f), 4.0f, ColAlpha(app.toastCol, app.toastSlide), 12);
    dl->AddText(ImVec2(p0.x + 28.0f, p0.y + (th - ts.y) * 0.5f), ColAlpha(Palette::TextHi, app.toastSlide), app.toastMsg.c_str());
}

// ==================== WIN32 ENTRY POINT ====================
int WINAPI WinMain(HINSTANCE hInstance, HINSTANCE, LPSTR, int) {
    // Enable crisp Per-Monitor V2 DPI scaling on Windows 10/11
    ImGui_ImplWin32_EnableDpiAwareness();

    WNDCLASSEXW wc{};
    wc.cbSize = sizeof(wc);
    wc.style = CS_CLASSDC;
    wc.lpfnWndProc = WndProc;
    wc.hInstance = hInstance;
    wc.hIcon = LoadIconW(hInstance, MAKEINTRESOURCEW(IDI_APP_ICON));
    wc.hIconSm = wc.hIcon;
    wc.hCursor = LoadCursorW(nullptr, IDC_ARROW);
    wc.lpszClassName = L"ViceBoxXEmulatorClass";
    RegisterClassExW(&wc);

    // Center 1160 x 710 frameless window on primary monitor work area
    RECT workArea{};
    SystemParametersInfoW(SPI_GETWORKAREA, 0, &workArea, 0);
    int screenW = workArea.right - workArea.left;
    int screenH = workArea.bottom - workArea.top;
    int winW = std::min(1160, std::max(960, screenW - 80));
    int winH = std::min(710, std::max(630, screenH - 70));
    int posX = workArea.left + (screenW - winW) / 2;
    int posY = workArea.top + (screenH - winH) / 2;

    g_hWnd = CreateWindowExW(
        WS_EX_APPWINDOW,
        wc.lpszClassName,
        L"VICEBOX X — GTA VI Xbox Emulator [Cyberleeks Build]",
        WS_POPUP | WS_THICKFRAME | WS_MINIMIZEBOX | WS_MAXIMIZEBOX | WS_SYSMENU,
        posX, posY, winW, winH,
        nullptr, nullptr, hInstance, nullptr);

    if (!g_hWnd) return 1;

    // Windows 11 rounded corners + dark immersive chrome + native DWM drop shadow
    BOOL darkMode = TRUE;
    DwmSetWindowAttribute(g_hWnd, DWMWA_USE_IMMERSIVE_DARK_MODE, &darkMode, sizeof(darkMode));
    DWORD cornerPref = DWMWCP_ROUND;
    DwmSetWindowAttribute(g_hWnd, DWMWA_WINDOW_CORNER_PREFERENCE, &cornerPref, sizeof(cornerPref));
    MARGINS shadowMargins{ 1, 1, 1, 1 };
    DwmExtendFrameIntoClientArea(g_hWnd, &shadowMargins);

    AppState app;
    app.hw = QueryPcHardware();
    LoadConfig(app.config);
    if (!app.config.savedGamertag.empty()) {
        std::snprintf(app.gamertagBuf, sizeof(app.gamertagBuf), "%s", app.config.savedGamertag.c_str());
    }

    if (!CreateDeviceD3D(g_hWnd, app.hw.gpuName)) {
        CleanupDeviceD3D();
        UnregisterClassW(wc.lpszClassName, hInstance);
        return 1;
    }

    ShowWindow(g_hWnd, SW_SHOWDEFAULT);
    UpdateWindow(g_hWnd);

    // Initialize Dear ImGui + DirectX 11 + Win32 backends
    IMGUI_CHECKVERSION();
    ImGui::CreateContext();
    ImGuiIO& io = ImGui::GetIO();
    io.IniFilename = nullptr; // Keep workspace directory clean (no imgui.ini clutter)
    io.ConfigFlags |= ImGuiConfigFlags_NavEnableKeyboard;

    FontSet fonts = LoadSystemFonts(io);
    ApplyCleanObsidianStyle();

    ImGui_ImplWin32_Init(g_hWnd);
    ImGui_ImplDX11_Init(g_pd3dDevice, g_pd3dDeviceContext);

    // Initialize Procedural Console Audio + GPU Particle System
    SoundEngine sfx;
    sfx.Init();
    sfx.Play(SfxId::Startup, 0.85f);

    ParticleSystem particles;
    particles.Init(static_cast<float>(winW), static_cast<float>(winH));

    app.PushLog("[XBSX-HV] ViceBox X Hypervisor v1.0 initialized (Cyberleeks Build)");
    app.PushLog("[D3D11] Active GPU Adapter: " + app.hw.gpuName);
    app.PushLog("[SYS] Host CPU: " + std::to_string(app.hw.cpuThreads) + " threads | RAM: "
                + std::to_string(static_cast<int>(std::round(app.hw.totalRamGb))) + " GB");
    app.PushLog("[AUDIO] 44.1 kHz polyphonic console SFX synthesizer online");
    app.PushLog("[XBSX-HV] GTA V Emulator target: READY | GTA VI Emulator target: DISABLED");

    auto prevClock = std::chrono::steady_clock::now();
    float elapsedTime = 0.0f;
    bool running = true;

    while (running) {
        MSG msg{};
        while (PeekMessageW(&msg, nullptr, 0U, 0U, PM_REMOVE)) {
            TranslateMessage(&msg);
            DispatchMessageW(&msg);
            if (msg.message == WM_QUIT) running = false;
        }
        if (!running) break;

        if (g_ResizeWidth != 0 && g_ResizeHeight != 0) {
            CleanupRenderTarget();
            g_pSwapChain->ResizeBuffers(0, g_ResizeWidth, g_ResizeHeight, DXGI_FORMAT_UNKNOWN, 0);
            g_ResizeWidth = g_ResizeHeight = 0;
            CreateRenderTarget();
        }

        auto nowClock = std::chrono::steady_clock::now();
        float dt = std::chrono::duration<float>(nowClock - prevClock).count();
        prevClock = nowClock;
        dt = std::clamp(dt, 0.001f, 0.05f);
        elapsedTime += dt;

        ImGui_ImplDX11_NewFrame();
        ImGui_ImplWin32_NewFrame();
        ImGui::NewFrame();

        const ImVec2 disp = io.DisplaySize;

        // 1. Render GPU Aurora + Interactive Multi-Depth Background Particles
        particles.UpdateAndRender(ImGui::GetBackgroundDrawList(), ImVec2(0, 0), disp, io.MousePos, dt, elapsedTime);

        // 2. Full-Viewport Borderless Host Window
        ImGui::SetNextWindowPos(ImVec2(0, 0));
        ImGui::SetNextWindowSize(disp);
        ImGui::Begin("##ViceBoxRoot", nullptr,
                     ImGuiWindowFlags_NoDecoration | ImGuiWindowFlags_NoMove |
                     ImGuiWindowFlags_NoResize | ImGuiWindowFlags_NoSavedSettings |
                     ImGuiWindowFlags_NoBackground | ImGuiWindowFlags_NoBringToFrontOnFocus);

        RenderHeaderBar(app, fonts, sfx, particles, disp.x, dt, elapsedTime);

        if (app.screen == AppScreen::Login) {
            RenderLoginScreen(app, fonts, sfx, particles, disp.x, disp.y, dt, elapsedTime);
        } else {
            app.dashFade = ExpLerp(app.dashFade, 1.0f, 7.5f, dt);
            app.tabSlideAlpha = ExpLerp(app.tabSlideAlpha, 1.0f, 10.5f, dt);
            float combinedA = app.dashFade * app.tabSlideAlpha;

            if (app.activeTab == 0) {
                RenderEmulatorsTab(app, fonts, sfx, particles, disp.x, disp.y, dt, elapsedTime, combinedA);
            } else if (app.activeTab == 1) {
                RenderConfigTab(app, fonts, sfx, disp.x, disp.y, combinedA);
            } else {
                RenderLogTab(app, fonts, sfx, disp.x, disp.y, combinedA);
            }
        }

        // Subtle outer border around the frameless window so it pops crisply on dark desktops
        ImGui::GetForegroundDrawList()->AddRect(
            ImVec2(0.5f, 0.5f), ImVec2(disp.x - 0.5f, disp.y - 0.5f),
            IM_COL32(255, 255, 255, 24), 8.0f, 0, 1.0f);

        ImGui::End();

        // Modal overlays & floating toasts
        RenderLaunchOverlay(app, fonts, sfx, particles, disp.x, disp.y, dt, elapsedTime);
        RenderToast(app, disp.x, disp.y, dt);

        // Render DirectX 11 frame with VSync
        ImGui::Render();
        const float clearColor[4] = { 0.024f, 0.035f, 0.063f, 1.0f };
        g_pd3dDeviceContext->OMSetRenderTargets(1, &g_mainRenderTargetView, nullptr);
        g_pd3dDeviceContext->ClearRenderTargetView(g_mainRenderTargetView, clearColor);
        ImGui_ImplDX11_RenderDrawData(ImGui::GetDrawData());
        g_pSwapChain->Present(1, 0);
    }

    sfx.Shutdown();
    ImGui_ImplDX11_Shutdown();
    ImGui_ImplWin32_Shutdown();
    ImGui::DestroyContext();
    CleanupDeviceD3D();
    DestroyWindow(g_hWnd);
    UnregisterClassW(wc.lpszClassName, hInstance);
    return 0;
}
