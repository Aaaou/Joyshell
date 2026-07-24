import type { Monitor } from "@tauri-apps/api/window";
import type { ChromeGradientPreset } from "../types";

export type ChromeGradientPresetDefinition = {
  id: ChromeGradientPreset;
  name: string;
  description: string;
  stops: [string, string, string];
  glow: string;
  hues: [number, number, number];
};

function clamp01(value: number) {
  return Math.max(0, Math.min(1, value));
}

function hexToRgb(hex: string) {
  const normalized = hex.replace("#", "");
  const value = normalized.length === 3
    ? normalized.split("").map((part) => part + part).join("")
    : normalized;
  const parsed = Number.parseInt(value, 16);
  return {
    r: (parsed >> 16) & 0xff,
    g: (parsed >> 8) & 0xff,
    b: parsed & 0xff
  };
}

function rgbToHex(r: number, g: number, b: number) {
  return `#${[r, g, b].map((value) => Math.max(0, Math.min(255, Math.round(value))).toString(16).padStart(2, "0")).join("")}`;
}

function mixHexColors(source: string, target: string, amount: number) {
  const from = hexToRgb(source);
  const to = hexToRgb(target);
  const mix = clamp01(amount);
  return rgbToHex(
    from.r + (to.r - from.r) * mix,
    from.g + (to.g - from.g) * mix,
    from.b + (to.b - from.b) * mix
  );
}

export const CHROME_GRADIENT_PRESETS: ChromeGradientPresetDefinition[] = [
  {
    id: "codex_cyan",
    name: "Codex Soft",
    description: "参考 Codex 的浅粉紫柔和渐变。",
    stops: ["#E4EEF8", "#F0E7F5", "#FBE3E9"],
    glow: "rgba(238, 188, 202, 0.52)",
    hues: [210, 324, 356]
  },
  {
    id: "cool_blues",
    name: "Cool Blues",
    description: "更稳的浅蓝过渡。",
    stops: ["#E3FAFF", "#CFEFFF", "#B9D8FF"],
    glow: "rgba(125, 208, 244, 0.18)",
    hues: [185, 198, 214]
  },
  {
    id: "green_beach",
    name: "Green Beach",
    description: "青绿到海蓝，偏清爽。",
    stops: ["#E7FFF8", "#D0F8ED", "#BEEBE6"],
    glow: "rgba(131, 228, 212, 0.18)",
    hues: [162, 174, 188]
  },
  {
    id: "slight_ocean_view",
    name: "Slight Ocean View",
    description: "蓝紫更柔和一点。",
    stops: ["#F1F4FF", "#DDE5FF", "#C7D3FF"],
    glow: "rgba(185, 195, 255, 0.16)",
    hues: [224, 238, 252]
  },
  {
    id: "perfect_blue",
    name: "Perfect Blue",
    description: "偏深蓝，适合低亮度。",
    stops: ["#ECF3FF", "#D4E2FF", "#B7CAFF"],
    glow: "rgba(166, 191, 255, 0.16)",
    hues: [212, 224, 238]
  }
];

function resolveChromeGradientPreset(presetId: string | null | undefined) {
  return CHROME_GRADIENT_PRESETS.find((preset) => preset.id === presetId) ?? CHROME_GRADIENT_PRESETS[0];
}

