"use client";

import * as React from "react";
import { toast } from "sonner";
import { Download, FileDown, Search, X, Check, Globe } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { cn } from "@/lib/utils";

type Country = { code: string; name: string };

type DepositFilter = "any" | "has_deposited" | "no_deposit";
type CountryMode = "any" | "include" | "exclude";

export function ExportUsersButton({
  countries,
}: {
  countries: Country[];
}) {
  const [open, setOpen] = React.useState(false);
  const [countryMode, setCountryMode] = React.useState<CountryMode>("any");
  const [selected, setSelected] = React.useState<Set<string>>(new Set());
  const [deposit, setDeposit] = React.useState<DepositFilter>("any");
  const [excludeStaff, setExcludeStaff] = React.useState(true);
  const [requireEmail, setRequireEmail] = React.useState(true);
  const [countryQuery, setCountryQuery] = React.useState("");
  const [downloading, setDownloading] = React.useState(false);

  // Reset the form each time the dialog opens — prevents a previous
  // export's filters from leaking into a new session.
  React.useEffect(() => {
    if (!open) return;
    setCountryMode("any");
    setSelected(new Set());
    setDeposit("any");
    setExcludeStaff(true);
    setRequireEmail(true);
    setCountryQuery("");
  }, [open]);

  const filteredCountries = React.useMemo(() => {
    const q = countryQuery.trim().toLowerCase();
    if (!q) return countries;
    return countries.filter(
      (c) =>
        c.name.toLowerCase().includes(q) || c.code.toLowerCase().includes(q),
    );
  }, [countries, countryQuery]);

  function toggle(code: string) {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(code)) next.delete(code);
      else next.add(code);
      return next;
    });
  }

  async function submit() {
    setDownloading(true);
    try {
      const res = await fetch("/api/users/export", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          countryMode: countryMode === "any" ? "any" : countryMode,
          countryCodes: countryMode === "any" ? [] : [...selected],
          deposit,
          excludeStaff,
          requireEmail,
        }),
      });
      if (!res.ok) {
        const text = await res.text().catch(() => "");
        throw new Error(
          text.length > 0 && text.length < 300
            ? text
            : `Export failed (${res.status})`,
        );
      }

      const blob = await res.blob();
      const contentDisp = res.headers.get("content-disposition") ?? "";
      const m = /filename="?([^"]+)"?/i.exec(contentDisp);
      const filename = m ? m[1] : `users-${Date.now()}.csv`;

      // Trigger the browser download by synthesizing an anchor click
      // on an object URL — the standard pattern for "fetch → file
      // download" since browsers don't expose a direct save API.
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = filename;
      document.body.appendChild(a);
      a.click();
      a.remove();
      URL.revokeObjectURL(url);

      toast.success("Export downloaded");
      setOpen(false);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Export failed");
    } finally {
      setDownloading(false);
    }
  }

  const selectedList = React.useMemo(
    () =>
      [...selected]
        .map((code) => countries.find((c) => c.code === code))
        .filter((c): c is Country => c != null),
    [selected, countries],
  );

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <Button variant="outline" size="sm">
            <FileDown className="size-4" />
            Export
          </Button>
        }
      />
      <DialogContent className="sm:max-w-lg">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Download className="size-4 text-primary" />
            Export user emails
          </DialogTitle>
        </DialogHeader>

        <div className="space-y-4 py-2">
          {/* Country filter */}
          <div className="space-y-2">
            <Label className="text-xs font-medium">
              <Globe className="mr-1 inline size-3.5" />
              Country filter
            </Label>
            <div className="flex gap-1.5">
              {(["any", "include", "exclude"] as CountryMode[]).map((mode) => (
                <button
                  key={mode}
                  type="button"
                  onClick={() => setCountryMode(mode)}
                  className={cn(
                    "flex-1 rounded-md border px-2 py-1.5 text-xs font-medium transition-colors",
                    countryMode === mode
                      ? "border-primary/60 bg-primary/10 text-foreground"
                      : "border-border bg-background text-muted-foreground hover:border-border hover:bg-accent/40",
                  )}
                >
                  {mode === "any"
                    ? "Any country"
                    : mode === "include"
                      ? "Include only"
                      : "Exclude"}
                </button>
              ))}
            </div>

            {countryMode !== "any" && (
              <div className="space-y-2 rounded-lg border border-border bg-background/50 p-2">
                <div className="relative">
                  <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                  <Input
                    value={countryQuery}
                    onChange={(e) => setCountryQuery(e.target.value)}
                    placeholder={`Search ${countries.length} countries…`}
                    className="h-7 pl-8 text-xs"
                  />
                </div>
                <div className="max-h-48 space-y-1 overflow-y-auto">
                  {filteredCountries.length === 0 && (
                    <p className="px-2 py-3 text-xs text-muted-foreground">
                      No match.
                    </p>
                  )}
                  {filteredCountries.map((c) => {
                    const isSelected = selected.has(c.code);
                    return (
                      <button
                        key={c.code}
                        type="button"
                        onClick={() => toggle(c.code)}
                        className={cn(
                          "flex w-full items-center gap-2 rounded-md border px-2 py-1.5 text-left text-xs transition-colors",
                          isSelected
                            ? "border-primary/50 bg-primary/10"
                            : "border-transparent hover:border-border hover:bg-accent/40",
                        )}
                      >
                        <span
                          className={cn(
                            "flex size-4 items-center justify-center rounded-sm border",
                            isSelected
                              ? "border-primary bg-primary text-primary-foreground"
                              : "border-border bg-background",
                          )}
                          aria-hidden
                        >
                          {isSelected && <Check className="size-3" />}
                        </span>
                        <span className="flex-1 truncate font-medium">
                          {c.name}
                        </span>
                        <span className="font-mono text-[10px] text-muted-foreground">
                          {c.code}
                        </span>
                      </button>
                    );
                  })}
                </div>
                {selectedList.length > 0 && (
                  <div className="flex flex-wrap gap-1 border-t border-border/60 pt-2">
                    {selectedList.map((c) => (
                      <Badge
                        key={c.code}
                        variant="outline"
                        className="flex items-center gap-1 px-1.5 py-0.5 text-[10px]"
                      >
                        {c.name}
                        <button
                          type="button"
                          onClick={() => toggle(c.code)}
                          aria-label={`Remove ${c.name}`}
                          className="hover:text-foreground"
                        >
                          <X className="size-2.5" />
                        </button>
                      </Badge>
                    ))}
                  </div>
                )}
                <p className="text-[10px] text-muted-foreground">
                  {countryMode === "include"
                    ? "Only users whose country matches a selection will be exported."
                    : "Users in the selected countries will be skipped; users with no country on file are kept."}
                </p>
              </div>
            )}
          </div>

          {/* Deposit filter */}
          <div className="space-y-2">
            <Label className="text-xs font-medium">Deposit status</Label>
            <div className="flex gap-1.5">
              {(
                [
                  ["any", "Any"],
                  ["has_deposited", "Has deposited"],
                  ["no_deposit", "No deposit yet"],
                ] as [DepositFilter, string][]
              ).map(([val, label]) => (
                <button
                  key={val}
                  type="button"
                  onClick={() => setDeposit(val)}
                  className={cn(
                    "flex-1 rounded-md border px-2 py-1.5 text-xs font-medium transition-colors",
                    deposit === val
                      ? "border-primary/60 bg-primary/10 text-foreground"
                      : "border-border bg-background text-muted-foreground hover:border-border hover:bg-accent/40",
                  )}
                >
                  {label}
                </button>
              ))}
            </div>
          </div>

          {/* Secondary options */}
          <div className="space-y-2">
            <Label className="text-xs font-medium">Options</Label>
            <label className="flex cursor-pointer items-center gap-2 rounded-md border border-border bg-background/50 px-2 py-1.5 text-xs">
              <input
                type="checkbox"
                checked={excludeStaff}
                onChange={(e) => setExcludeStaff(e.target.checked)}
                className="size-3.5 accent-primary"
              />
              Exclude staff accounts (admin, creator)
            </label>
            <label className="flex cursor-pointer items-center gap-2 rounded-md border border-border bg-background/50 px-2 py-1.5 text-xs">
              <input
                type="checkbox"
                checked={requireEmail}
                onChange={(e) => setRequireEmail(e.target.checked)}
                className="size-3.5 accent-primary"
              />
              Only include users with an email set
            </label>
          </div>

          <p className="rounded-lg border border-border bg-muted/30 px-3 py-2 text-[11px] text-muted-foreground">
            The CSV contains: <code>email</code>, <code>username</code>,{" "}
            <code>country</code>, <code>country_code</code>,{" "}
            <code>total_deposited_usd</code>, <code>has_deposited</code>,{" "}
            <code>created_at</code>. Export events are recorded in the
            admin audit log.
          </p>
        </div>

        <DialogFooter>
          <Button
            type="button"
            variant="ghost"
            onClick={() => setOpen(false)}
            disabled={downloading}
          >
            Cancel
          </Button>
          <Button type="button" onClick={submit} disabled={downloading}>
            {downloading ? "Preparing…" : "Download CSV"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
