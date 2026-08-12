"use client";

import { useMemo, useState, useTransition } from "react";
import {
  Check,
  ChevronsUpDown,
  Loader2,
  MapPinPlus,
  Save,
  ShieldCheck,
} from "lucide-react";
import { toast } from "sonner";
import { clientActionError } from "@/lib/errors/client-action-error";

import { EmptyState } from "@/components/empty-state";
import { SectionHeading } from "@/components/modern-panels";
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
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Command,
  CommandEmpty,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover";
import { cn } from "@/lib/utils";
import type { RiskyLocation } from "@/lib/antifraud/risky-locations-api";
import { addRiskyLocation, setRiskyLocation } from "./actions";

type CountryOption = { code: string; name: string };

const MONITOR_DURATION_MINUTES = 15;
const DEFAULT_RISK_WEIGHT = 20;

function flag(code: string): string {
  return String.fromCodePoint(
    ...code.split("").map((character) => 127397 + character.charCodeAt(0)),
  );
}

export function RiskyLocationsClient({
  initialLocations,
  countries,
}: {
  initialLocations: RiskyLocation[];
  countries: CountryOption[];
}) {
  const [locations, setLocations] = useState(initialLocations);
  const [countryCode, setCountryCode] = useState("");
  const [countryOpen, setCountryOpen] = useState(false);
  // Confirmation state for the two audited mutations. Replaces the native
  // window.confirm calls — identical wording, identical arguments.
  const [pendingCountry, setPendingCountry] = useState<string | null>(null);
  const [pendingSave, setPendingSave] = useState<{
    location: RiskyLocation;
    enabled: boolean;
    weight: number;
  } | null>(null);
  const [isPending, startTransition] = useTransition();
  const [draftWeights, setDraftWeights] = useState<Record<string, number>>(
    Object.fromEntries(
      initialLocations.map((location) => [
        location.countryCode,
        location.riskWeight,
      ]),
    ),
  );
  const countryNames = useMemo(
    () => new Map(countries.map((country) => [country.code, country.name])),
    [countries],
  );
  const configuredCodes = new Set(
    locations.map((location) => location.countryCode),
  );

  function addLocation(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!countryCode) {
      toast.error("Choose a country.");
      return;
    }
    setPendingCountry(countryCode);
  }

  function confirmAddLocation() {
    const countryCode = pendingCountry;
    if (!countryCode) return;
    setPendingCountry(null);
    startTransition(async () => {
      try {
        const result = await addRiskyLocation({
          countryCode,
          monitorDurationMinutes: MONITOR_DURATION_MINUTES,
          riskWeight: DEFAULT_RISK_WEIGHT,
          idempotencyKey: crypto.randomUUID(),
        });
        if (!result.success) {
          toast.error(result.error);
          return;
        }
        const saved = result.data;
        setLocations((current) => [
          ...current.filter(
            (location) => location.countryCode !== saved.countryCode,
          ),
          saved,
        ]);
        setDraftWeights((current) => ({
          ...current,
          [saved.countryCode]: saved.riskWeight,
        }));
        setCountryCode("");
        toast.success(
          `${countryNames.get(saved.countryCode) ?? saved.countryCode} now uses a ${saved.monitorDurationMinutes}-minute monitor.`,
        );
      } catch (error) {
        toast.error(
          clientActionError(error, "The risky location could not be added."),
        );
      }
    });
  }

  function saveLocation(location: RiskyLocation, enabled = location.enabled) {
    const selectedWeight =
      draftWeights[location.countryCode] ?? location.riskWeight;
    setPendingSave({ location, enabled, weight: selectedWeight });
  }

  function confirmSaveLocation() {
    const request = pendingSave;
    if (!request) return;
    const { location, enabled, weight: selectedWeight } = request;
    setPendingSave(null);
    startTransition(async () => {
      try {
        const result = await setRiskyLocation({
          countryCode: location.countryCode,
          enabled,
          monitorDurationMinutes: MONITOR_DURATION_MINUTES,
          riskWeight: selectedWeight,
          idempotencyKey: crypto.randomUUID(),
        });
        if (!result.success) {
          toast.error(result.error);
          return;
        }
        const saved = result.data;
        setLocations((current) =>
          current.map((entry) =>
            entry.countryCode === saved.countryCode ? saved : entry,
          ),
        );
        setDraftWeights((current) => ({
          ...current,
          [saved.countryCode]: saved.riskWeight,
        }));
        toast.success(
          saved.enabled
            ? `${countryNames.get(saved.countryCode) ?? saved.countryCode} will be monitored for ${saved.monitorDurationMinutes} minutes.`
            : `${countryNames.get(saved.countryCode) ?? saved.countryCode} is disabled.`,
        );
      } catch (error) {
        toast.error(
          clientActionError(error, "The risky location could not be updated."),
        );
      }
    });
  }

  return (
    <div className="grid gap-5 xl:grid-cols-[minmax(0,0.75fr)_minmax(0,1.25fr)]">
      <form
        onSubmit={addLocation}
        className="h-fit space-y-4 rounded-xl border border-border/60 bg-card p-3 sm:p-4"
      >
        <div>
          <SectionHeading icon={MapPinPlus} title="Add risky location" />
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            New accounts from this country enter the live monitor for{" "}
            {MONITOR_DURATION_MINUTES} minutes even when they have no other risk
            points.
          </p>
        </div>
        <div className="space-y-2">
          <Label htmlFor="risky-country">Country</Label>
          <Popover open={countryOpen} onOpenChange={setCountryOpen}>
            <PopoverTrigger
              render={
                <Button
                  id="risky-country"
                  type="button"
                  variant="outline"
                  disabled={isPending}
                  className="h-9 w-full justify-between text-left font-normal"
                />
              }
            >
              {countryCode ? (
                <span className="truncate">
                  {flag(countryCode)}{" "}
                  {countryNames.get(countryCode) ?? countryCode}
                </span>
              ) : (
                <span className="text-muted-foreground">Choose a country</span>
              )}
              <ChevronsUpDown className="ml-1 size-3 shrink-0 opacity-50" />
            </PopoverTrigger>
            <PopoverContent
              className="w-[var(--anchor-width)] min-w-64 p-0"
              align="start"
            >
              <Command>
                <CommandInput placeholder="Search countries..." />
                <CommandList>
                  <CommandEmpty>No country found.</CommandEmpty>
                  {countries
                    .filter((country) => !configuredCodes.has(country.code))
                    .map((country) => (
                      <CommandItem
                        key={country.code}
                        value={`${country.name} ${country.code}`}
                        onSelect={() => {
                          setCountryCode(country.code);
                          setCountryOpen(false);
                        }}
                      >
                        <span className="truncate">
                          {flag(country.code)} {country.name}
                        </span>
                        <Check
                          className={cn(
                            "ml-auto size-4",
                            countryCode === country.code
                              ? "opacity-100"
                              : "opacity-0",
                          )}
                        />
                      </CommandItem>
                    ))}
                </CommandList>
              </Command>
            </PopoverContent>
          </Popover>
        </div>
        <p className="text-xs text-muted-foreground">
          Risk weight starts at {DEFAULT_RISK_WEIGHT} and can be changed in the
          rules list.
        </p>
        <Button type="submit" className="w-full" disabled={isPending}>
          {isPending ? (
            <Loader2 className="size-4 motion-safe:animate-spin" />
          ) : (
            <MapPinPlus className="size-4" />
          )}
          Add location
        </Button>
      </form>

      <section className="overflow-hidden rounded-xl border border-border/60 bg-card">
        <div className="border-b border-border/60 px-4 py-3">
          <SectionHeading
            icon={ShieldCheck}
            title="Location monitor rules"
            action={
              <span className="text-[10px] font-semibold uppercase tracking-wide tabular-nums text-muted-foreground">
                {locations.length} {locations.length === 1 ? "rule" : "rules"}
              </span>
            }
          />
        </div>
        {locations.length === 0 ? (
          <EmptyState
            icon={MapPinPlus}
            title="No risky locations are configured."
          />
        ) : (
          <div className="divide-y divide-border/60">
            {locations
              .toSorted((a, b) =>
                (
                  countryNames.get(a.countryCode) ?? a.countryCode
                ).localeCompare(
                  countryNames.get(b.countryCode) ?? b.countryCode,
                ),
              )
              .map((location) => (
                <div
                  key={location.countryCode}
                  className="grid gap-3 px-4 py-3 md:grid-cols-[minmax(0,1fr)_96px_auto] md:items-end"
                >
                  <div className="min-w-0 space-y-1 self-center">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="truncate text-sm font-semibold">
                        {flag(location.countryCode)}{" "}
                        {countryNames.get(location.countryCode) ??
                          location.countryCode}
                      </span>
                      <Badge
                        variant="outline"
                        className={
                          location.enabled
                            ? "border-cyan-500/30 bg-cyan-500/10 text-cyan-700 dark:text-cyan-300"
                            : ""
                        }
                      >
                        {location.enabled ? "Monitoring" : "Disabled"}
                      </Badge>
                    </div>
                    <p className="text-xs tabular-nums text-muted-foreground">
                      {location.affectedUsers} accounts · {location.matches24h}/24h ·{" "}
                      {location.matches7d}/7d · {location.matches30d}/30d ·{" "}
                      {location.averageRisk ?? "unknown"} avg risk ·{" "}
                      {location.reviewCount} reviews · bans/locks unknown
                    </p>
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor={`weight-${location.countryCode}`}>Weight</Label>
                    <Input
                      id={`weight-${location.countryCode}`}
                      type="number"
                      min={0}
                      max={49}
                      value={draftWeights[location.countryCode] ?? location.riskWeight}
                      onChange={(event) =>
                        setDraftWeights((current) => ({
                          ...current,
                          [location.countryCode]: Number(event.target.value),
                        }))
                      }
                      disabled={isPending}
                    />
                  </div>
                  <div className="flex gap-2">
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      disabled={isPending}
                      onClick={() => saveLocation(location)}
                    >
                      <Save className="size-4" />
                      Save
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant={location.enabled ? "outline" : "default"}
                      disabled={isPending}
                      onClick={() => saveLocation(location, !location.enabled)}
                    >
                      {location.enabled ? "Disable" : "Enable"}
                    </Button>
                  </div>
                </div>
              ))}
          </div>
        )}
      </section>

      <AlertDialog
        open={pendingCountry !== null}
        onOpenChange={(open) => {
          if (!open && !isPending) setPendingCountry(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {`Add ${countryNames.get(pendingCountry ?? "") ?? pendingCountry ?? ""} as a risk location?`}
            </AlertDialogTitle>
            <AlertDialogDescription>
              This change will be audited.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              onClick={confirmAddLocation}
              disabled={isPending || !pendingCountry}
            >
              Add location
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={pendingSave !== null}
        onOpenChange={(open) => {
          if (!open && !isPending) setPendingSave(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {pendingSave
                ? `${pendingSave.enabled ? "Save" : "Disable"} ${countryNames.get(pendingSave.location.countryCode) ?? pendingSave.location.countryCode}?`
                : ""}
            </AlertDialogTitle>
            <AlertDialogDescription>
              This change will be audited.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel disabled={isPending}>Cancel</AlertDialogCancel>
            <AlertDialogAction
              variant={pendingSave?.enabled ? "default" : "destructive"}
              onClick={confirmSaveLocation}
              disabled={isPending || !pendingSave}
            >
              {pendingSave?.enabled ? "Save" : "Disable"}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </div>
  );
}
