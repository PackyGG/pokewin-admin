"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import Link from "next/link";
import { toast } from "sonner";
import { Package, ArrowRight } from "lucide-react";
import { Switch } from "@/components/ui/switch";
import { Badge } from "@/components/ui/badge";
import { setPhysicalWithdrawalAllCountries } from "./actions";
import type { PhysicalAvailability } from "@/lib/queries/physical-withdrawals";

export function PhysicalControls({
  availability,
}: {
  availability: PhysicalAvailability;
}) {
  const router = useRouter();
  const [isPending, startTransition] = useTransition();

  const allCountriesAllowed =
    availability.totalCountries > 0 &&
    availability.physicalCountriesAllowed === availability.totalCountries;
  const [physicalAllOn, setPhysicalAllOn] = useState(allCountriesAllowed);

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
    <div className="relative overflow-hidden rounded-2xl border bg-card p-5 md:max-w-xl">
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
  );
}
