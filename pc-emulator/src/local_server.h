#pragma once

#include <winsock2.h>
#include <ws2tcpip.h>
#include <windows.h>
#include <winhttp.h>
#include <shellapi.h>

#include <algorithm>
#include <atomic>
#include <cctype>
#include <cstdint>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <fstream>
#include <mutex>
#include <sstream>
#include <string>
#include <thread>
#include <utility>
#include <vector>

#include "embedded_assets.h"
#include "hw_monitor.h"
#include "dev_overlay.h"

namespace vicebox {

struct SharedEmulatorState {
    std::string consoleTarget      = "ps5";    // "ps5" | "xbox" | "viceos"
    std::string emulatedGame       = "gta5";   // "gta5" | "gta6" | "all"
    std::string profileName        = "Player";
    std::string psPlusTier         = "Extra";  // "None" | "Essential" | "Extra" | "Deluxe"
    bool        showDebugHud       = true;
    bool        enableCheatMenu    = true;
    bool        motionBlur         = false;
    int         motionBlurStrength = 55;
    bool        optimizationMode   = false;
    int         lookSensitivity    = 100;      // 20..300%
    int         resIndex           = 2;        // 0:1280x720, 1:1600x900, 2:1920x1080, 3:2560x1440, 4:3840x2160
    int         gta5Mode           = 0;        // 0:Balanced 60, 1:Ultra Visuals, 2:Performance Boost

    // Foxxy Developer Mode (unlocked when logging in as "Foxxy")
    bool        isFoxxyDev         = false;
    bool        devGta6Enabled     = false;
    bool        devExpGta6         = false;
    bool        devPerfAuto        = true;
    std::string devGta6ExePath;
    bool        devFullOverlay     = true;
    bool        devFakeFpsEnabled  = false;
    int         devFakeFpsLimit    = 30;
    std::string customGta5PlayPath;
    std::string customExpGta6PlayPath;
    bool        configDirtyFromWeb = false;

    // Live in-game telemetry pushed by Experimental GTA 6 WebGPU worker (/vbx/api/perf)
    double      liveGameFps        = 0.0;
    double      liveGameFrameMs    = 0.0;
    int         livePerfTier       = 0;
    int         liveGameW          = 0;
    int         liveGameH          = 0;
    uint64_t    livePerfTickMs     = 0;

    std::string BuildExpGta6PlayUrl() const {
        if (!customExpGta6PlayPath.empty()) return customExpGta6PlayPath;
        char buf[320];
        int sens = lookSensitivity < 20 ? 20 : (lookSensitivity > 300 ? 300 : lookSensitivity);
        if (devPerfAuto) {
            std::snprintf(buf, sizeof(buf),
                          "/gta6/boot?mode=sandbox&vbx_gta6=1&vbx_perf_auto=1&low=0&fps=60&res=1920x1080&scale=0.92&shadows=1&fixed=1&vbx_sens=%d&args=-textureQuality=1,-shaderQuality=1,-shadowQuality=1,-noInGameDOF,-MSAA=0",
                          sens);
        } else {
            std::snprintf(buf, sizeof(buf),
                          "/gta6/boot?mode=sandbox&vbx_gta6=1&vbx_perf_auto=0&low=0&fps=0&res=1920x1080&scale=1.00&shadows=1&fixed=1&vbx_sens=%d",
                          sens);
        }
        return std::string(buf);
    }

    std::string BuildGta5PlayUrl() const {
        if (!customGta5PlayPath.empty()) return customGta5PlayPath;
        static const char* kResStrs[] = {
            "1920x1080", "1600x900", "1280x720", "960x540"
        };
        int ri = resIndex < 0 ? 0 : (resIndex > 3 ? 3 : resIndex);
        int low = (gta5Mode == 2) ? 1 : 0;
        int fps = 60;
        int shadows = 1;
        const char* scale = optimizationMode ? "0.95" : "1.00";

        char buf[256];
        std::snprintf(buf, sizeof(buf),
                      "/play/?low=%d&fps=%d&res=%s&scale=%s&shadows=%d&fixed=1",
                      low, fps, kResStrs[ri], scale, shadows);
        return std::string(buf);
    }
};

class LocalHttpServer {
public:
    LocalHttpServer() = default;
    ~LocalHttpServer() { Stop(); }

    bool Start(HwMonitor* hw, SharedEmulatorState* sharedState, std::mutex* stateMu, DevTargetController* devCtrl = nullptr) {
        if (running_.load()) return true;
        hw_ = hw;
        shared_ = sharedState;
        stateMu_ = stateMu;
        devCtrl_ = devCtrl;

        WSADATA wsa{};
        if (WSAStartup(MAKEWORD(2, 2), &wsa) != 0) return false;
        wsaInit_ = true;

        hSession_ = WinHttpOpen(
            L"ViceBoxX-PC-Emulator/2.0 (Windows NT 10.0; Win64; x64)",
            WINHTTP_ACCESS_TYPE_AUTOMATIC_PROXY,
            WINHTTP_NO_PROXY_NAME,
            WINHTTP_NO_PROXY_BYPASS, 0);
        if (hSession_) {
            DWORD maxConns = 32;
            WinHttpSetOption(hSession_, WINHTTP_OPTION_MAX_CONNS_PER_SERVER,
                             &maxConns, sizeof(maxConns));
            WinHttpSetTimeouts(hSession_, 10000, 12000, 15000, 30000);
        }

        listenSock_ = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
        if (listenSock_ == INVALID_SOCKET) return false;

        // Exclusive bind on Windows prevents two instances from silently hijacking port 17585
#ifdef SO_EXCLUSIVEADDRUSE
        int excl = 1;
        setsockopt(listenSock_, SOL_SOCKET, SO_EXCLUSIVEADDRUSE,
                   reinterpret_cast<const char*>(&excl), sizeof(excl));
#endif

        // Prefer stable localhost port 17585 so browser localStorage (PFPs, Jailbreak edits) persists!
        sockaddr_in addr{};
        addr.sin_family = AF_INET;
        addr.sin_addr.s_addr = htonl(INADDR_LOOPBACK);
        addr.sin_port = htons(17585);
        if (bind(listenSock_, reinterpret_cast<sockaddr*>(&addr), sizeof(addr)) != 0) {
            addr.sin_port = 0; // fallback to any free port
            if (bind(listenSock_, reinterpret_cast<sockaddr*>(&addr), sizeof(addr)) != 0) {
                closesocket(listenSock_);
                listenSock_ = INVALID_SOCKET;
                return false;
            }
        }

        socklen_t len = sizeof(addr);
        if (getsockname(listenSock_, reinterpret_cast<sockaddr*>(&addr), &len) == 0) {
            port_ = ntohs(addr.sin_port);
        }

        if (listen(listenSock_, 64) != 0) {
            closesocket(listenSock_);
            listenSock_ = INVALID_SOCKET;
            return false;
        }

        running_.store(true);
        acceptThread_ = std::thread([this]() { AcceptLoop(); });
        return true;
    }

    void Stop() {
        if (!running_.exchange(false)) return;
        if (listenSock_ != INVALID_SOCKET) {
            closesocket(listenSock_);
            listenSock_ = INVALID_SOCKET;
        }
        if (acceptThread_.joinable()) acceptThread_.join();
        if (hSession_) {
            WinHttpCloseHandle(hSession_);
            hSession_ = nullptr;
        }
        if (wsaInit_) {
            WSACleanup();
            wsaInit_ = false;
        }
    }

    uint16_t Port() const { return port_; }
    bool IsRunning() const { return running_.load() && port_ != 0; }

    std::string BaseUrl() const {
        char buf[64];
        std::snprintf(buf, sizeof(buf), "http://127.0.0.1:%u", static_cast<unsigned>(port_));
        return std::string(buf);
    }

private:
    static std::string EscapeJson(const std::string& s) {
        std::string out;
        out.reserve(s.size() + 8);
        for (unsigned char c : s) {
            switch (c) {
                case '"':  out += "\\\""; break;
                case '\\': out += "\\\\"; break;
                case '\b': out += "\\b"; break;
                case '\f': out += "\\f"; break;
                case '\n': out += "\\n"; break;
                case '\r': out += "\\r"; break;
                case '\t': out += "\\t"; break;
                default:
                    if (c < 0x20) {
                        char b[8];
                        std::snprintf(b, sizeof(b), "\\u%04x", c);
                        out += b;
                    } else {
                        out.push_back(static_cast<char>(c));
                    }
            }
        }
        return out;
    }

