"use client";

import { useMemo, useState } from "react";
import { ArrowDownAZ, ListFilter, Plus, Trash2, Upload } from "lucide-react";
import { toast } from "sonner";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Textarea } from "@/components/ui/textarea";

const MAX_BLOCKED_WORDS = 500;

export function normalizeWordEntries(values: readonly string[]): string[] {
  const seen = new Set<string>();
  const result: string[] = [];
  for (const raw of values) {
    const value = raw.trim().toLocaleLowerCase("en-US");
    if (!value || seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

function parseEntries(value: string): string[] {
  return value.split(/[\n,]/).map((entry) => entry.trim()).filter(Boolean);
}

export function BlockedWordsEditor({
  words,
  disabled,
  onChange,
}: {
  words: readonly string[];
  disabled: boolean;
  onChange: (words: string[]) => void;
}) {
  const [search, setSearch] = useState("");
  const [newEntry, setNewEntry] = useState("");
  const [bulkText, setBulkText] = useState("");
  const [bulkOpen, setBulkOpen] = useState(false);

  const visibleWords = useMemo(() => {
    const needle = search.trim().toLocaleLowerCase("en-US");
    if (!needle) return words;
    return words.filter((word) => word.toLocaleLowerCase("en-US").includes(needle));
  }, [search, words]);

  const addEntries = (entries: readonly string[]) => {
    const next = normalizeWordEntries([...words, ...entries]);
    if (next.length > MAX_BLOCKED_WORDS) {
      toast.error(`The blocked-word list supports up to ${MAX_BLOCKED_WORDS} entries.`);
      return false;
    }
    if (next.length === words.length) {
      toast.info("Those entries are already in the list.");
      return false;
    }
    onChange(next);
    return true;
  };

  const addOne = () => {
    if (!newEntry.trim()) return;
    if (addEntries([newEntry])) setNewEntry("");
  };

  const addBulk = () => {
    const entries = parseEntries(bulkText);
    if (entries.length === 0) {
      toast.error("Paste at least one word or phrase.");
      return;
    }
    if (addEntries(entries)) {
      setBulkText("");
      setBulkOpen(false);
    }
  };

  const remove = (word: string) => {
    onChange(words.filter((entry) => entry !== word));
  };

  return (
    <div className="overflow-hidden rounded-xl border bg-card">
      <div className="space-y-4 border-b bg-muted/20 p-4">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="space-y-1">
            <div className="flex items-center gap-2">
              <Label htmlFor="new-blocked-word">Blocked words and phrases</Label>
              <Badge variant={words.length >= MAX_BLOCKED_WORDS ? "destructive" : "secondary"}>
                {words.length.toLocaleString()} / {MAX_BLOCKED_WORDS}
              </Badge>
            </div>
            <p className="text-xs text-muted-foreground">
              Case-insensitive whole-word matching. Changes take effect after you save the page.
            </p>
          </div>
          <div className="flex items-center gap-2">
            <Button
              type="button"
              variant="outline"
              size="sm"
              disabled={disabled || words.length < 2}
              onClick={() => onChange([...words].sort((a, b) => a.localeCompare(b)))}
            >
              <ArrowDownAZ /> Sort A–Z
            </Button>
            <Button
              type="button"
              variant={bulkOpen ? "secondary" : "outline"}
              size="sm"
              disabled={disabled}
              onClick={() => setBulkOpen((open) => !open)}
            >
              <Upload /> Bulk add
            </Button>
          </div>
        </div>

        <div className="flex gap-2">
          <Input
            id="new-blocked-word"
            value={newEntry}
            maxLength={120}
            disabled={disabled || words.length >= MAX_BLOCKED_WORDS}
            placeholder="Add a word or phrase"
            onChange={(event) => setNewEntry(event.target.value)}
            onKeyDown={(event) => {
              if (event.key !== "Enter") return;
              event.preventDefault();
              addOne();
            }}
          />
          <Button type="button" disabled={disabled || !newEntry.trim()} onClick={addOne}>
            <Plus /> Add
          </Button>
        </div>

        {bulkOpen && (
          <div className="space-y-2 rounded-lg border bg-background p-3">
            <Label htmlFor="bulk-blocked-words">Paste a list</Label>
            <Textarea
              id="bulk-blocked-words"
              rows={7}
              className="resize-y font-mono text-xs"
              value={bulkText}
              disabled={disabled}
              placeholder={"one entry per line\nblocked phrase\nanother entry"}
              onChange={(event) => setBulkText(event.target.value)}
            />
            <div className="flex items-center justify-between gap-3">
              <p className="text-xs text-muted-foreground">
                Blank lines and duplicates are removed automatically.
              </p>
              <Button type="button" size="sm" disabled={disabled || !bulkText.trim()} onClick={addBulk}>
                Add pasted list
              </Button>
            </div>
          </div>
        )}
      </div>

      <div className="border-b p-3">
        <div className="relative">
          <ListFilter className="pointer-events-none absolute left-2.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
          <Input
            value={search}
            disabled={disabled}
            className="pl-8"
            placeholder="Search the blocked list"
            aria-label="Search blocked words"
            onChange={(event) => setSearch(event.target.value)}
          />
        </div>
      </div>

      <div className="max-h-[32rem] min-h-48 overflow-y-auto">
        {visibleWords.length === 0 ? (
          <div className="flex min-h-48 items-center justify-center p-6 text-center text-sm text-muted-foreground">
            {words.length === 0 ? "No blocked words yet." : "No entries match your search."}
          </div>
        ) : (
          <div className="divide-y">
            {visibleWords.map((word) => (
              <div key={word} className="group flex min-h-10 items-center justify-between gap-3 px-4 py-2 hover:bg-muted/30">
                <span className="min-w-0 break-words font-mono text-sm">{word}</span>
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  disabled={disabled}
                  className="text-muted-foreground opacity-70 hover:text-destructive group-hover:opacity-100"
                  aria-label={`Remove ${word}`}
                  onClick={() => remove(word)}
                >
                  <Trash2 />
                </Button>
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="flex items-center justify-between border-t bg-muted/20 px-4 py-2 text-xs text-muted-foreground">
        <span>{search.trim() ? `${visibleWords.length} matching entries` : `${words.length} total entries`}</span>
        <span>One entry can contain multiple words</span>
      </div>
    </div>
  );
}
