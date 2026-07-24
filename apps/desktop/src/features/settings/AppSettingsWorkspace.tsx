import { Palette, X } from "lucide-react";
import type React from "react";
import { useCallback, useEffect, useRef, useState } from "react";
import defaultWorkspaceBackground from "../../assets/backgrounds/default-workspace-bg.jpg";
import splashCenterImage from "../../assets/splash/center-joy-cropped.png";
import { CHROME_GRADIENT_PRESETS } from "../../shell/chrome-gradient";
import type { LayoutSettings } from "../../types";

type ImageCropRequest = {
  target: "splash" | "terminal-background";
  title: string;
  sourceUrl: string;
  aspectRatio: number;
  outputWidth: number;
  outputHeight: number;
};

function clampNumber(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

async function readImageFileAsDataUrl(file: File) {
  return new Promise<string>((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => typeof reader.result === "string" ? resolve(reader.result) : reject(new Error("Unable to read image"));
    reader.onerror = () => reject(reader.error ?? new Error("Unable to read image"));
    reader.readAsDataURL(file);
  });
}

export function AppSettingsWorkspace({
  activePage,
  layout,
  onLayoutChange
}: {
  activePage: "general" | "appearance";
  layout: LayoutSettings;
  onLayoutChange: (patch: Partial<LayoutSettings>) => void;
}) {
  const splashInputRef = useRef<HTMLInputElement | null>(null);
  const backgroundInputRef = useRef<HTMLInputElement | null>(null);
  const [cropRequest, setCropRequest] = useState<ImageCropRequest | null>(null);

  const chooseSplashImage = useCallback(async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) {
      return;
    }
    setCropRequest({
      target: "splash",
      title: "裁剪中心图",
      sourceUrl: await readImageFileAsDataUrl(file),
      aspectRatio: 1,
      outputWidth: 288,
      outputHeight: 288
    });
  }, []);

  const chooseTerminalBackground = useCallback(async (event: React.ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    event.target.value = "";
    if (!file) {
      return;
    }
    setCropRequest({
      target: "terminal-background",
      title: "裁剪背景图",
      sourceUrl: await readImageFileAsDataUrl(file),
      aspectRatio: 16 / 9,
      outputWidth: 1600,
      outputHeight: 900
    });
  }, []);

  return (
        <div className="app-settings-content">
          <header>
            <span>{activePage === "general" ? "常规" : "外观"}</span>
          </header>
          {activePage === "general" ? (
            <div className="settings-page general-settings-page">
              <section>
                <strong>启动</strong>
                <label className="settings-toggle-row">
                  <span>
                    <b>恢复上次会话</b>
                    <small>持久化会话接入后启用。</small>
                  </span>
                  <input type="checkbox" disabled />
                </label>
                <label className="settings-toggle-row">
                  <span>
                    <b>自动刷新文件列表</b>
                    <small>SSH 连接后同步 SFTP。</small>
                  </span>
                  <input type="checkbox" defaultChecked readOnly />
                </label>
              </section>
              <section>
                <strong>传输</strong>
                <label className="settings-toggle-row">
                  <span>
                    <b>速度和预计时间</b>
                    <small>任务完成后隐藏实时速度。</small>
                  </span>
                  <input type="checkbox" defaultChecked readOnly />
                </label>
              </section>
              <section>
                <strong>危险操作</strong>
                <label className="settings-toggle-row">
                  <span>
                    <b>跳过删除确认</b>
                    <small>关闭时删除前弹出确认。</small>
                  </span>
                  <input
                    type="checkbox"
                    checked={layout.skip_delete_confirmations}
                    onChange={(event) => onLayoutChange({ skip_delete_confirmations: event.target.checked })}
                  />
                </label>
              </section>
            </div>
          ) : (
            <div className="settings-page">
              <section>
                <strong>主题</strong>
                <div className="appearance-options">
                  {CHROME_GRADIENT_PRESETS.map((preset) => (
                    <button
                      key={preset.id}
                      type="button"
                      className={`appearance-swatch ${layout.chrome_gradient_preset === preset.id ? "active" : ""}`}
                      onClick={() => onLayoutChange({ chrome_gradient_preset: preset.id })}
                    >
                      <span style={{ background: `linear-gradient(135deg, ${preset.stops[0]}, ${preset.stops[1]} 56%, ${preset.stops[2]})` }} />
                      <span className="appearance-swatch-copy">
                        <strong>{preset.name}</strong>
                        <small>{preset.description}</small>
                      </span>
                    </button>
                  ))}
                </div>
              </section>
              <section>
                <strong>开机动画</strong>
                <div className="image-personalization-row">
                  <div className="splash-center-preview">
                    <img src={layout.splash_center_image_data_url || splashCenterImage} alt="" />
                  </div>
                  <div>
                    <b>中心图案</b>
                    <small>裁剪为启动中心图。</small>
                  </div>
                  <div className="image-actions">
                    <button className="secondary-button" onClick={() => splashInputRef.current?.click()}>
                      选择图片
                    </button>
                    <button className="secondary-button" onClick={() => onLayoutChange({ splash_center_image_data_url: null })}>
                      恢复默认
                    </button>
                  </div>
                  <input ref={splashInputRef} type="file" accept="image/*" hidden onChange={chooseSplashImage} />
                </div>
              </section>
              <section>
                <strong>Shell 背景</strong>
                <div className="image-personalization-row background-row">
                  <div className="terminal-background-preview">
                    <img src={layout.terminal_background_image_data_url || defaultWorkspaceBackground} alt="" />
                  </div>
                  <div>
                    <b>命令行背景图片</b>
                    <small>裁剪后用于 Shell 或主页。</small>
                  </div>
                  <div className="image-actions">
                    <button className="secondary-button" onClick={() => backgroundInputRef.current?.click()}>
                      选择图片
                    </button>
                    <button className="secondary-button" onClick={() => onLayoutChange({ terminal_background_image_data_url: null })}>
                      恢复默认
                    </button>
                  </div>
                  <input ref={backgroundInputRef} type="file" accept="image/*" hidden onChange={chooseTerminalBackground} />
                </div>
                <label className="settings-toggle-row opacity-row">
                  <span>
                    <b>背景不透明度</b>
                    <small>{clampNumber(layout.terminal_background_opacity, 0, 100)}%</small>
                  </span>
                  <input
                    type="range"
                    min={0}
                    max={80}
                    value={clampNumber(layout.terminal_background_opacity, 0, 100)}
                    onChange={(event) => onLayoutChange({ terminal_background_opacity: Number(event.target.value) })}
                  />
                </label>
                <label className="settings-toggle-row">
                  <span>
                    <b>改变 Shell 工作区</b>
                    <small>打开服务器后的终端区域使用该背景。</small>
                  </span>
                  <input
                    type="checkbox"
                    checked={layout.terminal_background_apply_workspace}
                    onChange={(event) => onLayoutChange({ terminal_background_apply_workspace: event.target.checked })}
                  />
                </label>
                <label className="settings-toggle-row">
                  <span>
                    <b>改变主页</b>
                    <small>服务器滑动动画主页也使用该背景。</small>
                  </span>
                  <input
                    type="checkbox"
                    checked={layout.terminal_background_apply_home}
                    onChange={(event) => onLayoutChange({ terminal_background_apply_home: event.target.checked })}
                  />
                </label>
              </section>
              <section>
                <strong>界面</strong>
                <label className="settings-toggle-row">
                  <span>
                    <b>圆角高光列表</b>
                    <small>会话列表和任务队列使用统一轻高光风格。</small>
                  </span>
                  <input type="checkbox" defaultChecked readOnly />
                </label>
                <label className="settings-toggle-row">
                  <span>
                    <b>恢复上次退出布局</b>
                    <small>开启后自动记住退出前左右和底部面板状态。</small>
                  </span>
                  <input
                    type="checkbox"
                    checked={layout.restore_last_layout}
                    onChange={(event) => onLayoutChange({ restore_last_layout: event.target.checked })}
                  />
                </label>
                <label className="settings-toggle-row">
                  <span>
                    <b>默认打开左侧导航栏</b>
                    <small>仅在关闭“恢复上次退出布局”时作为启动默认值。</small>
                  </span>
                  <input
                    type="checkbox"
                    checked={layout.default_left_sidebar_open}
                    disabled={layout.restore_last_layout}
                    onChange={(event) => onLayoutChange({ default_left_sidebar_open: event.target.checked })}
                  />
                </label>
                <label className="settings-toggle-row">
                  <span>
                    <b>默认打开右侧助手栏</b>
                    <small>仅在关闭“恢复上次退出布局”时作为启动默认值。</small>
                  </span>
                  <input
                    type="checkbox"
                    checked={layout.default_right_sidebar_open}
                    disabled={layout.restore_last_layout}
                    onChange={(event) => onLayoutChange({ default_right_sidebar_open: event.target.checked })}
                  />
                </label>
                <label className="settings-toggle-row">
                  <span>
                    <b>默认打开底部文件/命令栏</b>
                    <small>仅在关闭“恢复上次退出布局”时作为启动默认值。</small>
                  </span>
                  <input
                    type="checkbox"
                    checked={layout.default_bottom_panel_open}
                    disabled={layout.restore_last_layout}
                    onChange={(event) => onLayoutChange({ default_bottom_panel_open: event.target.checked })}
                  />
                </label>
              </section>
            </div>
          )}
          {cropRequest ? (
            <ImageCropDialog
              request={cropRequest}
              onCancel={() => setCropRequest(null)}
              onConfirm={(dataUrl) => {
                if (cropRequest.target === "splash") {
                  onLayoutChange({ splash_center_image_data_url: dataUrl });
                } else {
                  onLayoutChange({
                    terminal_background_image_data_url: dataUrl,
                    terminal_background_apply_workspace: true
                  });
                }
                setCropRequest(null);
              }}
            />
          ) : null}
        </div>
  );
}

