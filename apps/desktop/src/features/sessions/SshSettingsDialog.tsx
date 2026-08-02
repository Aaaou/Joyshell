import { Save, Server, ShieldCheck, X } from "lucide-react";
import { useState } from "react";
import { desktopClient } from "../../platform/desktop-client";
import type { ProfileSecrets } from "../../platform/runtime-client";
import type { SessionFolder, SessionProfile } from "../../types";

type SshAuthMethod = "password" | "privateKey" | "agent";

export function SshSettingsDialog({
  profile,
  folders,
  onClose,
  onSave
}: {
  profile: SessionProfile;
  folders: SessionFolder[];
  onClose: () => void;
  onSave: (profile: SessionProfile, secrets?: ProfileSecrets) => void;
}) {
  const savedPrivateKey =
    typeof profile.auth_method === "object" && "PrivateKey" in profile.auth_method
      ? profile.auth_method.PrivateKey
      : null;
  const initialAuthMethod: SshAuthMethod =
    profile.auth_method === "Agent"
      ? "agent"
      : savedPrivateKey
        ? "privateKey"
        : "password";
  const [draft, setDraft] = useState(profile);
  const [authMethod, setAuthMethod] = useState<SshAuthMethod>(initialAuthMethod);
  const [password, setPassword] = useState("");
  const [privateKeyPath, setPrivateKeyPath] = useState(savedPrivateKey?.key_ref ?? "");
  const [privateKeyPassphrase, setPrivateKeyPassphrase] = useState("");
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
                <select
                  value={authMethod}
                  onChange={(event) => setAuthMethod(event.target.value as SshAuthMethod)}
                >
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
                  <input
                    value={privateKeyPath}
                    onChange={(event) => setPrivateKeyPath(event.target.value)}
                    placeholder="选择或输入本机私钥文件路径"
                    disabled={authMethod !== "privateKey"}
                  />
                  <button
                    type="button"
                    disabled={authMethod !== "privateKey"}
                    onClick={() => {
                      void desktopClient.selectPrivateKeyFile()
                        .then((path) => {
                          if (path) {
                            setPrivateKeyPath(path);
                            setError(null);
                          }
                        })
                        .catch((selectError) => {
                          setError(selectError instanceof Error ? selectError.message : String(selectError));
                        });
                    }}
                  >
                    浏览...
                  </button>
                </div>
              </label>
              <label>
                <span>密钥口令:</span>
                <input
                  type="password"
                  value={privateKeyPassphrase}
                  onChange={(event) => setPrivateKeyPassphrase(event.target.value)}
                  placeholder="未加密私钥可留空"
                  disabled={authMethod !== "privateKey"}
                />
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
              if (authMethod === "agent") {
                setError("SSH Agent 认证尚未接入");
                return;
              }
              const cleanPrivateKeyPath = privateKeyPath.trim();
              if (authMethod === "privateKey" && !cleanPrivateKeyPath) {
                setError("请选择私钥文件");
                return;
              }
              const existingPassphraseRef =
                savedPrivateKey?.key_ref === cleanPrivateKeyPath
                  ? savedPrivateKey.passphrase_ref
                  : null;
              const passphraseRef = privateKeyPassphrase
                ? existingPassphraseRef ?? `secret://${draft.id}/private-key-passphrase`
                : existingPassphraseRef ?? null;
              const auth_method: SessionProfile["auth_method"] = authMethod === "privateKey"
                ? {
                    PrivateKey: {
                      key_ref: cleanPrivateKeyPath,
                      passphrase_ref: passphraseRef
                    }
                  }
                : {
                    Password: {
                      secret_ref: `secret://${draft.id}/password`
                    }
                  };
              onSave({
                ...draft,
                name: draft.name.trim(),
                host: draft.host.trim(),
                latency_probe_host: null,
                latency_probe_port: null,
                use_terminal_latency_probe: Boolean(draft.use_terminal_latency_probe),
                username: draft.username.trim(),
                group: draft.group?.trim() || null,
                auth_method,
                host_key_policy: draft.host_key_policy ?? "AcceptNew",
                jump_host_id: draft.jump_host_id ?? null,
                tags: tagsText
                  .split(",")
                  .map((tag) => tag.trim())
                  .filter(Boolean)
              }, {
                password: authMethod === "password" ? password : undefined,
                privateKeyPassphrase: authMethod === "privateKey" ? privateKeyPassphrase : undefined
              });
            }}
          >
            <Save size={15} /> 确定
          </button>
        </footer>
      </section>
    </div>
  );
}
