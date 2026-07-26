"use client";

import * as React from "react";
import { toast } from "sonner";
import { Fingerprint, ShieldCheck } from "lucide-react";
import {
  startRegistration,
  browserSupportsWebAuthn,
} from "@simplewebauthn/browser";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  listMyPasskeys,
  startPasskeyRegistration,
  finishPasskeyRegistration,
} from "@/app/(admin)/profile/passkey-actions";
import { isPasskeyFromOldDomain } from "@/lib/passkey-migration";
import { isNextControlFlowError } from "@/lib/utils/action-error";

/**
 * One-time nudge to set up a passkey, shown to an admin who has none that works
 * on this domain.
 *
 * WHY IT EXISTS NOW: the move to packydash.com changed the WebAuthn RP ID, so
 * every passkey registered before the cutover is bound to the old domain and
 * the browser won't offer it here. Without a prompt, the failure mode is silent
 * — people just quietly stop having a second factor besides TOTP and only find
 * out when they try to use it. This closes that loop by offering the fix at the
 * moment they're already signed in.
 *
 * IT IS A NUDGE, NOT A GATE:
 *   • Passkeys are the ALTERNATIVE second factor — TOTP is primary and is
 *     unaffected — so nothing here blocks work. "Not now" always dismisses.
 *   • Snoozed for SNOOZE_DAYS in localStorage, and shown at most once per tab,
 *     so it can't become a thing people click past on every navigation.
 *   • It never renders for someone who already has a usable passkey.
 *
 * Mounted from the shared `AdminHeader`, so it covers all four shells (admin,
 * Creator Hub, Pack Studio, Antifraud) from one place and no layout needs to
 * thread anything down. It reads through the EXISTING passkey server actions —
 * no new endpoint, no new permission surface.
 */

const SNOOZE_KEY = "passkey-setup-prompt-snoozed-until";
const SNOOZE_DAYS = 7;

/** Wait for the page to settle before interrupting — an instant modal on load
 *  reads as a blocker rather than a suggestion. */
const OPEN_DELAY_MS = 2500;

function snoozedUntil(): number {
  try {
    const raw = localStorage.getItem(SNOOZE_KEY);
    if (!raw) return 0;
    const ms = Number(raw);
    return Number.isFinite(ms) ? ms : 0;
  } catch {
    // Private mode / storage disabled — treat as not snoozed. Worst case the
    // prompt shows again next session, which is the intended behaviour anyway.
    return 0;
  }
}

function snooze(days: number) {
  try {
    localStorage.setItem(
      SNOOZE_KEY,
      String(Date.now() + days * 24 * 60 * 60 * 1000),
    );
  } catch {
    // Non-fatal: the once-per-tab guard still prevents repeat nagging.
  }
}

export function PasskeySetupPrompt() {
  const [open, setOpen] = React.useState(false);
  const [busy, setBusy] = React.useState(false);
  const [deviceName, setDeviceName] = React.useState("");
  /** True when the account HAD passkeys but all of them predate the cutover —
   *  changes the copy from "add one" to "yours stopped working". */
  const [wasMigrated, setWasMigrated] = React.useState(false);

  React.useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    async function check() {
      // Cheap local guards first — never call the server just to be told to
      // stay quiet.
      if (Date.now() < snoozedUntil()) return;
      if (!browserSupportsWebAuthn()) return;

      let usable = 0;
      let stale = 0;
      try {
        const passkeys = await listMyPasskeys();
        for (const key of passkeys) {
          if (isPasskeyFromOldDomain(key.createdAt)) stale += 1;
          else usable += 1;
        }
      } catch (err) {
        // A Next redirect/notFound is CONTROL FLOW, not an error — swallowing
        // it would suppress a real navigation. The one that matters here:
        // `listMyPasskeys` calls `verifySession`, which redirects an admin who
        // hasn't enrolled 2FA to /setup-2fa. Mandatory 2FA is ON by default, so
        // eating that would strand exactly the person who most needs to move.
        if (isNextControlFlowError(err)) throw err;
        // Anything else (transient read failure, not signed in far enough) is
        // genuinely ignorable — this is a suggestion, not something worth an
        // error toast in the chrome.
        return;
      }

      if (cancelled || usable > 0) return;

      timer = setTimeout(() => {
        if (cancelled) return;
        setWasMigrated(stale > 0);
        setOpen(true);
      }, OPEN_DELAY_MS);
    }

    void check();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, []);

  function dismiss() {
    snooze(SNOOZE_DAYS);
    setOpen(false);
  }

  async function handleSetup() {
    setBusy(true);
    try {
      const optionsJSON = await startPasskeyRegistration();
      const response = await startRegistration({ optionsJSON });
      await finishPasskeyRegistration(response, deviceName.trim() || undefined);
      toast.success("Passkey added — you can use it next time you sign in");
      // Success is permanent: never ask again on this browser.
      snooze(365);
      setOpen(false);
    } catch (err) {
      if (err instanceof Error && err.name === "NotAllowedError") {
        toast.error("Passkey setup was cancelled.");
      } else {
        toast.error(
          err instanceof Error ? err.message : "Could not add passkey",
        );
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // Closing by any route (Esc, overlay, the X) counts as "not now" —
        // otherwise it would re-appear on the next page load.
        if (!next) dismiss();
        else setOpen(true);
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <div className="mb-1 flex size-10 items-center justify-center rounded-xl bg-cyan-500/10 text-cyan-500">
            <Fingerprint className="size-5" />
          </div>
          <DialogTitle>
            {wasMigrated ? "Your passkey needs re-adding" : "Add a passkey"}
          </DialogTitle>
          <DialogDescription>
            {wasMigrated
              ? "The dashboard moved to packydash.com. A passkey is tied to the domain it was created on, so the one you had can't be offered here anymore — adding a new one takes a few seconds."
              : "Sign in with your fingerprint, face or device PIN instead of typing a code from your authenticator app."}
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-4 py-2">
          <div className="flex items-start gap-2.5 rounded-lg border border-border/60 bg-muted/30 px-3 py-2.5">
            <ShieldCheck className="mt-0.5 size-4 shrink-0 text-emerald-500" />
            <p className="text-xs leading-relaxed text-muted-foreground">
              This is an <strong className="font-semibold">extra</strong> way in,
              not a replacement. Your authenticator app keeps working exactly as
              it does today, so you can skip this and nothing changes.
            </p>
          </div>

          <div className="space-y-1.5">
            <Label htmlFor="passkey-prompt-name">Name this device (optional)</Label>
            <Input
              id="passkey-prompt-name"
              value={deviceName}
              onChange={(e) => setDeviceName(e.target.value)}
              placeholder="e.g. Work laptop"
              maxLength={40}
            />
          </div>
        </div>

        <DialogFooter>
          <Button type="button" variant="ghost" onClick={dismiss} disabled={busy}>
            Not now
          </Button>
          <Button type="button" onClick={handleSetup} disabled={busy}>
            <Fingerprint className="mr-2 size-4" />
            {busy ? "Waiting for device…" : "Set up passkey"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
