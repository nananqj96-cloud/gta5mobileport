#pragma once

#include <winsock2.h>
#include <windows.h>
#include <dxgi1_4.h>
#include <pdh.h>
#include <pdhmsg.h>

#include <atomic>
#include <cstring>
#include <mutex>
#include <string>
#include <thread>
#include <vector>

namespace vicebox {

struct HwSnapshot {
    double cpuPct       = 0.0;
    double gpuPct       = 0.0;
    double vramUsedMb   = 0.0;
    double vramBudgetMb = 0.0;
    double ramUsedGb    = 0.0;
    double ramTotalGb   = 0.0;
    std::string gpuName = "Direct3D 11 GPU";
};

class HwMonitor {
public:
    HwMonitor() = default;
    ~HwMonitor() { Shutdown(); }

    void Start() {
        if (running_.exchange(true)) return;
        QueryAdapterInfo();
        InitPdhGpu();
        SampleCpuDelta(); // prime baseline
        worker_ = std::thread([this]() { Loop(); });
    }

    void Shutdown() {
        if (!running_.exchange(false)) return;
        if (worker_.joinable()) worker_.join();
        if (pdhQuery_) {
            PdhCloseQuery(pdhQuery_);
            pdhQuery_ = nullptr;
            pdhGpuCounter_ = nullptr;
        }
        if (adapter3_) {
            adapter3_->Release();
            adapter3_ = nullptr;
        }
        if (factory4_) {
            factory4_->Release();
            factory4_ = nullptr;
        }
    }

    HwSnapshot Get() const {
        std::lock_guard<std::mutex> lk(mu_);
        return snap_;
    }

private:
    static uint64_t FileTimeToU64(const FILETIME& ft) {
        return (static_cast<uint64_t>(ft.dwHighDateTime) << 32) |
               static_cast<uint64_t>(ft.dwLowDateTime);
    }

    static std::string WideToUtf8(const wchar_t* ws) {
        if (!ws || !ws[0]) return {};
        int n = WideCharToMultiByte(CP_UTF8, 0, ws, -1, nullptr, 0, nullptr, nullptr);
        if (n <= 1) return {};
        std::string out(static_cast<size_t>(n - 1), '\0');
        WideCharToMultiByte(CP_UTF8, 0, ws, -1, &out[0], n, nullptr, nullptr);
        return out;
    }

    void QueryAdapterInfo() {
        if (FAILED(CreateDXGIFactory1(__uuidof(IDXGIFactory4),
                                      reinterpret_cast<void**>(&factory4_))) || !factory4_) {
            return;
        }
        IDXGIAdapter1* best = nullptr;
        SIZE_T bestVram = 0;
        for (UINT i = 0;; ++i) {
            IDXGIAdapter1* ad = nullptr;
            if (factory4_->EnumAdapters1(i, &ad) == DXGI_ERROR_NOT_FOUND) break;
            if (!ad) continue;
            DXGI_ADAPTER_DESC1 desc{};
            if (SUCCEEDED(ad->GetDesc1(&desc))) {
                if ((desc.Flags & DXGI_ADAPTER_FLAG_SOFTWARE) == 0) {
                    if (!best || desc.DedicatedVideoMemory > bestVram) {
                        if (best) best->Release();
                        best = ad;
                        bestVram = desc.DedicatedVideoMemory;
                        ad = nullptr;
                    }
                }
            }
            if (ad) ad->Release();
        }
        if (!best) {
            factory4_->EnumAdapters1(0, &best);
        }
        if (best) {
            DXGI_ADAPTER_DESC1 desc{};
            if (SUCCEEDED(best->GetDesc1(&desc))) {
                std::string name = WideToUtf8(desc.Description);
                if (!name.empty()) {
                    std::lock_guard<std::mutex> lk(mu_);
                    snap_.gpuName = name;
                    snap_.vramBudgetMb = static_cast<double>(desc.DedicatedVideoMemory) / (1024.0 * 1024.0);
                }
            }
            best->QueryInterface(__uuidof(IDXGIAdapter3), reinterpret_cast<void**>(&adapter3_));
            best->Release();
        }
    }

    void InitPdhGpu() {
        if (PdhOpenQueryW(nullptr, 0, &pdhQuery_) != ERROR_SUCCESS) {
            pdhQuery_ = nullptr;
            return;
        }
        // Windows 10/11 native GPU Engine 3D utilization wildcard counter
        if (PdhAddEnglishCounterW(pdhQuery_,
                                  L"\\GPU Engine(*engtype_3D)\\Utilization Percentage",
                                  0, &pdhGpuCounter_) != ERROR_SUCCESS) {
            PdhCloseQuery(pdhQuery_);
            pdhQuery_ = nullptr;
            pdhGpuCounter_ = nullptr;
            return;
        }
        PdhCollectQueryData(pdhQuery_);
    }

