#pragma once

#ifdef _WIN32

#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#ifndef NOMINMAX
#define NOMINMAX
#endif

#include <windows.h>
#include <objbase.h>
#include <algorithm>
#include <atomic>
#include <functional>
#include <string>

#ifdef VICEBOX_HAS_WEBVIEW2
#include <WebView2.h>
#endif

namespace vicebox {

/**
 * Embedded Microsoft Edge WebView2 Viewport Host inside the ViceBox X native Win32 window.
 * Keeps PS5 / Xbox / ViceOS Neo dashboards AND Grand Theft Auto V running 100% INSIDE
 * the ViceBox X window (never spawning external browser windows), with full WebGPU,
 * COOP/COEP SharedArrayBuffer, Pointer Lock, and DualSense/Xbox Gamepad API support.
 */
class EmbeddedViewportHost {
public:
    EmbeddedViewportHost() = default;
    ~EmbeddedViewportHost() { Shutdown(); }

    void SetCallbacks(std::function<void(bool)> onHtmlFullscreen,
                      std::function<void(const std::string&)> onFallbackExternal,
                      std::function<void(const std::string&)> onLog) {
        onHtmlFullscreen_ = std::move(onHtmlFullscreen);
        onFallbackExternal_ = std::move(onFallbackExternal);
        onLog_ = std::move(onLog);
    }

    bool Init(HWND parentHwnd, const std::wstring& userDataDir, bool highPerfGpu) {
        parentHwnd_ = parentHwnd;
        userDataDir_ = userDataDir;
        highPerfGpu_ = highPerfGpu;

#ifdef VICEBOX_HAS_WEBVIEW2
        if (!hostHwnd_) {
            const wchar_t* clsName = L"ViceBoxEmbeddedViewportHost";
            HINSTANCE hInst = GetModuleHandleW(nullptr);
            WNDCLASSEXW wc{};
            wc.cbSize = sizeof(wc);
            wc.lpfnWndProc = HostWndProc;
            wc.hInstance = hInst;
            wc.hbrBackground = reinterpret_cast<HBRUSH>(GetStockObject(BLACK_BRUSH));
            wc.lpszClassName = clsName;
            RegisterClassExW(&wc);

            hostHwnd_ = CreateWindowExW(
                0, clsName, L"ViceBox Embedded Viewport",
                WS_CHILD | WS_CLIPCHILDREN | WS_CLIPSIBLINGS,
                0, 54, 800, 600,
                parentHwnd_, nullptr, hInst, nullptr);
            if (!hostHwnd_) return false;
            ShowWindow(hostHwnd_, SW_HIDE);
        }
        return true;
#else
        return false;
#endif
    }

    bool IsSupportedBuild() const {
#ifdef VICEBOX_HAS_WEBVIEW2
        return !runtimeUnavailable_;
#else
        return false;
#endif
    }

    bool IsVisible() const { return visible_; }
    bool HasActiveSession() const { return hasSession_; }
    bool IsReady() const { return ready_; }
    const std::string& CurrentUrl() const { return currentUrl_; }

    /**
     * Opens a URL directly inside the embedded ViceBox X viewport.
     * Lazily initializes WebView2 on first launch so app startup stays instant.
     */
    bool OpenUrl(const std::string& url, int topOffsetPx, int parentW, int parentH) {
#ifdef VICEBOX_HAS_WEBVIEW2
        if (runtimeUnavailable_ || !hostHwnd_) {
            return false;
        }
        currentUrl_ = url;
        pendingUrl_ = Utf8ToWideLocal(url);
        hasSession_ = true;
        Show(topOffsetPx, parentW, parentH);

        if (ready_ && webview_) {
            webview_->Navigate(pendingUrl_.c_str());
            FocusViewport();
            return true;
        }

        if (!initializing_) {
            StartWebView2Init();
        }
        return true;
#else
        (void)url; (void)topOffsetPx; (void)parentW; (void)parentH;
        return false;
#endif
    }

    void Show(int topOffsetPx, int parentW, int parentH) {
#ifdef VICEBOX_HAS_WEBVIEW2
        if (!hostHwnd_) return;
        visible_ = true;
        Resize(topOffsetPx, parentW, parentH);
        if (ready_ && controller_) {
            ShowWindow(hostHwnd_, SW_SHOW);
            SetWindowPos(hostHwnd_, HWND_TOP, 0, topOffsetPx,
                         std::max(1, parentW), std::max(1, parentH - topOffsetPx),
                         SWP_SHOWWINDOW);
            controller_->put_IsVisible(TRUE);
            FocusViewport();
        }
#else
        (void)topOffsetPx; (void)parentW; (void)parentH;
#endif
    }

