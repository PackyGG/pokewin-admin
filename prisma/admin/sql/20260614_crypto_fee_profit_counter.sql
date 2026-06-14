-- Crypto fee profit counter -- ADMIN-DB additive single-row table (2026-06-14)
-- Provisioned via `prisma db execute` (NOT migrate; the admin DB is
-- db-push/execute-managed with a drifted migration history). Idempotent:
-- CREATE TABLE IF NOT EXISTS only. The Prisma model block in
-- prisma/admin/schema.prisma (model crypto_fee_profit_counter) is the mirror
-- for typed access. Read path catches P2021/P2025/42P01 and degrades.
--
-- Touches ONLY this one new table. No ALTER/DROP on any other object.
--
-- Backs the dashboard "Crypto Fee" KPI box: house estimated cumulative profit
-- from the hidden crypto exchange-rate fee, ANCHORED to count_start_at and
-- kept MONOTONIC (high-water) so it only counts up. bps as Decimal(7,4) so the
-- withdrawal midpoint 7.5 (= 0.075%) is exact, not rounded to an int.

CREATE TABLE IF NOT EXISTS "crypto_fee_profit_counter" (
  "id"                  TEXT PRIMARY KEY DEFAULT 'singleton',
  "count_start_at"      TIMESTAMPTZ(6) NOT NULL,
  "deposit_fee_bps"     NUMERIC(7, 4) NOT NULL,
  "withdrawal_fee_bps"  NUMERIC(7, 4) NOT NULL,
  "total_fee_usd"       NUMERIC(20, 2) NOT NULL DEFAULT 0,
  "deposit_fee_usd"     NUMERIC(20, 2) NOT NULL DEFAULT 0,
  "withdrawal_fee_usd"  NUMERIC(20, 2) NOT NULL DEFAULT 0,
  "updated_at"          TIMESTAMPTZ(6) NOT NULL DEFAULT now()
);
