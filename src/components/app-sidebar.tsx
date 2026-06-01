"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  LayoutDashboard,
  BarChart3,
  Users,
  ArrowDownToLine,
  Receipt,
  FileText,
  Package,
  Settings,
  Swords,
  Tag,
  Share2,
  MessageSquare,
  Gift,
  CalendarDays,
  CloudRain,
  Command,
  Gauge,
  Bot,
  Shield,
  ShieldCheck,
  KeyRound,
  SquareKanban,
  Trophy,
  Ticket,
  Award,
  Layers,
  Library,
  Percent,
  TrendingUp,
  UserCircle,
  Globe,
  Megaphone,
  CalendarClock,
  Coins,
  ChevronRight,
  FlaskConical,
  Ban,
  Network,
  ArrowUpCircle,
  Archive,
  ScrollText,
  LineChart,
  Joystick,
  Tv,
  Sigma,
  Wallet,
  Flag,
  UserPlus,
  Scale,
  type LucideIcon,
} from "lucide-react";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar";
import {
  Collapsible,
  CollapsibleTrigger,
  CollapsibleContent,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import { getDefaultRoute } from "@/lib/admin-roles";
import { ThemeToggle } from "@/components/theme-toggle";

const ICONS: Record<string, LucideIcon> = {
  LayoutDashboard,
  BarChart3,
  Users,
  ArrowDownToLine,
  Receipt,
  FileText,
  Package,
  Settings,
  Swords,
  Tag,
  Share2,
  MessageSquare,
  Gift,
  CalendarDays,
  CloudRain,
  Command,
  Gauge,
  Bot,
  Shield,
  ShieldCheck,
  KeyRound,
  SquareKanban,
  Trophy,
  Ticket,
  Award,
  Layers,
  Library,
  Percent,
  TrendingUp,
  UserCircle,
  Globe,
  Megaphone,
  CalendarClock,
  Coins,
  FlaskConical,
  Ban,
  Network,
  ArrowUpCircle,
  Archive,
  ScrollText,
  LineChart,
  Joystick,
  Tv,
  Sigma,
  Wallet,
  Flag,
  UserPlus,
  Scale,
};

type NavItem = {
  label: string;
  href: string;
  icon: string;
  // Restrict an item to a specific username allowlist (case-
  // insensitive). Used for the salaries link which is visible only
  // to founders (motha, void, kotha). The route itself ALSO gates
  // server-side via requireMotha — this flag is purely cosmetic /
  // discoverability.
  usernameAllowlist?: string[];
  // Renders a small "NEW" badge next to the label to surface a
  // recently-added page. Purely cosmetic — remove once the team has
  // discovered the page.
  isNew?: boolean;
};

type NavGroup = {
  label: string;
  items: NavItem[];
  creatorOnly?: boolean;
  /**
   * When true, the group is only rendered while the admin's main-DB
   * cookie points at the dev environment. Production never sees it.
   */
  devEnvOnly?: boolean;
};

const NAV_GROUPS: NavGroup[] = [
  {
    label: "Overview",
    items: [
      { label: "Dashboard", href: "/dashboard", icon: "LayoutDashboard" },
      { label: "Analytics", href: "/analytics", icon: "BarChart3" },
      // GGR moved to the Insights group below — analytical rollups
      // live with the rest of the cross-cutting deep-dives.
      // Changelogs — curated release notes. Read-only for anyone with
      // /changelogs access, publish/edit/delete requires the
      // __can_manage_changelog capability (admin-only by default).
      // Sits at the top of Overview so admins notice new platform
      // updates as soon as they land, before drilling into Users /
      // Transactions further down.
      { label: "Changelogs", href: "/changelogs", icon: "ScrollText", isNew: true },
      // /transactions overview was removed — admins go straight to a
      // specific sub-ledger via the "Transactions" group below.
      // /map was folded into /analytics as a tab; the standalone link is gone.
      { label: "Users", href: "/users", icon: "Users" },
      // /users/deleted is no longer a sidebar entry — access is via
      // the "Deleted users" header button on /users itself (gated by
      // __can_delete_user + /users/deleted page key). Permission key
      // stays in admin-pages.ts so admins can still grant or revoke
      // access independently in the role editor.
      // Single entry for the unified "Transactions" page (deposits +
      // withdrawals tabs in one surface). The standalone Withdrawals
      // link was folded in — its old route now redirects here with
      // `?tab=withdrawals` so existing bookmarks still resolve. The
      // page hero says "Transactions"; the sidebar mirrors that label
      // so the two surfaces agree.
      { label: "Transactions", href: "/transactions/deposits", icon: "Receipt" },
    ],
  },
  {
    // Insights — cross-cutting analytical surfaces split out from the
    // individual feature groups. Sits directly below Overview so admins
    // reach the analytical rollups before drilling into the operational
    // surfaces (Marketing, Content, Transactions, Rewards). The four
    // entries here are intentionally separate from the per-feature
    // Analytics tabs (e.g. /rewards/analytics) — those stay in their
    // own groups.
    label: "Insights",
    items: [
      { label: "Analytics", href: "/insights/analytics", icon: "LineChart", isNew: true },
      // GGR — long-form deep-dive of the headline GGR number with one
      // card per ledger type + canonical descriptions + top-10
      // contributors for the active window. Sits in Insights because
      // it's the same class of cross-cutting analytical surface as the
      // other entries here. The /dashboard GgrStatCard's popover is
      // the compact companion.
      { label: "GGR", href: "/ggr", icon: "TrendingUp", isNew: true },
      { label: "Games", href: "/insights/games", icon: "Joystick", isNew: true },
      { label: "Rewards", href: "/insights/rewards", icon: "Gift", isNew: true },
      // Per-reward-type deep-dives. Each route is the same class of
      // analytical surface as /insights/rewards (the overview), just
      // scoped to a single ledger type. Sit directly under the parent
      // "Rewards" entry so admins reach the breakdown they want without
      // first landing on the overview. The active-state logic in the
      // render path correctly deactivates the parent when one of these
      // sub-routes matches (longer prefix wins).
      { label: "Deposit Bonus", href: "/insights/rewards/deposit-bonus", icon: "Coins", isNew: true },
      { label: "Rakeback", href: "/insights/rewards/rakeback", icon: "Wallet", isNew: true },
      { label: "Race", href: "/insights/rewards/race", icon: "Flag", isNew: true },
      { label: "Affiliate", href: "/insights/rewards/affiliate", icon: "Share2", isNew: true },
      { label: "Sign Up", href: "/insights/rewards/signup", icon: "UserPlus", isNew: true },
      { label: "Streamers", href: "/insights/streamers", icon: "Tv", isNew: true },
      // Balance Adjustments — accountability surface for admin manual
      // credits/debits to user balances (admin_balance_adjustment ledger
      // rows + admin_audit_events attribution).
      { label: "Balance Adjustments", href: "/insights/balance-adjustments", icon: "Scale", isNew: true },
      // Edge Calc — theoretical EV / scenario simulator companion to
      // the other Insights surfaces (pure math, no historical query).
      { label: "Edge Calc", href: "/insights/edge-calc", icon: "Sigma", isNew: true },
    ],
  },
  {
    // Creator Marketing — the "who promotes us" half of the old
    // Marketing group, split out so creator-people management sits
    // separately from the campaign tooling. Sits ABOVE Marketing in
    // the sidebar so admins land on the people-management surfaces
    // first (typical workflow: vet a creator → grant tooling → track
    // their campaigns). Order inside matches the funnel: creators
    // (the list) → leaderboards (their public rankings) → socials
    // review (their onboarding gate).
    label: "Creator Marketing",
    items: [
      { label: "Creators", href: "/creators", icon: "Users" },
      { label: "Leaderboards", href: "/creators/leaderboards", icon: "Trophy" },
      { label: "Socials Review", href: "/creators/socials", icon: "ShieldCheck" },
    ],
  },
  {
    // Marketing — the campaign tools + acquisition surfaces. Creator-
    // people management (Creators, Leaderboards, Socials Review) lives
    // in the Creator Marketing group above; Analytics was dropped from
    // the sidebar entirely (still reachable at /creators/analytics,
    // just not surfaced here).
    label: "Marketing",
    items: [
      // Ads — third-party promo codes attached to specific campaigns.
      // Creators/Codes was removed from this group; promotional-code
      // workflows now live on /promo-codes (Rewards group).
      { label: "Ads", href: "/creators/ads", icon: "Megaphone" },
      // Promo / acquisition surfaces (previously in their own
      // "Marketing" group). Promo Codes was moved out of Marketing
      // into Rewards (it sits alongside the other user-facing
      // promo/reward levers there). Vouchers was also removed from
      // this group — the route still exists at /vouchers but is no
      // longer surfaced in nav.
      { label: "Gift Cards", href: "/gift-cards", icon: "Gift" },
      // Giveaway log — every balance-adjustment tagged as a giveaway
      // shows up here with the source tweet / Discord link, so the
      // marketing team has a single feed of "what we gave away and
      // why" without grepping the ledger.
      { label: "Giveaway", href: "/marketing/giveaway", icon: "Gift" },
      // Settings sits last in the group — it's the configuration
      // surface for the whole Marketing section, not a daily-use
      // entry, so it lives at the bottom under the working surfaces.
      { label: "Settings", href: "/creators/settings", icon: "Settings" },
    ],
  },
  {
    label: "Employees",
    items: [
      {
        label: "Salaries",
        href: "/salaries",
        icon: "Coins",
        usernameAllowlist: ["motha", "void", "kotha"],
      },
      { label: "Employee Board", href: "/employees", icon: "Network" },
      { label: "Shifts", href: "/shifts", icon: "CalendarClock" },
    ],
  },
  {
    label: "Content",
    items: [
      { label: "Packs", href: "/packs", icon: "Package" },
      { label: "Cards", href: "/cards", icon: "Layers" },
      { label: "Sets", href: "/sets", icon: "Library", isNew: true },
      { label: "Upgrader", href: "/upgrader", icon: "ArrowUpCircle", isNew: true },
    ],
  },
  {
    // The standalone /transactions overview was removed — admins
    // land on a specific sub-ledger here instead. Each per-type
    // entry filters the same ledger by the relevant ledger_type set.
    // Deposits + Withdrawals live in the Overview group at the top
    // (where they were before — keeping them discoverable as the
    // catch-all entry points for those money flows).
    label: "Transactions",
    items: [
      { label: "Packs", href: "/transactions/packs", icon: "Package" },
      { label: "Battles", href: "/battles", icon: "Swords" },
      { label: "Upgrader", href: "/transactions/upgrader", icon: "ArrowUpCircle" },
      { label: "Rewards", href: "/transactions/rewards", icon: "Award" },
    ],
  },
  {
    label: "Rewards",
    items: [
      // Analytics sits at the top of the Rewards group — admins land here
      // first to read the rollup before drilling into specific surfaces
      // (Rewards listing, Rakeback, Promo Codes, Raffles, etc.).
      { label: "Analytics", href: "/rewards/analytics", icon: "BarChart3" },
      { label: "Rewards", href: "/rewards", icon: "Award" },
      { label: "Rakeback", href: "/rewards/rakeback", icon: "Percent" },
      // Promo Codes — moved here from the Marketing group; it's a
      // user-facing promo lever, so it sits next to the other promo
      // surfaces (Rakeback above, Raffles/Rain below).
      { label: "Promo Codes", href: "/promo-codes", icon: "Tag" },
      { label: "Raffles", href: "/rewards/raffles", icon: "Ticket" },
      { label: "Rain", href: "/rain", icon: "CloudRain" },
      { label: "Leaderboards", href: "/rewards/leaderboards", icon: "Trophy" },
      { label: "Level Up", href: "/rewards/level-up", icon: "TrendingUp" },
      { label: "Settings", href: "/rewards/settings", icon: "Settings" },
    ],
  },
  {
    label: "Creator Portal",
    creatorOnly: true,
    items: [
      { label: "My Profile", href: "/my-profile", icon: "UserCircle" },
    ],
  },
  {
    label: "Test Tools",
    devEnvOnly: true,
    items: [
      { label: "Creator Testing", href: "/test/creator", icon: "FlaskConical" },
    ],
  },
  {
    label: "Security",
    items: [
      { label: "Security", href: "/security", icon: "Shield" },
    ],
  },
  {
    label: "System",
    items: [
      { label: "Users", href: "/admin-users", icon: "ShieldCheck" },
      { label: "Roles", href: "/settings/roles", icon: "KeyRound" },
      { label: "Bots", href: "/bots", icon: "Bot" },
      { label: "Settings", href: "/settings", icon: "Settings" },
      // Excluded users blacklist — motha-only entry point. The page
      // itself ALSO enforces the gate server-side, so this is just a
      // UI hide; the security boundary is in the page + actions.
      {
        label: "Excluded Users",
        href: "/system/excluded-users",
        icon: "Ban",
        usernameAllowlist: ["motha"],
      },
      { label: "Audit Log", href: "/audit", icon: "FileText" },
      { label: "Commands", href: "/system/commands", icon: "Command" },
      { label: "Dashboard Stats", href: "/system/stats", icon: "Gauge" },
    ],
  },
];

const STORAGE_KEY = "sidebar-collapsed-groups";

function useCollapsedGroups(activeGroupLabel: string | undefined) {
  const [openGroups, setOpenGroups] = useState<Record<string, boolean>>(() => {
    const defaults: Record<string, boolean> = {};
    NAV_GROUPS.forEach((g) => { defaults[g.label] = false; });
    return defaults;
  });

  useEffect(() => {
    try {
      const stored = localStorage.getItem(STORAGE_KEY);
      if (stored) {
        const parsed = JSON.parse(stored) as Record<string, boolean>;
        if (activeGroupLabel) parsed[activeGroupLabel] = true;
        setOpenGroups(parsed);
      } else if (activeGroupLabel) {
        setOpenGroups((prev) => ({ ...prev, [activeGroupLabel]: true }));
      }
    } catch {
      // fallback: keep defaults (all collapsed)
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (activeGroupLabel) {
      setOpenGroups((prev) => {
        if (prev[activeGroupLabel]) return prev;
        const next = { ...prev, [activeGroupLabel]: true };
        localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
        return next;
      });
    }
  }, [activeGroupLabel]);

  const toggleGroup = useCallback((label: string) => {
    setOpenGroups((prev) => {
      const next = { ...prev, [label]: !prev[label] };
      localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
      return next;
    });
  }, []);

  return { openGroups, toggleGroup };
}

export function AppSidebar({
  role,
  allowedPages,
  username,
  dbEnv,
}: {
  role: string;
  allowedPages: string[];
  username: string;
  dbEnv: "prod" | "dev";
}) {
  const pathname = usePathname();
  const isAdmin = role === "admin";

  const groupsWithVisibility = useMemo(() =>
    NAV_GROUPS
      // devEnvOnly groups (e.g. Test Tools) hide entirely on prod.
      .filter((group) => !group.devEnvOnly || dbEnv === "dev")
      .map((group) => ({
        ...group,
        visibleItems: group.items.filter((item) => {
          // usernameAllowlist is the strictest — even real admins
          // don't see it unless their username is in the list.
          // Used for /salaries which is a founder-only entry-point,
          // not a role-based one. Comparison is case-insensitive.
          if (
            item.usernameAllowlist &&
            !item.usernameAllowlist.some(
              (u) => u.toLowerCase() === (username ?? "").toLowerCase(),
            )
          ) {
            return false;
          }
          return isAdmin || allowedPages.includes(item.href);
        }),
      })),
  [isAdmin, allowedPages, username, dbEnv]);

  const activeGroupLabel = useMemo(() =>
    groupsWithVisibility.find((group) =>
      group.visibleItems.some(
        (item) =>
          pathname === item.href ||
          (item.href !== "/dashboard" && pathname.startsWith(item.href + "/"))
      )
    )?.label,
  [groupsWithVisibility, pathname]);

  const { openGroups, toggleGroup } = useCollapsedGroups(activeGroupLabel);
  // When the whole sidebar is collapsed to icon mode, skip the per-group
  // Collapsible wrapper and render items flat. Otherwise the user has
  // nowhere to click the group header (it's hidden in icon mode) so items
  // in a closed group would be unreachable.
  const { state, isMobile, setOpenMobile } = useSidebar();
  const isIconMode = state === "collapsed";

  // On mobile the sidebar lives inside a Sheet drawer that doesn't
  // auto-close when a Link inside it navigates — the page changes
  // underneath the still-open drawer, which felt like "clicking does
  // nothing" because the new page is hidden behind the overlay. This
  // closes the drawer on every navigation tap inside the mobile
  // sidebar; on desktop it's a no-op.
  const handleNavTap = useCallback(() => {
    if (isMobile) setOpenMobile(false);
  }, [isMobile, setOpenMobile]);

  return (
    <Sidebar collapsible="icon">
      <SidebarHeader className="border-b border-border px-4 h-14 flex items-center justify-center group-data-[collapsible=icon]:px-0">
        <Link
          href={getDefaultRoute(role, allowedPages)}
          onClick={handleNavTap}
          className="flex justify-center"
        >
          {/* Expanded wordmark. Light mode uses logo-light.png — the exact
              same artwork as logo.png (identical 390×91 geometry, so sizing
              and placement match dark mode pixel-for-pixel), just with the
              wordmark recolored to dark ink so it's visible on a light
              background. Dark mode keeps logo.png. Both hide when collapsed. */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/logo-light.png" alt="PackyGG" className="h-6 group-data-[collapsible=icon]:hidden dark:hidden" />
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/logo.png" alt="Pokewin" className="h-6 hidden dark:block group-data-[collapsible=icon]:hidden" />
          {/* Collapsed (icon) mode: show the compact favicon-sized mark */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/icon.png" alt="Pokewin" className="h-7 w-7 hidden group-data-[collapsible=icon]:block" />
        </Link>
      </SidebarHeader>
      <SidebarContent>
        {groupsWithVisibility.map((group) => {
          if (group.creatorOnly && role !== "creator") return null;
          const { visibleItems } = group;
          if (visibleItems.length === 0) return null;
          const isOpen = openGroups[group.label] ?? false;

          const menuItems = (
            <SidebarMenu>
              {visibleItems.map((item) => {
                const Icon = ICONS[item.icon];
                const isActive =
                  pathname === item.href ||
                  (item.href !== "/dashboard" &&
                    pathname.startsWith(item.href + "/") &&
                    !visibleItems.some(
                      (other) => other.href !== item.href && pathname.startsWith(other.href)
                    ));
                return (
                  <SidebarMenuItem key={item.href}>
                    <SidebarMenuButton
                      isActive={isActive}
                      tooltip={item.label}
                      render={<Link href={item.href} />}
                      onClick={handleNavTap}
                      // 44px tap target inside the mobile drawer; falls
                      // back to the compact 36px height on md+ where
                      // density matters more than tap area. group-data
                      // attribute keeps icon-mode (collapsed desktop) at
                      // its forced 32px square.
                      className="h-11 md:h-9 group-data-[collapsible=icon]:h-8!"
                    >
                      <Icon className={cn("size-4", isActive ? "text-primary" : "text-muted-foreground")} />
                      <span>{item.label}</span>
                      {item.isNew && (
                        <span className="ml-auto rounded-sm bg-emerald-500/15 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-emerald-600 group-data-[collapsible=icon]:hidden dark:text-emerald-400">
                          New
                        </span>
                      )}
                    </SidebarMenuButton>
                  </SidebarMenuItem>
                );
              })}
            </SidebarMenu>
          );

          // Icon mode: render items flat, skip the Collapsible group header
          // entirely so nothing is unreachable. Each button shows a tooltip
          // on hover courtesy of shadcn's SidebarMenuButton.
          if (isIconMode) {
            return (
              <SidebarGroup key={group.label} className="px-2 py-1">
                <SidebarGroupContent>{menuItems}</SidebarGroupContent>
              </SidebarGroup>
            );
          }

          return (
            <Collapsible
              key={group.label}
              open={isOpen}
              onOpenChange={() => toggleGroup(group.label)}
            >
              <SidebarGroup className="px-2 py-1">
                {/* Group header: 44px tap target on mobile (drawer mode)
                    so a thumb can comfortably hit it; compacts back to
                    h-9 on md+ where the cursor handles it. */}
                <CollapsibleTrigger
                  className={cn(
                    "flex h-11 w-full shrink-0 cursor-pointer select-none items-center justify-between rounded-md px-2 text-xs font-semibold uppercase tracking-wider transition-colors hover:text-sidebar-foreground md:h-9",
                    group.label === activeGroupLabel
                      ? "bg-sidebar-accent text-sidebar-foreground"
                      : "text-sidebar-foreground/50",
                  )}
                >
                  <span className="truncate">{group.label}</span>
                  <ChevronRight
                    className={cn(
                      "size-3 shrink-0 transition-transform duration-200",
                      isOpen && "rotate-90",
                    )}
                  />
                </CollapsibleTrigger>
                <CollapsibleContent className="mt-0.5">
                  <SidebarGroupContent>{menuItems}</SidebarGroupContent>
                </CollapsibleContent>
              </SidebarGroup>
            </Collapsible>
          );
        })}
      </SidebarContent>
      <SidebarFooter className="border-t border-border">
        <div className="flex items-center justify-between px-2 group-data-[collapsible=icon]:justify-center">
          <span className="text-xs text-muted-foreground group-data-[collapsible=icon]:hidden">Theme</span>
          <ThemeToggle />
        </div>
      </SidebarFooter>
    </Sidebar>
  );
}
