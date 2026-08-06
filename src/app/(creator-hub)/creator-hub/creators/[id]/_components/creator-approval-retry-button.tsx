"use client";

import { useTransition } from "react";
import { RefreshCw } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ux";

import { retryCreatorApprovalAction } from "./creator-approval-retry-actions";

export function CreatorApprovalRetryButton({
  creatorUserId,
  requestId,
  step,
}: {
  creatorUserId: string;
  requestId: string;
  step: "delivery" | "provisioning";
}) {
  const [pending, startTransition] = useTransition();

  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          const result = await retryCreatorApprovalAction({
            creatorUserId,
            requestId,
            step,
          });
          if (!result.success) {
            toast.error(result.error);
            return;
          }
          toast.success(
            step === "delivery"
              ? "Discord delivery requeued"
              : result.status === "approved"
                ? "Deal provisioning completed"
                : "Provisioning retry saved its latest state",
          );
        })
      }
    >
      {pending ? <Spinner size={14} /> : <RefreshCw className="size-3.5" />}
      {pending
        ? "Retrying…"
        : step === "delivery"
          ? "Retry Discord delivery"
          : "Retry creation"}
    </Button>
  );
}
