---
name: promo-code-user-binding
description: promo_codes.metadata.bound_user_id restricts a code to one account; reward-campaign codes are HMAC-derived so retries reuse them
metadata: 
  node_type: memory
  type: project
  originSessionId: 1e58921f-e659-4642-9018-896460ff734e
  modified: 2026-07-22T22:40:12.165Z
---

`max_uses: 1` on a promo code means "single use" — it says nothing about WHO.
Anyone who learns the code can burn it, and the intended owner is then told the
code is exhausted.

**Binding (added PackyGG/backend#462, merged to `dev` 2026-07-23):** set
`promo_codes.metadata.bound_user_id` and only that account can redeem;
everyone else gets `PROMO_CODE_NOT_FOR_THIS_USER`. No schema change —
`metadata` was already jsonb. Absent = ordinary shared code. Enforced in
`backend/src/services/code.service.ts` `processPromoCode`, checked before every
other gate, and the reader fails open on a malformed blob.

**Also verified in that service:** promo-code `region` is recorded but NOT
enforced at redeem — only gift cards check region. Don't treat a promo code's
region as a gate.

**Reward-campaign codes are derived, not random:**
`HMAC(GIFT_CARD_PEPPER, "packy.promo-campaign.v1:<campaign>:<user_id>")` →
`PACKY-XXXX-XXXX-XXXX` (`src/lib/reward-campaign-codes.ts`).

**Why:** determinism is what makes a campaign retry-safe. Re-deriving gives the
same code, the existing row is found by the indexed `code_hash` and skipped, and
the notification's `dedupe_key` collapses too — so a replayed chunk mints
nothing new. A random code would need a mapping table or a JSONB metadata scan
to achieve the same, and silently mints a second $N per retried user if it has
neither.

**How to apply:** never "improve" this to a random generator, and never change
the derivation inputs or `DERIVATION_DOMAIN` without bumping the version — old
campaigns would stop resolving to their issued codes. Minting is gated to the
dev game DB by two independent checks. See
[[personal-notification-frontend-templates]].
