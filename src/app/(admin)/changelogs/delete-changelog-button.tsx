"use client";

import * as React from "react";
import { useTransition } from "react";
import { Trash2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
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

import { deleteChangelogEntry } from "./actions";

/**
 * Confirm-then-delete button used on each card. The deletion is hard
 * (no soft-delete) — admin_audit_events captures the audit trail per
 * the project's audit convention, so there's nothing to recover from
 * the table itself.
 */
export function DeleteChangelogButton({
  id,
  title,
}: {
  id: string;
  title: string;
}) {
  const [open, setOpen] = React.useState(false);
  const [pending, startTransition] = useTransition();

  function handleDelete() {
    startTransition(async () => {
      try {
        await deleteChangelogEntry(id);
        toast.success("Changelog entry deleted");
        setOpen(false);
      } catch (err) {
        toast.error(
          err instanceof Error ? err.message : "Could not delete entry",
        );
      }
    });
  }

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <Button
        size="sm"
        variant="ghost"
        className="text-muted-foreground hover:text-rose-500"
        onClick={() => setOpen(true)}
        aria-label={`Delete ${title}`}
      >
        <Trash2 className="mr-1 size-3.5" />
        Delete
      </Button>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete changelog entry?</AlertDialogTitle>
          <AlertDialogDescription>
            This permanently removes &ldquo;{title}&rdquo;. The deletion is
            audit-logged but the entry itself cannot be restored.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={handleDelete}
            disabled={pending}
            className="bg-rose-500 hover:bg-rose-600 focus:ring-rose-500"
          >
            {pending ? "Deleting…" : "Delete"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
