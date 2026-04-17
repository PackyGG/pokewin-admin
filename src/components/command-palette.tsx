"use client";

// Global CMD+K command palette. Mounted once in the admin layout.
//
//   - CMD+K (macOS) / CTRL+K (other) toggles it open.
//   - Three sections: Navigation, Quick Actions, Users.
//   - Navigation + Quick Actions come from src/lib/commands.ts — single
//     source of truth also used by the /system/commands docs page.
//   - Users: server-side search against the main DB (db.user). Fires only
//     when the query is non-trivial; debounced 200ms.
//   - A floating "⌘K" trigger button is rendered in the top-right so users
//     can open the palette by click as well as keyboard.
//
// cmdk handles ↑↓ navigation, Enter-to-select, and its own fuzzy filter
// over the rendered items. We set `shouldFilter={false}` when showing live
// user results (the server returned exactly what it wanted); otherwise we
// let cmdk filter nav + actions against the input string.

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  useTransition,
} from "react";
import { useRouter } from "next/navigation";
import { useTheme } from "next-themes";
import { toast } from "sonner";
import { SearchIcon } from "lucide-react";

import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
  CommandShortcut,
} from "@/components/ui/command";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { ROLE_COLORS } from "@/lib/constants";
import { cn } from "@/lib/utils";
import {
  ACTION_COMMANDS,
  NAV_COMMANDS,
  PALETTE_SECTION_LABELS,
  filterCommandsForUser,
  type ActionCommand,
  type NavCommand,
} from "@/lib/commands";
import {
  searchUsersGlobal,
  type GlobalUserSearchResult,
} from "@/app/(admin)/actions/global-search";
import { logout } from "@/lib/actions/auth";

const DEBOUNCE_MS = 200;
const MIN_USER_QUERY = 2;

function userSearchTrigger(query: string): string | null {
  const trimmed = query.trim();
  if (trimmed.startsWith("@")) {
    const rest = trimmed.slice(1).trim();
    return rest.length >= MIN_USER_QUERY ? rest : "";
  }
  if (trimmed.length >= 3) return trimmed;
  return null;
}

function initials(source: string | null): string {
  const clean = (source ?? "").trim();
  if (!clean) return "?";
  const parts = clean.split(/\s+/).filter(Boolean);
  if (parts.length >= 2) return (parts[0][0] + parts[1][0]).toUpperCase();
  return clean.slice(0, 2).toUpperCase();
}

