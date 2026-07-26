"use client";

import { LayoutDashboard, Megaphone, Package, ShieldAlert } from "lucide-react";

import { HostLink } from "@/components/host-link";
import { cn } from "@/lib/utils";

/**
 * APP SWITCHER — the single control for moving between the four apps that share
 * this dashboard (Admin, Creator Hub, Pack Studio, Antifraud).
 *
 * It replaces the stack of full-width "Switch to X" gradient cards each sidebar
 * used to carry. Those grew one card per app and by four apps they ate the
 * footer, repeated the same affordance three times, and gave no sense of "which
 * app am I in" — a switcher does both jobs in one row: the current app is the
 * selected segment, the others are one click away.
 *
 * Shape is a segmented control: neutral track, the active segment lifted onto
 * the surface color with its app's accent on the icon + label. That follows the
 * flat design standard (accent on the mark, not a colored fill) and the accents
 * are the ones each app already owned — pink = Creator Hub, violet = Pack
 * Studio, cyan = Antifraud, primary = Admin — so the color still reads as
 * "which app".
 *
 * COLLAPSED SIDEBAR: the track turns into a single-column icon stack, so the
 * switcher survives icon mode instead of being hidden.
 *
 * ACCESS: `access` is computed SERVER-SIDE by `resolveAppAccess` and passed
 * down. A segment only renders for an app the viewer would actually get into,
 * and the current app is always shown even if its flag were false (you are in
 * it). The sub-app layouts remain the real gate.
 */

export type AppKey = "admin" | "creator-hub" | "pack-studio" | "antifraud";

export type AppSwitcherAccess = {
  admin?: boolean;
  /** Optional role-specific Admin landing route (Pack Builder uses /packs). */
  adminHref?: string;
  creatorHub: boolean;
  packStudio: boolean;
  antifraud: boolean;
};

type AppEntry = {
  key: AppKey;
  /** Canonical internal path — HostLink maps it to the owning subdomain. */
  href: string;
  /** Short label; the track holds up to four, so it has to stay tight. */
  label: string;
  title: string;
  icon: typeof LayoutDashboard;
  /** Active-state accent classes (text color for icon + label). */
  accent: string;
};

const APPS: readonly AppEntry[] = [
  {
    key: "admin",
    href: "/dashboard",
    label: "Admin",
    title: "Admin dashboard",
    icon: LayoutDashboard,
    accent: "text-sidebar-primary",
  },
  {
    key: "creator-hub",
    href: "/creator-hub",
    label: "Creators",
    title: "Creator Hub — CM team workspace",
    icon: Megaphone,
    accent: "text-pink-600 dark:text-pink-400",
  },
  {
    key: "pack-studio",
    href: "/pack-studio",
    label: "Packs",
    title: "Pack Studio",
    icon: Package,
    accent: "text-violet-600 dark:text-violet-400",
  },
  {
    key: "antifraud",
    href: "/antifraud",
    label: "Fraud",
    title: "Antifraud — fraud operations",
    icon: ShieldAlert,
    accent: "text-cyan-600 dark:text-cyan-400",
  },
];

export function AppSwitcher({
  current,
  access,
  onNavigate,
}: {
  /** The app this sidebar belongs to — its segment is the selected one. */
  current: AppKey;
  /** Server-computed per-app entitlement. */
  access: AppSwitcherAccess;
  /** Mobile drawers close on a nav tap, same as the nav rows. */
  onNavigate?: () => void;
}) {
  const entries = APPS.filter((app) => {
    if (app.key === current) return true;
    if (app.key === "admin") return access.admin !== false;
    if (app.key === "creator-hub") return access.creatorHub;
    if (app.key === "pack-studio") return access.packStudio;
    return access.antifraud;
  });

  // One app only — a switcher with nothing to switch to is noise.
  if (entries.length < 2) return null;

  return (
    <div className="px-2 group-data-[collapsible=icon]:px-1">
      <div
        role="group"
        aria-label="Switch workspace"
        className={cn(
          "grid gap-0.5 rounded-xl border border-border bg-muted/40 p-1",
          entries.length === 2 && "grid-cols-2",
          entries.length === 3 && "grid-cols-3",
          entries.length === 4 && "grid-cols-4",
          "group-data-[collapsible=icon]:grid-cols-1",
        )}
      >
        {entries.map((app) => {
          const Icon = app.icon;
          const isActive = app.key === current;
          const href =
            app.key === "admin" ? (access.adminHref ?? app.href) : app.href;
          return (
            <HostLink
              key={app.key}
              href={href}
              onClick={onNavigate}
              title={app.title}
              aria-current={isActive ? "page" : undefined}
              className={cn(
                "flex min-w-0 flex-col items-center justify-center gap-1 rounded-lg px-1 py-1.5 outline-none",
                "focus-visible:ring-2 focus-visible:ring-ring",
                "motion-safe:transition-[background-color,color,transform] motion-safe:duration-150 motion-safe:ease-out motion-safe:active:scale-[0.97]",
                isActive
                  ? "bg-background shadow-sm ring-1 ring-inset ring-border"
                  : "text-muted-foreground hover:bg-background/60 hover:text-foreground",
              )}
            >
              <Icon
                className={cn("size-4 shrink-0", isActive && app.accent)}
              />
              <span
                className={cn(
                  "block max-w-full truncate text-[9px] font-semibold uppercase tracking-[0.08em] group-data-[collapsible=icon]:hidden",
                  isActive ? app.accent : "text-muted-foreground",
                )}
              >
                {app.label}
              </span>
            </HostLink>
          );
        })}
      </div>
    </div>
  );
}
