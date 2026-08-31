# Joyshell 0.1.69_build_3

## Windows 企业网络访问能力

本版本为 Windows x64 Pre-release，是 `v0.1.69` 的企业网络稳定性修复构建：

- 单级 ProxyJump，跳板与目标分别进行认证和主机密钥校验。
- ProxyJump 意外断线后沿原跳板链路重新校验、认证和连接，不降级为目标直连。
- Local `-L`、Remote `-R` 和 SOCKS5 `-D` TCP 转发。
- 意外断线前正在运行且 `auto_resume=true` 的规则进入“重连中”，SSH 恢复后逐条恢复；用户主动停止的规则不恢复。
- 转发规则永久归属服务器 Profile，运行时 Session 仅作为可空的当前连接绑定。
- 转发状态、活动连接数和失败原因通过事件实时更新；单条规则恢复失败不影响终端和其他规则。
- Local/SOCKS 只允许 `127.0.0.1` 或 `::1` 回环监听，本版本不支持向局域网或公网暴露监听器。

## 验证重点

1. 为跳板和目标各建立 Profile，目标选择单级跳板后连接，确认两台主机分别进行主机密钥校验。
2. 在已连接 Session 创建 Local、Remote、SOCKS 规则，验证 TCP 访问、端口显示、活动连接数和停止后端口释放。
3. 断开跳板网络后观察有限重连，确认目标连接仍经原跳板建立。
4. 确认断线前运行的规则进入“重连中”，SSH 恢复后逐条恢复；主动停止的规则不恢复。
5. 故意制造一条恢复失败规则，确认 `last_error` 可见，其他规则和终端不受影响。
6. 重启应用并重新连接同一 Profile，确认原规则仍归属于该服务器。

## 发布验收状态

2026-08-31 已在 Windows x64 客户端和 Ubuntu 24.04 目标服务器之间完成旧 `v0.1.69` 候选包实测：

| 能力 | 结果 | 实测链路 |
| --- | --- | --- |
| Local `-L` | 通过 | Windows `127.0.0.1:28080` 访问服务器测试服务 |
| Remote `-R` | 通过 | 服务器 `127.0.0.1:28081` 访问 Windows `127.0.0.1:18081` |
| SOCKS5 `-D` | 通过 | Windows 经 `127.0.0.1:1080` 访问服务器 `127.0.0.1:18080` |
| 单条规则停止/继续 | 通过 | SOCKS 监听释放并恢复，其他规则未受影响 |
| 规则持久化 | 通过 | SQLite 保存、读取、更新和删除规则 |

历史 `v0.1.69` 安装包已被本修复构建替代，但保留用于追溯：

- `Joyshell_0.1.69_x64-setup.exe`: SHA-256 `9DE3C1301AE1976F5A1A14349F2966A8080F1D5EAFF875A47CA6F601FF5E5F46`
- `Joyshell_0.1.69_x64_en-US.msi`: SHA-256 `5727A8B8518E9E7D941FF4ED428DCE3B6AA5C6AACAD4D9D39021C1FECC0FACD6`

`0.1.69_build_2` 已生成但未分发；最终审阅补齐 Local/SOCKS 目标失败状态后按构建规则递增为 `build_3`，不复用 `build_2` 的文件名和哈希。

`0.1.69_build_3` 修复安装包（2026-09-01，Windows x64 Pre-release）：

- `Joyshell_0.1.69_build_3_x64-setup.exe`: SHA-256 `0DA4E788A98B30D9EE1D3376959E6FA6A297262F004A8BCE6169B67BE2524560`
- `Joyshell_0.1.69_build_3_x64_en-US.msi`: SHA-256 `003B023B280EEADE52AA17AD11B5B7FDF3AD191EA42AB27C6DBB3136E6D0750C`

两份安装包的 Authenticode 状态均为 `NotSigned`。自动检查已通过：Rust workspace 34 项测试、前端 16 项测试、TypeScript 类型检查、Rust 格式检查、Clippy、生产前端构建和 Windows NSIS/MSI 打包。Git 标签为 `v0.1.69-build.3`；标签所指提交即为本报告对应源码。Windows 产品版本保持 `0.1.69`，应用内标识、Release 标题、Git 标签和安装包文件名使用 `0.1.69_build_3`。

安装包尚未进行 Authenticode 数字签名。开源 Pre-release 可分发未签名包，但 Windows 可能显示未知发布者或 SmartScreen 提示；用户应使用 Release 中的 SHA-256 校验文件。后续签名会改变文件哈希，必须使用新的构建号重新发布。

独立构建序号从 `0.1.69_build_2` 候选起生效，最终发布构建为 `0.1.69_build_3`，详见 [版本与构建编号规则](versioning-and-builds.md)。

## 认证组合状态

桌面端统一凭据加载器支持跳板与目标分别使用密码、私钥或 SSH Agent，并允许混合组合。当前发布环境尚未完成以下五种组合的全部真实验收，因此不把“代码支持”写成“实测通过”：

- 跳板密码 + 目标密码
- 跳板私钥 + 目标私钥
- 跳板 Agent + 目标 Agent
- 跳板 Agent + 目标密码
- 跳板密码 + 目标私钥

## 已知限制

- ProxyJump 断网恢复和上述认证组合仍需在具备相应跳板、目标和凭据的企业网络环境完成最终实机验收。
- SOCKS5 仅支持 TCP CONNECT，不支持 UDP Associate。
- 不包含多级跳板；macOS/Linux 不在本版本实机承诺范围内。
