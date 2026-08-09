import postgres, { type Sql } from "postgres";
import { drizzle } from "drizzle-orm/postgres-js";

import { getConfig } from "../core/config.ts";
import * as schema from "./schema.ts";

let sqlClient: Sql | undefined;

export function getSql(): Sql {
  sqlClient ??= postgres(getConfig().databaseUrl, {
    max: 12,
    idle_timeout: 20,
    connect_timeout: 10,
    onnotice: () => undefined,
  });
  return sqlClient;
}

export function getDatabase() {
  return drizzle(getSql(), { schema });
}

export async function closeDatabase(): Promise<void> {
  if (sqlClient) {
    await sqlClient.end({ timeout: 5 });
    sqlClient = undefined;
  }
}
