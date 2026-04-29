"use client";

import { useState, useTransition } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

import { searchCreatorsAction, setCreatorRoleAction } from "../actions";

type Creator = {
  user_id: string;
  username: string | null;
  email: string | null;
};

export function UsersTab() {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<Creator[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [pending, startTransition] = useTransition();
  const [promoteUserId, setPromoteUserId] = useState("");

  const runSearch = () => {
    setError(null);
    startTransition(async () => {
      const res = await searchCreatorsAction(query);
      if (!res.success) {
        setError(res.error);
        return;
      }
      setResults(res.data ?? []);
    });
  };

  const setRole = (userId: string, promote: boolean) => {
    setError(null);
    startTransition(async () => {
      const res = await setCreatorRoleAction({ user_id: userId, promote });
      if (!res.success) {
        setError(res.error);
        return;
      }
      runSearch();
    });
  };

  return (
    <div className="space-y-6">
      <div className="space-y-2">
        <Label className="text-xs uppercase tracking-wider text-muted-foreground">
          Promote a user to creator
        </Label>
        <div className="flex gap-2">
          <Input
            placeholder="user id"
            value={promoteUserId}
            onChange={(e) => setPromoteUserId(e.target.value)}
            className="max-w-md"
          />
          <Button
            disabled={pending || !promoteUserId.trim()}
            onClick={() => setRole(promoteUserId.trim(), true)}
          >
            Promote
          </Button>
          <Button
            variant="outline"
            disabled={pending || !promoteUserId.trim()}
            onClick={() => setRole(promoteUserId.trim(), false)}
          >
            Demote
          </Button>
        </div>
        <p className="text-xs text-muted-foreground">
          Paste a user id (not username). The user must already exist on the
          dev database.
        </p>
      </div>

      <div className="space-y-2">
        <Label className="text-xs uppercase tracking-wider text-muted-foreground">
          Existing creators
        </Label>
        <div className="flex gap-2">
          <Input
            placeholder="search by username, email, or id"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="max-w-md"
            onKeyDown={(e) => {
              if (e.key === "Enter") runSearch();
            }}
          />
          <Button variant="outline" disabled={pending} onClick={runSearch}>
            {pending ? "Loading..." : "Search"}
          </Button>
        </div>

        {error && <p className="text-sm text-destructive">{error}</p>}

        {results.length > 0 && (
          <div className="rounded-md border divide-y">
            {results.map((c) => (
              <div
                key={c.user_id}
                className="flex items-center justify-between gap-3 px-3 py-2"
              >
                <div className="text-sm">
                  <div className="font-medium">{c.username ?? "(no username)"}</div>
                  <div className="text-muted-foreground text-xs">
                    {c.email ?? "(no email)"} · {c.user_id}
                  </div>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={pending}
                  onClick={() => setRole(c.user_id, false)}
                >
                  Demote
                </Button>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
