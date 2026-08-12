"use client";

import { useRef, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Eye, LoaderCircle } from "lucide-react";
import { toast } from "sonner";
import { clientActionError } from "@/lib/errors/client-action-error";

import { Button } from "@/components/ui/button";
import { startReview } from "../actions";

export function StartReviewButton({
  reviewId,
  href,
  label,
  subject,
}: {
  reviewId: string;
  href: string;
  label: string;
  subject: string;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();
  const idempotencyKey = useRef<string | null>(null);
  const requestInFlight = useRef(false);

  function openReview() {
    // `isPending` only updates after React commits the transition. A fast
    // double-click can otherwise start two navigations and two server actions
    // before the disabled state reaches the DOM.
    if (requestInFlight.current) return;
    requestInFlight.current = true;

    // Opening the workspace must not wait for the claim transaction, its
    // audit note, and cache revalidation. Both requests can safely run
    // together because startReview remains guarded and idempotent.
    router.push(href, { scroll: false });

    startTransition(async () => {
      try {
        idempotencyKey.current ??= crypto.randomUUID();
        const result = await startReview({
          reviewId,
          expectedStatus: "open",
          idempotencyKey: idempotencyKey.current,
        });
        if (!result.success) {
          toast.error(result.error);
          return;
        }
        // The navigation and claim intentionally run in parallel. Refresh
        // once the claim settles so a detail response that won the race does
        // not keep the pre-claim status in the dialog.
        router.refresh();
      } catch (error) {
        toast.error(
          clientActionError(error, "Review could not be opened"),
        );
      } finally {
        requestInFlight.current = false;
      }
    });
  }

  return (
    <Button
      type="button"
      className="h-9 min-w-28 px-3 text-sm"
      disabled={isPending}
      aria-label={`${label} for ${subject}`}
      onClick={openReview}
    >
      {isPending ? (
        <LoaderCircle className="size-4 animate-spin" />
      ) : (
        <Eye className="size-4" />
      )}
      {isPending ? "Opening…" : label}
    </Button>
  );
}
