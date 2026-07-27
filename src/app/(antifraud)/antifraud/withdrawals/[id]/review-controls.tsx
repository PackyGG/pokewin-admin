"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  CircleCheck,
  CirclePlay,
  ShieldAlert,
  TriangleAlert,
} from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type {
  WithdrawalReviewAction,
  WithdrawalReviewStatus,
} from "@/lib/antifraud/withdrawals-api";
import { setWithdrawalReviewState } from "../actions";

const actions: {
  key: WithdrawalReviewAction;
  label: string;
  success: string;
  icon: React.ElementType;
  variant: "default" | "outline" | "destructive";
}[] = [
  {
    key: "start_review",
    label: "Start review",
    success: "Review started",
    icon: CirclePlay,
    variant: "default",
  },
  {
    key: "clear",
    label: "Clear",
    success: "Withdrawal risk cleared",
    icon: CircleCheck,
    variant: "outline",
  },
  {
    key: "escalate",
    label: "Escalate",
    success: "Withdrawal escalated",
    icon: TriangleAlert,
    variant: "outline",
  },
  {
    key: "recommend_block",
    label: "Recommend block",
    success: "Block recommendation recorded",
    icon: ShieldAlert,
    variant: "destructive",
  },
];

export function WithdrawalReviewControls({
  withdrawalId,
  status,
}: {
  withdrawalId: string;
  status: WithdrawalReviewStatus;
}) {
  const router = useRouter();
  const [note, setNote] = React.useState("");
  const [pending, setPending] = React.useState<WithdrawalReviewAction | null>(
    null,
  );
  const attempt = React.useRef<{
    action: WithdrawalReviewAction;
    note: string;
    key: string;
  } | null>(null);

  async function apply(action: WithdrawalReviewAction, success: string) {
    const trimmed = note.trim();
    if (action !== "start_review" && trimmed.length < 4) {
      toast.error("Write what you concluded first");
      return;
    }
    if (
      attempt.current?.action !== action ||
      attempt.current.note !== trimmed
    ) {
      attempt.current = {
        action,
        note: trimmed,
        key: crypto.randomUUID(),
      };
    }
    setPending(action);
    try {
      await setWithdrawalReviewState({
        withdrawalId,
        action,
        note: trimmed,
        expectedStatus: status,
        idempotencyKey: attempt.current.key,
      });
      attempt.current = null;
      setNote("");
      toast.success(success);
      router.refresh();
    } catch (error) {
      toast.error(
        error instanceof Error ? error.message : "The review could not be saved",
      );
    } finally {
      setPending(null);
    }
  }

  return (
    <div className="space-y-4 rounded-xl border bg-card p-4">
      <div>
        <p className="text-sm font-semibold">Analyst decision</p>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">
          This records the fraud recommendation and review trail. It does not
          move money or change the withdrawal in the customer database.
        </p>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="withdrawal-review-note">Review note</Label>
        <Textarea
          id="withdrawal-review-note"
          value={note}
          onChange={(event) => setNote(event.target.value)}
          rows={4}
          maxLength={1_000}
          placeholder="What did you check, and why is this safe or suspicious?"
        />
        <p className="text-[11px] text-muted-foreground">
          A written conclusion is required to clear, escalate, or recommend a
          block.
        </p>
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        {actions.map((action) => {
          const Icon = action.icon;
          const isCurrent =
            (action.key === "start_review" && status === "in_review") ||
            (action.key === "clear" && status === "cleared") ||
            (action.key === "escalate" && status === "escalated") ||
            (action.key === "recommend_block" &&
              status === "block_recommended");
          return (
            <Button
              key={action.key}
              type="button"
              variant={action.variant}
              disabled={pending !== null || isCurrent}
              onClick={() => void apply(action.key, action.success)}
            >
              <Icon className="size-4" />
              {pending === action.key ? "Saving…" : action.label}
            </Button>
          );
        })}
      </div>
    </div>
  );
}
