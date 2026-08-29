import { invoke } from "@tauri-apps/api/core";
import { open as openDialog } from "@tauri-apps/plugin-dialog";
import type {
  AgentToolCallPreview,
  AssistantDefinition,
  AuditEntry,
  CommandSnippet,
  LayoutSettings,
  RemoteDirectoryListing,
  SessionInfo,
  SessionFolder,
  SessionProfile,
  SftpProgress,
  LanDevice,
  SystemSnapshot,
  TerminalOutputBatch
} from "../types";

const canUseTauri = "__TAURI_INTERNALS__" in window;

const previewDragTest = !canUseTauri && window.location.search.includes("dragTest=1");
const demoFolders: SessionFolder[] = previewDragTest
  ? [
      { id: "preview-folder-alpha", name: "项目 Alpha", parent_id: null },
      { id: "preview-folder-beta", name: "项目 Beta", parent_id: null }
    ]
  : [];
const demoProfiles: SessionProfile[] = previewDragTest
  ? [
      {
        id: "preview-profile-alpha",
        name: "Alpha SSH",
        group: "项目 Alpha",
        host: "192.168.1.10",
        port: 22,
        latency_probe_host: null,
        latency_probe_port: null,
        use_terminal_latency_probe: false,
        operating_system: "Ubuntu 22.04.5 LTS",
        username: "root",
        tags: ["linux"],
        favorite: false,
        sort_order: 0
      },
      {
        id: "preview-profile-beta",
        name: "Beta SSH",
        group: "项目 Beta",
        host: "192.168.1.11",
        port: 22,
        latency_probe_host: null,
        latency_probe_port: null,
        use_terminal_latency_probe: false,
        operating_system: "Windows Server 2025",
        username: "root",
        tags: ["linux"],
        favorite: false,
        sort_order: 1
      },
      ...Array.from({ length: 12 }, (_, index) => ({
        id: `preview-profile-extra-${index}`,
        name: `新建服务器${index + 1}`,
        group: index < 2 ? "项目 Alpha" : null,
        host: `192.168.110.${index + 20}`,
        port: 22,
        latency_probe_host: null,
        latency_probe_port: null,
        use_terminal_latency_probe: false,
        operating_system: ["Alpine Linux", "Fedora Linux", "CentOS Stream", "FreeBSD", "Debian GNU/Linux"][index % 5],
        username: index % 2 === 0 ? "root" : "admin",
        tags: ["ssh"],
        favorite: false,
        sort_order: index + 2
      }))
    ]
  : [];
const demoCommands: CommandSnippet[] = [];
const defaultLayoutSettings: LayoutSettings = {
  restore_last_layout: false,
  default_left_sidebar_open: true,
  default_right_sidebar_open: true,
  default_bottom_panel_open: true,
  last_left_sidebar_open: true,
  last_right_sidebar_open: true,
  last_bottom_panel_open: true,
  use_icmp_latency_probe: false,
  skip_delete_confirmations: false,
  splash_center_image_data_url: null,
  terminal_background_image_data_url: null,
  terminal_background_opacity: 35,
  terminal_background_apply_workspace: true,
  terminal_background_apply_home: true,
  chrome_gradient_preset: "codex_cyan",
  bottom_panel_height: 390,
  connected_profile_double_click_action: "open_earliest"
};

export async function listProfiles(): Promise<SessionProfile[]> {
  if (canUseTauri) {
    return invoke("list_profiles");
  }
  return demoProfiles;
}

export async function scanLanDevices(): Promise<LanDevice[]> {
  if (canUseTauri) {
    return invoke("scan_lan_devices");
  }
  return [
    { ip: "192.168.1.1", mac: "A4:5E:60:12:34:56", name: "路由器", vendor: "TP-Link", interface: "Wi-Fi" },
    { ip: "192.168.1.23", mac: "B8:27:EB:78:9A:BC", name: "开发机", vendor: "Raspberry Pi Foundation", interface: "Wi-Fi" }
  ];
}

export async function listFolders(): Promise<SessionFolder[]> {
  if (canUseTauri) {
    return invoke("list_folders");
  }
  return demoFolders;
}

export async function connectProfile(profileId: string, sessionId?: string): Promise<SessionInfo> {
  if (canUseTauri) {
    return invoke("connect_profile", { profileId, sessionId: sessionId ?? null });
  }
  throw new Error("网页预览没有 Tauri/Rust 后端，不能执行真实 SSH 连接。请使用桌面安装包或 Tauri dev 运行。");
}

export async function acceptKnownHost(host: string, port: number, keyType: string, keyBase64: string, update = false): Promise<void> {
  if (canUseTauri) {
    await invoke("accept_known_host", { host, port, keyType, keyBase64, update });
  }
}

export async function disconnectProfile(sessionId: string): Promise<void> {
  if (canUseTauri) {
    await invoke("disconnect_profile", { sessionId });
  }
}

export async function writeClipboardText(text: string): Promise<void> {
  if (canUseTauri) {
    await invoke("write_clipboard_text", { text });
    return;
  }
  await navigator.clipboard.writeText(text);
}

export type ProfileSecrets = {
  password?: string;
  privateKeyPassphrase?: string;
};

