# SSH Desktop Client Research And Tech Selection

调研日期：2026-07-21

实现更新：2026-07-27。仓库已经采用本文推荐的 `Tauri 2 + React/TypeScript + Rust + xterm.js + SQLite` 路线；SSH/SFTP 后端当前使用 `ssh2-rs/libssh2`。Windows `0.1.52` NSIS/MSI 已构建，macOS/Linux 仍待实机验证。本文其余内容保留为选型背景，不代表所有列出的功能已经实现。

### 同一服务器多 Shell 的源码结论

`0.1.51` 针对已连接服务器双击和同服务器多开，复核了以下固定提交：

- Electerm `02925cb811366190613484f9d95d077be27767a0`：bookmark 通过 `srcId` 关联保存配置，`newTerm()`/`addTab()` 为每次打开创建新的 tab 实例。
- Tabby `14e2d60b9b6dee84a53c37f05eefeb803787de04`：`SSHProfile`、`SSHTabComponent`、`SSHShellSession` 与底层 `SSHSession` 分层；`setupOneSession()` 明确控制是否复用/多路复用底层连接，duplicate tab 也创建新的 tab。
- Termora `712a3168ebae86b12647989dc1285718a0b11ec9`：`OpenHostAction` 每次经 provider 创建 `TerminalTab`，重连时在原 tab 索引创建替代 runtime tab。

Joyshell 因而采用 `ProfileId -> ShellId -> Runtime SessionId`。当前 `ShellId` 与 `Runtime SessionId` 一一对应，一个 Profile 可拥有多个独立连接；关闭一个 Shell 不会断开同 Profile 的其他 Shell。初版不默认复用交互式 SSH 传输层，以隔离阻塞、断线和终端状态。已连接服务器双击默认激活最早打开的已连接 Shell，也可在常规设置切换为新建独立 SSH 连接。

目标：开发一款 UI、主题、操控性和功能接近 FinalShell，但性能和内存占用尽量接近 MobaXterm 的 SSH 客户端。首期目标平台为 Windows、macOS、Linux Debian/Ubuntu，后续评估 Android 与 iOS。

## 1. 结论先行

推荐首期路线：

- 前端壳：Tauri 2 + Web UI。
- 前端技术：React/Vue/Svelte 均可，建议 React + TypeScript 或 Svelte + TypeScript。
- 终端组件：xterm.js，优先启用 WebGL/canvas 渲染路径。
- 后端核心：Rust。
- SSH/SFTP：首期可用 libssh2/ssh2-rs 或 russh，视稳定性和算法兼容性二选一。
- 本地 shell/PTY：Windows ConPTY，Unix/macOS PTY。
- 数据层：SQLite + SQLCipher 可选；配置、会话、密钥、主题、命令片段都本地持久化。
- 打包：Tauri 打包 exe/msi、dmg/pkg、deb/AppImage；移动端等核心稳定后再开分支验证。

不建议首期使用 Electron 作为主壳。Electron 生态成熟，Tabby、electerm 等 SSH 工具已经证明它能快速做出好看的跨平台桌面应用，但它自带 Chromium 和 Node runtime，内存基线更难接近 MobaXterm。

如果极端追求 MobaXterm 级别内存和启动速度，长期可考虑 Qt 6/QML + C++/Rust core 或全 Rust native UI。但这会显著增加 UI 研发成本，主题系统、插件生态、复杂表格/侧栏/设置页的迭代速度都会变慢。

## 2. 主流产品版图

### Windows 桌面

- MobaXterm：Windows 生态强势，卖点是 SSH、X11 server、SFTP、tabbed terminal、portable、network tools。闭源。适合作为性能和工具箱密度标杆。
- FinalShell：Windows/macOS/Linux 均有客户端，侧重 SSH、服务器管理、文件管理、监控、主题和易用性。闭源。适合作为 UI/功能体验标杆。
- Xshell：商业 SSH 终端，Windows 为主，企业用户多。
- SecureCRT：商业多平台 SSH/terminal，稳定性和企业场景强。
- PuTTY：经典、轻量、开源，Windows 传统用户群巨大，但 UI 现代化不足。
- Bitvise SSH Client：Windows SSH/SFTP 场景成熟，偏工具型。
- WinSCP：Windows SFTP/SCP/FTP 客户端，开源，文件传输体验可参考。
- Royal TS / Devolutions Remote Desktop Manager：远程连接管理平台，覆盖 SSH/RDP/VNC 等，偏企业资产管理。

