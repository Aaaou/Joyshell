import { useEffect, useState } from "react";

export function useTransferClock(hasActiveTransfer: boolean) {
  const [clockNow, setClockNow] = useState(() => Date.now());

  useEffect(() => {
    if (!hasActiveTransfer) {
      return;
    }
    const timer = window.setInterval(() => setClockNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, [hasActiveTransfer]);

  return clockNow;
}
