import { readFile } from "node:fs/promises";
import { resolve } from "node:path";

import { createOpencodeClient } from "@opencode-ai/sdk/v2/client";
import { z } from "zod";

import {
  criticJsonExample,
  criticOutputSchema,
  findingBatchOutputSchema,
  summaryOutputSchema,
} from "../src/agent/finalization.ts";
import { extractStructuredOutput } from "../src/agent/structured-output.ts";
import { getConfig } from "../src/core/config.ts";
import { finalizerOutputTransport } from "../src/core/finalizer-transport.ts";

const runId = process.argv[2];
if (!runId || !/^[0-9a-f-]{36}$/i.test(runId)) throw new Error("Usage: npm run smoke:finalizer -- <active-local-run-id>");
const attach = JSON.parse(await readFile(resolve(".debug", "attach", `${runId}.json`), "utf8")) as { openCodeUrl: string; password: string };
const client = createOpencodeClient({
  baseUrl: attach.openCodeUrl,
  headers: { authorization: `Basic ${Buffer.from(`opencode:${attach.password}`).toString("base64")}` },
  throwOnError: false,
});
const directory = "/workspace/case";
const claimId = "00000000-0000-4000-8000-000000000001";

async function focused<T>(agent: "evidence-critic" | "fresh-adjudicator", title: string, prompt: string, schema: z.ZodType<T>, jsonExample: unknown): Promise<void> {
  const config = getConfig();
  const transport = finalizerOutputTransport(config.finalizerOpenCodeProvider, config.finalizerModel);
  const created = await client.session.create({ directory, title, agent, model: { id: "deepseek-v4-flash", providerID: "translucid", variant: "medium" } });
  if (!created.data || created.error) throw new Error(`${title} session creation failed.`);
  const schemaJson = z.toJSONSchema(schema);
  const message = await client.session.prompt({
    sessionID: created.data.id,
    directory,
    agent,
    model: { providerID: "translucid", modelID: "deepseek-v4-flash" },
    variant: "medium",
    ...(transport === "NATIVE_JSON_SCHEMA" ? { format: { type: "json_schema" as const, schema: schemaJson, retryCount: 2 } } : {}),
    parts: [{ type: "text", text: transport === "NATIVE_JSON_SCHEMA"
      ? prompt
      : `${prompt}\n\nReturn only one complete JSON object with no prose. It must validate against this JSON Schema:\n${JSON.stringify(schemaJson)}\nExample JSON shape:\n${JSON.stringify(jsonExample)}` }],
  });
  if (!message.data || message.error) throw new Error(`${title} prompt failed: ${JSON.stringify(message.error ?? "missing response")}`);
  schema.parse(extractStructuredOutput(message.data));
}

for (let cycle = 1; cycle <= 3; cycle += 1) {
  await focused("evidence-critic", `Finalizer smoke critic ${cycle}`, "Return a focused critic audit with empty arrays and one limitation explaining this is a schema smoke test.", criticOutputSchema, { ...criticJsonExample, limitations: ["Schema smoke test only."] });
  await focused("fresh-adjudicator", `Finalizer smoke findings ${cycle}`, `Return one UNRESOLVED, WEAK finding for claim ${claimId}, with no evidence IDs and one schema-smoke limitation.`, findingBatchOutputSchema, { findings: [{ claimId, verdict: "UNRESOLVED", strength: "WEAK", explanation: "Schema smoke test only.", supportingEvidenceIds: [], contradictingEvidenceIds: [], limitations: ["Schema smoke test only."] }] });
  await focused("fresh-adjudicator", `Finalizer smoke summary ${cycle}`, `Return a non-ranking summary with AMBIGUOUS identity, no evidence IDs, claim ${claimId} unresolved, and one schema-smoke limitation.`, summaryOutputSchema, { summary: { professionalIdentity: { status: "AMBIGUOUS", summary: "Schema smoke test only.", evidenceIds: [] }, professionalTimelineSummary: "Schema smoke test only.", strongestEvidenceIds: [], materialInconsistencies: [], unresolvedMaterialClaimIds: [claimId], investigationLimitations: ["Schema smoke test only."] } });
  process.stdout.write(`Finalizer structured-output cycle ${cycle}/3 passed.\n`);
}
