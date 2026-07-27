import { z } from "zod";

export const scoreWeightUpdateSchema = z.object({
  idempotencyKey: z.string().uuid(),
  actorId: z.string().trim().min(1).max(100).optional(),
  actorUsername: z.string().trim().min(1).max(100).optional(),
  points: z.number().int().min(-500).max(500),
}).strict();

export const ruleUpdateSchema = z.object({
  idempotencyKey: z.string().uuid(),
  actorId: z.string().trim().min(1).max(100).optional(),
  actorUsername: z.string().trim().min(1).max(100).optional(),
  name: z.string().min(1).max(100).optional(),
  description: z.string().max(500).optional(),
  enabled: z.boolean().optional(),
  sequence: z.array(z.string().min(1).max(100)).min(1).max(20).optional(),
  excludeBefore: z.array(z.string().min(1).max(100)).max(20).optional(),
  windowSeconds: z.number().int().min(1).max(86_400).optional(),
  scoreDelta: z.number().int().min(-500).max(500).optional(),
  actionType: z.enum(["manual_review", "escalate"]).optional(),
}).strict().refine(
  (value) =>
    Object.keys(value).some(
      (key) =>
        key !== "idempotencyKey" &&
        key !== "actorId" &&
        key !== "actorUsername",
    ),
  { message: "At least one rule field must be supplied" },
);

export const ruleCreateSchema = z.object({
  idempotencyKey: z.string().uuid(),
  actorId: z.string().trim().min(1).max(100).optional(),
  actorUsername: z.string().trim().min(1).max(100).optional(),
  name: z.string().trim().min(1).max(100),
  description: z.string().trim().max(500).default(""),
  enabled: z.boolean().default(false),
  sequence: z.array(z.string().min(1).max(100)).min(1).max(20),
  excludeBefore: z.array(z.string().min(1).max(100)).max(20).default([]),
  windowSeconds: z.number().int().min(1).max(86_400),
  scoreDelta: z.number().int().min(-500).max(500),
  actionType: z.enum(["manual_review", "escalate"]),
}).strict();

export const caseDecisionSchema = z.object({
  decision: z.enum([
    "in_review",
    "escalated",
    "resolved_safe",
    "resolved_fraud",
  ]),
  idempotencyKey: z.string().uuid(),
  reason: z.string().trim().min(1).max(1000),
  actorId: z.string().trim().min(1).max(100).optional(),
  actorUsername: z.string().trim().min(1).max(100).optional(),
}).strict();
