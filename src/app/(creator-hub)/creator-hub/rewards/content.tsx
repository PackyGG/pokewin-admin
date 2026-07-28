"use client";

import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
  type ReactNode,
} from "react";
import Link from "next/link";
import { toast } from "sonner";
import {
  BadgeCheck,
  Check,
  Crown,
  Inbox,
  Plus,
  RotateCcw,
  Send,
  ShieldQuestion,
  X,
} from "lucide-react";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
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
import { StepUpField } from "@/components/step-up-field";
import { formatCurrency, formatDateTime, formatRelative } from "@/lib/utils/format";
import { cn } from "@/lib/utils";
import type { CreatorRewardProgramWithStats } from "@/lib/creator-vip/types";
import type { CreatorRewardClaimRow } from "@/lib/creator-vip/queries";

import type { CreatorSearchResult } from "./actions";
import {
  approveCreatorRewardClaim,
  createCreatorRewardProgram,
  previewCreatorRewardEntitlement,
  raiseCreatorRewardClaimForUser,
  reinstateCreatorRewardClaim,
  resendClaimDecisionNotice,
  testBotWebhookConnection,
  rejectCreatorRewardClaim,
  searchCreatorsWithCodes,
  setCreatorRewardProgramActive,
} from "./actions";

/**
 * Creator Hub VIP reward programs + the claim review queue.
 *
 * House-POV colouring throughout (CLAUDE.md): a VIP reward is money the house
 * GIVES a user, so every payout figure is ROSE. The wager that earned it is
 * money the user LOST to us, so it reads EMERALD. Pending review is neutral.
 */

export type CreatorVipTab = "programs" | "requests";

type SubTab = CreatorVipTab;

export function CreatorVipContent({
  programs,
  claims,
  initialTab,
  creatorHrefBase = "/users",
  userHrefBase = "/users",
  claimsCap,
}: {
  programs: CreatorRewardProgramWithStats[];
  claims: CreatorRewardClaimRow[];
  /**
   * Deep-link override for the initial tab (e.g. driven from `?tab=` by the
   * Creator Hub surface). When absent, the original behavior applies: land on
   * Requests if claims are waiting, otherwise Programs.
   */
  initialTab?: CreatorVipTab;
  /**
   * Base path for links to the CREATOR who owns a program (`{base}/{userId}`).
   * Defaults to the admin `/users` profile; the Creator Hub passes
   * `/creator-hub/creators` so its surface stays self-contained. A string, not
   * a function — both consumers render this from Server Components, and
   * function props don't cross the RSC boundary.
   */
  creatorHrefBase?: string;
  /**
   * Base path for links to the PLAYER a claim belongs to (`{base}/{userId}`).
   * Split from `creatorHrefBase` because claimants are ordinary players, which
   * the Hub has no page for — it keeps the `/users` default there.
   */
  userHrefBase?: string;
  /**
   * The fetch limit the caller used for `claims`. When exactly this many rows
   * came back the list is almost certainly truncated, so the Requests panel
   * says so instead of silently presenting a capped list as complete.
   */
  claimsCap?: number;
}) {
  const pending = useMemo(
    () => claims.filter((c) => c.status === "pending"),
    [claims],
  );
  // Land on whichever side needs attention — an operator opening this tab with
  // claims waiting almost certainly came to review them, not to read config.
  const [subTab, setSubTab] = useState<SubTab>(
    initialTab ?? (pending.length > 0 ? "requests" : "programs"),
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
        <ProgramsPanel programs={programs} creatorHrefBase={creatorHrefBase} />
      ) : (
        <RequestsPanel
          claims={claims}
          userHrefBase={userHrefBase}
          claimsCap={claimsCap}
        />
      )}
    </div>
  );
}

/* ─────────────────────────── Programs ─────────────────────────── */

/**
 * One-line description of a program's terms. The two reward types have nothing
 * in common numerically, so each gets its own sentence rather than a shared
 * template with half the fields blank.
 *
 * House-POV colours: the wager the player risks is EMERALD (money we take),
 * the reward we pay out is ROSE (money we owe).
 */
