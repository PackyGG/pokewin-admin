"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import {
  LogOut,
  RotateCw,
  User,
  Sun,
  Moon,
  Monitor,
  Clock,
  Check,
  Database,
} from "lucide-react";
import { useTheme } from "next-themes";
import { toast } from "sonner";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { Separator } from "@/components/ui/separator";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuGroup,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { logout } from "@/lib/actions/auth";
import { switchDbEnv } from "@/lib/actions/db-env";
import { ROLE_COLORS } from "@/lib/constants";
import { TIMEZONE_GROUPS } from "@/lib/timezones";
import { updatePreferences } from "@/app/(admin)/profile/preferences-actions";
import { useTimezoneContext } from "@/components/timezone-provider";
import { cn } from "@/lib/utils";
import type { DbEnv } from "@/lib/db-env";

function getBreadcrumbs(pathname: string) {
  const segments = pathname.split("/").filter(Boolean);
  return segments.map((seg) => seg.charAt(0).toUpperCase() + seg.slice(1));
}

/**
 * Phone-sized breadcrumb fallback: keep only the last two segments and
 * prefix with `…` so the user still sees the current page + parent
 * without overflowing. Drops everything above two segments so the chain
 * never wraps to a second line on a 360px viewport.
 */
function truncateBreadcrumbs(crumbs: string[]): {
  truncated: boolean;
  visible: string[];
} {
  if (crumbs.length <= 2) {
    return { truncated: false, visible: crumbs };
  }
  return { truncated: true, visible: crumbs.slice(-2) };
}

function initials(source: string): string {
  const clean = source.trim();
  if (!clean) return "?";
  const parts = clean.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return clean.slice(0, 2).toUpperCase();
}

/**
 * Theme submenu — three presets with a checkmark on the active choice.
 * Writes both client-side (next-themes) and server-side (preferences row)
 * so the setting survives logout / other devices.
 */
function ThemeSubmenu() {
  const { theme, setTheme } = useTheme();
  // next-themes returns `theme` for the user's choice ("system" /
  // "light" / "dark"); `resolvedTheme` is the actually-applied class.
  // For the checkmark we care about the explicit choice.
  const active = theme ?? "system";

  async function pick(next: "light" | "dark" | "system") {
    setTheme(next);
    try {
      await updatePreferences({ theme: next });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not save theme");
    }
  }

  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>
        <Sun className="mr-1 size-4" />
        <span>Theme</span>
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="min-w-[160px]">
        <DropdownMenuItem onClick={() => pick("light")}>
          <Sun className="size-4" />
          <span>Light</span>
          {active === "light" && <Check className="ml-auto size-4" />}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => pick("dark")}>
          <Moon className="size-4" />
          <span>Dark</span>
          {active === "dark" && <Check className="ml-auto size-4" />}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => pick("system")}>
          <Monitor className="size-4" />
          <span>System</span>
          {active === "system" && <Check className="ml-auto size-4" />}
        </DropdownMenuItem>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}

/**
 * Timezone submenu — grouped list of curated IANA zones plus a "Detect
 * from browser" option that clears the explicit preference. A "Custom…"
 * row navigates to /profile where the editor has a free-form text field
 * (keeps the dropdown itself lean).
 */
