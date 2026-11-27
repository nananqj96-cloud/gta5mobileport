#pragma once

#ifdef _WIN32

#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif

#include <winsock2.h>
#include <windows.h>
#include <dwmapi.h>

#include <algorithm>
#include <cstdint>
#include <cstdlib>
#include <cwchar>
#include <functional>
#include <string>
#include <vector>

#include "dev_overlay.h"

namespace vicebox {

/**
 * Native Win32 Embedded Executable Viewport Host ("fitanyexe" Developer Feature).
 *
 * Captures the top-level window of ANY Windows .exe launched via DevTargetController
 * (including child processes spawned by launchers/bootstrappers via Job Object),
 * strips all native OS window chrome (title bar, borders, resize frame, system menu,
 * Win32 menu bar, taskbar button), and docks its client surface flush inside
 * ViceBox X's viewport rectangle so the .exe runs INSIDE the emulator GUI instead
 * of appearing as a separate desktop window.
 *
 * Uses true Win32 SetParent child embedding with SWP_ASYNCWINDOWPOS (deadlock-free),
 * plus automatic borderless owned-overlay fallback for elevated / DXGI windows that
 * refuse cross-process WS_CHILD reparenting.
 */
class EmbeddedExeHost {
public:
    enum class State {
        Idle,
        Searching,
        Embedded,
        Error
    };

    EmbeddedExeHost() = default;
    ~EmbeddedExeHost() { Shutdown(); }

    void SetCallbacks(std::function<void(const std::string&)> onDocked,
                      std::function<void(const std::string&)> onExited,
                      std::function<void(const std::string&)> onError,
                      std::function<void(const std::string&)> onLog) {
        onDocked_ = std::move(onDocked);
        onExited_ = std::move(onExited);
        onError_  = std::move(onError);
        onLog_    = std::move(onLog);
    }

    bool Init(HWND parentHwnd) {
        parentHwnd_ = parentHwnd;
        if (!containerHwnd_ && parentHwnd_) {
            const wchar_t* clsName = L"ViceBoxEmbeddedExeContainer";
            HINSTANCE hInst = GetModuleHandleW(nullptr);
            WNDCLASSEXW wc{};
            wc.cbSize = sizeof(wc);
            wc.lpfnWndProc = ContainerWndProc;
            wc.hInstance = hInst;
            wc.hbrBackground = reinterpret_cast<HBRUSH>(GetStockObject(BLACK_BRUSH));
            wc.lpszClassName = clsName;
            RegisterClassExW(&wc);

            containerHwnd_ = CreateWindowExW(
                0, clsName, L"ViceBox Embedded EXE Viewport",
                WS_CHILD | WS_CLIPCHILDREN | WS_CLIPSIBLINGS,
                0, 54, 800, 600,
                parentHwnd_, nullptr, hInst, nullptr);
            if (!containerHwnd_) return false;
            ShowWindow(containerHwnd_, SW_HIDE);
        }
        return containerHwnd_ != nullptr;
    }

    bool IsActive() const {
        return state_ == State::Searching || state_ == State::Embedded;
    }

    bool IsEmbedded() const {
        return state_ == State::Embedded && targetHwnd_ && IsWindow(targetHwnd_);
    }

    bool IsVisible() const {
        return visible_ && IsEmbedded();
    }

    State GetState() const { return state_; }
    const std::string& ExeName() const { return exeName_; }
    const std::string& LastError() const { return lastError_; }

    /**
     * Begins tracking the currently running DevTargetController .exe session and
     * automatically captures + embeds its main window into ViceBox X's viewport.
     */
    void BeginAttach(DevTargetController* devCtrl, int topOffsetPx, int parentW, int parentH) {
        DetachWindowOnly();
        devCtrl_ = devCtrl;
        topOffsetPx_ = topOffsetPx;
        parentW_ = std::max(1, parentW);
        parentH_ = std::max(1, parentH);
        exeName_ = devCtrl_ ? devCtrl_->GetExeName() : std::string();
        lastError_.clear();
        state_ = State::Searching;
        visible_ = false;
        searchStartMs_ = GetTickCount64();
        dockedAtMs_ = 0;
        lastWatchdogMs_ = 0;
        childMode_ = false;
        if (onLog_) onLog_("[FITANYEXE] Waiting for window of " + exeName_ + " to dock inside emulator viewport...");
    }

