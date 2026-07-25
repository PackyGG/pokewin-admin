"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { RotateCcw } from "lucide-react";
import { toast } from "sonner";

import { Checkbox } from "@/components/ui/checkbox";
import { cn } from "@/lib/utils";
import { resetNotificationPref, setNotificationPref } from "../actions";

/**
 * The per-event delivery matrix.
 *
 * A row you've never touched shows the shipped DEFAULT and stores nothing —
 * which is what makes a newly added event kind opt-OUT for everyone rather than
 * silently off. Once you change anything, that row is yours and defaults stop
 * applying to it; "Reset" deletes the override and puts it back on the default.
 *
 * The Discord / Telegram columns are disabled when that channel isn't verified,
 * because ticking them would promise a delivery that can't happen.
 */

export type PrefRow = {
  kind: string;
  label: string;
  description: string;
  inApp: boolean;
  discord: boolean;
  telegram: boolean;
  /** True when this row is still on the shipped default (no stored override). */
  isDefault: boolean;
};

export function NotificationPrefs({
  rows,
  discordReady,
  telegramReady,
}: {
  rows: PrefRow[];
  discordReady: boolean;
  telegramReady: boolean;
}) {
  const router = useRouter();
  const [pending, setPending] = React.useState<string | null>(null);
  // Optimistic local copy so a click feels instant; the server refresh
  // reconciles it.
  const [local, setLocal] = React.useState(rows);

  React.useEffect(() => setLocal(rows), [rows]);

  async function update(row: PrefRow, patch: Partial<PrefRow>) {
    const next = { ...row, ...patch, isDefault: false };
    setLocal((prev) => prev.map((r) => (r.kind === row.kind ? next : r)));
    setPending(row.kind);
    try {
      await setNotificationPref({
        kind: row.kind,
        inApp: next.inApp,
        discord: next.discord,
        telegram: next.telegram,
      });
      router.refresh();
    } catch (err) {
      setLocal(rows);
      toast.error(err instanceof Error ? err.message : "Could not save");
    } finally {
      setPending(null);
    }
  }

  async function reset(row: PrefRow) {
    setPending(row.kind);
    try {
      await resetNotificationPref({ kind: row.kind });
      toast.success("Back to the default");
      router.refresh();
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Could not reset");
    } finally {
      setPending(null);
    }
  }

  return (
    <div className="overflow-hidden rounded-xl border border-border/60 bg-card">
      <div className="hidden items-center gap-3 border-b border-border/60 px-4 py-2 text-[10px] font-semibold uppercase tracking-wide text-muted-foreground sm:flex">
        <span className="min-w-0 flex-1">Event</span>
        <span className="w-14 text-center">In app</span>
        <span className="w-14 text-center">Discord</span>
        <span className="w-14 text-center">Telegram</span>
        <span className="w-8" />
      </div>

      <ul className="divide-y divide-border/60">
        {local.map((row) => (
          <li
            key={row.kind}
            className={cn(
              "flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:gap-3",
              pending === row.kind && "opacity-60",
            )}
          >
            <span className="min-w-0 flex-1">
              <span className="block text-sm font-medium">{row.label}</span>
              <span className="block text-[11px] text-muted-foreground">
                {row.description}
              </span>
            </span>

            <span className="flex items-center gap-6 sm:gap-0">
              <Cell
                label="In app"
                checked={row.inApp}
                disabled={pending !== null}
                onChange={(checked) => update(row, { inApp: checked })}
              />
              <Cell
                label="Discord"
                checked={row.discord}
                disabled={pending !== null || !discordReady}
                onChange={(checked) => update(row, { discord: checked })}
              />
              <Cell
                label="Telegram"
                checked={row.telegram}
                disabled={pending !== null || !telegramReady}
                onChange={(checked) => update(row, { telegram: checked })}
              />
            </span>

            <span className="w-8 shrink-0 text-right">
              {!row.isDefault && (
                <button
                  type="button"
                  title="Back to the default"
                  aria-label={`Reset ${row.label}`}
                  disabled={pending !== null}
                  onClick={() => reset(row)}
                  className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground disabled:opacity-40"
                >
                  <RotateCcw className="size-3.5" />
                </button>
              )}
            </span>
          </li>
        ))}
      </ul>

      {(!discordReady || !telegramReady) && (
        <p className="border-t border-border/60 px-4 py-2.5 text-[11px] text-muted-foreground">
          {!discordReady && !telegramReady
            ? "Verify a Discord or Telegram channel above to switch those columns on."
            : !discordReady
              ? "Verify your Discord channel above to switch that column on."
              : "Verify your Telegram channel above to switch that column on."}
        </p>
      )}
    </div>
  );
}

function Cell({
  label,
  checked,
  disabled,
  onChange,
}: {
  label: string;
  checked: boolean;
  disabled: boolean;
  onChange: (checked: boolean) => void;
}) {
  return (
    <span className="flex w-14 flex-col items-center gap-1">
      <Checkbox
        checked={checked}
        disabled={disabled}
        onCheckedChange={(value) => onChange(value === true)}
        aria-label={label}
      />
      <span className="text-[9px] uppercase tracking-wide text-muted-foreground sm:hidden">
        {label}
      </span>
    </span>
  );
}
