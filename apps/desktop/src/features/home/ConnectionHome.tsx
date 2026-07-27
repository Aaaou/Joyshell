import { Plus, Server } from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import type { SessionProfile } from "../../types";
import { OperatingSystemIcon } from "../../ui/OperatingSystemIcon";
import { resolveProfileOperatingSystem } from "../sessions/session-model";

export function ConnectionHome({
  profiles,
  activeProfileId,
  onAdd,
  onSelect,
  onConnect
}: {
  profiles: SessionProfile[];
  activeProfileId: string | null;
  onAdd: () => void;
  onSelect: (profile: SessionProfile) => void;
  onConnect: (profile: SessionProfile) => void;
}) {
  const HOME_ORBIT_ITEM_WIDTH = 136;
  const homeRef = useRef<HTMLDivElement | null>(null);
  const stripRef = useRef<HTMLDivElement | null>(null);
  const [selectedIndex, setSelectedIndex] = useState(() => Math.max(0, profiles.findIndex((profile) => profile.id === activeProfileId)));
  const loopPad = profiles.length > 1 ? profiles.length : 0;
  const loopCopyCount = loopPad ? Math.max(7, Math.ceil(12 / profiles.length) | 1) : 1;
  const middleLoopCopy = Math.floor(loopCopyCount / 2);
  const [highlightedOrbitIndex, setHighlightedOrbitIndex] = useState(() => middleLoopCopy * profiles.length + selectedIndex);
  const selectedIndexRef = useRef(selectedIndex);
  const highlightedOrbitIndexRef = useRef(highlightedOrbitIndex);
  const dragStateRef = useRef<{ startX: number; startY: number; lastX: number; lastAt: number; velocity: number; dragging: boolean } | null>(null);
  const tapHandledRef = useRef(false);
  const scrollSelectionRafRef = useRef<number | null>(null);
  const orbitMomentumRafRef = useRef<number | null>(null);
  const orbitMomentumLastAtRef = useRef(0);
  const visibleProfiles = loopPad
    ? Array.from({ length: loopCopyCount }, () => profiles).flat()
    : profiles;

  const normalizeScrollPosition = useCallback(() => {
    const strip = stripRef.current;
    if (!strip || !loopPad) {
      return;
    }
    const loopWidth = profiles.length * HOME_ORBIT_ITEM_WIDTH;
    if (loopWidth <= 0) {
      return;
    }
    const loopOffset = middleLoopCopy * loopWidth;
    if (strip.scrollLeft < loopOffset - loopWidth * 0.5) {
      strip.scrollLeft += loopWidth;
    } else if (strip.scrollLeft > loopOffset + loopWidth * 0.5) {
      strip.scrollLeft -= loopWidth;
    }
  }, [loopPad, middleLoopCopy, profiles.length]);

  const scrollProfileIntoView = useCallback((index: number, behavior: ScrollBehavior = "smooth") => {
    const strip = stripRef.current;
    if (!strip || profiles.length === 0) {
      return;
    }
    const normalized = ((index % profiles.length) + profiles.length) % profiles.length;
    const targetOrbitIndex = loopPad ? middleLoopCopy * profiles.length + normalized : normalized;
    highlightedOrbitIndexRef.current = targetOrbitIndex;
    setHighlightedOrbitIndex(targetOrbitIndex);
    const targetLeft = targetOrbitIndex * HOME_ORBIT_ITEM_WIDTH - Math.max(0, (strip.clientWidth - HOME_ORBIT_ITEM_WIDTH) / 2);
    strip.scrollTo({ left: Math.max(0, targetLeft), behavior });
  }, [loopPad, middleLoopCopy, profiles.length]);

  const stopOrbitMomentum = useCallback(() => {
    if (orbitMomentumRafRef.current !== null) {
      window.cancelAnimationFrame(orbitMomentumRafRef.current);
      orbitMomentumRafRef.current = null;
    }
  }, []);

  const startOrbitMomentum = useCallback((initialVelocity: number) => {
    const strip = stripRef.current;
    if (!strip || Math.abs(initialVelocity) < 0.04) {
      scrollProfileIntoView(selectedIndexRef.current);
      return;
    }
    stopOrbitMomentum();
    let velocity = Math.max(-2.4, Math.min(2.4, initialVelocity));
    orbitMomentumLastAtRef.current = performance.now();
    const step = (now: number) => {
      const currentStrip = stripRef.current;
      if (!currentStrip) {
        orbitMomentumRafRef.current = null;
        return;
      }
      const dt = Math.min(34, Math.max(1, now - orbitMomentumLastAtRef.current));
      orbitMomentumLastAtRef.current = now;
      currentStrip.scrollLeft += velocity * dt;
      normalizeScrollPosition();
      velocity *= Math.pow(0.925, dt / 16);
      if (Math.abs(velocity) < 0.035) {
        orbitMomentumRafRef.current = null;
        scrollProfileIntoView(selectedIndexRef.current);
        return;
      }
      orbitMomentumRafRef.current = window.requestAnimationFrame(step);
    };
    orbitMomentumRafRef.current = window.requestAnimationFrame(step);
  }, [normalizeScrollPosition, scrollProfileIntoView, stopOrbitMomentum]);

  useEffect(() => {
    selectedIndexRef.current = selectedIndex;
  }, [selectedIndex]);

  useEffect(() => {
    highlightedOrbitIndexRef.current = highlightedOrbitIndex;
  }, [highlightedOrbitIndex]);

  useEffect(() => () => {
    stopOrbitMomentum();
  }, [stopOrbitMomentum]);

  useEffect(() => {
    const strip = stripRef.current;
    if (!strip || !loopPad) {
      return;
    }
    scrollProfileIntoView(selectedIndex, "auto");
  }, [loopPad, profiles.length, scrollProfileIntoView]);

  useEffect(() => {
    const nextIndex = profiles.findIndex((profile) => profile.id === activeProfileId);
    if (nextIndex >= 0) {
      selectedIndexRef.current = nextIndex;
      setSelectedIndex(nextIndex);
      scrollProfileIntoView(nextIndex, "auto");
    }
  }, [activeProfileId, profiles, scrollProfileIntoView]);

  const handleLoopScroll = useCallback(() => {
    const strip = stripRef.current;
    if (!strip) {
      return;
    }
    normalizeScrollPosition();
    if (scrollSelectionRafRef.current !== null) {
      window.cancelAnimationFrame(scrollSelectionRafRef.current);
    }
    scrollSelectionRafRef.current = window.requestAnimationFrame(() => {
      scrollSelectionRafRef.current = null;
      if (profiles.length === 0) {
        return;
      }
      const center = strip.scrollLeft + strip.clientWidth / 2;
      const absoluteIndex = Math.round((center - HOME_ORBIT_ITEM_WIDTH / 2) / HOME_ORBIT_ITEM_WIDTH);
      const normalized = ((absoluteIndex % profiles.length) + profiles.length) % profiles.length;
      selectedIndexRef.current = normalized;
      highlightedOrbitIndexRef.current = absoluteIndex;
      setSelectedIndex((current) => current === normalized ? current : normalized);
      setHighlightedOrbitIndex((current) => current === absoluteIndex ? current : absoluteIndex);
    });
  }, [normalizeScrollPosition, profiles]);

  const moveProfileBy = useCallback((delta: number) => {
    if (profiles.length === 0) {
      return;
    }
    stopOrbitMomentum();
    const nextOrbitIndex = loopPad
      ? highlightedOrbitIndexRef.current + delta
      : selectedIndexRef.current + delta;
    const nextIndex = ((nextOrbitIndex % profiles.length) + profiles.length) % profiles.length;
    selectedIndexRef.current = nextIndex;
    highlightedOrbitIndexRef.current = loopPad ? nextOrbitIndex : nextIndex;
    setSelectedIndex(nextIndex);
    setHighlightedOrbitIndex(highlightedOrbitIndexRef.current);
    const strip = stripRef.current;
    if (strip && loopPad) {
      strip.scrollBy({ left: delta * HOME_ORBIT_ITEM_WIDTH, behavior: "smooth" });
      window.setTimeout(normalizeScrollPosition, 180);
      return;
    }
    scrollProfileIntoView(nextIndex);
  }, [loopPad, normalizeScrollPosition, profiles.length, scrollProfileIntoView, stopOrbitMomentum]);

  const handleHomeKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "ArrowLeft") {
      event.preventDefault();
      moveProfileBy(-1);
    } else if (event.key === "ArrowRight") {
      event.preventDefault();
      moveProfileBy(1);
    } else if (event.key === "Enter") {
      event.preventDefault();
      const profile = profiles[selectedIndexRef.current];
      if (profile) {
        onConnect(profile);
      }
    }
  }, [moveProfileBy, onConnect, profiles]);

  useEffect(() => {
    const handleWindowKeyDown = (event: KeyboardEvent) => {
      const target = event.target;
      if (
        target instanceof HTMLInputElement ||
        target instanceof HTMLTextAreaElement ||
        target instanceof HTMLSelectElement ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey
      ) {
        return;
      }
      if (event.key === "ArrowLeft") {
        event.preventDefault();
        moveProfileBy(-1);
      } else if (event.key === "ArrowRight") {
        event.preventDefault();
        moveProfileBy(1);
      }
    };
    window.addEventListener("keydown", handleWindowKeyDown);
    return () => {
      window.removeEventListener("keydown", handleWindowKeyDown);
    };
  }, [moveProfileBy]);

  const handlePointerDown = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const strip = stripRef.current;
    if (!strip) {
      return;
    }
    stopOrbitMomentum();
    tapHandledRef.current = false;
    homeRef.current?.focus();
    dragStateRef.current = { startX: event.clientX, startY: event.clientY, lastX: event.clientX, lastAt: performance.now(), velocity: 0, dragging: false };
    strip.setPointerCapture?.(event.pointerId);
  }, [stopOrbitMomentum]);

  const activateHomeProfile = useCallback((profile: SessionProfile, orbitIndex: number) => {
    const profileIndex = profiles.findIndex((item) => item.id === profile.id);
    if (profileIndex < 0) {
      return;
    }
    selectedIndexRef.current = profileIndex;
    highlightedOrbitIndexRef.current = orbitIndex;
    setSelectedIndex(profileIndex);
    setHighlightedOrbitIndex(orbitIndex);
    onSelect(profile);
    onConnect(profile);
    homeRef.current?.focus();
  }, [onConnect, onSelect, profiles]);

  const handlePointerMove = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    const strip = stripRef.current;
    const state = dragStateRef.current;
    if (!strip || !state) {
      return;
    }
    const now = performance.now();
    const dt = Math.max(1, now - state.lastAt);
    const delta = event.clientX - state.lastX;
    const scrollDelta = -delta;
    const totalMove = Math.hypot(event.clientX - state.startX, event.clientY - state.startY);
    if (totalMove > 8) {
      state.dragging = true;
    }
    strip.scrollLeft += scrollDelta;
    state.lastX = event.clientX;
    state.lastAt = now;
    state.velocity = scrollDelta / dt;
    normalizeScrollPosition();
  }, [normalizeScrollPosition]);

  const handlePointerUp = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    stripRef.current?.releasePointerCapture?.(event.pointerId);
    const dragState = dragStateRef.current;
    if (dragState?.dragging) {
      startOrbitMomentum(dragState.velocity);
    } else {
      const target = document.elementFromPoint(event.clientX, event.clientY);
      const item = target?.closest?.<HTMLElement>(".profile-orbit-item");
      const profileId = item?.dataset.profileId;
      const profileIndex = profileId ? profiles.findIndex((profile) => profile.id === profileId) : -1;
      if (profileIndex >= 0) {
        const orbitIndex = Number(item?.dataset.orbitIndex ?? profileIndex);
        tapHandledRef.current = true;
        activateHomeProfile(profiles[profileIndex], Number.isFinite(orbitIndex) ? orbitIndex : profileIndex);
      }
    }
    window.setTimeout(() => {
      dragStateRef.current = null;
      tapHandledRef.current = false;
    }, 0);
  }, [activateHomeProfile, profiles, startOrbitMomentum]);

  const handlePointerCancel = useCallback((event: React.PointerEvent<HTMLDivElement>) => {
    stripRef.current?.releasePointerCapture?.(event.pointerId);
    dragStateRef.current = null;
    tapHandledRef.current = false;
  }, []);

  if (profiles.length === 0) {
    return (
      <div className="connection-home empty">
        <div className="connection-home-inner">
          <div className="connection-home-icon">
            <Server size={34} />
          </div>
          <strong>添加第一台 SSH 服务器</strong>
          <span>Joyshell 会把服务器配置保存到本地 SQLite；密码暂不明文落盘。</span>
          <button className="primary-button" onClick={onAdd}>
            <Plus size={15} /> 添加服务器
          </button>
        </div>
      </div>
    );
  }

  return (
    <div ref={homeRef} className="connection-home" tabIndex={0} onKeyDownCapture={handleHomeKeyDown}>
      <button className="connection-home-add" title="添加服务器" onClick={onAdd}>
        <Plus size={24} />
      </button>
      <div
        ref={stripRef}
        className="profile-orbit-strip"
        aria-label="服务器快捷入口"
        onScroll={handleLoopScroll}
        onWheel={(event) => {
          event.preventDefault();
          stopOrbitMomentum();
          event.currentTarget.scrollLeft += event.deltaY || event.deltaX;
          handleLoopScroll();
        }}
        onPointerDown={handlePointerDown}
        onPointerMove={handlePointerMove}
        onPointerUp={handlePointerUp}
        onPointerCancel={handlePointerCancel}
      >
        {visibleProfiles.map((profile, index) => {
          const os = resolveProfileOperatingSystem(profile);
          const isSelected = index === highlightedOrbitIndex && profiles[selectedIndex]?.id === profile.id;
          return (
            <div
              role="button"
              tabIndex={-1}
              data-profile-id={profile.id}
              data-orbit-index={index}
              className={`profile-orbit-item ${os.tone} ${isSelected ? "selected" : ""}`}
              key={`${profile.id}-${index}`}
              title={`${profile.name}\n${profile.username}@${profile.host}:${profile.port}\n${profile.group ?? "未分组"}`}
              onClick={(event) => {
                if (tapHandledRef.current || dragStateRef.current?.dragging) {
                  event.preventDefault();
                  return;
                }
                activateHomeProfile(profile, index);
              }}
            >
              <span className="profile-orbit-icon" title={os.label}>
                <OperatingSystemIcon symbolId={os.symbolId} />
              </span>
              <small>{profile.name}</small>
            </div>
          );
        })}
      </div>
    </div>
  );
}
