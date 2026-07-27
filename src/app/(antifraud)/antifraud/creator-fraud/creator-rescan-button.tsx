"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { RefreshCw } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import type { CreatorWindow } from "@/lib/antifraud/network-api";
import { rescanCreatorFraud } from "./actions";

export function CreatorRescanButton({
  creatorId,
  window,
}: {
  creatorId: string;
  window: CreatorWindow;
}) {
  const router = useRouter();
  const [pending, startTransition] = React.useTransition();
  return (
    <Button
      size="sm"
      variant="outline"
      disabled={pending}
      onClick={() =>
        startTransition(async () => {
          try {
            await rescanCreatorFraud({ creatorId, window });
            toast.success("Affiliate cohort assessment queued");
            router.refresh();
          } catch (error) {
            toast.error(
              error instanceof Error ? error.message : "Could not queue scan",
            );
          }
        })
      }
    >
      <RefreshCw className={pending ? "size-3.5 animate-spin" : "size-3.5"} />
      Refresh
    </Button>
  );
}