    /**
     * Called once per frame on the main Win32 UI thread.
     * Handles fast window capture, splash-screen auto-promotion, anti-escape style
     * enforcement, docked-owner coordinate tracking, and clean exit detection.
     */
    void Tick(int topOffsetPx, int parentW, int parentH) {
        topOffsetPx_ = topOffsetPx;
        parentW_ = std::max(1, parentW);
        parentH_ = std::max(1, parentH);

        if (state_ == State::Idle || state_ == State::Error) return;

        const uint64_t now = GetTickCount64();

        if (state_ == State::Searching) {
            // Check if process already exited before creating any GUI window
            if (!devCtrl_ || (!devCtrl_->IsTargetAlive() && (now - searchStartMs_) > 900ULL)) {
                state_ = State::Error;
                lastError_ = "The selected .exe exited before opening a GUI window.";
                if (onLog_) onLog_("[FITANYEXE] ERROR: " + lastError_);
                if (onError_) onError_(lastError_);
                return;
            }

            // Allow hidden/console fallback only after giving GUI apps 1.8s to show their real window
            bool allowFallback = (now - searchStartMs_) > 1800ULL;
            HWND found = FindBestTargetWindow(allowFallback, nullptr);
            if (found) {
                DockWindow(found);
                return;
            }

            // Timeout after 25s if the executable is purely headless/CLI with no window
            if ((now - searchStartMs_) > 25000ULL) {
                state_ = State::Error;
                lastError_ = "Timed out waiting for " + exeName_ + " to create a visible window (is it a console/background-only app?).";
                if (onLog_) onLog_("[FITANYEXE] ERROR: " + lastError_);
                if (onError_) onError_(lastError_);
            }
            return;
        }

        if (state_ == State::Embedded) {
            // Check if the embedded .exe closed or terminated
            bool winGone = (!targetHwnd_ || !IsWindow(targetHwnd_));
            bool procDead = (!devCtrl_ || !devCtrl_->IsTargetAlive());

            if (winGone && !procDead) {
                // App may have closed a launcher/splash window and spawned its real game window!
                HWND replacement = FindBestTargetWindow(false, targetHwnd_);
                if (replacement) {
                    if (onLog_) onLog_("[FITANYEXE] Main window transitioned — seamlessly re-docking new game window...");
                    targetHwnd_ = nullptr;
                    DockWindow(replacement);
                    return;
                }
                // Give a brief 2.5s window-transition grace period while process is still alive
                if (lostWinAtMs_ == 0) lostWinAtMs_ = now;
                if ((now - lostWinAtMs_) < 2500ULL) return;
            } else {
                lostWinAtMs_ = 0;
            }

            if (winGone || procDead) {
                std::string finishedName = exeName_;
                CleanupAfterExit();
                if (onLog_) onLog_("[FITANYEXE] Target " + finishedName + " exited — restored ViceBox X viewport");
                if (onExited_) onExited_(finishedName);
                return;
            }

            // Splash-screen upgrade check during the first 12 seconds: if a small splash window was docked
            // and the process spawns a larger primary window, automatically promote it!
            if (visible_ && (now - dockedAtMs_) < 12000ULL && (now - lastWatchdogMs_) >= 200ULL) {
                if (origW_ < 560 || origH_ < 360) {
                    HWND bigger = FindBestTargetWindow(false, targetHwnd_);
                    if (bigger && bigger != targetHwnd_) {
                        RECT br{};
                        GetWindowRect(bigger, &br);
                        int bw = br.right - br.left;
                        int bh = br.bottom - br.top;
                        if (bw > origW_ + 80 || bh > origH_ + 80) {
                            if (onLog_) onLog_("[FITANYEXE] Detected main application window replacing splash — promoting...");
                            ShowWindowAsync(targetHwnd_, SW_HIDE);
                            targetHwnd_ = nullptr;
                            DockWindow(bigger);
                            return;
                        }
                    }
                }
            }

            // Periodic 120ms anti-escape watchdog: re-strip titlebar/borders/menu if the app tried to restore
            // its own chrome after DXGI/Vulkan/Qt init, and snap flush to ViceBox X's viewport bounds!
            if ((now - lastWatchdogMs_) >= 120ULL) {
                lastWatchdogMs_ = now;
                if (visible_) {
                    EnforceStrippedChromeAndBounds();
                } else if (!childMode_ && IsWindowVisible(targetHwnd_)) {
                    ShowWindowAsync(targetHwnd_, SW_HIDE);
                }
            } else if (visible_ && !childMode_) {
                // In docked-owner fallback mode, keep screen coordinates locked every single frame
                SyncDockedOwnerBounds();
            }
        }
    }

