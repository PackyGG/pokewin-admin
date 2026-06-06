-- Add creator_manager to admin_role enum (idempotent).
-- Run against ADMIN DB: npx prisma db execute --schema prisma/admin/schema.prisma --config prisma/admin/prisma.config.ts --file prisma/admin/sql/20260606_creator_manager_role.sql

ALTER TYPE "admin_role" ADD VALUE IF NOT EXISTS 'creator_manager';
