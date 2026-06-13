"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { togglePackActive } from "../actions";
import { invalidatePackDetailCache } from "../pack-detail-cache";

export function TogglePackButton({
  packId,
  active,
  onToggled,
}: {
  packId: string;
  active: boolean;
  onToggled?: () => void;
}) {
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  return (
    <Button
      variant={active ? "destructive" : "default"}
      size="sm"
      disabled={isPending}
      onClick={() => {
        startTransition(async () => {
          try {
            await togglePackActive(packId, !active);
            invalidatePackDetailCache(packId);
            toast.success(active ? "Pack deactivated" : "Pack activated");
            onToggled?.();
            router.refresh();
          } catch (e) {
            toast.error(e instanceof Error ? e.message : "Failed");
          }
        });
      }}
    >
      {active ? "Deactivate" : "Activate"}
    </Button>
  );
}
