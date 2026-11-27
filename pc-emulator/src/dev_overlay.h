#pragma once

#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif

#include <winsock2.h>
#include <windows.h>
#include <objidl.h>
#include <mmsystem.h>
#include <psapi.h>
#include <shellapi.h>
#include <dwmapi.h>
#include <xinput.h>

#include <algorithm>
#include <atomic>
#include <cctype>
#include <cmath>
#include <cstdio>
#include <cstring>
#include <deque>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

namespace Gdiplus {
using std::max;
using std::min;
}
#include <gdiplus.h>

#include "hw_monitor.h"

namespace vicebox {

inline bool IsExeFilePath(const std::string& path) {
    std::string s = path;
    while (!s.empty() && (s.back() == ' ' || s.back() == '\t' || s.back() == '"' || s.back() == '\r' || s.back() == '\n')) {
        s.pop_back();
    }
    if (s.size() < 4) return false;
    std::string ext = s.substr(s.size() - 4);
    for (char& c : ext) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
    return ext == ".exe";
}

struct DevTargetStatus {
    bool running = false;
    DWORD pid = 0;
    std::string exeName;
    bool overlayVisible = false;
    bool fakeFpsActive = false;
    int fakeFpsLimit = 30;
    double displayedFps = 0.0;
};

class DevTargetController {
public:
    DevTargetController() = default;
    ~DevTargetController() { Shutdown(); }

    void Init(HwMonitor* hw) {
        hw_ = hw;
        if (!gdipStarted_) {
            Gdiplus::GdiplusStartupInput si{};
            if (Gdiplus::GdiplusStartup(&gdipToken_, &si, nullptr) == Gdiplus::Ok) {
                gdipStarted_ = true;
            }
        }
        if (!ntdll_) {
            ntdll_ = GetModuleHandleW(L"ntdll.dll");
            if (ntdll_) {
                pNtSuspendProcess_ = reinterpret_cast<PFN_NtProc>(GetProcAddress(ntdll_, "NtSuspendProcess"));
                pNtResumeProcess_  = reinterpret_cast<PFN_NtProc>(GetProcAddress(ntdll_, "NtResumeProcess"));
            }
        }
        if (!xinputDll_) {
            const wchar_t* libs[] = { L"xinput1_4.dll", L"xinput1_3.dll", L"xinput9_1_0.dll" };
            for (const wchar_t* lib : libs) {
                HMODULE m = LoadLibraryW(lib);
                if (m) {
                    xinputDll_ = m;
                    pXInputGetState_ = reinterpret_cast<PFN_XInputGetState>(GetProcAddress(m, "XInputGetState"));
                    break;
                }
            }
        }
    }

    void UpdateSettings(bool fullOverlay, bool fakeFpsEnabled, int fakeFpsLimit) {
        fullOverlayEnabled_.store(fullOverlay);
        bool wasFake = fakeFpsEnabled_.exchange(fakeFpsEnabled);
        fakeFpsLimit_.store(std::max(5, std::min(144, fakeFpsLimit)));
        if (wasFake && !fakeFpsEnabled) {
            ResumeAllTrackedProcesses();
        }
        if (fullOverlay) {
            userHidOverlay_.store(false);
        }
    }

    bool LaunchExe(const std::string& utf8Path, std::string& outError, bool forEmbed = false) {
        if (!IsExeFilePath(utf8Path)) {
            outError = "Selected file is not a Windows .exe executable.";
            return false;
        }

        std::wstring wPath = Utf8ToWideLocal(utf8Path);
        DWORD attrs = GetFileAttributesW(wPath.c_str());
        if (attrs == INVALID_FILE_ATTRIBUTES) {
            outError = "Selected .exe file no longer exists on disk.";
            return false;
        }

        // Stop any previous tracked session cleanly (resuming it first!)
        StopSession();

        std::wstring wDir;
        std::string shortName = utf8Path;
        size_t slash = wPath.find_last_of(L"\\/");
        if (slash != std::wstring::npos) {
            wDir = wPath.substr(0, slash);
        }
        size_t slashA = utf8Path.find_last_of("\\/");
        if (slashA != std::string::npos && slashA + 1 < utf8Path.size()) {
            shortName = utf8Path.substr(slashA + 1);
        }

        // Create a Job Object to automatically track child processes spawned by launchers/bootstrappers.
        // When launched in fitanyexe embedded mode, set KILL_ON_JOB_CLOSE so closing ViceBox X
        // never leaves an invisible borderless .exe orphaned on the desktop!
        HANDLE hJob = CreateJobObjectW(nullptr, nullptr);
        if (hJob && forEmbed) {
            JOBOBJECT_EXTENDED_LIMIT_INFORMATION jeli{};
            jeli.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE;
            SetInformationJobObject(hJob, JobObjectExtendedLimitInformation, &jeli, sizeof(jeli));
        }

        HANDLE hProc = nullptr;
        DWORD pid = 0;

        STARTUPINFOW si{};
        si.cb = sizeof(si);
        if (forEmbed) {
            si.dwFlags = STARTF_USESHOWWINDOW;
            si.wShowWindow = SW_SHOWNOACTIVATE;
        }
        PROCESS_INFORMATION pi{};
        std::wstring cmdLine = L"\"" + wPath + L"\"";
        std::vector<wchar_t> cmdBuf(cmdLine.begin(), cmdLine.end());
        cmdBuf.push_back(L'\0');

        if (CreateProcessW(
                wPath.c_str(), cmdBuf.data(), nullptr, nullptr, FALSE,
                CREATE_NEW_PROCESS_GROUP, nullptr,
                wDir.empty() ? nullptr : wDir.c_str(), &si, &pi)) {
            hProc = pi.hProcess;
            pid = pi.dwProcessId;
            CloseHandle(pi.hThread);
            if (hJob) {
                AssignProcessToJobObject(hJob, hProc);
            }
        } else {
            // Fallback for UAC-manifested executables
            SHELLEXECUTEINFOW sei{};
            sei.cbSize = sizeof(sei);
            sei.fMask = SEE_MASK_NOCLOSEPROCESS;
            sei.lpVerb = L"open";
            sei.lpFile = wPath.c_str();
            sei.lpDirectory = wDir.empty() ? nullptr : wDir.c_str();
            sei.nShow = forEmbed ? SW_SHOWNOACTIVATE : SW_SHOWNORMAL;
            if (!ShellExecuteExW(&sei) || !sei.hProcess) {
                if (hJob) CloseHandle(hJob);
                outError = "Windows failed to start the selected .exe executable.";
                return false;
            }
            hProc = sei.hProcess;
            pid = GetProcessId(hProc);
            if (hJob && hProc) {
                AssignProcessToJobObject(hJob, hProc);
            }
        }

        {
            std::lock_guard<std::mutex> lk(mu_);
            hJob_ = hJob;
            hTargetProc_ = hProc;
            targetPid_ = pid;
            targetExeName_ = shortName;
            targetFullPath_ = utf8Path;
            launchTickMs_ = GetTickCount64();
            eventLog_.clear();
            PushEventLocked(std::string(forEmbed ? "[FITEXE]  Embedding target " : "[DEVKIT] Attached target ") +
                            shortName + " (PID " + std::to_string(pid) + ")");
            PushEventLocked("[RAGE9]  Full-Screen Telemetry Overlay armed (F10 toggle)");
            if (fakeFpsEnabled_.load()) {
                PushEventLocked("[FPSCAP] Target limiter engaged -> MAX " + std::to_string(fakeFpsLimit_.load()) + " FPS");
            }
        }

        stopSession_.store(false);
        sessionRunning_.store(true);
        userHidOverlay_.store(false);

        limiterThread_ = std::thread([this]() { LimiterLoop(); });
        overlayThread_ = std::thread([this]() { OverlayLoop(); });
        return true;
    }

