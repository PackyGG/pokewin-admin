-- Add the `creator_manager` role to the admin_role enum.
-- Idempotent: ADD VALUE IF NOT EXISTS.
-- Pure additive change — existing admins are untouched.
-- Apply via: npx prisma db execute --file prisma/admin/sql/20260606_add_creator_manager_role.sql --config prisma/admin/prisma.config.ts

ALTER TYPE "admin_role" ADD VALUE IF NOT EXISTS 'creator_manager';
