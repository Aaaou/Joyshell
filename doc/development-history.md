# Joyshell 开发历程与问题记录

本文以 Git 提交记录和实际调试过程为依据，说明当前功能如何演进。未提交的工作会明确标注为工作区状态，不伪造提交号。

## 2026-08-02：`0.1.53` 私钥登录与密钥会话 SFTP

- 阅读 Tabby、electerm、ssh2-rs 和 libssh2 的固定版本实现后，接入本机私钥文件与可选私钥口令认证。
- Profile 只保存私钥路径；私钥口令复用 AES-256-GCM secret store，私钥正文不进入 SQLite。
- 交互终端、系统监控和 SFTP side session 复用同一种认证凭据。
- 将 SFTP 初始目录从硬编码 `/root` 改为服务器解析的当前用户主目录，修复非 root 密钥用户无法读取文件面板的问题。
- Windows OpenSSH 和 Joyshell 后端均完成真实密钥登录验证；后端同时验证终端、系统监控、用户主目录和根目录 SFTP 读取。

## 2026-07-22：从原型到真实桌面 SSH

### `be2cc80` Initial Joyshell desktop implementation

初始提交建立了 Tauri 2 + React + Rust monorepo，并实现了桌面 UI、SSH/SFTP 核心、SQLite、Agent 权限模型等第一批代码。

这个阶段最重要的教训是：UI 显示“连接成功”不能代表 SSH 成功。真实连接路径必须完成 TCP 连接、SSH 握手、密码认证、PTY 分配和 Shell 启动后才能进入 `Connected`。

主要困难：

- libssh2 非阻塞状态曾被当成致命错误，导致终端只在连接后一瞬间可输入。
- Windows 默认算法能力不足，连接现代 OpenSSH 时出现 KEX 失败。
- Tauri 事件偶发遗漏时，后端已有输出但 xterm.js 没有刷新。
- SFTP、监控和终端最初共享一个阻塞 worker，大文件传输会冻结终端。

解决方案分别记录在：

- [Terminal SSH Interaction](components/terminal-ssh-interaction.md)
- [SFTP And Terminal Concurrency](components/sftp-terminal-concurrency.md)
- [SSH Health And System Sync](components/ssh-health-and-sync.md)

## 2026-07-23：系统信息、时延和会话交互

### `c46f6bc` 系统信息与会话 UI

加入 CPU、内存、磁盘、网络和进程信息。监控数据通过 side SSH exec channel 采集，不向用户可见的 Shell 注入命令。

### `2d8162b`、`491aedf`、`e5e5573`、`da83b05`、`5148f6d`

时延功能经历了多次修正：

1. TCP 时延对普通服务器有效，但 `127.0.0.1:2222` 之类的 FRP/Cloudflare 本地入口只会测到本机代理。
2. 配置独立 probe host 仍不能保证测到隧道内真实 SSH 链路。
3. 改用 SSH 会话 RTT/终端回传采样后，主动探测可能与用户输入竞争。
4. 最终增加输入/输出忙碌窗口、交互样本平均和 Profile 级开关，避免每次按键都刷新时延。

相关提交：

- `2d8162b` feat: add latency metric and refine status panels
- `491aedf` feat: support tunnel latency probe target
- `e5e5573` feat: measure latency through ssh terminal channel
- `da83b05` fix: avoid active latency probes during terminal use
- `5148f6d` fix: gate terminal latency behind profile setting

### `da06b24` 至 `b8a7242`

这一阶段修复了服务器位置调整、删除确认、侧栏滚动、主页设备轮播、应用内弹窗和右键菜单定位。

实际遇到的问题：

- HTML5 drag-and-drop 在 WebView 中会出现禁止光标和 `dragenter/dragleave` 闪烁。
- 占位元素改变文档流会让服务器列表抖动。
- 系统 `confirm/prompt` 与软件视觉不一致。
- 右键菜单靠近窗口边缘时会被裁切。

采用的交互：拖放位置使用蓝色插入线而不是占位块；危险操作使用应用内确认框；菜单根据视口尺寸反向定位。

## 2026-07-23 至 2026-07-24：个性化与桌面 Chrome

### `7d356dd` 至 `e096a2d`

