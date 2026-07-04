/**
 * DISPLAY-RECONCILIATION harness for planned-odds vectors (pure, no DB).
 *
 * Run with:
 *   npx tsx "src/app/(admin)/packs/__checks__/odds-display.ts"
 *
 * Pins the display-layer fix for the retune workspace's planned-% column. The
 * WRITTEN odds are fair and untouched (per-card weight/Σweights → true pcts sum
 * to exactly 100 as a ratio identity — NOT re-litigated here). The bug this
 * suite guards is DISPLAY PRECISION: independent per-card rounding (≥1% at flat
 * 2dp, sub-1% at 4 sig-figs) makes the VISIBLE column sum to 100.005% / 99.99%
 * while the true pcts sum to 100, and a total-odds readout then stamps
 * "match 100%" while the column disagrees.
 *
 * `reconcileOddsForDisplay(pcts, decimals=4)` rounds the vector to the grid and
 * directs the WHOLE rounding residual into the largest-mass ("buffer") entry,
 * so the displayed vector sums to EXACTLY 100 at that precision. Contracts:
 *
 *   1.  EXACT-100: output sums to exactly 100 at `decimals` across many random
 *       + edge vectors — INCLUDING the 42.625 buffer case that renders as
 *       100.005% under the naive rule.
 *   2.  BUFFER CARRIES THE RESIDUAL: the entry that differs from its own
 *       independent rounding is the LARGEST-mass entry, and only it.
 *   3.  NON-BUFFER CLEAN VALUES UNCHANGED: every non-buffer entry equals its
 *       independent `toFixed(decimals)` rounding (no perturbation).
 *   4.  IDEMPOTENCE: a vector already on the grid (sum exactly 100) is returned
 *       unchanged; re-running the fn is a fixed point.
 *   5.  SUB-1% PRESERVED: a real 0.0075% jackpot is never collapsed; the buffer
 *       (largest) is never a tiny jackpot.
 *   6.  EDGE CASES: empty, single-element, NaN-guarded, negative-residual.
 *   7.  FORMATTER: `formatReconciledPct` trims trailing zeros (25 → "25%",
 *       42.625 → "42.625%", 0.075 → "0.075%") and keeps sub-1% precision.
 *
 * Exit code 0 = all passed; 1 = at least one failure (printed).
 */

import {
  formatReconciledPct,
  reconcileOddsForDisplay,
} from "../../../(pack-studio)/pack-studio/retune/_workspace/odds-display";

let passes = 0;
const failures: string[] = [];

function check(name: string, fn: () => void): void {
  try {
    fn();
    passes += 1;
    console.log(`PASS  ${name}`);
  } catch (err) {
    failures.push(name);
    console.error(`FAIL  ${name}`);
    console.error(`      ${err instanceof Error ? err.message : String(err)}`);
  }
}

function assert(cond: boolean, msg: string): asserts cond {
  if (!cond) throw new Error(msg);
}

/** Sum a vector at the same precision the display grid uses. */
function gridSum(v: readonly number[], decimals = 4): number {
  // Sum, then snap to the grid so we compare against exact 100 without float
  // accumulation noise across dozens of entries.
  let s = 0;
  for (const x of v) s += x;
  return Number(s.toFixed(decimals));
}

/** The naive independent per-card rounding (the buggy display rule's column). */
function naiveColumn(pcts: readonly number[], decimals = 4): number[] {
  return pcts.map((p) => Number(p.toFixed(decimals)));
}

// ── 1. EXACT-100 across representative + the reported bug case ───────────────

// The confirmed-diagnosis buffer case: winners + a 42.625% buffer. Naive 2dp
// (or here, the general residual) leaves the column off 100; reconcile fixes it.
const BUFFER_CASE = [42.625, 25, 12.5, 10, 5, 2.5, 1.25, 0.75, 0.025, 0.025];

