import { z } from "zod";

import type { Signup } from "./types.js";

const nullableString = z.string().nullable();

const failedSignupSchema = z.object({
  id: z.string().min(1),
  username: nullableString,
  email: nullableString,
  image: nullableString,
  signup_ip: nullableString,
  country: nullableString,
  country_code: nullableString,
  continent_code: nullableString,
  state: nullableString,
  city: nullableString,
  affiliate_code: nullableString,
  referred_by: nullableString,
  is_suspected_alt: z.boolean(),
  created_at: z.union([z.date(), z.string().datetime()]).transform((value) =>
    value instanceof Date ? value : new Date(value)
  ),
  fingerprint_request_id: nullableString,
  visitor_id: nullableString,
  fingerprint_confidence: z.number().nullable(),
  fingerprint_ip: nullableString,
  user_agent: nullableString,
  auth_provider: nullableString.optional().default(null),
  auth_providers: z.array(z.object({
    provider: z.string(),
    linkedAt: z.string().nullable(),
  })).default([]),
  is_creator: z.boolean().default(false),
});

export function parseFailedSignup(value: unknown): Signup | null {
  const parsed = failedSignupSchema.safeParse(value);
  return parsed.success ? parsed.data : null;
}
