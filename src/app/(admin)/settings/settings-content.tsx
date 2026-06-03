"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Switch } from "@/components/ui/switch";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { toggleCountryRestriction, updateCountryRestrictionArray, upsertVaultLockTime, deleteVaultLockTime } from "./actions";
import { Pencil, Trash2, X, Check, ChevronDown, Globe, Timer, Plus } from "lucide-react";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover";
import { SectionHeading } from "@/components/modern-panels";
import { EmptyState } from "@/components/empty-state";
import { Spinner, transition } from "@/components/ux";
import { cn } from "@/lib/utils";

type SettingsData = {
  vaultLockTimes: {
    id: string;
    hours: number;
    label: string;
  }[];
  countryRestrictions: {
    countryCode: string;
    physicalWithdrawal: boolean;
    digitalWithdrawal: boolean;
    giftCardDeposit: boolean;
    promoCodeDeposit: boolean;
    blocked: boolean;
    lockedDepositsCrypto: string[];
    lockedDepositsFiat: string[];
    lockedWithdrawalsCrypto: string[];
  }[];
};

export function SettingsContent({ data }: { data: SettingsData }) {
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  function handleCountryToggle(countryCode: string, field: string, currentValue: boolean) {
    startTransition(async () => {
      try {
        await toggleCountryRestriction(countryCode, field, !currentValue);
        toast.success("Restriction updated");
        router.refresh();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Failed");
      }
    });
  }

  return (
    <div className="space-y-6">
      {/* Vault Lock Times */}
      <VaultLockTimesCard
        vaultLockTimes={data.vaultLockTimes}
        isPending={isPending}
        startTransition={startTransition}
        router={router}
      />

      {/* Country Restrictions */}
      <div className="space-y-3">
        <SectionHeading icon={Globe} title="Country Restrictions" />

        {data.countryRestrictions.length === 0 ? (
          <div className="rounded-xl border">
            <EmptyState
              icon={Globe}
              title="No country restrictions configured"
              description="Every country is unrestricted until a row is added."
              compact
            />
          </div>
        ) : (
          <>
            {/* Desktop table (>=md). The 9-column grid overflows badly on
                phones, so it stays behind a horizontal-scroll guard here and
                is replaced by a stacked card list below md. */}
            <div className="hidden rounded-xl border overflow-x-auto md:block">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>Country</TableHead>
                    <TableHead>Physical</TableHead>
                    <TableHead>Digital</TableHead>
                    <TableHead>Gift Card</TableHead>
                    <TableHead>Promo Code</TableHead>
                    <TableHead>Blocked</TableHead>
                    <TableHead>Locked Deposits Crypto</TableHead>
                    <TableHead>Locked Deposits Fiat</TableHead>
                    <TableHead>Locked Withdrawals Crypto</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {data.countryRestrictions.map((c) => (
                    <TableRow key={c.countryCode}>
                      <TableCell className="font-medium">{c.countryCode}</TableCell>
                      <TableCell>
                        <Switch
                          checked={c.physicalWithdrawal}
                          onCheckedChange={() => handleCountryToggle(c.countryCode, "physical_withdrawal", c.physicalWithdrawal)}
                          disabled={isPending}
                        />
                      </TableCell>
                      <TableCell>
                        <Switch
                          checked={c.digitalWithdrawal}
                          onCheckedChange={() => handleCountryToggle(c.countryCode, "digital_withdrawal", c.digitalWithdrawal)}
                          disabled={isPending}
                        />
                      </TableCell>
                      <TableCell>
                        <Switch
                          checked={c.giftCardDeposit}
                          onCheckedChange={() => handleCountryToggle(c.countryCode, "gift_card_deposit", c.giftCardDeposit)}
                          disabled={isPending}
                        />
                      </TableCell>
                      <TableCell>
                        <Switch
                          checked={c.promoCodeDeposit}
                          onCheckedChange={() => handleCountryToggle(c.countryCode, "promo_code_deposit", c.promoCodeDeposit)}
                          disabled={isPending}
                        />
                      </TableCell>
                      <TableCell>
                        <Switch
                          checked={c.blocked}
                          onCheckedChange={() => handleCountryToggle(c.countryCode, "blocked", c.blocked)}
                          disabled={isPending}
                        />
                      </TableCell>
                      <TableCell>
                        <CurrencyMultiSelect
                          countryCode={c.countryCode}
                          field="locked_deposits_crypto"
                          values={c.lockedDepositsCrypto}
                          options={CRYPTO_OPTIONS}
                          disabled={isPending}
                          startTransition={startTransition}
                          router={router}
                        />
                      </TableCell>
                      <TableCell>
                        <CurrencyMultiSelect
                          countryCode={c.countryCode}
                          field="locked_deposits_fiat"
                          values={c.lockedDepositsFiat}
                          options={FIAT_OPTIONS}
                          disabled={isPending}
                          startTransition={startTransition}
                          router={router}
                        />
                      </TableCell>
                      <TableCell>
                        <CurrencyMultiSelect
                          countryCode={c.countryCode}
                          field="locked_withdrawals_crypto"
                          values={c.lockedWithdrawalsCrypto}
                          options={CRYPTO_OPTIONS}
                          disabled={isPending}
                          startTransition={startTransition}
                          router={router}
                        />
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>

            {/* Mobile card list (<md) — the 9-col table is unusable at 360px,
                so each country renders as a stacked card mirroring the
                admin-users mobile fallback: header + grouped toggle rows +
                the three currency multi-selects. */}
            <div className="space-y-2 md:hidden">
              {data.countryRestrictions.map((c) => (
                <div
                  key={c.countryCode}
                  className="rounded-xl border bg-card p-3"
                >
                  <div className="flex items-center gap-2">
                    <Globe className="size-4 shrink-0 text-muted-foreground" />
                    <span className="font-medium">{c.countryCode}</span>
                  </div>
                  <div className="mt-3 grid grid-cols-2 gap-2">
                    {(
                      [
                        ["Physical", "physical_withdrawal", c.physicalWithdrawal],
                        ["Digital", "digital_withdrawal", c.digitalWithdrawal],
                        ["Gift Card", "gift_card_deposit", c.giftCardDeposit],
                        ["Promo Code", "promo_code_deposit", c.promoCodeDeposit],
                        ["Blocked", "blocked", c.blocked],
                      ] as const
                    ).map(([label, field, value]) => (
                      <div
                        key={field}
                        className="flex items-center justify-between gap-2 rounded-lg border bg-background/40 px-3 py-2"
                      >
                        <span className="text-sm text-muted-foreground">
                          {label}
                        </span>
                        <Switch
                          checked={value}
                          onCheckedChange={() =>
                            handleCountryToggle(c.countryCode, field, value)
                          }
                          disabled={isPending}
                        />
                      </div>
                    ))}
                  </div>
                  <div className="mt-3 space-y-2">
                    {(
                      [
                        [
                          "Locked Deposits Crypto",
                          "locked_deposits_crypto",
                          c.lockedDepositsCrypto,
                          CRYPTO_OPTIONS,
                        ],
                        [
                          "Locked Deposits Fiat",
                          "locked_deposits_fiat",
                          c.lockedDepositsFiat,
                          FIAT_OPTIONS,
                        ],
                        [
                          "Locked Withdrawals Crypto",
                          "locked_withdrawals_crypto",
                          c.lockedWithdrawalsCrypto,
                          CRYPTO_OPTIONS,
                        ],
                      ] as const
                    ).map(([label, field, values, options]) => (
                      <div
                        key={field}
                        className="flex items-center justify-between gap-3"
                      >
                        <span className="text-sm text-muted-foreground">
                          {label}
                        </span>
                        <CurrencyMultiSelect
                          countryCode={c.countryCode}
                          field={field}
                          values={values}
                          options={options}
                          disabled={isPending}
                          startTransition={startTransition}
                          router={router}
                        />
                      </div>
                    ))}
                  </div>
                </div>
              ))}
            </div>
          </>
        )}
      </div>
    </div>
  );
}

const CRYPTO_OPTIONS = [
  { value: "bitcoin", label: "Bitcoin" },
  { value: "ethereum", label: "Ethereum" },
  { value: "solana", label: "Solana" },
  { value: "usdt_erc20", label: "USDT (ERC20)" },
  { value: "usdt_trc20", label: "USDT (TRC20)" },
];

const FIAT_OPTIONS = [
  { value: "gift_card", label: "Gift Card" },
  { value: "promo_code", label: "Promo Code" },
];

function CurrencyMultiSelect({
  countryCode,
  field,
  values,
  options,
  disabled,
  startTransition,
  router,
}: {
  countryCode: string;
  field: string;
  values: string[];
  options: { value: string; label: string }[];
  disabled: boolean;
  startTransition: (fn: () => Promise<void>) => void;
  router: ReturnType<typeof useRouter>;
}) {
  function handleToggle(optionValue: string) {
    const newValues = values.includes(optionValue)
      ? values.filter((v) => v !== optionValue)
      : [...values, optionValue];
    startTransition(async () => {
      try {
        await updateCountryRestrictionArray(countryCode, field, newValues);
        toast.success("Restriction updated");
        router.refresh();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Failed");
      }
    });
  }

  return (
    <Popover>
      <PopoverTrigger disabled={disabled} className="flex items-center gap-1 text-xs cursor-pointer rounded border px-2 py-1 hover:bg-muted">
        {values.length === 0 ? (
          <span className="text-muted-foreground">None</span>
        ) : (
          <span>{values.length} blocked</span>
        )}
        <ChevronDown className="h-3 w-3" />
      </PopoverTrigger>
      <PopoverContent align="start" className="w-48 p-2">
        <div className="flex flex-col gap-1">
          {options.map((opt) => (
            <label
              key={opt.value}
              className="flex items-center gap-2 rounded px-2 py-1 text-sm cursor-pointer hover:bg-muted"
            >
              <input
                type="checkbox"
                checked={values.includes(opt.value)}
                onChange={() => handleToggle(opt.value)}
                disabled={disabled}
                className="rounded"
              />
              {opt.label}
            </label>
          ))}
        </div>
      </PopoverContent>
    </Popover>
  );
}

function VaultLockTimesCard({
  vaultLockTimes,
  isPending,
  startTransition,
  router,
}: {
  vaultLockTimes: SettingsData["vaultLockTimes"];
  isPending: boolean;
  startTransition: (fn: () => Promise<void>) => void;
  router: ReturnType<typeof useRouter>;
}) {
  const [editingId, setEditingId] = useState<string | null>(null);
  const [editHours, setEditHours] = useState("");
  const [editLabel, setEditLabel] = useState("");
  const [newHours, setNewHours] = useState("");
  const [newLabel, setNewLabel] = useState("");

  function startEdit(v: SettingsData["vaultLockTimes"][number]) {
    setEditingId(v.id);
    setEditHours(String(v.hours));
    setEditLabel(v.label);
  }

  function cancelEdit() {
    setEditingId(null);
  }

  function handleSaveEdit(id: string) {
    const hours = parseInt(editHours);
    if (isNaN(hours) || hours <= 0) {
      toast.error("Hours must be a positive number");
      return;
    }
    startTransition(async () => {
      try {
        await upsertVaultLockTime(id, hours, editLabel);
        toast.success("Lock time updated");
        setEditingId(null);
        router.refresh();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Failed");
      }
    });
  }

  function handleAdd() {
    const hours = parseInt(newHours);
    if (isNaN(hours) || hours <= 0) {
      toast.error("Hours must be a positive number");
      return;
    }
    if (!newLabel.trim()) {
      toast.error("Label is required");
      return;
    }
    startTransition(async () => {
      try {
        await upsertVaultLockTime(null, hours, newLabel);
        toast.success("Lock time added");
        setNewHours("");
        setNewLabel("");
        router.refresh();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Failed");
      }
    });
  }

  function handleDelete(id: string) {
    if (!confirm("Delete this vault lock time?")) return;
    startTransition(async () => {
      try {
        await deleteVaultLockTime(id);
        toast.success("Lock time deleted");
        router.refresh();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Failed");
      }
    });
  }

  return (
    <div className="space-y-3">
      <SectionHeading icon={Timer} title="Vault Lock Times" />
      <div className="space-y-4 rounded-xl border p-4">
        <div className="overflow-x-auto">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Hours</TableHead>
              <TableHead>Label</TableHead>
              <TableHead className="w-[100px]" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {vaultLockTimes.map((v) =>
              editingId === v.id ? (
                <TableRow key={v.id} className={cn(transition("all", "base"))}>
                  <TableCell>
                    <Input
                      type="number"
                      value={editHours}
                      onChange={(e) => setEditHours(e.target.value)}
                      className="h-8 w-24"
                      disabled={isPending}
                    />
                  </TableCell>
                  <TableCell>
                    <Input
                      value={editLabel}
                      onChange={(e) => setEditLabel(e.target.value)}
                      className="h-8"
                      disabled={isPending}
                    />
                  </TableCell>
                  <TableCell>
                    <div className="flex gap-1">
                      <Button
                        variant="ghost"
                        size="icon"
                        disabled={isPending}
                        onClick={() => handleSaveEdit(v.id)}
                      >
                        <Check className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        onClick={cancelEdit}
                      >
                        <X className="h-4 w-4" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              ) : (
                <TableRow key={v.id} className={cn(transition("all", "base"))}>
                  <TableCell>{v.hours}h</TableCell>
                  <TableCell>{v.label}</TableCell>
                  <TableCell>
                    <div className="flex gap-1">
                      <Button
                        variant="ghost"
                        size="icon"
                        disabled={isPending}
                        onClick={() => startEdit(v)}
                      >
                        <Pencil className="h-4 w-4" />
                      </Button>
                      <Button
                        variant="ghost"
                        size="icon"
                        disabled={isPending}
                        onClick={() => handleDelete(v.id)}
                      >
                        <Trash2 className="h-4 w-4 text-destructive" />
                      </Button>
                    </div>
                  </TableCell>
                </TableRow>
              )
            )}
            {vaultLockTimes.length === 0 && (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={3} className="p-0">
                  <EmptyState
                    icon={Timer}
                    title="No vault lock times configured"
                    description="Add a duration below to offer it as a vault option."
                    compact
                  />
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
        </div>

        <div className="flex flex-col items-stretch gap-3 sm:flex-row sm:items-end sm:gap-4">
          <div className="space-y-1">
            <Label>Hours</Label>
            <Input
              type="number"
              placeholder="e.g. 48"
              value={newHours}
              onChange={(e) => setNewHours(e.target.value)}
              className="sm:w-24"
            />
          </div>
          <div className="space-y-1 flex-1">
            <Label>Label</Label>
            <Input
              placeholder="e.g. 2 Days"
              value={newLabel}
              onChange={(e) => setNewLabel(e.target.value)}
            />
          </div>
          <Button onClick={handleAdd} disabled={isPending}>
            {isPending && newLabel.trim() && newHours.trim() ? (
              <Spinner size={16} className="text-current" />
            ) : (
              <Plus className="size-4" />
            )}
            Add
          </Button>
        </div>
      </div>
    </div>
  );
}
