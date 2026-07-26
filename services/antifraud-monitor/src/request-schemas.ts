import { z } from "zod";

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
