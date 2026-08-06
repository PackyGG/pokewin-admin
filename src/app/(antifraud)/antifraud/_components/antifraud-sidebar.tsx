"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  BookOpen,
  Banknote,
  ChevronRight,
  Fingerprint,
  LayoutDashboard,
  MailWarning,
  MapPinned,
  Network,
  RadioTower,
  RotateCcw,
  ScrollText,
  Settings2,
  ShieldAlert,
  SlidersHorizontal,
  Webhook,
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
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from "@/components/ui/collapsible";
import { cn } from "@/lib/utils";
import { ThemeToggle } from "@/components/theme-toggle";
import { LinkPending } from "@/components/ux";
import { AppSwitcher, type AppSwitcherAccess } from "@/components/app-switcher";
import { useAppHost } from "@/lib/use-app-host";
import { hrefFrom } from "@/lib/app-hosts";
import {
  NavAlertBadge,
  useNavAlertBadges,
  type NavAlertKey,
} from "@/components/nav-alert-badge";

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
  disabledReason?: string;
};

function persistSectionState(storageKey: string, open: boolean) {
  try {
    window.localStorage.setItem(storageKey, open ? "open" : "closed");
  } catch {
    // Storage can be unavailable in hardened/private browser contexts.
  }
}

const OVERVIEW_NAV: NavItem[] = [
  { label: "Dashboard", href: "/antifraud", icon: LayoutDashboard },
  { label: "Live events", href: "/antifraud/monitor", icon: RadioTower },
  { label: "Account reviews", href: "/antifraud/reviews", icon: ShieldAlert },
];
const ANTIFRAUD_NAV_ALERT_KEYS = ["fiat", "reviews"] as const;

const MAIN_NAV: NavItem[] = [
  {
    label: "Deposit reviews",
    href: "/antifraud/fiat-deposits",
    icon: Banknote,
  },
  { label: "KYC reviews", href: "/antifraud/kyc", icon: Fingerprint },
];

const BLACKLIST_NAV: NavItem[] = [
  {
    label: "Domains",
    href: "/antifraud/email-blacklist",
    icon: MailWarning,
  },
  {
    label: "IPs",
    href: "/antifraud/ip-blacklist",
    icon: Network,
  },
  {
    label: "Fingerprints",
    href: "/antifraud/fingerprint-blacklist",
    icon: Fingerprint,
  },
  {
    label: "Banned users",
    href: "/antifraud/banned-users",
    icon: ShieldAlert,
  },
  {
    label: "Risk locations",
    href: "/antifraud/risky-locations",
    icon: MapPinned,
  },
];

/**
 * Operator guide. The first two entries keep their original slots (signup, then
 * fiat) so the reading order staff already learned is unchanged; the pre-payment
 * page grew into the full end-to-end fiat guide, and `/guide/fiat-pre-payment`
 * redirects to it rather than 404ing on old bookmarks.
 */
const GUIDE_NAV: NavItem[] = [
  {
    label: "Signup Risk",
    href: "/antifraud/guide/sign-up",
    icon: BookOpen,
  },
  {
    label: "Fiat Deposits",
    href: "/antifraud/guide/fiat-deposits",
    icon: BookOpen,
  },
  {
    label: "Account Review",
    href: "/antifraud/guide/account-review",
    icon: BookOpen,
  },
  {
    label: "Money Out & Refunds",
    href: "/antifraud/guide/refunds",
    icon: BookOpen,
  },
  {
    label: "Blacklists & Bans",
    href: "/antifraud/guide/blacklists",
    icon: BookOpen,
  },
  {
    label: "When Something Breaks",
    href: "/antifraud/guide/troubleshooting",
    icon: BookOpen,
  },
];

const ADMIN_NAV: NavItem[] = [
  { label: "Deposits", href: "/antifraud/admin/deposits", icon: Banknote },
];

/**
 * System owns Fraud configuration and manager tools: Settings, Config,
 * Discord routing, and the staff audit log. Retired per-surface routes
 * (`/automation`, `/points`, `/events`, `/flows`) redirect to Settings tabs.
 */
