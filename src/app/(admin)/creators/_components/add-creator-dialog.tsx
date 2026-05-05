"use client";

import { useEffect, useRef, useState, useTransition } from "react";
import { toast } from "sonner";
import { Loader2, Search, Sparkles, UserPlus } from "lucide-react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Badge } from "@/components/ui/badge";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog";
import { ROLE_COLORS } from "@/lib/constants";

import { promoteUserToCreator } from "../backend-actions";
import {
  searchNonCreatorUsers,
  type NonCreatorCandidate,
} from "../_queries/search-non-creator-users";

const MIN_SEARCH_LENGTH = 2;
const DEBOUNCE_MS = 250;

export function AddCreatorDialog() {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<NonCreatorCandidate[]>([]);
  const [isSearching, setIsSearching] = useState(false);
  const [isPromoting, startPromote] = useTransition();
  const [promotingUserId, setPromotingUserId] = useState<string | null>(null);

  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const requestIdRef = useRef(0);

  useEffect(() => {
    if (!open) return;
    if (debounceRef.current) clearTimeout(debounceRef.current);

    const trimmed = query.trim();
    if (trimmed.length < MIN_SEARCH_LENGTH) {
      setResults([]);
      setIsSearching(false);
      return;
    }

    setIsSearching(true);
    const reqId = ++requestIdRef.current;
    debounceRef.current = setTimeout(async () => {
      try {
        const found = await searchNonCreatorUsers(trimmed);
        // Guard against out-of-order responses
        if (reqId === requestIdRef.current) {
          setResults(found);
        }
      } catch (err) {
        if (reqId === requestIdRef.current) {
          setResults([]);
          toast.error(
            err instanceof Error ? err.message : "Search failed",
          );
        }
      } finally {
        if (reqId === requestIdRef.current) {
          setIsSearching(false);
        }
      }
    }, DEBOUNCE_MS);

    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [query, open]);

  function reset() {
    setQuery("");
    setResults([]);
    setIsSearching(false);
    setPromotingUserId(null);
  }

  function handlePromote(candidate: NonCreatorCandidate) {
    setPromotingUserId(candidate.userId);
    startPromote(async () => {
      try {
        await promoteUserToCreator(candidate.userId);
        toast.success(
          `${candidate.username ?? candidate.email ?? "User"} is now a creator`,
        );
        setOpen(false);
        reset();
      } catch (err) {
        toast.error(
          err instanceof Error ? err.message : "Failed to promote user",
        );
      } finally {
        setPromotingUserId(null);
      }
    });
  }

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (!next) reset();
      }}
    >
      <DialogTrigger render={<Button size="sm" />}>
        <UserPlus className="mr-2 size-4" />
        Add Creator
      </DialogTrigger>
      <DialogContent className="sm:max-w-lg max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Sparkles className="size-5 text-primary" />
            Promote to Creator
          </DialogTitle>
          <DialogDescription>
            Search for a user by username or email and promote them to the
            creator role. Deals and payouts are configured afterwards on the
            creator&apos;s detail page.
          </DialogDescription>
        </DialogHeader>

        <div className="space-y-3">
          <div className="relative">
            <Search className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
            <Input
              autoFocus
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder="Username or email..."
              className="pl-9"
            />
            {isSearching && (
              <Loader2 className="absolute right-3 top-1/2 size-4 -translate-y-1/2 animate-spin text-muted-foreground" />
            )}
          </div>

          <div className="min-h-[120px] rounded-md border divide-y">
            {query.trim().length < MIN_SEARCH_LENGTH ? (
              <EmptyState message="Type at least 2 characters to search." />
            ) : isSearching && results.length === 0 ? (
              <EmptyState message="Searching..." />
            ) : results.length === 0 ? (
              <EmptyState message="No non-creator users match your search." />
            ) : (
              results.map((candidate) => (
                <CandidateRow
                  key={candidate.userId}
                  candidate={candidate}
                  disabled={isPromoting}
                  loading={promotingUserId === candidate.userId}
                  onPromote={() => handlePromote(candidate)}
                />
              ))
            )}
          </div>
        </div>

        <DialogFooter>
          <Button
            variant="outline"
            onClick={() => setOpen(false)}
            disabled={isPromoting}
          >
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

function EmptyState({ message }: { message: string }) {
  return (
    <div className="flex min-h-[120px] items-center justify-center p-4 text-center text-sm text-muted-foreground">
      {message}
    </div>
  );
}

function CandidateRow({
  candidate,
  disabled,
  loading,
  onPromote,
}: {
  candidate: NonCreatorCandidate;
  disabled: boolean;
  loading: boolean;
  onPromote: () => void;
}) {
  const primary = candidate.username ?? candidate.email ?? "(no name)";
  const secondary =
    candidate.username && candidate.email ? candidate.email : null;

  return (
    <div className="flex items-center justify-between gap-3 px-3 py-2.5">
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-2">
          <span className="truncate text-sm font-medium">{primary}</span>
          <Badge
            variant="outline"
            className={ROLE_COLORS[candidate.role] ?? ""}
          >
            {candidate.role}
          </Badge>
        </div>
        {secondary && (
          <div className="truncate text-xs text-muted-foreground">
            {secondary}
          </div>
        )}
      </div>
      <Button
        size="sm"
        variant="outline"
        onClick={onPromote}
        disabled={disabled}
      >
        {loading ? (
          <Loader2 className="size-3.5 animate-spin" />
        ) : (
          "Promote"
        )}
      </Button>
    </div>
  );
}
