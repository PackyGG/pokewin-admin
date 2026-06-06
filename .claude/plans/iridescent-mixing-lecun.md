# Creator Hub Revamp Plan — `iridescent-mixing-lecun`

> **Status (2026-06-06):** Waves 0 → B+C **DONE**. Audit wave **DONE** (safe fixes shipped). Live verify **DONE** (minted-session Playwright). Owner can free agents for other work; only blocked/deferred items remain below.

---

## Goal

Build a self-contained **Creator Hub** sub-app (`/creator-hub/*`) for the in-house CM team — distinct from legacy `/creators` (untouched). House-POV finance colors, modern panels, lazy tabs, dual-DB rules, fail-closed access.

---

## Wave progress

| Wave | Scope | Status |
|---|---|---|
| **0** | Foundation — `creator_manager` role, sub-app shell, `canAccessCreatorHub` gate (motha + per-role ADMIN-DB toggles, default OFF), portal button | **DONE** |
| **1** | Core pages — roster, `creators/[id]` Overview + tabs, profitable-algo, live-leaderboards, changelog, nav wiring | **DONE** |
| **Substrate** | 9 ADMIN-DB tables (kick/twitter/crm/alerts/session meta) + `src/lib/creator-hub/*` (TTL cache, throttle, server-only) + Settings (RapidAPI keys in `admin_settings`) | **DONE** |
| **Per-creator tabs** | Creator, Risk, Forecast, Cohorts&LTV, Alt Accounts, Kick, Twitter, Sessions+VOD | **DONE** |
| **Ops tools** | Creator Check, onboarding checklist dock, acquisition, compare, alerts (right-rail dock), deal-tracker, socials-review | **DONE** |
| **B** | Dashboard 24h real-data + bucketed charts, Add Creator v2, ops routes wired | **DONE** |
| **C** | Top Creators = most wager; post-B+C fixes (Vercel build, creator cost converted payouts, linked socials, Kick refetch) | **DONE** |
| **AUDIT-FIX** | Design, security, perf, math sweep + safe fixes | **DONE** (see checklist below) |
| **LIVE VERIFY** | All `/creator-hub/*` routes | **DONE** (`e2e/tests/creator-hub.spec.ts`) |

---

## AUDIT-FIX checklist (2026-06-06 closeout)

| # | Finding | Fix | Status |
|---|---|---|---|
| 1 | `creator-hub/page.tsx` used weaker gate than layout | Already uses `requireCreatorHubPageAccess` | **DONE** (was fixed pre-closeout) |
| 2 | `add-creator-setup.ts` used `requirePageAccess("/creators")` | Switched to `requireCreatorHubAccess` | **DONE** |
| 3 | `/creator-hub/alerts` redirect had no gate | Added `requireCreatorHubPageAccess` before redirect | **DONE** |
| 4 | `creator_manager` not assignable (enum missing) | Schema + `PERSISTABLE_ADMIN_ROLES` + SQL `20260606_add_creator_manager_role.sql` applied | **DONE** |
| 5 | Layout comment still said `requireRole(admin/creator_manager)` | Updated to `canAccessCreatorHub` | **DONE** |
| 6 | All hub pages gate consistently | Verified — every `page.tsx` uses `requireCreatorHubPageAccess` | **DONE** |
| 7 | Discord channel URL + reward page storage | `creator_socials.discord_channel_url` + `reward_page_url`; Add Creator v2 + Creator tab editor | **DONE** |
| 8 | Forecast tab math | Uses Profitable Algo 7.5% rate; lazy tab; partial states labelled | **DONE** (no code change needed) |
| 9 | Active-timeframe-only on dashboard | `Suspense key={period}` on overview | **DONE** (verified in code) |
| 10 | House-POV colors on financial surfaces | Spot-checked forecast, dashboard KPIs, overview | **DONE** (no regressions found) |

---

## Route inventory (all verified)

