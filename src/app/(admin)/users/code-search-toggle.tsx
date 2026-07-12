"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useTransition } from "react";
import { Checkbox } from "@/components/ui/checkbox";

/**
 * "Affiliate code only" search toggle for the /users toolbar.
 *
 * Rendered right next to the shared search input (via DataTableToolbar's
 * `afterSearch` slot). When checked it sets `?codeSearch=1` (and resets
 * `page` to 1); unchecked it removes the param. In that mode getUsers matches
 * the search term ONLY against affiliate/creator codes
 * (affiliate_codes.code, case-insensitive prefix) and returns the code
 * OWNERS — "type a code, find who owns it". Off, the normal multi-column
 * search runs.
 *
 * URL-param driven (same pattern as the toolbar's own controls) so the state
 * survives refresh / back-forward and the server reads it straight from
 * searchParams. Uses next/navigation router.replace inside a transition so the
 * toggle doesn't push a history entry per click.
 */
export function CodeSearchToggle() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = useTransition();

  const checked = searchParams.get("codeSearch") === "1";

  function handleChange(next: boolean) {
    const params = new URLSearchParams(searchParams.toString());
    if (next) params.set("codeSearch", "1");
    else params.delete("codeSearch");
    // A filter change always returns to the first page, matching the
    // toolbar's own updateParam behaviour.
    params.set("page", "1");
    const query = params.toString();
    startTransition(() =>
      router.replace(query ? `${pathname}?${query}` : pathname),
    );
  }

  return (
    <label
      className="flex h-9 shrink-0 cursor-pointer select-none items-center gap-2 rounded-lg border border-input bg-transparent px-3 text-sm text-muted-foreground transition-colors hover:text-foreground data-[disabled]:opacity-50"
      data-disabled={isPending ? "" : undefined}
    >
      <Checkbox
        checked={checked}
        onCheckedChange={(v) => handleChange(v === true)}
        aria-label="Search affiliate codes only"
      />
      Affiliate code only
    </label>
  );
}