    void Hide() {
#ifdef VICEBOX_HAS_WEBVIEW2
        visible_ = false;
        if (controller_) {
            controller_->put_IsVisible(FALSE);
        }
        if (hostHwnd_) {
            ShowWindow(hostHwnd_, SW_HIDE);
        }
        if (parentHwnd_) {
            SetFocus(parentHwnd_);
        }
#endif
    }

    void StopSession() {
#ifdef VICEBOX_HAS_WEBVIEW2
        Hide();
        hasSession_ = false;
        currentUrl_.clear();
        pendingUrl_.clear();
        if (webview_) {
            webview_->Navigate(L"about:blank");
        }
#endif
    }

    void Resize(int topOffsetPx, int parentW, int parentH) {
#ifdef VICEBOX_HAS_WEBVIEW2
        if (!hostHwnd_) return;
        int w = std::max(1, parentW);
        int h = std::max(1, parentH - topOffsetPx);
        MoveWindow(hostHwnd_, 0, topOffsetPx, w, h, TRUE);
        if (controller_) {
            RECT bounds{ 0, 0, w, h };
            controller_->put_Bounds(bounds);
        }
#else
        (void)topOffsetPx; (void)parentW; (void)parentH;
#endif
    }

    void FocusViewport() {
#ifdef VICEBOX_HAS_WEBVIEW2
        if (visible_ && controller_) {
            controller_->MoveFocus(COREWEBVIEW2_MOVE_FOCUS_REASON_PROGRAMMATIC);
        }
#endif
    }

    void NotifyParentMoved() {
#ifdef VICEBOX_HAS_WEBVIEW2
        if (controller_) {
            controller_->NotifyParentWindowPositionChanged();
        }
#endif
    }

    void Shutdown() {
#ifdef VICEBOX_HAS_WEBVIEW2
        shuttingDown_ = true;
        if (webview_) {
            webview_->Release();
            webview_ = nullptr;
        }
        if (controller_) {
            controller_->Close();
            controller_->Release();
            controller_ = nullptr;
        }
        if (env_) {
            env_->Release();
            env_ = nullptr;
        }
        if (hostHwnd_ && IsWindow(hostHwnd_)) {
            DestroyWindow(hostHwnd_);
            hostHwnd_ = nullptr;
        }
        ready_ = false;
        visible_ = false;
        hasSession_ = false;
#endif
    }

private:
    static std::wstring Utf8ToWideLocal(const std::string& s) {
        if (s.empty()) return {};
        int n = MultiByteToWideChar(CP_UTF8, 0, s.c_str(), static_cast<int>(s.size()), nullptr, 0);
        if (n <= 0) return {};
        std::wstring ws(static_cast<size_t>(n), L'\0');
        MultiByteToWideChar(CP_UTF8, 0, s.c_str(), static_cast<int>(s.size()), &ws[0], n);
        return ws;
    }

    static LRESULT CALLBACK HostWndProc(HWND hWnd, UINT msg, WPARAM wParam, LPARAM lParam) {
        if (msg == WM_ERASEBKGND) return 1;
        return DefWindowProcW(hWnd, msg, wParam, lParam);
    }

#ifdef VICEBOX_HAS_WEBVIEW2
    template <typename Interface, typename Fn>
    class ComCallback : public Interface {
    public:
        explicit ComCallback(Fn fn) : refCount_(1), fn_(std::move(fn)) {}
        virtual ~ComCallback() = default;

        HRESULT STDMETHODCALLTYPE QueryInterface(REFIID riid, void** ppvObject) override {
            if (!ppvObject) return E_POINTER;
            if (IsEqualIID(riid, IID_IUnknown) || IsEqualIID(riid, __uuidof(Interface))) {
                *ppvObject = static_cast<Interface*>(this);
                AddRef();
                return S_OK;
            }
            *ppvObject = nullptr;
            return E_NOINTERFACE;
        }
        ULONG STDMETHODCALLTYPE AddRef() override {
            return static_cast<ULONG>(InterlockedIncrement(&refCount_));
        }
        ULONG STDMETHODCALLTYPE Release() override {
            ULONG c = static_cast<ULONG>(InterlockedDecrement(&refCount_));
            if (c == 0) delete this;
            return c;
        }

    protected:
        LONG refCount_;
        Fn fn_;
    };

    struct EnvHandler final : ComCallback<ICoreWebView2CreateCoreWebView2EnvironmentCompletedHandler,
                                          std::function<HRESULT(HRESULT, ICoreWebView2Environment*)>> {
        using ComCallback::ComCallback;
        HRESULT STDMETHODCALLTYPE Invoke(HRESULT res, ICoreWebView2Environment* env) override {
            return fn_(res, env);
        }
    };

