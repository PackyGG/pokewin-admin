---
name: crypto-fee-model-and-tracking
description: "How the hidden crypto deposit/withdrawal fee works, that it's live, and how actual profit is tracked (backend metadata.crypto_fee)"
metadata: 
  node_type: memory
  type: reference
  originSessionId: d4f148e1-2501-4456-97ae-4eb29709a862
---

**Model (backend `PackyGG/backend`):** a hidden exchange-rate spread, not a line-item. `site-config.service.ts` `rollCryptoFeeBps(direction, asset)` rolls a random fee in `[min_bps,max_bps]` (clamped 0–500). Deposit: `effectivePrice = price × (1 − fee/10000)` → credits fewer USD (`webhook.service.ts`). Withdrawal: `effectivePrice = price × (1 + fee/10000)` → sends less crypto (`outgoing.service.ts` `calculateCryptoAmount`, used by card `crypto.service.ts` + `balance.service.ts`). Skewed price stored as `ledger_transactions.exchange_rate`; rolled ONCE at request time, reused (no re-roll). Config admin route `routes/v1/admin/crypto-fees.ts`; managed from admin UI `security/crypto-fees-card.tsx`. Creator-LB funding always converts at market (no fee).

**Verified live (2026-07-15, read-only prod):** enabled on all 11 coins — deposits 0.10–0.60%, withdrawals 0.05–0.25%. Stablecoin exchange_rates prove it (deposits <1.0, withdrawals > deposit-rate). Admin dashboard estimate ≈$987 since 2026-06-14 (`dashboard-crypto-fee-counter.ts`, `volume × locked midpoint 45/7.5 bps` — an ESTIMATE).

**Actual-profit tracking:** the skewed rate alone can't be inverted (market price + bps were thrown away, only logged). Fix = backend PR #445 (branch `motha/feat/crypto-fee-metadata`): writes `metadata.crypto_fee = {market_price, fee_bps, fee_usd}` into the existing `ledger_transactions.metadata` JSONB at creation (only when fee>0), where `fee_usd = crypto_amount × market_price × fee_bps/10000`. No schema migration, no API change (metadata stripped by response schemas — see [[no-new-api-response-returns]]). Multiplier-routed deposit completion preserves the record. Admin exact counter = `SUM((metadata->'crypto_fee'->>'fee_usd')::numeric) WHERE status='completed'`, read directly from game DB — **still TODO in pokewin-admin, and only meaningful once PR #445 merges + deploys** (historical tx have no record, exact from merge onward).
