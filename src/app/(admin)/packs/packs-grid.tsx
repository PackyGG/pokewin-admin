"use client";

import Link from "next/link";
import { CardImage } from "@/components/card-image";
import { Card } from "@/components/ui/card";
import { formatCurrency, formatNumber } from "@/lib/utils/format";
import type { PackListItem } from "@/lib/queries/packs";

export function PacksGrid({ data }: { data: PackListItem[] }) {
  if (data.length === 0) {
    return (
      <div className="flex h-32 items-center justify-center rounded-md border text-muted-foreground">
        No packs found.
      </div>
    );
  }

  return (
    <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 gap-3">
      {data.map((pack) => (
        <Link
          key={pack.id}
          href={`/packs/${pack.id}`}
          className="group"
        >
          <Card className="overflow-hidden transition-shadow duration-200 group-hover:ring-primary/40 py-0">
            {/* Header: image + name/price */}
            <div className="flex items-start gap-3 p-3 pb-0">
              <div className="relative shrink-0">
                <CardImage
                  src={pack.imageUrl}
                  alt={pack.name}
                  className="size-14 rounded-lg"
                />
                {!pack.active && (
                  <div className="absolute inset-0 bg-black/50 rounded-lg flex items-center justify-center">
                    <span className="text-tiny font-semibold text-zinc-300">Off</span>
                  </div>
                )}
              </div>
              <div className="min-w-0 flex-1">
                <div className="flex items-center justify-between gap-2">
                  <h3 className="text-sm font-semibold truncate group-hover:text-primary transition-colors">
                    {pack.name}
                  </h3>
                  <span className="shrink-0 text-sm font-semibold">{formatCurrency(pack.priceUsd)}</span>
                </div>
                <p className="text-xs text-muted-foreground mt-0.5">
                  {formatNumber(pack.totalOpenings)} opens · {pack.cards.length} cards
                </p>
              </div>
            </div>

            {/* Stats row */}
            <div className="grid grid-cols-4 gap-2 px-3 py-2.5 text-center">
              <div>
                <p className="text-tiny">Revenue</p>
                <p className="text-meta font-medium">{formatCurrency(pack.totalRevenue)}</p>
              </div>
              <div>
                <p className="text-tiny">Edge</p>
                <p className={`text-meta font-medium ${pack.actualHouseEdge >= 0 ? "text-green-400" : "text-red-400"}`}>
                  {pack.actualHouseEdge.toFixed(1)}%
                </p>
              </div>
              <div>
                <p className="text-tiny">RTP</p>
                <p className="text-meta font-medium">{pack.actualRtp.toFixed(1)}%</p>
              </div>
              <div>
                <p className="text-tiny">Payout</p>
                <p className="text-meta font-medium">{formatCurrency(pack.totalPayout)}</p>
              </div>
            </div>

            {/* Cards row */}
            {pack.cards.length > 0 && (
              <div className="flex gap-1 px-3 pb-3 overflow-hidden">
                {pack.cards.slice(0, 10).map((card) => (
                  <CardImage
                    key={card.id}
                    src={card.imageUrl}
                    alt={card.name}
                    className="size-6 rounded-sm shrink-0"
                  />
                ))}
                {pack.cards.length > 10 && (
                  <div className="size-6 rounded-sm bg-muted flex items-center justify-center text-tiny font-medium shrink-0">
                    +{pack.cards.length - 10}
                  </div>
                )}
              </div>
            )}
          </Card>
        </Link>
      ))}
    </div>
  );
}
