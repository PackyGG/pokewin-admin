"use client";

import { useActionState, useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { verify2FA } from "./actions";

export function VerifyForm() {
  const [state, formAction, pending] = useActionState(verify2FA, {});
  const [useRecovery, setUseRecovery] = useState(false);

  return (
    <form action={formAction} className="space-y-6">
      {state?.error && (
        <div className="rounded-lg bg-destructive/10 px-4 py-3 text-sm text-destructive">
          {state.error}
        </div>
      )}

      {!useRecovery ? (
        <div className="space-y-2">
          <Label htmlFor="code" className="text-sm font-medium">
            Authentication Code
          </Label>
          <Input
            id="code"
            name="code"
            type="text"
            inputMode="numeric"
            pattern="[0-9]{6}"
            maxLength={6}
            placeholder="000000"
            required
            autoComplete="one-time-code"
            className="h-12 rounded-lg border-white/10 bg-white/5 px-4 text-center text-lg font-mono tracking-widest placeholder:text-muted-foreground/50"
          />
        </div>
      ) : (
        <div className="space-y-2">
          <Label htmlFor="recoveryCode" className="text-sm font-medium">
            Recovery Code
          </Label>
          <Input
            id="recoveryCode"
            name="recoveryCode"
            type="text"
            placeholder="Enter recovery code"
            required
            className="h-12 rounded-lg border-white/10 bg-white/5 px-4 text-center text-sm font-mono tracking-widest placeholder:text-muted-foreground/50"
          />
        </div>
      )}

      <input type="hidden" name="mode" value={useRecovery ? "recovery" : "totp"} />

      <Button
        type="submit"
        disabled={pending}
        className="h-12 w-full rounded-lg bg-primary text-sm font-semibold text-primary-foreground hover:bg-primary/90"
      >
        {pending ? "Verifying..." : "Verify"}
      </Button>

      <div className="text-center">
        <button
          type="button"
          onClick={() => setUseRecovery(!useRecovery)}
          className="text-xs text-muted-foreground hover:text-foreground underline"
        >
          {useRecovery ? "Use authenticator code instead" : "Use a recovery code"}
        </button>
      </div>
    </form>
  );
}
