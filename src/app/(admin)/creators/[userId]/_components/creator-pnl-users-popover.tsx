"use client";

import Link from "next/link";
import { AlertTriangle, Users } from "lucide-react";

import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { formatCurrency, formatNumber } from "@/lib/utils/format";
import { cn } from "@/lib/utils";
import type { CreatorPnlPeriodUser } from "@/lib/queries/creators-types";

type Props = {
  users: CreatorPnlPeriodUser[];
  periodLabel: string;
};

/**
 * Hover-triggered popover surfacing per-user contribution to a single
 * PnL period tile. The trigger is a compact `users` chip dropped into
 * the StatPanel `action` slot; hovering it opens the popover with a
 * table of the top contributors (server-sorted by `abs(pnl)` desc,
 * already capped at 50 rows server-side).
 *
 * Hover behaviour: uses Base UI's built-in `openOnHover` /
 * `closeDelay` on the trigger so the popover stays open while the
 * cursor crosses the gap to the popped-out content, instead of
 * flickering open/closed every time the cursor crossed the chip
 * border. `closeDelay=200` gives enough grace for a slow mouse
 * traversal without leaving the popover stuck on after the cursor
 * has left the chip area entirely.
 *
 * Non-depositor users (no acu 'deposit' row under this creator) are
 * surfaced with an amber warning badge — they wagered under this
 * code but never deposited, so their card withdrawals were excluded
 * from the headline P&L. Showing them in the table keeps the audit
 * trail visible while explaining why their cardWD doesn't drag the
 * creator's number down.
 */
export function CreatorPnlUsersPopover({ users, periodLabel }: Props) {
  // Empty state — render a muted chip so the panel layout stays
  // consistent across periods, but skip the popover entirely.
  if (users.length === 0) {
    return (
      <span
        className="inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[10px] text-muted-foreground/60"
        title="No referred-user activity in this period"
      >
        <Users className="size-3" />
        0
      </span>
    );
  }

  const nonDepositorCount = users.filter((u) => !u.isDepositor).length;

  return (
    <Popover>
      <PopoverTrigger
        openOnHover
        delay={100}
        closeDelay={200}
        className={cn(
          "inline-flex items-center gap-1 rounded-md border border-border/60 bg-background/40 px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground transition-colors",
          "hover:border-foreground/30 hover:text-foreground",
          "focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
        )}
        aria-label={`Show users contributing to ${periodLabel}`}
      >
        <Users className="size-3" />
        {formatNumber(users.length)}
      </PopoverTrigger>
      <PopoverContent
        align="end"
        sideOffset={6}
        className="w-[460px] max-w-[calc(100vw-2rem)] p-0"
      >
        <div className="flex items-center justify-between border-b border-border/60 px-3 py-2">
          <div className="flex items-center gap-2">
            <Users className="size-3.5 text-muted-foreground" />
            <span className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
              {periodLabel} · {users.length} user{users.length === 1 ? "" : "s"}
            </span>
          </div>
          <span className="text-[10px] text-muted-foreground/70">
            sorted by |PnL|
          </span>
        </div>
        {nonDepositorCount > 0 && (
          <div className="flex items-start gap-1.5 border-b border-border/60 bg-amber-500/[0.06] px-3 py-1.5 text-[10px] text-muted-foreground">
            <AlertTriangle className="mt-0.5 size-3 shrink-0 text-amber-500" />
            <span>
              <strong className="text-amber-600 dark:text-amber-400">
                {nonDepositorCount}
              </strong>{" "}
              user{nonDepositorCount === 1 ? "" : "s"} wagered under this code
              without depositing here — their card withdrawals are excluded
              from the P&amp;L formula.
            </span>
          </div>
        )}
        <div className="max-h-[360px] overflow-y-auto">
          <table className="w-full text-xs">
            <thead className="sticky top-0 bg-popover">
              <tr className="border-b border-border/60 text-[10px] uppercase tracking-wider text-muted-foreground">
                <th className="px-3 py-1.5 text-left font-medium">User</th>
                <th className="px-2 py-1.5 text-right font-medium">Dep</th>
                <th className="px-2 py-1.5 text-right font-medium">Wagered</th>
                {/* Card WD column removed — money-out figure not surfaced (owner
                    request). The PnL column still nets it. */}
                <th className="px-3 py-1.5 text-right font-medium">PnL</th>
              </tr>
            </thead>
            <tbody>
              {users.map((u) => {
                const isWin = u.pnl > 0;
                const isLoss = u.pnl < 0;
                const muted = !u.isDepositor;
                return (
                  <tr
                    key={u.userId}
                    className={cn(
                      "border-b border-border/30 last:border-0 hover:bg-muted/40",
                      muted && "bg-amber-500/[0.03]",
                    )}
                  >
                    <td className="px-3 py-1.5">
                      <Link
                        href={`/users/${u.userId}`}
                        className="flex items-center gap-2 hover:underline"
                      >
                        <Avatar className="size-5">
                          {u.image && <AvatarImage src={u.image} alt="" />}
                          <AvatarFallback className="text-[9px]">
                            {(u.username ?? "?").slice(0, 2).toUpperCase()}
                          </AvatarFallback>
                        </Avatar>
                        <span
                          className={cn(
                            "max-w-[120px] truncate font-medium",
                            muted && "text-muted-foreground",
                          )}
                        >
                          {u.username ?? "—"}
                        </span>
                        {muted && (
                          <AlertTriangle
                            className="size-3 shrink-0 text-amber-500"
                            aria-label="No deposit under this code"
                          />
                        )}
                      </Link>
                    </td>
                    <td
                      className={cn(
                        "px-2 py-1.5 text-right tabular-nums",
                        u.deposits > 0
                          ? "text-emerald-600 dark:text-emerald-400"
                          : "text-muted-foreground/60",
                      )}
                    >
                      {u.deposits === 0 ? "—" : formatCurrency(u.deposits)}
                    </td>
                    <td className="px-2 py-1.5 text-right tabular-nums text-muted-foreground">
                      {u.wagered === 0 ? "—" : formatCurrency(u.wagered)}
                    </td>
                    {/* Card WD cell removed — money-out figure not surfaced
                        (owner request). PnL still nets it. */}
                    <td
                      className={cn(
                        "px-3 py-1.5 text-right font-semibold tabular-nums",
                        muted
                          ? "text-muted-foreground/60"
                          : isWin
                            ? "text-emerald-600 dark:text-emerald-400"
                            : isLoss
                              ? "text-rose-600 dark:text-rose-400"
                              : "text-muted-foreground/60",
                      )}
                      title={
                        muted
                          ? "Excluded from P&L — user never deposited under this code"
                          : undefined
                      }
                    >
                      {muted
                        ? "excl"
                        : u.pnl === 0
                          ? "—"
                          : `${isWin ? "+" : ""}${formatCurrency(u.pnl)}`}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </PopoverContent>
    </Popover>
  );
}