export function CommandPalette({
  role,
  allowedPages,
}: {
  role: string;
  allowedPages: string[];
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const [userResults, setUserResults] = useState<GlobalUserSearchResult[]>([]);
  const [searching, setSearching] = useState(false);
  const [, startTransition] = useTransition();
  const router = useRouter();
  const { setTheme } = useTheme();

  // Filter commands against the user's allowed_pages. Admins see every
  // entry; non-admins only see items whose `pageKey` they have access to.
  const visibleNav = useMemo(
    () => filterCommandsForUser(NAV_COMMANDS, role, allowedPages),
    [role, allowedPages],
  );
  const visibleActions = useMemo(
    () => filterCommandsForUser(ACTION_COMMANDS, role, allowedPages),
    [role, allowedPages],
  );

  // ── Global hotkey: CMD/CTRL + K ────────────────────────────────────
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const isHotkey =
        (e.key === "k" || e.key === "K") && (e.metaKey || e.ctrlKey);
      if (!isHotkey) return;
      // Don't hijack the shortcut when the user is typing into an input —
      // base-ui dialog inputs are still fine because e.target will be the
      // palette input itself, which is already focused.
      const target = e.target as HTMLElement | null;
      const isEditing =
        target?.tagName === "INPUT" ||
        target?.tagName === "TEXTAREA" ||
        target?.isContentEditable;
      if (isEditing && !open) {
        // Still allow opening from inside an input — users expect ⌘K to
        // always work. We just don't eat the Escape.
      }
      e.preventDefault();
      setOpen((v) => !v);
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open]);

  // Reset state when the dialog closes so the next open starts clean.
  useEffect(() => {
    if (!open) {
      setQuery("");
      setUserResults([]);
      setSearching(false);
    }
  }, [open]);

  // ── Live user search (debounced) ───────────────────────────────────
  // Only runs when the query is a non-trivial substring (>= 3 chars) or
  // starts with `@`. The server action enforces its own min length too.
  useEffect(() => {
    const trigger = userSearchTrigger(query);
    if (trigger === null) {
      setUserResults([]);
      setSearching(false);
      return;
    }
    if (trigger === "") {
      // User typed `@` alone — waiting for more input. Keep results cleared.
      setUserResults([]);
      setSearching(false);
      return;
    }

    setSearching(true);
    const handle = setTimeout(() => {
      // startTransition keeps the input responsive while the server action
      // is in flight. We also guard against stale responses with a token.
      startTransition(async () => {
        try {
          const results = await searchUsersGlobal(trigger);
          // Stale-check: if the query changed since this fired, drop the
          // results. The latest effect run will have already updated state.
          if (userSearchTrigger(queryRef.current) === trigger) {
            setUserResults(results);
          }
        } catch {
          // Silently fail — search isn't critical. Show empty results.
          setUserResults([]);
        } finally {
          if (userSearchTrigger(queryRef.current) === trigger) {
            setSearching(false);
          }
        }
      });
    }, DEBOUNCE_MS);

    return () => clearTimeout(handle);
  }, [query]);

  // Keep a ref to the latest query for the stale-check above.
  const queryRef = useRef(query);
  useEffect(() => {
    queryRef.current = query;
  }, [query]);

  // ── Dispatchers ────────────────────────────────────────────────────
  const runNav = useCallback(
    (cmd: NavCommand) => {
      setOpen(false);
      router.push(cmd.href);
    },
    [router],
  );

  const runAction = useCallback(
    async (cmd: ActionCommand) => {
      switch (cmd.run.type) {
        case "navigate":
          setOpen(false);
          router.push(cmd.run.href);
          return;
        case "theme":
          setTheme(cmd.run.mode);
          setOpen(false);
          return;
        case "logout":
          setOpen(false);
          try {
            await logout();
          } catch {
            // logout() throws NEXT_REDIRECT internally; ignore.
          }
          return;
        case "focus-user-search":
          // Prefill `@` and let the user keep typing inside the palette.
          setQuery("@");
          return;
      }
    },
    [router, setTheme],
  );

  const runUser = useCallback(
    (u: GlobalUserSearchResult) => {
      setOpen(false);
      router.push(`/users/${u.id}`);
    },
    [router],
  );

  const trigger = userSearchTrigger(query);
  const showUserResults = trigger !== null;
  const hasUserResults = userResults.length > 0;
  // When we're actively showing server-driven user results, disable cmdk's
  // own fuzzy filter so every row we render stays visible regardless of
  // what cmdk's matcher thinks. Nav + actions still use cmdk filtering.
  const shouldCmdkFilter = !showUserResults;

  return (
    <>
      {/* Floating hint / trigger button — keyboard users will mostly use
          CMD+K, but this gives a visible affordance and a click target. */}
      <PaletteTriggerButton onClick={() => setOpen(true)} />

      <CommandDialog
        open={open}
        onOpenChange={setOpen}
        title="Command palette"
        description="Search for a page, run an action, or jump to a user."
        className="max-w-2xl"
      >
        <Command shouldFilter={shouldCmdkFilter} loop>
          <CommandInput
            value={query}
            onValueChange={setQuery}
            placeholder="Type a command, search users with @, or jump to a page…"
            autoFocus
          />
          <CommandList className="max-h-[420px]">
            {/* Empty state: shown when cmdk has no matches AND we have no
                server user results. The exact copy changes based on whether
                the query looks like a user lookup. */}
            <CommandEmpty>
              {searching
                ? "Searching…"
                : showUserResults
                  ? "No results — try @username"
                  : "No results found."}
            </CommandEmpty>

            {/* Users — rendered first when the query is a user lookup so
                the typical flow (type @, hit Enter) jumps straight to the
                matching profile. */}
            {showUserResults && (hasUserResults || searching) && (
              <CommandGroup heading={PALETTE_SECTION_LABELS.users}>
                {userResults.map((u) => (
                  <CommandItem
                    key={`user-${u.id}`}
                    value={`user-${u.id}-${u.username ?? ""}-${u.email ?? ""}`}
                    onSelect={() => runUser(u)}
                    className="gap-3"
                  >
                    <Avatar size="sm">
                      {u.image && <AvatarImage src={u.image} alt={u.username ?? u.id} />}
                      <AvatarFallback>{initials(u.username ?? u.email)}</AvatarFallback>
                    </Avatar>
                    <div className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate text-sm font-medium">
                        {u.username ?? <span className="text-muted-foreground">(no username)</span>}
                      </span>
                      {u.email && (
                        <span className="truncate text-xs text-muted-foreground">
                          {u.email}
                        </span>
                      )}
                    </div>
                    <Badge
                      variant="outline"
                      className={cn("shrink-0", ROLE_COLORS[u.role] ?? ROLE_COLORS.user)}
                    >
                      {u.role}
                    </Badge>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}

            {/* Navigation — always shown; cmdk filters rows by the input. */}
            {visibleNav.length > 0 && (
              <CommandGroup heading={PALETTE_SECTION_LABELS.navigation}>
                {visibleNav.map((cmd) => (
                  <CommandItem
                    key={cmd.id}
                    value={`${cmd.label} ${cmd.description ?? ""} ${(cmd.keywords ?? []).join(" ")} ${cmd.href}`}
                    onSelect={() => runNav(cmd)}
                  >
                    <cmd.icon className="size-4 text-muted-foreground" />
                    <div className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate">{cmd.label}</span>
                      {cmd.description && (
                        <span className="truncate text-xs text-muted-foreground">
                          {cmd.description}
                        </span>
                      )}
                    </div>
                    <CommandShortcut>{cmd.href}</CommandShortcut>
                  </CommandItem>
                ))}
              </CommandGroup>
            )}

            {/* Quick Actions — anything that doesn't just navigate. */}
            {visibleActions.length > 0 && (
              <CommandGroup heading={PALETTE_SECTION_LABELS.actions}>
                {visibleActions.map((cmd) => (
                  <CommandItem
                    key={cmd.id}
                    value={`${cmd.label} ${cmd.description ?? ""} ${(cmd.keywords ?? []).join(" ")}`}
                    onSelect={() => {
                      void runAction(cmd).catch((err) => {
                        toast.error(
                          err instanceof Error
                            ? err.message
                            : "Action failed",
                        );
                      });
                    }}
                  >
                    <cmd.icon className="size-4 text-muted-foreground" />
                    <div className="flex min-w-0 flex-1 flex-col">
                      <span className="truncate">{cmd.label}</span>
                      {cmd.description && (
                        <span className="truncate text-xs text-muted-foreground">
                          {cmd.description}
                        </span>
                      )}
                    </div>
                    {cmd.shortcut && (
                      <CommandShortcut>{cmd.shortcut}</CommandShortcut>
                    )}
                  </CommandItem>
                ))}
              </CommandGroup>
            )}
          </CommandList>
        </Command>
      </CommandDialog>
    </>
  );
}

/**
 * Small floating affordance in the bottom-left. Persistent and visible so
 * click-users can find the palette without memorising ⌘K. Keeps out of the
 * way of the existing bottom-right ChatPanel FAB.
 */
function PaletteTriggerButton({ onClick }: { onClick: () => void }) {
  return (
    <Button
      onClick={onClick}
      variant="outline"
      size="sm"
      aria-label="Open command palette"
      title="Open command palette (⌘K)"
      className="fixed bottom-6 left-6 z-40 h-9 gap-2 rounded-full border-border/60 bg-background/80 pr-3 pl-3 shadow-sm backdrop-blur-sm hover:bg-accent"
    >
      <SearchIcon className="size-3.5 text-muted-foreground" />
      <span className="text-xs text-muted-foreground">Search</span>
      <kbd className="pointer-events-none ml-1 inline-flex h-5 select-none items-center gap-1 rounded border bg-muted px-1.5 font-mono text-[10px] font-medium text-muted-foreground">
        <span className="text-[11px]">{typeof navigator !== "undefined" && /mac/i.test(navigator.platform) ? "⌘" : "Ctrl"}</span>
        K
      </kbd>
    </Button>
  );
}
