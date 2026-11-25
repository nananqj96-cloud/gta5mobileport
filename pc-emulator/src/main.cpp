#define NOMINMAX
#define WIN32_LEAN_AND_MEAN

#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#include <windowsx.h>
#include <objbase.h>
#include <dwmapi.h>
#include <d3d11.h>
#include <dxgi.h>

#include "imgui.h"
#include "imgui_impl_win32.h"
#include "imgui_impl_dx11.h"

#include "sound_engine.h"
#include "particles.h"
#include "hw_monitor.h"
#include "local_server.h"
#include "launcher.h"
#include "webview_host.h"
#include "ui_draw.h"

#include <algorithm>
#include <cctype>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <mutex>
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
static float g_NavLeftX = 300.0f;
static float g_NavRightX = 820.0f;
static float g_RightControlsMinX = 880.0f;

// Embedded WebView2 Viewport Host & Borderless Fullscreen State
static vicebox::EmbeddedViewportHost* g_ViewportHost = nullptr;
static bool g_BorderlessFs = false;
static WINDOWPLACEMENT g_PrevPlacement = { sizeof(WINDOWPLACEMENT) };

static int ActiveViewportTopOffset() {
    return g_BorderlessFs ? 0 : kHeaderHeight;
}

static void SyncViewportBounds() {
    if (!g_ViewportHost || !g_hWnd) return;
    RECT rc{};
    if (GetClientRect(g_hWnd, &rc)) {
        g_ViewportHost->Resize(ActiveViewportTopOffset(), rc.right - rc.left, rc.bottom - rc.top);
    }
}

static void SetBorderlessFullscreen(HWND hWnd, bool enable) {
    if (!hWnd || g_BorderlessFs == enable) return;
    if (enable) {
        g_PrevPlacement.length = sizeof(WINDOWPLACEMENT);
        GetWindowPlacement(hWnd, &g_PrevPlacement);
        MONITORINFO mi{};
        mi.cbSize = sizeof(mi);
        if (GetMonitorInfoW(MonitorFromWindow(hWnd, MONITOR_DEFAULTTONEAREST), &mi)) {
            g_BorderlessFs = true;
            SetWindowLongW(hWnd, GWL_STYLE, WS_POPUP | WS_CLIPCHILDREN | WS_VISIBLE);
            SetWindowPos(hWnd, HWND_TOP,
                         mi.rcMonitor.left, mi.rcMonitor.top,
                         mi.rcMonitor.right - mi.rcMonitor.left,
                         mi.rcMonitor.bottom - mi.rcMonitor.top,
                         SWP_NOOWNERZORDER | SWP_FRAMECHANGED);
        }
    } else {
        g_BorderlessFs = false;
        SetWindowLongW(hWnd, GWL_STYLE,
                       WS_POPUP | WS_THICKFRAME | WS_MINIMIZEBOX | WS_MAXIMIZEBOX | WS_SYSMENU | WS_CLIPCHILDREN | WS_VISIBLE);
        SetWindowPlacement(hWnd, &g_PrevPlacement);
        SetWindowPos(hWnd, nullptr, 0, 0, 0, 0,
                     SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOOWNERZORDER | SWP_FRAMECHANGED);
    }
    SyncViewportBounds();
}

