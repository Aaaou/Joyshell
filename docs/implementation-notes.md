# Joyshell Implementation Notes

更新时间：2026-07-27，桌面版本 `0.1.52`。

## 当前实现

- Tauri 2 + React/Vite/TypeScript 桌面应用。
- xterm.js 终端和 Rust `ssh2-rs/libssh2` 真实 SSH 密码认证。
- Tauri command + `session:event` 事件流，终端 tail 轮询作为 MVP 兜底。
- SFTP 浏览、上传、下载、取消、重试和偏移续传。
- 独立 side SSH session 执行 SFTP 与系统监控，避免阻塞交互终端。
- SQLite/WAL 保存服务器、文件夹、命令片段和布局设置。
- AES-256-GCM 加密保存密码。
- Agent 大/小助手定义、工具注册、权限判定、记忆和 Provider 配置抽象。
- 首页轮播、会话拖放、应用内菜单/弹窗、全页设置、图片裁剪和统一桌面渐变。
- Profile、Shell 标签和 SSH Runtime 使用独立 ID，同一服务器可并行打开多个 Shell。

## 当前边界

- 真实 SSH 仅完成密码认证；私钥和 SSH Agent 数据结构存在，但连接命令会明确返回未实现。
- known_hosts 严格校验、跳板机、端口转发、本地 PTY 尚未完成。
- Agent 运行时还没有实际调用 OpenAI/Anthropic/Ollama，也没有完整 Agentic Loop UI。
- MCP 仅预留工具与权限入口。
- Windows 安装包已经验证；macOS/Linux 是目标平台，但尚未完成同等实机打包测试。
- 当前传输队列存在于进程内，应用重启后不会恢复任务。

## 前端结构

`9945ac0` 和 `912dd16` 完成第一轮领域与 CSS 拆分。`0.1.43` 工作区继续提取布局、窗口、事件、终端和传输 runtime。

入口 `apps/desktop/src/app/JoyshellApp.tsx` 仍负责跨模块编排，但业务 UI 和纯模型已分别位于 `features`、`platform`、`shell` 和 `styles`。

详见：

- `doc/components/frontend-decoupling.md`
- `doc/development-history.md`

## 验证基线

```powershell
pnpm test
pnpm build
cargo test --workspace
pnpm --filter @joyshell/desktop tauri build
```

`0.1.52` 验证结果：前端测试 `5/5`、Rust 单元测试 `8/8`、前端生产构建通过，同一 Profile 双独立 SSH Session 实机探针通过；Windows NSIS/MSI 打包通过。

## 下一阶段优先级

1. 增加终端缓存、传输统计、拖放定位和渐变坐标特征测试。
2. 完成私钥认证、known_hosts 与主机密钥变更提示。
3. 建立每 Profile 持久 SFTP worker 和并发限制。
4. 实现自动重连以及传输 reconnect-and-resume。
5. 接入首个模型 Provider，再开放受权限控制的命令执行。
