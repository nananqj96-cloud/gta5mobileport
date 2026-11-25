#pragma once

#include "imgui.h"
#include "sound_engine.h"
#include <algorithm>
#include <cmath>
#include <string>

namespace vicebox {

// ==================== SMOOTH FRAME-RATE-INDEPENDENT EASING ====================
inline float ExpLerp(float current, float target, float speed, float dt) {
    float f = 1.0f - std::exp(-speed * std::clamp(dt, 0.0005f, 0.05f));
    return current + (target - current) * f;
}

inline float EaseOutCubic(float t) {
    t = std::clamp(t, 0.0f, 1.0f);
    float u = 1.0f - t;
    return 1.0f - u * u * u;
}

inline ImU32 ColAlpha(ImVec4 c, float alphaMult) {
    c.w = std::clamp(c.w * alphaMult, 0.0f, 1.0f);
    return ImGui::ColorConvertFloat4ToU32(c);
}

inline ImVec4 LerpColor(ImVec4 a, ImVec4 b, float t) {
    t = std::clamp(t, 0.0f, 1.0f);
    return ImVec4(
        a.x + (b.x - a.x) * t,
        a.y + (b.y - a.y) * t,
        a.z + (b.z - a.z) * t,
        a.w + (b.w - a.w) * t);
}

// ==================== BRAND PALETTE ====================
namespace Palette {
    inline constexpr ImVec4 Emerald     = ImVec4(0.10f, 0.86f, 0.48f, 1.0f); // Xbox Series X Emerald
    inline constexpr ImVec4 EmeraldDeep = ImVec4(0.05f, 0.54f, 0.30f, 1.0f);
    inline constexpr ImVec4 Cyan        = ImVec4(0.04f, 0.88f, 1.00f, 1.0f); // Cyber Neon Cyan
    inline constexpr ImVec4 VicePink    = ImVec4(1.00f, 0.20f, 0.58f, 1.0f); // Vice City Magenta
    inline constexpr ImVec4 ViceOrange  = ImVec4(1.00f, 0.54f, 0.22f, 1.0f); // Leonida Sunset
    inline constexpr ImVec4 GlassBg     = ImVec4(0.062f, 0.082f, 0.135f, 0.86f);
    inline constexpr ImVec4 GlassDeep   = ImVec4(0.043f, 0.058f, 0.102f, 0.92f);
    inline constexpr ImVec4 TextHi      = ImVec4(0.96f, 0.98f, 1.00f, 1.0f);
    inline constexpr ImVec4 TextMid     = ImVec4(0.62f, 0.69f, 0.80f, 1.0f);
    inline constexpr ImVec4 TextDim     = ImVec4(0.42f, 0.48f, 0.58f, 1.0f);
    inline constexpr ImVec4 BorderSub   = ImVec4(1.00f, 1.00f, 1.00f, 0.09f);
}

// ==================== VECTOR LOGO: VICEBOX X ====================
inline void DrawViceBoxLogo(ImDrawList* dl, ImVec2 center, float radius, float time, float alpha = 1.0f) {
    // Soft emerald/magenta radial halo behind mark
    dl->AddCircleFilled(center, radius * 1.65f, ColAlpha(ImVec4(0.08f, 0.85f, 0.52f, 0.12f), alpha), 28);
    dl->AddCircleFilled(center, radius * 1.25f, ColAlpha(ImVec4(0.05f, 0.86f, 1.00f, 0.14f), alpha), 24);

    // Dark obsidian disc
    dl->AddCircleFilled(center, radius, ColAlpha(ImVec4(0.05f, 0.07f, 0.12f, 0.96f), alpha), 28);

    // Subtle animated neon ring arc
    float a0 = time * 0.75f;
    dl->PathArcTo(center, radius * 0.92f, a0, a0 + 2.4f, 24);
    dl->PathStroke(ColAlpha(Palette::Emerald, 0.85f * alpha), 0, radius * 0.11f);
    dl->PathArcTo(center, radius * 0.92f, a0 + 3.14159f, a0 + 3.14159f + 2.2f, 24);
    dl->PathStroke(ColAlpha(Palette::VicePink, 0.85f * alpha), 0, radius * 0.11f);

    // Outer subtle rim
    dl->AddCircle(center, radius, ColAlpha(ImVec4(1.0f, 1.0f, 1.0f, 0.16f), alpha), 28, 1.0f);

    // Crisp X strokes inside disc
    float d = radius * 0.44f;
    float thick = std::max(2.0f, radius * 0.21f);
    dl->AddLine(ImVec2(center.x - d, center.y - d), ImVec2(center.x + d, center.y + d),
                ColAlpha(Palette::Emerald, alpha), thick);
    dl->AddLine(ImVec2(center.x + d, center.y - d), ImVec2(center.x - d, center.y + d),
                ColAlpha(Palette::VicePink, alpha), thick);
    dl->AddCircleFilled(center, thick * 0.55f, ColAlpha(ImVec4(0.92f, 0.99f, 1.0f, 0.95f), alpha), 12);
}

// ==================== SPINNING DUAL-ARC NEON LOADER ====================
inline void DrawSpinnerRing(ImDrawList* dl, ImVec2 center, float radius, float thickness,
                            float time, ImVec4 colA, ImVec4 colB, float alpha = 1.0f) {
    dl->AddCircle(center, radius, ColAlpha(ImVec4(1.0f, 1.0f, 1.0f, 0.08f), alpha), 44, thickness);

    float rot1 = time * 3.2f;
    dl->PathArcTo(center, radius, rot1, rot1 + 2.15f, 32);
    dl->PathStroke(ColAlpha(colA, alpha), 0, thickness);

    float rot2 = -time * 2.1f + 1.2f;
    dl->PathArcTo(center, radius * 0.72f, rot2, rot2 + 1.85f, 26);
    dl->PathStroke(ColAlpha(colB, 0.85f * alpha), 0, thickness * 0.75f);

    // Soft center glow pulse
    float pulse = 0.55f + 0.45f * std::sin(time * 4.5f);
    dl->AddCircleFilled(center, radius * 0.24f, ColAlpha(colA, 0.20f * pulse * alpha), 18);
}

// ==================== FROSTED OBSIDIAN GLASS CARD ====================
inline void DrawGlassCard(ImDrawList* dl, ImVec2 pMin, ImVec2 pMax, float rounding,
                          ImVec4 accentCol, float hoverT, float alpha = 1.0f, bool disabled = false) {
    // Soft ambient under-shadow
    dl->AddRectFilled(
        ImVec2(pMin.x - 4.0f, pMin.y + 6.0f),
        ImVec2(pMax.x + 4.0f, pMax.y + 10.0f),
        ColAlpha(ImVec4(0.0f, 0.0f, 0.0f, 0.42f + 0.14f * hoverT), alpha),
        rounding + 4.0f);

    // Subtle colored outer halo on hover
    if (hoverT > 0.01f) {
        dl->AddRect(
            ImVec2(pMin.x - 2.0f, pMin.y - 2.0f),
            ImVec2(pMax.x + 2.0f, pMax.y + 2.0f),
            ColAlpha(accentCol, (disabled ? 0.16f : 0.28f) * hoverT * alpha),
            rounding + 2.0f, 0, 3.0f);
    }

    // Main frosted dark glass fill
    ImVec4 bgTop = disabled ? ImVec4(0.055f, 0.062f, 0.100f, 0.82f) : ImVec4(0.066f, 0.088f, 0.145f, 0.88f);
    ImVec4 bgBot = disabled ? ImVec4(0.042f, 0.048f, 0.078f, 0.90f) : ImVec4(0.045f, 0.060f, 0.105f, 0.94f);
    dl->AddRectFilled(pMin, pMax, ColAlpha(LerpColor(bgTop, bgBot, 0.5f), alpha), rounding);

    // Subtle top accent tint wash
    dl->AddRectFilledMultiColor(
        ImVec2(pMin.x + 1.0f, pMin.y + 1.0f),
        ImVec2(pMax.x - 1.0f, pMin.y + 72.0f),
        ColAlpha(accentCol, (0.06f + 0.08f * hoverT) * alpha),
        ColAlpha(accentCol, (0.03f + 0.05f * hoverT) * alpha),
        ColAlpha(accentCol, 0.0f),
        ColAlpha(accentCol, 0.0f));

    // Crisp hairline border with smooth hover accent transition
    ImVec4 borderCol = LerpColor(ImVec4(1.0f, 1.0f, 1.0f, 0.10f), accentCol, 0.22f + 0.55f * hoverT);
    dl->AddRect(pMin, pMax, ColAlpha(borderCol, alpha), rounding, 0, 1.0f + 0.5f * hoverT);

    // Top specular glass highlight
    dl->AddLine(
        ImVec2(pMin.x + rounding, pMin.y + 1.0f),
        ImVec2(pMax.x - rounding, pMin.y + 1.0f),
        ColAlpha(ImVec4(1.0f, 1.0f, 1.0f, 0.14f + 0.14f * hoverT), alpha),
        1.0f);
}

// ==================== VECTOR SCENE ART: GTA V (LOS SANTOS TWILIGHT) ====================
inline void DrawGta5BannerArt(ImDrawList* dl, ImVec2 pMin, ImVec2 pMax, float time, float hoverT, float alpha) {
    dl->PushClipRect(pMin, pMax, true);
    float w = pMax.x - pMin.x;
    float h = pMax.y - pMin.y;

    // Twilight Emerald-Navy sky gradient
    dl->AddRectFilledMultiColor(
        pMin, pMax,
        ColAlpha(ImVec4(0.04f, 0.16f, 0.15f, 1.0f), alpha),
        ColAlpha(ImVec4(0.05f, 0.11f, 0.22f, 1.0f), alpha),
        ColAlpha(ImVec4(0.04f, 0.07f, 0.12f, 1.0f), alpha),
        ColAlpha(ImVec4(0.07f, 0.22f, 0.18f, 1.0f), alpha));

    // Glowing emerald horizon orb (Vinewood sunset glow)
    ImVec2 sunPos(pMin.x + w * 0.72f, pMin.y + h * (0.56f - 0.03f * hoverT));
    for (int i = 5; i >= 1; --i) {
        float r = h * (0.16f * i);
        dl->AddCircleFilled(sunPos, r,
                            ColAlpha(ImVec4(0.12f, 0.88f, 0.54f, 0.055f + 0.025f * hoverT), alpha), 32);
    }
    dl->AddCircleFilled(sunPos, h * 0.22f, ColAlpha(ImVec4(0.32f, 0.96f, 0.68f, 0.28f), alpha), 32);

    // Stylized Los Santos Downtown skyline silhouettes (Maze Bank tower + skyscrapers)
    const float baseY = pMax.y;
    const float bldgs[][3] = {
        {0.05f, 0.07f, 0.34f}, {0.13f, 0.06f, 0.48f}, {0.20f, 0.08f, 0.28f},
        {0.31f, 0.07f, 0.54f}, {0.39f, 0.09f, 0.72f}, // Maze Bank spire
        {0.49f, 0.07f, 0.46f}, {0.57f, 0.08f, 0.36f}, {0.78f, 0.07f, 0.42f}, {0.86f, 0.08f, 0.30f}
    };
    for (const auto& b : bldgs) {
        float bx0 = pMin.x + w * b[0];
        float bx1 = bx0 + w * b[1];
        float by0 = baseY - h * b[2];
        dl->AddRectFilled(ImVec2(bx0, by0), ImVec2(bx1, baseY),
                          ColAlpha(ImVec4(0.03f, 0.05f, 0.09f, 0.92f), alpha), 2.0f);
        // Subtle glowing window highlight bar
        dl->AddLine(ImVec2(bx0 + 2.0f, by0 + 2.0f), ImVec2(bx1 - 2.0f, by0 + 2.0f),
                    ColAlpha(Palette::Emerald, (0.28f + 0.22f * hoverT) * alpha), 1.5f);
    }

    // Animated diagonal light sweep across banner on hover
    float sweepX = pMin.x + std::fmod(time * 95.0f, w + 180.0f) - 90.0f;
    dl->AddQuadFilled(
        ImVec2(sweepX, pMin.y), ImVec2(sweepX + 46.0f, pMin.y),
        ImVec2(sweepX - 24.0f, pMax.y), ImVec2(sweepX - 70.0f, pMax.y),
        ColAlpha(ImVec4(0.45f, 1.0f, 0.78f, (0.04f + 0.05f * hoverT) * alpha), 1.0f));

    // Bottom fade into card body
    dl->AddRectFilledMultiColor(
        ImVec2(pMin.x, pMin.y + h * 0.58f), pMax,
        ColAlpha(ImVec4(0.05f, 0.07f, 0.12f, 0.0f), alpha),
        ColAlpha(ImVec4(0.05f, 0.07f, 0.12f, 0.0f), alpha),
        ColAlpha(ImVec4(0.05f, 0.07f, 0.12f, 0.95f), alpha),
        ColAlpha(ImVec4(0.05f, 0.07f, 0.12f, 0.95f), alpha));

    dl->PopClipRect();
}

// ==================== VECTOR SCENE ART: GTA VI (CYBERLEEKS VICE NEON SUNSET) ====================
inline void DrawGta6BannerArt(ImDrawList* dl, ImVec2 pMin, ImVec2 pMax, float time, float hoverT, float alpha) {
    dl->PushClipRect(pMin, pMax, true);
    float w = pMax.x - pMin.x;
    float h = pMax.y - pMin.y;

    // Vice City Neon Twilight Sky (Deep Violet -> Sunset Magenta -> Cyan Horizon)
    dl->AddRectFilledMultiColor(
        pMin, pMax,
        ColAlpha(ImVec4(0.11f, 0.05f, 0.20f, 1.0f), alpha),
        ColAlpha(ImVec4(0.24f, 0.06f, 0.22f, 1.0f), alpha),
        ColAlpha(ImVec4(0.05f, 0.14f, 0.22f, 1.0f), alpha),
        ColAlpha(ImVec4(0.20f, 0.07f, 0.18f, 1.0f), alpha));

    // Iconic Vice Sunset Sun with retro-futuristic horizontal scanline slices
    ImVec2 sunPos(pMin.x + w * 0.68f, pMin.y + h * (0.50f - 0.02f * hoverT));
    float sunR = h * 0.30f;
    for (int i = 4; i >= 1; --i) {
        dl->AddCircleFilled(sunPos, sunR * (0.85f + 0.42f * i),
                            ColAlpha(ImVec4(1.0f, 0.22f, 0.56f, 0.06f), alpha), 36);
    }
    dl->AddCircleFilled(sunPos, sunR, ColAlpha(ImVec4(1.0f, 0.36f, 0.58f, 0.72f), alpha), 36);
    dl->AddCircleFilled(ImVec2(sunPos.x, sunPos.y - sunR * 0.18f), sunR * 0.75f,
                        ColAlpha(ImVec4(1.0f, 0.64f, 0.26f, 0.52f), alpha), 32);

    // Crisp horizontal synthwave slices cutting lower half of the sun
    for (int s = 0; s < 4; ++s) {
        float sy = sunPos.y + sunR * (0.14f + 0.22f * s);
        float sh = 2.0f + s * 1.1f;
        dl->AddRectFilled(ImVec2(sunPos.x - sunR - 4.0f, sy),
                          ImVec2(sunPos.x + sunR + 4.0f, sy + sh),
                          ColAlpha(ImVec4(0.10f, 0.05f, 0.16f, 0.85f), alpha));
    }

    // Stylized Vice Beach Palm Tree Silhouette on the right
    ImVec2 trunkBase(pMin.x + w * 0.86f, pMax.y);
    ImVec2 trunkMid(pMin.x + w * 0.83f, pMin.y + h * 0.56f);
    ImVec2 trunkTop(pMin.x + w * 0.79f, pMin.y + h * 0.24f);
    ImU32 silCol = ColAlpha(ImVec4(0.04f, 0.03f, 0.08f, 0.92f), alpha);
    dl->AddLine(trunkBase, trunkMid, silCol, 6.0f);
    dl->AddLine(trunkMid, trunkTop, silCol, 4.2f);
    const float frondAngs[] = {-2.7f, -2.1f, -1.4f, -0.55f, 0.15f, 0.75f};
    for (float fa : frondAngs) {
        float sway = 0.04f * std::sin(time * 1.6f + fa);
        float len = h * 0.28f;
        ImVec2 tip(trunkTop.x + std::cos(fa + sway) * len, trunkTop.y + std::sin(fa + sway) * len + 6.0f);
        ImVec2 ctrl(trunkTop.x + std::cos(fa + sway) * len * 0.55f, trunkTop.y + std::sin(fa + sway) * len * 0.35f - 4.0f);
        dl->AddBezierQuadratic(trunkTop, ctrl, tip, silCol, 3.4f, 10);
    }

    // Subtle Leonida Ocean Beach skyline bars on the left
    const float vb[][3] = {{0.06f, 0.06f, 0.38f}, {0.13f, 0.08f, 0.52f}, {0.22f, 0.06f, 0.42f}, {0.29f, 0.07f, 0.30f}};
    for (const auto& b : vb) {
        float x0 = pMin.x + w * b[0], x1 = x0 + w * b[1], y0 = pMax.y - h * b[2];
        dl->AddRectFilled(ImVec2(x0, y0), ImVec2(x1, pMax.y), silCol, 2.0f);
        dl->AddLine(ImVec2(x0 + 2.0f, y0 + 2.0f), ImVec2(x1 - 2.0f, y0 + 2.0f),
                    ColAlpha(Palette::Cyan, 0.38f * alpha), 1.5f);
    }

    // Subtle frosted dimming veil (because module is locked/disabled)
    dl->AddRectFilled(pMin, pMax, ColAlpha(ImVec4(0.04f, 0.04f, 0.08f, 0.30f), alpha));

    // Bottom fade into card body
    dl->AddRectFilledMultiColor(
        ImVec2(pMin.x, pMin.y + h * 0.58f), pMax,
        ColAlpha(ImVec4(0.05f, 0.05f, 0.09f, 0.0f), alpha),
        ColAlpha(ImVec4(0.05f, 0.05f, 0.09f, 0.0f), alpha),
        ColAlpha(ImVec4(0.05f, 0.05f, 0.09f, 0.96f), alpha),
        ColAlpha(ImVec4(0.05f, 0.05f, 0.09f, 0.96f), alpha));

    dl->PopClipRect();
}

// ==================== SMOOTH ANIMATED NEON BUTTON ====================
inline bool DrawNeonButton(const char* id, const char* label, ImVec2 size,
                           ImVec4 colA, ImVec4 colB, float& hoverState, float dt,
                           SoundEngine& sfx, bool disabled = false, float alpha = 1.0f,
                           ImVec2* outCenter = nullptr) {
    ImVec2 pos = ImGui::GetCursorScreenPos();
    if (outCenter) *outCenter = ImVec2(pos.x + size.x * 0.5f, pos.y + size.y * 0.5f);

    bool clicked = ImGui::InvisibleButton(id, size);
    bool hovered = ImGui::IsItemHovered();
    bool focused = ImGui::IsItemFocused();
    bool active = ImGui::IsItemActive();

    if ((hovered || focused) && hoverState < 0.06f && !disabled) {
        sfx.Play(SfxId::Hover, 0.55f);
    }
    hoverState = ExpLerp(hoverState, (hovered || focused) ? 1.0f : 0.0f, 13.0f, dt);

    ImDrawList* dl = ImGui::GetWindowDrawList();
    float pressInset = active ? 1.5f : 0.0f;
    ImVec2 p0(pos.x + pressInset, pos.y + pressInset);
    ImVec2 p1(pos.x + size.x - pressInset, pos.y + size.y - pressInset);
    float rounding = 10.0f;

    if (disabled) {
        dl->AddRectFilled(p0, p1, ColAlpha(ImVec4(0.11f, 0.13f, 0.19f, 0.78f), alpha), rounding);
        dl->AddRect(p0, p1, ColAlpha(ImVec4(1.0f, 0.25f, 0.58f, 0.25f + 0.22f * hoverState), alpha), rounding, 0, 1.0f);
    } else {
        // Outer glow bloom on hover or controller focus
        if (hoverState > 0.02f) {
            dl->AddRectFilled(
                ImVec2(p0.x - 4.0f, p0.y - 3.0f),
                ImVec2(p1.x + 4.0f, p1.y + 4.0f),
                ColAlpha(colA, 0.20f * hoverState * alpha),
                rounding + 4.0f);
        }

        // Smooth horizontal gradient fill
        ImVec4 cLeft  = LerpColor(colA, ImVec4(std::min(1.0f, colA.x + 0.14f), std::min(1.0f, colA.y + 0.14f), std::min(1.0f, colA.z + 0.14f), 1.0f), hoverState);
        ImVec4 cRight = LerpColor(colB, ImVec4(std::min(1.0f, colB.x + 0.14f), std::min(1.0f, colB.y + 0.14f), std::min(1.0f, colB.z + 0.14f), 1.0f), hoverState);
        dl->PushClipRect(p0, p1, true);
        dl->AddRectFilledMultiColor(p0, p1,
                                    ColAlpha(cLeft, alpha), ColAlpha(cRight, alpha),
                                    ColAlpha(cRight, alpha), ColAlpha(cLeft, alpha));
        dl->PopClipRect();

        // Crisp rounded inner rim + top specular shine
        dl->AddRect(p0, p1, ColAlpha(ImVec4(1.0f, 1.0f, 1.0f, 0.22f + 0.25f * hoverState), alpha), rounding, 0, 1.0f);
        dl->AddLine(ImVec2(p0.x + rounding, p0.y + 1.0f), ImVec2(p1.x - rounding, p0.y + 1.0f),
                    ColAlpha(ImVec4(1.0f, 1.0f, 1.0f, 0.35f), alpha), 1.0f);
    }

    if (focused) {
        dl->AddRect(ImVec2(p0.x - 2.5f, p0.y - 2.5f), ImVec2(p1.x + 2.5f, p1.y + 2.5f),
                    ColAlpha(Palette::Cyan, 0.95f * alpha), rounding + 2.0f, 0, 2.2f);
    }

    // Centered crisp label
    ImVec2 textSize = ImGui::CalcTextSize(label);
    ImVec2 textPos(pos.x + (size.x - textSize.x) * 0.5f, pos.y + (size.y - textSize.y) * 0.5f);
    ImVec4 txtCol = disabled ? ImVec4(0.60f, 0.64f, 0.74f, 0.85f) : ImVec4(0.99f, 1.0f, 1.0f, 1.0f);
    dl->AddText(textPos, ColAlpha(txtCol, alpha), label);

    if (clicked) {
        if (disabled) sfx.Play(SfxId::Locked, 0.85f);
        else sfx.Play(SfxId::Click, 0.90f);
    }
    return clicked;
}

// ==================== SMALL PILL BADGE ====================
inline void DrawStatusPill(ImDrawList* dl, ImVec2 pos, const char* text, ImVec4 accentCol, float alpha = 1.0f, bool dot = true) {
    ImVec2 ts = ImGui::CalcTextSize(text);
    float padX = 10.0f;
    float dotSpace = dot ? 13.0f : 0.0f;
    float w = ts.x + padX * 2.0f + dotSpace;
    float h = ts.y + 8.0f;
    ImVec2 p1(pos.x + w, pos.y + h);

    dl->AddRectFilled(pos, p1, ColAlpha(ImVec4(accentCol.x * 0.22f, accentCol.y * 0.22f, accentCol.z * 0.22f, 0.78f), alpha), h * 0.5f);
    dl->AddRect(pos, p1, ColAlpha(accentCol, 0.50f * alpha), h * 0.5f, 0, 1.0f);

    if (dot) {
        ImVec2 dc(pos.x + padX + 3.5f, pos.y + h * 0.5f);
        dl->AddCircleFilled(dc, 5.0f, ColAlpha(accentCol, 0.28f * alpha), 12);
        dl->AddCircleFilled(dc, 2.8f, ColAlpha(accentCol, alpha), 12);
    }
    dl->AddText(ImVec2(pos.x + padX + dotSpace, pos.y + 4.0f), ColAlpha(Palette::TextHi, alpha), text);
}

} // namespace vicebox