完成全页设置、图片裁剪、启动图、工作区背景和主页背景。背景图只作用于主页/终端区域，不能覆盖系统标题栏和统一 Chrome 渐变底层。

### `a52d81a` 至 `d8eb240`

桌面顶栏、左侧导航、左下设置区和折叠过渡曾出现白条、黄条、紫色断层及圆角尖角。根因不是单个颜色值，而是多个容器分别绘制背景，加上 Grid 剩余空间、伪元素和窗口尺寸变化后露出不同底层。

关键提交：

- `89aefc6` unify chrome background layout
- `0404a5f` isolate workspace background from chrome gradient
- `31d58a1` flatten sidebar footer layout
- `0e40f1e` use unified chrome gradient base
- `9353e5b` prevent sidebar footer gradient fallback
- `d8eb240` add chrome gradient overscan

最终原则：

- `app-shell` 只绘制一次完整渐变底面。
- 标题栏、左侧栏和 footer 本身透明。
- 工作区和背景图位于渐变底面上方，作用域彼此隔离。
- 渐变画布按显示器坐标定位，窗口移动时只更新 CSS 变量。

详见 [Desktop Chrome And Gradient](components/desktop-chrome-and-gradient.md)。

### `852128b` 与 `33ca652`

可调侧栏宽度和命令历史轨道曾一次性进入主分支，但引入明显布局回归，随后回滚到 `0.1.30` 稳定 Chrome。这个过程确认了后续 UI 改动必须小批量、每批截图验证，不能把布局重构与新功能同时提交。

## 2026-07-24：稳定基线与前端解耦

### `bf6e7dd` `0.1.41` 稳定基线

在解耦前固定可回滚版本，修复桌面 Chrome、SQLite 设置字段和前端类型兼容。

### `9945ac0` 前端领域拆分

将约 6000 行入口按 `home`、`sessions`、`settings`、`commands`、`dialogs`、`system-info`、`terminal`、`transfers` 等领域拆分，并提取纯模型函数。DOM 类名、Tauri command、Rust DTO、SQLite schema 和 SSH/SFTP 算法保持不变。

### `912dd16` CSS 领域拆分

在不调整选择器声明的前提下，将样式按原顺序拆成：

- `styles/base.css`
- `styles/workspace.css`
- `styles/overlays.css`

### `0.1.43` 工作区收尾（尚未形成提交号）

在 `912dd16` 后继续提取：

- `platform/runtime-client.ts` 与兼容导出 `bridge.ts`
- `platform/use-session-events.ts`
- `shell/use-layout-controller.ts`
- `shell/use-window-controls.ts`
- `features/terminal/use-terminal-runtime.ts`
- `features/transfers/use-transfer-runtime.ts`
- SFTP 路径模型、系统信息弹窗、启动生命周期和文件夹偏好

验证结果：

- `pnpm test` 通过，前端实际测试 `2/2`。
- `pnpm build` 通过。
- `cargo test --workspace` 通过，Rust 实际单元测试 `4/4`，doc tests 通过。
- Windows NSIS/MSI `0.1.43` 构建通过。

## 2026-07-24：`0.1.44` 图标与系统识别

- 文件图标项目 `5214392` 更新 folder、SHELL 和 other fallback。
- 引入操作系统图标项目 `5215323`，主页由探针结果选择 Windows、macOS、Ubuntu、Alpine、CentOS、Fedora、Red Hat 或 FreeBSD 图标。
- `SessionProfile.operating_system` 写入 SQLite；旧数据库通过幂等列迁移保留原有服务器和密码数据。
- 常见 UI 图标项目 `5214464` 只导入资源，等待后续交互方案，避免同名 SVG Symbol 与现有文件图标冲突。
- 增加旧 schema 迁移与 OS 字段持久化测试。

## 2026-07-24: `0.1.45` file and application icons

- Replaced the remaining SFTP path-tree folder glyphs with the same Iconfont symbol used by the remote file table.
- Added project-owned Joyshell terminal-mark exports at native 16/20/24/32/48/64/128/256 pixel sizes.
- Built the Windows ICO from all native source sizes so taskbar and executable icons do not depend on downscaling a single large source.
- Kept UI action folders, session-group folders, and file-kind folders as separate semantic icon roles.

## 2026-07-24: `0.1.46` Windows installer upgrade behavior

