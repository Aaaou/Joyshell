import { MonitorCog } from "lucide-react";

export function OperatingSystemIcon({ symbolId }: { symbolId: string | null }) {
  if (!symbolId) {
    return <MonitorCog className="operating-system-fallback" aria-hidden="true" />;
  }

  return (
    <svg className="operating-system-icon" aria-hidden="true">
      <use href={`#${symbolId}`} />
    </svg>
  );
}
