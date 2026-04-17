// Single source of truth for the global command palette (CMD+K) and the
// `/system/commands` docs page.
//
// Every command lives in one place so:
//   - the palette can render them grouped by section with icons + shortcuts
//   - the docs page can render a human-readable list without drifting from
//     what the palette actually offers
//   - permission filtering can be applied once (ADMIN_PAGES keys)
//
// This file is imported from both a Client Component (the palette) and a
// Server Component (the docs page), so it must stay dependency-free — no
// `"use client"`, no server-only modules, only pure data + typed icons.

import {
  Activity,
  ArrowDownToLine,
  Award,
  BarChart3,
  Bot,
  CalendarDays,
  CloudRain,
  Command,
  FileText,
  Gift,
  Globe,
  KeyRound,
  Keyboard,
  Layers,
  LayoutDashboard,
  LogOut,
  Megaphone,
  MessageSquare,
  MoonStar,
  Package,
  Percent,
  Plus,
  Receipt,
  Search,
  Settings,
  Share2,
  Shield,
  ShieldCheck,
  SquareKanban,
  Sun,
  Swords,
  Tag,
  Ticket,
  TrendingUp,
  Trophy,
  UserCircle,
  UserSearch,
  Users,
  Wallet,
  type LucideIcon,
} from "lucide-react";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * A navigation command — jumps to an admin page.
 * `pageKey` matches an entry in ADMIN_PAGES so we can filter by the user's
 * allowed_pages without duplicating the nav list.
 */
export type NavCommand = {
  kind: "nav";
  id: string;
  label: string;
  description?: string;
  icon: LucideIcon;
  href: string;
  /** ADMIN_PAGES.key — controls whether a non-admin sees this entry. */
  pageKey: string;
  /** Keywords for fuzzy matching (e.g. aliases). */
  keywords?: string[];
};

/**
 * A quick action — either navigates with a query param that opens a dialog,
 * or fires a client-side side-effect (theme / logout). Server mutations are
 * NOT triggered directly; the palette navigates to the right page first.
 */
export type ActionCommand = {
  kind: "action";
  id: string;
  label: string;
  description?: string;
  icon: LucideIcon;
  /**
   * What the palette does when this item is selected.
   *   - `{ type: "navigate", href }`             → router.push(href)
   *   - `{ type: "theme", mode }`                → next-themes setTheme
   *   - `{ type: "logout" }`                     → fires the logout action
   *   - `{ type: "focus-user-search" }`          → keeps palette open, prefills `@`
   */
  run:
    | { type: "navigate"; href: string }
    | { type: "theme"; mode: "light" | "dark" | "system" }
    | { type: "logout" }
    | { type: "focus-user-search" };
  /** Page the action belongs to — gates visibility via ADMIN_PAGES. */
  pageKey?: string;
  /** Optional keyboard shortcut label (display-only; palette doesn't bind it). */
  shortcut?: string;
  keywords?: string[];
};

export type PaletteCommand = NavCommand | ActionCommand;

// ---------------------------------------------------------------------------
// Navigation commands — mirrors src/lib/admin-pages.ts one-for-one.
// ---------------------------------------------------------------------------

