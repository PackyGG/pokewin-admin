"use client";

import { useActionState, useCallback, useEffect, useRef } from "react";
import { login } from "./actions";
import Image from "next/image";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function LoginForm() {
  const [state, formAction, pending] = useActionState(login, {});

  const formRef = useRef<HTMLFormElement>(null);
  const emailRef = useRef<HTMLInputElement>(null);
  const passwordRef = useRef<HTMLInputElement>(null);
  // The user manually typed → don't auto-submit (we only auto-submit an
  // autofill, never a half-typed form). Set only on printable keystrokes so
  // picking a browser suggestion with Enter/arrows doesn't count as typing.
  const typedRef = useRef(false);
  // Submit exactly once via the auto path (also flipped by any real submit).
  const submittedRef = useRef(false);

  // A successful password step returns requires2FA / requiresSetup with the
  // pending-2FA cookie already committed by the server action. Navigate with a
  // full-page load (NOT a soft router.push) so middleware re-runs with the
  // fresh cookie and no stale unauthenticated RSC cache is served. `redirecting`
  // keeps the button pinned to "Signing in…" through the hop, so it never
  // flashes back to "Sign in" while the navigation is in flight (the reported
  // ~2s button-flash jank).
  const redirecting = !!(state?.requires2FA || state?.requiresSetup);

  useEffect(() => {
    if (state?.requires2FA) {
      window.location.assign("/verify-2fa");
    } else if (state?.requiresSetup) {
      window.location.assign("/setup-2fa");
    }
  }, [state]);

  // Auto-press "Sign in" once a password manager autofills BOTH email and
  // password, so the admin doesn't have to click after autofill. Guarded so it
  // never fires on manually-typed input and never submits twice.
  const maybeAutoSubmit = useCallback(() => {
    if (submittedRef.current || typedRef.current) return;
    const email = emailRef.current?.value.trim() ?? "";
    const password = passwordRef.current?.value ?? "";
    if (!email || !password) return;
    submittedRef.current = true;
    formRef.current?.requestSubmit();
  }, []);

  // Extensions/Chrome fire change events on some fills, but native autofill
  // (and gesture-deferred password fill) often don't — so also poll briefly
  // until both fields are populated. Stops on submit, on typing, or after 4s.
  useEffect(() => {
    const id = window.setInterval(() => {
      if (submittedRef.current || typedRef.current) {
        window.clearInterval(id);
        return;
      }
      maybeAutoSubmit();
    }, 150);
    const stop = window.setTimeout(() => window.clearInterval(id), 4000);
    return () => {
      window.clearInterval(id);
      window.clearTimeout(stop);
    };
  }, [maybeAutoSubmit]);

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key.length === 1 || e.key === "Backspace" || e.key === "Delete") {
      typedRef.current = true;
    }
  };

  return (
    <div className="relative w-full overflow-hidden rounded-xl border border-border bg-card p-6 shadow-2xl shadow-black/40 sm:p-10">
      {/* Hairline top light-catch — a crisp cyan lifted edge. Decorative. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-primary/40 to-transparent"
      />
      {/* Logo + heading */}
      <div className="relative mb-8 text-center">
        <div className="mb-5 flex justify-center">
          <Image src="/logo.png" alt="Pokewin" width={200} height={36} priority />
        </div>
        <h1 className="text-xl font-semibold tracking-tight text-foreground sm:text-2xl">
          Welcome back
        </h1>
      </div>

      <form
        ref={formRef}
        action={formAction}
        onSubmit={() => {
          submittedRef.current = true;
        }}
        className="space-y-5"
      >
        {state?.error && (
          <div className="rounded-lg border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive">
            {state.error}
          </div>
        )}

        <div className="space-y-2">
          <Label htmlFor="email" className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Email
          </Label>
          <Input
            id="email"
            name="email"
            type="email"
            placeholder="admin@pokewin.gg"
            required
            autoComplete="email"
            ref={emailRef}
            onChange={maybeAutoSubmit}
            onKeyDown={handleKeyDown}
            className="h-11 px-3.5 text-sm"
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="password" className="text-xs font-medium uppercase tracking-wider text-muted-foreground">
            Password
          </Label>
          <Input
            id="password"
            name="password"
            type="password"
            required
            autoComplete="current-password"
            ref={passwordRef}
            onChange={maybeAutoSubmit}
            onKeyDown={handleKeyDown}
            className="h-11 px-3.5 text-sm"
          />
        </div>

        <Button
          type="submit"
          disabled={pending || redirecting}
          className="mt-2 h-11 w-full text-sm font-semibold"
        >
          {pending || redirecting ? "Signing in..." : "Sign in"}
        </Button>
      </form>

    </div>
  );
}
