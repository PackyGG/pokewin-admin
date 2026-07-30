import { Banknote, Bitcoin, type LucideIcon } from "lucide-react";

import { HostLink } from "@/components/host-link";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";

type TransactionRail = "fiat" | "crypto";

const RAILS: Array<{
  value: TransactionRail;
  label: string;
  icon: LucideIcon;
}> = [
  { value: "fiat", label: "Fiat", icon: Banknote },
  { value: "crypto", label: "Crypto", icon: Bitcoin },
];

export function TransactionRailTabs({
  active,
  hrefFor,
  counts,
  label,
}: {
  active: TransactionRail;
  hrefFor: (rail: TransactionRail) => string;
  counts?: Partial<Record<TransactionRail, number>>;
  label: string;
}) {
  return (
    <nav
      aria-label={`${label} payment rail`}
      className="inline-flex gap-1 rounded-lg bg-muted p-1"
    >
      {RAILS.map((rail) => {
        const Icon = rail.icon;
        return (
          <HostLink
            key={rail.value}
            href={hrefFor(rail.value)}
            scroll={false}
            prefetch={false}
            aria-current={active === rail.value ? "page" : undefined}
            className={cn(
              "inline-flex min-h-9 items-center gap-1.5 rounded-md px-3 text-sm font-medium transition-colors",
              active === rail.value
                ? "bg-background text-foreground shadow-sm"
                : "text-muted-foreground hover:text-foreground",
            )}
          >
            <Icon className="size-3.5" />
            {rail.label}
            {counts?.[rail.value] !== undefined && (
              <Badge
                variant="secondary"
                className="h-5 min-w-5 justify-center px-1.5 text-[10px] tabular-nums"
              >
                {counts[rail.value]!.toLocaleString()}
              </Badge>
            )}
          </HostLink>
        );
      })}
    </nav>
  );
}
