"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Crown,
  Gift,
  LayoutDashboard,
  ScrollText,
  Megaphone,
  Users,
  Trophy,
  ShieldCheck,
  Calculator,
  TrendingUp,
  type LucideIcon,
} from "lucide-react";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarGroup,
  SidebarGroupContent,
  SidebarGroupLabel,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar";
import { cn } from "@/lib/utils";
import { ThemeToggle } from "@/components/theme-toggle";
import { LinkPending } from "@/components/ux";
import { AppSwitcher, type AppSwitcherAccess } from "@/components/app-switcher";
import { useAppHost } from "@/lib/use-app-host";
import { hrefFrom } from "@/lib/app-hosts";
import {
  NavAlertBadge,
  type NavAlertKey,
  useNavAlertBadges,
} from "@/components/nav-alert-badge";

/**
 * Creator Hub sidebar — the swapped nav rendered by the Creator Hub
 * layout INSTEAD of the main `AppSidebar`. Reuses the same shadcn
 * `Sidebar` primitive geometry (so the SidebarProvider/SidebarInset
 * collapse + width math is shared), but gives the sub-app its own
 * identity: the Packy wordmark (same assets as the main sidebar), a
 * "Back to Admin" exit at the top, and its own nav list.
 *
 * Live nav, sectioned (owner request 2026-07-29): Overview (Dashboard,
 * Creator Rewards),
 * Creators (Roster, Creator Fraud, Socials Review), Programs & Payouts
 * (Leaderboards, Tips & Sponsors), Economics
 * (Profitability, ROI Calculator). The theme toggle sits in the footer.
 *
 * Removed 2026-07-23 (owner): All Sessions, Wager / Fraud Abusers and
 * Changelog — Changelog still exists in the main admin app
 * (`/creators/changelog`). Leaderboards was removed in the same pass and
 * RESTORED at the owner's request; the admin surface
 * (`/creators/leaderboards`) remains the write/approval side.
 *
 * Client-safe: no DB / server-only imports. Icons are direct
 * `lucide-react` component refs (not the string-keyed ICONS map the main
 * sidebar uses), so there's no React #130 icon-registry coupling here.
 */

type HubNavItem = {
  label: string;
  href: string;
  icon: LucideIcon;
  alertKey?: NavAlertKey;
};

type HubNavGroup = {
  label: string;
  items: HubNavItem[];
};

/**
 * Sectioned nav (owner request 2026-07-29): the flat "Workspace" list grew to
 * 9 items, so the sidebar now groups them by job — mirroring the antifraud
 * sidebar's sectioning. Route ownership is unchanged; this is purely nav
 * structure.
 */
const HUB_NAV_GROUPS: HubNavGroup[] = [
  {
    label: "Overview",
    items: [
      { label: "Dashboard", href: "/creator-hub", icon: LayoutDashboard },
      {
        label: "Creator Rewards",
        href: "/creator-hub/rewards",
        icon: Crown,
        alertKey: "creatorRewards",
      },
      { label: "Terms", href: "/creator-hub/tos", icon: ScrollText },
    ],
  },
  {
    label: "Creators",
    items: [
      { label: "Roster", href: "/creator-hub/creators", icon: Users },
      {
        label: "Creator Fraud",
        href: "/creator-hub/creator-fraud",
        icon: Megaphone,
      },
      {
        label: "Socials Review",
        href: "/creator-hub/socials-review",
        icon: ShieldCheck,
      },
    ],
  },
  {
    label: "Programs & Payouts",
    items: [
      {
        label: "Leaderboards",
        href: "/creator-hub/leaderboards",
        icon: Trophy,
      },
      {
        label: "Tips & Sponsors",
        href: "/creator-hub/tips-sponsors",
        icon: Gift,
      },
    ],
  },
  {
    label: "Economics",
    items: [
      {
        label: "Profitability",
        href: "/creator-hub/profitability",
        icon: TrendingUp,
      },
      {
        label: "ROI Calculator",
        href: "/creator-hub/profitable-algo",
        icon: Calculator,
      },
    ],
  },
];

