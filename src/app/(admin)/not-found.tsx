"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { FileQuestion, ArrowLeft, LayoutDashboard } from "lucide-react";

import { Button } from "@/components/ui/button";

/**
 * 404 boundary for the entire `(admin)` route group.
 *
 * Every admin detail page throws `notFound()` for a missing / invalid id
 * (users/[id], packs/[id], withdrawals/[id], transactions/[id], rain/[id],
 * cards/[id], creators/*, promo-codes/[id], admin-users/[id], …). Before this
 * file existed there was NO `not-found.tsx` anywhere in the app, so those
 * `notFound()` calls fell through to Next's BUILT-IN default 404 — which
 * injects an unlayered `<style>body{background:#fff;color:#000}</style>` and
 * renders un-themed black-on-white with no admin shell. That injected rule
 * beats the app's `@layer base` body theme, which is exactly the
 * "navbar whitened out + barely-visible 404 message" the owner reported.
 *
 * This boundary renders INSIDE `(admin)/layout.tsx`, so the sidebar + header
 * stay intact and the fallback uses the app's semantic tokens (bg-card /
 * text-foreground / muted) — correct in light, dark, and grailed themes.
 * Mirrors the shape of `(admin)/error.tsx` for a consistent recovery UI.
 *
 * `notFound()` is a navigation signal, not an error, so this is separate
 * from `error.tsx` (which catches real throws + owns the `reset()` retry).
 */
export default function AdminNotFound() {
  const router = useRouter();

  return (
    <div className="space-y-5 motion-safe:animate-in motion-safe:fade-in motion-safe:duration-300">
      <div className="rounded-xl border bg-card p-5 sm:p-6">
        <div className="flex items-start gap-3">
          <div className="flex size-11 items-center justify-center rounded-xl bg-blue-500/10 ring-1 ring-blue-500/30">
            <FileQuestion className="size-5 text-blue-500" />
          </div>
          <div className="flex-1">
            <h1 className="text-xl font-semibold leading-tight tracking-tight">
              Page not found
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              We couldn&apos;t find what you were looking for. The record may
              have been deleted, the id might be wrong, or the link is out of
              date.
            </p>
          </div>
        </div>
      </div>

      <div className="flex flex-wrap items-center gap-2">
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
  );
}
