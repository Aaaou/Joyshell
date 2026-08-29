import { useCallback, useEffect, useMemo, useState } from "react";
import type { SftpProgress } from "../../types";
import { deleteTransfer, listTransfers, saveTransfer } from "../../platform/runtime-client";
import { isTransferActive, type TransferStats } from "./transfer-model";

export function useTransferRuntime() {
  const [transfers, setTransfers] = useState<SftpProgress[]>([]);
  const [transferStats, setTransferStats] = useState<Record<string, TransferStats>>({});
  const [cancellingTransfers, setCancellingTransfers] = useState<Record<string, boolean>>({});

  useEffect(() => {
    let active = true;
    void listTransfers().then((items) => {
      if (active && items.length > 0) {
        const restored = items.slice(0, 20).map((item) => isTransferActive(item.status)
          ? { ...item, status: { Failed: { reason: "应用已重启，重新连接服务器后可继续传输" } } } satisfies SftpProgress
          : item);
        setTransfers(restored);
        restored.forEach((item) => { void saveTransfer(item).catch(() => undefined); });
      }
    }).catch(() => undefined);
    return () => { active = false; };
  }, []);

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
    setTransfers((current) => {
      const existing = current.find((item) => item.id === progress.id || item.id === replaceId);
      const merged = {
        ...progress,
        profile_id: progress.profile_id ?? existing?.profile_id ?? null
      };
      void saveTransfer(merged).catch(() => undefined);
      return [
        merged,
        ...current.filter((item) => item.id !== progress.id && item.id !== replaceId)
      ].slice(0, 20);
    });
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
      const failed = { ...existing, status: { Failed: { reason } } } satisfies SftpProgress;
      void saveTransfer(failed).catch(() => undefined);
      return [
        failed,
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

  const removeTransfer = useCallback((transferId: string) => {
    setTransfers((current) => current.filter((item) => item.id !== transferId));
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
    void deleteTransfer(transferId).catch(() => undefined);
  }, []);

  const hasActiveTransfer = useMemo(
    () => transfers.some((transfer) => isTransferActive(transfer.status)),
    [transfers]
  );

  return {
    state: { transfers, transferStats, cancellingTransfers, hasActiveTransfer },
    actions: { markTransferFailed, removeTransfer, setCancellingTransfers, upsertTransfer }
  };
}
