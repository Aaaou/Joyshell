import type { SessionInfo, SftpProgress } from "../../types";

export type SessionEvent =
  | { StateChanged: { session_id: string; state: SessionInfo["state"] } }
  | { TerminalOutput: { session_id: string; data: string } }
  | { SftpProgress: SftpProgress };
