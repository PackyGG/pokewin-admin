"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
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
  hold: HoldInfo | null;
  claimedAt: string | null;
};

const POSITION_COLORS: Record<number, string> = {
  1: "bg-yellow-500/15 text-yellow-600 dark:text-yellow-400 border-yellow-500/30",
  2: "bg-zinc-400/15 text-zinc-500 dark:text-zinc-400 border-zinc-400/30",
  3: "bg-amber-700/15 text-amber-700 dark:text-amber-500 border-amber-700/30",
};

// The claim-review state shown per row. Only the period-specific leaderboard
// (not the all-time view) carries holds/claims, so reviewable gates the
// Status/Action columns entirely.
function StatusBadge({ s }: { s: Standing }) {
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
  return <span className="text-xs text-muted-foreground">—</span>;
}

export function StandingsTable({
  data,
  raceType,
  periodStart,
}: {
  data: Standing[];
  raceType: string;
  periodStart?: string;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  // Holds are per (user, period). The all-time view has no single period, so
  // claim review is disabled there.
  const reviewable = raceType !== "all" && !!periodStart;

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
    startTransition(async () => {
      try {
        await freezeUserRaceClaim({
          userId: target.userId,
          raceType,
          periodStart,
          reason: reason.trim(),
        });
        toast.success("Claim frozen");
        setFreezeTarget(null);
        router.refresh();
      } catch (e) {
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
    startTransition(async () => {
      try {
        await unfreezeUserRaceClaim({
          userId: s.userId,
          raceType,
          periodStart,
        });
        toast.success("Claim opened");
        router.refresh();
      } catch (e) {
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

  const colCount = reviewable ? 5 : 3;

  return (
    <>
      {/* Mobile card list (<lg) */}
      <div className="lg:hidden">
        {data.length === 0 ? (
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
            {data.map((s) => {
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
                    {reviewable && (s.claimedAt || s.hold) && (
                      <div className="mt-0.5">
                        <StatusBadge s={s} />
                      </div>
                    )}
                  </div>
                  <div className="shrink-0 text-right">
                    {/* Wager total ‒ neutral here (it's just a counter, not a P&L). */}
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
              {reviewable && <TableHead>Claim</TableHead>}
              {reviewable && <TableHead className="w-[120px]" />}
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.map((e) => (
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
                {reviewable && (
                  <TableCell>
                    <StatusBadge s={e} />
                  </TableCell>
                )}
                {reviewable && (
                  <TableCell>
                    <ActionButton s={e} />
                  </TableCell>
                )}
              </TableRow>
            ))}
            {data.length === 0 && (
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
