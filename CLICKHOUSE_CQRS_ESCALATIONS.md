# ClickHouse CQRS — Escalation Notes (owner decisions)

Behavior-affecting items surfaced during the ClickHouse CQRS read-engine mission.
These are **documented, not silently changed**: each would alter a number the live
dashboard serves today, so the call is the owner's. The code is left at its current
(parity-aligned) behavior until an owner decides.

> **Status update (2026-06-15): all three items RESOLVED by owner — see each
> entry's "OWNER DECISION" note.** ESC-1 + ESC-2 (P&L scope): **keep** the
> current 2-role real-user scope (`role NOT IN ('admin','support')`, creators
> counted) — *"P&L is the same for everyone"*; ESC-3 (crypto-fee high-water
> write): **keep** as-is. No served numbers change and no source code is
> changed.
>
> **Phase 2B/2C ClickHouse guidance (binding):** for the upcoming ClickHouse
> work, **all P&L surfaces must use the uniform 2-role real-user scope
> (`role NOT IN ('admin','support')`, creators INCLUDED)** to stay consistent
> with this owner decision. Do **not** apply the canonical 3-role
> `getMetricsScope` / `CUSTOMER_EXCLUDED_ROLES` (which drops creators) to any
> P&L surface — that scope remains for GGR/NGR/wager analytics only.

---

## ESC-1 — Realized P&L keeps creators (2-role scope), diverging from canonical 3-role `getMetricsScope`

**Date:** 2026-06-15 · **Feature:** `m2-realized-pnl-scope-align` · **Status:** RESOLVED (owner decision, 2026-06-15)

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

> **OWNER DECISION (2026-06-15): RESOLVED — KEEP the current 2-role scope.**
> The owner ruled: **"P&L is the same for everyone."** Realized P&L keeps its
> current 2-role balance-sheet semantics (`role NOT IN ('admin','support')`,
> creators counted as real users) — i.e. **option (A)**. Creators are treated
> as real users in P&L, only `admin`/`support` are excluded. The divergence
> from the canonical 3-role `getMetricsScope` / `CUSTOMER_EXCLUDED_ROLES` is
> therefore **intentional and accepted**, not a bug. **No served number
> changes** and **no code change** is made: the PG twin stays as-is and the CH
> twin remains aligned to it (2-role). This scope must be applied **uniformly**
> across the whole P&L family (see ESC-2).

---

## ESC-2 — P&L family uses the legacy 2-role scope (keeps creators) vs canonical 3-role `getMetricsScope`

**Date:** 2026-06-15 · **Feature:** `m4-escalation-notes` · **Status:** RESOLVED (owner decision, 2026-06-15) · **Code: UNCHANGED**

**What:** The dashboard P&L family scopes its "real users" to
`role NOT IN ('admin', 'support')` — i.e. it **KEEPS creators** — rather than
the canonical customer scope used by GGR/NGR/wager analytics.

**File / line references (current `main`):**

| Function | File · line | Scope predicate today |
|---|---|---|
| `getDailyPnl` → `computeDailyPnl` (Daily P&L chart) | `src/lib/queries/pnl.ts:795` (computor), scope at **`pnl.ts:799`**; public entry `getDailyPnl` at `pnl.ts:1037` | `u.role NOT IN ('admin', 'support')` |
| `getRealizedPnlSnapshot` → `realizedPnlSnapshotInner` (lifetime P&L tile) | `src/lib/queries/_realized-pnl.ts` `real_users` CTE at **`_realized-pnl.ts:108-109`** | `role NOT IN ('admin', 'support')` |
| (siblings sharing the same 2-role scope) `calculateWindowedPnl` | `src/lib/queries/pnl.ts:347` | `u.role NOT IN ('admin', 'support')` |
| (siblings) `getPnlBreakdownWindows` | `src/lib/queries/pnl.ts:1134` | `u.role NOT IN ('admin', 'support')` |

**Canonical scope it diverges from:** `getMetricsScope()` /
`CUSTOMER_EXCLUDED_ROLES = ['admin','support','creator']` at
**`src/lib/metrics/scope.ts:86`** (built into `userScopeSql` at
`scope.ts:175`) — the canonical 3-role scope that **drops creators**.

**Why it may be intentional (do not assume it's a bug):** This is a
**balance-sheet** figure, and `_realized-pnl.ts` documents the intent in its
header (`_realized-pnl.ts:35-37`): *"All aggregates exclude only the `admin`
role. Creators are real users — their wagers/deposits/payouts count in P&L
like everyone else."* (Note: the predicate actually drops both `admin` and
`support`; the header undercounts by one role but the meaning — creators are
kept — is the deliberate part.) For a money-owed balance sheet, counting a
creator's real deposits/holdings is defensible; the canonical 3-role scope is
tuned for GGR/NGR/wager *analytics*, where creator activity is excluded as
non-customer. Same question already recorded for the lifetime tile in **ESC-1**
(resolved for ClickHouse parity by aligning the CH twin to this PG scope, not
by changing the PG twin).

