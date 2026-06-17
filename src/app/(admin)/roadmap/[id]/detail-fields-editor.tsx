"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Plus, Trash2, Check, X, Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ux";
import {
  addRoadmapDetailField,
  removeRoadmapDetailField,
  updateRoadmapDetailField,
} from "../actions";
import type { RoadmapDetailField } from "../types";

export function DetailFieldsEditor({
  itemId,
  fields,
}: {
  itemId: string;
  fields: RoadmapDetailField[];
}) {
  const router = useRouter();
  const [busy, setBusy] = React.useState(false);

  // New-row inputs.
  const [newLabel, setNewLabel] = React.useState("");
  const [newValue, setNewValue] = React.useState("");

  // Inline edit state.
  const [editId, setEditId] = React.useState<string | null>(null);
  const [editLabel, setEditLabel] = React.useState("");
  const [editValue, setEditValue] = React.useState("");

  async function add() {
    const label = newLabel.trim();
    if (!label) {
      toast.error("Label is required");
      return;
    }
    setBusy(true);
    try {
      const r = await addRoadmapDetailField({
        itemId,
        label,
        value: newValue.trim(),
      });
      if (!r.success) {
        toast.error(r.error);
        return;
      }
      setNewLabel("");
      setNewValue("");
      router.refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to add field");
    } finally {
      setBusy(false);
    }
  }

  async function saveEdit() {
    if (!editId) return;
    const label = editLabel.trim();
    if (!label) {
      toast.error("Label is required");
      return;
    }
    setBusy(true);
    try {
      const r = await updateRoadmapDetailField({
        id: editId,
        label,
        value: editValue.trim(),
      });
      if (!r.success) {
        toast.error(r.error);
        return;
      }
      setEditId(null);
      router.refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to update field");
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    setBusy(true);
    try {
      const r = await removeRoadmapDetailField(id);
      if (!r.success) {
        toast.error(r.error);
        return;
      }
      router.refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to remove field");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-2xl border bg-card p-4">
      {fields.length > 0 ? (
        <ul className="divide-y divide-border/60">
          {fields.map((f) => (
            <li key={f.id} className="py-2 first:pt-0 last:pb-0">
              {editId === f.id ? (
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                  <Input
                    value={editLabel}
                    onChange={(e) => setEditLabel(e.target.value)}
                    placeholder="Label"
                    className="sm:w-48"
                    maxLength={80}
                  />
                  <Input
                    value={editValue}
                    onChange={(e) => setEditValue(e.target.value)}
                    placeholder="Value"
                    className="flex-1"
                    maxLength={500}
                  />
                  <div className="flex items-center gap-1">
                    <Button
                      size="icon"
                      variant="ghost"
                      onClick={saveEdit}
                      disabled={busy}
                      aria-label="Save field"
                    >
                      <Check className="size-4" />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      onClick={() => setEditId(null)}
                      disabled={busy}
                      aria-label="Cancel edit"
                    >
                      <X className="size-4" />
                    </Button>
                  </div>
                </div>
              ) : (
                <div className="group flex items-center gap-3">
                  <span className="w-40 shrink-0 truncate text-xs font-medium uppercase tracking-wide text-muted-foreground">
                    {f.label}
                  </span>
                  <span className="flex-1 break-words text-sm text-foreground/90">
                    {f.value || (
                      <span className="text-muted-foreground/60">—</span>
                    )}
                  </span>
                  <div className="flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                    <Button
                      size="icon"
                      variant="ghost"
                      onClick={() => {
                        setEditId(f.id);
                        setEditLabel(f.label);
                        setEditValue(f.value);
                      }}
                      aria-label="Edit field"
                    >
                      <Pencil className="size-3.5" />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      onClick={() => remove(f.id)}
                      disabled={busy}
                      aria-label="Remove field"
                      className="text-rose-500 hover:bg-rose-500/10 hover:text-rose-500"
                    >
                      <Trash2 className="size-3.5" />
                    </Button>
                  </div>
                </div>
              )}
            </li>
          ))}
        </ul>
      ) : (
        <p className="text-sm text-muted-foreground">
          No detail fields yet. Add things like “Release date”, “Edge”, “Owner”.
        </p>
      )}

      <div className="mt-3 flex flex-col gap-2 border-t border-border/60 pt-3 sm:flex-row sm:items-center">
        <Input
          value={newLabel}
          onChange={(e) => setNewLabel(e.target.value)}
          placeholder="Label (e.g. Release date)"
          className="sm:w-48"
          maxLength={80}
        />
        <Input
          value={newValue}
          onChange={(e) => setNewValue(e.target.value)}
          placeholder="Value"
          className="flex-1"
          maxLength={500}
          onKeyDown={(e) => {
            if (e.key === "Enter") add();
          }}
        />
        <Button size="sm" onClick={add} disabled={busy}>
          {busy ? (
            <Spinner size={14} className="text-current" />
          ) : (
            <Plus className="size-4" />
          )}
          Add
        </Button>
      </div>
    </div>
  );
}
