"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { toast } from "sonner";
import { MoreHorizontal, Pencil, RotateCcw, Trash2 } from "lucide-react";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Switch } from "@/components/ui/switch";
import { formatCurrency, formatDateTime } from "@/lib/utils/format";
import { cn } from "@/lib/utils";
import type { CreatorRewardProgramWithStats } from "@/lib/creator-vip/types";

import {
  restoreCreatorRewardProgram,
  setCreatorRewardProgramActive,
} from "../actions";
import { ProgramFormDialog } from "./program-form-dialog";
import { ProgramRemoveDialog } from "./program-remove-dialog";
import { RaiseClaimDialog } from "./raise-claim-dialog";

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

export function ProgramRow({
  program,
  creatorHrefBase,
}: {
  program: CreatorRewardProgramWithStats;
  creatorHrefBase: string;
}) {
  const [isPending, startTransition] = useTransition();
  const [raiseOpen, setRaiseOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const [removeOpen, setRemoveOpen] = useState(false);

  const archived = program.archivedAt != null;

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

  function restore() {
    startTransition(async () => {
      const res = await restoreCreatorRewardProgram({ programId: program.id });
      if (!res.success) {
        toast.error(res.error);
        return;
      }
      toast.success("Program restored — it's paused until you turn it on");
    });
  }

  return (
    <Card className={cn(archived && "opacity-60")}>
      {/* `Card` already supplies the vertical padding (py-4); only the
          horizontal inset belongs here. */}
      <CardContent className="flex flex-wrap items-center gap-x-6 gap-y-3 px-4">
        {/* Identity block — avatar + who the program belongs to, on the same
            baseline as the program name. A program is an agreement with a
            person, and this card is where someone decides to pause or pay
            one, so the creator reads as a person rather than a username in
            small grey text. Fixed avatar size + `items-center` keeps every
            card's first line aligned no matter how long a name runs. */}
        <div className="flex min-w-0 flex-1 items-center gap-3 sm:min-w-[240px]">
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
              {archived ? (
                <Badge
                  variant="outline"
                  className="bg-zinc-500/15 text-[10px] text-zinc-600 dark:text-zinc-400"
                  title="Retired — it kept its claims, so it was archived instead of deleted."
                >
                  Archived
                </Badge>
              ) : (
                !program.isActive && (
                  <Badge
                    variant="outline"
                    className="bg-zinc-500/15 text-[10px] text-zinc-600 dark:text-zinc-400"
                  >
                    Paused
                  </Badge>
                )
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

        {/* An archived program is not a program you operate — it's history you
            can bring back. Everything that mutates it is gone. */}
        {archived ? (
          <Button
            size="sm"
            variant="outline"
            onClick={restore}
            disabled={isPending}
          >
            <RotateCcw className="size-3.5" />
            {isPending ? "Restoring…" : "Restore"}
          </Button>
        ) : (
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
            <DropdownMenu>
              <DropdownMenuTrigger
                render={<Button variant="ghost" size="icon" className="size-8" />}
                aria-label={`More actions for ${program.name}`}
              >
                <MoreHorizontal className="size-4" />
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={() => setEditOpen(true)}>
                  <Pencil className="mr-2 size-4" />
                  Edit program
                </DropdownMenuItem>
                <DropdownMenuSeparator />
                <DropdownMenuItem
                  onSelect={() => setRemoveOpen(true)}
                  className="text-rose-600 focus:text-rose-600"
                >
                  <Trash2 className="mr-2 size-4" />
                  Delete program
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          </div>
        )}
      </CardContent>

      {!archived && (
        <>
          <RaiseClaimDialog
            program={program}
            open={raiseOpen}
            onOpenChange={setRaiseOpen}
          />
          <ProgramFormDialog
            program={program}
            open={editOpen}
            onOpenChange={setEditOpen}
          />
          <ProgramRemoveDialog
            programId={program.id}
            programName={program.name}
            open={removeOpen}
            onOpenChange={setRemoveOpen}
          />
        </>
      )}
    </Card>
  );
}
