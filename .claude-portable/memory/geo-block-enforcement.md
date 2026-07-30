---
name: geo-block-enforcement
description: "How the whole-site country geo-block works, and the CF-bypass-secret gotcha that made it silently never apply"
metadata: 
  node_type: memory
  type: reference
  originSessionId: d4f148e1-2501-4456-97ae-4eb29709a862
  modified: 2026-07-21T21:05:37.025Z
---

**Whole-site country block is enforced ONLY by the frontend middleware** `PackyGG/frontend` `src/proxy.ts` (Next 16 renamed middleware→`proxy.ts`; it DOES build/run — prod build shows `ƒ Proxy (Middleware)`; the legacy `.next/**/middleware-manifest.json` is empty in Next 16, a red herring). It does a server-side `GET ${BACKEND_URL}/country-restrictions`, reads `data.blocked`, redirects to `/blocked`. The `country_restrictions` cookie caches the result. Per-function restrictions (physical/digital withdrawal, gift-card/promo deposit, `locked_*` arrays) are a SEPARATE path — client `useCountryRestrictions` hook + backend route checks — so they can work while the whole-site block is broken.

Backend resolution is correct: `getRestrictionsForLocation({countryCode, stateCode})` (`repository/countryRestrictions.ts`) merges country + `US-{STATE}` rows, `blocked = base||override`; route `routes/v1/misc/country-restrictions.ts` returns it; geolocation returns MaxMind 2-letter `isoCode` (e.g. `"DE"`, matches DB, upper-cased). Config: admin `system/geo-blocking` writes `country_restrictions.blocked` in MAIN db.

**DUAL DB + CACHING is the real trap (2026-07-21 incident, "enabled DE, still not blocked on dev"):** there are TWO game DBs — `DATABASE_URL` (prod) and `DEV_DATABASE_URL` (dev). The admin `system/geo-blocking` writes to whichever the admin's prod/dev switch (`admin_db_env` cookie) points at; the dev site's backend (`dev.fdsfi.com`) reads the DEV db. So a block toggled against prod won't apply on the dev site and vice-versa — the two DE rows diverged live (prod `blocked=false`, dev `blocked=true`) and were being toggled actively. Layer on caching: the browser `country_restrictions` cookie (1-day maxAge) AND the backend Redis flags cache (`country_restriction:*` / `country_restriction_flags:*`, 1-HOUR TTL, `repository/countryRestrictions.ts`). Diagnose via the cookie value: countryCode=`DE`, blocked=`false`, restrictions all-`true` = the "no row / defaults" or stale shape. Open question if a dev toggle doesn't take effect: does the admin's `invalidateCountryRestrictionsCache()` call hit the DEV backend or only prod?

**MIS-DIAGNOSIS to NOT repeat:** the middleware DOES run and its `/country-restrictions` fetch SUCCEEDS (the cookie is only written on success → proves CF is NOT 403-ing it). CF-bypass PR #739 (adds `x-bypass-secret` to that fetch, matching waitlist + `/api/backend`) is harmless consistency but was NOT the bug — I initially claimed it was, wrongly. Backend IS Cloudflare-fronted so the bypass is defensively correct, just not the fix. PR #737 (soft/RSC nav re-check of the cached cookie) is a real secondary caching fix. See [[feedback_repo_scope_boundary]] (frontend PRs → `dev`).
