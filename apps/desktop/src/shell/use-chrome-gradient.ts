import {
  currentMonitor,
  getCurrentWindow,
  type Monitor,
  type PhysicalPosition,
  type PhysicalSize
} from "@tauri-apps/api/window";
import { useEffect, useRef } from "react";
import { isDesktopRuntime } from "../platform/desktop-client";
import type { ChromeGradientPreset } from "../types";
import { applySidebarFallbackGradient, applySidebarPositionGradient } from "./chrome-gradient";

export function useChromeGradient(preset: ChromeGradientPreset) {
  const presetRef = useRef<ChromeGradientPreset>(preset);

  useEffect(() => {
    if (!isDesktopRuntime) {
      applySidebarFallbackGradient(presetRef.current);
      return;
    }

    let unlisten: (() => void) | undefined;
    let unlistenResize: (() => void) | undefined;
    let monitor: Monitor | null = null;
    let windowSize: PhysicalSize | null = null;
    let windowPosition: PhysicalPosition | null = null;
    let rafId: number | undefined;
    let disposed = false;

    const syncGradient = async () => {
      try {
        const appWindow = getCurrentWindow();
        monitor = await currentMonitor();
        const [position, size] = await Promise.all([appWindow.outerPosition(), appWindow.outerSize()]);
        if (!disposed) {
          windowPosition = position;
          windowSize = size;
          applySidebarPositionGradient(position, monitor, size, presetRef.current);
        }
      } catch {
        if (!disposed) {
          applySidebarFallbackGradient(presetRef.current);
        }
      }
    };

    const scheduleSync = () => {
      if (disposed || rafId !== undefined) {
        return;
      }
      rafId = window.requestAnimationFrame(() => {
        rafId = undefined;
        void syncGradient();
      });
    };

    scheduleSync();
    void getCurrentWindow().onMoved(({ payload }) => {
      windowPosition = payload;
      scheduleSync();
    }).then((dispose) => {
      unlisten = dispose;
    });
    void getCurrentWindow().onResized(({ payload }) => {
      windowSize = payload;
      scheduleSync();
    }).then((dispose) => {
      unlistenResize = dispose;
    });

    return () => {
      disposed = true;
      unlisten?.();
      unlistenResize?.();
      if (rafId !== undefined) {
        window.cancelAnimationFrame(rafId);
      }
    };
  }, []);

  useEffect(() => {
    presetRef.current = preset;
    if (!isDesktopRuntime) {
      applySidebarFallbackGradient(preset);
      return;
    }
    void getCurrentWindow().outerPosition()
      .then((position) =>
        Promise.all([currentMonitor(), getCurrentWindow().outerSize()]).then(([monitor, size]) => {
          applySidebarPositionGradient(position, monitor, size, preset);
        })
      )
      .catch(() => {
        applySidebarFallbackGradient(preset);
      });
  }, [preset]);
}
