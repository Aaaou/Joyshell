import { FolderPlus, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";

export type TextInputDialogProps = {
  title: string;
  message?: string;
  label: string;
  initialValue: string;
  placeholder?: string;
  confirmLabel?: string;
  onCancel: () => void;
  onConfirm: (value: string) => void;
};

export function TextInputDialog({
  title,
  message,
  label,
  initialValue,
  placeholder,
  confirmLabel = "确定",
  onCancel,
  onConfirm
}: TextInputDialogProps) {
  const [value, setValue] = useState(initialValue);
  const inputRef = useRef<HTMLInputElement | null>(null);
  const cleanValue = value.trim();

  useEffect(() => {
    window.setTimeout(() => {
      inputRef.current?.focus();
      inputRef.current?.select();
    }, 0);
  }, []);

  return (
    <div className="modal-backdrop text-input-backdrop" role="presentation" onMouseDown={onCancel}>
      <form
        className="text-input-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onSubmit={(event) => {
          event.preventDefault();
          if (cleanValue) {
            onConfirm(cleanValue);
          }
        }}
        onMouseDown={(event) => event.stopPropagation()}
      >
        <header className="danger-confirm-titlebar">
          <div className="danger-confirm-title">
            <span className="text-input-icon"><FolderPlus size={17} /></span>
            <strong>{title}</strong>
          </div>
          <button className="dialog-close" type="button" onClick={onCancel} title="取消"><X size={15} /></button>
        </header>
        <div className="text-input-body">
          {message ? <p>{message}</p> : null}
          <label>
            <span>{label}</span>
            <input
              ref={inputRef}
              value={value}
              placeholder={placeholder}
              onChange={(event) => setValue(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  onCancel();
                }
              }}
            />
          </label>
        </div>
        <footer className="danger-confirm-actions text-input-actions">
          <button className="secondary-button" type="button" onClick={onCancel}>取消</button>
          <button className="primary-confirm-button" type="submit" disabled={!cleanValue}>{confirmLabel}</button>
        </footer>
      </form>
    </div>
  );
}
