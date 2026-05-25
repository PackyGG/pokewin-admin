"use client";

import { useEffect, useState, useTransition } from "react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  Copy,
  ExternalLink,
  Pencil,
  Plus,
  QrCode,
  Trash2,
  Wallet,
} from "lucide-react";
import QRCode from "qrcode";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
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
import { cn } from "@/lib/utils";
import { EmptyState } from "@/components/empty-state";
import {
  addSalaryEmployee,
  deleteSalaryEmployee,
  updateSalaryEmployee,
} from "./actions";

type Cadence = "weekly" | "biweekly" | "monthly";

// Chain the saved address belongs to — derived server-side from the
// address format and passed down (the client never re-detects).
type AddressKind = "erc20" | "sol" | "unknown";

type Employee = {
  id: string;
  discordName: string;
  ethAddress: string;
  addressKind: AddressKind;
  cadence: Cadence;
  salaryUsdt: number;
  active: boolean;
  notes: string | null;
};

const CADENCE_LABELS: Record<Cadence, string> = {
  weekly: "Weekly",
  biweekly: "Bi-weekly",
  monthly: "Monthly",
};

const CADENCE_COLORS: Record<Cadence, string> = {
  weekly:
    "bg-cyan-500/15 text-cyan-600 dark:text-cyan-400 border-cyan-500/30",
  biweekly:
    "bg-blue-500/15 text-blue-600 dark:text-blue-400 border-blue-500/30",
  monthly:
    "bg-purple-500/15 text-purple-600 dark:text-purple-400 border-purple-500/30",
};

// ── Address-type tag (ERC-20 / SOL) ─────────────────────────────────

const ADDRESS_KIND_META: Record<
  AddressKind,
  { label: string; className: string }
> = {
  erc20: {
    label: "ERC-20",
    className:
      "bg-indigo-500/15 text-indigo-600 dark:text-indigo-400 border-indigo-500/30",
  },
  sol: {
    label: "SOL",
    className:
      "bg-purple-500/15 text-purple-600 dark:text-purple-400 border-purple-500/30",
  },
  unknown: {
    label: "Unknown",
    className: "bg-muted text-muted-foreground border-border",
  },
};

function AddressTag({ kind }: { kind: AddressKind }) {
  const meta = ADDRESS_KIND_META[kind];
  return (
    <Badge
      variant="outline"
      className={cn("shrink-0 text-[10px] font-medium", meta.className)}
    >
      {meta.label}
    </Badge>
  );
}

// Per-chain QR-dialog copy + block explorer. `null` explorer = no link
// (unknown format).
const EXPLORER: Record<
  AddressKind,
  { name: string; addressUrl: (a: string) => string } | null
> = {
  erc20: {
    name: "Etherscan",
    addressUrl: (a) => `https://etherscan.io/address/${a}`,
  },
  sol: {
    name: "Solscan",
    addressUrl: (a) => `https://solscan.io/account/${a}`,
  },
  unknown: null,
};

const SCAN_HINT: Record<AddressKind, string> = {
  erc20: "Scan with any Ethereum wallet to send USDT (ERC-20) on mainnet.",
  sol: "Scan with any Solana wallet to send to this address.",
  unknown: "Scan with the matching wallet — verify the network first.",
};

const NETWORK_NOTE: Record<AddressKind, string> = {
  erc20:
    "Network: Ethereum Mainnet (USDT contract 0xdAC17F95…1ec7). Sending other tokens or the wrong network = lost funds.",
  sol: "Network: Solana. Sending the wrong token or network = lost funds.",
  unknown:
    "Unrecognized address format — double-check which network this belongs to before sending.",
};

export function SalariesClient({ employees }: { employees: Employee[] }) {
  return (
    <div className="space-y-4">
      <EmployeesCard employees={employees} />
    </div>
  );
}

// ── Employees card ──────────────────────────────────────────────────