export function applySidebarPositionGradient(
  position: { x: number; y: number },
  monitor: Monitor | null,
  windowSize?: { width: number; height: number } | null,
  presetId?: ChromeGradientPreset | null
) {
  const preset = resolveChromeGradientPreset(presetId);
  const monitorX = monitor?.position.x ?? 0;
  const monitorY = monitor?.position.y ?? 0;
  const monitorWidth = Math.max(monitor?.size.width ?? 1920, 1);
  const monitorHeight = Math.max(monitor?.size.height ?? 1080, 1);
  const windowWidth = Math.max(windowSize?.width ?? monitorWidth * 0.34, 1);
  const windowHeight = Math.max(windowSize?.height ?? monitorHeight * 0.55, 1);
  const centerX = position.x + windowWidth / 2;
  const centerY = position.y + windowHeight / 2;
  const xRatio = clamp01((centerX - monitorX) / monitorWidth);
  const yRatio = clamp01((centerY - monitorY) / monitorHeight);
  const [baseTopHue, baseMidHue, baseBottomHue] = preset.hues;
  const topHue = baseTopHue + xRatio * 8 + yRatio * 6;
  const midHue = baseMidHue + xRatio * 8 + yRatio * 6;
  const bottomHue = baseBottomHue + xRatio * 5 + yRatio * 4;
  const glowX = 10 + xRatio * 42;
  const glowY = 78 + yRatio * 16;
  const topBlend = 0.02 + (1 - yRatio) * 0.02;
  const midBlend = 0.03 + (1 - yRatio) * 0.02;
  const bottomBlend = 0.015 + xRatio * 0.015;
  const topLight = `${(94.8 - yRatio * 0.35 - xRatio * 0.15).toFixed(1)}%`;
  const midLight = `${(95.2 - yRatio * 0.35 - xRatio * 0.10).toFixed(1)}%`;
  const bottomLight = `${(96.2 - yRatio * 0.25 + xRatio * 0.08).toFixed(1)}%`;
  const glowOpacity = 0.30 + xRatio * 0.06 + yRatio * 0.08;
  const canvasWidth = Math.max(monitorWidth, windowWidth, 1);
  const canvasHeight = Math.max(monitorHeight, windowHeight, 1);
  const bgX = Math.round(monitorX - position.x);
  const bgY = Math.round(monitorY - position.y);

  document.documentElement.style.setProperty("--sidebar-top-hue", topHue.toFixed(1));
  document.documentElement.style.setProperty("--sidebar-mid-hue", midHue.toFixed(1));
  document.documentElement.style.setProperty("--sidebar-bottom-hue", bottomHue.toFixed(1));
  document.documentElement.style.setProperty("--sidebar-top-light", topLight);
  document.documentElement.style.setProperty("--sidebar-mid-light", midLight);
  document.documentElement.style.setProperty("--sidebar-bottom-light", bottomLight);
  document.documentElement.style.setProperty("--sidebar-glow-x", `${glowX.toFixed(1)}%`);
  document.documentElement.style.setProperty("--sidebar-glow-y", `${glowY.toFixed(1)}%`);
  document.documentElement.style.setProperty("--sidebar-glow-opacity", glowOpacity.toFixed(2));
  document.documentElement.style.setProperty("--chrome-gradient-stop-1", mixHexColors(preset.stops[0], "#ffffff", topBlend));
  document.documentElement.style.setProperty("--chrome-gradient-stop-2", mixHexColors(preset.stops[1], "#ffffff", midBlend));
  document.documentElement.style.setProperty("--chrome-gradient-stop-3", mixHexColors(preset.stops[2], "#ffffff", bottomBlend));
  document.documentElement.style.setProperty("--chrome-gradient-glow", preset.glow.replace(/\d*\.?\d+\)$/, `${glowOpacity.toFixed(2)})`));
  document.documentElement.style.setProperty("--chrome-bg-width", `${canvasWidth}px`);
  document.documentElement.style.setProperty("--chrome-bg-height", `${canvasHeight}px`);
  document.documentElement.style.setProperty("--chrome-bg-x", `${bgX}px`);
  document.documentElement.style.setProperty("--chrome-bg-y", `${bgY}px`);
}

export function applySidebarFallbackGradient(presetId?: ChromeGradientPreset | null) {
  applySidebarPositionGradient(
    { x: window.screenX || 0, y: window.screenY || 0 },
    null,
    { width: window.outerWidth || window.innerWidth, height: window.outerHeight || window.innerHeight },
    presetId
  );
}
