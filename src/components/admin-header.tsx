"use client";

import { usePathname, useRouter } from "next/navigation";
import { LogOut, RotateCw } from "lucide-react";
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

export function AdminHeader({
  username,
  role,
}: {
  username: string;
  role: string;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const breadcrumbs = getBreadcrumbs(pathname);

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
        {/* Username text is noise on narrow screens — the role badge +
            logout button are enough identity to keep visible. */}
        <span className="hidden text-sm sm:inline">{username}</span>
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
