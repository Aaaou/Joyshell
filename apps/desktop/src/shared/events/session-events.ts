import type { SessionInfo, SftpProgress, TerminalOutput } from "../../types";

export type SessionEvent =
  | { StateChanged: { session_id: string; state: SessionInfo["state"] } }
  | { TerminalOutput: TerminalOutput }
  | { SftpProgress: SftpProgress };
