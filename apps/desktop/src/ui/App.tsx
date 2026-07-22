import { JoyTerminal, type JoyTerminalHandle } from "@joyshell/terminal";
import { listen } from "@tauri-apps/api/event";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { open as openDialog, save as saveDialog } from "@tauri-apps/plugin-dialog";
import type React from "react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  Bot,
  ChevronRight,
  Circle,
  Cpu,
  Download,
  Edit3,
  Folder,
  FolderPlus,
  HardDrive,
  KeyRound,
  MemoryStick,
  MessageSquareText,
  Network,
  PanelRight,
  Play,
  Plus,
  RefreshCw,
  Save,
  Search,
  Server,
  Settings,
  ShieldCheck,
  SplitSquareHorizontal,
  Star,
  TerminalSquare,
  Trash2,
  Upload,
  X
} from "lucide-react";
import { FileKindIcon } from "./FileKindIcon";
import {
  collectSystemSnapshot,
  cancelSftpTransfer,
  connectProfile,
  listAssistants,
  listProfiles,
  previewToolCall,
  recentAudit,
  saveProfile,
  sessionDiagnostics,
  sftpCreateDir,
  sftpDeletePath,
  sftpDownloadFile,
  sftpListDirectory,
  sftpRenamePath,
  sftpUploadFile,
  terminalOutputTail,
  writeTerminal
} from "../bridge";
import type {
  AgentToolCallPreview,
  AssistantDefinition,
  AuditEntry,
  RemoteDirectoryListing,
  RemoteFileEntry,
  SessionInfo,
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

type TransferStats = {
  startedAt: number;
  lastAt: number;
  lastBytes: number;
  rateBytesPerSecond: number;
};

type ContextMenuState = {
  kind: "terminal" | "file";
  x: number;
  y: number;
};

export function App() {
  const [profiles, setProfiles] = useState<SessionProfile[]>([]);
  const [sessions, setSessions] = useState<SessionInfo[]>([]);
  const [activeProfileId, setActiveProfileId] = useState<string | null>(null);
  const [assistants, setAssistants] = useState<AssistantDefinition[]>([]);
  const [preview, setPreview] = useState<AgentToolCallPreview | null>(null);
  const [audit, setAudit] = useState<AuditEntry[]>([]);
  const [assistantOpen, setAssistantOpen] = useState(true);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [editingProfile, setEditingProfile] = useState<SessionProfile | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [commandDraft, setCommandDraft] = useState("");
  const [terminalInputCount, setTerminalInputCount] = useState(0);
  const [terminalRevision, setTerminalRevision] = useState(0);
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
  const [terminalSeed, setTerminalSeed] = useState(
    "Joyshell is ready. Add an SSH connection, then click Connect.\r\n"
  );
  const terminalRef = useRef<JoyTerminalHandle | null>(null);
  const fileRegionRef = useRef<HTMLElement | null>(null);
  const terminalMirrorRef = useRef(terminalSeed);
  const activeProfileIdRef = useRef<string | null>(null);
  const previousSystemSnapshotRef = useRef<SystemSnapshot | null>(null);
  const systemSyncInFlightRef = useRef(false);
  const systemSyncFailureCountRef = useRef(0);

  const replaceTerminalOutput = useCallback((data: string) => {
    terminalMirrorRef.current = data;
    setTerminalSeed(data);
    setTerminalRevision((revision) => revision + 1);
  }, []);

  const appendTerminalOutput = useCallback((data: string) => {
    terminalMirrorRef.current += data;
    terminalRef.current?.write(data);
  }, []);

  const syncTerminalTail = useCallback((tail: string) => {
    if (!tail || tail === terminalMirrorRef.current) {
      return;
    }

    if (tail.startsWith(terminalMirrorRef.current)) {
      appendTerminalOutput(tail.slice(terminalMirrorRef.current.length));
      return;
    }

    terminalMirrorRef.current = tail;
    terminalRef.current?.clear();
    terminalRef.current?.write(tail);
  }, [appendTerminalOutput]);

  const upsertTransfer = useCallback((progress: SftpProgress, replaceId?: string) => {
    const now = Date.now();
    setTransferStats((current) => {
      const existing = current[progress.id] ?? (replaceId ? current[replaceId] : undefined);
      const elapsedSeconds = existing ? Math.max((now - existing.lastAt) / 1000, 0) : 0;
      const byteDelta = existing ? progress.bytes_done - existing.lastBytes : 0;
      const instantRate = elapsedSeconds > 0.08 && byteDelta >= 0 ? byteDelta / elapsedSeconds : 0;
      const isActive = isTransferActive(progress.status);
      const rateBytesPerSecond = instantRate > 0
        ? existing?.rateBytesPerSecond
          ? existing.rateBytesPerSecond * 0.65 + instantRate * 0.35
          : instantRate
        : isActive
          ? existing?.rateBytesPerSecond ?? 0
          : existing?.rateBytesPerSecond ?? 0;
      const next = { ...current };
      if (replaceId && replaceId !== progress.id) {
        delete next[replaceId];
      }
      next[progress.id] = {
        startedAt: existing?.startedAt ?? now,
        lastAt: now,
        lastBytes: progress.bytes_done,
        rateBytesPerSecond
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
          rateBytesPerSecond: existing?.rateBytesPerSecond ?? 0
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
    if (!hasActiveTransfer) {
      return;
    }
    const timer = window.setInterval(() => {
      setTransferClockNow(Date.now());
    }, 1000);
    return () => window.clearInterval(timer);
  }, [hasActiveTransfer]);

  useEffect(() => {
    void Promise.all([listProfiles(), listAssistants(), recentAudit()]).then(
      ([profilesResult, assistantsResult, auditResult]) => {
        setProfiles(profilesResult);
        setAssistants(assistantsResult);
        setAudit(auditResult);
        setActiveProfileId(profilesResult[0]?.id ?? null);
      }
    );
  }, []);

  useEffect(() => {
    activeProfileIdRef.current = activeProfileId;
  }, [activeProfileId]);

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
        if (session_id === activeProfileIdRef.current) {
          appendTerminalOutput(data);
        }
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
    () => profiles.find((profile) => profile.id === activeProfileId) ?? profiles[0],
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

  useEffect(() => {
    if (!activeProfile) {
      replaceTerminalOutput("Joyshell is ready. Add an SSH connection, then click Connect.\r\n");
      return;
    }

    replaceTerminalOutput(buildSelectedProfileSeed(activeProfile));
  }, [activeProfile?.id, replaceTerminalOutput]);

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
    const timer = window.setInterval(() => {
      void terminalOutputTail(activeSession.id).then((tail) => {
        if (!cancelled && activeSession.id === activeProfileIdRef.current) {
          syncTerminalTail(tail);
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

  const connect = useCallback(async () => {
    if (!activeProfile) {
      setSettingsOpen(true);
      flash("请先添加 SSH 连接参数");
      return;
    }

    setConnecting(true);
    replaceTerminalOutput(buildConnectingTerminalSeed(activeProfile));

    try {
      const session = await connectProfile(activeProfile.id);
      setSessions((current) => [
        session,
        ...current.filter((item) => item.id !== session.id)
      ]);
      const tail = await terminalOutputTail(session.id);
      if (tail.trim()) {
        replaceTerminalOutput(tail);
      }
      window.setTimeout(() => terminalRef.current?.focus(), 0);
      flash(`已连接 ${session.profile_name}`);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      setSessions((current) => current.filter((item) => item.id !== activeProfile.id));
      replaceTerminalOutput(buildFailedTerminalSeed(activeProfile, message));
      flash(`连接失败：${message}`);
    } finally {
      setConnecting(false);
    }
  }, [activeProfile, flash, replaceTerminalOutput]);

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

  const renameRemoteEntry = useCallback(async () => {
    if (!activeSession || !selectedRemoteEntry) {
      flash("请先选择远程文件或目录");
      return;
    }
    const name = window.prompt("重命名为", selectedRemoteEntry.name);
    if (!name?.trim() || name.trim() === selectedRemoteEntry.name) {
      return;
    }
    const target = joinRemotePath(sftpPath, name.trim());
    setSftpBusy(true);
    try {
      await sftpRenamePath(activeSession.id, selectedRemoteEntry.path, target);
      flash(`已重命名为 ${name.trim()}`);
      await refreshSftpListing(sftpPath);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      flash(`重命名失败：${message}`);
      setSftpStatus(`重命名失败：${message}`);
    } finally {
      setSftpBusy(false);
    }
  }, [activeSession, flash, refreshSftpListing, selectedRemoteEntry, sftpPath]);

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
    const onPointerDown = () => setContextMenu(null);
    window.addEventListener("keydown", onKeyDown);
    window.addEventListener("mousedown", onPointerDown);
    return () => {
      window.removeEventListener("keydown", onKeyDown);
      window.removeEventListener("mousedown", onPointerDown);
    };
  }, []);

  const openNewProfileDialog = useCallback(() => {
    setEditingProfile(createBlankProfile());
    setSettingsOpen(true);
  }, []);

  const openEditProfileDialog = useCallback(() => {
    setEditingProfile(activeProfile ?? createBlankProfile());
    setSettingsOpen(true);
  }, [activeProfile]);

  return (
    <div className={`app-shell ${assistantOpen ? "assistant-open" : "assistant-collapsed"}`}>
      <aside className="sidebar">
        <div className="brand">
          <div className="brand-mark">J</div>
          <div>
            <strong>Joyshell</strong>
            <span>Desktop SSH Console</span>
          </div>
        </div>

        <div className="status-card">
          <div className="status-line">
            <span>运行模式</span>
            <Circle size={8} fill={isDesktopRuntime ? "#1f9d55" : "#c58515"} />
          </div>
          <div className="host-address">
            <span>{isDesktopRuntime ? "Desktop" : "Preview"}</span>
            <strong>{activeProfile?.host || "未连接"}</strong>
          </div>
          <div className="build-label">{clientBuildLabel}</div>
          <button className="system-button" onClick={() => void refreshSystemSnapshot()}>
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
          <input placeholder="Search sessions" />
        </label>

        <div className="nav-section">
          <div className="section-title-row">
            <span className="section-title">Sessions</span>
            <button className="tiny-action" title="新建连接" onClick={openNewProfileDialog}>
              <FolderPlus size={14} />
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
          ) : profiles.map((profile) => (
            <button
              className={`session-row ${profile.id === activeProfile?.id ? "active" : ""}`}
              key={profile.id}
              onClick={() => setActiveProfileId(profile.id)}
            >
              <span className={`session-status-dot ${sessions.some((session) => session.id === profile.id) ? "online" : ""}`} />
              <span className="session-main">
                <strong>{profile.name}</strong>
                <small>{profile.username}@{profile.host}</small>
              </span>
              {profile.favorite ? <Star size={14} fill="currentColor" /> : <ChevronRight size={14} />}
            </button>
          ))}
        </div>

        <div className="nav-section compact">
          <button onClick={() => flash("本地终端将在接入 PTY 后启用")}>
            <TerminalSquare size={16} /> 本地终端
          </button>
          <button onClick={() => flash("密钥管理将在 Secret Store 接入后启用")}>
            <KeyRound size={16} /> 密钥
          </button>
          <button onClick={openEditProfileDialog}>
            <Settings size={16} /> SSH 设置
          </button>
        </div>
      </aside>

      <main className="workspace">
        <header className="topbar">
          <div>
            <div className="crumb">
              <Folder size={15} />
              <span>{activeProfile?.group ?? "Joyshell"}</span>
              <ChevronRight size={14} />
              <strong>{activeProfile?.name ?? "未选择连接"}</strong>
            </div>
          </div>
          <div className="toolbar">
            <button className="icon-button" title="Refresh" onClick={() => flash("已刷新当前视图")}>
              <RefreshCw size={16} />
            </button>
            <button
              className="icon-button"
              title="Split terminal"
              onClick={() => flash("分屏布局将在终端多实例接入后启用")}
            >
              <SplitSquareHorizontal size={17} />
            </button>
            <button
              className="icon-button"
              title={assistantOpen ? "Collapse assistant" : "Open assistant"}
              onClick={() => setAssistantOpen((open) => !open)}
            >
              <PanelRight size={17} />
            </button>
            <button className="primary-button" onClick={connect} disabled={connecting}>
              <Play size={16} /> {connecting ? "Connecting" : "Connect"}
            </button>
          </div>
        </header>

        <section
          className="terminal-region"
          onContextMenuCapture={(event) => openAppContextMenu("terminal", event)}
        >
          <div className="terminal-tabs">
            {profiles.map((profile, index) => (
              <button
                className={`tab ${profile.id === activeProfile?.id ? "active" : ""}`}
                key={profile.id}
                onClick={() => setActiveProfileId(profile.id)}
              >
                <Circle size={9} fill={sessions.some((session) => session.id === profile.id) ? "var(--joy-success)" : "var(--joy-danger)"} />
                {index + 1} {profile.name}
              </button>
            ))}
            <button className="tab add-tab" onClick={openNewProfileDialog}>
              <Plus size={16} />
            </button>
          </div>
          <div className="terminal-stage">
            <JoyTerminal
              key={`${activeProfile?.id ?? "empty"}-${terminalRevision}`}
              id={activeSession?.id ?? "empty"}
              initialOutput={terminalSeed}
              onInput={handleInput}
              onReady={(terminal) => {
                terminalRef.current = terminal;
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
                <button>历史</button>
                <button>选项</button>
                <button onClick={printDiagnostics} title="打印 SSH 诊断">
                  <ShieldCheck size={13} />
                </button>
                <span className="input-meter" title="前端收到的终端输入次数">
                  in {terminalInputCount}
                </span>
                <Search size={15} />
                <Settings size={15} />
              </div>
            </div>
          </div>
        </section>

        <section
          ref={fileRegionRef}
          className={`file-region ${sftpDropActive ? "drop-active" : ""}`}
          onContextMenuCapture={(event) => openAppContextMenu("file", event)}
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
            <button className="file-tab active">文件</button>
            <button className="file-tab">命令</button>
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
            <button className="mini-icon" onClick={renameRemoteEntry} disabled={!selectedRemoteEntry || sftpBusy} title="重命名">
              <Edit3 size={14} />
            </button>
            <button className="mini-icon danger" onClick={deleteRemoteEntry} disabled={!selectedRemoteEntry || sftpBusy} title="删除">
              <Trash2 size={14} />
            </button>
          </div>
          <SystemMonitorPanel
            activeProfile={activeProfile}
            derived={systemDerived}
            snapshot={systemSnapshot}
            status={systemStatus}
          />
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
                  <button
                    className={`sftp-table-row ${entry.path === selectedRemotePath ? "selected" : ""}`}
                    key={entry.path}
                    onClick={() => setSelectedRemotePath(entry.path)}
                    onDoubleClick={() => openRemoteEntry(entry)}
                  >
                    <span className="file-name-cell">
                      <FileKindIcon path={entry.path} isDirectory={entry.is_dir} />
                      {entry.name}
                    </span>
                    <span>{entry.is_dir ? "--" : formatBytes(entry.size)}</span>
                    <span>{entry.permissions}</span>
                    <span>{formatDateTime(entry.modified_at)}</span>
                    <span>{entry.path}</span>
                  </button>
                ))
              ) : (
                <div className="table-empty">
                  {activeSession ? "当前目录为空，或点击刷新读取 SFTP 目录。" : "连接 SSH 后显示远程文件。"}
                </div>
              )}
            </div>
          </div>
        </section>
      </main>

      <aside className="inspector" aria-label="AI assistant panel">
        <button
          className="drawer-toggle"
          title={assistantOpen ? "Collapse assistant" : "Open assistant"}
          onClick={() => setAssistantOpen((open) => !open)}
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
                <div className="transfer-row" key={transfer.id}>
                  <div className="transfer-row-main">
                    <span className="transfer-title">
                      <FileKindIcon path={transfer.remote_path} />
                      {transfer.direction === "Upload" ? "上传" : "下载"} {remoteBasename(transfer.remote_path)}
                    </span>
                    <small>{statusLabel}</small>
                    <div className="transfer-telemetry">
                      <TransferMetric tone="success" label="大小" value={telemetry.size} />
                      <TransferMetric tone="danger" label="时间" value={telemetry.time} />
                      <TransferMetric tone="warning" label="速度" value={telemetry.rate} />
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
            {contextMenu.kind === "terminal" ? (
              <>
                <button onClick={() => { void copyTerminalSelection(); closeContextMenu(); }}>复制</button>
                <button onClick={() => { void pasteToTerminal(); closeContextMenu(); }}>粘贴</button>
                <button onClick={() => { selectAllTerminal(); closeContextMenu(); }}>全选</button>
                <button onClick={() => { clearTerminal(); closeContextMenu(); }}>清屏</button>
              </>
            ) : (
              <>
                <button onClick={() => { void refreshSftpListing(); closeContextMenu(); }}>刷新</button>
                <button onClick={() => { goParentDirectory(); closeContextMenu(); }} disabled={!sftpListing?.parent}>上级目录</button>
                <button onClick={() => { void uploadRemoteFile(); closeContextMenu(); }} disabled={!activeSession}>上传文件</button>
                <button onClick={() => { void createRemoteDirectory(); closeContextMenu(); }} disabled={!activeSession}>新建目录</button>
                <button onClick={() => { void downloadRemoteEntry(); closeContextMenu(); }} disabled={!selectedRemoteEntry || selectedRemoteEntry.is_dir}>下载</button>
                <button onClick={() => { void renameRemoteEntry(); closeContextMenu(); }} disabled={!selectedRemoteEntry}>重命名</button>
                <button onClick={() => { void deleteRemoteEntry(); closeContextMenu(); }} disabled={!selectedRemoteEntry}>删除</button>
              </>
            )}
          </div>
        </div>
      ) : null}

      {notice ? <div className="toast">{notice}</div> : null}
      {settingsOpen ? (
        <SshSettingsDialog
          profile={editingProfile ?? activeProfile ?? createBlankProfile()}
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
            setActiveProfileId(saved.id);
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
  const rate = stats?.rateBytesPerSecond ?? 0;
  const total = transfer.bytes_total ?? null;
  const remainingBytes = total === null ? null : Math.max(total - transfer.bytes_done, 0);
  const estimatedSeconds = active && remainingBytes !== null && rate > 0
    ? Math.ceil(remainingBytes / rate)
    : active
      ? null
      : elapsedSeconds;

  return {
    size: `${formatBytes(transfer.bytes_done)}/${total ? formatBytes(total) : "--"}`,
    time: `${formatTransferDuration(elapsedSeconds)}/${estimatedSeconds === null ? "--:--" : formatTransferDuration(estimatedSeconds)}`,
    rate: formatRate(active ? rate : 0)
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

function createBlankProfile(): SessionProfile {
  return {
    id: crypto.randomUUID(),
    name: "新建连接",
    group: "SSH连接",
    host: "",
    port: 22,
    username: "",
    tags: [],
    favorite: false
  };
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
  const root = snapshot?.filesystems.find((fs) => fs.mount_point === "/") ?? snapshot?.filesystems[0];
  const primaryInterface = derived.interfaceRates.find((iface) => iface.name !== "lo")
    ?? derived.interfaceRates[0];

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
        <button className="copy-button" type="button">复制</button>
      </div>

      <div className="system-monitor-grid">
        <div className="system-monitor-card">
          <div className="metric-title">
            <Cpu size={14} />
            <span>CPU</span>
            <strong>{formatPercent(derived.cpuPercent)}</strong>
          </div>
          <UsageBar value={derived.cpuPercent ?? 0} tone="cpu" />
          <small>
            {snapshot
              ? `${snapshot.cpu_info.logical_cores || snapshot.cpu_cores.length} 核 · ${trimCpuName(snapshot.cpu_info.model_name)}`
              : "等待连接"}
          </small>
        </div>

        <div className="system-monitor-card">
          <div className="metric-title">
            <MemoryStick size={14} />
            <span>内存</span>
            <strong>{formatUsagePercent(snapshot?.memory)}</strong>
          </div>
          <UsageBar value={usagePercent(snapshot?.memory)} tone="memory" />
          <small>{snapshot ? `${formatBytes(snapshot.memory.used_bytes)}/${formatBytes(snapshot.memory.total_bytes)}` : "等待连接"}</small>
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

        <div className="system-monitor-card">
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
        </div>
      </div>

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

function SshSettingsDialog({
  profile,
  onClose,
  onSave
}: {
  profile: SessionProfile;
  onClose: () => void;
  onSave: (profile: SessionProfile, password?: string) => void;
}) {
  const [draft, setDraft] = useState(profile);
  const [authMethod, setAuthMethod] = useState("password");
  const [password, setPassword] = useState("");
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
              <label className="wide">
                <span>备注:</span>
                <textarea
                  defaultValue={draft.tags.join(", ")}
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
                  placeholder="当前版本暂存在桌面进程内存"
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
                username: draft.username.trim()
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


