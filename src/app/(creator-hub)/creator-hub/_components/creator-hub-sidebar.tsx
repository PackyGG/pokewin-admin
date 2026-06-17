"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  ArrowLeft,
  CalendarRange,
  GitCompareArrows,
  Gift,
  LayoutDashboard,
  Users,
  Trophy,
  LineChart,
  ShieldCheck,
  ShieldAlert,
  Calculator,
  History,
  Settings,
  Tv,
  UserSearch,
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

/**
 * Creator Hub sidebar — the swapped nav rendered by the Creator Hub
 * layout INSTEAD of the main `AppSidebar`. Reuses the same shadcn
 * `Sidebar` primitive geometry (so the SidebarProvider/SidebarInset
 * collapse + width math is shared), but gives the sub-app its own
 * identity: the Packy wordmark (same assets as the main sidebar), a
 * "Back to Admin" exit at the top, and its own nav list.
 *
 * Live nav: Dashboard, Creators, Leaderboards, Tips & Sponsors, Creator Check, Acquisition,
 * Socials Review, ROI Calculator, Changelog; plus an Ops group (Deal Tracker,
 * Compare). Settings is pinned in the footer above the theme toggle. Alerts
 * live on the right rail dock.
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

const HUB_NAV: HubNavItem[] = [
  { label: "Dashboard", href: "/creator-hub", icon: LayoutDashboard },
  { label: "Creators", href: "/creator-hub/creators", icon: Users },
  { label: "All Sessions", href: "/creator-hub/sessions", icon: Tv },
  { label: "Leaderboards", href: "/creator-hub/leaderboards", icon: Trophy },
  {
    label: "Tips & Sponsors",
    href: "/creator-hub/tips-sponsors",
    icon: Gift,
  },
  {
    label: "Creator Check",
    href: "/creator-hub/creator-check",
    icon: UserSearch,
  },
  {
    label: "Acquisition",
    href: "/creator-hub/acquisition",
    icon: LineChart,
  },
  {
    label: "Socials Review",
    href: "/creator-hub/socials-review",
    icon: ShieldCheck,
  },
  {
    label: "Wager / Fraud Abusers",
    href: "/creator-hub/wager-abusers",
    icon: ShieldAlert,
  },
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
  { label: "Changelog", href: "/creator-hub/changelog", icon: History },
];

const HUB_FOOTER_NAV: HubNavItem[] = [
  { label: "Settings", href: "/creator-hub/settings", icon: Settings },
];

const HUB_OPS_NAV: HubNavItem[] = [
  {
    label: "Deal Tracker",
    href: "/creator-hub/deal-tracker",
    icon: CalendarRange,
  },
  { label: "Compare", href: "/creator-hub/compare", icon: GitCompareArrows },
];

function HubNavMenu({
  items,
  pathname,
  onNavTap,
}: {
  items: HubNavItem[];
  pathname: string;
  onNavTap: () => void;
}) {
  return (
    <SidebarMenu>
      {items.map((item, i) => {
        const Icon = item.icon;
        const isActive =
          pathname === item.href ||
          (item.href !== "/creator-hub" &&
            pathname.startsWith(item.href + "/"));
        return (
          <SidebarMenuItem key={`${item.label}-${i}`}>
            <SidebarMenuButton
              isActive={isActive}
              tooltip={item.label}
              render={<Link href={item.href} />}
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

export function CreatorHubSidebar() {
  const pathname = usePathname();
  const { isMobile, setOpenMobile } = useSidebar();

  // Close the mobile drawer on a navigation tap (same UX the main sidebar
  // applies — otherwise the new page renders behind the still-open sheet).
  function handleNavTap() {
    if (isMobile) setOpenMobile(false);
  }

  return (
    <Sidebar collapsible="icon">
      {/* Packy wordmark — same assets + sizing as the main AppSidebar header.
          Creator Hub title/subtitle sit below the logo when expanded. */}
      <SidebarHeader className="border-b border-border px-4 py-3 flex items-center justify-center group-data-[collapsible=icon]:px-0 group-data-[collapsible=icon]:h-14 group-data-[collapsible=icon]:py-0">
        <Link
          href="/creator-hub"
          onClick={handleNavTap}
          title="Creator Hub"
          className="flex flex-col items-center rounded-md outline-none hover:opacity-80 focus-visible:ring-2 focus-visible:ring-ring motion-safe:transition-[transform,opacity] motion-safe:duration-150 motion-safe:ease-out motion-safe:active:scale-95"
        >
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/logo-light.png"
            alt="PackyGG"
            className="h-6 group-data-[collapsible=icon]:hidden dark:hidden"
          />
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/logo.png"
            alt="PackyGG"
            className="h-6 hidden dark:block group-data-[collapsible=icon]:hidden"
          />
          {/* eslint-disable-next-line @next/next/no-img-element */}
          <img
            src="/icon.png"
            alt="PackyGG"
            className="h-7 w-7 hidden group-data-[collapsible=icon]:block"
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

      {/* Back to Admin — symmetric portal to the main sidebar's
          "Switch to Creator Hub" affordance: same pink gradient card,
          two-line label, mirrored arrow + icon placement. */}
      <div className="px-2 pt-2 group-data-[collapsible=icon]:px-0">
        <Link
          href="/dashboard"
          onClick={handleNavTap}
          title="Back to Admin"
          className={cn(
            "group/back relative flex items-center gap-2.5 overflow-hidden rounded-xl border border-pink-500/30 bg-gradient-to-r from-pink-500/15 via-pink-500/10 to-transparent px-3 py-2.5 outline-none",
            "transition-colors hover:border-pink-500/50 hover:from-pink-500/25 hover:via-pink-500/15 focus-visible:ring-2 focus-visible:ring-pink-500/40",
            "group-data-[collapsible=icon]:mx-auto group-data-[collapsible=icon]:size-8 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:gap-0 group-data-[collapsible=icon]:rounded-lg group-data-[collapsible=icon]:px-0 group-data-[collapsible=icon]:py-0",
          )}
        >
          <ArrowLeft className="size-4 shrink-0 text-pink-500 transition-transform group-data-[collapsible=icon]:hidden motion-safe:group-hover/back:-translate-x-0.5" />
          <span className="min-w-0 flex-1 group-data-[collapsible=icon]:hidden">
            <span className="block truncate text-xs font-semibold text-pink-600 dark:text-pink-300">
              Back to Admin
            </span>
            <span className="block truncate text-[11px] text-muted-foreground">
              Main dashboard
            </span>
          </span>
          <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-pink-500/20 text-pink-600 ring-1 ring-inset ring-pink-500/30 dark:text-pink-400 group-data-[collapsible=icon]:size-8 group-data-[collapsible=icon]:rounded-lg">
            <LayoutDashboard className="size-4" />
          </span>
        </Link>
      </div>

      <SidebarContent>
        <SidebarGroup className="px-2 py-1">
          <SidebarGroupLabel>Workspace</SidebarGroupLabel>
          <SidebarGroupContent>
            <HubNavMenu
              items={HUB_NAV}
              pathname={pathname}
              onNavTap={handleNavTap}
            />
          </SidebarGroupContent>
        </SidebarGroup>

        <SidebarGroup className="px-2 py-1">
          <SidebarGroupLabel>Ops</SidebarGroupLabel>
          <SidebarGroupContent>
            <HubNavMenu
              items={HUB_OPS_NAV}
              pathname={pathname}
              onNavTap={handleNavTap}
            />
          </SidebarGroupContent>
        </SidebarGroup>
      </SidebarContent>

      <SidebarFooter className="border-t border-border">
        <HubNavMenu
          items={HUB_FOOTER_NAV}
          pathname={pathname}
          onNavTap={handleNavTap}
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
