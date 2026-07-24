import { Save, Server, ShieldCheck, X } from "lucide-react";
import { useState } from "react";
import { desktopClient } from "../../platform/desktop-client";
import type { SessionFolder, SessionProfile } from "../../types";

export function SshSettingsDialog({
  profile,
  folders,
  onClose,
  onSave
}: {
  profile: SessionProfile;
  folders: SessionFolder[];
  onClose: () => void;
  onSave: (profile: SessionProfile, password?: string) => void;
}) {
  const [draft, setDraft] = useState(profile);
  const [authMethod, setAuthMethod] = useState("password");
  const [password, setPassword] = useState("");
  const [tagsText, setTagsText] = useState(profile.tags.join(", "));
  const [error, setError] = useState<string | null>(null);

  const update = (key: keyof SessionProfile, value: string | number | boolean | null) => {
    setDraft((current) => ({ ...current, [key]: value }));
  };

  return (
    <div className="modal-backdrop" role="presentation">
      <section className="ssh-dialog" role="dialog" aria-modal="true" aria-label="SSH 连接设置">
        <header className="dialog-titlebar">
          <div>
            <Server size={16} />
            <strong>SSH 连接设置</strong>
          </div>
          <button className="dialog-close" onClick={onClose} title="关闭">
            <X size={16} />
          </button>
        </header>
        <div className="dialog-body">
          <aside className="settings-tree">
            <div className="settings-root">SSH连接</div>
            <button className="settings-node active">常规</button>
            <button className="settings-node">代理服务器</button>
            <button className="settings-node">隧道</button>
          </aside>
          <main className="settings-form">
            <fieldset>
              <legend>常规</legend>
              <label>
                <span>名称:</span>
                <input value={draft.name} onChange={(event) => update("name", event.target.value)} autoFocus />
              </label>
              <label>
                <span>主机:</span>
                <input value={draft.host} onChange={(event) => update("host", event.target.value)} />
              </label>
              <label>
                <span>端口:</span>
                <input
                  type="number"
                  min={1}
                  max={65535}
                  value={draft.port}
                  onChange={(event) => update("port", Number(event.target.value))}
                />
              </label>
              <label>
                <span>文件夹:</span>
                <input
                  list="session-folder-options"
                  value={draft.group ?? ""}
                  onChange={(event) => update("group", event.target.value)}
                  placeholder="未分组"
                />
                <datalist id="session-folder-options">
                  {folders.map((folder) => (
                    <option key={folder.id} value={folder.name} />
                  ))}
                </datalist>
              </label>
              <label className="wide">
                <span>备注:</span>
                <textarea
                  value={tagsText}
                  onChange={(event) => setTagsText(event.target.value)}
                  placeholder="可填写标签或备注，后续会进入会话管理搜索"
                />
              </label>
            </fieldset>

            <fieldset>
              <legend>认证</legend>
              <label>
                <span>方法:</span>
                <select value={authMethod} onChange={(event) => setAuthMethod(event.target.value)}>
                  <option value="password">密码</option>
                  <option value="privateKey">私钥</option>
                  <option value="agent">Agent</option>
                </select>
              </label>
              <label>
                <span>用户名:</span>
                <input value={draft.username} onChange={(event) => update("username", event.target.value)} />
              </label>
              <label>
                <span>密码:</span>
                <input
                  type="password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  placeholder="留空则继续使用已保存的加密密码"
                  disabled={authMethod !== "password"}
                />
              </label>
              <label className="wide">
                <span>私钥:</span>
                <div className="file-input-row">
                  <input placeholder="私钥认证接口已预留，尚未启用" disabled={authMethod !== "privateKey"} />
                  <button disabled={authMethod !== "privateKey"}>浏览...</button>
                </div>
              </label>
            </fieldset>

            <fieldset>
              <legend>高级</legend>
              <label className="check-row">
                <input
                  type="checkbox"
                  checked={Boolean(draft.use_terminal_latency_probe)}
                  onChange={(event) => update("use_terminal_latency_probe", event.target.checked)}
                />
                <span>使用终端交互平均时延</span>
              </label>
              <label className="check-row">
                <input type="checkbox" disabled />
                <span>跳板机 / 代理链预留</span>
              </label>
              <label className="check-row">
                <input type="checkbox" defaultChecked />
                <span>连接后打开交互式 Shell</span>
              </label>
            </fieldset>
          </main>
        </div>
        <footer className="dialog-actions">
          {error ? <span className="dialog-error">{error}</span> : null}
          <button onClick={onClose}>取消</button>
          <button
            className="save-button"
            onClick={() => {
              if (!draft.name.trim() || !draft.host.trim() || !draft.username.trim()) {
                setError("请填写名称、主机和用户名");
                return;
              }
              if (draft.port < 1 || draft.port > 65535) {
                setError("端口必须在 1 到 65535 之间");
                return;
              }
              if (authMethod !== "password") {
                setError("初版后端当前只接入密码认证，请先选择密码方式");
                return;
              }
              onSave({
                ...draft,
                name: draft.name.trim(),
                host: draft.host.trim(),
                latency_probe_host: null,
                latency_probe_port: null,
                use_terminal_latency_probe: Boolean(draft.use_terminal_latency_probe),
                username: draft.username.trim(),
                group: draft.group?.trim() || null,
                tags: tagsText
                  .split(",")
                  .map((tag) => tag.trim())
                  .filter(Boolean)
              }, password);
            }}
          >
            <Save size={15} /> 确定
          </button>
        </footer>
      </section>
    </div>
  );
}