    static std::wstring Utf8ToWide(const std::string& s) {
        if (s.empty()) return {};
        int n = MultiByteToWideChar(CP_UTF8, 0, s.c_str(), static_cast<int>(s.size()), nullptr, 0);
        if (n <= 0) return {};
        std::wstring ws(static_cast<size_t>(n), L'\0');
        MultiByteToWideChar(CP_UTF8, 0, s.c_str(), static_cast<int>(s.size()), &ws[0], n);
        return ws;
    }

    static std::string ToLowerAscii(std::string s) {
        for (char& c : s) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
        return s;
    }

    static bool SendAll(SOCKET s, const char* data, size_t len) {
        size_t sent = 0;
        while (sent < len) {
            int n = send(s, data + sent, static_cast<int>(std::min<size_t>(len - sent, 65536)), 0);
            if (n <= 0) return false;
            sent += static_cast<size_t>(n);
        }
        return true;
    }

    static void SendResponse(SOCKET s, int code, const char* statusText,
                             const char* contentType, const char* body, size_t bodyLen,
                             const std::string& extraHeaders = "", bool headOnly = false) {
        std::ostringstream oss;
        oss << "HTTP/1.1 " << code << " " << statusText << "\r\n"
            << "Content-Type: " << contentType << "\r\n"
            << "Content-Length: " << bodyLen << "\r\n"
            << "Cross-Origin-Resource-Policy: same-origin\r\n"
            << "Connection: close\r\n"
            << extraHeaders
            << "\r\n";
        std::string hdr = oss.str();
        SendAll(s, hdr.data(), hdr.size());
        if (!headOnly && body && bodyLen > 0) {
            SendAll(s, body, bodyLen);
        }
    }

    static void SendJson(SOCKET s, const std::string& json, int code = 200) {
        SendResponse(s, code, code == 200 ? "OK" : "Bad Request",
                     "application/json; charset=utf-8",
                     json.data(), json.size(),
                     "Cache-Control: no-store\r\n");
    }

    // Minimal flat JSON helpers for POST /vbx/api/config & /vbx/api/switch-console
    static bool ExtractJsonString(const std::string& body, const char* key, std::string& out) {
        std::string needle = std::string("\"") + key + "\"";
        size_t p = body.find(needle);
        if (p == std::string::npos) return false;
        p = body.find(':', p + needle.size());
        if (p == std::string::npos) return false;
        p = body.find('"', p + 1);
        if (p == std::string::npos) return false;
        ++p;
        std::string val;
        while (p < body.size()) {
            char c = body[p++];
            if (c == '\\' && p < body.size()) {
                char esc = body[p++];
                if (esc == '"' || esc == '\\' || esc == '/') val.push_back(esc);
                else if (esc == 'n') val.push_back('\n');
                else if (esc == 't') val.push_back('\t');
            } else if (c == '"') {
                out = val;
                return true;
            } else {
                val.push_back(c);
            }
        }
        return false;
    }

    static bool ExtractJsonBool(const std::string& body, const char* key, bool& out) {
        std::string needle = std::string("\"") + key + "\"";
        size_t p = body.find(needle);
        if (p == std::string::npos) return false;
        p = body.find(':', p + needle.size());
        if (p == std::string::npos) return false;
        ++p;
        while (p < body.size() && std::isspace(static_cast<unsigned char>(body[p]))) ++p;
        if (body.compare(p, 4, "true") == 0)  { out = true;  return true; }
        if (body.compare(p, 5, "false") == 0) { out = false; return true; }
        return false;
    }

    static bool ExtractJsonInt(const std::string& body, const char* key, int& out) {
        std::string needle = std::string("\"") + key + "\"";
        size_t p = body.find(needle);
        if (p == std::string::npos) return false;
        p = body.find(':', p + needle.size());
        if (p == std::string::npos) return false;
        ++p;
        while (p < body.size() && std::isspace(static_cast<unsigned char>(body[p]))) ++p;
        if (p >= body.size() || (!std::isdigit(static_cast<unsigned char>(body[p])) && body[p] != '-'))
            return false;
        out = std::atoi(body.c_str() + p);
        return true;
    }

    static bool ExtractJsonDouble(const std::string& body, const char* key, double& out) {
        std::string needle = std::string("\"") + key + "\"";
        size_t p = body.find(needle);
        if (p == std::string::npos) return false;
        p = body.find(':', p + needle.size());
        if (p == std::string::npos) return false;
        ++p;
        while (p < body.size() && std::isspace(static_cast<unsigned char>(body[p]))) ++p;
        if (p >= body.size() || (!std::isdigit(static_cast<unsigned char>(body[p])) && body[p] != '-' && body[p] != '.'))
            return false;
        out = std::strtod(body.c_str() + p, nullptr);
        return true;
    }

    void AcceptLoop() {
        while (running_.load()) {
            sockaddr_in cli{};
            socklen_t cliLen = sizeof(cli);
            SOCKET client = accept(listenSock_, reinterpret_cast<sockaddr*>(&cli), &cliLen);
            if (client == INVALID_SOCKET) {
                if (!running_.load()) break;
                Sleep(10);
                continue;
            }
            DWORD rcvTimeout = 15000;
            setsockopt(client, SOL_SOCKET, SO_RCVTIMEO,
                       reinterpret_cast<const char*>(&rcvTimeout), sizeof(rcvTimeout));
            std::thread([this, client]() {
                HandleClient(client);
                shutdown(client, SD_SEND);
                char drain[256];
                DWORD shortTo = 80;
                setsockopt(client, SOL_SOCKET, SO_RCVTIMEO,
                           reinterpret_cast<const char*>(&shortTo), sizeof(shortTo));
                recv(client, drain, sizeof(drain), 0);
                closesocket(client);
            }).detach();
        }
    }

