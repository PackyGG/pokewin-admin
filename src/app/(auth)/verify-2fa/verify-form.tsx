"use client";

import { useActionState, useState } from "react";
import { Fingerprint } from "lucide-react";
import { startAuthentication } from "@simplewebauthn/browser";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { verify2FA, startPasskeyLogin, verifyPasskeyLogin } from "./actions";
import { PASSKEY_SIGNIN_FAILED_HINT } from "@/lib/passkey-migration";

export function VerifyForm({ hasPasskeys = false }: { hasPasskeys?: boolean }) {
  const [state, formAction, pending] = useActionState(verify2FA, {});
  const [useRecovery, setUseRecovery] = useState(false);
  const [passkeyPending, setPasskeyPending] = useState(false);
  const [passkeyError, setPasskeyError] = useState<string | null>(null);
  /**
   * Set when a passkey attempt failed for a reason consistent with the
   * packydash.com RP-ID cutover — the browser had no usable credential, or the
   * server rejected the one it got. We can't know WHICH credential was tried
   * (the browser picks silently), so this surfaces the likely cause plus the
   * route that definitely works, instead of leaving someone staring at a bare
   * "could not sign in".
   *
   * Deliberately NOT shown for a user-cancelled prompt — that's a deliberate
   * action, not a failure.
   */
  const [showMigrationHint, setShowMigrationHint] = useState(false);

  async function handlePasskey() {
    setPasskeyError(null);
    setShowMigrationHint(false);
    setPasskeyPending(true);
    try {
      const optionsJSON = await startPasskeyLogin();
      const response = await startAuthentication({ optionsJSON });
      const result = await verifyPasskeyLogin(response);
      if (result?.redirectTo) {
        // Full-page navigation (NOT a soft router.replace): verifyPasskeyLogin
        // just minted the real admin_session cookie server-side. A soft App
        // Router nav can race that Set-Cookie and be served a stale,
        // unauthenticated RSC cache, so middleware bounces the user back here
        // (the reported "stuck on /verify-2fa until manual reload" bug). A hard
        // navigation guarantees middleware re-runs with the committed cookie.
        // We intentionally do NOT clear passkeyPending here, so the button
        // stays disabled / "Waiting for passkey…" until the page unloads.
        window.location.assign(result.redirectTo);
        return;
      }
      if (result?.error) {
        setPasskeyError(result.error);
        // The server had a credential but wouldn't accept it — the classic
        // shape of an old-domain passkey.
        setShowMigrationHint(true);
      }
      setPasskeyPending(false);
    } catch (err) {
      if (err instanceof Error && err.name === "NotAllowedError") {
        // Covers BOTH a deliberate cancel and "the browser found nothing it
        // could offer for this domain" — which is exactly what a pre-cutover
        // passkey looks like from here, since the browser never even shows it.
        // The copy has to work for both readings.
        setPasskeyError(
          "Passkey sign-in was cancelled, or your browser had no passkey for this domain.",
        );
        setShowMigrationHint(true);
      } else {
        setPasskeyError(
          err instanceof Error ? err.message : "Could not sign in with passkey.",
        );
        setShowMigrationHint(true);
      }
      setPasskeyPending(false);
    }
  }

  return (
    <div className="space-y-6">
      <form action={formAction} className="space-y-5">
        {(state?.error || passkeyError) && (
          <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
            {state?.error || passkeyError}
          </div>
        )}
        {/* Domain-move explainer. Amber, not destructive: nothing is wrong with
            the account and the way in is one field below — this is guidance,
            not another error. */}
        {showMigrationHint && (
          <div className="rounded-lg border border-amber-500/30 bg-amber-500/10 px-4 py-3 text-xs leading-relaxed text-amber-700 dark:text-amber-400">
            {PASSKEY_SIGNIN_FAILED_HINT}
          </div>
        )}

        {!useRecovery ? (
          <div className="space-y-2">
            <Label htmlFor="code" className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
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
              className="h-12 text-center text-lg font-mono tracking-[0.35em]"
            />
          </div>
        ) : (
          <div className="space-y-2">
            <Label htmlFor="recoveryCode" className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
              Recovery Code
            </Label>
            <Input
              id="recoveryCode"
              name="recoveryCode"
              type="text"
              placeholder="Enter recovery code"
              required
              className="h-12 text-center text-sm font-mono tracking-[0.2em]"
            />
          </div>
        )}

        <input type="hidden" name="mode" value={useRecovery ? "recovery" : "totp"} />

        <Button
          type="submit"
          disabled={pending || passkeyPending}
          className="h-11 w-full text-sm font-semibold"
        >
          {pending ? "Verifying..." : "Verify"}
        </Button>
      </form>

      {hasPasskeys && !useRecovery && (
        <>
          <div className="flex items-center gap-3 text-xs text-muted-foreground">
            <span className="h-px flex-1 bg-border" />
            or
            <span className="h-px flex-1 bg-border" />
          </div>
          <Button
            type="button"
            variant="outline"
            onClick={handlePasskey}
            disabled={pending || passkeyPending}
            className="h-11 w-full text-sm font-semibold"
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
          className="text-xs text-muted-foreground underline underline-offset-4 hover:text-foreground"
        >
          {useRecovery ? "Use authenticator code instead" : "Use a recovery code"}
        </button>
      </div>
    </div>
  );
}
