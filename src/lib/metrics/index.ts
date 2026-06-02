/**
 * @/lib/metrics — the single-source-of-truth metric layer for the admin.
 *
 * Phase-1 foundation. UNWIRED: nothing in the live app imports this yet.
 * New files only → zero behaviour change → zero live risk. A later,
 * build-verified migration swaps each page/query onto these exports and
 * deletes the inline type lists / formulas. Until then,
 * `src/lib/queries/_wager-payout-types.ts` and the inline definitions
 * remain the live source of truth — do NOT edit them from here.
 *
 * Layout:
 *   • ledger-sets.ts   — the disjoint partition of all 42
 *                        `ledger_transaction_type` members into buckets
 *                        (WAGER / FEE / GAMING_PAYOUT / NEUTRAL /
 *                        REWARD_PAYOUT / RESIDUAL / UPGRADER), with SQL
 *                        list helpers and a compile-time exhaustiveness
 *                        guard. Client-safe (no DB import).
 *   • formulas.ts      — pure, testable arithmetic: GGR / NGR / gaming
 *                        payout / empirical RTP & house edge (sample-
 *                        guarded) / rain-cost hook / MIN_SAMPLE. Client-
 *                        safe.
 *   • queries.ts       — canonical DB-read builders (server-only) that
 *                        bake in the real-customer + borrow-corrected
 *                        scope and compose the formulas. Isolated upgrader
 *                        read behind `UPGRADER_IN_LEDGER`.
 *   • realized-pnl.ts  — re-export of the already-correct canonical
 *                        realized-P&L functions (server-only).
 *
 * IMPORTANT: this barrel intentionally re-exports ONLY the client-safe
 * modules (ledger-sets, formulas). The server-only modules (queries,
 * realized-pnl) are NOT re-exported here so importing `@/lib/metrics`
 * from a client component can never accidentally pull `server-only` and
 * crash the build. Import those directly:
 *   import { getWindowMetrics } from "@/lib/metrics/queries";
 *   import { getRealizedPnlSnapshot } from "@/lib/metrics/realized-pnl";
 */

export * from "./ledger-sets";
export * from "./formulas";
