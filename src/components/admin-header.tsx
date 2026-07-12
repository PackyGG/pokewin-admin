"use client";

import * as React from "react";
import { usePathname, useRouter } from "next/navigation";
import {
  LogOut,
  User,
  Sun,
  Moon,
  Monitor,
  Sparkles,
  Sparkle,
  Clock,
  Check,
  Database,
  KeyRound,
  ChevronDown,
  ShieldCheck,
} from "lucide-react";
import { useTheme } from "next-themes";
import { toast } from "sonner";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
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
  // Only title-case real route slugs (lowercase letters/hyphens). Dynamic id
  // segments (user ids etc. are case-sensitive nanoid/cuid strings) are shown
  // verbatim — capitalizing their first char corrupts the displayed id.
  return segments.map((seg) =>
    /^[a-z][a-z-]*$/.test(seg) ? seg.charAt(0).toUpperCase() + seg.slice(1) : seg,
  );
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

  async function pick(
    next: "light" | "dark" | "system" | "grailed" | "grailed-light",
  ) {
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
        <DropdownMenuItem onClick={() => pick("grailed")}>
          <Sparkles className="size-4" />
          <span>Grailed Dark</span>
          {active === "grailed" && <Check className="ml-auto size-4" />}
        </DropdownMenuItem>
        <DropdownMenuItem onClick={() => pick("grailed-light")}>
          <Sparkle className="size-4" />
          <span>Grailed Light</span>
          {active === "grailed-light" && <Check className="ml-auto size-4" />}
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
}) {
  const pathname = usePathname();
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
    // Glass chrome: layered translucency (background token ~85% +
    // backdrop blur) with a hairline divider, per the Liquid-Glass spec.
    // The /95 fallback keeps the header legible when backdrop-filter is
    // unsupported.
    <header className="sticky top-0 z-30 flex h-14 shrink-0 items-center gap-1.5 border-b border-border/60 bg-background/95 px-2 backdrop-blur-xl supports-[backdrop-filter]:bg-background/85 sm:gap-3 sm:px-4">
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
      <div className="ml-auto flex shrink-0 items-center gap-1.5 sm:gap-3">
        {/* Avatar + name now opens a dropdown with quick-access theme +
            timezone pickers alongside the profile link and logout. The
            whole cluster is the trigger so the click target stays as
            large as the pre-dropdown Link was. */}
        <DropdownMenu>
          {/* All-in-one identity card — rounded-square avatar + a two-line
              name/role stack + a chevron, wrapped in a single bordered,
              tinted pill (sm+). On phones it stays a compact avatar-only tap
              target so it never crowds a 360px header (name + roles live in
              the dropdown there). The whole card is the trigger, so the click
              target stays large. `group` + base-ui's `data-popup-open` flips
              the chevron while the menu is open. */}
          <DropdownMenuTrigger
            className={cn(
              "group flex items-center gap-2.5 rounded-xl p-0.5 outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring",
              // sm+: a roomy, premium identity card — wider avatar-to-chevron
              // span via a min-width floor that grows on large screens, more
              // L↔R padding and a larger gap. Kept deliberately short vertically
              // (py-1 + a size-10 avatar sits well inside the h-14 header) so it
              // reads WIDE + spacious, never tall/bulky.
              "sm:gap-3.5 sm:rounded-2xl sm:border sm:border-border/60 sm:bg-muted/30 sm:py-1 sm:pl-1.5 sm:pr-3.5 sm:min-w-[14.5rem] lg:min-w-[17rem] sm:hover:border-border sm:hover:bg-muted/50",
            )}
            aria-label="Open profile menu"
            title={label}
          >
            <Avatar className="size-10 rounded-lg after:rounded-lg sm:rounded-xl sm:after:rounded-xl">
              {hasAvatar && (
                <AvatarImage
                  src={`/api/admin/avatar/${adminId}`}
                  alt={label}
                  className="rounded-lg sm:rounded-xl"
                />
              )}
              <AvatarFallback className="rounded-lg text-sm font-semibold sm:rounded-xl">
                {initials(label)}
              </AvatarFallback>
            </Avatar>
            {/* Name (line 1) over role badge(s) (line 2). Hidden on phones —
                the dropdown menu already carries both there. */}
            <div className="hidden min-w-0 flex-col items-start gap-1 sm:flex">
              <span className="max-w-[16rem] truncate text-sm font-semibold leading-tight text-foreground">
                {label}
              </span>
              <span className="flex flex-wrap items-center gap-1">
                {roleList.map((r) => (
                  <Badge
                    key={r}
                    variant="outline"
                    className={cn(
                      "h-[18px] gap-0.5 px-2 text-[10px] font-bold uppercase leading-none tracking-wide",
                      ROLE_COLORS[r],
                    )}
                  >
                    <ShieldCheck className="size-3" />
                    {r.replace("_", " ")}
                  </Badge>
                ))}
              </span>
            </div>
            <ChevronDown className="hidden size-4 shrink-0 text-muted-foreground transition-transform duration-200 group-data-[popup-open]:rotate-180 sm:ml-auto sm:block" />
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
