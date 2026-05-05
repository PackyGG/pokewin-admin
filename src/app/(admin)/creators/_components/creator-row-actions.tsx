"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { MoreHorizontal, ExternalLink, UserMinus } from "lucide-react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";

import { demoteCreator } from "../backend-actions";

type Props = {
  userId: string;
  hasActiveSession: boolean;
  hasActiveDeal: boolean;
};

export function CreatorRowActions({
  userId,
  hasActiveSession,
  hasActiveDeal,
}: Props) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const [confirmOpen, setConfirmOpen] = useState(false);
  // Optimistic flag — once the demote succeeds we hide the row's
  // actions immediately, even before router.refresh() pulls the
  // re-rendered list. Without this the user sees the same row
  // sitting there for the duration of the backend RPC and starts
  // clicking again, double-firing the action.
  const [optimisticallyRemoved, setOptimisticallyRemoved] =
    useState(false);

  const demoteBlocked = hasActiveSession || hasActiveDeal;
  const blockedReason = hasActiveSession
    ? "Creator has an active stream session"
    : hasActiveDeal
      ? "Creator has an active deal for this week"
      : null;

  function handleDemote() {
    startTransition(async () => {
      try {
        await demoteCreator(userId);
        // Mark removed first so the UI dims instantly — the
        // dialog closes, the kebab is hidden, no double-click.
        setOptimisticallyRemoved(true);
        toast.success("Creator role revoked");
        setConfirmOpen(false);
        // revalidatePath in the server action invalidated the
        // cache; this pull re-renders the page with the user
        // gone. Without this call the user only sees the change
        // on next manual reload, which is what makes it feel
        // "didn't actually remove".
        router.refresh();
      } catch (err) {
        toast.error(
          err instanceof Error ? err.message : "Failed to demote creator",
        );
      }
    });
  }

  // Optimistic-removed rows render nothing — the next router.refresh()
  // will rebuild the list without this user and the component will
  // unmount cleanly. We do this in addition to (not instead of)
  // setOptimisticallyRemoved so even slow backends feel snappy.
  if (optimisticallyRemoved) return null;

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger
          render={<Button variant="ghost" size="icon" className="size-8" />}
        >
          <MoreHorizontal className="size-4" />
          <span className="sr-only">Open row actions</span>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end">
          <DropdownMenuItem render={<Link href={`/creators/${userId}`} />}>
            <ExternalLink className="mr-2 size-4" />
            View details
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            disabled={demoteBlocked || isPending}
            // No `e.preventDefault()` — letting the dropdown close
            // its portal first, THEN opening the AlertDialog, is what
            // makes the dialog actually visible. Keeping the dropdown
            // open (preventDefault) traps focus + z-index above the
            // dialog so clicks "do nothing" from the user's POV.
            // Matches the working pattern in withdrawals/row-actions.
            onSelect={() => {
              if (!demoteBlocked) setConfirmOpen(true);
            }}
            className="text-rose-600 focus:text-rose-600"
          >
            <UserMinus className="mr-2 size-4" />
            Revoke creator role
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Revoke creator role?</AlertDialogTitle>
            <AlertDialogDescription>
              {blockedReason ? (
                <>This is blocked: {blockedReason}.</>
              ) : (
                <>
                  The user will lose creator status and no longer be able to
                  activate fills or claim payouts. Past deals and sessions
                  remain for audit. This is reversible — you can re-promote
                  them later.
                </>
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={handleDemote}
              disabled={isPending || demoteBlocked}
              className="bg-rose-600 text-white hover:bg-rose-700"
            >
              {isPending ? "Revoking..." : "Revoke"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </>
  );
}
