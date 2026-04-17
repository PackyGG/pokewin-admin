"use client";

import * as React from "react";
import { toast } from "sonner";
import { useTheme } from "next-themes";
import { Sun, Moon, Monitor, Clock, CalendarDays } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectLabel,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import { cn } from "@/lib/utils";
import {
  DATE_FORMAT_VALUES,
  type AdminPreferences,
  isValidTimezone,
} from "@/lib/admin-preferences-types";
import {
  TIMEZONE_GROUPS,
  formatClockInZone,
  timezoneLabel,
} from "@/lib/timezones";
import { useTimezoneContext } from "@/components/timezone-provider";
import { formatWithPattern } from "@/lib/utils/format";
import { updatePreferences } from "./preferences-actions";

// ---------------------------------------------------------------------------
// Preferences form
// ---------------------------------------------------------------------------
//
// Theme / timezone / date format editor that saves to the admin's row
// via updatePreferences. The TimezoneProvider in the admin layout is
// updated in the same tick so downstream hooks (useFormatDateTime etc.)
// re-render without a navigation. The page URL is revalidated inside
// updatePreferences so a hard refresh also reflects the new values.
// ---------------------------------------------------------------------------

const DATE_FORMAT_LABELS: Record<
  NonNullable<AdminPreferences["dateFormat"]>,
  string
> = {
  "MMM d, yyyy": "Month d, yyyy",
  "dd/MM/yyyy": "dd/MM/yyyy",
  "yyyy-MM-dd": "yyyy-MM-dd (ISO)",
};

type ThemeValue = NonNullable<AdminPreferences["theme"]>;

function ThemeRadio({
  value,
  active,
  onSelect,
  icon: Icon,
  label,
  hint,
}: {
  value: ThemeValue;
  active: string;
  onSelect: (v: ThemeValue) => void;
  icon: React.ComponentType<{ className?: string }>;
  label: string;
  hint: string;
}) {
  const selected = active === value;
  return (
    <button
      type="button"
      onClick={() => onSelect(value)}
      className={cn(
        "group flex flex-col gap-2 rounded-lg border px-4 py-3 text-left transition-colors",
        "hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        selected
          ? "border-primary/60 bg-primary/5 ring-1 ring-primary/30"
          : "border-border",
      )}
      aria-pressed={selected}
    >
      <div className="flex items-center gap-2">
        <Icon className="size-4 text-muted-foreground" />
        <span className="text-sm font-medium">{label}</span>
      </div>
      <span className="text-xs text-muted-foreground">{hint}</span>
    </button>
  );
}

