"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useCallback } from "react";

export function DateRangeFilter({ from, to }: { from: string; to: string }) {
  const router = useRouter();
  const searchParams = useSearchParams();

  const update = useCallback(
    (newFrom: string, newTo: string) => {
      const params = new URLSearchParams(searchParams.toString());
      params.set("from", newFrom);
      params.set("to", newTo);
      router.push(`/spending?${params.toString()}`);
    },
    [router, searchParams]
  );

  const setPreset = useCallback(
    (preset: string) => {
      const now = new Date();
      let newFrom: string;
      let newTo: string;

      switch (preset) {
        case "this-month": {
          newFrom = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-01`;
          const lastDay = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
          newTo = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(lastDay).padStart(2, "0")}`;
          break;
        }
        case "last-month": {
          const lm = new Date(now.getFullYear(), now.getMonth() - 1, 1);
          newFrom = `${lm.getFullYear()}-${String(lm.getMonth() + 1).padStart(2, "0")}-01`;
          const lastDayLm = new Date(lm.getFullYear(), lm.getMonth() + 1, 0).getDate();
          newTo = `${lm.getFullYear()}-${String(lm.getMonth() + 1).padStart(2, "0")}-${String(lastDayLm).padStart(2, "0")}`;
          break;
        }
        case "last-90": {
          const d90 = new Date(now);
          d90.setDate(d90.getDate() - 90);
          newFrom = d90.toISOString().split("T")[0];
          newTo = now.toISOString().split("T")[0];
          break;
        }
        case "this-year": {
          newFrom = `${now.getFullYear()}-01-01`;
          newTo = now.toISOString().split("T")[0];
          break;
        }
        case "all": {
          newFrom = "2020-01-01";
          newTo = now.toISOString().split("T")[0];
          break;
        }
        default:
          return;
      }
      update(newFrom, newTo);
    },
    [update]
  );

  return (
    <div className="flex items-center gap-2 flex-wrap">
      <div className="flex items-center gap-1.5">
        <input
          type="date"
          value={from}
          onChange={(e) => update(e.target.value, to)}
          className="h-8 rounded-md border border-input bg-background px-2 text-sm text-foreground"
        />
        <span className="text-sm text-muted-foreground">→</span>
        <input
          type="date"
          value={to}
          onChange={(e) => update(from, e.target.value)}
          className="h-8 rounded-md border border-input bg-background px-2 text-sm text-foreground"
        />
      </div>
      <div className="flex items-center gap-1">
        {[
          { key: "this-month", label: "This month" },
          { key: "last-month", label: "Last month" },
          { key: "last-90", label: "90 days" },
          { key: "this-year", label: "YTD" },
          { key: "all", label: "All" },
        ].map((p) => (
          <button
            key={p.key}
            type="button"
            onClick={() => setPreset(p.key)}
            className="h-7 rounded-md px-2 text-xs font-medium text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
          >
            {p.label}
          </button>
        ))}
      </div>
    </div>
  );
}
