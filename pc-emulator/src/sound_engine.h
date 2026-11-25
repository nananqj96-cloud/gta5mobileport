#pragma once

#include <atomic>
#include <cmath>
#include <cstdint>
#include <mutex>
#include <vector>

#ifdef _WIN32
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>
#include <mmsystem.h>
#endif

namespace vicebox {

enum class SfxId : int {
    Startup = 0,
    Hover,
    Click,
    TabSwitch,
    KeyType,
    LoginSuccess,
    Locked,
    Launch,
    Count
};

/**
 * Self-contained procedural 44.1 kHz Stereo PCM synthesizer + polyphonic WinMM waveOut mixer.
 * Zero external .wav/.mp3 files needed — every sound is mathematically crafted at startup
 * to feel smooth, atmospheric, and console-native (never harsh 8-bit beeps).
 */
class SoundEngine {
public:
    SoundEngine() = default;
    ~SoundEngine() { Shutdown(); }

    void Init() {
        SynthesizeAll();
#ifdef _WIN32
        WAVEFORMATEX wfx{};
        wfx.wFormatTag = WAVE_FORMAT_PCM;
        wfx.nChannels = 2;
        wfx.nSamplesPerSec = kSampleRate;
        wfx.wBitsPerSample = 16;
        wfx.nBlockAlign = (wfx.nChannels * wfx.wBitsPerSample) / 8;
        wfx.nAvgBytesPerSec = wfx.nSamplesPerSec * wfx.nBlockAlign;

        if (waveOutOpen(&hWaveOut_, WAVE_MAPPER, &wfx,
                        reinterpret_cast<DWORD_PTR>(&WaveOutProc),
                        reinterpret_cast<DWORD_PTR>(this),
                        CALLBACK_FUNCTION) != MMSYSERR_NOERROR) {
            hWaveOut_ = nullptr;
            return;
        }

        running_.store(true);
        for (int i = 0; i < kNumBuffers; ++i) {
            buffers_[i].assign(kBufferFrames * 2, 0);
            headers_[i] = {};
            headers_[i].lpData = reinterpret_cast<LPSTR>(buffers_[i].data());
            headers_[i].dwBufferLength = static_cast<DWORD>(buffers_[i].size() * sizeof(int16_t));
            headers_[i].dwUser = static_cast<DWORD_PTR>(i);
            waveOutPrepareHeader(hWaveOut_, &headers_[i], sizeof(WAVEHDR));
            FillAndSubmit(i);
        }
#endif
    }

    void Shutdown() {
#ifdef _WIN32
        running_.store(false);
        if (hWaveOut_) {
            waveOutReset(hWaveOut_);
            for (int i = 0; i < kNumBuffers; ++i) {
                if (headers_[i].dwFlags & WHDR_PREPARED) {
                    waveOutUnprepareHeader(hWaveOut_, &headers_[i], sizeof(WAVEHDR));
                }
            }
            waveOutClose(hWaveOut_);
            hWaveOut_ = nullptr;
        }
#endif
    }

    void Play(SfxId id, float gain = 1.0f, float pitch = 1.0f) {
        if (muted_.load()) return;
        int idx = static_cast<int>(id);
        if (idx < 0 || idx >= static_cast<int>(SfxId::Count)) return;
        if (clips_[idx].empty()) return;

        std::lock_guard<std::mutex> lock(voiceMutex_);
        // Find free slot or steal the quietest / oldest active voice
        int slot = -1;
        for (int i = 0; i < kMaxVoices; ++i) {
            if (!voices_[i].active) {
                slot = i;
                break;
            }
        }
        if (slot < 0) slot = 0;
        voices_[slot].clip = idx;
        voices_[slot].pos = 0.0f;
        voices_[slot].gain = gain;
        voices_[slot].pitch = pitch;
        voices_[slot].active = true;
    }

    void SetMuted(bool m) { muted_.store(m); }
    bool IsMuted() const { return muted_.load(); }
    void ToggleMute() { muted_.store(!muted_.load()); }

private:
    static constexpr int kSampleRate = 44100;
    static constexpr int kMaxVoices = 12;
    static constexpr int kNumBuffers = 4;
    static constexpr int kBufferFrames = 512; // ~11.6 ms ultra-low latency
    static constexpr float kTwoPi = 6.28318530718f;

    struct Voice {
        int clip = 0;
        float pos = 0.0f;
        float gain = 1.0f;
        float pitch = 1.0f;
        bool active = false;
    };

    std::vector<float> clips_[static_cast<int>(SfxId::Count)]; // interleaved stereo float [-1, 1]
    Voice voices_[kMaxVoices]{};
    std::mutex voiceMutex_;
    std::atomic<bool> muted_{false};
    std::atomic<bool> running_{false};

#ifdef _WIN32
    HWAVEOUT hWaveOut_ = nullptr;
    WAVEHDR headers_[kNumBuffers]{};
    std::vector<int16_t> buffers_[kNumBuffers];

