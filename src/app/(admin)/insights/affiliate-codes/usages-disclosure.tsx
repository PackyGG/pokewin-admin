"use client";

import { useState } from "react";
import { ChevronDown, Loader2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatCurrency, formatRelative } from "@/lib/utils/format";
import { loadRecentAffiliateUsages } from "./actions";
import type { AffiliateCodeUsageRow } from "@/lib/queries/affiliate-codes-lookup";

/**
 * Lazy recent-usages drawer for one affiliate owner. The bounded, indexed
 * query only runs the FIRST time the disclosure is opened (via the
 * `loadRecentAffiliateUsages` server action) — never on initial render —
 * so a search results list never fans out N usage queries eagerly.
 *
 * House-POV: `referrer_cut_usd` is house cost (commission paid to the
 * affiliate) → rose. Deposit + wager are neutral context.
 */
export function UsagesDisclosure({
  affiliateUserId,
}: {
  affiliateUserId: string;
}) {
  const [open, setOpen] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [rows, setRows] = useState<AffiliateCodeUsageRow[]>([]);
  const [failed, setFailed] = useState(false);

  async function toggle() {
    const next = !open;
    setOpen(next);
    if (next && !loaded && !loading) {
      setLoading(true);
      setFailed(false);
      try {
        const data = await loadRecentAffiliateUsages(affiliateUserId);
        setRows(data);
        setLoaded(true);
      } catch {
        setFailed(true);
      } finally {
        setLoading(false);
      }
    }
  }

  return (
    <div className="mt-3 border-t pt-2">
      <button
        type="button"
        onClick={toggle}
        aria-expanded={open}
        className="flex items-center gap-1.5 text-xs font-medium text-muted-foreground transition-colors hover:text-foreground"
      >
        <ChevronDown
          className={cn(
            "size-3.5 transition-transform",
            open && "rotate-180",
          )}
          aria-hidden
        />
        Recent referrals
      </button>

      {open && (
        <div className="mt-2">
          {loading && (
            <div className="flex items-center gap-2 py-2 text-xs text-muted-foreground">
              <Loader2 className="size-3.5 animate-spin" aria-hidden />
              Loading…
            </div>
          )}
          {!loading && failed && (
            <p className="py-2 text-xs text-muted-foreground">
              Couldn&apos;t load recent referrals.
            </p>
          )}
          {!loading && loaded && rows.length === 0 && (
            <p className="py-2 text-xs text-muted-foreground">
              No referral usages recorded for this owner.
            </p>
          )}
          {!loading && loaded && rows.length > 0 && (
            <ul className="divide-y rounded-lg border bg-background/40">
              {rows.map((r) => (
                <li
                  key={r.id}
                  className="flex flex-wrap items-center justify-between gap-x-3 gap-y-1 px-3 py-2 text-xs"
                >
                  <span className="flex min-w-0 items-center gap-2">
                    <span className="font-mono text-[11px] text-muted-foreground">
                      {r.code}
                    </span>
                    <span className="truncate">
                      {r.referredUsername ? `@${r.referredUsername}` : "referred user"}
                    </span>
                  </span>
                  <span className="flex shrink-0 items-center gap-3 tabular-nums">
                    <span className="text-muted-foreground">
                      dep {formatCurrency(r.depositAmountUsd)}
                    </span>
                    <span className="font-medium text-rose-600 dark:text-rose-400">
                      cut {formatCurrency(r.referrerCutUsd)}
                    </span>
                    <span className="text-muted-foreground">
                      {formatRelative(r.createdAt)}
                    </span>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
