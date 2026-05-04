"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  Copy,
  Eye,
  EyeOff,
  KeyRound,
  Pencil,
  Plus,
  RefreshCw,
  Send,
  Trash2,
  Wallet as WalletIcon,
  ExternalLink,
  AlertTriangle,
} from "lucide-react";
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
import {
  addSalaryEmployee,
  deleteSalaryEmployee,
  paySalary,
  refreshSalaryPayoutStatus,
  setSalaryWalletKey,
  updateSalaryEmployee,
} from "./actions";

type WalletState =
  | { hasKey: false }
  | {
      hasKey: true;
      address: string;
      privateKey: string;
      rpcUrl: string | null;
      usdtBalance: string;
      ethBalance: string;
      snapshotError: string | null;
      updatedAt: string;
    };

type Employee = {
  id: string;
  name: string;
  ethAddress: string;
  salaryUsdt: number;
  maxPerPayout: number | null;
  active: boolean;
  lastPaidAt: string | null;
  notes: string | null;
};

type Payout = {
  id: string;
  employeeName: string;
  amountUsdt: number;
  toAddress: string;
  txHash: string | null;
  status: "pending" | "broadcast" | "confirmed" | "failed";
  errorMessage: string | null;
  broadcastAt: string | null;
  confirmedAt: string | null;
  createdAt: string;
};

export function SalariesClient({
  wallet,
  employees,
  payouts,
}: {
  wallet: WalletState;
  employees: Employee[];
  payouts: Payout[];
}) {
  return (
    <div className="grid gap-4 lg:grid-cols-[400px_1fr]">
      <WalletCard wallet={wallet} />
      <div className="space-y-4">
        <EmployeesCard employees={employees} hasKey={wallet.hasKey} />
        <PayoutsCard payouts={payouts} />
      </div>
    </div>
  );
}

// ── Wallet card ─────────────────────────────────────────────────────

