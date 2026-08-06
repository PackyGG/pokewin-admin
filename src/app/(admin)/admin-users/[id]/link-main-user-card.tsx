"use client";

import { useState, useTransition, useEffect, useRef } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { LinkIcon } from "lucide-react";
import { Input } from "@/components/ui/input";
import { Spinner } from "@/components/ux";
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
  // Out-of-order-response guard. Clearing the debounce timer does NOT cancel a
  // request that already went out, so without this "ka" could resolve after
  // "kartos" and leave the wrong candidates on screen — and linking the wrong
  // main-site user to an admin account is not a recoverable mistake.
  const requestIdRef = useRef(0);

  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    // Bumped on every run so any in-flight request is invalidated, including
    // on the below-minimum branch and on unmount.
    const reqId = ++requestIdRef.current;
    // Keep in sync with the server-side minimum in searchMainSiteUsers.
    if (query.trim().length < 3) {
      setResults([]);
      setIsSearching(false);
      return;
    }
    setIsSearching(true);
    debounceRef.current = setTimeout(async () => {
      try {
        const users = await searchMainSiteUsers(query);
        if (reqId === requestIdRef.current) setResults(users);
      } catch {
        if (reqId === requestIdRef.current) toast.error("Search failed");
      } finally {
        if (reqId === requestIdRef.current) setIsSearching(false);
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
        {isSearching && (
          <p className="flex items-center gap-2 text-sm text-muted-foreground">
            <Spinner size={14} />
            Searching...
          </p>
        )}
        {results.length > 0 && (
          <div className="rounded-md border divide-y">
            {results.map((user) => (
              <div key={user.id} className="flex flex-col gap-2 px-3 py-2 text-sm sm:flex-row sm:items-center sm:justify-between">
                <div className="min-w-0 flex flex-wrap items-center gap-x-2 gap-y-1">
                  <span className="font-medium truncate">{user.username ?? user.email ?? user.id.slice(0, 8)}</span>
                  {user.username && user.email && (
                    <span className="text-muted-foreground truncate">({user.email})</span>
                  )}
                  <Badge variant="outline" className="text-xs shrink-0">{user.role}</Badge>
                </div>
                <Button
                  size="sm"
                  variant="outline"
                  disabled={isPending}
                  onClick={() => handleLink(user.id)}
                  className="self-start sm:self-auto"
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
