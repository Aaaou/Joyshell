import type { SessionProfile, SystemSnapshot } from "../../types";

export type SystemDerivedStats = {
  cpuPercent: number | null;
  rxRate: number;
  txRate: number;
  interfaceRates: Array<{ name: string; rxRate: number; txRate: number }>;
};

export const emptySystemDerived: SystemDerivedStats = {
  cpuPercent: null,
  rxRate: 0,
  txRate: 0,
  interfaceRates: []
};

export function clampPercent(value: number) {
  return Math.max(0, Math.min(100, value));
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
    .reduce((total, iface) => ({ rx: total.rx + iface.rx_bytes, tx: total.tx + iface.tx_bytes }), { rx: 0, tx: 0 });
}

export function deriveSystemStats(previous: SystemSnapshot | null, current: SystemSnapshot): SystemDerivedStats {
  if (!previous) {
    return emptySystemDerived;
  }
  const previousTotal = cpuTotal(previous.cpu);
  const currentTotal = cpuTotal(current.cpu);
  const totalDelta = currentTotal - previousTotal;
  const idleDelta = cpuIdle(current.cpu) - cpuIdle(previous.cpu);
  const cpuPercent = totalDelta > 0 ? clampPercent(((totalDelta - idleDelta) / totalDelta) * 100) : null;
  const seconds = Math.max(0.001, (Date.parse(current.captured_at) - Date.parse(previous.captured_at)) / 1000);
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

function formatRate(bytesPerSecond: number) {
  if (bytesPerSecond <= 0) {
    return "0 B/s";
  }
  return `${formatBytes(bytesPerSecond)}/s`;
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

export function formatPercent(value: number | null) {
  return value === null ? "--" : `${value.toFixed(0)}%`;
}

export function formatMemoryMetric(sample?: SystemSnapshot["memory"]) {
  if (!sample || sample.total_bytes === 0) {
    return "\u5f85\u8fde\u63a5";
  }
  return `${((sample.used_bytes / sample.total_bytes) * 100).toFixed(0)}% ${formatBytes(sample.used_bytes)}/${formatBytes(sample.total_bytes)}`;
}

export function usagePercent(sample?: SystemSnapshot["memory"] | SystemSnapshot["swap"]) {
  if (!sample || sample.total_bytes === 0) {
    return 0;
  }
  return clampPercent((sample.used_bytes / sample.total_bytes) * 100);
}

export function formatUsagePercent(sample?: SystemSnapshot["memory"] | SystemSnapshot["swap"]) {
  if (!sample || sample.total_bytes === 0) {
    return "--";
  }
  return `${usagePercent(sample).toFixed(0)}%`;
}

export function formatRootDisk(snapshot: SystemSnapshot | null) {
  const root = snapshot?.filesystems.find((fs) => fs.mount_point === "/") ?? snapshot?.filesystems[0];
  if (!root) {
    return "\u5f85\u8fde\u63a5";
  }
  return `${root.mount_point}: ${root.used_percent.toFixed(0)}%`;
}

export function formatLoad(snapshot: SystemSnapshot | null) {
  return snapshot ? `${snapshot.load.one.toFixed(2)}, ${snapshot.load.five.toFixed(2)}, ${snapshot.load.fifteen.toFixed(2)}` : "--, --, --";
}

export function formatCpuFrequency(mhz?: number | null) {
  if (!mhz || mhz <= 0) return "频率未知";
  return mhz >= 1000 ? `${(mhz / 1000).toFixed(2)} GHz` : `${mhz.toFixed(0)} MHz`;
}

export function formatMemoryFrequency(mhz?: number | null) {
  return !mhz || mhz <= 0 ? "频率未知" : `${mhz.toFixed(0)} MHz`;
}

export function formatSystemBytes(bytes: number) { return formatBytes(bytes); }
export function formatSystemRate(bytesPerSecond: number) { return formatRate(bytesPerSecond); }
export function formatSystemUptime(seconds: number) { return formatUptime(seconds); }

export function buildSystemInfoClipboard(
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
  if (!snapshot) return lines.join("\n");
  const cpuCoreCount = snapshot.cpu_info.logical_cores || snapshot.cpu_cores.length;
  const root = snapshot.filesystems.find((fs) => fs.mount_point === "/") ?? snapshot.filesystems[0];
  const rateByName = new Map(derived.interfaceRates.map((iface) => [iface.name, iface]));
  lines.push(
    "", "[Host]", `Hostname: ${snapshot.host.hostname || "-"}`, `OS: ${snapshot.host.os_name || "-"}`,
    `Kernel: ${[snapshot.host.kernel_name, snapshot.host.kernel_release].filter(Boolean).join(" ") || "-"}`,
    `Arch: ${snapshot.host.architecture || "-"}`, `Primary IP: ${snapshot.host.primary_ip ?? "-"}`,
    `Device: ${snapshot.host.device_model ?? "-"}`, `Uptime: ${formatUptime(snapshot.uptime_seconds)}`,
    `Load: ${formatLoad(snapshot)}`, "", "[CPU]", `Usage: ${formatPercent(derived.cpuPercent)}`,
    `Cores: ${cpuCoreCount || "-"}`, `Frequency: ${formatCpuFrequency(snapshot.cpu_info.mhz)}`,
    `Model: ${snapshot.cpu_info.model_name || "Unknown CPU"}`, `ARM part: ${snapshot.cpu_info.raw_part ?? "-"}`,
    "", "[Memory]", `Usage: ${formatUsagePercent(snapshot.memory)}`,
    `Used/Total: ${formatBytes(snapshot.memory.used_bytes)}/${formatBytes(snapshot.memory.total_bytes)}`,
    `Frequency: ${formatMemoryFrequency(snapshot.memory_info.frequency_mhz)}`,
    `Swap: ${formatBytes(snapshot.swap.used_bytes)}/${formatBytes(snapshot.swap.total_bytes)}`,
    "", "[Process]", `Running/Total: ${snapshot.processes.running}/${snapshot.processes.total}`,
    `Threads: ${snapshot.processes.threads}`, "", "[Disk]",
    root ? `${root.mount_point}: ${root.used_percent.toFixed(0)}% used, ${formatBytes(root.available_bytes)} available` : "-"
  );
  lines.push("", "[Network]");
  const ifaces = snapshot.network.filter((iface) => iface.name !== "lo");
  if (!ifaces.length) lines.push("-");
  else for (const iface of ifaces) {
    const rate = rateByName.get(iface.name);
    lines.push(`${iface.name}: ip=${iface.ipv4_addresses.join(",") || "-"} down=${formatRate(rate?.rxRate ?? 0)} up=${formatRate(rate?.txRate ?? 0)} rx=${formatBytes(iface.rx_bytes)} tx=${formatBytes(iface.tx_bytes)} errors=${iface.rx_errors}/${iface.tx_errors}`);
  }
  return lines.join("\n");
}
