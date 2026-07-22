import { FitAddon } from "@xterm/addon-fit";
import { SearchAddon } from "@xterm/addon-search";
import { WebLinksAddon } from "@xterm/addon-web-links";
import { Terminal } from "@xterm/xterm";
import "@xterm/xterm/css/xterm.css";
import type { KeyboardEvent } from "react";
import { useEffect, useRef } from "react";

export type JoyTerminalHandle = {
  write(data: string): void;
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

export function JoyTerminal({
  id,
  initialOutput,
  fontFamily = "Cascadia Mono, JetBrains Mono, Consolas, monospace",
  fontSize = 13,
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
      fontFamily,
      fontSize,
      scrollback: 10_000,
      theme: {
        background: "#0e1c26",
        foreground: "#e9f1f7",
        cursor: "#62b6ff",
        selectionBackground: "rgba(79, 179, 255, 0.28)"
      }
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
  }, [fontFamily, fontSize, id, initialOutput]);

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
