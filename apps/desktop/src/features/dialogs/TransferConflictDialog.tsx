import { FileWarning, X } from "lucide-react";
import type { SftpProgress } from "../../types";

export function TransferConflictDialog({
  transfer,
  submitting,
  onDecision
}: {
  transfer: SftpProgress;
  submitting: boolean;
  onDecision: (decision: "restart" | "continue" | "cancel") => void;
}) {
  const conflict = typeof transfer.status === "object" && "NeedsAttention" in transfer.status
    ? transfer.status.NeedsAttention
    : null;
  const sourceSize = transfer.source_size ?? transfer.bytes_total;
  const targetSize = conflict?.actual_size ?? transfer.target_size;
  const canContinue = sourceSize === null
    || sourceSize === undefined
    || targetSize === null
    || targetSize === undefined
    || targetSize <= sourceSize;
  return <div className="modal-backdrop" role="presentation"><section className="danger-confirm-dialog transfer-conflict-dialog" role="dialog" aria-modal="true" aria-label="传输文件发生变化">
    <header className="danger-confirm-titlebar"><div className="danger-confirm-title"><span className="text-input-icon"><FileWarning size={17} /></span><strong>传输文件发生变化</strong></div><button className="dialog-close" onClick={() => onDecision("cancel")} disabled={submitting} title="取消任务"><X size={15} /></button></header>
    <div className="danger-confirm-body">
      <p>{conflict?.reason ?? "文件状态与保存的断点不一致。"}</p>
      <dl className="host-key-details">
        <dt>本地</dt><dd>{transfer.local_path}</dd>
        <dt>远端</dt><dd>{transfer.remote_path}</dd>
        <dt>记录断点</dt><dd>{formatBytes(conflict?.expected_size)}</dd>
        <dt>实际大小</dt><dd>{formatBytes(conflict?.actual_size)}</dd>
      </dl>
      <small>{canContinue
        ? "强制继续可能产生损坏文件；不能确认文件未被替换时请选择重新开始。"
        : "现有目标文件大于源文件，不能安全继续；请选择重新开始或取消任务。"}</small>
    </div>
    <footer className={`danger-confirm-actions transfer-conflict-actions${canContinue ? "" : " transfer-conflict-actions--limited"}`}>
      <button className="secondary-button" onClick={() => onDecision("cancel")} disabled={submitting}>取消任务</button>
      {canContinue ? <button className="secondary-button" onClick={() => onDecision("continue")} disabled={submitting}>强制继续</button> : null}
      <button className="primary-confirm-button" onClick={() => onDecision("restart")} disabled={submitting}>{submitting ? "处理中..." : "覆盖并重新开始"}</button>
    </footer>
  </section></div>;
}

function formatBytes(value?: number | null) {
  if (value === null || value === undefined) return "未知";
  if (value < 1024) return `${value} B`;
  if (value < 1024 ** 2) return `${(value / 1024).toFixed(1)} KB`;
  if (value < 1024 ** 3) return `${(value / 1024 ** 2).toFixed(1)} MB`;
  return `${(value / 1024 ** 3).toFixed(2)} GB`;
}
