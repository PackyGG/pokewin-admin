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

/** One row for the ladder-order check: identity + value + displayed chance. */
export type LadderRow = {
  cardId: string;
  name: string;
  value: number;
  /** The chance the row DISPLAYS (percent). */
  pct: number;
  /** Owner-pinned — the lever the one-click remedy can release. */
  pinned: boolean;
};

/**
 * One "a pricier card is more common than a cheaper card" inversion — the
 * shape the owner reads as "the %s aren't sorted right".
 */
export type LadderInversion = {
  /** The pricier card that ended up MORE common. */
  rich: LadderRow;
  /** The cheaper card it out-commons. */
  poor: LadderRow;
  /**
   * The pinned card whose pin FORCES this inversion, if one exists — releasing
   * it lets the ladder re-sort. This is the cheaper card when IT is pinned too
   * low (the 50/50 Menace case: Mewtwo pinned under a pricier free winner), or
   * the pricier card when IT is pinned too high. Null ⇒ the inversion is not
   * pin-caused (a deliberate win-band shape) and there is no one-click fix.
   */
  unpinTarget: LadderRow | null;
};

/**
 * Find every place the DISPLAYED ladder puts a pricier card at a higher chance
 * than a strictly-cheaper card — the monotone-order break the owner sees as
 * unsorted percentages.
 *
 * This is a PURE DISPLAY check over the numbers already on screen. It does NOT
 * touch the solver, EV, or the write — the engine's own LAW M deliberately
 * exempts pinned cards (they are sovereign), so an owner pin can legitimately
 * create this order break. The point here is to make that break VISIBLE before
 * a push (the engine's "never ship a silent zigzag" promise, extended to the
 * one case it can't enforce), and to name the pin that can release it.
 *
 * Walks value-ascending and, per card, compares its share to the smallest
 * share seen among strictly-cheaper cards; a card richer than that minimum is
 * an inversion. `tol` (default 0.05pp) ignores rounding-scale wobble so two
 * cards a hair apart never trip it.
 */
export function findLadderInversions(
  rows: readonly LadderRow[],
  tol = 0.05,
): LadderInversion[] {
  const live = rows
    .filter((r) => Number.isFinite(r.value) && r.value > 0 && Number.isFinite(r.pct) && r.pct > 0)
    .slice()
    .sort((a, b) => a.value - b.value);

  const out: LadderInversion[] = [];
  let minCheaper: LadderRow | null = null;
  let g = 0;
  while (g < live.length) {
    // Group equal-value cards — no constraint applies WITHIN a value tie.
    let h = g;
    while (h < live.length && live[h]!.value - live[g]!.value <= 1e-9) h += 1;
    if (minCheaper !== null) {
      for (let i = g; i < h; i++) {
        const rich = live[i]!;
        if (rich.pct > minCheaper.pct + tol) {
          // Prefer releasing the CHEAPER pinned card (raising it re-sorts the
          // pair); else the pricier one if IT is the pin; else no one-click.
          const unpinTarget = minCheaper.pinned
            ? minCheaper
            : rich.pinned
              ? rich
              : null;
          out.push({ rich, poor: minCheaper, unpinTarget });
        }
      }
    }
    for (let i = g; i < h; i++) {
      if (minCheaper === null || live[i]!.pct < minCheaper.pct) minCheaper = live[i]!;
    }
    g = h;
  }
  return out;
}
