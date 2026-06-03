"use client";

import { useEffect, useState, useTransition } from "react";
import Image from "next/image";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  Copy,
  ExternalLink,
  Link2,
  Pencil,
  Plus,
  QrCode,
  Receipt,
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
import { formatDate } from "@/lib/utils/format";
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
import { Spinner } from "@/components/ux";
import {
  addSalaryEmployee,
  addSalaryPayment,
  deleteSalaryEmployee,
  deleteSalaryPayment,
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
  // Recurring pay day as a day of the month (1-31) or null if unset,
  // plus the server-computed proximity status used to color the badge.
  payDayOfMonth: number | null;
  payStatus: "due" | "ok" | null;
  notes: string | null;
};

// Day-of-month options for the pay-day dropdown (1-31).
const PAY_DAY_OPTIONS = Array.from({ length: 31 }, (_, i) => i + 1);

// 1 → "1st", 2 → "2nd", 3 → "3rd", 11 → "11th", 21 → "21st", 31 → "31st".
function ordinal(n: number): string {
  const s = ["th", "st", "nd", "rd"];
  const v = n % 100;
  return `${n}${s[(v - 20) % 10] || s[v] || s[0]}`;
}

// Pay-day badge. Red = "due" (today/tomorrow is the pay date, ~24h out),
// green = "ok" (not imminent). These are status colors the admin asked
// for, not House-POV money colors.
function PayDayBadge({
  payDayOfMonth,
  payStatus,
}: {
  payDayOfMonth: number | null;
  payStatus: "due" | "ok" | null;
}) {
  if (payDayOfMonth == null) {
    return <span className="text-xs text-muted-foreground">—</span>;
  }
  const due = payStatus === "due";
  return (
    <Badge
      variant="outline"
      className={cn(
        "text-[10px] font-medium",
        due
          ? "border-rose-500/30 bg-rose-500/15 text-rose-600 dark:text-rose-400"
          : "border-emerald-500/30 bg-emerald-500/15 text-emerald-600 dark:text-emerald-400",
      )}
      title={due ? "Pay day is within ~24h" : "Pay day not imminent"}
    >
      {ordinal(payDayOfMonth)}
    </Badge>
  );
}

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

type Payment = {
  id: string;
  employeeId: string;
  employeeDiscordName: string;
  paymentLink: string;
  paidAt: string;
};