check("42.625 buffer case: naive column is OFF 100, reconciled sums to EXACTLY 100", () => {
  const naive = gridSum(naiveColumn(BUFFER_CASE));
  // The naive column need not equal 100 — that's the whole bug.
  const rec = reconcileOddsForDisplay(BUFFER_CASE);
  assert(
    gridSum(rec) === 100,
    `reconciled must sum to exactly 100 (got ${gridSum(rec)}; naive was ${naive})`,
  );
});

check("the MASAKI-shaped 96.625 buffer (0.025 winner rounds up) reconciles to 100", () => {
  // Case A from the invariant probe: buffer 96.625, winners incl. a 0.025 that
  // rounds UP — the naive 2dp column overshoots to 100.010.
  const v = [96.625, 2.0, 0.75, 0.4, 0.15, 0.05, 0.025];
  const rec = reconcileOddsForDisplay(v);
  assert(gridSum(rec) === 100, `sum ${gridSum(rec)} !== 100`);
});

check("random vectors (200×, 2–40 cards, scaled to sum 100): all reconcile to EXACTLY 100", () => {
  let seed = 123456789;
  const rnd = () => {
    // deterministic LCG so a failure is reproducible
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
  };
  for (let t = 0; t < 200; t++) {
    const n = 2 + Math.floor(rnd() * 39);
    const raw: number[] = [];
    for (let i = 0; i < n; i++) raw.push(rnd() ** 3 + 1e-6); // skew toward a buffer
    const rawSum = raw.reduce((s, x) => s + x, 0);
    const pcts = raw.map((x) => (x / rawSum) * 100); // exact-100 true vector
    for (const decimals of [2, 3, 4]) {
      const rec = reconcileOddsForDisplay(pcts, decimals);
      const sum = gridSum(rec, decimals);
      assert(
        sum === 100,
        `trial ${t} n=${n} d=${decimals}: reconciled sum ${sum} !== 100`,
      );
      assert(rec.length === n, `trial ${t}: length changed ${rec.length} vs ${n}`);
    }
  }
});

// ── 2 + 3. Buffer carries the residual; non-buffer clean values unchanged ────

check("only the largest-mass entry differs from its independent rounding (the buffer)", () => {
  const rec = reconcileOddsForDisplay(BUFFER_CASE);
  const naive = naiveColumn(BUFFER_CASE);
  const bufferIdx = BUFFER_CASE.indexOf(Math.max(...BUFFER_CASE)); // 42.625 → idx 0
  for (let i = 0; i < rec.length; i++) {
    if (i === bufferIdx) continue;
    assert(
      rec[i] === naive[i],
      `non-buffer entry ${i} perturbed: ${rec[i]} vs naive ${naive[i]}`,
    );
  }
});

check("the residual lands on the LARGEST entry (buffer index = argmax of the vector)", () => {
  // A vector whose naive column overshoots — the buffer must eat the whole −residual.
  const v = [50.005, 30.0, 12.5, 5.0, 2.5]; // naive 4dp sums to 100.005
  const rec = reconcileOddsForDisplay(v);
  assert(gridSum(rec) === 100, `sum ${gridSum(rec)} !== 100`);
  const naive = naiveColumn(v);
  // Only index 0 (the 50.005 buffer) may move.
  for (let i = 1; i < v.length; i++) {
    assert(rec[i] === naive[i], `entry ${i} moved: ${rec[i]} vs ${naive[i]}`);
  }
  assert(rec[0] !== naive[0], "the buffer must absorb the residual");
});

// ── 4. IDEMPOTENCE ───────────────────────────────────────────────────────────

check("a vector already on the grid (sum exactly 100) is returned unchanged", () => {
  const v = [40, 25, 20, 10, 5]; // sum 100 exactly, no rounding needed
  const rec = reconcileOddsForDisplay(v);
  assert(
    JSON.stringify(rec) === JSON.stringify(v),
    `on-grid vector perturbed: ${JSON.stringify(rec)}`,
  );
});

