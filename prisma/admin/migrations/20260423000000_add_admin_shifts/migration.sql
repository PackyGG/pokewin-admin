-- CreateTable
CREATE TABLE "admin_shifts" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "week_start" TIMESTAMPTZ(6) NOT NULL,
    "day_of_week" INTEGER NOT NULL,
    "shift_slot" INTEGER NOT NULL,
    "start_at" TIMESTAMPTZ(6) NOT NULL,
    "end_at" TIMESTAMPTZ(6) NOT NULL,
    "notes" TEXT,
    "created_by_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMPTZ(6) NOT NULL,

    CONSTRAINT "admin_shifts_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "admin_shifts_week_start_day_of_week_shift_slot_key" ON "admin_shifts"("week_start", "day_of_week", "shift_slot");

-- CreateIndex
CREATE INDEX "admin_shifts_week_start_idx" ON "admin_shifts"("week_start");

-- AddForeignKey
ALTER TABLE "admin_shifts" ADD CONSTRAINT "admin_shifts_created_by_id_fkey" FOREIGN KEY ("created_by_id") REFERENCES "admin_users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- CreateTable
CREATE TABLE "admin_shift_assignments" (
    "id" UUID NOT NULL DEFAULT gen_random_uuid(),
    "shift_id" UUID NOT NULL,
    "admin_user_id" UUID NOT NULL,
    "created_at" TIMESTAMPTZ(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "admin_shift_assignments_pkey" PRIMARY KEY ("id")
);

-- CreateIndex
CREATE UNIQUE INDEX "admin_shift_assignments_shift_id_admin_user_id_key" ON "admin_shift_assignments"("shift_id", "admin_user_id");

-- CreateIndex
CREATE INDEX "admin_shift_assignments_admin_user_id_idx" ON "admin_shift_assignments"("admin_user_id");

-- AddForeignKey
ALTER TABLE "admin_shift_assignments" ADD CONSTRAINT "admin_shift_assignments_shift_id_fkey" FOREIGN KEY ("shift_id") REFERENCES "admin_shifts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "admin_shift_assignments" ADD CONSTRAINT "admin_shift_assignments_admin_user_id_fkey" FOREIGN KEY ("admin_user_id") REFERENCES "admin_users"("id") ON DELETE CASCADE ON UPDATE CASCADE;
