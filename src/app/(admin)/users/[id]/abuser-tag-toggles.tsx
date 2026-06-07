"use client";

import { useState } from "react";
import { toast } from "sonner";
import { ShieldAlert } from "lucide-react";
import { Label } from "@/components/ui/label";
import { setUserTag } from "./actions";

export type AbuserTagValue = "wager_abuser" | "fraud_abuser";

export type AbuserTagState = {
  wager: boolean;
  fraud: boolean;
  setWager: (v: boolean) => void;
  setFraud: (v: boolean) => void;
  /** The tag keys currently toggled on. */
  selected: AbuserTagValue[];
  reset: () => void;
};

/**
 * Shared state for the optional "flag this user as Wager/Fraud Abuser"
 * control reused across the admin removal dialogs (inventory item, bulk
 * inventory, voucher) and the balance-adjust dialog. The tag is the SAME
 * persistent user-profile flag shown on the Tags panel + Creator Hub
 * Wager/Fraud Abusers page — applied alongside whatever action the dialog
 * performs.
 */
export function useAbuserTags(): AbuserTagState {
  const [wager, setWager] = useState(false);
  const [fraud, setFraud] = useState(false);
  const selected: AbuserTagValue[] = [];
  if (wager) selected.push("wager_abuser");
  if (fraud) selected.push("fraud_abuser");
  return {
    wager,
    fraud,
    setWager,
    setFraud,
    selected,
    reset: () => {
      setWager(false);
      setFraud(false);
    },
  };
}

/**
 * Apply the selected abuser tags to a user. Non-fatal: tagging failures
 * surface a soft warning (the primary action already succeeded) rather
 * than throwing.
 */
export async function applyAbuserTags(
  userId: string,
  tags: AbuserTagValue[],
): Promise<void> {
  for (const t of tags) {
    const r = await setUserTag(userId, t);
    if (!r.success) {
      toast.warning(`Couldn't tag (${t.replace("_", " ")}): ${r.error}`);
    }
  }
}

export function AbuserTagToggles({
  state,
  disabled,
}: {
  state: AbuserTagState;
  disabled?: boolean;
}) {
  return (
    <div className="space-y-1.5">
      <Label className="text-xs text-muted-foreground">
        Flag user (optional)
      </Label>
      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          disabled={disabled}
          onClick={() => state.setWager(!state.wager)}
          className={`inline-flex items-center gap-1 rounded-md border px-2.5 py-1 text-xs font-medium transition-colors disabled:opacity-50 ${
            state.wager
              ? "border-red-500/40 bg-red-500/15 text-red-700 dark:text-red-300"
              : "border-border text-muted-foreground hover:bg-muted"
          }`}
        >
          <ShieldAlert className="size-3.5" />
          Wager Abuser
        </button>
        <button
          type="button"
          disabled={disabled}
          onClick={() => state.setFraud(!state.fraud)}
          className={`inline-flex items-center gap-1 rounded-md border px-2.5 py-1 text-xs font-medium transition-colors disabled:opacity-50 ${
            state.fraud
              ? "border-rose-600/40 bg-rose-600/15 text-rose-800 dark:text-rose-300"
              : "border-border text-muted-foreground hover:bg-muted"
          }`}
        >
          <ShieldAlert className="size-3.5" />
          Fraud Abuser
        </button>
      </div>
    </div>
  );
}
