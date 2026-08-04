"use client";

import { useState } from "react";
import { Ban, History, Pencil } from "lucide-react";

import { Button } from "@/components/ui/button";
import type { CreatorDealResponse } from "@/lib/backend-api";

import { EditDealDialog } from "./edit-deal-dialog";
import { PreviousDealsDialog } from "./previous-deals-dialog";
import { TerminateDealDialog } from "./terminate-deal-dialog";

/**
 * Deal actions — the replacement for the old kebab overflow menu.
 *
 * The Deal card's heading now mirrors the Affiliate Leaderboards card beside
 * it: a plain "Previous deals" button next to the primary "New Deal", instead
 * of a `⋯` that hid it. The two deal-specific actions that don't exist on the
 * leaderboards side (edit / terminate) moved INTO the card body, on the row
 * that already holds the allowance badges — so the heading never grows to the
 * four inline buttons that used to wrap badly, and nothing lives behind a
 * kebab any more.
 *
 * Both components own their dialogs (which are controlled and trigger-less)
 * and take only serializable props, so the server card can render them
 * directly across the RSC boundary.
 */

/** Heading button — same shape/size as `PreviousLeaderboardsDialog`'s. */
export function PreviousDealsButton({
  deals,
}: {
  deals: CreatorDealResponse[];
}) {
  const [open, setOpen] = useState(false);

  if (deals.length === 0) return null;

  return (
    <>
      <Button variant="outline" size="sm" onClick={() => setOpen(true)}>
        <History className="mr-1 size-3.5" />
        Previous deals ({deals.length})
      </Button>
      <PreviousDealsDialog deals={deals} open={open} onOpenChange={setOpen} />
    </>
  );
}

/**
 * In-card actions for the LIVE deal (active, or scheduled and not yet
 * started — same set the admin deals table allows). Terminate is destructive
 * and keeps its typed confirmation inside the dialog.
 */
export function DealCardActions({
  userId,
  username,
  deal,
}: {
  userId: string;
  username: string | null;
  deal: CreatorDealResponse;
}) {
  const [openDialog, setOpenDialog] = useState<"edit" | "terminate" | null>(
    null,
  );

  return (
    <>
      <Button
        variant="outline"
        size="sm"
        className="h-7 px-2 text-xs"
        onClick={() => setOpenDialog("edit")}
      >
        <Pencil className="mr-1 size-3.5" />
        Edit terms
      </Button>
      <Button
        variant="outline"
        size="sm"
        className="h-7 px-2 text-xs text-rose-600 hover:text-rose-600 dark:text-rose-400 dark:hover:text-rose-400"
        onClick={() => setOpenDialog("terminate")}
      >
        <Ban className="mr-1 size-3.5" />
        Terminate
      </Button>

      <EditDealDialog
        userId={userId}
        deal={deal}
        open={openDialog === "edit"}
        onOpenChange={(next) => setOpenDialog(next ? "edit" : null)}
      />
      <TerminateDealDialog
        userId={userId}
        dealId={deal.id}
        username={username}
        open={openDialog === "terminate"}
        onOpenChange={(next) => setOpenDialog(next ? "terminate" : null)}
      />
    </>
  );
}
