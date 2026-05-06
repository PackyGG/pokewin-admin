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
  Percent,
  TrendingUp,
  UserCircle,
  Wallet,
  Globe,
  Megaphone,
  CalendarClock,
  Coins,
  ChevronRight,
  FlaskConical,
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
  Percent,
  TrendingUp,
  UserCircle,
  Wallet,
  Globe,
  Megaphone,
  CalendarClock,
  Coins,
  FlaskConical,
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
      { label: "Map", href: "/map", icon: "Globe" },
      { label: "Users", href: "/users", icon: "Users" },
      { label: "Deposits", href: "/transactions/deposits", icon: "ArrowDownToLine" },
      { label: "Withdrawals", href: "/withdrawals", icon: "ArrowDownToLine" },
    ],
  },
  {
    label: "Creators",
    items: [
      // Analytics sits at the top — it's the "what's happening across
      // creators right now" overview, so admins land on it first when
      // expanding the group.
      { label: "Analytics", href: "/creators/analytics", icon: "BarChart3" },
      { label: "Creators", href: "/creators", icon: "Users" },
      // Ads is the more frequently-used surface (third-party promo
      // codes attached to specific campaigns) so it sits above Codes
      // (which is the raw code list).
      { label: "Ads", href: "/creators/ads", icon: "Megaphone" },
      { label: "Codes", href: "/creators/codes", icon: "Share2" },
      { label: "Leaderboards", href: "/creators/leaderboards", icon: "Trophy" },
      { label: "Socials Review", href: "/creators/socials", icon: "ShieldCheck" },
      { label: "Settings", href: "/creators/settings", icon: "Settings" },
    ],
  },
  {
    label: "Marketing",
    items: [
      { label: "Promo Codes", href: "/promo-codes", icon: "Tag" },
      { label: "Gift Cards", href: "/gift-cards", icon: "Gift" },
      { label: "Vouchers", href: "/vouchers", icon: "Ticket" },
    ],
  },
  {
    label: "Employees",
    items: [
      { label: "Shifts", href: "/shifts", icon: "CalendarClock" },
      { label: "Spending", href: "/spending", icon: "Wallet" },
      {
        label: "Salaries",
        href: "/salaries",
        icon: "Coins",
        usernameAllowlist: ["motha", "void", "kotha"],
      },
    ],
  },
  {
    label: "Content",
    items: [
      { label: "Packs", href: "/packs", icon: "Package" },
      { label: "Cards", href: "/cards", icon: "Layers" },
      { label: "Battles", href: "/battles", icon: "Swords" },
    ],
  },
  {
    label: "Transactions",
    items: [
      { label: "All", href: "/transactions", icon: "Receipt" },
      { label: "Packs", href: "/transactions/packs", icon: "Package" },
      { label: "Battles", href: "/transactions/battles", icon: "Swords" },
      { label: "Rewards", href: "/transactions/rewards", icon: "Award" },
    ],
  },
  {
    label: "Rewards",
    items: [
      { label: "Rewards", href: "/rewards", icon: "Award" },
      { label: "Rakeback", href: "/rewards/rakeback", icon: "Percent" },
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
      { label: "Roles", href: "/admin-users/roles", icon: "KeyRound" },
      { label: "Role Permissions", href: "/settings/roles", icon: "Shield" },
      { label: "Bots", href: "/bots", icon: "Bot" },
      { label: "Settings", href: "/settings", icon: "Settings" },
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
          {/* Expanded mode: wordmark (same logo for both light and dark theme) */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/logo.png" alt="Pokewin" className="h-6 group-data-[collapsible=icon]:hidden" />
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