    struct CtrlHandler final : ComCallback<ICoreWebView2CreateCoreWebView2ControllerCompletedHandler,
                                           std::function<HRESULT(HRESULT, ICoreWebView2Controller*)>> {
        using ComCallback::ComCallback;
        HRESULT STDMETHODCALLTYPE Invoke(HRESULT res, ICoreWebView2Controller* ctrl) override {
            return fn_(res, ctrl);
        }
    };

    struct NewWindowHandler final : ComCallback<ICoreWebView2NewWindowRequestedEventHandler,
                                                std::function<HRESULT(ICoreWebView2*, ICoreWebView2NewWindowRequestedEventArgs*)>> {
        using ComCallback::ComCallback;
        HRESULT STDMETHODCALLTYPE Invoke(ICoreWebView2* sender, ICoreWebView2NewWindowRequestedEventArgs* args) override {
            return fn_(sender, args);
        }
    };

    struct PermHandler final : ComCallback<ICoreWebView2PermissionRequestedEventHandler,
                                           std::function<HRESULT(ICoreWebView2*, ICoreWebView2PermissionRequestedEventArgs*)>> {
        using ComCallback::ComCallback;
        HRESULT STDMETHODCALLTYPE Invoke(ICoreWebView2* sender, ICoreWebView2PermissionRequestedEventArgs* args) override {
            return fn_(sender, args);
        }
    };

    struct FullscreenHandler final : ComCallback<ICoreWebView2ContainsFullScreenElementChangedEventHandler,
                                                 std::function<HRESULT(ICoreWebView2*, IUnknown*)>> {
        using ComCallback::ComCallback;
        HRESULT STDMETHODCALLTYPE Invoke(ICoreWebView2* sender, IUnknown* args) override {
            return fn_(sender, args);
        }
    };