| Route | Purpose |
|---|---|
| `/creator-hub` | Dashboard (period KPIs, top creators, charts) |
| `/creator-hub/creators` | Roster grid |
| `/creator-hub/creators/[id]` | Detail + tabs (Overview default; `?tab=` lazy) |
| `/creator-hub/leaderboards` | Live leaderboards |
| `/creator-hub/creator-check` | Kick/Twitter check tool |
| `/creator-hub/acquisition` | Acquisition funnel |
| `/creator-hub/socials-review` | Social post review queue |
| `/creator-hub/profitable-algo` | ROI calculator (no DB) |
| `/creator-hub/changelog` | Creator changelog |
| `/creator-hub/deal-tracker` | Deal timeline |
| `/creator-hub/compare` | Creator compare |
| `/creator-hub/settings` | RapidAPI integration keys |
| `/creator-hub/alerts` | Legacy → redirects to dashboard (alerts in right-rail dock) |
| `/creator-hub/codes-ads` | Affiliate codes + house ads (`?tab=codes` \| `ads`) |

---

## Remaining / deferred (NOT blocking plan closeout)

| Item | Status | Notes |
|---|---|---|
| Packy.gg PFP write on Add Creator | **BLOCKED** | No confirmed MAIN-DB/backend endpoint; ADMIN-only preview OK |
| Bulk delete `/gift-cards` + `/vouchers` | **BLOCKED** | Tables in MAIN DB — write forbidden |
| Admin-DB schema drift (`creator_deals` cashout limits + `creator_deal_estimates`) | **OPEN** | `db push` refuses; owner decision: restore schema or archive+drop |
| `codes-ads` dedicated hub route | **DONE** (`9f0c02f8`) | `/creator-hub/codes-ads` — lazy tabs; ad card detail still links to admin `/creators/ads/[code]` |
| Forecast tab — deal `tip/sponsor allowance` from deal terms | **DONE** (`d629ba09`) | Primary: `(max_tip_per_stream + max_sponsorship_per_stream) × fills_allowed`; fallback: realized lifetime ÷ active weeks when no deal; UI labels source |
| Responsive harness `RESPONSIVE_EXPECT_CLEAN=1` full sweep | **OPEN** | Hub routes not yet in responsive matrix (smoke e2e covers render) |
| Fold durable reward findings into `ONBOARDING.md` | **OPEN** | Affiliate commission basis; signup $5.71 clarification |

---

## Access model (canonical)

```
canAccessCreatorHub =
  username === 'motha'
  OR settings['creator_hub_access_<role>_enabled'] === 'true'
  for any effective role in { admin, creator_manager }
```

- Toggles live in ADMIN DB `admin_settings`; both default **OFF**.
- Fail-closed on DB read failure (only motha bypass survives).
- `creator_manager` is now a persistable `admin_role` enum value.

---

## Key files

| Area | Path |
|---|---|
| Access gate | `src/lib/creator-hub-access.ts`, `src/lib/require-creator-hub-access.ts` |
| Layout + sidebar | `src/app/(creator-hub)/creator-hub/layout.tsx`, `_components/creator-hub-sidebar.tsx` |
| Dashboard queries | `src/app/(creator-hub)/creator-hub/_queries/*` |
| Creator detail tabs | `src/app/(creator-hub)/creator-hub/creators/[id]/*` |
| Integration services | `src/lib/creator-hub/*` |
| Social URL persistence | `src/lib/creator-social-urls.ts` |
| E2E smoke | `e2e/tests/creator-hub.spec.ts` |

---

## Profitable Algo math (owner spec)

```
Generated Value = wager × 7.5%
Deal Spend      = weekly withdraw cap + weekly LB funding + weekly tip/sponsor
Rate of Return  = Generated Value / Deal Spend   (profitable when > 1)
```

Used in: `/creator-hub/profitable-algo`, Forecast tab (`forecast-data.ts`).

---

## DB policy reminder

- **ADMIN DB:** writable; schema via `db push` or `prisma db execute` — **never** `migrate dev` on prod-shaped DB.
- **MAIN DB:** read-only — no writes, no schema changes.

---

*Last updated: 2026-06-06 — codes-ads deferred wave shipped (`9f0c02f8`).*
