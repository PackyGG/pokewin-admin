"use client";

import { useState, useTransition } from "react";
import { Check, Loader2, X } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  approveCreatorSocial,
  rejectCreatorSocial,
} from "../backend-actions";

export function SocialReviewActions({ socialId }: { socialId: string }) {
  const [pending, startTransition] = useTransition();
  const [rejecting, setRejecting] = useState(false);
  const [reason, setReason] = useState("");

  const onApprove = () => {
    startTransition(async () => {
      try {
        await approveCreatorSocial(socialId);
        toast.success("Approved");
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Approve failed");
      }
    });
  };

  const onReject = () => {
    if (!rejecting) {
      setRejecting(true);
      return;
    }
    startTransition(async () => {
      try {
        await rejectCreatorSocial(socialId, {
          reason: reason.trim() || undefined,
        });
        toast.success("Rejected");
        setRejecting(false);
        setReason("");
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Reject failed");
      }
    });
  };

  return (
    <div className="flex flex-col items-stretch gap-2 md:flex-row md:items-center">
      {rejecting && (
        <input
          type="text"
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Reason (optional)"
          maxLength={500}
          className="h-8 w-full rounded-md border bg-background px-2 text-xs outline-none focus:border-foreground/40 md:w-56"
        />
      )}
      <div className="flex items-center gap-2">
        <Button
          size="sm"
          variant="default"
          onClick={onApprove}
          disabled={pending}
        >
          {pending ? (
            <Loader2 className="size-3.5 animate-spin" />
          ) : (
            <Check className="size-3.5" />
          )}
          Approve
        </Button>
        <Button
          size="sm"
          variant="outline"
          onClick={onReject}
          disabled={pending}
        >
          <X className="size-3.5" />
          {rejecting ? "Confirm reject" : "Reject"}
        </Button>
        {rejecting && !pending && (
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setRejecting(false);
              setReason("");
            }}
          >
            Cancel
          </Button>
        )}
      </div>
    </div>
  );
}
