package com.ps5.mobile.stats;

import android.app.ActivityManager;
import android.content.Context;
import android.os.Debug;
import android.os.Handler;
import android.os.Looper;
import android.os.Process;
import android.os.SystemClock;

import java.io.BufferedReader;
import java.io.File;
import java.io.FileReader;

/**
 * Samples real Android device telemetry:
 * - Engine FPS (pushed from WebGPU/PS5 UI)
 * - CPU usage % (via /proc/stat or Android SELinux-safe Process.getElapsedCpuTime + cpufreq MHz)
 * - GPU usage % (via Adreno kgsl / ARM Mali / MediaTek sysfs probes when available)
 * - System RAM used/total GB + App PSS MB
 */
public final class StatsMonitor {

    public static final class Snapshot {
        public final int fps;
        public final int cpuPct;
        public final int cpuMhz;
        public final int gpuPct;        // -1 if hardware GPU sensor is sealed by kernel
        public final boolean gpuDirect; // true = real kernel GPU sensor, false = unavailable
        public final long usedRamMb;
        public final long totalRamMb;
        public final int appPssMb;

        Snapshot(int fps, int cpuPct, int cpuMhz, int gpuPct, boolean gpuDirect,
                 long usedRamMb, long totalRamMb, int appPssMb) {
            this.fps = fps;
            this.cpuPct = cpuPct;
            this.cpuMhz = cpuMhz;
            this.gpuPct = gpuPct;
            this.gpuDirect = gpuDirect;
            this.usedRamMb = usedRamMb;
            this.totalRamMb = totalRamMb;
            this.appPssMb = appPssMb;
        }
    }

    public interface Listener {
        void onStatsUpdated(Snapshot snapshot);
    }

    private final Context appContext;
    private final ActivityManager activityManager;
    private final Handler handler = new Handler(Looper.getMainLooper());
    private final Listener listener;
    private final int cpuCount;

    private volatile int currentFps = 0;
    private boolean running = false;

    private long prevTotalCpu = -1;
    private long prevIdleCpu = -1;
    private long prevProcCpuMs = -1;
    private long prevWallMs = -1;

    private final Runnable ticker = new Runnable() {
        @Override
        public void run() {
            if (!running) return;
            Snapshot snap = sample();
            if (listener != null) listener.onStatsUpdated(snap);
            handler.postDelayed(this, 850);
        }
    };

    public StatsMonitor(Context context, Listener listener) {
        this.appContext = context.getApplicationContext();
        this.activityManager = (ActivityManager) appContext.getSystemService(Context.ACTIVITY_SERVICE);
        this.listener = listener;
        this.cpuCount = Math.max(1, Runtime.getRuntime().availableProcessors());
    }

    public void setFps(int fps) {
        this.currentFps = Math.max(0, fps);
    }

    public void start() {
        if (running) return;
        running = true;
        prevProcCpuMs = Process.getElapsedCpuTime();
        prevWallMs = SystemClock.elapsedRealtime();
        handler.post(ticker);
    }

    public void stop() {
        running = false;
        handler.removeCallbacks(ticker);
    }

    private Snapshot sample() {
        int cpuPct = readSystemCpuPct();
        if (cpuPct < 0) cpuPct = readProcessCpuPct();
        int cpuMhz = readCpuFreqMhz();

        int gpuDirectVal = readGpuSensorPct();
        boolean hasGpu = gpuDirectVal >= 0;

        long totalMb = 0;
        long usedMb = 0;
        if (activityManager != null) {
            ActivityManager.MemoryInfo mi = new ActivityManager.MemoryInfo();
            activityManager.getMemoryInfo(mi);
            totalMb = mi.totalMem / (1024L * 1024L);
            usedMb = Math.max(0L, (mi.totalMem - mi.availMem) / (1024L * 1024L));
        }

        int pssMb = 0;
        try {
            Debug.MemoryInfo dmi = new Debug.MemoryInfo();
            Debug.getMemoryInfo(dmi);
            pssMb = dmi.getTotalPss() / 1024;
        } catch (Throwable ignored) {}

        return new Snapshot(currentFps, cpuPct, cpuMhz, gpuDirectVal, hasGpu, usedMb, totalMb, pssMb);
    }

