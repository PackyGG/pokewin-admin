"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Megaphone, Search } from "lucide-react";
import { PageHero } from "@/components/modern-panels";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { setHouseAccount, searchUsersForHouse } from "./actions";

type UserResult = {
  id: string;
  username: string | null;
  email: string | null;
};

/**
 * First-time setup card shown when no house account is configured yet.
 * Once an admin picks a user and hits save, the page re-renders into
 * the full Ads dashboard.
 */
export function HouseAccountSetup() {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<UserResult[]>([]);
  const [showResults, setShowResults] = useState(false);
  const [searching, setSearching] = useState(false);
  const [selected, setSelected] = useState<UserResult | null>(null);
  const [saving, startTransition] = useTransition();
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (query.length < 2) {
      setResults([]);
      return;
    }
    setSearching(true);
    debounceRef.current = setTimeout(async () => {
      try {
        const res = await searchUsersForHouse(query);
        setResults(res);
        setShowResults(true);
      } finally {
        setSearching(false);
      }
    }, 300);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query]);

  useEffect(() => {
    function onClickOutside(e: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
        setShowResults(false);
      }
    }
    document.addEventListener("mousedown", onClickOutside);
    return () => document.removeEventListener("mousedown", onClickOutside);
  }, []);

  function handlePick(u: UserResult) {
    setSelected(u);
    setQuery(u.username ?? u.email ?? u.id.slice(0, 8));
    setShowResults(false);
  }

  function handleSave() {
    if (!selected) {
      toast.error("Select a user first");
      return;
    }
    startTransition(async () => {
      try {
        await setHouseAccount(selected.id);
        toast.success("House account configured");
        router.refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed to save");
      }
    });
  }

  return (
    <div className="space-y-6">
      <PageHero>
        <div className="flex items-center gap-3">
          <div className="flex size-10 items-center justify-center rounded-xl bg-primary/10">
            <Megaphone className="size-5 text-primary" />
          </div>
          <div>
            <h1 className="text-2xl font-bold leading-tight">Ads</h1>
            <p className="text-sm text-muted-foreground">
              Track ad campaigns through a single &ldquo;house&rdquo; affiliate account.
            </p>
          </div>
        </div>
      </PageHero>

      <div className="mx-auto max-w-2xl rounded-2xl border bg-card p-6">
        <div className="mb-4">
          <h2 className="text-base font-semibold">Pick the house account</h2>
          <p className="mt-1 text-sm text-muted-foreground">
            Choose a real user account. All ad codes will be created under this
            user so clicks, signups, and deposits track through the existing
            affiliate pipeline. You can change this later, but existing codes
            stay attached to whichever account they were created on.
          </p>
        </div>

        <div ref={containerRef} className="space-y-2">
          <Label htmlFor="house-search">Search user</Label>
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              id="house-search"
              value={query}
              onChange={(e) => {
                setQuery(e.target.value);
                if (selected) setSelected(null);
              }}
              onFocus={() => results.length > 0 && setShowResults(true)}
              placeholder="Username, email, or user ID"
              className="pl-9"
            />
            {showResults && results.length > 0 && (
              <div className="absolute top-full z-50 mt-1 w-full rounded-md border bg-popover shadow-md">
                {results.map((u) => (
                  <button
                    key={u.id}
                    type="button"
                    className="flex w-full items-center justify-between gap-3 px-3 py-2 text-left text-sm hover:bg-muted"
                    onClick={() => handlePick(u)}
                  >
                    <span className="font-medium truncate">
                      {u.username ?? "(no username)"}
                    </span>
                    <span className="text-xs text-muted-foreground truncate">
                      {u.email ?? u.id.slice(0, 8)}
                    </span>
                  </button>
                ))}
              </div>
            )}
            {showResults && query.length >= 2 && results.length === 0 && !searching && (
              <div className="absolute top-full z-50 mt-1 w-full rounded-md border bg-popover p-3 text-center text-sm text-muted-foreground shadow-md">
                No users found
              </div>
            )}
          </div>

          {selected && (
            <div className="mt-3 rounded-md border bg-muted/40 px-3 py-2 text-sm">
              <span className="text-muted-foreground">Selected: </span>
              <span className="font-medium">
                {selected.username ?? selected.email ?? selected.id}
              </span>
              <span className="ml-2 text-xs font-mono text-muted-foreground">
                {selected.id.slice(0, 8)}
              </span>
            </div>
          )}
        </div>

        <div className="mt-6 flex justify-end">
          <Button onClick={handleSave} disabled={saving || !selected}>
            {saving ? "Saving..." : "Save house account"}
          </Button>
        </div>
      </div>
    </div>
  );
}
