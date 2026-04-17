"use client";

import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";
import { LogOut, RotateCw } from "lucide-react";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { Separator } from "@/components/ui/separator";
import { logout } from "@/lib/actions/auth";
import { ROLE_COLORS } from "@/lib/constants";

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
        {/* Avatar + label link through to the admin's own profile page.
            The label is noise on narrow screens — the avatar + role badge
            are enough identity to keep visible. */}
        <Link
          href="/profile"
          className="flex items-center gap-2 rounded-full p-0.5 pr-2 hover:bg-accent transition-colors"
          aria-label="Open my profile"
          title={label}
        >
          <Avatar size="sm">
            {hasAvatar && (
              <AvatarImage src={`/api/admin/avatar/${adminId}`} alt={label} />
            )}
            <AvatarFallback>{initials(label)}</AvatarFallback>
          </Avatar>
          <span className="hidden text-sm sm:inline">{label}</span>
        </Link>
        <Badge variant="outline" className={ROLE_COLORS[role]}>
          {role}
        </Badge>
        <form action={logout}>
          <Button
            variant="ghost"
            size="icon"
            type="submit"
            className="size-8"
            aria-label="Log out"
            title="Log out"
          >
            <LogOut className="size-4" />
          </Button>
        </form>
      </div>
    </header>
  );
}
