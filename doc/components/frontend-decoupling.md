# Frontend Conservative Decoupling

## 目标

本轮解耦解决 `JoyshellApp.tsx` 过大、状态和 UI 互相牵连的问题。首要约束不是追求抽象数量，而是不改变已经调试稳定的 SSH、SFTP、时延、拖拽、传输和渐变算法。

基线提交：

- `bf6e7dd`：`0.1.41` 稳定回滚点。
- `9945ac0`：领域组件和纯模型拆分。
- `912dd16`：样式领域拆分。

## 当前目录边界

```text
src/app/JoyshellApp.tsx       组合、初始化和跨模块路由
src/features/home/            主页服务器轮播
src/features/sessions/        会话设置、排序和拖放模型
src/features/settings/        全页设置工作区
src/features/terminal/        时延、缓存模型和终端 runtime
src/features/sftp/            远程路径模型
src/features/transfers/       传输统计、动画时钟和 runtime
src/features/system-info/     系统指标派生和详情弹窗
src/features/commands/        命令片段 UI
src/features/dialogs/         应用内确认和输入弹窗
src/platform/                 DesktopClient 与事件适配
src/shell/                    窗口、布局和渐变
src/styles/                   base/workspace/overlays
```

## 状态归属

| 状态 | 所有者 | 原因 |
| --- | --- | --- |
| xterm 实例、输出镜像、每会话缓存 | `useTerminalRuntime` 的 ref | 高频、不可序列化，不应触发 React 全树渲染 |
| 传输队列、平滑速度、ETA、取消标记 | `useTransferRuntime` | 公式和队列更新需要保持原子性 |
| 三面板开关、布局设置持久化 | `useLayoutController` | 集中处理“恢复上次布局”和 SQLite 写入 |
| Tauri session event | `useSessionEvents` | 只注册一次监听，再分发给会话/终端/传输 |
| 窗口移动和渐变 CSS 变量 | `useChromeGradient` | 不进入业务组件状态，避免拖窗时重渲染 |
| 终端和传输纯计算 | `terminal-model`、`transfer-model` | 可测试、无 React/Tauri 依赖 |

## DesktopClient

业务代码通过 `platform/desktop-client.ts` 使用统一客户端，不直接判断 `window.__TAURI_INTERNALS__`。

- 桌面运行时：调用 Tauri invoke/listen。
- 浏览器预览：返回本地预览数据或明确的不支持结果。
- `src/bridge.ts` 仅保留兼容重导出，避免一次性改坏旧引用。

浏览器预览与桌面 UI 使用同一 React 组件，但不代表后端行为一致。真实 SSH、SQLite、系统文件对话框、窗口控制和打包资源必须在 Tauri 中测试。

## 保守迁移方法

1. 先提取纯计算函数并用相同输入验证输出。
2. 再提取组件，保留 DOM 顺序、class 名和回调签名。
3. runtime 状态用 hook 封装，但不改缓存长度、速度平滑或事件顺序。
4. 每批运行 TypeScript 构建。
5. 完成后运行前端测试、Rust workspace 测试和 Tauri 打包。

## 已解决的风险

- Hook 返回对象会在每次渲染产生新 identity。终端切换 effect 必须依赖稳定的 action 函数，不能依赖整个 `actions` 对象，否则会重复执行 `replace/focus`。
- `DesktopClient` 迁移时保留 `bridge.ts` 兼容层，避免业务组件同时大面积改 import。
- CSS 拆分保持原有加载顺序，避免层叠优先级和圆角/背景回归。
- 终端输出、Promise resolver 和 xterm handle 不写入 SQLite 或普通 React 可序列化状态。

## 当前限制

- `JoyshellApp.tsx` 仍负责较多会话、SFTP 操作和上下文菜单编排，尚未达到最初“不超过约 300 行”的目标。
- 没有引入 Zustand/Redux；在现阶段这是有意选择，避免第二套状态语义。
- 前端自动测试覆盖不足，当前主要依赖纯模型测试、生产构建和桌面冒烟验证。
- 代码分包尚未处理，Vite 对大于 500 kB 的 JS chunk 会给出警告。

## 后续顺序

1. 先补终端缓存、传输统计、拖放定位和渐变坐标的特征测试。
2. 将会话 CRUD/排序编排收敛为 `useSessionsController`。
3. 将 SFTP listing、原生文件选择和传输 action 收敛为 `useSftpController`。
4. 最后再评估 CSS Modules、类型自动生成和代码分包。
