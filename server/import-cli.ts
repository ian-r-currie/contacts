import fs from "node:fs";
import { parseArgs } from "node:util";
import { openDb } from "./db.ts";
import { importCsv, previewCsv } from "./importer.ts";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { category: { type: "string" } },
});

if (positionals.length === 0) {
  console.log("Usage: npm run import -- [--category Professor] file.csv [more.csv ...]");
  console.log("Imports into the local database (data/contacts.db). Existing contacts with the same name are merged, never overwritten.");
  process.exit(1);
}

const db = openDb();
for (const file of positionals) {
  const csv = fs.readFileSync(file, "utf8");
  const category = values.category ?? previewCsv(csv).suggestedCategory;
  const s = importCsv(db, csv, { category });
  console.log(`${file} (category "${category}"): ${s.created} created, ${s.merged} merged, ${s.stubs} placeholder contacts from "Related to", ${s.relations} relationships, ${s.skipped} skipped`);
  for (const note of s.notes) console.log(`  - ${note}`);
}