check("idempotence: reconcile(reconcile(v)) === reconcile(v)", () => {
  const once = reconcileOddsForDisplay(BUFFER_CASE);
  const twice = reconcileOddsForDisplay(once);
  assert(
    JSON.stringify(once) === JSON.stringify(twice),
    `not a fixed point:\n once=${JSON.stringify(once)}\n twice=${JSON.stringify(twice)}`,
  );
  assert(gridSum(twice) === 100, `idempotent sum ${gridSum(twice)} !== 100`);
});

// ── 5. SUB-1% PRESERVED ──────────────────────────────────────────────────────

check("a real 0.0075% jackpot is never collapsed and never becomes the buffer", () => {
  const v = [88.6825, 8.0, 2.0, 1.0, 0.3, 0.01, 0.0075];
  const rec = reconcileOddsForDisplay(v, 4);
  // The jackpot (idx 6) is untouched at 4dp (0.0075 is exactly on the 4dp grid).
  assert(rec[6] === 0.0075, `jackpot collapsed: ${rec[6]}`);
  // The buffer (residual carrier) is the largest entry, not the jackpot.
  const bufferIdx = v.indexOf(Math.max(...v));
  assert(bufferIdx === 0, "buffer must be the largest entry");
  assert(gridSum(rec) === 100, `sum ${gridSum(rec)} !== 100`);
});

// ── 6. EDGE CASES ────────────────────────────────────────────────────────────

check("empty vector → []", () => {
  assert(reconcileOddsForDisplay([]).length === 0, "empty must return []");
});

check("single-element vector → the lone entry IS the buffer (rounded, unchanged length)", () => {
  const rec = reconcileOddsForDisplay([100]);
  assert(rec.length === 1 && rec[0] === 100, `single-element wrong: ${JSON.stringify(rec)}`);
  const rec2 = reconcileOddsForDisplay([99.99999]);
  assert(rec2.length === 1, "length must be 1");
});

check("NaN / non-finite entries are guarded (treated as 0, never poison the sum)", () => {
  const rec = reconcileOddsForDisplay([57.5, NaN, 30, 12.5]);
  assert(rec.every((x) => Number.isFinite(x)), `non-finite leaked: ${JSON.stringify(rec)}`);
  assert(gridSum(rec) === 100, `guarded sum ${gridSum(rec)} !== 100`);
});

check("negative residual (naive column overshoots) is absorbed correctly", () => {
  // Two 0.xxx5 that both round UP → naive overshoots; residual is negative and
  // must be subtracted from the buffer.
  const v = [99.331, 0.3335, 0.3335, 0.0015, 0.0005];
  const rec = reconcileOddsForDisplay(v, 4);
  assert(gridSum(rec) === 100, `overshoot sum ${gridSum(rec)} !== 100`);
});

// ── 7. FORMATTER ─────────────────────────────────────────────────────────────

check("formatReconciledPct trims trailing zeros + keeps sub-1% precision", () => {
  const cases: [number, string][] = [
    [42.625, "42.625%"],
    [25, "25%"],
    [0.075, "0.075%"],
    [0.0075, "0.0075%"],
    [12.5, "12.5%"],
    [0, "0%"],
    [100, "100%"],
    [2.0, "2%"],
  ];
  for (const [input, want] of cases) {
    const got = formatReconciledPct(input);
    assert(got === want, `formatReconciledPct(${input}) = "${got}", want "${want}"`);
  }
  // A sub-1% value uses the canonical 4-sig-fig rule (never flat 2dp).
  assert(
    formatReconciledPct(0.0075) === "0.0075%",
    "sub-1% must keep 4 sig-figs",
  );
  // A non-finite input degrades to the em-dash, never "NaN%".
  assert(formatReconciledPct(NaN) === "—", "NaN must render em-dash");
});

// ── Summary ──────────────────────────────────────────────────────────────────
console.log(
  `\n${passes} passed, ${failures.length} failed${
    failures.length > 0 ? ` — ${failures.join(", ")}` : ""
  }`,
);
if (failures.length > 0) process.exit(1);
