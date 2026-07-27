import { getCurrentWindow } from "@tauri-apps/api/window";
import { useCallback, useEffect, useState } from "react";
import { isDesktopRuntime } from "../platform/desktop-client";

export function useWindowControls(flash: (message: string) => void) {
  const [windowMaximized, setWindowMaximized] = useState(false);

  useEffect(() => {
    if (!isDesktopRuntime) {
      return;
    }
    let unlistenResize: (() => void) | undefined;
    let disposed = false;
    const syncMaximizedState = () => {
      const appWindow = getCurrentWindow();
      void appWindow.isMaximized().then((maximized) => {
        if (!disposed) {
          setWindowMaximized(maximized);
        }
      }).catch(() => {
        if (!disposed) {
          setWindowMaximized(false);
        }
      });
    };
    syncMaximizedState();
    void getCurrentWindow().onResized(() => {
      syncMaximizedState();
    }).then((dispose) => {
      unlistenResize = dispose;
    });
    return () => {
      disposed = true;
      unlistenResize?.();
    };
  }, []);

  const minimizeWindow = useCallback(() => {
    if (!isDesktopRuntime) {
      flash("Desktop window controls are available in the packaged app.");
      return;
    }
    void getCurrentWindow().minimize();
  }, [flash]);

  const toggleMaximizeWindow = useCallback(() => {
    if (!isDesktopRuntime) {
      flash("Desktop window controls are available in the packaged app.");
      return;
    }
    const appWindow = getCurrentWindow();
    void appWindow.toggleMaximize()
      .then(() => appWindow.isMaximized())
      .then(setWindowMaximized)
      .catch(() => setWindowMaximized(false));
  }, [flash]);

  const closeWindow = useCallback(() => {
    if (!isDesktopRuntime) {
      flash("Desktop window controls are available in the packaged app.");
      return;
    }
    void getCurrentWindow().close();
  }, [flash]);

  return { windowMaximized, minimizeWindow, toggleMaximizeWindow, closeWindow };
}
