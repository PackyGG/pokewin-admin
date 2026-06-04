-- CreateTable
-- Admin-side "creator paid his part" flag on a creator (affiliate)
-- leaderboard. Purely an internal tracking annotation — "so we know if
-- he paid or not." It NEVER touches the backend leaderboard, any
-- balance/ledger, or ANY money math (PnL / GGR / Leaderboard Cost are
-- unaffected). A dedicated table (not a column on
-- admin_leaderboard_sponsorship) so the toggle works even for
-- leaderboards that carry no sponsorship row yet.
CREATE TABLE "admin_leaderboard_creator_paid" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "leaderboard_id" TEXT NOT NULL,
    "paid" BOOLEAN NOT NULL DEFAULT false,
    "paid_at" TIMESTAMPTZ(6),
    "set_by_admin_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_leaderboard_creator_paid_pkey" PRIMARY KEY ("id")
);

-- One row per leaderboard — the setLeaderboardCreatorPaid upsert keys
-- on this unique constraint.
CREATE UNIQUE INDEX "admin_leaderboard_creator_paid_leaderboard_id_key"
    ON "admin_leaderboard_creator_paid"("leaderboard_id");