function describeTerms(program: CreatorRewardProgramWithStats) {
  const hasWager = program.thresholdUsd != null && program.rewardUsd != null;
  const hasLossback =
    program.lossbackPct != null && program.minDepositUsd != null;

  return (
    <div className="space-y-0.5">
      {hasWager && (
        <div>
          <span className="text-emerald-600 tabular-nums dark:text-emerald-400">
            {formatCurrency(program.thresholdUsd ?? 0)}
          </span>
          <span className="mx-1.5 text-muted-foreground">wagered →</span>
          <span className="text-rose-600 tabular-nums dark:text-rose-400">
            {formatCurrency(program.rewardUsd ?? 0)}
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
      )}
      {hasLossback && (
        <div>
          <span className="text-rose-600 tabular-nums dark:text-rose-400">
            {program.lossbackPct}%
          </span>
          <span className="mx-1.5 text-muted-foreground">
            back on a lost first deposit ≥
          </span>
          <span className="text-emerald-600 tabular-nums dark:text-emerald-400">
            {formatCurrency(program.minDepositUsd ?? 0)}
          </span>
        </div>
      )}
      {!hasWager && !hasLossback && (
        <span className="text-muted-foreground">No rewards configured</span>
      )}
    </div>
  );
}

function ProgramsPanel({
  programs,
  creatorHrefBase,
}: {
  programs: CreatorRewardProgramWithStats[];
  creatorHrefBase: string;
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
            <ProgramRow
              key={p.id}
              program={p}
              creatorHrefBase={creatorHrefBase}
            />
          ))}
        </div>
      )}

      <CreateProgramDialog open={createOpen} onOpenChange={setCreateOpen} />
    </div>
  );
}

