import { useEffect, useState } from "react";
import type { SessionInfo, SftpProgress } from "../../types";

export type TransferStats = {
  startedAt: number;
  lastAt: number;
  lastBytes: number;
  rateBytesPerSecond: number;
  etaSeconds: number | null;
};

export function TransferMetric({
  tone,
  label,
  value,
  span
}: {
  tone: "success" | "danger" | "warning";
  label: string;
  value: string;
  span?: boolean;
}) {
  return (
    <span className={`transfer-metric ${tone} ${span ? "span" : ""}`}>
      <span className="transfer-metric-label">{label}</span>
      <RollingText value={value} />
    </span>
  );
}

export function RollingText({ value }: { value: string }) {
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
        const charWidthClass = rollingCharWidthClass(char, previousChar);
        if (frame.sequence === 0 || char === previousChar) {
          return <span className={`rolling-char stable ${charWidthClass}`} key={`${index}-${char}`}>{content}</span>;
        }
        return (
          <span className={`rolling-char ${frame.direction} ${charWidthClass}`} key={`${frame.sequence}-${index}-${char}`}>
            <span className="rolling-char-old">{previousContent}</span>
            <span className="rolling-char-new">{content}</span>
          </span>
        );
      })}
    </span>
  );
}

function rollingCharWidthClass(current: string, previous: string) {
  const char = current.trim() ? current : previous;
  if (!char.trim()) {
    return "space";
  }
  if (/[^\x00-\x7F]/.test(char)) {
    return "wide";
  }
  if (/[MW@%]/.test(char)) {
    return "wide-latin";
  }
  if (/[A-Z]/.test(char)) {
    return "latin";
  }
  if (/[./:]/.test(char)) {
    return "punct";
  }
  return "";
}

function compareRollingValue(next: string, previous: string) {
  const nextNumber = Number.parseFloat(next.replace(/[^\d.]/g, ""));
  const previousNumber = Number.parseFloat(previous.replace(/[^\d.]/g, ""));
  if (Number.isFinite(nextNumber) && Number.isFinite(previousNumber)) {
    return nextNumber - previousNumber;
  }
  return next.localeCompare(previous);
}

export function buildTransferTelemetry(
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

export function formatUptime(seconds: number) {
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

export function formatRate(bytesPerSecond: number) {
  if (bytesPerSecond <= 0) {
    return "0 B/s";
  }
  return `${formatBytes(bytesPerSecond)}/s`;
}

export function formatLatency(ms: number | null, status: string) {
  if (status === "断开") {
    return "--";
  }
  if (ms === null) {
    return status;
  }
  if (ms >= 1000) {
    return `${(ms / 1000).toFixed(2)}s`;
  }
  return `${Math.max(1, Math.round(ms))}ms`;
}

export function latencyTone(ms: number | null, status: string): "success" | "warning" | "danger" | undefined {
  if (ms === null) {
    return status === "timeout" ? "danger" : undefined;
  }
  if (ms < 100) {
    return "success";
  }
  if (ms < 500) {
    return "warning";
  }
  return "danger";
}

export function formatTransferDuration(seconds: number) {
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

export function formatBytes(bytes: number) {
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

export function formatDateTime(value?: string | null) {
  if (!value) {
    return "--";
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "--";
  }
  return date.toLocaleString();
}

export function formatTransferStatus(transfer: SftpProgress) {
  if (typeof transfer.status === "string") {
    return transfer.status;
  }
  if ("Retrying" in transfer.status) {
    const { attempt, max_attempts, reason } = transfer.status.Retrying;
    return `Retrying ${attempt}/${max_attempts}: ${reason}`;
  }
  return `Failed: ${transfer.status.Failed.reason}`;
}

export function isConnectedState(state: SessionInfo["state"]) {
  return state === "Connected";
}

export function getDisconnectedReason(state: SessionInfo["state"]) {
  if (typeof state === "object" && "Failed" in state) {
    return state.Failed.reason || "SSH session closed.";
  }
  return "SSH session closed.";
}

export function createTransferProgress({
  id = crypto.randomUUID(),
  direction,
  sessionId,
  profileId,
  localPath,
  remotePath,
  bytesTotal = null,
  status
}: {
  id?: string;
  direction: SftpProgress["direction"];
  sessionId: string;
  profileId?: string | null;
  localPath: string;
  remotePath: string;
  bytesTotal?: number | null;
  status: SftpProgress["status"];
}): SftpProgress {
  return {
    id,
    session_id: sessionId,
    profile_id: profileId ?? null,
    direction,
    local_path: localPath,
    remote_path: remotePath,
    bytes_done: 0,
    bytes_total: bytesTotal,
    status
  };
}

export function isTransferActive(status: SftpProgress["status"]) {
  return status === "Running" || status === "Queued" || (typeof status !== "string" && "Retrying" in status);
}