    void Show(int topOffsetPx, int parentW, int parentH) {
        topOffsetPx_ = topOffsetPx;
        parentW_ = std::max(1, parentW);
        parentH_ = std::max(1, parentH);
        if (!IsEmbedded() || !containerHwnd_) return;
        visible_ = true;
        int w = std::max(1, parentW_);
        int h = std::max(1, parentH_ - topOffsetPx_);
        SetWindowPos(containerHwnd_, HWND_TOP, 0, topOffsetPx_, w, h, SWP_SHOWWINDOW);
        ShowWindow(containerHwnd_, SW_SHOW);
        EnforceStrippedChromeAndBounds();
        if (targetHwnd_ && IsWindow(targetHwnd_)) {
            ShowWindowAsync(targetHwnd_, SW_SHOW);
        }
    }

    void Hide() {
        visible_ = false;
        if (containerHwnd_ && IsWindow(containerHwnd_)) {
            ShowWindow(containerHwnd_, SW_HIDE);
        }
        if (targetHwnd_ && IsWindow(targetHwnd_) && !childMode_) {
            ShowWindowAsync(targetHwnd_, SW_HIDE);
        }
        if (parentHwnd_ && IsWindow(parentHwnd_)) {
            SetFocus(parentHwnd_);
        }
    }

    void Resize(int topOffsetPx, int parentW, int parentH) {
        topOffsetPx_ = topOffsetPx;
        parentW_ = std::max(1, parentW);
        parentH_ = std::max(1, parentH);
        if (!containerHwnd_ || !IsWindow(containerHwnd_)) return;
        int w = std::max(1, parentW_);
        int h = std::max(1, parentH_ - topOffsetPx_);
        MoveWindow(containerHwnd_, 0, topOffsetPx_, w, h, TRUE);
        if (visible_ && IsEmbedded()) {
            if (childMode_) {
                SetWindowPos(targetHwnd_, HWND_TOP, 0, 0, w, h,
                             SWP_ASYNCWINDOWPOS | SWP_NOACTIVATE | SWP_FRAMECHANGED);
            } else {
                SyncDockedOwnerBounds();
            }
        }
    }

    void NotifyParentMoved() {
        if (visible_ && IsEmbedded() && !childMode_) {
            SyncDockedOwnerBounds();
        }
    }

    /**
     * Cleanly terminates the embedded .exe and resets the host to Idle.
     */
    void Stop() {
        HWND hwnd = targetHwnd_;
        if (hwnd && IsWindow(hwnd)) {
            PostMessageW(hwnd, WM_CLOSE, 0, 0);
        }
        if (devCtrl_) {
            // Brief grace window for graceful WM_CLOSE exit before forceful Job cleanup
            for (int i = 0; i < 12; ++i) {
                if (!devCtrl_->IsTargetAlive()) break;
                Sleep(20);
            }
            if (devCtrl_->IsTargetAlive()) {
                devCtrl_->TerminateAllTrackedProcesses();
            }
            devCtrl_->StopSession();
        }
        CleanupAfterExit();
    }

    void Shutdown() {
        if (IsActive()) {
            Stop();
        }
        if (containerHwnd_ && IsWindow(containerHwnd_)) {
            DestroyWindow(containerHwnd_);
            containerHwnd_ = nullptr;
        }
    }

private:
    static LRESULT CALLBACK ContainerWndProc(HWND hWnd, UINT msg, WPARAM wParam, LPARAM lParam) {
        if (msg == WM_ERASEBKGND) {
            RECT rc{};
            GetClientRect(hWnd, &rc);
            FillRect(reinterpret_cast<HDC>(wParam), &rc, reinterpret_cast<HBRUSH>(GetStockObject(BLACK_BRUSH)));
            return 1;
        }
        return DefWindowProcW(hWnd, msg, wParam, lParam);
    }

