/**
 * Plain (NON server-only) wager-requirement view types + pure projection.
 *
 * This module deliberately carries NO `import "server-only"` and NO DB /
 * backend-api imports, so a CLIENT component (the transaction-detail popup,
 * the deposits/withdrawals table) can value-import `toWagerRequirementSummary`
 * + the `WagerRequirementSummary` type without dragging the Prisma client and
 * the server-only `users-wager-progress.ts` module graph into the client
 * bundle (which breaks `next build` — see the crypto-fees-assets precedent in
 * CLAUDE.md / AGENT_HANDOFF "Crypto deposit/withdrawal exchange-rate fee").
 *
 * The heavy read (`getUserWagerProgress`) stays in `users-wager-progress.ts`
 * and produces a `UserWagerProgress`; this file only projects that already-
 * resolved object down to the compact popup summary. Pure, no I/O.
 */

import type { UserWagerProgress } from "./users-wager-progress";

/**
 * Compact, fully-serializable subset of `UserWagerProgress` for places that
 * only need the headline "filled $X of $Y required — Z% complete" status
 * (e.g. the transaction-detail popup on a deposit/withdrawal row). All-
 * primitive so it crosses the RSC → client boundary with no function props.
 *
 * `requiredUsd` / `remainingUsd` / `pct` are null when the backend bps config
 * was unreachable (we then show only the backend-truth `completedUsd`).
 */
export type WagerRequirementSummary = {
  completedUsd: number;
  requiredUsd: number | null;
  remainingUsd: number | null;
  /** completed / required × 100, clamped 0..100; null when no requirement total. */
  pct: number | null;
  /** True when the user is fully exempt (per-user override = 0). */
  exempt: boolean;
  /** True when the (non-exempt) user has met the full requirement. */
  met: boolean;
  /** Whether the backend bps config was reachable (gates required/remaining). */
  backendAvailable: boolean;
};

/**
 * Project a `UserWagerProgress` (or null) down to the compact
 * `WagerRequirementSummary` used by the transaction-detail popup. Pure, no
 * I/O — safe to call in a server component after the progress promise
 * resolves (the result is then passed as a plain prop to the client modal).
 */
export function toWagerRequirementSummary(
  data: UserWagerProgress | null,
): WagerRequirementSummary | null {
  if (!data) return null;
  const { completedUsd, requiredUsd, remainingUsd, exempt, backendAvailable } =
    data;
  const pct =
    requiredUsd && requiredUsd > 0
      ? Math.min(100, Math.max(0, (completedUsd / requiredUsd) * 100))
      : exempt || (requiredUsd != null && requiredUsd <= 0)
        ? 100
        : null;
  const met = !exempt && remainingUsd != null && remainingUsd <= 0;
  return {
    completedUsd,
    requiredUsd,
    remainingUsd,
    pct,
    exempt,
    met,
    backendAvailable,
  };
}
