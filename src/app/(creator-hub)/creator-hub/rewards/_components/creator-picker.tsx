"use client";

import { useEffect, useId, useRef, useState, useTransition } from "react";
import { toast } from "sonner";

import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

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
 *
 * KEYBOARD: input + results are one combobox, not an input followed by an
 * orphan grid of buttons. The results were previously reachable only by
 * tabbing THROUGH every one of them, and only after leaving the box — so the
 * natural "type, arrow down, Enter" never worked. ArrowDown/Up move an active
 * option (`aria-activedescendant`, focus stays in the box so typing keeps
 * narrowing), Enter picks it, Escape drops back to the raw term. Clicking a row
 * still works exactly as before.
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
  const uid = useId();
  const listId = `${uid}-results`;
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<CreatorSearchResult[]>([]);
  /** -1 = nothing active; the box's own text is what Enter would act on. */
  const [activeIndex, setActiveIndex] = useState(-1);
  /**
   * True once a search has actually answered, so the "nothing matched" line
   * only shows after a real round-trip — not in the blank moment before the
   * first one lands.
   */
  const [searched, setSearched] = useState(false);
  const [searching, startSearch] = useTransition();
  const listRef = useRef<HTMLDivElement>(null);

  const runSearch = useRef((_term: string) => {});
  runSearch.current = (term: string) => {
    startSearch(async () => {
      try {
        setResults(await searchCreatorsWithCodes(term));
        // A new result set invalidates the old highlight — keeping the index
        // would silently move the highlight onto a different creator.
        setActiveIndex(-1);
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

  // Keep the highlighted row in view when arrowing past the scroll edge.
  useEffect(() => {
    if (activeIndex < 0) return;
    listRef.current
      ?.querySelector(`[data-index="${activeIndex}"]`)
      ?.scrollIntoView({ block: "nearest" });
  }, [activeIndex]);

  function onKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (results.length === 0) return;
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setActiveIndex((i) => (i + 1) % results.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setActiveIndex((i) => (i <= 0 ? results.length - 1 : i - 1));
    } else if (e.key === "Home") {
      e.preventDefault();
      setActiveIndex(0);
    } else if (e.key === "End") {
      e.preventDefault();
      setActiveIndex(results.length - 1);
    } else if (e.key === "Enter" && activeIndex >= 0) {
      // Only swallow Enter when a row is actually highlighted — otherwise the
      // dialog's own default submit behaviour is unchanged.
      e.preventDefault();
      onSelect(results[activeIndex]);
    } else if (e.key === "Escape" && activeIndex >= 0) {
      e.preventDefault();
      e.stopPropagation(); // …and don't close the dialog on the same press.
      setActiveIndex(-1);
    }
  }

  const activeId = activeIndex >= 0 ? `${uid}-opt-${activeIndex}` : undefined;

  return (
    <>
      <Input
        id={inputId}
        role="combobox"
        aria-expanded={results.length > 0}
        aria-controls={listId}
        aria-autocomplete="list"
        aria-activedescendant={activeId}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder="Username, affiliate code, or user ID…"
        disabled={disabled}
      />
      {/* Results sit directly under the box: who they are on the left, the
          codes they own on the right — the operator usually knows the CODE and
          needs to confirm the account before attaching a money program to it. */}
      {results.length > 0 ? (
        <div
          ref={listRef}
          id={listId}
          role="listbox"
          aria-label="Matching creators"
          className="max-h-56 space-y-0.5 overflow-y-auto rounded-md border p-1"
        >
          {/* Every row is a creator — the query returns no other role — so all
              of them are selectable. Rows are not tab stops: the box owns the
              focus, the way a combobox is meant to work. */}
          {results.map((r, i) => (
            <div
              key={r.userId}
              id={`${uid}-opt-${i}`}
              data-index={i}
              role="option"
              aria-selected={i === activeIndex}
              aria-disabled={disabled || undefined}
              onClick={() => {
                if (!disabled) onSelect(r);
              }}
              onMouseEnter={() => setActiveIndex(i)}
              className={cn(
                "flex w-full cursor-pointer items-center justify-between gap-3 rounded px-2 py-1.5 text-left text-sm",
                i === activeIndex && "bg-muted",
                disabled && "pointer-events-none opacity-50",
              )}
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
            </div>
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
