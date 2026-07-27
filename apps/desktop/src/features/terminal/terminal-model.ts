import type { SessionProfile } from "../../types";
import { isDesktopRuntime } from "../../platform/desktop-client";

const TERMINAL_CACHE_LIMIT = 2 * 1024 * 1024;

export function trimCpuName(name: string) {
  return name
    .replace(/\(R\)|\(TM\)|CPU|Processor/gi, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 42) || "Unknown";
}

export function buildSelectedProfileSeed(profile: SessionProfile) {
  return [
    `Selected ${profile.name} (${profile.username || "user"}@${profile.host || "host"}:${profile.port}).`,
    "Click Connect to start a real SSH connection through the Tauri/Rust backend.",
    isDesktopRuntime
      ? "Desktop runtime detected: password will be checked by ssh2/libssh2."
      : "Preview runtime detected: this page cannot open a real SSH socket.",
    ""
  ].join("\r\n");
}

export function buildConnectingTerminalSeed(profile: SessionProfile) {
  return [
    `Connecting to ${profile.username || "user"}@${profile.host}:${profile.port}...`,
    "Opening SSH session...",
    ""
  ].join("\r\n");
}

export function buildFailedTerminalSeed(profile: SessionProfile, message: string) {
  return [
    `Connecting to ${profile.username || "user"}@${profile.host}:${profile.port}...`,
    "Connection failed.",
    "",
    message,
    ""
  ].join("\r\n");
}

export function trimTerminalCache(data: string) {
  if (data.length <= TERMINAL_CACHE_LIMIT) {
    return data;
  }
  return data.slice(data.length - TERMINAL_CACHE_LIMIT);
}
