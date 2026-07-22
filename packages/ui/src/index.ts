export type ThemeMode = "dark" | "light";

export type ThemeToken = {
  name: string;
  mode: ThemeMode;
  colors: {
    app: string;
    panel: string;
    panelRaised: string;
    border: string;
    text: string;
    muted: string;
    accent: string;
    accentSoft: string;
    terminalBackground: string;
    terminalForeground: string;
    danger: string;
    warning: string;
    success: string;
  };
};

export const defaultTheme: ThemeToken = {
  name: "Joyshell Graphite",
  mode: "dark",
  colors: {
    app: "#15181c",
    panel: "#1c2026",
    panelRaised: "#242932",
    border: "#343b46",
    text: "#eef2f6",
    muted: "#9ca8b7",
    accent: "#4fb3ff",
    accentSoft: "#19354a",
    terminalBackground: "#101317",
    terminalForeground: "#e8edf4",
    danger: "#ff6b6b",
    warning: "#f2c94c",
    success: "#4fd18b"
  }
};

export function applyTheme(theme: ThemeToken, root: HTMLElement = document.documentElement) {
  root.dataset.themeMode = theme.mode;
  for (const [key, value] of Object.entries(theme.colors)) {
    root.style.setProperty(`--joy-${toKebabCase(key)}`, value);
  }
}

function toKebabCase(value: string) {
  return value.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`);
}
