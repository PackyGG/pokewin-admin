import { Target } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { formatCurrency, formatDateTime, formatNumber } from "@/lib/utils/format";
import { EmptyState } from "@/components/empty-state";
import type { Challenge } from "@/lib/backend-api";
import { EditChallengeButton } from "./edit-challenge-button";
import { ArchiveChallengeButton } from "./archive-challenge-button";

const STATUS_COLORS: Record<string, string> = {
  active:
    "bg-emerald-500/15 text-emerald-600 dark:text-emerald-400 border-emerald-500/30",
  inactive:
    "bg-amber-500/15 text-amber-600 dark:text-amber-400 border-amber-500/30",
  archived:
    "bg-zinc-500/15 text-zinc-600 dark:text-zinc-400 border-zinc-500/30",
};

// Kind badge derived from `type` — the two creatable kinds.
function kindLabel(c: Challenge): string {
  return c.type === "pack_pull" ? "Card hit" : "Upgrader hit";
}

const KIND_COLORS: Record<string, string> = {
  pack_pull: "bg-blue-500/15 text-blue-600 dark:text-blue-400 border-blue-500/30",
  upgrader: "bg-purple-500/15 text-purple-600 dark:text-purple-400 border-purple-500/30",
};

function ChallengeMobileCard({ c }: { c: Challenge }) {
  return (
    <div className="border-b border-border/60 last:border-b-0 px-3 py-3">
      <div className="flex items-start gap-3">
        <div className="flex size-9 items-center justify-center rounded-md bg-rose-500/10 shrink-0">
          <Target className="size-4 text-rose-500" />
        </div>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2 flex-wrap">
            <span className="text-sm font-medium truncate">{c.name}</span>
            <Badge
              variant="outline"
              className={"h-4 px-1 text-[9px] " + (KIND_COLORS[c.type] ?? "")}
            >
              {kindLabel(c)}
            </Badge>
            <Badge
              variant="outline"
              className={"h-4 px-1 text-[9px] capitalize " + (STATUS_COLORS[c.status] ?? "")}
            >
              {c.status}
            </Badge>
          </div>
          <div className="mt-1 grid grid-cols-2 gap-x-3 text-[11px] text-muted-foreground">
            <div>
              <span className="text-[9px] uppercase tracking-wide">Prize</span>
              {/* Prize = house gives the user money → user-gain → rose. */}
              <div className="tabular-nums text-rose-600 dark:text-rose-400">
                {formatCurrency(c.prize_amount)}
              </div>
            </div>
            <div>
              <span className="text-[9px] uppercase tracking-wide">Claims</span>
              <div className="tabular-nums">
                {formatNumber(c.claimed_count)} / {formatNumber(c.max_claims)}
              </div>
            </div>
          </div>
          <div className="mt-1 text-[10px] text-muted-foreground">
            Created {formatDateTime(c.created_at)}
          </div>
        </div>
        <div className="shrink-0 flex flex-col items-end gap-1">
          <EditChallengeButton
            challengeId={c.id}
            name={c.name}
            prizeAmount={c.prize_amount}
            maxClaims={c.max_claims}
            claimedCount={c.claimed_count}
            status={c.status}
            version={c.version}
          />
          {c.status !== "archived" && (
            <ArchiveChallengeButton challengeId={c.id} version={c.version} />
          )}
        </div>
      </div>
    </div>
  );
}

export function ChallengesTable({ data }: { data: Challenge[] }) {
  return (
    <>
      {/* Mobile card list (<lg) */}
      <div className="lg:hidden">
        {data.length === 0 ? (
          <div className="rounded-md border">
            <EmptyState
              icon={Target}
              title="No challenges found"
              description="Create a challenge to reward players for hitting a target card or upgrader outcome."
              compact
            />
          </div>
        ) : (
          <div className="overflow-hidden rounded-md border">
            {data.map((c) => (
              <ChallengeMobileCard key={c.id} c={c} />
            ))}
          </div>
        )}
      </div>

      {/* Desktop table (>=lg) */}
      <div className="hidden rounded-md border overflow-x-auto lg:block">
        <Table>
          <TableHeader>
            <TableRow>
              <TableHead>Name</TableHead>
              <TableHead>Kind</TableHead>
              <TableHead>Prize</TableHead>
              <TableHead>Claims</TableHead>
              <TableHead>Status</TableHead>
              <TableHead>Created</TableHead>
              <TableHead className="w-[160px]" />
            </TableRow>
          </TableHeader>
          <TableBody>
            {data.map((c) => (
              <TableRow key={c.id}>
                <TableCell className="font-medium">{c.name}</TableCell>
                <TableCell>
                  <Badge variant="outline" className={KIND_COLORS[c.type] ?? ""}>
                    {kindLabel(c)}
                  </Badge>
                </TableCell>
                {/* Prize = house gives the user money → user-gain → rose. */}
                <TableCell className="tabular-nums text-rose-600 dark:text-rose-400">
                  {formatCurrency(c.prize_amount)}
                </TableCell>
                <TableCell className="tabular-nums">
                  {formatNumber(c.claimed_count)} / {formatNumber(c.max_claims)}
                </TableCell>
                <TableCell>
                  <Badge
                    variant="outline"
                    className={"capitalize " + (STATUS_COLORS[c.status] ?? "")}
                  >
                    {c.status}
                  </Badge>
                </TableCell>
                <TableCell>{formatDateTime(c.created_at)}</TableCell>
                <TableCell>
                  <div className="flex items-center justify-end gap-1">
                    <EditChallengeButton
                      challengeId={c.id}
                      name={c.name}
                      prizeAmount={c.prize_amount}
                      maxClaims={c.max_claims}
                      claimedCount={c.claimed_count}
                      status={c.status}
                      version={c.version}
                    />
                    {c.status !== "archived" && (
                      <ArchiveChallengeButton challengeId={c.id} version={c.version} />
                    )}
                  </div>
                </TableCell>
              </TableRow>
            ))}
            {data.length === 0 && (
              <TableRow className="hover:bg-transparent">
                <TableCell colSpan={7} className="p-0">
                  <EmptyState
                    icon={Target}
                    title="No challenges found"
                    description="Create a challenge to reward players for hitting a target card or upgrader outcome."
                    compact
                  />
                </TableCell>
              </TableRow>
            )}
          </TableBody>
        </Table>
      </div>
    </>
  );
}