function HubNavMenu({
  items,
  pathname,
  onNavTap,
  toHref,
  alertCounts,
  onAlertSeen,
}: {
  items: HubNavItem[];
  pathname: string;
  onNavTap: () => void;
  /**
   * Canonical path → the href for the current host. On marketing.packydash.com
   * the `/creator-hub` prefix is stripped, which BOTH keeps the URL clean and
   * keeps the active check below honest: after the middleware rewrite the
   * browser URL is the short form, so comparing it against the long form would
   * mark every item inactive.
   */
  toHref: (path: string) => string;
  alertCounts?: Partial<Record<NavAlertKey, number>>;
  onAlertSeen?: (key: NavAlertKey) => void;
}) {
  const root = toHref("/creator-hub");
  const activeHref = items
    .map((item) => toHref(item.href))
    .filter(
      (href) =>
        pathname === href || (href !== root && pathname.startsWith(href + "/")),
    )
    .sort((a, b) => b.length - a.length)[0];

  return (
    <SidebarMenu>
      {items.map((item, i) => {
        const Icon = item.icon;
        const href = toHref(item.href);
        const isActive = href === activeHref;
        const alertCount = item.alertKey
          ? (alertCounts?.[item.alertKey] ?? 0)
          : 0;
        return (
          <SidebarMenuItem key={`${item.label}-${i}`}>
            <SidebarMenuButton
              isActive={isActive}
              tooltip={item.label}
              render={<Link href={href} />}
              onClick={() => {
                if (item.alertKey) onAlertSeen?.(item.alertKey);
                onNavTap();
              }}
              className="h-11 md:h-9 group-data-[collapsible=icon]:h-8!"
            >
              <Icon
                className={cn(
                  "size-4",
                  isActive ? "text-pink-500" : "text-muted-foreground",
                )}
              />
              <span>{item.label}</span>
              <LinkPending
                size={13}
                className={cn(
                  "shrink-0 group-data-[collapsible=icon]:hidden",
                  alertCount === 0 && "ml-auto",
                )}
              />
              <NavAlertBadge count={alertCount} />
            </SidebarMenuButton>
          </SidebarMenuItem>
        );
      })}
    </SidebarMenu>
  );
}

export function CreatorHubSidebar({
  viewerId,
  access = { creatorHub: true, packStudio: false, antifraud: false },
}: {
  viewerId: string;
  /** Server-computed workspace entitlement for the footer switcher. */
  access?: AppSwitcherAccess;
}) {
  const pathname = usePathname();
  const { isMobile, setOpenMobile } = useSidebar();
  // Host-aware hrefs: on marketing.packydash.com the `/creator-hub` prefix is
  // stripped from in-app links. Cross-app links are handled by the switcher's
  // HostLink (a bare /dashboard here would be rewritten into this segment).
  const appHost = useAppHost();
  const toHref = (path: string) => (appHost ? hrefFrom(appHost, path) : path);
  const rewardsHref = toHref("/creator-hub/rewards");
  const rewardsIsActive =
    pathname === rewardsHref || pathname.startsWith(`${rewardsHref}/`);
  const { counts: navAlertCounts, markSeen: markNavAlertSeen } =
    useNavAlertBadges({
      keys: ["creatorRewards"],
      viewerId,
      scope: "creatorHub",
      activeKey: rewardsIsActive ? "creatorRewards" : undefined,
    });

  // Close the mobile drawer on a navigation tap (same UX the main sidebar
  // applies — otherwise the new page renders behind the still-open sheet).
  function handleNavTap() {
    if (isMobile) setOpenMobile(false);
  }

  return (
    <Sidebar collapsible="icon">
      {/* Packy wordmark — same assets, sizing AND header height (h-16) as the
          main AppSidebar header, so the logo box lines up with the top bar. */}
      <SidebarHeader className="border-b border-border px-4 h-16 flex items-center justify-center group-data-[collapsible=icon]:px-0">
        <Link
          href={toHref("/creator-hub")}
          onClick={handleNavTap}
          title="Creator Hub"
          className="flex justify-center rounded-md outline-none hover:opacity-80 focus-visible:ring-2 focus-visible:ring-ring motion-safe:transition-[transform,opacity] motion-safe:duration-150 motion-safe:ease-out motion-safe:active:scale-95"
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/logo-light.png"
            alt="PackyGG"
            className="h-7 group-data-[collapsible=icon]:hidden dark:hidden"
          />
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/logo.png"
            alt="PackyGG"
            className="h-7 hidden dark:block group-data-[collapsible=icon]:hidden"
          />
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/icon.png"
            alt="PackyGG"
            className="h-8 w-8 hidden group-data-[collapsible=icon]:block"
          />
        </Link>
      </SidebarHeader>

      <SidebarContent>
        {HUB_NAV_GROUPS.map((group) => (
          <SidebarGroup key={group.label} className="px-2 py-1">
            <SidebarGroupLabel>{group.label}</SidebarGroupLabel>
            <SidebarGroupContent>
              <HubNavMenu
                items={group.items}
                pathname={pathname}
                onNavTap={handleNavTap}
                toHref={toHref}
                alertCounts={navAlertCounts}
                onAlertSeen={markNavAlertSeen}
              />
            </SidebarGroupContent>
          </SidebarGroup>
        ))}
      </SidebarContent>

      <SidebarFooter className="border-t border-border">
        {/* Same switcher the main sidebar carries — the way back to Admin (and
            across to the other workspaces) is one control in one place. */}
        <AppSwitcher
          current="creator-hub"
          access={access}
          onNavigate={handleNavTap}
        />
        <div className="flex items-center justify-between px-2 group-data-[collapsible=icon]:justify-center">
          <span className="text-xs text-muted-foreground group-data-[collapsible=icon]:hidden">
            Theme
          </span>
          <ThemeToggle />
        </div>
      </SidebarFooter>
    </Sidebar>
  );
}
