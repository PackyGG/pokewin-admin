"use client";

import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Fingerprint, Check } from "lucide-react";
import {
  startAuthentication,
  browserSupportsWebAuthn,
} from "@simplewebauthn/browser";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Spinner } from "@/components/ux";
import {
  hasMyPasskeys,
  startPasskeyStepUp,
  verifyPasskeyStepUp,
} from "@/lib/passkey-step-up-actions";

// ---------------------------------------------------------------------------
// Shared second-factor field for privileged-action dialogs. Drop-in replacement
// for the hand-rolled "2FA code" <Input> that these dialogs used to duplicate:
// it renders the same authenticator-code input AND — for admins who have a
// passkey — a "Use a passkey" button.
//
// The field's string value is whatever should be submitted to the action's 2FA
// argument: the typed 6-digit code, OR (after a passkey assertion) a short-lived
// step-up proof token. Because passkey mode yields a NON-EMPTY string too, every
// existing dialog's `if (!code.trim())` guard, submit, and action call keep
// working unchanged — swap the input for <StepUpField> and nothing else moves.
//
// require2FA on the server accepts either form. See passkey-step-up-actions.ts.
// ---------------------------------------------------------------------------

export function StepUpField({
  value,
  onChange,
  label = "2FA code",
  disabled = false,
  autoFocus = false,
  id,
}: {
  /** Current field value — the typed code or a passkey proof token. */
  value: string;
  /** Called with the new value (bare string, not an event). */
  onChange: (value: string) => void;
  label?: string;
  disabled?: boolean;
  autoFocus?: boolean;
  id?: string;
}) {
  const [offerPasskey, setOfferPasskey] = useState(false);
  const [pending, setPending] = useState(false);
  // True once a passkey assertion succeeded and `value` holds its proof token.
  const [verified, setVerified] = useState(false);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    // Only offer the passkey path when the browser supports WebAuthn AND this
    // admin actually has a registered passkey — otherwise the button would just
    // error on click. Fetched lazily on mount (the dialog is already open).
    if (browserSupportsWebAuthn()) {
      hasMyPasskeys()
        .then((has) => {
          if (mounted.current) setOfferPasskey(has);
        })
        .catch(() => {
          /* stay hidden — TOTP still works */
        });
    }
    return () => {
      mounted.current = false;
    };
  }, []);

  // If the parent clears the value (e.g. resets the field after a successful
  // submit) while we're showing the passkey-verified state, drop back to the
  // code input. Matters for always-mounted usages (an inline Card, not a Dialog
  // that unmounts on close) — otherwise it keeps showing "Verified" over an
  // empty value and the next action can't be authorized.
  useEffect(() => {
    if (verified && value === "") setVerified(false);
  }, [verified, value]);

  async function handlePasskey() {
    setPending(true);
    try {
      const optionsJSON = await startPasskeyStepUp();
      const response = await startAuthentication({ optionsJSON });
      const { token } = await verifyPasskeyStepUp(response);
      onChange(token);
      setVerified(true);
    } catch (err) {
      if (err instanceof Error && err.name === "NotAllowedError") {
        toast.error("Passkey verification was cancelled.");
      } else {
        toast.error(
          err instanceof Error ? err.message : "Could not verify passkey.",
        );
      }
    } finally {
      if (mounted.current) setPending(false);
    }
  }

  function reset() {
    setVerified(false);
    onChange("");
  }

  if (verified) {
    return (
      <div className="space-y-2">
        <Label>{label}</Label>
        <div className="flex items-center justify-between rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm">
          <span className="flex items-center gap-2 font-medium text-emerald-600 dark:text-emerald-400">
            <Check className="size-4" />
            Verified with passkey
          </span>
          <button
            type="button"
            onClick={reset}
            disabled={disabled}
            className="text-xs text-muted-foreground underline underline-offset-4 hover:text-foreground disabled:opacity-50"
          >
            Use a code instead
          </button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-2">
      <Label htmlFor={id}>{label}</Label>
      <Input
        id={id}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder="6-digit authenticator code"
        autoComplete="one-time-code"
        inputMode="numeric"
        disabled={disabled || pending}
        autoFocus={autoFocus}
      />
      {offerPasskey && (
        <button
          type="button"
          onClick={handlePasskey}
          disabled={disabled || pending}
          className="flex items-center gap-1.5 text-xs text-muted-foreground underline-offset-4 hover:text-foreground hover:underline disabled:opacity-50"
        >
          {pending ? (
            <Spinner size={12} className="text-current" />
          ) : (
            <Fingerprint className="size-3.5" />
          )}
          {pending ? "Waiting for passkey…" : "Use a passkey instead"}
        </button>
      )}
    </div>
  );
}
