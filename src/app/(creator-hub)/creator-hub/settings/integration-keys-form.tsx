"use client";

import { useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import {
  Eye,
  EyeOff,
  Save,
  Trash2,
  Tv,
  Twitter,
  type LucideIcon,
} from "lucide-react";

import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Spinner } from "@/components/ux";
import { formatRelative } from "@/lib/utils/format";
import type { IntegrationKeyRowData } from "@/lib/integration-settings";

import { saveIntegrationKey, removeIntegrationKey } from "./actions";

/**
 * Client-safe view of one integration key — the shared masked row shape from
 * `@/lib/integration-settings`. Carries ONLY masked metadata (set/unset,
 * last-4 preview, last-updated, resolved editor name); never the raw secret
 * (the secret is stored server-side and never sent to the browser).
 */
export type IntegrationKeyRow = IntegrationKeyRowData;

/** Per-key icon. Falls back to a generic key glyph for unknown ids. */
const KEY_ICON: Record<string, LucideIcon> = {
  kick: Tv,
  twitter: Twitter,
};

/**
 * Creator-Hub integration API-key manager. One card per key (Kick, Twitter),
 * each with a masked "set / not set" state, last-updated line, a secret input
 * with show/hide, a Save action, and a Clear action when a key is configured.
 *
 * The raw key is write-only from the UI's perspective: it's submitted to a
 * server action and never read back. Server responses return the refreshed
 * masked statuses, which replace local state. Follows the house client error
 * pattern (try/catch → sonner) + shadcn primitives.
 */
export function IntegrationKeysForm({ rows }: { rows: IntegrationKeyRow[] }) {
  const router = useRouter();
  const [statuses, setStatuses] = useState<IntegrationKeyRow[]>(rows);

  return (
    <div className="grid gap-4 lg:grid-cols-2">
      {statuses.map((row) => (
        <IntegrationKeyCard
          key={row.id}
          row={row}
          onStatuses={(next) => {
            // Replace the whole list from the server's masked response so
            // every card reflects the latest persisted state.
            const byId = new Map(next.map((s) => [s.id, s]));
            setStatuses((prev) =>
              prev.map((p) => byId.get(p.id) ?? p),
            );
            router.refresh();
          }}
        />
      ))}
    </div>
  );
}

function IntegrationKeyCard({
  row,
  onStatuses,
}: {
  row: IntegrationKeyRow;
  onStatuses: (next: IntegrationKeyRow[]) => void;
}) {
  const [value, setValue] = useState("");
  const [reveal, setReveal] = useState(false);
  const [pending, startTransition] = useTransition();
  const [action, setAction] = useState<"save" | "clear" | null>(null);

  const Icon = KEY_ICON[row.id] ?? Save;

  function handleSave() {
    const trimmed = value.trim();
    if (trimmed.length === 0) {
      toast.error("Enter a key before saving.");
      return;
    }
    setAction("save");
    startTransition(async () => {
      try {
        const res = await saveIntegrationKey(row.id, trimmed);
        if (!res.success) {
          toast.error(res.error);
          return;
        }
        toast.success(`${row.label} saved.`);
        setValue("");
        setReveal(false);
        onStatuses(res.statuses);
      } catch (err) {
        toast.error(
          err instanceof Error ? err.message : "Failed to save the key.",
        );
      } finally {
        setAction(null);
      }
    });
  }

  function handleClear() {
    setAction("clear");
    startTransition(async () => {
      try {
        const res = await removeIntegrationKey(row.id);
        if (!res.success) {
          toast.error(res.error);
          return;
        }
        toast.success(`${row.label} cleared.`);
        setValue("");
        setReveal(false);
        onStatuses(res.statuses);
      } catch (err) {
        toast.error(
          err instanceof Error ? err.message : "Failed to clear the key.",
        );
      } finally {
        setAction(null);
      }
    });
  }

  const inputId = `integration-key-${row.id}`;

  return (
    <Card className="overflow-hidden">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <span className="flex size-7 shrink-0 items-center justify-center rounded-lg bg-cyan-500/15 text-cyan-600 ring-1 ring-inset ring-cyan-500/30 dark:text-cyan-400">
            <Icon className="size-4" />
          </span>
          <span className="min-w-0">
            <span className="block truncate">{row.label}</span>
            <span className="block truncate text-xs font-normal text-muted-foreground">
              {row.provider}
            </span>
          </span>
          <span className="ml-auto shrink-0">
            {row.isSet ? (
              <Badge
                variant="outline"
                className="border-emerald-500/30 bg-emerald-500/10 text-[10px] font-medium text-emerald-600 dark:text-emerald-400"
              >
                Set
              </Badge>
            ) : (
              <Badge
                variant="outline"
                className="border-amber-500/30 bg-amber-500/10 text-[10px] font-medium text-amber-600 dark:text-amber-400"
              >
                Not set
              </Badge>
            )}
          </span>
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        {/* Current state: masked preview + last-updated. No raw secret. */}
        <div className="rounded-lg border bg-card/50 px-3 py-2 text-xs">
          {row.isSet ? (
            <div className="space-y-0.5">
              <div className="flex items-center justify-between gap-2">
                <span className="text-muted-foreground">Stored key</span>
                <span className="truncate font-mono text-foreground">
                  {row.maskedPreview}
                </span>
              </div>
              {row.lastUpdated && (
                <div className="flex items-center justify-between gap-2">
                  <span className="text-muted-foreground">Last updated</span>
                  <span className="truncate text-muted-foreground">
                    {formatRelative(row.lastUpdated)}
                    {row.updatedByName ? ` · ${row.updatedByName}` : ""}
                  </span>
                </div>
              )}
            </div>
          ) : (
            <span className="text-muted-foreground">
              No key configured. Paste a key below to enable {row.label} lookups.
            </span>
          )}
        </div>

        {/* Secret input + show/hide. Write-only: the stored value is never
            loaded back into this field. */}
        <div className="space-y-1.5">
          <Label htmlFor={inputId} className="text-xs">
            {row.isSet ? "Replace key" : "Set key"}
          </Label>
          <div className="flex items-center gap-2">
            <Input
              id={inputId}
              type={reveal ? "text" : "password"}
              value={value}
              onChange={(e) => setValue(e.target.value)}
              placeholder="Paste RapidAPI key"
              autoComplete="off"
              spellCheck={false}
              disabled={pending}
              className="font-mono"
            />
            <Button
              type="button"
              variant="outline"
              size="icon"
              className="shrink-0"
              disabled={pending}
              aria-label={reveal ? "Hide key" : "Show key"}
              onClick={() => setReveal((r) => !r)}
            >
              {reveal ? (
                <EyeOff className="size-4" />
              ) : (
                <Eye className="size-4" />
              )}
            </Button>
          </div>
          <p className="text-[11px] text-muted-foreground">
            Sent over a server action and stored server-side only — it never
            comes back to your browser.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <Button
            type="button"
            onClick={handleSave}
            disabled={pending || value.trim().length === 0}
            className="gap-1.5"
          >
            {pending && action === "save" ? (
              <Spinner size={14} />
            ) : (
              <Save className="size-4" />
            )}
            Save
          </Button>
          {row.isSet && (
            <Button
              type="button"
              variant="outline"
              onClick={handleClear}
              disabled={pending}
              className="gap-1.5 text-rose-600 hover:text-rose-600 dark:text-rose-400 dark:hover:text-rose-400"
            >
              {pending && action === "clear" ? (
                <Spinner size={14} />
              ) : (
                <Trash2 className="size-4" />
              )}
              Clear
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}
