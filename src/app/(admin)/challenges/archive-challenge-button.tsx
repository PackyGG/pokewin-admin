"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Archive } from "lucide-react";
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
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import { archiveChallenge } from "./actions";

export function ArchiveChallengeButton({
  challengeId,
  version,
}: {
  challengeId: string;
  version: number;
}) {
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  function handleArchive() {
    startTransition(async () => {
      try {
        const result = await archiveChallenge(challengeId, version);
        if (!result.success) {
          toast.error(result.error);
          return;
        }
        toast.success("Challenge archived");
        router.refresh();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Failed to archive challenge");
      }
    });
  }

  return (
    <AlertDialog>
      <AlertDialogTrigger
        render={<Button variant="ghost" size="sm" disabled={isPending} />}
      >
        <Archive className="mr-1 size-3" /> Archive
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Archive Challenge?</AlertDialogTitle>
          <AlertDialogDescription>
            This soft-deletes the challenge (sets its status to archived). Players can
            no longer progress or claim it. This can be undone by setting the status
            back to active.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel>Go back</AlertDialogCancel>
          <AlertDialogAction onClick={handleArchive}>Archive</AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
