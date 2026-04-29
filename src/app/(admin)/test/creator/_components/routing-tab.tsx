"use client";

import { useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

import {
  injectWagerAction,
  setActiveCodeAction,
} from "../actions";

/**
 * Wager-routing playground. Two operations live here so they can be
 * sequenced without tab-flipping:
 *
 *   1. Switch a user's active affiliate code so their organic wagers
 *      from now on flow to whichever creator owns that code.
 *   2. Inject synthetic wager rows directly so a leaderboard tied to a
 *      code can be ranked without spinning up real game sessions.
 */
export function RoutingTab() {
  const [userId, setUserId] = useState("");
  const [code, setCode] = useState("");
  const [amount, setAmount] = useState("100");
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [lastResult, setLastResult] = useState<string | null>(null);

  const redirect = () => {
    setError(null);
    setLastResult(null);
    if (!userId.trim() || !code.trim()) {
      setError("user id and code are required");
      return;
    }
    startTransition(async () => {
      const res = await setActiveCodeAction({
        user_id: userId.trim(),
        code: code.trim(),
      });
      if (!res.success) {
        setError(res.error);
        return;
      }
      setLastResult(
        `Active code for ${res.data?.user_id} → ${res.data?.affiliate_code ?? "(none)"}`,
      );
    });
  };

  const inject = () => {
    setError(null);
    setLastResult(null);
    if (!userId.trim() || !code.trim() || !amount) {
      setError("user id, code, and amount are required");
      return;
    }
    const numAmount = Number(amount);
    if (!Number.isFinite(numAmount) || numAmount <= 0) {
      setError("amount must be a positive number");
      return;
    }
    startTransition(async () => {
      const res = await injectWagerAction({
        referred_user_id: userId.trim(),
        code: code.trim(),
        wager_amount_usd: numAmount,
      });
      if (!res.success) {
        setError(res.error);
        return;
      }
      setLastResult(
        `Injected $${res.data?.wager_amount_usd.toFixed(2)} on code ${res.data?.code} for ${res.data?.referred_user_id}`,
      );
    });
  };

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-1 gap-2 md:grid-cols-3 max-w-3xl">
        <div className="space-y-1">
          <Label className="text-xs uppercase tracking-wider text-muted-foreground">
            User id
          </Label>
          <Input
            placeholder="user id"
            value={userId}
            onChange={(e) => setUserId(e.target.value)}
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs uppercase tracking-wider text-muted-foreground">
            Affiliate code
          </Label>
          <Input
            placeholder="code"
            value={code}
            onChange={(e) => setCode(e.target.value)}
          />
        </div>
        <div className="space-y-1">
          <Label className="text-xs uppercase tracking-wider text-muted-foreground">
            Wager amount (USD)
          </Label>
          <Input
            type="number"
            value={amount}
            onChange={(e) => setAmount(e.target.value)}
          />
        </div>
      </div>

      <div className="flex flex-wrap gap-2">
        <Button disabled={pending} onClick={redirect}>
          Redirect user → code
        </Button>
        <Button variant="outline" disabled={pending} onClick={inject}>
          Inject wager row
        </Button>
      </div>

      <div className="text-xs text-muted-foreground space-y-1">
        <p>
          <strong>Redirect:</strong> sets the user&apos;s <span className="font-mono">affiliate_code</span> to
          the chosen code. From the next bet onward their wagers count for any active
          leaderboard listing that code.
        </p>
        <p>
          <strong>Inject:</strong> writes a single <span className="font-mono">affiliate_code_usages</span> row
          (no real game session). Useful for seeding leaderboard standings when a real bet
          flow isn&apos;t available. The next refresh tick (~60s) picks it up.
        </p>
      </div>

      {lastResult && <p className="text-sm text-emerald-600">{lastResult}</p>}
      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  );
}