**Recommended owner decision:** Choose ONE, consciously, and apply it to the
WHOLE P&L family together so the surfaces stay mutually consistent:
- **(A) Keep the 2-role balance-sheet semantics** (creators counted as real
  users) — this is today's served number on the Daily P&L chart and the
  lifetime P&L tile. No code change; close this as "intended".
- **(B) Canonicalize to the 3-role `getMetricsScope`** (drop creators). This
  **changes a live served number** on every P&L surface above, so it is a
  behavior change that must move `getDailyPnl`, `getRealizedPnlSnapshot`,
  `calculateWindowedPnl`, and `getPnlBreakdownWindows` (plus the per-user
  `calculateUserPnl` / `calculateUsersPnlBatch` if per-user P&L should match)
  together, and requires fresh before/after served-number evidence per window.

**Left unchanged this mission** — `git diff` of `src/lib/queries/pnl.ts` and
`src/lib/queries/_realized-pnl.ts` shows no logic change to these functions.

> **OWNER DECISION (2026-06-15): RESOLVED — option (A), KEEP the 2-role scope.**
> The owner ruled: **"P&L is the same for everyone."** The entire P&L family
> keeps the legacy 2-role balance-sheet scope (`role NOT IN ('admin','support')`,
> creators counted as real users). The divergence from the canonical 3-role
> `getMetricsScope` is **intentional and accepted** for P&L surfaces — it is the
> deliberate balance-sheet semantics, not a bug. This scope is to be applied
> **uniformly** across the whole P&L family — `getDailyPnl` / `computeDailyPnl`,
> `getRealizedPnlSnapshot` / `realizedPnlSnapshotInner`, `calculateWindowedPnl`,
> `getPnlBreakdownWindows`, and any insights P&L surface — so they stay mutually
> consistent. **No served number changes** and **no code change** is made.

---

## ESC-3 — `getCryptoFeeProfitCounter` performs an admin-DB write on the render path

**Date:** 2026-06-15 · **Feature:** `m4-escalation-notes` · **Status:** RESOLVED (owner decision, 2026-06-15) · **Code: UNCHANGED**

**What:** The dashboard "Crypto Fee" KPI box is backed by
`getCryptoFeeProfitCounter` (**`src/lib/queries/dashboard-crypto-fee-counter.ts:172`**),
which is called during the `/dashboard` Server-Component render. As a side
effect of rendering it can issue an **ADMIN-DB `UPDATE`**: the high-water
write-back at **`dashboard-crypto-fee-counter.ts:232-240`**
(`adminDb.$executeRaw … UPDATE "crypto_fee_profit_counter" SET … = GREATEST(…)`),
guarded by `if (useLive && liveTotal > storedTotal)` (line 230).

**Why it exists (context, not a defect):** The counter is designed to be
**durable + monotonic** (header doc, `dashboard-crypto-fee-counter.ts:14-58`):
the prod GAME DB has swapped hosts, so a value read purely from live game-DB
history could DROP; persisting `GREATEST(stored, live)` in the admin DB makes
the displayed figure provably non-decreasing across a host swap. The write is
**idempotent** (`GREATEST(...)`, harmless under concurrent renders), targets
the **ADMIN DB** (which the mission rules permit writing — this is NOT a
MAIN/prod game-DB write, so it does not violate the SELECT-only invariant),
and is wrapped in try/catch that swallows missing-object errors without taking
the tile down (lines 241-247).

**Why it's escalated:** A **render path that mutates durable state** is a
side-effecting GET — surprising for a read surface, can write under
auto-refresh (the dashboard re-renders every 60s), and couples tile rendering
to admin-DB write availability. Moving the write off the render path is
**behavior-affecting** (it changes *when/whether* the high-water mark
advances — e.g. it would only advance when a scheduled job or explicit refresh
runs, not on every viewer render), so it is not changed here.

**Recommended owner decision:** Choose ONE:
- **(A) Keep the render-time monotonic write-back** (simplest; idempotent;
  guarantees the high-water mark advances whenever any admin views the
  dashboard, surviving host swaps). No code change.
- **(B) Relocate the write to a scheduled job / explicit refresh action**
  (e.g. a cron or an admin-triggered server action) and make
  `getCryptoFeeProfitCounter` a pure read (return `GREATEST(stored, live)`
  without persisting). This removes the render-time side effect but changes
  the advancement cadence of the stored counter — a behavior change requiring
  its own verification.

**Left unchanged this mission** — `git diff` of
`src/lib/queries/dashboard-crypto-fee-counter.ts` shows no logic change to
this function.

> **OWNER DECISION (2026-06-15): RESOLVED — option (A), KEEP as-is.**
> The owner ruled to keep the render-time monotonic high-water write-back.
> Rationale accepted: the write is **idempotent** (`GREATEST(stored, live)`),
> targets the **ADMIN DB only** (permitted to write — not a MAIN/prod game-DB
> write), and guarantees the displayed counter is provably non-decreasing
> across a game-DB host swap. **No code change** is made.
