import pg from "pg";

async function main() {
  const client = new pg.Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();

  const packs = await client.query(`
    SELECT p.id, p.name,
           array_agg(json_build_object('id', pc.id, 'weight', pc.weight) ORDER BY pc.weight DESC) as cards,
           SUM(pc.weight)::bigint as total_weight
    FROM packs p
    JOIN pack_cards pc ON pc.pack_id = p.id
    GROUP BY p.id, p.name
    ORDER BY p.name
  `);

  const DRY_RUN = process.argv.includes("--dry-run");
  if (DRY_RUN) console.log("=== DRY RUN ===\n");

  let totalUpdated = 0;

  for (const pack of packs.rows) {
    const total = Number(pack.total_weight);
    const cards: { id: string; weight: number }[] = pack.cards;

    // Calculate new weights
    const newCards = cards.map((c) => ({
      id: c.id,
      oldWeight: c.weight,
      newWeight: Math.round((c.weight / total) * 1_000_000),
    }));

    // Adjust last card so sum is exactly 1_000_000
    const sumWithoutLast = newCards
      .slice(0, -1)
      .reduce((s, c) => s + c.newWeight, 0);
    newCards[newCards.length - 1].newWeight = 1_000_000 - sumWithoutLast;

    // Ensure min weight of 1
    for (const c of newCards) {
      if (c.newWeight < 1) c.newWeight = 1;
    }

    const newSum = newCards.reduce((s, c) => s + c.newWeight, 0);

    console.log(
      `[${pack.name}] total=${total} → new sum=${newSum} (${cards.length} cards)`,
    );

    for (const c of newCards) {
      if (c.oldWeight !== c.newWeight) {
        if (DRY_RUN) {
          console.log(`  ${c.id}: ${c.oldWeight} → ${c.newWeight}`);
        } else {
          await client.query("UPDATE pack_cards SET weight = $1 WHERE id = $2", [
            c.newWeight,
            c.id,
          ]);
        }
        totalUpdated++;
      }
    }
  }

  console.log(
    `\n${DRY_RUN ? "Would update" : "Updated"} ${totalUpdated} pack_cards across ${packs.rows.length} packs`,
  );

  await client.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
