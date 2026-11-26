#pragma once

#include <algorithm>
#include <cstdio>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <sstream>
#include <string>
#include <vector>

#ifdef _WIN32
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <winsock2.h>
#include <windows.h>
#include <commdlg.h>
#include <shellapi.h>
#include <shlobj.h>
#endif

namespace vicebox {

struct EmulatorConfig {
    // 0=Ultra, 1=High, 2=Balanced, 3=Low, 4=Potato
    int preset = 1;
    // 0=1920x1080, 1=1600x900, 2=1280x720, 3=960x540
    int resIndex = 1;
    // 0=Uncapped, 1=60 FPS, 2=30 FPS
    int fpsIndex = 1;
    // 0=High(2), 1=Normal(1), 2=Low(0), 3=Off(-1)
    int shadowsIndex = 1;
    // -1 = Engine Default, 0..100 custom LOD scale
    int renderDistance = -1;
    // 0=Title Menu, 1=Story Mode, 2=Sandbox LS, 3=Vice Test Map
    int gta5Mode = 0;
    // 0=Frameless Game Window (--app), 1=Fullscreen App, 2=Default Browser
    int viewportMode = 0;

    // Active console shell: 0 = PlayStation 5 (Xbox->PS5 Port), 1 = Xbox Series X / 360 (DashX360)
    int consoleTarget = 0;

    // PC Enhancement Suite (live-synced with PS5/Xbox UI + pc_overlay.js)
    bool showDebugHud       = true;
    bool enableCheatMenu    = true;
    bool motionBlur         = false;
    int  motionBlurStrength = 55;
    bool optimizationMode   = false;
    int  lookSensitivity    = 100; // 20..300% (Mouse & Controller GTA V camera sensitivity)

    // Session & Profile
    bool rememberSession = true;
    std::string savedGamertag;
    std::string psPlusTier = "Extra";

    // Foxxy Developer Mode (only accessible when signed in as "Foxxy")
    bool devGta6Enabled     = false;
    bool devExpGta6         = false; // Experimental GTA 6 (reskins PlayGTA5 Sandbox -> GTA VI experience)
    bool devPerfAuto        = true;  // Default ON: quiet GTX 1050 (2-4GB VRAM) 1080p @ 60 FPS optimizer
    std::string devGta6ExePath;
    bool devFullOverlay     = true;  // Full-screen Windows Dev Overlay for launched GTA VI .exe
    bool devFakeFpsEnabled  = false; // Cap launched GTA VI .exe max FPS
    int  devFakeFpsLimit    = 30;    // Target Max FPS (5..144)