### macOS 桌面

- Termius：多平台 SSH 客户端，同步和团队功能强。
- SecureCRT：多平台商业终端。
- Royal TSX：macOS 远程连接管理。
- iTerm2 + OpenSSH：开发者常用组合，不是 SSH 管理器，但终端体验强。
- Tabby/electerm/WindTerm/WezTerm：跨平台或开源产品，在 macOS 上有用户群。

### Linux 桌面

- OpenSSH + GNOME Terminal/Konsole/Alacritty/WezTerm：开发者常用组合。
- FinalShell：提供 Linux 客户端。
- Termius：提供 Linux 客户端。
- WindTerm、electerm、Tabby：跨平台 GUI SSH 客户端。
- Remmina：偏远程桌面，也支持 SSH/隧道等。

### iOS / iPadOS

- Termius：iOS/iPadOS 体验成熟，支持多端同步。
- Blink Shell：iOS/iPadOS 上的 SSH/Mosh/terminal，开发者口碑强，开源。
- Prompt by Panic：iOS SSH 客户端，商业应用。

### Android

- Termius。
- JuiceSSH。
- Termux + OpenSSH：更偏命令行环境。
- ConnectBot：经典开源 SSH 客户端。

## 3. 可参考的开源项目

### GUI SSH 客户端

1. WindTerm
   - 地址：https://github.com/kingToolbox/WindTerm
   - 技术价值：跨平台 SSH/SFTP/terminal，一体化体验接近目标产品。
   - 可参考：会话管理、SFTP、终端多标签、主题、性能优化思路。
   - 注意：不要直接照搬 UI 或代码结构；重点看功能边界和交互密度。

2. electerm
   - 地址：https://github.com/electerm/electerm
   - 技术价值：Electron + terminal + SSH/SFTP，产品形态接近 FinalShell。
   - 可参考：会话树、文件管理、主题、同步、设置页、快捷命令。
   - 注意：Electron 内存基线偏高，不建议作为性能目标的主架构。

3. Tabby
   - 地址：https://github.com/Eugeny/tabby
   - 技术价值：Electron/TypeScript 终端应用，插件和主题生态强。
   - 可参考：插件系统、配置体系、终端 profile 抽象、跨平台打包。
   - 注意：同样存在 Electron 体积和内存问题。

4. PuTTY
   - 地址：https://git.tartarus.org/simon/putty.git
   - 技术价值：经典 SSH 实现，轻量、稳定、可移植。
   - 可参考：SSH 兼容性、密钥格式、会话参数模型。
   - 注意：UI 现代化价值不高。

5. WinSCP
   - 地址：https://github.com/winscp/winscp
   - 技术价值：Windows 文件传输客户端标杆。
   - 可参考：SFTP 文件管理、队列、断点/重试、权限、远程编辑。

6. Blink Shell
   - 地址：https://github.com/blinksh/blink
   - 技术价值：iOS/iPadOS SSH/Mosh 终端，移动端键盘、手势、会话体验优秀。
   - 可参考：移动端交互、软键盘辅助栏、Mosh 支持。

### 终端模拟器 / 渲染

1. xterm.js
   - 地址：https://github.com/xtermjs/xterm.js
   - 技术价值：VS Code 等产品使用的 Web terminal component。
   - 推荐用途：Tauri/Web UI 路线下首选终端组件。

2. WezTerm
   - 地址：https://github.com/wez/wezterm
   - 技术价值：Rust 终端模拟器，GPU 渲染、多平台、内置 SSH/mux 能力。
   - 可参考：终端渲染、PTY、多路复用、配置模型、SSH session。

3. Alacritty
   - 地址：https://github.com/alacritty/alacritty
   - 技术价值：Rust + OpenGL 高性能终端。
   - 可参考：终端网格、渲染性能、配置与跨平台处理。

4. Contour
   - 地址：https://github.com/contour-terminal/contour
   - 技术价值：C++ terminal emulator，现代终端协议支持较多。

### SSH / PTY / 协议库

1. libssh2
   - 地址：https://libssh2.org/
   - 技术价值：C 语言 SSH2 client library，成熟稳定。
   - 推荐用途：需要最大兼容性时作为底层 SSH 库。

