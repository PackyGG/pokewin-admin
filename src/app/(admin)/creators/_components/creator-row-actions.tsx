"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
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
  const [isPending, startTransition] = useTransition();
  const [confirmOpen, setConfirmOpen] = useState(false);

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
        toast.success("Creator role revoked");
        setConfirmOpen(false);
      } catch (err) {
        toast.error(
          err instanceof Error ? err.message : "Failed to demote creator",
        );
      }
    });
  }

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
            onSelect={(e) => {
              e.preventDefault();
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
