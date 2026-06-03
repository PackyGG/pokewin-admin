"use client";

import { useState, useTransition } from "react";
import { ColumnDef } from "@tanstack/react-table";
import { useRouter } from "next/navigation";
import { Trash2 } from "lucide-react";
import { toast } from "sonner";
import { formatCurrency, formatDate } from "@/lib/utils/format";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogTrigger,
} from "@/components/ui/alert-dialog";
import type { PromoCodeListItem } from "@/lib/queries/promo-codes";
import { deletePromoCode } from "./actions";
import { PromoCodeDetailDialog } from "./promo-code-detail-dialog";
import { usePromoCodesSelection } from "./promo-codes-selection-context";

function codeStatus(
  row: PromoCodeListItem,
): { label: string; cls: string } {
  const isExpired =
    row.expiresAt && new Date(row.expiresAt) < new Date();
  const isUsedUp = row.redemptionCount >= row.maxUses;
  if (isExpired)
    return {
      label: "Expired",
      cls: "border-rose-500/30 bg-rose-500/15 text-rose-400",
    };
  if (isUsedUp)
    return {
      label: "Used up",
      cls: "border-amber-500/30 bg-amber-500/15 text-amber-400",
    };
  return {
    label: "Active",
    cls: "border-emerald-500/30 bg-emerald-500/15 text-emerald-400",
  };
}

// The clickable code → opens the claim detail dialog (who claimed it,
// summary, limits). Replaces the old navigate-to-/promo-codes/[id] link
// per the reworked-page brief; the standalone detail route still exists
// for deep-links but the in-table affordance is now a popup.
function CodeCell({ row }: { row: PromoCodeListItem }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="font-mono text-xs text-left hover:underline"
        title="View claims"
      >
        {row.code ?? row.codeHash.slice(0, 16) + "…"}
      </button>
      <PromoCodeDetailDialog row={row} open={open} onOpenChange={setOpen} />
    </>
  );
}

// Redemptions count — same click-through target as the code cell, so an
// admin can open the claim list from either column.
function RedemptionsCell({ row }: { row: PromoCodeListItem }) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="font-medium tabular-nums hover:underline"
        title="View claims"
      >
        {row.redemptionCount} / {row.maxUses}
      </button>
      <PromoCodeDetailDialog row={row} open={open} onOpenChange={setOpen} />
    </>
  );
}

// Region badge — subtle colored chip matching the rest of the admin
// palette. NA = blue, EU = purple. Unknown values fall through to a
// neutral muted style so a future region (e.g. APAC) doesn't render
// blank if the schema is extended before this list is updated.
function RegionBadge({ region }: { region: string }) {
  const cls =
    region === "NA"
      ? "border-blue-500/30 bg-blue-500/15 text-blue-600 dark:text-blue-400"
      : region === "EU"
        ? "border-purple-500/30 bg-purple-500/15 text-purple-600 dark:text-purple-400"
        : "border-muted bg-muted/40 text-muted-foreground";
  return (
    <Badge variant="outline" className={cls}>
      {region}
    </Badge>
  );
}

// Compact requirements summary so admins can scan eligibility gates
// at a glance without opening the detail page. Fields with a zero /
// false default are dropped — only the gates that ACTUALLY restrict
// redemption show up. Renders "—" when nothing is gated so the
// column doesn't look empty.
function RequirementsCell({ row }: { row: PromoCodeListItem }) {
  const parts: string[] = [];
  if (row.minimumLevel > 0) parts.push(`Lv ${row.minimumLevel}`);
  if (row.minimumWagerAmount > 0) {
    // Append the window when there is one ("$100w / 7d") so the admin
    // can tell a "lifetime $100 wager" gate from a "$100 in last 7
    // days" gate. wager_period_days = 0 means lifetime.
    const wager = formatCurrency(row.minimumWagerAmount);
    parts.push(
      row.wagerPeriodDays > 0
        ? `${wager}w / ${row.wagerPeriodDays}d`
        : `${wager}w`,
    );
  }
  if (row.minimumAccountAgeDays > 0) {
    parts.push(`${row.minimumAccountAgeDays}d age`);
  }
  if (row.minimumDepositAmount > 0) {
    parts.push(`${formatCurrency(row.minimumDepositAmount)}d`);
  }
  if (row.requiredAffiliateCode) {
    parts.push(`code ${row.requiredAffiliateCode}`);
  }
  if (row.requiresDiscord) parts.push("Discord");

  if (parts.length === 0) {
    return <span className="text-muted-foreground">—</span>;
  }
  return (
    <span className="text-xs text-muted-foreground">{parts.join(" · ")}</span>
  );
}

