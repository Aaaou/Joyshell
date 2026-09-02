# Joyshell Implementation Notes

更新时间：2026-09-02，桌面正式版本 `0.1.69_build_4`。

## 当前实现

- Tauri 2 + React/Vite/TypeScript 桌面应用。
- xterm.js 终端和 Rust `ssh2-rs/libssh2` 真实 SSH 密码、本机私钥文件和 SSH Agent 认证。
- Tauri command + `session:event` 事件流，终端 tail 轮询作为 MVP 兜底。
- 密码和私钥会话均支持 SFTP 浏览、上传、下载、取消、重试和偏移续传；初始路径解析为当前远端用户的主目录。
- 独立 side SSH session 执行 SFTP 与系统监控，避免阻塞交互终端。
- SQLite/WAL 保存服务器、文件夹、命令片段和布局设置。
- AES-256-GCM 加密保存密码和私钥口令；Profile 只保存私钥路径，不保存私钥正文。
- Agent 大/小助手定义、工具注册、权限判定、记忆和 Provider 配置抽象。
- 首页轮播、会话拖放、应用内菜单/弹窗、全页设置、图片裁剪和统一桌面渐变。
- Profile、Shell 标签和 SSH Runtime 使用独立 ID，同一服务器可并行打开多个 Shell。
- 网络工具支持按需内网设备扫描、MAC 厂商线索识别、在线/离线历史和设备详情查看。
- 单级 ProxyJump、Local/Remote/SOCKS5 转发、主机密钥校验和断线重连。
- 转发规则按 Profile 持久归属，运行中的规则支持安全重连后的自动恢复，状态通过事件同步到界面。

## 当前边界

- Windows x64 是当前唯一完成正式打包验证的平台；macOS/Linux 尚未完成同等实机回归。
- ProxyJump 当前只支持单级跳板；断网恢复和五种混合认证组合仍需按发布验收矩阵持续实机验证。
- Local/SOCKS 监听仅允许 `127.0.0.1`/`::1`，当前不支持局域网或公网暴露。
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

`v0.1.69_build_4` 自动验证基线：Rust workspace 测试、前端测试 `16/16`、TypeScript 类型检查、格式检查、Clippy、生产前端构建和 Windows NSIS/MSI 打包通过。真实 ProxyJump 断网恢复、混合认证及端口冲突恢复属于持续实机验收项目，详见 [v0.1.69 发布说明](release-v0.1.69.md)。

## 下一阶段优先级

1. 完成 ProxyJump 断网恢复和混合认证的真实集成验收。
2. 开发 v0.1.70 终端体验：PTY resize、搜索、复制粘贴、快捷键和高输出响应。
3. 完善转发 generation 隔离、端口冲突恢复和失败状态展示。
4. 建立持久化 SFTP worker、传输队列重启恢复和并发限制。
5. 在 SSH 基础体验稳定后接入模型 Provider 和受权限控制的命令执行。