function WalletCard({ wallet }: { wallet: WalletState }) {
  const [editing, setEditing] = useState(!wallet.hasKey);
  const [keyVisible, setKeyVisible] = useState(false);
  const [pkInput, setPkInput] = useState("");
  const [rpcInput, setRpcInput] = useState(
    wallet.hasKey ? wallet.rpcUrl ?? "" : "",
  );
  const [totp, setTotp] = useState("");
  const [pending, startTransition] = useTransition();
  const router = useRouter();

  function handleSubmit() {
    if (!pkInput.trim()) {
      toast.error("Enter a private key");
      return;
    }
    if (!totp.trim()) {
      toast.error("Enter your 2FA code");
      return;
    }
    startTransition(async () => {
      const result = await setSalaryWalletKey({
        privateKey: pkInput.trim(),
        rpcUrl: rpcInput.trim() || null,
        totpCode: totp.trim(),
      });
      if (!result.success) {
        toast.error(result.error);
        return;
      }
      toast.success(`Wallet set: ${result.address}`);
      setPkInput("");
      setTotp("");
      setEditing(false);
      router.refresh();
    });
  }

  function copy(text: string, label: string) {
    navigator.clipboard
      .writeText(text)
      .then(() => toast.success(`${label} copied`))
      .catch(() => toast.error("Copy failed"));
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2 text-base">
          <WalletIcon className="size-4 text-emerald-500" />
          Payout Wallet
        </CardTitle>
        <p className="text-xs text-muted-foreground">
          Single ETH mainnet wallet that holds USDT (ERC-20) for sending
          to employees. Top up with USDT + a small amount of ETH for gas.
        </p>
      </CardHeader>
      <CardContent className="space-y-3">
        {wallet.hasKey && !editing && (
          <>
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">Address</Label>
              <div className="flex items-center gap-1">
                <code className="flex-1 rounded-md bg-muted px-2 py-1.5 text-xs font-mono break-all">
                  {wallet.address}
                </code>
                <Button
                  size="icon"
                  variant="ghost"
                  className="size-7 shrink-0"
                  onClick={() => copy(wallet.address, "Address")}
                >
                  <Copy className="size-3.5" />
                </Button>
                <Button
                  size="icon"
                  variant="ghost"
                  className="size-7 shrink-0"
                  render={
                    <a
                      href={`https://etherscan.io/address/${wallet.address}`}
                      target="_blank"
                      rel="noreferrer"
                      aria-label="Open in Etherscan"
                    >
                      <ExternalLink className="size-3.5" />
                    </a>
                  }
                />
              </div>
            </div>

            <div className="grid grid-cols-2 gap-2 rounded-md border bg-muted/40 p-2">
              <div>
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
                  USDT
                </p>
                <p className="text-sm font-semibold tabular-nums text-emerald-600 dark:text-emerald-400">
                  {wallet.usdtBalance}
                </p>
              </div>
              <div>
                <p className="text-[10px] uppercase tracking-wider text-muted-foreground">
                  ETH (gas)
                </p>
                <p className="text-sm font-semibold tabular-nums">
                  {wallet.ethBalance}
                </p>
              </div>
            </div>

            {wallet.snapshotError && (
              <div className="flex items-start gap-2 rounded-md border border-amber-500/30 bg-amber-500/10 p-2 text-[11px] text-amber-700 dark:text-amber-300">
                <AlertTriangle className="size-3.5 shrink-0 mt-0.5" />
                <span>
                  RPC error reading balances. Address shown is from the
                  stored key. {wallet.snapshotError}
                </span>
              </div>
            )}

            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">
                Private Key
              </Label>
              <div className="flex items-center gap-1">
                <code className="flex-1 rounded-md bg-muted px-2 py-1.5 text-xs font-mono break-all">
                  {keyVisible
                    ? wallet.privateKey
                    : "•".repeat(Math.min(64, wallet.privateKey.length))}
                </code>
                <Button
                  size="icon"
                  variant="ghost"
                  className="size-7 shrink-0"
                  onClick={() => setKeyVisible((v) => !v)}
                  aria-label={keyVisible ? "Hide" : "Show"}
                >
                  {keyVisible ? (
                    <EyeOff className="size-3.5" />
                  ) : (
                    <Eye className="size-3.5" />
                  )}
                </Button>
                {keyVisible && (
                  <Button
                    size="icon"
                    variant="ghost"
                    className="size-7 shrink-0"
                    onClick={() => copy(wallet.privateKey, "Private key")}
                  >
                    <Copy className="size-3.5" />
                  </Button>
                )}
              </div>
              <p className="text-[10px] text-muted-foreground">
                Anyone with this key can drain the wallet. Don&apos;t share.
              </p>
            </div>

            {wallet.rpcUrl && (
              <div className="space-y-1">
                <Label className="text-xs text-muted-foreground">RPC URL</Label>
                <code className="block rounded-md bg-muted px-2 py-1.5 text-[11px] font-mono break-all">
                  {wallet.rpcUrl}
                </code>
              </div>
            )}

            <p className="text-[10px] text-muted-foreground">
              Updated {formatRelative(wallet.updatedAt)}
            </p>
            <Button
              variant="outline"
              size="sm"
              className="w-full"
              onClick={() => {
                setPkInput(wallet.privateKey);
                setRpcInput(wallet.rpcUrl ?? "");
                setEditing(true);
              }}
            >
              <KeyRound className="size-4" />
              Change Key / RPC
            </Button>
          </>
        )}

        {(editing || !wallet.hasKey) && (
          <>
            {!wallet.hasKey && (
              <p className="text-xs text-amber-600 dark:text-amber-400">
                No payout wallet set. Paste a private key below to enable
                sending.
              </p>
            )}
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">
                Private Key (0x…)
              </Label>
              <Textarea
                value={pkInput}
                onChange={(e) => setPkInput(e.target.value)}
                placeholder="0x..."
                rows={3}
                className="font-mono text-xs"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">
                RPC URL (optional)
              </Label>
              <Input
                value={rpcInput}
                onChange={(e) => setRpcInput(e.target.value)}
                placeholder="https://eth-mainnet.g.alchemy.com/v2/…"
                className="font-mono text-xs"
              />
              <p className="text-[10px] text-muted-foreground">
                Leave blank to use the env-var default (or public fallback).
                A private RPC is strongly recommended for sending.
              </p>
            </div>
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">
                2FA Code
              </Label>
              <Input
                type="text"
                inputMode="numeric"
                placeholder="6-digit code"
                value={totp}
                onChange={(e) => setTotp(e.target.value)}
                maxLength={6}
                autoComplete="one-time-code"
              />
            </div>
            <div className="flex gap-2">
              {wallet.hasKey && (
                <Button
                  variant="ghost"
                  size="sm"
                  className="flex-1"
                  onClick={() => {
                    setEditing(false);
                    setPkInput("");
                    setTotp("");
                    setRpcInput(wallet.rpcUrl ?? "");
                  }}
                  disabled={pending}
                >
                  Cancel
                </Button>
              )}
              <Button
                size="sm"
                className="flex-1"
                onClick={handleSubmit}
                disabled={pending}
              >
                {pending ? "Saving…" : "Save Key"}
              </Button>
            </div>
          </>
        )}
      </CardContent>
    </Card>
  );
}

