"use client";

import { useTransition } from "react";
import { useRouter, useSearchParams, usePathname } from "next/navigation";
import { Layers, Trophy, Wallet, Sparkles, ReceiptText } from "lucide-react";
import { cn } from "@/lib/utils";
import type { LucideIcon } from "lucide-react";

import type { SpendBucketKey } from "../_queries/spend-events";

const CHIPS: { value: SpendBucketKey; label: string; icon: LucideIcon }[] = [
  { value: "all", label: "All events", icon: Layers },
  { value: "leaderboard", label: "Leaderboard", icon: Trophy },
  { value: "fill", label: "Fill program", icon: Wallet },
  { value: "multiplier", label: "Multiplier deal", icon: Sparkles },
  { value: "expense", label: "Expense", icon: ReceiptText },
];

/**
 * URL-driven event-type chips for the audit-spend list. Updates the
 * `bucket` search param and resets `page` to 1 on change. Pure
 * client-side navigation — the page's Suspense `key` rebuilds the table
 * for the new bucket.
 */
export function BucketFilter({ active }: { active: SpendBucketKey }) {
  const router = useRouter();
  const pathname = usePathname();
  const params = useSearchParams();
  const [pending, startTransition] = useTransition();

  function selectBucket(next: SpendBucketKey) {
    if (next === active) return;
    const sp = new URLSearchParams(params.toString());
    if (next === "all") sp.delete("bucket");
    else sp.set("bucket", next);
    sp.delete("page");
    const qs = sp.toString();
    startTransition(() => {
      router.push(qs ? `${pathname}?${qs}` : pathname);
    });
  }

  return (
    <div
      className={cn(
        "flex flex-wrap items-center gap-1.5",
        pending && "opacity-70",
      )}
    >
      {CHIPS.map((chip) => {
        const Icon = chip.icon;
        const isActive = chip.value === active;
        return (
          <button
            key={chip.value}
            type="button"
            onClick={() => selectBucket(chip.value)}
            className={cn(
              "inline-flex items-center gap-1.5 rounded-full border px-3 py-1.5 text-xs font-semibold transition-colors",
              "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
              isActive
                ? "border-rose-500/40 bg-rose-500/15 text-rose-600 dark:text-rose-300"
                : "border-border bg-background/40 text-muted-foreground hover:border-rose-500/30 hover:text-foreground",
            )}
          >
            <Icon className="size-3.5" />
            <span>{chip.label}</span>
          </button>
        );
      })}
    </div>
  );
}