    void HandleClient(SOCKET client) {
        std::string raw;
        raw.reserve(4096);
        char buf[4096];
        size_t hdrEnd = std::string::npos;

        while (raw.size() < 65536) {
            int n = recv(client, buf, sizeof(buf), 0);
            if (n <= 0) break;
            raw.append(buf, static_cast<size_t>(n));
            hdrEnd = raw.find("\r\n\r\n");
            if (hdrEnd != std::string::npos) break;
        }
        if (hdrEnd == std::string::npos) return;

        std::string hdrBlock = raw.substr(0, hdrEnd);
        std::string body = raw.substr(hdrEnd + 4);

        // Parse request line
        size_t firstLineEnd = hdrBlock.find("\r\n");
        std::string reqLine = (firstLineEnd == std::string::npos)
                                  ? hdrBlock
                                  : hdrBlock.substr(0, firstLineEnd);
        std::istringstream rl(reqLine);
        std::string method, target, httpVer;
        rl >> method >> target >> httpVer;
        if (method.empty() || target.empty()) return;

        // Parse selected headers
        size_t contentLength = 0;
        std::string reqRange, reqIfNoneMatch, reqIfModSince, reqAcceptEncoding;
        size_t pos = (firstLineEnd == std::string::npos) ? hdrBlock.size() : firstLineEnd + 2;
        while (pos < hdrBlock.size()) {
            size_t next = hdrBlock.find("\r\n", pos);
            std::string line = (next == std::string::npos)
                                   ? hdrBlock.substr(pos)
                                   : hdrBlock.substr(pos, next - pos);
            pos = (next == std::string::npos) ? hdrBlock.size() : next + 2;
            size_t colon = line.find(':');
            if (colon == std::string::npos) continue;
            std::string k = ToLowerAscii(line.substr(0, colon));
            std::string v = line.substr(colon + 1);
            size_t vs = 0;
            while (vs < v.size() && (v[vs] == ' ' || v[vs] == '\t')) ++vs;
            v = v.substr(vs);
            if (k == "content-length") contentLength = static_cast<size_t>(std::strtoul(v.c_str(), nullptr, 10));
            else if (k == "range") reqRange = v;
            else if (k == "if-none-match") reqIfNoneMatch = v;
            else if (k == "if-modified-since") reqIfModSince = v;
            else if (k == "accept-encoding") reqAcceptEncoding = v;
        }

        // Read remaining POST body
        if (contentLength > 0 && contentLength <= 262144) {
            while (body.size() < contentLength) {
                int n = recv(client, buf, sizeof(buf), 0);
                if (n <= 0) break;
                body.append(buf, static_cast<size_t>(n));
            }
            if (body.size() > contentLength) body.resize(contentLength);
        }

        bool headOnly = (method == "HEAD");
        if (method == "OPTIONS") {
            SendResponse(client, 204, "No Content", "text/plain", nullptr, 0,
                         "Access-Control-Allow-Origin: *\r\n"
                         "Access-Control-Allow-Methods: GET, POST, HEAD, OPTIONS\r\n"
                         "Access-Control-Allow-Headers: Content-Type, Range\r\n", true);
            return;
        }

        std::string path = target;
        std::string query;
        size_t qpos = target.find('?');
        if (qpos != std::string::npos) {
            path = target.substr(0, qpos);
            query = target.substr(qpos);
        }

        // 1. Root redirect to active console
        if (path == "/") {
            std::string loc = "/ps5/";
            {
                std::lock_guard<std::mutex> lk(*stateMu_);
                if (shared_->consoleTarget == "xbox") loc = "/xbox/";
                else if (shared_->consoleTarget == "viceos") loc = "/viceos/";
            }
            SendResponse(client, 302, "Found", "text/plain", nullptr, 0,
                         "Location: " + loc + "\r\n", true);
            return;
        }

        // 2. Embedded Console Dashboards & GTA VI Updates Page
        if (path == "/ps5" || path == "/ps5/") {
            ServeEmbedded(client, "/vbx/ps5.html", headOnly, true);
            return;
        }
        if (path == "/xbox" || path == "/xbox/") {
            ServeEmbedded(client, "/vbx/xbox.html", headOnly, true);
            return;
        }
        if (path == "/viceos" || path == "/viceos/") {
            ServeEmbedded(client, "/vbx/viceos.html", headOnly, true);
            return;
        }
        if (path == "/updates/gta6" || path == "/updates/gta6/") {
            ServeEmbedded(client, "/vbx/gta6_updates.html", headOnly, true);
            return;
        }
        // Dedicated non-COEP Experimental GTA 6 Startup Video Page (auto-plays z_RUhg96MiI -> hands off to /play/)
        if (path == "/gta6/boot" || path == "/gta6/boot/") {
            ServeEmbedded(client, "/vbx/gta6_startup.html", headOnly, true);
            return;
        }

        // 3. API Endpoints
        if (path == "/vbx/api/telemetry") {
            HandleTelemetry(client);
            return;
        }
        if (path == "/vbx/api/state") {
            HandleState(client);
            return;
        }
        if (path == "/vbx/api/config" && method == "POST") {
            HandleConfigPost(client, body);
            return;
        }
        if (path == "/vbx/api/switch-console" && method == "POST") {
            HandleSwitchConsole(client, body);
            return;
        }
        if (path == "/vbx/api/launch-custom-exe" && method == "POST") {
            HandleLaunchCustomExe(client);
            return;
        }
        if (path == "/vbx/api/perf" && method == "POST") {
            HandlePerfPost(client, body);
            return;
        }
        if (path == "/vbx/api/intro-status") {
            HandleIntroStatus(client);
            return;
        }
        if (path == "/vbx/api/intro-resolve") {
            HandleIntroResolve(client);
            return;
        }
        if (path == "/vbx/api/intro-media") {
            HandleIntroMedia(client, query, reqRange, headOnly);
            return;
        }
        if (path == "/vbx/user/gta6_intro.mp4") {
            ServeUserIntroVideo(client, reqRange, headOnly);
            return;
        }

        // 4. Embedded static web assets (/vbx/pc_overlay.js, /vbx/img/*.jpg, *.png)
        if (path.rfind("/vbx/", 0) == 0) {
            ServeEmbedded(client, path, headOnly, false);
            return;
        }

        // 5. GTA V Enhanced Play Route (/play or /play/) -> injects pc_overlay.js (+ gta6_experimental.js when vbx_gta6=1)
        if (path == "/play" || path == "/play/") {
            ProxyGta5Html(client, query, headOnly);
            return;
        }

        // 6. Relative path under /play/... -> strip /play and stream from playgta5.com
        std::string upstreamTarget = target;
        if (path.rfind("/play/", 0) == 0) {
            upstreamTarget = target.substr(5); // keep leading '/'
        }

        // 6b. Experimental GTA 6 WebGPU post-processing & GTX 1050 perf governor hook
        if (method == "GET" && upstreamTarget.find("wgpu_worker.js") != std::string::npos) {
            bool expActive = false;
            {
                std::lock_guard<std::mutex> lk(*stateMu_);
                expActive = shared_->isFoxxyDev && shared_->devExpGta6;
            }
            if (expActive) {
                ProxyGta6WgpuWorker(client, upstreamTarget, headOnly);
                return;
            }
        }

        // 7. Root-relative transparent streaming passthrough to https://playgta5.com
        ProxyStreamUpstream(client, method, upstreamTarget, reqRange, reqIfNoneMatch, reqIfModSince, reqAcceptEncoding, headOnly);
    }

    void ServeEmbedded(SOCKET client, const std::string& assetPath, bool headOnly, bool noCache) {
        const EmbeddedAsset* a = FindEmbeddedAsset(assetPath.c_str());
        if (!a) {
            const char* msg = "Not Found";
            SendResponse(client, 404, "Not Found", "text/plain", msg, std::strlen(msg), "", headOnly);
            return;
        }
        std::string extra = noCache
            ? "Cache-Control: no-store\r\n"
            : "Cache-Control: public, max-age=3600\r\n";
        SendResponse(client, 200, "OK", a->mime,
                     reinterpret_cast<const char*>(a->data), a->size, extra, headOnly);
    }

    void HandleTelemetry(SOCKET client) {
        HwSnapshot s = hw_ ? hw_->Get() : HwSnapshot{};
        char buf[512];
        std::snprintf(buf, sizeof(buf),
                      "{\"cpuPct\":%.1f,\"gpuPct\":%.1f,\"vramUsedMb\":%.1f,"
                      "\"vramBudgetMb\":%.1f,\"ramUsedGb\":%.2f,\"ramTotalGb\":%.2f,"
                      "\"gpuName\":\"%s\"}",
                      s.cpuPct, s.gpuPct, s.vramUsedMb, s.vramBudgetMb,
                      s.ramUsedGb, s.ramTotalGb, EscapeJson(s.gpuName).c_str());
        SendJson(client, buf);
    }

    void HandleState(SOCKET client) {
        SharedEmulatorState st;
        {
            std::lock_guard<std::mutex> lk(*stateMu_);
            st = *shared_;
        }
        std::ostringstream oss;
        oss << "{"
            << "\"consoleTarget\":\"" << EscapeJson(st.consoleTarget) << "\","
            << "\"emulatedGame\":\"" << EscapeJson(st.emulatedGame) << "\","
            << "\"profileName\":\"" << EscapeJson(st.profileName) << "\","
            << "\"psPlusTier\":\"" << EscapeJson(st.psPlusTier) << "\","
            << "\"showDebugHud\":" << (st.showDebugHud ? "true" : "false") << ","
            << "\"enableCheatMenu\":" << (st.enableCheatMenu ? "true" : "false") << ","
            << "\"motionBlur\":" << (st.motionBlur ? "true" : "false") << ","
            << "\"motionBlurStrength\":" << st.motionBlurStrength << ","
            << "\"optimizationMode\":" << (st.optimizationMode ? "true" : "false") << ","
            << "\"lookSensitivity\":" << st.lookSensitivity << ","
            << "\"resIndex\":" << st.resIndex << ","
            << "\"gta5Mode\":" << st.gta5Mode << ","
            << "\"gta5Url\":\"" << EscapeJson(st.BuildGta5PlayUrl()) << "\","
            << "\"expGta6Url\":\"" << EscapeJson(st.BuildExpGta6PlayUrl()) << "\","
            << "\"isFoxxyDev\":" << (st.isFoxxyDev ? "true" : "false") << ","
            << "\"devGta6Enabled\":" << (st.devGta6Enabled ? "true" : "false") << ","
            << "\"devExpGta6\":" << (st.devExpGta6 ? "true" : "false") << ","
            << "\"devPerfAuto\":" << (st.devPerfAuto ? "true" : "false") << ","
            << "\"devGta6ExePath\":\"" << EscapeJson(st.devGta6ExePath) << "\","
            << "\"devFullOverlay\":" << (st.devFullOverlay ? "true" : "false") << ","
            << "\"devFakeFpsEnabled\":" << (st.devFakeFpsEnabled ? "true" : "false") << ","
            << "\"devFakeFpsLimit\":" << st.devFakeFpsLimit
            << "}";
        SendJson(client, oss.str());
    }

    void HandlePerfPost(SOCKET client, const std::string& body) {
        double fps = 0.0, fms = 0.0;
        int tier = 0, w = 0, h = 0;
        ExtractJsonDouble(body, "fps", fps);
        ExtractJsonDouble(body, "frameMs", fms);
        ExtractJsonInt(body, "perfTier", tier);
        ExtractJsonInt(body, "resW", w);
        ExtractJsonInt(body, "resH", h);
        {
            std::lock_guard<std::mutex> lk(*stateMu_);
            if (fps > 0.0 && fps < 1000.0) shared_->liveGameFps = fps;
            if (fms > 0.0 && fms < 1000.0) shared_->liveGameFrameMs = fms;
            shared_->livePerfTier = std::max(0, std::min(3, tier));
            if (w > 0) shared_->liveGameW = w;
            if (h > 0) shared_->liveGameH = h;
            shared_->livePerfTickMs = GetTickCount64();
        }
        SendJson(client, "{\"ok\":true}");
    }

