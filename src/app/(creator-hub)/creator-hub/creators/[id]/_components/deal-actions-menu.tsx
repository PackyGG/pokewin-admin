"use client";

import { useState } from "react";
import { Ban, History, MoreHorizontal, Pencil } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { CreatorDealResponse } from "@/lib/backend-api";

import { EditDealDialog } from "./edit-deal-dialog";
import { PreviousDealsDialog } from "./previous-deals-dialog";
import { TerminateDealDialog } from "./terminate-deal-dialog";

type OpenDialog = "edit" | "previous" | "terminate" | null;

/**
 * Deal overflow menu — consolidates the secondary deal actions behind ONE
 * compact kebab so the SectionHeading action slot holds just "New Deal" +
 * this menu (the four inline buttons used to wrap badly):
 *
 *   • Edit terms           (active deal only)
 *   • Previous deals (n)   (when any ended deal exists)
 *   • ── separator ──
 *   • Terminate deal       (destructive; typed confirmation in the dialog)
 *
 * The dialogs are CONTROLLED (no own triggers) and mount alongside the menu;
 * `onSelect` lets the dropdown close its portal first, then opens the dialog
 * (the working pattern from `creators/_components/creator-row-actions.tsx`).
 */
export function DealActionsMenu({
  userId,
  username,
  activeDeal,
  previousDeals,
}: {
  userId: string;
  username: string | null;
  activeDeal: CreatorDealResponse | null;
  previousDeals: CreatorDealResponse[];
}) {
  const [openDialog, setOpenDialog] = useState<OpenDialog>(null);

  const hasPrevious = previousDeals.length > 0;
  if (!activeDeal && !hasPrevious) return null;

  const closeFor =
    (name: Exclude<OpenDialog, null>) => (next: boolean) =>
      setOpenDialog(next ? name : null);

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={<Button variant="outline" size="icon" className="size-8" />}
        >
          <MoreHorizontal className="size-4" />
          <span className="sr-only">Open deal actions</span>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          {activeDeal && (
            <DropdownMenuItem onSelect={() => setOpenDialog("edit")}>
              <Pencil className="mr-2 size-4" />
              Edit terms
            </DropdownMenuItem>
          )}
          {hasPrevious && (
            <DropdownMenuItem onSelect={() => setOpenDialog("previous")}>
              <History className="mr-2 size-4" />
              Previous deals ({previousDeals.length})
            </DropdownMenuItem>
          )}
          {activeDeal && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuItem
                variant="destructive"
                onSelect={() => setOpenDialog("terminate")}
              >
                <Ban className="mr-2 size-4" />
                Terminate deal
              </DropdownMenuItem>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>

      {activeDeal && (
        <EditDealDialog
          userId={userId}
          deal={activeDeal}
          open={openDialog === "edit"}
          onOpenChange={closeFor("edit")}
        />
      )}
      {hasPrevious && (
        <PreviousDealsDialog
          deals={previousDeals}
          open={openDialog === "previous"}
          onOpenChange={closeFor("previous")}
        />
      )}
      {activeDeal && (
        <TerminateDealDialog
          userId={userId}
          dealId={activeDeal.id}
          username={username}
          open={openDialog === "terminate"}
          onOpenChange={closeFor("terminate")}
        />
      )}
    </>
  );
}