// ── Employees card ──────────────────────────────────────────────────

function EmployeesCard({
  employees,
  hasKey,
}: {
  employees: Employee[];
  hasKey: boolean;
}) {
  const [adding, setAdding] = useState(false);
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle className="text-base">Employees</CardTitle>
          <Button size="sm" onClick={() => setAdding(true)}>
            <Plus className="size-4" />
            Add Employee
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          Saved recipients with default salary + an optional per-payout
          cap (typo defense).
        </p>
      </CardHeader>
      <CardContent>
        {employees.length === 0 ? (
          <div className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
            No employees yet. Add one to start sending salaries.
          </div>
        ) : (
          <div className="rounded-md border overflow-hidden">
            <table className="w-full">
              <thead>
                <tr className="border-b bg-muted/50">
                  <th className="px-3 py-2 text-left text-xs font-medium">
                    Name
                  </th>
                  <th className="px-3 py-2 text-left text-xs font-medium">
                    Address
                  </th>
                  <th className="px-3 py-2 text-right text-xs font-medium">
                    Salary
                  </th>
                  <th className="px-3 py-2 text-right text-xs font-medium">
                    Cap
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
                  <EmployeeRow key={e.id} employee={e} hasKey={hasKey} />
                ))}
              </tbody>
            </table>
          </div>
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

