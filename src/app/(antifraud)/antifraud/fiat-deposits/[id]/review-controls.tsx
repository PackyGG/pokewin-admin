"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import {
  CircleCheck,
  CirclePlay,
  ShieldAlert,
} from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import type {
  FiatReviewAction,
  FiatReviewStatus,
} from "@/lib/antifraud/fiat-deposits-api";
import { setFiatReviewState } from "../actions";

const actions: Array<{
  key: FiatReviewAction;
  label: string;
  success: string;
  icon: React.ElementType;
  variant: "default" | "outline" | "destructive";
}> = [
  { key: "start_review", label: "Start review", success: "Review started", icon: CirclePlay, variant: "default" },
  { key: "clear", label: "Clear", success: "Deposit cleared", icon: CircleCheck, variant: "outline" },
  { key: "recommend_hold", label: "Recommend hold", success: "Hold recommendation recorded", icon: ShieldAlert, variant: "destructive" },
];

export function FiatReviewControls({
  depositIntentId,
  status,
}: {
  depositIntentId: string;
  status: FiatReviewStatus;
}) {
  const router = useRouter();
  const [note, setNote] = React.useState("");
  const [pending, setPending] = React.useState<FiatReviewAction | null>(null);
  const attempt = React.useRef<{
    action: FiatReviewAction;
    note: string;
    key: string;
  } | null>(null);

  async function apply(action: FiatReviewAction, success: string) {
    const trimmed = note.trim();
    if (action !== "start_review" && trimmed.length < 4) {
      toast.error("Write what you concluded first");
      return;
    }
    if (attempt.current?.action !== action || attempt.current.note !== trimmed) {
      attempt.current = { action, note: trimmed, key: crypto.randomUUID() };
    }
    setPending(action);
    try {
      await setFiatReviewState({
        depositIntentId,
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
      toast.error(error instanceof Error ? error.message : "The review could not be saved");
    } finally {
      setPending(null);
    }
  }

  return (
    <div className="space-y-4 rounded-xl border border-border/60 bg-card p-4">
      <div>
        <p className="text-sm font-semibold">Analyst decision</p>
        <p className="mt-1 text-xs leading-5 text-muted-foreground">
          Records a fraud recommendation and audit trail. It does not refund,
          freeze, or move customer money.
        </p>
      </div>
      <div className="space-y-1.5">
        <Label htmlFor="fiat-review-note">Review note</Label>
        <Textarea
          id="fiat-review-note"
          value={note}
          onChange={(event) => setNote(event.target.value)}
          rows={4}
          maxLength={1_000}
          placeholder="What evidence did you check, and what did you conclude?"
        />
        <p className="text-[11px] text-muted-foreground">
          A conclusion is required to clear or recommend a hold.
        </p>
      </div>
      <div className="grid gap-2 sm:grid-cols-2">
        {actions.map((action) => {
          const Icon = action.icon;
          const current =
            (action.key === "start_review" && status === "in_review") ||
            (action.key === "clear" && status === "cleared") ||
            (action.key === "recommend_hold" && status === "hold_recommended");
          return (
            <Button
              key={action.key}
              type="button"
              variant={action.variant}
              disabled={pending !== null || current}
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