2. ssh2-rs
   - 地址：https://github.com/alexcrichton/ssh2-rs
   - 技术价值：Rust bindings for libssh2。
   - 推荐用途：Rust 后端中快速获得成熟 SSH/SFTP 能力。

3. russh
   - 地址：https://github.com/Eugeny/russh
   - 技术价值：Rust 原生 SSH client/server library，异步友好。
   - 推荐用途：追求纯 Rust、异步架构和长期可控性。

4. portable-pty
   - 地址：https://github.com/wez/wezterm/tree/main/pty
   - 技术价值：WezTerm 的跨平台 PTY 思路可参考。

## 4. 前端技术路线对比

| 方案 | 优点 | 缺点 | 适配平台 | 适合程度 |
| --- | --- | --- | --- | --- |
| Tauri 2 + Web UI + Rust | 包体小、内存低于 Electron、Rust 后端强、桌面三平台好，Tauri 2 已支持移动端方向 | WebView 差异需要适配；复杂终端性能要优化 | Windows/macOS/Linux，Android/iOS 可探索 | 首推 |
| Electron + React/Vue | 生态成熟、开发快、xterm.js 方案成熟、插件好做 | 内存和包体偏大，难接近 MobaXterm | Windows/macOS/Linux，移动端不适合 | 快速原型可用，不适合最终性能目标 |
| Qt 6/QML + C++/Rust | 性能好、原生能力强、跨平台成熟、商业桌面质感可做高 | 开发成本高，主题/复杂 UI 迭代慢，团队要求高 | Windows/macOS/Linux/Android/iOS | 性能优先路线 |
| Flutter | 桌面和移动统一，UI 一致，移动端优势明显 | 终端模拟器和 SSH GUI 生态弱于 Web/xterm.js，桌面原生细节要补 | Windows/macOS/Linux/Android/iOS | 移动优先时考虑 |
| Avalonia/.NET | 桌面跨平台不错，Windows 体验较好 | 移动端和终端生态不如 Web/Rust，Linux 细节需验证 | Windows/macOS/Linux，移动可探索 | Windows 团队可考虑 |
| Rust native UI: egui/iced/slint | 性能和内存有潜力 | 复杂业务 UI、表格、主题、插件生态成本较高 | 视框架而定 | 长期专项可探索 |

## 5. 后端技术路线对比

| 后端 | 优点 | 缺点 | 判断 |
| --- | --- | --- | --- |
| Rust | 性能好、内存可控、跨平台、适合 SSH/PTY/SFTP/同步/加密，本地安全边界清晰 | 学习曲线较高，GUI 生态需搭配 | 首推 |
| Go | 并发和网络开发快，跨平台打包简单 | GUI 整合和本地终端/PTY细节弱于 Rust/C++，内存控制一般 | 可做服务层，但不首推 |
| C++ | 性能强，Qt 生态成熟 | 研发和维护成本高，安全风险更高 | 极致性能路线 |
| C#/.NET | Windows 体验好，Avalonia 可跨平台 | Linux/macOS/移动一致性与包体需评估 | Windows 优先团队可选 |
| Node.js | 生态多、开发快 | 性能/内存与目标冲突 | 只适合插件/脚本层 |

推荐后端模块拆分：

- session-core：SSH session 生命周期、重连、心跳、代理、跳板机。
- terminal-core：PTY/terminal 数据流、backpressure、编码、日志录制。
- sftp-core：目录枚举、上传下载、队列、权限、远程编辑、断点续传。
- secret-core：密钥、密码、passphrase、本机 Keychain/Credential Manager/libsecret。
- profile-store：SQLite 存储 session、folder、tag、theme、snippet。
- sync-core：后续再做云同步或自托管同步，不要首期绑定。
- plugin-api：后期用 WebView extension 或 WASM/JS sandbox 做插件。

## 6. 为什么推荐 Tauri 2 + Rust + xterm.js

这个组合最符合目标中的三角平衡：美观性、个性化、性能。

