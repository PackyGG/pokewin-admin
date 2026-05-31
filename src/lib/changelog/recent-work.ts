/**
 * RECENT_WORK_ENTRIES — curated release history for the admin panel.
 *
 * Source of truth for the "Populate from recent work" button on
 * /changelogs. Each entry is a grouped "what shipped" summary — NOT one
 * row per git commit. The seed action de-dupes by `(published_at, title)`
 * so re-pressing the button after adding new entries to this list only
 * inserts the new ones.
 *
 * HOW TO EXTEND:
 *
 *   1. Add a new object to the bottom of the array (or anywhere — order
 *      doesn't matter, the page sorts by published_at desc).
 *   2. Keep `summary` to a single sentence (the headline shown in bold).
 *   3. `changes` is 3–6 bullets — each describes a user-facing or
 *      developer-facing shipped capability, not the commit message.
 *   4. `category` rules of thumb:
 *        - feature      → wholly new capability / page / surface
 *        - improvement  → enhancement to an existing capability
 *        - fix          → bug fix or correctness repair
 *        - breaking     → behaviour change a user needs to know
 *        - infra        → infra / observability / no user-facing change
 *   5. `publishedAt` is an ISO date (UTC midnight is fine) — the day the
 *      work actually landed on main / the active branch.
 *   6. `version` is optional — leave null unless a real release tag.
 *   7. Press the "Populate from recent work" button on /changelogs as
 *      whichever admin should appear as the author.
 */

import type {
  ChangelogCategory,
  ChangelogChange,
} from "@/lib/changelog/types";

export type RecentWorkEntry = {
  publishedAt: string; // ISO date, e.g. "2026-05-31T00:00:00.000Z"
  title: string;
  summary: string;
  version: string | null;
  category: ChangelogCategory;
  changes: ChangelogChange[];
};

