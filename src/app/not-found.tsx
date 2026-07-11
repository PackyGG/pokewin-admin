"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { FileQuestion, ArrowLeft, LayoutDashboard } from "lucide-react";

import { Button } from "@/components/ui/button";

/**
 * Root 404 — the app-wide fallback for unmatched URLs and for any
 * `notFound()` that bubbles above the `(admin)` group. It renders inside the
 * ROOT `app/layout.tsx` only (no admin shell / session context), so it is
 * fully self-contained: a centered card built from semantic tokens
 * (bg-background / bg-card / text-foreground / muted) that reads correctly in
 * light, dark, and grailed themes.
 *
 * This replaces Next's un-themed built-in 404, which injects an unlayered
 * `<style>body{background:#fff;color:#000}</style>` that forces a white body +
 * black text over the app's dark theme (the "whitened out" symptom the owner
 * reported). The ThemeProvider lives in the root layout above this file, so
 * every semantic token here resolves against the active theme.
 */
export default function NotFound() {
  const router = useRouter();

  return (
    <main className="flex min-h-screen flex-col items-center justify-center bg-background px-6 py-16 text-center text-foreground">
      <div className="w-full max-w-md rounded-2xl border bg-card/60 p-8 shadow-sm motion-safe:animate-in motion-safe:fade-in motion-safe:duration-300 sm:p-10">
        <div className="mx-auto flex size-14 items-center justify-center rounded-2xl bg-blue-500/10 ring-1 ring-blue-500/30">
          <FileQuestion className="size-7 text-blue-500" />
        </div>
        <p className="mt-5 text-4xl font-semibold tracking-tight">404</p>
        <h1 className="mt-1 text-lg font-semibold">Page not found</h1>
        <p className="mx-auto mt-2 max-w-sm text-sm text-muted-foreground">
          The page you&apos;re looking for doesn&apos;t exist or may have been
          moved.
        </p>
        <div className="mt-6 flex flex-wrap items-center justify-center gap-2">
          <Button
            type="button"
            variant="default"
            size="sm"
            nativeButton={false}
            render={<Link href="/dashboard" />}
          >
            <LayoutDashboard className="size-4" />
            Back to dashboard
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => router.back()}
          >
            <ArrowLeft className="size-4" />
            Go back
          </Button>
        </div>
      </div>
    </main>
  );
}
