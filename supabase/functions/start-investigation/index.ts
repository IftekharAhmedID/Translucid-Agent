import { createDispatcher } from "../../../src/serverless/dispatch.ts";
import { launchInvestigation } from "../../../src/serverless/launch.ts";

const envs: Record<string, string> = {};
for (const name of ["E2B_API_KEY", "E2B_TEMPLATE_ID", "OPENCODE_API_KEY", "EXA_API_KEY", "GITHUB_TOKEN", "RESEND_API_KEY", "RESEND_FROM", "TRACEDOG_MODEL", "TRACEDOG_RETAIN_FOR_VERIFICATION"]) {
  const value = Deno.env.get(name);
  if (value) envs[name] = value;
}
const templateId = Deno.env.get("TRACEDOG_COORDINATOR_TEMPLATE_ID") ?? "";
const origin = "https://tracedog.co";

Deno.serve(createDispatcher({
  origin,
  enabled: Deno.env.get("TRACEDOG_ACCEPT_SUBMISSIONS") === "true" && Boolean(templateId && envs.E2B_API_KEY && envs.E2B_TEMPLATE_ID && envs.OPENCODE_API_KEY && envs.RESEND_API_KEY && envs.RESEND_FROM),
  launch: async (payload, id) => { await launchInvestigation(payload, id, { templateId, envs }); },
}));
