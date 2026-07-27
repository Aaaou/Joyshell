import { useEffect, useState } from "react";

export function useSplashLifecycle() {
  const [splashVisible, setSplashVisible] = useState(true);
  const [splashClosing, setSplashClosing] = useState(false);

  useEffect(() => {
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const showTimer = window.setTimeout(() => setSplashClosing(true), reduceMotion ? 500 : 4200);
    const hideTimer = window.setTimeout(() => setSplashVisible(false), reduceMotion ? 760 : 4700);
    return () => {
      window.clearTimeout(showTimer);
      window.clearTimeout(hideTimer);
    };
  }, []);

  return { splashVisible, splashClosing };
}
