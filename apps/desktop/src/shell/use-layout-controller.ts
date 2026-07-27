import { useCallback, useState } from "react";
import { desktopClient } from "../platform/desktop-client";
import type { LayoutSettings } from "../types";
import { resolveStartupLayout } from "../features/sessions/session-model";
import { clampBottomPanelHeight } from "./use-bottom-panel-resize";

const initialLayoutSettings: LayoutSettings = {
  restore_last_layout: false,
  default_left_sidebar_open: true,
  default_right_sidebar_open: true,
  default_bottom_panel_open: true,
  last_left_sidebar_open: true,
  last_right_sidebar_open: true,
  last_bottom_panel_open: true,
  use_icmp_latency_probe: false,
  skip_delete_confirmations: false,
  splash_center_image_data_url: null,
  terminal_background_image_data_url: null,
  terminal_background_opacity: 35,
  terminal_background_apply_workspace: true,
  terminal_background_apply_home: false,
  chrome_gradient_preset: "codex_cyan",
  bottom_panel_height: 390,
  connected_profile_double_click_action: "open_earliest"
};

export function useLayoutController(flash: (message: string) => void) {
  const [assistantOpen, setAssistantOpen] = useState(true);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const [bottomPanelOpen, setBottomPanelOpen] = useState(true);
  const [bottomPanelHeight, setBottomPanelHeight] = useState(390);
  const [layoutSettings, setLayoutSettings] = useState<LayoutSettings>(initialLayoutSettings);

  const persistLayout = useCallback((next: LayoutSettings) => {
    void desktopClient.saveLayoutSettings(next).catch((error) => {
      const message = error instanceof Error ? error.message : String(error);
      flash(`Failed to save layout settings: ${message}`);
    });
  }, [flash]);

  const applyLoadedLayout = useCallback((settings: LayoutSettings) => {
    setLayoutSettings(settings);
    const effectiveLayout = resolveStartupLayout(settings);
    setSidebarCollapsed(!effectiveLayout.leftSidebarOpen);
    setAssistantOpen(effectiveLayout.rightSidebarOpen);
    setBottomPanelOpen(effectiveLayout.bottomPanelOpen);
    setBottomPanelHeight(clampBottomPanelHeight(settings.bottom_panel_height));
  }, []);

  const saveLayoutPreference = useCallback((patch: Partial<LayoutSettings>) => {
    setLayoutSettings((current) => {
      const next = { ...current, ...patch };
      persistLayout(next);
      return next;
    });
  }, [persistLayout]);

  const setLeftSidebarOpen = useCallback((open: boolean) => {
    setSidebarCollapsed(!open);
    if (layoutSettings.restore_last_layout) {
      saveLayoutPreference({ last_left_sidebar_open: open });
    }
  }, [layoutSettings.restore_last_layout, saveLayoutPreference]);

  const setRightSidebarOpen = useCallback((open: boolean) => {
    setAssistantOpen(open);
    if (layoutSettings.restore_last_layout) {
      saveLayoutPreference({ last_right_sidebar_open: open });
    }
  }, [layoutSettings.restore_last_layout, saveLayoutPreference]);

  const setBottomPanelPreferenceOpen = useCallback((open: boolean) => {
    setBottomPanelOpen(open);
    if (layoutSettings.restore_last_layout) {
      saveLayoutPreference({ last_bottom_panel_open: open });
    }
  }, [layoutSettings.restore_last_layout, saveLayoutPreference]);

  const previewBottomPanelHeight = useCallback((height: number) => {
    setBottomPanelHeight(clampBottomPanelHeight(height));
  }, []);

  const commitBottomPanelHeight = useCallback((height: number) => {
    const nextHeight = clampBottomPanelHeight(height);
    setBottomPanelHeight(nextHeight);
    saveLayoutPreference({ bottom_panel_height: nextHeight });
  }, [saveLayoutPreference]);

  const updateLayoutSettings = useCallback((patch: Partial<LayoutSettings>) => {
    const nextPatch = patch.restore_last_layout
      ? {
          ...patch,
          last_left_sidebar_open: !sidebarCollapsed,
          last_right_sidebar_open: assistantOpen,
          last_bottom_panel_open: bottomPanelOpen
        }
      : patch;
    setLayoutSettings((current) => {
      const next = { ...current, ...nextPatch };
      persistLayout(next);
      return next;
    });
  }, [assistantOpen, bottomPanelOpen, persistLayout, sidebarCollapsed]);

  return {
    state: { assistantOpen, sidebarCollapsed, bottomPanelOpen, bottomPanelHeight, layoutSettings },
    actions: {
      applyLoadedLayout,
      setLeftSidebarOpen,
      setRightSidebarOpen,
      setBottomPanelPreferenceOpen,
      previewBottomPanelHeight,
      commitBottomPanelHeight,
      updateLayoutSettings
    }
  };
}
