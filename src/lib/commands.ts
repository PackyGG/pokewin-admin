// Command palette (CMD+K) + `/system/commands` docs page command lists.
//
// Navigation commands are DERIVED from the single shared nav config in
// `src/lib/nav-config.ts` (the same source the sidebar derives from), so the
// palette and sidebar can no longer drift. This file:
//   - resolves the nav config's string icon keys into `lucide-react`
//     components and exposes them as `NavCommand`s (`NAV_COMMANDS`),
//   - defines the palette-only quick actions (`ACTION_COMMANDS`),
//   - re-exposes the docs grouping (also derived from the nav config).
//
// Because navigation now comes from `nav-config.ts`, the palette genuinely
// mirrors the permission-key universe (`ADMIN_PAGES`) one-for-one via each
// entry's `pageKey`.
//
// This file is imported from both a Client Component (the palette) and a
// Server Component (the docs page), so it must stay dependency-free — no
// `"use client"`, no server-only modules, only pure data + typed icons.

import {
  Activity,
  ArrowDownToLine,
  ArrowUpCircle,
  Award,
  BarChart3,
  Bot,
  CalendarClock,
  CalendarDays,
  CloudRain,
  Command,
  FileText,
  Gift,
  Globe,
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
  type LucideIcon,
} from "lucide-react";

import {
  getPaletteNavEntries,
  getDocsNavGroups,
  type NavEntry,
} from "@/lib/nav-config";

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
// Icon resolution — maps nav-config string icon keys to lucide components.
// Only the keys used by palette-surfaced nav entries need to be present.
// ---------------------------------------------------------------------------

const NAV_ICONS: Record<string, LucideIcon> = {
  ArrowDownToLine,
  ArrowUpCircle,
  Award,
  BarChart3,
  Bot,
  CalendarClock,
  CloudRain,
  Command,
  FileText,
  Gift,
  Globe,
  Layers,
  LayoutDashboard,
  Megaphone,
  Package,
  Percent,
  Receipt,
  Settings,
  Shield,
  ShieldCheck,
  Swords,
  Tag,
  Ticket,
  TrendingUp,
  Trophy,
  UserCircle,
  Users,
};

function navEntryToCommand(e: NavEntry): NavCommand {
  const icon = NAV_ICONS[e.icon] ?? Command;
  return {
    kind: "nav",
    id: e.id,
    label: e.paletteLabel ?? e.label,
    description: e.description,
    icon,
    href: e.href,
    pageKey: e.pageKey,
    keywords: e.keywords,
  };
}

// ---------------------------------------------------------------------------
// Navigation commands — derived from src/lib/nav-config.ts (one-for-one with
// the ADMIN_PAGES permission keys via each entry's pageKey).
// ---------------------------------------------------------------------------

export const NAV_COMMANDS: NavCommand[] =
  getPaletteNavEntries().map(navEntryToCommand);

// ---------------------------------------------------------------------------
// Quick-action commands (palette-only — not part of the shared nav config).
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
// Docs helpers — grouped views for /system/commands (derived from nav-config).
// ---------------------------------------------------------------------------

/**
 * Group nav commands by their sidebar section for the docs page. Fully
 * derived from the shared nav config (`getDocsNavGroups`), then mapped into
 * `NavCommand`s — so the docs page can never drift from the palette or the
 * sidebar.
 */
export function getNavCommandsByDocsGroup(): Array<{
  label: string;
  items: NavCommand[];
}> {
  return getDocsNavGroups().map((g) => ({
    label: g.label,
    items: g.items.map(navEntryToCommand),
  }));
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
