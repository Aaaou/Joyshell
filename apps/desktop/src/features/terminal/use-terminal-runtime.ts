import type { JoyTerminalHandle } from "@joyshell/terminal";
import { useCallback, useRef, useState } from "react";
import type { SessionInfo } from "../../types";
import { trimTerminalCache } from "./terminal-model";

type TerminalRuntimeOptions = {
  initialOutput: string;
  isConnected: (state: SessionInfo["state"]) => boolean;
  disconnectedReason: (state: SessionInfo["state"]) => string;
  isLatencyProbeEnabled: (profileId: string) => boolean;
  onInteractiveLatencySample: (profileId: string, elapsedMs: number) => void;
  maximumInteractiveLatencyMs: number;
};

export function useTerminalRuntime({
  initialOutput,
  isConnected,
  disconnectedReason,
  isLatencyProbeEnabled,
  onInteractiveLatencySample,
  maximumInteractiveLatencyMs
}: TerminalRuntimeOptions) {
  const [terminalSeed, setTerminalSeed] = useState(initialOutput);
  const terminalRef = useRef<JoyTerminalHandle | null>(null);
  const terminalMirrorRef = useRef(initialOutput);
  const terminalCacheRef = useRef<Record<string, string>>({ empty: initialOutput });
  const terminalDisconnectNoticeRef = useRef<Record<string, string>>({});
  const lastTerminalInputAtRef = useRef<Record<string, number>>({});
  const lastTerminalOutputAtRef = useRef<Record<string, number>>({});
  const pendingInteractiveLatencyRef = useRef<Record<string, number>>({});
  const interactiveLatencySamplesRef = useRef<Record<string, number[]>>({});

  const replaceTerminalOutput = useCallback((data: string, activeProfileId: string | null, profileId?: string | null) => {
    const cacheKey = profileId ?? activeProfileId ?? "empty";
    const next = trimTerminalCache(data);
    terminalCacheRef.current[cacheKey] = next;
    if (cacheKey === (activeProfileId ?? "empty")) {
      terminalMirrorRef.current = next;
      setTerminalSeed(next);
      terminalRef.current?.replace(next);
    }
  }, []);

  const appendTerminalOutput = useCallback((data: string, activeProfileId: string | null, profileId?: string | null) => {
    const cacheKey = profileId ?? activeProfileId ?? "empty";
    const now = Date.now();
    lastTerminalOutputAtRef.current[cacheKey] = now;
    const pendingStartedAt = pendingInteractiveLatencyRef.current[cacheKey];
    if (isLatencyProbeEnabled(cacheKey) && pendingStartedAt && data) {
      const elapsed = now - pendingStartedAt;
      if (elapsed > 0 && elapsed <= maximumInteractiveLatencyMs) {
        onInteractiveLatencySample(cacheKey, elapsed);
      }
      delete pendingInteractiveLatencyRef.current[cacheKey];
    }
    const next = trimTerminalCache((terminalCacheRef.current[cacheKey] ?? "") + data);
    terminalCacheRef.current[cacheKey] = next;
    if (cacheKey === (activeProfileId ?? "empty")) {
      terminalMirrorRef.current = next;
      terminalRef.current?.write(data);
    }
  }, [isLatencyProbeEnabled, maximumInteractiveLatencyMs, onInteractiveLatencySample]);

  const appendSessionStateNotice = useCallback((sessionId: string, state: SessionInfo["state"], activeProfileId: string | null) => {
    if (isConnected(state) || state === "Connecting" || state === "Reconnecting") {
      delete terminalDisconnectNoticeRef.current[sessionId];
      return;
    }

    const reason = disconnectedReason(state);
    const notice = `\r\n[disconnected] ${reason}\r\n`;
    if (terminalDisconnectNoticeRef.current[sessionId]) {
      return;
    }
    terminalDisconnectNoticeRef.current[sessionId] = notice;
    appendTerminalOutput(notice, activeProfileId, sessionId);
  }, [appendTerminalOutput, disconnectedReason, isConnected]);

  const syncTerminalTail = useCallback((tail: string, activeProfileId: string | null, profileId?: string | null) => {
    const cacheKey = profileId ?? activeProfileId ?? "empty";
    const current = terminalCacheRef.current[cacheKey] ?? "";
    if (!tail || tail === current) {
      return;
    }
    if (tail.startsWith(current)) {
      appendTerminalOutput(tail.slice(current.length), activeProfileId, cacheKey);
      return;
    }
    replaceTerminalOutput(tail, activeProfileId, cacheKey);
  }, [appendTerminalOutput, replaceTerminalOutput]);

  const clearTerminalCache = useCallback((profileId: string) => {
    terminalCacheRef.current[profileId] = "";
    delete terminalDisconnectNoticeRef.current[profileId];
    delete lastTerminalInputAtRef.current[profileId];
    delete lastTerminalOutputAtRef.current[profileId];
    delete pendingInteractiveLatencyRef.current[profileId];
    delete interactiveLatencySamplesRef.current[profileId];
  }, []);

  return {
    state: { terminalSeed },
    refs: {
      terminalRef,
      terminalMirrorRef,
      terminalCacheRef,
      terminalDisconnectNoticeRef,
      lastTerminalInputAtRef,
      lastTerminalOutputAtRef,
      pendingInteractiveLatencyRef,
      interactiveLatencySamplesRef
    },
    actions: {
      appendSessionStateNotice,
      appendTerminalOutput,
      clearTerminalCache,
      replaceTerminalOutput,
      syncTerminalTail
    }
  };
}
