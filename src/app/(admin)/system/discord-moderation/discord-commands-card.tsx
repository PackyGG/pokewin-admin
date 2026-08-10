"use client";

import { useMemo, useState } from "react";
import { Check, Filter, LockKeyhole, Minus, Search, TerminalSquare, Users } from "lucide-react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { Input } from "@/components/ui/input";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import {
  DISCORD_COMMAND_CATALOG,
  DISCORD_SURFACES,
  type DiscordSurfaceId,
} from "@/lib/discord-command-catalog";
import { cn } from "@/lib/utils";

type AccessFilter = "all" | "everyone" | "restricted";

const ACCESS = {
  everyone: { label: "Everyone", className: "border-emerald-500/30 bg-emerald-500/10 text-emerald-700 dark:text-emerald-300" },
  linked: { label: "Linked account", className: "border-sky-500/30 bg-sky-500/10 text-sky-700 dark:text-sky-300" },
  section: { label: "Linked section", className: "border-violet-500/30 bg-violet-500/10 text-violet-700 dark:text-violet-300" },
  staff: { label: "Staff only", className: "border-amber-500/30 bg-amber-500/10 text-amber-700 dark:text-amber-300" },
} as const;

function Availability({ available, label }: { available: boolean; label: string }) {
  return available ? (
    <span className="inline-flex size-7 items-center justify-center rounded-full bg-emerald-500/12 text-emerald-600 ring-1 ring-emerald-500/20 dark:text-emerald-400" aria-label={`Available in ${label}`}>
      <Check className="size-4" /> <span className="sr-only">Available</span>
    </span>
  ) : (
    <span className="inline-flex text-muted-foreground/45" aria-label={`Not available in ${label}`}>
      <Minus className="size-4" /> <span className="sr-only">Not available</span>
    </span>
  );
}

function ScopeBadge({ surfaces }: { surfaces: readonly DiscordSurfaceId[] }) {
  if (surfaces.length === DISCORD_SURFACES.length) {
    return <Badge variant="outline" className="border-primary/30 bg-primary/10 text-primary">Everywhere</Badge>;
  }
  if (surfaces.length === 1) {
    const surface = DISCORD_SURFACES.find((entry) => entry.id === surfaces[0]);
    return <Badge className="bg-rose-600 text-white hover:bg-rose-600">{surface?.label} only</Badge>;
  }
  return (
    <Badge variant="outline" className="border-slate-500/30 bg-slate-500/10">
      {surfaces.length} locations{surfaces.includes("dm") ? "" : " · No DMs"}
    </Badge>
  );
}