static void ExpandWindowForViewport(HWND hWnd) {
    if (!hWnd || g_BorderlessFs || IsZoomed(hWnd)) return;
    RECT rc{};
    if (!GetWindowRect(hWnd, &rc)) return;
    int curW = rc.right - rc.left;
    int curH = rc.bottom - rc.top;
    if (curW >= 1280 && curH >= 760) return;

    MONITORINFO mi{};
    mi.cbSize = sizeof(mi);
    if (!GetMonitorInfoW(MonitorFromWindow(hWnd, MONITOR_DEFAULTTONEAREST), &mi)) return;
    int workW = mi.rcWork.right - mi.rcWork.left;
    int workH = mi.rcWork.bottom - mi.rcWork.top;
    int newW = std::min(1380, std::max(curW, workW - 36));
    int newH = std::min(840, std::max(curH, workH - 36));
    int newX = mi.rcWork.left + (workW - newW) / 2;
    int newY = mi.rcWork.top + (workH - newH) / 2;
    SetWindowPos(hWnd, nullptr, newX, newY, newW, newH, SWP_NOZORDER | SWP_NOACTIVATE);
}

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
            mmi->ptMinTrackSize.x = 1000;
            mmi->ptMinTrackSize.y = 650;
            return 0;
        }

        case WM_NCHITTEST: {
            if (g_BorderlessFs) return HTCLIENT;
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

        case WM_MOVE:
            if (g_ViewportHost) g_ViewportHost->NotifyParentMoved();
            return 0;

        case WM_SIZE:
            if (wParam == SIZE_MINIMIZED) return 0;
            g_ResizeWidth = static_cast<UINT>(LOWORD(lParam));
            g_ResizeHeight = static_cast<UINT>(HIWORD(lParam));
            SyncViewportBounds();
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

static bool IsFoxxyUsername(const std::string& name) {
    std::string s = name;
    while (!s.empty() && std::isspace(static_cast<unsigned char>(s.front()))) s.erase(s.begin());
    while (!s.empty() && std::isspace(static_cast<unsigned char>(s.back()))) s.pop_back();
    if (s.size() != 5) return false;
    for (char& c : s) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
    return s == "foxxy";
}

// ==================== APPLICATION STATE ====================
enum class AppScreen { Login, Dashboard };

struct AppState {
    AppScreen screen = AppScreen::Login;
    int activeTab = 0; // 0=Emulators, 1=Engine Config, 2=Hypervisor Log, 3=Developer (Foxxy only)

    // Login state
    char gamertagBuf[64] = "";
    char passkeyBuf[64] = "";
    char devPathBuf[1024] = "";
    bool showPasskey = false;
    bool authenticating = false;
    float authTimer = 0.0f;
    std::string authError;
    float loginShakeT = 0.0f;
    std::string signedInUser;
    bool isFoxxyDev = false;

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
    float btnGta6Hover = 0.0f;
    float btnAllModeHover = 0.0f;
    float btnDevBrowseHover = 0.0f;
    float btnDevLaunchHover = 0.0f;
    float btnDevAllHover = 0.0f;
    float gta6ShakeT = 0.0f;
    float hdrBtnHover[4] = {};

    // Toast notification
    std::string toastMsg;
    ImVec4 toastCol = Palette::VicePink;
    float toastTimer = 0.0f;
    float toastSlide = 0.0f;

    // Launch Sequence overlay
    bool launching = false;
    bool launchDispatched = false;
    float launchProgress = 0.0f;
    float launchOverlayAlpha = 0.0f;
    std::string launchTargetUrl;
    std::string launchBannerTitle;
    std::string launchSubtitle;
    std::string launchViewportStatus;
    ImVec4 launchAccent = Palette::Emerald;

    // Config, hardware, server bridge, logs
    EmulatorConfig config;
    PcHardwareInfo hw;
    HwSnapshot liveHw;
    std::vector<std::string> logs;
    int lastInputChars = 0;
    uint16_t serverPort = 0;

    void PushLog(const std::string& line) {
        SYSTEMTIME st{};
        GetLocalTime(&st);
        char ts[24];
        std::snprintf(ts, sizeof(ts), "[%02u:%02u:%02u] ", st.wHour, st.wMinute, st.wSecond);
        logs.push_back(std::string(ts) + line);
        if (logs.size() > 160) logs.erase(logs.begin());
    }

    void ShowToast(const std::string& msg, ImVec4 accent) {
        toastMsg = msg;
        toastCol = accent;
        toastTimer = 4.2f;
    }

    void SyncToShared(SharedEmulatorState& s, std::mutex& mu, const char* forceEmulatedGame = nullptr) const {
        std::lock_guard<std::mutex> lk(mu);
        s.consoleTarget      = (config.consoleTarget == 2) ? "viceos" : ((config.consoleTarget == 1) ? "xbox" : "ps5");
        if (forceEmulatedGame) s.emulatedGame = forceEmulatedGame;
        if (!signedInUser.empty()) s.profileName = signedInUser;
        s.psPlusTier         = config.psPlusTier;
        s.showDebugHud       = config.showDebugHud;
        s.enableCheatMenu    = config.enableCheatMenu;
        s.motionBlur         = config.motionBlur;
        s.motionBlurStrength = config.motionBlurStrength;
        s.optimizationMode   = config.optimizationMode;
        s.lookSensitivity    = config.lookSensitivity;
        s.resIndex           = config.resIndex;
        s.gta5Mode           = config.gta5Mode;
        s.isFoxxyDev         = isFoxxyDev;
        s.devGta6Enabled     = isFoxxyDev && config.devGta6Enabled;
        s.devGta6ExePath     = config.devGta6ExePath;
        s.devFullOverlay     = config.devFullOverlay;
        s.devFakeFpsEnabled  = config.devFakeFpsEnabled;
        s.devFakeFpsLimit    = config.devFakeFpsLimit;
        s.customGta5PlayPath = BuildLocalGta5PlayPath(config);
    }

    void PullFromSharedIfDirty(SharedEmulatorState& s, std::mutex& mu) {
        bool dirty = false;
        {
            std::lock_guard<std::mutex> lk(mu);
            if (s.configDirtyFromWeb) {
                s.configDirtyFromWeb = false;
                dirty = true;
                config.consoleTarget      = (s.consoleTarget == "viceos") ? 2 : ((s.consoleTarget == "xbox") ? 1 : 0);
                config.psPlusTier         = s.psPlusTier;
                config.showDebugHud       = s.showDebugHud;
                config.enableCheatMenu    = s.enableCheatMenu;
                config.motionBlur         = s.motionBlur;
                config.motionBlurStrength = s.motionBlurStrength;
                config.optimizationMode   = s.optimizationMode;
                config.lookSensitivity    = std::max(20, std::min(300, s.lookSensitivity));
                if (!s.profileName.empty() && s.profileName != signedInUser) {
                    signedInUser = s.profileName;
                }
                s.customGta5PlayPath = BuildLocalGta5PlayPath(config);
            }
        }
        if (dirty) {
            SaveConfig(config);
            PushLog("[SYNC] Updated config live from Console Dashboard Settings");
        }
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
        0x0020, 0x00FF,
        0x2000, 0x206F,
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
    c[ImGuiCol_WindowBg]            = ImVec4(0, 0, 0, 0);
    c[ImGuiCol_ChildBg]             = ImVec4(0, 0, 0, 0);
    c[ImGuiCol_Text]                = Palette::TextHi;
    c[ImGuiCol_TextDisabled]        = Palette::TextDim;
    c[ImGuiCol_FrameBg]             = ImVec4(0.035f, 0.048f, 0.086f, 0.92f);
    c[ImGuiCol_FrameBgHovered]      = ImVec4(0.055f, 0.075f, 0.130f, 0.96f);
    c[ImGuiCol_FrameBgActive]       = ImVec4(0.068f, 0.095f, 0.165f, 1.00f);
    c[ImGuiCol_Border]              = ImVec4(1.0f, 1.0f, 1.0f, 0.11f);
    c[ImGuiCol_CheckMark]           = Palette::Emerald;
    c[ImGuiCol_SliderGrab]          = Palette::Emerald;
    c[ImGuiCol_SliderGrabActive]    = Palette::Cyan;
    c[ImGuiCol_Button]              = ImVec4(0.08f, 0.11f, 0.18f, 0.85f);
    c[ImGuiCol_ButtonHovered]       = ImVec4(0.12f, 0.17f, 0.27f, 0.95f);
    c[ImGuiCol_ButtonActive]        = ImVec4(0.10f, 0.65f, 0.42f, 0.95f);
    c[ImGuiCol_PopupBg]             = ImVec4(0.055f, 0.072f, 0.125f, 0.97f);
    c[ImGuiCol_Header]              = ImVec4(0.09f, 0.56f, 0.36f, 0.48f);
    c[ImGuiCol_HeaderHovered]       = ImVec4(0.10f, 0.72f, 0.44f, 0.65f);
    c[ImGuiCol_HeaderActive]        = ImVec4(0.10f, 0.86f, 0.48f, 0.78f);
    c[ImGuiCol_ScrollbarBg]         = ImVec4(0.03f, 0.04f, 0.07f, 0.40f);
    c[ImGuiCol_ScrollbarGrab]       = ImVec4(0.24f, 0.30f, 0.44f, 0.65f);
    c[ImGuiCol_ScrollbarGrabHovered]= ImVec4(0.12f, 0.82f, 0.50f, 0.75f);
    c[ImGuiCol_NavHighlight]        = Palette::Cyan;
}

static const ImVec4 kPs5Blue   = ImVec4(0.14f, 0.52f, 0.98f, 1.0f);
static const ImVec4 kDevGold   = ImVec4(0.98f, 0.78f, 0.18f, 1.0f);
static const ImVec4 kDevGoldDk = ImVec4(0.68f, 0.44f, 0.06f, 1.0f);

static ImVec4 GetConsoleAccent(int target) {
    if (target == 2) return ImVec4(0.00f, 0.90f, 1.00f, 1.0f); // ViceOS Neo Cyan/Magenta
    if (target == 1) return Palette::Emerald;
    return kPs5Blue;
}

static const char* GetConsoleRoute(int target) {
    if (target == 2) return "/viceos/";
    if (target == 1) return "/xbox/";
    return "/ps5/";
}

static const char* GetConsoleTag(int target) {
    if (target == 2) return "VICEOS NEO";
    if (target == 1) return "XBOX";
    return "PS5";
}

// ==================== TOP FRAMELESS GLASS HEADER ====================
static void RenderHeaderBar(AppState& app, const FontSet& fonts, SoundEngine& sfx,
                            ParticleSystem& particles, LocalHttpServer& server,
                            SharedEmulatorState& shared, std::mutex& sharedMu,
                            EmbeddedViewportHost& viewportHost,
                            float winW, float dt, float time) {
    if (g_BorderlessFs) return;
    ImDrawList* dl = ImGui::GetWindowDrawList();
    ImVec2 p0(0, 0), p1(winW, static_cast<float>(kHeaderHeight));

    dl->AddRectFilled(p0, p1, IM_COL32(7, 10, 18, 226));
    dl->AddLine(ImVec2(0, p1.y - 1.0f), ImVec2(winW, p1.y - 1.0f), IM_COL32(255, 255, 255, 20), 1.0f);

    ImVec4 topAccentL = GetConsoleAccent(app.config.consoleTarget);
    dl->AddRectFilledMultiColor(
        ImVec2(0, 0), ImVec2(winW, 2.0f),
        ColAlpha(topAccentL, 0.90f), ColAlpha(Palette::Cyan, 0.88f),
        ColAlpha(Palette::VicePink, 0.88f), ColAlpha(topAccentL, 0.90f));

    // Left: ViceBox X Logo + Brand Title
    DrawViceBoxLogo(dl, ImVec2(28.0f, 27.0f), 13.5f, time, 1.0f);
    ImGui::PushFont(fonts.bold);
    dl->AddText(ImVec2(50.0f, 11.0f), ColAlpha(Palette::TextHi, 1.0f), "VICEBOX X");
    ImGui::PopFont();
    ImGui::PushFont(fonts.mono);
    dl->AddText(ImVec2(50.0f, 30.0f), ColAlpha(Palette::TextDim, 0.95f),
                viewportHost.IsVisible() ? "LIVE EMBEDDED VIEWPORT  //  v2.5"
                                         : "PS5 · XBOX · VICEOS  //  v2.5");
    ImGui::PopFont();

    // Center Controls: LIVE EMBEDDED VIEWPORT TOOLBAR when game/console is active inside window,
    // otherwise Dashboard Navigation Tabs!
    if (app.screen == AppScreen::Dashboard && viewportHost.IsVisible()) {
        struct VpBtn { const char* id; const char* lbl; float w; ImVec4 col; int action; };
        const VpBtn btns[7] = {
            { "##vp_back",   "< LAUNCHER", 98.0f, Palette::TextMid,  0 },
            { "##vp_ps5",    "PS5",        52.0f, kPs5Blue,          1 },
            { "##vp_xbox",   "XBOX",       58.0f, Palette::Emerald,  2 },
            { "##vp_viceos", "VICEOS",     68.0f, Palette::Cyan,     3 },
            { "##vp_gta5",   "GTA V",      64.0f, Palette::VicePink, 4 },
            { "##vp_full",   "FULLSCREEN", 92.0f, kDevGold,          5 },
            { "##vp_stop",   "STOP",       56.0f, ImVec4(0.95f, 0.24f, 0.34f, 1.0f), 6 }
        };
        float totalW = 0.0f;
        for (int i = 0; i < 7; ++i) totalW += btns[i].w + (i > 0 ? 5.0f : 0.0f);
        float startX = (winW - totalW) * 0.5f;
        if (startX < 252.0f) startX = 252.0f;
        g_NavLeftX = startX - 8.0f;
        g_NavRightX = startX + totalW + 8.0f;

        dl->AddRectFilled(ImVec2(startX - 6.0f, 9.0f), ImVec2(startX + totalW + 6.0f, 45.0f),
                          IM_COL32(10, 15, 28, 224), 10.0f);
        dl->AddRect(ImVec2(startX - 6.0f, 9.0f), ImVec2(startX + totalW + 6.0f, 45.0f),
                    ColAlpha(Palette::Cyan, 0.22f), 10.0f);

        float curX = startX;
        ImGui::PushFont(fonts.mono);
        for (int i = 0; i < 7; ++i) {
            const auto& b = btns[i];
            ImVec2 bp(curX, 13.0f);
            ImGui::SetCursorPos(bp);
            bool clicked = ImGui::InvisibleButton(b.id, ImVec2(b.w, 28.0f));
            bool hov = ImGui::IsItemHovered();
            bool isActiveConsole =
                (b.action == 1 && app.config.consoleTarget == 0) ||
                (b.action == 2 && app.config.consoleTarget == 1) ||
                (b.action == 3 && app.config.consoleTarget == 2);
            float bgAlpha = hov ? 0.34f : (isActiveConsole ? 0.22f : 0.11f);
            float brdAlpha = hov ? 0.90f : (isActiveConsole ? 0.65f : 0.32f);
            dl->AddRectFilled(bp, ImVec2(bp.x + b.w, bp.y + 28.0f),
                              ColAlpha(ImVec4(b.col.x, b.col.y, b.col.z, bgAlpha), 1.0f), 7.0f);
            dl->AddRect(bp, ImVec2(bp.x + b.w, bp.y + 28.0f),
                        ColAlpha(b.col, brdAlpha), 7.0f, 0, isActiveConsole ? 1.4f : 1.0f);
            ImVec2 ts = ImGui::CalcTextSize(b.lbl);
            dl->AddText(ImVec2(bp.x + (b.w - ts.x) * 0.5f, bp.y + (28.0f - ts.y) * 0.5f),
                        ColAlpha((hov || isActiveConsole || b.action >= 4) ? Palette::TextHi : Palette::TextMid, 1.0f),
                        b.lbl);

            if (clicked) {
                sfx.Play(SfxId::Click, 0.70f);
                if (b.action == 0) {
                    viewportHost.Hide();
                    app.ShowToast("Viewport paused in background — click RESUME GAME anytime", Palette::Cyan);
                } else if (b.action >= 1 && b.action <= 3) {
                    int newCt = b.action - 1;
                    app.config.consoleTarget = newCt;
                    SaveConfig(app.config);
                    app.SyncToShared(shared, sharedMu);
                    std::string u = server.BaseUrl() + GetConsoleRoute(newCt);
                    RECT rc{}; GetClientRect(g_hWnd, &rc);
                    viewportHost.OpenUrl(u, ActiveViewportTopOffset(), rc.right - rc.left, rc.bottom - rc.top);
                    app.PushLog(std::string("[VIEWPORT] Live switched console to ") + GetConsoleTag(newCt));
                } else if (b.action == 4) {
                    app.SyncToShared(shared, sharedMu, "gta5");
                    std::string u = server.BaseUrl() + "/play/?vbx_from=" +
                        (app.config.consoleTarget == 2 ? "viceos" : (app.config.consoleTarget == 1 ? "xbox" : "ps5"));
                    RECT rc{}; GetClientRect(g_hWnd, &rc);
                    viewportHost.OpenUrl(u, ActiveViewportTopOffset(), rc.right - rc.left, rc.bottom - rc.top);
                    app.PushLog("[VIEWPORT] Direct GTA V WebGPU launch inside embedded viewport -> " + u);
                } else if (b.action == 5) {
                    SetBorderlessFullscreen(g_hWnd, !g_BorderlessFs);
                } else if (b.action == 6) {
                    if (g_BorderlessFs) SetBorderlessFullscreen(g_hWnd, false);
                    viewportHost.StopSession();
                    app.PushLog("[VIEWPORT] Stopped embedded emulator viewport");
                    app.ShowToast("Embedded Emulator Viewport stopped", Palette::TextMid);
                }
            }
            if (hov) {
                if (b.action == 0) ImGui::SetTooltip("Return to ViceBox X Launcher (keeps GTA V running)");
                else if (b.action == 4) ImGui::SetTooltip("Boot Grand Theft Auto V directly inside this viewport");
                else if (b.action == 5) ImGui::SetTooltip("Toggle Edge-to-Edge Fullscreen (F11)");
                else if (b.action == 6) ImGui::SetTooltip("Close game & free viewport GPU/RAM");
            }
            curX += b.w + 5.0f;
        }
        ImGui::PopFont();
    } else if (app.screen == AppScreen::Dashboard && app.dashFade > 0.05f) {
        const int numTabs = app.isFoxxyDev ? 4 : 3;
        const char* tabs[4] = { "EMULATORS", "CONFIG", "LOG", "DEVELOPER" };
        const float tabW[4] = { 102.0f, 82.0f, 64.0f, 112.0f };
        float totalW = 0.0f;
        for (int i = 0; i < numTabs; ++i) totalW += tabW[i] + (i > 0 ? 6.0f : 0.0f);
        float startX = (winW - totalW) * 0.5f;
        if (startX < 268.0f) startX = 268.0f;
        g_NavLeftX = startX - 8.0f;
        g_NavRightX = startX + totalW + 8.0f;

        dl->AddRectFilled(ImVec2(startX - 6.0f, 9.0f), ImVec2(startX + totalW + 6.0f, 45.0f),
                          ColAlpha(ImVec4(0.04f, 0.06f, 0.11f, 0.85f), app.dashFade), 10.0f);
        dl->AddRect(ImVec2(startX - 6.0f, 9.0f), ImVec2(startX + totalW + 6.0f, 45.0f),
                    ColAlpha(ImVec4(1, 1, 1, 0.08f), app.dashFade), 10.0f);

        float curX = startX;
        float targetX = startX;
        float targetW = tabW[0];
        for (int i = 0; i < numTabs; ++i) {
            if (i == app.activeTab) { targetX = curX; targetW = tabW[i]; }
            curX += tabW[i] + 6.0f;
        }
        if (app.tabPillX < 1.0f) { app.tabPillX = targetX; app.tabPillW = targetW; }
        app.tabPillX = ExpLerp(app.tabPillX, targetX, 15.0f, dt);
        app.tabPillW = ExpLerp(app.tabPillW, targetW, 15.0f, dt);

        ImVec4 pillCol = (app.activeTab == 3) ? kDevGold : GetConsoleAccent(app.config.consoleTarget);
        dl->AddRectFilled(
            ImVec2(app.tabPillX, 12.0f), ImVec2(app.tabPillX + app.tabPillW, 42.0f),
            ColAlpha(ImVec4(pillCol.x, pillCol.y, pillCol.z, 0.18f), app.dashFade), 8.0f);
        dl->AddRect(
            ImVec2(app.tabPillX, 12.0f), ImVec2(app.tabPillX + app.tabPillW, 42.0f),
            ColAlpha(pillCol, 0.52f * app.dashFade), 8.0f);
        dl->AddLine(
            ImVec2(app.tabPillX + 14.0f, 42.0f), ImVec2(app.tabPillX + app.tabPillW - 14.0f, 42.0f),
            ColAlpha(pillCol, 0.95f * app.dashFade), 2.0f);

        // Controller LB / RB quick-switches dashboard tabs!
        if (!app.launching) {
            if (ImGui::IsKeyPressed(ImGuiKey_GamepadL1, false)) {
                app.activeTab = (app.activeTab - 1 + numTabs) % numTabs;
                app.tabSlideAlpha = 0.0f;
                sfx.Play(SfxId::TabSwitch, 0.85f);
            } else if (ImGui::IsKeyPressed(ImGuiKey_GamepadR1, false)) {
                app.activeTab = (app.activeTab + 1) % numTabs;
                app.tabSlideAlpha = 0.0f;
                sfx.Play(SfxId::TabSwitch, 0.85f);
            }
        }

        curX = startX;
        ImGui::PushFont(fonts.bold);
        for (int i = 0; i < numTabs; ++i) {
            ImGui::SetCursorPos(ImVec2(curX, 12.0f));
            char tid[32];
            std::snprintf(tid, sizeof(tid), "##nav_%d", i);
            if (ImGui::InvisibleButton(tid, ImVec2(tabW[i], 30.0f))) {
                if (app.activeTab != i) {
                    app.activeTab = i;
                    app.tabSlideAlpha = 0.0f;
                    sfx.Play(SfxId::TabSwitch, 0.85f);
                    particles.EmitBurst(ImVec2(curX + tabW[i] * 0.5f, 27.0f), 10,
                                        i == 3 ? kDevGold : Palette::Emerald, Palette::Cyan);
                }
            }
            bool hov = ImGui::IsItemHovered() || ImGui::IsItemFocused();
            if (ImGui::IsItemFocused()) {
                dl->AddRect(ImVec2(curX, 12.0f), ImVec2(curX + tabW[i], 42.0f),
                            ColAlpha(Palette::Cyan, 0.90f * app.dashFade), 8.0f, 0, 1.8f);
            }
            ImVec2 ts = ImGui::CalcTextSize(tabs[i]);
            ImVec4 tcol = (app.activeTab == i)
                              ? (i == 3 ? kDevGold : Palette::TextHi)
                              : (i == 3 ? ImVec4(0.98f, 0.82f, 0.36f, hov ? 1.0f : 0.86f)
                                        : (hov ? ImVec4(0.84f, 0.90f, 0.96f, 1.0f) : Palette::TextMid));
            dl->AddText(ImVec2(curX + (tabW[i] - ts.x) * 0.5f, 12.0f + (30.0f - ts.y) * 0.5f),
                        ColAlpha(tcol, app.dashFade), tabs[i]);
            curX += tabW[i] + 6.0f;
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

    if (drawWinBtn("##win_close", 0, 34.0f, ImVec4(0.88f, 0.16f, 0.28f, 1.0f),
                   [&](ImVec2 c, ImU32 col) {
                       dl->AddLine(ImVec2(c.x - 4.5f, c.y - 4.5f), ImVec2(c.x + 4.5f, c.y + 4.5f), col, 1.6f);
                       dl->AddLine(ImVec2(c.x + 4.5f, c.y - 4.5f), ImVec2(c.x - 4.5f, c.y + 4.5f), col, 1.6f);
                   })) {
        PostMessageW(g_hWnd, WM_CLOSE, 0, 0);
    }

    if (drawWinBtn("##win_max", 1, 34.0f, ImVec4(0.16f, 0.22f, 0.34f, 1.0f),
                   [&](ImVec2 c, ImU32 col) {
                       dl->AddRect(ImVec2(c.x - 4.5f, c.y - 4.5f), ImVec2(c.x + 4.5f, c.y + 4.5f), col, 1.5f, 0, 1.5f);
                   })) {
        sfx.Play(SfxId::Click, 0.55f);
        ShowWindow(g_hWnd, IsZoomed(g_hWnd) ? SW_RESTORE : SW_MAXIMIZE);
    }

    if (drawWinBtn("##win_min", 2, 34.0f, ImVec4(0.16f, 0.22f, 0.34f, 1.0f),
                   [&](ImVec2 c, ImU32 col) {
                       dl->AddLine(ImVec2(c.x - 5.0f, c.y + 2.0f), ImVec2(c.x + 5.0f, c.y + 2.0f), col, 1.6f);
                   })) {
        sfx.Play(SfxId::Click, 0.55f);
        ShowWindow(g_hWnd, SW_MINIMIZE);
    }

    // SFX Toggle Chip
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

    // Signed-in Gamertag Pill (click to sign out)
    if (app.screen == AppScreen::Dashboard && !app.signedInUser.empty() && app.dashFade > 0.05f) {
        rightX -= 10.0f;
        std::string badge = app.signedInUser + (app.isFoxxyDev ? " [DEV]" : "");
        if (badge.size() > 19) badge = badge.substr(0, 17) + "..";
        ImVec2 ts = ImGui::CalcTextSize(badge.c_str());
        float bw = ts.x + 33.0f;
        rightX -= bw;
        ImVec2 badgePos(rightX, 14.0f);
        DrawStatusPill(dl, badgePos, badge.c_str(), app.isFoxxyDev ? kDevGold : Palette::Emerald, app.dashFade, true);
        ImGui::SetCursorPos(badgePos);
        if (ImGui::InvisibleButton("##operator_pill", ImVec2(bw, 26.0f))) {
            sfx.Play(SfxId::TabSwitch, 0.80f);
            if (g_BorderlessFs) SetBorderlessFullscreen(g_hWnd, false);
            if (viewportHost.HasActiveSession()) viewportHost.StopSession();
            app.screen = AppScreen::Login;
            app.loginFade = 0.0f;
            app.passkeyBuf[0] = '\0';
            app.authenticating = false;
            app.isFoxxyDev = false;
            if (app.activeTab == 3) app.activeTab = 0;
            app.authError.clear();
            app.SyncToShared(shared, sharedMu, "gta5");
            app.PushLog("[AUTH] Operator signed out");
        }
        if (ImGui::IsItemHovered()) {
            ImGui::SetTooltip("Signed in as %s — click to switch account", app.signedInUser.c_str());
        }

        // If user stepped back to Launcher while a game/console session is still alive, offer 1-click RESUME!
        if (!viewportHost.IsVisible() && viewportHost.HasActiveSession()) {
            rightX -= 10.0f;
            const char* resLbl = "RESUME GAME";
            ImGui::PushFont(fonts.mono);
            ImVec2 rTs = ImGui::CalcTextSize(resLbl);
            float rW = rTs.x + 22.0f;
            rightX -= rW;
            ImVec2 rp(rightX, 13.0f);
            ImGui::SetCursorPos(rp);
            bool clickedRes = ImGui::InvisibleButton("##resume_vp_btn", ImVec2(rW, 28.0f));
            bool rHov = ImGui::IsItemHovered();
            float pulse = 0.65f + 0.35f * std::sin(time * 4.0f);
            dl->AddRectFilled(rp, ImVec2(rp.x + rW, rp.y + 28.0f),
                              ColAlpha(ImVec4(0.08f, 0.86f, 0.48f, rHov ? 0.38f : (0.20f + 0.08f * pulse)), 1.0f), 8.0f);
            dl->AddRect(rp, ImVec2(rp.x + rW, rp.y + 28.0f),
                        ColAlpha(Palette::Emerald, rHov ? 1.0f : (0.65f + 0.25f * pulse)), 8.0f, 0, 1.4f);
            dl->AddText(ImVec2(rp.x + 11.0f, rp.y + (28.0f - rTs.y) * 0.5f),
                        ColAlpha(Palette::TextHi, 1.0f), resLbl);
            ImGui::PopFont();
            if (clickedRes) {
                sfx.Play(SfxId::Launch, 0.75f);
                RECT rc{}; GetClientRect(g_hWnd, &rc);
                viewportHost.Show(ActiveViewportTopOffset(), rc.right - rc.left, rc.bottom - rc.top);
            }
            if (rHov) ImGui::SetTooltip("Return to your live embedded Console / GTA V session");
        }
    }

    g_RightControlsMinX = rightX - 10.0f;
}

// ==================== SCREEN 1: AUTHENTIC OPERATOR SIGN-IN ====================
static void RenderLoginScreen(AppState& app, const FontSet& fonts, SoundEngine& sfx,
                              ParticleSystem& particles, SharedEmulatorState& shared, std::mutex& sharedMu,
                              float winW, float winH, float dt, float time) {
    app.loginFade = ExpLerp(app.loginFade, 1.0f, 6.5f, dt);
    if (app.loginShakeT > 0.0f) app.loginShakeT = std::max(0.0f, app.loginShakeT - dt * 2.8f);
    float shakeX = (app.loginShakeT > 0.0f) ? std::sin(app.loginShakeT * 38.0f) * app.loginShakeT * 12.0f : 0.0f;

    float alpha = app.loginFade;
    float slideY = (1.0f - EaseOutCubic(app.loginFade)) * 22.0f;

    const float cardW = 456.0f;
    const float cardH = 482.0f;
    ImVec2 cMin((winW - cardW) * 0.5f + shakeX, kHeaderHeight + (winH - kHeaderHeight - cardH) * 0.5f + slideY);
    ImVec2 cMax(cMin.x + cardW, cMin.y + cardH);

    ImDrawList* dl = ImGui::GetWindowDrawList();
    DrawGlassCard(dl, cMin, cMax, 18.0f, Palette::Emerald, 0.35f + 0.15f * std::sin(time * 1.4f), alpha, false);

    dl->AddRectFilledMultiColor(
        ImVec2(cMin.x + 24.0f, cMin.y + 1.0f), ImVec2(cMax.x - 24.0f, cMin.y + 4.0f),
        ColAlpha(kPs5Blue, alpha), ColAlpha(Palette::Cyan, alpha),
        ColAlpha(Palette::VicePink, alpha), ColAlpha(Palette::Emerald, alpha));

    DrawViceBoxLogo(dl, ImVec2(cMin.x + cardW * 0.5f, cMin.y + 56.0f), 26.0f, time, alpha);

    ImGui::PushFont(fonts.title);
    const char* title = "VICEBOX X";
    ImVec2 ts = ImGui::CalcTextSize(title);
    dl->AddText(ImVec2(cMin.x + (cardW - ts.x) * 0.5f, cMin.y + 92.0f), ColAlpha(Palette::TextHi, alpha), title);
    ImGui::PopFont();

    ImGui::PushFont(fonts.mono);
    const char* sub = "PS5 & XBOX SERIES X EMULATOR  //  CYBERLEEKS v2.1";
    ImVec2 ss = ImGui::CalcTextSize(sub);
    dl->AddText(ImVec2(cMin.x + (cardW - ss.x) * 0.5f, cMin.y + 124.0f), ColAlpha(Palette::Cyan, 0.85f * alpha), sub);
    ImGui::PopFont();

    const char* gwText = "LOCAL CONSOLE HYPERVISOR · READY";
    ImVec2 gws = ImGui::CalcTextSize(gwText);
    DrawStatusPill(dl, ImVec2(cMin.x + (cardW - (gws.x + 33.0f)) * 0.5f, cMin.y + 148.0f), gwText, Palette::Emerald, alpha, true);

    if (app.authenticating) {
        app.authTimer += dt;
        ImVec2 spinC(cMin.x + cardW * 0.5f, cMin.y + 278.0f);
        DrawSpinnerRing(dl, spinC, 34.0f, 4.0f, time, app.isFoxxyDev ? kDevGold : Palette::Emerald, Palette::VicePink, alpha);

        const char* stage = (app.authTimer < 0.28f) ? "Verifying Hypervisor Session..."
                          : (app.authTimer < 0.60f) ? (app.isFoxxyDev ? "Unlocking Foxxy Developer Suite..." : "Mounting PS5 & Xbox Dashboards...")
                                                    : "Access Granted — Entering ViceBox X...";
        ImGui::PushFont(fonts.bold);
        ImVec2 stSz = ImGui::CalcTextSize(stage);
        dl->AddText(ImVec2(cMin.x + (cardW - stSz.x) * 0.5f, cMin.y + 336.0f), ColAlpha(Palette::TextHi, alpha), stage);
        ImGui::PopFont();

        ImGui::PushFont(fonts.mono);
        std::string opLine = "OPERATOR: " + app.signedInUser + (app.isFoxxyDev ? "  [DEV ACCESS]" : "");
        ImVec2 opSz = ImGui::CalcTextSize(opLine.c_str());
        dl->AddText(ImVec2(cMin.x + (cardW - opSz.x) * 0.5f, cMin.y + 364.0f),
                    ColAlpha(app.isFoxxyDev ? kDevGold : Palette::Emerald, 0.92f * alpha), opLine.c_str());
        ImGui::PopFont();

        if (app.authTimer >= 0.85f) {
            app.authenticating = false;
            app.screen = AppScreen::Dashboard;
            app.dashFade = 0.0f;
            app.tabSlideAlpha = 0.0f;
            app.SyncToShared(shared, sharedMu, "gta5");
            sfx.Play(SfxId::LoginSuccess, 0.90f);
            particles.EmitBurst(spinC, 28, app.isFoxxyDev ? kDevGold : Palette::Emerald, Palette::Cyan);
            app.PushLog("[AUTH] Operator '" + app.signedInUser + "' signed in");
            if (app.isFoxxyDev) {
                app.PushLog("[DEV] Foxxy Developer Mode unlocked — DEVELOPER tab enabled");
                app.ShowToast("Welcome Foxxy! Developer Mode tab unlocked in top header.", kDevGold);
            }
        }
        return;
    }

    const float padX = 36.0f;
    const float fieldW = cardW - padX * 2.0f;
    float y = cMin.y + 194.0f;

    ImGui::PushStyleVar(ImGuiStyleVar_Alpha, alpha);

    ImGui::PushFont(fonts.bold);
    dl->AddText(ImVec2(cMin.x + padX, y), ColAlpha(Palette::TextMid, alpha), "GAMERTAG / PSN ID");
    ImGui::PopFont();
    y += 24.0f;

    ImGui::SetCursorPos(ImVec2(cMin.x + padX, y));
    ImGui::SetNextItemWidth(fieldW);
    ImGui::PushStyleVar(ImGuiStyleVar_FrameBorderSize, 1.0f);
    bool enter1 = ImGui::InputTextWithHint("##gamertag", "Enter Username or Gamertag",
                                           app.gamertagBuf, sizeof(app.gamertagBuf),
                                           ImGuiInputTextFlags_EnterReturnsTrue);
    y += 50.0f;

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
    ImGui::PopStyleVar();
    y += 50.0f;

    ImGui::SetCursorPos(ImVec2(cMin.x + padX, y));
    if (ImGui::Checkbox("Remember Profile & Session", &app.config.rememberSession)) {
        sfx.Play(SfxId::Click, 0.50f);
    }
    y += 38.0f;

    if (!app.authError.empty()) {
        ImVec2 errSz = ImGui::CalcTextSize(app.authError.c_str());
        dl->AddText(ImVec2(cMin.x + (cardW - errSz.x) * 0.5f, y - 8.0f),
                    ColAlpha(ImVec4(1.0f, 0.36f, 0.45f, 1.0f), alpha), app.authError.c_str());
    }

    ImGui::SetCursorPos(ImVec2(cMin.x + padX, cMax.y - 78.0f));
    ImVec2 btnCenter{};
    ImGui::PushFont(fonts.bold);
    bool submit = DrawNeonButton("##btn_signin", "SIGN IN TO VICEBOX X", ImVec2(fieldW, 46.0f),
                                 Palette::EmeraldDeep, Palette::Emerald, app.btnLoginHover, dt, sfx, false, alpha, &btnCenter);
    ImGui::PopFont();

    if (submit || enter1 || enter2 || ImGui::IsKeyPressed(ImGuiKey_GamepadStart, false)) {
        std::string gt(app.gamertagBuf);
        std::string pk(app.passkeyBuf);
        while (!gt.empty() && (gt.front() == ' ' || gt.front() == '\t')) gt.erase(gt.begin());
        while (!gt.empty() && (gt.back() == ' ' || gt.back() == '\t')) gt.pop_back();

        bool isDevLogin = IsFoxxyUsername(gt);
        if (gt.empty() || (!isDevLogin && pk.empty())) {
            app.authError = "Enter your Gamertag and Passkey to continue.";
            app.loginShakeT = 1.0f;
            sfx.Play(SfxId::Locked, 0.85f);
        } else {
            app.authError.clear();
            app.signedInUser = gt;
            app.isFoxxyDev = isDevLogin;
            std::snprintf(app.devPathBuf, sizeof(app.devPathBuf), "%s", app.config.devGta6ExePath.c_str());
            app.config.savedGamertag = app.config.rememberSession ? gt : "";
            SaveConfig(app.config);
            app.authenticating = true;
            app.authTimer = 0.0f;
            if (enter1 || enter2) sfx.Play(SfxId::Click, 0.80f);
            particles.EmitBurst(btnCenter, 16, app.isFoxxyDev ? kDevGold : Palette::Emerald, Palette::Cyan);
        }
    }

    ImGui::PopStyleVar();
}

// ==================== HELPER TO LAUNCH CONSOLE / UPDATES VIEWPORT ====================
static void TriggerConsoleLaunch(AppState& app, LocalHttpServer& server,
                                 SharedEmulatorState& shared, std::mutex& sharedMu,
                                 SoundEngine& sfx, ParticleSystem& particles, ImVec2 burstPos,
                                 const char* emulatedGame, bool openGta6UpdatesPage = false) {
    if (!server.IsRunning()) {
        app.ShowToast("Local emulator server failed to bind port.", Palette::VicePink);
        return;
    }

    if (openGta6UpdatesPage) {
        app.SyncToShared(shared, sharedMu, "gta5");
        app.launchTargetUrl = server.BaseUrl() + "/updates/gta6";
        app.launchBannerTitle = "CYBERLEEKS GTA VI UPDATES";
        app.launchSubtitle = "Opening Live GTA VI Development Status & Port Tracker...";
        app.launchAccent = Palette::VicePink;
    } else {
        app.SyncToShared(shared, sharedMu, emulatedGame);
        int ct = std::max(0, std::min(2, app.config.consoleTarget));
        app.launchTargetUrl = server.BaseUrl() + GetConsoleRoute(ct);
        app.launchBannerTitle = (ct == 2) ? "BOOTING VICEOS NEO CUSTOM EMULATOR"
                              : (ct == 1 ? "BOOTING XBOX DASHX360 EMULATOR" : "BOOTING PLAYSTATION 5 EMULATOR");
        std::string mountName = (std::strcmp(emulatedGame, "all") == 0)
                              ? "ALL MODE (GTA V + GTA VI · Experimental)"
                              : (std::strcmp(emulatedGame, "gta6") == 0 ? "GTA VI (Foxxy Dev)" : "Grand Theft Auto V");
        std::string shellPrefix = (ct == 2) ? "ViceOS Neo Custom OS · Mounting "
                                : (ct == 1 ? "Xbox Series X Native · Mounting " : "Xbox-to-PS5 Port · Mounting ");
        app.launchSubtitle = shellPrefix + mountName;
        app.launchAccent = (std::strcmp(emulatedGame, "all") == 0) ? kDevGold : GetConsoleAccent(ct);
    }

    app.launching = true;
    app.launchDispatched = false;
    app.launchProgress = 0.0f;
    app.launchViewportStatus.clear();
    sfx.Play(SfxId::Launch, 0.95f);
    particles.EmitBurst(burstPos, 30, app.launchAccent, Palette::Cyan);
    app.PushLog("[LAUNCH] " + app.launchBannerTitle + " -> " + app.launchTargetUrl);
}

// ==================== TAB 0: CONSOLE & EMULATOR SELECTOR ====================
static void RenderEmulatorsTab(AppState& app, const FontSet& fonts, SoundEngine& sfx,
                               ParticleSystem& particles, LocalHttpServer& server,
                               SharedEmulatorState& shared, std::mutex& sharedMu,
                               float winW, float winH, float dt, float time, float alpha) {
    ImDrawList* dl = ImGui::GetWindowDrawList();
    const float marginX = std::max(32.0f, (winW - 1060.0f) * 0.5f);
    const float contentW = winW - marginX * 2.0f;
    const float topY = static_cast<float>(kHeaderHeight) + 14.0f + (1.0f - alpha) * 14.0f;
    const int ct = std::max(0, std::min(2, app.config.consoleTarget));
    const ImVec4 activeConCol = GetConsoleAccent(ct);

    // Top Hero Row + 3-Way Console Target Switcher (PS5 | XBOX | VICEOS NEO)
    ImGui::PushFont(fonts.mono);
    const char* activeBanner = (ct == 2)
        ? "ACTIVE CONSOLE: VICEOS NEO (CUSTOM OS)  ·  NEO-GLASS + QUICK DECK + DUAL-LAUNCH"
        : (ct == 1
            ? "ACTIVE CONSOLE: XBOX SERIES X / 360 (NATIVE)  ·  DASHX360 METRO + BLADES + JAILBREAK"
            : "ACTIVE CONSOLE: PLAYSTATION 5 (XBOX-TO-PS5 PORT)  ·  PS5_ONLINE + SETTINGS + JAILBREAK");
    dl->AddText(ImVec2(marginX, topY), ColAlpha(activeConCol, 0.95f * alpha), activeBanner);
    ImGui::PopFont();

    ImGui::PushFont(fonts.title);
    dl->AddText(ImVec2(marginX, topY + 17.0f), ColAlpha(Palette::TextHi, alpha), "Select Mode & Console Target");
    ImGui::PopFont();

    // Right-aligned 3-Way Console Switcher Pills (PS5 | XBOX | VICEOS NEO)
    {
        const float swW = 456.0f;
        const float swH = 34.0f;
        ImVec2 sw0(winW - marginX - swW, topY + 17.0f);
        dl->AddRectFilled(sw0, ImVec2(sw0.x + swW, sw0.y + swH),
                          ColAlpha(ImVec4(0.04f, 0.06f, 0.11f, 0.92f), alpha), 10.0f);
        dl->AddRect(sw0, ImVec2(sw0.x + swW, sw0.y + swH),
                    ColAlpha(ImVec4(1, 1, 1, 0.12f), alpha), 10.0f);

        const char* cLabels[3] = { "PS5  (Port)", "XBOX  (Dash360)", "VICEOS NEO" };
        const ImVec4 cCols[3] = { kPs5Blue, Palette::Emerald, ImVec4(0.00f, 0.90f, 1.00f, 1.0f) };
        const float segW = (swW - 8.0f) / 3.0f;
        ImGui::PushFont(fonts.bold);
        for (int c = 0; c < 3; ++c) {
            ImVec2 bp(sw0.x + 4.0f + c * segW, sw0.y + 3.0f);
            ImGui::SetCursorPos(bp);
            char cid[24];
            std::snprintf(cid, sizeof(cid), "##console_sel_%d", c);
            if (!app.launching && ImGui::InvisibleButton(cid, ImVec2(segW, swH - 6.0f))) {
                if (app.config.consoleTarget != c) {
                    app.config.consoleTarget = c;
                    SaveConfig(app.config);
                    app.SyncToShared(shared, sharedMu);
                    sfx.Play(SfxId::TabSwitch, 0.85f);
                    particles.EmitBurst(ImVec2(bp.x + segW * 0.5f, bp.y + 14.0f), 14, cCols[c], Palette::VicePink);
                    app.PushLog(std::string("[CONSOLE] Switched target to ") + kConsoleNames[c]);
                }
            }
            bool sel = (app.config.consoleTarget == c);
            bool hov = ImGui::IsItemHovered();
            bool foc = ImGui::IsItemFocused();
            if (sel || hov || foc) {
                dl->AddRectFilled(bp, ImVec2(bp.x + segW, bp.y + swH - 6.0f),
                                  ColAlpha(ImVec4(cCols[c].x, cCols[c].y, cCols[c].z, sel ? 0.30f : 0.14f), alpha), 7.0f);
                if (sel || foc) {
                    dl->AddRect(bp, ImVec2(bp.x + segW, bp.y + swH - 6.0f),
                                ColAlpha(foc ? Palette::Cyan : cCols[c], 0.90f * alpha), 7.0f, 0, foc ? 2.0f : 1.3f);
                }
            }
            ImVec2 ts = ImGui::CalcTextSize(cLabels[c]);
            dl->AddText(ImVec2(bp.x + (segW - ts.x) * 0.5f, bp.y + (swH - 6.0f - ts.y) * 0.5f),
                        ColAlpha(sel ? Palette::TextHi : Palette::TextMid, alpha), cLabels[c]);
        }
        ImGui::PopFont();
    }

    const float gap = 22.0f;
    const float cardW = (contentW - gap) * 0.5f;
    const float cardsTop = topY + 60.0f;
    const float statusBarH = 44.0f;
    const float allBarH = 68.0f;
    const float allBarY = winH - statusBarH - 12.0f - 10.0f - allBarH;
    const float cardH = std::max(336.0f, allBarY - cardsTop - 12.0f);

    // ------------------------------------------------------------------
    // CARD 1: GTA V EMULATOR (PS5 / XBOX / VICEOS NEO + PC ENHANCEMENTS)
    // ------------------------------------------------------------------
    {
        float lift = app.card5Hover * 4.5f;
        ImVec2 cMin(marginX, cardsTop - lift);
        ImVec2 cMax(cMin.x + cardW, cMin.y + cardH);

        ImVec2 mp = ImGui::GetMousePos();
        bool inCard5 = !app.launching && mp.x >= cMin.x && mp.x <= cMax.x && mp.y >= cardsTop - 6.0f && mp.y <= cardsTop + cardH;
        app.card5Hover = ExpLerp(app.card5Hover, inCard5 ? 1.0f : 0.0f, 11.0f, dt);

        ImVec4 c5Accent = activeConCol;
        DrawGlassCard(dl, cMin, cMax, 16.0f, c5Accent, app.card5Hover, alpha, false);

        float bannerH = std::min(134.0f, cardH * 0.32f);
        ImVec2 bMin(cMin.x + 1.0f, cMin.y + 1.0f);
        ImVec2 bMax(cMax.x - 1.0f, cMin.y + bannerH);
        DrawGta5BannerArt(dl, bMin, bMax, time, app.card5Hover, alpha);

        const char* pill5 = (ct == 2) ? "READY · VICEOS NEO" : (ct == 1 ? "READY · XBOX NATIVE" : "READY · PS5 PORT");
        DrawStatusPill(dl, ImVec2(cMin.x + 18.0f, cMin.y + 14.0f), pill5, c5Accent, alpha, true);
        ImGui::PushFont(fonts.mono);
        const char* tag5 = (ct == 2) ? "VICEOS CUSTOM UI" : (ct == 1 ? "DASHX360 UI" : "PS5_ONLINE UI");
        ImVec2 t5s = ImGui::CalcTextSize(tag5);
        dl->AddText(ImVec2(cMax.x - t5s.x - 18.0f, cMin.y + 19.0f), ColAlpha(Palette::TextHi, 0.86f * alpha), tag5);
        ImGui::PopFont();

        float y = cMin.y + bannerH + 8.0f;
        ImGui::PushFont(fonts.title);
        dl->AddText(ImVec2(cMin.x + 22.0f, y), ColAlpha(Palette::TextHi, alpha), "GTA V EMULATOR");
        ImGui::PopFont();
        y += 28.0f;

        const char* desc5 = (ct == 2)
            ? "Boots ViceOS Neo Custom Console OS with GTA V"
            : (ct == 1 ? "Boots Xbox DashX360 (Metro & Blades) with GTA V"
                       : "Boots PlayStation 5 Home UI (Xbox->PS5 Port) with GTA V");
        dl->AddText(ImVec2(cMin.x + 22.0f, y), ColAlpha(Palette::TextMid, alpha), desc5);
        y += 24.0f;

        // Live PC Enhancement Badges
        std::vector<std::string> specs5;
        specs5.push_back(app.config.enableCheatMenu ? "Cheat Menu ON" : "Cheat Menu OFF");
        specs5.push_back(app.config.showDebugHud ? "Real HW HUD" : "HUD Hidden");
        if (app.config.optimizationMode) specs5.push_back("Opt Mode ON");
        else if (app.config.motionBlur) specs5.push_back("Motion Blur ON");
        else specs5.push_back("DualSense/Xbox");

        float sx = cMin.x + 22.0f;
        ImGui::PushFont(fonts.mono);
        for (const auto& sp : specs5) {
            ImVec2 ss = ImGui::CalcTextSize(sp.c_str());
            float pw = ss.x + 16.0f;
            dl->AddRectFilled(ImVec2(sx, y), ImVec2(sx + pw, y + 24.0f),
                              ColAlpha(ImVec4(c5Accent.x, c5Accent.y, c5Accent.z, 0.12f), alpha), 6.0f);
            dl->AddRect(ImVec2(sx, y), ImVec2(sx + pw, y + 24.0f),
                        ColAlpha(c5Accent, 0.34f * alpha), 6.0f);
            dl->AddText(ImVec2(sx + 8.0f, y + 5.0f), ColAlpha(Palette::TextHi, 0.92f * alpha), sp.c_str());
            sx += pw + 8.0f;
        }
        ImGui::PopFont();
        y += 36.0f;

        // Inline GTA V Launch Mode Selector Pills
        ImGui::PushFont(fonts.mono);
        dl->AddText(ImVec2(cMin.x + 22.0f, y), ColAlpha(Palette::TextDim, alpha), "GTA V LAUNCH MODE");
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
                    app.SyncToShared(shared, sharedMu);
                    sfx.Play(SfxId::Click, 0.65f);
                }
            }
            bool sel = (app.config.gta5Mode == m);
            bool hov = !app.launching && ImGui::IsItemHovered();
            bool foc = !app.launching && ImGui::IsItemFocused();
            dl->AddRectFilled(pp, ImVec2(pp.x + pillW, pp.y + 28.0f),
                              ColAlpha(sel ? ImVec4(c5Accent.x, c5Accent.y, c5Accent.z, 0.24f)
                                           : ((hov || foc) ? ImVec4(0.12f, 0.16f, 0.24f, 0.90f)
                                                           : ImVec4(0.04f, 0.06f, 0.10f, 0.85f)), alpha), 7.0f);
            dl->AddRect(pp, ImVec2(pp.x + pillW, pp.y + 28.0f),
                        ColAlpha(foc ? Palette::Cyan : (sel ? c5Accent : ImVec4(1, 1, 1, hov ? 0.22f : 0.09f)), alpha), 7.0f, 0, foc ? 2.0f : 1.0f);

            const char* shortLbl[4] = { "TITLE", "STORY", "SANDBOX", "VICE MAP" };
            ImVec2 ls = ImGui::CalcTextSize(shortLbl[m]);
            dl->AddText(ImVec2(pp.x + (pillW - ls.x) * 0.5f, pp.y + (28.0f - ls.y) * 0.5f),
                        ColAlpha(sel ? Palette::TextHi : Palette::TextMid, alpha), shortLbl[m]);
        }
        ImGui::PopFont();

        // Primary CTA Button -> Opens PS5, Xbox, or ViceOS Neo UI with GTA V mounted!
        ImGui::SetCursorPos(ImVec2(cMin.x + 22.0f, cMax.y - 62.0f));
        ImVec2 btnC{};
        ImGui::PushFont(fonts.bold);
        const char* launchLbl = (ct == 2) ? "BOOT VICEOS NEO  (GTA V)"
                              : (ct == 1 ? "BOOT XBOX EMULATOR  (GTA V)" : "BOOT PS5 EMULATOR  (GTA V)");
        ImVec4 btnDark = (ct == 2) ? ImVec4(0.05f, 0.34f, 0.56f, 1.0f)
                       : (ct == 1 ? Palette::EmeraldDeep : ImVec4(0.03f, 0.26f, 0.62f, 1.0f));
        bool launchClicked = !app.launching && DrawNeonButton(
            "##launch_gta5", launchLbl, ImVec2(cardW - 44.0f, 44.0f),
            btnDark, c5Accent, app.btnLaunch5Hover, dt, sfx, false, alpha, &btnC);
        ImGui::PopFont();

        if (launchClicked) {
            TriggerConsoleLaunch(app, server, shared, sharedMu, sfx, particles, btnC, "gta5", false);
        }
    }

    // ------------------------------------------------------------------
    // CARD 2: GTA VI EMULATOR (CYBERLEEKS UPDATES OR FOXXY DEV MOUNT)
    // ------------------------------------------------------------------
    {
        if (app.gta6ShakeT > 0.0f) app.gta6ShakeT = std::max(0.0f, app.gta6ShakeT - dt * 3.0f);
        float shakeX = (app.gta6ShakeT > 0.0f) ? std::sin(app.gta6ShakeT * 42.0f) * app.gta6ShakeT * 8.0f : 0.0f;

        const bool devGta6Ready = app.isFoxxyDev && app.config.devGta6Enabled;

        float lift = app.card6Hover * (devGta6Ready ? 4.5f : 2.8f);
        ImVec2 cMin(marginX + cardW + gap + shakeX, cardsTop - lift);
        ImVec2 cMax(cMin.x + cardW, cMin.y + cardH);

        ImVec2 mp = ImGui::GetMousePos();
        bool inCard6 = !app.launching && mp.x >= cMin.x && mp.x <= cMax.x && mp.y >= cardsTop - 6.0f && mp.y <= cardsTop + cardH;
        app.card6Hover = ExpLerp(app.card6Hover, inCard6 ? 1.0f : 0.0f, 11.0f, dt);

        ImVec4 c6Accent = devGta6Ready ? kDevGold : Palette::VicePink;
        DrawGlassCard(dl, cMin, cMax, 16.0f, c6Accent, app.card6Hover, alpha, !devGta6Ready);

        float bannerH = std::min(134.0f, cardH * 0.32f);
        ImVec2 bMin(cMin.x + 1.0f, cMin.y + 1.0f);
        ImVec2 bMax(cMax.x - 1.0f, cMin.y + bannerH);
        DrawGta6BannerArt(dl, bMin, bMax, time, app.card6Hover, alpha);

        DrawStatusPill(dl, ImVec2(cMin.x + 18.0f, cMin.y + 14.0f),
                       devGta6Ready ? "FOXXY DEV · GTA VI ACTIVE" : "IN DEVELOPMENT · CYBERLEEKS",
                       c6Accent, alpha, true);
        ImGui::PushFont(fonts.mono);
        const char* tag6 = devGta6Ready ? "CUSTOM .EXE HOOK" : "XBOX PORT WIP";
        ImVec2 t6s = ImGui::CalcTextSize(tag6);
        dl->AddText(ImVec2(cMax.x - t6s.x - 18.0f, cMin.y + 19.0f), ColAlpha(Palette::Cyan, 0.88f * alpha), tag6);
        ImGui::PopFont();

        float y = cMin.y + bannerH + 8.0f;
        ImGui::PushFont(fonts.title);
        dl->AddText(ImVec2(cMin.x + 22.0f, y), ColAlpha(Palette::TextHi, 0.94f * alpha), "GTA VI EMULATOR");
        ImGui::PopFont();
        y += 28.0f;

        dl->AddText(ImVec2(cMin.x + 22.0f, y), ColAlpha(Palette::TextMid, 0.92f * alpha),
                    devGta6Ready ? "Developer Override Active — Launch GTA VI inside Console UI"
                                 : "Grand Theft Auto VI — Cyberleeks Xbox-to-PS5 Port Status");
        y += 24.0f;

        const char* specs6[3] = {
            "RAGE9 XBSX",
            devGta6Ready ? "Console-Only Exec" : "PS5 Port Pending",
            "Cyberleeks CL-0.94"
        };
        float sx = cMin.x + 22.0f;
        ImGui::PushFont(fonts.mono);
        for (const char* sp : specs6) {
            ImVec2 ss = ImGui::CalcTextSize(sp);
            float pw = ss.x + 16.0f;
            dl->AddRectFilled(ImVec2(sx, y), ImVec2(sx + pw, y + 24.0f),
                              ColAlpha(ImVec4(c6Accent.x, c6Accent.y, c6Accent.z, 0.12f), alpha), 6.0f);
            dl->AddRect(ImVec2(sx, y), ImVec2(sx + pw, y + 24.0f),
                        ColAlpha(c6Accent, 0.34f * alpha), 6.0f);
            dl->AddText(ImVec2(sx + 8.0f, y + 5.0f), ColAlpha(Palette::TextHi, 0.88f * alpha), sp);
            sx += pw + 8.0f;
        }
        ImGui::PopFont();
        y += 36.0f;

        ImVec2 boxMin(cMin.x + 22.0f, y);
        ImVec2 boxMax(cMax.x - 22.0f, cMax.y - 80.0f);
        if (boxMax.y > boxMin.y + 34.0f) {
            dl->AddRectFilled(boxMin, boxMax, ColAlpha(ImVec4(0.035f, 0.042f, 0.075f, 0.82f), alpha), 9.0f);
            dl->AddRect(boxMin, boxMax, ColAlpha(ImVec4(c6Accent.x, c6Accent.y, c6Accent.z, 0.28f), alpha), 9.0f);
            std::string boxTxt;
            if (devGta6Ready) {
                std::string fn = app.config.devGta6ExePath.empty() ? "(No file picked — configure in DEVELOPER tab)" : app.config.devGta6ExePath;
                if (fn.size() > 54) fn = "..." + fn.substr(fn.size() - 51);
                boxTxt = "Dev Target: " + fn + "\nBoots console UI with GTA VI mounted; your custom file launches ONLY when played inside PS5/Xbox UI.";
            } else if (app.isFoxxyDev) {
                boxTxt = "Foxxy Dev Mode Unlocked! Open the DEVELOPER tab (top header) to enable GTA VI Emulation and bind ANY file type.";
            } else {
                boxTxt = "Live GTA VI Dev Build: runs at 5 FPS per 20 seconds (game fully works, semi-playable — only FPS optimization needed).\nClick below for full Cyberleeks GTA 6 Updates!";
            }
            dl->AddText(nullptr, 14.5f, ImVec2(boxMin.x + 14.0f, boxMin.y + 10.0f),
                        ColAlpha(Palette::TextMid, 0.94f * alpha),
                        boxTxt.c_str(), nullptr, (boxMax.x - boxMin.x) - 24.0f);
        }

        ImGui::SetCursorPos(ImVec2(cMin.x + 22.0f, cMax.y - 62.0f));
        ImVec2 btnC6{};
        ImGui::PushFont(fonts.bold);
        const char* cta6 = devGta6Ready
            ? (ct == 2 ? "BOOT VICEOS NEO  (GTA VI DEV)"
                       : (ct == 1 ? "BOOT XBOX UI  (GTA VI DEV)" : "BOOT PS5 UI  (GTA VI DEV)"))
            : (app.isFoxxyDev ? "OPEN FOXXY DEVELOPER SETTINGS" : "VIEW GTA 6 UPDATES  ·  CYBERLEEKS");
        bool click6 = !app.launching && DrawNeonButton(
            "##btn_gta6", cta6, ImVec2(cardW - 44.0f, 44.0f),
            (devGta6Ready || app.isFoxxyDev) ? kDevGoldDk : ImVec4(0.56f, 0.09f, 0.34f, 1.0f),
            (devGta6Ready || app.isFoxxyDev) ? kDevGold : c6Accent, app.btnGta6Hover, dt, sfx, false, alpha, &btnC6);
        ImGui::PopFont();

        if (click6) {
            if (devGta6Ready) {
                if (app.config.devGta6ExePath.empty()) {
                    app.activeTab = 3;
                    app.tabSlideAlpha = 0.0f;
                    app.ShowToast("Pick ANY file inside DEVELOPER settings first!", kDevGold);
                    sfx.Play(SfxId::TabSwitch, 0.85f);
                } else {
                    TriggerConsoleLaunch(app, server, shared, sharedMu, sfx, particles, btnC6, "gta6", false);
                }
            } else if (app.isFoxxyDev) {
                app.activeTab = 3;
                app.tabSlideAlpha = 0.0f;
                sfx.Play(SfxId::TabSwitch, 0.85f);
            } else {
                // Opens the dedicated Cyberleeks GTA VI Development Updates Page!
                TriggerConsoleLaunch(app, server, shared, sharedMu, sfx, particles, btnC6, "gta5", true);
            }
        }
    }

    // ------------------------------------------------------------------
    // NEW MODE BANNER: ALL MODE (GTA V + GTA VI SIMULTANEOUS · MIGHT BE BUGGY)
    // ------------------------------------------------------------------
    {
        ImVec2 aMin(marginX, allBarY);
        ImVec2 aMax(winW - marginX, allBarY + allBarH);
        dl->AddRectFilledMultiColor(
            aMin, aMax,
            ColAlpha(ImVec4(0.16f, 0.11f, 0.02f, 0.90f), alpha),
            ColAlpha(ImVec4(0.18f, 0.04f, 0.14f, 0.90f), alpha),
            ColAlpha(ImVec4(0.11f, 0.04f, 0.16f, 0.92f), alpha),
            ColAlpha(ImVec4(0.11f, 0.07f, 0.02f, 0.92f), alpha));
        dl->AddRect(aMin, aMax, ColAlpha(kDevGold, 0.62f * alpha), 13.0f, 0, 1.3f);

        ImGui::PushFont(fonts.bold);
        dl->AddText(ImVec2(aMin.x + 18.0f, aMin.y + 12.0f), ColAlpha(Palette::TextHi, alpha),
                    "ALL MODE  —  GTA V + GTA VI AT THE SAME TIME");
        ImGui::PopFont();

        DrawStatusPill(dl, ImVec2(aMin.x + 392.0f, aMin.y + 9.0f),
                       "EXPERIMENTAL · MIGHT BE BUGGY", kDevGold, alpha, true);

        dl->AddText(nullptr, 13.5f, ImVec2(aMin.x + 18.0f, aMin.y + 39.0f),
                    ColAlpha(ImVec4(1.0f, 0.90f, 0.66f, 0.94f), alpha),
                    "Unlocks BOTH Grand Theft Auto V and Grand Theft Auto VI simultaneously in your selected Console UI. May be buggy or increase GPU/RAM load.");

        const float btnW = 258.0f;
        ImGui::SetCursorPos(ImVec2(aMax.x - btnW - 14.0f, aMin.y + (allBarH - 42.0f) * 0.5f));
        ImVec2 allBtnC{};
        char allLbl[64];
        std::snprintf(allLbl, sizeof(allLbl), "BOOT %s  (ALL MODE)", GetConsoleTag(ct));
        ImGui::PushFont(fonts.bold);
        bool clickAll = !app.launching && DrawNeonButton(
            "##btn_all_mode", allLbl, ImVec2(btnW, 42.0f),
            kDevGoldDk, kDevGold, app.btnAllModeHover, dt, sfx, false, alpha, &allBtnC);
        ImGui::PopFont();

        if (clickAll) {
            app.PushLog("[ALL MODE] Experimental dual-title launch (GTA V + GTA VI) — might be buggy!");
            app.ShowToast("ALL MODE (Might be buggy): Mounting both GTA V & GTA VI simultaneously!", kDevGold);
            TriggerConsoleLaunch(app, server, shared, sharedMu, sfx, particles, allBtnC, "all", false);
        }
    }

    // ------------------------------------------------------------------
    // BOTTOM LIVE REAL PC HARDWARE & LOCAL SERVER TELEMETRY BAR
    // ------------------------------------------------------------------
    {
        float barY = winH - statusBarH - 12.0f;
        ImVec2 bMin(marginX, barY);
        ImVec2 bMax(winW - marginX, barY + statusBarH);
        dl->AddRectFilled(bMin, bMax, ColAlpha(ImVec4(0.048f, 0.064f, 0.112f, 0.90f), alpha), 12.0f);
        dl->AddRect(bMin, bMax, ColAlpha(ImVec4(1, 1, 1, 0.08f), alpha), 12.0f);

        ImVec2 dotC(bMin.x + 22.0f, bMin.y + statusBarH * 0.5f);
        float pulse = 0.55f + 0.45f * std::sin(time * 3.2f);
        dl->AddCircleFilled(dotC, 6.5f, ColAlpha(Palette::Emerald, 0.25f * pulse * alpha), 14);
        dl->AddCircleFilled(dotC, 3.2f, ColAlpha(Palette::Emerald, alpha), 12);

        ImGui::PushFont(fonts.mono);
        char hwLine[320];
        std::string gpuShort = app.liveHw.gpuName.empty() ? app.hw.gpuName : app.liveHw.gpuName;
        if (gpuShort.size() > 24) gpuShort = gpuShort.substr(0, 22) + "..";
        std::snprintf(hwLine, sizeof(hwLine),
                      "GPU: %s (%.0f%%) | VRAM: %.0fMB | CPU: %.1f%% | RAM: %.1f/%.1fGB | :%u",
                      gpuShort.c_str(), app.liveHw.gpuPct, app.liveHw.vramUsedMb,
                      app.liveHw.cpuPct, app.liveHw.ramUsedGb,
                      app.liveHw.ramTotalGb > 0.1 ? app.liveHw.ramTotalGb : app.hw.totalRamGb,
                      static_cast<unsigned>(app.serverPort));
        dl->AddText(ImVec2(bMin.x + 38.0f, bMin.y + (statusBarH - 14.0f) * 0.5f),
                    ColAlpha(Palette::TextMid, alpha), hwLine);
        ImGui::PopFont();

        // Direct fallback button: opens active PS5 / Xbox / ViceOS Neo console menu straight in System Browser
        const float fbW = 176.0f;
        const float fbH = 28.0f;
        ImVec2 fbPos(bMax.x - fbW - 12.0f, bMin.y + (statusBarH - fbH) * 0.5f);
        ImGui::SetCursorPos(fbPos);
        ImGui::PushFont(fonts.mono);
        char fbLbl[48];
        std::snprintf(fbLbl, sizeof(fbLbl), "OPEN %s IN BROWSER", GetConsoleTag(ct));
        if (ImGui::Button(fbLbl, ImVec2(fbW, fbH))) {
            app.SyncToShared(shared, sharedMu, "gta5");
            std::string directUrl = server.BaseUrl() + GetConsoleRoute(ct);
            LaunchGameViewport(directUrl, 3, false);
            sfx.Play(SfxId::Launch, 0.85f);
            app.PushLog("[BROWSER] Opened direct console UI: " + directUrl);
            app.ShowToast("Opened " + directUrl + " in default browser!", activeConCol);
        }
        ImGui::PopFont();
    }
}

// ==================== TAB 1: ENGINE CONFIGURATION ====================
static void RenderConfigTab(AppState& app, const FontSet& fonts, SoundEngine& sfx,
                            SharedEmulatorState& shared, std::mutex& sharedMu,
                            float winW, float winH, float alpha) {
    ImDrawList* dl = ImGui::GetWindowDrawList();
    const float marginX = std::max(32.0f, (winW - 1060.0f) * 0.5f);
    const float contentW = winW - marginX * 2.0f;
    const float topY = static_cast<float>(kHeaderHeight) + 20.0f + (1.0f - alpha) * 14.0f;

    ImGui::PushFont(fonts.mono);
    dl->AddText(ImVec2(marginX, topY), ColAlpha(Palette::Cyan, 0.90f * alpha),
                "RAGE ENGINE · CONSOLE SHELL · PC ENHANCEMENT SUITE");
    ImGui::PopFont();

    ImGui::PushFont(fonts.title);
    dl->AddText(ImVec2(marginX, topY + 18.0f), ColAlpha(Palette::TextHi, alpha), "Engine Configuration");
    ImGui::PopFont();

    const float gap = 22.0f;
    const float colW = (contentW - gap) * 0.5f;
    const float cardsTop = topY + 62.0f;
    const float cardH = std::max(430.0f, winH - cardsTop - 22.0f);

    ImGui::PushStyleVar(ImGuiStyleVar_Alpha, alpha);
    bool changed = false;

    // Left Glass Panel: GTA V Graphics & Performance
    {
        ImVec2 p0(marginX, cardsTop), p1(marginX + colW, cardsTop + cardH);
        DrawGlassCard(dl, p0, p1, 16.0f, Palette::Emerald, 0.20f, alpha, false);

        float x = p0.x + 24.0f;
        float w = colW - 48.0f;
        float y = p0.y + 20.0f;

        ImGui::PushFont(fonts.subtitle);
        dl->AddText(ImVec2(x, y), ColAlpha(Palette::TextHi, alpha), "GTA V Graphics & RAGE Engine");
        ImGui::PopFont();
        y += 36.0f;

        ImGui::PushFont(fonts.mono);
        dl->AddText(ImVec2(x, y), ColAlpha(Palette::TextMid, alpha), "GRAPHICS PRESET");
        ImGui::PopFont();
        y += 20.0f;

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
                changed = true;
                sfx.Play(SfxId::Click, 0.65f);
            }
            bool sel = (app.config.preset == i);
            bool foc = ImGui::IsItemFocused();
            dl->AddRectFilled(bp, ImVec2(bp.x + pw, bp.y + 30.0f),
                              ColAlpha(sel ? ImVec4(0.10f, 0.86f, 0.48f, 0.24f) : ImVec4(0.04f, 0.06f, 0.10f, 0.85f), alpha), 7.0f);
            dl->AddRect(bp, ImVec2(bp.x + pw, bp.y + 30.0f),
                        ColAlpha(foc ? Palette::Cyan : (sel ? Palette::Emerald : ImVec4(1, 1, 1, 0.10f)), alpha), 7.0f, 0, foc ? 2.0f : 1.0f);
            ImVec2 ts = ImGui::CalcTextSize(kPresetNames[i]);
            dl->AddText(ImVec2(bp.x + (pw - ts.x) * 0.5f, bp.y + (30.0f - ts.y) * 0.5f),
                        ColAlpha(sel ? Palette::TextHi : Palette::TextMid, alpha), kPresetNames[i]);
        }
        ImGui::PopFont();
        y += 44.0f;

        ImGui::PushFont(fonts.mono);
        dl->AddText(ImVec2(x, y), ColAlpha(Palette::TextMid, alpha), "RENDER RESOLUTION");
        ImGui::PopFont();
        y += 20.0f;
        ImGui::SetCursorPos(ImVec2(x, y));
        ImGui::SetNextItemWidth(w);
        if (ImGui::Combo("##res_combo", &app.config.resIndex, kResNames, 4)) {
            changed = true;
            sfx.Play(SfxId::Click, 0.60f);
        }
        y += 50.0f;

        ImGui::PushFont(fonts.mono);
        dl->AddText(ImVec2(x, y), ColAlpha(Palette::TextMid, alpha), "FRAME RATE TARGET");
        dl->AddText(ImVec2(x + w * 0.52f, y), ColAlpha(Palette::TextMid, alpha), "CASCADE SHADOWS");
        ImGui::PopFont();
        y += 20.0f;
        ImGui::SetCursorPos(ImVec2(x, y));
        ImGui::SetNextItemWidth(w * 0.48f);
        if (ImGui::Combo("##fps_combo", &app.config.fpsIndex, kFpsNames, 3)) {
            changed = true;
            sfx.Play(SfxId::Click, 0.60f);
        }
        ImGui::SetCursorPos(ImVec2(x + w * 0.52f, y));
        ImGui::SetNextItemWidth(w * 0.48f);
        if (ImGui::Combo("##shd_combo", &app.config.shadowsIndex, kShadowNames, 4)) {
            changed = true;
            sfx.Play(SfxId::Click, 0.60f);
        }
        y += 54.0f;

        ImGui::PushFont(fonts.mono);
        char rdLbl[64];
        if (app.config.renderDistance < 0) std::snprintf(rdLbl, sizeof(rdLbl), "RENDER DISTANCE: ENGINE DEFAULT");
        else std::snprintf(rdLbl, sizeof(rdLbl), "RENDER DISTANCE: %d / 100", app.config.renderDistance);
        dl->AddText(ImVec2(x, y), ColAlpha(Palette::TextMid, alpha), rdLbl);
        ImGui::PopFont();
        y += 20.0f;
        ImGui::SetCursorPos(ImVec2(x, y));
        ImGui::SetNextItemWidth(w - 92.0f);
        if (ImGui::SliderInt("##rd_slider", &app.config.renderDistance, -1, 100,
                             app.config.renderDistance < 0 ? "Default" : "%d%%")) {
            changed = true;
        }
        ImGui::SetCursorPos(ImVec2(x + w - 82.0f, y));
        if (ImGui::Button("RESET", ImVec2(82.0f, 36.0f))) {
            app.config.renderDistance = -1;
            changed = true;
            sfx.Play(SfxId::Click, 0.55f);
        }
        y += 52.0f;

        ImGui::PushFont(fonts.mono);
        dl->AddText(ImVec2(x, y), ColAlpha(Palette::TextMid, alpha), "PC LAUNCH VIEWPORT");
        ImGui::PopFont();
        y += 20.0f;
        ImGui::SetCursorPos(ImVec2(x, y));
        ImGui::SetNextItemWidth(w);
        if (ImGui::Combo("##vp_combo", &app.config.viewportMode, kViewportNames, 4)) {
            changed = true;
            sfx.Play(SfxId::Click, 0.60f);
        }
    }

    // Right Glass Panel: Console Shell + Real PC Enhancement Suite
    {
        ImVec2 p0(marginX + colW + gap, cardsTop), p1(p0.x + colW, cardsTop + cardH);
        DrawGlassCard(dl, p0, p1, 16.0f, kPs5Blue, 0.22f, alpha, false);

        float x = p0.x + 24.0f;
        float w = colW - 48.0f;
        float y = p0.y + 20.0f;

        ImGui::PushFont(fonts.subtitle);
        dl->AddText(ImVec2(x, y), ColAlpha(Palette::TextHi, alpha), "Console UI & PC Enhancements");
        ImGui::PopFont();
        y += 36.0f;

        ImGui::PushFont(fonts.mono);
        dl->AddText(ImVec2(x, y), ColAlpha(Palette::TextMid, alpha), "ACTIVE CONSOLE DASHBOARD");
        ImGui::PopFont();
        y += 20.0f;
        ImGui::SetCursorPos(ImVec2(x, y));
        ImGui::SetNextItemWidth(w);
        if (ImGui::Combo("##console_combo", &app.config.consoleTarget, kConsoleNames, 3)) {
            changed = true;
            sfx.Play(SfxId::Click, 0.65f);
        }
        y += 52.0f;

        dl->AddLine(ImVec2(x, y), ImVec2(x + w, y), ColAlpha(ImVec4(1, 1, 1, 0.09f), alpha));
        y += 16.0f;

        ImGui::SetCursorPos(ImVec2(x, y));
        if (ImGui::Checkbox("Optimization Mode (Keep Same Visuals)", &app.config.optimizationMode)) {
            changed = true;
            sfx.Play(SfxId::Click, 0.60f);
        }
        y += 26.0f;
        dl->AddText(nullptr, 13.5f, ImVec2(x + 28.0f, y), ColAlpha(Palette::TextDim, alpha),
                    "Locks discrete high-perf GPU, clamps HiDPI fillrate & trims hidden PostFX.");
        y += 28.0f;

        ImGui::SetCursorPos(ImVec2(x, y));
        if (ImGui::Checkbox("Motion Blur (Directional GPU Smoothing)", &app.config.motionBlur)) {
            changed = true;
            sfx.Play(SfxId::Click, 0.60f);
        }
        y += 30.0f;

        ImGui::SetCursorPos(ImVec2(x + 28.0f, y));
        ImGui::SetNextItemWidth(w - 28.0f);
        if (ImGui::SliderInt("##mblur_str", &app.config.motionBlurStrength, 0, 100, "Blur Intensity: %d%%")) {
            changed = true;
        }
        y += 40.0f;

        ImGui::SetCursorPos(ImVec2(x, y));
        ImGui::SetNextItemWidth(w - 86.0f);
        if (ImGui::SliderInt("##look_sens", &app.config.lookSensitivity, 20, 300, "GTA V Sensitivity: %d%%")) {
            changed = true;
        }
        ImGui::SetCursorPos(ImVec2(x + w - 78.0f, y));
        if (ImGui::Button("100%", ImVec2(78.0f, 36.0f))) {
            app.config.lookSensitivity = 100;
            changed = true;
            sfx.Play(SfxId::Click, 0.55f);
        }
        y += 44.0f;

        ImGui::SetCursorPos(ImVec2(x, y));
        if (ImGui::Checkbox("Real Hardware Debug HUD (CPU / GPU / VRAM / FPS)", &app.config.showDebugHud)) {
            changed = true;
            sfx.Play(SfxId::Click, 0.60f);
        }
        y += 32.0f;

        ImGui::SetCursorPos(ImVec2(x, y));
        if (ImGui::Checkbox("In-Game Cheat Menu Overlay (F2 / L3+R3)", &app.config.enableCheatMenu)) {
            changed = true;
            sfx.Play(SfxId::Click, 0.60f);
        }
        y += 38.0f;

        dl->AddRectFilled(ImVec2(x, y), ImVec2(x + w, y + 46.0f), ColAlpha(ImVec4(0.03f, 0.05f, 0.09f, 0.86f), alpha), 9.0f);
        dl->AddRect(ImVec2(x, y), ImVec2(x + w, y + 46.0f), ColAlpha(Palette::Cyan, 0.26f * alpha), 9.0f);
        dl->AddText(nullptr, 13.0f, ImVec2(x + 12.0f, y + 8.0f), ColAlpha(Palette::TextMid, 0.94f * alpha),
                    "Mouse & Controller sensitivity, Motion Blur & toggles sync live\nwith PS5/Xbox Settings and GTA V in-game drawer (F2 / L3+R3).",
                    nullptr, w - 24.0f);
    }

    if (changed) {
        SaveConfig(app.config);
        app.SyncToShared(shared, sharedMu);
    }

    ImGui::PopStyleVar();
}

