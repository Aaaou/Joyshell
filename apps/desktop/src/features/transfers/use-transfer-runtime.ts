import { useCallback, useMemo, useState } from "react";
import type { SftpProgress } from "../../types";
import { isTransferActive, type TransferStats } from "./transfer-model";

export function useTransferRuntime() {
  const [transfers, setTransfers] = useState<SftpProgress[]>([]);
  const [transferStats, setTransferStats] = useState<Record<string, TransferStats>>({});
  const [cancellingTransfers, setCancellingTransfers] = useState<Record<string, boolean>>({});

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
