import { useEffect, useState } from "react";

/**
 * `Date.now()`, re-read every `intervalMs` while `enabled` (elapsed-time
 * counters). Disabled, it returns the time of the last render that read it
 * and schedules nothing.
 */
export function useNow(intervalMs: number, enabled = true): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!enabled) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), intervalMs);
    return () => clearInterval(timer);
  }, [enabled, intervalMs]);
  return now;
}