export function PreferencesForm({
  initial,
  profileFieldsAvailable,
}: {
  initial: AdminPreferences;
  /** Same flag `profile-form.tsx` uses to gate controls pre-migration. */
  profileFieldsAvailable: boolean;
}) {
  const { setTheme } = useTheme();
  const tzCtx = useTimezoneContext();

  const [theme, setThemeLocal] = React.useState<ThemeValue>(initial.theme);
  const [timezone, setTimezoneLocal] = React.useState<string | null>(
    initial.timezone,
  );
  const [customTimezone, setCustomTimezone] = React.useState<string>("");
  const [dateFormat, setDateFormatLocal] = React.useState<
    AdminPreferences["dateFormat"] | undefined
  >(initial.dateFormat);
  const [saving, setSaving] = React.useState(false);

  // Ticking clock so the "current time in X" preview updates live. 30s
  // is plenty — the preview shows HH:mm, so sub-minute updates are noise.
  //
  // CRITICAL: initial state is `null` instead of `new Date()`. Seeding
  // with Date.now() at render time would run on the server during SSR
  // and again on the client during hydration with a slightly different
  // time; if the two instants straddle a minute boundary, the HH:mm
  // preview differs between SSR and hydration output and React 19
  // throws a hydration error ("client-side exception"). We instead
  // render a placeholder until the post-mount effect lands the first
  // Date, then tick every 30s.
  const [now, setNow] = React.useState<Date | null>(null);
  React.useEffect(() => {
    setNow(new Date());
    const id = setInterval(() => setNow(new Date()), 30_000);
    return () => clearInterval(id);
  }, []);

  // The effective zone is the explicit pick OR, when null, the browser
  // zone from the provider (which resolved it on mount).
  const effectiveZone = timezone ?? tzCtx.timezone;
  const clock = now ? formatClockInZone(now, effectiveZone) : "—";

  const preview = now
    ? dateFormat
      ? formatWithPattern(now, `${dateFormat} HH:mm`, effectiveZone)
      : formatWithPattern(now, "MMM d, yyyy HH:mm", effectiveZone)
    : "—";

  // The Select needs a concrete string — use a sentinel for "detect from
  // browser" because null isn't a valid <option value>.
  const DETECT_SENTINEL = "__detect__";
  const CUSTOM_SENTINEL = "__custom__";
  const selectValue =
    timezone === null
      ? DETECT_SENTINEL
      : TIMEZONE_GROUPS.some((g) => g.zones.some((z) => z.value === timezone))
        ? timezone
        : CUSTOM_SENTINEL;

  // Dirty check so the Save button only lights up when there's something
  // to persist. Compares against the initial snapshot, not the provider —
  // the provider may have been updated by the header dropdown in the
  // meantime, which is fine (we don't re-submit those values on save).
  const dirty =
    theme !== initial.theme ||
    timezone !== initial.timezone ||
    dateFormat !== initial.dateFormat;

  async function handleSave(e: React.FormEvent) {
    e.preventDefault();

    // Custom-timezone validation: if the user left the text field blank
    // after selecting "Custom", refuse to save — silently persisting the
    // previous value would be surprising.
    if (selectValue === CUSTOM_SENTINEL) {
      const candidate = customTimezone.trim();
      if (!candidate) {
        toast.error("Enter an IANA timezone (e.g. Europe/Berlin)");
        return;
      }
      if (!isValidTimezone(candidate)) {
        toast.error("Unknown IANA timezone");
        return;
      }
    }

    setSaving(true);
    try {
      await updatePreferences({
        theme,
        timezone,
        dateFormat,
      });

      // Propagate into the existing providers so the rest of the UI
      // re-renders without a full reload.
      setTheme(theme);
      tzCtx.setTimezone(timezone);
      tzCtx.setDateFormat(dateFormat);

      toast.success("Preferences saved");
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Could not save preferences",
      );
    } finally {
      setSaving(false);
    }
  }

  return (
    <form className="space-y-6" onSubmit={handleSave}>
      {/* Theme */}
      <div className="space-y-3">
        <div>
          <Label className="text-sm font-medium">Theme</Label>
          <p className="text-xs text-muted-foreground">
            Dark is the project default. Pick System to follow your OS.
          </p>
        </div>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          <ThemeRadio
            value="light"
            active={theme}
            onSelect={setThemeLocal}
            icon={Sun}
            label="Light"
            hint="Bright mode"
          />
          <ThemeRadio
            value="dark"
            active={theme}
            onSelect={setThemeLocal}
            icon={Moon}
            label="Dark"
            hint="Low-light mode"
          />
          <ThemeRadio
            value="system"
            active={theme}
            onSelect={setThemeLocal}
            icon={Monitor}
            label="System"
            hint="Match your OS"
          />
        </div>
      </div>

      {/* Timezone */}
      <div className="space-y-3">
        <div>
          <Label className="text-sm font-medium">Timezone</Label>
          <p className="text-xs text-muted-foreground">
            Dates across the admin panel render in this zone. Defaults to
            your browser zone when unset.
          </p>
        </div>
        <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
          <Select
            value={selectValue}
            onValueChange={(v) => {
              if (v === DETECT_SENTINEL) {
                setTimezoneLocal(null);
              } else if (v === CUSTOM_SENTINEL) {
                // Leave `timezone` at whatever was last set; the user
                // commits the custom string by typing + Save.
              } else {
                setTimezoneLocal(v);
              }
            }}
          >
            <SelectTrigger className="w-full sm:w-[320px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent className="max-h-[60vh]">
              <SelectGroup>
                <SelectItem value={DETECT_SENTINEL}>
                  <Clock className="size-4" />
                  Detect from browser
                </SelectItem>
                <SelectItem value={CUSTOM_SENTINEL}>Custom…</SelectItem>
              </SelectGroup>
              {TIMEZONE_GROUPS.map((group) => (
                <SelectGroup key={group.region}>
                  <SelectLabel>{group.region}</SelectLabel>
                  {group.zones.map((z) => (
                    <SelectItem key={z.value} value={z.value}>
                      {z.label} ({z.value})
                    </SelectItem>
                  ))}
                </SelectGroup>
              ))}
            </SelectContent>
          </Select>

          {/* Live "right now" preview in the chosen zone — invaluable for
              teams spanning timezones so the admin can sanity-check which
              zone they've picked before saving. */}
          <div className="flex items-center gap-2 rounded-lg border border-border bg-muted/30 px-3 py-1.5 text-xs">
            <Clock className="size-3.5 text-muted-foreground" />
            <span className="font-mono">{clock}</span>
            <span className="text-muted-foreground">
              in {timezoneLabel(effectiveZone)}
            </span>
          </div>
        </div>

        {selectValue === CUSTOM_SENTINEL && (
          <div className="space-y-1.5">
            <Label htmlFor="custom-timezone" className="text-xs">
              Custom IANA timezone
            </Label>
            <Input
              id="custom-timezone"
              placeholder="e.g. Europe/Berlin, Pacific/Auckland"
              value={customTimezone}
              onChange={(e) => setCustomTimezone(e.target.value)}
              onBlur={(e) => {
                // Validate + stage on blur so the preview updates without
                // waiting for Save. Invalid input leaves `timezone` alone.
                const v = e.target.value.trim();
                if (v && isValidTimezone(v)) setTimezoneLocal(v);
              }}
            />
            <p className="text-xs text-muted-foreground">
              Full IANA list:{" "}
              <a
                href="https://en.wikipedia.org/wiki/List_of_tz_database_time_zones"
                target="_blank"
                rel="noreferrer noopener"
                className="underline underline-offset-2 hover:text-foreground"
              >
                tz database
              </a>
            </p>
          </div>
        )}
      </div>

      {/* Date format */}
      <div className="space-y-3">
        <div>
          <Label className="text-sm font-medium">Date format</Label>
          <p className="text-xs text-muted-foreground">
            Controls how absolute timestamps render. Relative times
            (&ldquo;2 hours ago&rdquo;) are unaffected.
          </p>
        </div>
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
          {DATE_FORMAT_VALUES.map((v) => (
            <button
              type="button"
              key={v}
              onClick={() => setDateFormatLocal(v)}
              className={cn(
                "flex flex-col gap-1 rounded-lg border px-4 py-3 text-left transition-colors",
                "hover:bg-accent/40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                dateFormat === v
                  ? "border-primary/60 bg-primary/5 ring-1 ring-primary/30"
                  : "border-border",
              )}
              aria-pressed={dateFormat === v}
            >
              <div className="flex items-center gap-2">
                <CalendarDays className="size-4 text-muted-foreground" />
                <span className="text-sm font-medium">
                  {DATE_FORMAT_LABELS[v]}
                </span>
              </div>
              <span className="font-mono text-xs text-muted-foreground">
                {now ? formatWithPattern(now, v, effectiveZone) : "—"}
              </span>
            </button>
          ))}
        </div>
        <p className="text-xs text-muted-foreground">
          Current preview: <span className="font-mono">{preview}</span>
        </p>
      </div>

      <div className="flex items-center justify-end gap-2 border-t border-border pt-4">
        <Button
          type="submit"
          size="sm"
          disabled={saving || !dirty || !profileFieldsAvailable}
        >
          {saving ? "Saving..." : "Save preferences"}
        </Button>
      </div>
    </form>
  );
}
