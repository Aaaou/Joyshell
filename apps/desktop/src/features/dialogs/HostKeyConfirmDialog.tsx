import { ShieldAlert, X } from "lucide-react";
import type { HostKeyPrompt } from "../../types";

export function HostKeyConfirmDialog({
  prompt,
  submitting,
  onCancel,
  onConfirm
}: {
  prompt: HostKeyPrompt;
  submitting: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const changed = prompt.reason === "changed";
  const title = changed ? "确认更新主机密钥" : "信任新主机";
  return <div className="modal-backdrop" role="presentation"><section className="danger-confirm-dialog" role="dialog" aria-modal="true" aria-label={title}>
    <header className="danger-confirm-titlebar"><div className="danger-confirm-title"><span className="text-input-icon"><ShieldAlert size={17} /></span><strong>{title}</strong></div><button className="dialog-close" onClick={onCancel} disabled={submitting} title="拒绝"><X size={15} /></button></header>
    <div className="danger-confirm-body">
      <p>{changed ? "主机密钥发生变化，连接已阻断。" : "首次连接，尚未信任此主机。"}</p>
      <dl className="host-key-details">
        <dt>主机</dt><dd>{prompt.host}:{prompt.port}</dd>
        <dt>算法</dt><dd>{prompt.key_type}</dd>
        {changed ? <><dt>旧指纹</dt><dd>{prompt.previous_fingerprint ?? "不可用"}</dd></> : null}
        <dt>{changed ? "新指纹" : "指纹"}</dt><dd>{prompt.fingerprint}</dd>
      </dl>
      <small>仅在确认主机指纹可信时继续。</small>
    </div>
    <footer className="danger-confirm-actions"><button className="secondary-button" onClick={onCancel} disabled={submitting}>拒绝连接</button><button className="primary-confirm-button" onClick={onConfirm} disabled={submitting}>{submitting ? "处理中..." : changed ? "更新信任并继续" : "信任并继续"}</button></footer>
  </section></div>;
}
