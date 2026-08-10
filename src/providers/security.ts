import { createHash, randomBytes } from "node:crypto";
import type postgres from "postgres";

import { getSql } from "../db/client.ts";
type CaseTokenScope = {
  digest: string;
  investigationId: string;
  expiresAt: string;
  allowedTools: string[];
  allowedModels: string[];
};

function digestToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

function asJson(value: unknown): postgres.JSONValue {
  return JSON.parse(JSON.stringify(value)) as postgres.JSONValue;
}

export async function issueCaseToken(input: {
  investigationId: string;
  runId: string;
  allowedTools: string[];
  allowedModels: string[];
  ttlMs: number;
}): Promise<{ token: string; expiresAt: Date }> {
  if (input.ttlMs <= 0 || input.ttlMs > 60 * 60_000) throw new Error("Case token TTL must be within one hour.");
  const token = randomBytes(32).toString("base64url");
  const expiresAt = new Date(Date.now() + input.ttlMs);
  const scope: CaseTokenScope = {
    digest: digestToken(token),
    investigationId: input.investigationId,
    expiresAt: expiresAt.toISOString(),
    allowedTools: [...new Set(input.allowedTools)],
    allowedModels: [...new Set(input.allowedModels)],
  };
  const [updated] = await getSql()<Array<{ id: string }>>`
    UPDATE runs
    SET runtime_handle = COALESCE(runtime_handle, '{}'::jsonb) ||
      ${getSql().json(asJson({ gatewayScope: scope }))}::jsonb,
      updated_at = now()
    WHERE id = ${input.runId} AND investigation_id = ${input.investigationId}
    RETURNING id
  `;
  if (!updated) throw new Error("Run not found while issuing case token.");
  return { token, expiresAt };
}

export async function authorizeCaseToken(
  token: string,
  request: { kind: "tool" | "model"; name: string; investigationId: string },
): Promise<string> {
  if (!token || token.length > 256) throw new Error("Unauthorized case token.");
  const digest = digestToken(token);
  const [run] = await getSql()<Array<{ id: string; scope: CaseTokenScope }>>`
    SELECT id, runtime_handle->'gatewayScope' AS scope
    FROM runs
    WHERE investigation_id = ${request.investigationId}
      AND runtime_handle->'gatewayScope'->>'digest' = ${digest}
    LIMIT 1
  `;
  if (!run?.scope || new Date(run.scope.expiresAt).getTime() <= Date.now()) {
    throw new Error("Unauthorized or expired case token.");
  }
  const allowed = request.kind === "tool" ? run.scope.allowedTools : run.scope.allowedModels;
  if (!allowed.includes(request.name as never)) throw new Error("Case token scope denies this operation.");
  return run.id;
}

export async function consumeBudget(input: {
  runId: string;
  counter: string;
  increment: number;
  ceiling: number;
}): Promise<number> {
  if (!Number.isFinite(input.increment) || input.increment <= 0 || input.ceiling < 0) {
    throw new Error("Invalid budget request.");
  }
  return getSql().begin(async (transaction) => {
    const [row] = await transaction<Array<{ budgetCounters: Record<string, number> }>>`
      SELECT budget_counters AS "budgetCounters" FROM runs WHERE id = ${input.runId} FOR UPDATE
    `;
    if (!row) throw new Error("Run not found.");
    const current = Number(row.budgetCounters[input.counter] ?? 0);
    const next = current + input.increment;
    if (next > input.ceiling) throw new Error(`Budget exhausted for ${input.counter}.`);
    const counters = { ...row.budgetCounters, [input.counter]: next };
    await transaction`
      UPDATE runs SET budget_counters = ${transaction.json(asJson(counters))}, updated_at = now()
      WHERE id = ${input.runId}
    `;
    return next;
  });
}