function ImageCropDialog({
  request,
  onCancel,
  onConfirm
}: {
  request: ImageCropRequest;
  onCancel: () => void;
  onConfirm: (dataUrl: string) => void;
}) {
  const frameRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{ x: number; y: number; offsetX: number; offsetY: number } | null>(null);
  const [imageSize, setImageSize] = useState<{ width: number; height: number } | null>(null);
  const [frameSize, setFrameSize] = useState<{ width: number; height: number } | null>(null);
  const [zoom, setZoom] = useState(1);
  const [offset, setOffset] = useState({ x: 0, y: 0 });

  useEffect(() => {
    setImageSize(null);
    setZoom(1);
    setOffset({ x: 0, y: 0 });
    const image = new Image();
    image.onload = () => setImageSize({ width: image.naturalWidth, height: image.naturalHeight });
    image.src = request.sourceUrl;
  }, [request.sourceUrl]);

  useEffect(() => {
    const frame = frameRef.current;
    if (!frame) {
      return;
    }
    const rect = frame.getBoundingClientRect();
    setFrameSize({ width: rect.width, height: rect.height });
  }, [request.aspectRatio, imageSize]);

  const baseScale = imageSize && frameSize
    ? Math.max(frameSize.width / imageSize.width, frameSize.height / imageSize.height)
    : 1;
  const displayScale = baseScale * zoom;

  const clampOffset = useCallback((next: { x: number; y: number }) => {
    if (!imageSize || !frameSize) {
      return next;
    }
    const displayWidth = imageSize.width * displayScale;
    const displayHeight = imageSize.height * displayScale;
    const maxX = Math.max(0, (displayWidth - frameSize.width) / 2);
    const maxY = Math.max(0, (displayHeight - frameSize.height) / 2);
    return {
      x: clampNumber(next.x, -maxX, maxX),
      y: clampNumber(next.y, -maxY, maxY)
    };
  }, [displayScale, frameSize, imageSize]);

  useEffect(() => {
    setOffset((current) => clampOffset(current));
  }, [clampOffset, zoom]);

  const confirmCrop = useCallback(() => {
    if (!imageSize || !frameSize) {
      return;
    }
    const image = new Image();
    image.onload = () => {
      const scale = baseScale * zoom;
      const sourceWidth = frameSize.width / scale;
      const sourceHeight = frameSize.height / scale;
      const sourceX = imageSize.width / 2 - (frameSize.width / 2 + offset.x) / scale;
      const sourceY = imageSize.height / 2 - (frameSize.height / 2 + offset.y) / scale;
      const canvas = document.createElement("canvas");
      canvas.width = request.outputWidth;
      canvas.height = request.outputHeight;
      const context = canvas.getContext("2d");
      if (!context) {
        return;
      }
      context.drawImage(
        image,
        sourceX,
        sourceY,
        sourceWidth,
        sourceHeight,
        0,
        0,
        request.outputWidth,
        request.outputHeight
      );
      onConfirm(canvas.toDataURL("image/webp", 0.88));
    };
    image.src = request.sourceUrl;
  }, [baseScale, frameSize, imageSize, offset.x, offset.y, onConfirm, request.outputHeight, request.outputWidth, request.sourceUrl, zoom]);

  return (
    <div className="modal-backdrop image-crop-backdrop" role="presentation" onMouseDown={onCancel}>
      <section className="image-crop-dialog" role="dialog" aria-modal="true" aria-label={request.title} onMouseDown={(event) => event.stopPropagation()}>
        <header className="dialog-titlebar">
          <div>
            <Palette size={16} />
            <strong>{request.title}</strong>
          </div>
          <button className="dialog-close" onClick={onCancel} title="关闭">
            <X size={16} />
          </button>
        </header>
        <div className="image-crop-body">
          <div
            ref={frameRef}
            className={`image-crop-frame ${request.target === "splash" ? "splash" : "background"}`}
            style={{ aspectRatio: request.aspectRatio }}
            onPointerDown={(event) => {
              dragRef.current = { x: event.clientX, y: event.clientY, offsetX: offset.x, offsetY: offset.y };
              event.currentTarget.setPointerCapture(event.pointerId);
            }}
            onPointerMove={(event) => {
              const drag = dragRef.current;
              if (!drag) {
                return;
              }
              setOffset(clampOffset({
                x: drag.offsetX + event.clientX - drag.x,
                y: drag.offsetY + event.clientY - drag.y
              }));
            }}
            onPointerUp={(event) => {
              dragRef.current = null;
              event.currentTarget.releasePointerCapture(event.pointerId);
            }}
            onPointerCancel={() => {
              dragRef.current = null;
            }}
            onWheel={(event) => {
              event.preventDefault();
              const delta = event.deltaY < 0 ? 0.08 : -0.08;
              setZoom((current) => clampNumber(Number((current + delta).toFixed(2)), 1, 3));
            }}
          >
            {imageSize ? (
              <img
                src={request.sourceUrl}
                alt=""
                style={{
                  width: imageSize.width,
                  height: imageSize.height,
                  left: `calc(50% + ${offset.x}px)`,
                  top: `calc(50% + ${offset.y}px)`,
                  transform: `translate(-50%, -50%) scale(${displayScale})`
                }}
              />
            ) : null}
            <div className="crop-guide-lines" />
            {request.target === "splash" ? <div className="crop-circle-mask" /> : null}
          </div>
          <label className="crop-zoom-row">
            <span>缩放</span>
            <input
              type="range"
              min={1}
              max={3}
              step={0.01}
              value={zoom}
              onChange={(event) => setZoom(Number(event.target.value))}
            />
          </label>
          <p className="crop-hint">
            拖动定位，滚轮缩放。
          </p>
        </div>
        <footer className="dialog-actions">
          <button className="secondary-button" onClick={onCancel}>取消</button>
          <button className="save-button" onClick={confirmCrop} disabled={!imageSize}>应用裁剪</button>
        </footer>
      </section>
    </div>
  );
}
