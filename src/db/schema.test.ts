import assert from "node:assert/strict";
import test from "node:test";

import { getTableName } from "drizzle-orm";

import { caseTables } from "./schema.ts";

test("database schema exposes exactly the thirteen approved durable tables", () => {
  assert.deepEqual(
    caseTables.map(getTableName).sort(),
    [
      "agent_events",
      "artifacts",
      "claims",
      "entities",
      "entity_identifiers",
      "entity_links",
      "evidence",
      "findings",
      "investigations",
      "observations",
      "provider_calls",
      "research_questions",
      "runs",
    ],
  );
});
