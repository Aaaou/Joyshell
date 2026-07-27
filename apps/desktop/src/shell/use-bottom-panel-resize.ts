import type { KeyboardEvent, PointerEvent } from "react";
import { useCallback, useEffect, useRef, useState } from "react";

export const BOTTOM_PANEL_MIN_HEIGHT = 120;
export const BOTTOM_PANEL_MAX_HEIGHT = 390;
const KEYBOARD_RESIZE_STEP = 20;

export function clampBottomPanelHeight(height: number | null | undefined) {
  const candidate = Number.isFinite(height) ? Number(height) : BOTTOM_PANEL_MAX_HEIGHT;
  return Math.round(Math.min(BOTTOM_PANEL_MAX_HEIGHT, Math.max(BOTTOM_PANEL_MIN_HEIGHT, candidate)));
}

export function useBottomPanelResize({
  height,
  onHeightChange,
  onHeightCommit,
  onCollapse
}: {
  height: number;
  onHeightChange: (height: number) => void;
  onHeightCommit: (height: number) => void;
  onCollapse: () => void;
}) {
  const dragRef = useRef<{
    pointerId: number;
    startY: number;
    startHeight: number;
    latestHeight: number;
  } | null>(null);
  const [isResizing, setIsResizing] = useState(false);

  const finishResize = useCallback(() => {
    const drag = dragRef.current;
    if (!drag) {
      return;
    }
    dragRef.current = null;
    setIsResizing(false);
    document.documentElement.classList.remove("bottom-panel-resizing");
    onHeightCommit(drag.latestHeight);
  }, [onHeightCommit]);

  useEffect(() => () => {
    document.documentElement.classList.remove("bottom-panel-resizing");
  }, []);

  const onPointerDown = useCallback((event: PointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) {
      return;
    }
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    const startHeight = clampBottomPanelHeight(height);
    dragRef.current = {
      pointerId: event.pointerId,
      startY: event.clientY,
      startHeight,
      latestHeight: startHeight
    };
    setIsResizing(true);
    document.documentElement.classList.add("bottom-panel-resizing");
  }, [height]);

  const onPointerMove = useCallback((event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }
    event.preventDefault();
    const nextHeight = clampBottomPanelHeight(drag.startHeight + drag.startY - event.clientY);
    drag.latestHeight = nextHeight;
    onHeightChange(nextHeight);
  }, [onHeightChange]);

  const onPointerEnd = useCallback((event: PointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    if (!drag || drag.pointerId !== event.pointerId) {
      return;
    }
    if (event.type === "pointercancel") {
      finishResize();
      return;
    }
    const rawFinalHeight = drag.startHeight + drag.startY - event.clientY;
    if (rawFinalHeight < BOTTOM_PANEL_MIN_HEIGHT) {
      dragRef.current = null;
      setIsResizing(false);
      document.documentElement.classList.remove("bottom-panel-resizing");
      onHeightChange(drag.startHeight);
      onCollapse();
      return;
    }
    const finalHeight = clampBottomPanelHeight(rawFinalHeight);
    drag.latestHeight = finalHeight;
    onHeightChange(finalHeight);
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    finishResize();
  }, [finishResize, onCollapse, onHeightChange]);

  const onKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    let nextHeight: number | null = null;
    if (event.key === "ArrowUp") {
      nextHeight = height + KEYBOARD_RESIZE_STEP;
    } else if (event.key === "ArrowDown") {
      nextHeight = height - KEYBOARD_RESIZE_STEP;
    } else if (event.key === "Home") {
      nextHeight = BOTTOM_PANEL_MIN_HEIGHT;
    } else if (event.key === "End") {
      nextHeight = BOTTOM_PANEL_MAX_HEIGHT;
    }
    if (nextHeight === null) {
      return;
    }
    event.preventDefault();
    if (nextHeight < BOTTOM_PANEL_MIN_HEIGHT) {
      onCollapse();
      return;
    }
    onHeightCommit(clampBottomPanelHeight(nextHeight));
  }, [height, onCollapse, onHeightCommit]);

  return {
    isResizing,
    handleProps: {
      onPointerDown,
      onPointerMove,
      onPointerUp: onPointerEnd,
      onPointerCancel: onPointerEnd,
      onKeyDown
    }
  };
}