// ==================== TAB 2: HYPERVISOR DIAGNOSTIC LOG ====================
static void RenderLogTab(AppState& app, const FontSet& fonts, SoundEngine& sfx,
                         float winW, float winH, float alpha) {
    ImDrawList* dl = ImGui::GetWindowDrawList();
    const float marginX = std::max(32.0f, (winW - 1060.0f) * 0.5f);
    const float contentW = winW - marginX * 2.0f;
    const float topY = static_cast<float>(kHeaderHeight) + 20.0f + (1.0f - alpha) * 14.0f;

    ImGui::PushFont(fonts.mono);
    dl->AddText(ImVec2(marginX, topY), ColAlpha(Palette::Emerald, 0.90f * alpha),
                "REAL-TIME TELEMETRY, LOCAL PROXY & LAUNCH DIAGNOSTICS");
    ImGui::PopFont();

    ImGui::PushFont(fonts.title);
    dl->AddText(ImVec2(marginX, topY + 18.0f), ColAlpha(Palette::TextHi, alpha), "Hypervisor Log");
    ImGui::PopFont();

    ImGui::SetCursorPos(ImVec2(winW - marginX - 118.0f, topY + 18.0f));
    if (ImGui::Button("COPY LOG", ImVec2(118.0f, 34.0f))) {
        std::string all;
        for (const auto& l : app.logs) all += l + "\n";
        ImGui::SetClipboardText(all.c_str());
        sfx.Play(SfxId::Click, 0.70f);
        app.ShowToast("Hypervisor log copied to clipboard.", Palette::Emerald);
    }

    const float boxTop = topY + 64.0f;
    const float boxH = std::max(380.0f, winH - boxTop - 24.0f);
    ImVec2 p0(marginX, boxTop), p1(winW - marginX, boxTop + boxH);
    DrawGlassCard(dl, p0, p1, 14.0f, Palette::Cyan, 0.15f, alpha, false);

    ImGui::PushStyleVar(ImGuiStyleVar_Alpha, alpha);
    ImGui::SetCursorPos(ImVec2(p0.x + 16.0f, p0.y + 14.0f));
    ImGui::BeginChild("##log_scroll", ImVec2(contentW - 32.0f, boxH - 28.0f), false);
    ImGui::PushFont(fonts.mono);
    for (const auto& line : app.logs) {
        ImVec4 col = Palette::TextMid;
        if (line.find("[AUTH]") != std::string::npos || line.find("[LAUNCH]") != std::string::npos) col = Palette::Emerald;
        else if (line.find("[DEV]") != std::string::npos) col = kDevGold;
        else if (line.find("[HTTP]") != std::string::npos || line.find("[CONSOLE]") != std::string::npos) col = Palette::Cyan;
        ImGui::TextColored(col, "%s", line.c_str());
    }
    ImGui::PopFont();
    ImGui::EndChild();
    ImGui::PopStyleVar();
}

