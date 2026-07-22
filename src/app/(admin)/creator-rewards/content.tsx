"use client";

import { useMemo, useState, useTransition } from "react";
import { toast } from "sonner";
import {
  BadgeCheck,
  Check,
  Crown,
  Inbox,
  Plus,
  RotateCcw,
  ShieldQuestion,
  X,
} from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { EmptyState } from "@/components/empty-state";
import { SectionHeading } from "@/components/modern-panels";
import { formatCurrency, formatDateTime, formatRelative } from "@/lib/utils/format";
import { cn } from "@/lib/utils";
import type { CreatorRewardProgramWithStats } from "@/lib/creator-vip/types";
import type { CreatorRewardClaimRow } from "@/lib/creator-vip/queries";

import {
  approveCreatorRewardClaim,
  createCreatorRewardProgram,
  previewCreatorRewardEntitlement,
  raiseCreatorRewardClaimForUser,
  reinstateCreatorRewardClaim,
  rejectCreatorRewardClaim,
  searchCreatorsWithCodes,
  setCreatorRewardProgramActive,
} from "./actions";

/**
 * Creator VIP reward programs + the claim review queue.
 *
 * House-POV colouring throughout (CLAUDE.md): a VIP reward is money the house
 * GIVES a user, so every payout figure is ROSE. The wager that earned it is
 * money the user LOST to us, so it reads EMERALD. Pending review is neutral.
 */

type SubTab = "programs" | "requests";