export const NAV_COMMANDS: NavCommand[] = [
  // ── Overview ──────────────────────────────────────────────────────────
  {
    kind: "nav",
    id: "nav.dashboard",
    label: "Dashboard",
    description: "Platform overview",
    icon: LayoutDashboard,
    href: "/dashboard",
    pageKey: "/dashboard",
    keywords: ["home", "overview"],
  },
  {
    kind: "nav",
    id: "nav.analytics",
    label: "Analytics",
    description: "GGR, NGR, PnL charts",
    icon: BarChart3,
    href: "/analytics",
    pageKey: "/analytics",
    keywords: ["metrics", "chart", "ggr", "ngr", "pnl"],
  },
  {
    kind: "nav",
    id: "nav.map",
    label: "Map",
    description: "Geographic user distribution",
    icon: Globe,
    href: "/map",
    pageKey: "/map",
    keywords: ["geo", "world", "country"],
  },
  {
    kind: "nav",
    id: "nav.users",
    label: "Users",
    description: "Browse end-users",
    icon: Users,
    href: "/users",
    pageKey: "/users",
    keywords: ["players", "accounts", "search"],
  },
  {
    kind: "nav",
    id: "nav.deposits",
    label: "Deposits",
    description: "Deposit & withdrawal ledger",
    icon: ArrowDownToLine,
    href: "/transactions/deposits",
    pageKey: "/transactions/deposits",
    keywords: ["crypto", "payments"],
  },
  {
    kind: "nav",
    id: "nav.withdrawals",
    label: "Withdrawals",
    description: "Withdrawal queue",
    icon: ArrowDownToLine,
    href: "/withdrawals",
    pageKey: "/withdrawals",
    keywords: ["payouts", "shipping"],
  },

  // ── Creators ──────────────────────────────────────────────────────────
  {
    kind: "nav",
    id: "nav.creators",
    label: "Creators",
    description: "Affiliate creator directory",
    icon: Users,
    href: "/creators",
    pageKey: "/creators",
    keywords: ["affiliate", "influencer"],
  },
  {
    kind: "nav",
    id: "nav.creators.codes",
    label: "Creator Codes",
    description: "Affiliate code directory",
    icon: Share2,
    href: "/creators/codes",
    pageKey: "/creators/codes",
    keywords: ["affiliate", "referral"],
  },
  {
    kind: "nav",
    id: "nav.creators.ads",
    label: "Ads",
    description: "Campaign / house codes",
    icon: Megaphone,
    href: "/creators/ads",
    pageKey: "/creators/ads",
    keywords: ["campaign", "house"],
  },
  {
    kind: "nav",
    id: "nav.creators.analytics",
    label: "Creator Analytics",
    description: "Creator performance",
    icon: BarChart3,
    href: "/creators/analytics",
    pageKey: "/creators/analytics",
  },
  {
    kind: "nav",
    id: "nav.creators.settings",
    label: "Creator Settings",
    description: "Global affiliate config",
    icon: Settings,
    href: "/creators/settings",
    pageKey: "/creators/settings",
  },

  // ── Marketing ─────────────────────────────────────────────────────────
  {
    kind: "nav",
    id: "nav.promo",
    label: "Promo Codes",
    description: "Bonus code directory",
    icon: Tag,
    href: "/promo-codes",
    pageKey: "/promo-codes",
    keywords: ["coupons", "bonus"],
  },
  {
    kind: "nav",
    id: "nav.gift-cards",
    label: "Gift Cards",
    icon: Gift,
    href: "/gift-cards",
    pageKey: "/gift-cards",
  },
  {
    kind: "nav",
    id: "nav.vouchers",
    label: "Vouchers",
    icon: Ticket,
    href: "/vouchers",
    pageKey: "/vouchers",
  },

  // ── Content ───────────────────────────────────────────────────────────
  {
    kind: "nav",
    id: "nav.packs",
    label: "Packs",
    description: "Pack catalog",
    icon: Package,
    href: "/packs",
    pageKey: "/packs",
  },
  {
    kind: "nav",
    id: "nav.cards",
    label: "Cards",
    description: "Card catalog",
    icon: Layers,
    href: "/cards",
    pageKey: "/cards",
  },
  {
    kind: "nav",
    id: "nav.battles",
    label: "Battles",
    description: "Pack battle directory",
    icon: Swords,
    href: "/battles",
    pageKey: "/battles",
  },

  // ── Transactions ──────────────────────────────────────────────────────
  {
    kind: "nav",
    id: "nav.transactions",
    label: "All Transactions",
    description: "Unified ledger view",
    icon: Receipt,
    href: "/transactions",
    pageKey: "/transactions",
  },
  {
    kind: "nav",
    id: "nav.transactions.packs",
    label: "Pack Transactions",
    icon: Package,
    href: "/transactions/packs",
    pageKey: "/transactions/packs",
  },
  {
    kind: "nav",
    id: "nav.transactions.battles",
    label: "Battle Transactions",
    icon: Swords,
    href: "/transactions/battles",
    pageKey: "/transactions/battles",
  },
  {
    kind: "nav",
    id: "nav.transactions.rewards",
    label: "Reward Transactions",
    icon: Award,
    href: "/transactions/rewards",
    pageKey: "/transactions/rewards",
  },

  // ── Rewards ───────────────────────────────────────────────────────────
  {
    kind: "nav",
    id: "nav.rewards",
    label: "Rewards",
    icon: Award,
    href: "/rewards",
    pageKey: "/rewards",
  },
  {
    kind: "nav",
    id: "nav.rewards.rakeback",
    label: "Rakeback",
    icon: Percent,
    href: "/rewards/rakeback",
    pageKey: "/rewards/rakeback",
  },
  {
    kind: "nav",
    id: "nav.rewards.raffles",
    label: "Raffles",
    icon: Ticket,
    href: "/rewards/raffles",
    pageKey: "/rewards/raffles",
  },
  {
    kind: "nav",
    id: "nav.rain",
    label: "Rain",
    icon: CloudRain,
    href: "/rain",
    pageKey: "/rain",
  },
  {
    kind: "nav",
    id: "nav.rewards.leaderboards",
    label: "Leaderboards",
    icon: Trophy,
    href: "/rewards/leaderboards",
    pageKey: "/rewards/leaderboards",
    keywords: ["races"],
  },
  {
    kind: "nav",
    id: "nav.rewards.level-up",
    label: "Level Up",
    icon: TrendingUp,
    href: "/rewards/level-up",
    pageKey: "/rewards/level-up",
  },
  {
    kind: "nav",
    id: "nav.rewards.settings",
    label: "Reward Settings",
    icon: Settings,
    href: "/rewards/settings",
    pageKey: "/rewards/settings",
  },

  // ── Finance ───────────────────────────────────────────────────────────
  {
    kind: "nav",
    id: "nav.spending",
    label: "Spending",
    description: "Expense tracking",
    icon: Wallet,
    href: "/spending",
    pageKey: "/spending",
    keywords: ["expenses", "recurring"],
  },

  // ── Creator Portal (creator-only) ─────────────────────────────────────
  {
    kind: "nav",
    id: "nav.my-profile",
    label: "My Profile",
    description: "Creator self-service",
    icon: UserCircle,
    href: "/my-profile",
    pageKey: "/my-profile",
  },

  // ── Security ──────────────────────────────────────────────────────────
  {
    kind: "nav",
    id: "nav.security",
    label: "Security",
    description: "Site security config",
    icon: Shield,
    href: "/security",
    pageKey: "/security",
  },

  // ── System ────────────────────────────────────────────────────────────
  {
    kind: "nav",
    id: "nav.admin-users",
    label: "Admin Users",
    description: "Admin panel users",
    icon: ShieldCheck,
    href: "/admin-users",
    pageKey: "/admin-users",
  },
  {
    kind: "nav",
    id: "nav.admin-users.roles",
    label: "Roles",
    description: "Custom admin roles",
    icon: KeyRound,
    href: "/admin-users/roles",
    pageKey: "/admin-users/roles",
  },
  {
    kind: "nav",
    id: "nav.settings.roles",
    label: "Role Permissions",
    description: "Legacy per-role permissions",
    icon: Shield,
    href: "/settings/roles",
    pageKey: "/settings/roles",
  },
  {
    kind: "nav",
    id: "nav.bots",
    label: "Bots",
    icon: Bot,
    href: "/bots",
    pageKey: "/bots",
  },
  {
    kind: "nav",
    id: "nav.settings",
    label: "Settings",
    description: "Global admin settings",
    icon: Settings,
    href: "/settings",
    pageKey: "/settings",
  },
  {
    kind: "nav",
    id: "nav.audit",
    label: "Audit Log",
    description: "Every admin action, searchable",
    icon: FileText,
    href: "/audit",
    pageKey: "/audit",
    keywords: ["log", "history"],
  },
  {
    kind: "nav",
    id: "nav.commands",
    label: "Commands",
    description: "All palette commands",
    icon: Command,
    href: "/system/commands",
    pageKey: "/system/commands",
    keywords: ["palette", "shortcuts", "cmd+k"],
  },
];

