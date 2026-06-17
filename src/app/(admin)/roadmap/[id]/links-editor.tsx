"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Plus, Trash2, Check, X, Pencil, ExternalLink } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ux";
import { addRoadmapLink, removeRoadmapLink, updateRoadmapLink } from "../actions";
import type { RoadmapLink } from "../types";

function isValidUrl(v: string): boolean {
  try {
    new URL(v);
    return true;
  } catch {
    return false;
  }
}

export function LinksEditor({
  itemId,
  links,
}: {
  itemId: string;
  links: RoadmapLink[];
}) {
  const router = useRouter();
  const [busy, setBusy] = React.useState(false);

  const [newLabel, setNewLabel] = React.useState("");
  const [newUrl, setNewUrl] = React.useState("");

  const [editId, setEditId] = React.useState<string | null>(null);
  const [editLabel, setEditLabel] = React.useState("");
  const [editUrl, setEditUrl] = React.useState("");

  async function add() {
    const label = newLabel.trim();
    const url = newUrl.trim();
    if (!label) {
      toast.error("Label is required");
      return;
    }
    if (!isValidUrl(url)) {
      toast.error("Enter a valid URL (include https://)");
      return;
    }
    setBusy(true);
    try {
      const r = await addRoadmapLink({ itemId, label, url });
      if (!r.success) {
        toast.error(r.error);
        return;
      }
      setNewLabel("");
      setNewUrl("");
      router.refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to add link");
    } finally {
      setBusy(false);
    }
  }

  async function saveEdit() {
    if (!editId) return;
    const label = editLabel.trim();
    const url = editUrl.trim();
    if (!label) {
      toast.error("Label is required");
      return;
    }
    if (!isValidUrl(url)) {
      toast.error("Enter a valid URL (include https://)");
      return;
    }
    setBusy(true);
    try {
      const r = await updateRoadmapLink({ id: editId, label, url });
      if (!r.success) {
        toast.error(r.error);
        return;
      }
      setEditId(null);
      router.refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to update link");
    } finally {
      setBusy(false);
    }
  }

  async function remove(id: string) {
    setBusy(true);
    try {
      const r = await removeRoadmapLink(id);
      if (!r.success) {
        toast.error(r.error);
        return;
      }
      router.refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to remove link");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="rounded-2xl border bg-card p-4">
      {links.length > 0 ? (
        <ul className="divide-y divide-border/60">
          {links.map((l) => (
            <li key={l.id} className="py-2 first:pt-0 last:pb-0">
              {editId === l.id ? (
                <div className="flex flex-col gap-2 sm:flex-row sm:items-center">
                  <Input
                    value={editLabel}
                    onChange={(e) => setEditLabel(e.target.value)}
                    placeholder="Label"
                    className="sm:w-48"
                    maxLength={120}
                  />
                  <Input
                    value={editUrl}
                    onChange={(e) => setEditUrl(e.target.value)}
                    placeholder="https://…"
                    className="flex-1"
                    maxLength={2000}
                  />
                  <div className="flex items-center gap-1">
                    <Button
                      size="icon"
                      variant="ghost"
                      onClick={saveEdit}
                      disabled={busy}
                      aria-label="Save link"
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
                  <a
                    href={l.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="flex min-w-0 flex-1 items-center gap-2 text-sm text-primary hover:underline"
                  >
                    <ExternalLink className="size-3.5 shrink-0" aria-hidden />
                    <span className="truncate font-medium">{l.label}</span>
                    <span className="truncate text-xs text-muted-foreground">
                      {l.url}
                    </span>
                  </a>
                  <div className="flex items-center gap-1 opacity-0 transition-opacity group-hover:opacity-100">
                    <Button
                      size="icon"
                      variant="ghost"
                      onClick={() => {
                        setEditId(l.id);
                        setEditLabel(l.label);
                        setEditUrl(l.url);
                      }}
                      aria-label="Edit link"
                    >
                      <Pencil className="size-3.5" />
                    </Button>
                    <Button
                      size="icon"
                      variant="ghost"
                      onClick={() => remove(l.id)}
                      disabled={busy}
                      aria-label="Remove link"
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
          No links yet. Add a Figma board, doc, or reference.
        </p>
      )}

      <div className="mt-3 flex flex-col gap-2 border-t border-border/60 pt-3 sm:flex-row sm:items-center">
        <Input
          value={newLabel}
          onChange={(e) => setNewLabel(e.target.value)}
          placeholder="Label (e.g. Figma)"
          className="sm:w-48"
          maxLength={120}
        />
        <Input
          value={newUrl}
          onChange={(e) => setNewUrl(e.target.value)}
          placeholder="https://…"
          className="flex-1"
          maxLength={2000}
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
