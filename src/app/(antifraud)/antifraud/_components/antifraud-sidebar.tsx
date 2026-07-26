"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  Braces,
  Fingerprint,
  Gauge,
  LayoutDashboard,
  RadioTower,
  Settings,
  ShieldAlert,
  UserRoundSearch,
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
 * Antifraud sidebar — the swapped nav rendered by the Antifraud layout INSTEAD
 * of the main `AppSidebar`. Same shadcn `Sidebar` primitive geometry as the
 * Creator-Hub and Pack-Studio sidebars (so the SidebarProvider/SidebarInset
 * collapse + width math is shared), with the sub-app's own cyan identity.
 *
 * Client-safe: no DB / server-only imports. Icons are direct `lucide-react`
 * component refs (not the string-keyed ICONS map the main sidebar uses), so
 * there's no React #130 icon-registry coupling here.
 */

type NavItem = {
  label: string;
  href: string;
  icon: LucideIcon;
};

const WORKSPACE_NAV: NavItem[] = [
  { label: "Overview", href: "/antifraud", icon: LayoutDashboard },
  { label: "Signups", href: "/antifraud/signups", icon: UserRoundSearch },
  { label: "Live Monitor", href: "/antifraud/monitor", icon: RadioTower },
  { label: "Account Review", href: "/antifraud/reviews", icon: ShieldAlert },
  { label: "KYC", href: "/antifraud/kyc", icon: Fingerprint },
];

/**
 * Owner/admin-only antifraud settings.
 */
const MANAGE_NAV: NavItem[] = [
  { label: "Risk Scoring", href: "/antifraud/points", icon: Gauge },
  { label: "API", href: "/antifraud/api", icon: Braces },
  { label: "Settings", href: "/antifraud/settings", icon: Settings },
];

function NavMenu({
  items,
  pathname,
  onNavTap,
  toHref,
}: {
  items: NavItem[];
  pathname: string;
  onNavTap: () => void;
  /**
   * Canonical path → the href for the current host. On fraud.packydash.com the
   * `/antifraud` prefix is stripped, which BOTH keeps the URL clean and keeps
   * the active check below honest: after the middleware rewrite the browser URL
   * is the short form, so comparing it against the long form would mark every
   * item inactive.
   */
  toHref: (path: string) => string;
}) {
  const root = toHref("/antifraud");
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
                  isActive ? "text-cyan-500" : "text-muted-foreground",
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

export function AntifraudSidebar({
  canManage = false,
  access = { creatorHub: false, packStudio: false, antifraud: true },
}: {
  /** Owner / admin — reveals the authoring + settings group. */
  canManage?: boolean;
  /** Server-computed workspace entitlement for the footer switcher. */
  access?: AppSwitcherAccess;
}) {
  const pathname = usePathname();
  const { isMobile, setOpenMobile } = useSidebar();
  // Host-aware hrefs: on fraud.packydash.com the `/antifraud` prefix is
  // stripped from in-app links. Cross-app links are handled by the switcher's
  // HostLink (a bare /dashboard here would be rewritten into this segment).
  const appHost = useAppHost();
  const toHref = (path: string) => (appHost ? hrefFrom(appHost, path) : path);

  // Close the mobile drawer on a navigation tap (same UX the other sidebars
  // apply — otherwise the new page renders behind the still-open sheet).
  function handleNavTap() {
    if (isMobile) setOpenMobile(false);
  }

  return (
    <Sidebar collapsible="icon">
      {/* Packy wordmark — same assets + sizing as the main AppSidebar header. */}
      <SidebarHeader className="border-b border-border px-4 py-3 flex items-center justify-center group-data-[collapsible=icon]:px-0 group-data-[collapsible=icon]:h-14 group-data-[collapsible=icon]:py-0">
        <Link
          href={toHref("/antifraud")}
          onClick={handleNavTap}
          title="Antifraud"
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
              Antifraud
            </span>
            <span className="block truncate text-[11px] text-muted-foreground">
              Risk workspace
            </span>
          </span>
        </Link>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup className="px-2 py-1">
          <SidebarGroupLabel>Fraud Operations</SidebarGroupLabel>
          <SidebarGroupContent>
            <NavMenu
              items={WORKSPACE_NAV}
              pathname={pathname}
              onNavTap={handleNavTap}
              toHref={toHref}
            />
          </SidebarGroupContent>
        </SidebarGroup>

        {canManage && (
          <SidebarGroup className="px-2 py-1">
            <SidebarGroupLabel>Manage</SidebarGroupLabel>
            <SidebarGroupContent>
              <NavMenu
                items={MANAGE_NAV}
                pathname={pathname}
                onNavTap={handleNavTap}
                toHref={toHref}
              />
            </SidebarGroupContent>
          </SidebarGroup>
        )}
      </SidebarContent>

      <SidebarFooter className="border-t border-border">
        {/* Same switcher the main sidebar carries — the way back to Admin (and
            across to the other workspaces) is one control in one place. */}
        <AppSwitcher
          current="antifraud"
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
