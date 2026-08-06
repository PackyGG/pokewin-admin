"use client";

import { useState } from "react";
import Link from "next/link";
import { Check, RotateCcw, X } from "lucide-react";

import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Button } from "@/components/ui/button";
import { Card, CardContent } from "@/components/ui/card";
import { formatCurrency, formatDateTime, formatRelative } from "@/lib/utils/format";
import type { CreatorRewardClaimRow } from "@/lib/creator-vip/queries";

import { Flag } from "./claim-flags";
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
export function ClaimRow({
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
      {/* `Card` already supplies the vertical padding (py-4). */}
      <CardContent className="grid grid-cols-1 gap-4 px-4 lg:grid-cols-[minmax(0,1fr)_15rem_7rem] lg:items-center lg:gap-6 xl:grid-cols-[minmax(0,1fr)_15rem_7rem_13rem]">
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

              {/* House-POV: an approved claim credits the player, which is money
                  the house gives away — rose, never emerald. */}
              {claim.status === "approved" ? (
                <Flag tone="rose">Approved</Flag>
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
              {claim.reinstatedAt && <Flag tone="blue">Reopened</Flag>}
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
                <div className="text-xs text-blue-600 dark:text-blue-400">
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
