export type SessionAuthMethod =
  | { Password: { secret_ref: string } }
  | { PrivateKey: { key_ref: string; passphrase_ref?: string | null } }
  | "Agent";

export type SessionProfile = {
  id: string;
  name: string;
  group?: string | null;
  host: string;
  port: number;
  latency_probe_host?: string | null;
  latency_probe_port?: number | null;
  use_terminal_latency_probe?: boolean;
  operating_system?: string | null;
  username: string;
  auth_method?: SessionAuthMethod;
  host_key_policy?: "Strict" | "AcceptNew" | "InsecureAcceptAny";
  jump_host_id?: string | null;
  tags: string[];
  favorite: boolean;
  sort_order: number;
};

export type SessionFolder = {
  id: string;
  name: string;
  parent_id?: string | null;
};

export type CommandSnippet = {
  id: string;
  title: string;
  command: string;
  tags: string[];
};

export type ChromeGradientPreset =
  | "codex_cyan"
  | "cool_blues"
  | "green_beach"
  | "slight_ocean_view"
  | "perfect_blue";

export type LayoutSettings = {
  restore_last_layout: boolean;
  default_left_sidebar_open: boolean;
  default_right_sidebar_open: boolean;
  default_bottom_panel_open: boolean;
  last_left_sidebar_open: boolean;
  last_right_sidebar_open: boolean;
  last_bottom_panel_open: boolean;
  use_icmp_latency_probe: boolean;
  skip_delete_confirmations: boolean;
  splash_center_image_data_url?: string | null;
  terminal_background_image_data_url?: string | null;
  terminal_background_opacity: number;
  terminal_background_apply_workspace: boolean;
  terminal_background_apply_home: boolean;
  chrome_gradient_preset: ChromeGradientPreset;
  bottom_panel_height: number;
  connected_profile_double_click_action: "open_earliest" | "new_session";
};

export type SessionInfo = {
  id: string;
  profile_id: string;
  profile_name: string;
  host: string;
  port: number;
  username: string;
  state: "Disconnected" | "Connecting" | "Connected" | "Reconnecting" | { Failed: { reason: string } };
  connected_at?: string | null;
  last_seen_at: string;
};

export type AssistantDefinition = {
  kind: string;
  display_name: string;
  description: string;
  allowed_tools: string[];
  disallowed_tools: string[];
  can_spawn_children: boolean;
  system_prompt: string;
};

export type PermissionBehavior = "Allow" | "Deny" | "Ask";
export type RiskLevel = "Low" | "Medium" | "High";

export type PermissionDecision = {
  behavior: PermissionBehavior;
  risk: RiskLevel;
  reason: string;
};

export type AgentToolCallPreview = {
  id: string;
  assistant: string;
  tool_name: string;
  target: string;
  decision: PermissionDecision;
};

export type AuditEntry = {
  id: string;
  created_at: string;
  actor: string;
  session_id?: string | null;
  action: string;
  target: string;
  decision?: string | null;
  summary: string;
};

export type RemoteFileEntry = {
  name: string;
  path: string;
  is_dir: boolean;
  size: number;
  permissions: string;
  modified_at?: string | null;
};

export type RemoteDirectoryListing = {
  path: string;
  parent?: string | null;
  entries: RemoteFileEntry[];
};

export type FileTransferDirection = "Upload" | "Download";

export type TransferStatus =
  | "Queued"
  | "Running"
  | { Retrying: { attempt: number; max_attempts: number; reason: string } }
  | "Completed"
  | "Cancelled"
  | { Failed: { reason: string } };

export type SftpProgress = {
  id: string;
  session_id: string;
  direction: FileTransferDirection;
  local_path: string;
  remote_path: string;
  bytes_done: number;
  bytes_total?: number | null;
  status: TransferStatus;
};

export type LoadAverage = {
  one: number;
  five: number;
  fifteen: number;
  runnable_processes: number;
  total_processes: number;
  last_pid: number;
};

export type CpuTimes = {
  user: number;
  nice: number;
  system: number;
  idle: number;
  iowait: number;
  irq: number;
  softirq: number;
  steal: number;
  guest: number;
  guest_nice: number;
};

export type CpuCoreSample = {
  name: string;
  times: CpuTimes;
};

export type CpuInfoSample = {
  model_name: string;
  raw_part?: string | null;
  logical_cores: number;
  physical_cores?: number | null;
  mhz?: number | null;
};

export type MemorySample = {
  total_bytes: number;
  used_bytes: number;
  free_bytes: number;
  available_bytes: number;
};

export type MemoryInfoSample = {
  frequency_mhz?: number | null;
};

export type NetworkInterfaceSample = {
  name: string;
  rx_bytes: number;
  tx_bytes: number;
  rx_packets: number;
  tx_packets: number;
  rx_errors: number;
  tx_errors: number;
  ipv4_addresses: string[];
};

export type FileSystemSample = {
  filesystem: string;
  fs_type: string;
  mount_point: string;
  total_bytes: number;
  used_bytes: number;
  available_bytes: number;
  used_percent: number;
  inode_total?: number | null;
  inode_used?: number | null;
  inode_available?: number | null;
  inode_used_percent?: number | null;
};

export type HostInfoSample = {
  hostname: string;
  os_name: string;
  kernel_name: string;
  kernel_release: string;
  architecture: string;
  primary_ip?: string | null;
  device_model?: string | null;
};

export type ProcessSample = {
  total: number;
  running: number;
  sleeping: number;
  stopped: number;
  zombie: number;
  threads: number;
};

export type SystemSnapshot = {
  captured_at: string;
  host: HostInfoSample;
  uptime_seconds: number;
  load: LoadAverage;
  cpu: CpuTimes;
  cpu_cores: CpuCoreSample[];
  cpu_info: CpuInfoSample;
  memory: MemorySample;
  memory_info: MemoryInfoSample;
  swap: MemorySample;
  processes: ProcessSample;
  network: NetworkInterfaceSample[];
  filesystems: FileSystemSample[];
};