function EmployeesCard({ employees }: { employees: Employee[] }) {
  const [adding, setAdding] = useState(false);
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-base">
            <Wallet className="size-4 text-amber-500" />
            Employees
          </CardTitle>
          <Button size="sm" onClick={() => setAdding(true)}>
            <Plus className="size-4" />
            Add Employee
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          Saved recipients with their default salary. Each address is
          tagged ERC-20 or Solana. Click an address to view its QR code,
          then scan it with your wallet to pay manually.
        </p>
      </CardHeader>
      <CardContent>
        {employees.length === 0 ? (
          <div className="rounded-md border border-dashed">
            <EmptyState
              icon={Wallet}
              title="No employees yet"
              description="Add one to start tracking salaries."
              compact
            />
          </div>
        ) : (
          <>
            {/* Desktop table (>=md). Horizontal scroll guard so the
                columns never blow up the layout on tablet widths. */}
            <div className="hidden rounded-md border overflow-x-auto md:block">
              <table className="w-full">
                <thead>
                  <tr className="border-b bg-muted/50">
                    <th className="px-3 py-2 text-left text-xs font-medium">
                      Discord
                    </th>
                    <th className="px-3 py-2 text-left text-xs font-medium">
                      Address (click for QR)
                    </th>
                    <th className="px-3 py-2 text-left text-xs font-medium">
                      Cadence
                    </th>
                    <th className="px-3 py-2 text-right text-xs font-medium">
                      Salary
                    </th>
                    <th className="px-3 py-2 text-right text-xs font-medium">
                      Actions
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {employees.map((e) => (
                    <EmployeeRow key={e.id} employee={e} />
                  ))}
                </tbody>
              </table>
            </div>

            {/* Mobile card list (<md) — the table overflows at 360px, so
                each employee renders as a stacked card with ≥40px touch
                targets for the actions. */}
            <div className="space-y-2 md:hidden">
              {employees.map((e) => (
                <EmployeeMobileCard key={e.id} employee={e} />
              ))}
            </div>
          </>
        )}
      </CardContent>
      <EmployeeFormDialog
        open={adding}
        onClose={() => setAdding(false)}
        employee={null}
      />
    </Card>
  );
}

