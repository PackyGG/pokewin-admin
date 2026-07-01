// Single shared navigation config — the ONE source of truth for the
// sidebar (`src/components/app-sidebar.tsx`), the command palette
// (`src/lib/commands.ts`), and the `/system/commands` docs grouping.
//
// Before this module those three lists drifted independently. Now they all
// DERIVE from `NAV_ENTRIES` below, so adding/moving a route in one place
// surfaces it everywhere consistently.
//
// Relationship to the permission system:
//   - `src/lib/admin-pages.ts` (`ADMIN_PAGES`) stays the authoritative
//     source of grantable permission KEYS (`requirePageAccess(key)`). This
//     module references those keys via `pageKey`; it does not replace them.
//   - The sidebar today gates each item by matching its `href` against the
//     user's `allowed_pages`. For every sidebar item that gate string IS the
//     item's `pageKey` (see the per-item entries below — every in-sidebar
//     entry has `href === pageKey`, the only exceptions being palette-only
//     tabbed routes like Map where `href` carries a `?tab=` suffix and the
//     item is not in the sidebar). The sidebar therefore now gates on
//     `pageKey`, which reproduces today's behavior exactly.
//
// This file is imported from both a Client Component (palette + sidebar) and
// a Server Component (docs page), so it must stay dependency-free — no
// `"use client"`, no server-only modules. Icons are referenced as string
// keys (resolved to `lucide-react` components by each consumer) so this
// module ships zero icon imports and serializes across the RSC boundary.

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Group ordering + group-level visibility metadata. Order here is the order
 *  the sidebar renders groups (and the docs page mirrors it). */
export type NavGroupKey =
  | "Overview"
  | "Insights"
  | "Employees"
  | "Content"
  | "Rewards"
  | "Creator Portal"
  | "Test Tools"
  | "System";

export type NavGroupMeta = {
  label: NavGroupKey;
  /** Only rendered for the `creator` role (the Creator Portal group). */
  creatorOnly?: boolean;
  /** Only rendered while the admin's main-DB cookie points at `dev`. */
  devEnvOnly?: boolean;
};

export type NavEntry = {
  /** Stable id — also the command-palette command id (e.g. `nav.dashboard`). */
  id: string;
  /** Sidebar / docs group this entry belongs to. */
  group: NavGroupKey;
  /** Canonical (sidebar) label. */
  label: string;
  /** Navigation target. May carry a `?tab=` suffix for tabbed palette items. */
  href: string;
  /**
   * Permission key (an `ADMIN_PAGES.key`) that gates visibility. The sidebar
   * matches this against the user's `allowed_pages`; the palette filters on
   * it too. For tabbed routes `href` can differ from `pageKey` (e.g. Map:
   * href `/analytics?tab=map`, pageKey `/analytics`).
   */
  pageKey: string;
  /** Icon string key — resolved to a `lucide-react` component by consumers.
   *  This is the icon the command palette uses. */
  icon: string;
  /** Sidebar icon override. When set, the sidebar renders this instead of
   *  `icon` (for the two routes where the sidebar historically used a
   *  different icon than the palette: Transactions/Deposits and Roles). */
  sidebarIcon?: string;
  /** Palette label override, where the palette historically used a more
   *  descriptive label than the sidebar (e.g. "Pack Transactions"). */
  paletteLabel?: string;
  /** Palette one-line description. */
  description?: string;
  /** Fuzzy-match keywords (palette). */
  keywords?: string[];
  /** Username allowlist (case-insensitive) — sidebar-only cosmetic gate on
   *  top of the route's own server-side guard (e.g. Salaries, Excluded Users). */
  usernameAllowlist?: string[];
  /** Renders a "NEW" badge in the sidebar. */
  isNew?: boolean;
  /** Surfaces in the sidebar. */
  inSidebar: boolean;
  /** Pinned to the sidebar footer, directly above the theme toggle. */
  inSidebarFooter?: boolean;
  /** Surfaces in the command palette navigation section. */
  inPalette: boolean;
};

// ---------------------------------------------------------------------------
// Group order + metadata (sidebar render order)
// ---------------------------------------------------------------------------

export const NAV_GROUP_META: NavGroupMeta[] = [
  { label: "Overview" },
  { label: "Insights" },
  { label: "Content" },
  { label: "Rewards" },
  { label: "Creator Portal", creatorOnly: true },
  { label: "Test Tools", devEnvOnly: true },
  // Owner: "move employees over system overview" — the Employees group now
  // sits directly above the System group (its previous slot was higher up,
  // between Insights and Content).
  { label: "Employees" },
  { label: "System" },
];