    static void CALLBACK WaveOutProc(HWAVEOUT, UINT uMsg, DWORD_PTR dwInstance, DWORD_PTR dwParam1, DWORD_PTR) {
        if (uMsg != WOM_DONE) return;
        auto* self = reinterpret_cast<SoundEngine*>(dwInstance);
        if (!self || !self->running_.load()) return;
        auto* hdr = reinterpret_cast<WAVEHDR*>(dwParam1);
        int bufIdx = static_cast<int>(hdr->dwUser);
        self->FillAndSubmit(bufIdx);
    }

    void FillAndSubmit(int bufIdx) {
        if (!running_.load() || !hWaveOut_) return;
        auto& out = buffers_[bufIdx];
        float mix[kBufferFrames * 2] = {};

        {
            std::lock_guard<std::mutex> lock(voiceMutex_);
            const bool isMuted = muted_.load();
            for (int v = 0; v < kMaxVoices; ++v) {
                Voice& vc = voices_[v];
                if (!vc.active) continue;
                const auto& clip = clips_[vc.clip];
                const int totalFrames = static_cast<int>(clip.size() / 2);
                for (int f = 0; f < kBufferFrames; ++f) {
                    int fi = static_cast<int>(vc.pos);
                    if (fi >= totalFrames - 1) {
                        vc.active = false;
                        break;
                    }
                    float frac = vc.pos - static_cast<float>(fi);
                    if (!isMuted) {
                        float l0 = clip[fi * 2];
                        float r0 = clip[fi * 2 + 1];
                        float l1 = clip[(fi + 1) * 2];
                        float r1 = clip[(fi + 1) * 2 + 1];
                        mix[f * 2] += (l0 + (l1 - l0) * frac) * vc.gain;
                        mix[f * 2 + 1] += (r0 + (r1 - r0) * frac) * vc.gain;
                    }
                    vc.pos += vc.pitch;
                }
            }
        }

        // Soft tanh limiter so overlapping polyphonic chords never harshly clip
        for (int i = 0; i < kBufferFrames * 2; ++i) {
            float s = std::tanh(mix[i] * 0.90f);
            out[i] = static_cast<int16_t>(s * 31500.0f);
        }
        waveOutWrite(hWaveOut_, &headers_[bufIdx], sizeof(WAVEHDR));
    }
#endif

    static float SmoothEnv(float t, float dur, float attack, float release) {
        if (t < 0.0f || t > dur) return 0.0f;
        float a = (attack > 0.0f && t < attack) ? (0.5f - 0.5f * std::cos(3.14159265f * t / attack)) : 1.0f;
        float rStart = dur - release;
        float r = (release > 0.0f && t > rStart)
            ? (0.5f + 0.5f * std::cos(3.14159265f * (t - rStart) / release))
            : 1.0f;
        return a * r;
    }

    static std::vector<float> MakeBuffer(float seconds) {
        int frames = static_cast<int>(seconds * kSampleRate);
        return std::vector<float>(static_cast<size_t>(frames) * 2, 0.0f);
    }

    static void AddTone(std::vector<float>& buf, float startSec, float durSec,
                        float freqStart, float freqEnd, float amp, float pan,
                        float attack, float release, float harmonic2 = 0.0f) {
        int totalFrames = static_cast<int>(buf.size() / 2);
        int i0 = static_cast<int>(startSec * kSampleRate);
        int len = static_cast<int>(durSec * kSampleRate);
        float panL = std::cos((pan + 1.0f) * 0.25f * 3.14159265f);
        float panR = std::sin((pan + 1.0f) * 0.25f * 3.14159265f);
        double phase = 0.0;
        for (int i = 0; i < len; ++i) {
            int idx = i0 + i;
            if (idx < 0 || idx >= totalFrames) continue;
            float t = static_cast<float>(i) / kSampleRate;
            float u = t / durSec;
            float freq = freqStart + (freqEnd - freqStart) * u;
            phase += static_cast<double>(kTwoPi * freq / kSampleRate);
            float env = SmoothEnv(t, durSec, attack, release);
            float sample = static_cast<float>(std::sin(phase));
            if (harmonic2 > 0.0f) {
                sample = (sample + harmonic2 * static_cast<float>(std::sin(phase * 2.0))) / (1.0f + harmonic2);
            }
            float val = sample * env * amp;
            buf[idx * 2] += val * panL;
            buf[idx * 2 + 1] += val * panR;
        }
    }

