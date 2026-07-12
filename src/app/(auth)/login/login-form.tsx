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
    <div className="relative w-full sm:w-[520px] max-w-full overflow-hidden rounded-2xl border border-white/10 bg-white/5 p-6 sm:rounded-3xl sm:p-12 shadow-2xl shadow-black/30 backdrop-blur-xl">
      {/* Hairline top light-catch — crisp lifted glass edge. Decorative. */}
      <div
        aria-hidden
        className="pointer-events-none absolute inset-x-0 top-0 h-px bg-gradient-to-r from-transparent via-white/20 to-transparent"
      />
      {/* Logo */}
      <div className="relative mb-10 text-center">
        <div className="mb-4 flex justify-center">
          <Image src="/logo.png" alt="Pokewin" width={200} height={36} priority />
        </div>
        <h1 className="text-page-title tracking-tight text-foreground">Welcome back</h1>
      </div>

      <form action={formAction} className="space-y-6">
        {state?.error && (
          <div className="rounded-lg bg-destructive/10 px-4 py-3 text-sm text-destructive">
            {state.error}
          </div>
        )}

        <div className="space-y-2">
          <Label htmlFor="email" className="text-sm font-medium">
            Email
          </Label>
          <Input
            id="email"
            name="email"
            type="email"
            placeholder="admin@pokewin.gg"
            required
            autoComplete="email"
            className="h-12 rounded-lg border-white/10 bg-white/5 px-4 text-sm placeholder:text-muted-foreground/50"
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="password" className="text-sm font-medium">
            Password
          </Label>
          <Input
            id="password"
            name="password"
            type="password"
            required
            autoComplete="current-password"
            className="h-12 rounded-lg border-white/10 bg-white/5 px-4 text-sm placeholder:text-muted-foreground/50"
          />
        </div>

        <Button
          type="submit"
          disabled={pending || redirecting}
          className="h-12 w-full rounded-lg bg-primary text-sm font-semibold text-primary-foreground hover:bg-primary/90"
        >
          {pending || redirecting ? "Signing in..." : "Sign in"}
        </Button>
      </form>

    </div>
  );
}
