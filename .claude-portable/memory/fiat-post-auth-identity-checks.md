---
name: fiat-post-auth-identity-checks
description: "Planned post-authorization fiat deposit identity-drift checks (card/email/IP/device vs first deposit) — spec, owner decisions, verified primitives; BLOCKED on concurrent fiat-eligibility work landing"
metadata: 
  node_type: memory
  type: project
  originSessionId: 4dcc317f-16e9-4717-b333-b5a05a9188d9
  modified: 2026-07-30T08:05:38.068Z
---

Owner asked (2026-07-30) for a new antifraud layer that checks every fiat
deposit **after Whop authorizes it** and, on a hit, requires KYC + fully locks
the account. Distinct from the pre-checkout `fiat-eligibility` gate: last4 and
the real checkout email only exist post-authorization.

**Status: NOT BUILT — deliberately deferred.** A concurrent Codex session had
uncommitted work in the same area (`services/antifraud-monitor/src/fiat-eligibility-policy.ts`
+ `fiat-eligibility-containment.ts` untracked, plus modified monitor
`config.ts` / `runtime-config.ts` / `server.ts`). Owner chose to wait for that
to land before starting, to avoid collisions on `monitor.ts`,
`src/app/api/antifraud/ingest/route.ts`, `ingest-delivery.ts`, and the next
migration number. **Re-check whether that work shipped before building.**
See [[concurrent-codex-sessions]].

## The rules (owner's spec + answers)

Baseline = the user's FIRST authorized fiat deposit. Compare each later one:

| Condition | Action |
|---|---|
| Checkout email domain on blacklist | KYC + full lock |
| Checkout IP or device on operator blocklist | KYC + full lock |
| Checkout email is catch-all (Abstract `is_catchall`) | KYC + full lock |
| Checkout email undeliverable (Abstract deliverability) | KYC + full lock |
| Checkout email differs from baseline | KYC + full lock |
| Card last4 differs from baseline | KYC + full lock, **unless** 3+ prior authorized fiat deposits with no dispute/refund/chargeback (grace applies to the card check ONLY) |
| Checkout IP **and** device both differ | KYC + full lock |
| Only IP differs, or only device differs | alert only, no lock |

Auto-KYC is attributed to admin `1336a279-971c-4089-a305-60f0313bf7cd`
(`motha`, admin DB `admin_users`), hardcoded as the automation actor.

## Verified primitives (all already exist — extend, don't invent)

- Card brand + last4: `whopPaymentMethodInfo` (`src/whop-payment-method.ts`),
  already surfaced as `cardBrand`/`cardLast4` in `fiat-risk.ts`.
- Checkout email: `payment_webhook_events.payload#>>'{data,user,email}'` /
  `paid.checkout_email`.
- Per-checkout IP + device: antifraud DB `fiat_eligibility_assessments`
  (`request_ip`, `checkout_visitor_id`) — no FK to the intent, correlate by
  `user_id` + nearest `created_at` before `fiat_deposit_intents.created_at`.
  `fiat_deposit_intents` itself carries NO ip/fingerprint column.
- Catchall + deliverability: `EnrichmentService.abstractEmailCheck()`
  (`enrichment.ts`) — takes a `Signup`-shaped `{id, email}`; today only run on
  signup emails, never on checkout emails.
- Auto-enforcement path: monitor inserts a `risk_events` row with
  `payload.containmentRequired = true` → `IngestDelivery` ships it (priority
  branch lists specific `event_type`s; the fallback query ships everything
  undelivered) → `src/app/api/antifraud/ingest/route.ts` applies the MAIN write
  via `getProdPrimaryDrizzleDb()`. `risk_events` requires a `subjects` row —
  upsert it first (see `fiat-email-domains.ts:1123`).
- Lock shape used by every existing containment: `user_feature_locks` upsert
  with `locked_withdrawals_crypto = ARRAY['all']`, `locked_withdrawals_items =
  TRUE`, preserving an existing `locked_withdrawals_at`/`_reason` via COALESCE.
- Discord: add a `FIAT_PROBLEM_CODES` entry + `fiatProblemTitle` branch +
  `notificationRoutesForFiatProblem` mapping. `fiat_problem_alert_outbox.problem_code`
  has NO check constraint, so a new code needs no migration; the
  `fiat_problem_alert_deliveries.destination` CHECK does.

## Gotchas found

- `requireUserKyc` (`src/lib/backend-api/kyc.ts`) needs an `adminId` and
  **itself re-locks withdrawals**. The panel guard
  `isLockedAccountEligibleForKyc` (both withdrawal channels already locked) is
  a UI-side policy for humans, not a backend constraint — but lock first anyway
  so the states stay consistent.
- `ingest/route.ts` currently documents the invariant "Automated signals never
  mutate KYC state." Auto-KYC breaks that on purpose — update the comment.
- Fiat checkout IP/fingerprint are NOT checked against the operator
  identifier blocklists today; that containment path is signup-only.
- `battle`-style grace: count only intents whose status ended `completed` and
  that never went `disputed`/`refunded`/`partially_refunded`.
