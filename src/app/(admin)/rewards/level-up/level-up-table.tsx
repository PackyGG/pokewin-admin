import { TrendingUp } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatCurrency, formatDateTime, formatRelative } from "@/lib/utils/format";
import type { RewardItem } from "@/lib/queries/rewards";
import { EmptyState } from "@/components/empty-state";
import { EditRewardButton } from "../edit-reward-button";
import { DeleteRewardButton } from "../delete-reward-button";

/**
 * Re-unlock threshold display. `dailyUnlockPercentage` is a fraction
 * (0.01 = 1%) stored on the reward row; `null` means the documented 1%
 * default applies (see `RewardItem.dailyUnlockPercentage` doc comment in
 * `src/lib/queries/rewards.ts`). Renders whole percents as-is ("2%") and
 * only shows decimals when the fraction doesn't land on a whole percent
 * (avoids floating-point tails like "2.0000000001%").
 */
function formatReunlockPct(pct: number | null): string {
  const value = pct ?? 0.01;
  const asPercent = value * 100;
  const rounded = Math.round(asPercent * 100) / 100; // guard fp noise
  const decimals = Number.isInteger(rounded) ? 0 : 2;
  return `${rounded.toFixed(decimals)}%`;
}

function LevelUpMobileCard({ r }: { r: RewardItem }) {
  return (
    <div className="border-b border-border/60 last:border-b-0 px-3 py-3">
      <div className="flex items-start gap-3">
        <div className="flex size-9 items-center justify-center rounded-md bg-rose-500/10 shrink-0">
          <TrendingUp className="size-4 text-rose-500" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <Badge variant="outline" className="h-4 px-1 text-[9px]">
              Lv {r.levelRequired}
            </Badge>
            <span className="text-sm font-medium truncate">{r.name}</span>
            <Badge variant="outline" className="h-4 px-1 text-[9px] capitalize">
              {r.type.replace("_", " ")}
            </Badge>
          </div>
          {r.packs.length > 0 && (
            <div className="mt-1.5 space-y-0.5">
              {r.packs.map((p) => (
                <div
                  key={p.id}
                  className="flex items-center gap-1.5 text-[10px] text-muted-foreground"
                >
                  {p.imageUrl && (
                    // eslint-disable-next-line @next/next/no-img-element
                    <img
                      src={p.imageUrl}
                      alt=""
                      className="size-3.5 rounded object-contain"
                    />
                  )}
                  <span className="truncate">{p.name}</span>
                  <span className="text-[9px]">{formatCurrency(p.priceUsd)}</span>
                </div>
              ))}
            </div>
          )}
          <div className="mt-1 flex items-center gap-1.5 text-[10px] text-muted-foreground">
            <span>{formatRelative(r.createdAt)}</span>
            <span aria-hidden="true">&middot;</span>
            <span>
              Re-unlock:{" "}
              <span className="tabular-nums">{formatReunlockPct(r.dailyUnlockPercentage)}</span>
            </span>
          </div>
        </div>
        <div className="shrink-0 text-right space-y-1">
          {r.cashAmount != null && (
            <div className="text-sm font-medium tabular-nums text-rose-600 dark:text-rose-400">
              {formatCurrency(r.cashAmount)}
            </div>
          )}
          <div className="flex justify-end gap-1">
            <EditRewardButton reward={r} />
            <DeleteRewardButton rewardId={r.id} />
          </div>
        </div>
      </div>
    </div>
  );
}

export function LevelUpTable({ data }: { data: RewardItem[] }) {
  return (
    <>
      {/* Mobile card list (<lg) */}
      <div className="lg:hidden">
        {data.length === 0 ? (
          <div className="rounded-md border">
            <EmptyState
              icon={TrendingUp}
              title="No level-up rewards found"
              description="Add a level-up reward to grant cash or packs when players reach a level."
              compact
            />
          </div>
        ) : (
          <div className="overflow-hidden rounded-md border">
            {data.map((r) => (
              <LevelUpMobileCard key={r.id} r={r} />
            ))}
          </div>
        )}
      </div>

      {/* Desktop table (>=lg) */}
      <div className="hidden rounded-md border overflow-x-auto lg:block">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Level</TableHead>
              <TableHead>Name</TableHead>
              <TableHead>Type</TableHead>
              <TableHead>Cash Amount</TableHead>
              <TableHead>Re-unlock</TableHead>
              <TableHead>Packs</TableHead>
              <TableHead>Created</TableHead>
              <TableHead className="w-[80px]" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.map((r) => (
              <TableRow key={r.id}>
                <TableCell>
                  <Badge variant="outline">Lv. {r.levelRequired}</Badge>
                </TableCell>
                <TableCell className="font-medium">{r.name}</TableCell>
                <TableCell>
                  <Badge variant="outline" className="capitalize">
                    {r.type.replace("_", " ")}
                  </Badge>
                </TableCell>
                <TableCell>
                  {r.cashAmount != null ? formatCurrency(r.cashAmount) : "—"}
                </TableCell>
                <TableCell className="tabular-nums">
                  {formatReunlockPct(r.dailyUnlockPercentage)}
                </TableCell>
                <TableCell>
                  {r.packs.length > 0 ? (
                    <div className="flex flex-col gap-1">
                      {r.packs.map((p) => (
                        <div key={p.id} className="flex items-center gap-1.5">
                          {p.imageUrl && (
                            // eslint-disable-next-line @next/next/no-img-element
                            <img
                              src={p.imageUrl}
                              alt=""
                              className="size-5 rounded object-contain"
                            />
                          )}
                          <span className="text-xs">{p.name}</span>
                          <span className="text-xs text-muted-foreground">
                            {formatCurrency(p.priceUsd)}
                          </span>
                        </div>
                      ))}
                    </div>
                  ) : (
                    <span className="text-muted-foreground">—</span>
                  )}
                </TableCell>
                <TableCell>{formatDateTime(r.createdAt)}</TableCell>
                <TableCell>
                  <div className="flex items-center gap-1">
                    <EditRewardButton reward={r} />
                    <DeleteRewardButton rewardId={r.id} />
                  </div>
                </TableCell>
              </TableRow>
            ))}
            {data.length === 0 && (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={8} className="p-0">
                  <EmptyState
                    icon={TrendingUp}
                    title="No level-up rewards found"
                    description="Add a level-up reward to grant cash or packs when players reach a level."
                    compact
                  />
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </>
  );
}