// ---------------------------------------------------------------------------
// The single nav entry list.
//
// Every entry that historically lived in the sidebar has `inSidebar: true`;
// every entry that historically lived in the palette `NAV_COMMANDS` has
// `inPalette: true`. Entries in both carry both flags. `paletteLabel`
// preserves the palette's distinct labels where they differed from the
// sidebar's.
// ---------------------------------------------------------------------------

/**
 * Owner-only — applied to every entry in the Insights sidebar group. The
 * sidebar treats `usernameAllowlist` as a cosmetic gate that ANY owner bypasses
 * (see `AppSidebar`'s `isOwner` prop), so this list is just the permanent root
 * owner; the live audience is "any owner". The routes enforce
 * `requireInsightsOwner` (now owner-gated) server-side.
 */
const INSIGHTS_USERNAME_ALLOWLIST = ["motha"] as const;

const RAW_NAV_ENTRIES: NavEntry[] = [
  // ── Overview ──────────────────────────────────────────────────────────
  {
    id: "nav.dashboard",
    group: "Overview",
    label: "Dashboard",
    href: "/dashboard",
    pageKey: "/dashboard",
    icon: "LayoutDashboard",
    description: "Platform overview",
    keywords: ["home", "overview"],
    inSidebar: true,
    inPalette: true,
  },
  {
    // Roadmap — internal product-planning month calendar. Each block is a
    // planned feature; the detail page links Linear issues, detail fields,
    // notes and resources. Icon `CalendarRange` MUST be registered in the
    // ICONS map in `src/components/app-sidebar.tsx` (React #130) and, since
    // `inPalette: true`, the id MUST also appear in PALETTE_ORDER (lockstep).
    id: "nav.roadmap",
    group: "Overview",
    label: "Roadmap",
    href: "/roadmap",
    pageKey: "/roadmap",
    icon: "CalendarRange",
    description: "Plan features on a calendar; link Linear tasks",
    keywords: ["roadmap", "calendar", "plan", "feature", "linear", "product"],
    isNew: true,
    inSidebar: true,
    inPalette: true,
  },
  {
    id: "nav.analytics",
    group: "Overview",
    label: "Analytics",
    href: "/analytics",
    pageKey: "/analytics",
    icon: "BarChart3",
    description: "GGR, NGR, PnL charts",
    keywords: ["metrics", "chart", "ggr", "ngr", "pnl"],
    inSidebar: true,
    inPalette: true,
  },
  {
    // One Piece — dedicated overview of the One Piece pack pool: lifetime
    // stats, per-pack insights and a daily opens/revenue trend. Icon `Anchor`
    // MUST be registered in the ICONS map in `src/components/app-sidebar.tsx`
    // (React #130) and, since `inPalette: true`, the id MUST also appear in
    // PALETTE_ORDER (lockstep).
    id: "nav.one-piece",
    group: "Overview",
    label: "One Piece",
    href: "/one-piece",
    pageKey: "/one-piece",
    icon: "Anchor",
    description: "One Piece pack pool stats, insights & daily trend",
    keywords: ["one piece", "onepiece", "packs", "pool", "pirate", "anchor"],
    isNew: true,
    inSidebar: true,
    inPalette: true,
  },
  {
    // Map — palette-only. /map was folded into /analytics as a tab; the
    // palette still surfaces it (routing through the analytics shell) but the
    // sidebar dropped the standalone link. href carries the tab; permission
    // inherits from /analytics.
    id: "nav.map",
    group: "Overview",
    label: "Map",
    href: "/analytics?tab=map",
    pageKey: "/analytics",
    icon: "Globe",
    description: "Geographic user distribution",
    keywords: ["geo", "world", "country"],
    inSidebar: false,
    inPalette: true,
  },
  {
    id: "nav.users",
    group: "Overview",
    label: "Users",
    href: "/users",
    pageKey: "/users",
    icon: "Users",
    description: "Browse end-users",
    keywords: ["players", "accounts", "search"],
    inSidebar: true,
    inPalette: true,
  },
  {
    id: "nav.creators",
    group: "Overview",
    label: "Creators",
    href: "/creators",
    pageKey: "/creators",
    icon: "Tv",
    sidebarIcon: "Tv",
    description: "Affiliate creator directory",
    keywords: ["affiliate", "influencer", "creator"],
    inSidebar: true,
    inPalette: true,
  },
  {
    // Player CRM — palette-only. /crm was folded into the (owner-only)
    // Insights Overview as a tab; the standalone /crm route now 308-redirects
    // to ?tab=crm and the sidebar dropped the standalone link. href carries
    // the tab; permission INHERITS from /insights/real-numbers — which is
    // owner-only (the Insights layout enforces requireInsightsOwner), so the
    // palette filters this entry out for non-owners by pageKey. Icon string
    // `PieChart` MUST be registered in the ICONS map in
    // `src/components/app-sidebar.tsx` (React #130) and, since
    // `inPalette: true`, the id MUST also appear in PALETTE_ORDER (lockstep).
    id: "nav.crm",
    group: "Overview",
    label: "Player CRM",
    href: "/insights/real-numbers?tab=crm",
    pageKey: "/insights/real-numbers",
    icon: "PieChart",
    description: "Lifecycle, value tiers & win-back targets",
    keywords: ["crm", "segment", "segmentation", "lifecycle", "vip", "whale", "retention", "cohort"],
    inSidebar: false,
    inPalette: true,
  },
  {
    // Sidebar label is "Transactions" (the unified deposits+withdrawals
    // surface); palette label is "Deposits". Same href/pageKey.
    id: "nav.deposits",
    group: "Overview",
    label: "Transactions",
    paletteLabel: "Deposits",
    href: "/transactions/deposits",
    pageKey: "/transactions/deposits",
    // Base `icon` is the palette icon; `sidebarIcon` overrides it in the
    // sidebar. The palette historically used ArrowDownToLine for Deposits;
    // the sidebar uses Receipt for the unified Transactions entry.
    icon: "ArrowDownToLine",
    sidebarIcon: "Receipt",
    description: "Deposit & withdrawal ledger",
    keywords: ["crypto", "payments"],
    inSidebar: true,
    inPalette: true,
  },
  // Withdrawals palette entry removed — the money-out figure/queue is no
  // longer surfaced in navigation (owner request). The /withdrawals route
  // still 308-redirects to the unified Transactions page (next.config.ts) and
  // its permission key stays in ADMIN_PAGES, but there is no nav/palette entry.
  {
    // Physical Withdrawals — real-world card-shipment availability controls
    // (global withdrawals master switch + per-country physical toggle) and the
    // fulfillment queue. The intended main page once physical withdrawals go
    // live. Icon string `Package` is already registered in the ICONS map in
    // `src/components/app-sidebar.tsx` (React #130); since `inPalette: true`,
    // the id is also added to PALETTE_ORDER (lockstep).
    id: "nav.physical",
    group: "Overview",
    label: "Physical",
    href: "/physical",
    pageKey: "/physical",
    icon: "Package",
    description: "Physical card-withdrawal availability & fulfillment",
    keywords: ["physical", "shipping", "shipment", "fulfillment", "cards", "payout", "withdrawal"],
    isNew: true,
    inSidebar: true,
    inPalette: true,
  },

  // ── Insights (sidebar-only; absent from palette today) ─────────────────
  {
    // Insights Overview — the source-of-truth "Real Numbers" page is now the
    // Insights landing. The former standalone /insights hub page was removed;
    // /insights 308-redirects here (next.config.ts). Labeled "Overview" in the
    // sidebar (it's the section landing) but keeps its own /insights/real-numbers
    // route + permission key. Icon `Sigma` is registered in the ICONS map in
    // `src/components/app-sidebar.tsx` (no React #130 risk). Sits first in the
    // group so the section landing is reachable directly from the sidebar. The
    // Cost Breakdown page (route kept) is reachable via a link on this page; it
    // no longer has its own sidebar entry.
    id: "nav.insights.real-numbers",
    group: "Insights",
    label: "Overview",
    href: "/insights/real-numbers",
    pageKey: "/insights/real-numbers",
    icon: "Sigma",
    isNew: true,
    inSidebar: true,
    inPalette: false,
  },
  {
    // Numbers — signup-method breakdown. Moved here from the Overview group
    // (owner: "move numbers page from overview to insights"). Same /numbers
    // route + permission key; only the sidebar/palette grouping changed. Icon
    // `Hash` is registered in the ICONS map in `src/components/app-sidebar.tsx`.
    id: "nav.numbers",
    group: "Insights",
    label: "Numbers",
    href: "/numbers",
    pageKey: "/numbers",
    icon: "Hash",
    description: "Signup method breakdown",
    keywords: ["signups", "registration", "email", "discord", "google", "steam", "auth"],
    inSidebar: true,
    inPalette: true,
  },
  {
    id: "nav.insights.rewards",
    group: "Insights",
    label: "Rewards",
    href: "/insights/rewards",
    pageKey: "/insights/rewards",
    icon: "Gift",
    isNew: true,
    inSidebar: true,
    inPalette: false,
  },
  {
    // Affiliate Codes — read-only lookup of an affiliate code or its owner
    // (earnings / claimable balance / referrals) + two audited admin-only
    // write actions. Icon `Ticket` is already registered in the ICONS map
    // in `src/components/app-sidebar.tsx` (no React #130 risk).
    id: "nav.insights.affiliate-codes",
    group: "Insights",
    label: "Affiliate Codes",
    href: "/insights/affiliate-codes",
    pageKey: "/insights/affiliate-codes",
    icon: "Ticket",
    description: "Look up an affiliate code or its owner",
    keywords: ["affiliate", "code", "referral", "promo", "owner", "claim"],
    isNew: true,
    inSidebar: true,
    inPalette: true,
  },
  {
    // Double Down — read-only tracking of the gamble-your-battle-winnings
    // feature (accept rate, win/lose, House-POV P&L + full audit log). Icon
    // `Dices` is registered in the ICONS map in
    // `src/components/app-sidebar.tsx` (required — React #130 otherwise).
    id: "nav.insights.double-down",
    group: "Insights",
    label: "Double Down",
    href: "/insights/double-down",
    pageKey: "/insights/double-down",
    icon: "Dices",
    description: "Track gamble-your-winnings rounds — who won / lost + P&L",
    keywords: ["double", "down", "gamble", "battle", "winnings", "wager"],
    isNew: true,
    inSidebar: true,
    inPalette: true,
  },
  {
    id: "nav.insights.rewards.deposit-bonus",
    group: "Insights",
    label: "Deposit Bonus",
    href: "/insights/rewards/deposit-bonus",
    pageKey: "/insights/rewards/deposit-bonus",
    icon: "Coins",
    isNew: true,
    inSidebar: false,
    inPalette: false,
  },
  {
    id: "nav.insights.rewards.rakeback",
    group: "Insights",
    label: "Rakeback",
    href: "/insights/rewards/rakeback",
    pageKey: "/insights/rewards/rakeback",
    icon: "Wallet",
    isNew: true,
    inSidebar: false,
    inPalette: false,
  },
  {
    id: "nav.insights.rewards.expiry",
    group: "Insights",
    label: "Reward Expiry",
    href: "/insights/rewards/expiry",
    pageKey: "/insights/rewards/expiry",
    icon: "Hourglass",
    isNew: true,
    inSidebar: false,
    inPalette: false,
  },
  {
    id: "nav.insights.rewards.race",
    group: "Insights",
    label: "Race",
    href: "/insights/rewards/race",
    pageKey: "/insights/rewards/race",
    icon: "Flag",
    isNew: true,
    inSidebar: false,
    inPalette: false,
  },
  {
    id: "nav.insights.rewards.affiliate",
    group: "Insights",
    label: "Affiliate",
    href: "/insights/rewards/affiliate",
    pageKey: "/insights/rewards/affiliate",
    icon: "Share2",
    isNew: true,
    inSidebar: false,
    inPalette: false,
  },
  {
    // Forecast — unified reward-forecast hub (scenario simulation per
    // reward type, anchored on real production baselines).
    id: "nav.insights.forecast",
    group: "Insights",
    label: "Forecast",
    href: "/insights/forecast",
    pageKey: "/insights/forecast",
    icon: "Gauge",
    description: "Model reward programs before shipping a change",
    keywords: ["forecast", "scenario", "simulate", "deposit bonus", "what-if"],
    isNew: true,
    inSidebar: true,
    inPalette: true,
  },

  {
    // Creator Analytics — palette-only (no sidebar link).
    id: "nav.creators.analytics",
    group: "Overview",
    label: "Creator Analytics",
    href: "/creators/analytics",
    pageKey: "/creators/analytics",
    icon: "BarChart3",
    description: "Creator performance",
    inSidebar: false,
    inPalette: true,
  },

  // ── Employees ──────────────────────────────────────────────────────────
  {
    // Salaries — sidebar-only, founder username-gated. Not in ADMIN_PAGES
    // (the page enforces requireMotha server-side); pageKey set to "/salaries"
    // to preserve today's sidebar gate (isAdmin || allowed_pages includes it,
    // which non-admins never have → effectively admin+username gated).
    id: "nav.salaries",
    group: "Employees",
    label: "Salaries",
    href: "/salaries",
    pageKey: "/salaries",
    icon: "Coins",
    // Owner-only now (was the founder username allowlist motha/void/kotha). The
    // sidebar lets ANY owner bypass this cosmetic gate (`isOwner` prop), so the
    // list is just the permanent root owner; void/kotha no longer see the link
    // (the route's `requireMotha` is owner-gated and would redirect them).
    usernameAllowlist: ["motha"],
    inSidebar: true,
    inPalette: false,
  },
  {
    // Employee Board — sidebar-only.
    id: "nav.employees",
    group: "Employees",
    label: "Employee Board",
    href: "/employees",
    pageKey: "/employees",
    icon: "Network",
    inSidebar: true,
    inPalette: false,
  },
  {
    id: "nav.shifts",
    group: "Employees",
    label: "Shifts",
    href: "/shifts",
    pageKey: "/shifts",
    icon: "CalendarClock",
    description: "Weekly support rota",
    keywords: ["schedule", "rota", "shift", "team", "planner", "support"],
    inSidebar: true,
    inPalette: true,
  },

  // ── Content ────────────────────────────────────────────────────────────
  {
    id: "nav.packs",
    group: "Content",
    label: "Packs",
    href: "/packs",
    pageKey: "/packs",
    icon: "Package",
    description: "Pack catalog",
    inSidebar: true,
    inPalette: true,
  },
  {
    // Shard packs — packs bought & opened with shards (a wager-earned
    // currency). Free-roll cards into inventory like reward packs.
    id: "nav.rewards.shards",
    group: "Content",
    label: "Shard Packs",
    href: "/rewards/shards",
    pageKey: "/rewards/shards",
    icon: "Gem",
    description: "Packs players buy & open with shards",
    keywords: ["shard", "shards", "pack", "currency", "wager", "free-roll"],
    inSidebar: true,
    inPalette: true,
  },
  {
    id: "nav.cards",
    group: "Content",
    label: "Cards",
    href: "/cards",
    pageKey: "/cards",
    icon: "Layers",
    description: "Card catalog",
    inSidebar: true,
    inPalette: true,
  },
  {
    // Sets — sidebar-only.
    id: "nav.sets",
    group: "Content",
    label: "Sets",
    href: "/sets",
    pageKey: "/sets",
    icon: "Library",
    isNew: true,
    inSidebar: true,
    inPalette: false,
  },
  {
    // Upgrader (catalog) — sidebar-only.
    id: "nav.upgrader",
    group: "Content",
    label: "Upgrader",
    href: "/upgrader",
    pageKey: "/upgrader",
    icon: "ArrowUpCircle",
    isNew: true,
    inSidebar: true,
    inPalette: false,
  },

  // ── Transactions (merged into Content) ─────────────────────────────────
  // Owner: "merge each catalog + its matching transactions page into ONE page
  // with a switch tab". The Pack-Transactions and Upgrader-Transactions
  // surfaces are now TABS of the Packs (/packs?tab=transactions) and Upgrader
  // (/upgrader?tab=transactions) catalog pages respectively, so their former
  // standalone sidebar entries were removed (the routes /transactions/packs
  // and /transactions/upgrader 308-redirect to the tabbed pages — see
  // next.config.ts). Their permission keys (/transactions/packs,
  // /transactions/upgrader) are PRESERVED and now gate the Transactions tab.
  //
  // Battles and Reward Transactions have NO catalog counterpart in Content, so
  // they stay as their own standalone Content sidebar entries.
  {
    id: "nav.battles",
    group: "Content",
    label: "Battles",
    href: "/battles",
    pageKey: "/battles",
    icon: "Swords",
    description: "Pack battle directory",
    inSidebar: true,
    inPalette: true,
  },
  {
    id: "nav.transactions.rewards",
    group: "Content",
    label: "Reward Transactions",
    href: "/transactions/rewards",
    pageKey: "/transactions/rewards",
    icon: "Receipt",
    inSidebar: true,
    inPalette: true,
  },

  // ── Rewards ────────────────────────────────────────────────────────────
  {
    // Legacy per-category stats — redirects to /insights/rewards/*.
    id: "nav.rewards.analytics",
    group: "Rewards",
    label: "Analytics",
    href: "/rewards/analytics",
    pageKey: "/rewards/analytics",
    icon: "BarChart3",
    inSidebar: false,
    inPalette: false,
  },
  {
    id: "nav.rewards",
    group: "Rewards",
    label: "Rewards",
    href: "/rewards",
    pageKey: "/rewards",
    icon: "Award",
    inSidebar: true,
    inPalette: true,
  },
  {
    // Deposit Bonus — tracks the rebuilt affiliate deposit bonus (fixed 5%
    // of each deposit, capped per rolling window) + the empirical savings
    // vs the old regime. Icon string "Coins" is already in the sidebar
    // ICONS map (app-sidebar.tsx), so no React #130 risk.
    id: "nav.rewards.deposit-bonus",
    group: "Rewards",
    label: "Deposit Bonus",
    href: "/rewards/deposit-bonus",
    pageKey: "/rewards/deposit-bonus",
    icon: "Coins",
    description: "Deposit-bonus spend + savings vs the old system",
    keywords: ["deposit", "bonus", "deposit bonus", "affiliate bonus", "savings"],
    inSidebar: true,
    inPalette: true,
  },
  {
    // XP Sales — global view of every xp_purchase (users buying XP with
    // their own withdrawable balance). Moved here from the Overview group
    // (owner: relocate XP Sales under Rewards). Same /xp-sales route +
    // permission key; only the sidebar/palette grouping changed. "Sparkles"
    // is already in the sidebar ICONS map (app-sidebar.tsx), so no React #130
    // risk.
    id: "nav.xp-sales",
    group: "Rewards",
    label: "XP Sales",
    href: "/xp-sales",
    pageKey: "/xp-sales",
    icon: "Sparkles",
    description: "XP purchases — balance spent on XP",
    keywords: ["xp", "experience", "level", "xp purchase", "xp_purchase", "sales"],
    inSidebar: true,
    inPalette: true,
  },
  {
    id: "nav.rewards.rakeback",
    group: "Rewards",
    label: "Rakeback",
    href: "/rewards/rakeback",
    pageKey: "/rewards/rakeback",
    icon: "Percent",
    inSidebar: true,
    inPalette: true,
  },
  {
    // Shard Pack Opens — opens of shard-bought packs (shards spent + shards
    // won per open) from the coin_transactions ledger. Icon string
    // `PackageOpen` MUST be registered in the ICONS map in
    // `src/components/app-sidebar.tsx` (React #130) — it is.
    id: "nav.rewards.shard-opens",
    group: "Rewards",
    label: "Shard Pack Opens",
    href: "/rewards/shard-opens",
    pageKey: "/rewards/shard-opens",
    icon: "PackageOpen",
    description: "Opens of shard-bought packs — shards spent & won per open",
    keywords: ["shard", "shards", "open", "opens", "pack", "currency", "wager"],
    isNew: true,
    inSidebar: true,
    inPalette: true,
  },
  {
    // Promo Codes — sidebar uses the Tag icon. Palette has it too.
    id: "nav.promo",
    group: "Rewards",
    label: "Promo Codes",
    href: "/promo-codes",
    pageKey: "/promo-codes",
    icon: "Tag",
    description: "Bonus code directory",
    keywords: ["coupons", "bonus"],
    inSidebar: true,
    inPalette: true,
  },
  {
    // Challenges — game challenge directory (card-hit / upgrader-hit). All
    // challenge data lives in the MAIN game DB and is read/written via the
    // backend admin API; this admin panel never touches it via Prisma. Icon
    // string `Target` MUST be registered in the ICONS map in
    // `src/components/app-sidebar.tsx`.
    id: "nav.challenges",
    group: "Rewards",
    label: "Challenges",
    href: "/challenges",
    pageKey: "/challenges",
    icon: "Target",
    description: "Game challenges — card-hit & upgrader-hit prizes",
    keywords: ["challenge", "challenges", "quest", "objective", "prize"],
    isNew: true,
    inSidebar: true,
    inPalette: true,
  },
  {
    id: "nav.rain",
    group: "Rewards",
    label: "Rain",
    href: "/rain",
    pageKey: "/rain",
    icon: "CloudRain",
    inSidebar: true,
    inPalette: true,
  },
  {
    // Rewards Leaderboards (wager/race board). Palette adds the "races"
    // keyword so the legacy term still finds it.
    id: "nav.rewards.leaderboards",
    group: "Rewards",
    label: "Leaderboards",
    href: "/rewards/leaderboards",
    pageKey: "/rewards/leaderboards",
    icon: "Trophy",
    keywords: ["races"],
    inSidebar: true,
    inPalette: true,
  },
  {
    id: "nav.rewards.level-up",
    group: "Rewards",
    label: "Level Up",
    href: "/rewards/level-up",
    pageKey: "/rewards/level-up",
    icon: "TrendingUp",
    inSidebar: true,
    inPalette: true,
  },
  {
    id: "nav.rewards.giveaway",
    group: "Rewards",
    label: "Giveaway",
    href: "/marketing/giveaway",
    pageKey: "/marketing/giveaway",
    icon: "Gift",
    inSidebar: true,
    inPalette: false,
  },
  {
    // Affiliate tier + commission config (/creators/settings).
    id: "nav.creators.settings",
    group: "Rewards",
    label: "Affiliate",
    paletteLabel: "Creator Settings",
    href: "/creators/settings",
    pageKey: "/creators/settings",
    icon: "Share2",
    description: "Affiliate level tiers, commission rates, and policies",
    keywords: ["affiliate", "creator", "commission", "tiers"],
    inSidebar: true,
    inPalette: true,
  },
  {
    // Reward Settings — sidebar group "Rewards" labeled "Settings"; palette
    // labels it "Reward Settings".
    id: "nav.rewards.settings",
    group: "Rewards",
    label: "Settings",
    paletteLabel: "Reward Settings",
    href: "/rewards/settings",
    pageKey: "/rewards/settings",
    icon: "Settings",
    inSidebar: true,
    inPalette: true,
  },

  // ── Creator Portal (creator-only group) ────────────────────────────────
  {
    id: "nav.my-profile",
    group: "Creator Portal",
    label: "My Profile",
    href: "/my-profile",
    pageKey: "/my-profile",
    icon: "UserCircle",
    description: "Creator self-service",
    inSidebar: true,
    inPalette: true,
  },

  // ── Test Tools (dev-env-only group; sidebar-only) ──────────────────────
  {
    id: "nav.test.creator",
    group: "Test Tools",
    label: "Creator Testing",
    href: "/test/creator",
    pageKey: "/test/creator",
    icon: "FlaskConical",
    inSidebar: true,
    inPalette: false,
  },

  // ── System ─────────────────────────────────────────────────────────────
  {
    id: "nav.security",
    group: "System",
    label: "Security",
    href: "/security",
    pageKey: "/security",
    icon: "Shield",
    description: "Site security config",
    inSidebar: true,
    inPalette: true,
  },
  {
    // Admins & Access — the unified staff-administration surface (admin
    // accounts + roles & permissions, merged into one tabbed page). The
    // standalone "Roles" entry was removed; roles live on the admin-only
    // Roles tab of this page (/admin-users?tab=roles). Icon `ShieldCheck`
    // is registered in the ICONS map in `src/components/app-sidebar.tsx`.
    id: "nav.admin-users",
    group: "System",
    label: "Admins & Access",
    href: "/admin-users",
    pageKey: "/admin-users",
    icon: "ShieldCheck",
    description: "Admin accounts, roles & permissions",
    keywords: ["admin", "users", "roles", "permissions", "access", "staff"],
    inSidebar: true,
    inPalette: true,
  },
  {
    // Geo Blocking — per-country deposit / withdrawal restrictions
    // (formerly the "Country Restrictions" section of the removed /settings
    // page). Icon string `Globe` is already registered in the ICONS map in
    // `src/components/app-sidebar.tsx` (no React #130 risk).
    id: "nav.geo-blocking",
    group: "System",
    label: "Geo Blocking",
    href: "/system/geo-blocking",
    pageKey: "/system/geo-blocking",
    icon: "Globe",
    description: "Per-country deposit & withdrawal restrictions",
    keywords: ["country", "geo", "block", "restriction", "region"],
    inSidebar: true,
    inPalette: true,
  },
  {
    // Excluded Users — sidebar-only, motha username-gated. Not in ADMIN_PAGES
    // as the security boundary (page + actions enforce requireExcludedUsersAccess
    // server-side); listed in ADMIN_PAGES only so the key isn't "unknown".
    // pageKey set to "/system/excluded-users" preserves today's sidebar gate.
    id: "nav.system.excluded-users",
    group: "System",
    label: "Excluded Users",
    href: "/system/excluded-users",
    pageKey: "/system/excluded-users",
    icon: "Ban",
    usernameAllowlist: ["motha"],
    inSidebar: true,
    inPalette: false,
  },
  {
    id: "nav.audit",
    group: "System",
    label: "Audit Log",
    href: "/audit",
    pageKey: "/audit",
    icon: "FileText",
    description: "Every admin action, searchable",
    keywords: ["log", "history"],
    inSidebar: true,
    inPalette: true,
  },
  {
    // Monitor — health/overview of the standalone backend-monitor service.
    // Icon string `Activity` MUST be registered in the ICONS map in
    // `src/components/app-sidebar.tsx` (React #130) — it is. `inPalette: true`
    // so it must also appear in PALETTE_ORDER below (lockstep).
    id: "nav.system.monitor",
    group: "System",
    label: "Monitor",
    href: "/system/monitor",
    pageKey: "/system/monitor",
    icon: "Activity",
    description:
      "Backend monitor service — health, notifications, analytics freshness",
    keywords: [
      "monitor",
      "health",
      "uptime",
      "status",
      "clickhouse",
      "postgres",
      "ntfy",
    ],
    isNew: true,
    inSidebar: true,
    inPalette: true,
  },
];

