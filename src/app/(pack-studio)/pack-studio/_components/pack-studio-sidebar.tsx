"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  ClipboardEdit,
  Layers3,
  LayoutDashboard,
  Package,
  PackageOpen,
  Stethoscope,
  Wand2,
  Sparkles,
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
import { useAppHost } from "@/lib/use-app-host";
import { hrefFrom } from "@/lib/app-hosts";
import { ThemeToggle } from "@/components/theme-toggle";
import { LinkPending } from "@/components/ux";
import { AppSwitcher, type AppSwitcherAccess } from "@/components/app-switcher";

/**
 * Pack Studio sidebar — the swapped nav rendered by the Pack Studio layout
 * INSTEAD of the main `AppSidebar`. Reuses the same shadcn `Sidebar`
 * primitive geometry (so the SidebarProvider/SidebarInset collapse + width
 * math is shared), but gives the sub-app its own identity: the Packy
 * wordmark (same assets as the main sidebar), a "Back to Admin" exit at the
 * top, and its own nav list.
 *
 * Client-safe: no DB / server-only imports. Icons are direct `lucide-react`
 * component refs (not the string-keyed ICONS map the main sidebar uses), so
 * there's no React #130 icon-registry coupling here.
 */

type StudioNavItem = {
  label: string;
  href: string;
  icon: LucideIcon;
};

const STUDIO_OVERVIEW_NAV: StudioNavItem[] = [
  { label: "Overview", href: "/pack-studio", icon: LayoutDashboard },
];

const STUDIO_BUILD_NAV: StudioNavItem[] = [
  { label: "Packs", href: "/pack-studio/packs", icon: Package },
  { label: "Cards", href: "/pack-studio/cards", icon: Layers3 },
  { label: "Pack Builder", href: "/pack-studio/builder", icon: Wand2 },
  {
    label: "Build Drafts",
    href: "/pack-studio/builder-drafts",
    icon: ClipboardEdit,
  },
];

const STUDIO_TUNE_NAV: StudioNavItem[] = [
  { label: "Pack Doctor", href: "/pack-studio/doctor", icon: Stethoscope },
  { label: "Retune", href: "/pack-studio/retune", icon: Sparkles },
];

const STUDIO_SYSTEM_NAV: StudioNavItem[] = [
  { label: "New Packs", href: "/pack-studio/new-packs", icon: PackageOpen },
];

/**
 * Retune-operator-only nav entries — appended for owners and the hard-coded
 * Pack-Studio retune operator allowlist (`isPackStudioRetuneOperator`). The
 * Drafts page itself is gated server-side; this just hides the link for
 * non-operators so a click never bounces.
 */
const STUDIO_OPERATOR_NAV: StudioNavItem[] = [
  { label: "Drafts", href: "/pack-studio/drafts", icon: ClipboardEdit },
];

/**
 * Owner-only nav entries — appended after the shared workspace nav when the
 * layout reports the viewer is an owner. The Pack Change History + revert page
 * is owner-gated server-side (`requirePackStudioPageAccess` + owner check), so
 * the nav link is hidden for non-owners to avoid a click that just bounces.
 */
const STUDIO_OWNER_NAV: StudioNavItem[] = [
  { label: "History", href: "/pack-studio/history", icon: History },
];

