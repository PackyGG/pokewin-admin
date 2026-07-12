"use client";

import { useActionState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { confirmSetup, type SetupState } from "./actions";
import Image from "next/image";

export function SetupForm({
  qrCodeDataUrl,
}: {
  qrCodeDataUrl: string;
}) {
  const [state, formAction, pending] = useActionState(confirmSetup, {} as SetupState);

  const hasRecoveryCodes = state?.recoveryCodes && state.recoveryCodes.length > 0;

  return (
    <div className="space-y-6">
      {!hasRecoveryCodes && (
        <>
          {/* QR Code — kept on a white tile so the code stays scannable. */}
          <div className="flex justify-center">
            <div className="rounded-lg border border-border bg-white p-3">
              <Image src={qrCodeDataUrl} alt="TOTP QR Code" width={200} height={200} />
            </div>
          </div>

          {/* Verification form */}
          <form action={formAction} className="space-y-4">
            <input type="hidden" name="step" value="verify" />
            {state?.error && (
              <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
                {state.error}
              </div>
            )}

            <div className="space-y-2">
              <Label htmlFor="code" className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
                Enter the 6-digit code from your app
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
                className="h-12 text-center text-lg font-mono tracking-[0.35em]"
              />
            </div>

            <Button
              type="submit"
              disabled={pending}
              className="h-11 w-full text-sm font-semibold"
            >
              {pending ? "Verifying..." : "Verify & Enable 2FA"}
            </Button>
          </form>
        </>
      )}

      {hasRecoveryCodes && (
        <>
          {/* Recovery codes display */}
          <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 p-4">
            <p className="mb-2 text-sm font-semibold text-amber-400">
              Save your recovery codes
            </p>
            <p className="mb-3 text-xs text-muted-foreground">
              Store these codes in a safe place. Each can only be used once. You won&apos;t be able to see them again.
            </p>
            <div className="grid grid-cols-2 gap-2">
              {state.recoveryCodes!.map((code) => (
                <code key={code} className="rounded border border-border bg-muted px-2 py-1 text-center text-xs font-mono text-foreground">
                  {code}
                </code>
              ))}
            </div>
          </div>

          {/* Confirm button */}
          <form action={formAction}>
            <input type="hidden" name="step" value="confirm" />
            <Button
              type="submit"
              disabled={pending}
              className="h-11 w-full text-sm font-semibold"
            >
              {pending ? "Redirecting..." : "I've saved my recovery codes"}
            </Button>
          </form>
        </>
      )}
    </div>
  );
}
