-- CreateTable
-- Admin-side "sponsored %" annotation on a creator (affiliate)
-- leaderboard. Purely a cost-accounting input — it never touches the
-- backend leaderboard. The /creators "Leaderboard Cost" KPI counts
-- each approved leaderboard's prize pool × this percentage.
CREATE TABLE "admin_leaderboard_sponsorship" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "leaderboard_id" TEXT NOT NULL,
    "sponsored_percentage" DECIMAL(5,2) NOT NULL,
    "set_by_admin_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_leaderboard_sponsorship_pkey" PRIMARY KEY ("id")
);

-- One row per leaderboard — the setLeaderboardSponsorship upsert keys
-- on this unique constraint.
CREATE UNIQUE INDEX "admin_leaderboard_sponsorship_leaderboard_id_key"
    ON "admin_leaderboard_sponsorship"("leaderboard_id");