export function DiscordCommandsCard() {
  const [query, setQuery] = useState("");
  const [surface, setSurface] = useState<"all" | DiscordSurfaceId>("all");
  const [access, setAccess] = useState<AccessFilter>("all");
  const [exclusiveOnly, setExclusiveOnly] = useState(false);
  const totals = Object.fromEntries(DISCORD_SURFACES.map((surface) => [
    surface.id,
    DISCORD_COMMAND_CATALOG.filter((command) => command.surfaces.includes(surface.id as DiscordSurfaceId)).length,
  ]));
  const filtered = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return DISCORD_COMMAND_CATALOG.filter((command) => {
      if (surface !== "all" && !command.surfaces.includes(surface)) return false;
      if (access === "everyone" && command.access !== "everyone") return false;
      if (access === "restricted" && command.access === "everyone") return false;
      if (exclusiveOnly && command.surfaces.length !== 1) return false;
      return !needle || [command.name, command.description, command.restriction]
        .some((value) => value.toLowerCase().includes(needle));
    });
  }, [access, exclusiveOnly, query, surface]);

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center gap-2">
          <TerminalSquare className="size-5 text-primary" />
          <CardTitle>Discord command access</CardTitle>
        </div>
        <CardDescription>
          Complete live command policy for all four Packy servers and one-to-one bot DMs. A dash means the command is not registered there.
        </CardDescription>
      </CardHeader>
      <CardContent className="space-y-5">
        <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-5">
          {DISCORD_SURFACES.map((surfaceOption) => (
            <button
              type="button"
              key={surfaceOption.id}
              onClick={() => setSurface((current) => current === surfaceOption.id ? "all" : surfaceOption.id)}
              className={cn(
                "rounded-xl border bg-muted/20 p-3 text-left transition hover:border-primary/40 hover:bg-muted/40",
                surfaceOption.id === surface && "border-primary bg-primary/5 ring-1 ring-primary/20",
              )}
            >
              <p className="font-medium">{surfaceOption.label}</p>
              <p className="text-xs text-muted-foreground">
                {totals[surfaceOption.id]} commands{surfaceOption.guildId ? ` · ${surfaceOption.guildId}` : " · one-to-one only"}
              </p>
            </button>
          ))}
        </div>

        <div className="rounded-xl border bg-muted/10 p-3">
          <div className="flex flex-col gap-3 xl:flex-row xl:items-center">
            <div className="relative min-w-64 flex-1">
              <Search className="absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
              <Input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Search commands or restrictions…"
                aria-label="Search Discord commands"
                className="pl-9"
              />
            </div>
            <div className="flex flex-wrap gap-2">
              {(["all", "everyone", "restricted"] as const).map((value) => (
                <Button
                  key={value}
                  size="sm"
                  variant={access === value ? "default" : "outline"}
                  onClick={() => setAccess(value)}
                >
                  {value === "all" ? <Filter /> : value === "everyone" ? <Users /> : <LockKeyhole />}
                  {value === "all" ? "All access" : value === "everyone" ? "Everyone" : "Restricted"}
                </Button>
              ))}
              <Button
                size="sm"
                variant={exclusiveOnly ? "default" : "outline"}
                onClick={() => setExclusiveOnly((current) => !current)}
              >
                Exclusive only
              </Button>
            </div>
          </div>
          <p className="mt-2 text-xs text-muted-foreground">
            Showing {filtered.length} of {DISCORD_COMMAND_CATALOG.length} commands
            {surface !== "all" ? ` available in ${DISCORD_SURFACES.find((entry) => entry.id === surface)?.label}` : ""}.
          </p>
        </div>

        <div className="rounded-xl border">
          <Table zebra>
            <TableHeader>
              <TableRow>
                <TableHead className="min-w-52">Command</TableHead>
                {DISCORD_SURFACES.map((surface) => (
                  <TableHead key={surface.id} className="text-center">{surface.label}</TableHead>
                ))}
                <TableHead className="min-w-96">Restrictions</TableHead>
              </TableRow>
            </TableHeader>
            <TableBody>
              {filtered.map((command) => (
                <TableRow key={command.name}>
                  <TableCell className="whitespace-normal">
                    <div className="flex flex-wrap items-center gap-2">
                      <code className="font-semibold">/{command.name}</code>
                      <ScopeBadge surfaces={command.surfaces} />
                    </div>
                    <p className="mt-1 text-xs text-muted-foreground">{command.description}</p>
                  </TableCell>
                  {DISCORD_SURFACES.map((surface) => (
                    <TableCell key={surface.id} className="text-center">
                      <Availability available={command.surfaces.includes(surface.id)} label={surface.label} />
                    </TableCell>
                  ))}
                  <TableCell className="whitespace-normal text-xs leading-relaxed text-muted-foreground">
                    <Badge variant="outline" className={ACCESS[command.access].className}>
                      {ACCESS[command.access].label}
                    </Badge>
                    <p className="mt-1.5">{command.restriction}</p>
                  </TableCell>
                </TableRow>
              ))}
              {filtered.length === 0 ? (
                <TableRow>
                  <TableCell colSpan={DISCORD_SURFACES.length + 2} className="h-28 text-center text-muted-foreground">
                    No commands match these filters.
                  </TableCell>
                </TableRow>
              ) : null}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}
