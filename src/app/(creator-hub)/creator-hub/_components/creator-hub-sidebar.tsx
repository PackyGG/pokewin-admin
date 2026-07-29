"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Crown,
  Gift,
  LayoutDashboard,
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

/**
 * Creator Hub sidebar — the swapped nav rendered by the Creator Hub
 * layout INSTEAD of the main `AppSidebar`. Reuses the same shadcn
 * `Sidebar` primitive geometry (so the SidebarProvider/SidebarInset
 * collapse + width math is shared), but gives the sub-app its own
 * identity: the Packy wordmark (same assets as the main sidebar), a
 * "Back to Admin" exit at the top, and its own nav list.
 *
 * Live nav, sectioned (owner request 2026-07-29): Overview (Dashboard),
 * Creators (Roster, Creator Fraud, Socials Review), Programs & Payouts
 * (Leaderboards, Tips & Sponsors, Creator Rewards), Economics
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
      {
        label: "Creator Rewards",
        href: "/creator-hub/rewards",
        icon: Crown,
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
        return (
          <SidebarMenuItem key={`${item.label}-${i}`}>
            <SidebarMenuButton
              isActive={isActive}
              tooltip={item.label}
              render={<Link href={href} />}
              onClick={onNavTap}
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
                className="ml-auto shrink-0 group-data-[collapsible=icon]:hidden"
              />
            </SidebarMenuButton>
          </SidebarMenuItem>
        );
      })}
    </SidebarMenu>
  );
}

export function CreatorHubSidebar({
  access = { creatorHub: true, packStudio: false, antifraud: false },
}: {
  /** Server-computed workspace entitlement for the footer switcher. */
  access?: AppSwitcherAccess;
} = {}) {
  const pathname = usePathname();
  const { isMobile, setOpenMobile } = useSidebar();
  // Host-aware hrefs: on marketing.packydash.com the `/creator-hub` prefix is
  // stripped from in-app links. Cross-app links are handled by the switcher's
  // HostLink (a bare /dashboard here would be rewritten into this segment).
  const appHost = useAppHost();
  const toHref = (path: string) => (appHost ? hrefFrom(appHost, path) : path);

  // Close the mobile drawer on a navigation tap (same UX the main sidebar
  // applies — otherwise the new page renders behind the still-open sheet).
  function handleNavTap() {
    if (isMobile) setOpenMobile(false);
  }

  return (
    <Sidebar collapsible="icon">
      {/* Packy wordmark — same assets + sizing as the main AppSidebar header.
          Creator Hub title/subtitle sit below the logo when expanded. */}
      <SidebarHeader className="border-b border-border px-4 py-4 flex items-center justify-center group-data-[collapsible=icon]:px-0 group-data-[collapsible=icon]:h-16 group-data-[collapsible=icon]:py-0">
        <Link
          href={toHref("/creator-hub")}
          onClick={handleNavTap}
          title="Creator Hub"
          className="flex flex-col items-center rounded-md outline-none hover:opacity-80 focus-visible:ring-2 focus-visible:ring-ring motion-safe:transition-[transform,opacity] motion-safe:duration-150 motion-safe:ease-out motion-safe:active:scale-95"
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
          <span className="mt-1 min-w-0 text-center group-data-[collapsible=icon]:hidden">
            <span className="block truncate text-xs font-semibold text-foreground">
              Creator Hub
            </span>
            <span className="block truncate text-[11px] text-muted-foreground">
              CM team workspace
            </span>
          </span>
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
