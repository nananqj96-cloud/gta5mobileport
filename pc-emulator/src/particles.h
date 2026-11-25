#pragma once

#include "imgui.h"
#include <algorithm>
#include <cmath>
#include <cstdint>
#include <vector>

namespace vicebox {

/**
 * High-framerate GPU-rendered ambient background particle & aurora engine.
 * Features:
 * - Smooth breathing Xbox Emerald / Vice Magenta / Cyber Cyan ambient aurora clouds
 * - Subtle perspective grid horizon along the lower edge
 * - 96 multi-depth floating luminous particles with smooth cursor repulsion & constellation links
 * - Interactive burst micro-sparks on clicks, sign-in, and game launches
 */
class ParticleSystem {
public:
    void Init(float width, float height) {
        w_ = (width > 1.0f) ? width : 1140.0f;
        h_ = (height > 1.0f) ? height : 700.0f;
        rng_ = 0x56494345u; // 'VICE'

        particles_.clear();
        particles_.reserve(kParticleCount);
        for (int i = 0; i < kParticleCount; ++i) {
            Particle p{};
            p.x = RandRange(0.0f, w_);
            p.y = RandRange(0.0f, h_);
            p.depth = (i < 34) ? 0.35f : (i < 70 ? 0.68f : 1.0f);
            float spd = (10.0f + 22.0f * p.depth);
            float ang = RandRange(0.0f, 6.2831853f);
            p.vx = std::cos(ang) * spd * 0.55f;
            p.vy = -std::abs(std::sin(ang)) * spd * 0.65f - 6.0f * p.depth;
            p.baseVx = p.vx;
            p.baseVy = p.vy;
            p.radius = (p.depth < 0.5f) ? RandRange(2.4f, 4.6f)
                     : (p.depth < 0.85f ? RandRange(1.6f, 2.9f) : RandRange(1.8f, 3.3f));
            p.phase = RandRange(0.0f, 6.2831853f);
            p.colorIdx = i % 3; // 0 = Xbox Emerald, 1 = Cyber Cyan, 2 = Vice Magenta
            particles_.push_back(p);
        }
        initialized_ = true;
    }

    void EmitBurst(ImVec2 origin, int count, ImVec4 colA, ImVec4 colB) {
        for (int i = 0; i < count; ++i) {
            BurstSpark s{};
            float ang = RandRange(0.0f, 6.2831853f);
            float spd = RandRange(75.0f, 290.0f);
            s.x = origin.x;
            s.y = origin.y;
            s.vx = std::cos(ang) * spd;
            s.vy = std::sin(ang) * spd;
            s.life = 0.0f;
            s.maxLife = RandRange(0.45f, 0.95f);
            s.radius = RandRange(1.6f, 3.6f);
            float t = RandRange(0.0f, 1.0f);
            s.color = ImVec4(
                colA.x + (colB.x - colA.x) * t,
                colA.y + (colB.y - colA.y) * t,
                colA.z + (colB.z - colA.z) * t,
                1.0f);
            sparks_.push_back(s);
        }
        if (sparks_.size() > 260) {
            sparks_.erase(sparks_.begin(), sparks_.begin() + static_cast<ptrdiff_t>(sparks_.size() - 260));
        }
    }