    static std::string GetViceBoxDataDir() {
        const char* appData = std::getenv("APPDATA");
        std::string dir = (appData && *appData) ? (std::string(appData) + "\\ViceBoxX") : ".";
        std::wstring wDir = Utf8ToWide(dir);
        if (!wDir.empty()) CreateDirectoryW(wDir.c_str(), nullptr);
        return dir;
    }

    static bool IsValidMp4Buffer(const std::string& data, size_t minBytes = 32768) {
        if (data.size() < minBytes || data.size() > 64 * 1024 * 1024) return false;
        // ISO BMFF box header has "ftyp" at offset 4 (MP4 / M4A / M4V)
        return (data[4] == 'f' && data[5] == 't' && data[6] == 'y' && data[7] == 'p');
    }

    static bool IsValidMp4File(const std::string& filePath, size_t minBytes = 32768) {
        std::ifstream f(filePath, std::ios::binary | std::ios::ate);
        if (!f.is_open()) return false;
        std::streamoff sz = f.tellg();
        if (sz < static_cast<std::streamoff>(minBytes) || sz > 64LL * 1024 * 1024) return false;
        f.seekg(0, std::ios::beg);
        char hdr[12]{};
        f.read(hdr, 12);
        if (f.gcount() < 12) return false;
        return (hdr[4] == 'f' && hdr[5] == 't' && hdr[6] == 'y' && hdr[7] == 'p');
    }

    static bool AtomicWriteFile(const std::string& destPath, const std::string& data) {
        std::string tmpPath = destPath + ".tmp";
        {
            std::ofstream out(tmpPath, std::ios::binary | std::ios::trunc);
            if (!out.is_open()) return false;
            out.write(data.data(), static_cast<std::streamsize>(data.size()));
            if (!out.good()) return false;
        }
        std::wstring wTmp = Utf8ToWide(tmpPath);
        std::wstring wDst = Utf8ToWide(destPath);
        return MoveFileExW(wTmp.c_str(), wDst.c_str(), MOVEFILE_REPLACE_EXISTING | MOVEFILE_WRITE_THROUGH) != 0;
    }

    static void ServeLocalMediaFile(SOCKET client, const std::string& filePath, const char* mime,
                                    const std::string& reqRange, bool headOnly) {
        std::ifstream f(filePath, std::ios::binary | std::ios::ate);
        if (!f.is_open()) {
            const char* msg = "Not Found";
            SendResponse(client, 404, "Not Found", "text/plain", msg, std::strlen(msg),
                         "Cache-Control: no-store\r\n", headOnly);
            return;
        }
        std::streamoff totalSz = f.tellg();
        if (totalSz <= 0 || totalSz > 64LL * 1024 * 1024) {
            const char* msg = "Invalid media file";
            SendResponse(client, 404, "Not Found", "text/plain", msg, std::strlen(msg), "", headOnly);
            return;
        }

        uint64_t total = static_cast<uint64_t>(totalSz);
        uint64_t start = 0;
        uint64_t end   = total - 1;
        bool isPartial = false;

        if (reqRange.rfind("bytes=", 0) == 0) {
            std::string spec = reqRange.substr(6);
            size_t comma = spec.find(',');
            if (comma != std::string::npos) spec = spec.substr(0, comma);
            size_t dash = spec.find('-');
            if (dash != std::string::npos) {
                std::string s1 = spec.substr(0, dash);
                std::string s2 = spec.substr(dash + 1);
                if (!s1.empty()) {
                    start = std::strtoull(s1.c_str(), nullptr, 10);
                    end = s2.empty() ? (total - 1) : std::strtoull(s2.c_str(), nullptr, 10);
                    if (end >= total) end = total - 1;
                    if (start <= end && start < total) isPartial = true;
                } else if (!s2.empty()) {
                    uint64_t suffix = std::strtoull(s2.c_str(), nullptr, 10);
                    if (suffix > 0) {
                        start = (suffix >= total) ? 0 : (total - suffix);
                        end = total - 1;
                        isPartial = true;
                    }
                }
            }
        }

        uint64_t len = (end - start) + 1;
        std::ostringstream hdr;
        hdr << "HTTP/1.1 " << (isPartial ? "206 Partial Content" : "200 OK") << "\r\n"
            << "Content-Type: " << mime << "\r\n"
            << "Content-Length: " << len << "\r\n"
            << "Accept-Ranges: bytes\r\n"
            << "Cache-Control: no-store\r\n"
            << "Cross-Origin-Resource-Policy: same-origin\r\n";
        if (isPartial) {
            hdr << "Content-Range: bytes " << start << "-" << end << "/" << total << "\r\n";
        }
        hdr << "Connection: close\r\n\r\n";
        std::string hdrStr = hdr.str();
        if (!SendAll(client, hdrStr.data(), hdrStr.size()) || headOnly) return;

        f.seekg(static_cast<std::streamoff>(start), std::ios::beg);
        std::vector<char> chunk(65536);
        uint64_t remaining = len;
        while (remaining > 0) {
            size_t toRead = static_cast<size_t>(std::min<uint64_t>(remaining, chunk.size()));
            f.read(chunk.data(), static_cast<std::streamsize>(toRead));
            std::streamsize got = f.gcount();
            if (got <= 0) break;
            if (!SendAll(client, chunk.data(), static_cast<size_t>(got))) break;
            remaining -= static_cast<uint64_t>(got);
        }
    }

    static std::string UnescapeJsonString(const std::string& raw) {
        std::string out;
        out.reserve(raw.size());
        for (size_t i = 0; i < raw.size(); ++i) {
            if (raw[i] == '\\' && i + 1 < raw.size()) {
                char n = raw[i + 1];
                if (n == '/' || n == '"' || n == '\\') {
                    out.push_back(n);
                    ++i;
                } else if (n == 'u' && i + 5 < raw.size()) {
                    std::string hex = raw.substr(i + 2, 4);
                    unsigned long cp = std::strtoul(hex.c_str(), nullptr, 16);
                    if (cp >= 0x20 && cp <= 0x7E) out.push_back(static_cast<char>(cp));
                    i += 5;
                } else {
                    out.push_back(raw[i]);
                }
            } else {
                out.push_back(raw[i]);
            }
        }
        return out;
    }

    // Scans JSON format objects (depth-1 keys "itag" and "url") for preferred itags
    static std::string ExtractFormatUrlByItags(const std::string& json, const std::vector<int>& preferredItags) {
        std::vector<std::pair<int, std::string>> found;
        size_t pos = 0;
        while (pos < json.size()) {
            size_t objStart = json.find('{', pos);
            if (objStart == std::string::npos) break;
            pos = objStart + 1;

            int depth = 0;
            bool inStr = false;
            int itag = -1;
            std::string url;
            size_t i = objStart;
            size_t limit = std::min<size_t>(json.size(), objStart + 12000);

            for (; i < limit; ++i) {
                char c = json[i];
                if (inStr) {
                    if (c == '\\' && i + 1 < limit) { ++i; continue; }
                    if (c == '"') inStr = false;
                    continue;
                }
                if (c == '{') { ++depth; continue; }
                if (c == '}') {
                    --depth;
                    if (depth == 0) break;
                    continue;
                }
                if (c == '"') {
                    // Only inspect top-level (depth == 1) keys inside this object!
                    if (depth == 1) {
                        size_t kEnd = i + 1;
                        while (kEnd < limit) {
                            if (json[kEnd] == '\\' && kEnd + 1 < limit) { kEnd += 2; continue; }
                            if (json[kEnd] == '"') break;
                            ++kEnd;
                        }
                        if (kEnd < limit) {
                            std::string key = json.substr(i + 1, kEnd - i - 1);
                            size_t col = kEnd + 1;
                            while (col < limit && (json[col] == ' ' || json[col] == '\t')) ++col;
                            if (col < limit && json[col] == ':') {
                                size_t v = col + 1;
                                while (v < limit && (json[v] == ' ' || json[v] == '\t')) ++v;
                                if (key == "itag" && v < limit) {
                                    if (json[v] == '"') ++v;
                                    if (v < limit && std::isdigit(static_cast<unsigned char>(json[v]))) {
                                        itag = std::atoi(json.c_str() + v);
                                    }
                                } else if (key == "url" && v < limit && json[v] == '"') {
                                    size_t q2 = v + 1;
                                    while (q2 < limit) {
                                        if (json[q2] == '\\' && q2 + 1 < limit) { q2 += 2; continue; }
                                        if (json[q2] == '"') break;
                                        ++q2;
                                    }
                                    if (q2 < limit && q2 > v + 8) {
                                        std::string u = UnescapeJsonString(json.substr(v + 1, q2 - v - 1));
                                        if (u.rfind("https://", 0) == 0 || u.rfind("http://", 0) == 0) {
                                            url = std::move(u);
                                        }
                                        i = q2;
                                        continue;
                                    }
                                }
                            }
                            i = kEnd;
                            continue;
                        }
                    }
                    inStr = true;
                }
            }

            if (depth == 0 && itag > 0 && !url.empty()) {
                found.emplace_back(itag, url);
                pos = i + 1;
            }
        }

        for (int want : preferredItags) {
            for (const auto& kv : found) {
                if (kv.first == want) return kv.second;
            }
        }
        return {};
    }

