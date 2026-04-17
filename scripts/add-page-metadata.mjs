#!/usr/bin/env node
// One-shot script: adds `export const metadata = { title: "..." };` to each
// (admin) page.tsx. Safe to re-run — skips files that already have a metadata
// export.
//
// Usage: node scripts/add-page-metadata.mjs [--dry]

import fs from "node:fs";
import path from "node:path";

const DRY = process.argv.includes("--dry");

// Map of page file -> browser tab title (gets wrapped by the root layout
// template into "<title> · PackyGG Admin")
const MAPPING = {
  "src/app/(admin)/dashboard/page.tsx": "Dashboard",
  "src/app/(admin)/analytics/page.tsx": "Analytics",
  "src/app/(admin)/map/page.tsx": "Map",
  "src/app/(admin)/users/page.tsx": "Users",
  "src/app/(admin)/users/[id]/page.tsx": "User Detail",
  "src/app/(admin)/transactions/page.tsx": "Transactions",
  "src/app/(admin)/transactions/deposits/page.tsx": "Deposits",
  "src/app/(admin)/transactions/packs/page.tsx": "Pack Transactions",
  "src/app/(admin)/transactions/battles/page.tsx": "Battle Transactions",
  "src/app/(admin)/transactions/rewards/page.tsx": "Reward Transactions",
  "src/app/(admin)/transactions/[id]/page.tsx": "Transaction Detail",
  "src/app/(admin)/withdrawals/page.tsx": "Withdrawals",
  "src/app/(admin)/withdrawals/[id]/page.tsx": "Withdrawal Detail",
  "src/app/(admin)/packs/page.tsx": "Packs",
  "src/app/(admin)/packs/[id]/page.tsx": "Pack Detail",
  "src/app/(admin)/cards/page.tsx": "Cards",
  "src/app/(admin)/cards/[id]/page.tsx": "Card Detail",
  "src/app/(admin)/battles/page.tsx": "Battles",
  "src/app/(admin)/battles/[id]/page.tsx": "Battle Detail",
  "src/app/(admin)/rewards/page.tsx": "Rewards",
  "src/app/(admin)/rewards/rakeback/page.tsx": "Rakeback",
  "src/app/(admin)/rewards/raffles/page.tsx": "Raffles",
  "src/app/(admin)/rewards/raffles/[id]/page.tsx": "Raffle Detail",
  "src/app/(admin)/rewards/leaderboards/page.tsx": "Leaderboards",
  "src/app/(admin)/rewards/level-up/page.tsx": "Level Up",
  "src/app/(admin)/rewards/settings/page.tsx": "Rewards Settings",
  "src/app/(admin)/rain/page.tsx": "Rain",
  "src/app/(admin)/rain/[id]/page.tsx": "Rain Detail",
  "src/app/(admin)/promo-codes/page.tsx": "Promo Codes",
  "src/app/(admin)/promo-codes/[id]/page.tsx": "Promo Code Detail",
  "src/app/(admin)/gift-cards/page.tsx": "Gift Cards",
  "src/app/(admin)/vouchers/page.tsx": "Vouchers",
  "src/app/(admin)/spending/page.tsx": "Spending",
  "src/app/(admin)/my-profile/page.tsx": "My Profile",
  "src/app/(admin)/creators/page.tsx": "Creators",
  "src/app/(admin)/creators/[userId]/page.tsx": "Creator Detail",
  "src/app/(admin)/creators/codes/page.tsx": "Creator Codes",
  "src/app/(admin)/creators/codes/[code]/page.tsx": "Creator Code Detail",
  "src/app/(admin)/creators/analytics/page.tsx": "Creator Analytics",
  "src/app/(admin)/creators/settings/page.tsx": "Creator Settings",
  "src/app/(admin)/chat/page.tsx": "Chat Moderation",
  "src/app/(admin)/security/page.tsx": "Security",
  "src/app/(admin)/admin-users/page.tsx": "Admin Users",
  "src/app/(admin)/admin-users/[id]/page.tsx": "Admin User Detail",
  "src/app/(admin)/whitelist/page.tsx": "Whitelist",
  "src/app/(admin)/bots/page.tsx": "Bots",
  "src/app/(admin)/settings/page.tsx": "Settings",
  "src/app/(admin)/audit/page.tsx": "Audit Log",
};

