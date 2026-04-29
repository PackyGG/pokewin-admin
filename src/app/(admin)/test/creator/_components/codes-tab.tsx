"use client";

import { useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

import { getActiveCodeAction, setActiveCodeAction } from "../actions";

type CodeRow = {
  user_id: string;
  affiliate_code: string | null;
  affiliate_code_active: boolean;
};

export function CodesTab() {
  const [userId, setUserId] = useState("");
  const [codeInput, setCodeInput] = useState("");
  const [current, setCurrent] = useState<CodeRow | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();

  const fetchCurrent = (id: string) => {
    setError(null);
    startTransition(async () => {
      const res = await getActiveCodeAction(id);
      if (!res.success) {
        setError(res.error);
        setCurrent(null);
        return;
      }
      setCurrent(res.data ?? null);
    });
  };

  const setCode = (code: string | null) => {
    if (!userId.trim()) {
      setError("user id required");
      return;
    }
    setError(null);
    startTransition(async () => {
      const res = await setActiveCodeAction({
        user_id: userId.trim(),
        code,
      });
      if (!res.success) {
        setError(res.error);
        return;
      }
      setCurrent(res.data ?? null);
      if (code === null) setCodeInput("");
    });
  };

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <Label className="text-xs uppercase tracking-wider text-muted-foreground">
          Target user id
        </Label>
        <div className="flex gap-2">
          <Input
            placeholder="user id"
            value={userId}
            onChange={(e) => setUserId(e.target.value)}
            className="max-w-md"
          />
          <Button
            variant="outline"
            disabled={pending || !userId.trim()}
            onClick={() => fetchCurrent(userId.trim())}
          >
            Read current
          </Button>
        </div>
      </div>

      {current && (
        <div className="rounded-md border bg-muted/40 p-3 text-sm space-y-1">
          <div>
            user_id: <span className="font-mono">{current.user_id}</span>
          </div>
          <div>
            active code:{" "}
            <span className="font-mono">
              {current.affiliate_code ?? "(none)"}
            </span>
          </div>
          <div>
            active flag:{" "}
            <span className="font-mono">
              {current.affiliate_code_active ? "true" : "false"}
            </span>
          </div>
        </div>
      )}

      <div className="space-y-2">
        <Label className="text-xs uppercase tracking-wider text-muted-foreground">
          Override active code
        </Label>
        <div className="flex gap-2">
          <Input
            placeholder="affiliate code (must already exist)"
            value={codeInput}
            onChange={(e) => setCodeInput(e.target.value)}
            className="max-w-md"
          />
          <Button
            disabled={pending || !codeInput.trim()}
            onClick={() => setCode(codeInput.trim())}
          >
            Set
          </Button>
          <Button
            variant="outline"
            disabled={pending}
            onClick={() => setCode(null)}
          >
            Clear
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          The new code must already exist in <span className="font-mono">affiliate_codes</span>.
          The user&apos;s wagers from this point will be attributed to it; any active
          leaderboard listing this code will start counting them on the next refresh tick
          (every 60s).
        </p>
      </div>

      {error && <p className="text-sm text-destructive">{error}</p>}
    </div>
  );
}
