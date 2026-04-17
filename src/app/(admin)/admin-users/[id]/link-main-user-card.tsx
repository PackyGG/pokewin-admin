"use client";

import { useState, useTransition, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { LinkIcon } from "lucide-react";
import { Input } from "@/components/ui/input";
import { searchMainSiteUsers, linkCreatorToMainUser } from "./actions";
import type { AdminUserDetail } from "@/lib/queries/admin-users";

/* ── Link Main Site User (Creator only) ── */
export function LinkMainUserCard({ detail }: { detail: AdminUserDetail }) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<{ id: string; username: string | null; email: string | null; role: string }[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [isPending, startTransition] = useTransition();
  const debounceRef = useRef<ReturnType<typeof setTimeout>>(null);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    if (query.length < 2) {
      setResults([]);
      return;
    }
    setIsSearching(true);
    debounceRef.current = setTimeout(async () => {
      try {
        const users = await searchMainSiteUsers(query);
        setResults(users);
      } catch {
        toast.error("Search failed");
      } finally {
        setIsSearching(false);
      }
    }, 300);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query]);

  function handleLink(mainUserId: string) {
    startTransition(async () => {
      try {
        await linkCreatorToMainUser(detail.id, mainUserId);
        toast.success("Creator linked to main site user");
        setResults([]);
        setQuery("");
        router.refresh();
      } catch (err) {
        toast.error(err instanceof Error ? err.message : "Failed to link");
      }
    });
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-base">Link to Main Site User</CardTitle>
      </CardHeader>
      <CardContent className="space-y-3">
        <p className="text-sm text-muted-foreground">
          Search for a main site user by username or email to link this creator account.
        </p>
        <Input
          placeholder="Search username or email..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
        />
        {isSearching && <p className="text-sm text-muted-foreground">Searching...</p>}
        {results.length > 0 && (
          <div className="rounded-md border divide-y">
            {results.map((user) => (
              <div key={user.id} className="flex items-center justify-between px-3 py-2 text-sm">
                <div>
                  <span className="font-medium">{user.username ?? user.email ?? user.id.slice(0, 8)}</span>
                  {user.username && user.email && (
                    <span className="text-muted-foreground ml-2">({user.email})</span>
                  )}
                  <Badge variant="outline" className="ml-2 text-xs">{user.role}</Badge>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={isPending}
                  onClick={() => handleLink(user.id)}
                >
                  <LinkIcon className="size-3 mr-1" />
                  Link
                </Button>
              </div>
            ))}
          </div>
        )}
        {results.length === 0 && !isSearching && query.length >= 2 && (
          <p className="text-sm text-muted-foreground">No users found</p>
        )}
      </CardContent>
    </Card>
  );
}
