"use client";

import * as React from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { LogOut, RotateCw, User, Sun, Moon, Monitor, Clock, Check } from "lucide-react";
import { useTheme } from "next-themes";
import { toast } from "sonner";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { Separator } from "@/components/ui/separator";
import { LiveIndicator } from "@/components/live-indicator";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { logout } from "@/lib/actions/auth";
import { ROLE_COLORS } from "@/lib/constants";
import { TIMEZONE_GROUPS } from "@/lib/timezones";
import { updatePreferences } from "@/app/(admin)/profile/preferences-actions";
import { useTimezoneContext } from "@/components/timezone-provider";

function getBreadcrumbs(pathname: string) {
  const segments = pathname.split("/").filter(Boolean);
  return segments.map((seg) => seg.charAt(0).toUpperCase() + seg.slice(1));
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
          <React.Fragment key={group.region}>
            <DropdownMenuLabel>{group.region}</DropdownMenuLabel>
            {group.zones.map((z) => (
              <DropdownMenuItem key={z.value} onClick={() => pick(z.value)}>
                <span className="truncate">{z.label}</span>
                {ctx.explicit && active === z.value && (
                  <Check className="ml-auto size-4" />
                )}
              </DropdownMenuItem>
            ))}
          </React.Fragment>
        ))}
        <DropdownMenuSeparator />
        <DropdownMenuItem onClick={() => router.push("/profile")}>
          <span className="text-muted-foreground">Custom…</span>
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
}: {
  adminId: string;
  username: string;
  displayUsername: string | null;
  hasAvatar: boolean;
  role: string;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const breadcrumbs = getBreadcrumbs(pathname);
  // Hidden-form ref so the dropdown's "Log out" menu item can submit the
  // existing server action without a visible icon button.
  const logoutFormRef = React.useRef<HTMLFormElement>(null);

  const label = displayUsername ?? username;

  return (
    <header className="flex h-14 items-center gap-2 border-b border-border px-3 sm:gap-3 sm:px-4">
      <SidebarTrigger />
      <Separator orientation="vertical" className="!self-auto h-5 hidden sm:block" />
      {/* Breadcrumbs: shrink aggressively on narrow screens and horizontally
          scroll if the crumb chain is longer than the remaining space.
          min-w-0 is required so flex children don't overflow their parent. */}
      <nav className="flex min-w-0 items-center gap-1 overflow-x-auto text-sm text-muted-foreground [scrollbar-width:none]">
        {breadcrumbs.map((crumb, i) => (
          <span key={i} className="flex shrink-0 items-center gap-1">
            {i > 0 && <span>/</span>}
            <span className={i === breadcrumbs.length - 1 ? "text-foreground" : ""}>
              {crumb}
            </span>
          </span>
        ))}
      </nav>
      <Button
        variant="ghost"
        size="icon"
        className="size-7 shrink-0"
        onClick={() => router.refresh()}
        aria-label="Reload page"
        title="Reload page"
      >
        <RotateCw className="size-3.5" />
      </Button>
      <div className="ml-auto flex shrink-0 items-center gap-2 sm:gap-3">
        {/* Global live-users indicator. Polls on its own 15s cadence and
            pauses when the tab is hidden. Sits LEFT of the avatar with a
            thin vertical divider so it reads as a sibling status chip,
            not part of the profile cluster. */}
        <LiveIndicator />
        <Separator orientation="vertical" className="!self-auto h-5" />
        {/* Avatar + name now opens a dropdown with quick-access theme +
            timezone pickers alongside the profile link and logout. The
            whole cluster is the trigger so the click target stays as
            large as the pre-dropdown Link was. */}
        <DropdownMenu>
          <DropdownMenuTrigger
            className="flex items-center gap-2.5 rounded-full p-1 pr-3 outline-none hover:bg-accent transition-colors focus-visible:ring-2 focus-visible:ring-ring"
            aria-label="Open profile menu"
            title={label}
          >
            <Avatar className="size-9">
              {hasAvatar && (
                <AvatarImage src={`/api/admin/avatar/${adminId}`} alt={label} />
              )}
              <AvatarFallback className="text-sm font-semibold">
                {initials(label)}
              </AvatarFallback>
            </Avatar>
            <span className="hidden text-sm font-medium sm:inline">{label}</span>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="min-w-[220px]">
            <DropdownMenuLabel className="font-normal">
              <div className="flex flex-col">
                <span className="text-sm font-medium">{label}</span>
                <span className="truncate text-xs text-muted-foreground">
                  @{username}
                </span>
              </div>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            <Link href="/profile" tabIndex={-1}>
              <DropdownMenuItem>
                <User className="size-4" />
                <span>My Profile</span>
              </DropdownMenuItem>
            </Link>
            <ThemeSubmenu />
            <TimezoneSubmenu />
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
        <Badge variant="outline" className={ROLE_COLORS[role]}>
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
