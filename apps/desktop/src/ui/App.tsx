import { JoyTerminal, type JoyTerminalHandle } from "@joyshell/terminal";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import {
  currentMonitor,
  getCurrentWindow,
  type Monitor,
  type PhysicalPosition,
  type PhysicalSize
} from "@tauri-apps/api/window";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import type React from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import splashCenterImage from "../assets/splash/center-joy-cropped.png";
import {
  Bot,
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
  MessageSquareText,
  Minus,
  Network,
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
import { FileKindIcon } from "./FileKindIcon";
import {
  collectSystemSnapshot,
  cancelSftpTransfer,
  connectProfile,
  disconnectProfile,
  deleteCommandSnippet,
  deleteFolder,
  getLayoutSettings,
  listCommandSnippets,
  listFolders,
  listAssistants,
  listProfiles,
  previewToolCall,
  recentAudit,
  revealLocalPath,
  saveCommandSnippet,
  saveFolder,
  saveLayoutSettings,
  saveProfile,
  sessionDiagnostics,
  sftpCreateDir,
  sftpDeletePath,
  sftpDownloadFile,
  sftpListDirectory,
  sftpRenamePath,
  sftpUploadFile,
  terminalOutputTail,
  writeClipboardText as writeDesktopClipboardText,
  writeTerminal
} from "../bridge";
import type {
  AgentToolCallPreview,
  AssistantDefinition,
  AuditEntry,
  CommandSnippet,
  LayoutSettings,
  RemoteDirectoryListing,
  RemoteFileEntry,
  SessionInfo,
  SessionFolder,
  SessionProfile,
  SftpProgress,
  SystemSnapshot
} from "../types";

type SessionEventPayload =
  | { StateChanged: { session_id: string; state: SessionInfo["state"] } }
  | { TerminalOutput: { session_id: string; data: string } }
  | { SftpProgress: SftpProgress };

const isDesktopRuntime = "__TAURI_INTERNALS__" in window;
const clientBuildLabel = "0.1.0 sftp-animated-transfer-20260722";
const COLLAPSED_SESSION_FOLDERS_STORAGE_KEY = "joyshell:collapsed-session-folders:v1";

function applySidebarPositionGradient(
  position: { x: number; y: number },
  monitor: Monitor | null,
  windowSize?: { width: number; height: number } | null
) {
  const monitorX = monitor?.position.x ?? 0;
  const monitorY = monitor?.position.y ?? 0;
  const monitorWidth = Math.max(monitor?.size.width ?? 1920, 1);
  const monitorHeight = Math.max(monitor?.size.height ?? 1080, 1);
  const centerX = position.x + (windowSize?.width ?? monitorWidth * 0.34) / 2;
  const centerY = position.y + (windowSize?.height ?? monitorHeight * 0.55) / 2;
  const xRatio = clamp01((centerX - monitorX) / monitorWidth);
  const yRatio = clamp01((centerY - monitorY) / monitorHeight);
  const topHue = 206 + xRatio * 36 + yRatio * 24;
  const midHue = 318 + xRatio * 28 + yRatio * 34;
  const bottomHue = 10 + yRatio * 58 + xRatio * 18;
  const glowX = 16 + xRatio * 66;
  const glowY = 10 + yRatio * 58;
  const topLight = 96.6 - yRatio * 4.4 + xRatio * 0.8;
  const midLight = 95.4 - yRatio * 1.6;
  const bottomLight = 92.8 + yRatio * 3.0 - xRatio * 0.8;
  const glowOpacity = 0.3 + xRatio * 0.12 + (1 - yRatio) * 0.08;
  const bgX = -Math.round(xRatio * 180);
  const bgY = -Math.round(yRatio * 120);

  document.documentElement.style.setProperty("--sidebar-top-hue", topHue.toFixed(1));
  document.documentElement.style.setProperty("--sidebar-mid-hue", midHue.toFixed(1));
  document.documentElement.style.setProperty("--sidebar-bottom-hue", bottomHue.toFixed(1));
  document.documentElement.style.setProperty("--sidebar-glow-x", `${glowX.toFixed(1)}%`);
  document.documentElement.style.setProperty("--sidebar-glow-y", `${glowY.toFixed(1)}%`);
  document.documentElement.style.setProperty("--sidebar-top-light", `${topLight.toFixed(1)}%`);
  document.documentElement.style.setProperty("--sidebar-mid-light", `${midLight.toFixed(1)}%`);
  document.documentElement.style.setProperty("--sidebar-bottom-light", `${bottomLight.toFixed(1)}%`);
  document.documentElement.style.setProperty("--sidebar-glow-opacity", glowOpacity.toFixed(3));
  document.documentElement.style.setProperty("--chrome-bg-x", `${bgX}px`);
  document.documentElement.style.setProperty("--chrome-bg-y", `${bgY}px`);
}

function applySidebarFallbackGradient() {
  applySidebarPositionGradient(
    { x: window.screenX || 0, y: window.screenY || 0 },
    null,
    { width: window.outerWidth || window.innerWidth, height: window.outerHeight || window.innerHeight }
  );
}

function clamp01(value: number) {
  return Math.max(0, Math.min(1, value));
}

type SystemDerivedStats = {
  cpuPercent: number | null;
  rxRate: number;
  txRate: number;
  interfaceRates: Array<{
    name: string;
    rxRate: number;
    txRate: number;
  }>;
};

const emptySystemDerived: SystemDerivedStats = {
  cpuPercent: null,
  rxRate: 0,
  txRate: 0,
  interfaceRates: []
};

const READY_TERMINAL_OUTPUT = "Joyshell is ready. Add an SSH connection, then click Connect.\r\n";
const TERMINAL_CACHE_LIMIT = 2 * 1024 * 1024;
const PROFILE_DRAG_TYPE = "application/x-joyshell-profile-id";
const TAB_DRAG_TYPE = "application/x-joyshell-tab-profile-id";
const dragDebugEnabled = !isDesktopRuntime && window.location.search.includes("dragTest=1");

function debugDrag(message: string, detail?: unknown) {
  if (dragDebugEnabled) {
    console.debug(`[joyshell-drag] ${message}`, detail ?? "");
  }
}

type TransferStats = {
  startedAt: number;
  lastAt: number;
  lastBytes: number;
  rateBytesPerSecond: number;
  etaSeconds: number | null;
};

type ContextMenuState = {
  kind: "terminal" | "file" | "transfer" | "session" | "create" | "folder" | "tab";
  x: number;
  y: number;
  transferId?: string;
  profileId?: string;
  folderId?: string;
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

type SidebarSortMode = "custom" | "name" | "host";

export function App() {
  const [profiles, setProfiles] = useState<SessionProfile[]>([]);
  const [sidebarSortMode, setSidebarSortMode] = useState<SidebarSortMode>("custom");
  const [folders, setFolders] = useState<SessionFolder[]>([]);
  const [collapsedSessionFolderIds, setCollapsedSessionFolderIds] = useState<Set<string>>(() => loadCollapsedSessionFolders());
  const [openProfileIds, setOpenProfileIds] = useState<string[]>([]);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [activeProfileId, setActiveProfileId] = useState<string | null>(null);
  const [assistants, setAssistants] = useState<AssistantDefinition[]>([]);
  const [preview, setPreview] = useState<AgentToolCallPreview | null>(null);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [assistantOpen, setAssistantOpen] = useState(true);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [bottomPanelOpen, setBottomPanelOpen] = useState(true);
  const [layoutSettings, setLayoutSettings] = useState<LayoutSettings>({
    restore_last_layout: false,
    default_left_sidebar_open: true,
    default_right_sidebar_open: true,
    default_bottom_panel_open: true,
    last_left_sidebar_open: true,
    last_right_sidebar_open: true,
    last_bottom_panel_open: true
  });
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [appSettingsOpen, setAppSettingsOpen] = useState(false);
  const [systemDialogOpen, setSystemDialogOpen] = useState(false);
  const [editingProfile, setEditingProfile] = useState<SessionProfile | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
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
  const [splashVisible, setSplashVisible] = useState(true);
  const [splashClosing, setSplashClosing] = useState(false);
  const [systemSnapshot, setSystemSnapshot] = useState<SystemSnapshot | null>(null);
  const [systemDerived, setSystemDerived] = useState<SystemDerivedStats>(emptySystemDerived);
  const [systemStatus, setSystemStatus] = useState("等待连接");
  const [sftpListing, setSftpListing] = useState<RemoteDirectoryListing | null>(null);
  const [sftpPath, setSftpPath] = useState("/root");
  const [selectedRemotePath, setSelectedRemotePath] = useState<string | null>(null);
  const [sftpBusy, setSftpBusy] = useState(false);
  const [sftpStatus, setSftpStatus] = useState("等待连接");
  const [transfers, setTransfers] = useState<SftpProgress[]>([]);
  const [transferStats, setTransferStats] = useState<Record<string, TransferStats>>({});
  const [transferClockNow, setTransferClockNow] = useState(() => Date.now());
  const [cancellingTransfers, setCancellingTransfers] = useState<Record<string, boolean>>({});
  const [sftpDropActive, setSftpDropActive] = useState(false);
  const [contextMenu, setContextMenu] = useState<ContextMenuState | null>(null);
  const [editingFolderId, setEditingFolderId] = useState<string | null>(null);
  const [folderNameDraft, setFolderNameDraft] = useState("");
  const [editingRemotePath, setEditingRemotePath] = useState<string | null>(null);
  const [remoteNameDraft, setRemoteNameDraft] = useState("");
  const [dragOverFolderId, setDragOverFolderId] = useState<string | null>(null);
  const [dragIndicator, setDragIndicator] = useState<DragIndicator | null>(null);
  const [terminalSeed, setTerminalSeed] = useState(READY_TERMINAL_OUTPUT);
  const terminalRef = useRef<JoyTerminalHandle | null>(null);
  const fileRegionRef = useRef<HTMLElement | null>(null);
  const terminalMirrorRef = useRef(terminalSeed);
  const terminalCacheRef = useRef<Record<string, string>>({ empty: READY_TERMINAL_OUTPUT });
  const activeProfileIdRef = useRef<string | null>(null);
  const previousSystemSnapshotRef = useRef<SystemSnapshot | null>(null);
  const systemSyncInFlightRef = useRef(false);
  const systemSyncFailureCountRef = useRef(0);
  const draggedProfileIdRef = useRef<string | null>(null);
  const draggedTabProfileIdRef = useRef<string | null>(null);
  const pointerDragRef = useRef<PointerDragState | null>(null);
  const dragIndicatorRef = useRef<DragIndicator | null>(null);
  const suppressNextClickRef = useRef(false);
  const profilesRef = useRef<SessionProfile[]>([]);

  const replaceTerminalOutput = useCallback((data: string, profileId?: string | null) => {
    const cacheKey = profileId ?? activeProfileIdRef.current ?? "empty";
    const next = trimTerminalCache(data);
    terminalCacheRef.current[cacheKey] = next;
    if (cacheKey === (activeProfileIdRef.current ?? "empty")) {
      terminalMirrorRef.current = next;
      setTerminalSeed(next);
      terminalRef.current?.replace(next);
    }
  }, []);

  const appendTerminalOutput = useCallback((data: string, profileId?: string | null) => {
    const cacheKey = profileId ?? activeProfileIdRef.current ?? "empty";
    const next = trimTerminalCache((terminalCacheRef.current[cacheKey] ?? "") + data);
    terminalCacheRef.current[cacheKey] = next;
    if (cacheKey === (activeProfileIdRef.current ?? "empty")) {
      terminalMirrorRef.current = next;
      terminalRef.current?.write(data);
    }
  }, []);

  const syncTerminalTail = useCallback((tail: string, profileId?: string | null) => {
    const cacheKey = profileId ?? activeProfileIdRef.current ?? "empty";
    const current = terminalCacheRef.current[cacheKey] ?? "";
    if (!tail || tail === current) {
      return;
    }

    if (tail.startsWith(current)) {
      appendTerminalOutput(tail.slice(current.length), cacheKey);
      return;
    }

    replaceTerminalOutput(tail, cacheKey);
  }, [appendTerminalOutput, replaceTerminalOutput]);

  const upsertTransfer = useCallback((progress: SftpProgress, replaceId?: string) => {
    const now = Date.now();
    setTransferStats((current) => {
      const existing = current[progress.id] ?? (replaceId ? current[replaceId] : undefined);
      const elapsedSeconds = existing ? Math.max((now - existing.lastAt) / 1000, 0) : 0;
      const byteDelta = existing ? progress.bytes_done - existing.lastBytes : 0;
      const canSampleRate = Boolean(existing) && elapsedSeconds >= 0.35 && byteDelta > 0;
      const instantRate = canSampleRate ? byteDelta / elapsedSeconds : 0;
      const isActive = isTransferActive(progress.status);
      const startedAt = existing?.startedAt ?? now;
      const averageElapsedSeconds = Math.max((now - startedAt) / 1000, 0);
      const averageRate = isActive && averageElapsedSeconds >= 0.5 && progress.bytes_done > 0
        ? progress.bytes_done / averageElapsedSeconds
        : 0;
      const rateBytesPerSecond = instantRate > 0
        ? existing?.rateBytesPerSecond
          ? existing.rateBytesPerSecond * 0.86 + instantRate * 0.14
          : instantRate
        : isActive
          ? existing?.rateBytesPerSecond || averageRate
          : existing?.rateBytesPerSecond ?? 0;
      const total = progress.bytes_total ?? null;
      const remainingBytes = total === null ? null : Math.max(total - progress.bytes_done, 0);
      const instantEta = isActive && remainingBytes !== null && rateBytesPerSecond > 0
        ? remainingBytes / rateBytesPerSecond
        : null;
      const etaSeconds = instantEta === null
        ? isActive
          ? existing?.etaSeconds ?? null
          : 0
        : existing?.etaSeconds !== null && existing?.etaSeconds !== undefined
          ? existing.etaSeconds * 0.82 + instantEta * 0.18
          : instantEta;
      const next = { ...current };
      if (replaceId && replaceId !== progress.id) {
        delete next[replaceId];
      }
      next[progress.id] = {
        startedAt,
        lastAt: canSampleRate || !existing || !isActive ? now : existing.lastAt,
        lastBytes: canSampleRate || !existing || !isActive ? progress.bytes_done : existing.lastBytes,
        rateBytesPerSecond,
        etaSeconds
      };
      return next;
    });
    setTransfers((current) => [
      progress,
      ...current.filter((item) => item.id !== progress.id && item.id !== replaceId)
    ].slice(0, 20));
    if (!isTransferActive(progress.status)) {
      setCancellingTransfers((current) => {
        if (!current[progress.id]) {
          return current;
        }
        const next = { ...current };
        delete next[progress.id];
        return next;
      });
    }
  }, []);

  const markTransferFailed = useCallback((transferId: string, fallback: SftpProgress, reason: string) => {
    const now = Date.now();
    setTransferStats((current) => {
      const existing = current[transferId];
      return {
        ...current,
        [transferId]: {
          startedAt: existing?.startedAt ?? now,
          lastAt: now,
          lastBytes: existing?.lastBytes ?? fallback.bytes_done,
          rateBytesPerSecond: existing?.rateBytesPerSecond ?? 0,
          etaSeconds: null
        }
      };
    });
    setTransfers((current) => {
      const existing = current.find((item) => item.id === transferId) ?? fallback;
      return [
        { ...existing, status: { Failed: { reason } } },
        ...current.filter((item) => item.id !== transferId)
      ].slice(0, 20);
    });
    setCancellingTransfers((current) => {
      if (!current[transferId]) {
        return current;
      }
      const next = { ...current };
      delete next[transferId];
      return next;
    });
  }, []);

  const hasActiveTransfer = useMemo(
    () => transfers.some((transfer) => isTransferActive(transfer.status)),
    [transfers]
  );

  useEffect(() => {
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const showTimer = window.setTimeout(() => setSplashClosing(true), reduceMotion ? 500 : 4200);
    const hideTimer = window.setTimeout(() => setSplashVisible(false), reduceMotion ? 760 : 4700);
    return () => {
      window.clearTimeout(showTimer);
      window.clearTimeout(hideTimer);
    };
  }, []);

  useEffect(() => {
    if (!isDesktopRuntime) {
      document.documentElement.style.setProperty("--sidebar-top-hue", "226");
      document.documentElement.style.setProperty("--sidebar-mid-hue", "350");
      document.documentElement.style.setProperty("--sidebar-bottom-hue", "24");
      return;
    }

    let unlisten: (() => void) | undefined;
    let unlistenResize: (() => void) | undefined;
    let monitor: Monitor | null = null;
    let windowSize: PhysicalSize | null = null;
    let windowPosition: PhysicalPosition | null = null;
    let pollTimer: number | undefined;
    let disposed = false;

    const updateFromCurrentPosition = async () => {
      try {
        const appWindow = getCurrentWindow();
        monitor = await currentMonitor();
        const [position, size] = await Promise.all([appWindow.outerPosition(), appWindow.outerSize()]);
        if (!disposed) {
          windowPosition = position;
          windowSize = size;
          applySidebarPositionGradient(position, monitor, size);
        }
      } catch {
        if (!disposed) {
          applySidebarFallbackGradient();
        }
      }
    };

    void updateFromCurrentPosition();
    void getCurrentWindow().onMoved(({ payload }) => {
      windowPosition = payload;
      applySidebarPositionGradient(payload, monitor, windowSize);
      void currentMonitor().then((nextMonitor) => {
        if (disposed || !windowPosition) {
          return;
        }
        monitor = nextMonitor;
        applySidebarPositionGradient(windowPosition, monitor, windowSize);
      });
    }).then((dispose) => {
      unlisten = dispose;
    });
    void getCurrentWindow().onResized(({ payload }) => {
      windowSize = payload;
      if (windowPosition) {
        applySidebarPositionGradient(windowPosition, monitor, payload);
      }
    }).then((dispose) => {
      unlistenResize = dispose;
    });
    pollTimer = window.setInterval(() => {
      const appWindow = getCurrentWindow();
      void Promise.all([appWindow.outerPosition(), appWindow.outerSize(), currentMonitor()]).then(([position, size, nextMonitor]) => {
        if (disposed) {
          return;
        }
        const moved = !windowPosition || windowPosition.x !== position.x || windowPosition.y !== position.y;
        const resized = !windowSize || windowSize.width !== size.width || windowSize.height !== size.height;
        monitor = nextMonitor;
        windowPosition = position;
        windowSize = size;
        if (moved || resized) {
          applySidebarPositionGradient(position, monitor, size);
        }
      }).catch(() => {
        if (!disposed) {
          applySidebarFallbackGradient();
        }
      });
    }, 90);

    return () => {
      disposed = true;
      unlisten?.();
      unlistenResize?.();
      if (pollTimer) {
        window.clearInterval(pollTimer);
      }
    };
  }, []);

  useEffect(() => {
    if (!hasActiveTransfer) {
      return;
    }
    const timer = window.setInterval(() => {
      setTransferClockNow(Date.now());
    }, 1000);
    return () => window.clearInterval(timer);
  }, [hasActiveTransfer]);

  useEffect(() => {
    void Promise.all([
      listProfiles(),
      listFolders(),
      listCommandSnippets(),
      getLayoutSettings(),
      listAssistants(),
      recentAudit()
    ]).then(
      ([profilesResult, foldersResult, commandsResult, layoutResult, assistantsResult, auditResult]) => {
        setProfiles(profilesResult);
        setFolders(foldersResult);
        setCommandSnippets(commandsResult);
        setLayoutSettings(layoutResult);
        const effectiveLayout = resolveStartupLayout(layoutResult);
        setSidebarCollapsed(!effectiveLayout.leftSidebarOpen);
        setAssistantOpen(effectiveLayout.rightSidebarOpen);
        setBottomPanelOpen(effectiveLayout.bottomPanelOpen);
        setAssistants(assistantsResult);
        setAudit(auditResult);
        setActiveProfileId(null);
      }
    );
  }, []);

  useEffect(() => {
    activeProfileIdRef.current = activeProfileId;
  }, [activeProfileId]);

  useEffect(() => {
    profilesRef.current = profiles;
  }, [profiles]);

  useEffect(() => {
    if (!isDesktopRuntime) {
      return;
    }

    let unlisten: (() => void) | undefined;
    void listen<SessionEventPayload>("session:event", (event) => {
      const payload = event.payload;

      if ("StateChanged" in payload) {
        const { session_id, state } = payload.StateChanged;
        setSessions((current) =>
          current.map((session) => session.id === session_id ? { ...session, state } : session)
        );
        return;
      }

      if ("TerminalOutput" in payload) {
        const { session_id, data } = payload.TerminalOutput;
        appendTerminalOutput(data, session_id);
        return;
      }

      if ("SftpProgress" in payload) {
        const progress = payload.SftpProgress;
        upsertTransfer(progress);
      }
    }).then((dispose) => {
      unlisten = dispose;
    });

    return () => {
      unlisten?.();
    };
  }, [appendTerminalOutput, upsertTransfer]);

  const activeProfile = useMemo(
    () => profiles.find((profile) => profile.id === activeProfileId),
    [activeProfileId, profiles]
  );

  const activeSession = useMemo(
    () => sessions.find((session) => session.id === activeProfile?.id && isConnectedState(session.state)),
    [activeProfile?.id, sessions]
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

  const openProfiles = useMemo(
    () => openProfileIds
      .map((id) => profiles.find((profile) => profile.id === id))
      .filter((profile): profile is SessionProfile => Boolean(profile)),
    [openProfileIds, profiles]
  );

  const activeProfileIndex = useMemo(
    () => openProfiles.findIndex((profile) => profile.id === activeProfile?.id),
    [activeProfile?.id, openProfiles]
  );

  const connectedSessions = useMemo(
    () => sessions.filter((session) => isConnectedState(session.state)),
    [sessions]
  );

  useEffect(() => {
    if (!activeProfile) {
      activeProfileIdRef.current = null;
      replaceTerminalOutput(READY_TERMINAL_OUTPUT, "empty");
      return;
    }

    activeProfileIdRef.current = activeProfile.id;
    const cached = terminalCacheRef.current[activeProfile.id] ?? buildSelectedProfileSeed(activeProfile);
    replaceTerminalOutput(cached, activeProfile.id);
    window.setTimeout(() => terminalRef.current?.focus(), 0);
  }, [activeProfile, replaceTerminalOutput]);

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
      return;
    }

    let cancelled = false;
    void terminalOutputTail(activeSession.id).then((tail) => {
      if (!cancelled) {
        syncTerminalTail(tail, activeSession.id);
      }
    }).catch(() => {});
    const timer = window.setInterval(() => {
      void terminalOutputTail(activeSession.id).then((tail) => {
        if (!cancelled) {
          syncTerminalTail(tail, activeSession.id);
        }
      }).catch(() => {});
    }, 500);

    return () => {
      cancelled = true;
      window.clearInterval(timer);
    };
  }, [activeSession?.id, syncTerminalTail]);

  const flash = useCallback((message: string) => {
    setNotice(message);
    window.setTimeout(() => setNotice(null), 1800);
  }, []);

  const openShellProfile = useCallback((profileId: string) => {
    setOpenProfileIds((current) => current.includes(profileId) ? current : [...current, profileId]);
    setActiveProfileId(profileId);
  }, []);

  const closeShellProfile = useCallback(async (profileId: string) => {
    setOpenProfileIds((current) => {
      const next = current.filter((id) => id !== profileId);
      if (activeProfileId === profileId) {
        setActiveProfileId(next.at(-1) ?? null);
      }
      return next;
    });
    setSessions((current) => current.filter((session) => session.id !== profileId));
    terminalCacheRef.current[profileId] = "";
    try {
      await disconnectProfile(profileId);
    } catch {
      // Closing a tab should still succeed if the session was already gone.
    }
  }, [activeProfileId]);

  const closeAllShells = useCallback(async () => {
    const ids = [...openProfileIds];
    setOpenProfileIds([]);
    setActiveProfileId(null);
    setSessions((current) => current.filter((session) => !ids.includes(session.id)));
    ids.forEach((id) => {
      terminalCacheRef.current[id] = "";
    });
    await Promise.all(ids.map((id) => disconnectProfile(id).catch(() => undefined)));
  }, [openProfileIds]);

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

  const saveLayoutPreference = useCallback((patch: Partial<LayoutSettings>) => {
    setLayoutSettings((current) => {
      const next = { ...current, ...patch };
      void saveLayoutSettings(next).catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        flash(`布局设置保存失败：${message}`);
      });
      return next;
    });
  }, [flash]);

  const setLeftSidebarOpen = useCallback((open: boolean) => {
    setSidebarCollapsed(!open);
    if (layoutSettings.restore_last_layout) {
      saveLayoutPreference({ last_left_sidebar_open: open });
    }
  }, [layoutSettings.restore_last_layout, saveLayoutPreference]);

  const setRightSidebarOpen = useCallback((open: boolean) => {
    setAssistantOpen(open);
    if (layoutSettings.restore_last_layout) {
      saveLayoutPreference({ last_right_sidebar_open: open });
    }
  }, [layoutSettings.restore_last_layout, saveLayoutPreference]);

  const setBottomPanelPreferenceOpen = useCallback((open: boolean) => {
    setBottomPanelOpen(open);
    if (layoutSettings.restore_last_layout) {
      saveLayoutPreference({ last_bottom_panel_open: open });
    }
  }, [layoutSettings.restore_last_layout, saveLayoutPreference]);

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
    } finally {
      systemSyncInFlightRef.current = false;
    }
  }, [activeSession]);

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
    void refreshSftpListing(sftpPath);
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

  const connectSelectedProfile = useCallback(async (profile: SessionProfile) => {
    openShellProfile(profile.id);
    setActiveProfileId(profile.id);
    setConnecting(true);
    replaceTerminalOutput(buildConnectingTerminalSeed(profile), profile.id);

    try {
      const session = await connectProfile(profile.id);
      setSessions((current) => [
        session,
        ...current.filter((item) => item.id !== session.id)
      ]);
      const tail = await terminalOutputTail(session.id);
      if (tail.trim()) {
        replaceTerminalOutput(tail, session.id);
      }
      window.setTimeout(() => terminalRef.current?.focus(), 0);
      flash(`已连接 ${session.profile_name}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setSessions((current) => current.filter((item) => item.id !== profile.id));
      replaceTerminalOutput(buildFailedTerminalSeed(profile, message), profile.id);
      flash(`连接失败：${message}`);
    } finally {
      setConnecting(false);
    }
  }, [flash, openShellProfile, replaceTerminalOutput]);

  const connect = useCallback(async () => {
    if (!activeProfile) {
      setEditingProfile(createUniqueBlankProfile(profiles));
      setSettingsOpen(true);
      flash("请先添加 SSH 连接参数");
      return;
    }

    await connectSelectedProfile(activeProfile);
  }, [activeProfile, connectSelectedProfile, flash, profiles]);

  const runPreview = useCallback(async () => {
    const result = await previewToolCall(
      "General Assistant",
      "terminal.run_command",
      "df -h"
    );
    setPreview(result);
  }, []);

  const handleInput = useCallback(
    (data: string) => {
      setTerminalInputCount((count) => count + 1);
      const targetSessionId = activeSession?.id ?? activeProfile?.id;
      if (!targetSessionId) {
        return;
      }
      void writeTerminal(targetSessionId, data).catch((error) => {
        const message = error instanceof Error ? error.message : String(error);
        terminalRef.current?.write(`\r\n[local input failed] ${message}\r\n`);
        void sessionDiagnostics(targetSessionId).then((diagnostics) => {
          terminalRef.current?.write(`[diagnostics] ${diagnostics}\r\n`);
        });
      });
    },
    [activeProfile?.id, activeSession?.id]
  );

  const sendCommandDraft = useCallback(() => {
    const command = commandDraft.trim();
    if (!command) {
      terminalRef.current?.focus();
      return;
    }
    const targetSessionId = activeSession?.id ?? activeProfile?.id;
    if (!targetSessionId) {
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
  }, [activeProfile?.id, activeSession?.id, commandDraft, flash]);

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

  const createRemoteDirectory = useCallback(async () => {
    if (!activeSession) {
      flash("请先连接 SSH session");
      return;
    }
    const name = window.prompt("新建远程目录名称", "new-folder");
    if (!name?.trim()) {
      return;
    }
    const target = joinRemotePath(sftpPath, name.trim());
    setSftpBusy(true);
    try {
      await sftpCreateDir(activeSession.id, target);
      flash(`已创建目录 ${name.trim()}`);
      await refreshSftpListing(sftpPath);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      flash(`创建目录失败：${message}`);
      setSftpStatus(`创建失败：${message}`);
    } finally {
      setSftpBusy(false);
    }
  }, [activeSession, flash, refreshSftpListing, sftpPath]);

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

  const deleteRemoteEntry = useCallback(async () => {
    if (!activeSession || !selectedRemoteEntry) {
      flash("请先选择远程文件或目录");
      return;
    }
    const confirmed = window.confirm(`确认删除远程${selectedRemoteEntry.is_dir ? "目录" : "文件"}：${selectedRemoteEntry.path}`);
    if (!confirmed) {
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
  }, [activeSession, flash, refreshSftpListing, selectedRemoteEntry, sftpPath]);

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
          localPath,
          remotePath,
          status: "Running"
        });
        upsertTransfer(pending);
        try {
          const completed = await sftpUploadFile(activeSession.id, transferId, localPath, remotePath);
          upsertTransfer(completed, pending.id);
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
  }, [cancellingTransfers, flash]);

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

  const openTabContextMenu = useCallback((profile: SessionProfile, event: React.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    setContextMenu({
      kind: "tab",
      profileId: profile.id,
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
    const confirmed = window.confirm(
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
  }, [flash, folders, profiles]);

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

  const removeTransfer = useCallback((transferId: string) => {
    setTransfers((current) => current.filter((transfer) => transfer.id !== transferId));
    setTransferStats((current) => {
      if (!current[transferId]) {
        return current;
      }
      const next = { ...current };
      delete next[transferId];
      return next;
    });
    setCancellingTransfers((current) => {
      if (!current[transferId]) {
        return current;
      }
      const next = { ...current };
      delete next[transferId];
      return next;
    });
  }, []);

  const retryTransfer = useCallback(async (transfer: SftpProgress) => {
    const session = sessions.find((item) => item.id === transfer.session_id && isConnectedState(item.state));
    if (!session) {
      flash("请先重新连接该 SSH 会话");
      return;
    }

    const transferId = crypto.randomUUID();
    const pending = createTransferProgress({
      id: transferId,
      direction: transfer.direction,
      sessionId: session.id,
      localPath: transfer.local_path,
      remotePath: transfer.remote_path,
      bytesTotal: transfer.bytes_total ?? null,
      status: "Running"
    });
    upsertTransfer(pending);

    try {
      const completed = transfer.direction === "Upload"
        ? await sftpUploadFile(session.id, transferId, transfer.local_path, transfer.remote_path)
        : await sftpDownloadFile(session.id, transferId, transfer.remote_path, transfer.local_path);
      upsertTransfer(completed, pending.id);
      flash(`重试完成：${remoteBasename(transfer.remote_path)}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      markTransferFailed(transferId, pending, message);
      flash(`重试失败：${message}`);
    }
  }, [flash, markTransferFailed, sessions, upsertTransfer]);

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
    const name = window.prompt("新建文件夹名称", "项目服务器");
    const cleanName = name?.trim();
    if (!cleanName) {
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
  }, [flash]);

  const openCreateContextMenu = useCallback((event: React.MouseEvent) => {
    event.preventDefault();
    event.stopPropagation();
    setContextMenu({
      kind: "create",
      x: Math.max(8, Math.min(event.clientX, window.innerWidth - 220)),
      y: Math.max(8, Math.min(event.clientY, window.innerHeight - 180))
    });
  }, []);

  const activatePreviousProfile = useCallback(() => {
    if (activeProfileIndex > 0) {
      setActiveProfileId(openProfiles[activeProfileIndex - 1].id);
    }
  }, [activeProfileIndex, openProfiles]);

  const activateNextProfile = useCallback(() => {
    if (activeProfileIndex >= 0 && activeProfileIndex < openProfiles.length - 1) {
      setActiveProfileId(openProfiles[activeProfileIndex + 1].id);
    }
  }, [activeProfileIndex, openProfiles]);

  const minimizeWindow = useCallback(() => {
    if (!isDesktopRuntime) {
      flash("桌面打包版本可使用窗口控制");
      return;
    }
    void getCurrentWindow().minimize();
  }, [flash]);

  const toggleMaximizeWindow = useCallback(() => {
    if (!isDesktopRuntime) {
      flash("桌面打包版本可使用窗口控制");
      return;
    }
    void getCurrentWindow().toggleMaximize();
  }, [flash]);

  const closeWindow = useCallback(() => {
    if (!isDesktopRuntime) {
      flash("桌面打包版本可使用窗口控制");
      return;
    }
    void getCurrentWindow().close();
  }, [flash]);

  return (
    <div className={`app-shell ${assistantOpen ? "assistant-open" : "assistant-collapsed"} ${sidebarCollapsed ? "sidebar-collapsed" : "sidebar-open"}`}>
      {splashVisible ? <JoyshellSplash closing={splashClosing} /> : null}
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
              disabled={activeProfileIndex < 0 || activeProfileIndex >= openProfiles.length - 1}
            >
              <ChevronRight size={15} />
            </button>
          </div>
          <div className="system-titlebar-drag" data-tauri-drag-region />
          <div className="window-controls">
            <button title="最小化" onClick={minimizeWindow}>
              <Minus size={15} />
            </button>
            <button title="最大化/还原" onClick={toggleMaximizeWindow}>
              <Square size={12} />
            </button>
            <button className="close" title="关闭" onClick={closeWindow}>
              <X size={15} />
            </button>
          </div>
        </header>

        <aside className={`sidebar ${sidebarCollapsed ? "collapsed" : ""}`}>
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
            <div className="system-details">
              <span>运行 {formatUptime(systemSnapshot?.uptime_seconds ?? 0)}</span>
              <span>负载 {formatLoad(systemSnapshot)}</span>
              <span>{systemStatus}</span>
            </div>
          </div>

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
                        onDoubleClick={() => void connectSelectedProfile(profile)}
                        onKeyDown={(event) => {
                          if (event.key === "Enter") {
                            event.preventDefault();
                            openShellProfile(profile.id);
                          }
                        }}
                        onContextMenu={(event) => openSessionContextMenu(profile, event)}
                      >
                        <span className={`session-status-dot ${sessions.some((session) => session.id === profile.id) ? "online" : ""}`} />
                        <span className="session-os-badge">{inferProfileOs(profile).label}</span>
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
            <button className="app-settings-button" onClick={() => setAppSettingsOpen(true)} title="应用设置">
              <Settings size={15} />
            </button>
            <button className="app-settings-button" onClick={() => flash("更新检查将在版本服务接入后启用")} title="检查更新">
              <RefreshCw size={15} />
            </button>
          </div>
        </aside>
      </div>

      <main className={`workspace ${!activeProfile ? "home-mode" : ""}`}>
        <section
          className="terminal-region"
          onContextMenu={(event) => openAppContextMenu("terminal", event)}
        >
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
            {openProfiles.map((profile) => {
              const showBefore = dragIndicator?.kind === "tab"
                && dragIndicator.targetId === profile.id
                && dragIndicator.position === "before";
              const showAfter = dragIndicator?.kind === "tab"
                && dragIndicator.targetId === profile.id
                && dragIndicator.position === "after";
              return (
                <div className="tab-wrap" key={profile.id}>
                  {showBefore ? <div className="tab-drop-marker" /> : null}
                  <div
                    className={`tab ${profile.id === activeProfile?.id ? "active" : ""}`}
                    data-tab-profile-id={profile.id}
                    onClick={() => {
                      if (suppressNextClickRef.current) {
                        suppressNextClickRef.current = false;
                        return;
                      }
                      setActiveProfileId(profile.id);
                    }}
                    onContextMenu={(event) => openTabContextMenu(profile, event)}
                    onPointerDown={(event) => {
                      debugDrag("tab pointer down", { profileId: profile.id });
                      beginPointerDrag(event, { kind: "tab", id: profile.id, label: profile.name });
                    }}
                    onMouseDown={() => debugDrag("tab mouse down", { profileId: profile.id })}
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
                        reorderOpenTab(draggedId, profile.id);
                      }
                    }}
                    onDragEnd={() => {
                      draggedTabProfileIdRef.current = null;
                    }}
                  >
                    <span className="tab-main">
                      <Circle size={9} fill={sessions.some((session) => session.id === profile.id) ? "var(--joy-success)" : "var(--joy-danger)"} />
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
                        void closeShellProfile(profile.id);
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
            <button className="tab add-tab" onClick={openNewProfileDialog}>
              <Plus size={16} />
            </button>
          </div>
          <div className="terminal-stage">
            {!activeProfile ? (
              <ConnectionHome
                profiles={profiles}
                onAdd={openNewProfileDialog}
                onSelect={(profile) => setActiveProfileId(profile.id)}
                onConnect={(profile) => void connectSelectedProfile(profile)}
              />
            ) : (
              <>
                <JoyTerminal
                  id={activeSession?.id ?? "empty"}
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
            className={`file-region ${sftpDropActive ? "drop-active" : ""}`}
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
                  <Folder size={15} fill="#f2c94c" />
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

      <aside className="inspector" aria-label="AI assistant panel">
        <button
          className="drawer-toggle"
          title={assistantOpen ? "Collapse assistant" : "Open assistant"}
          onClick={() => setRightSidebarOpen(!assistantOpen)}
        >
          <PanelRight size={17} />
        </button>
        <div className="drawer-rail">
          <Bot size={18} />
          <ShieldCheck size={18} />
          <MessageSquareText size={18} />
        </div>
        <div className="drawer-content">
          <section className="panel">
            <div className="panel-heading">
              <Bot size={17} />
              <strong>AI 助手</strong>
            </div>
            <div className="assistant-list">
              {assistants.map((assistant) => (
                <div className="assistant-item" key={assistant.kind}>
                  <div className="assistant-avatar">{assistant.display_name.slice(0, 1)}</div>
                  <div>
                    <span>{assistant.display_name}</span>
                    <small>{assistant.can_spawn_children ? "main" : "limited"}</small>
                  </div>
                </div>
              ))}
            </div>
            <button className="secondary-button" onClick={runPreview}>
              <ShieldCheck size={15} /> Preview command permission
            </button>
            {preview ? (
              <div className={`decision ${preview.decision.behavior.toLowerCase()}`}>
                <strong>{preview.decision.behavior}</strong>
                <span>{preview.tool_name}</span>
                <small>{preview.decision.reason}</small>
              </div>
            ) : null}
          </section>

          <section className="panel">
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
                      <TransferMetric tone="success" label="大小" value={telemetry.size} />
                      <TransferMetric tone="danger" label="时间" value={telemetry.time} />
                      {telemetry.rate ? <TransferMetric tone="warning" label="速度" value={telemetry.rate} /> : null}
                    </div>
                  </div>
                  <div className="transfer-row-actions">
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
        </div>
      </aside>

      {contextMenu ? (
        <div className="context-menu-backdrop" onMouseDown={closeContextMenu}>
          <div
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
                <button onClick={() => { if (activeProfile) { void closeShellProfile(activeProfile.id); } closeContextMenu(); }} disabled={!activeProfile}>
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
                <button onClick={() => { void deleteRemoteEntry(); closeContextMenu(); }} disabled={!selectedRemoteEntry}>删除</button>
              </>
            ) : contextMenu.kind === "folder" ? (
              <>
                <button onClick={() => { if (contextFolder) { openNewProfileDialogInFolder(contextFolder.name); } closeContextMenu(); }} disabled={!contextFolder}>
                  <Server size={14} /> 新建服务器到此文件夹
                </button>
                <button onClick={() => { if (contextFolder) { startSessionFolderRename(contextFolder); } closeContextMenu(); }} disabled={!contextFolder}>
                  <Edit3 size={14} /> 重命名文件夹
                </button>
                <button onClick={() => { if (contextFolder) { void deleteSessionFolder(contextFolder); } closeContextMenu(); }} disabled={!contextFolder}>
                  <Trash2 size={14} /> 删除文件夹
                </button>
              </>
            ) : contextMenu.kind === "tab" ? (
              <>
                <button onClick={() => { if (contextTabProfile) { setActiveProfileId(contextTabProfile.id); } closeContextMenu(); }} disabled={!contextTabProfile}>
                  <ChevronRight size={14} /> 设为当前
                </button>
                <button onClick={() => { if (contextTabProfile) { void closeShellProfile(contextTabProfile.id); } closeContextMenu(); }} disabled={!contextTabProfile}>
                  <X size={14} /> 关闭 Shell
                </button>
                <button onClick={() => {
                  if (contextTabProfile) {
                    void Promise.all(openProfileIds
                      .filter((id) => id !== contextTabProfile.id)
                      .map((id) => closeShellProfile(id)));
                    setActiveProfileId(contextTabProfile.id);
                  }
                  closeContextMenu();
                }} disabled={!contextTabProfile || openProfileIds.length <= 1}>
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
                <button onClick={() => { if (contextProfile) { void closeShellProfile(contextProfile.id); } closeContextMenu(); }} disabled={!contextProfile || !openProfileIds.includes(contextProfile.id)}>
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
                <button onClick={() => { if (contextTransfer) { removeTransfer(contextTransfer.id); } closeContextMenu(); }} disabled={!contextTransfer || isTransferActive(contextTransfer.status)}>
                  <Trash2 size={14} /> 移除记录
                </button>
              </>
            )}
          </div>
        </div>
      ) : null}

      {notice ? <div className="toast">{notice}</div> : null}
      {appSettingsOpen ? (
        <AppSettingsDialog
          layout={layoutSettings}
          onLayoutChange={(patch) => {
            const nextPatch = patch.restore_last_layout
              ? {
                  ...patch,
                  last_left_sidebar_open: !sidebarCollapsed,
                  last_right_sidebar_open: assistantOpen,
                  last_bottom_panel_open: bottomPanelOpen
                }
              : patch;
            saveLayoutPreference(nextPatch);
          }}
          onClose={() => setAppSettingsOpen(false)}
        />
      ) : null}
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
          onSave={async (profile, password) => {
            const saved = await saveProfile(profile, password);
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

function deriveSystemStats(previous: SystemSnapshot | null, current: SystemSnapshot): SystemDerivedStats {
  if (!previous) {
    return emptySystemDerived;
  }

  const previousTotal = cpuTotal(previous.cpu);
  const currentTotal = cpuTotal(current.cpu);
  const totalDelta = currentTotal - previousTotal;
  const idleDelta = cpuIdle(current.cpu) - cpuIdle(previous.cpu);
  const cpuPercent = totalDelta > 0
    ? clampPercent(((totalDelta - idleDelta) / totalDelta) * 100)
    : null;

  const seconds = Math.max(
    0.001,
    (Date.parse(current.captured_at) - Date.parse(previous.captured_at)) / 1000
  );
  const previousNet = networkTotals(previous);
  const currentNet = networkTotals(current);
  const previousByInterface = new Map(previous.network.map((iface) => [iface.name, iface]));
  const interfaceRates = current.network.map((iface) => {
    const before = previousByInterface.get(iface.name);
    return {
      name: iface.name,
      rxRate: before ? Math.max(0, (iface.rx_bytes - before.rx_bytes) / seconds) : 0,
      txRate: before ? Math.max(0, (iface.tx_bytes - before.tx_bytes) / seconds) : 0
    };
  });

  return {
    cpuPercent,
    rxRate: Math.max(0, (currentNet.rx - previousNet.rx) / seconds),
    txRate: Math.max(0, (currentNet.tx - previousNet.tx) / seconds),
    interfaceRates
  };
}

function cpuTotal(cpu: SystemSnapshot["cpu"]) {
  return cpu.user + cpu.nice + cpu.system + cpu.idle + cpu.iowait + cpu.irq + cpu.softirq + cpu.steal;
}

function cpuIdle(cpu: SystemSnapshot["cpu"]) {
  return cpu.idle + cpu.iowait;
}

function networkTotals(snapshot: SystemSnapshot) {
  return snapshot.network
    .filter((iface) => iface.name !== "lo")
    .reduce(
      (total, iface) => ({
        rx: total.rx + iface.rx_bytes,
        tx: total.tx + iface.tx_bytes
      }),
      { rx: 0, tx: 0 }
    );
}

function clampPercent(value: number) {
  return Math.max(0, Math.min(100, value));
}

function formatPercent(value: number | null) {
  return value === null ? "--" : `${value.toFixed(0)}%`;
}

function formatMemoryMetric(sample?: SystemSnapshot["memory"]) {
  if (!sample || sample.total_bytes === 0) {
    return "待连接";
  }
  return `${((sample.used_bytes / sample.total_bytes) * 100).toFixed(0)}% ${formatBytes(sample.used_bytes)}/${formatBytes(sample.total_bytes)}`;
}

function usagePercent(sample?: SystemSnapshot["memory"] | SystemSnapshot["swap"]) {
  if (!sample || sample.total_bytes === 0) {
    return 0;
  }
  return clampPercent((sample.used_bytes / sample.total_bytes) * 100);
}

function formatUsagePercent(sample?: SystemSnapshot["memory"] | SystemSnapshot["swap"]) {
  if (!sample || sample.total_bytes === 0) {
    return "--";
  }
  return `${usagePercent(sample).toFixed(0)}%`;
}

function formatRootDisk(snapshot: SystemSnapshot | null) {
  const root = snapshot?.filesystems.find((fs) => fs.mount_point === "/") ?? snapshot?.filesystems[0];
  if (!root) {
    return "待连接";
  }
  return `${root.mount_point}: ${root.used_percent.toFixed(0)}%`;
}

function formatLoad(snapshot: SystemSnapshot | null) {
  if (!snapshot) {
    return "--, --, --";
  }
  return `${snapshot.load.one.toFixed(2)}, ${snapshot.load.five.toFixed(2)}, ${snapshot.load.fifteen.toFixed(2)}`;
}

function formatCpuFrequency(mhz?: number | null) {
  if (!mhz || mhz <= 0) {
    return "频率未知";
  }
  if (mhz >= 1000) {
    return `${(mhz / 1000).toFixed(2)} GHz`;
  }
  return `${mhz.toFixed(0)} MHz`;
}

function formatMemoryFrequency(mhz?: number | null) {
  if (!mhz || mhz <= 0) {
    return "频率未知";
  }
  return `${mhz.toFixed(0)} MHz`;
}

function buildSystemInfoClipboard(
  snapshot: SystemSnapshot | null,
  derived: SystemDerivedStats,
  activeProfile: SessionProfile | undefined,
  status: string
) {
  const lines = [
    "Joyshell System Information",
    `Status: ${status}`,
    `Target: ${activeProfile ? `${activeProfile.username}@${activeProfile.host}:${activeProfile.port}` : "not connected"}`
  ];

  if (!snapshot) {
    return lines.join("\n");
  }

  const cpuCoreCount = snapshot.cpu_info.logical_cores || snapshot.cpu_cores.length;
  const root = snapshot.filesystems.find((fs) => fs.mount_point === "/") ?? snapshot.filesystems[0];
  const rateByName = new Map(derived.interfaceRates.map((iface) => [iface.name, iface]));

  lines.push(
    "",
    `[Host]`,
    `Hostname: ${snapshot.host.hostname || "-"}`,
    `OS: ${snapshot.host.os_name || "-"}`,
    `Kernel: ${[snapshot.host.kernel_name, snapshot.host.kernel_release].filter(Boolean).join(" ") || "-"}`,
    `Arch: ${snapshot.host.architecture || "-"}`,
    `Primary IP: ${snapshot.host.primary_ip ?? "-"}`,
    `Device: ${snapshot.host.device_model ?? "-"}`,
    `Uptime: ${formatUptime(snapshot.uptime_seconds)}`,
    `Load: ${formatLoad(snapshot)}`,
    "",
    `[CPU]`,
    `Usage: ${formatPercent(derived.cpuPercent)}`,
    `Cores: ${cpuCoreCount || "-"}`,
    `Frequency: ${formatCpuFrequency(snapshot.cpu_info.mhz)}`,
    `Model: ${snapshot.cpu_info.model_name || "Unknown CPU"}`,
    `ARM part: ${snapshot.cpu_info.raw_part ?? "-"}`,
    "",
    `[Memory]`,
    `Usage: ${formatUsagePercent(snapshot.memory)}`,
    `Used/Total: ${formatBytes(snapshot.memory.used_bytes)}/${formatBytes(snapshot.memory.total_bytes)}`,
    `Frequency: ${formatMemoryFrequency(snapshot.memory_info.frequency_mhz)}`,
    `Swap: ${formatBytes(snapshot.swap.used_bytes)}/${formatBytes(snapshot.swap.total_bytes)}`,
    "",
    `[Process]`,
    `Running/Total: ${snapshot.processes.running}/${snapshot.processes.total}`,
    `Threads: ${snapshot.processes.threads}`,
    "",
    `[Disk]`,
    root ? `${root.mount_point}: ${root.used_percent.toFixed(0)}% used, ${formatBytes(root.available_bytes)} available` : "-"
  );

  lines.push("", "[Network]");
  const ifaces = snapshot.network.filter((iface) => iface.name !== "lo");
  if (ifaces.length === 0) {
    lines.push("-");
  } else {
    for (const iface of ifaces) {
      const rate = rateByName.get(iface.name);
      lines.push(
        `${iface.name}: ip=${iface.ipv4_addresses.join(",") || "-"} down=${formatRate(rate?.rxRate ?? 0)} up=${formatRate(rate?.txRate ?? 0)} rx=${formatBytes(iface.rx_bytes)} tx=${formatBytes(iface.tx_bytes)} errors=${iface.rx_errors}/${iface.tx_errors}`
      );
    }
  }

  return lines.join("\n");
}

async function writeClipboardText(text: string) {
  try {
    await writeDesktopClipboardText(text);
    return;
  } catch {
    // Fall back to the WebView clipboard path below.
  }

  try {
    await navigator.clipboard.writeText(text);
    return;
  } catch {
    const textarea = document.createElement("textarea");
    textarea.value = text;
    textarea.setAttribute("readonly", "true");
    textarea.style.position = "fixed";
    textarea.style.left = "-9999px";
    textarea.style.top = "0";
    document.body.appendChild(textarea);
    textarea.focus();
    textarea.select();
    try {
      if (!document.execCommand("copy")) {
        throw new Error("execCommand copy failed");
      }
    } finally {
      textarea.remove();
    }
  }
}

function TransferMetric({
  tone,
  label,
  value
}: {
  tone: "success" | "danger" | "warning";
  label: string;
  value: string;
}) {
  return (
    <span className={`transfer-metric ${tone}`}>
      <span className="transfer-metric-label">{label}</span>
      <RollingText value={value} />
    </span>
  );
}

function RollingText({ value }: { value: string }) {
  const [frame, setFrame] = useState({
    previous: value,
    current: value,
    sequence: 0,
    direction: "up" as "up" | "down"
  });

  useEffect(() => {
    setFrame((currentFrame) => {
      if (currentFrame.current === value) {
        return currentFrame;
      }
      return {
        previous: currentFrame.current,
        current: value,
        sequence: currentFrame.sequence + 1,
        direction: compareRollingValue(value, currentFrame.current) >= 0 ? "up" : "down"
      };
    });
  }, [value]);

  const width = Math.max(frame.previous.length, frame.current.length);
  const previous = frame.previous.padStart(width, " ");
  const current = frame.current.padStart(width, " ");

  return (
    <span className="rolling-text" aria-label={frame.current}>
      {Array.from(current).map((char, index) => {
        const previousChar = previous[index] ?? " ";
        const content = char === " " ? "\u00a0" : char;
        const previousContent = previousChar === " " ? "\u00a0" : previousChar;
        if (frame.sequence === 0 || char === previousChar) {
          return <span className="rolling-char stable" key={`${index}-${char}`}>{content}</span>;
        }
        return (
          <span className={`rolling-char ${frame.direction}`} key={`${frame.sequence}-${index}-${char}`}>
            <span className="rolling-char-old">{previousContent}</span>
            <span className="rolling-char-new">{content}</span>
          </span>
        );
      })}
    </span>
  );
}

function compareRollingValue(next: string, previous: string) {
  const nextNumber = Number.parseFloat(next.replace(/[^\d.]/g, ""));
  const previousNumber = Number.parseFloat(previous.replace(/[^\d.]/g, ""));
  if (Number.isFinite(nextNumber) && Number.isFinite(previousNumber)) {
    return nextNumber - previousNumber;
  }
  return next.localeCompare(previous);
}

function buildTransferTelemetry(
  transfer: SftpProgress,
  stats: TransferStats | undefined,
  now: number
) {
  const active = isTransferActive(transfer.status);
  const endAt = active ? now : stats?.lastAt ?? now;
  const startedAt = stats?.startedAt ?? endAt;
  const elapsedSeconds = Math.max(0, Math.floor((endAt - startedAt) / 1000));
  const averageElapsedSeconds = Math.max((endAt - startedAt) / 1000, 0);
  const averageRate = active && averageElapsedSeconds >= 0.5 && transfer.bytes_done > 0
    ? transfer.bytes_done / averageElapsedSeconds
    : 0;
  const rate = stats?.rateBytesPerSecond || averageRate;
  const total = transfer.bytes_total ?? null;
  const remainingBytes = total === null ? null : Math.max(total - transfer.bytes_done, 0);
  const estimatedSeconds = active && stats?.etaSeconds !== null && stats?.etaSeconds !== undefined
    ? Math.max(0, Math.ceil(stats.etaSeconds))
    : active && remainingBytes !== null && rate > 0
      ? Math.ceil(remainingBytes / rate)
      : active
        ? null
        : elapsedSeconds;

  return {
    size: `${formatBytes(transfer.bytes_done)} / ${total ? formatBytes(total) : "--"}`,
    time: `${formatTransferDuration(elapsedSeconds)}/${estimatedSeconds === null ? "--:--" : formatTransferDuration(estimatedSeconds)}`,
    rate: active ? formatRate(rate) : null
  };
}

function formatUptime(seconds: number) {
  if (!seconds) {
    return "--";
  }
  const minutes = Math.floor(seconds / 60);
  const hours = Math.floor(minutes / 60);
  const days = Math.floor(hours / 24);
  if (days > 0) {
    return `${days}天${hours % 24}小时`;
  }
  if (hours > 0) {
    return `${hours}小时${minutes % 60}分`;
  }
  return `${minutes}分`;
}

function formatRate(bytesPerSecond: number) {
  if (bytesPerSecond <= 0) {
    return "0 B/s";
  }
  return `${formatBytes(bytesPerSecond)}/s`;
}

function formatTransferDuration(seconds: number) {
  if (!Number.isFinite(seconds) || seconds <= 0) {
    return "00:00";
  }
  const wholeSeconds = Math.floor(seconds);
  const hours = Math.floor(wholeSeconds / 3600);
  const minutes = Math.floor((wholeSeconds % 3600) / 60);
  const remainingSeconds = wholeSeconds % 60;
  if (hours > 0) {
    return `${hours}:${padTimeUnit(minutes)}:${padTimeUnit(remainingSeconds)}`;
  }
  return `${padTimeUnit(minutes)}:${padTimeUnit(remainingSeconds)}`;
}

function padTimeUnit(value: number) {
  return value.toString().padStart(2, "0");
}

function formatBytes(bytes: number) {
  if (!Number.isFinite(bytes) || bytes <= 0) {
    return "0B";
  }
  const units = ["B", "K", "M", "G", "T"];
  let value = bytes;
  let index = 0;
  while (value >= 1024 && index < units.length - 1) {
    value /= 1024;
    index += 1;
  }
  return `${value >= 10 || index === 0 ? value.toFixed(0) : value.toFixed(1)}${units[index]}`;
}

function formatDateTime(value?: string | null) {
  if (!value) {
    return "--";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "--";
  }
  return date.toLocaleString();
}

function formatTransferStatus(transfer: SftpProgress) {
  if (typeof transfer.status === "string") {
    return transfer.status;
  }
  if ("Retrying" in transfer.status) {
    const { attempt, max_attempts, reason } = transfer.status.Retrying;
    return `Retrying ${attempt}/${max_attempts}: ${reason}`;
  }
  return `Failed: ${transfer.status.Failed.reason}`;
}

function isConnectedState(state: SessionInfo["state"]) {
  return state === "Connected";
}

function createTransferProgress({
  id = crypto.randomUUID(),
  direction,
  sessionId,
  localPath,
  remotePath,
  bytesTotal = null,
  status
}: {
  id?: string;
  direction: SftpProgress["direction"];
  sessionId: string;
  localPath: string;
  remotePath: string;
  bytesTotal?: number | null;
  status: SftpProgress["status"];
}): SftpProgress {
  return {
    id,
    session_id: sessionId,
    direction,
    local_path: localPath,
    remote_path: remotePath,
    bytes_done: 0,
    bytes_total: bytesTotal,
    status
  };
}

function isTransferActive(status: SftpProgress["status"]) {
  return status === "Running" || status === "Queued" || (typeof status !== "string" && "Retrying" in status);
}

function joinRemotePath(directory: string, name: string) {
  const cleanName = name.replaceAll("\\", "/").replace(/^\/+/, "");
  if (!directory || directory === ".") {
    return cleanName;
  }
  if (directory === "/") {
    return `/${cleanName}`;
  }
  return `${directory.replace(/\/+$/, "")}/${cleanName}`;
}

function remoteBasename(path: string) {
  return path.replaceAll("\\", "/").split("/").filter(Boolean).pop() || path;
}

function remoteParentDir(path: string) {
  const normalized = path.replaceAll("\\", "/");
  const lastSlash = normalized.lastIndexOf("/");
  if (lastSlash <= 0) {
    return normalized.startsWith("/") ? "/" : ".";
  }
  return normalized.slice(0, lastSlash);
}

function buildPathCrumbs(path: string) {
  const normalized = path || "/";
  if (normalized === "." || !normalized.startsWith("/")) {
    return [{ label: normalized, path: normalized }];
  }
  const parts = normalized.split("/").filter(Boolean);
  const crumbs = [{ label: "/", path: "/" }];
  let current = "";
  for (const part of parts) {
    current += `/${part}`;
    crumbs.push({ label: part, path: current });
  }
  return crumbs;
}

function trimCpuName(name: string) {
  return name
    .replace(/\(R\)|\(TM\)|CPU|Processor/gi, "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 42) || "Unknown";
}

function buildSelectedProfileSeed(profile: SessionProfile) {
  return [
    `Selected ${profile.name} (${profile.username || "user"}@${profile.host || "host"}:${profile.port}).`,
    "Click Connect to start a real SSH connection through the Tauri/Rust backend.",
    isDesktopRuntime
      ? "Desktop runtime detected: password will be checked by ssh2/libssh2."
      : "Preview runtime detected: this page cannot open a real SSH socket.",
    ""
  ].join("\r\n");
}

function buildConnectingTerminalSeed(profile: SessionProfile) {
  return [
    `Connecting to ${profile.username || "user"}@${profile.host}:${profile.port}...`,
    "Opening SSH session...",
    ""
  ].join("\r\n");
}

function buildFailedTerminalSeed(profile: SessionProfile, message: string) {
  return [
    `Connecting to ${profile.username || "user"}@${profile.host}:${profile.port}...`,
    "Connection failed.",
    "",
    message,
    ""
  ].join("\r\n");
}

function createBlankProfile(name = "新建服务器", group: string | null = null): SessionProfile {
  return {
    id: crypto.randomUUID(),
    name,
    group,
    host: "",
    port: 22,
    username: "",
    tags: [],
    favorite: false,
    sort_order: 0
  };
}

function createUniqueBlankProfile(profiles: SessionProfile[], group: string | null = null): SessionProfile {
  const nextOrder = profiles.reduce((max, profile) => Math.max(max, profile.sort_order ?? 0), -1) + 1;
  return { ...createBlankProfile(createUniqueProfileName(profiles, "新建服务器"), group), sort_order: nextOrder };
}

function createUniqueProfileName(profiles: SessionProfile[], baseName: string) {
  const existingNames = new Set(profiles.map((profile) => profile.name.trim()).filter(Boolean));
  if (!existingNames.has(baseName)) {
    return baseName;
  }

  let index = 1;
  while (existingNames.has(`${baseName}${index}`)) {
    index += 1;
  }
  return `${baseName}${index}`;
}

function resolveStartupLayout(settings: LayoutSettings) {
  return settings.restore_last_layout
    ? {
        leftSidebarOpen: settings.last_left_sidebar_open,
        rightSidebarOpen: settings.last_right_sidebar_open,
        bottomPanelOpen: settings.last_bottom_panel_open
      }
    : {
        leftSidebarOpen: settings.default_left_sidebar_open,
        rightSidebarOpen: settings.default_right_sidebar_open,
        bottomPanelOpen: settings.default_bottom_panel_open
      };
}

function buildProfileGroups(profiles: SessionProfile[], folders: SessionFolder[], sortMode: SidebarSortMode) {
  const folderGroups = folders.map((folder) => ({
    id: folder.id,
    name: folder.name,
    profiles: sortProfilesForSidebar(profiles.filter((profile) => profile.group === folder.name), sortMode)
  }));
  const folderNames = new Set(folders.map((folder) => folder.name));
  const looseProfiles = profiles.filter((profile) => !profile.group || !folderNames.has(profile.group));
  folderGroups.push({
    id: "ungrouped",
    name: "独立服务器",
    profiles: sortProfilesForSidebar(looseProfiles, sortMode)
  });
  return folderGroups;
}

function profileMatchesSearch(
  profile: SessionProfile,
  query: string,
  folderNameByProfileGroup: Map<string, string>
) {
  const folderName = profile.group ? folderNameByProfileGroup.get(profile.group) ?? profile.group : "独立服务器";
  const haystack = [
    profile.name,
    profile.host,
    String(profile.port),
    profile.username,
    folderName,
    ...profile.tags
  ].join(" ").toLowerCase();

  return haystack.includes(query);
}

function sortProfilesForSidebar(profiles: SessionProfile[], sortMode: SidebarSortMode) {
  return [...profiles].sort((left, right) => {
    if (left.favorite !== right.favorite) {
      return Number(right.favorite) - Number(left.favorite);
    }
    if (sortMode === "name") {
      return left.name.localeCompare(right.name, "zh-Hans-CN") || left.host.localeCompare(right.host);
    }
    if (sortMode === "host") {
      return left.host.localeCompare(right.host) || left.name.localeCompare(right.name, "zh-Hans-CN");
    }
    return (left.sort_order ?? 0) - (right.sort_order ?? 0) || left.name.localeCompare(right.name, "zh-Hans-CN");
  });
}

function normalizeProfileSortOrders(profiles: SessionProfile[]) {
  const groupOrder = new Map<string, number>();
  return profiles.map((profile) => {
    const key = profile.group ?? "__ungrouped__";
    const nextOrder = groupOrder.get(key) ?? 0;
    groupOrder.set(key, nextOrder + 1);
    return { ...profile, sort_order: nextOrder };
  });
}

function getProfileGroupName(profile: SessionProfile | undefined, folders: SessionFolder[]) {
  if (!profile?.group || !folders.some((folder) => folder.name === profile.group)) {
    return null;
  }
  return profile.group;
}

function groupNameFromGroupId(groupId: string | null | undefined, folders: SessionFolder[]) {
  if (!groupId || groupId === "ungrouped") {
    return null;
  }
  return folders.find((folder) => folder.id === groupId)?.name ?? null;
}

function reorderProfileByPointer(
  profiles: SessionProfile[],
  folders: SessionFolder[],
  draggedId: string,
  targetId: string | null,
  targetGroupId: string | null,
  clientY: number
) {
  const dragged = profiles.find((profile) => profile.id === draggedId);
  if (!dragged) {
    return profiles;
  }
  const target = targetId ? profiles.find((profile) => profile.id === targetId) : null;
  const targetGroupName = target
    ? getProfileGroupName(target, folders)
    : groupNameFromGroupId(targetGroupId, folders);
  const draggedGroupName = getProfileGroupName(dragged, folders);
  if (targetId === draggedId && targetGroupName === draggedGroupName) {
    return profiles;
  }

  const withoutDragged = profiles.filter((profile) => profile.id !== draggedId);
  const moved = { ...dragged, group: targetGroupName };
  let insertIndex = withoutDragged.length;

  if (target) {
    const targetElement = document.querySelector<HTMLElement>(`[data-session-profile-id="${target.id}"]`);
    const targetIndex = withoutDragged.findIndex((profile) => profile.id === target.id);
    if (targetIndex >= 0) {
      const rect = targetElement?.getBoundingClientRect();
      const placeAfter = rect ? clientY > rect.top + rect.height / 2 : false;
      insertIndex = targetIndex + (placeAfter ? 1 : 0);
    }
  } else if (targetGroupId) {
    const lastInGroup = withoutDragged
      .map((profile, index) => ({ profile, index }))
      .filter((item) => getProfileGroupName(item.profile, folders) === targetGroupName)
      .at(-1);
    insertIndex = lastInGroup ? lastInGroup.index + 1 : withoutDragged.length;
  }

  const next = [...withoutDragged];
  next.splice(insertIndex, 0, moved);
  return normalizeProfileSortOrders(next);
}

function moveProfileWithinCurrentGroup(
  profiles: SessionProfile[],
  profileId: string,
  action: "up" | "down" | "top" | "bottom"
) {
  const profile = profiles.find((item) => item.id === profileId);
  if (!profile) {
    return profiles;
  }
  const group = profile.group ?? null;
  const sameGroup = profiles.filter((item) => (item.group ?? null) === group)
    .sort((left, right) => (left.sort_order ?? 0) - (right.sort_order ?? 0));
  const index = sameGroup.findIndex((item) => item.id === profileId);
  if (index < 0) {
    return profiles;
  }

  const reordered = [...sameGroup];
  const [item] = reordered.splice(index, 1);
  const targetIndex = action === "top"
    ? 0
    : action === "bottom"
      ? reordered.length
      : action === "up"
        ? Math.max(0, index - 1)
        : Math.min(reordered.length, index + 1);
  reordered.splice(targetIndex, 0, item);
  const orderById = new Map(reordered.map((profileItem, order) => [profileItem.id, order]));
  return normalizeProfileSortOrders(profiles.map((profileItem) => (
    orderById.has(profileItem.id)
      ? { ...profileItem, sort_order: orderById.get(profileItem.id) ?? profileItem.sort_order }
      : profileItem
  )));
}

function findProfileDropIndicator(clientX: number, clientY: number, draggedId: string) {
  const elements = document.elementsFromPoint(clientX, clientY);
  const targetGroup = elements
    .map((element) => element.closest("[data-session-group-id]") as HTMLElement | null)
    .find(Boolean);
  if (!targetGroup) {
    return null;
  }

  const targetRow = elements
    .map((element) => element.closest("[data-session-profile-id]") as HTMLElement | null)
    .find((element) => Boolean(element) && element?.dataset.sessionProfileId !== draggedId);
  if (!targetRow) {
    return {
      groupId: targetGroup.dataset.sessionGroupId ?? null,
      targetId: null,
      position: "inside" as const,
      clientY
    };
  }

  const rect = targetRow.getBoundingClientRect();
  return {
    groupId: targetGroup.dataset.sessionGroupId ?? null,
    targetId: targetRow.dataset.sessionProfileId ?? null,
    position: clientY > rect.top + rect.height / 2 ? "after" as const : "before" as const,
    clientY
  };
}

function findTabDropIndicator(clientX: number, draggedId: string) {
  const tabs = Array.from(document.querySelectorAll<HTMLElement>("[data-tab-profile-id]"))
    .filter((element) => element.dataset.tabProfileId !== draggedId);
  if (tabs.length === 0) {
    return {
      targetId: null,
      position: "after" as const
    };
  }

  for (const tab of tabs) {
    const rect = tab.getBoundingClientRect();
    if (clientX < rect.left + rect.width / 2) {
      return {
        targetId: tab.dataset.tabProfileId ?? null,
        position: "before" as const
      };
    }
  }

  return {
    targetId: tabs.at(-1)?.dataset.tabProfileId ?? null,
    position: "after" as const
  };
}

function inferProfileOs(profile: SessionProfile) {
  const text = `${profile.name} ${profile.host} ${profile.tags.join(" ")} ${profile.group ?? ""}`.toLowerCase();
  if (text.includes("win")) {
    return { label: "WIN", tone: "windows" };
  }
  if (text.includes("mac") || text.includes("darwin")) {
    return { label: "MAC", tone: "mac" };
  }
  if (text.includes("ubuntu") || text.includes("debian") || text.includes("linux") || text.includes("centos")) {
    return { label: "LIN", tone: "linux" };
  }
  return { label: "SSH", tone: "unknown" };
}

function ConnectionHome({
  profiles,
  onAdd,
  onSelect,
  onConnect
}: {
  profiles: SessionProfile[];
  onAdd: () => void;
  onSelect: (profile: SessionProfile) => void;
  onConnect: (profile: SessionProfile) => void;
}) {
  if (profiles.length === 0) {
    return (
      <div className="connection-home empty">
        <div className="connection-home-inner">
          <div className="connection-home-icon">
            <Server size={34} />
          </div>
          <strong>添加第一台 SSH 服务器</strong>
          <span>Joyshell 会把服务器配置保存到本地 SQLite；密码暂不明文落盘。</span>
          <button className="primary-button" onClick={onAdd}>
            <Plus size={15} /> 添加服务器
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="connection-home">
      <div className="profile-orbit-strip" aria-label="服务器快捷入口">
        {profiles.map((profile) => {
          const os = inferProfileOs(profile);
          return (
            <button
              className={`profile-orbit-item ${os.tone}`}
              key={profile.id}
              title={`${profile.name}\n${profile.username}@${profile.host}:${profile.port}\n${profile.group ?? "未分组"}`}
              onClick={() => onSelect(profile)}
              onDoubleClick={() => onConnect(profile)}
            >
              <span className="profile-orbit-icon">{os.label}</span>
              <small>{profile.host}</small>
            </button>
          );
        })}
        <button className="profile-orbit-item add" title="添加服务器" onClick={onAdd}>
          <Plus size={22} />
          <small>New</small>
        </button>
      </div>
    </div>
  );
}

function trimTerminalCache(data: string) {
  if (data.length <= TERMINAL_CACHE_LIMIT) {
    return data;
  }
  return data.slice(data.length - TERMINAL_CACHE_LIMIT);
}

function loadCollapsedSessionFolders() {
  try {
    const raw = window.localStorage.getItem(COLLAPSED_SESSION_FOLDERS_STORAGE_KEY);
    if (!raw) {
      return new Set<string>();
    }
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed)) {
      return new Set<string>();
    }
    return new Set(parsed.filter((item): item is string => typeof item === "string"));
  } catch {
    return new Set<string>();
  }
}

function saveCollapsedSessionFolders(folderIds: Set<string>) {
  try {
    window.localStorage.setItem(
      COLLAPSED_SESSION_FOLDERS_STORAGE_KEY,
      JSON.stringify(Array.from(folderIds))
    );
  } catch {
    // Local storage can be unavailable in restricted preview contexts.
  }
}

function JoyshellSplash({ closing }: { closing: boolean }) {
  return (
    <div className={`splash-overlay ${closing ? "closing" : ""}`}>
      <div
        className="joyshell-splash"
        style={{ "--duration": "4.2s", "--center-opacity": "0.82" } as React.CSSProperties}
      >
        <svg viewBox="0 0 600 600" role="img" aria-label="Joyshell startup animation">
          <defs>
            <path id="joyshell-splash-word-top" d="M217.3 230.6 A108 108 0 0 1 382.7 230.6" />
            <clipPath id="joyshell-splash-center-clip">
              <circle cx="300" cy="300" r="72" />
            </clipPath>
          </defs>

          <circle cx="300" cy="300" r="238" className="orbit-accent" />
          <circle cx="300" cy="300" r="205" className="orbit-accent" />
          <circle cx="300" cy="300" r="170" className="orbit-accent" />

          <g className="orbit" style={{ "--turn": "405deg" } as React.CSSProperties}>
            <path className="orbit-line" d="M530.9 357.6 A238 238 0 0 1 69.1 357.6" />
            <path className="orbit-line" d="M69.1 242.4 A238 238 0 0 1 530.9 242.4" />
            <circle cx="538" cy="300" r="11" className="dot" />
            <circle cx="62" cy="300" r="11" className="dot" />
          </g>

          <g className="orbit reverse" style={{ "--turn": "-315deg" } as React.CSSProperties}>
            <path className="orbit-line" d="M250.4 498.9 A205 205 0 0 1 102.9 243.5" />
            <path className="orbit-line" d="M152.5 157.6 A205 205 0 0 1 447.5 157.6" />
            <path className="orbit-line" d="M497.1 243.5 A205 205 0 0 1 349.6 498.9" />
            <circle cx="300" cy="505" r="10" className="dot" />
            <circle cx="122.5" cy="197.5" r="10" className="dot" />
            <circle cx="477.5" cy="197.5" r="10" className="dot" />
          </g>

          <g className="orbit" style={{ "--turn": "500deg" } as React.CSSProperties}>
            <path className="orbit-line" d="M352.5 138.3 A170 170 0 1 1 247.5 138.3" />
            <circle cx="300" cy="130" r="12" className="dot" />
          </g>

          <circle cx="300" cy="300" r="132" className="inner-disc" />
          <circle cx="300" cy="300" r="103" className="inner-disc" />
          <image
            className="center-image"
            href={splashCenterImage}
            x="228"
            y="228"
            width="144"
            height="144"
            preserveAspectRatio="xMidYMid slice"
            clipPath="url(#joyshell-splash-center-clip)"
          />

          <g className="word-track word-ssh">
            <text className="word-ring small">
              <textPath href="#joyshell-splash-word-top" startOffset="50%" textAnchor="middle">SSHSHELL</textPath>
            </text>
          </g>
          <g className="word-track word-open">
            <text className="word-ring">
              <textPath href="#joyshell-splash-word-top" startOffset="50%" textAnchor="middle">OPENSOURCE</textPath>
            </text>
          </g>
          <g className="word-track word-spg">
            <text className="word-ring small">
              <textPath href="#joyshell-splash-word-top" startOffset="50%" textAnchor="middle">SPG</textPath>
            </text>
          </g>
          <g className="word-track word-joy">
            <text className="word-ring">
              <textPath href="#joyshell-splash-word-top" startOffset="50%" textAnchor="middle">JOYSHELL</textPath>
            </text>
          </g>
        </svg>
      </div>
    </div>
  );
}

function Metric({
  icon,
  label,
  value,
  tone
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  tone?: "warning" | "success";
}) {
  return (
    <div className={`metric ${tone ?? ""}`}>
      {icon}
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

function SystemMonitorPanel({
  activeProfile,
  derived,
  snapshot,
  status
}: {
  activeProfile?: SessionProfile;
  derived: SystemDerivedStats;
  snapshot: SystemSnapshot | null;
  status: string;
}) {
  const [networkDetailsOpen, setNetworkDetailsOpen] = useState(false);
  const [cpuDetailsOpen, setCpuDetailsOpen] = useState(false);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");
  const root = snapshot?.filesystems.find((fs) => fs.mount_point === "/") ?? snapshot?.filesystems[0];
  const primaryInterface = derived.interfaceRates.find((iface) => iface.name !== "lo")
    ?? derived.interfaceRates[0];
  const interfaceRateByName = new Map(derived.interfaceRates.map((iface) => [iface.name, iface]));
  const cpuCoreCount = snapshot ? snapshot.cpu_info.logical_cores || snapshot.cpu_cores.length : 0;
  const cpuFrequency = snapshot ? formatCpuFrequency(snapshot.cpu_info.mhz) : "频率未知";

  useEffect(() => {
    if (copyState === "idle") {
      return;
    }
    const timer = window.setTimeout(() => setCopyState("idle"), 1600);
    return () => window.clearTimeout(timer);
  }, [copyState]);

  const copySystemInfo = useCallback(async () => {
    try {
      await writeClipboardText(buildSystemInfoClipboard(snapshot, derived, activeProfile, status));
      setCopyState("copied");
    } catch {
      setCopyState("failed");
    }
  }, [activeProfile, derived, snapshot, status]);

  return (
    <div className="system-monitor">
      <div className="system-monitor-meta">
        <div>
          <span className="system-kicker">同步状态</span>
          <strong>{status}</strong>
        </div>
        <div>
          <span className="system-kicker">IP</span>
          <strong>{snapshot?.host.primary_ip ?? activeProfile?.host ?? "未连接"}</strong>
        </div>
        <button
          className={`copy-button ${copyState}`}
          type="button"
          onClick={copySystemInfo}
          title="复制系统信息"
        >
          <Copy size={13} />
          <span>{copyState === "copied" ? "已复制" : copyState === "failed" ? "失败" : "复制"}</span>
        </button>
      </div>

      <div className="system-monitor-grid">
        <button
          className={`system-monitor-card detail-card cpu-card ${cpuDetailsOpen ? "active" : ""}`}
          type="button"
          onClick={() => setCpuDetailsOpen((open) => !open)}
        >
          <div className="metric-title">
            <Cpu size={14} />
            <span>CPU</span>
            <strong>{formatPercent(derived.cpuPercent)}</strong>
          </div>
          <UsageBar value={derived.cpuPercent ?? 0} tone="cpu" />
          <small>
            {snapshot
              ? `${cpuCoreCount} 核 · ${cpuFrequency}`
              : "等待连接"}
          </small>
        </button>

        <div className="system-monitor-card">
          <div className="metric-title">
            <MemoryStick size={14} />
            <span>内存</span>
            <strong>{formatUsagePercent(snapshot?.memory)}</strong>
          </div>
          <UsageBar value={usagePercent(snapshot?.memory)} tone="memory" />
          <small>
            {snapshot
              ? `${formatBytes(snapshot.memory.used_bytes)}/${formatBytes(snapshot.memory.total_bytes)} · ${formatMemoryFrequency(snapshot.memory_info.frequency_mhz)}`
              : "等待连接"}
          </small>
        </div>

        <div className="system-monitor-card">
          <div className="metric-title">
            <HardDrive size={14} />
            <span>交换</span>
            <strong>{formatUsagePercent(snapshot?.swap)}</strong>
          </div>
          <UsageBar value={usagePercent(snapshot?.swap)} tone="swap" />
          <small>{snapshot ? `${formatBytes(snapshot.swap.used_bytes)}/${formatBytes(snapshot.swap.total_bytes)}` : "等待连接"}</small>
        </div>

        <button
          className={`system-monitor-card detail-card network-card ${networkDetailsOpen ? "active" : ""}`}
          type="button"
          onClick={() => setNetworkDetailsOpen((open) => !open)}
        >
          <div className="metric-title">
            <Network size={14} />
            <span>{primaryInterface?.name ?? "网络"}</span>
            <strong>{formatRate(derived.rxRate)}</strong>
          </div>
          <div className="network-rate-row">
            <span>↑ {formatRate(derived.txRate)}</span>
            <span>↓ {formatRate(derived.rxRate)}</span>
          </div>
          <small>
            {snapshot?.network
              .filter((iface) => iface.name !== "lo")
              .flatMap((iface) => iface.ipv4_addresses)
                .join(", ") || "无活动网卡"}
          </small>
        </button>
      </div>

      {cpuDetailsOpen ? (
        <div className="hardware-detail-panel">
          {snapshot ? (
            <>
              <div className="hardware-detail-row wide">
                <span>型号</span>
                <strong>{snapshot.cpu_info.model_name || "Unknown CPU"}</strong>
              </div>
              <div className="hardware-detail-row wide">
                <span>设备</span>
                <strong>{snapshot.host.device_model || "--"}</strong>
              </div>
              <div className="hardware-detail-row">
                <span>逻辑核心</span>
                <strong>{cpuCoreCount || "--"}</strong>
              </div>
              <div className="hardware-detail-row">
                <span>物理核心</span>
                <strong>{snapshot.cpu_info.physical_cores ?? "--"}</strong>
              </div>
              <div className="hardware-detail-row">
                <span>ARM Part</span>
                <strong>{snapshot.cpu_info.raw_part ?? "--"}</strong>
              </div>
              <div className="hardware-detail-row">
                <span>当前频率</span>
                <strong>{cpuFrequency}</strong>
              </div>
              <div className="hardware-detail-row">
                <span>架构</span>
                <strong>{snapshot.host.architecture || "--"}</strong>
              </div>
              <div className="hardware-detail-row wide">
                <span>内核</span>
                <strong>{[snapshot.host.kernel_name, snapshot.host.kernel_release].filter(Boolean).join(" ") || "--"}</strong>
              </div>
            </>
          ) : (
            <div className="network-detail-empty">等待 CPU 信息同步</div>
          )}
        </div>
      ) : null}

      {networkDetailsOpen ? (
        <div className="network-detail-panel">
          {snapshot?.network.length ? snapshot.network.map((iface) => {
            const rate = interfaceRateByName.get(iface.name);
            return (
              <div className="network-detail-row" key={iface.name}>
                <div>
                  <strong>{iface.name}</strong>
                  <small>{iface.ipv4_addresses.join(", ") || "无 IPv4 地址"}</small>
                </div>
                <span>↓ {formatRate(rate?.rxRate ?? 0)}</span>
                <span>↑ {formatRate(rate?.txRate ?? 0)}</span>
                <span>RX {formatBytes(iface.rx_bytes)}</span>
                <span>TX {formatBytes(iface.tx_bytes)}</span>
                <span>包 {iface.rx_packets}/{iface.tx_packets}</span>
                <span>错误 {iface.rx_errors}/{iface.tx_errors}</span>
              </div>
            );
          }) : (
            <div className="network-detail-empty">等待网络信息同步</div>
          )}
        </div>
      ) : null}

      <div className="system-monitor-footer">
        <span>运行 {formatUptime(snapshot?.uptime_seconds ?? 0)}</span>
        <span>负载 {formatLoad(snapshot)}</span>
        <span>进程 {snapshot ? `${snapshot.processes.running}/${snapshot.processes.total}` : "--"}</span>
        <span>磁盘 {root ? `${root.mount_point}: ${root.used_percent.toFixed(0)}%` : "--"}</span>
        <span>{snapshot?.host.os_name || "Linux/Unix 监控待同步"}</span>
      </div>
    </div>
  );
}

function UsageBar({ value, tone }: { value: number; tone: "cpu" | "memory" | "swap" }) {
  return (
    <div className={`usage-bar ${tone}`} aria-hidden="true">
      <span style={{ width: `${clampPercent(value)}%` }} />
    </div>
  );
}

function SystemInfoDialog({
  activeProfile,
  derived,
  snapshot,
  status,
  onClose,
  onRefresh
}: {
  activeProfile?: SessionProfile;
  derived: SystemDerivedStats;
  snapshot: SystemSnapshot | null;
  status: string;
  onClose: () => void;
  onRefresh: () => void;
}) {
  return (
    <div className="modal-backdrop" role="presentation">
      <section className="system-dialog" role="dialog" aria-modal="true" aria-label="系统信息">
        <header className="dialog-titlebar">
          <div>
            <Cpu size={16} />
            <strong>系统信息</strong>
          </div>
          <div className="dialog-title-actions">
            <button className="dialog-close" onClick={onRefresh} title="刷新">
              <RefreshCw size={15} />
            </button>
            <button className="dialog-close" onClick={onClose} title="关闭">
              <X size={16} />
            </button>
          </div>
        </header>
        <SystemMonitorPanel
          activeProfile={activeProfile}
          derived={derived}
          snapshot={snapshot}
          status={status}
        />
      </section>
    </div>
  );
}

function CommandLibraryPanel({
  snippets,
  connectedSessions,
  sendMode,
  selectedTargets,
  titleDraft,
  commandDraft,
  editingId,
  onSend,
  onEdit,
  onDelete,
  onSelectTarget,
  onTitleChange,
  onCommandChange,
  onCancelEdit
}: {
  snippets: CommandSnippet[];
  connectedSessions: SessionInfo[];
  sendMode: "current" | "all" | "selected";
  selectedTargets: Record<string, boolean>;
  titleDraft: string;
  commandDraft: string;
  editingId: string | null;
  onSend: (command: string) => void;
  onEdit: (snippet: CommandSnippet) => void;
  onDelete: (snippet: CommandSnippet) => void;
  onSelectTarget: (sessionId: string, selected: boolean) => void;
  onTitleChange: (value: string) => void;
  onCommandChange: (value: string) => void;
  onCancelEdit: () => void;
}) {
  return (
    <div className="command-library">
      <div className="command-editor">
        <input
          value={titleDraft}
          onChange={(event) => onTitleChange(event.target.value)}
          placeholder="命令名称，例如 查看磁盘"
        />
        <textarea
          value={commandDraft}
          onChange={(event) => onCommandChange(event.target.value)}
          placeholder="命令内容，例如 df -h"
        />
        {editingId ? (
          <button className="mini-button" onClick={onCancelEdit}>取消编辑</button>
        ) : null}
      </div>

      <div className="command-targets">
        <strong>发送目标</strong>
        {sendMode === "selected" ? (
          connectedSessions.length ? connectedSessions.map((session) => (
            <label key={session.id}>
              <input
                type="checkbox"
                checked={Boolean(selectedTargets[session.id])}
                onChange={(event) => onSelectTarget(session.id, event.target.checked)}
              />
              <span>{session.profile_name}</span>
              <small>{session.username}@{session.host}</small>
            </label>
          )) : <span className="muted">暂无已连接设备。</span>
        ) : (
          <span className="muted">
            {sendMode === "current" ? "发送到当前活动会话。" : `发送到全部 ${connectedSessions.length} 台已连接设备。`}
          </span>
        )}
      </div>

      <div className="command-list">
        {snippets.length ? snippets.map((snippet) => (
          <div className="command-row" key={snippet.id}>
            <div>
              <strong>{snippet.title}</strong>
              <code>{snippet.command}</code>
            </div>
            <div className="command-row-actions">
              <button onClick={() => onSend(snippet.command)} title="发送命令">
                <Play size={13} />
              </button>
              <button onClick={() => onEdit(snippet)} title="编辑命令">
                <Edit3 size={13} />
              </button>
              <button onClick={() => onDelete(snippet)} title="删除命令">
                <Trash2 size={13} />
              </button>
            </div>
          </div>
        )) : (
          <div className="table-empty">暂无常用命令。填写上方内容后点击保存命令。</div>
        )}
      </div>
    </div>
  );
}

function AppSettingsDialog({
  layout,
  onLayoutChange,
  onClose
}: {
  layout: LayoutSettings;
  onLayoutChange: (patch: Partial<LayoutSettings>) => void;
  onClose: () => void;
}) {
  const [activePage, setActivePage] = useState<"general" | "appearance">("general");

  return (
    <div className="modal-backdrop app-settings-backdrop" role="presentation">
      <section className="app-settings-dialog" role="dialog" aria-modal="true" aria-label="应用设置">
        <aside className="app-settings-sidebar">
          <button className="settings-back-button" onClick={onClose}>
            <ChevronRight size={15} />
            返回应用
          </button>
          <label className="settings-search">
            <Search size={15} />
            <input placeholder="搜索设置..." />
          </label>
          <span className="settings-group-label">个人</span>
          <button
            className={`app-settings-node ${activePage === "general" ? "active" : ""}`}
            onClick={() => setActivePage("general")}
          >
            <Settings size={15} />
            常规
          </button>
          <button
            className={`app-settings-node ${activePage === "appearance" ? "active" : ""}`}
            onClick={() => setActivePage("appearance")}
          >
            <Palette size={15} />
            外观
          </button>
        </aside>
        <main className="app-settings-content">
          <header>
            <span>{activePage === "general" ? "常规" : "外观"}</span>
            <button className="dialog-close" onClick={onClose} title="关闭">
              <X size={16} />
            </button>
          </header>
          {activePage === "general" ? (
            <div className="settings-page">
              <section>
                <strong>启动</strong>
                <label className="settings-toggle-row">
                  <span>
                    <b>启动后恢复上次会话</b>
                    <small>后续接入持久化会话状态后启用。</small>
                  </span>
                  <input type="checkbox" disabled />
                </label>
                <label className="settings-toggle-row">
                  <span>
                    <b>连接后自动刷新文件列表</b>
                    <small>当前版本默认启用。</small>
                  </span>
                  <input type="checkbox" defaultChecked readOnly />
                </label>
              </section>
              <section>
                <strong>传输</strong>
                <label className="settings-toggle-row">
                  <span>
                    <b>显示传输速度和预计时间</b>
                    <small>完成后自动隐藏实时速度。</small>
                  </span>
                  <input type="checkbox" defaultChecked readOnly />
                </label>
              </section>
            </div>
          ) : (
            <div className="settings-page">
              <section>
                <strong>主题</strong>
                <div className="appearance-options">
                  <button className="appearance-swatch active">
                    <span style={{ background: "#ffffff" }} />
                    Codex White
                  </button>
                  <button className="appearance-swatch" disabled>
                    <span style={{ background: "#111827" }} />
                    Dark
                  </button>
                </div>
              </section>
              <section>
                <strong>界面</strong>
                <label className="settings-toggle-row">
                  <span>
                    <b>圆角高光列表</b>
                    <small>会话列表和任务队列使用统一轻高光风格。</small>
                  </span>
                  <input type="checkbox" defaultChecked readOnly />
                </label>
                <label className="settings-toggle-row">
                  <span>
                    <b>恢复上次退出布局</b>
                    <small>开启后自动记住退出前左右和底部面板状态。</small>
                  </span>
                  <input
                    type="checkbox"
                    checked={layout.restore_last_layout}
                    onChange={(event) => onLayoutChange({ restore_last_layout: event.target.checked })}
                  />
                </label>
                <label className="settings-toggle-row">
                  <span>
                    <b>默认打开左侧导航栏</b>
                    <small>仅在关闭“恢复上次退出布局”时作为启动默认值。</small>
                  </span>
                  <input
                    type="checkbox"
                    checked={layout.default_left_sidebar_open}
                    disabled={layout.restore_last_layout}
                    onChange={(event) => onLayoutChange({ default_left_sidebar_open: event.target.checked })}
                  />
                </label>
                <label className="settings-toggle-row">
                  <span>
                    <b>默认打开右侧助手栏</b>
                    <small>仅在关闭“恢复上次退出布局”时作为启动默认值。</small>
                  </span>
                  <input
                    type="checkbox"
                    checked={layout.default_right_sidebar_open}
                    disabled={layout.restore_last_layout}
                    onChange={(event) => onLayoutChange({ default_right_sidebar_open: event.target.checked })}
                  />
                </label>
                <label className="settings-toggle-row">
                  <span>
                    <b>默认打开底部文件/命令栏</b>
                    <small>仅在关闭“恢复上次退出布局”时作为启动默认值。</small>
                  </span>
                  <input
                    type="checkbox"
                    checked={layout.default_bottom_panel_open}
                    disabled={layout.restore_last_layout}
                    onChange={(event) => onLayoutChange({ default_bottom_panel_open: event.target.checked })}
                  />
                </label>
              </section>
            </div>
          )}
        </main>
      </section>
    </div>
  );
}

function SshSettingsDialog({
  profile,
  folders,
  onClose,
  onSave
}: {
  profile: SessionProfile;
  folders: SessionFolder[];
  onClose: () => void;
  onSave: (profile: SessionProfile, password?: string) => void;
}) {
  const [draft, setDraft] = useState(profile);
  const [authMethod, setAuthMethod] = useState("password");
  const [password, setPassword] = useState("");
  const [tagsText, setTagsText] = useState(profile.tags.join(", "));
  const [error, setError] = useState<string | null>(null);

  const update = (key: keyof SessionProfile, value: string | number) => {
    setDraft((current) => ({ ...current, [key]: value }));
  };

  return (
    <div className="modal-backdrop" role="presentation">
      <section className="ssh-dialog" role="dialog" aria-modal="true" aria-label="SSH 连接设置">
        <header className="dialog-titlebar">
          <div>
            <Server size={16} />
            <strong>SSH 连接设置</strong>
          </div>
          <button className="dialog-close" onClick={onClose} title="关闭">
            <X size={16} />
          </button>
        </header>
        <div className="dialog-body">
          <aside className="settings-tree">
            <div className="settings-root">SSH连接</div>
            <button className="settings-node active">常规</button>
            <button className="settings-node">代理服务器</button>
            <button className="settings-node">隧道</button>
          </aside>
          <main className="settings-form">
            <fieldset>
              <legend>常规</legend>
              <label>
                <span>名称:</span>
                <input value={draft.name} onChange={(event) => update("name", event.target.value)} autoFocus />
              </label>
              <label>
                <span>主机:</span>
                <input value={draft.host} onChange={(event) => update("host", event.target.value)} />
              </label>
              <label>
                <span>端口:</span>
                <input
                  type="number"
                  min={1}
                  max={65535}
                  value={draft.port}
                  onChange={(event) => update("port", Number(event.target.value))}
                />
              </label>
              <label>
                <span>文件夹:</span>
                <input
                  list="session-folder-options"
                  value={draft.group ?? ""}
                  onChange={(event) => update("group", event.target.value)}
                  placeholder="未分组"
                />
                <datalist id="session-folder-options">
                  {folders.map((folder) => (
                    <option key={folder.id} value={folder.name} />
                  ))}
                </datalist>
              </label>
              <label className="wide">
                <span>备注:</span>
                <textarea
                  value={tagsText}
                  onChange={(event) => setTagsText(event.target.value)}
                  placeholder="可填写标签或备注，后续会进入会话管理搜索"
                />
              </label>
            </fieldset>

            <fieldset>
              <legend>认证</legend>
              <label>
                <span>方法:</span>
                <select value={authMethod} onChange={(event) => setAuthMethod(event.target.value)}>
                  <option value="password">密码</option>
                  <option value="privateKey">私钥</option>
                  <option value="agent">Agent</option>
                </select>
              </label>
              <label>
                <span>用户名:</span>
                <input value={draft.username} onChange={(event) => update("username", event.target.value)} />
              </label>
              <label>
                <span>密码:</span>
                <input
                  type="password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  placeholder="留空则继续使用已保存的加密密码"
                  disabled={authMethod !== "password"}
                />
              </label>
              <label className="wide">
                <span>私钥:</span>
                <div className="file-input-row">
                  <input placeholder="私钥认证接口已预留，尚未启用" disabled={authMethod !== "privateKey"} />
                  <button disabled={authMethod !== "privateKey"}>浏览...</button>
                </div>
              </label>
            </fieldset>

            <fieldset>
              <legend>高级</legend>
              <label className="check-row">
                <input type="checkbox" disabled />
                <span>跳板机 / 代理链预留</span>
              </label>
              <label className="check-row">
                <input type="checkbox" defaultChecked />
                <span>连接后打开交互式 Shell</span>
              </label>
            </fieldset>
          </main>
        </div>
        <footer className="dialog-actions">
          {error ? <span className="dialog-error">{error}</span> : null}
          <button onClick={onClose}>取消</button>
          <button
            className="save-button"
            onClick={() => {
              if (!draft.name.trim() || !draft.host.trim() || !draft.username.trim()) {
                setError("请填写名称、主机和用户名");
                return;
              }
              if (draft.port < 1 || draft.port > 65535) {
                setError("端口必须在 1 到 65535 之间");
                return;
              }
              if (authMethod !== "password") {
                setError("初版后端当前只接入密码认证，请先选择密码方式");
                return;
              }
              onSave({
                ...draft,
                name: draft.name.trim(),
                host: draft.host.trim(),
                username: draft.username.trim(),
                group: draft.group?.trim() || null,
                tags: tagsText
                  .split(",")
                  .map((tag) => tag.trim())
                  .filter(Boolean)
              }, password);
            }}
          >
            <Save size={15} /> 确定
          </button>
        </footer>
      </section>
    </div>
  );
}


