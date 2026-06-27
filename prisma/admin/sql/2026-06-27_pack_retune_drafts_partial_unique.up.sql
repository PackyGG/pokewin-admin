-- Pack Studio drafts: enforce "at most ONE pending draft per pack"
-- while keeping pushed / discarded rows for audit history.
--
-- Prisma can't model a partial unique constraint, so this is run via
-- `prisma db execute --file <this file> --config=prisma/admin/prisma.config.ts`
-- after `prisma db push` lands the table.
--
-- The action layer (src/app/(pack-studio)/pack-studio/drafts/_actions.ts ->
-- seedDraftForPack) catches the P2002 unique violation this raises to surface
-- "a pending draft already exists for this pack — open it instead" cleanly.
CREATE UNIQUE INDEX IF NOT EXISTS pack_retune_drafts_one_pending_per_pack
  ON pack_retune_drafts (pack_id)
  WHERE status = 'draft';
