import { z } from "zod";

import type { DbEnv } from "@/lib/db-env";

export const eosPlayerPeriodSchema = z.enum(["24h", "7d", "30d"]);
export const eosPlayerCurrencySchema = z.enum(["real", "coin"]);
export const eosPlayerSortSchema = z.enum([
  "luck",
  "battles",
  "volume",
  "largest",
]);

export const eosPlayerIntelligenceInputSchema = z.object({
  period: eosPlayerPeriodSchema.default("7d"),
  currency: eosPlayerCurrencySchema.default("real"),
  sort: eosPlayerSortSchema.default("luck"),
  minBattles: z.number().int().min(1).max(100).default(5),
  minBattleValue: z.number().min(0).max(1_000_000).default(0),
  limit: z.number().int().min(10).max(100).default(50),
}).strict();

export type EosPlayerIntelligenceInput = z.infer<typeof eosPlayerIntelligenceInputSchema>;

export type EosPlayerSignal = {
  userId: string;
  username: string | null;
  role: string;
  battleCount: number;
  wins: number;
  losses: number;
  winRate: number;
  luckEligibleBattles: number;
  luckWins: number;
  expectedWins: number;
  expectedWinRate: number;
  luckScore: number | null;
  totalCreatorCost: number;
  averageCreatorCost: number;
  largestCreatorCost: number;
  largestPotValue: number;
  estimatedPayout: number;
  estimatedNetPnl: number;
  lastBattleAt: string;
  signal: "strong" | "elevated" | "none";
};

export type EosPlayerIntelligence = {
  environment: DbEnv;
  generatedAt: string;
  period: EosPlayerIntelligenceInput["period"];
  currency: EosPlayerIntelligenceInput["currency"];
  sort: EosPlayerIntelligenceInput["sort"];
  minBattles: number;
  matchingPlayers: number;
  matchingBattles: number;
  rows: EosPlayerSignal[];
};
