# Desktop Chrome And Unified Gradient

## 问题背景

标题栏、左侧导航、左下设置区和工作区曾分别绘制背景。窗口高度或宽度变化后，Grid 剩余区域、footer、伪元素或折叠动画会露出不同底色，表现为：

- 左下角淡紫/白色横条随窗口高度变化；
- 右侧折叠时闪现整条黄色背景；
- 标题栏与侧栏有明显分界线；
- 工作区背景图覆盖标题栏；
- 左上圆角同时出现尖角、缺口或向内凹痕。

这些问题不能靠继续给子元素补背景色解决，因为每补一层都会增加新的拼接边界。

## 最终结构

- `app-shell` 是唯一 Chrome 渐变底面。
- `.system-titlebar`、`.sidebar`、`.sidebar-footer` 使用透明背景并位于同一底面之上。
- `.workspace`、终端背景图和主页背景图是独立上层，不修改 Chrome CSS 变量。
- `--sidebar-footer-height` 固定 footer 高度；会话列表只在剩余区域滚动，不能覆盖 footer。
- 工作区圆角只在一个边界层裁剪，避免父子层重复圆角产生尖角。

相关文件：

- `apps/desktop/src/styles/base.css`
- `apps/desktop/src/styles/workspace.css`
- `apps/desktop/src/shell/chrome-gradient.ts`
- `apps/desktop/src/shell/use-chrome-gradient.ts`

## 与屏幕位置绑定

Tauri 桌面端通过以下信息计算渐变：

- `currentMonitor()`：显示器起点和物理尺寸；
- `outerPosition()`：窗口左上角物理坐标；
- `outerSize()`：窗口物理尺寸；
- `onMoved/onResized`：窗口位置和大小变化事件。

算法使用窗口中心点相对显示器的 `xRatio/yRatio`，更新色相、亮度、glow 位置和整张渐变画布的偏移：

```text
bgX = monitor.x - window.x
bgY = monitor.y - window.y
```

因此窗口移动时看到的是固定在桌面坐标系上的大画布，而不是每个窗口内部重新开始的渐变。

事件处理使用 `requestAnimationFrame` 合并同一帧的 move/resize 更新，不监听全局鼠标，不干扰右键菜单和拖放操作。React 组件本身不随每次拖动重渲染，只更新根节点 CSS 变量。

浏览器预览无法调用 Tauri Window API，使用 `screenX/screenY/outerWidth/outerHeight` 的 fallback。该 fallback 仅用于视觉检查，最终行为以桌面包为准。

## 预设

当前预设定义于 `CHROME_GRADIENT_PRESETS`：

- Codex Soft（默认）
- Cool Blues
- Green Beach
- Slight Ocean View
- Perfect Blue

设置只改变 `app-shell` 的渐变变量，不应修改终端、主页背景图或半透明内容层。

## 回归经验

- `852128b` 同时增加侧栏 resize 和历史轨道后布局回归，`33ca652` 回滚。布局底层和新功能应分开提交。
- 只用固定 `100%` 背景尺寸不足以覆盖拖动/缩放过渡，需要物理画布尺寸和 overscan。
- footer 必须属于侧栏 Grid，而不是绝对定位叠加层。
- 折叠时出现的颜色通常来自被揭露的底层，不应先怀疑按钮本身。

## 验证清单

1. 1920x1080、1365x768 和最小窗口尺寸检查标题栏/侧栏连续性。
2. 上下、左右拖动窗口，确认渐变位置随桌面坐标变化。
3. 反复收起左右栏和底部文件区，确认无白条/黄条闪现。
4. 切换主页/终端自定义背景，确认图片不覆盖系统栏。
5. 进入设置页，确认左侧分类区仍使用同一 Chrome 底面。
