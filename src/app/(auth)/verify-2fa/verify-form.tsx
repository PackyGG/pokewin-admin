"use client";

import { useActionState, useState } from "react";
import { Fingerprint } from "lucide-react";
import { startAuthentication } from "@simplewebauthn/browser";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { verify2FA, startPasskeyLogin, verifyPasskeyLogin } from "./actions";

export function VerifyForm({ hasPasskeys = false }: { hasPasskeys?: boolean }) {
  const [state, formAction, pending] = useActionState(verify2FA, {});
  const [useRecovery, setUseRecovery] = useState(false);
  const [passkeyPending, setPasskeyPending] = useState(false);
  const [passkeyError, setPasskeyError] = useState<string | null>(null);

  async function handlePasskey() {
    setPasskeyError(null);
    setPasskeyPending(true);
    try {
      const optionsJSON = await startPasskeyLogin();
      const response = await startAuthentication({ optionsJSON });
      // On success this redirects (NEXT_REDIRECT); only an error returns here.
      const result = await verifyPasskeyLogin(response);
      if (result?.error) {
        setPasskeyError(result.error);
        setPasskeyPending(false);
      }
    } catch (err) {
      if (err instanceof Error && err.name === "NotAllowedError") {
        setPasskeyError("Passkey sign-in was cancelled.");
      } else {
        setPasskeyError(
          err instanceof Error ? err.message : "Could not sign in with passkey.",
        );
      }
      setPasskeyPending(false);
    }
  }

  return (
    <div className="space-y-6">
      <form action={formAction} className="space-y-6">
        {(state?.error || passkeyError) && (
          <div className="rounded-lg bg-destructive/10 px-4 py-3 text-sm text-destructive">
            {state?.error || passkeyError}
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
          disabled={pending || passkeyPending}
          className="h-12 w-full rounded-lg bg-primary text-sm font-semibold text-primary-foreground hover:bg-primary/90"
        >
          {pending ? "Verifying..." : "Verify"}
        </Button>
      </form>

      {hasPasskeys && !useRecovery && (
        <>
          <div className="flex items-center gap-3 text-xs text-muted-foreground">
            <span className="h-px flex-1 bg-white/10" />
            or
            <span className="h-px flex-1 bg-white/10" />
          </div>
          <Button
            type="button"
            variant="outline"
            onClick={handlePasskey}
            disabled={pending || passkeyPending}
            className="h-12 w-full rounded-lg border-white/10 bg-white/5 text-sm font-semibold hover:bg-white/10"
          >
            <Fingerprint className="size-4" />
            {passkeyPending ? "Waiting for passkey..." : "Use a passkey"}
          </Button>
        </>
      )}

      <div className="text-center">
        <button
          type="button"
          onClick={() => setUseRecovery(!useRecovery)}
          className="text-xs text-muted-foreground hover:text-foreground underline"
        >
          {useRecovery ? "Use authenticator code instead" : "Use a recovery code"}
        </button>
      </div>
    </div>
  );
}
