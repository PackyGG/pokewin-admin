"use client";

import { useState } from "react";
import Link from "next/link";
import { Check, RotateCcw, X } from "lucide-react";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { Checkbox } from "@/components/ui/checkbox";
import { formatCurrency, formatDateTime, formatRelative } from "@/lib/utils/format";
import type { CreatorRewardClaimRow } from "@/lib/creator-vip/queries";

import { Flag, Hint } from "./claim-flags";
import {
  ApproveDialog,
  RejectDialog,
  ReopenDialog,
  ResendNoticeButton,
} from "./claim-decision-dialogs";

/** Two letters for the avatar fallback — same helper the user tables use. */
function initialsFor(username: string | null, userId: string): string {
  return (username ?? userId).slice(0, 2).toUpperCase();
}

/**
 * The pieces one claim is made of, each usable on its own.
 *
 * The queue renders the same claim two ways — a real table on desktop (sortable,
 * labelled columns) and a stacked card on narrow screens — and both have to show
 * the same flags, the same tooltips and the same buttons. Splitting the row into
 * cells rather than duplicating the markup is what stops a risk flag existing in
 * one of them and not the other.
 */

/**
 * Who is asking, and every reason to look twice before paying.
 *
 * Absence of a flag is not evidence of a clean account — the MAIN-DB profile
 * lookup degrades to `false` — so these read as "flagged", never as "cleared".
 */
export function ClaimClaimantCell({
  claim,
  userHrefBase,
}: {
  claim: CreatorRewardClaimRow;
  userHrefBase: string;
}) {
  const displayName = claim.username ?? claim.userId;

  const meta = [
    claim.discordUserId ? `Discord ${claim.discordUserId}` : null,
    claim.userCreatedAt ? `joined ${formatRelative(claim.userCreatedAt)}` : null,
    claim.userCountryCode?.toUpperCase() ?? null,
  ].filter(Boolean);

  return (
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

          {claim.wasVip && <Flag tone="vip">VIP</Flag>}

          {/* Account risk. Rare, so the row stays quiet in the normal case
              and gets loud exactly when a reviewer should slow down. */}
          {claim.userIsBanned && (
            <Flag tone="rose" tip="This account is banned">
              Banned
            </Flag>
          )}
          {claim.userIsLocked && (
            <Flag tone="warn" tip="This account is locked">
              Locked
            </Flag>
          )}
          {claim.userSuspectedAlt && (
            <Flag
              tone="warn"
              tip="Device fingerprinting flagged this account as a suspected alt"
            >
              Alt
            </Flag>
          )}

          {claim.switchedAway === true && (
            <Flag
              tone="warn"
              tip="The player has moved to a different creator's code since filing"
            >
              Switched code
            </Flag>
          )}
          {claim.reinstatedAt && <Flag tone="blue">Reopened</Flag>}
          {claim.botNotifyError && (
            <Flag tone="warn" tip={claim.botNotifyError}>
              DM failed
            </Flag>
          )}
        </div>

        {meta.length > 0 && (
          <div className="truncate text-[11px] text-muted-foreground">
            {meta.join(" · ")}
          </div>
        )}

        {/* A reopened claim is pending again, so the buttons replace the
            note column — surface the original rejection here instead, or
            the second reviewer repeats the first one's work blind. */}
        {claim.status === "pending" &&
          claim.reinstatedAt &&
          claim.reviewNote && (
            <div className="text-xs text-blue-600 dark:text-blue-400">
              Previously rejected: &ldquo;{claim.reviewNote}&rdquo;
            </div>
          )}

        {/* Kept out of the actions column: a variable-width quote sitting
            beside the buttons pushed them off the grid on every row. */}
        {claim.status !== "pending" && claim.reviewNote && (
          <div className="text-xs text-muted-foreground">
            &ldquo;{claim.reviewNote}&rdquo;
          </div>
        )}
      </div>
    </div>
  );
}

/** Which program and creator earned it, and when it was filed. */
export function ClaimProgramCell({ claim }: { claim: CreatorRewardClaimRow }) {
  return (
    <div className="min-w-0 space-y-0.5 text-xs">
      <div className="truncate font-medium text-foreground">
        {claim.programName}
      </div>
      <div className="truncate text-muted-foreground">
        {claim.creatorUsername ?? "creator"}
      </div>
    </div>
  );
}

/**
 * How old the claim is. The exact filing time decides queue-order disputes, so
 * it has to be reachable — a `title` here reached neither keyboard nor touch.
 */
