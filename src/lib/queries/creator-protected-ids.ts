import { queryMainRows, queryRows } from "@/lib/drizzle-query";
import "server-only";

import { cache } from "react";
import { adminDrizzle } from "@/lib/admin-db";

/**
 * Every user id that is, or has ever been, a creator — the set that a bulk
 * ban must NEVER touch (owner rule, 2026-07-24: "never ever ban ex
 * creators").
 *
 * The CURRENT role is handled by the caller's role gate (bulk ban only ever
 * targets `role = 'user'`). This set exists for the harder case: a creator
 * whose role was since reset to `user`. They look exactly like a normal
 * account on the /users list — no deposits, house-funded play, often a
 * shared signup IP from a stream setup — which is precisely the shape the
 * bulk-ban filters select for. Without this carve-out an anti-farming sweep
 * would take out retired partners.
 *
 * ─── Which artifacts count ─────────────────────────────────────────────
 *
 * Only CREATOR-ONLY relations. Each of these rows can only exist because
 * the account was run as a creator at some point:
 *
 *   Main DB:  creator_deals, creator_multiplier_deals, creator_socials,
 *             creator_stream_sessions, creator_withdrawal_limits,
 *             affiliate_leaderboards (owner + co-creators)
 *   Admin DB: creator_deals, creator_webhooks, creator_socials,
 *             creator_balance_fills, and the creator-signal audit events
 *             (promotion, deal created/deleted, social approved, force
 *             reset to user, and `role_changed` naming creator on either
 *             side of the transition)
 *
 * DELIBERATELY EXCLUDED: `affiliate_codes` and `affiliate_payouts`. The
 * Past-creators list (`getEverCreatorCandidateIds` in
 * `src/app/(admin)/creators/_queries/list-ex-creators.ts`) treats those as
 * creator evidence, but they are NOT creator-only on live data — verified
 * read-only 2026-07-24: 708 of 815 affiliate-code owners and 100 of 168
 * payout recipients carry `role = 'user'` and never held a creator
 * artifact. The affiliate program is open to ordinary players, and a
 * self-referring farm account minting its own code is exactly what the
 * bulk ban is for. Treating a code as "was a creator" would gut the tool.
 * That looser set stays correct for the Past-creators TAB (a false
 * positive there just shows an extra card); this stricter set is the one a
 * destructive action keys off.
 *
 * Every source is a small creator-scale table (~100-250 rows), so a seq
 * scan is the optimal plan — there is no index to hit and nothing to gain
 * from one. Deduped per request via React `cache()`: the bulk-ban flow
 * resolves it twice (preview, then the ban itself) and both must agree.
 *
 * Throws on failure by design. The caller is a destructive action, so an
 * unresolvable protection set must abort the ban — never degrade to an
 * empty set and ban unprotected.
 */
export const getCreatorProtectedUserIds = cache(
  async (): Promise<string[]> => {

    const [mainRows, adminRows] = await Promise.all([
      // Main DB: one UNION so the six creator-only tables cost a single
      // round-trip. UNION already dedupes.
      queryMainRows<{ user_id: string }[]>(`
        SELECT user_id FROM creator_deals WHERE user_id IS NOT NULL
        UNION SELECT user_id FROM creator_multiplier_deals WHERE user_id IS NOT NULL
        UNION SELECT user_id FROM creator_socials WHERE user_id IS NOT NULL
        UNION SELECT user_id FROM creator_stream_sessions WHERE user_id IS NOT NULL
        UNION SELECT user_id FROM creator_withdrawal_limits WHERE user_id IS NOT NULL
        UNION SELECT creator_user_id FROM affiliate_leaderboards WHERE creator_user_id IS NOT NULL
        UNION SELECT unnest(co_creator_user_ids) FROM affiliate_leaderboards
      `),
      // Admin DB: one round-trip across the creator-only evidence tables.
      queryRows<
        {
          event_type: string | null;
          target_user_id: string;
          metadata: unknown;
        }[]
      >(
        adminDrizzle,
        `
          SELECT NULL::text AS event_type, target_user_id, NULL::jsonb AS metadata
            FROM creator_deals
          UNION
          SELECT NULL::text, target_user_id, NULL::jsonb FROM creator_webhooks
          UNION
          SELECT NULL::text, target_user_id, NULL::jsonb FROM creator_socials
          UNION
          SELECT NULL::text, target_user_id, NULL::jsonb FROM creator_balance_fills
          UNION ALL
          SELECT event_type, target_user_id, metadata
            FROM admin_audit_events
           WHERE target_user_id IS NOT NULL
             AND event_type IN (
               'user_made_creator',
               'creator_deal_created',
               'creator_deal_deleted',
               'creator_social_approved',
               'creator_force_reset_to_user',
               'role_changed'
             )
        `,
      ),
    ]);

    const ids = new Set<string>();

    for (const r of mainRows) if (r.user_id) ids.add(r.user_id);
    for (const e of adminRows) {
      if (e.event_type === null) {
        ids.add(e.target_user_id);
        continue;
      }
      // The dedicated creator event types count outright. `role_changed` is
      // the generic dropdown path, so it only counts when the metadata names
      // creator on one side — a promotion TO creator, or a demotion FROM one.
      if (e.event_type !== "role_changed") {
        ids.add(e.target_user_id);
        continue;
      }
      const meta =
        e.metadata && typeof e.metadata === "object" && !Array.isArray(e.metadata)
          ? (e.metadata as Record<string, unknown>)
          : {};
      if (meta.new_role === "creator" || meta.prev_role === "creator") {
        ids.add(e.target_user_id);
      }
    }

    return [...ids];
  },
);