// ---------------------------------------------------------------------------
// Quick-action commands
// ---------------------------------------------------------------------------

export const ACTION_COMMANDS: ActionCommand[] = [
  {
    kind: "action",
    id: "action.search-user",
    label: "Go to user…",
    description: "Search end-users by username, email, or ID",
    icon: UserSearch,
    run: { type: "focus-user-search" },
    pageKey: "/users",
    keywords: ["find", "lookup", "player"],
  },
  {
    kind: "action",
    id: "action.new-ad-code",
    label: "New ad code",
    description: "Create a campaign tracking code",
    icon: Plus,
    run: { type: "navigate", href: "/creators/ads" },
    pageKey: "/creators/ads",
    keywords: ["create", "campaign"],
  },
  {
    kind: "action",
    id: "action.new-admin",
    label: "Create admin user",
    description: "Open the admin-users page",
    icon: Plus,
    run: { type: "navigate", href: "/admin-users" },
    pageKey: "/admin-users",
    keywords: ["invite", "staff"],
  },
  {
    kind: "action",
    id: "action.latest-withdrawals",
    label: "Latest withdrawals",
    description: "Open the withdrawal queue",
    icon: ArrowDownToLine,
    run: { type: "navigate", href: "/withdrawals" },
    pageKey: "/withdrawals",
    keywords: ["payouts", "queue"],
  },
  {
    kind: "action",
    id: "action.audit-log",
    label: "Audit log",
    description: "Recent admin actions",
    icon: Activity,
    run: { type: "navigate", href: "/audit" },
    pageKey: "/audit",
    keywords: ["history"],
  },
  {
    kind: "action",
    id: "action.theme-light",
    label: "Switch to light mode",
    icon: Sun,
    run: { type: "theme", mode: "light" },
    keywords: ["theme", "day"],
  },
  {
    kind: "action",
    id: "action.theme-dark",
    label: "Switch to dark mode",
    icon: MoonStar,
    run: { type: "theme", mode: "dark" },
    keywords: ["theme", "night"],
  },
  {
    kind: "action",
    id: "action.logout",
    label: "Log out",
    icon: LogOut,
    run: { type: "logout" },
    keywords: ["signout", "exit"],
  },
];

