/**
 * Client-safe type for the fraud shared-identity feature. Split out of
 * `./shared-identity.ts` so "use client" components can import the type
 * without pulling the Prisma client into the browser bundle.
 */
export type SharedIdentityUser = {
  userId: string;
  username: string | null;
  email: string | null;
  image: string | null;
  role: string;
  isBanned: boolean;
  isLocked: boolean;
  /** Number of distinct IPs (or visitor_ids for fingerprint variant) in common. */
  sharedCount: number;
  /** Number of fingerprint events recorded for the OTHER user with a shared identity. */
  totalEvents: number;
  /** Most recent time the OTHER user had a matching event. */
  lastSeenAt: string | null;
  /** Examples of the shared identity value (IP / visitor_id) — max 5, for display. */
  sampleValues: string[];
};
