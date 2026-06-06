-- Add the `creator_manager` built-in role to the admin_role enum.
-- Idempotent: ADD VALUE IF NOT EXISTS.
-- Pure additive change — existing admins are untouched.

ALTER TYPE "admin_role" ADD VALUE IF NOT EXISTS 'creator_manager';
