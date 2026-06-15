# ClickHouse CQRS — Escalation Notes (owner decisions)

Behavior-affecting items surfaced during the ClickHouse CQRS read-engine mission.
These are **documented, not silently changed**: each would alter a number the live
dashboard serves today, so the call is the owner's. The code is left at its current
(parity-aligned) behavior until an owner decides.

---

## ESC-1 — Realized P&L keeps creators (2-role scope), diverging from canonical 3-role `getMetricsScope`

**Date:** 2026-06-15 · **Feature:** `m2-realized-pnl-scope-align` · **Status:** OPEN (owner decision)

**What:** The served Postgres realized-P&L twin
`getRealizedPnlSnapshot` (`src/lib/queries/_realized-pnl.ts` →
`realizedPnlSnapshotInner`) scopes its "real users" to
`role NOT IN ('admin','support')` — i.e. it **KEEPS creators**. Its own doc
states the intent: *"Creators are real users — their wagers/deposits/payouts
count in P&L like everyone else."* This is a deliberate balance-sheet scope.

This **diverges from the canonical customer scope** `getMetricsScope()`
(`src/lib/metrics/scope.ts`), whose `CUSTOMER_EXCLUDED_ROLES =
['admin','support','creator']` **drops creators** (the canonical 3-role scope
used for GGR/NGR/wager analytics).

**What was done (parity, behavior-neutral):** The ClickHouse twin
`getRealizedPnlSnapshotFromClickHouse`
(`src/lib/clickhouse/queries/realized-pnl.ts`) previously used the 3-role drop
(`role NOT IN ('admin','support','creator')`), which made every term differ from
the served PG value by the creators' contribution. It has been **aligned to the
PG twin** (`role NOT IN ('admin','support')`, creators KEPT) so comparison-mode
drift reflects engine/CDC-lag only. The `official_stream` + `remove_locked_balance`
carve-outs are replicated as **SIGNED NET `SUM(amount)`** (not ABS) exactly as PG.

**Parity evidence (uncommitted `scripts/_compare-realized-pnl.mjs`, `TZ=UTC`,
blacklist=6 fed to both engines, role list `NOT IN ('admin','support')`):** every
term parity-clean to the cent — `totalDeposited` Δ=0.00, `totalWithdrawn` Δ=0.00
(balance + card 4-status legs each 0.00), `userBalance` Δ=0.00 (incl. a
`remove_locked_net = -500.19` signed-NET carve-out matching on both engines),
`inventory` Δ=0.00, `vouchers` Δ=0.00, `unclaimedRakeback` Δ=0.00, composed `pnl`
Δ=0.00 and reconciles from the six terms. The harness also computed CH under the
OLD 3-role scope to show the creators' contribution that the alignment closed
(e.g. `totalDeposited` +24,179.90, composed `pnl` −53,770.41 between the two
scopes) — i.e. the scope was the entire structural gap.

**The decision (owner):** Should realized-P&L **keep** its current 2-role
balance-sheet semantics (creators counted as real users — today's served number),
**or canonicalize to the 3-role `getMetricsScope`** (drop creators)?
Canonicalizing **would change the served lifetime P&L tile** (per the harness,
the composed `pnl` differs by tens of thousands of dollars between the two
scopes). This is a behavior change to a live tile, so it is **not** made here.

- **No change to the PG twin** was made for parity — `git diff` of
  `src/lib/queries/_realized-pnl.ts` shows its scope predicate unmodified.
- If the owner chooses to canonicalize, BOTH `getRealizedPnlSnapshot` (PG) and
  its CH twin (plus `getDailyPnl`, which shares the legacy 2-role scope — see
  ESC-2) would move together, and new served-number evidence would be required.

---

## ESC-2 — Other legacy 2-role / render-time-write items (tracked for the /dashboard audit milestone)

These are owned by the `/dashboard` audit milestone (escalate, do NOT change):

- **`getDailyPnl` / `getRealizedPnlSnapshot` legacy 2-role scope** vs canonical
  3-role — same balance-sheet-vs-analytics question as ESC-1; may be intentional.
- **`getCryptoFeeProfitCounter` admin-DB write on render** — a write performed
  during a render path; relocation is behavior-affecting.

(Listed here so the realized-P&L scope question and its siblings live in one
place; ESC-1 is the item resolved by `m2-realized-pnl-scope-align`.)
