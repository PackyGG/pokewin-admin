"use client";

import { useEffect, useState } from "react";
import { ChevronDown, ChevronRight, Loader2, Tag } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { formatCurrency, formatRelative } from "@/lib/utils/format";
import {
  getUserInventorySaleBatches,
  type InventorySaleBatch,
} from "./actions";

/**
 * Card sales grouped into BATCHES on the Overview — cards sold together in
 * one action show as a single "N cards · $total" entry (expandable to the
 * individual cards) instead of one row per card. Loads on mount; hidden
 * entirely when the user has never sold a card.
 */
export function InventorySalesPanel({ userId }: { userId: string }) {
  const [batches, setBatches] = useState<InventorySaleBatch[] | null>(null);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    getUserInventorySaleBatches(userId)
      .then((rows) => {
        if (!cancelled) setBatches(rows);
      })
      .catch(() => {
        if (!cancelled) setBatches([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [userId]);

  if (!loading && (!batches || batches.length === 0)) return null;

  const grandTotal = (batches ?? []).reduce((a, b) => a + b.total, 0);
  const itemTotal = (batches ?? []).reduce((a, b) => a + b.count, 0);

  function toggle(id: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-sm font-medium">
          <Tag className="size-4" />
          Inventory sales
          {batches && batches.length > 0 && (
            <span className="text-muted-foreground">
              — {itemTotal} card{itemTotal !== 1 ? "s" : ""} ·{" "}
              <span className="tabular-nums">{formatCurrency(grandTotal)}</span>
            </span>
          )}
        </CardTitle>
      </CardHeader>
      <CardContent>
        {loading ? (
          <div className="flex items-center justify-center py-6">
            <Loader2 className="size-5 animate-spin text-muted-foreground" />
          </div>
        ) : (
          <div className="space-y-1.5">
            {(batches ?? []).map((b) => {
              const isOpen = expanded.has(b.id);
              return (
                <div key={b.id} className="rounded-lg border bg-card">
                  <button
                    type="button"
                    onClick={() => toggle(b.id)}
                    className="flex w-full items-center justify-between gap-2 px-3 py-2 text-left hover:bg-muted/40"
                  >
                    <span className="flex items-center gap-2 text-sm">
                      {isOpen ? (
                        <ChevronDown className="size-3.5 text-muted-foreground" />
                      ) : (
                        <ChevronRight className="size-3.5 text-muted-foreground" />
                      )}
                      <span className="font-medium">
                        Sold {b.count} card{b.count !== 1 ? "s" : ""}
                      </span>
                      <span className="text-xs text-muted-foreground">
                        {formatRelative(b.at)}
                      </span>
                    </span>
                    <span className="font-semibold tabular-nums text-emerald-600 dark:text-emerald-400">
                      {formatCurrency(b.total)}
                    </span>
                  </button>
                  {isOpen && (
                    <div className="border-t px-3 py-2">
                      <div className="grid grid-cols-1 gap-1 sm:grid-cols-2">
                        {b.cards.map((c, i) => (
                          <div
                            key={`${b.id}-${i}`}
                            className="flex items-center justify-between gap-2 text-xs"
                          >
                            <span className="truncate text-muted-foreground">
                              {c.name}
                            </span>
                            <span className="tabular-nums">
                              {formatCurrency(c.value)}
                            </span>
                          </div>
                        ))}
                      </div>
                      {b.count > b.cards.length && (
                        <p className="mt-1 text-[10px] text-muted-foreground">
                          + {b.count - b.cards.length} more…
                        </p>
                      )}
                    </div>
                  )}
                </div>
              );
            })}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