export const RECENT_WORK_ENTRIES: RecentWorkEntry[] = [
  // ──────────────────────────────────────────────────────────────────
  // 2026-05-31 — Resilience pass
  // ──────────────────────────────────────────────────────────────────
  {
    publishedAt: "2026-05-31T00:00:00.000Z",
    title: "Resilience pass — error boundaries, safeQuery, and ServerActionResult",
    summary:
      "A single broken query no longer crashes the page. Tiles render an inline fallback, server actions return structured results, and long-poll widgets self-recover from transient backend hiccups.",
    version: null,
    category: "infra",
    changes: [
      {
        kind: "infra",
        text: "New resilience primitives: safeQuery wraps non-critical reads, ServerActionResult standardises action returns, TileErrorFallback renders inline tile errors, structured logger replaces ad-hoc console calls.",
      },
      {
        kind: "feature",
        text: "Added 6 segment-level error.tsx boundaries so a thrown render error is contained to its segment instead of bubbling to the root.",
      },
      {
        kind: "improvement",
        text: "Wrapped non-critical queries on /dashboard and /users/[id] in safeQuery — page renders with an inline 'tile failed' fallback instead of a 500.",
      },
      {
        kind: "improvement",
        text: "Migrated 5 high-traffic server actions to ServerActionResult so client callers handle errors via typed return values instead of thrown messages.",
      },
      {
        kind: "fix",
        text: "Hardened the live-money-chat and docked-recent-activity polling loops — they back off on transient errors and recover instead of going silent.",
      },
    ],
  },

  // ──────────────────────────────────────────────────────────────────
  // 2026-05-31 — Changelogs page itself
  // ──────────────────────────────────────────────────────────────────
  {
    publishedAt: "2026-05-31T00:00:00.000Z",
    title: "Changelogs page — admin-curated release notes",
    summary:
      "New /changelogs surface with manual entries, sidebar wiring, and a dedicated capability so non-admin roles can publish without full admin rights.",
    version: null,
    category: "feature",
    changes: [
      {
        kind: "feature",
        text: "New page with PageHero, KPI strip (total / month / last published) and a card stack per release.",
      },
      {
        kind: "feature",
        text: "Inline new-entry / edit / delete dialogs with categorized bullets (feature / improvement / fix / breaking / infra).",
      },
      {
        kind: "infra",
        text: "admin_changelog_entries table provisioned via ensureChangelogSchema (the salaries / shifts self-heal pattern) — no Prisma migration needed.",
      },
      {
        kind: "feature",
        text: "New __can_manage_changelog capability so a custom role can publish without being admin.",
      },
    ],
  },

  // ──────────────────────────────────────────────────────────────────
  // 2026-05-31 — Transactions page rebuild + upgrader detail
  // ──────────────────────────────────────────────────────────────────
  {
    publishedAt: "2026-05-31T00:00:00.000Z",
    title: "Transactions overhaul — unified page, Provably Fair detail, upgrader receipts",
    summary:
      "Deposits and Withdrawals collapsed into a single /transactions page with tabs. Upgrader plays are now first-class: click an ID to see the PF ticket, the landed card, the target multiplier, the chance, and the actual roll.",
    version: null,
    category: "feature",
    changes: [
      {
        kind: "feature",
        text: "Unified /transactions page with Deposits + Withdrawals tabs (deposits is the default).",
      },
      {
        kind: "feature",
        text: "New /transactions/[id] detail surfaces Provably Fair rolls — ticket and landed card per spin / draw.",
      },
      {
        kind: "feature",
        text: "Upgrader rows: click ID → popup with PF ticket + card hit + won amount (no full-page navigation).",
      },
      {
        kind: "feature",
        text: "Upgrader metadata parsing — target multiplier, chance, and roll surface on the receipt.",
      },
      {
        kind: "feature",
        text: "Toolbar search/filter + pagination on the global upgrader pool, plus Top multiplier / Top win $ sort buttons.",
      },
      {
        kind: "improvement",
        text: "Withdrawals table swapped Handled By / Tracking / Actions for a focused Crypto column.",
      },
    ],
  },

  // ──────────────────────────────────────────────────────────────────
  // 2026-05-31 — Performance pass
  // ──────────────────────────────────────────────────────────────────
  {
    publishedAt: "2026-05-31T00:00:00.000Z",
    title: "Performance pass — paginated KPIs, deferred /users/[id], collapsed P&L fan-out",
    summary:
      "Big sweep across the heaviest server components. KPI strips now read global stats so they're stable across search / filter / paginate; /users/[id] paints the hero after ~4 queries instead of 14; the rolling P&L ladder collapsed from 20 round-trips to 5.",
    version: null,
    category: "improvement",
    changes: [
      {
        kind: "improvement",
        text: "Every paginated page's KPI strip now reads GLOBAL stats — numbers stay stable across search / paginate / filter / tab switching.",
      },
      {
        kind: "improvement",
        text: "/users/[id] defers 7 per-tab data fetches behind Suspense — hero paints after ~4 queries instead of waiting on all 14.",
      },
      {
        kind: "improvement",
        text: "users-financial rolling P&L ladder: collapsed 4x fan-out into one composite query (20 → 5 round-trips).",
      },
      {
        kind: "improvement",
        text: "/users search routes to index-friendly fast paths instead of full-table ILIKE scans.",
      },
      {
        kind: "improvement",
        text: "Live-money-chat: watermarked idle polls and cached 24h totals; dashboard lifetime queries cached 5 min.",
      },
    ],
  },

  // ──────────────────────────────────────────────────────────────────
  // 2026-05-31 — UUID guards on dynamic routes
  // ──────────────────────────────────────────────────────────────────
  {
    publishedAt: "2026-05-31T00:00:00.000Z",
    title: "UUID shape guards on every dynamic [id] route",
    summary:
      "A crawler or stale link hitting /users/some-non-uuid no longer triggers a Prisma error — every [id] page validates the UUID shape and 404s cleanly.",
    version: null,
    category: "fix",
    changes: [
      {
        kind: "fix",
        text: "Added a UUID shape guard to every dynamic [id] page so invalid ids 404 instead of throwing.",
      },
      {
        kind: "fix",
        text: "/users/[id] split its detail error boundary so a thrown query inside a tab doesn't blank the hero.",
      },
      {
        kind: "fix",
        text: "/users/[id] is now safe against non-UUID ids — direct entry from bad links no longer hits the DB.",
      },
    ],
  },

  // ──────────────────────────────────────────────────────────────────
  // 2026-05-31 — Sidebar / nav restructure
  // ──────────────────────────────────────────────────────────────────
  {
    publishedAt: "2026-05-31T00:00:00.000Z",
    title: "Sidebar restructure — Marketing vs Creator Marketing, Rewards group, slimmed entries",
    summary:
      "Sidebar reorganised so creator tooling sits above campaign tooling. Promo Codes moved to Rewards. Standalone entries that duplicated existing affordances (Deleted Users, Codes, Vouchers) were dropped.",
    version: null,
    category: "improvement",
    changes: [
      {
        kind: "improvement",
        text: "Marketing split into 'Marketing' + 'Creator Marketing' groups; Analytics removed from the sidebar (folded into /analytics).",
      },
      {
        kind: "improvement",
        text: "Creator Marketing now sits above Marketing — creator tooling above generic campaign tooling.",
      },
      {
        kind: "improvement",
        text: "Promo Codes moved to the Rewards group; Marketing Settings dropped to the bottom of its group.",
      },
      {
        kind: "improvement",
        text: "Removed standalone 'Deleted Users' sidebar entry — access is the header button on /users.",
      },
      {
        kind: "improvement",
        text: "Dropped Codes + Vouchers from the sidebar, the role editor, and the CMD+K palette.",
      },
    ],
  },

  // ──────────────────────────────────────────────────────────────────
  // 2026-05-31 — Dashboard right-rail rebuild + 3 widgets
  // ──────────────────────────────────────────────────────────────────
  {
    publishedAt: "2026-05-31T00:00:00.000Z",
    title: "Admin shell — docked Live Money + Chat + Recent Activity right rail",
    summary:
      "The right edge of the admin shell now hosts three docked widgets that follow you on every page: Live Money, Chat, and Recent Activity. The rail reflows when widgets collapse, with an at-most-2-open constraint.",
    version: null,
    category: "feature",
    changes: [
      {
        kind: "feature",
        text: "Docked Live Money + Chat widgets across the whole admin shell (not just /dashboard).",
      },
      {
        kind: "feature",
        text: "Recent Activity docked as the middle right-rail widget; at-most-2 widgets open at once.",
      },
      {
        kind: "feature",
        text: "Right-rail reflows: chat slides up when Live is collapsed, Live expands when Chat is collapsed (symmetric).",
      },
      {
        kind: "feature",
        text: "Clickable rail headers + mini user-preview dialog from LiveMoneyChat rows.",
      },
      {
        kind: "fix",
        text: "Bumped SSE per-user concurrent cap 4 → 16 so multiple admin tabs don't fight each other.",
      },
      {
        kind: "fix",
        text: "Sized the collapsed tabs correctly after the 3-widget rewrite.",
      },
    ],
  },

  // ──────────────────────────────────────────────────────────────────
  // 2026-05-30 — Dashboard upgrader stats + wager attribution chart
  // ──────────────────────────────────────────────────────────────────
  {
    publishedAt: "2026-05-30T00:00:00.000Z",
    title: "Dashboard — Upgrader Stats and Wager Attribution",
    summary:
      "Dedicated Upgrader Stats section with Wins / Losses / Hit Rate tiles, paired 50/50 with a new Wager Attribution chart showing organic vs creator-coded wager share over 30 days.",
    version: null,
    category: "feature",
    changes: [
      {
        kind: "feature",
        text: "Dedicated Upgrader Stats section between KPIs and graphs — Wins / Losses / Hit Rate tiles.",
      },
      {
        kind: "feature",
        text: "Wager Attribution chart — organic vs creator-coded over 30 days, with % display in title + tooltip.",
      },
      {
        kind: "feature",
        text: "Paired Upgrader Stats + Wager Attribution at 50/50; Upgrader Stats redesigned for the half-width slot.",
      },
      {
        kind: "feature",
        text: "Creator Withdrawals KPI tile — period count + $ of withdrawals from creator-role users.",
      },
      {
        kind: "fix",
        text: "Upgrader Stats excludes creator role from all metrics; payouts + wins read from balance delta with a SUM fallback across fields.",
      },
    ],
  },

  // ──────────────────────────────────────────────────────────────────
  // 2026-05-30 — Live deposits/withdrawals feed + period selector
  // ──────────────────────────────────────────────────────────────────
  {
    publishedAt: "2026-05-30T00:00:00.000Z",
    title: "Dashboard — Live Deposits + Withdrawals feed and global period selector",
    summary:
      "Combined Live Deposits + Withdrawals feed lives in a side-by-side layout from lg breakpoint, and the dashboard now has a global period selector that only fetches the selected window.",
    version: null,
    category: "feature",
    changes: [
      {
        kind: "feature",
        text: "Live Deposits + Withdrawals combined feed.",
      },
      {
        kind: "improvement",
        text: "Global period selector — only fetches the selected window instead of all of them.",
      },
      {
        kind: "fix",
        text: "Deposits + Withdrawals render side-by-side from lg (1024px).",
      },
      {
        kind: "improvement",
        text: "Dropped the balance tile, cached lifetime queries 5 min, upgrader is lifetime-only.",
      },
    ],
  },

  // ──────────────────────────────────────────────────────────────────
  // 2026-05-30 — Creators leaderboards + settings
  // ──────────────────────────────────────────────────────────────────
  {
    publishedAt: "2026-05-30T00:00:00.000Z",
    title: "Creators — editable leaderboard prize pool + tab-aware PnL",
    summary:
      "Creator leaderboards now have an editable site-funded prize pool with a strict pool==sum invariant. /creators tab switching uses real Link navigation, drops the search/sort/page params on flip, and the global PnL tile is now tab-aware.",
    version: null,
    category: "feature",
    changes: [
      {
        kind: "feature",
        text: "/creators/leaderboards — editable site-funded prize pool with strict pool==sum enforcement + Scale-tiers helper.",
      },
      {
        kind: "feature",
        text: "/creators global PnL tile is now scoped to the active tab.",
      },
      {
        kind: "feature",
        text: "/creators/[userId] wager-volume breakdown — Packs & Battles vs Upgrader.",
      },
      {
        kind: "feature",
        text: "/creators tab switch moved into the toolbar with Suspense skeleton on swap and a single tab-aware count tile.",
      },
      {
        kind: "fix",
        text: "Creators tab switch uses real Link + drops search / sort / page across the flip.",
      },
      {
        kind: "improvement",
        text: "Affiliate Cut Expiration value now shown at the top of the creator settings card.",
      },
    ],
  },

  // ──────────────────────────────────────────────────────────────────
  // 2026-05-30 — Users page: 7-day delete recovery + sort buttons
  // ──────────────────────────────────────────────────────────────────
  {
    publishedAt: "2026-05-30T00:00:00.000Z",
    title: "Users — 7-day delete-recovery bin and global PnL sort buttons",
    summary:
      "Deleted users are now snapshotted to the admin DB and restorable for 7 days from /users/deleted. The Users page got Top losers / Top winners sort buttons that operate on global PnL, not just the current page.",
    version: null,
    category: "feature",
    changes: [
      {
        kind: "feature",
        text: "7-day delete-recovery bin: snapshot deleted users to the admin DB; restore from /users/deleted within 7 days.",
      },
      {
        kind: "feature",
        text: "Top losers / Top winners sort buttons — operate on global PnL, not just current page.",
      },
      {
        kind: "feature",
        text: "/users/[id] Total Depo tile sits next to P&L in the hero KPI strip; Balances refresh button + Rolling P&L 12h/3d windows.",
      },
      {
        kind: "feature",
        text: "Gaming tab — Won Value + House Profit columns for upgrader_bet rows.",
      },
      {
        kind: "feature",
        text: "Leaderboard Wins now labelled with source leaderboard + click-through.",
      },
      {
        kind: "fix",
        text: "Self-heal /users baseline for support so an accidental role save can't lock them out; users-mini P&L routes through the canonical helper so numbers match /users/[id].",
      },
    ],
  },

  // ──────────────────────────────────────────────────────────────────
  // 2026-05-28 — Analytics: Pure P&L
  // ──────────────────────────────────────────────────────────────────
  {
    publishedAt: "2026-05-28T00:00:00.000Z",
    title: "Analytics — Pure P&L (raw amounts, no creators, no borrow-mode)",
    summary:
      "New 'Pure P&L' analytics view shows raw amounts only with a Lifetime column. Creators and borrow-mode plays are excluded so the number matches the house's actual exposure.",
    version: null,
    category: "feature",
    changes: [
      {
        kind: "feature",
        text: "Dedicated Pure P&L page + tab with raw amounts and a Lifetime column.",
      },
      {
        kind: "feature",
        text: "Pack & Battle Pure P&L section added to the analytics overview.",
      },
      {
        kind: "improvement",
        text: "Renamed to 'Raw P&L' and dropped creators + borrow-mode plays from the source set.",
      },
      {
        kind: "improvement",
        text: "Rewards Analytics: dropped vouchers and surfaced platform daily / weekly leaderboards.",
      },
    ],
  },

  // ──────────────────────────────────────────────────────────────────
  // 2026-05-31 — Cards / Sets / Packs / Employees modernization
  // ──────────────────────────────────────────────────────────────────
  {
    publishedAt: "2026-05-31T00:00:00.000Z",
    title: "Cards / Sets / Packs / Employees — KPI strips + bulk actions",
    summary:
      "Modern pattern (cached KPI strip, SectionHeading shell) rolled out across Cards, Sets, Packs, and the Upgrader page. Cards got bulk multi-select with a move-to-set dialog and inline set creation; Employees gained a Discord Servers section with explicit multi-placement.",
    version: null,
    category: "feature",
    changes: [
      {
        kind: "feature",
        text: "Cards: bulk multi-select + move-to-set dialog with inline set creation.",
      },
      {
        kind: "feature",
        text: "Sets: trimmed UI fields, new Edit dialog, Pokemon / One Piece backfill seed.",
      },
      {
        kind: "feature",
        text: "Packs: cached KPI strip and SectionHeading shell.",
      },
      {
        kind: "feature",
        text: "Employees: Discord Servers section with explicit multi-placement; drag-add of synthetic cards now persists.",
      },
      {
        kind: "feature",
        text: "Upgrader page modernized with hero, KPI strip, and tier panel.",
      },
      {
        kind: "improvement",
        text: "getCardsStats() cached + SectionHeading on /cards.",
      },
    ],
  },

  // ──────────────────────────────────────────────────────────────────
  // 2026-05-31 — Various correctness fixes
  // ──────────────────────────────────────────────────────────────────
  {
    publishedAt: "2026-05-31T00:00:00.000Z",
    title: "Correctness fixes — promo stats, chat mute, P&L attribution",
    summary:
      "Promo Codes stats query no longer references a non-existent column; muting a user with an expires datetime no longer fails Zod silently; creator on-stream upgrader wins are dropped from customer P&L so attribution stays honest.",
    version: null,
    category: "fix",
    changes: [
      {
        kind: "fix",
        text: "Promo Codes stats query referenced a non-existent promo_codes.redemption_count column.",
      },
      {
        kind: "fix",
        text: "Muting a user with an expires datetime silently failed Zod validation.",
      },
      {
        kind: "fix",
        text: "Dropped creator on-stream upgrader wins from customer P&L.",
      },
      {
        kind: "fix",
        text: "Card sales + exchanges drop out of Deposits & Withdrawals.",
      },
      {
        kind: "fix",
        text: "Properly integrated upgrader_games payouts everywhere the ledger misses them.",
      },
    ],
  },
];
