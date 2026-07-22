import { invoke } from "@tauri-apps/api/core";
import type {
  AgentToolCallPreview,
  AssistantDefinition,
  AuditEntry,
  RemoteDirectoryListing,
  SessionInfo,
  SessionProfile,
  SftpProgress,
  SystemSnapshot
} from "./types";

const canUseTauri = "__TAURI_INTERNALS__" in window;

const demoProfiles: SessionProfile[] = [];

export async function listProfiles(): Promise<SessionProfile[]> {
  if (canUseTauri) {
    return invoke("list_profiles");
  }
  return demoProfiles;
}

export async function connectProfile(profileId: string): Promise<SessionInfo> {
  if (canUseTauri) {
    return invoke("connect_profile", { profileId });
  }
  throw new Error("网页预览没有 Tauri/Rust 后端，不能执行真实 SSH 连接。请使用桌面安装包或 Tauri dev 运行。");
}

export async function saveProfile(profile: SessionProfile, password?: string): Promise<SessionProfile> {
  if (canUseTauri) {
    return invoke("save_profile", {
      payload: {
        profile: toBackendProfile(profile),
        password: password || null
      }
    });
  }
  const existingIndex = demoProfiles.findIndex((item) => item.id === profile.id);
  if (existingIndex >= 0) {
    demoProfiles[existingIndex] = profile;
  } else {
    demoProfiles.push(profile);
  }
  return profile;
}

function toBackendProfile(profile: SessionProfile) {
  return {
    ...profile,
    auth_method: {
      Password: {
        secret_ref: `secret://${profile.id}/password`
      }
    },
    host_key_policy: "AcceptNew",
    jump_host_id: null
  };
}

export async function writeTerminal(sessionId: string, data: string): Promise<void> {
  if (canUseTauri) {
    await invoke("write_terminal", { sessionId, data });
    return;
  }
  console.debug("preview terminal input ignored", sessionId, data);
}

export async function terminalOutputTail(sessionId: string, maxChunks = 200): Promise<string> {
  if (canUseTauri) {
    return invoke("terminal_output_tail", { sessionId, maxChunks });
  }
  return "";
}

export async function sessionDiagnostics(sessionId: string): Promise<string> {
  if (canUseTauri) {
    return invoke("session_diagnostics", { sessionId });
  }
  return `preview session=${sessionId}`;
}

export async function collectSystemSnapshot(sessionId: string): Promise<SystemSnapshot> {
  if (canUseTauri) {
    return invoke("collect_system_snapshot", { sessionId });
  }
  const now = new Date().toISOString();
  return {
    captured_at: now,
    host: {
      hostname: "preview",
      os_name: "Preview runtime",
      kernel_name: "",
      kernel_release: "",
      architecture: "",
      primary_ip: null
    },
    uptime_seconds: 0,
    load: { one: 0, five: 0, fifteen: 0, runnable_processes: 0, total_processes: 0, last_pid: 0 },
    cpu: {
      user: 0,
      nice: 0,
      system: 0,
      idle: 0,
      iowait: 0,
      irq: 0,
      softirq: 0,
      steal: 0,
      guest: 0,
      guest_nice: 0
    },
    cpu_cores: [],
    cpu_info: { model_name: "Unknown CPU", logical_cores: 0, physical_cores: null, mhz: null },
    memory: { total_bytes: 0, used_bytes: 0, free_bytes: 0, available_bytes: 0 },
    swap: { total_bytes: 0, used_bytes: 0, free_bytes: 0, available_bytes: 0 },
    processes: { total: 0, running: 0, sleeping: 0, stopped: 0, zombie: 0, threads: 0 },
    network: [],
    filesystems: []
  };
}

export async function sftpListDirectory(
  sessionId: string,
  path: string
): Promise<RemoteDirectoryListing> {
  if (canUseTauri) {
    return invoke("sftp_list_directory", { sessionId, path });
  }
  return {
    path,
    parent: path === "/" ? null : "/",
    entries: []
  };
}

export async function sftpCreateDir(sessionId: string, path: string): Promise<void> {
  if (canUseTauri) {
    await invoke("sftp_create_dir", { sessionId, path });
  }
}

export async function sftpDeletePath(
  sessionId: string,
  path: string,
  isDir: boolean
): Promise<void> {
  if (canUseTauri) {
    await invoke("sftp_delete_path", { sessionId, path, isDir });
  }
}

export async function sftpRenamePath(
  sessionId: string,
  from: string,
  to: string
): Promise<void> {
  if (canUseTauri) {
    await invoke("sftp_rename_path", { sessionId, from, to });
  }
}

export async function sftpDownloadFile(
  sessionId: string,
  transferId: string,
  remotePath: string,
  localPath: string
): Promise<SftpProgress> {
  if (canUseTauri) {
    return invoke("sftp_download_file", { sessionId, transferId, remotePath, localPath });
  }
  return {
    id: transferId,
    session_id: sessionId,
    direction: "Download",
    remote_path: remotePath,
    local_path: localPath,
    bytes_done: 0,
    bytes_total: null,
    status: "Completed"
  };
}

export async function sftpUploadFile(
  sessionId: string,
  transferId: string,
  localPath: string,
  remotePath: string
): Promise<SftpProgress> {
  if (canUseTauri) {
    return invoke("sftp_upload_file", { sessionId, transferId, localPath, remotePath });
  }
  return {
    id: transferId,
    session_id: sessionId,
    direction: "Upload",
    remote_path: remotePath,
    local_path: localPath,
    bytes_done: 0,
    bytes_total: null,
    status: "Completed"
  };
}

export async function cancelSftpTransfer(transferId: string): Promise<void> {
  if (canUseTauri) {
    await invoke("cancel_sftp_transfer", { transferId });
  }
}

export async function listAssistants(): Promise<AssistantDefinition[]> {
  if (canUseTauri) {
    return invoke("list_assistants");
  }
  return [
    {
      kind: "GeneralAssistant",
      display_name: "General Assistant",
      description: "Primary assistant for explaining output, proposing commands, delegating constrained subtasks, and summarizing results.",
      allowed_tools: ["*"],
      disallowed_tools: [],
      can_spawn_children: true,
      system_prompt: ""
    },
    {
      kind: "ExploreAssistant",
      display_name: "Explore Assistant",
      description: "Read-only assistant for terminal and session analysis.",
      allowed_tools: ["terminal.read_output", "session.get_info", "memory.search"],
      disallowed_tools: ["terminal.run_command", "sftp.upload", "sftp.delete", "mcp.call"],
      can_spawn_children: false,
      system_prompt: ""
    }
  ];
}

export async function previewToolCall(
  assistant: string,
  toolName: string,
  target: string
): Promise<AgentToolCallPreview> {
  if (canUseTauri) {
    return invoke("preview_agent_tool_call", {
      assistant,
      toolName,
      target,
      input: { command: target }
    });
  }
  return {
    id: crypto.randomUUID(),
    assistant,
    tool_name: toolName,
    target,
    decision: {
      behavior: toolName.includes("read") || toolName === "session.get_info" ? "Allow" : "Ask",
      risk: toolName === "terminal.run_command" ? "High" : "Low",
      reason: "preview-only guarded mode"
    }
  };
}

export async function recentAudit(): Promise<AuditEntry[]> {
  if (canUseTauri) {
    return invoke("recent_audit");
  }
  return [];
}