    void SynthesizeAll() {
        // 1. Startup: Warm Xbox-inspired atmospheric stereo Dmaj9 bloom (1.45s)
        {
            auto b = MakeBuffer(1.45f);
            AddTone(b, 0.00f, 1.40f, 73.42f, 73.42f, 0.22f, 0.00f, 0.18f, 0.90f, 0.15f);   // D2 sub
            AddTone(b, 0.04f, 1.32f, 220.0f, 220.6f, 0.15f, -0.35f, 0.15f, 0.85f, 0.12f);  // A3
            AddTone(b, 0.08f, 1.28f, 293.66f, 294.2f, 0.16f, 0.30f, 0.14f, 0.85f, 0.18f);  // D4
            AddTone(b, 0.14f, 1.22f, 369.99f, 370.5f, 0.12f, -0.20f, 0.16f, 0.80f, 0.10f); // F#4
            AddTone(b, 0.20f, 1.15f, 659.25f, 660.0f, 0.08f, 0.42f, 0.20f, 0.78f, 0.08f);  // E5 airy shimmer
            clips_[static_cast<int>(SfxId::Startup)] = std::move(b);
        }

        // 2. Hover: Ultra-delicate glass air tick (26ms)
        {
            auto b = MakeBuffer(0.030f);
            AddTone(b, 0.000f, 0.024f, 1180.0f, 1340.0f, 0.065f, 0.0f, 0.003f, 0.019f, 0.08f);
            clips_[static_cast<int>(SfxId::Hover)] = std::move(b);
        }

        // 3. Click: Crisp velvet confirmation chime (75ms)
        {
            auto b = MakeBuffer(0.085f);
            AddTone(b, 0.000f, 0.048f, 520.0f, 780.0f, 0.17f, -0.10f, 0.003f, 0.038f, 0.15f);
            AddTone(b, 0.014f, 0.065f, 980.0f, 1020.0f, 0.10f, 0.15f, 0.004f, 0.055f, 0.05f);
            clips_[static_cast<int>(SfxId::Click)] = std::move(b);
        }

        // 4. TabSwitch: Soft silky stereo sweep (110ms)
        {
            auto b = MakeBuffer(0.12f);
            AddTone(b, 0.00f, 0.10f, 440.0f, 660.0f, 0.12f, -0.28f, 0.012f, 0.075f, 0.10f);
            AddTone(b, 0.02f, 0.09f, 660.0f, 880.0f, 0.09f, 0.28f, 0.012f, 0.065f, 0.08f);
            clips_[static_cast<int>(SfxId::TabSwitch)] = std::move(b);
        }

        // 5. KeyType: Ultra-subtle tactile keystroke pip (22ms)
        {
            auto b = MakeBuffer(0.025f);
            AddTone(b, 0.000f, 0.018f, 640.0f, 420.0f, 0.075f, 0.0f, 0.002f, 0.014f, 0.12f);
            clips_[static_cast<int>(SfxId::KeyType)] = std::move(b);
        }

        // 6. LoginSuccess: Ascending crystal glass 4-note chord (0.92s)
        {
            auto b = MakeBuffer(0.95f);
            AddTone(b, 0.00f, 0.55f, 587.33f, 587.33f, 0.16f, -0.30f, 0.012f, 0.45f, 0.12f); // D5
            AddTone(b, 0.07f, 0.60f, 739.99f, 739.99f, 0.16f, 0.25f, 0.012f, 0.50f, 0.12f);  // F#5
            AddTone(b, 0.14f, 0.68f, 880.00f, 880.00f, 0.15f, -0.20f, 0.012f, 0.55f, 0.10f); // A5
            AddTone(b, 0.22f, 0.70f, 1174.66f, 1176.0f, 0.14f, 0.30f, 0.015f, 0.60f, 0.08f); // D6
            AddTone(b, 0.00f, 0.80f, 146.83f, 146.83f, 0.16f, 0.00f, 0.050f, 0.62f, 0.10f);  // D3 warm bass
            clips_[static_cast<int>(SfxId::LoginSuccess)] = std::move(b);
        }

        // 7. Locked / Error: Soft warm muted double-thump (210ms)
        {
            auto b = MakeBuffer(0.22f);
            AddTone(b, 0.00f, 0.085f, 185.0f, 140.0f, 0.22f, -0.12f, 0.006f, 0.068f, 0.15f);
            AddTone(b, 0.09f, 0.110f, 140.0f, 105.0f, 0.20f, 0.12f, 0.006f, 0.090f, 0.15f);
            clips_[static_cast<int>(SfxId::Locked)] = std::move(b);
        }

        // 8. Launch: Iconic Xbox Hypervisor power-up turbine swell + fifth bloom (1.42s)
        {
            auto b = MakeBuffer(1.45f);
            AddTone(b, 0.00f, 1.38f, 65.41f, 98.00f, 0.24f, 0.00f, 0.16f, 0.85f, 0.22f);    // Rising sub turbine
            AddTone(b, 0.06f, 1.30f, 196.00f, 293.66f, 0.17f, -0.32f, 0.18f, 0.80f, 0.16f);  // G3 -> D4 rise
            AddTone(b, 0.16f, 1.22f, 293.66f, 440.00f, 0.16f, 0.32f, 0.16f, 0.78f, 0.14f);   // D4 -> A4 rise
            AddTone(b, 0.28f, 1.10f, 587.33f, 588.50f, 0.13f, -0.22f, 0.14f, 0.80f, 0.10f);  // D5 shimmer
            AddTone(b, 0.36f, 1.02f, 880.00f, 882.00f, 0.10f, 0.26f, 0.18f, 0.76f, 0.08f);   // A5 glow
            clips_[static_cast<int>(SfxId::Launch)] = std::move(b);
        }
    }
};

} // namespace vicebox
