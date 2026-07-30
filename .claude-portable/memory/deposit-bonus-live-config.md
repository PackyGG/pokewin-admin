---
name: deposit-bonus-live-config
description: "Deposit bonus is 5% only inside a 30-min window then capped at $20/6h — real cost ~1% of deposits, not 5%"
metadata: 
  node_type: memory
  type: project
  originSessionId: 985536c8-fd72-492d-913d-742287ae7992
  modified: 2026-07-22T20:31:34.137Z
---

Two filters stack before a deposit earns anything (backend `deposit-credit.service.ts` + `affiliate.service.ts`):

1. **30-minute eligibility window.** `DEPOSIT_BONUS_RATE = 0.05` applies only if `affiliate_bonus_expires_at > now`. Staff and creators are excluded outright; own-code deposits excluded; idempotent per deposit ref.
2. **Rolling cap.** At most `deposit_bonus_cap_per_period_usd` per `deposit_bonus_period_hours`.

Live values on prod, verified read-only 2026-07-22:
- `deposit_bonus_cap_per_period_usd` = **`"20"`** (set 2026-06-17). Admin code comments said 25 — that's the backend *default*, now corrected in-repo.
- `deposit_bonus_period_hours` — **never written to `site_config`**, so it runs on the backend default (6h).
- `affiliate_cut_expiration_days` = **`""`** → affiliate commission never expires (lifetime).

**Why it matters — the real cost is ~1%, not 5%.** 14d to 2026-07-22: 603 deposits totalling $59,377.68; only $21,748.17 (37%) was in-window; the $20 cap then clamped 5% → 2.7% on that slice; total paid $590.49 across 225 bonuses / 86 users. Max single bonus and max per-user 6h total were both exactly $20.00. Any model costing this at 5% overstates it ~5×.

**How to apply:** only the cap + period are editable (from /security, via backend `PUT /admin/deposit-bonus-config`). The 5% rate and the 30-min window are backend constants — changing them is a backend PR, not an admin change. ONBOARDING.md's reward table now carries the corrected figures.

Related: [[affiliate-code-binding-7-days]]
