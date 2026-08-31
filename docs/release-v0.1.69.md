# Joyshell v0.1.69

## Windows 企业网络访问能力

本版本为 Windows x64 Pre-release，提供通用 SSH 企业网络访问能力：

- 单级 ProxyJump，跳板与目标分别进行认证和主机密钥校验。
- Local `-L`、Remote `-R` 和 SOCKS5 `-D` TCP 转发。
- 转发规则幂等启动、停止、删除和会话断开清理。
- 回环监听默认安全策略，非回环监听需要显式风险确认。
- 端口冲突、目标不可达、服务器拒绝和跳板链错误提供可读错误。
- 既有主机信任、SSH Agent、自动重连和 SFTP 传输能力保持兼容。

## 验证重点

1. 为跳板和目标各建立 Profile，目标选择单级跳板后连接，确认两台主机分别弹出信任提示。
2. 在已连接 Session 创建 Local、Remote、SOCKS 规则，验证 TCP 访问、端口显示和停止后端口释放。
3. 断开网络后观察有限重连；主动停止的规则不应自动恢复。
4. 退出应用后确认本地监听端口不再占用。

## 发布验收状态

2026-08-31 已在 Windows x64 客户端和 Ubuntu 24.04 目标服务器之间完成候选包实测：

| 能力 | 结果 | 实测链路 |
| --- | --- | --- |
| Local `-L` | 通过 | Windows `127.0.0.1:28080` 访问服务器测试服务 |
| Remote `-R` | 通过 | 服务器 `127.0.0.1:28081` 访问 Windows `127.0.0.1:18081` |
| SOCKS5 `-D` | 通过 | Windows 经 `127.0.0.1:1080` 访问服务器 `127.0.0.1:18080` |
| 单条规则停止 | 通过 | 停止 SOCKS 后 `127.0.0.1:1080` 监听释放，代理请求失败 |
| 单条规则继续 | 通过 | 继续 SOCKS 后监听恢复，代理请求重新成功 |
| 规则隔离 | 通过 | SOCKS 停止期间 Local 和 Remote 规则未受影响 |
| 规则持久化 | 通过 | SQLite 保存规则，应用重启后失效运行状态归一为已停止 |

候选安装包：

- `Joyshell_0.1.69_x64-setup.exe`
  - SHA-256: `9DE3C1301AE1976F5A1A14349F2966A8080F1D5EAFF875A47CA6F601FF5E5F46`
- `Joyshell_0.1.69_x64_en-US.msi`
  - SHA-256: `5727A8B8518E9E7D941FF4ED428DCE3B6AA5C6AACAD4D9D39021C1FECC0FACD6`

发布前自动检查已通过：Rust workspace 测试 33 项、前端测试 16 项、TypeScript 类型检查、Rust 格式检查、Clippy 和生产构建。Rust 构建仍会输出未使用函数、既有 Clippy 提示及静态 OpenSSL PDB 缺失警告，不影响测试、打包或运行。

当前 EXE 和 MSI 的 Windows 产品版本均为 `0.1.69`，但尚未进行 Authenticode 数字签名。开源 Pre-release 允许分发未签名包，Windows 可能显示未知发布者或 SmartScreen 提示；用户可使用上述 SHA-256 与本 Release 校验下载内容。后续若签名，必须重新记录签名后文件的 SHA-256。

`0.1.69` 是启用独立构建序号前的最后一个版本。从 `0.1.70` 开始，所有可分发构建遵循 [版本与构建编号规则](versioning-and-builds.md)。

## 已知限制

- ProxyJump 当前桌面入口要求跳板和目标使用密码认证；私钥/Agent 路径保留在核心层，后续 UI 收口。
- SOCKS5 仅支持 TCP CONNECT，不支持 UDP Associate。
- 不包含多级跳板、端口转发以外的 P1 终端增强功能。
- macOS/Linux 不在本版本实机承诺范围内。