// ---------------------------------------------------------------------------
// Palette section metadata (order + label)
// ---------------------------------------------------------------------------

export type PaletteSection = "navigation" | "actions" | "users";

export const PALETTE_SECTION_LABELS: Record<PaletteSection, string> = {
  navigation: "Navigation",
  actions: "Quick Actions",
  users: "Users",
};

// ---------------------------------------------------------------------------
// Permission filtering
// ---------------------------------------------------------------------------

/**
 * Filter commands to only those the current user can reach.
 * Admins see everything. Everyone else is filtered by `allowedPages`.
 */
export function filterCommandsForUser<T extends PaletteCommand>(
  commands: T[],
  role: string,
  allowedPages: readonly string[],
): T[] {
  if (role === "admin") return commands;
  const allowed = new Set(allowedPages);
  return commands.filter((c) => {
    const key = c.kind === "nav" ? c.pageKey : c.pageKey;
    return !key || allowed.has(key);
  });
}

// ---------------------------------------------------------------------------
// Docs helpers — grouped views for /system/commands.
// ---------------------------------------------------------------------------

/**
 * Group nav commands by their sidebar section. Mirrors the NAV_GROUPS
 * ordering in src/components/app-sidebar.tsx so the docs page matches what
 * users see in the nav.
 */
export const DOCS_NAV_GROUPS: Array<{ label: string; pageKeys: string[] }> = [
  {
    label: "Overview",
    pageKeys: [
      "/dashboard",
      "/analytics",
      "/map",
      "/users",
      "/transactions/deposits",
      "/withdrawals",
    ],
  },
  {
    label: "Creators",
    pageKeys: [
      "/creators",
      "/creators/codes",
      "/creators/ads",
      "/creators/analytics",
      "/creators/settings",
    ],
  },
  {
    label: "Marketing",
    pageKeys: ["/promo-codes", "/gift-cards", "/vouchers"],
  },
  {
    label: "Content",
    pageKeys: ["/packs", "/cards", "/battles"],
  },
  {
    label: "Transactions",
    pageKeys: [
      "/transactions",
      "/transactions/packs",
      "/transactions/battles",
      "/transactions/rewards",
    ],
  },
  {
    label: "Rewards",
    pageKeys: [
      "/rewards",
      "/rewards/rakeback",
      "/rewards/raffles",
      "/rain",
      "/rewards/leaderboards",
      "/rewards/level-up",
      "/rewards/settings",
    ],
  },
  {
    label: "Finance",
    pageKeys: ["/spending"],
  },
  {
    label: "Creator Portal",
    pageKeys: ["/my-profile"],
  },
  {
    label: "Security",
    pageKeys: ["/security"],
  },
  {
    label: "System",
    pageKeys: [
      "/admin-users",
      "/admin-users/roles",
      "/settings/roles",
      "/bots",
      "/settings",
      "/audit",
      "/system/commands",
    ],
  },
];

export function getNavCommandsByDocsGroup(): Array<{
  label: string;
  items: NavCommand[];
}> {
  const byKey = new Map<string, NavCommand>(
    NAV_COMMANDS.map((c) => [c.pageKey, c]),
  );
  return DOCS_NAV_GROUPS.map((g) => ({
    label: g.label,
    items: g.pageKeys.map((k) => byKey.get(k)).filter((c): c is NavCommand => Boolean(c)),
  })).filter((g) => g.items.length > 0);
}

// ---------------------------------------------------------------------------
// Example queries for the docs page.
// ---------------------------------------------------------------------------

export const EXAMPLE_QUERIES: Array<{ query: string; what: string }> = [
  { query: "@vlad", what: "Fuzzy search end-users whose username starts with 'vlad'." },
  { query: "withdrawals", what: "Jump to the withdrawal queue." },
  { query: "ban", what: "Shorthand for user moderation flows — opens the users page." },
  { query: "dark", what: "Switch to dark mode." },
  { query: "audit", what: "Open the audit log." },
  { query: "admin user", what: "Create an admin user." },
];

// ---------------------------------------------------------------------------
// Docs page icon (kept here so the route stays data-only)
// ---------------------------------------------------------------------------

export const COMMANDS_DOCS_ICON = Keyboard;
export const COMMANDS_DOCS_SECONDARY_ICON = SquareKanban;
export const COMMANDS_SEARCH_ICON = Search;
export const COMMANDS_CHAT_ICON = MessageSquare;
export const COMMANDS_CALENDAR_ICON = CalendarDays;
