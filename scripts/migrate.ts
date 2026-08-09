import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import postgres from "postgres";

import { loadConfig } from "../src/core/config.ts";

const config = loadConfig(process.env);
const migrationPath = fileURLToPath(
  new URL("../migrations/0001_foundation.sql", import.meta.url),
);
const source = await readFile(migrationPath, "utf8");
const statements = source
  .split("-- statement-breakpoint")
  .map((statement) => statement.trim())
  .filter(Boolean);

const sql = postgres(config.databaseUrl, { max: 1 });
try {
  await sql.begin(async (transaction) => {
    for (const statement of statements) {
      await transaction.unsafe(statement);
    }
  });
  process.stdout.write(`Applied ${statements.length} foundation statements.\n`);
} finally {
  await sql.end();
}
