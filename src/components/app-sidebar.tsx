"use client";

import { useState, useEffect, useCallback, useMemo } from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Activity,
  Bell,
  LayoutDashboard,
  BarChart3,
  Users,
  ArrowDownToLine,
  Receipt,
  FileText,
  Package,
  Settings,
  Tag,
  Share2,
  MessageSquare,
  Gift,
  CalendarDays,
  CalendarRange,
  CloudRain,
  Command,
  Gauge,
  Bot,
  Shield,
  ShieldCheck,
  KeyRound,
  SquareKanban,
  Trophy,
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
  Joystick,
  Tv,
  Sigma,
  Wallet,
  Flag,
  UserPlus,
  Scale,
  History,
  SlidersHorizontal,
  Sparkles,
  ArrowRight,
  Target,
  Hash,
  Hourglass,
  PackageOpen,
  PieChart,
  Anchor,
  Dices,
  Crown,
  Eye,
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
import { pageAccessGranted } from "@/lib/admin-pages";
import { ThemeToggle } from "@/components/theme-toggle";
import { AppSwitcher } from "@/components/app-switcher";
import { getSidebarFooterItems, getSidebarGroups } from "@/lib/nav-config";
import { LinkPending } from "@/components/ux";

const ICONS: Record<string, LucideIcon> = {
  Activity,
  Bell,
  LayoutDashboard,
  BarChart3,
  Users,
  ArrowDownToLine,
  Receipt,
  FileText,
  Package,
  Settings,
  Tag,
  Share2,
  MessageSquare,
  Gift,
  CalendarDays,
  CalendarRange,
  CloudRain,
  Command,
  Gauge,
  Bot,
  Shield,
  ShieldCheck,
  KeyRound,
  SquareKanban,
  Trophy,
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
  Joystick,
  Tv,
  Sigma,
  Wallet,
  Flag,
  UserPlus,
  Scale,
  History,
  SlidersHorizontal,
  Sparkles,
  ArrowRight,
  Target,
  Hash,
  Hourglass,
  PackageOpen,
  PieChart,
  Anchor,
  Dices,
  Crown,
  Eye,
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
  // When true, the usernameAllowlist is STRICT: the generic owner
  // bypass (isOwner) does NOT apply, so only a username actually in the
  // allowlist sees the item. Used for the root-owner-only (motha)
  // Excluded Users entry — every non-root owner is still hidden.
  strictUsernameAllowlist?: boolean;
  // Renders a small "NEW" badge next to the label to surface a
  // recently-added page. Purely cosmetic — remove once the team has
  // discovered the page.
  isNew?: boolean;
  // Visible to every authenticated dashboard user, regardless of page grants.
  alwaysVisible?: boolean;
  // Role required unless the viewer is an admin or owner.
  roleAllowlist?: string[];
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
const NAV_FOOTER_ITEMS: NavItem[] = getSidebarFooterItems().map((e) => ({
  label: e.label,
  href: e.href,
  icon: e.sidebarIcon ?? e.icon,
  usernameAllowlist: e.usernameAllowlist,
  strictUsernameAllowlist: e.strictUsernameAllowlist,
  isNew: e.isNew,
  alwaysVisible: e.alwaysVisible,
  roleAllowlist: e.roleAllowlist,
}));

const NAV_GROUPS: NavGroup[] = getSidebarGroups().map((group) => ({
  label: group.label,
  creatorOnly: group.creatorOnly,
  devEnvOnly: group.devEnvOnly,
  items: group.items.map((e) => ({
    label: e.label,
    href: e.href,
    icon: e.sidebarIcon ?? e.icon,
    usernameAllowlist: e.usernameAllowlist,
    strictUsernameAllowlist: e.strictUsernameAllowlist,
    isNew: e.isNew,
    alwaysVisible: e.alwaysVisible,
    roleAllowlist: e.roleAllowlist,
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
  canEnterCreatorHub = false,
  canEnterPackStudio = false,
  canEnterAntifraud = false,
  isOwner = false,
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
  // Whether to show the "Switch to Creator Hub" portal button. Computed
  // SERVER-SIDE by the layout (it depends on ADMIN-DB access toggles the
  // client can't read) via `canAccessCreatorHub`, and matched 1:1 to the
  // /creator-hub route guard. Defaults to false (fail-closed) so a missing
  // prop never reveals the portal. With both toggles off only `motha` gets
  // `true`.
  canEnterCreatorHub?: boolean;
  // Whether to show the "Switch to Pack Studio" portal button. Computed
  // SERVER-SIDE by the layout (it depends on ADMIN-DB access toggles the
  // client can't read) via `canAccessPackStudio`, and matched 1:1 to the
  // /pack-studio route guard. Defaults to false (fail-closed) so a missing
  // prop never reveals the portal. With the toggle off only an owner gets
  // `true`.
  canEnterPackStudio?: boolean;
  // Whether to show the "Switch to Antifraud" portal button — the THIRD
  // sub-app card, directly below Pack Studio. Computed SERVER-SIDE by the
  // layout (it depends on ADMIN-DB toggles + the per-username allow/deny lists
  // the client can't read) via `canAccessAntifraud`, and matched 1:1 to the
  // /antifraud route guard. Defaults to false (fail-closed) so a missing prop
  // never reveals the portal.
  canEnterAntifraud?: boolean;
  // OWNER / ultra-admin flag, computed SERVER-SIDE by the layout from the
  // DB-fresh session. An owner bypasses the `usernameAllowlist` cosmetic gate
  // (so the owner-only nav items — Salaries, Excluded Users, the Insights group
  // — show for ANY owner, not just `motha`) AND the page-access check (owners
  // see every page, like admins). Defaults false (fail-closed) so a missing
  // prop never reveals owner-only items.
  isOwner?: boolean;
}) {
  const pathname = usePathname();
  // Sub-app portals must be ABSOLUTE on a segment host — a bare /pack-studio
  // there would be rewritten into the current segment. Resolved client-side
  // (see use-app-host) so no layout has to thread the hostname down.
  const effectiveRoles = useMemo(() => roles ?? [role], [role, roles]);
  const isAdmin = effectiveRoles.includes("admin");
  const isCreator = effectiveRoles.includes("creator");

  const visibleFooterItems = useMemo(
    () =>
      NAV_FOOTER_ITEMS.filter((item) => {
        // Owners bypass the username allowlist (they see every owner-only item),
        // UNLESS the item is strict — then only a username actually in the
        // allowlist passes (used for the root-owner-only Excluded Users entry).
        const ownerBypassesAllowlist = isOwner && !item.strictUsernameAllowlist;
        const inAllowlist = item.usernameAllowlist?.some(
          (u) => u.toLowerCase() === (username ?? "").toLowerCase(),
        );
        if (item.usernameAllowlist && !ownerBypassesAllowlist && !inAllowlist) {
          return false;
        }
        // A strict allowlist item is gated purely by the allowlist above — the
        // admin/owner "see every page" shortcut must not re-reveal it.
        if (item.strictUsernameAllowlist) {
          return Boolean(inAllowlist);
        }
        if (
          item.roleAllowlist &&
          !isAdmin &&
          !isOwner &&
          !item.roleAllowlist.some((requiredRole) =>
            effectiveRoles.includes(requiredRole),
          )
        ) {
          return false;
        }
        if (item.alwaysVisible) return true;
        // Owners + admins see every page.
        return isAdmin || isOwner || pageAccessGranted(allowedPages, item.href);
      }),
    [isAdmin, isOwner, allowedPages, username, effectiveRoles],
  );

  const groupsWithVisibility = useMemo(() =>
    NAV_GROUPS
      // devEnvOnly groups (e.g. Test Tools) hide entirely on prod.
      .filter((group) => !group.devEnvOnly || dbEnv === "dev")
      .map((group) => ({
        ...group,
        visibleItems: group.items.filter((item) => {
          // usernameAllowlist is the strictest — even real admins
          // don't see it unless their username is in the list (or they
          // are an OWNER, who bypasses it). Used for /salaries + the
          // Insights group, owner-only entry-points. Case-insensitive.
          //
          // A STRICT allowlist (strictUsernameAllowlist) is not bypassed by the
          // generic owner flag — only a listed username passes. Used for the
          // root-owner-only (motha) Excluded Users entry.
          const ownerBypassesAllowlist = isOwner && !item.strictUsernameAllowlist;
          const inAllowlist = item.usernameAllowlist?.some(
            (u) => u.toLowerCase() === (username ?? "").toLowerCase(),
          );
          if (item.usernameAllowlist && !ownerBypassesAllowlist && !inAllowlist) {
            return false;
          }
          // A strict allowlist item is gated purely by the allowlist above — the
          // admin/owner "see every page" shortcut must not re-reveal it.
          if (item.strictUsernameAllowlist) {
            return Boolean(inAllowlist);
          }
          if (
            item.roleAllowlist &&
            !isAdmin &&
            !isOwner &&
            !item.roleAllowlist.some((requiredRole) =>
              effectiveRoles.includes(requiredRole),
            )
          ) {
            return false;
          }
          if (item.alwaysVisible) return true;
          // Owners + admins see every page.
          return isAdmin || isOwner || pageAccessGranted(allowedPages, item.href);
        }),
      })),
  [isAdmin, isOwner, allowedPages, username, dbEnv, effectiveRoles]);

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
      <SidebarHeader className="border-b border-sidebar-border/60 px-4 h-16 flex items-center justify-center group-data-[collapsible=icon]:px-0">
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
          <img src="/logo-light.png" alt="PackyGG" className="h-7 group-data-[collapsible=icon]:hidden dark:hidden" />
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/logo.png" alt="Pokewin" className="h-7 hidden dark:block group-data-[collapsible=icon]:hidden" />
          {/* Collapsed (icon) mode: show the compact favicon-sized mark */}
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img src="/icon.png" alt="Pokewin" className="h-8 w-8 hidden group-data-[collapsible=icon]:block" />
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
                // Fallback to ScrollText if an icon key is unmapped — never
                // render <undefined/> (that throws React #130 and crashes the
                // whole admin shell, since this renders inside the root layout).
                const Icon = ICONS[item.icon] ?? ScrollText;
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
                      // Marks the current route's link for assistive tech.
                      // The visual active state already comes from `isActive`
                      // (data-active bg/text-primary in the primitive); this
                      // adds the matching `aria-current="page"` a11y hook.
                      aria-current={isActive ? "page" : undefined}
                      tooltip={item.label}
                      render={<Link href={item.href} />}
                      onClick={handleNavTap}
                      // 44px tap target inside the mobile drawer; falls
                      // back to the compact 36px height on md+ where
                      // density matters more than tap area. group-data
                      // attribute keeps icon-mode (collapsed desktop) at
                      // its forced 32px square.
                      //
                      // Interaction polish (motion-safe only): ease the
                      // icon/text COLOR on hover (the base primitive only
                      // transitions background-color, so text color hard-
                      // snapped) and add a brief settle-on-press scale so the
                      // row reads as a physical tap. The transition list
                      // re-includes the primitive's own width/height/padding so
                      // the collapse animation is unchanged. Reduced-motion
                      // users get none of this (no tween, no scale).
                      //
                      // Active treatment — ONE cohesive accent state (no
                      // grey-pill-plus-clashing-blue): a single soft
                      // sidebar-primary wash (bg-sidebar-primary/15) with the
                      // accent carried on the label + icon (text-sidebar-primary)
                      // and a small rounded left indicator bar drawn by the
                      // ::before pseudo-element. `data-active:bg-sidebar-primary/15`
                      // deliberately OVERRIDES the primitive's own
                      // `data-active:bg-sidebar-accent` grey fill (twMerge keeps
                      // this later bg-color), so the active row reads as one
                      // harmonious tinted pill instead of a grey pill fighting a
                      // blue accent. All sidebar tokens → correct hue in every
                      // theme (blue light/dark, cyan grailed). Pure CSS state
                      // styles — nav logic untouched. The indicator hides in
                      // icon-collapsed mode (the 32px square button leaves no
                      // gutter for it); the wash + accent icon still mark it there.
                      className="relative h-11 rounded-lg md:h-9 group-data-[collapsible=icon]:h-8! data-active:bg-sidebar-primary/15 data-active:text-sidebar-primary before:pointer-events-none before:absolute before:inset-y-2 before:left-0 before:w-0.5 before:rounded-full before:bg-sidebar-primary before:opacity-0 data-active:before:opacity-100 group-data-[collapsible=icon]:before:hidden motion-safe:transition-[color,background-color,width,height,padding,transform] motion-safe:duration-150 motion-safe:ease-out motion-safe:active:scale-[0.98]"
                    >
                      <Icon className={cn("size-4", isActive ? "text-sidebar-primary" : "text-muted-foreground")} />
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
                    // Group label: canonical micro-caps rhythm (11px /
                    // medium / 0.14em) so section labels read as quiet
                    // chrome, not competing nav items.
                    "flex h-11 w-full shrink-0 cursor-pointer select-none items-center justify-between rounded-md px-2 text-[11px] font-medium uppercase tracking-[0.14em] transition-[color,background-color,transform] hover:bg-sidebar-accent/50 hover:text-sidebar-foreground md:h-9 motion-safe:active:scale-95",
                    // Active section: quiet accent-colored label (no grey fill).
                    // Previously this was a solid `bg-sidebar-accent` grey pill
                    // that sat right above the active item's blue accent pill —
                    // the two competing fills read as "grey background AND blue
                    // one" and clashed. Tinting just the label with the same
                    // sidebar-primary accent ties the section to its active item
                    // in ONE hue with zero competing grey. Hover still gets the
                    // transient grey wash above, so hover stays clearly distinct.
                    group.label === activeGroupLabel
                      ? "text-sidebar-primary"
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
      <SidebarFooter className="border-t border-sidebar-border/60">
        {visibleFooterItems.length > 0 && (
          <SidebarMenu>
            {visibleFooterItems.map((item) => {
              const Icon = ICONS[item.icon] ?? ScrollText;
              const isActive =
                pathname === item.href ||
                (item.href !== "/dashboard" &&
                  pathname.startsWith(item.href + "/"));
              return (
                <SidebarMenuItem key={item.href}>
                  <SidebarMenuButton
                    isActive={isActive}
                    // Matching a11y + interaction polish to the main nav items
                    // above (aria-current for the active route; motion-safe
                    // color/press easing; reduced-motion users unaffected).
                    aria-current={isActive ? "page" : undefined}
                    tooltip={item.label}
                    render={<Link href={item.href} />}
                    onClick={handleNavTap}
                    // Same single cohesive accent active treatment as the main
                    // nav rows above (sidebar-primary wash + accent label/icon +
                    // left indicator bar; overrides the primitive's grey active
                    // fill so there is no grey-plus-blue clash).
                    className="relative h-11 rounded-lg md:h-9 group-data-[collapsible=icon]:h-8! data-active:bg-sidebar-primary/15 data-active:text-sidebar-primary before:pointer-events-none before:absolute before:inset-y-2 before:left-0 before:w-0.5 before:rounded-full before:bg-sidebar-primary before:opacity-0 data-active:before:opacity-100 group-data-[collapsible=icon]:before:hidden motion-safe:transition-[color,background-color,width,height,padding,transform] motion-safe:duration-150 motion-safe:ease-out motion-safe:active:scale-[0.98]"
                  >
                    <Icon
                      className={cn(
                        "size-4",
                        isActive ? "text-sidebar-primary" : "text-muted-foreground",
                      )}
                    />
                    <span>{item.label}</span>
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
        )}
        {/* Workspace switcher — one segmented control replacing the three
            stacked "Switch to X" cards this footer used to carry. Which
            segments render is decided SERVER-SIDE (the canEnter* props, each
            matched 1:1 to its route guard), so nobody sees a door they'd bounce
            off. The routes stay independently gated regardless. */}
        <AppSwitcher
          current="admin"
          access={{
            creatorHub: canEnterCreatorHub,
            packStudio: canEnterPackStudio,
            antifraud: canEnterAntifraud,
          }}
          onNavigate={handleNavTap}
        />
        <div className="flex items-center justify-between px-2 group-data-[collapsible=icon]:justify-center">
          <span className="text-[11px] font-medium uppercase tracking-[0.14em] text-muted-foreground group-data-[collapsible=icon]:hidden">Theme</span>
          <ThemeToggle />
        </div>
      </SidebarFooter>
    </Sidebar>
  );
}