function EmployeeRow({
  employee,
  hasKey,
}: {
  employee: Employee;
  hasKey: boolean;
}) {
  const [payOpen, setPayOpen] = useState(false);
  const [editOpen, setEditOpen] = useState(false);
  return (
    <>
      <tr
        className={`border-b last:border-b-0 ${
          employee.active ? "" : "opacity-60"
        }`}
      >
        <td className="px-3 py-2 text-sm font-medium">
          {employee.name}
          {!employee.active && (
            <Badge variant="outline" className="ml-1.5 text-[10px]">
              inactive
            </Badge>
          )}
        </td>
        <td className="px-3 py-2 text-xs font-mono">
          {employee.ethAddress.slice(0, 6)}…{employee.ethAddress.slice(-4)}
        </td>
        <td className="px-3 py-2 text-right text-sm tabular-nums">
          ${employee.salaryUsdt.toFixed(2)}
        </td>
        <td className="px-3 py-2 text-right text-xs text-muted-foreground tabular-nums">
          {employee.maxPerPayout
            ? `$${employee.maxPerPayout.toFixed(2)}`
            : "—"}
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
              disabled={!hasKey || !employee.active}
              onClick={() => setPayOpen(true)}
              title={
                !hasKey
                  ? "Set the wallet key first"
                  : !employee.active
                    ? "Employee is inactive"
                    : "Pay this employee now"
              }
            >
              <Send className="size-3" />
              Pay
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
      <PayDialog
        open={payOpen}
        onClose={() => setPayOpen(false)}
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

// ── Pay dialog ──────────────────────────────────────────────────────

function PayDialog({
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
  const [totp, setTotp] = useState("");
  const [pending, startTransition] = useTransition();

  function handleSubmit() {
    const n = parseFloat(amount);
    if (!Number.isFinite(n) || n <= 0) {
      toast.error("Enter a positive amount");
      return;
    }
    if (employee.maxPerPayout && n > employee.maxPerPayout) {
      toast.error(
        `Amount $${n.toFixed(2)} exceeds the per-payout cap ($${employee.maxPerPayout.toFixed(2)})`,
      );
      return;
    }
    if (!totp.trim()) {
      toast.error("Enter your 2FA code");
      return;
    }
    startTransition(async () => {
      const result = await paySalary({
        employeeId: employee.id,
        amountUsdt: n,
        totpCode: totp.trim(),
      });
      if (!result.success) {
        toast.error(result.error);
        return;
      }
      toast.success(
        `Sent $${n.toFixed(2)} USDT to ${employee.name}. Tx: ${result.txHash.slice(0, 10)}…`,
      );
      // Best-effort confirmation polling — not blocking the dialog.
      pollPayoutConfirmation(result.payoutId).catch(() => {});
      setTotp("");
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
            <Send className="size-4 text-emerald-500" />
            Pay {employee.name}
          </DialogTitle>
          <DialogDescription>
            Sends USDT (ERC-20) on Ethereum mainnet to{" "}
            <code className="font-mono">{employee.ethAddress}</code>. This is
            irreversible. Double-check the amount.
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-3">
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
            {employee.maxPerPayout && (
              <p className="text-[10px] text-muted-foreground">
                Per-payout cap: ${employee.maxPerPayout.toFixed(2)}
              </p>
            )}
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">2FA Code</Label>
            <Input
              type="text"
              inputMode="numeric"
              placeholder="6-digit code"
              value={totp}
              onChange={(e) => setTotp(e.target.value)}
              maxLength={6}
              autoComplete="one-time-code"
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
            {pending ? "Sending…" : `Send $${amount}`}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

async function pollPayoutConfirmation(payoutId: string) {
  // Simple linear poll — every 8s for ~3 min. Refresh server state
  // on every tick so the page picks up the new status row.
  for (let i = 0; i < 24; i++) {
    await new Promise((r) => setTimeout(r, 8000));
    try {
      const res = await refreshSalaryPayoutStatus(payoutId);
      if (res.status === "confirmed" || res.status === "failed") {
        if (typeof window !== "undefined") window.location.reload();
        return;
      }
    } catch {
      // ignore — keep polling
    }
  }
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
  const [name, setName] = useState(employee?.name ?? "");
  const [address, setAddress] = useState(employee?.ethAddress ?? "");
  const [salary, setSalary] = useState(
    employee ? String(employee.salaryUsdt) : "",
  );
  const [maxCap, setMaxCap] = useState(
    employee?.maxPerPayout ? String(employee.maxPerPayout) : "",
  );
  const [active, setActive] = useState(employee?.active ?? true);
  const [notes, setNotes] = useState(employee?.notes ?? "");
  const [pending, startTransition] = useTransition();
  const isEdit = Boolean(employee);

  function reset() {
    setName(employee?.name ?? "");
    setAddress(employee?.ethAddress ?? "");
    setSalary(employee ? String(employee.salaryUsdt) : "");
    setMaxCap(employee?.maxPerPayout ? String(employee.maxPerPayout) : "");
    setActive(employee?.active ?? true);
    setNotes(employee?.notes ?? "");
  }

  function handleSubmit() {
    if (!name.trim()) {
      toast.error("Name is required");
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
    const cap = maxCap.trim() ? parseFloat(maxCap) : null;
    if (cap != null && (!Number.isFinite(cap) || cap <= 0)) {
      toast.error("Cap must be > 0 or empty");
      return;
    }
    startTransition(async () => {
      const result = isEdit
        ? await updateSalaryEmployee({
            id: employee!.id,
            name: name.trim(),
            ethAddress: address.trim(),
            salaryUsdt: sal,
            maxPerPayout: cap,
            active,
            notes: notes.trim() || null,
          })
        : await addSalaryEmployee({
            name: name.trim(),
            ethAddress: address.trim(),
            salaryUsdt: sal,
            maxPerPayout: cap,
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
            <Label className="text-xs text-muted-foreground">Name</Label>
            <Input
              value={name}
              onChange={(e) => setName(e.target.value)}
              placeholder="Alice"
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
          <div className="grid grid-cols-2 gap-2">
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">
                Salary (USDT)
              </Label>
              <Input
                type="number"
                step="0.01"
                min="0"
                value={salary}
                onChange={(e) => setSalary(e.target.value)}
                placeholder="500"
              />
            </div>
            <div className="space-y-1">
              <Label className="text-xs text-muted-foreground">
                Per-payout cap
              </Label>
              <Input
                type="number"
                step="0.01"
                min="0"
                value={maxCap}
                onChange={(e) => setMaxCap(e.target.value)}
                placeholder="optional"
              />
            </div>
          </div>
          <div className="space-y-1">
            <Label className="text-xs text-muted-foreground">Notes</Label>
            <Textarea
              value={notes}
              onChange={(e) => setNotes(e.target.value)}
              rows={2}
              placeholder="Role, payment cadence, etc."
              maxLength={500}
            />
          </div>
          <label className="flex items-center gap-2 text-xs">
            <input
              type="checkbox"
              checked={active}
              onChange={(e) => setActive(e.target.checked)}
            />
            <span>Active (eligible to be paid)</span>
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

function DeleteEmployeeButton({ employee }: { employee: Employee }) {
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
        className="size-7 text-muted-foreground hover:text-rose-500"
        onClick={() => setOpen(true)}
        aria-label="Remove"
      >
        <Trash2 className="size-3.5" />
      </Button>
      <AlertDialogContent>
        <AlertDialogHeader>
          <AlertDialogTitle>Remove {employee.name}?</AlertDialogTitle>
          <AlertDialogDescription>
            Removes the saved salary record for{" "}
            <span className="font-medium">{employee.name}</span>. If they
            have any payouts on file, this will be blocked — deactivate
            instead.
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

// ── Recent payouts ──────────────────────────────────────────────────

function PayoutsCard({ payouts }: { payouts: Payout[] }) {
  const router = useRouter();
  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between">
          <CardTitle className="text-base">Recent Payouts</CardTitle>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => router.refresh()}
            title="Refresh"
          >
            <RefreshCw className="size-3.5" />
          </Button>
        </div>
      </CardHeader>
      <CardContent>
        {payouts.length === 0 ? (
          <div className="rounded-md border border-dashed p-6 text-center text-sm text-muted-foreground">
            No payouts yet.
          </div>
        ) : (
          <div className="rounded-md border overflow-hidden">
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
                    Status
                  </th>
                  <th className="px-3 py-2 text-left text-xs font-medium">
                    Tx
                  </th>
                  <th className="px-3 py-2 text-left text-xs font-medium">
                    When
                  </th>
                </tr>
              </thead>
              <tbody>
                {payouts.map((p) => (
                  <tr key={p.id} className="border-b last:border-b-0">
                    <td className="px-3 py-2 text-sm">{p.employeeName}</td>
                    <td className="px-3 py-2 text-right text-sm tabular-nums">
                      ${p.amountUsdt.toFixed(2)}
                    </td>
                    <td className="px-3 py-2">
                      <PayoutStatusBadge status={p.status} />
                      {p.errorMessage && (
                        <p className="mt-0.5 text-[10px] text-rose-500 line-clamp-1">
                          {p.errorMessage}
                        </p>
                      )}
                    </td>
                    <td className="px-3 py-2">
                      {p.txHash ? (
                        <a
                          href={`https://etherscan.io/tx/${p.txHash}`}
                          target="_blank"
                          rel="noreferrer"
                          className="inline-flex items-center gap-1 text-xs text-blue-500 hover:underline font-mono"
                        >
                          {p.txHash.slice(0, 8)}…
                          <ExternalLink className="size-3" />
                        </a>
                      ) : (
                        <span className="text-xs text-muted-foreground">—</span>
                      )}
                    </td>
                    <td className="px-3 py-2 text-xs text-muted-foreground">
                      {formatRelative(p.createdAt)}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </CardContent>
    </Card>
  );
}

function PayoutStatusBadge({ status }: { status: Payout["status"] }) {
  const map: Record<
    Payout["status"],
    { label: string; cls: string }
  > = {
    pending: {
      label: "Pending",
      cls: "bg-yellow-500/15 text-yellow-600 dark:text-yellow-400 border-yellow-500/30",
    },
    broadcast: {
      label: "Broadcast",
      cls: "bg-blue-500/15 text-blue-600 dark:text-blue-400 border-blue-500/30",
    },
    confirmed: {
      label: "Confirmed",
      cls: "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30",
    },
    failed: {
      label: "Failed",
      cls: "bg-rose-500/15 text-rose-600 dark:text-rose-400 border-rose-500/30",
    },
  };
  const m = map[status];
  return (
    <Badge variant="outline" className={`text-[10px] ${m.cls}`}>
      {m.label}
    </Badge>
  );
}