    private int readSystemCpuPct() {
        try (BufferedReader br = new BufferedReader(new FileReader("/proc/stat"))) {
            String line = br.readLine();
            if (line == null || !line.startsWith("cpu ")) return -1;
            String[] p = line.trim().split("\\s+");
            if (p.length < 5) return -1;
            long user = Long.parseLong(p[1]);
            long nice = Long.parseLong(p[2]);
            long sys = Long.parseLong(p[3]);
            long idle = Long.parseLong(p[4]);
            long iowait = p.length > 5 ? Long.parseLong(p[5]) : 0;
            long irq = p.length > 6 ? Long.parseLong(p[6]) : 0;
            long softirq = p.length > 7 ? Long.parseLong(p[7]) : 0;
            long total = user + nice + sys + idle + iowait + irq + softirq;
            long idleAll = idle + iowait;
            int pct = -1;
            if (prevTotalCpu >= 0 && total > prevTotalCpu) {
                long dt = total - prevTotalCpu;
                long di = idleAll - prevIdleCpu;
                pct = (int) Math.round(((dt - di) * 100.0) / dt);
                pct = Math.max(0, Math.min(100, pct));
            }
            prevTotalCpu = total;
            prevIdleCpu = idleAll;
            return pct;
        } catch (Throwable ignored) {
            return -1;
        }
    }

    private int readProcessCpuPct() {
        long nowProc = Process.getElapsedCpuTime();
        long nowWall = SystemClock.elapsedRealtime();
        int pct = 0;
        if (prevWallMs > 0 && nowWall > prevWallMs) {
            long dProc = Math.max(0, nowProc - prevProcCpuMs);
            long dWall = nowWall - prevWallMs;
            // Scale against core count while giving readable utilization
            pct = (int) Math.min(100, Math.round((dProc * 100.0) / (dWall * Math.max(1, cpuCount / 2.0))));
        }
        prevProcCpuMs = nowProc;
        prevWallMs = nowWall;
        return pct;
    }

    private int readCpuFreqMhz() {
        String[] paths = {
                "/sys/devices/system/cpu/cpu0/cpufreq/scaling_cur_freq",
                "/sys/devices/system/cpu/cpu4/cpufreq/scaling_cur_freq",
                "/sys/devices/system/cpu/cpu6/cpufreq/scaling_cur_freq"
        };
        int maxKhz = 0;
        for (String path : paths) {
            String txt = readFirstLine(path);
            if (txt != null) {
                try {
                    int khz = Integer.parseInt(txt.trim());
                    if (khz > maxKhz) maxKhz = khz;
                } catch (NumberFormatException ignored) {}
            }
        }
        return maxKhz > 0 ? (maxKhz / 1000) : 0;
    }

    private int readGpuSensorPct() {
        // 1. Qualcomm Adreno gpubusy ("busy total")
        String adrenoBusy = readFirstLine("/sys/class/kgsl/kgsl-3d0/gpubusy");
        if (adrenoBusy != null) {
            String[] p = adrenoBusy.trim().split("\\s+");
            if (p.length >= 2) {
                try {
                    long busy = Long.parseLong(p[0]);
                    long total = Long.parseLong(p[1]);
                    if (total > 0) return (int) Math.max(0, Math.min(100, (busy * 100L) / total));
                } catch (NumberFormatException ignored) {}
            }
        }
        // 2. Direct percentage sensors (Adreno / ARM Mali / MediaTek / PowerVR)
        String[] pctPaths = {
                "/sys/class/kgsl/kgsl-3d0/gpu_busy_percentage",
                "/sys/class/misc/mali0/device/utilisation",
                "/sys/devices/platform/mali0/utilisation",
                "/sys/module/ged/parameters/gpu_loading"
        };
        for (String path : pctPaths) {
            String txt = readFirstLine(path);
            if (txt != null) {
                String clean = txt.replace("%", "").trim().split("\\s+")[0];
                try {
                    int v = Integer.parseInt(clean);
                    if (v >= 0 && v <= 100) return v;
                } catch (NumberFormatException ignored) {}
            }
        }
        return -1;
    }

    private static String readFirstLine(String path) {
        File f = new File(path);
        if (!f.exists() || !f.canRead()) return null;
        try (BufferedReader br = new BufferedReader(new FileReader(f))) {
            return br.readLine();
        } catch (Throwable ignored) {
            return null;
        }
    }
}