export const NAV_ENTRIES: NavEntry[] = RAW_NAV_ENTRIES.map((entry) =>
  entry.group === "Insights"
    ? {
        ...entry,
        usernameAllowlist:
          entry.usernameAllowlist ?? [...INSIGHTS_USERNAME_ALLOWLIST],
      }
    : entry,
);

// ---------------------------------------------------------------------------
// Derived views
// ---------------------------------------------------------------------------

export type SidebarNavGroup = {
  label: NavGroupKey;
  creatorOnly?: boolean;
  devEnvOnly?: boolean;
  items: NavEntry[];
};

/**
 * Sidebar groups (in render order) containing only the entries flagged
 * `inSidebar`, preserving the per-entry order of `NAV_ENTRIES`. Empty groups
 * are kept (the sidebar drops them at render time after visibility filtering).
 */
export function getSidebarGroups(): SidebarNavGroup[] {
  return NAV_GROUP_META.map((meta) => ({
    label: meta.label,
    creatorOnly: meta.creatorOnly,
    devEnvOnly: meta.devEnvOnly,
    items: NAV_ENTRIES.filter(
      (e) => e.inSidebar && !e.inSidebarFooter && e.group === meta.label,
    ),
  }));
}

/** Sidebar footer pins (rendered above the theme toggle). */
export function getSidebarFooterItems(): NavEntry[] {
  return NAV_ENTRIES.filter((e) => e.inSidebar && e.inSidebarFooter);
}

