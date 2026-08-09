import { z } from "zod";

const positiveInteger = (fallback: number) =>
  z.coerce.number().int().positive().default(fallback);

const nonNegativeNumber = (fallback: number) =>
  z.coerce.number().nonnegative().default(fallback);

const environmentSchema = z
  .object({
    DATABASE_URL: z.string().min(1),
    APP_ORIGIN: z.url().default("http://127.0.0.1:3000"),
    RUNNER_GATEWAY_ORIGIN: z.url().default("http://127.0.0.1:3001"),
    E2B_GATEWAY_PUBLIC_URL: z.string().optional(),
    DATA_CLASSIFICATION: z.enum(["SYNTHETIC", "PUBLIC_PROFESSIONAL"]).default("SYNTHETIC"),
    OPENCODE_PROVIDER: z.enum(["ZEN", "GO"]).default("ZEN"),
    PROVIDER_MODE: z.enum(["fixture", "live"]).default("fixture"),
    RUNTIME_DEFAULT: z.enum(["LOCAL", "E2B"]).default("LOCAL"),
    E2B_API_KEY: z.string().optional(),
    E2B_TEMPLATE_ID: z.string().optional(),
    PDL_LIVE_ENABLED: z.enum(["true", "false"]).default("false"),
    RUNNER_CONCURRENCY: positiveInteger(4),
    LOCAL_RUNTIME_CONCURRENCY: positiveInteger(4),
    GLOBAL_E2B_CONCURRENCY: positiveInteger(4),
    EXA_CONCURRENCY: positiveInteger(4),
    LINKDAPI_CONCURRENCY: positiveInteger(2),
    BRIGHTDATA_CONCURRENCY: positiveInteger(2),
    PDL_CONCURRENCY: positiveInteger(1),
    GITHUB_CONCURRENCY: positiveInteger(4),
    ARCHIVES_CONCURRENCY: positiveInteger(3),
    PUBLIC_RECORDS_CONCURRENCY: positiveInteger(3),
    SCHOLARLY_CONCURRENCY: positiveInteger(3),
    PACKAGES_CONCURRENCY: positiveInteger(3),
    SECURITY_RECORDS_CONCURRENCY: positiveInteger(3),
    INVESTIGATION_TIMEOUT_MS: positiveInteger(1_800_000),
    MODEL_BUDGET_USD: nonNegativeNumber(5),
    PROVIDER_BUDGET_USD: nonNegativeNumber(10),
  })
  .passthrough();

export type AppConfig = ReturnType<typeof loadConfig>;

export function loadConfig(environment: Record<string, string | undefined>) {
  const parsed = environmentSchema.parse(environment);

  if (parsed.PDL_LIVE_ENABLED === "true") {
    throw new Error("PDL live execution is disabled by policy.");
  }
  if (parsed.RUNTIME_DEFAULT === "E2B") {
    if (!parsed.E2B_API_KEY || !parsed.E2B_TEMPLATE_ID) {
      throw new Error("E2B runtime requires E2B_API_KEY and E2B_TEMPLATE_ID.");
    }
    if (!parsed.E2B_GATEWAY_PUBLIC_URL?.startsWith("https://")) {
      throw new Error("E2B runtime requires an HTTPS E2B_GATEWAY_PUBLIC_URL.");
    }
  }

  return {
    databaseUrl: parsed.DATABASE_URL,
    appOrigin: parsed.APP_ORIGIN,
    runnerGatewayOrigin: parsed.RUNNER_GATEWAY_ORIGIN,
    e2bGatewayPublicUrl: parsed.E2B_GATEWAY_PUBLIC_URL,
    dataClassification: parsed.DATA_CLASSIFICATION,
    openCodeProvider: parsed.OPENCODE_PROVIDER,
    openCodeUpstreamUrl: parsed.OPENCODE_PROVIDER === "GO"
      ? "https://opencode.ai/zen/go/v1/chat/completions"
      : "https://opencode.ai/zen/v1/chat/completions",
    providerMode: parsed.PROVIDER_MODE,
    runtimeDefault: parsed.RUNTIME_DEFAULT,
    pdlLiveEnabled: false as const,
    runnerConcurrency: parsed.RUNNER_CONCURRENCY,
    localRuntimeConcurrency: parsed.LOCAL_RUNTIME_CONCURRENCY,
    globalE2bConcurrency: parsed.GLOBAL_E2B_CONCURRENCY,
    providerConcurrency: {
      EXA: parsed.EXA_CONCURRENCY,
      LINKDAPI: parsed.LINKDAPI_CONCURRENCY,
      BRIGHTDATA: parsed.BRIGHTDATA_CONCURRENCY,
      PDL: parsed.PDL_CONCURRENCY,
      GITHUB: parsed.GITHUB_CONCURRENCY,
      ARCHIVES: parsed.ARCHIVES_CONCURRENCY,
      PUBLIC_RECORDS: parsed.PUBLIC_RECORDS_CONCURRENCY,
      SCHOLARLY: parsed.SCHOLARLY_CONCURRENCY,
      PACKAGES: parsed.PACKAGES_CONCURRENCY,
      SECURITY_RECORDS: parsed.SECURITY_RECORDS_CONCURRENCY,
    },
    investigationTimeoutMs: parsed.INVESTIGATION_TIMEOUT_MS,
    modelBudgetUsd: parsed.MODEL_BUDGET_USD,
    providerBudgetUsd: parsed.PROVIDER_BUDGET_USD,
  };
}

let cachedConfig: AppConfig | undefined;

export function getConfig(): AppConfig {
  cachedConfig ??= loadConfig(process.env);
  return cachedConfig;
}
