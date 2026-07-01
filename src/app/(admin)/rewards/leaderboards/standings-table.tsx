"use client";

import { useEffect, useState, useTransition } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { Trophy, Lock, LockOpen } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { formatCurrency } from "@/lib/utils/format";
import { EmptyState } from "@/components/empty-state";
import { freezeUserRaceClaim, unfreezeUserRaceClaim } from "./actions";
import {
  isRacePrizeClaimExpired,
  type RaceClaimWindow,
} from "@/lib/reward-expiry/race-claim-window";

type HoldInfo = {
  id: string;
  reason: string;
  createdBy: string;
  createdAt: string;
};

type Standing = {
  id: string;
  position: number;
  userId: string;
  username: string | null;
  wageredUsd: number;
  prizeAmountUsd: number | null;
  hold: HoldInfo | null;
  claimedAt: string | null;
};

function PrizeCell({ amount }: { amount: number | null }) {
  if (amount == null) {
    return <span className="text-muted-foreground">—</span>;
  }
  return (
    <span className="tabular-nums text-rose-600 dark:text-rose-400">
      {formatCurrency(amount)}
    </span>
  );
}

const POSITION_COLORS: Record<number, string> = {
  1: "bg-yellow-500/15 text-yellow-600 dark:text-yellow-400 border-yellow-500/30",
  2: "bg-zinc-400/15 text-zinc-500 dark:text-zinc-400 border-zinc-400/30",
  3: "bg-amber-700/15 text-amber-700 dark:text-amber-500 border-amber-700/30",
};

// The claim-review state shown per row. Only the period-specific leaderboard
// (not the all-time view) carries holds/claims, so reviewable gates the
// Status/Action columns entirely.
function StatusBadge({
  s,
  claimWindow,
}: {
  s: Standing;
  claimWindow?: RaceClaimWindow | null;
}) {
  if (s.claimedAt) {
    return (
      <Badge variant="outline" className="text-muted-foreground">
        Claimed
      </Badge>
    );
  }
  if (s.hold) {
    return (
      <Badge
        variant="outline"
        className="gap-1 border-amber-500/40 text-amber-600 dark:text-amber-400"
        title={`Reason: ${s.hold.reason}`}
      >
        <Lock className="size-3" />
        On hold
      </Badge>
    );
  }
  if (
    claimWindow &&
    s.prizeAmountUsd != null &&
    s.prizeAmountUsd > 0 &&
    isRacePrizeClaimExpired(claimWindow, s.claimedAt)
  ) {
    return (
      <Badge
        variant="outline"
        className="border-red-500/40 text-red-600 dark:text-red-400"
      >
        Expired
      </Badge>
    );
  }
  return <span className="text-xs text-muted-foreground">—</span>;
}

