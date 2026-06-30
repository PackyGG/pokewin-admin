"use client";

import { useEffect, useState, useTransition } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { Search, Loader2 } from "lucide-react";
import { Input } from "@/components/ui/input";

/**
 * Server-driven username search for the /insights/double-down audit log.
 *
 * The query lives in the URL (`?q=`) — typing updates the input locally and
 * pushes a debounced `?q=` so the server re-runs the windowed log query with
 * the username predicate. There is NO client-side full-table load; results are
 * rendered server-side behind a Suspense boundary keyed on period|page|search.
 * Changing the search resets the log to page 1.
 */
export function DoubleDownSearchForm() {
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
      params.delete("page"); // a new search starts at page 1
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
        placeholder="Search the log by username…"
        className="pl-9"
        aria-label="Search Double Down rounds by username"
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
