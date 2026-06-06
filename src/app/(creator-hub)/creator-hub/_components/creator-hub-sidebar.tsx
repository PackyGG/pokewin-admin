"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  ArrowLeft,
  Bell,
  CalendarRange,
  GitCompareArrows,
  LayoutDashboard,
  Users,
  Trophy,
  LineChart,
  Megaphone,
  ShieldCheck,
  Calculator,
  History,
  Settings,
  UserSearch,
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
 * identity: a pink "Creator Hub" wordmark, a "Back to Admin" exit at the
 * top, and its own nav list.
 *
 * Live nav: Dashboard, Creators, Leaderboards, Creator Check, Acquisition,
 * Codes & Ads, Socials Review, ROI Calculator, Changelog, Settings; plus an
 * Ops group (Alerts, Deal Tracker, Compare).
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
  { label: "Leaderboards", href: "/creator-hub/leaderboards", icon: Trophy },
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
    label: "Codes & Ads",
    href: "/creator-hub/codes-ads",
    icon: Megaphone,
  },
  {
    label: "Socials Review",
    href: "/creator-hub/socials-review",
    icon: ShieldCheck,
  },
  {
    label: "ROI Calculator",
    href: "/creator-hub/profitable-algo",
    icon: Calculator,
  },
  { label: "Changelog", href: "/creator-hub/changelog", icon: History },
  { label: "Settings", href: "/creator-hub/settings", icon: Settings },
];

const HUB_OPS_NAV: HubNavItem[] = [
  { label: "Alerts", href: "/creator-hub/alerts", icon: Bell },
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
      {/* Identity header — Creator Hub wordmark (pink mark + label). Reuses
          the main sidebar's 14-unit header height so the inset geometry
          lines up. Collapses to just the mark in icon mode. */}
      <SidebarHeader className="border-b border-border px-3 h-14 flex items-center justify-center group-data-[collapsible=icon]:px-0">
        <Link
          href="/creator-hub"
          onClick={handleNavTap}
          className="flex items-center gap-2.5 rounded-md outline-none hover:opacity-90 focus-visible:ring-2 focus-visible:ring-pink-500/40 group-data-[collapsible=icon]:gap-0"
        >
          <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-gradient-to-br from-pink-500 to-pink-600 text-sm font-extrabold text-white shadow-sm shadow-pink-500/30">
            C
          </span>
          <span className="min-w-0 leading-tight group-data-[collapsible=icon]:hidden">
            <span className="block truncate text-sm font-bold tracking-tight">
              Creator Hub
            </span>
            <span className="block truncate text-[11px] text-muted-foreground">
              CM workspace
            </span>
          </span>
        </Link>
      </SidebarHeader>

      <SidebarContent>
        {/* Back to Admin — the symmetric exit from the sub-app back to the
            main admin shell. Distinct from the nav list (muted, leading
            arrow). */}
        <div className="px-2 pt-2 group-data-[collapsible=icon]:px-0">
          <Link
            href="/dashboard"
            onClick={handleNavTap}
            title="Back to Admin"
            className={cn(
              "group/back flex items-center gap-2.5 rounded-lg border border-border bg-card/40 px-3 py-2 text-xs font-semibold text-muted-foreground outline-none",
              "transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring",
              "group-data-[collapsible=icon]:mx-auto group-data-[collapsible=icon]:size-8 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:gap-0 group-data-[collapsible=icon]:px-0 group-data-[collapsible=icon]:py-0",
            )}
          >
            <ArrowLeft className="size-4 shrink-0 transition-transform motion-safe:group-hover/back:-translate-x-0.5" />
            <span className="group-data-[collapsible=icon]:hidden">
              Back to Admin
            </span>
          </Link>
        </div>

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
