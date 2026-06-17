"use client";

import * as React from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Pencil } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Spinner } from "@/components/ux";
import { updateRoadmapBody } from "../actions";

export function NotesEditor({
  itemId,
  body,
}: {
  itemId: string;
  body: string | null;
}) {
  const router = useRouter();
  const [editing, setEditing] = React.useState(false);
  const [value, setValue] = React.useState(body ?? "");
  const [saving, setSaving] = React.useState(false);

  React.useEffect(() => {
    setValue(body ?? "");
  }, [body]);

  async function save() {
    setSaving(true);
    try {
      const r = await updateRoadmapBody({ id: itemId, body: value });
      if (!r.success) {
        toast.error(r.error);
        return;
      }
      toast.success("Notes saved");
      setEditing(false);
      router.refresh();
    } catch (e) {
      toast.error(e instanceof Error ? e.message : "Failed to save notes");
    } finally {
      setSaving(false);
    }
  }

  if (!editing) {
    return (
      <div className="rounded-2xl border bg-card p-4">
        {body ? (
          <div className="whitespace-pre-wrap text-sm leading-relaxed text-foreground/90">
            {body}
          </div>
        ) : (
          <p className="text-sm text-muted-foreground">No notes yet.</p>
        )}
        <div className="mt-3">
          <Button variant="outline" size="sm" onClick={() => setEditing(true)}>
            <Pencil className="size-3.5" />
            {body ? "Edit notes" : "Add notes"}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-3 rounded-2xl border bg-card p-4">
      <Textarea
        value={value}
        onChange={(e) => setValue(e.target.value)}
        rows={8}
        maxLength={20000}
        placeholder="Spec, context, decisions, open questions…"
        autoFocus
      />
      <div className="flex items-center gap-2">
        <Button size="sm" onClick={save} disabled={saving}>
          {saving && <Spinner size={14} className="text-current" />}
          {saving ? "Saving…" : "Save"}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => {
            setValue(body ?? "");
            setEditing(false);
          }}
          disabled={saving}
        >
          Cancel
        </Button>
      </div>
    </div>
  );
}