    bool WinHttpFetchUrl(const std::string& url, const std::string& method,
                         const std::string& postBody, const std::wstring& extraHeaders,
                         std::string& outBody, size_t maxBytes, int timeoutMs) {
        if (!hSession_) return false;
        outBody.clear();

        std::wstring wUrl = Utf8ToWide(url);
        URL_COMPONENTSW uc{};
        uc.dwStructSize = sizeof(uc);
        wchar_t hostBuf[256]{};
        wchar_t pathBuf[8192]{};
        uc.lpszHostName = hostBuf;
        uc.dwHostNameLength = static_cast<DWORD>(sizeof(hostBuf) / sizeof(wchar_t));
        uc.lpszUrlPath = pathBuf;
        uc.dwUrlPathLength = static_cast<DWORD>(sizeof(pathBuf) / sizeof(wchar_t));

        if (!WinHttpCrackUrl(wUrl.c_str(), static_cast<DWORD>(wUrl.size()), 0, &uc)) {
            return false;
        }
        std::wstring host(uc.lpszHostName, uc.dwHostNameLength);
        std::wstring pathAndQuery(uc.lpszUrlPath, uc.dwUrlPathLength);
        if (pathAndQuery.empty()) pathAndQuery = L"/";
        bool isHttps = (uc.nScheme == INTERNET_SCHEME_HTTPS);

        HINTERNET hConn = WinHttpConnect(hSession_, host.c_str(), uc.nPort, 0);
        if (!hConn) return false;

        std::wstring wMethod = Utf8ToWide(method);
        HINTERNET hReq = WinHttpOpenRequest(
            hConn, wMethod.c_str(), pathAndQuery.c_str(), nullptr,
            WINHTTP_NO_REFERER, WINHTTP_DEFAULT_ACCEPT_TYPES,
            isHttps ? WINHTTP_FLAG_SECURE : 0);
        if (!hReq) {
            WinHttpCloseHandle(hConn);
            return false;
        }

        WinHttpSetTimeouts(hReq, timeoutMs, timeoutMs, timeoutMs, timeoutMs);
        DWORD redirPolicy = WINHTTP_OPTION_REDIRECT_POLICY_ALWAYS;
        WinHttpSetOption(hReq, WINHTTP_OPTION_REDIRECT_POLICY, &redirPolicy, sizeof(redirPolicy));

        if (!extraHeaders.empty()) {
            WinHttpAddRequestHeaders(hReq, extraHeaders.c_str(), static_cast<DWORD>(-1), WINHTTP_ADDREQ_FLAG_ADD);
        }

        BOOL sent = WinHttpSendRequest(
            hReq, WINHTTP_NO_ADDITIONAL_HEADERS, 0,
            postBody.empty() ? WINHTTP_NO_REQUEST_DATA : const_cast<char*>(postBody.data()),
            static_cast<DWORD>(postBody.size()),
            static_cast<DWORD>(postBody.size()), 0);

        bool ok = false;
        if (sent && WinHttpReceiveResponse(hReq, nullptr)) {
            DWORD statusCode = 0, scSz = sizeof(statusCode);
            WinHttpQueryHeaders(hReq, WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
                                WINHTTP_HEADER_NAME_BY_INDEX, &statusCode, &scSz, WINHTTP_NO_HEADER_INDEX);
            if (statusCode >= 200 && statusCode < 300) {
                DWORD avail = 0;
                while (WinHttpQueryDataAvailable(hReq, &avail) && avail > 0) {
                    if (outBody.size() + avail > maxBytes) {
                        avail = static_cast<DWORD>(maxBytes - outBody.size());
                        if (avail == 0) break;
                    }
                    size_t oldSz = outBody.size();
                    outBody.resize(oldSz + avail);
                    DWORD rd = 0;
                    if (!WinHttpReadData(hReq, &outBody[oldSz], avail, &rd) || rd == 0) {
                        outBody.resize(oldSz);
                        break;
                    }
                    outBody.resize(oldSz + rd);
                    if (outBody.size() >= maxBytes) break;
                }
                ok = !outBody.empty();
            }
        }

        WinHttpCloseHandle(hReq);
        WinHttpCloseHandle(hConn);
        return ok;
    }

    std::string BuildIntroStatusJson() const {
        std::string dir = GetViceBoxDataDir();
        if (IsValidMp4File(dir + "\\gta6_intro.mp4", 16384)) {
            return "{\"ready\":true,\"mode\":\"custom\",\"video\":\"/vbx/user/gta6_intro.mp4\"}";
        }
        if (IsValidMp4File(dir + "\\gta6_intro_z_RUhg96MiI_m.mp4", 32768)) {
            return "{\"ready\":true,\"mode\":\"cached_mux\",\"video\":\"/vbx/api/intro-media?slot=m\"}";
        }
        if (IsValidMp4File(dir + "\\gta6_intro_z_RUhg96MiI_v.mp4", 32768) &&
            IsValidMp4File(dir + "\\gta6_intro_z_RUhg96MiI_a.m4a", 8192)) {
            return "{\"ready\":true,\"mode\":\"cached_av\",\"video\":\"/vbx/api/intro-media?slot=v\",\"audio\":\"/vbx/api/intro-media?slot=a\"}";
        }
        return "{\"ready\":false,\"mode\":\"none\"}";
    }

    bool TryCacheFromStreamJson(const std::string& json, const std::wstring& mediaHeaders, const std::string& dir) {
        // 1. Prefer high-quality 720p60/1080p60 H.264 MP4 video + AAC M4A audio (zero artifacts, ~5 MB total!)
        std::string vUrl = ExtractFormatUrlByItags(json, { 298, 136, 299, 135 });
        std::string aUrl = ExtractFormatUrlByItags(json, { 140, 139 });
        if (!vUrl.empty() && !aUrl.empty()) {
            std::string vBuf, aBuf;
            if (WinHttpFetchUrl(vUrl, "GET", "", mediaHeaders, vBuf, 20 * 1024 * 1024, 6500) &&
                IsValidMp4Buffer(vBuf, 32768) &&
                WinHttpFetchUrl(aUrl, "GET", "", mediaHeaders, aBuf, 4 * 1024 * 1024, 4500) &&
                IsValidMp4Buffer(aBuf, 8192)) {
                if (AtomicWriteFile(dir + "\\gta6_intro_z_RUhg96MiI_v.mp4", vBuf) &&
                    AtomicWriteFile(dir + "\\gta6_intro_z_RUhg96MiI_a.m4a", aBuf)) {
                    return true;
                }
            }
        }
        // 2. Fallback: muxed MP4 stream (itag 22 720p or itag 18 360p)
        std::string mUrl = ExtractFormatUrlByItags(json, { 22, 18 });
        if (!mUrl.empty()) {
            std::string mBuf;
            if (WinHttpFetchUrl(mUrl, "GET", "", mediaHeaders, mBuf, 16 * 1024 * 1024, 6500) &&
                IsValidMp4Buffer(mBuf, 32768)) {
                if (AtomicWriteFile(dir + "\\gta6_intro_z_RUhg96MiI_m.mp4", mBuf)) {
                    return true;
                }
            }
        }
        return false;
    }

    void HandleIntroStatus(SOCKET client) {
        SendJson(client, BuildIntroStatusJson());
    }