    double SampleCpuDelta() {
        FILETIME idleFt{}, kernelFt{}, userFt{};
        if (!GetSystemTimes(&idleFt, &kernelFt, &userFt)) return 0.0;
        uint64_t idle = FileTimeToU64(idleFt);
        uint64_t kernel = FileTimeToU64(kernelFt);
        uint64_t user = FileTimeToU64(userFt);
        if (!hasPrevCpu_) {
            prevIdle_ = idle;
            prevKernel_ = kernel;
            prevUser_ = user;
            hasPrevCpu_ = true;
            return 0.0;
        }
        uint64_t dIdle = idle - prevIdle_;
        uint64_t dTotal = (kernel - prevKernel_) + (user - prevUser_);
        prevIdle_ = idle;
        prevKernel_ = kernel;
        prevUser_ = user;
        if (dTotal == 0) return 0.0;
        double busy = static_cast<double>(dTotal > dIdle ? (dTotal - dIdle) : 0);
        double pct = (busy * 100.0) / static_cast<double>(dTotal);
        if (pct < 0.0) pct = 0.0;
        if (pct > 100.0) pct = 100.0;
        return pct;
    }

    double SampleGpu3dPct() {
        if (!pdhQuery_ || !pdhGpuCounter_) return 0.0;
        if (PdhCollectQueryData(pdhQuery_) != ERROR_SUCCESS) return 0.0;

        DWORD bufSize = 0;
        DWORD itemCount = 0;
        PDH_STATUS st = PdhGetFormattedCounterArrayW(
            pdhGpuCounter_, PDH_FMT_DOUBLE, &bufSize, &itemCount, nullptr);
        if (st != static_cast<PDH_STATUS>(PDH_MORE_DATA) || bufSize == 0) return 0.0;

        std::vector<uint8_t> raw(bufSize);
        auto* items = reinterpret_cast<PDH_FMT_COUNTERVALUE_ITEM_W*>(raw.data());
        st = PdhGetFormattedCounterArrayW(
            pdhGpuCounter_, PDH_FMT_DOUBLE, &bufSize, &itemCount, items);
        if (st != ERROR_SUCCESS) return 0.0;

        double total = 0.0;
        for (DWORD i = 0; i < itemCount; ++i) {
            if (items[i].FmtValue.CStatus == ERROR_SUCCESS ||
                items[i].FmtValue.CStatus == static_cast<DWORD>(PDH_CSTATUS_NEW_DATA)) {
                double v = items[i].FmtValue.doubleValue;
                if (v > 0.0 && v <= 100.0) total += v;
            }
        }
        if (total > 100.0) total = 100.0;
        return total;
    }

    void SampleOnce() {
        double cpu = SampleCpuDelta();
        double gpu = SampleGpu3dPct();

        MEMORYSTATUSEX ms{};
        ms.dwLength = sizeof(ms);
        double ramUsed = 0.0, ramTotal = 0.0;
        if (GlobalMemoryStatusEx(&ms)) {
            ramTotal = static_cast<double>(ms.ullTotalPhys) / (1024.0 * 1024.0 * 1024.0);
            ramUsed  = static_cast<double>(ms.ullTotalPhys - ms.ullAvailPhys) / (1024.0 * 1024.0 * 1024.0);
        }

        double vramUsed = 0.0, vramBudget = 0.0;
        if (adapter3_) {
            DXGI_QUERY_VIDEO_MEMORY_INFO vmi{};
            if (SUCCEEDED(adapter3_->QueryVideoMemoryInfo(
                    0, DXGI_MEMORY_SEGMENT_GROUP_LOCAL, &vmi))) {
                vramUsed   = static_cast<double>(vmi.CurrentUsage) / (1024.0 * 1024.0);
                vramBudget = static_cast<double>(vmi.Budget) / (1024.0 * 1024.0);
            }
        }

        std::lock_guard<std::mutex> lk(mu_);
        snap_.cpuPct = cpu;
        snap_.gpuPct = gpu;
        snap_.ramUsedGb = ramUsed;
        snap_.ramTotalGb = ramTotal;
        if (vramBudget > 0.0) snap_.vramBudgetMb = vramBudget;
        snap_.vramUsedMb = vramUsed;
    }

    void Loop() {
        while (running_.load()) {
            SampleOnce();
            for (int i = 0; i < 10 && running_.load(); ++i) {
                Sleep(60);
            }
        }
    }

    std::atomic<bool> running_{false};
    std::thread worker_;
    mutable std::mutex mu_;
    HwSnapshot snap_;

    IDXGIFactory4* factory4_ = nullptr;
    IDXGIAdapter3* adapter3_ = nullptr;
    PDH_HQUERY pdhQuery_ = nullptr;
    PDH_HCOUNTER pdhGpuCounter_ = nullptr;

    bool hasPrevCpu_ = false;
    uint64_t prevIdle_ = 0;
    uint64_t prevKernel_ = 0;
    uint64_t prevUser_ = 0;
};

} // namespace vicebox
