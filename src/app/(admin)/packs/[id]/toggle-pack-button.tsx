"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import { togglePackActive } from "../actions";

export function TogglePackButton({ packId, active }: { packId: string; active: boolean }) {
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
            toast.success(active ? "Pack deactivated" : "Pack activated");
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