function TimezoneSubmenu() {
  const router = useRouter();
  const ctx = useTimezoneContext();
  const active = ctx.timezone;

  async function pick(value: string | null) {
    ctx.setTimezone(value);
    try {
      await updatePreferences({ timezone: value });
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not save timezone");
    }
  }

  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>
        <Clock className="mr-1 size-4" />
        <span>Timezone</span>
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="max-h-[60vh] min-w-[240px] overflow-y-auto">
        <DropdownMenuItem onClick={() => pick(null)}>
          <span>Detect from browser</span>
          {!ctx.explicit && <Check className="ml-auto size-4" />}
        </DropdownMenuItem>
        <DropdownMenuSeparator />
        {TIMEZONE_GROUPS.map((group) => (
          // DropdownMenuLabel = base-ui Menu.GroupLabel, which requires a
          // Menu.Group parent. Each region gets its own Group so the label
          // and its items are a valid a11y group.
          <DropdownMenuGroup key={group.region}>
            <DropdownMenuLabel>{group.region}</DropdownMenuLabel>
            {group.zones.map((z) => (
              <DropdownMenuItem key={z.value} onClick={() => pick(z.value)}>
                <span className="truncate">{z.label}</span>
                {ctx.explicit && active === z.value && (
                  <Check className="ml-auto size-4" />
                )}
              </DropdownMenuItem>
            ))}
          </DropdownMenuGroup>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => router.push("/profile")}>
          <span className="text-muted-foreground">Custom…</span>
        </DropdownMenuItem>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}

/**
 * Database-env submenu — admin-only. Lets the current admin route
 * their own requests at the prod or dev Main-DB. The switcher is
 * hidden entirely unless the server confirms both `canSwitch` (admin
 * role) and that a DEV_DATABASE_URL is configured. The active env is
 * server-sourced so it survives navigation and reloads.
 */
function DbEnvSubmenu({ active }: { active: DbEnv }) {
  const router = useRouter();
  const [pending, setPending] = React.useState(false);

  async function pick(next: DbEnv) {
    if (pending || next === active) return;
    setPending(true);
    try {
      await switchDbEnv(next);
      toast.success(
        next === "dev"
          ? "Switched to DEV environment"
          : "Switched back to PROD environment",
      );
      // Force the layout to re-read the cookie and refresh RSC payload
      // so the banner appears/disappears immediately.
      router.refresh();
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Could not switch environment",
      );
    } finally {
      setPending(false);
    }
  }

  return (
    <DropdownMenuSub>
      <DropdownMenuSubTrigger>
        <Database className="mr-1 size-4" />
        <span>Database</span>
        <span
          className={
            "ml-auto text-[10px] font-semibold uppercase tracking-wide " +
            (active === "dev" ? "text-rose-500" : "text-muted-foreground")
          }
        >
          {active}
        </span>
      </DropdownMenuSubTrigger>
      <DropdownMenuSubContent className="min-w-[200px]">
        <DropdownMenuItem onClick={() => pick("prod")} disabled={pending}>
          <span>Production</span>
          {active === "prod" && <Check className="ml-auto size-4" />}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => pick("dev")} disabled={pending}>
          <span>Development</span>
          {active === "dev" && <Check className="ml-auto size-4" />}
        </DropdownMenuItem>
      </DropdownMenuSubContent>
    </DropdownMenuSub>
  );
}