function ProgramRow({
  program,
  creatorHrefBase,
}: {
  program: CreatorRewardProgramWithStats;
  creatorHrefBase: string;
}) {
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
        {/* Identity block — avatar + who the program belongs to, on the same
            baseline as the program name. A program is an agreement with a
            person, and this card is where someone decides to pause or pay
            one, so the creator reads as a person rather than a username in
            small grey text. Fixed avatar size + `items-center` keeps every
            card's first line aligned no matter how long a name runs. */}
        <div className="flex min-w-[240px] flex-1 items-center gap-3">
          <Avatar className="size-10 shrink-0">
            {program.creatorImage && (
              <AvatarImage src={program.creatorImage} alt="" />
            )}
            <AvatarFallback className="text-xs">
              {(program.creatorUsername ?? program.creatorUserId)
                .slice(0, 2)
                .toUpperCase()}
            </AvatarFallback>
          </Avatar>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="truncate font-medium">{program.name}</span>
              {!program.isActive && (
                <Badge
                  variant="outline"
                  className="bg-zinc-500/15 text-[10px] text-zinc-600 dark:text-zinc-400"
                >
                  Paused
                </Badge>
              )}
              {program.creatorIsBanned && (
                <Badge
                  variant="outline"
                  className="border-rose-500/30 bg-rose-500/15 text-[10px] text-rose-600 dark:text-rose-400"
                  title="This creator's account is banned — the program is still accruing."
                >
                  Creator banned
                </Badge>
              )}
            </div>
            <div className="mt-0.5 flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground">
              <Link
                href={`${creatorHrefBase}/${program.creatorUserId}`}
                className="truncate hover:text-foreground hover:underline"
                title={`Open ${program.creatorUsername ?? program.creatorUserId}`}
              >
                {program.creatorUsername ?? program.creatorUserId}
              </Link>
              {program.creatorCountryCode && (
                <span className="shrink-0 text-muted-foreground/70">
                  · {program.creatorCountryCode}
                </span>
              )}
            </div>
          </div>
        </div>

        <div className="flex flex-wrap gap-1">
          {program.codes.map((c) => (
            <Badge key={c} variant="outline" className="font-mono text-[10px]">
              {c}
            </Badge>
          ))}
        </div>

<div className="text-sm">{describeTerms(program)}</div>

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
    leg: "wager" | "ftd_lossback";
    ftdLostUsd: number | null;
    ftdDepositUsd: number | null;
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
        // The preview already resolved WHICH leg has something payable, so
        // the claim is filed against that same leg — no second guess.
        leg: preview.leg,
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
                {preview.leg === "wager" && program.thresholdUsd != null && (
                  <span className="text-xs text-muted-foreground">
                    {formatCurrency(preview.appliedRewardUsd)} per{" "}
                    {formatCurrency(program.thresholdUsd)}
                  </span>
                )}
              </div>
              {preview.leg === "ftd_lossback" ? (
                <>
                  <div className="flex justify-between text-xs text-muted-foreground">
                    <span>First deposit</span>
                    <span className="tabular-nums text-emerald-600 dark:text-emerald-400">
                      {formatCurrency(preview.ftdDepositUsd ?? 0)}
                    </span>
                  </div>
                  <div className="flex justify-between text-xs text-muted-foreground">
                    <span>Lost so far</span>
                    <span className="tabular-nums">
                      {formatCurrency(preview.ftdLostUsd ?? 0)}
                    </span>
                  </div>
                </>
              ) : (
              <div className="flex justify-between text-xs text-muted-foreground">
                <span>Wagered since {formatDateTime(preview.runStartedAt)}</span>
                <span className="tabular-nums text-emerald-600 dark:text-emerald-400">
                  {formatCurrency(preview.qualifyingWagerUsd)}
                </span>
              </div>
              )}
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
                preview.units === 0 &&
                preview.leg === "wager" &&
                program.rewardUsd != null && (
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
  const [results, setResults] = useState<CreatorSearchResult[]>([]);
  /**
   * True once a search has actually answered, so the "nothing matched" line
   * only shows after a real round-trip — not in the blank moment before the
   * first one lands.
   */
  const [searched, setSearched] = useState(false);
  const [selected, setSelected] = useState<CreatorSearchResult | null>(null);
  const [pickedCodes, setPickedCodes] = useState<string[]>([]);
  // Both legs can run at once — creators hand them out together.
  const [wagerOn, setWagerOn] = useState(true);
  const [lossbackOn, setLossbackOn] = useState(true);
  const [threshold, setThreshold] = useState("1000");
  const [reward, setReward] = useState("5");
  const [vipReward, setVipReward] = useState("");
  const [lossbackPct, setLossbackPct] = useState("5");
  const [minDeposit, setMinDeposit] = useState("50");
  const [cap, setCap] = useState("");
  const [isPending, startTransition] = useTransition();
  const [searching, startSearch] = useTransition();

  const thresholdNum = Number(threshold);
  const rewardNum = Number(reward);
  const vipRewardNum = vipReward.trim() === "" ? null : Number(vipReward);
  const lossbackPctNum = Number(lossbackPct);
  const minDepositNum = Number(minDeposit);

  // Mirrors validateTerms() on the server. The server stays authoritative;
  // this only stops the operator submitting what it would refuse.
  const wagerInvalid =
    wagerOn &&
    ((Number.isFinite(thresholdNum) &&
      Number.isFinite(rewardNum) &&
      rewardNum >= thresholdNum) ||
      (vipRewardNum != null &&
        (!Number.isFinite(vipRewardNum) ||
          vipRewardNum >= thresholdNum ||
          vipRewardNum < rewardNum)));
  const lossbackInvalid =
    lossbackOn &&
    (!Number.isFinite(lossbackPctNum) ||
      lossbackPctNum <= 0 ||
      lossbackPctNum >= 100 ||
      !Number.isFinite(minDepositNum) ||
      minDepositNum <= 0);
  const nothingOn = !wagerOn && !lossbackOn;
  const ratesInvalid = wagerInvalid || lossbackInvalid || nothingOn;

  function reset() {
    setName("");
    setQuery("");
    setResults([]);
    setSearched(false);
    setSelected(null);
    setPickedCodes([]);
    setWagerOn(true);
    setLossbackOn(true);
    setThreshold("1000");
    setReward("5");
    setVipReward("");
    setLossbackPct("5");
    setMinDeposit("50");
    setCap("");
  }

  const runSearch = useRef((_term: string) => {});
  runSearch.current = (term: string) => {
    startSearch(async () => {
      try {
        setResults(await searchCreatorsWithCodes(term));
        setSearched(true);
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Search failed");
      }
    });
  };

  /**
   * Live search as the operator types — no Search button to press. 300 ms
   * debounce, the same pause the /users toolbar uses, so a typed handle is one
   * round-trip per pause rather than one per keystroke. Runs on an empty box
   * too: that's the "just show me the creators" case the dialog opens with.
   *
   * Skipped entirely once a creator is picked (the list is replaced by the
   * selection), so re-opening the picker with `Change` re-runs it from the
   * term still in the box.
   */
  useEffect(() => {
    if (!open || selected) return;
    const t = setTimeout(() => runSearch.current(query), 300);
    return () => clearTimeout(t);
  }, [open, selected, query]);

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
        thresholdUsd: wagerOn ? thresholdNum : null,
        rewardUsd: wagerOn ? rewardNum : null,
        vipRewardUsd: wagerOn ? vipRewardNum : null,
        lossbackPct: lossbackOn ? lossbackPctNum : null,
        minDepositUsd: lossbackOn ? minDepositNum : null,
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
            <Label className="text-xs">Rewards this program gives</Label>
            <div className="space-y-2 rounded-md border p-3">
              <label className="flex items-start gap-2.5">
                <Switch
                  checked={wagerOn}
                  onCheckedChange={setWagerOn}
                  disabled={isPending}
                />
                <span className="text-sm">
                  Wager milestones
                  <span className="block text-[11px] text-muted-foreground">
                    Recurring — pays every time they wager another full
                    threshold under the code.
                  </span>
                </span>
              </label>
              <label className="flex items-start gap-2.5">
                <Switch
                  checked={lossbackOn}
                  onCheckedChange={setLossbackOn}
                  disabled={isPending}
                />
                <span className="text-sm">
                  First-deposit lossback
                  <span className="block text-[11px] text-muted-foreground">
                    Once, ever — a % of what they lost from their FIRST deposit.
                    Needs signup under the code; a second deposit closes it.
                  </span>
                </span>
              </label>
            </div>
            {nothingOn && (
              <p className="text-[11px] text-rose-600 dark:text-rose-400">
                Turn on at least one.
              </p>
            )}
          </div>

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
                <Input
                  value={query}
                  onChange={(e) => setQuery(e.target.value)}
                  placeholder="Username, affiliate code, or user ID…"
                  disabled={isPending}
                />
                {/* Results sit directly under the box: who they are on the
                    left, the codes they own on the right — the operator
                    usually knows the CODE and needs to confirm the account
                    before attaching a money program to it. */}
                {results.length > 0 ? (
                  <div className="max-h-56 space-y-0.5 overflow-y-auto rounded-md border p-1">
                    {/* Every row is a creator — the query returns no other
                        role — so all of them are selectable. */}
                    {results.map((r) => (
                      <button
                        key={r.userId}
                        type="button"
                        disabled={isPending}
                        onClick={() => {
                          setSelected(r);
                          setPickedCodes(r.codes);
                        }}
                        className="flex w-full items-center justify-between gap-3 rounded px-2 py-1.5 text-left text-sm hover:bg-muted"
                        title={`User ID: ${r.userId}`}
                      >
                        <span className="min-w-0 truncate">
                          {r.username ?? r.userId}
                        </span>
                        {r.codes.length > 0 ? (
                          <span className="flex shrink-0 flex-wrap justify-end gap-1">
                            {r.codes.slice(0, 4).map((c) => (
                              <span
                                key={c}
                                className="rounded border px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground"
                              >
                                {c}
                              </span>
                            ))}
                            {r.codes.length > 4 && (
                              <span className="text-[10px] text-muted-foreground">
                                +{r.codes.length - 4}
                              </span>
                            )}
                          </span>
                        ) : (
                          <span className="shrink-0 text-[10px] text-muted-foreground">
                            no codes
                          </span>
                        )}
                      </button>
                    ))}
                  </div>
                ) : (
                  searched &&
                  !searching && (
                    <p className="text-xs text-muted-foreground">
                      {query.trim()
                        ? "No creator matches that. A code owned by a non-creator account won't show — make them a creator first."
                        : "No creators yet."}
                    </p>
                  )
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

          {lossbackOn && (
            <div className="grid grid-cols-2 gap-3">
              <div className="space-y-1.5">
                <Label className="text-xs">Lossback (%)</Label>
                <Input
                  type="number"
                  min="0.01"
                  max="99.99"
                  step="0.01"
                  value={lossbackPct}
                  onChange={(e) => setLossbackPct(e.target.value)}
                  disabled={isPending}
                />
              </div>
              <div className="space-y-1.5">
                <Label className="text-xs">Minimum first deposit ($)</Label>
                <Input
                  type="number"
                  min="1"
                  value={minDeposit}
                  onChange={(e) => setMinDeposit(e.target.value)}
                  disabled={isPending}
                />
              </div>
            </div>
          )}

          {wagerOn && (
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
          )}

          {wagerOn && (
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
          )}

          {ratesInvalid && (
            <p className="text-sm text-rose-600 dark:text-rose-400">
              {nothingOn
                ? "Turn on at least one reward."
                : lossbackInvalid
                  ? "Lossback must be between 0 and 100%, with a positive minimum deposit."
                  : "Rewards must be under the threshold, and the VIP rate at least the standard one."}
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

          {wagerOn &&
            Number.isFinite(thresholdNum) &&
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

function RequestsPanel({
  claims,
  userHrefBase,
  claimsCap,
}: {
  claims: CreatorRewardClaimRow[];
  userHrefBase: string;
  claimsCap?: number;
}) {
  const pending = claims.filter((c) => c.status === "pending");
  const reviewed = claims.filter((c) => c.status !== "pending");

  return (
    <div className="space-y-5">
      <div className="space-y-3">
        <SectionHeading icon={Inbox} title="Awaiting review" action={<WebhookTestButton />} />
        {pending.length === 0 ? (
          <EmptyState
            icon={BadgeCheck}
            title="Nothing waiting"
            description="Claim requests raised from Discord land here for manual approval."
          />
        ) : (
          <div className="space-y-2">
            {pending.map((c) => (
              <ClaimRow key={c.id} claim={c} userHrefBase={userHrefBase} />
            ))}
          </div>
        )}
      </div>

      {reviewed.length > 0 && (
        <div className="space-y-3">
          <SectionHeading icon={ShieldQuestion} title="Reviewed" />
          <div className="space-y-2">
            {reviewed.map((c) => (
              <ClaimRow key={c.id} claim={c} userHrefBase={userHrefBase} />
            ))}
          </div>
        </div>
      )}

      {/* Capped-list honesty: exactly hitting the fetch limit means older
          claims exist but were cut off — say so rather than letting the list
          read as the complete history. */}
      {claimsCap != null && claims.length === claimsCap && (
        <p className="text-xs text-muted-foreground">
          Showing the {claimsCap} most recent claims — older ones aren&apos;t
          listed here.
        </p>
      )}
    </div>
  );
}

/** Two letters for the avatar fallback — same helper the user tables use. */
function initialsFor(username: string | null, userId: string): string {
  return (username ?? userId).slice(0, 2).toUpperCase();
}

/**
 * One tone per meaning, defined once.
 *
 * These were eight hand-written Badge blocks with their colour classes copied
 * into each, which is how a palette drifts. Nothing new is introduced here.
 */
const FLAG_TONE = {
  amber: "bg-amber-500/15 text-amber-600 dark:text-amber-400",
  purple: "bg-purple-500/15 text-purple-600 dark:text-purple-400",
  rose: "bg-rose-500/15 text-rose-600 dark:text-rose-400",
  sky: "bg-sky-500/15 text-sky-600 dark:text-sky-400",
  emerald: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
  zinc: "bg-zinc-500/15 text-zinc-600 dark:text-zinc-400",
} as const;

function Flag({
  tone,
  title,
  children,
}: {
  tone: keyof typeof FLAG_TONE;
  title?: string;
  children: ReactNode;
}) {
  return (
    <Badge
      variant="outline"
      className={cn("text-[10px]", FLAG_TONE[tone])}
      title={title}
    >
      {children}
    </Badge>
  );
}

/**
 * One claim in the review queue.
 *
 * Laid out as a fixed four-column grid — who / what it costs / how much / act —
 * rather than a wrapping flex row. Under flex-wrap every column started
 * wherever the previous one happened to end, so no two rows lined up and the
 * amount (the number the decision turns on) sat in a different place on each
 * one. Fixed track widths mean the eye can run straight down a column.
 *
 * The identity block carries the profile because approving moves money: an
 * account that is banned, locked, flagged as an alt, or three days old is the
 * reason to look twice, and that has to be visible where the button is rather
 * than one page away.
 */
function ClaimRow({
  claim,
  userHrefBase,
}: {
  claim: CreatorRewardClaimRow;
  userHrefBase: string;
}) {
  const [approveOpen, setApproveOpen] = useState(false);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [reopenOpen, setReopenOpen] = useState(false);

  const displayName = claim.username ?? claim.userId;

  // Absence of a flag is not evidence of a clean account — the MAIN-DB profile
  // lookup degrades to `false` — so these read as "flagged", never as "cleared".
  const meta = [
    claim.discordUserId ? `Discord ${claim.discordUserId}` : null,
    claim.userCreatedAt ? `joined ${formatRelative(claim.userCreatedAt)}` : null,
    claim.userCountryCode?.toUpperCase() ?? null,
  ].filter(Boolean);

  return (
    <Card>
      <CardContent className="grid grid-cols-1 gap-4 p-4 lg:grid-cols-[minmax(0,1fr)_15rem_7rem] lg:items-center lg:gap-6 xl:grid-cols-[minmax(0,1fr)_15rem_7rem_13rem]">
        {/* ── who ── */}
        <div className="flex min-w-0 items-start gap-3">
          <Avatar className="size-10 shrink-0">
            {claim.userImage && <AvatarImage src={claim.userImage} alt="" />}
            <AvatarFallback className="text-xs">
              {initialsFor(claim.username, claim.userId)}
            </AvatarFallback>
          </Avatar>

          <div className="min-w-0 space-y-1">
            <div className="flex flex-wrap items-center gap-1.5">
              <Link
                href={`${userHrefBase}/${claim.userId}`}
                className="truncate font-medium outline-none hover:underline focus-visible:rounded-md focus-visible:ring-2 focus-visible:ring-ring"
                title={displayName}
              >
                {displayName}
              </Link>

              {claim.status === "approved" ? (
                <Flag tone="emerald">Approved</Flag>
              ) : claim.status === "rejected" ? (
                <Flag tone="zinc">Rejected</Flag>
              ) : (
                <Flag tone="amber">Pending</Flag>
              )}

              {claim.wasVip && <Flag tone="purple">VIP</Flag>}

              {/* Account risk. Rare, so the row stays quiet in the normal case
                  and gets loud exactly when a reviewer should slow down. */}
              {claim.userIsBanned && (
                <Flag tone="rose" title="This account is banned">
                  Banned
                </Flag>
              )}
              {claim.userIsLocked && (
                <Flag tone="amber" title="This account is locked">
                  Locked
                </Flag>
              )}
              {claim.userSuspectedAlt && (
                <Flag
                  tone="amber"
                  title="Device fingerprinting flagged this account as a suspected alt"
                >
                  Alt
                </Flag>
              )}

              {claim.switchedAway === true && (
                <Flag
                  tone="amber"
                  title="The player has moved to a different creator's code since filing"
                >
                  Switched code
                </Flag>
              )}
              {claim.reinstatedAt && <Flag tone="sky">Reopened</Flag>}
              {claim.botNotifyError && (
                <Flag tone="amber" title={claim.botNotifyError}>
                  DM failed
                </Flag>
              )}
            </div>

            <div
              className="truncate text-xs text-muted-foreground"
              title={formatDateTime(claim.requestedAt)}
            >
              {claim.programName} · {claim.creatorUsername ?? "creator"} ·{" "}
              {formatRelative(claim.requestedAt)}
            </div>

            {meta.length > 0 && (
              <div className="truncate text-[11px] text-muted-foreground/80">
                {meta.join(" · ")}
              </div>
            )}

            {/* A reopened claim is pending again, so the buttons replace the
                note column — surface the original rejection here instead, or
                the second reviewer repeats the first one's work blind. */}
            {claim.status === "pending" &&
              claim.reinstatedAt &&
              claim.reviewNote && (
                <div className="text-xs text-sky-600 dark:text-sky-400">
                  Previously rejected: &ldquo;{claim.reviewNote}&rdquo;
                </div>
              )}

            {/* Moved out of the actions column: a variable-width quote sitting
                beside the buttons pushed them off the grid on every row. */}
            {claim.status !== "pending" && claim.reviewNote && (
              <div className="text-xs text-muted-foreground">
                &ldquo;{claim.reviewNote}&rdquo;
              </div>
            )}
          </div>
        </div>

        {/* ── what it costs ── */}
        <div className="space-y-0.5 text-xs text-muted-foreground">
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

        {/* ── how much ── */}
        <div className="lg:text-right">
          <div className="text-lg font-semibold tabular-nums text-rose-600 dark:text-rose-400">
            {formatCurrency(claim.amountUsd)}
          </div>
          {claim.reviewerName && (
            <div className="truncate text-[11px] text-muted-foreground">
              by {claim.reviewerName}
            </div>
          )}
        </div>

        {/* ── act ── */}
        <div className="flex flex-wrap gap-2 lg:justify-end">
          {claim.status === "pending" ? (
            <>
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
            </>
          ) : (
            <>
              {claim.botNotifyError && <ResendNoticeButton claim={claim} />}
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
            </>
          )}
        </div>
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


/**
 * Verifies the approve/decline DM path end to end without messaging a player.
 * Lives next to the review queue because that is where the consequence of a
 * broken webhook shows up.
 */
function WebhookTestButton() {
  const [isPending, startTransition] = useTransition();

  function test() {
    startTransition(async () => {
      const res = await testBotWebhookConnection();
      if (!res.success) {
        toast.error(res.error, { duration: 10_000 });
        return;
      }
      toast.success(res.data.message);
    });
  }

  return (
    <Button size="sm" variant="outline" onClick={test} disabled={isPending}>
      <Send className="size-3.5" />
      {isPending ? "Testing…" : "Test bot connection"}
    </Button>
  );
}

/**
 * Retry the decision DM after a delivery failure.
 *
 * Safe to press repeatedly: the bot dedupes on an event id derived from the
 * claim and the decision, so a press after a delivery that actually succeeded
 * returns `duplicate` and sends no second DM.
 */
function ResendNoticeButton({ claim }: { claim: CreatorRewardClaimRow }) {
  const [isPending, startTransition] = useTransition();

  function resend() {
    startTransition(async () => {
      const res = await resendClaimDecisionNotice({ claimId: claim.id });
      if (!res.success) {
        toast.error(res.error);
        return;
      }
      toast.success("Notification delivered");
    });
  }

  return (
    <Button
      size="sm"
      variant="outline"
      onClick={resend}
      disabled={isPending}
      title={claim.botNotifyError ?? undefined}
    >
      <Send className="size-3.5" />
      {isPending ? "Sending…" : "Resend DM"}
    </Button>
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
  const [isPending, startTransition] = useTransition();

  function submit() {
    startTransition(async () => {
      const res = await approveCreatorRewardClaim({
        claimId: claim.id,
        totpCode: totp.trim(),
      });
      if (!res.success) {
        toast.error(res.error);
        return;
      }
      toast.success(`Paid ${formatCurrency(claim.amountUsd)}`);
      setTotp("");
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

        {/* Passkey OR authenticator code — `require2FA` accepts either, so the
            same field serves both. The note input was removed (owner,
            2026-07-23): approvals are already traceable through the claim, the
            audit event and the ledger row's creator metadata. */}
        <StepUpField value={totp} onChange={setTotp} disabled={isPending} />

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => onOpenChange(false)}
            disabled={isPending}
          >
            Cancel
          </Button>
          {/* Non-empty is the right client-side test: a passkey proof token is
              far longer than 6 chars, and the server validates the real shape. */}
          <Button onClick={submit} disabled={isPending || totp.trim().length === 0}>
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