function StudioNavMenu({
  items,
  pathname,
  onNavTap,
  toHref,
}: {
  items: StudioNavItem[];
  pathname: string;
  onNavTap: () => void;
  /**
   * Canonical path → the href for the current host. On packs.packydash.com the
   * `/pack-studio` prefix is stripped, which BOTH keeps the URL clean and keeps
   * the active check honest: after the middleware rewrite the browser URL is
   * the short form, so comparing it against the long form would mark every item
   * inactive.
   */
  toHref: (path: string) => string;
}) {
  return (
    <SidebarMenu>
      {items.map((item, i) => {
        const Icon = item.icon;
        const href = toHref(item.href);
        const root = toHref("/pack-studio");
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
                  isActive ? "text-violet-500" : "text-muted-foreground",
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

export function PackStudioSidebar({
  isOwner = false,
  isRetuneOperator = false,
  access = { creatorHub: false, packStudio: true, antifraud: false },
}: {
  isOwner?: boolean;
  /** Server-computed workspace entitlement for the footer switcher. */
  access?: AppSwitcherAccess;
  /**
   * True iff the viewer can use the staging draft tools — owners + the
   * hard-coded retune operator allowlist (`isPackStudioRetuneOperator`).
   * Reveals the "Drafts" nav entry; the page is gated server-side too.
   */
  isRetuneOperator?: boolean;
}) {
  const pathname = usePathname();
  const { isMobile, setOpenMobile } = useSidebar();
  // Host-aware links: strip the `/pack-studio` prefix while on the Studio's own
  // host. Cross-app links go through the switcher's HostLink — a bare
  // /dashboard here would be rewritten into this host's segment.
  const appHost = useAppHost();
  const toHref = (path: string) => (appHost ? hrefFrom(appHost, path) : path);

  const operationsNav = [
    ...(isRetuneOperator ? STUDIO_OPERATOR_NAV : []),
    ...(isOwner ? STUDIO_OWNER_NAV : []),
  ];

  // Close the mobile drawer on a navigation tap (same UX the main sidebar
  // applies — otherwise the new page renders behind the still-open sheet).
  function handleNavTap() {
    if (isMobile) setOpenMobile(false);
  }

  return (
    <Sidebar collapsible="icon">
      {/* Packy wordmark — same assets + sizing as the main AppSidebar header.
          Pack Studio title/subtitle sit below the logo when expanded. */}
      <SidebarHeader className="border-b border-border px-4 py-4 flex items-center justify-center group-data-[collapsible=icon]:px-0 group-data-[collapsible=icon]:h-16 group-data-[collapsible=icon]:py-0">
        <Link
          href={toHref("/pack-studio")}
          onClick={handleNavTap}
          title="Pack Studio"
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
              Pack Studio
            </span>
          </span>
        </Link>
      </SidebarHeader>

      <SidebarContent>
        <SidebarGroup className="px-2 py-1">
          <SidebarGroupLabel>Overview</SidebarGroupLabel>
          <SidebarGroupContent>
            <StudioNavMenu
              items={STUDIO_OVERVIEW_NAV}
              pathname={pathname}
              onNavTap={handleNavTap}
              toHref={toHref}
            />
          </SidebarGroupContent>
        </SidebarGroup>
        <SidebarGroup className="px-2 py-1">
          <SidebarGroupLabel>Build</SidebarGroupLabel>
          <SidebarGroupContent>
            <StudioNavMenu
              items={STUDIO_BUILD_NAV}
              pathname={pathname}
              onNavTap={handleNavTap}
              toHref={toHref}
            />
          </SidebarGroupContent>
        </SidebarGroup>
        <SidebarGroup className="px-2 py-1">
          <SidebarGroupLabel>Tune</SidebarGroupLabel>
          <SidebarGroupContent>
            <StudioNavMenu
              items={STUDIO_TUNE_NAV}
              pathname={pathname}
              onNavTap={handleNavTap}
              toHref={toHref}
            />
          </SidebarGroupContent>
        </SidebarGroup>
        {operationsNav.length > 0 && (
          <SidebarGroup className="px-2 py-1">
            <SidebarGroupLabel>Operations</SidebarGroupLabel>
            <SidebarGroupContent>
              <StudioNavMenu
                items={operationsNav}
                pathname={pathname}
                onNavTap={handleNavTap}
                toHref={toHref}
              />
            </SidebarGroupContent>
          </SidebarGroup>
        )}
        {isOwner && (
          <SidebarGroup className="px-2 py-1">
            <SidebarGroupLabel>System</SidebarGroupLabel>
            <SidebarGroupContent>
              <StudioNavMenu
                items={STUDIO_SYSTEM_NAV}
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
          current="pack-studio"
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
