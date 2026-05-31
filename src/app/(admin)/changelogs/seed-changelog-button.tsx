"use client";

import * as React from "react";
import { useTransition } from "react";
import { Sparkles } from "lucide-react";
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
import { RECENT_WORK_ENTRIES } from "@/lib/changelog/recent-work";

import { seedChangelogFromRecentWork } from "./actions";

/**
 * One-click "Populate from recent work" button.
 *
 * Pushes the hardcoded RECENT_WORK_ENTRIES list through the seed action.
 * The action is idempotent by (published_at calendar-day, title), so
 * re-pressing the button after the const has been extended only inserts
 * the new entries. Existing rows are skipped, not overwritten.
 */
export function SeedChangelogButton() {
  const [open, setOpen] = React.useState(false);
  const [pending, startTransition] = useTransition();

  // The const is the source of truth — read its length here so the
  // confirm dialog tells the admin exactly how many entries will be
  // attempted (skipped count is reported back in the success toast).
  const totalCandidates = RECENT_WORK_ENTRIES.length;

  function handleSeed() {
    startTransition(async () => {
      try {
        const result = await seedChangelogFromRecentWork(
          // Map to the action's input shape. ISO strings on the const
          // are widened to Date by Zod's z.coerce.date() on the server.
          RECENT_WORK_ENTRIES.map((e) => ({
            publishedAt: new Date(e.publishedAt),
            title: e.title,
            summary: e.summary,
            version: e.version,
            category: e.category,
            changes: e.changes,
          })),
        );
        toast.success(
          `Seeded ${result.seeded} entries · skipped ${result.skipped} duplicates`,
        );
        setOpen(false);
      } catch (err) {
        toast.error(
          err instanceof Error
            ? err.message
            : "Could not seed changelog entries",
        );
      }
    });
  }

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <Button
        size="sm"
        variant="outline"
        onClick={() => setOpen(true)}
        disabled={pending}
      >
        <Sparkles className="mr-1 size-4" />
        Populate from recent work
      </Button>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Populate changelog from recent work?</AlertDialogTitle>
          <AlertDialogDescription>
            Attempts to insert {totalCandidates} curated entries into the
            changelog. Entries that already exist (matched by published
            date + title) are skipped — the action is safe to re-run
            after extending the source list.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={handleSeed} disabled={pending}>
            {pending ? "Seeding…" : "Populate"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
