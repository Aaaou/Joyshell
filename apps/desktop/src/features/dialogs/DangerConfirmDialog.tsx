import { Trash2, TriangleAlert, X } from "lucide-react";

export type DangerConfirmDialogProps = {
  title: string;
  message: string;
  onCancel: () => void;
  onConfirm: () => void;
};

export function DangerConfirmDialog({ title, message, onCancel, onConfirm }: DangerConfirmDialogProps) {
  return (
    <div className="modal-backdrop danger-confirm-backdrop" role="presentation" onMouseDown={onCancel}>
      <section
        className="danger-confirm-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="danger-confirm-titlebar">
          <div className="danger-confirm-title">
            <span className="danger-confirm-icon"><TriangleAlert size={17} /></span>
            <strong>{title}</strong>
          </div>
          <button className="dialog-close" onClick={onCancel} title="取消"><X size={15} /></button>
        </header>
        <div className="danger-confirm-body">
          <p>{message}</p>
          <small>此操作可能影响已保存的连接信息或远程文件。</small>
        </div>
        <footer className="danger-confirm-actions">
          <button className="secondary-button" onClick={onCancel}>取消</button>
          <button className="danger-confirm-button" onClick={onConfirm}><Trash2 size={14} /> 删除</button>
        </footer>
      </section>
    </div>
  );
}
