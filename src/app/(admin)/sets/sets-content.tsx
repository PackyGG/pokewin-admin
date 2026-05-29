"use client";

import { Library } from "lucide-react";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { EmptyState } from "@/components/empty-state";
import { formatDate, formatNumber } from "@/lib/utils/format";
import type { SetListItem } from "@/lib/queries/sets";

function SetThumb({ set }: { set: SetListItem }) {
  return set.imageUrl ? (
    // eslint-disable-next-line @next/next/no-img-element
    <img
      src={set.imageUrl}
      alt={set.name}
      className="size-9 rounded-md object-contain bg-muted/40 shrink-0"
    />
  ) : (
    <div className="size-9 rounded-md bg-muted shrink-0" />
  );
}

export function SetsContent({ data }: { data: SetListItem[] }) {
  return (
    <div className="space-y-4">
      {/* Mobile card list (<lg) */}
      <div className="lg:hidden">
        {data.length === 0 ? (
          <div className="rounded-md border">
            <EmptyState
              icon={Library}
              title="No sets found"
              description="Create a set to group cards into a series (e.g. One Piece)."
              compact
            />
          </div>
        ) : (
          <div className="overflow-hidden rounded-md border">
            {data.map((set) => (
              <div
                key={set.id}
                className="border-b border-border/60 last:border-b-0 px-3 py-3"
              >
                <div className="flex items-start gap-3">
                  <SetThumb set={set} />
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm font-medium truncate">
                        {set.name}
                      </span>
                      <span className="text-[11px] text-muted-foreground tabular-nums">
                        {formatNumber(set.cardCount)} cards
                      </span>
                    </div>
                    <div className="mt-1 grid grid-cols-2 gap-x-3 text-[11px] text-muted-foreground">
                      <div>
                        <span className="text-[9px] uppercase tracking-wide">
                          Series
                        </span>
                        <div className="truncate">{set.series}</div>
                      </div>
                      <div>
                        <span className="text-[9px] uppercase tracking-wide">
                          Language
                        </span>
                        <div className="uppercase">{set.language}</div>
                      </div>
                    </div>
                    <div className="mt-1 text-[10px] text-muted-foreground">
                      {set.releaseDate
                        ? `Released ${formatDate(set.releaseDate)}`
                        : `Added ${formatDate(set.createdAt)}`}
                    </div>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Desktop table (>=lg) */}
      <div className="hidden rounded-md border overflow-x-auto lg:block">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Series</TableHead>
              <TableHead>Language</TableHead>
              <TableHead className="text-right">Cards</TableHead>
              <TableHead>TCGPlayer ID</TableHead>
              <TableHead>Release Date</TableHead>
              <TableHead>Added</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.map((set) => (
              <TableRow key={set.id}>
                <TableCell className="font-medium">
                  <div className="flex items-center gap-2">
                    <SetThumb set={set} />
                    {set.name}
                  </div>
                </TableCell>
                <TableCell>{set.series}</TableCell>
                <TableCell className="uppercase">{set.language}</TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatNumber(set.cardCount)}
                </TableCell>
                <TableCell className="tabular-nums">{set.tcgplayerId}</TableCell>
                <TableCell>
                  {set.releaseDate ? formatDate(set.releaseDate) : "—"}
                </TableCell>
                <TableCell>{formatDate(set.createdAt)}</TableCell>
              </TableRow>
            ))}
            {data.length === 0 && (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={7} className="p-0">
                  <EmptyState
                    icon={Library}
                    title="No sets found"
                    description="Create a set to group cards into a series (e.g. One Piece)."
                    compact
                  />
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