function EmployeeRow({ employee }: { employee: Employee }) {
  const [qrOpen, setQrOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  return (
    <>
      <tr
        className={`border-b last:border-b-0 ${employee.active ? "" : "opacity-60"}`}
      >
        <td className="px-3 py-2 text-sm font-medium">
          <span className="font-mono">{employee.discordName}</span>
          {!employee.active && (
            <Badge variant="outline" className="ml-1.5 text-[10px]">
              inactive
            </Badge>
          )}
        </td>
        <td className="px-3 py-2">
          <div className="flex items-center gap-1.5">
            <button
              type="button"
              onClick={() => setQrOpen(true)}
              className="inline-flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-xs font-mono text-blue-500 hover:bg-blue-500/10 hover:underline"
              title="Click to view QR code"
            >
              <QrCode className="size-3" />
              {employee.ethAddress.slice(0, 6)}…{employee.ethAddress.slice(-4)}
            </button>
            <AddressTag kind={employee.addressKind} />
          </div>
        </td>
        <td className="px-3 py-2">
          <Badge
            variant="outline"
            className={`text-[10px] ${CADENCE_COLORS[employee.cadence]}`}
          >
            {CADENCE_LABELS[employee.cadence]}
          </Badge>
        </td>
        <td className="px-3 py-2 text-right text-sm tabular-nums">
          ${employee.salaryUsdt.toFixed(2)}
          <span className="ml-1 text-[10px] text-muted-foreground">
            /{employee.cadence === "monthly" ? "mo" : employee.cadence === "weekly" ? "wk" : "2wk"}
          </span>
          {employee.cadence !== "monthly" && (
            <div className="text-[10px] text-muted-foreground">
              ≈ $
              {(
                employee.salaryUsdt *
                (employee.cadence === "weekly" ? 52 / 12 : 26 / 12)
              ).toLocaleString(undefined, { maximumFractionDigits: 2 })}{" "}
              /mo
            </div>
          )}
        </td>
        <td className="px-3 py-2 text-right">
          <div className="flex items-center justify-end gap-1">
            <Button
              size="icon"
              variant="ghost"
              className="size-7"
              onClick={() => setEditOpen(true)}
              aria-label="Edit"
            >
              <Pencil className="size-3.5" />
            </Button>
            <DeleteEmployeeButton employee={employee} />
          </div>
        </td>
      </tr>
      <AddressQrDialog
        open={qrOpen}
        onClose={() => setQrOpen(false)}
        employee={employee}
      />
      <EmployeeFormDialog
        open={editOpen}
        onClose={() => setEditOpen(false)}
        employee={employee}
      />
    </>
  );
}

// Mobile equivalent of EmployeeRow — same data + actions + dialogs,
// laid out as a stacked card so the table doesn't overflow on phones.
function EmployeeMobileCard({ employee }: { employee: Employee }) {
  const [qrOpen, setQrOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  const perMonth =
    employee.cadence === "monthly"
      ? null
      : employee.salaryUsdt *
        (employee.cadence === "weekly" ? 52 / 12 : 26 / 12);
  return (
    <div
      className={cn(
        "rounded-lg border bg-card p-3",
        !employee.active && "opacity-60",
      )}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="flex min-w-0 flex-wrap items-center gap-1.5">
          <span className="font-mono text-sm font-medium">
            {employee.discordName}
          </span>
          {!employee.active && (
            <Badge variant="outline" className="text-[10px]">
              inactive
            </Badge>
          )}
          <Badge
            variant="outline"
            className={cn("text-[10px]", CADENCE_COLORS[employee.cadence])}
          >
            {CADENCE_LABELS[employee.cadence]}
          </Badge>
        </div>
        <div className="text-right">
          <div className="text-sm font-semibold tabular-nums">
            ${employee.salaryUsdt.toFixed(2)}
            <span className="ml-1 text-[10px] font-normal text-muted-foreground">
              /
              {employee.cadence === "monthly"
                ? "mo"
                : employee.cadence === "weekly"
                  ? "wk"
                  : "2wk"}
            </span>
          </div>
          {perMonth != null && (
            <div className="text-[10px] text-muted-foreground tabular-nums">
              ≈ $
              {perMonth.toLocaleString(undefined, {
                maximumFractionDigits: 2,
              })}{" "}
              /mo
            </div>
          )}
        </div>
      </div>

      <div className="mt-2 flex flex-wrap items-center gap-1.5">
        <button
          type="button"
          onClick={() => setQrOpen(true)}
          className="inline-flex items-center gap-1.5 rounded-md px-1.5 py-1 text-xs font-mono text-blue-500 hover:bg-blue-500/10 hover:underline"
          title="Click to view QR code"
        >
          <QrCode className="size-3" />
          {employee.ethAddress.slice(0, 6)}…{employee.ethAddress.slice(-4)}
        </button>
        <AddressTag kind={employee.addressKind} />
      </div>

      <div className="mt-3 flex items-center gap-2">
        <Button
          size="sm"
          variant="outline"
          className="h-9 flex-1"
          onClick={() => setEditOpen(true)}
        >
          <Pencil className="size-4" />
          Edit
        </Button>
        <DeleteEmployeeButton employee={employee} className="size-9" />
      </div>

      <AddressQrDialog
        open={qrOpen}
        onClose={() => setQrOpen(false)}
        employee={employee}
      />
      <EmployeeFormDialog
        open={editOpen}
        onClose={() => setEditOpen(false)}
        employee={employee}
      />
    </div>
  );
}

// ── QR Code modal ───────────────────────────────────────────────────

function AddressQrDialog({
  open,
  onClose,
  employee,
}: {
  open: boolean;
  onClose: () => void;
  employee: Employee;
}) {
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const explorer = EXPLORER[employee.addressKind];

  useEffect(() => {
    if (!open) {
      setDataUrl(null);
      return;
    }
    let cancelled = false;
    // Generate the QR for the bare address — universally scannable by
    // any wallet on the matching network.
    QRCode.toDataURL(employee.ethAddress, {
      errorCorrectionLevel: "M",
      margin: 2,
      width: 320,
      color: { dark: "#000000", light: "#FFFFFF" },
    })
      .then((url) => {
        if (!cancelled) setDataUrl(url);
      })
      .catch(() => {
        if (!cancelled) setDataUrl(null);
      });
    return () => {
      cancelled = true;
    };
  }, [open, employee.ethAddress]);

  function copy(text: string, label: string) {
    navigator.clipboard
      .writeText(text)
      .then(() => toast.success(`${label} copied`))
      .catch(() => toast.error("Copy failed"));
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) onClose();
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <QrCode className="size-4 text-amber-500" />
            {employee.discordName} — Wallet Address
            <AddressTag kind={employee.addressKind} />
          </DialogTitle>
          <DialogDescription>
            {SCAN_HINT[employee.addressKind]} Salary per period: $
            {employee.salaryUsdt.toFixed(2)}.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <div className="flex justify-center">
            {dataUrl ? (
              <Image
                src={dataUrl}
                alt={`QR for ${employee.ethAddress}`}
                width={280}
                height={280}
                className="rounded-lg border bg-white p-2"
                unoptimized
              />
            ) : (
              <div className="size-[280px] animate-pulse rounded-lg bg-muted" />
            )}
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">Address</Label>
            <div className="flex items-center gap-1">
              <code className="flex-1 rounded-md bg-muted px-2 py-1.5 text-xs font-mono break-all">
                {employee.ethAddress}
              </code>
              <Button
                size="icon"
                variant="ghost"
                className="size-7 shrink-0"
                onClick={() => copy(employee.ethAddress, "Address")}
                aria-label="Copy address"
              >
                <Copy className="size-3.5" />
              </Button>
              {explorer && (
                <Button
                  size="icon"
                  variant="ghost"
                  className="size-7 shrink-0"
                  render={
                    <a
                      href={explorer.addressUrl(employee.ethAddress)}
                      target="_blank"
                      rel="noreferrer"
                      aria-label={`Open in ${explorer.name}`}
                    >
                      <ExternalLink className="size-3.5" />
                    </a>
                  }
                />
              )}
            </div>
            <p className="text-[10px] text-muted-foreground">
              {NETWORK_NOTE[employee.addressKind]}
            </p>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ── Employee form (add + edit) ──────────────────────────────────────

function EmployeeFormDialog({
  open,
  onClose,
  employee,
}: {
  open: boolean;
  onClose: () => void;
  employee: Employee | null;
}) {
  const router = useRouter();
  const [discordName, setDiscordName] = useState(employee?.discordName ?? "");
  const [address, setAddress] = useState(employee?.ethAddress ?? "");
  const [cadence, setCadence] = useState<Cadence>(employee?.cadence ?? "monthly");
  const [salary, setSalary] = useState(
    employee ? String(employee.salaryUsdt) : "",
  );
  const [active, setActive] = useState(employee?.active ?? true);
  const [notes, setNotes] = useState(employee?.notes ?? "");
  const [pending, startTransition] = useTransition();
  const isEdit = Boolean(employee);

  function reset() {
    setDiscordName(employee?.discordName ?? "");
    setAddress(employee?.ethAddress ?? "");
    setCadence(employee?.cadence ?? "monthly");
    setSalary(employee ? String(employee.salaryUsdt) : "");
    setActive(employee?.active ?? true);
    setNotes(employee?.notes ?? "");
  }

  function handleSubmit() {
    if (!discordName.trim()) {
      toast.error("Discord name is required");
      return;
    }
    if (!address.trim()) {
      toast.error("Address is required");
      return;
    }
    const sal = parseFloat(salary);
    if (!Number.isFinite(sal) || sal <= 0) {
      toast.error("Salary must be > 0");
      return;
    }
    startTransition(async () => {
      const result = isEdit
        ? await updateSalaryEmployee({
            id: employee!.id,
            discordName: discordName.trim(),
            ethAddress: address.trim(),
            cadence,
            salaryUsdt: sal,
            active,
            notes: notes.trim() || null,
          })
        : await addSalaryEmployee({
            discordName: discordName.trim(),
            ethAddress: address.trim(),
            cadence,
            salaryUsdt: sal,
            active,
            notes: notes.trim() || null,
          });
      if (!result.success) {
        toast.error(result.error);
        return;
      }
      toast.success(isEdit ? "Employee updated" : "Employee added");
      reset();
      onClose();
      router.refresh();
    });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(o) => {
        if (!o) {
          onClose();
          reset();
        }
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>
            {isEdit ? "Edit Employee" : "Add Employee"}
          </DialogTitle>
        </DialogHeader>
        <div className="space-y-3">
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">
              Discord Name
            </Label>
            <Input
              value={discordName}
              onChange={(e) => setDiscordName(e.target.value)}
              placeholder="alice or alice#1234"
              maxLength={80}
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">
              Wallet Address (ERC-20 or Solana)
            </Label>
            <Input
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              placeholder="0x… (ERC-20) or a Solana address"
              className="font-mono text-xs"
            />
            <p className="text-[10px] text-muted-foreground">
              Auto-tagged ERC-20 or Solana from the address format.
            </p>
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">Cadence</Label>
            <select
              value={cadence}
              onChange={(e) => setCadence(e.target.value as Cadence)}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            >
              <option value="weekly">Weekly</option>
              <option value="biweekly">Bi-weekly</option>
              <option value="monthly">Monthly</option>
            </select>
            <p className="text-[10px] text-muted-foreground">
              Salary below is the amount per pay period (per
              {cadence === "weekly"
                ? " week"
                : cadence === "biweekly"
                  ? " 2 weeks"
                  : " month"}
              ).
            </p>
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">
              Salary per Period (USDT)
            </Label>
            <Input
              type="number"
              step="0.01"
              min="0"
              value={salary}
              onChange={(e) => setSalary(e.target.value)}
              placeholder="500"
            />
            {/* For weekly/biweekly cadences show the calendar-month
                equivalent so it's obvious what the actual monthly
                cost is. Same factor used in page.tsx for the
                Monthly Budget KPI: weekly ×52/12, biweekly ×26/12. */}
            {(() => {
              const sal = parseFloat(salary);
              if (!Number.isFinite(sal) || sal <= 0) return null;
              if (cadence === "monthly") return null;
              const factor = cadence === "weekly" ? 52 / 12 : 26 / 12;
              const perMonth = sal * factor;
              return (
                <p className="text-[10px] text-muted-foreground">
                  ≈ ${perMonth.toLocaleString(undefined, {
                    maximumFractionDigits: 2,
                  })}{" "}
                  per month
                </p>
              );
            })()}
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">Notes</Label>
            <Textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              placeholder="Role, special arrangements, etc."
              maxLength={500}
            />
          </div>
          <label className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={active}
              onChange={(e) => setActive(e.target.checked)}
            />
            <span>Active (eligible for payments)</span>
          </label>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button onClick={handleSubmit} disabled={pending}>
            {pending ? "Saving…" : isEdit ? "Save" : "Add"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function DeleteEmployeeButton({
  employee,
  className,
}: {
  employee: Employee;
  className?: string;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();

  function handleDelete() {
    startTransition(async () => {
      const result = await deleteSalaryEmployee(employee.id);
      if (!result.success) {
        toast.error(result.error);
        return;
      }
      toast.success("Employee removed");
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
        onClick={() => setOpen(true)}
        aria-label="Remove"
      >
        <Trash2 className="size-3.5" />
      </Button>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Remove {employee.discordName}?</AlertDialogTitle>
          <AlertDialogDescription>
            Removes the saved salary record for{" "}
            <span className="font-medium">{employee.discordName}</span>. If
            they have any payouts on file, this will be blocked —
            deactivate instead.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={handleDelete}
            disabled={pending}
            className="bg-rose-500 hover:bg-rose-500/90"
          >
            {pending ? "Removing…" : "Remove"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}
