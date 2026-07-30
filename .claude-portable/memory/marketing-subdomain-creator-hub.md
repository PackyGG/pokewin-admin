---
name: marketing-subdomain-creator-hub
description: marketing.packydash.com is a SEGMENT host owning /creator-hub (clean URLs); Hub redesigned to flat standard 2026-07-29
metadata: 
  node_type: memory
  type: project
  originSessionId: ee2803a1-a012-4949-8f2f-8da123310038
  modified: 2026-07-28T22:19:23.494Z
---

Since 2026-07-28/29, `marketing.packydash.com` is a SEGMENT host in `src/lib/app-hosts.ts` with `basePath: "/creator-hub"` (like packs./fraud.) — the subdomain serves the Creator Hub with the `/creator-hub` prefix stripped from visible URLs (`/creators`, `/leaderboards`, …). Old prefixed links 308-redirect. Sidebar/tab switchers/checklist dock are host-aware (`useHostHref`/`hrefFrom`).

The whole Hub was redesigned to the flat house standard (2026-07-29, 11 commits): `KpiTile` everywhere (gained a `live` prop; `HubKpiBox` is deprecated but the file still exists), shared primitives `HubNotice`/`HubEmptyState`/`HubErrorPage`/`HubPagination` in `creator-hub/_components/`, page identity = `SectionHeading` (no hero titles — owner removed those app-wide), sectioned sidebar nav (Overview / Creators / Programs & Payouts / Economics), dashboard split by time contract (period-keyed band vs fixed 30d/28d bands).

**How to apply:** new Hub pages/consumers must use these primitives, keep links in-hub, one skeleton module per page shared by loading.tsx + Suspense fallback. Cleanup candidate: delete `hub-kpi-box.tsx` once nothing imports it.