    void HandleIntroResolve(SOCKET client) {
        std::lock_guard<std::mutex> lk(introResolveMu_);
        std::string already = BuildIntroStatusJson();
        if (already.find("\"ready\":true") != std::string::npos) {
            SendJson(client, already);
            return;
        }

        std::string dir = GetViceBoxDataDir();
        const std::wstring dlHdrs =
            L"User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36\r\n"
            L"Accept: */*\r\n";

        // Method A: Direct YouTube InnerTube player lookup from the user's own PC IP (IP-matched, sub-second!)
        {
            const std::string bodyVr =
                "{\"videoId\":\"z_RUhg96MiI\",\"context\":{\"client\":{"
                "\"clientName\":\"ANDROID_VR\",\"clientVersion\":\"1.60.19\","
                "\"deviceMake\":\"Oculus\",\"deviceModel\":\"Quest 3\","
                "\"androidSdkVersion\":32,\"hl\":\"en\",\"gl\":\"US\"}}}";
            const std::wstring vrHdrs =
                L"Content-Type: application/json\r\n"
                L"User-Agent: com.google.android.apps.youtube.vr.oculus/1.60.19 (Linux; U; Android 12L; eureka-user Build/SQ3A.220605.009.A1) gzip\r\n"
                L"Accept-Encoding: identity\r\n";
            std::string resp;
            if (WinHttpFetchUrl("https://www.youtube.com/youtubei/v1/player?prettyPrint=false",
                                "POST", bodyVr, vrHdrs, resp, 1024 * 1024, 3500)) {
                if (TryCacheFromStreamJson(resp, dlHdrs, dir)) {
                    SendJson(client, BuildIntroStatusJson());
                    return;
                }
            }
        }

        // Method B: Live Invidious Public API (local=true proxies streams cleanly with zero IP mismatch!)
        {
            const char* kInvidiousHosts[] = {
                "https://yt.chocolatemoo53.com",
                "https://inv.nadeko.net",
                "https://invidious.nerdvpn.de"
            };
            const std::wstring invHdrs =
                L"User-Agent: Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/131.0.0.0 Safari/537.36\r\n"
                L"Accept: application/json\r\n"
                L"Accept-Encoding: identity\r\n";
            for (const char* host : kInvidiousHosts) {
                std::string apiUrl = std::string(host) + "/api/v1/videos/z_RUhg96MiI?local=true";
                std::string resp;
                if (WinHttpFetchUrl(apiUrl, "GET", "", invHdrs, resp, 1024 * 1024, 3500)) {
                    if (TryCacheFromStreamJson(resp, dlHdrs, dir)) {
                        SendJson(client, BuildIntroStatusJson());
                        return;
                    }
                }
            }
        }

        SendJson(client, "{\"ready\":false,\"fallback\":\"youtube\"}");
    }

    void HandleIntroMedia(SOCKET client, const std::string& query, const std::string& reqRange, bool headOnly) {
        std::string dir = GetViceBoxDataDir();
        if (query.find("slot=m") != std::string::npos) {
            ServeLocalMediaFile(client, dir + "\\gta6_intro_z_RUhg96MiI_m.mp4", "video/mp4", reqRange, headOnly);
        } else if (query.find("slot=a") != std::string::npos) {
            ServeLocalMediaFile(client, dir + "\\gta6_intro_z_RUhg96MiI_a.m4a", "audio/mp4", reqRange, headOnly);
        } else {
            ServeLocalMediaFile(client, dir + "\\gta6_intro_z_RUhg96MiI_v.mp4", "video/mp4", reqRange, headOnly);
        }
    }

    void ServeUserIntroVideo(SOCKET client, const std::string& reqRange, bool headOnly) {
        std::string path = GetViceBoxDataDir() + "\\gta6_intro.mp4";
        ServeLocalMediaFile(client, path, "video/mp4", reqRange, headOnly);
    }

    void HandleConfigPost(SOCKET client, const std::string& body) {
        std::lock_guard<std::mutex> lk(*stateMu_);
        std::string sVal;
        bool bVal = false;
        int iVal = 0;

        if (ExtractJsonString(body, "profileName", sVal) && !sVal.empty()) {
            shared_->profileName = sVal.substr(0, 32);
        }
        if (ExtractJsonString(body, "psPlusTier", sVal)) {
            shared_->psPlusTier = sVal;
        }
        if (ExtractJsonBool(body, "showDebugHud", bVal)) shared_->showDebugHud = bVal;
        if (ExtractJsonBool(body, "enableCheatMenu", bVal)) shared_->enableCheatMenu = bVal;
        if (ExtractJsonBool(body, "motionBlur", bVal)) shared_->motionBlur = bVal;
        if (ExtractJsonInt(body, "motionBlurStrength", iVal)) {
            shared_->motionBlurStrength = std::max(0, std::min(100, iVal));
        }
        if (ExtractJsonBool(body, "optimizationMode", bVal)) shared_->optimizationMode = bVal;
        if (ExtractJsonBool(body, "devPerfAuto", bVal)) shared_->devPerfAuto = bVal;
        if (ExtractJsonInt(body, "lookSensitivity", iVal)) {
            shared_->lookSensitivity = std::max(20, std::min(300, iVal));
        }
        if (ExtractJsonInt(body, "resIndex", iVal)) {
            shared_->resIndex = std::max(0, std::min(4, iVal));
        }
        if (ExtractJsonString(body, "emulatedGame", sVal)) {
            if (sVal == "gta5" || sVal == "gta6" || sVal == "all") {
                shared_->emulatedGame = sVal;
            }
        }
        if (ExtractJsonInt(body, "gta5Mode", iVal)) {
            shared_->gta5Mode = std::max(0, std::min(3, iVal));
        }
        shared_->configDirtyFromWeb = true;
        SendJson(client, "{\"ok\":true}");
    }

    void HandleSwitchConsole(SOCKET client, const std::string& body) {
        std::string target;
        if (ExtractJsonString(body, "consoleTarget", target)) {
            if (target == "xbox" || target == "ps5" || target == "viceos") {
                std::lock_guard<std::mutex> lk(*stateMu_);
                shared_->consoleTarget = target;
                shared_->configDirtyFromWeb = true;
            }
        }
        SendJson(client, "{\"ok\":true}");
    }

    void HandleLaunchCustomExe(SOCKET client) {
        bool allowed = false;
        std::string targetPath;
        bool devFullOverlay = true;
        bool devFakeFpsEnabled = false;
        int devFakeFpsLimit = 30;
        {
            std::lock_guard<std::mutex> lk(*stateMu_);
            bool gameOk = (shared_->emulatedGame == "gta6" || shared_->emulatedGame == "all");
            allowed = shared_->isFoxxyDev && shared_->devGta6Enabled &&
                      gameOk && !shared_->devGta6ExePath.empty();
            targetPath = shared_->devGta6ExePath;
            devFullOverlay = shared_->devFullOverlay;
            devFakeFpsEnabled = shared_->devFakeFpsEnabled;
            devFakeFpsLimit = shared_->devFakeFpsLimit;
        }

        if (!allowed) {
            SendJson(client, "{\"ok\":false,\"error\":\"Developer Mode (Foxxy) + Custom GTA VI file not enabled.\"}");
            return;
        }

        // If the selected target is a Windows .exe, launch via DevTargetController so the
        // Full-Screen Windows Dev Overlay & Fake Max-FPS Limiter attach cleanly!
        if (IsExeFilePath(targetPath) && devCtrl_) {
            devCtrl_->UpdateSettings(devFullOverlay, devFakeFpsEnabled, devFakeFpsLimit);
            std::string err;
            if (!devCtrl_->LaunchExe(targetPath, err)) {
                SendJson(client, "{\"ok\":false,\"error\":\"" + EscapeJson(err) + "\"}");
                return;
            }
            std::ostringstream oss;
            oss << "{\"ok\":true,\"exePath\":\"" << EscapeJson(targetPath) << "\""
                << ",\"isExe\":true"
                << ",\"devOverlay\":" << (devFullOverlay ? "true" : "false")
                << ",\"fakeFps\":" << (devFakeFpsEnabled ? "true" : "false")
                << ",\"fakeFpsLimit\":" << devFakeFpsLimit << "}";
            SendJson(client, oss.str());
            return;
        }

        std::wstring wTarget = Utf8ToWide(targetPath);
        bool isUrl = (targetPath.rfind("http://", 0) == 0 || targetPath.rfind("https://", 0) == 0);

        std::wstring wDir;
        if (!isUrl) {
            DWORD attrs = GetFileAttributesW(wTarget.c_str());
            if (attrs == INVALID_FILE_ATTRIBUTES) {
                SendJson(client, "{\"ok\":false,\"error\":\"Selected file no longer exists on disk.\"}");
                return;
            }
            size_t slash = wTarget.find_last_of(L"\\/");
            if (slash != std::wstring::npos) wDir = wTarget.substr(0, slash);
        }

        HINSTANCE res = ShellExecuteW(
            nullptr, L"open", wTarget.c_str(), nullptr,
            wDir.empty() ? nullptr : wDir.c_str(), SW_SHOWNORMAL);
        intptr_t code = reinterpret_cast<intptr_t>(res);

        // If the file extension has no default Windows app, open Windows "Open With..." dialog
        if (code == SE_ERR_NOASSOC || code == SE_ERR_ASSOCINCOMPLETE) {
            std::wstring openAsArgs = L"shell32.dll,OpenAs_RunDLL " + wTarget;
            res = ShellExecuteW(nullptr, L"open", L"rundll32.exe", openAsArgs.c_str(),
                                wDir.empty() ? nullptr : wDir.c_str(), SW_SHOWNORMAL);
            code = reinterpret_cast<intptr_t>(res);
        }

        if (code <= 32) {
            SendJson(client, "{\"ok\":false,\"error\":\"Windows failed to launch the selected file.\"}");
            return;
        }

        std::string json = "{\"ok\":true,\"exePath\":\"" + EscapeJson(targetPath) + "\"}";
        SendJson(client, json);
    }

