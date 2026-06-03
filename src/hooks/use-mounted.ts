import * as React from "react";

/**
 * `false` on the server render AND on the first client render (the paint that
 * must hydrate byte-identically to the SSR markup), then flips to `true` in a
 * post-mount effect.
 *
 * Use this to gate any value that is computed differently on the server vs the
 * client during render — most commonly a CLOCK-derived string
 * (`formatRelative`, a live countdown, anything reading `Date.now()` /
 * `new Date()` at render time). The server formats against the server clock and
 * the client re-formats against the client clock a moment later, so the two
 * renders disagree → React throws a hydration mismatch (minified #418 in
 * production). `suppressHydrationWarning` only silences the dev *warning*; the
 * recoverable error is still surfaced in prod, so it is NOT a reliable fix.
 *
 * The correct pattern: render a DETERMINISTIC value while `mounted === false`
 * (a fixed placeholder, or an absolute timestamp serialized from the server),
 * and switch to the live/clock-derived value only once `mounted === true`. The
 * first client paint then matches SSR exactly; the live value appears one tick
 * later with no mismatch.
 */
export function useMounted(): boolean {
  const [mounted, setMounted] = React.useState(false);
  React.useEffect(() => {
    setMounted(true);
  }, []);
  return mounted;
}