// The command palette historically rendered its nav commands in an order
// that interleaves the sidebar groups differently (e.g. Shifts sits second,
// Battles before Pack Transactions). `NAV_ENTRIES` above is kept in sidebar
// render order (the canonical structure); this list re-orders the palette
// subset to reproduce the exact pre-refactor palette ordering. It only
// references ids — all entry DATA still lives in `NAV_ENTRIES`.
const PALETTE_ORDER: string[] = [
  "nav.dashboard",
  "nav.roadmap",
  "nav.shifts",
  "nav.analytics",
  "nav.one-piece",
  "nav.map",
  "nav.users",
  "nav.crm",
  "nav.deposits",
  "nav.physical",
  "nav.creators",
  "nav.creators.analytics",
  "nav.promo",
  "nav.packs",
  "nav.rewards.shards",
  "nav.cards",
  "nav.battles",
  "nav.transactions.rewards",
  "nav.rewards",
  "nav.rewards.deposit-bonus",
  "nav.rewards.rakeback",
  "nav.rewards.shard-opens",
  "nav.challenges",
  "nav.rain",
  "nav.rewards.leaderboards",
  "nav.rewards.level-up",
  "nav.creators.settings",
  "nav.rewards.settings",
  "nav.my-profile",
  "nav.admin-users",
  "nav.security",
  "nav.geo-blocking",
  "nav.audit",
  "nav.system.monitor",
];

