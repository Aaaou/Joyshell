import { Edit3, Play, Trash2 } from "lucide-react";
import type { CommandSnippet, SessionInfo } from "../../types";

export function CommandLibraryPanel({
  snippets,
  connectedSessions,
  sendMode,
  selectedTargets,
  titleDraft,
  commandDraft,
  editingId,
  onSend,
  onEdit,
  onDelete,
  onSelectTarget,
  onTitleChange,
  onCommandChange,
  onCancelEdit
}: {
  snippets: CommandSnippet[];
  connectedSessions: SessionInfo[];
  sendMode: "current" | "all" | "selected";
  selectedTargets: Record<string, boolean>;
  titleDraft: string;
  commandDraft: string;
  editingId: string | null;
  onSend: (command: string) => void;
  onEdit: (snippet: CommandSnippet) => void;
  onDelete: (snippet: CommandSnippet) => void;
  onSelectTarget: (sessionId: string, selected: boolean) => void;
  onTitleChange: (value: string) => void;
  onCommandChange: (value: string) => void;
  onCancelEdit: () => void;
}) {
  return (
    <div className="command-library">
      <div className="command-editor">
        <input
          value={titleDraft}
          onChange={(event) => onTitleChange(event.target.value)}
          placeholder="命令名称，例如 查看磁盘"
        />
        <textarea
          value={commandDraft}
          onChange={(event) => onCommandChange(event.target.value)}
          placeholder="命令内容，例如 df -h"
        />
        {editingId ? (
          <button className="mini-button" onClick={onCancelEdit}>取消编辑</button>
        ) : null}
      </div>

      <div className="command-targets">
        <strong>发送目标</strong>
        {sendMode === "selected" ? (
          connectedSessions.length ? connectedSessions.map((session) => (
            <label key={session.id}>
              <input
                type="checkbox"
                checked={Boolean(selectedTargets[session.id])}
                onChange={(event) => onSelectTarget(session.id, event.target.checked)}
              />
              <span>{session.profile_name}</span>
              <small>{session.username}@{session.host}</small>
            </label>
          )) : <span className="muted">暂无已连接设备。</span>
        ) : (
          <span className="muted">
            {sendMode === "current" ? "发送到当前活动会话。" : `发送到全部 ${connectedSessions.length} 台已连接设备。`}
          </span>
        )}
      </div>

      <div className="command-list">
        {snippets.length ? snippets.map((snippet) => (
          <div className="command-row" key={snippet.id}>
            <div>
              <strong>{snippet.title}</strong>
              <code>{snippet.command}</code>
            </div>
            <div className="command-row-actions">
              <button onClick={() => onSend(snippet.command)} title="发送命令">
                <Play size={13} />
              </button>
              <button onClick={() => onEdit(snippet)} title="编辑命令">
                <Edit3 size={13} />
              </button>
              <button onClick={() => onDelete(snippet)} title="删除命令">
                <Trash2 size={13} />
              </button>
            </div>
          </div>
        )) : (
          <div className="table-empty">暂无常用命令。填写上方内容后点击保存命令。</div>
        )}
      </div>
    </div>
  );
}

