import { JoyTerminal } from "@joyshell/terminal";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import type React from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import defaultWorkspaceBackground from "../assets/backgrounds/default-workspace-bg.jpg";
import splashCenterImage from "../assets/splash/center-joy-cropped.png";
import {
  ChevronRight,
  Circle,
  Copy,
  Cpu,
  Download,
  Edit3,
  Folder,
  FolderOpen,
  FolderPlus,
  HardDrive,
  MemoryStick,
  Minus,
  Minimize2,
  Network,
  Pause,
  Palette,
  PanelBottom,
  PanelRight,
  Play,
  Plus,
  RefreshCw,
  RotateCcw,
  Save,
  Search,
  Server,
  Settings,
  ShieldCheck,
  SplitSquareHorizontal,
  Square,
  Star,
  Trash2,
  Upload,
  X
} from "lucide-react";
import { FileKindIcon } from "../ui/FileKindIcon";
import { OperatingSystemIcon } from "../ui/OperatingSystemIcon";
import { DangerConfirmDialog } from "../features/dialogs/DangerConfirmDialog";
import { TextInputDialog } from "../features/dialogs/TextInputDialog";
import { HostKeyConfirmDialog } from "../features/dialogs/HostKeyConfirmDialog";
import { TransferConflictDialog } from "../features/dialogs/TransferConflictDialog";
import { JoyshellSplash } from "../features/splash/JoyshellSplash";
import type {
  CommandSnippet,
  ChromeGradientPreset,
  RemoteDirectoryListing,
  RemoteFileEntry,
  HostKeyPrompt,
  SessionInfo,
  SessionFolder,
  SessionProfile,
  SftpProgress,
  SystemSnapshot,
  TerminalOutput,
  LanDevice
} from "../types";
import { desktopClient, isDesktopRuntime } from "../platform/desktop-client";
import { useSessionEvents } from "../platform/use-session-events";
import {
  CHROME_GRADIENT_PRESETS
} from "../shell/chrome-gradient";
import { useBottomPanelResize } from "../shell/use-bottom-panel-resize";
import { useChromeGradient } from "../shell/use-chrome-gradient";
import { useLayoutController } from "../shell/use-layout-controller";
import { useWindowControls } from "../shell/use-window-controls";
import {
  buildProfileGroups,
  createBlankProfile,
  createUniqueBlankProfile,
  createUniqueFolderName,
  findProfileDropIndicator,
  findTabDropIndicator,
  resolveProfileOperatingSystem,
  moveProfileWithinCurrentGroup,
  normalizeProfileSortOrders,
  profileMatchesSearch,
  reorderProfileByPointer,
  resolveProfileDoubleClickDecision
} from "../features/sessions/session-model";
import { enqueueHostKeyPrompt, removeHostKeyPrompt } from "../features/sessions/host-key-model";
import {
  buildSystemInfoClipboard,
  clampPercent,
  deriveSystemStats,
  emptySystemDerived,
  formatCpuFrequency,
  formatLoad,
  formatMemoryFrequency,
  formatMemoryMetric,
  formatPercent,
  formatRootDisk,
  formatUsagePercent,
  usagePercent,
  type SystemDerivedStats
} from "../features/system-info/system-model";
import { Metric, SystemInfoDialog } from "../features/system-info/SystemInfoDialog";
const clientBuildLabel = "0.1.68";

function clampNumber(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function escapeCssUrl(value: string) {
  return value.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

function deviceTypeFromMac(mac: string) {
  const prefix = mac.replace(/[-:]/g, "").slice(0, 6).toUpperCase();
  const known: Record<string, string> = {
    "B827EB": "Raspberry Pi（推测）",
    "DCA632": "Raspberry Pi（推测）",
    "E45F01": "Raspberry Pi（推测）",
    "D83ADD": "Rockchip / 瑞芯微设备（推测）",
    "A85E45": "Rockchip / 瑞芯微设备（推测）"
  };
  return known[prefix] ?? null;
}

async function readImageFileAsDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => typeof reader.result === "string" ? resolve(reader.result) : reject(new Error("无法读取图片"));
    reader.onerror = () => reject(reader.error ?? new Error("无法读取图片"));
    reader.readAsDataURL(file);
  });
}

const READY_TERMINAL_OUTPUT = "Joyshell is ready. Add an SSH connection, then click Connect.\r\n";
const INTERACTIVE_LATENCY_IDLE_MS = 2500;
const TERMINAL_OUTPUT_BUSY_MS = 1200;
const INTERACTIVE_LATENCY_MAX_MS = 5000;
const INTERACTIVE_LATENCY_SAMPLE_LIMIT = 6;
const PROFILE_DRAG_TYPE = "application/x-joyshell-profile-id";
const TAB_DRAG_TYPE = "application/x-joyshell-tab-profile-id";
const dragDebugEnabled = !isDesktopRuntime && window.location.search.includes("dragTest=1");

function debugDrag(message: string, detail?: unknown) {
  if (dragDebugEnabled) {
    console.debug(`[joyshell-drag] ${message}`, detail ?? "");
  }
}

type ContextMenuState = {
  kind: "terminal" | "file" | "transfer" | "session" | "create" | "folder" | "tab";
  x: number;
  y: number;
  transferId?: string;
  profileId?: string;
  shellId?: string;
  folderId?: string;
};

type DangerConfirmState = {
  title: string;
  message: string;
};

type TextInputDialogState = {
  title: string;
  message?: string;
  label: string;
  initialValue: string;
  placeholder?: string;
  confirmLabel?: string;
};

type ImageCropRequest = {
  target: "splash" | "terminal-background";
  title: string;
  sourceUrl: string;
  aspectRatio: number;
  outputWidth: number;
  outputHeight: number;
};

type PointerDragState = {
  kind: "profile" | "tab";
  id: string;
  label: string;
  startX: number;
  startY: number;
  dragging: boolean;
};

type DragIndicator =
  | {
      kind: "profile";
      draggedId: string;
      groupId: string | null;
      targetId: string | null;
      position: "before" | "after" | "inside";
      clientY: number;
    }
  | {
      kind: "tab";
      draggedId: string;
      targetId: string | null;
      position: "before" | "after";
    };

import type { SidebarSortMode } from "../features/sessions/session-model";
import { ConnectionHome } from "../features/home/ConnectionHome";
import { CommandLibraryPanel } from "../features/commands/CommandLibraryPanel";
import { SshSettingsDialog } from "../features/sessions/SshSettingsDialog";
import { loadCollapsedSessionFolders, saveCollapsedSessionFolders } from "../features/sessions/folder-preferences";
import { AppSettingsWorkspace } from "../features/settings/AppSettingsWorkspace";
import { useSplashLifecycle } from "../features/splash/use-splash-lifecycle";
import { buildPathCrumbs, joinRemotePath, remoteBasename, remoteParentDir } from "../features/sftp/path-model";
import {
  buildTransferTelemetry,
  createTransferProgress,
  formatBytes,
  formatDateTime,
  formatLatency,
  formatRate,
  formatTransferStatus,
  formatUptime,
  getDisconnectedReason,
  isConnectedState,
  isTransferActive,
  transferNeedsAttention,
  latencyTone,
  TransferMetric
} from "../features/transfers/transfer-model";
import {
  isRecoverableTransferFailure,
  isScheduledTransferRetryCurrent,
  recoverableTransferFailureReason
} from "../features/transfers/transfer-retry-model";
import { useTransferClock } from "../features/transfers/use-transfer-clock";
import { useTransferRuntime } from "../features/transfers/use-transfer-runtime";

const {
  collectSystemSnapshot,
  cancelSftpTransfer,
  pauseSftpTransfer,
  connectProfile,
  disconnectProfile,
  deleteCommandSnippet,
  deleteFolder,
  deleteLocalFile,
  deleteProfile,
  getLayoutSettings,
  listCommandSnippets,
  listFolders,
  listProfiles,
  measureLatency,
  measureSessionLatency,
  revealLocalPath,
  saveCommandSnippet,
  saveFolder,
  saveProfile,
  sessionDiagnostics,
  sftpCreateDir,
  sftpDeletePath,
  sftpDownloadFile,
  sftpListDirectory,
  sftpRenamePath,
  sftpUploadFile,
  terminalOutputBatch,
  writeTerminal
} = desktopClient;
import {
  advanceSessionHealthFailure,
  averageLatencySamples,
  clearSessionHealthFailures,
  recordInteractiveLatencySample,
  resolveLatencyTarget,
  shouldSkipActiveLatencyProbe
} from "../features/terminal/latency-model";
import {
  buildConnectingTerminalSeed,
  buildFailedTerminalSeed,
  buildSelectedProfileSeed,
  trimCpuName
} from "../features/terminal/terminal-model";
import { useTerminalRuntime } from "../features/terminal/use-terminal-runtime";

