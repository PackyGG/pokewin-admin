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
  | "Players"
  | "Content"
  | "Creator Portal"
  | "Test Tools"
  | "Staff"
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
  /**
   * When true, the `usernameAllowlist` is STRICT: it is NOT bypassed by the
   * generic owner flag (`isOwner`) in the sidebar. Only a username actually in
   * the allowlist sees the item — every other owner does not. Used for the
   * root-owner-only (`motha`) Excluded Users entry, whose route enforces
   * `requireMainOwner` server-side. Default (undefined/false) keeps the legacy
   * behaviour where any owner bypasses the allowlist.
   */
  strictUsernameAllowlist?: boolean;
  /** Renders a "NEW" badge in the sidebar. */
  isNew?: boolean;
  /** Visible to every authenticated dashboard user, independent of page grants. */
  alwaysVisible?: boolean;
  /** Role required unless the viewer is an admin or owner. */
  roleAllowlist?: string[];
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
  { label: "Players" },
  // The "Insights" group is gone (owner, 2026-07-23) — every surface it held
  // is an /analytics tab now, and its pages were deleted.
  { label: "Content" },
  { label: "Creator Portal", creatorOnly: true },
  { label: "Test Tools", devEnvOnly: true },
  { label: "Staff" },
  // The "Rewards" group was collapsed into the Rewards hub (moved into
  // Overview below Users). The "Employees" group was deleted (Salaries moved
  // into System, Shifts removed).
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
    group: "Players",
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
    id: "nav.vips",
    group: "Players",
    label: "VIPs",
    href: "/vips",
    pageKey: "/vips",
    icon: "Crown",
    description: "Users flagged as VIP",
    keywords: ["vip", "high roller", "whale"],
    inSidebar: true,
    inPalette: true,
  },
  {
    id: "nav.chat-raffle",
    group: "Players",
    label: "Chat Raffle",
    href: "/chat-raffle",
    pageKey: "/chat-raffle",
    icon: "Dices",
    description: "Chat activity earns tickets — one is drawn per prize place",
    keywords: [
      "chat",
      "raffle",
      "chatters",
      "tickets",
      "draw",
      "giveaway",
      "leaderboard",
    ],
    inSidebar: true,
    inPalette: true,
  },
  {
    // Rewards hub — the former "Rewards" sidebar SECTION was collapsed into
    // this single tabbed hub (Rain | Challenges | XP Sales | Rakeback | Promo
    // Codes | Leaderboards | Deposit Bonus | Level Up | Affiliate | Settings)
    // and moved into Overview, directly below Users. Icon "Award" is already
    // in the sidebar ICONS map (app-sidebar.tsx).
    id: "nav.rewards",
    group: "Overview",
    label: "Rewards",
    href: "/rewards",
    pageKey: "/rewards",
    icon: "Award",
    description: "Rain, challenges, rakeback, promos, leaderboards, and more",
    keywords: ["rewards", "rain", "challenges", "rakeback", "promo", "leaderboards"],
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
  {
    // Notifications — global broadcast announcements. Backend
    // /v1/admin/announcements; per-user notifications have no admin
    // endpoint yet. Icon "Megaphone" is already registered in the ICONS
    // map (app-sidebar.tsx), reused here to avoid a React #130 miss.
    id: "nav.notifications",
    group: "Overview",
    label: "Notifications",
    href: "/notifications",
    pageKey: "/notifications",
    icon: "Megaphone",
    description: "Send a site-wide announcement to all users",
    keywords: ["announcement", "broadcast", "notify", "alert", "news"],
    inSidebar: true,
    inPalette: true,
  },

  // ── Insights (sidebar-only; absent from palette today) ─────────────────
  {
    // Creator Rewards — VIP wager programs + the claim review queue. Promoted
    // out of the /rewards tab hub to its own page: it is an operational queue
    // staff work through, and burying that a tab deep hides work that needs
    // doing. Icon "Gift" is already in the ICONS map in app-sidebar.tsx —
    // a nav icon string that ISN'T there is a runtime crash (React #130).
    id: "nav.creator-rewards",
    group: "Overview",
    label: "Creator Rewards",
    href: "/creator-rewards",
    pageKey: "/creator-rewards",
    icon: "Gift",
    description: "Creator wager-reward programs + claim review",
    keywords: ["creator", "vip", "wager", "reward", "claim", "review"],
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
  // Battles admin page (/battles) was removed as a standalone admin surface
  // (2026-07) — battle data itself is untouched and still shown elsewhere
  // (user-detail history, dashboard KPIs, creators pages, insights-games).

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
    // Salaries — moved here from the (now-deleted) Employees section. Still
    // sidebar-only, owner username-gated. Not in ADMIN_PAGES (the page enforces
    // requireMotha server-side); pageKey "/salaries" preserves today's sidebar
    // gate (isAdmin || allowed_pages includes it, which non-admins never have
    // → effectively admin+username gated). Icon "Coins" is in the ICONS map.
    id: "nav.salaries",
    group: "System",
    label: "Salaries",
    href: "/salaries",
    pageKey: "/salaries",
    icon: "Coins",
    usernameAllowlist: ["motha"],
    inSidebar: true,
    inPalette: false,
  },
  {
    id: "nav.staff",
    group: "Staff",
    label: "Staff Hub",
    href: "/staff",
    pageKey: "/staff",
    icon: "Users",
    description: "Profiles, quizzes, points and the staff leaderboard",
    keywords: ["staff", "profile", "quiz", "points", "leaderboard"],
    alwaysVisible: true,
    roleAllowlist: ["support"],
    inSidebar: true,
    inPalette: false,
  },
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
    // Global inbox + custom staff composer. The bell is shared by every shell;
    // this main-dashboard page is its canonical history and management surface.
    id: "nav.staff-notifications",
    group: "System",
    label: "Staff Notifications",
    href: "/system/staff-notifications",
    pageKey: "/system/staff-notifications",
    icon: "Bell",
    description: "Global staff inbox and custom team notifications",
    keywords: ["staff", "notification", "inbox", "broadcast", "discord", "telegram"],
    isNew: true,
    inSidebar: true,
    inPalette: true,
  },
  {
    // Geo Blocking — per-country deposit / withdrawal restrictions.
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
    // Admin API — machine-to-machine keys + the endpoint catalogue for the
    // /api/v1 surface (Discord bot + in-house consumers). Icon string
    // `KeyRound` is already registered in the ICONS map in
    // `src/components/app-sidebar.tsx` (no React #130 risk).
    id: "nav.system.admin-api",
    group: "System",
    label: "Admin API",
    href: "/system/admin-api",
    pageKey: "/system/admin-api",
    icon: "KeyRound",
    description: "API keys + endpoint catalogue for the /api/v1 surface",
    keywords: ["api", "key", "token", "bot", "discord", "integration", "scope", "endpoint"],
    inSidebar: true,
    inPalette: true,
  },
  {
    // Excluded Users — sidebar-only, ROOT-OWNER-ONLY (motha). Not in ADMIN_PAGES
    // as the security boundary (page + actions enforce requireExcludedUsersAccess
    // → requireMainOwner server-side); listed in ADMIN_PAGES only so the key
    // isn't "unknown". pageKey set to "/system/excluded-users" preserves the
    // sidebar gate. `strictUsernameAllowlist` keeps the entry hidden from every
    // NON-root owner too (the generic isOwner bypass does NOT apply here).
    id: "nav.system.excluded-users",
    group: "System",
    label: "Excluded Users",
    href: "/system/excluded-users",
    pageKey: "/system/excluded-users",
    icon: "Ban",
    usernameAllowlist: ["motha"],
    strictUsernameAllowlist: true,
    inSidebar: true,
    inPalette: false,
  },
];

// The Insights group used to get a blanket owner-only allowlist applied here.
// The group is gone (owner, 2026-07-23), so entries pass through untouched —
// each one carries its own `usernameAllowlist` when it needs one.
export const NAV_ENTRIES: NavEntry[] = RAW_NAV_ENTRIES;

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
  "nav.analytics",
  "nav.map",
  "nav.users",
  "nav.vips",
  "nav.rewards",
  "nav.crm",
  "nav.deposits",
  "nav.withdrawals",
  "nav.notifications",
  "nav.creators",
  "nav.creators.analytics",
  "nav.packs",
  "nav.cards",
  "nav.my-profile",
  "nav.admin-users",
  "nav.staff-notifications",
  "nav.security",
  "nav.geo-blocking",
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
