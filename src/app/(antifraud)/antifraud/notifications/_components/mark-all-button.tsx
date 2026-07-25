"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { CheckCheck } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { markAllNotificationsRead } from "@/components/notification-bell-actions";

/** Clears the unread state on every notification in your own inbox. */
export function MarkAllButton({ disabled }: { disabled?: boolean }) {
  const router = useRouter();
  const [pending, setPending] = React.useState(false);

  return (
    <Button
      size="sm"
      variant="outline"
      disabled={pending || disabled}
      onClick={async () => {
        setPending(true);
        try {
          await markAllNotificationsRead();
          toast.success("All caught up");
          router.refresh();
        } catch (err) {
          toast.error(err instanceof Error ? err.message : "Could not update");
        } finally {
          setPending(false);
        }
      }}
    >
      <CheckCheck className="mr-2 size-4" />
      {pending ? "Working…" : "Mark all read"}
    </Button>
  );
}
