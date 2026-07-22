import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import type { KeyboardEvent } from "react";
import { useEffect, useRef } from "react";

export type JoyTerminalHandle = {
  write(data: string): void;
  replace(data: string): void;
  focus(): void;
  fit(): void;
  clear(): void;
  getSelection(): string;
  selectAll(): void;
};

export type JoyTerminalProps = {
  id: string;
  initialOutput?: string;
  fontFamily?: string;
  fontSize?: number;
  onInput?: (data: string) => void;
  onReady?: (terminal: JoyTerminalHandle) => void;
};

function keyEventToTerminalData(event: KeyboardEvent<HTMLDivElement>) {
  if (event.ctrlKey || event.metaKey || event.altKey) {
    return null;
  }

  switch (event.key) {
    case "Enter":
      return "\r";
    case "Backspace":
      return "\x7f";
    case "Tab":
      return "\t";
    case "Escape":
      return "\x1b";
    case "ArrowUp":
      return "\x1b[A";
    case "ArrowDown":
      return "\x1b[B";
    case "ArrowRight":
      return "\x1b[C";
    case "ArrowLeft":
      return "\x1b[D";
    case "Home":
      return "\x1b[H";
    case "End":
      return "\x1b[F";
    case "Delete":
      return "\x1b[3~";
    default:
      return event.key.length === 1 ? event.key : null;
  }
}

function readThemeColor(name: string, fallback: string) {
  if (typeof window === "undefined") {
    return fallback;
  }
  const value = window.getComputedStyle(document.documentElement).getPropertyValue(name).trim();
  return resolveCssColor(value || fallback, fallback);
}

function resolveCssColor(value: string, fallback: string) {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return fallback;
  }

  const probe = document.createElement("span");
  probe.style.position = "absolute";
  probe.style.visibility = "hidden";
  probe.style.pointerEvents = "none";
  probe.style.color = value;
  document.body.appendChild(probe);
  const resolved = window.getComputedStyle(probe).color;
  probe.remove();
  return resolved || fallback;
}

function createTerminalTheme() {
  return {
    background: readThemeColor("--joy-terminal-background", "#f7f9fb"),
    foreground: readThemeColor("--joy-terminal-foreground", "#101820"),
    cursor: readThemeColor("--joy-accent", "#1677ff"),
    selectionBackground: "rgba(22, 119, 255, 0.22)",
    black: "#111820",
    red: "#c72020",
    green: "#087a35",
    yellow: "#9a6300",
    blue: "#075fd7",
    magenta: "#8c2bb5",
    cyan: "#007a8c",
    white: "#111820",
    brightBlack: "#4e5a66",
    brightRed: "#e12929",
    brightGreen: "#0b963f",
    brightYellow: "#c07a00",
    brightBlue: "#1677ff",
    brightMagenta: "#a842d1",
    brightCyan: "#0097aa",
    brightWhite: "#05080c"
  };
}

export function JoyTerminal({
  id,
  initialOutput,
  fontFamily = "Cascadia Mono, JetBrains Mono, Consolas, Alimama FangYuanTi, Microsoft YaHei UI, monospace",
  fontSize = 13.5,
  onInput,
  onReady
}: JoyTerminalProps) {
  const hostRef = useRef<HTMLDivElement | null>(null);
  const terminalRef = useRef<Terminal | null>(null);
  const fitRef = useRef<FitAddon | null>(null);
  const onInputRef = useRef(onInput);
  const onReadyRef = useRef(onReady);

  useEffect(() => {
    onInputRef.current = onInput;
  }, [onInput]);

  useEffect(() => {
    onReadyRef.current = onReady;
  }, [onReady]);

  useEffect(() => {
    if (!hostRef.current || terminalRef.current) {
      return;
    }

    const terminal = new Terminal({
      allowProposedApi: false,
      convertEol: true,
      cursorBlink: true,
      drawBoldTextInBrightColors: false,
      fontFamily,
      fontSize,
      minimumContrastRatio: 7,
      scrollback: 10_000,
      theme: createTerminalTheme()
    });
    const fit = new FitAddon();
    terminal.loadAddon(fit);
    terminal.loadAddon(new SearchAddon());
    terminal.loadAddon(new WebLinksAddon());
    const host = hostRef.current;
    terminal.open(host);
    fit.fit();
    terminal.write(initialOutput ?? "Joyshell terminal ready.\r\n");
    window.setTimeout(() => {
      fit.fit();
      terminal.focus();
    }, 0);
    const inputDisposable = terminal.onData((data) => onInputRef.current?.(data));

    terminalRef.current = terminal;
    fitRef.current = fit;
    onReadyRef.current?.({
      write: (data) => terminal.write(data),
      replace: (data) => {
        terminal.options.theme = createTerminalTheme();
        terminal.reset();
        terminal.write(data);
      },
      focus: () => terminal.focus(),
      fit: () => fit.fit(),
      clear: () => terminal.clear(),
      getSelection: () => terminal.getSelection(),
      selectAll: () => terminal.selectAll()
    });

    const resizeObserver = new ResizeObserver(() => fit.fit());
    resizeObserver.observe(host);

    return () => {
      resizeObserver.disconnect();
      inputDisposable.dispose();
      terminal.dispose();
      terminalRef.current = null;
      fitRef.current = null;
    };
  }, [fontFamily, fontSize]);

  return (
    <div
      className="joy-terminal"
      ref={hostRef}
      tabIndex={0}
      onKeyDownCapture={(event) => {
        if (event.target instanceof HTMLTextAreaElement) {
          return;
        }

        const data = keyEventToTerminalData(event);
        if (!data) {
          return;
        }

        event.preventDefault();
        terminalRef.current?.focus();
        onInputRef.current?.(data);
      }}
      onMouseDown={() => terminalRef.current?.focus()}
      onClick={() => terminalRef.current?.focus()}
    />
  );
}