export function ClaimAgeCell({ claim }: { claim: CreatorRewardClaimRow }) {
  return (
    <Hint
      tip={`Filed ${formatDateTime(claim.requestedAt)}`}
      className="text-xs text-muted-foreground"
    >
      <span className="truncate">{formatRelative(claim.requestedAt)}</span>
    </Hint>
  );
}

/** What the payout consumes — the wager side of the trade. */
export function ClaimBasisCell({ claim }: { claim: CreatorRewardClaimRow }) {
  return (
    <div className="space-y-0.5 text-xs text-muted-foreground">
      <div>
        Wagered{" "}
        {/* House-POV: wager is money the player lost to us — emerald. */}
        <span className="tabular-nums text-emerald-600 dark:text-emerald-400">
          {formatCurrency(claim.wagerBasisUsd)}
        </span>
        {claim.priorConsumedUsd > 0 && (
          <> · {formatCurrency(claim.priorConsumedUsd)} already used</>
        )}
        {claim.forfeitedWagerUsd > 0 && (
          <> · {formatCurrency(claim.forfeitedWagerUsd)} lost to a code switch</>
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
  );
}

/**
 * The number the decision turns on.
 *
 * House-POV: an approved claim credits the player, which is money the house
 * gives away — rose, never emerald.
 */
export function ClaimAmountCell({ claim }: { claim: CreatorRewardClaimRow }) {
  return (
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
  );
}

export function ClaimStatusCell({ claim }: { claim: CreatorRewardClaimRow }) {
  return claim.status === "approved" ? (
    <Flag tone="rose">Approved</Flag>
  ) : claim.status === "rejected" ? (
    <Flag tone="zinc">Rejected</Flag>
  ) : (
    <Flag tone="warn">Pending</Flag>
  );
}

/** Approve / reject / reopen / resend, with the dialogs they own. */
export function ClaimActionsCell({ claim }: { claim: CreatorRewardClaimRow }) {
  const [approveOpen, setApproveOpen] = useState(false);
  const [rejectOpen, setRejectOpen] = useState(false);
  const [reopenOpen, setReopenOpen] = useState(false);

  const who = claim.username ?? claim.userId;

  return (
    <>
      <div className="flex flex-wrap gap-2 lg:justify-end">
        {claim.status === "pending" ? (
          <>
            <Button
              size="sm"
              onClick={() => setApproveOpen(true)}
              aria-label={`Approve ${who}'s claim`}
            >
              <Check className="size-3.5" />
              Approve
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setRejectOpen(true)}
              aria-label={`Reject ${who}'s claim`}
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
                aria-label={`Reopen ${who}'s claim`}
              >
                <RotateCcw className="size-3.5" />
                Reopen
              </Button>
            )}
          </>
        )}
      </div>

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
    </>
  );
}

/**
 * One claim as a stacked card — the narrow-screen rendering of the queue.
 *
 * The desktop table (`ClaimsQueue`) carries the column headers that label these
 * numbers; a card has no header row, so each block keeps its own inline label.
 */
export function ClaimRow({
  claim,
  userHrefBase,
  selectable = false,
  selected = false,
  onSelectedChange,
}: {
  claim: CreatorRewardClaimRow;
  userHrefBase: string;
  /** Pending rows only — a decided claim can't be bulk-approved. */
  selectable?: boolean;
  selected?: boolean;
  onSelectedChange?: (next: boolean) => void;
}) {
  return (
    <Card>
      {/* `Card` already supplies the vertical padding (py-4). */}
      <CardContent className="space-y-3 px-4">
        <div className="flex items-start gap-3">
          {selectable && (
            <Checkbox
              className="mt-3"
              checked={selected}
              onCheckedChange={(v) => onSelectedChange?.(v === true)}
              aria-label={`Select ${claim.username ?? claim.userId}'s claim`}
            />
          )}
          <div className="min-w-0 flex-1">
            <ClaimClaimantCell claim={claim} userHrefBase={userHrefBase} />
          </div>
          <ClaimStatusCell claim={claim} />
        </div>

        <div className="flex flex-wrap items-end justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <div className="flex items-center gap-1.5 text-xs">
              <ClaimProgramCell claim={claim} />
              <span className="text-muted-foreground">·</span>
              <ClaimAgeCell claim={claim} />
            </div>
            <ClaimBasisCell claim={claim} />
          </div>
          <ClaimAmountCell claim={claim} />
        </div>

        <ClaimActionsCell claim={claim} />
      </CardContent>
    </Card>
  );
}
