import "server-only";

import { createHash } from "node:crypto";
import { asc, desc, eq, sql } from "drizzle-orm";
import { z } from "zod";

import { adminDrizzle } from "@/lib/admin-db";
import {
  admin_audit_events,
  creator_agreement_documents,
  creator_agreement_lines,
} from "@/lib/db-schema/admin/schema";

const LinesSchema = z
  .array(z.string().trim().min(1).max(1000))
  .min(1, "Add at least one agreement line.")
  .max(100, "The agreement cannot contain more than 100 lines.");

export type PublishedCreatorAgreementTerms = {
  id: string;
  version: number;
  lines: string[];
  checksum: string;
  publishedAt: string;
};

export type CreatorAgreementVersionSummary = Omit<
  PublishedCreatorAgreementTerms,
  "lines"
> & { lineCount: number };

function creatorAgreementChecksum(lines: readonly string[]): string {
  return createHash("sha256")
    .update(JSON.stringify(lines.map((line) => line.trim())), "utf8")
    .digest("hex");
}

async function readDocument(
  document: typeof creator_agreement_documents.$inferSelect,
): Promise<PublishedCreatorAgreementTerms> {
  const rows = await adminDrizzle
    .select({ lineNumber: creator_agreement_lines.line_number, text: creator_agreement_lines.text })
    .from(creator_agreement_lines)
    .where(eq(creator_agreement_lines.document_id, document.id))
    .orderBy(asc(creator_agreement_lines.line_number));
  return {
    id: document.id,
    version: document.version,
    lines: rows.map((row) => row.text),
    checksum: document.checksum,
    publishedAt: document.published_at,
  };
}

export async function getPublishedCreatorAgreementTerms(): Promise<PublishedCreatorAgreementTerms | null> {
  const [document] = await adminDrizzle
    .select()
    .from(creator_agreement_documents)
    .orderBy(desc(creator_agreement_documents.version))
    .limit(1);
  return document ? readDocument(document) : null;
}

export async function listCreatorAgreementTermVersions(): Promise<CreatorAgreementVersionSummary[]> {
  const rows = await adminDrizzle.execute<{
    id: string;
    version: number;
    checksum: string;
    published_at: string;
    line_count: number;
  }>(sql`
    SELECT document.id::text, document.version, document.checksum,
           document.published_at::text, count(line.document_id)::int AS line_count
    FROM creator_agreement_documents AS document
    LEFT JOIN creator_agreement_lines AS line ON line.document_id = document.id
    GROUP BY document.id
    ORDER BY document.version DESC
  `);
  return rows.rows.map((row) => ({
    id: row.id,
    version: row.version,
    checksum: row.checksum,
    publishedAt: row.published_at,
    lineCount: row.line_count,
  }));
}

/** Publish creates a new immutable version; existing documents are never edited. */
export async function publishCreatorAgreementTerms(input: {
  lines: string[];
  actorAdminUserId: string;
}): Promise<PublishedCreatorAgreementTerms> {
  const lines = LinesSchema.parse(input.lines);
  const actorAdminUserId = z.string().uuid().parse(input.actorAdminUserId);
  const checksum = creatorAgreementChecksum(lines);

  const result = await adminDrizzle.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext('creator-agreement-publish'))`);
    const [current] = await tx
      .select({ version: creator_agreement_documents.version, checksum: creator_agreement_documents.checksum })
      .from(creator_agreement_documents)
      .orderBy(desc(creator_agreement_documents.version))
      .limit(1);
    if (current?.checksum === checksum) {
      const [existing] = await tx
        .select()
        .from(creator_agreement_documents)
        .where(eq(creator_agreement_documents.version, current.version))
        .limit(1);
      return { document: existing!, created: false };
    }
    const [created] = await tx
      .insert(creator_agreement_documents)
      .values({
        version: (current?.version ?? 0) + 1,
        checksum,
        created_by: actorAdminUserId,
        published_by: actorAdminUserId,
      })
      .returning();
    await tx.insert(creator_agreement_lines).values(
      lines.map((text, index) => ({
        document_id: created.id,
        line_number: index + 1,
        text,
      })),
    );
    await tx.insert(admin_audit_events).values({
      admin_user_id: actorAdminUserId,
      event_type: "creator_agreement_terms_published",
      metadata: {
        documentId: created.id,
        version: created.version,
        checksum,
        lineCount: lines.length,
      },
    });
    return { document: created, created: true };
  });
  return readDocument(result.document);
}
