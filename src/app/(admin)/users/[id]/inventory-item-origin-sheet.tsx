"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { Gem, Package } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { InspectorSheet } from "@/components/entity-surface";
import { CardImage } from "@/components/card-image";
import { getRarityDot, getRarityRing } from "@/components/card-tile";
import { formatCurrency, formatDateTime } from "@/lib/utils/format";
import { cn } from "@/lib/utils";
import { getInventoryItemOrigin } from "./actions";
import type { InventoryItemOrigin } from "./actions";
import { inventorySourceLabel, type InventoryItem } from "./user-tabs-types";

/**
 * Click-to-view ORIGIN sheet for a single "Current Inventory" card — answers
 * "where did this come from" (which pack/battle produced it, when, price
 * paid) without leaving the grid. Opens from a card click in
 * <InventoryGrid> (user-tabs-inventory.tsx).
 *
 * Loading discipline (CLAUDE.md Active-Timeframe-Only): the header paints
 * instantly from the `item` the grid already has in memory (name, image,
 * rarity, value, obtained date — zero fetch). The origin/opening breakdown
 * is fetched ONLY once the sheet is open, via `InspectorSheet`'s
 * `LazyModalContent` gate — it is never fetched for the whole grid, and
 * closing the sheet fully unmounts the fetched subtree (re-opening re-fetches
 * fresh, same contract as the transaction-detail modal's game-session load).
 */
export function InventoryItemOriginSheet({
  userId,
  item,
  open,
  onOpenChange,
}: {
  userId: string;
  item: InventoryItem | null;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  return (
    <InspectorSheet
      open={open}
      onOpenChange={onOpenChange}
      icon={Gem}
      accent="purple"
      title={item?.cardName ?? "Item"}
      subtitle={
        item
          ? `${inventorySourceLabel(item.sourceType)} · ${formatCurrency(item.value)}`
          : undefined
      }
      bodyMinHeight={240}
    >
      {item && <OriginBody userId={userId} item={item} />}
    </InspectorSheet>
  );
}

function DetailRow({
  label,
  value,
}: {
  label: string;
  value: React.ReactNode;
}) {
  return (
    <div className="flex flex-col gap-1">
      <span className="text-xs text-muted-foreground">{label}</span>
      <div className="text-sm">{value}</div>
    </div>
  );
}

/** Deferred body — only mounts while the sheet is open (see LazyModalContent
 *  inside InspectorSheet), so this effect (and the origin fetch it runs)
 *  never fires for a card that was never clicked. */
function OriginBody({
  userId,
  item,
}: {
  userId: string;
  item: InventoryItem;
}) {
  const [data, setData] = useState<InventoryItemOrigin | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(false);
    setData(null);
    getInventoryItemOrigin(userId, item.id)
      .then((res) => {
        if (!cancelled) setData(res);
      })
      .catch(() => {
        if (!cancelled) setError(true);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [userId, item.id]);

  const dot = getRarityDot(item.rarity);
  const ring = getRarityRing(item.rarity);
  const session = data?.session ?? null;

  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <div
          className={cn(
            "relative size-16 shrink-0 overflow-hidden rounded-lg bg-muted/40 ring-1",
            ring,
          )}
        >
          <CardImage
            src={item.imageUrl}
            alt={item.cardName}
            className="size-full"
          />
        </div>
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex items-center gap-1.5">
            <span className={cn("size-1.5 shrink-0 rounded-full", dot)} />
            <p className="truncate text-sm font-medium" title={item.cardName}>
              {item.cardName}
            </p>
          </div>
          {item.rarity && (
            <p className="truncate text-xs capitalize text-muted-foreground">
              {item.rarity}
            </p>
          )}
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 rounded-md border bg-muted/30 p-3">
        <DetailRow
          label="Value"
          value={
            <span className="font-semibold tabular-nums">
              {formatCurrency(item.value)}
            </span>
          }
        />
        <DetailRow label="Obtained" value={formatDateTime(item.obtainedAt)} />
        <DetailRow
          label="Source"
          value={inventorySourceLabel(item.sourceType)}
        />
        {data?.pullChance != null && (
          <DetailRow
            label="Pull chance"
            value={`${(data.pullChance * 100).toFixed(4)}%`}
          />
        )}
      </div>

      <div className="border-t pt-3 space-y-3">
        <h3 className="text-sm font-medium">Opening details</h3>

        {loading ? (
          <p className="py-4 text-center text-sm text-muted-foreground">
            Loading opening details…
          </p>
        ) : error ? (
          <p className="py-2 text-center text-sm text-amber-600 dark:text-amber-400">
            Couldn&apos;t load opening details — close and reopen to retry.
          </p>
        ) : session ? (
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <span className="text-xs text-muted-foreground">
                {session.gameType === "pack"
                  ? "Pack opening"
                  : session.gameType === "battle"
                    ? "Battle"
                    : "Upgrader"}{" "}
                · {formatDateTime(session.createdAt)}
              </span>
              {session.result && (
                <Badge variant="outline" className="font-mono text-xs">
                  {session.result}
                </Badge>
              )}
            </div>

            {session.pack && (
              <Link
                href={`/packs/${session.pack.id}`}
                className="group flex items-center gap-3 rounded-md border bg-muted/30 p-2.5"
              >
                <div className="flex size-12 shrink-0 items-center justify-center overflow-hidden rounded-lg bg-muted">
                  {session.pack.imageUrl ? (
                    <CardImage
                      src={session.pack.imageUrl}
                      alt={session.pack.name}
                      className="size-full"
                    />
                  ) : (
                    <Package className="size-5 text-muted-foreground" />
                  )}
                </div>
                <div className="min-w-0 flex-1">
                  <p className="truncate text-sm font-medium text-blue-500 group-hover:underline dark:text-blue-400">
                    {session.pack.name}
                  </p>
                  <p className="text-xs text-muted-foreground">
                    Price paid: {formatCurrency(session.betAmount)}
                  </p>
                </div>
              </Link>
            )}

            {!session.pack && (
              <p className="text-xs text-muted-foreground">
                Bet: {formatCurrency(session.betAmount)}
              </p>
            )}

            {session.packsOpened.length > 0 && (
              <div className="space-y-1.5">
                <p className="text-xs text-muted-foreground">
                  Packs opened this session ({session.packsOpened.length})
                </p>
                <div className="space-y-1">
                  {session.packsOpened.map((entry) => (
                    <div
                      key={entry.key}
                      className="flex items-center justify-between gap-2 rounded-md border bg-muted/20 px-2.5 py-1.5 text-xs"
                    >
                      <span className="truncate text-muted-foreground">
                        {entry.roundIndex != null
                          ? `Round ${entry.roundIndex + 1} · `
                          : ""}
                        {entry.pack.name}
                      </span>
                      <span className="shrink-0 font-medium">
                        {entry.card
                          ? `${entry.card.name} · ${formatCurrency(entry.card.valueUsd)}`
                          : "No card"}
                      </span>
                    </div>
                  ))}
                </div>
              </div>
            )}
          </div>
        ) : (
          <p className="py-2 text-sm text-muted-foreground">
            No linked opening session for this item
            {item.sourceType === "exchange"
              ? " — exchanges don't record an originating session."
              : item.sourceType === "raffle"
                ? " — raffle wins aren't tracked as a game session."
                : "."}
          </p>
        )}
      </div>
    </div>
  );
}
