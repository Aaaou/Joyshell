import type { SftpProgress } from "../../types";

export function recoverableTransferFailureReason(transfer: SftpProgress) {
  return typeof transfer.status === "object" && "Failed" in transfer.status
    ? transfer.status.Failed.reason
    : "";
}

export function isRecoverableTransferFailure(reason: string) {
  const normalized = reason.toLowerCase();
  return reason.startsWith("应用已重启")
    || ["connection", "socket", "transport", "timed out", "timeout", "not connected", "session is not connected"]
      .some((token) => normalized.includes(token));
}

export function isScheduledTransferRetryCurrent(transfer: SftpProgress, retryCount: number) {
  if (transfer.retry_count !== retryCount || typeof transfer.status !== "object" || !("Retrying" in transfer.status)) {
    return false;
  }
  return transfer.status.Retrying.attempt === retryCount + 1
    && transfer.status.Retrying.max_attempts === 5;
}