export function SalariesClient({
  employees,
  payments,
}: {
  employees: Employee[];
  payments: Payment[];
}) {
  return (
    <div className="space-y-4">
      <EmployeesCard employees={employees} />
      <PaymentTrackingCard employees={employees} payments={payments} />
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
                    <th className="px-3 py-2 text-left text-xs font-medium">
                      Pay Day
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
        <td className="px-3 py-2">
          <PayDayBadge
            payDayOfMonth={employee.payDayOfMonth}
            payStatus={employee.payStatus}
          />
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
                (employee.cadence === "weekly" ? 4 : 2)
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
      : employee.salaryUsdt * (employee.cadence === "weekly" ? 4 : 2);
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
          {employee.payDayOfMonth != null && (
            <PayDayBadge
              payDayOfMonth={employee.payDayOfMonth}
              payStatus={employee.payStatus}
            />
          )}
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
                className="rounded-lg border bg-white p-2 motion-safe:animate-in motion-safe:fade-in motion-safe:duration-300"
                unoptimized
              />
            ) : (
              // Dimension-matched placeholder so the dialog body keeps a
              // stable height while the QR encodes (no jump on swap-in).
              <div className="flex size-[280px] items-center justify-center rounded-lg border bg-muted/50">
                <Spinner size={22} label="Generating QR code…" />
              </div>
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
  const [payDay, setPayDay] = useState<number | null>(
    employee?.payDayOfMonth ?? null,
  );
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
    setPayDay(employee?.payDayOfMonth ?? null);
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
            payDayOfMonth: payDay,
            notes: notes.trim() || null,
          })
        : await addSalaryEmployee({
            discordName: discordName.trim(),
            ethAddress: address.trim(),
            cadence,
            salaryUsdt: sal,
            active,
            payDayOfMonth: payDay,
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
            <Label className="text-xs text-muted-foreground">Pay Day</Label>
            <select
              value={payDay === null ? "" : String(payDay)}
              onChange={(e) =>
                setPayDay(
                  e.target.value === "" ? null : Number(e.target.value),
                )
              }
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            >
              <option value="">No pay day</option>
              {PAY_DAY_OPTIONS.map((d) => (
                <option key={d} value={d}>
                  {ordinal(d)}
                </option>
              ))}
            </select>
            <p className="text-[10px] text-muted-foreground">
              Day of the month. Shown on the list and flagged red ~24h
              before. Days past a short month&apos;s end fall on its last
              day.
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
            {/* For weekly/biweekly cadences show the monthly equivalent
                so it's obvious what the actual monthly cost is. Same
                fixed multiples used in page.tsx for the Monthly Budget
                KPI — dead-simple, NO calendar math: weekly ×4,
                biweekly ×2. */}
            {(() => {
              const sal = parseFloat(salary);
              if (!Number.isFinite(sal) || sal <= 0) return null;
              if (cadence === "monthly") return null;
              const factor = cadence === "weekly" ? 4 : 2;
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
            {pending && <Spinner size={14} className="text-current" />}
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
            {pending && <Spinner size={14} className="text-current" />}
            {pending ? "Removing…" : "Remove"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

// ── Payment tracking ────────────────────────────────────────────────

function PaymentTrackingCard({
  employees,
  payments,
}: {
  employees: Employee[];
  payments: Payment[];
}) {
  const [adding, setAdding] = useState(false);
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2 text-base">
            <Receipt className="size-4 text-emerald-500" />
            Payment Tracking
          </CardTitle>
          <Button
            size="sm"
            onClick={() => setAdding(true)}
            disabled={employees.length === 0}
          >
            <Plus className="size-4" />
            Track payment
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          Log a payment you sent: pick the employee, paste the payment
          link, and save it with a date.
        </p>
      </CardHeader>
      <CardContent>
        {payments.length === 0 ? (
          <div className="rounded-md border border-dashed">
            <EmptyState
              icon={Receipt}
              title="No payments tracked yet"
              description="Use the Track payment button to save one."
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
                    <th className="px-3 py-2 text-left text-xs font-medium">
                      Payment Link
                    </th>
                    <th className="px-3 py-2 text-left text-xs font-medium">
                      Date
                    </th>
                    <th className="px-3 py-2 text-right text-xs font-medium">
                      Actions
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {payments.map((p) => (
                    <PaymentRow key={p.id} payment={p} />
                  ))}
                </tbody>
              </table>
            </div>

            {/* Mobile cards (<md). */}
            <div className="space-y-2 md:hidden">
              {payments.map((p) => (
                <PaymentMobileCard key={p.id} payment={p} />
              ))}
            </div>
          </>
        )}
      </CardContent>
      <TrackPaymentDialog
        open={adding}
        onClose={() => setAdding(false)}
        employees={employees}
      />
    </Card>
  );
}

function PaymentLink({ href }: { href: string }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      className="inline-flex max-w-full items-center gap-1 text-xs text-blue-500 hover:underline"
      title={href}
    >
      <Link2 className="size-3 shrink-0" />
      <span className="truncate">{href}</span>
      <ExternalLink className="size-3 shrink-0" />
    </a>
  );
}

function PaymentRow({ payment }: { payment: Payment }) {
  return (
    <tr className="border-b last:border-b-0">
      <td className="px-3 py-2 text-sm font-medium">
        <span className="font-mono">{payment.employeeDiscordName}</span>
      </td>
      <td className="max-w-[280px] px-3 py-2">
        <PaymentLink href={payment.paymentLink} />
      </td>
      <td className="px-3 py-2 text-xs text-muted-foreground">
        {formatDate(payment.paidAt)}
      </td>
      <td className="px-3 py-2 text-right">
        <DeletePaymentButton paymentId={payment.id} />
      </td>
    </tr>
  );
}

function PaymentMobileCard({ payment }: { payment: Payment }) {
  return (
    <div className="rounded-lg border bg-card p-3">
      <div className="flex items-start justify-between gap-2">
        <span className="font-mono text-sm font-medium">
          {payment.employeeDiscordName}
        </span>
        <span className="shrink-0 text-[11px] text-muted-foreground">
          {formatDate(payment.paidAt)}
        </span>
      </div>
      <div className="mt-2 min-w-0">
        <PaymentLink href={payment.paymentLink} />
      </div>
      <DeletePaymentButton
        paymentId={payment.id}
        className="mt-2 h-9 w-full"
        withLabel
      />
    </div>
  );
}

function DeletePaymentButton({
  paymentId,
  className,
  withLabel,
}: {
  paymentId: string;
  className?: string;
  withLabel?: boolean;
}) {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [pending, startTransition] = useTransition();

  function handleDelete() {
    startTransition(async () => {
      const result = await deleteSalaryPayment(paymentId);
      if (!result.success) {
        toast.error(result.error);
        return;
      }
      toast.success("Payment removed");
      setOpen(false);
      router.refresh();
    });
  }

  return (
    <AlertDialog open={open} onOpenChange={setOpen}>
      <Button
        size={withLabel ? "sm" : "icon"}
        variant="ghost"
        className={cn(
          "text-muted-foreground hover:text-rose-500",
          !withLabel && "size-7",
          className,
        )}
        onClick={() => setOpen(true)}
        aria-label="Remove payment"
      >
        <Trash2 className="size-3.5" />
        {withLabel ? "Remove" : null}
      </Button>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Remove this payment?</AlertDialogTitle>
          <AlertDialogDescription>
            Deletes the tracked payment record. Bookkeeping only — it does
            not affect anything off-system.
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogCancel disabled={pending}>Cancel</AlertDialogCancel>
          <AlertDialogAction
            onClick={handleDelete}
            disabled={pending}
            className="bg-rose-500 hover:bg-rose-500/90"
          >
            {pending && <Spinner size={14} className="text-current" />}
            {pending ? "Removing…" : "Remove"}
          </AlertDialogAction>
        </AlertDialogFooter>
      </AlertDialogContent>
    </AlertDialog>
  );
}

function TrackPaymentDialog({
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
  const [link, setLink] = useState("");
  // Init empty; set to today in the effect on open so there's no
  // server/client date mismatch during render.
  const [date, setDate] = useState("");
  const [pending, startTransition] = useTransition();

  useEffect(() => {
    if (!open) return;
    setEmployeeId("");
    setLink("");
    setDate(new Date().toISOString().slice(0, 10));
  }, [open]);

  function handleSubmit() {
    if (!employeeId) {
      toast.error("Pick an employee");
      return;
    }
    if (!link.trim()) {
      toast.error("Enter a payment link");
      return;
    }
    startTransition(async () => {
      const result = await addSalaryPayment({
        employeeId,
        paymentLink: link.trim(),
        paidAt: date || undefined,
      });
      if (!result.success) {
        toast.error(result.error);
        return;
      }
      const name =
        employees.find((e) => e.id === employeeId)?.discordName ?? "employee";
      toast.success(`Tracked payment to ${name}`);
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
            Track a payment
          </DialogTitle>
          <DialogDescription>
            Save a payment link against an employee, with a date.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3 py-2">
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">Employee</Label>
            <select
              value={employeeId}
              onChange={(e) => setEmployeeId(e.target.value)}
              className="w-full rounded-md border border-input bg-background px-3 py-2 text-sm"
            >
              <option value="">Pick an employee…</option>
              {employees.map((e) => (
                <option key={e.id} value={e.id}>
                  {e.discordName}
                  {e.active ? "" : " (inactive)"}
                </option>
              ))}
            </select>
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">
              Payment Link
            </Label>
            <Input
              value={link}
              onChange={(e) => setLink(e.target.value)}
              placeholder="https://…"
              className="font-mono text-xs"
            />
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">Date</Label>
            <Input
              type="date"
              value={date}
              onChange={(e) => setDate(e.target.value)}
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
            {pending && <Spinner size={14} className="text-current" />}
            {pending ? "Saving…" : "Save payment"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
