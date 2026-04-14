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
    <header className="flex h-14 items-center gap-3 border-b border-border px-4">
      <SidebarTrigger />
      <Separator orientation="vertical" className="!self-auto h-5" />
      <nav className="flex items-center gap-1 text-sm text-muted-foreground">
        {breadcrumbs.map((crumb, i) => (
          <span key={i} className="flex items-center gap-1">
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
        className="size-7"
        onClick={() => router.refresh()}
        aria-label="Reload page"
        title="Reload page"
      >
        <RotateCw className="size-3.5" />
      </Button>
      <div className="ml-auto flex items-center gap-3">
        <span className="text-sm">{username}</span>
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
