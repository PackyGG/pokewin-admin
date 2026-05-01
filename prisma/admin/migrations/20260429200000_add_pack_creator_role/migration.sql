-- Add the `pack_creator` role to the admin_role enum.
-- Idempotent: ADD VALUE IF NOT EXISTS.
-- Pure additive change — existing admins are untouched.

ALTER TYPE "admin_role" ADD VALUE IF NOT EXISTS 'pack_creator';
