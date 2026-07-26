"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  ArrowLeft,
  BadgeCheck,
  Braces,
  GraduationCap,
  LayoutDashboard,
  RadioTower,
  Settings,
  ShieldAlert,
  Trophy,
  Users,
  UserCircle,
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
import { useAppHost, useCrossAppHrefs } from "@/lib/use-app-host";
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
  { label: "Live Monitor", href: "/antifraud/monitor", icon: RadioTower },
  { label: "Account Review", href: "/antifraud/reviews", icon: ShieldAlert },
];

const TEAM_NAV: NavItem[] = [
  { label: "My Profile", href: "/antifraud/profile", icon: UserCircle },
];

const STAFF_NAV: NavItem[] = [
  { label: "Quizzes", href: "/antifraud/quizzes", icon: GraduationCap },
];

/**
 * Owner/admin-only entries. The settings pages are gated server-side
 * (`requireAntifraudManagerPage`); hiding the link just avoids a click that
 * would bounce.
 */
const MANAGE_NAV: NavItem[] = [
  { label: "Staff Members", href: "/antifraud/staff", icon: Users },
  { label: "Points", href: "/antifraud/settings/points", icon: Trophy },
  { label: "API", href: "/antifraud/settings/api", icon: Braces },
  { label: "Quiz Manager", href: "/antifraud/settings/quizzes", icon: BadgeCheck },
  { label: "Workspace Settings", href: "/antifraud/settings", icon: Settings },
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
  return (
    <SidebarMenu>
      {items.map((item, i) => {
        const Icon = item.icon;
        const href = toHref(item.href);
        const root = toHref("/antifraud");
        const isActive =
          pathname === href || (href !== root && pathname.startsWith(href + "/"));
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
}: {
  /** Owner / admin — reveals the authoring + settings group. */
  canManage?: boolean;
}) {
  const pathname = usePathname();
  const { isMobile, setOpenMobile } = useSidebar();
  // Host-aware hrefs: on fraud.packydash.com the `/antifraud` prefix is
  // stripped from in-app links, and "Back to Admin" becomes an absolute URL to
  // the apex (a bare /dashboard would be rewritten into this host's segment).
  const appHost = useAppHost();
  const { admin: adminHref } = useCrossAppHrefs();
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
              Risk &amp; staff workspace
            </span>
          </span>
        </Link>
      </SidebarHeader>

      {/* Back to Admin — symmetric portal to the main sidebar's "Switch to
          Antifraud" affordance: same cyan gradient card, two-line label,
          mirrored arrow + icon placement. */}
      <div className="px-2 pt-2 group-data-[collapsible=icon]:px-0">
        <Link
          href={adminHref}
          onClick={handleNavTap}
          title="Back to Admin"
          className={cn(
            "group/back relative flex items-center gap-2.5 overflow-hidden rounded-xl border border-cyan-500/30 bg-gradient-to-r from-cyan-500/15 via-cyan-500/10 to-transparent px-3 py-2.5 outline-none",
            "transition-colors hover:border-cyan-500/50 hover:from-cyan-500/25 hover:via-cyan-500/15 focus-visible:ring-2 focus-visible:ring-cyan-500/40",
            "group-data-[collapsible=icon]:mx-auto group-data-[collapsible=icon]:size-8 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:gap-0 group-data-[collapsible=icon]:rounded-lg group-data-[collapsible=icon]:px-0 group-data-[collapsible=icon]:py-0",
          )}
        >
          <ArrowLeft className="size-4 shrink-0 text-cyan-500 transition-transform group-data-[collapsible=icon]:hidden motion-safe:group-hover/back:-translate-x-0.5" />
          <span className="min-w-0 flex-1 group-data-[collapsible=icon]:hidden">
            <span className="block truncate text-xs font-semibold text-cyan-600 dark:text-cyan-300">
              Back to Admin
            </span>
            <span className="block truncate text-[11px] text-muted-foreground">
              Main dashboard
            </span>
          </span>
          <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-cyan-500/20 text-cyan-600 ring-1 ring-inset ring-cyan-500/30 dark:text-cyan-400 group-data-[collapsible=icon]:size-8 group-data-[collapsible=icon]:rounded-lg">
            <LayoutDashboard className="size-4" />
          </span>
        </Link>
      </div>

      <SidebarContent>
        <SidebarGroup className="px-2 py-1">
          <SidebarGroupLabel>Workspace</SidebarGroupLabel>
          <SidebarGroupContent>
            <NavMenu
              items={WORKSPACE_NAV}
              pathname={pathname}
              onNavTap={handleNavTap}
              toHref={toHref}
            />
          </SidebarGroupContent>
        </SidebarGroup>

        <SidebarGroup className="px-2 py-1">
          <SidebarGroupLabel>Team</SidebarGroupLabel>
          <SidebarGroupContent>
            <NavMenu
              items={canManage ? TEAM_NAV : [...STAFF_NAV, ...TEAM_NAV]}
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
