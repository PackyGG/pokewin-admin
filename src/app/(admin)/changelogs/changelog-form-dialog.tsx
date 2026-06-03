"use client";

import * as React from "react";
import { Plus, Sparkles, Trash2, Wrench, Zap, AlertTriangle, Server } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";
import { cn } from "@/lib/utils";
import { Spinner } from "@/components/ux";
import {
  CHANGELOG_CATEGORIES,
  CHANGELOG_CHANGE_KINDS,
  type ChangelogCategory,
  type ChangelogChange,
  type ChangelogChangeKind,
  type ChangelogEntry,
} from "@/lib/changelog/types";

import { createChangelogEntry, updateChangelogEntry } from "./actions";

// ---------------------------------------------------------------------------
// Shared category / kind cosmetic config — kept in this client file so the
// dropdowns and the icons inside the dynamic rows draw from the same source
// of truth. Mirror only — the server enforces the canonical sets via Zod.
// ---------------------------------------------------------------------------

const CATEGORY_LABEL: Record<ChangelogCategory, string> = {
  feature: "Feature",
  improvement: "Improvement",
  fix: "Fix",
  breaking: "Breaking",
  infra: "Infra",
};

const CHANGE_KIND_LABEL: Record<ChangelogChangeKind, string> = {
  feature: "Feature",
  improvement: "Improvement",
  fix: "Fix",
  breaking: "Breaking",
  infra: "Infra",
};

const CHANGE_KIND_ICON: Record<ChangelogChangeKind, React.ElementType> = {
  feature: Sparkles,
  improvement: Zap,
  fix: Wrench,
  breaking: AlertTriangle,
  infra: Server,
};

// ---------------------------------------------------------------------------
// Editable change-row state
//
// Identified by a transient client-side id (NOT persisted) so the dynamic
// add/remove operations on the list keep stable React keys between renders.
// On submit the id is dropped before sending to the server action.
// ---------------------------------------------------------------------------

type EditableChange = {
  cid: string;
  kind: ChangelogChangeKind;
  text: string;
};

let cidCounter = 0;
function nextCid() {
  cidCounter += 1;
  return `c${cidCounter}`;
}

function emptyChangeRow(kind: ChangelogChangeKind = "feature"): EditableChange {
  return { cid: nextCid(), kind, text: "" };
}

function toEditableChanges(input: ChangelogChange[]): EditableChange[] {
  if (input.length === 0) return [emptyChangeRow()];
  return input.map((c) => ({ cid: nextCid(), kind: c.kind, text: c.text }));
}