const SYSTEM_NAV: NavItem[] = [
  { label: "Refunds", href: "/antifraud/refunds", icon: RotateCcw },
  { label: "Settings", href: "/antifraud/settings", icon: SlidersHorizontal },
  { label: "Config", href: "/antifraud/config", icon: Settings2 },
  { label: "Discord routing", href: "/antifraud/discord", icon: Webhook },
  {
    label: "Audit log",
    href: "/antifraud/audit",
    icon: ScrollText,
  },
];

function NavMenu({
  items,
  pathname,
  onNavTap,
  alertCounts,
  onAlertSeen,
  toHref,
}: {
  items: NavItem[];
  pathname: string;
  onNavTap: () => void;
  alertCounts?: Partial<Record<NavAlertKey, number>>;
  onAlertSeen?: (key: NavAlertKey) => void;
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
        const alertKey: NavAlertKey | undefined =
          item.href === "/antifraud/fiat-deposits"
            ? "fiat"
            : item.href === "/antifraud/reviews"
              ? "reviews"
              : undefined;
        const alertCount = alertKey ? (alertCounts?.[alertKey] ?? 0) : 0;
        return (
          <SidebarMenuItem key={`${item.label}-${i}`}>
            <SidebarMenuButton
              isActive={isActive}
              tooltip={item.label}
              render={item.disabledReason ? undefined : <Link href={href} />}
              disabled={Boolean(item.disabledReason)}
              aria-label={
                item.disabledReason
                  ? `${item.label}. ${item.disabledReason}`
                  : item.label
              }
              title={item.disabledReason}
              onClick={() => {
                if (item.disabledReason) return;
                if (alertKey) onAlertSeen?.(alertKey);
                onNavTap();
              }}
              className="relative h-11 md:h-9 group-data-[collapsible=icon]:h-8!"
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

function NavSection({
  label,
  items,
  pathname,
  onNavTap,
  alertCounts,
  onAlertSeen,
  toHref,
  defaultOpen = false,
  storageKey,
}: {
  label: string;
  items: NavItem[];
  pathname: string;
  onNavTap: () => void;
  alertCounts?: Partial<Record<NavAlertKey, number>>;
  onAlertSeen?: (key: NavAlertKey) => void;
  toHref: (path: string) => string;
  defaultOpen?: boolean;
  storageKey: string;
}) {
  const active = items.some((item) => {
    const href = toHref(item.href);
    const root = toHref("/antifraud");
    return (
      pathname === href || (href !== root && pathname.startsWith(`${href}/`))
    );
  });
  const [open, setOpen] = React.useState(defaultOpen || active);

  React.useEffect(() => {
    if (active) {
      setOpen(true);
      persistSectionState(storageKey, true);
      return;
    }
    try {
      const saved = window.localStorage.getItem(storageKey);
      if (saved) setOpen(saved === "open");
    } catch {
      // The default/active state remains usable without persistence.
    }
  }, [active, storageKey]);

  function updateOpen(next: boolean) {
    setOpen(next);
    persistSectionState(storageKey, next);
  }

  return (
    <Collapsible open={open} onOpenChange={updateOpen}>
      <SidebarGroup className="px-2 py-1 group-data-[collapsible=icon]:hidden">
        <CollapsibleTrigger
          className="flex w-full items-center rounded-md pr-1 text-left outline-none hover:bg-sidebar-accent focus-visible:ring-2 focus-visible:ring-sidebar-ring group-data-[collapsible=icon]:hidden"
          aria-label={`${open ? "Collapse" : "Expand"} ${label} navigation`}
        >
          <SidebarGroupLabel className="flex-1 cursor-pointer">
            {label}
          </SidebarGroupLabel>
          <ChevronRight
            className={cn(
              "size-3.5 text-muted-foreground transition-transform motion-reduce:transition-none",
              open && "rotate-90",
            )}
            aria-hidden
          />
        </CollapsibleTrigger>
        <CollapsibleContent>
          <SidebarGroupContent>
            <NavMenu
              items={items}
              pathname={pathname}
              onNavTap={onNavTap}
              alertCounts={alertCounts}
              onAlertSeen={onAlertSeen}
              toHref={toHref}
            />
          </SidebarGroupContent>
        </CollapsibleContent>
      </SidebarGroup>
    </Collapsible>
  );
}

export function AntifraudSidebar({
  viewerId,
  canManage = false,
  access = { creatorHub: false, packStudio: false, antifraud: true },
}: {
  viewerId: string;
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
  const reviewsHref = toHref("/antifraud/reviews");
  const fiatHref = toHref("/antifraud/fiat-deposits");
  const activeAlertKey: NavAlertKey | undefined =
    pathname === reviewsHref || pathname.startsWith(reviewsHref + "/")
      ? "reviews"
      : pathname === fiatHref || pathname.startsWith(fiatHref + "/")
        ? "fiat"
        : undefined;
  const { counts: navAlertCounts, markSeen: markNavAlertSeen } =
    useNavAlertBadges({
      keys: ANTIFRAUD_NAV_ALERT_KEYS,
      viewerId,
      scope: "antifraud",
      activeKey: activeAlertKey,
    });

  // Close the mobile drawer on a navigation tap (same UX the other sidebars
  // apply — otherwise the new page renders behind the still-open sheet).
  function handleNavTap() {
    if (isMobile) setOpenMobile(false);
  }

  return (
    <Sidebar collapsible="icon">
      {/* Packy wordmark — same assets + sizing as the main AppSidebar header. */}
      <SidebarHeader className="border-b border-border px-4 h-16 flex items-center justify-center group-data-[collapsible=icon]:px-0">
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
        </Link>
      </SidebarHeader>

      <SidebarContent>
        <NavSection
          label="Overview"
          items={OVERVIEW_NAV}
          pathname={pathname}
          onNavTap={handleNavTap}
          alertCounts={navAlertCounts}
          onAlertSeen={markNavAlertSeen}
          toHref={toHref}
          defaultOpen
          storageKey={`antifraud-nav:v1:${viewerId}:overview`}
        />
        <NavSection
          label="Main"
          items={MAIN_NAV}
          pathname={pathname}
          onNavTap={handleNavTap}
          alertCounts={navAlertCounts}
          onAlertSeen={markNavAlertSeen}
          toHref={toHref}
          storageKey={`antifraud-nav:v1:${viewerId}:transactions`}
        />
        <NavSection
          label="Blacklists"
          items={BLACKLIST_NAV}
          pathname={pathname}
          onNavTap={handleNavTap}
          toHref={toHref}
          storageKey={`antifraud-nav:v1:${viewerId}:blacklists`}
        />
        <NavSection
          label="Guide"
          items={GUIDE_NAV}
          pathname={pathname}
          onNavTap={handleNavTap}
          toHref={toHref}
          storageKey={`antifraud-nav:v1:${viewerId}:guide`}
        />

        {canManage && (
          <NavSection
            label="Admin"
            items={ADMIN_NAV}
            pathname={pathname}
            onNavTap={handleNavTap}
            toHref={toHref}
            storageKey={`antifraud-nav:v1:${viewerId}:admin`}
          />
        )}
        {canManage && (
          <NavSection
            label="System"
            items={SYSTEM_NAV}
            pathname={pathname}
            onNavTap={handleNavTap}
            toHref={toHref}
            storageKey={`antifraud-nav:v1:${viewerId}:system`}
          />
        )}
        <SidebarGroup className="hidden px-1 py-1 group-data-[collapsible=icon]:block">
          <SidebarGroupContent>
            <NavMenu
              items={[
                ...OVERVIEW_NAV,
                ...MAIN_NAV,
                ...BLACKLIST_NAV,
                ...GUIDE_NAV,
                ...(canManage ? ADMIN_NAV : []),
                ...(canManage ? SYSTEM_NAV : []),
              ]}
              pathname={pathname}
              onNavTap={handleNavTap}
              alertCounts={navAlertCounts}
              onAlertSeen={markNavAlertSeen}
              toHref={toHref}
            />
          </SidebarGroupContent>
        </SidebarGroup>
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
