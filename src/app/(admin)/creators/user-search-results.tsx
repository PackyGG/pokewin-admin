"use client";

import { useTransition } from "react";
import { useRouter } from "next/navigation";
import { toast } from "sonner";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ROLE_COLORS } from "@/lib/constants";
import { makeCreator } from "./actions";
import type { UserSearchResult } from "@/lib/queries/creators";

export function UserSearchResults({ users }: { users: UserSearchResult[] }) {
  return (
    <div className="space-y-2">
      <p className="text-sm text-muted-foreground">Other users matching search</p>
      <div className="rounded-md border divide-y">
        {users.map((user) => (
          <UserRow key={user.userId} user={user} />
        ))}
      </div>
    </div>
  );
}

function UserRow({ user }: { user: UserSearchResult }) {
  const [isPending, startTransition] = useTransition();
  const router = useRouter();

  function handleMakeCreator() {
    startTransition(async () => {
      try {
        await makeCreator(user.userId);
        toast.success(`${user.username ?? user.email} is now a creator`);
        router.refresh();
      } catch (e) {
        toast.error(e instanceof Error ? e.message : "Failed to make creator");
      }
    });
  }

  return (
    <div className="flex items-center justify-between px-4 py-2.5">
      <div className="flex items-center gap-3">
        <span className="text-sm font-medium">{user.username ?? user.email}</span>
        <Badge variant="outline" className={ROLE_COLORS[user.role] ?? ""}>
          {user.role}
        </Badge>
      </div>
      <Button size="sm" variant="outline" onClick={handleMakeCreator} disabled={isPending}>
        {isPending ? "..." : "Make Creator"}
      </Button>
    </div>
  );
}
