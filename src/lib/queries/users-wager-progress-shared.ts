/**
 * Plain (NON server-only) wager-requirement view types + pure projection.
 *
 * This module deliberately carries NO `import "server-only"` and NO DB /
 * backend-api imports, so a CLIENT component (the transaction-detail popup,
 * the deposits/withdrawals table) can value-import `toWagerRequirementSummary`
 * + the `WagerRequirementSummary` type without dragging the database client and
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
 * only need the headline withdrawal-gate status (e.g. the transaction-detail
 * popup on a deposit/withdrawal row). All-primitive so it crosses the
 * RSC → client boundary with no function props.
 *
 * Frozen-rate debt model (backend rework 2026-06-14): the gate is a PARTIAL
 * lock — `remainingUsd` (= `balances.wager_requirement_remaining`) reserves
 * that many balance dollars and `withdrawableUsd = max(0, available −
 * remaining)` is free to leave. `met` ⇔ remaining ≤ 0 (or exempt).
 */
export type WagerRequirementSummary = {
  /** Lifetime weighted wager cleared (informational). */
  completedUsd: number;
  /** completed + remaining (informational "progress + still-owed"). */
  requiredUsd: number;
  /** Authoritative locked debt that gates withdrawal (0 when exempt). */
  remainingUsd: number;
  /** Authoritative withdrawable-now = max(0, available − remaining). */
  withdrawableUsd: number;
  /** Current available balance (backend truth). */
  availableBalanceUsd: number;
  /** completed / required × 100, clamped 0..100; null only when there is no
   *  requirement total at all (completed = remaining = 0). */
  pct: number | null;
  /** True when the user is fully exempt (per-user override = 0). */
  exempt: boolean;
  /** True when the requirement is satisfied (remaining ≤ 0) or exempt. */
  met: boolean;
  /** Whether the backend bps config was reachable (gates the informational
   *  per-source weights only — the figures above are column-authoritative). */
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
  const {
    completedUsd,
    requiredUsd,
    remainingUsd,
    withdrawableUsd,
    availableBalanceUsd,
    exempt,
    met,
    backendAvailable,
  } = data;
  const pct =
    requiredUsd > 0
      ? Math.min(100, Math.max(0, (completedUsd / requiredUsd) * 100))
      : 100; // nothing required → trivially complete
  return {
    completedUsd,
    requiredUsd,
    remainingUsd,
    withdrawableUsd,
    availableBalanceUsd,
    pct,
    exempt,
    met,
    backendAvailable,
  };
}