export function AdminHeader({
  adminId,
  username,
  displayUsername,
  hasAvatar,
  role,
  dbEnv,
  canSwitchDbEnv,
}: {
  adminId: string;
  username: string;
  displayUsername: string | null;
  hasAvatar: boolean;
  role: string;
  dbEnv: DbEnv;
  canSwitchDbEnv: boolean;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const breadcrumbs = getBreadcrumbs(pathname);
  const phoneCrumbs = truncateBreadcrumbs(breadcrumbs);
  // Hidden-form ref so the dropdown's "Log out" menu item can submit the
  // existing server action without a visible icon button.
  const logoutFormRef = React.useRef<HTMLFormElement>(null);

  const label = displayUsername ?? username;

  return (
    <header className="sticky top-0 z-30 flex h-14 shrink-0 items-center gap-1.5 border-b border-border bg-background/95 px-2 backdrop-blur supports-[backdrop-filter]:bg-background/80 sm:gap-3 sm:px-4">
      {/* SidebarTrigger renders a 44×44 hit-target on mobile (full
          touch-target spec) but stays visually compact via the inner
          icon. Margin -ml-1 lets it hug the left edge while keeping the
          tap target large. */}
      <SidebarTrigger className="size-11 sm:size-8 -ml-1 sm:ml-0 shrink-0" />
      <Separator orientation="vertical" className="!self-auto h-5 hidden sm:block" />
      {/* Breadcrumbs:
            - <sm: collapse to last two segments with leading "…" so a
              long path like /creators/123/codes/abc renders as
              "… / Codes / abc" without wrapping or overflowing.
            - sm+:  show the full chain with horizontal scroll if needed.
          min-w-0 lets the flex item shrink below its content's natural
          width — without it, a long crumb forces the whole header to
          overflow horizontally. */}
      <nav className="flex min-w-0 flex-1 items-center gap-1 overflow-hidden text-sm text-muted-foreground sm:overflow-x-auto sm:[scrollbar-width:none] sm:[&::-webkit-scrollbar]:hidden">
        {/* Phone view (<sm): truncated chain, no scroll. */}
        <div className="flex min-w-0 items-center gap-1 sm:hidden">
          {phoneCrumbs.truncated && (
            <>
              <span className="shrink-0">…</span>
              <span className="shrink-0">/</span>
            </>
          )}
          {phoneCrumbs.visible.map((crumb, i, arr) => (
            <span key={i} className="flex min-w-0 items-center gap-1">
              {i > 0 && <span className="shrink-0">/</span>}
              <span
                className={cn(
                  "truncate",
                  i === arr.length - 1 && "text-foreground",
                )}
              >
                {crumb}
              </span>
            </span>
          ))}
        </div>
        {/* Desktop view (sm+): full chain, horizontal scroll if huge. */}
        <div className="hidden sm:flex sm:min-w-0 sm:items-center sm:gap-1">
          {breadcrumbs.map((crumb, i) => (
            <span key={i} className="flex shrink-0 items-center gap-1">
              {i > 0 && <span>/</span>}
              <span className={i === breadcrumbs.length - 1 ? "text-foreground" : ""}>
                {crumb}
              </span>
            </span>
          ))}
        </div>
      </nav>
      <Button
        variant="ghost"
        size="icon"
        className="size-9 sm:size-7 shrink-0"
        onClick={() => router.refresh()}
        aria-label="Reload page"
        title="Reload page"
      >
        <RotateCw className="size-4 sm:size-3.5" />
      </Button>
      <div className="ml-auto flex shrink-0 items-center gap-1.5 sm:gap-3">
        {/* Avatar + name now opens a dropdown with quick-access theme +
            timezone pickers alongside the profile link and logout. The
            whole cluster is the trigger so the click target stays as
            large as the pre-dropdown Link was. */}
        <DropdownMenu>
          <DropdownMenuTrigger
            className="flex items-center gap-2 rounded-full p-0.5 outline-none hover:bg-accent transition-colors focus-visible:ring-2 focus-visible:ring-ring sm:gap-2.5 sm:p-1 sm:pr-3"
            aria-label="Open profile menu"
            title={label}
          >
            <Avatar className="size-10 sm:size-9">
              {hasAvatar && (
                <AvatarImage src={`/api/admin/avatar/${adminId}`} alt={label} />
              )}
              <AvatarFallback className="text-sm font-semibold">
                {initials(label)}
              </AvatarFallback>
            </Avatar>
            <span className="hidden max-w-[10rem] truncate text-sm font-medium sm:inline">
              {label}
            </span>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-[220px]">
            <DropdownMenuGroup>
              <DropdownMenuLabel className="font-normal">
                <div className="flex flex-col">
                  <span className="text-sm font-medium">{label}</span>
                  <span className="truncate text-xs text-muted-foreground">
                    @{username}
                  </span>
                </div>
              </DropdownMenuLabel>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <Link href="/profile" tabIndex={-1}>
              <DropdownMenuItem>
                <User className="size-4" />
                <span>My Profile</span>
              </DropdownMenuItem>
            </Link>
            <ThemeSubmenu />
            <TimezoneSubmenu />
            {canSwitchDbEnv && <DbEnvSubmenu active={dbEnv} />}
            <DropdownMenuSeparator />
            <DropdownMenuItem
              variant="destructive"
              onClick={() => logoutFormRef.current?.requestSubmit()}
            >
              <LogOut className="size-4" />
              <span>Log out</span>
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        {/* Role badge sits next to the avatar at sm+. On phones the role
            already lives inside the dropdown menu (and the badge would
            push the avatar off-screen on a 360px viewport), so we hide
            it here. */}
        <Badge
          variant="outline"
          className={cn("hidden sm:inline-flex", ROLE_COLORS[role])}
        >
          {role}
        </Badge>
        {/* Hidden form so the menu item above can trigger the server
            action — the old iconified button is replaced by the
            dropdown's Log out entry, but the form is still needed to
            post to the `logout` server action. */}
        <form ref={logoutFormRef} action={logout} className="hidden" />
      </div>
    </header>
  );
}