// ==================== TAB 3: FOXXY SECRET DEVELOPER SUITE ====================
static void RenderDeveloperTab(AppState& app, const FontSet& fonts, SoundEngine& sfx,
                               ParticleSystem& particles, LocalHttpServer& server,
                               SharedEmulatorState& shared, std::mutex& sharedMu,
                               DevTargetController& devCtrl,
                               float winW, float winH, float dt, float alpha) {
    ImDrawList* dl = ImGui::GetWindowDrawList();
    const float marginX = std::max(32.0f, (winW - 1060.0f) * 0.5f);
    const float contentW = winW - marginX * 2.0f;
    const float topY = static_cast<float>(kHeaderHeight) + 18.0f + (1.0f - alpha) * 14.0f;

    ImGui::PushFont(fonts.mono);
    dl->AddText(ImVec2(marginX, topY), ColAlpha(kDevGold, 0.95f * alpha),
                "FOXXY DEVELOPER ACCESS  ·  GTA VI .EXE HOOK, FULL DEV OVERLAY & FAKE FPS CAP");
    ImGui::PopFont();

    ImGui::PushFont(fonts.title);
    dl->AddText(ImVec2(marginX, topY + 18.0f), ColAlpha(Palette::TextHi, alpha), "Developer Settings");
    ImGui::PopFont();

    const float boxTop = topY + 60.0f;
    const float boxH = std::max(450.0f, winH - boxTop - 20.0f);
    ImVec2 p0(marginX, boxTop), p1(marginX + contentW, boxTop + boxH);
    DrawGlassCard(dl, p0, p1, 16.0f, kDevGold, 0.30f, alpha, false);

    ImGui::PushStyleVar(ImGuiStyleVar_Alpha, alpha);

    float x = p0.x + 26.0f;
    float w = contentW - 52.0f;
    float y = p0.y + 18.0f;

    const bool hasExe = IsExeFilePath(app.config.devGta6ExePath);
    const DevTargetStatus devSt = devCtrl.GetStatus();

    DrawStatusPill(dl, ImVec2(x, y), "OPERATOR: FOXXY  ·  ROOT DEVKIT", kDevGold, alpha, true);
    if (hasExe) {
        DrawStatusPill(dl, ImVec2(x + 275.0f, y), ".EXE TARGET ARMED (OVERLAY + FPS CAP READY)", Palette::Emerald, alpha, true);
    } else if (!app.config.devGta6ExePath.empty()) {
        DrawStatusPill(dl, ImVec2(x + 275.0f, y), "NON-.EXE FILE (DEV OVERLAY / FPS CAP REQUIRE .EXE)", Palette::VicePink, alpha, true);
    }
    y += 38.0f;

    bool devChanged = false;

    // 1. Toggle GTA VI Emulation
    ImGui::SetCursorPos(ImVec2(x, y));
    if (ImGui::Checkbox("Enable GTA VI Emulation (Unlock GTA VI in Emulators + PS5/Xbox UI)", &app.config.devGta6Enabled)) {
        devChanged = true;
        sfx.Play(SfxId::Click, 0.75f);
        app.PushLog(std::string("[DEV] GTA VI Dev Override ") + (app.config.devGta6Enabled ? "ENABLED" : "DISABLED"));
        app.ShowToast(app.config.devGta6Enabled ? "GTA VI Emulation ENABLED for Foxxy!" : "GTA VI Emulation disabled.", kDevGold);
    }
    y += 36.0f;

    // 2. Custom File Picker (ANY FILE TYPE!) + Editable Path / URL Box
    ImGui::PushFont(fonts.mono);
    dl->AddText(ImVec2(x, y), ColAlpha(Palette::TextMid, alpha), "CUSTOM GTA VI LAUNCH TARGET (.EXE UNLOCKS FULLSCREEN DEV OVERLAY & FAKE FPS CAP)");
    ImGui::PopFont();
    y += 20.0f;

    float pathBoxW = w - 274.0f;
    ImGui::SetCursorPos(ImVec2(x, y + 2.0f));
    ImGui::SetNextItemWidth(pathBoxW);
    ImGui::PushStyleVar(ImGuiStyleVar_FrameBorderSize, 1.0f);
    if (ImGui::InputTextWithHint("##dev_path_inp", "Browse any .exe (for Full Dev Overlay + Fake FPS Cap) or any other file/URL",
                                 app.devPathBuf, sizeof(app.devPathBuf))) {
        app.config.devGta6ExePath = app.devPathBuf;
        devChanged = true;
    }
    ImGui::PopStyleVar();

    ImGui::SetCursorPos(ImVec2(x + pathBoxW + 12.0f, y));
    ImGui::PushFont(fonts.bold);
    bool browseClick = DrawNeonButton("##dev_browse", "BROWSE FILE...", ImVec2(172.0f, 40.0f),
                                      kDevGoldDk, kDevGold, app.btnDevBrowseHover, dt, sfx, false, alpha);
    ImGui::PopFont();
    if (browseClick) {
        std::string picked = PickCustomFileDialog(g_hWnd);
        if (!picked.empty()) {
            app.config.devGta6ExePath = picked;
            std::snprintf(app.devPathBuf, sizeof(app.devPathBuf), "%s", picked.c_str());
            app.config.devGta6Enabled = true;
            devChanged = true;
            app.PushLog("[DEV] Bound GTA VI custom target file: " + picked);
            app.ShowToast(IsExeFilePath(picked)
                              ? "Selected .EXE! Full Dev Overlay & Fake FPS Limiter armed on launch."
                              : "Selected GTA VI target file! Launch it from inside the PS5 or Xbox UI.",
                          kDevGold);
        }
    }

    ImGui::SetCursorPos(ImVec2(x + pathBoxW + 192.0f, y));
    if (ImGui::Button("CLEAR", ImVec2(82.0f, 40.0f))) {
        app.config.devGta6ExePath.clear();
        app.devPathBuf[0] = '\0';
        devChanged = true;
        sfx.Play(SfxId::Click, 0.60f);
    }
    y += 52.0f;

    // 3. Two-Column DevKit Controls: Full-Screen Dev Overlay (Left) + Fake FPS Limiter (Right)
    float halfGap = 16.0f;
    float halfW = (w - halfGap) * 0.5f;
    float panelH = 148.0f;

    // Left Sub-Card: Full-Screen Windows GTA VI Dev Overlay (.exe only)
    {
        ImVec2 c0(x, y), c1(x + halfW, y + panelH);
        dl->AddRectFilled(c0, c1, ColAlpha(ImVec4(0.05f, 0.08f, 0.14f, 0.78f), alpha), 10.0f);
        dl->AddRect(c0, c1, ColAlpha(Palette::Cyan, 0.36f * alpha), 10.0f);

        float cx = c0.x + 14.0f, cy = c0.y + 12.0f;
        ImGui::SetCursorPos(ImVec2(cx, cy));
        if (ImGui::Checkbox("Full-Screen GTA VI Dev Overlay (.EXE)", &app.config.devFullOverlay)) {
            devChanged = true;
            sfx.Play(SfxId::Click, 0.70f);
            app.PushLog(std::string("[DEV] Full-Screen GTA VI Dev Overlay ") + (app.config.devFullOverlay ? "ON" : "OFF"));
        }
        cy += 34.0f;
        dl->AddText(nullptr, 13.5f, ImVec2(cx, cy), ColAlpha(Palette::TextMid, 0.94f * alpha),
                    "Draws a fullscreen click-through RAGE 9 DevKit HUD across Windows\n"
                    "(Top-Left FPS/Graph/World, Left Subsystems/Log, Top-Right Real\n"
                    "CPU/GPU/VRAM/.EXE RAM, Right Heaps/Input, Bottom Status Strip).\n"
                    "Press F10 anytime in-game to hide or show the overlay.",
                    nullptr, halfW - 28.0f);
    }

    // Right Sub-Card: Fake FPS Limiter (Cap Launched .EXE Max FPS)
    {
        ImVec2 c0(x + halfW + halfGap, y), c1(c0.x + halfW, y + panelH);
        dl->AddRectFilled(c0, c1, ColAlpha(ImVec4(0.10f, 0.07f, 0.02f, 0.72f), alpha), 10.0f);
        dl->AddRect(c0, c1, ColAlpha(app.config.devFakeFpsEnabled ? kDevGold : ImVec4(1, 1, 1, 0.14f), 0.55f * alpha), 10.0f);

        float cx = c0.x + 14.0f, cy = c0.y + 12.0f;
        ImGui::SetCursorPos(ImVec2(cx, cy));
        if (ImGui::Checkbox("Fake FPS Limiter (Cap Target .EXE Max FPS)", &app.config.devFakeFpsEnabled)) {
            devChanged = true;
            sfx.Play(SfxId::Click, 0.70f);
            app.PushLog(std::string("[DEV] Fake FPS Cap ") +
                        (app.config.devFakeFpsEnabled ? ("ENABLED (" + std::to_string(app.config.devFakeFpsLimit) + " FPS max)") : "DISABLED"));
        }
        cy += 34.0f;

        ImGui::BeginDisabled(!app.config.devFakeFpsEnabled);
        ImGui::SetCursorPos(ImVec2(cx, cy));
        ImGui::SetNextItemWidth(halfW - 28.0f);
        if (ImGui::SliderInt("##dev_fake_fps", &app.config.devFakeFpsLimit, 5, 144, "Max Cap: %d FPS")) {
            devChanged = true;
        }
        cy += 42.0f;

        // Quick FPS cap presets
        static const int kCaps[] = { 10, 15, 24, 30, 45, 60 };
        float btnGap = 6.0f;
        float btnW = (halfW - 28.0f - btnGap * 5.0f) / 6.0f;
        ImGui::PushFont(fonts.mono);
        for (int i = 0; i < 6; ++i) {
            ImGui::SetCursorPos(ImVec2(cx + i * (btnW + btnGap), cy));
            char bLbl[16];
            std::snprintf(bLbl, sizeof(bLbl), "%d##cap", kCaps[i]);
            if (ImGui::Button(bLbl, ImVec2(btnW, 28.0f))) {
                app.config.devFakeFpsLimit = kCaps[i];
                devChanged = true;
                sfx.Play(SfxId::Click, 0.55f);
            }
        }
        ImGui::PopFont();
        ImGui::EndDisabled();

        cy += 34.0f;
        dl->AddText(nullptr, 12.5f, ImVec2(cx, cy), ColAlpha(Palette::TextDim, 0.92f * alpha),
                    "Paces the launched .exe process so it runs at most your selected FPS.",
                    nullptr, halfW - 28.0f);
    }
    y += panelH + 14.0f;

    if (devChanged) {
        SaveConfig(app.config);
        app.SyncToShared(shared, sharedMu);
        devCtrl.UpdateSettings(app.config.devFullOverlay, app.config.devFakeFpsEnabled, app.config.devFakeFpsLimit);
    }

    // 4. Live Status Strip (or Strict Console-Only Notice when idle)
    if (devSt.running) {
        dl->AddRectFilled(ImVec2(x, y), ImVec2(x + w, y + 54.0f),
                          ColAlpha(ImVec4(0.05f, 0.16f, 0.10f, 0.72f), alpha), 10.0f);
        dl->AddRect(ImVec2(x, y), ImVec2(x + w, y + 54.0f), ColAlpha(Palette::Emerald, 0.65f * alpha), 10.0f);
        char runLine[256];
        std::string capLabel = devSt.fakeFpsActive ? (std::to_string(devSt.fakeFpsLimit) + " MAX") : "OFF";
        std::snprintf(runLine, sizeof(runLine),
                      "ACTIVE TARGET: %s (PID %lu)  ·  OVERLAY: %s  ·  FPS CAP: %s",
                      devSt.exeName.c_str(), static_cast<unsigned long>(devSt.pid),
                      devSt.overlayVisible ? "FULLSCREEN ON" : "HIDDEN",
                      capLabel.c_str());
        ImGui::PushFont(fonts.mono);
        dl->AddText(ImVec2(x + 14.0f, y + 19.0f), ColAlpha(Palette::TextHi, alpha), runLine);
        ImGui::PopFont();

        ImGui::SetCursorPos(ImVec2(x + w - 188.0f, y + 10.0f));
        if (ImGui::Button("DETACH OVERLAY / CAP", ImVec2(176.0f, 34.0f))) {
            devCtrl.StopSession();
            sfx.Play(SfxId::Click, 0.70f);
            app.ShowToast("Detached Dev Overlay & resumed target .exe cleanly.", Palette::Cyan);
        }
    } else {
        dl->AddRectFilled(ImVec2(x, y), ImVec2(x + w, y + 54.0f),
                          ColAlpha(ImVec4(0.14f, 0.10f, 0.03f, 0.55f), alpha), 10.0f);
        dl->AddRect(ImVec2(x, y), ImVec2(x + w, y + 54.0f), ColAlpha(kDevGold, 0.42f * alpha), 10.0f);
        dl->AddText(nullptr, 13.5f, ImVec2(x + 14.0f, y + 10.0f), ColAlpha(Palette::TextHi, 0.92f * alpha),
                    "CONSOLE-UI LAUNCH RULE: Selected file launches ONLY when you press Play on Grand Theft Auto VI\n"
                    "inside PS5 or Xbox UI. When a .exe is launched, the Full Dev Overlay & Fake FPS Cap engage automatically.",
                    nullptr, w - 28.0f);
    }
    y += 66.0f;

    // 5. Boot Console UI with GTA VI Mounted OR ALL Mode (GTA V + GTA VI)
    const int devCt = std::max(0, std::min(2, app.config.consoleTarget));
    char devBootLbl[80];
    std::snprintf(devBootLbl, sizeof(devBootLbl), "OPEN %s UI  (GTA VI MOUNTED)", GetConsoleTag(devCt));
    ImGui::SetCursorPos(ImVec2(x, y));
    ImVec2 bCenter{};
    ImGui::PushFont(fonts.bold);
    bool bootDevConsole = !app.launching && DrawNeonButton(
        "##dev_boot_console", devBootLbl,
        ImVec2(360.0f, 44.0f), kDevGoldDk, kDevGold, app.btnDevLaunchHover, dt, sfx,
        !(app.config.devGta6Enabled && !app.config.devGta6ExePath.empty()), alpha, &bCenter);
    ImGui::PopFont();

    if (bootDevConsole) {
        if (!app.config.devGta6Enabled || app.config.devGta6ExePath.empty()) {
            app.ShowToast("Enable GTA VI Emulation and pick any file first.", kDevGold);
        } else {
            TriggerConsoleLaunch(app, server, shared, sharedMu, sfx, particles, bCenter, "gta6", false);
        }
    }

    ImGui::SetCursorPos(ImVec2(x + 376.0f, y));
    ImVec2 bAllCenter{};
    ImGui::PushFont(fonts.bold);
    bool bootDevAll = !app.launching && DrawNeonButton(
        "##dev_boot_all", "OPEN ALL MODE  (GTA V + VI · BUGGY)",
        ImVec2(340.0f, 44.0f), ImVec4(0.45f, 0.12f, 0.34f, 1.0f), Palette::VicePink,
        app.btnDevAllHover, dt, sfx, false, alpha, &bAllCenter);
    ImGui::PopFont();
    if (bootDevAll) {
        TriggerConsoleLaunch(app, server, shared, sharedMu, sfx, particles, bAllCenter, "all", false);
    }

    ImGui::PopStyleVar();
}

