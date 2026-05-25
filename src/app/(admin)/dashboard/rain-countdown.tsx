"use client";

import { useEffect, useState } from "react";

/**
 * Live "time remaining" for the Active Rain chip. Ticks every second from
 * the rain's end time. Renders "M:SS" (or "H:MM:SS" when over an hour) and
 * "ending…" once it hits zero. The dashboard re-renders on its 60s tick so
 * a fresh endsAt arrives between rains; this just animates the seconds in
 * between.
 */
function format(ms: number): string {
  if (ms <= 0) return "ending…";
  const total = Math.floor(ms / 1000);
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  const mm = String(m).padStart(2, "0");
  const ss = String(s).padStart(2, "0");
  return h > 0 ? `${h}:${mm}:${ss}` : `${m}:${ss}`;
}

export function RainCountdown({ endsAt }: { endsAt: string }) {
  const target = new Date(endsAt).getTime();
  const [remaining, setRemaining] = useState(() => target - Date.now());

  useEffect(() => {
    setRemaining(target - Date.now());
    const id = setInterval(() => setRemaining(target - Date.now()), 1000);
    return () => clearInterval(id);
  }, [target]);

  // suppressHydrationWarning: the value is clock-derived, so the server-
  // rendered tick and the first client tick can differ by a second.
  return (
    <span className="tabular-nums" suppressHydrationWarning>
      {format(remaining)}
    </span>
  );
}