// Format a JS Date into a `yyyy-MM-dd` string for the native date input
// using the LOCAL wall-clock fields. Using toISOString() would shift back
// to UTC and could land on the previous day for negative offsets — the
// admin wants the date they typed, not a TZ-shifted version.
function toDateInputValue(d: Date): string {
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

// ---------------------------------------------------------------------------
// Form
// ---------------------------------------------------------------------------

type Mode =
  | { kind: "create" }
  | { kind: "edit"; entry: ChangelogEntry };

function ChangelogForm({
  mode,
  onDone,
}: {
  mode: Mode;
  onDone: () => void;
}) {
  const initial = mode.kind === "edit" ? mode.entry : null;

  const [publishedAt, setPublishedAt] = React.useState<string>(
    initial
      ? toDateInputValue(new Date(initial.publishedAt))
      : toDateInputValue(new Date()),
  );
  const [title, setTitle] = React.useState<string>(initial?.title ?? "");
  const [summary, setSummary] = React.useState<string>(initial?.summary ?? "");
  const [version, setVersion] = React.useState<string>(initial?.version ?? "");
  const [category, setCategory] = React.useState<ChangelogCategory>(
    initial?.category ?? "feature",
  );
  const [changes, setChanges] = React.useState<EditableChange[]>(
    initial ? toEditableChanges(initial.changes) : [emptyChangeRow()],
  );
  const [submitting, setSubmitting] = React.useState(false);

  function setChangeKind(cid: string, kind: ChangelogChangeKind) {
    setChanges((prev) =>
      prev.map((c) => (c.cid === cid ? { ...c, kind } : c)),
    );
  }

  function setChangeText(cid: string, text: string) {
    setChanges((prev) =>
      prev.map((c) => (c.cid === cid ? { ...c, text } : c)),
    );
  }

  function addChangeRow() {
    setChanges((prev) => [...prev, emptyChangeRow(category)]);
  }

  function removeChangeRow(cid: string) {
    setChanges((prev) => {
      const next = prev.filter((c) => c.cid !== cid);
      // Always keep at least one row visible so the user has somewhere
      // to type — the action also validates min 1 with non-empty text.
      return next.length === 0 ? [emptyChangeRow(category)] : next;
    });
  }

  async function handleSubmit(e: React.FormEvent<HTMLFormElement>) {
    e.preventDefault();
    if (submitting) return;
    setSubmitting(true);

    const trimmedChanges = changes
      .map((c) => ({ kind: c.kind, text: c.text.trim() }))
      .filter((c) => c.text.length > 0);

    const payload = {
      // Build a Date from the yyyy-MM-dd input. Native date input emits
      // the picked calendar day; constructing `new Date(value)` in JS
      // would interpret it as UTC midnight (off-by-one in negative
      // offsets), so we expand it to the LOCAL wall-clock midnight of
      // the chosen day — the date that the admin sees on their screen.
      publishedAt: (() => {
        const [yyyy, mm, dd] = publishedAt.split("-").map(Number);
        if (!yyyy || !mm || !dd) return new Date(publishedAt);
        return new Date(yyyy, mm - 1, dd, 0, 0, 0, 0);
      })(),
      title,
      summary,
      version: version.trim() || null,
      category,
      changes: trimmedChanges,
    };

    try {
      if (mode.kind === "create") {
        await createChangelogEntry(payload);
        toast.success("Changelog entry published");
      } else {
        await updateChangelogEntry(mode.entry.id, payload);
        toast.success("Changelog entry updated");
      }
      onDone();
    } catch (err) {
      toast.error(
        err instanceof Error ? err.message : "Could not save changelog entry",
      );
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <form id="changelog-form" onSubmit={handleSubmit} className="space-y-4">
      <div className="grid gap-3 sm:grid-cols-3">
        <div className="space-y-2 sm:col-span-1">
          <Label htmlFor="changelog-date">Published date</Label>
          <Input
            id="changelog-date"
            type="date"
            required
            value={publishedAt}
            onChange={(e) => setPublishedAt(e.target.value)}
          />
        </div>
        <div className="space-y-2 sm:col-span-1">
          <Label htmlFor="changelog-version">Version (optional)</Label>
          <Input
            id="changelog-version"
            value={version}
            placeholder="e.g. v2025.11"
            maxLength={60}
            onChange={(e) => setVersion(e.target.value)}
          />
        </div>
        <div className="space-y-2 sm:col-span-1">
          <Label htmlFor="changelog-category">Category</Label>
          <select
            id="changelog-category"
            value={category}
            onChange={(e) => setCategory(e.target.value as ChangelogCategory)}
            className="w-full rounded-md border border-input bg-background px-3 py-2 text-base sm:text-sm"
          >
            {CHANGELOG_CATEGORIES.map((c) => (
              <option key={c} value={c}>
                {CATEGORY_LABEL[c]}
              </option>
            ))}
          </select>
        </div>
      </div>

      <div className="space-y-2">
        <Label htmlFor="changelog-title">Title</Label>
        <Input
          id="changelog-title"
          required
          value={title}
          placeholder='e.g. "Sets overhaul"'
          maxLength={120}
          onChange={(e) => setTitle(e.target.value)}
        />
      </div>

      <div className="space-y-2">
        <Label htmlFor="changelog-summary">Summary</Label>
        <Textarea
          id="changelog-summary"
          required
          value={summary}
          placeholder="One-paragraph TL;DR for what shipped in this release."
          rows={3}
          maxLength={4000}
          onChange={(e) => setSummary(e.target.value)}
        />
      </div>

      <div className="space-y-2">
        <div className="flex items-center justify-between">
          <Label>Changes</Label>
          <Button
            type="button"
            size="sm"
            variant="outline"
            onClick={addChangeRow}
          >
            <Plus className="mr-1 size-3.5" />
            Add change
          </Button>
        </div>
        <div className="space-y-2">
          {changes.map((row) => {
            const Icon = CHANGE_KIND_ICON[row.kind];
            return (
              <div
                key={row.cid}
                className="flex items-start gap-2 rounded-md border border-border/60 bg-background p-2"
              >
                <div className="flex items-center gap-2 sm:w-44">
                  <Icon className="size-4 shrink-0 text-muted-foreground" />
                  <select
                    value={row.kind}
                    onChange={(e) =>
                      setChangeKind(
                        row.cid,
                        e.target.value as ChangelogChangeKind,
                      )
                    }
                    className="w-full rounded-md border border-input bg-background px-2 py-1.5 text-sm"
                    aria-label="Change kind"
                  >
                    {CHANGELOG_CHANGE_KINDS.map((k) => (
                      <option key={k} value={k}>
                        {CHANGE_KIND_LABEL[k]}
                      </option>
                    ))}
                  </select>
                </div>
                <Input
                  value={row.text}
                  placeholder="What changed?"
                  maxLength={500}
                  onChange={(e) => setChangeText(row.cid, e.target.value)}
                  className="flex-1"
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  className={cn(
                    "size-8 shrink-0 text-muted-foreground hover:text-rose-500",
                  )}
                  onClick={() => removeChangeRow(row.cid)}
                  aria-label="Remove change row"
                  title="Remove change row"
                >
                  <Trash2 className="size-4" />
                </Button>
              </div>
            );
          })}
        </div>
        <p className="text-xs text-muted-foreground">
          Empty rows are ignored on save. At least one non-empty row is
          required.
        </p>
      </div>

      <DialogFooter>
        <Button type="submit" disabled={submitting} className="w-full sm:w-auto">
          {submitting && <Spinner size={14} className="text-current" />}
          {submitting
            ? mode.kind === "create"
              ? "Publishing…"
              : "Saving…"
            : mode.kind === "create"
              ? "Publish entry"
              : "Save changes"}
        </Button>
      </DialogFooter>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Public components
// ---------------------------------------------------------------------------

export function NewChangelogEntryButton() {
  const [open, setOpen] = React.useState(false);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <Button size="sm">
            <Plus className="mr-1 size-4" />
            New entry
          </Button>
        }
      />
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Publish changelog entry</DialogTitle>
        </DialogHeader>
        <ChangelogForm mode={{ kind: "create" }} onDone={() => setOpen(false)} />
      </DialogContent>
    </Dialog>
  );
}

export function EditChangelogEntryButton({ entry }: { entry: ChangelogEntry }) {
  const [open, setOpen] = React.useState(false);

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <DialogTrigger
        render={
          <Button size="sm" variant="ghost">
            Edit
          </Button>
        }
      />
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Edit changelog entry</DialogTitle>
        </DialogHeader>
        <ChangelogForm
          mode={{ kind: "edit", entry }}
          onDone={() => setOpen(false)}
        />
      </DialogContent>
    </Dialog>
  );
}