    void ProxyGta5Html(SOCKET client, const std::string& query, bool headOnly) {
        if (!hSession_) {
            SendOfflineHtml(client, "WinHTTP session unavailable.");
            return;
        }

        HINTERNET hConn = WinHttpConnect(hSession_, L"playgta5.com", INTERNET_DEFAULT_HTTPS_PORT, 0);
        if (!hConn) {
            SendOfflineHtml(client, "Could not connect to playgta5.com.");
            return;
        }

        std::wstring wPath = Utf8ToWide("/" + query);
        HINTERNET hReq = WinHttpOpenRequest(
            hConn, L"GET", wPath.c_str(), nullptr,
            WINHTTP_NO_REFERER, WINHTTP_DEFAULT_ACCEPT_TYPES, WINHTTP_FLAG_SECURE);
        if (!hReq) {
            WinHttpCloseHandle(hConn);
            SendOfflineHtml(client, "Failed to open request to playgta5.com.");
            return;
        }

        // Request identity encoding so we can inject pc_overlay.js cleanly into plain UTF-8 HTML
        WinHttpAddRequestHeaders(
            hReq,
            L"Accept: text/html,application/xhtml+xml,*/*;q=0.9\r\n"
            L"Accept-Encoding: identity\r\n",
            static_cast<DWORD>(-1), WINHTTP_ADDREQ_FLAG_ADD);

        std::string html;
        bool ok = false;
        if (WinHttpSendRequest(hReq, WINHTTP_NO_ADDITIONAL_HEADERS, 0, nullptr, 0, 0, 0) &&
            WinHttpReceiveResponse(hReq, nullptr)) {
            DWORD statusCode = 0, sz = sizeof(statusCode);
            WinHttpQueryHeaders(hReq, WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
                                WINHTTP_HEADER_NAME_BY_INDEX, &statusCode, &sz, WINHTTP_NO_HEADER_INDEX);
            if (statusCode >= 200 && statusCode < 400) {
                DWORD avail = 0;
                while (WinHttpQueryDataAvailable(hReq, &avail) && avail > 0) {
                    size_t oldSz = html.size();
                    html.resize(oldSz + avail);
                    DWORD rd = 0;
                    if (!WinHttpReadData(hReq, &html[oldSz], avail, &rd) || rd == 0) {
                        html.resize(oldSz);
                        break;
                    }
                    html.resize(oldSz + rd);
                    if (html.size() > 4 * 1024 * 1024) break;
                }
                ok = !html.empty();
            }
        }

        WinHttpCloseHandle(hReq);
        WinHttpCloseHandle(hConn);

        if (!ok) {
            SendOfflineHtml(client, "Unable to load playgta5.com right now. Check your internet connection and click Retry.");
            return;
        }

        // Inject ViceBox X PC Enhancement Layer (+ Experimental GTA 6 layer when vbx_gta6=1) right after <head>
        std::string injectTag = "\n<script src=\"/vbx/pc_overlay.js\"></script>\n";
        if (query.find("vbx_gta6=1") != std::string::npos) {
            injectTag += "<script src=\"/vbx/gta6_experimental.js\"></script>\n";
        }
        std::string lowerHtml = ToLowerAscii(html);
        size_t headPos = lowerHtml.find("<head");
        if (headPos != std::string::npos) {
            size_t gt = html.find('>', headPos);
            if (gt != std::string::npos) {
                html.insert(gt + 1, injectTag);
            } else {
                html = injectTag + html;
            }
        } else {
            html = injectTag + html;
        }

        // Exact Cross-Origin Isolation headers required by playgta5.com SharedArrayBuffer!
        const std::string isolationHeaders =
            "Cross-Origin-Opener-Policy: same-origin\r\n"
            "Cross-Origin-Embedder-Policy: require-corp\r\n"
            "Cache-Control: no-store\r\n";

        SendResponse(client, 200, "OK", "text/html; charset=utf-8",
                     html.data(), html.size(), isolationHeaders, headOnly);
    }

    void ProxyGta6WgpuWorker(SOCKET client, const std::string& upstreamTarget, bool headOnly) {
        if (!hSession_) {
            SendResponse(client, 502, "Bad Gateway", "text/plain", "Proxy offline", 13);
            return;
        }
        HINTERNET hConn = WinHttpConnect(hSession_, L"playgta5.com", INTERNET_DEFAULT_HTTPS_PORT, 0);
        if (!hConn) {
            SendResponse(client, 502, "Bad Gateway", "text/plain", "Connect failed", 14);
            return;
        }
        std::wstring wTarget = Utf8ToWide(upstreamTarget);
        HINTERNET hReq = WinHttpOpenRequest(
            hConn, L"GET", wTarget.c_str(), nullptr,
            L"https://playgta5.com/", WINHTTP_DEFAULT_ACCEPT_TYPES, WINHTTP_FLAG_SECURE);
        if (!hReq) {
            WinHttpCloseHandle(hConn);
            SendResponse(client, 502, "Bad Gateway", "text/plain", "Open failed", 11);
            return;
        }
        WinHttpAddRequestHeaders(hReq, L"Accept-Encoding: identity\r\n",
                                 static_cast<DWORD>(-1), WINHTTP_ADDREQ_FLAG_ADD);

        std::string js;
        bool ok = false;
        if (WinHttpSendRequest(hReq, WINHTTP_NO_ADDITIONAL_HEADERS, 0, nullptr, 0, 0, 0) &&
            WinHttpReceiveResponse(hReq, nullptr)) {
            DWORD statusCode = 0, sz = sizeof(statusCode);
            WinHttpQueryHeaders(hReq, WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
                                WINHTTP_HEADER_NAME_BY_INDEX, &statusCode, &sz, WINHTTP_NO_HEADER_INDEX);
            if (statusCode >= 200 && statusCode < 400) {
                DWORD avail = 0;
                while (WinHttpQueryDataAvailable(hReq, &avail) && avail > 0) {
                    size_t oldSz = js.size();
                    js.resize(oldSz + avail);
                    DWORD rd = 0;
                    if (!WinHttpReadData(hReq, &js[oldSz], avail, &rd) || rd == 0) {
                        js.resize(oldSz);
                        break;
                    }
                    js.resize(oldSz + rd);
                    if (js.size() > 8 * 1024 * 1024) break;
                }
                ok = !js.empty();
            }
        }
        WinHttpCloseHandle(hReq);
        WinHttpCloseHandle(hConn);

        if (!ok) {
            SendResponse(client, 502, "Bad Gateway", "text/plain", "wgpu_worker fetch failed", 24);
            return;
        }

        // Patch present() blit in wgpu_worker.js to route through __vbxGta6Present with automatic fallback
        const EmbeddedAsset* patch = FindEmbeddedAsset("/vbx/gta6_wgpu_patch.js");
        if (patch && patch->size > 0) {
            size_t blitPos = js.find("if (!blit) makeBlit();");
            if (blitPos != std::string::npos) {
                size_t endPos = js.find("pass2.end();", blitPos);
                if (endPos != std::string::npos) {
                    size_t blockEnd = endPos + std::strlen("pass2.end();");
                    std::string origBlock = js.substr(blitPos, blockEnd - blitPos);
                    std::string wrapped =
                        "const __vbxDt = lastPresentT ? (performance.now() - lastPresentT) : 16.6;\n"
                        "if (!self.__vbxGta6Present || !self.__vbxGta6Present(device, canvasCtx, canvasFormat, getEncoder, t, __vbxDt, presentCount)) {\n" +
                        origBlock + "\n}";
                    js.replace(blitPos, blockEnd - blitPos, wrapped);
                }
            }
            js.append("\n\n");
            js.append(reinterpret_cast<const char*>(patch->data), patch->size);
        }

        SendResponse(client, 200, "OK", "application/javascript; charset=utf-8",
                     js.data(), js.size(), "Cache-Control: no-store\r\n", headOnly);
    }

