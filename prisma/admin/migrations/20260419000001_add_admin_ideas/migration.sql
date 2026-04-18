-- CreateTable
CREATE TABLE "admin_ideas" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "title" TEXT NOT NULL,
    "description" TEXT,
    "status" TEXT NOT NULL DEFAULT 'neutral',
    "sort_order" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "admin_ideas_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE INDEX "admin_ideas_sort_order_idx" ON "admin_ideas"("sort_order");

-- CreateIndex
CREATE INDEX "admin_ideas_status_idx" ON "admin_ideas"("status");

-- AddForeignKey
ALTER TABLE "admin_ideas" ADD CONSTRAINT "admin_ideas_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "admin_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