// Inline row-level delete. Same server action as the detail page's
// DeletePromoCodeButton, but stays on the list and just refreshes the
// route instead of navigating away. Server enforces the
// `__can_delete_promo_code` capability — the button is shown for
// everyone but the action will reject unauthorized users with a toast.
//
// IMPORTANT: AlertDialogAction in this codebase is just a styled
// <Button> (see src/components/ui/alert-dialog.tsx) — clicking it does
// NOT auto-close the dialog. We have to control `open` explicitly and
// call setOpen(false) after the action completes, otherwise:
//   • the popup stays open after a successful delete (visible bug)
//   • a confused admin can double-click Delete on the same row,
//     firing a second deletePromoCode for an already-deleted row,
//     which used to throw P2025 and trigger the page-level error
//     boundary. The server action is now idempotent (deleteMany)
//     too, but the UX still needs the explicit close.
function RowDeleteButton({ promoCodeId }: { promoCodeId: string }) {
  const [open, setOpen] = useState(false);
  const [isPending, startTransition] = useTransition();
  const router = useRouter();
  // Keep the toolbar Quick-select counts in sync after a single-row
  // delete too — same data-version bump the bulk-delete uses, so the
  // used-up / expired badges drop a deleted code without a full reload.
  const { bumpDataVersion } = usePromoCodesSelection();

  function handleDelete() {
    startTransition(async () => {
      try {
        await deletePromoCode(promoCodeId);
        toast.success("Promo code deleted");
        setOpen(false);
        bumpDataVersion();
        router.refresh();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Failed to delete");
        setOpen(false);
      }
    });
  }

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <AlertDialogTrigger
        render={
          <Button
            variant="ghost"
            size="icon"
            disabled={isPending}
            className="size-8 text-muted-foreground hover:text-rose-600 dark:hover:text-rose-400"
            aria-label="Delete promo code"
          />
        }
      >
        <Trash2 className="size-4" />
      </AlertDialogTrigger>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Delete Promo Code?</AlertDialogTitle>
          <AlertDialogDescription>
            This action cannot be undone. This will permanently delete the
            promo code.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={isPending}>Cancel</AlertDialogCancel>
          <AlertDialogAction onClick={handleDelete} disabled={isPending}>
            {isPending ? "Deleting…" : "Delete"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

export const columns: ColumnDef<PromoCodeListItem>[] = [
  {
    id: "select",
    enableSorting: false,
    enableHiding: false,
    header: ({ table }) => {
      // Use the row-level (not page-level) selection helpers — the
      // page-level versions (`getIsAllPageRowsSelected`,
      // `toggleAllPageRowsSelected`) require `getPaginationRowModel`
      // to be wired up, which we don't have. base-ui Checkbox in
      // this codebase only supports boolean (no tri-state), so we
      // treat "some selected" as checked too — a single header click
      // then flips between toggle-all-on / toggle-all-off.
      const checked =
        table.getIsAllRowsSelected() || table.getIsSomeRowsSelected();
      return (
        <Checkbox
          checked={checked}
          onCheckedChange={(v) => table.toggleAllRowsSelected(v === true)}
          aria-label="Select all rows"
        />
      );
    },
    cell: ({ row }) => (
      <Checkbox
        checked={row.getIsSelected()}
        onCheckedChange={(v) => row.toggleSelected(v === true)}
        aria-label={`Select promo code ${row.original.code ?? row.original.codeHash.slice(0, 12)}`}
      />
    ),
  },
  {
    accessorKey: "code",
    header: "Code",
    cell: ({ row }) => <CodeCell row={row.original} />,
  },
  {
    accessorKey: "region",
    header: "Region",
    cell: ({ row }) => <RegionBadge region={row.original.region} />,
  },
  {
    accessorKey: "value",
    header: "Value",
    cell: ({ row }) => formatCurrency(row.original.value),
  },
  {
    id: "requirements",
    header: "Requirements",
    cell: ({ row }) => <RequirementsCell row={row.original} />,
  },
  {
    accessorKey: "maxUses",
    header: "Max Uses",
  },
  {
    accessorKey: "redemptionCount",
    header: "Redemptions",
    cell: ({ row }) => <RedemptionsCell row={row.original} />,
  },
  {
    id: "status",
    header: "Status",
    cell: ({ row }) => {
      const s = codeStatus(row.original);
      return (
        <Badge variant="outline" className={s.cls}>
          {s.label}
        </Badge>
      );
    },
  },
  {
    accessorKey: "expiresAt",
    header: "Expires",
    cell: ({ row }) => {
      if (!row.original.expiresAt) return "Never";
      const expired = new Date(row.original.expiresAt) < new Date();
      return (
        <span className={expired ? "text-rose-400" : ""}>
          {formatDate(row.original.expiresAt)}
        </span>
      );
    },
  },
  {
    accessorKey: "createdAt",
    header: "Created",
    cell: ({ row }) => formatDate(row.original.createdAt),
  },
  {
    id: "actions",
    header: "",
    cell: ({ row }) => (
      <div className="flex justify-end">
        <RowDeleteButton promoCodeId={row.original.id} />
      </div>
    ),
  },
];
