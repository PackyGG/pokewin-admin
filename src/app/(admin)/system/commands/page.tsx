// Docs page for the global command palette. Lists every command the
// palette understands so admins can discover features without having to
// memorise the CMD+K vocabulary.
//
// Single source of truth: the command list lives in src/lib/commands.ts
// and is rendered here via getNavCommandsByDocsGroup() + ACTION_COMMANDS
// so new commands automatically surface on this page.

import { Command, Keyboard } from "lucide-react";
import { requirePageAccess } from "@/lib/dal";
import { PageHero, SectionHeading, KpiTile } from "@/components/modern-panels";
import {
  ACTION_COMMANDS,
  EXAMPLE_QUERIES,
  NAV_COMMANDS,
  getNavCommandsByDocsGroup,
  type ActionCommand,
  type NavCommand,
} from "@/lib/commands";

export const metadata = { title: "Commands" };

export default async function CommandsDocsPage() {
  await requirePageAccess("/system/commands");

  const navGroups = getNavCommandsByDocsGroup();
  const totalCommands = NAV_COMMANDS.length + ACTION_COMMANDS.length;

  return (
    <div className="space-y-6">
      <PageHero>
        <div className="flex items-center gap-3">
          <div className="flex size-10 items-center justify-center rounded-xl bg-primary/10">
            <Keyboard className="size-5 text-primary" />
          </div>
          <div>
            <h1 className="text-2xl font-bold leading-tight">Commands</h1>
            <p className="text-sm text-muted-foreground">
              Press{" "}
              <Kbd>
                {/* We can't feature-detect platform server-side; show both. */}
                <span className="hidden md:inline">⌘</span>
                <span className="md:hidden">Ctrl</span>
              </Kbd>{" "}
              <Kbd>K</Kbd> from any admin page to open the palette. Type to
              jump to a page, run a quick action, or search end-users with
              an <code className="rounded bg-muted px-1 py-0.5 text-xs">@</code>{" "}
              prefix.
            </p>
          </div>
        </div>
      </PageHero>

      <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
        <KpiTile
          label="Total commands"
          value={String(totalCommands)}
          icon={Command}
          accent="blue"
        />
        <KpiTile
          label="Navigation"
          value={String(NAV_COMMANDS.length)}
          icon={Command}
          accent="purple"
        />
        <KpiTile
          label="Quick actions"
          value={String(ACTION_COMMANDS.length)}
          icon={Command}
          accent="cyan"
        />
      </div>

      {/* Examples ─────────────────────────────────────────────────── */}
      <div className="space-y-3">
        <SectionHeading icon={Keyboard} title="Example queries" />
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          {EXAMPLE_QUERIES.map((ex) => (
            <div
              key={ex.query}
              className="rounded-xl border bg-card p-4 transition-colors hover:border-border/80"
            >
              <code className="inline-block rounded-md bg-muted px-2 py-1 font-mono text-sm">
                {ex.query}
              </code>
              <p className="mt-2 text-sm text-muted-foreground">{ex.what}</p>
            </div>
          ))}
        </div>
      </div>

      {/* Quick Actions ───────────────────────────────────────────── */}
      <div className="space-y-3">
        <SectionHeading icon={Command} title="Quick actions" />
        <CommandTable commands={ACTION_COMMANDS} />
      </div>

      {/* Navigation (grouped) ────────────────────────────────────── */}
      <div className="space-y-3">
        <SectionHeading icon={Command} title="Navigation" />
        <div className="space-y-4">
          {navGroups.map((group) => (
            <div key={group.label} className="rounded-xl border bg-card">
              <div className="border-b px-4 py-2">
                <h3 className="text-xs font-semibold uppercase tracking-wider text-muted-foreground">
                  {group.label}
                </h3>
              </div>
              <CommandTable commands={group.items} plain />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}

/**
 * Compact command-list row. Used for both nav and action tables. When
 * `plain` is true, the surrounding card chrome is skipped (the caller
 * already provides one — e.g. the per-group nav cards).
 */
function CommandTable({
  commands,
  plain = false,
}: {
  commands: ReadonlyArray<NavCommand | ActionCommand>;
  plain?: boolean;
}) {
  const inner = (
    <div className="divide-y">
      {commands.map((cmd) => {
        const Icon = cmd.icon;
        const trailing =
          cmd.kind === "nav" ? (
            <code className="rounded-md bg-muted px-2 py-0.5 font-mono text-xs text-muted-foreground">
              {cmd.href}
            </code>
          ) : cmd.run.type === "navigate" ? (
            <code className="rounded-md bg-muted px-2 py-0.5 font-mono text-xs text-muted-foreground">
              {cmd.run.href}
            </code>
          ) : cmd.run.type === "theme" ? (
            <span className="text-xs text-muted-foreground">
              theme → {cmd.run.mode}
            </span>
          ) : cmd.run.type === "logout" ? (
            <span className="text-xs text-muted-foreground">signs out</span>
          ) : (
            <span className="text-xs text-muted-foreground">
              opens user search
            </span>
          );
        return (
          <div
            key={cmd.id}
            className="flex items-center gap-3 px-4 py-3 text-sm"
          >
            <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted/50">
              <Icon className="size-4 text-muted-foreground" />
            </div>
            <div className="min-w-0 flex-1">
              <div className="truncate font-medium">{cmd.label}</div>
              {cmd.description && (
                <div className="truncate text-xs text-muted-foreground">
                  {cmd.description}
                </div>
              )}
            </div>
            <div className="shrink-0">{trailing}</div>
          </div>
        );
      })}
    </div>
  );

  if (plain) return inner;
  return <div className="overflow-hidden rounded-xl border bg-card">{inner}</div>;
}

function Kbd({ children }: { children: React.ReactNode }) {
  return (
    <kbd className="pointer-events-none inline-flex h-5 select-none items-center gap-1 rounded border bg-muted px-1.5 font-mono text-[10px] font-medium text-muted-foreground">
      {children}
    </kbd>
  );
}
