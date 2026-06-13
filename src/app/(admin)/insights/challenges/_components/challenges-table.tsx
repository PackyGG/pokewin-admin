"use client";

import { useMemo, useState } from "react";
import { ArrowDown, ArrowUp } from "lucide-react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Badge } from "@/components/ui/badge";
import { cn } from "@/lib/utils";
import { formatCurrency, formatDate } from "@/lib/utils/format";
import type { ChallengeRow } from "@/lib/queries/insights-challenges";

/**
 * Per-challenge metadata table. Current-state (not period-filtered). Sortable
 * by prize cost or claims. House-POV: prize_amount is money paid TO users →
 * a house cost → rose. Status / type / counts are neutral state, not money.
 */

// Status pills are STATE indicators (active / paused / archived), not money
// values — so the House-POV rose/emerald financial rule does not apply here.
const STATUS_BADGE: Record<string, string> = {
  active:
    "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30",
  inactive:
    "bg-zinc-500/15 text-zinc-600 dark:text-zinc-400 border-zinc-500/30",
  archived:
    "bg-zinc-500/15 text-zinc-500 dark:text-zinc-400 border-zinc-500/30",
};

const TYPE_LABEL: Record<string, string> = {
  pack_pull: "Pack pull",
  upgrader: "Upgrader",
};

type SortKey = "cost" | "claims";

export function ChallengesTable({ rows }: { rows: ChallengeRow[] }) {
  const [sortKey, setSortKey] = useState<SortKey>("cost");
  const [dir, setDir] = useState<"asc" | "desc">("desc");

  const sorted = useMemo(() => {
    const copy = [...rows];
    copy.sort((a, b) => {
      const av = sortKey === "cost" ? a.prizeAmount : a.claimedCount;
      const bv = sortKey === "cost" ? b.prizeAmount : b.claimedCount;
      return dir === "desc" ? bv - av : av - bv;
    });
    return copy;
  }, [rows, sortKey, dir]);

  function toggle(key: SortKey) {
    if (sortKey === key) {
      setDir((d) => (d === "desc" ? "asc" : "desc"));
    } else {
      setSortKey(key);
      setDir("desc");
    }
  }

  function SortHead({
    label,
    sortable,
  }: {
    label: string;
    sortable: SortKey;
  }) {
    const active = sortKey === sortable;
    return (
      <TableHead className="text-right">
        <button
          type="button"
          onClick={() => toggle(sortable)}
          className={cn(
            "ml-auto inline-flex items-center gap-1 text-xs font-medium transition-colors hover:text-foreground",
            active ? "text-foreground" : "text-muted-foreground",
          )}
          aria-label={`Sort by ${label}`}
        >
          {label}
          {active &&
            (dir === "desc" ? (
              <ArrowDown className="size-3" />
            ) : (
              <ArrowUp className="size-3" />
            ))}
        </button>
      </TableHead>
    );
  }

  return (
    <div className="overflow-x-auto">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead className="text-xs text-muted-foreground">
              Challenge
            </TableHead>
            <TableHead className="text-xs text-muted-foreground">Type</TableHead>
            <TableHead className="text-xs text-muted-foreground">
              Status
            </TableHead>
            <SortHead label="Prize" sortable="cost" />
            <SortHead label="Claims" sortable="claims" />
            <TableHead className="text-right text-xs text-muted-foreground">
              Completion
            </TableHead>
            <TableHead className="text-right text-xs text-muted-foreground">
              Created
            </TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {sorted.map((c) => {
            const pct = Math.round(c.completionRate * 100);
            return (
              <TableRow key={c.id}>
                <TableCell className="font-medium">{c.name}</TableCell>
                <TableCell className="text-muted-foreground">
                  {TYPE_LABEL[c.type] ?? c.type}
                </TableCell>
                <TableCell>
                  <Badge
                    variant="outline"
                    className={cn(
                      "capitalize",
                      STATUS_BADGE[c.status] ??
                        "bg-zinc-500/15 text-zinc-600 dark:text-zinc-400 border-zinc-500/30",
                    )}
                  >
                    {c.status}
                  </Badge>
                </TableCell>
                {/* Prize = money paid out to users = house cost → rose */}
                <TableCell className="text-right font-medium tabular-nums text-rose-600 dark:text-rose-400">
                  {formatCurrency(c.prizeAmount)}
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  {c.claimedCount}
                  <span className="text-muted-foreground"> / {c.maxClaims}</span>
                </TableCell>
                <TableCell className="text-right tabular-nums">
                  <span
                    className={cn(
                      "text-muted-foreground",
                      pct >= 100 && "text-foreground",
                    )}
                  >
                    {pct}%
                  </span>
                </TableCell>
                <TableCell className="text-right text-muted-foreground tabular-nums">
                  {formatDate(c.createdAt)}
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}
