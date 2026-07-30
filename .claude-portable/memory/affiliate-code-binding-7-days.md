---
name: affiliate-code-binding-7-days
description: "Two clocks — a 7-day attribution lock on the affiliate code, and a separate 30-minute deposit-bonus window; admin assignment sets no lock"
metadata: 
  node_type: memory
  type: project
  originSessionId: 985536c8-fd72-492d-913d-742287ae7992
  modified: 2026-07-22T20:31:25.205Z
---

Applying an affiliate code in the packy.gg UI starts **two independent clocks** (backend `src/services/affiliate.service.ts`, `useCode`):

1. **Attribution lock — 7 days.** `user.affiliate_code_expires_at = now + SEVEN_DAYS_MS`. While it is live the user **cannot switch to a different code** — the backend throws `AFFILIATE_CODE_LOCKED` ("You're already linked to affiliate code X until it expires"). Re-applying the *same* code is allowed.
2. **Deposit-bonus window — 30 minutes.** `user.affiliate_bonus_expires_at = now + DEPOSIT_BONUS_WINDOW_MS`. Only deposits landing inside it earn the 5% bonus. Opened on first apply, on same-code re-apply (which refreshes ONLY this, never the 7-day attribution), and at referral signup.

Verified read-only on prod 2026-07-22: 6,212 users carry a code, 6,208 have an expiry, `expires_at − updated_at` clusters at exactly `7 days`, and the derived bonus-window length is exactly 30 min on 4,967 rows. `bonus_window_live` was 0 at probe time — with a 30-min window, almost nobody has one open at any instant.

**Why:** the 7d lock stops code-hopping to farm per-code bonuses; the 30-min window is what actually rations the deposit bonus. Both are backend constants, not admin-editable.

**How to apply:**
- Never say "bound for 7 days" without the second clock — the user is *attributed* for 7d but only *bonus-eligible* for 30 min at a time.
- Other `useCode` guards: can't use your own code, circular referrals blocked, IP→code sybil association tracked in Redis for 30d (logged as a warning, not blocked).
- Admin `assignAffiliateCode` sets `affiliate_code_expires_at = null` on purpose → no lock, user can change it immediately on the site.
- `affiliate_code_queue` is EMPTY in prod, so the "pending" KPI fed by `creators-detail.ts` is structurally always 0.

Related: [[deposit-bonus-live-config]]
