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
  | "Marketing"
  | "Employees"
  | "Content"
  | "Transactions"
  | "Rewards"
  | "Creator Portal"
  | "Test Tools"
  | "Security"
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
  { label: "Marketing" },
  { label: "Employees" },
  { label: "Content" },
  { label: "Transactions" },
  { label: "Rewards" },
  { label: "Creator Portal", creatorOnly: true },
  { label: "Test Tools", devEnvOnly: true },
  { label: "Security" },
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

export const NAV_ENTRIES: NavEntry[] = [
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
  {
    // Withdrawals — palette-only. The standalone /withdrawals route redirects
    // to the unified Transactions page, but the palette still advertises the
    // legacy entry-point (key retained in ADMIN_PAGES).
    id: "nav.withdrawals",
    group: "Overview",
    label: "Withdrawals",
    href: "/withdrawals",
    pageKey: "/withdrawals",
    icon: "ArrowDownToLine",
    description: "Withdrawal queue",
    keywords: ["payouts", "shipping"],
    inSidebar: false,
    inPalette: true,
  },

  // ── Insights (sidebar-only; absent from palette today) ─────────────────
  {
    // Insights Hub — the /insights landing page. KPI strip sourced from
    // the canonical cost-breakdown helper plus quick-link cards into
    // every sub-area. Icon string `Compass` MUST be registered in the
    // ICONS map in `src/components/app-sidebar.tsx`. Sits first in the
    // group so the parent route is reachable directly from the sidebar.
    id: "nav.insights.hub",
    group: "Insights",
    label: "Overview",
    href: "/insights",
    pageKey: "/insights",
    icon: "Compass",
    isNew: true,
    inSidebar: true,
    inPalette: false,
  },
  {
    id: "nav.insights.cost-breakdown",
    group: "Insights",
    label: "Cost Breakdown",
    href: "/insights/cost-breakdown",
    pageKey: "/insights/cost-breakdown",
    icon: "TrendingDown",
    isNew: true,
    inSidebar: true,
    inPalette: false,
  },
  {
    id: "nav.insights.analytics",
    group: "Insights",
    label: "Analytics",
    href: "/insights/analytics",
    pageKey: "/insights/analytics",
    icon: "LineChart",
    isNew: true,
    inSidebar: true,
    inPalette: false,
  },
  {
    id: "nav.ggr",
    group: "Insights",
    label: "GGR",
    href: "/ggr",
    pageKey: "/ggr",
    icon: "TrendingUp",
    isNew: true,
    inSidebar: true,
    inPalette: false,
  },
  {
    id: "nav.insights.games",
    group: "Insights",
    label: "Games",
    href: "/insights/games",
    pageKey: "/insights/games",
    icon: "Joystick",
    isNew: true,
    inSidebar: true,
    inPalette: false,
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
    id: "nav.insights.rewards.signup",
    group: "Insights",
    label: "Signup",
    href: "/insights/rewards/signup",
    pageKey: "/insights/rewards/signup",
    icon: "UserPlus",
    isNew: true,
    inSidebar: true,
    inPalette: false,
  },
  {
    id: "nav.insights.balance-adjustments",
    group: "Insights",
    label: "Balance Adjustments",
    href: "/insights/balance-adjustments",
    pageKey: "/insights/balance-adjustments",
    icon: "Scale",
    isNew: true,
    inSidebar: true,
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
    // System Edge Plan — unified reward-system planning page. Tune every
    // lever and see the projected profit impact + delta vs the current real
    // config (read-only planning). Icon string `SlidersHorizontal` MUST be
    // registered in the ICONS map in `src/components/app-sidebar.tsx`.
    id: "nav.insights.system-edge-plan",
    group: "Insights",
    label: "System Edge Plan",
    href: "/insights/system-edge-plan",
    pageKey: "/insights/system-edge-plan",
    icon: "SlidersHorizontal",
    description: "Plan reward-system changes — projected profit impact + delta",
    keywords: [
      "edge",
      "plan",
      "levers",
      "rakeback",
      "affiliate",
      "profit",
      "what-if",
      "tuning",
    ],
    isNew: true,
    inSidebar: true,
    // Sidebar-only, matching the rest of the Insights group (the per-feature
    // analytical surfaces are absent from the command palette today).
    inPalette: false,
  },

  // ── Marketing ──────────────────────────────────────────────────────────
  {
    id: "nav.creators.ads",
    group: "Marketing",
    label: "Ads",
    href: "/creators/ads",
    pageKey: "/creators/ads",
    icon: "Megaphone",
    description: "Campaign / house codes",
    keywords: ["campaign", "house"],
    inSidebar: true,
    inPalette: true,
  },
  {
    // Creator Analytics — palette-only. The sidebar dropped this link in the
    // nav split, but the route + ADMIN_PAGES key (/creators/analytics, grouped
    // under Marketing) and the palette command are both retained.
    id: "nav.creators.analytics",
    group: "Marketing",
    label: "Creator Analytics",
    href: "/creators/analytics",
    pageKey: "/creators/analytics",
    icon: "BarChart3",
    description: "Creator performance",
    inSidebar: false,
    inPalette: true,
  },
  {
    id: "nav.gift-cards",
    group: "Marketing",
    label: "Gift Cards",
    href: "/gift-cards",
    pageKey: "/gift-cards",
    icon: "Gift",
    inSidebar: true,
    inPalette: true,
  },
  {
    // Giveaway — sidebar-only.
    id: "nav.marketing.giveaway",
    group: "Marketing",
    label: "Giveaway",
    href: "/marketing/giveaway",
    pageKey: "/marketing/giveaway",
    icon: "Gift",
    inSidebar: true,
    inPalette: false,
  },
  {
    // Creator Settings — sidebar shows it in the Marketing group labeled
    // "Settings"; palette labels it "Creator Settings".
    id: "nav.creators.settings",
    group: "Marketing",
    label: "Settings",
    paletteLabel: "Creator Settings",
    href: "/creators/settings",
    pageKey: "/creators/settings",
    icon: "Settings",
    description: "Global affiliate config",
    inSidebar: true,
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
    usernameAllowlist: ["motha", "void", "kotha"],
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

  // ── Transactions ───────────────────────────────────────────────────────
  {
    // Sidebar label "Packs"; palette label "Pack Transactions".
    id: "nav.transactions.packs",
    group: "Transactions",
    label: "Packs",
    paletteLabel: "Pack Transactions",
    href: "/transactions/packs",
    pageKey: "/transactions/packs",
    icon: "Package",
    inSidebar: true,
    inPalette: true,
  },
  {
    id: "nav.battles",
    group: "Transactions",
    label: "Battles",
    href: "/battles",
    pageKey: "/battles",
    icon: "Swords",
    description: "Pack battle directory",
    inSidebar: true,
    inPalette: true,
  },
  {
    // Sidebar label "Upgrader"; palette label "Upgrader Transactions".
    id: "nav.transactions.upgrader",
    group: "Transactions",
    label: "Upgrader",
    paletteLabel: "Upgrader Transactions",
    href: "/transactions/upgrader",
    pageKey: "/transactions/upgrader",
    icon: "ArrowUpCircle",
    keywords: ["upgrader", "bet", "payout"],
    inSidebar: true,
    inPalette: true,
  },
  {
    // Sidebar label "Rewards"; palette label "Reward Transactions".
    id: "nav.transactions.rewards",
    group: "Transactions",
    label: "Rewards",
    paletteLabel: "Reward Transactions",
    href: "/transactions/rewards",
    pageKey: "/transactions/rewards",
    icon: "Award",
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
    id: "nav.rewards.raffles",
    group: "Rewards",
    label: "Raffles",
    href: "/rewards/raffles",
    pageKey: "/rewards/raffles",
    icon: "Ticket",
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

  // ── Security ───────────────────────────────────────────────────────────
  {
    id: "nav.security",
    group: "Security",
    label: "Security",
    href: "/security",
    pageKey: "/security",
    icon: "Shield",
    description: "Site security config",
    inSidebar: true,
    inPalette: true,
  },

  // ── System ─────────────────────────────────────────────────────────────
  {
    // Admin panel users. Sidebar icon is ShieldCheck; palette icon is also
    // ShieldCheck. Both labels are "Users".
    id: "nav.admin-users",
    group: "System",
    label: "Users",
    href: "/admin-users",
    pageKey: "/admin-users",
    icon: "ShieldCheck",
    description: "Admin panel users",
    inSidebar: true,
    inPalette: true,
  },
  {
    // Roles. Sidebar icon KeyRound; palette icon Shield (preserve both).
    id: "nav.settings.roles",
    group: "System",
    label: "Roles",
    href: "/settings/roles",
    pageKey: "/settings/roles",
    icon: "Shield",
    sidebarIcon: "KeyRound",
    description: "Built-in & custom roles",
    inSidebar: true,
    inPalette: true,
  },
  {
    id: "nav.bots",
    group: "System",
    label: "Bots",
    href: "/bots",
    pageKey: "/bots",
    icon: "Bot",
    inSidebar: true,
    inPalette: true,
  },
  {
    id: "nav.settings",
    group: "System",
    label: "Settings",
    href: "/settings",
    pageKey: "/settings",
    icon: "Settings",
    description: "Global admin settings",
    inSidebar: true,
    inSidebarFooter: true,
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
    id: "nav.commands",
    group: "System",
    label: "Commands",
    href: "/system/commands",
    pageKey: "/system/commands",
    icon: "Command",
    description: "All palette commands",
    keywords: ["palette", "shortcuts", "cmd+k"],
    inSidebar: true,
    inPalette: true,
  },
  {
    // Dashboard Stats — sidebar-only.
    id: "nav.system.stats",
    group: "System",
    label: "Dashboard Stats",
    href: "/system/stats",
    pageKey: "/system/stats",
    icon: "Gauge",
    inSidebar: true,
    inPalette: false,
  },
];

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
  "nav.shifts",
  "nav.analytics",
  "nav.map",
  "nav.users",
  "nav.deposits",
  "nav.withdrawals",
  "nav.creators",
  "nav.creators.ads",
  "nav.creators.analytics",
  "nav.creators.settings",
  "nav.promo",
  "nav.gift-cards",
  "nav.packs",
  "nav.cards",
  "nav.battles",
  "nav.transactions.packs",
  "nav.transactions.upgrader",
  "nav.transactions.rewards",
  "nav.rewards",
  "nav.rewards.rakeback",
  "nav.rewards.raffles",
  "nav.rain",
  "nav.rewards.leaderboards",
  "nav.rewards.level-up",
  "nav.rewards.settings",
  "nav.my-profile",
  "nav.security",
  "nav.admin-users",
  "nav.settings.roles",
  "nav.bots",
  "nav.settings",
  "nav.audit",
  "nav.commands",
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
