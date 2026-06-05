"use client";

import { useActionState, useEffect } from "react";
import { useRouter } from "next/navigation";
import { login } from "./actions";
import Image from "next/image";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export function LoginForm() {
  const [state, formAction, pending] = useActionState(login, {});
  const router = useRouter();

  useEffect(() => {
    if (state?.requires2FA) {
      router.push("/verify-2fa");
    } else if (state?.requiresSetup) {
      router.push("/setup-2fa");
    }
  }, [state, router]);

  return (
    <div className="w-full sm:w-[520px] max-w-full rounded-2xl border border-white/10 bg-white/5 p-6 sm:p-12 shadow-2xl shadow-black/30 backdrop-blur-xl">
      {/* Logo */}
      <div className="mb-10 text-center">
        <div className="mb-4 flex justify-center">
          <Image src="/logo.png" alt="Pokewin" width={200} height={36} priority />
        </div>
        <h1 className="text-page-title text-foreground">Welcome back</h1>
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
          disabled={pending}
          className="h-12 w-full rounded-lg bg-primary text-sm font-semibold text-primary-foreground hover:bg-primary/90"
        >
          {pending ? "Signing in..." : "Sign in"}
        </Button>
      </form>

    </div>
  );
}
