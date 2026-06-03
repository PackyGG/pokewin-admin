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
import { SetFormDialog } from "./set-form-dialog";
import { DeleteSetButton } from "./delete-set-button";

export function SetsContent({
  data,
  isAdmin,
}: {
  data: SetListItem[];
  isAdmin: boolean;
}) {
  return (
    <div className="space-y-4">
      {/* Mobile card list (<lg) */}
      <div className="lg:hidden">
        {data.length === 0 ? (
          <div className="rounded-2xl border border-dashed bg-card/30">
            <EmptyState
              icon={Library}
              title="No sets found"
              description="Create a set to group cards into a series (e.g. One Piece)."
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
                  <div className="min-w-0 flex-1">
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-sm font-medium truncate">
                        {set.name}
                      </span>
                      <span className="text-[11px] text-muted-foreground tabular-nums">
                        {formatNumber(set.cardCount)} cards
                      </span>
                    </div>
                    <div className="mt-1 text-[10px] text-muted-foreground">
                      Added {formatDate(set.createdAt)}
                    </div>
                  </div>
                  <div className="flex items-center gap-1">
                    <SetFormDialog
                      mode="edit"
                      initialValues={{
                        id: set.id,
                        name: set.name,
                      }}
                    />
                    {isAdmin && (
                      <DeleteSetButton
                        id={set.id}
                        name={set.name}
                        cardCount={set.cardCount}
                      />
                    )}
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
              <TableHead className="text-right">Cards</TableHead>
              <TableHead>Added</TableHead>
              <TableHead className="text-right">Actions</TableHead>
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.map((set) => (
              <TableRow key={set.id}>
                <TableCell className="font-medium">{set.name}</TableCell>
                <TableCell className="text-right tabular-nums">
                  {formatNumber(set.cardCount)}
                </TableCell>
                <TableCell>{formatDate(set.createdAt)}</TableCell>
                <TableCell className="text-right">
                  <div className="flex items-center justify-end gap-1">
                    <SetFormDialog
                      mode="edit"
                      initialValues={{
                        id: set.id,
                        name: set.name,
                      }}
                    />
                    {isAdmin && (
                      <DeleteSetButton
                        id={set.id}
                        name={set.name}
                        cardCount={set.cardCount}
                      />
                    )}
                  </div>
                </TableCell>
              </TableRow>
            ))}
            {data.length === 0 && (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={4} className="p-3">
                  <div className="rounded-2xl border border-dashed bg-card/30">
                    <EmptyState
                      icon={Library}
                      title="No sets found"
                      description="Create a set to group cards into a series (e.g. One Piece)."
                    />
                  </div>
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </div>
  );
}