export function StandingsTable({
  data,
  raceType,
  periodStart,
  claimWindow,
}: {
  data: Standing[];
  raceType: string;
  periodStart?: string;
  claimWindow?: RaceClaimWindow | null;
}) {
  const [isPending, startTransition] = useTransition();

  // Optimistic in-place mirror of the standings. Freezing/opening a claim flips
  // the row's `hold` locally the instant the admin acts — no router.refresh(),
  // so the page never re-renders and scroll position is preserved. The server
  // action still revalidates /rewards server-side (the underlying standings
  // read is uncached, so there is no cache tag to bust); when a genuine
  // revalidation streams fresh props in we re-sync below, but never mid-flight
  // so an in-progress optimistic change is not clobbered by a stale prop.
  const [rows, setRows] = useState<Standing[]>(data);
  useEffect(() => {
    if (isPending) return;
    setRows(data);
  }, [data, isPending]);

  // Holds are per (user, period). The all-time view has no single period, so
  // claim review is disabled there.
  const reviewable = raceType !== "all" && !!periodStart;
  const showPrizes = raceType !== "all";

  // Freeze dialog state — a single shared dialog targeting one row at a time.
  const [freezeTarget, setFreezeTarget] = useState<Standing | null>(null);
  const [reason, setReason] = useState("");

  function openFreeze(s: Standing) {
    setReason("");
    setFreezeTarget(s);
  }

  function submitFreeze() {
    if (!freezeTarget || !periodStart) return;
    if (!reason.trim()) {
      toast.error("A reason is required");
      return;
    }
    const target = freezeTarget;
    const trimmedReason = reason.trim();
    const prevHold = target.hold;
    // Optimistic hold — mark the row on-hold in place immediately. A temporary
    // id/timestamp stands in until the next revalidation reconciles the real
    // hold row; only `reason` is surfaced (the on-hold badge tooltip).
    const optimisticHold: HoldInfo = {
      id:
        typeof crypto !== "undefined" && "randomUUID" in crypto
          ? crypto.randomUUID()
          : `tmp-hold-${target.id}`,
      reason: trimmedReason,
      createdBy: "",
      createdAt: new Date().toISOString(),
    };
    setRows((rs) =>
      rs.map((r) => (r.id === target.id ? { ...r, hold: optimisticHold } : r)),
    );
    setFreezeTarget(null);
    startTransition(async () => {
      try {
        await freezeUserRaceClaim({
          userId: target.userId,
          raceType,
          periodStart,
          reason: trimmedReason,
        });
        toast.success("Claim frozen");
      } catch (e) {
        // Roll back to the prior hold state.
        setRows((rs) =>
          rs.map((r) => (r.id === target.id ? { ...r, hold: prevHold } : r)),
        );
        toast.error(e instanceof Error ? e.message : "Failed to freeze claim");
      }
    });
  }

  function handleUnfreeze(s: Standing) {
    if (!periodStart) return;
    if (
      !confirm(
        `Open ${s.username ?? s.userId.slice(0, 8)}'s claim? They will be able to claim this period's prize again.`,
      )
    ) {
      return;
    }
    const prevHold = s.hold;
    // Optimistic open — clear the hold in place immediately.
    setRows((rs) =>
      rs.map((r) => (r.id === s.id ? { ...r, hold: null } : r)),
    );
    startTransition(async () => {
      try {
        await unfreezeUserRaceClaim({
          userId: s.userId,
          raceType,
          periodStart,
        });
        toast.success("Claim opened");
      } catch (e) {
        // Restore the hold on failure.
        setRows((rs) =>
          rs.map((r) => (r.id === s.id ? { ...r, hold: prevHold } : r)),
        );
        toast.error(e instanceof Error ? e.message : "Failed to open claim");
      }
    });
  }

  function ActionButton({ s }: { s: Standing }) {
    if (!reviewable) return null;
    if (s.claimedAt) {
      return <span className="text-xs text-muted-foreground">Paid</span>;
    }
    if (s.hold) {
      return (
        <Button
          size="sm"
          variant="ghost"
          disabled={isPending}
          onClick={() => handleUnfreeze(s)}
          className="h-7 text-muted-foreground hover:text-emerald-600"
        >
          <LockOpen className="mr-1 size-3" />
          Open
        </Button>
      );
    }
    return (
      <Button
        size="sm"
        variant="ghost"
        disabled={isPending}
        onClick={() => openFreeze(s)}
        className="h-7 text-muted-foreground hover:text-amber-600"
      >
        <Lock className="mr-1 size-3" />
        Freeze
      </Button>
    );
  }

  const colCount = (showPrizes ? 1 : 0) + (reviewable ? 5 : 3);

  return (
    <>
      {/* Mobile card list (<lg) */}
      <div className="lg:hidden">
        {rows.length === 0 ? (
          <div className="rounded-md border">
            <EmptyState
              icon={Trophy}
              title="No leaderboard data"
              description="Standings populate as players wager during this race period."
              compact
            />
          </div>
        ) : (
          <div className="overflow-hidden rounded-md border">
            {rows.map((s) => {
              const positionColor =
                POSITION_COLORS[s.position] ??
                "bg-muted text-muted-foreground border-border";
              return (
                <div
                  key={s.id}
                  className="flex items-center gap-3 border-b border-border/60 last:border-b-0 px-3 py-3 hover:bg-muted/40 transition-colors"
                >
                  <div
                    className={
                      "flex size-9 shrink-0 items-center justify-center rounded-md text-xs font-semibold tabular-nums " +
                      positionColor
                    }
                  >
                    {s.position <= 3 ? (
                      <Trophy className="size-4" />
                    ) : (
                      `#${s.position}`
                    )}
                  </div>
                  <div className="min-w-0 flex-1">
                    <Link
                      href={`/users/${s.userId}`}
                      className="block text-sm font-medium hover:underline truncate"
                    >
                      {s.username ?? s.userId.slice(0, 8)}
                    </Link>
                    {reviewable && (s.claimedAt || s.hold || claimWindow) && (
                      <div className="mt-0.5">
                        <StatusBadge s={s} claimWindow={claimWindow} />
                      </div>
                    )}
                  </div>
                  <div className="shrink-0 text-right space-y-0.5">
                    {showPrizes && (
                      <div className="text-sm font-medium">
                        <PrizeCell amount={s.prizeAmountUsd} />
                      </div>
                    )}
                    <div className="text-sm font-medium tabular-nums">
                      {formatCurrency(s.wageredUsd)}
                    </div>
                    <div className="mt-0.5">
                      <ActionButton s={s} />
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      {/* Desktop table (>=lg) */}
      <div className="hidden rounded-md border overflow-x-auto lg:block">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Position</TableHead>
              <TableHead>User</TableHead>
              <TableHead>Wagered</TableHead>
              {showPrizes && <TableHead>Prize</TableHead>}
              {reviewable && <TableHead>Claim</TableHead>}
              {reviewable && <TableHead className="w-[120px]" />}
            </TableRow>
          </TableHeader>
          <TableBody>
            {rows.map((e) => (
              <TableRow key={e.id}>
                <TableCell>
                  <Badge variant="outline">#{e.position}</Badge>
                </TableCell>
                <TableCell>
                  <Link
                    href={`/users/${e.userId}`}
                    className="hover:underline"
                  >
                    {e.username ?? e.userId.slice(0, 8)}
                  </Link>
                </TableCell>
                <TableCell>{formatCurrency(e.wageredUsd)}</TableCell>
                {showPrizes && (
                  <TableCell>
                    <PrizeCell amount={e.prizeAmountUsd} />
                  </TableCell>
                )}
                {reviewable && (
                  <TableCell>
                    <StatusBadge s={e} claimWindow={claimWindow} />
                  </TableCell>
                )}
                {reviewable && (
                  <TableCell>
                    <ActionButton s={e} />
                  </TableCell>
                )}
              </TableRow>
            ))}
            {rows.length === 0 && (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={colCount} className="p-0">
                  <EmptyState
                    icon={Trophy}
                    title="No leaderboard data"
                    description="Standings populate as players wager during this race period."
                    compact
                  />
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>

      <Dialog
        open={freezeTarget !== null}
        onOpenChange={(open) => {
          if (!open) setFreezeTarget(null);
        }}
      >
        <DialogContent>
          <DialogHeader>
            <DialogTitle>Freeze claim</DialogTitle>
            <DialogDescription>
              Block{" "}
              <span className="font-medium text-foreground">
                {freezeTarget?.username ??
                  freezeTarget?.userId.slice(0, 8) ??
                  ""}
              </span>{" "}
              from claiming this {raceType} period&apos;s prize while a
              wager-abuse review runs. The hold is logged with your reason and
              can be opened again at any time.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-2">
            <label className="text-sm font-medium" htmlFor="freeze-reason">
              Reason
            </label>
            <Textarea
              id="freeze-reason"
              value={reason}
              onChange={(ev) => setReason(ev.target.value)}
              placeholder="e.g. Suspected wager manipulation — pending review of session logs"
              maxLength={500}
              rows={3}
              disabled={isPending}
            />
          </div>
          <DialogFooter>
            <Button
              variant="outline"
              onClick={() => setFreezeTarget(null)}
              disabled={isPending}
            >
              Cancel
            </Button>
            <Button onClick={submitFreeze} disabled={isPending}>
              <Lock className="mr-1 size-3" />
              Freeze claim
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