- Forked the official Tauri CLI 2.11.4 NSIS template with one behavioral change: upgrades default to an in-place overwrite instead of uninstall-first.
- Removed the custom pre-uninstall data-deletion message box.
- Reused the NSIS confirmation-page checkbox, renamed it to `清除用户数据`, and kept it unchecked by default.
- Update-mode uninstalls always preserve SQLite and other user data.

## 2026-07-24: `0.1.47` native Windows small icons

- Replaced the 16/20/24/32/48/64 px application icon frames with the family redrawn from a native 16 px source.
- Preserved the native 128/256 px assets for larger Windows, Linux, and macOS surfaces.
- Rebuilt the multi-frame ICO so Windows selects a supplied frame at each common DPI instead of shrinking the former large-canvas artwork.

## 2026-07-24: `0.1.48` unified operating-system icons

- Replaced the sidebar `UBU/WIN/ALP` text badges with the same operating-system symbols used by the home carousel.
- Reused `resolveProfileOperatingSystem` and `OperatingSystemIcon`, so probe persistence and fallback behavior stay identical in both views.
- Kept the connection-status dot separate from the OS icon and constrained the sidebar symbol to a stable 18 px drawing area.

## 2026-07-24: `0.1.49` native icon family, resizable files, and SSH health

- Replaced every supplied 16/20/24/32/48/64/128/256 px Joyshell mark with the new independently drawn native PNG and rebuilt ICO/ICNS containers from those payloads.
- Added a `120-390px` file-panel resize separator with pointer capture, fast-drag final-coordinate handling, keyboard controls, and SQLite persistence.
- Removed the false PTY-resize RTT probe after verifying libssh2 marks `window-change` as no-reply.
- Added a response-required, nonblocking SSH channel health request every `5s` with a `3s` deadline and deduplicated terminal disconnect feedback.
- Recorded exact OpenSSH, libssh2, and Tabby source commits in `doc/components/ssh-health-and-sync.md`.

## 2026-07-24: `0.1.50` disconnect status and drag-to-collapse

- Changed sidebar and shell-tab status colors to derive from `SessionInfo.state` instead of merely checking whether a cached session object exists.
- Connected sessions are green, connecting/reconnecting sessions are yellow, and failed/disconnected sessions are red.
- Dragging the file panel below its `120px` minimum now collapses it on release without persisting an invalid height.
- Added the same collapse behavior to keyboard resizing when Arrow Down crosses the minimum.

## 2026-07-24: `0.1.51` profile-aware multi-Shell sessions

- Separated saved Profile IDs from Shell/runtime Session IDs so one server can own multiple independent SSH connections and terminal caches.
- Added a general setting for connected-server double-click behavior: activate the earliest connected Shell or create a new SSH connection.
- Added server and tab context-menu entries for opening another Shell without reconnecting an already connected tab.
- Kept sidebar status aggregated by Profile while tab status, terminal input, SFTP, latency, disconnect and close actions use the runtime Session ID.
- Followed Electerm `02925cb8`, Tabby `14e2d60b`, and Termora `712a3168` source boundaries for Profile/Tab/Session ownership.
- Fixed the `0.1.50` sidebar status card overflow by constraining it to the 238px rail and shortening the visible build label.
- Added three frontend decision tests, one SQLite migration/persistence test, and an environment-driven two-session SSH probe; the real probe verified isolated output on two simultaneous sessions for one Profile.

## 2026-07-27: `0.1.52` theme text layout fix

- Replaced the broad `.appearance-swatch span` selector with the dedicated `.appearance-swatch-preview` class.
- Prevented the theme title/description container from inheriting the color dot's `18x18px` size, circular radius, and inset shadow.
- Verified all five theme items in the browser preview; text containers retain natural width while only the color preview remains circular.

## 持续原则

1. 传统 SSH/SFTP 行为优先参考官方协议库和成熟开源客户端。
2. 浏览器预览只验证 UI；SSH、文件对话框、SQLite 和窗口行为必须在 Tauri 包中验证。
3. 高频终端数据不进入全局可序列化状态。
4. 终端、SFTP、监控各自隔离，任何辅助功能不得阻塞用户输入。
5. 每次发布递增版本号，并在包内显示 build marker。
6. 文档和测试禁止包含真实密码、Token、私钥和内部服务器信息。
