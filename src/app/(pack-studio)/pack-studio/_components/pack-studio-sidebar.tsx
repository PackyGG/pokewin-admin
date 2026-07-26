"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import {
  ArrowLeft,
  ClipboardEdit,
  LayoutDashboard,
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
import { useAppHost, useCrossAppHrefs } from "@/lib/use-app-host";
import { hrefFrom } from "@/lib/app-hosts";
import { ThemeToggle } from "@/components/theme-toggle";
import { LinkPending } from "@/components/ux";

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

const STUDIO_NAV: StudioNavItem[] = [
  { label: "Overview", href: "/pack-studio", icon: LayoutDashboard },
  { label: "Pack Doctor", href: "/pack-studio/doctor", icon: Stethoscope },
  { label: "Retune", href: "/pack-studio/retune", icon: Sparkles },
  { label: "Pack Builder", href: "/pack-studio/builder", icon: Wand2 },
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
}: {
  isOwner?: boolean;
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
  // host, and make "Back to Admin" absolute — a bare /dashboard there would be
  // rewritten into this host's segment.
  const appHost = useAppHost();
  const { admin: adminHref } = useCrossAppHrefs();
  const toHref = (path: string) => (appHost ? hrefFrom(appHost, path) : path);

  // Append owner-only (History) and operator-only (Drafts) entries after the
  // shared workspace nav. Owners are implicitly retune-operators, but the prop
  // is the explicit signal so the layout's contract is symmetric.
  const navItems = [
    ...STUDIO_NAV,
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
            <span className="block truncate text-[11px] text-muted-foreground">
              Pack design workspace
            </span>
          </span>
        </Link>
      </SidebarHeader>

      {/* Back to Admin — symmetric portal to the main sidebar's
          "Switch to Pack Studio" affordance: same violet gradient card,
          two-line label, mirrored arrow + icon placement. */}
      <div className="px-2 pt-2 group-data-[collapsible=icon]:px-0">
        <Link
          href={adminHref}
          onClick={handleNavTap}
          title="Back to Admin"
          className={cn(
            "group/back relative flex items-center gap-2.5 overflow-hidden rounded-xl border border-violet-500/30 bg-gradient-to-r from-violet-500/15 via-violet-500/10 to-transparent px-3 py-2.5 outline-none",
            "transition-colors hover:border-violet-500/50 hover:from-violet-500/25 hover:via-violet-500/15 focus-visible:ring-2 focus-visible:ring-violet-500/40",
            "group-data-[collapsible=icon]:mx-auto group-data-[collapsible=icon]:size-8 group-data-[collapsible=icon]:justify-center group-data-[collapsible=icon]:gap-0 group-data-[collapsible=icon]:rounded-lg group-data-[collapsible=icon]:px-0 group-data-[collapsible=icon]:py-0",
          )}
        >
          <ArrowLeft className="size-4 shrink-0 text-violet-500 transition-transform group-data-[collapsible=icon]:hidden motion-safe:group-hover/back:-translate-x-0.5" />
          <span className="min-w-0 flex-1 group-data-[collapsible=icon]:hidden">
            <span className="block truncate text-xs font-semibold text-violet-600 dark:text-violet-300">
              Back to Admin
            </span>
            <span className="block truncate text-[11px] text-muted-foreground">
              Main dashboard
            </span>
          </span>
          <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-violet-500/20 text-violet-600 ring-1 ring-inset ring-violet-500/30 dark:text-violet-400 group-data-[collapsible=icon]:size-8 group-data-[collapsible=icon]:rounded-lg">
            <LayoutDashboard className="size-4" />
          </span>
        </Link>
      </div>

      <SidebarContent>
        <SidebarGroup className="px-2 py-1">
          <SidebarGroupLabel>Workspace</SidebarGroupLabel>
          <SidebarGroupContent>
            <StudioNavMenu
              items={navItems}
              pathname={pathname}
              onNavTap={handleNavTap}
              toHref={toHref}
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