- 美观性：Web UI 的主题、布局、动画、设置页、文件管理器、图标系统都更容易做出 FinalShell 式完整体验。
- 个性化：主题、快捷键、命令片段、会话树、标签页、布局保存，用前端状态管理更快。
- 性能：Tauri 使用系统 WebView，避免 Electron 捆绑整套 Chromium；Rust 负责 SSH/PTY/SFTP 后端，避免把高频 IO 压在 Node 里。
- 跨平台：桌面三平台成熟度最高；Tauri 2 已经把移动端纳入路线，但移动端终端体验需要单独设计，不能指望桌面 UI 原样搬过去。

关键风险：

- xterm.js 在超大输出、全屏刷新、日志刷屏时要调优。
- Windows WebView2 版本和 Linux WebKitGTK 依赖会影响部署体验。
- SSH 算法兼容性、代理、跳板机、键盘交互、SFTP 边界情况会吃很多测试时间。
- iOS 后台连接、文件系统权限、密钥管理、外接键盘体验都和桌面不同。

## 7. 建议产品能力分期

### MVP

- 多标签 SSH terminal。
- 会话树、分组、搜索、标签。
- 密码/密钥登录。
- SFTP 左右/单侧文件管理。
- 主题、字体、配色、透明度、光标、快捷键。
- 本地 shell terminal。
- 日志、复制粘贴、命令片段。
- Windows/macOS/Linux 打包。

### V1

- 跳板机、代理、端口转发。
- 批量执行命令。
- 远程监控面板：CPU、内存、磁盘、网络、进程。
- 多布局：左右分屏、上下分屏、拖拽标签。
- 密钥管理、known_hosts 管理。
- SFTP 队列、断点、冲突处理、远程编辑。
- 自动重连、会话恢复。

### V2

- 插件系统。
- 连接同步/备份。
- Mosh。
- RDP/VNC/Serial/WSL/Docker/Kubernetes 集成。
- Android/iOS 专用 UI。

## 8. 性能目标建议

不要直接写“达到 MobaXterm 一致”，而是制定可测指标：

- 冷启动到首屏：Windows 主流机器小于 1.5 秒。
- 空闲内存：单窗口小于 120 MB，目标小于 90 MB。
- 单 SSH 会话内存增量：小于 15 MB。
- 10 个 SSH 标签空闲：小于 220 MB。
- 大量输出：持续 5 MB/s 文本输出时 UI 不冻结。
- SFTP 大文件传输：UI 主线程不阻塞。
- 打包体积：Windows 安装包小于 30-50 MB，Linux deb 小于 30-50 MB。

这些指标需要首月就写 benchmark，不然后期很难补救。

## 9. 初始仓库建议

建议 monorepo：

```text
Joyshell/
  apps/
    desktop/          # Tauri app + Web UI
  crates/
    joyshell-core/    # session/ssh/sftp/pty shared core
    joyshell-store/   # sqlite/config/secret
    joyshell-proto/   # DTO/event protocol
  packages/
    ui/               # shared UI components
    terminal/         # xterm.js wrapper
  docs/
```

首期技术栈：

- apps/desktop：Tauri 2 + React/Vite + TypeScript。
- crates：Rust workspace。
- UI：Tailwind CSS 或 vanilla-extract；如果强调设计系统，Radix UI + 自研主题 token。
- Terminal：xterm.js + addons fit/search/web-links/webgl。
- Storage：SQLite。
- IPC：Tauri commands + event stream；终端数据流建议单独做高频通道和 backpressure。

## 10. 资料来源

- MobaXterm: https://mobaxterm.mobatek.net/
- FinalShell: https://www.hostbuf.com/
- Termius: https://termius.com/
- Tauri: https://tauri.app/
- Flutter multi-platform: https://flutter.dev/multi-platform
- Qt supported platforms: https://doc.qt.io/qt-6/supported-platforms.html
- Avalonia: https://avaloniaui.net/
- xterm.js: https://xtermjs.org/
- WindTerm: https://github.com/kingToolbox/WindTerm
- electerm: https://github.com/electerm/electerm
- Tabby: https://github.com/Eugeny/tabby
- WezTerm: https://github.com/wez/wezterm
- Alacritty: https://github.com/alacritty/alacritty
- PuTTY source: https://git.tartarus.org/simon/putty.git
- WinSCP source: https://github.com/winscp/winscp
- Blink Shell: https://github.com/blinksh/blink
- libssh2: https://libssh2.org/
- ssh2-rs: https://github.com/alexcrichton/ssh2-rs
- russh: https://github.com/Eugeny/russh