export async function saveProfile(
  profile: SessionProfile,
  secrets: ProfileSecrets = {}
): Promise<SessionProfile> {
  if (canUseTauri) {
    return invoke("save_profile", {
      payload: {
        profile: toBackendProfile(profile),
        password: secrets.password || null,
        private_key_passphrase: secrets.privateKeyPassphrase || null
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

export async function selectPrivateKeyFile(): Promise<string | null> {
  if (!canUseTauri) {
    return null;
  }
  const selected = await openDialog({
    title: "选择 SSH 私钥",
    multiple: false,
    directory: false
  });
  return typeof selected === "string" ? selected : null;
}

export async function saveFolder(folder: SessionFolder): Promise<SessionFolder> {
  if (canUseTauri) {
    return invoke("save_folder", { folder });
  }
  const existingIndex = demoFolders.findIndex((item) => item.id === folder.id);
  if (existingIndex >= 0) {
    demoFolders[existingIndex] = folder;
  } else {
    demoFolders.push(folder);
  }
  return folder;
}

export async function deleteFolder(folderId: string): Promise<string | null> {
  if (canUseTauri) {
    return invoke("delete_folder", { folderId });
  }
  const existingIndex = demoFolders.findIndex((item) => item.id === folderId);
  if (existingIndex < 0) {
    return null;
  }
  const [folder] = demoFolders.splice(existingIndex, 1);
  for (const profile of demoProfiles) {
    if (profile.group === folder.name) {
      profile.group = null;
    }
  }
  return folder.name;
}

export async function deleteProfile(profileId: string): Promise<boolean> {
  if (canUseTauri) {
    return invoke("delete_profile", { profileId });
  }
  const existingIndex = demoProfiles.findIndex((item) => item.id === profileId);
  if (existingIndex < 0) {
    return false;
  }
  demoProfiles.splice(existingIndex, 1);
  return true;
}

export async function listCommandSnippets(): Promise<CommandSnippet[]> {
  if (canUseTauri) {
    return invoke("list_command_snippets");
  }
  return demoCommands;
}

export async function saveCommandSnippet(snippet: CommandSnippet): Promise<CommandSnippet> {
  if (canUseTauri) {
    return invoke("save_command_snippet", { snippet });
  }
  const existingIndex = demoCommands.findIndex((item) => item.id === snippet.id);
  if (existingIndex >= 0) {
    demoCommands[existingIndex] = snippet;
  } else {
    demoCommands.unshift(snippet);
  }
  return snippet;
}

export async function deleteCommandSnippet(id: string): Promise<void> {
  if (canUseTauri) {
    await invoke("delete_command_snippet", { id });
    return;
  }
  const existingIndex = demoCommands.findIndex((item) => item.id === id);
  if (existingIndex >= 0) {
    demoCommands.splice(existingIndex, 1);
  }
}

export async function getLayoutSettings(): Promise<LayoutSettings> {
  if (canUseTauri) {
    return invoke("get_layout_settings");
  }
  return defaultLayoutSettings;
}

export async function saveLayoutSettings(settings: LayoutSettings): Promise<LayoutSettings> {
  if (canUseTauri) {
    return invoke("save_layout_settings", { settings });
  }
  Object.assign(defaultLayoutSettings, settings);
  return settings;
}

function toBackendProfile(profile: SessionProfile) {
  return {
    ...profile,
    auth_method: profile.auth_method ?? {
      Password: {
        secret_ref: `secret://${profile.id}/password`
      }
    },
    host_key_policy: profile.host_key_policy ?? "AcceptNew",
    jump_host_id: profile.jump_host_id ?? null
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

export async function terminalOutputBatch(
  sessionId: string,
  afterSequence: number | null,
  maxChunks = 200
): Promise<TerminalOutputBatch> {
  if (canUseTauri) {
    return invoke("terminal_output_batch", { sessionId, afterSequence, maxChunks });
  }
  return {
    session_id: sessionId,
    first_sequence: null,
    latest_sequence: afterSequence ?? 0,
    truncated: false,
    outputs: []
  };
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
      primary_ip: null,
      device_model: null
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
    cpu_info: { model_name: "Unknown CPU", raw_part: null, logical_cores: 0, physical_cores: null, mhz: null },
    memory: { total_bytes: 0, used_bytes: 0, free_bytes: 0, available_bytes: 0 },
    memory_info: { frequency_mhz: null },
    swap: { total_bytes: 0, used_bytes: 0, free_bytes: 0, available_bytes: 0 },
    processes: { total: 0, running: 0, sleeping: 0, stopped: 0, zombie: 0, threads: 0 },
    network: [],
    filesystems: []
  };
}

export async function measureLatency(
  host: string,
  port: number,
  useIcmp: boolean
): Promise<number | null> {
  if (canUseTauri) {
    return invoke("measure_latency", { host, port, useIcmp });
  }
  return null;
}

export async function measureSessionLatency(sessionId: string): Promise<number | null> {
  if (canUseTauri) {
    return invoke("measure_session_latency", { sessionId });
  }
  return null;
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

export async function revealLocalPath(path: string): Promise<void> {
  if (canUseTauri) {
    await invoke("reveal_local_path", { path });
    return;
  }
  console.debug("preview reveal local path", path);
}

export async function deleteLocalFile(path: string): Promise<void> {
  if (canUseTauri) {
    await invoke("delete_local_file", { path });
    return;
  }
  console.debug("preview delete local file", path);
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
