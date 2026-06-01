import Image from "next/image";
import Link from "next/link";
import { Trophy, Crown, Frown } from "lucide-react";
import { FadeIn } from "@/components/fade-in";
import { SectionHeading } from "@/components/modern-panels";
import { formatCompactUsd, formatNumber } from "@/lib/utils/format";
import { getGamesTopUsers } from "@/lib/queries/insights-games/top-users";
import type { GamesPeriod } from "@/lib/queries/insights-games/_shared";
import type { GamesLeaderboardRow } from "@/lib/queries/insights-games/top-users";
import { labelForPeriod } from "@/lib/queries/insights-games/_shared";

/**
 * Per-user leaderboards: top wagerers, winners (user POV), losers
 * (user POV). All scopes match the rest of the page — real
 * customers only, borrow-corrected wager, creator-stream excluded.
 *
 * Winners + losers are flipped: top winners = users who came out
 * ahead → house loss (rose tint on the net). Top losers = users
 * down → house gain (emerald tint). Matches the project-wide
 * house-POV color convention.
 */
export async function UsersTab({ period }: { period: GamesPeriod }) {
  const data = await getGamesTopUsers(period);
  return (
    <FadeIn>
      <div className="space-y-6">
        <p className="text-xs text-muted-foreground">
          Wager is what each user actually paid out of balance
          (post-borrow). Net is wager − payouts (positive = house
          gained on them; negative = they won net). Period:{" "}
          {labelForPeriod(period)}.
        </p>

        <Leaderboard
          title="Top wagerers"
          icon={Trophy}
          rows={data.topWagerers}
          metric="wager"
          tone="emerald"
        />

        <Leaderboard
          title="Top winners (user POV — house loss)"
          icon={Crown}
          rows={data.topWinners}
          metric="userWin"
          tone="rose"
        />

        <Leaderboard
          title="Top losers (user POV — house gain)"
          icon={Frown}
          rows={data.topLosers}
          metric="houseGain"
          tone="emerald"
        />
      </div>
    </FadeIn>
  );
}

function Leaderboard({
  title,
  icon: Icon,
  rows,
  metric,
  tone,
}: {
  title: string;
  icon: typeof Trophy;
  rows: GamesLeaderboardRow[];
  metric: "wager" | "userWin" | "houseGain";
  tone: "emerald" | "rose";
}) {
  // metric drives BOTH the headline column and the color rule on
  // it. Color tone is house-POV (caller sets it explicitly).
  const headline = (r: GamesLeaderboardRow): number => {
    switch (metric) {
      case "wager":
        return r.wager;
      case "userWin":
        return r.payouts - r.wager;
      case "houseGain":
        return r.pnl;
    }
  };
  const headlineLabel =
    metric === "wager" ? "Wager" : metric === "userWin" ? "Net win" : "House gain";
  const headlineColor =
    tone === "emerald"
      ? "text-emerald-600 dark:text-emerald-400"
      : "text-rose-600 dark:text-rose-400";

  return (
    <div className="space-y-3">
      <SectionHeading icon={Icon} title={title} />
      {rows.length === 0 ? (
        <div className="rounded-2xl border bg-card p-6 text-center text-sm text-muted-foreground">
          No customers in this bucket for the period.
        </div>
      ) : (
        <div className="overflow-hidden rounded-2xl border bg-card">
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead className="border-b bg-muted/40 text-xs uppercase tracking-wider text-muted-foreground">
                <tr>
                  <th className="px-3 py-2 text-left font-semibold">#</th>
                  <th className="px-3 py-2 text-left font-semibold">User</th>
                  <th className="px-3 py-2 text-right font-semibold">Plays</th>
                  <th className="px-3 py-2 text-right font-semibold">Wager</th>
                  <th className="px-3 py-2 text-right font-semibold">Payout</th>
                  <th className="px-3 py-2 text-right font-semibold">{headlineLabel}</th>
                </tr>
              </thead>
              <tbody>
                {rows.map((r, i) => (
                  <tr key={r.userId} className="border-b last:border-0 hover:bg-muted/30">
                    <td className="px-3 py-2 tabular-nums text-muted-foreground">
                      {i + 1}
                    </td>
                    <td className="px-3 py-2">
                      <Link
                        href={`/users/${r.userId}`}
                        className="flex items-center gap-2 hover:underline"
                      >
                        {r.image ? (
                          <Image
                            src={r.image}
                            alt={r.username ?? "user"}
                            width={28}
                            height={28}
                            className="size-7 rounded-full object-cover"
                            unoptimized
                          />
                        ) : (
                          <div className="size-7 rounded-full bg-muted" />
                        )}
                        <span className="font-medium">{r.username ?? "—"}</span>
                      </Link>
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums">
                      {formatNumber(r.plays)}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-emerald-600 dark:text-emerald-400">
                      {formatCompactUsd(r.wager)}
                    </td>
                    <td className="px-3 py-2 text-right tabular-nums text-rose-600 dark:text-rose-400">
                      {formatCompactUsd(r.payouts)}
                    </td>
                    <td className={`px-3 py-2 text-right tabular-nums font-medium ${headlineColor}`}>
                      {formatCompactUsd(headline(r))}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
