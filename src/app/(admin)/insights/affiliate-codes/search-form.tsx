"use client";

import { useEffect, useState, useTransition } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Search, Loader2 } from "lucide-react";
import { Input } from "@/components/ui/input";

/**
 * Server-driven search box for /insights/affiliate-codes.
 *
 * The query lives entirely in the URL (`?q=`) — typing updates the input
 * locally and pushes a new `?q=` (debounced) so the server re-runs the
 * indexed lookup. There is NO client-side full-table load; the results are
 * rendered server-side behind a Suspense boundary keyed on `q`.
 */
export function AffiliateCodeSearchForm() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = useTransition();

  const urlQuery = searchParams.get("q") ?? "";
  const [value, setValue] = useState(urlQuery);

  // Keep the input in sync if the URL changes from outside (back/forward).
  useEffect(() => {
    setValue(urlQuery);
  }, [urlQuery]);

  // Debounce the push so each keystroke doesn't fire a server round-trip.
  useEffect(() => {
    const trimmed = value.trim();
    if (trimmed === urlQuery) return;
    const handle = setTimeout(() => {
      const params = new URLSearchParams(searchParams.toString());
      if (trimmed) params.set("q", trimmed);
      else params.delete("q");
      startTransition(() => {
        router.replace(`${pathname}?${params.toString()}`, { scroll: false });
      });
    }, 350);
    return () => clearTimeout(handle);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  return (
    <div className="relative w-full sm:max-w-md">
      <Search
        className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground"
        aria-hidden
      />
      <Input
        value={value}
        onChange={(e) => setValue(e.target.value)}
        placeholder="Search by code, or owner username / email…"
        className="pl-9"
        aria-label="Search affiliate codes"
        autoComplete="off"
        spellCheck={false}
      />
      {isPending && (
        <Loader2
          className="absolute right-3 top-1/2 size-4 -translate-y-1/2 animate-spin text-muted-foreground"
          aria-hidden
        />
      )}
    </div>
  );
}