    std::vector<DWORD> GetTrackedPids() const {
        return CollectTrackedPids();
    }

    bool IsTargetAlive() const {
        return IsAnyTargetAlive();
    }

    std::string GetExeName() const {
        std::lock_guard<std::mutex> lk(mu_);
        return targetExeName_;
    }

    void TerminateAllTrackedProcesses() {
        ResumeAllTrackedProcesses();
        HANDLE jobCopy = nullptr;
        HANDLE rootCopy = nullptr;
        {
            std::lock_guard<std::mutex> lk(mu_);
            jobCopy = hJob_;
            rootCopy = hTargetProc_;
        }
        if (jobCopy) {
            TerminateJobObject(jobCopy, 0);
        }
        auto pids = CollectTrackedPids();
        DWORD selfPid = GetCurrentProcessId();
        for (DWORD p : pids) {
            if (p == 0 || p == selfPid) continue;
            HANDLE h = OpenProcess(PROCESS_TERMINATE, FALSE, p);
            if (h) {
                TerminateProcess(h, 0);
                CloseHandle(h);
            }
        }
        if (rootCopy) {
            TerminateProcess(rootCopy, 0);
        }
    }

    void StopSession() {
        stopSession_.store(true);
        ResumeAllTrackedProcesses();

        HWND ov = overlayHwnd_.load();
        if (ov && IsWindow(ov)) {
            PostMessageW(ov, WM_CLOSE, 0, 0);
        }

        if (limiterThread_.joinable()) limiterThread_.join();
        if (overlayThread_.joinable()) overlayThread_.join();

        ResumeAllTrackedProcesses();

        {
            std::lock_guard<std::mutex> lk(mu_);
            if (hTargetProc_) { CloseHandle(hTargetProc_); hTargetProc_ = nullptr; }
            if (hJob_) { CloseHandle(hJob_); hJob_ = nullptr; }
            targetPid_ = 0;
        }
        sessionRunning_.store(false);
        overlayHwnd_.store(nullptr);
    }

    void Shutdown() {
        StopSession();
        if (xinputDll_) {
            FreeLibrary(xinputDll_);
            xinputDll_ = nullptr;
            pXInputGetState_ = nullptr;
        }
        if (gdipStarted_) {
            Gdiplus::GdiplusShutdown(gdipToken_);
            gdipStarted_ = false;
        }
    }

    DevTargetStatus GetStatus() const {
        DevTargetStatus st;
        st.running = sessionRunning_.load();
        st.overlayVisible = st.running && fullOverlayEnabled_.load() && !userHidOverlay_.load();
        st.fakeFpsActive = st.running && fakeFpsEnabled_.load();
        st.fakeFpsLimit = fakeFpsLimit_.load();
        st.displayedFps = displayedFps_.load();
        std::lock_guard<std::mutex> lk(mu_);
        st.pid = targetPid_;
        st.exeName = targetExeName_;
        return st;
    }

private:
    using PFN_NtProc = LONG(NTAPI*)(HANDLE);
    using PFN_XInputGetState = DWORD(WINAPI*)(DWORD, XINPUT_STATE*);

    static std::wstring Utf8ToWideLocal(const std::string& s) {
        if (s.empty()) return {};
        int n = MultiByteToWideChar(CP_UTF8, 0, s.c_str(), static_cast<int>(s.size()), nullptr, 0);
        if (n <= 0) return {};
        std::wstring ws(static_cast<size_t>(n), L'\0');
        MultiByteToWideChar(CP_UTF8, 0, s.c_str(), static_cast<int>(s.size()), &ws[0], n);
        return ws;
    }

    void PushEventLocked(const std::string& msg) {
        eventLog_.push_back(msg);
        while (eventLog_.size() > 7) eventLog_.pop_front();
    }

    std::vector<DWORD> CollectTrackedPids() const {
        std::vector<DWORD> pids;
        DWORD selfPid = GetCurrentProcessId();
        HANDLE jobCopy = nullptr;
        DWORD rootPid = 0;
        {
            std::lock_guard<std::mutex> lk(mu_);
            jobCopy = hJob_;
            rootPid = targetPid_;
        }

        if (jobCopy) {
            BYTE buf[sizeof(JOBOBJECT_BASIC_PROCESS_ID_LIST) + sizeof(ULONG_PTR) * 64]{};
            DWORD retLen = 0;
            if (QueryInformationJobObject(jobCopy, JobObjectBasicProcessIdList, buf, sizeof(buf), &retLen)) {
                auto* list = reinterpret_cast<JOBOBJECT_BASIC_PROCESS_ID_LIST*>(buf);
                for (DWORD i = 0; i < list->NumberOfProcessIdsInList; ++i) {
                    DWORD p = static_cast<DWORD>(list->ProcessIdList[i]);
                    if (p != 0 && p != selfPid) pids.push_back(p);
                }
            }
        }
        if (rootPid != 0 && rootPid != selfPid) {
            if (std::find(pids.begin(), pids.end(), rootPid) == pids.end()) {
                pids.push_back(rootPid);
            }
        }
        return pids;
    }

