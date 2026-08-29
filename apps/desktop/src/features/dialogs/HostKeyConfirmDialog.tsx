import { ShieldAlert, X } from "lucide-react";

export function HostKeyConfirmDialog({ title, message, onCancel, onConfirm }: { title: string; message: string; onCancel: () => void; onConfirm: () => void }) {
  return <div className="modal-backdrop" role="presentation"><section className="danger-confirm-dialog" role="dialog" aria-modal="true" aria-label={title}>
    <header className="danger-confirm-titlebar"><div className="danger-confirm-title"><span className="text-input-icon"><ShieldAlert size={17} /></span><strong>{title}</strong></div><button className="dialog-close" onClick={onCancel} title="拒绝"><X size={15} /></button></header>
    <div className="danger-confirm-body"><p style={{ whiteSpace: "pre-line" }}>{message}</p><small>仅在确认主机指纹可信时继续。</small></div>
    <footer className="danger-confirm-actions"><button className="secondary-button" onClick={onCancel}>拒绝连接</button><button className="primary-confirm-button" onClick={onConfirm}>信任并继续</button></footer>
  </section></div>;
}
