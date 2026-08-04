"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Eye, Loader2 } from "lucide-react";
import { toast } from "sonner";

import { hrefForCurrentHost } from "@/lib/use-app-host";
import { assignReview } from "../actions";

const TERMINAL_STATUSES = new Set(["cleared", "flagged"]);

/** Opening a live case also claims it for the analyst who clicked Review. */
export function ReviewOpenButton({
  reviewId,
  viewerId,
  status,
  href,
  label,
}: {
  reviewId: string;
  viewerId: string;
  status: string;
  href: string;
  label: string;
}) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();

  function openReview() {
    startTransition(async () => {
      try {
        if (!TERMINAL_STATUSES.has(status)) {
          await assignReview({ reviewId, adminUserId: viewerId });
        }
        router.push(hrefForCurrentHost(href), { scroll: false });
      } catch (error) {
        toast.error(
          error instanceof Error ? error.message : "The review could not be claimed",
        );
      }
    });
  }

  return (
    <button
      type="button"
      onClick={openReview}
      disabled={pending}
      className="inline-flex h-8 items-center gap-1.5 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground shadow-sm transition-colors hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-wait disabled:opacity-70"
      aria-label={`Review ${label}`}
    >
      {pending ? (
        <Loader2 className="size-3.5 animate-spin" />
      ) : (
        <Eye className="size-3.5" />
      )}
      Review
    </button>
  );
}
