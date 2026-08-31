import type { ForwardingRule, HostKeyPrompt, SessionInfo, SftpProgress, TerminalOutput } from "../../types";

export type SessionEvent =
  | { StateChanged: { session_id: string; state: SessionInfo["state"] } }
  | { TerminalOutput: TerminalOutput }
  | { SftpProgress: SftpProgress }
  | { ForwardingChanged: ForwardingRule }
  | { HostKeyPrompt: HostKeyPrompt }
  | { HostKeyAccepted: { session_id: string; host: string; port: number; fingerprint: string } }
  | { HostKeyChanged: { session_id: string; host: string; port: number; previous_fingerprint: string; fingerprint: string } };
