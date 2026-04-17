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
          {/* QR Code */}
          <div className="flex justify-center">
            <div className="rounded-lg bg-white p-3">
              <Image src={qrCodeDataUrl} alt="TOTP QR Code" width={200} height={200} />
            </div>
          </div>

          {/* Verification form */}
          <form action={formAction} className="space-y-4">
            <input type="hidden" name="step" value="verify" />
            {state?.error && (
              <div className="rounded-lg bg-destructive/10 px-4 py-3 text-sm text-destructive">
                {state.error}
              </div>
            )}

            <div className="space-y-2">
              <Label htmlFor="code" className="text-sm font-medium">
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
                className="h-12 rounded-lg border-white/10 bg-white/5 px-4 text-center text-lg font-mono tracking-widest placeholder:text-muted-foreground/50"
              />
            </div>

            <Button
              type="submit"
              disabled={pending}
              className="h-12 w-full rounded-lg bg-primary text-sm font-semibold text-primary-foreground hover:bg-primary/90"
            >
              {pending ? "Verifying..." : "Verify & Enable 2FA"}
            </Button>
          </form>
        </>
      )}

      {hasRecoveryCodes && (
        <>
          {/* Recovery codes display */}
          <div className="rounded-lg border border-yellow-500/30 bg-yellow-500/10 p-4">
            <p className="mb-2 text-sm font-semibold text-yellow-400">
              Save your recovery codes
            </p>
            <p className="mb-3 text-xs text-muted-foreground">
              Store these codes in a safe place. Each can only be used once. You won&apos;t be able to see them again.
            </p>
            <div className="grid grid-cols-2 gap-2">
              {state.recoveryCodes!.map((code) => (
                <code key={code} className="rounded bg-white/5 px-2 py-1 text-center text-xs font-mono">
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
              className="h-12 w-full rounded-lg bg-primary text-sm font-semibold text-primary-foreground hover:bg-primary/90"
            >
              {pending ? "Redirecting..." : "I've saved my recovery codes"}
            </Button>
          </form>
        </>
      )}
    </div>
  );
}
