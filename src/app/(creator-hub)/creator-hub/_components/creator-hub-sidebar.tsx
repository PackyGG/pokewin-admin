"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  ArrowLeft,
  LayoutDashboard,
  Users,
  Trophy,
  LineChart,
  Megaphone,
  ShieldCheck,
  Calculator,
  History,
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
 * Live nav: Dashboard, Creators, Leaderboards, ROI Calculator (Profitable
 * Algo) and Changelog all link to real routes. The remaining sections are
 * placeholders (the future Acquisition / Codes & Ads / Socials Review
 * sub-apps), rendered disabled so the eventual structure is visible without
 * dead links. They carry no functional href and never navigate.
 *
 * Client-safe: no DB / server-only imports. Icons are direct
 * `lucide-react` component refs (not the string-keyed ICONS map the main
 * sidebar uses), so there's no React #130 icon-registry coupling here.
 */

type HubNavItem = {
  label: string;
  href: string;
  icon: LucideIcon;
  /** Placeholder (future section) — rendered disabled, never navigates. */
  soon?: boolean;
};

const HUB_NAV: HubNavItem[] = [
  { label: "Dashboard", href: "/creator-hub", icon: LayoutDashboard },
  { label: "Creators", href: "/creator-hub/creators", icon: Users },
  { label: "Leaderboards", href: "/creator-hub/leaderboards", icon: Trophy },
  { label: "Acquisition", href: "/creator-hub", icon: LineChart, soon: true },
  { label: "Codes & Ads", href: "/creator-hub", icon: Megaphone, soon: true },
  {
    label: "Socials Review",
    href: "/creator-hub",
    icon: ShieldCheck,
    soon: true,
  },
  {
    label: "ROI Calculator",
    href: "/creator-hub/profitable-algo",
    icon: Calculator,
  },
  { label: "Changelog", href: "/creator-hub/changelog", icon: History },
];

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
            <SidebarMenu>
              {HUB_NAV.map((item, i) => {
                const Icon = item.icon;
                // Active when the route matches. Dashboard ("/creator-hub")
                // is exact-only so it doesn't light up on every sub-page;
                // the deeper items also match their nested routes (e.g.
                // "/creator-hub/creators/[id]" keeps "Creators" active).
                // Placeholder items never navigate, so never active.
                const isActive =
                  !item.soon &&
                  (pathname === item.href ||
                    (item.href !== "/creator-hub" &&
                      pathname.startsWith(item.href + "/")));
                if (item.soon) {
                  return (
                    <SidebarMenuItem key={`${item.label}-${i}`}>
                      <SidebarMenuButton
                        // Disabled placeholder — non-interactive, dimmed,
                        // with a "Soon" badge. Rendered as a plain button
                        // (no Link) so it can't navigate.
                        disabled
                        tooltip={`${item.label} — coming soon`}
                        className="h-11 cursor-default opacity-55 md:h-9 group-data-[collapsible=icon]:h-8!"
                      >
                        <Icon className="size-4 text-muted-foreground" />
                        <span>{item.label}</span>
                        <span className="ml-auto rounded-sm bg-muted px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-wider text-muted-foreground group-data-[collapsible=icon]:hidden">
                          Soon
                        </span>
                      </SidebarMenuButton>
                    </SidebarMenuItem>
                  );
                }
                return (
                  <SidebarMenuItem key={`${item.label}-${i}`}>
                    <SidebarMenuButton
                      isActive={isActive}
                      tooltip={item.label}
                      render={<Link href={item.href} />}
                      onClick={handleNavTap}
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
