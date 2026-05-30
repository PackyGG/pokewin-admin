-- CreateTable
-- 7-day soft-delete snapshot for main-DB users wiped via the admin
-- /users delete action. The deleteUser server action snapshots the
-- user row plus the heavier per-user satellite tables (balances,
-- inventory, vouchers, rakeback claims, recent ledger / game sessions)
-- into this table BEFORE running the destructive main-DB delete.
-- Snapshots live for 7 days, listed at /users/deleted, and are purged
-- fire-and-forget on the next /users/deleted read after expiry.
CREATE TABLE "admin_deleted_users" (
    "id"          VARCHAR(36)  NOT NULL,
    "username"    VARCHAR(255),
    "email"       VARCHAR(255),
    "deleted_at"  TIMESTAMP(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "deleted_by"  VARCHAR(36)  NOT NULL,
    "expires_at"  TIMESTAMP(6) NOT NULL,
    "snapshot"    JSONB        NOT NULL,
    "restored_at" TIMESTAMP(6),
    "restored_by" VARCHAR(36),

    CONSTRAINT "admin_deleted_users_pkey" PRIMARY KEY ("id")
);

-- Purge scan: "delete every row whose expires_at < now()" hits this.
CREATE INDEX "admin_deleted_users_expires_at_idx"
    ON "admin_deleted_users"("expires_at");

-- Listing default sort: newest deletions first.
CREATE INDEX "admin_deleted_users_deleted_at_idx"
    ON "admin_deleted_users"("deleted_at" DESC);
