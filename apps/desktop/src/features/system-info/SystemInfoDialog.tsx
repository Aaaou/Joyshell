import { Copy, Cpu, HardDrive, MemoryStick, Network, RefreshCw, X } from "lucide-react";
import type React from "react";
import { useCallback, useEffect, useState } from "react";
import { desktopClient } from "../../platform/desktop-client";
import type { SessionProfile, SystemSnapshot } from "../../types";
import {
  buildSystemInfoClipboard, clampPercent, formatCpuFrequency, formatLoad, formatMemoryFrequency,
  formatPercent, formatUsagePercent, usagePercent, type SystemDerivedStats
} from "./system-model";
import { formatBytes, formatRate, formatUptime } from "../transfers/transfer-model";

async function writeClipboardText(text: string) {
  try {
    await desktopClient.writeClipboardText(text);
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

export function Metric({
  icon,
  label,
  value,
  tone
}: {
  icon: React.ReactNode;
  label: string;
  value: string;
  tone?: "warning" | "success" | "danger";
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

export function SystemInfoDialog({
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