    void StartWebView2Init() {
        initializing_ = true;
        std::wstring args = L"--autoplay-policy=no-user-gesture-required --disable-features=msWebOOUI,msPdfOOUI";
        if (highPerfGpu_) {
            args += L" --force-high-performance-gpu";
        }
        SetEnvironmentVariableW(L"WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS", args.c_str());

        auto* envCb = new EnvHandler([this](HRESULT hr, ICoreWebView2Environment* env) -> HRESULT {
            if (shuttingDown_) return S_OK;
            if (FAILED(hr) || !env) {
                HandleRuntimeMissing("WebView2 Environment init failed (HRESULT=" + std::to_string(static_cast<long>(hr)) + ")");
                return S_OK;
            }
            env_ = env;
            env_->AddRef();

            auto* ctrlCb = new CtrlHandler([this](HRESULT hr2, ICoreWebView2Controller* ctrl) -> HRESULT {
                if (shuttingDown_) return S_OK;
                initializing_ = false;
                if (FAILED(hr2) || !ctrl) {
                    HandleRuntimeMissing("WebView2 Controller creation failed");
                    return S_OK;
                }

                controller_ = ctrl;
                controller_->AddRef();

                ICoreWebView2* wv = nullptr;
                if (FAILED(controller_->get_CoreWebView2(&wv)) || !wv) {
                    HandleRuntimeMissing("WebView2 core interface missing");
                    return S_OK;
                }
                webview_ = wv;

                // Configure clean console-style WebView2 settings (no browser context menu, no URL bar, no zoom)
                ICoreWebView2Settings* settings = nullptr;
                if (SUCCEEDED(webview_->get_Settings(&settings)) && settings) {
                    settings->put_IsScriptEnabled(TRUE);
                    settings->put_IsWebMessageEnabled(TRUE);
                    settings->put_AreDefaultContextMenusEnabled(FALSE);
                    settings->put_IsStatusBarEnabled(FALSE);
                    settings->put_IsZoomControlEnabled(FALSE);
                    settings->put_AreDevToolsEnabled(FALSE);
                    settings->put_AreDefaultScriptDialogsEnabled(TRUE);
                    settings->Release();
                }

                // NEVER allow any link / window.open() to spawn a separate browser window!
                // Always redirect right inside the embedded ViceBox X viewport!
                EventRegistrationToken tokNewWin{};
                auto* nwCb = new NewWindowHandler([](ICoreWebView2* sender, ICoreWebView2NewWindowRequestedEventArgs* args) -> HRESULT {
                    if (args) {
                        args->put_Handled(TRUE);
                        LPWSTR uri = nullptr;
                        if (SUCCEEDED(args->get_Uri(&uri)) && uri) {
                            if (uri[0] && sender) {
                                sender->Navigate(uri);
                            }
                            CoTaskMemFree(uri);
                        }
                    }
                    return S_OK;
                });
                webview_->add_NewWindowRequested(nwCb, &tokNewWin);
                nwCb->Release();

                // Auto-approve permissions (Pointer Lock, Fullscreen, Media, etc.) cleanly
                EventRegistrationToken tokPerm{};
                auto* permCb = new PermHandler([](ICoreWebView2*, ICoreWebView2PermissionRequestedEventArgs* args) -> HRESULT {
                    if (args) args->put_State(COREWEBVIEW2_PERMISSION_STATE_ALLOW);
                    return S_OK;
                });
                webview_->add_PermissionRequested(permCb, &tokPerm);
                permCb->Release();

                // Sync HTML5 Fullscreen inside GTA V -> ViceBox X borderless fullscreen
                EventRegistrationToken tokFs{};
                auto* fsCb = new FullscreenHandler([this](ICoreWebView2* sender, IUnknown*) -> HRESULT {
                    if (!sender || !onHtmlFullscreen_) return S_OK;
                    BOOL isFs = FALSE;
                    if (SUCCEEDED(sender->get_ContainsFullScreenElement(&isFs))) {
                        onHtmlFullscreen_(isFs != FALSE);
                    }
                    return S_OK;
                });
                webview_->add_ContainsFullScreenElementChanged(fsCb, &tokFs);
                fsCb->Release();

                // Set dark obsidian default background so page transitions never flash white!
                ICoreWebView2Controller2* ctrl2 = nullptr;
                if (SUCCEEDED(controller_->QueryInterface(IID_PPV_ARGS(&ctrl2))) && ctrl2) {
                    COREWEBVIEW2_COLOR darkBg{ 255, 6, 9, 16 };
                    ctrl2->put_DefaultBackgroundColor(darkBg);
                    ctrl2->Release();
                }

                RECT rc{};
                GetClientRect(hostHwnd_, &rc);
                controller_->put_Bounds(rc);
                ready_ = true;
                if (visible_) {
                    ShowWindow(hostHwnd_, SW_SHOW);
                    SetWindowPos(hostHwnd_, HWND_TOP, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_SHOWWINDOW);
                    controller_->put_IsVisible(TRUE);
                } else {
                    controller_->put_IsVisible(FALSE);
                }

                if (onLog_) onLog_("[VIEWPORT] Embedded Edge WebView2 (WebGPU + PointerLock + Gamepad) ready inside ViceBox X");

                if (!pendingUrl_.empty()) {
                    webview_->Navigate(pendingUrl_.c_str());
                    if (visible_) FocusViewport();
                }
                return S_OK;
            });

            HRESULT hrCtrl = env_->CreateCoreWebView2Controller(hostHwnd_, ctrlCb);
            ctrlCb->Release();
            if (FAILED(hrCtrl)) {
                initializing_ = false;
                HandleRuntimeMissing("CreateCoreWebView2Controller failed");
            }
            return S_OK;
        });

        HRESULT hrEnv = CreateCoreWebView2EnvironmentWithOptions(
            nullptr,
            userDataDir_.empty() ? nullptr : userDataDir_.c_str(),
            nullptr,
            envCb);
        envCb->Release();

        if (FAILED(hrEnv)) {
            initializing_ = false;
            HandleRuntimeMissing("Edge WebView2 Runtime not installed on this PC");
        }
    }

    void HandleRuntimeMissing(const std::string& reason) {
        runtimeUnavailable_ = true;
        initializing_ = false;
        Hide();
        hasSession_ = false;
        if (onLog_) onLog_("[VIEWPORT] Fallback to external viewport (" + reason + ")");
        if (onFallbackExternal_ && !currentUrl_.empty()) {
            onFallbackExternal_(currentUrl_);
        }
    }

    ICoreWebView2Environment* env_ = nullptr;
    ICoreWebView2Controller*  controller_ = nullptr;
    ICoreWebView2*            webview_ = nullptr;
#endif

    HWND parentHwnd_ = nullptr;
    HWND hostHwnd_ = nullptr;
    std::wstring userDataDir_;
    bool highPerfGpu_ = false;
    bool initializing_ = false;
    bool ready_ = false;
    bool visible_ = false;
    bool hasSession_ = false;
    bool runtimeUnavailable_ = false;
    bool shuttingDown_ = false;
    std::string currentUrl_;
    std::wstring pendingUrl_;

    std::function<void(bool)> onHtmlFullscreen_;
    std::function<void(const std::string&)> onFallbackExternal_;
    std::function<void(const std::string&)> onLog_;
};

} // namespace vicebox

#endif // _WIN32
