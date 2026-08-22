import type { DbEnv } from "@/lib/db-env";

export type EosObservedCreatorBattle = {
  environment: DbEnv;
  battleId: string;
  creatorUserId: string;
  creatorUsername: string | null;
  createdAt: string;
  mode: string;
  currency: string;
  status: string;
  creatorTeam: number;
  winnerTeam: number | null;
  creatorWonBattle: boolean | null;
  creatorCost: number;
  creatorPayout: number | null;
  creatorProfitLoss: number | null;
  creatorMultiplier: number | null;
};
