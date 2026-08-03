import { z } from "zod";

/**
 * The Fiat perk wire contract — shapes, scopes and limits shared by the server
 * transport (`fiat-perks-api.ts`) and the client workspace. Deliberately free
 * of `server-only` so the review UI can import the same definitions the reads
 * are validated against, instead of restating them and drifting.
 */

export const FIAT_PERK_SCOPES = [
  "all",
  "selected_accounts",
  "crypto_depositors",
  "prior_fiat",
  "active_players",
  "country",
  "never_screened",
] as const;
export type FiatPerkScope = (typeof FIAT_PERK_SCOPES)[number];

export const FIAT_PERK_SCOPE_LABELS: Record<FiatPerkScope, string> = {
  all: "All eligible accounts",
  selected_accounts: "Specific account IDs",
  crypto_depositors: "Deposited crypto before",
  prior_fiat: "Used a card before",
  active_players: "Played recently",
  country: "One country",
  never_screened: "Never screened",
};

export const DEFAULT_MIN_ACCOUNT_AGE_DAYS = 14;
export const MAX_PERK_RUN_ACCOUNTS = 500;

export const perkRunSchema = z.object({
  id: z.string().uuid(),
  scope: z.enum(FIAT_PERK_SCOPES),
  scopeLabel: z.string(),
  parameters: z.record(z.string(), z.unknown()),
  status: z.enum(["running", "completed", "failed"]),
  requestedBy: z.string(),
  requestedByUsername: z.string().nullable(),
  scannedCount: z.number().int(),
  candidateCount: z.number().int(),
  passCount: z.number().int(),
  reviewCount: z.number().int(),
  failCount: z.number().int(),
  providerChecks: z.number().int(),
  pendingCount: z.number().int(),
  errorCode: z.string().nullable(),
  createdAt: z.string(),
  completedAt: z.string().nullable(),
});
export type FiatPerkRun = z.infer<typeof perkRunSchema>;

export const perkCheckSchema = z.object({
  key: z.string(),
  label: z.string(),
  category: z.enum([
    "account",
    "blacklist",
    "network",
    "device",
    "behaviour",
    "history",
    "maxmind",
  ]),
  status: z.enum(["pass", "warn", "fail"]),
  detail: z.string(),
  points: z.number(),
});
export type FiatPerkCheck = z.infer<typeof perkCheckSchema>;

export const perkEvidenceSchema = z.object({
  behaviour: z
    .object({
      cryptoDeposits: z.number(),
      cryptoDepositUsd: z.number(),
      fiatDeposits: z.number(),
      fiatDepositUsd: z.number(),
      disputedFiat: z.number(),
      refundedFiat: z.number(),
      wagerUsd: z.number(),
      gameEvents: z.number(),
      rewardUsd: z.number(),
      rainWins: z.number(),
      withdrawalRequests: z.number(),
      withdrawalUsd: z.number(),
    })
    .nullish(),
  network: z
    .object({
      sharedDeviceUsers: z.number(),
      sharedSignupIpUsers: z.number(),
      signupIp: z.string().nullable(),
      visitorId: z.string().nullable(),
    })
    .nullish(),
  lastKnownIp: z.string().nullish(),
  visitorId: z.string().nullish(),
  maxmind: z
    .object({
      status: z.enum(["success", "failed", "skipped", "not_checked"]),
      riskScore: z.number().nullable(),
      ipRisk: z.number().nullable(),
      disposition: z.string().nullable(),
      reasons: z.array(z.object({
        code: z.string(),
        reason: z.string().nullable(),
        multiplier: z.number().nullable(),
      })),
      factors: z.record(z.string(), z.number()),
      warnings: z.array(z.string()),
    })
    .nullish(),
});
export type FiatPerkEvidence = z.infer<typeof perkEvidenceSchema>;

export const perkCandidateSchema = z.object({
  id: z.string().uuid(),
  runId: z.string().uuid(),
  userId: z.string(),
  username: z.string().nullable(),
  email: z.string().nullable(),
  avatarUrl: z.string().nullable(),
  countryCode: z.string().nullable(),
  accountAgeDays: z.number(),
  verdict: z.enum(["pass", "review", "fail"]),
  riskScore: z.number().int(),
  blockingReasons: z.array(z.string()),
  // Evidence shapes are additive over time; a candidate written by an older
  // service build must still render rather than blow up the whole queue.
  checks: z.array(perkCheckSchema).catch([]),
  evidence: perkEvidenceSchema.catch({}),
  providerChecked: z.boolean(),
  maxMindStatus: z.enum(["success", "failed", "skipped", "not_checked"])
    .default("not_checked"),
  maxMindRiskScore: z.number().nullable().default(null),
  maxMindIpRisk: z.number().nullable().default(null),
  maxMindDisposition: z.string().nullable().default(null),
  maxMindReasonCodes: z.array(z.string()).default([]),
  decision: z.enum(["pending", "approved", "declined"]),
  decidedBy: z.string().nullable(),
  decidedByUsername: z.string().nullable(),
  decidedAt: z.string().nullable(),
  decisionNote: z.string().nullable(),
  grantStatus: z.enum(["granted", "revoked"]).nullable(),
  accessStatus: z.enum(["unknown", "syncing", "enabled", "disabled", "error"])
    .nullable().default(null),
  createdAt: z.string(),
});
export type FiatPerkCandidate = z.infer<typeof perkCandidateSchema>;

export const perkGrantSchema = z.object({
  userId: z.string(),
  username: z.string().nullable(),
  status: z.enum(["granted", "revoked"]),
  riskScore: z.number().int().nullable(),
  grantedBy: z.string().nullable(),
  grantedByUsername: z.string().nullable(),
  grantedAt: z.string().nullable(),
  revokedBy: z.string().nullable(),
  revokedByUsername: z.string().nullable(),
  revokedAt: z.string().nullable(),
  revokedReason: z.string().nullable(),
  accessStatus: z.enum(["unknown", "syncing", "enabled", "disabled", "error"])
    .default("unknown"),
  accessErrorCode: z.string().nullable().default(null),
  accessConfirmedAt: z.string().nullable().default(null),
  updatedAt: z.string(),
});
export type FiatPerkGrant = z.infer<typeof perkGrantSchema>;

export const perkAccessBatchSchema = z.object({
  id: z.string().uuid(),
  action: z.enum(["enable", "disable"]),
  status: z.enum(["queued", "running", "completed", "partial", "failed"]),
  requestedCount: z.number().int(),
  succeededCount: z.number().int(),
  failedCount: z.number().int(),
  note: z.string().nullable(),
  requestedBy: z.string(),
  requestedByUsername: z.string().nullable(),
  createdAt: z.string(),
  completedAt: z.string().nullable(),
  failures: z.array(z.object({
    userId: z.string(),
    errorCode: z.string().nullable(),
  })).default([]),
});
export type FiatPerkAccessBatch = z.infer<typeof perkAccessBatchSchema>;
