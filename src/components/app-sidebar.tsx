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
  TrendingDown,
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
import { getSidebarGroups } from "@/lib/nav-config";
import { LinkPending } from "@/components/ux";

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
  TrendingDown,
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

// Derived from the single shared nav config (src/lib/nav-config.ts) — the
// same source the command palette + /system/commands docs page derive from.
// Each sidebar item's `href` is what the visibility filter matches against
// `allowedPages` (every in-sidebar entry has href === pageKey, so this is
// identical to gating on the permission key). The sidebar uses `sidebarIcon`
// when set, otherwise the entry's base `icon`.
const NAV_GROUPS: NavGroup[] = getSidebarGroups().map((group) => ({
  label: group.label,
  creatorOnly: group.creatorOnly,
  devEnvOnly: group.devEnvOnly,
  items: group.items.map((e) => ({
    label: e.label,
    href: e.href,
    icon: e.sidebarIcon ?? e.icon,
    usernameAllowlist: e.usernameAllowlist,
    isNew: e.isNew,
  })),
}));

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
  roles,
  allowedPages,
  username,
  dbEnv,
}: {
  role: string;
  // Full effective role set (defaults to [role] for legacy single-role).
  // Used for the admin bypass + the creator-only group so a multi-role
  // user that merely INCLUDES admin/creator is treated correctly even
  // when that isn't their highest-privilege primary role.
  roles?: string[];
  allowedPages: string[];
  username: string;
  dbEnv: "prod" | "dev";
}) {
  const pathname = usePathname();
  const effectiveRoles = roles ?? [role];
  const isAdmin = effectiveRoles.includes("admin");
  const isCreator = effectiveRoles.includes("creator");

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
          // Subtle press feedback matching the house interaction feel:
          // a soft hover dim + a brief settle-on-press scale. Motion is
          // fully `motion-safe:` gated (reduced-motion users land on the
          // final state with no transform/tween) and purely cosmetic — the
          // href / navigation behaviour is unchanged. `rounded-md` just
          // clips the focus-visible ring to the logo box; `flex
          // justify-center` is preserved so centering is untouched.
          className="flex justify-center rounded-md outline-none hover:opacity-80 focus-visible:ring-2 focus-visible:ring-ring motion-safe:transition-[transform,opacity] motion-safe:duration-150 motion-safe:ease-out motion-safe:active:scale-95"
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
          if (group.creatorOnly && !isCreator) return null;
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
                      {/* Per-link pending cue — reads this <Link>'s
                          `useLinkStatus()` and shows a small spinner only
                          while THIS item's navigation is in flight, so a slow
                          server render reads as "loading" instead of a dead
                          click. Renders null otherwise (zero footprint) and
                          hides in icon-collapsed mode to keep the 32px button
                          square. `ml-auto` parks it on the right edge unless
                          the NEW badge already claimed that slot. */}
                      <LinkPending
                        size={13}
                        className={cn(
                          "shrink-0 group-data-[collapsible=icon]:hidden",
                          !item.isNew && "ml-auto",
                        )}
                      />
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
                    // Added: a hover background tint + a brief settle-on-
                    // press scale so the group header reads as a physical
                    // tap, matching the house interaction feel. The scale is
                    // `motion-safe:active:` only (reduced-motion users never
                    // get the transform class) and the transition now covers
                    // colors + transform so both ease. Collapse toggle
                    // behaviour itself is unchanged.
                    "flex h-11 w-full shrink-0 cursor-pointer select-none items-center justify-between rounded-md px-2 text-xs font-semibold uppercase tracking-wider transition-[color,background-color,transform] hover:bg-sidebar-accent/50 hover:text-sidebar-foreground md:h-9 motion-safe:active:scale-95",
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
