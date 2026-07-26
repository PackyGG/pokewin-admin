import { queryMainRows } from "@/lib/drizzle-query";
import "server-only";

import { toNumber } from "@/lib/utils/decimal";
import { withTiming } from "@/lib/observability/query-timings";
import { ggr as ggrFormula } from "@/lib/metrics/formulas";

/**
 * Per-battle drilldown for the Battles tab. Returns one battle's
 * full picture:
 *
 *   • Battle row (mode, pot, status, borrow %, sponsorship %, packs)
 *   • Participants (user/bot, team, bet, total payout, P&L per player)
 *   • Winner team
 *
 * Read-only — battle ids are surfaced from the existing top-battles
 * table on the parent tab, so the lookup is bounded to ids the user
 * already saw on the page. UUID-validated defensively.
 */

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export type BattleParticipantRow = {
  id: string;
  userId: string | null;
  botId: string | null;
  username: string | null;
  image: string | null;
  teamNumber: number;
  teamPosition: number;
  isBot: boolean;
  isWinner: boolean;
  betAmount: number;
  payout: number;
  pnl: number;
};

export type BattlePackRow = {
  id: string;
  name: string;
  imageUrl: string | null;
  price: number;
};

export type BattleDrilldownData = {
  battleId: string;
  mode: string;
  status: string;
  teams: number;
  playersPerTeam: number;
  betAmount: number;
  totalPot: number;
  totalPayout: number;
  housePnl: number;
  winnerTeam: number | null;
  borrowPercentage: number;
  sponsorshipPercentage: number;
  createdAt: string;
  packs: BattlePackRow[];
  participants: BattleParticipantRow[];
};

export async function getBattleDrilldown(
  battleId: string,
): Promise<BattleDrilldownData | null> {
  if (!UUID_RE.test(battleId)) return null;
  return withTiming("insights-games.battle-drilldown", async () => {

    type BattleRow = {
      id: string;
      mode: string;
      status: string;
      teams: string;
      players_per_team: string;
      bet_amount: string;
      winner_team: string | null;
      borrow_percentage: string | null;
      sponsorship_percentage: string | null;
      pack_ids: string[];
      created_at: Date;
    };
    type ParticipantRow = {
      id: string;
      user_id: string | null;
      bot_id: string | null;
      username: string | null;
      bot_username: string | null;
      user_image: string | null;
      bot_image: string | null;
      team_number: string;
      team_position: string;
      game_session_id: string;
      payout: string;
    };
    type PackRow = {
      id: string;
      name: string;
      image_url: string | null;
      price: string;
    };

    const [battleRows, participantRows] = await Promise.all([
      queryMainRows<BattleRow[]>(
        `SELECT
           b.id::text AS id,
           b.mode::text AS mode,
           b.status::text AS status,
           b.teams::text AS teams,
           b.players_per_team::text AS players_per_team,
           b.bet_amount::text AS bet_amount,
           b.winner_team::text AS winner_team,
           b.borrow_percentage::text AS borrow_percentage,
           b.sponsorship_percentage::text AS sponsorship_percentage,
           b.pack_ids AS pack_ids,
           b.created_at AS created_at
         FROM battles b
         WHERE b.id = '${battleId}'::uuid
         LIMIT 1`,
      ),
      queryMainRows<ParticipantRow[]>(
        `SELECT
           bp.id::text AS id,
           bp.user_id AS user_id,
           bp.bot_id::text AS bot_id,
           u.username AS username,
           bot.username AS bot_username,
           u.image AS user_image,
           bot.image_url AS bot_image,
           bp.team_number::text AS team_number,
           bp.team_position::text AS team_position,
           bp.game_session_id::text AS game_session_id,
           COALESCE((
             SELECT SUM(ui.value_at_obtained::numeric)::text
             FROM user_inventory ui
             WHERE ui.source_type = 'battle' AND ui.source_id = bp.game_session_id
           ), '0') AS payout
         FROM battle_participants bp
         LEFT JOIN "user" u ON u.id = bp.user_id
         LEFT JOIN bots bot ON bot.id = bp.bot_id
         WHERE bp.battle_id = '${battleId}'::uuid
         ORDER BY bp.team_number, bp.team_position`,
      ),
    ]);
    if (battleRows.length === 0) return null;
    const battle = battleRows[0];

    // Fetch the packs that are on this battle. pack_ids is text[]
    // (UUID-shaped) — use ANY(...) to map.
    const packIds = battle.pack_ids ?? [];
    let packs: PackRow[] = [];
    if (packIds.length > 0) {
      packs = await queryMainRows<PackRow[]>(
        `SELECT id::text AS id, name, image_url, price::text AS price
         FROM packs
         WHERE id = ANY(ARRAY[${packIds.map((id) => `'${id}'::uuid`).join(",")}])
         ORDER BY price DESC`,
      );
    }

    const teamsCount = Number(battle.teams);
    const playersPerTeam = Number(battle.players_per_team);
    const betAmount = toNumber(battle.bet_amount);
    const totalPot = betAmount * teamsCount * playersPerTeam;
    const winnerTeam =
      battle.winner_team != null ? Number(battle.winner_team) : null;

    const participants: BattleParticipantRow[] = participantRows.map((p) => {
      const payout = toNumber(p.payout);
      const teamNumber = Number(p.team_number);
      const isBot = p.bot_id != null;
      return {
        id: p.id,
        userId: p.user_id,
        botId: p.bot_id,
        username: isBot ? p.bot_username : p.username,
        image: isBot ? p.bot_image : p.user_image,
        teamNumber,
        teamPosition: Number(p.team_position),
        isBot,
        isWinner: winnerTeam != null && teamNumber === winnerTeam,
        betAmount,
        payout,
        // House-POV P&L per participant via the canonical GGR helper.
        pnl: ggrFormula({ wager: betAmount, gamingPayout: payout }),
      };
    });

    const totalPayout = participants.reduce((s, p) => s + p.payout, 0);

    return {
      battleId: battle.id,
      mode: battle.mode,
      status: battle.status,
      teams: teamsCount,
      playersPerTeam,
      betAmount,
      totalPot,
      totalPayout,
      // House-POV P&L via the canonical GGR helper (pot collected − cards paid).
      housePnl: ggrFormula({ wager: totalPot, gamingPayout: totalPayout }),
      winnerTeam,
      borrowPercentage: Number(battle.borrow_percentage ?? "0"),
      sponsorshipPercentage: Number(battle.sponsorship_percentage ?? "0"),
      createdAt: battle.created_at.toISOString(),
      packs: packs.map((p) => ({
        id: p.id,
        name: p.name,
        imageUrl: p.image_url,
        price: toNumber(p.price),
      })),
      participants,
    };
  });
}
