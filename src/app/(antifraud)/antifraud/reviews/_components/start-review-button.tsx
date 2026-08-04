"use client";

import { useRef, useTransition } from "react";
import { useRouter } from "next/navigation";
import { Eye, LoaderCircle } from "lucide-react";
import { toast } from "sonner";

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

  return (
    <Button
      type="button"
      className="h-9 min-w-28 px-3 text-sm"
      disabled={isPending}
      aria-label={`${label} for ${subject}`}
      onClick={() => {
        startTransition(async () => {
          try {
            idempotencyKey.current ??= crypto.randomUUID();
            await startReview({
              reviewId,
              expectedStatus: "open",
              idempotencyKey: idempotencyKey.current,
            });
            router.push(href, { scroll: false });
          } catch (error) {
            toast.error(
              error instanceof Error ? error.message : "Review could not be opened",
            );
          }
        });
      }}
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
