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
  const [duration, setDuration] = useState(60);
  const [draftDurations, setDraftDurations] = useState<Record<string, number>>(
    Object.fromEntries(
      initialLocations.map((location) => [
        location.countryCode,
        location.monitorDurationMinutes,
      ]),
    ),
  );
  const [isPending, startTransition] = useTransition();
  const countryNames = useMemo(
    () => new Map(countries.map((country) => [country.code, country.name])),
    [countries],
  );
  const configuredCodes = new Set(
    locations.map((location) => location.countryCode),
  );

  function addLocation(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!countryCode || duration < 1 || duration > 60) {
      toast.error("Choose a country and a monitor time from 1 to 60 minutes.");
      return;
    }
    startTransition(async () => {
      try {
        const saved = await addRiskyLocation({
          countryCode,
          monitorDurationMinutes: duration,
          idempotencyKey: crypto.randomUUID(),
        });
        setLocations((current) => [
          ...current.filter(
            (location) => location.countryCode !== saved.countryCode,
          ),
          saved,
        ]);
        setDraftDurations((current) => ({
          ...current,
          [saved.countryCode]: saved.monitorDurationMinutes,
        }));
        setCountryCode("");
        toast.success(
          `${countryNames.get(saved.countryCode) ?? saved.countryCode} now uses a ${saved.monitorDurationMinutes}-minute monitor.`,
        );
      } catch (error) {
        toast.error(
          error instanceof Error
            ? error.message
            : "The risky location could not be added.",
        );
      }
    });
  }

  function saveLocation(location: RiskyLocation, enabled = location.enabled) {
    const monitorDurationMinutes =
      draftDurations[location.countryCode] ??
      location.monitorDurationMinutes;
    if (monitorDurationMinutes < 1 || monitorDurationMinutes > 60) {
      toast.error("Monitor time must be between 1 and 60 minutes.");
      return;
    }
    startTransition(async () => {
      try {
        const saved = await setRiskyLocation({
          countryCode: location.countryCode,
          enabled,
          monitorDurationMinutes,
          idempotencyKey: crypto.randomUUID(),
        });
        setLocations((current) =>
          current.map((entry) =>
            entry.countryCode === saved.countryCode ? saved : entry,
          ),
        );
        setDraftDurations((current) => ({
          ...current,
          [saved.countryCode]: saved.monitorDurationMinutes,
        }));
        toast.success(
          saved.enabled
            ? `${countryNames.get(saved.countryCode) ?? saved.countryCode} will be monitored for ${saved.monitorDurationMinutes} minutes.`
            : `${countryNames.get(saved.countryCode) ?? saved.countryCode} is disabled.`,
        );
      } catch (error) {
        toast.error(
          error instanceof Error
            ? error.message
            : "The risky location could not be updated.",
        );
      }
    });
  }

  return (
    <div className="grid gap-5 xl:grid-cols-[minmax(0,0.75fr)_minmax(0,1.25fr)]">
      <form
        onSubmit={addLocation}
        className="h-fit space-y-4 rounded-xl border bg-card p-4"
      >
        <div>
          <h2 className="flex items-center gap-2 text-sm font-semibold">
            <MapPinPlus className="size-4 text-cyan-500" />
            Add risky location
          </h2>
          <p className="mt-1 text-xs leading-5 text-muted-foreground">
            New accounts from this country enter the live monitor even when
            they have no other risk points.
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
        <div className="space-y-2">
          <Label htmlFor="risky-duration">Monitor time (minutes)</Label>
          <Input
            id="risky-duration"
            type="number"
            min={1}
            max={60}
            value={duration}
            onChange={(event) => setDuration(Number(event.target.value))}
            disabled={isPending}
          />
          <p className="text-xs text-muted-foreground">
            60 minutes is supported, but it keeps matching accounts active 20×
            longer than the 3-minute default. Use long windows selectively.
          </p>
        </div>
        <Button type="submit" className="w-full" disabled={isPending}>
          {isPending ? (
            <Loader2 className="size-4 animate-spin" />
          ) : (
            <MapPinPlus className="size-4" />
          )}
          Add location
        </Button>
      </form>

      <section className="overflow-hidden rounded-xl border bg-card">
        <div className="border-b px-4 py-3">
          <h2 className="flex items-center gap-2 text-sm font-semibold">
            <ShieldCheck className="size-4 text-cyan-500" />
            Location monitor rules
          </h2>
        </div>
        {locations.length === 0 ? (
          <p className="px-4 py-10 text-center text-sm text-muted-foreground">
            No risky locations are configured.
          </p>
        ) : (
          <div className="divide-y">
            {locations
              .toSorted((a, b) =>
                (countryNames.get(a.countryCode) ?? a.countryCode).localeCompare(
                  countryNames.get(b.countryCode) ?? b.countryCode,
                ),
              )
              .map((location) => (
                <div
                  key={location.countryCode}
                  className="grid gap-3 px-4 py-3 md:grid-cols-[minmax(0,1fr)_120px_auto] md:items-end"
                >
                  <div className="min-w-0 self-center">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="text-sm font-semibold">
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
                    <p className="mt-1 text-xs text-muted-foreground">
                      Applies to new signups after this rule is enabled.
                    </p>
                  </div>
                  <div className="space-y-1.5">
                    <Label htmlFor={`duration-${location.countryCode}`}>
                      Minutes
                    </Label>
                    <Input
                      id={`duration-${location.countryCode}`}
                      type="number"
                      min={1}
                      max={60}
                      value={
                        draftDurations[location.countryCode] ??
                        location.monitorDurationMinutes
                      }
                      onChange={(event) =>
                        setDraftDurations((current) => ({
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
    </div>
  );
}