    void UpdateAndRender(ImDrawList* dl, ImVec2 origin, ImVec2 size, ImVec2 mousePos, float dt, float time) {
        if (!initialized_) Init(size.x, size.y);
        w_ = (size.x > 1.0f) ? size.x : w_;
        h_ = (size.y > 1.0f) ? size.y : h_;
        dt = std::clamp(dt, 0.0005f, 0.05f);

        // 1. Deep Obsidian Carbon Vertical Backdrop Gradient
        const ImU32 colTop = IM_COL32(6, 9, 16, 255);
        const ImU32 colBot = IM_COL32(11, 15, 27, 255);
        dl->AddRectFilledMultiColor(origin, ImVec2(origin.x + w_, origin.y + h_), colTop, colTop, colBot, colBot);

        // 2. Smooth Breathing Ambient Aurora Blobs
        DrawSoftGlow(dl,
                     ImVec2(origin.x + w_ * (0.20f + 0.08f * std::sin(time * 0.23f)),
                            origin.y + h_ * (0.24f + 0.07f * std::cos(time * 0.19f))),
                     w_ * 0.38f, ImVec4(0.08f, 0.85f, 0.48f, 0.095f)); // Xbox Emerald

        DrawSoftGlow(dl,
                     ImVec2(origin.x + w_ * (0.82f + 0.07f * std::cos(time * 0.21f)),
                            origin.y + h_ * (0.76f + 0.08f * std::sin(time * 0.17f))),
                     w_ * 0.40f, ImVec4(1.00f, 0.18f, 0.58f, 0.090f)); // Vice Magenta

        DrawSoftGlow(dl,
                     ImVec2(origin.x + w_ * (0.68f + 0.09f * std::sin(time * 0.15f + 1.4f)),
                            origin.y + h_ * (0.22f + 0.06f * std::cos(time * 0.24f))),
                     w_ * 0.30f, ImVec4(0.00f, 0.88f, 1.00f, 0.065f)); // Cyber Cyan

        // 3. Subtle Perspective Hypervisor Horizon Grid (lower 26%)
        DrawHorizonGrid(dl, origin, w_, h_, time);

        // 4. Update Multi-Depth Floating Luminous Particles + Mouse Force Field
        const float relMouseX = mousePos.x - origin.x;
        const float relMouseY = mousePos.y - origin.y;
        const float damp = 1.0f - std::exp(-2.8f * dt);

        for (auto& p : particles_) {
            float dx = p.x - relMouseX;
            float dy = p.y - relMouseY;
            float distSq = dx * dx + dy * dy;
            if (distSq > 1.0f && distSq < 155.0f * 155.0f) {
                float dist = std::sqrt(distSq);
                float force = (1.0f - dist / 155.0f) * 165.0f * p.depth;
                p.vx += (dx / dist) * force * dt;
                p.vy += (dy / dist) * force * dt;
            }

            // Gentle drift + spring return to ambient velocity
            float sway = std::sin(time * 0.7f + p.phase) * 7.0f * p.depth;
            p.vx += ((p.baseVx + sway) - p.vx) * damp;
            p.vy += (p.baseVy - p.vy) * damp;
            p.x += p.vx * dt;
            p.y += p.vy * dt;

            // Seamless wrap-around
            if (p.x < -16.0f) p.x = w_ + 16.0f;
            if (p.x > w_ + 16.0f) p.x = -16.0f;
            if (p.y < -16.0f) {
                p.y = h_ + 16.0f;
                p.x = RandRange(0.0f, w_);
            }
            if (p.y > h_ + 16.0f) p.y = -16.0f;
        }

        // 5. Delicate Constellation Links Between Foreground Particles
        const float maxLinkDist = 132.0f;
        const float maxLinkSq = maxLinkDist * maxLinkDist;
        for (size_t i = 0; i < particles_.size(); ++i) {
            const auto& a = particles_[i];
            if (a.depth < 0.65f) continue;
            for (size_t j = i + 1; j < particles_.size(); ++j) {
                const auto& b = particles_[j];
                if (b.depth < 0.65f) continue;
                float dx = a.x - b.x;
                float dy = a.y - b.y;
                float d2 = dx * dx + dy * dy;
                if (d2 < maxLinkSq) {
                    float t = 1.0f - (std::sqrt(d2) / maxLinkDist);
                    float alpha = t * t * 0.18f;
                    ImVec4 c = PaletteColor(a.colorIdx);
                    dl->AddLine(
                        ImVec2(origin.x + a.x, origin.y + a.y),
                        ImVec2(origin.x + b.x, origin.y + b.y),
                        ImGui::ColorConvertFloat4ToU32(ImVec4(c.x, c.y, c.z, alpha)),
                        1.0f);
                }
            }
        }

        // 6. Render Luminous Particles with Layered Soft Halos
        for (const auto& p : particles_) {
            float twinkle = 0.68f + 0.32f * std::sin(time * (1.2f + p.depth) + p.phase);
            ImVec4 c = PaletteColor(p.colorIdx);
            ImVec2 pos(origin.x + p.x, origin.y + p.y);
            float baseA = (0.20f + 0.52f * p.depth) * twinkle;

            // Soft outer halo
            dl->AddCircleFilled(pos, p.radius * 3.1f,
                                ImGui::ColorConvertFloat4ToU32(ImVec4(c.x, c.y, c.z, baseA * 0.14f)), 14);
            // Mid glow
            dl->AddCircleFilled(pos, p.radius * 1.7f,
                                ImGui::ColorConvertFloat4ToU32(ImVec4(c.x, c.y, c.z, baseA * 0.36f)), 12);
            // Crisp bright core
            dl->AddCircleFilled(pos, p.radius,
                                ImGui::ColorConvertFloat4ToU32(ImVec4(
                                    std::min(1.0f, c.x + 0.32f),
                                    std::min(1.0f, c.y + 0.32f),
                                    std::min(1.0f, c.z + 0.32f),
                                    baseA)),
                                10);
        }

        // 7. Update & Render Interactive Click/Launch Burst Sparks
        for (size_t i = 0; i < sparks_.size();) {
            auto& s = sparks_[i];
            s.life += dt;
            if (s.life >= s.maxLife) {
                sparks_[i] = sparks_.back();
                sparks_.pop_back();
                continue;
            }
            float drag = std::exp(-3.4f * dt);
            s.vx *= drag;
            s.vy *= drag;
            s.vy += 40.0f * dt;
            s.x += s.vx * dt;
            s.y += s.vy * dt;

            float rem = 1.0f - (s.life / s.maxLife);
            float a = rem * rem;
            ImVec2 p(s.x, s.y);
            dl->AddCircleFilled(p, s.radius * 2.5f * rem,
                                ImGui::ColorConvertFloat4ToU32(ImVec4(s.color.x, s.color.y, s.color.z, a * 0.25f)), 10);
            dl->AddCircleFilled(p, s.radius * rem,
                                ImGui::ColorConvertFloat4ToU32(ImVec4(s.color.x, s.color.y, s.color.z, a * 0.92f)), 10);
            ++i;
        }
    }

private:
    static constexpr int kParticleCount = 96;