// ==================== CONSOLE HYPERVISOR LAUNCH OVERLAY ====================
static void RenderLaunchOverlay(AppState& app, const FontSet& fonts, SoundEngine& sfx,
                                ParticleSystem& particles, EmbeddedViewportHost& viewportHost,
                                float winW, float winH, float dt, float time) {
    app.launchOverlayAlpha = ExpLerp(app.launchOverlayAlpha, app.launching ? 1.0f : 0.0f, 10.0f, dt);
    if (app.launchOverlayAlpha < 0.01f) return;

    if (app.launching) {
        const bool useEmbedded = (app.config.viewportMode <= 1) && viewportHost.IsSupportedBuild();
        app.launchProgress += dt * (useEmbedded ? 1.25f : 0.72f);
        if (app.launchProgress >= 1.0f && !app.launchDispatched) {
            app.launchDispatched = true;
            particles.EmitBurst(ImVec2(winW * 0.5f, winH * 0.5f), 26, app.launchAccent, Palette::Cyan);
            sfx.Play(SfxId::LoginSuccess, 0.75f);

            if (useEmbedded) {
                ExpandWindowForViewport(g_hWnd);
                if (app.config.viewportMode == 1) {
                    SetBorderlessFullscreen(g_hWnd, true);
                }
                RECT rc{};
                GetClientRect(g_hWnd, &rc);
                bool ok = viewportHost.OpenUrl(app.launchTargetUrl, ActiveViewportTopOffset(),
                                               rc.right - rc.left, rc.bottom - rc.top);
                if (ok) {
                    app.launchViewportStatus = "Embedded ViceBox X Viewport (WebView2)";
                    app.PushLog("[VIEWPORT] Mounted INSIDE ViceBox X emulator viewport -> " + app.launchTargetUrl);
                    app.launching = false;
                    app.launchOverlayAlpha = 0.0f;
                    app.ShowToast("Running INSIDE ViceBox X Viewport (F11 for Fullscreen)", app.launchAccent);
                    return;
                }
            }

            // Fallback / User-selected External Window Mode
            app.launchViewportStatus = LaunchGameViewport(
                app.launchTargetUrl, app.config.viewportMode, app.config.optimizationMode);
            app.PushLog("[VIEWPORT] Launched via " + app.launchViewportStatus);
        }
        if (app.launchProgress >= 1.75f) {
            app.launching = false;
            app.ShowToast("Console Viewport active via " + app.launchViewportStatus, app.launchAccent);
        }
    }

    float a = app.launchOverlayAlpha;
    ImDrawList* dl = ImGui::GetForegroundDrawList();
    dl->AddRectFilled(ImVec2(0, 0), ImVec2(winW, winH), ColAlpha(ImVec4(0.02f, 0.03f, 0.06f, 0.78f), a));

    const float bw = 490.0f, bh = 290.0f;
    ImVec2 c0((winW - bw) * 0.5f, (winH - bh) * 0.5f);
    ImVec2 c1(c0.x + bw, c0.y + bh);
    DrawGlassCard(dl, c0, c1, 18.0f, app.launchAccent, 0.65f, a, false);

    DrawSpinnerRing(dl, ImVec2(c0.x + bw * 0.5f, c0.y + 88.0f), 36.0f, 4.2f, time, app.launchAccent, Palette::Cyan, a);

    float p = std::clamp(app.launchProgress, 0.0f, 1.0f);
    const char* title = app.launchDispatched ? "EMULATOR VIEWPORT ACTIVE" : app.launchBannerTitle.c_str();
    ImGui::PushFont(fonts.subtitle);
    ImVec2 tSz = ImGui::CalcTextSize(title);
    dl->AddText(ImVec2(c0.x + (bw - tSz.x) * 0.5f, c0.y + 144.0f), ColAlpha(Palette::TextHi, a), title);
    ImGui::PopFont();

    const bool useEmbedded = (app.config.viewportMode <= 1) && viewportHost.IsSupportedBuild();
    const char* stage = (p < 0.35f) ? app.launchSubtitle.c_str()
                      : (p < 0.72f) ? "Syncing Local COOP/COEP Proxy & PC Enhancement Layer..."
                      : (p < 0.99f) ? (useEmbedded ? "Mounting Embedded WebGPU Emulator Viewport..."
                                                   : "Handing Off External WebGPU Console Viewport...")
                                    : "Console Viewport Active!";
    ImGui::PushFont(fonts.mono);
    ImVec2 sSz = ImGui::CalcTextSize(stage);
    dl->AddText(ImVec2(c0.x + (bw - sSz.x) * 0.5f, c0.y + 178.0f), ColAlpha(app.launchAccent, 0.94f * a), stage);
    ImGui::PopFont();

    float barW = bw - 84.0f;
    ImVec2 pb0(c0.x + 42.0f, c0.y + 218.0f);
    ImVec2 pb1(pb0.x + barW, pb0.y + 8.0f);
    dl->AddRectFilled(pb0, pb1, ColAlpha(ImVec4(1, 1, 1, 0.08f), a), 4.0f);
    float fillW = std::max(8.0f, barW * EaseOutCubic(p));
    dl->AddRectFilledMultiColor(
        pb0, ImVec2(pb0.x + fillW, pb1.y),
        ColAlpha(app.launchAccent, a), ColAlpha(Palette::Cyan, a),
        ColAlpha(Palette::Cyan, a), ColAlpha(app.launchAccent, a));
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
    HRESULT comHr = CoInitializeEx(nullptr, COINIT_APARTMENTTHREADED);
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

    RECT workArea{};
    SystemParametersInfoW(SPI_GETWORKAREA, 0, &workArea, 0);
    int screenW = workArea.right - workArea.left;
    int screenH = workArea.bottom - workArea.top;
    int winW = std::min(1200, std::max(1000, screenW - 70));
    int winH = std::min(730, std::max(650, screenH - 60));
    int posX = workArea.left + (screenW - winW) / 2;
    int posY = workArea.top + (screenH - winH) / 2;

    g_hWnd = CreateWindowExW(
        WS_EX_APPWINDOW,
        wc.lpszClassName,
        L"VICEBOX X v2.5 — Embedded Console & GTA V PC Emulator",
        WS_POPUP | WS_THICKFRAME | WS_MINIMIZEBOX | WS_MAXIMIZEBOX | WS_SYSMENU | WS_CLIPCHILDREN,
        posX, posY, winW, winH,
        nullptr, nullptr, hInstance, nullptr);

    if (!g_hWnd) {
        if (SUCCEEDED(comHr)) CoUninitialize();
        return 1;
    }

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
    if (!app.config.devGta6ExePath.empty()) {
        std::snprintf(app.devPathBuf, sizeof(app.devPathBuf), "%s", app.config.devGta6ExePath.c_str());
    }

    if (!CreateDeviceD3D(g_hWnd, app.hw.gpuName)) {
        CleanupDeviceD3D();
        UnregisterClassW(wc.lpszClassName, hInstance);
        return 1;
    }

    // Start Real Windows Hardware Monitor (CPU%, GPU 3D%, VRAM MB, RAM GB)
    HwMonitor hwMonitor;
    hwMonitor.Start();

    // Initialize Full-Screen Windows GTA VI Dev Overlay & Target .EXE Max-FPS Limiter
    DevTargetController devCtrl;
    devCtrl.Init(&hwMonitor);
    devCtrl.UpdateSettings(app.config.devFullOverlay, app.config.devFakeFpsEnabled, app.config.devFakeFpsLimit);

    // Start Embedded Local Console & GTA V COOP/COEP Proxy HTTP Server
    SharedEmulatorState sharedState;
    std::mutex sharedMu;
    app.SyncToShared(sharedState, sharedMu, "gta5");

    LocalHttpServer httpServer;
    bool serverOk = httpServer.Start(&hwMonitor, &sharedState, &sharedMu, &devCtrl);
    app.serverPort = httpServer.Port();

    // Initialize Embedded Microsoft Edge WebView2 Viewport Host (renders consoles + GTA V inside ViceBox X!)
    EmbeddedViewportHost viewportHost;
    g_ViewportHost = &viewportHost;
    viewportHost.Init(g_hWnd, GetEmbeddedWebViewDir(), app.config.optimizationMode);
    viewportHost.SetCallbacks(
        [&](bool enterFs) {
            SetBorderlessFullscreen(g_hWnd, enterFs);
        },
        [&](const std::string& url) {
            if (g_BorderlessFs) SetBorderlessFullscreen(g_hWnd, false);
            viewportHost.StopSession();
            std::string via = LaunchGameViewport(url, 2, app.config.optimizationMode);
            app.PushLog("[VIEWPORT] WebView2 unavailable — opened external window via " + via);
            app.ShowToast("WebView2 runtime missing — opened in external window", kDevGold);
        },
        [&](const std::string& msg) {
            app.PushLog(msg);
        });

    ShowWindow(g_hWnd, SW_SHOWDEFAULT);
    UpdateWindow(g_hWnd);

    IMGUI_CHECKVERSION();
    ImGui::CreateContext();
    ImGuiIO& io = ImGui::GetIO();
    io.IniFilename = nullptr;
    io.ConfigFlags |= ImGuiConfigFlags_NavEnableKeyboard;
    io.ConfigFlags |= ImGuiConfigFlags_NavEnableGamepad;

    FontSet fonts = LoadSystemFonts(io);
    ApplyCleanObsidianStyle();

    ImGui_ImplWin32_Init(g_hWnd);
    ImGui_ImplDX11_Init(g_pd3dDevice, g_pd3dDeviceContext);

    SoundEngine sfx;
    sfx.Init();
    sfx.Play(SfxId::Startup, 0.85f);

    ParticleSystem particles;
    particles.Init(static_cast<float>(winW), static_cast<float>(winH));

    app.PushLog("[HYPERVISOR] ViceBox X v2.5 initialized (Embedded WebGPU Emulator Viewport + ALL Mode + ViceOS Neo)");
    app.PushLog(viewportHost.IsSupportedBuild()
                    ? "[VIEWPORT] Embedded Edge WebView2 Host compiled in (zero external DLLs, static loader)"
                    : "[VIEWPORT] WebView2 SDK not present in build — using external frameless window fallback");
    app.PushLog("[D3D11] Active GPU: " + app.hw.gpuName);
    app.PushLog("[HWMON] Real Windows CPU/GPU/VRAM/RAM telemetry monitor started");
    if (serverOk) {
        app.PushLog("[HTTP] Embedded console & GTA V COOP/COEP proxy active at " + httpServer.BaseUrl());
        app.PushLog("[ASSETS] Mounted PS5_Online UI, DashX360 Metro+Blades, ViceOS Neo, GTA 6 Updates & 29 game artworks");
    } else {
        app.PushLog("[HTTP] ERROR: Failed to start local server on 127.0.0.1");
    }

    auto prevClock = std::chrono::steady_clock::now();
    float elapsedTime = 0.0f;
    float hwPollAcc = 0.0f;
    bool prevF11Down = false;
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
            SyncViewportBounds();
        }

        // Edge-triggered F11 fullscreen toggle even while WebView2 child viewport holds focus!
        bool f11Down = ((GetAsyncKeyState(VK_F11) & 0x8000) != 0);
        if (f11Down && !prevF11Down && viewportHost.IsVisible() && GetForegroundWindow() == g_hWnd) {
            SetBorderlessFullscreen(g_hWnd, !g_BorderlessFs);
        }
        prevF11Down = f11Down;

        auto nowClock = std::chrono::steady_clock::now();
        float dt = std::chrono::duration<float>(nowClock - prevClock).count();
        prevClock = nowClock;
        dt = std::clamp(dt, 0.001f, 0.05f);
        elapsedTime += dt;

        // Pull live real PC hardware metrics & any config edits made inside PS5/Xbox/ViceOS UI
        hwPollAcc += dt;
        if (hwPollAcc >= 0.45f) {
            hwPollAcc = 0.0f;
            app.liveHw = hwMonitor.Get();
            app.PullFromSharedIfDirty(sharedState, sharedMu);
        }

        ImGui_ImplDX11_NewFrame();
        ImGui_ImplWin32_NewFrame();
        ImGui::NewFrame();

        const ImVec2 disp = io.DisplaySize;

        if (!viewportHost.IsVisible()) {
            particles.UpdateAndRender(ImGui::GetBackgroundDrawList(), ImVec2(0, 0), disp, io.MousePos, dt, elapsedTime);
        }

        ImGui::SetNextWindowPos(ImVec2(0, 0));
        ImGui::SetNextWindowSize(disp);
        ImGui::Begin("##ViceBoxRoot", nullptr,
                     ImGuiWindowFlags_NoDecoration | ImGuiWindowFlags_NoMove |
                     ImGuiWindowFlags_NoResize | ImGuiWindowFlags_NoSavedSettings |
                     ImGuiWindowFlags_NoBackground | ImGuiWindowFlags_NoBringToFrontOnFocus);

        RenderHeaderBar(app, fonts, sfx, particles, httpServer, sharedState, sharedMu, viewportHost,
                        disp.x, dt, elapsedTime);

        if (viewportHost.IsVisible()) {
            // While WebView2 finishes spinning up (~200ms cold start), show a clean centered loader!
            if (!viewportHost.IsReady()) {
                ImDrawList* dl = ImGui::GetWindowDrawList();
                float vpTop = static_cast<float>(ActiveViewportTopOffset());
                float vpH = std::max(100.0f, disp.y - vpTop);
                ImVec2 center(disp.x * 0.5f, vpTop + vpH * 0.5f - 18.0f);
                DrawSpinnerRing(dl, center, 34.0f, 4.0f, elapsedTime,
                                GetConsoleAccent(app.config.consoleTarget), Palette::Cyan, 1.0f);
                ImGui::PushFont(fonts.subtitle);
                const char* ldTitle = "INITIALIZING EMBEDDED WEBGPU VIEWPORT...";
                ImVec2 ts = ImGui::CalcTextSize(ldTitle);
                dl->AddText(ImVec2(center.x - ts.x * 0.5f, center.y + 52.0f),
                            ColAlpha(Palette::TextHi, 0.96f), ldTitle);
                ImGui::PopFont();
                ImGui::PushFont(fonts.mono);
                const char* ldSub = "Microsoft Edge WebView2 · COOP/COEP + WebGPU + Gamepad + Pointer Lock";
                ImVec2 ss = ImGui::CalcTextSize(ldSub);
                dl->AddText(ImVec2(center.x - ss.x * 0.5f, center.y + 84.0f),
                            ColAlpha(Palette::Cyan, 0.86f), ldSub);
                ImGui::PopFont();
            }
        } else if (app.screen == AppScreen::Login) {
            RenderLoginScreen(app, fonts, sfx, particles, sharedState, sharedMu, disp.x, disp.y, dt, elapsedTime);
        } else {
            app.dashFade = ExpLerp(app.dashFade, 1.0f, 7.5f, dt);
            app.tabSlideAlpha = ExpLerp(app.tabSlideAlpha, 1.0f, 10.5f, dt);
            float combinedA = app.dashFade * app.tabSlideAlpha;

            if (app.activeTab == 0) {
                RenderEmulatorsTab(app, fonts, sfx, particles, httpServer, sharedState, sharedMu,
                                   disp.x, disp.y, dt, elapsedTime, combinedA);
            } else if (app.activeTab == 1) {
                RenderConfigTab(app, fonts, sfx, sharedState, sharedMu, disp.x, disp.y, combinedA);
            } else if (app.activeTab == 2) {
                RenderLogTab(app, fonts, sfx, disp.x, disp.y, combinedA);
            } else if (app.activeTab == 3 && app.isFoxxyDev) {
                RenderDeveloperTab(app, fonts, sfx, particles, httpServer, sharedState, sharedMu, devCtrl,
                                   disp.x, disp.y, dt, combinedA);
            }
        }

        if (!g_BorderlessFs) {
            ImGui::GetForegroundDrawList()->AddRect(
                ImVec2(0.5f, 0.5f), ImVec2(disp.x - 0.5f, disp.y - 0.5f),
                IM_COL32(255, 255, 255, 24), 8.0f, 0, 1.0f);
        }

        ImGui::End();

        RenderLaunchOverlay(app, fonts, sfx, particles, viewportHost, disp.x, disp.y, dt, elapsedTime);
        if (!viewportHost.IsVisible()) {
            RenderToast(app, disp.x, disp.y, dt);
        }

        ImGui::Render();
        const float clearColor[4] = { 0.024f, 0.035f, 0.063f, 1.0f };
        g_pd3dDeviceContext->OMSetRenderTargets(1, &g_mainRenderTargetView, nullptr);
        g_pd3dDeviceContext->ClearRenderTargetView(g_mainRenderTargetView, clearColor);
        ImGui_ImplDX11_RenderDrawData(ImGui::GetDrawData());
        g_pSwapChain->Present(1, 0);
    }

    viewportHost.Shutdown();
    g_ViewportHost = nullptr;
    httpServer.Stop();
    devCtrl.Shutdown();
    hwMonitor.Shutdown();
    sfx.Shutdown();
    ImGui_ImplDX11_Shutdown();
    ImGui_ImplWin32_Shutdown();
    ImGui::DestroyContext();
    CleanupDeviceD3D();
    DestroyWindow(g_hWnd);
    UnregisterClassW(wc.lpszClassName, hInstance);
    if (SUCCEEDED(comHr)) CoUninitialize();
    return 0;
}