    bool IsAnyTargetAlive() const {
        HANDLE hRoot = nullptr;
        {
            std::lock_guard<std::mutex> lk(mu_);
            hRoot = hTargetProc_;
        }
        if (hRoot && WaitForSingleObject(hRoot, 0) == WAIT_TIMEOUT) {
            return true;
        }
        auto pids = CollectTrackedPids();
        for (DWORD p : pids) {
            HANDLE h = OpenProcess(SYNCHRONIZE, FALSE, p);
            if (h) {
                bool alive = (WaitForSingleObject(h, 0) == WAIT_TIMEOUT);
                CloseHandle(h);
                if (alive) return true;
            }
        }
        return false;
    }

    void SuspendPids(const std::vector<DWORD>& pids) {
        if (!pNtSuspendProcess_) return;
        DWORD selfPid = GetCurrentProcessId();
        for (DWORD p : pids) {
            if (p == 0 || p == selfPid) continue;
            HANDLE h = OpenProcess(PROCESS_SUSPEND_RESUME, FALSE, p);
            if (h) {
                pNtSuspendProcess_(h);
                CloseHandle(h);
            }
        }
    }

    void ResumePids(const std::vector<DWORD>& pids) {
        if (!pNtResumeProcess_) return;
        DWORD selfPid = GetCurrentProcessId();
        for (DWORD p : pids) {
            if (p == 0 || p == selfPid) continue;
            HANDLE h = OpenProcess(PROCESS_SUSPEND_RESUME, FALSE, p);
            if (h) {
                pNtResumeProcess_(h);
                CloseHandle(h);
            }
        }
    }

    void ResumeAllTrackedProcesses() {
        auto pids = CollectTrackedPids();
        ResumePids(pids);
        HANDLE hRoot = nullptr;
        {
            std::lock_guard<std::mutex> lk(mu_);
            hRoot = hTargetProc_;
        }
        if (hRoot && pNtResumeProcess_) {
            pNtResumeProcess_(hRoot);
        }
    }

    // Precision Max-FPS Pacing Engine for the launched target .exe (+ any child processes in its Job)
    void LimiterLoop() {
        timeBeginPeriod(1);
        LARGE_INTEGER freq{};
        QueryPerformanceFrequency(&freq);
        const double invFreqMs = 1000.0 / static_cast<double>(freq.QuadPart);

        auto waitMsInterruptible = [&](double ms, bool allowInterruptOnDisable) {
            LARGE_INTEGER t0{}, now{};
            QueryPerformanceCounter(&t0);
            while (!stopSession_.load()) {
                if (allowInterruptOnDisable && !fakeFpsEnabled_.load()) break;
                QueryPerformanceCounter(&now);
                double elapsed = static_cast<double>(now.QuadPart - t0.QuadPart) * invFreqMs;
                double rem = ms - elapsed;
                if (rem <= 0.0) break;
                if (rem > 2.2) Sleep(1);
                else SwitchToThread();
            }
        };

        bool currentlySuspended = false;
        std::vector<DWORD> suspendedPids;

        while (!stopSession_.load()) {
            if (!IsAnyTargetAlive()) {
                stopSession_.store(true);
                break;
            }

            if (!fakeFpsEnabled_.load()) {
                if (currentlySuspended) {
                    ResumePids(suspendedPids);
                    ResumeAllTrackedProcesses();
                    suspendedPids.clear();
                    currentlySuspended = false;
                }
                Sleep(25);
                continue;
            }

            int cap = std::max(5, std::min(144, fakeFpsLimit_.load()));
            double periodMs = 1000.0 / static_cast<double>(cap);
            double activeMs = 0.0;
            if (cap <= 60) {
                // Tight active execution slice so even lightweight 200+ FPS .exe apps
                // cannot burst multiple frames per cycle and remain capped at <= target FPS!
                activeMs = std::clamp(3.2 + (static_cast<double>(cap) / 60.0) * 6.8, 3.2, 10.0);
            } else {
                activeMs = periodMs * 0.78;
            }
            double sleepMs = std::max(1.0, periodMs - activeMs);

            // 1. Active frame slice
            waitMsInterruptible(activeMs, true);
            if (stopSession_.load() || !fakeFpsEnabled_.load()) {
                if (currentlySuspended) {
                    ResumePids(suspendedPids);
                    suspendedPids.clear();
                    currentlySuspended = false;
                }
                continue;
            }

            // 2. Cap pacing pause across target .exe and child processes
            suspendedPids = CollectTrackedPids();
            if (!suspendedPids.empty()) {
                SuspendPids(suspendedPids);
                currentlySuspended = true;
                waitMsInterruptible(sleepMs, true);
                ResumePids(suspendedPids);
                suspendedPids.clear();
                currentlySuspended = false;
            } else {
                Sleep(15);
            }
        }

        if (currentlySuspended) {
            ResumePids(suspendedPids);
        }
        ResumeAllTrackedProcesses();
        timeEndPeriod(1);
        sessionRunning_.store(false);
    }

    static LRESULT CALLBACK OverlayWndProc(HWND hWnd, UINT msg, WPARAM wParam, LPARAM lParam) {
        if (msg == WM_NCHITTEST) return HTTRANSPARENT;
        if (msg == WM_MOUSEACTIVATE) return MA_NOACTIVATE;
        if (msg == WM_DESTROY) {
            PostQuitMessage(0);
            return 0;
        }
        return DefWindowProcW(hWnd, msg, wParam, lParam);
    }

    struct TargetProcStats {
        double workingSetMb = 0.0;
        double privateMb = 0.0;
        int procCount = 0;
    };

