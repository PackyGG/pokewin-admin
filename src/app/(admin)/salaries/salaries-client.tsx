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
  Receipt,
  RefreshCw,
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
import { formatRelative } from "@/lib/utils/format";
import { cn } from "@/lib/utils";
import { EmptyState } from "@/components/empty-state";
import {
  addSalaryEmployee,
  deleteSalaryEmployee,
  deleteSalaryPayout,
  recordSalaryPayout,
  updateSalaryEmployee,
} from "./actions";

type Cadence = "weekly" | "biweekly" | "monthly";

type Employee = {
  id: string;
  discordName: string;
  ethAddress: string;
  cadence: Cadence;
  salaryUsdt: number;
  active: boolean;
  lastPaidAt: string | null;
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

type Payout = {
  id: string;
  employeeId: string;
  employeeDiscordName: string;
  amountUsdt: number;
  toAddress: string;
  txHash: string | null;
  notes: string | null;
  paidAt: string;
  createdAt: string;
};

export function SalariesClient({
  employees,
  payouts,
}: {
  employees: Employee[];
  payouts: Payout[];
}) {
  return (
    <div className="space-y-4">
      <EmployeesCard employees={employees} />
      <PayoutsCard payouts={payouts} employees={employees} />
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
          Saved recipients with their default salary. Click the
          address to view a QR code, then scan it with your wallet
          (MetaMask, Trust, etc.) to send USDT (ERC-20) on Ethereum
          mainnet manually. Log the payment here afterwards so the
          monthly totals stay accurate.
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
                6 columns never blow up the layout on tablet widths. */}
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
                    <th className="px-3 py-2 text-left text-xs font-medium">
                      Last Paid
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

            {/* Mobile card list (<md) — the 6-col table overflows at
                360px, so each employee renders as a stacked card with
                ≥40px touch targets for the actions. */}
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
  const [logOpen, setLogOpen] = useState(false);
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
          <button
            type="button"
            onClick={() => setQrOpen(true)}
            className="inline-flex items-center gap-1.5 rounded-md px-1.5 py-0.5 text-xs font-mono text-blue-500 hover:bg-blue-500/10 hover:underline"
            title="Click to view QR code"
          >
            <QrCode className="size-3" />
            {employee.ethAddress.slice(0, 6)}…{employee.ethAddress.slice(-4)}
          </button>
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
        <td className="px-3 py-2 text-xs text-muted-foreground">
          {employee.lastPaidAt ? formatRelative(employee.lastPaidAt) : "never"}
        </td>
        <td className="px-3 py-2 text-right">
          <div className="flex items-center justify-end gap-1">
            <Button
              size="sm"
              variant="default"
              className="h-7 text-xs bg-emerald-500 hover:bg-emerald-500/90"
              disabled={!employee.active}
              onClick={() => setLogOpen(true)}
              title={
                employee.active
                  ? "Record a manual payment"
                  : "Employee is inactive"
              }
            >
              <Receipt className="size-3" />
              Log Payment
            </Button>
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
      <RecordPayoutDialog
        open={logOpen}
        onClose={() => setLogOpen(false)}
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
// laid out as a stacked card so the 6-column table doesn't overflow
// on phones. Action buttons keep ≥40px touch targets.
function EmployeeMobileCard({ employee }: { employee: Employee }) {
  const [qrOpen, setQrOpen] = useState(false);
  const [logOpen, setLogOpen] = useState(false);
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

      <button
        type="button"
        onClick={() => setQrOpen(true)}
        className="mt-2 inline-flex items-center gap-1.5 rounded-md px-1.5 py-1 text-xs font-mono text-blue-500 hover:bg-blue-500/10 hover:underline"
        title="Click to view QR code"
      >
        <QrCode className="size-3" />
        {employee.ethAddress.slice(0, 6)}…{employee.ethAddress.slice(-4)}
      </button>

      <div className="mt-1 text-[11px] text-muted-foreground">
        Last paid:{" "}
        {employee.lastPaidAt ? formatRelative(employee.lastPaidAt) : "never"}
      </div>

      <div className="mt-3 flex items-center gap-2">
        <Button
          size="sm"
          variant="default"
          className="h-9 flex-1 bg-emerald-500 text-xs hover:bg-emerald-500/90"
          disabled={!employee.active}
          onClick={() => setLogOpen(true)}
          title={
            employee.active ? "Record a manual payment" : "Employee is inactive"
          }
        >
          <Receipt className="size-3.5" />
          Log Payment
        </Button>
        <Button
          size="icon"
          variant="outline"
          className="size-9"
          onClick={() => setEditOpen(true)}
          aria-label="Edit"
        >
          <Pencil className="size-4" />
        </Button>
        <DeleteEmployeeButton employee={employee} className="size-9" />
      </div>

      <AddressQrDialog
        open={qrOpen}
        onClose={() => setQrOpen(false)}
        employee={employee}
      />
      <RecordPayoutDialog
        open={logOpen}
        onClose={() => setLogOpen(false)}
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

  useEffect(() => {
    if (!open) {
      setDataUrl(null);
      return;
    }
    let cancelled = false;
    // Generate the QR for the bare 0x address — universally
    // scannable by any Ethereum wallet.
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
            {employee.discordName} — USDT Address
          </DialogTitle>
          <DialogDescription>
            Scan with any Ethereum wallet to send USDT (ERC-20) on
            mainnet. Default monthly salary: $
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
              <Button
                size="icon"
                variant="ghost"
                className="size-7 shrink-0"
                render={
                  <a
                    href={`https://etherscan.io/address/${employee.ethAddress}`}
                    target="_blank"
                    rel="noreferrer"
                    aria-label="Open in Etherscan"
                  >
                    <ExternalLink className="size-3.5" />
                  </a>
                }
              />
            </div>
            <p className="text-[10px] text-muted-foreground">
              Network: Ethereum Mainnet (USDT contract
              0xdAC17F95…1ec7). Sending other tokens or wrong
              network = lost funds.
            </p>
          </div>
        </div>
      </DialogContent>
    </Dialog>
  );
}

// ── Record payout dialog (per-employee) ────────────────────────────

function RecordPayoutDialog({
  open,
  onClose,
  employee,
}: {
  open: boolean;
  onClose: () => void;
  employee: Employee;
}) {
  const router = useRouter();
  const [amount, setAmount] = useState(String(employee.salaryUsdt));
  const [txHash, setTxHash] = useState("");
  const [notes, setNotes] = useState("");
  const [pending, startTransition] = useTransition();

  // Reset on (re-)open so a stale form from a previous employee
  // doesn't leak across rows.
  useEffect(() => {
    if (open) {
      setAmount(String(employee.salaryUsdt));
      setTxHash("");
      setNotes("");
    }
  }, [open, employee.id, employee.salaryUsdt]);

  function handleSubmit() {
    const amt = parseFloat(amount);
    if (!Number.isFinite(amt) || amt <= 0) {
      toast.error("Enter a positive amount");
      return;
    }
    // Auto-extract hash if motha pastes a full URL.
    const m = txHash.match(/0x[a-fA-F0-9]{64}/);
    const cleanedHash = m ? m[0] : txHash.trim() || undefined;
    startTransition(async () => {
      const result = await recordSalaryPayout({
        employeeId: employee.id,
        amountUsdt: amt,
        txHash: cleanedHash,
        notes: notes.trim() || undefined,
      });
      if (!result.success) {
        toast.error(result.error);
        return;
      }
      toast.success(`Logged $${amt.toFixed(2)} payout to ${employee.discordName}`);
      onClose();
      router.refresh();
    });
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
            <Receipt className="size-4 text-emerald-500" />
            Log payment to {employee.discordName}
          </DialogTitle>
          <DialogDescription>
            Record a USDT salary payment you already sent from your
            own wallet. Pasting the etherscan tx link is optional but
            recommended — the audit log + dedup checks key off it.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">
              Amount (USDT)
            </Label>
            <Input
              type="number"
              step="0.01"
              min="0"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">
              Etherscan Tx Hash{" "}
              <span className="font-normal text-muted-foreground/60">
                (optional)
              </span>
            </Label>
            <Input
              value={txHash}
              onChange={(e) => setTxHash(e.target.value)}
              placeholder="0x… or full etherscan URL"
              className="font-mono text-xs"
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">
              Notes{" "}
              <span className="font-normal text-muted-foreground/60">
                (optional)
              </span>
            </Label>
            <Textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              placeholder="e.g. April 2026 — paid via Ledger"
              maxLength={500}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={pending}
            className="bg-emerald-500 hover:bg-emerald-500/90"
          >
            {pending ? "Logging…" : "Log Payment"}
          </Button>
        </DialogFooter>
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
              Ethereum Address
            </Label>
            <Input
              value={address}
              onChange={(e) => setAddress(e.target.value)}
              placeholder="0x…"
              className="font-mono text-xs"
            />
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

// ── Payouts log ─────────────────────────────────────────────────────

function PayoutsCard({
  payouts,
  employees,
}: {
  payouts: Payout[];
  employees: Employee[];
}) {
  const router = useRouter();
  const [adding, setAdding] = useState(false);

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-base">
            <Receipt className="size-4 text-emerald-500" />
            Payment Log
          </CardTitle>
          <div className="flex items-center gap-1">
            <Button
              size="sm"
              variant="ghost"
              onClick={() => router.refresh()}
              title="Refresh"
            >
              <RefreshCw className="size-3.5" />
            </Button>
            <Button
              size="sm"
              variant="outline"
              onClick={() => setAdding(true)}
              disabled={employees.length === 0}
            >
              <Plus className="size-4" />
              Log Payment
            </Button>
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          Manual record of payments sent off-system. Etherscan link
          is optional but recommended for auditability — the
          &quot;Paid This Month&quot; / &quot;Paid YTD&quot; KPIs
          above sum every row in here.
        </p>
      </CardHeader>
      <CardContent>
        {payouts.length === 0 ? (
          <div className="rounded-md border border-dashed">
            <EmptyState
              icon={Receipt}
              title="No payments logged yet"
              description="Logged payments roll up into the KPIs above."
              compact
            />
          </div>
        ) : (
          <>
            {/* Desktop table (>=md). */}
            <div className="hidden rounded-md border overflow-x-auto md:block">
              <table className="w-full">
                <thead>
                  <tr className="border-b bg-muted/50">
                    <th className="px-3 py-2 text-left text-xs font-medium">
                      Employee
                    </th>
                    <th className="px-3 py-2 text-right text-xs font-medium">
                      Amount
                    </th>
                    <th className="px-3 py-2 text-left text-xs font-medium">
                      Etherscan
                    </th>
                    <th className="px-3 py-2 text-left text-xs font-medium">
                      Notes
                    </th>
                    <th className="px-3 py-2 text-left text-xs font-medium">
                      When
                    </th>
                    <th className="px-3 py-2 text-right text-xs font-medium">
                      Actions
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {payouts.map((p) => (
                    <PayoutRow key={p.id} payout={p} />
                  ))}
                </tbody>
              </table>
            </div>

            {/* Mobile card list (<md). */}
            <div className="space-y-2 md:hidden">
              {payouts.map((p) => (
                <PayoutMobileCard key={p.id} payout={p} />
              ))}
            </div>
          </>
        )}
      </CardContent>
      <StandalonePayoutDialog
        open={adding}
        onClose={() => setAdding(false)}
        employees={employees.filter((e) => e.active)}
      />
    </Card>
  );
}

function PayoutRow({ payout }: { payout: Payout }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [confirmOpen, setConfirmOpen] = useState(false);

  function handleDelete() {
    startTransition(async () => {
      const result = await deleteSalaryPayout(payout.id);
      if (!result.success) {
        toast.error(result.error);
        return;
      }
      toast.success("Payment removed from log");
      setConfirmOpen(false);
      router.refresh();
    });
  }

  return (
    <tr className="border-b last:border-b-0">
      <td className="px-3 py-2 text-sm">{payout.employeeDiscordName}</td>
      <td className="px-3 py-2 text-right text-sm tabular-nums">
        ${payout.amountUsdt.toFixed(2)}
      </td>
      <td className="px-3 py-2">
        {payout.txHash ? (
          <a
            href={`https://etherscan.io/tx/${payout.txHash}`}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 text-xs text-blue-500 hover:underline font-mono"
          >
            {payout.txHash.slice(0, 10)}…
            <ExternalLink className="size-3" />
          </a>
        ) : (
          <span className="text-xs text-muted-foreground italic">
            no tx link
          </span>
        )}
      </td>
      <td className="px-3 py-2 text-xs text-muted-foreground max-w-xs truncate">
        {payout.notes ?? "—"}
      </td>
      <td className="px-3 py-2 text-xs text-muted-foreground">
        {formatRelative(payout.paidAt)}
      </td>
      <td className="px-3 py-2 text-right">
        <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
          <Button
            size="icon"
            variant="ghost"
            className="size-7 text-muted-foreground hover:text-rose-500"
            onClick={() => setConfirmOpen(true)}
            aria-label="Remove from log"
          >
            <Trash2 className="size-3.5" />
          </Button>
          <AlertDialogContent>
            <AlertDialogHeader>
              <AlertDialogTitle>Remove this entry?</AlertDialogTitle>
              <AlertDialogDescription>
                Drops the $
                {payout.amountUsdt.toFixed(2)} payment to{" "}
                <span className="font-medium">{payout.employeeDiscordName}</span>{" "}
                from the log. The on-chain transaction (if any)
                isn&apos;t affected — this is bookkeeping only. Use
                if you logged it twice or by mistake.
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
      </td>
    </tr>
  );
}

// Mobile equivalent of PayoutRow — stacked card with a full-width
// delete button (≥40px touch target). Amounts stay plain (these are
// operational salary payments, not user-ledger events).
function PayoutMobileCard({ payout }: { payout: Payout }) {
  const router = useRouter();
  const [pending, startTransition] = useTransition();
  const [confirmOpen, setConfirmOpen] = useState(false);

  function handleDelete() {
    startTransition(async () => {
      const result = await deleteSalaryPayout(payout.id);
      if (!result.success) {
        toast.error(result.error);
        return;
      }
      toast.success("Payment removed from log");
      setConfirmOpen(false);
      router.refresh();
    });
  }

  return (
    <div className="rounded-lg border bg-card p-3">
      <div className="flex items-start justify-between gap-2">
        <span className="min-w-0 truncate text-sm font-medium">
          {payout.employeeDiscordName}
        </span>
        <span className="text-sm font-semibold tabular-nums">
          ${payout.amountUsdt.toFixed(2)}
        </span>
      </div>
      <div className="mt-1 flex items-center justify-between gap-2 text-[11px] text-muted-foreground">
        <span>{formatRelative(payout.paidAt)}</span>
        {payout.txHash ? (
          <a
            href={`https://etherscan.io/tx/${payout.txHash}`}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 font-mono text-blue-500 hover:underline"
          >
            {payout.txHash.slice(0, 10)}…
            <ExternalLink className="size-3" />
          </a>
        ) : (
          <span className="italic">no tx link</span>
        )}
      </div>
      {payout.notes && (
        <p className="mt-1 text-xs text-muted-foreground">{payout.notes}</p>
      )}
      <AlertDialog open={confirmOpen} onOpenChange={setConfirmOpen}>
        <Button
          size="sm"
          variant="ghost"
          className="mt-2 h-9 w-full text-muted-foreground hover:text-rose-500"
          onClick={() => setConfirmOpen(true)}
          aria-label="Remove from log"
        >
          <Trash2 className="size-3.5" />
          Remove from log
        </Button>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove this entry?</AlertDialogTitle>
            <AlertDialogDescription>
              Drops the ${payout.amountUsdt.toFixed(2)} payment to{" "}
              <span className="font-medium">
                {payout.employeeDiscordName}
              </span>{" "}
              from the log. The on-chain transaction (if any) isn&apos;t
              affected — this is bookkeeping only. Use if you logged it twice
              or by mistake.
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
    </div>
  );
}

// Variant of RecordPayoutDialog opened from the payouts card itself
// (rather than a specific employee row). Shows a dropdown of active
// employees instead of pre-selecting one.
function StandalonePayoutDialog({
  open,
  onClose,
  employees,
}: {
  open: boolean;
  onClose: () => void;
  employees: Employee[];
}) {
  const router = useRouter();
  const [employeeId, setEmployeeId] = useState("");
  const [amount, setAmount] = useState("");
  const [txHash, setTxHash] = useState("");
  const [notes, setNotes] = useState("");
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    if (!open) return;
    setEmployeeId("");
    setAmount("");
    setTxHash("");
    setNotes("");
  }, [open]);

  function handleSubmit() {
    if (!employeeId) {
      toast.error("Pick an employee");
      return;
    }
    const amt = parseFloat(amount);
    if (!Number.isFinite(amt) || amt <= 0) {
      toast.error("Enter a positive amount");
      return;
    }
    const hashMatch = txHash.match(/0x[a-fA-F0-9]{64}/);
    const cleanedHash = hashMatch ? hashMatch[0] : txHash.trim() || undefined;
    startTransition(async () => {
      const result = await recordSalaryPayout({
        employeeId,
        amountUsdt: amt,
        txHash: cleanedHash,
        notes: notes.trim() || undefined,
      });
      if (!result.success) {
        toast.error(result.error);
        return;
      }
      const empName =
        employees.find((e) => e.id === employeeId)?.discordName ?? "employee";
      toast.success(`Logged $${amt.toFixed(2)} payout to ${empName}`);
      onClose();
      router.refresh();
    });
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
            <Receipt className="size-4 text-emerald-500" />
            Log a payment
          </DialogTitle>
          <DialogDescription>
            Record a payment you sent from your own wallet. Pick the
            recipient + amount + (optionally) the etherscan link.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">Employee</Label>
            <select
              value={employeeId}
              onChange={(e) => {
                const id = e.target.value;
                setEmployeeId(id);
                const emp = employees.find((x) => x.id === id);
                if (emp && !amount) setAmount(String(emp.salaryUsdt));
              }}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            >
              <option value="">Pick an employee…</option>
              {employees.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.discordName} — ${e.salaryUsdt.toFixed(2)}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">
              Amount (USDT)
            </Label>
            <Input
              type="number"
              step="0.01"
              min="0"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">
              Etherscan Tx Hash{" "}
              <span className="font-normal text-muted-foreground/60">
                (optional)
              </span>
            </Label>
            <Input
              value={txHash}
              onChange={(e) => setTxHash(e.target.value)}
              placeholder="0x… or full etherscan URL"
              className="font-mono text-xs"
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">
              Notes{" "}
              <span className="font-normal text-muted-foreground/60">
                (optional)
              </span>
            </Label>
            <Textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              maxLength={500}
            />
          </div>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button
            onClick={handleSubmit}
            disabled={pending}
            className="bg-emerald-500 hover:bg-emerald-500/90"
          >
            {pending ? "Logging…" : "Log Payment"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