export function App() {
  const [profiles, setProfiles] = useState<SessionProfile[]>([]);
  const [sidebarSortMode, setSidebarSortMode] = useState<SidebarSortMode>("custom");
  const [folders, setFolders] = useState<SessionFolder[]>([]);
  const [collapsedSessionFolderIds, setCollapsedSessionFolderIds] = useState<Set<string>>(() => loadCollapsedSessionFolders());
  const [openProfileIds, setOpenProfileIds] = useState<string[]>([]);
  const [shellProfileIds, setShellProfileIds] = useState<Record<string, string>>({});
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [activeProfileId, setActiveProfileId] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const flash = useCallback((message: string) => {
    setNotice(message);
    window.setTimeout(() => setNotice(null), 1800);
  }, []);
  const {
    state: { assistantOpen, sidebarCollapsed, bottomPanelOpen, bottomPanelHeight, layoutSettings },
    actions: {
      applyLoadedLayout,
      setLeftSidebarOpen,
      setRightSidebarOpen,
      setBottomPanelPreferenceOpen,
      previewBottomPanelHeight,
      commitBottomPanelHeight,
      updateLayoutSettings
    }
  } = useLayoutController(flash);
  const bottomPanelResize = useBottomPanelResize({
    height: bottomPanelHeight,
    onHeightChange: previewBottomPanelHeight,
    onHeightCommit: commitBottomPanelHeight,
    onCollapse: () => setBottomPanelPreferenceOpen(false)
  });
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [appSettingsOpen, setAppSettingsOpen] = useState(false);
  const [appSettingsPage, setAppSettingsPage] = useState<"general" | "appearance" | "security">("general");
  const [systemDialogOpen, setSystemDialogOpen] = useState(false);
  const [editingProfile, setEditingProfile] = useState<SessionProfile | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [commandDraft, setCommandDraft] = useState("");
  const [sessionSearchQuery, setSessionSearchQuery] = useState("");
  const [activeBottomView, setActiveBottomView] = useState<"files" | "commands">("files");
  const [commandSnippets, setCommandSnippets] = useState<CommandSnippet[]>([]);
  const [editingCommandId, setEditingCommandId] = useState<string | null>(null);
  const [commandTitleDraft, setCommandTitleDraft] = useState("");
  const [commandBodyDraft, setCommandBodyDraft] = useState("");
  const [commandSendMode, setCommandSendMode] = useState<"current" | "all" | "selected">("current");
  const [selectedCommandTargets, setSelectedCommandTargets] = useState<Record<string, boolean>>({});
  const [terminalInputCount, setTerminalInputCount] = useState(0);
  const [systemSnapshot, setSystemSnapshot] = useState<SystemSnapshot | null>(null);
  const [systemDerived, setSystemDerived] = useState<SystemDerivedStats>(emptySystemDerived);
  const [systemStatus, setSystemStatus] = useState("等待连接");
  const [latencyMs, setLatencyMs] = useState<number | null>(null);
  const [latencyStatus, setLatencyStatus] = useState("待连接");
  const [sftpListing, setSftpListing] = useState<RemoteDirectoryListing | null>(null);
  const [sftpPath, setSftpPath] = useState(".");
  const [selectedRemotePath, setSelectedRemotePath] = useState<string | null>(null);
  const [sftpBusy, setSftpBusy] = useState(false);
  const [sftpStatus, setSftpStatus] = useState("等待连接");
  const [lanDevices, setLanDevices] = useState<LanDevice[]>(() => {
    try { return JSON.parse(localStorage.getItem("joyshell.lan.devices") || "[]") as LanDevice[]; } catch { return []; }
  });
  const [lanScanning, setLanScanning] = useState(false);
  const [lanToolsOpen, setLanToolsOpen] = useState(false);
  const [lanScanRequested, setLanScanRequested] = useState(false);
  const [lanScanOpen, setLanScanOpen] = useState(false);
  const [selectedLanDevice, setSelectedLanDevice] = useState<LanDevice | null>(null);
  const scanLanDevices = desktopClient.scanLanDevices;
  const transferRuntime = useTransferRuntime();
  const { transfers, transferStats, cancellingTransfers, hasActiveTransfer } = transferRuntime.state;
  const { markTransferFailed, removeTransfer: removeTransferRecord, setCancellingTransfers, upsertTransfer } = transferRuntime.actions;
  const [sftpDropActive, setSftpDropActive] = useState(false);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [dangerConfirm, setDangerConfirm] = useState<DangerConfirmState | null>(null);
  const [textInputDialog, setTextInputDialog] = useState<TextInputDialogState | null>(null);
  const [hostKeyPrompts, setHostKeyPrompts] = useState<HostKeyPrompt[]>([]);
  const [hostKeySubmitting, setHostKeySubmitting] = useState(false);
  const [transferConflict, setTransferConflict] = useState<SftpProgress | null>(null);
  const [transferConflictSubmitting, setTransferConflictSubmitting] = useState(false);
  const autoResumedTransferIdsRef = useRef(new Set<string>());
  const autoResumeTimersRef = useRef(new Map<string, { retryKey: string; timer: number }>());
  const transfersRef = useRef<SftpProgress[]>([]);
  const [editingFolderId, setEditingFolderId] = useState<string | null>(null);
  const [folderNameDraft, setFolderNameDraft] = useState("");
  const [editingRemotePath, setEditingRemotePath] = useState<string | null>(null);
  const [remoteNameDraft, setRemoteNameDraft] = useState("");
  const [dragOverFolderId, setDragOverFolderId] = useState<string | null>(null);
  const [dragIndicator, setDragIndicator] = useState<DragIndicator | null>(null);
  const activeProfileIdRef = useRef<string | null>(null);
  const profilesRef = useRef<SessionProfile[]>([]);
  const shellProfileIdsRef = useRef<Record<string, string>>({});
  const fileRegionRef = useRef<HTMLElement | null>(null);
  const previousSystemSnapshotRef = useRef<SystemSnapshot | null>(null);
  const systemSyncInFlightRef = useRef(false);
  const systemSyncFailureCountRef = useRef(0);
  const latencyTimeoutCountRef = useRef<Record<string, number>>({});
  const draggedProfileIdRef = useRef<string | null>(null);
  const draggedTabProfileIdRef = useRef<string | null>(null);
  const contextMenuRef = useRef<HTMLDivElement | null>(null);
  const dangerConfirmResolverRef = useRef<((confirmed: boolean) => void) | null>(null);
  const textInputDialogResolverRef = useRef<((value: string | null) => void) | null>(null);
  const pointerDragRef = useRef<PointerDragState | null>(null);
  const dragIndicatorRef = useRef<DragIndicator | null>(null);
  const suppressNextClickRef = useRef(false);
  const isTerminalLatencyProbeEnabled = useCallback(
    (shellId: string) => {
      const profileId = shellProfileIdsRef.current[shellId] ?? shellId;
      return profilesRef.current.some((profile) => profile.id === profileId && profile.use_terminal_latency_probe);
    },
    []
  );
  const handleInteractiveLatencySample = useCallback((profileId: string, elapsedMs: number) => {
    setLatencyMs(recordInteractiveLatencySample(profileId, elapsedMs, interactiveLatencySamplesRef.current));
    setLatencyStatus("\u4ea4\u4e92\u5e73\u5747");
  }, []);
  const terminalRuntime = useTerminalRuntime({
    initialOutput: READY_TERMINAL_OUTPUT,
    isConnected: isConnectedState,
    disconnectedReason: getDisconnectedReason,
    isLatencyProbeEnabled: isTerminalLatencyProbeEnabled,
    onInteractiveLatencySample: handleInteractiveLatencySample,
    maximumInteractiveLatencyMs: INTERACTIVE_LATENCY_MAX_MS
  });
  const { terminalSeed } = terminalRuntime.state;
  const {
    terminalRef,
    terminalMirrorRef,
    terminalCacheRef,
    terminalSequenceRef,
    terminalDisconnectNoticeRef,
    lastTerminalInputAtRef,
    lastTerminalOutputAtRef,
    pendingInteractiveLatencyRef,
    interactiveLatencySamplesRef
  } = terminalRuntime.refs;
  const {
    appendSessionStateNotice: appendTerminalSessionStateNotice,
    appendTerminalOutput: appendTerminalRuntimeOutput,
    clearTerminalCache,
    consumeTerminalOutput: consumeTerminalRuntimeOutput,
    replaceTerminalOutput: replaceTerminalRuntimeOutput,
    resetTerminalOutputCursor: resetTerminalRuntimeOutputCursor,
    syncTerminalOutputBatch: syncTerminalRuntimeOutputBatch
  } = terminalRuntime.actions;
  const replaceTerminalOutput = useCallback(
    (data: string, profileId?: string | null) => replaceTerminalRuntimeOutput(data, activeProfileIdRef.current, profileId),
    [replaceTerminalRuntimeOutput]
  );
  const appendTerminalOutput = useCallback(
    (data: string, profileId?: string | null) => appendTerminalRuntimeOutput(data, activeProfileIdRef.current, profileId),
    [appendTerminalRuntimeOutput]
  );
  const appendSessionStateNotice = useCallback(
    (sessionId: string, state: SessionInfo["state"]) => appendTerminalSessionStateNotice(sessionId, state, activeProfileIdRef.current),
    [appendTerminalSessionStateNotice]
  );
  const consumeTerminalOutput = useCallback(
    (output: TerminalOutput) => consumeTerminalRuntimeOutput(output, activeProfileIdRef.current),
    [consumeTerminalRuntimeOutput]
  );
  const syncTerminalOutputBatch = useCallback(
    (batch: Awaited<ReturnType<typeof terminalOutputBatch>>) => syncTerminalRuntimeOutputBatch(batch, activeProfileIdRef.current),
    [syncTerminalRuntimeOutputBatch]
  );

  const markSessionDisconnected = useCallback((sessionId: string, reason: string) => {
    const state: SessionInfo["state"] = { Failed: { reason } };
    latencyTimeoutCountRef.current[sessionId] = 0;
    delete pendingInteractiveLatencyRef.current[sessionId];
    delete interactiveLatencySamplesRef.current[sessionId];
    setLatencyMs(null);
    setLatencyStatus("断开");
    setSessions((current) =>
      current.map((session) => session.id === sessionId ? { ...session, state } : session)
    );
    appendSessionStateNotice(sessionId, state);
  }, [appendSessionStateNotice]);

  const recordSessionHealthFailure = useCallback((sessionId: string) => {
    const decision = advanceSessionHealthFailure(sessionId, latencyTimeoutCountRef.current);
    if (!decision.shouldDisconnect) {
      setLatencyMs(null);
      setLatencyStatus(`确认中 ${decision.failures}/3`);
      return;
    }
    markSessionDisconnected(sessionId, "SSH connection timed out.");
    void disconnectProfile(sessionId).catch(() => undefined);
  }, [markSessionDisconnected]);

  useChromeGradient(layoutSettings.chrome_gradient_preset);

  const { splashVisible, splashClosing } = useSplashLifecycle();
  const transferClockNow = useTransferClock(hasActiveTransfer);

  const refreshLanDevices = useCallback(async () => {
    setLanScanning(true);
    try {
      const current = (await scanLanDevices()).map((device) => ({ ...device, online: true }));
      setLanDevices((previous) => {
        const byMac = new Map(previous.map((device) => [device.mac, device]));
        current.forEach((device) => byMac.set(device.mac, { ...byMac.get(device.mac), ...device }));
        const merged = Array.from(byMac.values()).map((device) => ({ ...device, online: current.some((item) => item.mac === device.mac) }));
        localStorage.setItem("joyshell.lan.devices", JSON.stringify(merged));
        return merged;
      });
    } catch (error) {
      flash(`扫描失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setLanScanning(false);
    }
  }, [flash, scanLanDevices]);

  useEffect(() => {
    void Promise.all([
      listProfiles(),
      listFolders(),
      listCommandSnippets(),
      getLayoutSettings()
    ]).then(
      ([profilesResult, foldersResult, commandsResult, layoutResult]) => {
        setProfiles(profilesResult);
        setFolders(foldersResult);
        setCommandSnippets(commandsResult);
        applyLoadedLayout(layoutResult);
        setActiveProfileId(null);
      }
    );
  }, [applyLoadedLayout]);

  useEffect(() => {
    activeProfileIdRef.current = activeProfileId;
  }, [activeProfileId]);

  useEffect(() => {
    profilesRef.current = profiles;
  }, [profiles]);

  useEffect(() => {
    transfersRef.current = transfers;
  }, [transfers]);

  useEffect(() => () => {
    for (const entry of autoResumeTimersRef.current.values()) {
      window.clearTimeout(entry.timer);
    }
    autoResumeTimersRef.current.clear();
  }, []);

  useEffect(() => {
    shellProfileIdsRef.current = shellProfileIds;
  }, [shellProfileIds]);

  const handleSessionStateChanged = useCallback((sessionId: string, state: SessionInfo["state"]) => {
    setSessions((current) =>
      current.map((session) => session.id === sessionId ? { ...session, state } : session)
    );
    if (
      sessionId === activeProfileIdRef.current
      && !isConnectedState(state)
      && state !== "Connecting"
      && state !== "HostKeyPending"
      && state !== "Reconnecting"
    ) {
      setLatencyMs(null);
      setLatencyStatus("\u65ad\u5f00");
    }
    appendSessionStateNotice(sessionId, state);
  }, [appendSessionStateNotice]);

  const handleTerminalOutput = useCallback((output: TerminalOutput) => {
    clearSessionHealthFailures(output.session_id, latencyTimeoutCountRef.current);
    consumeTerminalOutput(output);
  }, [consumeTerminalOutput]);

  const handleHostKeyPrompt = useCallback((prompt: HostKeyPrompt) => {
    setHostKeySubmitting(false);
    setHostKeyPrompts((current) => enqueueHostKeyPrompt(current, prompt));
  }, []);

  const hostKeyPrompt = hostKeyPrompts[0] ?? null;

  const resolveCurrentHostKeyPrompt = useCallback(async (accepted: boolean) => {
    if (!hostKeyPrompt || hostKeySubmitting) return;
    setHostKeySubmitting(true);
    try {
      await desktopClient.resolveHostKeyPrompt(
        hostKeyPrompt.token,
        hostKeyPrompt.session_id,
        accepted ? (hostKeyPrompt.reason === "changed" ? "update" : "accept") : "reject"
      );
      setHostKeyPrompts((current) => removeHostKeyPrompt(current, hostKeyPrompt.token));
    } catch (error) {
      flash(error instanceof Error ? error.message : String(error));
    } finally {
      setHostKeySubmitting(false);
    }
  }, [flash, hostKeyPrompt, hostKeySubmitting]);

  useSessionEvents({
    onStateChanged: handleSessionStateChanged,
    onTerminalOutput: handleTerminalOutput,
    onSftpProgress: upsertTransfer,
    onHostKeyPrompt: handleHostKeyPrompt
  });
  const activeShellProfileId = activeProfileId
    ? shellProfileIds[activeProfileId] ?? activeProfileId
    : null;
  const activeProfile = useMemo(
    () => profiles.find((profile) => profile.id === activeShellProfileId),
    [activeShellProfileId, profiles]
  );

  const activeSession = useMemo(
    () => sessions.find((session) => session.id === activeProfileId && isConnectedState(session.state)),
    [activeProfileId, sessions]
  );

  const selectedRemoteEntry = useMemo(
    () => sftpListing?.entries.find((entry) => entry.path === selectedRemotePath) ?? null,
    [selectedRemotePath, sftpListing]
  );

  const contextTransfer = useMemo(
    () => contextMenu?.kind === "transfer"
      ? transfers.find((transfer) => transfer.id === contextMenu.transferId) ?? null
      : null,
    [contextMenu, transfers]
  );

  const contextProfile = useMemo(
    () => contextMenu?.kind === "session"
      ? profiles.find((profile) => profile.id === contextMenu.profileId) ?? null
      : null,
    [contextMenu, profiles]
  );

  const contextFolder = useMemo(
    () => contextMenu?.kind === "folder"
      ? folders.find((folder) => folder.id === contextMenu.folderId) ?? null
      : null,
    [contextMenu, folders]
  );

  const contextTabProfile = useMemo(
    () => contextMenu?.kind === "tab"
      ? profiles.find((profile) => profile.id === contextMenu.profileId) ?? null
      : null,
    [contextMenu, profiles]
  );
  const contextTabShellId = contextMenu?.kind === "tab" ? contextMenu.shellId ?? null : null;
  const contextProfileShellIds = useMemo(
    () => contextProfile
      ? openProfileIds.filter((shellId) => (shellProfileIds[shellId] ?? shellId) === contextProfile.id)
      : [],
    [contextProfile, openProfileIds, shellProfileIds]
  );

  const normalizedSessionSearch = sessionSearchQuery.trim().toLowerCase();
  const filteredProfiles = useMemo(() => {
    if (!normalizedSessionSearch) {
      return profiles;
    }

    const folderNameByProfileGroup = new Map(folders.map((folder) => [folder.name, folder.name.toLowerCase()]));
    return profiles.filter((profile) => profileMatchesSearch(profile, normalizedSessionSearch, folderNameByProfileGroup));
  }, [folders, normalizedSessionSearch, profiles]);

  const groupedProfiles = useMemo(
    () => buildProfileGroups(filteredProfiles, folders, sidebarSortMode),
    [filteredProfiles, folders, sidebarSortMode]
  );

  const visibleGroupedProfiles = useMemo(
    () => normalizedSessionSearch
      ? groupedProfiles.filter((group) => (
        group.profiles.length > 0 || group.name.toLowerCase().includes(normalizedSessionSearch)
      ))
      : groupedProfiles,
    [groupedProfiles, normalizedSessionSearch]
  );

  const toggleSessionFolderCollapsed = useCallback((groupId: string) => {
    setCollapsedSessionFolderIds((current) => {
      const next = new Set(current);
      if (next.has(groupId)) {
        next.delete(groupId);
      } else {
        next.add(groupId);
      }
      return next;
    });
  }, []);

  useEffect(() => {
    setCollapsedSessionFolderIds((current) => {
      const validIds = new Set(["ungrouped", ...folders.map((folder) => folder.id)]);
      let changed = false;
      const next = new Set<string>();
      for (const id of current) {
        if (validIds.has(id)) {
          next.add(id);
        } else {
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [folders]);

  useEffect(() => {
    saveCollapsedSessionFolders(collapsedSessionFolderIds);
  }, [collapsedSessionFolderIds]);

  const openShellTabs = useMemo(
    () => openProfileIds
      .map((id) => {
        const profileId = shellProfileIds[id] ?? id;
        const profile = profiles.find((item) => item.id === profileId);
        return profile ? { id, profile } : null;
      })
      .filter((tab): tab is { id: string; profile: SessionProfile } => Boolean(tab)),
    [openProfileIds, profiles, shellProfileIds]
  );

  const activeProfileIndex = useMemo(
    () => openShellTabs.findIndex((tab) => tab.id === activeProfileId),
    [activeProfileId, openShellTabs]
  );

  const connectedSessions = useMemo(
    () => sessions.filter((session) => isConnectedState(session.state)),
    [sessions]
  );
  const connectedSessionIds = useMemo(
    () => new Set(connectedSessions.map((session) => session.id)),
    [connectedSessions]
  );
  const pendingSessionIds = useMemo(
    () => new Set(
      sessions
        .filter((session) => session.state === "Connecting" || session.state === "Reconnecting")
        .map((session) => session.id)
    ),
    [sessions]
  );
  const trackedSessionIds = useMemo(
    () => new Set(sessions.map((session) => session.id)),
    [sessions]
  );
  const connectedProfileIds = useMemo(
    () => new Set(connectedSessions.map((session) => session.profile_id)),
    [connectedSessions]
  );
  const pendingProfileIds = useMemo(
    () => new Set(
      sessions
        .filter((session) => session.state === "Connecting" || session.state === "Reconnecting")
        .map((session) => session.profile_id)
    ),
    [sessions]
  );
  const trackedProfileIds = useMemo(
    () => new Set(sessions.map((session) => session.profile_id)),
    [sessions]
  );

  useEffect(() => {
    if (!activeProfile) {
      activeProfileIdRef.current = null;
      replaceTerminalOutput(READY_TERMINAL_OUTPUT, "empty");
      return;
    }

    const shellId = activeProfileId ?? activeProfile.id;
    activeProfileIdRef.current = shellId;
    const cached = terminalCacheRef.current[shellId] ?? buildSelectedProfileSeed(activeProfile);
    replaceTerminalOutput(cached, shellId);
    window.setTimeout(() => terminalRef.current?.focus(), 0);
  }, [activeProfile, activeProfileId, replaceTerminalOutput]);

  useEffect(() => {
    systemSyncInFlightRef.current = false;
    systemSyncFailureCountRef.current = 0;
    if (!activeSession) {
      setSystemSnapshot(null);
      setSystemDerived(emptySystemDerived);
      setSystemStatus("等待连接");
      setSftpListing(null);
      setSelectedRemotePath(null);
      setSftpStatus("等待连接");
      previousSystemSnapshotRef.current = null;
      if (activeProfileId) {
        latencyTimeoutCountRef.current[activeProfileId] = 0;
      }
      return;
    }

    let cancelled = false;
    let timer: number | undefined;
    const pollTerminalTail = async () => {
      try {
        const sequence = terminalSequenceRef.current[activeSession.id];
        const batch = await terminalOutputBatch(activeSession.id, sequence ?? null);
        if (!cancelled) {
          syncTerminalOutputBatch(batch);
        }
      } catch {
        // Live terminal events remain the primary output path.
      } finally {
        if (!cancelled) {
          timer = window.setTimeout(() => void pollTerminalTail(), 500);
        }
      }
    };
    void pollTerminalTail();

    return () => {
      cancelled = true;
      if (timer !== undefined) {
        window.clearTimeout(timer);
      }
    };
  }, [activeSession?.id, syncTerminalOutputBatch]);

  useEffect(() => {
    const target = activeSession ? resolveLatencyTarget(activeProfile) : null;
    if (!target || !activeSession) {
      setLatencyMs(null);
      setLatencyStatus(activeProfileId && terminalDisconnectNoticeRef.current[activeProfileId] ? "断开" : "待连接");
      if (activeProfileId) {
        latencyTimeoutCountRef.current[activeProfileId] = 0;
      }
      return;
    }

    if (!isConnectedState(activeSession.state)) {
      setLatencyMs(null);
      setLatencyStatus("断开");
      if (activeSession.id) {
        latencyTimeoutCountRef.current[activeSession.id] = 0;
      }
      return;
    }

    let cancelled = false;
    let refreshInFlight = false;
    const confirmSessionReachable = async (sessionId: string) => {
      setLatencyMs(null);
      setLatencyStatus("确认中");
      try {
        const value = await measureSessionLatency(sessionId);
        if (cancelled) {
          return true;
        }
        if (value === null) {
          return false;
        }
        setLatencyMs(value);
        setLatencyStatus("SSH RTT");
        latencyTimeoutCountRef.current[sessionId] = 0;
        return true;
      } catch {
        return false;
      }
    };

    const refreshLatency = async () => {
      if (refreshInFlight) {
        return;
      }
      refreshInFlight = true;
      const sessionId = activeSession.id;
      try {
        if (shouldSkipActiveLatencyProbe(sessionId, Date.now(), {
          lastInputAt: lastTerminalInputAtRef.current,
          lastOutputAt: lastTerminalOutputAtRef.current,
          pendingInputAt: pendingInteractiveLatencyRef.current
        })) {
          if (interactiveLatencySamplesRef.current[sessionId]?.length) {
            setLatencyMs(averageLatencySamples(interactiveLatencySamplesRef.current[sessionId]));
            setLatencyStatus("交互平均");
          }
          return;
        }

        if (terminalDisconnectNoticeRef.current[sessionId]) {
          setLatencyMs(null);
          setLatencyStatus("断开");
          return;
        }

        setLatencyStatus("测量中");
        let tcpLatency: number | null = null;
        if (!activeProfile?.use_terminal_latency_probe) {
          try {
            tcpLatency = await measureLatency(target.host, target.port, false);
          } catch {
            tcpLatency = null;
          }
        }
        if (cancelled) {
          return;
        }

        const reachable = await confirmSessionReachable(sessionId);
        if (cancelled) {
          return;
        }
        if (!reachable) {
          recordSessionHealthFailure(sessionId);
          return;
        }
        if (tcpLatency !== null && !activeProfile?.use_terminal_latency_probe) {
          setLatencyMs(tcpLatency);
          setLatencyStatus("TCP RTT");
        }
      } finally {
        refreshInFlight = false;
      }
    };

    void refreshLatency();
    const timer = window.setInterval(() => {
      void refreshLatency();
    }, 3000);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [
    activeProfile?.host,
    activeProfile?.port,
    activeProfile?.use_terminal_latency_probe,
    activeProfileId,
    activeSession?.id,
    activeSession?.state,
    recordSessionHealthFailure
  ]);

  const openShellProfile = useCallback((profileId: string, forceNew = false) => {
    const existingShellId = forceNew
      ? undefined
      : openProfileIds.find((shellId) => (shellProfileIds[shellId] ?? shellId) === profileId);
    const shellId = existingShellId ?? (
      !forceNew && !openProfileIds.includes(profileId) ? profileId : crypto.randomUUID()
    );
    setShellProfileIds((current) => current[shellId] === profileId
      ? current
      : { ...current, [shellId]: profileId });
    setOpenProfileIds((current) => current.includes(shellId) ? current : [...current, shellId]);
    setActiveProfileId(shellId);
    return shellId;
  }, [openProfileIds, shellProfileIds]);

  const closeShellProfile = useCallback(async (shellId: string) => {
    setOpenProfileIds((current) => {
      const next = current.filter((id) => id !== shellId);
      if (activeProfileId === shellId) {
        setActiveProfileId(next.at(-1) ?? null);
      }
      return next;
    });
    setShellProfileIds((current) => {
      const next = { ...current };
      delete next[shellId];
      return next;
    });
    setSessions((current) => current.filter((session) => session.id !== shellId));
    clearTerminalCache(shellId);
    try {
      await disconnectProfile(shellId);
    } catch {
      // Closing a tab should still succeed if the session was already gone.
    }
  }, [activeProfileId, clearTerminalCache]);

  const closeAllShells = useCallback(async () => {
    const ids = [...openProfileIds];
    setOpenProfileIds([]);
    setShellProfileIds({});
    setActiveProfileId(null);
    setSessions((current) => current.filter((session) => !ids.includes(session.id)));
    ids.forEach(clearTerminalCache);
    await Promise.all(ids.map((id) => disconnectProfile(id).catch(() => undefined)));
  }, [clearTerminalCache, openProfileIds]);

  const moveProfileToFolder = useCallback(async (profileId: string, folderName: string | null) => {
    const profile = profiles.find((item) => item.id === profileId);
    if (!profile) {
      return;
    }
    const nextProfile = { ...profile, group: folderName };
    setProfiles((current) => current.map((item) => item.id === profileId ? nextProfile : item));
    try {
      await saveProfile(nextProfile);
      flash(folderName ? `已移动到 ${folderName}` : "已移动到未分组");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setProfiles((current) => current.map((item) => item.id === profileId ? profile : item));
      flash(`移动失败：${message}`);
    }
  }, [flash, profiles]);

  const persistProfileOrder = useCallback((nextProfiles: SessionProfile[]) => {
    const ordered = normalizeProfileSortOrders(nextProfiles);
    profilesRef.current = ordered;
    setProfiles(ordered);
    void Promise.all(ordered.map((profile) => saveProfile(profile))).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      flash(`排序保存失败：${message}`);
    });
  }, [flash]);

  const moveProfilePosition = useCallback((profileId: string, action: "up" | "down" | "top" | "bottom") => {
    const profile = profilesRef.current.find((item) => item.id === profileId);
    if (!profile) {
      return;
    }
    setSidebarSortMode("custom");
    const nextProfiles = moveProfileWithinCurrentGroup(profilesRef.current, profileId, action);
    persistProfileOrder(nextProfiles);
  }, [persistProfileOrder]);

  const getDraggedProfileId = useCallback((event: React.DragEvent) => (
    event.dataTransfer.getData(PROFILE_DRAG_TYPE) || draggedProfileIdRef.current
  ), []);

  const acceptProfileFolderDrag = useCallback((event: React.DragEvent, folderId: string) => {
    if (!draggedProfileIdRef.current && !Array.from(event.dataTransfer.types).includes(PROFILE_DRAG_TYPE)) {
      debugDrag("folder drag ignored", { folderId, types: Array.from(event.dataTransfer.types), ref: draggedProfileIdRef.current });
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    event.dataTransfer.dropEffect = "move";
    setDragOverFolderId(folderId);
    debugDrag("folder drag accepted", { folderId, types: Array.from(event.dataTransfer.types), ref: draggedProfileIdRef.current });
  }, []);

  const dropProfileToFolder = useCallback((event: React.DragEvent, group: { id: string; name: string }) => {
    event.preventDefault();
    event.stopPropagation();
    const profileId = getDraggedProfileId(event);
    draggedProfileIdRef.current = null;
    setDragOverFolderId(null);
    debugDrag("folder drop", { group, profileId, types: Array.from(event.dataTransfer.types) });
    if (profileId) {
      void moveProfileToFolder(profileId, group.id === "ungrouped" ? null : group.name);
    }
  }, [getDraggedProfileId, moveProfileToFolder]);

  const reorderOpenTab = useCallback((draggedId: string, targetId: string, position: "before" | "after" = "before") => {
    if (draggedId === targetId) {
      return;
    }
    setOpenProfileIds((current) => {
      const from = current.indexOf(draggedId);
      const to = current.indexOf(targetId);
      if (from < 0 || to < 0) {
        return current;
      }
      const next = [...current];
      const [item] = next.splice(from, 1);
      const adjustedTo = next.indexOf(targetId);
      next.splice(adjustedTo + (position === "after" ? 1 : 0), 0, item);
      return next;
    });
  }, []);

  const moveOpenTabToEnd = useCallback((draggedId: string) => {
    setOpenProfileIds((current) => {
      if (!current.includes(draggedId) || current.at(-1) === draggedId) {
        return current;
      }
      return [...current.filter((id) => id !== draggedId), draggedId];
    });
  }, []);

  const getDraggedTabId = useCallback((event: React.DragEvent) => (
    event.dataTransfer.getData(TAB_DRAG_TYPE) || draggedTabProfileIdRef.current
  ), []);

  const beginPointerDrag = useCallback((
    event: React.PointerEvent<HTMLElement>,
    item: Pick<PointerDragState, "kind" | "id" | "label">
  ) => {
    if (event.button !== 0) {
      return;
    }

    const source = event.currentTarget;
    const state: PointerDragState = {
      ...item,
      startX: event.clientX,
      startY: event.clientY,
      dragging: false
    };
    source.setPointerCapture?.(event.pointerId);
    pointerDragRef.current = state;
    debugDrag("pointer drag begin", item);

    const clearPointerDrag = () => {
      window.removeEventListener("pointermove", onPointerMove, true);
      window.removeEventListener("pointerup", onPointerUp, true);
      window.removeEventListener("pointercancel", onPointerCancel, true);
      setDragOverFolderId(null);
      setDragIndicator(null);
      dragIndicatorRef.current = null;
      pointerDragRef.current = null;
    };

    const onPointerMove = (moveEvent: PointerEvent) => {
      const current = pointerDragRef.current;
      if (!current) {
        return;
      }
      const deltaX = moveEvent.clientX - current.startX;
      const deltaY = moveEvent.clientY - current.startY;
      if (!current.dragging && Math.hypot(deltaX, deltaY) < 6) {
        return;
      }

      if (!current.dragging) {
        current.dragging = true;
        source.classList.add("dragging");
        debugDrag("pointer drag active", current);
      }

      moveEvent.preventDefault();
      moveEvent.stopPropagation();

      if (current.kind === "profile") {
        const indicator = findProfileDropIndicator(
          moveEvent.clientX,
          moveEvent.clientY,
          current.id
        );
        setSidebarSortMode("custom");
        setDragOverFolderId(indicator?.groupId ?? null);
        dragIndicatorRef.current = indicator
          ? { ...indicator, kind: "profile", draggedId: current.id }
          : null;
        setDragIndicator(dragIndicatorRef.current);
      } else {
        const indicator = findTabDropIndicator(moveEvent.clientX, current.id);
        dragIndicatorRef.current = indicator
          ? { ...indicator, kind: "tab", draggedId: current.id }
          : null;
        setDragIndicator(dragIndicatorRef.current);
      }
    };

    const onPointerUp = (upEvent: PointerEvent) => {
      const current = pointerDragRef.current;
      source.classList.remove("dragging");
      source.releasePointerCapture?.(event.pointerId);
      if (!current) {
        clearPointerDrag();
        return;
      }

      if (current.dragging) {
        suppressNextClickRef.current = true;
        window.setTimeout(() => {
          suppressNextClickRef.current = false;
        }, 0);
        upEvent.preventDefault();
        upEvent.stopPropagation();

        if (current.kind === "profile") {
          const indicator = dragIndicatorRef.current?.kind === "profile"
            ? dragIndicatorRef.current
            : findProfileDropIndicator(upEvent.clientX, upEvent.clientY, current.id);
          debugDrag("pointer profile drop", { id: current.id, indicator });
          if (indicator?.groupId) {
            const next = reorderProfileByPointer(
              profilesRef.current,
              folders,
              current.id,
              indicator.targetId,
              indicator.groupId,
              indicator.position === "after" ? indicator.clientY + 9999 : indicator.clientY
            );
            persistProfileOrder(next);
          }
        } else {
          const indicator = dragIndicatorRef.current?.kind === "tab"
            ? dragIndicatorRef.current
            : findTabDropIndicator(upEvent.clientX, current.id);
          debugDrag("pointer tab drop", { id: current.id, indicator });
          if (indicator?.targetId) {
            reorderOpenTab(current.id, indicator.targetId, indicator.position);
          } else if (indicator) {
            moveOpenTabToEnd(current.id);
          }
        }
      }

      clearPointerDrag();
    };

    const onPointerCancel = () => {
      source.classList.remove("dragging");
      source.releasePointerCapture?.(event.pointerId);
      clearPointerDrag();
    };

    window.addEventListener("pointermove", onPointerMove, true);
    window.addEventListener("pointerup", onPointerUp, true);
    window.addEventListener("pointercancel", onPointerCancel, true);
  }, [folders, moveOpenTabToEnd, persistProfileOrder, reorderOpenTab]);

  const refreshSystemSnapshot = useCallback(async () => {
    if (!activeSession) {
      setSystemStatus("未连接");
      return;
    }
    if (systemSyncInFlightRef.current) {
      return;
    }
    systemSyncInFlightRef.current = true;

    try {
      const snapshot = await collectSystemSnapshot(activeSession.id);
      const previous = previousSystemSnapshotRef.current;
      setSystemSnapshot(snapshot);
      const detectedOs = snapshot.host.os_name.trim();
      if (detectedOs) {
        setProfiles((current) => current.map((profile) =>
          profile.id === activeSession.profile_id && profile.operating_system !== detectedOs
            ? { ...profile, operating_system: detectedOs }
            : profile
        ));
      }
      setSystemDerived(deriveSystemStats(previous, snapshot));
      previousSystemSnapshotRef.current = snapshot;
      systemSyncFailureCountRef.current = 0;
      setSystemStatus("已同步");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      systemSyncFailureCountRef.current += 1;
      setSystemDerived(emptySystemDerived);
      setSystemStatus(
        systemSyncFailureCountRef.current < 3
          ? `同步重试中 ${systemSyncFailureCountRef.current}/3`
          : `同步失败：${message}`
      );
      if (systemSyncFailureCountRef.current >= 3) {
        const sessionId = activeSession.id;
        void measureSessionLatency(sessionId).then((value) => {
          if (value === null) {
            recordSessionHealthFailure(sessionId);
          } else {
            latencyTimeoutCountRef.current[sessionId] = 0;
          }
        }).catch(() => {
          recordSessionHealthFailure(sessionId);
        });
      }
    } finally {
      systemSyncInFlightRef.current = false;
    }
  }, [activeSession, recordSessionHealthFailure]);

  const refreshSftpListing = useCallback(async (path = sftpPath) => {
    if (!activeSession) {
      setSftpStatus("请先连接 SSH");
      return;
    }

    setSftpBusy(true);
    setSftpStatus("正在读取目录");
    try {
      const listing = await sftpListDirectory(activeSession.id, path);
      setSftpListing(listing);
      setSftpPath(listing.path);
      setSelectedRemotePath(null);
      setSftpStatus(`已读取 ${listing.entries.length} 项`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setSftpStatus(`读取失败：${message}`);
      flash(`SFTP 读取失败：${message}`);
    } finally {
      setSftpBusy(false);
    }
  }, [activeSession, flash, sftpPath]);

  useEffect(() => {
    if (!activeSession) {
      return;
    }
    setSftpListing(null);
    setSftpPath(".");
    setSelectedRemotePath(null);
    void refreshSftpListing(".");
  }, [activeSession?.id]);

  useEffect(() => {
    if (!activeSession) {
      return;
    }

    void refreshSystemSnapshot();
    const timer = window.setInterval(() => {
      void refreshSystemSnapshot();
    }, 2000);

    return () => {
      window.clearInterval(timer);
    };
  }, [activeSession?.id, refreshSystemSnapshot]);

  const connectSelectedProfile = useCallback(async (profile: SessionProfile, requestedShellId?: string) => {
    const shellId = requestedShellId ?? openShellProfile(profile.id);
    if (connectedSessionIds.has(shellId)) {
      setActiveProfileId(shellId);
      window.setTimeout(() => terminalRef.current?.focus(), 0);
      return;
    }
    setShellProfileIds((current) => ({ ...current, [shellId]: profile.id }));
    setOpenProfileIds((current) => current.includes(shellId) ? current : [...current, shellId]);
    setActiveProfileId(shellId);
    setConnecting(true);
    resetTerminalRuntimeOutputCursor(shellId);
    replaceTerminalOutput(buildConnectingTerminalSeed(profile), shellId);

    try {
      const session = await connectProfile(profile.id, shellId);
      setSessions((current) => [
        session,
        ...current.filter((item) => item.id !== session.id)
      ]);
      const batch = await terminalOutputBatch(session.id, null);
      syncTerminalOutputBatch(batch);
      window.setTimeout(() => terminalRef.current?.focus(), 0);
      flash(`已连接 ${session.profile_name}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setSessions((current) => current.filter((item) => item.id !== shellId));
      replaceTerminalOutput(buildFailedTerminalSeed(profile, message), shellId);
      flash(`连接失败：${message}`);
    } finally {
      setConnecting(false);
    }
  }, [connectedSessionIds, flash, openShellProfile, replaceTerminalOutput, resetTerminalRuntimeOutputCursor, syncTerminalOutputBatch]);

  const handleProfileDoubleClick = useCallback(async (profile: SessionProfile) => {
    const decision = resolveProfileDoubleClickDecision({
      profileId: profile.id,
      openShellIds: openProfileIds,
      shellProfileIds,
      connectedSessionIds,
      action: layoutSettings.connected_profile_double_click_action
    });
    if (decision.kind === "activate") {
      setActiveProfileId(decision.shellId);
      window.setTimeout(() => terminalRef.current?.focus(), 0);
      return;
    }
    if (decision.kind === "create") {
      const shellId = openShellProfile(profile.id, true);
      await connectSelectedProfile(profile, shellId);
      return;
    }
    const shellId = decision.shellId ?? openShellProfile(profile.id);
    await connectSelectedProfile(profile, shellId);
  }, [connectSelectedProfile, connectedSessionIds, layoutSettings.connected_profile_double_click_action, openProfileIds, openShellProfile, shellProfileIds]);

  const connect = useCallback(async () => {
    if (!activeProfile) {
      setEditingProfile(createUniqueBlankProfile(profiles));
      setSettingsOpen(true);
      flash("请先添加 SSH 连接参数");
      return;
    }

    await connectSelectedProfile(activeProfile, activeProfileId ?? undefined);
  }, [activeProfile, activeProfileId, connectSelectedProfile, flash, profiles]);

  const handleInput = useCallback(
    (data: string) => {
      setTerminalInputCount((count) => count + 1);
      const targetSessionId = activeSession?.id;
      if (!targetSessionId) {
        if (activeProfileId) {
          appendSessionStateNotice(activeProfileId, "Disconnected");
        }
        return;
      }
      const startedAt = Date.now();
      lastTerminalInputAtRef.current[targetSessionId] = startedAt;
      pendingInteractiveLatencyRef.current[targetSessionId] = startedAt;
      void writeTerminal(targetSessionId, data).catch((error) => {
        delete pendingInteractiveLatencyRef.current[targetSessionId];
        const message = error instanceof Error ? error.message : String(error);
        terminalRef.current?.write(`\r\n[local input failed] ${message}\r\n`);
        void sessionDiagnostics(targetSessionId).then((diagnostics) => {
          terminalRef.current?.write(`[diagnostics] ${diagnostics}\r\n`);
        });
      });
    },
    [activeProfileId, activeSession?.id, appendSessionStateNotice]
  );

  const sendCommandDraft = useCallback(() => {
    const command = commandDraft.trim();
    if (!command) {
      terminalRef.current?.focus();
      return;
    }
    const targetSessionId = activeSession?.id;
    if (!targetSessionId) {
      if (activeProfileId) {
        appendSessionStateNotice(activeProfileId, "Disconnected");
      }
      flash("请先连接 SSH session");
      return;
    }
    void writeTerminal(targetSessionId, `${command}\r`).then(() => {
      terminalRef.current?.focus();
    }).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      terminalRef.current?.write(`\r\n[local send failed] ${message}\r\n`);
      void sessionDiagnostics(targetSessionId).then((diagnostics) => {
        terminalRef.current?.write(`[diagnostics] ${diagnostics}\r\n`);
      });
      flash(`命令发送失败：${message}`);
    });
    setCommandDraft("");
  }, [activeProfileId, activeSession?.id, appendSessionStateNotice, commandDraft, flash]);

  const resolveCommandTargetSessions = useCallback(() => {
    if (commandSendMode === "current") {
      return activeSession ? [activeSession] : [];
    }
    if (commandSendMode === "all") {
      return connectedSessions;
    }
    return connectedSessions.filter((session) => selectedCommandTargets[session.id]);
  }, [activeSession, commandSendMode, connectedSessions, selectedCommandTargets]);

  const sendStoredCommand = useCallback(async (command: string) => {
    const cleanCommand = command.trim();
    if (!cleanCommand) {
      flash("命令为空");
      return;
    }
    const targets = resolveCommandTargetSessions();
    if (targets.length === 0) {
      flash("没有可发送的已连接会话");
      return;
    }
    try {
      await Promise.all(targets.map((session) => writeTerminal(session.id, `${cleanCommand}\r`)));
      flash(`已发送到 ${targets.length} 台设备`);
      terminalRef.current?.focus();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      flash(`命令发送失败：${message}`);
    }
  }, [flash, resolveCommandTargetSessions]);

  const saveCommandDraft = useCallback(async () => {
    const title = commandTitleDraft.trim();
    const command = commandBodyDraft.trim();
    if (!title || !command) {
      flash("请填写命令名称和命令内容");
      return;
    }
    const snippet: CommandSnippet = {
      id: editingCommandId ?? crypto.randomUUID(),
      title,
      command,
      tags: []
    };
    try {
      const saved = await saveCommandSnippet(snippet);
      setCommandSnippets((current) => {
        const exists = current.some((item) => item.id === saved.id);
        return exists
          ? current.map((item) => item.id === saved.id ? saved : item)
          : [saved, ...current];
      });
      setEditingCommandId(null);
      setCommandTitleDraft("");
      setCommandBodyDraft("");
      flash(`已保存命令 ${saved.title}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      flash(`命令保存失败：${message}`);
    }
  }, [commandBodyDraft, commandTitleDraft, editingCommandId, flash]);

  const editStoredCommand = useCallback((snippet: CommandSnippet) => {
    setEditingCommandId(snippet.id);
    setCommandTitleDraft(snippet.title);
    setCommandBodyDraft(snippet.command);
    setActiveBottomView("commands");
  }, []);

  const deleteStoredCommand = useCallback(async (snippet: CommandSnippet) => {
    try {
      await deleteCommandSnippet(snippet.id);
      setCommandSnippets((current) => current.filter((item) => item.id !== snippet.id));
      if (editingCommandId === snippet.id) {
        setEditingCommandId(null);
        setCommandTitleDraft("");
        setCommandBodyDraft("");
      }
      flash(`已删除命令 ${snippet.title}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      flash(`命令删除失败：${message}`);
    }
  }, [editingCommandId, flash]);

  const printDiagnostics = useCallback(() => {
    const targetSessionId = activeSession?.id ?? activeProfile?.id;
    if (!targetSessionId) {
      terminalRef.current?.write("\r\n[diagnostics] no active profile/session\r\n");
      return;
    }
    void sessionDiagnostics(targetSessionId).then((diagnostics) => {
      terminalRef.current?.write(`\r\n[diagnostics] ${diagnostics}\r\n`);
      terminalRef.current?.focus();
    }).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      terminalRef.current?.write(`\r\n[diagnostics failed] ${message}\r\n`);
    });
  }, [activeProfile?.id, activeSession?.id]);

  const openRemoteEntry = useCallback((entry: RemoteFileEntry) => {
    setSelectedRemotePath(entry.path);
    if (entry.is_dir) {
      void refreshSftpListing(entry.path);
    }
  }, [refreshSftpListing]);

  const goParentDirectory = useCallback(() => {
    if (sftpListing?.parent) {
      void refreshSftpListing(sftpListing.parent);
    }
  }, [refreshSftpListing, sftpListing?.parent]);

  const requestTextInput = useCallback((dialog: TextInputDialogState) => new Promise<string | null>((resolve) => {
    textInputDialogResolverRef.current?.(null);
    textInputDialogResolverRef.current = resolve;
    setTextInputDialog(dialog);
  }), []);

  const closeTextInputDialog = useCallback((value: string | null) => {
    textInputDialogResolverRef.current?.(value);
    textInputDialogResolverRef.current = null;
    setTextInputDialog(null);
  }, []);

  const createRemoteDirectory = useCallback(async () => {
    if (!activeSession) {
      flash("请先连接 SSH session");
      return;
    }
    const name = await requestTextInput({
      title: "新建远程目录",
      label: "目录名称",
      initialValue: "new-folder",
      placeholder: "new-folder",
      confirmLabel: "创建"
    });
    const cleanName = name?.trim();
    if (!cleanName) {
      return;
    }
    if (cleanName.includes("/") || cleanName.includes("\\")) {
      flash("目录名不能包含路径分隔符");
      return;
    }
    const target = joinRemotePath(sftpPath, cleanName);
    setSftpBusy(true);
    try {
      await sftpCreateDir(activeSession.id, target);
      flash(`已创建目录 ${cleanName}`);
      await refreshSftpListing(sftpPath);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      flash(`创建目录失败：${message}`);
      setSftpStatus(`创建失败：${message}`);
    } finally {
      setSftpBusy(false);
    }
  }, [activeSession, flash, refreshSftpListing, requestTextInput, sftpPath]);

  const startRemoteEntryRename = useCallback((entry = selectedRemoteEntry) => {
    if (!entry) {
      flash("请先选择远程文件或目录");
      return;
    }
    setSelectedRemotePath(entry.path);
    setEditingRemotePath(entry.path);
    setRemoteNameDraft(entry.name);
  }, [flash, selectedRemoteEntry]);

  const cancelRemoteEntryRename = useCallback(() => {
    setEditingRemotePath(null);
    setRemoteNameDraft("");
  }, []);

  const commitRemoteEntryRename = useCallback(async (entry: RemoteFileEntry, name: string) => {
    if (!activeSession) {
      cancelRemoteEntryRename();
      flash("请先连接 SSH session");
      return;
    }
    const cleanName = name.trim();
    if (!cleanName || cleanName === entry.name) {
      cancelRemoteEntryRename();
      return;
    }
    if (cleanName.includes("/") || cleanName.includes("\\")) {
      flash("文件名不能包含路径分隔符");
      return;
    }
    const target = joinRemotePath(remoteParentDir(entry.path), cleanName);
    cancelRemoteEntryRename();
    setSftpBusy(true);
    try {
      await sftpRenamePath(activeSession.id, entry.path, target);
      flash(`已重命名为 ${cleanName}`);
      await refreshSftpListing(sftpPath);
      setSelectedRemotePath(target);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      flash(`重命名失败：${message}`);
      setSftpStatus(`重命名失败：${message}`);
    } finally {
      setSftpBusy(false);
    }
  }, [activeSession, cancelRemoteEntryRename, flash, refreshSftpListing, sftpPath]);

  const requestDangerConfirmation = useCallback((message: string, title = "确认删除") => new Promise<boolean>((resolve) => {
    dangerConfirmResolverRef.current?.(false);
    dangerConfirmResolverRef.current = resolve;
    setDangerConfirm({ title, message });
  }), []);

  const closeDangerConfirmation = useCallback((confirmed: boolean) => {
    dangerConfirmResolverRef.current?.(confirmed);
    dangerConfirmResolverRef.current = null;
    setDangerConfirm(null);
  }, []);

  const deleteRemoteEntry = useCallback(async () => {
    if (!activeSession || !selectedRemoteEntry) {
      flash("请先选择远程文件或目录");
      return;
    }
    if (!layoutSettings.skip_delete_confirmations && !await requestDangerConfirmation(`确认删除远程${selectedRemoteEntry.is_dir ? "目录" : "文件"}：${selectedRemoteEntry.path}`)) {
      return;
    }
    setSftpBusy(true);
    try {
      await sftpDeletePath(activeSession.id, selectedRemoteEntry.path, selectedRemoteEntry.is_dir);
      flash(`已删除 ${selectedRemoteEntry.name}`);
      await refreshSftpListing(sftpPath);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      flash(`删除失败：${message}`);
      setSftpStatus(`删除失败：${message}`);
    } finally {
      setSftpBusy(false);
    }
  }, [activeSession, flash, layoutSettings.skip_delete_confirmations, refreshSftpListing, requestDangerConfirmation, selectedRemoteEntry, sftpPath]);

  const uploadLocalPaths = useCallback(async (paths: string[]) => {
    if (!activeSession) {
      flash("请先连接 SSH session");
      return;
    }
    const normalizedPaths = paths.filter(Boolean);
    if (normalizedPaths.length === 0) {
      return;
    }

    setSftpBusy(true);
    setSftpStatus(`正在上传 ${normalizedPaths.length} 个文件`);
    try {
      for (const localPath of normalizedPaths) {
        const transferId = crypto.randomUUID();
        const localName = remoteBasename(localPath);
        const remotePath = joinRemotePath(sftpPath, localName);
        const pending = createTransferProgress({
          id: transferId,
          direction: "Upload",
          sessionId: activeSession.id,
          profileId: activeSession.profile_id,
          localPath,
          remotePath,
          status: "Running"
        });
        upsertTransfer(pending);
        try {
          const completed = await sftpUploadFile(activeSession.id, transferId, localPath, remotePath);
          upsertTransfer(completed, pending.id);
          if (transferNeedsAttention(completed)) {
            flash(`需要确认后继续：${localName}`);
            setSftpStatus("目标文件状态发生变化，等待处理");
            return;
          }
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          markTransferFailed(transferId, pending, message);
          throw error;
        }
      }
      flash(`已上传 ${normalizedPaths.length} 个文件`);
      await refreshSftpListing(sftpPath);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      flash(`上传失败：${message}`);
      setSftpStatus(`上传失败：${message}`);
    } finally {
      setSftpBusy(false);
    }
  }, [activeSession, flash, markTransferFailed, refreshSftpListing, sftpPath, upsertTransfer]);

  const uploadRemoteFile = useCallback(async () => {
    let selected: string | string[] | null = null;
    try {
      selected = await openDialog({
        multiple: true,
        directory: false,
        title: "选择要上传的文件"
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      flash(`无法打开上传文件选择器：${message}`);
      return;
    }
    if (!selected) {
      return;
    }
    const paths = Array.isArray(selected) ? selected : [selected];
    await uploadLocalPaths(paths);
  }, [flash, uploadLocalPaths]);

  const downloadRemoteEntry = useCallback(async () => {
    if (!activeSession || !selectedRemoteEntry || selectedRemoteEntry.is_dir) {
      flash("请先选择一个远程文件");
      return;
    }
    let localPath: string | null = null;
    try {
      localPath = await saveDialog({
        defaultPath: selectedRemoteEntry.name,
        title: "选择保存位置"
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      flash(`无法打开保存位置选择器：${message}`);
      return;
    }
    if (!localPath) {
      return;
    }
    const transferId = crypto.randomUUID();
    const pending = createTransferProgress({
      id: transferId,
      direction: "Download",
      sessionId: activeSession.id,
      profileId: activeSession.profile_id,
      localPath,
      remotePath: selectedRemoteEntry.path,
      bytesTotal: selectedRemoteEntry.size,
      status: "Running"
    });
    upsertTransfer(pending);
    setSftpBusy(true);
    try {
      const completed = await sftpDownloadFile(activeSession.id, transferId, selectedRemoteEntry.path, localPath);
      upsertTransfer(completed, pending.id);
      if (transferNeedsAttention(completed)) {
        flash(`文件状态发生变化，请选择处理方式：${selectedRemoteEntry.name}`);
        setSftpStatus("目标文件状态发生变化，等待处理");
        return;
      }
      flash(`下载完成：${selectedRemoteEntry.name}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      markTransferFailed(transferId, pending, message);
      flash(`下载失败：${message}`);
      setSftpStatus(`下载失败：${message}`);
    } finally {
      setSftpBusy(false);
    }
  }, [activeSession, flash, markTransferFailed, selectedRemoteEntry, upsertTransfer]);

  const cancelTransfer = useCallback(async (transfer: SftpProgress) => {
    if (!isTransferActive(transfer.status) || cancellingTransfers[transfer.id]) {
      return;
    }

    setCancellingTransfers((current) => ({
      ...current,
      [transfer.id]: true
    }));

    const scheduledRetry = autoResumeTimersRef.current.get(transfer.id);
    if (scheduledRetry) {
      window.clearTimeout(scheduledRetry.timer);
      autoResumeTimersRef.current.delete(transfer.id);
      autoResumedTransferIdsRef.current.delete(scheduledRetry.retryKey);
      upsertTransfer({
        ...transfer,
        status: "Cancelled",
        updated_at: new Date().toISOString()
      });
    }

    try {
      await cancelSftpTransfer(transfer.id);
      flash(`已发送取消请求：${remoteBasename(transfer.remote_path)}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setCancellingTransfers((current) => {
        const next = { ...current };
        delete next[transfer.id];
        return next;
      });
      flash(`取消失败：${message}`);
    }
  }, [cancellingTransfers, flash, upsertTransfer]);

  const pauseTransfer = useCallback(async (transfer: SftpProgress) => {
    if (!isTransferActive(transfer.status)) return;
    try {
      await pauseSftpTransfer(transfer.id);
      flash(`正在暂停：${remoteBasename(transfer.remote_path)}`);
    } catch (error) {
      flash(`暂停失败：${error instanceof Error ? error.message : String(error)}`);
    }
  }, [flash]);

  const closeContextMenu = useCallback(() => {
    setContextMenu(null);
  }, []);

  const openAppContextMenu = useCallback((kind: ContextMenuState["kind"], event: React.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    setContextMenu({
      kind,
      x: Math.max(8, Math.min(event.clientX, window.innerWidth - 228)),
      y: Math.max(8, Math.min(event.clientY, window.innerHeight - 268))
    });
  }, []);

  const openTransferContextMenu = useCallback((transfer: SftpProgress, event: React.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    setContextMenu({
      kind: "transfer",
      transferId: transfer.id,
      x: Math.max(8, Math.min(event.clientX, window.innerWidth - 248)),
      y: Math.max(8, Math.min(event.clientY, window.innerHeight - 300))
    });
  }, []);

  const openSessionContextMenu = useCallback((profile: SessionProfile, event: React.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    setContextMenu({
      kind: "session",
      profileId: profile.id,
      x: Math.max(8, Math.min(event.clientX, window.innerWidth - 248)),
      y: Math.max(8, Math.min(event.clientY, window.innerHeight - 260))
    });
  }, []);

  const openFolderContextMenu = useCallback((folderId: string, event: React.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    setContextMenu({
      kind: "folder",
      folderId,
      x: Math.max(8, Math.min(event.clientX, window.innerWidth - 248)),
      y: Math.max(8, Math.min(event.clientY, window.innerHeight - 220))
    });
  }, []);

  const openTabContextMenu = useCallback((profile: SessionProfile, shellId: string, event: React.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    setContextMenu({
      kind: "tab",
      profileId: profile.id,
      shellId,
      x: Math.max(8, Math.min(event.clientX, window.innerWidth - 248)),
      y: Math.max(8, Math.min(event.clientY, window.innerHeight - 220))
    });
  }, []);

  const openNewProfileDialogInFolder = useCallback((folderName: string | null) => {
    setEditingProfile(createUniqueBlankProfile(profiles, folderName));
    setSettingsOpen(true);
  }, [profiles]);

  const startSessionFolderRename = useCallback((folder: SessionFolder) => {
    setEditingFolderId(folder.id);
    setFolderNameDraft(folder.name);
  }, []);

  const cancelSessionFolderRename = useCallback(() => {
    setEditingFolderId(null);
    setFolderNameDraft("");
  }, []);

  const commitSessionFolderRename = useCallback(async (folder: SessionFolder, name: string) => {
    const cleanName = name.trim();
    if (!cleanName || cleanName === folder.name) {
      cancelSessionFolderRename();
      return;
    }
    if (folders.some((item) => item.id !== folder.id && item.name === cleanName)) {
      flash("已存在同名文件夹");
      return;
    }
    const nextFolder = { ...folder, name: cleanName };
    const affectedProfiles = profiles.filter((profile) => profile.group === folder.name);
    cancelSessionFolderRename();
    setFolders((current) => current.map((item) => item.id === folder.id ? nextFolder : item));
    setProfiles((current) => current.map((profile) => (
      profile.group === folder.name ? { ...profile, group: cleanName } : profile
    )));
    try {
      await saveFolder(nextFolder);
      await Promise.all(affectedProfiles.map((profile) => saveProfile({ ...profile, group: cleanName })));
      flash(`已重命名为 ${cleanName}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setFolders((current) => current.map((item) => item.id === folder.id ? folder : item));
      setProfiles((current) => current.map((profile) => (
        profile.group === cleanName ? { ...profile, group: folder.name } : profile
      )));
      flash(`重命名失败：${message}`);
    }
  }, [cancelSessionFolderRename, flash, folders, profiles]);

  const deleteSessionFolder = useCallback(async (folder: SessionFolder) => {
    const affectedCount = profiles.filter((profile) => profile.group === folder.name).length;
    const confirmed = layoutSettings.skip_delete_confirmations || await requestDangerConfirmation(
      affectedCount > 0
        ? `删除文件夹“${folder.name}”？其中 ${affectedCount} 台服务器会移动到“独立服务器”，服务器不会被删除。`
        : `删除空文件夹“${folder.name}”？`
    );
    if (!confirmed) {
      return;
    }

    const previousFolders = folders;
    const previousProfiles = profiles;
    setFolders((current) => current.filter((item) => item.id !== folder.id));
    setProfiles((current) => current.map((profile) => (
      profile.group === folder.name ? { ...profile, group: null } : profile
    )));

    try {
      const deletedName = await deleteFolder(folder.id);
      flash(deletedName ? `已删除文件夹 ${deletedName}` : "文件夹已不存在");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setFolders(previousFolders);
      setProfiles(previousProfiles);
      flash(`删除文件夹失败：${message}`);
    }
  }, [flash, folders, layoutSettings.skip_delete_confirmations, profiles, requestDangerConfirmation]);

  const deleteSessionProfile = useCallback(async (profile: SessionProfile) => {
    if (!layoutSettings.skip_delete_confirmations && !await requestDangerConfirmation(`删除服务器“${profile.name}”？保存的连接信息和密码记录也会删除。`)) {
      return;
    }
    const previousProfiles = profiles;
    const previousOpenIds = openProfileIds;
    const previousShellProfileIds = shellProfileIds;
    const previousSessions = sessions;
    const shellIds = Array.from(new Set([
      ...openProfileIds.filter((shellId) => (shellProfileIds[shellId] ?? shellId) === profile.id),
      ...sessions.filter((session) => session.profile_id === profile.id).map((session) => session.id)
    ]));
    setProfiles((current) => current.filter((item) => item.id !== profile.id));
    setOpenProfileIds((current) => current.filter((id) => !shellIds.includes(id)));
    setShellProfileIds((current) => Object.fromEntries(
      Object.entries(current).filter(([shellId]) => !shellIds.includes(shellId))
    ));
    setSessions((current) => current.filter((session) => session.profile_id !== profile.id));
    if (activeProfileId && shellIds.includes(activeProfileId)) {
      setActiveProfileId(null);
    }
    try {
      await Promise.all(shellIds.map((shellId) => disconnectProfile(shellId).catch(() => undefined)));
      const deleted = await deleteProfile(profile.id);
      for (const shellId of shellIds) {
        clearTerminalCache(shellId);
      }
      flash(deleted ? `已删除服务器 ${profile.name}` : "服务器已不存在");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setProfiles(previousProfiles);
      setOpenProfileIds(previousOpenIds);
      setShellProfileIds(previousShellProfileIds);
      setSessions(previousSessions);
      flash(`删除服务器失败：${message}`);
    }
  }, [activeProfileId, clearTerminalCache, flash, layoutSettings.skip_delete_confirmations, openProfileIds, profiles, requestDangerConfirmation, sessions, shellProfileIds]);

  const copyTerminalSelection = useCallback(async () => {
    const selected = terminalRef.current?.getSelection().trim();
    const text = selected || terminalMirrorRef.current.trim();
    if (!text) {
      flash("终端没有可复制内容");
      return;
    }
    try {
      await navigator.clipboard.writeText(text);
      flash("已复制终端内容");
    } catch {
      flash("复制失败");
    }
  }, [flash]);

  const pasteToTerminal = useCallback(async () => {
    const targetSessionId = activeSession?.id ?? activeProfile?.id;
    if (!targetSessionId) {
      flash("请先连接 SSH session");
      return;
    }
    try {
      const text = await navigator.clipboard.readText();
      if (!text) {
        return;
      }
      await writeTerminal(targetSessionId, text);
      flash("已粘贴到终端");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      flash(`粘贴失败：${message}`);
    }
  }, [activeProfile?.id, activeSession?.id, flash]);

  const selectAllTerminal = useCallback(() => {
    terminalRef.current?.selectAll();
  }, []);

  const clearTerminal = useCallback(() => {
    terminalRef.current?.clear();
  }, []);

  const copyTransferPath = useCallback(async (path: string, label: string) => {
    if (!path) {
      flash(`${label}为空`);
      return;
    }
    try {
      await navigator.clipboard.writeText(path);
      flash(`已复制${label}`);
    } catch {
      flash(`复制${label}失败`);
    }
  }, [flash]);

  const copyProfileAddress = useCallback(async (profile: SessionProfile) => {
    try {
      await navigator.clipboard.writeText(`${profile.username}@${profile.host}:${profile.port}`);
      flash("已复制服务器地址");
    } catch {
      flash("复制服务器地址失败");
    }
  }, [flash]);

  const openProfileSshSettings = useCallback((profile: SessionProfile) => {
    setEditingProfile(profile);
    setSettingsOpen(true);
  }, []);

  const revealTransferLocalPath = useCallback(async (transfer: SftpProgress) => {
    try {
      await revealLocalPath(transfer.local_path);
      flash("已打开本地位置");
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      flash(`打开失败：${message}`);
    }
  }, [flash]);

  const removeTransfer = useCallback(async (transfer: SftpProgress, deleteLocal = false) => {
    if (isTransferActive(transfer.status)) {
      return;
    }
    if (!layoutSettings.skip_delete_confirmations) {
      const action = deleteLocal ? "移除传输记录并删除本地文件" : "移除传输记录";
      if (!await requestDangerConfirmation(`${action}：${remoteBasename(transfer.remote_path)}？`)) {
        return;
      }
    }
    if (deleteLocal && transfer.local_path) {
      try {
        await deleteLocalFile(transfer.local_path);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        flash(`删除本地文件失败：${message}`);
        return;
      }
    }
    const scheduledRetry = autoResumeTimersRef.current.get(transfer.id);
    if (scheduledRetry) {
      window.clearTimeout(scheduledRetry.timer);
      autoResumeTimersRef.current.delete(transfer.id);
      autoResumedTransferIdsRef.current.delete(scheduledRetry.retryKey);
    }
    removeTransferRecord(transfer.id);
    flash(deleteLocal ? "已移除记录并删除本地文件" : "已移除传输记录");
  }, [deleteLocalFile, flash, layoutSettings.skip_delete_confirmations, removeTransferRecord, requestDangerConfirmation]);

  const retryTransfer = useCallback(async (transfer: SftpProgress) => {
    const session = sessions.find((item) => item.id === transfer.session_id && isConnectedState(item.state))
      ?? sessions.find((item) => item.profile_id === transfer.profile_id && isConnectedState(item.state));
    if (!session) {
      flash("请先重新连接该 SSH 会话");
      return;
    }

    const transferId = transfer.id;
    const pending: SftpProgress = {
      ...transfer,
      session_id: session.id,
      profile_id: session.profile_id,
      status: "Running",
      updated_at: new Date().toISOString(),
      retry_count: (transfer.retry_count ?? 0) + 1,
      last_error: null
    };
    upsertTransfer(pending);

    try {
      const completed = transfer.direction === "Upload"
        ? await sftpUploadFile(session.id, transferId, transfer.local_path, transfer.remote_path)
        : await sftpDownloadFile(session.id, transferId, transfer.remote_path, transfer.local_path);
      upsertTransfer(completed, pending.id);
      flash(transferNeedsAttention(completed)
        ? `文件状态发生变化，请选择处理方式：${remoteBasename(transfer.remote_path)}`
        : `重试完成：${remoteBasename(transfer.remote_path)}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      markTransferFailed(transferId, pending, message);
      flash(`重试失败：${message}`);
    }
  }, [flash, markTransferFailed, sessions, upsertTransfer]);

  useEffect(() => {
    if (transferConflict) {
      const current = transfers.find((item) => item.id === transferConflict.id);
      if (!current || typeof current.status !== "object" || !("NeedsAttention" in current.status)) {
        setTransferConflict(null);
      }
      return;
    }
    const pendingConflict = transfers.find((item) => typeof item.status === "object" && "NeedsAttention" in item.status);
    if (pendingConflict) setTransferConflict(pendingConflict);
  }, [transferConflict, transfers]);

  const resolveTransferConflict = useCallback(async (decision: "restart" | "continue" | "cancel") => {
    if (!transferConflict || transferConflictSubmitting) return;
    if (decision !== "cancel") {
      const session = sessions.find((item) => item.id === transferConflict.session_id && isConnectedState(item.state))
        ?? sessions.find((item) => item.profile_id === transferConflict.profile_id && isConnectedState(item.state));
      if (!session) {
        flash("请先连接对应的 SSH 会话，再处理传输冲突");
        return;
      }
    }
    setTransferConflictSubmitting(true);
    try {
      await desktopClient.resolveTransferConflict(transferConflict.id, decision);
      if (decision === "cancel") {
        upsertTransfer({ ...transferConflict, status: "Cancelled", updated_at: new Date().toISOString() });
      } else {
        await retryTransfer(transferConflict);
      }
      setTransferConflict(null);
    } catch (error) {
      flash(`冲突处理失败：${error instanceof Error ? error.message : String(error)}`);
    } finally {
      setTransferConflictSubmitting(false);
    }
  }, [flash, retryTransfer, sessions, transferConflict, transferConflictSubmitting, upsertTransfer]);

  useEffect(() => {
    for (const transfer of transfers) {
      const reason = recoverableTransferFailureReason(transfer);
      const retryCount = transfer.retry_count ?? 0;
      const retryKey = `${transfer.id}:${retryCount}`;
      if (!isRecoverableTransferFailure(reason) || retryCount >= 5 || autoResumedTransferIdsRef.current.has(retryKey)) {
        continue;
      }
      const hasConnectedSession = sessions.some((session) => isConnectedState(session.state)
        && (session.id === transfer.session_id || session.profile_id === transfer.profile_id));
      if (!hasConnectedSession) {
        continue;
      }
      autoResumedTransferIdsRef.current.add(retryKey);
      const delayMs = Math.min(16_000, 1000 * (2 ** retryCount));
      const existingTimer = autoResumeTimersRef.current.get(transfer.id);
      if (existingTimer) window.clearTimeout(existingTimer.timer);
      upsertTransfer({
        ...transfer,
        status: {
          Retrying: {
            attempt: retryCount + 1,
            max_attempts: 5,
            reason
          }
        },
        updated_at: new Date().toISOString()
      });
      const timer = window.setTimeout(() => {
        autoResumeTimersRef.current.delete(transfer.id);
        const current = transfersRef.current.find((item) => item.id === transfer.id);
        const stillConnected = current ? sessions.some((session) => isConnectedState(session.state)
          && (session.id === current.session_id || session.profile_id === current.profile_id)) : false;
        if (!current || !isScheduledTransferRetryCurrent(current, retryCount) || !stillConnected) {
          autoResumedTransferIdsRef.current.delete(retryKey);
          return;
        }
        void retryTransfer(current);
      }, delayMs);
      autoResumeTimersRef.current.set(transfer.id, { retryKey, timer });
    }
  }, [retryTransfer, sessions, transfers, upsertTransfer]);

  const uploadDraggedFiles = useCallback(async (paths: string[]) => {
    await uploadLocalPaths(paths);
  }, [uploadLocalPaths]);

  useEffect(() => {
    if (!isDesktopRuntime) {
      return;
    }

    let unlisten: (() => void) | undefined;
    void getCurrentWebview().onDragDropEvent((event) => {
      const payload = event.payload as {
        type: "enter" | "over" | "drop" | "leave" | "cancel";
        paths?: string[];
        position?: { x: number; y: number };
      };
      const region = fileRegionRef.current;
      const isInside = region && payload.position
        ? (() => {
            const rect = region.getBoundingClientRect();
            return payload.position.x >= rect.left
              && payload.position.x <= rect.right
              && payload.position.y >= rect.top
              && payload.position.y <= rect.bottom;
          })()
        : false;

      if (payload.type === "enter" || payload.type === "over") {
        setSftpDropActive(Boolean(isInside));
        return;
      }

      if (payload.type === "leave" || payload.type === "cancel") {
        setSftpDropActive(false);
        return;
      }

      if (payload.type === "drop") {
        setSftpDropActive(false);
        if (isInside && payload.paths?.length) {
          void uploadDraggedFiles(payload.paths);
        }
      }
    }).then((dispose) => {
      unlisten = dispose;
    });

    return () => {
      unlisten?.();
    };
  }, [uploadDraggedFiles]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setContextMenu(null);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
    };
  }, []);

  const openNewProfileDialog = useCallback(() => {
    setEditingProfile(createUniqueBlankProfile(profiles));
    setSettingsOpen(true);
  }, [profiles]);

  const createSessionFolder = useCallback(async () => {
    const name = await requestTextInput({
      title: "新建文件夹",
      label: "文件夹名称",
      initialValue: createUniqueFolderName(folders, "项目服务器"),
      placeholder: "项目服务器",
      confirmLabel: "创建"
    });
    const cleanName = name?.trim();
    if (!cleanName) {
      return;
    }
    if (folders.some((folder) => folder.name.trim() === cleanName)) {
      flash("文件夹名称已存在");
      return;
    }

    const folder = {
      id: crypto.randomUUID(),
      name: cleanName,
      parent_id: null
    };

    try {
      const saved = await saveFolder(folder);
      setFolders((current) => {
        const exists = current.some((item) => item.id === saved.id);
        return exists
          ? current.map((item) => item.id === saved.id ? saved : item)
          : [...current, saved];
      });
      flash(`已创建文件夹 ${saved.name}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      flash(`创建文件夹失败：${message}`);
    }
  }, [flash, folders, requestTextInput]);

  const openCreateContextMenu = useCallback((event: React.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    setContextMenu({
      kind: "create",
      x: Math.max(8, Math.min(event.clientX, window.innerWidth - 220)),
      y: Math.max(8, Math.min(event.clientY, window.innerHeight - 180))
    });
  }, []);

  useEffect(() => {
    if (!contextMenu) {
      return;
    }
    const frame = window.requestAnimationFrame(() => {
      const menu = contextMenuRef.current;
      if (!menu) {
        return;
      }
      const rect = menu.getBoundingClientRect();
      const margin = 8;
      const maxX = Math.max(margin, window.innerWidth - rect.width - margin);
      const maxY = Math.max(margin, window.innerHeight - rect.height - margin);
      const nextX = Math.max(margin, Math.min(contextMenu.x, maxX));
      const nextY = Math.max(margin, Math.min(contextMenu.y, maxY));
      if (Math.abs(nextX - contextMenu.x) > 0.5 || Math.abs(nextY - contextMenu.y) > 0.5) {
        setContextMenu((current) => current ? { ...current, x: nextX, y: nextY } : current);
      }
    });
    return () => window.cancelAnimationFrame(frame);
  }, [contextMenu]);

  const activatePreviousProfile = useCallback(() => {
    if (activeProfileIndex > 0) {
      setActiveProfileId(openShellTabs[activeProfileIndex - 1].id);
    }
  }, [activeProfileIndex, openShellTabs]);

  const activateNextProfile = useCallback(() => {
    if (activeProfileIndex >= 0 && activeProfileIndex < openShellTabs.length - 1) {
      setActiveProfileId(openShellTabs[activeProfileIndex + 1].id);
    }
  }, [activeProfileIndex, openShellTabs]);

  const { windowMaximized, minimizeWindow, toggleMaximizeWindow, closeWindow } = useWindowControls(flash);

  const splashCenterImageSrc = layoutSettings.splash_center_image_data_url || splashCenterImage;
  const usingDefaultTerminalBackground = !layoutSettings.terminal_background_image_data_url;
  const terminalBackgroundImage = layoutSettings.terminal_background_image_data_url || defaultWorkspaceBackground;
  const terminalBackgroundOpacity = layoutSettings.terminal_background_image_data_url
    ? clampNumber(layoutSettings.terminal_background_opacity, 0, 100) / 100
    : 0.35;
  const hasWorkspaceBackground = Boolean(terminalBackgroundImage && layoutSettings.terminal_background_apply_workspace);
  const hasHomeBackground = Boolean(terminalBackgroundImage && (layoutSettings.terminal_background_apply_home || usingDefaultTerminalBackground));
  const appCustomStyle = {
    "--joy-custom-background-image": terminalBackgroundImage ? `url("${escapeCssUrl(terminalBackgroundImage)}")` : "none",
    "--joy-custom-background-opacity": String(terminalBackgroundOpacity)
  } as React.CSSProperties;

  return (
    <div
      className={`app-shell ${!appSettingsOpen && !activeProfile ? "home-mode" : ""} ${appSettingsOpen ? "settings-mode" : ""} ${hasWorkspaceBackground ? "has-workspace-bg" : ""} ${hasHomeBackground ? "has-home-bg" : ""} ${assistantOpen ? "assistant-open" : "assistant-collapsed"} ${sidebarCollapsed ? "sidebar-collapsed" : "sidebar-open"}`}
      style={appCustomStyle}
    >
      {splashVisible ? <JoyshellSplash closing={splashClosing} centerImage={splashCenterImageSrc} /> : null}
      <div className="left-chrome">
        <header className="system-titlebar">
          <div className="titlebar-nav">
            <button
              className="nav-control"
              title={sidebarCollapsed ? "展开左侧导航" : "收起左侧导航"}
              onClick={() => setLeftSidebarOpen(sidebarCollapsed)}
            >
              <PanelRight size={15} />
            </button>
            <button
              className="nav-control"
              title="上一个会话"
              onClick={activatePreviousProfile}
              disabled={activeProfileIndex <= 0}
            >
              <ChevronRight className="back-icon" size={15} />
            </button>
            <button
              className="nav-control"
              title="下一个会话"
              onClick={activateNextProfile}
              disabled={activeProfileIndex < 0 || activeProfileIndex >= openShellTabs.length - 1}
            >
              <ChevronRight size={15} />
            </button>
          </div>
          <div className="system-titlebar-drag" data-tauri-drag-region />
          <div className="window-controls">
            <button title="最小化" onClick={minimizeWindow}>
              <Minus size={15} />
            </button>
            <button title={windowMaximized ? "还原" : "最大化"} onClick={toggleMaximizeWindow}>
              {windowMaximized ? <Minimize2 size={13} /> : <Square size={12} />}
            </button>
            <button className="close" title="关闭" onClick={closeWindow}>
              <X size={15} />
            </button>
          </div>
        </header>

        <aside className={`sidebar ${appSettingsOpen ? "settings-sidebar-mode" : "session-sidebar-mode"} ${sidebarCollapsed ? "collapsed" : ""}`}>
          {!appSettingsOpen ? (
          <div className="status-card">
            <div className="status-line">
              <span className="status-title">运行模式</span>
              <Circle size={8} fill={isDesktopRuntime ? "#1f9d55" : "#c58515"} />
            </div>
            <div className="host-address">
              <span>{isDesktopRuntime ? "Desktop" : "Preview"}</span>
              <strong>{activeProfile?.host || "未连接"}</strong>
            </div>
            <div className="build-label">{clientBuildLabel}</div>
            <button
              className="system-button"
              onClick={() => {
                setSystemDialogOpen(true);
                void refreshSystemSnapshot();
              }}
            >
              系统信息
            </button>
            <Metric icon={<Cpu size={14} />} label="CPU" value={formatPercent(systemDerived.cpuPercent)} />
            <Metric icon={<MemoryStick size={14} />} label="内存" value={formatMemoryMetric(systemSnapshot?.memory)} tone="warning" />
            <Metric icon={<HardDrive size={14} />} label="磁盘" value={formatRootDisk(systemSnapshot)} />
            <Metric icon={<Network size={14} />} label="网络" value={`${formatRate(systemDerived.rxRate)}/${formatRate(systemDerived.txRate)}`} tone="success" />
            <Metric icon={<RefreshCw size={14} />} label="时延" value={formatLatency(latencyMs, latencyStatus)} tone={latencyTone(latencyMs, latencyStatus)} />
            <div className="system-details">
              <span>运行 {formatUptime(systemSnapshot?.uptime_seconds ?? 0)}</span>
              <span>负载 {formatLoad(systemSnapshot)}</span>
              <span>{systemStatus}</span>
            </div>
          </div>
          ) : null}

          {appSettingsOpen ? (
            <>
              <div className="settings-sidebar-header">
                <strong>设置</strong>
                <button className="tiny-action" title="返回会话" onClick={() => setAppSettingsOpen(false)}>
                  <X size={14} />
                </button>
              </div>
              <div className="settings-sidebar-list">
                <button
                  className={`settings-sidebar-item ${appSettingsPage === "general" ? "active" : ""}`}
                  onClick={() => setAppSettingsPage("general")}
                >
                  <Settings size={15} />
                  <span>
                    <strong>常规</strong>
                    <small>启动、删除确认和基础行为</small>
                  </span>
                </button>
                <button
                  className={`settings-sidebar-item ${appSettingsPage === "appearance" ? "active" : ""}`}
                  onClick={() => setAppSettingsPage("appearance")}
                >
                  <Palette size={15} />
                  <span>
                    <strong>外观</strong>
                    <small>侧栏、面板和主题偏好</small>
                  </span>
                </button>
                <button
                  className={`settings-sidebar-item ${appSettingsPage === "security" ? "active" : ""}`}
                  onClick={() => setAppSettingsPage("security")}
                >
                  <ShieldCheck size={15} />
                  <span>
                    <strong>安全与信任</strong>
                    <small>凭据存储和已信任主机</small>
                  </span>
                </button>
              </div>
            </>
          ) : (
            <div className="sidebar-session-shell">
          <label className="search-box">
            <Search size={15} />
            <input
              value={sessionSearchQuery}
              placeholder="Search sessions"
              onChange={(event) => setSessionSearchQuery(event.target.value)}
            />
          </label>

          <div className="nav-section">
            <div className="section-title-row">
              <span className="section-title">Sessions</span>
              <button className="tiny-action" title="新建服务器或文件夹" onClick={openCreateContextMenu}>
                <Plus size={14} />
              </button>
            </div>
            {profiles.length === 0 ? (
              <button className="empty-session" onClick={openNewProfileDialog}>
                <Server size={18} />
                <span>
                  <strong>添加 SSH 连接</strong>
                  <small>填写主机、端口和认证信息</small>
                </span>
              </button>
            ) : visibleGroupedProfiles.length === 0 ? (
              <div className="session-search-empty">
                未找到匹配会话
              </div>
            ) : visibleGroupedProfiles.map((group) => {
              const folder = folders.find((item) => item.id === group.id) ?? null;
              const isRenamingFolder = Boolean(folder) && editingFolderId === group.id;
              const isGroupCollapsed = collapsedSessionFolderIds.has(group.id);
              const isSearchingSessions = Boolean(normalizedSessionSearch);
              return (
              <div
                className={`session-group ${isGroupCollapsed ? "collapsed" : ""} ${dragOverFolderId === group.id ? "drop-target" : ""}`}
                key={group.id}
                data-session-group-id={group.id}
                onDragEnter={(event) => acceptProfileFolderDrag(event, group.id)}
                onDragOver={(event) => acceptProfileFolderDrag(event, group.id)}
                onDragLeave={(event) => {
                  if (!event.currentTarget.contains(event.relatedTarget as Node | null)) {
                    setDragOverFolderId(null);
                  }
                }}
                onDrop={(event) => dropProfileToFolder(event, group)}
              >
                <div
                  className="session-folder-label"
                  onContextMenu={(event) => group.id !== "ungrouped" ? openFolderContextMenu(group.id, event) : undefined}
                >
                  {group.id === "ungrouped" || !isGroupCollapsed ? <FolderOpen size={13} /> : <Folder size={13} />}
                  {isRenamingFolder && folder ? (
                    <input
                      className="inline-rename-input folder-rename-input"
                      value={folderNameDraft}
                      autoFocus
                      onChange={(event) => setFolderNameDraft(event.target.value)}
                      onClick={(event) => event.stopPropagation()}
                      onMouseDown={(event) => event.stopPropagation()}
                      onContextMenu={(event) => event.stopPropagation()}
                      onBlur={() => { void commitSessionFolderRename(folder, folderNameDraft); }}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") {
                          event.preventDefault();
                          void commitSessionFolderRename(folder, folderNameDraft);
                        }
                        if (event.key === "Escape") {
                          event.preventDefault();
                          cancelSessionFolderRename();
                        }
                      }}
                    />
                  ) : (
                    <span>{group.name}</span>
                  )}
                  <button
                    className="session-folder-collapse-button"
                    title={isGroupCollapsed ? "展开文件夹" : "折叠文件夹"}
                    aria-label={isGroupCollapsed ? `展开 ${group.name}` : `折叠 ${group.name}`}
                    aria-expanded={!isGroupCollapsed}
                    onClick={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      toggleSessionFolderCollapsed(group.id);
                    }}
                    onPointerDown={(event) => event.stopPropagation()}
                    onContextMenu={(event) => event.stopPropagation()}
                  >
                    <ChevronRight size={13} />
                  </button>
                </div>
                {!isGroupCollapsed ? group.profiles.map((profile) => {
                  const profileOs = resolveProfileOperatingSystem(profile);
                  const showBefore = dragIndicator?.kind === "profile"
                    && dragIndicator.targetId === profile.id
                    && dragIndicator.position === "before";
                  const showAfter = dragIndicator?.kind === "profile"
                    && dragIndicator.targetId === profile.id
                    && dragIndicator.position === "after";
                  return (
                    <div
                      className={`session-row-wrap ${showBefore ? "drop-before" : ""} ${showAfter ? "drop-after" : ""}`}
                      key={profile.id}
                    >
                      {showBefore ? <div className="session-drop-placeholder" /> : null}
                      <div
                        className={`session-row ${profile.id === activeProfile?.id ? "active" : ""}`}
                        data-session-profile-id={profile.id}
                        role="button"
                        tabIndex={0}
                        onPointerDown={(event) => {
                          debugDrag("profile pointer down", { profileId: profile.id });
                          beginPointerDrag(event, { kind: "profile", id: profile.id, label: profile.name });
                        }}
                        onMouseDown={() => debugDrag("profile mouse down", { profileId: profile.id })}
                        onClick={() => {
                          if (suppressNextClickRef.current) {
                            suppressNextClickRef.current = false;
                            return;
                          }
                          openShellProfile(profile.id);
                        }}
                        onDoubleClick={() => void handleProfileDoubleClick(profile)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") {
                            event.preventDefault();
                            openShellProfile(profile.id);
                          }
                        }}
                        onContextMenu={(event) => openSessionContextMenu(profile, event)}
                      >
                        <span
                          className={`session-status-dot ${connectedProfileIds.has(profile.id) ? "online" : pendingProfileIds.has(profile.id) ? "pending" : trackedProfileIds.has(profile.id) ? "offline" : ""}`}
                        />
                        <span className="session-os-badge" title={profileOs.label}>
                          <OperatingSystemIcon symbolId={profileOs.symbolId} />
                        </span>
                        <span className="session-main">
                          <strong>{profile.name}</strong>
                          <small>{profile.username}@{profile.host}</small>
                        </span>
                        {profile.favorite ? <Star size={14} fill="currentColor" /> : <ChevronRight size={14} />}
                      </div>
                      {showAfter ? <div className="session-drop-placeholder after" /> : null}
                    </div>
                  );
                }) : null}
                {!isGroupCollapsed && group.profiles.length === 0 && dragIndicator?.kind === "profile" && dragIndicator.groupId === group.id ? (
                  <div className="session-drop-placeholder empty" />
                ) : null}
                {!isGroupCollapsed && group.profiles.length > 0
                  && dragIndicator?.kind === "profile"
                  && dragIndicator.groupId === group.id
                  && !dragIndicator.targetId ? (
                  <div className="session-drop-placeholder after" />
                ) : null}
                {!isSearchingSessions && !isGroupCollapsed && group.profiles.length === 0 ? (
                  <button
                    className="session-row folder-empty"
                    onClick={() => openNewProfileDialogInFolder(group.id === "ungrouped" ? null : group.name)}
                  >
                    <span className="session-os-badge">+</span>
                    <span className="session-main">
                      <strong>{group.id === "ungrouped" ? "拖入独立服务器" : "添加服务器"}</strong>
                      <small>{group.id === "ungrouped" ? "无文件夹的服务器放在这里" : `保存到 ${group.name}`}</small>
                    </span>
                  </button>
                ) : null}
              </div>
              );
            })}
          </div>

          <div className="sidebar-footer">
            <button className="app-settings-button primary" onClick={() => setAppSettingsOpen(true)} title="应用设置">
              <Settings size={15} />
              <span>custom</span>
            </button>
            <button className="app-settings-button update" onClick={() => flash("更新检查将在版本服务接入后启用")} title="检查更新">
              <Download size={13} />
            </button>
          </div>
            </div>
          )}
        </aside>
      </div>

      {appSettingsOpen ? (
        <main className="workspace settings-workspace">
          <AppSettingsWorkspace
            activePage={appSettingsPage}
            layout={layoutSettings}
            onLayoutChange={updateLayoutSettings}
          />
        </main>
      ) : (
          <main className={`workspace ${!activeProfile ? "home-mode" : ""}`}>
        <section
          className={`terminal-region ${bottomPanelOpen ? "file-panel-open" : "file-panel-closed"}`}
          onContextMenu={(event) => openAppContextMenu("terminal", event)}
        >
          <button
            className="workspace-assistant-toggle"
            title={assistantOpen ? "收起右侧栏" : "展开右侧栏"}
            onClick={() => setRightSidebarOpen(!assistantOpen)}
          >
            <PanelRight size={17} />
          </button>
          <div
            className="terminal-tabs"
            onDragOver={(event) => {
              if (draggedTabProfileIdRef.current || Array.from(event.dataTransfer.types).includes(TAB_DRAG_TYPE)) {
                event.preventDefault();
                event.dataTransfer.dropEffect = "move";
              }
            }}
            onDrop={(event) => {
              event.preventDefault();
              const draggedId = getDraggedTabId(event);
              draggedTabProfileIdRef.current = null;
              if (draggedId) {
                moveOpenTabToEnd(draggedId);
              }
            }}
          >
            {openShellTabs.map(({ id: shellId, profile }) => {
              const showBefore = dragIndicator?.kind === "tab"
                && dragIndicator.targetId === shellId
                && dragIndicator.position === "before";
              const showAfter = dragIndicator?.kind === "tab"
                && dragIndicator.targetId === shellId
                && dragIndicator.position === "after";
              return (
                <div className="tab-wrap" key={shellId}>
                  {showBefore ? <div className="tab-drop-marker" /> : null}
                  <div
                    className={`tab ${shellId === activeProfileId ? "active" : ""}`}
                    data-tab-profile-id={shellId}
                    onClick={() => {
                      if (suppressNextClickRef.current) {
                        suppressNextClickRef.current = false;
                        return;
                      }
                      setActiveProfileId(shellId);
                    }}
                    onContextMenu={(event) => openTabContextMenu(profile, shellId, event)}
                    onPointerDown={(event) => {
                      debugDrag("tab pointer down", { profileId: profile.id, shellId });
                      beginPointerDrag(event, { kind: "tab", id: shellId, label: profile.name });
                    }}
                    onMouseDown={() => debugDrag("tab mouse down", { profileId: profile.id, shellId })}
                    onDragOver={(event) => {
                      if (draggedTabProfileIdRef.current || Array.from(event.dataTransfer.types).includes(TAB_DRAG_TYPE)) {
                        event.preventDefault();
                        event.stopPropagation();
                        event.dataTransfer.dropEffect = "move";
                      }
                    }}
                    onDrop={(event) => {
                      event.preventDefault();
                      event.stopPropagation();
                      const draggedId = getDraggedTabId(event);
                      draggedTabProfileIdRef.current = null;
                      if (draggedId) {
                        reorderOpenTab(draggedId, shellId);
                      }
                    }}
                    onDragEnd={() => {
                      draggedTabProfileIdRef.current = null;
                    }}
                  >
                    <span className="tab-main">
                      <Circle
                        size={9}
                        fill={connectedSessionIds.has(shellId) ? "var(--joy-success)" : pendingSessionIds.has(shellId) ? "var(--joy-warning)" : "var(--joy-danger)"}
                      />
                      {profile.name}
                    </span>
                    <button
                      className="tab-close"
                      title="关闭 Shell"
                      onPointerDown={(event) => {
                        event.stopPropagation();
                      }}
                      onClick={(event) => {
                        event.stopPropagation();
                        void closeShellProfile(shellId);
                      }}
                    >
                      <X size={12} />
                    </button>
                  </div>
                  {showAfter ? <div className="tab-drop-marker after" /> : null}
                </div>
              );
            })}
            {dragIndicator?.kind === "tab" && !dragIndicator.targetId ? <div className="tab-drop-marker after" /> : null}
          </div>
          <div className="terminal-stage">
            {!activeProfile ? (
              <ConnectionHome
                profiles={profiles}
                onAdd={openNewProfileDialog}
                activeProfileId={null}
                onSelect={(profile) => openShellProfile(profile.id)}
                onConnect={(profile) => void connectSelectedProfile(profile)}
              />
            ) : (
              <>
                <JoyTerminal
                  id={activeProfileId ?? "empty"}
                  initialOutput={terminalSeed}
                  onInput={handleInput}
                  onReady={(terminal) => {
                    terminalRef.current = terminal;
                    terminal.replace(terminalMirrorRef.current);
                  }}
                />
                <div className="command-dock">
                  <input
                    value={commandDraft}
                    onChange={(event) => setCommandDraft(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        sendCommandDraft();
                      }
                    }}
                    placeholder={activeSession ? "输入命令后回车发送" : "连接 SSH 后可发送命令"}
                  />
                  <div className="command-tools">
                    <button onClick={sendCommandDraft} title="发送命令">
                      <Play size={13} />
                    </button>
                    <button onClick={printDiagnostics} title="打印 SSH 诊断">
                      <ShieldCheck size={13} />
                    </button>
                    <span className="input-meter" title="前端收到的终端输入次数">
                      in {terminalInputCount}
                    </span>
                    <button title="刷新状态" onClick={() => void refreshSystemSnapshot()}>
                      <RefreshCw size={13} />
                    </button>
                    <button
                      title="分屏终端"
                      onClick={() => flash("分屏布局将在终端多实例接入后启用")}
                    >
                      <SplitSquareHorizontal size={14} />
                    </button>
                    <button
                      title={bottomPanelOpen ? "收起文件/命令面板" : "打开文件/命令面板"}
                      onClick={() => setBottomPanelPreferenceOpen(!bottomPanelOpen)}
                    >
                      <PanelBottom size={14} />
                    </button>
                    <button className="connect-dock-button" onClick={connect} disabled={connecting}>
                      <Play size={13} />
                      {connecting ? "Connecting" : "Connect"}
                    </button>
                  </div>
                </div>
              </>
            )}
          </div>
        </section>

        {activeProfile && bottomPanelOpen ? (
          <section
            ref={fileRegionRef}
            className={`file-region ${sftpDropActive ? "drop-active" : ""} ${bottomPanelResize.isResizing ? "resizing" : ""}`}
            style={{ "--bottom-panel-height": `${bottomPanelHeight}px` } as React.CSSProperties}
            onContextMenu={(event) => openAppContextMenu("file", event)}
            onDragOver={(event) => {
              event.preventDefault();
              if (isDesktopRuntime) {
                setSftpDropActive(true);
              }
            }}
            onDragLeave={() => setSftpDropActive(false)}
            onDrop={(event) => {
              event.preventDefault();
              setSftpDropActive(false);
            }}
          >
          <div
            className="file-region-resize-handle"
            role="separator"
            aria-label="调整文件面板高度"
            aria-orientation="horizontal"
            aria-valuemin={120}
            aria-valuemax={390}
            aria-valuenow={bottomPanelHeight}
            tabIndex={0}
            title="拖动调整文件面板高度"
            {...bottomPanelResize.handleProps}
          />
          <div className="file-tabs">
            <button
              className={`file-tab ${activeBottomView === "files" ? "active" : ""}`}
              onClick={() => setActiveBottomView("files")}
            >
              文件
            </button>
            <button
              className={`file-tab ${activeBottomView === "commands" ? "active" : ""}`}
              onClick={() => setActiveBottomView("commands")}
            >
              命令
            </button>
            {activeBottomView === "files" ? (
              <>
                <div className="path-bar">{sftpListing?.path ?? sftpPath}</div>
                <button className="mini-button" onClick={goParentDirectory} disabled={!sftpListing?.parent || sftpBusy}>上级</button>
                <button className="mini-icon" onClick={() => void refreshSftpListing()} disabled={!activeSession || sftpBusy} title="刷新">
                  <RefreshCw size={14} />
                </button>
                <button className="mini-icon" onClick={createRemoteDirectory} disabled={!activeSession || sftpBusy} title="新建目录">
                  <FolderPlus size={14} />
                </button>
                <button className="mini-icon" onClick={uploadRemoteFile} disabled={!activeSession || sftpBusy} title="上传">
                  <Upload size={14} />
                </button>
                <button className="mini-icon" onClick={downloadRemoteEntry} disabled={!selectedRemoteEntry || selectedRemoteEntry.is_dir || sftpBusy} title="下载">
                  <Download size={14} />
                </button>
                <button className="mini-icon" onClick={() => startRemoteEntryRename()} disabled={!selectedRemoteEntry || sftpBusy} title="重命名">
                  <Edit3 size={14} />
                </button>
                <button className="mini-icon danger" onClick={deleteRemoteEntry} disabled={!selectedRemoteEntry || sftpBusy} title="删除">
                  <Trash2 size={14} />
                </button>
              </>
            ) : (
              <div className="command-tab-toolbar">
                <select value={commandSendMode} onChange={(event) => setCommandSendMode(event.target.value as typeof commandSendMode)}>
                  <option value="current">当前设备</option>
                  <option value="all">全部已连接</option>
                  <option value="selected">指定设备</option>
                </select>
                <button className="mini-button" onClick={saveCommandDraft}>
                  <Save size={13} /> 保存命令
                </button>
              </div>
            )}
          </div>
          {activeBottomView === "files" ? (
            <div className="file-browser">
            <div className="file-tree">
              {buildPathCrumbs(sftpListing?.path ?? sftpPath).map((item) => (
                <button
                  className={`tree-row ${item.path === (sftpListing?.path ?? sftpPath) ? "selected" : ""}`}
                  key={item.path}
                  onClick={() => void refreshSftpListing(item.path)}
                  disabled={!activeSession || sftpBusy}
                >
                  <FileKindIcon path={item.path} isDirectory />
                  <span>{item.label}</span>
                </button>
              ))}
              <div className="tree-status">{sftpStatus}</div>
            </div>
            <div className="file-table">
              <div className="sftp-table-head">
                <span>名称</span>
                <span>大小</span>
                <span>权限</span>
                <span>修改时间</span>
                <span>路径</span>
              </div>
              {sftpListing?.entries.length ? (
                sftpListing.entries.map((entry) => (
                  <div
                    className={`sftp-table-row ${entry.path === selectedRemotePath ? "selected" : ""}`}
                    key={entry.path}
                    role="button"
                    tabIndex={0}
                    onClick={() => setSelectedRemotePath(entry.path)}
                    onDoubleClick={() => openRemoteEntry(entry)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") {
                        event.preventDefault();
                        openRemoteEntry(entry);
                      }
                    }}
                    onContextMenu={(event) => {
                      setSelectedRemotePath(entry.path);
                      openAppContextMenu("file", event);
                    }}
                  >
                    <span className="file-name-cell">
                      <FileKindIcon path={entry.path} isDirectory={entry.is_dir} />
                      {editingRemotePath === entry.path ? (
                        <input
                          className="inline-rename-input remote-rename-input"
                          value={remoteNameDraft}
                          autoFocus
                          onChange={(event) => setRemoteNameDraft(event.target.value)}
                          onClick={(event) => event.stopPropagation()}
                          onDoubleClick={(event) => event.stopPropagation()}
                          onMouseDown={(event) => event.stopPropagation()}
                          onContextMenu={(event) => event.stopPropagation()}
                          onBlur={() => { void commitRemoteEntryRename(entry, remoteNameDraft); }}
                          onKeyDown={(event) => {
                            if (event.key === "Enter") {
                              event.preventDefault();
                              void commitRemoteEntryRename(entry, remoteNameDraft);
                            }
                            if (event.key === "Escape") {
                              event.preventDefault();
                              cancelRemoteEntryRename();
                            }
                          }}
                        />
                      ) : (
                        entry.name
                      )}
                    </span>
                    <span>{entry.is_dir ? "--" : formatBytes(entry.size)}</span>
                    <span>{entry.permissions}</span>
                    <span>{formatDateTime(entry.modified_at)}</span>
                    <span>{entry.path}</span>
                  </div>
                ))
              ) : (
                <div className="table-empty">
                  {activeSession ? "当前目录为空，或点击刷新读取 SFTP 目录。" : "连接 SSH 后显示远程文件。"}
                </div>
              )}
            </div>
            </div>
          ) : (
            <CommandLibraryPanel
              snippets={commandSnippets}
              connectedSessions={connectedSessions}
              sendMode={commandSendMode}
              selectedTargets={selectedCommandTargets}
              titleDraft={commandTitleDraft}
              commandDraft={commandBodyDraft}
              editingId={editingCommandId}
              onSend={sendStoredCommand}
              onEdit={editStoredCommand}
              onDelete={deleteStoredCommand}
              onSelectTarget={(sessionId, selected) => setSelectedCommandTargets((current) => ({
                ...current,
                [sessionId]: selected
              }))}
              onTitleChange={setCommandTitleDraft}
              onCommandChange={setCommandBodyDraft}
              onCancelEdit={() => {
                setEditingCommandId(null);
                setCommandTitleDraft("");
                setCommandBodyDraft("");
              }}
            />
          )}
          </section>
        ) : null}
      </main>
      )}

      {!appSettingsOpen ? (
      <aside className="inspector" aria-label="AI assistant panel">
        <div className="drawer-rail" />
        <div className="drawer-content">
          <section className="panel transfer-panel">
            <div className="panel-heading">
              <Folder size={17} />
              <strong>任务队列</strong>
            </div>
            <div className="transfer-actions">
              <button title="Upload" onClick={uploadRemoteFile} disabled={!activeSession || sftpBusy}>
                <Upload size={16} />
              </button>
              <button title="Download" onClick={downloadRemoteEntry} disabled={!selectedRemoteEntry || selectedRemoteEntry.is_dir || sftpBusy}>
                <Download size={16} />
              </button>
            </div>
            {transfers.length === 0 ? (
              <p className="muted">暂无传输任务。</p>
            ) : transfers.map((transfer) => {
              const isCancelling = Boolean(cancellingTransfers[transfer.id]);
              const statusLabel = isCancelling ? "Cancelling" : formatTransferStatus(transfer);
              const telemetry = buildTransferTelemetry(transfer, transferStats[transfer.id], transferClockNow);
              return (
                <div
                  className="transfer-row"
                  key={transfer.id}
                  onContextMenu={(event) => openTransferContextMenu(transfer, event)}
                >
                  <div className="transfer-row-main">
                    <span className="transfer-title">
                      <FileKindIcon path={transfer.remote_path} />
                      {transfer.direction === "Upload" ? "上传" : "下载"} {remoteBasename(transfer.remote_path)}
                    </span>
                    <small>{statusLabel}</small>
                    <div className="transfer-telemetry">
                      <TransferMetric tone="success" label="大小" value={telemetry.size} span />
                      <TransferMetric tone="danger" label="时间" value={telemetry.time} />
                      {telemetry.rate ? <TransferMetric tone="warning" label="速度" value={telemetry.rate} /> : null}
                    </div>
                  </div>
                  <div className="transfer-row-actions">
                    {transfer.status === "Paused" ? (
                      <button onClick={() => { void retryTransfer(transfer); }} title="继续传输">
                        <Play size={13} />
                      </button>
                    ) : (
                      <button onClick={() => { void pauseTransfer(transfer); }} disabled={!isTransferActive(transfer.status) || isCancelling} title="暂停传输">
                        <Pause size={13} />
                      </button>
                    )}
                    <button
                      onClick={() => { void cancelTransfer(transfer); }}
                      disabled={!isTransferActive(transfer.status) || isCancelling}
                      title="取消传输"
                    >
                      <X size={13} />
                    </button>
                  </div>
                </div>
              );
            })}
          </section>

          <section className="panel lan-device-panel">
            <button className="tool-folder" onClick={() => setLanToolsOpen((open) => !open)} aria-expanded={lanToolsOpen}>
              <FolderOpen size={17} />
              <strong>网络工具</strong>
              <ChevronRight size={14} className={lanToolsOpen ? "tool-folder-chevron open" : "tool-folder-chevron"} />
            </button>
            {lanToolsOpen ? <div className="tool-folder-content">
              <button className="tool-entry" onClick={() => { setLanScanOpen((open) => !open); if (!lanScanRequested) { setLanScanRequested(true); void refreshLanDevices(); } }} disabled={lanScanning} aria-expanded={lanScanOpen}>
                <Network size={15} />
                <span><strong>内网设备扫描</strong><small>发现 IP、MAC 和设备类型</small></span>
                {lanScanning ? <RefreshCw size={14} className="spin" /> : <ChevronRight size={14} className={lanScanOpen ? "tool-folder-chevron open" : ""} />}
              </button>
              {lanScanRequested && lanScanOpen ? <div className="lan-device-results">
              <div className="lan-results-heading"><span>扫描结果 · {lanDevices.filter((device) => device.online !== false).length}/{lanDevices.length} 台在线</span><button className="panel-heading-action" onClick={() => { void refreshLanDevices(); }} disabled={lanScanning} title="刷新设备"><RefreshCw size={14} className={lanScanning ? "spin" : ""} /></button></div>
              {selectedLanDevice ? <div className="lan-device-detail">
                <div className="lan-detail-heading"><button className="lan-back-button" onClick={() => setSelectedLanDevice(null)}>‹ 设备列表</button><strong>设备详情</strong><span /></div>
                <dl>
                  <dt>设备 ID / 名称</dt><dd>{selectedLanDevice.name || "未提供"}</dd>
                  <dt>IP 地址</dt><dd>{selectedLanDevice.ip}</dd>
                  <dt>MAC 地址</dt><dd>{selectedLanDevice.mac}</dd>
                  <dt>厂商 / 类型</dt><dd>{selectedLanDevice.vendor || deviceTypeFromMac(selectedLanDevice.mac) || "未识别"}</dd>
                  <dt>状态</dt><dd>{selectedLanDevice.online === false ? "离线" : "在线"}</dd>
                  <dt>网卡接口</dt><dd>{selectedLanDevice.interface || "未提供"}</dd>
                </dl>
              </div> : lanDevices.length === 0 ? <p className="muted">暂未发现设备。</p> : (
              <div className="lan-device-list">
                {lanDevices.map((device) => (
                  <button className="lan-device-row" key={`${device.ip}-${device.mac}`} onClick={() => setSelectedLanDevice(device)}>
                    <div className="lan-device-main"><strong>{device.name || device.vendor || deviceTypeFromMac(device.mac) || `设备 ${device.ip.split(".").at(-1) ?? ""}`}</strong><span>{device.ip}{device.vendor && device.name ? ` · ${device.vendor}` : ""}{device.interface ? ` · ${device.interface}` : ""} · {device.online === false ? "离线" : "在线"}</span></div>
                    <small>{device.mac}</small>
                  </button>
                ))}
              </div>
              )}
            </div> : null}
            </div> : null}
          </section>

          <section className="panel assistant-research-panel">
            <span>in researching</span>
          </section>
        </div>
      </aside>
      ) : null}

      {contextMenu ? (
        <div className="context-menu-backdrop" onMouseDown={closeContextMenu}>
          <div
            ref={contextMenuRef}
            className="context-menu"
            style={{ left: contextMenu.x, top: contextMenu.y }}
            onMouseDown={(event) => event.stopPropagation()}
          >
            {contextMenu.kind === "create" ? (
              <>
                <button onClick={() => { openNewProfileDialog(); closeContextMenu(); }}>
                  <Server size={14} /> 新建服务器
                </button>
                <button onClick={() => { void createSessionFolder(); closeContextMenu(); }}>
                  <FolderPlus size={14} /> 新建文件夹
                </button>
              </>
            ) : contextMenu.kind === "terminal" ? (
              <>
                <button onClick={() => { void copyTerminalSelection(); closeContextMenu(); }}>复制</button>
                <button onClick={() => { void pasteToTerminal(); closeContextMenu(); }}>粘贴</button>
                <button onClick={() => { selectAllTerminal(); closeContextMenu(); }}>全选</button>
                <button onClick={() => { clearTerminal(); closeContextMenu(); }}>清屏</button>
                <button onClick={() => { if (activeProfileId) { void closeShellProfile(activeProfileId); } closeContextMenu(); }} disabled={!activeProfileId}>
                  关闭当前 Shell
                </button>
                <button onClick={() => { void closeAllShells(); closeContextMenu(); }} disabled={openProfileIds.length === 0}>
                  关闭全部 Shell
                </button>
              </>
            ) : contextMenu.kind === "file" ? (
              <>
                <button onClick={() => { void refreshSftpListing(); closeContextMenu(); }}>刷新</button>
                <button onClick={() => { goParentDirectory(); closeContextMenu(); }} disabled={!sftpListing?.parent}>上级目录</button>
                <button onClick={() => { void uploadRemoteFile(); closeContextMenu(); }} disabled={!activeSession}>上传文件</button>
                <button onClick={() => { void createRemoteDirectory(); closeContextMenu(); }} disabled={!activeSession}>新建目录</button>
                <button onClick={() => { void downloadRemoteEntry(); closeContextMenu(); }} disabled={!selectedRemoteEntry || selectedRemoteEntry.is_dir}>下载</button>
                <button onClick={() => { startRemoteEntryRename(); closeContextMenu(); }} disabled={!selectedRemoteEntry}>重命名</button>
                <button className="danger" onClick={() => { void deleteRemoteEntry(); closeContextMenu(); }} disabled={!selectedRemoteEntry}>
                  <Trash2 size={14} /> 删除
                </button>
              </>
            ) : contextMenu.kind === "folder" ? (
              <>
                <button onClick={() => { if (contextFolder) { openNewProfileDialogInFolder(contextFolder.name); } closeContextMenu(); }} disabled={!contextFolder}>
                  <Server size={14} /> 新建服务器到此文件夹
                </button>
                <button onClick={() => { if (contextFolder) { startSessionFolderRename(contextFolder); } closeContextMenu(); }} disabled={!contextFolder}>
                  <Edit3 size={14} /> 重命名文件夹
                </button>
                <button className="danger" onClick={() => { if (contextFolder) { void deleteSessionFolder(contextFolder); } closeContextMenu(); }} disabled={!contextFolder}>
                  <Trash2 size={14} /> 删除文件夹
                </button>
              </>
            ) : contextMenu.kind === "tab" ? (
              <>
                <button onClick={() => { if (contextTabShellId) { setActiveProfileId(contextTabShellId); } closeContextMenu(); }} disabled={!contextTabShellId}>
                  <ChevronRight size={14} /> 设为当前
                </button>
                <button onClick={() => { if (contextTabShellId) { void closeShellProfile(contextTabShellId); } closeContextMenu(); }} disabled={!contextTabShellId}>
                  <X size={14} /> 关闭 Shell
                </button>
                <button onClick={() => {
                  if (contextTabProfile) {
                    const shellId = openShellProfile(contextTabProfile.id, true);
                    void connectSelectedProfile(contextTabProfile, shellId);
                  }
                  closeContextMenu();
                }} disabled={!contextTabProfile}>
                  <Plus size={14} /> 新建同服务器 Shell
                </button>
                <button onClick={() => {
                  if (contextTabShellId) {
                    void Promise.all(openProfileIds
                      .filter((id) => id !== contextTabShellId)
                      .map((id) => closeShellProfile(id)));
                    setActiveProfileId(contextTabShellId);
                  }
                  closeContextMenu();
                }} disabled={!contextTabShellId || openProfileIds.length <= 1}>
                  <X size={14} /> 关闭其他 Shell
                </button>
                <button onClick={() => { void closeAllShells(); closeContextMenu(); }} disabled={openProfileIds.length === 0}>
                  <X size={14} /> 关闭全部 Shell
                </button>
              </>
            ) : contextMenu.kind === "session" ? (
              <>
                <button onClick={() => { if (contextProfile) { openShellProfile(contextProfile.id); } closeContextMenu(); }} disabled={!contextProfile}>
                  <ChevronRight size={14} /> 打开 Shell
                </button>
                <button onClick={() => { if (contextProfile) { void connectSelectedProfile(contextProfile); } closeContextMenu(); }} disabled={!contextProfile}>
                  <Play size={14} /> 连接
                </button>
                <button onClick={() => {
                  if (contextProfile) {
                    const shellId = openShellProfile(contextProfile.id, true);
                    void connectSelectedProfile(contextProfile, shellId);
                  }
                  closeContextMenu();
                }} disabled={!contextProfile}>
                  <Plus size={14} /> 新建 SSH 连接
                </button>
                <button onClick={() => {
                  if (contextProfileShellIds[0]) { void closeShellProfile(contextProfileShellIds[0]); }
                  closeContextMenu();
                }} disabled={!contextProfile || contextProfileShellIds.length === 0}>
                  <X size={14} /> 关闭 Shell
                </button>
                <button onClick={() => { if (contextProfile) { openProfileSshSettings(contextProfile); } closeContextMenu(); }} disabled={!contextProfile}>
                  <Settings size={14} /> SSH 设置
                </button>
                <button onClick={() => { if (contextProfile) { void copyProfileAddress(contextProfile); } closeContextMenu(); }} disabled={!contextProfile}>
                  <Copy size={14} /> 复制地址
                </button>
                <div className="context-submenu">
                  <button disabled={!contextProfile}>
                    <ChevronRight size={14} /> 排序方式
                  </button>
                  <div className="context-submenu-panel">
                    <button onClick={() => { setSidebarSortMode("custom"); closeContextMenu(); }}>
                      {sidebarSortMode === "custom" ? "✓ " : ""}自定义排序
                    </button>
                    <button onClick={() => { setSidebarSortMode("name"); closeContextMenu(); }}>
                      {sidebarSortMode === "name" ? "✓ " : ""}按名称
                    </button>
                    <button onClick={() => { setSidebarSortMode("host"); closeContextMenu(); }}>
                      {sidebarSortMode === "host" ? "✓ " : ""}按主机
                    </button>
                  </div>
                </div>
                <div className="context-submenu">
                  <button disabled={!contextProfile}>
                    <ChevronRight size={14} /> 位置调整
                  </button>
                  <div className="context-submenu-panel">
                    <button onClick={() => { if (contextProfile) { moveProfilePosition(contextProfile.id, "up"); } closeContextMenu(); }} disabled={!contextProfile}>
                      上移
                    </button>
                    <button onClick={() => { if (contextProfile) { moveProfilePosition(contextProfile.id, "down"); } closeContextMenu(); }} disabled={!contextProfile}>
                      下移
                    </button>
                    <button onClick={() => { if (contextProfile) { moveProfilePosition(contextProfile.id, "top"); } closeContextMenu(); }} disabled={!contextProfile}>
                      置顶
                    </button>
                    <button onClick={() => { if (contextProfile) { moveProfilePosition(contextProfile.id, "bottom"); } closeContextMenu(); }} disabled={!contextProfile}>
                      置底
                    </button>
                  </div>
                </div>
                <button onClick={() => { openNewProfileDialog(); closeContextMenu(); }}>
                  <Plus size={14} /> 新建服务器
                </button>
                <button className="danger" onClick={() => { if (contextProfile) { void deleteSessionProfile(contextProfile); } closeContextMenu(); }} disabled={!contextProfile}>
                  <Trash2 size={14} /> 删除服务器
                </button>
              </>
            ) : (
              <>
                <button onClick={() => { if (contextTransfer) { void revealTransferLocalPath(contextTransfer); } closeContextMenu(); }} disabled={!contextTransfer?.local_path}>
                  <FolderOpen size={14} /> 打开本地位置
                </button>
                <button onClick={() => { if (contextTransfer) { void copyTransferPath(contextTransfer.local_path, "本地路径"); } closeContextMenu(); }} disabled={!contextTransfer?.local_path}>
                  <Copy size={14} /> 复制本地路径
                </button>
                <button onClick={() => { if (contextTransfer) { void copyTransferPath(contextTransfer.remote_path, "远端路径"); } closeContextMenu(); }} disabled={!contextTransfer?.remote_path}>
                  <Copy size={14} /> 复制远端路径
                </button>
                <button onClick={() => { if (contextTransfer) { void retryTransfer(contextTransfer); } closeContextMenu(); }} disabled={!contextTransfer || isTransferActive(contextTransfer.status)}>
                  <RotateCcw size={14} /> 重试任务
                </button>
                <button onClick={() => { if (contextTransfer) { void cancelTransfer(contextTransfer); } closeContextMenu(); }} disabled={!contextTransfer || !isTransferActive(contextTransfer.status) || Boolean(contextTransfer && cancellingTransfers[contextTransfer.id])}>
                  <X size={14} /> 取消任务
                </button>
                <button className="danger" onClick={() => { if (contextTransfer) { void removeTransfer(contextTransfer, false); } closeContextMenu(); }} disabled={!contextTransfer || isTransferActive(contextTransfer.status)}>
                  <Trash2 size={14} /> 移除记录
                </button>
                <button className="danger" onClick={() => { if (contextTransfer) { void removeTransfer(contextTransfer, true); } closeContextMenu(); }} disabled={!contextTransfer || isTransferActive(contextTransfer.status) || !contextTransfer.local_path}>
                  <Trash2 size={14} /> 移除并删除本地文件
                </button>
              </>
            )}
          </div>
        </div>
      ) : null}

      {dangerConfirm ? (
        <DangerConfirmDialog
          title={dangerConfirm.title}
          message={dangerConfirm.message}
          onCancel={() => closeDangerConfirmation(false)}
          onConfirm={() => closeDangerConfirmation(true)}
        />
      ) : null}

      {textInputDialog ? (
        <TextInputDialog
          title={textInputDialog.title}
          message={textInputDialog.message}
          label={textInputDialog.label}
          initialValue={textInputDialog.initialValue}
          placeholder={textInputDialog.placeholder}
          confirmLabel={textInputDialog.confirmLabel}
          onCancel={() => closeTextInputDialog(null)}
          onConfirm={(value) => closeTextInputDialog(value)}
        />
      ) : null}
      {hostKeyPrompt ? <HostKeyConfirmDialog prompt={hostKeyPrompt} submitting={hostKeySubmitting} onCancel={() => { void resolveCurrentHostKeyPrompt(false); }} onConfirm={() => { void resolveCurrentHostKeyPrompt(true); }} /> : null}
      {transferConflict ? <TransferConflictDialog transfer={transferConflict} submitting={transferConflictSubmitting} onDecision={(decision) => { void resolveTransferConflict(decision); }} /> : null}

      {notice ? <div className="toast">{notice}</div> : null}
      {systemDialogOpen ? (
        <SystemInfoDialog
          activeProfile={activeProfile}
          derived={systemDerived}
          snapshot={systemSnapshot}
          status={systemStatus}
          onClose={() => setSystemDialogOpen(false)}
          onRefresh={() => void refreshSystemSnapshot()}
        />
      ) : null}
      {settingsOpen ? (
        <SshSettingsDialog
          profile={editingProfile ?? activeProfile ?? createBlankProfile()}
          folders={folders}
          onClose={() => {
            setSettingsOpen(false);
            setEditingProfile(null);
          }}
          onSave={async (profile, secrets) => {
            const saved = await saveProfile(profile, secrets);
            setProfiles((current) => {
              const exists = current.some((item) => item.id === saved.id);
              return exists
                ? current.map((item) => (item.id === saved.id ? saved : item))
                : [...current, saved];
            });
            openShellProfile(saved.id);
            setSettingsOpen(false);
            setEditingProfile(null);
            flash(`已保存 ${saved.name} 的 SSH 参数`);
          }}
        />
      ) : null}
    </div>
  );
}
