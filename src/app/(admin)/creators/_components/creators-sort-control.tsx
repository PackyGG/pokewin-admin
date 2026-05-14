"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useTransition } from "react";
import { ArrowDownWideNarrow, ArrowUpNarrowWide, Clock } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
} from "@/components/ui/select";

const OPTIONS = [
  {
    value: "recent" as const,
    label: "Recent (default)",
    Icon: Clock,
  },
  {
    value: "pnl_desc" as const,
    label: "Highest PnL",
    Icon: ArrowDownWideNarrow,
  },
  {
    value: "pnl_asc" as const,
    label: "Lowest PnL",
    Icon: ArrowUpNarrowWide,
  },
] as const;

/**
 * URL-driven sort dropdown for /creators. Three modes:
 *   • Recent (default) — backend-paginated, cheap.
 *   • Highest PnL    — full creator-pool walk + lifetime PnL sort.
 *   • Lowest PnL     — same expensive path, ascending order.
 *
 * Picking a non-default option drops `?page` (resets to page 1) so
 * the new sort doesn't land the user on a half-empty page of the
 * old order.
 */
export function CreatorsSortControl() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [isPending, startTransition] = useTransition();
  const current = (searchParams.get("sortBy") ?? "recent") as
    | "recent"
    | "pnl_desc"
    | "pnl_asc";

  function handleChange(value: string | null) {
    // base-ui Select fires `null` when the open popover is dismissed
    // without a selection (e.g. clicking outside). Treat as no-op so
    // we don't mutate the URL for ambient closes.
    if (value == null) return;
    const params = new URLSearchParams(searchParams.toString());
    if (value === "recent") {
      params.delete("sortBy");
    } else {
      params.set("sortBy", value);
    }
    params.delete("page");
    startTransition(() => {
      router.replace(`?${params.toString()}`, { scroll: false });
    });
  }

  const currentOption =
    OPTIONS.find((o) => o.value === current) ?? OPTIONS[0];
  const CurrentIcon = currentOption.Icon;

  return (
    <Select
      value={current}
      onValueChange={handleChange}
      disabled={isPending}
    >
      <SelectTrigger className="h-9 w-[180px]">
        {/* Render the current label manually in the trigger — base-ui
            Select's <SelectValue /> doesn't always inline the
            selected option's content at SSR, which makes the
            initial render flash empty. Matches the manual-label
            pattern used in the rest of the admin toolbars. */}
        <span className="inline-flex items-center gap-2 truncate">
          <CurrentIcon className="size-3.5 shrink-0" />
          {currentOption.label}
        </span>
      </SelectTrigger>
      <SelectContent>
        {OPTIONS.map(({ value, label, Icon }) => (
          <SelectItem key={value} value={value}>
            <div className="inline-flex items-center gap-2">
              <Icon className="size-3.5 shrink-0" />
              {label}
            </div>
          </SelectItem>
        ))}
      </SelectContent>
    </Select>
  );
}
