"use client";

import * as React from "react";
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
  KeyRound,
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
import {
  ProfileDialog,
  type ProfileDialogSection,
} from "@/app/(admin)/profile/profile-dialog";
import { useTimezoneContext } from "@/components/timezone-provider";
import { cn } from "@/lib/utils";
import type { DbEnv } from "@/lib/db-env";
import type { AdminPreferences } from "@/lib/admin-preferences-types";

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
 * row opens the profile dialog, where the preferences editor has a
 * free-form IANA text field (keeps the dropdown itself lean).
 */
function TimezoneSubmenu({ onOpenProfile }: { onOpenProfile: () => void }) {
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
        <DropdownMenuItem onClick={onOpenProfile}>
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
  email,
  hasAvatar,
  role,
  roles,
  profileFieldsAvailable,
  preferences,
  dbEnv,
  canSwitchDbEnv,
  houseStatsSlot,
}: {
  adminId: string;
  username: string;
  displayUsername: string | null;
  /** Login email — shown in the profile dialog's identity block. */
  email: string;
  hasAvatar: boolean;
  role: string;
  /**
   * Full effective system-role set for this admin (always non-empty, always
   * includes `role`). A user can hold several roles at once, so the header
   * shows every one of them — not just the primary.
   */
  roles: string[];
  /**
   * Whether the admin-DB profile columns exist (display name / avatar /
   * preferences). Gates the editing controls in the profile dialog the same
   * way the old /profile page did; the header itself works regardless.
   */
  profileFieldsAvailable: boolean;
  /** The acting admin's saved preferences, seeded into the dialog editor. */
  preferences: AdminPreferences;
  dbEnv: DbEnv;
  canSwitchDbEnv: boolean;
  /**
   * Admin-only "house at a glance" pills (all-time wager / deposit /
   * withdrawal / GGR). Passed as a server-rendered slot from the layout —
   * wrapped there in its own <Suspense> so it streams independently and
   * never blocks the header shell. `undefined` for non-admins, so the bar
   * renders unchanged for every other role. Sits to the RIGHT of the
   * breadcrumbs + sidebar toggle and is `ml-auto`-pushed alongside the
   * profile cluster; it self-collapses on narrow screens.
   */
  houseStatsSlot?: React.ReactNode;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const breadcrumbs = getBreadcrumbs(pathname);
  const phoneCrumbs = truncateBreadcrumbs(breadcrumbs);
  // Hidden-form ref so the dropdown's "Log out" menu item can submit the
  // existing server action without a visible icon button.
  const logoutFormRef = React.useRef<HTMLFormElement>(null);

  // Profile dialog (replaces the old /profile route). Controlled open state
  // + which section to land on — "Change password" opens straight at the
  // Security form; "My Profile" / the timezone "Custom…" item open at the top.
  const [profileOpen, setProfileOpen] = React.useState(false);
  const [profileSection, setProfileSection] =
    React.useState<ProfileDialogSection>("profile");

  function openProfile(section: ProfileDialogSection = "profile") {
    setProfileSection(section);
    setProfileOpen(true);
  }

  const label = displayUsername ?? username;
  // Defensive: always render at least the primary role. Dedupe in case a
  // caller passed a list that already includes `role`.
  const roleList =
    roles && roles.length > 0 ? [...new Set(roles)] : [role];

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
      {/* Reload sits right beside the SidebarTrigger and is the header's
          other primary action button, so it shares the trigger's exact
          footprint (44px tap target on mobile, the shared 32px `size-8`
          icon token on desktop) and the same 16px (`size-4`) glyph —
          previously it was a touch smaller (`size-9 sm:size-7` + a
          `sm:size-3.5` icon), which read as inconsistent next to the
          trigger. Purely a sizing alignment; the reload behaviour is
          unchanged. */}
      <Button
        variant="ghost"
        size="icon"
        className="size-11 sm:size-8 shrink-0"
        onClick={() => router.refresh()}
        aria-label="Reload page"
        title="Reload page"
      >
        <RotateCw className="size-4" />
      </Button>
      <div className="ml-auto flex shrink-0 items-center gap-1.5 sm:gap-3">
        {/* Admin-only house-stats pills (all-time wager / deposit /
            withdrawal / GGR). Server-rendered + Suspense-streamed by the
            layout, so it's a no-op node for non-admins and never blocks
            the header. It collapses progressively on narrow screens (its
            own responsive `hidden md/lg/xl:flex` rules), so it can't push
            the avatar off-screen on a phone. */}
        {houseStatsSlot}
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
                <div className="flex flex-col gap-1">
                  <span className="text-sm font-medium">{label}</span>
                  <span className="truncate text-xs text-muted-foreground">
                    @{username}
                  </span>
                  {/* Roles live here so they're visible on phones too (the
                      standalone badge cluster is hidden below sm). */}
                  <span className="mt-0.5 flex flex-wrap gap-1">
                    {roleList.map((r) => (
                      <Badge
                        key={r}
                        variant="outline"
                        className={cn("text-[10px] uppercase", ROLE_COLORS[r])}
                      >
                        {r.replace("_", " ")}
                      </Badge>
                    ))}
                  </span>
                </div>
              </DropdownMenuLabel>
            </DropdownMenuGroup>
            <DropdownMenuSeparator />
            <DropdownMenuItem onClick={() => openProfile("profile")}>
              <User className="size-4" />
              <span>My Profile</span>
            </DropdownMenuItem>
            <DropdownMenuItem onClick={() => openProfile("security")}>
              <KeyRound className="size-4" />
              <span>Security</span>
            </DropdownMenuItem>
            <ThemeSubmenu />
            <TimezoneSubmenu onOpenProfile={() => openProfile("profile")} />
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
        {/* Role badges sit next to the avatar at sm+. A user can hold
            several roles, so every one is shown. On phones the roles
            already live inside the dropdown menu (and the badges would
            push the avatar off-screen on a 360px viewport), so they're
            hidden here. */}
        <span className="hidden items-center gap-1 sm:inline-flex">
          {roleList.map((r) => (
            <Badge key={r} variant="outline" className={cn(ROLE_COLORS[r])}>
              {r.replace("_", " ")}
            </Badge>
          ))}
        </span>
        {/* Hidden form so the menu item above can trigger the server
            action — the old iconified button is replaced by the
            dropdown's Log out entry, but the form is still needed to
            post to the `logout` server action. */}
        <form ref={logoutFormRef} action={logout} className="hidden" />
      </div>
      {/* Self-service profile popup — opened from the avatar dropdown
          ("My Profile" / "Change password") and the timezone "Custom…"
          row. Renders via a portal, so its position here doesn't affect
          header layout. Replaces the removed /profile route. */}
      <ProfileDialog
        open={profileOpen}
        onOpenChange={setProfileOpen}
        initialSection={profileSection}
        data={{
          id: adminId,
          username,
          email,
          role,
          displayUsername,
          hasAvatar,
          profileFieldsAvailable,
          preferences,
        }}
      />
    </header>
  );
}