    TargetProcStats QueryTargetProcMemory() const {
        TargetProcStats out;
        auto pids = CollectTrackedPids();
        out.procCount = static_cast<int>(pids.size());
        for (DWORD p : pids) {
            HANDLE h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION | PROCESS_VM_READ, FALSE, p);
            if (!h) h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, FALSE, p);
            if (h) {
                PROCESS_MEMORY_COUNTERS_EX pmc{};
                pmc.cb = sizeof(pmc);
                if (GetProcessMemoryInfo(h, reinterpret_cast<PROCESS_MEMORY_COUNTERS*>(&pmc), sizeof(pmc))) {
                    out.workingSetMb += static_cast<double>(pmc.WorkingSetSize) / (1024.0 * 1024.0);
                    out.privateMb += static_cast<double>(pmc.PrivateUsage) / (1024.0 * 1024.0);
                }
                CloseHandle(h);
            }
        }
        return out;
    }

    void OverlayLoop() {
        const wchar_t* kCls = L"ViceBoxGta6FullDevOverlayWnd";
        HINSTANCE hInst = GetModuleHandleW(nullptr);

        WNDCLASSEXW wc{};
        wc.cbSize = sizeof(wc);
        wc.lpfnWndProc = OverlayWndProc;
        wc.hInstance = hInst;
        wc.lpszClassName = kCls;
        RegisterClassExW(&wc);

        int monW = GetSystemMetrics(SM_CXSCREEN);
        int monH = GetSystemMetrics(SM_CYSCREEN);
        if (monW < 640) monW = 1920;
        if (monH < 480) monH = 1080;

        HWND hWnd = CreateWindowExW(
            WS_EX_TOPMOST | WS_EX_LAYERED | WS_EX_TRANSPARENT | WS_EX_NOACTIVATE | WS_EX_TOOLWINDOW,
            kCls, L"ViceBox GTA VI Full Dev Overlay",
            WS_POPUP, 0, 0, monW, monH,
            nullptr, nullptr, hInst, nullptr);
        if (!hWnd) return;

        overlayHwnd_.store(hWnd);
        ShowWindow(hWnd, SW_SHOWNOACTIVATE);

        HDC screenDC = GetDC(nullptr);
        HDC memDC = CreateCompatibleDC(screenDC);
        HBITMAP hBmp = nullptr;
        void* dibBits = nullptr;
        int curW = 0, curH = 0;

        auto ensureBackbuffer = [&](int w, int h) -> bool {
            if (hBmp && curW == w && curH == h) return true;
            if (hBmp) { DeleteObject(hBmp); hBmp = nullptr; }
            BITMAPINFO bmi{};
            bmi.bmiHeader.biSize = sizeof(BITMAPINFOHEADER);
            bmi.bmiHeader.biWidth = w;
            bmi.bmiHeader.biHeight = -h; // top-down DIB
            bmi.bmiHeader.biPlanes = 1;
            bmi.bmiHeader.biBitCount = 32;
            bmi.bmiHeader.biCompression = BI_RGB;
            hBmp = CreateDIBSection(screenDC, &bmi, DIB_RGB_COLORS, &dibBits, nullptr, 0);
            if (!hBmp) return false;
            SelectObject(memDC, hBmp);
            curW = w;
            curH = h;
            return true;
        };

        std::deque<float> ftHistory(56, 16.6f);
        bool prevF10 = false;
        ULONGLONG lastDrawTick = 0;
        ULONGLONG lastEventTick = GetTickCount64();
        int eventCycle = 0;
        double simPhase = 0.0;

        MSG msg{};
        while (!stopSession_.load()) {
            while (PeekMessageW(&msg, nullptr, 0, 0, PM_REMOVE)) {
                if (msg.message == WM_QUIT) {
                    stopSession_.store(true);
                    break;
                }
                TranslateMessage(&msg);
                DispatchMessageW(&msg);
            }
            if (stopSession_.load()) break;

            if (!IsAnyTargetAlive()) {
                stopSession_.store(true);
                break;
            }

            // F10 hotkey toggles Full Dev Overlay visibility anytime while playing
            bool f10 = (GetAsyncKeyState(VK_F10) & 0x8000) != 0;
            if (f10 && !prevF10) {
                userHidOverlay_.store(!userHidOverlay_.load());
            }
            prevF10 = f10;

            ULONGLONG nowTick = GetTickCount64();
            if (nowTick - lastDrawTick >= 66) { // ~15 FPS crisp HUD refresh (<1% CPU)
                lastDrawTick = nowTick;
                simPhase += 0.066;

                int nw = GetSystemMetrics(SM_CXSCREEN);
                int nh = GetSystemMetrics(SM_CYSCREEN);
                if (nw < 640) nw = 1920;
                if (nh < 480) nh = 1080;

                bool showNow = fullOverlayEnabled_.load() && !userHidOverlay_.load();
                if (!showNow) {
                    if (IsWindowVisible(hWnd)) ShowWindow(hWnd, SW_HIDE);
                    Sleep(20);
                    continue;
                }
                if (!IsWindowVisible(hWnd)) {
                    ShowWindow(hWnd, SW_SHOWNOACTIVATE);
                }

                // Keep gently on top above target borderless/windowed .exe
                SetWindowPos(hWnd, HWND_TOPMOST, 0, 0, nw, nh,
                             SWP_NOACTIVATE | SWP_SHOWWINDOW | SWP_NOSENDCHANGING);

                if (nowTick - lastEventTick > 3800) {
                    lastEventTick = nowTick;
                    static const char* kStreamMsgs[] = {
                        "[STREAM] Mounted sector vc_ocean_dr_lod0 (38.4 MB)",
                        "[RTGI]   Probe cascade #2 converged (1.42 ms)",
                        "[CROWD]  PedNavMesh sector sync OK (84 active)",
                        "[SHADER] PSO cache warm: 14,820 / 14,820 compiled",
                        "[AUDIO]  RAGE9 Ambience mixer bank Leonida_Day OK",
                        "[NET]    Local telemetry bridge 127.0.0.1 heartbeat"
                    };
                    std::lock_guard<std::mutex> lk(mu_);
                    PushEventLocked(kStreamMsgs[eventCycle % 6]);
                    ++eventCycle;
                }

                if (ensureBackbuffer(nw, nh)) {
                    RenderFullDevHud(memDC, dibBits, nw, nh, simPhase, ftHistory);

                    POINT ptDst{ 0, 0 };
                    POINT ptSrc{ 0, 0 };
                    SIZE sz{ nw, nh };
                    BLENDFUNCTION bf{};
                    bf.BlendOp = AC_SRC_OVER;
                    bf.SourceConstantAlpha = 255;
                    bf.AlphaFormat = AC_SRC_ALPHA;
                    UpdateLayeredWindow(hWnd, screenDC, &ptDst, &sz, memDC, &ptSrc, 0, &bf, ULW_ALPHA);
                }
            }
            Sleep(12);
        }

        if (hBmp) DeleteObject(hBmp);
        DeleteDC(memDC);
        ReleaseDC(nullptr, screenDC);
        if (IsWindow(hWnd)) DestroyWindow(hWnd);
        overlayHwnd_.store(nullptr);
        sessionRunning_.store(false);
    }

    void RenderFullDevHud(HDC memDC, void* dibBits, int W, int H, double phase, std::deque<float>& ftHist) {
        if (!gdipStarted_ || !dibBits) return;
        std::memset(dibBits, 0, static_cast<size_t>(W) * static_cast<size_t>(H) * 4);

        Gdiplus::Graphics g(memDC);
        g.SetSmoothingMode(Gdiplus::SmoothingModeAntiAlias);
        g.SetTextRenderingHint(Gdiplus::TextRenderingHintAntiAliasGridFit);

        // Snapshot real host & target data
        HwSnapshot hw = hw_ ? hw_->Get() : HwSnapshot{};
        TargetProcStats procMem = QueryTargetProcMemory();
        bool fakeOn = fakeFpsEnabled_.load();
        int capVal = std::max(5, std::min(144, fakeFpsLimit_.load()));

        // Determine native refresh rate from DWM
        double refreshHz = 60.0;
        DWM_TIMING_INFO dti{};
        dti.cbSize = sizeof(dti);
        if (SUCCEEDED(DwmGetCompositionTimingInfo(nullptr, &dti)) && dti.rateRefresh.uiDenominator > 0) {
            double r = static_cast<double>(dti.rateRefresh.uiNumerator) / static_cast<double>(dti.rateRefresh.uiDenominator);
            if (r >= 24.0 && r <= 360.0) refreshHz = r;
        }

        // Compute displayed FPS (reflecting active FPS cap cleanly with realistic micro-variation)
        double jitter = std::sin(phase * 3.7) * 0.18 + std::cos(phase * 7.1) * 0.11;
        double loadDip = (hw.gpuPct > 92.0) ? ((hw.gpuPct - 92.0) * 0.35) : 0.0;
        double fps = fakeOn
            ? std::max(1.0, std::min(static_cast<double>(capVal), static_cast<double>(capVal) - std::abs(jitter) * 1.4 - loadDip * 0.3))
            : std::max(15.0, refreshHz - loadDip + jitter * 1.5);
        displayedFps_.store(fps);
        double frameMs = 1000.0 / std::max(1.0, fps);
        ftHist.push_back(static_cast<float>(frameMs));
        while (ftHist.size() > 56) ftHist.pop_front();

        std::string exeName;
        DWORD pid = 0;
        ULONGLONG uptimeSec = 0;
        std::vector<std::string> evCopy;
        {
            std::lock_guard<std::mutex> lk(mu_);
            exeName = targetExeName_;
            pid = targetPid_;
            uptimeSec = (GetTickCount64() - launchTickMs_) / 1000ULL;
            evCopy.assign(eventLog_.begin(), eventLog_.end());
        }

        // Responsive scale for 720p / 1080p / 1440p / 4K monitors
        float sc = std::clamp(static_cast<float>(H) / 1080.0f, 0.72f, 1.35f);
        auto S = [&](float v) -> float { return v * sc; };

        Gdiplus::FontFamily ffMono(L"Consolas");
        Gdiplus::FontFamily ffUi(L"Segoe UI");
        Gdiplus::Font fTitle(&ffUi, S(11.0f), Gdiplus::FontStyleBold, Gdiplus::UnitPoint);
        Gdiplus::Font fBigFps(&ffMono, S(21.0f), Gdiplus::FontStyleBold, Gdiplus::UnitPoint);
        Gdiplus::Font fMono(&ffMono, S(9.2f), Gdiplus::FontStyleRegular, Gdiplus::UnitPoint);
        Gdiplus::Font fMonoB(&ffMono, S(9.5f), Gdiplus::FontStyleBold, Gdiplus::UnitPoint);
        Gdiplus::Font fSmall(&ffMono, S(8.2f), Gdiplus::FontStyleRegular, Gdiplus::UnitPoint);

        Gdiplus::SolidBrush brPanel(Gdiplus::Color(186, 8, 12, 20));
        Gdiplus::SolidBrush brPanelDark(Gdiplus::Color(206, 6, 9, 15));
        Gdiplus::SolidBrush brShadow(Gdiplus::Color(180, 0, 0, 0));
        Gdiplus::SolidBrush brWhite(Gdiplus::Color(245, 240, 246, 255));
        Gdiplus::SolidBrush brDim(Gdiplus::Color(220, 156, 174, 198));
        Gdiplus::SolidBrush brGold(Gdiplus::Color(255, 250, 204, 48));
        Gdiplus::SolidBrush brCyan(Gdiplus::Color(255, 56, 208, 255));
        Gdiplus::SolidBrush brGreen(Gdiplus::Color(255, 42, 230, 132));
        Gdiplus::SolidBrush brAmber(Gdiplus::Color(255, 255, 165, 42));
        Gdiplus::SolidBrush brRed(Gdiplus::Color(255, 255, 78, 96));
        Gdiplus::SolidBrush brPink(Gdiplus::Color(255, 255, 82, 168));
        Gdiplus::SolidBrush brTrack(Gdiplus::Color(115, 255, 255, 255));
        Gdiplus::Pen penBorderGold(Gdiplus::Color(170, 250, 204, 48), S(1.2f));
        Gdiplus::Pen penBorderCyan(Gdiplus::Color(155, 56, 208, 255), S(1.2f));
        Gdiplus::Pen penBorderDim(Gdiplus::Color(110, 148, 163, 184), S(1.0f));

        auto drawStr = [&](const std::string& utf8, const Gdiplus::Font& fnt, const Gdiplus::Brush& br, float x, float y) {
            std::wstring ws = Utf8ToWideLocal(utf8);
            g.DrawString(ws.c_str(), -1, &fnt, Gdiplus::PointF(x + 1.0f, y + 1.0f), &brShadow);
            g.DrawString(ws.c_str(), -1, &fnt, Gdiplus::PointF(x, y), &br);
        };

        auto drawPanel = [&](float x, float y, float w, float h, const Gdiplus::Pen& border, Gdiplus::Color hdrCol, const std::string& title) {
            g.FillRectangle(&brPanel, x, y, w, h);
            Gdiplus::SolidBrush hdrBr(hdrCol);
            g.FillRectangle(&hdrBr, x, y, w, S(24.0f));
            g.DrawRectangle(&border, x, y, w, h);
            drawStr(title, fTitle, brWhite, x + S(9.0f), y + S(3.5f));
        };

        auto drawBar = [&](float x, float y, float w, float h, float pct, const Gdiplus::Brush& fillBr) {
            float cl = std::clamp(pct, 0.0f, 100.0f);
            g.FillRectangle(&brTrack, x, y, w, h);
            if (cl > 0.5f) g.FillRectangle(&fillBr, x, y, w * (cl / 100.0f), h);
        };

        const float pad = S(14.0f);
        const float bottomH = S(34.0f);
        const float leftW = S(395.0f);
        const float rightW = S(375.0f);

        // =========================================================================
        // 1. TOP-LEFT PANEL: RAGE 9 BUILD + LIVE FPS + FRAME GRAPH + WORLD STREAMING
        // =========================================================================
        const float tlH = S(246.0f);
        drawPanel(pad, pad, leftW, tlH, penBorderGold, Gdiplus::Color(200, 130, 88, 12),
                  "RAGE 9.0.2641-DEV  ·  AMERICAS / LEONIDA  [DEVKIT]");

        float y = pad + S(30.0f);
        const Gdiplus::Brush& fpsBr = (fps >= 45.0) ? static_cast<const Gdiplus::Brush&>(brGreen)
                                    : (fps >= 24.0 ? static_cast<const Gdiplus::Brush&>(brAmber)
                                                   : static_cast<const Gdiplus::Brush&>(brRed));
        char buf[256];
        std::snprintf(buf, sizeof(buf), "%.1f FPS", fps);
        drawStr(buf, fBigFps, fpsBr, pad + S(12.0f), y);

        std::snprintf(buf, sizeof(buf), "%.2f ms  |  %s", frameMs, fakeOn ? "CAP ACTIVE" : "NATIVE");
        drawStr(buf, fMonoB, fakeOn ? static_cast<const Gdiplus::Brush&>(brGold) : static_cast<const Gdiplus::Brush&>(brCyan),
                pad + S(178.0f), y + S(4.0f));
        if (fakeOn) {
            std::snprintf(buf, sizeof(buf), "FAKE FPS LIMIT: MAX %d FPS", capVal);
            drawStr(buf, fSmall, brAmber, pad + S(178.0f), y + S(21.0f));
        } else {
            std::snprintf(buf, sizeof(buf), "DWM REFRESH: %.0f Hz", refreshHz);
            drawStr(buf, fSmall, brDim, pad + S(178.0f), y + S(21.0f));
        }
        y += S(42.0f);

        // Live Frame-Time Sparkline Graph
        float gx = pad + S(12.0f), gy = y, gw = leftW - S(24.0f), gh = S(46.0f);
        g.FillRectangle(&brPanelDark, gx, gy, gw, gh);
        g.DrawRectangle(&penBorderDim, gx, gy, gw, gh);
        Gdiplus::Pen penGraph(fakeOn ? Gdiplus::Color(255, 250, 204, 48) : Gdiplus::Color(255, 42, 230, 132), S(1.6f));
        float maxScaleMs = std::max(40.0f, static_cast<float>(frameMs * 1.45));
        if (ftHist.size() >= 2) {
            for (size_t i = 1; i < ftHist.size(); ++i) {
                float x0 = gx + (static_cast<float>(i - 1) / static_cast<float>(ftHist.size() - 1)) * gw;
                float x1 = gx + (static_cast<float>(i)     / static_cast<float>(ftHist.size() - 1)) * gw;
                float y0 = gy + gh - std::clamp(ftHist[i - 1] / maxScaleMs, 0.04f, 0.96f) * gh;
                float y1 = gy + gh - std::clamp(ftHist[i]     / maxScaleMs, 0.04f, 0.96f) * gh;
                g.DrawLine(&penGraph, x0, y0, x1, y1);
            }
        }
        y += gh + S(8.0f);

        unsigned hrs = static_cast<unsigned>(uptimeSec / 3600);
        unsigned mins = static_cast<unsigned>((uptimeSec % 3600) / 60);
        unsigned secs = static_cast<unsigned>(uptimeSec % 60);
        std::string shortExe = exeName.size() > 24 ? exeName.substr(0, 22) + ".." : exeName;
        std::snprintf(buf, sizeof(buf), "PROC: %s (PID %lu)  UP %02u:%02u:%02u",
                      shortExe.c_str(), static_cast<unsigned long>(pid), hrs, mins, secs);
        drawStr(buf, fMonoB, brWhite, pad + S(12.0f), y); y += S(17.0f);

        std::snprintf(buf, sizeof(buf), "VIEWPORT: %dx%d  ·  SUBPROCESSES: %d  ·  D3D12/VK",
                      W, H, std::max(1, procMem.procCount));
        drawStr(buf, fMono, brDim, pad + S(12.0f), y); y += S(17.0f);

        double wx = 1422.4 + std::sin(phase * 0.25) * 18.6;
        double wy = -2810.9 + std::cos(phase * 0.21) * 14.2;
        double wz = 14.8 + std::sin(phase * 0.4) * 0.9;
        std::snprintf(buf, sizeof(buf), "WORLD: VC_BEACH  [X:%+.1f Y:%+.1f Z:%+.1f]", wx, wy, wz);
        drawStr(buf, fMono, brCyan, pad + S(12.0f), y); y += S(17.0f);

        int peds = 82 + static_cast<int>(std::sin(phase * 0.6) * 6.0);
        int vehs = 41 + static_cast<int>(std::cos(phase * 0.5) * 4.0);
        int dc = 3180 + static_cast<int>(std::sin(phase * 1.4) * 140.0);
        std::snprintf(buf, sizeof(buf), "SCENE: Peds %d/160 · Vehs %d/96 · DrawCalls %d", peds, vehs, dc);
        drawStr(buf, fMono, brDim, pad + S(12.0f), y); y += S(17.0f);

        std::snprintf(buf, sizeof(buf), "STREAM POOL: Phys 3,842/6,144MB · Virt 2,110/4,096MB");
        drawStr(buf, fSmall, brGold, pad + S(12.0f), y);

        // =========================================================================
        // 2. LEFT-MIDDLE PANEL: SUBSYSTEM TIMINGS + ENGINE FLAGS + LIVE KERNEL LOG
        // =========================================================================
        const float lmY = pad + tlH + S(10.0f);
        const float lmH = std::min(S(365.0f), static_cast<float>(H) - lmY - bottomH - S(12.0f));
        if (lmH > S(140.0f)) {
            drawPanel(pad, lmY, leftW, lmH, penBorderDim, Gdiplus::Color(185, 22, 34, 52),
                      "ENGINE SUBSYSTEMS · PROFILER & EVENT STREAM");
            float ly = lmY + S(30.0f);
            struct SubItem { const char* name; float share; };
            const SubItem subs[] = {
                { "RenderThread",  0.34f },
                { "GpuMainPass",   0.46f },
                { "Physics/RAGE",  0.14f },
                { "AI / PedCrowd", 0.11f },
                { "StreamingIO",   0.09f },
                { "Audio/DSP",     0.05f },
                { "ScriptVM",      0.08f }
            };
            for (const auto& s : subs) {
                if (ly + S(17.0f) > lmY + lmH - S(95.0f)) break;
                float ms = static_cast<float>(frameMs) * s.share * (0.94f + 0.12f * static_cast<float>(std::sin(phase * 2.1 + s.share * 10.0f)));
                std::snprintf(buf, sizeof(buf), "%-14s %5.2f ms", s.name, ms);
                drawStr(buf, fSmall, brWhite, pad + S(12.0f), ly);
                drawBar(pad + S(190.0f), ly + S(3.0f), leftW - S(204.0f), S(8.0f),
                        std::min(100.0f, s.share * 180.0f), (s.share > 0.35f) ? static_cast<const Gdiplus::Brush&>(brPink) : static_cast<const Gdiplus::Brush&>(brCyan));
                ly += S(17.5f);
            }

            ly += S(6.0f);
            drawStr("FLAGS: RTGI:ON · VOL_CLOUDS:ULTRA · HAIR:STRAND · FOXXY:ROOT", fSmall, brGold, pad + S(12.0f), ly);
            ly += S(18.0f);
            drawStr("EVENT STREAM:", fMonoB, brCyan, pad + S(12.0f), ly);
            ly += S(16.0f);
            for (const auto& ev : evCopy) {
                if (ly + S(14.0f) > lmY + lmH - S(6.0f)) break;
                drawStr(ev, fSmall, brDim, pad + S(12.0f), ly);
                ly += S(14.5f);
            }
        }

        // =========================================================================
        // 3. TOP-RIGHT PANEL: REAL WINDOWS HOST HARDWARE & TARGET PROCESS PROFILER
        // =========================================================================
        const float rx = static_cast<float>(W) - rightW - pad;
        const float trH = S(268.0f);
        drawPanel(rx, pad, rightW, trH, penBorderCyan, Gdiplus::Color(200, 14, 72, 126),
                  "REAL WINDOWS HARDWARE & TARGET PROFILER");
        float ry = pad + S(30.0f);

        std::string gpuNm = hw.gpuName.empty() ? "Direct3D Hardware GPU" : hw.gpuName;
        if (gpuNm.size() > 36) gpuNm = gpuNm.substr(0, 34) + "..";
        drawStr("GPU: " + gpuNm, fMonoB, brCyan, rx + S(12.0f), ry); ry += S(19.0f);

        std::snprintf(buf, sizeof(buf), "GPU 3D LOAD:   %5.1f%%    VRAM: %.0f MB", hw.gpuPct, hw.vramUsedMb);
        drawStr(buf, fMono, brWhite, rx + S(12.0f), ry); ry += S(16.0f);
        drawBar(rx + S(12.0f), ry, rightW - S(24.0f), S(7.0f), static_cast<float>(hw.gpuPct), brGreen); ry += S(15.0f);

        std::snprintf(buf, sizeof(buf), "HOST CPU LOAD: %5.1f%%    CORES: ONLINE", hw.cpuPct);
        drawStr(buf, fMono, brWhite, rx + S(12.0f), ry); ry += S(16.0f);
        drawBar(rx + S(12.0f), ry, rightW - S(24.0f), S(7.0f), static_cast<float>(hw.cpuPct), brCyan); ry += S(15.0f);

        double ramPct = (hw.ramTotalGb > 0.1) ? (hw.ramUsedGb / hw.ramTotalGb * 100.0) : 0.0;
        std::snprintf(buf, sizeof(buf), "SYSTEM RAM:    %.1f / %.1f GB (%.0f%%)", hw.ramUsedGb, hw.ramTotalGb, ramPct);
        drawStr(buf, fMono, brWhite, rx + S(12.0f), ry); ry += S(16.0f);
        drawBar(rx + S(12.0f), ry, rightW - S(24.0f), S(7.0f), static_cast<float>(ramPct), brGold); ry += S(17.0f);

        std::snprintf(buf, sizeof(buf), "EXE WORKING SET: %7.1f MB", procMem.workingSetMb);
        drawStr(buf, fMonoB, brWhite, rx + S(12.0f), ry); ry += S(17.0f);
        std::snprintf(buf, sizeof(buf), "EXE PRIVATE MEM: %7.1f MB", procMem.privateMb);
        drawStr(buf, fMono, brDim, rx + S(12.0f), ry); ry += S(20.0f);

        // FPS Limiter badge box inside top-right panel
        Gdiplus::SolidBrush capBg(fakeOn ? Gdiplus::Color(165, 115, 72, 10) : Gdiplus::Color(140, 18, 36, 52));
        g.FillRectangle(&capBg, rx + S(10.0f), ry, rightW - S(20.0f), S(38.0f));
        g.DrawRectangle(fakeOn ? &penBorderGold : &penBorderDim, rx + S(10.0f), ry, rightW - S(20.0f), S(38.0f));
        if (fakeOn) {
            std::snprintf(buf, sizeof(buf), "FAKE FPS CAP: ACTIVE -> MAX %d FPS", capVal);
            drawStr(buf, fMonoB, brGold, rx + S(18.0f), ry + S(5.0f));
            drawStr("Process Pacing Limiter enforcing hard frame ceiling", fSmall, brWhite, rx + S(18.0f), ry + S(21.0f));
        } else {
            drawStr("FAKE FPS CAP: OFF (NATIVE UNLOCKED)", fMonoB, brGreen, rx + S(18.0f), ry + S(5.0f));
            drawStr("Enable in ViceBox Developer Tab to cap target .exe", fSmall, brDim, rx + S(18.0f), ry + S(21.0f));
        }

        // =========================================================================
        // 4. RIGHT-MIDDLE PANEL: MEMORY HEAPS + LIVE INPUT / CONTROLLER BUS
        // =========================================================================
        const float rmY = pad + trH + S(10.0f);
        const float rmH = std::min(S(290.0f), static_cast<float>(H) - rmY - bottomH - S(12.0f));
        if (rmH > S(140.0f)) {
            drawPanel(rx, rmY, rightW, rmH, penBorderDim, Gdiplus::Color(185, 22, 34, 52),
                      "MEMORY ALLOCATORS & LIVE INPUT BUS");
            float my = rmY + S(30.0f);
            struct HeapInfo { const char* lbl; float pct; const char* mb; };
            const HeapInfo heaps[] = {
                { "GameHeap",    62.0f, "2,480 / 4,000 MB" },
                { "RenderHeap",  74.0f, "1,480 / 2,000 MB" },
                { "TexturePool", 81.0f, "3,240 / 4,000 MB" },
                { "AudioHeap",   38.0f, "  304 /   800 MB" },
                { "NetworkPool", 24.0f, "   96 /   400 MB" }
            };
            for (const auto& hp : heaps) {
                if (my + S(22.0f) > rmY + rmH - S(95.0f)) break;
                std::snprintf(buf, sizeof(buf), "%-12s %s", hp.lbl, hp.mb);
                drawStr(buf, fSmall, brWhite, rx + S(12.0f), my);
                drawBar(rx + S(12.0f), my + S(13.0f), rightW - S(24.0f), S(5.0f),
                        hp.pct + static_cast<float>(std::sin(phase + hp.pct) * 2.0),
                        hp.pct > 75.0f ? static_cast<const Gdiplus::Brush&>(brAmber) : static_cast<const Gdiplus::Brush&>(brCyan));
                my += S(23.0f);
            }

            my += S(8.0f);
            POINT mp{};
            GetCursorPos(&mp);
            bool lmb = (GetAsyncKeyState(VK_LBUTTON) & 0x8000) != 0;
            bool rmb = (GetAsyncKeyState(VK_RBUTTON) & 0x8000) != 0;
            std::snprintf(buf, sizeof(buf), "MOUSE: (%ld, %ld)  LMB:%d  RMB:%d",
                          mp.x, mp.y, lmb ? 1 : 0, rmb ? 1 : 0);
            drawStr(buf, fMono, brWhite, rx + S(12.0f), my); my += S(18.0f);

            XINPUT_STATE xs{};
            bool padOk = (pXInputGetState_ != nullptr) && (pXInputGetState_(0, &xs) == ERROR_SUCCESS);
            if (padOk) {
                float lx = xs.Gamepad.sThumbLX / 32767.0f;
                float ly = xs.Gamepad.sThumbLY / 32767.0f;
                float rxS = xs.Gamepad.sThumbRX / 32767.0f;
                float ryS = xs.Gamepad.sThumbRY / 32767.0f;
                drawStr("XINPUT PAD 0: CONNECTED (ACTIVE)", fMonoB, brGreen, rx + S(12.0f), my); my += S(16.0f);
                std::snprintf(buf, sizeof(buf), "LS(%+.2f,%+.2f) RS(%+.2f,%+.2f) LT:%3u RT:%3u",
                              lx, ly, rxS, ryS, xs.Gamepad.bLeftTrigger, xs.Gamepad.bRightTrigger);
                drawStr(buf, fSmall, brCyan, rx + S(12.0f), my);
            } else {
                drawStr("XINPUT PAD 0: STANDBY (KB/MOUSE ACTIVE)", fMono, brDim, rx + S(12.0f), my);
            }
        }

        // =========================================================================
        // 5. FULL-WIDTH BOTTOM DEVKIT STATUS STRIP
        // =========================================================================
        const float by = static_cast<float>(H) - bottomH;
        g.FillRectangle(&brPanelDark, 0.0f, by, static_cast<float>(W), bottomH);
        Gdiplus::Pen topLine(Gdiplus::Color(200, 250, 204, 48), S(1.6f));
        g.DrawLine(&topLine, 0.0f, by, static_cast<float>(W), by);

        drawStr("AMERICAS_DEV_BUILD  ·  CL# 49182044  ·  FOXXY FULLSCREEN DEV OVERLAY  ·  CONFIDENTIAL",
                fMonoB, brGold, S(14.0f), by + S(9.0f));

        SYSTEMTIME lt{};
        GetLocalTime(&lt);
        std::snprintf(buf, sizeof(buf), "%02u:%02u:%02u  |  %s (PID %lu)  |  CPU %.0f%%  GPU %.0f%%  MEM %.0fMB",
                      lt.wHour, lt.wMinute, lt.wSecond, shortExe.c_str(), static_cast<unsigned long>(pid),
                      hw.cpuPct, hw.gpuPct, procMem.workingSetMb);
        drawStr(buf, fMono, brWhite, static_cast<float>(W) * 0.43f, by + S(9.0f));

        std::string capStr = fakeOn ? (std::to_string(capVal) + " FPS") : "OFF";
        std::snprintf(buf, sizeof(buf), "[F10] TOGGLE HUD  ·  CAP: %s", capStr.c_str());
        drawStr(buf, fMonoB, fakeOn ? static_cast<const Gdiplus::Brush&>(brAmber) : static_cast<const Gdiplus::Brush&>(brCyan),
                static_cast<float>(W) - S(275.0f), by + S(9.0f));
    }

    HwMonitor* hw_ = nullptr;
    ULONG_PTR gdipToken_ = 0;
    bool gdipStarted_ = false;
    HMODULE ntdll_ = nullptr;
    PFN_NtProc pNtSuspendProcess_ = nullptr;
    PFN_NtProc pNtResumeProcess_ = nullptr;
    HMODULE xinputDll_ = nullptr;
    PFN_XInputGetState pXInputGetState_ = nullptr;

    mutable std::mutex mu_;
    HANDLE hJob_ = nullptr;
    HANDLE hTargetProc_ = nullptr;
    DWORD targetPid_ = 0;
    std::string targetExeName_;
    std::string targetFullPath_;
    ULONGLONG launchTickMs_ = 0;
    std::deque<std::string> eventLog_;

    std::atomic<bool> fullOverlayEnabled_{true};
    std::atomic<bool> userHidOverlay_{false};
    std::atomic<bool> fakeFpsEnabled_{false};
    std::atomic<int>  fakeFpsLimit_{30};
    std::atomic<bool> stopSession_{false};
    std::atomic<bool> sessionRunning_{false};
    std::atomic<double> displayedFps_{0.0};
    std::atomic<HWND> overlayHwnd_{nullptr};

    std::thread limiterThread_;
    std::thread overlayThread_;
};

} // namespace vicebox
