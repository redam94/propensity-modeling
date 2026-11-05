import { useEffect, useState } from "react";

/** Re-render every second while `active` so elapsed timers tick between polls. */
export function useTicker(active: boolean) {
  const [, set] = useState(0);
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => set((n) => n + 1), 1000);
    return () => clearInterval(id);
  }, [active]);
}
