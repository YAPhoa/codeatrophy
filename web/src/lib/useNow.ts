import { useEffect, useState } from 'react';

/** A clock for elapsed times: the time now, updated every second while `ticking`. */
export function useNow(ticking = true): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!ticking) return;
    setNow(Date.now());
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [ticking]);
  return now;
}