    void SendOfflineHtml(SOCKET client, const std::string& reason) {
        std::string page =
            "<!DOCTYPE html><html><head><meta charset='utf-8'><title>ViceBox X — GTA V Offline</title>"
            "<style>body{margin:0;min-height:100vh;display:flex;align-items:center;justify-content:center;"
            "background:#0a0f18;color:#f1f5f9;font-family:'Segoe UI',sans-serif;}"
            ".card{max-width:480px;padding:30px;background:#111827;border:1px solid #334155;border-radius:16px;text-align:center;}"
            "button{margin:8px;padding:11px 22px;border-radius:10px;border:none;font-weight:700;cursor:pointer;}"
            ".p{background:#2563eb;color:#fff;}.g{background:#334155;color:#fff;}</style></head><body>"
            "<div class='card'><h2>GTA V Stream Connection</h2><p style='color:#94a3b8;'>" + reason +
            "</p><button class='p' onclick='location.reload()'>Retry Connection</button>"
            "<button class='g' onclick=\"location.href='/'\">Back to Console UI</button></div></body></html>";
        SendResponse(client, 503, "Service Unavailable", "text/html; charset=utf-8",
                     page.data(), page.size(), "Cache-Control: no-store\r\n");
    }

    static std::string QueryWideHeaderUtf8(HINTERNET hReq, DWORD queryFlag, const wchar_t* customName = nullptr) {
        DWORD sz = 0;
        if (!WinHttpQueryHeaders(hReq, queryFlag, customName ? customName : WINHTTP_HEADER_NAME_BY_INDEX,
                                 nullptr, &sz, WINHTTP_NO_HEADER_INDEX)) {
            if (GetLastError() != ERROR_INSUFFICIENT_BUFFER || sz == 0) return {};
        }
        std::wstring ws(sz / sizeof(wchar_t), L'\0');
        if (!WinHttpQueryHeaders(hReq, queryFlag, customName ? customName : WINHTTP_HEADER_NAME_BY_INDEX,
                                 &ws[0], &sz, WINHTTP_NO_HEADER_INDEX)) {
            return {};
        }
        while (!ws.empty() && ws.back() == L'\0') ws.pop_back();
        int n = WideCharToMultiByte(CP_UTF8, 0, ws.c_str(), static_cast<int>(ws.size()), nullptr, 0, nullptr, nullptr);
        if (n <= 0) return {};
        std::string out(static_cast<size_t>(n), '\0');
        WideCharToMultiByte(CP_UTF8, 0, ws.c_str(), static_cast<int>(ws.size()), &out[0], n, nullptr, nullptr);
        return out;
    }

    void ProxyStreamUpstream(SOCKET client, const std::string& method,
                             const std::string& upstreamTarget,
                             const std::string& reqRange,
                             const std::string& reqIfNoneMatch,
                             const std::string& reqIfModSince,
                             const std::string& reqAcceptEncoding,
                             bool headOnly) {
        if (!hSession_) {
            SendResponse(client, 502, "Bad Gateway", "text/plain", "Proxy offline", 13);
            return;
        }

        HINTERNET hConn = WinHttpConnect(hSession_, L"playgta5.com", INTERNET_DEFAULT_HTTPS_PORT, 0);
        if (!hConn) {
            SendResponse(client, 502, "Bad Gateway", "text/plain", "Upstream connect failed", 23);
            return;
        }

        std::wstring wMethod = Utf8ToWide(method);
        std::wstring wTarget = Utf8ToWide(upstreamTarget);
        HINTERNET hReq = WinHttpOpenRequest(
            hConn, wMethod.c_str(), wTarget.c_str(), nullptr,
            L"https://playgta5.com/", WINHTTP_DEFAULT_ACCEPT_TYPES, WINHTTP_FLAG_SECURE);
        if (!hReq) {
            WinHttpCloseHandle(hConn);
            SendResponse(client, 502, "Bad Gateway", "text/plain", "Upstream open failed", 20);
            return;
        }

        // Forward Range / caching / compression headers so WASM/DATA/BC7 assets fly at full speed!
        std::string extraReq;
        if (!reqRange.empty()) extraReq += "Range: " + reqRange + "\r\n";
        if (!reqIfNoneMatch.empty()) extraReq += "If-None-Match: " + reqIfNoneMatch + "\r\n";
        if (!reqIfModSince.empty()) extraReq += "If-Modified-Since: " + reqIfModSince + "\r\n";
        if (!reqAcceptEncoding.empty()) extraReq += "Accept-Encoding: " + reqAcceptEncoding + "\r\n";
        if (!extraReq.empty()) {
            std::wstring wEx = Utf8ToWide(extraReq);
            WinHttpAddRequestHeaders(hReq, wEx.c_str(), static_cast<DWORD>(-1), WINHTTP_ADDREQ_FLAG_ADD);
        }

        if (!WinHttpSendRequest(hReq, WINHTTP_NO_ADDITIONAL_HEADERS, 0, nullptr, 0, 0, 0) ||
            !WinHttpReceiveResponse(hReq, nullptr)) {
            WinHttpCloseHandle(hReq);
            WinHttpCloseHandle(hConn);
            SendResponse(client, 502, "Bad Gateway", "text/plain", "Upstream request failed", 23);
            return;
        }

        DWORD statusCode = 200, scSize = sizeof(statusCode);
        WinHttpQueryHeaders(hReq, WINHTTP_QUERY_STATUS_CODE | WINHTTP_QUERY_FLAG_NUMBER,
                            WINHTTP_HEADER_NAME_BY_INDEX, &statusCode, &scSize, WINHTTP_NO_HEADER_INDEX);

        std::string statusText = QueryWideHeaderUtf8(hReq, WINHTTP_QUERY_STATUS_TEXT);
        if (statusText.empty()) statusText = (statusCode == 206) ? "Partial Content" : "OK";

        std::string ct    = QueryWideHeaderUtf8(hReq, WINHTTP_QUERY_CONTENT_TYPE);
        std::string cl    = QueryWideHeaderUtf8(hReq, WINHTTP_QUERY_CONTENT_LENGTH);
        std::string cr    = QueryWideHeaderUtf8(hReq, WINHTTP_QUERY_CONTENT_RANGE);
        std::string ar    = QueryWideHeaderUtf8(hReq, WINHTTP_QUERY_ACCEPT_RANGES);
        std::string ce    = QueryWideHeaderUtf8(hReq, WINHTTP_QUERY_CONTENT_ENCODING);
        std::string etag  = QueryWideHeaderUtf8(hReq, WINHTTP_QUERY_ETAG);
        std::string cc    = QueryWideHeaderUtf8(hReq, WINHTTP_QUERY_CACHE_CONTROL);

        if (ct.empty()) ct = "application/octet-stream";

        std::ostringstream hdr;
        hdr << "HTTP/1.1 " << statusCode << " " << statusText << "\r\n"
            << "Content-Type: " << ct << "\r\n";
        if (!cl.empty())   hdr << "Content-Length: " << cl << "\r\n";
        if (!cr.empty())   hdr << "Content-Range: " << cr << "\r\n";
        if (!ar.empty())   hdr << "Accept-Ranges: " << ar << "\r\n";
        if (!ce.empty())   hdr << "Content-Encoding: " << ce << "\r\n";
        if (!etag.empty()) hdr << "ETag: " << etag << "\r\n";
        if (!cc.empty())   hdr << "Cache-Control: " << cc << "\r\n";
        hdr << "Cross-Origin-Resource-Policy: same-origin\r\n"
            << "Cross-Origin-Embedder-Policy: require-corp\r\n"
            << "Connection: close\r\n\r\n";

        std::string hdrStr = hdr.str();
        if (SendAll(client, hdrStr.data(), hdrStr.size()) && !headOnly && statusCode != 304 && statusCode != 204) {
            std::vector<char> chunk(65536);
            DWORD avail = 0;
            while (WinHttpQueryDataAvailable(hReq, &avail) && avail > 0) {
                DWORD toRead = static_cast<DWORD>(std::min<size_t>(avail, chunk.size()));
                DWORD rd = 0;
                if (!WinHttpReadData(hReq, chunk.data(), toRead, &rd) || rd == 0) break;
                if (!SendAll(client, chunk.data(), rd)) break;
            }
        }

        WinHttpCloseHandle(hReq);
        WinHttpCloseHandle(hConn);
    }

    HwMonitor* hw_ = nullptr;
    SharedEmulatorState* shared_ = nullptr;
    std::mutex* stateMu_ = nullptr;
    DevTargetController* devCtrl_ = nullptr;

    HINTERNET hSession_ = nullptr;
    SOCKET listenSock_ = INVALID_SOCKET;
    uint16_t port_ = 0;
    bool wsaInit_ = false;
    std::atomic<bool> running_{false};
    std::thread acceptThread_;
    std::mutex introResolveMu_;
};

} // namespace vicebox
