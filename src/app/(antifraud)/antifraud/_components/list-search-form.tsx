"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { Loader2, Search } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useHostHref } from "@/lib/use-app-host";
import { cn } from "@/lib/utils";

/**
 * Shared search box for the antifraud list pages (fiat deposits, KYC, banned
 * users, staff audit).
 *
 * WHY THIS EXISTS — the pages previously used a bare `<form action="/antifraud/…">`
 * GET submit. That is a NATIVE document navigation, which cost two things on
 * every single search:
 *
 *  1. A full page load. The whole shell (SidebarProvider, AdminHeader,
 *     TimezoneProvider, the layout's admin-DB wave) was torn down and rebuilt,
 *     and the keyed `<Suspense>` skeleton these pages already maintain never got
 *     a chance to render — the browser just sat on a stale document until the
 *     new one arrived.
 *  2. An extra redirect hop on the dedicated host. `fraud.packydash.com` serves
 *     these routes at their clean paths, so a submit to the canonical
 *     `/antifraud/fiat-deposits` is 308'd back to `/fiat-deposits` by
 *     `redirectTargetForHost` before anything rendered.
 *
 * Submitting through the router instead makes it a client transition: the URL
 * updates, the existing `<Suspense key={…}>` boundary swaps to its skeleton,
 * and the shell is never re-created. `useHostHref` resolves the host-correct
 * target so the redirect hop disappears.
 *
 * NO-JS CONTRACT: the rendered markup is still a real `<form>` with the
 * canonical `action`/`method` and real hidden inputs, so before hydration — or
 * with scripting unavailable — the native GET submit behaves exactly as it did
 * before. `onSubmit` only takes over once React has hydrated.
 */
export function ListSearchForm({
  action,
  placeholder,
  ariaLabel,
  defaultValue,
  carry,
  className,
  inputClassName,
  fieldName = "search",
  submitLabel,
  compact = false,
  maxLength = 100,
}: {
  /** Canonical in-app path, e.g. `/antifraud/fiat-deposits`. */
  action: string;
  placeholder: string;
  ariaLabel: string;
  defaultValue: string;
  /**
   * Filter state to preserve across the search. Rendered as hidden inputs so
   * the no-JS submit carries them too; `undefined` / empty entries are skipped.
   */
  carry?: Record<string, string | undefined>;
  className?: string;
  inputClassName?: string;
  /** Query key for the term. KYC uses `q`; the list pages use `search`. */
  fieldName?: string;
  /** Render text beside the icon instead of an icon-only button. */
  submitLabel?: string;
  /** Match the denser `h-8 / text-xs` filter bars (KYC, audit). */
  compact?: boolean;
  maxLength?: number;
}) {
  const router = useRouter();
  const hostAction = useHostHref(action);
  const [pending, startTransition] = React.useTransition();

  const entries = Object.entries(carry ?? {}).filter(
    (entry): entry is [string, string] =>
      typeof entry[1] === "string" && entry[1].length > 0,
  );

  function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const query = new URLSearchParams();
    for (const [key, value] of entries) query.set(key, value);
    const raw = new FormData(event.currentTarget).get(fieldName);
    const term = typeof raw === "string" ? raw.trim() : "";
    // Searching is a new query, so it always restarts at page 1 (never carried
    // in `carry`). An empty box clears the term rather than submitting an empty
    // param, which keeps the URL — and so the Suspense key and any shared
    // link — clean.
    if (term) query.set(fieldName, term.slice(0, maxLength));
    const qs = query.toString();
    startTransition(() => {
      router.push(qs ? `${hostAction}?${qs}` : hostAction);
    });
  }

  const icon = pending ? (
    <Loader2
      className={cn(
        "motion-safe:animate-spin",
        compact ? "size-3.5" : "size-4",
      )}
      aria-hidden
    />
  ) : (
    <Search className={compact ? "size-3.5" : "size-4"} aria-hidden />
  );

  return (
    <form
      // `method="get"` + `action` keep the pre-hydration / no-JS submit intact.
      method="get"
      action={action}
      onSubmit={handleSubmit}
      aria-busy={pending || undefined}
      className={cn("flex min-w-0 gap-2", className)}
    >
      {entries.map(([key, value]) => (
        <input key={key} type="hidden" name={key} value={value} />
      ))}
      {compact ? (
        <>
          <input
            type="search"
            name={fieldName}
            defaultValue={defaultValue}
            placeholder={placeholder}
            maxLength={maxLength}
            aria-label={ariaLabel}
            className={cn(
              "h-8 min-w-0 flex-1 rounded-md border border-border/60 bg-background px-2.5 text-xs outline-none focus-visible:ring-2 focus-visible:ring-ring",
              inputClassName,
            )}
          />
          <button
            type="submit"
            disabled={pending}
            aria-label={pending ? "Searching" : ariaLabel}
            className="inline-flex h-8 shrink-0 items-center gap-1.5 rounded-md border border-border/60 bg-muted/40 px-3 text-xs font-medium transition-colors hover:bg-muted disabled:opacity-60"
          >
            {pending ? icon : null}
            {submitLabel ?? "Search"}
          </button>
        </>
      ) : (
        <>
          <Input
            name={fieldName}
            defaultValue={defaultValue}
            placeholder={placeholder}
            maxLength={maxLength}
            aria-label={ariaLabel}
            className={cn("min-w-0", inputClassName)}
          />
          <Button
            type="submit"
            variant="outline"
            aria-label={pending ? "Searching" : ariaLabel}
            disabled={pending}
          >
            {icon}
            {submitLabel}
          </Button>
        </>
      )}
    </form>
  );
}
