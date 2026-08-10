import { readFile, readdir } from "node:fs/promises";
import { fileURLToPath } from "node:url";

import postgres from "postgres";

import { loadConfig } from "../src/core/config.ts";

const config = loadConfig(process.env);
const migrationsDirectory = fileURLToPath(new URL("../migrations/", import.meta.url));
const migrationFiles = (await readdir(migrationsDirectory))
  .filter((name) => /^\d+.*\.sql$/.test(name))
  .sort();

const sql = postgres(config.databaseUrl, { max: 1 });
try {
  await sql.begin(async (transaction) => {
    for (const migrationFile of migrationFiles) {
      const source = await readFile(new URL(migrationFile, new URL("../migrations/", import.meta.url)), "utf8");
      const statements = source.split("-- statement-breakpoint").map((statement) => statement.trim()).filter(Boolean);
      for (const statement of statements) await transaction.unsafe(statement);
    }
  });
  process.stdout.write(`Applied ${migrationFiles.length} migration files.\n`);
} finally {
  await sql.end();
}