    struct EnumSearchCtx {
        std::vector<DWORD> pids;
        DWORD selfPid = 0;
        HWND containerHwnd = nullptr;
        HWND ignoreHwnd = nullptr;
        bool allowFallback = false;
        HWND bestHwnd = nullptr;
        int64_t bestScore = -1;
    };

    static bool IsIgnoredSystemClass(const wchar_t* cls) {
        if (!cls || !cls[0]) return true;
        static const wchar_t* kSkip[] = {
            L"IME", L"MSCTFIME UI", L"CicMarshalWndClass",
            L"tooltips_class32", L"DummyDWMListenerWindow",
            L"EdgeUiInputTopWndClass", L"ApplicationFrameInputSinkWindow",
            L"WorkerW", L"Progman", L"Shell_TrayWnd"
        };
        for (const wchar_t* s : kSkip) {
            if (_wcsicmp(cls, s) == 0) return true;
        }
        return false;
    }

    static BOOL CALLBACK EnumWindowsSearchProc(HWND hwnd, LPARAM lParam) {
        auto* ctx = reinterpret_cast<EnumSearchCtx*>(lParam);
        if (!hwnd || hwnd == ctx->containerHwnd || hwnd == ctx->ignoreHwnd) return TRUE;

        DWORD pid = 0;
        GetWindowThreadProcessId(hwnd, &pid);
        if (pid == 0 || pid == ctx->selfPid) return TRUE;
        if (std::find(ctx->pids.begin(), ctx->pids.end(), pid) == ctx->pids.end()) return TRUE;

        // Must be a top-level unowned window (skip owned popups / tooltips / dialogs)
        if (GetWindow(hwnd, GW_OWNER) != nullptr) return TRUE;

        wchar_t cls[128]{};
        GetClassNameW(hwnd, cls, 128);
        if (IsIgnoredSystemClass(cls)) return TRUE;

        bool isConsole = (_wcsicmp(cls, L"ConsoleWindowClass") == 0);
        if (isConsole && !ctx->allowFallback) return TRUE;

        bool vis = (IsWindowVisible(hwnd) != FALSE);
        if (!vis && !ctx->allowFallback) return TRUE;

        RECT rc{};
        if (!GetWindowRect(hwnd, &rc)) return TRUE;
        int w = rc.right - rc.left;
        int h = rc.bottom - rc.top;
        if (w < 100 || h < 70) return TRUE;

        LONG_PTR exStyle = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        if ((exStyle & WS_EX_TOOLWINDOW) && !ctx->allowFallback) return TRUE;

        int64_t score = static_cast<int64_t>(w) * static_cast<int64_t>(h);
        if (vis) score += 2000000LL;
        if (w >= 320 && h >= 200) score += 1000000LL;
        if (!isConsole) score += 500000LL;

        if (score > ctx->bestScore) {
            ctx->bestScore = score;
            ctx->bestHwnd = hwnd;
        }
        return TRUE;
    }

    HWND FindBestTargetWindow(bool allowFallback, HWND ignoreHwnd) const {
        if (!devCtrl_) return nullptr;
        EnumSearchCtx ctx;
        ctx.pids = devCtrl_->GetTrackedPids();
        if (ctx.pids.empty()) return nullptr;
        ctx.selfPid = GetCurrentProcessId();
        ctx.containerHwnd = containerHwnd_;
        ctx.ignoreHwnd = ignoreHwnd;
        ctx.allowFallback = allowFallback;
        EnumWindows(EnumWindowsSearchProc, reinterpret_cast<LPARAM>(&ctx));
        return ctx.bestHwnd;
    }

