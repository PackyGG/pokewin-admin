"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Loader2, RefreshCw } from "lucide-react";

import { Button } from "@/components/ui/button";

import { refetchCreatorKick } from "./kick-refetch-actions";

/**
 * Manual Refetch button for the Kick tab.
 *
 * Calls the `refetchCreatorKick` server action (the ONLY forced-refresh path —
 * the underlying service is anti-mash throttled, and nothing polls). On
 * success it `router.refresh()`es so the streamed tab re-reads the freshly
 * cached rows. Receives only the serializable `userId` (no function props
 * across the RSC boundary); the action is imported directly.
 */
export function KickRefetchButton({ userId }: { userId: string }) {
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  function onClick() {
    startTransition(async () => {
      try {
        const res = await refetchCreatorKick(userId);
        if (!res.ok) {
          toast.error(
            res.reason === "no_handle"
              ? "No Kick handle linked — add one on the Creator tab first."
              : "Could not refetch Kick data.",
          );
          return;
        }
        if (res.noKeyConfigured) {
          toast.error("Kick API key not configured — set it in Hub Settings.");
          return;
        }
        toast.success("Kick data refreshed");
        // The server action already revalidated the route; refresh the client
        // cache so the streamed tab re-reads the new cached rows immediately.
        router.refresh();
      } catch (err) {
        toast.error(
          err instanceof Error ? err.message : "Could not refetch Kick data.",
        );
      }
    });
  }

  return (
    <Button
      type="button"
      size="sm"
      variant="outline"
      onClick={onClick}
      disabled={isPending}
    >
      {isPending ? (
        <Loader2 className="mr-1.5 size-3.5 animate-spin" />
      ) : (
        <RefreshCw className="mr-1.5 size-3.5" />
      )}
      Refetch
    </Button>
  );
}
