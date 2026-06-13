"use client";

import { useState, useTransition } from "react";
import Link from "next/link";
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
import { upsertSiteConfig, deleteSiteConfig } from "./actions";
import type { SiteConfigRow } from "@/lib/queries/security";
import { CloudRain, Trash2, Plus } from "lucide-react";
import { CollapsibleSecuritySection } from "./collapsible-security-section";
import { EmptyState } from "@/components/empty-state";

function isBoolean(value: string) {
  return value === "true" || value === "false";
}

export function SecurityContent({
  config,
  rainConfigMoved = false,
}: {
  config: SiteConfigRow[];
  rainConfigMoved?: boolean;
}) {
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  const [newKey, setNewKey] = useState("");
  const [newValue, setNewValue] = useState("");
  const [newDescription, setNewDescription] = useState("");

  function handleUpdate(row: SiteConfigRow, updates: Partial<Pick<SiteConfigRow, "value" | "description">>) {
    startTransition(async () => {
      try {
        await upsertSiteConfig(
          row.key,
          updates.value ?? row.value,
          updates.description !== undefined ? updates.description : row.description
        );
        toast.success("Setting updated");
        router.refresh();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Failed");
      }
    });
  }

  function handleDelete(key: string) {
    if (!confirm(`Delete config key "${key}"?`)) return;
    startTransition(async () => {
      try {
        await deleteSiteConfig(key);
        toast.success("Setting deleted");
        router.refresh();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Failed");
      }
    });
  }

  function handleAdd() {
    if (!newKey.trim()) {
      toast.error("Key is required");
      return;
    }
    startTransition(async () => {
      try {
        await upsertSiteConfig(newKey, newValue, newDescription || null);
        toast.success("Setting added");
        setNewKey("");
        setNewValue("");
        setNewDescription("");
        router.refresh();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Failed");
      }
    });
  }

  return (
    <div className="space-y-6">
      <div className="space-y-3">
        {rainConfigMoved && (
          <div className="flex items-center gap-2 rounded-md border border-blue-500/40 bg-blue-500/10 p-3 text-xs text-blue-600 dark:text-blue-400">
            <CloudRain className="size-4 shrink-0" />
            <span>
              Rain configuration moved to{" "}
              <Link
                href="/rain?tab=config"
                className="font-medium underline-offset-2 hover:underline"
              >
                /rain?tab=config
              </Link>
              . Keys <code>rain_base_amount_usd</code>,{" "}
              <code>rain_default_base_amount</code>,{" "}
              <code>rain_duration_minutes</code>, and{" "}
              <code>rain_duration_ms</code> are managed there to avoid
              double-editing.
            </span>
          </div>
        )}
        <div className="rounded-md border overflow-x-auto">
          <Table>
            <TableHeader>
              <TableRow>
                <TableHead>Key</TableHead>
                <TableHead>Value</TableHead>
                <TableHead>Description</TableHead>
                <TableHead className="w-[80px]" />
              </TableRow>
            </TableHeader>
            <TableBody>
              {config.length === 0 && (
                <TableRow className="hover:bg-transparent">
                  <TableCell colSpan={4} className="p-0">
                    <EmptyState
                      icon={Plus}
                      title="No configuration entries"
                      description="Add a config key below to control site behaviour."
                      compact
                    />
                  </TableCell>
                </TableRow>
              )}
              {config.map((row) => (
                <TableRow key={row.key}>
                  <TableCell className="font-mono text-sm">{row.key}</TableCell>
                  <TableCell>
                    {isBoolean(row.value) ? (
                      <Switch
                        checked={row.value === "true"}
                        onCheckedChange={() =>
                          handleUpdate(row, { value: row.value === "true" ? "false" : "true" })
                        }
                        disabled={isPending}
                      />
                    ) : (
                      <EditableText
                        value={row.value}
                        disabled={isPending}
                        onSave={(val) => handleUpdate(row, { value: val })}
                        mono
                      />
                    )}
                  </TableCell>
                  <TableCell>
                    <EditableText
                      value={row.description || ""}
                      disabled={isPending}
                      onSave={(val) => handleUpdate(row, { description: val || null })}
                      placeholder="Add description"
                    />
                  </TableCell>
                  <TableCell>
                    <Button
                      variant="ghost"
                      size="icon"
                      disabled={isPending}
                      onClick={() => handleDelete(row.key)}
                    >
                      <Trash2 className="h-4 w-4 text-destructive" />
                    </Button>
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </div>

      <CollapsibleSecuritySection icon={Plus} title="Add Configuration" defaultOpen={false}>
        <div className="rounded-md border p-4">
          <div className="grid grid-cols-1 gap-4 sm:grid-cols-4">
            <div className="space-y-1">
              <Label>Key</Label>
              <Input
                placeholder="e.g. feature_enabled"
                value={newKey}
                onChange={(e) => setNewKey(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label>Value</Label>
              <Input
                placeholder="e.g. true"
                value={newValue}
                onChange={(e) => setNewValue(e.target.value)}
              />
            </div>
            <div className="space-y-1">
              <Label>Description</Label>
              <Input
                placeholder="Optional"
                value={newDescription}
                onChange={(e) => setNewDescription(e.target.value)}
              />
            </div>
            <div className="flex items-end">
              <Button
                onClick={handleAdd}
                disabled={isPending}
                className="w-full sm:w-auto"
              >
                <Plus className="size-4" />
                Add
              </Button>
            </div>
          </div>
        </div>
      </CollapsibleSecuritySection>
    </div>
  );
}

function EditableText({
  value,
  disabled,
  onSave,
  mono,
  placeholder = "empty",
}: {
  value: string;
  disabled: boolean;
  onSave: (val: string) => void;
  mono?: boolean;
  placeholder?: string;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);

  if (!editing) {
    return (
      <span
        className={`cursor-pointer text-sm hover:underline ${mono ? "font-mono" : "text-muted-foreground"}`}
        onClick={() => {
          setDraft(value);
          setEditing(true);
        }}
      >
        {value || <span className="text-muted-foreground italic">{placeholder}</span>}
      </span>
    );
  }

  return (
    <form
      className="flex items-center gap-2"
      onSubmit={(e) => {
        e.preventDefault();
        onSave(draft);
        setEditing(false);
      }}
    >
      <Input
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        disabled={disabled}
        className="h-8"
        autoFocus
      />
      <Button type="submit" size="sm" disabled={disabled}>
        Save
      </Button>
      <Button
        type="button"
        variant="ghost"
        size="sm"
        onClick={() => setEditing(false)}
      >
        Cancel
      </Button>
    </form>
  );
}
