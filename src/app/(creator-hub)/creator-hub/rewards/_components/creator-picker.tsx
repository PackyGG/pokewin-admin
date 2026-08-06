"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { toast } from "sonner";

import { Input } from "@/components/ui/input";

import { searchCreatorsWithCodes, type CreatorSearchResult } from "../actions";

/**
 * The create-program creator picker: one box, three ways in (username, user id,
 * affiliate code). Split out of the program dialog because it owns a debounce,
 * a transition and its own "nothing matched" state — none of which the terms
 * form cares about.
 *
 * Only rendered while NOTHING is selected; the parent replaces it with the
 * chosen creator, so re-opening it re-runs the search from the term still in
 * the box. Edit mode never mounts it at all — a program's creator is fixed.
 */
export function CreatorPicker({
  inputId,
  /** Gate for the debounce: the dialog is closed, so don't search. */
  active,
  disabled,
  onSelect,
}: {
  inputId: string;
  active: boolean;
  disabled?: boolean;
  onSelect: (creator: CreatorSearchResult) => void;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<CreatorSearchResult[]>([]);
  /**
   * True once a search has actually answered, so the "nothing matched" line
   * only shows after a real round-trip — not in the blank moment before the
   * first one lands.
   */
  const [searched, setSearched] = useState(false);
  const [searching, startSearch] = useTransition();

  const runSearch = useRef((_term: string) => {});
  runSearch.current = (term: string) => {
    startSearch(async () => {
      try {
        setResults(await searchCreatorsWithCodes(term));
        setSearched(true);
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Search failed");
      }
    });
  };

  /**
   * Live search as the operator types — no Search button to press. 300 ms
   * debounce, the same pause the /users toolbar uses, so a typed handle is one
   * round-trip per pause rather than one per keystroke. Runs on an empty box
   * too: that's the "just show me the creators" case the dialog opens with.
   */
  useEffect(() => {
    if (!active) return;
    const t = setTimeout(() => runSearch.current(query), 300);
    return () => clearTimeout(t);
  }, [active, query]);

  return (
    <>
      <Input
        id={inputId}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        placeholder="Username, affiliate code, or user ID…"
        disabled={disabled}
      />
      {/* Results sit directly under the box: who they are on the left, the
          codes they own on the right — the operator usually knows the CODE and
          needs to confirm the account before attaching a money program to it. */}
      {results.length > 0 ? (
        <div className="max-h-56 space-y-0.5 overflow-y-auto rounded-md border p-1">
          {/* Every row is a creator — the query returns no other role — so all
              of them are selectable. */}
          {results.map((r) => (
            <button
              key={r.userId}
              type="button"
              disabled={disabled}
              onClick={() => onSelect(r)}
              className="flex w-full items-center justify-between gap-3 rounded px-2 py-1.5 text-left text-sm hover:bg-muted"
              title={`User ID: ${r.userId}`}
            >
              <span className="min-w-0 truncate">{r.username ?? r.userId}</span>
              {r.codes.length > 0 ? (
                <span className="flex shrink-0 flex-wrap justify-end gap-1">
                  {r.codes.slice(0, 4).map((c) => (
                    <span
                      key={c}
                      className="rounded border px-1.5 py-0.5 font-mono text-[10px] text-muted-foreground"
                    >
                      {c}
                    </span>
                  ))}
                  {r.codes.length > 4 && (
                    <span className="text-[10px] text-muted-foreground">
                      +{r.codes.length - 4}
                    </span>
                  )}
                </span>
              ) : (
                <span className="shrink-0 text-[10px] text-muted-foreground">
                  no codes
                </span>
              )}
            </button>
          ))}
        </div>
      ) : (
        searched &&
        !searching && (
          <p className="text-xs text-muted-foreground">
            {query.trim()
              ? "No creator matches that. A code owned by a non-creator account won't show — make them a creator first."
              : "No creators yet."}
          </p>
        )
      )}
    </>
  );
}
