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

/**
 * `initialRemainingMs` is computed ONCE on the server (in the rain chip's
 * server component, `endsAt − Date.now()` at request time) and serialized
 * down. The first client
 * paint renders from that SAME number, so it is byte-identical to the SSR
 * markup — no hydration mismatch. Reading `Date.now()` during render instead
 * (the previous approach) made the server tick and the first client tick
 * disagree by a second, which React surfaces as a recoverable hydration error
 * (minified #418) in production even with `suppressHydrationWarning`. The
 * post-mount effect re-syncs to the live clock and starts the 1s tick.
 */
export function RainCountdown({
  endsAt,
  initialRemainingMs,
}: {
  endsAt: string;
  initialRemainingMs: number;
}) {
  const target = new Date(endsAt).getTime();
  const [remaining, setRemaining] = useState(initialRemainingMs);

  useEffect(() => {
    setRemaining(target - Date.now());
    const id = setInterval(() => setRemaining(target - Date.now()), 1000);
    return () => clearInterval(id);
  }, [target]);

  return <span className="tabular-nums">{format(remaining)}</span>;
}
