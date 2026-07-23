/**
 * Client-side "clean ladder" grid + ticket math for hand-typed odds displays
 * (Retune workspace pool table / totals strip).
 *
 * The human step grid MIRRORS `pinStepPct` in
 * `src/app/(admin)/insights/edge-calc/tag-guidance.ts` — kept as a deliberate
 * copy: importing tag-guidance here would pull the server-side solver module
 * into the client bundle. If the server grid changes, change BOTH.
 *
 * Tickets: the game writes integer per-card ticket weights on a 100,000 grid
 * (0.001% = 1 ticket), so a percent maps to `round(pct * 1000)` tickets. All
 * pcts here are percentage values (0.0075 ⇒ 0.0075%), NOT 0..1 fractions.
 * Pure module — no React, no side effects.
 */

/** Human step grid for a typed percentage (mirror of `pinStepPct`). */
function oddsGridStepPct(pct: number): number {
  if (pct >= 20) return 0.5;
  if (pct >= 5) return 0.25;
  if (pct >= 1) return 0.05;
  if (pct >= 0.1) return 0.01;
  return 0.001;
}

/** The nearest on-grid value for `pct` (its own band's step). */
function nearestGridPct(pct: number): number {
  if (!Number.isFinite(pct) || pct <= 0) return 0;
  const step = oddsGridStepPct(pct);
  return Number((Math.round(pct / step) * step).toFixed(6));
}

/** True when `pct` sits exactly ON its band's grid step (float-noise safe). */
export function isOnOddsGrid(pct: number): boolean {
  if (!Number.isFinite(pct) || pct <= 0) return false;
  return Math.abs(pct - nearestGridPct(pct)) < 1e-9;
}

/** Title/tooltip body for an off-grid value, with the nearest clean rung. */
export function offGridTitle(pct: number): string {
  return `off the clean ladder (nearest: ${nearestGridPct(pct)}%)`;
}

/** The whole-pack ticket pool the game draws from. */
export const TICKETS_PER_PACK = 100_000;

/** Integer tickets per 100k a percent means (0.001% = 1 ticket). */
export function ticketsFromPct(pct: number): number {
  if (!Number.isFinite(pct) || pct <= 0) return 0;
  return Math.round(pct * 1000);
}

/**
 * True when `pct` lands on a WHOLE ticket (pct·1000 is an integer within
 * float noise) — a fractional-ticket value can't be written as typed, so the
 * displayed rounded tickets must never claim an OK state over one.
 */
export function isWholeTicketPct(pct: number): boolean {
  if (!Number.isFinite(pct) || pct <= 0) return false;
  const raw = pct * 1000;
  return Math.abs(raw - Math.round(raw)) < 1e-6;
}

/** "1 in N opens" (N = 100000/tickets, 1 decimal, trailing .0 trimmed). */
export function oneInOpensLabel(tickets: number): string {
  if (tickets <= 0) return "0 tickets — this chance can't land in the 100k draw";
  const n = (TICKETS_PER_PACK / tickets).toFixed(1);
  return `1 in ${n.endsWith(".0") ? n.slice(0, -2) : n} opens`;
}