    void StripWindowChrome(HWND hwnd, bool asChild) {
        if (!hwnd || !IsWindow(hwnd)) return;

        // Remove native Win32 Menu Bar (File/Edit/View/Help) so emulator/app tool menus don't show!
        if (GetMenu(hwnd) != nullptr) {
            SetMenu(hwnd, nullptr);
        }

        LONG_PTR style = GetWindowLongPtrW(hwnd, GWL_STYLE);
        constexpr LONG_PTR kStripMask =
            WS_CAPTION | WS_THICKFRAME | WS_BORDER | WS_DLGFRAME |
            WS_SYSMENU | WS_MINIMIZEBOX | WS_MAXIMIZEBOX | WS_MINIMIZE | WS_MAXIMIZE;
        style &= ~kStripMask;
        if (asChild) {
            style &= ~static_cast<LONG_PTR>(WS_POPUP);
            style |= (WS_CHILD | WS_VISIBLE | WS_CLIPSIBLINGS | WS_CLIPCHILDREN);
        } else {
            style &= ~static_cast<LONG_PTR>(WS_CHILD);
            style |= (WS_POPUP | WS_VISIBLE | WS_CLIPSIBLINGS | WS_CLIPCHILDREN);
        }
        SetWindowLongPtrW(hwnd, GWL_STYLE, style);

        LONG_PTR exStyle = GetWindowLongPtrW(hwnd, GWL_EXSTYLE);
        constexpr LONG_PTR kExStripMask =
            WS_EX_DLGMODALFRAME | WS_EX_WINDOWEDGE | WS_EX_CLIENTEDGE |
            WS_EX_STATICEDGE | WS_EX_APPWINDOW | WS_EX_OVERLAPPEDWINDOW;
        exStyle &= ~kExStripMask;
        exStyle |= WS_EX_TOOLWINDOW; // Keep completely off the Windows taskbar & Alt+Tab!
        SetWindowLongPtrW(hwnd, GWL_EXSTYLE, exStyle);

        // Disable Windows 11 rounded corners on the embedded child so edges sit pixel-flush
        constexpr DWORD kDwmAttrCornerPref = 33; // DWMWA_WINDOW_CORNER_PREFERENCE
        DWORD noRound = 1;                       // DWMWCP_DONOTROUND
        DwmSetWindowAttribute(hwnd, kDwmAttrCornerPref, &noRound, sizeof(noRound));
    }

    void DockWindow(HWND hwnd) {
        if (!hwnd || !IsWindow(hwnd) || !containerHwnd_) return;

        RECT rc{};
        GetWindowRect(hwnd, &rc);
        origW_ = rc.right - rc.left;
        origH_ = rc.bottom - rc.top;
        targetHwnd_ = hwnd;
        lostWinAtMs_ = 0;

        int w = std::max(1, parentW_);
        int h = std::max(1, parentH_ - topOffsetPx_);

        // Position & reveal our black clipping container inside ViceBox X first
        SetWindowPos(containerHwnd_, HWND_TOP, 0, topOffsetPx_, w, h, SWP_SHOWWINDOW);
        ShowWindow(containerHwnd_, SW_SHOW);

        // Attempt Mode 1: True Win32 SetParent child embedding inside ViceBox X's viewport!
        StripWindowChrome(hwnd, true);
        SetLastError(0);
        SetParent(hwnd, containerHwnd_);

        if (GetParent(hwnd) == containerHwnd_) {
            childMode_ = true;
            SetWindowPos(hwnd, HWND_TOP, 0, 0, w, h,
                         SWP_ASYNCWINDOWPOS | SWP_FRAMECHANGED | SWP_SHOWWINDOW);
            if (onLog_) onLog_("[FITANYEXE] Embedded " + exeName_ + " directly inside ViceBox X viewport (true child HWND, chrome stripped)");
        } else {
            // Mode 2 Fallback: Seamless borderless owned docking (for elevated/DXGI windows refusing WS_CHILD)
            childMode_ = false;
            StripWindowChrome(hwnd, false);
            SetWindowLongPtrW(hwnd, GWLP_HWNDPARENT, reinterpret_cast<LONG_PTR>(parentHwnd_));
            SyncDockedOwnerBounds();
            if (onLog_) onLog_("[FITANYEXE] Docked " + exeName_ + " flush inside ViceBox X viewport (borderless owned fallback, chrome stripped)");
        }

        state_ = State::Embedded;
        visible_ = true;
        dockedAtMs_ = GetTickCount64();
        lastWatchdogMs_ = dockedAtMs_;

        if (onDocked_) onDocked_(exeName_);
    }