    struct Particle {
        float x, y;
        float vx, vy;
        float baseVx, baseVy;
        float depth;
        float radius;
        float phase;
        int colorIdx;
    };

    struct BurstSpark {
        float x, y;
        float vx, vy;
        float life, maxLife;
        float radius;
        ImVec4 color;
    };

    float w_ = 1140.0f;
    float h_ = 700.0f;
    bool initialized_ = false;
    uint32_t rng_ = 0x56494345u;
    std::vector<Particle> particles_;
    std::vector<BurstSpark> sparks_;

    float Rand01() {
        rng_ ^= rng_ << 13;
        rng_ ^= rng_ >> 17;
        rng_ ^= rng_ << 5;
        return static_cast<float>(rng_ & 0x00FFFFFFu) / static_cast<float>(0x01000000u);
    }

    float RandRange(float a, float b) { return a + (b - a) * Rand01(); }

    static ImVec4 PaletteColor(int idx) {
        switch (idx) {
            case 0: return ImVec4(0.13f, 0.90f, 0.52f, 1.0f); // Xbox Series X Emerald
            case 1: return ImVec4(0.05f, 0.88f, 1.00f, 1.0f); // Cyber Cyan
            default: return ImVec4(1.00f, 0.22f, 0.60f, 1.0f); // Vice City Magenta
        }
    }

    static void DrawSoftGlow(ImDrawList* dl, ImVec2 center, float radius, ImVec4 col) {
        constexpr int kRings = 7;
        for (int i = kRings; i >= 1; --i) {
            float t = static_cast<float>(i) / static_cast<float>(kRings);
            float r = radius * t;
            float a = col.w * (1.0f - t * 0.82f) * (1.0f / static_cast<float>(kRings)) * 2.4f;
            dl->AddCircleFilled(center, r,
                                ImGui::ColorConvertFloat4ToU32(ImVec4(col.x, col.y, col.z, a)), 44);
        }
    }

    static void DrawHorizonGrid(ImDrawList* dl, ImVec2 origin, float w, float h, float time) {
        const float topY = origin.y + h * 0.75f;
        const float botY = origin.y + h;
        const float midX = origin.x + w * 0.5f;

        // Horizontal perspective lines scrolling subtly downward
        const float scroll = std::fmod(time * 0.22f, 1.0f);
        for (int i = 0; i < 8; ++i) {
            float u = (static_cast<float>(i) + scroll) / 8.0f;
            float y = topY + (botY - topY) * (u * u);
            float a = u * 0.065f;
            dl->AddLine(ImVec2(origin.x, y), ImVec2(origin.x + w, y),
                        ImGui::ColorConvertFloat4ToU32(ImVec4(0.25f, 0.82f, 0.95f, a)), 1.0f);
        }

        // Perspective radiating floor lines
        for (int i = -8; i <= 8; ++i) {
            float topX = midX + static_cast<float>(i) * (w * 0.045f);
            float botX = midX + static_cast<float>(i) * (w * 0.145f);
            float edgeFade = 1.0f - std::min(1.0f, std::abs(static_cast<float>(i)) / 9.5f);
            dl->AddLine(ImVec2(topX, topY), ImVec2(botX, botY),
                        ImGui::ColorConvertFloat4ToU32(ImVec4(0.18f, 0.85f, 0.65f, 0.045f * edgeFade)), 1.0f);
        }
    }
};

} // namespace vicebox
