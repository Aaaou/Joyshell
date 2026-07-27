import { listen } from "@tauri-apps/api/event";
import { useEffect } from "react";
import type { SessionInfo, SftpProgress } from "../types";
import type { SessionEvent } from "../shared/events/session-events";
import { isDesktopRuntime } from "./desktop-client";

export type SessionEventHandlers = {
  onStateChanged: (sessionId: string, state: SessionInfo["state"]) => void;
  onTerminalOutput: (sessionId: string, data: string) => void;
  onSftpProgress: (progress: SftpProgress) => void;
};

export function useSessionEvents({ onStateChanged, onTerminalOutput, onSftpProgress }: SessionEventHandlers) {
  useEffect(() => {
    if (!isDesktopRuntime) {
      return;
    }
    let unlisten: (() => void) | undefined;
    void listen<SessionEvent>("session:event", (event) => {
      const payload = event.payload;
      if ("StateChanged" in payload) {
        onStateChanged(payload.StateChanged.session_id, payload.StateChanged.state);
        return;
      }
      if ("TerminalOutput" in payload) {
        onTerminalOutput(payload.TerminalOutput.session_id, payload.TerminalOutput.data);
        return;
      }
      if ("SftpProgress" in payload) {
        onSftpProgress(payload.SftpProgress);
      }
    }).then((dispose) => {
      unlisten = dispose;
    });
    return () => {
      unlisten?.();
    };
  }, [onSftpProgress, onStateChanged, onTerminalOutput]);
}
