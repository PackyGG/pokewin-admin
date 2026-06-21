"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { toast } from "sonner";
import { Globe, Package, AlertTriangle, ArrowRight } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import {
  setWithdrawalsEnabled,
  setPhysicalWithdrawalAllCountries,
} from "./actions";
import type { PhysicalAvailability } from "@/lib/queries/physical-withdrawals";

export function PhysicalControls({
  availability,
}: {
  availability: PhysicalAvailability;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  const [withdrawalsOn, setWithdrawalsOn] = useState(
    availability.withdrawalsEnabled,
  );
  const allCountriesAllowed =
    availability.totalCountries > 0 &&
    availability.physicalCountriesAllowed === availability.totalCountries;
  const [physicalAllOn, setPhysicalAllOn] = useState(allCountriesAllowed);

  function toggleWithdrawals(next: boolean) {
    setWithdrawalsOn(next);
    startTransition(async () => {
      const r = await setWithdrawalsEnabled(next);
      if (!r.success) {
        setWithdrawalsOn(!next);
        toast.error(r.error);
        return;
      }
      toast.success(
        next ? "Withdrawals enabled" : "All withdrawals disabled",
      );
      router.refresh();
    });
  }

  function togglePhysicalAll(next: boolean) {
    setPhysicalAllOn(next);
    startTransition(async () => {
      const r = await setPhysicalWithdrawalAllCountries(next);
      if (!r.success) {
        setPhysicalAllOn(!next);
        toast.error(r.error);
        return;
      }
      toast.success(
        next
          ? "Physical withdrawal enabled in all countries"
          : "Physical withdrawal disabled in all countries",
      );
      router.refresh();
    });
  }

  return (
    <div className="grid gap-4 md:grid-cols-2">
      {/* Global withdrawals master switch */}
      <div className="relative overflow-hidden rounded-2xl border bg-card p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0 space-y-1">
            <div className="flex items-center gap-2">
              <Globe className="size-4 text-muted-foreground" />
              <h3 className="text-sm font-semibold">Withdrawals master switch</h3>
            </div>
            <p className="text-xs text-muted-foreground">
              Global on/off for the whole site. When off, the backend blocks{" "}
              <span className="font-medium">every</span> withdrawal request.
            </p>
          </div>
          <Switch
            checked={withdrawalsOn}
            onCheckedChange={toggleWithdrawals}
            disabled={isPending}
            aria-label="Toggle all withdrawals"
          />
        </div>
        <div className="mt-3 flex items-center gap-2">
          <Badge
            variant="outline"
            className={
              withdrawalsOn
                ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                : "border-rose-500/30 bg-rose-500/10 text-rose-600 dark:text-rose-400"
            }
          >
            {withdrawalsOn ? "Enabled" : "Disabled"}
          </Badge>
        </div>
        <div className="mt-3 flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2">
          <AlertTriangle className="mt-0.5 size-3.5 shrink-0 text-amber-500" />
          <p className="text-[11px] text-amber-700 dark:text-amber-300">
            This affects crypto and balance withdrawals too, not just physical.
            It maps to <code className="font-mono">site_config.withdrawals_enabled</code>.
          </p>
        </div>
      </div>

      {/* Physical withdrawal availability (per-country, bulk-toggled) */}
      <div className="relative overflow-hidden rounded-2xl border bg-card p-5">
        <div className="flex items-start justify-between gap-4">
          <div className="min-w-0 space-y-1">
            <div className="flex items-center gap-2">
              <Package className="size-4 text-muted-foreground" />
              <h3 className="text-sm font-semibold">Physical withdrawal</h3>
            </div>
            <p className="text-xs text-muted-foreground">
              Allow physical card shipments in every country. Maps to{" "}
              <code className="font-mono">country_restrictions.physical_withdrawal</code>.
            </p>
          </div>
          <Switch
            checked={physicalAllOn}
            onCheckedChange={togglePhysicalAll}
            disabled={isPending}
            aria-label="Toggle physical withdrawal in all countries"
          />
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Badge
            variant="outline"
            className={
              physicalAllOn
                ? "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 dark:text-emerald-400"
                : "border-amber-500/30 bg-amber-500/10 text-amber-600 dark:text-amber-400"
            }
          >
            {physicalAllOn ? "Allowed everywhere" : "Partially / fully blocked"}
          </Badge>
          <span className="text-xs text-muted-foreground">
            {availability.physicalCountriesAllowed} / {availability.totalCountries}{" "}
            countries
          </span>
        </div>
        <Link
          href="/system/geo-blocking"
          className="mt-3 inline-flex items-center gap-1 text-xs font-medium text-blue-500 hover:underline"
        >
          Edit per-country rules
          <ArrowRight className="size-3" />
        </Link>
      </div>
    </div>
  );
}
