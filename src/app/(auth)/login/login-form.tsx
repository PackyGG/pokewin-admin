"use client";

import { useActionState, useEffect } from "react";
import { login } from "./actions";
import Image from "next/image";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function LoginForm() {
  const [state, formAction, pending] = useActionState(login, {});

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
        <p className="text-[11px] font-medium uppercase tracking-[0.2em] text-muted-foreground">
          Secure Access
        </p>
        <h1 className="mt-1.5 text-xl font-semibold tracking-tight text-foreground sm:text-2xl">
          Welcome back
        </h1>
      </div>

      <form action={formAction} className="space-y-5">
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
