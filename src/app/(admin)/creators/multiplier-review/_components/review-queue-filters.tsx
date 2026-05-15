"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { Flag } from "lucide-react";

import { Button } from "@/components/ui/button";

type Props = {
  flaggedOnly: boolean;
};

/**
 * Top-right filter toggle on the review queue page. The "Flagged only"
 * toggle flips `?flagged_only=1` in the URL — server reads this on next
 * render and narrows the queue accordingly. Offset is reset to 0 on
 * filter change so the user always lands on the first page of the new
 * view.
 */
export function ReviewQueueFilters({ flaggedOnly }: Props) {
  const router = useRouter();
  const searchParams = useSearchParams();

  function toggle() {
    const next = new URLSearchParams(searchParams.toString());
    if (flaggedOnly) {
      next.delete("flagged_only");
    } else {
      next.set("flagged_only", "1");
    }
    next.delete("offset");
    const qs = next.toString();
    router.push(qs ? `?${qs}` : "?", { scroll: false });
  }

  return (
    <Button
      variant={flaggedOnly ? "default" : "outline"}
      size="sm"
      onClick={toggle}
    >
      <Flag className="mr-1.5 size-3.5" />
      {flaggedOnly ? "Showing flagged only" : "Flagged only"}
    </Button>
  );
}
