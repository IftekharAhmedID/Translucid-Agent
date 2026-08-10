import { spawn } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";

import postgres from "postgres";

function testDatabaseUrl(): string {
  const configured = process.env.TEST_DATABASE_URL?.trim();
  const development = process.env.DATABASE_URL?.trim();
  if (!development) throw new Error("DATABASE_URL is required for integration tests.");
  if (configured) return configured;
  const derived = new URL(development);
  const database = derived.pathname.slice(1);
  derived.pathname = `/${database}_test`;
  return derived.toString();
}

const developmentUrl = process.env.DATABASE_URL!;
const databaseUrl = testDatabaseUrl();
const parsed = new URL(databaseUrl);
const databaseName = decodeURIComponent(parsed.pathname.slice(1));
if (!databaseName.endsWith("_test")) throw new Error("Integration tests require a database whose name ends in _test.");
if (parsed.toString() === new URL(developmentUrl).toString()) throw new Error("Integration tests refuse to use the development database.");
if (!/^[A-Za-z0-9_]+$/.test(databaseName)) throw new Error("The integration-test database name contains unsupported characters.");

const adminUrl = new URL(databaseUrl);
adminUrl.pathname = "/postgres";
const admin = postgres(adminUrl.toString(), { max: 1 });
try {
  const [existing] = await admin<Array<{ exists: boolean }>>`SELECT EXISTS(SELECT 1 FROM pg_database WHERE datname = ${databaseName}) AS exists`;
  if (!existing?.exists) await admin.unsafe(`CREATE DATABASE "${databaseName}"`);
} finally {
  await admin.end();
}

const migrationsDirectory = new URL("../migrations/", import.meta.url);
const migrationFiles = (await readdir(migrationsDirectory)).filter((name) => /^\d+.*\.sql$/.test(name)).sort();
const testSql = postgres(databaseUrl, { max: 1 });
try {
  await testSql.begin(async (transaction) => {
    for (const migrationFile of migrationFiles) {
      const source = await readFile(new URL(migrationFile, migrationsDirectory), "utf8");
      for (const statement of source.split("-- statement-breakpoint").map((value) => value.trim()).filter(Boolean)) {
        await transaction.unsafe(statement);
      }
    }
  });
} finally {
  await testSql.end();
}

const child = spawn(process.execPath, ["--import", "tsx", "--test", "--test-concurrency=1", "src/**/*.integration.ts"], {
  cwd: process.cwd(),
  env: { ...process.env, DATABASE_URL: databaseUrl, NODE_ENV: "test" },
  stdio: "inherit",
});
const exitCode = await new Promise<number>((resolve, reject) => {
  child.once("error", reject);
  child.once("exit", (code) => resolve(code ?? 1));
});
if (exitCode !== 0) process.exitCode = exitCode;