export function CreatorVipContent({
  programs,
  claims,
}: {
  programs: CreatorRewardProgramWithStats[];
  claims: CreatorRewardClaimRow[];
}) {
  const pending = useMemo(
    () => claims.filter((c) => c.status === "pending"),
    [claims],
  );
  // Land on whichever side needs attention — an operator opening this tab with
  // claims waiting almost certainly came to review them, not to read config.
  const [subTab, setSubTab] = useState<SubTab>(
    pending.length > 0 ? "requests" : "programs",
  );

  return (
    <div className="space-y-4">
      <div className="inline-flex gap-1 rounded-lg bg-muted p-1">
        <button
          type="button"
          onClick={() => setSubTab("programs")}
          className={cn(
            "inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
            subTab === "programs"
              ? "bg-background text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          <Crown className="size-4" aria-hidden />
          Programs
          <span className="tabular-nums text-xs text-muted-foreground">
            {programs.length}
          </span>
        </button>
        <button
          type="button"
          onClick={() => setSubTab("requests")}
          className={cn(
            "inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm font-medium transition-colors",
            subTab === "requests"
              ? "bg-background text-foreground shadow-sm"
              : "text-muted-foreground hover:text-foreground",
          )}
        >
          <Inbox className="size-4" aria-hidden />
          Requests
          {pending.length > 0 && (
            <Badge
              variant="outline"
              className="bg-amber-500/15 text-[10px] text-amber-600 dark:text-amber-400"
            >
              {pending.length}
            </Badge>
          )}
        </button>
      </div>

      {subTab === "programs" ? (
        <ProgramsPanel programs={programs} />
      ) : (
        <RequestsPanel claims={claims} />
      )}
    </div>
  );
}

/* ─────────────────────────── Programs ─────────────────────────── */

function ProgramsPanel({
  programs,
}: {
  programs: CreatorRewardProgramWithStats[];
}) {
  const [createOpen, setCreateOpen] = useState(false);

  return (
    <div className="space-y-3">
      <SectionHeading
        icon={Crown}
        title="VIP wager programs"
        action={
          <Button size="sm" onClick={() => setCreateOpen(true)}>
            <Plus className="size-3.5" />
            New program
          </Button>
        }
      />
      <p className="text-sm text-muted-foreground">
        &ldquo;Wager $X under my code, get $Y.&rdquo; Wager is read live from
        the player&apos;s attributed activity; claims are reviewed by staff
        before any balance moves. Only wager booked{" "}
        <strong>after a program is created</strong> counts towards it.
      </p>

      {programs.length === 0 ? (
        <EmptyState
          icon={Crown}
          title="No programs yet"
          description="Create one to let a creator offer wager milestones to their referrals."
        />
      ) : (
        <div className="space-y-2">
          {programs.map((p) => (
            <ProgramRow key={p.id} program={p} />
          ))}
        </div>
      )}

      <CreateProgramDialog open={createOpen} onOpenChange={setCreateOpen} />
    </div>
  );
}

function ProgramRow({ program }: { program: CreatorRewardProgramWithStats }) {
  const [isPending, startTransition] = useTransition();
  const [raiseOpen, setRaiseOpen] = useState(false);

  function toggle(next: boolean) {
    startTransition(async () => {
      const res = await setCreatorRewardProgramActive({
        programId: program.id,
        isActive: next,
      });
      if (!res.success) {
        toast.error(res.error);
        return;
      }
      toast.success(next ? "Program activated" : "Program paused");
    });
  }

  return (
    <Card>
      <CardContent className="flex flex-wrap items-center gap-x-6 gap-y-3 p-4">
        <div className="min-w-[180px] flex-1">
          <div className="flex items-center gap-2">
            <span className="font-medium">{program.name}</span>
            {!program.isActive && (
              <Badge
                variant="outline"
                className="bg-zinc-500/15 text-[10px] text-zinc-600 dark:text-zinc-400"
              >
                Paused
              </Badge>
            )}
          </div>
          <div className="mt-0.5 text-xs text-muted-foreground">
            {program.creatorUsername ?? program.creatorUserId}
          </div>
        </div>

        <div className="flex flex-wrap gap-1">
          {program.codes.map((c) => (
            <Badge key={c} variant="outline" className="font-mono text-[10px]">
              {c}
            </Badge>
          ))}
        </div>

        <div className="text-sm">
          <span className="text-emerald-600 tabular-nums dark:text-emerald-400">
            {formatCurrency(program.thresholdUsd)}
          </span>
          <span className="mx-1.5 text-muted-foreground">wagered →</span>
          <span className="text-rose-600 tabular-nums dark:text-rose-400">
            {formatCurrency(program.rewardUsd)}
          </span>
          {program.vipRewardUsd != null && (
            <>
              <span className="mx-1.5 text-muted-foreground">· VIP</span>
              <span className="text-rose-600 tabular-nums dark:text-rose-400">
                {formatCurrency(program.vipRewardUsd)}
              </span>
            </>
          )}
        </div>

        <div className="text-xs text-muted-foreground">
          <div>
            Paid out{" "}
            <span className="tabular-nums text-rose-600 dark:text-rose-400">
              {formatCurrency(program.paidOutUsd)}
            </span>{" "}
            over {program.approvedClaims} claim
            {program.approvedClaims === 1 ? "" : "s"}
          </div>
          <div>
            Accrues from {formatDateTime(program.accrualStartAt)}
            {program.maxRewardPerUserUsd != null && (
              <> · cap {formatCurrency(program.maxRewardPerUserUsd)}/user</>
            )}
          </div>
        </div>

        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={() => setRaiseOpen(true)}
            disabled={!program.isActive}
          >
            Check a player
          </Button>
          <Switch
            checked={program.isActive}
            onCheckedChange={toggle}
            disabled={isPending}
            aria-label="Program active"
          />
        </div>
      </CardContent>

      <RaiseClaimDialog
        program={program}
        open={raiseOpen}
        onOpenChange={setRaiseOpen}
      />
    </Card>
  );
}

/**
 * Look a player up on this program, see what they'd get, and optionally raise
 * the claim for them — the same server path the Discord bot will use, so the
 * review queue can be exercised before any bot exists.
 */
function RaiseClaimDialog({
  program,
  open,
  onOpenChange,
}: {
  program: CreatorRewardProgramWithStats;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const [query, setQuery] = useState("");
  const [preview, setPreview] = useState<{
    userId: string;
    username: string | null;
    isVip: boolean;
    appliedRewardUsd: number;
    qualifyingWagerUsd: number;
    lifetimeWagerUsd: number;
    forfeitedWagerUsd: number;
    runStartedAt: string;
    availableWagerUsd: number;
    priorConsumedUsd: number;
    units: number;
    amountUsd: number;
    wagerToNextUnitUsd: number;
    blockedReason: string | null;
  } | null>(null);
  const [checking, startCheck] = useTransition();
  const [raising, startRaise] = useTransition();

  function check() {
    startCheck(async () => {
      const res = await previewCreatorRewardEntitlement({
        programId: program.id,
        query: query.trim(),
      });
      if (!res.success) {
        setPreview(null);
        toast.error(res.error);
        return;
      }
      setPreview(res.data);
    });
  }

  function raise() {
    if (!preview) return;
    startRaise(async () => {
      const res = await raiseCreatorRewardClaimForUser({
        programId: program.id,
        userId: preview.userId,
      });
      if (!res.success) {
        toast.error(res.error);
        return;
      }
      toast.success(
        `Claim raised for ${formatCurrency(res.data.amountUsd)} — it's in Requests`,
      );
      setPreview(null);
      setQuery("");
      onOpenChange(false);
    });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) {
          setPreview(null);
          setQuery("");
        }
        onOpenChange(v);
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Check a player</DialogTitle>
          <DialogDescription>
            See what they&apos;ve earned on {program.name}, and raise the claim
            for them if you want.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="flex gap-2">
            <Input
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter") {
                  e.preventDefault();
                  check();
                }
              }}
              placeholder="Username, email or user ID"
              disabled={checking || raising}
            />
            <Button
              variant="outline"
              onClick={check}
              disabled={checking || raising || query.trim() === ""}
            >
              {checking ? "…" : "Check"}
            </Button>
          </div>

          {preview && (
            <div className="space-y-2 rounded-md border p-3 text-sm">
              <div className="flex items-center gap-2">
                <span className="font-medium">
                  {preview.username ?? preview.userId}
                </span>
                {preview.isVip && (
                  <Badge
                    variant="outline"
                    className="bg-purple-500/15 text-[10px] text-purple-600 dark:text-purple-400"
                  >
                    VIP
                  </Badge>
                )}
                <span className="text-xs text-muted-foreground">
                  {formatCurrency(preview.appliedRewardUsd)} per{" "}
                  {formatCurrency(program.thresholdUsd)}
                </span>
              </div>
              <div className="flex justify-between text-xs text-muted-foreground">
                <span>Wagered since {formatDateTime(preview.runStartedAt)}</span>
                <span className="tabular-nums text-emerald-600 dark:text-emerald-400">
                  {formatCurrency(preview.qualifyingWagerUsd)}
                </span>
              </div>
              {preview.forfeitedWagerUsd > 0 && (
                <div className="flex justify-between text-xs text-muted-foreground">
                  <span>Lost to a code switch</span>
                  <span className="tabular-nums">
                    −{formatCurrency(preview.forfeitedWagerUsd)}
                  </span>
                </div>
              )}
              {preview.priorConsumedUsd > 0 && (
                <div className="flex justify-between text-xs text-muted-foreground">
                  <span>Already claimed against</span>
                  <span className="tabular-nums">
                    −{formatCurrency(preview.priorConsumedUsd)}
                  </span>
                </div>
              )}
              <div className="flex justify-between border-t pt-2">
                <span>Claimable now</span>
                <span className="font-semibold tabular-nums text-rose-600 dark:text-rose-400">
                  {formatCurrency(preview.amountUsd)}
                </span>
              </div>
              {preview.blockedReason ? (
                <p className="text-xs text-amber-600 dark:text-amber-400">
                  {preview.blockedReason}
                </p>
              ) : (
                preview.units === 0 && (
                  <p className="text-xs text-muted-foreground">
                    {formatCurrency(preview.wagerToNextUnitUsd)} more wager
                    needed for the next {formatCurrency(program.rewardUsd)}.
                  </p>
                )
              )}
            </div>
          )}
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={raising}
          >
            Close
          </Button>
          <Button
            onClick={raise}
            disabled={raising || !preview || preview.units < 1}
          >
            {raising ? "Raising…" : "Raise claim"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function CreateProgramDialog({
  open,
  onOpenChange,
}: {
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const [name, setName] = useState("");
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<
    { userId: string; username: string | null; codes: string[] }[]
  >([]);
  const [selected, setSelected] = useState<{
    userId: string;
    username: string | null;
    codes: string[];
  } | null>(null);
  const [pickedCodes, setPickedCodes] = useState<string[]>([]);
  const [threshold, setThreshold] = useState("1000");
  const [reward, setReward] = useState("5");
  const [vipReward, setVipReward] = useState("");
  const [cap, setCap] = useState("");
  const [isPending, startTransition] = useTransition();
  const [searching, startSearch] = useTransition();

  const thresholdNum = Number(threshold);
  const rewardNum = Number(reward);
  const vipRewardNum = vipReward.trim() === "" ? null : Number(vipReward);
  const ratesInvalid =
    (Number.isFinite(thresholdNum) &&
      Number.isFinite(rewardNum) &&
      rewardNum >= thresholdNum) ||
    (vipRewardNum != null &&
      (!Number.isFinite(vipRewardNum) ||
        vipRewardNum >= thresholdNum ||
        vipRewardNum < rewardNum));

  function reset() {
    setName("");
    setQuery("");
    setResults([]);
    setSelected(null);
    setPickedCodes([]);
    setThreshold("1000");
    setReward("5");
    setVipReward("");
    setCap("");
  }

  function search() {
    startSearch(async () => {
      try {
        setResults(await searchCreatorsWithCodes(query));
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Search failed");
      }
    });
  }

  function submit() {
    if (!selected) {
      toast.error("Pick a creator");
      return;
    }
    if (pickedCodes.length === 0) {
      toast.error("Pick at least one code");
      return;
    }
    startTransition(async () => {
      const res = await createCreatorRewardProgram({
        name: name.trim(),
        creatorUserId: selected.userId,
        codes: pickedCodes,
        thresholdUsd: thresholdNum,
        rewardUsd: rewardNum,
        vipRewardUsd: vipRewardNum,
        maxRewardPerUserUsd: cap.trim() === "" ? null : Number(cap),
      });
      if (!res.success) {
        toast.error(res.error);
        return;
      }
      toast.success("Program created");
      reset();
      onOpenChange(false);
    });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(v) => {
        if (!v) reset();
        onOpenChange(v);
      }}
    >
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>New VIP wager program</DialogTitle>
          <DialogDescription>
            Accrual starts now — wager booked before this moment never counts.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label className="text-xs">Program name</Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Jimmy VIP wager reward"
              disabled={isPending}
            />
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs">Creator</Label>
            {selected ? (
              <div className="flex items-center justify-between rounded-md border px-3 py-2">
                <span className="text-sm">
                  {selected.username ?? selected.userId}
                </span>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setSelected(null);
                    setPickedCodes([]);
                  }}
                  disabled={isPending}
                >
                  Change
                </Button>
              </div>
            ) : (
              <>
                <div className="flex gap-2">
                  <Input
                    value={query}
                    onChange={(e) => setQuery(e.target.value)}
                    onKeyDown={(e) => {
                      if (e.key === "Enter") {
                        e.preventDefault();
                        search();
                      }
                    }}
                    placeholder="Search creators…"
                    disabled={isPending}
                  />
                  <Button
                    variant="outline"
                    onClick={search}
                    disabled={searching || isPending}
                  >
                    {searching ? "…" : "Search"}
                  </Button>
                </div>
                {results.length > 0 && (
                  <div className="max-h-44 space-y-1 overflow-y-auto rounded-md border p-1">
                    {results.map((r) => (
                      <button
                        key={r.userId}
                        type="button"
                        onClick={() => {
                          setSelected(r);
                          setPickedCodes(r.codes);
                        }}
                        className="flex w-full items-center justify-between rounded px-2 py-1.5 text-left text-sm hover:bg-muted"
                      >
                        <span>{r.username ?? r.userId}</span>
                        <span className="text-xs text-muted-foreground">
                          {r.codes.length} code
                          {r.codes.length === 1 ? "" : "s"}
                        </span>
                      </button>
                    ))}
                  </div>
                )}
              </>
            )}
          </div>

          {selected && (
            <div className="space-y-1.5">
              <Label className="text-xs">
                Codes this program accrues on
              </Label>
              {selected.codes.length === 0 ? (
                <p className="text-sm text-muted-foreground">
                  This creator owns no affiliate codes — nothing to attach.
                </p>
              ) : (
                <div className="flex flex-wrap gap-1.5">
                  {selected.codes.map((c) => {
                    const on = pickedCodes.includes(c);
                    return (
                      <button
                        key={c}
                        type="button"
                        disabled={isPending}
                        onClick={() =>
                          setPickedCodes((prev) =>
                            on ? prev.filter((x) => x !== c) : [...prev, c],
                          )
                        }
                        className={cn(
                          "rounded-md border px-2 py-1 font-mono text-xs transition-colors",
                          on
                            ? "border-primary/40 bg-primary/10 text-foreground"
                            : "text-muted-foreground hover:text-foreground",
                        )}
                      >
                        {c}
                      </button>
                    );
                  })}
                </div>
              )}
            </div>
          )}

          <div className="grid grid-cols-2 gap-3">
            <div className="space-y-1.5">
              <Label className="text-xs">Wager threshold ($)</Label>
              <Input
                type="number"
                min="1"
                value={threshold}
                onChange={(e) => setThreshold(e.target.value)}
                disabled={isPending}
              />
            </div>
            <div className="space-y-1.5">
              <Label className="text-xs">Reward ($)</Label>
              <Input
                type="number"
                min="0.01"
                step="0.01"
                value={reward}
                onChange={(e) => setReward(e.target.value)}
                disabled={isPending}
              />
            </div>
          </div>

          <div className="space-y-1.5">
            <Label className="text-xs">
              VIP reward ($) — optional
            </Label>
            <Input
              type="number"
              min="0.01"
              step="0.01"
              value={vipReward}
              onChange={(e) => setVipReward(e.target.value)}
              placeholder="Same as standard"
              disabled={isPending}
            />
            <p className="text-[11px] text-muted-foreground">
              Paid instead of the standard rate to players carrying the VIP
              tag. Checked live on every claim — losing the tag drops them back
              to the standard rate immediately.
            </p>
          </div>

          {ratesInvalid && (
            <p className="text-sm text-rose-600 dark:text-rose-400">
              Rewards must be smaller than the threshold, and the VIP rate
              can&apos;t be below the standard one.
            </p>
          )}

          <div className="space-y-1.5">
            <Label className="text-xs">
              Lifetime cap per user ($) — optional
            </Label>
            <Input
              type="number"
              min="0"
              value={cap}
              onChange={(e) => setCap(e.target.value)}
              placeholder="No cap"
              disabled={isPending}
            />
          </div>

          {Number.isFinite(thresholdNum) &&
            Number.isFinite(rewardNum) &&
            !ratesInvalid &&
            thresholdNum > 0 && (
              <p className="rounded-md border border-border/60 bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
                Effective rate:{" "}
                <strong className="text-foreground">
                  {((rewardNum / thresholdNum) * 100).toFixed(2)}%
                </strong>{" "}
                of wagered volume.
              </p>
            )}
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isPending}
          >
            Cancel
          </Button>
          <Button
            onClick={submit}
            disabled={isPending || ratesInvalid || !selected}
          >
            {isPending ? "Creating…" : "Create program"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/* ─────────────────────────── Requests ─────────────────────────── */

function RequestsPanel({ claims }: { claims: CreatorRewardClaimRow[] }) {
  const pending = claims.filter((c) => c.status === "pending");
  const reviewed = claims.filter((c) => c.status !== "pending");

  return (
    <div className="space-y-5">
      <div className="space-y-3">
        <SectionHeading icon={Inbox} title="Awaiting review" />
        {pending.length === 0 ? (
          <EmptyState
            icon={BadgeCheck}
            title="Nothing waiting"
            description="Claim requests raised from Discord land here for manual approval."
          />
        ) : (
          <div className="space-y-2">
            {pending.map((c) => (
              <ClaimRow key={c.id} claim={c} />
            ))}
          </div>
        )}
      </div>

      {reviewed.length > 0 && (
        <div className="space-y-3">
          <SectionHeading icon={ShieldQuestion} title="Reviewed" />
          <div className="space-y-2">
            {reviewed.map((c) => (
              <ClaimRow key={c.id} claim={c} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function ClaimRow({ claim }: { claim: CreatorRewardClaimRow }) {
  const [approveOpen, setApproveOpen] = useState(false);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [reopenOpen, setReopenOpen] = useState(false);

  const statusBadge =
    claim.status === "approved" ? (
      <Badge
        variant="outline"
        className="bg-emerald-500/15 text-[10px] text-emerald-600 dark:text-emerald-400"
      >
        Approved
      </Badge>
    ) : claim.status === "rejected" ? (
      <Badge
        variant="outline"
        className="bg-zinc-500/15 text-[10px] text-zinc-600 dark:text-zinc-400"
      >
        Rejected
      </Badge>
    ) : (
      <Badge
        variant="outline"
        className="bg-amber-500/15 text-[10px] text-amber-600 dark:text-amber-400"
      >
        Pending
      </Badge>
    );

  return (
    <Card>
      <CardContent className="flex flex-wrap items-center gap-x-6 gap-y-3 p-4">
        <div className="min-w-[170px] flex-1">
          <div className="flex items-center gap-2">
            <span className="font-medium">
              {claim.username ?? claim.userId}
            </span>
            {claim.wasVip && (
              <Badge
                variant="outline"
                className="bg-purple-500/15 text-[10px] text-purple-600 dark:text-purple-400"
              >
                VIP
              </Badge>
            )}
            {claim.switchedAway === true && (
              <Badge
                variant="outline"
                className="bg-amber-500/15 text-[10px] text-amber-600 dark:text-amber-400"
              >
                Switched code
              </Badge>
            )}
            {claim.reinstatedAt && (
              <Badge
                variant="outline"
                className="bg-sky-500/15 text-[10px] text-sky-600 dark:text-sky-400"
              >
                Reopened
              </Badge>
            )}
            {statusBadge}
          </div>
          <div className="mt-0.5 text-xs text-muted-foreground">
            {claim.programName} · {claim.creatorUsername ?? "creator"} ·{" "}
            {formatRelative(claim.requestedAt)}
          </div>
          {/* A reopened claim is pending again, so the buttons replace the note
              column — surface the original rejection here instead, or the
              second reviewer repeats the first one's work blind. */}
          {claim.status === "pending" &&
            claim.reinstatedAt &&
            claim.reviewNote && (
              <div className="mt-1 text-xs text-sky-600 dark:text-sky-400">
                Previously rejected: &ldquo;{claim.reviewNote}&rdquo;
              </div>
            )}
        </div>

        <div className="text-xs text-muted-foreground">
          <div>
            Wagered{" "}
            <span className="tabular-nums text-emerald-600 dark:text-emerald-400">
              {formatCurrency(claim.wagerBasisUsd)}
            </span>
            {claim.priorConsumedUsd > 0 && (
              <> · {formatCurrency(claim.priorConsumedUsd)} already used</>
            )}
            {claim.forfeitedWagerUsd > 0 && (
              <>
                {" "}
                · {formatCurrency(claim.forfeitedWagerUsd)} lost to a code
                switch
              </>
            )}
          </div>
          <div>
            Consumes{" "}
            <span className="tabular-nums">
              {formatCurrency(claim.consumedWagerUsd)}
            </span>{" "}
            for {claim.units} unit{claim.units === 1 ? "" : "s"} @{" "}
            {formatCurrency(claim.appliedRewardUsd)}
          </div>
        </div>

        <div className="text-right">
          <div className="text-lg font-semibold tabular-nums text-rose-600 dark:text-rose-400">
            {formatCurrency(claim.amountUsd)}
          </div>
          {claim.reviewerName && (
            <div className="text-[11px] text-muted-foreground">
              by {claim.reviewerName}
            </div>
          )}
        </div>

        {claim.status === "pending" ? (
          <div className="flex gap-2">
            <Button size="sm" onClick={() => setApproveOpen(true)}>
              <Check className="size-3.5" />
              Approve
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setRejectOpen(true)}
            >
              <X className="size-3.5" />
              Reject
            </Button>
          </div>
        ) : (
          <div className="flex items-center gap-3">
            {claim.reviewNote && (
              <div className="max-w-[220px] text-xs text-muted-foreground">
                &ldquo;{claim.reviewNote}&rdquo;
              </div>
            )}
            {claim.status === "rejected" && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => setReopenOpen(true)}
              >
                <RotateCcw className="size-3.5" />
                Reopen
              </Button>
            )}
          </div>
        )}
      </CardContent>

      <ApproveDialog
        claim={claim}
        open={approveOpen}
        onOpenChange={setApproveOpen}
      />
      <RejectDialog
        claim={claim}
        open={rejectOpen}
        onOpenChange={setRejectOpen}
      />
      <ReopenDialog
        claim={claim}
        open={reopenOpen}
        onOpenChange={setReopenOpen}
      />
    </Card>
  );
}

/** Undo for a wrongly-rejected claim: puts it back in the review queue. */
function ReopenDialog({
  claim,
  open,
  onOpenChange,
}: {
  claim: CreatorRewardClaimRow;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const [note, setNote] = useState("");
  const [isPending, startTransition] = useTransition();

  function submit() {
    startTransition(async () => {
      const res = await reinstateCreatorRewardClaim({
        claimId: claim.id,
        note: note.trim(),
      });
      if (!res.success) {
        toast.error(res.error);
        return;
      }
      toast.success("Back in the review queue");
      setNote("");
      onOpenChange(false);
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Reopen this claim</DialogTitle>
          <DialogDescription>
            Puts it back in the queue for {formatCurrency(claim.amountUsd)} and
            re-reserves the {formatCurrency(claim.consumedWagerUsd)} of wager it
            was based on. Nothing is paid until someone approves it.
          </DialogDescription>
        </DialogHeader>

        {claim.reviewNote && (
          <div className="rounded-md border border-border/60 bg-muted/30 px-3 py-2 text-xs text-muted-foreground">
            Rejected because: &ldquo;{claim.reviewNote}&rdquo;
          </div>
        )}

        <div className="space-y-1.5">
          <Label className="text-xs">Why reopen it? (required)</Label>
          <Textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={3}
            placeholder="e.g. rejected by mistake — wrong row"
            disabled={isPending}
          />
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isPending}
          >
            Cancel
          </Button>
          <Button onClick={submit} disabled={isPending || note.trim().length < 3}>
            {isPending ? "Reopening…" : "Reopen"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function ApproveDialog({
  claim,
  open,
  onOpenChange,
}: {
  claim: CreatorRewardClaimRow;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const [totp, setTotp] = useState("");
  const [note, setNote] = useState("");
  const [isPending, startTransition] = useTransition();

  function submit() {
    startTransition(async () => {
      const res = await approveCreatorRewardClaim({
        claimId: claim.id,
        totpCode: totp.trim(),
        note: note.trim() || undefined,
      });
      if (!res.success) {
        toast.error(res.error);
        return;
      }
      toast.success(`Paid ${formatCurrency(claim.amountUsd)}`);
      setTotp("");
      setNote("");
      onOpenChange(false);
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Approve and pay</DialogTitle>
          <DialogDescription>
            Credits{" "}
            <strong className="text-rose-600 dark:text-rose-400">
              {formatCurrency(claim.amountUsd)}
            </strong>{" "}
            to {claim.username ?? claim.userId} and permanently consumes{" "}
            {formatCurrency(claim.consumedWagerUsd)} of their wager under{" "}
            {claim.programName}.
          </DialogDescription>
        </DialogHeader>

        {claim.switchedAway === true && (
          <div className="rounded-md border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-600 dark:text-amber-400">
            This player has since switched to another creator&apos;s code. They
            earned this before leaving, so it&apos;s still payable — but they
            can&apos;t claim here again unless they come back.
          </div>
        )}

        <div className="space-y-3">
          <div className="space-y-1.5">
            <Label className="text-xs">Note (optional)</Label>
            <Textarea
              value={note}
              onChange={(e) => setNote(e.target.value)}
              rows={2}
              disabled={isPending}
            />
          </div>
          <div className="space-y-1.5">
            <Label className="text-xs">2FA code</Label>
            <Input
              value={totp}
              onChange={(e) => setTotp(e.target.value)}
              placeholder="123456"
              inputMode="numeric"
              autoComplete="one-time-code"
              disabled={isPending}
            />
          </div>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isPending}
          >
            Cancel
          </Button>
          <Button onClick={submit} disabled={isPending || totp.trim().length < 6}>
            {isPending ? "Paying…" : "Approve and pay"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function RejectDialog({
  claim,
  open,
  onOpenChange,
}: {
  claim: CreatorRewardClaimRow;
  open: boolean;
  onOpenChange: (v: boolean) => void;
}) {
  const [note, setNote] = useState("");
  const [isPending, startTransition] = useTransition();

  function submit() {
    startTransition(async () => {
      const res = await rejectCreatorRewardClaim({
        claimId: claim.id,
        note: note.trim(),
      });
      if (!res.success) {
        toast.error(res.error);
        return;
      }
      toast.success("Claim rejected — wager released");
      setNote("");
      onOpenChange(false);
    });
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>Reject claim</DialogTitle>
          <DialogDescription>
            No balance moves. The {formatCurrency(claim.consumedWagerUsd)} this
            claim reserved is released, so the user can claim it again later.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-1.5">
          <Label className="text-xs">Reason (required)</Label>
          <Textarea
            value={note}
            onChange={(e) => setNote(e.target.value)}
            rows={3}
            placeholder="Why is this being rejected?"
            disabled={isPending}
          />
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isPending}
          >
            Cancel
          </Button>
          <Button
            variant="destructive"
            onClick={submit}
            disabled={isPending || note.trim().length < 3}
          >
            {isPending ? "Rejecting…" : "Reject"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