    // Phase 2 staging directory
    std::string gta6TexturePackDir = ".\\packs\\gta6_vice";
};

struct PcHardwareInfo {
    int cpuThreads = 8;
    double totalRamGb = 16.0;
    double availRamGb = 8.0;
    std::string gpuName = "Direct3D 11 Hardware GPU";
};

inline const char* kPresetNames[]   = { "ULTRA", "HIGH", "BALANCED", "LOW", "POTATO" };
inline const char* kResNames[]      = { "1920 x 1080 (FHD)", "1600 x 900 (HD+)", "1280 x 720 (HD)", "960 x 540 (Perf)" };
inline const char* kResQuery[]      = { "1920x1080", "1600x900", "1280x720", "960x540" };
inline const char* kFpsNames[]      = { "Uncapped", "60 FPS", "30 FPS" };
inline const int   kFpsValues[]     = { 0, 60, 30 };
inline const char* kShadowNames[]   = { "High", "Normal", "Low", "Off (Max FPS)" };
inline const int   kShadowVals[]    = { 2, 1, 0, -1 };
inline const char* kGta5Modes[]     = { "TITLE MENU", "STORY MODE", "SANDBOX LS", "VICE TEST MAP" };
inline const char* kViewportNames[] = {
    "Embedded Inside Emulator Viewport (Default)",
    "Embedded Fullscreen Viewport",
    "External Frameless Window (Edge/Chrome)",
    "System Default Browser"
};
inline const char* kConsoleNames[]  = { "PlayStation 5 (Xbox->PS5 Port)", "Xbox Series X / 360 (DashX360)", "ViceOS Neo (Custom Console UI)" };

/**
 * Builds the Experimental GTA 6 Sandbox boot path ("/gta6/boot?mode=sandbox&vbx_gta6=1...")
 * used ONLY when Developer Settings -> "Experimental GTA 6" is enabled.
 * Plays the real GTA 6 Rockstar Games Logo startup video (z_RUhg96MiI) before opening the
 * GTA VI Main Menu & Sandbox, keeping GTX 1050 targeting 60 FPS @ 1080p when devPerfAuto is ON.
 */
inline std::string BuildExperimentalGta6PlayPath(const EmulatorConfig& cfg) {
    const int sens = std::max(20, std::min(300, cfg.lookSensitivity));
    std::string url = "/gta6/boot?mode=sandbox&map=env_test&vbx_gta6=1";
    url += "&vbx_perf_auto=" + std::string(cfg.devPerfAuto ? "1" : "0");
    url += "&low=0";
    url += "&fps=" + std::string(cfg.devPerfAuto ? "60" : "0");
    url += "&scale=" + std::string(cfg.devPerfAuto ? "0.90" : "1.00");
    url += "&shadows=1";
    url += "&vbx_sens=" + std::to_string(sens);
    return url;
}

/**
 * Builds the local-proxy GTA V play path ("/play/?...") so the embedded server
 * injects pc_overlay.js (Cheat Menu, Real Hardware Debug HUD, Motion Blur,
 * Optimization Mode, DualSense/Xbox Controller Engine) with exact COOP/COEP headers.
 */
inline std::string BuildLocalGta5PlayPath(const EmulatorConfig& cfg) {
    const bool isLowProfile = (cfg.preset >= 3);
    const int fps = kFpsValues[(cfg.fpsIndex >= 0 && cfg.fpsIndex < 3) ? cfg.fpsIndex : 1];
    const int shVal = kShadowVals[(cfg.shadowsIndex >= 0 && cfg.shadowsIndex < 4) ? cfg.shadowsIndex : 1];
    const char* resStr = kResQuery[(cfg.resIndex >= 0 && cfg.resIndex < 4) ? cfg.resIndex : 1];

    float scale = 1.0f;
    switch (cfg.preset) {
        case 0: scale = 1.00f; break;
        case 1: scale = 1.00f; break;
        case 2: scale = 0.88f; break;
        case 3: scale = 0.75f; break;
        default: scale = 0.55f; break;
    }

    char scaleBuf[16];
    std::snprintf(scaleBuf, sizeof(scaleBuf), "%.2f", scale);

    std::string url = "/play/?low=";
    url += isLowProfile ? "1" : "0";
    url += "&fps=" + std::to_string(fps);
    url += "&res=" + std::string(resStr);
    url += "&scale=" + std::string(scaleBuf);
    url += "&shadows=" + std::string(shVal >= 0 ? "1" : "0");
    url += "&fixed=1";
    url += "&vbx_sens=" + std::to_string(std::max(20, std::min(300, cfg.lookSensitivity)));

    if (cfg.gta5Mode == 1) {
        url += "&mode=story";
    } else if (cfg.gta5Mode == 2) {
        url += "&mode=sandbox";
    } else if (cfg.gta5Mode == 3) {
        url += "&mode=sandbox&map=env_test";
    }

    // Verified RAGE CLI overrides
    std::vector<std::string> args;
    if (isLowProfile) {
        if (shVal >= 0) args.push_back("-shadowQuality=" + std::to_string(shVal));
    } else {
        int q = (cfg.preset == 0) ? 2 : 1;
        args.push_back("-textureQuality=" + std::to_string(q));
        args.push_back("-shaderQuality=" + std::to_string(q));
        args.push_back("-shadowQuality=" + std::to_string(shVal));
        args.push_back("-reflectionQuality=" + std::to_string(q));
        args.push_back("-particleQuality=" + std::to_string(q));
        args.push_back("-grassQuality=" + std::to_string(q));
    }
    if (cfg.optimizationMode) {
        args.push_back("-noInGameDOF");
        args.push_back("-MSAA=0");
    }

    if (cfg.renderDistance >= 0) {
        float lod = static_cast<float>(cfg.renderDistance) / 100.0f;
        if (lod < 0.0f) lod = 0.0f;
        if (lod > 1.0f) lod = 1.0f;
        char lodBuf[16];
        std::snprintf(lodBuf, sizeof(lodBuf), "%.2f", lod);
        std::string ls(lodBuf);
        args.push_back("-lodScale=" + ls);
        args.push_back("-pedLodBias=" + ls);
        args.push_back("-vehicleLodBias=" + ls);
        args.push_back("-cityDensity=" + ls);
    }

    if (!args.empty()) {
        url += "&args=";
        for (size_t i = 0; i < args.size(); ++i) {
            if (i > 0) url += ",";
            url += args[i];
        }
    }
    return url;
}

inline PcHardwareInfo QueryPcHardware() {
    PcHardwareInfo info;
#ifdef _WIN32
    SYSTEM_INFO si{};
    GetSystemInfo(&si);
    if (si.dwNumberOfProcessors > 0) {
        info.cpuThreads = static_cast<int>(si.dwNumberOfProcessors);
    }
    MEMORYSTATUSEX ms{};
    ms.dwLength = sizeof(ms);
    if (GlobalMemoryStatusEx(&ms)) {
        info.totalRamGb = static_cast<double>(ms.ullTotalPhys) / (1024.0 * 1024.0 * 1024.0);
        info.availRamGb = static_cast<double>(ms.ullAvailPhys) / (1024.0 * 1024.0 * 1024.0);
    }
#endif
    return info;
}

#ifdef _WIN32
inline std::wstring Utf8ToWide(const std::string& s) {
    if (s.empty()) return L"";
    int n = MultiByteToWideChar(CP_UTF8, 0, s.c_str(), static_cast<int>(s.size()), nullptr, 0);
    std::wstring w(static_cast<size_t>(n), L'\0');
    MultiByteToWideChar(CP_UTF8, 0, s.c_str(), static_cast<int>(s.size()), &w[0], n);
    return w;
}

inline std::string WideToUtf8(const std::wstring& w) {
    if (w.empty()) return "";
    int n = WideCharToMultiByte(CP_UTF8, 0, w.c_str(), static_cast<int>(w.size()), nullptr, 0, nullptr, nullptr);
    std::string s(static_cast<size_t>(n), '\0');
    WideCharToMultiByte(CP_UTF8, 0, w.c_str(), static_cast<int>(w.size()), &s[0], n, nullptr, nullptr);
    return s;
}

inline bool FileExistsW(const std::wstring& path) {
    DWORD attr = GetFileAttributesW(path.c_str());
    return (attr != INVALID_FILE_ATTRIBUTES) && !(attr & FILE_ATTRIBUTE_DIRECTORY);
}

inline std::string PickCustomFileDialog(HWND owner) {
    wchar_t fileBuf[MAX_PATH * 4] = {};
    OPENFILENAMEW ofn{};
    ofn.lStructSize = sizeof(ofn);
    ofn.hwndOwner = owner;
    ofn.lpstrFilter =
        L"All Files (*.*)\0*.*\0"
        L"Executables & Scripts (*.exe;*.bat;*.cmd;*.lnk;*.msi)\0*.exe;*.bat;*.cmd;*.lnk;*.msi\0"
        L"Media & Archives (*.mp4;*.mkv;*.iso;*.zip;*.html)\0*.mp4;*.mkv;*.iso;*.zip;*.html\0";
    ofn.nFilterIndex = 1; // Default to All Files (*.*) so ANY file type is shown immediately!
    ofn.lpstrFile = fileBuf;
    ofn.nMaxFile = static_cast<DWORD>(sizeof(fileBuf) / sizeof(wchar_t));
    ofn.lpstrTitle = L"Select Custom GTA VI Launch Target (Any File Type)";
    ofn.Flags = OFN_FILEMUSTEXIST | OFN_PATHMUSTEXIST | OFN_NOCHANGEDIR;
    if (GetOpenFileNameW(&ofn)) {
        return WideToUtf8(std::wstring(fileBuf));
    }
    return {};
}

inline std::wstring GetViewportProfileDir() {
    wchar_t localApp[MAX_PATH] = {};
    if (GetEnvironmentVariableW(L"LOCALAPPDATA", localApp, MAX_PATH) && localApp[0]) {
        std::wstring base = std::wstring(localApp) + L"\\ViceBoxX";
        CreateDirectoryW(base.c_str(), nullptr);
        std::wstring prof = base + L"\\ViewportProfile";
        CreateDirectoryW(prof.c_str(), nullptr);
        return prof;
    }
    return L"";
}

inline std::wstring GetEmbeddedWebViewDir() {
    wchar_t localApp[MAX_PATH] = {};
    if (GetEnvironmentVariableW(L"LOCALAPPDATA", localApp, MAX_PATH) && localApp[0]) {
        std::wstring base = std::wstring(localApp) + L"\\ViceBoxX";
        CreateDirectoryW(base.c_str(), nullptr);
        std::wstring prof = base + L"\\EmbeddedWebView2";
        CreateDirectoryW(prof.c_str(), nullptr);
        return prof;
    }
    return L"";
}

inline std::wstring FindChromiumAppBrowser() {
    wchar_t progFiles[MAX_PATH] = {};
    wchar_t progFiles86[MAX_PATH] = {};
    wchar_t localApp[MAX_PATH] = {};
    GetEnvironmentVariableW(L"ProgramFiles", progFiles, MAX_PATH);
    GetEnvironmentVariableW(L"ProgramFiles(x86)", progFiles86, MAX_PATH);
    GetEnvironmentVariableW(L"LOCALAPPDATA", localApp, MAX_PATH);

    std::vector<std::wstring> candidates;
    if (progFiles86[0]) candidates.push_back(std::wstring(progFiles86) + L"\\Microsoft\\Edge\\Application\\msedge.exe");
    if (progFiles[0])   candidates.push_back(std::wstring(progFiles)   + L"\\Microsoft\\Edge\\Application\\msedge.exe");
    if (progFiles[0])   candidates.push_back(std::wstring(progFiles)   + L"\\Google\\Chrome\\Application\\chrome.exe");
    if (progFiles86[0]) candidates.push_back(std::wstring(progFiles86) + L"\\Google\\Chrome\\Application\\chrome.exe");
    if (localApp[0])    candidates.push_back(std::wstring(localApp)    + L"\\Google\\Chrome\\Application\\chrome.exe");
    if (progFiles[0])   candidates.push_back(std::wstring(progFiles)   + L"\\BraveSoftware\\Brave-Browser\\Application\\brave.exe");
    if (localApp[0])    candidates.push_back(std::wstring(localApp)    + L"\\BraveSoftware\\Brave-Browser\\Application\\brave.exe");

    for (const auto& c : candidates) {
        if (FileExistsW(c)) return c;
    }
    return L"";
}

/**
 * Launches the PS5 / Xbox Emulator Dashboard or GTA VI Updates page inside a clean
 * dedicated foreground WebGPU game window (--app mode) with zero Startup Boost hijack.
 */
inline std::string LaunchGameViewport(const std::string& url, int viewportMode, bool highPerfGpu = false) {
    std::wstring wUrl = Utf8ToWide(url);
    if (viewportMode != 3) {
        std::wstring browser = FindChromiumAppBrowser();
        if (!browser.empty()) {
            std::wstring profDir = GetViewportProfileDir();
            // Dedicated user-data-dir + --new-window guarantees Edge/Chrome ALWAYS pops up a
            // fresh foreground frameless console window even if Edge Startup Boost is active!
            std::wstring cmd = L"\"" + browser + L"\"";
            if (!profDir.empty()) {
                cmd += L" --user-data-dir=\"" + profDir + L"\"";
            }
            cmd += L" --new-window --no-first-run --no-default-browser-check"
                   L" --autoplay-policy=no-user-gesture-required"
                   L" --app=" + wUrl;
            if (highPerfGpu) {
                cmd += L" --force-high-performance-gpu";
            }
            if (viewportMode == 1) {
                cmd += L" --start-fullscreen";
            } else {
                cmd += L" --window-size=1600,900";
            }
            STARTUPINFOW si{};
            si.cb = sizeof(si);
            si.dwFlags = STARTF_USESHOWWINDOW;
            si.wShowWindow = SW_SHOWNORMAL;
            PROCESS_INFORMATION pi{};
            std::vector<wchar_t> cmdBuf(cmd.begin(), cmd.end());
            cmdBuf.push_back(L'\0');
            if (CreateProcessW(nullptr, cmdBuf.data(), nullptr, nullptr, FALSE,
                               CREATE_NEW_PROCESS_GROUP, nullptr, nullptr, &si, &pi)) {
                CloseHandle(pi.hThread);
                CloseHandle(pi.hProcess);
                bool isEdge = (browser.find(L"msedge") != std::wstring::npos);
                bool isBrave = (browser.find(L"brave") != std::wstring::npos);
                return isEdge ? "Frameless Edge WebGPU Viewport"
                     : (isBrave ? "Frameless Brave WebGPU Viewport" : "Frameless Chrome WebGPU Viewport");
            }
        }
    }
    ShellExecuteW(nullptr, L"open", wUrl.c_str(), nullptr, nullptr, SW_SHOWNORMAL);
    return "System Default WebGPU Browser";
}

inline std::wstring GetConfigFilePath() {
    wchar_t appData[MAX_PATH] = {};
    if (SUCCEEDED(SHGetFolderPathW(nullptr, CSIDL_APPDATA, nullptr, 0, appData))) {
        std::wstring dir = std::wstring(appData) + L"\\ViceBoxX";
        CreateDirectoryW(dir.c_str(), nullptr);
        return dir + L"\\config.ini";
    }
    return L"vicebox_config.ini";
}

inline void SaveConfig(const EmulatorConfig& cfg) {
    std::filesystem::path cfgPath(GetConfigFilePath());
    std::ofstream f(cfgPath);
    if (!f.is_open()) return;
    f << "preset=" << cfg.preset << "\n";
    f << "resIndex=" << cfg.resIndex << "\n";
    f << "fpsIndex=" << cfg.fpsIndex << "\n";
    f << "shadowsIndex=" << cfg.shadowsIndex << "\n";
    f << "renderDistance=" << cfg.renderDistance << "\n";
    f << "gta5Mode=" << cfg.gta5Mode << "\n";
    f << "viewportMode=" << cfg.viewportMode << "\n";
    f << "consoleTarget=" << cfg.consoleTarget << "\n";
    f << "showDebugHud=" << (cfg.showDebugHud ? 1 : 0) << "\n";
    f << "enableCheatMenu=" << (cfg.enableCheatMenu ? 1 : 0) << "\n";
    f << "motionBlur=" << (cfg.motionBlur ? 1 : 0) << "\n";
    f << "motionBlurStrength=" << cfg.motionBlurStrength << "\n";
    f << "optimizationMode=" << (cfg.optimizationMode ? 1 : 0) << "\n";
    f << "lookSensitivity=" << cfg.lookSensitivity << "\n";
    f << "psPlusTier=" << cfg.psPlusTier << "\n";
    f << "devGta6Enabled=" << (cfg.devGta6Enabled ? 1 : 0) << "\n";
    f << "devExpGta6=" << (cfg.devExpGta6 ? 1 : 0) << "\n";
    f << "devPerfAuto=" << (cfg.devPerfAuto ? 1 : 0) << "\n";
    f << "devGta6ExePath=" << cfg.devGta6ExePath << "\n";
    f << "devFullOverlay=" << (cfg.devFullOverlay ? 1 : 0) << "\n";
    f << "devFakeFpsEnabled=" << (cfg.devFakeFpsEnabled ? 1 : 0) << "\n";
    f << "devFakeFpsLimit=" << cfg.devFakeFpsLimit << "\n";
    f << "rememberSession=" << (cfg.rememberSession ? 1 : 0) << "\n";
    if (cfg.rememberSession && !cfg.savedGamertag.empty()) {
        f << "gamertag=" << cfg.savedGamertag << "\n";
    }
}

inline void LoadConfig(EmulatorConfig& cfg) {
    std::filesystem::path cfgPath(GetConfigFilePath());
    std::ifstream f(cfgPath);
    if (!f.is_open()) return;
    std::string line;
    while (std::getline(f, line)) {
        auto eq = line.find('=');
        if (eq == std::string::npos) continue;
        std::string k = line.substr(0, eq);
        std::string v = line.substr(eq + 1);
        if (!v.empty() && v.back() == '\r') v.pop_back();
        try {
            if (k == "preset") cfg.preset = std::stoi(v);
            else if (k == "resIndex") cfg.resIndex = std::stoi(v);
            else if (k == "fpsIndex") cfg.fpsIndex = std::stoi(v);
            else if (k == "shadowsIndex") cfg.shadowsIndex = std::stoi(v);
            else if (k == "renderDistance") cfg.renderDistance = std::stoi(v);
            else if (k == "gta5Mode") cfg.gta5Mode = std::stoi(v);
            else if (k == "viewportMode") cfg.viewportMode = std::max(0, std::min(3, std::stoi(v)));
            else if (k == "consoleTarget") cfg.consoleTarget = std::max(0, std::min(2, std::stoi(v)));
            else if (k == "showDebugHud") cfg.showDebugHud = (std::stoi(v) != 0);
            else if (k == "enableCheatMenu") cfg.enableCheatMenu = (std::stoi(v) != 0);
            else if (k == "motionBlur") cfg.motionBlur = (std::stoi(v) != 0);
            else if (k == "motionBlurStrength") cfg.motionBlurStrength = std::stoi(v);
            else if (k == "optimizationMode") cfg.optimizationMode = (std::stoi(v) != 0);
            else if (k == "lookSensitivity") cfg.lookSensitivity = std::max(20, std::min(300, std::stoi(v)));
            else if (k == "psPlusTier") cfg.psPlusTier = v;
            else if (k == "devGta6Enabled") cfg.devGta6Enabled = (std::stoi(v) != 0);
            else if (k == "devExpGta6") cfg.devExpGta6 = (std::stoi(v) != 0);
            else if (k == "devPerfAuto") cfg.devPerfAuto = (std::stoi(v) != 0);
            else if (k == "devGta6ExePath") cfg.devGta6ExePath = v;
            else if (k == "devFullOverlay") cfg.devFullOverlay = (std::stoi(v) != 0);
            else if (k == "devFakeFpsEnabled") cfg.devFakeFpsEnabled = (std::stoi(v) != 0);
            else if (k == "devFakeFpsLimit") cfg.devFakeFpsLimit = std::max(5, std::min(144, std::stoi(v)));
            else if (k == "rememberSession") cfg.rememberSession = (std::stoi(v) != 0);
            else if (k == "gamertag") cfg.savedGamertag = v;
        } catch (...) {}
    }
}
#else
inline std::string LaunchGameViewport(const std::string&, int, bool = false) { return "Preview Stub"; }
inline void SaveConfig(const EmulatorConfig&) {}
inline void LoadConfig(EmulatorConfig&) {}
#endif

} // namespace vicebox