    void EnforceStrippedChromeAndBounds() {
        if (!targetHwnd_ || !IsWindow(targetHwnd_)) return;

        // Re-strip if the app re-added WS_CAPTION/WS_THICKFRAME/HMENU after initialization
        LONG_PTR style = GetWindowLongPtrW(targetHwnd_, GWL_STYLE);
        LONG_PTR exStyle = GetWindowLongPtrW(targetHwnd_, GWL_EXSTYLE);
        bool dirtyStyle = ((style & (WS_CAPTION | WS_THICKFRAME | WS_BORDER | WS_DLGFRAME | WS_SYSMENU)) != 0) ||
                          ((exStyle & WS_EX_APPWINDOW) != 0) ||
                          (GetMenu(targetHwnd_) != nullptr);
        if (childMode_ && GetParent(targetHwnd_) != containerHwnd_) {
            SetParent(targetHwnd_, containerHwnd_);
            dirtyStyle = true;
        }
        if (dirtyStyle) {
            StripWindowChrome(targetHwnd_, childMode_);
        }

        int w = std::max(1, parentW_);
        int h = std::max(1, parentH_ - topOffsetPx_);
        if (childMode_) {
            RECT cr{};
            GetWindowRect(targetHwnd_, &cr);
            int cw = cr.right - cr.left;
            int ch = cr.bottom - cr.top;
            if (dirtyStyle || std::abs(cw - w) > 2 || std::abs(ch - h) > 2) {
                SetWindowPos(targetHwnd_, HWND_TOP, 0, 0, w, h,
                             SWP_ASYNCWINDOWPOS | SWP_NOACTIVATE | SWP_FRAMECHANGED | SWP_SHOWWINDOW);
            }
        } else {
            SyncDockedOwnerBounds();
        }
    }

    void SyncDockedOwnerBounds() {
        if (!targetHwnd_ || !IsWindow(targetHwnd_) || !containerHwnd_ || !IsWindow(containerHwnd_)) return;
        RECT sr{};
        if (!GetWindowRect(containerHwnd_, &sr)) return;
        int w = std::max(1, static_cast<int>(sr.right - sr.left));
        int h = std::max(1, static_cast<int>(sr.bottom - sr.top));
        SetWindowPos(targetHwnd_, HWND_TOP, sr.left, sr.top, w, h,
                     SWP_ASYNCWINDOWPOS | SWP_NOACTIVATE | SWP_FRAMECHANGED | SWP_SHOWWINDOW);
    }

    void DetachWindowOnly() {
        targetHwnd_ = nullptr;
        childMode_ = false;
        visible_ = false;
        lostWinAtMs_ = 0;
        if (containerHwnd_ && IsWindow(containerHwnd_)) {
            ShowWindow(containerHwnd_, SW_HIDE);
        }
    }

    void CleanupAfterExit() {
        DetachWindowOnly();
        devCtrl_ = nullptr;
        exeName_.clear();
        lastError_.clear();
        state_ = State::Idle;
        if (parentHwnd_ && IsWindow(parentHwnd_)) {
            SetFocus(parentHwnd_);
        }
    }

    HWND parentHwnd_ = nullptr;
    HWND containerHwnd_ = nullptr;
    HWND targetHwnd_ = nullptr;
    DevTargetController* devCtrl_ = nullptr;

    State state_ = State::Idle;
    bool visible_ = false;
    bool childMode_ = false;
    int topOffsetPx_ = 54;
    int parentW_ = 1280;
    int parentH_ = 720;
    int origW_ = 0;
    int origH_ = 0;
    uint64_t searchStartMs_ = 0;
    uint64_t dockedAtMs_ = 0;
    uint64_t lastWatchdogMs_ = 0;
    uint64_t lostWinAtMs_ = 0;

    std::string exeName_;
    std::string lastError_;

    std::function<void(const std::string&)> onDocked_;
    std::function<void(const std::string&)> onExited_;
    std::function<void(const std::string&)> onError_;
    std::function<void(const std::string&)> onLog_;
};

} // namespace vicebox

#endif // _WIN32
