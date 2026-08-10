import { Check, Minus, TerminalSquare } from "lucide-react";

import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
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

function Availability({ available, label }: { available: boolean; label: string }) {
  return available ? (
    <span className="inline-flex items-center gap-1 text-emerald-600 dark:text-emerald-400" aria-label={`Available in ${label}`}>
      <Check className="size-4" /> <span className="sr-only">Available</span>
    </span>
  ) : (
    <span className="inline-flex text-muted-foreground/45" aria-label={`Not available in ${label}`}>
      <Minus className="size-4" /> <span className="sr-only">Not available</span>
    </span>
  );
}

export function DiscordCommandsCard() {
  const totals = Object.fromEntries(DISCORD_SURFACES.map((surface) => [
    surface.id,
    DISCORD_COMMAND_CATALOG.filter((command) => command.surfaces.includes(surface.id as DiscordSurfaceId)).length,
  ]));

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
          {DISCORD_SURFACES.map((surface) => (
            <div key={surface.id} className="rounded-xl border bg-muted/20 p-3">
              <p className="font-medium">{surface.label}</p>
              <p className="text-xs text-muted-foreground">
                {totals[surface.id]} commands{surface.guildId ? ` · ${surface.guildId}` : " · one-to-one only"}
              </p>
            </div>
          ))}
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
              {DISCORD_COMMAND_CATALOG.map((command) => (
                <TableRow key={command.name}>
                  <TableCell className="whitespace-normal">
                    <code className="font-semibold">/{command.name}</code>
                    <p className="mt-1 text-xs text-muted-foreground">{command.description}</p>
                  </TableCell>
                  {DISCORD_SURFACES.map((surface) => (
                    <TableCell key={surface.id} className="text-center">
                      <Availability available={command.surfaces.includes(surface.id)} label={surface.label} />
                    </TableCell>
                  ))}
                  <TableCell className="whitespace-normal text-xs leading-relaxed text-muted-foreground">
                    {command.restriction}
                  </TableCell>
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </div>
      </CardContent>
    </Card>
  );
}
