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
  getMyPasskeyStepUpState,
  startPasskeyStepUp,
  verifyPasskeyStepUp,
} from "@/lib/passkey-step-up-actions";
import { PASSKEY_GRACE_CREDENTIAL } from "@/lib/passkey-grace-shared";

/**
 * Shared second-factor field for privileged actions. A passkey normally yields
 * a one-use proof. For admins and owners, the server instead also establishes
 * a signed ten-minute grace window and this field stays approved until expiry.
 */
export function StepUpField({
  value,
  onChange,
  label = "2FA code",
  disabled = false,
  autoFocus = false,
  id,
}: {
  value: string;
  onChange: (value: string) => void;
  label?: string;
  disabled?: boolean;
  autoFocus?: boolean;
  id?: string;
}) {
  const [offerPasskey, setOfferPasskey] = useState(false);
  const [pending, setPending] = useState(false);
  const [verified, setVerified] = useState(false);
  const [graceExpiresAt, setGraceExpiresAt] = useState<number | null>(null);
  const [remainingSeconds, setRemainingSeconds] = useState(0);
  const [useCodeForThisAction, setUseCodeForThisAction] = useState(false);
  const mounted = useRef(true);
  const onChangeRef = useRef(onChange);

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  useEffect(() => {
    mounted.current = true;
    // Read grace even if a new WebAuthn ceremony is unavailable. An existing
    // approval window should still suppress the prompt.
    getMyPasskeyStepUpState()
      .then((state) => {
        if (!mounted.current) return;
        setOfferPasskey(browserSupportsWebAuthn() && state.hasPasskeys);
        if (!state.graceExpiresAt) return;
        const expiresAt = new Date(state.graceExpiresAt).getTime();
        if (expiresAt > Date.now()) {
          setGraceExpiresAt(expiresAt);
          setVerified(true);
          onChangeRef.current(PASSKEY_GRACE_CREDENTIAL);
        }
      })
      .catch(() => {
        // TOTP remains available when the optional state check fails.
      });
    return () => {
      mounted.current = false;
    };
  }, []);

  // Many dialogs clear their code after submitting. Re-arm those fields while
  // grace remains active so the next action does not prompt again.
  useEffect(() => {
    if (!verified || value !== "") return;
    if (
      graceExpiresAt &&
      graceExpiresAt > Date.now() &&
      !useCodeForThisAction
    ) {
      onChangeRef.current(PASSKEY_GRACE_CREDENTIAL);
      return;
    }
    setVerified(false);
  }, [graceExpiresAt, useCodeForThisAction, value, verified]);

  useEffect(() => {
    if (!graceExpiresAt) {
      setRemainingSeconds(0);
      return;
    }
    const updateRemaining = () => {
      const seconds = Math.max(
        0,
        Math.ceil((graceExpiresAt - Date.now()) / 1000),
      );
      setRemainingSeconds(seconds);
      if (seconds === 0) {
        setGraceExpiresAt(null);
        setVerified(false);
        onChangeRef.current("");
      }
    };
    updateRemaining();
    const timer = window.setInterval(updateRemaining, 1000);
    return () => window.clearInterval(timer);
  }, [graceExpiresAt]);

  async function handlePasskey() {
    setPending(true);
    try {
      const optionsJSON = await startPasskeyStepUp();
      const response = await startAuthentication({ optionsJSON });
      const { token, graceExpiresAt: graceExpiry } =
        await verifyPasskeyStepUp(response);
      setUseCodeForThisAction(false);
      if (graceExpiry) {
        setGraceExpiresAt(new Date(graceExpiry).getTime());
        onChange(PASSKEY_GRACE_CREDENTIAL);
      } else {
        onChange(token);
      }
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
    setUseCodeForThisAction(true);
    setGraceExpiresAt(null);
    setVerified(false);
    onChange("");
  }

  const remainingMinutes = Math.floor(remainingSeconds / 60);
  const remainingClockSeconds = String(remainingSeconds % 60).padStart(2, "0");

  if (verified) {
    return (
      <div className="space-y-2">
        <Label>{label}</Label>
        <div className="flex items-center justify-between rounded-md border border-emerald-500/30 bg-emerald-500/10 px-3 py-2 text-sm">
          <span className="flex items-center gap-2 font-medium text-emerald-600 dark:text-emerald-400">
            <Check className="size-4" />
            {graceExpiresAt
              ? `Passkey approved · ${remainingMinutes}:${remainingClockSeconds} remaining`
              : "Verified with passkey"}
          </span>
          <button
            type="button"
            onClick={reset}
            disabled={disabled}
            className="text-xs text-muted-foreground underline underline-offset-4 hover:text-foreground disabled:opacity-50"
          >
            Use a code for this action
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
        onChange={(event) => onChange(event.target.value)}
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