/**
 * Walks the top of a file and returns the line index (0-based) of the last
 * line belonging to the import block. Handles multi-line imports.
 * Returns -1 if the file has no imports.
 */
function findImportBlockEndIdx(lines) {
  let lastImportIdx = -1;
  let inMultiLine = false;

  for (let i = 0; i < lines.length; i++) {
    const trimmed = lines[i].trim();

    if (inMultiLine) {
      lastImportIdx = i;
      // Close of a multi-line import: `} from "..."` (possibly with ; or type)
      if (/}\s*from\s+['"][^'"]+['"]\s*;?\s*$/.test(trimmed)) {
        inMultiLine = false;
      }
      continue;
    }

    if (trimmed === "") continue;
    if (trimmed.startsWith("//")) continue;
    if (trimmed.startsWith("/*")) continue;
    if (trimmed.startsWith("*")) continue;
    if (trimmed === '"use client";' || trimmed === "'use client';") continue;
    if (trimmed === '"use server";' || trimmed === "'use server';") continue;

    if (trimmed.startsWith("import ")) {
      // Single-line import ends on same line
      if (/from\s+['"][^'"]+['"]\s*;?\s*$/.test(trimmed)) {
        lastImportIdx = i;
      } else if (trimmed.includes("{") && !trimmed.includes("}")) {
        // Multi-line named import begins
        lastImportIdx = i;
        inMultiLine = true;
      } else {
        // e.g. `import "./foo.css";`
        lastImportIdx = i;
      }
      continue;
    }

    // First non-import, non-blank, non-comment line — stop
    break;
  }

  return lastImportIdx;
}

function alreadyHasMetadata(content) {
  // Detects either `export const metadata` or `export async function generateMetadata`
  return (
    /^\s*export\s+const\s+metadata\b/m.test(content) ||
    /^\s*export\s+(async\s+)?function\s+generateMetadata\b/m.test(content)
  );
}

function escapeTitle(t) {
  return t.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
}

let changed = 0;
let skipped = 0;
let missing = 0;

for (const [relPath, title] of Object.entries(MAPPING)) {
  const abs = path.resolve(relPath);
  if (!fs.existsSync(abs)) {
    console.log(`[MISSING] ${relPath}`);
    missing++;
    continue;
  }

  const content = fs.readFileSync(abs, "utf8");
  if (alreadyHasMetadata(content)) {
    console.log(`[SKIP ]  ${relPath}  (already has metadata)`);
    skipped++;
    continue;
  }

  // Preserve original EOL style — Next.js files here use LF ("\n")
  const eol = content.includes("\r\n") ? "\r\n" : "\n";
  const lines = content.split(eol);

  const endIdx = findImportBlockEndIdx(lines);
  const metaLine = `export const metadata = { title: "${escapeTitle(title)}" };`;

  let insertIdx;
  if (endIdx === -1) {
    // No imports — insert at top
    insertIdx = 0;
    lines.splice(insertIdx, 0, metaLine, "");
  } else {
    // Insert after the last import line, with a leading blank line separator
    // unless one already exists
    const afterImport = endIdx + 1;
    const nextLine = lines[afterImport];
    if (nextLine !== undefined && nextLine.trim() === "") {
      // Existing blank line: insert metadata after it, then another blank
      lines.splice(afterImport + 1, 0, metaLine, "");
    } else {
      // No blank line: insert blank + metadata + blank
      lines.splice(afterImport, 0, "", metaLine, "");
    }
  }

  const updated = lines.join(eol);

  if (DRY) {
    console.log(`[DRY  ]  ${relPath}  -> "${title}"`);
  } else {
    fs.writeFileSync(abs, updated);
    console.log(`[WRITE]  ${relPath}  -> "${title}"`);
  }
  changed++;
}

console.log("");
console.log(`Done. changed=${changed} skipped=${skipped} missing=${missing}`);
