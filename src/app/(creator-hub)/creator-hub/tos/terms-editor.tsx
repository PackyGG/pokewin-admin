"use client";

import { useState, useTransition } from "react";
import { GripVertical, Plus, Save, Trash2 } from "lucide-react";
import { toast } from "sonner";

import { Button } from "@/components/ui/button";
import { Textarea } from "@/components/ui/textarea";
import { Spinner } from "@/components/ux";

import { publishCreatorTermsAction } from "./actions";

/**
 * A term row carries a stable identity so React can key on it. Keying on the
 * array index made the reorder and delete controls reuse the wrong DOM nodes —
 * the values stayed correct (the Textarea is controlled) but the caret jumped
 * to a different row on every move/delete. The id is editor-local and never
 * crosses the server boundary: `publish` maps back to `string[]`.
 */
type TermLine = { id: string; text: string };

function newLine(text: string): TermLine {
  return { id: crypto.randomUUID(), text };
}

export function CreatorTermsEditor({ initialLines }: { initialLines: string[] }) {
  const [lines, setLines] = useState<TermLine[]>(() =>
    (initialLines.length > 0 ? initialLines : [""]).map(newLine),
  );
  const [pending, startTransition] = useTransition();

  function update(index: number, text: string) {
    setLines((current) =>
      current.map((line, at) => (at === index ? { ...line, text } : line)),
    );
  }

  function move(index: number, direction: -1 | 1) {
    const target = index + direction;
    if (target < 0 || target >= lines.length) return;
    setLines((current) => {
      const next = [...current];
      [next[index], next[target]] = [next[target], next[index]];
      return next;
    });
  }

  function publish() {
    startTransition(async () => {
      // Unchanged server contract — plain `string[]`, editor ids stripped.
      const result = await publishCreatorTermsAction({
        lines: lines.map((line) => line.text),
      });
      if (!result.success) {
        toast.error(result.error);
        return;
      }
      toast.success(`Creator terms version ${result.version} published`);
    });
  }

  return (
    <div className="space-y-4">
      <div className="space-y-2">
        {lines.map((line, index) => (
          <div key={line.id} className="grid grid-cols-[auto_1fr_auto] items-start gap-2 rounded-lg border bg-card p-2">
            <div className="flex items-center gap-1 pt-2 text-sm font-semibold tabular-nums text-muted-foreground">
              <GripVertical className="size-4" />
              {index + 1}.
            </div>
            <Textarea
              value={line.text}
              onChange={(event) => update(index, event.target.value)}
              placeholder={`Term ${index + 1}`}
              aria-label={`Term ${index + 1}`}
              disabled={pending}
              className="min-h-16 resize-y"
            />
            <div className="flex flex-col gap-1">
              <Button type="button" size="icon-sm" variant="ghost" onClick={() => move(index, -1)} disabled={pending || index === 0} aria-label={`Move term ${index + 1} up`}>↑</Button>
              <Button type="button" size="icon-sm" variant="ghost" onClick={() => move(index, 1)} disabled={pending || index === lines.length - 1} aria-label={`Move term ${index + 1} down`}>↓</Button>
              <Button type="button" size="icon-sm" variant="ghost" onClick={() => setLines((current) => current.filter((_, at) => at !== index))} disabled={pending || lines.length === 1} aria-label={`Remove term ${index + 1}`}>
                <Trash2 className="size-3.5" />
              </Button>
            </div>
          </div>
        ))}
      </div>

      <div className="flex flex-wrap justify-between gap-2">
        <Button type="button" variant="outline" onClick={() => setLines((current) => [...current, newLine("")])} disabled={pending || lines.length >= 100}>
          <Plus className="size-4" />
          Add line
        </Button>
        <Button type="button" onClick={publish} disabled={pending}>
          {pending ? <Spinner size={14} /> : <Save className="size-4" />}
          {pending ? "Publishing…" : "Publish new version"}
        </Button>
      </div>
    </div>
  );
}
