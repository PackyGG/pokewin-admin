"use client";

import { useMemo, useState, useTransition } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  Plus,
  Trash2,
  Pencil,
  Search,
  Wallet,
  ChevronRight,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { ROLE_COLORS } from "@/lib/constants";
import { cn } from "@/lib/utils";
import { formatRelative } from "@/lib/utils/format";
import { EmptyState } from "@/components/empty-state";
import { setAdminLimit, deleteAdminLimit } from "../limits-actions";
import type { limit_period_type } from "@/generated/admin-prisma/client";

type Row = {
  id: string;
  adminUserId: string;
  adminUsername: string;
  adminEmail: string;
  adminRole: string;
  periodType: limit_period_type;
  maxAmount: number;
  setByUsername: string | null;
  updatedAt: string;
};

type AdminOption = {
  id: string;
  username: string;
  email: string;
  role: string;
};

const PERIODS: limit_period_type[] = ["daily", "weekly", "monthly"];
const PERIOD_LABEL: Record<limit_period_type, string> = {
  daily: "Daily",
  weekly: "Weekly",
  monthly: "Monthly",
};

export function BalanceLimitsOverview({
  rows,
  allAdmins,
}: {
  rows: Row[];
  allAdmins: AdminOption[];
}) {
  const [query, setQuery] = useState("");

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter(
      (r) =>
        r.adminUsername.toLowerCase().includes(q) ||
        r.adminEmail.toLowerCase().includes(q) ||
        r.adminRole.toLowerCase().includes(q),
    );
  }, [rows, query]);

  return (
    <div className="space-y-4">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="relative w-full max-w-sm">
          <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Filter by username, email, or role…"
            className="pl-9"
          />
        </div>
        <AddLimitDialog allAdmins={allAdmins} />
      </div>

      {filtered.length === 0 ? (
        <div className="rounded-2xl border">
          {rows.length === 0 ? (
            <EmptyState
              icon={Wallet}
              title="No balance caps set on any admin"
              description={
                <>
                  Click <span className="font-medium">Add Limit</span> to cap an
                  admin&apos;s adjustment power.
                </>
              }
              compact
            />
          ) : (
            <EmptyState
              icon={Search}
              title="No caps match your search"
              compact
            />
          )}
        </div>
      ) : (
        <>
          {/* Desktop table (>=md). */}
          <div className="hidden rounded-2xl border overflow-x-auto md:block">
            <table className="w-full">
              <thead>
                <tr className="border-b bg-muted/50">
                  <th className="px-4 py-3 text-left text-sm font-medium">
                    Admin
                  </th>
                  <th className="px-4 py-3 text-left text-sm font-medium">
                    Role
                  </th>
                  <th className="px-4 py-3 text-left text-sm font-medium">
                    Period
                  </th>
                  <th className="px-4 py-3 text-right text-sm font-medium">
                    Cap
                  </th>
                  <th className="px-4 py-3 text-left text-sm font-medium">
                    Set by
                  </th>
                  <th className="px-4 py-3 text-left text-sm font-medium">
                    Updated
                  </th>
                  <th className="px-4 py-3 text-right text-sm font-medium w-[140px]">
                    Actions
                  </th>
                </tr>
              </thead>
              <tbody>
                {filtered.map((row) => (
                  <LimitRow key={row.id} row={row} />
                ))}
              </tbody>
            </table>
          </div>

          {/* Mobile card list (<md) — the 7-col table overflows at
              360px. Each cap renders as a stacked card with inline
              edit + delete. */}
          <div className="space-y-2 md:hidden">
            {filtered.map((row) => (
              <LimitMobileCard key={row.id} row={row} />
            ))}
          </div>
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Row with inline edit + delete
// ---------------------------------------------------------------------------

function LimitRow({ row }: { row: Row }) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(String(row.maxAmount));
  const [pending, startTransition] = useTransition();
  const roleColor =
    ROLE_COLORS[row.adminRole as keyof typeof ROLE_COLORS] ??
    "bg-zinc-500/15 text-zinc-600 dark:text-zinc-400 border-zinc-500/30";

  function handleSave() {
    const amount = parseFloat(value);
    if (Number.isNaN(amount) || amount <= 0) {
      toast.error("Enter a positive amount");
      return;
    }
    startTransition(async () => {
      const result = await setAdminLimit({
        adminUserId: row.adminUserId,
        periodType: row.periodType,
        maxAmount: amount,
      });
      if (!result.success) {
        toast.error(result.error);
        return;
      }
      toast.success(
        `${PERIOD_LABEL[row.periodType]} cap for ${row.adminUsername} → $${amount.toFixed(2)}`,
      );
      setEditing(false);
      router.refresh();
    });
  }

  return (
    <tr className="border-b last:border-b-0 hover:bg-muted/30 transition-colors">
      <td className="px-4 py-3 text-sm">
        <Link
          href={`/admin-users/${row.adminUserId}`}
          className="inline-flex items-center gap-1.5 font-medium hover:underline"
        >
          {row.adminUsername}
          <ChevronRight className="size-3 text-muted-foreground" />
        </Link>
        <p className="text-xs text-muted-foreground">{row.adminEmail}</p>
      </td>
      <td className="px-4 py-3">
        <Badge variant="outline" className={roleColor}>
          {row.adminRole}
        </Badge>
      </td>
      <td className="px-4 py-3">
        <Badge variant="outline" className="capitalize">
          {PERIOD_LABEL[row.periodType]}
        </Badge>
      </td>
      <td className="px-4 py-3 text-right tabular-nums">
        {editing ? (
          <div className="flex items-center justify-end gap-1">
            <span className="text-sm text-muted-foreground">$</span>
            <Input
              type="number"
              className="h-7 w-28 text-sm"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              min={0}
              step={0.01}
              autoFocus
              onKeyDown={(e) => {
                if (e.key === "Enter") handleSave();
                if (e.key === "Escape") {
                  setEditing(false);
                  setValue(String(row.maxAmount));
                }
              }}
            />
          </div>
        ) : (
          <span className="font-medium">${row.maxAmount.toLocaleString()}</span>
        )}
      </td>
      <td className="px-4 py-3 text-sm text-muted-foreground">
        {row.setByUsername ?? <span className="italic">unknown</span>}
      </td>
      <td className="px-4 py-3 text-sm text-muted-foreground">
        {formatRelative(row.updatedAt)}
      </td>
      <td className="px-4 py-3 text-right">
        <div className="flex items-center justify-end gap-1">
          {editing ? (
            <>
              <Button
                size="sm"
                variant="outline"
                className="h-7 text-xs"
                disabled={pending}
                onClick={handleSave}
              >
                Save
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-7 text-xs"
                disabled={pending}
                onClick={() => {
                  setEditing(false);
                  setValue(String(row.maxAmount));
                }}
              >
                Cancel
              </Button>
            </>
          ) : (
            <>
              <Button
                size="icon"
                variant="ghost"
                className="size-7"
                aria-label="Edit cap"
                onClick={() => setEditing(true)}
              >
                <Pencil className="size-3.5" />
              </Button>
              <DeleteLimitButton row={row} />
            </>
          )}
        </div>
      </td>
    </tr>
  );
}

// ---------------------------------------------------------------------------
// Mobile equivalent of LimitRow — stacked card with inline edit/delete.
// Same actions + server calls as the desktop row; touch targets >=36px.
// ---------------------------------------------------------------------------

function LimitMobileCard({ row }: { row: Row }) {
  const router = useRouter();
  const [editing, setEditing] = useState(false);
  const [value, setValue] = useState(String(row.maxAmount));
  const [pending, startTransition] = useTransition();
  const roleColor =
    ROLE_COLORS[row.adminRole as keyof typeof ROLE_COLORS] ??
    "bg-zinc-500/15 text-zinc-600 dark:text-zinc-400 border-zinc-500/30";

  function handleSave() {
    const amount = parseFloat(value);
    if (Number.isNaN(amount) || amount <= 0) {
      toast.error("Enter a positive amount");
      return;
    }
    startTransition(async () => {
      const result = await setAdminLimit({
        adminUserId: row.adminUserId,
        periodType: row.periodType,
        maxAmount: amount,
      });
      if (!result.success) {
        toast.error(result.error);
        return;
      }
      toast.success(
        `${PERIOD_LABEL[row.periodType]} cap for ${row.adminUsername} → $${amount.toFixed(2)}`,
      );
      setEditing(false);
      router.refresh();
    });
  }

  return (
    <div className="rounded-xl border bg-card p-3">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <Link
            href={`/admin-users/${row.adminUserId}`}
            className="inline-flex items-center gap-1 font-medium hover:underline"
          >
            {row.adminUsername}
            <ChevronRight className="size-3 text-muted-foreground" />
          </Link>
          <p className="truncate text-xs text-muted-foreground">
            {row.adminEmail}
          </p>
        </div>
        <div className="flex flex-wrap items-center justify-end gap-1.5">
          <Badge variant="outline" className={roleColor}>
            {row.adminRole}
          </Badge>
          <Badge variant="outline" className="capitalize">
            {PERIOD_LABEL[row.periodType]}
          </Badge>
        </div>
      </div>

      <div className="mt-3 flex items-center justify-between gap-2">
        {editing ? (
          <div className="flex items-center gap-1">
            <span className="text-sm text-muted-foreground">$</span>
            <Input
              type="number"
              className="h-9 w-28 text-sm"
              value={value}
              onChange={(e) => setValue(e.target.value)}
              min={0}
              step={0.01}
              autoFocus
              onKeyDown={(e) => {
                if (e.key === "Enter") handleSave();
                if (e.key === "Escape") {
                  setEditing(false);
                  setValue(String(row.maxAmount));
                }
              }}
            />
          </div>
        ) : (
          <span className="text-lg font-semibold tabular-nums">
            ${row.maxAmount.toLocaleString()}
          </span>
        )}
        <div className="flex items-center gap-1">
          {editing ? (
            <>
              <Button
                size="sm"
                variant="outline"
                className="h-9"
                disabled={pending}
                onClick={handleSave}
              >
                Save
              </Button>
              <Button
                size="sm"
                variant="ghost"
                className="h-9"
                disabled={pending}
                onClick={() => {
                  setEditing(false);
                  setValue(String(row.maxAmount));
                }}
              >
                Cancel
              </Button>
            </>
          ) : (
            <>
              <Button
                size="icon"
                variant="outline"
                className="size-9"
                aria-label="Edit cap"
                onClick={() => setEditing(true)}
              >
                <Pencil className="size-4" />
              </Button>
              <DeleteLimitButton row={row} className="size-9" />
            </>
          )}
        </div>
      </div>

      <p className="mt-2 text-[11px] text-muted-foreground">
        Set by {row.setByUsername ?? "unknown"} ·{" "}
        {formatRelative(row.updatedAt)}
      </p>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Delete confirm
// ---------------------------------------------------------------------------

function DeleteLimitButton({
  row,
  className,
}: {
  row: Row;
  className?: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();

  function handleDelete() {
    startTransition(async () => {
      const result = await deleteAdminLimit(row.adminUserId, row.periodType);
      if (!result.success) {
        toast.error(result.error);
        return;
      }
      toast.success(
        `${PERIOD_LABEL[row.periodType]} cap for ${row.adminUsername} removed`,
      );
      setOpen(false);
      router.refresh();
    });
  }

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <Button
        size="icon"
        variant="ghost"
        className={cn(
          "size-7 text-muted-foreground hover:text-rose-500",
          className,
        )}
        aria-label="Remove cap"
        onClick={() => setOpen(true)}
      >
        <Trash2 className="size-3.5" />
      </Button>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Remove this cap?</AlertDialogTitle>
          <AlertDialogDescription>
            This removes the{" "}
            <span className="font-mono">{PERIOD_LABEL[row.periodType]}</span>{" "}
            ${row.maxAmount.toLocaleString()} cap on{" "}
            <span className="font-medium">{row.adminUsername}</span>. After
            this, they will be able to adjust user balances without a{" "}
            {PERIOD_LABEL[row.periodType].toLowerCase()} cap (other periods
            still apply if set).
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={handleDelete}
            disabled={pending}
            className="bg-rose-500 hover:bg-rose-600 focus:ring-rose-500"
          >
            {pending ? "Removing…" : "Remove cap"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

// ---------------------------------------------------------------------------
// Add limit dialog
// ---------------------------------------------------------------------------

function AddLimitDialog({ allAdmins }: { allAdmins: AdminOption[] }) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [adminUserId, setAdminUserId] = useState("");
  const [periodType, setPeriodType] = useState<limit_period_type>("daily");
  const [amount, setAmount] = useState("");
  const [pending, startTransition] = useTransition();

  function reset() {
    setAdminUserId("");
    setPeriodType("daily");
    setAmount("");
  }

  function handleSave() {
    const parsed = parseFloat(amount);
    if (!adminUserId) {
      toast.error("Pick an admin");
      return;
    }
    if (Number.isNaN(parsed) || parsed <= 0) {
      toast.error("Enter a positive cap amount");
      return;
    }
    startTransition(async () => {
      const result = await setAdminLimit({
        adminUserId,
        periodType,
        maxAmount: parsed,
      });
      if (!result.success) {
        toast.error(result.error);
        return;
      }
      const target = allAdmins.find((a) => a.id === adminUserId);
      toast.success(
        `${PERIOD_LABEL[periodType]} cap of $${parsed.toFixed(2)} set on ${target?.username ?? "admin"}`,
      );
      reset();
      setOpen(false);
      router.refresh();
    });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        setOpen(o);
        if (!o) reset();
      }}
    >
      <DialogTrigger
        render={
          <Button size="sm">
            <Plus className="mr-1 size-4" />
            Add Limit
          </Button>
        }
      />
      <DialogContent>
        <DialogHeader>
          <DialogTitle>Add balance limit</DialogTitle>
          <DialogDescription>
            Caps how much this admin can adjust user balances within the
            selected period. Existing caps for the same admin + period are
            overwritten.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-4">
          <div className="space-y-1.5">
            <Label htmlFor="add-limit-admin">Admin</Label>
            <Select
              value={adminUserId}
              onValueChange={(v) => setAdminUserId(v ?? "")}
            >
              <SelectTrigger id="add-limit-admin">
                <SelectValue placeholder="Select admin user…" />
              </SelectTrigger>
              <SelectContent>
                {allAdmins.map((a) => (
                  <SelectItem key={a.id} value={a.id}>
                    <span className="font-medium">{a.username}</span>
                    <span className="ml-2 text-xs text-muted-foreground">
                      {a.role} · {a.email}
                    </span>
                  </SelectItem>
                ))}
              </SelectContent>
            </Select>
          </div>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <div className="space-y-1.5">
              <Label htmlFor="add-limit-period">Period</Label>
              <Select
                value={periodType}
                onValueChange={(v) => setPeriodType(v as limit_period_type)}
              >
                <SelectTrigger id="add-limit-period">
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  {PERIODS.map((p) => (
                    <SelectItem key={p} value={p}>
                      {PERIOD_LABEL[p]}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
            <div className="space-y-1.5">
              <Label htmlFor="add-limit-amount">Cap (USD)</Label>
              <Input
                id="add-limit-amount"
                type="number"
                placeholder="e.g. 500"
                value={amount}
                onChange={(e) => setAmount(e.target.value)}
                min={0}
                step={0.01}
              />
            </div>
          </div>
        </div>
        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => setOpen(false)}
            disabled={pending}
            className="w-full sm:w-auto"
          >
            Cancel
          </Button>
          <Button
            onClick={handleSave}
            disabled={pending}
            className="w-full sm:w-auto"
          >
            {pending ? "Saving…" : "Add cap"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