/**
 * All entries that surface in the command-palette navigation section, in the
 * canonical palette order.
 *
 * `PALETTE_ORDER` lists exactly the ids of the `inPalette` entries; any entry
 * flagged `inPalette` that is missing from `PALETTE_ORDER` would silently drop
 * out of the palette, and any id here that isn't `inPalette` is ignored. Both
 * lists are kept in lockstep (and asserted by the nav verification harness).
 */
export function getPaletteNavEntries(): NavEntry[] {
  const byId = new Map(NAV_ENTRIES.map((e) => [e.id, e]));
  return PALETTE_ORDER.map((id) => byId.get(id)).filter(
    (e): e is NavEntry => Boolean(e && e.inPalette),
  );
}

// Docs headings equal sidebar group labels.
const DOCS_GROUP_HEADING: Partial<Record<NavGroupKey, string>> = {};

/** A docs group: a display heading + the palette entries under it. */
export type DocsNavGroup = { label: string; items: NavEntry[] };

/**
 * Docs grouping for `/system/commands`, fully DERIVED from `NAV_ENTRIES`.
 * Each palette entry is bucketed under its sidebar group's heading (with the
 * one remap above), in palette order within each group and group order across
 * them. No hand-maintained command/pageKey list — adding a palette entry
 * surfaces it on the docs page automatically. This replaces the old standalone
 * `DOCS_NAV_GROUPS` array which had drifted from both sidebar and palette.
 */
export function getDocsNavGroups(): DocsNavGroup[] {
  const palette = getPaletteNavEntries();
  const headingFor = (g: NavGroupKey): string => DOCS_GROUP_HEADING[g] ?? g;

  const byHeading = new Map<string, NavEntry[]>();
  for (const e of palette) {
    const heading = headingFor(e.group);
    const bucket = byHeading.get(heading);
    if (bucket) bucket.push(e);
    else byHeading.set(heading, [e]);
  }

  // Emit in group render order, skipping empty groups.
  const out: DocsNavGroup[] = [];
  const seen = new Set<string>();
  for (const meta of NAV_GROUP_META) {
    const heading = headingFor(meta.label);
    if (seen.has(heading)) continue;
    seen.add(heading);
    const items = byHeading.get(heading);
    if (items && items.length > 0) out.push({ label: heading, items });
  }
  return out;
}
