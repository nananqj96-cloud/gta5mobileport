#pragma once

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
#include <windows.h>
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

    bool rememberSession = true;
    std::string savedGamertag;

    // Phase 2 hooks for GTA VI Emulator (Cyberleeks XBSX build)
    // Leave empty until a GTA VI web runtime or local texture-pack override server is integrated.
    std::string gta6RuntimeUrl;
    std::string gta6TexturePackDir = ".\\packs\\gta6_vice";
};

struct PcHardwareInfo {
    int cpuThreads = 8;
    double totalRamGb = 16.0;
    double availRamGb = 8.0;
    std::string gpuName = "Direct3D 11 Hardware GPU";
};

inline const char* kPresetNames[] = { "ULTRA", "HIGH", "BALANCED", "LOW", "POTATO" };
inline const char* kResNames[]    = { "1920 x 1080 (FHD)", "1600 x 900 (HD+)", "1280 x 720 (HD)", "960 x 540 (Perf)" };
inline const char* kResQuery[]    = { "1920x1080", "1600x900", "1280x720", "960x540" };
inline const char* kFpsNames[]    = { "Uncapped", "60 FPS", "30 FPS" };
inline const int   kFpsValues[]   = { 0, 60, 30 };
inline const char* kShadowNames[] = { "High", "Normal", "Low", "Off (Max FPS)" };
inline const int   kShadowVals[]  = { 2, 1, 0, -1 };
inline const char* kGta5Modes[]   = { "TITLE MENU", "STORY MODE", "SANDBOX LS", "VICE TEST MAP" };
inline const char* kViewportNames[] = { "Frameless Game Window (App Mode)", "Fullscreen Viewport", "System Default Browser" };

inline std::string BuildGta5LaunchUrl(const EmulatorConfig& cfg) {
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

    std::string url = "https://playgta5.com/?low=";
    url += isLowProfile ? "1" : "0";
    url += "&fps=" + std::to_string(fps);
    url += "&res=" + std::string(resStr);
    url += "&scale=" + std::string(scaleBuf);
    url += "&shadows=" + std::string(shVal >= 0 ? "1" : "0");
    url += "&fixed=1";

    if (cfg.gta5Mode == 1) {
        url += "&mode=story";
    } else if (cfg.gta5Mode == 2) {
        url += "&mode=sandbox";
    } else if (cfg.gta5Mode == 3) {
        url += "&mode=sandbox&map=env_test";
    }

    // Clean, verified RAGE CLI overrides (zero conflicting flags)
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

inline std::wstring FindChromiumAppBrowser() {
    wchar_t progFiles[MAX_PATH] = {};
    wchar_t progFiles86[MAX_PATH] = {};
    wchar_t localApp[MAX_PATH] = {};
    GetEnvironmentVariableW(L"ProgramFiles", progFiles, MAX_PATH);
    GetEnvironmentVariableW(L"ProgramFiles(x86)", progFiles86, MAX_PATH);
    GetEnvironmentVariableW(L"LOCALAPPDATA", localApp, MAX_PATH);

    std::vector<std::wstring> candidates;
    // Prefer Edge (preinstalled on every Windows 10/11 PC with native WebGPU + SharedArrayBuffer),
    // then Chrome, then Brave!
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
 * Launches the GTA V runtime inside a clean frameless PC game window (--app mode)
 * with zero browser tabs/bars and full desktop WebGPU + SharedArrayBuffer + mouse Pointer Lock.
 * Returns a short status description of which viewport backend launched.
 */
inline std::string LaunchGameViewport(const std::string& url, int viewportMode) {
    std::wstring wUrl = Utf8ToWide(url);
    if (viewportMode != 2) {
        std::wstring browser = FindChromiumAppBrowser();
        if (!browser.empty()) {
            std::wstring cmd = L"\"" + browser + L"\" --app=\"" + wUrl + L"\"";
            if (viewportMode == 1) {
                cmd += L" --start-fullscreen";
            } else {
                cmd += L" --window-size=1600,900";
            }
            STARTUPINFOW si{};
            si.cb = sizeof(si);
            PROCESS_INFORMATION pi{};
            std::vector<wchar_t> cmdBuf(cmd.begin(), cmd.end());
            cmdBuf.push_back(L'\0');
            if (CreateProcessW(browser.c_str(), cmdBuf.data(), nullptr, nullptr, FALSE,
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
        try {
            if (k == "preset") cfg.preset = std::stoi(v);
            else if (k == "resIndex") cfg.resIndex = std::stoi(v);
            else if (k == "fpsIndex") cfg.fpsIndex = std::stoi(v);
            else if (k == "shadowsIndex") cfg.shadowsIndex = std::stoi(v);
            else if (k == "renderDistance") cfg.renderDistance = std::stoi(v);
            else if (k == "gta5Mode") cfg.gta5Mode = std::stoi(v);
            else if (k == "viewportMode") cfg.viewportMode = std::stoi(v);
            else if (k == "rememberSession") cfg.rememberSession = (std::stoi(v) != 0);
            else if (k == "gamertag") cfg.savedGamertag = v;
        } catch (...) {}
    }
}
#else
inline std::string LaunchGameViewport(const std::string&, int) { return "Preview Stub"; }
inline void SaveConfig(const EmulatorConfig&) {}
inline void LoadConfig(EmulatorConfig&) {}
#endif

} // namespace vicebox
