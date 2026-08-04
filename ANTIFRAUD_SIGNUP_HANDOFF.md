# Antifraud signup flow handoff

Last verified: 2026-08-04 (Europe/Berlin)

## Start here

This file is the focused handoff for continuing the signup-risk work in
`PackyGG/pokewin-admin`. Read `AGENT_HANDOFF.md`, `ONBOARDING.md`, and
`CLAUDE.md` as required by the repository before changing anything.

The owner wants to continue by mapping the signup check categories, flags,
points, notifications, and staff actions in simple language, then documenting
the agreed behavior on `/antifraud/guide/sign-up`.

## Final signup bands

- **0-20 · No risk:** no monitor, no Discord notification, no Account Review,
  no locks.
- **21-49 · Low risk:** 5-minute monitor, configurable
  `antifraud.signup_low_risk` Discord action, no Account Review, no locks.
- **50-69 · High risk:** 10-minute monitor, Account Review opens, Discord action
  `antifraud.signup_high` routes to `#high-risk` (`1534296433241493774`), no
  automatic locks.
- **70-100 · Critical risk:** 15-minute monitor, Account Review opens, Discord
  action `antifraud.signup_critical` routes to `#critical-risk`
  (`1534296454129254523`), and the system disables Fiat deposits, locks crypto
  and item withdrawals, and locks tips. It does not automatically ban the
  account or request KYC.

The latest score decides the result when monitoring ends. If new evidence
crosses a higher threshold during monitoring, the higher action can happen
immediately.

## Discord state

- The retired combined `antifraud.signup_high_risk` action is disabled and has
  no live route.
- The duplicate signup `antifraud.review_opened` Discord route is retired. Do
  not restore it for signups. Internal Account Review creation and non-signup
  review operations remain active.
- High and Critical signup embeds have an emoji title and these fields:
  Username, User ID, Risk score, Location / country, Locks, Time, and Why it was
  flagged.
- Only User ID uses Discord inline-code styling. Normal text uses normal Discord
  formatting.
- Signup-risk embeds have no description, Trigger, visible Case ID, risk-band
  subtitle, or secondary flag descriptions.
- `Locks` has one emoji in the field title only. Its value is plain `None` or a
  plain list such as `Fiat deposits · Crypto withdrawals · Item withdrawals · Tips`.
- `Why it was flagged` shows up to four compact point/title rows. The review
  button still carries the internal case link.
- Synthetic previews must use fake identities and no customer data. Do not add
  a visible synthetic-test sentence to the normal embed design. Keep delivered
  queue rows as the audit trail and delete only temporary sender scripts.

## Guide state

The staff guide is live at `/antifraud/guide/sign-up`. It shows the four bands,
monitoring, Discord destination/action, Review Yes/No, locks, and the four-step
flow: check -> score -> monitor -> decide. Card footer copy and the separate
Critical containment explainer box were intentionally removed.

## Production evidence

- Latest code commit: `bf28e71a1` on `main`.
- Vercel: deployment `dpl_9grEH4rsFS6yqaXTAgC8PxguotyZ` is READY and owns the
  production aliases, including `fraud.packydash.com`.
- Railway `antifraud-monitor`: deployment
  `9ff82aa3-e696-4514-ae38-6432f29d8a03` is SUCCESS; `/ready` returns HTTP 200
  with `{"status":"ready"}`. `/health` returns HTTP 200 with
  `{"status":"degraded","stalledForMs":null}`; keep this distinction when
  reporting health.
- Latest synthetic run: `a6667061-726d-49d5-a85c-ebc91e4bb754`.
- High preview message: `1534319095116202148`.
- Critical preview message: `1534319095254749217`.
- Both preview jobs were verified `delivered` in their intended channels with
  no real customer data.

## Verification baseline

- Monitor TypeScript and all 345 monitor tests pass.
- All 506 dashboard guardrails pass.
- Repository TypeScript, scoped ESLint, and diff checks pass.
- Production Vercel is READY, Railway is SUCCESS, and live Discord delivery was
  verified after the latest formatter deployment.

## Continue from here

1. Trace the authoritative signup scoring sources before describing them:
   `services/antifraud-monitor/src/scoring.ts`, `score-catalog.ts`, provider
   adapters, and persisted assessment evidence.
2. Produce a simple inventory of categories, individual flags, point values,
   hard-policy overrides, and whether each item is initial-signup or monitoring
   evidence.
3. Confirm any product-language changes with the owner, then update the guide
   without changing runtime scoring unless explicitly requested.
4. Preserve the current bands, routing, containment behavior, and compact
   Discord design unless the owner asks to change them.

## Workspace caution

The primary checkout has unrelated concurrent changes. Inspect status first,
preserve all user work, and use a clean isolated worktree or explicit path-only
staging. Never stage the whole root checkout.
